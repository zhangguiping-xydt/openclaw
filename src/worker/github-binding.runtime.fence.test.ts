import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { prepareWorkerGitHubEnvironment } from "./github-binding.runtime.js";
import {
  createWorkerCheckoutFixture,
  isBranchMove,
  workerFixtureBinding,
  type WorkerCheckoutFixture,
} from "./github-binding.test-support.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => ({ ...actual.createSubsystemLogger(name), warn }),
  };
});

// A turn is fenced when the owner epoch it was started under no longer matches. Every await between
// the export and the first write of the move is a point the fence can land on, and each one owes the
// checkout its own answer: the steps that already began the move complete it, and the reads that
// come before the first write must not start one at all.
describe("prepareWorkerGitHubEnvironment for a fenced turn", () => {
  const binding = workerFixtureBinding;
  let fixture: WorkerCheckoutFixture;
  let root: string;
  let cwd: string;
  let origin: string;
  let initialHead: string;
  let git: WorkerCheckoutFixture["git"];
  let commit: WorkerCheckoutFixture["commit"];
  // What the move set aside stays under the checkout's Git directory, where `git status` cannot see
  // it and a later `git add` cannot pick it up as work to publish.
  const replacedBytes = () => fixture.preservedBytes();

  beforeEach(async () => {
    fixture = await createWorkerCheckoutFixture();
    ({ root, cwd, origin, initialHead, git, commit } = fixture);
    warn.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture.dispose();
  });

  it("leaves the checkout untouched when the turn is fenced while the content is exported", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision));
    await fs.mkdir(path.join(seed, collision));
    await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    // Exporting the incoming content is the last step that can reach the network: this checkout can
    // be a blobless clone, where an entry's content is fetched from the origin with the turn's
    // credentials. A fence that lands there has to abort it with the checkout untouched, instead of
    // carrying the turn's authority into work that no longer honors the abort.
    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("checkout-index")) {
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return await runCommand(argv, options);
    });
    const prepareFenced = () =>
      prepareWorkerGitHubEnvironment({
        binding,
        stateDir: path.join(root, "state"),
        turnId: "turn",
        cwd,
        signal: controller.signal,
      });

    await prepareFenced();

    // Nothing was set aside and the branch did not move, so the next turn repeats the same
    // fast-forward on the checkout it expects to find.
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    expect(warn).not.toHaveBeenCalled();

    // With a live signal the same fast-forward completes.
    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: new AbortController().signal,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });

  it("leaves the checkout untouched when the turn is fenced just after the export", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision));
    await fs.mkdir(path.join(seed, collision));
    await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    // The export is the last step that can reach the network, and the fence it honors is the one that
    // lands while it runs. The steps between it and the first move are reads and scratch writes that
    // do not observe the abort, so a fence that lands *after* the export has finished still has to be
    // read again before anything is set aside: the fence below is raised once `checkout-index` has
    // returned, which is the interval no cancellable step covers.
    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("checkout-index") && !controller.signal.aborted) {
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return result;
    });
    const prepareFenced = () =>
      prepareWorkerGitHubEnvironment({
        binding,
        stateDir: path.join(root, "state"),
        turnId: "turn",
        cwd,
        signal: controller.signal,
      });

    await prepareFenced();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    expect(warn).not.toHaveBeenCalled();

    // With a live signal the same fast-forward completes.
    vi.restoreAllMocks();
    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: new AbortController().signal,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });

  it("completes the move when the turn is fenced after the removals", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision));
    await fs.mkdir(path.join(seed, collision));
    await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    const controller = new AbortController();
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (String(to).includes("collision-recovery") && !controller.signal.aborted) {
        // The fence lands once the move is underway: the incoming files are staged and the
        // approvals are set aside, but the branch has not moved yet. The bounded local work has to
        // complete, because a turn that stopped here would leave the checkout half replaced.
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return result;
    });
    const prepareFenced = () =>
      prepareWorkerGitHubEnvironment({
        binding,
        stateDir: path.join(root, "state"),
        turnId: "turn",
        cwd,
        signal: controller.signal,
      });

    await prepareFenced();

    // The hook is the fence: without it landing mid-move the assertions below would hold for a turn
    // that was never fenced at all.
    expect(controller.signal.aborted).toBe(true);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");

    // The next turn sees a local head that already matches the remote one, so it returns early.
    // A fresh live signal keeps that early return on its normal path instead of the fence exit.
    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: new AbortController().signal,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });

  it("does not start the move when the turn is fenced while classifying", async () => {
    const collision = "collision";
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, collision, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision), { recursive: true });
    await fs.writeFile(path.join(seed, collision), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    const runner = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const result = await runCommand(argv, options);
        if (argv.includes("--deleted")) {
          // The fence lands after the classifier approved the path and before the move touches it.
          controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
        }
        return result;
      });

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: controller.signal,
    });

    // The move advances the branch before it materializes the replacements, so a fenced turn that
    // started it would leave the workspace half applied with no later recovery.
    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision, "base.txt"), "utf8")).resolves.toBe(
      "base file\n",
    );
    await expect(replacedBytes()).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not start the move when the turn is fenced with no collision to set aside", async () => {
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base file\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const incoming = "incoming.txt";
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, incoming), "remote file\n");
    });

    // With nothing to set aside, re-reading the deleted paths is the last step before the first
    // write and the last one that can fence the turn before it: the preparation ahead awaits
    // commands that do not observe the abort, and the check before the loop runs before this read.
    // A turn fenced while it runs has changed nothing yet, so it owes the checkout the same
    // untouched state instead of materializing the incoming file and moving the branch.
    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    let deletions = 0;
    const runner = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const result = await runCommand(argv, options);
        if (argv.includes("--deleted")) {
          deletions += 1;
          if (deletions === 3 && !controller.signal.aborted) {
            controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
          }
        }
        return result;
      });

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: controller.signal,
    });

    expect(deletions).toBe(3);
    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(fs.lstat(path.join(cwd, incoming))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not start the move when the turn is fenced while the index is copied", async () => {
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base file\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "tracked.txt"), "remote bytes\n");
    });

    // An incoming history that only rewrites files materializes nothing, so the index write that
    // starts the completion phase is the first mutation of the turn — and the index copy ahead of it
    // is a filesystem call that does not observe the abort. A turn fenced while that copy ran has
    // changed nothing yet, so it owes the checkout an untouched working tree and an unmoved HEAD
    // instead of the index and the branch the move would have written.
    const controller = new AbortController();
    const copyFile = fs.copyFile;
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to) => {
      const result = await copyFile(from, to);
      if (String(to).includes("previous.index") && !controller.signal.aborted) {
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return result;
    });
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    await fixture.prepare({ signal: controller.signal });

    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, "tracked.txt"), "utf8")).resolves.toBe("base file\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not create the first directory when the turn is fenced while its parent is read", async () => {
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base file\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.mkdir(path.join(seed, "nested"));
      await fs.writeFile(path.join(seed, "nested", "remote.txt"), "remote file\n");
    });

    // A nested incoming entry is materialized by creating its directory first, and the `lstat` that
    // creation reads before its `mkdir` does not observe the abort. A turn fenced during that read
    // has not written anything yet, so it owes the checkout an untouched working tree rather than a
    // created directory, a placed file and a moved branch.
    const nested = path.join(cwd, "nested");
    const controller = new AbortController();
    let classified = false;
    const removed = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes("github-checkout-incoming.index")) {
        classified = true;
      }
      return await removed(target, options);
    });
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (classified && String(target) === nested && !controller.signal.aborted) {
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return await lstat(target, options);
    });
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    await fixture.prepare({ signal: controller.signal });

    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(
      fs.lstat(nested).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not start the move when the turn is fenced while the move reads its source", async () => {
    const nested = "nested";
    const collision = "collision";
    await fs.mkdir(path.join(cwd, nested));
    await fs.writeFile(path.join(cwd, nested, collision), "base file\n");
    initialHead = await commit(cwd, "Track nested collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, nested, collision));
      await fs.mkdir(path.join(seed, nested, collision));
      await fs.writeFile(path.join(seed, nested, collision, "remote.txt"), "remote file\n");
    });

    // Setting the approved path aside is the first mutation of the move, and the reads that decide
    // whether the path still reaches the checkout do not observe the abort. Marking the transaction
    // started before them would let a fence that landed while they ran still set the path aside under
    // the Git directory and advance the branch; the move therefore reads the fence itself, at the
    // rename those reads lead to, and a turn fenced during them owes the checkout the untouched state
    // every earlier fence owes it.
    const parent = path.join(cwd, nested);
    const controller = new AbortController();
    const realpath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]) === parent && !controller.signal.aborted) {
        controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
      }
      return await realpath(...args);
    });
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    await fixture.prepare({ signal: controller.signal });

    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(fs.readFile(path.join(parent, collision), "utf8")).resolves.toBe("base file\n");
    await expect(replacedBytes()).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not create a placed link when the turn is fenced while its destination is read", async () => {
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base file\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const link = "link";
    const destination = "tracked.txt";
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.symlink(destination, path.join(seed, link));
    });

    // A symlink entry is materialized from the destination its staging copy holds, and that read is
    // the placement's last await. The fence is read after it, so a turn that lost the checkout while
    // the destination was read has created nothing, rather than a link whose path the next turn would
    // otherwise read as a checkout state it did not make.
    const controller = new AbortController();
    const readlink = fs.readlink;
    let destinationReads = 0;
    vi.spyOn(fs, "readlink").mockImplementation(async (...args: Parameters<typeof fs.readlink>) => {
      if (String(args[0]).includes("incoming-")) {
        destinationReads += 1;
        if (destinationReads === 2 && !controller.signal.aborted) {
          controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
        }
      }
      return await readlink(...args);
    });
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    await fixture.prepare({ signal: controller.signal });

    expect(destinationReads).toBe(2);
    expect(runner.mock.calls.some(([argv]) => isBranchMove(argv))).toBe(false);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(
      fs.lstat(path.join(cwd, link)).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a fenced turn untouched when the writer occupies its first write", async () => {
    const incoming = "new-file.txt";
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, incoming), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    // The writer takes the incoming path while the placement's first `link` is in flight, so that
    // `link` fails with `EEXIST` and nothing has been written yet; the fence lands in the same call.
    // The turn never mutated the checkout, so it still owes the fence the decision: reading the
    // admission once and remembering it before the syscall would let this retry move the writer's
    // file aside and advance the branch under a turn that had already been revoked.
    const controller = new AbortController();
    const link = fs.link;
    let occupied = 0;
    let fenced = true;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (occupied === 0 && String(to).endsWith(incoming)) {
        occupied += 1;
        await fs.writeFile(to, "writer bytes\n");
        if (fenced) {
          controller.abort(new Error("worker fenced: owner-epoch-mismatch"));
        }
      }
      return await link(from, to);
    });

    await fixture.prepare({ signal: controller.signal });

    expect(occupied).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, incoming), "utf8")).resolves.toBe("writer bytes\n");
    // Nothing was set aside, because the only write the turn attempted is the one that failed.
    await expect(replacedBytes()).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    // The same placement under a live signal is not a dead end: the retry moves the writer's file
    // aside and the incoming file lands, which is what tells the refusal apart from a path rule.
    await fs.rm(path.join(cwd, incoming), { force: true });
    occupied = 0;
    fenced = false;
    await fixture.prepare({ signal: new AbortController().signal });

    expect(occupied).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, incoming), "utf8")).resolves.toBe("remote file\n");
    await expect(replacedBytes()).resolves.toEqual(["writer bytes"]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });
});

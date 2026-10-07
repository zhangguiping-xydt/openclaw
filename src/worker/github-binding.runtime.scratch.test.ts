import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import {
  createWorkerCheckoutFixture,
  isBranchMove,
  type WorkerCheckoutFixture,
} from "./github-binding.test-support.js";

// The scratch tree the replacement keeps is created out of names under the checkout's Git directory:
// a root at a fixed name, directories below it, an index file, and the copies the incoming content is
// exported to. A command from an earlier turn still runs as the worker user and can write there, so
// every one of those names is a pathname a writer can arrange in advance. These scenarios drive the
// four moments where such a name decides what the turn does: creating the tree, carrying an approved
// path into it, releasing it, and reading the index the move is planned from.
describe("prepareWorkerGitHubEnvironment beside a writer that owns a scratch name", () => {
  let fixture: WorkerCheckoutFixture;
  let cwd: string;
  let initialHead: string;
  let git: WorkerCheckoutFixture["git"];
  let commit: WorkerCheckoutFixture["commit"];
  let prepare: WorkerCheckoutFixture["prepare"];

  beforeEach(async () => {
    fixture = await createWorkerCheckoutFixture();
    ({ cwd, initialHead, git, commit, prepare } = fixture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.dispose();
  });

  /** Every file a redirect carried outside the checkout, so a scenario can assert none of them went. */
  const filesBelow = async (directory: string): Promise<string[]> => {
    const found: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await filesBelow(child)));
      } else {
        found.push(child);
      }
    }
    return found;
  };

  /** The one entry a prefix names in a scratch directory, which every scenario here expects to find. */
  const only = (entries: string[], prefix: string) => {
    const found = entries.find((entry) => entry.startsWith(prefix));
    if (!found) {
      throw new Error(`the scratch tree has no ${prefix} entry`);
    }
    return found;
  };

  /** A tracked file the incoming commit turns into a directory, so the move has an approved path. */
  const collisionScenario = async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });
    return { collision, remoteHead };
  };

  it("does not move an approved path through a link a writer left at the scratch root", async () => {
    const { collision, remoteHead } = await collisionScenario();

    // The scratch root is created at a fixed name, so a writer can leave a link there before the turn
    // starts. A recursive `mkdir` accepts an existing link as the directory it names, and every name
    // created or moved below it afterwards resolves through that link: the approved path would be
    // moved out of the checkout, under a name this turn cannot describe and no later turn can reach.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(cwd, ".git", "github-checkout-collision-recovery"));

    await prepare();

    // The turn could not make the scratch tree it needs, so it left the checkout exactly as it found
    // it: nothing this turn wrote is outside it, the approved path still holds the bytes the next
    // turn expects to classify, and the branch is where it was for that turn to repeat the same
    // fast-forward.
    await expect(filesBelow(outside)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
  });

  it("gives up a move whose destination a writer redirected at the rename", async () => {
    const { collision, remoteHead } = await collisionScenario();

    // The rename that carries an approved path into the recovery directory is the one step whose
    // destination is not beside its source, and a rename resolves that destination's whole pathname.
    // A writer that replaces the scratch root with a link once the approved path has left its name —
    // the interval between the two renames, which is where the move's own protection sits — therefore
    // has the entry carried outside the checkout, where the read-back still finds it and reports a
    // move that finished while the name in the checkout stays empty. The writer fills the directory
    // the entry's own name sits in, so the destination it redirected is a name the rename can reach.
    const recoveryRoot = path.join(cwd, ".git", "github-checkout-collision-recovery");
    const outside = path.join(fixture.root, "outside");
    const setAside = path.join(fixture.root, "recovery-set-aside");
    await fs.mkdir(outside);
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (swapped === 0 && String(from) === path.join(cwd, collision)) {
        swapped += 1;
        const move = only(await fs.readdir(recoveryRoot), "move-");
        await fs.mkdir(path.join(outside, move), { recursive: true });
        await rename(recoveryRoot, setAside);
        await fs.symlink(outside, recoveryRoot);
      }
      return result;
    });

    await prepare();

    expect(swapped).toBe(1);
    // The move was given up and the entry it would have carried went back to the name it still has, so
    // nothing was placed outside the checkout, the approved path keeps its bytes, and the branch did
    // not move over a working tree the turn could not complete.
    await expect(filesBelow(outside)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
  });

  it("does not empty a redirect when it releases the scratch it exported to", async () => {
    const { remoteHead } = await collisionScenario();

    // The scratch copy of the incoming content is released once the turn is done with it, and a
    // recursive removal resolves the whole pathname: a writer that replaced the scratch root with a
    // link while the move was finishing would have the turn empty a directory of its own. The writer's
    // file is under the same relative name the turn's own scratch copy had.
    const recoveryRoot = path.join(cwd, ".git", "github-checkout-collision-recovery");
    const outside = path.join(fixture.root, "outside");
    const setAside = path.join(fixture.root, "recovery-set-aside");
    const runCommand = exec.runCommandWithTimeout;
    let mirror = "";
    let redirected = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (isBranchMove(argv) && redirected === 0) {
        redirected += 1;
        const move = only(await fs.readdir(recoveryRoot), "move-");
        const exported = only(await fs.readdir(path.join(recoveryRoot, move)), "incoming-");
        mirror = path.join(outside, move, exported);
        await fs.mkdir(mirror, { recursive: true });
        await fs.writeFile(path.join(mirror, "writer.txt"), "writer bytes\n");
        await fs.rename(recoveryRoot, setAside);
        await fs.symlink(outside, recoveryRoot);
      }
      return result;
    });

    await prepare();

    expect(redirected).toBe(1);
    // The turn's own fast-forward completed, and the writer's directory kept every entry it had: the
    // name the turn was about to remove no longer resolved to its own scratch tree, so it released
    // the single name instead of recursing into the writer's.
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fs.readFile(path.join(mirror, "writer.txt"), "utf8")).resolves.toBe(
      "writer bytes\n",
    );
  });

  it("does not export the incoming content through a link a writer left at its directory", async () => {
    const { collision, remoteHead } = await collisionScenario();

    // The incoming content is exported by `git checkout-index --prefix`, which resolves the whole
    // pathname it is given and writes every entry it names below the directory that name reaches. The
    // directory is created a system call earlier, so the name is read again at the point of use: a
    // writer that replaced it in between has the export written where its link points, and the copies
    // the turn would go on to place come from there rather than from the directory it made — outside
    // the checkout, under a name no turn can describe.
    const recoveryRoot = path.join(cwd, ".git", "github-checkout-collision-recovery");
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const runCommand = exec.runCommandWithTimeout;
    let redirected = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (redirected === 0 && argv.includes("checkout-index")) {
        redirected += 1;
        const move = only(await fs.readdir(recoveryRoot), "move-");
        const below = path.join(recoveryRoot, move);
        const exported = path.join(below, only(await fs.readdir(below), "incoming-"));
        await fs.rm(exported, { recursive: true, force: true });
        await fs.symlink(outside, exported);
      }
      return await runCommand(argv, options);
    });

    await prepare();

    // The name was no longer the directory this turn created when the export came back, so the turn
    // refused it rather than place from a copy reached through the link: the approved path still holds
    // the bytes the next turn expects to classify, and the branch is where it was for that turn to
    // repeat the same fast-forward.
    expect(redirected).toBe(1);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
  });

  it("does not read an index a writer left at the name the turn could be predicted to use", async () => {
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base file\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "added.txt"), "remote added\n");
    });

    // The turn reads an index of the incoming commit to learn which paths it has to materialize, and
    // it reads it in a command of its own: a writer cannot guess a name this turn made with `mkdtemp`,
    // but it can guess a fixed one. This writer leaves a link at the fixed name at the moment the
    // incoming index has just been written, pointing at the checkout's own index — the one index that
    // describes no incoming file, so a turn that read it would find nothing missing, move the branch,
    // and leave the head it moved to with files the working tree never got.
    const fixed = path.join(cwd, ".git", "github-checkout-incoming.index");
    const runCommand = exec.runCommandWithTimeout;
    let guessed = 0;
    let attacked = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      const index = typeof options === "object" ? options.baseEnv?.GIT_INDEX_FILE : undefined;
      if (argv.includes("read-tree") && index !== undefined) {
        guessed += 1;
        const left = await fs.lstat(fixed).catch(() => undefined);
        if (left) {
          attacked += 1;
          await fs.rm(fixed, { force: true });
          await fs.symlink(path.join(cwd, ".git", "index"), fixed);
        }
      }
      return result;
    });

    await prepare();

    // The turn planned the move from an index of its own that no writer could place anything at, so
    // the link the writer left was never consulted, the incoming file is in the working tree, and the
    // head the branch moved to describes exactly what the checkout holds.
    expect(guessed).toBeGreaterThan(0);
    expect(attacked).toBe(0);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, "added.txt"), "utf8")).resolves.toBe("remote added\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });
});

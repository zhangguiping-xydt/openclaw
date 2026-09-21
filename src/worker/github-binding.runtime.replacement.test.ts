import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import {
  createWorkerCheckoutFixture,
  workerFixtureBranch,
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

// A background command from an earlier turn keeps running as the worker user, so it can write into
// a path the classifier already approved while the binding is replacing it. These scenarios cover
// what the replacement owes those bytes, and what the checkout owes the next turn when the
// replacement cannot be completed at all.
describe("prepareWorkerGitHubEnvironment beside a racing writer", () => {
  let fixture: WorkerCheckoutFixture;
  let cwd: string;
  let initialHead: string;
  let git: WorkerCheckoutFixture["git"];
  let commit: WorkerCheckoutFixture["commit"];
  let prepare: WorkerCheckoutFixture["prepare"];
  let replacedBytes: WorkerCheckoutFixture["preservedBytes"];

  beforeEach(async () => {
    fixture = await createWorkerCheckoutFixture();
    ({ cwd, initialHead, git, commit, prepare } = fixture);
    replacedBytes = fixture.preservedBytes;
    warn.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.dispose();
  });

  it("preserves a file written into a replaced directory after the classification", async () => {
    const collision = "collision";
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, collision, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision), { recursive: true });
      await fs.writeFile(path.join(seed, collision), "remote file\n");
    });

    // The writer lands after the classifier approved the directory it is about to replace.
    const runCommand = exec.runCommandWithTimeout;
    let written = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("--deleted") && written === 0) {
        written += 1;
        await fs.writeFile(path.join(cwd, collision, "late.txt"), "written after classification\n");
      }
      return result;
    });

    await prepare();

    expect(written).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("remote file\n");
    // The replacement sets the directory aside, so the late bytes survive it instead of being
    // deleted along with the directory the classifier approved.
    await expect(replacedBytes()).resolves.toEqual(["base file", "written after classification"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves a path a writer recreates before the incoming file is materialized", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    // The file is already set aside here, which is the window a background command from an earlier
    // turn keeps running in: it recreates the path the incoming directory has to be written under.
    const runCommand = exec.runCommandWithTimeout;
    let written = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("checkout-index") && written === 0) {
        written += 1;
        await fs.writeFile(path.join(cwd, collision), "written while the move ran\n");
      }
      return result;
    });

    await prepare();

    expect(written).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    // Neither the replaced file nor the recreated path was overwritten: both are recoverable.
    await expect(replacedBytes()).resolves.toEqual(["base file", "written while the move ran"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a writer's bytes when a failed move is rolled back", async () => {
    const first = "aaa-first";
    const second = "zzz-second";
    await fs.writeFile(path.join(cwd, first), "first bytes\n");
    await fs.writeFile(path.join(cwd, second), "second bytes\n");
    initialHead = await commit(cwd, "Track collision files");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      for (const name of [first, second]) {
        await fs.rm(path.join(seed, name), { force: true });
        await fs.mkdir(path.join(seed, name));
        await fs.writeFile(path.join(seed, name, "remote.txt"), `${name} remote\n`);
      }
    });

    // The rollback runs when a later move fails. A writer recreating the earlier path in that
    // window keeps its bytes, so the rollback may only restore what is still free.
    const rename = fs.rename;
    let recreated = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(second)) {
        recreated += 1;
        await fs.writeFile(path.join(cwd, first), "written while the move ran\n");
        throw Object.assign(new Error("ENOENT: the approved path vanished"), { code: "ENOENT" });
      }
      return await rename(from, to);
    });

    await prepare();

    expect(recreated).toBe(1);
    expect(remoteHead).not.toBe(initialHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, first), "utf8")).resolves.toBe(
      "written while the move ran\n",
    );
    // The restored bytes stayed recoverable instead of being written over the recreation.
    await expect(replacedBytes()).resolves.toEqual(["first bytes"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("rolls the placements back when the index cannot be written", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    const before = await git(cwd, "status", "--porcelain", "-z");
    // A Git process that crashed leaves its lock behind. It lets the classification and the
    // placements run and fails only the reset that moves the branch, which is the one failure that
    // lands after the incoming files are already in place.
    const lock = path.join(cwd, ".git", "index.lock");
    await fs.writeFile(lock, "");

    await prepare();

    // The branch and the index did not move, and the placements were taken back with the removals,
    // so the checkout is again exactly what the next turn's classification expects to see.
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    await expect(fs.access(path.join(cwd, collision, "remote.txt"))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe(before);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // With the lock gone, the same fast-forward completes.
    await fs.rm(lock);
    warn.mockClear();
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a writer's bytes when the rollback restores a moved symlink", async () => {
    const first = "aaa-first";
    const second = "zzz-second";
    const linkTarget = "link-target.txt";
    await fs.writeFile(path.join(cwd, linkTarget), "link target bytes\n");
    await fs.symlink(linkTarget, path.join(cwd, first));
    await fs.writeFile(path.join(cwd, second), "second bytes\n");
    initialHead = await commit(cwd, "Track collision paths");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      for (const name of [first, second]) {
        await fs.rm(path.join(seed, name), { force: true });
        await fs.mkdir(path.join(seed, name));
        await fs.writeFile(path.join(seed, name, "remote.txt"), `${name} remote\n`);
      }
    });

    // The rollback runs when a later move fails, and the writer fills the path the earlier symlink
    // has to come back into within the window a restoration has to close: after it asks whether the
    // path is free and before it puts the entry back, where a rename would replace the writer's
    // file instead of reporting the occupant.
    const rename = fs.rename;
    const symlink = fs.symlink;
    const restoreTarget = path.join(cwd, first);
    let recreated = 0;
    const recreateInTheWindow = async (target: unknown) => {
      if (String(target) !== restoreTarget || recreated > 0) {
        return;
      }
      recreated += 1;
      await fs.rm(restoreTarget, { force: true });
      await fs.writeFile(restoreTarget, "written while the move ran\n");
    };
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(second)) {
        throw Object.assign(new Error("ENOENT: the approved path vanished"), { code: "ENOENT" });
      }
      await recreateInTheWindow(to);
      return await rename(from, to);
    });
    vi.spyOn(fs, "symlink").mockImplementation(async (destination, target, type) => {
      await recreateInTheWindow(target);
      return await symlink(destination, target, type);
    });

    await prepare();

    expect(recreated).toBe(1);
    expect(remoteHead).not.toBe(initialHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(restoreTarget, "utf8")).resolves.toBe("written while the move ran\n");
    // The restored symlink did not replace the recreation; it is still the recoverable copy.
    await expect(fixture.preservedLinks()).resolves.toEqual([linkTarget]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps an incoming file inside the checkout when a writer recreates a symlinked path", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    // A background command from an earlier turn recreates the approved path as a link to another
    // directory. Creating the incoming file's parent directory recursively would resolve that link
    // and put the file outside the checkout, where nothing would own it.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const runCommand = exec.runCommandWithTimeout;
    let redirected = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("checkout-index") && redirected === 0) {
        redirected += 1;
        await fs.symlink(outside, path.join(cwd, collision));
      }
      return result;
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect((await fs.lstat(path.join(cwd, collision))).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    // The link is set aside like any other recreation, so the writer's directory is still reachable.
    await expect(fixture.preservedLinks()).resolves.toEqual([outside]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a writer's bytes when a placed file is modified before the reset fails", async () => {
    const collision = "collision";
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, collision, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision), { recursive: true });
      await fs.writeFile(path.join(seed, collision), "remote file\n");
    });

    // A background command from an earlier turn appends to the file the replacement just put in
    // place. The staging copy shares that file's inode, so a rollback that compared only inodes
    // would take the checkout name back and drop the staging name with it, leaving the appended
    // bytes with no name at all.
    await fs.writeFile(path.join(cwd, ".git", "index.lock"), "");
    const runCommand = exec.runCommandWithTimeout;
    let appended = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("reset") && appended === 0) {
        appended += 1;
        await fs.appendFile(path.join(cwd, collision), "appended by the writer\n");
      }
      return await runCommand(argv, options);
    });

    await prepare();

    expect(appended).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    // The writer's bytes stayed at the path the writer claimed, and the incoming copy stayed
    // recoverable instead of being deleted along with it.
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe(
      "remote file\nappended by the writer\n",
    );
    await expect(fixture.preservedBytes()).resolves.toEqual([
      "base file",
      "remote file\nappended by the writer",
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps a writer's bytes when a failed turn puts a replaced directory back", async () => {
    const collision = "collision";
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, collision, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision), { recursive: true });
      await fs.writeFile(path.join(seed, collision), "remote file\n");
    });

    await fs.writeFile(path.join(cwd, ".git", "index.lock"), "");
    // Putting a directory back by replacing the one a restore just created is not portable, so a
    // restore falls back to its entries one by one. A writer that fills the new directory inside
    // that window owns the name it wrote: putting the entry back over it would delete those bytes.
    const rename = fs.rename;
    const restored = path.join(cwd, collision);
    let filled = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === restored && filled === 0 && String(from).includes(".git")) {
        filled += 1;
        await fs.writeFile(path.join(restored, "base.txt"), "written while the move ran\n");
        throw Object.assign(new Error("ENOTEMPTY: the restored directory is not empty"), {
          code: "ENOTEMPTY",
        });
      }
      return await rename(from, to);
    });

    await prepare();

    expect(filled).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision, "base.txt"), "utf8")).resolves.toBe(
      "written while the move ran\n",
    );
    // The replaced directory could not be put back without overwriting the writer, so it stays the
    // recoverable copy under the Git directory.
    await expect(fixture.preservedBytes()).resolves.toEqual(["base file"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("puts the index back when the branch cannot move after the index was written", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    // `reset --mixed` writes the checkout's index before it moves the branch, so a branch ref a
    // crashed Git left locked fails the reset with the incoming entries already staged. Taking only
    // the working tree back would leave that mixture behind, and every later turn would read it as
    // local work and keep skipping the fast-forward.
    const lock = path.join(cwd, ".git", "refs", "heads", `${workerFixtureBranch}.lock`);
    await fs.writeFile(lock, "");

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // With the branch free again, the same fast-forward completes.
    await fs.rm(lock);
    warn.mockClear();
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });
});

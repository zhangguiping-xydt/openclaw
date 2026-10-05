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

    // The move sets the file aside here, which is the window a background command from an earlier
    // turn keeps running in: it recreates the path the incoming directory has to be written under.
    // The incoming content is already exported at this point, so the recreation lands between that
    // export and the write into the path the move freed.
    const rename = fs.rename;
    let written = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (
        written === 0 &&
        String(from) === path.join(cwd, collision) &&
        String(to).includes("collision-recovery")
      ) {
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
    const rename = fs.rename;
    let redirected = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (
        redirected === 0 &&
        String(from) === path.join(cwd, collision) &&
        String(to).includes("collision-recovery")
      ) {
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
    // recoverable copy under the Git directory. The incoming file the turn had placed comes back out
    // of the checkout by being moved there rather than removed, so its bytes are recoverable too.
    await expect(fixture.preservedBytes()).resolves.toEqual(["base file", "remote file"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps a restored directory's entries out of a link a writer left in its place", async () => {
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
    // A restoration creates the directory it fills, so a writer that keeps running as the worker
    // user can swap that directory for a link before the preserved copy is renamed onto it, and the
    // rename then fails because the name is no longer an empty directory. Putting the entries back
    // one at a time resolves the link on the way, so without reading the parent chain again every
    // entry would be created at the link's target and the path the incoming history named would stay
    // empty. A link is not a directory this runs through, so the preserved copy keeps its name under
    // the Git directory instead of being placed through it.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const rename = fs.rename;
    const restored = path.join(cwd, collision);
    let redirected = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (redirected === 0 && String(to) === restored && String(from).includes(".git")) {
        redirected += 1;
        await fs.rm(restored, { recursive: true, force: true });
        await fs.symlink(outside, restored);
        throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
      }
      return await rename(from, to);
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    // Nothing was created at the link's target, the link the writer put in the directory's place is
    // left exactly where it is, and both copies still have a name: the directory the move set aside
    // and the incoming file the rollback took back out of the checkout.
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await expect(fs.readlink(restored)).resolves.toBe(outside);
    await expect(fixture.preservedBytes()).resolves.toEqual(["base file", "remote file"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("materializes a newly added nested directory one component at a time", async () => {
    await fs.writeFile(path.join(cwd, "anchor.txt"), "anchor bytes\n");
    initialHead = await commit(cwd, "Track anchor file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.mkdir(path.join(seed, "new", "deep"), { recursive: true });
      await fs.writeFile(path.join(seed, "new", "deep", "file.txt"), "remote nested\n");
    });

    // Git reports the path with `/` on every platform, so a checkout that splits it on its own
    // separator sees one component on Windows and never creates `new` before `deep`: every attempt
    // fails with ENOENT and the turn repeats it forever. The parent chains are walked with Git's
    // own separator, so each component is created on its own wherever the checkout runs.
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, "new", "deep", "file.txt"), "utf8")).resolves.toBe(
      "remote nested\n",
    );
    await expect(fs.readdir(path.join(cwd, "new"))).resolves.toEqual(["deep"]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not advance the branch when the index cannot be backed up", async () => {
    await fs.writeFile(path.join(cwd, "added.txt"), "local bytes\n");
    initialHead = await commit(cwd, "Track local file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "later.txt"), "remote later\n");
    });

    // `reset --mixed` writes the index before it moves the branch, so a reset without a backup has
    // no copy to put back when the branch ref then refuses: the incoming entries would stay staged
    // against the head the checkout still has, and every later turn would read that mixture as its
    // own local work. A checkout whose index cannot be copied is not one this turn advances.
    const copyFile = fs.copyFile;
    let refused = 0;
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to) => {
      if (refused === 0 && String(to).includes("github-checkout-previous.index")) {
        refused += 1;
        throw Object.assign(new Error("EACCES: cannot back up the index"), { code: "EACCES" });
      }
      return await copyFile(from, to);
    });

    await prepare();

    expect(refused).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    await expect(fs.lstat(path.join(cwd, "later.txt"))).rejects.toThrow();
    await expect(fs.readFile(path.join(cwd, "added.txt"), "utf8")).resolves.toBe("local bytes\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // With the copy available again the same fast-forward completes.
    warn.mockClear();
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, "later.txt"), "utf8")).resolves.toBe("remote later\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the index backup when it cannot be put back", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    // The reset fails with the incoming entries staged against the head the checkout still has, so
    // the backup is the only copy of the index that head describes. Putting it back can fail too,
    // and then the cleanup may not delete what is left of it: the checkout keeps the name.
    const lock = path.join(cwd, ".git", "refs", "heads", `${workerFixtureBranch}.lock`);
    await fs.writeFile(lock, "");
    const backup = path.join(cwd, ".git", "github-checkout-previous.index");
    const rename = fs.rename;
    let refused = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (refused === 0 && String(from) === backup) {
        refused += 1;
        throw Object.assign(new Error("EACCES: cannot put the index back"), { code: "EACCES" });
      }
      return await rename(from, to);
    });

    await prepare();

    expect(refused).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.lstat(backup)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // The next turn prepares its own transaction through the same fixed name, so the copy above would
    // be deleted in that turn's cleanup or overwritten while it took its own copy: the preservation
    // would last only until the next turn reached these paths. The next turn therefore has to
    // recognize the outstanding copy and keep it under the recovery directory, where it keeps a name
    // of its own even though this turn then completes its own fast-forward.
    const keptBytes = await fs.readFile(backup);
    await fs.rm(lock);
    vi.restoreAllMocks();
    // The failed reset left the incoming entries staged, so a turn starting from that mixture skips
    // the fast-forward and never prepares a transaction. Clearing it puts the checkout back on the
    // same replacement, which is the turn that has to recognize the outstanding copy.
    await git(cwd, "reset", "--hard", "HEAD");
    await git(cwd, "clean", "--force", "-d");
    await prepare();

    const recoveryRoot = path.join(cwd, ".git", "github-checkout-collision-recovery");
    const indexCopies: Buffer[] = [];
    const collect = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collect(child);
        } else if (entry.name === "index") {
          indexCopies.push(await fs.readFile(child).catch(() => Buffer.alloc(0)));
        }
      }
    };
    await collect(recoveryRoot);
    expect(
      indexCopies.some((bytes) => bytes.equals(keptBytes)),
      "the index the failed restoration kept is still readable after the next turn",
    ).toBe(true);
  });

  it("keeps a file a writer adds while a restored directory is emptied", async () => {
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
    // Putting a directory back by replacing one that a writer filled inside the window is not
    // portable, so a restore falls back to its entries one by one. This time every entry fits, which
    // is the branch that cleans the preserved directory up afterwards. A background command whose
    // working directory was inside the directory the replacement set aside is still there after the
    // move, and a file it creates once the entries have been enumerated has no other name.
    const restored = path.join(cwd, collision);
    const rename = fs.rename;
    const link = fs.link;
    let preserved = "";
    let recreated = 0;
    let late = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        recreated === 0 &&
        String(to) === restored &&
        String(from).includes("collision-recovery")
      ) {
        recreated += 1;
        preserved = String(from);
        await fs.writeFile(path.join(restored, "writer.txt"), "written while the move ran\n");
      }
      return await rename(from, to);
    });
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      const created = await link(from, to);
      if (late === 0 && preserved !== "" && String(from).startsWith(preserved)) {
        late += 1;
        await fs.writeFile(
          path.join(preserved, "late.txt"),
          "written while the directory was emptied\n",
        );
      }
      return created;
    });

    await prepare();

    expect(recreated).toBe(1);
    expect(late).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision, "base.txt"), "utf8")).resolves.toBe(
      "base file\n",
    );
    await expect(fs.readFile(path.join(cwd, collision, "writer.txt"), "utf8")).resolves.toBe(
      "written while the move ran\n",
    );
    // Every entry went back and the writer's own file was never overwritten, while the file created
    // after the enumeration keeps the only name it has: the cleanup can only take a directory that
    // has nothing left in it. The incoming copy the rollback moved out of the checkout is there as
    // well, so nothing this turn wrote is deleted either.
    await expect(replacedBytes()).resolves.toEqual([
      "base file",
      "remote file",
      "written while the directory was emptied",
    ]);
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

  it("keeps bytes a writer adds after the rollback took its snapshot", async () => {
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

    // The writer lands inside the window the rollback opens between looking at the placed file and
    // acting on what it saw. The look is answered with the state from before the write, so any
    // comparison is already stale when it authorizes the removal: what the rollback does to a path
    // may not depend on the order those two steps happen to run in.
    const placed = path.join(cwd, collision);
    const lstat = fs.lstat;
    const runCommand = exec.runCommandWithTimeout;
    let rollbackStarted = false;
    let appended = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("reset")) {
        rollbackStarted = true;
      }
      return await runCommand(argv, options);
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      const stats = await lstat(target, options);
      if (rollbackStarted && String(target) === placed && appended === 0) {
        appended += 1;
        await fs.appendFile(placed, "written after the snapshot\n");
      }
      return stats;
    });

    await prepare();

    expect(appended).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    // Both copies still have a name: the writer's bytes at the path they went to, and the incoming
    // copy the rollback moved out of the checkout.
    await expect(fs.readFile(placed, "utf8")).resolves.toBe(
      "remote file\nwritten after the snapshot\n",
    );
    await expect(replacedBytes()).resolves.toEqual([
      "base file",
      "remote file\nwritten after the snapshot",
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps the incoming file inside the checkout when its parent is replaced after the check", async () => {
    const nested = "nested";
    await fs.writeFile(path.join(cwd, "anchor.txt"), "anchor bytes\n");
    initialHead = await commit(cwd, "Track anchor file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.mkdir(path.join(seed, nested));
      await fs.writeFile(path.join(seed, nested, "remote.txt"), "remote file\n");
    });

    // The writer replaces the directory the replacement just created with a link to somewhere else,
    // after the replacement checked that the parent is a real directory and before it creates the
    // incoming file under it. Reading the path again after the entry exists is the only way to see
    // that, and the entry has to be taken back instead of being accepted where it landed.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const parent = path.join(cwd, nested);
    const target = path.join(parent, "remote.txt");
    const link = fs.link;
    let redirected = 0;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to) === target && redirected === 0) {
        redirected += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.symlink(outside, parent);
      }
      return await link(from, to);
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("remote file\n");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    // The link is set aside like any other recreation, so the writer's directory stays reachable.
    await expect(fixture.preservedLinks()).resolves.toEqual([outside]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the incoming file at its own path when a parent links to another checkout path", async () => {
    const nested = "nested";
    const other = "other";
    await fs.writeFile(path.join(cwd, "anchor.txt"), "anchor bytes\n");
    initialHead = await commit(cwd, "Track anchor file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.mkdir(path.join(seed, nested));
      await fs.writeFile(path.join(seed, nested, "remote.txt"), "remote file\n");
    });

    // A link to another path in the same checkout keeps the resolved parent inside the checkout, so
    // a check that only asks whether the entry landed inside the root accepts it at the link's
    // target while the path the incoming commit names stays empty, and no later turn repairs that.
    // The parent chain has to be read again for what it is, not only for where it points.
    const elsewhere = path.join(cwd, other);
    await fs.mkdir(elsewhere);
    const parent = path.join(cwd, nested);
    const target = path.join(parent, "remote.txt");
    const link = fs.link;
    let redirected = 0;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to) === target && redirected === 0) {
        redirected += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.symlink(elsewhere, parent);
      }
      return await link(from, to);
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("remote file\n");
    // Nothing was written at the link's target, and the link is set aside like any other
    // recreation, so the writer's own directory stays reachable.
    await expect(fs.readdir(elsewhere)).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fixture.preservedLinks()).resolves.toEqual([elsewhere]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not take a move back when only its report was truncated", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    // `reset --mixed` prints one line per path it changes, so a large reconciliation comes back with
    // the report cut off at the command's diagnostic cap: exit code 0, the index written and the
    // branch moved. A truncated report is not a failed move; taking it back would restore the old
    // index against the new head and delete the incoming file the new head already holds.
    const runCommand = exec.runCommandWithTimeout;
    let truncated = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("reset") && truncated === 0) {
        truncated += 1;
        return { ...result, stdoutTruncatedBytes: 1_048_576 };
      }
      return result;
    });

    await prepare();

    expect(truncated).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("puts the index back when a reset without placements cannot move the branch", async () => {
    await fs.writeFile(path.join(cwd, "modified.txt"), "local bytes\n");
    initialHead = await commit(cwd, "Track modified file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "modified.txt"), "remote bytes\n");
    });

    // An incoming commit that only rewrites files materializes nothing, so there is no placement to
    // notice the index the reset wrote before the branch ref it could not move. The backup cannot be
    // tied to the placements: every reset writes the index first.
    const lock = path.join(cwd, ".git", "refs", "heads", `${workerFixtureBranch}.lock`);
    await fs.writeFile(lock, "");

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    await expect(fs.readFile(path.join(cwd, "modified.txt"), "utf8")).resolves.toBe(
      "local bytes\n",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // With the branch free again, the same fast-forward completes.
    await fs.rm(lock);
    warn.mockClear();
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });
});

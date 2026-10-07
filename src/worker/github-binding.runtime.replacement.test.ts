import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import {
  createWorkerCheckoutFixture,
  isCompletionPhaseCommand,
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
        path.dirname(String(to)) === cwd
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
    // placements run and fails only the index write that starts the completion phase, which is the
    // one failure that lands after the incoming files are already in place.
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
    // directory, at the rename that frees the path — the moment the name is free for it. Creating the
    // incoming file's parent directory recursively would resolve that link and put the file outside
    // the checkout, where nothing would own it.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const rename = fs.rename;
    let redirected = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (
        redirected === 0 &&
        String(from) === path.join(cwd, collision) &&
        path.dirname(String(to)) === cwd
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

  it("keeps a writer's bytes when a placed file is modified before the move writes the index", async () => {
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
      if (isCompletionPhaseCommand(options) && appended === 0) {
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
    // A directory is put back by filling the directory the restore created, one entry at a time: no
    // step of a restore renames a directory onto a name. A writer that fills that directory in the
    // window before the entries go back owns the name it wrote, and putting an entry back over it
    // would delete those bytes.
    const mkdir = fs.mkdir;
    const restored = path.join(cwd, collision);
    let filled = 0;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      const made = await mkdir(target, options);
      if (String(target) === restored && filled === 0) {
        filled += 1;
        await fs.writeFile(path.join(restored, "base.txt"), "written while the move ran\n");
      }
      return made;
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
    // user can swap that directory for a link before the entries go back into it, and each entry
    // creation would then resolve the link on the way. Reading the parent chain again before every
    // entry is what keeps them out: a link is not a directory this runs through, so the entries stay
    // where they are and the preserved copy keeps its name under the Git directory instead of being
    // placed through it.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const mkdir = fs.mkdir;
    const restored = path.join(cwd, collision);
    let redirected = 0;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      const made = await mkdir(target, options);
      if (String(target) === restored && redirected === 0) {
        redirected += 1;
        await fs.rm(restored, { recursive: true, force: true });
        await fs.symlink(outside, restored);
      }
      return made;
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

  it("keeps a writer's own directory at the name a restored directory is filled into", async () => {
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
    // Putting a directory back creates the name it needs before it fills it, and the directory that
    // name holds is a writer's to take: a background command still running as the worker user can
    // remove the directory this turn just created and make one of its own there. A rename onto that
    // name replaces whatever holds it, so the writer's directory would be discarded — the one
    // operation a restoration promises never to perform. Filling the name entry by entry keeps it:
    // the entries go back beside whatever holds the name rather than the name being taken over.
    const mkdir = fs.mkdir;
    const restored = path.join(cwd, collision);
    let taken = 0;
    let writerIno: number | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      const made = await mkdir(target, options);
      if (taken === 0 && String(target) === restored) {
        taken += 1;
        await fs.rm(restored, { recursive: true, force: true });
        await fs.mkdir(restored);
        writerIno = (await fs.lstat(restored)).ino;
      }
      return made;
    });

    await prepare();

    expect(taken).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    // The directory that holds the name afterwards is the writer's own, not the directory this turn
    // moved aside and put back there.
    expect((await fs.lstat(restored)).ino).toBe(writerIno);
    await expect(fs.readFile(path.join(cwd, collision, "base.txt"), "utf8")).resolves.toBe(
      "base file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps a restored link out of the directory a writer swaps its parent for", async () => {
    const directory = "nested";
    const link = `${directory}/link`;
    const linkTarget = "link-target.txt";
    const second = "zzz-second";
    await fs.mkdir(path.join(cwd, directory));
    await fs.writeFile(path.join(cwd, linkTarget), "link target bytes\n");
    await fs.symlink(linkTarget, path.join(cwd, link));
    await fs.writeFile(path.join(cwd, second), "second bytes\n");
    initialHead = await commit(cwd, "Track collision paths");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      for (const name of [link, second]) {
        await fs.rm(path.join(seed, name), { force: true });
        await fs.mkdir(path.join(seed, name), { recursive: true });
        await fs.writeFile(path.join(seed, name, "remote.txt"), `${name} remote\n`);
      }
    });

    // A restoration reads the parent chain before it creates the name it puts back, and the writer
    // can replace that chain with a link while the restoration awaits the preserved entry's own
    // destination. Creating the link then resolves the replaced directory, so the entry lands at the
    // link's target, and a restoration that reported success would release the preserved copy that
    // is the only name left holding it. The landing is read back, so the copy keeps its name under
    // the Git directory instead of being placed through the writer's link.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const readlink = fs.readlink;
    let redirected = 0;
    vi.spyOn(fs, "readlink").mockImplementation(async (target) => {
      if (redirected === 0 && String(target).includes("collision-recovery")) {
        redirected += 1;
        await fs.rm(path.join(cwd, directory), { recursive: true, force: true });
        await fs.symlink(outside, path.join(cwd, directory));
      }
      return await readlink(target);
    });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(second)) {
        throw Object.assign(new Error("ENOENT: the approved path vanished"), { code: "ENOENT" });
      }
      return await rename(from, to);
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    // Nothing was created at the link's target, the directory the writer replaced is left where it
    // is, and the preserved link still has a name under the Git directory.
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await expect(fs.readlink(path.join(cwd, directory))).resolves.toBe(outside);
    await expect(fixture.preservedLinks()).resolves.toEqual([linkTarget]);
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

    // The move writes the index before it moves the branch, so a move without a backup has
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

    // The branch step fails with the incoming entries staged against the head the checkout still has, so
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
    // The failed move left the incoming entries staged, so a turn starting from that mixture skips
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
    // Putting a directory back fills the directory a restore created, one entry at a time. This time
    // every entry fits, which is the branch that cleans the preserved directory up afterwards. A
    // background command whose working directory was inside the directory the replacement set aside
    // is still there after the move, and a file it creates once the entries have been enumerated has
    // no other name.
    const restored = path.join(cwd, collision);
    const mkdir = fs.mkdir;
    const link = fs.link;
    let preserved = "";
    let recreated = 0;
    let late = 0;
    vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      const made = await mkdir(target, options);
      if (recreated === 0 && String(target) === restored) {
        recreated += 1;
        await fs.writeFile(path.join(restored, "writer.txt"), "written while the move ran\n");
      }
      return made;
    });
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      const created = await link(from, to);
      // The first entry that goes back into the restored directory names the direction: the preserved
      // copy is what it came from. Matching the destination rather than the source matters, because
      // the staging directory the incoming file was exported to lives under the same recovery
      // directory and is released by this turn.
      if (preserved === "" && String(to).startsWith(`${restored}${path.sep}`)) {
        preserved = path.dirname(String(from));
      }
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

    // The move writes the checkout's index before it moves the branch, so a branch ref a crashed Git
    // left locked fails the branch step with the incoming entries already staged. Taking only
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

  it("keeps what a writer staged when the rollback restores the index", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, collision));
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    });

    const lock = path.join(cwd, ".git", "refs", "heads", `${workerFixtureBranch}.lock`);
    await fs.writeFile(lock, "");
    const index = path.join(cwd, ".git", "index");
    const previousIndex = path.join(cwd, ".git", "github-checkout-previous.index");
    const staged = "staged-by-writer.txt";
    await fs.writeFile(path.join(cwd, staged), "staged while the move ran\n");
    const before = await fs.readFile(index);

    // The index is a name a command still running as the worker user writes: `git add` from a
    // retained exec stages into it after the move wrote it and before the locked branch ref fails
    // into the rollback. The restoration replaces its destination with a rename, so it may only ever
    // replace the entry this turn last knew the index to be — anything else is what the writer just
    // wrote, and putting the copy back over it would discard that staging.
    //
    // The writer lands in the one interval that tells the two behaviours apart: after the move's own
    // index write, which is the entry the rollback knows about, and before the rollback reads the
    // destination it is about to replace. The restoration reads the copy's name first and the index
    // second, so the rollback's read of the copy is the last event before that compare: the staging
    // is injected there. The index is confirmed to have been rewritten by the move at that point, so
    // an injection that landed earlier — and would therefore be undone by the move and prove nothing
    // — reports itself instead of passing.
    const beforeIno = (await fs.lstat(index)).ino;
    const lstat = fs.lstat;
    let reads = 0;
    let rewritten = false;
    let injected = false;
    let stagedIndex: Buffer | undefined;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (String(target) === previousIndex) {
        reads += 1;
        // The constructor's stale-copy check, then the copy's own read while it is taken, then the
        // rollback's read of it. Only the last one is inside the window the writer needs.
        if (reads === 3) {
          rewritten = (await lstat(index)).ino !== beforeIno;
          injected = true;
          await git(cwd, "add", staged);
          stagedIndex = await fs.readFile(index);
        }
      }
      return await lstat(target, options);
    });

    await prepare();

    expect(rewritten).toBe(true);
    expect(injected).toBe(true);
    // A restoration that ran would have replaced the index with the copy, so the bytes compared here
    // are the ones the writer's own staging left. Nothing the turn does afterwards writes the index,
    // which is why the comparison comes before any of the reads below.
    await expect(fs.readFile(index)).resolves.toEqual(stagedIndex);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    // What the writer staged is still what the checkout's index holds.
    expect((await git(cwd, "diff", "--cached", "--name-only")).split("\n")).toContain(staged);
    // The copy the turn was going to put back was not consumed by a restoration that would have
    // destroyed the staging, so the index the checkout still describes is readable beside it.
    await expect(fs.readFile(previousIndex)).resolves.toEqual(before);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
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
      if (isCompletionPhaseCommand(options)) {
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

  it("leaves a writer's own file in place when a placement's parent is swapped for a link to it", async () => {
    const nested = "nested";
    await fs.writeFile(path.join(cwd, "anchor.txt"), "anchor bytes\n");
    initialHead = await commit(cwd, "Track anchor file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.mkdir(path.join(seed, nested));
      await fs.writeFile(path.join(seed, nested, "remote.txt"), "remote file\n");
    });

    // A take-back resolves the path it is refusing again, and the writer can change what that name
    // means after the placement already succeeded: renaming the directory the entry was made in and
    // putting a link to a directory of its own in its place makes the pathname name the writer's
    // file. That file is not this turn's to move, so the entry the turn created is identified before
    // the take-back runs: an entry that is not it keeps its name and its bytes, and the retry moves
    // the link aside instead of taking the writer's file away with the placement.
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    const outsideFile = path.join(outside, "remote.txt");
    await fs.writeFile(outsideFile, "outside file\n");
    const parent = path.join(cwd, nested);
    const target = path.join(parent, "remote.txt");
    const link = fs.link;
    let redirected = 0;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      const result = await link(from, to);
      if (String(to) === target && redirected === 0) {
        redirected += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.symlink(outside, parent);
      }
      return result;
    });

    await prepare();

    expect(redirected).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("remote file\n");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside file\n");
    await expect(replacedBytes()).resolves.toEqual([]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fixture.preservedLinks()).resolves.toEqual([outside]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a file outside the checkout when an approved path's ancestor becomes a link", async () => {
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

    // Moving an approved path aside resolves its whole pathname at the instant the rename runs, so a
    // writer that replaced an ancestor of that path with a link makes the pathname name a file that
    // lives outside the checkout. The move would take that file under the Git directory and destroy
    // the name it had there, and no later step can put back a source name it never saw.
    const outside = path.join(fixture.root, "outside");
    const outsideFile = path.join(outside, collision);
    const parent = path.join(cwd, nested);
    const madeDirectory = fs.mkdtemp;
    let swapped = 0;
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
      if (prefix.includes("github-checkout-incoming-") && swapped === 0) {
        swapped += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(outsideFile, "outside file\n");
        await fs.symlink(outside, parent);
      }
      return await madeDirectory(prefix, options);
    });

    await prepare();

    expect(swapped).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    // The writer's own file keeps its name and its bytes exactly where the writer put them.
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside file\n");
    await expect(replacedBytes()).resolves.toEqual([]);
    expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps a file outside the checkout when an approved path's ancestor becomes a link at the move", async () => {
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

    // The reads that decide whether an approved path still reaches the checkout are separate system
    // calls from the rename they lead to, so the writer owns the interval between them: the rename
    // then resolves through the writer's link and takes a file that lives outside the checkout under
    // the Git directory, where the turn that took it has no record of the name it had there. The
    // parent is therefore read again after the move, and an entry the move took through a different
    // parent goes back to the name it had outside before the replacement is refused.
    const outside = path.join(fixture.root, "outside");
    const outsideFile = path.join(outside, collision);
    const parent = path.join(cwd, nested);
    const source = path.join(parent, collision);
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === source && swapped === 0) {
        swapped += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(outsideFile, "outside file\n");
        await fs.symlink(outside, parent);
      }
      return await rename(from, to);
    });

    await prepare();

    expect(swapped).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    // The writer's own file keeps the name it had outside the checkout, as well as its bytes.
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside file\n");
    await expect(replacedBytes()).resolves.toEqual([]);
    expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("keeps an outside directory at its own name when an approved path's ancestor becomes a link at the move", async () => {
    const nested = "nested";
    const collision = "collision";
    await fs.mkdir(path.join(cwd, nested, collision), { recursive: true });
    await fs.writeFile(path.join(cwd, nested, collision, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track nested collision directory");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, nested, collision), { recursive: true });
      await fs.writeFile(path.join(seed, nested, collision), "remote file\n");
    });

    // The entry this move takes is a directory rather than a file: the redirect puts the writer's
    // own directory under the Git directory, and the name it came from has to come back. A repair
    // that can only link leaves that name empty and the bytes under a checkout the worker discards,
    // which is a name the writer had and nothing this turn can restore.
    const outside = path.join(fixture.root, "outside");
    const writerFile = path.join(outside, collision, "writer.txt");
    const parent = path.join(cwd, nested);
    const source = path.join(parent, collision);
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === source && swapped === 0) {
        swapped += 1;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.mkdir(path.join(outside, collision), { recursive: true });
        await fs.writeFile(writerFile, "writer file\n");
        await fs.symlink(outside, parent);
      }
      return await rename(from, to);
    });

    await prepare();

    expect(swapped).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    // The writer's directory keeps the name it had outside the checkout, as well as its bytes.
    await expect(fs.readFile(writerFile, "utf8")).resolves.toBe("writer file\n");
    await expect(replacedBytes()).resolves.toEqual([]);
    expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
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

  it("finishes the fast-forward when the origin is gone before the completion phase", async () => {
    await fixture.blobless();
    await fs.writeFile(path.join(cwd, "existing.txt"), "local bytes\n");
    initialHead = await commit(cwd, "Track an existing file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "existing.txt"), "incoming bytes\n");
      await fs.writeFile(path.join(seed, "added.txt"), "added bytes\n");
    });

    // The export may fetch the incoming content it materializes; the origin is gone from the moment
    // it returns. The completion phase writes the incoming index and moves the branch, and the file
    // the turn kept is one whose incoming content no step exports — in a blobless checkout that blob
    // is missing, so a phase that compares the kept file against the new index reaches for it with
    // the turn's credentials, after the fence stopped being honored. The phase writes its index and
    // its ref from the objects the move already put on disk instead: nothing about this move needs
    // that blob, and a fast-forward that stalls on it would leave the checkout half applied.
    const originGit = path.join(fixture.root, "origin.git");
    const runCommand = exec.runCommandWithTimeout;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("checkout-index")) {
        await fs.rename(originGit, path.join(fixture.root, "origin.gone"));
      }
      return result;
    });

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, "added.txt"), "utf8")).resolves.toBe("added bytes\n");
    await expect(fs.readFile(path.join(cwd, "existing.txt"), "utf8")).resolves.toBe(
      "local bytes\n",
    );
    // The blob the kept file's incoming version holds is still missing, which is what makes this a
    // regression for the phase rather than for the checkout: no step of the move needed it.
    const incomingKept = (await git(cwd, "rev-parse", `${remoteHead}:existing.txt`)).trim();
    await expect(
      exec.runExec("git", ["-C", cwd, "cat-file", "-e", incomingKept], {
        baseEnv: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      }),
    ).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("puts the index back when a move without placements cannot move the branch", async () => {
    await fs.writeFile(path.join(cwd, "modified.txt"), "local bytes\n");
    initialHead = await commit(cwd, "Track modified file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "modified.txt"), "remote bytes\n");
    });

    // An incoming commit that only rewrites files materializes nothing, so there is no placement to
    // notice the index the move wrote before the branch ref it could not move. The backup cannot be
    // tied to the placements: every move writes the index first.
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

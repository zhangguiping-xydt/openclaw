import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckoutPaths,
  createGitScratch,
  type CreatedEntry,
} from "./github-binding.checkout-paths.js";

/**
 * The rules a placement and a take-back both follow live in one module, and the reads that approve a
 * path are separate system calls from the write that acts on it, so a command still running as the
 * worker user owns the interval between them. These scenarios drive those intervals directly rather
 * than through the binding: the recovery directory is the one await inside each of them, and owning
 * it here is what holds the writer still long enough to observe what the module owes it.
 */
describe("checkout path rules beside a writer that moves the name", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkout-paths-")));
    cwd = path.join(root, "worker");
    await fs.mkdir(cwd);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * A recovery directory the scenario owns, so it can act while the module creates it. The module
   * creates it once per turn, which is what makes this the whole of the interval under test. The
   * fixture root stands in for the checkout's Git directory, so the boundary a name is held to here
   * is the same one the runtime holds its scratch tree to.
   */
  const recoveryBeside = (create: () => Promise<void>) => {
    const directory = path.join(root, "recovery");
    let ensured: Promise<string> | undefined;
    const paths = createCheckoutPaths(
      cwd,
      {
        ensureRecoveryDirectory: async () => {
          ensured ??= (async () => {
            await fs.mkdir(directory, { recursive: true });
            await create();
            return directory;
          })();
          return await ensured;
        },
        recoveryName: (relative: string) => `preserved-${path.basename(relative)}`,
      },
      createGitScratch(root),
    );
    return { directory, paths };
  };

  it("leaves an entry the pathname no longer names with the writer that moved it there", async () => {
    const outside = path.join(root, "outside");
    const writer = path.join(root, "writer");
    await fs.mkdir(outside);
    await fs.mkdir(writer);
    // The placement resolved the whole pathname through a link, so the entry this turn created sits
    // outside the checkout under a name a writer uses for one of its own files.
    const nested = path.join(cwd, "nested");
    await fs.symlink(outside, nested);
    const staged = path.join(root, "staged.txt");
    await fs.writeFile(staged, "incoming bytes\n");
    const target = path.join(nested, "remote.txt");
    await fs.link(staged, target);
    const stats = await fs.stat(staged);
    const created: CreatedEntry = { kind: "inode", dev: stats.dev, ino: stats.ino };
    const writerFile = path.join(writer, "remote.txt");
    await fs.writeFile(writerFile, "writer bytes\n");

    // Creating the recovery directory is an await between the identity check and the rename, and the
    // writer spends it pointing the ancestor at a directory of its own. The rename that follows
    // resolves through the new link, so the entry it takes is the writer's rather than the one this
    // turn identified, and nothing this turn holds records the name it had there.
    const { directory, paths } = recoveryBeside(async () => {
      await fs.rm(nested, { force: true });
      await fs.symlink(writer, nested);
    });

    await paths.takeBackMisplaced("nested/remote.txt", target, created);

    // The writer's file keeps its name and its bytes, and nothing was taken away in its place.
    await expect(fs.readFile(writerFile, "utf8")).resolves.toBe("writer bytes\n");
    await expect(fs.readFile(path.join(outside, "remote.txt"), "utf8")).resolves.toBe(
      "incoming bytes\n",
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it("keeps the entry a writer refilled the name with after moving an approved path", async () => {
    const nested = path.join(cwd, "nested");
    await fs.mkdir(nested);
    const collision = path.join(nested, "collision");
    await fs.writeFile(collision, "base file\n");

    // An approved path is set aside by renaming it, and a rename resolves the whole pathname at the
    // instant it runs: a writer that replaced the directory with a link has the move take its own
    // file instead, under a name the turn never saw. That entry is put back at the name it came
    // from, and the writer has refilled that name by then — the compensation owes the name the
    // entry it finds there, so it must refuse rather than replace what is not its own.
    const outside = path.join(root, "outside");
    const outsideFile = path.join(outside, "collision");
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === collision && swapped === 0) {
        swapped = 1;
        await fs.rm(nested, { recursive: true, force: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(outsideFile, "outside file\n");
        await fs.symlink(outside, nested);
      }
      const result = await rename(from, to);
      if (String(from) === collision && swapped === 1) {
        await fs.writeFile(outsideFile, "recreated file\n");
      }
      return result;
    });
    const { directory, paths } = recoveryBeside(async () => {});

    await expect(paths.moveIntoRecovery("nested/collision", collision)).resolves.toBeUndefined();

    expect(swapped).toBe(1);
    // The redirect took the move's source out of the directory the turn had read and put it in the
    // writer's own, so the entry that left is not the one the move was approved for. The read-back
    // finds that and gives the move up; the writer has refilled the name by then, so the entry it
    // owns keeps the name the move gave it — inside the writer's own directory, which is where a
    // rename confined to that directory can leave it. Both entries stay reachable and neither is
    // spent on the other: the writer's refill keeps the name it took, and nothing of the writer's is
    // under the Git directory, the one outcome no later turn can repair.
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("recreated file\n");
    await expect(fs.readFile(path.join(outside, "preserved-collision"), "utf8")).resolves.toBe(
      "outside file\n",
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  /**
   * Moves an approved path aside while a writer replaces the directory it is named through with a
   * link to one of its own, so the move takes that directory's entry instead. `prepare` fills the
   * writer's directory inside that swap, and `afterMove` refills a name once the move has taken it.
   */
  const redirectMoveOntoOutsideDirectory = async (hooks: {
    prepare: (outside: string) => Promise<void>;
    afterMove?: (outside: string) => Promise<void>;
  }) => {
    const nested = path.join(cwd, "nested");
    await fs.mkdir(nested, { recursive: true });
    const collision = path.join(nested, "collision");
    await fs.writeFile(collision, "base file\n");
    const outside = path.join(root, "outside");
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === collision && swapped === 0) {
        swapped = 1;
        await fs.rm(nested, { recursive: true, force: true });
        await fs.mkdir(outside, { recursive: true });
        await hooks.prepare(outside);
        await fs.symlink(outside, nested);
      }
      const result = await rename(from, to);
      if (String(from) === collision && hooks.afterMove) {
        await hooks.afterMove(outside);
      }
      return result;
    });
    const { directory, paths } = recoveryBeside(async () => {});
    return { collision, directory, outside, paths, swapped: () => swapped };
  };

  const writerDirectory = async (outside: string) => {
    await fs.mkdir(path.join(outside, "collision"));
    await fs.writeFile(path.join(outside, "collision", "writer.txt"), "writer bytes\n");
  };

  it("puts a directory a redirected move took back at the outside name it came from", async () => {
    // The entry the rename takes is a directory, and the name it came from is free again once the
    // move has taken it. A directory cannot be linked, so a repair that only knows how to link
    // leaves that name empty and the directory under the disposable checkout's Git directory — a
    // name the writer had, which nothing this turn can restore.
    const scenario = await redirectMoveOntoOutsideDirectory({ prepare: writerDirectory });

    await expect(
      scenario.paths.moveIntoRecovery("nested/collision", scenario.collision),
    ).resolves.toBeUndefined();

    expect(scenario.swapped()).toBe(1);
    await expect(
      fs.readFile(path.join(scenario.outside, "collision", "writer.txt"), "utf8"),
    ).resolves.toBe("writer bytes\n");
    await expect(fs.readdir(scenario.directory)).resolves.toEqual([]);
  });

  it("keeps a writer's own directory at the name a repaired move fills", async () => {
    const scenario = await redirectMoveOntoOutsideDirectory({ prepare: writerDirectory });
    // The repair takes the name with `mkdir` — which refuses an occupied path on its own — and then
    // puts the directory's entries back through the same refusal. Taking the name is not owning it:
    // a writer can remove the directory this call just made and create one of its own in the
    // interval before the entries go back, and the single `rename` this replaces would discard that
    // directory, because a rename replaces whatever holds its destination. Filling the name one
    // entry at a time leaves the writer's directory where the writer put it.
    const mkdir = fs.mkdir;
    let taken = 0;
    let writerIno: number | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
      const made = await mkdir(directory, options);
      if (taken === 0 && String(directory) === scenario.collision) {
        taken += 1;
        await fs.rmdir(scenario.collision);
        await fs.mkdir(scenario.collision);
        writerIno = (await fs.lstat(scenario.collision)).ino;
      }
      return made;
    });

    await expect(
      scenario.paths.moveIntoRecovery("nested/collision", scenario.collision),
    ).resolves.toBeUndefined();

    expect(taken).toBe(1);
    // The name still holds the writer's own directory, with the entry the repair put back beside it.
    expect((await fs.lstat(scenario.collision)).ino).toBe(writerIno);
    await expect(
      fs.readFile(path.join(scenario.outside, "collision", "writer.txt"), "utf8"),
    ).resolves.toBe("writer bytes\n");
    await expect(fs.readdir(scenario.directory)).resolves.toEqual([]);
  });

  it("leaves a directory a writer refilled the name with where the writer put it", async () => {
    const scenario = await redirectMoveOntoOutsideDirectory({
      prepare: writerDirectory,
      // The move took the writer's directory, so refilling the name means putting it back.
      afterMove: async (outside) => {
        await fs.mkdir(path.join(outside, "collision"));
        await fs.writeFile(path.join(outside, "collision", "writer.txt"), "refilled bytes\n");
      },
    });

    await expect(
      scenario.paths.moveIntoRecovery("nested/collision", scenario.collision),
    ).resolves.toBeUndefined();

    // The repair cannot take a name that holds a directory, so it refuses: the writer keeps the name
    // it refilled, and the directory the move took stays where the redirected rename left it — inside
    // the writer's own directory, under the intermediate name, rather than under the Git directory
    // where no later turn could tell it apart from a preserved checkout path.
    await expect(
      fs.readFile(path.join(scenario.outside, "collision", "writer.txt"), "utf8"),
    ).resolves.toBe("refilled bytes\n");
    await expect(fs.readdir(path.join(scenario.outside, "preserved-collision"))).resolves.toEqual([
      "writer.txt",
    ]);
    await expect(fs.readdir(scenario.directory)).resolves.toEqual([]);
  });

  it("gives back a directory it created through an ancestor a writer swapped for a link", async () => {
    const nested = path.join(cwd, "nested");
    await fs.mkdir(nested);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    // Creating a component resolves the whole pathname, so a writer that replaces an ancestor with
    // a link while the `mkdir` runs has this turn create the directory at the link's target. The
    // name taken is this turn's own, so a refusal that ends the attempt has to give it back: a
    // retry that succeeds afterwards would otherwise leave a directory this turn made, at a path
    // outside the checkout, behind it.
    const target = path.join(cwd, "nested", "deep");
    const mkdir = fs.mkdir;
    let swapped = 0;
    vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
      if (String(directory) === target && swapped === 0) {
        swapped = 1;
        await fs.rm(nested, { recursive: true, force: true });
        await fs.symlink(outside, nested);
      }
      return await mkdir(directory, options);
    });
    const { paths } = recoveryBeside(async () => {});

    await expect(paths.createRealDirectories("nested/deep")).rejects.toMatchObject({
      code: "EEXIST",
    });

    expect(swapped).toBe(1);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    expect(paths.createdDirectories).toEqual([]);
  });

  it("keeps an unrelated file out of the Git directory when the link moves at the rename", async () => {
    const verified = path.join(root, "verified");
    const redirected = path.join(root, "redirected");
    await fs.mkdir(verified);
    await fs.mkdir(redirected);
    const nested = path.join(cwd, "nested");
    await fs.symlink(verified, nested);
    const staged = path.join(root, "staged.txt");
    await fs.writeFile(staged, "incoming bytes\n");
    const target = path.join(nested, "remote.txt");
    await fs.link(staged, target);
    const stats = await fs.stat(staged);
    const created: CreatedEntry = { kind: "inode", dev: stats.dev, ino: stats.ino };
    // A file of the writer's own, in the directory the same link is aimed at afterwards.
    const writerFile = path.join(redirected, "remote.txt");
    await fs.writeFile(writerFile, "writer bytes\n");

    // Redirecting the link *inside the rename* is the interval the identity comparison cannot cover:
    // the comparison answered about the directory the link named when it ran, and the rename consumes
    // the name its own pathname resolves to at the instant it runs. Taking the parent's resolved name
    // as the source instead leaves the syscall nothing to resolve, so it can only move the entry this
    // turn compared — and the read-back at the intermediate name confirms that is what happened. The
    // writer refills the outside name the redirected move would have emptied, which is what a repair
    // that follows the pathname again would run into: it would ask the writer's own file for the name,
    // be refused, and leave the unrelated entry it took under the Git directory.
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (swapped === 0 && String(to).endsWith("preserved-remote.txt")) {
        swapped = 1;
        await fs.rm(nested, { force: true });
        await fs.symlink(redirected, nested);
        const result = await rename(from, to);
        await fs.writeFile(writerFile, "refilled bytes\n");
        return result;
      }
      return await rename(from, to);
    });
    const { directory, paths } = recoveryBeside(async () => {});

    await paths.takeBackMisplaced("nested/remote.txt", target, created);

    expect(swapped).toBe(1);
    // The entry the take-back was after is the one that moved: the syscall had nothing left to
    // resolve, so the walk found the entry it had read and the move finished. The misplaced placement
    // is out of the working tree, and the writer's directory was never touched — nothing of the
    // writer's is under the Git directory, which is the one outcome no later turn can repair.
    await expect(fs.readdir(directory)).resolves.toEqual(["preserved-remote.txt"]);
    await expect(fs.readFile(path.join(directory, "preserved-remote.txt"), "utf8")).resolves.toBe(
      "incoming bytes\n",
    );
    await expect(fs.readdir(verified)).resolves.toEqual([]);
    await expect(fs.readFile(writerFile, "utf8")).resolves.toBe("refilled bytes\n");
  });

  it("keeps an outside file in its own directory when the link is put back before the move is read", async () => {
    const nested = path.join(cwd, "nested");
    await fs.mkdir(nested);
    const collision = path.join(nested, "collision");
    await fs.writeFile(collision, "base file\n");
    const saved = path.join(cwd, "nested-saved");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    const outsideFile = path.join(outside, "collision");
    await fs.writeFile(outsideFile, "outside file\n");

    // The writer spends the interval between the reads that approve the path and the rename they
    // lead to pointing the pathname at a directory of its own, and puts the directory back before
    // this turn reads anything again. Both the read before the move and the read after it therefore
    // answer about the checkout's own directory, while the rename answered about the writer's — the
    // interval no comparison of the two ends can see. Only the entry the rename actually moved tells
    // the two apart, and it is the entry the move owes an answer about: the move gives it up rather
    // than carrying an entry it never read under the Git directory.
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === collision && swapped === 0) {
        swapped = 1;
        await rename(nested, saved);
        await fs.symlink(outside, nested);
        const result = await rename(from, to);
        await fs.unlink(nested);
        await rename(saved, nested);
        return result;
      }
      return await rename(from, to);
    });
    const { directory, paths } = recoveryBeside(async () => {});

    const outcome = await paths.moveIntoRecovery("nested/collision", collision);

    expect(swapped).toBe(1);
    // The entry the move was approved for is still where the checkout has it, and the writer's own
    // entry is still inside the writer's own directory — under the name the move gave it, which is
    // all a rename inside that directory can be asked to leave. Nothing of the writer's is under the
    // Git directory, which is the one outcome that cannot be repaired.
    await expect(fs.readdir(directory)).resolves.toEqual([]);
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("base file\n");
    await expect(fs.readFile(path.join(outside, "preserved-collision"), "utf8")).resolves.toBe(
      "outside file\n",
    );
    expect(outcome).toBeUndefined();
  });

  it("refuses a scratch directory a writer left a link at", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const rootName = path.join(root, "scratch");
    await fs.symlink(outside, rootName);

    // A recursive creation accepts an existing link as the directory it names, so a tree made that way
    // and every name below it would be made at the link's target. The one component is created on its
    // own instead, which refuses a name `lstat` does not report as a directory.
    const scratch = createGitScratch(root);

    await expect(scratch.make(rootName, "move-")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("does not empty a directory a redirected scratch name points at", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const redirectedDirectory = path.join(outside, "move-1", "incoming-1");
    await fs.mkdir(redirectedDirectory, { recursive: true });
    await fs.writeFile(path.join(redirectedDirectory, "writer.txt"), "writer bytes\n");
    const rootName = path.join(root, "scratch");
    await fs.symlink(outside, rootName);

    // A recursive removal resolves the whole pathname, so a link at the name above the scratch tree
    // would have this turn empty a directory of the writer's. The single name is released instead, and
    // a directory that is still not empty keeps the name that holds it.
    const scratch = createGitScratch(root);

    await scratch.remove(path.join(rootName, "move-1", "incoming-1"));

    await expect(fs.readFile(path.join(redirectedDirectory, "writer.txt"), "utf8")).resolves.toBe(
      "writer bytes\n",
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("gives up a move whose destination the writer moved out of the scratch tree", async () => {
    const nested = path.join(cwd, "nested");
    await fs.mkdir(nested);
    const collision = path.join(nested, "collision");
    await fs.writeFile(collision, "base file\n");
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const { directory, paths } = recoveryBeside(async () => {});
    const held = path.join(nested, "preserved-collision");

    // The crossing rename resolves the destination's whole pathname, and the read-back that follows it
    // reads through that same pathname: a writer that replaces the recovery tree with a link has the
    // entry carried outside the checkout while the move is reported as finished. The tree the caller
    // named is asked about the destination as well, and an entry that moved through a different tree
    // goes back to the name it still has.
    const rename = fs.rename;
    let swapped = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const result = await rename(from, to);
      if (swapped === 0 && String(to) === held) {
        swapped += 1;
        await rename(directory, `${directory}-set-aside`);
        await fs.symlink(outside, directory);
      }
      return result;
    });

    const outcome = await paths.moveIntoRecovery("nested/collision", collision);

    expect(swapped).toBe(1);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("base file\n");
    expect(outcome).toBeUndefined();
    await fs.rm(outside, { recursive: true, force: true });
  });
});

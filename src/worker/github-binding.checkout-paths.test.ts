import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutPaths, type CreatedEntry } from "./github-binding.checkout-paths.js";

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
   * creates it once per turn, which is what makes this the whole of the interval under test.
   */
  const recoveryBeside = (create: () => Promise<void>) => {
    const directory = path.join(root, "recovery");
    let ensured: Promise<string> | undefined;
    return {
      directory,
      recovery: {
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
    };
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
    const { directory, recovery } = recoveryBeside(async () => {
      await fs.rm(nested, { force: true });
      await fs.symlink(writer, nested);
    });
    const paths = createCheckoutPaths(cwd, recovery);

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
    const { directory, recovery } = recoveryBeside(async () => {});
    const paths = createCheckoutPaths(cwd, recovery);

    await expect(paths.moveIntoRecovery("nested/collision", collision)).resolves.toBeUndefined();

    expect(swapped).toBe(1);
    // Both entries stay reachable: the writer keeps the name it refilled, and the bytes the move
    // took stay under the Git directory instead of being spent on a repair.
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("recreated file\n");
    await expect(fs.readFile(path.join(directory, "preserved-collision"), "utf8")).resolves.toBe(
      "outside file\n",
    );
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
    const { directory, recovery } = recoveryBeside(async () => {});
    const paths = createCheckoutPaths(cwd, recovery);
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

    // The repair cannot take a name that holds a directory, so it refuses and both copies stay: the
    // writer keeps the name it refilled and the directory the move took stays under the Git
    // directory rather than replacing what appeared.
    await expect(
      fs.readFile(path.join(scenario.outside, "collision", "writer.txt"), "utf8"),
    ).resolves.toBe("refilled bytes\n");
    await expect(fs.readdir(path.join(scenario.directory, "preserved-collision"))).resolves.toEqual(
      ["writer.txt"],
    );
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
    const { recovery } = recoveryBeside(async () => {});
    const paths = createCheckoutPaths(cwd, recovery);

    await expect(paths.createRealDirectories("nested/deep")).rejects.toMatchObject({
      code: "EEXIST",
    });

    expect(swapped).toBe(1);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    expect(paths.createdDirectories).toEqual([]);
  });
});

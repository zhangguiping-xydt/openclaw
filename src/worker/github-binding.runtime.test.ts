import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import {
  disposeWorkerGitHubEnvironment,
  prepareWorkerGitHubEnvironment,
} from "./github-binding.runtime.js";
import {
  createWorkerCheckoutFixture,
  isBranchMove,
  isCompletionPhaseCommand,
  workerFixtureBinding,
  type WorkerCheckoutFixture,
} from "./github-binding.test-support.js";

const { warn, inspectPathPermissions, isPathCaseInsensitive } = vi.hoisted(() => ({
  warn: vi.fn(),
  inspectPathPermissions: vi.fn(),
  isPathCaseInsensitive: vi.fn(),
}));
vi.mock("../infra/path-case.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/path-case.js")>();
  isPathCaseInsensitive.mockImplementation(actual.isPathCaseInsensitive);
  return { ...actual, isPathCaseInsensitive };
});
vi.mock("@openclaw/fs-safe/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/permissions")>();
  inspectPathPermissions.mockImplementation(actual.inspectPathPermissions);
  return { ...actual, inspectPathPermissions };
});
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => ({ ...actual.createSubsystemLogger(name), warn }),
  };
});

describe("prepareWorkerGitHubEnvironment", () => {
  const binding = workerFixtureBinding;
  const filename = " reconciled file.txt";
  const pushedContent = "earlier worker content\n";
  let fixture: WorkerCheckoutFixture;
  let root: string;
  let cwd: string;
  let origin: string;
  let initialHead: string;
  let git: WorkerCheckoutFixture["git"];
  let commit: WorkerCheckoutFixture["commit"];

  async function publishEarlierTurn() {
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, filename), pushedContent);
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    return remoteHead;
  }

  const prepare = () => fixture.prepare();
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

  it.each([
    { scenario: "reconciled identical content", content: pushedContent, porcelain: "" },
    { scenario: "reconciled local edits", content: "local edit\n", porcelain: ` M ${filename}\0` },
    { scenario: "a missing pushed file", content: undefined, porcelain: "" },
  ])(
    "fast-forwards $scenario without losing working-tree bytes",
    async ({ content, porcelain }) => {
      const remoteHead = await publishEarlierTurn();
      if (content !== undefined) {
        await fs.writeFile(path.join(cwd, filename), content);
      }

      await prepare();

      expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
      expect((await git(cwd, "rev-parse", `refs/heads/${binding.branch}`)).trim()).toBe(remoteHead);
      expect((await git(cwd, "rev-parse", `refs/remotes/origin/${binding.branch}`)).trim()).toBe(
        remoteHead,
      );
      expect(await git(cwd, "status", "--porcelain", "-z")).toBe(porcelain);
      expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe(content ?? pushedContent);
      expect(
        (await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).trim(),
      ).toBe(`origin/${binding.branch}`);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("fast-forwards with more than 1 MiB of unrelated ignored paths", async () => {
    const tracked = "tracked.txt";
    const incoming = "incoming.txt";
    await fs.writeFile(path.join(cwd, tracked), "base\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, tracked), "remote edit\n");
    await fs.writeFile(path.join(seed, incoming), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    const ignoredDir = path.join(cwd, "cache");
    await fs.mkdir(ignoredDir);
    await fs.writeFile(path.join(cwd, ".git", "info", "exclude"), "cache/\n");
    const ignoredNames = Array.from(
      { length: 4_500 },
      (_, index) => `${index.toString().padStart(4, "0")}-${"x".repeat(230)}`,
    );
    for (let index = 0; index < ignoredNames.length; index += 100) {
      await Promise.all(
        ignoredNames
          .slice(index, index + 100)
          .map((name) => fs.writeFile(path.join(ignoredDir, name), "")),
      );
    }
    expect(
      ignoredNames.reduce((bytes, name) => bytes + Buffer.byteLength(`cache/${name}\0`), 0),
    ).toBeGreaterThan(1_048_576);

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, tracked), "utf8")).resolves.toBe("base\n");
    await expect(fs.readFile(path.join(cwd, incoming), "utf8")).resolves.toBe("remote file\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe(` M ${tracked}\0`);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "file with a directory", localDirectory: false },
    { scenario: "directory with a file", localDirectory: true },
  ])("fast-forwards a clean tracked $scenario", async ({ localDirectory }) => {
    const collision = "collision";
    if (localDirectory) {
      await fs.mkdir(path.join(cwd, collision));
      await fs.writeFile(path.join(cwd, collision, "base.txt"), "base file\n");
    } else {
      await fs.writeFile(path.join(cwd, collision), "base file\n");
    }
    initialHead = await commit(cwd, "Track collision path");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision), { recursive: true });
    if (localDirectory) {
      await fs.writeFile(path.join(seed, collision), "remote file\n");
    } else {
      await fs.mkdir(path.join(seed, collision));
      await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    }
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    const remotePath = localDirectory ? collision : path.join(collision, "remote.txt");
    await expect(fs.readFile(path.join(cwd, remotePath), "utf8")).resolves.toBe("remote file\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "untracked", ignored: false },
    { scenario: "ignored", ignored: true },
  ])("preserves an $scenario file that blocks an incoming directory", async ({ ignored }) => {
    const collision = "collision";
    const localContent = "local file\n";
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.mkdir(path.join(seed, collision));
    await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    if (ignored) {
      await fs.writeFile(path.join(cwd, ".git", "info", "exclude"), `${collision}\n`);
    }
    await fs.writeFile(path.join(cwd, collision), localContent);
    const before = await git(cwd, "status", "--porcelain", "--ignored", "-z");

    await prepare();

    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe(localContent);
    await expect(fs.access(path.join(cwd, collision, "remote.txt"))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe(before);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it("treats an empty untracked collision with Git pattern characters literally", async () => {
    const collision = "a[bc]";
    await fs.writeFile(path.join(cwd, "ab"), "tracked file\n");
    initialHead = await commit(cwd, "Track pathspec match");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, collision), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    await fs.mkdir(path.join(cwd, collision));

    await prepare();

    expect((await fs.lstat(path.join(cwd, collision))).isDirectory()).toBe(true);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it("preserves an untracked directory that blocks an incoming file", async () => {
    const collision = "collision";
    const localFile = path.join(collision, "local.txt");
    const localContent = "local file\n";
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, collision), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, localFile), localContent);
    const before = await git(cwd, "status", "--porcelain", "--ignored", "-z");

    await prepare();

    await expect(fs.readFile(path.join(cwd, localFile), "utf8")).resolves.toBe(localContent);
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe(before);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it("preserves a tracked dirty file that blocks an incoming directory", async () => {
    const collision = "collision";
    const localContent = "local edit\n";
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
    await fs.writeFile(path.join(cwd, collision), localContent);
    const before = await git(cwd, "status", "--porcelain", "--ignored", "-z");

    await prepare();

    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe(localContent);
    await expect(fs.access(path.join(cwd, collision, "remote.txt"))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe(before);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it.each([
    { scenario: "assume-unchanged", flags: ["--assume-unchanged"] },
    { scenario: "skip-worktree", flags: ["--skip-worktree"] },
    { scenario: "both index", flags: ["--assume-unchanged", "--skip-worktree"] },
  ])("preserves a tracked file that a $scenario flag hides from Git status", async ({ flags }) => {
    const collision = "collision";
    const localContent = "local edit hidden from status\n";
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

    await fs.writeFile(path.join(cwd, collision), localContent);
    for (const flag of flags) {
      await git(cwd, "update-index", flag, collision);
    }
    // The flag hides the edit, so a clean report must not authorize removing these bytes.
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe("");

    await prepare();

    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe(localContent);
    await expect(fs.access(path.join(cwd, collision, "remote.txt"))).rejects.toThrow();
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it.each([
    { scenario: "the collision path", nested: "" },
    { scenario: "a tracked subdirectory", nested: "sub" },
  ])("preserves a nested repository inside $scenario", async ({ nested }) => {
    const collision = "collision";
    const nestedDirectory = nested ? path.join(collision, nested) : collision;
    const trackedFile = path.join(nestedDirectory, "base.txt");
    await fs.mkdir(path.join(cwd, nestedDirectory), { recursive: true });
    await fs.writeFile(path.join(cwd, trackedFile), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision), { recursive: true });
    await fs.writeFile(path.join(seed, collision), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    // The worker initializes its own repository inside the tracked directory.
    const nestedRepository = path.join(cwd, nestedDirectory);
    await git(cwd, "init", "--quiet", nestedDirectory);
    await git(nestedRepository, "config", "user.name", "Worker Fixture");
    await git(nestedRepository, "config", "user.email", "worker@openclaw.invalid");
    const nestedHead = await commit(nestedRepository, "Nested work");
    // Git reports nothing for the `.git` entry, so the outer status is still empty here.
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe("");

    await prepare();

    await expect(fs.readFile(path.join(cwd, trackedFile), "utf8")).resolves.toBe("base file\n");
    expect((await fs.lstat(path.join(cwd, collision))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).rejects.toThrow();
    expect((await git(nestedRepository, "rev-parse", "HEAD")).trim()).toBe(nestedHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  // Git reports none of these entries, so an empty status plus tracked index entries cannot prove
  // the directory the removal deletes is reproducible from the index. A named pipe needs a POSIX
  // host; the empty directory covers the same code path everywhere. A live socket needs a short
  // path for `sun_path`, so the runtime proof covers that variant in a shorter scenario root.
  const gitInvisibleEntries: Array<{
    entry: string;
    create: (target: string) => Promise<void>;
  }> = [
    {
      entry: "an empty directory",
      create: async (target) => {
        await fs.mkdir(target);
      },
    },
  ];
  if (process.platform !== "win32") {
    gitInvisibleEntries.push({
      entry: "a named pipe",
      create: async (target) => {
        const created = spawnSync("mkfifo", [target], { encoding: "utf8", timeout: 5_000 });
        expect(created.status, created.stderr).toBe(0);
      },
    });
  }

  it.each(gitInvisibleEntries)(
    "preserves $entry inside a tracked directory",
    async ({ create }) => {
      const collision = "collision";
      const trackedFile = path.join(collision, "base.txt");
      await fs.mkdir(path.join(cwd, collision));
      await fs.writeFile(path.join(cwd, trackedFile), "base file\n");
      initialHead = await commit(cwd, "Track collision directory");
      await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");

      const seed = path.join(root, "earlier-worker");
      await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
      await fs.rm(path.join(seed, collision), { recursive: true });
      await fs.writeFile(path.join(seed, collision), "remote file\n");
      const remoteHead = await commit(seed, "Earlier turn");
      await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

      const invisible = path.join(cwd, collision, "invisible");
      await create(invisible);
      // Git reports nothing for the entry, so the outer status is still empty here.
      expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe("");

      await prepare();

      await expect(fs.readFile(path.join(cwd, trackedFile), "utf8")).resolves.toBe("base file\n");
      await expect(fs.lstat(invisible)).resolves.toBeDefined();
      await expect(fs.readFile(path.join(cwd, collision), "utf8")).rejects.toThrow();
      expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
      expect(remoteHead).not.toBe(initialHead);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("GitHub checkout fast-forward skipped"),
      );
    },
  );

  it("replaces a collision whose path exceeds the recovery name limit", async () => {
    const long = "l".repeat(140);
    const nested = `${long}/${long}`;
    const short = "a";
    await fs.writeFile(path.join(cwd, short), "a bytes\n");
    await fs.mkdir(path.join(cwd, nested), { recursive: true });
    await fs.writeFile(path.join(cwd, nested, "base.txt"), "nested bytes\n");
    initialHead = await commit(cwd, "Track collision paths");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, short));
    await fs.mkdir(path.join(seed, short));
    await fs.writeFile(path.join(seed, short, "remote.txt"), "remote short\n");
    await fs.rm(path.join(seed, nested), { recursive: true });
    await fs.writeFile(path.join(seed, nested), "remote nested\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    await expect(fs.readFile(path.join(cwd, short, "remote.txt"), "utf8")).resolves.toBe(
      "remote short\n",
    );
    await expect(fs.readFile(path.join(cwd, nested), "utf8")).resolves.toBe("remote nested\n");
    // Both blockers were set aside: a name the filesystem rejects cannot strand the first one.
    await expect(replacedBytes()).resolves.toEqual(["a bytes", "nested bytes"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("materializes a submodule entry without stranding the files after it", async () => {
    await fs.writeFile(path.join(cwd, "base.txt"), "base bytes\n");
    initialHead = await commit(cwd, "Track base file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await git(
      seed,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,0000000000000000000000000000000000000001,a-module",
    );
    await fs.writeFile(path.join(seed, "z-file.txt"), "remote later\n");
    // `git add .` would stage the submodule entry as a deletion, because the directory Git expects
    // for it does not exist yet; the incoming history carries it the way an existing repository does.
    await git(seed, "add", "z-file.txt");
    await git(
      seed,
      "-c",
      "user.name=Worker Fixture",
      "-c",
      "user.email=worker@openclaw.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Earlier turn",
    );
    const remoteHead = (await git(seed, "rev-parse", "HEAD")).trim();
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    await prepare();

    // A submodule entry is a directory Git expects to exist, and the file after it still lands.
    expect((await fs.lstat(path.join(cwd, "a-module"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(cwd, "z-file.txt"), "utf8")).resolves.toBe("remote later\n");
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("holds the branch when an incoming file cannot be put in place", async () => {
    const collision = "collision";
    await fs.writeFile(path.join(cwd, collision), "base file\n");
    initialHead = await commit(cwd, "Track collision file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");

    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision));
    await fs.mkdir(path.join(seed, collision));
    await fs.writeFile(path.join(seed, collision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);

    const before = await git(cwd, "status", "--porcelain", "-z");
    const runCommand = exec.runCommandWithTimeout;
    let denied = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("checkout-index") && denied === 0) {
        denied += 1;
        // The replacement cannot be put in place at all: the content it would install cannot be
        // exported, which fails the turn before anything in the checkout has been touched.
        return { ...result, code: 1 };
      }
      return result;
    });

    await prepare();

    // The branch and the index did not move, so the checkout is exactly what the next turn expects.
    expect(denied).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    await expect(fs.readFile(path.join(cwd, collision), "utf8")).resolves.toBe("base file\n");
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe(before);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );

    // That turn repeats the same fast-forward and completes it.
    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, collision, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });

  it("moves the branch to the commit it resolved, not to one a later fetch names", async () => {
    const remoteHead = await publishEarlierTurn();

    // The fetched commit is read from `FETCH_HEAD`, and that file is a name a command still running as
    // the worker user can rewrite with a fetch of its own. A turn that read the file again for each
    // command of the move would export one commit and advance the branch to whichever one the file
    // held when the last command ran — here a divergent history the session never classified, which
    // the checkout would then hold as its head. The commit is resolved to an object name once, and
    // every command after that names the object rather than the file.
    const divergent = path.join(root, "divergent-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, divergent);
    await fs.writeFile(path.join(divergent, "divergent.txt"), "divergent content\n");
    const divergentHead = await commit(divergent, "Divergent turn");
    await git(divergent, "push", "--quiet", "origin", "HEAD:refs/heads/divergent");

    const runCommand = exec.runCommandWithTimeout;
    let refetched = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      // The turn has just resolved the fetched commit, and the writer's own fetch lands straight
      // after it — the one moment the name is between being read and being used.
      if (refetched === 0 && argv.includes("rev-parse") && argv.includes("FETCH_HEAD")) {
        refetched += 1;
        await git(cwd, "fetch", "--quiet", "origin", "divergent");
      }
      return result;
    });

    await prepare();

    // The branch sits at the commit this turn resolved and materialized, so the head and the working
    // tree describe the same revision instead of the mixture two histories would leave behind.
    expect(refetched).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).not.toBe(divergentHead);
    await expect(fs.readFile(path.join(cwd, filename), "utf8")).resolves.toBe(pushedContent);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
  });

  it("keeps a commit a worker command makes while the branch is being moved", async () => {
    await fs.writeFile(path.join(cwd, "modified.txt"), "local bytes\n");
    initialHead = await commit(cwd, "Track modified file");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.writeFile(path.join(seed, "modified.txt"), "incoming bytes\n");
    });

    // An incoming history that only rewrites a tracked file materializes nothing, so this turn is the
    // two commands of the completion phase and nothing else. The index and the branch are separate
    // commands, and a worker command that still runs can commit on the session branch between them:
    // the commit is a child of the head the checkout had, and it exists only here until the session
    // pushes it. Moving the branch is therefore done against the head this turn read, so an update
    // that no longer matches it fails into the rollback rather than rewinding the commit the session
    // itself made. What the worker committed stays what the session has.
    const runCommand = exec.runCommandWithTimeout;
    let workerCommit = "";
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      // The branch move is the completion phase's last command. The commit is made just before it, so
      // it lands in the window the index write opened — the one place an update that ignores the head
      // the turn read would undo work the session never pushed.
      if (workerCommit === "" && isBranchMove(argv) && isCompletionPhaseCommand(options)) {
        await fs.writeFile(path.join(cwd, "worker.txt"), "worker bytes\n");
        workerCommit = await commit(cwd, "Worker commit");
      }
      return await runCommand(argv, options);
    });

    await prepare();

    expect(workerCommit).not.toBe("");
    expect(workerCommit).not.toBe(remoteHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(workerCommit);
    expect(await git(cwd, "ls-tree", "--name-only", "HEAD")).toContain("worker.txt");
    // The turn gave its fast-forward up rather than undo what the worker did, so the file the
    // incoming commit rewrote still holds the worker's bytes and nothing it placed is left behind.
    await expect(fs.readFile(path.join(cwd, "modified.txt"), "utf8")).resolves.toBe(
      "local bytes\n",
    );
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("checkout binding failed"),
    );
  });

  it("preserves a tracked dirty directory that blocks an incoming file", async () => {
    const collision = "collision";
    const localFile = path.join(collision, "local.txt");
    const localContent = "local edit\n";
    await fs.mkdir(path.join(cwd, collision));
    await fs.writeFile(path.join(cwd, localFile), "base file\n");
    initialHead = await commit(cwd, "Track collision directory");
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.rm(path.join(seed, collision), { recursive: true });
    await fs.writeFile(path.join(seed, collision), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    await fs.writeFile(path.join(cwd, localFile), localContent);
    const before = await git(cwd, "status", "--porcelain", "--ignored", "-z");

    await prepare();

    await expect(fs.readFile(path.join(cwd, localFile), "utf8")).resolves.toBe(localContent);
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe(before);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it("honors case-insensitive paths when a local file blocks an incoming directory", async () => {
    isPathCaseInsensitive.mockReturnValueOnce(true);
    const localCollision = "Collision";
    const remoteCollision = "collision";
    const localContent = "local file\n";
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.mkdir(path.join(seed, remoteCollision));
    await fs.writeFile(path.join(seed, remoteCollision, "remote.txt"), "remote file\n");
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    await fs.writeFile(path.join(cwd, localCollision), localContent);
    const before = await git(cwd, "status", "--porcelain", "--ignored", "-z");

    await prepare();

    await expect(fs.readFile(path.join(cwd, localCollision), "utf8")).resolves.toBe(localContent);
    await expect(fs.access(path.join(cwd, remoteCollision, "remote.txt"))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "--ignored", "-z")).toBe(before);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("GitHub checkout fast-forward skipped"),
    );
  });

  it("replaces a clean local file whose name differs by case from an incoming directory", async () => {
    isPathCaseInsensitive.mockReturnValueOnce(true);
    const localSpelling = "Collision";
    const incomingSpelling = "collision";
    await fs.writeFile(path.join(cwd, localSpelling), "local file\n");
    initialHead = await commit(cwd, "Track the local spelling");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, localSpelling));
      await fs.mkdir(path.join(seed, incomingSpelling));
      await fs.writeFile(path.join(seed, incomingSpelling, "remote.txt"), "remote file\n");
    });

    // A case-insensitive filesystem answers `lstat` for either spelling, so recording the collision
    // under the spelling the incoming path used makes the literal Git pathspec match no index entry.
    // The clean local file is then read as work Git cannot reproduce and the whole fast-forward is
    // skipped, even though the replacement is provably safe. Asking Git about the entry's own name
    // instead lets the replacement proceed.
    await prepare();

    expect(remoteHead).not.toBe(initialHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, incomingSpelling, "remote.txt"), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect((await git(cwd, "ls-files", "-z")).split("\0").filter(Boolean)).toEqual([
      `${incomingSpelling}/remote.txt`,
    ]);
    await expect(replacedBytes()).resolves.toEqual(["local file"]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("replaces a clean local directory whose name differs by case from an incoming file", async () => {
    isPathCaseInsensitive.mockReturnValueOnce(true);
    const localSpelling = "Collision";
    const incomingSpelling = "collision";
    await fs.mkdir(path.join(cwd, localSpelling));
    await fs.writeFile(path.join(cwd, localSpelling, "base.txt"), "base file\n");
    initialHead = await commit(cwd, "Track the local spelling");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await fixture.publishIncoming(async (seed) => {
      await fs.rm(path.join(seed, localSpelling), { recursive: true });
      await fs.writeFile(path.join(seed, incomingSpelling), "remote file\n");
    });

    // The other half of the same alias: the local entry is a directory this time, so the incoming
    // file's whole path is the collision and the deletion scan reports nothing missing for it — the
    // name is present under the local spelling. Asking the incoming index with the local spelling
    // matches no index entry at all, so the export would come back empty, the move would set the
    // path aside and nothing would be put back, and the branch would advance over it.
    await prepare();

    expect(remoteHead).not.toBe(initialHead);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.readFile(path.join(cwd, incomingSpelling), "utf8")).resolves.toBe(
      "remote file\n",
    );
    expect((await git(cwd, "ls-files", "-z")).split("\0").filter(Boolean)).toEqual([
      incomingSpelling,
    ]);
    await expect(replacedBytes()).resolves.toEqual(["base file"]);
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves diverged local history and files untouched with one warning", async () => {
    const remoteHead = await publishEarlierTurn();
    await fs.writeFile(path.join(cwd, "local.txt"), "local commit\n");
    const localHead = await commit(cwd, "Local turn");
    await fs.writeFile(path.join(cwd, filename), "local untracked content\n");
    const before = await git(cwd, "status", "--porcelain");

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(localHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("local untracked content\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(binding.branch));
    expect(warn.mock.lastCall?.[0]).toContain(localHead.slice(0, 7));
    expect(warn.mock.lastCall?.[0]).toContain(remoteHead.slice(0, 7));
  });

  it("keeps the session's own tracked-file deletion while materializing new pushed files", async () => {
    // A file tracked since the initial commit that the previous turn deleted locally.
    const keepDeleted = "keep-deleted.txt";
    await fs.writeFile(path.join(cwd, keepDeleted), "to be deleted\n");
    initialHead = await commit(cwd, "Track a file that will be deleted");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await publishEarlierTurn();
    await fs.rm(path.join(cwd, keepDeleted));

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.access(path.join(cwd, keepDeleted))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe(` D ${keepDeleted}\0`);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe(pushedContent);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never starts the credentialed fetch for a fenced turn", async () => {
    const remoteHead = await publishEarlierTurn();
    const controller = new AbortController();
    controller.abort(new Error("worker fenced: owner-epoch-mismatch"));

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: controller.signal,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
  });

  it("rejects the fetch when the turn is fenced while it is being spawned", async () => {
    const remoteHead = await publishEarlierTurn();
    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    let fetchAttempts = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("fetch")) {
        fetchAttempts += 1;
        // The claim closes after the pre-check and before the process starts.
        controller.abort(new Error("worker fenced: credential-replaced"));
      }
      return await runCommand(argv, options);
    });

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
      signal: controller.signal,
    });

    expect(fetchAttempts).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitHub checkout binding failed"));
  });

  it("disables the binding before any token use when a Windows profile is not owner-only", async () => {
    const remoteHead = await publishEarlierTurn();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    inspectPathPermissions.mockResolvedValueOnce({
      ok: true,
      source: "windows-acl",
      ownerTrusted: false,
      groupReadable: true,
      worldReadable: false,
      groupWritable: false,
      worldWritable: false,
    } as never);
    try {
      await expect(prepare()).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("profile is not owner-only"));
  });

  it("never fetches or fast-forwards without a verified GitHub origin", async () => {
    const remoteHead = await publishEarlierTurn();
    const { remoteUrl: _omitted, ...withoutRemote } = binding;

    await prepareWorkerGitHubEnvironment({
      binding: withoutRemote,
      stateDir: path.join(root, "state"),
      turnId: "turn",
      cwd,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("silently leaves the checkout alone when the session branch does not exist on origin", async () => {
    await fs.writeFile(path.join(cwd, filename), "first turn\n");
    const before = await git(cwd, "status", "--porcelain");
    const runCommand = exec.runCommandWithTimeout;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv.includes("fetch") && result.code !== 0) {
        return { ...result, stderr: "fatal: synthetic localized missing branch diagnostic" };
      }
      return result;
    });

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("first turn\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fetches with the private turn token and managed identity environment", async () => {
    const remoteHead = await publishEarlierTurn();
    vi.stubEnv("GH_TOKEN", "inherited-synthetic-token");
    vi.stubEnv("GITHUB_TOKEN", "inherited-synthetic-token");
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    const prepared = await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(prepared?.localIdentityEnv).toMatchObject({
      GH_CONFIG_DIR: expect.stringContaining(path.join(root, "state", "github-profiles")),
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_AUTHOR_NAME: binding.gitAuthor.name,
      GIT_AUTHOR_EMAIL: binding.gitAuthor.email,
    });
    const fetchCall = runner.mock.calls.find(([args]) => args[3] === "fetch");
    expect(fetchCall?.[0]).toEqual([
      "git",
      "-C",
      cwd,
      "fetch",
      "--quiet",
      "origin",
      binding.branch,
    ]);
    const options = fetchCall?.[1];
    if (typeof options !== "object") {
      throw new Error("Expected options for Git fetch");
    }
    expect(options.timeoutMs).toBe(60_000);
    // Project only fixture-owned keys so a failed assertion cannot dump the host environment.
    const expectedEnv = {
      ...prepared?.localIdentityEnv,
      GH_TOKEN: binding.token,
      GITHUB_TOKEN: "",
    };
    const actualEnv = Object.fromEntries(
      Object.keys(expectedEnv).map((key) => [key, options.baseEnv?.[key]]),
    );
    expect(actualEnv).toEqual(expectedEnv);
    expect(JSON.stringify(prepared)).not.toContain(binding.token);
    expect(process.env.GH_TOKEN).toBe("inherited-synthetic-token");
    expect(process.env.GITHUB_TOKEN).toBe("inherited-synthetic-token");
    const profileDir = prepared?.localIdentityEnv?.GH_CONFIG_DIR;
    if (!profileDir) {
      throw new Error("Expected a turn-owned GitHub profile");
    }
    await disposeWorkerGitHubEnvironment(path.join(root, "state"), "turn");
    await expect(fs.access(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a newer profile when the previous turn finishes cleanup", async () => {
    const previous = await prepare();
    const current = await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      turnId: "next-turn",
      cwd,
    });
    const previousProfile = previous?.localIdentityEnv.GH_CONFIG_DIR;
    const currentProfile = current?.localIdentityEnv.GH_CONFIG_DIR;
    expect(previousProfile).toBeTruthy();
    expect(currentProfile).toBeTruthy();
    expect(currentProfile).not.toBe(previousProfile);
    if (!previousProfile || !currentProfile) {
      throw new Error("Expected both turns' GitHub profiles");
    }
    expect(await fs.readFile(path.join(previousProfile, "hosts.yml"), "utf8")).toContain(
      binding.token,
    );
    await disposeWorkerGitHubEnvironment(path.join(root, "state"), "turn");
    expect(await fs.readFile(path.join(currentProfile, "hosts.yml"), "utf8")).toContain(
      binding.token,
    );
    await disposeWorkerGitHubEnvironment(path.join(root, "state"), "next-turn");
    await expect(fs.access(currentProfile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warns and continues without changing local files when origin cannot be fetched", async () => {
    await fs.writeFile(path.join(cwd, filename), "unpublished work\n");
    await fs.rm(path.join(root, "origin.git"), { recursive: true });
    const before = await git(cwd, "status", "--porcelain");

    expect(await prepare()).toMatchObject({ managedLocalIdentity: true });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("unpublished work\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("git fetch failed"));
    expect(warn.mock.lastCall?.[0]).not.toContain(binding.token);
    expect(warn.mock.lastCall?.[0]).not.toContain(origin);
  });
});

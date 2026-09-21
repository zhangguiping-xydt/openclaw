import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
import {
  managedGitHubIdentityEnvironment,
  removeManagedGitHubProfile,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { hasErrnoCode, isMissingPathError } from "../infra/errno.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { isPathCaseInsensitive } from "../infra/path-case.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkerGitHubLaunchBinding } from "./launch-descriptor.js";

const log = createSubsystemLogger("worker/github");

export function disposeWorkerGitHubEnvironment(stateDir: string, turnId: string) {
  return removeManagedGitHubProfile(
    path.join(stateDir, "github-profiles", sha256HexPrefixCore(turnId, 16)),
  );
}

/** Whether the filesystem refused a write because something else is already at that path. */
function isOccupiedPathError(error: unknown) {
  return (
    hasErrnoCode(error, "EEXIST") ||
    hasErrnoCode(error, "EISDIR") ||
    hasErrnoCode(error, "ENOTEMPTY") ||
    hasErrnoCode(error, "ENOTDIR")
  );
}

async function bindWorkerGitHubCheckout(
  cwd: string,
  binding: WorkerGitHubLaunchBinding,
  baseEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const runGit = (
    args: string[],
    timeoutMs: number,
    honorSignal: boolean,
    extraEnv: NodeJS.ProcessEnv = {},
  ) =>
    executeGitCommand(cwd, args, {
      baseEnv: { ...baseEnv, ...extraEnv },
      timeoutMs,
      maxOutputBytes: { stdout: 1_048_576, stderr: 2_048 },
      ...(honorSignal && signal ? { signal } : {}),
    });
  const git = (args: string[], timeoutMs = 5_000) => runGit(args, timeoutMs, true);
  const requireGitWith = async (
    args: string[],
    honorSignal: boolean,
    extraEnv: NodeJS.ProcessEnv = {},
  ) => {
    const result = await runGit(args, 5_000, honorSignal, extraEnv);
    if (result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(`git ${args[0]} failed or output was truncated (exit ${result.code})`);
    }
    return result.stdout;
  };
  const requireGit = (args: string[]) => requireGitWith(args, true);
  // The move below advances the branch only once every incoming file is in place, so a turn fenced
  // partway through cannot leave the workspace half applied: it either completes its bounded local
  // work or leaves the checkout exactly as the next turn expects it. Once the move starts it
  // completes instead of honoring the abort.
  const requireMoveGit = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    requireGitWith(args, false, extraEnv);
  try {
    const repository = await git(["rev-parse", "--absolute-git-dir"]);
    if (repository.code !== 0) {
      return;
    }
    const gitDirectory = repository.stdout.trim();
    if (binding.remoteUrl) {
      const origin = await git(["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        await requireGit(["remote", "add", "origin", binding.remoteUrl]);
      } else if (origin.stdout.trim() !== binding.remoteUrl) {
        await requireGit(["remote", "set-url", "origin", binding.remoteUrl]);
      }
    }
    const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
    const branch = `refs/heads/${binding.branch}`;
    if (head.code !== 0 || head.stdout.trim() !== branch) {
      await requireGit(["update-ref", branch, "HEAD"]);
      await requireGit(["symbolic-ref", "HEAD", branch]);
    }
    // Reconciliation returns files, not commits. Fetch only the admitted origin;
    // fast-forward session commits without overwriting reconciled working bytes.
    if (!binding.remoteUrl || signal?.aborted) {
      return;
    }
    const fetched = await git(["fetch", "--quiet", "origin", binding.branch], 60_000);
    if (fetched.code !== 0) {
      const remoteBranch = await git(["ls-remote", "--exit-code", "--heads", "origin", branch]);
      if (remoteBranch.code === 2) {
        return;
      }
      throw new Error(`git fetch failed (exit ${fetched.code})`);
    }
    await requireGit(["update-ref", `refs/remotes/origin/${binding.branch}`, "FETCH_HEAD"]);
    // A tracked upstream lets a bare `git push` and `git status -sb` work on a fresh checkout.
    await requireGit(["branch", `--set-upstream-to=origin/${binding.branch}`, binding.branch]);
    const local = (await requireGit(["rev-parse", "HEAD"])).trim();
    const remote = (await requireGit(["rev-parse", "FETCH_HEAD"])).trim();
    if (local === remote) {
      return;
    }
    if ((await git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"])).code !== 0) {
      log.warn(
        `GitHub checkout fast-forward skipped: ${binding.branch} HEAD=${local.slice(0, 7)} origin=${remote.slice(0, 7)}`,
      );
      return;
    }
    if (signal?.aborted) {
      return;
    }
    const splitPaths = (stdout: string) => stdout.split("\0").filter(Boolean);
    const listPaths = async (args: string[]) => splitPaths(await requireGit(args));
    const added = await listPaths([
      "diff",
      "--name-only",
      "--diff-filter=A",
      "--no-renames",
      "-z",
      "HEAD",
      "FETCH_HEAD",
      "--",
    ]);
    const caseInsensitive = isPathCaseInsensitive(cwd);
    const localEntriesByDirectory = new Map<
      string,
      Promise<Map<string, { name: string; isDirectory: boolean }>>
    >();
    const findLocalEntry = async (directory: string, name: string) => {
      try {
        const stats = await fs.lstat(path.join(directory, name));
        return { name, isDirectory: stats.isDirectory() };
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        if (!caseInsensitive) {
          return undefined;
        }
      }
      let entries = localEntriesByDirectory.get(directory);
      if (!entries) {
        entries = fs
          .readdir(directory, { withFileTypes: true })
          .then(
            (items) =>
              new Map(
                items.map((item) => [
                  item.name.toLowerCase(),
                  { name: item.name, isDirectory: item.isDirectory() },
                ]),
              ),
          );
        localEntriesByDirectory.set(directory, entries);
      }
      return (await entries).get(name.toLowerCase());
    };
    const removableTrackedCollisions = new Set<string>();
    let hasPathPrefixCollision = false;
    // Inspect only incoming path components; unrelated workspace inventories can exceed output caps.
    for (const addedPath of added) {
      const segments = addedPath.split("/");
      let directory = cwd;
      let collisionPath: string | undefined;
      for (const [index, segment] of segments.entries()) {
        const entry = await findLocalEntry(directory, segment);
        if (!entry) {
          break;
        }
        const isExactPath = index === segments.length - 1;
        if (!entry.isDirectory) {
          if (!isExactPath) {
            collisionPath = path.relative(cwd, path.join(directory, entry.name));
          }
          break;
        }
        if (isExactPath) {
          collisionPath = path.relative(cwd, path.join(directory, entry.name));
          break;
        }
        directory = path.join(directory, entry.name);
      }
      if (!collisionPath) {
        continue;
      }
      const gitPath = collisionPath.split(path.sep).join("/");
      const status = await requireGit([
        "--literal-pathspecs",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
        "--",
        gitPath,
      ]);
      // `-v` tags assume-unchanged (`h`) and skip-worktree (`S`, or `s` when both are set)
      // entries, whose worktree edits status deliberately hides; only a plain cached entry
      // proves the local bytes are reproducible from the index.
      const tracked = await listPaths([
        "--literal-pathspecs",
        "ls-files",
        "-v",
        "--stage",
        "-z",
        "--",
        gitPath,
      ]);
      const isCleanTracked =
        status.length === 0 &&
        tracked.length > 0 &&
        tracked.every((entry) => entry.startsWith("H ") && !entry.startsWith("H 160000 "));
      if (!isCleanTracked) {
        hasPathPrefixCollision = true;
        break;
      }
      // Git reports neither nested repositories, empty directories, named pipes nor sockets, so an
      // empty status cannot prove the subtree the removal would delete is reproducible from the
      // index. Every on-disk entry has to be a tracked path; anything else is local work Git
      // cannot see, and deleting the directory would destroy it with no way to restore it.
      const trackedPaths = new Set(tracked.map((entry) => entry.slice(entry.indexOf("\t") + 1)));
      const holdsUnreproducibleEntry = async (relative: string): Promise<boolean> => {
        const entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true });
        if (entries.length === 0) {
          return true;
        }
        for (const entry of entries) {
          const entryPath = `${relative}/${entry.name}`;
          if (!entry.isDirectory()) {
            if (!trackedPaths.has(entryPath)) {
              return true;
            }
            continue;
          }
          if (await holdsUnreproducibleEntry(entryPath)) {
            return true;
          }
        }
        return false;
      };
      const collisionIsDirectory = (await fs.lstat(path.join(cwd, collisionPath))).isDirectory();
      if (collisionIsDirectory && (await holdsUnreproducibleEntry(gitPath))) {
        hasPathPrefixCollision = true;
        break;
      }
      removableTrackedCollisions.add(collisionPath);
    }
    if (hasPathPrefixCollision) {
      log.warn(`GitHub checkout fast-forward skipped: local path conflicts with ${binding.branch}`);
      return;
    }
    // Paths already missing before the move are the session's own deletions and stay
    // deleted; only files the incoming commits introduce are materialized.
    const deletedBefore = new Set(await listPaths(["ls-files", "--deleted", "-z"]));
    // The checks above cannot reserve what they approved: a background command from an earlier
    // turn still runs as the worker user and can write into an approved path after the
    // classification and before the move. Nothing here may destroy bytes this turn did not write,
    // so no step deletes or overwrites: an approved path is moved into a recovery directory under
    // the Git directory, the incoming files are staged there too and linked into place, which
    // fails instead of overwriting, and a path a writer recreated in the meantime is moved aside
    // and retried. The Git directory is on the checkout's own filesystem and invisible to
    // `git status`, so preserved bytes cannot be mistaken for work to publish, and they stay for
    // the lifetime of the checkout, which is discarded with the worker. Recovery names are digest
    // based, so a legal path of any length still fits the filesystem's component limit, no
    // placement writes through a directory a writer recreated as a symlink to somewhere else, and
    // a failure part way through takes the placements back and puts back what this turn moved,
    // without overwriting a writer's bytes. The branch and the index only move once every incoming
    // file is in place, so a turn that cannot finish leaves the checkout exactly as the next turn
    // expects it and that turn retries the same fast-forward; a turn that lost its authority while
    // classifying must not start the move.
    if (signal?.aborted) {
      return;
    }
    const collisionRecovery = path.join(gitDirectory, "github-checkout-collision-recovery");
    let recoveryDirectory: string | undefined;
    const ensureRecoveryDirectory = async () => {
      if (!recoveryDirectory) {
        await fs.mkdir(collisionRecovery, { recursive: true });
        recoveryDirectory = await fs.mkdtemp(path.join(collisionRecovery, "move-"));
      }
      return recoveryDirectory;
    };
    let recoverySequence = 0;
    // Enough attempts for a writer that keeps recreating the path, while every attempt that moves
    // a blocker aside is still followed by another write into the path it freed.
    const placementAttempts = 8;
    const recoveryName = (relative: string) => {
      recoverySequence += 1;
      const leaf = path.basename(relative);
      const digest = sha256HexPrefixCore(relative.split(path.sep).join("/"), 16);
      return `${recoverySequence}-${digest}${leaf.length <= 64 ? `-${leaf}` : ""}`;
    };
    /** Replacing a path means moving it aside, so a writer's bytes survive at one of the two. */
    const moveAside = async (relative: string) => {
      const preserved = path.join(await ensureRecoveryDirectory(), recoveryName(relative));
      await fs.rename(path.join(cwd, relative), preserved);
      return preserved;
    };
    /**
     * Every restoration refuses an occupied path instead of replacing what is there, so a writer
     * that recreated the path in the meantime keeps its bytes and the preserved entry stays
     * recoverable under the Git directory. Creating a link or a symlink reports the occupant on
     * its own, and a directory is created before it is filled so the only directory a restore can
     * ever replace is the empty one this function just made. Nothing here renames onto a path it
     * checked first: a check is not atomic, and a rename would overwrite what appeared after it.
     */
    const restoreIntoFreePath = async (preserved: string, target: string): Promise<boolean> => {
      const stats = await fs.lstat(preserved).catch(() => undefined);
      if (!stats) {
        return false;
      }
      if (stats.isDirectory()) {
        if (
          !(await fs
            .mkdir(target)
            .then(() => true)
            .catch(() => false))
        ) {
          return false;
        }
        if (
          await fs
            .rename(preserved, target)
            .then(() => true)
            .catch(() => false)
        ) {
          return true;
        }
        // Replacing the directory just created is not portable, so its entries go back one by one;
        // an entry a writer claimed in the meantime keeps its bytes where they already are.
        let complete = true;
        for (const entry of await fs.readdir(preserved).catch(() => [])) {
          const moved = await fs
            .rename(path.join(preserved, entry), path.join(target, entry))
            .then(() => true)
            .catch(() => false);
          complete = complete && moved;
        }
        return complete;
      }
      if (stats.isSymbolicLink()) {
        const destination = await fs.readlink(preserved).catch(() => undefined);
        return destination === undefined
          ? false
          : await fs
              .symlink(destination, target)
              .then(() => true)
              .catch(() => false);
      }
      return await fs
        .link(preserved, target)
        .then(() => true)
        .catch(() => false);
    };
    const restoreAside = async (relative: string, preserved: string) => {
      if (await restoreIntoFreePath(preserved, path.join(cwd, relative))) {
        // Failing to unlink the preserved name only leaves the same entry reachable twice, and the
        // copy under the Git directory is the recoverable one, so it is never an error.
        await fs.rm(preserved, { recursive: true, force: true }).catch(() => {});
      }
    };
    /**
     * The path a writer's file occupies on the way to `relative`, or the path itself when the
     * whole path exists as directories. Walking from the top finds the blocker whatever errno the
     * filesystem chose: `mkdir` of a path that is a file reports `EEXIST`, while a `mkdir` or
     * `link` below a file reports `ENOTDIR`.
     */
    const blockingPath = async (relative: string) => {
      let current = "";
      for (const segment of relative.split(path.sep)) {
        current = current ? path.join(current, segment) : segment;
        const stats = await fs.lstat(path.join(cwd, current)).catch(() => undefined);
        if (!stats) {
          // Nothing is in the way below this point, so the retry can create the rest itself.
          return undefined;
        }
        if (!stats.isDirectory()) {
          return current;
        }
      }
      return relative;
    };
    /**
     * Creates the directories an incoming path needs, refusing every ancestor that is not a real
     * directory. A recursive `mkdir` resolves a symlinked ancestor and would put the incoming file
     * wherever that link points, outside the checkout, so each component is created on its own and
     * has to be a directory that `lstat` reports as one. A symlink a writer recreated in place of
     * the directory this turn set aside is an occupied path, so the placement retry moves it aside
     * like any other recreation instead of writing through it. Only the components this turn
     * creates are recorded, so a rollback cannot remove a directory the checkout already had.
     */
    const createdDirectories: string[] = [];
    const createRealDirectories = async (relative: string) => {
      let current = "";
      for (const segment of relative.split(path.sep)) {
        current = current ? path.join(current, segment) : segment;
        const target = path.join(cwd, current);
        const existing = await fs.lstat(target).catch(() => undefined);
        if (existing) {
          if (!existing.isDirectory()) {
            throw Object.assign(new Error(`${current} is not a directory`), { code: "EEXIST" });
          }
          continue;
        }
        try {
          await fs.mkdir(target);
        } catch (error) {
          // Only a real directory created by someone else makes this attempt safe to continue.
          const created = await fs.lstat(target).catch(() => undefined);
          if (!created?.isDirectory() || !hasErrnoCode(error, "EEXIST")) {
            throw error;
          }
          continue;
        }
        createdDirectories.push(current);
      }
    };
    const movedAside: Array<{ relative: string; preserved: string }> = [];
    const placed: Array<{ relative: string; staged: string }> = [];
    /**
     * Undoes placements of a failed turn so the checkout goes back to what the next turn expects:
     * the incoming files are gone and the branch never moved, so the next turn repeats the same
     * fast-forward. Only an entry that is still exactly the one this turn placed is removed, which
     * keeps a writer's own bytes: a hard link keeps the placed inode, a placed symlink keeps its
     * destination, and a path a writer replaced is left where it is with the placed copy still
     * recoverable under the Git directory. Directories are pruned only when this turn created them
     * and only while they stayed empty, so a writer's files keep their directory.
     */
    const undoPlacements = async () => {
      for (const { relative, staged } of placed.toReversed()) {
        const target = path.join(cwd, relative);
        const placedEntry = await fs.lstat(target).catch(() => undefined);
        const stagedEntry = await fs.lstat(staged).catch(() => undefined);
        if (!placedEntry || !stagedEntry || placedEntry.isDirectory()) {
          continue;
        }
        const stillPlaced =
          placedEntry.isSymbolicLink() || stagedEntry.isSymbolicLink()
            ? placedEntry.isSymbolicLink() &&
              stagedEntry.isSymbolicLink() &&
              (await fs.readlink(target).catch(() => undefined)) ===
                (await fs.readlink(staged).catch(() => undefined))
            : placedEntry.dev === stagedEntry.dev && placedEntry.ino === stagedEntry.ino;
        if (stillPlaced) {
          await fs.rm(target, { force: true }).catch(() => {});
        }
      }
      for (const directory of createdDirectories.toReversed()) {
        await fs.rmdir(path.join(cwd, directory)).catch(() => {});
      }
    };
    // The incoming history is exported and materialized from its own index, held outside the
    // checkout's index, so HEAD and the index only move after every incoming file is in place.
    const incomingIndex = path.join(gitDirectory, "github-checkout-incoming.index");
    const incomingEnv = { GIT_INDEX_FILE: incomingIndex };
    let staging: string | undefined;
    let replaced = false;
    try {
      for (const collisionPath of removableTrackedCollisions) {
        movedAside.push({ relative: collisionPath, preserved: await moveAside(collisionPath) });
      }
      // A crashed turn can leave the index behind; a stale index file is not a valid one.
      await fs.rm(incomingIndex, { force: true });
      await requireMoveGit(["read-tree", "FETCH_HEAD"], incomingEnv);
      const missing = splitPaths(
        await requireMoveGit(["ls-files", "--deleted", "-z"], incomingEnv),
      ).filter((file) => !deletedBefore.has(file));
      if (missing.length === 0) {
        await requireMoveGit(["reset", "--mixed", "FETCH_HEAD"]);
        replaced = true;
        return;
      }
      // A submodule entry has no content to materialize; Git expects the directory to exist and
      // reports its absence as a deletion of the entry, so those paths are created as directories.
      const stagedEntries = splitPaths(
        await requireMoveGit(
          ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...missing],
          incomingEnv,
        ),
      );
      const gitlinks = new Set(
        stagedEntries
          .filter((entry) => entry.startsWith("160000 "))
          .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
      );
      staging = await fs.mkdtemp(path.join(await ensureRecoveryDirectory(), "incoming-"));
      await requireMoveGit(
        [
          "--literal-pathspecs",
          "checkout-index",
          `--prefix=${staging}${path.sep}`,
          "--",
          ...missing,
        ],
        incomingEnv,
      );
      for (const file of missing) {
        const gitlink = gitlinks.has(file);
        const staged = path.join(staging, file);
        const stats = gitlink ? undefined : await fs.lstat(staged).catch(() => undefined);
        if (!gitlink && !stats) {
          continue;
        }
        const target = path.join(cwd, file);
        const place = async () => {
          // A submodule entry has no content of its own, so the directory Git expects is the whole
          // result; everything else needs its parent directories to exist first.
          const directories = gitlink ? file : path.dirname(file);
          if (directories !== ".") {
            await createRealDirectories(directories);
          }
          if (gitlink) {
            return;
          }
          if (stats?.isSymbolicLink()) {
            await fs.symlink(await fs.readlink(staged), target);
          } else {
            // Linking refuses an occupied path, so a writer's bytes are never overwritten.
            await fs.link(staged, target);
          }
        };
        let materialized = false;
        for (let attempt = 0; attempt < placementAttempts && !materialized; attempt += 1) {
          try {
            await place();
            materialized = true;
          } catch (error) {
            if (!isOccupiedPathError(error)) {
              // A directory that vanished between the two steps is recreated by the next attempt.
              if (isMissingPathError(error)) {
                continue;
              }
              throw error;
            }
            const blocking = await blockingPath(file);
            if (!blocking) {
              continue;
            }
            // Never end the loop on a move: every move has to be followed by a write into the path
            // it freed, or the replacement is left incomplete with nothing to retry it.
            if (attempt + 1 >= placementAttempts) {
              break;
            }
            await moveAside(blocking);
          }
        }
        if (!materialized) {
          // The branch has not moved, so the next turn repeats this fast-forward with the writer's
          // bytes preserved under the Git directory.
          throw new Error(`incoming path stayed occupied while a writer kept recreating it`);
        }
        placed.push({ relative: file, staged });
      }
      await requireMoveGit(["reset", "--mixed", "FETCH_HEAD"]);
      replaced = true;
    } catch (error) {
      // Nothing has moved yet, so put the checkout back exactly as this turn found it: the paths
      // this turn set aside are what the next turn's fast-forward expects to classify, and the
      // incoming files this turn already placed are removed again, or the checkout would keep them
      // while HEAD still holds the paths they replaced and the next turn would read that mixture
      // as local work. The removals are limited to the exact entries this turn placed and the
      // restorations never overwrite a writer's bytes, so whatever is left under the Git directory
      // is still recoverable from there.
      if (!replaced) {
        await undoPlacements();
        for (const { relative, preserved } of movedAside) {
          await restoreAside(relative, preserved);
        }
      }
      throw error;
    } finally {
      if (staging) {
        await fs.rm(staging, { recursive: true, force: true });
      }
      await fs.rm(incomingIndex, { force: true });
    }
  } catch (error) {
    // Checkout metadata helps direct publication; a failure must not discard the coding turn.
    log.warn(`GitHub checkout binding failed: ${String(error).slice(0, 2_048)}`);
  }
}

export async function prepareWorkerGitHubEnvironment(params: {
  binding: WorkerGitHubLaunchBinding;
  stateDir: string;
  turnId: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<PreparedGitHubToolEnvironment | undefined> {
  const { binding, stateDir, turnId, cwd, signal } = params;
  registerSecretValueForRedaction(binding.token);
  const profileDir = path.join(stateDir, "github-profiles", sha256HexPrefixCore(turnId, 16));
  try {
    // Each turn owns its path; retained commands keep their existing credentials.
    await removeManagedGitHubProfile(profileDir);
    await writeManagedGitHubProfileFiles(profileDir, binding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker GitHub identity profile could not be written: ${message}`, {
      cause: error,
    });
  }
  const localIdentityEnv = managedGitHubIdentityEnvironment({
    profileDir,
    gitAuthor: binding.gitAuthor,
    // Reset inherited helpers so paired-device credentials cannot override the turn identity.
    gitConfig: [
      ["credential.helper", ""],
      ["credential.helper", "!gh auth git-credential"],
    ],
  });
  if (process.platform === "win32") {
    const permissions = await inspectPathPermissions(profileDir);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      log.warn(`GitHub binding skipped: profile is not owner-only: ${profileDir}`);
      return undefined;
    }
  }
  await bindWorkerGitHubCheckout(
    cwd,
    binding,
    {
      ...process.env,
      ...localIdentityEnv,
      GH_TOKEN: binding.token,
      GITHUB_TOKEN: "",
    },
    signal,
  );
  return {
    managedLocalIdentity: true,
    excludedStoreNames: [],
    credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
    localIdentityEnv,
  };
}

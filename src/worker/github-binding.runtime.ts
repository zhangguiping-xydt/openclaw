import fs from "node:fs/promises";
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
import { createCheckoutPaths } from "./github-binding.checkout-paths.js";
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
  // work or leaves the checkout exactly as the next turn expects it. The step that can still reach
  // the network — exporting the incoming content, which fetches a blobless clone's missing blobs
  // with the turn's credentials — runs while the abort is still honored, so the phase that ignores
  // the fence only moves and links what is already on disk.
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
    /**
     * The components of a Git path, which is `/`-separated on every platform: splitting on the
     * checkout's own separator makes a nested incoming path a single component on Windows, and
     * creating it fails with ENOENT before its parent exists. Joining back with `/` is for the same
     * reason; `path.join` turns that into the platform's separators when an entry is created.
     */
    // The directory-boundary rules a placement has to satisfy live in their own module: each rule
    // re-reads the filesystem instead of trusting an earlier check, and every creation site uses the
    // same ones, so they are kept together rather than beside the code that calls them.
    const {
      blockingPath,
      resolvesInsideCheckout,
      reachesIntendedDirectories,
      createdDirectories,
      createRealDirectories,
    } = createCheckoutPaths(cwd);
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
      // A case-insensitive filesystem answers `lstat` for any spelling of an entry it holds, so the
      // fast path would hand back the spelling the caller asked for instead of the one on disk. The
      // collision is then recorded under that spelling and classified with the literal Git pathspec
      // it produces, which matches no index entry, so a replacement that is provably clean stays
      // blocked under whatever spelling the incoming history happens to use. The entry's own name is
      // therefore read from the directory listing, which is cached per directory and is what the
      // caller records as the collision path.
      if (!caseInsensitive) {
        try {
          const stats = await fs.lstat(path.join(directory, name));
          return { name, isDirectory: stats.isDirectory() };
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
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
    // without overwriting a writer's bytes or deleting anything a writer may have written since.
    // A placement a writer has modified in place is put back at its own path when it is still free,
    // and both copies stay reachable otherwise, so the writer's bytes are never the price of the
    // rollback. The branch, the index and the working tree only move once every incoming file is in
    // place, so a turn that cannot finish leaves the checkout as the next turn expects it and that
    // turn retries the same fast-forward; a turn that lost its authority while classifying must not
    // start the move.
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
      // A restoration creates names in the checkout, so it owes the same parent guarantee a placement
      // owes: the directory this turn created can be replaced with a link by a writer, and after that
      // every entry restored below would be created at the link's target instead of at the path the
      // next turn reads. Each call re-reads its own parent chain, so the recursive call that fills a
      // restored directory catches a link that appears while its entries are going back, and the
      // preserved copy simply stays under the Git directory rather than being placed through it.
      const relativeTarget = path.relative(cwd, target);
      if (
        path.isAbsolute(relativeTarget) ||
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${path.sep}`)
      ) {
        return false;
      }
      if (!(await reachesIntendedDirectories(path.dirname(relativeTarget)))) {
        return false;
      }
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
        // Replacing the directory just created is not portable, so its entries go back one by one
        // through this same function: each of them refuses the name it finds occupied, and a writer
        // that filled the new directory in the meantime keeps its bytes where they already are. An
        // entry that could not be put back leaves the preserved copy under the Git directory, which
        // is why the caller only discards it once every entry is back.
        let complete = true;
        for (const entry of await fs.readdir(preserved).catch(() => [])) {
          const restored = await restoreIntoFreePath(
            path.join(preserved, entry),
            path.join(target, entry),
          );
          complete = restored && complete;
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
      if (!(await restoreIntoFreePath(preserved, path.join(cwd, relative)))) {
        return;
      }
      // Failing to unlink the preserved name only leaves the same entry reachable twice, and the
      // copy under the Git directory is the recoverable one, so it is never an error.
      const entry = await fs.lstat(preserved).catch(() => undefined);
      if (!entry) {
        return;
      }
      if (!entry.isDirectory()) {
        await fs.rm(preserved, { force: true }).catch(() => {});
        return;
      }
      // A restored directory is emptied by a non-recursive `rmdir`, never by a recursive removal.
      // A background command that kept its working directory inside the directory this turn moved
      // can create a file there after the restoration enumerated the entries, and that file's only
      // name is the one under the Git directory: a recursive removal would take those bytes with
      // it. `rmdir` reports the directory as not empty instead, which leaves the name, the entries
      // that were restored and were never deleted, and the late file all recoverable.
      await fs.rmdir(preserved).catch(() => {});
    };
    /**
     * Takes a placement that resolved outside the checkout back into the recovery directory. The
     * entry is moved rather than removed, so bytes a writer wrote through the misdirected name are
     * not the price of refusing the placement, and the path is free for the retry that follows.
     */
    const takeBackMisplaced = async (relative: string, target: string) => {
      const preserved = path.join(await ensureRecoveryDirectory(), recoveryName(relative));
      await fs.rename(target, preserved).catch(() => {});
    };
    const movedAside: Array<{ relative: string; preserved: string }> = [];
    const placed: Array<{
      relative: string;
      staged: string;
      /** Size and modification time the incoming link was created with, from the staging copy. */
      size: number;
      mtimeMs: number;
    }> = [];
    /**
     * Undoes placements of a failed turn so the checkout goes back to what the next turn expects:
     * the incoming files are gone and the branch never moved, so the next turn repeats the same
     * fast-forward. Nothing here deletes a placed path. Each placed name is *moved* into the
     * recovery directory, which is atomic: at no instant is the entry absent from every name, so a
     * writer that appended to or truncated the file through its checkout name in the window after
     * this turn looked at it keeps those bytes in the moved entry, and no comparison can authorize a
     * removal that would destroy a write that landed after it. Moving this turn's own copy aside
     * also leaves the incoming path free, which is exactly what the next classification expects.
     *
     * The moved entry is then compared with the size and modification time the staging copy was
     * linked with. A match is the incoming copy this turn placed, and it simply stays under the Git
     * directory. Anything else holds bytes a writer wrote since, so it is put back at its own path
     * through the same refusal a restoration uses, which cannot overwrite and leaves both copies
     * reachable when the path was taken again. That comparison only chooses between those two
     * outcomes, so a stale reading cannot lose anything. Directories are pruned only when this turn
     * created them and only while they stayed empty, so a writer's files keep their directory.
     */
    const undoPlacements = async (): Promise<void> => {
      for (const { relative, staged, size, mtimeMs } of placed.toReversed()) {
        const target = path.join(cwd, relative);
        const placedEntry = await fs.lstat(target).catch(() => undefined);
        if (!placedEntry) {
          continue;
        }
        const stagedEntry = await fs.lstat(staged).catch(() => undefined);
        if (!stagedEntry) {
          continue;
        }
        const preserved = path.join(await ensureRecoveryDirectory(), recoveryName(relative));
        if (
          !(await fs
            .rename(target, preserved)
            .then(() => true)
            .catch(() => false))
        ) {
          continue;
        }
        const moved = await fs.lstat(preserved).catch(() => undefined);
        if (!moved) {
          continue;
        }
        const stillPlaced = moved.isDirectory()
          ? false
          : moved.isSymbolicLink() || stagedEntry.isSymbolicLink()
            ? moved.isSymbolicLink() &&
              stagedEntry.isSymbolicLink() &&
              (await fs.readlink(preserved).catch(() => undefined)) ===
                (await fs.readlink(staged).catch(() => undefined))
            : moved.dev === stagedEntry.dev &&
              moved.ino === stagedEntry.ino &&
              moved.size === size &&
              moved.mtimeMs === mtimeMs;
        if (!stillPlaced) {
          await restoreIntoFreePath(preserved, target);
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
    /**
     * `reset --mixed` writes the checkout's index before it moves the branch, so a failure after
     * that point leaves the incoming entries staged against the head the checkout still has, and
     * every later turn would read that mixture as local work and keep skipping the fast-forward.
     * The index is copied before the move and put back byte for byte when the move fails, and a
     * checkout whose index cannot be copied is not one this turn advances: the reset writes the
     * index anyway, and a branch ref that then refused would leave the mixture behind with no copy
     * to put back. The copy is discarded only once it is not the checkout's own index — after the
     * reset it describes, or after it was put back — and an unsuccessful restoration keeps it,
     * because it then holds the only copy of the index the checkout still describes.
     */
    const previousIndex = path.join(gitDirectory, "github-checkout-previous.index");
    let indexBackup: "absent" | "live" | "spent" = "absent";
    /**
     * A turn that could not put the index back keeps its copy, because it is then the only description
     * of the head the checkout still has. The name it keeps is fixed, so the next turn would discard
     * it in its own cleanup or overwrite it while preparing its copy, and the preservation would last
     * only until that turn reached these paths. An outstanding copy is therefore moved under the
     * recovery directory first, where it keeps a name of its own and no later turn reuses it; a copy
     * that cannot be moved aside stops the turn before it mutates anything.
     */
    const outstandingIndex = await fs.lstat(previousIndex).catch(() => undefined);
    if (outstandingIndex) {
      const kept = await fs.mkdtemp(path.join(await ensureRecoveryDirectory(), "previous-index-"));
      await fs.rename(previousIndex, path.join(kept, "index"));
    }
    const backUpCheckoutIndex = async () => {
      if (indexBackup === "absent") {
        await fs.copyFile(path.join(gitDirectory, "index"), previousIndex);
        indexBackup = "live";
      }
    };
    const putBackCheckoutIndex = async () => {
      if (indexBackup !== "live") {
        return;
      }
      const putBack = await fs
        .rename(previousIndex, path.join(gitDirectory, "index"))
        .then(() => true)
        .catch(() => false);
      if (putBack) {
        indexBackup = "spent";
      }
    };
    /**
     * Whether the branch already sits at the fetched commit. The rollback follows the branch that is
     * actually there instead of inferring it from a command's exit: a reset that failed can still
     * have moved the branch, and putting the previous index back then would describe a head the
     * checkout no longer has and turn the incoming history into local work for every later turn.
     */
    const branchReachedFetchedCommit = async () => {
      const current = await runGit(["rev-parse", "HEAD"], 5_000, false);
      const target = await runGit(["rev-parse", "FETCH_HEAD"], 5_000, false);
      return (
        current.code === 0 && target.code === 0 && current.stdout.trim() === target.stdout.trim()
      );
    };
    /**
     * Moves the branch to the fetched commit after copying the index, which `reset --mixed` writes
     * before it moves the branch. Every reset has to go through here: a failure afterwards leaves
     * the incoming entries staged against the head the checkout still has, and a turn that cannot
     * put the index back leaves the next turn reading that mixture as local work. Only the exit code
     * decides success. The command prints one line per path it changes, so a large reconciliation
     * exceeds the diagnostic output cap and comes back with a truncated stdout on a clean exit with
     * the index written and the branch moved; that is a reporting limit, not a mutation failure, and
     * the rollback re-reads the branch instead of trusting or second-guessing the exit.
     */
    const moveBranchToFetchedCommit = async () => {
      await backUpCheckoutIndex();
      const result = await runGit(["reset", "--mixed", "FETCH_HEAD"], 5_000, false);
      if (result.code !== 0) {
        throw new Error(`git reset --mixed FETCH_HEAD failed (exit ${result.code})`);
      }
      // The index the reset wrote is the one the checkout now has, so the backup is not needed.
      indexBackup = "spent";
    };
    let staging: string | undefined;
    let replaced = false;
    try {
      // A crashed turn can leave the index behind; a stale index file is not a valid one.
      await fs.rm(incomingIndex, { force: true });
      await requireMoveGit(["read-tree", "FETCH_HEAD"], incomingEnv);
      const absent = splitPaths(
        await requireMoveGit(["ls-files", "--deleted", "-z"], incomingEnv),
      ).filter((file) => !deletedBefore.has(file));
      // Exporting is the only step here that may reach the network: this checkout can be a blobless
      // clone, where an entry's content is fetched from the origin on first use, and that fetch
      // carries the turn's credentials. It therefore runs before the first mutation, while the turn
      // still honors the fence, so a fence that lands here aborts with the checkout untouched. The
      // approved paths are exported too, because setting them aside makes them absent: the export
      // covers every path the move below can need, and everything after it only moves and links
      // content that is already on disk.
      const candidates = [...new Set([...absent, ...removableTrackedCollisions])];
      // A submodule entry has no content to materialize; Git expects the directory to exist and
      // reports its absence as a deletion of the entry, so those paths are created as directories.
      const stagedEntries =
        candidates.length === 0
          ? []
          : splitPaths(
              await requireMoveGit(
                ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...candidates],
                incomingEnv,
              ),
            );
      // An `ls-files --stage` line is a mode, an object name, a stage and the path.
      const stagedPath = (entry: string) => entry.slice(entry.indexOf("\t") + 1);
      const exportable = new Set(stagedEntries.map(stagedPath));
      const gitlinks = new Set(
        stagedEntries.filter((entry) => entry.startsWith("160000 ")).map(stagedPath),
      );
      if (exportable.size > 0) {
        staging = await fs.mkdtemp(path.join(await ensureRecoveryDirectory(), "incoming-"));
        try {
          await requireGitWith(
            [
              "--literal-pathspecs",
              "checkout-index",
              `--prefix=${staging}${path.sep}`,
              "--",
              ...exportable,
            ],
            true,
            incomingEnv,
          );
        } catch (error) {
          // The export is the last cancellable step and the first one to touch the network, and
          // nothing has been mutated under it: a fenced turn leaves the checkout as it found it.
          if (signal?.aborted) {
            return;
          }
          throw error;
        }
      }
      // Everything above this line only reads the checkout or prepares scratch state under its Git
      // directory; the loop below is the first step that changes the working tree. The fence is
      // therefore re-read here as well: the preparation above awaits commands that do not observe the
      // abort, and when no entry had to be exported none of them runs at all, so without this check a
      // turn fenced during the preparation would still set the approved paths aside and reset the
      // branch. A turn that is fenced up to here leaves the checkout exactly as it found it; from the
      // first move on, the bounded local work this turn already began completes on content that is
      // already on disk.
      if (signal?.aborted) {
        return;
      }
      for (const collisionPath of removableTrackedCollisions) {
        movedAside.push({ relative: collisionPath, preserved: await moveAside(collisionPath) });
      }
      // Setting a path aside is what makes it absent, so the list is read again after the move: the
      // paths this turn just emptied are exactly the ones the move below has to put back. A path a
      // writer removed from the worktree in between is not one of those, and it is not in the export
      // either, so it is left for the next turn rather than placed from a copy that is not there.
      const missing = splitPaths(
        await requireMoveGit(["ls-files", "--deleted", "-z"], incomingEnv),
      ).filter((file) => !deletedBefore.has(file) && exportable.has(file));
      if (missing.length === 0) {
        await moveBranchToFetchedCommit();
        replaced = true;
        return;
      }
      const stagingDirectory = staging;
      if (stagingDirectory === undefined) {
        // Every path above is one the export covered, so the staging copy is what the move places.
        throw new Error("the incoming content was not exported");
      }
      for (const file of missing) {
        const gitlink = gitlinks.has(file);
        const staged = path.join(stagingDirectory, file);
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
          // Creating the entry resolved the whole pathname, so a writer that swapped an ancestor for
          // a link after `createRealDirectories` checked it would have put the incoming file outside
          // the checkout, where nothing owns it and no later turn repairs it. The resolved parent is
          // read back, and a placement that landed outside is taken back and refused, which moves
          // the link aside on the next attempt like any other occupied path.
          if (!(await resolvesInsideCheckout(target))) {
            await takeBackMisplaced(file, target);
            throw Object.assign(new Error(`${file} landed outside the checkout`), {
              code: "EEXIST",
            });
          }
          // A link to another path in the same checkout resolves inside the root, so it passes the
          // check above while the entry sits at the link's target and the incoming path stays
          // empty. The parent chain is read again for that: the paths this turn approved have to be
          // the directories the entry was created through, and anything else is taken back.
          if (!(await reachesIntendedDirectories(path.dirname(file)))) {
            await takeBackMisplaced(file, target);
            throw Object.assign(new Error(`${file} landed behind a link in the checkout`), {
              code: "EEXIST",
            });
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
        placed.push({
          relative: file,
          staged,
          // Read from the staging copy, which only this turn can reach, so a writer that appends to
          // the placed file later always shows up as a difference in the rollback comparison.
          size: stats?.size ?? 0,
          mtimeMs: stats?.mtimeMs ?? 0,
        });
      }
      await moveBranchToFetchedCommit();
      replaced = true;
    } catch (error) {
      // The rollback follows the branch that is actually there. A reset that failed after it wrote
      // the index can still have moved the branch, so undoing that would restore the previous index
      // against a head it no longer describes and delete the incoming files that head holds.
      replaced ||= await branchReachedFetchedCommit();
      if (replaced) {
        // The branch is at the fetched commit, so the index the reset wrote is the checkout's own.
        indexBackup = "spent";
      }
      // Nothing has moved, so put the checkout back exactly as this turn found it: the paths this
      // turn set aside are what the next turn's fast-forward expects to classify, and the incoming
      // files this turn already placed are taken back out, or the checkout would keep them while
      // HEAD still holds the paths they replaced and the next turn would read that mixture as local
      // work. The index goes back first, because the reset that failed may have written it before it
      // could not move the branch. The rollback never deletes a placed path and its restorations
      // never overwrite a writer's bytes, so whatever is left under the Git directory is still
      // recoverable from there.
      if (!replaced) {
        await putBackCheckoutIndex();
        await undoPlacements();
        for (const { relative, preserved } of movedAside) {
          await restoreAside(relative, preserved);
        }
      }
      throw error;
    } finally {
      // Every placed file keeps a name under the Git directory once the rollback has moved it there,
      // so the staging directory is only ever this turn's own scratch copy of the same bytes; the
      // incoming index is a scratch file for the whole turn. The backup is kept while it is still
      // the only copy of the index the checkout describes, which is what an unsuccessful
      // restoration leaves behind.
      if (staging) {
        await fs.rm(staging, { recursive: true, force: true });
      }
      await fs.rm(incomingIndex, { force: true });
      // "live" is the one state that must survive: it is the index the checkout still describes,
      // reached when the reset ran and putting the copy back did not work.
      if (indexBackup === "absent" || indexBackup === "spent") {
        await fs.rm(previousIndex, { force: true });
      }
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

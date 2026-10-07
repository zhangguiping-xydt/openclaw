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
import { createCheckoutPaths, type CreatedEntry } from "./github-binding.checkout-paths.js";
import { createIndexTransaction } from "./github-binding.index-transaction.js";
import type { WorkerGitHubLaunchBinding } from "./launch-descriptor.js";

const log = createSubsystemLogger("worker/github");

/**
 * The environment the completion phase runs its own commands with. It may only use objects the
 * checkout already holds: a blob that is missing there refuses the command instead of being fetched
 * from the origin with the turn's credentials after the fence stopped being honored.
 */
const noLazyFetchEnv = { GIT_NO_LAZY_FETCH: "1" };

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
  // the fence only moves and links what is already on disk, and writes the incoming index and branch
  // from the objects it already holds.
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
    const removableTrackedCollisions = new Map<string, string>();
    let hasPathPrefixCollision = false;
    // Inspect only incoming path components; unrelated workspace inventories can exceed output caps.
    for (const addedPath of added) {
      const segments = addedPath.split("/");
      let directory = cwd;
      // The local spelling and the incoming one for the same blocking path. Everything asked of the
      // incoming index has to be asked with the incoming spelling: a literal pathspec built from the
      // local spelling of a path whose case differs matches no index entry at all, so the export
      // would come back empty, nothing would be materialized, and the branch would advance over the
      // path the move had just emptied.
      let collision: { local: string; incoming: string } | undefined;
      for (const [index, segment] of segments.entries()) {
        const entry = await findLocalEntry(directory, segment);
        if (!entry) {
          break;
        }
        const isExactPath = index === segments.length - 1;
        if (entry.isDirectory && !isExactPath) {
          directory = path.join(directory, entry.name);
          continue;
        }
        // A local entry that is not a directory where the incoming path continues below it is a
        // collision too; a local file the incoming path ends at is the same entry under one spelling
        // of it and blocks nothing.
        if (entry.isDirectory || !isExactPath) {
          collision = {
            local: path.relative(cwd, path.join(directory, entry.name)),
            incoming: segments.slice(0, index + 1).join("/"),
          };
        }
        break;
      }
      if (!collision) {
        continue;
      }
      const gitPath = collision.local.split(path.sep).join("/");
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
      const collisionIsDirectory = (await fs.lstat(path.join(cwd, collision.local))).isDirectory();
      if (collisionIsDirectory && (await holdsUnreproducibleEntry(gitPath))) {
        hasPathPrefixCollision = true;
        break;
      }
      removableTrackedCollisions.set(collision.local, collision.incoming);
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
    // The path rules a placement and a take-back both owe live in their own module: each one re-reads
    // the filesystem instead of trusting an earlier check, and every creation site uses the same
    // ones, so they are kept together rather than beside the code that calls them. The take-back
    // writes into the recovery directory this turn just named, so it is handed the two callbacks
    // that describe it.
    const {
      blockingPath,
      resolvesInsideCheckout,
      reachesIntendedDirectories,
      createdDirectories,
      createRealDirectories,
      takeBackMisplaced,
      moveIntoRecovery,
    } = createCheckoutPaths(cwd, { ensureRecoveryDirectory, recoveryName });
    /**
     * Replacing a path means moving it aside, so a writer's bytes survive at one of the two. The
     * move itself is guarded where the path rules live: a rename resolves the whole pathname at the
     * instant it runs, so an ancestor a writer swapped for a link would otherwise move a file from
     * outside the checkout into the recovery directory. An undefined answer means the move was
     * refused, which is either the path no longer reaching this checkout's own directories or the
     * caller's fence landing first, and the caller tells those two apart. A caller whose move is the
     * turn's first mutation hands its own fence read down to the site, so the fence is read there,
     * and hands its own mutation report down as well: the move changes the checkout the moment its
     * rename succeeds, so a turn whose first mutation was this move owes the rest of its bounded work
     * even though no placement ran yet.
     */
    const moveAside = (relative: string, admit?: () => boolean, markMutated?: () => void) =>
      moveIntoRecovery(relative, path.join(cwd, relative), admit, markMutated);
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
      // Creating a name resolves the whole pathname, so the parent chain read above can be replaced
      // with a link while the awaits below run: the entry is then created at the link's target, the
      // restoration reports success, and the caller releases the preserved copy, which was the only
      // name left holding the bytes. Every creation below is therefore bracketed the way a placement
      // is: the parent chain is read again immediately before the name is created, the landing is
      // read back afterwards, and an entry that landed elsewhere is taken back into the recovery
      // directory, so nothing this turn created stays outside the checkout and a restoration that
      // reports failure never released the preserved copy.
      const landed = async () =>
        (await resolvesInsideCheckout(target)) &&
        (await reachesIntendedDirectories(path.dirname(relativeTarget)));
      const createRestored = async (created: CreatedEntry, create: () => Promise<unknown>) => {
        if (!(await reachesIntendedDirectories(path.dirname(relativeTarget)))) {
          return false;
        }
        if (
          !(await create()
            .then(() => true)
            .catch(() => false))
        ) {
          return false;
        }
        if (await landed()) {
          return true;
        }
        await takeBackMisplaced(relativeTarget, target, created);
        return false;
      };
      const moveRestored = async () => {
        if (!(await reachesIntendedDirectories(path.dirname(relativeTarget)))) {
          return false;
        }
        if (
          !(await fs
            .rename(preserved, target)
            .then(() => true)
            .catch(() => false))
        ) {
          return false;
        }
        if (await landed()) {
          return true;
        }
        // The rename moved this turn's own copy, so its inode — read from the preserved entry, which
        // only this turn can reach — is what a take-back compares the pathname against.
        await takeBackMisplaced(relativeTarget, target, held);
        return false;
      };
      const stats = await fs.lstat(preserved).catch(() => undefined);
      if (!stats) {
        return false;
      }
      const held: CreatedEntry = { kind: "inode", dev: stats.dev, ino: stats.ino };
      if (stats.isDirectory()) {
        if (!(await createRestored({ kind: "createdDirectory" }, () => fs.mkdir(target)))) {
          return false;
        }
        if (await moveRestored()) {
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
        if (destination === undefined) {
          return false;
        }
        return await createRestored({ kind: "symlink", destination }, () =>
          fs.symlink(destination, target),
        );
      }
      return await createRestored(held, () => fs.link(preserved, target));
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
        // The rollback resolves this pathname again as well, so it owes the same guarantee the move
        // aside owes: an ancestor a writer swapped for a link would make this rename take a file
        // from outside the checkout. A refused move leaves the placement exactly where it is.
        const preserved = await moveIntoRecovery(relative, target);
        if (preserved === undefined) {
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
    // The index copy that has to precede the index write is a concern of its own: it is taken once, put
    // back when the move it describes fails, and kept when putting it back did not work.
    const indexTransaction = await createIndexTransaction({
      gitDirectory,
      ensureRecoveryDirectory,
    });
    /**
     * Whether the branch already sits at the fetched commit. The rollback follows the branch that is
     * actually there instead of inferring it from a command's exit: a move that failed can still
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
     * Admits the first mutation of the move, and only that one. Everything before it reads the
     * checkout or prepares scratch state under its Git directory, while a turn still honours the
     * fence; the awaits that lead here do not observe the abort, so a fence that lands during them
     * would otherwise be missed at the one step that makes the move observable. The fence is
     * therefore re-read here, as late as possible, and each mutation path calls this immediately
     * before its own first write.
     *
     * What makes the turn owe the rest of its bounded work is a write that *succeeded*, not one that
     * was admitted: an attempt that a writer's file refused — an occupied destination, a directory a
     * link redirected — has changed nothing, so a fence that landed while it was failing still finds
     * a checkout the turn never touched and must be able to end the turn. The admission is therefore
     * answered from whether a mutation has been reported, and every syscall that changes the checkout
     * reports itself the moment it succeeds.
     */
    let mutationCommitted = false;
    const admitFirstMutation = () => mutationCommitted || signal?.aborted !== true;
    const noteCommittedMutation = () => {
      mutationCommitted = true;
    };
    /**
     * Whether a refused mutation site was refused by the fence rather than by a path rule. The fence
     * that lands before this turn's first mutation leaves the checkout as the turn found it, so a
     * caller that only reads the refusal can tell the two apart by asking whether anything was ever
     * committed: the site reads the fence itself and reports a write only once it succeeded.
     */
    const refusedByFence = () => !mutationCommitted && signal?.aborted === true;
    /**
     * Moves the branch to the fetched commit, in the two steps `reset --mixed` takes: the index of
     * the incoming commit is written first and the branch moves after it, so a failure between the
     * two leaves the rollback the index it describes rather than a head the checkout never read.
     * Every move goes through here: a failure afterwards leaves the incoming entries staged against
     * the head the checkout still has, and a turn that cannot put the index back leaves the next turn
     * reading that mixture as local work. Only the exit codes decide success.
     *
     * The pair is also what keeps this phase off the network. `reset --mixed` refreshes the working
     * tree against the index it just wrote, and that comparison reads the incoming content of every
     * file it kept: in a blobless checkout those blobs are missing, so the reset fetches them from the
     * origin with the turn's credentials — after the placements, where a fence no longer stops it.
     * `read-tree` writes the same index from the trees alone and `update-ref` moves the branch, and
     * lazy fetching is switched off for both, so an object this phase does not hold refuses the
     * command instead of being fetched. The rollback re-reads the branch rather than trusting or
     * second-guessing those exits.
     */
    const moveBranchToFetchedCommit = async () => {
      await indexTransaction.backUp();
      // An incoming history that only rewrites existing files materializes nothing, so this index
      // write is the first mutation of the turn — and the copy above is a filesystem call that does
      // not observe the abort. Re-reading the fence after it is what keeps a turn fenced while the
      // index was copied from advancing HEAD and replacing the index over an untouched working tree.
      if (!admitFirstMutation()) {
        return;
      }
      await requireMoveGit(["read-tree", "FETCH_HEAD"], noLazyFetchEnv);
      noteCommittedMutation();
      await requireMoveGit(["update-ref", branch, "FETCH_HEAD"], noLazyFetchEnv);
      // The index this wrote is the one the checkout now has, so the backup is not needed.
      indexTransaction.markSpent();
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
      // content that is already on disk — the completion phase writes its index and ref with lazy
      // fetching switched off, so it cannot reach the origin even through an object it lacks.
      // The approved paths are asked of the incoming index under the *incoming* spelling: a literal
      // pathspec built from the local spelling of a path whose case differs matches no index entry,
      // so the export would come back empty, nothing would be materialized, and the branch would
      // advance over the path the move had just emptied.
      const candidates = [...new Set([...absent, ...removableTrackedCollisions.values()])];
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
      // turn fenced during the preparation would still set the approved paths aside. A turn that is
      // fenced up to here leaves the checkout exactly as it found it; from the first move on, the
      // bounded local work this turn already began completes on content that is already on disk.
      if (signal?.aborted) {
        return;
      }
      for (const collisionPath of removableTrackedCollisions.keys()) {
        // Setting the first path aside is this turn's first mutation, and the move's own reads do not
        // observe the abort, so it reads the fence itself at its rename; reporting the mutation
        // before those reads would let a fence that landed during them still set the path aside,
        // which is the opposite of leaving the checkout as the turn found it.
        const preserved = await moveAside(collisionPath, admitFirstMutation, noteCommittedMutation);
        if (preserved === undefined) {
          // A fence that landed before this turn mutated anything has left the checkout as it was
          // found, so the branch stays where it is and the next turn repeats the same fast-forward.
          if (refusedByFence()) {
            return;
          }
          // The classification approved this path from the directory chain it read; a path that no
          // longer reaches that chain must not be moved at all, or the rename would take whatever
          // the pathname now names — a file outside the checkout included — under the Git directory.
          throw new Error(`approved path no longer reaches the checkout: ${collisionPath}`);
        }
        movedAside.push({ relative: collisionPath, preserved });
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
        // The identity of the entry the placement makes, so taking a misdirected one back cannot act
        // on a pathname a writer has since pointed at one of its own files.
        const created: CreatedEntry =
          stats?.isSymbolicLink() === true
            ? { kind: "symlink", destination: await fs.readlink(staged) }
            : { kind: "inode", dev: stats?.dev ?? 0, ino: stats?.ino ?? 0 };
        const place = async (): Promise<boolean> => {
          // A submodule entry has no content of its own, so the directory Git expects is the whole
          // result; everything else needs its parent directories to exist first.
          const directories = gitlink ? file : path.dirname(file);
          if (directories !== ".") {
            // The directory creation is the first write for a nested entry, and it reads the fence
            // itself, immediately before each `mkdir`, after the parent read that does not observe
            // the abort; a refusal there has created nothing, so the turn can still be left as it
            // was found. For an entry with no directory to create, the write below is the first one.
            if (
              !(await createRealDirectories(directories, admitFirstMutation, noteCommittedMutation))
            ) {
              return false;
            }
          }
          if (gitlink) {
            return true;
          }
          // A symlink entry is created from the destination its staging copy holds. Reading it here,
          // rather than reusing the identity read above, is what makes it the placement's last await:
          // the fence below is then the last thing before the syscall, and a turn that lost the
          // checkout while the read ran has created nothing. A top-level entry has no directory to
          // create, so the write below is the first one for it either way.
          const destination = created.kind === "symlink" ? await fs.readlink(staged) : undefined;
          if (!admitFirstMutation()) {
            return false;
          }
          if (destination === undefined) {
            // Linking refuses an occupied path, so a writer's bytes are never overwritten.
            await fs.link(staged, target);
          } else {
            await fs.symlink(destination, target);
          }
          // The entry is in the working tree, so the placement is the turn's mutation even when
          // nothing before it was, and the turn owes the rest of its bounded work from here on.
          noteCommittedMutation();
          // Creating the entry resolved the whole pathname, so a writer that swapped an ancestor for
          // a link after `createRealDirectories` checked it would have put the incoming file outside
          // the checkout, where nothing owns it and no later turn repairs it. The resolved parent is
          // read back, and a placement that landed outside is taken back and refused, which moves
          // the link aside on the next attempt like any other occupied path.
          if (!(await resolvesInsideCheckout(target))) {
            await takeBackMisplaced(file, target, created);
            throw Object.assign(new Error(`${file} landed outside the checkout`), {
              code: "EEXIST",
            });
          }
          // A link to another path in the same checkout resolves inside the root, so it passes the
          // check above while the entry sits at the link's target and the incoming path stays
          // empty. The parent chain is read again for that: the paths this turn approved have to be
          // the directories the entry was created through, and anything else is taken back.
          if (!(await reachesIntendedDirectories(path.dirname(file)))) {
            await takeBackMisplaced(file, target, created);
            throw Object.assign(new Error(`${file} landed behind a link in the checkout`), {
              code: "EEXIST",
            });
          }
          return true;
        };
        // The fence is not read here: reading the staging copy above is only the last await before
        // the first write for an entry that needs no directory, and a nested entry still has the
        // parent `lstat` between this point and its write. Each placement reads the fence itself,
        // immediately before the write it is about to make, which is the last point at which the
        // checkout can still be left exactly as the turn found it. A turn that already set a path
        // aside completes what it began, because that move is what makes the replacement
        // observable and the admission is remembered.
        let materialized = false;
        for (let attempt = 0; attempt < placementAttempts && !materialized; attempt += 1) {
          try {
            if (!(await place())) {
              // The fence landed before this placement's first write and nothing was created, so
              // the checkout is left as the turn found it and the branch does not move.
              return;
            }
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
            // it freed, or the replacement is left incomplete with nothing to retry it. The blocker a
            // retry meets is recorded like the approved paths are, so a turn that later fails puts
            // back every path it moved and not only the ones the classification named.
            if (attempt + 1 >= placementAttempts) {
              break;
            }
            // This move can be the turn's first mutation too — a placement that met an occupied
            // directory has not written anything yet — so it reads the fence at its own rename.
            const preserved = await moveAside(blocking, admitFirstMutation, noteCommittedMutation);
            if (preserved === undefined) {
              // A fence that landed before this turn mutated anything leaves the checkout as it was
              // found; a blocker this turn cannot free without reaching outside the checkout stays
              // occupied, and the placement is refused below.
              if (refusedByFence()) {
                return;
              }
              break;
            }
            movedAside.push({ relative: blocking, preserved });
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
      // The rollback follows the branch that is actually there. A move that failed after it wrote
      // the index can still have moved the branch, so undoing that would restore the previous index
      // against a head it no longer describes and delete the incoming files that head holds.
      replaced ||= await branchReachedFetchedCommit();
      if (replaced) {
        // The branch is at the fetched commit, so the index the move wrote is the checkout's own.
        indexTransaction.markSpent();
      }
      // Nothing has moved, so put the checkout back exactly as this turn found it: the paths this
      // turn set aside are what the next turn's fast-forward expects to classify, and the incoming
      // files this turn already placed are taken back out, or the checkout would keep them while
      // HEAD still holds the paths they replaced and the next turn would read that mixture as local
      // work. The index goes back first, because the move that failed may have written it before it
      // could not move the branch. The rollback never deletes a placed path and its restorations
      // never overwrite a writer's bytes, so whatever is left under the Git directory is still
      // recoverable from there.
      if (!replaced) {
        await indexTransaction.putBack();
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
      // The copy is discarded in every state except the one that must survive: the index the
      // checkout still describes, reached when the move ran and putting it back did not work.
      await indexTransaction.discardUnused();
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

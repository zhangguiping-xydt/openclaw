import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

/**
 * Splits a Git path on `/`. Git reports every path with `/` on every platform, so a walk that split
 * on the platform's own separator would read a nested path as a single component on Windows and make
 * one non-recursive `mkdir` for a directory that does not exist yet.
 */
const pathComponents = (relative: string) => relative.split("/");

/**
 * The identity of the entry a creation made, so taking a misdirected entry back compares what the
 * pathname now names with what this turn created instead of moving whatever is there. A link, or a
 * copy this turn renamed into place, is proven by the inode it shares with the copy the turn holds,
 * a symlink by the destination it was created with, and a directory — which the creation leaves
 * empty — by being the empty directory that creation left.
 */
export type CreatedEntry =
  | { kind: "inode"; dev: number; ino: number }
  | { kind: "symlink"; destination: string }
  | { kind: "createdDirectory" };

type EntryStats = Awaited<ReturnType<typeof fs.lstat>>;

/**
 * Whether the entry a re-resolved pathname names is still the one this turn created. The comparison
 * is what keeps a take-back off an entry that belongs to a writer: a pathname resolved again after a
 * writer moved an ancestor can name one of the writer's files, and dev/ino, a link target or the
 * emptiness of a freshly created directory all distinguish that entry from this turn's own.
 */
async function isCreatedEntry(entry: EntryStats, target: string, created: CreatedEntry) {
  if (created.kind === "symlink") {
    return (
      entry.isSymbolicLink() &&
      (await fs.readlink(target).catch(() => undefined)) === created.destination
    );
  }
  if (created.kind === "createdDirectory") {
    return entry.isDirectory() && (await fs.readdir(target).catch(() => [""])).length === 0;
  }
  return entry.dev === created.dev && entry.ino === created.ino;
}

/**
 * Puts a preserved entry back at a name a move took it from without replacing whatever is there
 * now. A file or a symlink is linked, which refuses a name that already exists instead of taking it
 * over, where the `rename` this replaces would replace the destination silently; the recovery name
 * is released once the entry is back at the other, so the entry is moved rather than copied.
 *
 * A directory cannot be linked, so its name is taken by `mkdir` — which refuses an occupied path on
 * its own — and the preserved directory is then renamed onto the empty directory that just took the
 * name. That empty directory is the only one a rename can replace, and a writer that filled it in
 * the meantime makes the rename fail with nothing lost. A repair that could not be completed gives
 * the name back and leaves the preserved entry under the Git directory, where its caller can still
 * reach it: a refused repair costs the outside name, never the bytes.
 */
async function putBackWithoutReplacing(preserved: string, destination: string) {
  const entry = await fs.lstat(preserved).catch(() => undefined);
  if (!entry) {
    return;
  }
  if (!entry.isDirectory()) {
    const placed = await fs
      .link(preserved, destination)
      .then(() => true)
      .catch(() => false);
    if (placed) {
      await fs.unlink(preserved).catch(() => {});
    }
    return;
  }
  const taken = await fs
    .mkdir(destination)
    .then(() => true)
    .catch(() => false);
  if (!taken) {
    return;
  }
  const restored = await fs
    .rename(preserved, destination)
    .then(() => true)
    .catch(() => false);
  if (!restored) {
    // `rmdir` only succeeds while the name still holds the empty directory this call made, so a
    // directory a writer filled keeps the name that holds it.
    await fs.rmdir(destination).catch(() => {});
  }
}

/**
 * The directory-boundary rules a placement has to satisfy before it may create a name in a checkout,
 * and the rule a take-back has to satisfy before it may move one. Every rule re-reads the filesystem
 * rather than trusting an earlier answer, because each check and the write it guards are separate
 * system calls and a command that is still running as the worker user can change what is between
 * them. A path that fails one of them is an occupied path like any other: the caller takes it back
 * into the recovery directory and retries.
 */
export function createCheckoutPaths(
  cwd: string,
  /**
   * Where a misplaced entry is moved so its bytes survive the refusal, and the name it keeps there.
   * The recovery directory lives under the checkout's Git directory, so the caller that owns it also
   * names the entries in it.
   */
  recovery: {
    ensureRecoveryDirectory: () => Promise<string>;
    recoveryName: (relative: string) => string;
  },
) {
  /**
   * The path a writer's file occupies on the way to `relative`, or the path itself when the
   * whole path exists as directories. Walking from the top finds the blocker whatever errno the
   * filesystem chose: `mkdir` of a path that is a file reports `EEXIST`, while a `mkdir` or
   * `link` below a file reports `ENOTDIR`.
   */
  const blockingPath = async (relative: string) => {
    let current = "";
    for (const segment of pathComponents(relative)) {
      current = current ? `${current}/${segment}` : segment;
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
   * The directory a path's parent resolves to, or `undefined` when that directory is not inside the
   * checkout. Creating or reading an entry resolves the whole pathname at once, so an ancestor a
   * writer swapped for a symlink after this turn checked it can only be observed afterwards, and
   * only the resolved path shows it. The leaf is never followed: a placed symlink points wherever
   * the incoming entry points, which is not a place this decides. The checkout root is resolved the
   * same way, so a checkout under a symlinked temporary directory is not a mismatch. Callers that
   * then change the checkout keep the answer, so the same read can be taken again afterwards and the
   * two compared.
   */
  let checkoutRoot: string | undefined;
  const resolvedCheckoutParent = async (target: string) => {
    checkoutRoot ??= await fs.realpath(cwd).catch(() => undefined);
    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
    if (
      checkoutRoot === undefined ||
      parent === undefined ||
      (parent !== checkoutRoot && !parent.startsWith(`${checkoutRoot}${path.sep}`))
    ) {
      return undefined;
    }
    return parent;
  };
  /** Whether a path resolves inside the checkout, which is all a placement asks of it. */
  const resolvesInsideCheckout = async (target: string) =>
    (await resolvedCheckoutParent(target)) !== undefined;
  /**
   * Whether a checkout-relative path is still reached through the directories this turn approved,
   * which is stricter than resolving inside the root: a writer that replaces one of them with a
   * link to another path in the same checkout keeps the resolved parent inside the checkout while
   * everything created below the link lands at the link's target, so the intended Git path stays
   * empty and no later turn repairs it. Each component is read again and has to be a directory
   * `lstat` reports as one — the same test `createRealDirectories` applies to every component it
   * accepts — so a link, wherever it points, is not a directory this path runs through.
   */
  const reachesIntendedDirectories = async (relative: string) => {
    let current = "";
    for (const segment of pathComponents(relative)) {
      current = current ? `${current}/${segment}` : segment;
      const stats = await fs.lstat(path.join(cwd, current)).catch(() => undefined);
      if (!stats?.isDirectory()) {
        return false;
      }
    }
    return true;
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
  /**
   * Gives back a name a directory creation just took, and drops the turn's record of it so a
   * rollback cannot act on a path this turn no longer holds. The path is resolved the same way the
   * creation resolved it, so the name removed is the one this turn made, wherever the link a writer
   * swapped in points; `rmdir` reports a directory that is no longer empty instead of removing it,
   * so anything a writer put there in the meantime keeps the name that holds it.
   */
  const giveBackCreatedDirectory = async (relative: string) => {
    const given = await fs
      .rmdir(path.join(cwd, relative))
      .then(() => true)
      .catch(() => false);
    if (given) {
      const recorded = createdDirectories.indexOf(relative);
      if (recorded !== -1) {
        createdDirectories.splice(recorded, 1);
      }
    }
  };
  const createRealDirectories = async (
    relative: string,
    admit?: () => boolean,
  ): Promise<boolean> => {
    let current = "";
    for (const segment of pathComponents(relative)) {
      current = current ? `${current}/${segment}` : segment;
      const target = path.join(cwd, current);
      const existing = await fs.lstat(target).catch(() => undefined);
      if (existing) {
        if (!existing.isDirectory()) {
          throw Object.assign(new Error(`${current} is not a directory`), { code: "EEXIST" });
        }
        continue;
      }
      // Creating this directory is the caller's first write, and the `lstat` above is an await that
      // does not observe the abort, so the caller's fence is read here — immediately before the
      // syscall that changes the checkout — rather than at the call that led here. A refusal returns
      // before anything was created, so the caller can leave the checkout as the turn found it.
      if (admit && !admit()) {
        return false;
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
      // The `mkdir` resolved the whole pathname, so a component a writer replaced with a link
      // after its own check would have created this directory wherever that link points. The path
      // is read back and a directory created outside the checkout is refused like any other
      // occupied path, which moves the link aside before the next attempt writes through it. The
      // name this turn took is given back first: the refusal is what ends this attempt, and a retry
      // that succeeded afterwards would otherwise leave a directory this turn made, at a path
      // outside the checkout, behind it.
      if (!(await resolvesInsideCheckout(target))) {
        await giveBackCreatedDirectory(current);
        throw Object.assign(new Error(`${current} is outside the checkout`), { code: "EEXIST" });
      }
      // A link to another path inside the checkout keeps the resolved parent inside the root, so
      // containment alone accepts a directory that the intended path does not reach.
      if (!(await reachesIntendedDirectories(current))) {
        await giveBackCreatedDirectory(current);
        throw Object.assign(new Error(`${current} is behind a link in the checkout`), {
          code: "EEXIST",
        });
      }
    }
    return true;
  };
  /**
   * Takes a placement or a restoration that resolved outside the checkout back into the recovery
   * directory. The entry is moved rather than removed, so bytes a writer wrote through the
   * misdirected name are not the price of refusing the placement, and the path is free for the retry
   * that follows. The name is resolved again here, and a writer can point it at a different entry
   * between the creation and this call: renaming the directory the entry was made in and putting a
   * link to somewhere else in its place makes this pathname name a file that belongs to the writer,
   * outside the checkout. Moving that entry would take an unrelated file under the Git directory and
   * leave the placement behind, so what the pathname names is compared with the entry this turn
   * created first and anything else is left exactly where it is — the placement retry moves the
   * blocker aside and writes into the path it freed instead.
   *
   * The recovery directory this moves the entry into may not exist yet, and creating it is an await
   * like any other, so the writer owns that interval too. The parent the rename would resolve
   * through is therefore read after the directory exists, and the identity is compared again as the
   * last read before the syscall: a writer that moved the name onto one of its own files while the
   * directory was being made is refused here rather than having its file taken under the Git
   * directory. A parent that resolves somewhere else once the rename has run is the same writer
   * working later, and the entry the rename took goes back to the name it had outside, which the
   * answer from before the move is the only record of.
   */
  const takeBackMisplaced = async (relative: string, target: string, created: CreatedEntry) => {
    const preserved = path.join(
      await recovery.ensureRecoveryDirectory(),
      recovery.recoveryName(relative),
    );
    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
    const entry = await fs.lstat(target).catch(() => undefined);
    if (parent === undefined || !entry || !(await isCreatedEntry(entry, target, created))) {
      return;
    }
    const moved = await fs
      .rename(target, preserved)
      .then(() => true)
      .catch(() => false);
    if (!moved) {
      return;
    }
    const afterwards = await fs.realpath(path.dirname(target)).catch(() => undefined);
    if (afterwards !== parent) {
      await putBackWithoutReplacing(preserved, path.join(parent, path.basename(target)));
    }
  };
  /**
   * Moves a path inside the checkout into the recovery directory, and refuses when the pathname no
   * longer reaches the directories this checkout owns. A rename resolves the whole pathname at the
   * instant it runs, so a writer that replaced an ancestor of an approved path with a link would have
   * this turn move a file that lives outside the checkout under the Git directory and destroy the
   * name it had there — and the placement checks that follow cannot put back a source name they
   * never saw.
   *
   * Reading the parent before the move is not enough on its own: the read and the rename are
   * separate system calls, and the writer owns the interval between them. The move therefore takes
   * the parent the rename would resolve through, and takes it again once the rename has run — a
   * parent that now resolves somewhere else is one the rename followed out of the checkout, and the
   * entry it took is put back at the name it had outside. Nothing this turn holds records that name,
   * so the answer from before the move is the only thing that can restore it. Putting the entry back
   * is a write of its own, and the writer that redirected the move owns the name it came from by
   * then: the compensation refuses a name that is occupied rather than replacing what appeared
   * there, so a file the writer refilled the name with keeps its bytes and the entry the move took
   * stays reachable under the Git directory. The destination is resolved first and the caller's
   * fence is read last, so the syscall is the first thing this turn does after it learned both that
   * the path still reaches the checkout and that it still owns it.
   */
  const moveIntoRecovery = async (
    relative: string,
    source: string,
    admit?: () => boolean,
  ): Promise<string | undefined> => {
    const preserved = path.join(
      await recovery.ensureRecoveryDirectory(),
      recovery.recoveryName(relative),
    );
    const parent = await resolvedCheckoutParent(source);
    if (parent === undefined || !(await reachesIntendedDirectories(path.dirname(relative)))) {
      return undefined;
    }
    if (admit && !admit()) {
      return undefined;
    }
    const moved = await fs
      .rename(source, preserved)
      .then(() => true)
      .catch(() => false);
    if (!moved) {
      return undefined;
    }
    const afterwards = await fs.realpath(path.dirname(source)).catch(() => undefined);
    if (afterwards === parent) {
      return preserved;
    }
    await putBackWithoutReplacing(preserved, path.join(parent, path.basename(source)));
    return undefined;
  };
  return {
    blockingPath,
    resolvesInsideCheckout,
    reachesIntendedDirectories,
    createdDirectories,
    createRealDirectories,
    takeBackMisplaced,
    moveIntoRecovery,
  };
}

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
 * Moves every entry of `preserved` into `destination` without replacing a name. A file or a symlink
 * is linked, which refuses a name that already exists; a directory is created and then filled the
 * same way, and its name is released once it holds nothing. Nothing here renames an entry onto a
 * name, so whatever holds one of those names keeps it: a name a writer took over is skipped and the
 * copy under the Git directory keeps the entry that could not be put back.
 */
async function moveEntriesWithoutReplacing(
  preserved: string,
  destination: string,
): Promise<boolean> {
  let complete = true;
  for (const name of await fs.readdir(preserved).catch(() => [])) {
    const from = path.join(preserved, name);
    const to = path.join(destination, name);
    const entry = await fs.lstat(from).catch(() => undefined);
    if (!entry) {
      complete = false;
      continue;
    }
    if (!entry.isDirectory()) {
      if (
        !(await fs
          .link(from, to)
          .then(() => true)
          .catch(() => false))
      ) {
        complete = false;
        continue;
      }
      await fs.unlink(from).catch(() => {});
      continue;
    }
    if (
      !(await fs
        .mkdir(to)
        .then(() => true)
        .catch(() => false))
    ) {
      complete = false;
      continue;
    }
    complete = (await moveEntriesWithoutReplacing(from, to)) && complete;
    await fs.rmdir(from).catch(() => {});
  }
  return complete;
}

/**
 * Puts a preserved entry back at a name a move took it from without replacing whatever is there
 * now. A file or a symlink is linked, which refuses a name that already exists instead of taking it
 * over, where the `rename` this replaces would replace the destination silently; the recovery name
 * is released once the entry is back at the other, so the entry is moved rather than copied.
 *
 * A directory cannot be linked, so its name is taken by `mkdir` — which refuses an occupied path on
 * its own — and its entries then go back through the same refusal. That is deliberately not the
 * single `rename` onto the empty directory this replaces: a rename replaces whatever holds its
 * destination, and the empty directory this call just made is not the only thing that can hold this
 * name — a writer can remove the placeholder and create a directory of its own in the interval
 * before the entries go back, and a rename would then discard it. Filling the name one entry at a
 * time can leave a writer's own entries in place beside the ones being restored, which is what the
 * refusal is for: a refused repair costs the outside name, never the bytes, and the entry that could
 * not be put back stays under the Git directory.
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
  if (!(await moveEntriesWithoutReplacing(preserved, destination))) {
    // `rmdir` only succeeds while the name still holds an empty directory, so a name a writer filled
    // keeps whatever holds it.
    await fs.rmdir(destination).catch(() => {});
    return;
  }
  await fs.rmdir(preserved).catch(() => {});
}

/**
 * The scratch tree this turn keeps under the checkout's Git directory, and the rules that hold it
 * there. The Git directory is the one directory the turn's own commands already write, so it is
 * where scratch state belongs; but a command from an earlier turn still runs as the worker user and
 * can put anything there, and a scratch name is the one thing this turn has to be able to reach by a
 * pathname nobody else chose.
 *
 * A recursive `mkdir` accepts an existing symlink as the directory it names — `lstat` follows
 * nothing, a recursive creation resolves the whole pathname — so a scratch root made that way, and
 * every name created or moved below it afterwards, would end up at the link's target: outside the
 * checkout, under names the turn that put them there cannot describe. Every component here is
 * therefore created on its own and has to be a directory `lstat` reports as one, every name below
 * the root is made by `mkdtemp` so that a writer cannot place anything at it in advance, and each
 * created name is read back and has to resolve inside the Git directory. What acts through the tree
 * afterwards — a rename that carries an entry into it, a recursive removal that releases it —
 * re-reads that boundary rather than trusting the creation, because each creation and the call it
 * leads to are separate system calls.
 */
export function createGitScratch(gitDirectory: string) {
  /**
   * The Git directory's own resolved name, read once. Every other name is measured against it, so a
   * checkout reached through a symlinked temporary directory is not a mismatch.
   */
  let boundary: string | undefined;
  const resolvedBoundary = async () =>
    (boundary ??= await fs.realpath(gitDirectory).catch(() => undefined));
  /** Whether a name resolves to the Git directory itself or to a directory below it. */
  const insideGitDirectory = async (directory: string) => {
    const root = await resolvedBoundary();
    const resolved = await fs.realpath(directory).catch(() => undefined);
    return (
      root !== undefined &&
      resolved !== undefined &&
      (resolved === root || resolved.startsWith(`${root}${path.sep}`))
    );
  };
  /**
   * Creates one uniquely named directory inside a scratch directory, and the scratch directory
   * itself when it does not exist yet. `directory` is the Git directory or one of its children, so
   * only one component can be missing, and it is created without `recursive` — which refuses a link
   * a writer left at that name instead of resolving through it. Both the directory and the name just
   * created are read back: a creation resolves the whole pathname, so a component a writer swapped
   * for a link while it ran would have put the tree at the link's target.
   */
  const make = async (directory: string, prefix: string) => {
    const existing = await fs.lstat(directory).catch(() => undefined);
    if (!existing) {
      await fs.mkdir(directory);
    } else if (!existing.isDirectory()) {
      throw Object.assign(new Error(`${directory} is not a directory`), { code: "EEXIST" });
    }
    if (!(await insideGitDirectory(directory))) {
      throw Object.assign(new Error(`${directory} is outside the git directory`), {
        code: "EEXIST",
      });
    }
    const created = await fs.mkdtemp(path.join(directory, prefix));
    if (!(await insideGitDirectory(created))) {
      throw Object.assign(new Error(`${created} is outside the git directory`), { code: "EEXIST" });
    }
    return created;
  };
  /**
   * Releases a scratch directory. The tree is removed recursively only while its name still resolves
   * to a directory the Git directory owns: a recursive removal resolves the whole pathname at once,
   * so a writer that replaced the scratch root with a link would have this turn empty a directory of
   * its own. The single name is released instead, and `rmdir` reports a directory that is not empty
   * rather than removing it, so whatever a redirect reaches keeps the entries it was aimed at.
   */
  const remove = async (target: string) => {
    if (await insideGitDirectory(target)) {
      await fs.rm(target, { recursive: true, force: true });
      return;
    }
    await fs.rmdir(target).catch(() => {});
  };
  /**
   * Whether a name this turn is about to use as a destination still resolves into the scratch tree:
   * the directory it would be created in, or moved into, has to be one the Git directory owns. Every
   * name the caller builds is made below a scratch root, so the Git directory is the boundary the
   * recovery tree owes, and it is read again here rather than remembered from the creation.
   */
  const insideRecovery = async (target: string) => insideGitDirectory(path.dirname(target));
  return { make, remove, insideRecovery };
}

/** The scratch tree a checkout turn keeps under its Git directory. */
export type GitScratch = ReturnType<typeof createGitScratch>;

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
  /**
   * The scratch tree the recovery directory belongs to. The rename that carries an entry into it is
   * the one step whose destination is not beside its source, so it owes the tree's own boundary
   * rather than the checkout's.
   */
  scratch: GitScratch,
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
  /** The checkout's own resolved name, read once: it is what a parent is measured against. */
  let checkoutRoot: string | undefined;
  /**
   * Whether a parent a pathname resolved to is the checkout or a directory below it. The checkout
   * root is resolved the same way, so a checkout under a symlinked temporary directory is not a
   * mismatch. The answer is about the name that was read, so a caller that keeps it and reads the
   * path again afterwards compares two answers about the same name instead of asking twice.
   */
  const parentIsInsideCheckout = async (parent: string | undefined) => {
    checkoutRoot ??= await fs.realpath(cwd).catch(() => undefined);
    return (
      checkoutRoot !== undefined &&
      parent !== undefined &&
      (parent === checkoutRoot || parent.startsWith(`${checkoutRoot}${path.sep}`))
    );
  };
  /**
   * The directory a path's parent resolves to, or `undefined` when that directory is not inside the
   * checkout. Creating or reading an entry resolves the whole pathname at once, so an ancestor a
   * writer swapped for a symlink after this turn checked it can only be observed afterwards, and
   * only the resolved path shows it. The leaf is never followed: a placed symlink points wherever
   * the incoming entry points, which is not a place this decides.
   */
  const resolvedCheckoutParent = async (target: string) => {
    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
    return (await parentIsInsideCheckout(parent)) ? parent : undefined;
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
    markMutated?: () => void,
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
      // The directory exists, so this turn has changed the checkout and owes the caller the rest of
      // the bounded work it began; a refusal below that gives the name back does not undo that, and
      // a caller that only reported the admission would instead let the next attempt be refused by a
      // fence the turn can no longer honour.
      markMutated?.();
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
   * Sets the entry a resolved pathname names aside, so the name it held is free.
   *
   * Nothing here can name a directory this turn already holds — there is no `renameat`, and the
   * `/dev/fd/<n>/<name>` form does not traverse a held directory on this platform — so the directory
   * a rename acts in is decided by the syscall, not by the reads before it. A writer that replaces a
   * checked ancestor with a link to a directory of its own, then puts the directory back before this
   * turn reads anything again, therefore has the reads before *and* after the move agree about the
   * checkout while the rename acted about the writer's directory.
   *
   * What such a rename cannot hide is *which* entry it moved. The entry is renamed to the name it
   * would keep in the recovery directory, but beside itself, inside the directory the pathname
   * resolves to, and read back there: the two renames act in the same directory, so a redirect moves
   * both ends together and the entry that arrives is the one that left; a redirected rename can
   * therefore only have moved an entry within the directory it went to, and the read-back finds an
   * entry this turn never read. The move is given up then, with that entry put back at the name it
   * came from while the name still resolves there, and an entry the writer owns is left inside the
   * writer's own directory instead of being carried under the Git directory. Only a name this read
   * proved holds the expected entry is then carried across into the recovery directory, and what
   * arrives is read back once more. That second rename is the one step whose destination is not
   * beside its source, and it is the intermediate name — this turn's own, one the writer cannot know
   * to place anything at — that keeps it from carrying an entry the writer owns: a redirect can only
   * make the source name resolve to a directory without it, where the rename finds nothing to move.
   * Every step moves an entry rather than deleting one, and the intermediate name is only ever
   * occupied by this turn: bytes this turn did not write survive, and nothing the writer owns is left
   * under the Git directory.
   *
   * The last rename is also the only one whose destination is not beside its source, and a rename
   * resolves the destination's whole pathname: a writer that replaced the scratch root with a link
   * would have the entry carried outside the checkout, where the read-back would still find it and
   * report a move that finished. Read-back alone cannot answer about a destination, so the tree the
   * caller named is asked about the destination both before the syscall and after it, and an entry
   * that moved through a different tree goes back to the name it still has.
   *
   * The caller reads the entry it expects *before* the path rules that approve the move: a swap still
   * in place when those rules run fails them, and one that came and went between this read and the
   * rename is caught by the read-back below. `admit` is the caller's fence, read as late as it can be
   * before the first syscall that changes the checkout — the entry leaving the path the caller acts
   * on — and `markMutated` is how that syscall reports itself once it succeeded.
   */
  const setAsideVerified = async (
    source: string,
    expected: EntryStats,
    parent: string,
    preserved: string,
    admit?: () => boolean,
    markMutated?: () => void,
  ): Promise<string | undefined> => {
    const holdsExpected = async (at: string) => {
      const entry = await fs.lstat(at).catch(() => undefined);
      return entry !== undefined && entry.dev === expected.dev && entry.ino === expected.ino;
    };
    const held = path.join(parent, path.basename(preserved));
    // The intermediate name is this turn's own invention, so an entry already sitting there is either
    // a leftover of a turn that died between the two renames below or something the writer put there
    // by chance. Renaming over it would replace it, so the move is given up instead: the caller's path
    // is left as it was and the retry that follows reports the same blocker again.
    if (await fs.lstat(held).catch(() => undefined)) {
      return undefined;
    }
    if (admit && !admit()) {
      return undefined;
    }
    if (
      !(await fs
        .rename(source, held)
        .then(() => true)
        .catch(() => false))
    ) {
      return undefined;
    }
    // The path the caller acts on is empty from here on, whatever the renames below answer, so this
    // is the write the turn owes the rest of its bounded work to. Reporting the syscall rather than
    // the admission is what leaves a call that never changed anything free to be refused by a later
    // fence.
    markMutated?.();
    if (!(await holdsExpected(held))) {
      await putBackWithoutReplacing(held, source);
      return undefined;
    }
    // The rename below is the one step whose destination is not beside its source, and it resolves
    // that destination's whole pathname: a writer that replaced the scratch root it runs through with
    // a link would have this move carry the entry out of the checkout, where the read-back would
    // still find the expected entry and report a move that finished. The destination is therefore
    // held to the tree the caller named, read again immediately before the syscall and again after
    // it, and a move that cannot be held to it is given up with the entry put back at its own name.
    if (!(await scratch.insideRecovery(preserved))) {
      await putBackWithoutReplacing(held, source);
      return undefined;
    }
    if (
      !(await fs
        .rename(held, preserved)
        .then(() => true)
        .catch(() => false))
    ) {
      await putBackWithoutReplacing(held, source);
      return undefined;
    }
    if ((await scratch.insideRecovery(preserved)) && (await holdsExpected(preserved))) {
      return preserved;
    }
    await putBackWithoutReplacing(preserved, source);
    return undefined;
  };
  /**
   * Takes a placement or a restoration that resolved outside the checkout back into the recovery
   * directory. The entry is moved rather than removed, so bytes a writer wrote through the
   * misdirected name are not the price of refusing the placement, and the path is free for the retry
   * that follows.
   *
   * The name is resolved again here, and a writer can point it at a different entry between the
   * creation and this call: renaming the directory the entry was made in and putting a link to
   * somewhere else in its place makes this pathname name a file that belongs to the writer, outside
   * the checkout. Moving that entry would take an unrelated file under the Git directory and leave
   * the placement behind, so what the pathname names is compared with the entry this turn created —
   * proven by the inode it shares with the copy only this turn can reach, the destination a symlink
   * was created with, or the emptiness of the directory it made — and anything else is left exactly
   * where it is; the placement retry moves the blocker aside and writes into the path it freed
   * instead.
   *
   * The recovery directory this moves the entry into may not exist yet, and creating it is an await
   * like any other, so the writer owns that interval too. The parent the rename would resolve through
   * is therefore read after the directory exists, and the entry is read at that parent's resolved
   * name, so the comparison and the syscall speak about the same directory. The move itself is the
   * one `setAsideVerified` performs, which is what keeps a rename that resolves through a redirected
   * ancestor from carrying an entry the writer owns under the Git directory.
   */
  const takeBackMisplaced = async (relative: string, target: string, created: CreatedEntry) => {
    const preserved = path.join(
      await recovery.ensureRecoveryDirectory(),
      recovery.recoveryName(relative),
    );
    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
    if (parent === undefined) {
      return;
    }
    const source = path.join(parent, path.basename(target));
    const entry = await fs.lstat(source).catch(() => undefined);
    if (!entry || !(await isCreatedEntry(entry, source, created))) {
      return;
    }
    await setAsideVerified(source, entry, parent, preserved);
  };
  /**
   * Moves a path inside the checkout into the recovery directory, and refuses when the pathname no
   * longer reaches the directories this checkout owns. The caller approved the path from the
   * directory chain it read, and the reads that decide whether the path still reaches that chain are
   * separate system calls from the rename they lead to, so the writer owns the interval between them:
   * the rename then resolves through the writer's link and would take a file that lives outside the
   * checkout under the Git directory, where the name it had there is not recorded anywhere.
   *
   * The entry is read at the parent's resolved name and the path rules are applied after it, which is
   * what makes the two ends of the move cover the whole interval — a swap still in place when the
   * rules run fails them, and one that came and went between this read and the rename is caught by
   * the read-back `setAsideVerified` takes. The destination is resolved first and the caller's fence
   * is read last, so the syscall is the first thing this turn does after it learned both that the
   * path still reaches the checkout and that it still owns it.
   */
  const moveIntoRecovery = async (
    relative: string,
    source: string,
    admit?: () => boolean,
    markMutated?: () => void,
  ): Promise<string | undefined> => {
    const preserved = path.join(
      await recovery.ensureRecoveryDirectory(),
      recovery.recoveryName(relative),
    );
    const parent = await fs.realpath(path.dirname(source)).catch(() => undefined);
    if (parent === undefined) {
      return undefined;
    }
    // The rename consumes the name that was resolved, not the pathname it came from: renaming the
    // pathname resolves through it once more, so a writer that redirects a link it runs through in
    // between has the rename act in the directory the link now names, one this turn never approved.
    // Reading the entry at the resolved name makes the comparison and the syscall speak about the
    // same directory.
    const resolvedSource = path.join(parent, path.basename(source));
    const entry = await fs.lstat(resolvedSource).catch(() => undefined);
    if (entry === undefined) {
      return undefined;
    }
    if (
      !(await parentIsInsideCheckout(parent)) ||
      !(await reachesIntendedDirectories(path.dirname(relative)))
    ) {
      return undefined;
    }
    return await setAsideVerified(resolvedSource, entry, parent, preserved, admit, markMutated);
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

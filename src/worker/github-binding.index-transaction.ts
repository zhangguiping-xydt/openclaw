import fs from "node:fs/promises";
import path from "node:path";
import { isSameEntry, type GitScratch } from "./github-binding.checkout-paths.js";

/**
 * The copy of the checkout's index this turn made, and what it is still needed for.
 *
 * The move writes the checkout's incoming index before it moves the branch, so a failure after that
 * point leaves the incoming entries staged against the head the checkout still has, and every later
 * turn would read that mixture as local work and keep skipping the fast-forward. The index is
 * therefore copied before the move and put back byte for byte when the move fails, and a checkout
 * whose index cannot be copied is not one a turn advances: the move writes the index anyway, and a
 * branch ref that then refused would leave the mixture behind with no copy to put back.
 *
 * The copy is discarded only once it is not the checkout's own index — after the index write it
 * describes, or after it was put back — and an unsuccessful restoration keeps it, because it then
 * holds the only copy of the index the checkout still describes. That last state is the reason a turn
 * also looks for an outstanding copy before it makes its own: the name is fixed, so a later turn
 * would discard it in its own cleanup or overwrite it while preparing its copy, and the preservation
 * would last only until that turn reached these paths.
 *
 * The name is fixed for that reason, which is also what makes it a name a command still running as
 * the worker user can put something at. Neither direction of the copy may therefore resolve through
 * it: the copy is taken with `O_EXCL`, so a link a writer left at the name is refused rather than
 * having the checkout's index written wherever it points, and the copy is moved back only while the
 * name still holds the entry this turn wrote, so a name a writer took over in the meantime cannot
 * have the checkout's index replaced by whatever the writer left there. A turn that cannot take the
 * name is a turn that cannot describe the index it would have to restore, so it does not advance the
 * branch at all.
 *
 * Both ends of the restoration are read for that reason: the name the copy came from, and the
 * checkout's own index, which is the destination of the move and a name a retained command writes as
 * well. An index that no longer holds the entry this turn last knew — the one its own write left, or
 * the one the copy was taken from when nothing was written — is left to whoever wrote it.
 *
 * The copy's own name is read for the same reason in both remaining directions. Discarding it after
 * a successful move removes the entry this turn copied, not whatever holds the name by then; and an
 * outstanding copy an earlier turn left is moved under the recovery directory through that
 * directory's own scratch rules, so the name it is moved into is one this turn made and re-read
 * rather than a path a retained command could have redirected.
 */
type IndexEntry = Awaited<ReturnType<typeof fs.lstat>>;

export const createIndexTransaction = async ({
  gitDirectory,
  ensureRecoveryDirectory,
  scratch,
}: {
  gitDirectory: string;
  ensureRecoveryDirectory: () => Promise<string>;
  scratch: GitScratch;
}) => {
  const index = path.join(gitDirectory, "index");
  const previousIndex = path.join(gitDirectory, "github-checkout-previous.index");
  let state: "absent" | "live" | "spent" = "absent";
  /** The entry this turn's copy is, so putting it back never moves what a writer left there instead. */
  let copy: IndexEntry | undefined;
  /**
   * The last entry this turn knows the checkout's index itself to be: the one the copy was taken
   * from, and then the one this turn's own write left. A restoration only ever replaces that entry,
   * so a command that staged something in between keeps what it staged.
   */
  let known: IndexEntry | undefined;
  // A copy an earlier turn could not put back is moved under the recovery directory first, where it
  // keeps a name of its own and no later turn reuses it.
  if (await fs.lstat(previousIndex).catch(() => undefined)) {
    // The name the copy is moved into is made through the scratch tree's own rules — every component
    // created on its own and the created name read back inside the Git directory — and read again
    // here, immediately before the move, because a rename resolves the whole destination pathname and
    // the recovery directory is a name a command still running as the worker user can replace.
    const kept = await scratch.make(await ensureRecoveryDirectory(), "previous-index-");
    if (await scratch.holds(kept)) {
      await fs.rename(previousIndex, path.join(kept, "index"));
    }
  }
  /** Copies the index once, and only when the checkout does not already have a copy of its own. */
  const backUp = async () => {
    if (state === "absent") {
      await fs.copyFile(index, previousIndex, fs.constants.COPYFILE_EXCL);
      state = "live";
      copy = await fs.lstat(previousIndex).catch(() => undefined);
      known = await fs.lstat(index).catch(() => undefined);
    }
  };
  /**
   * Records the index this turn's own write left, so a restoration is held to the entry this turn
   * last knew the index to be rather than to whatever holds the name at the time it runs.
   */
  const noteIndexWritten = async () => {
    if (state === "live") {
      known = await fs.lstat(index).catch(() => undefined);
    }
  };
  /** Puts the copy back over the index, which is the one state in which it is still needed. */
  const putBack = async () => {
    if (state !== "live") {
      return;
    }
    const held = await fs.lstat(previousIndex).catch(() => undefined);
    if (!isSameEntry(copy, held)) {
      return;
    }
    // The destination is read last, because a rename replaces whatever holds it and the index is a
    // name a command still running as the worker user writes: `git add` from a retained exec stages
    // into it after this turn's own write and before a failure reaches this restoration, and putting
    // the copy back over that update would silently discard what it staged. Only the entry this turn
    // last knew the index to be is replaced; anything else is left to whoever wrote it, and the copy
    // stays where the next turn can still reach it. Git replaces the index through a lock file and a
    // rename, so a staged change is a different entry and never the one compared here.
    const current = await fs.lstat(index).catch(() => undefined);
    if (!isSameEntry(known, current)) {
      return;
    }
    const putBackIntoPlace = await fs
      .rename(previousIndex, index)
      .then(() => true)
      .catch(() => false);
    if (putBackIntoPlace) {
      state = "spent";
    }
  };
  /**
   * Records that the index the copy describes has been replaced by the write that describes the same
   * head, so the copy is no longer any turn's only record of it.
   */
  const markSpent = () => {
    state = "spent";
  };
  /**
   * Discards the copy this turn took, and only while the name still holds that very entry. The name
   * is fixed, so a command still running as the worker user can put a file of its own at it between
   * the copy being spent and this cleanup, and removing the name then would delete that file. A copy
   * this turn never took is not this turn's to remove either: `absent` means the move never reached
   * the copy, so whatever holds the name was put there by someone else.
   */
  const discardUnused = async () => {
    if (state !== "spent" || copy === undefined) {
      return;
    }
    const held = await fs.lstat(previousIndex).catch(() => undefined);
    if (!isSameEntry(copy, held)) {
      return;
    }
    await fs.rm(previousIndex, { force: true });
  };
  return { backUp, noteIndexWritten, putBack, markSpent, discardUnused };
};

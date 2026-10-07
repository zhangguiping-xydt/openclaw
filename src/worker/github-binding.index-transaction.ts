import fs from "node:fs/promises";
import path from "node:path";

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
 */
export const createIndexTransaction = async ({
  gitDirectory,
  ensureRecoveryDirectory,
}: {
  gitDirectory: string;
  ensureRecoveryDirectory: () => Promise<string>;
}) => {
  const index = path.join(gitDirectory, "index");
  const previousIndex = path.join(gitDirectory, "github-checkout-previous.index");
  let state: "absent" | "live" | "spent" = "absent";
  // A copy an earlier turn could not put back is moved under the recovery directory first, where it
  // keeps a name of its own and no later turn reuses it.
  if (await fs.lstat(previousIndex).catch(() => undefined)) {
    const kept = await fs.mkdtemp(path.join(await ensureRecoveryDirectory(), "previous-index-"));
    await fs.rename(previousIndex, path.join(kept, "index"));
  }
  /** Copies the index once, and only when the checkout does not already have a copy of its own. */
  const backUp = async () => {
    if (state === "absent") {
      await fs.copyFile(index, previousIndex);
      state = "live";
    }
  };
  /** Puts the copy back over the index, which is the one state in which it is still needed. */
  const putBack = async () => {
    if (state !== "live") {
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
   * Discards the copy in every state except the one that must survive: `live` is reached when the
   * move ran and putting the copy back did not work, and it then holds the only description of the
   * index the checkout still has.
   */
  const discardUnused = async () => {
    if (state === "absent" || state === "spent") {
      await fs.rm(previousIndex, { force: true });
    }
  };
  return { backUp, putBack, markSpent, discardUnused };
};

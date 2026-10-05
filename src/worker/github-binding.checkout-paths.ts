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
 * The directory-boundary rules a placement has to satisfy before it may create a name in a checkout.
 * Every rule re-reads the filesystem rather than trusting an earlier answer, because each check and
 * the write it guards are separate system calls and a command that is still running as the worker
 * user can change what is between them. A path that fails one of them is an occupied path like any
 * other: the caller takes it back into the recovery directory and retries.
 */
export function createCheckoutPaths(cwd: string) {
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
   * Whether a path resolves inside the checkout. Creating or reading an entry resolves the whole
   * pathname at once, so an ancestor a writer swapped for a symlink after this turn checked it can
   * only be observed afterwards, and only the resolved path shows it. The leaf is never followed:
   * a placed symlink points wherever the incoming entry points, which is not a place this decides.
   * The checkout root is resolved the same way, so a checkout under a symlinked temporary
   * directory is not a mismatch.
   */
  let checkoutRoot: string | undefined;
  const resolvesInsideCheckout = async (target: string) => {
    checkoutRoot ??= await fs.realpath(cwd).catch(() => undefined);
    const parent = await fs.realpath(path.dirname(target)).catch(() => undefined);
    return (
      checkoutRoot !== undefined &&
      parent !== undefined &&
      (parent === checkoutRoot || parent.startsWith(`${checkoutRoot}${path.sep}`))
    );
  };
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
  const createRealDirectories = async (relative: string) => {
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
      // occupied path, which moves the link aside before the next attempt writes through it.
      if (!(await resolvesInsideCheckout(target))) {
        throw Object.assign(new Error(`${current} is outside the checkout`), { code: "EEXIST" });
      }
      // A link to another path inside the checkout keeps the resolved parent inside the root, so
      // containment alone accepts a directory that the intended path does not reach.
      if (!(await reachesIntendedDirectories(current))) {
        throw Object.assign(new Error(`${current} is behind a link in the checkout`), {
          code: "EEXIST",
        });
      }
    }
  };
  return {
    blockingPath,
    resolvesInsideCheckout,
    reachesIntendedDirectories,
    createdDirectories,
    createRealDirectories,
  };
}

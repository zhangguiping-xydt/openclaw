/**
 * Shared fixture for the worker GitHub checkout suites: a real checkout whose binding's GitHub URL
 * is routed to a bare repository on disk, plus the Git commands and inspections those suites drive
 * it with. It lives beside the suites rather than inside one of them because the per-file line cap
 * counts fixture code too, and the checkout behavior needs more than one suite to cover.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import * as exec from "../process/exec.js";
import { prepareWorkerGitHubEnvironment } from "./github-binding.runtime.js";
import type { WorkerGitHubLaunchBinding } from "./launch-descriptor.js";

const workerFixtureRemoteUrl = "https://github.com/openclaw/worker-fixture.git";
export const workerFixtureBranch = "openclaw/session-fixture";
export const workerFixtureBinding = {
  token: "worker-checkout-synthetic-token",
  login: "worker-fixture",
  branch: workerFixtureBranch,
  remoteUrl: workerFixtureRemoteUrl,
  gitAuthor: { name: "Worker Fixture", email: "worker@openclaw.invalid" },
} satisfies WorkerGitHubLaunchBinding;

/** Runs one Git command in the fixture, whose global config the fixture owns. */
async function fixtureGit(directory: string, ...args: string[]) {
  const result = await exec.runExec("git", ["-C", directory, ...args], {
    timeoutMs: 10_000,
    logOutput: false,
  });
  return result.stdout;
}

/** Commits everything a scenario prepared, so the bytes it starts from are a known revision. */
async function fixtureCommit(directory: string, message: string) {
  await fixtureGit(directory, "add", ".");
  await fixtureGit(
    directory,
    "-c",
    "user.name=Worker Fixture",
    "-c",
    "user.email=worker@openclaw.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    message,
  );
  return (await fixtureGit(directory, "rev-parse", "HEAD")).trim();
}

async function recoveryEntries(
  cwd: string,
  root = path.join(cwd, ".git", "github-checkout-collision-recovery"),
) {
  return await fs.readdir(root, { withFileTypes: true }).catch(() => undefined);
}

/**
 * Every byte the replacement set aside under the checkout's Git directory, in path order. Git
 * reports nothing inside its own directory, so this only ever holds what the replacement preserved
 * rather than work a later turn could publish.
 */
async function preservedRecoveryBytes(
  cwd: string,
  root = path.join(cwd, ".git", "github-checkout-collision-recovery"),
): Promise<string[]> {
  const entries = await recoveryEntries(cwd, root);
  if (!entries) {
    return [];
  }
  const contents = await Promise.all(
    entries
      .filter((entry) => !entry.isDirectory() && !entry.isSymbolicLink())
      .map(async (entry) => (await fs.readFile(path.join(root, entry.name), "utf8")).trim()),
  );
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => preservedRecoveryBytes(cwd, path.join(root, entry.name))),
  );
  return [...contents, ...nested.flat()].toSorted();
}

/** Where a preserved symlink still points: a link has no bytes to compare, only a destination. */
async function preservedRecoveryLinks(
  cwd: string,
  root = path.join(cwd, ".git", "github-checkout-collision-recovery"),
): Promise<string[]> {
  const entries = await recoveryEntries(cwd, root);
  if (!entries) {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(await fs.readlink(entryPath));
    } else if (entry.isDirectory()) {
      found.push(...(await preservedRecoveryLinks(cwd, path.join(root, entry.name))));
    }
  }
  return found.toSorted();
}

export type WorkerCheckoutFixture = {
  root: string;
  cwd: string;
  /** The URL that stands in for the binding's GitHub origin. */
  origin: string;
  stateDir: string;
  /** The revision the checkout starts each scenario from; a scenario may commit past it. */
  initialHead: string;
  git: typeof fixtureGit;
  commit: typeof fixtureCommit;
  /** Publishes one commit from a fresh clone onto the session branch, like an earlier turn. */
  publishIncoming: (apply: (seed: string) => Promise<void>) => Promise<string>;
  prepare: (options?: {
    signal?: AbortSignal;
    binding?: WorkerGitHubLaunchBinding;
  }) => Promise<PreparedGitHubToolEnvironment | undefined>;
  preservedBytes: () => Promise<string[]>;
  preservedLinks: () => Promise<string[]>;
  dispose: () => Promise<void>;
};

/** A checkout, a bare origin and the isolation a turn needs, ready for one scenario. */
export const createWorkerCheckoutFixture = async (): Promise<WorkerCheckoutFixture> => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "worker-checkout-")));
  const cwd = path.join(root, "worker");
  const origin = pathToFileURL(path.join(root, "origin.git")).href;
  const stateDir = path.join(root, "state");
  const inheritedConfig = {
    global: process.env.GIT_CONFIG_GLOBAL,
    count: process.env.GIT_CONFIG_COUNT,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_COUNT = "0";
  await fs.mkdir(cwd);
  await fixtureGit(root, "init", "--quiet", "--bare", "origin.git");
  // The binding rewrites origin to the verified GitHub URL; route it to the local bare repository.
  await fixtureGit(root, "config", "--global", `url.${origin}.insteadOf`, workerFixtureRemoteUrl);
  await fixtureGit(cwd, "init", "--quiet", `--initial-branch=${workerFixtureBranch}`);
  const initialHead = await fixtureCommit(cwd, "Initial commit");
  await fixtureGit(cwd, "remote", "add", "origin", origin);
  await fixtureGit(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const git = fixtureGit;
  const commit = fixtureCommit;
  const prepare: WorkerCheckoutFixture["prepare"] = (options = {}) =>
    prepareWorkerGitHubEnvironment({
      binding: options.binding ?? workerFixtureBinding,
      stateDir,
      turnId: "turn",
      cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  return {
    root,
    cwd,
    origin,
    stateDir,
    initialHead,
    git,
    commit,
    prepare,
    publishIncoming: async (apply) => {
      const seed = path.join(root, "earlier-worker");
      await fs.rm(seed, { recursive: true, force: true });
      await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
      await apply(seed);
      const head = await commit(seed, "Earlier turn");
      await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${workerFixtureBranch}`);
      return head;
    },
    preservedBytes: () => preservedRecoveryBytes(cwd),
    preservedLinks: () => preservedRecoveryLinks(cwd),
    dispose: async () => {
      await fs.rm(root, { recursive: true, force: true });
      for (const [key, value] of [
        ["GIT_CONFIG_GLOBAL", inheritedConfig.global],
        ["GIT_CONFIG_COUNT", inheritedConfig.count],
        ["GIT_CONFIG_NOSYSTEM", inheritedConfig.system],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
};

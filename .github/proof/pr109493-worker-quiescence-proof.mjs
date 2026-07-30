import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_HEAD = "c895a54dea0ee92b11c90df95e9382a6644c23d7";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OPENCLAW_PROOF_REPO_ROOT
  ? path.resolve(process.env.OPENCLAW_PROOF_REPO_ROOT)
  : path.resolve(scriptDirectory, "..");
const {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
    ),
  ).href
);

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(description, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function runNodeScript(source, args, env, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 128, signal, stdout, stderr, timedOut });
    });
  });
}

function processStatus(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function processStart(pid) {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(child.pid, "SIGCONT");
  } catch {}
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000),
    ),
  ]);
}

function cleanMessage(value) {
  return value.trim().replaceAll(/\s+/gu, " ").slice(0, 500);
}

const sourcePaths = [
  "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
  "src/gateway/worker-environments/workspace-sync-scripts.test.ts",
];

let root;
let stalled;
let healthy;
let originalWatchdogPid;

try {
  if (process.platform !== "linux") fail("proof requires Linux");
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    fail("proof must run as a non-root POSIX user");
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head !== EXPECTED_HEAD) {
    fail(`expected HEAD ${EXPECTED_HEAD}, got ${head}`);
  }
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...sourcePaths], { cwd: repoRoot });
  execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--", ...sourcePaths], {
    cwd: repoRoot,
  });

  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr109493-proof-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const processList = path.join(root, "controlled-processes.txt");
  const stallTarget = path.join(root, "stall-identity-probe.target");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace), fs.mkdir(bin)]);

  const psWrapper = `#!/bin/sh
case "$*" in
  *"stat=,lstart= -p"*) exec /bin/ps "$@" ;;
  *"lstart= -p"*)
    target=""
    for argument in "$@"; do target=$argument; done
    if [ -f "$OPENCLAW_PROOF_STALL_TARGET" ] && grep -qx "$target" "$OPENCLAW_PROOF_STALL_TARGET"; then
      trap "" TERM
      exec sleep 30
    fi
    exec /bin/ps "$@"
    ;;
  *"pid=,ppid=,uid=,stat=,lstart="*)
    printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"
    while IFS= read -r pid; do
      [ -n "$pid" ] && /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$pid"
    done < "$OPENCLAW_PROOF_PROCESS_LIST"
    ;;
  *) exec /bin/ps "$@" ;;
esac
`;
  const psPath = path.join(bin, "ps");
  await fs.writeFile(psPath, psWrapper, { mode: 0o755 });

  stalled = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  healthy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (!stalled.pid || !healthy.pid) fail("failed to start controlled worker processes");
  await waitFor("controlled processes to start", () => {
    return Boolean(processStart(stalled.pid) && processStart(healthy.pid));
  });
  await fs.writeFile(processList, `${stalled.pid}\n${healthy.pid}\n`);

  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    OPENCLAW_PROOF_PROCESS_LIST: processList,
    OPENCLAW_PROOF_STALL_TARGET: stallTarget,
  };

  console.log("PR109493_WORKER_QUIESCENCE_PROOF");
  console.log(`head=${head}`);
  console.log(`platform=${process.platform}/${process.arch}`);
  console.log(`node=${process.version}`);
  console.log("workspace=<isolated-temporary-workspace>");

  const quiesce = await runNodeScript(
    REMOTE_WORKSPACE_QUIESCE_JS,
    [workspace, "2000"],
    env,
    10_000,
  );
  if (quiesce.code !== 0) fail(`quiesce failed: ${cleanMessage(quiesce.stderr)}`);
  const nonceMatch = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesce.stdout);
  if (!nonceMatch) fail(`unexpected quiesce output: ${cleanMessage(quiesce.stdout)}`);
  const nonce = nonceMatch[1];
  const workspaceKey = createHash("sha256").update(await fs.realpath(workspace)).digest("hex");
  const leaseFile = path.join(home, ".openclaw-worker", "quiescence", `${workspaceKey}.${nonce}.json`);
  const initialLease = JSON.parse(await fs.readFile(leaseFile, "utf8"));
  originalWatchdogPid = initialLease.watchdog?.pid;

  await waitFor("both controlled processes to be quiesced", () => {
    return processStatus(stalled.pid).startsWith("T") && processStatus(healthy.pid).startsWith("T");
  });
  console.log("quiesce=PASS controlled_processes=2 both_suspended=true");

  await fs.writeFile(stallTarget, `${stalled.pid}\n`);
  await fs.writeFile(
    leaseFile,
    JSON.stringify({ ...initialLease, expiresAtMs: Date.now() + 500 }),
    { mode: 0o600 },
  );

  let terminalLease;
  const recoveryStartedAt = Date.now();
  await waitFor(
    "terminal probe-timeout lease and independent sibling recovery",
    async () => {
      terminalLease = JSON.parse(await fs.readFile(leaseFile, "utf8"));
      return (
        terminalLease.watchdog === null &&
        terminalLease.recovery?.state === "probe-timeout" &&
        terminalLease.processes.length === 1 &&
        terminalLease.processes[0].pid === stalled.pid &&
        processStatus(stalled.pid).startsWith("T") &&
        !processStatus(healthy.pid).startsWith("T")
      );
    },
    15_000,
  );
  console.log(
    `terminal_recovery=PASS state=${terminalLease.recovery.state} watchdog=null retained_unverified=1 verified_sibling_resumed=true elapsed_ms=${Date.now() - recoveryStartedAt}`,
  );

  const renew = await runNodeScript(
    REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
    [workspace, nonce, "20000"],
    env,
    10_000,
  );
  if (renew.code === 0 || !renew.stderr.includes("lease retained for operator recovery")) {
    fail(`renew did not report terminal operator recovery: ${cleanMessage(renew.stderr)}`);
  }
  console.log(`renew_terminal_diagnostic=PASS exit=${renew.code} message=${cleanMessage(renew.stderr)}`);

  const blockedResume = await runNodeScript(
    REMOTE_WORKSPACE_RESUME_JS,
    [workspace, nonce],
    env,
    10_000,
  );
  if (blockedResume.code === 0 || !(await exists(leaseFile))) {
    fail("resume unexpectedly succeeded while the identity probe remained stalled");
  }
  console.log(
    `resume_while_probe_stalled=PASS exit=${blockedResume.code} lease_retained=true message=${cleanMessage(blockedResume.stderr)}`,
  );

  await fs.rm(stallTarget, { force: true });
  const recoveredResume = await runNodeScript(
    REMOTE_WORKSPACE_RESUME_JS,
    [workspace, nonce],
    env,
    10_000,
  );
  if (recoveredResume.code !== 0) {
    fail(`resume after probe recovery failed: ${cleanMessage(recoveredResume.stderr)}`);
  }
  await waitFor("remaining process to resume and lease to be removed", async () => {
    return !processStatus(stalled.pid).startsWith("T") && !(await exists(leaseFile));
  });
  console.log("resume_after_probe_recovery=PASS remaining_process_resumed=true lease_removed=true");
  console.log("RESULT=PASS");
} catch (error) {
  console.error(`RESULT=FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (originalWatchdogPid) {
    try {
      process.kill(originalWatchdogPid, "SIGKILL");
    } catch {}
  }
  await Promise.all([terminate(stalled), terminate(healthy)]);
  if (root) await fs.rm(root, { recursive: true, force: true });
}

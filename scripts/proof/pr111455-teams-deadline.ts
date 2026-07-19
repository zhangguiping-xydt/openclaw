import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [targetPath, label, expectedSha] = process.argv.slice(2);
if (!targetPath || !label || !expectedSha || !["base", "head"].includes(label)) {
  throw new Error("usage: pr111455-teams-deadline.ts <node-host.ts> <base|head> <sha>");
}

const logPath = process.env.OPENCLAW_PROOF_LOG;
if (!logPath) {
  throw new Error("OPENCLAW_PROOF_LOG is required");
}

const targetUrl = `${pathToFileURL(resolve(targetPath)).href}?proof=${label}-${Date.now()}`;
const { handleTeamsMeetingsNodeHostCommand } = (await import(targetUrl)) as {
  handleTeamsMeetingsNodeHostCommand: (paramsJSON?: string | null) => Promise<string>;
};

const paramsJSON = JSON.stringify({
  action: "setup",
  audioInputCommand: ["true"],
  audioOutputCommand: ["true"],
  bargeInInputCommand: ["true"],
});

const startedAt = performance.now();
let result: string | undefined;
let errorMessage: string | undefined;
try {
  result = await handleTeamsMeetingsNodeHostCommand(paramsJSON);
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}
const elapsedMs = Math.round(performance.now() - startedAt);
const probeStarts = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("command-v-start "));

const proof = {
  label,
  sha: expectedSha,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  elapsedMs,
  commandProbeStarts: probeStarts.length,
  result,
  errorMessage,
};
console.log(`PROOF_RESULT ${JSON.stringify(proof)}`);

if (process.platform !== "darwin") {
  throw new Error(`expected darwin, got ${process.platform}`);
}

if (label === "base") {
  if (result !== JSON.stringify({ ok: true }) || errorMessage !== undefined) {
    throw new Error(`base setup should complete after all probes: ${JSON.stringify(proof)}`);
  }
  if (probeStarts.length !== 3) {
    throw new Error(`base should start three command probes: ${JSON.stringify(proof)}`);
  }
  if (elapsedMs < 17_000 || elapsedMs > 30_000) {
    throw new Error(`base should accumulate three controlled stalls: ${JSON.stringify(proof)}`);
  }
} else {
  if (result !== undefined || !errorMessage?.includes("Configured audio command not found")) {
    throw new Error(`head setup should stop at the shared deadline: ${JSON.stringify(proof)}`);
  }
  if (probeStarts.length !== 2) {
    throw new Error(`head should not start a third command probe: ${JSON.stringify(proof)}`);
  }
  if (elapsedMs < 9_000 || elapsedMs > 12_500) {
    throw new Error(`head should finish around one 10-second deadline: ${JSON.stringify(proof)}`);
  }
}

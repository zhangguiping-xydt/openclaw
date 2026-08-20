import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runQaSuite } from "../../extensions/qa-lab/src/suite-launch.runtime.ts";

const exactHead = execFileSync("/usr/bin/git", ["rev-parse", "HEAD^"], {
  encoding: "utf8",
}).trim();
if (exactHead !== process.env.EXPECTED_PR_HEAD) {
  throw new Error(`expected PR head ${process.env.EXPECTED_PR_HEAD}, got ${exactHead}`);
}

const outputDir = path.resolve(".artifacts/issue-126311-real-boundary-proof");
const primaryModel = "mock-openai/gpt-5.6-luna";
const fallbackModel = "mock-openai/gpt-5.6-luna-alt";
const requestTrace = [];
let requestSeq = 0;
let upstreamBaseUrl;
let gatewayTempRoot;

function hashId(value) {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex").slice(0, 12)
    : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const proxy = http.createServer(async (req, res) => {
  const seq = ++requestSeq;
  try {
    const bodyBuffer = await readBody(req);
    let body = {};
    try {
      body = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString("utf8")) : {};
    } catch {
      body = {};
    }
    const modelId = typeof body.model === "string" ? body.model : null;
    const inputText = JSON.stringify(body.input ?? "");
    const targetWorker = /subagent terminal reply qa worker:\s*empty/i.test(inputText);
    const hasToolOutput = /function_call_output|custom_tool_call_output/i.test(inputText);
    const shouldInject =
      req.method === "POST" &&
      req.url === "/v1/responses" &&
      modelId === "gpt-5.6-luna" &&
      targetWorker;

    if (shouldInject) {
      const payload = JSON.stringify({
        error: {
          type: "server_error",
          code: "server_is_overloaded",
          message: "QA proof injected primary overload",
        },
      });
      requestTrace.push({
        seq,
        boundary: "real-loopback-http",
        case: "qa-terminal-empty",
        model: primaryModel,
        hasToolOutput,
        httpStatus: 503,
        outcome: "injected-server_is_overloaded",
      });
      res.writeHead(503, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }

    if (!upstreamBaseUrl) {
      throw new Error("QA provider upstream was not captured before the first proxy request");
    }
    const upstreamUrl = new URL(req.url ?? "/", upstreamBaseUrl);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        name === "host" ||
        name === "content-length" ||
        name === "connection"
      ) {
        continue;
      }
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuffer,
    });
    const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseText = responseBuffer.toString("utf8");
    if (targetWorker && req.url === "/v1/responses") {
      requestTrace.push({
        seq,
        boundary: "real-loopback-http",
        case: "qa-terminal-empty",
        model: modelId ? `mock-openai/${modelId}` : null,
        hasToolOutput,
        httpStatus: upstreamResponse.status,
        outcome: upstreamResponse.ok ? "provider-response" : "provider-error",
        plannedWrite:
          responseText.includes('"name":"write"') &&
          responseText.includes("qa-terminal-empty-side-effect.txt"),
        returnedTerminalMarker: responseText.includes(
          "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
        ),
      });
    }
    const responseHeaders = {};
    for (const [name, value] of upstreamResponse.headers) {
      if (
        name !== "content-encoding" &&
        name !== "transfer-encoding" &&
        name !== "content-length"
      ) {
        responseHeaders[name] = value;
      }
    }
    responseHeaders["content-length"] = String(responseBuffer.length);
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(responseBuffer);
  } catch (error) {
    const payload = JSON.stringify({
      error: {
        type: "proxy_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    res.writeHead(502, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
});

await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", resolve);
});
const address = proxy.address();
if (!address || typeof address === "string") {
  throw new Error("fault proxy did not bind a TCP port");
}
const proxyBaseUrl = `http://127.0.0.1:${address.port}/v1`;

let suiteResult;
try {
  const runtimeResult = await runQaSuite({
    repoRoot: process.cwd(),
    outputDir,
    providerMode: "mock-openai",
    primaryModel: fallbackModel,
    alternateModel: primaryModel,
    scenarioIds: ["subagent-completion-direct-fallback"],
    concurrency: 1,
    controlUiEnabled: false,
    failFast: true,
    mutateConfig(cfg) {
      const provider = cfg.models?.providers?.["mock-openai"];
      if (!provider || typeof provider.baseUrl !== "string") {
        throw new Error("QA mock-openai provider config is unavailable");
      }
      upstreamBaseUrl = provider.baseUrl;
      provider.baseUrl = proxyBaseUrl;
      const workspace = cfg.agents?.defaults?.workspace;
      if (typeof workspace !== "string") {
        throw new Error("QA gateway workspace is unavailable");
      }
      gatewayTempRoot = path.dirname(workspace);
      const modelSelection = { primary: primaryModel, fallbacks: [fallbackModel] };
      cfg.agents.defaults.subagents = {
        ...cfg.agents.defaults.subagents,
        model: modelSelection,
      };
      const qaAgent = cfg.agents.entries?.qa;
      if (!qaAgent) {
        throw new Error("QA agent config is unavailable");
      }
      qaAgent.subagents = { ...qaAgent.subagents, model: modelSelection };
      return cfg;
    },
  });
  if (runtimeResult.executionKind !== "flow") {
    throw new Error(`expected one flow QA result, got ${runtimeResult.executionKind}`);
  }
  suiteResult = runtimeResult.result;
} finally {
  await new Promise((resolve) => proxy.close(() => resolve()));
}

if (!gatewayTempRoot) {
  throw new Error("QA gateway runtime root was not captured");
}
const scenario = suiteResult.scenarios.find(
  (candidate) => candidate.name === "Subagent completion terminal-reply delivery",
);
if (!scenario || scenario.status !== "pass") {
  throw new Error(`real-boundary QA scenario did not pass: ${JSON.stringify(scenario ?? null)}`);
}
const details = JSON.parse(scenario.details ?? "{}");
const emptyVerdict = Array.isArray(details.verdicts)
  ? details.verdicts.find((candidate) => candidate?.case === "empty")
  : undefined;
if (!emptyVerdict) {
  throw new Error("QA scenario did not emit the empty-worker terminal verdict");
}

const stateDbPath = path.join(gatewayTempRoot, "state", "state", "openclaw.sqlite");
const stateDb = new DatabaseSync(stateDbPath, { readOnly: true });
const taskRows = stateDb
  .prepare(
    `SELECT task_id, run_id, child_session_key, label, status, delivery_status,
            ended_at, tool_use_count, last_tool_name, terminal_outcome
       FROM task_runs
      WHERE label = 'qa-terminal-empty'
      ORDER BY created_at`,
  )
  .all();
stateDb.close();
if (taskRows.length !== 1) {
  throw new Error(`expected one qa-terminal-empty task row, got ${taskRows.length}`);
}
const task = taskRows[0];
const childSessionKey = typeof task.child_session_key === "string" ? task.child_session_key : "";
const childSessionId = childSessionKey.split(":").at(-1);
if (!childSessionId) {
  throw new Error("target task is missing a child session id");
}

const agentDbPath = path.join(
  gatewayTempRoot,
  "state",
  "agents",
  "qa",
  "agent",
  "openclaw-agent.sqlite",
);
const agentDb = new DatabaseSync(agentDbPath, { readOnly: true });
const trajectoryRows = agentDb
  .prepare(
    `SELECT seq, run_id, event_json
       FROM trajectory_runtime_events
      WHERE session_id = ?
      ORDER BY seq`,
  )
  .all(childSessionId);
agentDb.close();
const trajectory = trajectoryRows.map((row) => {
  const event = JSON.parse(String(row.event_json));
  const data = event && typeof event.data === "object" && event.data ? event.data : {};
  return {
    seq: Number(row.seq),
    type: String(event.type ?? "unknown"),
    provider: typeof data.provider === "string" ? data.provider : undefined,
    model:
      typeof data.model === "string"
        ? data.model
        : typeof data.modelId === "string"
          ? data.modelId
          : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    terminalError: typeof data.terminalError === "string" ? data.terminalError : undefined,
    stopReason: typeof data.stopReason === "string" ? data.stopReason : undefined,
    tool:
      typeof data.toolName === "string"
        ? data.toolName
        : typeof data.name === "string"
          ? data.name
          : undefined,
  };
});
const terminalTrajectory = trajectory.filter((event) => event.type === "session.ended");
const injectedFailures = requestTrace.filter(
  (event) => event.model === primaryModel && event.httpStatus === 503,
);
const fallbackWriteResponses = requestTrace.filter(
  (event) => event.model === fallbackModel && event.httpStatus === 200 && event.plannedWrite === true,
);

const assertions = {
  scenarioPassed: scenario.status === "pass",
  oneTargetTaskRow: taskRows.length === 1,
  taskCompleted: task.status === "completed",
  deliverySettled: task.delivery_status === "delivered",
  taskEnded: typeof task.ended_at === "number" && task.ended_at > 0,
  fallbackExecutedOneWrite: task.tool_use_count === 1 && task.last_tool_name === "write",
  primaryFailureObserved: injectedFailures.length >= 1,
  fallbackWriteObserved: fallbackWriteResponses.length >= 1,
  exactlyOneTerminalTrajectory: terminalTrajectory.length === 1,
  exactlyOneTerminalDelivery: emptyVerdict.actualTerminalSendCount === 1,
};
if (!Object.values(assertions).every(Boolean)) {
  throw new Error(`real-boundary proof assertion failed: ${JSON.stringify(assertions)}`);
}

const evidence = {
  schema: "openclaw-real-boundary-fallback-proof-v1",
  exactHead,
  issue: 126311,
  pr: 126566,
  environment: {
    isolation: "secretless GitHub-hosted fork runner",
    credentials: "none",
    transport: "real loopback HTTP OpenAI Responses boundary",
    gateway: "ephemeral production Gateway child",
    ingress: "qa-channel",
    taskStore: "SQLite task_runs",
    trajectoryStore: "per-agent SQLite trajectory_runtime_events",
  },
  fault: {
    case: "qa-terminal-empty",
    primaryModel,
    injectedStatus: 503,
    injectedCode: "server_is_overloaded",
    fallbackModel,
  },
  requestTrace,
  task: {
    taskIdHash: hashId(task.task_id),
    runIdHash: hashId(task.run_id),
    childSessionHash: hashId(task.child_session_key),
    label: task.label,
    status: task.status,
    deliveryStatus: task.delivery_status,
    ended: typeof task.ended_at === "number" && task.ended_at > 0,
    toolUseCount: task.tool_use_count,
    lastToolName: task.last_tool_name,
    terminalOutcome: task.terminal_outcome,
    terminalDeliveryCount: emptyVerdict.actualTerminalSendCount,
  },
  trajectory,
  terminalTrajectoryCount: terminalTrajectory.length,
  assertions,
  qaArtifacts: {
    report: path.relative(process.cwd(), suiteResult.reportPath),
    evidence: path.relative(process.cwd(), suiteResult.evidencePath),
    summary: path.relative(process.cwd(), suiteResult.summaryPath),
  },
};

await mkdir(outputDir, { recursive: true });
const evidencePath = path.join(outputDir, "redacted-recovery-trace.json");
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write("REAL_BOUNDARY_PROOF_BEGIN\n");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write("REAL_BOUNDARY_PROOF_END\n");

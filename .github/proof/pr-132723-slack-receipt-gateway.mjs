import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RECEIPT_MESSAGE = "Slack inbound event rejected during preparation";
const WEBHOOK_PATH = "/slack/events";
const TEAM_ID = "TMOCK12345";
const APP_ID = "AMOCK12345";
const BOT_USER_ID = "UBOT12345";
const BOT_ID = "BMOCK12345";
const DROP_CHANNEL_ID = "DDROP12345";
const VISIBLE_CHANNEL_ID = "CVISIBLE12";
const SENTINEL_CHANNEL_ID = "DSENTINEL1";
const TWIN_CHANNEL_ID = "CTWIN12345";
const DROP_TS = "1710000000.000100";
const VISIBLE_TS = "1710000000.000200";
const SENTINEL_TS = "1710000000.000300";
const TWIN_TS = "1710000000.000400";
const DROP_BODY_MARKER = "DROP_BODY_MARKER";
const VISIBLE_BODY_MARKER = "VISIBLE_BODY_MARKER";
const SENTINEL_BODY_MARKER = "SENTINEL_BODY_MARKER";
const TWIN_BODY_MARKER = "TWIN_BODY_MARKER";
const STARTUP_TIMEOUT_MS = 60_000;
const EVENT_TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const next = Buffer.from(chunk);
    size += next.length;
    if (size > 1024 * 1024) {
      throw new Error("mock API request exceeded 1 MiB");
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, value, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === "object", "server did not expose a TCP address");
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitFor(predicate, label, timeoutMs = EVENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function attachLogStream(stream, run, streamName, records) {
  let pending = "";
  const flush = (complete) => {
    const parts = pending.split(/\r?\n/u);
    pending = complete ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      if (line) {
        records.push({ run, stream: streamName, line, json: parseJsonLine(line) });
      }
    }
    if (complete && pending) {
      records.push({ run, stream: streamName, line: pending, json: parseJsonLine(pending) });
      pending = "";
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    flush(false);
  });
  stream.on("end", () => flush(true));
}

function projectReceiptRecord(record) {
  if (record?.message !== RECEIPT_MESSAGE) {
    return null;
  }
  const metadata = Object.entries(record)
    .filter(([key]) => /^\d+$/u.test(key))
    .map(([, value]) => value)
    .find(
      (value) =>
        value && typeof value === "object" && !Array.isArray(value) && value.provider === "slack",
    );
  return metadata ? { ...metadata, message: record.message } : { message: record.message };
}

function receiptRecords(records) {
  return records
    .map((record) => ("json" in record ? record.json : record))
    .map(projectReceiptRecord)
    .filter((record) => record !== null);
}

function receiptCount(records, messageTs) {
  return receiptRecords(records).filter((record) => record.messageTs === messageTs).length;
}

function logCount(records, fragment) {
  return records.filter((record) => record.line.includes(fragment)).length;
}

async function readJsonLogRecords(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((record) => record !== null);
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(10_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function buildSlackEvent(eventId, event) {
  return {
    token: "fixture-verification-token",
    team_id: TEAM_ID,
    context_team_id: TEAM_ID,
    api_app_id: APP_ID,
    type: "event_callback",
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: TEAM_ID,
        user_id: BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    event,
  };
}

async function sendSlackEvent({ gatewayPort, signingSecret, eventId, event }) {
  const body = JSON.stringify(buildSlackEvent(eventId, event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const responseBody = await response.text();
  assert(
    response.ok,
    `Slack event ${eventId} returned HTTP ${response.status}: ${responseBody.slice(0, 160)}`,
  );
}

async function findSqliteFiles(root) {
  const matches = [];
  const visit = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.name.endsWith(".sqlite")) {
        matches.push(target);
      }
    }
  };
  await visit(root);
  return matches;
}

const sourceRoot = path.resolve(process.argv[2] ?? "source");
const evidenceDir = path.resolve(process.env.EVIDENCE_DIR ?? path.join(process.cwd(), "evidence"));
const expectedHead = process.env.EXPECTED_SHA?.trim();
assert(/^[0-9a-f]{40}$/u.test(expectedHead ?? ""), "EXPECTED_SHA must be a full commit SHA");
const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
assert(actualHead === expectedHead, "proof source does not match EXPECTED_SHA");

await fs.mkdir(evidenceDir, { recursive: true });
const runnerTemp = path.resolve(process.env.RUNNER_TEMP ?? process.cwd());
const proofRoot = await fs.mkdtemp(path.join(runnerTemp, "pr-132723-gateway-proof-"));
const homeDir = path.join(proofRoot, "home");
const stateDir = path.join(proofRoot, "state");
const workspaceDir = path.join(proofRoot, "workspace");
const tmpDir = path.join(proofRoot, "tmp");
const configPath = path.join(proofRoot, "openclaw.json");
const gatewayLogPath = path.join(proofRoot, "gateway.jsonl");
await Promise.all(
  [homeDir, stateDir, workspaceDir, tmpDir].map((dir) => fs.mkdir(dir, { recursive: true })),
);

const botToken = ["xoxb", "fixture", "pr132723"].join("-");
const signingSecret = ["fixture", "signing", "pr132723"].join("-");
const gatewayToken = ["fixture", "gateway", "pr132723"].join("-");
const providerApiKey = ["fixture", "provider", "pr132723"].join("-");
const slackRequests = [];
const modelRequests = [];
const mockServer = createServer((request, response) => {
  void (async () => {
    const body = await readBody(request);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/v1/")) {
      modelRequests.push({ method: request.method ?? "", pathname });
      writeJson(response, {
        id: "resp_fixture",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      });
      return;
    }
    if (!pathname.startsWith("/api/")) {
      writeJson(response, { ok: false, error: "unknown_fixture_route" }, 404);
      return;
    }
    const method = pathname.slice("/api/".length);
    const form = new URLSearchParams(body);
    slackRequests.push({
      method,
      channel: form.get("channel") ?? undefined,
      user: form.get("user") ?? undefined,
    });
    if (method === "auth.test") {
      writeJson(response, {
        ok: true,
        url: "https://mock.slack.invalid/",
        team: "Mock Slack",
        user: "mock-bot",
        team_id: TEAM_ID,
        user_id: BOT_USER_ID,
        bot_id: BOT_ID,
        app_id: APP_ID,
        is_enterprise_install: false,
      });
      return;
    }
    if (method === "conversations.info") {
      writeJson(response, {
        ok: true,
        channel: {
          id: form.get("channel") ?? VISIBLE_CHANNEL_ID,
          name: "blocked-room",
          is_channel: true,
          is_group: false,
          is_im: false,
          is_mpim: false,
        },
      });
      return;
    }
    if (method === "users.info") {
      const userId = form.get("user") ?? BOT_USER_ID;
      writeJson(response, {
        ok: true,
        user: {
          id: userId,
          name: userId === BOT_USER_ID ? "mock-bot" : "mock-user",
          real_name: userId === BOT_USER_ID ? "Mock Bot" : "Mock User",
          is_bot: userId === BOT_USER_ID,
          profile: {
            display_name: userId === BOT_USER_ID ? "Mock Bot" : "Mock User",
            real_name: userId === BOT_USER_ID ? "Mock Bot" : "Mock User",
          },
        },
      });
      return;
    }
    if (method === "chat.postEphemeral") {
      writeJson(response, {
        ok: true,
        channel: form.get("channel") ?? VISIBLE_CHANNEL_ID,
        message_ts: "1710000000.900001",
      });
      return;
    }
    writeJson(response, { ok: true });
  })().catch(() => {
    if (!response.headersSent) {
      writeJson(response, { ok: false, error: "mock_api_failure" }, 500);
    } else {
      response.destroy();
    }
  });
});

const gatewayLogs = [];
let activeGateway = null;
let mockServerPort;
let gatewayPort;
let verdict = {
  schema: "openclaw.pr132723.slack-receipt-gateway-proof.v2",
  exactHead: expectedHead,
  status: "fail",
  proofKind:
    "secretless mock Slack API + real built ephemeral Gateway; not authenticated live Slack",
  authenticatedSlack: false,
};

try {
  mockServerPort = await listen(mockServer);
  gatewayPort = await reservePort();
  const mockBaseUrl = `http://127.0.0.1:${mockServerPort}`;
  const config = {
    logging: { level: "debug", consoleStyle: "json", file: gatewayLogPath },
    plugins: {
      allow: ["slack"],
      entries: { slack: { enabled: true } },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": {} },
      },
    },
    models: {
      mode: "replace",
      providers: {
        "mock-openai": {
          baseUrl: `${mockBaseUrl}/v1`,
          apiKey: providerApiKey,
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5.6-luna",
              name: "gpt-5.6-luna",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port: gatewayPort,
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    discovery: { mdns: { mode: "off" } },
    channels: {
      slack: {
        enabled: true,
        mode: "http",
        botToken,
        signingSecret,
        webhookPath: WEBHOOK_PATH,
        dm: { enabled: false },
        groupPolicy: "allowlist",
        channels: { [TWIN_CHANNEL_ID]: { enabled: true, requireMention: true } },
        presenceEvents: { mode: "off" },
        reactionNotifications: "off",
      },
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const gatewayEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    TMPDIR: tmpDir,
    CI: "1",
    NODE_ENV: "production",
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_LOG_LEVEL: "debug",
    SLACK_API_URL: `${mockBaseUrl}/api/`,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };

  const launchGateway = async (run) => {
    const child = spawn(
      process.execPath,
      [
        path.join(sourceRoot, "openclaw.mjs"),
        "gateway",
        "run",
        "--port",
        String(gatewayPort),
        "--bind",
        "loopback",
        "--allow-unconfigured",
        "--verbose",
      ],
      {
        cwd: sourceRoot,
        env: gatewayEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    attachLogStream(child.stdout, run, "stdout", gatewayLogs);
    attachLogStream(child.stderr, run, "stderr", gatewayLogs);
    await waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`gateway run ${run} exited before Slack HTTP readiness`);
        }
        return gatewayLogs.some(
          (record) =>
            record.run === run &&
            record.line.includes(`slack http mode listening at ${WEBHOOK_PATH}`),
        );
      },
      `Gateway run ${run} Slack HTTP readiness`,
      STARTUP_TIMEOUT_MS,
    );
    return child;
  };

  const dropEvent = (type, eventId) => ({
    type,
    channel: DROP_CHANNEL_ID,
    channel_type: "im",
    user: "UDROP12345",
    text: DROP_BODY_MARKER,
    ts: DROP_TS,
    event_ts: DROP_TS,
    client_msg_id: eventId,
  });
  const visibleEvent = (eventId) => ({
    type: "app_mention",
    channel: VISIBLE_CHANNEL_ID,
    channel_type: "channel",
    user: "UVISIBLE12",
    text: `<@${BOT_USER_ID}> ${VISIBLE_BODY_MARKER}`,
    ts: VISIBLE_TS,
    event_ts: VISIBLE_TS,
    client_msg_id: eventId,
  });
  const sentinelEvent = (eventId) => ({
    type: "message",
    channel: SENTINEL_CHANNEL_ID,
    channel_type: "im",
    text: SENTINEL_BODY_MARKER,
    ts: SENTINEL_TS,
    event_ts: SENTINEL_TS,
    client_msg_id: eventId,
  });
  const twinEvent = (type, eventId) => ({
    type,
    channel: TWIN_CHANNEL_ID,
    channel_type: "channel",
    user: "UTWIN12345",
    text: type === "app_mention" ? `<@${BOT_USER_ID}> ${TWIN_BODY_MARKER}` : TWIN_BODY_MARKER,
    ts: TWIN_TS,
    event_ts: TWIN_TS,
    client_msg_id: eventId,
  });

  activeGateway = await launchGateway(1);
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvDropRunOne",
    event: dropEvent("message", "drop-run-one"),
  });
  await waitFor(
    async () => receiptCount(await readJsonLogRecords(gatewayLogPath), DROP_TS) === 1,
    "first drop receipt",
  );
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvVisibleRunOne",
    event: visibleEvent("visible-run-one"),
  });
  await waitFor(
    () => slackRequests.filter((request) => request.method === "chat.postEphemeral").length === 1,
    "sender-visible denial",
  );
  await waitFor(
    async () => receiptCount(await readJsonLogRecords(gatewayLogPath), VISIBLE_TS) === 1,
    "visible-drop receipt",
  );
  await stopGateway(activeGateway);
  activeGateway = null;

  activeGateway = await launchGateway(2);
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvDropRunTwo",
    event: dropEvent("message", "drop-run-two"),
  });
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvVisibleRunTwo",
    event: visibleEvent("visible-run-two"),
  });
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvSentinelRunTwo",
    event: sentinelEvent("sentinel-run-two"),
  });
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvTwinMessageRunTwo",
    event: twinEvent("message", "twin-message-run-two"),
  });
  await waitFor(
    async () => receiptCount(await readJsonLogRecords(gatewayLogPath), TWIN_TS) === 1,
    "ordinary-message twin rejection receipt",
  );
  await sendSlackEvent({
    gatewayPort,
    signingSecret,
    eventId: "EvTwinMentionRunTwo",
    event: twinEvent("app_mention", "twin-mention-run-two"),
  });
  await waitFor(() => modelRequests.length === 1, "app_mention twin model dispatch");
  await waitFor(
    async () => receiptCount(await readJsonLogRecords(gatewayLogPath), SENTINEL_TS) === 1,
    "post-replay sentinel receipt",
  );
  await sleep(500);
  await stopGateway(activeGateway);
  activeGateway = null;

  const persistedGatewayLogs = await readJsonLogRecords(gatewayLogPath);
  const receipts = receiptRecords(persistedGatewayLogs);
  const dropReceipts = receiptCount(persistedGatewayLogs, DROP_TS);
  const visibleReceipts = receiptCount(persistedGatewayLogs, VISIBLE_TS);
  const sentinelReceipts = receiptCount(persistedGatewayLogs, SENTINEL_TS);
  const twinReceiptRecords = receipts.filter((receipt) => receipt.messageTs === TWIN_TS);
  const twinReceipts = twinReceiptRecords.length;
  const channelPolicyGateExecutions = logCount(
    gatewayLogs,
    "slack: drop message (channel not allowed)",
  );
  const ephemeralCalls = slackRequests.filter(
    (request) => request.method === "chat.postEphemeral",
  ).length;
  const repeatedNonVisibleGateExecutions = channelPolicyGateExecutions - ephemeralCalls;
  const authTestCalls = slackRequests.filter((request) => request.method === "auth.test").length;
  const receiptText = JSON.stringify(receipts);
  const sqliteFiles = await findSqliteFiles(stateDir);

  assert(dropReceipts === 2, `expected two event-attempt receipts, observed ${dropReceipts}`);
  assert(visibleReceipts === 1, `expected one visible-drop receipt, observed ${visibleReceipts}`);
  assert(sentinelReceipts === 1, `expected one sentinel receipt, observed ${sentinelReceipts}`);
  assert(
    twinReceipts === 1,
    `expected one rejected twin-attempt receipt, observed ${twinReceipts}`,
  );
  assert(
    twinReceiptRecords[0]?.source === "message" &&
      twinReceiptRecords[0]?.reason === "missing-mention",
    "expected only the ordinary message twin to record a missing-mention rejection",
  );
  assert(
    channelPolicyGateExecutions === 3,
    `expected three controlled channel-policy gate executions, observed ${channelPolicyGateExecutions}`,
  );
  assert(
    repeatedNonVisibleGateExecutions === 2,
    `expected the released non-visible gate to execute twice, observed ${repeatedNonVisibleGateExecutions}`,
  );
  assert(ephemeralCalls === 1, `expected one sender-visible denial, observed ${ephemeralCalls}`);
  assert(
    authTestCalls === 9,
    `expected auth.test for two starts and seven authorized events, observed ${authTestCalls}`,
  );
  assert(
    modelRequests.length === 1,
    `expected one model request from the successful app_mention twin, observed ${modelRequests.length}`,
  );
  assert(sqliteFiles.length > 0, "Gateway proof did not create durable SQLite state");
  for (const forbidden of [
    DROP_BODY_MARKER,
    VISIBLE_BODY_MARKER,
    SENTINEL_BODY_MARKER,
    TWIN_BODY_MARKER,
    botToken,
    signingSecret,
    gatewayToken,
    providerApiKey,
  ]) {
    assert(!receiptText.includes(forbidden), "receipt evidence contained forbidden payload data");
  }

  verdict = {
    ...verdict,
    status: "pass",
    gateway: {
      runtime: "built dist-backed openclaw.mjs",
      starts: 2,
      sameStateDirectory: true,
      transport: "Slack HTTP event route",
      durableSqliteObserved: true,
    },
    repeatedNonVisibleAttempts: {
      logicalKeyDigest: sha256(JSON.stringify(["default", TEAM_ID, DROP_CHANNEL_ID, DROP_TS])),
      gatewayDeliveries: 2,
      preparationGateExecutions: repeatedNonVisibleGateExecutions,
      operatorReceipts: dropReceipts,
      semantics: "at-least-once event-attempt facts",
    },
    senderVisibleSibling: {
      logicalKeyDigest: sha256(
        JSON.stringify(["default", TEAM_ID, VISIBLE_CHANNEL_ID, VISIBLE_TS]),
      ),
      gatewayDeliveries: 2,
      senderVisibleDenials: ephemeralCalls,
      operatorReceipts: visibleReceipts,
    },
    orderingSentinel: {
      operatorReceipts: sentinelReceipts,
      confirmsReplayQueueDrainedBeforeVerdict: true,
    },
    rejectedThenDispatchedTwin: {
      logicalKeyDigest: sha256(JSON.stringify(["default", TEAM_ID, TWIN_CHANNEL_ID, TWIN_TS])),
      gatewayDeliveries: 2,
      rejectedAttemptReceipts: twinReceipts,
      rejectedAttemptSource: twinReceiptRecords[0]?.source,
      rejectedAttemptReason: twinReceiptRecords[0]?.reason,
      successfulTwinSource: "app_mention",
      agentModelRequests: modelRequests.length,
    },
    mockSlackApi: {
      authTestCalls,
      chatPostEphemeralCalls: ephemeralCalls,
      totalCalls: slackRequests.length,
    },
    privacy: {
      receiptContainsMessageBody: false,
      receiptContainsCredential: false,
      uploadedRawGatewayLogs: false,
    },
    boundary: {
      authenticatedSlack: false,
      description:
        "secretless mock Slack API + real built ephemeral Gateway; not authenticated live Slack",
    },
    gatewayLogSha256: sha256(gatewayLogs.map((record) => record.line).join("\n")),
  };
} catch (error) {
  verdict = {
    ...verdict,
    failure: error instanceof Error ? error.message : "unknown proof failure",
    sanitizedGatewayLogTail: gatewayLogs
      .slice(-60)
      .map((record) => record.line)
      .join("\n")
      .replaceAll(botToken, "[redacted-bot-token]")
      .replaceAll(signingSecret, "[redacted-signing-secret]")
      .replaceAll(gatewayToken, "[redacted-gateway-token]")
      .replaceAll(providerApiKey, "[redacted-provider-key]")
      .replaceAll(DROP_BODY_MARKER, "[redacted-message-body]")
      .replaceAll(VISIBLE_BODY_MARKER, "[redacted-message-body]")
      .replaceAll(SENTINEL_BODY_MARKER, "[redacted-message-body]")
      .replaceAll(TWIN_BODY_MARKER, "[redacted-message-body]"),
  };
  throw error;
} finally {
  await stopGateway(activeGateway);
  await closeServer(mockServer);
  await fs.writeFile(
    path.join(evidenceDir, "gateway-verdict.json"),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
}

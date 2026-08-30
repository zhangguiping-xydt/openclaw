import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const CHILD_PROVIDER_ID = "mock-openai-child";
const CHILD_MODEL_REF = `${CHILD_PROVIDER_ID}/gpt-5.6-luna`;
const CHILD_MODEL_ID = "gpt-5.6-luna";
const PARENT_PROVIDER_TIMEOUT_SECONDS = 5;
const CHILD_PROVIDER_TIMEOUT_SECONDS = 60;
const PARENT_CONTEXT_TOKENS = 100_000;
const HIGH_PROMPT_TOKENS = 96_000;
const SPAWN_PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
const RECOVERY_PROMPT =
  "Subagent terminal reply QA recovery check: answer briefly without calling tools.";
const CHILD_MARKER = "QA-SUBAGENT-TERMINAL-VISIBLE-OK";
const CHILD_TASK_TITLE = "qa-terminal-visible";
const TEST_TIMEOUT_MS = 300_000;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type TaskSummary = {
  taskId?: unknown;
  title?: unknown;
  status?: unknown;
  deliveryStatus?: unknown;
  runId?: unknown;
};

type TaskDeliveryLedger = {
  status?: unknown;
  disposition?: unknown;
  lastError?: unknown;
};

type SubagentLedger = {
  runId?: unknown;
  execution?: {
    status?: unknown;
  };
  completion?: unknown;
  delivery?: TaskDeliveryLedger;
};

type GatewayRun = {
  runId?: unknown;
  status?: unknown;
};

type ProviderEvent = {
  phase: string;
  at: string;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function collectText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(collectText).join("\n");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return Object.values(value).map(collectText).join("\n");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitForProviderPhase(
  phase: string,
  promise: Promise<void>,
  events: ProviderEvent[],
  timeoutMs = 60_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${phase}; events=${JSON.stringify(events)}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function rewriteParentSpawnResponse(body: Buffer): Buffer {
  const spawnArguments = JSON.stringify({
    task: "Subagent terminal reply QA worker: visible.",
    label: CHILD_TASK_TITLE,
    thread: false,
    mode: "run",
    model: CHILD_MODEL_REF,
  });
  let argumentDeltaRewritten = false;
  let completedCallRewritten = false;
  const lines = body
    .toString("utf8")
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") {
        return line;
      }
      const event = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
      if (event.type === "response.function_call_arguments.delta") {
        event.delta = spawnArguments;
        argumentDeltaRewritten = true;
      }
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call" && item.name === "sessions_spawn") {
          item.arguments = spawnArguments;
          completedCallRewritten = true;
        }
      }
      if (event.type === "response.completed") {
        const completed = event.response as Record<string, unknown> | undefined;
        const output = Array.isArray(completed?.output) ? completed.output : [];
        for (const value of output) {
          const item = value as Record<string, unknown>;
          if (item.type === "function_call" && item.name === "sessions_spawn") {
            item.arguments = spawnArguments;
            completedCallRewritten = true;
          }
        }
      }
      return `data: ${JSON.stringify(event)}`;
    });
  if (!argumentDeltaRewritten || !completedCallRewritten) {
    throw new Error("mock provider did not return the expected sessions_spawn response");
  }
  return Buffer.from(lines.join("\n"));
}

function configureGatewayModels(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  const childModel = provider?.models.find((model) => model.id === CHILD_MODEL_ID);
  if (!provider || !childModel) {
    throw new Error("mock-openai model config is missing");
  }
  const modelPolicyAllow = config.agents?.defaults?.modelPolicy?.allow ?? [];
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        timeoutSeconds: 300,
        compaction: {
          ...config.agents?.defaults?.compaction,
          timeoutSeconds: 30,
        },
        models: {
          ...config.agents?.defaults?.models,
          [CHILD_MODEL_REF]: {},
        },
        modelPolicy: {
          ...config.agents?.defaults?.modelPolicy,
          allow: [...new Set([...modelPolicyAllow, CHILD_MODEL_REF])],
        },
      },
    },
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        "mock-openai": {
          ...provider,
          timeoutSeconds: PARENT_PROVIDER_TIMEOUT_SECONDS,
          models: provider.models.map((model) =>
            model.id === CHILD_MODEL_ID
              ? { ...model, contextTokens: PARENT_CONTEXT_TOKENS }
              : model,
          ),
        },
        [CHILD_PROVIDER_ID]: {
          ...provider,
          timeoutSeconds: CHILD_PROVIDER_TIMEOUT_SECONDS,
          models: [{ ...childModel }],
        },
      },
    },
  };
}

function copyResponse(response: Response, body: Buffer, target: ServerResponse): void {
  target.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  target.end(body);
}

function writeAssistantResponse(
  response: ServerResponse,
  text: string | undefined,
  inputTokens = 100,
): void {
  const content = text ? [{ type: "output_text", text, annotations: [] }] : [];
  const outputTokens = text ? 5 : 0;
  const message = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content,
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function startRecoveryProviderProxy(params: {
  upstreamBaseUrl: string;
  failRecovery: boolean;
}) {
  const childRelease = createDeferred();
  const childStarted = createDeferred();
  const compactionRelease = createDeferred();
  const compactionStarted = createDeferred();
  const compactionSettled = createDeferred();
  const successorStarted = createDeferred();
  const successorRelease = createDeferred();
  const events: ProviderEvent[] = [];
  let recoverySucceeded = false;
  let spawnRequestCount = 0;
  let recoveryRequestCount = 0;
  const record = (phase: string) => events.push({ phase, at: new Date().toISOString() });
  const server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequestBody(request);
      const body = requestBody.length
        ? (JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>)
        : {};
      const allText = collectText(body);
      const isModelRequest = request.method === "POST" && request.url === "/v1/responses";
      const isCompaction = /context summarization assistant/iu.test(allText);
      const isChild = /Your session:\s*agent:[^\s]+:subagent:/u.test(allText);
      // A later turn includes the earlier session transcript. Match the recovery turn
      // first so its replay-safe timeout never falls back into the spawn flow.
      const isRecoveryRequest =
        isModelRequest && !isChild && !isCompaction && allText.includes(RECOVERY_PROMPT);
      const isSpawnRequest =
        isModelRequest &&
        !isChild &&
        !isCompaction &&
        !isRecoveryRequest &&
        allText.includes(SPAWN_PROMPT);
      const spawnRequestIndex = isSpawnRequest ? spawnRequestCount++ : -1;
      const recoveryRequestIndex = isRecoveryRequest ? recoveryRequestCount++ : -1;
      const fetchUpstream = async () => {
        const upstream = await fetch(`${params.upstreamBaseUrl}${request.url ?? "/"}`, {
          method: request.method,
          headers: {
            "content-type": request.headers["content-type"] ?? "application/json",
          },
          ...(requestBody.length ? { body: requestBody } : {}),
        });
        return { upstream, body: Buffer.from(await upstream.arrayBuffer()) };
      };

      if (isChild) {
        const upstream = await fetchUpstream();
        record("child_response_held");
        childStarted.resolve();
        await childRelease.promise;
        record("child_response_released");
        copyResponse(upstream.upstream, upstream.body, response);
        return;
      }
      if (isCompaction) {
        record("timeout_compaction_request_started");
        compactionStarted.resolve();
        if (!params.failRecovery) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          response.write(": transport-keepalive\n\n");
          // The proof deliberately holds compaction open while the child completes.
          // Comments keep the HTTP body alive without creating model events.
          const transportKeepalive = setInterval(() => {
            if (!response.destroyed && !response.writableEnded) {
              response.write(": transport-keepalive\n\n");
            }
          }, 1_000);
          transportKeepalive.unref();
          try {
            await compactionRelease.promise;
          } finally {
            clearInterval(transportKeepalive);
          }
          if (response.destroyed) {
            record("timeout_compaction_discarded_after_close");
            return;
          }
          const upstream = await fetchUpstream();
          recoverySucceeded = true;
          record("timeout_compaction_released");
          response.end(upstream.body);
          compactionSettled.resolve();
          return;
        }
        await compactionRelease.promise;
        record("timeout_compaction_failed");
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { type: "server_error", message: "QA injected recovery failure" },
          }),
        );
        compactionSettled.resolve();
        return;
      }
      if (isModelRequest && recoverySucceeded) {
        record("successor_request_held");
        successorStarted.resolve();
        await successorRelease.promise;
        if (response.destroyed) {
          record("successor_request_discarded_after_close");
          return;
        }
        if (allText.includes(CHILD_TASK_TITLE) || allText.includes(CHILD_MARKER)) {
          const upstream = await fetchUpstream();
          record("successor_completion_response");
          copyResponse(upstream.upstream, upstream.body, response);
        } else {
          record("successor_pre_completion_settled_silently");
          writeAssistantResponse(response, "NO_REPLY");
        }
        return;
      }
      if (spawnRequestIndex === 0) {
        record("parent_spawn_response");
        const upstream = await fetchUpstream();
        const upstreamBody = rewriteParentSpawnResponse(upstream.body);
        copyResponse(upstream.upstream, upstreamBody, response);
        return;
      }
      if (spawnRequestIndex >= 1) {
        record("parent_spawn_tool_continuation");
        const upstream = await fetchUpstream();
        copyResponse(upstream.upstream, upstream.body, response);
        return;
      }
      if (recoveryRequestIndex === 0) {
        record("parent_high_usage_empty_response");
        writeAssistantResponse(response, undefined, HIGH_PROMPT_TOKENS);
        return;
      }
      if (recoveryRequestIndex >= 1) {
        // The recovery turn has no tool side effects and is safe to replay. Return only
        // stream activity, then let OpenClaw's idle watchdog own timeout classification.
        record("parent_recovery_request_held_for_timeout");
        const responseId = `resp_${randomUUID()}`;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.write(
          [
            { type: "response.created", response: { id: responseId, status: "in_progress" } },
            { type: "response.in_progress", response: { id: responseId, status: "in_progress" } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
        // Refresh only the guarded HTTP body's transport deadline. SSE comments are
        // ignored by the Responses event parser, so the model-event idle watchdog
        // remains silent and owns the timeout classification exercised by this PR.
        const transportKeepalive = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) {
            response.write(": transport-keepalive\n\n");
          }
        }, 1_000);
        transportKeepalive.unref();
        try {
          await new Promise<void>((resolve) => {
            request.once("aborted", resolve);
            response.once("close", resolve);
          });
        } finally {
          clearInterval(transportKeepalive);
        }
        record("parent_recovery_client_timed_out");
        return;
      }

      const upstream = await fetchUpstream();
      record("successor_or_auxiliary_response");
      copyResponse(upstream.upstream, upstream.body, response);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("recovery provider proxy did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    events,
    waitForCompaction: () =>
      waitForProviderPhase("timeout compaction request", compactionStarted.promise, events, 20_000),
    waitForChild: () => waitForProviderPhase("child request", childStarted.promise, events),
    waitForCompactionSettled: () =>
      waitForProviderPhase("timeout compaction settlement", compactionSettled.promise, events),
    waitForSuccessor: () =>
      waitForProviderPhase("recovered successor request", successorStarted.promise, events),
    releaseChild: () => childRelease.resolve(),
    releaseCompaction: () => compactionRelease.resolve(),
    releaseSuccessor: () => successorRelease.resolve(),
    stop: async () => {
      childRelease.resolve();
      compactionRelease.resolve();
      successorRelease.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function readSubagentLedger(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  runId: string,
): SubagentLedger | undefined {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(runId) as { payload_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`subagent ledger ${runId} did not contain an object payload`);
    }
    return parsed as SubagentLedger;
  } finally {
    database.close();
  }
}

async function waitForSubagentLedger(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  runId: string,
  predicate: (ledger: SubagentLedger) => boolean,
  timeoutMs: number,
): Promise<SubagentLedger> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ledger = readSubagentLedger(gateway, runId);
    if (ledger && predicate(ledger)) {
      return ledger;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`timed out waiting for subagent ledger ${runId}`);
}

function requireTaskRunId(task: TaskSummary): string {
  if (typeof task.runId !== "string" || !task.runId.trim()) {
    throw new Error(`${CHILD_TASK_TITLE} task did not expose its run id`);
  }
  return task.runId;
}

function requireGatewayRunId(run: GatewayRun): string {
  if (typeof run.runId !== "string" || !run.runId.trim()) {
    throw new Error("Gateway run did not expose its run id");
  }
  return run.runId;
}

async function startRequesterTurn(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  params: { sessionKey: string; conversationId: string; message: string },
): Promise<GatewayRun> {
  const run = (await gateway.call(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: true,
      originatingChannel: "qa-channel",
      originatingTo: `dm:${params.conversationId}`,
      originatingAccountId: "default",
      idempotencyKey: randomUUID(),
    },
    { timeoutMs: 30_000 },
  )) as GatewayRun;
  expect(run.status).toBe("started");
  requireGatewayRunId(run);
  return run;
}

async function waitForRunTerminal(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  run: GatewayRun,
): Promise<GatewayRun> {
  const terminal = (await gateway.call(
    "agent.wait",
    { runId: requireGatewayRunId(run), timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  )) as GatewayRun;
  expect(["ok", "error"]).toContain(terminal.status);
  return terminal;
}

async function writeVerdict(name: string, verdict: unknown): Promise<void> {
  const evidenceDir = process.env.EVIDENCE_DIR;
  if (!evidenceDir) {
    return;
  }
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, `ephemeral-gateway-${name}-verdict.json`),
    `${JSON.stringify(verdict, null, 2)}\n`,
    "utf8",
  );
}

async function waitForCompactionWithDiagnostics(
  name: string,
  proxy: Awaited<ReturnType<typeof startRecoveryProviderProxy>>,
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
): Promise<void> {
  try {
    await proxy.waitForCompaction();
  } catch (error) {
    const diagnostic = {
      schema: "openclaw.pr132704.ephemeral-gateway-diagnostic.v1",
      exactHead: process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "local",
      parentContextTokens: PARENT_CONTEXT_TOKENS,
      highPromptTokens: HIGH_PROMPT_TOKENS,
      providerEvents: proxy.events,
      gatewayLogs: gateway.logs().split("\n").slice(-400),
    };
    await writeVerdict(`${name}-diagnostic`, diagnostic);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; gatewayLogs=${JSON.stringify(diagnostic.gatewayLogs)}`,
      { cause: error },
    );
  }
}

async function waitForTask(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  predicate: (task: TaskSummary) => boolean,
  timeoutMs: number,
): Promise<TaskSummary> {
  const deadline = Date.now() + timeoutMs;
  let tasks: TaskSummary[] = [];
  while (Date.now() < deadline) {
    const result = (await gateway.call(
      "tasks.list",
      { agentId: "qa", limit: 100 },
      { timeoutMs: 10_000 },
    )) as { tasks?: TaskSummary[] };
    tasks = result.tasks ?? [];
    const task = tasks.find(
      (candidate) => candidate.title === CHILD_TASK_TITLE && predicate(candidate),
    );
    if (task) {
      return task;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(
    `timed out waiting for ${CHILD_TASK_TITLE} task state; tasks=${JSON.stringify(tasks)}`,
  );
}

describe.runIf(process.env.OPENCLAW_PR132704_GATEWAY_PROOF === "1")(
  "PR 132704 timeout recovery Gateway proof",
  () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Gateway proof cleanup failed");
      }
    });

    it(
      "defers a real channel completion until the recovered successor is active",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const state = createQaBusState();
        const transport = createQaChannelTransport(state);
        const bus = await startQaBusServer({ state });
        cleanups.push(() => bus.stop());
        const upstream = await startQaMockOpenAiServer();
        cleanups.push(() => upstream.stop());
        const proxy = await startRecoveryProviderProxy({
          upstreamBaseUrl: upstream.baseUrl,
          failRecovery: false,
        });
        cleanups.push(() => proxy.stop());
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(async () => {
          const stopped = await gatewayOwner.stop();
          expect(stopped.errors).toEqual([]);
        });
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          useRepoCli: true,
          providerBaseUrl: `${proxy.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transport,
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: false,
          mutateConfig: configureGatewayModels,
        });
        await transport.waitReady({ gateway });

        const conversationId = `pr132704-success-${randomUUID().slice(0, 8)}`;
        const sessionKey = `agent:qa:${conversationId}`;
        const outboundStart = state.getSnapshot().messages.length;
        const spawnRun = await startRequesterTurn(gateway, {
          sessionKey,
          conversationId,
          message: SPAWN_PROMPT,
        });
        await proxy.waitForChild();
        const runningTask = await waitForTask(gateway, (task) => task.status === "running", 30_000);
        const childRunId = requireTaskRunId(runningTask);
        const spawnTerminal = await waitForRunTerminal(gateway, spawnRun);

        const recoveryRun = await startRequesterTurn(gateway, {
          sessionKey,
          conversationId,
          message: RECOVERY_PROMPT,
        });

        await waitForCompactionWithDiagnostics("recovery-success", proxy, gateway);
        expect(proxy.events.map((event) => event.phase)).toContain(
          "parent_high_usage_empty_response",
        );
        proxy.releaseChild();
        let pendingTask: TaskSummary;
        let pendingLedger: SubagentLedger;
        try {
          pendingLedger = await waitForSubagentLedger(
            gateway,
            childRunId,
            (ledger) =>
              ledger.execution?.status === "terminal" &&
              collectText(ledger.completion).includes(CHILD_MARKER) &&
              ledger.delivery?.status === "pending" &&
              ledger.delivery.disposition === "retryable" &&
              typeof ledger.delivery.lastError === "string" &&
              ledger.delivery.lastError.includes("completion_handoff_pending"),
            30_000,
          );
          pendingTask = await waitForTask(
            gateway,
            (task) =>
              task.runId === childRunId &&
              (task.status === "running" || task.status === "completed") &&
              task.deliveryStatus !== "delivered",
            30_000,
          );
        } catch (error) {
          const diagnostic = {
            schema: "openclaw.pr132704.ephemeral-gateway-diagnostic.v1",
            exactHead: process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "local",
            childRunId,
            ledger: readSubagentLedger(gateway, childRunId),
            providerEvents: proxy.events,
            gatewayLogs: gateway.logs().split("\n").slice(-400),
          };
          await writeVerdict("recovery-success-pending-diagnostic", diagnostic);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostic)}`,
            { cause: error },
          );
        }
        expect(requireTaskRunId(pendingTask)).toBe(childRunId);
        expect(["running", "completed"]).toContain(pendingTask.status);
        expect(pendingTask.deliveryStatus).not.toBe("delivered");
        const beforeSuccessor = state
          .getSnapshot()
          .messages.slice(outboundStart)
          .filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === conversationId &&
              String(message.text ?? "").includes(CHILD_MARKER),
          );
        expect(beforeSuccessor).toHaveLength(0);

        proxy.releaseCompaction();
        await proxy.waitForCompactionSettled();
        await proxy.waitForSuccessor();
        const beforeSuccessorReply = state
          .getSnapshot()
          .messages.slice(outboundStart)
          .filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === conversationId &&
              String(message.text ?? "").includes(CHILD_MARKER),
          );
        expect(beforeSuccessorReply).toHaveLength(0);
        proxy.releaseSuccessor();
        const completion = await transport.waitForOutbound({
          conversation: { id: conversationId, kind: "direct" },
          sinceIndex: outboundStart,
          textIncludes: CHILD_MARKER,
          timeoutMs: 90_000,
        });
        const deliveredTask = await waitForTask(
          gateway,
          (task) => task.status === "completed" && task.deliveryStatus === "delivered",
          30_000,
        );
        const deliveredLedger = await waitForSubagentLedger(
          gateway,
          childRunId,
          (ledger) =>
            ledger.delivery?.status === "delivered" &&
            ledger.delivery.disposition === "delivered" &&
            (ledger.delivery.lastError === null || ledger.delivery.lastError === undefined),
          30_000,
        );
        const matchingOutbound = state
          .getSnapshot()
          .messages.slice(outboundStart)
          .filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === conversationId &&
              String(message.text ?? "").includes(CHILD_MARKER),
          );
        expect(matchingOutbound).toHaveLength(1);
        expect(completion.text).toContain(CHILD_MARKER);

        const verdict = {
          schema: "openclaw.pr132704.ephemeral-gateway-proof.v1",
          exactHead: process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "local",
          proofKind: "secretless mock-provider, ephemeral Gateway, and QA channel transport",
          assertions: {
            realGateway: true,
            realQaChannelIngressAndEgress: true,
            highUsageRetrySeedObserved: true,
            timeoutCompactionObserved: true,
            completionPendingDuringRecovery: true,
            noDispatchBeforeSuccessor: true,
            successorRegistrationObserved: true,
            successorDeliveredExactlyOnce: true,
          },
          pendingTask,
          pendingLedger,
          deliveredTask,
          deliveredLedger,
          spawnTerminal,
          recoveryRunId: requireGatewayRunId(recoveryRun),
          matchingOutboundCount: matchingOutbound.length,
          providerEvents: proxy.events,
          gatewayLogEvidence: gateway
            .logs()
            .split("\n")
            .filter((line) => /timeout-compaction|subagent|completion|requester/i.test(line))
            .slice(-120),
        };
        await writeVerdict("recovery-success", verdict);
        console.log(JSON.stringify(verdict));
      },
    );

    it(
      "restores terminal suppression before a completion released after failed recovery",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const state = createQaBusState();
        const transport = createQaChannelTransport(state);
        const bus = await startQaBusServer({ state });
        cleanups.push(() => bus.stop());
        const upstream = await startQaMockOpenAiServer();
        cleanups.push(() => upstream.stop());
        const proxy = await startRecoveryProviderProxy({
          upstreamBaseUrl: upstream.baseUrl,
          failRecovery: true,
        });
        cleanups.push(() => proxy.stop());
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(async () => {
          const stopped = await gatewayOwner.stop();
          expect(stopped.errors).toEqual([]);
        });
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          useRepoCli: true,
          providerBaseUrl: `${proxy.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transport,
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: false,
          mutateConfig: configureGatewayModels,
        });
        await transport.waitReady({ gateway });

        const conversationId = `pr132704-failure-${randomUUID().slice(0, 8)}`;
        const sessionKey = `agent:qa:${conversationId}`;
        const outboundStart = state.getSnapshot().messages.length;
        const spawnRun = await startRequesterTurn(gateway, {
          sessionKey,
          conversationId,
          message: SPAWN_PROMPT,
        });
        await proxy.waitForChild();
        const runningTask = await waitForTask(gateway, (task) => task.status === "running", 30_000);
        const childRunId = requireTaskRunId(runningTask);
        const spawnTerminal = await waitForRunTerminal(gateway, spawnRun);

        const recoveryRun = await startRequesterTurn(gateway, {
          sessionKey,
          conversationId,
          message: RECOVERY_PROMPT,
        });

        await waitForCompactionWithDiagnostics("recovery-failure", proxy, gateway);
        expect(proxy.events.map((event) => event.phase)).toContain(
          "parent_high_usage_empty_response",
        );
        proxy.releaseCompaction();
        await proxy.waitForCompactionSettled();
        const parentTerminal = await waitForRunTerminal(gateway, recoveryRun);
        proxy.releaseChild();
        const terminalTask = await waitForTask(
          gateway,
          (task) => task.status === "completed" && task.deliveryStatus !== "delivered",
          30_000,
        );
        const terminalChildRunId = requireTaskRunId(terminalTask);
        expect(terminalChildRunId).toBe(childRunId);
        const terminalLedger = await waitForSubagentLedger(
          gateway,
          terminalChildRunId,
          (ledger) =>
            ledger.delivery?.status === "pending" &&
            ledger.delivery.disposition === "retryable" &&
            typeof ledger.delivery.lastError === "string" &&
            ledger.delivery.lastError.includes("requester_abandoned"),
          30_000,
        );

        const matchingOutbound = state
          .getSnapshot()
          .messages.slice(outboundStart)
          .filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === conversationId &&
              String(message.text ?? "").includes(CHILD_MARKER),
          );
        expect(matchingOutbound).toHaveLength(0);
        expect(terminalTask.deliveryStatus).not.toBe("delivered");

        const verdict = {
          schema: "openclaw.pr132704.ephemeral-gateway-proof.v1",
          exactHead: process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "local",
          proofKind: "secretless mock-provider, ephemeral Gateway, and QA channel transport",
          assertions: {
            realGateway: true,
            qaChannelDeliveryRouteConfigured: true,
            highUsageRetrySeedObserved: true,
            timeoutCompactionObserved: true,
            recoveryFailureObservedBeforeChildRelease: true,
            parentTerminalObservedBeforeChildRelease: true,
            terminalCompletionSuppressed: true,
            terminalDispatchCount: matchingOutbound.length,
          },
          parentTerminal,
          spawnTerminal,
          terminalTask,
          terminalLedger,
          matchingOutboundCount: matchingOutbound.length,
          providerEvents: proxy.events,
          gatewayLogEvidence: gateway
            .logs()
            .split("\n")
            .filter((line) => /timeout-compaction|subagent|completion|requester/i.test(line))
            .slice(-120),
        };
        await writeVerdict("recovery-failure", verdict);
        console.log(JSON.stringify(verdict));
      },
    );
  },
);

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
const REQUESTER_PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
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
        if (completed) {
          completed.usage = { input_tokens: 84_000, output_tokens: 16, total_tokens: 84_016 };
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

function writeAssistantResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
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
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
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
  const compactionRelease = createDeferred();
  const compactionStarted = createDeferred();
  const compactionSettled = createDeferred();
  const successorStarted = createDeferred();
  const successorRelease = createDeferred();
  const events: ProviderEvent[] = [];
  let recoverySucceeded = false;
  let requesterRequestCount = 0;
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
      const isRequesterRequest =
        isModelRequest && !isChild && !isCompaction && allText.includes(REQUESTER_PROMPT);
      const requesterRequestIndex = isRequesterRequest ? requesterRequestCount++ : -1;
      const isParentInitial = requesterRequestIndex === 0;
      // One quiet provider request is retried before timeout recovery begins.
      // Hold every pre-recovery continuation so the retry cannot settle the parent.
      const isParentToolContinuation = requesterRequestIndex >= 1 && !recoverySucceeded;
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

      if (isParentInitial) {
        record("parent_initial_spawn_response");
        const upstream = await fetchUpstream();
        const upstreamBody = rewriteParentSpawnResponse(upstream.body);
        copyResponse(upstream.upstream, upstreamBody, response);
        return;
      }
      if (isParentToolContinuation) {
        // The upstream QA fixture records the parent as settled here, which releases
        // its worker gate. Keep that completed provider response away from the Gateway.
        await fetchUpstream();
        record("parent_tool_continuation_held_for_timeout");
        await new Promise<void>((resolve) => {
          request.once("aborted", resolve);
          response.once("close", resolve);
        });
        record("parent_tool_continuation_client_timed_out");
        return;
      }
      if (isChild) {
        const upstream = await fetchUpstream();
        record("child_response_held");
        await childRelease.promise;
        record("child_response_released");
        copyResponse(upstream.upstream, upstream.body, response);
        return;
      }
      if (isCompaction) {
        record("timeout_compaction_request_started");
        compactionStarted.resolve();
        await compactionRelease.promise;
        if (params.failRecovery) {
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
        const upstream = await fetchUpstream();
        recoverySucceeded = true;
        record("timeout_compaction_released");
        copyResponse(upstream.upstream, upstream.body, response);
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
      waitForProviderPhase("timeout compaction request", compactionStarted.promise, events),
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

async function waitForTask(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaGatewayChild>["start"]>>,
  predicate: (task: TaskSummary) => boolean,
  timeoutMs: number,
): Promise<TaskSummary> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await gateway.call(
      "tasks.list",
      { agentId: "qa", limit: 100 },
      { timeoutMs: 10_000 },
    )) as { tasks?: TaskSummary[] };
    const task = (result.tasks ?? []).find(
      (candidate) => candidate.title === CHILD_TASK_TITLE && predicate(candidate),
    );
    if (task) {
      return task;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`timed out waiting for ${CHILD_TASK_TITLE} task state`);
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
        const outboundStart = state.getSnapshot().messages.length;
        await transport.sendInbound({
          accountId: "default",
          conversation: { id: conversationId, kind: "direct" },
          senderId: conversationId,
          senderName: "PR 132704 proof",
          text: REQUESTER_PROMPT,
        });

        await proxy.waitForCompaction();
        proxy.releaseChild();
        const pendingTask = await waitForTask(
          gateway,
          (task) => task.status === "completed" && task.deliveryStatus === "pending",
          30_000,
        );
        const childRunId = requireTaskRunId(pendingTask);
        const pendingLedger = await waitForSubagentLedger(
          gateway,
          childRunId,
          (ledger) =>
            ledger.delivery?.status === "pending" &&
            ledger.delivery.disposition === "retryable" &&
            typeof ledger.delivery.lastError === "string" &&
            ledger.delivery.lastError.includes("completion_handoff_pending"),
          30_000,
        );
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
        const started = (await gateway.call(
          "chat.send",
          {
            sessionKey,
            message: REQUESTER_PROMPT,
            deliver: true,
            originatingChannel: "qa-channel",
            originatingTo: `dm:${conversationId}`,
            originatingAccountId: "default",
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        )) as GatewayRun;
        expect(started.status).toBe("started");
        expect(typeof started.runId).toBe("string");

        await proxy.waitForCompaction();
        proxy.releaseCompaction();
        await proxy.waitForCompactionSettled();
        const parentTerminal = (await gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        )) as GatewayRun;
        expect(["ok", "error"]).toContain(parentTerminal.status);
        proxy.releaseChild();
        const terminalTask = await waitForTask(
          gateway,
          (task) => task.status === "completed" && task.deliveryStatus !== "delivered",
          30_000,
        );
        const terminalChildRunId = requireTaskRunId(terminalTask);
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
            timeoutCompactionObserved: true,
            recoveryFailureObservedBeforeChildRelease: true,
            parentTerminalObservedBeforeChildRelease: true,
            terminalCompletionSuppressed: true,
            terminalDispatchCount: matchingOutbound.length,
          },
          parentTerminal,
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

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const REQUESTER_PROMPT =
  "Subagent terminal reply QA check: visible. Spawn one native worker, then finish the parent turn without waiting. Do not use ACP.";
const CHILD_MARKER = "QA-SUBAGENT-TERMINAL-VISIBLE-OK";
const CHILD_TASK_TITLE = "qa-terminal-visible";
const PROVIDER_TIMEOUT_SECONDS = 5;
const TEST_TIMEOUT_MS = 180_000;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type TaskSummary = {
  taskId?: unknown;
  title?: unknown;
  status?: unknown;
  deliveryStatus?: unknown;
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

function hasToolOutput(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? body.input : [];
  return input.some(
    (item) =>
      item &&
      typeof item === "object" &&
      ["function_call_output", "custom_tool_call_output"].includes(
        String((item as { type?: unknown }).type ?? ""),
      ),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function copyResponse(response: Response, body: Buffer, target: ServerResponse): void {
  target.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  target.end(body);
}

async function startRecoveryProviderProxy(params: {
  upstreamBaseUrl: string;
  failRecovery: boolean;
}) {
  const childRelease = createDeferred();
  const compactionRelease = createDeferred();
  const compactionStarted = createDeferred();
  const events: ProviderEvent[] = [];
  const record = (phase: string) => events.push({ phase, at: new Date().toISOString() });
  const server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequestBody(request);
      const body = requestBody.length
        ? (JSON.parse(requestBody.toString("utf8")) as Record<string, unknown>)
        : {};
      const allText = collectText(body);
      const isCompaction = allText.includes("You are a context summarization assistant");
      const isChild = /Your session:\s*agent:[^\s]+:subagent:/u.test(allText);
      const isParentInitial =
        !isChild && !isCompaction && allText.includes(REQUESTER_PROMPT) && !hasToolOutput(body);
      const isParentToolContinuation =
        !isChild && !isCompaction && allText.includes(REQUESTER_PROMPT) && hasToolOutput(body);
      const upstream = await fetch(`${params.upstreamBaseUrl}${request.url ?? "/"}`, {
        method: request.method,
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
        },
        ...(requestBody.length ? { body: requestBody } : {}),
      });
      let upstreamBody = Buffer.from(await upstream.arrayBuffer());

      if (isParentInitial) {
        record("parent_initial_spawn_response");
        upstreamBody = Buffer.from(
          upstreamBody
            .toString("utf8")
            .replace(/"input_tokens":\s*\d+/gu, '"input_tokens":100000')
            .replace(/"total_tokens":\s*\d+/gu, '"total_tokens":100016'),
        );
        copyResponse(upstream, upstreamBody, response);
        return;
      }
      if (isParentToolContinuation) {
        record("parent_tool_continuation_held_for_timeout");
        await new Promise<void>((resolve) => {
          request.once("aborted", resolve);
          response.once("close", resolve);
        });
        record("parent_tool_continuation_client_timed_out");
        return;
      }
      if (isChild) {
        record("child_response_held");
        await childRelease.promise;
        record("child_response_released_during_recovery");
        copyResponse(upstream, upstreamBody, response);
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
          return;
        }
        record("timeout_compaction_released");
        copyResponse(upstream, upstreamBody, response);
        return;
      }

      record("successor_or_auxiliary_response");
      copyResponse(upstream, upstreamBody, response);
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
    waitForCompaction: () => compactionStarted.promise,
    releaseChild: () => childRelease.resolve(),
    releaseCompaction: () => compactionRelease.resolve(),
    stop: async () => {
      childRelease.resolve();
      compactionRelease.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
          mutateConfig: (config) => {
            const provider = config.models?.providers?.["mock-openai"];
            if (!provider) {
              throw new Error("mock-openai provider config is missing");
            }
            return {
              ...config,
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  timeoutSeconds: 60,
                  compaction: {
                    ...config.agents?.defaults?.compaction,
                    timeoutSeconds: 30,
                  },
                },
              },
              models: {
                ...config.models,
                providers: {
                  ...config.models?.providers,
                  "mock-openai": {
                    ...provider,
                    timeoutSeconds: PROVIDER_TIMEOUT_SECONDS,
                  },
                },
              },
            };
          },
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
            successorDeliveredExactlyOnce: true,
          },
          pendingTask,
          deliveredTask,
          matchingOutboundCount: matchingOutbound.length,
          providerEvents: proxy.events,
          gatewayLogEvidence: gateway
            .logs()
            .split("\n")
            .filter((line) => /timeout-compaction|subagent|completion|requester/i.test(line))
            .slice(-120),
        };
        const evidenceDir = process.env.EVIDENCE_DIR;
        if (evidenceDir) {
          await fs.mkdir(evidenceDir, { recursive: true });
          await fs.writeFile(
            path.join(evidenceDir, "ephemeral-gateway-verdict.json"),
            `${JSON.stringify(verdict, null, 2)}\n`,
            "utf8",
          );
        }
        console.log(JSON.stringify(verdict));
      },
    );
  },
);

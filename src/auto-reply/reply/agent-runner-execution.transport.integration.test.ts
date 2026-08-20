import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installEmbeddedRunnerBaseE2eMocks } from "../../agents/test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";

const fixtureState = {
  markerPath: "",
  releasePath: "",
  responsesBaseUrl: "",
};

const cliFixtureScript = [
  'const fs = require("node:fs");',
  "fs.writeFileSync(process.argv[1], String(process.pid));",
  'process.stdin.on("data", () => {});',
  'process.stdin.on("end", () => {',
  "const wait = setInterval(() => {",
  "if (!fs.existsSync(process.argv[2])) return;",
  "clearInterval(wait);",
  'process.stdout.write("fallback recovered\\n");',
  "}, 5);",
  "});",
].join("");

let executeAgentTurn: typeof import("./agent-runner-execution.js").executeAgentTurn;
let isEmbeddedAgentRunHandleActive: typeof import("../../agents/embedded-agent.js").isEmbeddedAgentRunHandleActive;
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
let resetAgentEventsForTest: typeof import("../../infra/agent-events.js").resetAgentEventsForTest;
let clearRuntimeConfigSnapshot: typeof import("../../config/config.js").clearRuntimeConfigSnapshot;

beforeAll(async () => {
  vi.resetModules();
  installEmbeddedRunnerBaseE2eMocks();
  vi.doMock("../../plugins/cli-backends.runtime.js", () => ({
    resolveRuntimeCliBackends: () => [
      {
        id: "fixture-cli",
        pluginId: "transport-recovery-fixture",
        bundleMcp: false,
        nativeToolMode: "none",
        config: {
          command: process.execPath,
          args: ["-e", cliFixtureScript, fixtureState.markerPath, fixtureState.releasePath],
          output: "text",
          input: "stdin",
          sessionMode: "none",
        },
      },
    ],
  }));
  vi.doMock("../../agents/embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../agents/embedded-agent-runner/model.js")
    >("../../agents/embedded-agent-runner/model.js");
    const stores = actual.createEmptyAgentDiscoveryStores();
    return {
      ...actual,
      resolveModelAsync: async (provider: string, modelId: string) => {
        if (provider !== "openai" || modelId !== "transport-primary") {
          throw new Error(`unexpected embedded model resolution: ${provider}/${modelId}`);
        }
        const model = {
          id: modelId,
          name: "Transport primary",
          api: "openai-responses",
          provider,
          baseUrl: fixtureState.responsesBaseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 2_048,
        } satisfies Model;
        return { model, error: undefined, ...stores };
      },
    };
  });

  ({ executeAgentTurn } = await import("./agent-runner-execution.js"));
  ({ isEmbeddedAgentRunHandleActive } = await import("../../agents/embedded-agent.js"));
  ({ onAgentEvent, resetAgentEventsForTest } = await import("../../infra/agent-events.js"));
  ({ clearRuntimeConfigSnapshot } = await import("../../config/config.js"));
});

afterAll(() => {
  clearRuntimeConfigSnapshot();
  resetAgentEventsForTest();
});

async function createRetryableFailureResponsesServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<{ method: string; path: string }>;
}> {
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    request.resume();
    request.on("end", () => {
      response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "retry-after-ms": "1",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "server_error",
            message: "primary transport failed for fallback proof",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("missing Responses loopback server address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

function createTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: async () => {},
    signalMessageStart: async () => {},
    signalTextDelta: async () => {},
    signalReasoningDelta: async () => {},
    signalToolStart: async () => {},
    signalExecutionActivity: async () => {},
  };
}

function createTurnParams(params: {
  agentDir: string;
  config: OpenClawConfig;
  runId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
}) {
  const followupRun = {
    prompt: "recover this turn",
    summaryLine: "recover this turn",
    enqueuedAt: Date.now(),
    images: undefined,
    imageOrder: undefined,
    run: {
      agentId: "main",
      agentDir: params.agentDir,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: "whatsapp",
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.config,
      skillsSnapshot: { prompt: "", skills: [] },
      provider: "openai",
      model: "transport-primary",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 10_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
  return {
    commandBody: "recover this turn",
    followupRun,
    sessionCtx: {
      Provider: "whatsapp",
      MessageSid: "transport-recovery-proof",
    } as unknown as TemplateContext,
    opts: {
      runId: params.runId,
      disableTools: true,
    } satisfies GetReplyOptions,
    typingSignals: createTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: (payload: ReplyPayload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: params.sessionKey,
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
  };
}

describe("agent runner transport to CLI fallback recovery", () => {
  it("releases the failed embedded transport owner before a real CLI child recovers", async () => {
    clearRuntimeConfigSnapshot();
    resetAgentEventsForTest();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transport-cli-recovery-"));
    const agentDir = path.join(root, "agent");
    const workspaceDir = path.join(root, "workspace");
    const markerPath = path.join(root, "cli-child.pid");
    const releasePath = path.join(root, "release-cli-child");
    const sessionStore = path.join(root, "sessions.json");
    await Promise.all([
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(workspaceDir, { recursive: true }),
    ]);
    const transport = await createRetryableFailureResponsesServer();
    fixtureState.markerPath = markerPath;
    fixtureState.releasePath = releasePath;
    fixtureState.responsesBaseUrl = transport.baseUrl;
    const runId = "run-transport-cli-recovery";
    const sessionId = "session-transport-cli-recovery";
    const sessionKey = "agent:main:transport-cli-recovery";
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === runId) {
        events.push(event);
      }
    });
    let executionPromise: ReturnType<typeof executeAgentTurn> | undefined;

    try {
      const apiKeyField = ["api", "Key"].join("");
      const config = {
        session: { store: sessionStore },
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: {
              primary: "openai/transport-primary",
              fallbacks: ["fixture-cli/fallback"],
            },
          },
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              [apiKeyField]: "transport-fixture-key",
              baseUrl: transport.baseUrl,
              models: [
                {
                  id: "transport-primary",
                  name: "Transport primary",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 16_000,
                  maxTokens: 2_048,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      executionPromise = executeAgentTurn(
        createTurnParams({
          agentDir,
          config,
          runId,
          sessionFile: sessionKey,
          sessionId,
          sessionKey,
          workspaceDir,
        }),
      );

      await Promise.race([
        waitForFile(markerPath),
        executionPromise.then(() => {
          throw new Error("turn settled before the CLI child published its start marker");
        }),
      ]);
      const activeEmbeddedRunAtCliStart = isEmbeddedAgentRunHandleActive(sessionId);
      expect(activeEmbeddedRunAtCliStart).toBe(false);
      await fs.writeFile(releasePath, "release", "utf8");
      const result = await executionPromise;
      const primaryAttempt =
        result.outcome.kind === "settled" ? result.outcome.fallback.attempts[0] : undefined;

      expect(
        transport.requests,
        `primary fallback attempt: ${primaryAttempt?.error ?? result.outcome.kind}`,
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          method: "POST",
          path: expect.stringMatching(/^\/v1\/responses(?:\?|$)/),
        })),
      );
      const childPid = Number((await fs.readFile(markerPath, "utf8")).trim());
      expect(childPid).toBeGreaterThan(0);
      expect(result).toMatchObject({
        runId,
        outcome: {
          kind: "settled",
          status: "ok",
          resolved: { provider: "fixture-cli", model: "fallback" },
          fallback: {
            exhausted: false,
            attempts: [{ provider: "openai", model: "transport-primary" }],
          },
          result: { payloads: [{ text: "fallback recovered" }] },
        },
      });
      if (result.outcome.kind !== "settled") {
        throw new Error(`unexpected turn outcome: ${result.outcome.kind}`);
      }
      expect(result.outcome.result.meta.error).toBeUndefined();
      expect(JSON.stringify(result.outcome.result.payloads)).not.toContain(
        "primary transport failed for fallback proof",
      );
      const lifecyclePhases = events
        .filter((event) => event.stream === "lifecycle")
        .map((event) => event.data.phase);
      expect(lifecyclePhases.filter((phase) => phase === "start")).toHaveLength(2);
      expect(lifecyclePhases).toContain("finishing");
      expect(lifecyclePhases.filter((phase) => phase === "end")).toHaveLength(1);
      expect(lifecyclePhases.at(-1)).toBe("end");
      expect(lifecyclePhases).not.toContain("error");
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);

      console.info(
        `[transport-cli-fallback-proof] ${JSON.stringify({
          transport: {
            requests: transport.requests.length,
            path: transport.requests[0]?.path,
            terminal: "http_503",
          },
          fallback: {
            runtime: result.outcome.resolved.provider,
            model: result.outcome.resolved.model,
            childProcessStarted: childPid > 0,
            activeEmbeddedRunAtStart: activeEmbeddedRunAtCliStart,
          },
          lifecycle: { phases: lifecyclePhases },
          final: {
            kind: result.outcome.kind,
            status: result.outcome.status,
            text: result.outcome.result.payloads?.[0]?.text,
            staleEmbeddedError: result.outcome.result.meta.error !== undefined,
            activeEmbeddedRun: isEmbeddedAgentRunHandleActive(sessionId),
          },
        })}`,
      );
    } finally {
      await fs.writeFile(releasePath, "release", "utf8").catch(() => undefined);
      await executionPromise?.catch(() => undefined);
      unsubscribe();
      await closeServer(transport.server);
      await fs.rm(root, { recursive: true, force: true });
      fixtureState.markerPath = "";
      fixtureState.releasePath = "";
      fixtureState.responsesBaseUrl = "";
      resetAgentEventsForTest();
    }
  }, 30_000);
});

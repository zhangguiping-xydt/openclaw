import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.NODE_ENV = "test";

const sourceRoot = path.resolve(process.argv[2] ?? "source");
const evidenceDir = path.resolve(
  process.env.EVIDENCE_DIR ?? path.join(process.cwd(), "evidence"),
);
const exactHead = process.env.EXPECTED_SHA?.trim();
if (!/^[0-9a-f]{40}$/.test(exactHead ?? "")) {
  throw new Error("EXPECTED_SHA must be an exact 40-character commit SHA");
}

const importSource = async <T>(relativePath: string): Promise<T> =>
  (await import(pathToFileURL(path.join(sourceRoot, relativePath)).href)) as T;

const runs = await importSource<typeof import("../../src/agents/embedded-agent-runner/runs.js")>(
  "src/agents/embedded-agent-runner/runs.ts",
);
const runTestSupport = await importSource<
  typeof import("../../src/agents/embedded-agent-runner/runs.test-support.js")
>("src/agents/embedded-agent-runner/runs.test-support.ts");
const delivery = await importSource<
  typeof import("../../src/agents/subagents/announce/subagent-announce-direct-delivery.js")
>("src/agents/subagents/announce/subagent-announce-direct-delivery.ts");
const deliveryRuntime = await importSource<
  typeof import("../../src/agents/subagents/announce/subagent-announce-delivery.runtime.js")
>("src/agents/subagents/announce/subagent-announce-delivery.runtime.ts");

const sessionId = "proof-requester-session";
const sessionKey = "agent:main:proof-requester";
let dispatchCalls = 0;
let queueCalls = 0;

const summarizeDelivery = (result: Awaited<ReturnType<typeof delivery.sendSubagentAnnounceDirectly>>) => ({
  delivered: result.delivered,
  path: result.path,
  reason: result.reason ?? null,
  disposition: result.disposition ?? null,
});

const sendCompletion = () =>
  delivery.sendSubagentAnnounceDirectly({
    requesterSessionKey: sessionKey,
    targetRequesterSessionKey: sessionKey,
    triggerMessage: "redacted child completion",
    expectsCompletionMessage: true,
    requesterIsSubagent: true,
    directIdempotencyKey: "proof-timeout-recovery",
  });

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message);
  }
};

const events: Array<Record<string, unknown>> = [];
try {
  runTestSupport.testing.resetActiveEmbeddedRuns();
  deliveryRuntime.setSubagentAnnounceDeliveryDepsForTest({
    dispatchGatewayMethodInProcess: async () => {
      dispatchCalls += 1;
      return undefined;
    },
    getRuntimeConfig: () => ({}) as never,
    getRequesterSessionActivity: () => ({
      sessionId,
      isActive: runs.isEmbeddedAgentRunActive(sessionId),
    }),
    loadRequesterSessionEntry: (requestedKey) => ({
      cfg: {} as never,
      entry: undefined,
      canonicalKey: requestedKey,
      agentId: "main",
    }),
  });

  const timedOutHandle = runTestSupport.createEmbeddedRunHandle({ runId: "proof-run-timeout" });
  runs.setActiveEmbeddedRun(sessionId, timedOutHandle, sessionKey);
  assert(
    runs.markActiveEmbeddedRunAbandoned({
      sessionId,
      handle: timedOutHandle,
      sessionKey,
      reason: "timeout",
    }),
    "timeout marker was not recorded",
  );
  runs.clearActiveEmbeddedRun(sessionId, timedOutHandle, sessionKey);
  const terminalBefore = await sendCompletion();
  assert(terminalBefore.reason === "requester_abandoned", "terminal timeout admitted completion");
  events.push({
    stage: "terminal_timeout",
    abandonment: runs.resolveEmbeddedRunAbandonment({ sessionId, sessionKey }),
    delivery: summarizeDelivery(terminalBefore),
    dispatchCalls,
  });

  const recoveryMarker = runs.markEmbeddedRunRecoveringTimeout({
    sessionId,
    runId: "proof-run-timeout",
  });
  assert(recoveryMarker, "eligible timeout did not enter recovery");
  const duringRecovery = await sendCompletion();
  assert(
    duringRecovery.reason === "completion_handoff_pending" &&
      duringRecovery.disposition === "retryable",
    "recovery completion was not durably deferred",
  );
  assert(dispatchCalls === 0, "recovery completion dispatched before successor activation");
  events.push({
    stage: "recovering_timeout",
    abandonment: runs.resolveEmbeddedRunAbandonment({ sessionId, sessionKey }),
    delivery: summarizeDelivery(duringRecovery),
    dispatchCalls,
  });

  const successorHandle = runTestSupport.createEmbeddedRunHandle({
    runId: "proof-run-successor",
    supportsTranscriptCommitWait: true,
    queueMessage: async () => {
      queueCalls += 1;
    },
  });
  runs.setActiveEmbeddedRun(sessionId, successorHandle, sessionKey);
  const afterSuccessor = await sendCompletion();
  assert(
    afterSuccessor.delivered && afterSuccessor.path === "steered" && queueCalls === 1,
    "successor did not accept exactly one deferred completion",
  );
  assert(
    !runs.restoreEmbeddedRunTimeoutAbandonment(recoveryMarker),
    "stale success marker restored cleared abandonment",
  );
  events.push({
    stage: "successor_active",
    abandonment: runs.resolveEmbeddedRunAbandonment({ sessionId, sessionKey }) ?? null,
    delivery: summarizeDelivery(afterSuccessor),
    queueCalls,
    staleRestoreAccepted: false,
  });
  runs.clearActiveEmbeddedRun(sessionId, successorHandle, sessionKey);

  const failedHandle = runTestSupport.createEmbeddedRunHandle({ runId: "proof-run-failed" });
  runs.setActiveEmbeddedRun(sessionId, failedHandle, sessionKey);
  assert(
    runs.markActiveEmbeddedRunAbandoned({
      sessionId,
      handle: failedHandle,
      sessionKey,
      reason: "timeout",
    }),
    "failure timeout marker was not recorded",
  );
  runs.clearActiveEmbeddedRun(sessionId, failedHandle, sessionKey);
  const failedMarker = runs.markEmbeddedRunRecoveringTimeout({
    sessionId,
    runId: "proof-run-failed",
  });
  assert(failedMarker, "failure timeout did not enter recovery");
  assert(runs.restoreEmbeddedRunTimeoutAbandonment(failedMarker), "terminal restore failed");
  const afterFailure = await sendCompletion();
  assert(afterFailure.reason === "requester_abandoned", "failed recovery admitted completion");
  assert(dispatchCalls === 0, "failure path dispatched a completion turn");
  events.push({
    stage: "recovery_failed",
    abandonment: runs.resolveEmbeddedRunAbandonment({ sessionId, sessionKey }),
    delivery: summarizeDelivery(afterFailure),
    dispatchCalls,
  });

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "verdict.json"),
    `${JSON.stringify(
      {
        schema: "openclaw.pr132704.timeout-recovery-proof.v1",
        exactHead,
        proofKind: "deterministic in-process production registry and delivery boundary",
        liveProvider: false,
        liveChannel: false,
        assertions: {
          terminalTimeoutSuppresses: true,
          recoveryDefersWithoutDispatch: true,
          successorAcceptsExactlyOnce: true,
          failedRecoveryRestoresSuppression: true,
        },
        events,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  deliveryRuntime.setSubagentAnnounceDeliveryDepsForTest();
  runTestSupport.testing.resetActiveEmbeddedRuns();
}

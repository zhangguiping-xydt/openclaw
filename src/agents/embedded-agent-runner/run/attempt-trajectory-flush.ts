import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";

type EmbeddedAttemptTrajectoryRecorder = {
  describeFlushState: () => string | undefined;
  flush: () => Promise<void>;
};

/** Bounds trajectory persistence so a stuck diagnostic write cannot block run teardown. */
export async function flushEmbeddedAttemptTrajectoryRecorder(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: EmbeddedAttemptTrajectoryRecorder | null;
  log: {
    warn: (message: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "openclaw-trajectory-flush",
    log: params.log,
    env: params.env,
    timeoutMs: params.timeoutMs,
    getTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
    cleanup: async () => {
      await params.trajectoryRecorder?.flush();
    },
  });
}

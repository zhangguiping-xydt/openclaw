import { formatErrorMessage } from "../../../infra/errors.js";
import { log } from "../logger.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush.js";
import type { DeferredEmbeddedRunLifecycleOwner, RunEmbeddedAgentParams } from "./params.js";

type DeferredTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  describeFlushState: () => string | undefined;
};

export type EmbeddedAttemptDeferredLifecycleOwner = DeferredEmbeddedRunLifecycleOwner & {
  recordSessionEnd: (data: Record<string, unknown>) => void;
};

/** Retains one candidate's logical terminal resources beyond attempt-local cleanup. */
export function createEmbeddedAttemptDeferredLifecycleOwner(params: {
  runId: string;
  sessionId: string;
  trajectoryRecorder: DeferredTrajectoryRecorder | null;
  clearActiveRun: () => void;
}): EmbeddedAttemptDeferredLifecycleOwner {
  let state: "pending" | "completed" | "discarded" = "pending";
  let sessionEndData: Record<string, unknown> | undefined;

  const releaseActiveRun = () => {
    try {
      params.clearActiveRun();
    } catch (error) {
      log.error(
        `CRITICAL: deferred active run cleanup failed, possible resource leak: ` +
          `runId=${params.runId} ${formatErrorMessage(error)}`,
      );
    }
  };

  return {
    recordSessionEnd: (data) => {
      if (state === "pending") {
        sessionEndData = data;
      }
    },
    discard: () => {
      if (state !== "pending") {
        return;
      }
      state = "discarded";
      releaseActiveRun();
    },
    complete: async () => {
      if (state !== "pending") {
        return;
      }
      state = "completed";
      try {
        if (params.trajectoryRecorder && sessionEndData) {
          try {
            params.trajectoryRecorder.recordEvent("session.ended", sessionEndData);
          } catch (error) {
            log.warn(
              `deferred trajectory terminal record failed: runId=${params.runId} ` +
                `sessionId=${params.sessionId} error=${formatErrorMessage(error)}`,
            );
          }
          await flushEmbeddedAttemptTrajectoryRecorder({
            runId: params.runId,
            sessionId: params.sessionId,
            trajectoryRecorder: params.trajectoryRecorder,
            log,
          });
        }
      } finally {
        releaseActiveRun();
      }
    },
  };
}

export type DeferredEmbeddedRunLifecycleManager = {
  adopt: NonNullable<RunEmbeddedAgentParams["onDeferredLifecycleOwner"]>;
  complete: () => Promise<void>;
  discard: () => void;
};

/** Keeps exactly one candidate owner alive across fallback and whole-turn retries. */
export function createDeferredEmbeddedRunLifecycleManager(): DeferredEmbeddedRunLifecycleManager {
  let current: DeferredEmbeddedRunLifecycleOwner | undefined;
  return {
    adopt: (owner) => {
      if (owner === current) {
        return;
      }
      const previous = current;
      // The candidate registers its active handle before adoption. Publish the
      // replacement first so discarding the loser cannot make the logical run idle.
      current = owner;
      previous?.discard();
    },
    complete: async () => {
      const owner = current;
      current = undefined;
      await owner?.complete();
    },
    discard: () => {
      const owner = current;
      current = undefined;
      owner?.discard();
    },
  };
}

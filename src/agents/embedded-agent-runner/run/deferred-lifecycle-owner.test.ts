import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushTrajectory: vi.fn(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./attempt-trajectory-flush.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: mocks.flushTrajectory,
}));
vi.mock("../logger.js", () => ({
  log: { warn: mocks.warn, error: mocks.error },
}));

import {
  createDeferredEmbeddedRunLifecycleManager,
  createEmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";

function createOwner(name: string, order: string[]) {
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    flush: vi.fn(async () => undefined),
    describeFlushState: vi.fn(() => undefined),
  };
  const clearActiveRun = vi.fn(() => order.push(`clear-${name}`));
  const owner = createEmbeddedAttemptDeferredLifecycleOwner({
    runId: `run-${name}`,
    sessionId: "session-1",
    trajectoryRecorder,
    clearActiveRun,
  });
  return { clearActiveRun, owner, trajectoryRecorder };
}

describe("deferred embedded-run lifecycle ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("discards a replaced candidate only after the replacement is adopted", async () => {
    const order: string[] = [];
    const first = createOwner("first", order);
    const second = createOwner("second", order);
    const manager = createDeferredEmbeddedRunLifecycleManager();
    first.owner.recordSessionEnd({ status: "error" });
    second.owner.recordSessionEnd({ status: "success" });

    manager.adopt(first.owner);
    order.push("replacement-registered");
    manager.adopt(second.owner);

    expect(order).toEqual(["replacement-registered", "clear-first"]);
    expect(first.trajectoryRecorder.recordEvent).not.toHaveBeenCalled();

    await manager.complete();
    await manager.complete();

    expect(second.trajectoryRecorder.recordEvent).toHaveBeenCalledOnce();
    expect(second.trajectoryRecorder.recordEvent).toHaveBeenCalledWith("session.ended", {
      status: "success",
    });
    expect(mocks.flushTrajectory).toHaveBeenCalledOnce();
    expect(order).toEqual(["replacement-registered", "clear-first", "clear-second"]);
  });
});

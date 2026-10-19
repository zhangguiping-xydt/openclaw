import {
  NODE_WORKER_CHECKOUT_PREPARATION_PROTOCOL_FEATURE,
  NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  nodeWorkerPlanHash,
  validateNodeWorkerLaunchInput,
} from "../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerEnvironmentStopInput,
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "../worker/worker-connection-endpoint.js";
import type { NodeWorkerProcessesChanged } from "../worker/worker-process-observation.js";
import {
  buildWorkerProcessTurn,
  type WorkerProcessResult,
} from "../worker/worker-process-protocol.js";
import type { NodeWorkerCapacity } from "./node-worker-capacity.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import type { NodeWorkerTerminalOutcome } from "./node-worker-launch-observation.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
  NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerNativeInferenceSnapshot } from "./node-worker-native-inference.js";
import type { NodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import type { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export const NODE_WORKER_STOP_GRACE_MS = 1_000;
export const NODE_WORKER_FORCE_STOP_WAIT_MS = 4_000;

export type NodeWorkerStopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;

type NodeWorkerLaunchRecovery = (
  receipt: NodeWorkerLaunchReceipt,
  notifyCapacity?: boolean,
  state?: NodeWorkerStopState,
  awaitCleanup?: boolean,
) => Promise<NodeWorkerLaunchReceipt>;

export type NodeWorkerEnvironmentBinding = ReturnType<typeof nodeWorkerEnvironmentBinding>;

export type NodeWorkerPendingAdmission = {
  binding: NodeWorkerEnvironmentBinding;
  identity: NodeWorkerSupervisorIdentity;
  abort: AbortController;
  signal: AbortSignal;
  done: Promise<NodeWorkerLaunchReceipt>;
};

/** Only environment facts survive a turn; descriptors contain disposable admission authority. */
export function nodeWorkerEnvironmentBinding(input: NodeWorkerLaunchInput) {
  const { admission, assignment } = input.descriptor;
  return {
    gatewayNamespace: input.gatewayNamespace,
    environmentId: admission.environmentId,
    sessionId: admission.sessionId,
    ownerEpoch: admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    bundleHash: input.expectedBundleHash,
    agentId: assignment.agentId,
    workspaceDir: assignment.workspaceDir,
    containmentRoot: assignment.workerContainmentRoot,
    permissionMode: assignment.permissionMode,
    inference: assignment.inference,
  };
}

export function nodeWorkerEnvironmentKey(
  binding: Pick<NodeWorkerEnvironmentBinding, "gatewayNamespace" | "environmentId">,
): string {
  return JSON.stringify([binding.gatewayNamespace, binding.environmentId]);
}

export function nodeWorkerEnvironmentMatches(
  binding: NodeWorkerEnvironmentStopInput,
  expected: NodeWorkerEnvironmentStopInput,
): boolean {
  return (
    binding.gatewayNamespace === expected.gatewayNamespace &&
    binding.environmentId === expected.environmentId &&
    binding.sessionId === expected.sessionId &&
    binding.ownerEpoch === expected.ownerEpoch
  );
}

export type NodeWorkerCheckoutPreparation = {
  done: Promise<void>;
  dispatched: boolean;
  settle: () => void;
};

export function createNodeWorkerCheckoutPreparation(): NodeWorkerCheckoutPreparation {
  const { promise, resolve } = createDeferredCore();
  return { done: promise, dispatched: false, settle: resolve };
}

type NodeWorkerActiveTurn = {
  claim: NodeWorkerLaunchClaim;
  done: Promise<void>;
  settle: () => void;
  cancelled: boolean;
  settling?: Promise<void>;
  checkoutPreparation?: NodeWorkerCheckoutPreparation;
};

export function createNodeWorkerActiveTurn(
  claim: NodeWorkerLaunchClaim,
  checkoutPreparation?: NodeWorkerCheckoutPreparation,
): NodeWorkerActiveTurn {
  const { promise, resolve } = createDeferredCore();
  return {
    claim,
    done: promise,
    settle: resolve,
    cancelled: false,
    ...(checkoutPreparation ? { checkoutPreparation } : {}),
  };
}

type NodeWorkerActiveBase = {
  binding: NodeWorkerEnvironmentBinding;
  gatewayNamespace: string;
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity;
  container?: NodeWorkerContainerIdentity;
};

export type NodeWorkerRunningChild = NodeWorkerActiveBase & {
  state: "running";
  adapter: NodeWorkerChildAdapter;
  done: Promise<void>;
  journalReady: Promise<void>;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  turn?: NodeWorkerActiveTurn;
  retiring: boolean;
  idleRetention?: boolean;
  retention?:
    | { reason: "background"; turnId: string }
    | { reason: "idle"; turnId: string; since: number; timer: NodeJS.Timeout };
  stopState?: NodeWorkerStopState;
  containerCleanup?: Promise<void>;
  deferredOutcome?: NodeWorkerTerminalOutcome;
};

export function clearNodeWorkerRetention(active: NodeWorkerRunningChild): void {
  if (active.retention?.reason === "idle") {
    clearTimeout(active.retention.timer);
  }
  active.retention = undefined;
}

export type NodeWorkerObservedTerminal = NodeWorkerActiveBase & {
  state: "observed";
  outcome: NodeWorkerTerminalOutcome;
  turn?: NodeWorkerActiveTurn;
  cancelledTurn?: NodeWorkerLaunchClaim;
  reconciliation?: Promise<NodeWorkerLaunchReceipt>;
};

export function createNodeWorkerObservedTerminal(
  active: NodeWorkerRunningChild,
  outcome: NodeWorkerTerminalOutcome,
): NodeWorkerObservedTerminal {
  return {
    state: "observed",
    binding: active.binding,
    gatewayNamespace: active.gatewayNamespace,
    launchId: active.launchId,
    planHash: active.planHash,
    supervisor: active.supervisor,
    worker: active.worker,
    ...(active.container ? { container: active.container } : {}),
    outcome,
    ...(active.turn ? { turn: active.turn } : {}),
    ...(!active.stopState && active.turn?.cancelled ? { cancelledTurn: active.turn.claim } : {}),
  };
}

export type NodeWorkerActiveOwnership = NodeWorkerRunningChild | NodeWorkerObservedTerminal;

export type NodeWorkerSupervisorOptions = {
  bundleRoot?: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  capacityWaitMs?: number;
  onCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  onProcessesChanged?: (binding: NodeWorkerProcessesChanged) => void;
  workspace?: NodeWorkerWorkspaceRuntime;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
  /** Node-local canonical models captured before the runtime yields. */
  nativeInferenceSnapshot?: NodeWorkerNativeInferenceSnapshot;
};

/** Match both process bookkeeping and exact authoritative container identity. */
export function nodeWorkerReceiptMatchesOwner(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
  container?: NodeWorkerContainerIdentity,
): boolean {
  const sameProcess = (
    left: NodeWorkerProcessIdentity | null,
    right: NodeWorkerProcessIdentity | null,
  ) =>
    left?.pid === right?.pid &&
    left?.startTime === right?.startTime &&
    (left !== null) === (right !== null);
  return (
    sameProcess(receipt.supervisor, supervisor) &&
    sameProcess(receipt.worker, worker) &&
    receipt.container?.engine === container?.engine &&
    receipt.container?.containerId === container?.containerId &&
    receipt.container?.engineTarget === container?.engineTarget
  );
}

const checkoutLog = createSubsystemLogger("node-host/worker");

export type NodeWorkerChildLifecycleOptions = {
  onProcessesChanged?: NodeWorkerSupervisorOptions["onProcessesChanged"];
  bundleRoot: string;
  nativeInferenceSnapshot?: NodeWorkerNativeInferenceSnapshot;
  engineEnv: NodeJS.ProcessEnv;
  store: NodeWorkerLaunchStore;
  turns: NodeWorkerTurnStore;
  capacity: NodeWorkerCapacity;
  containerEngine?: NodeWorkerContainerEngine;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  containerImage?: string;
  starting: ReadonlyMap<string, Promise<NodeWorkerLaunchReceipt>>;
  initialize: () => Promise<void>;
  isClosed: () => boolean;
  cancelTurn: (
    expected: NodeWorkerSupervisorIdentity,
  ) => Promise<NodeWorkerLaunchReceipt | undefined>;
  recoverRunning: NodeWorkerLaunchRecovery;
};

/** Synchronous: the exact child owner still sends and accepts the acknowledgement. */
export function buildNodeWorkerCheckoutTurn(
  descriptor: WorkerLaunchDescriptor,
  idleRetention: boolean | undefined,
  checkoutMode?: "admitted" | "deferred",
  checkoutPreparation?: NodeWorkerCheckoutPreparation,
  canonicalWorkspace = false,
  processChanges = false,
) {
  if (
    checkoutMode &&
    !descriptor.admission.handshake.protocolFeatures.includes(
      NODE_WORKER_CHECKOUT_PREPARATION_PROTOCOL_FEATURE,
    )
  ) {
    throw new Error("worker bundle does not support owned checkout preparation");
  }
  if (checkoutPreparation) {
    checkoutPreparation.dispatched = true;
  }
  return buildWorkerProcessTurn(
    descriptor,
    idleRetention,
    canonicalWorkspace,
    processChanges,
    checkoutMode,
  );
}

export async function dispatchNodeWorkerWithCheckoutPreparation(
  workspace: NodeWorkerWorkspaceRuntime,
  input: NodeWorkerLaunchInput,
  signal: AbortSignal,
  dispatch: (
    mode?: "admitted" | "deferred",
    preparation?: NodeWorkerCheckoutPreparation,
  ) => Promise<NodeWorkerLaunchReceipt>,
): Promise<NodeWorkerLaunchReceipt> {
  if (!input.descriptor.assignment.github) {
    return dispatch();
  }
  const receipt = createDeferredCore<NodeWorkerLaunchReceipt>();
  const operation = workspace.withCheckoutPreparation(
    { ...nodeWorkerEnvironmentBinding(input), sessionKey: input.sessionKey },
    async (mode) => {
      const preparation = mode === "admitted" ? createNodeWorkerCheckoutPreparation() : undefined;
      try {
        const result = await dispatch(mode, preparation);
        receipt.resolve(result);
        return result;
      } catch (error) {
        receipt.reject(error);
        throw error;
      } finally {
        if (preparation) {
          // No descriptor bytes means no mutator. Otherwise the exact active turn
          // retains this queue operation until ACK or confirmed tree retirement.
          if (!preparation.dispatched) {
            preparation.settle();
          }
          await preparation.done;
        }
      }
    },
    signal,
  );
  void operation.catch((error: unknown) => {
    receipt.reject(error);
    checkoutLog.warn(`Owned checkout preparation failed: ${String(error).slice(0, 2_048)}`);
  });
  return receipt.promise;
}

export function prepareNodeWorkerLaunch(
  rawInput: NodeWorkerLaunchInput,
  connectionEndpoint: WorkerConnectionEndpoint,
) {
  const input = validateNodeWorkerLaunchInput(structuredClone(rawInput));
  if (
    input.descriptor.assignment.github &&
    !input.descriptor.admission.handshake.protocolFeatures.includes(
      NODE_WORKER_CHECKOUT_PREPARATION_PROTOCOL_FEATURE,
    )
  ) {
    throw new Error(
      "Worker bundle does not support owned checkout preparation; refresh the worker runtime",
    );
  }
  const parsedEndpoint = parseWorkerConnectionEndpoint(connectionEndpoint);
  if (!parsedEndpoint) {
    throw new Error("invalid worker launch descriptor");
  }
  const descriptor = { ...input.descriptor, connectionEndpoint: parsedEndpoint };
  const claimInput: NodeWorkerLaunchClaim = {
    launchId: input.launchId,
    planHash: nodeWorkerPlanHash(input),
    gatewayNamespace: input.gatewayNamespace,
    environmentId: descriptor.admission.environmentId,
    sessionId: descriptor.admission.sessionId,
    ownerEpoch: descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: descriptor.assignment.runId,
  };
  return { input, descriptor, claimInput };
}

export type NodeWorkerChildAdmission = {
  workerEnv: NodeJS.ProcessEnv;
  homeDir?: string;
  input: NodeWorkerLaunchInput;
  descriptor: WorkerLaunchDescriptor;
  supervisor: NodeWorkerProcessIdentity;
  claim: NodeWorkerLaunchClaim;
  signal?: AbortSignal;
  idleRetention?: boolean;
  checkoutMode?: "admitted" | "deferred";
  checkoutPreparation?: NodeWorkerCheckoutPreparation;
  assertWorkspaceCurrent?: () => void;
};

export function createNodeWorkerAdmissionScope(input: NodeWorkerLaunchInput, signal?: AbortSignal) {
  const abort = new AbortController();
  const idleRetention =
    input.idleRetention &&
    input.descriptor.admission.handshake.protocolFeatures.includes(
      NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
    );
  const admissionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  return { abort, idleRetention, admissionSignal };
}

export function acceptNodeWorkerCheckoutPrepared(
  active: NodeWorkerRunningChild,
  turnId: string,
  isCurrentOwner: boolean,
): void {
  const turn = active.turn;
  const preparation = turn?.checkoutPreparation;
  if (
    !turn ||
    turn.claim.launchId !== turnId ||
    !preparation ||
    !preparation.dispatched ||
    active.retiring ||
    active.stopState ||
    !isCurrentOwner
  ) {
    throw new Error("worker returned checkout preparation outside its exact turn");
  }
  delete turn.checkoutPreparation;
  preparation.settle();
}

/** Settles one logical turn while preserving pending checkout custody on its physical owner. */
export function settleNodeWorkerTurnResult(
  active: NodeWorkerRunningChild,
  frame: WorkerProcessResult,
  turns: NodeWorkerTurnStore,
): Promise<void> {
  const turn = active.turn;
  if (!turn || turn.claim.launchId !== frame.turnId || active.retiring) {
    throw new Error("node worker returned a result outside its active turn");
  }
  if (turn.checkoutPreparation && frame.retainWorker) {
    throw new Error("worker retained execution before checkout preparation settled");
  }
  // Publish this operation before finish can invoke a reentrant cancellation.
  const settling = Promise.resolve()
    .then(async () => {
      const receipt = await turns.finish({
        expected: turn.claim,
        ownerLaunchId: active.launchId,
        supervisor: active.supervisor,
        worker: active.worker,
        ...(turn.cancelled
          ? ({
              state: "cancelled",
              errorText: active.connectionFailure.errorText ?? "node worker turn cancelled",
            } as const)
          : ({ state: "completed", resultJson: JSON.stringify(frame.result) } as const)),
      });
      if (!receipt || receipt.state === "pending" || receipt.state === "running") {
        throw new Error("node worker turn completion lost its physical owner");
      }
      // An early failed/fenced result keeps pending preparation on this exact
      // turn until the physical child retires; logical result is not an unlock.
      if (!turn.checkoutPreparation) {
        active.turn = undefined;
      }
      active.retiring = !frame.retainWorker;
      turn.settle();
    })
    .finally(() => {
      if (turn.settling === settling) {
        turn.settling = undefined;
      }
    });
  turn.settling = settling;
  return settling;
}

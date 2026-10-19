import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { NodeWorkerPreparedWorkspaceRuntime } from "./node-worker-prepared-workspace.js";
import { serializeNodeWorkerWorkspace } from "./node-worker-transfer-client.js";
import {
  hashNodeWorkerWorkspaceComponent as hashPathComponent,
  nodeWorkerWorkspaceGenerationKey as workspaceGenerationKey,
  resolveNodePreparedWorkspaceIdentity,
  type NodeWorkerManagedWorkspaceRequest,
} from "./node-worker-workspace-identity.js";
import type { NodeWorkerWorkspaceProcesses } from "./node-worker-workspace-processes.js";

type NodeWorkerCheckoutPreparationOwner = {
  root: string;
  prepared: Pick<NodeWorkerPreparedWorkspaceRuntime, "root" | "store">;
  processes: Pick<NodeWorkerWorkspaceProcesses, "captureAdmission" | "hasActiveWorkspace">;
  deletingWorkspaceGenerations: ReadonlySet<string>;
  beginWorkspaceOperation: (gatewayNamespace: string, generationKey: string) => () => void;
};

/** Shared construction only; the caller retains its existing admission and filesystem checks. */
export function ordinaryWorkspacePaths(
  root: string,
  input: {
    gatewayNamespace: string;
    environmentId: string;
    sessionId: string;
    generation: number;
  },
) {
  const environmentHash = hashPathComponent(input.environmentId, 16);
  const sessionHash = hashPathComponent(input.sessionId, 32);
  const sessionRoot = path.join(
    root,
    input.gatewayNamespace,
    "workspaces",
    environmentHash,
    sessionHash,
  );
  return {
    environmentHash,
    sessionHash,
    sessionRoot,
    workspaceDir: path.join(sessionRoot, String(input.generation)),
    generationKey: workspaceGenerationKey({ ...input, environmentHash, sessionHash }),
  };
}

/** The existing workspace queue owns this short interval, not the model turn. */
export async function withNodeWorkerCheckoutPreparation<T>(
  owner: NodeWorkerCheckoutPreparationOwner,
  request: Omit<NodeWorkerManagedWorkspaceRequest, "sessionKey"> & {
    gatewayNamespace: string;
    sessionKey?: string;
  },
  operation: (mode: "admitted" | "deferred") => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const assertProcessCurrent = owner.processes.captureAdmission(request, request.ownerEpoch);
  const resolveIdentity = async () => {
    const prepared = await owner.prepared.store?.find(request.environmentId);
    if (prepared) {
      if (!request.sessionKey) {
        throw new Error("INVALID_REQUEST: prepared checkout requires its bound session");
      }
      return resolveNodePreparedWorkspaceIdentity(owner.prepared.root, prepared, {
        ...request,
        sessionKey: request.sessionKey,
      });
    }
    // Ordinary RPC placements already bind cwd by namespace/environment/session/epoch;
    // unlike a prepared cache, that identity does not require a stored session key.
    const ordinary = ordinaryWorkspacePaths(owner.root, {
      ...request,
      generation: request.ownerEpoch,
    });
    const expected = ordinary.workspaceDir;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.gatewayNamespace) ||
      !Number.isSafeInteger(request.ownerEpoch) ||
      request.ownerEpoch < 1 ||
      !isPathInside(owner.root, expected) ||
      request.workspaceDir !== expected ||
      !fs.lstatSync(expected).isDirectory() ||
      fs.realpathSync.native(expected) !== expected
    ) {
      throw new Error("INVALID_REQUEST: node placement does not own checkout workspace");
    }
    return {
      workspaceDir: expected,
      gatewayNamespace: request.gatewayNamespace,
      generationKey: ordinary.generationKey,
    };
  };
  const identity = await resolveIdentity();
  if (
    identity.gatewayNamespace !== request.gatewayNamespace ||
    owner.deletingWorkspaceGenerations.has(identity.generationKey)
  ) {
    throw new Error("INVALID_REQUEST: checkout workspace owner changed");
  }
  const release = owner.beginWorkspaceOperation(identity.gatewayNamespace, identity.generationKey);
  try {
    return await serializeNodeWorkerWorkspace(path.dirname(identity.workspaceDir), async () => {
      signal?.throwIfAborted();
      assertProcessCurrent();
      const latest = await resolveIdentity();
      if (
        latest.workspaceDir !== identity.workspaceDir ||
        latest.generationKey !== identity.generationKey
      ) {
        throw new Error("INVALID_REQUEST: checkout workspace binding changed");
      }
      signal?.throwIfAborted();
      assertProcessCurrent();
      return operation(
        owner.processes.hasActiveWorkspace(identity.workspaceDir) ? "deferred" : "admitted",
      );
    });
  } finally {
    release();
  }
}

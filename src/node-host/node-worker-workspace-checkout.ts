import fs from "node:fs";
import path from "node:path";
import { ignoreMissingPath } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import type { NodeWorkerWorkspaceExecInput } from "../worker/node-workspace-protocol.js";
import type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.js";
import type { NodeWorkerPreparedWorkspaceRuntime } from "./node-worker-prepared-workspace.js";
import { serializeNodeWorkerWorkspace } from "./node-worker-transfer-client.js";
import {
  ensureContainedDirectory,
  ensureNodeWorkerWorkspaceSessionRoot,
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

/** Resolves command paths under the caller's existing serialized workspace admission. */
export function resolveNodeWorkerWorkspaceCommandPaths(
  owner: {
    root: string;
    prepared: Pick<NodeWorkerPreparedWorkspaceRuntime, "resolveCommand">;
    validateDeviceFolder: (folder: string) => string;
  },
  input: NodeWorkerWorkspaceExecInput,
  registered: NodeWorkerPreparedWorkspaceRow | undefined,
  prepared: NodeWorkerPreparedWorkspaceRow | undefined,
  deviceFolder: string | undefined,
) {
  let sessionRoot: string;
  let workspacePath: string;
  if (prepared) {
    workspacePath = owner.prepared.resolveCommand(input, prepared).workspaceDir;
    sessionRoot = path.dirname(workspacePath);
  } else {
    if (registered) {
      throw new Error("INVALID_REQUEST: prepared workspace registration disappeared");
    }
    sessionRoot = ensureNodeWorkerWorkspaceSessionRoot(
      owner.root,
      input.gatewayNamespace,
      input.environmentId,
      input.sessionId,
    );
    workspacePath = deviceFolder
      ? owner.validateDeviceFolder(input.deviceFolder!)
      : path.join(sessionRoot, String(input.generation));
  }
  const workspaceName = path.basename(workspacePath);
  const homeDir = deviceFolder
    ? ensureContainedDirectory(sessionRoot, String(input.generation))
    : (prepared?.home_dir ?? sessionRoot);
  if (prepared && (input.resetWorkspace !== undefined || input.seed)) {
    throw new Error("INVALID_REQUEST: a consumed prepared workspace cannot be reset or reseeded");
  }
  if (input.transfer || input.resetWorkspace || input.seed) {
    try {
      const stats = fs.lstatSync(workspacePath);
      const resolved = fs.realpathSync.native(workspacePath);
      if (!stats.isDirectory() || !isPathInside(sessionRoot, resolved)) {
        throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
      }
    } catch (error) {
      ignoreMissingPath(error);
    }
  }
  return { sessionRoot, workspacePath, workspaceName, homeDir };
}

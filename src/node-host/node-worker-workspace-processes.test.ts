import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commandScopes from "../process/exec-spawn.js";
import * as commandExec from "../process/exec.js";
import { BrokerChild } from "../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import * as workspaceTransfer from "./node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaces: NodeWorkerWorkspaceRuntime[] = [];
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.processes.close()));
});

const identity = {
  gatewayNamespace: "gateway-preview",
  environmentId: "worker:preview",
  sessionId: "conversation-preview",
  generation: 1,
};
const serverScript = `
import fs from "node:fs";
import http from "node:http";
const server = http.createServer((req, res) => res.end(fs.existsSync("page.txt") ? fs.readFileSync("page.txt") : process.env.DISPLAY));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("http://127.0.0.1:" + server.address().port + "\\n", () => sendReceipt(source, "ready"));
});
`;
const runtimeExecutableName = path.basename(process.execPath);
function nodeCommand(script: string, extra: Partial<NodeWorkerWorkspaceExecInput> = {}) {
  return { ...identity, argv: [runtimeExecutableName, "-e", script], ...extra };
}
async function withHeldLookup(
  workspace: NodeWorkerWorkspaceRuntime,
  command: NodeWorkerWorkspaceExecInput,
  effect: (
    pending: ReturnType<NodeWorkerWorkspaceRuntime["exec"]>,
    release: () => void,
  ) => Promise<void>,
) {
  const entered = createDeferredCore();
  const lookup = createDeferredCore<undefined>();
  vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockImplementationOnce(async () => {
    entered.resolve();
    return await lookup.promise;
  });
  const pending = workspace.exec(command);
  void pending.catch(() => undefined);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "lookup did not hold the command");
    await effect(pending, () => lookup.resolve(undefined));
  } finally {
    lookup.resolve(undefined);
    await pending.catch(() => undefined);
  }
}
function fixture(ephemeral = false) {
  const root = tempDirs.make("node-workspace-preview-");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root,
    ephemeral,
    env: {
      PATH: path.dirname(process.execPath),
      HOME: root,
      DISPLAY: ":99",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  workspaces.push(workspace);
  if (ephemeral) {
    vi.spyOn(NodeWorkerPreparedWorkspaceStore.prototype, "find").mockResolvedValue(undefined);
  }
  const start: NodeWorkerWorkspaceExecInput = {
    ...identity,
    argv: [
      runtimeExecutableName,
      "--input-type=module",
      "-e",
      `${fixtureReceiptClientSource(receipts.endpoint)}\nconst source = ${JSON.stringify(root)};\n${serverScript}`,
    ],
    process: { action: "start", processId: "preview-server" },
  };
  const control = (action: "status" | "stop", extra: Partial<typeof identity> = {}) =>
    workspace.exec({
      ...identity,
      ...extra,
      argv: ["openclaw-internal-workspace-process"],
      process: { action, processId: "preview-server" },
    });
  const ready = async (signal: AbortSignal) => {
    await withinTest(receipts.waitFor(root, "ready"), signal);
    let url = "";
    await vi.waitFor(async () => {
      url = (await control("status")).stdout.trim();
      expect(url).toMatch(/^http:\/\/127.0.0.1:\d+$/);
    });
    return url;
  };
  const stop = (ownerEpoch = 1, cleanup?: () => Promise<void>) =>
    workspace.processes.stopEnvironment({ ...identity, ownerEpoch }, cleanup);
  const launch = async (signal: AbortSignal, caller?: AbortSignal) => ({
    started: await workspace.exec(start, caller),
    url: await ready(signal),
  });
  const rejectRetired = (command: NodeWorkerWorkspaceExecInput) =>
    expect(workspace.exec(command)).rejects.toThrow("retired");
  const collect = (sequence: number) =>
    workspace.applyRetainSnapshot(
      {
        version: 1,
        gatewayNamespace: identity.gatewayNamespace,
        controllerId: "retention",
        sequence,
        retain: [],
      },
      async () => [],
    );
  return { root, workspace, start, control, ready, launch, stop, collect, rejectRetired };
}

it.skipIf(!supportsSpawnBrokerCommandTransport())(
  "keeps a real legacy command and its preparation queue owned through delayed broker readiness",
  async ({ signal }) => {
    const { root, workspace } = fixture();
    const seeded = await workspace.exec({
      ...identity,
      nativeProcessOwner: true,
      argv: [runtimeExecutableName, "-e", "process.exit(0)"],
    });
    const readiness = createDeferredCore();
    const bounded =
      createDeferredCore<Awaited<ReturnType<typeof commandExec.runCommandWithTimeout>>>();
    const queued = createDeferredCore();
    const controller = new AbortController();
    const host = createSpawnBrokerHost();
    await host.ready();
    const ready = Object.getOwnPropertyDescriptor(BrokerChild.prototype, "ready")?.value as
      | BrokerChild["ready"]
      | undefined;
    if (typeof ready !== "function") {
      throw new Error("Expected the native broker readiness method");
    }
    vi.spyOn(BrokerChild.prototype, "ready").mockImplementation(function (this: BrokerChild) {
      // Delay only receipt delivery. The broker starts a real Node command below.
      return ready.call(this).then(() => readiness.promise);
    });
    const run = commandExec.runCommandWithTimeout;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await run(argv, options);
      if (argv.some((arg) => arg.includes("legacy-real-writer"))) {
        bounded.resolve(result);
      }
      return result;
    });
    const script = `
      import fs from "node:fs";
      import http from "node:http";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      const source = ${JSON.stringify(root)};
      const server = http.createServer((_request, response) => {
        fs.writeFileSync("late.txt", "retained legacy bytes\\n");
        response.end("written");
      });
      server.listen(0, "127.0.0.1", () => {
        fs.writeFileSync("legacy-ready.json", JSON.stringify({
          pid: process.pid, url: "http://127.0.0.1:" + server.address().port,
        }));
        sendReceipt(source, "legacy-real-writer");
      });
    `;
    const execution = runWithSpawnBroker(host, () =>
      workspace.exec(
        {
          ...identity,
          argv: [runtimeExecutableName, "--input-type=module", "-e", script],
        },
        AbortSignal.any([signal, controller.signal]),
      ),
    );
    const outcome = execution.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let preparation: Promise<"admitted" | "deferred"> | undefined;
    let entered = false;
    try {
      await withinTest(receipts.waitFor(root, "legacy-real-writer"), signal);
      const actual = JSON.parse(
        fs.readFileSync(path.join(seeded.workspaceDir, "legacy-ready.json"), "utf8"),
      ) as {
        pid: number;
        url: string;
      };
      expect(() => process.kill(actual.pid, 0)).not.toThrow();
      // Establish real writer bytes before cancellation. Delaying client readiness
      // does not withhold the broker's independent cancellation delivery.
      expect(await (await fetch(actual.url, { signal })).text()).toBe("written");
      expect(fs.readFileSync(path.join(seeded.workspaceDir, "late.txt"), "utf8")).toBe(
        "retained legacy bytes\n",
      );
      controller.abort(new Error("legacy caller cancelled before PID delivery"));
      expect(await withinTest(bounded.promise, signal)).toMatchObject({
        termination: "signal",
        cleanup: "uncertain",
      });
      expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(true);
      const serialize = workspaceTransfer.serializeNodeWorkerWorkspace;
      vi.spyOn(workspaceTransfer, "serializeNodeWorkerWorkspace").mockImplementation(
        <T>(directory: string, operation: () => Promise<T>): Promise<T> => {
          const result = serialize(directory, operation);
          queued.resolve();
          return result;
        },
      );
      preparation = workspace.withCheckoutPreparation(
        {
          gatewayNamespace: identity.gatewayNamespace,
          environmentId: identity.environmentId,
          sessionId: identity.sessionId,
          ownerEpoch: identity.generation,
          workspaceDir: seeded.workspaceDir,
        },
        async (mode) => {
          entered = true;
          return mode;
        },
        signal,
      );
      await withinTest(queued.promise, signal);
      expect(entered).toBe(false);
      // No post-cancellation liveness claim: the bounded result is uncertain
      // until canonical readiness and physical settlement finish below.
      readiness.resolve();
      const completed = await withinTest(outcome, signal);
      expect(completed).not.toHaveProperty("error");
      expect(await withinTest(preparation, signal)).toBe("admitted");
      expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(false);
      expect(() => process.kill(actual.pid, 0)).toThrow();
      expect(fs.readFileSync(path.join(seeded.workspaceDir, "late.txt"), "utf8")).toBe(
        "retained legacy bytes\n",
      );
    } finally {
      readiness.resolve();
      controller.abort();
      await Promise.allSettled([outcome, ...(preparation ? [preparation] : [])]);
      await host.close();
    }
  },
);

it("does not unlock checkout when a real legacy command's canonical cleanup reports uncertainty", async () => {
  const { workspace } = fixture();
  const seeded = await workspace.exec({
    ...identity,
    nativeProcessOwner: true,
    argv: [runtimeExecutableName, "-e", "process.exit(0)"],
  });
  const run = commandExec.runCommandWithTimeout;
  vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const result = await run(argv, options);
    // A real command executes; only the cleanup acknowledgement is fault injected.
    commandScopes.retainCommandProcessCleanup(Promise.resolve("uncertain"));
    return result;
  });
  await expect(
    workspace.exec({
      ...identity,
      argv: [
        runtimeExecutableName,
        "-e",
        "require('node:fs').writeFileSync('late.txt', 'owned bytes');",
      ],
    }),
  ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
  expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(true);
  const request = {
    gatewayNamespace: identity.gatewayNamespace,
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    ownerEpoch: identity.generation,
    workspaceDir: seeded.workspaceDir,
  };
  expect(await workspace.withCheckoutPreparation(request, async (mode) => mode)).toBe("deferred");
  expect(fs.readFileSync(path.join(seeded.workspaceDir, "late.txt"), "utf8")).toBe("owned bytes");
  // Explicit normal cleanup can confirm the canonical receipts; the failed call stays failed.
  await workspace.processes.stopEnvironment({ ...identity, ownerEpoch: identity.generation });
  expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(false);
  expect(await workspace.withCheckoutPreparation(request, async (mode) => mode)).toBe("admitted");
});

it("retains an unknown legacy reservation when construction fails before scope attachment", async () => {
  const { workspace } = fixture();
  const seeded = await workspace.exec({
    ...identity,
    nativeProcessOwner: true,
    argv: [runtimeExecutableName, "-e", "process.exit(0)"],
  });
  const failure = new Error("synthetic ambiguous command construction failure");
  const scope = commandScopes.withCommandProcessScope;
  vi.spyOn(commandScopes, "withCommandProcessScope").mockImplementation(
    (run, signal, custody) => {
      // Model the exact reserve-before-construction gap; no fake PID or native signal.
      custody?.reserve(["synthetic-unacknowledged-legacy-command"]);
      return scope(run, signal, custody);
    },
  );
  vi.spyOn(commandExec, "runCommandWithTimeout").mockRejectedValue(failure);
  try {
    await expect(
      workspace.exec({
        ...identity,
        argv: [runtimeExecutableName, "-e", "0"],
      }),
    ).rejects.toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN", cause: failure });
    expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(true);
    expect(
      await workspace.withCheckoutPreparation(
        {
          gatewayNamespace: identity.gatewayNamespace,
          environmentId: identity.environmentId,
          sessionId: identity.sessionId,
          ownerEpoch: identity.generation,
          workspaceDir: seeded.workspaceDir,
        },
        async (mode) => mode,
      ),
    ).toBe("deferred");
    await expect(
      workspace.processes.stopEnvironment({ ...identity, ownerEpoch: identity.generation }),
    ).rejects.toThrow();
    expect(workspace.processes.hasActiveWorkspace(seeded.workspaceDir)).toBe(true);
  } finally {
    // Unknown custody is deliberately fail-closed. This synthetic reservation
    // spawned nothing; do not make the shared fixture teardown claim it was settled.
    await expect(workspace.processes.close()).rejects.toThrow();
    workspaces.splice(workspaces.indexOf(workspace), 1);
  }
});

it("defers checkout for a live preview and admits the same ordinary workspace after extinction", async ({
  signal,
}) => {
  const { workspace, start, control, ready } = fixture();
  const launched = await workspace.exec(start);
  const url = await ready(signal);
  const request = {
    gatewayNamespace: identity.gatewayNamespace,
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    ownerEpoch: identity.generation,
    workspaceDir: launched.workspaceDir,
  };
  // Ordinary managed placements deliberately have no prepared-cache session key.
  expect(await workspace.withCheckoutPreparation(request, async (mode) => mode)).toBe("deferred");
  expect(workspace.processes.hasActiveWorkspace(launched.workspaceDir)).toBe(true);
  expect(await (await fetch(url)).text()).toBe(":99");
  await control("stop");
  expect(workspace.processes.hasActiveWorkspace(launched.workspaceDir)).toBe(false);
  expect(await workspace.withCheckoutPreparation(request, async (mode) => mode)).toBe("admitted");
});

it("queues preview spawn behind the canonical checkout preparation interval", async ({
  signal,
}) => {
  const { workspace, start, ready } = fixture();
  const seeded = await workspace.exec({
    ...identity,
    nativeProcessOwner: true,
    argv: [runtimeExecutableName, "-e", "process.exit(0)"],
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const previewQueued = createDeferredCore();
  const serialize = workspaceTransfer.serializeNodeWorkerWorkspace;
  let enqueued = 0;
  vi.spyOn(workspaceTransfer, "serializeNodeWorkerWorkspace").mockImplementation(
    <T>(directory: string, operation: () => Promise<T>): Promise<T> => {
      const result = serialize(directory, operation);
      if (++enqueued === 2) {
        previewQueued.resolve();
      }
      return result;
    },
  );
  const execute = vi.spyOn(workspace.processes, "execute");
  const preparation = workspace.withCheckoutPreparation(
    {
      gatewayNamespace: identity.gatewayNamespace,
      environmentId: identity.environmentId,
      sessionId: identity.sessionId,
      ownerEpoch: identity.generation,
      workspaceDir: seeded.workspaceDir,
    },
    async (mode) => {
      expect(mode).toBe("admitted");
      entered.resolve();
      await release.promise;
    },
  );
  let starting: ReturnType<typeof workspace.exec> | undefined;
  try {
    await withinTest(entered.promise, signal);
    starting = workspace.exec(start);
    await withinTest(previewQueued.promise, signal);
    expect(execute).not.toHaveBeenCalled();
    release.resolve();
    await preparation;
    await starting;
    expect((await fetch(await ready(signal))).ok).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([preparation, ...(starting ? [starting] : [])]);
  }
});

it("rejects outside path operands after positional arguments, eval terminators, and option values", async () => {
  const { workspace } = fixture(true);
  const initial = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  const outside = path.join(tempDirs.make("node-workspace-outside-"), "outside.cjs");
  fs.writeFileSync(outside, "process.exit(0)");
  fs.writeFileSync(path.join(initial.workspaceDir, "tool.cjs"), "process.exit(0)");
  const commands = [
    [...(process.versions.bun ? ["run"] : []), "./tool.cjs", "-e", outside],
    ["-e", "process.exit(0)", "--", "-e", outside],
    ["-e", "process.exit(0)", "label", "-p", outside],
    ["--title", "-e", outside],
  ];
  for (const args of commands) {
    await expect(
      workspace.exec({
        ...identity,
        nativeProcessOwner: true,
        argv: [runtimeExecutableName, ...args],
      }),
    ).rejects.toThrow("workspace command argv resolves outside its workspace");
  }
});

it("keeps identical logical process ids isolated across node workspace runtimes", async ({
  signal,
}) => {
  const first = fixture();
  const second = fixture();
  const { url: firstUrl } = await first.launch(signal);
  const { url: secondUrl } = await second.launch(signal);
  await first.stop();
  await expect(fetch(firstUrl)).rejects.toThrow();
  expect(await (await fetch(secondUrl)).text()).toBe(":99");
});

it("rejects an unavailable app while preserving an already running server", async ({ signal }) => {
  const { workspace, start, launch } = fixture();
  const { url } = await launch(signal);
  await expect(
    workspace.exec({
      ...start,
      process: { action: "start", processId: "missing-app" },
      argv: ["openclaw-nonexistent-preview-command"],
    }),
  ).rejects.toThrow("executable is unavailable");
  expect(workspace.processes.hasActiveWork()).toBe(true);
  expect((await fetch(url)).ok).toBe(true);
  await workspace.exec({
    ...start,
    process: { action: "start", processId: "missing-app" },
    argv: [runtimeExecutableName, "-e", "process.exit(0)"],
  });
});

it("keeps the same app and desktop environment across turns, reuses a retried start, and stops its server", async ({
  signal,
}) => {
  const { workspace, start, control, launch } = fixture();
  const turn = new AbortController();
  const { started, url } = await launch(signal, turn.signal);
  expect(await (await fetch(url)).text()).toBe(":99");
  turn.abort();
  await workspace.exec(
    nodeCommand('require("node:fs").writeFileSync("page.txt", "updated preview")'),
  );
  expect(await (await fetch(url)).text()).toBe("updated preview");
  const retried = await workspace.exec(start);
  expect(retried.process).toEqual({ processId: "preview-server", state: "running" });
  expect(retried.workspaceDir).toBe(started.workspaceDir);
  expect(retried.stdout.trim()).toBe(url);
  await expect(
    workspace.exec({
      ...start,
      argv: [runtimeExecutableName, "-e", "setInterval(() => {}, 1000)"],
    }),
  ).rejects.toThrow("different command");
  const stopped = await control("stop");
  expect(stopped.process?.state).toBe("exited");
  expect(parseNodeWorkerWorkspaceExecResult(stopped)).toEqual(stopped);
  await expect(fetch(url)).rejects.toThrow();
});

it("keeps running workspaces through retention and fences exact environment cleanup", async ({
  signal,
}) => {
  const { workspace, control, launch, stop, collect } = fixture();
  const { started, url } = await launch(signal);
  await expect(control("stop", { sessionId: "another-conversation" })).rejects.toThrow(
    "unknown workspace process",
  );
  await collect(1);
  expect(fs.existsSync(started.workspaceDir)).toBe(true);
  expect((await fetch(url)).ok).toBe(true);
  await stop();
  await expect(fetch(url)).rejects.toThrow();
  const resumed = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  expect(resumed.code).toBe(0);
  await collect(2);
  expect(fs.existsSync(started.workspaceDir)).toBe(false);
});

it("revokes a queued reset command but reopens fresh execution at the retained epoch", async () => {
  const { workspace, stop } = fixture(true);
  const command = nodeCommand("process.stdout.write('fresh')", {
    nativeProcessOwner: true,
    resetWorkspace: true,
  });
  // Keep a sentinel in the retained workspace so a late reset cannot silently delete it.
  const initial = await workspace.exec(
    nodeCommand("process.exit(0)", { nativeProcessOwner: true }),
  );
  const sentinel = path.join(initial.workspaceDir, "retained.txt");
  fs.writeFileSync(sentinel, "retained");
  await withHeldLookup(workspace, command, async (pending, release) => {
    await stop();
    release();
    await expect(pending).rejects.toThrow("retired");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained");
    const fresh = await workspace.exec(command);
    expect(fresh).toMatchObject({ code: 0, stdout: "fresh" });
  });
});

it("keeps overlapping stops sealed and excludes higher epochs from stale stop", async () => {
  const { workspace, stop, rejectRetired } = fixture(true);
  const first = createDeferredCore();
  const second = createDeferredCore();
  const secondStarted = createDeferredCore();
  const command = nodeCommand("process.stdout.write('fresh')", { nativeProcessOwner: true });
  const stopping = stop(1, () => first.promise);
  const overlapping = stop(1, async () => {
    secondStarted.resolve();
    await second.promise;
  });
  try {
    await rejectRetired(command);
    first.resolve();
    await stopping;
    await awaitGateBeforeSettlement(
      secondStarted.promise,
      overlapping,
      "second stop did not begin",
    );
    await rejectRetired(command);
    second.resolve();
    await overlapping;
    expect((await workspace.exec(command)).stdout).toBe("fresh");
    await stop(2);
    await rejectRetired(command);
    await withHeldLookup(workspace, { ...command, generation: 3 }, async (higher, release) => {
      await stop();
      release();
      expect((await higher).stdout).toBe("fresh");
    });
    const lowerStarted = createDeferredCore();
    const finishLower = createDeferredCore();
    const lower = stop(1, async () => {
      lowerStarted.resolve();
      await finishLower.promise;
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        lowerStarted.promise,
        lower,
        "lower-epoch stop did not begin",
      );
      expect(workspace.processes.hasActiveWork()).toBe(true);
      closing = workspace.processes.close().then(() => {
        closed = true;
      });
      const drained = await workspace.exec({ ...identity, argv: [NODE_WORKSPACE_DRAIN_COMMAND] });
      expect(drained.stdout.trim()).toBe("drained");
      expect(closed).toBe(false);
      finishLower.resolve();
      await closing;
      await rejectRetired({ ...command, generation: 3 });
    } finally {
      finishLower.resolve();
      await Promise.allSettled([lower, closing]);
    }
  } finally {
    first.resolve();
    second.resolve();
    await Promise.allSettled([stopping, overlapping]);
  }
});

it("rejects revoked starts before launch and bounds both output streams", async ({ signal }) => {
  const { root, workspace, start, control } = fixture();
  const revoked = AbortSignal.abort();
  await expect(workspace.exec(start, revoked)).rejects.toThrow();
  await expect(control("status")).rejects.toThrow("unknown workspace process");
  await workspace.exec({
    ...start,
    argv: [
      runtimeExecutableName,
      "--input-type=module",
      "-e",
      `${fixtureReceiptClientSource(receipts.endpoint)}
sendReceipt(${JSON.stringify(root)}, "output-ready");
await awaitRelease(${JSON.stringify(root)}, "write");
process.stdout.write("界".repeat(20000)); process.stderr.write("界".repeat(20000));`,
    ],
  });
  await withinTest(receipts.waitFor(root, "output-ready"), signal);
  receipts.release(root, "write");
  await withinTest(receipts.waitForExit(root), signal);
  await vi.waitFor(async () => {
    const result = await control("status");
    expect(result.process?.state).toBe("exited");
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(parseNodeWorkerWorkspaceExecResult(result)).toEqual(result);
  });
});

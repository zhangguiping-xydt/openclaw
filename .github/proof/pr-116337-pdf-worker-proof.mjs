import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const sourceRoot = path.resolve(process.argv[2] ?? "");
const expectedSha = process.env.EXPECTED_SHA;
const runnerTemp = process.env.RUNNER_TEMP;

assert(expectedSha, "EXPECTED_SHA is required");
assert(runnerTemp, "RUNNER_TEMP is required");

const proofRoot = path.join(runnerTemp, "pr-116337-pdf-proof");
const evidenceDir = path.join(proofRoot, "evidence");
const proofHome = path.join(proofRoot, "runtime-home");
const proofTmp = path.join(proofRoot, "runtime-tmp");
const cacheHome = path.join(proofRoot, "runtime-cache");
const stateDir = path.join(proofRoot, "state");
const configPath = path.join(stateDir, "openclaw.json");
const gatewayLogPath = path.join(evidenceDir, "gateway.log");
const evidencePath = path.join(evidenceDir, "evidence.json");
const workerPath = path.join(sourceRoot, "dist/media/document-extractors.worker.js");

function createBlankPdf(pageCount) {
  const objects = [];
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  for (const pageId of pageIds) {
    const contentId = pageId + 1;
    const content = "q 0.95 g 0 0 612 792 re f Q\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }

  let pdf = "%PDF-1.4\n% OpenClaw PDF worker cancellation proof\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      assert(address && typeof address !== "string", "server did not bind a TCP port");
      resolve(address.port);
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function capture(command, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `command failed (${code ?? signal ?? "unknown"}): ${stderr || stdout || command}`,
        ),
      );
    });
  });
}

async function taskIds(pid) {
  const entries = await readdir(`/proc/${pid}/task`);
  return new Set(entries.filter((entry) => /^\d+$/u.test(entry)));
}

async function stableTaskIds(pid) {
  let previousKey = "";
  let stableSamples = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ids = await taskIds(pid);
    const key = [...ids].sort().join(",");
    stableSamples = key === previousKey ? stableSamples + 1 : 0;
    previousKey = key;
    if (stableSamples >= 10) {
      return ids;
    }
    await delay(50);
  }
  throw new Error("Gateway worker-thread baseline did not stabilize");
}

async function waitForWorkerStart(pid, baselineIds) {
  const deadline = Date.now() + 30_000;
  let peakCount = baselineIds.size;
  while (Date.now() < deadline) {
    const ids = await taskIds(pid);
    peakCount = Math.max(peakCount, ids.size);
    const newIds = [...ids].filter((id) => !baselineIds.has(id));
    if (newIds.length > 0 && ids.size > baselineIds.size) {
      return { ids, newIds, peakCount };
    }
    await delay(5);
  }
  throw new Error("PDF request did not start a Gateway Worker thread");
}

async function waitForWorkerShutdown(pid, baselineIds, startedIds) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ids = await taskIds(pid);
    const startedRemain = startedIds.some((id) => ids.has(id));
    if (!startedRemain && ids.size === baselineIds.size) {
      return ids;
    }
    await delay(20);
  }
  throw new Error("PDF Worker thread did not return to the stable baseline after disconnect");
}

async function waitForGatewayReady(port, gatewayState) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (gatewayState.exited) {
      const log = await readFile(gatewayLogPath, "utf8").catch(() => "");
      throw new Error(`Gateway exited before readiness: ${JSON.stringify(gatewayState)}\n${log}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // Gateway startup is still in progress.
    }
    await delay(100);
  }
  throw new Error("Gateway did not become ready");
}

async function stopGateway(child, gatewayState) {
  if (gatewayState.exited) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([gatewayState.exitPromise, delay(5_000)]);
  if (!gatewayState.exited) {
    child.kill("SIGKILL");
    await gatewayState.exitPromise;
  }
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(proofHome, { recursive: true });
  await mkdir(proofTmp, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await access(workerPath);

  let providerRequests = 0;
  const providerPaths = [];
  const provider = http.createServer((request, response) => {
    providerRequests += 1;
    providerPaths.push(request.url ?? "");
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "resp_unexpected",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    );
  });
  const providerPort = await listen(provider);
  const gatewayPort = await reservePort();

  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "pr-116337-local-proof-token" },
      http: {
        endpoints: {
          responses: {
            enabled: true,
            files: {
              allowUrl: false,
              timeoutMs: 120_000,
              pdf: { maxPages: 60, maxPixels: 120_000_000, minTextChars: 1 },
            },
          },
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        model: { primary: "proof/pdf-proof" },
        models: { "proof/pdf-proof": { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        proof: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "pr-116337-local-provider-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "pdf-proof",
              name: "PDF proof",
              api: "openai-responses",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const runtimeEnv = {
    HOME: proofHome,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    TMPDIR: proofTmp,
    XDG_CACHE_HOME: cacheHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NO_COLOR: "1",
  };

  const resolverUrl = pathToFileURL(
    path.join(sourceRoot, "dist/plugins/document-extractors.runtime.js"),
  ).href;
  const resolver = await capture(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const m=await import(process.argv[1]); const value=m.resolvePluginDocumentExtractors().map(({id,pluginId,mimeTypes})=>({id,pluginId,mimeTypes})); process.stdout.write(JSON.stringify(value));",
      resolverUrl,
    ],
    { cwd: sourceRoot, env: runtimeEnv },
  );
  const extractors = JSON.parse(resolver.stdout);
  const resolvedExtractor = extractors.find(
    (entry) =>
      entry.id === "pdf" &&
      entry.pluginId === "document-extract" &&
      entry.mimeTypes?.includes("application/pdf"),
  );
  assert(resolvedExtractor, `bundled PDF extractor was not resolved: ${resolver.stdout}`);

  const gatewayLogFd = openSync(gatewayLogPath, "w");
  const gateway = spawn(
    process.execPath,
    [
      path.join(sourceRoot, "openclaw.mjs"),
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--verbose",
    ],
    {
      cwd: sourceRoot,
      env: runtimeEnv,
      stdio: ["ignore", gatewayLogFd, gatewayLogFd],
    },
  );
  closeSync(gatewayLogFd);

  let resolveGatewayExit;
  const gatewayState = {
    exited: false,
    code: undefined,
    signal: undefined,
    exitPromise: new Promise((resolve) => {
      resolveGatewayExit = resolve;
    }),
  };
  gateway.once("exit", (code, signal) => {
    gatewayState.exited = true;
    gatewayState.code = code;
    gatewayState.signal = signal;
    resolveGatewayExit();
  });

  try {
    await waitForGatewayReady(gatewayPort, gatewayState);
    const baselineIds = await stableTaskIds(gateway.pid);
    const pdf = createBlankPdf(60);
    const requestBody = JSON.stringify({
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Read the attached PDF." },
            {
              type: "input_file",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdf.toString("base64"),
                filename: "worker-cancellation-proof.pdf",
              },
            },
          ],
        },
      ],
    });

    let responseSeen = false;
    let responseCompleted = false;
    let clientSocketClosed = false;
    let clientError = "";
    const clientRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: "/v1/responses",
        method: "POST",
        headers: {
          authorization: "Bearer pr-116337-local-proof-token",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        responseSeen = true;
        response.on("end", () => {
          responseCompleted = true;
        });
        response.resume();
      },
    );
    clientRequest.on("socket", (socket) => {
      socket.once("close", () => {
        clientSocketClosed = true;
      });
    });
    clientRequest.on("error", (error) => {
      clientError = error.code ?? error.message;
    });
    clientRequest.end(requestBody);

    const started = await waitForWorkerStart(gateway.pid, baselineIds);
    clientRequest.destroy(new Error("proof client disconnected"));

    for (let attempt = 0; attempt < 300 && !clientSocketClosed; attempt += 1) {
      await delay(10);
    }
    assert(clientSocketClosed, "proof client socket did not close");

    const finalIds = await waitForWorkerShutdown(gateway.pid, baselineIds, started.newIds);
    await delay(1_500);
    const delayedIds = await taskIds(gateway.pid);

    assert.equal(delayedIds.size, baselineIds.size, "Gateway thread count drifted after shutdown");
    assert(
      started.newIds.every((id) => !delayedIds.has(id)),
      "PDF Worker thread survived the delayed-completion window",
    );
    assert.equal(providerRequests, 0, `agent provider was dispatched: ${providerPaths.join(",")}`);
    assert.equal(responseCompleted, false, "request completed after the client disconnected");
    assert.equal(gatewayState.exited, false, "Gateway exited during PDF cancellation proof");

    const evidence = {
      exactHead: expectedSha,
      bundledWorkerPath: path.relative(sourceRoot, workerPath),
      bundledWorkerPresent: true,
      resolvedExtractor,
      gatewayPid: gateway.pid,
      workerBaselineCount: baselineIds.size,
      workerStartedCount: started.ids.size,
      workerPeakCount: started.peakCount,
      workerTaskIdsStarted: started.newIds,
      clientSocketClosed,
      clientError,
      workerFinalCount: finalIds.size,
      workerDelayedCount: delayedIds.size,
      agentDispatchCount: providerRequests,
      providerPaths,
      responseSeen,
      delayedResponseCompletion: responseCompleted,
      gatewayAliveAfterAbort: !gatewayState.exited,
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`[pr-116337-pdf-worker-proof] ${JSON.stringify(evidence)}`);
  } finally {
    await stopGateway(gateway, gatewayState);
    await closeServer(provider);
  }
}

await main();

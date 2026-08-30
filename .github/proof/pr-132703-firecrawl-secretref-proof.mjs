import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sourceDir = path.resolve(process.argv[2] ?? "source");
const expectedSha = process.env.EXPECTED_SHA;
const evidenceDir = path.join(
  process.env.RUNNER_TEMP ?? os.tmpdir(),
  "pr-132703-firecrawl-proof",
  "evidence",
);
const proofNonce = randomUUID();
const gatewayToken = `gateway-${proofNonce}`;
const searchCredential = `search-${proofNonce}`;
const fetchCredential = `fetch-${proofNonce}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert(address && typeof address !== "string", "failed to reserve a Gateway port");
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startFirecrawlFixture() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      const payload =
        request.url === "/v2/search"
          ? { success: true, data: { web: [] } }
          : {
              success: true,
              data: {
                markdown: "# Exact-head Firecrawl proof",
                metadata: {
                  sourceURL: "https://example.com/pr-132703-proof",
                  statusCode: 200,
                },
              },
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "failed to start Firecrawl fixture");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function redact(value) {
  return value
    .replaceAll(searchCredential, "[REDACTED_SEARCH_CREDENTIAL]")
    .replaceAll(fetchCredential, "[REDACTED_FETCH_CREDENTIAL]")
    .replaceAll(gatewayToken, "[REDACTED_GATEWAY_TOKEN]");
}

async function stopGateway(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function waitForGateway(port, child, readLogs) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited before readiness (${child.exitCode}): ${redact(readLogs())}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`readyz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway readiness timed out: ${String(lastError)}\n${redact(readLogs())}`);
}

async function invokeTool(port, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, args, sessionKey: "main" }),
  });
  const payload = await response.json();
  assert(
    response.status === 200,
    `${name} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert(payload?.ok === true, `${name} did not return ok=true: ${JSON.stringify(payload)}`);
  return { status: response.status, ok: payload.ok };
}

async function runScenario(params) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-pr132703-${params.id}-`));
  const configPath = path.join(stateDir, "openclaw.json");
  const secretsPath = path.join(stateDir, "firecrawl-secrets.json");
  const port = await getFreePort();
  const pluginConfig = {};
  if (params.searchFixture) {
    pluginConfig.webSearch = {
      apiKey: { source: "file", provider: "proof_file", id: "/firecrawl/search" },
      baseUrl: params.searchFixture.baseUrl,
    };
  }
  if (params.fetchFixture) {
    pluginConfig.webFetch = {
      apiKey: { source: "file", provider: "proof_file", id: "/firecrawl/fetch" },
      baseUrl: params.fetchFixture.baseUrl,
    };
  }
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    secrets: {
      providers: {
        proof_file: { source: "file", path: secretsPath, mode: "json" },
      },
    },
    plugins: {
      entries: {
        firecrawl: { enabled: true, config: pluginConfig },
      },
    },
  };
  await writeFile(
    secretsPath,
    `${JSON.stringify({ firecrawl: { search: searchCredential, fetch: fetchCredential } })}\n`,
    { mode: 0o600 },
  );
  await chmod(secretsPath, 0o600);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);

  let logs = "";
  const appendLog = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-100_000);
  };
  const gateway = spawn(
    process.execPath,
    [
      "dist/entry.js",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--auth",
      "token",
      "--allow-unconfigured",
      "--force",
    ],
    {
      cwd: sourceDir,
      env: {
        HOME: stateDir,
        PATH: process.env.PATH,
        TMPDIR: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_DISABLE_BONJOUR: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout.on("data", appendLog);
  gateway.stderr.on("data", appendLog);

  try {
    const trackedFixtures = [
      ...new Set([params.searchFixture, params.fetchFixture].filter(Boolean)),
    ];
    const initialRequestCounts = new Map(
      trackedFixtures.map((fixture) => [fixture, fixture.requests.length]),
    );
    await waitForGateway(port, gateway, () => logs);
    const invocation = await invokeTool(port, params.tool, params.args);
    const fixture = params.expectedFixture;
    for (const trackedFixture of trackedFixtures) {
      const expectedDelta = trackedFixture === fixture ? 1 : 0;
      const actualDelta =
        trackedFixture.requests.length - (initialRequestCounts.get(trackedFixture) ?? 0);
      assert(
        actualDelta === expectedDelta,
        `${params.id} sent ${actualDelta} request(s) to ${
          trackedFixture === fixture ? "the expected" : "an unexpected"
        } fixture`,
      );
    }
    const request = fixture.requests.at(-1);
    assert(request, `${params.id} did not reach its Firecrawl fixture`);
    assert(request.method === "POST", `${params.id} used ${request.method}, expected POST`);
    assert(request.path === params.expectedPath, `${params.id} used ${request.path}`);
    assert(
      request.authorization === `Bearer ${params.expectedCredential}`,
      `${params.id} selected the wrong credential`,
    );
    const requestShapeMatches =
      params.expectedPath === "/v2/search"
        ? request.body?.query === params.args.query
        : request.body?.url === params.args.url;
    assert(requestShapeMatches, `${params.id} sent the wrong request body`);

    const persistedConfigText = await readFile(configPath, "utf8");
    assert(
      !persistedConfigText.includes(searchCredential) &&
        !persistedConfigText.includes(fetchCredential),
      `${params.id} persisted resolved credential material`,
    );
    const persistedConfig = JSON.parse(persistedConfigText);
    const configuredCapabilities = ["webSearch", "webFetch"].filter(
      (capability) => persistedConfig.plugins.entries.firecrawl.config[capability],
    );
    for (const capability of configuredCapabilities) {
      const apiKey = persistedConfig.plugins.entries.firecrawl.config[capability].apiKey;
      assert(
        apiKey?.source === "file" && apiKey.provider === "proof_file",
        `${params.id} did not preserve the ${capability} SecretRef`,
      );
    }
    assert(
      !logs.includes(searchCredential) &&
        !logs.includes(fetchCredential) &&
        !logs.includes(gatewayToken),
      `${params.id} leaked proof credentials to Gateway logs`,
    );
    return {
      id: params.id,
      tool: params.tool,
      gatewayStatus: invocation.status,
      gatewayOk: invocation.ok,
      requestMethod: request.method,
      requestPath: request.path,
      endpointMatches: true,
      credentialMatches: true,
      fileSecretRefResolved: true,
      nonTargetEndpointRequests: 0,
      persistedSecretRefs: configuredCapabilities,
      persistedConfigCredentialFree: true,
      gatewayLogsCredentialFree: true,
      requestShape:
        params.expectedPath === "/v2/search" ? { queryMatches: true } : { targetUrlMatches: true },
    };
  } finally {
    await stopGateway(gateway);
    await rm(stateDir, { recursive: true, force: true });
  }
}

await mkdir(evidenceDir, { recursive: true });
const distinctSearch = await startFirecrawlFixture();
const distinctFetch = await startFirecrawlFixture();
const fetchFallback = await startFirecrawlFixture();
const searchFallback = await startFirecrawlFixture();

try {
  const scenarios = [];
  scenarios.push(
    await runScenario({
      id: "distinct-search",
      searchFixture: distinctSearch,
      fetchFixture: distinctFetch,
      expectedFixture: distinctSearch,
      expectedCredential: searchCredential,
      expectedPath: "/v2/search",
      tool: "firecrawl_search",
      args: { query: "PR 132703 distinct search", count: 1 },
    }),
  );
  scenarios.push(
    await runScenario({
      id: "distinct-fetch",
      searchFixture: distinctSearch,
      fetchFixture: distinctFetch,
      expectedFixture: distinctFetch,
      expectedCredential: fetchCredential,
      expectedPath: "/v2/scrape",
      tool: "firecrawl_scrape",
      args: {
        url: "https://example.com/pr-132703-distinct-fetch",
        extractMode: "markdown",
      },
    }),
  );
  scenarios.push(
    await runScenario({
      id: "search-falls-back-to-fetch",
      fetchFixture: fetchFallback,
      expectedFixture: fetchFallback,
      expectedCredential: fetchCredential,
      expectedPath: "/v2/search",
      tool: "firecrawl_search",
      args: { query: "PR 132703 search fallback", count: 1 },
    }),
  );
  scenarios.push(
    await runScenario({
      id: "fetch-falls-back-to-search",
      searchFixture: searchFallback,
      expectedFixture: searchFallback,
      expectedCredential: searchCredential,
      expectedPath: "/v2/scrape",
      tool: "firecrawl_scrape",
      args: {
        url: "https://example.com/pr-132703-fetch-fallback",
        extractMode: "markdown",
      },
    }),
  );

  const evidence = {
    kind: "pr-132703-firecrawl-secretref-gateway-proof",
    exactHead: expectedSha,
    runtime: "Node 24 + built dist/entry.js Gateway + HTTP /tools/invoke",
    secretProvider: "file/json with two distinct non-environment SecretRefs",
    externalBoundary:
      "loopback Firecrawl-compatible HTTP fixtures; no live Firecrawl credentials or paid calls",
    secretsPrinted: false,
    scenarios,
  };
  const evidencePath = path.join(evidenceDir, "firecrawl-secretref-proof.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await Promise.all([
    distinctSearch.close(),
    distinctFetch.close(),
    fetchFallback.close(),
    searchFallback.close(),
  ]);
}

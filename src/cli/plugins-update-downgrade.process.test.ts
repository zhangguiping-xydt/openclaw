// Exercise the operator-facing update command against a real isolated state and npm metadata.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runPluginsUpdateProcess(root: string) {
  const configPath = path.join(root, "config", "openclaw.json");
  const stateDir = path.join(root, "state");
  const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    ["--import", "tsx", entryPath, "plugins", "update", "discord", "--dry-run"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        ALL_PROXY: undefined,
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        HOME: root,
        USERPROFILE: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: root,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_HIDE_BANNER: "1",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        all_proxy: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

describe("plugins update downgrade process", () => {
  it("reports a real npm dry-run downgrade without mutating isolated state", async () => {
    const root = tempDirs.make("openclaw-plugin-update-downgrade-");
    const configPath = path.join(root, "config", "openclaw.json");
    const stateDir = path.join(root, "state");
    const installPath = path.join(root, "extensions", "discord");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { mode: "local" }, plugins: { allow: ["discord"] } }, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(installPath, "package.json"),
      `${JSON.stringify(
        {
          name: "@openclaw/discord",
          version: "2026.7.1",
          openclaw: { extensions: ["./index.ts"] },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(installPath, "index.ts"), "export default {};\n");
    await fs.writeFile(path.join(installPath, "openclaw.plugin.json"), '{"id":"discord"}\n');
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@2026.6.9",
          installPath,
          version: "2026.7.1",
          resolvedName: "@openclaw/discord",
          resolvedVersion: "2026.7.1",
          resolvedSpec: "@openclaw/discord@2026.7.1",
        },
      },
      { stateDir },
    );
    closeOpenClawStateDatabaseForTest();

    const beforeConfig = await fs.readFile(configPath, "utf8");
    const result = runPluginsUpdateProcess(root);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain("Would downgrade discord: 2026.7.1 -> 2026.6.9.");
    expect(await fs.readFile(configPath, "utf8")).toBe(beforeConfig);
    console.log(
      `plugin-update-downgrade-proof ${JSON.stringify({
        status: result.status,
        message: "Would downgrade discord: 2026.7.1 -> 2026.6.9.",
        configUnchanged: (await fs.readFile(configPath, "utf8")) === beforeConfig,
      })}`,
    );
  });
});

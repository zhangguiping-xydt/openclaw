import { fileURLToPath } from "node:url";
import path from "node:path";

const childScript = fileURLToPath(new URL("./proof-cli-child.mjs", import.meta.url));
const markerPath = path.join(
  process.env.OPENCLAW_STATE_DIR ?? process.cwd(),
  "pr-126566-proof-cli-child.json",
);

export default {
  id: "pr-126566-proof-cli",
  register(api) {
    api.registerCliBackend({
      id: "proof-cli",
      bundleMcp: false,
      nativeToolMode: "none",
      config: {
        command: process.execPath,
        args: [childScript, markerPath],
        output: "text",
        input: "stdin",
        sessionMode: "none",
        serialize: true,
      },
    });
  },
};

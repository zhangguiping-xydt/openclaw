import { writeFile } from "node:fs/promises";

const markerPath = process.argv[2];
if (!markerPath) {
  throw new Error("proof CLI marker path is required");
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const stdinBytes = Buffer.concat(chunks).length;
const responseMarker = "QA-SUBAGENT-TERMINAL-FALLBACK-OK";

await writeFile(
  markerPath,
  `${JSON.stringify({
    schema: "openclaw-pr-126566-proof-cli-v1",
    pid: process.pid,
    stdinBytes,
    responseMarker,
  })}\n`,
  "utf8",
);

process.stdout.write(
  [
    responseMarker,
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n"),
);

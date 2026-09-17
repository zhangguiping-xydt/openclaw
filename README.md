# Long session HTML export reproduction

Baseline: 4a35a213beb7b65b80b4bb51df820cec122ecb07
Candidate: 6905ab8bb3bd8f23a640313f626939c5873a37c4

Linux, Node 24.16.0, Google Chrome 138.0.7204.157.
The harness writes 10,000 synthetic messages through the SQLite session accessor, calls buildExportSessionReply, and opens the resulting HTML in real Chrome. No provider or channel is contacted. A single command module is compiled beside generated template/vendor assets; its imports continue to use repository source. This avoids requiring a complete build solely to locate bundled assets.

Copy command.mts to .artifacts/export-html-proof/command.mts in an independently installed checkout. Run:

    node --import ./scripts/tsx.mjs .artifacts/export-html-proof/command.mts red

On the candidate checkout, use green instead of red. The harness expects /usr/bin/google-chrome. State is synthetic and cleaned up; generated HTML contains the local system prompt, so inspect it before sharing. The public screenshots contain only synthetic messages, and JSON stack paths are sanitized.

Baseline: the command reports success but Chrome raises RangeError in sortChildren; no message or tree entry renders. Candidate: all 10,000 entries render and first/last navigation preserves them. The 100-message template control also rendered successfully before the fix.

The committed template.navigation.test.ts separately checks a 50,000-entry chain with hidden intermediate messages and a sibling branch. Hidden records bound DOM cost; the longer chain exceeds the larger Node/Vitest worker stack. Baseline fails in sortChildren; candidate passes. All 30 focused template tests pass.

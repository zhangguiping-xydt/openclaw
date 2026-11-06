// Real CLI + real isolated Gateway. No product imports, mocks, credentials, or model calls.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const mode = process.argv[2];
assert.ok(['red', 'green'].includes(mode), 'usage: cron-proof.mjs red|green [setup-only]');
const proof = process.env.CRON_PROOF_OUTPUT || path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(proof, { recursive: true });
const expectedHead = '4aedd1ddf20b4d1806c7f9b864737bda7d646cab';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), expectedHead);
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '');
const root = fs.mkdtempSync(path.join(proof, `cron-input-${mode}-`));
const state = path.join(root, 'state'), home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
for (const dir of [state, home, workspace]) fs.mkdirSync(dir);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputScript = ' return { notify: "synthetic cron proof 中文" };\n';
const inputTrigger = ' return { fire: false, state: { source: "synthetic trigger 中文" } };\n';
const exactScratch = '\uFEFF Exact synthetic scratch 中文 😀 \r\n';
const ordinary = path.join(root, 'script.js'), linked = path.join(root, 'linked.js');
fs.writeFileSync(ordinary, inputScript);
const triggerFile = path.join(root, 'trigger.js');
fs.writeFileSync(triggerFile, inputTrigger); fs.symlinkSync(triggerFile, linked);
const scratchFile = path.join(root, 'scratch.txt'), scratchLink = path.join(root, 'scratch-link.txt');
fs.writeFileSync(scratchFile, exactScratch); fs.symlinkSync(scratchFile, scratchLink);
const fifo = path.join(root, 'input.fifo'), fifoLink = path.join(root, 'linked.fifo');
execFileSync('mkfifo', [fifo]); fs.symlinkSync(fifo, fifoLink);
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const token = 'synthetic-cron-input-proof-token';
const config = {
  gateway: { mode: 'local', port, bind: 'loopback', auth: { mode: 'token', token }, controlUi: { enabled: false } },
  agents: { entries: { main: {} }, defaults: { workspace, skipBootstrap: true } },
  plugins: { enabled: false, slots: { memory: 'none' } },
  models: { catalogRefresh: { enabled: false } },
  cron: { enabled: false, triggers: { enabled: true } },
  update: { checkOnStart: false },
  discovery: { mdns: { mode: 'off' } },
};
const configPath = path.join(state, 'openclaw.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, NO_COLOR: '1' };
const runs = [], cases = [], children = new Set(), launched = [];
const receipt = { mode, fixture: root, checkout: process.cwd(), node: process.version, port, result: 'INCOMPLETE', runs, cases };
for (const rel of ['src/cli/cron-cli/trigger-options.ts', 'dist/.buildstamp', 'dist/.runtime-postbuildstamp', 'dist/build-info.json']) {
  const file = path.join(process.cwd(), rel);
  if (fs.existsSync(file)) (receipt.sourceAndBuildSha256 ??= {})[rel] = hash(fs.readFileSync(file));
}
receipt.expectedHead = expectedHead;
const initialRuntimeStamp = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'dist/.runtime-postbuildstamp'), 'utf8'));
assert.equal(initialRuntimeStamp.head, expectedHead, 'Runtime build must belong to current PR head');
assert.equal(initialRuntimeStamp.inputsClean, true, 'Runtime build must use clean source');
receipt.initialRuntimePostbuildStamp = initialRuntimeStamp;
const save = () => fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(receipt, null, 2));
function launch(label, args, input) {
  const stdoutPath = path.join(root, `${label}.stdout`), stderrPath = path.join(root, `${label}.stderr`);
  const stdout = fs.openSync(stdoutPath, 'w'), stderr = fs.openSync(stderrPath, 'w');
  const child = spawn(process.execPath, ['openclaw.mjs', ...args], { env, detached: true, stdio: ['pipe', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const item = { label, args: ['node', 'openclaw.mjs', ...args], child, startedAt: Date.now(), stdoutPath, stderrPath };
  item.closed = new Promise(resolve => {
    child.once('error', error => { item.error = String(error); resolve(); });
    child.once('close', (code, signal) => { item.outcome = { code, signal }; children.delete(item); resolve(); });
  });
  children.add(item); launched.push(item); child.stdin.on('error', () => {}); child.stdin.end(input);
  return item;
}
function groupMembers(group) {
  const pids = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && fields[0] !== 'Z') pids.push(Number(pid));
    } catch {}
  }
  return pids;
}
async function stop(item) {
  if (item.outcome && groupMembers(item.child.pid).length === 0) return;
  try { process.kill(-item.child.pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 20000;
  while (groupMembers(item.child.pid).length > 0 && Date.now() < deadline) await delay(100);
  if (groupMembers(item.child.pid).length > 0) {
    item.forcedCleanup = true;
    try { process.kill(-item.child.pid, 'SIGKILL'); } catch {}
  }
  await item.closed;
  for (let attempt = 0; attempt < 20 && groupMembers(item.child.pid).length > 0; attempt++) await delay(100);
}
function logs(item) { return fs.readFileSync(item.stdoutPath, 'utf8') + fs.readFileSync(item.stderrPath, 'utf8'); }
function blockedOpen(file) {
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let tids;
    try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const tid of tids) {
      try {
        const syscall = fs.readFileSync(`/proc/${pid}/task/${tid}/syscall`, 'utf8').trim();
        const fields = syscall.split(/\s+/);
        if (fields[0] !== '257') continue; // Linux x86_64 openat, used by this pinned environment.
        const fd = fs.openSync(`/proc/${pid}/mem`, 'r'), buffer = Buffer.alloc(4096);
        try { fs.readSync(fd, buffer, 0, buffer.length, Number(BigInt(fields[2]))); } finally { fs.closeSync(fd); }
        const openPath = buffer.subarray(0, buffer.indexOf(0)).toString();
        if (openPath !== file) continue;
        const flags = Number(BigInt(fields[3]));
        if (flags & fs.constants.O_NONBLOCK) continue;
        return { pid, tid, syscall, openPath, flags, observedAt: Date.now() };
      } catch {}
    }
  }
  return undefined;
}
async function command(label, args, options = {}) {
  const item = launch(label, args, options.input);
  let first, confirmed, writer, writerClosed;
  try {
    while (!item.outcome && !item.error && Date.now() - item.startedAt < 180000) {
      if (options.fifo && !confirmed) {
        const now = blockedOpen(options.fifo);
        if (!first && now) first = now;
        if (first && now && now.tid === first.tid && now.openPath === first.openPath && now.observedAt - first.observedAt >= 1000) {
          confirmed = now;
          if (mode === 'green') throw Error(`Product regression: ${label} still blocks opening FIFO before any writer`);
          writer = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))', options.fifo, Buffer.from(options.releaseText).toString('base64')], { stdio: 'ignore' });
          writerClosed = new Promise(resolve => writer.once('close', (code, signal) => resolve({ code, signal })));
        }
      }
      await delay(options.fifo ? 50 : 100);
    }
    if (item.error) throw Error(item.error);
    if (!item.outcome) throw Error(`Harness deadline; product proof inconclusive: ${label}\n${logs(item).slice(-5000)}`);
    await item.closed;
    let writerOutcome;
    if (writerClosed) {
      const writerDeadline = Date.now() + 10000;
      while (writer.exitCode === null && writer.signalCode === null && Date.now() < writerDeadline) await delay(50);
      assert.ok(writer.exitCode !== null || writer.signalCode !== null, 'Fixture writer did not finish after FIFO release');
      writerOutcome = await writerClosed;
    }
    const result = { label, command: item.args, ...item.outcome, elapsedMs: Date.now() - item.startedAt,
      stdoutPath: item.stdoutPath, stderrPath: item.stderrPath,
      blockedOpen: first ? { first, confirmed, writerStartedAfterConfirmation: Boolean(writer), writerOutcome } : null };
    runs.push(result); save(); console.log(JSON.stringify(result));
    if (options.fifo && mode === 'red') {
      assert.ok(first && confirmed && confirmed.observedAt - first.observedAt >= 1000, `No confirmed FIFO blocking evidence for ${label}`);
      assert.deepEqual(writerOutcome, { code: 0, signal: null });
    }
    if (options.fifo && mode === 'green') assert.equal(first, undefined, 'Nonblocking admission must not perform a blocking open');
    const expectedCode = options.fifo && mode === 'green' ? 1 : 0;
    assert.equal(item.outcome.signal, null, logs(item).slice(-5000));
    assert.equal(item.outcome.code, expectedCode, logs(item).slice(-5000));
    const out = fs.readFileSync(item.stdoutPath, 'utf8').trim();
    let json;
    try { json = JSON.parse(out); } catch (error) { throw Error(`Expected one JSON document for ${label}: ${out.slice(-3000)}`, { cause: error }); }
    if (expectedCode === 1) {
      assert.equal(json.ok, false);
      assert.equal(json.error?.type, "cli_error");
      assert.match(json.error?.message ?? '', /regular file/i);
      result.error = json.error;
    }
    return json;
  } finally {
    if (!item.outcome) await stop(item);
    if (writer && writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGKILL'); await writerClosed; }
  }
}
const gateway = launch('gateway', ['gateway', 'run', '--port', String(port), '--bind', 'loopback', '--ws-log', 'full', '--verbose']);
const common = ['--json', '--timeout', '30000'];
const list = label => command(label, ['cron', 'list', '--all', ...common]);
const get = (label, id) => command(label, ['cron', 'get', id, ...common]);
const scratch = (label, id) => command(label, ['cron', 'scratch', id, ...common]);
const addArgs = (name, kind, file) => ['cron', 'add', '--name', name, '--agent', 'main', '--every', '1d', '--disabled', '--session', kind === 'script' ? 'isolated' : 'main',
  ...(kind === 'script' ? ['--no-deliver', '--script', file] : ['--system-event', 'Synthetic disabled job; never execute', '--trigger-script', file]), ...common];
try {
  let ready = false;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (gateway.outcome || gateway.error) throw Error(`Real Gateway exited during setup: ${logs(gateway).slice(-6000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, `Gateway not ready; setup failure:\n${logs(gateway).slice(-6000)}`);
  receipt.gatewayReadyAt = new Date().toISOString(); save();
  const status = await command('setup-cron-status', ['cron', 'status', ...common]);
  assert.equal(status.enabled, false, 'Scheduler must stay disabled throughout proof');
  if (process.argv[3] === 'setup-only') {
    receipt.result = 'SETUP_PASS';
  } else {
    const scriptSeed = await command('control-add-script-regular', addArgs('proof-seed-script', 'script', ordinary));
    assert.ok(scriptSeed.id); assert.equal(scriptSeed.enabled, false);
    const seedRead = await get('control-add-script-readback', scriptSeed.id);
    assert.equal(seedRead.payload.script, inputScript.trim());
    const seed = await command('control-add-trigger-symlink', addArgs('proof-seed-trigger', 'trigger', linked));
    assert.ok(seed.id); assert.equal(seed.enabled, false);
    assert.equal((await get('control-add-trigger-readback', seed.id)).trigger.script, inputTrigger.trim());
    await command('control-scratch-stdin', ['cron', 'scratch', seed.id, '--file', '-', ...common], { input: exactScratch });
    assert.equal((await scratch('control-scratch-stdin-readback', seed.id)).scratch.content, exactScratch);
    cases.push({ kind: 'controls', result: 'PASS', regularAndSymlinkAndStdinReadback: true }); save();
    for (const [label, kind, operation, file] of [
      ['add-script-fifo', 'script', 'add', fifo],
      ['edit-trigger-symlink-fifo', 'trigger', 'edit', fifoLink],
      ['scratch-fifo', 'scratch', 'scratch', fifo],
    ]) {
      const text = kind === 'scratch' ? ` Exact ${label} 中文\r\n` : kind === 'trigger' ? `return { fire: false, state: { source: "${label}" } };\n` : `return { notify: "${label}" };\n`;
      const readState = name => operation === 'add' ? list(name) : operation === 'edit' ? get(name, seed.id) : scratch(name, seed.id);
      const before = await readState(`${label}-before`);
      const args = operation === 'add' ? addArgs(`proof-${label}`, kind, file) : operation === 'edit'
        ? ['cron', 'edit', seed.id, kind === 'script' ? '--script' : '--trigger-script', file, ...common]
        : ['cron', 'scratch', seed.id, '--file', file, ...common];
      const result = await command(label, args, { fifo: file, releaseText: text });
      const after = await readState(`${label}-after`);
      if (mode === 'green') {
        assert.deepEqual(after, before, `${label}: business state changed on rejected input`);
      } else if (operation === 'add') {
        assert.ok(result.id);
        const readback = await get(`${label}-readback`, result.id);
        assert.equal(kind === 'script' ? readback.payload.script : readback.trigger.script, text.trim());
        assert.equal(readback.enabled, false);
      } else {
        assert.equal(kind === 'script' ? after.payload.script : kind === 'trigger' ? after.trigger.script : after.scratch.content, kind === 'scratch' ? text : text.trim());
      }
      cases.push({ label, kind, operation, result: 'PASS', unchangedOnRejection: mode === 'green', beforeSha256: hash(JSON.stringify(before)), afterSha256: hash(JSON.stringify(after)) });
      save();
    }
    assert.equal((await command('final-cron-status', ['cron', 'status', ...common])).enabled, false);
    const jobs = (await list('final-job-list')).jobs;
    assert.ok(Array.isArray(jobs) && jobs.length >= 2);
    assert.ok(jobs.every(job => job.enabled === false), 'Every proof job must remain disabled');
    receipt.persistedDisabledJobIds = jobs.map(job => job.id);
    assert.equal(fs.readFileSync(ordinary, 'utf8'), inputScript);
    assert.equal(fs.readFileSync(scratchFile, 'utf8'), exactScratch);
    assert.ok(fs.statSync(fifo).isFIFO());
    receipt.result = 'PASS';
  }
} catch (error) {
  receipt.result = 'FAILED_OR_INCONCLUSIVE'; receipt.error = String(error); throw error;
} finally {
  for (const item of launched) await stop(item);
  receipt.survivingOwnedPids = launched.flatMap(item => groupMembers(item.child.pid));
  if (receipt.survivingOwnedPids.length) receipt.result = 'FAILED_OR_INCONCLUSIVE';
  receipt.gatewayExit = gateway.outcome;
  receipt.gatewayForcedCleanup = Boolean(gateway.forcedCleanup);
  receipt.cleanup = 'All collector-owned CLI/Gateway process groups stopped; synthetic input/state retained for inspection. No models were called; scheduler and all created jobs remained disabled.';
  for (const [rel, sha] of Object.entries(receipt.sourceAndBuildSha256)) {
    if (hash(fs.readFileSync(path.join(process.cwd(), rel))) !== sha) {
      const finalBytes = fs.readFileSync(path.join(process.cwd(), rel));
      const finalStamp = rel === 'dist/.runtime-postbuildstamp' ? JSON.parse(finalBytes) : undefined;
      if (finalStamp && initialRuntimeStamp.staticAssets === false && finalStamp.staticAssets === true &&
          finalStamp.head === initialRuntimeStamp.head && finalStamp.inputSignature === initialRuntimeStamp.inputSignature &&
          finalStamp.inputsClean === initialRuntimeStamp.inputsClean) {
        receipt.normalStaticAssetPreparation = { before: initialRuntimeStamp, after: finalStamp, afterSha256: hash(finalBytes) };
      } else receipt.provenanceChanged = true;
    }
  }
  if (receipt.provenanceChanged) receipt.result = 'FAILED_OR_INCONCLUSIVE';
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, fixture: root, cases: cases.length, commands: runs.length, gatewayForcedCleanup: receipt.gatewayForcedCleanup }));
}
assert.ok(['PASS', 'SETUP_PASS'].includes(receipt.result), 'Proof incomplete');

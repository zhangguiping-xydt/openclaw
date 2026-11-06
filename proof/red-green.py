import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

proof = Path(__file__).resolve().parent
base = '3dcbccb6979e367dde7a443b8ce22f49546e6b8b'
head = '4aedd1ddf20b4d1806c7f9b864737bda7d646cab'
owner = 'src/cli/cron-cli/trigger-options.ts'
test = 'src/cli/cron-cli/trigger-options.test.ts'
def git(*args):
    return subprocess.check_output(['git', *args])
assert git('rev-parse', 'HEAD').decode().strip() == head
assert git('rev-parse', 'HEAD^').decode().strip() == base
assert not git('status', '--porcelain', '--untracked-files=no').strip()
changed = git('diff', '--name-only', base, head, '--', 'src').decode().splitlines()
assert set(changed) == {owner, test}, changed
fixed = Path(owner).read_bytes()
test_hash = hashlib.sha256(Path(test).read_bytes()).hexdigest()
args = ['node', 'scripts/run-vitest.mjs', test, '--maxWorkers=1', '--reporter=verbose', '-t', 'rejects FIFO']
results = []
try:
    for mode in ['green', 'red']:
        if mode == 'red':
            Path(owner).write_bytes(git('show', f'{base}:{owner}'))
        log = proof / f'{mode}-regressions.log'
        with log.open('w') as out:
            result = subprocess.run(args, stdout=out, stderr=subprocess.STDOUT, timeout=900)
        text = re.sub(r'\x1b\[[0-9;]*m', '', log.read_text())
        print(text[-14000:], flush=True)
        expected = '3 passed' if mode == 'green' else '3 failed'
        assert (result.returncode == 0) == (mode == 'green'), (mode, result.returncode)
        assert re.search(r'Tests\s+.*' + expected, text), (mode, 'assertions not reached')
        for option in ['script', 'trigger-script', 'file']:
            assert f'rejects FIFO --{option} inputs without a Gateway mutation' in text
        results.append({'mode': mode, 'exitCode': result.returncode, 'testSha256': test_hash,
                        'productionOwnerSha256': hashlib.sha256(Path(owner).read_bytes()).hexdigest(),
                        'expectedResult': expected, 'logSha256': hashlib.sha256(log.read_bytes()).hexdigest()})
finally:
    Path(owner).write_bytes(fixed)
    assert not git('status', '--porcelain', '--untracked-files=no').strip()
    (proof / 'regression-comparison.json').write_text(json.dumps({
        'head': head, 'base': base, 'command': args, 'results': results,
        'method': 'Exact head tests; restore the only changed production file to its exact base bytes for RED; all other production source is identical.',
        'worktreeRestored': True,
    }, indent=2))
assert len(results) == 2

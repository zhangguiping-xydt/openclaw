import json
import shutil
import subprocess
import sys
from pathlib import Path

mode = sys.argv[1]
root = Path('/tmp/docs-proof')
root.mkdir()
(root / 'scripts').mkdir()
shutil.copytree('/src/scripts/lib', root / 'scripts/lib')
for file in ['format-docs.mts', 'windows-cmd-helpers.mjs', 'tsx.mjs']:
    shutil.copy2('/src/scripts/' + file, root / 'scripts' / file)
if mode == 'before':
    shutil.copy2('/proof/base-format-docs.mts', root / 'scripts/format-docs.mts')
shutil.copy2('/src/.oxfmtrc.jsonc', root / '.oxfmtrc.jsonc')
(root / 'package.json').write_text('{"type":"module"}\n')
modules = root / 'node_modules'
modules.mkdir()
for package, pattern in [('tsx', 'tsx@4.23.15'), ('oxfmt', 'oxfmt@0.74.0')]:
    source, = Path('/deps').glob(pattern)
    (modules / package).symlink_to(source / 'node_modules' / package)

def run(args):
    r = subprocess.run(args, cwd=root, text=True, capture_output=True, timeout=30)
    return dict(argv=args, exit=r.returncode, stdout=r.stdout, stderr=r.stderr)

assert run(['git', 'init', '--quiet'])['exit'] == 0
assert run(['git', 'config', 'core.quotePath', 'true'])['exit'] == 0
(root / 'docs').mkdir()
files = ['docs/root.md', 'docs/root.mdx', 'docs/guide/指南.md', 'docs/guide/quote"name.md', 'docs/guide/line\nbreak.md']
original = '# Guide\n\n-   first\n-   second\n'
for file in files:
    (root / file).parent.mkdir(parents=True, exist_ok=True)
    (root / file).write_text(original)
(root / 'README.md').write_text('# Guide\n')
assert run(['git', 'add', '--', 'README.md', 'docs'])['exit'] == 0
command = ['node', '--import', './scripts/tsx.mjs', 'scripts/format-docs.mts']
check = run(command + ['--check'])
assert all((root / f).read_text() == original for f in files), 'check modified input'
write = run(command)
observed = {f: (root / f).read_text() for f in files}
check_after = run(command + ['--check'])
record = dict(mode=mode, runtime=run(['node', '--version'])['stdout'].strip(),
              git_paths=run(['git', 'ls-files']), raw_paths=run(['git', 'ls-files', '-z', 'docs/**/*.md', 'docs/**/*.mdx', 'README.md']), source_line=[line for line in (root / 'scripts/format-docs.mts').read_text().splitlines() if 'const result = spawnSync("git"' in line], check=check, write=write,
              original=original, files=observed, check_after=check_after)
print(json.dumps(record, ensure_ascii=False, indent=2))
Path('/proof/' + mode + '.json').write_text(json.dumps(record, ensure_ascii=False, indent=2))
assert write['exit'] == 0 and check_after['exit'] == 0
if mode == 'before':
    assert check['exit'] == 0 and all(text == original for text in observed.values())
    assert 'clean (1 files)' in check['stdout']
else:
    assert check['exit'] == 1 and '5 docs file(s)' in check['stderr']
    assert all(text != original for text in observed.values())
    assert 'clean (6 files)' in check_after['stdout']

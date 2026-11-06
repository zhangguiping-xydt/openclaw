from pathlib import Path
import re
import sys

source, target = map(Path, sys.argv[1:])
target.mkdir(parents=True, exist_ok=True)
# Publish only proof records and process output, never the synthetic state DB or config.
files = list(source.glob('*.log')) + list(source.glob('regression-comparison.json'))
for fixture in source.glob('cron-input-*'):
    files += list(fixture.glob('*.stdout')) + list(fixture.glob('*.stderr'))
    files += list(fixture.glob('results.json'))
for file in files:
    text = file.read_text(errors='replace')
    text = text.replace('synthetic-cron-input-proof-token', '<synthetic-token-redacted>')
    text = re.sub(r'127\.0\.0\.1(?::\d+)?', '<loopback>', text)
    text = re.sub(r'localhost:\d+', '<loopback>', text)
    text = re.sub(r'"port":\s*\d+', '"port": "<loopback-port>"', text)
    out = target / file.relative_to(source)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
print(f'Exported {len(files)} redacted evidence files; no state DB or config exported.')

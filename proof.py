import hashlib,json,subprocess,sys,tempfile,os
from pathlib import Path
script=Path(os.environ.get('TRANSCRIPT_SCRIPT', '/src/extensions/knowledge/skills/knowledge-source-ingest/scripts/chat-transcript.mjs'))
records=[]
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp);src=root/'input.jsonl';out=root/'transcripts'
 def row(i,at,text):return {'id':i,'occurred_at':at,'payload':{'author_id':'a','author_name':'开发者🦀','content':text}}
 def run(rows,target=out):
  src.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
  return subprocess.run(['node',str(script),'--input',str(src),'--output-dir',str(target),'--channel','#synthetic'],capture_output=True,text=True,timeout=10)
 def snapshot():return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir()}
 good=[row('1','2026-10-01T12:00:00Z','Original 🦀'),row('2','2026-10-02T12:00:00.123456789Z','Precise message')]
 for invalid in ['2026-13-10T12:00:00Z','2026-10-02T25:00:00Z']:
  seeded=run(good);assert seeded.returncode==0,seeded.stderr
  before=snapshot()
  bad=[row('1','2026-10-01T12:00:00Z','New content must not replace old output'),row('bad',invalid,'Invalid')]
  result=run(bad);after=snapshot()
  record={'timestamp':invalid,'exit':result.returncode,'unchanged_files':before==after,'files_added':sorted(after.keys()-before.keys()),'files_changed':sorted(k for k in before if before[k]!=after.get(k)),'stderr':result.stderr.replace(tmp,'<temporary>'),'pass':result.returncode!=0 and before==after}
  records.append(record)
  for f in out.iterdir():f.unlink()
 report={'source_sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'valid_control':'Real CLI succeeds with whole seconds, nine-digit fractions, and Unicode; generated five files','records':records}
 Path('/proof/'+sys.argv[1]+'.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
 sys.exit(0 if all(r['pass'] for r in records) else 1)

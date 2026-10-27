"""Run the existing source inventory for pages 0 and 1 of the public fixture."""
import hashlib
import json
from pathlib import Path
import sys

PUBLIC_SHA = 'b41ec33c64b72da8b5c43156751998f6b2f64a3a934dab15a2e15b0894bd2ffb'
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'app' / 'local'))
from paper_inventory import build_inventory

source = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(source).hexdigest() != PUBLIC_SHA:
    raise ValueError('not the verified public fixture')
report = build_inventory(source, page_indices=[0, 1])
if report['status'] != 'available' or len(report['pages']) != 2:
    raise RuntimeError('existing parser inventory unavailable')
Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': report['status'], 'sourceSha256': report['sourceSha256'], 'pageTextLines': [len(page['text']) for page in report['pages']]}))

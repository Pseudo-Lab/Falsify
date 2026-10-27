"""Emit only the public experiment result and previews with hashes for relay."""
import base64
import hashlib
import json
from pathlib import Path
import sys

root = Path('/tmp/falsify-layout-evaluation')
names = ('docling-detector.json', 'public-page-1.png', 'public-page-2.png')
artifacts = []
for name in names:
    data = (root / name).read_bytes()
    if len(data) > 10 * 1024 * 1024:
        raise ValueError('artifact exceeds 10 MiB')
    item = {'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if '--manifest' not in sys.argv[1:]:
        item['base64'] = base64.b64encode(data).decode('ascii')
    artifacts.append(item)
print(json.dumps({'schema': 'falsify.public-layout-relay.v1', 'artifacts': artifacts}))

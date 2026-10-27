"""Verify and unpack only the known public result files from a collect.py relay."""
import base64
import hashlib
import json
from pathlib import Path
import sys

NAMES = {'docling-detector.json', 'public-page-1.png', 'public-page-2.png'}


def unpack(packet, directory):
    if packet.get('schema') != 'falsify.public-layout-relay.v1':
        raise ValueError('unexpected relay schema')
    artifacts = packet['artifacts']
    if len(artifacts) != len(NAMES) or {a['name'] for a in artifacts} != NAMES:
        raise ValueError('unexpected relay artifact names')
    verified = []
    for item in artifacts:
        data = base64.b64decode(item['base64'], validate=True)
        if len(data) > 10 * 1024 * 1024 or len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('relay artifact verification failed')
        verified.append((item['name'], data))
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in verified:
        (directory / name).write_bytes(data)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as stream:
        unpack(json.load(stream), Path(sys.argv[2]))

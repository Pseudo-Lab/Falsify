#!/usr/bin/env python3
"""Reconstruct the pinned static Noto faces; reject any byte drift."""
import argparse
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

import fontTools
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

APP = Path(__file__).resolve().parents[1]
PROOF = json.loads((APP / 'dist/recomposition-vendor/static-font-provenance.json').read_text(encoding='utf-8'))
COMMIT = PROOF['sourceCommit']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if fontTools.__version__ != PROOF['fonttools']:
        raise SystemExit('Expected fonttools ' + PROOF['fonttools'])
    args.sources.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    for face in PROOF['faces']:
        source = args.sources / face['source']
        family, filename = face['source'].split('-', 1)
        if not source.exists():
            url = f'https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/{family}/' + quote(filename)
            source.write_bytes(urlopen(url, timeout=60).read())
        if digest(source.read_bytes()) != face['sourceSha256']:
            raise SystemExit('Source hash mismatch: ' + str(source))
        license_path = args.sources / (family + '-OFL.txt')
        if not license_path.exists():
            url = f'https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/{family}/OFL.txt'
            license_path.write_bytes(urlopen(url, timeout=60).read())
        if digest(license_path.read_bytes()) != 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a':
            raise SystemExit('License hash mismatch: ' + str(license_path))
        font = TTFont(source, recalcTimestamp=False)
        instantiateVariableFont(font, face['axes'], inplace=True)
        names = font['name']
        for record in names.names:
            values = {1: face['family'], 2: face['subfamily'], 4: face['family'] + ' ' + face['subfamily'], 6: face['postscript']}
            if record.nameID == 3:
                values[3] = record.toUnicode().rsplit(';', 1)[0] + ';' + face['postscript']
            if record.nameID in values:
                record.string = values[record.nameID].encode(record.getEncoding())
        names.names = [n for n in names.names if n.nameID not in (16, 17)]
        font['OS/2'].usWeightClass = face['weight']
        font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~(1 | 32 | 64)) | (1 if face['italic'] else 0) | (32 if face['weight'] == 700 else 0) | (64 if face['weight'] == 400 and not face['italic'] else 0)
        font['head'].macStyle = (font['head'].macStyle & ~3) | (1 if face['weight'] == 700 else 0) | (2 if face['italic'] else 0)
        buffer = io.BytesIO()
        font.save(buffer)
        data = buffer.getvalue()
        if digest(data) != face['sha256']:
            raise SystemExit('Generated font hash mismatch: ' + face['file'] + ' (got ' + digest(data) + ')')
        (args.output / face['file']).write_bytes(data)
    (args.output / 'manifest.json').write_text(json.dumps(PROOF, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()

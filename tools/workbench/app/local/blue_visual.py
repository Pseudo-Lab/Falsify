"""Validation and temporary transport for opt-in BLUE visual evidence."""
import base64
import hashlib
import math
import re
import struct
import tempfile
import zlib
from pathlib import Path

HEX = re.compile(r'^[0-9a-f]{64}$')
KEYS = {'fileHash', 'sourceHash', 'page', 'bbox', 'rotation', 'width', 'height', 'mime', 'sha256', 'base64'}

def validate_png(raw, width, height):
    # Canvas PNGs are 8-bit RGB/RGBA, non-interlaced. Validate every chunk and
    # bounded decoded scanlines before passing untrusted bytes to a provider.
    try:
        pos, chunks, ended = 8, [], False
        while pos < len(raw):
            if pos + 12 > len(raw): raise ValueError()
            size = struct.unpack('>I', raw[pos:pos+4])[0]
            if size > len(raw) - pos - 12: raise ValueError()
            kind = raw[pos+4:pos+8]; data = raw[pos+8:pos+8+size]
            crc = struct.unpack('>I', raw[pos+8+size:pos+12+size])[0]
            if zlib.crc32(kind + data) & 0xffffffff != crc: raise ValueError()
            if not chunks and (kind != b'IHDR' or size != 13): raise ValueError()
            if kind == b'IHDR':
                if chunks or data[:8] != struct.pack('>II', width, height) or data[8] != 8 or data[9] not in (2, 6) or data[10:] != b'\x00\x00\x00': raise ValueError()
                channels = 3 if data[9] == 2 else 4
            chunks.append((kind, data)); pos += size + 12
            if kind == b'IEND':
                if size or pos != len(raw): raise ValueError()
                ended = True; break
        if not ended or not any(k == b'IDAT' for k, _ in chunks): raise ValueError()
        expected = (width * channels + 1) * height
        decoder = zlib.decompressobj(); decoded = decoder.decompress(b''.join(d for k, d in chunks if k == b'IDAT'), expected + 1)
        if len(decoded) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or any(decoded[i] > 4 for i in range(0, expected, width * channels + 1)): raise ValueError()
    except (ValueError, struct.error, zlib.error, UnboundLocalError):
        raise ValueError('visual_png_invalid') from None

def validate_visual(data):
    items = data.get('visualEvidence')
    if items is None:
        if 'visualConsent' in data or 'fileHash' in data: raise ValueError('visual_envelope_invalid')
        return []
    if data.get('visualConsent') is not True: raise ValueError('visual_consent_required')
    file_hash = data.get('fileHash')
    if not isinstance(file_hash, str) or not HEX.fullmatch(file_hash): raise ValueError('visual_file_hash_invalid')
    if not isinstance(items, list) or not 1 <= len(items) <= 2: raise ValueError('visual_count_limit')
    decoded = []
    for item in items:
        if not isinstance(item, dict) or set(item) != KEYS: raise ValueError('visual_item_invalid')
        if item['fileHash'] != file_hash or item['sourceHash'] != data['sourceHash']: raise ValueError('visual_binding_mismatch')
        if type(item['page']) is not int or item['page'] < 1 or item['rotation'] not in (0, 90, 180, 270) or type(item['rotation']) is not int: raise ValueError('visual_location_invalid')
        bbox = item['bbox']
        if not isinstance(bbox, list) or len(bbox) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in bbox) or bbox[0] < 0 or bbox[1] < 0 or bbox[2] <= 0 or bbox[3] <= 0: raise ValueError('visual_bbox_invalid')
        w, h = item['width'], item['height']
        if type(w) is not int or type(h) is not int or not (0 < w <= 4096 and 0 < h <= 4096 and w*h <= 8000000) or w != math.ceil(bbox[2]*2) or h != math.ceil(bbox[3]*2): raise ValueError('visual_resolution_limit')
        if item['mime'] != 'image/png' or not isinstance(item['sha256'], str) or not HEX.fullmatch(item['sha256']) or not isinstance(item['base64'], str) or len(item['base64']) > 699052: raise ValueError('visual_encoding_invalid')
        try: raw = base64.b64decode(item['base64'], validate=True)
        except Exception: raise ValueError('visual_encoding_invalid') from None
        if not 24 <= len(raw) <= 524288 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[8:16] != b'\x00\x00\x00\rIHDR' or struct.unpack('>II', raw[16:24]) != (w, h) or hashlib.sha256(raw).hexdigest() != item['sha256']: raise ValueError('visual_png_invalid')
        validate_png(raw, w, h)
        decoded.append(raw)
    return decoded

def infer_visual(engine, prompt, schema, images):
    """Inject exact files into the existing Codex transport; private dir always cleaned."""
    with tempfile.TemporaryDirectory(prefix='falsify-blue-images-') as directory:
        paths = []
        for i, raw in enumerate(images):
            p = Path(directory) / f'image-{i+1}.png'; p.write_bytes(raw); paths.append(str(p))
        transport = engine.transport
        def with_images(argv, **kwargs):
            if 'exec' in argv:
                argv = list(argv)
                index = argv.index('exec') + 1
                argv[index:index] = [part for path in paths for part in ('--image', path)]
            return transport(argv, **kwargs)
        engine.transport = with_images
        try: return engine.infer(prompt, schema)
        finally: engine.transport = transport

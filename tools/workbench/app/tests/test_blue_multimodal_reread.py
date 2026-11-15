"""Multi-provider visualEvidence (ClaudeBackend + opted-in stdio/wrapper) and two-stage auto-crop reread tests."""
import base64
import hashlib
import json
import struct
import sys
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import pymupdf
import blue_service as blue
import blue_structured_reread as bsr
import blue_visual
import cli_backend
import harness
from paper_evidence import EvidenceStore


def make_png(width=20, height=20, rgb=(10, 20, 30)):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    row = b'\x00' + bytes(rgb) * width
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>II', width, height) + b'\x08\x02\x00\x00\x00')
            + chunk(b'IDAT', zlib.compress(row * height))
            + chunk(b'IEND', b''))


PNG_A = make_png(20, 20, (10, 20, 30))
PNG_B = make_png(24, 16, (40, 50, 60))
SUBSCRIPTION = json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty'})
SCHEMA = {'type': 'object', 'properties': {'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
          'findings': {'type': 'array', 'maxItems': 0}}, 'required': ['status', 'findings'], 'additionalProperties': False}


def claude_visual_events(output):
    return [
        {'type': 'system', 'subtype': 'init', 'apiKeySource': 'none', 'mcp_servers': [], 'tools': ['StructuredOutput']},
        {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'ok'}]}},
        {'type': 'user', 'message': {'content': []}},
        {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': '', 'num_turns': 1,
         'structured_output': output, 'usage': {'input_tokens': 10, 'output_tokens': 5},
         'modelUsage': {'claude-opus-5-5': {}}, 'permission_denials': []},
    ]


def pdf_with_table_and_figures():
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=420)
    page.insert_text((40, 30), 'Table 1. Observed counts')
    for y in (45, 70, 95, 120):
        page.draw_line((40, y), (280, y))
    for x in (40, 160, 280):
        page.draw_line((x, 45), (x, 120))
    for x, y, text in [(50, 62, 'Group'), (170, 62, 'Count'), (50, 88, 'Control'), (170, 88, '7'), (50, 112, 'Treatment'), (170, 112, '11')]:
        page.insert_text((x, y), text)
    pix1 = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 60, 40), False)
    pix1.clear_with(130)
    page.insert_image(pymupdf.Rect(40, 150, 160, 230), stream=pix1.tobytes('png'))
    page.insert_text((40, 245), 'Figure 1. Primary assay trace')
    pix2 = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 50, 50), False)
    pix2.clear_with(200)
    page.insert_image(pymupdf.Rect(40, 270, 140, 350), stream=pix2.tobytes('png'))
    page.insert_text((40, 365), 'Figure 2. Secondary assay trace')
    raw = doc.tobytes()
    doc.close()
    return raw


def visual_item(raw, file_hash, source_hash, page=1, bbox=None):
    w, h = struct.unpack('>II', raw[16:24])
    bbox = bbox or [0, 0, w / 2, h / 2]
    return {'fileHash': file_hash, 'sourceHash': source_hash, 'page': page, 'bbox': bbox,
            'rotation': 0, 'width': w, 'height': h, 'mime': 'image/png',
            'sha256': hashlib.sha256(raw).hexdigest(), 'base64': base64.b64encode(raw).decode()}


def filler(n, tag):
    out, i = [], 0
    while sum(len(x) for x in out) < n:
        out.append(f'{tag} sentence {i}. ')
        i += 1
    return ''.join(out)


class ClaudeVisualTests(unittest.TestCase):
    def test_claude_infer_visual_stream_json_and_validation(self):
        calls = []
        def transport(command, **options):
            calls.append((command, options))
            if command[-3:] == ['auth', 'status', '--json']:
                return {'returncode': 0, 'stdout': SUBSCRIPTION}
            events = claude_visual_events({'status': 'ok', 'findings': []})
            return {'returncode': 0, 'stdout': '\n'.join(json.dumps(e) for e in events)}

        backend = cli_backend.ClaudeBackend(max_calls=4, transport=transport, executable=['claude.exe'])
        for bad in ([], [PNG_A] * 7, [b'not-png'], ['not-bytes'], None):
            res = backend.infer_visual('Check', SCHEMA, bad)
            self.assertEqual(res['error_code'], 'visual_images_invalid')
        self.assertEqual(calls, [])
        self.assertEqual(backend.calls, 0)

        res = backend.infer_visual('Inspect figures', SCHEMA, [PNG_A, PNG_B])
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(len(calls), 2)
        cmd, opts = calls[1]
        self.assertIn('--input-format', cmd)
        self.assertEqual(cmd[cmd.index('--input-format') + 1], 'stream-json')
        self.assertEqual(cmd[cmd.index('--tools') + 1], '')
        self.assertIn('--strict-mcp-config', cmd)
        self.assertTrue(opts['stdin'].endswith('\n'))
        self.assertEqual(opts['stdin'].count('\n'), 1)
        payload = json.loads(opts['stdin'])
        content = payload['message']['content']
        self.assertEqual(payload['type'], 'user')
        self.assertEqual(len(content), 3)
        self.assertEqual(content[0]['source']['data'], base64.b64encode(PNG_A).decode('ascii'))
        self.assertEqual(content[1]['source']['data'], base64.b64encode(PNG_B).decode('ascii'))
        self.assertEqual(content[2], {'type': 'text', 'text': 'Return only the requested JSON as structured output. Do not use tools.\nInspect figures'})

    def test_claude_and_opted_in_wrapper_visual_review(self):
        text = 'Short text.'
        src_hash = hashlib.sha256(text.encode()).hexdigest()
        fhash = 'ab' * 32
        imgs = [make_png(20 + 2 * i, 20, (i * 20, 40, 80)) for i in range(6)]
        vis = [visual_item(raw, fhash, src_hash, page=i + 1) for i, raw in enumerate(imgs)]

        class FakeClaude(cli_backend.ClaudeBackend):
            def __init__(self, **kwargs):
                def transport(command, **options):
                    if command[-3:] == ['auth', 'status', '--json']:
                        return {'returncode': 0, 'stdout': SUBSCRIPTION}
                    payload = json.loads(options['stdin'])
                    prompt_text = payload['message']['content'][-1]['text']
                    marker = 'Supplemental images in order, identified by these references: '
                    refs, _ = json.JSONDecoder().raw_decode(prompt_text.split(marker, 1)[1])
                    obs = [{'id': f'v{i+1}', 'sha256': r['sha256'], 'page': r['page'], 'bbox': r['bbox'],
                            'observation': 'Checked figure.', 'uncertainty': 'Unverified.'} for i, r in enumerate(refs)]
                    return {'returncode': 0, 'stdout': '\n'.join(json.dumps(e) for e in claude_visual_events(
                        {'status': 'ok', 'findings': [], 'visualObservations': obs}))}
                super().__init__(**kwargs, transport=transport, executable=['claude.exe'])

        req = {'schema': blue.VERSION, 'revision': 'r1', 'requestId': 'c6', 'sourceHash': src_hash,
               'segments': [{'id': 's0', 'label': 'p1', 'text': text}], 'maxCalls': 8, 'consent': True,
               'fileHash': fhash, 'visualConsent': True, 'visualEvidence': vis,
               'harness': {**harness.default('blue'), 'adapter': {'type': 'claude'}}}
        result = blue.run_review(req, lambda _: None, threading.Event(), blue.CodexBackend, FakeClaude)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(len(result['visualObservations']), 6)

        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'wrap.py'
            script.write_text(
                "import json, sys\n"
                "inv = json.loads(sys.stdin.read())\n"
                "marker = 'Supplemental images in order, identified by these references: '\n"
                "refs, _ = json.JSONDecoder().raw_decode(inv['prompt'].split(marker, 1)[1])\n"
                "obs = [{'id': 'w1', 'sha256': refs[0]['sha256'], 'page': refs[0]['page'], 'bbox': refs[0]['bbox'], 'observation': 'OK', 'uncertainty': 'Test'}]\n"
                "print(json.dumps({'status': 'ok', 'findings': [], 'visualObservations': obs}))\n",
                encoding='utf-8',
            )
            wrap_req = {**req, 'visualEvidence': vis[:1], 'executionConsent': True,
                        'harness': {**harness.default('blue'),
                                    'adapter': {'type': 'wrapper',
                                                'target': {'type': 'stdio', 'executable': sys.executable, 'args': [str(script)]},
                                                'input': {'mode': 'invocation'},
                                                'output': {'source': 'stdout', 'format': 'json'}},
                                    'settings': {'supportsVisualEvidence': True}}}
            wrap_res = blue.run_review(wrap_req, lambda _: None, threading.Event())
            self.assertEqual(wrap_res['visualObservations'][0]['id'], 'w1')


class AutoCropRereadTests(unittest.TestCase):
    def _prepare_store(self):
        raw = pdf_with_table_and_figures()
        fhash = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore()
        summary = store.prepare(raw, fhash)
        return store, summary['paperId'], fhash

    def test_two_stage_auto_crop_multichunk_and_budget_cap(self):
        store, pid, fhash = self._prepare_store()
        listing = store.list_items(pid)
        fig_ids = [item['id'] for item in listing['items'] if item['type'] == 'figure']
        self.assertGreaterEqual(len(fig_ids), 2)

        segs = [
            {'id': 's0', 'label': 'Intro', 'text': 'ANCHOR_S0 mark. ' + filler(24000, 's0')},
            {'id': 's1', 'label': 'Methods', 'text': filler(24000, 's1')},
        ]
        src_hash = hashlib.sha256('\n\n'.join(s['text'] for s in segs).encode()).hexdigest()
        structured = {
            'text': 'SOURCE_PDF_STRUCTURED_EVIDENCE_V1\nOmitted figures exist',
            'coverage': {'paperId': pid, 'fileHash': fhash, 'omittedIds': fig_ids, 'truncated': True},
        }

        class FakeMultimodal:
            def __init__(self, **kwargs):
                self.visual_calls = []
            def infer(self, prompt, schema):
                if schema is blue.SCAN:
                    return {'status': 'ok', 'response': {'status': 'ok', 'summary': 'Chunk summary.', 'evidence': []}}
                if schema is blue.SELECTION:
                    return {'status': 'ok', 'response': {'status': 'ok', 'targets': [
                        {'segmentId': 's0', 'anchor': f'evitem:{fig_ids[0]}', 'reason': 'inspect fig 1'},
                        {'segmentId': 's0', 'anchor': f'evitem:{fig_ids[1]}', 'reason': 'inspect fig 2'},
                    ]}}
                raise AssertionError('unexpected non-visual RESULT call')
            def infer_visual(self, prompt, schema, images):
                self.visual_calls.append((schema, len(images), prompt))
                marker = 'Supplemental images in order, identified by these references: '
                refs, _ = json.JSONDecoder().raw_decode(prompt.split(marker, 1)[1])
                obs = [{'id': f'auto{i}', 'sha256': r['sha256'], 'page': r['page'], 'bbox': r['bbox'],
                        'observation': 'Cropped figure checked.', 'uncertainty': 'Model judgment.'}
                       for i, r in enumerate(refs)]
                return {'status': 'ok', 'response': {'status': 'ok', 'findings': [], 'visualObservations': obs}}

        # Case 1: 0 initial visualEvidence -> 2 auto-cropped images attached to finalizing
        req0 = {'schema': blue.VERSION, 'revision': 'r1', 'requestId': 'ac0', 'sourceHash': src_hash,
                'segments': segs, 'maxCalls': 8, 'consent': True, 'fileHash': fhash,
                'paperEvidence': {'paperId': pid, 'fileHash': fhash}, 'paperEvidenceConsent': True,
                'visualConsent': True, 'autoVisualReread': True}
        with patch('paper_evidence_blue.context_for_review', return_value=structured), \
             patch('paper_evidence.default_store', store):
            res0 = blue.run_review(req0, lambda _: None, threading.Event(), FakeMultimodal)
        self.assertEqual(res0['coverage']['paperEvidence']['autoVisualCrops'], 2)
        self.assertEqual(res0['coverage']['paperEvidence']['selectedEvidenceItems'], fig_ids[:2])
        self.assertEqual(len(res0['visualObservations']), 2)
        for obs in res0['visualObservations']:
            self.assertEqual(obs['page'], 1)
            self.assertEqual(len(obs['bbox']), 4)

        # Case 2: 5 initial visualEvidence -> room for only min(2, 6 - 5) == 1 auto-crop
        five_imgs = [visual_item(make_png(20 + 2 * i, 20, (i * 30, 10, 20)), fhash, src_hash, page=1) for i in range(5)]
        req5 = {**req0, 'requestId': 'ac5', 'visualEvidence': five_imgs}
        with patch('paper_evidence_blue.context_for_review', return_value=structured), \
             patch('paper_evidence.default_store', store):
            res5 = blue.run_review(req5, lambda _: None, threading.Event(), FakeMultimodal)
        self.assertEqual(res5['coverage']['paperEvidence']['autoVisualCrops'], 1)
        self.assertEqual(len(res5['visualObservations']), 6)

    def test_single_chunk_auto_crop_and_reread_items_budget(self):
        store, pid, fhash = self._prepare_store()
        text = 'Short paper.'
        src_hash = hashlib.sha256(text.encode()).hexdigest()

        class FakeSingleVisual:
            def __init__(self, **kwargs): pass
            def infer_visual(self, prompt, schema, images):
                marker = 'Supplemental images in order, identified by these references: '
                refs, _ = json.JSONDecoder().raw_decode(prompt.split(marker, 1)[1])
                obs = [{'id': f's{i}', 'sha256': r['sha256'], 'page': r['page'], 'bbox': r['bbox'],
                        'observation': 'Figure inspected.', 'uncertainty': 'Unverified.'}
                       for i, r in enumerate(refs)]
                return {'status': 'ok', 'response': {'status': 'ok', 'findings': [], 'visualObservations': obs}}

        req = {'schema': blue.VERSION, 'revision': 'r1', 'requestId': 'sc1', 'sourceHash': src_hash,
               'segments': [{'id': 's0', 'label': 'p1', 'text': text}], 'maxCalls': 4, 'consent': True,
               'fileHash': fhash, 'paperEvidence': {'paperId': pid, 'fileHash': fhash},
               'paperEvidenceConsent': True, 'visualConsent': True, 'autoVisualReread': True}
        with patch('paper_evidence.default_store', store):
            res = blue.run_review(req, lambda _: None, threading.Event(), FakeSingleVisual)
        self.assertGreaterEqual(res['coverage']['paperEvidence']['autoVisualCrops'], 1)
        self.assertLessEqual(res['coverage']['paperEvidence']['autoVisualCrops'], 2)
        self.assertEqual(len(res['visualObservations']), res['coverage']['paperEvidence']['autoVisualCrops'])

        # Budget bound check for format_reread_items (<= 12_000 chars)
        items = store.list_items(pid)['items']
        formatted = bsr.format_reread_items(pid, fhash, [x['id'] for x in items], store=store, max_chars=500)
        self.assertLessEqual(len(json.dumps(formatted, ensure_ascii=False)), 500)


if __name__ == '__main__':
    unittest.main()

"""Actual PDF -> authenticated companion -> prepared BLUE context; no paid model call."""
import base64
import hashlib
import http.client
import json
import sys
import subprocess
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import pymupdf
import server
import blue_service
import paper_evidence


def fixture():
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=400)
    page.insert_text((40, 35), 'Table 1. Observed counts')
    for y in (50, 80, 110, 140): page.draw_line((40, y), (280, y))
    for x in (40, 160, 280): page.draw_line((x, 50), (x, 140))
    for x, y, text in [(50, 70, 'Group'), (170, 70, 'Count'), (50, 100, 'Control'), (170, 100, '7'), (50, 130, 'Treatment'), (170, 130, '11')]:
        page.insert_text((x, y), text)
    page.insert_text((40, 175), 'The count was 9 in the treatment group.')
    pix = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 50, 40), False)
    pix.clear_with(140)
    page.insert_image(pymupdf.Rect(40, 200, 140, 280), stream=pix.tobytes('png'))
    page.insert_text((40, 300), 'Figure 1. Group illustration')
    raw = doc.tobytes()
    doc.close()
    return raw


class FakeBackend:
    prompts = []
    def __init__(self, **kwargs): pass
    def infer(self, prompt, schema):
        self.prompts.append(prompt)
        return {'status': 'ok', 'response': {'status': 'ok', 'findings': []}}


class PaperEvidenceIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.port = cls.http.server_port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.thread.join()

    def call(self, route, payload, auth=True, origin=None):
        headers = {'Content-Type': 'application/json'}
        if auth: headers.update({'Authorization': 'Bearer ' + server.TOKEN, 'Origin': origin or f'http://127.0.0.1:{self.port}'})
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        connection.request('POST', route, json.dumps(payload).encode(), headers)
        response = connection.getresponse(); raw = response.read(); connection.close()
        return response.status, json.loads(raw)

    def prepare(self):
        raw = fixture(); digest = hashlib.sha256(raw).hexdigest()
        code, summary = self.call('/api/paper/evidence/prepare', {'fileHash': digest, 'file': base64.b64encode(raw).decode()})
        self.assertEqual(code, 200, summary)
        self.assertEqual(summary['fileHash'], digest)
        return raw, digest, summary

    def test_auth_and_allowlisted_origins(self):
        for route in ('/api/paper/evidence/prepare', '/api/paper/evidence/query'):
            self.assertEqual(self.call(route, {}, auth=False)[0], 403)
            self.assertEqual(self.call(route, {}, origin='https://other.example')[0], 403)
            self.assertTrue(server.cors_route('POST', route))

    def test_real_cells_crop_and_blue_context(self):
        raw, digest, summary = self.prepare()
        pid = summary['paperId']
        self.assertGreaterEqual(summary['counts']['tables'], 1)
        self.assertGreaterEqual(summary['counts']['figures'], 1)
        code, listing = self.call('/api/paper/evidence/query', {'paperId': pid, 'operation': 'list', 'kind': 'table'})
        self.assertEqual(code, 200)
        table_id = listing['items'][0]['id']
        code, table = self.call('/api/paper/evidence/query', {'paperId': pid, 'operation': 'item', 'itemId': table_id})
        self.assertEqual(code, 200)
        cells = table['table']['cells']
        self.assertTrue(any(c['text'] == '11' for c in cells))
        self.assertTrue(any(c['text'] == 'Treatment' for c in cells))
        code, crop = self.call('/api/paper/evidence/query', {'paperId': pid, 'operation': 'render', 'pageIndex': 0, 'bbox': table['bbox']})
        self.assertEqual(code, 200)
        png = base64.b64decode(crop['data'])
        self.assertTrue(png.startswith(b'\x89PNG'))
        self.assertEqual(hashlib.sha256(png).hexdigest(), crop['sha256'])
        self.assertEqual(crop['fileHash'], digest)
        text = 'The count was 9 in the treatment group.'
        request = dict(schema=blue_service.VERSION, revision='evidence-r1', requestId='evidence-test', sourceHash=hashlib.sha256(text.encode()).hexdigest(), segments=[dict(id='s0', label='PDF p. 1', text=text)], maxCalls=8, consent=True, fileHash=digest, paperEvidence=dict(paperId=pid, fileHash=digest), paperEvidenceConsent=True)
        FakeBackend.prompts.clear()
        result = blue_service.run_review(request, lambda _: None, threading.Event(), FakeBackend)
        self.assertIn('paperEvidence', result['coverage'])
        self.assertIn('SOURCE_PDF_STRUCTURED_EVIDENCE_V1', FakeBackend.prompts[0])
        for literal in ('Treatment', '11', table_id): self.assertIn(literal, FakeBackend.prompts[0])
        self.assertNotIn('candidateRationales', FakeBackend.prompts[0])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)
        for broken in ({**request, 'paperEvidence': None}, {**request, 'paperEvidenceConsent': False}, {**request, 'fileHash': '0'*64}, {**request, 'paperEvidence': {**request['paperEvidence'], 'cells': []}}):
            with self.assertRaises(ValueError): blue_service.validate_request(broken)

    def test_text_companion_still_imports_without_optional_pdf_dependency(self):
        local = str(Path(__file__).resolve().parents[1] / 'local')
        child = "import sys; sys.path.insert(0,sys.argv[1]); sys.modules['pymupdf']=None; import server; assert server.paper_analysis_service.capability()['available'] is False; print('text_companion_ready')"
        checked = subprocess.run([sys.executable, '-c', child, local], capture_output=True, text=True, timeout=20)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertIn('text_companion_ready', checked.stdout)

    def test_hash_mismatch_and_query_fields(self):
        raw = fixture()
        self.assertEqual(self.call('/api/paper/evidence/prepare', {'fileHash': '0'*64, 'file': base64.b64encode(raw).decode()})[0], 400)
        self.assertEqual(self.call('/api/paper/evidence/query', {'paperId': 'unknown', 'operation': 'open', 'path': 'any'})[0], 400)
        _, _, summary = self.prepare()
        self.assertEqual(self.call('/api/paper/evidence/query', {'paperId': summary['paperId'], 'operation': 'status', 'gold': []})[0], 400)


if __name__ == '__main__': unittest.main()

"""Coordinated RED MCP, multimodal validation, JS core preservation, and PDF stealth self-audit tests."""
import base64
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import anyio
import pikepdf
import pymupdf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
TESTS = ROOT / 'app' / 'tests'
for folder in (LOCAL, TESTS):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))

from chart_shape_fixture import chart_pdf
from paper_evidence import EvidenceStore
from paper_red_mcp import build_server
from paper_stealth_audit import SCHEMA as STEALTH_SCHEMA, audit_pdf_stealth
from paper_visual_edit import export_visual
from test_paper_evidence import sample_pdf


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _png(color=(255, 255, 255), size=(80, 80)):
    im = Image.new('RGBA', size, color)
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()


class StealthAuditTests(unittest.TestCase):
    def setUp(self):
        self.raw = sample_pdf(pages=2)
        self.store = EvidenceStore()
        self.h = _sha(self.raw)
        self.summary = self.store.prepare(self.raw, self.h)
        self.pid = self.summary['paperId']

    def test_clean_table_cell_edit_passes_stealth_audit(self):
        table_meta = self.store.list_items(self.pid, kind='table')['items'][0]
        item = self.store.read_item(self.pid, table_meta['id'])
        cell = next(c for c in item['table']['cells'] if c['text'] == '5')
        res = export_visual({
            'schema': 'falsify.visual-edit-request.v1',
            'paperId': self.pid,
            'fileHash': self.h,
            'revision': 'r1',
            'operations': [{'id': 'c1', 'kind': 'table-cell', 'itemId': item['id'],
                            'row': cell['row'], 'column': cell['column'], 'before': '5', 'after': '9'}],
        }, store=self.store)
        edited = base64.b64decode(res['file'])
        audit = audit_pdf_stealth(self.raw, edited, modified_regions=[{'pageIndex': 0, 'bbox': cell['bbox']}])
        self.assertEqual(audit['schema'], STEALTH_SCHEMA)
        self.assertEqual(audit['sourceSha256'], self.h)
        self.assertEqual(audit['outputSha256'], _sha(edited))
        self.assertTrue(audit['checks']['metadataClean'])
        self.assertTrue(audit['checks']['pageCountPreserved'])
        self.assertTrue(audit['checks']['unmodifiedPagesIdentical'])
        self.assertTrue(audit['checks']['exteriorPixelsPreserved'])
        self.assertEqual(audit['seamMetrics'][0]['seamMaxDelta'], 0)
        self.assertNotEqual(audit['status'], 'detectable_artifact')

        # A stream-ordered or chart-shape edit has status == 'clean'
        chart_raw = chart_pdf()
        chart_audit = audit_pdf_stealth(chart_raw, chart_raw, modified_regions=[{'pageIndex': 0, 'bbox': [35, 40, 395, 278]}])
        self.assertEqual(chart_audit['status'], 'clean')
        self.assertTrue(all(chart_audit['checks'].values()))
        self.assertEqual(chart_audit['issues'], [])

    def test_metadata_and_xmp_leak_flagged_as_detectable_artifact(self):
        doc = pymupdf.open(stream=self.raw, filetype='pdf')
        doc.set_metadata({'title': 'Synthetic red-plan candidate', 'author': 'falsify'})
        doc.set_xml_metadata('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:description>rationale before after attack</dc:description></rdf:RDF></x:xmpmeta>')
        leaked = doc.tobytes()
        doc.close()
        audit = audit_pdf_stealth(self.raw, leaked, modified_regions=[])
        self.assertEqual(audit['status'], 'detectable_artifact')
        self.assertFalse(audit['checks']['metadataClean'])
        leaked_tokens = {i['token'] for i in audit['issues'] if i['code'] == 'metadata_leak'}
        self.assertTrue({'falsify', 'red-plan', 'attack', 'candidate', 'rationale', 'before', 'after'} <= leaked_tokens)

        # Custom pikepdf DocInfo key leak is also caught
        with pikepdf.Pdf.open(io.BytesIO(self.raw)) as pdf:
            pdf.docinfo['/RedPlanNote'] = 'falsify-attack'
            buf = io.BytesIO()
            pdf.save(buf)
        audit2 = audit_pdf_stealth(self.raw, buf.getvalue(), modified_regions=[])
        self.assertFalse(audit2['checks']['metadataClean'])

    def test_source_metadata_tokens_not_falsely_flagged(self):
        doc = pymupdf.open(stream=self.raw, filetype='pdf')
        doc.set_metadata({'title': 'Heart attack study before and after'})
        src_with_words = doc.tobytes()
        doc.close()
        audit = audit_pdf_stealth(src_with_words, src_with_words, modified_regions=[])
        self.assertTrue(audit['checks']['metadataClean'])
        self.assertEqual(audit['status'], 'clean')

    def test_page_count_and_unmodified_page_detected(self):
        doc = pymupdf.open(stream=self.raw, filetype='pdf')
        doc.new_page()
        more_pages = doc.tobytes()
        doc.close()
        audit = audit_pdf_stealth(self.raw, more_pages, modified_regions=[])
        self.assertEqual(audit['status'], 'detectable_artifact')
        self.assertFalse(audit['checks']['pageCountPreserved'])

        doc = pymupdf.open(stream=self.raw, filetype='pdf')
        doc[1].insert_text((80, 120), 'tampered page 2')
        touched_p2 = doc.tobytes()
        doc.close()
        audit2 = audit_pdf_stealth(self.raw, touched_p2, modified_regions=[{'pageIndex': 0, 'bbox': [72, 90, 172, 118]}])
        self.assertEqual(audit2['status'], 'detectable_artifact')
        self.assertFalse(audit2['checks']['unmodifiedPagesIdentical'])

    def test_reading_order_append_jump_flagged_warning(self):
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((72, 100), 'Top paragraph original line.')
        p.insert_text((72, 500), 'Bottom paragraph lower on the page.')
        src = doc.tobytes()
        doc.close()

        doc2 = pymupdf.open()
        p2 = doc2.new_page(width=595, height=842)
        p2.insert_text((72, 500), 'Bottom paragraph lower on the page.')
        p2.insert_text((72, 100), 'Top paragraph appended at stream end.')
        reordered = doc2.tobytes()
        doc2.close()

        audit = audit_pdf_stealth(src, reordered, modified_regions=[{'pageIndex': 0, 'bbox': [60, 80, 400, 130]}])
        self.assertFalse(audit['checks']['readingOrderOk'])
        self.assertEqual(audit['status'], 'warning')
        self.assertTrue(any(i['code'] == 'append_order_jump' for i in audit['issues']))

    def test_exterior_pixels_and_harsh_boundary_seam_detected(self):
        # 1. Exterior pixel damage inside 6pt crop outside bbox + 2pt
        doc = pymupdf.open(stream=self.raw, filetype='pdf')
        doc[0].draw_rect(pymupdf.Rect(275, 355, 277, 385), color=(0, 0, 0), fill=(0, 0, 0))
        ext_damaged = doc.tobytes()
        doc.close()
        audit = audit_pdf_stealth(self.raw, ext_damaged, modified_regions=[{'pageIndex': 0, 'bbox': [280, 350, 320, 390]}])
        self.assertFalse(audit['checks']['exteriorPixelsPreserved'])
        self.assertEqual(audit['status'], 'detectable_artifact')

        # 2. Harsh unblended solid gray rectangle strictly inside bbox creates seam discontinuity warning
        doc2 = pymupdf.open(stream=self.raw, filetype='pdf')
        bbox = [280, 350, 340, 410]
        doc2[0].draw_rect(pymupdf.Rect(*bbox), color=None, fill=(0.55, 0.55, 0.55))
        harsh = doc2.tobytes()
        doc2.close()
        audit2 = audit_pdf_stealth(self.raw, harsh, modified_regions=[{'pageIndex': 0, 'bbox': bbox}])
        self.assertTrue(audit2['checks']['exteriorPixelsPreserved'])
        self.assertGreater(audit2['seamMetrics'][0]['seamMaxDelta'], 40)
        self.assertEqual(audit2['status'], 'warning')
        self.assertTrue(any(i['code'] == 'boundary_seam_discontinuity' for i in audit2['issues']))


class CoordinatedRedMcpTests(unittest.TestCase):
    def test_node_core_preserves_occurrence_span_and_visual_targets(self):
        script = r"""
        const assert = require('node:assert/strict');
        const C = require('./app/dist/document-red-core.js');
        const text = 'Sample had p = 0.04 and replication also had p = 0.04.';
        const second = text.lastIndexOf('p = 0.04');
        const doc = { revision: 'r1', sourceHash: 'h1', segments: [{ id: 's0', label: 'p1', text }] };
        const cand = {
          id: 'c1', segmentId: 's0', level: 1, before: 'p = 0.04', after: 'p = 0.40', occurrence: 1,
          visualTargets: [{ kind: 'table-cell', itemId: 't1', row: 1, column: 1 }],
          rationale: 'Edit second occurrence',
          evidence: [{ segmentId: 's0', quote: 'replication also had p = 0.04', relation: 'Second match' }],
          uncertainty: null
        };
        const out = C.validateResponse(doc, { schema: C.VERSION, revision: 'r1', sourceHash: 'h1', status: 'ok', candidates: [cand] });
        assert.equal(out[0].offset, second);
        assert.equal(out[0].occurrence, 1);
        assert.equal(out[0].spanStart, second);
        assert.deepEqual(out[0].span, [second, second + 8]);
        assert.deepEqual(out[0].visualTargets, cand.visualTargets);
        out[0].selected = true;
        const p = C.patches(doc, out);
        assert.equal(p[0].offset, second);
        assert.equal(p[0].occurrence, 1);
        assert.deepEqual(p[0].visualTargets, cand.visualTargets);
        """
        proc = subprocess.run(['node', '-e', script], cwd=str(ROOT), capture_output=True, text=True, check=True)
        self.assertEqual(proc.returncode, 0)

    def test_stdio_mcp_roundtrip_tools_and_blind_export(self):
        raw = sample_pdf(pages=2)
        digest = _sha(raw)
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'paper.pdf'
            source.write_bytes(raw)

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[str(LOCAL / 'paper_red_mcp.py'), '--pdf', str(source)],
                    env={'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'},
                )
                with anyio.fail_after(60):
                    async with stdio_client(params) as (read, write):
                        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                            init = await session.initialize()
                            binding = json.loads(init.instructions.split('Selected PDF: ', 1)[1])
                            pid = binding['paperId']
                            self.assertEqual(binding['fileHash'], digest)
                            tools = {t.name for t in (await session.list_tools()).tools}
                            self.assertEqual(tools, {
                                'list_red_targets', 'scan_source_baseline', 'list_pdf_links',
                                'prepare_chart_scene', 'preview_coordinated_edits',
                                'export_coordinated_edits', 'audit_candidate_pdf',
                            })

                            targets_res = await session.call_tool('list_red_targets', {'paperId': pid})
                            self.assertFalse(targets_res.isError, targets_res)
                            targets = targets_res.structuredContent
                            self.assertGreaterEqual(len(targets['paragraphs']), 1)
                            self.assertEqual(len(targets['tables']), 1)
                            self.assertEqual(len(targets['figures']), 1)
                            tbl = targets['tables'][0]
                            cell = next(c for c in tbl['cells'] if c['text'] == '1')

                            ops = [{
                                'id': 't1', 'kind': 'table-cell', 'itemId': tbl['itemId'],
                                'row': cell['row'], 'column': cell['column'], 'before': '1', 'after': '-7.5',
                            }]
                            prev = await session.call_tool('preview_coordinated_edits', {
                                'paperId': pid, 'operations': ops, 'previewPageIndex': 0,
                            })
                            self.assertFalse(prev.isError, prev)
                            self.assertEqual(len([b for b in prev.content if b.type == 'image']), 1)
                            self.assertEqual(prev.structuredContent['appliedCount'], 1)
                            self.assertNotEqual(prev.structuredContent['stealthAudit']['status'], 'detectable_artifact')

                            # Also test region-replace / chart-redraw mapping via preview_coordinated_edits
                            fig = targets['figures'][0]
                            reg_ops = [{
                                'id': 'fig-1', 'kind': 'region-replace', 'pageIndex': fig['pageIndex'],
                                'bbox': fig['bbox'], 'png': base64.b64encode(_png((240, 240, 240))).decode('ascii'),
                            }]
                            reg_prev = await session.call_tool('preview_coordinated_edits', {
                                'paperId': pid, 'operations': reg_ops, 'previewPageIndex': 0,
                            })
                            self.assertFalse(reg_prev.isError, reg_prev)
                            self.assertEqual(reg_prev.structuredContent['appliedCount'], 1)

                            exp = await session.call_tool('export_coordinated_edits', {
                                'paperId': pid, 'operations': ops, 'requireCleanStealth': True,
                            })
                            self.assertFalse(exp.isError, exp)
                            exp_data = exp.structuredContent
                            exported_bytes = base64.b64decode(exp_data['pdfBase64'])
                            self.assertEqual(exp_data['outputSha256'], _sha(exported_bytes))
                            self.assertIn('record', exp_data)
                            with pymupdf.open(stream=exported_bytes, filetype='pdf') as d:
                                self.assertIn('-7.5', d[0].get_text())
                                self.assertNotIn('falsify', json.dumps(d.metadata).lower())

                            # Audit candidate PDF with leaked metadata + reject on foreign paperId
                            doc = pymupdf.open(stream=raw, filetype='pdf')
                            doc.set_metadata({'subject': 'falsify red-plan candidate'})
                            bad_pdf = doc.tobytes()
                            doc.close()
                            audit_res = await session.call_tool('audit_candidate_pdf', {
                                'paperId': pid, 'candidatePdfBase64': base64.b64encode(bad_pdf).decode('ascii'),
                            })
                            self.assertFalse(audit_res.isError, audit_res)
                            self.assertEqual(audit_res.structuredContent['status'], 'detectable_artifact')

                            foreign = await session.call_tool('list_red_targets', {'paperId': 'other'})
                            self.assertTrue(foreign.isError)

            anyio.run(run)
            self.assertEqual(source.read_bytes(), raw)

    def test_require_clean_stealth_rejects_artifact_and_prepare_chart_scene_works(self):
        raw = chart_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        server = build_server(store, pid, digest)

        # Verify prepare_chart_scene works via MCP tool manager
        prepare_fn = server._tool_manager._tools['prepare_chart_scene'].fn
        export_fn = server._tool_manager._tools['export_coordinated_edits'].fn

        async def run():
            scene_res = await prepare_fn(pid, 0, [35, 40, 395, 278])
            self.assertFalse(scene_res.isError, scene_res)
            scene = scene_res.structuredContent
            series = scene['series'][0]
            pt = series['points'][len(series['points']) // 2]
            ops = [{
                'id': 'shape-1',
                'kind': 'chart-shape',
                'plan': {
                    'sceneId': scene['sceneId'],
                    'revision': 1,
                    'operations': [{'id': 'd1', 'kind': 'deform', 'seriesId': series['id'],
                                    'center': [pt['x'], pt['y']], 'radius': 35, 'dx': 0, 'dy': -15}],
                },
            }]
            exp_res = await export_fn(pid, ops, requireCleanStealth=True)
            self.assertFalse(exp_res.isError, exp_res)
            self.assertEqual(exp_res.structuredContent['stealthAudit']['status'], 'clean')

            with patch('paper_red_mcp.audit_pdf_stealth', return_value={'status': 'detectable_artifact', 'checks': {}, 'issues': []}):
                rejected = await export_fn(pid, ops, requireCleanStealth=True)
                self.assertTrue(rejected.isError)
                self.assertEqual(rejected.structuredContent['error'], 'stealth_audit_failed')

        anyio.run(run)


if __name__ == '__main__':
    unittest.main()

"""Unit and MCP integration tests for RED Baseline Guard and lossless PDF /URI mutator."""
import base64
import hashlib
import sys
import unittest
from pathlib import Path

import anyio
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
TESTS = ROOT / 'app' / 'tests'
for folder in (LOCAL, TESTS):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))

import paper_blue_sensor as blue_sensor
from paper_evidence import EvidenceStore
from paper_red_mcp import build_server
from paper_stealth_audit import audit_blindness_leaks
from paper_uri_mutator import SCHEMA, list_pdf_uri_links, mutate_pdf_uri_links
from test_paper_evidence import sample_pdf


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _build_multi_link_pdf() -> bytes:
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 70), 'References', fontsize=12)
    p0.insert_text(
        (72, 100),
        '[1] Kim J, Park S. Deep learning biomarkers (2023). Nature. doi:10.1038/s41586-023-00001-1',
        fontsize=9.5,
    )
    p0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 88, 520, 106),
        'uri': 'https://doi.org/10.1038/s41586-023-00001-1',
    })
    p0.insert_text((72, 130), '[32] Alice B. Cardiac imaging cohort study. Science. 2021.', fontsize=9.5)
    p0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 118, 450, 136),
        'uri': 'https://doi.org/10.1126/science.abc1234',
    })
    p0.insert_text((72, 160), '[33] Bob C. Unrelated soil microbes analysis. Ecology. 2022.', fontsize=9.5)
    p0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 148, 450, 166),
        'uri': 'https://doi.org/10.1002/ecy.9999',
    })
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 80), 'Supplementary protocol at https://example.org/protocol', fontsize=10)
    p1.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 68, 360, 86),
        'uri': 'https://example.org/protocol',
    })
    raw = doc.tobytes()
    doc.close()
    return raw


def _build_flawed_source_pdf() -> bytes:
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 80), 'Baseline stat: t(28) = 2.50, p = 0.25 [9].', fontsize=10)
    p0.insert_text((72, 110), 'References', fontsize=12)
    p0.insert_text((72, 135), '[1] Alpha Study. doi:10.1000/alpha-study', fontsize=9.5)
    p0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 123, 350, 141),
        'uri': 'https://doi.org/10.1000/alpha-study',
    })
    p0.insert_text((72, 160), '[2] Beta Study. doi:10.1000/beta-study', fontsize=9.5)
    raw = doc.tobytes()
    doc.close()
    return raw


class PaperUriMutatorTests(unittest.TestCase):
    def test_list_and_mutate_links_pixel_identical_and_caught_by_blue_sensor(self):
        raw = _build_multi_link_pdf()
        listed = list_pdf_uri_links(raw)
        self.assertEqual(listed['schema'], SCHEMA)
        self.assertEqual(listed['linkCount'], 4)
        self.assertEqual(listed['links'][0]['linkId'], 'p0-a0')
        self.assertEqual(listed['links'][0]['pageIndex'], 0)
        self.assertEqual(listed['links'][0]['annotIndex'], 0)
        self.assertIn('10.1038/s41586-023-00001-1', listed['links'][0]['visibleText'])
        self.assertEqual(listed['links'][3]['linkId'], 'p1-a0')

        # W5 D2-1 (visible DOI mismatch) + W5 D2-3 (shared link hijack onto [32])
        edits = [
            {
                'linkId': 'p0-a0',
                'beforeUri': 'https://doi.org/10.1038/s41586-023-00001-1',
                'afterUri': 'https://doi.org/10.1038/s41586-019-99999-9',
                'rationale': 'D2-1 visible DOI vs embedded URI swap',
            },
            {
                'pageIndex': 0,
                'annotIndex': 2,
                'beforeUri': 'https://doi.org/10.1002/ecy.9999',
                'afterUri': 'https://doi.org/10.1126/science.abc1234',
                'rationale': 'D2-3 shared URI hijack',
            },
        ]
        mutated = mutate_pdf_uri_links(raw, edits, require_clean_stealth=True)
        self.assertEqual(mutated['schema'], SCHEMA)
        self.assertEqual(mutated['sourceSha256'], _sha(raw))
        self.assertEqual(mutated['outputSha256'], _sha(mutated['pdfBytes']))
        self.assertEqual(mutated['appliedCount'], 2)
        self.assertEqual(mutated['stealthAudit']['status'], 'clean')
        self.assertTrue(all(mutated['stealthAudit']['checks'].values()))

        # Verify 100% pixel identity across all pages
        with pymupdf.open(stream=raw, filetype='pdf') as d1, pymupdf.open(stream=mutated['pdfBytes'], filetype='pdf') as d2:
            self.assertEqual(len(d1), len(d2))
            for idx in range(len(d1)):
                p1 = d1[idx].get_pixmap(dpi=150, colorspace=pymupdf.csRGB, alpha=False)
                p2 = d2[idx].get_pixmap(dpi=150, colorspace=pymupdf.csRGB, alpha=False)
                arr1 = np.frombuffer(p1.samples, dtype=np.uint8).reshape(p1.height, p1.width, 3)
                arr2 = np.frombuffer(p2.samples, dtype=np.uint8).reshape(p2.height, p2.width, 3)
                self.assertTrue(np.array_equal(arr1, arr2), f'page {idx} pixels differed')

        # Roundtrip proof: BLUE Layer 0 sensor catches BOTH W5 D2-1 and W5 D2-3 on the mutated PDF
        store = EvidenceStore()
        out_bytes = mutated['pdfBytes']
        summary = store.prepare(out_bytes, _sha(out_bytes))
        blue_report = blue_sensor.run_blue_sensor(summary['paperId'], summary['fileHash'], store=store)
        kinds = {s['kind'] for s in blue_report['signals']}
        self.assertIn('uri_visible_doi_mismatch', kinds)
        self.assertIn('duplicate_reference_uri_or_doi', kinds)
        self.assertEqual(blue_report['uriLinks']['mismatchCount'], 1)
        self.assertGreaterEqual(blue_report['uriLinks']['sharedTargetCount'], 1)
        self.assertTrue(audit_blindness_leaks(raw, out_bytes)['clean'])

    def test_blindness_gate_and_before_mismatch_rejections(self):
        raw = _build_multi_link_pdf()
        bad_urls = [
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///etc/passwd',
            'mailto:test@example.com',
            'https://doi.org/10.1000/intentional-error',
            'https://doi.org/10.1000/fabricated-ref',
            'https://doi.org/10.1000/fake-doi-1',
            'https://example.org/red-team/marker',
            'https://example.org/injected-defect',
            'https://example.org/변조',
            'https://example.org/가짜',
            'https://example.org/함정',
            'https://example.org/has space',
            'https://example.org/' + ('a' * 1020),
        ]
        for bad in bad_urls:
            with self.assertRaises(ValueError, msg=f'should reject {bad}'):
                mutate_pdf_uri_links(raw, [{'pageIndex': 0, 'annotIndex': 0, 'afterUri': bad}])

        with self.assertRaises(ValueError):
            mutate_pdf_uri_links(raw, [{
                'pageIndex': 0, 'annotIndex': 0,
                'beforeUri': 'https://doi.org/10.1000/wrong-before',
                'afterUri': 'https://doi.org/10.1000/clean-target',
            }])

    def test_mcp_baseline_scan_list_links_and_coordinated_uri_export(self):
        raw = _build_flawed_source_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        server = build_server(store, pid, digest)

        scan_fn = server._tool_manager._tools['scan_source_baseline'].fn
        links_fn = server._tool_manager._tools['list_pdf_links'].fn
        preview_fn = server._tool_manager._tools['preview_coordinated_edits'].fn
        export_fn = server._tool_manager._tools['export_coordinated_edits'].fn

        base_res = scan_fn(pid)
        self.assertFalse(base_res.isError, base_res)
        base_kinds = {s['kind'] for s in base_res.structuredContent['signals']}
        self.assertIn('stat_pvalue_mismatch', base_kinds)
        self.assertIn('citation_index_out_of_range', base_kinds)

        all_links = links_fn(pid)
        self.assertFalse(all_links.isError, all_links)
        self.assertEqual(all_links.structuredContent['linkCount'], 1)
        self.assertEqual(links_fn(pid, pageIndex=0).structuredContent['linkCount'], 1)
        self.assertTrue(links_fn(pid, pageIndex=9).isError)

        ops = [{
            'id': 'uri-1',
            'kind': 'uri-link',
            'pageIndex': 0,
            'annotIndex': 0,
            'beforeUri': 'https://doi.org/10.1000/alpha-study',
            'afterUri': 'https://doi.org/10.1000/beta-study',
            'rationale': 'D2-1 swap',
        }]

        async def run():
            prev = await preview_fn(pid, ops, previewPageIndex=0)
            self.assertFalse(prev.isError, prev)
            self.assertEqual(prev.structuredContent['appliedCount'], 1)
            self.assertEqual(prev.structuredContent['stealthAudit']['status'], 'clean')

            exp = await export_fn(pid, ops, requireCleanStealth=True)
            self.assertFalse(exp.isError, exp)
            data = exp.structuredContent
            self.assertEqual(data['stealthAudit']['status'], 'clean')
            ch = data['record']['changes'][0]
            self.assertEqual(ch['defectFamily'], 'D2')
            self.assertEqual(ch['subtype'], 'identifier-hijack')
            self.assertEqual(ch['afterUri'], 'https://doi.org/10.1000/beta-study')
            out_bytes = base64.b64decode(data['pdfBase64'])
            self.assertEqual(list_pdf_uri_links(out_bytes)['links'][0]['uri'], 'https://doi.org/10.1000/beta-study')
            self.assertTrue(audit_blindness_leaks(raw, out_bytes)['clean'])

        anyio.run(run)

    def test_mcp_combined_table_cell_and_uri_link_export(self):
        # Build a PDF that has both a table (from sample_pdf) and a /URI link
        base_raw = sample_pdf(pages=1)
        doc = pymupdf.open(stream=base_raw, filetype='pdf')
        doc[0].insert_text((72, 600), '[1] Test Ref. doi:10.1000/orig', fontsize=9.5)
        doc[0].insert_link({
            'kind': pymupdf.LINK_URI,
            'from': pymupdf.Rect(70, 588, 300, 606),
            'uri': 'https://doi.org/10.1000/orig',
        })
        raw = doc.tobytes()
        doc.close()

        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        server = build_server(store, pid, digest)

        targets = server._tool_manager._tools['list_red_targets'].fn(pid).structuredContent
        tbl = targets['tables'][0]
        cell = next(c for c in tbl['cells'] if c['text'] == '5')
        links = server._tool_manager._tools['list_pdf_links'].fn(pid).structuredContent
        lnk = links['links'][0]

        ops = [
            {
                'id': 't1', 'kind': 'table-cell', 'itemId': tbl['itemId'],
                'row': cell['row'], 'column': cell['column'], 'before': '5', 'after': '9',
            },
            {
                'id': 'u1', 'kind': 'uri-link',
                'pageIndex': lnk['pageIndex'], 'annotIndex': lnk['annotIndex'],
                'beforeUri': lnk['uri'], 'afterUri': 'https://doi.org/10.1000/hijacked',
            },
        ]

        async def run():
            exp = await server._tool_manager._tools['export_coordinated_edits'].fn(pid, ops, requireCleanStealth=True)
            self.assertFalse(exp.isError, exp)
            data = exp.structuredContent
            self.assertNotEqual(data['stealthAudit']['status'], 'detectable_artifact')
            kinds = {c.get('kind', 'table-cell') for c in data['record']['changes']}
            self.assertIn('uri-link', kinds)
            out_bytes = base64.b64decode(data['pdfBase64'])
            self.assertEqual(list_pdf_uri_links(out_bytes)['links'][0]['uri'], 'https://doi.org/10.1000/hijacked')
            self.assertTrue(audit_blindness_leaks(raw, out_bytes)['clean'])

        anyio.run(run)


if __name__ == '__main__':
    unittest.main()

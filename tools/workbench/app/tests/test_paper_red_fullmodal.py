"""Unit and stdio MCP integration tests for full-modal coordinated RED editing."""
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

import anyio
import pymupdf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
TESTS = ROOT / 'app' / 'tests'
for folder in (LOCAL, TESTS):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))

from paper_evidence import EvidenceStore  # noqa: E402
from paper_red_mcp import GOLD_LEDGER_SCHEMA, build_server  # noqa: E402
from paper_stealth_audit import audit_blindness_leaks, audit_pdf_stealth  # noqa: E402
from paper_text_span_mutator import (  # noqa: E402
    FORBIDDEN_RED_KEYS,
    SCHEMA as TEXT_SPAN_SCHEMA,
    SpanMutationError,
    list_pdf_text_spans,
    load_red_supplements,
    mutate_pdf_text_spans,
)
from paper_uri_mutator import list_pdf_uri_links  # noqa: E402
from test_paper_evidence import draw_table  # noqa: E402


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _fullmodal_pdf() -> bytes:
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 72), 'Table 1. Primary outcomes across groups', fontsize=11, fontname='helv')
    draw_table(p0)
    p0.insert_text(
        (72, 230),
        'Primary cohort showed p = 0.04 and AUC = 0.94 in training.',
        fontsize=10,
        fontname='helv',
    )
    p0.insert_text(
        (72, 250),
        'Validation cohort also showed p = 0.04 with N = 240 patients.',
        fontsize=10,
        fontname='helv',
    )
    p0.insert_text(
        (72, 290),
        '[1] Kim J. Biomarker validation study. doi:10.1000/orig-ref',
        fontsize=9.5,
        fontname='helv',
    )
    p0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 278, 420, 296),
        'uri': 'https://doi.org/10.1000/orig-ref',
    })
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 80), 'Supplementary methods remain untouched on page 2.', fontsize=10, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _flawed_baseline_pdf() -> bytes:
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 80), 'Preexisting defect: t(28) = 2.50, p = 0.25 in cohort A.', fontsize=10, fontname='helv')
    p0.insert_text((72, 110), 'Clean sentence: accuracy = 0.88 in cohort B.', fontsize=10, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _assert_no_forbidden_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in FORBIDDEN_RED_KEYS:
                raise AssertionError(f'Forbidden RED key leaked: {k}')
            _assert_no_forbidden_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_forbidden_keys(item)


class FullModalRedMcpTests(unittest.TestCase):
    def test_stdio_mcp_fullmodal_coordinated_export_and_gold_ledger(self):
        raw = _fullmodal_pdf()
        digest = _sha(raw)
        supp_text = 'cohort,N,AUC\nmain,240,0.94\n'
        with tempfile.TemporaryDirectory() as folder:
            pdf_path = Path(folder) / 'paper.pdf'
            supp_path = Path(folder) / 'Table_S1.csv'
            pdf_path.write_bytes(raw)
            supp_path.write_text(supp_text, encoding='utf-8')

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[
                        str(LOCAL / 'paper_red_mcp.py'),
                        '--pdf', str(pdf_path),
                        '--supplement', str(supp_path),
                    ],
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
                            self.assertIn('list_text_spans', tools)
                            self.assertIn('list_red_supplements', tools)

                            spans_res = await session.call_tool('list_text_spans', {
                                'paperId': pid, 'pageIndex': 0, 'query': 'p = 0.04',
                            })
                            self.assertFalse(spans_res.isError, spans_res)
                            spans = spans_res.structuredContent['spans']
                            self.assertEqual(len(spans), 2)
                            self.assertEqual(spans[0]['pageIndex'], 0)
                            self.assertEqual(len(spans[0]['bbox']), 4)

                            supp_res = await session.call_tool('list_red_supplements', {'paperId': pid})
                            self.assertFalse(supp_res.isError, supp_res)
                            supp_list = supp_res.structuredContent
                            self.assertEqual(supp_list['supplementCount'], 1)
                            self.assertEqual(supp_list['supplements'][0]['name'], 'Table_S1.csv')
                            self.assertNotIn(folder, json.dumps(supp_list))

                            targets = (await session.call_tool('list_red_targets', {'paperId': pid})).structuredContent
                            tbl = targets['tables'][0]
                            cell = next(c for c in tbl['cells'] if c['text'] == '5')
                            links = (await session.call_tool('list_pdf_links', {'paperId': pid})).structuredContent
                            lnk = links['links'][0]

                            ops = [
                                {
                                    'id': 'op-text-1',
                                    'kind': 'text-span',
                                    'pageIndex': 0,
                                    'before': 'p = 0.04',
                                    'after': 'p = 0.41',
                                    'occurrence': 1,
                                    'world': 'W3',
                                    'family': 'D1',
                                    'difficulty': 'L3',
                                    'rationale': 'Flip validation p-value while leaving primary intact',
                                },
                                {
                                    'id': 'op-cell-1',
                                    'kind': 'table-cell',
                                    'itemId': tbl['itemId'],
                                    'row': cell['row'],
                                    'column': cell['column'],
                                    'before': '5',
                                    'after': '9',
                                    'world': 'W1',
                                    'family': 'D1',
                                    'difficulty': 'L1',
                                    'rationale': 'Perturb table cell total',
                                },
                                {
                                    'id': 'op-uri-1',
                                    'kind': 'uri-link',
                                    'linkId': lnk['linkId'],
                                    'beforeUri': 'https://doi.org/10.1000/orig-ref',
                                    'afterUri': 'https://doi.org/10.1000/other-study',
                                    'world': 'W5',
                                    'family': 'D2',
                                    'difficulty': 'L2',
                                    'rationale': 'Hijack reference URI target',
                                },
                                {
                                    'id': 'op-supp-1',
                                    'kind': 'supplement-edit',
                                    'name': 'Table_S1.csv',
                                    'before': 'main,240,0.94',
                                    'after': 'main,240,0.71',
                                    'world': 'W4',
                                    'family': 'D1',
                                    'difficulty': 'L4',
                                    'rationale': 'Cross-document AUC mismatch with supplement CSV',
                                },
                            ]

                            prev = await session.call_tool('preview_coordinated_edits', {
                                'paperId': pid, 'operations': ops, 'previewPageIndex': 0,
                            })
                            self.assertFalse(prev.isError, prev)
                            self.assertEqual(prev.structuredContent['appliedCount'], 4)
                            self.assertNotEqual(prev.structuredContent['stealthAudit']['status'], 'detectable_artifact')
                            self.assertEqual(len([b for b in prev.content if b.type == 'image']), 1)

                            exp = await session.call_tool('export_coordinated_edits', {
                                'paperId': pid, 'operations': ops, 'requireCleanStealth': True,
                            })
                            self.assertFalse(exp.isError, exp)
                            data = exp.structuredContent
                            out_bytes = base64.b64decode(data['pdfBase64'])
                            self.assertEqual(data['outputSha256'], _sha(out_bytes))
                            self.assertNotEqual(data['stealthAudit']['status'], 'detectable_artifact')
                            self.assertTrue(data['stealthAudit']['checks']['exteriorPixelsPreserved'])
                            self.assertTrue(data['stealthAudit']['checks']['unmodifiedPagesIdentical'])
                            self.assertTrue(audit_blindness_leaks(raw, out_bytes)['clean'])

                            with pymupdf.open(stream=out_bytes, filetype='pdf') as out_doc:
                                p0_text = out_doc[0].get_text()
                                self.assertIn('p = 0.41', p0_text)
                                self.assertIn('p = 0.04', p0_text)
                                self.assertIn('9', p0_text)
                                meta_dump = json.dumps(out_doc.metadata or {}).lower()
                                for tok in ('falsify', 'red-plan', 'rationale', 'gold'):
                                    self.assertNotIn(tok, meta_dump)
                            self.assertEqual(
                                list_pdf_uri_links(out_bytes)['links'][0]['uri'],
                                'https://doi.org/10.1000/other-study',
                            )

                            blind_supps = data['blindSupplements']
                            self.assertEqual(len(blind_supps), 1)
                            _assert_no_forbidden_keys(blind_supps)
                            self.assertEqual(blind_supps[0]['name'], 'Table_S1.csv')
                            self.assertIn('main,240,0.71', blind_supps[0]['text'])
                            self.assertEqual(
                                base64.b64decode(blind_supps[0]['contentBase64']).decode('utf-8'),
                                blind_supps[0]['text'],
                            )
                            self.assertEqual(blind_supps[0]['sha256'], _sha(blind_supps[0]['text'].encode('utf-8')))

                            ledger = data['goldLedger']
                            self.assertEqual(ledger['schema'], GOLD_LEDGER_SCHEMA)
                            self.assertEqual(ledger['sourceSha256'], digest)
                            self.assertEqual(ledger['blindPdfSha256'], data['outputSha256'])
                            self.assertTrue(ledger['stealthPass'])
                            self.assertEqual(len(ledger['defects']), 4)
                            by_id = {d['defectId']: d for d in ledger['defects']}
                            self.assertEqual(by_id['op-text-1']['world'], 'W3')
                            self.assertEqual(by_id['op-text-1']['family'], 'D1')
                            self.assertEqual(by_id['op-text-1']['difficulty'], 'L3')
                            self.assertIsNotNone(by_id['op-text-1']['bbox'])
                            self.assertEqual(by_id['op-cell-1']['itemId'], tbl['itemId'])
                            self.assertEqual(by_id['op-supp-1']['supplementName'], 'Table_S1.csv')
                            self.assertEqual(by_id['op-uri-1']['after'], 'https://doi.org/10.1000/other-study')

            anyio.run(run)
            self.assertEqual(pdf_path.read_bytes(), raw)
            self.assertEqual(supp_path.read_text(encoding='utf-8'), supp_text)

    def test_self_healing_errors_for_text_span_and_supplement(self):
        raw = _fullmodal_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        supps = [{'supplementId': 'supp-0', 'name': 'notes.md', 'text': 'Cohort N = 240\nAUC = 0.94\n'}]
        server = build_server(store, pid, digest, supplements=supps)
        export_fn = server._tool_manager._tools['export_coordinated_edits'].fn
        list_supps_fn = server._tool_manager._tools['list_red_supplements'].fn

        self.assertEqual(list_supps_fn(pid).structuredContent['supplementCount'], 1)
        empty_server = build_server(store, pid, digest)
        self.assertEqual(
            empty_server._tool_manager._tools['list_red_supplements'].fn(pid).structuredContent['supplementCount'],
            0,
        )

        async def run():
            typo_res = await export_fn(pid, [{
                'id': 'bad-text',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'p = 0.045 typo',
                'after': 'p = 0.41',
            }])
            self.assertTrue(typo_res.isError)
            sc = typo_res.structuredContent
            self.assertEqual(sc['error'], 'text_span_not_found')
            self.assertEqual(sc['pageIndex'], 0)
            self.assertTrue(sc['recoveryHint'])
            self.assertGreaterEqual(len(sc['nearestCandidates']), 1)
            self.assertTrue(any('0.04' in c['text'] for c in sc['nearestCandidates']))

            occ_res = await export_fn(pid, [{
                'id': 'bad-occ',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'p = 0.04',
                'after': 'p = 0.41',
                'occurrence': 5,
            }])
            self.assertTrue(occ_res.isError)
            self.assertEqual(occ_res.structuredContent['error'], 'text_span_occurrence_out_of_range')
            self.assertEqual(occ_res.structuredContent['matchCount'], 2)

            room_res = await export_fn(pid, [{
                'id': 'no-room',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'p = 0.04',
                'after': 'this replacement phrase is much too long to fit inside inline span bounds without colliding',
            }])
            self.assertTrue(room_res.isError)
            self.assertEqual(room_res.structuredContent['error'], 'text_span_no_room')
            self.assertTrue(room_res.structuredContent['recoveryHint'])

            supp_err = await export_fn(pid, [{
                'id': 'bad-supp',
                'kind': 'supplement-edit',
                'supplementId': 'supp-0',
                'before': 'AUC = 0.999',
                'after': 'AUC = 0.70',
            }])
            self.assertTrue(supp_err.isError)
            self.assertEqual(supp_err.structuredContent['error'], 'supplement_before_not_found')
            self.assertTrue(any('0.94' in c['text'] for c in supp_err.structuredContent['nearestCandidates']))

        anyio.run(run)

    def test_baseline_overlaps_warning_on_preexisting_layer0_stat_defect(self):
        raw = _flawed_baseline_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        server = build_server(store, pid, digest)
        export_fn = server._tool_manager._tools['export_coordinated_edits'].fn

        async def run():
            overlap_res = await export_fn(pid, [{
                'id': 'hit-baseline',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'p = 0.25',
                'after': 'p = 0.01',
            }])
            self.assertFalse(overlap_res.isError, overlap_res)
            overlaps = overlap_res.structuredContent['baselineOverlaps']
            self.assertEqual(len(overlaps), 1)
            self.assertEqual(overlaps[0]['operationId'], 'hit-baseline')
            self.assertEqual(overlaps[0]['signals'][0]['kind'], 'stat_pvalue_mismatch')

            clean_res = await export_fn(pid, [{
                'id': 'clean-edit',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'accuracy = 0.88',
                'after': 'accuracy = 0.61',
            }])
            self.assertFalse(clean_res.isError, clean_res)
            self.assertEqual(clean_res.structuredContent['baselineOverlaps'], [])

        anyio.run(run)

    def test_text_span_font_scaling_and_blindness_rejection(self):
        raw = _fullmodal_pdf()
        spans = list_pdf_text_spans(raw, page_index=0, query='AUC = 0.94')['spans']
        self.assertEqual(len(spans), 1)

        mutated = mutate_pdf_text_spans(raw, [{
            'id': 'scale-1',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': 'p = 0.04',
            'after': 'p = 0.0412',
            'occurrence': 0,
        }])
        self.assertEqual(mutated['schema'], TEXT_SPAN_SCHEMA)
        self.assertEqual(mutated['appliedCount'], 1)
        ch = mutated['changes'][0]
        self.assertLessEqual(ch['fontSize'], ch['originalFontSize'])
        self.assertGreaterEqual(ch['fontSize'], max(5.5, ch['originalFontSize'] * 0.78))
        audit = audit_pdf_stealth(raw, mutated['pdfBytes'], modified_regions=mutated['modifiedRegions'])
        self.assertNotEqual(audit['status'], 'detectable_artifact')
        self.assertTrue(audit['checks']['exteriorPixelsPreserved'])

        with self.assertRaises(SpanMutationError) as ctx:
            mutate_pdf_text_spans(raw, [{
                'id': 'leak-1',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'p = 0.04',
                'after': 'falsify-red',
            }])
        self.assertEqual(ctx.exception.code, 'text_span_blindness_rejected')

        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / 'evil.exe'
            bad.write_bytes(b'MZ')
            with self.assertRaises(ValueError):
                load_red_supplements([bad])

    def test_ccn_gate_on_new_and_modified_python_modules(self):
        parser_script = ROOT / 'tools' / 'quality' / 'python-functions.py'
        for rel in ('app/local/paper_text_span_mutator.py', 'app/local/paper_red_mcp.py'):
            src = (ROOT / rel).read_bytes()
            proc = subprocess.run(
                [sys.executable, str(parser_script)],
                input=src,
                capture_output=True,
                check=True,
            )
            funcs = json.loads(proc.stdout.decode('utf-8'))
            over = [f for f in funcs if f['ccn'] > 15]
            self.assertEqual(over, [], f'{rel} has functions exceeding CCN 15: {over}')


if __name__ == '__main__':
    unittest.main()

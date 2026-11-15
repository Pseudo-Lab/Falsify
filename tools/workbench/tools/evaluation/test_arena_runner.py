"""Unit and CLI tests for headless arena evaluator and blind-bundle verifier."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import arena_runner as mod  # noqa: E402

CLI_PATH = EVAL_DIR / 'arena_runner.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'

try:
    import pymupdf  # type: ignore
except ImportError:
    pymupdf = None


def _build_pdf_bytes(
    title: str = 'Clean Clinical Trial',
    xmp: str | None = None,
    annot_text: str | None = None,
    annot_title: str | None = None,
    widget_value: str | None = None,
    link_uri: str | None = None,
) -> bytes:
    if pymupdf is None:
        return _build_raw_pdf_bytes(title=title, xmp=xmp, annot_text=annot_text, annot_title=annot_title)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), 'Clinical outcome report body text.')
    doc.set_metadata({'title': title, 'author': 'Trial Consortium'})
    if xmp:
        doc.set_xml_metadata(xmp)
    if annot_text or annot_title:
        annot = page.add_text_annot((100, 120), annot_text or 'note')
        info = dict(annot.info or {})
        if annot_title:
            info['title'] = annot_title
        annot.set_info(info)
        annot.update()
    if widget_value:
        widget = pymupdf.Widget()
        widget.rect = pymupdf.Rect(72, 160, 260, 190)
        widget.field_name = 'reviewer_notes'
        widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.field_value = widget_value
        page.add_widget(widget)
    if link_uri:
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(72, 200, 220, 220), 'uri': link_uri})
    raw = doc.tobytes()
    doc.close()
    return raw


def _build_raw_pdf_bytes(
    title: str = 'Clean Clinical Trial',
    xmp: str | None = None,
    annot_text: str | None = None,
    annot_title: str | None = None,
    comment: str | None = None,
    widget_value: str | None = None,
) -> bytes:
    parts = [b'%PDF-1.4\n']
    if comment:
        parts.append(f'% {comment}\n'.encode('utf-8'))
    parts.append(b'1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n')
    parts.append(b'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n')
    parts.append(b'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n')
    parts.append(f'4 0 obj << /Title ({title}) /Author (Trial Consortium) >> endobj\n'.encode('utf-8'))
    if xmp:
        parts.append(f'5 0 obj << /Type /Metadata /Subtype /XML >> stream\n{xmp}\nendstream endobj\n'.encode('utf-8'))
    if annot_text or annot_title:
        parts.append(
            f'6 0 obj << /Type /Annot /Subtype /Popup /Contents ({annot_text or ""}) /T ({annot_title or ""}) >> endobj\n'.encode('utf-8')
        )
    if widget_value:
        parts.append(
            f'7 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (notes) /V ({widget_value}) >> endobj\n'.encode('utf-8')
        )
    parts.append(b'trailer << /Root 1 0 R /Info 4 0 R >>\n%%EOF\n')
    return b''.join(parts)


class BlindVerificationTests(unittest.TestCase):
    def test_clean_pdf_and_link_only_pass(self):
        pdf = _build_pdf_bytes(
            title='Randomized Cardiology Study',
            link_uri='https://doi.org/10.1000/falsify-link-uri-ignored',
        )
        res = mod.verify_blind_bundle(
            pdf,
            blind_supplements=[{'name': 'Table_S1.csv', 'text': 'arm,n,events\nA,100,12\nB,100,18\n'}],
        )
        self.assertEqual(res['schema'], mod.BLIND_SCHEMA)
        self.assertTrue(res['blindClean'])
        self.assertEqual(res['leakCount'], 0)
        self.assertEqual(res['supplementCount'], 1)
        self.assertEqual(len(res['pdfSha256']), 64)

    def test_docinfo_xmp_popup_widget_comment_and_supplement_leaks_fail(self):
        xmp_leak = '<x:xmpmeta><rdf:RDF><dc:description>why_hard: hidden drift</dc:description></rdf:RDF></x:xmpmeta>'
        pdf_docinfo = _build_pdf_bytes(title='Paper falsify red-plan')
        res_doc = mod.verify_blind_bundle(pdf_docinfo)
        self.assertFalse(res_doc['blindClean'])
        self.assertTrue(any(lk['surface'] == 'docinfo' for lk in res_doc['leaks']))

        pdf_xmp = _build_pdf_bytes(xmp=xmp_leak)
        res_xmp = mod.verify_blind_bundle(pdf_xmp)
        self.assertFalse(res_xmp['blindClean'])
        self.assertTrue(any(lk['surface'] == 'xmp' for lk in res_xmp['leaks']))

        pdf_annot = _build_pdf_bytes(annot_text='candidateRationales injected', annot_title='red-plan')
        res_annot = mod.verify_blind_bundle(pdf_annot)
        self.assertFalse(res_annot['blindClean'])
        self.assertTrue(any(lk['surface'] == 'annotation' for lk in res_annot['leaks']))

        pdf_widget = _build_pdf_bytes(widget_value='stealth_audit internal note')
        res_widget = mod.verify_blind_bundle(pdf_widget)
        self.assertFalse(res_widget['blindClean'])
        self.assertTrue(any(lk['surface'] == 'acroform' for lk in res_widget['leaks']))

        pdf_comment = _build_raw_pdf_bytes(comment='generated by falsify gold_ledger')
        res_comment = mod.verify_blind_bundle(pdf_comment)
        self.assertFalse(res_comment['blindClean'])
        self.assertTrue(any(lk['surface'] == 'trailer_comment' for lk in res_comment['leaks']))

        clean_pdf = _build_pdf_bytes()
        bad_supplements = [
            {'name': 'leak.json', 'text': json.dumps({'items': [{'defectId': 'g1', 'before': '10', 'after': '20'}]})},
            {'name': 'notes.txt', 'bytes': b'{"goldLedger": [], "why_hard": "cross-table"}'},
        ]
        res_sup = mod.verify_blind_bundle(clean_pdf, blind_supplements=bad_supplements)
        self.assertFalse(res_sup['blindClean'])
        tokens = {lk['token'].lower() for lk in res_sup['leaks']}
        self.assertTrue({'defectid', 'before', 'after', 'goldledger', 'why_hard'}.issubset(tokens))

    def test_source_inherited_before_and_after_title_is_exempted(self):
        source = _build_pdf_bytes(title='Heart attack before and after')
        blind_clean = _build_pdf_bytes(title='Heart attack before and after')
        res = mod.verify_blind_bundle(blind_clean, source_pdf_bytes=source)
        self.assertTrue(res['blindClean'])
        self.assertEqual(res['leakCount'], 0)

        with mock.patch.object(mod, 'pymupdf', None):
            raw_src = _build_raw_pdf_bytes(title='Heart attack before and after')
            raw_blind = _build_raw_pdf_bytes(title='Heart attack before and after')
            res_fallback = mod.verify_blind_bundle(raw_blind, source_pdf_bytes=raw_src)
            self.assertTrue(res_fallback['blindClean'])

            raw_leaked = _build_raw_pdf_bytes(
                title='Heart attack before and after',
                annot_text='injected why_hard clue',
                widget_value='gold_ledger',
            )
            res_fallback_leak = mod.verify_blind_bundle(raw_leaked, source_pdf_bytes=raw_src)
            self.assertFalse(res_fallback_leak['blindClean'])
            surfaces = {lk['surface'] for lk in res_fallback_leak['leaks']}
            self.assertEqual(surfaces, {'annotation', 'acroform'})


class ArenaEvaluationTests(unittest.TestCase):
    def _sample_gold_and_baseline(self):
        gold = {
            'schema': 'falsify.red-gold-ledger.v1',
            'defects': [
                {
                    'defectId': 'g-prose',
                    'world': 'W1',
                    'family': 'D1',
                    'difficulty': 'L1',
                    'pageIndex': 1,
                    'after': 'Overall mortality was 14.2% (p = 0.041) in the intervention arm.',
                    'stealthPass': False,
                },
                {
                    'defectId': 'g-bbox',
                    'world': 'W2',
                    'family': 'D5',
                    'difficulty': 'L2',
                    'pageIndex': 2,
                    'bbox': [100.0, 200.0, 300.0, 360.0],
                    'after': 'Kaplan-Meier figure bar height altered.',
                    'stealthPass': True,
                },
                {
                    'defectId': 'g-table',
                    'world': 'W3',
                    'family': 'D3',
                    'difficulty': 'L3',
                    'pageIndex': 3,
                    'itemId': 'table-1',
                    'after': 'Row total 48 disagrees with 21 + 24.',
                    'stealthPass': True,
                },
                {
                    'defectId': 'g-supp',
                    'world': 'W5',
                    'family': 'D6',
                    'difficulty': 'L4',
                    'supplementName': 'Table_S1.csv',
                    'after': 'Supplemental subgroup N=190 mismatches main N=180.',
                    'stealthStatus': 'clean',
                },
            ],
        }
        baseline = {
            'schema': 'falsify.blue-defect-sensor.v1',
            'signals': [
                {
                    'id': 'sens-1',
                    'family': 'D2',
                    'pageIndex': 4,
                    'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.',
                },
            ],
        }
        return gold, baseline

    def test_bipartite_matching_baseline_exemption_stratified_metrics_and_stealth_yield(self):
        gold, baseline = self._sample_gold_and_baseline()
        blue_run = {
            'runId': 'blue-main',
            'agentId': 'agent-a',
            'findings': [
                {
                    'id': 'f1',
                    'decision': 'defect',
                    'pageIndex': 1,
                    'quote': 'In Results, overall mortality was 14.2% (p = 0.041) in the intervention arm.',
                },
                {
                    'id': 'f2',
                    'decision': 'defect',
                    'pageIndex': 2,
                    'bbox': [110.0, 210.0, 290.0, 350.0],
                    'quote': 'Visual inconsistency in figure curve.',
                },
                {
                    'id': 'f3',
                    'decision': 'defect',
                    'pageIndex': 3,
                    'itemId': 'table-1',
                    'quote': 'Table 1 arithmetic discrepancy.',
                },
                {
                    'id': 'f4',
                    'decision': 'defect',
                    'supplementName': 'Table_S1.csv',
                    'quote': 'Supplemental file N=190 conflicts with main text.',
                },
                {
                    'id': 'f5',
                    'decision': 'defect',
                    'pageIndex': 4,
                    'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.',
                },
            ],
        }
        report = mod.evaluate_arena_match(gold, [blue_run], baseline_signals=baseline)
        self.assertEqual(report['schema'], mod.ARENA_SCHEMA)
        run = report['runs'][0]
        self.assertEqual(run['tp'], 4)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['preExistingExempted'], 1)
        self.assertEqual(run['precision'], 1.0)
        self.assertEqual(run['recall'], 1.0)
        self.assertEqual(run['stealthYield'], 0.0)
        self.assertEqual(run['byWorld']['W1']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W2']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W3']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W5']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D1']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D5']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D3']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D6']['recall'], 1.0)
        self.assertEqual(run['byDifficulty']['L4']['recall'], 1.0)

    def test_multi_agent_alpha_selective_prediction_and_stealth_evasion(self):
        gold, baseline = self._sample_gold_and_baseline()
        run1 = {
            'runId': 'b1',
            'findings': [
                {'id': 'b1-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b1-2', 'decision': 'defect', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b1-3', 'decision': '확인필요', 'pageIndex': 3, 'itemId': 'table-1', 'quote': 'possible table sum issue'},
                {'id': 'b1-4', 'decision': '확인필요', 'pageIndex': 0, 'quote': 'borderline abstract phrasing'},
            ],
        }
        run2 = {
            'runId': 'b2',
            'findings': [
                {'id': 'b2-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b2-2', 'decision': 'defect', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b2-3', 'decision': 'needs_check', 'pageIndex': 3, 'itemId': 'table-1', 'quote': 'table check'},
                {'id': 'b2-4', 'decision': 'uncertain', 'pageIndex': 0, 'quote': 'uncertain sample size phrasing'},
            ],
        }
        run3 = {
            'runId': 'b3',
            'findings': [
                {'id': 'b3-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b3-2', 'decision': 'needs_check', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b3-3', 'decision': 'defect', 'pageIndex': 5, 'quote': 'completely fabricated hallucination'},
                {'id': 'b3-4', 'decision': 'defect', 'pageIndex': 4, 'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.'},
            ],
        }
        report = mod.evaluate_arena_match(gold, [run1, run2, run3], baseline_signals=baseline)
        # run1 caught 2/4 (missed g-table, g-supp; both are stealthPass out of 3 stealthPass total -> 2/3)
        self.assertAlmostEqual(report['runs'][0]['stealthYield'], 0.6667, places=4)
        self.assertEqual(report['runs'][0]['abstainedCount'], 2)
        self.assertEqual(report['runs'][2]['pureFp'], 1)
        self.assertEqual(report['runs'][2]['preExistingExempted'], 1)

        agreement = report['agreement']
        self.assertIsNotNone(agreement['nominalAlpha'])
        self.assertIsNotNone(agreement['ordinalAlpha'])
        self.assertGreater(agreement['ordinalAlpha'], agreement['nominalAlpha'])

        sel = report['selectivePrediction']
        self.assertGreater(sel['abstentionGain'], 0.0)
        self.assertIsNotNone(sel['aurc'])
        self.assertEqual(len(sel['riskCoverageCurve']), 3)

        digest = report['feedbackDigest']
        self.assertEqual(digest['evadedGoldDefectIds'], ['g-table', 'g-supp'])
        self.assertEqual(digest['triviallyCaughtDefectIds'], ['g-prose'])
        self.assertEqual(len(digest['pureFalsePositives']), 1)

    def test_coordinated_red_record_input_shape(self):
        coord = {
            'schema': 'falsify.coordinated-red-record.v1',
            'changes': [
                {'id': 'op-1', 'kind': 'uri-link', 'pageIndex': 0, 'afterUri': 'https://doi.org/10.1000/wrong'},
            ],
        }
        blue = {
            'status': 'ok',
            'findings': [
                {'id': 'f1', 'verdict': 'defect', 'pageIndex': 0, 'quote': 'https://doi.org/10.1000/wrong'},
            ],
        }
        report = mod.evaluate_arena_match(coord, blue)
        self.assertEqual(report['goldCount'], 1)
        self.assertEqual(report['runs'][0]['tp'], 1)


class CliAndComplexityTests(unittest.TestCase):
    def test_cli_verify_blind_and_evaluate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clean_pdf = root / 'clean.pdf'
            leaked_pdf = root / 'leaked.pdf'
            sup_json = root / 'sup.json'
            gold_json = root / 'gold.json'
            blue_json = root / 'blue.json'
            out_json = root / 'arena_report.json'

            clean_pdf.write_bytes(_build_pdf_bytes())
            leaked_pdf.write_bytes(_build_pdf_bytes(title='Leaked falsify copy'))
            sup_json.write_text('{"rows": [1, 2, 3]}', encoding='utf-8')
            gold_json.write_text(json.dumps([
                {'defectId': 'd1', 'world': 'W1', 'family': 'D1', 'difficulty': 'L1', 'pageIndex': 0, 'after': 'value 99.1%'},
            ]), encoding='utf-8')
            blue_json.write_text(json.dumps({
                'runId': 'cli-blue',
                'findings': [{'id': 'f1', 'decision': 'defect', 'pageIndex': 0, 'quote': 'value 99.1%'}],
            }), encoding='utf-8')

            proc_ok = subprocess.run(
                [sys.executable, str(CLI_PATH), 'verify-blind', '--pdf', str(clean_pdf), '--supplement', str(sup_json)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc_ok.returncode, 0)
            self.assertTrue(json.loads(proc_ok.stdout)['blindClean'])

            proc_leak = subprocess.run(
                [sys.executable, str(CLI_PATH), 'verify-blind', '--pdf', str(leaked_pdf)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc_leak.returncode, 3)
            self.assertFalse(json.loads(proc_leak.stdout)['blindClean'])

            proc_eval = subprocess.run(
                [sys.executable, str(CLI_PATH), 'evaluate', '--gold', str(gold_json), '--blue', str(blue_json), '--out', str(out_json)],
                capture_output=True, text=True, check=True,
            )
            payload = json.loads(proc_eval.stdout)
            self.assertEqual(payload['schema'], mod.ARENA_SCHEMA)
            self.assertEqual(payload['runs'][0]['tp'], 1)
            self.assertTrue(out_json.exists())

    def test_arena_runner_ccn_within_gate(self):
        source = CLI_PATH.read_text(encoding='utf-8')
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source, capture_output=True, text=True, check=True,
        )
        functions = json.loads(proc.stdout)
        violations = [fn for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])


if __name__ == '__main__':
    unittest.main()

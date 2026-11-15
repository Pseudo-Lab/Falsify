"""Offline tests for the adversarial RED runner. Stdlib unittest only."""
import hashlib
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
import unittest

import pymupdf

HERE = Path(__file__).resolve().parent
LOCAL = HERE.parents[2] / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import build_profile
import runner
from paper_evidence import EvidenceStore


FORBIDDEN_BLIND = (
    'tampered', 'falsify', 'red-plan', 'answer-key', 'answer_key', 'why_hard',
    'candidateRationales', '변조', '정답',
)


def _cell(page, x0, y0, width, height, text):
    rect = pymupdf.Rect(x0, y0, x0 + width, y0 + height)
    page.draw_rect(rect, color=(0, 0, 0), width=1)
    if text:
        page.insert_textbox(
            pymupdf.Rect(rect.x0 + 3, rect.y0 + 7, rect.x1 - 3, rect.y1 - 3),
            text, fontsize=9, fontname='helv',
        )


def _rows(page, origin_y, rows):
    for row_index, row in enumerate(rows):
        for column_index, text in enumerate(row):
            _cell(page, 72 + column_index * 110, origin_y + row_index * 26, 110, 26, text)


def _build_fixture(folder):
    """Multi-surface PDF: broken page-1 stat and link, clean table and DOI, isolated L4 sentence."""
    doc = pymupdf.open()
    page0 = doc.new_page(width=595, height=842)
    page0.insert_text((72, 72), 'Primary cohort showed AUC = 0.94 in training.', fontsize=10, fontname='helv')
    _rows(page0, 110, (
        ('Site', 'Arm A', 'Arm B', 'Total'),
        ('north', '10', '20', '99'),
        ('south', '5', '15', '20'),
        ('Total', '15', '35', '50'),
    ))
    page0.insert_text((72, 280), 'Broken baseline doi:10.1000/visible-ok', fontsize=9, fontname='helv')
    page0.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 270, 340, 292),
        'uri': 'https://doi.org/10.1000/broken-link-target',
    })
    page1 = doc.new_page(width=595, height=842)
    page1.insert_text(
        (72, 80), '[1] Kim J. Biomarker validation study. doi:10.1000/orig-ref', fontsize=9.5, fontname='helv',
    )
    page1.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 70, 480, 92),
        'uri': 'https://doi.org/10.1000/orig-ref',
    })
    _rows(page1, 160, (
        ('Site', 'Arm A', 'Arm B', 'Total'),
        ('east', '10', '20', '30'),
        ('west', '5', '15', '20'),
        ('Total', '15', '35', '50'),
    ))
    page2 = doc.new_page(width=595, height=842)
    page2.insert_text(
        (72, 400), 'Our findings prove the marker prevents relapse in all adults.', fontsize=10, fontname='helv',
    )
    raw = doc.tobytes()
    doc.close()
    pdf_path = folder / 'source.pdf'
    pdf_path.write_bytes(raw)
    csv_path = folder / 'Table_S1.csv'
    csv_path.write_text('cohort,N,AUC\nmain,240,0.94\n', encoding='utf-8')
    md_path = folder / 'notes.md'
    md_path.write_text('# Notes\nTraining cohort stays consistent with the main text.\n', encoding='utf-8')
    return {'pdf': pdf_path, 'csv': csv_path, 'md': md_path, 'raw': raw}


def _blind_blob(pdf_path, supplement_dir):
    doc = pymupdf.open(pdf_path)
    parts = [json.dumps(doc.metadata)]
    parts.extend(page.get_text('text') for page in doc)
    doc.close()
    if supplement_dir is not None:
        for path in sorted(Path(supplement_dir).iterdir()):
            parts.append(path.read_text(encoding='utf-8'))
    return '\n'.join(parts).lower()


def _broken_table_id(raw):
    digest = hashlib.sha256(raw).hexdigest()
    store = EvidenceStore()
    paper_id = store.prepare(raw, digest)['paperId']
    for item in store.list_items(paper_id)['items']:
        if item.get('type') != 'table':
            continue
        full = store.read_item(paper_id, item['id'])
        cells = (full.get('table') or {}).get('cells') or []
        if any(str(cell.get('text') or '').strip() == '99' for cell in cells):
            return item['id']
    raise AssertionError('broken table was not extracted')


def _gold(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


class RedRunnerOfflineTests(unittest.TestCase):
    def test_bundle_identity_contract_and_profile(self):
        first = runner.bundle_identity()
        self.assertEqual(first, runner.bundle_identity())
        settings = runner.contract_settings()
        again = runner.contract_settings()
        self.assertEqual(settings, again)
        self.assertEqual(settings['bundleSha256'], first)
        self.assertEqual(settings['profileId'], runner.PROFILE_ID)
        runner.check_settings(dict(settings))
        drifted = dict(settings)
        drifted['bundleSha256'] = 'ab' * 32
        with self.assertRaises(ValueError):
            runner.check_settings(drifted)
        profile = build_profile.build()
        self.assertEqual(profile['schema'], 'falsify.harness.v1')
        self.assertEqual(profile['role'], 'red')
        self.assertEqual(profile['id'], runner.PROFILE_ID)
        self.assertEqual(profile['version'], runner.VERSION)
        self.assertEqual(profile['settings']['bundleSha256'], first)

    def test_baseline_guard_skips_preexisting_page1_defects(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            fixture = _build_fixture(folder)
            broken_id = _broken_table_id(fixture['raw'])
            out_pdf = folder / 'blind.pdf'
            out_gold = folder / 'gold.json'
            supp = folder / 'blind-supp'
            summary = runner.execute({
                'pdfPath': str(fixture['pdf']),
                'outPdfPath': str(out_pdf),
                'outGoldPath': str(out_gold),
                'outSupplementDir': str(supp),
                'supplementPaths': [str(fixture['csv']), str(fixture['md'])],
                'targetDifficulty': 'L3',
                'seed': 7,
            })
            self.assertGreaterEqual(summary['audit']['baselineSignalCount'], 2)
            gold = _gold(out_gold)
            blob = json.dumps({'operations': gold['operations'], 'defects': gold['defects']})
            self.assertNotIn('broken-link-target', blob)
            self.assertNotIn(broken_id, blob)
            self.assertGreaterEqual(len(summary['achievedDifficulties']), 2)
            self.assertTrue(all(
                runner.distance_rank(distance) >= runner.distance_rank('L3')
                for distance in summary['achievedDifficulties']
            ))
            kinds = {op['kind'] for op in gold['operations']}
            self.assertIn('text-span', kinds)
            self.assertTrue(kinds & {'table-cell', 'supplement-edit'})
            self.assertEqual(fixture['pdf'].read_bytes(), fixture['raw'])
            self.assertEqual(fixture['csv'].read_bytes(), (folder / 'Table_S1.csv').read_bytes())

    def test_target_l3_and_l4_detectability(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            fixture = _build_fixture(folder)
            l3_pdf, l3_gold = folder / 'l3.pdf', folder / 'l3.json'
            l3_supp = folder / 'l3-supp'
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = runner.main([
                    '--pdf', str(fixture['pdf']),
                    '--out-pdf', str(l3_pdf),
                    '--out-gold', str(l3_gold),
                    '--out-supplement-dir', str(l3_supp),
                    '--supplement', str(fixture['csv']),
                    '--supplement', str(fixture['md']),
                    '--target-difficulty', 'L3',
                    '--seed', '7',
                ])
            self.assertEqual(code, 0, buf.getvalue())
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload['schema'], runner.OUTPUT_SCHEMA)
            self.assertNotIn('operations', payload)
            self.assertIn('blindPdfBase64', payload)
            self.assertIn('goldLedger', payload)
            self.assertIn('blindSupplements', payload)
            self.assertIn('L3', payload['achievedDifficulties'])
            self.assertIn(payload['stealthStatus'], ('clean', 'warning'))
            gold = _gold(l3_gold)
            self.assertEqual(gold['schema'], 'falsify.red-gold-ledger.v1')
            self.assertEqual(gold['detectabilitySummary']['schema'], 'falsify.red-detectability.v1')
            self.assertGreaterEqual(len(gold['operations']), 2)
            self.assertTrue(all(
                runner.distance_rank(row['crossInferenceDistance']) >= runner.distance_rank('L3')
                for row in gold['detectabilitySummary']['results']
            ))
            defect = next(item for item in gold['defects'] if item['surface'] == 'supplement')
            for key in ('world', 'family', 'difficulty', 'surface', 'stealthPass'):
                self.assertIn(key, defect)
            self.assertTrue(defect['stealthPass'])
            blinded = (l3_supp / 'Table_S1.csv').read_text(encoding='utf-8')
            self.assertIn(defect['after'], blinded)
            self.assertNotIn(defect['before'], blinded)
            self.assertEqual(fixture['csv'].read_text(encoding='utf-8'), (folder / 'Table_S1.csv').read_text(encoding='utf-8'))
            notes = (l3_supp / 'notes.md').read_text(encoding='utf-8')
            self.assertIn('Training cohort', notes)
            blob = _blind_blob(l3_pdf, l3_supp)
            for token in FORBIDDEN_BLIND:
                self.assertNotIn(token, blob)

            encoded = __import__('base64').b64encode(fixture['raw']).decode('ascii')
            l4 = runner.execute({
                'schema': 'falsify.red-invocation.v1',
                'pdfBase64': encoded,
                'outPdfPath': str(folder / 'l4.pdf'),
                'outGoldPath': str(folder / 'l4.json'),
                'supplementPaths': [str(fixture['csv'])],
                'targetDifficulty': 'L4',
                'seed': 7,
                'settings': runner.contract_settings(),
            })
            self.assertTrue(all(distance == 'L4' for distance in l4['achievedDifficulties']))
            self.assertEqual(l4['stealthStatus'], 'clean')
            l4_gold = _gold(folder / 'l4.json')
            self.assertTrue(all(row['crossInferenceDistance'] == 'L4' for row in l4_gold['detectabilitySummary']['results']))
            self.assertEqual(l4_gold['defects'][0]['surface'], 'prose')
            self.assertIn(l4_gold['defects'][0]['family'], ('D3', 'S1'))
            self.assertNotEqual((folder / 'l4.pdf').read_bytes(), fixture['raw'])
            self.assertEqual(fixture['pdf'].read_bytes(), fixture['raw'])

    def test_ops_hint_l1_misses_l3(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            fixture = _build_fixture(folder)
            hint = folder / 'hint.json'
            hint.write_text(json.dumps([{
                'id': 'forced-l1',
                'kind': 'uri-link',
                'linkId': 'p1-a0',
                'pageIndex': 1,
                'beforeUri': 'https://doi.org/10.1000/orig-ref',
                'afterUri': 'https://doi.org/10.1000/other-study',
                'world': 'W5',
                'family': 'D2',
                'difficulty': 'L1',
                'rationale': 'Swap one clean DOI target.',
            }]), encoding='utf-8')
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = runner.main([
                    '--pdf', str(fixture['pdf']),
                    '--out-pdf', str(folder / 'blind.pdf'),
                    '--out-gold', str(folder / 'gold.json'),
                    '--target-difficulty', 'L3',
                    '--ops-hint', str(hint),
                ])
            self.assertEqual(code, 3)
            self.assertEqual(json.loads(buf.getvalue())['error'], 'difficulty_target_unmet')
            self.assertFalse((folder / 'blind.pdf').exists())
            self.assertEqual(fixture['pdf'].read_bytes(), fixture['raw'])

    def test_stdio_execute_round_trip_and_overwrite_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            fixture = _build_fixture(folder)
            out_pdf = folder / 'stdio.pdf'
            out_gold = folder / 'stdio.json'
            payload = json.dumps({
                'schema': 'falsify.harness-invocation.v1',
                'pdfPath': str(fixture['pdf']),
                'outPdfPath': str(out_pdf),
                'outGoldPath': str(out_gold),
                'targetDifficulty': 'L4',
                'seed': 7,
                'settings': runner.contract_settings(),
            })
            proc_in = sys.stdin
            sys.stdin = io.StringIO(payload)
            try:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = runner.main([])
            finally:
                sys.stdin = proc_in
            self.assertEqual(code, 0, buf.getvalue())
            summary = json.loads(buf.getvalue())
            self.assertTrue(summary['ok'])
            self.assertEqual(summary['outPdf'], str(out_pdf))
            self.assertEqual(_gold(out_gold)['schema'], 'falsify.red-gold-ledger.v1')
            self.assertIn('L4', summary['achievedDifficulties'])
            with self.assertRaises(runner.RedRunnerError) as caught:
                runner.execute({
                    'pdfPath': str(fixture['pdf']),
                    'outPdfPath': str(fixture['pdf']),
                    'outGoldPath': str(folder / 'other-gold.json'),
                    'targetDifficulty': 'L4',
                })
            self.assertEqual(caught.exception.exit_code, 2)
            self.assertEqual(caught.exception.code, 'source_overwrite_refused')
            self.assertEqual(fixture['pdf'].read_bytes(), fixture['raw'])

    def test_arena_invocation_and_blind_supplement_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            workspace = folder / 'arena'
            supplements = workspace / 'supplements'
            supplements.mkdir(parents=True)
            raw = _spaced_pdf()
            (workspace / 'source.pdf').write_bytes(raw)
            source_csv = 'cohort,N,AUC\nmain,240,0.94\nraw,240,0.94\n'
            (supplements / 'Table_S1.csv').write_text(source_csv, encoding='utf-8')
            payload = json.dumps({
                'schema': 'falsify.red-invocation.v1',
                'sourcePdf': 'source.pdf',
                'outPdf': 'blind.pdf',
                'outGold': 'gold.json',
                'outSupplementsDir': 'blind_supplements',
                'outAudit': 'audit.json',
                'minDifficulty': 'L3',
                'supplementNames': ['Table_S1.csv'],
            })
            previous = os.getcwd()
            stdin = sys.stdin
            os.chdir(workspace)
            sys.stdin = io.StringIO(payload)
            try:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = runner.main([])
            finally:
                sys.stdin = stdin
                os.chdir(previous)
            self.assertEqual(code, 0, buf.getvalue())
            summary = json.loads(buf.getvalue())
            self.assertEqual(summary['schema'], runner.OUTPUT_SCHEMA)
            self.assertTrue(summary['blindPdfBase64'])
            self.assertEqual(summary['goldLedger']['schema'], 'falsify.red-gold-ledger.v1')
            self.assertTrue(summary['blindSupplements'])
            self.assertEqual(summary['stealthStatus'], 'clean')
            kinds = {op['kind'] for op in summary['goldLedger']['operations']}
            self.assertIn('text-span', kinds)
            self.assertTrue(kinds & {'table-cell', 'supplement-edit'})
            self.assertTrue(all(
                runner.distance_rank(distance) >= runner.distance_rank('L3')
                for distance in summary['achievedDifficulties']
            ))
            blinded = (workspace / 'blind_supplements' / 'Table_S1.csv').read_text(encoding='utf-8')
            self.assertNotEqual(blinded, source_csv)
            self.assertIn('raw,240,0.94', blinded)
            self.assertEqual((supplements / 'Table_S1.csv').read_text(encoding='utf-8'), source_csv)
            self.assertEqual((workspace / 'source.pdf').read_bytes(), raw)
            audit = json.loads((workspace / 'audit.json').read_text(encoding='utf-8'))
            self.assertEqual(audit['schema'], runner.AUDIT_SCHEMA)
            self.assertEqual(audit['profileId'], runner.PROFILE_ID)
            blob = _blind_blob(workspace / 'blind.pdf', workspace / 'blind_supplements')
            for token in FORBIDDEN_BLIND:
                self.assertNotIn(token, blob)
            self.assertTrue((workspace / 'blind.pdf').read_bytes().startswith(b'%PDF-'))
            self.assertTrue(summary['goldLedger']['outputSha256'])

    def test_notebook_supplement_loads_as_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'notes.ipynb'
            path.write_text('{"cells":[{"source":["AUC = 0.94"]}]}\n', encoding='utf-8')
            loaded = runner._load_text_inputs([str(path)])
            self.assertEqual(loaded[0]['name'], 'notes.ipynb')
            self.assertIn('cells', loaded[0]['text'])
            self.assertNotIn('\x00', loaded[0]['text'])


def _spaced_pdf():
    """One prose line on its own page so the coordinated glyph edit stays stealth-clean."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 400), 'Primary cohort showed AUC = 0.94 in training.', fontsize=11, fontname='helv')
    page2 = doc.new_page(width=595, height=842)
    page2.insert_text((72, 400), 'Rates increased after treatment.', fontsize=11, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


if __name__ == '__main__':
    unittest.main()

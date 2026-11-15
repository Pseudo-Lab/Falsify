"""Chart planner v0.3 coverage. Stdlib unittest only. Synthetic PDFs stay in memory."""
import base64
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
V03 = ROOT / 'app' / 'examples' / 'adversarial_red_v03'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

from paper_evidence import EvidenceStore  # noqa: E402
from paper_figure_forensics import audit_figure_forensics  # noqa: E402
from paper_red_detectability import simulate_red_detectability  # noqa: E402
from paper_red_planner import HINT_TOKENS, plan_coordinated_mutations  # noqa: E402
from paper_stealth_audit import audit_pdf_stealth  # noqa: E402


def _load_v03_runner():
    spec = importlib.util.spec_from_file_location('adversarial_red_v03_runner', V03 / 'runner.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load_v03_runner()


def _bind(raw):
    digest = hashlib.sha256(raw).hexdigest()
    store = EvidenceStore()
    paper_id = store.prepare(raw, digest)['paperId']
    return store, paper_id, digest


def _png(seed, width=64, height=48):
    samples = bytearray()
    for y in range(height):
        for x in range(width):
            samples += bytes((
                (x * 3 + y * 7 + seed * 13) % 256,
                (x * 5 + y * 11 + seed * 29) % 256,
                ((x // 4) * 23 + (y // 6) * 31 + seed * 41) % 256,
            ))
    return pymupdf.Pixmap(pymupdf.csRGB, width, height, bytes(samples), 0).tobytes('png')


def _image_pdf(placements):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for bbox, png in placements:
        page.insert_image(pymupdf.Rect(*bbox), stream=png)
    raw = doc.tobytes()
    doc.close()
    return raw


def _region_op(bbox, png):
    return {
        'id': 'dup-1',
        'kind': 'region-replace',
        'pageIndex': 0,
        'bbox': list(bbox),
        'assetKind': 'figure',
        'png': base64.b64encode(png).decode('ascii'),
    }


def _duplicate_excerpts(raw):
    store, paper_id, digest = _bind(raw)
    report = audit_figure_forensics(paper_id, digest, store=store)
    excerpts = []
    for signal in report.get('signals') or []:
        if signal.get('kind') == 'duplicate_figure_panel':
            excerpts.append(signal.get('excerpt'))
    return excerpts


def _matched_excerpts(result):
    excerpts = []
    for row in result.get('results') or []:
        for signal in row.get('matchedSignals') or []:
            excerpts.append(signal.get('excerpt'))
    return excerpts


def _cell(page, x0, y0, width, height, text):
    rect = pymupdf.Rect(x0, y0, x0 + width, y0 + height)
    page.draw_rect(rect, color=(0, 0, 0), width=1)
    if text:
        page.insert_textbox(
            pymupdf.Rect(rect.x0 + 3, rect.y0 + 7, rect.x1 - 3, rect.y1 - 3),
            text, fontsize=9, fontname='helv',
        )


def _chart_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.draw_line(pymupdf.Point(80, 420), pymupdf.Point(360, 420), color=(0, 0, 0), width=1)
    page.draw_line(pymupdf.Point(80, 180), pymupdf.Point(80, 420), color=(0, 0, 0), width=1)
    page.draw_rect(pymupdf.Rect(120, 300, 156, 420), color=None, fill=(0.2, 0.4, 0.8), width=0)
    page.draw_rect(pymupdf.Rect(180, 240, 216, 420), color=None, fill=(0.2, 0.4, 0.8), width=0)
    page.draw_rect(pymupdf.Rect(240, 340, 276, 420), color=None, fill=(0.2, 0.4, 0.8), width=0)
    page.insert_text((72, 700), 'Methods kept the raw AUC = 0.94 for audit.', fontsize=11, fontname='helv')
    for row_index, row in enumerate((('Metric', 'Value'), ('AUC', '0.94'), ('N', '240'))):
        for column_index, text in enumerate(row):
            _cell(page, 72 + column_index * 90, 520 + row_index * 26, 90, 26, text)
    prose = doc.new_page(width=595, height=842)
    prose.insert_text((72, 400), 'Primary cohort showed AUC = 0.94 in training.', fontsize=11, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


SUPPLEMENTS = [{
    'supplementId': 'supp-0',
    'name': 'Table_S1.csv',
    'text': 'cohort,N,AUC\nmain,240,0.94\nraw,240,0.94\n',
}]
BRIEF = {'preferredSurfaces': ['figure', 'prose'], 'targetFamilies': ['D4-1']}


def _plan(raw, brief=None):
    store, paper_id, digest = _bind(raw)
    return plan_coordinated_mutations(
        paper_id, file_hash=digest, store=store, supplements=SUPPLEMENTS,
        target_difficulty='L3', red_brief=brief,
    )


def _kinds(bundle):
    return {op.get('kind') for op in bundle['operations']}


def _write_xlsx(path):
    with zipfile.ZipFile(path, 'w') as book:
        book.writestr('[Content_Types].xml', '<Types></Types>')
        book.writestr('xl/workbook.xml', '<workbook/>')


def _hint_hits(blob):
    lowered = str(blob or '').lower()
    hits = []
    for token in HINT_TOKENS:
        if token.lower() in lowered:
            hits.append(token)
    return hits


def _pdf_text(path):
    doc = pymupdf.open(path)
    try:
        return '\n'.join(page.get_text('text') for page in doc)
    finally:
        doc.close()


def _function_rows(path):
    tool = ROOT / 'tools' / 'quality' / 'python-functions.py'
    proc = subprocess.run(
        [sys.executable, str(tool)], input=path.read_bytes(), capture_output=True, check=True,
    )
    return json.loads(proc.stdout.decode('utf-8'))


def _over_limit(paths):
    found = []
    for path in paths:
        for row in _function_rows(path):
            if row['ccn'] > 15:
                found.append(path.name + ':' + row['id'] + ':' + str(row['ccn']))
    return found


class ChartPlannerV03Tests(unittest.TestCase):
    def test_plan_discovers_marks_and_three_surface_l3_bundle(self):
        plan = _plan(_chart_pdf())
        self.assertGreaterEqual(plan['bundleCount'], 1)
        bundle = plan['bundles'][0]
        kinds = _kinds(bundle)
        self.assertIn('chart-shape', kinds)
        self.assertIn('text-span', kinds)
        self.assertTrue(kinds & {'table-cell', 'supplement-edit'})
        self.assertIn('figure', bundle['surfaces'])
        self.assertIn('prose', bundle['surfaces'])
        self.assertTrue(set(bundle['surfaces']) & {'table', 'supplement'})
        self.assertEqual(bundle['effectiveDifficulty'], 'L3')
        self.assertFalse(bundle['layer0Triggered'])
        self.assertTrue(bundle['targetMet'])
        chart = next(op for op in bundle['operations'] if op['kind'] == 'chart-shape')
        self.assertEqual(chart['world'], 'W4')
        self.assertEqual(chart['family'], 'D4-1')
        edit = chart['plan']['operations'][0]
        self.assertEqual(edit['kind'], 'set-values')
        self.assertEqual(chart['plan']['schema'], 'falsify.chart-edit-plan.v1')
        self.assertEqual(chart['plan']['revision'], 1)

    def test_new_duplicate_is_caught_and_baseline_duplicate_is_ignored(self):
        png_a, png_b, png_c = _png(3), _png(9), _png(12)
        left, mid, right = (40, 40, 140, 120), (200, 40, 300, 120), (360, 40, 460, 120)
        raw = _image_pdf(((left, png_a), (mid, png_a), (right, png_b)))
        baseline = set(_duplicate_excerpts(raw))
        self.assertTrue(baseline)
        store, paper_id, digest = _bind(raw)
        quiet = simulate_red_detectability(
            paper_id, [_region_op(right, png_c)], file_hash=digest, store=store,
        )
        introduced = simulate_red_detectability(
            paper_id, [_region_op(right, png_a)], file_hash=digest, store=store,
        )
        quiet_row = quiet['results'][0]
        hit = introduced['results'][0]
        self.assertFalse(quiet_row['detectedByLayer0'])
        self.assertTrue(hit['detectedByLayer0'])
        self.assertIn(hit['crossInferenceDistance'], ('L1', 'L2'))
        matched = set(_matched_excerpts(introduced))
        self.assertTrue(matched)
        self.assertTrue(matched.isdisjoint(baseline))

    def test_red_brief_steers_planner_and_runner(self):
        plan = _plan(_chart_pdf(), BRIEF)
        bundle = plan['bundles'][0]
        self.assertIn('figure', bundle['surfaces'])
        self.assertIn('prose', bundle['surfaces'])
        self.assertTrue(any(op.get('family') == 'D4-1' for op in bundle['operations']))
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pdf_path = folder / 'source.pdf'
            raw = _chart_pdf()
            pdf_path.write_bytes(raw)
            csv_path = folder / 'Table_S1.csv'
            csv_path.write_text(SUPPLEMENTS[0]['text'], encoding='utf-8')
            summary = runner.execute({
                'pdfPath': str(pdf_path),
                'outPdfPath': str(folder / 'blind.pdf'),
                'outGoldPath': str(folder / 'gold.json'),
                'outSupplementDir': str(folder / 'blind'),
                'supplementPaths': [str(csv_path)],
                'targetDifficulty': 'L3',
                'redBrief': BRIEF,
                'seed': 7,
            })
            kinds = {op['kind'] for op in summary['goldLedger']['operations']}
            self.assertIn('chart-shape', kinds)
            self.assertIn('text-span', kinds)
            self.assertEqual(summary['stealthStatus'], 'clean')
            self.assertTrue(all(
                runner.distance_rank(distance) >= runner.distance_rank('L3')
                for distance in summary['achievedDifficulties']
            ))
            self.assertEqual(pdf_path.read_bytes(), raw)

    def test_binary_xlsx_passthrough_hints_stealth_and_ccn(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            raw = _chart_pdf()
            pdf_path = folder / 'source.pdf'
            pdf_path.write_bytes(raw)
            csv_path = folder / 'Table_S1.csv'
            csv_path.write_text(SUPPLEMENTS[0]['text'], encoding='utf-8')
            xlsx_path = folder / 'Table_S2.xlsx'
            _write_xlsx(xlsx_path)
            original = xlsx_path.read_bytes()
            blind_dir = folder / 'blind'
            summary = runner.execute({
                'pdfPath': str(pdf_path),
                'outPdfPath': str(folder / 'blind.pdf'),
                'outGoldPath': str(folder / 'gold.json'),
                'outSupplementDir': str(blind_dir),
                'supplementPaths': [str(csv_path), str(xlsx_path)],
                'targetDifficulty': 'L3',
                'seed': 7,
            })
            copied = (blind_dir / 'Table_S2.xlsx').read_bytes()
            self.assertEqual(copied, original)
            self.assertEqual(xlsx_path.read_bytes(), original)
            self.assertEqual(summary['stealthStatus'], 'clean')
            edited = (folder / 'blind.pdf').read_bytes()
            regions = []
            for change in summary['goldLedger'].get('changes') or []:
                if type(change.get('pageIndex')) is int and isinstance(change.get('bbox'), list):
                    regions.append({'pageIndex': change['pageIndex'], 'bbox': change['bbox']})
            audit = audit_pdf_stealth(raw, edited, modified_regions=regions)
            self.assertEqual(audit['status'], 'clean')
            blob = _pdf_text(folder / 'blind.pdf')
            for path in blind_dir.iterdir():
                if path.suffix.lower() in {'.csv', '.md', '.json', '.tsv', '.ipynb', '.txt'}:
                    blob += '\n' + path.read_text(encoding='utf-8')
            self.assertEqual(_hint_hits(blob), [])
            self.assertEqual(pdf_path.read_bytes(), raw)
        owned = [
            LOCAL / 'paper_red_detectability.py',
            LOCAL / 'paper_red_planner.py',
            V03 / 'runner.py',
            V03 / 'build_profile.py',
            V03 / 'test_offline.py',
            Path(__file__),
        ]
        self.assertEqual(_over_limit(owned), [])


if __name__ == '__main__':
    unittest.main()

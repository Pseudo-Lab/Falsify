"""Generator validation for the synthetic PDF foundation corpus (no QA verdicts are asserted here)."""
import hashlib
import math
import re
import subprocess
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdf_foundation_corpus as corpus
import pymupdf

def _open(data): return pymupdf.open(stream=data, filetype='pdf')
def _flat(page): return re.sub(r'\s+', ' ', page.get_text('text', sort=True)).strip()
def _pix(page): return page.get_pixmap(dpi=72, alpha=False).samples
def _spans(page, text):
    return [s for b in page.get_text('dict')['blocks'] for l in b.get('lines', []) for s in l['spans'] if text in s['text']]
def _digest(): return [hashlib.sha256(c['source'] + b'|' + c['output']).hexdigest() for c in corpus.build_corpus()]

CASES = {c['id']: c for c in corpus.build_corpus()}
GATES, PLANS = {'must-not-fail', 'must-not-pass'}, {'resolved', 'ambiguous', 'resolved-or-partial', 'none'}

class Shape(unittest.TestCase):
    def test_fixed_case_list(self):
        self.assertEqual(len(corpus.CASE_IDS), 15)
        self.assertEqual(list(CASES), list(corpus.CASE_IDS))
    def test_signatures_counts_and_identity_maps(self):
        for cid, c in CASES.items():
            with self.subTest(cid):
                for data in (c['source'], c['output']):
                    self.assertTrue(data.startswith(b'%PDF-')); self.assertTrue(data.rstrip().endswith(b'%%EOF'))
                    doc = _open(data); self.assertFalse(doc.is_repaired); self.assertEqual(doc.page_count, 2)
                self.assertEqual(c['pageCount'], {'source': 2, 'output': 2})
                self.assertEqual(c['pageMap'], [{'sourcePageIndex': i, 'outputPageIndex': i, 'continuationPageIndices': []} for i in range(2)])
                self.assertEqual(c['schema'], corpus.SCHEMA); self.assertTrue(c['description'])
    def test_expected_fields_are_closed_and_consistent(self):
        for cid, c in CASES.items():
            e = c['expected']
            with self.subTest(cid):
                self.assertIn(e['qaGate'], GATES); self.assertIn(e['planStatus'], PLANS); self.assertIs(type(e['capability']), bool)
                self.assertIn(e['outsidePreservation'], {'preserved', 'defect'}); self.assertIn(e['insideTypography'], {'consistent', 'defect', 'n/a'})
                benign = e['outsidePreservation'] == 'preserved' and e['insideTypography'] != 'defect' and e['planStatus'] != 'ambiguous'
                self.assertEqual(e['qaGate'], 'must-not-fail' if benign else 'must-not-pass')
                self.assertEqual(e['defect'] is not None, e['outsidePreservation'] == 'defect')
        self.assertEqual(sum(c['expected']['qaGate'] == 'must-not-fail' for c in CASES.values()), 7)

class Determinism(unittest.TestCase):
    def test_rebuild_is_byte_identical(self):
        for cid in corpus.CASE_IDS:
            a, b = corpus.build_case(cid), corpus.build_case(cid)
            self.assertEqual((a['source'], a['output']), (b['source'], b['output']), cid)
    def test_fresh_interpreter_hashes_match(self):
        code = 'import sys;sys.path.insert(0,sys.argv[1]);import test_pdf_foundation_corpus as t;print(",".join(t._digest()))'
        run = subprocess.run([sys.executable, '-c', code, str(Path(__file__).resolve().parent)], capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0); self.assertEqual(run.stdout.strip().split(','), _digest())
    def test_no_metadata_ids_or_paths(self):
        for cid, c in CASES.items():
            for data in (c['source'], c['output']):
                self.assertFalse(any(_open(data).metadata.get(k) for k in ('creationDate', 'modDate', 'author', 'title', 'producer')), cid)
                self.assertNotIn(b'/ID', data); self.assertNotIn(b'Users', data); self.assertNotIn(b':\\', data)

class TextExpectations(unittest.TestCase):
    def test_before_in_source_after_in_output(self):
        for cid, c in CASES.items():
            for e in c['edits']:
                with self.subTest(cid):
                    src, out = _flat(_open(c['source'])[e['pageIndex']]), _flat(_open(c['output'])[e['pageIndex']])
                    self.assertIn(e['before'], src); self.assertIn(e['after'], out); self.assertNotEqual(e['before'], e['after'])
    def test_control_page_text_and_pixels_unchanged(self):
        for cid, c in CASES.items():
            a, b = _open(c['source'])[1], _open(c['output'])[1]
            self.assertEqual(_flat(a), _flat(b), cid); self.assertEqual(_pix(a), _pix(b), cid)
    def test_benign_outputs_differ_only_by_selection(self):
        for cid, c in CASES.items():
            if c['expected']['qaGate'] != 'must-not-fail' or not c['edits']: continue
            src, out = _flat(_open(c['source'])[0]), _flat(_open(c['output'])[0])
            for e in c['edits']: src = src.replace(e['before'], e['after'])
            self.assertEqual(src, out, cid)
    def test_noop_roundtrip_is_text_and_pixel_identical(self):
        c = CASES['noop_roundtrip']; self.assertEqual(c['edits'], []); self.assertNotEqual(c['source'], c['output'])
        for a, b in zip(_open(c['source']), _open(c['output'])): self.assertEqual((_flat(a), _pix(a)), (_flat(b), _pix(b)))
    def test_ambiguous_anchor_occurs_twice(self):
        c = CASES['ambiguous_repeated_quote']; before = c['edits'][0]['before']
        self.assertEqual(_flat(_open(c['source'])[0]).count(before), 2); self.assertEqual(len(c['selected'][0]['regions']), 2)

class SignedNegatives(unittest.TestCase):
    def test_plain_signed_negatives_retained(self):
        c = CASES['minus_sign_preservation']; src, out = _flat(_open(c['source'])[0]), _flat(_open(c['output'])[0])
        self.assertIn('slope was -0.42 with offset -3.1', src); self.assertIn('slope was -0.47 with offset -3.1', out)
        self.assertNotIn(chr(0x2212), out); self.assertNotIn(chr(0xAD), out)
    def test_erased_sign_variant_drops_only_the_unselected_hyphen(self):
        out = _flat(_open(CASES['minus_sign_erased']['output'])[0])
        self.assertIn('slope was -0.47 with offset 3.1', out); self.assertNotIn('-3.1', out)

class Geometry(unittest.TestCase):
    def test_selected_regions_are_tight_valid_and_cover_the_anchor(self):
        for cid, c in CASES.items():
            self.assertEqual(len(c['selected']), len(c['edits']), cid)
            for e, sel in zip(c['edits'], c['selected']):
                page = _open(c['source'])[sel['pageIndex']]; self.assertEqual(sel['pageIndex'], e['pageIndex'])
                self.assertTrue(sel['regions'], cid)
                for r in sel['regions']:
                    with self.subTest(cid, r=r):
                        self.assertTrue(all(math.isfinite(v) for v in r)); x0, y0, x1, y1 = r
                        self.assertTrue(x0 < x1 and y0 < y1 and y1 - y0 < 20); self.assertIn(pymupdf.Rect(r), page.rect + (-1, -1, 1, 1))
                        self.assertLess(pymupdf.Rect(r).get_area(), 0.02 * page.rect.get_area())
                clipped = ' '.join(re.sub(r'\s+', ' ', page.get_text(clip=pymupdf.Rect(r))).strip() for r in sel['regions'])
                self.assertIn(e['before'].split()[0], clipped, cid); self.assertIn(e['before'].split()[-1], clipped, cid)
                for s in sel['styles']: self.assertEqual(set(s), {'font', 'size', 'color'}); self.assertIs(type(s['color']), int)
    def test_multiline_mixed_font_has_one_region_per_line_and_two_styles(self):
        sel = CASES['multiline_mixed_font']['selected'][0]
        self.assertEqual(len(sel['regions']), 2); self.assertNotEqual(sel['regions'][0][1], sel['regions'][1][1])
        self.assertEqual({s['font'] for s in sel['styles']}, {'Helvetica', 'Helvetica-Bold'})
    def test_two_column_region_is_in_right_column(self):
        self.assertGreater(CASES['two_column']['selected'][0]['regions'][0][0], 300)
    def test_rotated_cropped_source(self):
        page = _open(CASES['rotated_cropped']['source'])[0]
        self.assertEqual(page.rotation, 90); self.assertEqual(tuple(page.cropbox), (36, 36, 559, 806))

class Defects(unittest.TestCase):
    def page(self, cid, which='output'): return _open(CASES[cid][which])[0]
    def test_defect_regions_are_valid(self):
        for cid, c in CASES.items():
            d = c['expected']['defect']
            if d: self.assertTrue(d['regions'] and all(pymupdf.Rect(r).is_valid and not pymupdf.Rect(r).is_empty for r in d['regions']), cid)
    def test_inside_typography_defects(self):
        self.assertEqual(_spans(self.page('edited_glyph_red'), 'fails')[0]['color'], 0xFF0000)
        span = _spans(self.page('edited_font_size'), 'fails')[0]; self.assertEqual((span['font'], span['size']), ('Times-Roman', 13))
    def test_outside_defects_are_real(self):
        self.assertNotIn('ordinary words.', _flat(self.page('damaged_unselected_paragraph')))
        self.assertNotEqual(len(self.page('damaged_unselected_vector', 'source').get_drawings()), len(self.page('damaged_unselected_vector').get_drawings()))
        fills = [d for d in self.page('white_overlay').get_drawings() if d.get('fill') == (1.0, 1.0, 1.0)]
        self.assertEqual(len(fills), 1); self.assertEqual(_flat(self.page('white_overlay')), _flat(self.page('valid_same_length_wording')))
        head = lambda which: _spans(self.page('moved_header', which), corpus.HEADER)[0]['bbox'][1]
        self.assertAlmostEqual(head('output') - head('source'), 8, places=3)
    def test_shared_image_has_two_placements_of_one_xobject(self):
        for which in ('source', 'output'):
            page = self.page('shared_image_occurrence', which)
            info = page.get_image_info(xrefs=True)
            self.assertEqual(len(info), 2); self.assertEqual(len({i['xref'] for i in info}), 1); self.assertGreater(info[0]['xref'], 0)

if __name__ == '__main__': unittest.main()

"""PDF QA 2026-10-19 findings F1/F4/F5 on synthetic in-memory PDFs (no private documents, no editor, no server).

F1: legacy edits of ordinary single-spaced body text (11 pt Helvetica, 15 pt leading) are not refused because adjacent
line boxes overlap by 0.114 pt; real foreign ink and overlapping selected edits still are.
F4: a rigid sub-RIGID_TOL translation of unchanged glyph runs is drift noise (warning); other movement still fails.
F5: a shorter legacy After moves the rest of its line left (no hole); unprovable cases (foreign text, vector paths or
images under the rest of the line) keep the old positions, so the original conservative spacing remains there."""
import hashlib
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pymupdf
from preserve import export_pdf
from test_pdf_regions import build, plan_for, run, status, bad
import pdf_regions

BODY = ['The toy widget was placed on the bench before noon.', 'A second toy widget waited on the shelf for the next round.',
    'The toy widget measured blue in every trial.', 'Nothing in this page describes a real experiment or result.',
    'Alpha beta gamma delta held steady on the bench, grey and calm.']

def body(lead=15, extra=None, split=None):
    """11 pt Helvetica lines from baseline 121 at the given leading. split=(line, prefix) draws that line as two text
    objects, the rest absolutely positioned where it was."""
    d = pymupdf.open(); p = d.new_page(width=595, height=842)
    for k, line in enumerate(BODY):
        y = 121 + k * lead
        if split and split[0] == k:
            p.insert_text((72, y), split[1], fontsize=11)
            p.insert_text((72 + pymupdf.get_text_length(split[1], fontsize=11), y), line[len(split[1]):], fontsize=11)
        else: p.insert_text((72, y), line, fontsize=11)
    if extra: extra(p)
    return d.tobytes()

def edit(raw, before, after): return export_pdf(raw, [{'label': 'PDF p. 1', 'before': before, 'after': after}])

def glyphs(out, y):
    return [(c['c'], round(c['origin'][0], 3)) for b in pymupdf.open(stream=out, filetype='pdf')[0].get_text('rawdict')['blocks']
        for l in b.get('lines', []) for s in l['spans'] for c in s['chars'] if abs(c['origin'][1] - y) < 0.5]

def tiny_image(rect):
    def draw(p):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), False); pix.clear_with(0)
        p.insert_image(rect, pixmap=pix)
    return draw

def objects(out):
    page = pymupdf.open(stream=out, filetype='pdf')[0]
    return [tuple(d['rect']) for d in page.get_drawings()], [tuple(i['bbox']) for i in page.get_image_info()]

class OrdinaryLeadingF1(unittest.TestCase):
    def test_line_boxes_really_overlap_but_ink_does_not(self):
        lines = [l['bbox'] for b in pymupdf.open(stream=body(), filetype='pdf')[0].get_text('dict')['blocks'] for l in b['lines']]
        self.assertGreater(lines[2][3] - lines[3][1], 0.1, 'adjacent line boxes overlap at 15 pt leading')
    def test_single_spaced_body_edit_is_exported(self):
        raw = body(); before = hashlib.sha256(raw).hexdigest()
        out, v = edit(raw, 'measured blue', 'measured grey')
        self.assertEqual(hashlib.sha256(raw).hexdigest(), before)
        self.assertIn('measured grey in every trial.', pymupdf.open(stream=out, filetype='pdf')[0].get_text())
        for y in (136, 166, 181): self.assertEqual(glyphs(out, y), glyphs(raw, y))
        self.assertTrue(v['outsideSelectedAreasUnchanged'])
    def test_overlapping_foreign_ink_on_other_lines_is_still_refused(self):
        cases = {'tight_leading': body(lead=8),
            'raised_mark_inside_selection': body(extra=lambda p: p.insert_text((150, 147), 'x', fontsize=6)),
            'lowered_mark_inside_selection': body(extra=lambda p: p.insert_text((150, 153.5), 'o', fontsize=6))}
        for name, raw in cases.items():
            with self.subTest(name), self.assertRaisesRegex(ValueError, '겹칩니다'): edit(raw, 'measured blue', 'measured grey')
    def test_overlapping_selected_edits_on_adjacent_lines_stay_refused(self):
        # 'this page' (line below) spans x 125..169 and 'measured blue' 147..219: their line boxes share 0.114 pt.
        with self.assertRaisesRegex(ValueError, '변경 영역이 겹칩니다'):
            export_pdf(body(), [{'label': 'PDF p. 1', 'before': 'measured blue', 'after': 'measured grey'},
                {'label': 'PDF p. 1', 'before': 'this page', 'after': 'this pane'}])

class ShorterAfterF5(unittest.TestCase):
    def test_rest_of_line_closes_the_gap_naturally(self):
        raw = body(); src = glyphs(raw, 181)
        out, v = edit(raw, 'gamma', 'beta')
        e = v['edits'][0]; got = glyphs(out, 181)
        shift = pymupdf.get_text_length('beta', fontsize=11) - pymupdf.get_text_length('gamma', fontsize=11)
        self.assertAlmostEqual(e['followingTextShift']['pt'], shift, places=2)
        self.assertEqual(e['spacing']['trailingGapPt'], 0)
        self.assertFalse(v['unselectedGlyphPositionsUnchanged']); self.assertEqual(v['unselectedGlyphsShiftedAlongEditedLine'], len(src) - 16)
        # Prefix in place, After at natural advances, the rest (with its original space) moved by exactly the shift.
        self.assertEqual(got[:11], src[:11]); self.assertEqual(''.join(c for c, _ in got), BODY[4].replace('gamma', 'beta'))
        for (c, x), (d, y) in zip(src[16:], got[15:]): self.assertEqual(c, d); self.assertAlmostEqual(y, x + shift, delta=0.01)
        for y in (121, 136, 151, 166): self.assertEqual(glyphs(out, y), glyphs(raw, y))
        self.assertEqual(pymupdf.open(stream=out, filetype='pdf')[0].get_fonts(), pymupdf.open(stream=raw, filetype='pdf')[0].get_fonts())
    def test_unprovable_rest_keeps_original_positions(self):
        cases = {'separately_positioned_rest': body(split=(4, 'Alpha beta gamma')),
            'link_over_rest': body(extra=lambda p: p.insert_link({'kind': pymupdf.LINK_URI, 'uri': 'https://example.invalid',
                'from': pymupdf.Rect(250, 172, 300, 184)}))}
        for name, raw in cases.items():
            with self.subTest(name):
                out, v = edit(raw, 'gamma', 'beta')
                self.assertTrue(v['gapCloseFallback']); self.assertTrue(v['unselectedGlyphPositionsUnchanged'])
                self.assertIsNone(v['edits'][0]['followingTextShift'])
                self.assertEqual(glyphs(out, 181)[15:], glyphs(raw, 181)[16:])
    def test_foreign_mark_over_the_rest_falls_back_instead_of_refusing(self):
        # A 6 pt mark on its own baseline over line 4 after the selection: the no-close export is valid, so the optional
        # closure must fall back, not hard-refuse. (300, 175) is over line 4 at 15 pt leading; at 18 pt it sits on line 3
        # (nothing over the rest: closes) and (300, 187) is the same mark over line 4.
        for lead, at, closes in ((15, (300, 175), False), (18, (300, 175), True), (18, (300, 187), False)):
            with self.subTest(lead=lead, at=at):
                y = 121 + 4 * lead; raw = body(lead=lead, extra=lambda p: p.insert_text(at, 'x', fontsize=6))
                out, v = edit(raw, 'gamma', 'beta')
                self.assertIn('beta delta held steady', ' '.join(pymupdf.open(stream=out, filetype='pdf')[0].get_text().split()))
                if closes: self.assertNotIn('gapCloseFallback', v); self.assertIsNotNone(v['edits'][0]['followingTextShift'])
                else:
                    self.assertTrue(v['gapCloseFallback']); self.assertIsNone(v['edits'][0]['followingTextShift'])
                    self.assertTrue(v['unselectedGlyphPositionsUnchanged']); self.assertEqual(glyphs(out, y)[15:], glyphs(raw, y)[16:])
    def test_foreign_mark_over_the_selection_itself_is_still_refused(self):
        with self.assertRaisesRegex(ValueError, '겹칩니다'): edit(body(extra=lambda p: p.insert_text((140, 175), 'x', fontsize=6)), 'gamma', 'beta')
    def test_decoration_under_the_rest_falls_back_and_stays_attached(self):
        # Zero-height / zero-width stroked rules have an empty path rect; their stroke extent still counts.
        cases = {'underline_under_delta_held': (lambda p: p.draw_line((167.38, 183), (215.08, 183)), (167.38, 215.08)),
            'vertical_bar': (lambda p: p.draw_line((260, 172), (260, 184)), (255, 265)),
            'image': (tiny_image(pymupdf.Rect(250, 182, 280, 185)), (250, 280))}
        for name, (draw, (x0, x1)) in cases.items():
            with self.subTest(name):
                raw = body(extra=draw); before = hashlib.sha256(raw).hexdigest()
                out, v = edit(raw, 'gamma', 'beta')
                self.assertEqual(hashlib.sha256(raw).hexdigest(), before)
                self.assertTrue(v['gapCloseFallback']); self.assertIsNone(v['edits'][0]['followingTextShift'])
                self.assertTrue(v['unselectedGlyphPositionsUnchanged']); self.assertEqual(v['unselectedGlyphsShiftedAlongEditedLine'], 0)
                self.assertEqual(objects(out), objects(raw))
                over = lambda b: ''.join(c for c, x in glyphs(b, 181) if x0 - 1 <= x < x1 - 1)
                self.assertEqual(over(out), over(raw))
                if name.startswith('underline'): self.assertEqual(over(raw), 'delta held')
    def test_decoration_elsewhere_does_not_block_the_close(self):
        out, v = edit(body(extra=lambda p: p.draw_line((72, 168), (300, 168))), 'gamma', 'beta')
        self.assertNotIn('gapCloseFallback', v); self.assertIsNotNone(v['edits'][0]['followingTextShift'])
    def test_line_final_after_is_unchanged_behaviour(self):
        out, v = edit(body(), 'calm.', 'cal.')
        self.assertNotIn('gapCloseFallback', v); self.assertIsNone(v['edits'][0]['followingTextShift'])
        self.assertTrue(v['unselectedGlyphPositionsUnchanged'])

class RigidDriftF4(unittest.TestCase):
    # The neighbor line drawn as two objects at an odd 1/8 pt, so a sub-pixel move re-antialiases glyph edges.
    ON = 72.125
    def halves(self, a, b, color=(0, 0, 0), mark=False):
        def draw(p):
            p.insert_text((self.ON + a, 132), 'Neighbor text ', fontname='cour', fontsize=11, color=color)
            p.insert_text((self.ON + 14 * 6.6 + b, 132), 'must remain unchanged.', fontname='cour', fontsize=11)
            if mark: p.draw_rect(pymupdf.Rect(80, 126, 81, 127), color=None, fill=(0, 0, 0))
        return dict(neighbor='', extra=draw)
    def outcome(self, a, b, **kw):
        src = build(**self.halves(0, 0)); out = build('false', **self.halves(a, b, **kw))
        pa, pb = (pymupdf.open(stream=x, filetype='pdf')[0].get_pixmap(alpha=False) for x in (build('false', **self.halves(0, 0)), out))
        self.assertGreater(sum(abs(x - y) > pdf_regions.PIXEL_DELTA for x, y in zip(pa.samples, pb.samples)), 0, 'the move changes pixels')
        return run(out, src=src, plan=plan_for(src))
    def test_rigid_float_reemit_shift_of_a_line_is_warning(self):
        r = self.outcome(-0.008, -0.008)
        self.assertEqual(status(r, 'edited_page_render'), 'warning', bad(r)); self.assertEqual(r['status'], 'warning')
        for code in ('edited_page_text', 'edited_region_style', 'edited_region_visible'): self.assertEqual(status(r, code), 'passed', code)
    def test_non_rigid_larger_restyled_or_marked_movement_still_fails(self):
        cases = {'one_half_moved': ((0, -0.008), {}), 'halves_moved_differently': ((-0.008, -0.004), {}),
            'beyond_rigid_tol': ((-0.03, -0.03), {}), 'recolor': ((-0.008, -0.008), {'color': (1, 0, 0)}),
            'tick_on_shifted_glyph': ((-0.008, -0.008), {'mark': True})}
        for name, ((a, b), kw) in cases.items():
            with self.subTest(name):
                r = self.outcome(a, b, **kw); self.assertEqual(status(r, 'edited_page_render'), 'failed', bad(r))
    def test_rigid_run_rule_bounds(self):
        class C:
            def __init__(self, c, x, y, style=('a', 11, 0, 'A')): self.c, self.box, self.base, self.style = c, (x, y - 9, x + 6, y + 2), y, style
        src = [C('a', 72, 100), C('b', 78, 100)]
        moved = lambda dx, dy, k=2: [(s, C(s.c, s.box[0] + dx, s.base + dy)) for s in src[:k]]
        self.assertTrue(pdf_regions._rigid(moved(0.011, 0.00806)))
        for run_ in (moved(0, 0), moved(0, 0.021), moved(0, 0.008, 1),
                [(src[0], C('a', 72, 100.008)), (src[1], C('b', 78, 100.004))],
                [(src[0], C('a', 72, 100.008)), (src[1], C('b', 78, 100.008, ('b', 11, 0, 'B')))]):
            self.assertFalse(pdf_regions._rigid(run_))

if __name__ == '__main__': unittest.main()

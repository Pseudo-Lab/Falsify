"""Blind regressions for export_pdf typography fitting, using the synthetic symbolic Arial fixture.

Only the public export_pdf(raw, patches) contract is exercised; fixtures are built in memory.
"""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from preserve import export_pdf
from test_pdf_glyph_mapping import FONT, symbolic_pdf

BEFORE = 'Study does not show benefit.'
UNTOUCHED = 'Untouched evidence and layout.'
SIZE = 12

def advance(text):
    import pymupdf as fitz
    font = fitz.Font(fontbuffer=FONT.read_bytes())
    return sum(font.glyph_advance(ord(c)) for c in text) * SIZE

def with_line(raw, *parts):
    """Redraw line 1 as text runs; a float part shifts the next run's x by that many points."""
    import pymupdf as fitz
    doc = fitz.open(stream=raw, filetype='pdf'); page = doc[0]
    x, runs = 50.0, []
    for part in parts:
        if isinstance(part, float): x += part; continue
        runs.append('1 0 0 1 %.4f 722 Tm <%s> Tj' % (x, part.encode('ascii').hex())); x += advance(part)
    content = 'BT /TT2 12 Tf %s 1 0 0 1 50 682 Tm <%s> Tj ET' % (' '.join(runs), UNTOUCHED.encode('ascii').hex())
    doc.update_stream(page.get_contents()[0], content.encode('ascii'))
    out = doc.tobytes(); doc.close()
    return out

def chars(doc):
    return [(c['c'], round(c['origin'][0], 3), round(c['origin'][1], 3), span['font'], round(span['size'], 3))
        for block in doc[0].get_text('rawdict')['blocks'] for line in block.get('lines', [])
        for span in line['spans'] for c in span['chars']]

def streams(doc):
    return b'\n'.join(doc.xref_stream(x) or b'' for x in range(1, doc.xref_length()) if doc.xref_is_stream(x))

@unittest.skipUnless(FONT.is_file(), 'Windows Arial font unavailable')
class BlindTypographyTests(unittest.TestCase):
    def setUp(self):
        import pymupdf as fitz
        self.fitz = fitz

    def open(self, raw): return self.fitz.open(stream=raw, filetype='pdf')

    def patch(self, before, after):
        return {'id': 'answerkey-7f3a', 'label': 'PDF p. 1', 'before': before, 'after': after}

    def assert_clean_edit(self, raw, before, after):
        out, self.verification = export_pdf(raw, [self.patch(before, after)])
        src, dst = self.open(raw), self.open(out)
        text = ' '.join(dst[0].get_text().split())
        self.assertNotIn(before, text); self.assertIn(after, text); self.assertIn(UNTOUCHED, text)
        # Old glyph codes are gone from content and no cover-up shape was painted.
        self.assertNotIn(before.encode('ascii').hex().encode(), dst[0].read_contents().lower())
        self.assertEqual(len(dst[0].get_drawings()), len(src[0].get_drawings()))
        # Same font objects, programs, metadata and annotations; no tool-named resources or comments.
        describe = lambda d: sorted({(f[1], f[2], f[3]) for f in d[0].get_fonts(full=True)})
        programs = lambda d: sorted({d.extract_font(f[0])[3] for f in d[0].get_fonts(full=True)})
        self.assertEqual(describe(dst), describe(src)); self.assertEqual(programs(dst), programs(src))
        self.assertEqual(dst.metadata, src.metadata)
        annots = lambda d: [(a.type[1], tuple(round(v, 2) for v in a.rect), a.info['content']) for a in d[0].annots()]
        self.assertEqual(annots(dst), annots(src))
        self.assertEqual([f[4] for f in dst[0].get_fonts(full=True) if 'falsify' in f[4].lower()], [])
        everything = streams(dst) + b''.join(dst.xref_object(x).encode() for x in range(1, dst.xref_length()))
        self.assertNotIn(b'falsify', everything.lower()); self.assertNotIn(b'answerkey', everything.lower())
        self.assertNotIn(before.encode('ascii'), everything); self.assertNotIn(b'%', dst[0].read_contents())
        return src, dst

    def test_long_but_plausible_replacement_fits_original_line(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED], annot=(400, 400))
        after = 'Study does not show benefits.'  # about 4% wider than the original line
        src, dst = self.assert_clean_edit(raw, BEFORE, after)
        baseline = chars(src)[0][2]
        old = [c for c in chars(src) if c[2] == baseline]
        new = [c for c in chars(dst) if abs(c[2] - baseline) < 0.01]
        self.assertEqual(''.join(c[0] for c in new), after)
        self.assertEqual(new[0][1:], old[0][1:])  # same start, baseline, font, size
        right = max(c['bbox'][2] for b in dst[0].get_text('rawdict')['blocks'] for l in b.get('lines', [])
            for s in l['spans'] for c in s['chars'] if abs(c['origin'][1] - baseline) < 0.01)
        self.assertLessEqual(right, 50 + advance(BEFORE) + 0.05)
        self.assertEqual([c for c in chars(dst) if c[2] != baseline], [c for c in chars(src) if c[2] != baseline])

    def test_excessive_replacement_fails(self):
        after = 'Study does not show the noted benefit in this studied unit.'
        self.assertTrue(set(after) <= set(BEFORE + UNTOUCHED))  # failure must be about length, not glyphs
        with self.assertRaises(ValueError): export_pdf(symbolic_pdf([BEFORE, UNTOUCHED]), [self.patch(BEFORE, after)])

    def test_mid_line_edit_keeps_neighbour_positions(self):
        # Contract change 2026-10-19 (F5): a shorter After closes its gap. The rest of the edited line moves by exactly
        # the reported followingTextShift with glyph, font, size and baseline kept, and the move is declared
        # (unselectedGlyphPositionsUnchanged false); the prefix and every other line keep their exact positions.
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        src, dst = self.assert_clean_edit(raw, 'does not show', 'does show')
        v, baseline = self.verification, chars(src)[0][2]
        shift = v['edits'][0]['followingTextShift']
        left, right = 50 + advance('Study'), 50 + advance('Study does not show') - 0.01
        line = lambda d: [c for c in chars(d) if c[2] == baseline]
        self.assertEqual([c for c in chars(dst) if c[2] != baseline], [c for c in chars(src) if c[2] != baseline])
        self.assertEqual([c for c in line(dst) if c[1] < left], [c for c in line(src) if c[1] < left])
        moved = advance('does show') - advance('does not show')
        self.assertLess(moved, 0); self.assertAlmostEqual(shift['pt'], moved, delta=0.002)
        old = [c for c in line(src) if c[1] >= right]
        new = [c for c in line(dst) if c[1] >= right + moved]
        self.assertEqual(len(new), len(old)); self.assertEqual(shift['glyphs'], len(old))
        for (c, x, y, font, size), (d, x2, y2, font2, size2) in zip(old, new):
            self.assertEqual((d, y2, font2, size2), (c, y, font, size)); self.assertAlmostEqual(x2, x + shift['pt'], delta=0.002)
        # No other glyph on the line: prefix + After + the shifted rest is the whole line.
        self.assertEqual(len(line(dst)), len(line(src)) - len('does not show') + len('does show'))
        self.assertFalse(v['unselectedGlyphPositionsUnchanged'])
        self.assertEqual(v['unselectedGlyphsShiftedAlongEditedLine'], len(old)); self.assertNotIn('gapCloseFallback', v)

    def test_mid_line_edit_with_separately_positioned_rest_keeps_neighbour_positions(self):
        # Fallback side of the same contract: a rest the export cannot prove moves with the edit (its own Tm) stays fixed.
        raw = with_line(symbolic_pdf([BEFORE, UNTOUCHED]), 'Study does not show ', 'benefit.')
        src, dst = self.assert_clean_edit(raw, 'does not show', 'does show')
        left, right = 50 + advance('Study'), 50 + advance('Study does not show ') - 0.01
        keep = lambda d: [c for c in chars(d) if c[0] != ' ' and (c[1] < left or c[1] >= right)]
        self.assertEqual(keep(dst), keep(src))
        v = self.verification
        self.assertTrue(v['unselectedGlyphPositionsUnchanged']); self.assertEqual(v['unselectedGlyphsShiftedAlongEditedLine'], 0)
        self.assertIsNone(v['edits'][0]['followingTextShift'])

    def test_visible_neighbour_overlap_rejected(self):
        raw = with_line(symbolic_pdf([BEFORE, UNTOUCHED]), 'Study', -0.5, 'does not show benefit.')
        with self.assertRaises(ValueError): export_pdf(raw, [self.patch('does not show benefit.', 'does show benefit.')])

    def test_insignificant_space_contact_is_handled(self):
        cases = [(('Study ', -0.003, 'does not show benefit.'), 'does not show benefit.', 'does show benefit.', True),
            (('Study does not', -0.003, ' show benefit.'), 'Study does not', 'Study does', False)]
        for parts, before, after, keep_left in cases:
            with self.subTest(before=before):
                raw = with_line(symbolic_pdf([BEFORE, UNTOUCHED]), *parts)
                src, dst = self.assert_clean_edit(raw, before, after)
                # Reading order is checked geometrically; stream order of a redrawn run may differ.
                self.assertIn('Study does show benefit.', ' '.join(dst[0].get_text(sort=True).split()))
                baseline = chars(src)[0][2]
                edge = 50 + advance('Study' if keep_left else 'Study does not') - 0.01
                kept = lambda d: [c for c in chars(d) if c[0] != ' ' and (c[2] != baseline or
                    (c[1] < edge if keep_left else c[1] >= edge))]
                self.assertEqual(kept(dst), kept(src))

if __name__ == '__main__': unittest.main()

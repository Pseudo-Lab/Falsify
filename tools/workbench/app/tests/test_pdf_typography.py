"""Bounded spacing fit, in-place text-operator edits and whitespace micro-overlap handling."""
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_typography import MAX_TRACKING_EM, find_show, plan_fit, rewrite_parts, serialize_tj
from preserve import export_pdf
from test_pdf_glyph_mapping import BEFORE, FONT, UNTOUCHED, symbolic_pdf

class PlanFitTests(unittest.TestCase):
    def test_word_gaps_absorb_overflow_within_source_range(self):
        plan = plan_fit('ab cd ef', [5] * 8, 38, 10, 5, (3, 8, 5, 10))
        self.assertAlmostEqual(plan['wordSpaceAdjustPt'], -1)
        self.assertEqual(plan['trackingPt'], 0)
        self.assertAlmostEqual(plan['fittedWidthPt'], 38)

    def test_tracking_only_after_space_floor(self):
        plan = plan_fit('ab cd', [5] * 5, 23.45, 10, 5, (5, 5, 5, 10))
        self.assertAlmostEqual(plan['wordSpaceAdjustPt'], -1.25)  # source never narrower: 75% floor
        self.assertAlmostEqual(plan['trackingPt'], -0.1)
        self.assertGreaterEqual(plan['trackingPt'], -MAX_TRACKING_EM * 10)

    def test_excess_fails_with_measurement(self):
        with self.assertRaisesRegex(ValueError, r'After 25\.00pt > 원래 영역 20\.00pt'):
            plan_fit('ab cd', [5] * 5, 20, 10, 5, (4, 6, 5, 10))

    def test_shorter_stretches_only_to_source_widest_space(self):
        plan = plan_fit('ab cd', [5] * 5, 40, 10, 5, (4, 7, 5, 10))
        self.assertAlmostEqual(plan['wordSpaceAdjustPt'], 2)
        self.assertEqual(plan['trackingPt'], 0)
        self.assertAlmostEqual(plan['trailingGapPt'], 13)

class ContentStreamTests(unittest.TestCase):
    MAP = {0x41 + i: chr(0x41 + i) for i in range(26)} | {0x20: ' '}

    def test_split_operators_rewritten_with_compensation(self):
        data = b'BT /F1 1 Tf [(AB) 10 (C)] TJ ET BT /F1 1 Tf (D) Tj ET BT /F1 1 Tf (EF) Tj ET'
        parts = find_show(data, 'F1', self.MAP, 'BCDE')
        self.assertEqual([(p[3], p[4]) for p in parts], [(1, 2), (0, 1), (0, 1)])
        splices, comp = rewrite_parts(parts, [0x58], [0], lambda code: 500)
        out = data
        for start, end, operand in sorted(splices, reverse=True): out = out[:start] + operand + out[end:]
        self.assertEqual(out, b'BT /F1 1 Tf [<4158>] TJ ET BT /F1 1 Tf [] TJ ET BT /F1 1 Tf [-500 <46>] TJ ET')
        self.assertEqual(comp, [None, None, -500])

    def test_spacing_state_and_duplicates_unprovable(self):
        with self.assertRaises(LookupError): find_show(b'BT 0.1 Tc /F1 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB')
        self.assertIsNotNone(find_show(b'q 0.1 Tc Q BT /F1 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB'))
        with self.assertRaises(LookupError): find_show(b'BT /F1 1 Tf (AB) Tj (AB) Tj ET', 'F1', self.MAP, 'AB')
        self.assertIsNone(find_show(b'BT /F2 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB'))
        with self.assertRaises(LookupError): find_show(b'BT 1 2 (AB) " /F1 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB')

    def test_q_restores_font_and_size(self):
        # Inside q the text is F2; after Q the font reverts to F1 at size 12.
        data = b'BT /F1 12 Tf ET q BT /F2 6 Tf (AB) Tj ET Q BT (AB) Tj ET'
        parts = find_show(data, 'F1', self.MAP, 'AB', size=12)
        self.assertEqual(len(parts), 1)
        self.assertEqual(data[parts[0][0]:parts[0][1]], b'(AB) Tj')
        self.assertIsNone(find_show(b'BT /F1 12 Tf ET q BT /F2 6 Tf ET Q', 'F2', self.MAP, 'AB'))

    def test_effective_size_checked(self):
        # Tf 1 scaled by Tm and CTM, as Quartz writes it: 1 x 50 x 0.24 = 12.
        quartz = b'q 0.24 0 0 0.24 0 0 cm BT 50 0 0 50 10 10 Tm /F1 1 Tf (AB) Tj ET Q'
        self.assertIsNotNone(find_show(quartz, 'F1', self.MAP, 'AB', size=12))
        with self.assertRaisesRegex(LookupError, 'font size'): find_show(quartz, 'F1', self.MAP, 'AB', size=11)
        with self.assertRaisesRegex(LookupError, 'font size'): find_show(b'BT /F1 10 Tf (AB) Tj ET', 'F1', self.MAP, 'AB', size=12)
        with self.assertRaisesRegex(LookupError, 'font size'):
            find_show(b'BT 2 0 0 1 0 0 Tm /F1 6 Tf (AB) Tj ET', 'F1', self.MAP, 'AB', size=12)  # anisotropic

    def test_unbalanced_q_fails(self):
        with self.assertRaisesRegex(LookupError, 'unbalanced q'): find_show(b'q BT /F1 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB')
        with self.assertRaises(LookupError): find_show(b'Q BT /F1 1 Tf (AB) Tj ET', 'F1', self.MAP, 'AB')

    def test_state_carries_across_content_streams(self):
        streams = [(7, b'q BT /F1 12 Tf ET'), (8, b'BT (AB) Tj ET Q')]
        parts = find_show(streams, 'F1', self.MAP, 'AB', size=12)
        self.assertEqual(parts[0][5], 8)
        self.assertEqual(streams[1][1][parts[0][0]:parts[0][1]], b'(AB) Tj')
        with self.assertRaisesRegex(LookupError, 'spacing state'): find_show([(1, b'0.2 Tw'), (2, b'BT /F1 1 Tf (AB) Tj ET')], 'F1', self.MAP, 'AB')

    def test_two_byte_codes(self):
        cid = {0x0102: 'A', 0x0103: 'B', 0x0203: 'C'}
        data = b'BT /F1 1 Tf [<01020103> -20 <0203>] TJ ET'
        parts = find_show(data, 'F1', cid, 'BC', code_bytes=2)
        self.assertEqual([(p[3], p[4]) for p in parts], [(1, 2)])
        splices, comp = rewrite_parts(parts, [0x0102], [0], lambda code: 500, 2)
        self.assertEqual(splices[0][2], b'[<01020102>] TJ')
        self.assertEqual(serialize_tj([('g', 0x0203)], 2), b'[<0203>] TJ')
        with self.assertRaisesRegex(LookupError, 'incomplete code'): find_show(b'BT /F1 1 Tf <010201> Tj ET', 'F1', cid, 'A', code_bytes=2)

@unittest.skipUnless(FONT.is_file(), 'Windows Arial font unavailable')
class SyntheticExportTests(unittest.TestCase):
    def test_slightly_longer_fits_in_place_with_bounded_spacing(self):
        import pymupdf as fitz
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        after = 'Study does not show benefits'
        out, v = export_pdf(raw, [{'label': 'PDF p. 1', 'before': BEFORE, 'after': after}])
        edit = v['edits'][0]
        self.assertEqual(edit['method'], 'in-place-text-operator')
        self.assertEqual(edit['fontResource'], 'TT2')
        self.assertTrue(v['logicalTextOrderPreserved'] and v['unselectedGlyphPositionsUnchanged'])
        spacing = edit['spacing']
        self.assertLess(spacing['wordSpaceAdjustPt'], 0)
        self.assertGreaterEqual(spacing['measuredSpaceAdvancePt'][0], spacing['spaceFloorPt'] - 0.005)
        self.assertGreaterEqual(spacing['trackingPt'], -MAX_TRACKING_EM * 12)
        doc = fitz.open(stream=out, filetype='pdf')
        self.assertEqual(doc[0].get_text().split('\n')[:2], [after, UNTOUCHED])
        self.assertEqual([f[4] for f in doc[0].get_fonts(full=True)], ['TT2'])
        doc.close()
        self.assertLess(len(json.dumps(v)), 20000)

    def test_excessive_still_fails(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        with self.assertRaisesRegex(ValueError, r'PDF p\. 1: After가 원래 텍스트 공간을 초과합니다'):
            export_pdf(raw, [{'label': 'PDF p. 1', 'before': BEFORE, 'after': 'Study does not show benefit and layout.'}])

    def restream(self, raw, old, new):
        import pymupdf as fitz
        doc = fitz.open(stream=raw, filetype='pdf'); x = doc[0].get_contents()[0]
        data = doc.xref_stream(x); self.assertIn(old, data)
        doc.update_stream(x, data.replace(old, new, 1)); out = doc.tobytes(); doc.close()
        return out

    def test_nondefault_spacing_rejected_without_fallback(self):
        # Previously this left the in-place path and shipped a redact+append copy with new content order.
        raw = self.restream(symbolic_pdf([BEFORE, UNTOUCHED]), b'BT /TT2 12 Tf', b'BT /TT2 12 Tf 0.3 Tc')
        with self.assertRaisesRegex(ValueError, r'PDF p\. 1: 지원하지 않는 PDF 구성.*Tc/Tw/Ts/Tz.*지우고 덧붙이는 방식으로 대신 만들지 않습니다'):
            export_pdf(raw, [{'label': 'PDF p. 1', 'before': BEFORE, 'after': 'Study does show benefit.'}])

    def test_unbalanced_content_rejected(self):
        raw = self.restream(symbolic_pdf([BEFORE, UNTOUCHED]), b'BT /TT2 12 Tf', b'q BT /TT2 12 Tf')
        with self.assertRaisesRegex(ValueError, r'지원하지 않는 PDF 구성.*q/Q'):
            export_pdf(raw, [{'label': 'PDF p. 1', 'before': BEFORE, 'after': 'Study does show benefit.'}])

    def test_scaled_text_matrix_in_place(self):
        import pymupdf as fitz
        doc = fitz.open(stream=symbolic_pdf([BEFORE, UNTOUCHED]), filetype='pdf'); x = doc[0].get_contents()[0]
        data = doc.xref_stream(x).replace(b'/TT2 12 Tf', b'/TT2 6 Tf').replace(b'1 0 0 1 50', b'2 0 0 2 50')
        doc.update_stream(x, data); raw = doc.tobytes(); doc.close()
        out, v = export_pdf(raw, [{'label': 'PDF p. 1', 'before': BEFORE, 'after': 'Study does show benefit.'}])
        self.assertEqual(v['edits'][0]['method'], 'in-place-text-operator')
        self.assertTrue(v['fontResourcesUnchanged'])

    def test_type0_without_unicode_cmap_dispatches_to_codec(self):
        # Type0 Arial whose program keeps only the (1,0) cmap: CIDToGID + ToUnicode still prove the
        # drawn glyphs, so the Unicode has_glyph false absence must not block it.
        import pymupdf as fitz
        from test_pdf_glyph_mapping import mac_only_cmap
        doc = fitz.open(); page = doc.new_page(); page.insert_font(fontname='Original', fontfile=str(FONT))
        page.insert_text((50, 70), 'Study does not show benefit.', fontname='Original')
        page.insert_text((50, 110), UNTOUCHED, fontname='Original')
        font = page.get_fonts(full=True)[0][0]
        cid = int(doc.xref_get_key(font, 'DescendantFonts')[1].strip('[] ').split()[0])
        program = int(doc.xref_get_key(cid, 'FontDescriptor/FontFile2')[1].split()[0])
        doc.update_stream(program, mac_only_cmap(doc.xref_stream(program)))
        raw = doc.tobytes(); doc.close()
        src = fitz.open(stream=raw, filetype='pdf')
        self.assertEqual(src[0].get_fonts(full=True)[0][2], 'Type0')
        self.assertFalse(fitz.Font(fontbuffer=src.extract_font(font)[3]).has_glyph(ord('S'), fallback=False))
        out, v = export_pdf(raw, [{'label': 'PDF p. 1', 'before': 'Study does not show benefit.', 'after': 'Study does show benefit.'}])
        self.assertEqual(v['edits'][0]['method'], 'in-place-text-operator')
        self.assertTrue(v['logicalTextOrderPreserved'] and v['unselectedGlyphPositionsUnchanged'] and v['fontResourcesUnchanged'])
        res = fitz.open(stream=out, filetype='pdf')
        self.assertEqual(res[0].get_text().replace(' ', ' '), 'Study does show benefit.\n' + UNTOUCHED + '\n')
        self.assertEqual(res[0].get_fonts(full=True), src[0].get_fonts(full=True))
        for f in src[0].get_fonts(full=True):
            self.assertEqual(res.extract_font(f[0])[3], src.extract_font(f[0])[3])
        untouched = lambda d: [(c['c'], c['origin']) for b in d[0].get_text('rawdict')['blocks'] for l in b['lines']
            for s in l['spans'] for c in s['chars'] if l['bbox'][1] > 90]
        self.assertEqual(untouched(res), untouched(src))
        src.close(); res.close()

if __name__ == '__main__': unittest.main()

"""Synthetic in-memory tests for original-font codecs (Base14 Type1 and embedded Type0 Identity-H)."""
import re
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from pdf_font_codec import font_codec, parse_cid_widths, parse_to_unicode

FONT = Path('C:/Windows/Fonts/arial.ttf')
TEXT = 'Study does not show benefit.'

def reopen(doc):
    import pymupdf as fitz
    return fitz.open('pdf', doc.tobytes(garbage=3, deflate=True))

def drawn(page, spanfont):
    return {c['c'] for b in page.get_text('rawdict')['blocks'] for line in b.get('lines', [])
        for s in line['spans'] if s['font'] == spanfont for c in s['chars']}

def helvetica_pdf(text=TEXT, encoding=None, second=False):
    import pymupdf as fitz
    doc = fitz.open(); page = doc.new_page()
    page.insert_text((50, 100), text, fontname='helv', fontsize=12)
    if second: page.insert_text((50, 140), 'Other', fontname='Helvetica', fontsize=12)
    doc = reopen(doc)
    if encoding is not None:
        xref = doc[0].get_fonts(full=True)[0][0]
        doc.xref_set_key(xref, 'Encoding', encoding)
    return doc

def winansi_bytes_pdf(data):
    """Helvetica/WinAnsi page whose content draws raw WinAnsi bytes (PyMuPDF insert_text is latin-1 only)."""
    doc = helvetica_pdf('x')
    page = doc[0]
    doc.update_stream(page.get_contents()[0], b'BT /helv 12 Tf 50 700 Td <' + data.hex().encode() + b'> Tj ET')
    return reopen(doc)

def arial_pdf(text=TEXT):
    if not FONT.exists(): raise unittest.SkipTest('Arial not installed')
    import pymupdf as fitz
    doc = fitz.open(); page = doc.new_page()
    page.insert_font(fontname='F1', fontfile=str(FONT))
    page.insert_text((50, 100), text, fontname='F1', fontsize=12)
    return reopen(doc)

def type0(doc):
    return next(f[0] for f in doc[0].get_fonts(full=True) if f[2] == 'Type0')

def to_unicode_xref(doc):
    return int(doc.xref_get_key(type0(doc), 'ToUnicode')[1].split()[0])

class Base14Tests(unittest.TestCase):
    def test_winansi_helvetica_codes_and_metrics(self):
        doc = helvetica_pdf()
        page = doc[0]
        self.assertEqual(doc.xref_get_key(page.get_fonts(full=True)[0][0], 'Encoding')[1], '/WinAnsiEncoding')
        result = font_codec(doc, page, 'Helvetica', 'Study does show.', drawn(page, 'Helvetica'))
        self.assertEqual(result['codeBytes'], 1)
        self.assertEqual(result['resource'], 'helv')
        self.assertEqual(result['xref'], page.get_fonts(full=True)[0][0])
        self.assertEqual(result['codes'], list(b'Study does show.'))
        self.assertEqual(result['mapping'][0x80], '€')  # WinAnsi, not latin-1
        for char, width in [('S', 667), ('t', 278), (' ', 278)]: self.assertAlmostEqual(result['widths'][ord(char)], width, places=2)

    def test_winansi_euro_and_curly_quotes_already_drawn(self):
        doc = winansi_bytes_pdf(b'Cost \x805 \x91said\x92 \x93ok\x94')
        seen = drawn(doc[0], 'Helvetica')
        self.assertTrue({'\u20ac', '\u2018', '\u2019', '\u201c', '\u201d'} <= seen)
        result = font_codec(doc, doc[0], 'Helvetica', '\u20ac5 \u201csaid\u201d \u2018ok\u2019', seen)
        self.assertEqual(result['codes'], list(b'\x805 \x93said\x94 \x91ok\x92'))
        self.assertAlmostEqual(result['widths'][0x80], 556, places=2)
        self.assertAlmostEqual(result['widths'][0x93], 333, places=2)

    def test_standard_encoding_when_absent(self):
        doc = helvetica_pdf(encoding='null')
        result = font_codec(doc, doc[0], 'Helvetica', 'does', {*'does'})
        self.assertEqual(result['mapping'][0x27], '\u2019')
        self.assertEqual(result['mapping'][0xA9], "'")

    def test_mac_roman(self):
        doc = helvetica_pdf(encoding='/MacRomanEncoding')
        result = font_codec(doc, doc[0], 'Helvetica', 'é', {'é'})
        self.assertEqual(result['codes'], [0x8E])

    def test_rejects_undrawn_and_unencodable(self):
        doc = helvetica_pdf()
        seen = drawn(doc[0], 'Helvetica')
        with self.assertRaisesRegex(ValueError, "그려진 적이 없어.*'X'"): font_codec(doc, doc[0], 'Helvetica', 'X', seen)
        with self.assertRaisesRegex(ValueError, '매핑이 없는 문자.*U\\+D55C'): font_codec(doc, doc[0], 'Helvetica', '한', seen | {'한'})

    def test_rejects_differences_and_unknown_encoding(self):
        doc = helvetica_pdf(encoding='<</Type/Encoding/BaseEncoding/WinAnsiEncoding/Differences[65/B]>>')
        with self.assertRaisesRegex(ValueError, 'Differences'): font_codec(doc, doc[0], 'Helvetica', 'S', {'S'})
        doc = helvetica_pdf(encoding='/PDFDocEncoding')
        with self.assertRaisesRegex(ValueError, '지원하지 않습니다'): font_codec(doc, doc[0], 'Helvetica', 'S', {'S'})

    def test_rejects_missing_and_ambiguous_resource(self):
        doc = helvetica_pdf()
        with self.assertRaisesRegex(ValueError, '찾을 수 없습니다'): font_codec(doc, doc[0], 'Times-Roman', 'S', {'S'})
        doc = helvetica_pdf(second=True)
        if len(doc[0].get_fonts(full=True)) < 2: self.skipTest('PyMuPDF merged the font resources')
        with self.assertRaisesRegex(ValueError, '모호'): font_codec(doc, doc[0], 'Helvetica', 'S', {'S'})

    def test_rejects_form_xobject_font(self):
        import pymupdf as fitz
        src = helvetica_pdf()
        doc = fitz.open(); page = doc.new_page()
        page.show_pdf_page(page.rect, src, 0)
        doc = reopen(doc)
        with self.assertRaisesRegex(ValueError, 'Form XObject'): font_codec(doc, doc[0], 'Helvetica', 'S', {'S'})

class Type0Tests(unittest.TestCase):
    def test_identity_h_codes_widths_and_source_resource(self):
        doc = arial_pdf()
        page = doc[0]
        seen = drawn(page, 'ArialMT')
        result = font_codec(doc, page, 'ArialMT', 'Study does show benefit.', seen)
        self.assertEqual((result['codeBytes'], result['resource'], result['xref']), (2, 'F1', type0(doc)))
        self.assertEqual(len(result['codes']), len('Study does show benefit.'))
        self.assertTrue(all(result['mapping'][code] in (c, '\u00a0') for code, c in zip(result['codes'], 'Study does show benefit.')))
        # The codes are exactly those the source content stream draws (Identity-H, two bytes each).
        shown = re.findall(rb'<([0-9a-f]+)>', page.read_contents())[0].decode()
        source = [int(shown[i:i + 4], 16) for i in range(0, len(shown), 4)]
        self.assertEqual(result['codes'][:6], source[:6])
        self.assertEqual(result['widths'][result['codes'][0]], 666)  # 'S' in ArialMT
        self.assertEqual(result['widths'][result['codes'][5]], 277)  # space

    def test_subset_prefix_normalized(self):
        doc = arial_pdf()
        x = type0(doc)
        cid = int(doc.xref_get_key(x, 'DescendantFonts')[1].strip('[]').split()[0])
        doc.xref_set_key(cid, 'BaseFont', '/ABCDEF+ArialMT')
        page = doc[0]
        self.assertEqual(font_codec(doc, page, 'ABCDEF+ArialMT', 'does', {*'does'})['resource'], 'F1')

    def test_rejects_absent_undrawn_and_vertical(self):
        doc = arial_pdf()
        seen = drawn(doc[0], 'ArialMT')
        with self.assertRaisesRegex(ValueError, "그려진 적이 없어.*'X'"): font_codec(doc, doc[0], 'ArialMT', 'X', seen)
        with self.assertRaisesRegex(ValueError, '매핑이 없는 문자.*U\\+D55C'): font_codec(doc, doc[0], 'ArialMT', '한', seen | {'한'})
        doc.xref_set_key(type0(doc), 'Encoding', '/Identity-V')
        with self.assertRaisesRegex(ValueError, 'Identity-H만'): font_codec(doc, doc[0], 'ArialMT', 'does', seen)

    def test_rejects_missing_tounicode(self):
        doc = arial_pdf()
        doc.xref_set_key(type0(doc), 'ToUnicode', 'null')
        with self.assertRaisesRegex(ValueError, 'ToUnicode가 없어'): font_codec(doc, doc[0], 'ArialMT', 'does', {*'does'})

    def test_rejects_ambiguous_mapping(self):
        doc = arial_pdf()
        cmap = doc.xref_stream(to_unicode_xref(doc)).decode('latin-1')
        mapped = parse_to_unicode(cmap.encode('latin-1'), 2)
        spare = next(code for code in range(1, 0xFFFF) if code not in mapped)
        cmap = cmap.replace('1 begincodespacerange', '1 begincodespacerange', 1).replace('endcmap', f'1 beginbfchar\n<{spare:04x}> <0064>\nendbfchar\nendcmap', 1)
        doc.update_stream(to_unicode_xref(doc), cmap.encode('latin-1'))
        with self.assertRaisesRegex(ValueError, "모호한 문자.*'d'"): font_codec(doc, doc[0], 'ArialMT', 'd', {'d'})

    def test_rejects_usecmap_and_mixed_codespace(self):
        doc = arial_pdf()
        cmap = doc.xref_stream(to_unicode_xref(doc)).decode('latin-1')
        doc.update_stream(to_unicode_xref(doc), cmap.replace('begincmap', '/Foo usecmap\nbegincmap', 1).encode('latin-1'))
        with self.assertRaisesRegex(ValueError, 'usecmap'): font_codec(doc, doc[0], 'ArialMT', 'd', {'d'})
        mixed = cmap.replace('1 begincodespacerange\n<0000> <FFFF>', '2 begincodespacerange\n<00> <7F>\n<8000> <FFFF>', 1)
        self.assertNotEqual(mixed, cmap)
        doc.update_stream(to_unicode_xref(doc), mixed.encode('latin-1'))
        with self.assertRaisesRegex(ValueError, '혼합'): font_codec(doc, doc[0], 'ArialMT', 'd', {'d'})

    def test_rejects_non_embedded(self):
        doc = arial_pdf()
        cid = int(doc.xref_get_key(type0(doc), 'DescendantFonts')[1].strip('[]').split()[0])
        fd = int(doc.xref_get_key(cid, 'FontDescriptor')[1].split()[0])
        doc.xref_set_key(fd, 'FontFile2', 'null')
        with self.assertRaisesRegex(ValueError, '임베디드'): font_codec(doc, doc[0], 'ArialMT', 'd', {'d'})

class ParserTests(unittest.TestCase):
    def test_widths_grammar(self):
        self.assertEqual(parse_cid_widths('[1 [500 600] 10 12 250]'), {1: 500, 2: 600, 10: 250, 11: 250, 12: 250})
        for bad in ['[1 [500', '[1 2]', '[1 [a]]', '1 2 3', '[1 3 2 5 ]']:
            with self.assertRaises(ValueError): parse_cid_widths(bad)

    def test_widths_expansion_budget_and_cid_bound(self):
        with self.assertRaisesRegex(ValueError, '확장'): parse_cid_widths('[' + ' 0 65535 500' * 3 + ']')
        with self.assertRaisesRegex(ValueError, '확장'): parse_cid_widths('[' + (' 0 [' + ' 500' * 50000 + ']') * 3 + ']')
        with self.assertRaisesRegex(ValueError, '범위'): parse_cid_widths('[65530 65536 500]')
        with self.assertRaisesRegex(ValueError, '범위'): parse_cid_widths('[65535 [500 500]]')

    def test_to_unicode_expansion_budget_and_odd_targets(self):
        head = b'1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
        ranges = b''.join(b'<%02x00> <%02xff> <0041>\n' % (hi, hi) for hi in range(100))
        flood = head + (b'100 beginbfrange\n' + ranges + b'endbfrange\n') * 6
        with self.assertRaisesRegex(ValueError, '너무 많습니다'): parse_to_unicode(flood, 2)
        # Odd-length targets make those codes unknowable (never offered), the rest still parses.
        mapping = parse_to_unicode(head + b'2 beginbfrange\n<0010> <0011> <10780>\n<0020> <0020> <0041>\nendbfrange', 2)
        self.assertEqual(mapping, {0x20: 'A'})

    def test_to_unicode_strictness(self):
        head = b'1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
        self.assertEqual(parse_to_unicode(head + b'1 beginbfrange\n<0010> <0012> <0041>\nendbfrange', 2), {16: 'A', 17: 'B', 18: 'C'})
        for body in [b'1 beginbfchar\n<10> <0041>\nendbfchar', b'2 beginbfchar\n<0010> <0041>\nendbfchar',
                b'1 beginbfchar\n<0010> <0041>\n<0011> <0042>\nendbfchar', b'1 beginbfrange\n<00ff> <0100> <0041>\nendbfrange',
                b'2 beginbfchar\n<0010> <0041>\n<0010> <0042>\nendbfchar', b'1 begincidrange\n<0000> <00ff> 0\nendcidrange']:
            with self.assertRaises(ValueError): parse_to_unicode(head + body, 2)

if __name__ == '__main__':
    unittest.main()

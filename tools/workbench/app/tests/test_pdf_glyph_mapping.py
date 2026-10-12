"""Synthetic regressions for symbolic subset fonts whose embedded program lacks a Unicode cmap.

Quartz (macOS) writes simple TrueType subsets with no /Encoding and only a (1,0) Mac cmap, so
Unicode glyph lookup reports every character absent although the page draws them. The fixture
reproduces that shape from a local TrueType font by keeping only its (1,0) cmap subtable.
"""
import struct
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from preserve import export_pdf, parse_to_unicode, truetype_symbolic_gid

FONT = Path('C:/Windows/Fonts/arial.ttf')
BEFORE = 'Study does not show benefit.'
AFTER = 'Study does show benefit.'
UNTOUCHED = 'Untouched evidence and layout.'

def mac_only_cmap(buffer):
    """Rewrite the cmap header in place so only the (1,0) subtable remains."""
    buffer = bytearray(buffer)
    count = struct.unpack_from('>H', buffer, 4)[0]
    for i in range(count):
        tag, _, start, _ = struct.unpack_from('>4sIII', buffer, 12 + i * 16)
        if tag == b'cmap': break
    records = [struct.unpack_from('>HHI', buffer, start + 4 + i * 8) for i in range(struct.unpack_from('>H', buffer, start + 2)[0])]
    mac = [r for r in records if r[:2] == (1, 0)]
    if not mac: raise unittest.SkipTest('font has no (1,0) cmap')
    struct.pack_into('>H', buffer, start + 2, 1)
    struct.pack_into('>HHI', buffer, start + 4, *mac[0])
    return bytes(buffer)

def to_unicode(chars):
    entries = ''.join('<%02X> <%04X>\n' % (ord(c), ord(c)) for c in sorted(set(chars)))
    return ('/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n'
        '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n%d beginbfchar\n%sendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end'
        % (len(set(chars)), entries)).encode('ascii')

def symbolic_pdf(lines, mapped=None, duplicate_font=False, annot=None):
    """Simple TrueType, no /Encoding, symbolic flag, (1,0)-only cmap, ToUnicode for `mapped`."""
    import pymupdf as fitz
    program = mac_only_cmap(FONT.read_bytes())
    metrics = fitz.Font(fontbuffer=FONT.read_bytes())
    doc = fitz.open(); page = doc.new_page()
    def obj(source, stream=None):
        xref = doc.get_new_xref(); doc.update_object(xref, source)
        if stream is not None: doc.update_stream(xref, stream)
        return xref
    file_xref = obj('<<>>', program)
    unicode_xref = obj('<<>>', to_unicode(mapped if mapped is not None else ''.join(lines)))
    widths = ' '.join(str(round(metrics.glyph_advance(c) * 1000)) for c in range(32, 127))
    def font():
        descriptor = obj('<</Type/FontDescriptor/FontName/AAAAAC+ArialMT/Flags 4/FontBBox[-665 -325 2000 1040]'
            '/ItalicAngle 0/Ascent 905/Descent -212/CapHeight 716/StemV 80/FontFile2 %d 0 R>>' % file_xref)
        return obj('<</Type/Font/Subtype/TrueType/BaseFont/AAAAAC+ArialMT/FirstChar 32/LastChar 126/Widths[%s]'
            '/FontDescriptor %d 0 R/ToUnicode %d 0 R>>' % (widths, descriptor, unicode_xref))
    fonts = '/TT2 %d 0 R' % font()
    if duplicate_font: fonts += ' /TT3 %d 0 R' % font()
    content = 'BT /TT2 12 Tf ' + ' '.join('1 0 0 1 50 %d Tm <%s> Tj' % (722 - 40 * i, line.encode('ascii').hex()) for i, line in enumerate(lines)) + ' ET'
    if duplicate_font: content += ' BT /TT3 12 Tf 1 0 0 1 50 600 Tm <%s> Tj ET' % b'Second'.hex()
    doc.xref_set_key(page.xref, 'Resources', '<</Font<<%s>>>>' % fonts)
    doc.xref_set_key(page.xref, 'Contents', '%d 0 R' % obj('<<>>', content.encode('ascii')))
    if annot: page.add_text_annot(annot, 'note')
    raw = doc.tobytes(); doc.close()
    return raw

@unittest.skipUnless(FONT.is_file(), 'Windows Arial font unavailable')
class SymbolicSubsetTests(unittest.TestCase):
    def setUp(self):
        import pymupdf as fitz
        self.fitz = fitz
        self.patch = {'id': 'c1', 'label': 'PDF p. 1', 'before': BEFORE, 'after': AFTER}

    def test_fixture_reproduces_false_absence(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED]); doc = self.fitz.open(stream=raw, filetype='pdf')
        self.assertIn(BEFORE, doc[0].get_text())
        buffer = doc.extract_font(doc[0].get_fonts(full=True)[0][0])[3]
        self.assertFalse(self.fitz.Font(fontbuffer=buffer).has_glyph(ord('S'), fallback=False))
        self.assertGreater(truetype_symbolic_gid(buffer, ord('S')), 0)

    def test_valid_glyphs_reuse_original_font_object(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        source = self.fitz.open(stream=raw, filetype='pdf'); font_xref = source[0].get_fonts(full=True)[0][0]; source.close()
        out, verification = export_pdf(raw, [self.patch])
        doc = self.fitz.open(stream=out, filetype='pdf'); text = doc[0].get_text()
        self.assertNotIn(BEFORE, text); self.assertIn(AFTER, text); self.assertIn(UNTOUCHED, text)
        self.assertTrue(verification['outsideSelectedAreasUnchanged']); self.assertTrue(verification['textActuallyRemoved'])
        # No second font program embedded: every font on the page is the original object.
        fonts = doc[0].get_fonts(full=True)
        self.assertEqual({f[3] for f in fonts}, {'AAAAAC+ArialMT'})
        self.assertEqual(len({doc.xref_get_key(f[0], 'FontDescriptor')[1] for f in fonts}), 1)
        self.assertEqual(len([x for x in range(1, doc.xref_length()) if doc.xref_get_key(x, 'FontFile2')[0] != 'null']), 1)
        doc.close()

    def test_truly_absent_glyph_fails_with_characters(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        with self.assertRaisesRegex(ValueError, r"PDF p\. 1: .*없는 문자: 'z' \(U\+007A\)"):
            export_pdf(raw, [{**self.patch, 'after': 'Study does show zeal.'}])

    def test_mapped_but_never_drawn_glyph_fails(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED], mapped=BEFORE + UNTOUCHED + 'q')
        with self.assertRaisesRegex(ValueError, r"그려진 적이 없어.*'q' \(U\+0071\)"):
            export_pdf(raw, [{**self.patch, 'after': 'Study does show bequest'}])

    def test_width_gate_reports_measurement(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED])
        with self.assertRaisesRegex(ValueError, r'PDF p\. 1: After가 원래 텍스트 공간을 초과합니다 \(After [\d.]+pt > 원래 영역 [\d.]+pt'):
            export_pdf(raw, [{**self.patch, 'after': 'Study does not show benefit and benefit.'}])

    def test_annotation_overlap_rejected(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED], annot=(60, 108))
        with self.assertRaisesRegex(ValueError, '주석'):export_pdf(raw, [self.patch])

    def test_signed_pdf_rejected(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED]).replace(b'%%EOF', b'% /ByteRange [0 0 0 0]\n%%EOF')
        with self.assertRaisesRegex(ValueError, '서명'):export_pdf(raw, [self.patch])

    def test_ambiguous_font_resources_rejected(self):
        raw = symbolic_pdf([BEFORE, UNTOUCHED], duplicate_font=True)
        with self.assertRaisesRegex(ValueError, '고유하게'):export_pdf(raw, [self.patch])

class ToUnicodeParserTests(unittest.TestCase):
    HEAD = b'begincmap 1 begincodespacerange <00> <FF> endcodespacerange '

    def test_bfchar_and_bfrange(self):
        cmap = self.HEAD + b'2 beginbfchar <21> <0020> <22> <00660069> endbfchar 2 beginbfrange <2d> <2e> <0078> <30> <31> [<0041> <2019>] endbfrange endcmap'
        self.assertEqual(parse_to_unicode(cmap), {0x21: ' ', 0x22: 'fi', 0x2d: 'x', 0x2e: 'y', 0x30: 'A', 0x31: '\u2019'})

    def test_fail_closed_inputs(self):
        for cmap in [
            self.HEAD + b'2 beginbfchar <21> <0041> <21> <0042> endbfchar',
            b'/Foo usecmap ' + self.HEAD + b'1 beginbfchar <21> <0041> endbfchar',
            b'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0021> <0041> endbfchar',
            self.HEAD + b'1 beginbfchar <21> <0041> junk endbfchar',
            self.HEAD + b'2 beginbfchar <21> <0041> endbfchar',
            self.HEAD + b'1 beginbfchar <21> <D800> endbfchar',
            b'1 beginbfchar <21> <0041> endbfchar',
            self.HEAD + b'1 beginbfrange <30> <2f> <0041> endbfrange',
            b'x' * (300 * 1024)]:
            self.assertIsNone(parse_to_unicode(cmap), cmap[:80])

    def test_malformed_font_program_is_unverifiable(self):
        for buffer in [b'', b'\0' * 20, b'\0\1\0\0\0\1' + b'\0' * 6 + b'cmap' + b'\0' * 4 + b'\xff' * 8]:
            self.assertIsNone(truetype_symbolic_gid(buffer, 65))

if __name__ == '__main__': unittest.main()

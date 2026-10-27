"""Single-occurrence image replacement engine on small in-memory synthetic PDFs (pikepdf/Pillow built, MuPDF checked).
No server, frontend, model or research PDF."""
import hashlib
import io
import sys
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import image_occurrence_editor as ed
try:
    import pikepdf
    import pymupdf
    from PIL import Image
except ImportError as error:
    raise unittest.SkipTest('Optional image dependencies are not installed; see requirements-images.txt') from error

sha = lambda b: hashlib.sha256(b).hexdigest()


def rgb_image(pdf, seed, w=6, h=5, **extra):
    s = pdf.make_stream(zlib.compress(pixels(seed, w, h)))
    s.Type, s.Subtype, s.Width, s.Height = pikepdf.Name.XObject, pikepdf.Name.Image, w, h
    s.ColorSpace, s.BitsPerComponent, s.Filter = pikepdf.Name.DeviceRGB, 8, pikepdf.Name.FlateDecode
    for k, v in extra.items(): s[pikepdf.Name('/' + k)] = v
    return s


def pixels(seed, w=6, h=5):
    return bytes(((seed * 70 + 40 * x) % 256 if c == 0 else (30 * y + seed * 9) % 256 if c == 1 else (seed * 50 + 7) % 256)
        for y in range(h) for x in range(w) for c in range(3))


def make_pdf(contents, xobjects=None, inherit=False, page_extra=None, extgstate=None, shared_content=False):
    """contents: one bytes (or list of bytes = Contents array) per page; xobjects: name -> callable(pdf) -> stream.
    Resources are one indirect dict shared by every page, or inherited from the Pages root when inherit=True. The page
    tree is built by hand: pikepdf's page list would push inherited attributes down into every page."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name.Helvetica))
    xo = pikepdf.Dictionary({'/' + n: pdf.make_indirect(f(pdf)) for n, f in (xobjects or {}).items()})
    res = pdf.make_indirect(pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font), XObject=xo,
        ExtGState=pikepdf.Dictionary(extgstate or {})))
    root = pdf.Root.Pages
    kids, first = pikepdf.Array(), None
    for i, c in enumerate(contents):
        page = pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=pikepdf.Array([0, 0, 300, 400]), Parent=root)
        if isinstance(c, list):
            page.Contents = pikepdf.Array([pdf.make_stream(x) for x in c])
        elif shared_content and first is not None:
            page.Contents = first
        else:
            page.Contents = pdf.make_stream(c)
            first = first or page.Contents
        page.Resources = res
        for k, v in ((page_extra or {}).get(i) or {}).items(): page[pikepdf.Name('/' + k)] = v
        kids.append(pdf.make_indirect(page))
    root.Kids, root.Count = kids, len(contents)
    buf = io.BytesIO()
    pdf.save(buf, deterministic_id=True)
    if not inherit: return buf.getvalue()
    # QPDF's writer pushes inherited attributes into every page, so true inheritance is made with MuPDF afterwards.
    doc = pymupdf.open(stream=buf.getvalue(), filetype='pdf')
    try:
        ref = doc.xref_get_key(doc.page_xref(0), 'Resources')[1]
        for pno in range(doc.page_count): doc.xref_set_key(doc.page_xref(pno), 'Resources', 'null')
        doc.xref_set_key(int(doc.xref_get_key(doc.pdf_catalog(), 'Pages')[1].split()[0]), 'Resources', ref)
        return doc.tobytes(no_new_id=True)
    finally:
        doc.close()


def png(seed=3, w=8, h=8, mode='RGB', alpha=255):
    img = Image.new(mode, (w, h))
    img.putdata([((seed * 90 + 31 * x) % 256, (seed * 40 + 29 * y) % 256, (200 - seed * 20) % 256) + ((alpha,) if mode == 'RGBA' else ())
        for y in range(h) for x in range(w)])
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


def chunk(kind, body): return len(body).to_bytes(4, 'big') + kind + body + zlib.crc32(kind + body).to_bytes(4, 'big')


def png_claiming(w, h):
    ihdr = w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + bytes([8, 2, 0, 0, 0])
    return ed.PNG_SIGNATURE + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b'\x00' * 7)) + chunk(b'IEND', b'')


IM = {'Im1': lambda p: rgb_image(p, 1), 'Im2': lambda p: rgb_image(p, 2)}
TEXT = b'BT /F1 12 Tf 40 30 Td (Caption stays put) Tj ET\n'
A = b'q 100 0 0 80 30 280 cm /Im1 Do Q\n'
B = b'q 100 0 0 80 170 280 cm /Im1 Do Q\n'
C = b'q 60 0 0 60 30 150 cm /Im2 Do Q\n'


def listing(src): return ed.list_occurrences(src)['occurrences']


def render(data, pno, zoom=1.0):
    doc = pymupdf.open(stream=data, filetype='pdf')
    try:
        pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        return pix
    finally:
        doc.close()


def texts(data):
    doc = pymupdf.open(stream=data, filetype='pdf')
    try: return [p.get_text('words') for p in doc]
    finally: doc.close()


class SharedOccurrences(unittest.TestCase):
    def test_same_xref_twice_on_one_page_changes_only_the_selected_paint(self):
        src = make_pdf([A + B + C + TEXT], IM)
        before = sha(src)
        occ = listing(src)
        self.assertEqual(len(occ), 3)
        a, b, c = occ
        self.assertTrue(a['shared'] and b['shared'] and not c['shared'])
        self.assertTrue(all(o['editable'] and o['reason'] is None for o in occ))
        self.assertNotEqual(a['id'], b['id'])
        self.assertEqual(a['bbox'], [30.0, 40.0, 130.0, 120.0])
        out, report = ed.replace_occurrence(src, a['id'], png(5, 10, 7))
        self.assertEqual(sha(src), before)
        self.assertEqual(report, {'schema': 'falsify.image-edit-report.v1', 'sourceSha256': before, 'occurrenceId': a['id'],
            'outputSha256': sha(out), 'pageIndex': 0, 'bbox': a['bbox'], 'changedOccurrences': 1, 'check': 'passed',
            'limits': ['engine-render-check', 'domain-review-pending', 'text-only-blue']})
        after = listing(out)
        self.assertEqual([(o['width'], o['height']) for o in after], [(10, 7), (6, 5), (6, 5)])
        self.assertEqual([o['bbox'] for o in after], [o['bbox'] for o in occ])
        self.assertFalse(after[1]['shared'])   # the old xref is now painted once
        pa, pb = render(src, 0), render(out, 0)
        self.assertEqual(pa.pixel(230, 80), pb.pixel(230, 80))      # second paint of the same xref untouched
        self.assertNotEqual(pa.pixel(80, 80), pb.pixel(80, 80))
        self.assertEqual(texts(src), texts(out))
        with pikepdf.open(io.BytesIO(out)) as pdf:
            page = pdf.Root.Pages.Kids[0]
            names = sorted(str(k) for k in page.Resources.XObject.keys())
            self.assertEqual(names, ['/Im1', '/Im2', '/Im3'])
            self.assertNotRegex(names[2], '(?i)falsify|red|attack')   # no self-inserted tool/experiment label
            self.assertNotIn(b'Falsify', out)
            self.assertEqual(page.Resources.XObject.Im1.read_bytes(),
                pixels(1))
            self.assertEqual(page.Contents.read_bytes(), (A + B + C + TEXT).replace(b'/Im1 Do', b'/Im3 Do', 1))

    def test_inherited_resources_across_pages_identical_bbox_distinct_ids(self):
        src = make_pdf([A + TEXT, A + TEXT, C], IM, inherit=True)
        occ = listing(src)
        p0, p1, p2 = occ
        self.assertEqual(p0['bbox'], p1['bbox'])
        self.assertNotEqual(p0['id'], p1['id'])
        self.assertTrue(p0['shared'] and p1['shared'] and not p2['shared'])
        out, report = ed.replace_occurrence(src, p1['id'], png(6))
        self.assertEqual(report['pageIndex'], 1)
        self.assertEqual(render(src, 0).samples, render(out, 0).samples)
        self.assertEqual(render(src, 2).samples, render(out, 2).samples)
        self.assertNotEqual(render(src, 1).samples, render(out, 1).samples)
        doc = pymupdf.open(stream=src, filetype='pdf')
        try:
            self.assertEqual({doc.xref_get_key(doc.page_xref(i), 'Resources')[0] for i in range(3)}, {'null'})
        finally:
            doc.close()
        with pikepdf.open(io.BytesIO(out)) as pdf:
            kids = pdf.Root.Pages.Kids
            # QPDF moves inherited attributes onto each page as references to the one shared dictionary; only the
            # edited page gets its own direct Resources.
            shared = kids[0].Resources
            self.assertTrue(shared.is_indirect)
            self.assertEqual(kids[2].Resources.objgen, shared.objgen)
            self.assertEqual(sorted(shared.XObject.keys()), ['/Im1', '/Im2'])
            self.assertFalse(kids[1].Resources.is_indirect)
            self.assertEqual(sorted(kids[1].Resources.XObject.keys()), ['/Im1', '/Im2', '/Im3'])
            self.assertEqual(kids[1].Resources.XObject.Im1.objgen, shared.XObject.Im1.objgen)
        self.assertEqual(len(texts(out)), 3)
        self.assertEqual(texts(src), texts(out))

    def test_shared_content_stream_between_pages_is_localized(self):
        src = make_pdf([A, A], IM, shared_content=True)
        occ = listing(src)
        out, _ = ed.replace_occurrence(src, occ[0]['id'], png(7))
        self.assertEqual(render(src, 1).samples, render(out, 1).samples)
        self.assertEqual([(o['width'], o['height']) for o in listing(out)], [(8, 8), (6, 5)])

    def test_contents_array_comment_and_name_collision(self):
        xo = dict(IM, Im3=lambda p: rgb_image(p, 4))
        page = [b'q 1 0 0 1 0 0 cm\n', b'q 100 0 0 80 30 280 cm /Im2 Do Q 100 0 0 80 30 120 cm /Im1 %keep\n Do Q\n',
            b'q 10 0 0 10 250 20 cm /Im3 Do Q %/Im4 named only in content\n']
        src = make_pdf([page], xo)
        occ = listing(src)
        self.assertEqual(len(occ), 3)
        out, _ = ed.replace_occurrence(src, occ[1]['id'], png(8))
        with pikepdf.open(io.BytesIO(out)) as pdf:
            p = pdf.Root.Pages.Kids[0]
            self.assertEqual(sorted(p.Resources.XObject.keys()), ['/Im1', '/Im2', '/Im3', '/Im5'])
            self.assertEqual(p.Contents[1].read_bytes(), page[1].replace(b'/Im1 %keep', b'/Im5 %keep'))
            self.assertEqual(p.Contents[0].read_bytes(), page[0])
            self.assertEqual(p.Contents[2].read_bytes(), page[2])


def form_source(depth=1, inner_data=None, image_extra=None, form_extra=None):
    def build(pdf):
        image = rgb_image(pdf, 1, **(image_extra or {}))
        form = pdf.make_stream(inner_data or b'q 50 0 0 40 0 0 cm /Im1 %keep\n Do Q\n')
        form.Type, form.Subtype, form.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 50, 40])
        form.Resources = pdf.make_indirect(pikepdf.Dictionary(XObject=pdf.make_indirect(pikepdf.Dictionary(Im1=image))))
        form.PieceInfo = pikepdf.Dictionary(Test=pikepdf.Dictionary(Private=pikepdf.String('preserve')))
        for key, value in (form_extra or {}).items(): form[key] = value
        if depth == 2:
            outer = pdf.make_stream(b'q /Inner Do Q q 1 0 0 1 60 0 cm /Inner Do Q\n')
            outer.Type, outer.Subtype = pikepdf.Name.XObject, pikepdf.Name.Form
            outer.BBox = pikepdf.Array([0, 0, 110, 40])
            outer.Resources = pdf.make_indirect(pikepdf.Dictionary(XObject=pikepdf.Dictionary(Inner=form)))
            return outer
        return form
    first = b'q 1 0 0 1 30 280 cm /Fm Do Q\n'
    second = b'q 1 0 0 1 170 280 cm /Fm Do Q\n'
    return make_pdf([[b'% untouched stream\n', first + second + TEXT], first + TEXT], {'Fm': build})


class FormOccurrences(unittest.TestCase):
    def test_optional_content_and_tagged_form_associations_are_not_lost(self):
        cases = [
            form_source(image_extra={'OC': pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name=pikepdf.String('Layer'))}),
            form_source(image_extra={'StructParent': 0}),
            form_source(form_extra={'/OC': pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name=pikepdf.String('Layer'))}),
            form_source(form_extra={'/StructParents': 0}),
            form_source(inner_data=b'/Figure << /MCID 0 >> BDC q 50 0 0 40 0 0 cm /Im1 Do Q EMC'),
            form_source(depth=2, form_extra={'/StructParents': 0}),
        ]
        for source in cases:
            with self.subTest(digest=sha(source)):
                original = sha(source)
                occurrences = listing(source)
                self.assertTrue(occurrences)
                self.assertTrue(all(not item['editable'] and item['reason'] == 'form-image' for item in occurrences))
                with self.assertRaises(ValueError):
                    ed.replace_occurrence(source, occurrences[0]['id'], png())
                self.assertEqual(sha(source), original)

    def assertOnlyTargetChanged(self, source, output, target):
        self.assertEqual(render(source, 1).samples, render(output, 1).samples)
        a, b = render(source, 0), render(output, 0)
        x0, y0, x1, y1 = target['bbox']
        changed = 0
        for y in range(a.height):
            for x in range(a.width):
                if a.pixel(x, y) != b.pixel(x, y):
                    changed += 1
                    self.assertTrue(x0 - 2 <= x <= x1 + 2 and y0 - 2 <= y <= y1 + 2)
        self.assertGreater(changed, 4)
        self.assertEqual(texts(source), texts(output))

    def test_one_and_two_nested_shared_forms_isolate_selected_invocation(self):
        for depth in (1, 2):
            with self.subTest(depth=depth):
                source = form_source(depth)
                original = sha(source)
                before = listing(source)
                self.assertEqual(len(before), 3 if depth == 1 else 6)
                self.assertTrue(all(o['editable'] and o['shared'] for o in before))
                self.assertEqual(len({o['id'] for o in before}), len(before))
                selected = before[0 if depth == 1 else 1]
                output, report = ed.replace_occurrence(source, selected['id'], png(7, 9, 7))
                self.assertEqual(sha(source), original)
                self.assertEqual(report['changedOccurrences'], 1)
                self.assertOnlyTargetChanged(source, output, selected)
                self.assertEqual([(o['width'], o['height']) for o in listing(output)],
                    [(9, 7) if o is selected else (6, 5) for o in before])
                with pikepdf.open(io.BytesIO(source)) as a, pikepdf.open(io.BytesIO(output)) as b:
                    old = a.Root.Pages.Kids[0].Resources.XObject.Fm
                    kept = b.Root.Pages.Kids[0].Resources.XObject.Fm
                    self.assertEqual(old.read_bytes(), kept.read_bytes())
                    self.assertEqual(kept.objgen, b.Root.Pages.Kids[1].Resources.XObject.Fm.objgen)
                    self.assertEqual(b.Root.Pages.Kids[0].Contents[0].read_bytes(), b'% untouched stream\n')
                    cloned = b.Root.Pages.Kids[0].Resources.XObject.Im1
                    self.assertNotEqual(cloned.objgen, kept.objgen)
                    if depth == 2:
                        # First inner invocation and all repeated outer uses retain the old Form.
                        self.assertEqual(cloned.Resources.XObject.Inner.objgen, kept.Resources.XObject.Inner.objgen)
                        cloned = cloned.Resources.XObject.Im1
                    self.assertEqual(str(cloned.PieceInfo.Test.Private), 'preserve')
                    self.assertIn(b'%keep\n', cloned.read_bytes())

    def test_selected_form_on_later_page_does_not_change_earlier_repeated_uses(self):
        source = form_source(2)
        before = listing(source)
        target = before[-1]
        self.assertEqual(target['pageIndex'], 1)
        output, report = ed.replace_occurrence(source, target['id'], png(5, 7, 9))
        self.assertEqual(report['pageIndex'], 1)
        self.assertEqual(render(source, 0).samples, render(output, 0).samples)
        self.assertNotEqual(render(source, 1).samples, render(output, 1).samples)
        self.assertEqual([(o['width'], o['height']) for o in listing(output)],
            [(7, 9) if o is target else (6, 5) for o in before])

    def test_form_matrix_and_containing_bbox_are_preserved(self):
        source = form_source(form_extra={'/Matrix': pikepdf.Array([0.8, 0, 0, 0.75, 2, 3])})
        target = listing(source)[0]
        self.assertTrue(target['editable'])
        self.assertEqual(target['bbox'], [32.0, 87.0, 72.0, 117.0])
        output, _ = ed.replace_occurrence(source, target['id'], png(8))
        self.assertOnlyTargetChanged(source, output, target)
        with pikepdf.open(io.BytesIO(output)) as pdf:
            old, new = pdf.Root.Pages.Kids[0].Resources.XObject.Fm, pdf.Root.Pages.Kids[0].Resources.XObject.Im1
            self.assertEqual(list(old.Matrix), list(new.Matrix))
            self.assertEqual(list(old.BBox), list(new.BBox))

    def test_masks_and_groups_remain_unsupported(self):
        cases = [
            (form_source(image_extra={'ImageMask': True}), 'transparency'),
            (form_source(image_extra={'Mask': pikepdf.Array([0, 0, 0, 0, 0, 0])}), 'transparency'),
            (form_source(form_extra={'/SMask': pikepdf.Name.None_}), 'transparency'),
            (form_source(form_extra={'/Group': pikepdf.Dictionary(S=pikepdf.Name.Transparency)}), 'transparency'),
        ]
        for source, reason in cases:
            with self.subTest(reason=reason):
                occ = listing(source)
                self.assertTrue(occ)
                self.assertTrue(all(not o['editable'] and o['reason'] == reason for o in occ))
                with self.assertRaisesRegex(ValueError, '^' + reason + '$'):
                    ed.replace_occurrence(source, occ[0]['id'], png())

    def test_rotated_form_and_complex_clip_export(self):
        cases = [form_source(inner_data=b'0 0 m 50 0 l 0 40 l h W n q 50 0 0 40 0 0 cm /Im1 Do Q'),
            form_source(form_extra={'/Matrix': pikepdf.Array([0, 1, -1, 0, 50, 0])})]
        for source in cases:
            target = listing(source)[0]
            self.assertTrue(target['editable'])
            out, _ = ed.replace_occurrence(source, target['id'], png())
            self.assertOnlyTargetChanged(source, out, target)

    def test_ambiguous_do_and_unbalanced_form_state_reject_entire_page(self):
        for tail in (b'/Im1 /Im1 Do', b'Q', b'q', b'1 q', b'1 Q'):
            with self.subTest(tail=tail):
                source = form_source(inner_data=b'q 50 0 0 40 0 0 cm /Im1 Do Q ' + tail)
                result = ed.list_occurrences(source)
                self.assertFalse(result['complete'])
                self.assertTrue(result['occurrences'])
                self.assertTrue(all(not o['editable'] and o['reason'] == 'malformed-pdf' for o in result['occurrences']))

    def test_form_stream_tampering_is_caught_even_without_pixel_change(self):
        source = form_source(2)
        target = listing(source)[1]
        real = ed._rewrite
        def tamper(pk, src, selected, rgb, size):
            output, expected = real(pk, src, selected, rgb, size)
            with pikepdf.open(io.BytesIO(output)) as pdf:
                original = pdf.Root.Pages.Kids[1].Resources.XObject.Fm
                original.write(original.read_bytes() + b'% unapproved modification\n')
                buf = io.BytesIO(); pdf.save(buf)
                return buf.getvalue(), expected
        with patch.object(ed, '_rewrite', tamper):
            with self.assertRaisesRegex(ValueError, '^check-failed$'):
                ed.replace_occurrence(source, target['id'], png())


class Identity(unittest.TestCase):
    def setUp(self):
        self.src = make_pdf([A + B + TEXT], IM)
        self.occ = listing(self.src)

    def test_ids_are_stable_and_source_bound(self):
        self.assertEqual([o['id'] for o in listing(self.src)], [o['id'] for o in self.occ])
        other = make_pdf([A + B + TEXT + b'% different\n'], IM)
        self.assertTrue(set(o['id'] for o in listing(other)).isdisjoint(o['id'] for o in self.occ))
        with self.assertRaisesRegex(ValueError, '^occurrence-not-found$'):
            ed.replace_occurrence(other, self.occ[0]['id'], png())

    def test_unknown_and_tampered_ids(self):
        good = self.occ[0]['id']
        for bad in ('0' * 64, good[:-1] + ('0' if good[-1] != '0' else '1'), good.upper(), good[:63], None, 'x' * 64):
            with self.assertRaisesRegex(ValueError, '^occurrence-not-found$'):
                ed.replace_occurrence(self.src, bad, png())

    def test_list_shape_and_thumbnails(self):
        result = ed.list_occurrences(self.src)
        self.assertEqual(set(result), {'schema', 'sourceSha256', 'complete', 'occurrences', 'limits'})
        self.assertEqual(result['schema'], 'falsify.image-list.v1')
        self.assertTrue(result['complete'])
        self.assertEqual(result['limits'], ['single-occurrence', 'manual-image', 'text-only-blue'])
        for o in result['occurrences']:
            self.assertEqual(set(o), {'id', 'pageIndex', 'bbox', 'width', 'height', 'shared', 'editable', 'reason', 'thumbnail'})
            import base64
            data = base64.b64decode(o['thumbnail'], validate=True)
            self.assertLessEqual(len(data), 256 * 1024)
            with Image.open(io.BytesIO(data)) as t:
                self.assertLessEqual(max(t.size), 320)


class HonestRejection(unittest.TestCase):
    def reason(self, contents, xobjects=IM, **kw):
        occ = listing(make_pdf(contents, xobjects, **kw))
        return [(o['editable'], o['reason']) for o in occ], occ

    def assertRejects(self, src, occ_id, code):
        with self.assertRaisesRegex(ValueError, '^%s$' % code):
            ed.replace_occurrence(src, occ_id, png())

    def test_rectangular_and_complex_clips_allowed(self):
        got, _ = self.reason([b'q 30 280 50 50 re W n ' + A + b'Q\n'])
        self.assertEqual(got, [(True, None)])
        src = make_pdf([b'q 30 280 50 50 re W n ' + A + b'Q\n'], IM)
        ed.replace_occurrence(src, listing(src)[0]['id'], png())
        got, _ = self.reason([b'q 0 0 300 400 re W n ' + A + b'Q\n'])
        self.assertEqual(got, [(True, None)])
        got, _ = self.reason([b'q 30 280 m 200 300 l 40 390 l h W n ' + A + b'Q\n'])
        self.assertEqual(got, [(True, None)])

    def test_transparency_rejected(self):
        gs = {'/Half': pikepdf.Dictionary(ca=0.5)}
        got, _ = self.reason([b'q /Half gs ' + A + b'Q\n'], extgstate=gs)
        self.assertEqual(got, [(False, 'transparency')])
        masked = {'Im1': lambda p: rgb_image(p, 1, SMask=p.make_indirect(rgb_image(p, 9)))}
        got, _ = self.reason([A], masked)
        self.assertEqual(got, [(False, 'transparency')])
        src = make_pdf([A], IM)
        out, _ = ed.replace_occurrence(src, listing(src)[0]['id'], png(mode='RGBA', alpha=128))
        self.assertTrue(out.startswith(b'%PDF-'))
        out, _ = ed.replace_occurrence(src, listing(src)[0]['id'], png(mode='RGBA', alpha=255))
        self.assertTrue(out.startswith(b'%PDF-'))


    def test_clip_and_later_paint_remain_visible(self):
        content = (b'q 30 280 50 80 re W n ' + A + b'Q\n'
            + b'q 0 0 0 rg 30 320 20 40 re f Q\n' + B + TEXT)
        src = make_pdf([content], IM)
        out, _ = ed.replace_occurrence(src, listing(src)[0]['id'], png())
        before, after = render(src, 0), render(out, 0)
        self.assertEqual(before.pixel(40, 50), after.pixel(40, 50))  # later black paint
        self.assertEqual(before.pixel(100, 80), after.pixel(100, 80))  # outside clip
        self.assertNotEqual(before.pixel(65, 80), after.pixel(65, 80))
        self.assertEqual(before.pixel(230, 80), after.pixel(230, 80))  # shared placement
        self.assertEqual(texts(src), texts(out))

    def test_rectangular_form_bbox_clip_exports(self):
        src = form_source(form_extra={'/BBox': pikepdf.Array([0, 0, 25, 40])})
        target = listing(src)[0]
        self.assertTrue(target['editable'])
        out, _ = ed.replace_occurrence(src, target['id'], png())
        self.assertEqual(texts(src), texts(out))

    def test_soft_mask_matte_rejected(self):
        def masked(p):
            mask = p.make_stream(bytes([128] * 30))
            mask.Type, mask.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            mask.Width, mask.Height = 6, 5
            mask.ColorSpace, mask.BitsPerComponent = pikepdf.Name.DeviceGray, 8
            mask.Matte = pikepdf.Array([0, 0, 0])
            return rgb_image(p, 1, SMask=mask)
        self.assertEqual(listing(make_pdf([A], {'Im1': masked}))[0]['reason'], 'transparency')

    def test_near_axis_noise_and_shear_allowed(self):
        for skew, expected in [('0.00002', True), ('0.1', True)]:
            src = make_pdf([('q 100 %s 0 80 30 280 cm /Im1 Do Q' % skew).encode()], IM)
            self.assertEqual(listing(src)[0]['editable'], expected)
            if expected: ed.replace_occurrence(src, listing(src)[0]['id'], png())

    def test_affine_and_complex_clip_shared_image_with_alpha(self):
        def masked(p):
            mask = p.make_stream(bytes([0, 64, 128, 192, 255, 255] * 5))
            mask.Type, mask.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            mask.Width, mask.Height = 6, 5
            mask.ColorSpace, mask.BitsPerComponent = pikepdf.Name.DeviceGray, 8
            return rgb_image(p, 1, SMask=mask)
        matrices = [b'0 80 -100 0 130 280', b'100 30 20 80 30 280', b'-100 0 0 80 130 280']
        for matrix in matrices:
            for mode in ('RGB', 'RGBA'):
                with self.subTest(matrix=matrix, mode=mode):
                    content = (b'q 0.8 0.8 0.2 rg 0 0 300 400 re f Q\n'
                        + b'q 30 280 m 130 280 l 80 360 l h W n q ' + matrix
                        + b' cm /Im1 Do Q Q\n' + B + TEXT)
                    src = make_pdf([content], {'Im1': masked})
                    occ = listing(src)
                    self.assertTrue(occ[0]['editable'] and occ[0]['shared'])
                    out, _ = ed.replace_occurrence(src, occ[0]['id'], png(mode=mode, alpha=128))
                    before, after = render(src, 0), render(out, 0)
                    self.assertEqual(before.pixel(230, 80), after.pixel(230, 80))
                    self.assertEqual(before.pixel(35, 45), after.pixel(35, 45))
                    self.assertEqual(texts(src), texts(out))

    def test_singular_transform_rejected(self):
        got, _ = self.reason([b'q 100 50 80 40 30 280 cm /Im1 Do Q'])
        self.assertEqual(got, [(False, 'unsupported-transform')])

    def test_soft_mask_rgb_retained_and_rgba_replaced_on_shared_occurrence(self):
        def masked(p):
            mask = p.make_stream(bytes([0, 64, 128, 192, 255, 255] * 5))
            mask.Type, mask.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            mask.Width, mask.Height = 6, 5
            mask.ColorSpace, mask.BitsPerComponent = pikepdf.Name.DeviceGray, 8
            return rgb_image(p, 1, SMask=mask)
        src = make_pdf([A + B + TEXT], {'Im1': masked})
        occ = listing(src)
        self.assertTrue(all(o['editable'] for o in occ))
        for mode, alpha in [('RGB', 255), ('RGBA', 128)]:
            out, _ = ed.replace_occurrence(src, occ[0]['id'], png(mode=mode, alpha=alpha))
            before, after = render(src, 0), render(out, 0)
            self.assertEqual(before.pixel(230, 80), after.pixel(230, 80))
            self.assertNotEqual(before.pixel(80, 80), after.pixel(80, 80))
            self.assertEqual(texts(src), texts(out))
            with pikepdf.open(io.BytesIO(out)) as pdf:
                xo = pdf.Root.Pages.Kids[0].Resources.XObject
                self.assertEqual(xo.Im2.SMask.objgen == xo.Im1.SMask.objgen, mode == 'RGB')
                if mode == 'RGBA': self.assertEqual(set(xo.Im2.SMask.read_bytes()), {128})

    def test_rotated_cropped_page_rejected_but_affine_allowed(self):
        got, _ = self.reason([A], page_extra={0: {'Rotate': 90}})
        self.assertEqual(got, [(False, 'rotated-page')])
        got, _ = self.reason([A], page_extra={0: {'CropBox': pikepdf.Array([0, 0, 200, 400])}})
        self.assertEqual(got, [(False, 'cropped-page')])
        got, _ = self.reason([b'q 0 80 -100 0 130 280 cm /Im1 Do Q\n', b'q 100 0 0 -80 30 360 cm /Im1 Do Q\n'])
        self.assertEqual(got, [(True, None), (True, None)])

    def test_simple_form_editable_but_inline_image_stays_rejected(self):
        def form(p):
            f = p.make_stream(b'q 50 0 0 50 0 0 cm /Im1 Do Q')
            f.Type, f.Subtype, f.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 50, 50])
            f.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=p.make_indirect(rgb_image(p, 1))))
            return f
        inline = b'q 40 0 0 40 200 50 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff EI Q\n'
        src = make_pdf([b'q 1 0 0 1 30 280 cm /Fm1 Do Q\n' + inline + C], dict(IM, Fm1=form))
        occ = listing(src)
        self.assertEqual([(o['editable'], o['reason']) for o in occ],
            [(True, None), (False, 'inline-image'), (True, None)])
        ed.replace_occurrence(src, occ[0]['id'], png())
        self.assertRejects(src, occ[1]['id'], 'inline-image')
        ed.replace_occurrence(src, occ[2]['id'], png())

    def test_later_content_over_the_image_rejected_earlier_content_allowed(self):
        over = b'BT /F1 14 Tf 40 320 Td (Label on figure) Tj ET\n'
        got, _ = self.reason([A + over])
        self.assertEqual(got, [(True, None)])
        src = make_pdf([A + over], IM)
        out, _ = ed.replace_occurrence(src, listing(src)[0]['id'], png())
        self.assertEqual(texts(src), texts(out))
        got, _ = self.reason([over + A])
        self.assertEqual(got, [(True, None)])
        got, _ = self.reason([A + A])        # identical box twice: the lower paint is covered, the upper is editable
        self.assertEqual(got, [(True, None), (True, None)])
        src = make_pdf([A + A], IM)
        with self.assertRaisesRegex(ValueError, '^no-op$'):
            ed.replace_occurrence(src, listing(src)[0]['id'], png())

    def test_no_op_replacement_rejected(self):
        src = make_pdf([A], IM)
        same = Image.new('RGB', (6, 5))
        same.frombytes(pixels(1))
        buf = io.BytesIO(); same.save(buf, 'PNG')
        with self.assertRaisesRegex(ValueError, '^no-op$'):
            ed.replace_occurrence(src, listing(src)[0]['id'], buf.getvalue())


class Bounds(unittest.TestCase):
    def setUp(self):
        self.src = make_pdf([A + C], IM)
        self.id = listing(self.src)[0]['id']

    def test_huge_png_header_rejected_before_any_decode(self):
        with patch.object(Image, 'open', side_effect=AssertionError('decoder reached')) as opened, \
                patch.object(ed, '_scan', side_effect=AssertionError('source parsed')):
            for w, h in ((9000, 10), (2001, 2000), (60000, 60000)):
                with self.assertRaisesRegex(ValueError, '^replacement-too-large$'):
                    ed.replace_occurrence(self.src, self.id, png_claiming(w, h))
            with self.assertRaisesRegex(ValueError, '^replacement-too-large$'):
                ed.replace_occurrence(self.src, self.id, png() + b'\x00' * (4 * 1024 * 1024))
            opened.assert_not_called()

    def test_invalid_png_variants(self):
        good = png()
        bad_crc = good[:29] + bytes([good[29] ^ 1]) + good[30:]
        img = Image.new('P', (4, 4)); buf = io.BytesIO(); img.save(buf, 'PNG')
        trns = good[:33] + chunk(b'tRNS', b'\x00\x00\x00\x00\x00\x00') + good[33:]
        for data, code in ((b'GIF89a' + good, 'replacement-invalid'), (bad_crc, 'replacement-invalid'),
                (buf.getvalue(), 'replacement-invalid'), (trns, 'transparency'), (good[:-12], 'replacement-invalid'),
                ('text', 'replacement-invalid')):
            with self.assertRaisesRegex(ValueError, '^%s$' % code):
                ed.replace_occurrence(self.src, self.id, data)

    def test_malformed_and_oversized_sources(self):
        for data in (b'not a pdf', b'%PDF-1.7\n' + b'\x00garbage' * 50, self.src[: len(self.src) // 3], 42):
            with self.assertRaisesRegex(ValueError, '^malformed-pdf$'):
                ed.list_occurrences(data)
        with self.assertRaisesRegex(ValueError, '^scan-limit$'):
            ed.list_occurrences(make_pdf([b''] * 65))
        with self.assertRaisesRegex(ValueError, '^scan-limit$'):
            ed.list_occurrences(b'%PDF-' + b'0' * (25 * 1024 * 1024))

    def test_corrupt_content_stream_marks_page_not_editable(self):
        pdf = pikepdf.open(io.BytesIO(make_pdf([A, C], IM)))
        pdf.Root.Pages.Kids[0].Contents.write(b'x\x9c\x00\x01garbage', filter=pikepdf.Name.FlateDecode)
        buf = io.BytesIO(); pdf.save(buf)
        result = ed.list_occurrences(buf.getvalue())
        self.assertFalse(result['complete'])
        self.assertEqual([(o['pageIndex'], o['editable']) for o in result['occurrences']], [(1, True)])

    def test_thumbnail_skipped_for_huge_declared_image(self):
        huge = {'Im1': lambda p: rgb_image(p, 1), 'Big': lambda p: rgb_image(p, 2, w=6, h=5)}
        src = make_pdf([A, b'q 50 0 0 50 30 30 cm /Big Do Q\n'], huge)
        pdf = pikepdf.open(io.BytesIO(src))
        big = pdf.Root.Pages.Kids[1].Resources.XObject.Big
        big.Width, big.Height = 5000, 5000           # declared size alone must keep the renderer away
        buf = io.BytesIO(); pdf.save(buf)
        rendered, real = [], pymupdf.Page.get_pixmap
        def spy(page, *args, **kwargs):
            rendered.append(page.number)
            return real(page, *args, **kwargs)
        with patch.object(pymupdf.Page, 'get_pixmap', spy):
            occ = ed.list_occurrences(buf.getvalue())['occurrences']
        self.assertIsNotNone(occ[0]['thumbnail'])
        self.assertIsNone(occ[1]['thumbnail'])
        self.assertEqual(rendered, [0])

    def test_dependency_unavailable(self):
        with patch.dict(sys.modules, {'pikepdf': None}):
            self.assertFalse(ed.available())
            with self.assertRaisesRegex(ValueError, '^dependency-unavailable$'):
                ed.list_occurrences(self.src)
        self.assertTrue(ed.available())


class OutputCheck(unittest.TestCase):
    """The self-check, not the surgery, is what refuses an output that changes anything but the selected paint."""
    def setUp(self):
        self.src = make_pdf([A + B, C + TEXT], IM)
        self.occ = listing(self.src)
        self.real = ed._rewrite

    def tampered(self, mutate):
        def rewrite(pk, source, target, rgb, size):
            output, expected = self.real(pk, source, target, rgb, size)
            pdf = pikepdf.open(io.BytesIO(output))
            mutate(pdf)
            buf = io.BytesIO(); pdf.save(buf)
            return buf.getvalue(), expected
        return rewrite

    def test_alpha_shared_form_control_and_small_unrelated_change(self):
        source = form_source()
        target = listing(source)[0]
        for alpha in (255, 128):
            out, _ = ed.replace_occurrence(source, target['id'], png(mode='RGBA', alpha=alpha))
            self.assertEqual(texts(source), texts(out))
        calls = [0]
        def tamper_actual(pk, src, selected, rgb, size):
            output, expected = self.real(pk, src, selected, rgb, size)
            calls[0] += 1
            if calls[0] == 1:
                with pikepdf.open(io.BytesIO(output)) as pdf:
                    original = pdf.Root.Pages.Kids[0].Resources.XObject.Fm.Resources.XObject.Im1
                    pixels = bytearray(original.read_bytes()); pixels[0] += 1
                    original.write(zlib.compress(bytes(pixels)), filter=pikepdf.Name.FlateDecode)
                    buf = io.BytesIO(); pdf.save(buf); output = buf.getvalue()
            return output, expected
        with patch.object(ed, '_rewrite', tamper_actual):
            with self.assertRaisesRegex(ValueError, '^check-failed$'):
                ed.replace_occurrence(source, target['id'], png(mode='RGBA', alpha=128))

    def test_unrelated_pixel_change_fails(self):
        def other_page_image(pdf):
            im2 = pdf.Root.Pages.Kids[1].Resources.XObject.Im2
            im2.write(zlib.compress(bytes(range(90))), filter=pikepdf.Name.FlateDecode)
        with patch.object(ed, '_rewrite', self.tampered(other_page_image)):
            with self.assertRaisesRegex(ValueError, '^check-failed$'):
                ed.replace_occurrence(self.src, self.occ[0]['id'], png())

    def test_global_shared_xref_replacement_fails(self):
        def global_swap(pdf):
            im1 = pdf.Root.Pages.Kids[0].Resources.XObject.Im1
            im1.write(zlib.compress(bytes(255 - (i % 256) for i in range(90))), filter=pikepdf.Name.FlateDecode)
        with patch.object(ed, '_rewrite', self.tampered(global_swap)):
            with self.assertRaisesRegex(ValueError, '^check-failed$'):
                ed.replace_occurrence(self.src, self.occ[0]['id'], png())

    def test_text_change_fails(self):
        def text(pdf):
            pdf.Root.Pages.Kids[1].Contents = pdf.make_stream(C + TEXT.replace(b'stays', b'moved'))
        with patch.object(ed, '_rewrite', self.tampered(text)):
            with self.assertRaisesRegex(ValueError, '^check-failed$'):
                ed.replace_occurrence(self.src, self.occ[0]['id'], png())

    def test_output_over_bound_rejected_before_output_is_parsed(self):
        with patch.dict(ed.LIMITS, {'maxOutputBytes': 1}), \
                patch.object(ed, '_page_streams', side_effect=AssertionError('output parsed')):
            with self.assertRaisesRegex(ValueError, '^output-too-large$'):
                ed.replace_occurrence(self.src, self.occ[0]['id'], png())


if __name__ == '__main__':
    unittest.main()

"""Single-occurrence raster image replacement for a private experiment copy of a PDF (pikepdf/QPDF + PyMuPDF + Pillow).

Public API (contract: falsify coordination image-occurrence-contract, v1):
  available() -> bool                         every native dependency imports
  list_occurrences(source) -> {schema:'falsify.image-list.v1', sourceSha256, complete, occurrences, limits}
  replace_occurrence(source, occurrence_id, replacement_png) -> (output_pdf_bytes, report)
Failures raise ValueError(fixed_code); a missing dependency raises ValueError('dependency-unavailable').

What is editable: a page-level or simple Form-nested `/Name Do` that paints an opaque raster Image XObject on an unrotated, uncropped page with
an axis-aligned positive-scale CTM, no clip that cuts the image, no transparency (ExtGState alpha/soft mask/blend, image
SMask/Mask/ImageMask), no later-painted content intersecting its box, inside a page whose image paints line up one-to-one
with MuPDF's paint log. The same xref may be painted elsewhere (twice on a page, on other pages, via inherited shared
Resources or repeated Forms): only the selected operator invocation is changed. Form ancestry is limited to three levels,
with rectangular containing BBoxes, no transparency group/masks and a positive axis-aligned final CTM. Inline, clipped,
transparent, rotated or overlapped images remain non-editable; nothing is guessed.

Occurrence id = sha256(source sha256, page index, painting operator path). The path is (content stream index, operator
index) for the page-level Do, extended by (form object, operator index) for nested paints, so two paints of one xref at
an identical bbox get distinct ids, and an id never transfers to other source bytes.

Edit: QPDF tokenizer raw-token surgery renames exactly one Do operand per selected page/Form ancestry stream (all other
tokens keep their raw bytes). Each ancestor Form is cloned with its own Resources/XObject dictionaries; the page gets its
own content stream / Contents array entry and direct Resources/XObject dictionaries. Other entries retain their original
references. Fresh collision-checked names connect only that invocation chain to a new DeviceRGB replacement image. Shared
original Forms/images and all other painting uses remain untouched. The
output is accepted only after re-reading it: same page count/boxes/rotation, identical text words on every page,
identical decoded content streams except the selected chain's renamed operands (including per-invocation Form checks),
identical occurrence list except the selected size,
pixel-identical renders of every other page and of the target page outside the image box (+2 px antialias bleed), and a
visible change inside it. This is an engine render self-check (MuPDF), not an independent fidelity proof.

Bounds: source <= 25 MiB and <= 64 pages, content streams decoded by a bounded Flate inflater (other filters -> page
'scan-limit'), operator/form-depth budgets, PNG <= 4 MiB / <= 4M pixels / each side <= 8192 validated from the IHDR and
chunk table BEFORE Pillow decodes, thumbnails only by clipped page render at <= 320 px when every image on that page is
within the thumbnail decode budget. Native allocations are not OS-isolated; run under the caller's child/timeout.
"""
import base64
import hashlib
import io
import json
import math
import zlib

LIST_SCHEMA = 'falsify.image-list.v1'
REPORT_SCHEMA = 'falsify.image-edit-report.v1'
ID_SCHEMA = 'falsify.image-occurrence.v1'
LIST_LIMITS = ['single-occurrence', 'manual-image', 'text-only-blue']
REPORT_LIMITS = ['engine-render-check', 'domain-review-pending', 'text-only-blue']
REASONS = ('form-image', 'inline-image', 'rotated-page', 'cropped-page', 'clipped-image', 'transparency',
    'unsupported-transform', 'overlapping-content', 'malformed-pdf', 'scan-limit', 'dependency-unavailable')
LIMITS = {'maxSourceBytes': 25 * 1024 * 1024, 'maxOutputBytes': 64 * 1024 * 1024, 'maxPages': 64,
    'maxListed': 256, 'maxStreamBytes': 16 * 1024 * 1024, 'maxPageContentBytes': 32 * 1024 * 1024,
    'maxPageOperators': 200000, 'maxOperators': 1000000, 'maxFormDepth': 3, 'maxPageImages': 2000,
    'maxPngBytes': 4 * 1024 * 1024, 'maxPngPixels': 4000000, 'maxPngSide': 8192,
    'thumbSide': 320, 'thumbBytes': 256 * 1024, 'thumbTotalBase64': 12 * 1024 * 1024, 'thumbImagePixels': 16 * 1024 * 1024,
    'checkTargetPixels': 4000000, 'checkPagePixels': 2000000, 'checkMaxZoom': 2.0, 'checkMinZoom': 0.25,
    'maxPageSide': 14400}
VISIBLE_DELTA = 24          # a channel difference above this counts as a visibly changed pixel
MIN_VISIBLE_PIXELS = 4
BLEED_PX = 2
TOL = 0.01
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
_PAINT_OPS = frozenset(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
_PATH_OPS = frozenset(['m', 'l', 'c', 'v', 'y', 'h'])
_TEXT_SHOW = frozenset(['Tj', 'TJ', "'", '"'])
_IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


class _PageStop(Exception):
    """Stops the scan of one page with a fixed reason; occurrences already seen on it become non-editable."""
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _sha(data): return hashlib.sha256(data).hexdigest()


def available():
    try:
        _deps()
    except ValueError:
        return False
    return True


def _deps():
    try:
        import pikepdf
        import pymupdf
        from PIL import Image, ImageChops
    except ImportError:
        raise ValueError('dependency-unavailable') from None
    return pikepdf, pymupdf, Image, ImageChops


# ---- geometry -----------------------------------------------------------------------------------------------------

def _mul(m, n):
    """m then n (PDF row-vector convention): cm M on CTM C gives _mul(M, C)."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


def _axis(m): return abs(m[1]) <= 1e-9 and abs(m[2]) <= 1e-9


def _rect_through(m, x0, y0, x1, y1):
    xs, ys = [], []
    for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        xs.append(m[0] * x + m[2] * y + m[4]); ys.append(m[1] * x + m[3] * y + m[5])
    return (min(xs), min(ys), max(xs), max(ys))


def _intersect(r, s):
    return (max(r[0], s[0]), max(r[1], s[1]), min(r[2], s[2]), min(r[3], s[3]))


def _contains(outer, inner):
    return outer[0] <= inner[0] + TOL and outer[1] <= inner[1] + TOL and outer[2] >= inner[2] - TOL \
        and outer[3] >= inner[3] - TOL


def _finite(values): return all(isinstance(v, float) and math.isfinite(v) for v in values)


def _num(x):
    v = float(x)
    if not math.isfinite(v): raise _PageStop('malformed-pdf')
    return v


def _box(obj):
    v = [_num(x) for x in obj]
    if len(v) != 4: raise _PageStop('malformed-pdf')
    return (min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3]))


# ---- PDF object helpers -------------------------------------------------------------------------------------------

def _inherited(pk, node, key):
    for _ in range(64):
        if node is None or not isinstance(node, pk.Dictionary): return None
        if key in node: return node[key]
        node = node.get('/Parent')
    return None


def _names(pk, value):
    if value is None: return []
    if isinstance(value, pk.Name): return [str(value)]
    if isinstance(value, pk.Array): return [str(v) for v in value]
    return ['?']


def _stream_bytes(pk, stream):
    """Decoded bytes of a content stream under the decode budget. Only unfiltered and plain Flate streams are decoded."""
    if not isinstance(stream, pk.Stream): raise _PageStop('malformed-pdf')
    filters = _names(pk, stream.get('/Filter'))
    parms = stream.get('/DecodeParms')
    limit = LIMITS['maxStreamBytes']
    raw = stream.read_raw_bytes()
    if not filters:
        if len(raw) > limit: raise _PageStop('scan-limit')
        return raw
    if filters != ['/FlateDecode'] or (parms is not None and not (isinstance(parms, (pk.Dictionary, pk.Array))
            and len(parms) == 0)):
        raise _PageStop('scan-limit')
    inflater = zlib.decompressobj()
    try:
        out = inflater.decompress(raw, limit + 1)
    except zlib.error:
        raise _PageStop('malformed-pdf') from None
    if len(out) > limit or inflater.unconsumed_tail: raise _PageStop('scan-limit')
    return out


def _page_dicts(pk, pdf):
    """Leaf page dictionaries in document order, walked by hand: pikepdf's page list pushes inherited attributes
    (Resources, MediaBox, ...) down into every page object, which would rewrite pages that are not being edited."""
    pages, stack, seen = [], [pdf.Root.get('/Pages')], set()
    while stack:
        node = stack.pop()
        if not isinstance(node, pk.Dictionary): raise ValueError('malformed-pdf')
        if node.is_indirect:
            if node.objgen in seen: raise ValueError('malformed-pdf')
            seen.add(node.objgen)
        if len(seen) > 4 * LIMITS['maxPages'] + 64: raise ValueError('scan-limit')
        kids = node.get('/Kids')
        if node.get('/Type') == pk.Name('/Page') or kids is None:
            pages.append(node)
            if len(pages) > LIMITS['maxPages']: raise ValueError('scan-limit')
            continue
        if not isinstance(kids, pk.Array): raise ValueError('malformed-pdf')
        stack.extend(reversed(list(kids)))
    return pages


def _contents(pk, page):
    c = page.get('/Contents')
    if c is None: return []
    if isinstance(c, pk.Array): return list(c)
    return [c]


def _effective_resources(pk, page):
    r = _inherited(pk, page, '/Resources')
    return r if isinstance(r, pk.Dictionary) else pk.Dictionary()


def _sub(pk, resources, category, name):
    d = resources.get(category)
    if not isinstance(d, pk.Dictionary): return None
    return d.get(name)


def _image_opaque_issue(pk, image):
    # Replacement image dictionaries do not clone optional-content membership or
    # structure-tree associations. A normal visible render cannot prove these.
    if any(key in image for key in ('/OC', '/StructParent', '/StructParents')):
        return 'form-image'
    if image.get('/ImageMask') is True or image.get('/SMask') is not None or image.get('/Mask') is not None:
        return 'transparency'
    smid = image.get('/SMaskInData')
    if smid is not None and int(smid) != 0: return 'transparency'
    return None


def _gs_transparency(pk, egs):
    """None if an ExtGState leaves fill opaque, normal blending and no soft mask, else True; unknown keys count."""
    if not isinstance(egs, pk.Dictionary): return True
    for key in ('/CA', '/ca'):
        if key in egs and abs(_num(egs[key]) - 1.0) > 1e-9: return True
    if '/SMask' in egs and egs['/SMask'] != pk.Name('/None'): return True
    if '/BM' in egs:
        modes = _names(pk, egs['/BM'])
        if not modes or modes[0] not in ('/Normal', '/Compatible'): return True
    return False


# ---- scanning -----------------------------------------------------------------------------------------------------

class _Scanner:
    """Content-stream interpreter tracking CTM, rectangle clips and transparency; records every image paint in order."""

    def __init__(self, pk, scratch, budget):
        self.pk, self.scratch, self.budget = pk, scratch, budget

    def page(self, page, pno, page_reason, mediabox):
        self.events, self.page_ops, self.page_bytes = [], 0, 0
        self.mediabox = mediabox
        self.page_reason = page_reason
        state = {'ctm': _IDENTITY, 'clip': None, 'trans': False, 'tr': 0}
        resources = _effective_resources(self.pk, page)
        self.stack = []
        self.path = {'rect': None, 'complex': False, 'clip': False}
        for k, stream in enumerate(_contents(self.pk, page)):
            ops = self._parse(stream)
            state = self._run(ops, resources, state, [k], 0, set(), ())
        if self.stack: raise _PageStop('malformed-pdf')
        return self.events

    def _parse(self, stream):
        data = _stream_bytes(self.pk, stream)
        self.page_bytes += len(data)
        if self.page_bytes > LIMITS['maxPageContentBytes']: raise _PageStop('scan-limit')
        try:
            return self.pk.parse_content_stream(self.scratch.make_stream(data))
        except Exception:
            raise _PageStop('malformed-pdf') from None

    def _tick(self):
        self.page_ops += 1
        self.budget[0] += 1
        if self.page_ops > LIMITS['maxPageOperators'] or self.budget[0] > LIMITS['maxOperators']:
            raise _PageStop('scan-limit')

    def _run(self, ops, resources, state, prefix, depth, forms, ancestry):
        pk = self.pk
        do_ordinal = 0
        for index, (operands, op) in enumerate(ops):
            self._tick()
            op = str(op)
            try:
                if op == 'q':
                    if operands: raise _PageStop('malformed-pdf')
                    self.stack.append(dict(state))
                elif op == 'Q':
                    if operands: raise _PageStop('malformed-pdf')
                    if not self.stack: raise _PageStop('malformed-pdf')
                    state = self.stack.pop()
                elif op == 'cm':
                    m = tuple(_num(x) for x in operands)
                    if len(m) != 6: raise _PageStop('malformed-pdf')
                    state['ctm'] = _mul(m, state['ctm'])
                elif op == 're':
                    x, y, w, h = (_num(v) for v in operands)
                    if self.path['rect'] is None and not self.path['complex'] and _axis(state['ctm']):
                        self.path['rect'] = _rect_through(state['ctm'], x, y, x + w, y + h)
                    else:
                        self.path['complex'] = True
                elif op in _PATH_OPS:
                    self.path['complex'] = True
                elif op in ('W', 'W*'):
                    self.path['clip'] = True
                elif op in _PAINT_OPS:
                    if self.path['clip']:
                        rect = None if self.path['complex'] else self.path['rect']
                        state['clip'] = 'complex' if rect is None or state['clip'] == 'complex' else \
                            rect if state['clip'] is None else _intersect(state['clip'], rect)
                    self.path = {'rect': None, 'complex': False, 'clip': False}
                elif op == 'gs':
                    if _gs_transparency(pk, _sub(pk, resources, '/ExtGState', operands[0])): state['trans'] = True
                elif op == 'Tr':
                    state['tr'] = int(operands[0])
                elif op in _TEXT_SHOW:
                    if state['tr'] >= 4: state['clip'] = 'complex'
                elif op == 'INLINE IMAGE':
                    image = operands[0]
                    self._event(state, 'inline', prefix + [index], None, None, int(image.width), int(image.height),
                        'inline-image', None, None)
                elif op == 'Do':
                    if len(operands) != 1 or not isinstance(operands[0], pk.Name): raise _PageStop('malformed-pdf')
                    name = operands[0]
                    ordinal, do_ordinal = do_ordinal, do_ordinal + 1
                    xobj = _sub(pk, resources, '/XObject', name)
                    if not isinstance(xobj, pk.Stream): continue
                    subtype = xobj.get('/Subtype')
                    if subtype == pk.Name('/Image'):
                        reason = _image_opaque_issue(pk, xobj)
                        self._event(state, 'xobject', prefix + [index], str(name), xobj.objgen,
                            int(xobj.get('/Width', 0)), int(xobj.get('/Height', 0)), reason,
                            {'stream': prefix[0], 'steps': ancestry + ((index, ordinal, str(name)),)}, xobj)
                    elif subtype == pk.Name('/Form'):
                        self._form(xobj, resources, state, prefix + [index], depth, forms,
                            ancestry + ((index, ordinal, str(name)),))
            except _PageStop:
                raise
            except Exception:
                raise _PageStop('malformed-pdf') from None
        return state

    def _form(self, form, resources, state, prefix, depth, forms, ancestry):
        pk = self.pk
        key = form.objgen
        if depth + 1 > LIMITS['maxFormDepth'] or key in forms: raise _PageStop('scan-limit')
        matrix = tuple(_num(x) for x in form.get('/Matrix', [1, 0, 0, 1, 0, 0]))
        if len(matrix) != 6: raise _PageStop('malformed-pdf')
        inner = dict(state)
        inner['ctm'] = _mul(matrix, state['ctm'])
        if '/BBox' not in form: raise _PageStop('malformed-pdf')
        b = _box(form['/BBox'])
        if _axis(inner['ctm']) and inner['clip'] != 'complex':
            r = _rect_through(inner['ctm'], *b)
            inner['clip'] = r if inner['clip'] is None else _intersect(inner['clip'], r)
        else:
            inner['clip'] = 'complex'
        if '/SMask' in form or '/Group' in form: inner['trans'] = True    # groups may composite; never editable inside
        res = form.get('/Resources')
        res = res if isinstance(res, pk.Dictionary) else resources
        saved_stack, saved_path = self.stack, self.path
        self.stack, self.path = [], {'rect': None, 'complex': False, 'clip': False}
        ops = self._parse(form)
        # A cloned Form needs a separately updated ParentTree/MCR graph when it
        # owns structural/marked content. Likewise /OC can change hidden-layer
        # semantics. Keep these outside the simple-Form replacement contract.
        if any(key in form for key in ('/OC', '/StructParent', '/StructParents')) or any(
                str(op) in ('BDC', 'BMC', 'EMC') for _, op in ops):
            inner['structure_unsupported'] = True
        self._run(ops, res, inner, prefix + [list(key)], depth + 1, forms | {key}, ancestry)
        if self.stack: raise _PageStop('malformed-pdf')
        self.stack, self.path = saved_stack, saved_path

    def _event(self, state, kind, path, name, xref, width, height, reason, surgery, xobj):
        if len(self.events) >= LIMITS['maxPageImages']: raise _PageStop('scan-limit')
        ctm = state['ctm']
        bbox = _rect_through(ctm, 0.0, 0.0, 1.0, 1.0)
        if not _finite(bbox): raise _PageStop('malformed-pdf')
        reason = self.page_reason or reason
        if reason is None and state.get('structure_unsupported'):
            reason = 'form-image'
        if reason is None and not (_axis(ctm) and ctm[0] > 0 and ctm[3] > 0 and bbox[2] - bbox[0] > TOL
                and bbox[3] - bbox[1] > TOL and width > 0 and height > 0):
            reason = 'unsupported-transform'
        if reason is None and (state['clip'] == 'complex' or (state['clip'] is not None
                and not _contains(state['clip'], bbox)) or not _contains(self.mediabox, bbox)):
            reason = 'clipped-image'
        if reason is None and state['trans']: reason = 'transparency'
        self.events.append({'kind': kind, 'path': path, 'name': name, 'xref': xref, 'width': width, 'height': height,
            'pdfBox': bbox, 'reason': reason, 'surgery': surgery})


def _page_geometry(pk, page):
    """(page reason or None, mediabox tuple) for one page."""
    mb = _inherited(pk, page, '/MediaBox')
    if mb is None: raise _PageStop('malformed-pdf')
    mediabox = _box(mb)
    if mediabox[2] - mediabox[0] <= TOL or mediabox[3] - mediabox[1] <= TOL: raise _PageStop('malformed-pdf')
    if max(mediabox[2] - mediabox[0], mediabox[3] - mediabox[1]) > LIMITS['maxPageSide']: raise _PageStop('scan-limit')
    rotate = _inherited(pk, page, '/Rotate')
    cb = _inherited(pk, page, '/CropBox')
    unit = page.get('/UserUnit')
    if rotate is not None and int(rotate) % 360 != 0: return 'rotated-page', mediabox
    if cb is not None and any(abs(a - b) > TOL for a, b in zip(_box(cb), mediabox)): return 'cropped-page', mediabox
    if unit is not None and abs(_num(unit) - 1.0) > 1e-9: return 'unsupported-transform', mediabox
    return None, mediabox


def _top_left(mediabox, box):
    return [round(box[0] - mediabox[0], 3), round(mediabox[3] - box[3], 3), round(box[2] - mediabox[0], 3),
        round(mediabox[3] - box[1], 3)]


def _occ_id(source_sha, pno, kind, path):
    key = json.dumps([ID_SCHEMA, source_sha, pno, kind, path], separators=(',', ':'))
    return _sha(key.encode('ascii'))


def _check_source(source):
    if not isinstance(source, (bytes, bytearray)): raise ValueError('malformed-pdf')
    if len(source) > LIMITS['maxSourceBytes']: raise ValueError('scan-limit')
    if not bytes(source[:5]) == b'%PDF-': raise ValueError('malformed-pdf')
    return bytes(source)


def _open_pike(pk, source):
    try:
        pdf = pk.open(io.BytesIO(source))
    except Exception:
        raise ValueError('malformed-pdf') from None
    try:
        if pdf.is_encrypted: raise ValueError('malformed-pdf')
        if not _page_dicts(pk, pdf): raise ValueError('malformed-pdf')
    except ValueError:
        pdf.close(); raise
    except Exception:
        pdf.close(); raise ValueError('malformed-pdf') from None
    return pdf


def _open_mu(mu, data):
    try:
        doc = mu.open(stream=data, filetype='pdf')
    except Exception:
        raise ValueError('malformed-pdf') from None
    if doc.needs_pass or doc.page_count == 0:
        doc.close(); raise ValueError('malformed-pdf')
    return doc


def _align(mu_page, page_events, mediabox):
    """Line page image paints up with MuPDF's ordered paint log and apply the overlap rule. Mutates reasons."""
    try:
        log = mu_page.get_bboxlog()
    except Exception:
        log = None
    paints = [] if log is None else [(i, r) for i, (t, r) in enumerate(log) if t in ('fill-image', 'fill-imgmask')]
    if log is None or len(paints) != len(page_events):
        for e in page_events:
            if e['reason'] is None: e['reason'] = 'scan-limit'
        return
    for e, (li, rect) in zip(page_events, paints):
        if e['reason'] is not None: continue
        x0, y0, x1, y1 = _top_left(mediabox, e['pdfBox'])
        if max(abs(x0 - rect[0]), abs(y0 - rect[1]), abs(x1 - rect[2]), abs(y1 - rect[3])) > 0.5:
            e['reason'] = 'scan-limit'; continue
        for kind, r in log[li + 1:]:
            if kind == 'ignore-text': continue
            ix0, iy0, ix1, iy1 = max(x0, r[0]), max(y0, r[1]), min(x1, r[2]), min(y1, r[3])
            if ix1 - ix0 > TOL and iy1 - iy0 > TOL:
                e['reason'] = 'overlapping-content'; break


def _scan(pk, mu, source):
    """(source sha, occurrences with private fields, complete, per-page facts) of exact source bytes."""
    sha = _sha(source)
    pdf = _open_pike(pk, source)
    scratch = pk.new()
    doc = None
    try:
        doc = _open_mu(mu, source)
        page_dicts = _page_dicts(pk, pdf)
        if doc.page_count != len(page_dicts): raise ValueError('malformed-pdf')
        occurrences, complete, budget, pages = [], True, [0], []
        scanner = _Scanner(pk, scratch, budget)
        for pno, obj in enumerate(page_dicts):
            facts = {'maxImagePixels': 0, 'thumbs': False, 'mediabox': None}
            pages.append(facts)
            try:
                reason, mediabox = _page_geometry(pk, obj)
            except _PageStop:
                complete = False
                continue
            except Exception:
                complete = False
                continue
            facts['mediabox'] = mediabox
            stop = None
            try:
                events = scanner.page(obj, pno, reason, mediabox)
            except _PageStop as exc:
                events, stop = scanner.events, exc.reason
                complete = False
            if stop:
                for e in events:
                    if e['reason'] is None: e['reason'] = stop
            elif reason is None:
                _align(doc[pno], events, mediabox)
            facts['maxImagePixels'] = max([e['width'] * e['height'] for e in events] + [0])
            facts['thumbs'] = stop is None and reason is None
            for e in events:
                e['pageIndex'] = pno
                e['bbox'] = _top_left(mediabox, e['pdfBox'])
                e['id'] = _occ_id(sha, pno, e['kind'], e['path'])
                occurrences.append(e)
        counts = {}
        for e in occurrences:
            if e['xref'] is not None: counts[e['xref']] = counts.get(e['xref'], 0) + 1
        for e in occurrences:
            e['shared'] = e['xref'] is not None and counts[e['xref']] > 1
        return sha, occurrences, complete, pages
    finally:
        if doc is not None: doc.close()
        scratch.close()
        pdf.close()


# ---- listing ------------------------------------------------------------------------------------------------------

def _thumbnail(mu, page, bbox):
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w <= TOL or h <= TOL: return None
    side = LIMITS['thumbSide']
    for target in (side, side // 2):
        zoom = min(target / w, target / h, 4.0)
        clip = mu.Rect(*bbox)
        irect = (mu.Rect(*bbox) * mu.Matrix(zoom, zoom)).irect      # Rect.transform would mutate clip in place
        if irect.width > side + 1 or irect.height > side + 1 or irect.width < 1 or irect.height < 1: return None
        pix = page.get_pixmap(matrix=mu.Matrix(zoom, zoom), clip=clip, alpha=False)
        if pix.width > side or pix.height > side: return None
        data = pix.tobytes('png')
        if len(data) <= LIMITS['thumbBytes']: return data
    return None


def list_occurrences(source):
    """Image occurrence list of exact source bytes (contract falsify.image-list.v1). Never edits anything."""
    pk, mu, _, _ = _deps()
    source = _check_source(source)
    sha, occurrences, complete, pages = _scan(pk, mu, source)
    if len(occurrences) > LIMITS['maxListed']:
        occurrences, complete = occurrences[:LIMITS['maxListed']], False
    out, spent, doc = [], 0, _open_mu(mu, source)
    try:
        for e in occurrences:
            thumb = None
            facts = pages[e['pageIndex']]
            if facts['thumbs'] and facts['maxImagePixels'] <= LIMITS['thumbImagePixels']:
                try:
                    data = _thumbnail(mu, doc[e['pageIndex']], e['bbox'])
                except Exception:
                    data = None
                if data is not None:
                    encoded = base64.b64encode(data).decode('ascii')
                    if spent + len(encoded) <= LIMITS['thumbTotalBase64']:
                        thumb, spent = encoded, spent + len(encoded)
            out.append({'id': e['id'], 'pageIndex': e['pageIndex'], 'bbox': list(e['bbox']), 'width': e['width'],
                'height': e['height'], 'shared': e['shared'], 'editable': e['reason'] is None, 'reason': e['reason'],
                'thumbnail': thumb})
    finally:
        doc.close()
    return {'schema': LIST_SCHEMA, 'sourceSha256': sha, 'complete': complete, 'occurrences': out,
        'limits': list(LIST_LIMITS)}


# ---- replacement PNG ----------------------------------------------------------------------------------------------

def _png_header(data):
    """(width, height) from the signature, a CRC-valid IHDR and the chunk table only; nothing is inflated or decoded.
    Accepts 8-bit RGB or RGBA, no tRNS, no animation. Raises ValueError(fixed code)."""
    if not isinstance(data, (bytes, bytearray)): raise ValueError('replacement-invalid')
    data = bytes(data)
    if len(data) > LIMITS['maxPngBytes']: raise ValueError('replacement-too-large')
    if len(data) < 45 or not data.startswith(PNG_SIGNATURE) or data[8:16] != b'\x00\x00\x00\x0dIHDR' \
            or zlib.crc32(data[12:29]) != int.from_bytes(data[29:33], 'big'):
        raise ValueError('replacement-invalid')
    width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    depth, color, compression, filt, interlace = data[24:29]
    if not (width and height): raise ValueError('replacement-invalid')
    if width > LIMITS['maxPngSide'] or height > LIMITS['maxPngSide'] or width * height > LIMITS['maxPngPixels']:
        raise ValueError('replacement-too-large')
    if depth != 8 or color not in (2, 6) or compression or filt or interlace > 1: raise ValueError('replacement-invalid')
    pos, seen_idat, end = 33, False, False
    while pos + 12 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], 'big')
        kind = data[pos + 4:pos + 8]
        if pos + 12 + length > len(data): raise ValueError('replacement-invalid')
        if kind == b'tRNS': raise ValueError('transparency')
        if kind in (b'acTL', b'fcTL', b'fdAT', b'IHDR'): raise ValueError('replacement-invalid')
        seen_idat = seen_idat or kind == b'IDAT'
        pos += 12 + length
        if kind == b'IEND':
            end = True; break
    if not (seen_idat and end): raise ValueError('replacement-invalid')
    return width, height


def _decode_png(Image, data, size):
    try:
        with Image.open(io.BytesIO(data), formats=['PNG']) as img:
            if img.size != size or img.mode not in ('RGB', 'RGBA') or getattr(img, 'is_animated', False):
                raise ValueError('replacement-invalid')
            img.load()
            if img.mode == 'RGBA':
                if img.getchannel('A').getextrema() != (255, 255): raise ValueError('transparency')
                img = img.convert('RGB')
            return img.tobytes()
    except ValueError:
        raise
    except Exception:
        raise ValueError('replacement-invalid') from None


# ---- surgery ------------------------------------------------------------------------------------------------------

def _tokens(pk, scratch, data):
    """Raw QPDF tokens of one decoded content stream; their concatenation must reproduce the stream byte for byte."""
    page = scratch.pages[0]
    page.obj.Contents = scratch.make_stream(data)
    tokens = []

    class _Collect(pk.TokenFilter):
        def handle_token(self, token):
            tokens.append((token.type_, bytes(token.raw_value)))
            return token

    page.get_filtered_contents(_Collect())
    if any(t == pk.TokenType.bad for t, _ in tokens) or b''.join(r for _, r in tokens) != data:
        raise ValueError('malformed-pdf')
    return tokens


def _rename_do(pk, scratch, data, do_ordinal, new_name):
    """data with the operand of its do_ordinal-th Do operator (0-based) replaced by /new_name; nothing else changes."""
    tokens = _tokens(pk, scratch, data)
    skip = (pk.TokenType.space, pk.TokenType.comment)
    seen = 0
    for i, (t, raw) in enumerate(tokens):
        if t == pk.TokenType.word and raw == b'Do':
            if seen == do_ordinal:
                j = i - 1
                while j >= 0 and tokens[j][0] in skip: j -= 1
                if j < 0 or tokens[j][0] != pk.TokenType.name_: raise ValueError('malformed-pdf')
                tokens[j] = (tokens[j][0], b'/' + new_name.encode('ascii'))
                return b''.join(r for _, r in tokens)
            seen += 1
    raise ValueError('malformed-pdf')


def _instructions(pk, scratch, data):
    return [pk.unparse_content_stream([(o, op)]) for o, op in pk.parse_content_stream(scratch.make_stream(data))]


def _isolated_resources(pk, resources, name, replacement):
    xobjects = resources.get('/XObject')
    if not isinstance(xobjects, pk.Dictionary): raise ValueError('malformed-pdf')
    copies = pk.Dictionary({key: xobjects.get(key) for key in xobjects.keys()})
    copies[pk.Name('/' + name)] = replacement
    result = pk.Dictionary({key: resources.get(key) for key in resources.keys()})
    result.XObject = copies
    return result


def _rewrite(pk, source, target, rgb, size):
    """Clone only the selected page/Form invocation chain. Other uses retain their original streams and resources."""
    pdf = _open_pike(pk, source)
    scratch = pk.new()
    try:
        scratch.add_blank_page()
        page = _page_dicts(pk, pdf)[target['pageIndex']]
        streams = _contents(pk, page)
        k = target['surgery']['stream']
        steps = target['surgery']['steps']
        try:
            datas = [_stream_bytes(pk, s) for s in streams]
        except _PageStop as exc:
            raise ValueError(exc.reason) from None
        image = pdf.make_stream(zlib.compress(rgb, 9))
        image.Type, image.Subtype = pk.Name('/XObject'), pk.Name('/Image')
        image.Width, image.Height = size
        image.ColorSpace, image.BitsPerComponent, image.Filter = pk.Name('/DeviceRGB'), 8, pk.Name('/FlateDecode')
        changed_forms = {}

        def rewrite_stream(data, resources, level, positions, name_data):
            index, ordinal, old_name = steps[level]
            xobjects = resources.get('/XObject')
            if not isinstance(xobjects, pk.Dictionary): raise ValueError('malformed-pdf')
            original = xobjects.get(pk.Name(old_name))
            if not isinstance(original, pk.Stream): raise ValueError('malformed-pdf')
            if level + 1 == len(steps):
                if original.get('/Subtype') != pk.Name.Image: raise ValueError('malformed-pdf')
                replacement = image
            else:
                if original.get('/Subtype') != pk.Name.Form: raise ValueError('malformed-pdf')
                child_resources = original.get('/Resources')
                child_resources = child_resources if isinstance(child_resources, pk.Dictionary) else resources
                try:
                    child_data = _stream_bytes(pk, original)
                except _PageStop as exc:
                    raise ValueError(exc.reason) from None
                child_positions = positions + (index,)
                child_data, child_resources = rewrite_stream(child_data, child_resources, level + 1,
                    child_positions, [child_data])
                replacement = pdf.make_stream(zlib.compress(child_data, 9))
                # Compression metadata belongs to the newly encoded stream; all Form semantics are retained.
                for key in original.keys():
                    if str(key) not in ('/Length', '/Filter', '/DecodeParms', '/Resources'):
                        replacement[key] = original.get(key)
                replacement.Filter = pk.Name.FlateDecode
                replacement.Resources = child_resources
                changed_forms[(k,) + child_positions] = child_data
            n = 1
            while pk.Name('/Im%d' % n) in xobjects or any(b'/Im%d' % n in d for d in name_data): n += 1
            new_name = 'Im%d' % n
            rewritten = _rename_do(pk, scratch, data, ordinal, new_name)
            before, after = _instructions(pk, scratch, data), _instructions(pk, scratch, rewritten)
            expected_op = pk.unparse_content_stream([([pk.Name('/' + new_name)], pk.Operator('Do'))])
            if not 0 <= index < len(before) or len(before) != len(after) or after[index] != expected_op \
                    or any(a != b for i, (a, b) in enumerate(zip(before, after)) if i != index) \
                    or before[index] != pk.unparse_content_stream([([pk.Name(old_name)], pk.Operator('Do'))]):
                raise ValueError('malformed-pdf')
            return rewritten, _isolated_resources(pk, resources, new_name, replacement)

        rewritten, resources = rewrite_stream(datas[k], _effective_resources(pk, page), 0, (), datas)
        page.Resources = resources
        content = pdf.make_stream(zlib.compress(rewritten, 9))
        content.Filter = pk.Name.FlateDecode
        if isinstance(page.get('/Contents'), pk.Array):
            arr = pk.Array(list(page.Contents))
            arr[k] = content
            page.Contents = arr
        else:
            page.Contents = content
        buf = io.BytesIO()
        pdf.save(buf, compress_streams=False, stream_decode_level=pk.StreamDecodeLevel.none,
            fix_metadata_version=False, deterministic_id=True)
        expected = list(datas)
        expected[k] = rewritten
        return buf.getvalue(), {'pageStreams': expected, 'formStreams': changed_forms}
    finally:
        scratch.close()
        pdf.close()


# ---- output check -------------------------------------------------------------------------------------------------

def _page_streams(pk, pdf):
    out = []
    for page in _page_dicts(pk, pdf):
        try:
            out.append([_stream_bytes(pk, s) for s in _contents(pk, page)])
        except _PageStop:
            out.append(None)
    return out


def _form_streams(pk, pdf):
    """Decoded reachable Form streams keyed by page/stream/operator positions, including repeated invocations.
    Object numbers may change during save; invocation positions may not. No unreferenced resources are traversed.
    """
    result, budget, scratch = {}, [0, 0], pk.new()
    try:
        def walk(data, resources, path, seen):
            budget[0] += len(data)
            if budget[0] > LIMITS['maxPageContentBytes'] * LIMITS['maxPages']: raise ValueError('scan-limit')
            ops = pk.parse_content_stream(scratch.make_stream(data))
            budget[1] += len(ops)
            if budget[1] > LIMITS['maxOperators']: raise ValueError('scan-limit')
            for index, (operands, op) in enumerate(ops):
                if str(op) != 'Do': continue
                if len(operands) != 1 or not isinstance(operands[0], pk.Name): raise ValueError('malformed-pdf')
                form = _sub(pk, resources, '/XObject', operands[0])
                if not isinstance(form, pk.Stream) or form.get('/Subtype') != pk.Name.Form: continue
                if len(seen) >= LIMITS['maxFormDepth'] or form.objgen in seen: raise ValueError('scan-limit')
                child = _stream_bytes(pk, form)
                position = path + (index,)
                result[position] = child
                res = form.get('/Resources')
                walk(child, res if isinstance(res, pk.Dictionary) else resources, position, seen | {form.objgen})
        for pno, page in enumerate(_page_dicts(pk, pdf)):
            for k, stream in enumerate(_contents(pk, page)):
                walk(_stream_bytes(pk, stream), _effective_resources(pk, page), (pno, k), set())
        return result
    except _PageStop as exc:
        raise ValueError(exc.reason) from None
    finally:
        scratch.close()


def _zoom(rect, cap):
    zoom = min(LIMITS['checkMaxZoom'], math.sqrt(cap / max(rect.width * rect.height, 1.0)))
    if zoom < LIMITS['checkMinZoom']: raise ValueError('scan-limit')
    return zoom


def _position(path):
    """Operator positions of a path. The writer renumbers objects, so nested form object numbers are not compared."""
    return [None if isinstance(p, list) else p for p in path]


def _verify(pk, mu, Image, ImageChops, source, output, scan, target, expected_streams, size):
    if len(output) > LIMITS['maxOutputBytes']: raise ValueError('output-too-large')
    fail = ValueError('check-failed')
    pno = target['pageIndex']
    a_pdf, b_pdf = _open_pike(pk, source), _open_pike(pk, output)
    try:
        a_streams, b_streams = _page_streams(pk, a_pdf), _page_streams(pk, b_pdf)
        expected_forms = _form_streams(pk, a_pdf)
        expected_forms.update({(pno,) + path: data for path, data in expected_streams['formStreams'].items()})
        if _form_streams(pk, b_pdf) != expected_forms: raise fail
    finally:
        a_pdf.close(); b_pdf.close()
    if len(a_streams) != len(b_streams): raise fail
    for i, (a, b) in enumerate(zip(a_streams, b_streams)):
        if b is None or b != (expected_streams['pageStreams'] if i == pno else a): raise fail
    a, b = _open_mu(mu, source), _open_mu(mu, output)
    try:
        if a.page_count != b.page_count: raise fail
        for i in range(a.page_count):
            pa, pb = a[i], b[i]
            if (tuple(pa.mediabox), tuple(pa.cropbox), pa.rotation) != (tuple(pb.mediabox), tuple(pb.cropbox), pb.rotation):
                raise fail
            if pa.get_text('words', sort=False) != pb.get_text('words', sort=False): raise fail
            zoom = _zoom(pa.rect, LIMITS['checkTargetPixels'] if i == pno else LIMITS['checkPagePixels'])
            m = mu.Matrix(zoom, zoom)
            ra, rb = pa.get_pixmap(matrix=m, alpha=False, colorspace=mu.csRGB), \
                pb.get_pixmap(matrix=m, alpha=False, colorspace=mu.csRGB)
            if (ra.width, ra.height) != (rb.width, rb.height): raise fail
            if i != pno:
                if ra.samples != rb.samples: raise fail
                continue
            ia = Image.frombytes('RGB', (ra.width, ra.height), ra.samples)
            ib = Image.frombytes('RGB', (rb.width, rb.height), rb.samples)
            diff = ImageChops.difference(ia, ib)
            x0, y0, x1, y1 = target['bbox']
            roi = (max(0, math.floor(x0 * zoom) - BLEED_PX), max(0, math.floor(y0 * zoom) - BLEED_PX),
                min(ra.width, math.ceil(x1 * zoom) + BLEED_PX), min(ra.height, math.ceil(y1 * zoom) + BLEED_PX))
            changed = diff.getbbox()
            if changed is None: raise ValueError('no-op')
            if not _contains(roi, changed): raise fail
            r, g, bl = diff.crop(roi).split()
            peak = ImageChops.lighter(ImageChops.lighter(r, g), bl)
            if sum(peak.point(lambda v: 255 if v > VISIBLE_DELTA else 0).histogram()[255:]) < MIN_VISIBLE_PIXELS:
                raise ValueError('no-op')
    finally:
        a.close(); b.close()
    _, after, complete, _ = _scan(pk, mu, output)
    before = scan['occurrences']
    if len(after) != len(before) or complete != scan['complete']: raise fail
    for x, y in zip(before, after):
        same = (x['pageIndex'], x['bbox'], x['reason'], x['kind']) == (y['pageIndex'], y['bbox'], y['reason'], y['kind'])
        dims = (y['width'], y['height']) == (size if x is target else (x['width'], x['height']))
        if not (same and dims and _position(x['path']) == _position(y['path'])): raise fail


def replace_occurrence(source, occurrence_id, replacement_png):
    """(output PDF bytes, falsify.image-edit-report.v1) replacing exactly the selected image paint. Raises ValueError."""
    if not isinstance(occurrence_id, str) or len(occurrence_id) != 64 or any(c not in '0123456789abcdef'
            for c in occurrence_id):
        raise ValueError('occurrence-not-found')
    size = _png_header(replacement_png)
    pk, mu, Image, ImageChops = _deps()
    source = _check_source(source)
    sha, occurrences, complete, _ = _scan(pk, mu, source)
    target = next((e for e in occurrences if e['id'] == occurrence_id), None)
    if target is None: raise ValueError('occurrence-not-found')
    if target['reason'] is not None: raise ValueError(target['reason'])
    rgb = _decode_png(Image, bytes(replacement_png), size)
    output, expected = _rewrite(pk, source, target, rgb, size)
    _verify(pk, mu, Image, ImageChops, source, output, {'occurrences': occurrences, 'complete': complete}, target,
        expected, size)
    out_sha = _sha(output)
    return output, {'schema': REPORT_SCHEMA, 'sourceSha256': sha, 'occurrenceId': occurrence_id, 'outputSha256': out_sha,
        'pageIndex': target['pageIndex'], 'bbox': list(target['bbox']), 'changedOccurrences': 1, 'check': 'passed',
        'limits': list(REPORT_LIMITS)}

"""Deterministic SYNTHETIC regression corpus for the PDF editor foundation (generator only; not a test module).

Every document is generated in memory with the installed PyMuPDF from fixed synthetic sentences; nothing is read from
or written to disk, and no real paper, researcher record or model output is involved. The bytes are test fixtures,
not publication artifacts.

Interface:
  CASE_IDS                      -> tuple of case ids in a fixed order
  build_case(case_id)           -> case dict (below); same id -> byte-identical source/output
  build_corpus()                -> [build_case(i) for i in CASE_IDS]
  page_regions(pdf_bytes, page_index, text) -> tight per-line [x0,y0,x1,y1] list for a unique on-page anchor

Case dict:
  id, schema 'falsify.pdf-foundation-corpus.v1', description
  source, output                bytes (output is the simulated editor result)
  edits                         [{pageIndex, before, after}] exactly as a user would select them
  pageMap                       sourcePageMap entries {sourcePageIndex, outputPageIndex, continuationPageIndices}
  pageCount                     {source, output}
  selected                      [{pageIndex, regions, styles}] per edit, from the SOURCE: regions are tight per-line
                                rectangles in MuPDF unrotated page points (CropBox origin); styles {font, size, color:int RGB}.
                                An ambiguous anchor lists every candidate line instead of guessing.
  expected                      {outsidePreservation: preserved|defect, insideTypography: consistent|defect|n/a,
                                 planStatus: resolved|ambiguous|resolved-or-partial|none,
                                 qaGate: must-not-fail|must-not-pass, capability: bool,
                                 defect: None|{kind, pageIndex, regions}}
qaGate is the policy target; capability=True marks a case the current engine is not expected to recognise, so a
matrix records the observed verdict instead of gating on it. Page index 1 (the second page) is an untouched control page.
"""
import pymupdf

SCHEMA = 'falsify.pdf-foundation-corpus.v1'
W, H = 595.0, 842.0
HEADER = 'Synthetic foundation corpus header'
BODY = 'The measured response holds under the stated assumptions.'
PARA_B = ['A second paragraph that the editor must not touch at all.',
    'It continues on a further line with ordinary words.']
CONTROL = ['This control page is never selected for editing.', 'Its rendering must survive export unchanged.']
FIGURE = (72, 300, 272, 400)
BLACK, RED = (0, 0, 0), (1, 0, 0)

def _t(x, y, text, font='helv', size=11, color=BLACK): return ('text', x, y, text, font, size, color)

def _runs(x, y, runs, size=11):
    """Consecutive runs [(text, font, color)] on one baseline, advancing by each run's own width."""
    out = []
    for text, font, color in runs:
        out.append(_t(x, y, text, font, size, color)); x += pymupdf.get_text_length(text, fontname=font, fontsize=size)
    return out

def _page(body, header_y=50, figure=True, figure_damage=False, overlay=None):
    items = [_t(72, header_y, HEADER, size=9)] + body
    if figure:
        x0, y0, x1, y1 = FIGURE
        items += [('rect', FIGURE), ('line', (x0, y1), (x1, y0) if not figure_damage else (x1, y0 + 40))]
        if not figure_damage: items.append(('fill', (x1 - 20, y1 - 20, x1 - 8, y1 - 8)))
    if overlay: items.append(('cover', overlay))
    return items + [_t(290, 800, 'Page 1', size=9)]

def _control():
    return [_t(72, 50, HEADER, size=9), _t(72, 100, CONTROL[0]), _t(72, 116, CONTROL[1]), _t(290, 800, 'Page 2', size=9)]

def _png():
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
    for y in range(8):
        for x in range(8): pix.set_pixel(x, y, (32 * x, 32 * y, 128))
    return pix.tobytes('png')

def _render(pages, rotate=None, crop=None):
    doc = pymupdf.open()
    for spec in pages:
        page = doc.new_page(width=W, height=H)
        image_xref = 0
        for it in spec:
            kind = it[0]
            if kind == 'text': page.insert_text((it[1], it[2]), it[3], fontname=it[4], fontsize=it[5], color=it[6])
            elif kind == 'rect': page.draw_rect(pymupdf.Rect(it[1]), color=BLACK, width=1)
            elif kind == 'line': page.draw_line(it[1], it[2], color=BLACK, width=1)
            elif kind == 'fill': page.draw_rect(pymupdf.Rect(it[1]), color=None, fill=BLACK)
            elif kind == 'cover': page.draw_rect(pymupdf.Rect(it[1]), color=None, fill=(1, 1, 1))
            elif kind == 'image':  # every placement after the first reuses the same image XObject
                if image_xref: page.insert_image(pymupdf.Rect(it[1]), xref=image_xref)
                else: image_xref = page.insert_image(pymupdf.Rect(it[1]), stream=_png())
    if crop: doc[0].set_cropbox(pymupdf.Rect(crop))
    if rotate: doc[0].set_rotation(rotate)
    doc.set_metadata({})
    return doc.tobytes(garbage=4, deflate=True, no_new_id=True)

def _pair(src_body, out_body, **kw):
    render = {k: kw.pop(k) for k in ('rotate', 'crop') if k in kw}
    return _render([_page(src_body), _control()], **render), _render([_page(out_body, **kw), _control()], **render)

def _int_rgb(c): return c if isinstance(c, int) else 0

def _box(rect): return [round(v, 3) for v in rect]

def page_regions(pdf_bytes, page_index, text):
    """Tight rectangles (one per line per occurrence) of text, in MuPDF page space: unrotated points measured from the
    CropBox top-left, exactly as MuPDF search/extraction reports them."""
    page = pymupdf.open(stream=pdf_bytes, filetype='pdf')[page_index]
    return [_box(r) for r in page.search_for(text, quads=False)]

def _styles(pdf_bytes, page_index, regions):
    page = pymupdf.open(stream=pdf_bytes, filetype='pdf')[page_index]
    seen = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                box = pymupdf.Rect(span['bbox'])
                if any(box.intersects(pymupdf.Rect(r)) for r in regions):
                    style = {'font': span['font'], 'size': round(span['size'], 2), 'color': _int_rgb(span['color'])}
                    if style not in seen: seen.append(style)
    return seen

def _selected(src, edits, anchors=None):
    out = []
    for k, e in enumerate(edits):
        pieces = (anchors or {}).get(k, [e['before']])
        regions = [r for piece in pieces for r in page_regions(src, e['pageIndex'], piece)]
        out.append({'pageIndex': e['pageIndex'], 'regions': regions, 'styles': _styles(src, e['pageIndex'], regions)})
    return out

def _expected(outside='preserved', inside='consistent', plan='resolved', capability=False, defect=None):
    gate = 'must-not-fail' if outside == 'preserved' and inside in ('consistent', 'n/a') and plan != 'ambiguous' else 'must-not-pass'
    return {'outsidePreservation': outside, 'insideTypography': inside, 'planStatus': plan, 'qaGate': gate,
        'capability': capability, 'defect': defect}

def _std(word='holds', runs=None):
    line = runs or [(BODY.replace('holds', word), 'helv', BLACK)]
    return _runs(72, 100, line) + [_t(72, 160, PARA_B[0]), _t(72, 176, PARA_B[1])]

EDIT = [{'pageIndex': 0, 'before': 'response holds under', 'after': 'response fails under'}]
PRE, POST = 'The measured response ', ' under the stated assumptions.'

def _std_case(description, out_body=None, expected=None, **kw):
    src, out = _pair(_std(), out_body if out_body is not None else _std('fails'), **kw)
    return description, src, out, EDIT, None, expected or _expected()

def _defect(kind, regions, **kw): return _expected(outside='defect', defect={'kind': kind, 'pageIndex': 0, 'regions': regions}, **kw)

def _c_valid():
    return _std_case('Same-length wording-only change at the same position; everything else identical.')

def _c_red():
    out = _std(runs=[(PRE, 'helv', BLACK), ('fails', 'helv', RED), (POST, 'helv', BLACK)])
    return _std_case('Edited word rendered red; outside preserved, inside typography defect (color).', out,
        _expected(inside='defect', capability=True))

def _c_font():
    out = _runs(72, 100, [(PRE, 'helv', BLACK)]) + _runs(72 + pymupdf.get_text_length(PRE, fontname='helv', fontsize=11),
        100, [('fails', 'tiro', BLACK)], size=13)
    out += _runs(out[-1][1] + pymupdf.get_text_length('fails', fontname='tiro', fontsize=13), 100, [(POST, 'helv', BLACK)])
    out += [_t(72, 160, PARA_B[0]), _t(72, 176, PARA_B[1])]
    return _std_case('Edited word switched to Times 13pt; inside typography defect (font and size).', out,
        _expected(inside='defect', capability=True))

def _c_paragraph():
    out = _runs(72, 100, [(BODY.replace('holds', 'fails'), 'helv', BLACK)]) + [_t(72, 160, PARA_B[0]),
        _t(72, 176, 'It continues on a further line with')]
    return _std_case('Unselected same-page paragraph lost its last words.', out,
        _defect('unselected_text', page_regions(_pair(_std(), [])[0], 0, 'ordinary words.')))

def _c_vector():
    return _std_case('Unselected simple vector figure on the edited page changed (diagonal moved, square removed).',
        expected=_defect('unselected_vector', [list(map(float, FIGURE))], capability=True), figure_damage=True)

def _c_overlay():
    return _std_case('White rectangle covers an unselected paragraph line; extracted text unchanged.',
        expected=_defect('white_overlay', [[70.0, 150.0, 400.0, 164.0]]), overlay=(70, 150, 400, 164))

def _c_header():
    return _std_case('Running header on the edited page moved down 8pt.',
        expected=_defect('moved_header', page_regions(_pair(_std(), [])[0], 0, HEADER), capability=True), header_y=58)

QUOTE = 'as reported in prior work'

def _c_ambiguous():
    lines = lambda first: [_t(72, 100, f'Results agree, {first}, for small samples.'),
        _t(72, 116, f'Larger samples differ, {QUOTE}, at scale.'), _t(72, 160, PARA_B[0])]
    src, out = _pair(lines(QUOTE), lines('as noted in earlier work'))
    edits = [{'pageIndex': 0, 'before': QUOTE, 'after': 'as noted in earlier work'}]
    return ('Selected quote occurs twice on the page; the anchor must be reported ambiguous, never guessed.',
        src, out, edits, None, _expected(plan='ambiguous', capability=True))

def _c_multiline():
    body = lambda last: (_runs(72, 100, [('We define the ', 'helv', BLACK), ('robust estimator', 'hebo', BLACK)])
        + [_t(72, 116, f'as the {last} of pairwise slopes.'), _t(72, 160, PARA_B[0])])
    src, out = _pair(body('median'), body('middle'))
    edits = [{'pageIndex': 0, 'before': 'robust estimator as the median', 'after': 'robust estimator as the middle'}]
    return ('Selection spans two lines and two fonts (bold + regular); one region per line, two styles.', src, out,
        edits, {0: ['robust estimator', 'as the median']}, _expected(plan='resolved-or-partial'))

def _c_columns():
    left = ['Column one notes the effect is small', 'in the first cohort only.']
    right = lambda w: [f'Column two notes the effect is {w}', 'in the second cohort only.']
    body = lambda w: ([_t(50, 100 + 16 * i, s, size=10) for i, s in enumerate(left)]
        + [_t(315, 100 + 16 * i, s, size=10) for i, s in enumerate(right(w))])
    src, out = _pair(body('large'), body('clear'))
    edits = [{'pageIndex': 0, 'before': 'the effect is large', 'after': 'the effect is clear'}]
    return ('Two-column page; edit in the right column next to a similar left-column line.', src, out, edits, None,
        _expected())

def _signed(slope, offset): return [_t(72, 100, f'Estimated slope was {slope} with offset {offset} in run one.'),
    _t(72, 160, PARA_B[0])]

SIGN_EDIT = [{'pageIndex': 0, 'before': 'slope was -0.42', 'after': 'slope was -0.47'}]

def _c_minus():
    src, out = _pair(_signed('-0.42', '-3.1'), _signed('-0.47', '-3.1'))
    return ('Signed negatives: selected -0.42 becomes -0.47; unselected -3.1 on the same line keeps its sign.',
        src, out, SIGN_EDIT, None, _expected())

def _c_minus_erased():
    src, out = _pair(_signed('-0.42', '-3.1'), _signed('-0.47', '3.1'))
    return ('Unselected -3.1 lost its hyphen-minus sign while the selected value was edited.', src, out, SIGN_EDIT,
        None, _defect('erased_sign', page_regions(src, 0, '-3.1'), capability=True))

def _c_image():
    body = lambda w: [_t(72, 100, f'The figure below is shown {w}.'), ('image', (72, 140, 172, 240)),
        ('image', (300, 140, 400, 240))]
    src, out = _pair(body('twice'), body('again'))
    edits = [{'pageIndex': 0, 'before': 'shown twice', 'after': 'shown again'}]
    return ('One image XObject placed twice on the edited page; both occurrences must survive.', src, out, edits,
        None, _expected())

def _c_rotated():
    src, out = _pair(_std(), _std('fails'), rotate=90, crop=(36, 36, 559, 806))
    return ('Edited page is cropped and rotated 90 degrees; regions are in unrotated points; partial is acceptable.',
        src, out, EDIT, None, _expected(plan='resolved-or-partial', capability=True))

def _c_noop():
    src = _render([_page(_std()), _control()])
    doc = pymupdf.open(stream=src, filetype='pdf')
    out = doc.tobytes(garbage=4, deflate=True, clean=True, no_new_id=True)
    return ('No-op roundtrip (re-saved, content streams cleaned) with no edits; a rendering-noise control.', src, out,
        [], None, _expected(inside='n/a', plan='none'))

_CASES = {'valid_same_length_wording': _c_valid, 'edited_glyph_red': _c_red, 'edited_font_size': _c_font,
    'damaged_unselected_paragraph': _c_paragraph, 'damaged_unselected_vector': _c_vector,
    'white_overlay': _c_overlay, 'moved_header': _c_header, 'ambiguous_repeated_quote': _c_ambiguous,
    'multiline_mixed_font': _c_multiline, 'two_column': _c_columns, 'minus_sign_preservation': _c_minus,
    'minus_sign_erased': _c_minus_erased, 'shared_image_occurrence': _c_image, 'rotated_cropped': _c_rotated,
    'noop_roundtrip': _c_noop}
CASE_IDS = tuple(_CASES)

def build_case(case_id):
    description, src, out, edits, anchors, expected = _CASES[case_id]()
    n_src = pymupdf.open(stream=src, filetype='pdf').page_count
    n_out = pymupdf.open(stream=out, filetype='pdf').page_count
    return {'id': case_id, 'schema': SCHEMA, 'description': description, 'source': src, 'output': out,
        'edits': [dict(e) for e in edits], 'selected': _selected(src, edits, anchors),
        'pageMap': [{'sourcePageIndex': i, 'outputPageIndex': i, 'continuationPageIndices': []} for i in range(n_src)],
        'pageCount': {'source': n_src, 'output': n_out}, 'expected': expected}

def build_corpus(): return [build_case(i) for i in CASE_IDS]

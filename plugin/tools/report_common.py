"""Shared pieces for the HTML reports: PDF crops with highlights, word diffs, page shell."""
import base64
import difflib
import html
import re

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz  # PyMuPDF before 1.24
    except ImportError:
        fitz = None

CROP_ZOOM = 2.0
PAGE_ZOOM = 1.2


def esc(text):
    return html.escape(str(text if text is not None else ""))


def png_tag(png, alt, cls="crop"):
    return f'<img class="{cls}" alt="{esc(alt)}" src="data:image/png;base64,{base64.b64encode(png).decode()}">'


def _norm(text):
    text = text.replace("\\|", "|").replace("−", "-").replace("­", "")
    return re.sub(r"\s+", " ", text).strip().strip("\"'“”")


def _search(page, text):
    flags = getattr(fitz, "TEXT_DEHYPHENATE", 0)
    try:
        return page.search_for(text, flags=flags)
    except TypeError:
        return page.search_for(text)


def find_rects(page, quote):
    """Rects for a quote on a page; falls back to its first and last words."""
    q = _norm(quote)
    if not q:
        return []
    hits = _search(page, q)
    if hits:
        return hits
    words = q.split()
    if len(words) >= 6:
        head, tail = " ".join(words[:6]), " ".join(words[-6:])
        hits = _search(page, head) + _search(page, tail)
    return hits


def crop(doc, page_no, quote, pad=28):
    """PNG of the region around a quote with the quote highlighted, or None."""
    if fitz is None or doc is None or not (1 <= page_no <= doc.page_count):
        return None
    page = doc[page_no - 1]
    rects = find_rects(page, quote)
    if not rects:
        return None
    for r in rects:
        annot = page.add_highlight_annot(r)
        annot.set_colors(stroke=(1.0, 0.85, 0.2))
        annot.update()
    box = fitz.Rect(rects[0])
    for r in rects[1:]:
        box |= r
    # widen to the text column the quote sits in
    for b in page.get_text("blocks"):
        block = fitz.Rect(b[:4])
        if block.intersects(box):
            box.x0, box.x1 = min(box.x0, block.x0), max(box.x1, block.x1)
    box = fitz.Rect(box.x0 - 8, box.y0 - pad, box.x1 + 8, box.y1 + pad) & page.rect
    png = page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=box).tobytes("png")
    for annot in list(page.annots() or []):
        page.delete_annot(annot)
    return png


def page_png(doc, page_no):
    if fitz is None or doc is None or not (1 <= page_no <= doc.page_count):
        return None
    return doc[page_no - 1].get_pixmap(matrix=fitz.Matrix(PAGE_ZOOM, PAGE_ZOOM)).tobytes("png")


def open_pdf(path):
    if fitz is None or path is None or not path.is_file():
        return None
    return fitz.open(path)


def word_diff(before, after):
    """(before_html, after_html) with changed words wrapped in <mark>."""
    a, b = re.findall(r"\S+|\s+", before), re.findall(r"\S+|\s+", after)
    out_a, out_b = [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        sa, sb = esc("".join(a[i1:i2])), esc("".join(b[j1:j2]))
        if op == "equal":
            out_a.append(sa)
            out_b.append(sb)
        else:
            if sa.strip():
                out_a.append(f"<mark>{sa}</mark>")
            if sb.strip():
                out_b.append(f"<mark>{sb}</mark>")
    return "".join(out_a), "".join(out_b)


def pages_in(text):
    """Page numbers mentioned as p.6 / p 6 / page 6 / 6쪽."""
    found = re.findall(r"\bp(?:age)?\.?\s*(\d{1,3})\b|(\d{1,3})\s*쪽", text, re.I)
    return sorted({int(a or b) for a, b in found})


CSS = """
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5b6470;--line:#dde1e6;--soft:#f1f3f5;
--blue:#1d5fbf;--blue-bg:#e6eefb;--red:#b4232c;--red-bg:#fbe9ea;--green:#1f7a4d;--green-bg:#e3f4ea;
--amber:#8a5a00;--amber-bg:#fff4d6;--oracle:#fbfaf3;--mark:#ffe08a}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--card:#1d2126;--ink:#e7eaee;--muted:#9aa4b0;
--line:#323840;--soft:#262b31;--blue:#8db4f2;--blue-bg:#1f2d44;--red:#f19aa0;--red-bg:#43242a;
--green:#86d3a9;--green-bg:#1d3a2b;--amber:#f0c66b;--amber-bg:#3d3220;--oracle:#22231d;--mark:#7a6420}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.6 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:21px;border-bottom:1px solid var(--line);padding-bottom:8px;margin:36px 0 16px}
.sub{color:var(--muted);margin:0 0 18px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin:16px 0}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.id{font-weight:700;font-size:19px;margin-right:4px}
.chip{display:inline-block;font-size:12.5px;padding:2px 10px;border-radius:999px;background:var(--soft);color:var(--muted)}
.chip.blue{background:var(--blue-bg);color:var(--blue)}.chip.red{background:var(--red-bg);color:var(--red)}
.chip.green{background:var(--green-bg);color:var(--green)}.chip.amber{background:var(--amber-bg);color:var(--amber)}
.title{font-size:20px;font-weight:700;margin:10px 0 4px}.meta{color:var(--muted);font-size:13.5px;margin:4px 0 12px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.panel{background:var(--soft);border-radius:10px;padding:14px;border-left:4px solid var(--line);min-width:0}
.panel.before{border-left-color:var(--green)}.panel.after{border-left-color:var(--red)}
.label{font-size:12.5px;color:var(--muted);margin-bottom:6px;font-weight:600}
.quote{font-family:Georgia,"Times New Roman",serif;font-size:16px}
mark{background:var(--mark);color:inherit;padding:0 2px;border-radius:3px}
img.crop{display:block;max-width:100%;margin-top:10px;border:1px solid var(--line);border-radius:6px;background:#fff}
img.page{display:block;max-width:100%;margin:8px 0;border:1px solid var(--line);background:#fff}
.oracle{background:var(--oracle);border:1px dashed var(--line);border-radius:10px;padding:14px;margin-top:14px}
.section-label{font-size:13px;font-weight:700;color:var(--blue);margin:16px 0 4px}
details{margin-top:14px;border:1px solid var(--line);border-radius:8px;padding:8px 12px}
summary{cursor:pointer;font-weight:600}.none{color:var(--muted);font-style:italic;font-size:13px}
pre{white-space:pre-wrap;font:inherit;margin:0}
"""


def page_shell(title, body):
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title>'
            f"<style>{CSS}</style></head><body><main>{body}</main></body></html>")

"""Render each PDF page to a PNG so figures can be inspected as images.

Usage: python tools/render_pages.py paper.pdf [--out work/images] [--dpi 110]

Writes work/images/p001.png, p002.png, ... (requires PyMuPDF: pip install pymupdf).
"""
import argparse
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf")
    parser.add_argument("--out", default="work/images")
    parser.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args()

    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz
        except ImportError:
            sys.exit("ERROR: PyMuPDF is not installed (pip install pymupdf)")
    pdf = Path(args.pdf)
    if not pdf.is_file():
        sys.exit(f"ERROR: {pdf} not found")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("p[0-9][0-9][0-9].png"):
        old.unlink()
    zoom = args.dpi / 72
    with fitz.open(pdf) as doc:
        if doc.page_count == 0:
            sys.exit(f"ERROR: {pdf} has zero pages")
        for i, page in enumerate(doc, 1):
            page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).save(out / f"p{i:03d}.png")
        print(f"wrote {doc.page_count} page images to {out}/ at {args.dpi} dpi")


if __name__ == "__main__":
    main()

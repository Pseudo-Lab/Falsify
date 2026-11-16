"""Extract per-page text from a PDF into work/pages/p001.txt, p002.txt, ...

Usage: python tools/extract_pages.py paper.pdf [--out work/pages]

Uses pdftotext when it is on PATH, otherwise pypdf. Exits non-zero when no
pages or no text at all could be extracted.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def pages_with_pdftotext(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "all.txt"
        # Reading-order mode, not -layout: -layout puts both columns of a
        # two-column paper on one line, which breaks quotes across lines.
        subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf), str(out)],
                       check=True, capture_output=True)
        text = out.read_text(encoding="utf-8", errors="replace")
    # pdftotext separates pages with form feeds; the last one is followed by nothing.
    pages = text.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def pages_with_pypdf(pdf):
    from pypdf import PdfReader
    return [page.extract_text() or "" for page in PdfReader(str(pdf)).pages]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf")
    parser.add_argument("--out", default="work/pages")
    args = parser.parse_args()

    pdf = Path(args.pdf)
    if not pdf.is_file():
        sys.exit(f"ERROR: {pdf} not found")

    if shutil.which("pdftotext"):
        engine, pages = "pdftotext", pages_with_pdftotext(pdf)
    else:
        try:
            engine, pages = "pypdf", pages_with_pypdf(pdf)
        except ImportError:
            sys.exit("ERROR: neither pdftotext nor pypdf is available")

    if not pages:
        sys.exit(f"ERROR: {engine} extracted zero pages from {pdf}")
    if not any(p.strip() for p in pages):
        sys.exit(f"ERROR: {engine} extracted {len(pages)} pages but no text (scanned PDF?)")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("p[0-9][0-9][0-9].txt"):
        old.unlink()
    empty = []
    for i, text in enumerate(pages, 1):
        (out / f"p{i:03d}.txt").write_text(text, encoding="utf-8")
        if not text.strip():
            empty.append(i)

    print(f"{engine}: wrote {len(pages)} pages to {out}/")
    if empty:
        print(f"WARNING: no text on page(s) {', '.join(map(str, empty))}", file=sys.stderr)


if __name__ == "__main__":
    main()

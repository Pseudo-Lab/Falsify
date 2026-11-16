"""Pre-session check for the HUMAN, run before a blind session. Never give its output to the model.

Usage: python tools/preflight.py <pdf>

Prints the PDF metadata and warns about text that could break blindness
(defect counts, "intentional", "planted", "answer", 정답, 변조, ...).
Read-only: the PDF is never modified. Exits 2 on strong warnings, 1 on weak
warnings only, 0 when clean.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_pages import pages_with_pdftotext, pages_with_pypdf  # noqa: E402

META_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]
NUM = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|한|두|세|네|다섯)"

# Strong hints almost certainly point at the planted defects; weak ones are
# common in honest papers too ("standard error", "to answer this question").
STRONG = [
    (r"\bintentional(?:ly)?\b", "intentional"),
    (r"\bdeliberate(?:ly)?\s+(?:introduced|inserted|planted|placed|errors?|defects?)", "deliberately introduced"),
    (r"\bplant(?:ed|ing)\b", "planted"),
    (r"\btamper(?:ed|ing)?\b", "tampered"),
    (r"\banswer[\s_-]?key\b", "answer key"),
    (rf"\b{NUM}\s+(?:\w+\s+){{0,2}}(?:defects?|flaws?|injected errors?)\b", "defect count"),
    (r"정답", "정답"),
    (r"변조", "변조"),
    (rf"결함\s*{NUM}\s*개|{NUM}\s*개의?\s*결함", "결함 N개"),
    (rf"오류\s*{NUM}\s*개|{NUM}\s*개의?\s*오류", "오류 N개"),
]
WEAK = [
    (rf"\b{NUM}\s+(?:\w+\s+){{0,3}}errors?\b|\berrors?\s+(?:\w+\s+){{0,2}}{NUM}\b", "error(s) near a number"),
    (r"\banswers?\b", "answer"),
]


def metadata(pdf):
    try:
        from pypdf import PdfReader
        info = PdfReader(str(pdf)).metadata or {}
        return {k: str(info.get("/" + k, "")) for k in META_KEYS}, "pypdf"
    except ImportError:
        pass
    # Fallback: read literal strings from the raw Info dictionary and XMP packet.
    raw = Path(pdf).read_bytes().decode("latin-1")
    meta = {}
    for k in META_KEYS:
        m = re.search(rf"/{k}\s*\(((?:\\.|[^\\)])*)\)", raw)
        meta[k] = m.group(1) if m else ""
    for k, tag in [("Title", "dc:title"), ("Author", "dc:creator"), ("Subject", "dc:description"), ("Keywords", "pdf:Keywords")]:
        m = re.search(rf"<{tag}>(.*?)</{tag}>", raw, re.S)
        if m and not meta[k]:
            meta[k] = re.sub(r"<[^>]+>", " ", m.group(1)).strip()
    return meta, "raw parse (install pypdf for compressed metadata)"


def scan(label, text, patterns):
    hits = []
    for pattern, name in patterns:
        for m in re.finditer(pattern, text, re.I):
            a, b = max(0, m.start() - 50), min(len(text), m.end() + 50)
            context = re.sub(r"\s+", " ", text[a:b]).strip()
            hits.append(f"{label}: [{name}] ...{context}...")
    return hits


def main():
    # The Windows console may default to cp949/cp1252; reports contain non-ASCII text.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    pdf = Path(sys.argv[1])
    if not pdf.is_file():
        sys.exit(f"ERROR: {pdf} not found")

    meta, source = metadata(pdf)
    print(f"== Metadata ({source})")
    for k in META_KEYS:
        print(f"  {k:9}: {meta.get(k) or '-'}")

    try:
        pages = pages_with_pdftotext(pdf)
    except (FileNotFoundError, OSError):
        pages = pages_with_pypdf(pdf)
    print(f"== Text: {len(pages)} pages, {sum(len(p) for p in pages)} characters")

    meta_text = "\n".join(f"{k}: {v}" for k, v in meta.items())
    strong = scan("metadata", meta_text, STRONG + WEAK)
    weak = []
    for i, text in enumerate(pages, 1):
        strong += scan(f"page {i}", text, STRONG)
        weak += scan(f"page {i}", text, WEAK)
    if not "".join(pages).strip():
        strong.append("no extractable text: extract_pages.py will fail")

    print(f"== STRONG warnings ({len(strong)}): likely blind-breaking, fix the PDF before the session")
    for h in strong:
        print("  ! " + h)
    print(f"== Weak warnings ({len(weak)}): often innocent, skim them")
    for h in weak:
        print("  ? " + h)
    if not strong and not weak:
        print("== No warnings.")
    sys.exit(2 if strong else 1 if weak else 0)


if __name__ == "__main__":
    main()

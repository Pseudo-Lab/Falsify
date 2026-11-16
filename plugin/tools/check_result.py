"""Integrity gate for a blind Blue session result. Deterministic; no LLM.

Usage: python tools/check_result.py <blue_result.md> <work/pages/>

Checks every row of the 8-column findings table (format, allowed labels,
verbatim quotes against the extracted page text) and that a method section
follows the table. Writes check_report.md next to the result file and exits
non-zero when any row is malformed or has a quote that is NOT_FOUND.
"""
import argparse
import difflib
import re
import sys
import unicodedata
from pathlib import Path

# Columns are found by header name, so both the Korean table
# (번호 | 쪽 | 위치 | 유형 | 심각도 | 인용한 원문 | 왜 결함인가 | 확신 | 관련 위치 | 근거 점검)
# and the older 8-column English table work.
ROLE_ALIASES = {
    "page": ["page", "쪽", "물리 페이지"],
    "location": ["location", "위치"],
    "type": ["type", "유형"],
    "severity": ["severity", "심각도"],
    "quote": ["verbatim quote", "인용한 원문", "정확한 원문 인용", "원문"],
    "why": ["why", "왜 결함인가", "이유"],
    "confidence": ["confidence", "확신"],
    "related": ["관련 위치", "related"],
    "evidence_check": ["근거 점검", "evidence check"],
}
REQUIRED_ROLES = ["page", "type", "severity", "quote", "why", "confidence"]
DEFAULT_MAP = {"page": 1, "location": 2, "type": 3, "severity": 4, "quote": 5, "why": 6, "confidence": 7}

# Team labels: English from the original rules, Korean from the team's Korean prompts.
SEVERITY = {
    "cannot be published unless reverted",
    "conclusion survives, but this evidence cannot support it",
    "minor",
    "되돌리지 않으면 공개할 수 없음",
    "결론은 살아 있으나 그 근거로 그 결론을 말할 수 없음",
    "가벼움",
}
CONFIDENCE = {"high", "medium", "low", "높음", "보통", "낮음"}
KNOWN_TYPES = {
    "needs check", "확인필요", "확인 필요",
    "evidence unchanged but conclusion reversed",
    "paragraph violates a criterion it set itself",
    "values from different conditions compared on one scale",
    "checked a subset, declared it all",
    "근거는 그대로인데 결론만 반대",
    "문단이 스스로 세운 기준을 문단 안에서 어김",
    "조건이 다른 수치를 한 기준에서 비교",
    "일부만 확인하고 전부라고 선언",
}
# Words whose presence suggests each required method-section item (warnings only).
METHOD_ITEMS = {
    "확인 범위(전수로 확인한 것 / 다루지 못한 것)": ["exhaustive", "not cover", "전수", "다루지", "확인한"],
    "원 논문의 불일치": ["original", "원 논문", "원논문"],
    "맹검 무결성 상태": ["integrity", "blind", "무결성", "블라인드", "맹검"],
}

FUZZY_THRESHOLD = 0.9
SHORT_QUOTE = 15
RANK = {"EXACT": 0, "FOUND_ON_OTHER_PAGE": 1, "FUZZY": 2, "NOT_FOUND": 3}

CHAR_MAP = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2212": "-", "\ufe63": "-",
    "\u00ad": None,  # soft hyphen
})


def normalize_chars(text):
    # NFKC expands ligatures (U+FB01 -> "fi") and full-width forms.
    return unicodedata.normalize("NFKC", text).translate(CHAR_MAP)


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def page_variants(raw):
    """Page text with line-break hyphens both joined ("detec-\\ntion" -> "detection")
    and kept ("cross-\\nvalidation" -> "cross-validation")."""
    text = normalize_chars(raw)
    return {squash(re.sub(r"-[ \t]*\n\s*", "", text)), squash(re.sub(r"-[ \t]*\n\s*", "-", text))}


def quote_variants(quote):
    q = squash(normalize_chars(quote.replace("\\|", "|")))
    if len(q) >= 2 and q[0] == q[-1] and q[0] in "\"'`":
        q = q[1:-1].strip()
    variants = {q}
    # a line-break hyphen copied as "detec- tion"
    variants.add(re.sub(r"(\w)- (\w)", r"\1\2", q))
    return {v for v in variants if v}


def fuzzy_ratio(quote, text):
    """Best similarity between quote and any word-aligned window of text."""
    n = len(quote)
    if n == 0 or not text:
        return 0.0
    best = 0.0
    sizes = sorted({n, int(n * 0.9), int(n * 1.1)})
    starts = [0] + [m.end() for m in re.finditer(r" ", text)]
    matcher = difflib.SequenceMatcher(autojunk=False)
    matcher.set_seq2(quote)
    for s in starts:
        for size in sizes:
            window = text[s:s + size]
            if not window:
                continue
            matcher.set_seq1(window)
            if matcher.real_quick_ratio() < FUZZY_THRESHOLD or matcher.quick_ratio() < FUZZY_THRESHOLD:
                continue
            r = matcher.ratio()
            if r > best:
                best = r
    return best


def locate(part, stated, pages):
    """Return (status, detail) for one quote fragment."""
    qs = quote_variants(part)
    stated_ok = [p for p in stated if p in pages]
    others = [p for p in sorted(pages) if p not in stated_ok]

    def exact_on(nums):
        return [p for p in nums if any(q in v for q in qs for v in pages[p])]

    hit = exact_on(stated_ok)
    if hit:
        return "EXACT", f"{hit[0]}쪽"
    hit = exact_on(others)
    if hit:
        return "FOUND_ON_OTHER_PAGE", f"적힌 쪽이 아니라 {', '.join(map(str, hit))}쪽에서 찾음"
    best_page, best = None, 0.0
    for p in stated_ok + others:
        for v in pages[p]:
            for q in qs:
                r = fuzzy_ratio(q, v)
                if r > best:
                    best_page, best = p, r
        if best >= FUZZY_THRESHOLD and p in stated_ok:
            break  # good enough on a stated page; stated pages are searched first
    if best >= FUZZY_THRESHOLD:
        where = "적힌 쪽" if best_page in stated_ok else "다른 쪽"
        return "FUZZY", f"{best_page}쪽에서 유사도 {best:.3f} ({where})"
    return "NOT_FOUND", f"가장 높은 유사도 {best:.3f}" + (f" ({best_page}쪽)" if best_page else "")


def split_row(line):
    """Split a markdown table row on unescaped pipes."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", line)]


def is_separator(cells):
    return all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c) and any(cells)


def parse(md):
    """Return (header, rows, text_after_table). rows are (line_no, cells)."""
    lines = md.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip().startswith("|"):
            cells = split_row(line)
            if cells and re.fullmatch(r"(no\.?|번호)", cells[0].strip("*` ").lower()):
                start = i
                break
    if start is None:
        return None, [], md
    header = split_row(lines[start])
    rows, i = [], start + 1
    while i < len(lines) and lines[i].strip().startswith("|"):
        cells = split_row(lines[i])
        if not is_separator(cells):
            rows.append((i + 1, cells))
        i += 1
    return header, rows, "\n".join(lines[i:])


def clean_label(value):
    return value.strip().strip("*`_ ").strip().lower()


def column_map(header):
    """role -> column index, matched by header name; DEFAULT_MAP if header is None."""
    if header is None:
        return dict(DEFAULT_MAP)
    cmap = {}
    for i, name in enumerate(header):
        h = clean_label(name)
        for role, aliases in ROLE_ALIASES.items():
            if role not in cmap and any(h.startswith(a) for a in aliases):
                cmap[role] = i
                break
    return cmap


def cell(cells, cmap, role):
    i = cmap.get(role)
    return cells[i] if i is not None and i < len(cells) else ""


def check_row(cells, pages, cmap=None, width=8):
    """Return (format_errors, warnings, quote_results)."""
    errors, warnings, quotes = [], [], []
    cmap = cmap or dict(DEFAULT_MAP)
    if len(cells) != width:
        return [f"열이 {width}개여야 하는데 {len(cells)}개임"], warnings, quotes
    page, typ, severity = cell(cells, cmap, "page"), cell(cells, cmap, "type"), cell(cells, cmap, "severity")
    quote, why, confidence = cell(cells, cmap, "quote"), cell(cells, cmap, "why"), cell(cells, cmap, "confidence")

    stated = []
    if not re.fullmatch(r"\d+(\s*,\s*\d+)*", page.strip()):
        errors.append(f"쪽 '{page}'이(가) 숫자가 아님")
    else:
        stated = [int(p) for p in re.findall(r"\d+", page)]
        missing = [p for p in stated if p not in pages]
        if missing:
            errors.append(f"쪽 {missing}이(가) 추출된 쪽 범위(1-{max(pages) if pages else 0})에 없음")
    if not clean_label(typ):
        errors.append("유형이 비어 있음")
    elif (not re.match(r"d[1-4]\b", clean_label(typ))
          and re.sub(r"\s*\(.*$", "", clean_label(typ)) not in KNOWN_TYPES):  # "(…)" notes are fine
        warnings.append(f"유형 '{typ}'은(는) 미리 정한 이름이 아님 (직접 붙인 이름이면 허용)")
    if not clean_label(severity):
        errors.append("심각도가 비어 있음")
    elif clean_label(severity) not in SEVERITY:
        errors.append(f"심각도 '{severity}'은(는) 허용된 값이 아님")
    if not clean_label(confidence):
        errors.append("확신이 비어 있음")
    elif clean_label(confidence) not in CONFIDENCE:
        errors.append(f"확신 '{confidence}'은(는) 허용된 값이 아님")
    if not why.strip():
        errors.append("이유(왜 결함인가)가 비어 있음")

    parts = [p for p in re.split(r"\s+/\s+", quote.strip()) if p.strip()]
    if not parts:
        errors.append("인용한 원문이 비어 있음")
    for part in parts:
        status, detail = locate(part, stated, pages)
        if len(squash(part)) < SHORT_QUOTE:
            warnings.append(f"인용 조각 '{part}'이(가) {SHORT_QUOTE}자 미만이라 일치해도 약한 근거임")
        quotes.append((part, status, detail))
    return errors, warnings, quotes


def load_pages(folder):
    pages = {}
    for f in sorted(Path(folder).glob("p[0-9][0-9][0-9].txt")):
        pages[int(f.stem[1:])] = page_variants(f.read_text(encoding="utf-8", errors="replace"))
    return pages


def md_cell(text):
    return text.replace("|", "\\|").replace("\n", " ")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("result")
    parser.add_argument("pages")
    return parser.parse_args()


def load_inputs(args):
    result = Path(args.result)
    if not result.is_file():
        sys.exit(f"ERROR: {result} not found")
    pages = load_pages(args.pages)
    if not pages:
        sys.exit(f"ERROR: no pNNN.txt files in {args.pages}")
    return result, pages


def check_header(header, rows, cmap):
    """Problems with the table as a whole."""
    if header is None:
        return ["'번호' / 'No.' 머리글 열이 있는 결함 표를 찾지 못함"]
    problems = []
    missing = [r for r in REQUIRED_ROLES if r not in cmap]
    if missing:
        problems.append(f"표 머리글에 다음 열이 없음: {', '.join(missing)}")
    if not rows:
        problems.append("표에 데이터 행이 없음")
    return problems


def check_rows(rows, pages, cmap, width):
    """Check every row. Returns (problems, warnings, report table lines, status counts)."""
    problems, warn_lines, report_rows = [], [], []
    counts = {k: 0 for k in RANK}
    for line_no, cells in rows:
        label = cells[0] if cells else "?"
        errors, warnings, quotes = check_row(cells, pages, cmap, width)
        status = max((q[1] for q in quotes), key=RANK.get, default="-")
        if status in counts:
            counts[status] += 1
        if errors:
            problems.append(f"행 {label} ({line_no}번째 줄): " + "; ".join(errors))
        if status == "NOT_FOUND":
            problems.append(f"행 {label} ({line_no}번째 줄): 인용문을 PDF에서 찾지 못함 (NOT_FOUND)")
        for w in warnings:
            warn_lines.append(f"행 {label}: {w}")
        detail = "<br>".join(f"{q[1]}: {md_cell(q[2])} — “{md_cell(q[0][:80])}”" for q in quotes) or "-"
        report_rows.append(f"| {md_cell(label)} | {md_cell(cells[1]) if len(cells) > 1 else ''} | "
                           f"{'형식 오류: ' + md_cell('; '.join(errors)) if errors else '정상'} | {status} | {detail} |")
    return problems, warn_lines, report_rows, counts


def check_method_section(after):
    """Returns (problems, warnings, number of non-space characters)."""
    method_chars = len(re.sub(r"\s", "", after))
    if method_chars < 100:
        return [f"표 뒤의 방법 절이 없거나 너무 짧음 ({method_chars}자)"], [], method_chars
    low = after.lower()
    warnings = [f"방법 절: '{item}'에 대한 언급이 보이지 않음" for item, words in METHOD_ITEMS.items()
                if not any(w in low for w in words)]
    return [], warnings, method_chars


def render_report(result, pages_arg, page_count, row_count, counts, method_chars, report_rows, problems, warn_lines):
    verdict = "실패 (FAIL)" if problems else "통과 (PASS)"
    return "\n".join([
        "# 결과 점검 보고서 (check_result)", "",
        f"- 결과 파일: `{result}`",
        f"- 쪽 텍스트: `{pages_arg}` ({page_count}쪽)",
        f"- 행: {row_count}개 — " + ", ".join(f"{k} {v}" for k, v in counts.items()),
        f"- 방법 절: 공백 제외 {method_chars}자",
        f"- **판정: {verdict}**", "",
        "| 번호 | 쪽 | 형식 | 인용 상태 | 세부 |", "|---|---|---|---|---|",
        *report_rows, "",
        "## 문제 (실패 사유)", "",
        *([f"- {p}" for p in problems] or ["- 없음"]), "",
        "## 경고 (사람이 검토할 것)", "",
        *([f"- {w}" for w in warn_lines] or ["- 없음"]), "",
    ])


def main():
    # The Windows console may default to cp949/cp1252; reports contain non-ASCII text.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    result, pages = load_inputs(args)
    header, rows, after = parse(result.read_text(encoding="utf-8"))
    cmap = column_map(header)

    problems = check_header(header, rows, cmap)
    row_problems, warn_lines, report_rows, counts = check_rows(rows, pages, cmap, len(header) if header else 8)
    method_problems, method_warnings, method_chars = check_method_section(after)
    problems += row_problems + method_problems
    warn_lines += method_warnings

    text = render_report(result, args.pages, len(pages), len(rows), counts, method_chars,
                         report_rows, problems, warn_lines)
    report = result.parent / "check_report.md"
    report.write_text(text, encoding="utf-8")
    print(text)
    print(f"보고서 저장: {report}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()

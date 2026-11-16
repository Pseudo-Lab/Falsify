"""Locate quotes in a Markdown paper by line number. Shared by the CSV export and the report."""
import re

import check_result as cr

WINDOW = 3     # a quote may run over a few Markdown lines
NEAR = 2       # a quote found within this many lines of the stated line counts as "at the stated line"
CONTEXT = 2    # lines shown above and below a hit in the report


def clean(text):
    return cr.squash(cr.normalize_chars(text or "")).lower()


def find_line(part, lines):
    """1-based line number where the quote fragment starts, or None."""
    part = clean(part)
    if not part:
        return None
    cleaned = [clean(line) for line in lines]
    for width in range(1, WINDOW + 1):
        for index in range(len(cleaned) - width + 1):
            if part in " ".join(cleaned[index:index + width]).strip():
                return index + 1
    return None


def header_offset(lines):
    """Lines taken by the warning block that the team's apply_patch.py puts on top of a
    tampered copy. Answer keys count lines in the clean paper, so the block is subtracted."""
    if not lines or lines[0].strip() != "<!--":
        return 0
    for index, line in enumerate(lines):
        if line.strip() == "-->":
            end = index + 1
            return end + 1 if end < len(lines) and not lines[end].strip() else end
    return 0


def stated_lines(page_cell):
    """'L142, L258' -> [142, 258]"""
    return [int(n) for n in re.findall(r"\d+", page_cell or "")]


def locate_md_quote(part, stated, lines):
    """(status, detail, line or None) for one quote fragment, with check_result's status names."""
    line = find_line(part, lines)
    if line is None:
        return "NOT_FOUND", "논문에서 찾지 못함", None
    if not stated or any(abs(line - s) <= NEAR for s in stated):
        return "EXACT", f"{line}번째 줄", line
    return "FOUND_ON_OTHER_PAGE", f"적힌 줄이 아니라 {line}번째 줄에서 찾음", line


def context_lines(lines, line):
    """[(line number, text, is the hit)] around a hit."""
    first, last = max(line - CONTEXT, 1), min(line + CONTEXT, len(lines))
    return [(n, lines[n - 1], n == line) for n in range(first, last + 1)]

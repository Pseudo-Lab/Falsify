"""HTML report for one Blue session folder (run by the human, after the session).

Usage: python tools/blue_report.py <session_folder>

Reads blue_result.md (or results/blue_result.md in older runs) and the paper, checks every
quote, and writes blue_report.html next to it with one card per finding, plus
blue_result.xlsx in the team's spreadsheet layout (needs openpyxl).
- PDF run (paper.pdf): quotes are checked the same way as check_result.py; cards show
  highlighted PDF crops and full-page images. Pages are extracted first if needed.
- Markdown run (paper.md): quotes are located by line; cards show the surrounding lines.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_result as cr  # noqa: E402
import report_common as rc  # noqa: E402
from extract_pages import pages_with_pdftotext, pages_with_pypdf  # noqa: E402
from funct_md_quotes import context_lines, locate_md_quote, stated_lines  # noqa: E402

STATUS_CHIP = {"EXACT": "green", "FOUND_ON_OTHER_PAGE": "amber", "FUZZY": "amber", "NOT_FOUND": "red"}
SEVERITY_CHIP = {"cannot be published unless reverted": "red", "되돌리지 않으면 공개할 수 없음": "red",
                 "conclusion survives, but this evidence cannot support it": "amber",
                 "결론은 살아 있으나 그 근거로 그 결론을 말할 수 없음": "amber", "minor": "green", "가벼움": "green"}
# xlsx fills, matching the team's spreadsheet
XL_SEVERITY = {"red": "F8CBAD", "amber": "FFE699", "green": "E2EFDA"}
XL_CONFIDENCE = {"높음": "F8CBAD", "high": "F8CBAD", "보통": "FFE699", "medium": "FFE699"}


def ensure_pages(folder):
    pages_dir = folder / "work" / "pages"
    if not list(pages_dir.glob("p[0-9][0-9][0-9].txt")):
        pages_dir = folder / "work" / "pages_report"
        pages_dir.mkdir(parents=True, exist_ok=True)
        try:
            texts = pages_with_pdftotext(folder / "paper.pdf")
        except (FileNotFoundError, OSError):
            texts = pages_with_pypdf(folder / "paper.pdf")
        for i, t in enumerate(texts, 1):
            (pages_dir / f"p{i:03d}.txt").write_text(t, encoding="utf-8")
    return pages_dir


def headline(why, location):
    first = re.split(r"(?<=[.!?。])\s|(?<=다\.)\s", why.strip(), maxsplit=1)[0]
    return first if 4 < len(first) < 140 else (location or why[:120])


def pdf_panels(quotes, stated, doc):
    panels = []
    for i, (part, st, detail) in enumerate(quotes):
        m = re.search(r"(\d+)쪽", detail)  # check_result.locate() names the page as "<n>쪽"
        where = int(m.group(1)) if m else stated[min(i, len(stated) - 1)]
        png = rc.crop(doc, where, part)
        img = rc.png_tag(png, f"p.{where}") if png else '<div class="none">PDF에서 위치를 찾지 못함</div>'
        panels.append(f'<div class="panel"><div class="label">PDF {where}쪽 · {rc.esc(st)}</div>'
                      f'<div class="quote">{rc.esc(part)}</div>{img}</div>')
    return panels


def md_panels(quotes, md_lines):
    """Markdown run: show the lines around each quote instead of a PDF crop."""
    panels = []
    for part, st, detail in quotes:
        m = re.search(r"(\d+)번째 줄", detail)
        if m:
            rows = "".join(
                f'<div style="{"background:#fff3bf;" if hit else ""}white-space:pre-wrap">'
                f'<span class="meta">{number:>4} </span>{rc.esc(text)}</div>'
                for number, text, hit in context_lines(md_lines, int(m.group(1))))
            shown = f'<div class="crop" style="font-family:monospace;font-size:12px">{rows}</div>'
        else:
            shown = '<div class="none">논문에서 위치를 찾지 못함</div>'
        panels.append(f'<div class="panel"><div class="label">{rc.esc(detail)} · {rc.esc(st)}</div>'
                      f'<div class="quote">{rc.esc(part)}</div>{shown}</div>')
    return panels


def finding_card(n, f, quotes, errors, doc, md_lines=None):
    page, location, typ, severity = f["page"], f["location"], f["type"], f["severity"]
    why, confidence = f["why"], f["confidence"]
    status = max((q[1] for q in quotes), key=cr.RANK.get, default="-")
    stated = [int(p) for p in re.findall(r"\d+", page)] or [0]
    chips = [f'<span class="chip blue">{rc.esc(typ)}</span>',
             f'<span class="chip {SEVERITY_CHIP.get(cr.clean_label(severity), "")}">{rc.esc(severity)}</span>',
             f'<span class="chip">확신 {rc.esc(confidence)}</span>',
             f'<span class="chip">{"줄 " + rc.esc(page) if md_lines is not None else "PDF " + rc.esc(page) + "쪽"}</span>',
             f'<span class="chip {STATUS_CHIP.get(status, "red")}">인용 {status}</span>']
    if errors:
        chips.append('<span class="chip red">형식 오류</span>')
    if md_lines is not None:
        panels, full = md_panels(quotes, md_lines), ""
    else:
        panels = pdf_panels(quotes, stated, doc)
        full = "".join(rc.png_tag(p, f"page {n}", "page") for n in stated if (p := rc.page_png(doc, n)))
    err = f'<p class="meta" style="color:var(--red)">{rc.esc("; ".join(errors))}</p>' if errors else ""
    extra = ""
    if f.get("related"):
        extra += f'<div class="section-label">관련 위치</div><p>{rc.esc(f["related"])}</p>'
    if f.get("evidence_check"):
        extra += f'<div class="section-label">근거 점검</div><p>{rc.esc(f["evidence_check"])}</p>'
    card_id = f["id"] or f"F{n:02d}"
    return (f'<section class="card"><div class="head"><span class="id">{rc.esc(card_id)}</span>{"".join(chips)}</div>'
            f'<div class="title">{rc.esc(headline(why, location))}</div>'
            f'<div class="meta">위치: {rc.esc(location)}</div>{err}'
            f'<div class="cols">{"".join(panels) or "<div class=none>인용 없음</div>"}</div>'
            f'<div class="section-label">왜 결함인가</div><p>{rc.esc(why)}</p>{extra}'
            + (f"<details><summary>PDF 원문 이미지 펼치기</summary>{full}</details>" if full else "")
            + "</section>")


def write_xlsx(path, header, rows, cmap, statuses, after, meta, pdf):
    """Team-style spreadsheet: 결함 목록 + 사용법·대조 방법. Returns False without openpyxl."""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        return False
    wb = Workbook()
    ws = wb.active
    ws.title = "결함 목록"
    cols = list(header) + ["인용 대조"]
    ws.append(cols)
    head_fill, white = PatternFill("solid", fgColor="C00000"), Font(bold=True, color="FFFFFF")
    for c in ws[1]:
        c.fill, c.font = head_fill, white
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    pdf_uri = pdf.resolve().as_uri() if pdf else ""
    for cells, status in zip(rows, statuses):
        cells = (cells + [""] * len(header))[:len(header)]
        ws.append([c.replace("\\|", "|") for c in cells] + [status])
        r = ws.max_row
        for c in ws[r]:
            c.alignment = Alignment(vertical="top", wrap_text=True)
        if "page" in cmap and pdf:  # Markdown runs keep the line numbers as written
            pc = ws.cell(r, cmap["page"] + 1)
            nums = re.findall(r"\d+", str(pc.value))
            if nums:
                pc.value = ", ".join(f"p.{p}" for p in nums)
                pc.hyperlink = f"{pdf_uri}#page={nums[0]}"
                pc.font = Font(color="0563C1", underline="single")
        if "severity" in cmap:
            sc = ws.cell(r, cmap["severity"] + 1)
            tone = SEVERITY_CHIP.get(cr.clean_label(str(sc.value)))
            if tone:
                sc.fill = PatternFill("solid", fgColor=XL_SEVERITY[tone])
        if "confidence" in cmap:
            cc = ws.cell(r, cmap["confidence"] + 1)
            fill = XL_CONFIDENCE.get(cr.clean_label(str(cc.value)))
            if fill:
                cc.fill = PatternFill("solid", fgColor=fill)
    widths = {"page": 9, "location": 22, "type": 22, "severity": 20, "quote": 48, "why": 48,
              "confidence": 7, "related": 20, "evidence_check": 28}
    for role, i in cmap.items():
        ws.column_dimensions[ws.cell(1, i + 1).column_letter].width = widths.get(role, 14)
    ws.column_dimensions["A"].width = 7
    ws.column_dimensions[ws.cell(1, len(cols)).column_letter].width = 14
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    info = wb.create_sheet("사용법·대조 방법")
    lines = [("논문", meta.get("paper_file", "")), ("실행", meta.get("run_dir", "")),
             ("모드", meta.get("mode", "")), ("모델", meta.get("model", "")),
             ("추론 강도", meta.get("reasoning_effort", "")), ("시작", meta.get("started_at", "")),
             ("끝", meta.get("finished_at", "")), ("소요(분)", meta.get("duration_minutes", "")),
             ("프롬프트", f'{meta.get("prompt_command", "")} ({meta.get("prompt_sha256", "")})'),
             ("쪽 링크", "클릭하면 paper.pdf가 열립니다. 해당 쪽으로 바로 가는지는 PDF 뷰어에 따라 다릅니다."),
             ("인용 대조", "check_result.py 기준. EXACT=그대로 있음, FOUND_ON_OTHER_PAGE=다른 쪽에 있음, "
                        "FUZZY=거의 같음, NOT_FOUND=PDF에 없음."),
             ("", ""), ("방법 절", "")]
    for k, v in lines:
        info.append([k, str(v)])
    for line in after.strip().splitlines():
        info.append(["", line])
    info.column_dimensions["A"].width = 14
    info.column_dimensions["B"].width = 110
    for row in info.iter_rows():
        row[0].font = Font(bold=True)
        for c in row:
            c.alignment = Alignment(vertical="top", wrap_text=True)
    wb.save(path)
    return True


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder")
    return parser.parse_args()


def find_result(folder):
    result = folder / "blue_result.md"
    if not result.is_file() and (folder / "results" / "blue_result.md").is_file():
        result = folder / "results" / "blue_result.md"  # runs made before the flat layout
    if not result.is_file():
        sys.exit(f"ERROR: {result} not found")
    return result


def load_meta(folder):
    meta_file = folder / "meta.json"
    return json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.is_file() else {}


def check_findings(rows, pages, cmap, width, doc):
    """One card per finding, plus the tallies the summary line needs."""
    cards, counts, types, statuses = [], {k: 0 for k in cr.RANK}, {}, []
    for n, (_, cells) in enumerate(rows, 1):
        errors, _, quotes = cr.check_row(cells, pages, cmap, width)
        f = {role: cr.cell(cells, cmap, role) for role in cr.ROLE_ALIASES}
        f["id"] = cells[0] if cells else ""
        status = max((q[1] for q in quotes), key=cr.RANK.get, default=None)
        statuses.append(status or "-")
        if status:
            counts[status] += 1
        key = re.match(r"(D[1-4]|확인필요|Needs check)?", f["type"].strip()).group(1) or f["type"].strip() or "?"
        types[key] = types.get(key, 0) + 1
        cards.append(finding_card(n, f, quotes, errors, doc))
    return cards, counts, types, statuses


def check_md_row(cells, cmap, md_lines):
    """Markdown counterpart of check_result.check_row: (errors, quotes)."""
    value = {role: cr.cell(cells, cmap, role) for role in ("page", "type", "severity", "quote", "why", "confidence")}
    errors = [f"{name}이(가) 비어 있음" for name, role in
              (("유형", "type"), ("심각도", "severity"), ("확신", "confidence"),
               ("이유(왜 결함인가)", "why"), ("인용한 원문", "quote")) if not value[role].strip()]
    if value["severity"].strip() and cr.clean_label(value["severity"]) not in cr.SEVERITY:
        errors.append(f"심각도 '{value['severity']}'은(는) 허용된 값이 아님")
    if value["confidence"].strip() and cr.clean_label(value["confidence"]) not in cr.CONFIDENCE:
        errors.append(f"확신 '{value['confidence']}'은(는) 허용된 값이 아님")
    stated = stated_lines(value["page"])
    if not stated:
        errors.append(f"쪽 칸 '{value['page']}'에 줄 번호(L142)가 없음")
    quotes = []
    for part in [p.strip() for p in value["quote"].replace("\\|", "|").split(" / ") if p.strip()]:
        status, detail, _ = locate_md_quote(part, stated, md_lines)
        quotes.append((part, status, detail))
    return errors, quotes


def check_md_findings(rows, cmap, md_lines):
    """Markdown counterpart of check_findings."""
    cards, counts, types, statuses = [], {k: 0 for k in cr.RANK}, {}, []
    for n, (_, cells) in enumerate(rows, 1):
        errors, quotes = check_md_row(cells, cmap, md_lines)
        f = {role: cr.cell(cells, cmap, role) for role in cr.ROLE_ALIASES}
        f["id"] = cells[0] if cells else ""
        status = max((q[1] for q in quotes), key=cr.RANK.get, default=None)
        statuses.append(status or "-")
        if status:
            counts[status] += 1
        key = re.match(r"(D[1-4]|확인필요|Needs check)?", f["type"].strip()).group(1) or f["type"].strip() or "?"
        types[key] = types.get(key, 0) + 1
        cards.append(finding_card(n, f, quotes, errors, None, md_lines))
    return cards, counts, types, statuses


def mode_label(meta):
    mode = meta.get("mode") or "blue"
    if meta.get("model"):
        mode += f" · {meta['model']}" + (f" · {meta['duration_minutes']}분" if meta.get("duration_minutes") else "")
    return mode


def render_body(folder, meta, row_count, cards, counts, types, after):
    stats = "".join(f'<span class="chip blue">{rc.esc(t)} × {c}</span>' for t, c in sorted(types.items()))
    stats += "".join(f'<span class="chip {STATUS_CHIP[k]}">{k} {v}</span>' for k, v in counts.items() if v)
    return (f"<h1>Blue 결과 · {rc.esc(folder.name)}</h1>"
            f'<p class="sub">{mode_label(meta)} · 발견 {row_count}건 · 인용은 논문 본문과 대조함</p>'
            f'<div class="stats">{stats}</div><h2>1. 발견한 결함</h2>{"".join(cards)}'
            f'<h2>2. 방법과 범위</h2><div class="card"><pre>{rc.esc(after.strip()) or "(없음)"}</pre></div>')


def write_html(result, folder, body, row_count):
    out = result.parent / "blue_report.html"
    out.write_text(rc.page_shell(f"Blue {folder.name}", body), encoding="utf-8")
    print(f"wrote {out} ({row_count} findings)")


def write_spreadsheet(result, folder, header, rows, cmap, statuses, after, meta):
    xlsx = result.parent / "blue_result.xlsx"
    pdf = folder / "paper.pdf"
    if write_xlsx(xlsx, header, [c for _, c in rows], cmap, statuses, after, meta, pdf if pdf.is_file() else None):
        print(f"wrote {xlsx}")
    else:
        print("WARNING: openpyxl not installed; skipped the xlsx (pip install openpyxl)", file=sys.stderr)


def main():
    args = parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    folder = Path(args.folder)
    result = find_result(folder)
    if rc.fitz is None and not (folder / "paper.md").is_file():
        print("WARNING: PyMuPDF not installed; the report will have no PDF images", file=sys.stderr)

    header, rows, after = cr.parse(result.read_text(encoding="utf-8"))
    cmap = cr.column_map(header)
    meta = load_meta(folder)

    if (folder / "paper.md").is_file():
        md_lines = (folder / "paper.md").read_text(encoding="utf-8").split("\n")
        cards, counts, types, statuses = check_md_findings(rows, cmap, md_lines)
    else:
        pages = cr.load_pages(ensure_pages(folder))
        doc = rc.open_pdf(folder / "paper.pdf")
        cards, counts, types, statuses = check_findings(rows, pages, cmap, len(header) if header else 8, doc)
    write_html(result, folder, render_body(folder, meta, len(rows), cards, counts, types, after), len(rows))
    if header:
        write_spreadsheet(result, folder, header, rows, cmap, statuses, after, meta)


if __name__ == "__main__":
    main()

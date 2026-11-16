"""HTML report for one Red session folder: what was planted, where, and the oracle.

Usage: python tools/red_report.py [red_folder]   (default: current folder)

Reads keys/answer_key.json, source/paper.pdf (original) and handoff/paper.pdf
(tampered, if present) and writes keys/red_report.html: one card per defect
with original vs. changed text (changed words highlighted), PDF crops of both,
and the oracle with crops or page images. Contains the answers: never give it
to Blue before scoring.
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import report_common as rc  # noqa: E402

SEVERITY_CHIP = {"Cannot be published unless reverted": "red", "되돌리지 않으면 공개할 수 없음": "red",
                 "결론은 살아 있으나 그 근거로 그 결론을 말할 수 없음": "amber", "가벼움": "green"}


def oracle_block(oracle, doc):
    """Oracle text plus crops of any quoted text in it, else page images it mentions."""
    quoted = re.findall(r"[\"“]([^\"”]{12,})[\"”]", oracle)
    figs = []
    for q in quoted:
        for p in range(1, (doc.page_count if doc else 0) + 1):
            png = rc.crop(doc, p, q)
            if png:
                figs.append(f'<div class="label">p.{p}</div>{rc.png_tag(png, f"oracle p.{p}")}')
                break
    if not figs:
        for p in rc.pages_in(oracle)[:2]:
            png = rc.page_png(doc, p)
            if png:
                figs.append(f"<details><summary>p.{p} 페이지 보기</summary>{rc.png_tag(png, f'p.{p}', 'page')}</details>")
    return (f'<div class="oracle"><div class="label">오라클 (정답 근거, 원본 그대로)</div>'
            f'<p style="margin:0">{rc.esc(oracle)}</p>{"".join(figs)}</div>')


def defect_card(d, src, handoff):
    page = d.get("page", "")
    pnums = [int(p) for p in re.findall(r"\d+", str(page))] or [0]
    before, after = str(d.get("before", "")), str(d.get("after", ""))
    b_html, a_html = rc.word_diff(before, after)
    b_png = next((png for p in pnums if (png := rc.crop(src, p, before))), None)
    a_png = None
    if handoff is not None:
        a_png = next((png for p in pnums if (png := rc.crop(handoff, p, after))), None)
        if a_png is None:  # page numbers can shift in a re-rendered PDF
            a_png = next((png for p in range(1, handoff.page_count + 1) if (png := rc.crop(handoff, p, after))), None)
    none = '<div class="none">PDF에서 위치를 찾지 못함</div>'
    chips = [f'<span class="chip blue">{rc.esc(d.get("defect_type", "?"))}</span>',
             f'<span class="chip">난이도 {rc.esc(d.get("level", "?"))}</span>',
             f'<span class="chip {SEVERITY_CHIP.get(d.get("severity"), "")}">{rc.esc(d.get("severity", ""))}</span>']
    if d.get("iterations"):
        chips.append(f'<span class="chip">수정 {rc.esc(d["iterations"])}회</span>')
    return (f'<section class="card"><div class="head"><span class="id">{rc.esc(d.get("defect_id", "?"))}</span>'
            f'{"".join(chips)}</div>'
            f'<div class="meta">바꾼 곳: p.{rc.esc(page)}, {rc.esc(d.get("location", ""))}</div>'
            f'<div class="cols"><div class="panel before"><div class="label">원문</div>'
            f'<div class="quote">{b_html}</div>{rc.png_tag(b_png, "before") if b_png else none}</div>'
            f'<div class="panel after"><div class="label">바꾼 뒤</div>'
            f'<div class="quote">{a_html}</div>'
            f'{rc.png_tag(a_png, "after") if a_png else ("" if handoff is None else none)}</div></div>'
            f'{oracle_block(str(d.get("oracle", "")), src)}'
            f'<div class="section-label">왜 어려운가</div><p>{rc.esc(d.get("why_hard", ""))}</p></section>')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", nargs="?", default=".")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    folder = Path(args.folder)
    key_file = folder / "keys" / "answer_key.json"
    if not key_file.is_file():
        sys.exit(f"ERROR: {key_file} not found")
    defects = json.loads(key_file.read_text(encoding="utf-8"))
    if isinstance(defects, dict):
        defects = defects.get("defects", [defects])
    if rc.fitz is None:
        print("WARNING: PyMuPDF not installed; the report will have no PDF images", file=sys.stderr)
    src = rc.open_pdf(next(iter(sorted((folder / "source").glob("*.pdf"))), None))
    handoff = rc.open_pdf(folder / "handoff" / "paper.pdf")

    first = defects[0] if defects else {}
    types = Counter(d.get("defect_type", "?") for d in defects)
    levels = Counter(str(d.get("level", "?")) for d in defects)
    stats = "".join(f'<span class="chip blue">{rc.esc(t)} × {c}</span>' for t, c in sorted(types.items()))
    stats += "".join(f'<span class="chip">L{rc.esc(l).lstrip("Ll")} × {c}</span>' for l, c in sorted(levels.items()))
    discrepancies = folder / "keys" / "original_discrepancies.md"
    disc = (f'<details><summary>원본에 이미 있던 불일치 (keys/original_discrepancies.md)</summary>'
            f'<pre>{rc.esc(discrepancies.read_text(encoding="utf-8"))}</pre></details>') if discrepancies.is_file() else ""
    note = "" if handoff else '<p class="meta">handoff/paper.pdf 없음: 바꾼 뒤 이미지는 생략</p>'
    body = (f"<h1>Red 결과 · {rc.esc(first.get('paper_id', folder.name))}</h1>"
            f'<p class="sub">라이선스 {rc.esc(first.get("license", "?"))} · 팀 {rc.esc(first.get("team", "?"))} · '
            f'심은 모델 {rc.esc(first.get("plant_model", "?"))} · 결함 {len(defects)}개 '
            f"· <b>정답 포함: 채점 전 Blue에게 공유 금지</b></p>"
            f'<div class="stats">{stats}</div>{note}<h2>1. 심은 결함</h2>'
            + "".join(defect_card(d, src, handoff) for d in defects)
            + f"<h2>2. 원본 점검</h2>{disc or '<p class=none>없음</p>'}")
    out = folder / "keys" / "red_report.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(rc.page_shell(f"Red {first.get('paper_id', folder.name)}", body), encoding="utf-8")
    print(f"wrote {out} ({len(defects)} defects)")


if __name__ == "__main__":
    main()

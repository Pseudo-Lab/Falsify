#!/usr/bin/env python3
"""unified diff 를 원문 마크다운에 적용해 변조본을 만든다.

    python tools/apply_patch.py corpus/raw/PMC12215570.md submissions/w3/team-a/PMC12215570.diff -o work/PMC12215570.tampered.md

- `patch` 명령 없이 파이썬만으로 적용한다.
- 적용에 실패하면 몇 번째 hunk 가 어디서 어긋났는지 알려 준다.
- 변조본 머리에 경고 블록을 넣는다. 원본 id 는 원문 옆의 `<id>.meta.json` 에서 읽고,
  없으면 파일 이름에서 가져온다.
- `--reverse` 로 역패치(변조본 → 원문)를 적용할 수 있다.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from dataclasses import dataclass, field

from _common import atomic_write_text, now_kst_iso

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class PatchError(Exception):
    def __init__(self, hunk_index: int, message: str):
        super().__init__(f"hunk {hunk_index}: {message}")
        self.hunk_index = hunk_index


@dataclass
class Hunk:
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    lines: list[tuple[str, str]] = field(default_factory=list)  # (' ' | '-' | '+', 내용)

    def reversed(self) -> "Hunk":
        swap = {"-": "+", "+": "-", " ": " "}
        return Hunk(self.new_start, self.new_len, self.old_start, self.old_len,
                    [(swap[t], s) for t, s in self.lines])

    @property
    def old_lines(self) -> list[str]:
        return [s for t, s in self.lines if t in (" ", "-")]

    @property
    def new_lines(self) -> list[str]:
        return [s for t, s in self.lines if t in (" ", "+")]


def parse_unified_diff(text: str) -> list[Hunk]:
    hunks: list[Hunk] = []
    cur: Hunk | None = None
    for raw in text.splitlines():
        if raw.startswith("\\ No newline"):
            continue
        m = HUNK_RE.match(raw)
        if m:
            cur = Hunk(int(m.group(1)), int(m.group(2) or 1), int(m.group(3)), int(m.group(4) or 1))
            hunks.append(cur)
            continue
        if cur is None:
            continue  # ---, +++, diff --git, index 같은 머리말
        if raw.startswith(("--- ", "+++ ", "diff ")) and _hunk_full(cur):
            cur = None
            continue
        if raw == "":
            cur.lines.append((" ", ""))  # 빈 문맥 줄은 편집기가 앞 공백을 지우기도 한다
        elif raw[0] in " -+":
            cur.lines.append((raw[0], raw[1:]))
        else:
            if _hunk_full(cur):
                cur = None
            else:
                raise ValueError(f"diff 형식이 아닙니다: {raw[:60]!r}")
    if not hunks:
        raise ValueError("diff 에 hunk(@@ ... @@)가 하나도 없습니다")
    return hunks


def _hunk_full(h: Hunk) -> bool:
    return len(h.old_lines) >= h.old_len and len(h.new_lines) >= h.new_len


def _same(a: str, b: str) -> bool:
    return a.rstrip() == b.rstrip()


def _find(src: list[str], block: list[str], expected: int) -> int | None:
    """expected(0 기반) 근처에서 block 이 들어맞는 위치를 찾는다. 가까운 쪽부터."""
    n, m = len(src), len(block)
    if m == 0:
        return min(max(expected, 0), n)

    def fits(pos: int) -> bool:
        if pos < 0 or pos + m > n:
            return False
        return all(_same(src[pos + i], block[i]) for i in range(m))

    for delta in range(0, n + 1):
        for pos in (expected - delta, expected + delta) if delta else (expected,):
            if fits(pos):
                return pos
    return None


def apply_hunks(src_lines: list[str], hunks: list[Hunk]) -> list[str]:
    out = list(src_lines)
    offset = 0
    for i, h in enumerate(hunks, 1):
        expected = h.old_start - 1 + offset
        block = h.old_lines
        pos = _find(out, block, expected)
        if pos is None:
            near = out[expected] if 0 <= expected < len(out) else "(파일 끝)"
            want = block[0] if block else ""
            raise PatchError(
                i,
                f"@@ -{h.old_start},{h.old_len} @@ 를 적용할 수 없습니다. "
                f"원문 {expected + 1}행 근처에서 문맥이 맞지 않습니다.\n"
                f"  기대: {want[:80]!r}\n  실제: {near[:80]!r}",
            )
        out[pos:pos + len(block)] = h.new_lines
        offset += len(h.new_lines) - len(block)
    return out


def apply_unified_diff(text: str, diff_text: str, reverse: bool = False) -> str:
    hunks = parse_unified_diff(diff_text)
    if reverse:
        hunks = [h.reversed() for h in hunks]
    trailing = text.endswith("\n")
    lines = text.split("\n")
    if trailing:
        lines = lines[:-1]
    result = apply_hunks(lines, hunks)
    return "\n".join(result) + ("\n" if trailing else "")


def find_original_id(md_path: pathlib.Path) -> str:
    meta = md_path.with_suffix("").with_suffix(".meta.json") if md_path.suffix == ".md" else None
    if meta is None or not meta.exists():
        meta = md_path.parent / (md_path.stem + ".meta.json")
    if meta.exists():
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            if data.get("id"):
                return str(data["id"])
        except (json.JSONDecodeError, OSError):
            pass
    return md_path.stem


def make_header(original_id: str, patch_name: str) -> str:
    return (
        "<!--\n"
        "경고: 이 문서는 연구용으로 의도적으로 변조된 것입니다. 인용하거나 사실로 쓰지 마세요.\n"
        f"원본: {original_id}, 패치: {patch_name}, 만든 시각: {now_kst_iso()}\n"
        "Falsify 스터디(Pseudo-Lab) 의 Red 공격 제출물입니다.\n"
        "-->\n\n"
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="unified diff 를 원문에 적용해 변조본을 만든다 (patch 명령 불필요)")
    ap.add_argument("original", help="원문 마크다운 (예: corpus/raw/PMC12215570.md)")
    ap.add_argument("patch", help="unified diff 파일")
    ap.add_argument("-o", "--output", required=True, help="결과 파일")
    ap.add_argument("--reverse", action="store_true", help="역패치(변조본에서 원문으로)")
    ap.add_argument("--no-header", action="store_true", help="경고 블록을 넣지 않는다")
    args = ap.parse_args(argv)

    src_path, patch_path, out_path = map(pathlib.Path, (args.original, args.patch, args.output))
    for p in (src_path, patch_path):
        if not p.exists():
            print(f"실패: 파일이 없습니다: {p}", file=sys.stderr)
            return 1
    text = src_path.read_text(encoding="utf-8")
    diff_text = patch_path.read_text(encoding="utf-8")
    try:
        result = apply_unified_diff(text, diff_text, reverse=args.reverse)
    except (PatchError, ValueError) as e:
        print(f"실패: 패치를 적용하지 못했습니다. {e}", file=sys.stderr)
        return 1
    if not args.no_header and not args.reverse:
        result = make_header(find_original_id(src_path), patch_path.name) + result
    atomic_write_text(out_path, result)
    changed = sum(1 for h in parse_unified_diff(diff_text) for t, _ in h.lines if t != " ")
    print(f"저장: {out_path} (hunk {len(parse_unified_diff(diff_text))}개, 바뀐 줄 {changed}개)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

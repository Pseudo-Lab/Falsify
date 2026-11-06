#!/usr/bin/env python3
"""매주 "마무리 한마디" 스레드의 댓글을 모은다.

    python tools/til_collect.py --week 3
    python tools/til_collect.py --week 3 --repo Pseudo-Lab/Falsify --members 9

스레드는 둘 중 하나다. 둘 다 찾아본다.
  - Discussion: 카테고리 "마무리 한마디", 제목 "[W3] 마무리 한마디"  (gh api graphql)
  - Issue: 라벨 `til`, 제목에 "[W3]"                               (gh issue list / view)

댓글마다 작성자(login), 시각(KST), 종류(본문 첫 글자가 💡 🧱 ➡️ 💬 중 하나면 그것, 아니면 기타),
본문을 뽑는다. 스레드 본문(빌더의 첫 글)도 한 줄로 친다.

출력
  benchmark/til/w{N}.json          그 주차 항목 배열
  benchmark/til/til_by_person.md   사람별 섹션, 주차 순 누적. 그 주차 것만 바꿔 끼운다
  표준 출력: "W3 마무리 한마디: 9명 중 7명, 종류별 💡4 🧱2 ➡️1 💬0"

참여 인원 분모는 --members N 또는 corpus/members.txt(한 줄에 login 하나).

`gh` CLI 가 필요하다: https://cli.github.com  설치 후 `gh auth login`.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

from _common import KST, REPO_ROOT, atomic_write_text, write_json

KINDS = ["💡", "🧱", "➡️", "💬"]
KIND_ALIASES = {"➡": "➡️"}  # 변형 선택자 없는 화살표
DEFAULT_REPO = "Pseudo-Lab/Falsify"
DEFAULT_OUT = REPO_ROOT / "benchmark" / "til"
DEFAULT_MEMBERS = REPO_ROOT / "corpus" / "members.txt"
THREAD_TITLE = "마무리 한마디"
MD_TITLE = "# 마무리 한마디 (사람별)"
ENTRY_RE = re.compile(r"^- W(\d+) \((.*?)\) (.*)$")

GRAPHQL = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url body createdAt
        author { login }
        category { name }
        comments(first: 100) {
          nodes { body createdAt author { login } }
        }
      }
    }
  }
}
"""


class GHError(Exception):
    pass


class NoThreadError(Exception):
    pass


# ---------------------------------------------------------------- gh
def gh_run(args: list[str]) -> str:
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True)
    except FileNotFoundError as e:
        raise GHError("gh 명령을 찾을 수 없습니다. https://cli.github.com 에서 설치하고 `gh auth login` 을 하세요") from e
    if p.returncode != 0:
        raise GHError(f"gh 실행 실패 (종료 코드 {p.returncode}): gh {' '.join(args)}\n{p.stderr.strip()[:400]}")
    return p.stdout


def _json(text: str, what: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise GHError(f"{what} 응답을 JSON 으로 읽지 못했습니다: {e}") from e


def _title_matches(title: str, week: int) -> bool:
    return f"[w{week}]" in (title or "").lower().replace(" ", "")


def find_discussion(week: int, repo: str, gh=gh_run) -> dict | None:
    owner, name = repo.split("/", 1)
    out = gh(["api", "graphql", "-f", f"query={GRAPHQL}", "-F", f"owner={owner}", "-F", f"name={name}"])
    data = _json(out, "graphql")
    nodes = (((data.get("data") or {}).get("repository") or {}).get("discussions") or {}).get("nodes") or []
    hits = [n for n in nodes if _title_matches(n.get("title", ""), week)]
    pref = [n for n in hits if THREAD_TITLE in ((n.get("category") or {}).get("name") or "")]
    chosen = (pref or hits)
    return chosen[0] if chosen else None


def find_issue(week: int, repo: str, gh=gh_run) -> dict | None:
    out = gh(["issue", "list", "--repo", repo, "--label", "til", "--search", f"[W{week}]", "--state", "all",
              "--limit", "50", "--json", "number,title,url"])
    items = _json(out, "issue list")
    hits = [i for i in items if _title_matches(i.get("title", ""), week)]
    if not hits:
        return None
    num = hits[0]["number"]
    out = gh(["issue", "view", str(num), "--repo", repo, "--comments",
              "--json", "number,title,url,body,createdAt,author,comments"])
    return _json(out, "issue view")


# ---------------------------------------------------------------- 가공
def to_kst(iso: str) -> str:
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")


def classify_kind(body: str) -> str:
    s = (body or "").lstrip()
    for k in KINDS:
        if s.startswith(k):
            return k
    for alias, k in KIND_ALIASES.items():
        if s.startswith(alias):
            return k
    return "기타"


def _entry(week: int, login: str, created: str, body: str, source: str) -> dict:
    body = (body or "").strip()
    return {"week": week, "login": login or "(알 수 없음)", "time_utc": created, "time_kst": to_kst(created),
            "kind": classify_kind(body), "body": body, "source": source}


def collect(week: int, repo: str = DEFAULT_REPO, gh=None) -> list[dict]:
    gh = gh or gh_run
    node = find_discussion(week, repo, gh)
    if node is not None:
        src = node.get("url", "")
        entries = [_entry(week, (node.get("author") or {}).get("login", ""), node["createdAt"], node.get("body", ""), src)]
        comments = ((node.get("comments") or {}).get("nodes")) or []
    else:
        node = find_issue(week, repo, gh)
        if node is None:
            raise NoThreadError(
                f"[W{week}] {THREAD_TITLE} 스레드를 찾지 못했습니다 ({repo}). "
                f"Discussion 카테고리 '{THREAD_TITLE}' 또는 라벨 til 이슈로 제목을 '[W{week}] {THREAD_TITLE}' 로 만들어 주세요"
            )
        src = node.get("url", "")
        entries = [_entry(week, (node.get("author") or {}).get("login", ""), node["createdAt"], node.get("body", ""), src)]
        comments = node.get("comments") or []
    for c in sorted(comments, key=lambda c: c.get("createdAt", "")):
        entries.append(_entry(week, (c.get("author") or {}).get("login", ""), c["createdAt"], c.get("body", ""), src))
    return entries


def count_kinds(entries: list[dict]) -> dict[str, int]:
    counts = {k: 0 for k in KINDS}
    counts["기타"] = 0
    for e in entries:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1
    return counts


def unique_logins(entries: list[dict]) -> list[str]:
    return sorted({e["login"] for e in entries})


def summary_line(week: int, entries: list[dict], members: int | None) -> str:
    c = count_kinds(entries)
    n = len(unique_logins(entries))
    who = f"{members}명 중 {n}명" if members else f"{n}명 참여"
    return f"W{week} {THREAD_TITLE}: {who}, 종류별 " + " ".join(f"{k}{c[k]}" for k in KINDS)


# ---------------------------------------------------------------- 사람별 md
def parse_by_person(text: str) -> dict[str, list[tuple[int, str]]]:
    people: dict[str, list[tuple[int, str]]] = {}
    cur: str | None = None
    for line in (text or "").splitlines():
        if line.startswith("## "):
            cur = line[3:].strip()
            people.setdefault(cur, [])
            continue
        m = ENTRY_RE.match(line)
        if m and cur is not None:
            people[cur].append((int(m.group(1)), line))
    return people


def render_by_person(people: dict[str, list[tuple[int, str]]]) -> str:
    out = [MD_TITLE, "", "매주 모임 끝에 남긴 한 줄. 💡 알게 된 것, 🧱 막힌 것, ➡️ 다음에 할 것, 💬 그 밖의 말.", ""]
    for login in sorted(people):
        items = sorted(people[login], key=lambda t: t[0])
        if not items:
            continue
        out.append(f"## {login}")
        out.append("")
        out.extend(line for _, line in items)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def update_by_person(existing: str, week: int, entries: list[dict]) -> str:
    people = parse_by_person(existing)
    for login in people:
        people[login] = [(w, line) for w, line in people[login] if w != week]
    for e in entries:
        body = re.sub(r"\s+", " ", e["body"]).strip()
        people.setdefault(e["login"], []).append((week, f"- W{week} ({e['time_kst']}) {body}"))
    return render_by_person(people)


def read_members(path: pathlib.Path | None) -> int | None:
    if not path:
        return None
    p = pathlib.Path(path)
    if not p.exists():
        return None
    logins = [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    return len(logins) or None


# ---------------------------------------------------------------- 실행
def main(argv=None, gh=None) -> int:
    ap = argparse.ArgumentParser(description="주차별 마무리 한마디 댓글을 모아 JSON 과 사람별 md 로 쌓는다")
    ap.add_argument("--week", type=int, required=True, help="주차 번호 (예: 3)")
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--members", type=int, default=None, help="참여 인원 분모")
    ap.add_argument("--members-file", default=None, help=f"login 목록 파일 (기본 {DEFAULT_MEMBERS.relative_to(REPO_ROOT)})")
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)

    members = args.members or read_members(args.members_file or DEFAULT_MEMBERS)
    try:
        entries = collect(args.week, args.repo, gh=gh)
    except (NoThreadError, GHError) as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1

    out_dir = pathlib.Path(args.out_dir)
    write_json(out_dir / f"w{args.week}.json", entries)
    md_path = out_dir / "til_by_person.md"
    existing = md_path.read_text(encoding="utf-8") if md_path.exists() else ""
    atomic_write_text(md_path, update_by_person(existing, args.week, entries))
    print(summary_line(args.week, entries, members))
    print(f"저장: {out_dir / f'w{args.week}.json'}, {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

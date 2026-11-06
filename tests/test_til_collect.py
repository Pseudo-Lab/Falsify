"""til_collect 검사. gh 호출은 녹화한 JSON 으로 대신한다.

(a) 댓글 5개 중 이모지 있는 것 3개가 종류별로 맞게 세어진다 (스레드 본문 ➡️ 포함)
(b) 같은 사람이 두 번 쓰면 한 명으로 센다
(c) 시각이 UTC 에서 KST 로 +9 시간
(d) 기존 til_by_person.md 에 W2 가 있을 때 W3 를 돌리면 W2 는 남고 W3 만 추가된다
"""
from __future__ import annotations

import json
import pathlib

import pytest

import til_collect as tc


class FakeGH:
    """gh 인자 목록을 녹화 파일에 대응시킨다."""

    def __init__(self, fixtures: pathlib.Path, discussions: bool = True):
        self.d = fixtures / "til"
        self.discussions = discussions
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        joined = " ".join(args)
        if "graphql" in joined:
            if self.discussions:
                return (self.d / "graphql_discussions.json").read_text(encoding="utf-8")
            return json.dumps({"data": {"repository": {"discussions": {"nodes": []}}}})
        if args[:2] == ["issue", "list"]:
            return (self.d / "issue_list_w3.json").read_text(encoding="utf-8")
        if args[:2] == ["issue", "view"]:
            return (self.d / "issue_view_42.json").read_text(encoding="utf-8")
        raise AssertionError(f"녹화되지 않은 gh 호출: {joined}")


def test_a_kinds_counted(fixtures):
    entries = tc.collect(week=3, repo="Pseudo-Lab/Falsify", gh=FakeGH(fixtures))
    assert len(entries) == 6  # 스레드 본문 1 + 댓글 5
    counts = tc.count_kinds(entries)
    assert counts == {"💡": 2, "🧱": 1, "➡️": 1, "💬": 0, "기타": 2}
    assert entries[0]["login"] == "builder" and entries[0]["kind"] == "➡️"
    # 이모지는 본문에서 떼지 않고 그대로 둔다
    assert entries[1]["body"].startswith("💡 표 3과")
    # 앞 공백이 있어도 첫 글자로 판정한다
    assert entries[5]["kind"] == "기타" and entries[5]["body"].startswith("패치 적용")


def test_b_same_person_counted_once(fixtures):
    entries = tc.collect(week=3, repo="Pseudo-Lab/Falsify", gh=FakeGH(fixtures))
    assert tc.unique_logins(entries) == ["alice", "bob", "builder", "carol", "dave"]
    line = tc.summary_line(3, entries, members=9)
    assert line == "W3 마무리 한마디: 9명 중 5명, 종류별 💡2 🧱1 ➡️1 💬0"


def test_c_utc_to_kst(fixtures):
    entries = tc.collect(week=3, repo="Pseudo-Lab/Falsify", gh=FakeGH(fixtures))
    alice = [e for e in entries if e["login"] == "alice"][0]
    assert alice["time_kst"] == "2026-10-19 22:05 KST"
    assert tc.to_kst("2026-10-19T14:59:59Z") == "2026-10-19 23:59 KST"
    assert tc.to_kst("2026-10-19T15:00:00Z") == "2026-10-20 00:00 KST"


def test_falls_back_to_issue_when_no_discussion(fixtures):
    gh = FakeGH(fixtures, discussions=False)
    entries = tc.collect(week=3, repo="Pseudo-Lab/Falsify", gh=gh)
    assert [e["login"] for e in entries] == ["builder", "erin", "frank"]
    assert entries[0]["kind"] == "💬"
    assert all(e["source"].endswith("/issues/42") for e in entries)
    assert any(a[:2] == ["issue", "view"] for a in gh.calls)


def test_wrong_week_is_ignored(fixtures):
    """W2 스레드는 W3 수집에 섞이지 않는다."""
    entries = tc.collect(week=2, repo="Pseudo-Lab/Falsify", gh=FakeGH(fixtures))
    assert len(entries) == 1 and entries[0]["body"].startswith("💡 W2")


def test_d_existing_week_kept(tmp_path, fixtures):
    out = tmp_path / "til"
    out.mkdir()
    existing = (
        "# 마무리 한마디 (사람별)\n\n"
        "## alice\n\n- W2 (2026-10-12 21:00 KST) 💡 지난주 알게 된 것\n\n"
        "## zed\n\n- W2 (2026-10-12 21:01 KST) 🧱 지난주 막힌 것\n"
    )
    (out / "til_by_person.md").write_text(existing, encoding="utf-8")
    code = tc.main(["--week", "3", "--members", "9", "--out-dir", str(out)], gh=FakeGH(fixtures))
    assert code == 0
    md = (out / "til_by_person.md").read_text(encoding="utf-8")
    assert "- W2 (2026-10-12 21:00 KST) 💡 지난주 알게 된 것" in md
    assert "- W2 (2026-10-12 21:01 KST) 🧱 지난주 막힌 것" in md
    assert "- W3 (2026-10-19 22:05 KST) 💡 표 3과 본문을" in md
    assert md.count("## alice") == 1
    assert md.index("W2 (2026-10-12 21:00") < md.index("W3 (2026-10-19 22:05")
    data = json.loads((out / "w3.json").read_text(encoding="utf-8"))
    assert isinstance(data, list) and len(data) == 6
    assert set(data[0]) >= {"login", "time_kst", "kind", "body", "week", "source"}

    # 같은 주차를 다시 돌리면 중복되지 않는다
    tc.main(["--week", "3", "--members", "9", "--out-dir", str(out)], gh=FakeGH(fixtures))
    md2 = (out / "til_by_person.md").read_text(encoding="utf-8")
    assert md2.count("W3 (2026-10-19 22:05 KST)") == 1


def test_members_file(tmp_path, fixtures, capsys):
    out = tmp_path / "til"
    members = tmp_path / "members.txt"
    members.write_text("alice\nbob\ncarol\ndave\nerin\nfrank\nbuilder\n", encoding="utf-8")
    code = tc.main(["--week", "3", "--members-file", str(members), "--out-dir", str(out)],
                   gh=FakeGH(fixtures))
    assert code == 0
    assert "W3 마무리 한마디: 7명 중 5명" in capsys.readouterr().out


def test_no_thread_is_clear_error(fixtures, capsys):
    gh = FakeGH(fixtures, discussions=False)

    def gh_empty(args):
        if args[:2] == ["issue", "list"]:
            return "[]"
        return gh(args)

    code = tc.main(["--week", "7", "--members", "9"], gh=gh_empty)
    assert code == 1
    assert "[W7]" in capsys.readouterr().err


@pytest.mark.network
def test_live_gh():
    """실제 gh 호출. 스레드가 아직 없으면 건너뛴다 (gh 자체가 없으면 실패)."""
    try:
        entries = tc.collect(week=1, repo="Pseudo-Lab/Falsify")
    except tc.NoThreadError as e:
        pytest.skip(str(e))
    assert isinstance(entries, list)

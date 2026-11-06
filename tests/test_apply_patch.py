"""apply_patch 검사. 참값을 아는 작은 md 와 diff 로 왕복한다."""
from __future__ import annotations

import pytest

import apply_patch as ap


@pytest.fixture
def patch_dir(fixtures):
    return fixtures / "patch"


def test_apply_matches_expected(patch_dir):
    original = (patch_dir / "original.md").read_text(encoding="utf-8")
    diff = (patch_dir / "change.diff").read_text(encoding="utf-8")
    expected = (patch_dir / "expected.md").read_text(encoding="utf-8")
    assert ap.apply_unified_diff(original, diff) == expected


def test_round_trip(patch_dir):
    original = (patch_dir / "original.md").read_text(encoding="utf-8")
    diff = (patch_dir / "change.diff").read_text(encoding="utf-8")
    tampered = ap.apply_unified_diff(original, diff)
    assert tampered != original
    back = ap.apply_unified_diff(tampered, diff, reverse=True)
    assert back == original


def test_hunk_count_and_offsets(patch_dir):
    diff = (patch_dir / "change.diff").read_text(encoding="utf-8")
    hunks = ap.parse_unified_diff(diff)
    assert len(hunks) == 2
    assert hunks[0].old_start == 3
    assert hunks[1].old_start == 9


def test_failure_reports_hunk_number(patch_dir):
    diff = (patch_dir / "change.diff").read_text(encoding="utf-8")
    wrong = "completely\ndifferent\ncontent\n"
    with pytest.raises(ap.PatchError) as e:
        ap.apply_unified_diff(wrong, diff)
    assert e.value.hunk_index == 1
    assert "hunk 1" in str(e.value)


def test_fuzzy_offset_is_tolerated(patch_dir):
    """앞쪽에 줄이 끼어들어 위치가 밀려도 문맥이 맞으면 적용한다."""
    original = (patch_dir / "original.md").read_text(encoding="utf-8")
    diff = (patch_dir / "change.diff").read_text(encoding="utf-8")
    shifted = "<!-- inserted -->\n\n" + original
    expected = "<!-- inserted -->\n\n" + (patch_dir / "expected.md").read_text(encoding="utf-8")
    assert ap.apply_unified_diff(shifted, diff) == expected


def test_cli_adds_warning_header(tmp_path, patch_dir):
    original = patch_dir / "original.md"
    out = tmp_path / "tampered.md"
    code = ap.main([str(original), str(patch_dir / "change.diff"), "-o", str(out)])
    assert code == 0
    text = out.read_text(encoding="utf-8")
    assert text.startswith("<!--")
    assert "연구용으로 의도적으로 변조" in text
    assert "원본: PMC00000001" in text  # original.meta.json 의 id
    assert "패치: change.diff" in text
    body = text.split("-->\n", 1)[1].lstrip("\n")
    assert body == (patch_dir / "expected.md").read_text(encoding="utf-8")


def test_cli_falls_back_to_stem_without_meta(tmp_path, patch_dir):
    src = tmp_path / "PMC99999999.md"
    src.write_text((patch_dir / "original.md").read_text(encoding="utf-8"), encoding="utf-8")
    out = tmp_path / "t.md"
    assert ap.main([str(src), str(patch_dir / "change.diff"), "-o", str(out)]) == 0
    assert "원본: PMC99999999" in out.read_text(encoding="utf-8")


def test_cli_failure_exit_code(tmp_path, patch_dir, capsys):
    src = tmp_path / "x.md"
    src.write_text("nothing here\n", encoding="utf-8")
    out = tmp_path / "t.md"
    code = ap.main([str(src), str(patch_dir / "change.diff"), "-o", str(out)])
    assert code == 1
    assert "hunk 1" in capsys.readouterr().err
    assert not out.exists()

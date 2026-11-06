"""demo.py 의 검사 문장 고르기를 참값을 아는 입력으로 건다.

맹검 규율이 코드로 지켜지는지가 핵심이다. 탐지기에 들어가는 글과 대조군이 모두 변조본
안에서 나와야 한다. 원본 문장이 대조군으로 새어 나오면 그 문장은 변조본에 없어서
참인데도 낮게 나오고, 대조가 조용히 무너진다.
"""
import demo
from pathlib import Path

ORIG = ["The model reached an accuracy of 92 percent on the held out split of the corpus. "
        "We trained every baseline for 30 epochs with the same random seed and schedule. "
        "Each run was repeated three times and we report the mean of those runs."]
BAD = ["The model reached an accuracy of 47 percent on the held out split of the corpus. "
       "We trained every baseline for 30 epochs with the same random seed and schedule. "
       "Each run was repeated three times and we report the mean of those runs."]


def test_diff_detects_the_changed_sentence():
    pairs = demo.pick_pairs_diff(BAD, ORIG, 5)
    assert len(pairs) == 1, pairs
    assert "47 percent" in pairs[0]["altered"]


def test_control_comes_from_the_altered_pdf_not_the_original():
    """대조군은 변조본 안에 그대로 있어야 한다. 원본 문장을 쓰면 안 된다."""
    pairs = demo.pick_pairs_diff(BAD, ORIG, 5)
    ctrl = pairs[0]["true"]
    assert ctrl in BAD[0], "대조군이 변조본에 없습니다. 준 글에 담기지 않아 대조가 무너집니다"
    assert "92 percent" not in ctrl, "원본 문장이 대조군으로 새어 나왔습니다"


def test_both_sentences_are_inside_the_evidence_window():
    """1단에 거는 두 문장 모두 변조본 본문에서 근거 창을 찾을 수 있어야 한다."""
    full = " ".join(BAD)
    p = demo.pick_pairs_diff(BAD, ORIG, 5)[0]
    assert demo.window(full, p["true"]) is not None
    assert demo.window(full, p["altered"]) is not None


def test_no_change_means_no_pairs():
    assert demo.pick_pairs_diff(ORIG, ORIG, 5) == []


def test_auto_mode_control_is_the_original_sentence():
    pairs = demo.pick_pairs_auto(BAD, 3)
    assert pairs, "숫자가 든 문장을 못 골랐습니다"
    for p in pairs:
        assert p["true"] in BAD[0]
        assert p["true"] != p["altered"]


def test_bibliography_is_skipped():
    refs = ["Smith et al. In Proceedings of the 41st Conference on Machine Learning, pages 12 to 30. "
            "Jones and Lee. Journal of Statistics, vol. 12, pp. 44 to 90, with arXiv:2401.00001 listed."]
    assert demo.pick_pairs_auto(refs, 3) == []


def test_orig_needs_unblinded_flag(capsys, monkeypatch, tmp_path):
    """맹검 해제를 밝히지 않고 원본을 주면 거부해야 한다."""
    f = tmp_path / "x.pdf"; f.write_bytes(b"%PDF-1.4\n")
    monkeypatch.setattr("sys.argv", ["demo.py", str(f), "--orig", str(f)])
    assert demo.main() == 2
    assert "맹검이 풀린 뒤에만" in capsys.readouterr().out


def test_best_page_skips_the_reference_list():
    """참고문헌 쪽을 2단 입력으로 고르면 안 된다. 번호를 숫자 모순으로 오인한다."""
    body = ["Patients were randomized to two arms. " * 40 +
            "eGFR fell by 2.1 and 3.4 mL per minute in the two groups over 24 months. " * 6]
    refs = ["References 1. Smith A. Journal of Nephrology. 2024; 12: 33 to 40. " * 30]
    assert demo.best_page(body + refs) == 0


def test_no_account_identifier_is_hardcoded():
    """계정에 묶인 값은 기본값으로 박지 않는다. 저장소에 올라가면 내 계정의 리소스 이름이 공개된다.

    참값이 파일에 있으므로 계약 검사다. 환경변수 이름은 남겨도 되고, 비어 있지 않은 기본값만 막는다.
    """
    import re
    src = Path(__file__).with_name("demo.py").read_text()
    scoped = {"FALSIFY_AWS_PROFILE", "FALSIFY_GUARDRAIL_ID"}
    bad = []
    for key, default in re.findall(r'os\.environ\.get\(\s*"([A-Z_]+)"\s*,\s*"([^"]*)"\s*\)', src):
        if key in scoped and default:
            bad.append((key, default))
    assert not bad, f"계정에 묶인 기본값이 박혀 있습니다: {bad}"

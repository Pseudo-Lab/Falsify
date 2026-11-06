"""score 검사. 참값을 아는 더미 CSV 와 정답지로 먼저 건다.

(a) 다 잡음 → 재현율 1.0, 정밀도 1.0, 다음 수 red_up
(b) 4건 중 2건 놓침 → 재현율 0.5, 다음 수 blue_rematch
(c) 다 잡았는데 오탐 3 → blue_precision
(d) 확인필요 과반 → human_review
(e) 홀드아웃 논문의 지적은 재현율 분모에 안 들어가고 FP 율로만
(f) 두 팀이 완전히 같은 판정 → kappa 1.0, 완전히 다른 판정 → kappa <= 0
(g) 위치 매칭은 줄 번호 ±2 허용
"""
from __future__ import annotations

import csv
import json
import pathlib

import pytest

import score

COLS = score.REQUIRED_COLUMNS


def write_blue(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in COLS})


def row(paper, team, loc, label="맞음", defect="D1", iteration=1, holdout=False):
    return dict(
        paper_id=paper, team=team, judge_type="model", model="dummy", iteration=iteration,
        location=f"L{loc}", defect_type=defect, label=label, evidence="e", time_sec=10,
        tokens=100, is_holdout="true" if holdout else "false",
    )


def write_keys(keys_dir: pathlib.Path, paper: str, locs: list[int], team="red-a") -> None:
    keys_dir.mkdir(parents=True, exist_ok=True)
    defects = [
        dict(paper_id=paper, team=team, defect_type="D1", location=f"L{l}", before="a", after="b",
             iterations=1, self_check_model="dummy", patch_v1="p1.diff", patch_final="p2.diff",
             why_hard="")
        for l in locs
    ]
    (keys_dir / f"{paper}.json").write_text(json.dumps(defects, ensure_ascii=False), encoding="utf-8")


def write_papers(path: pathlib.Path, papers: dict[str, str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "title", "license", "source", "team", "role", "level"])
        for pid, role in papers.items():
            w.writerow([pid, "t", "cc by", "europepmc", "red-a", role, "L1"])


@pytest.fixture
def ws(tmp_path):
    """results/w1, keys/, papers.csv 경로 묶음."""
    results = tmp_path / "results" / "w1"
    keys = tmp_path / "keys"
    papers = tmp_path / "papers.csv"
    results.mkdir(parents=True)
    return dict(results=results, keys=keys, papers=papers, root=tmp_path)


def run(ws, papers=None):
    write_papers(ws["papers"], papers or {"P1": "team"})
    return score.score_dir(ws["results"], ws["keys"], ws["papers"])


def test_a_all_caught_is_red_up(ws):
    write_keys(ws["keys"], "P1", [10, 20, 30, 40])
    write_blue(ws["results"] / "blue-x.csv", [row("P1", "blue-x", l) for l in (10, 20, 30, 40)])
    r = run(ws)
    p = r["papers"]["P1"]
    assert p["recall"] == 1.0 and p["precision"] == 1.0
    assert p["false_positives"] == 0 and p["max_iteration"] == 1
    assert p["next_move"] == "red_up"
    assert r["overall"]["recall"] == 1.0


def test_b_half_missed_is_blue_rematch(ws):
    write_keys(ws["keys"], "P1", [10, 20, 30, 40])
    write_blue(ws["results"] / "blue-x.csv", [row("P1", "blue-x", l) for l in (10, 20)])
    r = run(ws)
    p = r["papers"]["P1"]
    assert p["recall"] == 0.5
    assert p["missed"] == ["L30", "L40"]
    assert p["next_move"] == "blue_rematch"


def test_c_all_caught_with_three_fp_is_blue_precision(ws):
    write_keys(ws["keys"], "P1", [10, 20, 30, 40])
    rows = [row("P1", "blue-x", l) for l in (10, 20, 30, 40, 100, 200, 300)]
    write_blue(ws["results"] / "blue-x.csv", rows)
    r = run(ws)
    p = r["papers"]["P1"]
    assert p["recall"] == 1.0
    assert p["false_positives"] == 3
    assert p["precision"] == pytest.approx(4 / 7)
    assert p["next_move"] == "blue_precision"


def test_d_abstain_majority_is_human_review(ws):
    write_keys(ws["keys"], "P1", [10, 20])
    rows = [row("P1", "blue-x", 10), row("P1", "blue-x", 20)] + [
        row("P1", "blue-x", l, label="확인필요") for l in (30, 40, 50)
    ]
    write_blue(ws["results"] / "blue-x.csv", rows)
    r = run(ws)
    p = r["papers"]["P1"]
    assert p["abstain_rate"] == pytest.approx(3 / 5)
    assert p["next_move"] == "human_review"


def test_e_holdout_flags_count_only_as_fp(ws):
    write_keys(ws["keys"], "P1", [10, 20])
    rows = [row("P1", "blue-x", 10), row("P1", "blue-x", 20),
            row("H1", "blue-x", 5, holdout=True), row("H1", "blue-x", 50, label="아님", holdout=True)]
    write_blue(ws["results"] / "blue-x.csv", rows)
    r = run(ws, {"P1": "team", "H1": "holdout"})
    assert r["overall"]["recall"] == 1.0
    assert r["overall"]["true_positives"] == 2 and r["overall"]["key_defects"] == 2
    assert r["holdout"]["papers"] == ["H1"]
    assert r["holdout"]["flags"] == 1
    assert r["holdout"]["judgments"] == 2
    assert r["holdout"]["false_positive_rate"] == 0.5
    assert r["papers"]["H1"]["next_move"] == "holdout"
    # 홀드아웃 오탐은 전체 정밀도 분모에도 들어간다
    assert r["overall"]["precision"] == pytest.approx(2 / 3)


def test_f_kappa_identical_and_disjoint(ws):
    write_keys(ws["keys"], "P1", [10, 20])
    write_keys(ws["keys"], "P2", [10, 20])
    rows = [row("P1", "blue-x", 10), row("P1", "blue-x", 20),
            row("P1", "blue-y", 10), row("P1", "blue-y", 20),
            row("P2", "blue-x", 10), row("P2", "blue-x", 20),
            row("P2", "blue-y", 30), row("P2", "blue-y", 40)]
    write_blue(ws["results"] / "all.csv", rows)
    r = run(ws, {"P1": "team", "P2": "team"})
    assert r["agreement"]["P1"]["kappa"] == 1.0
    assert r["agreement"]["P2"]["kappa"] <= 0
    assert r["agreement"]["P1"]["teams"] == ["blue-x", "blue-y"]


def test_kappa_function_directly():
    assert score.cohen_kappa([True, False, True], [True, False, True]) == 1.0
    assert score.cohen_kappa([True, True, False, False], [False, False, True, True]) == -1.0
    assert score.cohen_kappa([True, False, False, False], [True, False, False, False]) == 1.0


def test_g_location_tolerance_two_lines(ws):
    write_keys(ws["keys"], "P1", [100, 200, 300])
    rows = [row("P1", "blue-x", 102), row("P1", "blue-x", 198), row("P1", "blue-x", 303)]
    write_blue(ws["results"] / "blue-x.csv", rows)
    r = run(ws)
    p = r["papers"]["P1"]
    assert p["true_positives"] == 2
    assert p["missed"] == ["L300"]
    assert p["false_positives"] == 1


def test_location_parsing():
    assert score.parse_location("L142") == 142
    assert score.parse_location("142") == 142
    assert score.parse_location("line 142") == 142
    assert score.parse_location("줄 142") == 142
    assert score.parse_location("Table 3") is None
    assert score.locations_match("L10", "L12") and not score.locations_match("L10", "L13")
    assert score.locations_match("Table 3", "table 3") and not score.locations_match("Table 3", "L3")


def test_iteration_recall_uses_final_round(ws):
    write_keys(ws["keys"], "P1", [10, 20])
    rows = [row("P1", "blue-x", 10, iteration=1),
            row("P1", "blue-x", 10, iteration=2), row("P1", "blue-x", 20, iteration=2)]
    write_blue(ws["results"] / "blue-x.csv", rows)
    r = run(ws)
    assert r["by_iteration"]["1"]["recall"] == 0.5
    assert r["by_iteration"]["2"]["recall"] == 1.0
    p = r["papers"]["P1"]
    assert p["recall"] == 1.0 and p["max_iteration"] == 2
    assert p["next_move"] == "hold"  # 다 잡았지만 반복이 1회가 아니라 승급하지 않는다


def test_missing_columns_exit_2(ws, capsys):
    bad = ws["results"] / "bad.csv"
    bad.write_text("paper_id,team,label\nP1,x,맞음\n", encoding="utf-8")
    write_keys(ws["keys"], "P1", [10])
    write_papers(ws["papers"], {"P1": "team"})
    code = score.main([str(ws["results"]), "--keys", str(ws["keys"]), "--papers", str(ws["papers"])])
    assert code == 2
    err = capsys.readouterr().err
    for col in ("judge_type", "model", "iteration", "location", "defect_type", "evidence",
                "time_sec", "tokens", "is_holdout"):
        assert col in err


def test_unknown_label_exit_2(ws, capsys):
    write_keys(ws["keys"], "P1", [10])
    write_blue(ws["results"] / "b.csv", [row("P1", "b", 10, label="maybe")])
    write_papers(ws["papers"], {"P1": "team"})
    code = score.main([str(ws["results"]), "--keys", str(ws["keys"]), "--papers", str(ws["papers"])])
    assert code == 2
    assert "maybe" in capsys.readouterr().err


def test_cli_writes_benchmark_json_and_table(ws, capsys, monkeypatch):
    write_keys(ws["keys"], "P1", [10, 20])
    write_blue(ws["results"] / "b.csv", [row("P1", "b", 10), row("P1", "b", 20)])
    write_papers(ws["papers"], {"P1": "team"})
    out = ws["root"] / "benchmark"
    code = score.main([str(ws["results"]), "--keys", str(ws["keys"]), "--papers", str(ws["papers"]),
                       "--out-dir", str(out)])
    assert code == 0
    data = json.loads((out / "w1.json").read_text(encoding="utf-8"))
    assert data["week"] == "w1"
    assert data["papers"]["P1"]["next_move"] == "red_up"
    printed = capsys.readouterr().out
    assert "P1" in printed and "red_up" in printed and "재현율" in printed

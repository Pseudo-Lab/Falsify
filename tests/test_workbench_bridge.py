"""Offline tests for tools/workbench_bridge.py (RED/BLUE conversions and roundtrip checks)."""
from __future__ import annotations

import csv
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import score  # noqa: E402
import workbench_bridge as wb  # noqa: E402
from eval import run_eval  # noqa: E402
from submissions import validate_submission  # noqa: E402


def _read_csv_rows(path: pathlib.Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def test_red_external_batch_and_blind_leakage_isolation(tmp_path: pathlib.Path):
    doc_path = tmp_path / "source.md"
    doc_path.write_text(
        "# Trial\n\nMean reduction was 12.36 points (95% CI [-1.85, -0.42]).\n",
        encoding="utf-8",
    )
    batch = {
        "schema": "falsify.external-batch.v1",
        "role": "red",
        "paperId": "PMC9000001",
        "team": "red-alpha",
        "items": [
            {
                "caseId": "case-d1-01",
                "attackTypes": ["D1"],
                "kind": "table-cell",
                "pageIndex": 3,
                "location": "L3",
                "before": "Mean reduction was 12.36 points (95% CI [-1.85, -0.42]).",
                "after": "Mean reduction was 14.36 points (95% CI [-1.85, -0.42]).",
                "rationale": "Plausible digit swap that stays inside prose narrative.",
            }
        ],
    }
    in_json = tmp_path / "red_batch.json"
    in_json.write_text(json.dumps(batch), encoding="utf-8")

    out_dir = tmp_path / "red_out"
    rc = wb.main([
        "red-to-submission",
        str(in_json),
        "--out-dir",
        str(out_dir),
        "--document",
        str(doc_path),
    ])
    assert rc == 0

    sub_path = out_dir / "submissions" / "red_submission.json"
    assert validate_submission.main([str(sub_path)]) == 0
    sub_data = json.loads(sub_path.read_text(encoding="utf-8"))
    assert sub_data["defect_type"] == "D1"
    assert sub_data["intended_label"] == "아님"
    assert "@@" in sub_data["patch"]
    assert "-Mean reduction was 12.36" in sub_data["patch"]
    assert "+Mean reduction was 14.36" in sub_data["patch"]

    blind_text = (out_dir / "blind" / "PMC9000001.blind.md").read_text(encoding="utf-8")
    assert "14.36 points" in blind_text
    assert "Plausible digit swap" not in blind_text
    assert "intended_label" not in blind_text
    assert "answer_key" not in blind_text
    assert "pageIndex" not in blind_text

    ak_rows = _read_csv_rows(out_dir / "organizer" / "answer_key.csv")
    assert len(ak_rows) == 1
    assert ak_rows[0]["case_id"] == "case-d1-01"
    assert ak_rows[0]["page_index"] == "3"
    assert "12.36" in ak_rows[0]["before"]
    assert "14.36" in ak_rows[0]["after"]
    assert "Plausible digit swap" in ak_rows[0]["rationale"]
    assert run_eval._load_answer_key_csv(out_dir / "organizer" / "answer_key.csv")["case-d1-01"]["verdict"] == "아님"


def test_red_proposals_review_bundle_and_visual_edits_mapping(tmp_path: pathlib.Path):
    visual_edits = [
        {
            "id": "ve-change-cit",
            "kind": "change",
            "pageIndex": 5,
            "before": "[1] Kim S. Original Sleep Study. doi:10.1000/123",
            "after": "[1] Kim S. Fabricated Miracle Study. doi:10.1000/123",
            "rationale": "Altered reference title while keeping real DOI.",
        },
        {
            "id": "ve-table",
            "kind": "table-cell",
            "pageIndex": 2,
            "before": {"value": "78.4%"},
            "after": {"value": "68.4%"},
            "rationale": "Table percentage mismatch.",
        },
        {
            "id": "ve-chart",
            "kind": "chart-point",
            "pageIndex": 4,
            "before": {"y": 4.2},
            "after": {"y": 9.2},
            "rationale": "Shifted plotted chart bar point.",
        },
    ]
    ve_path = tmp_path / "falsify-visual-edits.json"
    ve_path.write_text(json.dumps(visual_edits), encoding="utf-8")
    res_ve = wb.convert_red_to_submission(ve_path, tmp_path / "ve_out", paper_id="PMC8000001")
    assert [r.defect_type for r in res_ve["records"]] == ["D2", "D1", "D1"]
    assert validate_submission.main([str(tmp_path / "ve_out" / "submissions")]) == 0

    proposals = {
        "schema": "falsify.external-proposals.v1",
        "paperId": "PMC8000002",
        "proposals": [
            {
                "proposalId": "prop-1",
                "kind": "change",
                "pageIndex": 6,
                "location": "L99",
                "before": "Secondary sleep latency showed no significant change (p = 0.09).",
                "after": "Secondary sleep latency significantly improved after treatment (p = 0.09).",
                "rationale": "Conclusion overclaims a null p-value.",
            }
        ],
    }
    res_prop = wb.convert_red_to_submission(proposals, tmp_path / "prop_out")
    assert res_prop["records"][0].defect_type == "D3"
    assert res_prop["records"][0].location == "L99"

    bundle = {
        "schema": "falsify.review-bundle.v1",
        "paper": {"id": "PMC8000003"},
        "red": {
            "attacks": [
                {
                    "id": "b-1",
                    "kind": "chart-point",
                    "pageIndex": 1,
                    "before": "10.0",
                    "after": "15.0",
                    "rationale": "Custom override check.",
                }
            ]
        },
    }
    res_override = wb.convert_red_to_submission(bundle, tmp_path / "ovr_out", defect_type="D3")
    assert res_override["records"][0].defect_type == "D3"

    res_custom = wb.convert_red_to_submission(
        bundle,
        tmp_path / "cust_out",
        defect_type="D4_STATUS",
        detector_spec="Checks registry alignment",
    )
    assert res_custom["records"][0].defect_type == "D4_STATUS"
    assert validate_submission.main([str(tmp_path / "cust_out" / "submissions")]) == 0


def test_red_rejects_blue_role_and_leakage(tmp_path: pathlib.Path):
    blue_payload = {"schema": "falsify.external-batch.v1", "role": "blue", "findings": []}
    with pytest.raises(wb.BridgeError, match="role='blue'"):
        wb.convert_red_to_submission(blue_payload, tmp_path / "bad_red")

    leaked_red = {
        "schema": "falsify.external-batch.v1",
        "role": "red",
        "paperId": "PMC1",
        "items": [
            {
                "caseId": "leak-1",
                "before": "orig",
                "after": 'tampered "intended_label": "아님"',
                "rationale": "test",
            }
        ],
    }
    with pytest.raises(validate_submission.SubmissionValidationError, match="leakage"):
        wb.convert_red_to_submission(leaked_red, tmp_path / "leak_out")


def test_blue_to_predictions_deterministic_mapping_and_score_compat(tmp_path: pathlib.Path):
    blue_batch = {
        "schema": "falsify.external-batch.v1",
        "role": "blue",
        "paperId": "PMC9000001",
        "team": "blue-wb",
        "model": "wb-harness-v1",
        "iteration": 1,
        "findings": [
            {
                "caseId": "f-crit",
                "defectType": "D1",
                "location": "L18",
                "severity": "critical",
                "status": "discrepant",
                "confidence": 0.95,
                "evidenceQuote": "mean reduction was 14.36",
                "evidence": "Prose 14.36 disagrees with Table 2 12.36",
            },
            {
                "caseId": "f-major",
                "attackTypes": ["citation"],
                "location": "L42",
                "severity": "major",
                "evidenceQuote": "Fabricated citation title",
            },
            {
                "caseId": "f-uncertain",
                "defectType": "D3",
                "location": "L55",
                "status": "needs-verification",
                "severity": "warning",
                "confidence": 45,
                "evidenceQuote": "Unclear subgroup scope",
            },
            {
                "caseId": "f-clean",
                "defectType": "D1",
                "location": "L80",
                "status": "clean",
                "severity": "none",
                "confidence": 0.99,
                "evidenceQuote": "Matches Table 2 exactly",
            },
        ],
    }
    in_json = tmp_path / "blue.json"
    in_json.write_text(json.dumps(blue_batch), encoding="utf-8")
    out_csv = tmp_path / "results" / "predictions.csv"

    rc = wb.main(["blue-to-predictions", str(in_json), "-o", str(out_csv)])
    assert rc == 0
    assert validate_submission.validate_blue_csv(out_csv) == 4

    rows = {r["case_id"]: r for r in _read_csv_rows(out_csv)}
    assert set(("case_id", "verdict", "defect_type", "confidence", "evidence_quote")).issubset(rows["f-crit"].keys())
    assert rows["f-crit"]["verdict"] == "아님"
    assert rows["f-crit"]["label"] == "맞음"
    assert rows["f-major"]["verdict"] == "아님"
    assert rows["f-major"]["label"] == "맞음"
    assert rows["f-major"]["defect_type"] == "D2"
    assert rows["f-uncertain"]["verdict"] == "확인필요"
    assert rows["f-uncertain"]["label"] == "확인필요"
    assert rows["f-uncertain"]["confidence"] == "0.4500"
    assert rows["f-clean"]["verdict"] == "맞음"
    assert rows["f-clean"]["label"] == "아님"

    loaded = score.load_blue_rows(out_csv.parent)
    assert len(loaded) == 4


def test_blue_harness_list_dedup_and_red_rejection(tmp_path: pathlib.Path):
    harness_out = [
        {
            "caseId": "dup-1",
            "paperId": "PMC100",
            "location": "L10",
            "defectType": "D1",
            "status": "uncertain",
            "confidence": 0.4,
            "evidenceQuote": "first pass",
        },
        {
            "caseId": "dup-2",
            "paperId": "PMC100",
            "location": "L10",
            "defectType": "D1",
            "severity": "error",
            "confidence": 0.92,
            "evidenceQuote": "confirmed error",
        },
    ]
    out_csv = tmp_path / "harness.csv"
    res = wb.convert_blue_to_predictions(harness_out, out_csv, team="harness-team", is_holdout=True)
    assert res["rows"] == 1
    assert res["defects_detected"] == 1
    row = _read_csv_rows(out_csv)[0]
    assert row["verdict"] == "아님"
    assert row["is_holdout"] == "true"

    with pytest.raises(wb.BridgeError, match="role='red'"):
        wb.convert_blue_to_predictions({"role": "red", "items": []}, tmp_path / "bad.csv")


def test_roundtrip_check_cli_self_test_and_custom_inputs(tmp_path: pathlib.Path, capsys):
    assert wb.main(["roundtrip-check", "--self-test"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert out["blind_leakage_free"] is True
    assert out["overall_score"]["recall"] == 1.0
    assert out["overall_score"]["precision"] == 1.0

    red_file = tmp_path / "red.json"
    blue_file = tmp_path / "blue.json"
    red_file.write_text(
        json.dumps({
            "schema": "falsify.external-batch.v1",
            "role": "red",
            "paperId": "PMC555",
            "items": [
                {"caseId": "c1", "attackTypes": ["D1"], "location": "L10", "before": "1.2", "after": "2.1", "rationale": "swap"},
                {"caseId": "c2", "attackTypes": ["D3"], "location": "L30", "before": "null", "after": "sig", "rationale": "spin"},
            ],
        }),
        encoding="utf-8",
    )
    blue_file.write_text(
        json.dumps({
            "schema": "falsify.blue-harness.v1",
            "paperId": "PMC555",
            "findings": [
                {"caseId": "c1", "defectType": "D1", "location": "L11", "severity": "critical", "evidenceQuote": "2.1 vs 1.2"},
                {"caseId": "c2", "defectType": "D3", "location": "L30", "status": "clean", "evidenceQuote": "looks fine"},
            ],
        }),
        encoding="utf-8",
    )
    work_dir = tmp_path / "rt_work"
    assert wb.main(["roundtrip-check", "--red", str(red_file), "--blue", str(blue_file), "--work-dir", str(work_dir)]) == 0
    rt_out = json.loads(capsys.readouterr().out)
    assert rt_out["red_submissions_validated"] == 2
    assert rt_out["blue_rows_validated"] == 2
    assert rt_out["overall_score"]["true_positives"] == 1
    assert rt_out["overall_score"]["recall"] == 0.5
    assert rt_out["papers"]["PMC555"]["next_move"] == "blue_rematch"

    assert wb.main(["roundtrip-check"]) == 1

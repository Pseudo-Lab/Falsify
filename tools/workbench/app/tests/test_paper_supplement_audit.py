"""Pytest suite for app/local/paper_supplement_audit.py."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_supplement_audit as psa  # noqa: E402

FORBIDDEN_RED_KEYS = ("before", "after", "patch", "gold", "why_hard", "candidateRationales")


def _assert_no_red_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert k not in FORBIDDEN_RED_KEYS
            _assert_no_red_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_red_keys(item)


def test_w4_missing_table_s4_and_metric_mismatch_across_pages_and_csv():
    pages = [
        "Introduction: cohort N = 120 patients (n = 60 treatment, n = 60 control).",
        "Results: Table S1 shows AUC = 0.94 (p = 0.003). Fig. S2 shows curves. Subgroup tests are in Table S4.",
    ]
    supplements = [
        {
            "name": "Table_S1.csv",
            "text": "Model,AUC,p_value\nProposed,0.81,0.041\n",
        },
        {
            "name": "supplement_notes.md",
            "text": "Table S1 details.\nFigure S2 sensitivity curves.\nTable S3 adverse events.",
        },
    ]
    report = psa.audit_paper_with_supplements(pages, supplements)
    assert report["schema"] == psa.SCHEMA
    assert report["supplementCount"] == 2
    _assert_no_red_keys(report)

    missing = [s for s in report["signals"] if s["kind"] == "missing_supplementary_item"]
    assert len(missing) == 1
    assert missing[0]["family"] == "D4-1"
    assert missing[0]["reported"]["item"] == "Table S4"

    metric_sigs = [s for s in report["signals"] if s["kind"] == "cross_file_metric_mismatch"]
    assert {s["reported"]["metric"] for s in metric_sigs} == {"auc", "p"}
    assert all(s["family"] == "D1" for s in metric_sigs)


def test_w3_w4_sample_size_mismatch_csv_rows_and_execution_log():
    main_text = "We enrolled N = 240 participants across 3 clinics. Final accuracy = 94.2%."
    csv_lines = ["patient_id,clinic,outcome"] + [f"ID{i},C1,{i % 2}" for i in range(1, 186)]
    supplements = [
        {"name": "participants.csv", "text": "\n".join(csv_lines)},
        {"name": "run_eval.log", "text": "Loaded 185 rows\naccuracy = 0.812\nF1 = 0.79"},
    ]
    report = psa.audit_paper_with_supplements(main_text, supplements)
    _assert_no_red_keys(report)

    n_sigs = [s for s in report["signals"] if s["kind"] == "cross_file_sample_size_mismatch"]
    assert len(n_sigs) >= 1
    assert n_sigs[0]["reported"]["mainN"] == 240
    assert n_sigs[0]["computed"]["supplementN"] == 185

    m_sigs = [s for s in report["signals"] if s["kind"] == "cross_file_metric_mismatch"]
    assert len(m_sigs) == 1
    assert m_sigs[0]["reported"]["metric"] == "accuracy"
    assert m_sigs[0]["computed"]["supplementValue"] == pytest.approx(0.812)


def test_clean_multifile_bundle_korean_anchors_cohorts_and_percent_equivalence():
    main_text = (
        "Discovery cohort (N = 200) and Validation cohort (N = 80). "
        "보충표 1, 보충그림 2, Supplementary Data 1, Appendix B를 참조하라. "
        "In Table S1, accuracy = 94.2% and AUC = 0.91."
    )
    supplements = [
        {
            "name": "supplement.txt",
            "text": "Table S1: accuracy = 0.942, AUC = 0.91.\nFigure S2.\nSupplementary Data 1.\nAppendix B.",
        },
        {
            "name": "validation_cohort.csv",
            "text": "patient_id,score\n" + "\n".join(f"P{i},0.9" for i in range(80)),
        },
        {
            "name": "metrics_summary.csv",
            "text": "Metric,Value\nAccuracy,94.2%\nAUC,0.91",
        },
    ]
    report = psa.audit_paper_with_supplements(main_text, supplements)
    assert report["counts"]["total"] == 0

    no_supp = psa.audit_paper_with_supplements("See Table S4.", [])
    assert no_supp["counts"]["total"] == 0


def test_blindness_guard_rejects_forbidden_red_keys():
    with pytest.raises(ValueError, match="forbidden_red_key"):
        psa.audit_paper_with_supplements([{"id": "s0", "text": "ok", "before": "x"}], [])
    with pytest.raises(ValueError, match="forbidden_red_key"):
        psa.audit_paper_with_supplements("ok", [{"name": "s.txt", "text": "hi", "gold": True}])
    with pytest.raises(ValueError, match="forbidden_red_key"):
        psa.audit_paper_with_supplements("ok", [{"name": "s.txt", "text": "hi", "candidateRationales": ["x"]}])


def test_http_supplement_audit_operation_on_prepared_pdf():
    import base64
    import hashlib
    import pymupdf
    import paper_evidence as pe
    import paper_evidence_http as http

    doc = pymupdf.open()
    p = doc.new_page()
    p.insert_text((72, 72), "Cohort N = 240 patients. Table S1 reports AUC = 0.94. See Table S4.", fontsize=11)
    raw = doc.tobytes()
    doc.close()

    store = pe.EvidenceStore()
    prep = http.prepare({"fileHash": hashlib.sha256(raw).hexdigest(), "file": base64.b64encode(raw).decode("ascii")}, store=store)
    res = http.query({
        "paperId": prep["paperId"],
        "operation": "supplement_audit",
        "supplements": [{"name": "Table_S1.csv", "text": "Model,AUC\nMain,0.81\n"}],
    }, store=store)
    assert res["schema"] == psa.SCHEMA
    kinds = {s["kind"] for s in res["signals"]}
    assert "missing_supplementary_item" in kinds
    assert "cross_file_metric_mismatch" in kinds
    with pytest.raises(ValueError, match="paper_evidence_request_invalid"):
        http.query({
            "paperId": prep["paperId"],
            "operation": "supplement_audit",
            "supplements": [{"name": "s.txt", "text": "x", "gold": True}],
        }, store=store)


def test_python_module_ccn_under_15():
    root = Path(__file__).resolve().parents[2]
    src = (root / "app" / "local" / "paper_supplement_audit.py").read_bytes()
    proc = subprocess.run(
        [sys.executable, str(root / "tools" / "quality" / "python-functions.py")],
        input=src,
        capture_output=True,
        check=True,
    )
    fns = json.loads(proc.stdout.decode("utf-8"))
    assert fns
    assert all(fn["ccn"] <= 15 for fn in fns), [fn for fn in fns if fn["ccn"] > 15]

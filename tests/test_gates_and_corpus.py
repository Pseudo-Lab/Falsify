"""Offline unit and integration tests for gates (D1/D2/D3), corpus, submissions, and eval."""
from __future__ import annotations

import csv
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import score  # noqa: E402 (imported via tests/conftest.py path)
from corpus import validate_corpus  # noqa: E402
from eval import run_eval  # noqa: E402
from gates import cli as gates_cli  # noqa: E402
from gates.d1_numeric import check_numeric_claim, verify_d1_document  # noqa: E402
from gates.d2_citation import DictCitationResolver, check_citation, verify_d2_citations  # noqa: E402
from gates.d3_claim_anchor import check_claim_against_anchors, verify_d3_document  # noqa: E402
from gates.models import GateFinding, GateVerdict, normalize_verdict  # noqa: E402
from submissions import validate_submission  # noqa: E402


def _sample_fact_card() -> dict:
    return json.loads((ROOT / "corpus" / "examples" / "sample_fact_card.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ Models
def test_gate_models_and_score_mapping():
    v = GateVerdict(
        case_id="c1",
        defect_type="D1",
        verdict="아님",
        confidence=0.95,
        evidence={"claimed": 18.4, "table": 12.4},
        reason="Percentage mismatch",
        location="L18",
        paper_id="PMC9000001",
    )
    assert isinstance(v, GateFinding)
    assert v.is_defect is True
    assert v.to_score_label(defect_perspective=True) == "맞음"
    assert v.to_score_label(defect_perspective=False) == "아님"
    row = v.to_score_row()
    assert list(row.keys()) == score.REQUIRED_COLUMNS
    assert row["label"] == "맞음"
    assert normalize_verdict("correct") == "맞음"
    assert normalize_verdict("defect") == "아님"
    assert normalize_verdict("needs_review") == "확인필요"
    with pytest.raises(ValueError):
        GateFinding(case_id="c2", defect_type="D1", verdict="맞음", confidence=1.5)


# ------------------------------------------------------------------ D1 Numeric Gate
def test_d1_half_ulp_rounding_consistent():
    fc = _sample_fact_card()
    finding = check_numeric_claim(
        "In the intervention group, mean Fatigue Severity Score reduction was 12.4 ± 3.2 points.",
        fc,
        case_id="d1-round",
    )
    assert finding.verdict == "맞음"
    assert finding.is_defect is False


def test_d1_percentage_mismatch_is_defect():
    fc = _sample_fact_card()
    finding = check_numeric_claim(
        "Adherence rate in the intervention arm was 68.4%.",
        fc,
        case_id="d1-pct",
    )
    assert finding.verdict == "아님"
    assert finding.is_defect is True


def test_d1_swapped_ci_and_group_swap_detected():
    fc = _sample_fact_card()
    swapped_ci = check_numeric_claim(
        "Fatigue Severity Score reduction in intervention had 95% CI [-0.42, -1.85].",
        fc,
        case_id="d1-ci-swap",
    )
    assert swapped_ci.verdict == "아님"
    assert "reversed" in swapped_ci.reason.lower() or "swapped" in swapped_ci.reason.lower()

    group_swap = check_numeric_claim(
        "In the intervention group, mean Fatigue Severity Score reduction was 8.10 points.",
        fc,
        case_id="d1-group-swap",
    )
    assert group_swap.verdict == "아님"
    assert "Control" in group_swap.reason or "mismatch" in group_swap.reason.lower()


def test_d1_missing_metric_needs_review():
    fc = _sample_fact_card()
    finding = check_numeric_claim(
        "Serum cortisol concentration dropped by 15.2% at week 12.",
        fc,
        case_id="d1-missing",
    )
    assert finding.verdict == "확인필요"


def test_d1_markdown_table_extraction_and_p_value():
    md = (
        "## Results\n\n"
        "Primary symptom index improved by 4.5 points (p < 0.001).\n\n"
        "| Metric | Group | Value | p_value |\n"
        "|---|---|---|---|\n"
        "| Primary symptom index | Intervention | 4.5 | 0.0004 |\n"
    )
    findings = verify_d1_document(md, None, paper_id="SYNTH1")
    assert len(findings) >= 1
    assert all(f.verdict == "맞음" for f in findings)


# ------------------------------------------------------------------ D2 Citation Gate
def test_d2_exact_doi_author_year_tolerance():
    resolver = DictCitationResolver({
        "10.1371/journal.pone.0000099": {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Digital sleep interventions in primary care",
            "first_author": "Kim",
            "year": 2024,  # +1 year epub vs print tolerance
        }
    })
    cit = {
        "ref_id": "1",
        "doi": "https://doi.org/10.1371/journal.pone.0000099",
        "title": "Digital sleep interventions in primary care",
        "first_author": "Kim S",
        "year": 2023,
    }
    finding = check_citation(cit, resolver=resolver, case_id="d2-ok")
    assert finding.verdict == "맞음"


def test_d2_nonexistent_doi_and_fabricated_metadata():
    resolver = DictCitationResolver({
        "10.1371/journal.pone.0000099": {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Digital sleep interventions in primary care",
            "first_author": "Kim",
            "year": 2023,
        },
        "10.9999/fake.doi.404": None,
    })
    f404 = check_citation({"doi": "10.9999/fake.doi.404", "title": "Any"}, resolver=resolver, case_id="d2-404")
    assert f404.verdict == "아님"

    fab_title = check_citation(
        {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Completely fabricated randomized miracle cure trial",
            "first_author": "Kim",
            "year": 2023,
        },
        resolver=resolver,
        case_id="d2-title",
    )
    assert fab_title.verdict == "아님"

    bad_year = check_citation(
        {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Digital sleep interventions in primary care",
            "first_author": "Kim",
            "year": 2015,
        },
        resolver=resolver,
        case_id="d2-year",
    )
    assert bad_year.verdict == "아님"


def test_d2_missing_doi_ambiguous_or_unavailable():
    unavailable_resolver = DictCitationResolver({}, unavailable=True)
    f_unavail = check_citation(
        {"doi": "10.1371/journal.pone.0000099", "title": "Digital sleep interventions in primary care"},
        resolver=unavailable_resolver,
        case_id="d2-unavail",
    )
    assert f_unavail.verdict == "확인필요"

    ambig_resolver = DictCitationResolver(records=[
        {"title": "Sleep coaching trial", "first_author": "Lee", "year": 2022},
        {"title": "Sleep coaching trial", "first_author": "Lee", "year": 2023},
    ])
    f_ambig = check_citation(
        {"title": "Sleep coaching trial", "first_author": "Lee"},
        resolver=ambig_resolver,
        case_id="d2-ambig",
    )
    assert f_ambig.verdict == "확인필요"

    doc = "## References\n\n[1] Kim S. Digital sleep interventions in primary care. 2023. doi:10.1371/journal.pone.0000099\n"
    res_ok = DictCitationResolver({
        "10.1371/journal.pone.0000099": {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Digital sleep interventions in primary care",
            "first_author": "Kim",
            "year": 2023,
        }
    })
    doc_findings = verify_d2_citations(doc, resolver=res_ok, paper_id="PMC9000001")
    assert len(doc_findings) == 1
    assert doc_findings[0].verdict == "맞음"


# ------------------------------------------------------------------ D3 Claim Anchor Gate
def test_d3_supported_and_contradicted_claims():
    fc = _sample_fact_card()
    ok = check_claim_against_anchors(
        "The intervention significantly reduced Fatigue Severity Score at 12 weeks.",
        fc,
        case_id="d3-ok",
    )
    assert ok.verdict == "맞음"

    null_inflated = check_claim_against_anchors(
        "The app significantly improved secondary sleep latency at 12 weeks.",
        fc,
        case_id="d3-null-inflate",
    )
    assert null_inflated.verdict == "아님"

    reversed_dir = check_claim_against_anchors(
        "The intervention significantly increased Fatigue Severity Score at 12 weeks.",
        fc,
        case_id="d3-reverse",
    )
    assert reversed_dir.verdict == "아님"


def test_d3_subgroup_overgeneralization_and_causal_overclaim():
    fc = {
        "paper_id": "PMC9000002",
        "claim_anchors": [
            {
                "anchor_id": "A_SUB",
                "primary_endpoint": "systolic blood pressure reduction",
                "is_primary": True,
                "design": "rct",
                "subgroup_condition": "patients aged >= 65 with baseline hypertension",
                "effect_direction": "decrease",
                "p_value": 0.01,
                "ci": [-8.2, -1.4],
                "null_value": 0.0,
                "keywords": ["systolic", "blood", "pressure"],
            },
            {
                "anchor_id": "A_OBS",
                "primary_endpoint": "hospital readmission risk",
                "is_primary": False,
                "design": "cohort",
                "subgroup_condition": None,
                "effect_direction": "decrease",
                "p_value": 0.02,
                "ci": [0.71, 0.96],
                "null_value": 1.0,
                "keywords": ["hospital", "readmission", "risk"],
            },
        ],
    }
    overgen = check_claim_against_anchors(
        "The intervention significantly lowered systolic blood pressure across all adults.",
        fc,
        case_id="d3-sub-drop",
    )
    assert overgen.verdict == "아님"

    scoped = check_claim_against_anchors(
        "Among patients aged >= 65 with baseline hypertension, the intervention significantly lowered systolic blood pressure.",
        fc,
        case_id="d3-sub-kept",
    )
    assert scoped.verdict == "맞음"

    causal = check_claim_against_anchors(
        "Telehealth follow-up directly caused lower hospital readmission risk.",
        fc,
        case_id="d3-causal",
    )
    assert causal.verdict == "아님"


def test_d3_unanchored_and_llm_judge_hook():
    fc = _sample_fact_card()
    unanchored = check_claim_against_anchors(
        "Mitochondrial respiration normalized after therapy.",
        fc,
        case_id="d3-unanchored",
    )
    assert unanchored.verdict == "확인필요"

    def fake_judge(claim: str, anchors: list[dict]) -> dict:
        return {"verdict": "맞음", "confidence": 0.88, "reason": "Judge verified against external anchor"}

    judged = check_claim_against_anchors(
        "Mitochondrial respiration normalized after therapy.",
        fc,
        case_id="d3-judge",
        llm_judge=fake_judge,
    )
    assert judged.verdict == "맞음"
    assert judged.confidence == 0.88

    doc = "## Discussion\n\nThe app significantly improved secondary sleep latency at 12 weeks.\n"
    doc_findings = verify_d3_document(doc, fc, paper_id="PMC9000001")
    assert len(doc_findings) == 1
    assert doc_findings[0].verdict == "아님"


# ------------------------------------------------------------------ Corpus & Submission Validators
def test_corpus_validator_valid_and_license_failures(tmp_path: pathlib.Path):
    assert validate_corpus.main([str(ROOT / "corpus" / "examples")]) == 0

    bad = _sample_fact_card()
    bad["license"] = "CC BY-NC"
    bad_file = tmp_path / "bad_license.json"
    bad_file.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    assert validate_corpus.main([str(bad_file)]) != 0

    malformed = _sample_fact_card()
    malformed["pmcid"] = "NOT_A_PMCID"
    mal_file = tmp_path / "bad_pmcid.json"
    mal_file.write_text(json.dumps(malformed, ensure_ascii=False), encoding="utf-8")
    assert validate_corpus.main([str(mal_file)]) != 0


def test_submission_validator_rules(tmp_path: pathlib.Path):
    assert validate_submission.main([str(ROOT / "submissions" / "examples")]) == 0

    custom_no_det = {
        "paper_id": "PMC9000001",
        "team": "red-x",
        "defect_type": "D9_CUSTOM",
        "location": "L10",
        "patch": "--- a\n+++ b\n",
        "target_quote": "Custom quote",
        "intended_label": "아님",
    }
    p_no_det = tmp_path / "custom_no_det.json"
    p_no_det.write_text(json.dumps(custom_no_det), encoding="utf-8")
    assert validate_submission.main([str(p_no_det)]) != 0

    custom_with_det = dict(custom_no_det, detector_spec="Regex checks figure caption mismatch")
    p_with_det = tmp_path / "custom_with_det.json"
    p_with_det.write_text(json.dumps(custom_with_det), encoding="utf-8")
    assert validate_submission.main([str(p_with_det)]) == 0

    leaked = dict(custom_with_det, blind_input='Text with "intended_label": "아님" leaked')
    p_leak = tmp_path / "leaked.json"
    p_leak.write_text(json.dumps(leaked), encoding="utf-8")
    assert validate_submission.main([str(p_leak)]) != 0

    dup_csv = tmp_path / "dup.csv"
    with dup_csv.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["case_id", *score.REQUIRED_COLUMNS])
        w.writerow(["c1", "P1", "blue", "rule", "v1", "1", "L10", "D1", "맞음", "ev", "0.1", "0", "false"])
        w.writerow(["c1", "P1", "blue", "rule", "v1", "1", "L11", "D1", "맞음", "ev", "0.1", "0", "false"])
    assert validate_submission.main([str(dup_csv)]) != 0


# ------------------------------------------------------------------ CLI & Eval Pipeline
def test_gates_cli_and_eval_pipeline_with_score_py(tmp_path: pathlib.Path):
    fc_path = ROOT / "corpus" / "examples" / "sample_fact_card.json"
    cit_idx = {
        "10.1371/journal.pone.0000099": {
            "doi": "10.1371/journal.pone.0000099",
            "title": "Digital sleep interventions in primary care",
            "first_author": "Kim",
            "year": 2023,
        }
    }
    cit_idx_path = tmp_path / "citations.json"
    cit_idx_path.write_text(json.dumps(cit_idx), encoding="utf-8")

    doc_path = tmp_path / "tampered.md"
    doc_path.write_text(
        "# Trial\n\n"
        "## Results\n"
        "Adherence rate in the intervention arm was 68.4%.\n\n"
        "## Discussion\n"
        "The app significantly improved secondary sleep latency at 12 weeks.\n\n"
        "## References\n"
        "[1] Kim S. Digital sleep interventions in primary care. 2023. doi:10.1371/journal.pone.0000099\n",
        encoding="utf-8",
    )

    out_csv = tmp_path / "results" / "w1" / "blue-gates.csv"
    out_json = tmp_path / "report.json"
    rc = gates_cli.main([
        "--fact-card", str(fc_path),
        "--document", str(doc_path),
        "--output", str(out_csv),
        "--json-out", str(out_json),
        "--citation-index", str(cit_idx_path),
    ])
    assert rc == 0
    assert validate_submission.validate_blue_csv(out_csv) == 3

    rows = score.load_blue_rows(out_csv.parent)
    keys = [{"paper_id": "PMC9000001", "location": "L4"}, {"paper_id": "PMC9000001", "location": "L7"}]
    scored = score.score_rows(rows, keys, {"PMC9000001": {"role": "team", "level": "L1"}})
    assert scored["overall"]["true_positives"] == 2
    assert scored["overall"]["recall"] == 1.0

    # Manifest evaluation with answer key + summary outputs
    manifest = {
        "cases": [
            {
                "case_id": "case-d1",
                "paper_id": "PMC9000001",
                "document_path": str(doc_path),
                "fact_card_path": str(fc_path),
                "defect_type": "D1",
                "citation_index_path": str(cit_idx_path),
            },
            {
                "case_id": "case-d2",
                "paper_id": "PMC9000001",
                "document_path": str(doc_path),
                "fact_card_path": str(fc_path),
                "defect_type": "D2",
                "citation_index_path": str(cit_idx_path),
            },
            {
                "case_id": "case-d3",
                "paper_id": "PMC9000001",
                "document_path": str(doc_path),
                "fact_card_path": str(fc_path),
                "defect_type": "D3",
                "citation_index_path": str(cit_idx_path),
            },
        ]
    }
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    answer_key = tmp_path / "answer_key.csv"
    answer_key.write_text(
        "case_id,defect_type,label\ncase-d1,D1,아님\ncase-d2,D2,맞음\ncase-d3,D3,아님\n",
        encoding="utf-8",
    )

    keys_dir = tmp_path / "keys"
    keys_dir.mkdir()
    (keys_dir / "PMC9000001.json").write_text(json.dumps(keys), encoding="utf-8")

    eval_csv = tmp_path / "eval_out" / "preds.csv"
    sum_json = tmp_path / "eval_summary.json"
    sum_md = tmp_path / "eval_summary.md"
    rc_eval = run_eval.main([
        "--input", str(manifest_path),
        "--output-csv", str(eval_csv),
        "--answer-key", str(answer_key),
        "--keys-dir", str(keys_dir),
        "--summary-json", str(sum_json),
        "--summary-md", str(sum_md),
    ])
    assert rc_eval == 0
    summary = json.loads(sum_json.read_text(encoding="utf-8"))
    assert summary["classification"]["overall"]["accuracy"] == 1.0
    assert summary["classification"]["overall"]["macro_f1"] == 1.0
    assert summary["score"]["overall"]["recall"] == 1.0
    assert "| Overall |" in sum_md.read_text(encoding="utf-8")

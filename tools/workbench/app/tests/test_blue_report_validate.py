"""Unittest suite for app/local/blue_report_validate.py (BLUE report gate + Zero-Drop)."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import blue_report_validate as mod  # noqa: E402

PAGE_ONE = (
    "Table 1. Cohort Metrics (N = 200).",
    "Results: AUC = 0.94 across N = 200 patients.",
)
PAGE_TWO = ("Discussion: Secondary endpoint remained stable.",)
EXACT_QUOTE = PAGE_ONE[1]
NORMALIZED_QUOTE = "results: auc = 0.94 ACROSS n = 200 PATIENTS."
MISSING_QUOTE = "Fabricated claim that never appears anywhere in this paper."
PAGE_TWO_QUOTE = PAGE_TWO[0]
UNRELATED_LEDGER_QUOTE = "unrelated ledger candidate about enrollment plumbing"


def _build_pdf() -> bytes:
    doc = pymupdf.open()
    for lines in (PAGE_ONE, PAGE_TWO):
        page = doc.new_page(width=595, height=842)
        for offset, line in enumerate(lines):
            page.insert_text((72, 74 + offset * 30), line, fontsize=10.5)
    raw = doc.tobytes()
    doc.close()
    return raw


def _report(findings, **extra) -> dict:
    return {
        "schema": "falsify.blue-report.v1",
        "paperId": "pid-test",
        "findings": list(findings),
        **extra,
    }


class QuoteGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _build_pdf()

    def test_exact_normalized_and_missing_quote_statuses(self):
        out = mod.validate_blue_report(self.pdf, _report([
            {"id": "f1", "verdictLabel": "아님", "pageIndex": 0, "quote": EXACT_QUOTE},
            {"id": "f2", "verdictLabel": "아님", "pageIndex": 0, "quote": NORMALIZED_QUOTE},
            {"id": "f3", "verdictLabel": "아님", "pageIndex": 0, "quote": MISSING_QUOTE},
        ]))
        self.assertEqual(out["schema"], mod.SCHEMA)
        self.assertFalse(out["ok"])
        checks = out["quoteCheck"]
        self.assertEqual(checks["findingCount"], 3)
        self.assertEqual(checks["checkedCount"], 3)
        self.assertEqual(checks["unquotedCount"], 0)
        self.assertEqual(
            (checks["exactCount"], checks["normalizedCount"], checks["missingCount"]), (1, 1, 1)
        )
        by_id = {quote["findingId"]: quote for quote in checks["quotes"]}
        self.assertEqual(by_id["f1"]["status"], "exact")
        self.assertEqual(by_id["f1"]["pageIndex"], 0)
        self.assertEqual(len(by_id["f1"]["bbox"]), 4)
        self.assertEqual(by_id["f1"]["nearestCandidates"], [])
        self.assertEqual(by_id["f2"]["status"], "normalized")
        self.assertEqual(by_id["f2"]["pageIndex"], 0)
        missing = by_id["f3"]
        self.assertEqual(
            set(missing),
            {"findingId", "quote", "status", "pageIndex", "bbox", "nearestCandidates", "recoveryHint"},
        )
        self.assertEqual(missing["status"], "missing")
        self.assertIsNone(missing["pageIndex"])
        self.assertIsNone(missing["bbox"])
        self.assertIn("verbatim", missing["recoveryHint"])
        self.assertGreaterEqual(len(missing["nearestCandidates"]), 1)
        for candidate in missing["nearestCandidates"]:
            self.assertEqual(set(candidate), {"pageIndex", "bbox", "text"})

    def test_page_scoped_quote_is_only_searched_on_its_declared_page(self):
        scoped = mod.validate_blue_report(self.pdf, _report([
            {"id": "a1", "quote": PAGE_TWO_QUOTE, "pageIndex": 0},
        ]))
        self.assertEqual(scoped["quoteCheck"]["missingCount"], 1)
        correct = mod.validate_blue_report(self.pdf, _report([
            {"id": "a2", "quote": PAGE_TWO_QUOTE, "pageIndex": 1},
        ]))
        self.assertEqual(correct["quoteCheck"]["exactCount"], 1)
        self.assertEqual(correct["quoteCheck"]["quotes"][0]["pageIndex"], 1)

    def test_one_based_page_field_and_unscoped_search(self):
        by_page = mod.validate_blue_report(self.pdf, _report([
            {"id": "b1", "quote": PAGE_TWO_QUOTE, "page": 2},
        ]))
        self.assertEqual(by_page["quoteCheck"]["exactCount"], 1)
        self.assertEqual(by_page["quoteCheck"]["quotes"][0]["pageIndex"], 1)
        unscoped = mod.validate_blue_report(self.pdf, _report([
            {"id": "b2", "quote": PAGE_TWO_QUOTE},
        ]))
        self.assertEqual(unscoped["quoteCheck"]["exactCount"], 1)

    def test_quote_spanning_two_lines_exact_with_union_bbox(self):
        spanning = " ".join(PAGE_ONE)
        out = mod.validate_blue_report(self.pdf, _report([
            {"id": "c1", "quote": spanning, "pageIndex": 0},
        ]))
        record = out["quoteCheck"]["quotes"][0]
        self.assertEqual(record["status"], "exact")
        self.assertGreater(record["bbox"][3] - record["bbox"][1], 20.0)

    def test_findings_without_quotes_are_counted_separately(self):
        out = mod.validate_blue_report(self.pdf, _report([
            {"id": "d1", "verdictLabel": "확인필요"},
        ]))
        checks = out["quoteCheck"]
        self.assertEqual(checks["checkedCount"], 0)
        self.assertEqual(checks["unquotedCount"], 1)
        self.assertTrue(out["ok"])

    def test_max_candidates_bounds_nearest_candidates(self):
        out = mod.validate_blue_report(
            self.pdf, _report([{"id": "e1", "quote": MISSING_QUOTE}]), max_candidates=1
        )
        self.assertEqual(len(out["quoteCheck"]["quotes"][0]["nearestCandidates"]), 1)


class ZeroDropTests(unittest.TestCase):
    """Fixtures mirror app/tests/blue-defect-sensor.spec.cjs (web-app parity)."""

    LEDGER = [
        {"candidateId": "C-1", "page": 3, "locationLabel": "Table 1", "defectFamily": "D1",
         "quote": "10/40 (35.0%) reported in arm A", "suspicion": "percentage mismatch"},
        {"candidateId": "C-2", "page": 7, "locationLabel": "References [30]", "defectFamily": "D2",
         "quote": "[30] Missing or mismatched reference entry", "suspicion": "ref 30 mismatch"},
        {"candidateId": "C-3", "page": 4, "locationLabel": "Results", "defectFamily": "D1",
         "quote": "Bonferroni-adjusted p = 0.015 reported", "suspicion": "statcheck check"},
        {"candidateId": "C-4", "page": 5, "locationLabel": "Discussion", "defectFamily": "D3",
         "quote": "Subgroup effect claimed overall", "suspicion": "scope overclaim"},
    ]
    FINDINGS = [
        {"reportNumber": "F-1", "candidateId": "C-1", "page": 3, "locationLabel": "Table 1",
         "findingType": "D1", "verdictLabel": "아님", "severity": "불일치",
         "quote": "10/40 (35.0%) reported in arm A", "rationale": "10/40=25% not 35%"},
        {"reportNumber": "F-2", "page": 4, "locationLabel": "Results", "findingType": "D1",
         "verdictLabel": "맞음", "quote": "Bonferroni-adjusted p = 0.015 reported",
         "rationale": "Multiplicity adjustment explicitly stated"},
        {"reportNumber": "F-3", "candidateId": "C-4", "page": 5, "locationLabel": "Discussion",
         "findingType": "D3", "verdictLabel": "맞음",
         "quote": "Subgroup effect claimed overall", "rationale": ""},
    ]

    def test_js_fixture_summary_and_recovered_order(self):
        reconciled = mod.reconcile_candidate_ledger(self.LEDGER, self.FINDINGS)
        self.assertEqual(
            reconciled["summary"],
            {"stage1Count": 4, "resolvedOkCount": 1, "reportedDefectCount": 1, "recoveredCount": 2},
        )
        self.assertEqual(
            [item.get("reportNumber") for item in reconciled["findings"]], ["F-1", "C-2", "C-4"]
        )
        self.assertEqual([item.get("reportNumber") for item in reconciled["resolvedOk"]], ["F-2"])
        recovered = [item for item in reconciled["findings"] if item.get("zeroDropRecovered")]
        self.assertEqual(len(recovered), 2)
        self.assertEqual(recovered[0]["verdictLabel"], "확인필요")
        self.assertEqual(recovered[0]["severity"], "불일치")
        self.assertEqual(recovered[0]["confidence"], "확인필요 (Zero-Drop 복원)")
        self.assertTrue(recovered[0]["rationale"].startswith("[Zero-Drop 자동 복원]"))

    def test_invalid_resolution_without_basis_is_re_reported(self):
        reconciled = mod.reconcile_candidate_ledger([], [{
            "reportNumber": "R-1", "verdictLabel": "맞음", "quote": "no basis here",
            "rationale": "   ",
        }])
        self.assertEqual(
            reconciled["summary"],
            {"stage1Count": 0, "resolvedOkCount": 0, "reportedDefectCount": 0, "recoveredCount": 1},
        )
        item = reconciled["findings"][0]
        self.assertEqual(item["verdictLabel"], "확인필요")
        self.assertTrue(item["zeroDropRecovered"])
        self.assertIn("해소 근거", item["rationale"])

    def test_resolution_with_rationale_stays_resolved(self):
        reconciled = mod.reconcile_candidate_ledger([], [{
            "reportNumber": "R-2", "verdictLabel": "맞음", "quote": "supported claim",
            "rationale": "Cross-checked against Table 2.",
        }])
        self.assertEqual(reconciled["summary"]["resolvedOkCount"], 1)
        self.assertEqual(reconciled["summary"]["recoveredCount"], 0)
        self.assertEqual(reconciled["findings"], [])

    def test_verdict_label_aliases(self):
        self.assertEqual(mod.normalize_verdict_label("SUPPORTED"), "맞음")
        self.assertEqual(mod.normalize_verdict_label(" supported-in-source "), "맞음")
        self.assertEqual(mod.normalize_verdict_label("defect"), "아님")
        self.assertEqual(mod.normalize_verdict_label("unsupported"), "아님")
        self.assertEqual(mod.normalize_verdict_label("needs_check"), "확인필요")
        self.assertEqual(mod.normalize_verdict_label("needs-verification"), "확인필요")
        self.assertEqual(mod.normalize_verdict_label("확인필요"), "확인필요")
        self.assertEqual(mod.normalize_verdict_label("banana"), "")

    def test_quote_overlap_requires_twelve_characters(self):
        self.assertFalse(mod.quote_overlaps12("short text", "short text extended"))
        self.assertTrue(mod.quote_overlaps12(
            "Bonferroni-adjusted p = 0.015", "the Bonferroni-adjusted p = 0.015 reported value"
        ))
        self.assertFalse(mod.quote_overlaps12("alpha beta gamma", "delta epsilon zeta"))


class ValidateIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _build_pdf()

    def test_unmatched_ledger_entry_is_restored_and_surfaces_missing_quote(self):
        out = mod.validate_blue_report(self.pdf, _report(
            [{"id": "f1", "verdictLabel": "아님", "pageIndex": 0, "quote": EXACT_QUOTE}],
            candidateLedger=[{"candidateId": "C-2", "page": 1, "locationLabel": "Results",
                              "defectFamily": "D2", "quote": UNRELATED_LEDGER_QUOTE}],
        ))
        self.assertEqual(out["zeroDrop"]["summary"]["stage1Count"], 1)
        self.assertEqual(out["zeroDrop"]["summary"]["recoveredCount"], 1)
        self.assertEqual(out["zeroDrop"]["recoveredFindingIds"], ["C-2"])
        self.assertEqual(out["quoteCheck"]["findingCount"], 2)
        self.assertEqual(out["quoteCheck"]["missingCount"], 1)
        self.assertFalse(out["ok"])
        missing = [item for item in out["quoteCheck"]["quotes"] if item["status"] == "missing"]
        self.assertEqual(missing[0]["findingId"], "C-2")

    def test_explicit_ledger_overrides_report_ledger(self):
        report = _report(
            [{"id": "f1", "verdictLabel": "아님", "quote": EXACT_QUOTE}],
            candidateLedger=[{"candidateId": "C-2", "quote": UNRELATED_LEDGER_QUOTE}],
        )
        from_report = mod.validate_blue_report(self.pdf, report)
        self.assertEqual(from_report["zeroDrop"]["summary"]["stage1Count"], 1)
        from_flag = mod.validate_blue_report(self.pdf, report, ledger=[])
        self.assertEqual(from_flag["zeroDrop"]["summary"]["stage1Count"], 0)
        self.assertEqual(from_flag["zeroDrop"]["summary"]["recoveredCount"], 0)
        self.assertIn("Explicit candidateLedger replaced report.candidateLedger.",
                      from_flag["warnings"])

    def test_empty_report_is_valid_and_reports_hashes(self):
        out = mod.validate_blue_report(
            self.pdf, {"findings": []}, paper_id="pid-cli", file_hash="a" * 64
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["paperId"], "pid-cli")
        self.assertEqual(out["fileHash"], "a" * 64)
        self.assertIsNone(out["csv"])
        self.assertEqual(out["quoteCheck"]["missingCount"], 0)
        self.assertEqual(
            out["zeroDrop"]["summary"],
            {"stage1Count": 0, "resolvedOkCount": 0, "reportedDefectCount": 0, "recoveredCount": 0},
        )

    def test_csv_is_written_only_when_requested(self):
        report = _report([{"id": "f1", "verdictLabel": "아님", "family": "D1", "quote": EXACT_QUOTE}])
        self.assertIsNone(mod.validate_blue_report(self.pdf, report)["csv"])
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "rows.csv"
            out = mod.validate_blue_report(self.pdf, report, csv_path=str(target))
            self.assertTrue(target.is_file())
            self.assertEqual(out["csv"]["rowCount"], 1)
            self.assertEqual(out["csv"]["columns"], list(mod.CSV_COLUMNS))


class ReportShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _build_pdf()

    def test_unknown_verdict_label_is_invalid(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report([{"id": "f1", "verdictLabel": "banana"}]))
        self.assertEqual(ctx.exception.code, "invalid_blue_report")
        self.assertEqual(ctx.exception.exit_code, 2)
        self.assertIn("아님", ctx.exception.recovery_hint)

    def test_non_object_finding_is_invalid(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report(["not-an-object"]))
        self.assertEqual(ctx.exception.code, "invalid_blue_report")
        self.assertIn("#1", ctx.exception.message)

    def test_report_that_is_not_object_or_array_is_invalid(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, "not-a-report")
        self.assertEqual(ctx.exception.code, "invalid_blue_report")

    def test_report_findings_must_be_a_list(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, {"findings": {"id": "f1"}})
        self.assertEqual(ctx.exception.code, "invalid_blue_report")
        self.assertIn("findings", ctx.exception.message)

    def test_more_than_5000_findings_is_invalid(self):
        findings = [{"id": f"f{index}", "quote": "x"} for index in range(mod.MAX_FINDINGS + 1)]
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report(findings))
        self.assertEqual(ctx.exception.code, "invalid_blue_report")
        self.assertEqual(ctx.exception.exit_code, 2)
        self.assertIn("5001", ctx.exception.message)

    def test_forbidden_red_key_exits_three(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report([], gold={"D1": 1}))
        self.assertEqual(ctx.exception.code, "forbidden_red_key")
        self.assertEqual(ctx.exception.exit_code, 3)
        self.assertTrue(ctx.exception.recovery_hint)
        self.assertIn("gold", ctx.exception.extra["leaks"][0])

    def test_forbidden_key_inside_ledger_exits_three(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report([]), ledger=[{"candidateId": "C", "plan": "x"}])
        self.assertEqual(ctx.exception.code, "forbidden_red_key")

    def test_malformed_ledger_shape_is_invalid(self):
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report([]), ledger="not-a-ledger")
        self.assertEqual(ctx.exception.code, "invalid_candidate_ledger")


class CsvNormalizationTests(unittest.TestCase):
    def test_header_matches_the_twelve_column_contract(self):
        self.assertEqual(list(mod.CSV_COLUMNS), [
            "paper_id", "team", "judge_type", "model", "iteration",
            "location", "defect_type", "label", "evidence", "time_sec", "tokens", "is_holdout",
        ])
        built = mod.build_csv_rows([{
            "id": "f1", "verdictLabel": "아님", "family": "D1", "quote": EXACT_QUOTE, "pageIndex": 0,
        }], "pid-test")
        rendered = mod.render_csv(built["rows"])
        self.assertEqual(rendered["text"].split("\r\n")[0], ",".join(mod.CSV_COLUMNS))
        self.assertEqual(built["warnings"], [])
        rows = list(csv.DictReader(io.StringIO(rendered["text"])))
        self.assertEqual(rows[0]["label"], "아님")
        self.assertEqual(rows[0]["defect_type"], "D1")
        self.assertEqual(rows[0]["location"], "p.1")
        self.assertEqual(rows[0]["is_holdout"], "false")

    def test_label_mapping_and_zero_drop_rows(self):
        built = mod.build_csv_rows([
            {"id": "a", "verdictLabel": "defect", "family": "D1"},
            {"id": "b", "verdictLabel": "supported", "family": "S1"},
            {"id": "c", "verdictLabel": "needs_check", "family": "D2"},
            {"id": "d", "zeroDropRecovered": True, "family": "D3"},
        ], "pid-test")
        self.assertEqual([row["label"] for row in built["rows"]],
                         ["아님", "맞음", "확인필요", "확인필요"])

    def test_formula_neutralization_and_rfc4180_quoting(self):
        built = mod.build_csv_rows([
            {"id": "a", "verdictLabel": "defect", "family": "D1", "quote": "=SUM(A1:A2)"},
            {"id": "b", "verdictLabel": "defect", "family": "D1", "quote": "-1 spurious sign"},
            {"id": "c", "verdictLabel": "defect", "family": "D1", "quote": "+1 gained value"},
            {"id": "d", "verdictLabel": "defect", "family": "D1", "quote": "@handle mention"},
            {"id": "e", "verdictLabel": "defect", "family": "D1", "quote": 'quoted, "comma" text'},
        ], "pid-test")
        rendered = mod.render_csv(built["rows"])
        self.assertEqual(rendered["neutralizedCells"], 4)
        parsed = list(csv.reader(io.StringIO(rendered["text"])))
        self.assertEqual(len(parsed[1]), 12)
        self.assertEqual(parsed[1][8], "'=SUM(A1:A2)")
        self.assertEqual(parsed[2][8], "'-1 spurious sign")
        self.assertEqual(parsed[3][8], "'+1 gained value")
        self.assertEqual(parsed[4][8], "'@handle mention")
        self.assertEqual(parsed[5][8], 'quoted, "comma" text')

    def test_evidence_cell_joins_multiline_without_duplicates(self):
        built = mod.build_csv_rows([{
            "id": "a", "verdictLabel": "아님", "family": "D1",
            "quote": EXACT_QUOTE, "resolutionQuote": EXACT_QUOTE, "rationale": "arithmetic diff",
        }], "pid-test")
        self.assertEqual(built["rows"][0]["evidence"], f"{EXACT_QUOTE}\narithmetic diff")

    def test_defect_type_whitelist_and_fallback_warnings(self):
        whitelisted = mod.build_csv_rows([{"id": "a", "family": "d4-1"}], "pid-test")
        self.assertEqual(whitelisted["rows"][0]["defect_type"], "D4-1")
        dotted = mod.build_csv_rows([{"id": "b", "family": "D4.1"}], "pid-test")
        self.assertEqual(dotted["rows"][0]["defect_type"], "D4-1")
        absent = mod.build_csv_rows([{"id": "c", "verdictLabel": "needs_check"}], "pid-test")
        self.assertEqual(absent["rows"][0]["defect_type"], "D3")
        self.assertTrue(any("missing defect family" in item for item in absent["warnings"]))
        unmapped = mod.build_csv_rows([{"id": "d", "family": "D9"}], "pid-test")
        self.assertEqual(unmapped["rows"][0]["defect_type"], "D3")
        self.assertTrue(any("unmapped defect family" in item for item in unmapped["warnings"]))

    def test_write_csv_is_utf8_without_bom_and_crlf(self):
        built = mod.build_csv_rows([{
            "id": "a", "verdictLabel": "아님", "family": "D1", "quote": EXACT_QUOTE,
        }], "pid-test")
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "rows.csv"
            result = mod.write_csv(str(target), built["rows"])
            raw = target.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b"\r\n", raw)
        self.assertIn("아님".encode("utf-8"), raw)
        self.assertEqual(result["rowCount"], 1)
        self.assertEqual(result["columns"], list(mod.CSV_COLUMNS))


if __name__ == "__main__":
    unittest.main()

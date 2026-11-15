"""Regression tests for Layer 0 deep statistical & clinical forensics (SPRITE, 2x2, KM No. at risk)."""
import hashlib
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_evidence as pe
import paper_stat_audit as audit
import paper_stat_math as sm

sha = lambda data: hashlib.sha256(data).hexdigest()


class SpriteTests(unittest.TestCase):
    def test_sprite_impossible_high_sd_on_likert_1_to_7(self):
        res = sm.check_sprite(4.00, 3.50, 10, 1, 7)
        self.assertFalse(res["consistent"])
        self.assertEqual(res["reason"], "sd_above_max")
        self.assertLess(res["sdBounds"][1], 3.20)

    def test_sprite_impossible_low_sd_and_grim_and_oob_mean(self):
        low = sm.check_sprite(4.50, 0.20, 10, 1, 7)
        self.assertFalse(low["consistent"])
        self.assertEqual(low["reason"], "sd_below_min")

        oob = sm.check_sprite(7.50, 1.00, 10, 1, 7)
        self.assertFalse(oob["consistent"])
        self.assertEqual(oob["reason"], "mean_out_of_bounds")

        grim = sm.check_sprite(3.45, 1.00, 10, 1, 7)
        self.assertFalse(grim["consistent"])
        self.assertEqual(grim["reason"], "grim_infeasible")

    def test_sprite_valid_integer_and_continuous_distributions(self):
        ok_int = sm.check_sprite(4.00, 2.00, 10, 1, 7)
        self.assertTrue(ok_int["consistent"])
        self.assertEqual(ok_int["reason"], "ok")

        ok_zero = sm.check_sprite(7.00, 0.00, 12, 1, 7)
        self.assertTrue(ok_zero["consistent"])

        ok_cont = sm.check_sprite(4.50, 0.15, 10, 1, 7, integer_scale=False)
        self.assertTrue(ok_cont["consistent"])

        bad_cont = sm.check_sprite(4.50, 4.00, 10, 1, 7, integer_scale=False)
        self.assertFalse(bad_cont["consistent"])
        self.assertEqual(bad_cont["reason"], "sd_above_max")


class TwoByTwoTests(unittest.TestCase):
    def test_two_by_two_detects_fabricated_or_and_p(self):
        res = sm.check_two_by_two(
            24, 100, 10, 100,
            reported_kind="OR", reported_est="5.80", est_decimals=2,
            reported_p="0.0001", p_op="=", p_decimals=4,
        )
        self.assertFalse(res["consistent"])
        self.assertFalse(res["estConsistent"])
        self.assertFalse(res["pConsistent"])
        self.assertEqual(set(res["issues"]), {"or_mismatch", "p_mismatch"})

    def test_two_by_two_accepts_valid_fisher_pearson_yates_and_rounding(self):
        exact = sm.check_two_by_two(24, 100, 10, 100)
        self.assertAlmostEqual(exact["or"], (24 * 90) / (76 * 10), delta=1e-9)
        self.assertAlmostEqual(exact["rr"], 2.40, delta=1e-9)

        ok_fisher = sm.check_two_by_two(
            24, 100, 10, 100,
            reported_kind="OR", reported_est="2.84", est_decimals=2,
            reported_p=f"{exact['fisherP']:.3f}", p_decimals=3,
        )
        self.assertTrue(ok_fisher["consistent"])

        ok_pearson = sm.check_two_by_two(
            24, 100, 10, 100,
            reported_kind="RR", reported_est="2.40", est_decimals=2,
            reported_p=f"{exact['pearsonP']:.3f}", p_decimals=3,
        )
        self.assertTrue(ok_pearson["consistent"])

        ok_inverse = sm.check_two_by_two(
            24, 100, 10, 100,
            reported_kind="OR", reported_est="0.35", est_decimals=2,
            reported_p="0.01", p_decimals=2,
        )
        self.assertTrue(ok_inverse["consistent"])

    def test_two_by_two_exempts_adjusted_aor_and_handles_zero_cell(self):
        adj = sm.check_two_by_two(
            24, 100, 10, 100,
            reported_kind="aOR", reported_est="1.85", est_decimals=2,
        )
        self.assertTrue(adj["consistent"])
        self.assertTrue(adj["adjustedExempt"])
        self.assertIsNone(adj["estConsistent"])

        zero_cell = sm.check_two_by_two(0, 20, 8, 20, reported_kind="OR", reported_est="0.04", est_decimals=2)
        self.assertTrue(zero_cell["consistent"])


class KmAtRiskTests(unittest.TestCase):
    def test_km_at_risk_flags_upward_jump_and_baseline_exceed(self):
        bad = sm.check_km_at_risk({"Drug A": [150, 132, 141, 98], "Placebo": [150, 120, 95, 70]})
        self.assertFalse(bad["consistent"])
        self.assertEqual(len(bad["violations"]), 1)
        self.assertEqual(bad["violations"][0]["arm"], "Drug A")
        self.assertEqual(bad["violations"][0]["kind"], "non_monotonic")
        self.assertEqual(bad["violations"][0]["prev"], 132)
        self.assertEqual(bad["violations"][0]["value"], 141)

        over = sm.check_km_at_risk({"Drug A": [150, 132, 110, 98]}, baseline_totals={"Drug A": 140})
        self.assertFalse(over["consistent"])
        self.assertEqual(over["violations"][0]["kind"], "exceeds_baseline")

    def test_km_at_risk_accepts_monotonic_and_skips_delayed_entry(self):
        good = sm.check_km_at_risk({"Drug A": [150, 132, 110, 98]})
        self.assertTrue(good["consistent"])
        self.assertEqual(good["violations"], [])

        skipped = sm.check_km_at_risk(
            {"Drug A": [100, 115, 90]},
            context_text="Kaplan-Meier curve with left-truncated delayed entry.",
        )
        self.assertTrue(skipped["consistent"])
        self.assertTrue(skipped["skipped"])


class AuditIntegrationTests(unittest.TestCase):
    def test_audit_paper_statistics_detects_deep_forensics_on_pdf_fixture(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "Results", fontsize=12)
        p0.insert_text((72, 95), "On the Likert 1-7 scale (n = 10), score was 4.00 +/- 3.50.", fontsize=10)
        p0.insert_text((72, 115), "Response was 24/100 (24.0%) vs 10/100 (10.0%), OR = 5.80, p = 0.0001.", fontsize=10)
        p0.insert_text((72, 135), "After multivariable adjustment, 24/100 vs 10/100 yielded aOR = 1.85, p = 0.12.", fontsize=10)
        p0.insert_text((72, 170), "Number at risk", fontsize=10)
        p0.insert_text((72, 186), "Drug A   150   132   141   98", fontsize=10)
        p0.insert_text((72, 202), "Placebo  150   120    95   70", fontsize=10)
        p0.insert_text((72, 218), "Months     0     6    12   18", fontsize=10)
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        res = audit.audit_paper_statistics(summary["paperId"], summary["fileHash"], store=store)
        kinds = [sig["kind"] for sig in res["signals"]]
        self.assertIn("sprite_bounds_mismatch", kinds)
        self.assertIn("two_by_two_mismatch", kinds)
        self.assertIn("km_at_risk_non_monotonic", kinds)
        self.assertEqual(kinds.count("two_by_two_mismatch"), 1)
        self.assertEqual(kinds.count("km_at_risk_non_monotonic"), 1)

    def test_audit_loaded_paper_structured_tables_and_demographics_guard(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842).insert_text((72, 70), "Table summary", fontsize=10)
        raw = doc.tobytes()
        doc.close()
        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))

        tables = [
            {
                "id": "tbl-1",
                "type": "table",
                "pageIndex": 0,
                "bbox": [50, 50, 500, 300],
                "caption": "Table 1. Baseline and outcomes",
                "table": {
                    "cells": [
                        {"row": 0, "column": 0, "text": "Variable", "header": True},
                        {"row": 0, "column": 1, "text": "Drug (N = 100)", "header": True},
                        {"row": 0, "column": 2, "text": "Control (N = 100)", "header": True},
                        {"row": 0, "column": 3, "text": "OR", "header": True},
                        {"row": 0, "column": 4, "text": "p-value", "header": True},
                        {"row": 1, "column": 0, "text": "Age, years"},
                        {"row": 1, "column": 1, "text": "54"},
                        {"row": 1, "column": 2, "text": "52"},
                        {"row": 1, "column": 3, "text": ""},
                        {"row": 1, "column": 4, "text": "0.30"},
                        {"row": 2, "column": 0, "text": "Responders n (%)"},
                        {"row": 2, "column": 1, "text": "24 (24.0%)"},
                        {"row": 2, "column": 2, "text": "10 (10.0%)"},
                        {"row": 2, "column": 3, "text": "5.80"},
                        {"row": 2, "column": 4, "text": "0.0001"},
                    ]
                },
            },
            {
                "id": "tbl-2",
                "type": "table",
                "pageIndex": 0,
                "bbox": [50, 320, 500, 480],
                "caption": "Number at risk",
                "table": {
                    "cells": [
                        {"row": 0, "column": 0, "text": "Arm", "header": True},
                        {"row": 0, "column": 1, "text": "0 mo", "header": True},
                        {"row": 0, "column": 2, "text": "6 mo", "header": True},
                        {"row": 0, "column": 3, "text": "12 mo", "header": True},
                        {"row": 1, "column": 0, "text": "Drug A"},
                        {"row": 1, "column": 1, "text": "150"},
                        {"row": 1, "column": 2, "text": "132"},
                        {"row": 1, "column": 3, "text": "141"},
                    ]
                },
            },
        ]
        loaded = audit.audit_loaded_paper(summary["paperId"], summary["fileHash"], summary, tables, store=store)
        kinds = [sig["kind"] for sig in loaded["signals"]]
        self.assertEqual(kinds.count("two_by_two_mismatch"), 1)
        self.assertEqual(kinds.count("km_at_risk_non_monotonic"), 1)
        self.assertFalse(any("Age" in sig["excerpt"] for sig in loaded["signals"]))


if __name__ == "__main__":
    unittest.main()

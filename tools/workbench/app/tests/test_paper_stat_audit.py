"""Tests for pure-Python statistical math core and paper-wide pre-audit scanner."""
import hashlib
import math
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_evidence as pe
import paper_stat_audit as audit
import paper_stat_math as sm

sha = lambda data: hashlib.sha256(data).hexdigest()


def _draw_grid(page, origin, col_widths, row_height, rows_data):
    x0, y0 = origin
    for r, row in enumerate(rows_data):
        cx = x0
        cy0 = y0 + r * row_height
        for c, text in enumerate(row):
            cw = col_widths[c]
            rect = pymupdf.Rect(cx, cy0, cx + cw, cy0 + row_height)
            page.draw_rect(rect, color=(0, 0, 0), width=0.8)
            if text:
                page.insert_textbox(
                    pymupdf.Rect(rect.x0 + 3, rect.y0 + 5, rect.x1 - 3, rect.y1 - 3),
                    text, fontsize=9.5, fontname="helv",
                )
            cx += cw


class StatMathCoreTests(unittest.TestCase):
    def test_gammaincc_and_betainc_high_precision(self):
        for x in (0.05, 0.5, 1.5, 5.0, 15.0):
            self.assertAlmostEqual(sm.gammaincc(1.0, x), math.exp(-x), delta=1e-12)
            self.assertAlmostEqual(sm.gammaincc(0.5, x), math.erfc(math.sqrt(x)), delta=1e-11)
        self.assertEqual(sm.gammaincc(2.5, 0.0), 1.0)
        self.assertEqual(sm.gammaincc(2.5, float("inf")), 0.0)

        for x in (0.05, 0.25, 0.5, 0.75, 0.95):
            exact_arc = (2.0 / math.pi) * math.asin(math.sqrt(x))
            self.assertAlmostEqual(sm.betainc(0.5, 0.5, x), exact_arc, delta=1e-11)
            self.assertAlmostEqual(sm.betainc(1.0, 4.0, x), 1.0 - (1.0 - x) ** 4, delta=1e-12)
            self.assertAlmostEqual(sm.betainc(3.5, 1.0, x), x ** 3.5, delta=1e-12)

    def test_exact_distribution_pvalues(self):
        self.assertAlmostEqual(sm.stat_pvalue("z", 1.959963984540054), 0.05, delta=1e-10)
        self.assertAlmostEqual(sm.stat_pvalue("t", 12.706204736432095, df1=1), 0.05, delta=1e-10)
        self.assertAlmostEqual(sm.stat_pvalue("t", 2.2281388519649385, df1=10), 0.05, delta=1e-10)
        self.assertAlmostEqual(sm.stat_pvalue("chi2", 3.841458820694124, df1=1), 0.05, delta=1e-10)
        self.assertAlmostEqual(sm.stat_pvalue("F", 3.492828476645873, df1=2, df2=20), 0.05, delta=1e-10)
        self.assertAlmostEqual(sm.stat_pvalue("t", 2.2281388519649385, df1=10, two_tailed=False), 0.025, delta=1e-10)

    def test_check_stat_pvalue_rounding_decision_and_one_tailed(self):
        ok = sm.check_stat_pvalue("t", "2.05", 28, None, "=", "0.050", 3)
        self.assertEqual(ok["status"], "consistent")

        inconsistent_same_side = sm.check_stat_pvalue("t", "3.00", 28, None, "=", "0.030", 3)
        self.assertEqual(inconsistent_same_side["status"], "inconsistent")

        decision_bad = sm.check_stat_pvalue("t", "1.10", 28, None, "<", "0.05", 2)
        self.assertEqual(decision_bad["status"], "decision_inconsistent")
        self.assertFalse(decision_bad["oneTailedCompatible"])

        one_tail = sm.check_stat_pvalue("t", "1.80", 28, None, "=", "0.041", 3)
        self.assertEqual(one_tail["status"], "decision_inconsistent")
        self.assertTrue(one_tail["oneTailedCompatible"])

    def test_check_count_percentage_and_grim_and_ci(self):
        self.assertTrue(sm.check_count_percentage(24, 120, 20.0, 1)["consistent"])
        self.assertTrue(sm.check_count_percentage(1, 3, 33.3, 1)["withinHalfUlp"])
        minor = sm.check_count_percentage(24, 120, 20.8, 1)
        self.assertFalse(minor["consistent"])
        self.assertTrue(minor["withinOnePctPoint"])
        self.assertTrue(minor["clearMismatch"])
        major = sm.check_count_percentage(24, 120, 25.0, 1)
        self.assertFalse(major["withinOnePctPoint"])

        self.assertFalse(sm.check_grim("3.45", 10)["consistent"])
        self.assertTrue(sm.check_grim("3.40", 10)["consistent"])
        self.assertTrue(sm.check_grim("3.45", 10, items=2)["consistent"])
        self.assertFalse(sm.check_grim("3.45", 120)["applicable"])

        self.assertEqual(sm.check_ci_bounds(1.5, 2.0, 1.0)["issues"], ["inverted_bounds"])
        self.assertEqual(sm.check_ci_bounds(2.5, 1.0, 2.0)["issues"], ["point_outside_ci"])
        self.assertEqual(sm.check_ci_bounds("2.00", "1.00", "9.00", "OR")["issues"], ["log_asymmetry"])
        self.assertTrue(sm.check_ci_bounds("2.00", "1.00", "4.00", "OR")["consistent"])


class PaperStatAuditTests(unittest.TestCase):
    def test_paper_wide_audit_detects_all_signal_categories(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "Results", fontsize=13)
        p0.insert_text((72, 95), "Group difference was t(28) = 2.10, p = 0.002 and F(2, 45) = 1.20, p = 0.01.", fontsize=10)
        p0.insert_text((72, 112), "Also chi2(1) = 1.50, p = 0.02 and z = 1.10, p = 0.01.", fontsize=10)
        p0.insert_text((72, 129), "Responder rate was 24/120 (25.0%) with OR = 2.10 (95% CI 2.30-3.50).", fontsize=10)
        p0.insert_text((72, 146), "For the 1-item rating (n = 10), M = 3.45.", fontsize=10)
        p0.insert_text((72, 163), "As shown in Table 1, mortality was 18.0% and p = 0.001.", fontsize=10)

        p0.insert_text((72, 200), "Table 1. Outcomes and Totals", fontsize=11)
        _draw_grid(
            p0, (72, 215), [140, 110, 110, 90], 24,
            [
                ["Outcome", "Drug (N = 100)", "Control (N = 100)", "Total"],
                ["Events n (%)", "12 (19.0%)", "10 (10.0%)", "22"],
                ["Count A", "15", "20", "35"],
                ["Count B", "10", "5", "25"],
                ["Total", "30", "25", "55"],
            ],
        )
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        res = audit.audit_paper_statistics(summary["paperId"], summary["fileHash"], store=store)
        self.assertEqual(res["schema"], audit.SCHEMA)
        self.assertGreater(res["signalCount"], 0)
        kinds = {sig["kind"] for sig in res["signals"]}
        self.assertIn("stat_pvalue_mismatch", kinds)
        self.assertIn("percentage_mismatch", kinds)
        self.assertIn("grim_impossible", kinds)
        self.assertIn("ci_containment_or_symmetry", kinds)
        self.assertIn("table_sum_mismatch", kinds)
        self.assertIn("cross_modal_number_mismatch", kinds)

        capped = audit.audit_paper_statistics(summary["paperId"], summary["fileHash"], max_signals=3, store=store)
        self.assertEqual(capped["signalCount"], 3)
        self.assertTrue(capped["truncated"])

    def test_cross_modal_figure_printed_values_and_clean_paper(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 80), "Baseline test was t(28) = 2.05, p = 0.050 and rate 24/120 (20.0%).", fontsize=10)
        p0.insert_text((72, 100), "Figure 1 shows an effect of 1.85 (95% CI 1.10-2.90).", fontsize=10)
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        clean = audit.audit_paper_statistics(summary["paperId"], summary["fileHash"], store=store)
        self.assertEqual(clean["signalCount"], 0)

        fig_item = {
            "id": "fig-1",
            "type": "figure",
            "pageIndex": 0,
            "bbox": [72, 200, 400, 400],
            "caption": "Figure 1. Forest plot",
            "printedValues": [{"value": 1.24, "lowerCi": 0.98, "upperCi": 1.56, "source": "pdf-text"}],
        }
        loaded = audit.audit_loaded_paper(summary["paperId"], summary["fileHash"], summary, [fig_item], store=store)
        self.assertEqual(loaded["signalCount"], 1)
        self.assertEqual(loaded["signals"][0]["kind"], "cross_modal_number_mismatch")
        self.assertEqual(loaded["signals"][0]["itemId"], "fig-1")


if __name__ == "__main__":
    unittest.main()

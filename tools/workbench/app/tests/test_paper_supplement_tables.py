"""Unittest suite for supplementary table arithmetic recalculation in paper_supplement_audit."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_supplement_audit as psa  # noqa: E402

FORBIDDEN_RED_KEYS = ("before", "after", "patch", "gold", "why_hard", "candidateRationales")
SUM_KIND = "supplement_table_sum_mismatch"
PCT_KIND = "supplement_table_percentage_mismatch"


def _assert_no_red_keys(obj):
    if isinstance(obj, dict):
        for key, value in obj.items():
            assert key not in FORBIDDEN_RED_KEYS, key
            _assert_no_red_keys(value)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_red_keys(item)


def _audit(main_text, supplements):
    report = psa.audit_paper_with_supplements(main_text, supplements)
    _assert_no_red_keys(report)
    return report


def _kinds(report):
    return [signal["kind"] for signal in report["signals"]]


class RowSumTests(unittest.TestCase):
    def test_row_sum_mismatch_emits_d1_signal_and_consistent_control_is_silent(self):
        report = _audit("", [
            {
                "name": "Table_S1.csv",
                "text": "Model,Metric A,Metric B\nModel 1,1.5,2.25\nModel 2,2.0,3.00\nTotal,3.5,5.30\n",
            },
            {
                "name": "Table_S2.csv",
                "text": "Model,Metric A,Metric B\nModel 1,1.5,2.25\nModel 2,2.0,3.0\nTotal,3.5,5.25\n",
            },
        ])
        sums = [signal for signal in report["signals"] if signal["kind"] == SUM_KIND]
        self.assertEqual(len(sums), 1, report["signals"])
        signal = sums[0]
        self.assertEqual(signal["family"], "D1")
        self.assertEqual(signal["category"], "D1")
        self.assertEqual(signal["supplementFile"], "Table_S1.csv")
        self.assertEqual(signal["reported"]["table"], "row-sum")
        self.assertEqual(signal["reported"]["label"], "Total")
        self.assertEqual(signal["reported"]["column"], "Metric B")
        self.assertAlmostEqual(signal["reported"]["printed"], 5.30, places=6)
        self.assertAlmostEqual(signal["computed"]["sum"], 5.25, places=6)
        self.assertEqual(signal["computed"]["cellCount"], 2)
        self.assertTrue(signal["detail"])
        self.assertEqual(report["counts"]["byKind"][SUM_KIND], 1)

    def test_row_sum_tolerates_half_ulp_at_printed_precision(self):
        report = _audit("", [{
            "name": "Table_S1.csv",
            "text": "Site,Cases\nA,0.1\nB,0.2\nTotal,0.3\n",
        }])
        self.assertEqual([signal for signal in report["signals"] if signal["kind"] == SUM_KIND], [])


class ColumnSumTests(unittest.TestCase):
    def test_column_sum_mismatch_and_consistent_row_control(self):
        report = _audit("", [{
            "name": "Table_S4.csv",
            "text": "Group,Arm A,Arm B,Total\nCohort X,10,20,30\nCohort Y,15,25,31\n",
        }])
        sums = [signal for signal in report["signals"] if signal["kind"] == SUM_KIND]
        self.assertEqual(len(sums), 1, report["signals"])
        signal = sums[0]
        self.assertEqual(signal["reported"]["table"], "column-sum")
        self.assertEqual(signal["reported"]["label"], "Cohort Y")
        self.assertEqual(signal["reported"]["column"], "Total")
        self.assertEqual(signal["reported"]["printed"], 31)
        self.assertEqual(signal["computed"]["sum"], 40)
        self.assertEqual(signal["computed"]["cellCount"], 2)


class PercentageTests(unittest.TestCase):
    def test_percentage_vs_total_mismatch_uses_public_stat_helper(self):
        report = _audit("", [{
            "name": "adverse_events.csv",
            "text": "Group,n,Rate\nTreatment,30,25.0%\nControl,50,62.5%\nTotal,80,\n",
        }])
        pcts = [signal for signal in report["signals"] if signal["kind"] == PCT_KIND]
        self.assertEqual(len(pcts), 1, report["signals"])
        signal = pcts[0]
        self.assertEqual(signal["family"], "D1")
        self.assertEqual(signal["reported"]["label"], "Treatment")
        self.assertEqual(signal["reported"]["count"], 30)
        self.assertEqual(signal["reported"]["total"], 80)
        self.assertAlmostEqual(signal["reported"]["printedPct"], 25.0, places=6)
        self.assertAlmostEqual(signal["computed"]["computedPct"], 37.5, places=6)
        self.assertEqual(signal["computed"]["status"], "mismatch")
        self.assertEqual(report["counts"]["byKind"][PCT_KIND], 1)

    def test_header_stated_total_is_honoured(self):
        report = _audit("", [{
            "name": "Table_S5.csv",
            "text": "Arm,n (N = 60),Share\nA,30,50.0%\nB,18,40.0%\n",
        }])
        pcts = [signal for signal in report["signals"] if signal["kind"] == PCT_KIND]
        self.assertEqual(len(pcts), 1, report["signals"])
        self.assertEqual(pcts[0]["reported"]["label"], "B")
        self.assertEqual(pcts[0]["reported"]["total"], 60)
        self.assertAlmostEqual(pcts[0]["computed"]["computedPct"], 30.0, places=6)

    def test_docx_supplement_tab_table_is_audited_with_its_page_index(self):
        report = _audit("", [{
            "name": "supplement.docx",
            "segments": [{
                "id": "s5",
                "pageIndex": 2,
                "text": "Group\tN\tPct\nA\t10\t10.0%\nB\t20\t66.7%\nTotal\t30\t100.0%\n",
            }],
        }])
        pcts = [signal for signal in report["signals"] if signal["kind"] == PCT_KIND]
        self.assertEqual(len(pcts), 1, report["signals"])
        self.assertEqual(pcts[0]["segmentId"], "s5")
        self.assertEqual(pcts[0]["pageIndex"], 2)
        self.assertEqual(pcts[0]["supplementFile"], "supplement.docx")


class ThousandsSeparatorTests(unittest.TestCase):
    TAB = "\t"

    def _tsv(self, total_events):
        return "\n".join([
            "Arm\tEvents\tTotal",
            "A\t400\t1,000",
            "B\t600\t2,000",
            f"Total\t{total_events}\t3,000",
            "",
        ])

    def test_thousand_separated_cells_parse_and_mismatch(self):
        report = _audit("", [{"name": "Table_S6.tsv", "text": self._tsv("1,050")}])
        sums = [signal for signal in report["signals"] if signal["kind"] == SUM_KIND]
        self.assertEqual(len(sums), 1, report["signals"])
        self.assertEqual(sums[0]["reported"]["column"], "Events")
        self.assertEqual(sums[0]["reported"]["printed"], 1050)
        self.assertEqual(sums[0]["computed"]["sum"], 1000)

    def test_thousand_separated_consistent_control_is_silent(self):
        report = _audit("", [{"name": "Table_S6.tsv", "text": self._tsv("1,000")}])
        self.assertEqual([signal for signal in report["signals"] if signal["kind"] == SUM_KIND], [])


class AmbiguityGuardTests(unittest.TestCase):
    def test_non_numeric_cell_suppresses_sum_signal(self):
        report = _audit("", [{
            "name": "Table_S7.csv",
            "text": "Model,Value A,Value B\nM1,1.5,2.25\nM2,n/a,3.0\nTotal,9.5,5.25\n",
        }])
        self.assertEqual(_kinds(report), [])

    def test_mixed_units_and_prose_are_not_guessed(self):
        report = _audit("", [
            {"name": "supplement_notes.txt", "text": "Total cohort included 120 patients, of whom 25.0% responded."},
            {
                "name": "Table_S8.csv",
                "text": "Model,Mean (SD),Range\nA,1.5 (0.2),0-3\nB,2.0 (0.3),0-4\nTotal,3.5 (0.5),0-7\n",
            },
        ])
        self.assertEqual(_kinds(report), [])

    def test_clean_bundle_reports_zero_new_kinds(self):
        report = _audit("See Table S1 and Table S2.", [
            {
                "name": "Table_S1.csv",
                "text": "Model,Metric A,Metric B\nModel 1,1.5,2.25\nModel 2,2.0,3.0\nTotal,3.5,5.25\n",
            },
            {
                "name": "Table_S2.csv",
                "text": "Group,n,Rate\nTreatment,30,37.5%\nControl,50,62.5%\nTotal,80,\n",
            },
        ])
        self.assertEqual(report["counts"]["byKind"][SUM_KIND], 0)
        self.assertEqual(report["counts"]["byKind"][PCT_KIND], 0)
        self.assertEqual(report["counts"]["total"], 0)
        self.assertEqual(report["signals"], [])

    def test_signal_ids_are_sequential_and_unique(self):
        report = _audit("", [
            {
                "name": "Table_S1.csv",
                "text": "Model,Metric A,Metric B\nModel 1,1.5,2.25\nModel 2,2.0,3.00\nTotal,3.5,5.30\n",
            },
            {
                "name": "Table_S2.csv",
                "text": "Group,Arm A,Arm B,Total\nCohort X,10,20,30\nCohort Y,15,25,31\n",
            },
        ])
        ids = [signal["id"] for signal in report["signals"]]
        self.assertEqual(ids, [f"SUPP-{index + 1}" for index in range(len(ids))])
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(report["counts"]["total"], len(ids))


if __name__ == "__main__":
    unittest.main()

"""Flow arithmetic signals stay separate from advisory spin-triage hints."""
import hashlib
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_blue_sensor as sensor  # noqa: E402
import paper_evidence as pe  # noqa: E402
import paper_flow_and_spin_triage as flow  # noqa: E402

CANONICAL = (
    "A total of 200 patients were randomized (100 Treatment, 100 Control); "
    "28 discontinued prior to follow-up, and 185 completed the primary endpoint analysis."
)
BENIGN_FLOW = (
    "Of 150 screened patients, 30 were excluded before randomization and 120 were randomized "
    "(60 Treatment, 60 Control); 12 discontinued and 108 were analyzed."
)
COMORBIDITY = (
    "Baseline comorbidities (non-mutually exclusive, patients could have multiple conditions): "
    "Hypertension 74 (61.7%), Diabetes 52 (43.3%), Dyslipidemia 68 (56.7%)."
)
SIGNAL_KEYS = {
    "id", "family", "kind", "subtype", "pageIndex", "excerpt", "detail", "reported", "computed",
}


def _audit(text="", tables=None, **kwargs):
    pages = text if isinstance(text, list) else [text]
    return flow.audit_flow_and_spin_triage(pages, table_items=tables, **kwargs)


def _by_check(result, check):
    return [sig for sig in result["signals"] if sig["computed"].get("check") == check]


class FlowArithmeticTests(unittest.TestCase):
    def test_screening_attrition_and_arm_sums(self):
        screening = _audit(
            "Of 200 screened patients, 40 were excluded before randomization and 150 were randomized."
        )
        screened = _by_check(screening, "screening")
        self.assertEqual(len(screened), 1, screening)
        self.assertEqual(screened[0]["reported"], {"screened": 200, "excluded": 40, "randomized": 150})
        self.assertEqual(screened[0]["computed"]["expected"], 160)
        self.assertEqual(screened[0]["family"], "D1")
        self.assertEqual(screened[0]["kind"], "consort_flow_mismatch")
        self.assertEqual(screened[0]["subtype"], "participant-flow-mismatch")
        self.assertEqual(screened[0]["id"], "flow-1")
        self.assertLessEqual(len(screened[0]["excerpt"]), 220)

        assessed = _audit(
            "220 patients were assessed for eligibility; 30 did not meet criteria and 180 were enrolled."
        )
        self.assertEqual(_by_check(assessed, "screening")[0]["computed"]["expected"], 190)

        canonical = _audit([{"id": "p3", "pageIndex": 3, "text": CANONICAL}])
        attrition = _by_check(canonical, "attrition")
        self.assertEqual(len(canonical["signals"]), 1, canonical)
        self.assertEqual(attrition[0]["reported"], {"randomized": 200, "attrition": 28, "analyzed": 185})
        self.assertEqual(attrition[0]["computed"]["expected"], 172)
        self.assertEqual(attrition[0]["pageIndex"], 3)
        self.assertEqual(attrition[0]["itemId"], "p3")
        self.assertTrue(SIGNAL_KEYS <= set(attrition[0]))

        summed = _audit(
            "100 patients were randomized; 10 were lost to follow-up, 5 withdrew, and 80 were analyzed."
        )
        self.assertEqual(_by_check(summed, "attrition")[0]["reported"]["attrition"], 15)
        self.assertEqual(_by_check(summed, "attrition")[0]["computed"]["expected"], 85)

        paren = _audit("200 patients were randomized (90 Treatment, 90 Control).")
        allocation = _by_check(paren, "allocation")
        self.assertEqual(allocation[0]["reported"]["total"], 200)
        self.assertEqual(allocation[0]["reported"]["arms"], [90, 90])
        self.assertEqual(allocation[0]["computed"]["armSum"], 180)

        assigned = _audit(
            "We enrolled N = 200 participants, with 95 assigned to treatment and 95 assigned to control."
        )
        assigned_sig = _by_check(assigned, "allocation")
        self.assertEqual(len(assigned_sig), 1, assigned)
        self.assertEqual(assigned_sig[0]["computed"]["armSum"], 190)
        self.assertEqual(assigned["triageHints"], [])

        shaped = flow.audit_flow_and_spin_triage([(4, CANONICAL)])
        self.assertEqual(shaped["signals"][0]["pageIndex"], 4)
        self.assertNotIn("itemId", shaped["signals"][0])

    def test_table_partition_and_fraction_overflow(self):
        table = {
            "id": "sex",
            "pageIndex": 2,
            "caption": "Table 1. Baseline sex",
            "headers": ["Characteristic", "Treatment (N = 100)", "Control (N = 80)"],
            "rows": [["Male", "60", "40"], ["Female", "50", "40"]],
        }
        result = _audit(tables=[table])
        partitions = _by_check(result, "partition")
        self.assertEqual(len(partitions), 1, result)
        self.assertEqual(partitions[0]["kind"], "subgroup_sum_mismatch")
        self.assertEqual(partitions[0]["subtype"], "denominator-sum-mismatch")
        self.assertEqual(partitions[0]["reported"]["columnN"], 100)
        self.assertEqual(partitions[0]["computed"]["sum"], 110)
        self.assertEqual(partitions[0]["pageIndex"], 2)
        self.assertEqual(partitions[0]["itemId"], "sex")

        under = _audit(tables=[{
            "headers": ["Characteristic", "Arm (N = 100)"],
            "rows": [["Men", "30"], ["Women", "40"]],
        }])
        self.assertEqual(_by_check(under, "partition")[0]["computed"]["sum"], 70)

        yes_no = _audit(tables=[{
            "headers": ["Response", "Arm (N = 40)"],
            "rows": [["Yes", "30"], ["No", "20"]],
        }])
        self.assertEqual(_by_check(yes_no, "partition")[0]["reported"]["pair"], "yes+no")

        overflow = _audit(tables=[{
            "headers": ["Characteristic", "Arm (N = 50)"],
            "rows": [["Median count", "80"]],
        }])
        self.assertEqual(_by_check(overflow, "row-cap")[0]["reported"]["count"], 80)

        cells = {
            "id": "cells-sex",
            "pageIndex": 4,
            "caption": "Table 2. Sex",
            "table": {"rows": 3, "columns": 2, "cells": [
                {"row": 0, "column": 0, "text": "Characteristic", "header": True},
                {"row": 0, "column": 1, "text": "Arm (N = 100)", "header": True},
                {"row": 1, "column": 0, "text": "Male", "header": False},
                {"row": 1, "column": 1, "text": "70", "header": False},
                {"row": 2, "column": 0, "text": "Female", "header": False},
                {"row": 2, "column": 1, "text": "40", "header": False},
            ]},
        }
        from_cells = _audit(tables=[cells])
        self.assertEqual(from_cells["signals"][0]["itemId"], "cells-sex")
        self.assertEqual(from_cells["signals"][0]["computed"]["sum"], 110)

        prose = _audit("Serious events occurred in 45/30 patients (150%).")
        fraction = _by_check(prose, "fraction")
        self.assertEqual(len(fraction), 1, prose)
        self.assertEqual(fraction[0]["kind"], "event_exceeds_denominator")
        self.assertEqual(fraction[0]["subtype"], "denominator-overflow")
        self.assertEqual(fraction[0]["reported"], {"numerator": 45, "denominator": 30})

        table_fraction = _audit(tables=[{
            "headers": ["Outcome", "Count"],
            "rows": [["Patients", "45/30 (150%)"]],
        }])
        self.assertEqual(_by_check(table_fraction, "fraction")[0]["reported"]["numerator"], 45)

    def test_benign_holdouts_emit_nothing(self):
        cases = {
            "flow": [BENIGN_FLOW],
            "comorbidity-prose": [COMORBIDITY],
            "blood-pressure": ["Mean blood pressure was 120/80 mmHg in these patients."],
            "visual": ["Visual acuity was 20/20 in the right eye and 20/15 in the left eye of treated patients."],
            "date": ["Participants were enrolled on 2024/11/03."],
            "hazard": ["The hazard ratio was 12/10 among treated patients."],
            "citation": ["Smith et al. reported 12/8 events in the patient cohort [15/4]."],
            "exploratory": [(
                "This observational analysis was associated with improved survival and is "
                "hypothesis-generating. It warrants further randomized trials."
            )],
            "aligned-polarity": [(
                "Treatment error rate was 9.2% and Control error rate was 18.4%. "
                "Treatment reduced the error rate relative to Control."
            )],
            "significant-p": ["The primary result was p = 0.04. The analysis stops there."],
        }
        for name, pages in cases.items():
            with self.subTest(name=name):
                result = flow.audit_flow_and_spin_triage(pages)
                self.assertEqual(result["signals"], [], result)
                self.assertEqual(result["triageHints"], [], result)

        tables = [
            {
                "caption": "Baseline comorbidities (non-mutually exclusive, patients could have multiple conditions)",
                "headers": ["Condition", "Count (N = 120)"],
                "rows": [["Hypertension", "74"], ["Diabetes", "52"], ["Dyslipidemia", "68"]],
            },
            {
                "caption": "Footnote: missing data were not available for 20 participants.",
                "headers": ["Characteristic", "Arm (N = 100)"],
                "rows": [["Male", "40"], ["Female", "40"]],
            },
            {
                "caption": "Kaplan-Meier number at risk for the delayed-entry, left-truncated cohort",
                "headers": ["Month", "Number at risk (N = 100)"],
                "rows": [["0", "80"], ["12", "110"]],
            },
        ]
        combined = (
            BENIGN_FLOW + " " + COMORBIDITY + " "
            "Mean blood pressure was 120/80 mmHg in these patients. "
            "Visual acuity was 20/20 and also 20/15 in treated patients. "
            "Participants were enrolled on 2024/11/03. "
            "The odds ratio was 9/4 for those patients. "
            "This observational analysis was associated with improved survival and is hypothesis-generating. "
            "Number at risk in this delayed-entry, left-truncated cohort is described below."
        )
        result = _audit(combined, tables)
        self.assertEqual(result["signals"], [], result)
        self.assertEqual(result["triageHints"], [], result)

    def test_hints_stay_out_of_signals(self):
        causal = _audit(
            "This retrospective single-arm study in mice was non-significant (p = 0.27). "
            "The regimen proves that the drug eliminates mortality."
        )
        self.assertEqual(causal["signals"], [], causal)
        self.assertEqual(len(causal["triageHints"]), 1, causal)
        hint = causal["triageHints"][0]
        self.assertEqual(hint["id"], "hint-1")
        self.assertEqual(hint["family"], "D3")
        self.assertEqual(hint["kind"], "d3_causal_overclaim_hint")
        self.assertIs(hint["advisoryOnly"], True)

        error_rate = _audit(
            "Treatment error rate was 18.4% and Control error rate was 9.2%. "
            "Treatment reduced the error rate relative to Control."
        )
        self.assertEqual(error_rate["signals"], [])
        self.assertEqual(error_rate["triageHints"][0]["kind"], "s1_polarity_inversion_hint")
        self.assertIs(error_rate["triageHints"][0]["advisoryOnly"], True)
        self.assertEqual(error_rate["triageHints"][0]["family"], "S1")
        self.assertGreater(error_rate["triageHints"][0]["reported"]["treatment"], error_rate["triageHints"][0]["reported"]["control"])

        mortality = _audit(
            "Mortality was 22% in Treatment vs 11% in Control. "
            "Treatment decreased mortality compared with Control."
        )
        self.assertEqual(mortality["signals"], [])
        self.assertEqual(mortality["triageHints"][0]["kind"], "s1_polarity_inversion_hint")

        increased = _audit(
            "Treatment error rate was 9.2% and Control error rate was 18.4%. "
            "Treatment increased the error rate compared with Control."
        )
        self.assertEqual(increased["triageHints"][0]["reported"]["direction"], "increased")
        self.assertEqual(increased["signals"], [])

    def test_limits_and_forbidden_keys(self):
        for bad in (True, False, 0, 101, -1):
            with self.assertRaises(ValueError) as caught:
                _audit("ok", max_signals=bad)
            self.assertEqual(caught.exception.args[0], "limit")
            with self.assertRaises(ValueError) as hints:
                _audit("ok", max_hints=bad)
            self.assertEqual(hints.exception.args[0], "limit")
        empty = _audit("", max_signals=100, max_hints=1)
        self.assertEqual(empty["schema"], flow.SCHEMA)
        self.assertFalse(empty["truncatedSignals"])
        self.assertEqual(empty["signalCount"], 0)

        with self.assertRaises(ValueError) as red:
            flow.audit_flow_and_spin_triage([{"text": "ok", "nested": [{"plan": 1}]}])
        self.assertEqual(red.exception.args[0], "forbidden_red_key")
        with self.assertRaises(ValueError) as table_red:
            _audit("ok", tables=[{"headers": ["A"], "rows": [["1"]], "gold": 1}])
        self.assertEqual(table_red.exception.args[0], "forbidden_red_key")

        capped = _audit(
            "Of 200 screened patients, 40 were excluded before randomization and 150 were randomized. "
            "Of 300 screened patients, 10 were excluded before randomization and 200 were randomized.",
            max_signals=1,
        )
        self.assertEqual(capped["signalCount"], 1)
        self.assertTrue(capped["truncatedSignals"])
        hinted = _audit(
            "This retrospective study had a non-significant result. "
            "The drug proves that benefit is real. It also establishes causality.",
            max_hints=1,
        )
        self.assertEqual(hinted["signals"], [])
        self.assertEqual(hinted["hintCount"], 1)
        self.assertTrue(hinted["truncatedHints"])


def _pdf(text):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    leftover = page.insert_textbox(pymupdf.Rect(48, 48, 547, 780), text, fontsize=11, fontname="helv")
    raw = doc.tobytes()
    doc.close()
    if leftover < 0:
        raise AssertionError(leftover)
    return raw


class SensorWireInTests(unittest.TestCase):
    def test_flow_triage_is_attached_and_hints_stay_separate(self):
        raw = _pdf(
            CANONICAL + " This retrospective observational study proves that the regimen eliminates mortality. "
            "Treatment error rate was 18.4% and Control error rate was 9.2%. "
            "Treatment reduced the error rate relative to Control."
        )
        store = pe.EvidenceStore()
        summary = store.prepare(raw, hashlib.sha256(raw).hexdigest())
        disabled = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=store)
        self.assertNotIn("flowAndSpinTriage", disabled)
        self.assertFalse(any(sig["kind"] == "consort_flow_mismatch" for sig in disabled["signals"]))

        enabled = sensor.run_blue_sensor(
            summary["paperId"], summary["fileHash"], store=store, include_flow_triage=True,
        )
        pack = enabled["flowAndSpinTriage"]
        self.assertTrue(pack["enabled"])
        self.assertEqual(pack["signalCount"], 1)
        self.assertEqual(pack["hintCount"], len(pack["triageHints"]))
        hint_kinds = {hint["kind"] for hint in pack["triageHints"]}
        self.assertEqual(hint_kinds, {"d3_causal_overclaim_hint", "s1_polarity_inversion_hint"})
        self.assertTrue(all(hint["advisoryOnly"] is True for hint in pack["triageHints"]))
        self.assertTrue(any(sig["kind"] == "consort_flow_mismatch" for sig in enabled["signals"]))
        self.assertFalse(any(
            sig.get("advisoryOnly") or sig["kind"] in hint_kinds for sig in enabled["signals"]
        ))

        with self.assertRaises(ValueError) as caught:
            sensor.run_blue_sensor(
                summary["paperId"], summary["fileHash"], store=store, include_flow_triage="yes",
            )
        self.assertEqual(caught.exception.args[0], "include_flow_triage")


if __name__ == "__main__":
    unittest.main()

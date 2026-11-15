"""IMRaD internal-consistency audit. Stdlib unittest only."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "app" / "local"))
import paper_internal_consistency as audit

ABSTRACT = "\n".join((
    "Abstract",
    "N = 240.",
    "Mortality was 8.2% (p = 0.012).",
))
METHODS = "\n".join((
    "Methods",
    "The primary endpoint was assessed at 12 months.",
    "We used 5-fold cross-validation.",
    "Patients aged 18 to 65 years were eligible.",
    "Alpha = 0.01.",
    "The primary endpoint was 12-month mortality.",
))
RESULTS = "\n".join((
    "Results",
    "A total of N = 180 patients were randomized.",
    "Mortality was 14.5% (p = 0.18).",
    "The primary endpoint at 6 months was reported.",
    "We used 10-fold cross-validation.",
    "We enrolled patients aged 18 to 78 years.",
    "Alpha = 0.05.",
    "12-month mortality was not significant (p = 0.22).",
))
CONCLUSION = "\n".join((
    "Conclusion",
    "The secondary endpoint of response rate improved significantly.",
))
PAGES = {
    0: ABSTRACT,
    1: METHODS,
    2: RESULTS,
    3: CONCLUSION,
}


def _paper():
    return [
        {"id": "s0", "pageIndex": 0, "text": ABSTRACT},
        {"id": "s1", "pageIndex": 1, "text": METHODS},
        {"id": "s2", "pageIndex": 2, "text": RESULTS},
        {"id": "s3", "pageIndex": 3, "text": CONCLUSION},
    ]


def _kinds(report):
    return [item["kind"] for item in report["signals"]]


class InternalConsistencyTests(unittest.TestCase):
    def test_schema_and_multipage_contradictions(self):
        report = audit.audit_internal_consistency(_paper())
        self.assertEqual(report["schema"], "falsify.internal-consistency.v1")
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["sectionsDetected"], ["abstract", "methods", "results", "conclusion"])
        kinds = _kinds(report)
        self.assertIn("abstract_results_sample_size_mismatch", kinds)
        self.assertIn("abstract_results_effect_or_p_mismatch", kinds)
        self.assertGreaterEqual(kinds.count("methods_results_protocol_drift"), 2)
        sample = next(item for item in report["signals"] if item["kind"] == "abstract_results_sample_size_mismatch")
        self.assertEqual(sample["family"], "D1")
        self.assertEqual(sample["subtype"], "internal-n-drift")
        self.assertEqual(sample["pageIndex"], 2)
        self.assertEqual(sample["reported"]["n"], 240)
        self.assertEqual(sample["computed"]["n"], 180)
        effects = [item for item in report["signals"] if item["kind"] == "abstract_results_effect_or_p_mismatch"]
        self.assertEqual(len(effects), 1)
        effect = effects[0]
        self.assertEqual(effect["subtype"], "internal-metric-drift")
        self.assertEqual(effect["reported"]["value"], 8.2)
        self.assertEqual(effect["computed"]["value"], 14.5)
        self.assertEqual(effect["reported"]["p"], 0.012)
        self.assertEqual(effect["computed"]["p"], 0.18)
        protocols = [item for item in report["signals"] if item["kind"] == "methods_results_protocol_drift"]
        parameters = {item["reported"]["parameter"] for item in protocols}
        self.assertIn("primary_follow_up_months", parameters)
        self.assertIn("cross_validation_folds", parameters)
        months = next(item for item in protocols if item["reported"]["parameter"] == "primary_follow_up_months")
        folds = next(item for item in protocols if item["reported"]["parameter"] == "cross_validation_folds")
        self.assertEqual(months["family"], "D4-1")
        self.assertEqual(months["subtype"], "methods-results-drift")
        self.assertEqual(months["reported"]["value"], 12)
        self.assertEqual(months["computed"]["value"], 6)
        self.assertEqual(folds["reported"]["value"], 5)
        self.assertEqual(folds["computed"]["value"], 10)
        self.assertEqual(months["anchorSection"], "methods")
        self.assertEqual(months["pageIndex"], 2)

    def test_excerpts_are_verbatim_on_the_named_page(self):
        report = audit.audit_internal_consistency([(0, ABSTRACT), (1, METHODS), (2, RESULTS), (3, CONCLUSION)])
        self.assertGreater(report["signalCount"], 0)
        for signal in report["signals"]:
            self.assertIn(signal["excerpt"], PAGES[signal["pageIndex"]])
            self.assertLessEqual(len(signal["excerpt"]), 220)
            self.assertIn(signal["anchorExcerpt"], PAGES[signal["anchorPageIndex"]])
            self.assertLessEqual(len(signal["anchorExcerpt"]), 220)
            self.assertTrue(signal["id"].startswith("ic-"))

    def test_endpoint_hint_stays_out_of_signals(self):
        report = audit.audit_internal_consistency(_paper())
        hints = [item for item in report["triageHints"] if item["kind"] == "primary_endpoint_emphasis_shift"]
        self.assertEqual(len(hints), 1)
        hint = hints[0]
        self.assertTrue(hint["advisoryOnly"])
        self.assertEqual(hint["family"], "D3")
        self.assertIn("12-month mortality", hint["methodsExcerpt"])
        self.assertIn("not significant", hint["resultsExcerpt"])
        self.assertTrue(hint["verificationPrompt"])
        self.assertNotIn("primary_endpoint_emphasis_shift", _kinds(report))
        self.assertNotIn("declared_exclusion_or_covariate_check", _kinds(report))

    def test_covariate_hint_is_advisory_only(self):
        pages = [
            "Methods\nModels were adjusted for age, sex, and baseline severity.",
            "Results\nMortality was compared between arms (p = 0.03).",
        ]
        report = audit.audit_internal_consistency(pages)
        self.assertEqual(report["signalCount"], 0)
        self.assertEqual(report["triageHints"][0]["kind"], "declared_exclusion_or_covariate_check")
        self.assertEqual(report["triageHints"][0]["family"], "D5")
        self.assertTrue(report["triageHints"][0]["advisoryOnly"])

    def test_benign_traps_emit_no_signals(self):
        holdouts = [
            "Abstract\nITT (N = 200) was analyzed.\nResults\nThe per-protocol population included n = 184.",
            "Abstract\nThe unadjusted OR = 2.4.\nResults\nThe adjusted aOR = 1.7.",
            "Abstract\nMean blood pressure was 120 ± 10 SD.\nResults\nMean blood pressure was 120 ± 4 SE.",
            "Abstract\nTraining AUC = 0.94.\nResults\nValidation AUC = 0.81.",
            "Abstract\n6-month mortality was 8.2%.\nResults\n12-month mortality was 14.5%.",
            "Abstract\n240 patients were randomized.\nResults\n300 patients were screened.",
            "Abstract\nThe discovery cohort included N = 400.\nResults\nThe validation cohort included N = 200.",
            "Abstract\nN = 200.\nResults\nTreatment n = 100 and Control n = 100.",
        ]
        for text in holdouts:
            report = audit.audit_internal_consistency(text)
            self.assertEqual(report["signalCount"], 0, text)
            self.assertEqual(report["signals"], [], text)

    def test_snippet_without_headings_is_insufficient(self):
        report = audit.audit_internal_consistency(["We enrolled 10 patients and mortality was 3%."])
        self.assertEqual(report["status"], "insufficient_sections")
        self.assertEqual(report["sectionsDetected"], [])
        self.assertEqual(report["signalCount"], 0)
        self.assertEqual(report["signals"], [])
        self.assertEqual(report["hintCount"], 0)
        self.assertEqual(report["triageHints"], [])

    def test_sensitivity_analysis_does_not_count_as_protocol_drift(self):
        text = "\n".join((
            "Methods",
            "The primary endpoint was assessed at 12 months.",
            "Results",
            "In a sensitivity analysis the primary endpoint at 6 months differed.",
        ))
        report = audit.audit_internal_consistency(text)
        self.assertEqual(_kinds(report), [])

    def test_korean_cohort_mismatch(self):
        text = "초록\n총 240명을 무작위 배정하였다.\n결과\n총 180명을 무작위 배정하였다."
        report = audit.audit_internal_consistency(text)
        self.assertEqual(_kinds(report), ["abstract_results_sample_size_mismatch"])
        self.assertIn("총 180명", report["signals"][0]["excerpt"])

    def test_blindness_and_limits(self):
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_internal_consistency([{"text": "Abstract\nN = 1.", "gold": 1}])
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_internal_consistency(["Abstract\nN = 1."], table_items=[{"plan": "hidden"}])
        for kwargs in ({"max_signals": 0}, {"max_signals": 101}, {"max_signals": True}, {"max_hints": False}):
            with self.assertRaisesRegex(ValueError, "limit"):
                audit.audit_internal_consistency(["Abstract\nN = 1."], **kwargs)
        report = audit.audit_internal_consistency("Abstract\nN = 240.\nResults\nN = 180.", max_signals=100, max_hints=1)
        self.assertEqual(report["signalCount"], 1)
        self.assertTrue(json.dumps(report))

    def test_functions_stay_within_ccn_limit(self):
        script = REPO / "tools" / "quality" / "python-functions.py"
        source = (REPO / "app" / "local" / "paper_internal_consistency.py").read_bytes()
        proc = subprocess.run([sys.executable, str(script)], input=source, capture_output=True, check=True)
        functions = json.loads(proc.stdout.decode("utf-8"))
        over = [f"{item['id']}:{item['ccn']}" for item in functions if item["ccn"] > 15]
        self.assertEqual(over, [])


if __name__ == "__main__":
    unittest.main()

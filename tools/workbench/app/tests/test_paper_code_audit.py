"""Static code-supplement audit. Stdlib unittest only. Never executes supplement code."""
import hashlib
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_code_audit as audit
import paper_mcp_bundle as bundle

BAD = (
    "All hypothesis tests were two-sided with alpha = 0.05, "
    "and feature standardization was fit strictly on the training split after train-test partitioning."
)
LEAK_PY = (
    "from sklearn.preprocessing import StandardScaler\n"
    "from sklearn.model_selection import train_test_split\n"
    "from scipy.stats import ttest_ind\n"
    "X = StandardScaler().fit_transform(df[[\"age\", \"biomarker\"]])\n"
    "X_train, X_test, y_train, y_test = train_test_split(X, y)\n"
    "ttest_ind(y_train, y_test, alternative=\"greater\")\n"
)
BENIGN_PY = (
    "from sklearn.preprocessing import StandardScaler\n"
    "from sklearn.model_selection import train_test_split\n"
    "from scipy.stats import ttest_ind\n"
    "X_train, X_test, y_train, y_test = train_test_split(df, y)\n"
    "scaler = StandardScaler()\n"
    "scaler.fit_transform(X_train)\n"
    "scaler.transform(X_test)\n"
    "ttest_ind(y_train, y_test, alternative=\"two-sided\")\n"
)
OK = (
    "All hypothesis tests were two-sided with alpha = 0.05; "
    "feature scaling used StandardScaler fit on X_train after train_test_split."
)


def _pages(text, page_index=0):
    return [{"id": "p0", "pageIndex": page_index, "text": text}]


def _py(text, name="analysis.py"):
    return [{"name": name, "text": text}]


def _kinds(result):
    return [sig["kind"] for sig in result["signals"]]


class CodeAuditTests(unittest.TestCase):
    def test_no_code_limit_and_red_keys(self):
        empty = audit.audit_code_supplements(_pages("N = 4."), [{"name": "cohort.csv", "text": "id\n1\n"}])
        self.assertEqual(empty["schema"], audit.SCHEMA)
        self.assertEqual(empty["status"], "no_code_supplement")
        self.assertEqual(empty["scriptCount"], 0)
        self.assertEqual(empty["signals"], [])
        self.assertFalse(empty["truncated"])
        for bad in (True, False, 0, 101, 1.5):
            with self.assertRaisesRegex(ValueError, "limit"):
                audit.audit_code_supplements(_pages("x"), _py("x = 1\n"), max_signals=bad)
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_code_supplements(_pages("x"), [{"name": "a.py", "text": "x = 1\n", "nested": {"plan": 1}}])
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_code_supplements([{"text": "x", "gold": "no"}], _py("x = 1\n"))

    def test_canonical_leak_and_tail_are_anchored_to_the_manuscript(self):
        result = audit.audit_code_supplements(_pages(BAD), _py(LEAK_PY))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["scriptCount"], 1)
        self.assertEqual(sorted(_kinds(result)), ["code_preprocessing_leakage", "code_tailness_mismatch"])
        for sig in result["signals"]:
            self.assertEqual(sig["family"], "D6")
            self.assertEqual(sig["pageIndex"], 0)
            self.assertLessEqual(len(sig["excerpt"]), 220)
            self.assertIn("two-sided", sig["excerpt"])
            self.assertNotIn("fit_transform", sig["excerpt"])
            self.assertEqual(sig["supplementName"], "analysis.py")
            self.assertEqual(sig["computed"]["supplementName"], "analysis.py")
            self.assertEqual(sig["lineNumber"], sig["computed"]["lineNumber"])
            self.assertEqual(sig["codeSnippet"], sig["computed"]["codeSnippet"])
            self.assertGreater(sig["lineNumber"], 0)
        snippets = {sig["kind"]: sig["codeSnippet"] for sig in result["signals"]}
        self.assertIn("fit_transform", snippets["code_preprocessing_leakage"])
        self.assertIn('alternative="greater"', snippets["code_tailness_mismatch"])

    def test_benign_split_then_train_fit_is_not_flagged(self):
        benign = audit.audit_code_supplements(_pages(OK), _py(BENIGN_PY))
        guarded = audit.audit_code_supplements(_pages(BAD), _py(BENIGN_PY))
        self.assertEqual(_kinds(benign), [])
        self.assertEqual(_kinds(guarded), [])

    def test_opposite_one_sided_direction_and_r_alternative(self):
        greater = "The primary contrast was one-sided greater."
        same = audit.audit_code_supplements(_pages(greater), _py('ttest_ind(a, b, alternative="greater")\n'))
        opposite = audit.audit_code_supplements(_pages(greater), _py('ttest_ind(a, b, alternative="less")\n'))
        self.assertEqual(_kinds(same), [])
        self.assertEqual(_kinds(opposite), ["code_tailness_mismatch"])
        r_script = 'result <- t.test(x, y, alternative = "less")\n'
        r_result = audit.audit_code_supplements(_pages(BAD), [{"name": "analysis.R", "text": r_script}])
        self.assertEqual(_kinds(r_result), ["code_tailness_mismatch"])
        self.assertEqual(r_result["signals"][0]["supplementName"], "analysis.R")
        self.assertIn("t.test", r_result["signals"][0]["codeSnippet"])

    def test_row_filters_cohort_claims_and_missing_data_guard(self):
        cohort = "All enrolled patients were analyzed with no exclusions."
        flagged = audit.audit_code_supplements(_pages(cohort), _py("df = df.iloc[:10]\n"))
        self.assertEqual(_kinds(flagged), ["code_undisclosed_row_filter"])
        comment = audit.audit_code_supplements(_pages(cohort), _py("# df = df.iloc[:10]\n"))
        self.assertEqual(_kinds(comment), [])
        missing = "All enrolled rows were kept with complete-case handling of missing values."
        kept = audit.audit_code_supplements(_pages(missing), _py("df = df.dropna()\n"))
        self.assertEqual(_kinds(kept), [])
        dropped = audit.audit_code_supplements(_pages(cohort), _py("df = df.dropna()\n"))
        self.assertEqual(_kinds(dropped), ["code_undisclosed_row_filter"])
        csv = "id,age\n1,10\n2,11\n3,12\n"
        n_claim = audit.audit_code_supplements(
            _pages("The study reports N = 3."),
            [{"name": "cohort.csv", "text": csv}, {"name": "analysis.py", "text": "df = df.head(1)\n"}],
        )
        self.assertEqual(_kinds(n_claim), ["code_undisclosed_row_filter"])
        sql = "SELECT * FROM patients WHERE id NOT IN (3, 4);\n"
        sql_result = audit.audit_code_supplements(
            _pages("All randomized participants were included."),
            [{"name": "filter.sql", "text": sql}],
        )
        self.assertEqual(sql_result["signals"][0]["subtype"], "code-undisclosed-exclusion")
        r_filter = audit.audit_code_supplements(_pages(cohort), [{"name": "a.R", "text": "subset(df, score < 10)\n"}])
        self.assertEqual(_kinds(r_filter), ["code_undisclosed_row_filter"])

    def test_method_mismatch_is_single_script_only(self):
        rank = "The primary analysis used the Mann-Whitney U test."
        two = "from scipy.stats import ttest_ind\nttest_ind(a, b)\nttest_ind(c, d)\nprint(res.pvalue)\n"
        mismatch = audit.audit_code_supplements(_pages(rank), _py(two))
        self.assertEqual(_kinds(mismatch), ["code_test_method_mismatch"])
        both = two + "mannwhitneyu(a, b)\n"
        self.assertEqual(_kinds(audit.audit_code_supplements(_pages(rank), _py(both))), [])
        multi = "P values were adjusted with the Bonferroni correction."
        raw = audit.audit_code_supplements(_pages(multi), _py(two))
        self.assertEqual(_kinds(raw), ["code_test_method_mismatch"])
        adjusted = two + "multipletests(pvals)\n"
        self.assertEqual(_kinds(audit.audit_code_supplements(_pages(multi), _py(adjusted))), [])
        scripts = [{"name": "a.py", "text": two}, {"name": "b.R", "text": "t.test(a, b)\n"}]
        self.assertEqual(_kinds(audit.audit_code_supplements(_pages(rank), scripts)), [])

    def test_bytes_segments_tuple_pages_pipeline_and_cap(self):
        pages = [(4, BAD)]
        result = audit.audit_code_supplements(pages, [{"name": "analysis.py", "bytes": LEAK_PY.encode("utf-8")}])
        self.assertEqual(result["signals"][0]["pageIndex"], 4)
        segments = [{"name": "analysis.py", "segments": [{"text": LEAK_PY}]}]
        self.assertIn("code_tailness_mismatch", _kinds(audit.audit_code_supplements([BAD], segments)))
        capped = audit.audit_code_supplements(_pages(BAD), _py(LEAK_PY), max_signals=1)
        self.assertEqual(capped["signalCount"], 1)
        self.assertTrue(capped["truncated"])
        pipe = (
            "from sklearn.pipeline import Pipeline\n"
            "from sklearn.preprocessing import StandardScaler\n"
            "from sklearn.model_selection import cross_val_score\n"
            "pipe = Pipeline([('scaler', StandardScaler())])\n"
            "cross_val_score(pipe, X, y, cv=5)\n"
        )
        claim = "Scaling was nested in cross-validation with no data leakage."
        self.assertEqual(_kinds(audit.audit_code_supplements(_pages(claim), _py(pipe))), [])
        explosive = 'raise SystemExit("executed")\n' + LEAK_PY
        self.assertIn("code_preprocessing_leakage", _kinds(audit.audit_code_supplements(_pages(BAD), _py(explosive))))


def _pdf(text):
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 90), text, fontsize=12)
        return doc.tobytes()
    finally:
        doc.close()


class _Store:
    def __init__(self, raw):
        self.raw = raw
        self.paper_id = "paper-code"
        self.file_hash = hashlib.sha256(raw).hexdigest()

    def status(self, paper_id):
        return {
            "schema": "falsify.paper-evidence.v1",
            "paperId": self.paper_id,
            "fileHash": self.file_hash,
            "status": "ready",
            "pageCount": 1,
            "counts": {"tables": 0, "figures": 0},
            "engine": "test",
            "limitations": ["unit"],
            "expiresAt": "2026-11-16T00:00:00+00:00",
        }

    def source_bytes(self, paper_id, file_hash):
        return self.raw

    def list_items(self, paper_id, kind=None, page_index=None, offset=0, limit=50):
        return {"items": []}


class BundleCodePayloadTests(unittest.TestCase):
    def test_payload_keeps_csv_companion_and_flow_flag_is_bool(self):
        raw = _pdf("The study reports N = 3.")
        store = _Store(raw)
        csv = {"supplementId": "csv-1", "name": "cohort.csv", "text": "id,age\n1,10\n2,11\n3,12\n"}
        script = {"supplementId": "py-1", "name": "analysis.py", "text": "df = df.iloc[:1]\n"}
        with self.assertRaisesRegex(ValueError, "limit"):
            bundle.audit_code_supplements_payload(store, store.paper_id, store.file_hash, [script], max_signals=0)
        with self.assertRaisesRegex(ValueError, "paper_evidence_unknown_id"):
            bundle.audit_code_supplements_payload(store, store.paper_id, store.file_hash, [script, csv], supplement_id="missing")
        out = bundle.audit_code_supplements_payload(
            store, store.paper_id, store.file_hash, [script, csv], supplement_id="py-1",
        )
        self.assertEqual(out["paperId"], store.paper_id)
        self.assertEqual(out["fileHash"], store.file_hash)
        self.assertEqual(out["schema"], audit.SCHEMA)
        self.assertIn("code_undisclosed_row_filter", _kinds(out))
        with self.assertRaisesRegex(ValueError, "include_flow_triage"):
            bundle.run_blue_sensor_payload(
                store, store.paper_id, store.file_hash, digest_only=True, include_flow_triage="yes",
            )
        digest = bundle.run_blue_sensor_payload(
            store, store.paper_id, store.file_hash, max_signals=10, digest_only=True, include_flow_triage=True,
        )
        self.assertTrue(digest["digestOnly"])
        self.assertTrue(digest["flowAndSpinTriage"]["enabled"])
        digest_off = bundle.run_blue_sensor_payload(
            store, store.paper_id, store.file_hash, max_signals=10, digest_only=True, include_flow_triage=False,
        )
        self.assertNotIn("flowAndSpinTriage", digest_off)


if __name__ == "__main__":
    unittest.main()

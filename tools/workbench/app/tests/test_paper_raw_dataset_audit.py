"""Row-level raw dataset recomputation. Stdlib unittest only."""
import hashlib
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_mcp_bundle as bundle
import paper_raw_dataset_audit as audit

SCORE_ROWS = "\n".join([
    "id,group,score,event",
    "1,Alpha,0,1",
    "2,Alpha,0,0",
    "3,Alpha,0,0",
    "4,Alpha,0,0",
    "5,Alpha,0,0",
    "6,Alpha,30,0",
    "7,Beta,8,0",
    "8,Beta,9,0",
    "9,Beta,10,0",
    "10,Beta,11,0",
    "11,Beta,12,0",
    "12,Beta,13,0",
])
ELIGIBLE_ROWS = "\n".join([
    "group,age,eligible",
    "Alpha,1,1",
    "Alpha,2,1",
    "Alpha,3,1",
    "Beta,5,1",
    "Beta,6,1",
    "Beta,7,0",
    "Beta,8,0",
    "Alpha,9,0",
])


def _page(text):
    return [{"id": "p0", "pageIndex": 0, "text": text}]


def _csv(name, text):
    return [{"name": name, "text": text}]


def _kinds(result):
    return [(sig["kind"], sig["variable"]) for sig in result["signals"]]


class RawDatasetAuditTests(unittest.TestCase):
    def test_no_row_level_dataset_and_summary_tables_are_skipped(self):
        empty = audit.audit_raw_datasets([], [])
        self.assertEqual(empty["status"], "no_row_level_dataset")
        self.assertEqual(empty["datasetCount"], 0)
        self.assertEqual(empty["signals"], [])
        short = "a,b\n1,2\n3,4\n"
        summary = "stat,value\nmean,1.0\nsd,0.2\nn,40\n"
        skipped = audit.audit_raw_datasets(_page("N = 99"), _csv("short.csv", short) + _csv("summary.csv", summary))
        self.assertEqual(skipped["status"], "no_row_level_dataset")

    def test_forbidden_red_keys_raise(self):
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_raw_datasets([], [{"name": "cohort.csv", "text": SCORE_ROWS, "plan": "hidden"}])
        payload = '{"rows":[{"arm":"Alpha","score":1,"gold":1},{"arm":"Alpha","score":2},{"arm":"Beta","score":3}]}'
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_raw_datasets([], [{"name": "cohort.json", "text": payload}])
        with self.assertRaisesRegex(ValueError, "limit"):
            audit.audit_raw_datasets([], [], max_signals=0)
        with self.assertRaisesRegex(ValueError, "limit"):
            audit.audit_raw_datasets([], [], max_signals=True)

    def test_exclusion_respected_for_total_n(self):
        matched = audit.audit_raw_datasets(
            _page("In the cohort patients we enrolled N = 5."),
            _csv("cohort.csv", ELIGIBLE_ROWS),
        )
        raw = audit.audit_raw_datasets(
            _page("In the cohort patients we enrolled N = 8."),
            _csv("cohort.csv", ELIGIBLE_ROWS),
        )
        wrong = audit.audit_raw_datasets(
            _page("In the cohort patients we enrolled N = 3."),
            _csv("cohort.csv", ELIGIBLE_ROWS),
        )
        self.assertEqual(matched["datasets"][0]["analysisCount"], 5)
        self.assertEqual(matched["datasets"][0]["rowCount"], 8)
        self.assertFalse(any(sig["kind"] == "raw_dataset_n_mismatch" for sig in matched["signals"]))
        self.assertFalse(any(sig["kind"] == "raw_dataset_n_mismatch" for sig in raw["signals"]))
        self.assertIn(("raw_dataset_n_mismatch", "total"), _kinds(wrong))
        self.assertEqual(wrong["signals"][0]["family"], "D6")
        self.assertEqual(wrong["signals"][0]["subtype"], "raw-n-mismatch")
        self.assertEqual(wrong["signals"][0]["id"], "raw-1")

    def test_summary_match_mismatch_and_table_cell(self):
        base = audit.audit_raw_datasets(_page("Alpha score is described."), _csv("cohort.csv", SCORE_ROWS))
        alpha = next(group for group in base["datasets"][0]["groups"] if group["label"] == "alpha")
        score = next(column for column in alpha["columns"] if column["name"] == "score")
        mean = f"{score['mean']:.2f}"
        sd = f"{score['sd']:.2f}"
        ok = audit.audit_raw_datasets(
            _page(f"Alpha score was {mean} ± {sd}."),
            _csv("cohort.csv", SCORE_ROWS),
        )
        bad = audit.audit_raw_datasets(
            _page("Alpha score was 99.00 ± 0.10."),
            _csv("cohort.csv", SCORE_ROWS),
        )
        table = [{
            "id": "t1",
            "pageIndex": 1,
            "caption": "Table 1",
            "table": {"cells": [
                {"row": 0, "column": 0, "text": "Alpha score"},
                {"row": 0, "column": 1, "text": "99.0 ± 0.1"},
            ]},
        }]
        from_table = audit.audit_raw_datasets([], _csv("cohort.csv", SCORE_ROWS), table_items=table)
        self.assertFalse(any(sig["kind"] == "raw_dataset_summary_mismatch" for sig in ok["signals"]))
        self.assertIn(("raw_dataset_summary_mismatch", "score"), _kinds(bad))
        self.assertEqual(bad["signals"][0]["subtype"], "raw-summary-mismatch")
        self.assertIn(("raw_dataset_summary_mismatch", "score"), _kinds(from_table))
        self.assertEqual(from_table["signals"][0]["pageIndex"], 1)

    def test_p_requires_both_tests_and_skips_adjusted(self):
        both = audit.audit_raw_datasets(_page("Alpha score p = 0.32."), _csv("cohort.csv", SCORE_ROWS))
        neither = audit.audit_raw_datasets(_page("Alpha score p = 0.90."), _csv("cohort.csv", SCORE_ROWS))
        adjusted = audit.audit_raw_datasets(
            _page("In multivariable logistic regression, Alpha score p = 0.90."),
            _csv("cohort.csv", SCORE_ROWS),
        )
        fdr = audit.audit_raw_datasets(
            _page("Alpha score FDR-adjusted p_adj = 0.90."),
            _csv("cohort.csv", SCORE_ROWS),
        )
        fisher_ok = audit.audit_raw_datasets(_page("Alpha event p = 1.00."), _csv("cohort.csv", SCORE_ROWS))
        fisher_bad = audit.audit_raw_datasets(_page("Alpha event p = 0.01."), _csv("cohort.csv", SCORE_ROWS))
        self.assertFalse(any(sig["kind"] == "raw_dataset_p_mismatch" for sig in both["signals"]))
        self.assertIn(("raw_dataset_p_mismatch", "score"), _kinds(neither))
        self.assertEqual(neither["signals"][0]["family"], "D1")
        self.assertEqual(neither["signals"][0]["subtype"], "raw-p-mismatch")
        self.assertFalse(any(sig["kind"] == "raw_dataset_p_mismatch" for sig in adjusted["signals"]))
        self.assertFalse(any(sig["kind"] == "raw_dataset_p_mismatch" for sig in fdr["signals"]))
        self.assertFalse(any(sig["kind"] == "raw_dataset_p_mismatch" for sig in fisher_ok["signals"]))
        self.assertIn(("raw_dataset_p_mismatch", "event"), _kinds(fisher_bad))

    def test_json_segments_tuple_pages_and_cap(self):
        rows = [{"arm": "Alpha", "score": value} for value in (1, 2, 3)]
        rows.extend({"arm": "Beta", "score": value} for value in (9, 8, 7))
        import json
        payload = json.dumps({"data": rows})
        result = audit.audit_raw_datasets(
            [(0, "In the cohort patients we enrolled N = 99. Alpha score was 99.00 ± 0.10.")],
            [{"name": "cohort.json", "segments": [{"text": payload}]}],
            max_signals=1,
        )
        self.assertEqual(result["datasetCount"], 1)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["signals"]), 1)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["signals"][0]["id"], "raw-1")
        self.assertEqual(result["signals"][0]["kind"], "raw_dataset_n_mismatch")


def _pdf(text):
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 90), text, fontsize=12)
        return doc.tobytes()
    finally:
        doc.close()


class _Store:
    def __init__(self, raw, *, with_tables=True, explode_tables=False):
        self.raw = raw
        self.paper_id = "paper-raw"
        self.file_hash = hashlib.sha256(raw).hexdigest()
        self.with_tables = with_tables
        self.explode_tables = explode_tables

    def status(self, paper_id):
        return {
            "schema": "falsify.paper-evidence.v1",
            "paperId": self.paper_id,
            "fileHash": self.file_hash,
            "status": "ready",
            "pageCount": 1,
            "counts": {"tables": 1 if self.with_tables else 0, "figures": 0},
            "engine": "test",
            "limitations": ["unit"],
            "expiresAt": "2026-11-16T00:00:00+00:00",
        }

    def source_bytes(self, paper_id, file_hash):
        return self.raw

    def list_items(self, paper_id, kind=None, page_index=None, offset=0, limit=50):
        if self.explode_tables:
            raise RuntimeError("no tables")
        if not self.with_tables:
            return {"items": []}
        return {"items": [{"id": "t1", "type": "table", "pageIndex": 0}]}

    def read_item(self, paper_id, item_id):
        return {
            "id": "t1",
            "type": "table",
            "pageIndex": 0,
            "caption": "Alpha score 99.0 ± 0.1",
            "table": {"cells": [{"row": 0, "column": 0, "text": "Alpha score 99.0 ± 0.1"}]},
        }


class BundlePayloadTests(unittest.TestCase):
    def test_recompute_payload_binds_pdf_and_rejects_limits(self):
        raw = _pdf("In the cohort patients we enrolled N = 99.")
        store = _Store(raw)
        attached = [{"supplementId": "supp-1", "name": "cohort.csv", "text": SCORE_ROWS}]
        with self.assertRaisesRegex(ValueError, "limit"):
            bundle.recompute_raw_supplement_payload(store, store.paper_id, store.file_hash, attached, max_signals=0)
        with self.assertRaisesRegex(ValueError, "paper_evidence_unknown_id"):
            bundle.recompute_raw_supplement_payload(store, store.paper_id, store.file_hash, attached, supplement_id="missing")
        out = bundle.recompute_raw_supplement_payload(store, store.paper_id, store.file_hash, attached, supplement_id="supp-1")
        self.assertEqual(out["paperId"], store.paper_id)
        self.assertEqual(out["fileHash"], store.file_hash)
        self.assertEqual(out["schema"], audit.SCHEMA)
        self.assertTrue(any(sig["kind"] == "raw_dataset_n_mismatch" for sig in out["signals"]))
        self.assertTrue(any(sig["kind"] == "raw_dataset_summary_mismatch" for sig in out["signals"]))
        blind = _Store(raw, explode_tables=True)
        still = bundle.recompute_raw_supplement_payload(blind, blind.paper_id, blind.file_hash, attached)
        self.assertTrue(any(sig["kind"] == "raw_dataset_n_mismatch" for sig in still["signals"]))

    def test_figure_payload_and_sensor_flag(self):
        raw = _pdf("No figure claims here.")
        store = _Store(raw, with_tables=False)
        figures = bundle.audit_figures_payload(store, store.paper_id, store.file_hash)
        self.assertEqual(figures["schema"], "falsify.figure-forensics.v1")
        self.assertEqual(figures["paperId"], store.paper_id)
        with self.assertRaisesRegex(ValueError, "include_figure_forensics"):
            bundle.run_blue_sensor_payload(store, store.paper_id, store.file_hash, digest_only=False, include_figure_forensics="yes")
        digest = bundle.run_blue_sensor_payload(
            store, store.paper_id, store.file_hash, max_signals=10, digest_only=True, include_figure_forensics=True,
        )
        self.assertTrue(digest["digestOnly"])
        self.assertIn("figureForensics", digest)
        plain = bundle.run_blue_sensor_payload(store, store.paper_id, store.file_hash, max_signals=10, digest_only=True)
        self.assertNotIn("figureForensics", plain)


if __name__ == "__main__":
    unittest.main()

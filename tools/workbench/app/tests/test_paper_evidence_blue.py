"""BLUE prepared-context helper against an injected evidence store. No model call."""
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_evidence_blue as blue

HASH = "ab" * 32
OTHER = "cd" * 32


def cell(text, header=None, row=0, column=0):
    return {"row": row, "column": column, "rowSpan": 1, "columnSpan": 1, "text": text, "bbox": [1, 2, 3, 4], "header": header}


def table(item_id, cells, caption="Table 1"):
    return {"id": item_id, "type": "table", "pageIndex": 0, "bbox": [1, 2, 3, 4], "caption": caption,
            "provenance": "pymupdf-find-tables", "table": {"rows": 2, "columns": 2, "cells": cells}}


def figure(item_id="fig-1", caption="Figure 1. Group illustration"):
    return {"id": item_id, "type": "figure", "pageIndex": 0, "bbox": [5, 6, 7, 8], "caption": caption,
            "provenance": "pymupdf-image"}


class EvidenceDouble:
    def __init__(self, items, *, paper_id="paper-1", file_hash=HASH, limitations=("pymupdf table finder; no docling",),
                 status="ready", page_count=1, counts=None, engine="pymupdf-native",
                 expires="2026-11-03T00:00:00+00:00", page_size=None, total=None):
        self.paper_id, self.file_hash, self.items = paper_id, file_hash, list(items)
        self.limitations, self.status_value, self.page_count = list(limitations), status, page_count
        self.counts = counts or {"tables": sum(item["type"] == "table" for item in items),
                                  "figures": sum(item["type"] == "figure" for item in items)}
        self.engine, self.expires, self.page_size, self.total_override = engine, expires, page_size, total
        self.calls = []

    def status(self, paper_id):
        self.calls.append(("status", paper_id))
        if paper_id != self.paper_id:
            raise KeyError("hidden-id")
        return {"schema": "falsify.paper-evidence.v1", "paperId": self.paper_id, "fileHash": self.file_hash,
                "status": self.status_value, "pageCount": self.page_count, "counts": dict(self.counts),
                "engine": self.engine, "limitations": list(self.limitations), "expiresAt": self.expires}

    def list_items(self, paper_id, kind=None, page_index=None, offset=0, limit=50):
        self.calls.append(("list", paper_id, offset, limit))
        if paper_id != self.paper_id:
            raise KeyError("hidden-id")
        rows = [{key: item[key] for key in ("id", "type", "pageIndex", "bbox", "caption", "provenance")} for item in self.items]
        if kind is not None:
            rows = [row for row in rows if row["type"] == kind]
        step = limit if self.page_size is None else min(limit, self.page_size)
        batch = rows[offset:offset + step]
        total = len(rows) if self.total_override is None else self.total_override
        nxt = offset + len(batch) if batch and offset + len(batch) < len(rows) else None
        return {"paperId": self.paper_id, "fileHash": self.file_hash, "items": batch, "total": total, "nextOffset": nxt}

    def read_item(self, paper_id, item_id):
        self.calls.append(("read", paper_id, item_id))
        if paper_id != self.paper_id:
            raise KeyError("hidden-id")
        for item in self.items:
            if item["id"] == item_id:
                return dict(item)
        raise KeyError("hidden-item")

    def render_region(self, *args, **kwargs):
        self.calls.append(("render",))
        raise AssertionError("context_for_review must not render images")


class ContextTests(unittest.TestCase):
    def consistent(self, result, max_chars):
        text, coverage = result["text"], result["coverage"]
        self.assertLessEqual(len(text), max_chars)
        self.assertEqual(coverage["charCount"], len(text))
        self.assertEqual(coverage["maxChars"], max_chars)
        self.assertEqual(coverage["truncationCount"], len(coverage["omittedIds"]) + coverage["listGap"])
        self.assertEqual(coverage["listGap"], max(coverage["unlisted"], coverage["countGap"]))
        self.assertEqual(coverage["included"]["tables"] + coverage["omitted"]["tables"], coverage["listed"]["tables"])
        self.assertEqual(coverage["included"]["figures"] + coverage["omitted"]["figures"], coverage["listed"]["figures"])
        expected = bool(coverage["truncationCount"] or not coverage["limitationsInText"] or coverage["listIncomplete"] or coverage["unavailableItems"])
        self.assertEqual(coverage["truncated"], expected)
        if coverage["limitationsInText"]:
            for item in coverage["limitations"]:
                self.assertIn(item, text)
            self.assertIn(coverage["engine"], text)
        return text, coverage

    def test_full_text_keeps_raw_cells_caption_and_limits(self):
        limits = ["pymupdf table finder; no docling", "원문 셀을 고치지 않음"]
        items = [figure(), table("table-1", [
            cell("Control", header=True, row=0, column=0), cell("7", header=False, row=0, column=1),
            cell("Treatment", header=None, row=1, column=0), cell("11", header=False, row=1, column=1),
        ])]
        store = EvidenceDouble(items, limitations=limits)
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store)
        text, coverage = self.consistent(result, 24000)
        self.assertFalse(coverage["truncated"])
        self.assertEqual(coverage["truncationCount"], 0)
        self.assertEqual(coverage["limitations"], limits)
        self.assertEqual(coverage["engine"], "pymupdf-native")
        self.assertIn("not a model tool call", text)
        self.assertIn("engine: pymupdf-native", text)
        for literal in ("Treatment", "11", "Control", "table-1", "fig-1", "Figure 1. Group illustration",
                        '"header":null', '"header":false', '"header":true', '"itemId":"fig-1"', '"paperId":"paper-1"'):
            self.assertIn(literal, text)
        self.assertNotIn("18", text)
        self.assertNotIn("render", [name for name, *_rest in store.calls])

    def test_truncation_count_names_the_omitted_item(self):
        items = [table("table-a", [cell("CELL_A_PAYLOAD")]),
                 table("table-b", [cell("CELL_B_PAYLOAD" + ("B" * 3000))])]
        store = EvidenceDouble(items, limitations=["short-limit"])
        found = None
        for budget in range(0, 20000, 100):
            result = blue.context_for_review(store.paper_id, store.file_hash, store=store, max_chars=budget)
            text, coverage = self.consistent(result, budget)
            if "CELL_B_PAYLOAD" in text:
                self.assertIn("CELL_A_PAYLOAD", text)
            if "CELL_A_PAYLOAD" in text and "CELL_B_PAYLOAD" not in text and coverage["limitationsInText"]:
                found = result
                break
        self.assertIsNotNone(found)
        self.assertEqual(found["coverage"]["omittedIds"], ["table-b"])
        self.assertEqual(found["coverage"]["truncationCount"], 1)
        self.assertTrue(found["coverage"]["truncated"])
        self.assertIn("table-b", found["text"])
        self.assertIn("short-limit", found["text"])

    def test_pagination_reads_every_page(self):
        store = EvidenceDouble([table("t0", [cell("PAGE0")]), table("t1", [cell("PAGE1")])], page_size=1)
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store)
        text, coverage = self.consistent(result, 24000)
        self.assertIn("PAGE0", text)
        self.assertIn("PAGE1", text)
        self.assertEqual(coverage["truncationCount"], 0)
        self.assertFalse(coverage["truncated"])
        offsets = [call[2] for call in store.calls if call[0] == "list"]
        self.assertEqual(offsets, [0, 1])

    def test_early_list_end_is_not_complete(self):
        store = EvidenceDouble([table("only", [cell("ONLY_CELL")])], total=3, counts={"tables": 3, "figures": 0})
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store)
        text, coverage = self.consistent(result, 24000)
        self.assertIn("ONLY_CELL", text)
        self.assertEqual(coverage["unlisted"], 2)
        self.assertEqual(coverage["countGap"], 2)
        self.assertEqual(coverage["listGap"], 2)
        self.assertEqual(coverage["truncationCount"], 2)
        self.assertEqual(coverage["omittedIds"], [])
        self.assertTrue(coverage["listIncomplete"])
        self.assertTrue(coverage["truncated"])

    def test_zero_budget_reports_every_item_without_leaking_cells(self):
        store = EvidenceDouble([table("a", [cell("HIDDEN_A")]), table("b", [cell("HIDDEN_B")])])
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store, max_chars=0)
        text, coverage = self.consistent(result, 0)
        self.assertEqual(text, "")
        self.assertEqual(coverage["truncationCount"], 2)
        self.assertEqual(sorted(coverage["omittedIds"]), ["a", "b"])
        self.assertFalse(coverage["limitationsInText"])
        self.assertTrue(coverage["truncated"])
        self.assertEqual(coverage["limitations"], ["pymupdf table finder; no docling"])

    def test_oversized_limitations_stay_out_of_text_and_in_coverage(self):
        huge = "LIMITATION_HUGE_" + ("q" * 8000)
        store = EvidenceDouble([table("kept", [cell("KEPT_CELL")])], limitations=[huge])
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store, max_chars=2500)
        text, coverage = self.consistent(result, 2500)
        self.assertIn("KEPT_CELL", text)
        self.assertNotIn("LIMITATION_HUGE_", text)
        self.assertEqual(coverage["limitations"], [huge])
        self.assertFalse(coverage["limitationsInText"])
        self.assertEqual(coverage["truncationCount"], 0)
        self.assertTrue(coverage["truncated"])

    def test_hash_mismatch_and_unknown_id_are_rejected(self):
        store = EvidenceDouble([table("secret", [cell("SECRET_CELL")])])
        with self.assertRaises(ValueError) as mismatch:
            blue.context_for_review(store.paper_id, OTHER, store=store)
        self.assertEqual(str(mismatch.exception), "paper_evidence_hash_mismatch")
        self.assertNotIn("SECRET_CELL", str(mismatch.exception))
        self.assertEqual([call[0] for call in store.calls], ["status"])
        store.calls.clear()
        with self.assertRaises(ValueError) as unknown:
            blue.context_for_review("missing-paper", store.file_hash, store=store)
        self.assertEqual(str(unknown.exception), "paper_evidence_unknown_id")
        self.assertNotIn("SECRET_CELL", str(unknown.exception))
        with self.assertRaises(ValueError) as bad:
            blue.context_for_review(store.paper_id, "AB" * 32, store=store)
        self.assertEqual(str(bad.exception), "paper_evidence_hash_invalid")
        self.assertFalse(any(call[0] == "list" for call in store.calls))

    def test_budget_type_is_rejected(self):
        store = EvidenceDouble([])
        for bad in (True, -1, 1.5):
            with self.assertRaises(ValueError) as caught:
                blue.context_for_review(store.paper_id, store.file_hash, store=store, max_chars=bad)
            self.assertEqual(str(caught.exception), "paper_evidence_budget_invalid")
        self.assertEqual(store.calls, [])

    def test_empty_document_is_complete(self):
        store = EvidenceDouble([], limitations=["no tables on the page"])
        result = blue.context_for_review(store.paper_id, store.file_hash, store=store)
        text, coverage = self.consistent(result, 24000)
        self.assertFalse(coverage["truncated"])
        self.assertEqual(coverage["truncationCount"], 0)
        self.assertIn("no tables on the page", text)
        self.assertIn("engine: pymupdf-native", text)

    def test_default_store_attribute_is_used(self):
        store = EvidenceDouble([table("from-default", [cell("DEFAULT_CELL")])])
        module = types.ModuleType("paper_evidence")
        module.default_store = store
        previous = sys.modules.get("paper_evidence")
        sys.modules["paper_evidence"] = module
        try:
            result = blue.context_for_review(store.paper_id, store.file_hash)
        finally:
            if previous is None:
                sys.modules.pop("paper_evidence", None)
            else:
                sys.modules["paper_evidence"] = previous
        self.assertIn("DEFAULT_CELL", result["text"])
        self.assertEqual(result["coverage"]["paperId"], store.paper_id)

    def test_helper_is_not_an_mcp_server(self):
        source = Path(blue.__file__).read_text(encoding="utf-8")
        self.assertNotIn("import mcp", source)
        self.assertNotIn("blue_service", source)


if __name__ == "__main__":
    unittest.main()

"""Evidence cache, SARIF export, and workspace triage cache. Stdlib unittest only."""
import hashlib
import inspect
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_evidence
import paper_evidence_cache as cache
import paper_mcp
import paper_mcp_workspace
import paper_sarif_export as sarif

ROOT = Path(__file__).resolve().parents[2]
OWNED = (
    "app/local/paper_evidence_cache.py",
    "app/local/paper_sarif_export.py",
    "app/local/paper_mcp_workspace.py",
)
SCHEMA_IDS = (
    "falsify.agent-cli.v1",
    "falsify.blue-defect-sensor.v1",
    "falsify.internal-consistency.v1",
    "falsify.blue-report.v1",
    "falsify.blue-report-finalize.v1",
    "falsify.quote-repair-pack.v1",
    "falsify.red-plan.v1",
    "falsify.red-gold-ledger.v1",
    "falsify.arena-round.v1",
    "falsify.harness-patch.v1",
    "falsify.evolution-lineage.v1",
    "falsify.benchmark-report.v1",
    "falsify.mcp-workspace-triage.v1",
)
ROLES = {"blue", "red", "arena", "cli"}
FILE_HASH = "ab" * 32


def _digest(label):
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _pdf(pages):
    doc = pymupdf.open()
    try:
        for lines in pages:
            page = doc.new_page(width=595, height=842)
            y = 72
            for line in lines:
                page.insert_text((72, y), line, fontsize=11)
                y += 18
        return doc.tobytes()
    finally:
        doc.close()


def _letters(index):
    index += 1
    chars = []
    while index:
        index, rem = divmod(index - 1, 26)
        chars.append(chr(65 + rem))
    return "".join(reversed(chars))


def _escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _cell_xml(ref, value):
    if isinstance(value, tuple) and value[0] == "inline":
        return f'<c r="{ref}" t="inlineStr"><is><t>{_escape(value[1])}</t></is></c>'
    return f'<c r="{ref}"><v>{_escape(value)}</v></c>'


def _sheet_xml(rows):
    body = []
    for row_index, row in enumerate(rows, start=1):
        cells = "".join(_cell_xml(f"{_letters(col)}{row_index}", value) for col, value in enumerate(row))
        body.append(f'<row r="{row_index}">{cells}</row>')
    return (
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(body)}</sheetData></worksheet>"
    )


def _xlsx(rows):
    sheet = _sheet_xml(rows)
    rels = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    workbook = (
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="cohort" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
    return buffer.getvalue()


def _notebook():
    return json.dumps({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"language_info": {"name": "python"}},
        "cells": [{
            "cell_type": "code",
            "execution_count": 1,
            "metadata": {},
            "source": "x = 1\n",
            "outputs": [],
        }],
    }).encode("utf-8")


def _link_dir(target, link):
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    if os.name != "nt":
        return False
    done = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
    return done.returncode == 0


def _cached_kinds(cache_dir):
    kinds = []
    for path in cache_dir.rglob("*.json"):
        envelope = json.loads(path.read_text(encoding="utf-8"))
        for signal in envelope["payload"]["signals"]:
            kinds.append(signal.get("kind"))
    return kinds


class EvidenceCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_key_is_order_independent_and_validated(self):
        supplements = [
            {"name": "b.txt", "sha256": "b" * 64},
            {"name": "a.txt", "sha256": "a" * 64},
        ]
        forward = cache.compute_cache_key("workspace-triage", FILE_HASH, supplements=supplements, options={"b": 1, "a": True})
        reverse = cache.compute_cache_key(
            "workspace-triage", FILE_HASH, supplements=list(reversed(supplements)), options={"a": True, "b": 1})
        self.assertEqual(forward, reverse)
        self.assertEqual(len(forward), 64)
        self.assertEqual(forward, forward.lower())
        changed = cache.compute_cache_key("workspace-triage", FILE_HASH, options={"a": False})
        self.assertNotEqual(forward, changed)
        for namespace, file_hash in (("Bad", FILE_HASH), ("ok", "A" * 64), ("", FILE_HASH), ("ok", "abc")):
            with self.assertRaisesRegex(ValueError, "cache_key_invalid"):
                cache.compute_cache_key(namespace, file_hash)

    def test_hit_miss_touch_and_get_or_compute(self):
        store = cache.EvidenceCache(self.root)
        key = _digest("round")
        self.assertIsNone(store.get(key))
        self.assertEqual(store.stats()["misses"], 1)
        calls = []

        def build():
            calls.append(1)
            return {"detail": "확인필요", "items": [1, {"subtype": "a"}]}

        payload, hit = store.get_or_compute(key, build)
        self.assertEqual(payload, {"detail": "확인필요", "items": [1, {"subtype": "a"}]})
        self.assertFalse(hit)
        path = self.root / key[:2] / f"{key}.json"
        self.assertTrue(path.is_file())
        os.utime(path, (1_000_000_000, 1_000_000_000))
        again, hit_again = store.get_or_compute(key, build)
        self.assertEqual(again, payload)
        self.assertTrue(hit_again)
        self.assertEqual(calls, [1])
        self.assertGreaterEqual(store.stats()["hits"], 1)
        self.assertGreater(path.stat().st_mtime, 1_000_000_000)
        stats = store.stats()
        self.assertEqual(set(stats), {"schema", "hits", "misses", "corruptEvictions", "entries", "totalBytes"})
        self.assertEqual(stats["schema"], cache.SCHEMA)
        self.assertNotIn(str(self.root), json.dumps(stats))
        self.assertEqual(stats["entries"], 1)
        self.assertGreater(stats["totalBytes"], 0)

    def test_corrupt_entries_are_evicted(self):
        store = cache.EvidenceCache(self.root)
        key = _digest("corrupt")
        path = self.root / key[:2] / f"{key}.json"
        path.parent.mkdir(parents=True)
        path.write_text("{", encoding="utf-8")
        self.assertIsNone(store.get(key))
        self.assertFalse(path.exists())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schema": cache.SCHEMA,
            "key": key,
            "payload": {"ok": 1},
            "payloadSha256": "0" * 64,
        }), encoding="utf-8")
        self.assertIsNone(store.get(key))
        self.assertFalse(path.exists())
        self.assertGreaterEqual(store.stats()["corruptEvictions"], 2)

    def test_red_keys_and_path_keys_are_rejected_before_write(self):
        store = cache.EvidenceCache(self.root)
        key = _digest("reject")
        for name in ("before", "after", "patch", "gold", "goldLedger", "why_hard", "candidateRationales", "plan"):
            with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
                store.put(key, {"nested": [{name: 1}]})
        for name in ("path", "paths", "filepath", "file_path", "cwd", "dir", "directory", "root", "workdir", "source_path"):
            with self.assertRaisesRegex(ValueError, "cache_path_leak"):
                store.put(key, {"meta": {name: "C:/secret"}})
        self.assertEqual(list(self.root.rglob("*.json")), [])
        self.assertEqual(store.put(key, {"note": "gold"}), {"note": "gold"})

    def test_lru_prunes_oldest_entries_and_bytes(self):
        store = cache.EvidenceCache(self.root / "count", max_entries=2)
        keys = [_digest("a"), _digest("b"), _digest("c")]
        store.put(keys[0], {"id": "a"})
        store.put(keys[1], {"id": "b"})
        os.utime(store._entry_path(keys[0]), (100, 100))
        os.utime(store._entry_path(keys[1]), (200, 200))
        store.put(keys[2], {"id": "c"})
        self.assertFalse(store._entry_path(keys[0]).exists())
        self.assertTrue(store._entry_path(keys[1]).exists())
        self.assertTrue(store._entry_path(keys[2]).exists())
        self.assertEqual(store.stats()["entries"], 2)
        wide = cache.EvidenceCache(self.root / "bytes", max_bytes=65536)
        blob = {"blob": "x" * 40000}
        wide.put(keys[0], blob)
        os.utime(wide._entry_path(keys[0]), (100, 100))
        wide.put(keys[1], blob)
        self.assertFalse(wide._entry_path(keys[0]).exists())
        self.assertTrue(wide._entry_path(keys[1]).exists())
        self.assertLessEqual(wide.stats()["totalBytes"], 65536)

    def test_limits_and_symlink_directory_are_rejected(self):
        for kwargs in ({"max_entries": True}, {"max_entries": 0}, {"max_entries": 4097},
                       {"max_bytes": True}, {"max_bytes": 65535}):
            with self.assertRaisesRegex(ValueError, "cache_limit_invalid"):
                cache.EvidenceCache(self.root / "limits", **kwargs)
        file_path = self.root / "not-a-dir"
        file_path.write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "cache_dir_invalid"):
            cache.EvidenceCache(file_path)
        target = self.root / "real"
        target.mkdir()
        link = self.root / "linked"
        if _link_dir(target, link):
            with self.assertRaisesRegex(ValueError, "cache_dir_invalid"):
                cache.EvidenceCache(link)
        else:
            self.assertTrue(target.is_dir())


class SarifExportTests(unittest.TestCase):
    def test_sensor_and_blue_report_map_to_sarif(self):
        sensor = sarif.export_sarif_report(
            {
                "schema": "falsify.agent-cli.v1",
                "scan": {"signals": [{
                    "kind": "consort_flow_mismatch",
                    "family": "D7",
                    "subtype": "participant-flow-mismatch",
                    "pageIndex": 2,
                    "excerpt": "x" * 300,
                    "detail": "flow mismatch",
                    "supplementName": r"C:\secret\flow.xlsx",
                    "quoteStatus": "normalized",
                }, {
                    "kind": "consort_flow_mismatch",
                    "detail": "same rule",
                    "pageIndex": 0,
                }]},
            },
            artifact_uri=r"C:\Users\secret\manuscript.pdf",
            tool_version="0.2.0",
        )
        self.assertEqual(sensor["$schema"], sarif.SARIF_SCHEMA_URL)
        self.assertEqual(sensor["version"], "2.1.0")
        results = sensor["runs"][0]["results"]
        self.assertEqual([item["level"] for item in results], ["warning", "warning"])
        self.assertEqual(results[0]["ruleId"], "consort_flow_mismatch")
        self.assertEqual(results[0]["message"]["text"], "flow mismatch")
        location = results[0]["locations"][0]["physicalLocation"]
        self.assertEqual(location["artifactLocation"]["uri"], "flow.xlsx")
        self.assertEqual(location["region"]["startLine"], 3)
        self.assertEqual(len(location["region"]["snippet"]["text"]), 220)
        self.assertEqual(results[0]["properties"]["family"], "D7")
        self.assertEqual(results[0]["properties"]["quoteStatus"], "normalized")
        self.assertEqual(len(sensor["runs"][0]["tool"]["driver"]["rules"]), 1)
        bare = sarif.export_sarif_report(
            {"signals": [{"kind": "layer0", "detail": "sensor"}]},
            artifact_uri="/Users/secret/manuscript.pdf",
        )
        bare_uri = bare["runs"][0]["results"][0]["locations"][0]["physicalLocation"]["artifactLocation"]["uri"]
        self.assertEqual(bare_uri, "manuscript.pdf")
        blob = json.dumps(sensor) + json.dumps(bare)
        self.assertNotIn("Users", blob)
        self.assertNotIn("secret", blob)
        self.assertNotIn("C:", blob)
        findings = sarif.export_sarif_report({
            "report": {"findings": [
                {"family": "D1", "decision": "defect", "verdictLabel": "아님", "rationale": "bad", "quote": "N = 1", "pageIndex": 0},
                {"family": "D2", "verdictLabel": "맞음", "summary": "matched", "pageIndex": 1, "supplementFile": "/Users/secret/table.csv"},
                {"category": "D3", "verdictLabel": "확인필요", "detail": "check", "pageIndex": 4},
            ]},
        })
        mapped = findings["runs"][0]["results"]
        self.assertEqual([item["level"] for item in mapped], ["error", "note", "warning"])
        self.assertEqual([item["ruleId"] for item in mapped], ["D1", "D2", "D3"])
        note_uri = mapped[1]["locations"][0]["physicalLocation"]["artifactLocation"]["uri"]
        self.assertEqual(note_uri, "table.csv")
        final = sarif.export_sarif_report({
            "finalReport": {"findings": [{"decision": "verified_clean", "quote": "kept", "verified_clean": True}]},
        })
        final_result = final["runs"][0]["results"][0]
        self.assertEqual(final_result["level"], "note")
        self.assertEqual(final_result["ruleId"], "falsify.blue.finding")
        self.assertEqual(final_result["locations"][0]["physicalLocation"]["region"]["startLine"], 1)
        sensor_direct = sarif.export_sarif_report({"sensor": {"signals": [{"kind": "direct", "detail": "from sensor"}]}})
        self.assertEqual(sensor_direct["runs"][0]["results"][0]["ruleId"], "direct")

    def test_red_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            sarif.export_sarif_report({"signals": [{"kind": "k"}], "goldLedger": {}})
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            sarif.export_sarif_report({"findings": [{"family": "D1", "plan": "hidden"}]})


class SchemaCatalogTests(unittest.TestCase):
    def test_catalog_lists_canonical_schemas(self):
        catalog = sarif.list_falsify_schemas()
        self.assertEqual(catalog["schema"], sarif.CATALOG_SCHEMA)
        self.assertGreaterEqual(catalog["count"], 12)
        self.assertEqual(catalog["count"], len(catalog["schemas"]))
        by_id = {item["schemaId"]: item for item in catalog["schemas"]}
        for schema_id in SCHEMA_IDS:
            self.assertIn(schema_id, by_id)
        for entry in catalog["schemas"]:
            self.assertIn(entry["role"], ROLES)
            self.assertTrue(entry["summary"])
            self.assertTrue(entry["cliProducer"])
            body = entry["jsonSchema"]
            self.assertEqual(body["type"], "object")
            self.assertIsInstance(body["required"], list)
            self.assertTrue(body["required"])
            self.assertIsInstance(body["properties"], dict)
        found = sarif.list_falsify_schemas("falsify.blue-report.v1")
        self.assertEqual(found["schemaId"], "falsify.blue-report.v1")
        self.assertNotIn("schemas", found)
        with self.assertRaisesRegex(ValueError, "schema_id_unknown"):
            sarif.list_falsify_schemas("falsify.missing.v1")
        with self.assertRaisesRegex(ValueError, "schema_id_unknown"):
            sarif.list_falsify_schemas(12)


class WorkspaceCacheTests(unittest.TestCase):
    def test_extensions_and_tool_flags(self):
        allowed = paper_mcp_workspace._supplement_extensions()
        for suffix in (".xlsx", ".ipynb", ".rmd", ".qmd", ".docx"):
            self.assertIn(suffix, allowed)
        self.assertEqual(paper_mcp_workspace._PRIORITY_WEIGHTS["D7"], 5)
        self.assertEqual(paper_mcp_workspace._PRIORITY_WEIGHTS["D5"], 3)
        self.assertEqual(paper_mcp_workspace._PRIORITY_WEIGHTS["D4-2"], 3)
        signature = inspect.signature(paper_mcp_workspace.triage_workspace)
        self.assertIs(signature.parameters["include_flow_triage"].default, True)
        self.assertIs(signature.parameters["include_internal_consistency"].default, True)
        self.assertIsNone(signature.parameters["cache_dir"].default)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "include_flow_triage"):
                paper_mcp_workspace.triage_workspace(root, include_flow_triage="yes")
            with self.assertRaisesRegex(ValueError, "include_internal_consistency"):
                paper_mcp_workspace.triage_workspace(root, include_internal_consistency=1)
            session = paper_mcp_workspace.WorkspaceSession(object(), root)
            server = paper_mcp.build_workspace_server(session)
            tool = server._tool_manager._tools["triage_workspace"].fn
            params = inspect.signature(tool).parameters
            self.assertIs(params["includeFlowTriage"].default, True)
            self.assertIs(params["includeInternalConsistency"].default, True)

    def test_pairs_xlsx_ipynb_rmd_and_qmd_without_answer_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "study.pdf").write_bytes(_pdf([["Study"]]))
            (root / "study.xlsx").write_bytes(_xlsx([[("inline", "N = 80")]]))
            (root / "study.ipynb").write_bytes(_notebook())
            (root / "study.rmd").write_text("notes\n", encoding="utf-8")
            (root / "study.qmd").write_text("notes\n", encoding="utf-8")
            (root / "study_gold.xlsx").write_bytes(b"secret-gold")
            (root / "notes.txt").write_text("plain\n", encoding="utf-8")
            scanned = paper_mcp_workspace.scan_workspace(root)
            entry = next(item for item in scanned["papers"] if item["name"] == "study.pdf")
            self.assertEqual(
                entry["pairedSupplementNames"],
                ["study.ipynb", "study.qmd", "study.rmd", "study.xlsx"],
            )
            masked = [item for item in scanned["papers"] if item["name"] == "study_gold.xlsx"]
            self.assertEqual(len(masked), 1)
            self.assertTrue(masked[0]["masked"])
            self.assertNotIn("study_gold.xlsx", entry["pairedSupplementNames"])
            self.assertNotIn(str(root), json.dumps(scanned))

    def test_triage_catches_imrad_and_xlsx_and_reuses_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            papers = root / "papers"
            papers.mkdir()
            (papers / "study.pdf").write_bytes(_pdf([
                ["Abstract", "N = 240.", "Mortality was 8.2% (p = 0.012)."],
                ["Methods", "The primary endpoint was assessed at 12 months.", "We used 5-fold cross-validation."],
                ["Results", "A total of N = 180 patients were randomized.",
                 "The primary endpoint at 6 months was reported.", "We used 10-fold cross-validation."],
            ]))
            (papers / "study.xlsx").write_bytes(_xlsx([[("inline", "N = 80")]]))
            (papers / "study.ipynb").write_bytes(_notebook())
            (papers / "study_gold.xlsx").write_bytes(b"secret-gold")
            cache_dir = root / "cache"
            store = paper_evidence.EvidenceStore(max_documents=4)
            first = paper_mcp_workspace.triage_workspace(
                papers, max_signals_per_paper=40, include_figure_forensics=False, recompute_raw=False,
                include_flow_triage=True, include_internal_consistency=True, cache_dir=cache_dir, store=store)
            second = paper_mcp_workspace.triage_workspace(
                papers, max_signals_per_paper=40, include_figure_forensics=False, recompute_raw=False,
                include_flow_triage=True, include_internal_consistency=True, cache_dir=cache_dir,
                store=paper_evidence.EvidenceStore(max_documents=4))
            ranked = {item["name"]: item for item in first["rankedPapers"]}
            self.assertEqual(set(ranked), {"study.pdf"})
            self.assertGreaterEqual(ranked["study.pdf"]["pairedSupplementCount"], 2)
            self.assertIn("D4-1", ranked["study.pdf"]["byFamily"])
            self.assertIn("D1", ranked["study.pdf"]["byFamily"])
            stable_keys = ("name", "totalSignals", "byFamily", "pairedSupplementCount", "priorityScore")
            stable = lambda result: [{key: item[key] for key in stable_keys} for item in result["rankedPapers"]]
            self.assertEqual(stable(first), stable(second))
            self.assertEqual(first["cacheStats"]["hits"], 0)
            self.assertGreaterEqual(first["cacheStats"]["misses"], 1)
            self.assertGreaterEqual(second["cacheStats"]["hits"], 1)
            self.assertEqual(set(second["cacheStats"]), {"schema", "hits", "misses", "corruptEvictions", "entries", "totalBytes"})
            kinds = _cached_kinds(cache_dir)
            self.assertIn("methods_results_protocol_drift", kinds, kinds)
            self.assertIn("cross_file_sample_size_mismatch", kinds, kinds)
            blob = json.dumps(first) + json.dumps(second)
            self.assertNotIn(str(root), blob)
            self.assertNotIn(str(cache_dir), blob)
            self.assertNotIn("study_gold.xlsx", blob)
            self.assertNotIn("secret-gold", blob)


class ComplexityTests(unittest.TestCase):
    def test_owned_production_functions_stay_within_ccn_15(self):
        script = ROOT / "tools" / "quality" / "python-functions.py"
        for rel in OWNED:
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=(ROOT / rel).read_bytes(),
                capture_output=True,
                check=True,
            )
            functions = json.loads(proc.stdout.decode("utf-8"))
            hot = [(item["id"], item["ccn"]) for item in functions if item["ccn"] > 15]
            self.assertEqual(hot, [])


if __name__ == "__main__":
    unittest.main()

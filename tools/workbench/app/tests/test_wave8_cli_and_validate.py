"""Wave 8 CLI gates: supplement quote checks, scan/red flags, and mcp-config roles."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
TESTS = ROOT / "app" / "tests"
for _folder in (str(LOCAL), str(TESTS)):
    if _folder not in sys.path:
        sys.path.insert(0, _folder)

import falsify_cli  # noqa: E402
from blue_report_validate import BlueReportError, validate_blue_report  # noqa: E402
from test_falsify_cli_and_skills import (  # noqa: E402
    _build_minimal_docx,
    _build_synthetic_paper_pdf,
    _run_cli,
)


def _one_page(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), text, fontsize=11)
    raw = doc.tobytes()
    doc.close()
    return raw


def _run_inprocess(*cli_args: str) -> tuple[int, dict]:
    captured = io.BytesIO()

    class _Stdout:
        buffer = captured

        def write(self, text):
            captured.write(text.encode("utf-8"))

        def flush(self):
            return None

    with patch.object(sys, "stdout", _Stdout()):
        code = falsify_cli.main(list(cli_args))
    return code, json.loads(captured.getvalue().decode("utf-8"))


def _raw_module(signals=None, error=None):
    module = types.ModuleType("paper_raw_dataset_audit")

    def audit_raw_datasets(page_items, supp_entries, max_signals=50):
        if error:
            raise ValueError(error)
        return {
            "schema": "falsify.raw-dataset-audit.v1",
            "signals": list(signals if signals is not None else [{"kind": "raw_recompute", "excerpt": "cohort"}]),
        }

    module.audit_raw_datasets = audit_raw_datasets
    return module


class SupplementQuoteGateTests(unittest.TestCase):
    def setUp(self):
        self.pdf = _one_page("Unrelated alpha sentence on the main page.")
        self.supplements = [
            {"name": "Table_S1.csv", "text": "cohort,auc\nmain,0.81\n"},
            {"name": "notes.md", "text": "Methods note alpha.\nSecond methods line beta.\nplatelet cohort zeta 812\n"},
            {"name": "metrics.json", "text": '{"metric":"specificity","value":0.77}\n'},
            {"name": "notes.docx", "bytes": _build_minimal_docx("Supplementary cohort remained blinded.")},
        ]

    def _report(self, findings):
        return {"schema": "falsify.blue-report.v1", "findings": findings}

    def _quote(self, quote, **extra):
        return validate_blue_report(
            self.pdf,
            self._report([{"id": "q1", "verdictLabel": "아님", "quote": quote, **extra}]),
            supplements=self.supplements,
        )["quoteCheck"]["quotes"][0]

    def test_exact_quotes_in_csv_md_json_and_docx(self):
        csv_row = self._quote("main,0.81")
        self.assertEqual(csv_row["status"], "exact")
        self.assertEqual(csv_row["source"], "supplement")
        self.assertEqual(csv_row["supplementName"], "Table_S1.csv")
        self.assertEqual(csv_row["lineNumber"], 2)
        self.assertIsNone(csv_row["pageIndex"])
        self.assertIsNone(csv_row["bbox"])
        self.assertEqual(csv_row["nearestCandidates"], [])

        spaced = self._quote("main 0.81")
        self.assertEqual(spaced["status"], "exact")
        self.assertEqual(spaced["supplementName"], "Table_S1.csv")
        self.assertEqual(spaced["lineNumber"], 2)

        tabbed = self._quote("main\t0.81")
        self.assertEqual(tabbed["status"], "exact")
        self.assertEqual(tabbed["lineNumber"], 2)

        markdown = self._quote("Methods note alpha. Second methods line beta.")
        self.assertEqual(markdown["status"], "exact")
        self.assertEqual(markdown["supplementName"], "notes.md")
        self.assertEqual(markdown["lineNumber"], 1)

        metrics = self._quote('{"metric":"specificity","value":0.77}')
        self.assertEqual(metrics["status"], "exact")
        self.assertEqual(metrics["supplementName"], "metrics.json")

        docx = self._quote("Supplementary cohort remained blinded.")
        self.assertEqual(docx["status"], "exact")
        self.assertEqual(docx["supplementName"], "notes.docx")
        self.assertEqual(docx["lineNumber"], 1)

    def test_named_supplement_is_searched_before_the_pdf(self):
        shared = "Unrelated alpha sentence on the main page."
        supplements = [{"name": "first.md", "text": shared + "\n"}, *self.supplements]
        out = validate_blue_report(
            self.pdf,
            self._report([{"id": "named", "verdictLabel": "아님", "quote": shared, "supplementName": "first.md"}]),
            supplements=supplements,
        )
        record = out["quoteCheck"]["quotes"][0]
        self.assertEqual(record["status"], "exact")
        self.assertEqual(record["source"], "supplement")
        self.assertEqual(record["supplementName"], "first.md")
        self.assertNotIn("source", validate_blue_report(
            self.pdf, self._report([{"id": "pdf", "verdictLabel": "아님", "quote": shared}]),
        )["quoteCheck"]["quotes"][0])

    def test_missing_quote_ranks_supplement_candidates(self):
        record = self._quote("platelet cohort zeta 999")
        self.assertEqual(record["status"], "missing")
        self.assertTrue(record["nearestCandidates"])
        supplement_hits = [item for item in record["nearestCandidates"] if item.get("supplementName")]
        self.assertTrue(supplement_hits)
        top = supplement_hits[0]
        self.assertEqual(top["supplementName"], "notes.md")
        self.assertEqual(top["lineNumber"], 3)
        self.assertIsNone(top["pageIndex"])
        self.assertIsNone(top["bbox"])
        self.assertIn("platelet cohort zeta", top["text"])

    def test_forbidden_red_key_and_ledger_schema_exit_three(self):
        with self.assertRaises(BlueReportError) as leaked:
            validate_blue_report(
                self.pdf, self._report([]),
                supplements=[{"name": "leaked.json", "text": json.dumps({"gold": "secret"})}],
            )
        self.assertEqual(leaked.exception.code, "forbidden_red_key")
        self.assertEqual(leaked.exception.exit_code, 3)
        self.assertTrue(leaked.exception.extra["leaks"])

        with self.assertRaises(BlueReportError) as ledger:
            validate_blue_report(
                self.pdf, self._report([]),
                supplements=[{"name": "ledger.json", "schema": "falsify.red-gold-ledger.v1", "text": "{}"}],
            )
        self.assertEqual(ledger.exception.exit_code, 3)
        self.assertEqual(ledger.exception.code, "forbidden_red_key")

    def test_markdown_prose_may_mention_gold(self):
        out = validate_blue_report(
            self.pdf,
            self._report([{"id": "ok", "verdictLabel": "아님", "quote": "The gold standard is stable here."}]),
            supplements=[{"name": "notes.md", "text": "The gold standard is stable here.\n"}],
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["quoteCheck"]["quotes"][0]["source"], "supplement")


class BlueValidateCliTests(unittest.TestCase):
    def test_supplement_quote_missing_quote_and_red_key(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "paper.pdf"
            pdf_path.write_bytes(raw)
            csv_path = tmp_dir / "Table_S1.csv"
            csv_path.write_text("cohort,auc\nzeta-only,0.12\n", encoding="utf-8")
            report_path = tmp_dir / "report.json"
            report_path.write_text(json.dumps({
                "findings": [{
                    "id": "s1",
                    "verdictLabel": "아님",
                    "family": "D1",
                    "quote": "zeta-only 0.12",
                    "supplementName": "Table_S1.csv",
                }],
            }), encoding="utf-8")

            code, payload, _ = _run_cli(
                "blue", "validate", "--pdf", str(pdf_path),
                "--report", str(report_path), "--supplement", str(csv_path),
            )
            self.assertEqual(code, 0, payload)
            self.assertTrue(payload["ok"])
            quote = payload["quoteCheck"]["quotes"][0]
            self.assertEqual(quote["status"], "exact")
            self.assertEqual(quote["source"], "supplement")
            self.assertEqual(quote["supplementName"], "Table_S1.csv")
            self.assertEqual(quote["lineNumber"], 2)

            missing_path = tmp_dir / "missing.json"
            missing_path.write_text(json.dumps({
                "findings": [{"id": "m1", "verdictLabel": "아님", "quote": "platelet cohort zeta 999"}],
            }), encoding="utf-8")
            miss_code, miss_payload, _ = _run_cli(
                "blue", "validate", "--pdf", str(pdf_path),
                "--report", str(missing_path), "--supplement", str(csv_path),
            )
            self.assertEqual(miss_code, 3)
            self.assertEqual(miss_payload["error"], "quote_not_found")

            leaked = tmp_dir / "leaked.json"
            leaked.write_text(json.dumps({"gold": "secret", "accuracy": 0.2}), encoding="utf-8")
            leak_code, leak_payload, _ = _run_cli(
                "blue", "validate", "--pdf", str(pdf_path),
                "--report", str(report_path), "--supplement", str(leaked),
            )
            self.assertEqual(leak_code, 3)
            self.assertEqual(leak_payload["error"], "forbidden_red_key")


class BlueScanFlagTests(unittest.TestCase):
    def test_figure_forensics_flag_is_optional(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "paper.pdf"
            pdf_path.write_bytes(raw)
            off_code, off_payload, _ = _run_cli("blue", "scan", "--pdf", str(pdf_path))
            self.assertEqual(off_code, 0, off_payload)
            self.assertNotIn("figureForensics", off_payload["sensor"])

            on_code, on_payload, _ = _run_cli(
                "blue", "scan", "--pdf", str(pdf_path), "--figure-forensics",
            )
            self.assertEqual(on_code, 0, on_payload)
            self.assertTrue(on_payload["sensor"]["figureForensics"]["enabled"])

    def test_recompute_raw_unavailable_mocked_and_digest(self):
        raw = _one_page("We enrolled N = 50 patients in the randomized cohort.")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "paper.pdf"
            pdf_path.write_bytes(raw)
            csv_path = tmp_dir / "Table_S1.csv"
            csv_path.write_text(
                "subject_id,group,outcome\n1,treat,10\n2,treat,12\n3,ctrl,8\n4,ctrl,9\n",
                encoding="utf-8",
            )

            live_code, live_payload, _ = _run_cli(
                "blue", "scan", "--pdf", str(pdf_path),
                "--supplement", str(csv_path), "--recompute-raw",
            )
            self.assertEqual(live_code, 0, live_payload)
            self.assertEqual(live_payload["rawDatasetAudit"]["schema"], "falsify.raw-dataset-audit.v1")
            self.assertTrue(
                any(s["kind"] == "raw_dataset_n_mismatch" for s in live_payload["rawDatasetAudit"]["signals"]),
                live_payload["rawDatasetAudit"],
            )

            with patch.dict(sys.modules, {"paper_raw_dataset_audit": None}):
                missing_code, missing_payload = _run_inprocess(
                    "blue", "scan", "--pdf", str(pdf_path),
                    "--supplement", str(csv_path), "--recompute-raw",
                )
            self.assertEqual(missing_code, 2)
            self.assertEqual(missing_payload["error"], "raw_dataset_audit_unavailable")

            with patch.dict(sys.modules, {"paper_raw_dataset_audit": _raw_module()}):
                ok_code, ok_payload = _run_inprocess(
                    "blue", "scan", "--pdf", str(pdf_path),
                    "--supplement", str(csv_path), "--recompute-raw",
                )
            self.assertEqual(ok_code, 0, ok_payload)
            self.assertEqual(ok_payload["rawDatasetAudit"]["signals"][0]["kind"], "raw_recompute")

            bulky = [{"kind": "raw_recompute", "excerpt": "x" * 400, "detail": "y" * 400} for _ in range(40)]
            with patch.dict(sys.modules, {"paper_raw_dataset_audit": _raw_module(signals=bulky)}):
                digest_code, digest_payload = _run_inprocess(
                    "blue", "scan", "--pdf", str(pdf_path),
                    "--supplement", str(csv_path), "--recompute-raw", "--digest-only",
                )
            self.assertEqual(digest_code, 0, digest_payload)
            self.assertLessEqual(len(digest_payload["rawDatasetAudit"]["signals"]), 25)
            self.assertLessEqual(len(digest_payload["rawDatasetAudit"]["signals"][0]["excerpt"]), 120)

            with patch.dict(sys.modules, {"paper_raw_dataset_audit": _raw_module(error="forbidden_red_key")}):
                leak_code, leak_payload = _run_inprocess(
                    "blue", "scan", "--pdf", str(pdf_path),
                    "--supplement", str(csv_path), "--recompute-raw",
                )
            self.assertEqual(leak_code, 3)
            self.assertEqual(leak_payload["error"], "forbidden_red_key")


class RedGateCliTests(unittest.TestCase):
    def _pdf(self, tmp_dir: Path) -> Path:
        pdf_path = tmp_dir / "paper.pdf"
        pdf_path.write_bytes(_build_synthetic_paper_pdf())
        return pdf_path

    def test_red_simulate_and_trace(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = self._pdf(tmp_dir)
            csv_path = tmp_dir / "Table_S1.csv"
            csv_path.write_text("cohort,auc\nmain,0.94\n", encoding="utf-8")
            _code, targets, _ = _run_cli("red", "targets", "--pdf", str(pdf_path))
            link = targets["links"][0]
            ops = [{
                "id": "op-uri",
                "kind": "uri-link",
                "linkId": link["linkId"],
                "pageIndex": link["pageIndex"],
                "annotIndex": link["annotIndex"],
                "beforeUri": link["uri"],
                "afterUri": "https://doi.org/10.1000/beta-hijack",
                "family": "D2",
                "difficulty": "L1",
            }]
            sim_code, sim_payload, _ = _run_cli(
                "red", "simulate", "--pdf", str(pdf_path),
                "--ops", json.dumps(ops), "--supplement", str(csv_path),
            )
            self.assertEqual(sim_code, 0, sim_payload)
            self.assertEqual(sim_payload["command"], "red simulate")
            result = sim_payload["detectability"]["results"][0]
            self.assertEqual(result["operationId"], "op-uri")
            self.assertEqual(result["crossInferenceDistance"], "L1")

            trace_code, trace_payload, _ = _run_cli(
                "red", "trace", "--pdf", str(pdf_path),
                "--claim", "0.94", "--supplement", str(csv_path),
            )
            self.assertEqual(trace_code, 0, trace_payload)
            self.assertEqual(trace_payload["command"], "red trace")
            self.assertGreaterEqual(trace_payload["propagation"]["occurrenceCount"], 1)

    def test_min_difficulty_blocks_l1_and_allows_l3_l4(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = self._pdf(tmp_dir)
            _code, targets, _ = _run_cli("red", "targets", "--pdf", str(pdf_path))
            link = targets["links"][0]
            blocked_pdf = tmp_dir / "blocked.pdf"
            blocked_gold = tmp_dir / "blocked.json"
            l1_ops = [{
                "id": "op-uri",
                "kind": "uri-link",
                "linkId": link["linkId"],
                "pageIndex": link["pageIndex"],
                "annotIndex": link["annotIndex"],
                "beforeUri": link["uri"],
                "afterUri": "https://doi.org/10.1000/beta-hijack",
                "family": "D2",
            }]
            block_code, block_payload, _ = _run_cli(
                "red", "apply", "--pdf", str(pdf_path),
                "--ops", json.dumps(l1_ops),
                "--out-pdf", str(blocked_pdf),
                "--out-gold", str(blocked_gold),
                "--min-difficulty", "L3",
            )
            self.assertEqual(block_code, 3, block_payload)
            self.assertEqual(block_payload["error"], "difficulty_below_minimum")
            self.assertEqual(block_payload["minDifficulty"], "L3")
            self.assertTrue(block_payload["belowMinimum"])
            self.assertEqual(block_payload["belowMinimum"][0]["crossInferenceDistance"], "L1")
            self.assertIn("detectability", block_payload)
            self.assertFalse(blocked_pdf.exists())
            self.assertFalse(blocked_gold.exists())

            allowed_pdf = tmp_dir / "allowed.pdf"
            allowed_gold = tmp_dir / "allowed.json"
            l4_ops = [{
                "id": "op-d3",
                "kind": "text-span",
                "pageIndex": 1,
                "before": "stable",
                "after": "steady",
                "family": "D3",
                "difficulty": "L4",
            }]
            allow_code, allow_payload, _ = _run_cli(
                "red", "apply", "--pdf", str(pdf_path),
                "--ops", json.dumps(l4_ops),
                "--out-pdf", str(allowed_pdf),
                "--out-gold", str(allowed_gold),
                "--min-difficulty", "L3",
            )
            self.assertEqual(allow_code, 0, allow_payload)
            self.assertTrue(allowed_pdf.is_file())
            self.assertTrue(allowed_gold.is_file())
            self.assertEqual(allow_payload["detectability"]["results"][0]["crossInferenceDistance"], "L4")
            self.assertEqual(allow_payload["goldLedger"]["schema"], "falsify.red-gold-ledger.v1")

            l3_pdf = tmp_dir / "l3.pdf"
            l3_ops = [{
                "id": "op-uri-l3",
                "kind": "uri-link",
                "linkId": link["linkId"],
                "pageIndex": link["pageIndex"],
                "annotIndex": link["annotIndex"],
                "beforeUri": link["uri"],
                "afterUri": "https://dx.doi.org/10.1000/alpha-one",
                "family": "D2",
            }]
            l3_code, l3_payload, _ = _run_cli(
                "red", "apply", "--pdf", str(pdf_path),
                "--ops", json.dumps(l3_ops),
                "--out-pdf", str(l3_pdf),
                "--min-difficulty", "L3",
            )
            self.assertEqual(l3_code, 0, l3_payload)
            self.assertTrue(l3_pdf.is_file())
            self.assertIn(
                l3_payload["detectability"]["results"][0]["crossInferenceDistance"],
                {"L3", "L4"},
            )


class McpConfigRoleTests(unittest.TestCase):
    def test_workspace_roles_and_selection_errors(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "paper.pdf"
            pdf_path.write_bytes(raw)
            workspace = tmp_dir / "papers"
            workspace.mkdir()

            alone_code, alone_payload, _ = _run_cli("mcp-config", "--workspace", str(workspace))
            self.assertEqual(alone_code, 0, alone_payload)
            alone_args = alone_payload["servers"]["falsify-paper-evidence"]["args"]
            self.assertNotIn("--pdf", alone_args)
            self.assertEqual(alone_args[alone_args.index("--workspace") + 1], str(workspace.resolve()))
            self.assertEqual(list(alone_payload["servers"]), ["falsify-paper-evidence"])

            legacy_code, legacy_payload, _ = _run_cli(
                "mcp-config", "--pdf", str(pdf_path), "--workspace", str(workspace),
            )
            self.assertEqual(legacy_code, 0, legacy_payload)
            legacy_args = legacy_payload["servers"]["falsify-paper-evidence"]["args"]
            self.assertEqual(legacy_args[legacy_args.index("--workspace") + 1], str(workspace.resolve()))

            none_code, none_payload, _ = _run_cli("mcp-config")
            self.assertEqual(none_code, 2)
            self.assertEqual(none_payload["error"], "invalid_arguments")
            self.assertIn("exactly one", none_payload["message"])

            missing_dir = tmp_dir / "missing-dir"
            dir_code, dir_payload, _ = _run_cli("mcp-config", "--workspace", str(missing_dir))
            self.assertEqual(dir_code, 2)
            self.assertEqual(dir_payload["error"], "file_not_found")

            red_ws_code, red_ws_payload, _ = _run_cli(
                "mcp-config", "--role", "red", "--workspace", str(workspace),
            )
            self.assertEqual(red_ws_code, 2)
            self.assertEqual(red_ws_payload["error"], "invalid_arguments")
            self.assertIn("paper_red_mcp.py", red_ws_payload["message"])

            both_flags_code, both_flags_payload, _ = _run_cli(
                "mcp-config", "--role", "red", "--pdf", str(pdf_path), "--workspace", str(workspace),
            )
            self.assertEqual(both_flags_code, 2)
            self.assertEqual(both_flags_payload["error"], "invalid_arguments")

            red_code, red_payload, _ = _run_cli("mcp-config", "--role", "red", "--pdf", str(pdf_path))
            self.assertEqual(red_code, 0, red_payload)
            self.assertEqual(list(red_payload["servers"]), ["falsify-paper-red"])
            red_args = red_payload["servers"]["falsify-paper-red"]["args"]
            self.assertEqual(Path(red_args[0]).name, "paper_red_mcp.py")
            self.assertEqual(red_args[1:3], ["--pdf", str(pdf_path.resolve())])
            self.assertIn("falsify-paper-red", red_payload["usage"]["claude"])
            self.assertIn("falsify-paper-red", red_payload["usage"]["codex"])
            self.assertIn("falsify-paper-red", red_payload["usage"]["gemini"])

            both_code, both_payload, _ = _run_cli("mcp-config", "--role", "both", "--pdf", str(pdf_path))
            self.assertEqual(both_code, 0, both_payload)
            self.assertEqual(
                set(both_payload["servers"]),
                {"falsify-paper-evidence", "falsify-paper-red"},
            )
            evidence_args = both_payload["servers"]["falsify-paper-evidence"]["args"]
            red_both_args = both_payload["servers"]["falsify-paper-red"]["args"]
            self.assertEqual(Path(evidence_args[0]).name, "paper_mcp.py")
            self.assertEqual(evidence_args[1:3], ["--pdf", str(pdf_path.resolve())])
            self.assertEqual(red_both_args[1:3], ["--pdf", str(pdf_path.resolve())])
            for client in ("claude", "codex", "gemini"):
                self.assertIn("falsify-paper-evidence", both_payload["usage"][client])
                self.assertIn("falsify-paper-red", both_payload["usage"][client])

            ws_both_code, ws_both_payload, _ = _run_cli(
                "mcp-config", "--role", "both", "--workspace", str(workspace),
            )
            self.assertEqual(ws_both_code, 0, ws_both_payload)
            self.assertEqual(list(ws_both_payload["servers"]), ["falsify-paper-evidence"])
            self.assertIn(
                "falsify-paper-red skipped because --workspace mode is read-only BLUE only",
                ws_both_payload["warnings"],
            )


class ArenaEvolutionCliTests(unittest.TestCase):
    def test_arena_benchmark_sensor_and_regression_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            out_path = tmp_dir / "bench.json"
            code, payload, _ = _run_cli(
                "arena", "benchmark", "--mode", "sensor",
                "--case", "gold-w2-d2-uri-hijack", "--case", "holdout-benign-multivariable-aor",
                "--out", str(out_path),
            )
            self.assertEqual(code, 0, payload)
            self.assertTrue(payload["ok"])
            bench = payload["benchmark"]
            self.assertEqual(bench["schema"], "falsify.benchmark-report.v1")
            self.assertEqual(bench["goldSummary"]["recall"], 1.0)
            self.assertEqual(bench["holdoutSummary"]["totalPureFp"], 0)

            strict_baseline = tmp_dir / "baseline.json"
            strict_baseline.write_text(json.dumps({
                "schema": "falsify.benchmark-report.v1",
                "goldSummary": {"recall": 1.0},
                "holdoutSummary": {"totalPureFp": -1},
            }), encoding="utf-8")
            reg_code, reg_payload, _ = _run_cli(
                "arena", "benchmark", "--mode", "sensor",
                "--case", "holdout-benign-multivariable-aor",
                "--baseline-report", str(strict_baseline),
            )
            self.assertEqual(reg_code, 3, reg_payload)
            self.assertEqual(reg_payload["error"], "benchmark_regression_detected")

    def test_arena_duel_and_apply_patch_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src_pdf = tmp_dir / "source.pdf"
            src_pdf.write_bytes(_one_page("Mortality stayed stable across both study arms."))
            red_py = tmp_dir / "red_agent.py"
            red_py.write_text(
                "import json, pathlib, sys\n"
                "req = json.loads(sys.stdin.buffer.read().decode('utf-8'))\n"
                "cwd = pathlib.Path.cwd()\n"
                "(cwd / req['outPdf']).write_bytes((cwd / req['sourcePdf']).read_bytes())\n"
                "(cwd / req['outGold']).write_text(json.dumps({"
                "'schema': 'falsify.red-gold-ledger.v1', 'defects': [{"
                "'defectId': 'g1', 'world': 'W1', 'family': 'D1', 'difficulty': 'L2', "
                "'pageIndex': 0, 'after': 'Mortality stayed stable across both study arms.', "
                "'stealthPass': True}]}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            blue_py = tmp_dir / "blue_agent.py"
            blue_py.write_text(
                "import json\n"
                "print(json.dumps({'schema': 'falsify.blue-report.v1', 'findings': [{"
                "'id': 'b1', 'decision': 'defect', 'pageIndex': 0, "
                "'quote': 'Mortality stayed stable across both study arms.'}]}))\n",
                encoding="utf-8",
            )
            duel_out = tmp_dir / "duel.json"
            duel_code, duel_payload, _ = _run_cli(
                "arena", "duel",
                "--source-pdf", str(src_pdf),
                "--red-cmd", sys.executable, "--red-arg", str(red_py),
                "--blue-cmd", sys.executable, "--blue-arg", str(blue_py),
                "--out", str(duel_out),
            )
            self.assertEqual(duel_code, 0, duel_payload)
            self.assertEqual(duel_payload["duel"]["schema"], "falsify.arena-duel.v1")
            patch_path = tmp_dir / "patch.json"
            patch_path.write_text(json.dumps(duel_payload["duel"]["harnessPatch"]), encoding="utf-8")
            harness_path = tmp_dir / "harness.json"
            harness_path.write_text(json.dumps({
                "schema": "falsify.harness.v1",
                "id": "blue-base",
                "role": "blue",
                "instructions": "Verify every claim against the supplied blind bundle.",
                "generation": 0,
            }), encoding="utf-8")

            promo_code, promo_payload, _ = _run_cli(
                "arena", "apply-patch",
                "--harness", str(harness_path), "--patch", str(patch_path),
                "--baseline-holdout-fp", "0", "--candidate-holdout-fp", "0",
            )
            self.assertEqual(promo_code, 0, promo_payload)
            self.assertEqual(promo_payload["promotion"]["generation"], 1)

            rollback_code, rollback_payload, _ = _run_cli(
                "arena", "apply-patch",
                "--harness", str(harness_path), "--patch", str(patch_path),
                "--baseline-holdout-fp", "0", "--candidate-holdout-fp", "1",
            )
            self.assertEqual(rollback_code, 3, rollback_payload)
            self.assertEqual(rollback_payload["error"], "holdout_fp_regression")


if __name__ == "__main__":
    unittest.main()

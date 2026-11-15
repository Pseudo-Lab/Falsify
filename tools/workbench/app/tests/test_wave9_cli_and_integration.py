"""Wave 9 end-to-end CLI, MCP, RED/BLUE supplement bundle, and Benchmark v2 tests."""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import pymupdf

_HERE = Path(__file__).resolve()
_APP_LOCAL = _HERE.parents[1] / "local"
_EVAL_DIR = _HERE.parents[2] / "tools" / "evaluation"
for _p in (str(_APP_LOCAL), str(_EVAL_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import falsify_cli  # noqa: E402
import paper_mcp  # noqa: E402
import paper_mcp_bundle  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402

RED_AGENT_SCRIPT = """import json, pathlib, sys
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
root = pathlib.Path.cwd()
raw = (root / payload["sourcePdf"]).read_bytes()
(root / payload["outPdf"]).write_bytes(raw)
gold = {
    "schema": "falsify.red-gold-ledger.v1",
    "defects": [{
        "defectId": "g-w9",
        "world": "W1",
        "family": "D1",
        "difficulty": "L3",
        "pageIndex": 0,
        "after": "Mortality stayed stable across both study arms.",
        "stealthPass": True,
    }],
}
(root / payload["outGold"]).write_text(json.dumps(gold), encoding="utf-8")
"""

BLUE_AGENT_SCRIPT = """import json
print(json.dumps({
    "schema": "falsify.blue-report.v1",
    "findings": [{
        "id": "f-w9",
        "decision": "defect",
        "pageIndex": 0,
        "quote": "Mortality stayed stable across both study arms.",
    }],
}))
"""


def _run_cli(argv: list[str]) -> tuple[int, dict]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = falsify_cli.main(argv)
    return code, json.loads(buf.getvalue())


_NOTO_TTF = _HERE.parents[1] / "dist" / "recomposition-vendor" / "NotoSans-Regular.ttf"


def _make_pdf(
    pages: list[list[str]],
    *,
    title: str = "Clinical Trial Report",
    use_ttf: bool = False,
) -> bytes:
    doc = pymupdf.open()
    try:
        embed_ttf = use_ttf and _NOTO_TTF.is_file()
        for lines in pages:
            page = doc.new_page(width=595, height=842)
            if embed_ttf:
                page.insert_font(fontname="noto", fontfile=str(_NOTO_TTF))
            y = 72
            for line in lines:
                page.insert_text((72, y), line, fontname="noto" if embed_ttf else "helv", fontsize=10)
                y += 22
        doc.set_metadata({"title": title, "author": "Study Group"})
        return doc.tobytes()
    finally:
        doc.close()


class Wave9CliAndIntegrationTests(unittest.TestCase):
    def test_blue_scan_flow_triage_and_code_audit_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "flow_code.pdf"
            pdf.write_bytes(_make_pdf([[
                "Mortality was 22% in Treatment vs 11% in Control.",
                "Treatment decreased mortality compared with Control.",
                "Of 200 screened patients, 40 were excluded before randomization and 150 were randomized.",
                "Methods: All p-values are two-sided across all enrolled participants (N = 150).",
            ]]))
            script = root / "analysis.py"
            script.write_text(
                "from scipy.stats import ttest_ind\n"
                "res = ttest_ind(arm_a, arm_b, alternative='greater')\n",
                encoding="utf-8",
            )
            code, payload = _run_cli([
                "blue", "scan",
                "--pdf", str(pdf),
                "--supplement", str(script),
                "--flow-triage",
                "--audit-code",
                "--digest-only",
            ])
            self.assertEqual(code, 0)
            self.assertTrue(payload["ok"])
            triage = payload["sensor"].get("flowAndSpinTriage")
            self.assertIsInstance(triage, dict)
            self.assertGreaterEqual(len(triage.get("triageHints") or []), 1)
            flow_kinds = {s.get("kind") for s in payload["sensor"].get("signals") or []}
            self.assertIn("consort_flow_mismatch", flow_kinds)
            code_audit = payload.get("codeAudit")
            self.assertIsInstance(code_audit, dict)
            code_kinds = {s.get("kind") for s in code_audit.get("signals") or []}
            self.assertIn("code_tailness_mismatch", code_kinds)
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.assertLess(len(encoded), 12 * 1024)

    def test_blue_scan_workspace_ranks_and_masks_answer_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "workspace"
            ws.mkdir()
            (ws / "clean_study.pdf").write_bytes(_make_pdf([[
                "Randomized trial with consistent numbers: 10 / 40 (25.0%) in control.",
            ]]))
            (ws / "trial_defect.pdf").write_bytes(_make_pdf([[
                "Results: In trial_defect.csv we enrolled N = 99 participants in total.",
                "Primary endpoint event rate was 10 / 40 (45.0%) with p = 0.01.",
            ]]))
            (ws / "trial_defect.csv").write_text(
                "id,group,outcome\n1,A,1\n2,A,0\n3,B,1\n4,B,0\n",
                encoding="utf-8",
            )
            (ws / "answer_key.pdf").write_bytes(_make_pdf([["SECRET GOLD ANSWER KEY"]]))
            (ws / "gold_ledger.json").write_text('{"secret": true}\n', encoding="utf-8")

            code, payload = _run_cli(["blue", "scan-workspace", "--workspace", str(ws)])
            self.assertEqual(code, 0)
            triage = payload["triage"]
            self.assertEqual(triage["maskedCount"], 2)
            ranked = triage["rankedPapers"]
            self.assertEqual(len(ranked), 2)
            self.assertEqual(ranked[0]["name"], "trial_defect.pdf")
            self.assertGreater(ranked[0]["totalSignals"], ranked[1]["totalSignals"])
            serialized = json.dumps(payload, ensure_ascii=False)
            self.assertNotIn(str(ws), serialized)
            self.assertNotIn("answer_key.pdf", serialized)

    def test_blue_validate_ligature_folding_and_repair_pack(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "ligature.pdf"
            pdf.write_bytes(_make_pdf([[
                "The primary endpoint\u00a0reached \u201cstatistical signi\u00adficance\u201d across arms 1\u20132.",
            ]], use_ttf=True))
            supp = root / "notes.txt"
            supp.write_text("Supplement note: \ufb01nancial bene\ufb01t remained stable.\n", encoding="utf-8")
            ok_report = root / "ok_report.json"
            ok_report.write_text(json.dumps({
                "findings": [
                    {
                        "id": "f-1",
                        "page": 1,
                        "verdict": "아님",
                        "quote": 'The primary endpoint reached "statistical significance" across arms 1-2.',
                    },
                    {
                        "id": "f-2",
                        "verdict": "아님",
                        "quote": "Supplement note: financial benefit remained stable.",
                    },
                ],
            }), encoding="utf-8")
            code_ok, res_ok = _run_cli([
                "blue", "validate",
                "--pdf", str(pdf),
                "--supplement", str(supp),
                "--report", str(ok_report),
            ])
            self.assertEqual(code_ok, 0)
            self.assertTrue(res_ok["ok"])

            bad_report = root / "bad_report.json"
            bad_report.write_text(json.dumps({
                "findings": [{
                    "id": "f-bad",
                    "page": 1,
                    "verdict": "아님",
                    "quote": "The primary endpoint reached clinical cure across arms 9-10.",
                }],
            }), encoding="utf-8")
            code_bad, res_bad = _run_cli([
                "blue", "validate",
                "--pdf", str(pdf),
                "--report", str(bad_report),
                "--emit-repair-pack",
            ])
            self.assertEqual(code_bad, 3)
            self.assertIn("repairPack", res_bad)
            pack = res_bad["repairPack"]
            self.assertEqual(pack["schema"], "falsify.blue-repair-pack.v1")
            self.assertEqual(len(pack["items"]), 1)
            self.assertGreaterEqual(len(pack["items"][0]["nearestCandidates"]), 1)
            self.assertIn("downgrade_verdictLabel_to_확인필요", pack["items"][0]["allowedActions"])

    def test_red_plan_and_apply_with_blind_supplement_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "study.pdf"
            pdf.write_bytes(_make_pdf([
                [
                    "Abstract: Mean systolic reduction was 14.2 mmHg across arms.",
                    "See supplement results.csv for arm-level summary metrics.",
                ],
                [
                    "Results: Detailed follow-up confirmed mean systolic reduction of 14.2 mmHg.",
                ],
            ]))
            supp_dir = root / "in_supp"
            supp_dir.mkdir()
            supp_csv = supp_dir / "results.csv"
            original_csv = "metric,value\nsystolic_reduction,14.2\n"
            supp_csv.write_text(original_csv, encoding="utf-8")

            code_plan, plan_payload = _run_cli([
                "red", "plan",
                "--pdf", str(pdf),
                "--supplement", str(supp_csv),
                "--target-difficulty", "L3",
                "--claim", "14.2",
            ])
            self.assertEqual(code_plan, 0)
            self.assertEqual(plan_payload["plan"]["schema"], "falsify.red-mutation-plan.v1")
            self.assertGreaterEqual(plan_payload["plan"]["bundleCount"], 1)

            ops = [
                {
                    "id": "op-supp",
                    "kind": "supplement-edit",
                    "name": "results.csv",
                    "before": "14.2",
                    "after": "18.6",
                    "world": "W4",
                    "family": "D6",
                    "difficulty": "L3",
                },
            ]
            ops_file = root / "ops.json"
            ops_file.write_text(json.dumps(ops), encoding="utf-8")
            out_pdf = root / "blind" / "study_blind.pdf"
            out_gold = root / "gold" / "gold.json"
            out_supp = root / "blind_supp"

            bad_code, bad_res = _run_cli([
                "red", "apply",
                "--pdf", str(pdf),
                "--supplement", str(supp_csv),
                "--ops", str(ops_file),
                "--out-pdf", str(out_pdf),
                "--out-supplement-dir", str(supp_dir),
            ])
            self.assertEqual(bad_code, 2)
            self.assertEqual(bad_res["error"], "cannot_overwrite_source")

            code_apply, apply_res = _run_cli([
                "red", "apply",
                "--pdf", str(pdf),
                "--supplement", str(supp_csv),
                "--ops", str(ops_file),
                "--out-pdf", str(out_pdf),
                "--out-gold", str(out_gold),
                "--out-supplement-dir", str(out_supp),
            ])
            self.assertEqual(code_apply, 0)
            self.assertEqual(supp_csv.read_text(encoding="utf-8"), original_csv)
            blind_csv = out_supp / "results.csv"
            self.assertTrue(blind_csv.is_file())
            self.assertIn("18.6", blind_csv.read_text(encoding="utf-8"))

            code_blind, blind_res = _run_cli([
                "blind", "verify",
                "--pdf", str(out_pdf),
                "--source-pdf", str(pdf),
                "--supplement", str(blind_csv),
            ])
            self.assertEqual(code_blind, 0)
            self.assertTrue(blind_res["clean"])

    def test_mcp_config_both_and_paper_mcp_code_audit_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "paper.pdf"
            pdf.write_bytes(_make_pdf([[
                "Methods: All tests were two-sided across N = 50 enrolled subjects.",
            ]]))
            script = root / "pipeline.py"
            script.write_text(
                "from scipy.stats import ttest_ind\n"
                "ttest_ind(a, b, alternative='less')\n",
                encoding="utf-8",
            )
            code, cfg = _run_cli([
                "mcp-config",
                "--pdf", str(pdf),
                "--supplement", str(script),
                "--role", "both",
            ])
            self.assertEqual(code, 0)
            blue_args = cfg["servers"]["falsify-paper-evidence"]["args"]
            red_args = cfg["servers"]["falsify-paper-red"]["args"]
            self.assertIn("--supplement", blue_args)
            self.assertIn("--supplement", red_args)

            store = EvidenceStore()
            summary = paper_mcp.open_selected(store, str(pdf))
            supps = paper_mcp_bundle.load_selected_supplements([str(script)])
            server = paper_mcp.build_server(
                store,
                summary["paperId"],
                summary["fileHash"],
                supplements=supps,
            )
            tool = server._tool_manager._tools["audit_code_supplements"]
            self.assertTrue(tool.annotations.readOnlyHint)
            call_res = tool.fn(paperId=summary["paperId"])
            audit_res = json.loads(call_res.content[0].text)
            self.assertEqual(audit_res["schema"], "falsify.code-supplement-audit.v1")
            self.assertGreaterEqual(audit_res["signalCount"], 1)

    def test_arena_score_matches_raw_dataset_and_code_audit_signals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "combo.pdf"
            pdf.write_bytes(_make_pdf([[
                "In cohort.csv we analyzed all enrolled subjects (N = 80) with two-sided tests.",
            ]]))
            csv_path = root / "cohort.csv"
            csv_path.write_text("id,arm,score\n1,A,10\n2,A,12\n3,B,15\n4,B,16\n", encoding="utf-8")
            py_path = root / "run.py"
            py_path.write_text(
                "from scipy.stats import ttest_ind\n"
                "ttest_ind(x, y, alternative='greater')\n",
                encoding="utf-8",
            )
            scan_json = root / "scan.json"
            code_scan, _ = _run_cli([
                "blue", "scan",
                "--pdf", str(pdf),
                "--supplement", str(csv_path), str(py_path),
                "--recompute-raw",
                "--audit-code",
                "--out", str(scan_json),
            ])
            self.assertEqual(code_scan, 0)

            gold_json = root / "gold.json"
            gold_json.write_text(json.dumps({
                "schema": "falsify.red-gold-ledger.v1",
                "defects": [
                    {
                        "defectId": "d-raw",
                        "world": "W4",
                        "family": "D6",
                        "difficulty": "L3",
                        "name": "cohort.csv",
                        "after": "N = 80",
                    },
                    {
                        "defectId": "d-code",
                        "world": "W4",
                        "family": "D4",
                        "difficulty": "L3",
                        "name": "run.py",
                        "after": "alternative='greater'",
                    },
                ],
            }), encoding="utf-8")
            code_score, score_res = _run_cli([
                "arena", "score", "--gold", str(gold_json), "--blue", str(scan_json),
            ])
            self.assertEqual(code_score, 0)
            run_entry = score_res["runs"][0]
            self.assertEqual(run_entry["recall"], 1.0)

    def test_arena_evolve_and_benchmark_v2_post_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_pdf = root / "source.pdf"
            src_pdf.write_bytes(_make_pdf([[
                "Mortality stayed stable across both study arms.",
            ]]))
            red_py = root / "red_agent.py"
            red_py.write_text(RED_AGENT_SCRIPT, encoding="utf-8")
            blue_py = root / "blue_agent.py"
            blue_py.write_text(BLUE_AGENT_SCRIPT, encoding="utf-8")
            out_lineage = root / "lineage.json"
            out_harness = root / "final_harness.json"

            code_ev, ev_res = _run_cli([
                "arena", "evolve",
                "--source-pdf", str(src_pdf),
                "--red-cmd", sys.executable,
                "--red-arg", str(red_py),
                "--blue-cmd", sys.executable,
                "--blue-arg", str(blue_py),
                "--generations", "2",
                "--min-difficulty", "L3",
                "--out", str(out_lineage),
                "--out-harness", str(out_harness),
            ])
            self.assertEqual(code_ev, 0)
            lineage = ev_res["lineage"]
            self.assertEqual(lineage["schema"], "falsify.evolution-lineage.v1")
            self.assertTrue(lineage["answerKeyFree"])
            self.assertTrue(lineage["scrubbed"])
            self.assertEqual(len(lineage["generations"]), 3)
            self.assertTrue(out_harness.is_file())

            code_bench, bench_res = _run_cli(["arena", "benchmark", "--mode", "sensor"])
            self.assertEqual(code_bench, 0)
            bench = bench_res["benchmark"]
            self.assertEqual(bench["corpusVersion"], "v3")
            self.assertEqual(bench["caseCount"], 24)
            self.assertEqual(bench["goldSummary"]["caseCount"], 14)
            self.assertEqual(bench["holdoutSummary"]["caseCount"], 10)
            self.assertEqual(bench["goldSummary"]["layer0Recall"], 1.0)
            self.assertEqual(bench["holdoutSummary"]["totalPureFp"], 0)


if __name__ == "__main__":
    unittest.main()

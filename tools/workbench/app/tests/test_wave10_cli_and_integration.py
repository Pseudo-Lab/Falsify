"""End-to-end Orchestrator seam tests for Wave 10 (Agent-First 5th Round).

Covers CLI, MCP, and Arena integration across:
- .xlsx + .ipynb + .rmd/.qmd supplement loading, blindness verification, raw recompute, and code audit
- IMRaD internal consistency audit via falsify_cli (`--internal-consistency`), `paper_blue_sensor`, and `paper_mcp`
- One-shot `falsify blue finalize` (quote repair + Zero-Drop + auto-downgrade to 확인필요 + 12-column CSV)
- `falsify red plan --red-brief` closed-loop family/surface prioritization
- `falsify arena apply-patch --compact-rules` and `falsify arena evolve --role both --compact-rules`
- `falsify arena benchmark` Corpus v3 (24 cases: 14 Gold + 10 Benign-Trap Holdout)
"""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

import pymupdf

_HERE = Path(__file__).resolve()
_LOCAL = _HERE.parents[1] / "local"
_EVAL = _HERE.parents[2] / "tools" / "evaluation"
for _p in (str(_LOCAL), str(_EVAL)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import falsify_cli  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402
import paper_mcp  # noqa: E402


def _run_cli(argv: list[str]) -> tuple[int, dict]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = falsify_cli.main(argv)
    raw = buf.getvalue().strip()
    return code, json.loads(raw)


def _make_imrad_pdf(path: Path) -> bytes:
    doc = pymupdf.open()
    try:
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text(
            (54, 72),
            "Abstract\n"
            "We enrolled N = 120 adults in a randomized trial. Primary endpoint was 28-day mortality.\n"
            "Mean biomarker level in the treatment arm was 15.0 (n = 3). Control arm mean was 10.0 (n = 3).\n\n"
            "Methods\n"
            "Participants: A total of N = 120 patients were randomized without exclusions (p < 0.05 two-sided).\n"
            "Primary endpoint was 28-day mortality assessed at day 28.\n",
            fontsize=11,
        )
        p1 = doc.new_page(width=595, height=842)
        p1.insert_text(
            (54, 72),
            "Results\n"
            "In total, N = 95 participants completed the study and were analyzed.\n"
            "Primary outcome was 90-day readmission rate, which improved (p = 0.04).\n"
            "See Supplementary Data S1 (cohort.xlsx) and analysis.ipynb.\n"
            "Table 1 reports treatment mean 15.0 and control mean 10.0.\n",
            fontsize=11,
        )
        raw = doc.tobytes()
    finally:
        doc.close()
    path.write_bytes(raw)
    return raw


def _make_xlsx(path: Path, *, leak_red: bool = False) -> bytes:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '</Relationships>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
        'Target="sharedStrings.xml"/>'
        '</Relationships>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Cohort" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>'
    )
    extra = " gold_ledger answer_key" if leak_red else ""
    shared = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">'
        '<si><t>arm</t></si>'
        '<si><t>biomarker</t></si>'
        f'<si><t>treatment{extra}</t></si>'
        '<si><t>control</t></si>'
        '</sst>'
    )
    # Treatment values: 10, 12, 14 -> actual AVERAGE is 12.0, but cached <v> claims 15.0!
    sheet1 = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>'
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row>'
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>12</v></c></row>'
        '<row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4"><v>14</v></c></row>'
        '<row r="5"><c r="A5" t="s"><v>3</v></c><c r="B5"><v>10</v></c></row>'
        '<row r="6"><c r="A6" t="s"><v>3</v></c><c r="B6"><v>10</v></c></row>'
        '<row r="7"><c r="A7" t="s"><v>3</v></c><c r="B7"><v>10</v></c></row>'
        '<row r="8"><c r="A8" t="inlineStr"><is><t>MeanTreatment</t></is></c>'
        '<c r="B8"><f>AVERAGE(B2:B4)</f><v>15.0</v></c></row>'
        '</sheetData>'
        '</worksheet>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/sharedStrings.xml", shared)
        zf.writestr("xl/worksheets/sheet1.xml", sheet1)
    raw = buf.getvalue()
    path.write_bytes(raw)
    return raw


def _make_ipynb(path: Path, *, leak_red: bool = False) -> bytes:
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": ({"gold": {"secret": True}} if leak_red else {"kernelspec": {"name": "python3"}}),
        "cells": [
            {
                "cell_type": "code",
                "execution_count": 5,
                "metadata": {},
                "source": [
                    "import pandas as pd\n",
                    "df = pd.read_excel('cohort.xlsx')\n",
                    "df = df[df['biomarker'] > 11]\n",
                ],
                "outputs": [],
            },
            {
                "cell_type": "code",
                "execution_count": 2,
                "metadata": {},
                "source": [
                    "from scipy.stats import ttest_ind\n",
                    "ttest_ind(df['biomarker'], [10, 10, 10], alternative='greater')\n",
                ],
                "outputs": [
                    {"output_type": "stream", "name": "stdout", "text": ["filtered mean = 13.0, p = 0.041\n"]}
                ],
            },
        ],
    }
    raw = json.dumps(nb, indent=2).encode("utf-8")
    path.write_bytes(raw)
    return raw


class Wave10CliAndIntegrationTests(unittest.TestCase):
    def test_blue_scan_xlsx_ipynb_and_internal_consistency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "paper.pdf"
            xlsx = root / "cohort.xlsx"
            ipynb = root / "analysis.ipynb"
            _make_imrad_pdf(pdf)
            _make_xlsx(xlsx)
            _make_ipynb(ipynb)

            code, payload = _run_cli([
                "blue", "scan",
                "--pdf", str(pdf),
                "--supplement", str(xlsx), str(ipynb),
                "--internal-consistency",
                "--recompute-raw",
                "--audit-code",
            ])
            self.assertEqual(code, 0)
            self.assertTrue(payload["ok"])
            sensor = payload["sensor"]
            self.assertIn("internalConsistency", sensor)
            ic = sensor["internalConsistency"]
            self.assertEqual(ic["schema"], "falsify.internal-consistency.v1")
            self.assertGreaterEqual(ic["signalCount"] + ic["hintCount"], 1)
            # Triage hints must never be promoted into top-level Layer 0 signals
            for sig in sensor["signals"]:
                self.assertNotIn(sig.get("kind"), ("endpoint_drift_hint", "exclusion_unaccounted_hint"))

            raw_audit = payload["rawDatasetAudit"]
            raw_kinds = {s.get("kind") for s in raw_audit.get("signals", [])}
            self.assertIn("xlsx_formula_value_mismatch", raw_kinds)

            code_audit = payload["codeAudit"]
            code_kinds = {s.get("kind") for s in code_audit.get("signals", [])}
            self.assertTrue(
                code_kinds & {
                    "notebook_out_of_order_execution",
                    "unlogged_row_exclusion",
                    "code_undisclosed_row_filter",
                    "code_tailness_mismatch",
                    "sidedness_mismatch",
                },
                f"Expected notebook/code audit signals, got {code_kinds}",
            )

            # Digest-only must stay strictly under 12 KB
            d_code, digest = _run_cli([
                "blue", "scan",
                "--pdf", str(pdf),
                "--supplement", str(xlsx), str(ipynb),
                "--internal-consistency",
                "--recompute-raw",
                "--audit-code",
                "--digest-only",
            ])
            self.assertEqual(d_code, 0)
            encoded = json.dumps(digest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.assertLess(len(encoded), 12 * 1024)

    def test_blind_verify_xlsx_and_ipynb_clean_vs_leaked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "blind.pdf"
            clean_xlsx = root / "clean.xlsx"
            clean_ipynb = root / "clean.ipynb"
            dirty_xlsx = root / "dirty.xlsx"
            dirty_ipynb = root / "dirty.ipynb"
            _make_imrad_pdf(pdf)
            _make_xlsx(clean_xlsx, leak_red=False)
            _make_ipynb(clean_ipynb, leak_red=False)
            _make_xlsx(dirty_xlsx, leak_red=True)
            _make_ipynb(dirty_ipynb, leak_red=True)

            code_ok, res_ok = _run_cli([
                "blind", "verify",
                "--pdf", str(pdf),
                "--supplement", str(clean_xlsx), str(clean_ipynb),
            ])
            self.assertEqual(code_ok, 0)
            self.assertTrue(res_ok["clean"])

            code_x, res_x = _run_cli([
                "blind", "verify",
                "--pdf", str(pdf),
                "--supplement", str(dirty_xlsx),
            ])
            self.assertEqual(code_x, 3)
            self.assertFalse(res_x["clean"])

            code_n, res_n = _run_cli([
                "blind", "verify",
                "--pdf", str(pdf),
                "--supplement", str(dirty_ipynb),
            ])
            self.assertEqual(code_n, 3)
            self.assertFalse(res_n["clean"])

    def test_blue_finalize_repairs_restores_downgrades_and_passes_validate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "paper.pdf"
            xlsx = root / "cohort.xlsx"
            ipynb = root / "analysis.ipynb"
            _make_imrad_pdf(pdf)
            _make_xlsx(xlsx)
            _make_ipynb(ipynb)

            report_path = root / "draft_report.json"
            repairs_path = root / "repairs.json"
            ledger_path = root / "candidates.json"
            final_report_path = root / "final_report.json"
            csv_path = root / "final.csv"
            out_path = root / "finalize_out.json"

            draft_report = {
                "schema": "falsify.blue-report.v1",
                "findings": [
                    {
                        "id": "F-1",
                        "reportNumber": "1",
                        "verdictLabel": "아님",
                        "family": "D1",
                        "pageIndex": 0,
                        "location": "Abstract / Results",
                        "quote": "We enrolled N = 9999 adults in a non-existent quote.",
                        "rationale": "Sample size dropped from 120 to 95 without explanation.",
                    },
                    {
                        "id": "F-2",
                        "reportNumber": "2",
                        "verdictLabel": "아님",
                        "family": "D3",
                        "pageIndex": 1,
                        "location": "Results",
                        "quote": "Completely hallucinated sentence that has no repair.",
                        "rationale": "Unverified claim.",
                    },
                    {
                        "id": "F-3",
                        "reportNumber": "3",
                        "verdictLabel": "아님",
                        "family": "D1",
                        "supplementName": "analysis.ipynb",
                        "location": "analysis.ipynb cell 1",
                        "quote": "df = df[df['biomarker'] > 11]",
                        "rationale": "Unlogged post-hoc row filter in notebook.",
                    },
                ],
            }
            repairs = {
                "repairs": [
                    {
                        "findingId": "F-1",
                        "quote": "We enrolled N = 120 adults in a randomized trial.",
                        "pageIndex": 0,
                    }
                ]
            }
            ledger = {
                "entries": [
                    {
                        "candidateId": "C-DROP-1",
                        "pageIndex": 1,
                        "location": "Results p.2",
                        "quote": "In total, N = 95 participants completed the study and were analyzed.",
                        "rationale": "Zero-Drop candidate from Layer 0.",
                    }
                ]
            }
            report_path.write_text(json.dumps(draft_report), encoding="utf-8")
            repairs_path.write_text(json.dumps(repairs), encoding="utf-8")
            ledger_path.write_text(json.dumps(ledger), encoding="utf-8")

            f_code, f_res = _run_cli([
                "blue", "finalize",
                "--pdf", str(pdf),
                "--report", str(report_path),
                "--repairs", str(repairs_path),
                "--ledger", str(ledger_path),
                "--supplement", str(xlsx), str(ipynb),
                "--out-report", str(final_report_path),
                "--csv", str(csv_path),
                "--out", str(out_path),
            ])
            self.assertEqual(f_code, 0)
            self.assertTrue(f_res["ok"])
            self.assertEqual(f_res["appliedRepairCount"], 1)
            self.assertGreaterEqual(f_res["autoDowngradedCount"], 1)
            self.assertEqual(f_res["quoteCheck"]["missingCount"], 0)
            self.assertTrue(final_report_path.is_file())
            self.assertTrue(csv_path.is_file())

            # Finalized report MUST pass strict `blue validate` with exit_code == 0!
            v_code, v_res = _run_cli([
                "blue", "validate",
                "--pdf", str(pdf),
                "--report", str(final_report_path),
                "--supplement", str(xlsx), str(ipynb),
            ])
            self.assertEqual(v_code, 0, msg=json.dumps(v_res, ensure_ascii=False))
            self.assertEqual(v_res["quoteCheck"]["missingCount"], 0)

    def test_red_plan_with_red_brief_and_leak_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "paper.pdf"
            _make_imrad_pdf(pdf)
            brief_path = root / "brief.json"
            brief_path.write_text(
                json.dumps({
                    "underTestedFamilies": ["D3", "D1"],
                    "preferredSurfaces": ["prose"],
                }),
                encoding="utf-8",
            )
            code, payload = _run_cli([
                "red", "plan",
                "--pdf", str(pdf),
                "--target-difficulty", "L2",
                "--red-brief", str(brief_path),
            ])
            self.assertEqual(code, 0)
            self.assertEqual(payload["plan"]["schema"], "falsify.red-mutation-plan.v1")

            bad_brief = root / "bad_brief.json"
            bad_brief.write_text(json.dumps({"gold": [{"secret": 1}]}), encoding="utf-8")
            bad_code, bad_payload = _run_cli([
                "red", "plan",
                "--pdf", str(pdf),
                "--red-brief", str(bad_brief),
            ])
            self.assertEqual(bad_code, 3)
            self.assertEqual(bad_payload["error"], "forbidden_red_key")

    def test_arena_apply_patch_compact_and_evolve_role_both(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            harness_path = root / "harness.json"
            patch_path = root / "patch.json"
            harness_path.write_text(
                json.dumps({
                    "schema": "falsify.harness.v1",
                    "id": "harness-blue",
                    "role": "blue",
                    "generation": 0,
                    "instructions": "Verify every statistical claim.",
                    "appliedRuleIds": ["rule-old"],
                    "appliedPatches": [],
                    "accumulatedRules": [
                        {
                            "ruleId": "rule-old",
                            "failureClass": "missed",
                            "family": "D1",
                            "surface": "TABLE",
                            "priority": 1,
                            "statement": "Recompute table row sums from source cells.",
                            "procedure": ["Sum all rows from the source table."],
                            "rationale": "Repeated arithmetic misses require explicit recomputation.",
                        }
                    ],
                }),
                encoding="utf-8",
            )
            patch_path.write_text(
                json.dumps({
                    "schema": "falsify.harness-patch.v1",
                    "patchId": "patch-rule-new",
                    "scrubbed": True,
                    "answerKeyFree": True,
                    "summary": {"axes": {}},
                    "rules": [
                        {
                            "ruleId": "rule-new",
                            "failureClass": "missed",
                            "family": "D1",
                            "surface": "TABLE",
                            "priority": 3,
                            "statement": "Cross-check prose and table totals across sections.",
                            "procedure": ["Sum rows and compare against prose totals."],
                            "rationale": "Higher-priority cross-surface arithmetic rule.",
                        }
                    ],
                }),
                encoding="utf-8",
            )
            ap_code, ap_res = _run_cli([
                "arena", "apply-patch",
                "--harness", str(harness_path),
                "--patch", str(patch_path),
                "--role", "blue",
                "--compact-rules",
            ])
            self.assertEqual(ap_code, 0, msg=json.dumps(ap_res, ensure_ascii=False))
            promoted_rules = ap_res["promotion"]["harness"]["accumulatedRules"]
            self.assertEqual(len(promoted_rules), 1)
            self.assertTrue(promoted_rules[0]["ruleId"].startswith("cr-"))
            self.assertIn("Cross-check prose and table totals", promoted_rules[0]["statement"])

            # Test `arena evolve --role both --compact-rules` with synthetic RED & BLUE agent scripts
            src_pdf = root / "src.pdf"
            _make_imrad_pdf(src_pdf)
            red_agent = root / "red_agent.py"
            blue_agent = root / "blue_agent.py"
            red_agent.write_text(
                "import json, pathlib, sys\n"
                "payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))\n"
                "cwd = pathlib.Path.cwd()\n"
                "raw = (cwd / payload['sourcePdf']).read_bytes()\n"
                "(cwd / payload['outPdf']).write_bytes(raw)\n"
                "gold = {\n"
                "  'schema': 'falsify.red-gold-ledger.v1',\n"
                "  'defects': [{\n"
                "    'defectId': 'G-1', 'world': 'W2', 'family': 'D3', 'difficulty': 'L3',\n"
                "    'pageIndex': 0, 'stealthPass': True,\n"
                "    'after': 'We enrolled N = 120 adults in a randomized trial.'\n"
                "  }]\n"
                "}\n"
                "(cwd / payload['outGold']).write_text(json.dumps(gold), encoding='utf-8')\n",
                encoding="utf-8",
            )
            blue_agent.write_text(
                "import json\n"
                "print(json.dumps({\n"
                "  'schema': 'falsify.blue-report.v1',\n"
                "  'findings': [{\n"
                "    'id': 'f-1', 'decision': 'defect', 'pageIndex': 0,\n"
                "    'quote': 'We enrolled N = 120 adults in a randomized trial.'\n"
                "  }]\n"
                "}))\n",
                encoding="utf-8",
            )
            out_json = root / "lineage.json"
            out_blue_h = root / "final_blue.json"
            out_red_h = root / "final_red.json"
            ev_code, ev_res = _run_cli([
                "arena", "evolve",
                "--source-pdf", str(src_pdf),
                "--role", "both",
                "--generations", "2",
                "--min-difficulty", "L3",
                "--compact-rules",
                "--red-cmd", sys.executable,
                "--red-arg", str(red_agent),
                "--blue-cmd", sys.executable,
                "--blue-arg", str(blue_agent),
                "--out", str(out_json),
                "--out-harness", str(out_blue_h),
                "--out-red-harness", str(out_red_h),
            ])
            self.assertEqual(ev_code, 0, msg=json.dumps(ev_res, ensure_ascii=False))
            lineage = ev_res["lineage"]
            self.assertEqual(lineage["role"], "both")
            self.assertIn("finalBlueHarness", lineage)
            self.assertIn("finalRedHarness", lineage)
            self.assertTrue(out_blue_h.is_file())
            self.assertTrue(out_red_h.is_file())

    def test_arena_benchmark_v3_24_cases(self):
        code, payload = _run_cli(["arena", "benchmark", "--mode", "sensor"])
        self.assertEqual(code, 0)
        bench = payload["benchmark"]
        self.assertEqual(bench["corpusVersion"], "v4")
        self.assertEqual(bench["caseCount"], 32)
        self.assertEqual(len(bench["caseResults"]), 32)
        self.assertEqual(bench["holdoutSummary"]["totalPureFp"], 0)
        self.assertEqual(bench["goldSummary"]["layer0Recall"], 1.0)
        self.assertGreater(bench["goldSummary"]["recall"], 0.75)

    def test_mcp_internal_consistency_and_sensor_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "paper.pdf"
            _make_imrad_pdf(pdf)
            store = EvidenceStore()
            summary = paper_mcp.open_selected(store, pdf)
            server = paper_mcp.build_server(store, summary["paperId"], summary["fileHash"])
            tools = server._tool_manager._tools
            self.assertIn("audit_internal_consistency", tools)

            ic_res = tools["audit_internal_consistency"].fn(paperId=summary["paperId"], maxSignals=20)
            self.assertFalse(ic_res.isError)
            self.assertEqual(ic_res.structuredContent["schema"], "falsify.internal-consistency.v1")

            sensor_res = tools["run_blue_sensor"].fn(
                paperId=summary["paperId"],
                includeInternalConsistency=True,
                digestOnly=True,
            )
            self.assertFalse(sensor_res.isError)
            self.assertIn("internalConsistency", sensor_res.structuredContent)


if __name__ == "__main__":
    unittest.main()

"""Finalize gate, workbook/notebook quotes, and Wave 10 skill contracts."""
from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import blue_report_validate as mod  # noqa: E402

_FONT_CANDIDATES = (
    Path(r"C:\Windows\Fonts\segoeui.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    Path("/Library/Fonts/Arial Unicode.ttf"),
)
FONT = next((path for path in _FONT_CANDIDATES if path.is_file()), _FONT_CANDIDATES[0])

EXACT_QUOTE = "Results: AUC = 0.94 across N = 200 patients."
TYPO_LINE = "range 1\u20133 and 4\u20145 holds"
TYPO_QUOTE = "range 1-3 and 4-5 holds"
MISSING_DEFECT = "Hallucinated defect quote never present anywhere."
MISSING_OK = "Hallucinated resolution quote never present anywhere."
MISSING_LEDGER = "Hallucinated ledger quote never present anywhere."
XLSX_SENTENCE = "Cohort size stayed at 200 patients."
XLSX_FORMULA = "=SUM(A2:A3)"
XLSX_CACHED = "cached-value-fifteen"
XLSX_DASH_LINE = "range 1\u20133 holds in the sheet"
XLSX_DASH_QUOTE = "range 1-3 holds in the sheet"
XLSX_NOTES = "Secondary endpoint remained stable."
NOTEBOOK_MD = "Notebook claim alpha stayed exact."
NOTEBOOK_CODE = "code cell beta marker"
NOTEBOOK_OUT = "output gamma marker stayed"
NOTEBOOK_PLAIN = "plain table zeta marker"
QMD_LINE = "Quarto source claim stayed verbatim."
RMD_LINE = "Rmarkdown source claim stayed verbatim."
PATH_LINE = "Path sheet claim eta stayed verbatim."

_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

_SKILL_PHRASES = {
    "falsify-blue-auditor": (
        "Wave 10",
        ".xlsx",
        ".ipynb",
        ".Rmd",
        ".qmd",
        "<f>",
        "<v>",
        "audit_internal_consistency",
        "--internal-consistency",
        "signals",
        "triageHints",
        "evidence_blue_v040",
        "--emit-repair-pack",
        "blue finalize",
        "finalize_blue_report",
        "falsify.blue-report.v1",
        "12-column",
    ),
    "falsify-red-injector": (
        "Wave 10",
        "chart-shape",
        "bar",
        "scatter",
        "curve",
        "plan_coordinated_mutation",
        "3-surface",
        "prose + figure + table/supplement",
        "L3",
        "simulate_red_detectability",
        "redBrief",
        "adversarial_red_v03",
    ),
    "falsify-arena-operator": (
        "Wave 10",
        "falsify arena run-round",
        "falsify arena score",
        "verify_blind_bundle",
        "Krippendorff",
        "AURC",
        "falsify arena distill",
        "falsify.harness-patch.v1",
        "distill_scrub_failed",
        "compact_harness_rules",
        "falsify arena duel",
        "falsify arena apply-patch",
        "MAX_GENERATIONS_CAP",
        "holdout_fp_regression",
        "falsify arena evolve",
        "blue|red|both",
        "blindness_leak_detected",
        "falsify.evolution-lineage.v1",
        "Pareto",
        "falsify arena benchmark",
        "v3",
        "24-case",
        "--baseline",
    ),
}


def _report(findings, **extra) -> dict:
    return {
        "schema": "falsify.blue-report.v1",
        "paperId": "pid-finalize",
        "findings": list(findings),
        **extra,
    }


def _plain_pdf(lines: tuple[str, ...]) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for index, line in enumerate(lines):
        page.insert_text((72, 74 + index * 28), line, fontsize=11)
    raw = doc.tobytes()
    doc.close()
    return raw


def _font_pdf(lines: tuple[str, ...]) -> bytes:
    if not FONT.is_file():
        raise unittest.SkipTest(f"missing font {FONT}")
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="body", fontfile=str(FONT))
    for index, line in enumerate(lines):
        page.insert_text((72, 72 + index * 22), line, fontname="body", fontsize=11)
    raw = doc.tobytes()
    doc.close()
    return raw


def _zip_xlsx(parts: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in parts.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def _cohort_xlsx() -> bytes:
    workbook = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">
  <sheets>
    <sheet name="Cohort" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"""
    rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{_NS_PKG}">
  <Relationship Id="rId1" Type="{_NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="{_NS_REL}/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"""
    shared = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="{_NS_MAIN}">
  <si><t>{XLSX_SENTENCE}</t></si>
  <si><r><t>Secondary endpoint </t></r><r><t>remained stable.</t></r></si>
</sst>"""
    sheet1 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{_NS_MAIN}">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="str"><f>SUM(A2:A3)</f><v>{XLSX_CACHED}</v></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>{XLSX_DASH_LINE}</t></is></c>
    </row>
  </sheetData>
</worksheet>"""
    sheet2 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{_NS_MAIN}">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>1</v></c></row>
  </sheetData>
</worksheet>"""
    return _zip_xlsx({
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": rels,
        "xl/sharedStrings.xml": shared,
        "xl/worksheets/sheet1.xml": sheet1,
        "xl/worksheets/sheet2.xml": sheet2,
    })


def _sentence_xlsx(sheet_name: str, sentence: str) -> bytes:
    workbook = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="{_NS_MAIN}" xmlns:r="{_NS_REL}">
  <sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{_NS_PKG}">
  <Relationship Id="rId1" Type="{_NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    sheet = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{_NS_MAIN}">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>{sentence}</t></is></c></row>
  </sheetData>
</worksheet>"""
    return _zip_xlsx({
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": rels,
        "xl/worksheets/sheet1.xml": sheet,
    })


def _doctype_xlsx() -> bytes:
    bad = """<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY x "boom">]><workbook></workbook>"""
    return _zip_xlsx({"xl/workbook.xml": bad})


def _notebook(marker: str) -> dict:
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": "python3"}},
        "cells": [
            {"cell_type": "markdown", "metadata": {}, "source": [f"{marker}\n"]},
            {
                "cell_type": "code",
                "metadata": {},
                "source": [f"print('{NOTEBOOK_CODE}')\n"],
                "outputs": [
                    {"output_type": "stream", "name": "stdout", "text": [f"{NOTEBOOK_OUT}\n"]},
                    {
                        "output_type": "display_data",
                        "data": {"text/plain": [NOTEBOOK_PLAIN], "image/png": "not-text"},
                    },
                ],
            },
        ],
    }


def _frontmatter(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} is missing YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise AssertionError(f"{path} frontmatter is not closed")
    meta = {}
    for line in text[4:end].splitlines():
        if not line.strip() or line[:1] in {" ", "\t"}:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip("'\"" )
    return meta, text


class FinalizeRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _font_pdf((EXACT_QUOTE, TYPO_LINE))

    def test_repairs_exact_and_typographic_quotes(self):
        exact = {
            "id": "exact-row",
            "verdictLabel": "아님",
            "family": "D1",
            "quote": "not in the document at all",
            "excerpt": "stale excerpt should be cleared",
        }
        typo = {
            "id": "typo-row",
            "verdictLabel": "아님",
            "family": "D3",
            "quote": "also absent from every page",
            "excerpt": "another stale excerpt",
        }
        report = _report([exact, typo])
        repairs = [
            {
                "findingId": "exact-row",
                "quote": EXACT_QUOTE,
                "action": "replace_quote_with_verbatim_substring",
            },
            {"findingId": "typo-row", "quote": TYPO_QUOTE},
        ]
        result = mod.finalize_blue_report(self.pdf, report, repairs=repairs)
        self.assertEqual(result["schema"], mod.FINALIZE_SCHEMA)
        self.assertTrue(result["ok"])
        self.assertEqual(result["appliedRepairCount"], 2)
        self.assertEqual(result["autoDowngradedCount"], 0)
        self.assertEqual(result["quoteCheck"]["missingCount"], 0)
        by_id = {row["findingId"]: row for row in result["quoteCheck"]["quotes"]}
        self.assertEqual(by_id["exact-row"]["status"], "exact")
        self.assertEqual(by_id["typo-row"]["status"], "normalized")
        self.assertEqual(by_id["typo-row"]["matchMode"], "typographic_folded")
        finalized = {row["id"]: row for row in result["finalizedReport"]["findings"]}
        self.assertEqual(finalized["exact-row"]["quote"], EXACT_QUOTE)
        self.assertEqual(finalized["exact-row"]["excerpt"], "")
        self.assertEqual(finalized["typo-row"]["quote"], TYPO_QUOTE)
        self.assertEqual(exact["quote"], "not in the document at all")
        self.assertIn("stale excerpt", exact["excerpt"])
        checked = mod.validate_blue_report(self.pdf, result["finalizedReport"])
        self.assertTrue(checked["ok"])
        self.assertEqual(checked["quoteCheck"]["missingCount"], 0)

    def test_mapping_repair_and_explicit_downgrade(self):
        stale = {
            "id": "exact-row",
            "verdictLabel": "아님",
            "quote": "missing before the mapping repair",
            "excerpt": "mapping must clear this excerpt",
        }
        mapped = mod.finalize_blue_report(
            self.pdf, _report([stale]), repairs={"exact-row": EXACT_QUOTE},
        )
        row = mapped["finalizedReport"]["findings"][0]
        self.assertEqual(mapped["appliedRepairCount"], 1)
        self.assertEqual(row["quote"], EXACT_QUOTE)
        self.assertEqual(row["excerpt"], "")
        self.assertEqual(stale["excerpt"], "mapping must clear this excerpt")

        kept = {
            "id": "exact-row",
            "verdict": "defect",
            "verdictLabel": "아님",
            "quote": EXACT_QUOTE,
            "family": "D1",
        }
        downgraded = mod.finalize_blue_report(
            self.pdf,
            _report([kept]),
            repairs=[{
                "findingId": "exact-row",
                "action": "downgrade_verdictLabel_to_확인필요",
            }],
        )
        finding = downgraded["finalizedReport"]["findings"][0]
        self.assertEqual(downgraded["appliedRepairCount"], 1)
        self.assertEqual(downgraded["autoDowngradedCount"], 0)
        self.assertEqual(finding["verdictLabel"], "확인필요")
        self.assertEqual(finding["verdict"], "needs_check")
        self.assertEqual(finding["quote"], EXACT_QUOTE)
        self.assertNotIn("autoDowngraded", finding)


class FinalizeDowngradeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _plain_pdf(("Unrelated anchor sentence for the blind PDF.",))
        cls.supps = [{"name": "notes.qmd", "text": QMD_LINE + "\n"}]

    def test_downgrades_hallucinated_defect_and_resolved_ok(self):
        defect = {
            "id": "bad-defect",
            "verdict": "defect",
            "verdictLabel": "아님",
            "family": "D1",
            "quote": MISSING_DEFECT,
            "rationale": "looks fabricated",
        }
        resolved = {
            "id": "bad-ok",
            "verdict": "supported",
            "verdictLabel": "맞음",
            "family": "D3",
            "resolutionQuote": MISSING_OK,
            "rationale": "claimed the suspicion was resolved",
        }
        result = mod.finalize_blue_report(
            self.pdf, _report([defect, resolved]), supplements=self.supps,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["quoteCheck"]["missingCount"], 0)
        self.assertEqual(result["autoDowngradedCount"], 2)
        self.assertEqual(result["autoDowngradedFindingIds"], ["bad-defect", "bad-ok"])
        self.assertEqual(result["finalizedReport"]["resolvedOk"], [])
        by_id = {row["id"]: row for row in result["finalizedReport"]["findings"]}
        self.assertEqual(set(by_id), {"bad-defect", "bad-ok"})
        for ident, original in (("bad-defect", MISSING_DEFECT), ("bad-ok", MISSING_OK)):
            row = by_id[ident]
            self.assertTrue(row["autoDowngraded"])
            self.assertEqual(row["unverifiedQuote"], original)
            self.assertEqual(row["quote"], "")
            self.assertEqual(row["excerpt"], "")
            self.assertEqual(row["resolutionQuote"], "")
            self.assertEqual(row["verdictLabel"], "확인필요")
            self.assertEqual(row["verdict"], "needs_check")
            self.assertTrue(row["rationale"].startswith(mod.AUTO_DOWNGRADE_PREFIX))
            self.assertIn("fabricated" if ident == "bad-defect" else "resolved", row["rationale"])
        self.assertEqual(defect["quote"], MISSING_DEFECT)
        self.assertEqual(resolved["resolutionQuote"], MISSING_OK)
        checked = mod.validate_blue_report(
            self.pdf, result["finalizedReport"], supplements=self.supps,
        )
        self.assertTrue(checked["ok"])
        self.assertEqual(checked["quoteCheck"]["missingCount"], 0)


class FinalizeGuardsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _plain_pdf((EXACT_QUOTE,))

    def test_zero_drop_csv_and_output_guards(self):
        ledger = [
            {
                "candidateId": "c-real",
                "quote": EXACT_QUOTE,
                "pageIndex": 0,
                "defectFamily": "D1",
                "locationLabel": "Results",
            },
            {
                "candidateId": "c-fake",
                "quote": MISSING_LEDGER,
                "pageIndex": 0,
                "defectFamily": "D2",
                "locationLabel": "Missing",
            },
        ]
        report = _report([], candidateLedger=ledger, team="blue", model="tester")
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            out_json = directory / "final.json"
            out_csv = directory / "final.csv"
            result = mod.finalize_blue_report(
                self.pdf,
                report,
                out_report_path=out_json,
                csv_path=out_csv,
                input_paths=[directory / "unused-input.json"],
            )
            self.assertEqual(result["zeroDrop"]["summary"]["recoveredCount"], 2)
            self.assertEqual(result["zeroDrop"]["summary"]["stage1Count"], 2)
            self.assertCountEqual(result["zeroDrop"]["recoveredFindingIds"], ["c-real", "c-fake"])
            self.assertNotIn("candidateLedger", result["finalizedReport"])
            by_id = {row.get("reportNumber"): row for row in result["finalizedReport"]["findings"]}
            self.assertEqual(by_id["c-real"]["quote"], EXACT_QUOTE)
            self.assertTrue(by_id["c-real"]["zeroDropRecovered"])
            self.assertTrue(by_id["c-fake"]["autoDowngraded"])
            self.assertEqual(by_id["c-fake"]["unverifiedQuote"], MISSING_LEDGER)
            self.assertEqual(by_id["c-fake"]["quote"], "")
            saved = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertEqual(saved["schema"], "falsify.blue-report.v1")
            self.assertEqual(saved["paperId"], result["paperId"])
            self.assertNotIn("candidateLedger", saved)
            csv_bytes = out_csv.read_bytes()
            self.assertFalse(csv_bytes.startswith(b"\xef\xbb\xbf"))
            self.assertIn(b"\r\n", csv_bytes)
            rows = list(csv.reader(io.StringIO(csv_bytes.decode("utf-8"))))
            self.assertEqual(rows[0], list(mod.CSV_COLUMNS))
            self.assertEqual(len(rows), 3)
            self.assertEqual(result["csv"]["rowCount"], 2)
            self.assertEqual(result["csv"]["columns"], list(mod.CSV_COLUMNS))
            self.assertEqual(result["outReportPath"], str(out_json))
            checked = mod.validate_blue_report(self.pdf, result["finalizedReport"])
            self.assertTrue(checked["ok"])
            self.assertEqual(checked["quoteCheck"]["missingCount"], 0)

            blocked = directory / "input.json"
            blocked.write_text("{}", encoding="utf-8")
            with self.assertRaises(mod.BlueReportError) as overwritten:
                mod.finalize_blue_report(
                    self.pdf, report, out_report_path=blocked, input_paths=[blocked],
                )
            self.assertEqual(overwritten.exception.code, "cannot_overwrite_input")
            self.assertEqual(overwritten.exception.exit_code, 2)
            same = directory / "same-output.csv"
            with self.assertRaises(mod.BlueReportError) as collided:
                mod.finalize_blue_report(
                    self.pdf, report, out_report_path=same, csv_path=same,
                )
            self.assertEqual(collided.exception.code, "cannot_overwrite_input")
            self.assertEqual(collided.exception.exit_code, 2)
            self.assertFalse(same.exists())

    def test_forbidden_red_keys_exit_three(self):
        with self.assertRaises(mod.BlueReportError) as report_leak:
            mod.finalize_blue_report(self.pdf, _report([], plan="leak"))
        self.assertEqual(report_leak.exception.code, "forbidden_red_key")
        self.assertEqual(report_leak.exception.exit_code, 3)
        with self.assertRaises(mod.BlueReportError) as repair_leak:
            mod.finalize_blue_report(self.pdf, _report([]), repairs={"gold": "hidden"})
        self.assertEqual(repair_leak.exception.code, "forbidden_red_key")
        self.assertEqual(repair_leak.exception.exit_code, 3)
        leaked = json.dumps({
            "nbformat": 4,
            "metadata": {"plan": "hidden"},
            "cells": [],
        })
        supplement = [{"name": "leak.ipynb", "text": leaked}]
        for caller in (mod.finalize_blue_report, mod.validate_blue_report):
            with self.assertRaises(mod.BlueReportError) as notebook_leak:
                caller(self.pdf, _report([]), supplements=supplement)
            self.assertEqual(notebook_leak.exception.code, "forbidden_red_key")
            self.assertEqual(notebook_leak.exception.exit_code, 3)


class SupplementQuoteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = _plain_pdf(("Unrelated anchor sentence for the blind PDF.",))
        cls.xlsx = _cohort_xlsx()
        cls.notebook_text = json.dumps(_notebook(NOTEBOOK_MD), ensure_ascii=False)

    def _by_quote(self, result) -> dict:
        return {row["quote"]: row for row in result["quoteCheck"]["quotes"]}

    def test_xlsx_ipynb_rmd_qmd_quotes_validate_and_finalize(self):
        supplements = [
            {"name": "cohort.xlsx", "bytes": self.xlsx},
            {"name": "notes.ipynb", "text": self.notebook_text},
            {"name": "analysis.qmd", "text": QMD_LINE + "\n"},
            {"name": "analysis.Rmd", "bytes": (RMD_LINE + "\n").encode("utf-8")},
        ]
        findings = [
            {"id": "sheet", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_SENTENCE},
            {"id": "formula", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_FORMULA},
            {"id": "cached", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_CACHED},
            {"id": "dash", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_DASH_QUOTE},
            {"id": "notes", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_NOTES},
            {"id": "md", "verdictLabel": "아님", "supplementName": "notes.ipynb", "quote": NOTEBOOK_MD},
            {"id": "code", "verdictLabel": "아님", "supplementName": "notes.ipynb", "quote": NOTEBOOK_CODE},
            {"id": "stream", "verdictLabel": "아님", "supplementName": "notes.ipynb", "quote": NOTEBOOK_OUT},
            {"id": "plain", "verdictLabel": "아님", "supplementName": "notes.ipynb", "quote": NOTEBOOK_PLAIN},
            {"id": "qmd", "verdictLabel": "아님", "supplementName": "analysis.qmd", "quote": QMD_LINE},
            {"id": "rmd", "verdictLabel": "아님", "supplementName": "analysis.Rmd", "quote": RMD_LINE},
        ]
        validated = mod.validate_blue_report(
            self.pdf, _report(findings), supplements=supplements,
        )
        self.assertTrue(validated["ok"])
        self.assertEqual(validated["quoteCheck"]["missingCount"], 0)
        by_quote = self._by_quote(validated)
        self.assertEqual(by_quote[XLSX_SENTENCE]["status"], "exact")
        self.assertEqual(by_quote[XLSX_SENTENCE]["source"], "supplement")
        self.assertEqual(by_quote[XLSX_SENTENCE]["supplementName"], "cohort.xlsx")
        self.assertEqual(by_quote[XLSX_SENTENCE]["lineNumber"], 2)
        self.assertEqual(by_quote[XLSX_FORMULA]["status"], "exact")
        self.assertEqual(by_quote[XLSX_CACHED]["status"], "exact")
        self.assertEqual(by_quote[XLSX_DASH_QUOTE]["status"], "normalized")
        self.assertEqual(by_quote[XLSX_NOTES]["status"], "exact")
        self.assertEqual(by_quote[XLSX_NOTES]["lineNumber"], 5)
        self.assertEqual(by_quote[NOTEBOOK_MD]["source"], "supplement")
        self.assertGreaterEqual(by_quote[NOTEBOOK_CODE]["lineNumber"], 1)
        self.assertEqual(by_quote[QMD_LINE]["supplementName"], "analysis.qmd")
        self.assertEqual(by_quote[RMD_LINE]["supplementName"], "analysis.Rmd")

        finalized = mod.finalize_blue_report(
            self.pdf,
            _report([
                {"id": "sheet", "verdictLabel": "아님", "supplementName": "cohort.xlsx", "quote": XLSX_SENTENCE},
                {"id": "missing", "verdictLabel": "아님", "quote": MISSING_DEFECT, "rationale": "no cell"},
            ]),
            supplements=supplements,
        )
        self.assertTrue(finalized["ok"])
        self.assertEqual(finalized["autoDowngradedFindingIds"], ["missing"])
        kept = finalized["finalizedReport"]["findings"]
        kept_sheet = next(row for row in kept if row.get("id") == "sheet")
        self.assertEqual(kept_sheet["quote"], XLSX_SENTENCE)
        dropped = next(row for row in kept if row.get("id") == "missing")
        self.assertEqual(dropped["unverifiedQuote"], MISSING_DEFECT)
        self.assertTrue(dropped["rationale"].startswith(mod.AUTO_DOWNGRADE_PREFIX))
        again = mod.validate_blue_report(
            self.pdf, finalized["finalizedReport"], supplements=supplements,
        )
        self.assertTrue(again["ok"])
        self.assertEqual(again["quoteCheck"]["missingCount"], 0)

    def test_xlsx_path_and_doctype_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "eta.xlsx"
            path.write_bytes(_sentence_xlsx("Eta", PATH_LINE))
            result = mod.validate_blue_report(
                self.pdf,
                _report([{
                    "id": "path",
                    "verdictLabel": "아님",
                    "quote": PATH_LINE,
                }]),
                supplements=[{"path": str(path)}],
            )
            self.assertTrue(result["ok"])
            quote = result["quoteCheck"]["quotes"][0]
            self.assertEqual(quote["status"], "exact")
            self.assertEqual(quote["source"], "supplement")
            self.assertEqual(quote["supplementName"], "eta.xlsx")
            self.assertGreaterEqual(quote["lineNumber"], 1)
        with self.assertRaises(mod.BlueReportError) as rejected:
            mod.validate_blue_report(
                self.pdf,
                _report([]),
                supplements=[{"name": "bad.xlsx", "bytes": _doctype_xlsx()}],
            )
        self.assertEqual(rejected.exception.code, "invalid_arguments")
        self.assertEqual(rejected.exception.exit_code, 2)


class SkillContractTests(unittest.TestCase):
    def test_wave10_skill_frontmatter_and_ccn(self):
        for name, phrases in _SKILL_PHRASES.items():
            path = ROOT / ".agents" / "skills" / name / "SKILL.md"
            meta, body = _frontmatter(path)
            self.assertEqual(meta.get("name"), name, name)
            self.assertTrue(meta.get("description"), name)
            self.assertEqual(meta.get("license"), "AGPL-3.0-only", name)
            for phrase in phrases:
                self.assertIn(phrase, body, f"{name} missing {phrase}")
        source = (ROOT / "app" / "local" / "blue_report_validate.py").read_bytes()
        completed = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "quality" / "python-functions.py")],
            input=source,
            capture_output=True,
            check=True,
        )
        rows = json.loads(completed.stdout)
        hot = [row["id"] for row in rows if row["ccn"] > 15]
        self.assertEqual(hot, [])


if __name__ == "__main__":
    unittest.main()

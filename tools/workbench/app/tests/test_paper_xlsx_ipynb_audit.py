"""Stdlib audits for xlsx workbooks, notebooks, and Rmd/qmd chunks."""
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_code_audit as code_audit
import paper_mcp_bundle as bundle
import paper_raw_dataset_audit as raw_audit
import paper_supplement_audit as supplement_audit
import paper_tabular_notebook_loader as loader

ROOT = Path(__file__).resolve().parents[2]
OWNED = (
    "app/local/paper_tabular_notebook_loader.py",
    "app/local/paper_mcp_bundle.py",
    "app/local/paper_raw_dataset_audit.py",
    "app/local/paper_code_audit.py",
    "app/local/paper_supplement_audit.py",
)
BAD = (
    "All hypothesis tests were two-sided with alpha = 0.05, "
    "and feature standardization was fit strictly on the training split after train-test partitioning. "
    "Test AUC = 0.93. N = 200. p = 0.002."
)
LEAK_SOURCE = (
    "from sklearn.preprocessing import StandardScaler\n"
    "from sklearn.model_selection import train_test_split\n"
    "from scipy.stats import ttest_ind\n"
    "X = StandardScaler().fit_transform(df[[\"age\", \"biomarker\"]])\n"
    "X_train, X_test, y_train, y_test = train_test_split(X, y)\n"
    "ttest_ind(y_train, y_test, alternative=\"greater\")\n"
)
CLEAN_SOURCE = (
    "from sklearn.pipeline import Pipeline\n"
    "from sklearn.preprocessing import StandardScaler\n"
    "from sklearn.linear_model import LogisticRegression\n"
    "from sklearn.model_selection import train_test_split\n"
    "X_train, X_test, y_train, y_test = train_test_split(X, y)\n"
    "pipe = Pipeline([(\"scaler\", StandardScaler()), (\"clf\", LogisticRegression())])\n"
    "pipe.fit(X_train, y_train)\n"
)


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
    if isinstance(value, tuple) and value[0] == "formula":
        return f'<c r="{ref}"><f>{_escape(value[1])}</f><v>{_escape(value[2])}</v></c>'
    if isinstance(value, tuple) and value[0] == "inline":
        return f'<c r="{ref}" t="inlineStr"><is><t>{_escape(value[1])}</t></is></c>'
    if isinstance(value, tuple) and value[0] == "shared":
        return f'<c r="{ref}" t="s"><v>{value[1]}</v></c>'
    return f'<c r="{ref}"><v>{_escape(value)}</v></c>'


def _sheet_xml(rows):
    body = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for col_index, value in enumerate(row):
            cells.append(_cell_xml(f"{_letters(col_index)}{row_index}", value))
        body.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    return (
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(body)}</sheetData></worksheet>"
    )


def _zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _workbook(sheets, shared=None):
    rels, listed = [], []
    files = {}
    for index, (name, rows) in enumerate(sheets, start=1):
        files[f"xl/worksheets/sheet{index}.xml"] = _sheet_xml(rows)
        rels.append(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>'
        )
        listed.append(f'<sheet name="{_escape(name)}" sheetId="{index}" r:id="rId{index}"/>')
    files["xl/workbook.xml"] = (
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{''.join(listed)}</sheets></workbook>"
    )
    files["xl/_rels/workbook.xml.rels"] = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(rels) + "</Relationships>"
    )
    if shared:
        items = "".join(f"<si><t>{_escape(item)}</t></si>" for item in shared)
        files["xl/sharedStrings.xml"] = f"<sst>{items}</sst>"
    return _zip(files)


def _cohort_rows():
    return [
        [("inline", "id"), ("inline", "group"), ("inline", "score")],
        [1, "Alpha", 10],
        [2, "Alpha", 20],
        [3, "Beta", 30],
        [4, "Beta", 40],
    ]


def _sums_rows(cached_sum, cached_average):
    return [
        [("shared", 0), ("shared", 1), ("shared", 2)],
        ["a", 10, ""],
        ["b", 20, ""],
        ["c", 30, ""],
        ["d", 40, ""],
        ["Total", ("formula", "SUM(B2:B5)", cached_sum), ("formula", "AVERAGE(B2:B5)", cached_average)],
    ]


def _xref_rows(cached):
    return [
        ["label", "value"],
        ["check", ("formula", "SUM(sums!B2:B5)", cached)],
    ]


def _ratio_rows(cached):
    return [
        ["left", "right", "ratio"],
        [1, 4, ("formula", "(A2/B2)*100", cached)],
    ]


def _study_book(cached_sum, cached_average, cached_cross, cached_ratio="25"):
    return _workbook(
        [
            ("cohort", _cohort_rows()),
            ("sums", _sums_rows(cached_sum, cached_average)),
            ("xref", _xref_rows(cached_cross)),
            ("ratio", _ratio_rows(cached_ratio)),
        ],
        shared=["label", "value", "avg"],
    )


def _kinds(result):
    return [signal["kind"] for signal in result["signals"]]


def _notebook(source, outputs, counts=(1, 2), language="python"):
    cells = []
    for index, count in enumerate(counts):
        cell = {
            "cell_type": "code",
            "execution_count": count,
            "metadata": {},
            "source": source if index == 0 else "y = 1\n",
            "outputs": outputs if index == 0 else [],
        }
        cells.append(cell)
    cells.insert(0, {"cell_type": "markdown", "metadata": {}, "source": "Table S1 cohort notes.\n"})
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": language, "language": language}, "language_info": {"name": language}},
        "cells": cells,
    }


def _pdf(text):
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        y = 72
        for line in str(text).splitlines():
            if line.strip():
                page.insert_text((72, y), line.strip(), fontsize=11)
                y += 18
        return doc.tobytes()
    finally:
        doc.close()


class _Store:
    def __init__(self, raw):
        self.raw = raw
        self.paper_id = "paper-xlsx"
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


class WorkbookLoaderTests(unittest.TestCase):
    def test_parses_shared_strings_inline_strings_and_formula_coordinates(self):
        parsed = loader.parse_xlsx_workbook(_study_book("240", "99", "1", "80"), name="cohort.xlsx")
        self.assertEqual([sheet["sheetName"] for sheet in parsed["sheets"]], ["cohort", "sums", "xref", "ratio"])
        cohort = parsed["sheets"][0]
        self.assertEqual(cohort["headers"], ["id", "group", "score"])
        self.assertEqual(cohort["rows"][0], ["1", "Alpha", "10"])
        sums = parsed["sheets"][1]
        self.assertEqual(sums["headers"], ["label", "value", "avg"])
        formula = next(cell for cell in sums["formulaCells"] if cell["ref"] == "B6")
        self.assertEqual(formula["row"], 6)
        self.assertEqual(formula["col"], 2)
        self.assertEqual(formula["formula"], "SUM(B2:B5)")
        self.assertEqual(formula["cachedValue"], "240")
        self.assertIn("[Sheet: cohort]", parsed["text"])
        self.assertIn("Alpha", parsed["text"])
        self.assertTrue(parsed["formulaSignals"])
        self.assertIn("\t", sums["tsvText"])

    def test_formula_mismatch_and_clean_cache(self):
        bad = loader.parse_xlsx_workbook(_study_book("240", "99", "1", "80"), name="cohort.xlsx")
        good = loader.parse_xlsx_workbook(_study_book("100", "25", "100", "25"), name="cohort.xlsx")
        pages = [{"id": "p0", "pageIndex": 0, "text": "The cached total was 240."}]
        anchored = loader.audit_xlsx_formulas(bad, page_items=pages)
        kinds = {signal["kind"] for signal in anchored}
        self.assertIn("xlsx_formula_value_mismatch", kinds)
        summed = next(signal for signal in anchored if signal["cellRef"] == "B6")
        self.assertEqual(summed["family"], "D1")
        self.assertEqual(summed["subtype"], "xlsx-formula-cached-mismatch")
        self.assertEqual(summed["sheetName"], "sums")
        self.assertEqual(summed["formula"], "SUM(B2:B5)")
        self.assertEqual(summed["reported"], "240")
        self.assertEqual(summed["computed"]["value"], 100)
        self.assertEqual(summed["computed"]["sheetName"], "sums")
        self.assertIn("cached total", summed["excerpt"].lower())
        self.assertLessEqual(len(summed["excerpt"]), 220)
        self.assertEqual(summed["pageIndex"], 0)
        average = next(signal for signal in anchored if signal["cellRef"] == "C6")
        self.assertEqual(average["computed"]["value"], 25)
        cross = next(signal for signal in anchored if signal["sheetName"] == "xref")
        self.assertEqual(cross["computed"]["value"], 100)
        ratio = next(signal for signal in anchored if signal["formula"] == "(A2/B2)*100")
        self.assertEqual(ratio["computed"]["value"], 25)
        self.assertEqual(good["formulaSignals"], [])
        self.assertEqual(loader.audit_xlsx_formulas(good, page_items=pages), [])

    def test_hardcoded_total_and_mean_rows(self):
        rows = [
            ["item", "amount"],
            ["a", 10],
            ["b", 20],
            ["c", 30],
            ["d", 40],
            ["Total", 999],
        ]
        mean_rows = [
            ["item", "amount"],
            ["a", 10],
            ["b", 20],
            ["c", 30],
            ["d", 40],
            ["Average", 1],
        ]
        parsed = loader.parse_xlsx_workbook(
            _workbook([("totals", rows), ("means", mean_rows)]),
            name="totals.xlsx",
        )
        signals = loader.audit_xlsx_formulas(parsed)
        total = next(signal for signal in signals if signal["sheetName"] == "totals")
        mean = next(signal for signal in signals if signal["sheetName"] == "means")
        self.assertEqual(total["kind"], "xlsx_summary_row_mismatch")
        self.assertEqual(total["subtype"], "xlsx-hardcoded-total-mismatch")
        self.assertEqual(total["family"], "D1")
        self.assertEqual(total["computed"]["value"], 100)
        self.assertEqual(mean["formula"], "MEAN")
        self.assertEqual(mean["computed"]["value"], 25)
        rows[-1][1] = 100
        mean_rows[-1][1] = 25
        clean = loader.parse_xlsx_workbook(_workbook([("totals", rows), ("means", mean_rows)]))
        self.assertEqual(clean["formulaSignals"], [])

    def test_rejects_xxe_zip_bomb_sheet_count_cell_count_and_red_keys(self):
        doctype = _zip({"xl/workbook.xml": '<!DOCTYPE foo [<!ENTITY x "y">]><workbook/>'})
        entity = _zip({"xl/workbook.xml": "<workbook><!ENTITY xxe 'no'></workbook>"})
        red = _zip({
            "xl/workbook.xml": '<workbook><definedNames><definedName name="plan">A1</definedName></definedNames></workbook>',
        })
        for payload in (doctype, entity, b"PK" + b"0" * (25 * 1024 * 1024), b"not-a-zip"):
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                loader.parse_xlsx_workbook(payload)
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            loader.parse_xlsx_workbook(red)
        oversized = b"<workbook>" + (b"a" * (loader.MAX_XML_BYTES + 1)) + b"</workbook>"
        with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
            loader.parse_xlsx_workbook(_zip({"xl/workbook.xml": oversized}))
        many = [(f"S{index}", [["id"], ["1"]]) for index in range(33)]
        with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
            loader.parse_xlsx_workbook(_workbook(many))
        cells = "".join(f'<c r="A{index}"><v>1</v></c>' for index in range(1, loader.MAX_CELLS + 2))
        huge = _zip({
            "xl/workbook.xml": (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
            ),
            "xl/_rels/workbook.xml.rels": (
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                'Target="worksheets/sheet1.xml"/></Relationships>'
            ),
            "xl/worksheets/sheet1.xml": f"<worksheet><sheetData><row>{cells}</row></sheetData></worksheet>",
        })
        with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
            loader.parse_xlsx_workbook(huge)

    def test_raw_dataset_uses_each_sheet_and_formula_signals(self):
        pages = [{"id": "p3", "pageIndex": 3, "text": "In the cohort patients we enrolled N = 99. The cached total was 240."}]
        parsed = loader.parse_xlsx_workbook(_study_book("240", "25", "100"), name="cohort.xlsx")
        result = raw_audit.audit_raw_datasets(pages, [{
            "name": "cohort.xlsx",
            "text": parsed["text"],
            "sheets": parsed["sheets"],
        }])
        self.assertGreaterEqual(result["datasetCount"], 1)
        mismatch = next(signal for signal in result["signals"] if signal["kind"] == "raw_dataset_n_mismatch")
        self.assertEqual(mismatch["computed"]["sheetName"], "cohort")
        self.assertEqual(mismatch["pageIndex"], 3)
        formula = next(signal for signal in result["signals"] if signal["kind"] == "xlsx_formula_value_mismatch")
        self.assertEqual(formula["sheetName"], "sums")
        self.assertEqual(formula["supplementName"], "cohort.xlsx")
        clean = _study_book("100", "25", "100", "25")
        quiet = raw_audit.audit_raw_datasets(
            [{"id": "p0", "pageIndex": 0, "text": "In the cohort patients we enrolled N = 4."}],
            [{"name": "cohort.xlsx", "bytes": clean}],
        )
        self.assertNotIn("xlsx_formula_value_mismatch", _kinds(quiet))
        self.assertNotIn("xlsx_summary_row_mismatch", _kinds(quiet))
        self.assertFalse(any(signal["kind"] == "raw_dataset_n_mismatch" and signal["computed"].get("sheetName") == "cohort" for signal in quiet["signals"]))


class NotebookAndLiterateTests(unittest.TestCase):
    def test_notebook_static_audit_and_clean_pipeline(self):
        outputs = [{
            "output_type": "execute_result",
            "metadata": {},
            "data": {
                "text/plain": "Test AUC = 0.71\nTrain AUC = 0.99\nN = 142\np = 0.24\n",
                "image/png": "iVBORw0KGgo" + ("A" * 180),
            },
        }]
        bad = _notebook(LEAK_SOURCE, outputs, counts=(4, 2))
        parsed = loader.parse_ipynb_notebook(json.dumps(bad), name="analysis.ipynb")
        self.assertEqual(parsed["language"], "python")
        self.assertIn("[Cell 1 markdown] Table S1 cohort notes.", parsed["text"])
        self.assertIn("[Cell 2 code]", parsed["text"])
        self.assertIn("[Cell 2 output] Test AUC = 0.71", parsed["text"])
        self.assertNotIn("iVBORw0KGgo", "\n".join(parsed["outputLines"]))
        self.assertIn("# [cell 1]", parsed["combinedCode"])
        self.assertTrue(parsed["codeCells"][0]["startLine"] >= 1)
        self.assertEqual(parsed["executionOrderAnomalies"][0]["advisoryOnly"], True)
        self.assertEqual(parsed["executionOrderAnomalies"][0]["direction"], "backwards")
        result = code_audit.audit_code_supplements(
            [{"id": "p0", "pageIndex": 0, "text": BAD}],
            [{"name": "analysis.ipynb", "text": json.dumps(bad)}],
        )
        self.assertIn("code_preprocessing_leakage", _kinds(result))
        self.assertIn("code_tailness_mismatch", _kinds(result))
        output_signals = [signal for signal in result["signals"] if signal["kind"] == "notebook_output_claim_mismatch"]
        self.assertEqual(sorted(signal["reported"]["label"] for signal in output_signals), ["n", "p", "test auc"])
        for signal in output_signals:
            self.assertEqual(signal["family"], "D6")
            self.assertEqual(signal["subtype"], "ipynb-output-mismatch")
            self.assertLessEqual(len(signal["excerpt"]), 220)
            self.assertNotEqual(signal["reported"]["label"], "train auc")
        clean = _notebook(CLEAN_SOURCE, [{
            "output_type": "stream",
            "name": "stdout",
            "text": ["Test AUC = 0.93\n", "Train AUC = 0.99\n"],
        }], counts=(1, 2))
        quiet = code_audit.audit_code_supplements(
            [{"id": "p0", "pageIndex": 0, "text": BAD}],
            [{"name": "clean.ipynb", "bytes": json.dumps(clean).encode("utf-8")}],
        )
        self.assertEqual(quiet["signals"], [])
        self.assertEqual(quiet["status"], "ok")

    def test_notebook_red_keys_and_r_kernel(self):
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            loader.parse_ipynb_notebook('{"cells": [], "metadata": {"plan": 1}, "nbformat": 4}')
        allowed = loader.parse_ipynb_notebook(
            '{"nbformat":4,"metadata":{},"cells":[{"cell_type":"code","source":"plan = 1\\n","outputs":[]}]}'
        )
        self.assertIn("plan = 1", allowed["combinedCode"])
        with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
            loader.parse_ipynb_notebook(b"\xff")
        with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
            loader.parse_ipynb_notebook("[]")
        r_nb = _notebook('t.test(a, b, alternative = "greater")\n', [], counts=(1,), language="r")
        result = code_audit.audit_code_supplements(
            [{"id": "p0", "pageIndex": 0, "text": "All tests were two-sided."}],
            [{"name": "stats.ipynb", "text": json.dumps(r_nb)}],
        )
        self.assertIn("code_tailness_mismatch", _kinds(result))
        self.assertIn("t.test", result["signals"][0]["codeSnippet"])

    def test_rmd_and_qmd_chunks_keep_file_line_numbers(self):
        rmd = "\n".join([
            "---",
            "title: demo",
            "---",
            "",
            "```{r}",
            't.test(a, b, alternative = "greater")',
            "```",
            "",
            "```{python}",
            "from sklearn.preprocessing import StandardScaler",
            "from sklearn.model_selection import train_test_split",
            "X = StandardScaler().fit_transform(df)",
            "X_train, X_test = train_test_split(X)",
            "```",
            "",
        ])
        chunks = loader.extract_rmd_qmd_chunks(rmd, name="analysis.Rmd")
        self.assertEqual([chunk["language"] for chunk in chunks], ["r", "python"])
        result = code_audit.audit_code_supplements(
            [{"id": "p0", "pageIndex": 2, "text": BAD}],
            [{"name": "analysis.Rmd", "text": rmd}],
        )
        lines = {signal["kind"]: signal["lineNumber"] for signal in result["signals"]}
        self.assertEqual(lines["code_tailness_mismatch"], rmd.splitlines().index('t.test(a, b, alternative = "greater")') + 1)
        self.assertEqual(lines["code_preprocessing_leakage"], rmd.splitlines().index("X = StandardScaler().fit_transform(df)") + 1)
        qmd = "\n".join([
            "---",
            "title: qmd",
            "---",
            "```{python}",
            "from sklearn.preprocessing import StandardScaler",
            "from sklearn.model_selection import train_test_split",
            "X = StandardScaler().fit_transform(df)",
            "X_train, X_test = train_test_split(X)",
            "```",
        ])
        qmd_result = code_audit.audit_code_supplements(
            [{"id": "p1", "pageIndex": 1, "text": BAD}],
            [{"name": "analysis.qmd", "text": qmd}],
        )
        leak = next(signal for signal in qmd_result["signals"] if signal["kind"] == "code_preprocessing_leakage")
        self.assertEqual(leak["lineNumber"], qmd.splitlines().index("X = StandardScaler().fit_transform(df)") + 1)
        self.assertEqual(leak["pageIndex"], 1)

    def test_supplement_bytes_are_decoded_and_kinds_are_specific(self):
        self.assertEqual(supplement_audit.infer_supplement_kind("cohort.xlsx"), "tabular")
        self.assertEqual(supplement_audit.infer_supplement_kind("notes.ipynb"), "code")
        self.assertEqual(supplement_audit.infer_supplement_kind("analysis.Rmd"), "code")
        self.assertEqual(supplement_audit.infer_supplement_kind("analysis.qmd"), "code")
        self.assertEqual(supplement_audit.infer_supplement_kind("cohort.csv"), "table-data")
        book = _workbook([("cohort", [["note"], ["Table S1 cohort"]])])
        report = supplement_audit.audit_paper_with_supplements(
            [{"id": "p0", "pageIndex": 0, "text": "See Table S1 for the cohort."}],
            [{"name": "cohort.xlsx", "bytes": book}],
        )
        self.assertNotIn("missing_supplementary_item", _kinds(report))
        notebook = _notebook("x = 1\n", [], counts=(1,))
        notebook_report = supplement_audit.audit_paper_with_supplements(
            [{"id": "p0", "pageIndex": 0, "text": "See Table S1."}],
            [{"name": "notes.ipynb", "bytes": json.dumps(notebook).encode("utf-8")}],
        )
        self.assertNotIn("missing_supplementary_item", _kinds(notebook_report))


class BundleAndComplexityTests(unittest.TestCase):
    def test_bundle_round_trip_and_internal_consistency_flag(self):
        raw = _pdf("\n".join([
            "In the cohort patients we enrolled N = 99.",
            "The cached total was 240.",
            "All hypothesis tests were two-sided.",
            "Feature standardization was fit strictly on the training split.",
            "Test AUC = 0.93.",
        ]))
        store = _Store(raw)
        workbook = _study_book("240", "25", "100")
        notebook = _notebook(LEAK_SOURCE, [{
            "output_type": "stream",
            "name": "stdout",
            "text": "Test AUC = 0.71\n",
        }])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            xlsx = folder / "cohort.xlsx"
            ipynb = folder / "analysis.ipynb"
            xlsx.write_bytes(workbook)
            ipynb.write_text(json.dumps(notebook), encoding="utf-8")
            loaded = bundle.load_selected_supplements([str(xlsx), str(ipynb)])
        self.assertEqual(loaded[0]["kind"], "tabular")
        self.assertEqual(loaded[1]["kind"], "code")
        self.assertGreaterEqual(len(loaded[0]["sheets"]), 2)
        self.assertIn("[Sheet: cohort]", loaded[0]["text"])
        self.assertIn("combinedCode", loaded[1]["notebook"])
        self.assertIn("[Cell 2 code]", loaded[1]["text"])
        recomputed = bundle.recompute_raw_supplement_payload(
            store, store.paper_id, store.file_hash, [loaded[0]],
        )
        self.assertIn("raw_dataset_n_mismatch", _kinds(recomputed))
        self.assertIn("xlsx_formula_value_mismatch", _kinds(recomputed))
        code = bundle.audit_code_supplements_payload(
            store, store.paper_id, store.file_hash, loaded, supplement_id=loaded[1]["supplementId"],
        )
        self.assertIn("code_preprocessing_leakage", _kinds(code))
        self.assertIn("notebook_output_claim_mismatch", _kinds(code))
        with self.assertRaisesRegex(ValueError, "include_internal_consistency"):
            bundle.run_blue_sensor_payload(store, store.paper_id, store.file_hash, include_internal_consistency="yes")
        digest = bundle._compact_sensor_digest({"schema": "x", "signals": [], "internalConsistency": {"status": "ok"}})
        self.assertEqual(digest["internalConsistency"], {"status": "ok"})

    def test_owned_production_functions_stay_within_ccn_15(self):
        script = ROOT / "tools" / "quality" / "python-functions.py"
        for rel in OWNED:
            source = (ROOT / rel).read_text(encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=source.encode("utf-8"),
                capture_output=True,
                check=True,
            )
            functions = json.loads(proc.stdout.decode("utf-8"))
            too_complex = [item for item in functions if item["ccn"] > 15]
            self.assertEqual(too_complex, [], msg=f"{rel} exceeded CCN 15")


if __name__ == "__main__":
    unittest.main()

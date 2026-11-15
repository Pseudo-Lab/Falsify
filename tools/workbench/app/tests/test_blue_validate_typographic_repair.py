"""Typographic quote folding and bounded BLUE repair packs."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

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
FONT = next((p for p in _FONT_CANDIDATES if p.is_file()), _FONT_CANDIDATES[0])
LIGATURE_LINES = (
    "con\ufb01dence interval stays wide",
    "the \ufb02ow of patients",
    "e\ufb00ect size reported",
    "the o\ufb03ce protocol",
    "wa\ufb04e thickness noted",
)
LIGATURE_QUOTES = (
    "confidence interval stays wide",
    "the flow of patients",
    "effect size reported",
    "the office protocol",
    "waffle thickness noted",
)
SYMBOL_LINES = (
    "delta \u22120.42 remained",
    "range 1\u20133 and 4\u20145 holds",
    "he said \u201cquote\u201d today",
    "patient\u2019s \u00b5g dose",
    "greek \u03bc symbol here",
    "rule p \u2264 0.05 holds",
    "rule p \u2265 0.80 holds",
    "score \u2260 zero today",
    "grid 2\u00d73 cells",
    "Dose\u00a05 mg given",
    "thin\u2009space token here",
    "hair\u200aspace token here",
    "narrow\u202fspace token here",
    "zero\u200bwidth token here",
    "bom\ufeffmarker token here",
)
SYMBOL_QUOTES = (
    "delta -0.42 remained",
    "range 1-3 and 4-5 holds",
    'he said "quote" today',
    "patient's \u03bcg dose",
    "greek \u00b5 symbol here",
    "rule p <= 0.05 holds",
    "rule p >= 0.80 holds",
    "score != zero today",
    "grid 2x3 cells",
    "zerowidth token here",
    "bommarker token here",
)
# collapse_ws already turns these Unicode spaces into ASCII spaces, so exact wins.
COLLAPSED_SPACE_QUOTES = (
    "Dose 5 mg given",
    "thin space token here",
    "hair space token here",
    "narrow space token here",
)
WRAP_LINES = (
    "Allocation was random-",
    "ized before the visit.",
    "Patients were self-",
    "reported during follow-up.",
)


def _font_page(lines: tuple[str, ...]) -> bytes:
    if not FONT.is_file():
        raise unittest.SkipTest(f"missing font {FONT}")
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="body", fontfile=str(FONT))
    for idx, line in enumerate(lines):
        page.insert_text((72, 72 + idx * 18), line, fontname="body", fontsize=11)
    raw = doc.tobytes()
    doc.close()
    return raw


def _plain_pdf(lines: tuple[str, ...]) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for idx, line in enumerate(lines):
        page.insert_text((72, 74 + idx * 28), line, fontsize=11)
    raw = doc.tobytes()
    doc.close()
    return raw


def _report(findings, **extra) -> dict:
    return {"schema": "falsify.blue-report.v1", "paperId": "pid-typo", "findings": list(findings), **extra}


def _finding(ident: str, quote: str, **extra) -> dict:
    return {"id": ident, "verdictLabel": "아님", "pageIndex": 0, "quote": quote, **extra}


class FoldHelperTests(unittest.TestCase):
    def test_fold_maps_ligatures_dashes_quotes_and_spaces(self):
        self.assertEqual(mod.fold_typographic("\ufb00\ufb01\ufb02\ufb03\ufb04\ufb05\ufb06"), "fffiflffifflstst")
        self.assertEqual(mod.fold_typographic("A\u2212B\u2010C\u2013D\u2014E"), "a-b-c-d-e")
        self.assertEqual(mod.fold_typographic("\u201cQ\u201d \u2019"), '"q" \'')
        self.assertEqual(mod.fold_typographic("\u00b5 \u03bc \u2264 \u2265 \u2260 \u00d7"), "\u03bc \u03bc <= >= != x")
        self.assertEqual(mod.fold_typographic("a\u00a0b\u2009c\u200ad\u202fe\u200bf\ufeffg"), "a b c d efg")

    def test_overlap_accepts_ligature_and_minus_windows(self):
        self.assertTrue(mod.quote_overlaps12("con\ufb01dence interval extra", "confidence interval extra"))
        self.assertTrue(mod.quote_overlaps12("delta \u22120.42 remained", "delta -0.42 remained"))
        self.assertFalse(mod.quote_overlaps12("short text", "short text extended"))


class TypographicPdfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ligature_pdf = _font_page(LIGATURE_LINES)
        cls.symbol_pdf = _font_page(SYMBOL_LINES)
        cls.wrap_pdf = _font_page(WRAP_LINES)

    def _quote(self, pdf: bytes, quote: str, ident: str = "q") -> dict:
        out = mod.validate_blue_report(pdf, _report([_finding(ident, quote)]))
        self.assertNotIn("repairPack", out)
        return out["quoteCheck"]["quotes"][0]

    def test_ligatures_match_ascii_quotes_with_bbox(self):
        for quote in LIGATURE_QUOTES:
            record = self._quote(self.ligature_pdf, quote)
            self.assertEqual(record["status"], "normalized", quote)
            self.assertEqual(record["matchMode"], "typographic_folded", quote)
            self._assert_bbox(record["bbox"])

    def test_math_dashes_quotes_micro_and_spaces(self):
        for quote in SYMBOL_QUOTES:
            record = self._quote(self.symbol_pdf, quote)
            self.assertEqual(record["status"], "normalized", quote)
            self.assertEqual(record["matchMode"], "typographic_folded", quote)
            self._assert_bbox(record["bbox"])
        for quote in COLLAPSED_SPACE_QUOTES:
            record = self._quote(self.symbol_pdf, quote)
            self.assertEqual(record["status"], "exact", quote)
            self.assertEqual(record["matchMode"], "exact", quote)
            self._assert_bbox(record["bbox"])

    def test_line_wrap_keeps_randomized_and_self_reported(self):
        randomized = self._quote(self.wrap_pdf, "randomized")
        self.assertEqual(randomized["status"], "exact")
        self.assertEqual(randomized["matchMode"], "exact")
        self._assert_bbox(randomized["bbox"])
        self.assertGreater(randomized["bbox"][3] - randomized["bbox"][1], 20.0)

        compound = self._quote(self.wrap_pdf, "self-reported")
        self.assertEqual(compound["status"], "normalized")
        self.assertEqual(compound["matchMode"], "typographic_folded")
        self._assert_bbox(compound["bbox"])
        self.assertGreater(compound["bbox"][3] - compound["bbox"][1], 20.0)

    def _assert_bbox(self, bbox) -> None:
        self.assertEqual(len(bbox), 4)
        self.assertTrue(all(isinstance(value, (int, float)) for value in bbox))
        self.assertGreater(bbox[2], bbox[0])
        self.assertGreater(bbox[3], bbox[1])


class RepairPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lines = (
            "Alpha sentence precedes the marker.",
            "Marker sentence stays unique.",
            "Omega sentence follows the marker.",
        )
        cls.pdf = _plain_pdf(cls.lines)

    def test_flag_defaults_off_and_rejects_non_booleans(self):
        plain = mod.validate_blue_report(self.pdf, _report([_finding("ok", self.lines[1])]))
        self.assertNotIn("repairPack", plain)
        self.assertEqual(plain["quoteCheck"]["quotes"][0]["matchMode"], "exact")
        self.assertEqual(
            set(plain),
            {"schema", "ok", "paperId", "fileHash", "quoteCheck", "zeroDrop", "csv", "warnings"},
        )
        with self.assertRaises(mod.BlueReportError) as ctx:
            mod.validate_blue_report(self.pdf, _report([]), include_repair_pack="yes")
        self.assertEqual(ctx.exception.code, "invalid_arguments")

    def test_pack_lists_missing_quote_context_and_recovered_ids(self):
        report = _report(
            [_finding("miss", "fabricated claim missing from every line here")],
            candidateLedger=[{
                "candidateId": "C-9",
                "page": 1,
                "locationLabel": "Results",
                "quote": "another fabricated ledger quote that is absent",
            }],
        )
        out = mod.validate_blue_report(self.pdf, report, include_repair_pack=True)
        self.assertFalse(out["ok"])
        pack = out["repairPack"]
        self.assertEqual(pack["schema"], mod.REPAIR_PACK_SCHEMA)
        self.assertFalse(pack["truncated"])
        self.assertIn("C-9", pack["recoveredFindingIds"])
        self.assertIn("확인필요", pack["promptSnippet"])
        self.assertIn("nearestCandidates", pack["promptSnippet"])
        self.assertGreaterEqual(len(pack["items"]), 1)
        item = next(row for row in pack["items"] if row["findingId"] == "miss")
        self.assertEqual(item["verdictLabel"], "아님")
        self.assertEqual(item["declaredPageIndex"], 0)
        self.assertEqual(item["rejectedQuote"], "fabricated claim missing from every line here")
        self.assertEqual(
            item["allowedActions"],
            ["replace_quote_with_verbatim_substring", "downgrade_verdictLabel_to_확인필요"],
        )
        self.assertLessEqual(len(item["nearestCandidates"]), 3)
        self.assertGreaterEqual(len(item["nearestCandidates"]), 1)
        top = item["nearestCandidates"][0]
        self.assertEqual(set(top), {"pageIndex", "bbox", "supplementName", "lineNumber", "text"})
        self.assertIsNone(top["supplementName"])
        self.assertIsNone(top["lineNumber"])
        window = [row["text"] for row in item["contextWindow"]]
        self.assertIn(top["text"], window)
        self.assertLessEqual(len(window), 3)
        self.assertGreaterEqual(len(window), 1)
        recovered = next(row for row in pack["items"] if row["findingId"] == "C-9")
        self.assertEqual(recovered["verdictLabel"], "확인필요")
        self.assertEqual(recovered["declaredPageIndex"], 0)
        encoded = json.dumps(pack, ensure_ascii=False).encode("utf-8")
        self.assertLessEqual(len(encoded), mod.MAX_REPAIR_PACK_BYTES)
        self.assertEqual(mod.forbidden_keys(pack), [])

    def test_many_missing_quotes_stay_inside_the_byte_cap(self):
        findings = [
            _finding(f"m{idx}", f"missing quote number {idx} " + ("x" * 400))
            for idx in range(55)
        ]
        out = mod.validate_blue_report(self.pdf, _report(findings), include_repair_pack=True)
        pack = out["repairPack"]
        self.assertTrue(pack["truncated"])
        self.assertLessEqual(
            len(json.dumps(pack, ensure_ascii=False).encode("utf-8")),
            mod.MAX_REPAIR_PACK_BYTES,
        )
        self.assertEqual(pack["schema"], mod.REPAIR_PACK_SCHEMA)

    def test_forbidden_red_keys_are_not_copied_into_the_pack(self):
        report = _report([_finding("miss", "fabricated claim missing from every line here")])
        out = mod.validate_blue_report(self.pdf, report)
        poisoned = json.loads(json.dumps(out))
        poisoned["quoteCheck"]["quotes"][0]["gold"] = "secret"
        poisoned["quoteCheck"]["quotes"][0]["nearestCandidates"][0]["plan"] = "hidden"
        poisoned["quoteCheck"]["quotes"][0]["nearestCandidates"][0]["before"] = "hidden"
        pack = mod.build_blue_repair_pack(poisoned, report, pdf_bytes=self.pdf)
        blob = json.dumps(pack, ensure_ascii=False)
        self.assertEqual(mod.forbidden_keys(pack), [])
        self.assertNotIn("secret", blob)
        self.assertNotIn("hidden", blob)
        self.assertNotIn('"gold"', blob)
        self.assertNotIn('"plan"', blob)
        self.assertNotIn('"before"', blob)


if __name__ == "__main__":
    unittest.main()

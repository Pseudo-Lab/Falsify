"""Comprehensive regression tests for D06 (decorative filtering), D02 (BLUE budget/ranking),
D03 (read-only native text/search/references MCP tools), and D04 (logical multi-grid tables,
superscripts, footnotes, units). All synthetic in-memory PDFs via PyMuPDF; zero private files."""
import hashlib
import json
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_evidence as pe
import paper_evidence_blue as blue
import paper_evidence_text as pet

sha = lambda data: hashlib.sha256(data).hexdigest()


def _make_pixmap(shade):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 12, 12), False)
    pix.clear_with(shade)
    return pix


def _draw_grid(page, origin, col_widths, row_height, rows_data, superscripts=None):
    """Draw a bordered table grid; superscripts={(r,c): (prefix, sup, suffix, base_fs, sup_fs)}."""
    superscripts = superscripts or {}
    x0, y0 = origin
    for r, row in enumerate(rows_data):
        cx = x0
        cy0 = y0 + r * row_height
        for c, text in enumerate(row):
            cw = col_widths[c]
            rect = pymupdf.Rect(cx, cy0, cx + cw, cy0 + row_height)
            page.draw_rect(rect, color=(0, 0, 0), width=0.8)
            if (r, c) in superscripts:
                pre, sup, suf, bfs, sfs = superscripts[(r, c)]
                base_y = cy0 + row_height * 0.65
                page.insert_text((cx + 4, base_y), pre, fontsize=bfs, fontname="helv")
                w_pre = pymupdf.get_text_length(pre, fontsize=bfs)
                page.insert_text((cx + 4 + w_pre, base_y - 4.0), sup, fontsize=sfs, fontname="helv")
                if suf:
                    w_sup = pymupdf.get_text_length(sup, fontsize=sfs)
                    page.insert_text((cx + 4 + w_pre + w_sup + 0.5, base_y), suf, fontsize=bfs, fontname="helv")
            elif text:
                page.insert_textbox(
                    pymupdf.Rect(rect.x0 + 3, rect.y0 + 5, rect.x1 - 3, rect.y1 - 3),
                    text, fontsize=9.5, fontname="helv",
                )
            cx += cw


class DecorativeAndBudgetTests(unittest.TestCase):
    def test_d06_repeated_logo_and_margin_badge_classified_decorative(self):
        doc = pymupdf.open()
        logo = _make_pixmap(60)
        cc_badge = _make_pixmap(120)
        sci_fig = _make_pixmap(190)
        for p_idx in range(4):
            page = doc.new_page(width=595, height=842)
            # Same logo digest repeated across 4 pages (body/top area)
            page.insert_image(pymupdf.Rect(72, 200, 240, 280), pixmap=logo)
            # Small running footer badge across 2 pages (<=140x60 in bottom 12%)
            if p_idx in (0, 1):
                page.insert_image(pymupdf.Rect(420, 770, 520, 805), pixmap=cc_badge)
            if p_idx == 2:
                page.insert_text((72, 390), "Figure 1. Kaplan-Meier survival curve.", fontsize=10)
                page.insert_image(pymupdf.Rect(72, 405, 360, 620), pixmap=sci_fig)
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        self.assertGreaterEqual(summary["counts"]["decorativeCount"], 6)
        figures = store.list_items(summary["paperId"], kind="figure")["items"]
        decorative = [f for f in figures if f["classification"] == "decorative"]
        scientific = [f for f in figures if f["classification"] == "scientific"]
        self.assertEqual(len(decorative), 6)
        self.assertEqual(len(scientific), 1)
        self.assertTrue(scientific[0]["caption"].startswith("Figure 1"))
        self.assertEqual(summary["counts"]["decorativeCount"], len(decorative))
        self.assertTrue(all(f["type"] == "figure" for f in figures))

    def test_d02_scientific_relevance_ranking_puts_late_table_before_decorative_logos(self):
        doc = pymupdf.open()
        logo = _make_pixmap(55)
        for p_idx in range(12):
            page = doc.new_page(width=595, height=842)
            # Repeated header logo on every page (pages 0..11)
            page.insert_image(pymupdf.Rect(40, 24, 150, 64), pixmap=logo)
            if p_idx == 11:
                page.insert_text((72, 100), "Table 3. Clinical Outcome Endpoints", fontsize=11)
                _draw_grid(
                    page, (72, 115), [160, 110, 110], 24,
                    [["Outcome", "Drug A", "Placebo"], ["Mortality n (%)", "12 (4.1%)", "29 (9.8%)"]],
                )
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        packed = blue.context_for_review(summary["paperId"], summary["fileHash"], store=store, max_chars=24000)
        text = packed["text"]
        self.assertIn("Table 3. Clinical Outcome Endpoints", text)
        self.assertIn("29 (9.8%)", text)
        self.assertIn("Decorative repeated assets omitted: 12", text)
        self.assertIn("read_page_text", text)
        self.assertIn("search_text", text)
        self.assertIn("list_references", text)
        cov = packed["coverage"]
        self.assertEqual(cov["included"]["tables"], 1)
        self.assertEqual(cov["included"]["figures"], 0)
        self.assertEqual(cov["omitted"]["figures"], 12)
        self.assertEqual(cov["included"]["figures"] + cov["omitted"]["figures"], cov["listed"]["figures"])

    def test_d02_omitted_scientific_items_listed_at_end_when_budget_exceeded(self):
        doc = pymupdf.open()
        for p_idx in range(2):
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 80), f"Table {p_idx + 1}. Cohort {p_idx + 1}", fontsize=11)
            rows = [[f"Row {r} col 0", f"Val {r} " + ("X" * 35)] for r in range(8)]
            _draw_grid(page, (72, 95), [140, 280], 24, rows)
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        tables = store.list_items(summary["paperId"], kind="table")["items"]
        self.assertEqual(len(tables), 2)
        t2_id = tables[1]["id"]
        packed = blue.context_for_review(summary["paperId"], summary["fileHash"], store=store, max_chars=3200)
        text = packed["text"]
        self.assertIn("Cohort 1", text)
        self.assertIn("Omitted scientific items", text)
        self.assertIn(t2_id, text)
        self.assertIn("Table 2. Cohort 2", text)
        self.assertIn(t2_id, packed["coverage"]["omittedIds"])


class NativeTextSearchAndReferencesTests(unittest.TestCase):
    def _two_col_pdf(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 35), "Journal of Medicine Vol 9", fontsize=9)
        p0.insert_text((500, 815), "Page 1", fontsize=9)
        p0.insert_text((72, 85), "1. Introduction", fontsize=13)
        p0.insert_text((72, 115), "Left column first paragraph", fontsize=10.5)
        p0.insert_text((72, 132), "with mean BMI 24.5 kg/m", fontsize=10.5)
        w = pymupdf.get_text_length("with mean BMI 24.5 kg/m", fontsize=10.5)
        p0.insert_text((72 + w, 127), "2", fontsize=7)
        p0.insert_text((320, 115), "Right column comes second", fontsize=10.5)
        p0.insert_text((320, 132), "discussing primary endpoint.", fontsize=10.5)

        p1 = doc.new_page(width=595, height=842)
        p1.insert_text((72, 35), "Journal of Medicine Vol 9", fontsize=9)
        p1.insert_text((500, 815), "Page 2", fontsize=9)
        p1.insert_text((72, 95), "References", fontsize=13)
        p1.insert_text((72, 120), "[1] Doe J, Roe A. Clinical trial design.", fontsize=10)
        p1.insert_text((72, 134), "N Engl J Med. 2022;386:12-20. doi:10.1056/NEJMoa2022001", fontsize=10)
        p1.insert_text((72, 154), "[2] Kim S. Statistical methods in oncology. 2024.", fontsize=10)
        p1.insert_text((72, 168), "https://doi.org/10.1016/j.onc.2024.01.005", fontsize=10)
        raw = doc.tobytes()
        doc.close()
        return raw

    def test_d03_read_page_text_two_column_section_only_and_superscripts(self):
        raw = self._two_col_pdf()
        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        pid = summary["paperId"]

        full = pet.read_page_text(pid, 0, section_only=False, store=store)
        self.assertEqual(full["fileHash"], summary["fileHash"])
        self.assertEqual(full["pageNumber"], 1)
        self.assertFalse(full["truncated"])
        self.assertIn("Journal of Medicine Vol 9", full["text"])
        self.assertIn("kg/m²", full["text"])
        self.assertLess(full["text"].index("Left column first paragraph"), full["text"].index("Right column comes second"))
        self.assertTrue(any("1. Introduction" in h for h in full["headings"]))

        sec = pet.read_page_text(pid, 0, section_only=True, store=store)
        self.assertNotIn("Journal of Medicine Vol 9", sec["text"])
        self.assertNotIn("Page 1", sec["text"])
        self.assertIn("Left column first paragraph", sec["text"])

    def test_d03_search_text_and_list_references(self):
        raw = self._two_col_pdf()
        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        pid = summary["paperId"]

        res = pet.search_text(pid, "primary endpoint", limit=10, case_sensitive=False, store=store)
        self.assertEqual(res["totalMatches"], 1)
        self.assertEqual(res["matches"][0]["pageIndex"], 0)
        self.assertEqual(res["matches"][0]["pageNumber"], 1)
        self.assertEqual(len(res["matches"][0]["bbox"]), 4)
        self.assertIn("primary endpoint", res["matches"][0]["snippet"])

        with self.assertRaises(ValueError):
            pet.search_text(pid, "   ", store=store)
        with self.assertRaises(ValueError):
            pet.search_text(pid, "x" * 201, store=store)
        with self.assertRaises(ValueError):
            pet.search_text(pid, "trial", limit=101, store=store)

        refs = pet.list_references(pid, offset=0, limit=50, store=store)
        self.assertEqual(refs["status"], "ready")
        self.assertEqual(refs["total"], 2)
        self.assertEqual(refs["references"][0]["index"], 1)
        self.assertEqual(refs["references"][0]["doi"], "10.1056/NEJMoa2022001")
        self.assertEqual(refs["references"][0]["year"], 2022)
        self.assertEqual(refs["references"][1]["doi"], "10.1016/j.onc.2024.01.005")
        self.assertEqual(refs["references"][1]["year"], 2024)

    def test_d03_list_references_not_found_and_author_year(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842).insert_text((72, 100), "Body without references.", fontsize=11)
        no_ref_raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        s1 = store.prepare(no_ref_raw, sha(no_ref_raw))
        missing = pet.list_references(s1["paperId"], store=store)
        self.assertEqual(missing["status"], "not_found")
        self.assertEqual(missing["references"], [])

        doc2 = pymupdf.open()
        p = doc2.new_page(width=595, height=842)
        p.insert_text((72, 90), "Bibliography", fontsize=13)
        p.insert_text((72, 120), "Smith, J. (2021). Outcomes in cohort A. JAMA 12:1-9.", fontsize=10)
        p.insert_text((72, 140), "Jones, B. (2023). Follow-up analysis. Lancet 14:22-30.", fontsize=10)
        ay_raw = doc2.tobytes()
        doc2.close()
        s2 = store.prepare(ay_raw, sha(ay_raw))
        ay = pet.list_references(s2["paperId"], store=store)
        self.assertEqual(ay["status"], "ready")
        self.assertEqual(ay["total"], 2)
        self.assertEqual([r["year"] for r in ay["references"]], [2021, 2023])


class LogicalMultiGridAndSuperscriptTableTests(unittest.TestCase):
    def test_d04_superscripts_same_page_stacked_and_cross_page_continuation(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 75), "Table 1. Baseline Characteristics and Outcomes", fontsize=11)
        # Stacked sub-grid part 0 (header/demographics) with superscript kg/m² and footnote marker
        _draw_grid(
            p0, (72, 90), [180, 120, 120], 26,
            [["Measure", "Cohort A", "Cohort B"], ["BMI", "24.1", "26.3"]],
            superscripts={
                (1, 0): ("BMI (kg/m", "2", ")", 9.5, 6.0),
                (1, 1): ("24.1", "a", "", 9.5, 6.0),
            },
        )
        # Stacked sub-grid part 1 immediately below on the same page
        _draw_grid(
            p0, (72, 152), [180, 120, 120], 26,
            [["WBC (10^6/uL)", "6.2", "7.1"], ["Survival (95% CI)", "88%", "74%"]],
            superscripts={(0, 0): ("WBC (10", "6", "/uL)", 9.5, 6.0)},
        )
        p0.insert_text((72, 222), "* Values are n (%) or 95% CI unless stated.", fontsize=8.5)
        p0.insert_text((72, 236), "a Adjusted for baseline age.", fontsize=8.5)

        # Page 1: Cross-page continuation of Table 1
        p1 = doc.new_page(width=595, height=842)
        p1.insert_text((72, 75), "Table 1 (continued)", fontsize=11)
        _draw_grid(
            p1, (72, 90), [180, 120, 120], 26,
            [["Follow-up (months)", "24", "24"]],
        )
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        tables = store.list_items(summary["paperId"], kind="table")["items"]
        self.assertEqual(len(tables), 3)
        logical_ids = {t["logicalTableId"] for t in tables}
        self.assertEqual(logical_ids, {"logical-table-1"})
        self.assertEqual([t["partIndex"] for t in tables], [0, 1, 2])
        self.assertTrue(all(t["partCount"] == 3 for t in tables))
        self.assertIsNone(tables[0]["continuedFromId"])
        self.assertEqual(tables[0]["continuedIds"], [tables[1]["id"], tables[2]["id"]])
        self.assertEqual(tables[1]["continuedFromId"], tables[0]["id"])
        self.assertEqual(tables[2]["continuedFromId"], tables[1]["id"])

        part0 = store.read_item(summary["paperId"], tables[0]["id"])
        texts0 = [c["text"] for c in part0["table"]["cells"]]
        self.assertIn("BMI (kg/m²)", texts0)
        self.assertIn("24.1ᵃ", texts0)
        self.assertEqual(part0["logicalTable"]["partIds"], [t["id"] for t in tables])
        self.assertTrue(any("Adjusted for baseline age." in fn for fn in part0["logicalTable"]["footnotes"]))
        self.assertIn("kg/m²", part0["logicalTable"]["units"])

        part1 = store.read_item(summary["paperId"], tables[1]["id"])
        texts1 = [c["text"] for c in part1["table"]["cells"]]
        self.assertIn("WBC (10⁶/uL)", texts1)
        self.assertIn("95% CI", part1["logicalTable"]["units"])


if __name__ == "__main__":
    unittest.main()

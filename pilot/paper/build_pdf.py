"""Render the complete candidate manuscript with a two-column educational AMF layout."""
from pathlib import Path
import csv
import hashlib
import html
import json
import re
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.graphics.shapes import Drawing, Line, String, Circle
from pypdf import PdfReader

OUT = Path(__file__).resolve().parents[1]
PAPER = OUT / "paper/manuscript_en.md"
PDF = OUT / "paper/paper.pdf"
WIDTH, HEIGHT = A4
MARGIN = 40
GAP = 18
COL = (WIDTH - MARGIN * 2 - GAP) / 2

# Font selection only affects layout, not manuscript content.
import os
import reportlab
font_candidates = [Path(os.environ.get("STUDY_FONT_DIR", "C:/Windows/Fonts")), Path("/usr/share/fonts/truetype/dejavu"), Path(reportlab.__file__).parent / "fonts"]
font_names = [("arial.ttf", "arialbd.ttf", "ariali.ttf"), ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf"), ("Vera.ttf", "VeraBd.ttf", "VeraIt.ttf")]
for directory in font_candidates:
    available = next((names for names in font_names if all((directory / name).is_file() for name in names)), None)
    if available:
        for label, name in zip(("Study", "StudyBold", "StudyItalic"), available): pdfmetrics.registerFont(TTFont(label, str(directory / name)))
        break
else: raise RuntimeError("No supported font family found; set STUDY_FONT_DIR.")
pdfmetrics.registerFontFamily("Study", normal="Study", bold="StudyBold", italic="StudyItalic", boldItalic="StudyBold")
styles = {
    "body": ParagraphStyle("body", fontName="Study", fontSize=9.4, leading=12.1, spaceAfter=5.5, splitLongWords=True),
    "title": ParagraphStyle("title", fontName="StudyBold", fontSize=14.2, leading=17.2, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="StudyBold", fontSize=11.2, leading=13.3, spaceBefore=8, spaceAfter=5, keepWithNext=True),
    "h3": ParagraphStyle("h3", fontName="StudyBold", fontSize=10, leading=12.5, spaceBefore=7, spaceAfter=4, keepWithNext=True),
    "small": ParagraphStyle("small", fontName="Study", fontSize=8, leading=10.2, spaceAfter=5),
    "cell": ParagraphStyle("cell", fontName="Study", fontSize=6.5, leading=8.1, spaceAfter=0),
    "header": ParagraphStyle("header", fontName="StudyBold", fontSize=6.6, leading=8.2, spaceAfter=0),
    "ref": ParagraphStyle("ref", fontName="Study", fontSize=8, leading=10.3, spaceAfter=5),
}

def markup(text):
    # Typography only: the original Markdown bytes and scientific quantities stay fixed.
    text = text.replace("–", "-").replace("—", "-").replace("‑", "-").replace("−", "-")
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", text)
    return text

def paragraph(text, style="body"):
    return Paragraph(markup(text), styles[style])

def make_table(rows, widths):
    result = []
    for i, row in enumerate(rows):
        result.append([paragraph(value.replace("<br/>", " "), "header" if i == 0 else "cell") for value in row])
    table = Table(result, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eaf0f3")),
        ("LINEABOVE", (0, 0), (-1, 0), .7, colors.HexColor("#405b6d")),
        ("LINEBELOW", (0, 0), (-1, 0), .5, colors.HexColor("#405b6d")),
        ("LINEBELOW", (0, -1), (-1, -1), .5, colors.HexColor("#405b6d")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9fa")]),
    ]))
    return table

def table_flow(rows):
    header = rows[0]
    body = rows[1:]
    if header[0] == "Task":
        config = [["Task", "Obs.", "Unobs.", "Incl.", "Pos.", "Prev.", "Thr."]]
        metrics = [["Task", "AUROC (95% CI)", "AP (95% CI)", "F1 (95% CI)"]]
        for row in body:
            count = row[:7]
            if row[0] == "Macro":
                count[3] = "Task-dependent; 223 scored overall"
            config.append(count)
            metrics.append([row[0], *row[7:10]])
        return [paragraph("Table 1a. Task inclusion and thresholds", "small"), make_table(config, [35, 26, 31, 36, 24, 33, COL-185]), Spacer(1, 6),
                paragraph("Table 1b. Task metrics (same runs and population as Table 1a)", "small"), make_table(metrics, [34, (COL-34)/3, (COL-34)/3, (COL-34)/3]), Spacer(1, 5)]
    if header[0] == "Execution":
        config = [["Execution", "Model", "Seed", "Epoch", "Planned / scored / abstained"]]
        metrics = [["Execution", "AUROC (95% CI)", "AP (95% CI)", "F1 (95% CI)"]]
        for row in body:
            label = row[0].replace(", four repetitions", "").replace("Three distinct attention seeds, mean±SD", "Distinct attention seeds; mean±SD")
            config.append([label, *row[1:5]])
            metrics.append([label, *row[5:8]])
        return [paragraph("Table 2a. Configuration and coverage", "small"), make_table(config, [76, 42, 35, 27, COL-180]), Spacer(1, 6),
                paragraph("Table 2b. Metrics for the executions in Table 2a", "small"), make_table(metrics, [65, (COL-65)/3, (COL-65)/3, (COL-65)/3]), Spacer(1, 5)]
    # Checklist: preserve every response and evidence text while fitting one column.
    return [make_table(rows, [62, 22, COL-84]), Spacer(1, 5)]

def forest():
    rows = list(csv.DictReader((OUT / "figures/figure3_source.csv").open(encoding="utf-8", newline="")))
    annotations = re.findall(r'>([0-9]+\.[0-9]+) \[[0-9., ]+\]</text>', (OUT / "figures/figure3.svg").read_text(encoding="utf-8"))
    assert len(annotations) == len(rows)
    drawing = Drawing(COL, 172)
    left, right = 50, 151
    def x(value): return left + (value - .4) / .5 * (right-left)
    for tick in (.4, .5, .6, .7, .8, .9):
        drawing.add(Line(x(tick), 34, x(tick), 156, strokeColor=colors.HexColor("#d8e1e5"), strokeWidth=.4))
        drawing.add(String(x(tick), 22, f"{tick:.1f}", fontName="Study", fontSize=6.8, textAnchor="middle"))
    drawing.add(String(0, 164, "Task", fontName="StudyBold", fontSize=7.1))
    drawing.add(String(159, 164, "AUROC [95% CI]", fontName="StudyBold", fontSize=7.1))
    for i, row in enumerate(rows):
        y = 146 - i * 17
        macro = row["task_id"] == "macro"
        color = colors.HexColor("#a34732" if macro else "#2b647e")
        low, value, high = (float(row[name]) for name in ("ci_low", "value", "ci_high"))
        drawing.add(String(0, y-2, "Macro" if macro else row["task_id"], fontName="StudyBold" if macro else "Study", fontSize=6.8))
        drawing.add(Line(x(low), y, x(high), y, strokeColor=color, strokeWidth=1.2))
        for endpoint in (low, high): drawing.add(Line(x(endpoint), y-3, x(endpoint), y+3, strokeColor=color, strokeWidth=1))
        drawing.add(Circle(x(value), y, 2.5, strokeColor=color, fillColor=color))
        # This is the same issued SVG annotation; source coordinates remain at the original value.
        display = annotations[i]
        drawing.add(String(159, y-2, f"{display} [{low:.3f}, {high:.3f}]", fontName="StudyBold" if macro else "Study", fontSize=6.5))
    drawing.add(String((left+right)/2, 8, "AUROC", fontName="Study", fontSize=7, textAnchor="middle"))
    return drawing

class ManuscriptDoc(BaseDocTemplate):
    def __init__(self, path):
        super().__init__(str(path), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=38, bottomMargin=39,
                         title="Reproducibility and Methodological Boundaries of Multimodal Feature Fusion for Six Synthetic Outcomes",
                         author="Anonymous Authors", subject="Educational fictional synthetic study", creator="Anonymous manuscript layout", pageCompression=1)
        frames = [Frame(MARGIN, 39, COL, HEIGHT-77, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="left"),
                  Frame(MARGIN+COL+GAP, 39, COL, HEIGHT-77, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="right")]
        self.addPageTemplates(PageTemplate(id="two_columns", frames=frames, onPage=self.decorate))
        self.sections = {}
    def decorate(self, canvas, doc):
        canvas.saveState()
        canvas.setFont("Study", 7)
        canvas.setFillColor(colors.HexColor("#4a5e6b"))
        canvas.drawString(MARGIN, HEIGHT-22, "AMF edu-1.0 | Educational fictional study | Anonymous initial submission")
        canvas.setStrokeColor(colors.HexColor("#c5cfd5"))
        canvas.line(MARGIN, HEIGHT-28, WIDTH-MARGIN, HEIGHT-28)
        canvas.drawString(MARGIN, 21, "Synthetic data only - no clinical validity established")
        canvas.drawRightString(WIDTH-MARGIN, 21, str(doc.page))
        canvas.restoreState()
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph):
            text = flowable.getPlainText()
            if text in ("References", "AMF edu-1.0 Reproducibility Checklist", "Ethics Statement"):
                self.sections[text] = self.page

def main():
    lines = PAPER.read_text(encoding="utf-8").splitlines()
    story = []
    i = 0
    reference_section = False
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("|"):
            raw = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[i].strip().split("|")[1:-1]]
                if not all(re.fullmatch(r"[:\- ]+", cell) for cell in cells): raw.append(cells)
                i += 1
            story.extend(table_flow(raw))
            continue
        if line.startswith("$$"):
            story.append(paragraph("L = -sum(o_nt [y_nt log(p_nt) + (1-y_nt) log(1-p_nt)]) / sum(o_nt).", "small"))
            i += 1
            continue
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            text = line[level:].strip()
            if text == "References": reference_section = True
            story.append(paragraph(text, "title" if level == 1 else "h2" if level == 2 else "h3"))
            i += 1
            continue
        if line.startswith("**Figure 3."):
            story.append(KeepTogether([forest(), paragraph(line, "small")]))
            i += 1
            continue
        para = [line]
        i += 1
        if not re.match(r"(?:\d+\.|-)\s", line):
            while i < len(lines) and lines[i].strip() and not lines[i].lstrip().startswith(("#", "|", "$$")):
                para.append(lines[i].strip())
                i += 1
        story.append(paragraph(" ".join(para), "ref" if reference_section else "small" if line.startswith("Target profile:") else "body"))
    doc = ManuscriptDoc(PDF)
    doc.build(story)
    reader = PdfReader(str(PDF))
    assert len(reader.pages) <= 8, len(reader.pages)
    texts = [page.extract_text() for page in reader.pages]
    assert all(text.strip() for text in texts)
    combined = "\n".join(texts)
    metadata = {str(key): str(value) for key, value in reader.metadata.items()}
    assert metadata.get("/Author") == "Anonymous Authors"
    report = {"version": "dropfusion.layout/1.0", "path": "paper/paper.pdf", "sha256": hashlib.sha256(PDF.read_bytes()).hexdigest(),
              "pages_total": len(reader.pages), "body_pages_upper_bound": len(reader.pages), "page_limit_including_all_back_matter": 8,
              "columns": 2, "sections_first_page": doc.sections, "metadata": metadata, "text_checks_passed": True,
              "source_md_sha256": hashlib.sha256(PAPER.read_bytes()).hexdigest(), "all_pages_visual_review": "pending",
              "layout_only_transformations": ["ASCII dash substitution", "Markdown inline styling", "Table1/2 split into aligned count/configuration and metric panels", "equivalent plain-text loss formula", "vector forest plot with source coordinates and issued SVG annotation"]}
    (OUT / "paper/layout_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pages": len(reader.pages), "PDF_sha256": report["sha256"], "sections": doc.sections}))

if __name__ == "__main__":
    main()

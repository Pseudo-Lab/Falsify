// Stirling-PDF MIT core; pinned cd48ccb288f66ff884cbb084bf101b875ed7ded7. See NOTICE.md and upstream/LICENSE.

// coordination/release-20261026/table-workbench/app/src/table-vendor/upstream/frontend/src/editor/core/tools/pdfTextEditor/model/Color.ts
var BLACK = { r: 0, g: 0, b: 0, a: 255 };

// coordination/release-20261026/table-workbench/app/src/table-vendor/upstream/frontend/src/editor/core/tools/pdfTextEditor/model/model/TableModel.ts
function defaultCellStyle(fontSize) {
  return {
    family: "Helvetica",
    fontSize,
    fill: { ...BLACK },
    align: "left",
    sourceFontId: "base14:Helvetica"
  };
}
var TableModel = class {
  id;
  pageIndex;
  /** Released grids remain in the session so existing undo steps can locate them. */
  editing = true;
  colEdges;
  rowEdges;
  /** Run id backing each cell, indexed [row][col]; null when the cell is empty. */
  cellRuns;
  // Further runs sharing a cell. OCR in particular splits one entry into
  // several text objects ("Q1 Sales" arrives as two), and a cell that tracks
  // only the first leaves the rest behind whenever the table moves.
  cellExtraRuns;
  // Merge structure, indexed [row][col] alongside cellRuns. An entry marks an
  // ANCHOR and how far it reaches; the positions it covers stay null in both
  // arrays, so every `if (!id) continue` loop keeps working untouched.
  cellSpans;
  /** Horizontal ruling-line object pointers, top-to-bottom. */
  hLinePtrs;
  /** Vertical ruling-line object pointers, left-to-right. */
  vLinePtrs;
  lineWidth;
  /** Colour the ruling lines are drawn in, copied from the table's own. */
  lineColor;
  // Background boxes the page paints behind whole rows (header shading), with
  // the rect each currently occupies so it can be refitted when the grid moves.
  rowFills;
  // The size the text was set for, and how much it has been scaled since. Text
  // scaling is derived from the table's size against THIS reference, never from
  // the last gesture: min(widthRatio, heightRatio) applied per drag does not
  // round-trip, so growing and shrinking repeatedly walked the type smaller.
  fontBase;
  fontSize;
  // False for a table adopted from recognized text: its rules (if any) are the
  // document's own objects, so structural edits must not draw or move any.
  ruled;
  /** True when the page draws this grid itself (an adopted ruled table). */
  pageRuled;
  // True when this grid wraps text the document already had, rather than one
  // the editor inserted - it can be handed back without deleting anything.
  adopted;
  // A picture with invisible OCR text over it: a structural edit has to rebuild
  // it as real objects before anything can move on screen.
  scanned;
  // Text style per column, so a cell filled later matches the ones already in
  // that column rather than reverting to the editor's defaults.
  columnStyles;
  /** Header-row style, when row 0 is set differently from the body. */
  headerStyle;
  constructor(init) {
    this.id = init.id;
    this.pageIndex = init.pageIndex;
    this.colEdges = init.colEdges;
    this.rowEdges = init.rowEdges;
    this.cellRuns = init.cellRuns;
    this.cellSpans = init.cellSpans ?? init.cellRuns.map((row) => row.map(() => null));
    this.cellExtraRuns = init.cellExtraRuns ?? init.cellRuns.map((row) => row.map(() => null));
    this.hLinePtrs = init.hLinePtrs;
    this.vLinePtrs = init.vLinePtrs;
    this.lineWidth = init.lineWidth;
    this.lineColor = init.lineColor ?? { ...BLACK };
    this.rowFills = init.rowFills ?? [];
    this.fontBase = {
      width: Math.max(
        1,
        init.colEdges[init.colEdges.length - 1] - init.colEdges[0]
      ),
      height: Math.max(
        1,
        init.rowEdges[0] - init.rowEdges[init.rowEdges.length - 1]
      ),
      scale: 1
    };
    this.fontSize = init.fontSize;
    this.ruled = init.ruled ?? true;
    this.pageRuled = init.pageRuled ?? false;
    this.adopted = init.adopted ?? false;
    this.scanned = init.scanned ?? false;
    const cols = init.colEdges.length - 1;
    this.columnStyles = Array.from(
      { length: Math.max(0, cols) },
      (_, c) => init.columnStyles?.[c] ?? defaultCellStyle(init.fontSize)
    );
    this.headerStyle = init.headerStyle ?? null;
  }
  // The style a cell should be written in. Alignment always comes from the
  // column - it is a property of the column, not of the header font - so the
  // header contributes only its face, size and colour.
  styleFor(row, col) {
    const column = this.columnStyles[col] ?? defaultCellStyle(this.fontSize);
    if (row === 0 && this.headerStyle) {
      return { ...this.headerStyle, align: column.align };
    }
    return column;
  }
  get rows() {
    return this.rowEdges.length - 1;
  }
  get cols() {
    return this.colEdges.length - 1;
  }
  /** Every run in this cell: the one that backs edits, then any others. */
  runsAt(row, col) {
    const primary = this.cellRuns[row]?.[col];
    if (!primary) return [];
    return [primary, ...this.cellExtraRuns[row]?.[col] ?? []];
  }
  /** How far the cell at (row, col) reaches; 1x1 unless the page merged it. */
  spanAt(row, col) {
    return this.cellSpans[row]?.[col] ?? { rowSpan: 1, colSpan: 1 };
  }
  // True when this position is swallowed by a merge anchored to its left or
  // above. Such a position holds no run and gets no cell of its own.
  isCovered(row, col) {
    for (let r = 0; r <= row; r++) {
      for (let c = 0; c <= col; c++) {
        if (r === row && c === col) continue;
        const span = this.cellSpans[r]?.[c];
        if (!span) continue;
        if (row < r + span.rowSpan && col < c + span.colSpan) return true;
      }
    }
    return false;
  }
  /** Rectangle of one cell in PDF page coords (y-up), spans included. */
  cellRect(row, col) {
    const { rowSpan, colSpan } = this.spanAt(row, col);
    const x = this.colEdges[col];
    const right = this.colEdges[Math.min(col + colSpan, this.cols)];
    const top = this.rowEdges[row];
    const bottom = this.rowEdges[Math.min(row + rowSpan, this.rows)];
    return { x, y: bottom, width: right - x, height: top - bottom };
  }
  snapshot() {
    const cells = [];
    const covered = /* @__PURE__ */ new Set();
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (covered.has(r * this.cols + c)) continue;
        const { rowSpan, colSpan } = this.spanAt(r, c);
        for (let rr = r; rr < Math.min(r + rowSpan, this.rows); rr++) {
          for (let cc = c; cc < Math.min(c + colSpan, this.cols); cc++) {
            if (rr !== r || cc !== c) covered.add(rr * this.cols + cc);
          }
        }
        cells.push({
          row: r,
          col: c,
          runIds: this.runsAt(r, c),
          colSpan,
          rowSpan,
          rect: this.cellRect(r, c)
        });
      }
    }
    const x = this.colEdges[0];
    const right = this.colEdges[this.colEdges.length - 1];
    const top = this.rowEdges[0];
    const bottom = this.rowEdges[this.rowEdges.length - 1];
    return {
      id: this.id,
      pageIndex: this.pageIndex,
      rows: this.rows,
      cols: this.cols,
      colEdges: [...this.colEdges],
      rowEdges: [...this.rowEdges],
      bounds: { x, y: bottom, width: right - x, height: top - bottom },
      cells,
      confidence: 1,
      synthetic: true,
      ruled: this.ruled,
      pageRuled: this.pageRuled,
      adopted: this.adopted,
      scanned: this.scanned,
      columnStyles: this.columnStyles.map((st) => ({
        ...st,
        fill: { ...st.fill }
      })),
      headerStyle: this.headerStyle ? { ...this.headerStyle, fill: { ...this.headerStyle.fill } } : null
    };
  }
};
export {
  TableModel,
  defaultCellStyle
};

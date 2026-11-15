const VALID_DIM = n => Number.isFinite(n) && n > 0;
const formatDim = n => Number(n.toFixed(4)).toString();

export function multirowPreambleLine() {
  return '\\IfFileExists{multirow.sty}{\\usepackage{multirow}}{\\providecommand{\\multirow}[3]{#3}}\n';
}

function nextFreeColumn(occupied, row, startCol) {
  let col = startCol;
  while (col < occupied[row].length && occupied[row][col]) col++;
  return col;
}

function claimGridSpan(occupied, row, col, rowSpan, colSpan, cell) {
  if (row + rowSpan > occupied.length || col + colSpan > occupied[0].length) return false;
  for (let rr = row; rr < row + rowSpan; rr++) {
    for (let cc = col; cc < col + colSpan; cc++) {
      if (occupied[rr][cc]) return false;
      occupied[rr][cc] = rr === row && cc === col ? {kind: 'origin', cell, col, rowSpan, colSpan} : {kind: 'covered', row, col, colSpan};
    }
  }
  return true;
}

function validCellSpan(cell) {
  const colSpan = cell?.colSpan ?? 1;
  const rowSpan = cell?.rowSpan ?? 1;
  return Number.isInteger(colSpan) && colSpan >= 1 && Number.isInteger(rowSpan) && rowSpan >= 1;
}

function fillTableRow(occupied, rowIndex, row, totalCols, validateCell) {
  if (!Array.isArray(row)) return null;
  let col = 0, hasRowSpan = false, hasColSpan = false;
  for (const cell of row) {
    col = nextFreeColumn(occupied, rowIndex, col);
    if (col >= totalCols || typeof cell?.text !== 'string' || !validCellSpan(cell)) return null;
    if (validateCell && !validateCell(cell)) return null;
    const colSpan = cell.colSpan ?? 1, rowSpan = cell.rowSpan ?? 1;
    hasColSpan = hasColSpan || colSpan > 1;
    hasRowSpan = hasRowSpan || rowSpan > 1;
    if (!claimGridSpan(occupied, rowIndex, col, rowSpan, colSpan, cell)) return null;
    col += colSpan;
  }
  return {hasRowSpan, hasColSpan};
}

/** Validate that table cells cleanly partition a rows x cols grid without overlaps or gaps. */
export function validateTableGrid(rows, validateCell = null) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length) return {valid: false};
  const totalCols = rows[0].reduce((sum, c) => sum + (Number.isInteger(c?.colSpan) && c.colSpan >= 1 ? c.colSpan : 1), 0);
  if (!Number.isInteger(totalCols) || totalCols < 1 || rows.length * totalCols > 400) return {valid: false};
  const occupied = Array.from({length: rows.length}, () => Array(totalCols).fill(null));
  let hasRowSpan = false, hasColSpan = false;
  for (let r = 0; r < rows.length; r++) {
    const res = fillTableRow(occupied, r, rows[r], totalCols, validateCell);
    if (!res) return {valid: false};
    hasRowSpan = hasRowSpan || res.hasRowSpan;
    hasColSpan = hasColSpan || res.hasColSpan;
  }
  if (occupied.some(row => row.some(slot => !slot))) return {valid: false};
  return {valid: true, cols: totalCols, hasRowSpan, hasColSpan, grid: occupied};
}

export function serializeTableCell(cell, colSpan, rowSpan, formatText) {
  const body = formatText(cell.text);
  const inner = rowSpan > 1 ? `\\multirow{${rowSpan}}{*}{${body}}` : body;
  return colSpan > 1 ? `\\multicolumn{${colSpan}}{l}{${inner}}` : inner;
}

function serializeGridRow(rowSlots, formatText) {
  const parts = [];
  for (let c = 0; c < rowSlots.length;) {
    const slot = rowSlots[c];
    if (slot.kind === 'origin') {
      parts.push(serializeTableCell(slot.cell, slot.colSpan, slot.rowSpan, formatText));
      c += slot.colSpan;
    } else if (slot.colSpan > 1) {
      parts.push(`\\multicolumn{${slot.colSpan}}{l}{}`);
      c += slot.colSpan;
    } else {
      parts.push('');
      c += 1;
    }
  }
  return parts.join(' & ') + ' \\\\';
}

export function serializeTabular(grid, cols, formatText, {resizeWidth = null} = {}) {
  const body = grid.map(row => serializeGridRow(row, formatText)).join('\n');
  const tabular = `\\begin{tabular}{${'l'.repeat(cols)}}\n${body}\n\\end{tabular}`;
  return resizeWidth ? `\\resizebox{${resizeWidth}}{!}{%\n${tabular}}` : tabular;
}

export function estimateTableDimensions(grid, cols, {sizeBp = 10, leadingBp = 12} = {}) {
  const colChars = Array(cols).fill(1);
  for (const row of grid) {
    for (let c = 0; c < cols; c++) {
      const slot = row[c];
      if (slot.kind !== 'origin') continue;
      const perCol = Math.ceil(slot.cell.text.length / slot.colSpan);
      for (let k = 0; k < slot.colSpan; k++) colChars[c + k] = Math.max(colChars[c + k], perCol);
    }
  }
  const charWidth = (VALID_DIM(sizeBp) ? sizeBp : 10) * 0.52;
  const widthBp = colChars.reduce((sum, n) => sum + n * charWidth + 12, 0);
  const rowHeightBp = Math.max(12, (VALID_DIM(leadingBp) ? leadingBp : 12) * 1.35);
  return {widthBp, heightBp: grid.length * rowHeightBp, rowHeightBp};
}

function rowHasSpanPast(rowSlots, rowIndex, endIndex) {
  return rowSlots.some(s => s.kind === 'origin' && rowIndex + s.rowSpan > endIndex);
}

function activeRowSpanExtendsPast(grid, startRow, candidateEnd) {
  for (let r = startRow; r < candidateEnd; r++) {
    if (rowHasSpanPast(grid[r], r, candidateEnd)) return true;
  }
  return false;
}

/** Split a validated grid into chunks without breaking any active rowSpan. */
export function splitTableGrid(grid, maxRowsPerChunk) {
  if (!Number.isInteger(maxRowsPerChunk) || maxRowsPerChunk < 1 || grid.length <= maxRowsPerChunk) return [grid];
  const chunks = [];
  let start = 0;
  while (start < grid.length) {
    let end = Math.min(grid.length, start + maxRowsPerChunk);
    while (end < grid.length && activeRowSpanExtendsPast(grid, start, end)) end++;
    if (start > 0 && grid[start].some(s => s.kind === 'covered')) {
      return [grid];
    }
    chunks.push(grid.slice(start, end));
    start = end;
  }
  return chunks;
}

export function formatBpDim(n) {
  return formatDim(n);
}

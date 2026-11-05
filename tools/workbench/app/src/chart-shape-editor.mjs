// FalsifyChartShapeEditor.create({host, scene, onChange, onCommit, onRequestExport, core})
// -> {setScene, getState, undo, redo, destroy}
// Load app/dist/chart-shape-editor.css and app/dist/chart-shape-editor.js.
// core is the supplied FalsifyChartShape, or globalThis.FalsifyChartShape when omitted.
// create() replaces the host's children. Pointer moves stay in the page; export is onRequestExport.

const BRANCH_JUMP_FACTOR = 4;
const SELECT_SPAN_FACTOR = 1.5;
const DEFORM_RADIUS_FACTOR = 2;
const MIN_DEFORM_RADIUS = 16;
const MAX_DEFORM_RADIUS = 160;
const MIN_SELECT_BUDGET = 12;
const NOOP_DISTANCE = 0.5;
const SCREEN_HIT_PX = 12;
const SCREEN_HANDLE_PX = 8;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const KEY_STEP = 1;
const KEY_STEP_LARGE = 10;
const KEY_WIDTH_FACTOR = 1.1;
const PRECISION_CAP = 400;
const SVG_NS = 'http://www.w3.org/2000/svg';

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(point) {
  return !!point && finite(point.x) && finite(point.y);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function medianSpacing(points) {
  const lengths = [];
  for (let i = 1; i < points.length; i += 1) {
    if (!isPoint(points[i]) || !isPoint(points[i - 1])) continue;
    const span = distance(points[i], points[i - 1]);
    if (span > 0) lengths.push(span);
  }
  if (!lengths.length) return 16;
  lengths.sort((a, b) => a - b);
  const mid = Math.floor(lengths.length / 2);
  return lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
}

function segmentLength(points, index) {
  if (!isPoint(points[index]) || !isPoint(points[index + 1])) return Infinity;
  return distance(points[index], points[index + 1]);
}

function branchBounds(points, index) {
  const spacing = medianSpacing(points);
  const jump = spacing * BRANCH_JUMP_FACTOR;
  let start = index;
  let end = index;
  while (start > 0 && segmentLength(points, start - 1) <= jump) start -= 1;
  while (end < points.length - 1 && segmentLength(points, end) <= jump) end += 1;
  return {start, end, spacing};
}

function selectionRange(points, index) {
  if (!points.length) return [0, 0];
  const safe = Math.max(0, Math.min(points.length - 1, index));
  const {start, end, spacing} = branchBounds(points, safe);
  const budget = Math.max(spacing * SELECT_SPAN_FACTOR, MIN_SELECT_BUDGET);
  let left = safe;
  let right = safe;
  let leftSpan = 0;
  let rightSpan = 0;
  while (left > start) {
    const step = segmentLength(points, left - 1);
    if (leftSpan + step > budget) break;
    leftSpan += step;
    left -= 1;
  }
  while (right < end) {
    const step = segmentLength(points, right);
    if (rightSpan + step > budget) break;
    rightSpan += step;
    right += 1;
  }
  if (left === right) {
    if (left > start) left -= 1;
    else if (right < end) right += 1;
  }
  return [left, right];
}

function deformRadius(points, index) {
  const {spacing} = branchBounds(points, Math.max(0, index));
  return Math.min(MAX_DEFORM_RADIUS, Math.max(MIN_DEFORM_RADIUS, spacing * DEFORM_RADIUS_FACTOR));
}

function normalizeRange(range, length) {
  if (!length) return [0, -1];
  let start = Number.isInteger(range?.[0]) ? range[0] : 0;
  let end = Number.isInteger(range?.[1]) ? range[1] : length - 1;
  if (start > end) [start, end] = [end, start];
  start = Math.max(0, Math.min(length - 1, start));
  end = Math.max(0, Math.min(length - 1, end));
  return [start, end];
}

function isCore(value) {
  return !!value && typeof value.applyPlan === 'function' && typeof value.hitTest === 'function';
}

function resolveCore(core) {
  if (arguments.length > 0 && core != null) {
    if (isCore(core)) return core;
    throw new Error('FalsifyChartShapeEditor.create requires FalsifyChartShape');
  }
  if (isCore(globalThis.FalsifyChartShape)) return globalThis.FalsifyChartShape;
  throw new Error('FalsifyChartShapeEditor.create requires FalsifyChartShape');
}

function usableHistory(history) {
  return !!history
    && typeof history.apply === 'function'
    && typeof history.preview === 'function'
    && typeof history.undo === 'function'
    && typeof history.redo === 'function'
    && typeof history.scene === 'function'
    && typeof history.operations === 'function'
    && typeof history.index === 'function'
    && typeof history.canUndo === 'function'
    && typeof history.canRedo === 'function';
}

function planScene(core, scene, operations) {
  const result = core.applyPlan(clone(scene), operations);
  const next = result?.scene && Array.isArray(result.scene.series)
    ? result.scene
    : (Array.isArray(result?.series) ? result : null);
  if (!next) throw new Error('FalsifyChartShape.applyPlan must return {scene}');
  return next;
}

function internalHistory(core, scene) {
  const baseline = clone(scene);
  const groups = [];
  let cursor = 0;
  const flat = () => groups.slice(0, cursor).flat();
  const at = ops => planScene(core, baseline, ops);
  return {
    baseline,
    index: () => cursor,
    operations: () => flat().map(op => clone(op)),
    scene: () => (cursor === 0 ? clone(baseline) : at(flat())),
    canUndo: () => cursor > 0,
    canRedo: () => cursor < groups.length,
    preview(operations) {
      const list = Array.isArray(operations) ? operations : [operations];
      return at(flat().concat(list));
    },
    apply(operations) {
      const list = (Array.isArray(operations) ? operations : [operations]).map(op => clone(op));
      groups.splice(cursor);
      groups.push(list);
      cursor += 1;
      return at(flat());
    },
    undo() {
      if (cursor > 0) cursor -= 1;
      return at(flat());
    },
    redo() {
      if (cursor < groups.length) cursor += 1;
      return at(flat());
    },
  };
}

function bindHistory(core, scene) {
  if (typeof core.createHistory === 'function') {
    const history = core.createHistory(clone(scene));
    if (usableHistory(history)) return history;
  }
  return internalHistory(core, scene);
}

function sceneSize(scene) {
  const width = Number(scene.width);
  const height = Number(scene.height);
  if (width > 0 && height > 0) return {width, height};
  let maxX = 1;
  let maxY = 1;
  for (const series of scene.series || []) {
    for (const point of series?.points || []) {
      if (!isPoint(point)) continue;
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {width: maxX, height: maxY};
}

function pngUrl(value) {
  if (!value) return '';
  const text = String(value);
  if (text.startsWith('data:') || text.startsWith('blob:')) return text;
  return `data:image/png;base64,${text}`;
}

function presentation(series) {
  const style = series.style || {};
  const attrs = {
    stroke: series.color || '#243126',
    'stroke-width': String(style.width ?? 1.5),
    fill: 'none',
    'stroke-linecap': style.lineCap || 'round',
    'stroke-linejoin': style.lineJoin || 'round',
    'stroke-opacity': String(style.opacity ?? 1),
  };
  if (Array.isArray(style.dashes) && style.dashes.length) attrs['stroke-dasharray'] = style.dashes.join(' ');
  else if (typeof style.dashes === 'string' && style.dashes) attrs['stroke-dasharray'] = style.dashes;
  return attrs;
}

function pointsAttr(points) {
  const parts = [];
  for (const point of points) {
    if (isPoint(point)) parts.push(`${point.x},${point.y}`);
  }
  return parts.join(' ');
}

function formatNumber(value) {
  if (!finite(value)) return '';
  return String(Math.round(value * 1000) / 1000);
}

function readNumber(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function isNoOp(op) {
  if (!op) return true;
  if (op.kind === 'deform' || op.kind === 'move') return Math.hypot(op.dx || 0, op.dy || 0) < NOOP_DISTANCE;
  if (op.kind === 'resize') return Math.abs((op.scaleX ?? 1) - 1) < 1e-3 && Math.abs((op.scaleY ?? 1) - 1) < 1e-3;
  if (op.kind === 'set-values') return !op.points?.length;
  return false;
}

function clampScale(value) {
  if (!finite(value) || value <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function seriesById(scene, seriesId) {
  return (scene?.series || []).find(item => item && item.id === seriesId) || null;
}

function rangePoints(points, range) {
  const [start, end] = normalizeRange(range, points.length);
  const found = [];
  for (let i = start; i <= end; i += 1) if (isPoint(points[i])) found.push(points[i]);
  return found;
}

function extreme(points, pick) {
  let chosen = null;
  for (const point of points) {
    if (!chosen || pick(point, chosen)) chosen = point;
  }
  return chosen;
}

function h(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function s(doc, tag, className) {
  const node = doc.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function attrs(node, values) {
  for (const [key, value] of Object.entries(values)) node.setAttribute(key, value);
  return node;
}

function handleName(target) {
  for (let node = target; node; node = node.parentElement || null) {
    const name = node.getAttribute?.('data-handle');
    if (name) return name;
  }
  return '';
}

function typingTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function normalizeHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  const seriesId = hit.seriesId ?? hit.series ?? hit.id;
  const index = hit.index ?? hit.pointIndex ?? hit.i;
  if ((typeof seriesId !== 'string' && typeof seriesId !== 'number') || !Number.isInteger(index) || index < 0) return null;
  return {seriesId, index, distance: finite(hit.distance) ? hit.distance : 0};
}

function validateEditorInputs(host, doc, options) {
  if (!host || typeof host.append !== 'function') throw new Error('FalsifyChartShapeEditor.create requires a host element');
  if (!doc?.createElement || !doc.createElementNS) throw new Error('FalsifyChartShapeEditor.create requires a document');
  if (!options.scene || !Array.isArray(options.scene.series)) throw new Error('FalsifyChartShapeEditor.create requires a scene with series');
}

function validPrecisionValue(seriesId,index,axis,value) {
  return !(seriesId == null || !Number.isInteger(index) || (axis !== 'x' && axis !== 'y') || value == null);
}

export function create(options = {}) {
  const host = options.host;
  const doc = options.document || host?.ownerDocument || globalThis.document;
  validateEditorInputs(host,doc,options);

  const core = resolveCore(options.core);
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
  const onRequestExport = typeof options.onRequestExport === 'function' ? options.onRequestExport : null;
  const listeners = [];
  let opSeq = 0;
  let history = bindHistory(core, options.scene);
  const state = {
    destroyed: false,
    baseRevision: finite(options.scene.revision) ? options.scene.revision : 0,
    selection: null,
    gesture: null,
    compare: false,
    backgroundPng: options.scene.backgroundPng || '',
    originalPng: options.scene.originalPng || '',
    size: sceneSize(options.scene),
  };

  const root = h(doc, 'div', 'falsify-shape-editor');
  root.tabIndex = 0;
  attrs(root, {
    tabindex: '0',
    role: 'application',
    'aria-label': '곡선 모양 편집',
  });
  const toolbar = h(doc, 'div', 'falsify-shape-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '곡선 편집 도구');
  const undoButton = h(doc, 'button', 'falsify-shape-button');
  const redoButton = h(doc, 'button', 'falsify-shape-button');
  const compareButton = h(doc, 'button', 'falsify-shape-button');
  const exportButton = h(doc, 'button', 'falsify-shape-button');
  for (const button of [undoButton, redoButton, compareButton, exportButton]) button.type = 'button';
  undoButton.textContent = '되돌리기';
  redoButton.textContent = '다시 실행';
  compareButton.textContent = '원본 비교';
  exportButton.textContent = '내보내기';
  undoButton.setAttribute('aria-label', '되돌리기');
  redoButton.setAttribute('aria-label', '다시 실행');
  compareButton.setAttribute('aria-label', '원본 비교');
  exportButton.setAttribute('aria-label', '내보내기');
  compareButton.setAttribute('aria-pressed', 'false');
  const status = h(doc, 'p', 'falsify-shape-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  toolbar.append(undoButton, redoButton, compareButton, exportButton, status);

  const stage = h(doc, 'div', 'falsify-shape-stage');
  const background = h(doc, 'img', 'falsify-shape-background');
  const original = h(doc, 'img', 'falsify-shape-original');
  background.alt = '';
  original.alt = '';
  background.setAttribute('aria-hidden', 'true');
  original.setAttribute('aria-hidden', 'true');
  background.style.pointerEvents = 'none';
  original.style.pointerEvents = 'none';
  const svg = s(doc, 'svg', 'falsify-shape-svg');
  svg.setAttribute('role', 'presentation');
  svg.setAttribute('focusable', 'false');
  stage.style.touchAction = 'none';
  stage.append(background, original, svg);

  const precision = h(doc, 'details', 'falsify-shape-precision');
  const summary = h(doc, 'summary');
  summary.textContent = '정밀 좌표';
  const algorithm = h(doc, 'p', 'falsify-shape-algorithm');
  algorithm.textContent = '곡선을 끌어 모양을 바꾸고, 양옆 손잡이는 폭, 가운데 손잡이는 위치와 높이입니다.';
  const keys = h(doc, 'p', 'falsify-shape-keys');
  keys.textContent = '키보드: 화살표는 위치, Shift는 10px, Alt와 좌우는 폭, Ctrl+Z는 되돌리기, Ctrl+Y는 다시 실행, Esc는 드래그 취소입니다.';
  const table = h(doc, 'table', 'falsify-shape-table');
  const caption = h(doc, 'caption');
  caption.textContent = '원본 이미지 좌표 · px';
  const thead = h(doc, 'thead');
  const headRow = h(doc, 'tr');
  for (const label of ['계열', '번호', 'x', 'y']) {
    const cell = h(doc, 'th');
    cell.textContent = label;
    headRow.append(cell);
  }
  thead.append(headRow);
  const precisionBody = h(doc, 'tbody');
  table.append(caption, thead, precisionBody);
  const limitNote = h(doc, 'p', 'falsify-shape-limit');
  limitNote.hidden = true;
  precision.append(summary, algorithm, keys, table, limitNote);
  root.append(toolbar, stage, precision);
  if (typeof host.replaceChildren === 'function') host.replaceChildren(root);
  else host.append(root);

  function assertLive() {
    if (state.destroyed) throw new Error('FalsifyChartShapeEditor instance was destroyed');
  }

  function listen(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  }

  function nextId(kind) {
    opSeq += 1;
    return `shape-${kind}-${opSeq}`;
  }

  function revision() {
    return state.baseRevision + history.index();
  }

  function contractOf(scene, extra) {
    const copy = clone(scene);
    copy.revision = revision();
    const operations = history.operations().concat(extra).map(op => clone(op));
    return {scene: copy, operations, revision: copy.revision};
  }

  function snapshot() {
    let body = null;
    if (state.gesture) {
      const op = state.gesture.operation();
      if (op && !isNoOp(op)) body = contractOf(history.preview([op]), [op]);
    }
    if (!body) body = contractOf(history.scene(), []);
    return {
      ...body,
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      compare: state.compare,
      selection: state.selection
        ? {seriesId: state.selection.seriesId, range: [...state.selection.range]}
        : null,
    };
  }

  function emitChange(body) {
    onChange?.({scene: body.scene, operations: body.operations, revision: body.revision});
  }

  function emitCommit(body) {
    onCommit?.({scene: body.scene, operations: body.operations, revision: body.revision});
  }

  function displayedScene() {
    if (state.gesture) {
      const op = state.gesture.operation();
      if (op && !isNoOp(op)) return history.preview([op]);
    }
    return history.scene();
  }

  function setStatus(text) {
    if (status.textContent !== text) status.textContent = text;
  }

  function statusText() {
    if (state.compare) return '원본과 비교하는 중입니다.';
    const gesture = state.gesture;
    if (gesture?.kind === 'deform') {
      if (gesture.op.dy < -NOOP_DISTANCE) return '봉우리를 올리는 중입니다.';
      if (gesture.op.dy > NOOP_DISTANCE) return '골을 만드는 중입니다.';
      return '곡선을 위아래로 미는 중입니다.';
    }
    if (gesture?.kind === 'resize') return '폭을 조절하는 중입니다.';
    if (gesture?.kind === 'move') return '위치와 높이를 옮기는 중입니다.';
    if (state.selection) return '양옆 손잡이는 폭, 가운데 손잡이는 위치와 높이입니다.';
    return '곡선을 누르면 그 부분을 위아래로 변형합니다.';
  }

  function screenScale() {
    const rect = stage.getBoundingClientRect?.() || {width: state.size.width, height: state.size.height};
    const width = rect.width > 0 ? rect.width : state.size.width;
    return state.size.width / width;
  }

  function eventPoint(event) {
    const rect = stage.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const x = (event.clientX - rect.left) * (state.size.width / rect.width);
    const y = (event.clientY - rect.top) * (state.size.height / rect.height);
    if (!finite(x) || !finite(y)) return null;
    return {x, y};
  }

  function focusRoot() {
    if (typeof root.focus !== 'function') return;
    try { root.focus({preventScroll: true}); }
    catch { root.focus(); }
  }

  function release(pointerId) {
    if (pointerId == null || typeof stage.releasePointerCapture !== 'function') return;
    if (typeof stage.hasPointerCapture === 'function' && !stage.hasPointerCapture(pointerId)) return;
    try { stage.releasePointerCapture(pointerId); }
    catch { /* capture already ended */ }
  }

  function focusInside(node) {
    let active = doc.activeElement || null;
    while (active) {
      if (active === node) return true;
      active = active.parentElement || null;
    }
    return false;
  }

  function renderTable(scene) {
    if (focusInside(precisionBody)) return;
    const selected = state.selection?.seriesId;
    const rows = [];
    let hidden = 0;
    for (const series of scene.series || []) {
      if (selected != null && series.id !== selected) continue;
      const points = series.points || [];
      const cap = Math.min(points.length, PRECISION_CAP);
      hidden += Math.max(0, points.length - cap);
      for (let index = 0; index < cap; index += 1) {
        if (!isPoint(points[index])) continue;
        rows.push({series, index, point: points[index]});
      }
    }
    precisionBody.replaceChildren(...rows.map(row => {
      const tr = h(doc, 'tr');
      const name = h(doc, 'td');
      name.textContent = row.series.name || String(row.series.id);
      const number = h(doc, 'td');
      number.textContent = String(row.index);
      const xCell = h(doc, 'td');
      const yCell = h(doc, 'td');
      const xInput = h(doc, 'input');
      const yInput = h(doc, 'input');
      for (const [input, axis, value] of [[xInput, 'x', row.point.x], [yInput, 'y', row.point.y]]) {
        input.type = 'text';
        input.value = formatNumber(value);
        input.inputMode = 'decimal';
        input.autocomplete = 'off';
        attrs(input, {
          'data-series-id': String(row.series.id),
          'data-index': String(row.index),
          'data-axis': axis,
          'aria-label': `${row.series.name || row.series.id} ${row.index} ${axis}`,
          inputmode: 'decimal',
          autocomplete: 'off',
        });
      }
      xCell.append(xInput);
      yCell.append(yInput);
      tr.append(name, number, xCell, yCell);
      return tr;
    }));
    limitNote.hidden = hidden === 0;
    limitNote.textContent = hidden ? `앞 ${PRECISION_CAP}점만 표시합니다. 나머지 ${hidden}점은 표에 없습니다.` : '';
  }

  function renderHandles(scene) {
    if (!state.selection || state.compare) return;
    const series = seriesById(scene, state.selection.seriesId);
    const points = rangePoints(series?.points || [], state.selection.range);
    if (points.length < 1) return;
    const left = extreme(points, (point, chosen) => point.x < chosen.x);
    const right = extreme(points, (point, chosen) => point.x > chosen.x);
    const center = points.reduce((sum, point) => ({x: sum.x + point.x, y: sum.y + point.y}), {x: 0, y: 0});
    center.x /= points.length;
    center.y /= points.length;
    const radius = String(Math.round(SCREEN_HANDLE_PX * screenScale() * 1000) / 1000);
    const handles = [
      ['width-start', '왼쪽 폭', 'falsify-shape-handle falsify-shape-handle-width', left],
      ['width-end', '오른쪽 폭', 'falsify-shape-handle falsify-shape-handle-width', right],
      ['move', '위치와 높이', 'falsify-shape-handle falsify-shape-handle-center', center],
    ];
    for (const [name, label, className, point] of handles) {
      svg.append(attrs(s(doc, 'circle', className), {
        'data-handle': name,
        cx: formatNumber(point.x),
        cy: formatNumber(point.y),
        r: radius,
        'aria-label': label,
        role: 'img',
      }));
    }
  }

  function renderRadius() {
    if (state.gesture?.kind !== 'deform') return;
    const [cx, cy] = state.gesture.op.center;
    svg.append(attrs(s(doc, 'circle', 'falsify-shape-radius'), {
      cx: formatNumber(cx),
      cy: formatNumber(cy),
      r: formatNumber(state.gesture.op.radius),
      'pointer-events': 'none',
    }));
  }

  function renderSvg(scene) {
    svg.replaceChildren();
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    attrs(svg, {
      viewBox: `0 0 ${state.size.width} ${state.size.height}`,
      preserveAspectRatio: 'none',
    });
    for (const series of scene.series || []) {
      const points = series?.points || [];
      if (!points.some(isPoint)) continue;
      const look = presentation(series);
      const paintedPoints = series.style?.closed && points.length > 1 ? [...points, points[0]] : points;
      const haloWidth = String((Number(look['stroke-width']) || 1.5) + 6);
      svg.append(attrs(s(doc, 'polyline', 'falsify-shape-halo'), {
        ...look,
        points: pointsAttr(paintedPoints),
        'stroke-width': haloWidth,
        'stroke-opacity': '0.25',
        'pointer-events': 'none',
      }));
      svg.append(attrs(s(doc, 'polyline', 'falsify-shape-curve'), {
        ...look,
        points: pointsAttr(paintedPoints),
        'data-series-id': String(series.id),
        'pointer-events': 'none',
      }));
      svg.append(attrs(s(doc, 'polyline', 'falsify-shape-hit'), {
        points: pointsAttr(paintedPoints),
        fill: 'none',
        stroke: 'transparent',
        'stroke-width': '16',
        'data-series-id': String(series.id),
      }));
    }
    renderRadius();
    renderHandles(scene);
  }

  function render(scene = displayedScene()) {
    stage.style.width = '100%';
    stage.style.maxWidth = '100%';
    stage.style.height = 'auto';
    stage.style.aspectRatio = `${state.size.width} / ${state.size.height}`;
    const backgroundSrc = pngUrl(state.backgroundPng);
    const originalSrc = pngUrl(state.originalPng);
    background.src = backgroundSrc;
    background.setAttribute('src', backgroundSrc);
    background.hidden = !backgroundSrc;
    original.src = originalSrc;
    original.setAttribute('src', originalSrc);
    original.hidden = !state.compare || !originalSrc;
    svg.style.visibility = state.compare ? 'hidden' : 'visible';
    stage.setAttribute('class', state.compare ? 'falsify-shape-stage is-comparing' : 'falsify-shape-stage');
    compareButton.setAttribute('aria-pressed', state.compare ? 'true' : 'false');
    undoButton.disabled = !history.canUndo() || !!state.gesture;
    redoButton.disabled = !history.canRedo() || !!state.gesture;
    exportButton.disabled = !!state.gesture;
    renderSvg(scene);
    if (!state.gesture) renderTable(scene);
    setStatus(statusText());
  }

  function bindScene(scene) {
    history = bindHistory(core, scene);
    state.baseRevision = finite(scene.revision) ? scene.revision : 0;
    state.selection = null;
    state.compare = false;
    state.backgroundPng = scene.backgroundPng || '';
    state.originalPng = scene.originalPng || '';
    state.size = sceneSize(scene);
  }

  function endGesture(commit) {
    const gesture = state.gesture;
    if (!gesture || gesture.settled) return;
    dropPreviewFrame();
    gesture.settled = true;
    release(gesture.pointerId);
    state.gesture = null;
    const op = gesture.operation();
    if (commit && op && !isNoOp(op)) {
      history.apply([op]);
      const body = snapshot();
      render();
      emitChange(body);
      emitCommit(body);
      return;
    }
    render();
    if (!commit && gesture.previewed) emitChange(snapshot());
  }

  function updateGesture(point) {
    const gesture = state.gesture;
    if (!gesture || !point) return;
    if (gesture.kind === 'deform' || gesture.kind === 'move') {
      gesture.op.dx = point.x - gesture.origin.x;
      gesture.op.dy = point.y - gesture.origin.y;
      return;
    }
    if (gesture.kind === 'resize') {
      const denominator = gesture.handle.x - gesture.anchor[0];
      const scaleX = Math.abs(denominator) < 1e-6 ? 1 : (point.x - gesture.anchor[0]) / denominator;
      gesture.op.scaleX = clampScale(scaleX);
      gesture.op.scaleY = 1;
    }
  }

  function publishPreview() {
    const op = state.gesture?.operation();
    if (!op || isNoOp(op)) {
      render();
      return;
    }
    state.gesture.previewed = true;
    render(history.preview([op]));
    emitChange(snapshot());
  }

  let previewFrame = 0;
  let previewScheduled = false;
  let previewEpoch = 0;

  function dropPreviewFrame() {
    previewEpoch += 1;
    previewScheduled = false;
    const frame = previewFrame;
    previewFrame = 0;
    if (frame && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(frame);
    }
  }

  function schedulePreview() {
    if (state.destroyed || previewScheduled) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') {
      publishPreview();
      return;
    }
    const epoch = previewEpoch;
    previewScheduled = true;
    previewFrame = raf(() => {
      previewScheduled = false;
      previewFrame = 0;
      if (epoch !== previewEpoch || state.destroyed || !state.gesture || state.gesture.settled) return;
      publishPreview();
    }) || 0;
  }

  function beginGesture(event, gesture) {
    state.gesture = gesture;
    if (event.pointerId != null && typeof stage.setPointerCapture === 'function') {
      try { stage.setPointerCapture(event.pointerId); }
      catch { /* the pointer may already be gone */ }
    }
    updateGesture(eventPoint(event) || gesture.origin);
    publishPreview();
  }

  function selectHit(hit, scene) {
    const series = seriesById(scene, hit.seriesId);
    const points = series?.points || [];
    if (!points.length || hit.index >= points.length) return null;
    const range = selectionRange(points, hit.index);
    state.selection = {seriesId: hit.seriesId, range};
    return series;
  }

  function startHandleGesture(event, name, scene, point) {
      const series = seriesById(scene, state.selection.seriesId);
      const spanned = rangePoints(series?.points || [], state.selection.range);
      if (!spanned.length) return;
      const left = extreme(spanned, (item, chosen) => item.x < chosen.x);
      const right = extreme(spanned, (item, chosen) => item.x > chosen.x);
      if (name === 'move') {
        beginGesture(event, {
          kind: 'move',
          pointerId: event.pointerId,
          settled: false,
          previewed: false,
          origin: point,
          op: {
            id: nextId('move'),
            kind: 'move',
            seriesId: state.selection.seriesId,
            range: [...state.selection.range],
            dx: 0,
            dy: 0,
          },
          operation() { return this.op; },
        });
        return;
      }
      const handle = name === 'width-start' ? left : right;
      const anchorPoint = name === 'width-start' ? right : left;
      beginGesture(event, {
        kind: 'resize',
        pointerId: event.pointerId,
        settled: false,
        previewed: false,
        origin: point,
        handle: {x: handle.x, y: handle.y},
        anchor: [anchorPoint.x, anchorPoint.y],
        op: {
          id: nextId('resize'),
          kind: 'resize',
          seriesId: state.selection.seriesId,
          range: [...state.selection.range],
          anchor: [anchorPoint.x, anchorPoint.y],
          scaleX: 1,
          scaleY: 1,
        },
        operation() { return this.op; },
      });
      return;
  }

  function onPointerDown(event) {
    if (state.destroyed || state.compare || state.gesture) return;
    if (event.button != null && event.button !== 0) return;
    const point = eventPoint(event);
    if (!point) return;
    focusRoot();
    event.preventDefault?.();
    const name = handleName(event.target);
    const scene = history.scene();
    if (name && state.selection) {
      startHandleGesture(event, name, scene, point);
      return;
    }
    const hit = normalizeHit(core.hitTest(scene, point.x, point.y, SCREEN_HIT_PX * screenScale()));
    if (!hit) {
      state.selection = null;
      render();
      return;
    }
    const series = selectHit(hit, scene);
    if (!series) return;
    const radius = deformRadius(series.points || [], hit.index);
    beginGesture(event, {
      kind: 'deform',
      pointerId: event.pointerId,
      settled: false,
      previewed: false,
      origin: point,
      op: {
        id: nextId('deform'),
        kind: 'deform',
        seriesId: hit.seriesId,
        center: [point.x, point.y],
        radius,
        dx: 0,
        dy: 0,
      },
      operation() { return this.op; },
    });
  }

  function onPointerMove(event) {
    if (!state.gesture || state.gesture.settled || event.pointerId !== state.gesture.pointerId) return;
    const point = eventPoint(event);
    if (!point) return;
    event.preventDefault?.();
    updateGesture(point);
    schedulePreview();
  }

  function onPointerUp(event) {
    if (!state.gesture || event.pointerId !== state.gesture.pointerId) return;
    const point = eventPoint(event);
    if (point) updateGesture(point);
    endGesture(true);
  }

  function onPointerCancel(event) {
    if (!state.gesture || event.pointerId !== state.gesture.pointerId) return;
    endGesture(false);
  }

  function onLostPointerCapture(event) {
    if (!state.gesture || state.gesture.settled || event.pointerId !== state.gesture.pointerId) return;
    endGesture(false);
  }

  function commitFinished(op) {
    if (!op || isNoOp(op)) return;
    history.apply([op]);
    const body = snapshot();
    render();
    emitChange(body);
    emitCommit(body);
  }

  function nudge(dx, dy) {
    if (!state.selection || state.compare || state.gesture) return;
    commitFinished({
      id: nextId('move'),
      kind: 'move',
      seriesId: state.selection.seriesId,
      range: [...state.selection.range],
      dx,
      dy,
    });
  }

  function scaleWidth(factor) {
    if (!state.selection || state.compare || state.gesture) return;
    const scene = history.scene();
    const series = seriesById(scene, state.selection.seriesId);
    const spanned = rangePoints(series?.points || [], state.selection.range);
    if (!spanned.length) return;
    const anchor = spanned.reduce((sum, point) => ({x: sum.x + point.x, y: sum.y + point.y}), {x: 0, y: 0});
    anchor.x /= spanned.length;
    anchor.y /= spanned.length;
    commitFinished({
      id: nextId('resize'),
      kind: 'resize',
      seriesId: state.selection.seriesId,
      range: [...state.selection.range],
      anchor: [anchor.x, anchor.y],
      scaleX: clampScale(factor),
      scaleY: 1,
    });
  }

  function undo() {
    assertLive();
    if (state.gesture || !history.canUndo()) return;
    history.undo();
    const body = snapshot();
    render();
    emitChange(body);
    setStatus('되돌렸습니다.');
  }

  function redo() {
    assertLive();
    if (state.gesture || !history.canRedo()) return;
    history.redo();
    const body = snapshot();
    render();
    emitChange(body);
    setStatus('다시 실행했습니다.');
  }

  function handleMovementKey(event,key) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    if (key === 'ArrowUp') nudge(0, -step);
    else if (key === 'ArrowDown') nudge(0, step);
    else if (key === 'ArrowLeft') {
      if (event.altKey) scaleWidth(1 / KEY_WIDTH_FACTOR);
      else nudge(-step, 0);
    }
    else if (key === 'ArrowRight') {
      if (event.altKey) scaleWidth(KEY_WIDTH_FACTOR);
      else nudge(step, 0);
    }
    else return false;
    return true;
  }

  function handleControlKey(event,key,mod) {
    if (mod && key.toLowerCase() === 'z') {
      event.preventDefault?.();
      if (event.shiftKey) redo();
      else undo();
      return true;
    }
    if (mod && key.toLowerCase() === 'y') {
      event.preventDefault?.();
      redo();
      return true;
    }
    if (key === 'Escape') {
      event.preventDefault?.();
      if (state.gesture) endGesture(false);
      else if (state.selection) {
        state.selection = null;
        render();
      }
      return true;
    }
    return false;
  }

  function onKeyDown(event) {
    if (state.destroyed) return;
    if (event.key === 'Escape' && typingTarget(event.target)) {
      event.preventDefault?.();
      event.target.blur?.();
      return;
    }
    if (typingTarget(event.target)) return;
    const key = String(event.key || '');
    const mod = !!(event.ctrlKey || event.metaKey);
    if (handleControlKey(event,key,mod)) return;
    if (!state.selection || state.compare || state.gesture) return;
    if (!handleMovementKey(event,key)) return;
    event.preventDefault?.();
  }

  function onPrecisionChange(event) {
    const input = event.target;
    if (!input || input.tagName !== 'INPUT' || state.gesture || state.compare) return;
    const seriesId = input.getAttribute('data-series-id');
    const index = Number(input.getAttribute('data-index'));
    const axis = input.getAttribute('data-axis');
    const value = readNumber(input.value);
    if (!validPrecisionValue(seriesId,index,axis,value)) return;
    const scene = history.scene();
    const series = (scene.series || []).find(item => String(item.id) === seriesId);
    const point = series?.points?.[index];
    if (!isPoint(point)) return;
    const x = axis === 'x' ? value : point.x;
    const y = axis === 'y' ? value : point.y;
    if (x === point.x && y === point.y) return;
    const numericId = series.id;
    commitFinished({
      id: nextId('set-values'),
      kind: 'set-values',
      seriesId: numericId,
      points: [{index, x, y}],
    });
  }

  function toggleCompare() {
    if (!state.originalPng) {
      state.compare = false;
      render();
      setStatus('비교할 원본 이미지가 없습니다.');
      return;
    }
    state.compare = !state.compare;
    if (state.gesture) endGesture(false);
    render();
  }

  function requestExport() {
    if (state.destroyed || state.gesture) return;
    const body = snapshot();
    onRequestExport?.({scene: body.scene, operations: body.operations, revision: body.revision});
  }

  listen(stage, 'pointerdown', onPointerDown);
  listen(stage, 'pointermove', onPointerMove);
  listen(stage, 'pointerup', onPointerUp);
  listen(stage, 'pointercancel', onPointerCancel);
  listen(stage, 'lostpointercapture', onLostPointerCapture);
  listen(root, 'keydown', onKeyDown);
  listen(undoButton, 'click', () => undo());
  listen(redoButton, 'click', () => redo());
  listen(compareButton, 'click', () => toggleCompare());
  listen(exportButton, 'click', () => requestExport());
  listen(precisionBody, 'change', onPrecisionChange);
  render();

  return {
    setScene(scene) {
      assertLive();
      if (!scene || !Array.isArray(scene.series)) throw new Error('FalsifyChartShapeEditor.setScene requires a scene with series');
      dropPreviewFrame();
      if (state.gesture) {
        state.gesture.settled = true;
        release(state.gesture.pointerId);
        state.gesture = null;
      }
      bindScene(scene);
      render();
      emitChange(snapshot());
    },
    getState() {
      assertLive();
      return snapshot();
    },
    undo,
    redo,
    destroy() {
      if (state.destroyed) return;
      dropPreviewFrame();
      state.destroyed = true;
      if (state.gesture) {
        state.gesture.settled = true;
        release(state.gesture.pointerId);
        state.gesture = null;
      }
      for (const off of listeners) off();
      listeners.length = 0;
      if (typeof root.remove === 'function') root.remove();
      if (typeof host.replaceChildren === 'function') host.replaceChildren();
    },
  };
}

export const EDITOR_CSS = `/* Falsify chart shape editor. No remote assets. */
.falsify-shape-editor {
  color: #1d1a16;
  background: #f7f4ee;
  font: 14px/1.45 "Segoe UI", sans-serif;
  display: grid;
  gap: 8px;
  padding: 8px;
  box-sizing: border-box;
}
.falsify-shape-editor:focus {
  outline: 2px solid #1d1a16;
  outline-offset: 2px;
}
.falsify-shape-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.falsify-shape-button {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid #1d1a16;
  background: #fffdf8;
  color: #1d1a16;
  font: inherit;
  cursor: pointer;
}
.falsify-shape-button[aria-pressed="true"] {
  background: #1d1a16;
  color: #fffdf8;
}
.falsify-shape-button:disabled {
  cursor: default;
  opacity: 0.45;
}
.falsify-shape-status {
  margin: 0;
  flex: 1 1 12em;
}
.falsify-shape-stage {
  position: relative;
  width: 100%;
  max-width: 100%;
  height: auto;
  touch-action: none;
  background: #ebe6dc;
  cursor: ns-resize;
  user-select: none;
  overflow: hidden;
}
.falsify-shape-background,
.falsify-shape-original,
.falsify-shape-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.falsify-shape-background,
.falsify-shape-original {
  object-fit: fill;
  pointer-events: none;
}
.falsify-shape-original {
  z-index: 2;
}
.falsify-shape-svg {
  z-index: 3;
  overflow: hidden;
  touch-action: none;
}
.falsify-shape-stage.is-comparing .falsify-shape-svg {
  visibility: hidden;
}
.falsify-shape-halo,
.falsify-shape-radius {
  pointer-events: none;
}
.falsify-shape-radius {
  fill: rgba(29, 26, 22, 0.08);
  stroke: rgba(29, 26, 22, 0.55);
  stroke-width: 1;
}
.falsify-shape-handle {
  fill: #fffdf8;
  stroke: #1d1a16;
  stroke-width: 2px;
  vector-effect: non-scaling-stroke;
}
.falsify-shape-handle-width {
  cursor: ew-resize;
}
.falsify-shape-handle-center {
  fill: #1d1a16;
  stroke: #fffdf8;
  cursor: move;
}
.falsify-shape-precision {
  background: #fffdf8;
  border: 1px solid #d9d2c5;
  padding: 8px;
}
.falsify-shape-table {
  border-collapse: collapse;
  margin: 8px 0;
}
.falsify-shape-table th,
.falsify-shape-table td {
  border-bottom: 1px solid #d9d2c5;
  padding: 2px 6px;
  text-align: left;
  font-weight: 400;
}
.falsify-shape-table input {
  font: 12px/1.4 ui-monospace, Consolas, monospace;
  color: #1d1a16;
  background: #fffdf8;
  border: 1px solid #d9d2c5;
  box-sizing: border-box;
  width: 8ch;
}
`;

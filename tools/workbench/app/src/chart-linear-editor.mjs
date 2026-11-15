import {knotBounds} from './chart-linear-core.mjs';
const NS = 'http://www.w3.org/2000/svg';
const clone = value => JSON.parse(JSON.stringify(value));
const png = value => `data:image/png;base64,${value}`;

function element(doc, tag, parent, text, svg = false) {
  const node = svg ? doc.createElementNS(NS, tag) : doc.createElement(tag);
  if (text) node.textContent = text;
  parent.append(node);
  return node;
}
function attrs(node, values) {
  for (const [key, value] of Object.entries(values)) node.setAttribute(key, String(value));
  return node;
}
function projection(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return {x: a.x + t * dx, y: a.y + t * dy};
}
function nearest(scene, p, tolerance) {
  const hits = [];
  for (const track of scene.linearTracks) {
    for (const knot of track.knots) {
      hits.push({track, knot, x: knot.x, y: knot.y, distance: Math.hypot(p.x - knot.x, p.y - knot.y), point: true});
    }
    track.knots.slice(1).forEach((b, i) => {
      const at = projection(p, track.knots[i], b);
      hits.push({track, knot: null, ...at, distance: Math.hypot(p.x - at.x, p.y - at.y), point: false});
    });
  }
  const close = hits.filter(hit => hit.distance <= tolerance);
  // Prefer a visible control point over its adjacent segment inside its hit target.
  close.sort((a, b) => Number(b.point) - Number(a.point) || a.distance - b.distance);
  return close[0] || null;
}

function decorationBox(decoration, track) {
  const source = track.sourceKnots.find(k => k.id === decoration.knotId);
  const target = track.knots.find(k => k.id === decoration.knotId);
  return decoration.bbox.map((v, i) => v + (i % 2 ? target.y - source.y : target.x - source.x));
}
function paintTrack(doc, svg, track) {
  const unchanged = JSON.stringify(track.knots) === JSON.stringify(track.sourceKnots);
  if (unchanged) {
    attrs(element(doc, 'image', svg, '', true), {href: png(track.inkPng), width: '100%', height: '100%'});
    return;
  }
  attrs(element(doc, 'polyline', svg, '', true), {
    points: track.knots.map(k => `${k.x},${k.y}`).join(' '), fill: 'none',
    stroke: track.color, 'stroke-width': track.width, 'stroke-linejoin': 'miter',
  });
  for (const decoration of track.decorations) {
    const [x, y, right, bottom] = decorationBox(decoration, track);
    attrs(element(doc, 'image', svg, '', true), {href: png(decoration.png), x, y, width: right - x, height: bottom - y});
  }
}

export function createLinearEditor(options) {
  const {host} = options, doc = options.document || host.ownerDocument;
  const core = options.core || globalThis.FalsifyChartShape;
  let baseline = clone(options.scene), history = core.createHistory(baseline);
  let current = history.scene(), gesture = null, selected = null, comparing = false, sequence = 0;
  const listeners = [];
  const root = element(doc, 'div', host); root.className = 'falsify-shape-editor'; root.tabIndex = 0;
  attrs(root, {role: 'application', 'aria-label': '꺾은선 그래프 편집'});
  const toolbar = element(doc, 'div', root); toolbar.className = 'falsify-shape-toolbar';
  const button = (label, fn) => {
    const b = element(doc, 'button', toolbar, label); b.type = 'button'; b.className = 'falsify-shape-button';
    b.addEventListener('click', fn); return b;
  };
  const undoButton = button('되돌리기', () => travel('undo'));
  const redoButton = button('다시 실행', () => travel('redo'));
  const compareButton = button('원본 비교', () => {cancel(); comparing = !comparing; render();});
  const exportButton = button('내보내기', () => {if (!gesture) options.onRequestExport?.(snapshot());});
  exportButton.hidden = options.embedded === true;
  const status = element(doc, 'p', toolbar); status.className = 'falsify-shape-status';
  attrs(status, {role: 'status', 'aria-live': 'polite'});
  const stage = element(doc, 'div', root); stage.className = 'falsify-shape-stage';
  const background = element(doc, 'img', stage); background.className = 'falsify-shape-background'; background.alt = '';
  const svg = element(doc, 'svg', stage, '', true); svg.setAttribute('class', 'falsify-shape-svg');
  const detail = element(doc, 'details', root);
  element(doc, 'summary', detail, '선택한 점의 정밀 좌표');
  const fields = ['x', 'y'].map(axis => {
    const label = element(doc, 'label', detail, `${axis} (px) `);
    const input = element(doc, 'input', label); input.type = 'number'; input.step = '0.1';
    input.setAttribute('aria-label', `${axis} 좌표`); return input;
  });
  element(doc, 'p', root, '점을 끌면 이웃 점까지 직선으로 이어집니다. 선 중간을 끌면 조절점이 생깁니다.');
  const listen = (node, event, fn) => {
    node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn));
  };
  function snapshot() {
    return {scene: clone(current), operations: history.operations(), revision: (baseline.revision || 0) + history.index(),
      canUndo: history.canUndo(), canRedo: history.canRedo(), selection: clone(selected)};
  }
  function emit(commit = false) {
    const value = snapshot(); options.onChange?.(value); if (commit) options.onCommit?.(value);
  }
  function render() {
    stage.style.aspectRatio = `${current.width} / ${current.height}`;
    attrs(svg, {viewBox: `0 0 ${current.width} ${current.height}`, width: '100%', height: '100%'});
    background.src = png(comparing ? baseline.originalPng : current.linearBasePng);
    svg.replaceChildren();
    if (!comparing) for (const track of current.linearTracks) paintTrack(doc, svg, track);
    const knot = selected && current.linearTracks.find(t => t.id === selected.seriesId)?.knots.find(k => k.id === selected.knotId);
    if (knot && !comparing) attrs(element(doc, 'circle', svg, '', true), {
      cx: knot.x, cy: knot.y, r: 5, fill: 'none', stroke: '#1d1a16', 'stroke-width': 1, 'pointer-events': 'none',
    });
    fields.forEach((input, i) => {input.disabled = !knot; input.value = knot ? String(knot[i ? 'y' : 'x']) : '';});
    undoButton.disabled = !history.canUndo(); redoButton.disabled = !history.canRedo();
    compareButton.setAttribute('aria-pressed', String(comparing));
    status.textContent = gesture ? '드래그 중' : `변경 ${history.index()}회`;
  }
  function position(event) {
    const box = stage.getBoundingClientRect();
    return {x: (event.clientX - box.left) * current.width / box.width,
      y: (event.clientY - box.top) * current.height / box.height};
  }
  function operation(hit, y) {
    return {id: `linear-${++sequence}`, kind: 'linear-edit', seriesId: hit.track.id,
      knotId: hit.knot?.id || null, target: [hit.x, y]};
  }
  function down(event) {
    if (comparing || gesture || event.button !== 0) return;
    const p = position(event), box = stage.getBoundingClientRect();
    const hit = nearest(current, p, current.width / box.width * 12);
    if (!hit) return;
    selected = hit.knot ? {seriesId: hit.track.id, knotId: hit.knot.id} : null;
    gesture = {id: event.pointerId, hit, start: p, operation: operation(hit, hit.y), moved: false};
    stage.setPointerCapture?.(event.pointerId); root.focus(); event.preventDefault();
    options.onGestureChange?.(true); render();
  }
  function move(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const p = position(event), dy = p.y - gesture.start.y;
    const bounds = knotBounds(gesture.hit.track, gesture.hit.knot?.id, current.width, current.height);
    const y = Math.max(bounds[1], Math.min(bounds[3], gesture.hit.y + dy));
    gesture.operation.target[1] = y;
    gesture.moved = Math.abs(y - gesture.hit.y) > 0.5;
    current = gesture.moved ? history.preview([gesture.operation]) : history.scene();
    render();
  }
  function finish(event, commit) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const saved = gesture; gesture = null;
    if (commit && saved.moved) {
      current = history.apply([saved.operation]);
      selected = {seriesId: saved.operation.seriesId, knotId: saved.operation.knotId || `edit-${saved.operation.id}`};
    } else current = history.scene();
    if (stage.hasPointerCapture?.(saved.id)) stage.releasePointerCapture(saved.id);
    render(); emit(commit && saved.moved); options.onGestureChange?.(false);
  }
  function cancel() {if (gesture) finish({pointerId: gesture.id}, false);}
  function travel(direction) {
    cancel(); current = history[direction](); selected = null; comparing = false; render(); emit(true);
  }
  function precision() {
    if (!selected) return;
    const op = {id: `linear-${++sequence}`, kind: 'linear-edit', ...selected, target: fields.map(f => Number(f.value))};
    if (fields.some(f => !f.value.trim())) {render(); return;}
    const knot = current.linearTracks.find(t => t.id === selected.seriesId).knots.find(k => k.id === selected.knotId);
    if (knot.x === op.target[0] && knot.y === op.target[1]) return;
    try {current = history.apply([op]);}
    catch (error) {render(); status.textContent = '선택 영역 안에서 이웃 점 사이의 좌표를 입력하세요.'; return;}
    render(); emit(true);
  }
  function key(event) {
    if (event.target?.tagName === 'INPUT') return;
    if (event.key === 'Escape') cancel();
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'z') {event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo');}
    if (event.key.toLowerCase() === 'y') {event.preventDefault(); travel('redo');}
  }
  listen(stage, 'pointerdown', down); listen(stage, 'pointermove', move);
  listen(stage, 'pointerup', event => {move(event); finish(event, true);});
  listen(stage, 'pointercancel', event => finish(event, false));
  listen(stage, 'lostpointercapture', event => finish(event, false));
  listen(root, 'keydown', key); fields.forEach(input => listen(input, 'change', precision));
  host.replaceChildren(root); render();
  return {getState: snapshot, undo: () => travel('undo'), redo: () => travel('redo'),
    setScene(scene) {cancel(); baseline = clone(scene); history = core.createHistory(baseline); current = history.scene(); selected = null; comparing = false; render(); emit();},
    destroy() {cancel(); listeners.forEach(off => off()); root.remove();}};
}

import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {create, EDITOR_CSS} from '../src/chart-shape-editor.mjs';

const pendingFrames = [];
let nextFrameId = 1;
globalThis.requestAnimationFrame = callback => {
  const id = nextFrameId;
  nextFrameId += 1;
  pendingFrames.push({id, callback});
  return id;
};
globalThis.cancelAnimationFrame = id => {
  const index = pendingFrames.findIndex(frame => frame.id === id);
  if (index >= 0) pendingFrames.splice(index, 1);
};
function flushFrames() {
  const batch = pendingFrames.splice(0, pendingFrames.length);
  for (const frame of batch) frame.callback(0);
}

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = spawnSync(process.execPath, [resolve(app, 'scripts/build-chart-shape-editor.mjs')], {
  cwd: app,
  encoding: 'utf8',
});
if (built.status !== 0) throw new Error(built.stderr || built.stdout || 'chart shape editor build failed');

const bundleText = readFileSync(resolve(app, 'dist/chart-shape-editor.js'), 'utf8');
const coreText = readFileSync(resolve(app, 'dist/chart-shape-core.js'), 'utf8');
const cssText = readFileSync(resolve(app, 'dist/chart-shape-editor.css'), 'utf8');
const sourceText = readFileSync(resolve(app, 'src/chart-shape-editor.mjs'), 'utf8');

function specifiedPx(value) {
  if (typeof value !== 'string' || !value.trim() || value.endsWith('%') || value === 'auto') return 0;
  const px = Number.parseFloat(value);
  return px > 0 ? px : 0;
}

function availableWidth(el) {
  let node = el;
  while (node) {
    const px = specifiedPx(node.style?.width);
    if (px > 0) return px;
    node = node.parentElement;
  }
  return 0;
}

function viewBoxSize(el) {
  for (const child of el.children || []) {
    const box = child.getAttribute?.('viewBox');
    if (!box) continue;
    const parts = box.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return {width: parts[2], height: parts[3]};
  }
  return null;
}

function layoutRect(el) {
  const explicit = specifiedPx(el.style?.width);
  const percent = typeof el.style?.width === 'string' && el.style.width.trim().endsWith('%');
  let width = explicit;
  if (!width && percent) {
    const parentW = availableWidth(el.parentElement);
    const pct = Number.parseFloat(el.style.width) / 100;
    if (parentW > 0 && pct > 0) width = parentW * pct;
  }
  const scene = viewBoxSize(el);
  if (!(width > 0) && scene) width = scene.width;
  const maxSpec = el.style?.maxWidth;
  if (typeof maxSpec === 'string' && maxSpec.trim().endsWith('%')) {
    const parentW = availableWidth(el.parentElement);
    const pct = Number.parseFloat(maxSpec) / 100;
    if (parentW > 0 && pct > 0 && width > 0) width = Math.min(width, parentW * pct);
  } else {
    const maxPx = specifiedPx(maxSpec);
    if (maxPx > 0 && width > 0) width = Math.min(width, maxPx);
  }
  let height = specifiedPx(el.style?.height);
  if (!(height > 0)) {
    const ratio = String(el.style?.aspectRatio || '');
    const match = ratio.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    const aspect = match && Number(match[2]) > 0
      ? Number(match[1]) / Number(match[2])
      : (scene && scene.height > 0 ? scene.width / scene.height : 0);
    if (width > 0 && aspect > 0) height = width / aspect;
  }
  width = width > 0 ? width : 0;
  height = height > 0 ? height : 0;
  return {x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height};
}

function createDom() {
  let active = null;
  function element(tag) {
    const el = new EventTarget();
    const attrs = {};
    const classes = new Set();
    el.tagName = String(tag).toUpperCase();
    el.children = [];
    el.parentElement = null;
    el.style = {};
    el.dataset = {};
    el.hidden = false;
    el.disabled = false;
    el.open = false;
    el.value = '';
    el.type = '';
    el.alt = '';
    el.src = '';
    el.tabIndex = 0;
    el.readOnly = false;
    el.rows = 0;
    el._listeners = [];
    Object.defineProperty(el, 'className', {
      get() { return [...classes].join(' '); },
      set(value) {
        classes.clear();
        for (const part of String(value || '').split(/\s+/)) if (part) classes.add(part);
        attrs.class = [...classes].join(' ');
      },
    });
    el.setAttribute = (name, value) => {
      const text = String(value);
      attrs[name] = text;
      if (name === 'class') el.className = text;
    };
    el.getAttribute = name => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null);
    el.removeAttribute = name => { delete attrs[name]; };
    el.append = (...nodes) => {
      for (const node of nodes) {
        if (node == null) continue;
        node.parentElement = el;
        el.children.push(node);
      }
    };
    el.replaceChildren = (...nodes) => {
      for (const child of el.children) if (child) child.parentElement = null;
      el.children = [];
      el.append(...nodes);
    };
    el.remove = () => {
      const parent = el.parentElement;
      if (!parent?.children) {
        el.parentElement = null;
        return;
      }
      parent.children = parent.children.filter(child => child !== el);
      el.parentElement = null;
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get() { return text; },
      set(value) {
        text = value == null ? '' : String(value);
        for (const child of el.children) if (child) child.parentElement = null;
        el.children = [];
      },
    });
    el.addEventListener = (type, fn) => {
      el._listeners.push({type, fn, capture: false});
      EventTarget.prototype.addEventListener.call(el, type, fn);
    };
    el.removeEventListener = (type, fn) => {
      el._listeners = el._listeners.filter(item => item.type !== type || item.fn !== fn);
      EventTarget.prototype.removeEventListener.call(el, type, fn);
    };
    el.setPointerCapture = id => { el._capture = id; };
    el.hasPointerCapture = id => el._capture === id;
    el.releasePointerCapture = id => {
      if (el._capture !== id) return;
      el._capture = null;
      emit(el, 'lostpointercapture', {pointerId: id});
    };
    el.getBoundingClientRect = () => layoutRect(el);
    el.focus = () => {
      active = el;
      el._focused = true;
    };
    el.blur = () => {
      if (active === el) active = null;
    };
    return el;
  }
  function invoke(node, event, capture) {
    event.currentTarget = node;
    for (const item of [...(node._listeners || [])]) {
      if (item.type === event.type && item.capture === capture) item.fn.call(node, event);
    }
  }
  function emit(target, type, init = {}) {
    if (type === 'click' && target.disabled) return null;
    const event = {
      type,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      button: 0,
      pointerId: 1,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      key: '',
      clientX: 0,
      clientY: 0,
      target,
      currentTarget: target,
      _stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
      ...init,
      target,
    };
    const chain = [];
    for (let node = target; node; node = node.parentElement) chain.push(node);
    for (let i = chain.length - 1; i >= 0; i -= 1) invoke(chain[i], event, true);
    for (const node of chain) {
      if (event._stopped) break;
      invoke(node, event, false);
    }
    return event;
  }
  const document = {
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    get activeElement() { return active; },
  };
  return {document, element, emit};
}

function scene() {
  return {
    sceneId: 'fixture-scene',
    sourceFileHash: 'abc123',
    pageIndex: 0,
    bbox: [0, 0, 400, 200],
    width: 200,
    height: 100,
    plotBbox: [11, 13, 191, 89],
    revision: 0,
    backgroundPng: 'AAAA',
    originalPng: 'BBBB',
    axes: {x: 'linear', y: 'linear'},
    series: [
      {
        id: 'a',
        name: 'A',
        color: '#c45c26',
        style: {width: 2.5, dashes: [4, 2], opacity: 0.9, lineCap: 'butt', lineJoin: 'miter'},
        points: [
          {x: 20, y: 50, sample: 1},
          {x: 60, y: 50, sample: 2},
          {x: 100, y: 50, sample: 3},
          {x: 140, y: 50, sample: 4},
          {x: 180, y: 50, sample: 5},
        ],
      },
      {
        id: 'b',
        color: '#205060',
        points: [
          {x: 20, y: 80},
          {x: 100, y: 80},
          {x: 180, y: 80},
        ],
      },
    ],
  };
}

function branchScene() {
  return {
    sceneId: 'branch',
    sourceFileHash: 'branch',
    pageIndex: 0,
    bbox: [0, 0, 220, 80],
    width: 220,
    height: 80,
    plotBbox: [0, 0, 220, 80],
    revision: 0,
    series: [{
      id: 'a',
      color: '#222222',
      points: [
        {x: 0, y: 0, sample: 'keep'},
        {x: 10, y: 4, sample: 'spike'},
        {x: 20, y: 0, sample: 'mid'},
        {x: 30, y: -3, sample: 'dip'},
        {x: 40, y: 0, sample: 'end'},
        {x: 200, y: 0, sample: 'jump'},
        {x: 12, y: 0, sample: 'other'},
      ],
    }],
  };
}

function walk(node, out = []) {
  if (node?.tagName) out.push(node);
  for (const child of node?.children || []) walk(child, out);
  return out;
}

function byClass(host, className) {
  return walk(host).filter(el => el.className.split(/\s+/).includes(className));
}

function one(host, className) {
  const found = byClass(host, className);
  assert.equal(found.length > 0, true, className);
  return found[0];
}

function button(host, label) {
  const found = walk(host).find(el => el.tagName === 'BUTTON' && el.textContent === label);
  assert.ok(found, label);
  return found;
}

function curves(host) {
  return byClass(host, 'falsify-shape-curve');
}

function handles(host) {
  return walk(host).filter(el => el.getAttribute('data-handle') && !el.className.includes('falsify-shape-handle-hit'));
}

function handle(host, name) {
  const found = handles(host).find(el => el.getAttribute('data-handle') === name);
  assert.ok(found, name);
  return found;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function pointsOf(editor, seriesId = 'a') {
  return editor.getState().scene.series.find(item => item.id === seriesId).points;
}

function mount(source = scene(), hooks = {}) {
  const dom = createDom();
  const host = dom.element('div');
  if (hooks.parentWidth) host.style.width = `${hooks.parentWidth}px`;
  const changes = [];
  const commits = [];
  const exports = [];
  const editor = create({
    host,
    embedded: hooks.embedded,
    scene: source,
    document: dom.document,
    core: hooks.core === undefined ? loadShapeCore() : hooks.core,
    onChange(state) { changes.push(structuredClone(state)); hooks.onChange?.(state); },
    onCommit(state) { commits.push(structuredClone(state)); hooks.onCommit?.(state); },
    onGestureChange: hooks.onGestureChange,
    onRequestExport(state) { exports.push(structuredClone(state)); },
  });
  return {dom, host, editor, changes, commits, exports};
}

function pointer(dom, target, type, x, y, extra = {}) {
  const event = dom.emit(target, type, {clientX: x, clientY: y, pointerId: 1, button: 0, ...extra});
  flushFrames();
  return event;
}

function renderedPoints(host, seriesId = 'a') {
  const curve = curves(host).find(el => el.getAttribute('data-series-id') === seriesId);
  return curve ? curve.getAttribute('points') : '';
}

function selectMiddle(session) {
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointerup', 100, 50);
  return stage;
}

function linearScene() {
  const value = scene();
  const knots = [{id: 'k0', x: 20, y: 50}, {id: 'k1', x: 100, y: 50}, {id: 'k2', x: 180, y: 50}];
  value.linearBasePng = 'AAAA';
  value.linearTracks = [{id: 'line-1', color: '#c45c26', width: 2, knots,
    sourceKnots: structuredClone(knots), inkPng: 'AAAA',
    decorations: [{knotId: 'k1', bbox: [96, 40, 104, 60], png: 'AAAA'}]}];
  return value;
}

test('linear point moves with decorations and one undo preserves the preceding drag', () => {
  const lifecycle = [];
  const s = mount(linearScene(), {embedded: true, onGestureChange: value => lifecycle.push(value)});
  const stage = one(s.host, 'falsify-shape-stage');
  const drag = (x, from, to) => {
    pointer(s.dom, stage, 'pointerdown', x, from);
    pointer(s.dom, stage, 'pointermove', x, (from + to) / 2);
    pointer(s.dom, stage, 'pointermove', x, to);
    pointer(s.dom, stage, 'pointerup', x, to);
  };
  drag(100, 50, 30);
  assert.equal(s.editor.getState().operations.length, 1);
  const first = s.editor.getState().scene;
  assert.equal(first.linearTracks[0].knots[1].y, 30);
  const images = walk(s.host).filter(n => n.tagName === 'IMAGE');
  assert.equal(images[0].getAttribute('y'), '20');
  drag(100, 30, 70);
  assert.equal(s.editor.getState().operations.length, 2);
  s.editor.undo();
  assert.deepEqual(s.editor.getState().scene, first);
  s.editor.undo();
  assert.deepEqual(s.editor.getState().scene, linearScene());
  s.editor.redo(); assert.deepEqual(s.editor.getState().scene, first);
  drag(100, 30, 40);
  assert.equal(s.editor.getState().canRedo, false);
  assert.deepEqual(lifecycle, [true, false, true, false, true, false]);
});

test('linear middle drag inserts one vertex with straight joins; cancellation and click add no steps', () => {
  const s = mount(linearScene()); const stage = one(s.host, 'falsify-shape-stage');
  pointer(s.dom, stage, 'pointerdown', 60, 50);
  pointer(s.dom, stage, 'pointerup', 60, 25);
  const state = s.editor.getState();
  assert.equal(state.operations.length, 1);
  assert.deepEqual(state.scene.linearTracks[0].knots.map(k => [k.x, k.y]), [[20,50],[60,25],[100,50],[180,50]]);
  const path = walk(s.host).find(n => n.tagName === 'POLYLINE');
  assert.equal(path.getAttribute('points'), '20,50 60,25 100,50 180,50');
  pointer(s.dom, stage, 'pointerdown', 60, 25);
  pointer(s.dom, stage, 'pointermove', 60, 70);
  pointer(s.dom, stage, 'pointercancel', 60, 70);
  assert.deepEqual(s.editor.getState().scene, state.scene);
  pointer(s.dom, stage, 'pointerdown', 60, 25);
  pointer(s.dom, stage, 'pointerup', 60, 25);
  assert.equal(s.editor.getState().operations.length, 1);
  pointer(s.dom, stage, 'pointerdown', 60, 25);
  pointer(s.dom, stage, 'pointermove', 60, 40);
  pointer(s.dom, stage, 'pointermove', 60, 25);
  pointer(s.dom, stage, 'pointerup', 60, 25);
  assert.equal(s.editor.getState().operations.length, 1);
});

test('bundle is a local FalsifyChartShapeEditor global and the stylesheet has visible handles', () => {
  assert.equal(cssText, EDITOR_CSS);
  assert.match(cssText, /\.falsify-shape-handle\s*\{[^}]*fill:\s*#fffdf8/s);
  assert.match(cssText, /ew-resize/);
  assert.match(cssText, /touch-action:\s*none/);
  assert.equal(cssText.includes('@import'), false);
  assert.equal(cssText.includes('http://'), false);
  assert.equal(cssText.includes('https://'), false);
  assert.match(bundleText, /FalsifyChartShapeEditor/);
  assert.match(bundleText, /setPointerCapture/);
  assert.match(bundleText, /되돌리기/);
  for (const file of [bundleText, sourceText]) {
    assert.equal(/\bfetch\s*\(/.test(file), false);
    assert.equal(file.includes('XMLHttpRequest'), false);
    assert.equal(file.includes('new WebSocket'), false);
    assert.equal(file.includes('sendBeacon'), false);
    assert.equal(file.includes('innerHTML'), false);
    assert.equal(file.includes('chart.js'), false);
    assert.equal(file.includes('from "react"'), false);
    assert.equal(file.includes("from 'react'"), false);
  }
  assert.equal(sourceText.includes('createFixtureCore'), false);
  assert.equal(bundleText.includes('createFixtureCore'), false);
  assert.equal(sourceText.includes('Math.cos'), false);
  assert.equal(bundleText.includes('Math.cos'), false);
  const dom = createDom();
  const bare = {console, document: dom.document, structuredClone};
  vm.createContext(bare);
  vm.runInContext(bundleText, bare, {filename: 'chart-shape-editor.js'});
  assert.equal(bare.FalsifyChartShapeEditor.createFixtureCore, undefined);
  assert.throws(() => bare.FalsifyChartShapeEditor.create({
    host: dom.element('div'),
    scene: scene(),
    document: dom.document,
  }), /FalsifyChartShape/);
  const sandbox = {console, document: dom.document, structuredClone};
  vm.createContext(sandbox);
  vm.runInContext(coreText, sandbox, {filename: 'chart-shape-core.js'});
  vm.runInContext(bundleText, sandbox, {filename: 'chart-shape-editor.js'});
  assert.equal(typeof sandbox.FalsifyChartShapeEditor.create, 'function');
  assert.equal(typeof sandbox.FalsifyChartShape.applyPlan, 'function');
  const host = dom.element('div');
  const editor = sandbox.FalsifyChartShapeEditor.create({
    host,
    scene: scene(),
    document: dom.document,
  });
  const curve = curves(host).find(el => el.getAttribute('data-series-id') === 'a');
  assert.equal(curve.getAttribute('stroke'), '#c45c26');
  editor.destroy();
});

test('shape core deform keeps the caller scene, the far branch, and point metadata', () => {
  const core = loadShapeCore();
  const input = branchScene();
  const before = structuredClone(input);
  const op = {id: 'd1', kind: 'deform', seriesId: 'a', center: [20, 0], radius: 25, dx: 0, dy: -8};
  const result = core.applyPlan(input, [op]);
  assert.deepEqual(input, before);
  assert.notEqual(result.scene, input);
  const next = result.scene.series[0].points;
  const prior = before.series[0].points;
  assert.equal(next.length, prior.length);
  assert.deepEqual(plain(next[5]), plain(prior[5]));
  assert.deepEqual(plain(next[6]), plain(prior[6]));
  assert.equal(next[6].sample, 'other');
  assert.ok(next[2].y < prior[2].y);
  assert.equal(next[2].sample, 'mid');
  assert.equal(next[1].sample, 'spike');
  assert.notEqual(next[1].y, prior[1].y);
  assert.equal(result.changes[0].id, 'd1');
  assert.equal(result.changes[0].indexes.includes(5), false);
  assert.equal(result.changes[0].indexes.includes(6), false);
  assert.equal(result.scene.sourceFileHash, 'branch');
  const history = core.createHistory(input);
  const move = {id: 'm1', kind: 'move', seriesId: 'a', range: [1, 2], dx: 3, dy: 0};
  history.apply([op]);
  history.apply([move]);
  const twice = history.scene();
  assert.deepEqual(twice.series, core.applyPlan(input, [op, move]).scene.series);
  history.undo();
  history.undo();
  assert.deepEqual(history.scene().series, core.applyPlan(input, []).scene.series);
  history.redo();
  history.redo();
  assert.deepEqual(history.scene().series, twice.series);
  assert.deepEqual(input, before);
});

test('editor draws the source style on the background and keeps precision collapsed', () => {
  const session = mount();
  const background = one(session.host, 'falsify-shape-background');
  const original = one(session.host, 'falsify-shape-original');
  const curve = curves(session.host).find(el => el.getAttribute('data-series-id') === 'a');
  const other = curves(session.host).find(el => el.getAttribute('data-series-id') === 'b');
  const halo = byClass(session.host, 'falsify-shape-halo')[0];
  assert.equal(background.getAttribute('src'), 'data:image/png;base64,AAAA');
  assert.equal(original.hidden, true);
  assert.equal(curve.getAttribute('stroke'), '#c45c26');
  assert.equal(curve.getAttribute('stroke-width'), '2.5');
  assert.equal(curve.getAttribute('stroke-dasharray'), '4 2');
  assert.equal(curve.getAttribute('stroke-opacity'), '0.9');
  assert.equal(curve.getAttribute('stroke-linecap'), 'butt');
  assert.equal(curve.getAttribute('stroke-linejoin'), 'miter');
  assert.equal(halo.getAttribute('stroke'), '#c45c26');
  assert.equal(other.getAttribute('stroke'), '#205060');
  assert.equal(other.getAttribute('stroke-width'), '1.5');
  assert.equal(other.getAttribute('stroke-dasharray'), null);
  const precision = walk(session.host).find(el => el.tagName === 'DETAILS');
  assert.equal(precision.open, false);
  assert.equal(walk(precision).find(el => el.tagName === 'SUMMARY').textContent, '선택한 점의 정밀 좌표 (px)');
  assert.equal(walk(precision).find(el => el.tagName === 'CAPTION').textContent, '원본 이미지 좌표 · px');
  assert.equal(one(session.host, 'falsify-shape-algorithm').textContent, '곡선을 끌어 모양을 바꾸고, 양옆 손잡이는 폭, 가운데 손잡이는 위치와 높이입니다.');
  assert.equal(walk(session.host).some(el => el.tagName === 'TEXTAREA'), false);
  assert.deepEqual(session.editor.getState().scene.axes, {x: 'linear', y: 'linear'});
  assert.deepEqual(session.editor.getState().scene.plotBbox, [11, 13, 191, 89]);
  assert.deepEqual(session.editor.getState().scene.bbox, [0, 0, 400, 200]);
  assert.equal(one(session.host, 'falsify-shape-editor').getAttribute('tabindex'), '0');
  assert.equal(button(session.host, '되돌리기').disabled, true);
  assert.equal(button(session.host, '다시 실행').disabled, true);
  assert.equal(handles(session.host).length, 0);
  session.editor.destroy();
});

test('dragging up makes a peak, leaves the radius boundary and the other series, and commits on pointerup', () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network'); };
  try {
    const input = scene();
    const before = structuredClone(input);
    const session = mount(input);
    const stage = one(session.host, 'falsify-shape-stage');
    pointer(session.dom, stage, 'pointerdown', 100, 50);
    assert.equal(stage.hasPointerCapture(1), true);
    assert.equal(session.dom.document.activeElement.className.includes('falsify-shape-editor'), true);
    assert.equal(byClass(session.host, 'falsify-shape-radius').length, 1);
    pointer(session.dom, stage, 'pointermove', 100, 20);
    assert.equal(session.exports.length, 0);
    assert.equal(session.commits.length, 0);
    assert.equal(session.changes.at(-1).revision, 0);
    assert.equal(session.changes.at(-1).operations.at(-1).kind, 'deform');
    assert.equal(button(session.host, '내보내기').disabled, true);
    assert.match(one(session.host, 'falsify-shape-status').textContent, /봉우리/);
    const up = pointer(session.dom, stage, 'pointerup', 100, 20);
    assert.equal(up.defaultPrevented, false);
    assert.equal(stage.hasPointerCapture(1), false);
    assert.equal(session.commits.length, 1);
    assert.equal(session.exports.length, 0);
    const committed = session.commits[0];
    assert.equal(committed.revision, 1);
    assert.equal(committed.scene.revision, 1);
    assert.equal(committed.operations.length, 1);
    const op = committed.operations[0];
    assert.equal(op.kind, 'deform');
    assert.equal(op.seriesId, 'a');
    assert.deepEqual(op.center, [100, 50]);
    assert.equal(op.radius, 80);
    assert.equal(op.dx, 0);
    assert.equal(op.dy, -30);
    const points = pointsOf(session.editor);
    const replay = loadShapeCore().applyPlan(before, committed.operations).scene;
    assert.deepEqual(plain(points), plain(replay.series[0].points));
    assert.equal(points[0].x, 20);
    assert.equal(points[0].y, 50);
    assert.equal(points[0].sample, 1);
    assert.equal(points[4].x, 180);
    assert.equal(points[4].y, 50);
    assert.equal(points[4].sample, 5);
    assert.equal(points[2].x, 100);
    assert.equal(points[2].sample, 3);
    assert.ok(points[2].y < points[1].y && points[1].y < 50);
    assert.ok(points[2].y < points[3].y && points[3].y < 50);
    assert.deepEqual(pointsOf(session.editor, 'b'), before.series[1].points);
    assert.deepEqual(input, before);
    assert.equal(one(session.host, 'falsify-shape-background').getAttribute('src'), 'data:image/png;base64,AAAA');
    session.editor.destroy();
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test('dragging down makes a well and pointercancel restores the committed curve', () => {
  const session = mount();
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 80);
  assert.match(one(session.host, 'falsify-shape-status').textContent, /골/);
  assert.ok(pointsOf(session.editor)[2].y > 50);
  pointer(session.dom, stage, 'pointercancel', 100, 80);
  assert.equal(session.commits.length, 0);
  assert.deepEqual(pointsOf(session.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  assert.equal(session.editor.getState().revision, 0);
  assert.equal(session.changes.at(-1).revision, 0);
  session.editor.destroy();
});

test('width handles and the center handle edit only the selected span', () => {
  const session = mount();
  selectMiddle(session);
  assert.deepEqual(handles(session.host).map(el => el.getAttribute('data-handle')), ['width-start', 'width-end', 'move']);
  for (const name of ['width-start', 'width-end']) {
    const node = handle(session.host, name);
    assert.equal(node.getAttribute('r'), '8');
    assert.match(node.getAttribute('class'), /falsify-shape-handle/);
  }
  assert.equal(handle(session.host, 'move').getAttribute('aria-label'), '위치와 높이');
  const right = handle(session.host, 'width-end');
  pointer(session.dom, right, 'pointerdown', 140, 50);
  pointer(session.dom, one(session.host, 'falsify-shape-stage'), 'pointermove', 170, 50);
  pointer(session.dom, one(session.host, 'falsify-shape-stage'), 'pointerup', 170, 50);
  let points = pointsOf(session.editor);
  assert.equal(points[0].x, 20);
  assert.equal(points[1].x, 60);
  assert.equal(points[2].x, 115);
  assert.equal(points[3].x, 170);
  assert.equal(points[4].x, 180);
  assert.deepEqual(points.map(point => point.y), [50, 50, 50, 50, 50]);
  assert.equal(points[3].sample, 4);
  assert.equal(session.commits.at(-1).operations.at(-1).kind, 'resize');
  assert.equal(session.commits.at(-1).operations.at(-1).scaleY, 1);
  assert.ok(session.commits.at(-1).operations.at(-1).scaleX > 1);
  const center = handle(session.host, 'move');
  pointer(session.dom, center, 'pointerdown', 100, 50);
  pointer(session.dom, one(session.host, 'falsify-shape-stage'), 'pointermove', 110, 35);
  pointer(session.dom, one(session.host, 'falsify-shape-stage'), 'pointerup', 110, 35);
  points = pointsOf(session.editor);
  assert.equal(points[2].x, 125);
  assert.equal(points[2].y, 35);
  assert.ok(points[1].y > 35 && points[1].y < 50);
  assert.ok(points[3].y > 35 && points[3].y < 50);
  assert.equal(session.commits.at(-1).operations.at(-1).kind, 'deform');
  assert.equal(session.commits.at(-1).operations.at(-1).radius, 110);
  assert.deepEqual(pointsOf(session.editor, 'b').map(point => point.y), [80, 80, 80]);
  const core = loadShapeCore();
  const replay = core.applyPlan(scene(), session.editor.getState().operations).scene;
  assert.deepEqual(plain(replay.series), plain(session.editor.getState().scene.series));
  session.editor.destroy();
});

test('undo, redo, and a new edit reevaluate the immutable baseline', () => {
  const session = mount();
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  pointer(session.dom, stage, 'pointerup', 100, 20);
  const peaked = structuredClone(pointsOf(session.editor));
  session.dom.emit(button(session.host, '되돌리기'), 'click');
  assert.deepEqual(pointsOf(session.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  assert.equal(session.editor.getState().revision, 0);
  assert.equal(session.commits.length, 1);
  assert.equal(button(session.host, '되돌리기').disabled, true);
  assert.equal(button(session.host, '다시 실행').disabled, false);
  session.dom.emit(button(session.host, '다시 실행'), 'click');
  assert.deepEqual(pointsOf(session.editor), peaked);
  assert.equal(session.editor.getState().revision, 1);
  session.editor.undo();
  selectMiddle(session);
  const move = handle(session.host, 'move');
  pointer(session.dom, move, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 110, 50);
  pointer(session.dom, stage, 'pointerup', 110, 50);
  assert.equal(button(session.host, '다시 실행').disabled, true);
  assert.equal(session.editor.getState().operations.length, 1);
  assert.equal(session.editor.getState().operations[0].kind, 'deform');
  assert.equal(pointsOf(session.editor)[2].y, 50);
  assert.equal(pointsOf(session.editor)[2].x, 110);
  session.editor.destroy();
});

test('compare shows the original image without changing points, and export stays local', () => {
  const session = mount();
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  pointer(session.dom, stage, 'pointerup', 100, 20);
  const edited = structuredClone(pointsOf(session.editor));
  session.dom.emit(button(session.host, '원본 비교'), 'click');
  const original = one(session.host, 'falsify-shape-original');
  const svg = one(session.host, 'falsify-shape-svg');
  assert.equal(original.hidden, false);
  assert.equal(original.getAttribute('src'), 'data:image/png;base64,BBBB');
  assert.equal(svg.style.visibility, 'hidden');
  assert.equal(button(session.host, '원본 비교').getAttribute('aria-pressed'), 'true');
  assert.equal(handles(session.host).length, 0);
  assert.deepEqual(pointsOf(session.editor), edited);
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 0);
  pointer(session.dom, stage, 'pointerup', 100, 0);
  assert.deepEqual(pointsOf(session.editor), edited);
  session.dom.emit(button(session.host, '원본 비교'), 'click');
  assert.equal(original.hidden, true);
  assert.equal(svg.style.visibility, 'visible');
  session.dom.emit(button(session.host, '내보내기'), 'click');
  assert.equal(session.exports.length, 1);
  assert.equal(session.exports[0].revision, 1);
  assert.deepEqual(session.exports[0].scene.series[0].points, edited);
  assert.equal(session.exports[0].operations[0].kind, 'deform');
  session.editor.destroy();
});

test('keyboard nudges, widens, and undoes the selected span', () => {
  const session = mount();
  const root = one(session.host, 'falsify-shape-editor');
  selectMiddle(session);
  const up = session.dom.emit(root, 'keydown', {key: 'ArrowUp'});
  assert.equal(up.defaultPrevented, true);
  let points = pointsOf(session.editor);
  assert.deepEqual(points.map(point => point.y), [50, 49.5, 49, 49.5, 50]);
  assert.deepEqual(points.map(point => point.x), [20, 60, 100, 140, 180]);
  assert.equal(session.commits.at(-1).operations.at(-1).kind, 'deform');
  session.dom.emit(root, 'keydown', {key: 'z', ctrlKey: true});
  assert.deepEqual(pointsOf(session.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  assert.equal(session.commits.length, 1);
  session.dom.emit(root, 'keydown', {key: 'ArrowUp', shiftKey: true});
  assert.deepEqual(pointsOf(session.editor).map(point => point.y), [50, 45, 40, 45, 50]);
  session.editor.undo();
  session.dom.emit(root, 'keydown', {key: 'ArrowRight', altKey: true});
  points = pointsOf(session.editor);
  assert.equal(points[0].x, 20);
  assert.equal(points[4].x, 180);
  assert.ok(Math.abs(points[1].x - 56) < 1e-9);
  assert.ok(Math.abs(points[2].x - 100) < 1e-9);
  assert.ok(Math.abs(points[3].x - 144) < 1e-9);
  assert.equal(session.commits.at(-1).operations.at(-1).kind, 'resize');
  const input = walk(session.host).find(el => el.getAttribute('aria-label') === 'A 2 y');
  const beforeKey = pointsOf(session.editor).map(point => ({x: point.x, y: point.y}));
  input.focus();
  session.dom.emit(input, 'keydown', {key: 'ArrowUp'});
  assert.deepEqual(pointsOf(session.editor).map(point => ({x: point.x, y: point.y})), beforeKey);
  session.editor.destroy();
});

test('escape cancels a drag, a secondary button does not select, and an empty press clears selection', () => {
  const session = mount();
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  assert.ok(pointsOf(session.editor)[2].y < 50);
  session.dom.emit(one(session.host, 'falsify-shape-editor'), 'keydown', {key: 'Escape'});
  assert.deepEqual(pointsOf(session.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  assert.equal(session.commits.length, 0);
  selectMiddle(session);
  assert.equal(handles(session.host).length, 3);
  pointer(session.dom, stage, 'pointerdown', 0, 0);
  pointer(session.dom, stage, 'pointerup', 0, 0);
  assert.equal(handles(session.host).length, 0);
  pointer(session.dom, stage, 'pointerdown', 100, 50, {button: 2});
  pointer(session.dom, stage, 'pointerup', 100, 50, {button: 2});
  assert.equal(handles(session.host).length, 0);
  session.editor.destroy();
});

test('collapsed precision can commit one coordinate without fitting the curve', () => {
  const session = mount();
  selectMiddle(session);
  const input = walk(session.host).find(el => el.getAttribute('aria-label') === 'A 2 y');
  input.value = 'foo';
  session.dom.emit(input, 'change');
  assert.equal(pointsOf(session.editor)[2].y, 50);
  input.value = '12';
  session.dom.emit(input, 'change');
  const points = pointsOf(session.editor);
  assert.equal(points[2].y, 12);
  assert.equal(points[2].x, 100);
  assert.equal(points[2].sample, 3);
  assert.equal(points[0].y, 50);
  assert.equal(points[4].y, 50);
  assert.equal(session.commits.at(-1).operations.at(-1).kind, 'set-values');
  assert.deepEqual(session.commits.at(-1).operations.at(-1).points, [{index: 2, x: 100, y: 12}]);
  const precision = walk(session.host).find(el => el.tagName === 'DETAILS');
  assert.equal(precision.open, false);
  session.editor.destroy();
});

test('missing original image does not hide the curve, and setScene resets history', () => {
  const input = scene();
  delete input.originalPng;
  const session = mount(input);
  session.dom.emit(button(session.host, '원본 비교'), 'click');
  assert.equal(one(session.host, 'falsify-shape-svg').style.visibility, 'visible');
  assert.match(one(session.host, 'falsify-shape-status').textContent, /원본 이미지/);
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  pointer(session.dom, stage, 'pointerup', 100, 20);
  const replacement = scene();
  replacement.series[0].points[2].y = 70;
  replacement.revision = 4;
  session.editor.setScene(replacement);
  assert.equal(session.editor.getState().revision, 4);
  assert.equal(pointsOf(session.editor)[2].y, 70);
  assert.equal(button(session.host, '되돌리기').disabled, true);
  assert.equal(input.series[0].points[2].y, 50);
  session.editor.destroy();
  assert.equal(session.host.children.length, 0);
  assert.throws(() => session.editor.getState(), /destroyed/);
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  assert.equal(session.commits.at(-1).revision, 1);
});

test('an injected core is used, and a core without history still undoes from the baseline', () => {
  const calls = [];
  const core = {
    applyPlan(input, operations) {
      calls.push(operations.map(op => op.kind));
      const next = structuredClone(input);
      next.marker = 'injected';
      next.series[0].points[2].y = 11;
      return {scene: next, changes: operations.map(op => op.id)};
    },
    hitTest() { return {seriesId: 'a', index: 2, distance: 0}; },
  };
  const input = scene();
  const session = mount(input, {core});
  assert.equal(calls.length, 0);
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  pointer(session.dom, stage, 'pointerup', 100, 20);
  assert.equal(session.editor.getState().scene.marker, 'injected');
  assert.ok(calls.some(list => list.includes('deform')));
  assert.equal(input.series[0].points[2].y, 50);
  const real = loadShapeCore();
  const fallback = mount(scene(), {core: {applyPlan: real.applyPlan, hitTest: real.hitTest}});
  const fallbackStage = one(fallback.host, 'falsify-shape-stage');
  pointer(fallback.dom, fallbackStage, 'pointerdown', 100, 50);
  pointer(fallback.dom, fallbackStage, 'pointermove', 100, 20);
  pointer(fallback.dom, fallbackStage, 'pointerup', 100, 20);
  assert.ok(pointsOf(fallback.editor)[2].y < 50);
  fallback.editor.undo();
  assert.deepEqual(pointsOf(fallback.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  const mutating = {
    applyPlan(value, operations) {
      value.series[0].points[0].x = 999;
      return {scene: value, changes: operations.map(op => op.id)};
    },
    hitTest: real.hitTest,
  };
  const caller = scene();
  const mutated = mount(caller, {core: mutating});
  const mutatedStage = one(mutated.host, 'falsify-shape-stage');
  pointer(mutated.dom, mutatedStage, 'pointerdown', 100, 50);
  pointer(mutated.dom, mutatedStage, 'pointermove', 100, 20);
  pointer(mutated.dom, mutatedStage, 'pointerup', 100, 20);
  assert.equal(caller.series[0].points[0].x, 20);
  globalThis.FalsifyChartShape = {
    applyPlan(value, operations) {
      const next = structuredClone(value);
      next.marker = 'global';
      next.series[0].points[2].y = 5;
      return {scene: next, changes: operations.map(op => op.id)};
    },
    hitTest: real.hitTest,
  };
  try {
    const dom = createDom();
    const host = dom.element('div');
    const editor = create({host, scene: scene(), document: dom.document});
    const globalStage = one(host, 'falsify-shape-stage');
    pointer(dom, globalStage, 'pointerdown', 100, 50);
    pointer(dom, globalStage, 'pointermove', 100, 20);
    pointer(dom, globalStage, 'pointerup', 100, 20);
    assert.equal(editor.getState().scene.marker, 'global');
    editor.destroy();
  } finally {
    delete globalThis.FalsifyChartShape;
  }
  session.editor.destroy();
  fallback.editor.destroy();
  mutated.editor.destroy();
});

let shapeCore;
function loadShapeCore() {
  if (shapeCore) return shapeCore;
  const context = {};
  vm.createContext(context);
  vm.runInContext(coreText, context, {filename: 'chart-shape-core.js', timeout: 2000});
  assert.equal(typeof context.FalsifyChartShape?.applyPlan, 'function');
  assert.equal(typeof context.FalsifyChartShape.createHistory, 'function');
  assert.equal(typeof context.FalsifyChartShape.hitTest, 'function');
  shapeCore = context.FalsifyChartShape;
  return shapeCore;
}

function sceneClient(stage, x, y, sceneWidth, sceneHeight) {
  const rect = stage.getBoundingClientRect();
  return {
    rect,
    x: rect.left + (x / sceneWidth) * rect.width,
    y: rect.top + (y / sceneHeight) * rect.height,
  };
}

test('stage keeps aspect ratio at 360px and full size, and the same pointer drag agrees', () => {
  const wide = scene();
  wide.width = 900;
  wide.height = 100;
  function drag(parentWidth) {
    const session = mount(wide, {parentWidth});
    const stage = one(session.host, 'falsify-shape-stage');
    const svg = one(session.host, 'falsify-shape-svg');
    const background = one(session.host, 'falsify-shape-background');
    assert.equal(stage.style.width, '100%');
    assert.equal(stage.style.height, 'auto');
    assert.equal(svg.getAttribute('width'), null);
    assert.equal(svg.getAttribute('height'), null);
    assert.equal(svg.getAttribute('viewBox'), '0 0 900 100');
    assert.equal(svg.getAttribute('preserveAspectRatio'), 'none');
    assert.equal(background.getAttribute('src'), 'data:image/png;base64,AAAA');
    const down = sceneClient(stage, 100, 50, 900, 100);
    const up = sceneClient(stage, 100, 20, 900, 100);
    assert.ok(Math.abs(down.rect.width - parentWidth) < 1e-6);
    assert.ok(Math.abs(down.rect.width / down.rect.height - 9) < 1e-6);
    assert.ok(down.rect.width <= parentWidth + 1e-6);
    pointer(session.dom, stage, 'pointerdown', down.x, down.y);
    pointer(session.dom, stage, 'pointermove', up.x, up.y);
    pointer(session.dom, stage, 'pointerup', up.x, up.y);
    const state = session.editor.getState();
    const result = {
      center: state.operations[0].center,
      dy: state.operations[0].dy,
      ys: pointsOf(session.editor).map(point => point.y),
      samples: pointsOf(session.editor).map(point => point.sample),
      hash: state.scene.sourceFileHash,
      rect: {width: down.rect.width, height: down.rect.height},
    };
    session.editor.destroy();
    return result;
  }
  const narrow = drag(360);
  const full = drag(900);
  assert.equal(narrow.rect.width, 360);
  assert.ok(Math.abs(narrow.rect.height - 40) < 1e-6);
  assert.equal(full.rect.width, 900);
  assert.ok(Math.abs(full.rect.height - 100) < 1e-6);
  assert.deepEqual(narrow.center, [100, 50]);
  assert.deepEqual(full.center, [100, 50]);
  assert.equal(narrow.dy, -30);
  assert.equal(full.dy, -30);
  assert.deepEqual(narrow.ys, full.ys);
  assert.equal(narrow.ys[0], 50);
  assert.equal(narrow.ys[4], 50);
  assert.ok(narrow.ys[2] < 50);
  assert.deepEqual(narrow.samples, [1, 2, 3, 4, 5]);
  assert.equal(narrow.hash, 'abc123');
  assert.equal(full.hash, 'abc123');
});

test('editor gestures use the shape-core bundle history and hit test', () => {
  const core = loadShapeCore();
  const input = scene();
  const before = structuredClone(input);
  const session = mount(input, {core});
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 20);
  pointer(session.dom, stage, 'pointerup', 100, 20);
  const state = session.editor.getState();
  assert.equal(state.operations[0].kind, 'deform');
  assert.equal(state.operations[0].seriesId, 'a');
  assert.equal(state.revision, 1);
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(state.scene.series), plain(core.applyPlan(input, state.operations).scene.series));
  const points = state.scene.series[0].points;
  assert.equal(points[0].y, 50);
  assert.equal(points[0].sample, 1);
  assert.equal(points[4].y, 50);
  assert.ok(points[2].y < 50);
  assert.equal(points[2].sample, 3);
  assert.deepEqual(state.scene.series[1].points, before.series[1].points);
  assert.deepEqual(input, before);
  session.editor.undo();
  assert.equal(session.editor.getState().revision, 0);
  assert.deepEqual(pointsOf(session.editor), before.series[0].points);
  assert.equal(session.commits.length, 1);
  session.editor.destroy();
});

test('pointer moves coalesce to one frame, pointerup commits that point, and dropped frames do not repaint', () => {
  const session = mount();
  const stage = one(session.host, 'falsify-shape-stage');
  const flat = '20,50 60,50 100,50 140,50 180,50';
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  assert.equal(renderedPoints(session.host), flat);
  const changesBefore = session.changes.length;
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: 40, pointerId: 1, button: 0});
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: 30, pointerId: 1, button: 0});
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: 20, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 1);
  assert.equal(renderedPoints(session.host), flat);
  assert.equal(session.changes.length, changesBefore);
  assert.ok(pointsOf(session.editor)[2].y < 50);
  flushFrames();
  assert.equal(pendingFrames.length, 0);
  assert.equal(session.changes.length, changesBefore + 1);
  assert.equal(renderedPoints(session.host), pointsOf(session.editor).map(point => `${point.x},${point.y}`).join(' '));
  assert.notEqual(renderedPoints(session.host), flat);
  const painted = renderedPoints(session.host);
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: 35, pointerId: 1, button: 0});
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: 10, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 1);
  assert.equal(renderedPoints(session.host), painted);
  const up = session.dom.emit(stage, 'pointerup', {clientX: 100, clientY: 15, pointerId: 1, button: 0});
  assert.equal(up.defaultPrevented, false);
  assert.equal(pendingFrames.length, 0);
  assert.equal(session.commits.length, 1);
  assert.equal(session.editor.getState().revision, 1);
  assert.equal(session.editor.getState().operations[0].dy, -35);
  assert.equal(button(session.host, '되돌리기').disabled, false);
  const committedPaint = renderedPoints(session.host);
  flushFrames();
  assert.equal(renderedPoints(session.host), committedPaint);
  assert.equal(session.commits.length, 1);
  assert.equal(session.editor.getState().revision, 1);
  session.editor.destroy();

  const cancelled = mount();
  const cancelStage = one(cancelled.host, 'falsify-shape-stage');
  pointer(cancelled.dom, cancelStage, 'pointerdown', 100, 50);
  cancelled.dom.emit(cancelStage, 'pointermove', {clientX: 100, clientY: 20, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 1);
  cancelled.dom.emit(cancelStage, 'pointercancel', {clientX: 100, clientY: 20, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 0);
  assert.equal(renderedPoints(cancelled.host), flat);
  flushFrames();
  assert.equal(renderedPoints(cancelled.host), flat);
  assert.equal(cancelled.commits.length, 0);
  assert.deepEqual(pointsOf(cancelled.editor).map(point => point.y), [50, 50, 50, 50, 50]);
  cancelled.editor.destroy();

  const replaced = mount();
  const replaceStage = one(replaced.host, 'falsify-shape-stage');
  pointer(replaced.dom, replaceStage, 'pointerdown', 100, 50);
  replaced.dom.emit(replaceStage, 'pointermove', {clientX: 100, clientY: 20, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 1);
  const replacement = scene();
  replacement.series[0].points[2].y = 70;
  replacement.revision = 4;
  replaced.editor.setScene(replacement);
  assert.equal(pendingFrames.length, 0);
  assert.match(renderedPoints(replaced.host), /100,70/);
  const replacedPaint = renderedPoints(replaced.host);
  flushFrames();
  assert.equal(renderedPoints(replaced.host), replacedPaint);
  assert.equal(pointsOf(replaced.editor)[2].y, 70);
  assert.equal(replaced.editor.getState().revision, 4);
  assert.equal(replaced.commits.length, 0);
  replaced.editor.destroy();

  const dropped = mount();
  const dropStage = one(dropped.host, 'falsify-shape-stage');
  pointer(dropped.dom, dropStage, 'pointerdown', 100, 50);
  dropped.dom.emit(dropStage, 'pointermove', {clientX: 100, clientY: 20, pointerId: 1, button: 0});
  assert.equal(pendingFrames.length, 1);
  dropped.editor.destroy();
  assert.equal(pendingFrames.length, 0);
  assert.equal(dropped.host.children.length, 0);
  assert.doesNotThrow(() => flushFrames());
  assert.equal(dropped.host.children.length, 0);
});

test('a 2000-point drag previews once per frame and records calculation/render cost', () => {
  const points = [];
  for (let index = 0; index < 2000; index += 1) points.push({x: index * 0.2, y: 50, sample: index});
  const input = scene();
  input.series = [{id: 'a', name: 'A', color: '#c45c26', points}];
  const session = mount(input);
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  const tableBody = walk(session.host).find(node => node.tagName === 'TBODY');
  const firstRow = tableBody.children[0];
  const samples = [];
  for (let index = 0; index < 100; index += 1) {
    const y = 20 + (index % 25);
    session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: y, pointerId: 1, button: 0});
    session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: y - 1, pointerId: 1, button: 0});
    assert.equal(pendingFrames.length, 1);
    const started = performance.now();
    flushFrames();
    assert.equal(tableBody.children[0], firstRow);
    samples.push(performance.now() - started);
    assert.equal(pendingFrames.length, 0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = ratio => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))];
  const perf = {
    points: 2000,
    frames: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted[sorted.length - 1],
    goalMs: 33,
  };
  console.log(`SHAPE_DRAG_PERF ${JSON.stringify(perf)}`);
  assert.equal(perf.frames, 100);
  assert.ok(Number.isFinite(perf.p95Ms));
  session.dom.emit(stage, 'pointerup', {clientX: 100, clientY: 10, pointerId: 1, button: 0});
  assert.equal(session.commits.length, 1);
  assert.equal(session.editor.getState().revision, 1);
  assert.equal(session.editor.getState().operations.length, 1);
  assert.equal(pendingFrames.length, 0);
  flushFrames();
  assert.equal(session.commits.length, 1);
  assert.equal(pointsOf(session.editor).length, 2000);
  session.editor.destroy();
});

function browserExecutable() {
  let bundled = '';
  try { bundled = spawnSync(process.execPath, ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {cwd: app, encoding: 'utf8'}).stdout; }
  catch { bundled = ''; }
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    bundled,
    resolve(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    resolve(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    resolve(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

test('browser pointer drag, handles, compare, and export do not request a server', async () => {
  const executable = browserExecutable();
  assert.ok(executable, 'Edge, Chrome, or Playwright Chromium is required');
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({executablePath: executable, headless: true});
  const requests = [];
  try {
    const page = await browser.newPage();
    page.on('request', request => requests.push(request.url()));
    await page.setContent('<!doctype html><meta charset="utf-8"><div id="host" style="width:360px"></div>');
    await page.addStyleTag({content: cssText});
    await page.addScriptTag({content: coreText});
    await page.addScriptTag({content: bundleText});
    await page.evaluate(input => {
      window.commits = [];
      window.exports = [];
      window.editor = FalsifyChartShapeEditor.create({
        host: document.querySelector('#host'),
        scene: input,
        onCommit(state) { window.commits.push(state.revision); },
        onRequestExport(state) { window.exports.push(state.revision); },
      });
    }, scene());
    const curve = page.locator('.falsify-shape-curve[data-series-id="a"]');
    await expectAttribute(curve, 'stroke', '#c45c26');
    await expectAttribute(curve, 'stroke-width', '2.5');
    const stage = page.locator('#host .falsify-shape-stage');
    const box = await stage.boundingBox();
    assert.ok(box);
    const fitted = await page.evaluate(() => {
      const host = document.querySelector('#host').getBoundingClientRect();
      const stageEl = document.querySelector('#host .falsify-shape-stage');
      const svgEl = document.querySelector('#host .falsify-shape-svg');
      const bgEl = document.querySelector('#host .falsify-shape-background');
      const stageBox = stageEl.getBoundingClientRect();
      const svgBox = svgEl.getBoundingClientRect();
      const bgBox = bgEl.getBoundingClientRect();
      return {
        host: host.width,
        stage: {width: stageBox.width, height: stageBox.height},
        svg: {width: svgBox.width, height: svgBox.height},
        bg: {width: bgBox.width, height: bgBox.height},
        viewBox: svgEl.getAttribute('viewBox'),
        svgWidth: svgEl.getAttribute('width'),
        svgHeight: svgEl.getAttribute('height'),
        overflow: stageEl.scrollWidth - stageEl.clientWidth,
      };
    });
    assert.ok(fitted.stage.width <= fitted.host + 0.5);
    assert.ok(fitted.stage.width > 300);
    assert.ok(Math.abs(fitted.stage.width / fitted.stage.height - 2) < 0.02);
    assert.equal(fitted.viewBox, '0 0 200 100');
    assert.equal(fitted.svgWidth, null);
    assert.equal(fitted.svgHeight, null);
    assert.ok(Math.abs(fitted.svg.width - fitted.stage.width) < 1);
    assert.ok(Math.abs(fitted.svg.height - fitted.stage.height) < 1);
    assert.ok(Math.abs(fitted.bg.width - fitted.stage.width) < 1);
    assert.ok(Math.abs(fitted.bg.height - fitted.stage.height) < 1);
    assert.ok(fitted.overflow <= 1);
    const point = (x, y) => ({x: box.x + (x / 200) * box.width, y: box.y + (y / 100) * box.height});
    const down = point(100, 50);
    await page.mouse.move(down.x, down.y);
    await page.mouse.down();
    const moved = point(100, 20);
    await page.mouse.move(moved.x, moved.y);
    await page.mouse.up();
    const after = await page.evaluate(() => ({
      y: window.editor.getState().scene.series[0].points.map(item => item.y),
      revision: window.editor.getState().revision,
      commits: window.commits.slice(),
      handles: [...document.querySelectorAll('.falsify-shape-handle')].map(el => el.getAttribute('data-handle')),
      fill: getComputedStyle(document.querySelector('.falsify-shape-handle-center')).fill,
      open: document.querySelector('details').open,
    }));
    assert.equal(after.revision, 1);
    assert.deepEqual(after.commits, [1]);
    assert.ok(after.y[2] < 50);
    assert.equal(after.y[0], 50);
    assert.equal(after.y[4], 50);
    assert.deepEqual(after.handles, ['width-start', 'width-end', 'move']);
    assert.equal(after.fill, 'rgb(29, 26, 22)');
    assert.equal(after.open, false);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.editor.getState().revision), 0);
    await page.getByRole('button', {name: '원본 비교'}).click();
    assert.equal(await page.locator('.falsify-shape-original').isVisible(), true);
    await page.getByRole('button', {name: '내보내기'}).click();
    assert.deepEqual(await page.evaluate(() => window.exports), [0]);
    assert.equal(requests.some(url => url.startsWith('http:') || url.startsWith('https:')), false);
    await page.setViewportSize({width: 1280, height: 1200});
    await page.evaluate(input => {
      const wide = structuredClone(input);
      wide.width = 900;
      wide.height = 100;
      for (const [id, width] of [['narrow-wide', 360], ['full-wide', 900]]) {
        const host = document.createElement('div');
        host.id = id;
        host.style.width = `${width}px`;
        document.body.append(host);
        host.editor = FalsifyChartShapeEditor.create({host, scene: structuredClone(wide)});
      }
    }, scene());
    async function dragHost(id) {
      const target = page.locator(`#${id} .falsify-shape-stage`);
      const area = await target.boundingBox();
      assert.ok(area);
      const at = (x, y) => ({
        x: area.x + (x / 900) * area.width,
        y: area.y + (y / 100) * area.height,
      });
      const down = at(100, 50);
      await page.mouse.move(down.x, down.y);
      await page.mouse.down();
      const moved = at(100, 20);
      await page.mouse.move(moved.x, moved.y);
      await page.mouse.up();
      return area;
    }
    const narrowBox = await dragHost('narrow-wide');
    const fullBox = await dragHost('full-wide');
    const compared = await page.evaluate(() => {
      function read(id) {
        const host = document.getElementById(id);
        const stageEl = host.querySelector('.falsify-shape-stage');
        const svgEl = host.querySelector('.falsify-shape-svg');
        const bgEl = host.querySelector('.falsify-shape-background');
        const stageBox = stageEl.getBoundingClientRect();
        const svgBox = svgEl.getBoundingClientRect();
        const bgBox = bgEl.getBoundingClientRect();
        const state = host.editor.getState();
        return {
          width: stageBox.width,
          height: stageBox.height,
          svgW: svgBox.width,
          svgH: svgBox.height,
          bgW: bgBox.width,
          bgH: bgBox.height,
          viewBox: svgEl.getAttribute('viewBox'),
          svgAttr: svgEl.getAttribute('width'),
          overflow: stageEl.scrollWidth - stageEl.clientWidth,
          ys: state.scene.series[0].points.map(point => point.y),
          samples: state.scene.series[0].points.map(point => point.sample),
          hash: state.scene.sourceFileHash,
          dy: state.operations[0].dy,
          center: state.operations[0].center,
        };
      }
      return {narrow: read('narrow-wide'), full: read('full-wide')};
    });
    assert.ok(narrowBox.width <= 360.5);
    assert.ok(narrowBox.width > 300);
    assert.ok(fullBox.width <= 900.5);
    assert.ok(fullBox.width > 800);
    for (const side of [compared.narrow, compared.full]) {
      assert.ok(Math.abs(side.width / side.height - 9) < 0.05);
      assert.equal(side.viewBox, '0 0 900 100');
      assert.equal(side.svgAttr, null);
      assert.ok(Math.abs(side.svgW - side.width) < 1);
      assert.ok(Math.abs(side.svgH - side.height) < 1);
      assert.ok(Math.abs(side.bgW - side.width) < 1);
      assert.ok(Math.abs(side.bgH - side.height) < 1);
      assert.ok(side.overflow <= 1);
      assert.ok(Math.abs(side.center[0] - 100) < 0.5);
      assert.ok(Math.abs(side.center[1] - 50) < 0.5);
      assert.ok(Math.abs(side.dy + 30) < 0.5);
      assert.equal(side.ys[0], 50);
      assert.equal(side.ys[4], 50);
      assert.ok(side.ys[2] < 50);
      assert.deepEqual(side.samples, [1, 2, 3, 4, 5]);
      assert.equal(side.hash, 'abc123');
    }
    assert.ok(Math.abs(compared.narrow.dy - compared.full.dy) < 0.05);
    for (let index = 0; index < compared.narrow.ys.length; index += 1) {
      assert.ok(Math.abs(compared.narrow.ys[index] - compared.full.ys[index]) < 0.05);
    }
  } finally {
    await browser.close();
  }
});

async function expectAttribute(locator, name, value) {
  assert.equal(await locator.getAttribute(name), value);
}


test('closed source stroke keeps its implicit closing edge in the overlay', () => {
  const source = scene();
  source.series[0].style.closed = true;
  const session = mount(source);
  const points = renderedPoints(session.host).trim().split(/\s+/);
  assert.equal(points.at(-1), points[0]);
  assert.equal(points.length, source.series[0].points.length + 1);
  session.editor.destroy();
});

test('embedded editor shows precision only for the selected point', () => {
  const session = mount(scene(), {embedded: true});
  assert.equal(button(session.host, '내보내기').hidden, true);
  const details = walk(session.host).find(el => el.tagName === 'DETAILS');
  assert.equal(details.hidden, true);
  selectMiddle(session);
  assert.equal(details.hidden, false);
  assert.equal(walk(session.host).filter(el => el.tagName === 'INPUT').length, 2);
});

test('selection click is a no-op and precision focus survives a change', () => {
  const session = mount();
  selectMiddle(session);
  assert.equal(session.editor.getState().operations.length, 0);
  assert.equal(session.commits.length, 0);
  const input = walk(session.host).find(el => el.getAttribute('aria-label') === 'A 2 y');
  input.focus();
  input.value = '42';
  session.dom.emit(input, 'change');
  assert.equal(session.dom.document.activeElement, input);
  assert.equal(walk(session.host).find(el => el.getAttribute('aria-label') === 'A 2 y'), input);
  assert.equal(pointsOf(session.editor)[2].y, 42);
});

test('halo and radius do not intercept pointer selection', () => {
  assert.match(cssText, /\.falsify-shape-halo,\s*\.falsify-shape-radius\s*\{\s*pointer-events:\s*none;/);
  assert.equal((cssText.match(/\.falsify-shape-halo\.is-selected/g) || []).length, 1);
  assert.equal((cssText.match(/\.falsify-shape-hit:hover/g) || []).length, 1);
});

test('gesture lifecycle settles preview before unlock, including return to origin', () => {
  const events = [];
  const session = mount(scene(), {onGestureChange: value => events.push(['gesture', value]), onChange: value => events.push(['change', value]), onCommit: () => events.push(['commit'])});
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 40);
  pointer(session.dom, stage, 'pointerup', 100, 40);
  assert.deepEqual(events.filter(e => e[0] === 'gesture').map(e => e[1]), [true, false]);
  const previous = session.editor.getState();
  const y = previous.scene.series[0].points[2].y;
  events.length = 0;
  pointer(session.dom, stage, 'pointerdown', 100, y);
  pointer(session.dom, stage, 'pointermove', 100, y - 10);
  session.dom.emit(stage, 'pointermove', {clientX: 100, clientY: y, pointerId: 1, button: 0});
  session.dom.emit(stage, 'pointerup', {clientX: 100, clientY: y, pointerId: 1, button: 0});
  flushFrames();
  assert.deepEqual(events.at(-1), ['gesture', false]);
  const last = events.filter(e => e[0] === 'change').at(-1)[1];
  const state = session.editor.getState();
  assert.deepEqual(last.operations, state.operations);
  assert.deepEqual(last.scene, state.scene);
  assert.equal(state.operations.length, previous.operations.length);
  assert.equal(events.some(e => e[0] === 'commit'), false);
  pointer(session.dom, stage, 'pointerdown', 100, y);
  session.editor.destroy();
  assert.deepEqual(events.at(-1), ['gesture', false]);
});

test('gesture callback pairs on cancellation, compare and scene replacement', () => {
  const states = [];
  const session = mount(scene(), {onGestureChange: value => states.push(value)});
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointercancel', 100, 50);
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  session.dom.emit(button(session.host, '원본 비교'), 'click');
  session.dom.emit(button(session.host, '원본 비교'), 'click');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  session.editor.setScene(scene());
  assert.deepEqual(states, [true, false, true, false, true, false]);
});

test('center handle and keyboard produce tapered influence with replay and undo', () => {
  const source = scene();
  source.series = [source.series[0]];
  source.series[0].points = Array.from({length: 41}, (_, i) => ({x: i * 5, y: 50}));
  const session = mount(source);
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointerup', 100, 50);
  const center = handle(session.host, 'move');
  pointer(session.dom, center, 'pointerdown', 100, 50);
  pointer(session.dom, stage, 'pointermove', 100, 30);
  pointer(session.dom, stage, 'pointerup', 100, 30);
  const ys = pointsOf(session.editor).map(point => point.y);
  assert.equal(ys[20], 30);
  assert.ok(ys[20] < ys[19] && ys[19] < ys[18] && ys[18] < ys[17]);
  assert.equal(ys[16], 50);
  assert.equal(ys[24], 50);
  assert.equal(session.editor.getState().operations.length, 1);
  assert.deepEqual(plain(loadShapeCore().applyPlan(source, session.editor.getState().operations).scene.series), plain(session.editor.getState().scene.series));
  session.editor.undo();
  assert.ok(pointsOf(session.editor).every(point => point.y === 50));
  session.dom.emit(one(session.host, 'falsify-shape-editor'), 'keydown', {key: 'ArrowUp', shiftKey: true});
  const keyed = pointsOf(session.editor).map(point => point.y);
  assert.ok(keyed[20] < keyed[19] && keyed[19] < keyed[18] && keyed[18] < keyed[17]);
  assert.equal(keyed[16], 50);
});

test('dense handles separate in screen space and offset resize uses actual delta', () => {
  const source = scene();
  source.series = [source.series[0]];
  source.series[0].points = Array.from({length: 41}, (_, i) => ({x: i * 5, y: 50}));
  const session = mount(source, {parentWidth: 100});
  const stage = one(session.host, 'falsify-shape-stage');
  pointer(session.dom, stage, 'pointerdown', 50, 25);
  pointer(session.dom, stage, 'pointerup', 50, 25);
  const hits = byClass(session.host, 'falsify-shape-handle-hit');
  const start = hits.find(el => el.getAttribute('data-handle') === 'width-start');
  const end = hits.find(el => el.getAttribute('data-handle') === 'width-end');
  const center = hits.find(el => el.getAttribute('data-handle') === 'move');
  const scale = stage.getBoundingClientRect().width / source.width;
  assert.ok((Number(center.getAttribute('cx')) - Number(start.getAttribute('cx'))) * scale >= 24);
  assert.ok((Number(end.getAttribute('cx')) - Number(center.getAttribute('cx'))) * scale >= 24);
  assert.ok(Number(end.getAttribute('r')) * scale * 2 >= 24);
  assert.equal(byClass(session.host, 'falsify-shape-handle-guide').length, 2);
  assert.equal(session.editor.getState().operations.length, 0);
  assert.deepEqual(pointsOf(session.editor), source.series[0].points);
  const x = Number(end.getAttribute('cx')) * scale;
  const y = Number(end.getAttribute('cy')) * scale;
  pointer(session.dom, end, 'pointerdown', x, y);
  pointer(session.dom, stage, 'pointerup', x + 2, y);
  const state = session.editor.getState();
  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].kind, 'resize');
  assert.ok(Math.abs(state.operations[0].scaleX - 1.2) < 1e-9);
  session.editor.undo();
  assert.deepEqual(pointsOf(session.editor), source.series[0].points);
});

test('handle targets stay inside all edges and corners at a compact viewport', () => {
  for (const [x, y] of [[2,50], [198,50], [100,2], [100,98], [2,2], [198,2], [2,98], [198,98]]) {
    const source = scene();
    source.series = [source.series[0]];
    source.series[0].points = [x - 5, x, x + 5].map(px => ({x: Math.max(0, Math.min(200, px)), y}));
    const session = mount(source, {parentWidth: 240});
    const stage = one(session.host, 'falsify-shape-stage');
    const scale = stage.getBoundingClientRect().width / source.width;
    pointer(session.dom, stage, 'pointerdown', x * scale, y * scale);
    pointer(session.dom, stage, 'pointerup', x * scale, y * scale);
    const hits = byClass(session.host, 'falsify-shape-handle-hit');
    assert.equal(hits.length, 3, `${x},${y}`);
    const centers = hits.map(el => ({x: Number(el.getAttribute('cx')) * scale, y: Number(el.getAttribute('cy')) * scale, r: Number(el.getAttribute('r')) * scale}));
    const rect = stage.getBoundingClientRect();
    for (const point of centers) {
      assert.ok(point.x - point.r >= -0.01 && point.x + point.r <= rect.width + 0.01, `${x},${y} horizontal`);
      assert.ok(point.y - point.r >= -0.01 && point.y + point.r <= rect.height + 0.01, `${x},${y} vertical`);
    }
    assert.ok(centers[2].x - centers[0].x >= 23.99);
    assert.ok(centers[1].x - centers[2].x >= 23.99);
    assert.ok(byClass(session.host, 'falsify-shape-handle-guide').length > 0);
    assert.equal(session.editor.getState().operations.length, 0);
    assert.deepEqual(pointsOf(session.editor), source.series[0].points);
    session.editor.destroy();
  }
});

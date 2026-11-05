import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {create, EDITOR_CSS} from '../src/chart-mark-editor.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = spawnSync(process.execPath, [resolve(app, 'scripts/build-chart-mark-editor.mjs')], {
  cwd: app,
  encoding: 'utf8',
});
if (built.status !== 0) throw new Error(built.stderr || built.stdout || 'chart mark editor build failed');

const bundleText = readFileSync(resolve(app, 'dist/chart-mark-editor.js'), 'utf8');
const cssText = readFileSync(resolve(app, 'dist/chart-mark-editor.css'), 'utf8');
const sourceText = readFileSync(resolve(app, 'src/chart-mark-editor.mjs'), 'utf8');
const coreText = readFileSync(resolve(app, 'dist/chart-shape-core.js'), 'utf8');

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
  function element(tag) {
    const el = new EventTarget();
    const attrs = {};
    const classes = new Set();
    el.tagName = String(tag).toUpperCase();
    el.children = [];
    el.parentElement = null;
    el.style = {};
    el.hidden = false;
    el.disabled = false;
    el.open = false;
    el.value = '';
    el.type = '';
    el.alt = '';
    el.src = '';
    el.readOnly = false;
    el.step = '';
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
      el._listeners.push({type, fn});
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
    };
    el.getBoundingClientRect = () => layoutRect(el);
    return el;
  }
  function invoke(node, event) {
    event.currentTarget = node;
    for (const item of [...(node._listeners || [])]) {
      if (item.type === event.type) item.fn.call(node, event);
    }
  }
  function emit(target, type, init = {}) {
    if (type === 'click' && target.disabled) return null;
    const event = {
      type,
      button: 0,
      pointerId: 1,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: '',
      clientX: 0,
      clientY: 0,
      target,
      currentTarget: target,
      preventDefault() {},
      stopPropagation() { this._stopped = true; },
      ...init,
    };
    const chain = [];
    for (let node = target; node; node = node.parentElement) chain.push(node);
    for (const node of chain) {
      if (event._stopped) break;
      invoke(node, event);
    }
    return event;
  }
  return {document: {createElement: element, createElementNS: (_ns, tag) => element(tag)}, emit, element};
}

function scene() {
  return {
    schema: 'falsify.chart-scene.v1',
    mode: 'marks',
    sceneId: 'marks',
    sourceFileHash: 'abc',
    pageIndex: 0,
    bbox: [0, 0, 400, 300],
    width: 400,
    height: 300,
    revision: 0,
    backgroundPng: 'AAAA',
    originalPng: 'BBBB',
    series: [
      {
        id: 'bars',
        kind: 'bar',
        name: '파랑',
        color: '#3366cc',
        baseline: 260,
        radius: null,
        orientation: 'vertical',
        style: {fill: '#3366cc', width: 36, baseline: 260, orientation: 'vertical'},
        points: [
          {x: 78, y: 170, baseline: 260, width: 36, axis: 'y', role: 'bar-top'},
          {x: 198, y: 290, baseline: 260, width: 36, axis: 'y', role: 'bar-top'},
        ],
      },
      {
        id: 'points',
        kind: 'scatter',
        color: '#1a8c40',
        baseline: null,
        radius: 6,
        orientation: null,
        style: {fill: '#1a8c40', radius: 6},
        points: [
          {x: 300, y: 200, radius: 6, role: 'scatter-point'},
          {x: 340, y: 150, radius: 6, role: 'scatter-point'},
        ],
      },
    ],
  };
}

let shapeCore = null;
function loadCore() {
  if (shapeCore) return shapeCore;
  const context = {};
  vm.createContext(context);
  vm.runInContext(coreText, context, {filename: 'chart-shape-core.js', timeout: 2000});
  shapeCore = context.FalsifyChartShape;
  assert.equal(typeof shapeCore.createHistory, 'function');
  assert.equal(typeof shapeCore.applyPlan, 'function');
  return shapeCore;
}

function walk(node, out = []) {
  if (node?.tagName) out.push(node);
  for (const child of node?.children || []) walk(child, out);
  return out;
}

function byClass(host, className) {
  return walk(host).filter(el => el.className.split(/\s+/).includes(className));
}

function button(host, label) {
  const found = walk(host).find(el => el.tagName === 'BUTTON' && el.textContent === label);
  assert.ok(found, label);
  return found;
}

function mount(source = scene(), parentWidth = 400) {
  const dom = createDom();
  const host = dom.element('div');
  host.style.width = `${parentWidth}px`;
  const changes = [];
  const commits = [];
  const exports = [];
  const editor = create({
    host,
    scene: source,
    document: dom.document,
    core: loadCore(),
    onChange(state) { changes.push(structuredClone(state)); },
    onCommit(state) { commits.push(structuredClone(state)); },
    onRequestExport(state) { exports.push(structuredClone(state)); },
  });
  return {dom, host, editor, changes, commits, exports};
}

function pointer(dom, target, type, x, y, extra = {}) {
  return dom.emit(target, type, {clientX: x, clientY: y, pointerId: 1, button: 0, ...extra});
}

function handles(host) {
  return walk(host).filter(el => el.getAttribute('data-handle') === 'value');
}

function points(host) {
  return byClass(host, 'falsify-mark-point');
}

test('bundle is local, pointer-driven, and has no network or Chart.js', () => {
  assert.equal(cssText, EDITOR_CSS);
  assert.match(cssText, /\.falsify-mark-handle\s*\{[^}]*fill:\s*#fffdf8/s);
  assert.match(cssText, /ns-resize/);
  assert.match(cssText, /ew-resize/);
  assert.match(cssText, /touch-action:\s*none/);
  assert.equal(cssText.includes('@import'), false);
  assert.equal(cssText.includes('http://'), false);
  assert.equal(cssText.includes('https://'), false);
  assert.match(bundleText, /FalsifyChartMarkEditor/);
  assert.match(bundleText, /setPointerCapture/);
  assert.match(bundleText, /set-values/);
  assert.match(bundleText, /x \(px\)/);
  for (const file of [bundleText, sourceText]) {
    assert.equal(/\bfetch\s*\(/.test(file), false);
    assert.equal(file.includes('XMLHttpRequest'), false);
    assert.equal(file.includes('new WebSocket'), false);
    assert.equal(file.includes('sendBeacon'), false);
    assert.equal(file.includes('innerHTML'), false);
    assert.equal(file.includes('chart.js'), false);
    assert.equal(file.includes('onpointerdown='), false);
  }
});

test('stage keeps the scene aspect ratio and precision starts collapsed', () => {
  const session = mount(scene(), 360);
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  assert.equal(stage.style.width, '100%');
  assert.equal(stage.style.aspectRatio, '400 / 300');
  const rect = stage.getBoundingClientRect();
  assert.equal(rect.width, 360);
  assert.equal(rect.height, 270);
  const details = walk(session.host).find(el => el.tagName === 'DETAILS');
  assert.equal(details.open, false);
  const summary = walk(session.host).find(el => el.tagName === 'SUMMARY');
  assert.equal(summary.textContent, '좌표 (px)');
  const headers = walk(session.host).filter(el => el.tagName === 'TH').map(el => el.textContent);
  assert.deepEqual(headers, ['계열', '번호', 'x (px)', 'y (px)']);
  const background = byClass(session.host, 'falsify-mark-background')[0];
  assert.equal(background.getAttribute('src'), 'data:image/png;base64,AAAA');
});

test('dragging a bar handle changes only its value axis through set-values', () => {
  const session = mount();
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  const handle = handles(session.host).find(el => el.getAttribute('data-index') === '0');
  pointer(session.dom, handle, 'pointerdown', 78, 170);
  pointer(session.dom, stage, 'pointermove', 90, 130);
  pointer(session.dom, stage, 'pointerup', 90, 130);
  const state = session.editor.getState();
  const point = state.scene.series[0].points[0];
  assert.equal(point.x, 78);
  assert.equal(point.y, 130);
  assert.equal(point.baseline, 260);
  assert.equal(point.width, 36);
  assert.equal(state.scene.series[0].points[1].y, 290);
  const op = state.operations.at(-1);
  assert.equal(op.kind, 'set-values');
  assert.deepEqual(op.points, [{index: 0, x: 78, y: 130}]);
  assert.equal(state.revision, 1);
  assert.deepEqual(Object.keys(session.commits.at(-1)).sort(), ['operations', 'revision', 'scene']);
  session.editor.undo();
  assert.equal(session.editor.getState().scene.series[0].points[0].y, 170);
  session.editor.redo();
  assert.equal(session.editor.getState().scene.series[0].points[0].y, 130);
});

test('a negative bar can cross its baseline and the body click does not drag', () => {
  const session = mount();
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  const body = byClass(session.host, 'falsify-mark-bar').find(el => el.getAttribute('data-index') === '1');
  pointer(session.dom, body, 'pointerdown', 198, 280);
  pointer(session.dom, stage, 'pointermove', 198, 240);
  pointer(session.dom, stage, 'pointerup', 198, 240);
  assert.equal(session.editor.getState().scene.series[0].points[1].y, 290);
  assert.equal(session.editor.getState().operations.length, 0);
  const handle = handles(session.host).find(el => el.getAttribute('data-index') === '1');
  pointer(session.dom, handle, 'pointerdown', 198, 290);
  pointer(session.dom, stage, 'pointermove', 210, 240);
  pointer(session.dom, stage, 'pointerup', 210, 240);
  const point = session.editor.getState().scene.series[0].points[1];
  assert.equal(point.x, 198);
  assert.equal(point.y, 240);
  assert.equal(point.baseline, 260);
  assert.equal(point.width, 36);
});

test('a horizontal bar handle moves only x', () => {
  const source = scene();
  source.series[0].orientation = 'horizontal';
  source.series[0].points = [{x: 180, y: 80, baseline: 60, width: 28, axis: 'x', role: 'bar-top'}];
  const session = mount(source);
  const handle = handles(session.host)[0];
  assert.equal(handle.className.includes('is-horizontal'), true);
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  pointer(session.dom, handle, 'pointerdown', 180, 80);
  pointer(session.dom, stage, 'pointermove', 210, 96);
  pointer(session.dom, stage, 'pointerup', 210, 96);
  const point = session.editor.getState().scene.series[0].points[0];
  assert.equal(point.x, 210);
  assert.equal(point.y, 80);
  assert.equal(point.baseline, 60);
  assert.equal(point.width, 28);
});

test('dragging a scatter point moves both axes and keeps the radius', () => {
  const session = mount();
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  const marker = points(session.host).find(el => el.getAttribute('data-index') === '0');
  pointer(session.dom, marker, 'pointerdown', 300, 200);
  pointer(session.dom, stage, 'pointermove', 315, 190);
  pointer(session.dom, stage, 'pointerup', 315, 190);
  const point = session.editor.getState().scene.series[1].points[0];
  assert.equal(point.x, 315);
  assert.equal(point.y, 190);
  assert.equal(point.radius, 6);
  assert.equal(session.editor.getState().scene.series[1].points[1].x, 340);
  assert.equal(session.editor.getState().operations.at(-1).kind, 'set-values');
});

test('compare shows the original crop and export reports the envelope', () => {
  const session = mount();
  const original = byClass(session.host, 'falsify-mark-original')[0];
  assert.equal(original.hidden, true);
  const stage = byClass(session.host, 'falsify-mark-stage')[0];
  pointer(session.dom, button(session.host, '원본 비교'), 'click', 0, 0);
  assert.equal(original.hidden, false);
  assert.equal(stage.className.includes('is-comparing'), true);
  assert.equal(button(session.host, '원본 비교').getAttribute('aria-pressed'), 'true');
  const svg = byClass(session.host, 'falsify-mark-svg')[0];
  assert.equal(svg.style.visibility, 'hidden');
  pointer(session.dom, button(session.host, '내보내기'), 'click', 0, 0);
  const payload = session.exports.at(-1);
  assert.deepEqual(Object.keys(payload).sort(), ['operations', 'revision', 'scene']);
  assert.equal(payload.scene.mode, 'marks');
});

test('precision edits the open axis and destroy rejects later calls', () => {
  const session = mount();
  const input = walk(session.host).find(el => el.tagName === 'INPUT' && el.getAttribute('data-series-id') === 'points' && el.getAttribute('data-axis') === 'x' && el.getAttribute('data-index') === '0');
  const locked = walk(session.host).find(el => el.tagName === 'INPUT' && el.getAttribute('data-series-id') === 'bars' && el.getAttribute('data-axis') === 'x' && el.getAttribute('data-index') === '0');
  assert.equal(locked.readOnly, true);
  input.value = '312';
  session.dom.emit(input, 'change', {target: input});
  assert.equal(session.editor.getState().scene.series[1].points[0].x, 312);
  assert.equal(session.editor.getState().scene.series[1].points[0].y, 200);
  session.editor.destroy();
  assert.equal(session.host.children.length, 0);
  assert.throws(() => session.editor.getState(), /destroyed/);
});


test('2000 marks coalesce drag previews and preserve precision rows until commit', () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map(); let next = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++next, fn); return next; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  try {
    const input = scene();
    input.series = [{id: 'points', kind: 'scatter', points: Array.from({length: 2000}, (_, i) => ({x: i % 400, y: 100, radius: 3}))}];
    const session = mount(input);
    const stage = byClass(session.host, 'falsify-mark-stage')[0];
    const body = walk(session.host).find(node => node.tagName === 'TBODY');
    const row = body.children[0];
    pointer(session.dom, points(session.host)[0], 'pointerdown', 0, 100);
    for (let i = 0; i < 10; i++) pointer(session.dom, stage, 'pointermove', i + 1, 110);
    assert.equal(frames.size, 1);
    const start = performance.now();
    const callback = [...frames.values()][0]; frames.clear(); callback();
    console.log(`MARK_DRAG_PERF ${JSON.stringify({marks: 2000, previewMs: performance.now() - start, environment: 'synthetic DOM'})}`);
    assert.equal(body.children[0], row);
    pointer(session.dom, stage, 'pointerup', 10, 110);
    assert.notEqual(body.children[0], row);
    assert.equal(session.commits.length, 1);
    session.editor.undo();
    assert.equal(session.editor.getState().scene.series[0].points[0].x, 0);
    pointer(session.dom, points(session.host)[0], 'pointerdown', 0, 100);
    pointer(session.dom, stage, 'pointermove', 20, 120);
    const stale = [...frames.values()][0];
    pointer(session.dom, stage, 'pointercancel', 20, 120);
    assert.equal(frames.size, 0);
    stale();
    assert.equal(session.editor.getState().scene.series[0].points[0].x, 0);
    pointer(session.dom, points(session.host)[0], 'pointerdown', 0, 100);
    pointer(session.dom, stage, 'pointermove', 30, 130);
    const destroyedFrame = [...frames.values()][0];
    session.editor.destroy();
    assert.equal(frames.size, 0);
    assert.doesNotThrow(() => destroyedFrame());
    assert.equal(session.host.children.length, 0);
  } finally { globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel; }
});

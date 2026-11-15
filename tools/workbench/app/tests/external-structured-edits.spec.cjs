'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const Red = require('../dist/external-red.js');
const Exchange = require('../dist/external-exchange.js');
const Proposals = require('../dist/external-proposals.js');
const VisualIntegration = require('../dist/paper-visual-integration.js');

const HASH = 'a'.repeat(64);
const SEGMENTS = [
  { id: 's0', label: 'PDF p. 1', pageIndex: 0, text: 'Table 1 summarizes accuracy. Baseline reached 81.2% on Validation.' },
  { id: 's1', label: 'PDF p. 2', pageIndex: 1, text: 'Figure 2 shows training loss over epochs.' },
];
const TABLES = [
  {
    id: 'table-1',
    pageIndex: 0,
    rows: [
      { cells: [{ text: 'Method', bbox: [10, 10, 50, 24] }, { text: 'Score', bbox: [60, 10, 100, 24] }] },
      { cells: [{ text: 'Baseline', bbox: [10, 30, 50, 44] }, { text: '81.2%', bbox: [60, 30, 100, 44] }] },
    ],
  },
  {
    id: 'table-dup-a',
    pageIndex: 1,
    cells: [{ row: 0, column: 0, text: '99.1%', bbox: [12, 12, 40, 22] }],
  },
  {
    id: 'table-dup-b',
    pageIndex: 1,
    cells: [{ row: 0, column: 0, text: '99.1%', bbox: [120, 12, 150, 22] }],
  },
];
const FIGURES = [
  {
    id: 'fig-2',
    pageIndex: 1,
    bbox: [40, 80, 320, 260],
    chart: {
      series: [{ id: 'loss', name: 'Training Loss', points: [{ x: 1, y: 0.9 }, { x: 2, y: 0.45 }] }],
    },
  },
];

function syntheticDom(options = {}) {
  const listeners = new Map();
  const makeNode = tag => {
    const nodeListeners = new Map();
    const n = {
      tagName: String(tag || 'DIV').toUpperCase(),
      children: [],
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      files: [],
      style: {},
      className: '',
      append(...items) { this.children.push(...items); },
      prepend(...items) { this.children.unshift(...items); },
      replaceChildren(...items) { this.children = items; },
      setAttribute(k, v) { this[k] = String(v); },
      addEventListener(type, fn) {
        if (!nodeListeners.has(type)) nodeListeners.set(type, []);
        nodeListeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of nodeListeners.get(ev.type) || []) fn(ev);
        return true;
      },
      click() { if (!this.disabled) this.dispatchEvent({ type: 'click', preventDefault() {} }); },
      select() { this.selected = true; },
      getClientRects() { return []; },
    };
    Object.defineProperty(n, 'innerHTML', { set() { throw Error('unsafe HTML'); } });
    return n;
  };
  const body = makeNode('body');
  const walk = n => [n, ...(n.children || []).flatMap(walk)];
  const document = {
    body,
    readyState: 'complete',
    createElement: makeNode,
    getElementById(id) { return walk(body).find(x => x.id === id) || null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return !ev.defaultPrevented;
    },
  };
  class CustomEventMock {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.cancelable = !!init.cancelable;
      this.defaultPrevented = false;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  if (options.withWorkspace) {
    const ws = makeNode('div');
    ws.id = 'paper-workspace';
    body.append(ws);
  }
  return { document, body, walk, makeNode, CustomEvent: CustomEventMock };
}

test('external-red buildPrompt omits visual schema by default and adds opt-in tableEdits/visualEdits schema', () => {
  const defaultPrompt = Red.buildPrompt({ segments: SEGMENTS, fileHash: HASH });
  assert.doesNotMatch(defaultPrompt, /tableEdits/);
  assert.doesNotMatch(defaultPrompt, /visualEdits/);

  const visualPrompt = Red.buildPrompt({
    segments: SEGMENTS,
    fileHash: HASH,
    includeVisualSchema: true,
    tables: TABLES.slice(0, 1),
    figures: FIGURES,
  });
  assert.match(visualPrompt, /tableEdits/);
  assert.match(visualPrompt, /visualEdits/);
  assert.match(visualPrompt, /table-1/);
  assert.match(visualPrompt, /fig-2/);

  const bluePrompt = Exchange.buildPrompt({
    role: 'blue',
    segments: SEGMENTS,
    includeVisualSchema: true,
    tables: TABLES,
  });
  assert.doesNotMatch(bluePrompt, /tableEdits/);
  assert.doesNotMatch(bluePrompt, /visualEdits/);
});

test('external-red parses JSON changes[], tableEdits[], visualEdits[], and Markdown structured blocks', () => {
  assert.equal(Red.parseExternalRedResponse, Red.parse);
  const jsonPayload = JSON.stringify({
    fileHash: HASH,
    changes: [
      { kind: 'table-cell', pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '94.7%' },
      { kind: 'chart-point', pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 1, before: 0.45, after: 0.12 },
    ],
    tableEdits: [
      { pageLabel: '1', tableId: 'table-1', row: '1-based: 2', column: '1-based: 1', before: 'Baseline', after: 'Proposed-Net' },
    ],
    visualEdits: [
      { pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 0, before: { x: 1, y: 0.9 }, after: { x: 1, y: 0.25 } },
    ],
  });
  const parsed = Red.parseExternalRedResponse(jsonPayload, { segments: SEGMENTS, fileHash: HASH, tables: TABLES, figures: FIGURES });
  assert.equal(parsed.proposals.length, 4);
  const [cell, point, oneBasedCell, objPoint] = parsed.proposals;
  assert.equal(cell.kind, 'table-cell');
  assert.equal(cell.status, 'matched');
  assert.equal(cell.anchor, null);
  assert.deepEqual(cell.tableTarget, {
    tableId: 'table-1',
    pageIndex: 0,
    row: 1,
    column: 1,
    bbox: [60, 30, 100, 44],
    before: '81.2%',
    after: '94.7%',
  });
  assert.equal(point.kind, 'chart-point');
  assert.equal(point.status, 'matched');
  assert.equal(point.anchor, null);
  assert.deepEqual(point.visualTarget, {
    figureId: 'fig-2',
    pageIndex: 1,
    bbox: [40, 80, 320, 260],
    series: 'loss',
    pointIndex: 1,
    markIndex: null,
    beforeValue: 0.45,
    afterValue: 0.12,
  });
  assert.equal(oneBasedCell.tableTarget.row, 1);
  assert.equal(oneBasedCell.tableTarget.column, 0);
  assert.deepEqual(objPoint.visualTarget.afterValue, { x: 1, y: 0.25 });

  const md = [
    '```markdown',
    '### 표 셀 변경',
    'pageLabel: 1',
    'tableId: table-1',
    'row: 2 (1-based)',
    'column: 2 (1-based)',
    'Before: 81.2%',
    'After: 88.0%',
    '',
    '---',
    '',
    '### Chart Edit',
    'page: 2',
    'figureId: fig-2',
    'series: loss',
    'pointIndex: 0 (0-based)',
    'Before: 0.9',
    'After: 0.15',
    '```',
  ].join('\n');
  const mdParsed = Red.parse(md, { segments: SEGMENTS, fileHash: HASH, tables: TABLES, figures: FIGURES });
  assert.equal(mdParsed.proposals.length, 2);
  assert.equal(mdParsed.proposals[0].kind, 'table-cell');
  assert.equal(mdParsed.proposals[0].tableTarget.row, 1);
  assert.equal(mdParsed.proposals[0].tableTarget.column, 1);
  assert.equal(mdParsed.proposals[1].kind, 'chart-point');
  assert.equal(mdParsed.proposals[1].visualTarget.afterValue, 0.15);
});

test('table-cell ambiguity, missing tables pending-table fallback, and chart diagnostics', () => {
  const ambig = Red.resolveTableEdit(
    { pageIndex: 1, row: 0, column: 0, before: '99.1%', after: '50.0%' },
    { tables: TABLES, diagnostics: [] }
  );
  assert.equal(ambig.status, 'ambiguous');
  assert.equal(ambig.matches.length, 2);
  assert.equal(ambig.tableTarget, null);

  const pendingDiags = [];
  const pending = Red.resolveTableEdit(
    { pageIndex: 3, tableId: 't-future', row: 2, column: 1, before: '12.3', after: '15.0' },
    { segments: SEGMENTS, diagnostics: pendingDiags }
  );
  assert.equal(pending.status, 'pending-table');
  assert.equal(pending.tableTarget.tableId, 't-future');
  assert.ok(pendingDiags.some(d => d.code === 'pending-table'));

  const noPageDiags = [];
  const missingPage = Red.resolveVisualEdit({ before: 10, after: 20 }, { diagnostics: noPageDiags });
  assert.equal(missingPage.status, 'unmatched');
  assert.ok(noPageDiags.some(d => d.code === 'missing-page'));

  const badCoordDiags = [];
  const badCoord = Red.resolveVisualEdit(
    { pageIndex: 1, figureId: 'fig-2', bbox: [50, 50, 10, 10], before: 'NaN', after: 20 },
    { figures: FIGURES, diagnostics: badCoordDiags }
  );
  assert.equal(badCoord.status, 'unmatched');
  assert.ok(badCoordDiags.some(d => d.code === 'invalid-coordinates'));

  const outOfRangeDiags = [];
  const outOfRange = Red.resolveVisualEdit(
    { pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 99, before: 1, after: 2 },
    { figures: FIGURES, diagnostics: outOfRangeDiags }
  );
  assert.equal(outOfRange.status, 'unmatched');
  assert.ok(outOfRangeDiags.some(d => d.code === 'invalid-coordinates'));

  const conflict = Red.parse(
    JSON.stringify({
      changes: [
        { kind: 'table-cell', pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '91.0%' },
        { kind: 'table-cell', pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '92.0%' },
      ],
    }),
    { segments: SEGMENTS, fileHash: HASH, tables: TABLES }
  );
  assert.equal(conflict.proposals[0].status, 'ambiguous');
  assert.equal(conflict.proposals[1].status, 'ambiguous');
  assert.ok(conflict.diagnostics.some(d => d.code === 'conflicting-replacement'));
});

test('external-exchange + external-proposals lifecycle, conflicts, binding, update, and ledger compatibility', () => {
  const raw = JSON.stringify({
    fileHash: HASH,
    changes: [
      { segmentId: 's0', before: 'Baseline reached 81.2%', after: 'Baseline reached 95.0%' },
    ],
    tableEdits: [
      { pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '94.7%' },
    ],
    visualEdits: [
      { pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 1, before: 0.45, after: 0.11 },
    ],
  });
  const batchA = Exchange.parse(raw, { role: 'red', fileHash: HASH, segments: SEGMENTS, tables: TABLES, figures: FIGURES });
  assert.equal(batchA.status, 'ok');
  assert.equal(batchA.items.length, 3);

  const batchB = Exchange.parse(
    JSON.stringify({
      fileHash: HASH,
      tableEdits: [
        { pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '99.9%' },
      ],
      visualEdits: [
        { pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 1, before: 0.45, after: 0.22 },
      ],
    }),
    { role: 'red', fileHash: HASH, segments: SEGMENTS, tables: TABLES, figures: FIGURES }
  );
  const batchPending = Exchange.parse(
    JSON.stringify({
      fileHash: HASH,
      tableEdits: [
        { pageIndex: 3, tableId: 'table-9', row: 0, column: 0, before: 'Unbound', after: 'Bound' },
      ],
    }),
    { role: 'red', fileHash: HASH, segments: SEGMENTS }
  );
  assert.equal(batchPending.items[0].matchStatus, 'pending-table');

  const store = Proposals.create({ fileHash: HASH, role: 'red', segments: SEGMENTS });
  store.append(batchA);
  store.append(batchB);
  store.append(batchPending);

  store.setEnabled('p1', true);
  store.setEnabled('p2', true);
  store.setEnabled('p3', true);
  assert.equal(store.edits().length, 1);
  assert.equal(store.tableEdits().length, 1);
  assert.equal(store.visualEdits().length, 1);
  assert.deepEqual(Object.keys(store.structuredEdits()).sort(), ['chartPoints', 'tableCells', 'text']);

  // Enabling conflicting table-cell (p4) and chart-point (p5) automatically disables p2 and p3
  store.setEnabled('p4', true);
  store.setEnabled('p5', true);
  assert.equal(store.snapshot().items.find(x => x.id === 'p2').enabled, false);
  assert.equal(store.snapshot().items.find(x => x.id === 'p4').enabled, true);
  assert.equal(store.snapshot().items.find(x => x.id === 'p3').enabled, false);
  assert.equal(store.snapshot().items.find(x => x.id === 'p5').enabled, true);

  // Update visual afterValue and bind pending table item (p6)
  store.update('p5', { afterValue: 0.05 });
  assert.equal(store.visualEdits()[0].visualTarget.afterValue, 0.05);
  assert.throws(() => store.update('p5', { afterValue: Number.NaN }));
  assert.throws(() => store.setEnabled('p6', true));
  store.bind('p6', { pageIndex: 3, tableId: 'table-9', row: 0, column: 0, bbox: [1, 2, 30, 40], before: 'Unbound' });
  store.setEnabled('p6', true);
  assert.equal(store.tableEdits().length, 2);

  // Snapshot / restore round-trip and ledger checkExternalAnchors invariant
  const snap = store.snapshot();
  const reloaded = Proposals.create({ fileHash: HASH, role: 'red', segments: SEGMENTS });
  reloaded.restore(snap);
  assert.deepEqual(reloaded.snapshot(), snap);
  for (const item of snap.items) {
    if (item.anchor) {
      const seg = SEGMENTS.find(s => s.id === item.segmentId);
      assert.equal(seg.text.slice(item.anchor.start, item.anchor.end), item.before);
    }
  }
});

test('external-red-ui displays structured table/chart badges cleanly without innerHTML', () => {
  const dom = syntheticDom({ withWorkspace: true });
  const accepted = [];
  const source = {
    fileHash: HASH,
    segments: SEGMENTS,
    tables: TABLES,
    figures: FIGURES,
  };
  let externalSnapshot = { items: [], batches: [] };
  const workspace = {
    getSource: () => source,
    getVisualContext: () => ({ tables: TABLES, figures: FIGURES }),
    acceptExternalResponse(b) {
      accepted.push(b);
      externalSnapshot = { items: b.items, batches: [b] };
    },
    getExternalResponses: () => externalSnapshot,
  };
  const ctx = {
    document: dom.document,
    FalsifyExternalExchange: Exchange,
    FalsifyPaperWorkspace: workspace,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true,
    Event: dom.CustomEvent,
    CustomEvent: dom.CustomEvent,
    JSON,
    Object,
    Array,
    String,
    Number,
    Error,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../dist/external-red-ui.js'), 'utf8'), ctx);

  const section = dom.document.getElementById('external-red');
  const nodes = () => dom.walk(section);
  const answer = nodes().find(n => n['aria-label'] === '외부 응답');
  answer.value = JSON.stringify({
    fileHash: HASH,
    tableEdits: [{ pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '94.7%' }],
    visualEdits: [{ pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 1, before: 0.45, after: 0.12 }],
  });
  nodes().find(n => n.tagName === 'BUTTON' && n.textContent === '응답 가져오기').click();

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].items.length, 2);
  const list = nodes().find(n => n.className === 'external-red-structured-list');
  assert.equal(list.hidden, false);
  assert.equal(list.children.length, 2);
  const text = dom.walk(list).map(x => x.textContent).join(' ');
  assert.match(text, /표 셀/);
  assert.match(text, /table-1/);
  assert.match(text, /81\.2% → 94\.7%/);
  assert.match(text, /차트/);
  assert.match(text, /fig-2/);
  assert.match(text, /0\.45 → 0\.12/);

  dom.document.dispatchEvent(new dom.CustomEvent('falsify:paper-workspace-source'));
  assert.equal(list.hidden, true);
  assert.equal(list.children.length, 0);
});

test('paper-visual-integration stages external table/chart edits with fileHash checks and preserves blind BLUE handoff', async () => {
  const batch = Exchange.parse(
    JSON.stringify({
      fileHash: HASH,
      tableEdits: [{ pageIndex: 0, tableId: 'table-1', row: 1, column: 1, before: '81.2%', after: '94.7%' }],
      visualEdits: [{ pageIndex: 1, figureId: 'fig-2', series: 'loss', pointIndex: 1, before: 0.45, after: 0.12 }],
    }),
    { role: 'red', fileHash: HASH, segments: SEGMENTS, tables: TABLES, figures: FIGURES }
  );
  const store = Proposals.create({ fileHash: HASH, role: 'red', segments: SEGMENTS });
  store.append(batch);
  store.setEnabled('p1', true);
  store.setEnabled('p2', true);
  const snap = store.snapshot();

  assert.throws(() => VisualIntegration.tableCellPatchesFromProposals(snap.items, {}), /fileHash/);
  assert.throws(() => VisualIntegration.stageExternalProposals(snap, { fileHash: 'wrong' }), /일치하지 않습니다/);

  const staged = VisualIntegration.stageExternalProposals(snap, { fileHash: HASH });
  assert.equal(staged.tableCells.length, 1);
  assert.deepEqual(staged.tableCells[0].bbox, [60, 30, 100, 44]);
  assert.equal(staged.tableCells[0].beforeText, '81.2%');
  assert.equal(staged.tableCells[0].afterText, '94.7%');
  assert.equal(staged.chartEdits.length, 1);
  assert.equal(staged.chartEdits[0].origin, 'external-ai-import');
  assert.equal(staged.chartEdits[0].before.series[0].points[1], 0.45);
  assert.equal(staged.chartEdits[0].after.series[0].points[1], 0.12);

  const edits = VisualIntegration.manualEdits(staged.chartEdits);
  assert.equal(edits[0].origin, 'external-ai-import');
  assert.match(edits[0].before, /0\.45/);
  assert.match(edits[0].after, /0\.12/);

  // Mount integration and check blind BLUE handoff
  const dom = syntheticDom();
  const host = dom.makeNode('div');
  host.id = 'document-red';
  const mountNodes = Object.fromEntries(
    ['red-visual-edit-host', 'red-visual-section', 'red-visual-analysis', 'red-visual-record-status'].map(id => {
      const n = dom.makeNode('div');
      n.id = id;
      return [id, n];
    })
  );
  const blueTab = dom.makeNode('button');
  blueTab['data-view'] = 'blue';
  blueTab.getClientRects = () => [{ width: 10, height: 10 }];
  dom.document.querySelectorAll = sel => (sel === '[data-view=blue]' ? [blueTab] : []);
  dom.document.getElementById = id => mountNodes[id] || (id === 'document-red' ? host : null);

  let editorCfg = null;
  let blueEventDetail = null;
  dom.document.addEventListener('falsify:blue-file', e => { blueEventDetail = e.detail; });
  const file = { name: 'paper.pdf', type: 'application/pdf', async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
  const ctx = {
    document: dom.document,
    CustomEvent: dom.CustomEvent,
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    structuredClone: globalThis.structuredClone,
    FalsifyLocalBridge: { session: () => null, busy() {}, capabilities: () => ({}) },
    FalsifyPaperWorkspace: { getSource: () => ({ file, fileHash: HASH, revision: 0, segments: SEGMENTS }), getPageIndex: () => 0 },
    FalsifyVisualEditUI: { create: cfg => { editorCfg = cfg; return { snapshot: () => null, refresh: async () => {}, clear() {} }; } },
    JSON, Object, Array, String, Set, Map, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../dist/paper-visual-integration.js'), 'utf8'), ctx);
  assert.equal(ctx.FalsifyVisualEditIntegration, ctx.FalsifyPaperVisualIntegration);

  const instance = ctx.FalsifyPaperVisualIntegration.instance;
  const fromMount = instance.stageFromProposals(snap);
  assert.equal(fromMount.chartEdits.length, 1);

  const blueFile = { name: 'edited.pdf', type: 'application/pdf' };
  await editorCfg.onOutput({ file: blueFile, changes: [{ id: 'p2', before: 'SECRET 0.45', after: 'SECRET 0.12' }] }, { intent: 'blue' });
  assert.deepEqual(Object.keys(blueEventDetail), ['file']);
  assert.equal(blueEventDetail.file, blueFile);
  assert.equal(JSON.stringify(blueEventDetail).includes('SECRET'), false);
});

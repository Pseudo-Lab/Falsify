'use strict';
// Synthetic chart values only. No paper image, network, or package install.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {readFileSync, existsSync} = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const runtimePath = path.join(app, 'dist/paper-chart-redraw.js');
const manifest = JSON.parse(readFileSync(path.join(app, 'dist/chart-redraw-vendor/manifest.json'), 'utf8'));
const upstream = JSON.parse(readFileSync(path.join(app, 'vendor-sources/chart-redraw/UPSTREAM.json'), 'utf8'));

function load() {
  const code = readFileSync(runtimePath, 'utf8');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    devicePixelRatio: 1,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  };
  vm.createContext(context);
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInContext(code, context, {filename: 'paper-chart-redraw.js', timeout: 5000});
  return context;
}

const sandbox = load();
const api = sandbox.FalsifyChartRedraw;
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function geometryAnalysis() {
  return {
    schema: 'falsify.chart-data.v1',
    title: 'Synthetic response',
    chartType: 'xy',
    pointKind: 'curve-sample',
    axes: {
      x: {label: 'Time', scale: 'linear', unit: 's'},
      y: {label: null, scale: 'linear', unit: 'mV'},
    },
    numericCells: [{row: 0, column: 3, value: 999, origin: 'model-estimate'}],
    rows: [['series-1', 'left', '0', '999']],
    geometry: {
      schema: 'falsify.chart-geometry.v1',
      pointKind: 'curve-sample',
      axes: {x: {scale: 'linear'}, left: {scale: 'linear'}},
      series: [{
        id: 'series-1',
        name: 'Trial',
        color: '#1f77b4',
        axisBinding: 'left',
        pointKind: 'curve-sample',
        points: [
          {x: 0, y: 1.5, xPixel: 10, yPixel: 40, pixelInterval: [1.2, 1.8], valueCandidates: {left: 1.5, right: 9}},
          {x: 2, y: -3, xPixel: 30, yPixel: 90},
        ],
      }],
    },
  };
}

function chart(extra) {
  return Object.assign({
    kind: 'line',
    title: '',
    xAxis: {scale: 'linear', min: 0, max: 10},
    yAxis: {scale: 'linear', min: -2, max: 2},
    series: [{id: 'a', name: 'A', color: '#ff0000', points: [{x: 1, y: 1}, {x: 4, y: -1}]}],
  }, extra);
}

test('pinned Chart.js bundle leaves no Chart global and matches its manifest', () => {
  const bytes = readFileSync(runtimePath);
  assert.equal(sandbox.Chart, undefined);
  assert.equal(sandbox.ChartErrorBars, undefined);
  assert.equal(sandbox.__FalsifyChartRedrawVendor, undefined);
  assert.equal(sandbox.__FALSIFY_CHART_FONT_BASE64__, undefined);
  assert.equal(api.provenance.chartJs, '4.6.1');
  assert.equal(api.provenance.errorBars, '4.4.5');
  assert.equal(api.pixelRatio, 2);
  assert.equal(manifest.runtime.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.runtime.bytes, bytes.length);
  assert.equal(manifest.upstream.chartJs.version, upstream.chartJs.version);
  assert.doesNotMatch(bytes.toString('utf8'), /sourceMappingURL/);
  const adapter = readFileSync(path.join(app, 'vendor-sources/chart-redraw/adapter.mjs'), 'utf8');
  assert.doesNotMatch(adapter, /watermark|confidence interval|diagnostic/i);
  for (const group of [upstream.chartJs, upstream.errorBars]) {
    for (const file of group.files) {
      const pinned = readFileSync(path.join(app, 'vendor-sources/chart-redraw', file.path));
      assert.equal(createHash('sha256').update(pinned).digest('hex'), file.sha256, file.path);
    }
  }
  const font = readFileSync(path.join(app, upstream.font.path));
  assert.equal(createHash('sha256').update(font).digest('hex'), api.provenance.fontSha256);
  assert.match(readFileSync(path.join(app, 'dist/chart-redraw-vendor/LICENSE-chart.js.md'), 'utf8'), /MIT License/);
  assert.match(readFileSync(path.join(app, 'dist/chart-redraw-vendor/LICENSE-chartjs-chart-error-bars'), 'utf8'), /MIT License/);
  assert.match(readFileSync(path.join(app, 'dist/chart-redraw-vendor/LICENSE-LM'), 'utf8'), /GUST Font License/);
});

test('fromAnalysis keeps PlotTracer source values and does not invent intervals', () => {
  const input = geometryAnalysis();
  const before = structuredClone(input);
  const mapped = plain(api.fromAnalysis(input));
  assert.deepEqual(input, before);
  assert.deepEqual(mapped, {
    kind: 'line',
    title: 'Synthetic response',
    xAxis: {scale: 'linear', label: 'Time'},
    yAxis: {scale: 'linear', label: 'mV'},
    series: [{
      id: 'series-1',
      name: 'Trial',
      color: '#1f77b4',
      points: [{x: 0, y: 1.5}, {x: 2, y: -3}],
    }],
  });
  assert.deepEqual(Object.keys(mapped.series[0].points[0]).sort(), ['x', 'y']);
  assert.deepEqual(plain(api.fromAnalysis(mapped)), mapped);
});

test('explicit chart type, order, palette, and error bars pass through unchanged', () => {
  const scatter = geometryAnalysis();
  scatter.chartType = 'scatter';
  scatter.geometry.series[0].points.reverse();
  assert.equal(api.fromAnalysis(scatter).kind, 'scatter');
  assert.deepEqual(api.fromAnalysis(scatter).series[0].points.map(point => point.x), [2, 0]);
  const bars = geometryAnalysis();
  bars.chartType = 'bar';
  assert.equal(api.fromAnalysis(bars).kind, 'bar');
  const colored = api.fromAnalysis({
    kind: 'line',
    title: 'Edited',
    xAxis: {scale: 'linear'},
    yAxis: {scale: 'linear'},
    series: [
      {id: 'kept', color: '#123456', points: [{x: 1, y: 2, yLow: 1, yHigh: 4, pixelInterval: [0, 1]}]},
      {id: 'plain', points: [{x: 3, y: 1}]},
    ],
  });
  assert.equal(colored.series[0].color, '#123456');
  assert.equal(colored.series[1].color, '#b03a2e');
  assert.deepEqual(plain(colored.series[0].points[0]), {x: 1, y: 2, yLow: 1, yHigh: 4});
  assert.equal(colored.series[1].name, 'plain');
});

test('log, ambiguous, and missing geometry are rejected', () => {
  const right = {
    schema: 'falsify.chart-geometry.v1',
    axes: {x: {scale: 'linear'}, right: {scale: 'log'}},
    series: [{id: 'r', axisBinding: 'right', color: '#111111', points: [{x: 1, y: 10}, {x: 2, y: 100}]}],
  };
  assert.equal(api.fromAnalysis(right).yAxis.scale, 'log');
  const dual = geometryAnalysis();
  dual.axes.y.scale = 'multiple';
  dual.geometry.axes.right = {scale: 'linear'};
  dual.geometry.series.push({id: 'series-2', axisBinding: 'right', color: '#222222', points: [{x: 1, y: 4}]});
  assert.throws(() => api.fromAnalysis(dual), /chart-y-axis-ambiguous/);
  const ambiguous = geometryAnalysis();
  ambiguous.geometry.series[0].axisBinding = 'ambiguous';
  ambiguous.geometry.series[0].points = [{x: 1, valueCandidates: {left: 2, right: 3}}];
  assert.throws(() => api.fromAnalysis(ambiguous), /chart-series-ambiguous/);
  assert.throws(() => api.fromAnalysis({schema: 'falsify.chart-data.v1', rows: [[1]], numericCells: [{value: 1}]}), /chart-analysis-unsupported/);
  assert.throws(() => api.fromAnalysis(chart({
    yAxis: {scale: 'log', min: 1, max: 100},
    series: [{id: 'a', color: '#ff0000', points: [{x: 1, y: 0}]}],
  })), /chart-log-nonpositive/);
  assert.throws(() => api.fromAnalysis(chart({
    series: [{id: 'a', color: '#ff0000', points: [{x: 1, y: 1, yLow: 0}]}],
  })), /chart-errorbar-incomplete/);
  assert.throws(() => api.fromAnalysis(chart({
    series: [{id: 'a', color: '#ff0000', points: [{x: 1, y: 1, yLow: 3, yHigh: 2}]}],
  })), /chart-errorbar-invalid/);
  assert.throws(() => api.fromAnalysis(chart({kind: 'pie'})), /chart-kind-invalid/);
  assert.throws(() => api.fromAnalysis(chart({series: [{id: 'a', color: 'not a color', points: [{x: 1, y: 1}]}]})), /chart-color-invalid/);
});

test('render rejects a missing canvas and a non-integer size before drawing', async () => {
  await assert.rejects(api.render({chart: chart(), width: 180, height: 120}), /chart-document-missing/);
  await assert.rejects(api.render({chart: chart(), width: 180.5, height: 120, document: {}}), /chart-size-invalid/);
});

function browserPath() {
  let bundled = '';
  try {
    bundled = require('playwright').chromium.executablePath();
  } catch {}
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    bundled,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

test('Chart.js canvas PNG keeps series, edits, log values, and explicit error bars', async () => {
  const executable = browserPath();
  assert.ok(executable, 'Edge or Chromium is required to read canvas PNG pixels');
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath: executable, headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 900, height: 700}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({path: runtimePath});
    const analysis = geometryAnalysis();
    const expected = plain(api.fromAnalysis(analysis));
    const diag = await page.evaluate(async source => {
      function scan(image, width, predicate) {
        let count = 0;
        let minY = Infinity;
        let maxY = -1;
        let ySum = 0;
        for (let index = 0, pixel = 0; index < image.length; index += 4, pixel += 1) {
          if (!predicate(image[index], image[index + 1], image[index + 2], image[index + 3])) continue;
          const y = Math.floor(pixel / width);
          count += 1;
          ySum += y;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        return {count, meanY: count ? ySum / count : null, span: count ? maxY - minY : 0};
      }
      const red = (r, g, b) => r > 160 && r > g + 50 && r > b + 50;
      const blue = (r, g, b) => b > 160 && b > r + 40 && b > g + 40;
      const dark = (r, g, b, a) => a > 200 && r < 80 && g < 80 && b < 80;
      async function draw(chart, width, height) {
        const rendered = await FalsifyChartRedraw.render({chart, width, height, document});
        const bitmap = await createImageBitmap(new Blob([rendered.png], {type: 'image/png'}));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const corner = context.getImageData(2, 2, 1, 1).data;
        return {rendered, image, corner, width: bitmap.width, height: bitmap.height};
      }
      const mapped = FalsifyChartRedraw.fromAnalysis(source);
      const resourcesBefore = performance.getEntriesByType('resource').length;
      let fetches = 0;
      window.fetch = () => {
        fetches += 1;
        return Promise.reject(new Error('network'));
      };
      const base = {kind: 'scatter', title: '', xAxis: {scale: 'linear', min: -1, max: 11}, yAxis: {scale: 'linear', min: -2, max: 2}, series: [{id: 'a', name: 'A', color: '#ff0000', points: [{x: 0, y: 0}, {x: 10, y: 0}]}]};
      const line = Object.assign({}, base, {kind: 'line'});
      const first = await draw(line, 180, 120);
      const second = await FalsifyChartRedraw.render({chart: line, width: 180, height: 120, document});
      let deterministic = first.rendered.png.length === second.png.length && first.rendered.width === second.width;
      if (deterministic) {
        for (let index = 0; index < second.png.length; index += 1) {
          if (first.rendered.png[index] !== second.png[index]) {
            deterministic = false;
            break;
          }
        }
      }
      const scatter = await draw(base, 180, 120);
      const bars = await draw({
        kind: 'bar',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 4},
        yAxis: {scale: 'linear', min: 0, max: 6},
        series: [{id: 'b', name: 'B', color: '#ff0000', points: [{x: 1, y: 2}, {x: 2, y: 5}, {x: 3, y: 3}]}],
      }, 180, 120);
      const point = {
        kind: 'scatter',
        title: '',
        xAxis: {scale: 'linear', min: -1, max: 1},
        yAxis: {scale: 'linear', min: -10, max: 10},
        series: [{id: 'p', name: 'P', color: '#ff0000', points: [{x: 0, y: 0}]}],
      };
      const withError = await draw({
        ...point,
        series: [{id: 'p', name: 'P', color: '#ff0000', points: [{x: 0, y: 0, yLow: -9, yHigh: 9}]}],
      }, 180, 140);
      const noError = await draw(point, 180, 140);
      const high = await draw({
        kind: 'scatter',
        title: '',
        xAxis: {scale: 'linear', min: -1, max: 1},
        yAxis: {scale: 'linear', min: -10, max: 10},
        series: [{id: 'h', color: '#ff0000', points: [{x: 0, y: 8}]}],
      }, 180, 140);
      const low = await draw({
        kind: 'scatter',
        title: '',
        xAxis: {scale: 'linear', min: -1, max: 1},
        yAxis: {scale: 'linear', min: -10, max: 10},
        series: [{id: 'l', color: '#ff0000', points: [{x: 0, y: -8}]}],
      }, 180, 140);
      const titled = await draw({
        kind: 'scatter',
        title: 'Synthetic title',
        xAxis: {scale: 'linear', label: 'Time', min: 0, max: 2},
        yAxis: {scale: 'linear', label: 'Signal', min: 0, max: 2},
        series: [{id: 't', color: '#ff0000', points: [{x: 1, y: 1}]}],
      }, 220, 140);
      const plain = await draw({
        kind: 'scatter',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 2},
        yAxis: {scale: 'linear', min: 0, max: 2},
        series: [{id: 't', color: '#ff0000', points: [{x: 1, y: 1}]}],
      }, 220, 140);
      const pair = await draw({
        kind: 'line',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 4},
        yAxis: {scale: 'linear', min: 0, max: 4},
        series: [
          {id: 'red', name: 'Red', color: '#ff0000', points: [{x: 0, y: 1}, {x: 4, y: 1}]},
          {id: 'blue', name: 'Blue', color: '#0033ff', points: [{x: 0, y: 3}, {x: 4, y: 3}]},
        ],
      }, 220, 140);
      const logged = await draw({
        kind: 'line',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 4},
        yAxis: {scale: 'log', min: 1, max: 1000},
        series: [{id: 'g', color: '#ff0000', points: [{x: 1, y: 10}, {x: 2, y: 100}, {x: 3, y: 1000}]}],
      }, 180, 140);
      let logCode = '';
      try {
        FalsifyChartRedraw.fromAnalysis({
          kind: 'line',
          xAxis: {scale: 'log'},
          yAxis: {scale: 'linear'},
          series: [{id: 'bad', points: [{x: 0, y: 1}]}],
        });
      } catch (error) {
        logCode = error.message;
      }
      const lineRed = scan(first.image, first.width, red);
      const resources = performance.getEntriesByType('resource').slice(resourcesBefore).map(entry => entry.name);
      return {
        chartGlobal: typeof window.Chart,
        mapped,
        fontReady: document.fonts.check('16px FalsifyChartText'),
        deterministic,
        fetches,
        resources,
        pngWidth: first.rendered.width,
        pngHeight: first.rendered.height,
        corner: Array.from(first.corner),
        lineCount: lineRed.count,
        scatterCount: scan(scatter.image, scatter.width, red).count,
        barCount: scan(bars.image, bars.width, red).count,
        errorSpan: scan(withError.image, withError.width, red).span,
        pointSpan: scan(noError.image, noError.width, red).span,
        highMean: scan(high.image, high.width, red).meanY,
        lowMean: scan(low.image, low.width, red).meanY,
        titleDark: scan(titled.image, titled.width, dark).count,
        plainDark: scan(plain.image, plain.width, dark).count,
        pairRed: scan(pair.image, pair.width, red).count,
        pairBlue: scan(pair.image, pair.width, blue).count,
        logCount: scan(logged.image, logged.width, red).count,
        logCode,
      };
    }, analysis);
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.equal(diag.chartGlobal, 'undefined');
    assert.deepEqual(diag.mapped, expected);
    assert.equal(diag.fontReady, true);
    assert.equal(diag.deterministic, true);
    assert.equal(diag.fetches, 0);
    assert.deepEqual(diag.resources, []);
    assert.equal(diag.pngWidth, 180 * api.pixelRatio);
    assert.equal(diag.pngHeight, 120 * api.pixelRatio);
    assert.ok(diag.corner[0] > 245 && diag.corner[1] > 245 && diag.corner[2] > 245, JSON.stringify(diag.corner));
    assert.ok(diag.lineCount > diag.scatterCount + 40, JSON.stringify(diag));
    assert.ok(diag.barCount > diag.scatterCount, JSON.stringify(diag));
    assert.ok(diag.errorSpan > diag.pointSpan + 30, JSON.stringify(diag));
    assert.ok(diag.highMean < diag.lowMean, JSON.stringify(diag));
    assert.ok(diag.titleDark > diag.plainDark, JSON.stringify(diag));
    assert.ok(diag.pairRed > 10 && diag.pairBlue > 10, JSON.stringify(diag));
    assert.ok(diag.logCount > 10, JSON.stringify(diag));
    assert.equal(diag.logCode, 'chart-log-nonpositive');
  } finally {
    await browser.close();
  }
});

test('calibrated axis ticks keep the original range despite subpixel trace noise',()=>{
 const x=geometryAnalysis();x.geometry.axes.x.points=[{pixel:10,value:0},{pixel:210,value:10}];
 x.geometry.axes.left.points=[{pixel:190,value:0},{pixel:10,value:100}];
 x.geometry.series[0].points[0].x=-0.002;
 const c=api.fromAnalysis(x);assert.equal(c.xAxis.min,0);assert.equal(c.xAxis.max,10);
 assert.equal(c.yAxis.min,0);assert.equal(c.yAxis.max,100);assert.equal(c.series[0].points[0].x,-0.002);
 x.axes.x.min=-1;assert.equal(api.fromAnalysis(x).xAxis.min,-1);
});

'use strict';
// User-edited chart values stay through normalization and redraw.
// Synthetic numbers only. No paper image and no network.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync, existsSync} = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const runtimePath = path.join(app, 'dist/paper-chart-redraw.js');

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

function editedChart(y) {
  return {
    kind: 'line',
    title: 'Edited spike',
    xAxis: {scale: 'linear', min: 0, max: 2},
    yAxis: {scale: 'linear', min: 0, max: 4},
    series: [{id: 'edited', name: 'Edited', color: '#d62728', points: [{x: 0, y: 0}, {x: 1, y}, {x: 2, y: 0}]}],
  };
}

test('user-edited y=3 is copied through chart compilation and is not fitted away', () => {
  const edited = editedChart(3);
  const before = structuredClone(edited);
  const mapped = plain(api.fromAnalysis(edited));
  const again = plain(api.fromAnalysis(mapped));
  assert.deepEqual(edited, before);
  assert.equal(mapped.series[0].points[1].y, 3);
  assert.equal(again.series[0].points[1].y, 3);
  assert.deepEqual(again.series[0].points.map(point => point.y), [0, 3, 0]);
  const payload = JSON.stringify(again);
  assert.equal(payload.includes('NaN') || payload.includes('Infinity'), false);
  assert.ok(payload.length < 100000);
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

test('redraw paints the y=3 spike instead of the fitted 0.06 stand-in', async () => {
  const executable = browserPath();
  assert.ok(executable, 'Edge or Chromium is required to read the redrawn spike');
  const {chromium} = require('playwright');
  const browser = await chromium.launch({executablePath: executable, headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 700, height: 500}});
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({path: runtimePath});
    const scan = await page.evaluate(async () => {
      function topInk(chart) {
        return FalsifyChartRedraw.render({chart, width: 240, height: 180, document}).then(rendered => {
          const blob = new Blob([rendered.png], {type: 'image/png'});
          return createImageBitmap(blob).then(bitmap => {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            context.drawImage(bitmap, 0, 0);
            const image = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            let minY = bitmap.height;
            let count = 0;
            for (let index = 0, pixel = 0; index < image.length; index += 4, pixel += 1) {
              const red = image[index];
              const green = image[index + 1];
              const blue = image[index + 2];
              if (!(red > 150 && red > green + 40 && red > blue + 40)) continue;
              count += 1;
              const y = Math.floor(pixel / bitmap.width);
              if (y < minY) minY = y;
            }
            return {minY, count, height: bitmap.height};
          });
        });
      }
      const spike = {
        kind: 'line',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 2},
        yAxis: {scale: 'linear', min: 0, max: 4},
        series: [{id: 'edited', name: 'Edited', color: '#d62728', points: [{x: 0, y: 0}, {x: 1, y: 3}, {x: 2, y: 0}]}],
      };
      const fitted = {
        kind: 'line',
        title: '',
        xAxis: {scale: 'linear', min: 0, max: 2},
        yAxis: {scale: 'linear', min: 0, max: 4},
        series: [{id: 'fitted', name: 'Fitted', color: '#d62728', points: [{x: 0, y: 0}, {x: 1, y: 0.06}, {x: 2, y: 0}]}],
      };
      const before = JSON.stringify(spike);
      const spikeInk = await topInk(spike);
      const fittedInk = await topInk(fitted);
      return {spikeInk, fittedInk, unchanged: JSON.stringify(spike) === before};
    });
    assert.equal(scan.unchanged, true);
    assert.ok(scan.spikeInk.count > 20, JSON.stringify(scan));
    assert.ok(scan.fittedInk.count > 20, JSON.stringify(scan));
    assert.ok(scan.spikeInk.minY + 25 < scan.fittedInk.minY, JSON.stringify(scan));
  } finally {
    await browser.close();
  }
});

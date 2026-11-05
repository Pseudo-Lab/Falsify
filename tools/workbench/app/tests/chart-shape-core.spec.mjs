import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const app = new URL('../', import.meta.url);
const bundleBytes = readFileSync(new URL('dist/chart-shape-core.js', app));
const manifest = JSON.parse(readFileSync(new URL('dist/chart-shape-vendor/manifest.json', app), 'utf8'));
const context = vm.createContext({});
vm.runInContext(bundleBytes.toString('utf8'), context, {timeout: 2000});
const api = context.FalsifyChartShape;

function scene(series) {
  return {
    schema: 'falsify.chart-scene.v1',
    sceneId: 'scene-1',
    sourceFileHash: 'a'.repeat(64),
    pageIndex: 0,
    bbox: [0, 0, 120, 80],
    width: 220,
    height: 140,
    plotBbox: [12, 10, 200, 120],
    revision: 0,
    series,
  };
}

function line(step, count, y, extras = () => ({})) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    points.push({x: index * step, y, origin: 'sample', ...extras(index)});
  }
  return points;
}

function values(points) {
  return points.map(point => ({x: point.x, y: point.y}));
}

function host(value) {
  return JSON.parse(JSON.stringify(value));
}

test('pinned Gaussian source and the esbuild bundle load without a browser or Node backend', () => {
  assert.equal(api.UPSTREAM_COMMIT, '5a87af23408aedf00e35e43ca6648a20cf6455bd');
  assert.equal(api.PROFILE, 'gaussian');
  assert.equal(manifest.bundle.sha256, createHash('sha256').update(bundleBytes).digest('hex'));
  assert.equal(manifest.bundle.bytes, bundleBytes.length);
  assert.equal(manifest.esbuild, '0.28.2');
  assert.equal(manifest.upstream.commit, api.UPSTREAM_COMMIT);
  assert.match(readFileSync(new URL('dist/chart-shape-vendor/LICENSE', app), 'utf8'), /MIT License/);
  assert.match(readFileSync(new URL('dist/chart-shape-vendor/NOTICE.md', app), 'utf8'), /5a87af23408aedf00e35e43ca6648a20cf6455bd/);
  const root = new URL('vendor-sources/chart-shape/ml-peak-shape-generator/', app);
  const upstream = JSON.parse(readFileSync(new URL('UPSTREAM.json', root), 'utf8'));
  for (const file of upstream.files) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(file.path, root))).digest('hex'), file.sha256, file.path);
  }
  assert.equal(vm.runInContext('typeof document+"/"+typeof require+"/"+typeof process', context), 'undefined/undefined/undefined');
});

test('zero and empty plans keep every sample bit-identical and do not mutate the baseline', () => {
  const input = scene([
    {id: 's', name: 'Trial', color: '#1f77b4', style: {width: 1.5, dashes: [2, 2]}, binding: {seqno: 9}, points: line(2, 21, 50)},
    {id: 'other', color: '#d62728', style: {width: 1}, points: [{x: 4, y: 7, origin: 'keep'}]},
  ]);
  const point = input.series[0].points[3];
  const before = JSON.stringify(input);
  const empty = api.applyPlan(input, []);
  const deform = api.applyPlan(input, [{id: 'd0', kind: 'deform', seriesId: 's', center: [20, 50], radius: 8, dx: 0, dy: 0}]);
  const move = api.applyPlan(input, [{id: 'm0', kind: 'move', seriesId: 's', range: [2, 6], dx: 0, dy: 0}]);
  const resize = api.applyPlan(input, [{id: 'r0', kind: 'resize', seriesId: 's', range: [2, 6], anchor: [20, 50], scaleX: 1, scaleY: 1}]);
  const same = api.applyPlan(input, [{id: 'v0', kind: 'set-values', seriesId: 's', points: [{index: 4, x: 8, y: 50}]}]);
  for (const result of [empty, deform, move, resize, same]) {
    assert.deepEqual(values(result.scene.series[0].points), values(input.series[0].points));
    assert.equal(result.scene.series[0].points[4].origin, 'sample');
    assert.deepEqual(host(result.scene.series[0].binding), {seqno: 9});
    assert.deepEqual(host(result.scene.series[1].points), input.series[1].points);
    assert.equal(result.scene.revision, 0);
    assert.notEqual(result.scene, input);
  }
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.series[0].points[3], point);
  assert.throws(() => api.applyPlan(input, [{id: 'bad', kind: 'warp', seriesId: 's'}]), /chart_shape_invalid/);
});

test('deform support is a finite path radius and the boundary sample is unchanged', () => {
  const points = line(10, 7, 50);
  const input = scene([{id: 's', color: '#111111', style: {width: 2}, points}]);
  const result = api.applyPlan(input, [{id: 'd', kind: 'deform', seriesId: 's', center: [20, 50], radius: 10, dx: 0, dy: -8}]);
  const edited = result.scene.series[0].points;
  assert.equal(edited[2].x, 20);
  assert.equal(edited[2].y, 42);
  assert.deepEqual(host(result.changes[0].indexes), [2]);
  for (const index of [0, 1, 3, 4, 5, 6]) {
    assert.equal(edited[index].x, points[index].x);
    assert.equal(edited[index].y, points[index].y);
  }
  assert.equal(input.series[0].points[2].y, 50);
});

test('peaks and wells share a Gaussian width and a larger radius widens the support', () => {
  const count = 81;
  const center = 40;
  const input = scene([{id: 's', color: '#111111', style: {width: 1}, points: line(2, count, 40)}]);
  const run = (radius, dy) => api.applyPlan(input, [{
    id: 'd', kind: 'deform', seriesId: 's', center: [80, 40], radius, dx: 0, dy,
  }]).scene.series[0].points;
  const peak = run(20, -12);
  const well = run(20, 12);
  const wide = run(40, -12);
  const affected = points => points.flatMap((point, index) => point.y === 40 ? [] : [index]);
  assert.deepEqual(affected(peak), affected(well));
  assert.equal(affected(peak).length, 19);
  assert.equal(affected(wide).length, 39);
  for (let index = 0; index < count; index += 1) {
    const distance = Math.abs(index - center) * 2;
    if (distance >= 20) {
      assert.equal(peak[index].y, 40);
      assert.equal(well[index].y, 40);
    } else {
      assert.ok(Math.abs((well[index].y - 40) - (40 - peak[index].y)) < 1e-12);
    }
  }
  const midway = peak[center + 5].y - 40;
  assert.ok(Math.abs(midway + 6) < 1e-9);
  const halfSpan = points => {
    let span = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.y - 40) >= 6 - 1e-9) span = Math.max(span, Math.abs(index - center));
    });
    return span;
  };
  assert.equal(halfSpan(peak), halfSpan(well));
  assert.ok(halfSpan(wide) > halfSpan(peak));
});

test('a local bump joins the unchanged curve with a vanishing boundary slope', () => {
  const input = scene([{id:'s', points:line(0.1, 1002, 0)}]);
  const points = api.applyPlan(input, [{id:'edge',kind:'deform',seriesId:'s',center:[0,0],radius:100,dx:0,dy:1}]).scene.series[0].points;
  assert.equal(points[0].y, 1);
  assert.equal(points[1000].y, 0);
  assert.equal(points[1001].y, 0);
  assert.ok(points[999].y > 0);
  assert.ok(points[999].y / 0.1 < 0.0001, 'support edge must not form a hard corner');
});

test('added deform keeps sample noise and move or resize keeps the irregular offsets', () => {
  const noise = [0, 2.4, -1.8, 3.3, -0.7, 1.9, -2.6, 0.4];
  const points = line(2, 81, 40, index => ({y: 40 + noise[index % noise.length]}));
  const input = scene([{id: 's', color: '#111111', style: {width: 1}, points}]);
  const edited = api.applyPlan(input, [{id: 'd', kind: 'deform', seriesId: 's', center: [80, 40], radius: 20, dx: 0, dy: -12}]).scene.series[0].points;
  const second = rows => {
    const out = [];
    for (let index = 1; index < rows.length - 1; index += 1) out.push(rows[index - 1] - 2 * rows[index] + rows[index + 1]);
    return out;
  };
  const rms = rows => Math.sqrt(rows.reduce((sum, value) => sum + value * value, 0) / rows.length);
  const delta = edited.map((point, index) => point.y - points[index].y);
  const originalSecond = second(points.map(point => point.y));
  assert.ok(rms(second(delta)) < rms(originalSecond) * 0.25);
  assert.ok(rms(second(edited.map(point => point.y))) > rms(originalSecond) * 0.75);
  assert.equal(edited[40].y, points[40].y - 12);
  assert.notEqual(points[41].y, 40);
  assert.equal(edited[50].y, points[50].y);

  const moved = api.applyPlan(input, [{id: 'm', kind: 'move', seriesId: 's', range: [10, 20], dx: 4, dy: -3}]).scene.series[0].points;
  for (let index = 0; index < points.length; index += 1) {
    const inside = index >= 10 && index <= 20;
    assert.equal(moved[index].x, points[index].x + (inside ? 4 : 0));
    assert.equal(moved[index].y, points[index].y + (inside ? -3 : 0));
    assert.equal(moved[index].origin, 'sample');
  }
  const resized = api.applyPlan(input, [{
    id: 'r', kind: 'resize', seriesId: 's', range: [30, 50], anchor: [80, 40], scaleX: 2, scaleY: 1,
  }]).scene.series[0].points;
  for (let index = 0; index < points.length; index += 1) {
    const inside = index >= 30 && index <= 50;
    assert.equal(resized[index].y, points[index].y);
    assert.equal(resized[index].x, inside ? 80 + (points[index].x - 80) * 2 : points[index].x);
  }
  const replaced = api.applyPlan(input, [{id: 'v', kind: 'set-values', seriesId: 's', points: [{index: 4, x: 9, y: 11}]}]).scene.series[0].points;
  assert.equal(replaced[4].x, 9);
  assert.equal(replaced[4].y, 11);
  assert.equal(replaced[4].origin, 'sample');
  assert.equal(replaced[3].x, points[3].x);
  assert.equal(replaced[5].y, points[5].y);
});

test('deform follows one branch and does not pull a nearby disconnected component', () => {
  const folded = [
    {x: 0, y: 0, branch: 'a'}, {x: 10, y: 0, branch: 'a'}, {x: 20, y: 0, branch: 'a'},
    {x: 20, y: 3, branch: 'b'}, {x: 30, y: 3, branch: 'b'},
    {x: 30, y: 0, branch: 'a'}, {x: 40, y: 0, branch: 'a'},
    {x: 40, y: 10, branch: 'a'}, {x: 20, y: 10, branch: 'a'},
  ];
  const input = scene([{id: 's', color: '#111111', style: {width: 1}, points: folded}]);
  const edited = api.applyPlan(input, [{
    id: 'd', kind: 'deform', seriesId: 's', center: [20, 0], radius: 25, dx: 4, dy: -6,
  }]).scene.series[0].points;
  assert.equal(edited[2].x, 24);
  assert.equal(edited[2].y, -6);
  assert.equal(edited[3].x, 20);
  assert.equal(edited[3].y, 3);
  assert.equal(edited[4].x, 30);
  assert.equal(edited[4].y, 3);
  assert.notEqual(edited[5].x, folded[5].x);
  assert.equal(edited[8].x, folded[8].x);
  assert.equal(edited[8].y, folded[8].y);
  assert.ok(Math.hypot(folded[8].x - 20, folded[8].y - 0) < 25);
  assert.equal(input.series[0].points[2].x, 20);
  assert.equal(input.series[0].points[3].y, 3);

  const gapped = [];
  for (let x = 0; x <= 20; x += 2) gapped.push({x, y: 0, origin: 'a'});
  gapped.push({x: 35, y: 0, origin: 'b'}, {x: 37, y: 0, origin: 'b'});
  const gapScene = scene([{id: 's', color: '#111111', style: {width: 1}, points: gapped}]);
  const gapEdited = api.applyPlan(gapScene, [{
    id: 'g', kind: 'deform', seriesId: 's', center: [20, 0], radius: 20, dx: 0, dy: -5,
  }]).scene.series[0].points;
  assert.equal(gapEdited[10].y, -5);
  assert.equal(gapEdited[11].x, 35);
  assert.equal(gapEdited[11].y, 0);
  assert.equal(gapEdited[12].y, 0);
});

test('history replays the immutable baseline and a later commit drops the redo tail', () => {
  const points = line(10, 7, 50);
  const input = scene([{id: 's', color: '#111111', style: {width: 1}, points}]);
  const deform = {id: 'd', kind: 'deform', seriesId: 's', center: [20, 50], radius: 30, dx: 0, dy: -8};
  const move = {id: 'm', kind: 'move', seriesId: 's', range: [1, 3], dx: 5, dy: 0};
  const other = {id: 'v', kind: 'set-values', seriesId: 's', points: [{index: 0, x: 1, y: 2}]};
  const history = api.createHistory(input);
  input.series[0].points[2].y = 999;
  const first = history.commit(deform);
  assert.equal(first.series[0].points[2].y, 42);
  first.series[0].points[2].y = 12345;
  history.commit(move);
  assert.equal(history.canUndo(), true);
  const undone = history.undo();
  assert.deepEqual(values(undone.series[0].points), values(api.applyPlan(scene([{id: 's', color: '#111111', style: {width: 1}, points: line(10, 7, 50)}]), [deform]).scene.series[0].points));
  const baseline = history.undo();
  assert.deepEqual(values(baseline.series[0].points), values(line(10, 7, 50)));
  assert.equal(history.canUndo(), false);
  assert.equal(history.cursor(), 0);
  const redone = history.redo();
  assert.equal(redone.series[0].points[2].y, 42);
  history.commit(other);
  assert.equal(history.canRedo(), false);
  assert.equal(history.getScene().series[0].points[0].x, 1);
  assert.equal(history.getScene().series[0].points[0].y, 2);
  assert.notEqual(history.getScene().series[0].points[1].x, 15);
  const grouped = api.createHistory(scene([{id: 's', color: '#111111', style: {width: 1}, points: line(10, 7, 50)}]));
  const preview = grouped.preview(deform);
  assert.equal(grouped.index(), 0);
  assert.equal(preview.series[0].points[2].y, 42);
  grouped.apply([deform, move]);
  assert.equal(grouped.index(), 1);
  assert.equal(grouped.operations().length, 2);
  assert.deepEqual(values(grouped.undo().series[0].points), values(line(10, 7, 50)));
  assert.equal(grouped.scene().series[0].points[2].y, 50);
});

test('hit testing uses the selected branch segment and misses across a gap', () => {
  const input = scene([
    {id: 'near', color: '#111111', style: {width: 1}, points: [{x: 0, y: 0, branch: 'a'}, {x: 10, y: 0, branch: 'a'}, {x: 12, y: 0, branch: 'b'}, {x: 22, y: 0, branch: 'b'}]},
    {id: 'far', color: '#222222', style: {width: 1}, points: [{x: 0, y: 20}, {x: 10, y: 20}]},
  ]);
  const onSegment = api.hitTest(input, 2, 1.5, 2);
  assert.equal(onSegment.seriesId, 'near');
  assert.equal(onSegment.index, 0);
  assert.equal(onSegment.segmentStart, 0);
  assert.equal(onSegment.nextIndex, 1);
  assert.equal(onSegment.branch, 'a');
  assert.equal(onSegment.y, 0);
  assert.equal(onSegment.x, 2);
  assert.ok(Math.abs(onSegment.distance - 1.5) < 1e-9);
  assert.equal(api.hitTest(input, 8, 1, 2).index, 1);
  assert.equal(api.hitTest(input, 5, 3, 1), null);
  const gap = api.hitTest(input, 11, 5, 5.02);
  assert.equal(gap, null);
  const nearer = api.hitTest(input, 5, 6, 20);
  assert.equal(nearer.seriesId, 'near');
  const endpoint = api.hitTest(input, 10, 0, 0);
  assert.equal(endpoint.distance, 0);
  assert.equal(endpoint.seriesId, 'near');
});

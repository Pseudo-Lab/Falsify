import {gaussianFct} from '../vendor-sources/chart-shape/ml-peak-shape-generator/src/shapes/1d/gaussian/Gaussian.ts';
import {editLinearTrack} from './chart-linear-core.mjs';

export const UPSTREAM_COMMIT = '5a87af23408aedf00e35e43ca6648a20cf6455bd';
export const PROFILE = 'gaussian';

const BRANCH_GAP_FLOOR = 12;
const BRANCH_GAP_FACTOR = 4;

function invalid(detail) {
  throw new Error(detail ? `chart_shape_invalid: ${detail}` : 'chart_shape_invalid');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = clone(value[key]);
    return copy;
  }
  return value;
}

function requireScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene) || !Array.isArray(scene.series)) invalid('scene');
  const ids = new Set();
  for (const series of scene.series) {
    if (!series || typeof series !== 'object' || typeof series.id !== 'string' || series.id.length === 0 || !Array.isArray(series.points)) invalid('series');
    if (ids.has(series.id)) invalid('series');
    ids.add(series.id);
  }
  return scene;
}

function requirePoint(point, index) {
  if (!point || typeof point !== 'object' || !finite(point.x) || !finite(point.y)) invalid(`point ${index}`);
}

function requireRange(range, length) {
  if (!Array.isArray(range) || range.length !== 2 || !integer(range[0]) || !integer(range[1])) invalid('range');
  if (range[0] < 0 || range[1] < range[0] || range[1] >= length) invalid('range');
  return range;
}

function seriesById(scene, seriesId) {
  if (typeof seriesId !== 'string') invalid('series');
  const series = scene.series.find(item => item.id === seriesId);
  if (!series) invalid('series');
  return series;
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function branchRuns(points) {
  const explicit = points.some(point => Object.prototype.hasOwnProperty.call(point, 'branch'));
  if (explicit) {
    const order = [];
    const groups = new Map();
    for (let index = 0; index < points.length; index += 1) {
      const id = Object.prototype.hasOwnProperty.call(points[index], 'branch') ? String(points[index].branch) : '';
      if (!groups.has(id)) {
        groups.set(id, []);
        order.push(id);
      }
      groups.get(id).push(index);
    }
    return order.map(id => ({id, indexes: groups.get(id)}));
  }
  const gaps = [];
  for (let index = 1; index < points.length; index += 1) gaps.push(pointDistance(points[index - 1], points[index]));
  const positive = gaps.filter(gap => gap > 0 && Number.isFinite(gap)).sort((left, right) => left - right);
  const median = positive.length ? positive[Math.floor((positive.length - 1) / 2)] : 0;
  const limit = Math.max(BRANCH_GAP_FLOOR, median * BRANCH_GAP_FACTOR);
  const runs = [];
  let current = points.length ? [0] : [];
  for (let index = 1; index < points.length; index += 1) {
    if (gaps[index - 1] > limit) {
      runs.push({id: null, indexes: current});
      current = [index];
    } else current.push(index);
  }
  if (current.length) runs.push({id: null, indexes: current});
  return runs;
}

// Taper the outer fifth to zero with zero slope, joining the unchanged curve
// smoothly while keeping the upstream Gaussian's center and half-height width.
function influence(distance, radius) {
  if (!(distance < radius)) return 0;
  if (distance === 0) return 1;
  const weight = gaussianFct(distance, radius);
  if (distance <= radius * 0.8) return weight;
  const t = (distance / radius - 0.8) / 0.2;
  return weight * (1 - t * t * (3 - 2 * t));
}

function deformAlongBranch(points, operation, along) {
  const changed = [];
  for (const [index, distance] of along) {
    const weight = influence(distance, operation.radius);
    if (weight === 0) continue;
    const point = points[index];
    const x = operation.dx === 0 ? point.x : (weight === 1 ? point.x + operation.dx : point.x + operation.dx * weight);
    const y = operation.dy === 0 ? point.y : (weight === 1 ? point.y + operation.dy : point.y + operation.dy * weight);
    if (x !== point.x || y !== point.y) {
      point.x = x;
      point.y = y;
      changed.push(index);
    }
  }
  changed.sort((left, right) => left - right);
  return changed;
}

function nearestPoint(points, center) {
  let anchor = -1;
  let nearest = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    requirePoint(points[index], index);
    const distance = Math.hypot(points[index].x - center[0], points[index].y - center[1]);
    if (distance < nearest) {
      nearest = distance;
      anchor = index;
    }
  }
  return {anchor, nearest};
}

function validateDeform(operation) {
  const center = operation.center;
  if (!Array.isArray(center) || center.length !== 2 || !finite(center[0]) || !finite(center[1])) invalid('center');
  if (!finite(operation.radius) || !(operation.radius > 0)) invalid('radius');
  if (!finite(operation.dx) || !finite(operation.dy)) invalid('delta');
}

function applyDeform(points, operation) {
  validateDeform(operation);
  const center = operation.center;
  if (points.length === 0 || (operation.dx === 0 && operation.dy === 0)) return [];
  const {anchor, nearest} = nearestPoint(points, center);
  if (!(nearest <= operation.radius)) return [];
  const run = branchRuns(points).find(item => item.indexes.includes(anchor));
  const place = run.indexes.indexOf(anchor);
  const along = new Map([[anchor, 0]]);
  for (let step = place - 1; step >= 0; step -= 1) {
    const index = run.indexes[step];
    const next = run.indexes[step + 1];
    along.set(index, along.get(next) + pointDistance(points[index], points[next]));
  }
  for (let step = place + 1; step < run.indexes.length; step += 1) {
    const index = run.indexes[step];
    const previous = run.indexes[step - 1];
    along.set(index, along.get(previous) + pointDistance(points[index], points[previous]));
  }
  return deformAlongBranch(points, operation, along);
}

export function linkedSeriesIds(scene, seriesId) {
  const found = new Set([seriesId]);
  const pending = [seriesId];
  while (pending.length) {
    const current = pending.pop();
    for (const [a, b] of scene.curveLinks || []) {
      const next = a[0] === current ? b[0] : b[0] === current ? a[0] : null;
      if (next === null || found.has(next)) continue;
      found.add(next);
      pending.push(next);
    }
  }
  return [...found];
}

const nodeKey = (seriesId, index) => JSON.stringify([seriesId, index]);

function connectNodes(nodes, a, b) {
  const left = nodes.get(a), right = nodes.get(b);
  if (!left || !right) invalid('links');
  const distance = pointDistance(left.point, right.point);
  left.neighbors.push([b, distance]);
  right.neighbors.push([a, distance]);
}

function networkNodes(scene, ids) {
  const nodes = new Map();
  for (const series of scene.series.filter(s => ids.includes(s.id))) {
    series.points.forEach((point, index) => {
      requirePoint(point, index);
      nodes.set(nodeKey(series.id, index), {point, seriesId: series.id, index, neighbors: []});
    });
    for (const run of branchRuns(series.points)) {
      for (let i = 1; i < run.indexes.length; i += 1) {
        connectNodes(nodes, nodeKey(series.id, run.indexes[i - 1]), nodeKey(series.id, run.indexes[i]));
      }
    }
  }
  for (const [a, b] of scene.curveLinks || []) {
    if (ids.includes(a[0]) && ids.includes(b[0])) connectNodes(nodes, nodeKey(...a), nodeKey(...b));
  }
  return nodes;
}

function networkDistances(nodes, start, radius) {
  const distances = new Map([[start, 0]]);
  const pending = [[start, 0]];
  while (pending.length) {
    pending.sort((a, b) => b[1] - a[1]);
    const [key, distance] = pending.pop();
    if (distance !== distances.get(key)) continue;
    for (const [next, length] of nodes.get(key).neighbors) {
      const value = distance + length;
      if (value >= radius || value >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, value);
      pending.push([next, value]);
    }
  }
  return distances;
}

function applyNetworkDeform(scene, series, operation) {
  validateDeform(operation);
  const {anchor, nearest} = nearestPoint(series.points, operation.center);
  const change = {id: operation.id, kind: operation.kind, seriesId: series.id, indexes: [], linked: []};
  if (anchor < 0 || nearest > operation.radius || (!operation.dx && !operation.dy)) return change;
  const ids = linkedSeriesIds(scene, series.id);
  const nodes = networkNodes(scene, ids);
  const distances = networkDistances(nodes, nodeKey(series.id, anchor), operation.radius);
  const paths = new Map(ids.map(id => [id, new Map()]));
  for (const [key, distance] of distances) {
    const node = nodes.get(key);
    paths.get(node.seriesId).set(node.index, distance);
  }
  for (const current of scene.series.filter(s => ids.includes(s.id))) {
    const indexes = deformAlongBranch(current.points, operation, paths.get(current.id));
    if (current.id === series.id) change.indexes = indexes;
    if (indexes.length) change.linked.push({seriesId: current.id, indexes});
  }
  return change;
}

function applyMove(points, operation) {
  const range = requireRange(operation.range, points.length);
  if (!finite(operation.dx) || !finite(operation.dy)) invalid('delta');
  if (operation.dx === 0 && operation.dy === 0) return [];
  const changed = [];
  for (let index = range[0]; index <= range[1]; index += 1) {
    requirePoint(points[index], index);
    points[index].x += operation.dx;
    points[index].y += operation.dy;
    changed.push(index);
  }
  return changed;
}

function resizeRange(points, operation, anchor, range) {
  const changed = [];
  for (let index = range[0]; index <= range[1]; index += 1) {
    requirePoint(points[index], index);
    const point = points[index];
    const x = operation.scaleX === 1 ? point.x : anchor[0] + (point.x - anchor[0]) * operation.scaleX;
    const y = operation.scaleY === 1 ? point.y : anchor[1] + (point.y - anchor[1]) * operation.scaleY;
    if (x !== point.x || y !== point.y) {
      point.x = x;
      point.y = y;
      changed.push(index);
    }
  }
  return changed;
}

function applyResize(points, operation) {
  const range = requireRange(operation.range, points.length);
  const anchor = operation.anchor;
  if (!Array.isArray(anchor) || anchor.length !== 2 || !finite(anchor[0]) || !finite(anchor[1])) invalid('anchor');
  if (!finite(operation.scaleX) || !(operation.scaleX > 0) || !finite(operation.scaleY) || !(operation.scaleY > 0)) invalid('scale');
  if (operation.scaleX === 1 && operation.scaleY === 1) return [];
  return resizeRange(points, operation, anchor, range);
}

function applySetValues(points, operation) {
  if (!Array.isArray(operation.points)) invalid('points');
  const changed = new Set();
  for (const edit of operation.points) {
    if (!edit || typeof edit !== 'object' || !integer(edit.index) || edit.index < 0 || edit.index >= points.length) invalid('index');
    if (!finite(edit.x) || !finite(edit.y)) invalid('point');
    requirePoint(points[edit.index], edit.index);
    if (points[edit.index].x !== edit.x || points[edit.index].y !== edit.y) {
      points[edit.index].x = edit.x;
      points[edit.index].y = edit.y;
      changed.add(edit.index);
    }
  }
  return [...changed].sort((left, right) => left - right);
}

function applyOperation(scene, operation) {
  if (!operation || typeof operation !== 'object' || typeof operation.id !== 'string' || operation.id.length === 0) invalid('operation');
  if (operation.kind === 'linear-edit') return editLinearTrack(scene, operation);
  const series = seriesById(scene, operation.seriesId);
  if (operation.kind === 'deform' && scene.curveLinks?.length) return applyNetworkDeform(scene, series, operation);
  let indexes;
  if (operation.kind === 'deform') indexes = applyDeform(series.points, operation);
  else if (operation.kind === 'move') indexes = applyMove(series.points, operation);
  else if (operation.kind === 'resize') indexes = applyResize(series.points, operation);
  else if (operation.kind === 'set-values') indexes = applySetValues(series.points, operation);
  else invalid('kind');
  return {id: operation.id, kind: operation.kind, seriesId: series.id, indexes};
}

export function applyPlan(scene, operations) {
  if (!Array.isArray(operations)) invalid('operations');
  if (operations.some(op => op?.kind === 'linear-edit') && operations.some(op => op?.kind !== 'linear-edit')) invalid('mixed linear and legacy operations');
  const edited = clone(requireScene(scene));
  const changes = operations.map(operation => applyOperation(edited, operation));
  return {scene: edited, changes};
}

export function createHistory(scene) {
  const baseline = clone(requireScene(scene));
  const groups = [];
  let cursor = 0;
  function flat() {
    return groups.slice(0, cursor).flat();
  }
  function present(operations = flat()) {
    return applyPlan(baseline, operations).scene;
  }
  function apply(operations) {
    const list = (Array.isArray(operations) ? operations : [operations]).map(operation => clone(operation));
    const edited = applyPlan(baseline, flat().concat(list)).scene;
    groups.splice(cursor);
    groups.push(list);
    cursor += 1;
    return edited;
  }
  return {
    baseline,
    apply,
    commit(operation) {
      return apply(operation);
    },
    preview(operations) {
      const list = (Array.isArray(operations) ? operations : [operations]).map(operation => clone(operation));
      return present(flat().concat(list));
    },
    undo() {
      if (cursor > 0) cursor -= 1;
      return present();
    },
    redo() {
      if (cursor < groups.length) cursor += 1;
      return present();
    },
    scene() {
      return present();
    },
    getScene() {
      return present();
    },
    operations() {
      return flat().map(operation => clone(operation));
    },
    index() {
      return cursor;
    },
    cursor() {
      return cursor;
    },
    canUndo() {
      return cursor > 0;
    },
    canRedo() {
      return cursor < groups.length;
    },
  };
}

function segmentPoint(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return {distance: Math.hypot(px - a.x, py - a.y), x: a.x, y: a.y, t: 0};
  let t = ((px - a.x) * dx + (py - a.y) * dy) / length2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return {distance: Math.hypot(px - x, py - y), x, y, t};
}

export function hitTest(scene, x, y, tolerance) {
  const source = requireScene(scene);
  if (!finite(x) || !finite(y) || !finite(tolerance) || tolerance < 0) invalid('hit');
  let best = null;
  for (const series of source.series) {
    for (const run of branchRuns(series.points)) {
      const pairs = run.indexes.length === 1
        ? [[run.indexes[0], run.indexes[0]]]
        : run.indexes.slice(1).map((end, offset) => [run.indexes[offset], end]);
      for (const [start, end] of pairs) {
        requirePoint(series.points[start], start);
        requirePoint(series.points[end], end);
        const hit = start === end
          ? {distance: Math.hypot(x - series.points[start].x, y - series.points[start].y), x: series.points[start].x, y: series.points[start].y, t: 0}
          : segmentPoint(x, y, series.points[start], series.points[end]);
        if (hit.distance <= tolerance && (best === null || hit.distance < best.distance)) {
          best = {
            seriesId: series.id,
            index: hit.t < 0.5 ? start : end,
            nextIndex: end,
            segmentStart: start,
            branch: run.id,
            distance: hit.distance,
            x: hit.x,
            y: hit.y,
            t: hit.t,
          };
        }
      }
    }
  }
  return best;
}

export function applyPlanJSON(sceneJson, operationsJson) {
  return JSON.stringify(applyPlan(JSON.parse(sceneJson), JSON.parse(operationsJson)));
}

const api = {applyPlan, createHistory, hitTest, applyPlanJSON, linkedSeriesIds, UPSTREAM_COMMIT, PROFILE};
if (typeof globalThis === 'object' && globalThis) globalThis.FalsifyChartShape = api;

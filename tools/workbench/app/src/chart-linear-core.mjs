function invalid(detail) { throw new Error(`chart_shape_invalid: ${detail}`); }
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function knotBounds(track, knotId, width, height) {
  const bounds = [0, 0, width, height];
  const source = track.sourceKnots?.find(k => k.id === knotId);
  if (!source) return bounds;
  for (const decoration of track.decorations || []) {
    if (decoration.knotId !== knotId) continue;
    const b = decoration.bbox;
    bounds[0] = Math.max(bounds[0], source.x - b[0]);
    bounds[1] = Math.max(bounds[1], source.y - b[1]);
    bounds[2] = Math.min(bounds[2], width + source.x - b[2]);
    bounds[3] = Math.min(bounds[3], height + source.y - b[3]);
  }
  return bounds;
}

function targetPoint(scene, track, operation) {
  const target = operation.target;
  if (!Array.isArray(target) || target.length !== 2 || !target.every(finite)) invalid('linear target');
  const b = knotBounds(track, operation.knotId, scene.width, scene.height);
  if (target[0] < b[0] || target[0] > b[2] || target[1] < b[1] || target[1] > b[3]) invalid('linear bounds');
  return target;
}

function moveKnot(track, index, target) {
  const knot = track.knots[index];
  if (knot.x === target[0] && knot.y === target[1]) return false;
  if (index > 0 && target[0] <= track.knots[index - 1].x) invalid('linear order');
  if (index + 1 < track.knots.length && target[0] >= track.knots[index + 1].x) invalid('linear order');
  knot.x = target[0]; knot.y = target[1];
  return true;
}

export function editLinearTrack(scene, operation) {
  const track = scene.linearTracks?.find(item => item.id === operation.seriesId);
  if (!track) invalid('linear track');
  const target = targetPoint(scene, track, operation);
  let index = track.knots.findIndex(knot => knot.id === operation.knotId);
  if (operation.knotId != null && index < 0) invalid('linear knot');
  if (index < 0) {
    if (target[0] <= track.knots[0].x || target[0] >= track.knots.at(-1).x) invalid('linear insertion');
    if (track.knots.some(knot => knot.x === target[0])) invalid('linear order');
    const id = `edit-${operation.id}`;
    if (track.knots.some(knot => knot.id === id)) invalid('linear knot');
    index = track.knots.findIndex(knot => knot.x > target[0]);
    track.knots.splice(index, 0, {id, x: target[0], y: target[1], origin: 'editing-control'});
  } else {
    if (!moveKnot(track, index, target)) return {id: operation.id, kind: operation.kind, seriesId: track.id, indexes: []};
  }
  return {id: operation.id, kind: operation.kind, seriesId: track.id, indexes: [index]};
}

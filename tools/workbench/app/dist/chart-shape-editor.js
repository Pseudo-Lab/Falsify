/* FalsifyChartShapeEditor. Pointer-event curve editor. No runtime network. Mount with FalsifyChartShapeEditor.create({host, scene, onChange, onCommit, onRequestExport, core}). */
var FalsifyChartShapeEditor = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/chart-shape-editor.mjs
  var chart_shape_editor_exports = {};
  __export(chart_shape_editor_exports, {
    EDITOR_CSS: () => EDITOR_CSS,
    create: () => create
  });

  // src/chart-linear-core.mjs
  function knotBounds(track, knotId, width, height) {
    const bounds = [0, 0, width, height];
    const source = track.sourceKnots?.find((k) => k.id === knotId);
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

  // src/chart-linear-editor.mjs
  var NS = "http://www.w3.org/2000/svg";
  var clone = (value) => JSON.parse(JSON.stringify(value));
  var png = (value) => `data:image/png;base64,${value}`;
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
    return { x: a.x + t * dx, y: a.y + t * dy };
  }
  function nearest(scene, p, tolerance) {
    const hits = [];
    for (const track of scene.linearTracks) {
      for (const knot of track.knots) {
        hits.push({ track, knot, x: knot.x, y: knot.y, distance: Math.hypot(p.x - knot.x, p.y - knot.y), point: true });
      }
      track.knots.slice(1).forEach((b, i) => {
        const at = projection(p, track.knots[i], b);
        hits.push({ track, knot: null, ...at, distance: Math.hypot(p.x - at.x, p.y - at.y), point: false });
      });
    }
    const close = hits.filter((hit) => hit.distance <= tolerance);
    close.sort((a, b) => Number(b.point) - Number(a.point) || a.distance - b.distance);
    return close[0] || null;
  }
  function decorationBox(decoration, track) {
    const source = track.sourceKnots.find((k) => k.id === decoration.knotId);
    const target = track.knots.find((k) => k.id === decoration.knotId);
    return decoration.bbox.map((v, i) => v + (i % 2 ? target.y - source.y : target.x - source.x));
  }
  function paintTrack(doc, svg, track) {
    const unchanged = JSON.stringify(track.knots) === JSON.stringify(track.sourceKnots);
    if (unchanged) {
      attrs(element(doc, "image", svg, "", true), { href: png(track.inkPng), width: "100%", height: "100%" });
      return;
    }
    attrs(element(doc, "polyline", svg, "", true), {
      points: track.knots.map((k) => `${k.x},${k.y}`).join(" "),
      fill: "none",
      stroke: track.color,
      "stroke-width": track.width,
      "stroke-linejoin": "miter"
    });
    for (const decoration of track.decorations) {
      const [x, y, right, bottom] = decorationBox(decoration, track);
      attrs(element(doc, "image", svg, "", true), { href: png(decoration.png), x, y, width: right - x, height: bottom - y });
    }
  }
  function createLinearEditor(options) {
    const { host } = options, doc = options.document || host.ownerDocument;
    const core = options.core || globalThis.FalsifyChartShape;
    let baseline = clone(options.scene), history = core.createHistory(baseline);
    let current = history.scene(), gesture = null, selected = null, comparing = false, sequence = 0;
    const listeners = [];
    const root = element(doc, "div", host);
    root.className = "falsify-shape-editor";
    root.tabIndex = 0;
    attrs(root, { role: "application", "aria-label": "꺾은선 그래프 편집" });
    const toolbar = element(doc, "div", root);
    toolbar.className = "falsify-shape-toolbar";
    const button = (label, fn) => {
      const b = element(doc, "button", toolbar, label);
      b.type = "button";
      b.className = "falsify-shape-button";
      b.addEventListener("click", fn);
      return b;
    };
    const undoButton = button("되돌리기", () => travel("undo"));
    const redoButton = button("다시 실행", () => travel("redo"));
    const compareButton = button("원본 비교", () => {
      cancel();
      comparing = !comparing;
      render();
    });
    const exportButton = button("내보내기", () => {
      if (!gesture) options.onRequestExport?.(snapshot());
    });
    exportButton.hidden = options.embedded === true;
    const status = element(doc, "p", toolbar);
    status.className = "falsify-shape-status";
    attrs(status, { role: "status", "aria-live": "polite" });
    const stage = element(doc, "div", root);
    stage.className = "falsify-shape-stage";
    const background = element(doc, "img", stage);
    background.className = "falsify-shape-background";
    background.alt = "";
    const svg = element(doc, "svg", stage, "", true);
    svg.setAttribute("class", "falsify-shape-svg");
    const detail = element(doc, "details", root);
    element(doc, "summary", detail, "선택한 점의 정밀 좌표");
    const fields = ["x", "y"].map((axis) => {
      const label = element(doc, "label", detail, `${axis} (px) `);
      const input = element(doc, "input", label);
      input.type = "number";
      input.step = "0.1";
      input.setAttribute("aria-label", `${axis} 좌표`);
      return input;
    });
    element(doc, "p", root, "점을 끌면 이웃 점까지 직선으로 이어집니다. 선 중간을 끌면 조절점이 생깁니다.");
    const listen = (node, event, fn) => {
      node.addEventListener(event, fn);
      listeners.push(() => node.removeEventListener(event, fn));
    };
    function snapshot() {
      return {
        scene: clone(current),
        operations: history.operations(),
        revision: (baseline.revision || 0) + history.index(),
        canUndo: history.canUndo(),
        canRedo: history.canRedo(),
        selection: clone(selected)
      };
    }
    function emit(commit = false) {
      const value = snapshot();
      options.onChange?.(value);
      if (commit) options.onCommit?.(value);
    }
    function render() {
      stage.style.aspectRatio = `${current.width} / ${current.height}`;
      attrs(svg, { viewBox: `0 0 ${current.width} ${current.height}`, width: "100%", height: "100%" });
      background.src = png(comparing ? baseline.originalPng : current.linearBasePng);
      svg.replaceChildren();
      if (!comparing) for (const track of current.linearTracks) paintTrack(doc, svg, track);
      const knot = selected && current.linearTracks.find((t) => t.id === selected.seriesId)?.knots.find((k) => k.id === selected.knotId);
      if (knot && !comparing) attrs(element(doc, "circle", svg, "", true), {
        cx: knot.x,
        cy: knot.y,
        r: 5,
        fill: "none",
        stroke: "#1d1a16",
        "stroke-width": 1,
        "pointer-events": "none"
      });
      fields.forEach((input, i) => {
        input.disabled = !knot;
        input.value = knot ? String(knot[i ? "y" : "x"]) : "";
      });
      undoButton.disabled = !history.canUndo();
      redoButton.disabled = !history.canRedo();
      compareButton.setAttribute("aria-pressed", String(comparing));
      status.textContent = gesture ? "드래그 중" : `변경 ${history.index()}회`;
    }
    function position(event) {
      const box = stage.getBoundingClientRect();
      return {
        x: (event.clientX - box.left) * current.width / box.width,
        y: (event.clientY - box.top) * current.height / box.height
      };
    }
    function operation(hit, y) {
      return {
        id: `linear-${++sequence}`,
        kind: "linear-edit",
        seriesId: hit.track.id,
        knotId: hit.knot?.id || null,
        target: [hit.x, y]
      };
    }
    function down(event) {
      if (comparing || gesture || event.button !== 0) return;
      const p = position(event), box = stage.getBoundingClientRect();
      const hit = nearest(current, p, current.width / box.width * 12);
      if (!hit) return;
      selected = hit.knot ? { seriesId: hit.track.id, knotId: hit.knot.id } : null;
      gesture = { id: event.pointerId, hit, start: p, operation: operation(hit, hit.y), moved: false };
      stage.setPointerCapture?.(event.pointerId);
      root.focus();
      event.preventDefault();
      options.onGestureChange?.(true);
      render();
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
      const saved = gesture;
      gesture = null;
      if (commit && saved.moved) {
        current = history.apply([saved.operation]);
        selected = { seriesId: saved.operation.seriesId, knotId: saved.operation.knotId || `edit-${saved.operation.id}` };
      } else current = history.scene();
      if (stage.hasPointerCapture?.(saved.id)) stage.releasePointerCapture(saved.id);
      render();
      emit(commit && saved.moved);
      options.onGestureChange?.(false);
    }
    function cancel() {
      if (gesture) finish({ pointerId: gesture.id }, false);
    }
    function travel(direction) {
      cancel();
      current = history[direction]();
      selected = null;
      comparing = false;
      render();
      emit(true);
    }
    function precision() {
      if (!selected) return;
      const op = { id: `linear-${++sequence}`, kind: "linear-edit", ...selected, target: fields.map((f) => Number(f.value)) };
      if (fields.some((f) => !f.value.trim())) {
        render();
        return;
      }
      const knot = current.linearTracks.find((t) => t.id === selected.seriesId).knots.find((k) => k.id === selected.knotId);
      if (knot.x === op.target[0] && knot.y === op.target[1]) return;
      try {
        current = history.apply([op]);
      } catch (error) {
        render();
        status.textContent = "선택 영역 안에서 이웃 점 사이의 좌표를 입력하세요.";
        return;
      }
      render();
      emit(true);
    }
    function key(event) {
      if (event.target?.tagName === "INPUT") return;
      if (event.key === "Escape") cancel();
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        travel(event.shiftKey ? "redo" : "undo");
      }
      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        travel("redo");
      }
    }
    listen(stage, "pointerdown", down);
    listen(stage, "pointermove", move);
    listen(stage, "pointerup", (event) => {
      move(event);
      finish(event, true);
    });
    listen(stage, "pointercancel", (event) => finish(event, false));
    listen(stage, "lostpointercapture", (event) => finish(event, false));
    listen(root, "keydown", key);
    fields.forEach((input) => listen(input, "change", precision));
    host.replaceChildren(root);
    render();
    return {
      getState: snapshot,
      undo: () => travel("undo"),
      redo: () => travel("redo"),
      setScene(scene) {
        cancel();
        baseline = clone(scene);
        history = core.createHistory(baseline);
        current = history.scene();
        selected = null;
        comparing = false;
        render();
        emit();
      },
      destroy() {
        cancel();
        listeners.forEach((off) => off());
        root.remove();
      }
    };
  }

  // src/chart-shape-editor.mjs
  var BRANCH_JUMP_FACTOR = 4;
  var SELECT_SPAN_FACTOR = 1.5;
  var DEFORM_RADIUS_FACTOR = 2;
  var MIN_DEFORM_RADIUS = 16;
  var MAX_DEFORM_RADIUS = 160;
  var MIN_SELECT_BUDGET = 12;
  var NOOP_DISTANCE = 0.5;
  var SCREEN_HIT_PX = 12;
  var SCREEN_HANDLE_PX = 8;
  var MIN_SCALE = 0.05;
  var MAX_SCALE = 20;
  var KEY_STEP = 1;
  var KEY_STEP_LARGE = 10;
  var KEY_WIDTH_FACTOR = 1.1;
  var SVG_NS = "http://www.w3.org/2000/svg";
  function clone2(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
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
    return { start, end, spacing };
  }
  function selectionRange(points, index) {
    if (!points.length) return [0, 0];
    const safe = Math.max(0, Math.min(points.length - 1, index));
    const { start, end, spacing } = branchBounds(points, safe);
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
    const { spacing } = branchBounds(points, Math.max(0, index));
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
    return !!value && typeof value.applyPlan === "function" && typeof value.hitTest === "function";
  }
  function resolveCore(core) {
    if (arguments.length > 0 && core != null) {
      if (isCore(core)) return core;
      throw new Error("FalsifyChartShapeEditor.create requires FalsifyChartShape");
    }
    if (isCore(globalThis.FalsifyChartShape)) return globalThis.FalsifyChartShape;
    throw new Error("FalsifyChartShapeEditor.create requires FalsifyChartShape");
  }
  function usableHistory(history) {
    return !!history && typeof history.apply === "function" && typeof history.preview === "function" && typeof history.undo === "function" && typeof history.redo === "function" && typeof history.scene === "function" && typeof history.operations === "function" && typeof history.index === "function" && typeof history.canUndo === "function" && typeof history.canRedo === "function";
  }
  function planScene(core, scene, operations) {
    const result = core.applyPlan(clone2(scene), operations);
    const next = result?.scene && Array.isArray(result.scene.series) ? result.scene : Array.isArray(result?.series) ? result : null;
    if (!next) throw new Error("FalsifyChartShape.applyPlan must return {scene}");
    return next;
  }
  function internalHistory(core, scene) {
    const baseline = clone2(scene);
    const groups = [];
    let cursor = 0;
    const flat = () => groups.slice(0, cursor).flat();
    const at = (ops) => planScene(core, baseline, ops);
    return {
      baseline,
      index: () => cursor,
      operations: () => flat().map((op) => clone2(op)),
      scene: () => cursor === 0 ? clone2(baseline) : at(flat()),
      canUndo: () => cursor > 0,
      canRedo: () => cursor < groups.length,
      preview(operations) {
        const list = Array.isArray(operations) ? operations : [operations];
        return at(flat().concat(list));
      },
      apply(operations) {
        const list = (Array.isArray(operations) ? operations : [operations]).map((op) => clone2(op));
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
      }
    };
  }
  function bindHistory(core, scene) {
    if (typeof core.createHistory === "function") {
      const history = core.createHistory(clone2(scene));
      if (usableHistory(history)) return history;
    }
    return internalHistory(core, scene);
  }
  function sceneSize(scene) {
    const width = Number(scene.width);
    const height = Number(scene.height);
    if (width > 0 && height > 0) return { width, height };
    let maxX = 1;
    let maxY = 1;
    for (const series of scene.series || []) {
      for (const point of series?.points || []) {
        if (!isPoint(point)) continue;
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    return { width: maxX, height: maxY };
  }
  function pngUrl(value) {
    if (!value) return "";
    const text = String(value);
    if (text.startsWith("data:") || text.startsWith("blob:")) return text;
    return `data:image/png;base64,${text}`;
  }
  function presentation(series) {
    const style = series.style || {};
    const attrs3 = {
      stroke: series.color || "#243126",
      "stroke-width": String(style.width ?? 1.5),
      fill: "none",
      "stroke-linecap": style.lineCap || "round",
      "stroke-linejoin": style.lineJoin || "round",
      "stroke-opacity": String(style.opacity ?? 1)
    };
    if (Array.isArray(style.dashes) && style.dashes.length) attrs3["stroke-dasharray"] = style.dashes.join(" ");
    else if (typeof style.dashes === "string" && style.dashes) attrs3["stroke-dasharray"] = style.dashes;
    return attrs3;
  }
  function pointsAttr(points) {
    const parts = [];
    for (const point of points) {
      if (isPoint(point)) parts.push(`${point.x},${point.y}`);
    }
    return parts.join(" ");
  }
  function formatNumber(value) {
    if (!finite(value)) return "";
    return String(Math.round(value * 1e3) / 1e3);
  }
  function readNumber(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  function isNoOp(op) {
    if (!op) return true;
    if (op.kind === "deform" || op.kind === "move") return Math.hypot(op.dx || 0, op.dy || 0) < NOOP_DISTANCE;
    if (op.kind === "resize") return Math.abs((op.scaleX ?? 1) - 1) < 1e-3 && Math.abs((op.scaleY ?? 1) - 1) < 1e-3;
    if (op.kind === "set-values") return !op.points?.length;
    return false;
  }
  function clampScale(value) {
    if (!finite(value) || value <= 0) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }
  function clampPosition(value, low, high) {
    if (high < low) return (low + high) / 2;
    return Math.min(high, Math.max(low, value));
  }
  function handlePositions(left, center, right, size, scale) {
    const inset = 12 * scale;
    const gap = 24 * scale;
    const anchor = {
      x: clampPosition(center.x, inset + gap, size.width - inset - gap),
      y: clampPosition(center.y, inset, size.height - inset)
    };
    return [
      { x: clampPosition(left.x, inset, anchor.x - gap), y: clampPosition(left.y, inset, size.height - inset) },
      { x: clampPosition(right.x, anchor.x + gap, size.width - inset), y: clampPosition(right.y, inset, size.height - inset) },
      anchor
    ];
  }
  function seriesById(scene, seriesId) {
    return (scene?.series || []).find((item) => item && item.id === seriesId) || null;
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
    if (className) node.setAttribute("class", className);
    return node;
  }
  function s(doc, tag, className) {
    const node = doc.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    return node;
  }
  function attrs2(node, values) {
    for (const [key, value] of Object.entries(values)) node.setAttribute(key, value);
    return node;
  }
  function handleName(target) {
    for (let node = target; node; node = node.parentElement || null) {
      const name = node.getAttribute?.("data-handle");
      if (name) return name;
    }
    return "";
  }
  function typingTarget(target) {
    const tag = target?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  }
  function normalizeHit(hit) {
    if (!hit || typeof hit !== "object") return null;
    const seriesId = hit.seriesId ?? hit.series ?? hit.id;
    const index = hit.index ?? hit.pointIndex ?? hit.i;
    if (typeof seriesId !== "string" && typeof seriesId !== "number" || !Number.isInteger(index) || index < 0) return null;
    return { seriesId, index, distance: finite(hit.distance) ? hit.distance : 0 };
  }
  function validateEditorInputs(host, doc, options) {
    if (!host || typeof host.append !== "function") throw new Error("FalsifyChartShapeEditor.create requires a host element");
    if (!doc?.createElement || !doc.createElementNS) throw new Error("FalsifyChartShapeEditor.create requires a document");
    if (!options.scene || !Array.isArray(options.scene.series)) throw new Error("FalsifyChartShapeEditor.create requires a scene with series");
  }
  function validPrecisionValue(seriesId, index, axis, value) {
    return !(seriesId == null || !Number.isInteger(index) || axis !== "x" && axis !== "y" || value == null);
  }
  function create(options = {}) {
    const host = options.host;
    const doc = options.document || host?.ownerDocument || globalThis.document;
    validateEditorInputs(host, doc, options);
    if (options.scene.linearTracks?.length && options.mode !== "smooth") return createLinearEditor({ ...options, document: doc });
    const core = resolveCore(options.core);
    const onChange = typeof options.onChange === "function" ? options.onChange : null;
    const onCommit = typeof options.onCommit === "function" ? options.onCommit : null;
    const onGestureChange = typeof options.onGestureChange === "function" ? options.onGestureChange : null;
    const onRequestExport = typeof options.onRequestExport === "function" ? options.onRequestExport : null;
    const listeners = [];
    let opSeq = 0;
    let history = bindHistory(core, options.scene);
    const state = {
      destroyed: false,
      baseRevision: finite(options.scene.revision) ? options.scene.revision : 0,
      selection: null,
      gesture: null,
      compare: false,
      backgroundPng: options.scene.backgroundPng || "",
      originalPng: options.scene.originalPng || "",
      size: sceneSize(options.scene)
    };
    const root = h(doc, "div", "falsify-shape-editor");
    root.tabIndex = 0;
    attrs2(root, {
      tabindex: "0",
      role: "application",
      "aria-label": "곡선 모양 편집"
    });
    const toolbar = h(doc, "div", "falsify-shape-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "곡선 편집 도구");
    const undoButton = h(doc, "button", "falsify-shape-button");
    const redoButton = h(doc, "button", "falsify-shape-button");
    const compareButton = h(doc, "button", "falsify-shape-button");
    const exportButton = h(doc, "button", "falsify-shape-button");
    for (const button of [undoButton, redoButton, compareButton, exportButton]) button.type = "button";
    undoButton.textContent = "되돌리기";
    redoButton.textContent = "다시 실행";
    compareButton.textContent = "원본 비교";
    exportButton.textContent = "내보내기";
    exportButton.hidden = options.embedded === true;
    undoButton.setAttribute("aria-label", "되돌리기");
    redoButton.setAttribute("aria-label", "다시 실행");
    compareButton.setAttribute("aria-label", "원본 비교");
    exportButton.setAttribute("aria-label", "내보내기");
    compareButton.setAttribute("aria-pressed", "false");
    const status = h(doc, "p", "falsify-shape-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    toolbar.append(undoButton, redoButton, compareButton, exportButton, status);
    const stage = h(doc, "div", "falsify-shape-stage");
    const background = h(doc, "img", "falsify-shape-background");
    const original = h(doc, "img", "falsify-shape-original");
    background.alt = "";
    original.alt = "";
    background.setAttribute("aria-hidden", "true");
    original.setAttribute("aria-hidden", "true");
    background.style.pointerEvents = "none";
    original.style.pointerEvents = "none";
    const svg = s(doc, "svg", "falsify-shape-svg");
    svg.setAttribute("role", "presentation");
    svg.setAttribute("focusable", "false");
    stage.style.touchAction = "none";
    stage.append(background, original, svg);
    const precision = h(doc, "details", "falsify-shape-precision");
    const summary = h(doc, "summary");
    summary.textContent = "선택한 점의 정밀 좌표 (px)";
    const algorithm = h(doc, "p", "falsify-shape-algorithm");
    algorithm.textContent = "곡선을 끌어 모양을 바꾸고, 양옆 손잡이는 폭, 가운데 손잡이는 위치와 높이입니다.";
    const keys = h(doc, "p", "falsify-shape-keys");
    keys.textContent = "키보드: 화살표는 위치, Shift는 10px, Alt와 좌우는 폭, Ctrl+Z는 되돌리기, Ctrl+Y는 다시 실행, Esc는 드래그 취소입니다.";
    const table = h(doc, "table", "falsify-shape-table");
    const caption = h(doc, "caption");
    caption.textContent = "원본 이미지 좌표 · px";
    const thead = h(doc, "thead");
    const headRow = h(doc, "tr");
    for (const label of ["계열", "번호", "x", "y"]) {
      const cell = h(doc, "th");
      cell.textContent = label;
      headRow.append(cell);
    }
    thead.append(headRow);
    const precisionBody = h(doc, "tbody");
    table.append(caption, thead, precisionBody);
    const limitNote = h(doc, "p", "falsify-shape-limit");
    limitNote.hidden = true;
    precision.append(summary, algorithm, keys, table, limitNote);
    root.append(toolbar, stage, precision);
    if (typeof host.replaceChildren === "function") host.replaceChildren(root);
    else host.append(root);
    function assertLive() {
      if (state.destroyed) throw new Error("FalsifyChartShapeEditor instance was destroyed");
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
      const copy = clone2(scene);
      copy.revision = revision();
      const operations = history.operations().concat(extra).map((op) => clone2(op));
      return { scene: copy, operations, revision: copy.revision };
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
        selection: state.selection ? { seriesId: state.selection.seriesId, range: [...state.selection.range] } : null
      };
    }
    function emitChange(body) {
      onChange?.({ scene: body.scene, operations: body.operations, revision: body.revision });
    }
    function emitCommit(body) {
      onCommit?.({ scene: body.scene, operations: body.operations, revision: body.revision });
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
      if (state.compare) return "원본과 비교하는 중입니다.";
      const gesture = state.gesture;
      if (gesture?.kind === "deform") {
        if (gesture.op.dy < -NOOP_DISTANCE) return "봉우리를 올리는 중입니다.";
        if (gesture.op.dy > NOOP_DISTANCE) return "골을 만드는 중입니다.";
        return "곡선을 위아래로 미는 중입니다.";
      }
      if (gesture?.kind === "resize") return "폭을 조절하는 중입니다.";
      if (gesture?.kind === "move") return "위치와 높이를 옮기는 중입니다.";
      if (state.selection) return "양옆 손잡이는 폭, 가운데 손잡이는 위치와 높이입니다.";
      return "곡선을 누르면 그 부분을 위아래로 변형합니다.";
    }
    function screenScale() {
      const rect = stage.getBoundingClientRect?.() || { width: state.size.width, height: state.size.height };
      const width = rect.width > 0 ? rect.width : state.size.width;
      return state.size.width / width;
    }
    function eventPoint(event) {
      const rect = stage.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
      const x = (event.clientX - rect.left) * (state.size.width / rect.width);
      const y = (event.clientY - rect.top) * (state.size.height / rect.height);
      if (!finite(x) || !finite(y)) return null;
      return { x, y };
    }
    function focusRoot() {
      if (typeof root.focus !== "function") return;
      try {
        root.focus({ preventScroll: true });
      } catch {
        root.focus();
      }
    }
    function release(pointerId) {
      if (pointerId == null || typeof stage.releasePointerCapture !== "function") return;
      if (typeof stage.hasPointerCapture === "function" && !stage.hasPointerCapture(pointerId)) return;
      try {
        stage.releasePointerCapture(pointerId);
      } catch {
      }
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
      const selection = state.selection;
      if (selection && focusInside(precisionBody)) return;
      precision.hidden = !selection;
      const series = selection && seriesById(scene, selection.seriesId);
      const point = series?.points?.[selection.index];
      const rows = isPoint(point) ? [{ series, index: selection.index, point }] : [];
      precisionBody.replaceChildren(...rows.map((row) => {
        const tr = h(doc, "tr");
        const name = h(doc, "td");
        name.textContent = row.series.name || String(row.series.id);
        const number = h(doc, "td");
        number.textContent = String(row.index);
        const xCell = h(doc, "td");
        const yCell = h(doc, "td");
        const xInput = h(doc, "input");
        const yInput = h(doc, "input");
        for (const [input, axis, value] of [[xInput, "x", row.point.x], [yInput, "y", row.point.y]]) {
          input.type = "text";
          input.value = formatNumber(value);
          input.inputMode = "decimal";
          input.autocomplete = "off";
          attrs2(input, {
            "data-series-id": String(row.series.id),
            "data-index": String(row.index),
            "data-axis": axis,
            "aria-label": `${row.series.name || row.series.id} ${row.index} ${axis}`,
            inputmode: "decimal",
            autocomplete: "off"
          });
        }
        xCell.append(xInput);
        yCell.append(yInput);
        tr.append(name, number, xCell, yCell);
        return tr;
      }));
      limitNote.hidden = true;
    }
    function renderHandles(scene) {
      if (!state.selection || state.compare) return;
      const series = seriesById(scene, state.selection.seriesId);
      const points = rangePoints(series?.points || [], state.selection.range);
      if (points.length < 1) return;
      const left = extreme(points, (point, chosen) => point.x < chosen.x);
      const right = extreme(points, (point, chosen) => point.x > chosen.x);
      const center = series.points[state.selection.index];
      if (!isPoint(center)) return;
      const scale = screenScale();
      const radius = formatNumber(SCREEN_HANDLE_PX * scale);
      const [leftPosition, rightPosition, centerPosition] = handlePositions(left, center, right, state.size, scale);
      const handles = [
        ["width-start", "왼쪽 폭", "falsify-shape-handle falsify-shape-handle-width", left, leftPosition],
        ["width-end", "오른쪽 폭", "falsify-shape-handle falsify-shape-handle-width", right, rightPosition],
        ["move", "위치와 높이", "falsify-shape-handle falsify-shape-handle-center", center, centerPosition]
      ];
      for (const [name, label, className, actual, point] of handles) {
        if (actual.x !== point.x || actual.y !== point.y) svg.append(attrs2(s(doc, "line", "falsify-shape-handle-guide"), {
          x1: formatNumber(actual.x),
          y1: formatNumber(actual.y),
          x2: formatNumber(point.x),
          y2: formatNumber(point.y)
        }));
        svg.append(attrs2(s(doc, "circle", className), {
          "data-handle": name,
          cx: formatNumber(point.x),
          cy: formatNumber(point.y),
          r: radius,
          "aria-label": label,
          role: "img"
        }));
        svg.append(attrs2(s(doc, "circle", "falsify-shape-handle-hit"), {
          "data-handle": name,
          cx: formatNumber(point.x),
          cy: formatNumber(point.y),
          r: formatNumber(12 * scale),
          fill: "transparent",
          "pointer-events": "all",
          "aria-hidden": "true"
        }));
      }
    }
    function renderRadius() {
      if (state.gesture?.kind !== "deform") return;
      const [cx, cy] = state.gesture.op.center;
      svg.append(attrs2(s(doc, "circle", "falsify-shape-radius"), {
        cx: formatNumber(cx),
        cy: formatNumber(cy),
        r: formatNumber(state.gesture.op.radius),
        "pointer-events": "none"
      }));
    }
    function renderSvg(scene) {
      svg.replaceChildren();
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      attrs2(svg, {
        viewBox: `0 0 ${state.size.width} ${state.size.height}`,
        preserveAspectRatio: "none"
      });
      const selectedIds = new Set(state.selection && typeof core.linkedSeriesIds === "function" ? core.linkedSeriesIds(scene, state.selection.seriesId) : [state.selection?.seriesId]);
      for (const series of scene.series || []) {
        const points = series?.points || [];
        if (!points.some(isPoint)) continue;
        const look = presentation(series);
        const paintedPoints = series.style?.closed && points.length > 1 ? [...points, points[0]] : points;
        const haloWidth = String((Number(look["stroke-width"]) || 1.5) + 4 * screenScale());
        svg.append(attrs2(s(doc, "polyline", selectedIds.has(series.id) ? "falsify-shape-halo is-selected" : "falsify-shape-halo"), {
          ...look,
          points: pointsAttr(paintedPoints),
          "stroke-width": haloWidth,
          "stroke-opacity": "0",
          "pointer-events": "none"
        }));
        svg.append(attrs2(s(doc, "polyline", "falsify-shape-curve"), {
          ...look,
          points: pointsAttr(paintedPoints),
          "data-series-id": String(series.id),
          "pointer-events": "none"
        }));
        svg.append(attrs2(s(doc, "polyline", "falsify-shape-hit"), {
          points: pointsAttr(paintedPoints),
          fill: "none",
          stroke: "transparent",
          "stroke-width": "16",
          "data-series-id": String(series.id)
        }));
      }
      renderConnections(scene);
      if (state.selection) {
        const series = seriesById(scene, state.selection.seriesId);
        const selectedPoints = rangePoints(series?.points || [], state.selection.range);
        svg.append(attrs2(s(doc, "polyline", "falsify-shape-range"), {
          points: pointsAttr(selectedPoints),
          fill: "none",
          stroke: "#1d1a16",
          "stroke-width": "5",
          "stroke-opacity": "0.35",
          "pointer-events": "none",
          "vector-effect": "non-scaling-stroke"
        }));
      }
      renderRadius();
      renderHandles(scene);
    }
    function renderConnections(scene) {
      for (const [left, right] of scene.curveLinks || []) {
        const series = seriesById(scene, left[0]);
        const a = series?.points[left[1]];
        const b = seriesById(scene, right[0])?.points[right[1]];
        if (!isPoint(a) || !isPoint(b) || distance(a, b) < 1e-4) continue;
        const look = presentation(series);
        svg.append(attrs2(s(doc, "polyline", "falsify-shape-curve falsify-shape-connection"), {
          ...look,
          points: pointsAttr([a, b]),
          "pointer-events": "none"
        }));
      }
    }
    function render(scene = displayedScene()) {
      stage.style.width = "100%";
      stage.style.maxWidth = "100%";
      stage.style.height = "auto";
      stage.style.aspectRatio = `${state.size.width} / ${state.size.height}`;
      const backgroundSrc = pngUrl(state.backgroundPng);
      const originalSrc = pngUrl(state.originalPng);
      background.src = backgroundSrc;
      background.setAttribute("src", backgroundSrc);
      background.hidden = !backgroundSrc;
      original.src = originalSrc;
      original.setAttribute("src", originalSrc);
      original.hidden = !state.compare || !originalSrc;
      svg.style.visibility = state.compare ? "hidden" : "visible";
      stage.setAttribute("class", state.compare ? "falsify-shape-stage is-comparing" : "falsify-shape-stage");
      compareButton.setAttribute("aria-pressed", state.compare ? "true" : "false");
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
      state.backgroundPng = scene.backgroundPng || "";
      state.originalPng = scene.originalPng || "";
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
        onGestureChange?.(false);
        return;
      }
      render();
      if (gesture.previewed) emitChange(snapshot());
      onGestureChange?.(false);
    }
    function updateGesture(point) {
      const gesture = state.gesture;
      if (!gesture || !point) return;
      if (gesture.kind === "deform" || gesture.kind === "move") {
        gesture.op.dx = point.x - gesture.origin.x;
        gesture.op.dy = point.y - gesture.origin.y;
        return;
      }
      if (gesture.kind === "resize") {
        const denominator = gesture.handle.x - gesture.anchor[0];
        const scaleX = Math.abs(denominator) < 1e-6 ? 1 : (gesture.handle.x + point.x - gesture.origin.x - gesture.anchor[0]) / denominator;
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
      if (frame && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frame);
      }
    }
    function schedulePreview() {
      if (state.destroyed || previewScheduled) return;
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf !== "function") {
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
      onGestureChange?.(true);
      if (event.pointerId != null && typeof stage.setPointerCapture === "function") {
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
        }
      }
      updateGesture(eventPoint(event) || gesture.origin);
      publishPreview();
    }
    function selectHit(hit, scene) {
      const series = seriesById(scene, hit.seriesId);
      const points = series?.points || [];
      if (!points.length || hit.index >= points.length) return null;
      const range = selectionRange(points, hit.index);
      state.selection = { seriesId: hit.seriesId, range, index: hit.index };
      return series;
    }
    function selectedDeform(scene, dx, dy) {
      const selection = state.selection;
      const points = seriesById(scene, selection.seriesId)?.points || [];
      const center = points[selection.index];
      if (!isPoint(center)) return null;
      const selected = rangePoints(points, selection.range);
      const span = selected.reduce((largest, point) => Math.max(largest, distance(center, point)), 0);
      const radius = span > 0 ? Math.min(MAX_DEFORM_RADIUS, Math.max(MIN_DEFORM_RADIUS, span * 2)) : deformRadius(points, selection.index);
      return {
        id: nextId("deform"),
        kind: "deform",
        seriesId: selection.seriesId,
        center: [center.x, center.y],
        radius,
        dx,
        dy
      };
    }
    function startHandleGesture(event, name, scene, point) {
      const series = seriesById(scene, state.selection.seriesId);
      const spanned = rangePoints(series?.points || [], state.selection.range);
      if (!spanned.length) return;
      const left = extreme(spanned, (item, chosen) => item.x < chosen.x);
      const right = extreme(spanned, (item, chosen) => item.x > chosen.x);
      if (name === "move") {
        const op = selectedDeform(scene, 0, 0);
        if (!op) return;
        beginGesture(event, {
          kind: "deform",
          pointerId: event.pointerId,
          settled: false,
          previewed: false,
          origin: point,
          op,
          operation() {
            return this.op;
          }
        });
        return;
      }
      const handle = name === "width-start" ? left : right;
      const anchorPoint = name === "width-start" ? right : left;
      beginGesture(event, {
        kind: "resize",
        pointerId: event.pointerId,
        settled: false,
        previewed: false,
        origin: point,
        handle: { x: handle.x, y: handle.y },
        anchor: [anchorPoint.x, anchorPoint.y],
        op: {
          id: nextId("resize"),
          kind: "resize",
          seriesId: state.selection.seriesId,
          range: [...state.selection.range],
          anchor: [anchorPoint.x, anchorPoint.y],
          scaleX: 1,
          scaleY: 1
        },
        operation() {
          return this.op;
        }
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
        kind: "deform",
        pointerId: event.pointerId,
        settled: false,
        previewed: false,
        origin: point,
        op: {
          id: nextId("deform"),
          kind: "deform",
          seriesId: hit.seriesId,
          center: [point.x, point.y],
          radius,
          dx: 0,
          dy: 0
        },
        operation() {
          return this.op;
        }
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
      commitFinished(selectedDeform(history.scene(), dx, dy));
    }
    function scaleWidth(factor) {
      if (!state.selection || state.compare || state.gesture) return;
      const scene = history.scene();
      const series = seriesById(scene, state.selection.seriesId);
      const spanned = rangePoints(series?.points || [], state.selection.range);
      if (!spanned.length) return;
      const anchor = spanned.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
      anchor.x /= spanned.length;
      anchor.y /= spanned.length;
      commitFinished({
        id: nextId("resize"),
        kind: "resize",
        seriesId: state.selection.seriesId,
        range: [...state.selection.range],
        anchor: [anchor.x, anchor.y],
        scaleX: clampScale(factor),
        scaleY: 1
      });
    }
    function undo() {
      assertLive();
      if (state.gesture || !history.canUndo()) return;
      history.undo();
      const body = snapshot();
      render();
      emitChange(body);
      setStatus("되돌렸습니다.");
    }
    function redo() {
      assertLive();
      if (state.gesture || !history.canRedo()) return;
      history.redo();
      const body = snapshot();
      render();
      emitChange(body);
      setStatus("다시 실행했습니다.");
    }
    function handleMovementKey(event, key) {
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      if (key === "ArrowUp") nudge(0, -step);
      else if (key === "ArrowDown") nudge(0, step);
      else if (key === "ArrowLeft") {
        if (event.altKey) scaleWidth(1 / KEY_WIDTH_FACTOR);
        else nudge(-step, 0);
      } else if (key === "ArrowRight") {
        if (event.altKey) scaleWidth(KEY_WIDTH_FACTOR);
        else nudge(step, 0);
      } else return false;
      return true;
    }
    function handleControlKey(event, key, mod) {
      if (mod && key.toLowerCase() === "z") {
        event.preventDefault?.();
        if (event.shiftKey) redo();
        else undo();
        return true;
      }
      if (mod && key.toLowerCase() === "y") {
        event.preventDefault?.();
        redo();
        return true;
      }
      if (key === "Escape") {
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
      if (event.key === "Escape" && typingTarget(event.target)) {
        event.preventDefault?.();
        event.target.blur?.();
        return;
      }
      if (typingTarget(event.target)) return;
      const key = String(event.key || "");
      const mod = !!(event.ctrlKey || event.metaKey);
      if (handleControlKey(event, key, mod)) return;
      if (!state.selection || state.compare || state.gesture) return;
      if (!handleMovementKey(event, key)) return;
      event.preventDefault?.();
    }
    function onPrecisionChange(event) {
      const input = event.target;
      if (!input || input.tagName !== "INPUT" || state.gesture || state.compare) return;
      const seriesId = input.getAttribute("data-series-id");
      const index = Number(input.getAttribute("data-index"));
      const axis = input.getAttribute("data-axis");
      const value = readNumber(input.value);
      if (!validPrecisionValue(seriesId, index, axis, value)) return;
      const scene = history.scene();
      const series = (scene.series || []).find((item) => String(item.id) === seriesId);
      const point = series?.points?.[index];
      if (!isPoint(point)) return;
      const x = axis === "x" ? value : point.x;
      const y = axis === "y" ? value : point.y;
      if (x === point.x && y === point.y) return;
      const numericId = series.id;
      commitFinished({
        id: nextId("set-values"),
        kind: "set-values",
        seriesId: numericId,
        points: [{ index, x, y }]
      });
    }
    function toggleCompare() {
      if (state.gesture) endGesture(false);
      if (!state.originalPng) {
        state.compare = false;
        render();
        setStatus("비교할 원본 이미지가 없습니다.");
        return;
      }
      state.compare = !state.compare;
      render();
    }
    function requestExport() {
      if (state.destroyed || state.gesture) return;
      const body = snapshot();
      onRequestExport?.({ scene: body.scene, operations: body.operations, revision: body.revision });
    }
    listen(stage, "pointerdown", onPointerDown);
    listen(stage, "pointermove", onPointerMove);
    listen(stage, "pointerup", onPointerUp);
    listen(stage, "pointercancel", onPointerCancel);
    listen(stage, "lostpointercapture", onLostPointerCapture);
    listen(root, "keydown", onKeyDown);
    listen(undoButton, "click", () => undo());
    listen(redoButton, "click", () => redo());
    listen(compareButton, "click", () => toggleCompare());
    listen(exportButton, "click", () => requestExport());
    listen(precisionBody, "change", onPrecisionChange);
    render();
    return {
      setScene(scene) {
        assertLive();
        if (!scene || !Array.isArray(scene.series)) throw new Error("FalsifyChartShapeEditor.setScene requires a scene with series");
        if (state.gesture) endGesture(false);
        dropPreviewFrame();
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
        if (state.gesture) endGesture(false);
        dropPreviewFrame();
        state.destroyed = true;
        for (const off of listeners) off();
        listeners.length = 0;
        if (typeof root.remove === "function") root.remove();
        if (typeof host.replaceChildren === "function") host.replaceChildren();
      }
    };
  }
  var EDITOR_CSS = `/* Falsify chart shape editor. No remote assets. */
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
.falsify-shape-halo.is-selected { stroke-opacity: 0.22; }
.falsify-shape-hit { cursor: grab; }
.falsify-shape-hit:hover { stroke: rgba(29, 26, 22, 0.18); }
.falsify-shape-radius {
  fill: rgba(29, 26, 22, 0.08);
  stroke: rgba(29, 26, 22, 0.55);
  stroke-width: 1;
}
.falsify-shape-handle-guide { stroke: #777064; stroke-width: 1px; vector-effect: non-scaling-stroke; pointer-events: none; }
.falsify-shape-handle-hit { cursor: pointer; }
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
.falsify-shape-precision[hidden], .falsify-shape-button[hidden] { display: none; }
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
  return __toCommonJS(chart_shape_editor_exports);
})();

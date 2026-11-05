/* FalsifyChartMarkEditor. Pointer-event bar and scatter editor. No runtime network. Mount with FalsifyChartMarkEditor.create({host, scene, core, onChange, onCommit, onRequestExport}). */
var FalsifyChartMarkEditor = (() => {
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

  // src/chart-mark-editor.mjs
  var chart_mark_editor_exports = {};
  __export(chart_mark_editor_exports, {
    EDITOR_CSS: () => EDITOR_CSS,
    create: () => create
  });
  var NOOP_DISTANCE = 0.01;
  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
      const copy = {};
      for (const key of Object.keys(value)) copy[key] = clone(value[key]);
      return copy;
    }
    return value;
  }
  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }
  function isCore(value) {
    return !!value && typeof value.applyPlan === "function";
  }
  function resolveCore(core) {
    if (core != null) {
      if (isCore(core)) return core;
      throw new Error("FalsifyChartMarkEditor.create requires FalsifyChartShape");
    }
    if (isCore(globalThis.FalsifyChartShape)) return globalThis.FalsifyChartShape;
    throw new Error("FalsifyChartMarkEditor.create requires FalsifyChartShape");
  }
  function usableHistory(history) {
    return !!history && typeof history.apply === "function" && typeof history.preview === "function" && typeof history.undo === "function" && typeof history.redo === "function" && typeof history.scene === "function" && typeof history.operations === "function" && typeof history.index === "function" && typeof history.canUndo === "function" && typeof history.canRedo === "function";
  }
  function planScene(core, scene, operations) {
    const result = core.applyPlan(clone(scene), operations);
    const next = result?.scene && Array.isArray(result.scene.series) ? result.scene : null;
    if (!next) throw new Error("FalsifyChartShape.applyPlan must return {scene}");
    return next;
  }
  function internalHistory(core, scene) {
    const baseline = clone(scene);
    const groups = [];
    let cursor = 0;
    const flat = () => groups.slice(0, cursor).flat();
    const at = (operations) => planScene(core, baseline, operations);
    return {
      index: () => cursor,
      operations: () => flat().map((item) => clone(item)),
      scene: () => cursor === 0 ? clone(baseline) : at(flat()),
      canUndo: () => cursor > 0,
      canRedo: () => cursor < groups.length,
      preview(operations) {
        const list = Array.isArray(operations) ? operations : [operations];
        return at(flat().concat(list));
      },
      apply(operations) {
        const list = (Array.isArray(operations) ? operations : [operations]).map((item) => clone(item));
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
      const history = core.createHistory(clone(scene));
      if (usableHistory(history)) return history;
    }
    return internalHistory(core, scene);
  }
  function sceneSize(scene) {
    const width = Number(scene.width);
    const height = Number(scene.height);
    if (width > 0 && height > 0) return { width, height };
    return { width: 1, height: 1 };
  }
  function pngUrl(value) {
    if (!value) return "";
    const text = String(value);
    if (text.startsWith("data:") || text.startsWith("blob:")) return text;
    return `data:image/png;base64,${text}`;
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
  function h(doc, tag, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function s(doc, tag, className) {
    const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    if (className) node.setAttribute("class", className);
    return node;
  }
  function attrs(node, values) {
    for (const [name, value] of Object.entries(values)) {
      if (value != null) node.setAttribute(name, String(value));
    }
    return node;
  }
  function seriesById(scene, seriesId) {
    return (scene.series || []).find((item) => item.id === seriesId) || null;
  }
  function markKind(series) {
    if (series?.kind === "bar" || series?.kind === "scatter") return series.kind;
    if (series?.points?.some((point) => point && (point.baseline != null || point.role === "bar-top"))) return "bar";
    return "scatter";
  }
  function barBox(point) {
    const width = finite(point.width) ? point.width : 0;
    const baseline = finite(point.baseline) ? point.baseline : point.y;
    if (point.axis === "x") {
      return {
        x: Math.min(point.x, baseline),
        y: point.y - width / 2,
        width: Math.abs(point.x - baseline),
        height: width
      };
    }
    return {
      x: point.x - width / 2,
      y: Math.min(point.y, baseline),
      width,
      height: Math.abs(point.y - baseline)
    };
  }
  function movedPoint(point, kind, pointer) {
    if (kind === "bar" && point.axis === "x") return { x: pointer.x, y: point.y };
    if (kind === "bar") return { x: point.x, y: pointer.y };
    return { x: pointer.x, y: pointer.y };
  }
  function samePoint(point, next) {
    return Math.abs(point.x - next.x) < NOOP_DISTANCE && Math.abs(point.y - next.y) < NOOP_DISTANCE;
  }
  function validateEditorInputs(host, doc, options) {
    if (!host || typeof host.append !== "function") throw new Error("FalsifyChartMarkEditor.create requires a host element");
    if (!doc?.createElement || !doc.createElementNS) throw new Error("FalsifyChartMarkEditor.create requires a document");
    if (!options.scene || !Array.isArray(options.scene.series)) throw new Error("FalsifyChartMarkEditor.create requires a scene with series");
  }
  function create(options = {}) {
    const host = options.host;
    const doc = options.document || host?.ownerDocument || globalThis.document;
    validateEditorInputs(host, doc, options);
    const core = resolveCore(options.core);
    const onChange = typeof options.onChange === "function" ? options.onChange : null;
    const onCommit = typeof options.onCommit === "function" ? options.onCommit : null;
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
    const root = h(doc, "div", "falsify-mark-editor");
    root.tabIndex = 0;
    attrs(root, { tabindex: "0", role: "application", "aria-label": "막대와 점 편집" });
    const toolbar = h(doc, "div", "falsify-mark-toolbar");
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "막대와 점 도구");
    const undoButton = h(doc, "button", "falsify-mark-button");
    const redoButton = h(doc, "button", "falsify-mark-button");
    const compareButton = h(doc, "button", "falsify-mark-button");
    const exportButton = h(doc, "button", "falsify-mark-button");
    for (const button of [undoButton, redoButton, compareButton, exportButton]) button.type = "button";
    undoButton.textContent = "되돌리기";
    redoButton.textContent = "다시 실행";
    compareButton.textContent = "원본 비교";
    exportButton.textContent = "내보내기";
    for (const button of [undoButton, redoButton, compareButton, exportButton]) {
      button.setAttribute("aria-label", button.textContent);
    }
    compareButton.setAttribute("aria-pressed", "false");
    const status = h(doc, "p", "falsify-mark-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    toolbar.append(undoButton, redoButton, compareButton, exportButton, status);
    const stage = h(doc, "div", "falsify-mark-stage");
    const background = h(doc, "img", "falsify-mark-background");
    const original = h(doc, "img", "falsify-mark-original");
    background.alt = "";
    original.alt = "원본 자르기 그림";
    background.setAttribute("aria-hidden", "true");
    background.style.pointerEvents = "none";
    original.style.pointerEvents = "none";
    const svg = s(doc, "svg", "falsify-mark-svg");
    svg.setAttribute("role", "presentation");
    svg.setAttribute("focusable", "false");
    stage.style.touchAction = "none";
    stage.append(background, original, svg);
    const precision = h(doc, "details", "falsify-mark-precision");
    const summary = h(doc, "summary");
    summary.textContent = "좌표 (px)";
    const note = h(doc, "p", "falsify-mark-note");
    note.textContent = "x (px)와 y (px)는 자르기 그림의 픽셀입니다. 막대는 값 끝만 움직이고 기준선과 너비는 유지됩니다.";
    const table = h(doc, "table", "falsify-mark-table");
    const caption = h(doc, "caption");
    caption.textContent = "픽셀 좌표";
    const thead = h(doc, "thead");
    const headRow = h(doc, "tr");
    for (const label of ["계열", "번호", "x (px)", "y (px)"]) {
      const cell = h(doc, "th");
      cell.textContent = label;
      headRow.append(cell);
    }
    thead.append(headRow);
    const precisionBody = h(doc, "tbody");
    table.append(caption, thead, precisionBody);
    precision.append(summary, note, table);
    root.append(toolbar, stage, precision);
    if (typeof host.replaceChildren === "function") host.replaceChildren(root);
    else host.append(root);
    function assertLive() {
      if (state.destroyed) throw new Error("FalsifyChartMarkEditor instance was destroyed");
    }
    function listen(target, type, fn) {
      target.addEventListener(type, fn);
      listeners.push(() => target.removeEventListener(type, fn));
    }
    function nextId() {
      opSeq += 1;
      return `mark-set-values-${opSeq}`;
    }
    function revision() {
      return state.baseRevision + history.index();
    }
    function envelope(scene, extra) {
      const copy = clone(scene);
      copy.revision = revision();
      return {
        scene: copy,
        operations: history.operations().concat(extra).map((item) => clone(item)),
        revision: copy.revision
      };
    }
    function snapshot() {
      const gesture = state.gesture;
      const operation = gesture?.operation();
      if (operation) return { ...envelope(history.preview([operation]), [operation]), canUndo: history.canUndo(), canRedo: history.canRedo(), compare: state.compare, selection: state.selection ? { ...state.selection } : null };
      return {
        ...envelope(history.scene(), []),
        canUndo: history.canUndo(),
        canRedo: history.canRedo(),
        compare: state.compare,
        selection: state.selection ? { ...state.selection } : null
      };
    }
    function emitChange() {
      const body = snapshot();
      onChange?.({ scene: body.scene, operations: body.operations, revision: body.revision });
      return body;
    }
    function displayedScene() {
      const operation = state.gesture?.operation();
      if (operation) return history.preview([operation]);
      return history.scene();
    }
    function setStatus(text) {
      if (status.textContent !== text) status.textContent = text;
    }
    function statusText() {
      if (state.compare) return "원본과 비교하는 중입니다.";
      if (state.gesture?.kind === "bar") return "막대 높이를 바꾸는 중입니다.";
      if (state.gesture?.kind === "scatter") return "점 위치를 옮기는 중입니다.";
      if (state.selection?.kind === "bar") return "막대 끝 손잡이를 위아래로 또는 가로 축으로 끕니다.";
      if (state.selection?.kind === "scatter") return "선택한 점을 가로와 세로로 옮깁니다.";
      return "막대 끝이나 점을 끌어 값을 바꿉니다.";
    }
    function eventPoint(event) {
      const rect = stage.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
      const x = (event.clientX - rect.left) * (state.size.width / rect.width);
      const y = (event.clientY - rect.top) * (state.size.height / rect.height);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    }
    function markFrom(target) {
      let node = target;
      while (node) {
        const seriesId = node.getAttribute?.("data-series-id");
        const index = Number(node.getAttribute?.("data-index"));
        if (seriesId != null && Number.isInteger(index)) {
          return {
            seriesId,
            index,
            handle: node.getAttribute("data-handle") || "",
            kind: node.getAttribute("data-kind") || ""
          };
        }
        node = node.parentElement;
      }
      return null;
    }
    function renderTable(scene) {
      const active = doc.activeElement;
      const focus = active && precisionBody.contains?.(active) ? [active.getAttribute("data-series-id"), active.getAttribute("data-index"), active.getAttribute("data-axis")] : null;
      precisionBody.replaceChildren();
      for (const series of scene.series || []) {
        const kind = markKind(series);
        series.points.forEach((point, index) => {
          if (!finite(point?.x) || !finite(point?.y)) return;
          const row = h(doc, "tr");
          const name = h(doc, "td");
          name.textContent = series.name || series.id;
          const number = h(doc, "td");
          number.textContent = String(index + 1);
          row.append(name, number);
          for (const axis of ["x", "y"]) {
            const cell = h(doc, "td");
            const input = h(doc, "input");
            input.type = "number";
            input.step = "0.1";
            input.value = formatNumber(point[axis]);
            attrs(input, {
              "data-series-id": series.id,
              "data-index": index,
              "data-axis": axis,
              "aria-label": `${series.id} ${index + 1} ${axis} (px)`
            });
            const locked = kind === "bar" && (point.axis === "x" && axis === "y" || point.axis !== "x" && axis === "x");
            if (locked) {
              input.readOnly = true;
              input.setAttribute("readonly", "");
            }
            if (focus && focus[0] === String(series.id) && focus[1] === String(index) && focus[2] === axis) queueMicrotask(() => {
              if (!state.destroyed && doc.activeElement === doc.body) input.focus?.();
            });
            cell.append(input);
            row.append(cell);
          }
          precisionBody.append(row);
        });
      }
    }
    function renderMarks(scene) {
      svg.replaceChildren();
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      attrs(svg, {
        viewBox: `0 0 ${state.size.width} ${state.size.height}`,
        preserveAspectRatio: "none"
      });
      for (const series of scene.series || []) {
        const kind = markKind(series);
        const color = series.color || series.style?.fill || "#243126";
        series.points.forEach((point, index) => {
          if (!finite(point?.x) || !finite(point?.y)) return;
          const selected = state.selection?.seriesId === series.id && state.selection.index === index;
          if (kind === "bar") {
            const box = barBox(point);
            svg.append(attrs(s(doc, "rect", "falsify-mark-bar"), {
              x: formatNumber(box.x),
              y: formatNumber(box.y),
              width: formatNumber(Math.max(0, box.width)),
              height: formatNumber(Math.max(0, box.height)),
              fill: color,
              "fill-opacity": String(series.style?.opacity ?? 1),
              stroke: selected ? "#1d1a16" : "none",
              "stroke-width": selected ? "2" : "0",
              "data-series-id": series.id,
              "data-index": index,
              "data-kind": "bar",
              "data-handle": "body"
            }));
            svg.append(attrs(s(doc, "circle", point.axis === "x" ? "falsify-mark-handle is-horizontal" : "falsify-mark-handle"), {
              cx: formatNumber(point.x),
              cy: formatNumber(point.y),
              r: "7",
              fill: "#fffdf8",
              stroke: "#1d1a16",
              "stroke-width": "2",
              "data-series-id": series.id,
              "data-index": index,
              "data-kind": "bar",
              "data-handle": "value"
            }));
            return;
          }
          const radius = finite(point.radius) ? point.radius : finite(series.radius) ? series.radius : finite(series.style?.radius) ? series.style.radius : 5;
          svg.append(attrs(s(doc, "circle", "falsify-mark-point"), {
            cx: formatNumber(point.x),
            cy: formatNumber(point.y),
            r: formatNumber(Math.max(1, radius)),
            fill: color,
            "fill-opacity": String(series.style?.opacity ?? 1),
            stroke: selected ? "#1d1a16" : "#fffdf8",
            "stroke-width": "2",
            "data-series-id": series.id,
            "data-index": index,
            "data-kind": "scatter",
            "data-handle": "point"
          }));
        });
      }
    }
    function render() {
      const scene = displayedScene();
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
      stage.className = state.compare ? "falsify-mark-stage is-comparing" : "falsify-mark-stage";
      compareButton.setAttribute("aria-pressed", state.compare ? "true" : "false");
      undoButton.disabled = !history.canUndo() || !!state.gesture;
      redoButton.disabled = !history.canRedo() || !!state.gesture;
      exportButton.disabled = !!state.gesture;
      renderMarks(scene);
      if (!state.gesture) renderTable(scene);
      setStatus(statusText());
    }
    function operationFor(pointer) {
      const gesture = state.gesture;
      if (!gesture) return null;
      const next = movedPoint(gesture.origin, gesture.kind, pointer);
      if (samePoint(gesture.origin, next)) return null;
      return {
        id: gesture.id,
        kind: "set-values",
        seriesId: gesture.seriesId,
        points: [{ index: gesture.index, x: next.x, y: next.y }]
      };
    }
    function release(pointerId) {
      if (pointerId == null || typeof stage.releasePointerCapture !== "function") return;
      try {
        if (typeof stage.hasPointerCapture !== "function" || stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
      } catch {
      }
    }
    let previewFrame = 0;
    let previewScheduled = false;
    let previewEpoch = 0;
    function dropPreviewFrame() {
      previewEpoch += 1;
      previewScheduled = false;
      const frame = previewFrame;
      previewFrame = 0;
      if (frame && typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(frame);
    }
    function schedulePreview() {
      if (state.destroyed || previewScheduled) return;
      const publish = () => {
        state.gesture.previewed = true;
        render();
        emitChange();
      };
      if (typeof globalThis.requestAnimationFrame !== "function") {
        publish();
        return;
      }
      const epoch = previewEpoch;
      previewScheduled = true;
      previewFrame = globalThis.requestAnimationFrame(() => {
        if (epoch !== previewEpoch || state.destroyed || !state.gesture) return;
        previewScheduled = false;
        previewFrame = 0;
        publish();
      }) || 0;
    }
    function endGesture(commit) {
      const gesture = state.gesture;
      if (!gesture) return;
      dropPreviewFrame();
      const operation = gesture.operation();
      state.gesture = null;
      release(gesture.pointerId);
      if (commit && operation) {
        history.apply([operation]);
        const body = snapshot();
        render();
        onChange?.({ scene: body.scene, operations: body.operations, revision: body.revision });
        onCommit?.({ scene: body.scene, operations: body.operations, revision: body.revision });
        return;
      }
      render();
      if (!commit && gesture.previewed) emitChange();
    }
    function beginGesture(event, point, series, mark, kind, origin) {
      event.preventDefault?.();
      const holder = { current: point };
      state.gesture = {
        id: nextId(),
        seriesId: series.id,
        index: mark.index,
        kind,
        origin: { x: origin.x, y: origin.y, axis: origin.axis, baseline: origin.baseline, width: origin.width, radius: origin.radius },
        pointerId: event.pointerId,
        holder,
        operation() {
          return operationFor(holder.current);
        }
      };
      if (event.pointerId != null && typeof stage.setPointerCapture === "function") {
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
        }
      }
    }
    function onPointerDown(event) {
      if (state.destroyed || state.compare || state.gesture) return;
      if (event.button != null && event.button !== 0) return;
      const mark = markFrom(event.target);
      const point = eventPoint(event);
      if (!mark || !point) return;
      const scene = history.scene();
      const series = seriesById(scene, mark.seriesId);
      const origin = series?.points?.[mark.index];
      if (!origin || !finite(origin.x) || !finite(origin.y)) return;
      const kind = mark.kind || markKind(series);
      state.selection = { seriesId: series.id, index: mark.index, kind };
      const draggable = kind === "scatter" || mark.handle === "value";
      if (!draggable) {
        render();
        return;
      }
      beginGesture(event, point, series, mark, kind, origin);
      render();
      emitChange();
    }
    function onPointerMove(event) {
      if (!state.gesture || event.pointerId !== state.gesture.pointerId) return;
      const point = eventPoint(event);
      if (!point) return;
      event.preventDefault?.();
      state.gesture.holder.current = point;
      schedulePreview();
    }
    function onPointerUp(event) {
      if (!state.gesture || event.pointerId !== state.gesture.pointerId) return;
      const point = eventPoint(event);
      if (point) state.gesture.holder.current = point;
      endGesture(true);
    }
    function onPointerCancel(event) {
      if (!state.gesture || event.pointerId !== state.gesture.pointerId) return;
      endGesture(false);
    }
    function undo() {
      assertLive();
      if (state.gesture || !history.canUndo()) return;
      history.undo();
      render();
      emitChange();
      setStatus("되돌렸습니다.");
    }
    function redo() {
      assertLive();
      if (state.gesture || !history.canRedo()) return;
      history.redo();
      render();
      emitChange();
      setStatus("다시 실행했습니다.");
    }
    function onKeyDown(event) {
      if (state.destroyed || event.target?.tagName === "INPUT") return;
      const key = String(event.key || "");
      const mod = !!(event.ctrlKey || event.metaKey);
      if (mod && key.toLowerCase() === "z") {
        event.preventDefault?.();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key.toLowerCase() === "y") {
        event.preventDefault?.();
        redo();
        return;
      }
      if (key === "Escape" && state.gesture) {
        event.preventDefault?.();
        endGesture(false);
      }
    }
    function onPrecisionChange(event) {
      const input = event.target;
      if (!input || input.tagName !== "INPUT" || input.readOnly || state.gesture || state.compare) return;
      const seriesId = input.getAttribute("data-series-id");
      const index = Number(input.getAttribute("data-index"));
      const axis = input.getAttribute("data-axis");
      const value = readNumber(input.value);
      if (!seriesId || !Number.isInteger(index) || axis !== "x" && axis !== "y" || value == null) return;
      const scene = history.scene();
      const series = seriesById(scene, seriesId);
      const point = series?.points?.[index];
      if (!point) return;
      const next = { x: axis === "x" ? value : point.x, y: axis === "y" ? value : point.y };
      if (samePoint(point, next)) return;
      history.apply([{ id: nextId(), kind: "set-values", seriesId: series.id, points: [{ index, x: next.x, y: next.y }] }]);
      state.selection = { seriesId: series.id, index, kind: markKind(series) };
      const body = snapshot();
      render();
      onChange?.({ scene: body.scene, operations: body.operations, revision: body.revision });
      onCommit?.({ scene: body.scene, operations: body.operations, revision: body.revision });
    }
    function toggleCompare() {
      if (!state.originalPng) {
        state.compare = false;
        render();
        setStatus("비교할 원본 이미지가 없습니다.");
        return;
      }
      if (state.gesture) endGesture(false);
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
    listen(stage, "lostpointercapture", onPointerCancel);
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
        if (!scene || !Array.isArray(scene.series)) throw new Error("FalsifyChartMarkEditor.setScene requires a scene with series");
        if (state.gesture) endGesture(false);
        history = bindHistory(core, scene);
        state.baseRevision = finite(scene.revision) ? scene.revision : 0;
        state.selection = null;
        state.compare = false;
        state.backgroundPng = scene.backgroundPng || "";
        state.originalPng = scene.originalPng || "";
        state.size = sceneSize(scene);
        render();
        emitChange();
      },
      getState() {
        assertLive();
        return snapshot();
      },
      undo,
      redo,
      destroy() {
        if (state.destroyed) return;
        dropPreviewFrame();
        state.destroyed = true;
        if (state.gesture) {
          release(state.gesture.pointerId);
          state.gesture = null;
        }
        for (const off of listeners) off();
        listeners.length = 0;
        if (typeof root.remove === "function") root.remove();
        if (typeof host.replaceChildren === "function") host.replaceChildren();
      }
    };
  }
  var EDITOR_CSS = `/* Falsify chart mark editor. No remote assets. */
.falsify-mark-editor {
  color: #1d1a16;
  background: #f7f4ee;
  font: 14px/1.45 "Segoe UI", sans-serif;
  display: grid;
  gap: 8px;
  padding: 8px;
  box-sizing: border-box;
}
.falsify-mark-editor:focus {
  outline: 2px solid #1d1a16;
  outline-offset: 2px;
}
.falsify-mark-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.falsify-mark-button {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid #1d1a16;
  background: #fffdf8;
  color: #1d1a16;
  font: inherit;
  cursor: pointer;
}
.falsify-mark-button[aria-pressed="true"] {
  background: #1d1a16;
  color: #fffdf8;
}
.falsify-mark-button:disabled {
  cursor: default;
  opacity: 0.45;
}
.falsify-mark-status {
  margin: 0;
  flex: 1 1 12em;
}
.falsify-mark-stage {
  position: relative;
  width: 100%;
  max-width: 100%;
  height: auto;
  touch-action: none;
  background: #ebe6dc;
  user-select: none;
  overflow: hidden;
}
.falsify-mark-background,
.falsify-mark-original,
.falsify-mark-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.falsify-mark-background,
.falsify-mark-original {
  object-fit: fill;
  pointer-events: none;
}
.falsify-mark-original {
  z-index: 2;
}
.falsify-mark-svg {
  z-index: 3;
  overflow: hidden;
  touch-action: none;
}
.falsify-mark-stage.is-comparing .falsify-mark-svg {
  visibility: hidden;
}
.falsify-mark-bar {
  cursor: pointer;
}
.falsify-mark-handle {
  fill: #fffdf8;
  stroke: #1d1a16;
  stroke-width: 2px;
  vector-effect: non-scaling-stroke;
  cursor: ns-resize;
}
.falsify-mark-handle.is-horizontal {
  cursor: ew-resize;
}
.falsify-mark-point {
  cursor: move;
  vector-effect: non-scaling-stroke;
}
.falsify-mark-precision {
  background: #fffdf8;
  border: 1px solid #d9d2c5;
  padding: 8px;
}
.falsify-mark-note {
  margin: 8px 0;
}
.falsify-mark-table {
  border-collapse: collapse;
  margin: 8px 0;
}
.falsify-mark-table th,
.falsify-mark-table td {
  border-bottom: 1px solid #d9d2c5;
  padding: 2px 6px;
  text-align: left;
  font-weight: 400;
}
.falsify-mark-table input {
  width: 8ch;
  font: 12px/1.4 ui-monospace, Consolas, monospace;
  color: #1d1a16;
  background: #fffdf8;
  border: 1px solid #d9d2c5;
  box-sizing: border-box;
}
.falsify-mark-table input[readonly] {
  background: #f3efe6;
}
`;
  return __toCommonJS(chart_mark_editor_exports);
})();

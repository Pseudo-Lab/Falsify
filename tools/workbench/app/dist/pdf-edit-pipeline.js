var FalsifyPdfEditPipeline = (() => {
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

  // app/src/pdf-edit-pipeline.mjs
  var pdf_edit_pipeline_exports = {};
  __export(pdf_edit_pipeline_exports, {
    PdfEditPipelineError: () => PdfEditPipelineError,
    prepare: () => prepare
  });
  var HEX = /^[a-f0-9]{64}$/i;
  var MAX_BYTES = 25 * 1024 * 1024;
  var PdfEditPipelineError = class extends Error {
    constructor(code, message = code) {
      super(message);
      this.name = "PdfEditPipelineError";
      this.code = code;
    }
  };
  var fail = (code) => {
    throw new PdfEditPipelineError(code);
  };
  var abort = (signal) => {
    if (signal?.aborted) fail("aborted");
  };
  var copy = (value) => value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
  var isTable = (e) => String(e?.segmentId || "").startsWith("table:");
  async function hash(bytes, signal) {
    abort(signal);
    const value = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
    abort(signal);
    return value;
  }
  async function read(file, signal) {
    abort(signal);
    if (Number.isFinite(file?.size) && file.size > MAX_BYTES) fail("file-too-large");
    const own = (value) => {
      if (!value || value.byteLength > MAX_BYTES) fail("invalid-file");
      return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : new Uint8Array(value).slice();
    };
    const bytes = file instanceof Uint8Array ? own(file) : file?.bytes instanceof Uint8Array ? own(file.bytes) : typeof file?.arrayBuffer === "function" ? own(await file.arrayBuffer()) : null;
    abort(signal);
    if (!bytes?.length || bytes.length > MAX_BYTES) fail("invalid-file");
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) fail("invalid-pdf");
    return bytes;
  }
  function prepareOf(api) {
    if (typeof api?.prepare !== "function") fail("engine-unavailable");
    return (request) => api.prepare(request);
  }
  function classification(result) {
    const v = result.verification;
    if (v?.status === "draft" || v?.report?.draft === true || v?.report?.status === "draft") return "draft";
    const allowedEdits = /* @__PURE__ */ new Set(["applied", "noop"]), allowedChecks = /* @__PURE__ */ new Set(["passed", "applied", "noop", "warning"]);
    const invalid = (rows, allowed) => rows !== void 0 && (!Array.isArray(rows) || rows.some((row) => !allowed.has(row?.status)));
    const checks = [v?.selfCheck, v?.report?.selfCheck].filter(Boolean);
    const report = v?.report;
    if (v?.status === "failed" || invalid(v?.edits, allowedEdits) || invalid(report?.edits, allowedEdits) || invalid(v?.checks, allowedChecks) || report?.ok === false || report?.quality === "failed" || checks.some((c) => c.ok === false || !["passed", "warning"].includes(c.status) || Array.isArray(c.failures) && c.failures.length) || report?.status !== void 0 && !["self-check-passed", "applied", "passed", "warning", "noop"].includes(report.status) || ["removedBefore", "presentAfter", "untouchedText", "figures"].some((k) => v?.quality?.[k] === false)) return "failed";
    return v?.status === "applied" || v?.status === "warning" ? v.status : "unverified";
  }
  async function verifyResult(result, inputHash, signal) {
    if (!result || typeof result.sha256 !== "string" || !HEX.test(result.sha256) || typeof result.file?.arrayBuffer !== "function") fail("invalid-result");
    const fileRef = result.file, saved = { ...result, sha256: result.sha256.toLowerCase(), verification: copy(result.verification), warnings: copy(result.warnings), pageMap: copy(result.pageMap) };
    const bytes = await read(fileRef, signal), actual = await hash(bytes, signal);
    if (actual !== saved.sha256) fail("output-hash-mismatch");
    const v = saved.verification;
    if (v?.sourceSha256 !== void 0 && v.sourceSha256 !== inputHash) fail("stage-source-hash-mismatch");
    if (v?.outputSha256 !== void 0 && v.outputSha256 !== actual) fail("stage-output-hash-mismatch");
    const rawName = typeof fileRef.name === "string" ? fileRef.name : "document.pdf";
    let name = rawName.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 160) || "document.pdf";
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    saved.file = new File([bytes], name, { type: "application/pdf" });
    return { bytes, actual, status: classification(saved), result: saved, fileRef };
  }
  function identityPages(result, edits) {
    const map = result.pageMap, count = result.verification?.pageCount;
    if (!Array.isArray(map) || !map.length || !Number.isSafeInteger(count?.source) || count.source !== map.length || count.output !== count.source || map.some((m, i) => m?.sourcePageIndex !== i || m.outputPageIndex !== i || !Array.isArray(m.continuationPageIndices) || m.continuationPageIndices.length || Object.hasOwn(m, "contentOutputPageIndices") && JSON.stringify(m.contentOutputPageIndices) !== JSON.stringify([i])) || edits.some((e) => !Number.isSafeInteger(e.pageIndex) || e.pageIndex < 0 || e.pageIndex >= map.length)) fail("stage-one-page-map-not-identity");
  }
  var validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
  function disjoint(tables, body) {
    for (const a of tables) for (const b of body) if (a.pageIndex === b.pageIndex) {
      const x = a.anchor?.bbox, y = b.anchor?.bbox;
      if (!validBox(x) || !validBox(y)) fail("mixed-overlap-unverifiable");
      if (Math.min(x[2], y[2]) > Math.max(x[0], y[0]) && Math.min(x[3], y[3]) > Math.max(x[1], y[1])) fail("overlapping-edits");
    }
  }
  function descriptor(name, inputSha256, result, verified) {
    return { name, inputSha256, outputSha256: verified.actual, status: verified.status, verification: copy(result.verification) ?? null, checks: copy(result.verification?.checks) ?? [], warnings: copy(result.warnings) ?? [] };
  }
  function composite(result, original, stages, pending, status, extra = []) {
    const warnings = [...stages.flatMap((s) => s.warnings.map((w) => ({ ...w, stage: s.name }))), ...extra];
    return { ...result, originalSourceSha256: original, warnings, verification: { schema: "falsify.pdf-edit-pipeline.v1", engine: "table-first-composition", sourceSha256: original, outputSha256: stages.at(-1).outputSha256, status, independent: false, layoutVerified: false, stages, pendingEditIds: pending.map((e) => e.id ?? null), bodyPending: pending.length > 0, checks: stages.flatMap((s) => s.checks.map((c) => ({ ...c, stage: s.name }))), warnings } };
  }
  async function prepare(request = {}, { selectionPdf, paragraphPdf } = {}) {
    const raw = Array.isArray(request.edits) ? request.edits : request.edits?.edits;
    if (!Array.isArray(raw)) fail("invalid-edits");
    const enabled = raw.filter((e) => e?.enabled !== false), tables = enabled.filter(isTable), body = enabled.filter((e) => !isTable(e));
    abort(request.signal);
    if (!tables.length) return prepareOf(paragraphPdf)(request);
    if (!body.length) return prepareOf(selectionPdf)(request);
    const { file: capturedFile, signal, ...rest } = request;
    const { fontSnapshot, ...metadata } = rest;
    const controls = { ...copy(metadata), ...fontSnapshot ? { fontSnapshot: structuredClone(fontSnapshot) } : {}, file: capturedFile, signal };
    if (enabled.length > 24 || enabled.some((e) => !e || typeof e.before !== "string" || typeof e.after !== "string")) fail("invalid-edits");
    disjoint(tables, body);
    const envelope = Array.isArray(request.edits) ? null : copy(request.edits);
    const tableEdits = copy(tables), bodyEdits = copy(body);
    const declared = controls.fileHash || envelope?.fileHash;
    if (typeof declared !== "string" || !HEX.test(declared) || controls.fileHash && envelope?.fileHash && controls.fileHash.toLowerCase() !== envelope.fileHash.toLowerCase()) fail("invalid-source-hash");
    const originalBytes = await read(capturedFile, signal), original = await hash(originalBytes, signal);
    if (original !== declared.toLowerCase()) fail("stale-source");
    for (const e of tableEdits) if (e.anchor) delete e.anchor.occurrence;
    const tablePages = new Set(tableEdits.map((e) => e.pageIndex));
    for (const e of bodyEdits) if (tablePages.has(e.pageIndex) && validBox(e.anchor?.bbox)) delete e.anchor.occurrence;
    const scoped = (edits, file, fileHash) => ({ ...controls, ...controls.fontSnapshot ? { fontSnapshot: structuredClone(controls.fontSnapshot) } : {}, file, fileHash, signal, edits: envelope ? { ...copy(envelope), fileHash, edits } : edits });
    const stageA = await prepareOf(selectionPdf)(scoped(tableEdits, originalBytes.slice(), original));
    abort(signal);
    const a = await verifyResult(stageA, original, signal), first = descriptor("table-selection", original, a.result, a);
    if (a.status !== "applied" && a.status !== "warning") return composite(a.result, original, [first], bodyEdits, "failed", [{ code: "mixed-table-stage-not-passed", severity: "warning", bodyPending: true }]);
    identityPages(a.result, [...tableEdits, ...bodyEdits]);
    const aBytes = await read(a.fileRef, signal);
    if (await hash(aBytes, signal) !== a.actual) fail("stage-one-file-changed");
    const stageB = await prepareOf(paragraphPdf)(scoped(bodyEdits, aBytes, a.actual));
    abort(signal);
    const b = await verifyResult(stageB, a.actual, signal), second = descriptor("paragraph-flow", a.actual, b.result, b);
    const status = b.status === "unverified" ? "failed" : b.status === "applied" && a.status === "warning" ? "warning" : b.status;
    abort(signal);
    return composite(b.result, original, [first, second], [], status, status === "failed" || status === "draft" ? [{ code: "mixed-body-stage-not-passed", severity: "warning", draft: status === "draft" }] : []);
  }
  return __toCommonJS(pdf_edit_pipeline_exports);
})();

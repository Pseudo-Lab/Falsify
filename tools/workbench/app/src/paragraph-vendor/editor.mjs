// Explicit, all-or-nothing PDF text edits on the pinned BentoPDF editcore.
//
// Alignment and run-preserving rebuild are derived from the earlier
// proof-of-concept adapter (AGPL-3.0-only, see notices). Every requested edit
// must match exactly once on its page after whitespace normalization; there
// is no fuzzy relocation, implicit selection or shortening of After text.
// All pages are planned against unchanged snapshots before any commit.
import { createHash } from "node:crypto";
import { loadRuntime } from "./runtime.mjs";
import { PAGINATION_CAPABILITY, PAGINATION_LIMITS, paginateOverflow } from "./pagination.mjs";
import {
  LineRetentionError,
  canCommitLineLocal,
  commitRetainingLines,
  pageObjectList,
  planInlineChange,
  replaceReflowWithLineLocal,
  sourceLinePlan,
} from "./inline-preservation.mjs";

export const LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxEdits: 64,
  maxTextChars: 4000,
  maxIdChars: 64,
});

// What this editor can do, for backends that advertise capabilities.
// pagination.supported is true only for the scope it describes.
export const EDITOR_CAPABILITIES = Object.freeze({
  reflow: true,
  pagination: PAGINATION_CAPABILITY,
  continuationStyle: Object.freeze({
    supported: true,
    policy: "source-number-suffix",
    scope: "text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged",
  }),
  limits: LIMITS,
});

export class EditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EditError";
    this.code = code;
    this.details = details;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EDIT_KEYS = new Set(["id", "pageIndex", "before", "after"]);
const REQUEST_KEYS = new Set(["sourceBytes", "edits", "reflow"]);

export const normalizeText = (s) => s.replace(/\s+/g, " ");

// Validates shape and budgets only; page ranges need the opened document.
export function validateRequest(request, limits = LIMITS) {
  const bad = (msg, details) => {
    throw new EditError("INVALID_REQUEST", msg, details);
  };
  if (!request || typeof request !== "object" || Array.isArray(request)) bad("Request must be an object");
  for (const k of Object.keys(request)) if (!REQUEST_KEYS.has(k)) bad(`Unknown request field: ${k}`);
  const { sourceBytes, edits, reflow } = request;
  if (!(sourceBytes instanceof Uint8Array)) bad("sourceBytes must be a Uint8Array");
  if (sourceBytes.length === 0) bad("sourceBytes is empty");
  if (sourceBytes.length > limits.maxFileBytes) bad(`sourceBytes exceeds ${limits.maxFileBytes} bytes`);
  if (typeof reflow !== "boolean") bad("reflow must be a boolean");
  if (!Array.isArray(edits)) bad("edits must be an array");
  if (edits.length > limits.maxEdits) bad(`At most ${limits.maxEdits} edits are allowed`);
  const seen = new Set();
  edits.forEach((e, index) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) bad(`Edit #${index} must be an object`, { index });
    for (const k of Object.keys(e)) if (!EDIT_KEYS.has(k)) bad(`Edit #${index} has unknown field: ${k}`, { index });
    if (typeof e.id !== "string" || e.id.length > limits.maxIdChars || !ID_RE.test(e.id)) {
      bad(`Edit #${index} id must match ${ID_RE} and be at most ${limits.maxIdChars} characters`, { index });
    }
    if (seen.has(e.id)) bad(`Duplicate edit id: ${e.id}`, { id: e.id });
    seen.add(e.id);
    if (!Number.isInteger(e.pageIndex) || e.pageIndex < 0) bad(`Edit ${e.id} pageIndex must be a non-negative integer`, { id: e.id });
    if (typeof e.before !== "string" || e.before.trim() === "") bad(`Edit ${e.id} before must be non-empty text`, { id: e.id });
    if (typeof e.after !== "string") bad(`Edit ${e.id} after must be a string`, { id: e.id });
    if (e.before.length > limits.maxTextChars || e.after.length > limits.maxTextChars) {
      bad(`Edit ${e.id} text exceeds ${limits.maxTextChars} characters`, { id: e.id });
    }
  });
  return { sourceBytes, edits: edits.map((e) => ({ id: e.id, pageIndex: e.pageIndex, before: e.before, after: e.after })), reflow };
}

function paginationOptions(options) {
  const bad = (msg) => {
    throw new EditError("INVALID_REQUEST", msg);
  };
  const allow = options.allowPagination ?? true;
  if (typeof allow !== "boolean") bad("allowPagination must be a boolean");
  const max = options.maxNewPages ?? PAGINATION_LIMITS.defaultMaxNewPages;
  if (!Number.isInteger(max) || max < 0 || max > PAGINATION_LIMITS.maxNewPages) bad(`maxNewPages must be an integer from 0 to ${PAGINATION_LIMITS.maxNewPages}`);
  return { allow, max };
}

// ---------- alignment (PoC-derived) ----------

function pageIndexMap(paras) {
  const chars = [];
  paras.forEach((p, pi) => {
    if (pi > 0) chars.push({ ch: "\n", pi: -1 });
    let offset = 0;
    const text = p.runs.map((r) => r.text).join("");
    const starts = new Set((p.lines || []).map((l) => l.off));
    p.runs.forEach((r, ri) => {
      for (let o = 0; o < r.text.length; o++) {
        const at = offset + o;
        const lineEndHyphen = text[at] === "\u0002" && /\p{L}/u.test(text[at - 1] || "") && /\s/.test(text[at + 1] || "") && /\p{L}/u.test(text[at + 2] || "") && starts.has(at + 2);
        chars.push({ ch: r.text[o], pi, ri, o, lineEndHyphen });
      }
      offset += r.text.length;
    });
  });
  return chars;
}

// Canonical selection text joins only source-proven discretionary line-end
// hyphens. Literal hyphens/minus signs and unproven controls are untouched.
export function sourceParagraphText(para) {
  const chars = pageIndexMap([para]);
  const drop = new Set(chars.flatMap((c,i) => c.lineEndHyphen ? [i,i+1] : []));
  return chars.filter((_,i) => !drop.has(i)).map((c) => c.ch).join("");
}

export const canonicalParagraphText = sourceParagraphText;

function normalizeChars(chars, logical = false) {
  let norm = "";
  const map = [];
  for (let i = 0; i < chars.length; i++) {
    if (logical && chars[i].lineEndHyphen) { i++; continue; }
    if (/\s/.test(chars[i].ch)) {
      let j = i;
      while (j + 1 < chars.length && /\s/.test(chars[j + 1].ch)) j++;
      norm += " ";
      map.push([i, j]);
      i = j;
    } else {
      norm += chars[i].lineEndHyphen ? "-" : chars[i].ch;
      map.push([i, i]);
    }
  }
  return { norm, map };
}

function findAll(norm, needle) {
  const hits = [];
  for (let k = norm.indexOf(needle); k >= 0; k = norm.indexOf(needle, k + 1)) hits.push(k);
  return hits;
}

// breaks: optional "ri:o" keys of source whitespace written as hard breaks.
export function rebuildRuns(para, del, inserts, breaks = null) {
  const out = [];
  const sourceChars = !breaks ? pageIndexMap([para]) : [];
  const discretionary = new Set();
  sourceChars.forEach((c,i) => {
    if (!c.lineEndHyphen) return;
    discretionary.add(c.ri + ":" + c.o);
    const next = sourceChars[i+1];
    discretionary.add(next.ri + ":" + next.o);
  });
  para.runs.forEach((r, ri) => {
    let t = "";
    for (let o = 0; o <= r.text.length; o++) {
      for (const ins of inserts) if (ins.ri === ri && ins.o === o) t += ins.text;
      if (o < r.text.length && !del.has(ri + ":" + o) && !discretionary.has(ri + ":" + o)) t += breaks?.has(ri + ":" + o) ? "\n" : r.text[o];
    }
    out.push({ ...r, text: t, rgba: r.rgba >>> 0, sourceIndex: ri });
  });
  const kept = out.filter((r) => r.text.length > 0);
  return kept.length ? kept : out.slice(0, 1);
}

// Plans all edits of one page against an unchanged paragraph snapshot.
// Only the changed tokens inside each match are mutated, so unchanged
// tokens keep their own run style and a replacement inherits the style of
// what it replaces (AMBIGUOUS_STYLE when that cannot be justified).
// Returns { failures, plans, perPara }; failures carry no document text.
export function planPageEdits(paras, edits) {
  const chars = pageIndexMap(paras);
  const visible = normalizeChars(chars);
  const logical = normalizeChars(chars, true);
  const failures = [];
  const spans = [];
  const plans = [];
  for (const e of edits) {
    const needle = normalizeText(e.before);
    // Both representations name raw source spans. Count their union before
    // choosing a target: an exact visible hit must not hide a second
    // paragraph whose source-proven discretionary spelling is equivalent.
    const candidates = new Map();
    for (const variant of [visible, logical]) {
      for (const hit of findAll(variant.norm, needle)) {
        const a = variant.map[hit][0], b = variant.map[hit + needle.length - 1][1];
        const key = a + ":" + b;
        if (!candidates.has(key)) candidates.set(key, { ...variant, hit, a, b });
      }
    }
    if (candidates.size !== 1) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: candidates.size ? "AMBIGUOUS_MATCH" : "NOT_FOUND", hits: candidates.size });
      continue;
    }
    const { map, hit, a, b } = candidates.values().next().value;
    const hits = [hit];
    const overlap = spans.find((s) => !(b < s.a || a > s.b));
    if (overlap) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: "OVERLAPPING_EDITS", with: overlap.id });
      continue;
    }
    spans.push({ a, b, id: e.id });
    const span = chars.slice(a, b + 1).filter((c) => c.pi >= 0);
    const touched = [...new Set(span.map((c) => c.pi))];
    const locked = touched.filter((pi) => paras[pi].editable === false);
    if (locked.length) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: "NOT_EDITABLE", paragraphIds: locked.map((pi) => paras[pi].id) });
      continue;
    }
    const lastPi = touched[touched.length - 1];
    const noop = normalizeText(e.after) === needle;
    const change = noop ? null : planInlineChange(paras, chars, map, hits[0], needle, e.after);
    if (change?.failure) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: change.failure });
      continue;
    }
    plans.push({ edit: e, span, touched, insertAt: span.find((c) => c.pi === lastPi), noop, change, start: a, sourceHyphenNormalization: span.some((c) => c.lineEndHyphen) });
  }
  // Paragraph mutations, built only from accepted, non-noop plans.
  const perPara = new Map();
  const entry = (pi) => {
    if (!perPara.has(pi)) perPara.set(pi, { del: new Set(), inserts: [] });
    return perPara.get(pi);
  };
  for (const p of plans) {
    if (p.noop) continue;
    for (const c of p.change.del) entry(c.pi).del.add(c.ri + ":" + c.o);
    p.change.inserts.forEach((ins, k) => entry(ins.pi).inserts.push({ ri: ins.ri, o: ins.o, text: ins.text, start: p.start, k }));
  }
  // Inserts sharing a position keep the page order of their edits.
  for (const v of perPara.values()) v.inserts.sort((x, y) => x.start - y.start || x.k - y.k);
  return { failures, plans, perPara };
}

// Paragraph ids are reassigned on every buildModel(), so snapshots compare
// text, run structure and geometry by paragraph order instead.
function snapshotKey(paras) {
  const box = (b) => (b ? [b.x, b.top, b.w, b.h].map((v) => Math.round(v * 100)).join(",") : "-");
  return paras.map((p) => box(p.box) + "|" + p.runs.map((r) => r.text).join("\u0000")).join("\n");
}

function groupByPage(edits) {
  const byPage = new Map();
  for (const e of edits) byPage.set(e.pageIndex, [...(byPage.get(e.pageIndex) || []), e]);
  return [...byPage.entries()].sort((x, y) => x[0] - y[0]);
}

async function loadQuality(override) {
  if (override) return override;
  try {
    return await import("./quality.mjs");
  } catch (err) {
    throw new EditError("QUALITY_UNAVAILABLE", "Quality module src/quality.mjs could not be loaded", { cause: err.code ?? err.name });
  }
}

// Captures console output from the upstream engine. Text is kept only when
// the caller opted in, because engine messages may quote document content.
function captureConsole(keepText) {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  const entries = [];
  let count = 0;
  const sink = (level) => (...args) => {
    count++;
    if (keepText) entries.push(level + ": " + args.map(String).join(" "));
  };
  console.warn = sink("warn");
  console.error = sink("error");
  console.log = sink("log");
  return {
    restore() {
      Object.assign(console, saved);
      return keepText ? { count, entries } : { count };
    },
  };
}

/**
 * editPdf({ sourceBytes, edits, reflow }, options?) => { pdf, report }
 *
 * options: sourceRoot, runtimeDir, includeEngineLog (default false),
 * allowPagination (default true), maxNewPages (document-wide budget,
 * default 8, at most 32), includeFlowText (default false: expected flow
 * text is reported as sha256/length only),
 * draft (default false; only the boolean true opts in),
 * quality / engineFactory (test seams).
 * Throws EditError on any definite failure; err.report carries diagnostics.
 * Strict mode (draft not exactly true, including the CLI) still throws after
 * a saved-file self-check failure and does not return those bytes.
 * Draft mode returns the saved readable PDF with ok:false when the self-check
 * fails or cannot run. It does not relabel that check as passed.
 */
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A saved file is readable here only when it is non-empty PDF bytes. Draft mode
// never invents a document and never treats another payload as a PDF.
function readablePdf(pdf) {
  return pdf instanceof Uint8Array && pdf.length >= 5 && pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46 && pdf[4] === 0x2d;
}

// After text that the self-check did not find must not keep a success status.
function withholdAbsentAfter(report) {
  const failures = Array.isArray(report.selfCheck?.failures) ? report.selfCheck.failures : [];
  const missing = failures.filter((f) => f && f.code === "after_missing");
  if (!missing.length) return;
  const ids = new Set(missing.map((f) => f.id).filter((id) => typeof id === "string"));
  const pages = new Set(missing.filter((f) => f.id == null && Number.isInteger(f.pageIndex)).map((f) => f.pageIndex));
  const unlabeled = ids.size === 0 && pages.size === 0;
  for (const row of report.edits) {
    if ((unlabeled || ids.has(row.id) || pages.has(row.pageIndex)) && (row.status === "applied" || row.status === "noop")) row.status = "after-missing";
  }
}

// Honest draft: the saved bytes stay, the check is not rewritten to passed,
// and the export itself is not labeled successful.
function finishDraft(report, pdf, sourceBytes, code, message) {
  report.ok = false;
  report.status = "draft";
  report.draft = true;
  report.quality = report.selfCheck?.status === "error" ? "error" : "failed";
  withholdAbsentAfter(report);
  report.inputSha256 = sha256Bytes(sourceBytes);
  report.outputSha256 = sha256Bytes(pdf);
  report.error = { code, message };
  return { pdf, report };
}

export async function editPdf(request, options = {}) {
  const { sourceBytes, edits, reflow } = validateRequest(request, options.limits ?? LIMITS);
  const pg = paginationOptions(options);
  const quality = await loadQuality(options.quality);
  for (const fn of ["capturePageLayout", "repairPageLayout", "inspectSavedPdf"]) {
    if (typeof quality[fn] !== "function") throw new EditError("QUALITY_UNAVAILABLE", `Quality module lacks ${fn}`);
  }
  let engineFactory = options.engineFactory;
  let runtimeInfo = options.runtimeInfo ?? null;
  if (!engineFactory) {
    const rt = await loadRuntime({ sourceRoot: options.sourceRoot, runtimeDir: options.runtimeDir });
    engineFactory = rt.engineFactory;
    runtimeInfo = rt.info;
  }

  const report = {
    ok: false,
    status: "failed",
    reflow,
    runtime: runtimeInfo,
    edits: edits.map((e) => ({ id: e.id, pageIndex: e.pageIndex, status: "pending" })),
    pages: [],
    repairs: [],
    warnings: [],
    selfCheck: { status: "not-run" },
    independentQA: { status: "pending", note: "Same-engine self-check only; independent QA is still required." },
  };
  const editReport = new Map(report.edits.map((r) => [r.id, r]));
  const fail = (code, message, details) => {
    const err = new EditError(code, message, details);
    err.report = report;
    return err;
  };

  const logCapture = captureConsole(!!options.includeEngineLog);
  let engine;
  let pdf;
  let sourcePageCount = 0;
  const continued = new Map();
  let added = 0;
  try {
    try {
      engine = await engineFactory(sourceBytes);
    } catch (err) {
      throw fail("OPEN_FAILED", err.passwordRequired ? "Source PDF is password-protected" : "Source PDF could not be opened");
    }
    sourcePageCount = engine.pageCount;
    const outOfRange = edits.filter((e) => e.pageIndex >= engine.pageCount);
    if (outOfRange.length) {
      for (const e of outOfRange) editReport.get(e.id).status = "page-out-of-range";
      throw fail("PAGE_OUT_OF_RANGE", `Edit page index out of range (document has ${engine.pageCount} pages)`, { ids: outOfRange.map((e) => e.id) });
    }

    // Phase 1: plan every page against its unchanged snapshot; no commits.
    const pagePlans = [];
    const failures = [];
    for (const [pageIndex, pageEdits] of groupByPage(edits)) {
      engine.loadPage(pageIndex);
      engine.normalizeFontsForEdit();
      const paras = engine.buildModel();
      const plan = planPageEdits(paras, pageEdits);
      failures.push(...plan.failures);
      pagePlans.push({ pageIndex, paras, plan, key: snapshotKey(paras), regenHostile: engine.pageRegenHostile() });
    }
    if (failures.length) {
      for (const f of failures) Object.assign(editReport.get(f.id), { status: "rejected", code: f.code, hits: f.hits });
      if (failures.every((f) => f.code === "AMBIGUOUS_STYLE")) {
        throw fail("STYLE_AMBIGUOUS", `${failures.length} edit(s) replace text of several styles with no justified style mapping`, { failures });
      }
      throw fail("MATCH_FAILED", `${failures.length} edit(s) could not be matched exactly once or planned`, { failures });
    }

    // Phase 2: per page, re-verify the snapshot, capture layout, commit, repair.
    // Pages are processed in source order; continuation pages inserted after
    // a page shift every later page by `added`, so the engine addresses
    // source page p at p + added (pagination evicts stale cache entries).
    let mutated = false;
    for (const { pageIndex, plan, key, regenHostile } of pagePlans) {
      const pageReport = { pageIndex, paragraphs: [], regenHostile };
      report.pages.push(pageReport);
      if (regenHostile) report.warnings.push({ pageIndex, code: "PAGE_REGEN_HOSTILE" });
      for (const p of plan.plans) {
        Object.assign(editReport.get(p.edit.id), {
          status: p.noop ? "noop" : "planned",
          paragraphIndices: [...p.touched],
        });
        if (p.sourceHyphenNormalization) report.warnings.push({ pageIndex, id: p.edit.id, code: "source_line_end_discretionary_hyphen_matched", severity: "info", evidence: "PDFium U+0002 followed by source line boundary", originalBefore: p.edit.before });
        if (p.change?.warning) report.warnings.push({ pageIndex, id: p.edit.id, code: p.change.warning, severity: "warning" });
      }
      if (plan.perPara.size === 0) continue;
      const at = pageIndex + added;
      engine.loadPage(at);
      // A line-local commit undoes steps by object handle, so it needs a page
      // whose model build keeps every page object: a build that re-creates
      // objects (seen for text objects with word spacing) would point those
      // steps at other objects. Such a page keeps the plain re-layout.
      const objectsBefore = canCommitLineLocal(engine) ? pageObjectList(engine).join(",") : null;
      const paras = engine.buildModel();
      const localStable = objectsBefore !== null && pageObjectList(engine).join(",") === objectsBefore;
      if (snapshotKey(paras) !== key) throw fail("STATE_DRIFT", "Page model changed between planning and commit", { pageIndex });
      const context = quality.capturePageLayout(engine, at, paras);
      const touched = [];
      for (const [pi, { del, inserts }] of [...plan.perPara.entries()].sort((x, y) => x[0] - y[0])) {
        const para = paras[pi];
        const runs = rebuildRuns(para, del, inserts);
        // Source lines are kept in place when the engine re-lays the
        // paragraph out for an edit that fits them (see inline-preservation).
        const linePlan = sourceLinePlan(para, del, inserts);
        if (linePlan?.breaks) linePlan.lineRuns = rebuildRuns(para, del, inserts, linePlan.breaks);
        mutated = true;
        let committed;
        let lineLocal = null;
        let publishedId = null;
        try {
          // Only a stepped commit (linePlan.breaks) can be undone here.
          const pre = linePlan?.breaks && localStable ? pageObjectList(engine) : null;
          committed = commitRetainingLines(engine, para, runs, linePlan);
          // Any plain re-layout lost the source lines, including one that
          // changed the line count: commitLineLocal itself declines an edit
          // that leaves its source line or does not fit it.
          const lost = committed.lines?.status === "reflowed";
          if (lost && linePlan?.breaks && objectsBefore !== null && !localStable) lineLocal = { status: "declined", reason: "page_model_unstable" };
          // A re-layout that lost the source lines is replaced by a re-layout
          // of the edited line alone when the edit stays inside it.
          if (pre && lost) {
            const changed = new Set(touched.map((t) => t.index));
            const local = replaceReflowWithLineLocal(engine, paras, pi, del, inserts, runs, pre, changed);
            // A line-local commit and a declined prefix rollback both rebuild
            // the page model, which renumbers every paragraph. The page keeps
            // the same paragraphs in order, including ones edited later.
            const applyIds = (ids) => {
              if (!Array.isArray(ids)) return;
              publishedId = ids[pi];
              ids.forEach((id, j) => {
                paras[j].id = id;
                context.paras[j].id = id;
              });
              for (const t of touched) t.id = ids[t.index];
            };
            if (local.lines) {
              committed = local;
              applyIds(local.ids);
            } else {
              committed = { upd: local.upd, lines: committed.lines };
              lineLocal = { status: "declined", reason: local.reason };
              applyIds(local.ids);
            }
          }
        } catch (err) {
          if (!(err instanceof LineRetentionError)) throw err;
          throw fail(err.code === "state_drift" ? "STATE_DRIFT" : "COMMIT_FAILED", "Paragraph state could not be re-verified during a line-retaining commit", { pageIndex, paragraphId: para.id, cause: err.code });
        }
        const upd = committed.upd;
        if (!upd) throw fail("COMMIT_FAILED", "Engine rejected a paragraph commit", { pageIndex, paragraphId: para.id });
        const row = { index: pi, surgical: !!upd.surgical, sourceLines: para.lines?.length ?? null, committedLines: upd.lines?.length ?? null };
        if (committed.lines) row.lineRetention = committed.lines;
        if (lineLocal) row.lineLocal = lineLocal;
        pageReport.paragraphs.push(row);
        if (committed.lines?.status === "reflowed" && committed.lines.reason !== "line_count_changed") {
          report.warnings.push({ pageIndex, code: "source_lines_reflowed", paragraphIndex: pi, reason: committed.lines.reason, severity: "warning" });
        }
        touched.push({ id: publishedId ?? upd.id ?? para.id, index: pi, sourceBox: para.box, sourceLines: para.lines, sourceFormat: para.format });
      }
      if (reflow) {
        let r;
        // The paginate result is kept so its continuationStyle reaches the
        // page map even when the quality module does not forward it.
        let paginated = null;
        const repairOptions = pg.allow
          ? { paginate: (eng, ctx, grown, info) => (paginated = paginateOverflow(eng, ctx, grown, { ...info, maxNewPages: pg.max - added })) }
          : {};
        try {
          r = quality.repairPageLayout(engine, at, context, touched, repairOptions);
        } catch (err) {
          throw fail("REPAIR_FAILED", "Layout repair raised an error", { pageIndex, cause: err?.code ?? err?.name ?? "Error" });
        }
        report.repairs.push({ pageIndex, repairs: r?.repairs ?? [] });
        const pageWarnings = (r?.warnings ?? []).map((w) => ({ pageIndex, ...(w && typeof w === "object" ? w : { message: String(w) }) }));
        report.warnings.push(...pageWarnings);
        // severity:error is a definite repair failure; warning/info are reported only.
        const errors = pageWarnings.filter((w) => w.severity === "error");
        if (errors.length) {
          if (errors.some((w) => w.code === "pagination_budget_exceeded")) {
            throw fail("PAGINATION_LIMIT", `Edit on page ${pageIndex} needs more than the ${pg.max} allowed new page(s)`, { pageIndex, maxNewPages: pg.max });
          }
          const unsupported = errors.some((w) => /unsupported/.test(String(w.code)));
          throw fail(unsupported ? "LAYOUT_UNSUPPORTED" : "REPAIR_FAILED", `Layout repair reported ${errors.length} error(s) on page ${pageIndex}`, {
            pageIndex,
            codes: errors.map((w) => w.code),
          });
        }
        if (r?.pagination?.added > 0) {
          const style = r.pagination.continuationStyle ?? (paginated?.ok ? paginated.continuationStyle : undefined);
          continued.set(pageIndex, { ...r.pagination, continuationStyle: style });
          added += r.pagination.added;
        }
      }
      for (const p of plan.plans) if (!p.noop) editReport.get(p.edit.id).status = "applied";
    }

    if (mutated) {
      pdf = engine.save();
      if (!pdf || !pdf.length) throw fail("SAVE_FAILED", "Engine did not produce output bytes");
      pdf = new Uint8Array(pdf);
    } else {
      // Nothing to change: return the source bytes unchanged.
      pdf = new Uint8Array(sourceBytes);
    }
  } finally {
    try {
      engine?.close();
    } catch {}
    report.engineLog = logCapture.restore();
  }

  // Source page -> output pages. Downstream pages keep their content and
  // only shift by the continuation pages inserted before them.
  const sourcePageMap = [];
  for (let s = 0, out = 0; s < sourcePageCount; s++) {
    const c = continued.get(s);
    const n = c?.added ?? 0;
    const entry = { sourcePageIndex: s, outputPageIndex: out, continuationPageIndices: Array.from({ length: n }, (_, k) => out + 1 + k) };
    if (c) Object.assign(entry, { lineCounts: [...c.lineCounts], keptLines: c.keptLines, bodyTop: c.bodyTop, ...(c.flowTop !== undefined ? { flowTop: c.flowTop } : {}), floor: c.floor });
    if (c?.continuationStyle) entry.continuationStyle = { version: c.continuationStyle.version, policy: c.continuationStyle.policy, applied: c.continuationStyle.applied === true };
    sourcePageMap.push(entry);
    out += 1 + n;
  }
  report.pagination = {
    enabled: pg.allow,
    maxNewPages: pg.max,
    pages: { source: sourcePageCount, output: sourcePageCount + added },
    addedPages: added,
    sourcePageMap,
  };

  // Same-engine self-check on a freshly reopened copy.
  const qaCapture = captureConsole(!!options.includeEngineLog);
  let check;
  try {
    check = await quality.inspectSavedPdf(engineFactory, sourceBytes, pdf, edits, { sourcePageMap, includeText: !!options.includeFlowText });
  } catch (err) {
    report.selfCheck = { status: "error", error: err?.code ?? err?.name ?? "Error" };
    if (options.draft === true && readablePdf(pdf)) return finishDraft(report, pdf, sourceBytes, "SELF_CHECK_FAILED", "Saved-PDF self-check could not run");
    throw fail("SELF_CHECK_FAILED", "Saved-PDF self-check could not run");
  } finally {
    report.selfCheckLog = qaCapture.restore();
  }
  report.selfCheck = { status: check?.ok === true ? "passed" : "failed", ...check };
  report.pagination.flow = (check?.pages ?? [])
    .filter((row) => row.continuationPageIndices?.length)
    .map((row) => ({
      sourcePageIndex: row.pageIndex,
      outputPageIndices: [row.outputPageIndex, ...row.continuationPageIndices],
      bodyBand: row.body_band,
      expectedText: row.expected_text,
      outputParts: row.output_parts,
      measuredLines: (row.continuation ?? []).map((c) => c.lines),
      textEqual: row.text_equal === true,
    }));
  const unapplied = report.edits.filter((r) => r.status !== "applied" && r.status !== "noop");
  // Draft keeps the already-saved PDF when the self-check failed. Strict mode
  // still throws and drops those bytes. A passing check is unchanged.
  if (options.draft === true && check?.ok !== true && readablePdf(pdf)) {
    return finishDraft(report, pdf, sourceBytes, "SELF_CHECK_FAILED", "Saved-PDF self-check reported failures");
  }
  if (unapplied.length) throw fail("EDIT_NOT_APPLIED", "Some requested edits were not applied", { ids: unapplied.map((r) => r.id) });
  if (check?.ok !== true) throw fail("SELF_CHECK_FAILED", "Saved-PDF self-check reported failures");
  if (added > 0 && sourcePageMap.every((m) => !m.continuationPageIndices.length || m.continuationStyle?.applied === true)) {
    report.pagination.continuationStyle = { policy: "source-number-suffix", applied: true, copiedPages: added };
  }
  report.ok = true;
  report.status = "self-check-passed";
  return { pdf, report };
}

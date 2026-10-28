export function isolateColumns(engine, paragraphs, edits, plan) {
  const M = engine.M;
  const api = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_ClosePage", "_FPDFPage_RemoveObject", "_FPDFPage_InsertObjectAtIndex", "_FPDFPageObj_GetType"];
  if (plan.failures.length || api.some((k) => typeof M?.[k] !== "function") || ["objectCount","objectAt","objectBounds","paragraphObjects"].some(k=>typeof engine[k]!=="function")) return null;
  const tp = M._FPDFText_LoadPage(engine.page);
  if (!tp) return null;
  let chars = [];
  try {
    for (let i = 0, n = M._FPDFText_CountChars(tp); i < n; i++) chars.push({ ch: String.fromCodePoint(M._FPDFText_GetUnicode(tp, i) || 0), h: M._FPDFText_GetTextObject(tp, i) >>> 0 });
  } finally {
    M._FPDFText_ClosePage(tp);
  }
  let norm = "", map = [];
  for (let i = 0; i < chars.length; i++) {
    let j = i;
    if (/\s/.test(chars[i].ch)) while (j + 1 < chars.length && /\s/.test(chars[j + 1].ch)) j++;
    norm += /\s/.test(chars[i].ch) ? " " : chars[i].ch;
    for (let k = 0; k < (/\s/.test(chars[i].ch) ? 1 : chars[i].ch.length); k++) map.push([i, j]);
    i = j;
  }
  const selected = new Set();
  for (const edit of edits) {
    const needle = edit.before.replace(/\s+/g, " "), at = norm.indexOf(needle);
    if (!needle || at < 0 || norm.indexOf(needle, at + 1) >= 0) {
      return null;
    }
    for (const c of chars.slice(map[at][0], map[at + needle.length - 1][1] + 1)) if (!/\s/.test(c.ch)) {
      if (!c.h) return null;
      selected.add(c.h);
    }
  }
  const candidates = new Set(plan.plans.flatMap((p) => p.touched));
  const foreign = new Set();
  let side = null, gap = null, gapRight = null;
  for (const pi of candidates) {
    const objects = engine.paragraphObjects(paragraphs[pi].id).map((h) => ({ h: h >>> 0, b: engine.objectBounds(h) }));
    if (objects.some((o) => !o.b || !Number.isFinite(o.b.x) || !Number.isFinite(o.b.w))) return null;
    const sorted = objects.slice().sort((a, b) => a.b.x - b.b.x);
    let right = -Infinity, gaps = [];
    for (const o of sorted) {
      if (o.b.x - right >= 10) gaps.push([right, o.b.x]);
      right = Math.max(right, o.b.x + o.b.w);
    }
    if (!gaps.length) continue;
    for (const [a, b] of gaps) {
      if (!Number.isFinite(a)) continue;
      const chosen = objects.filter((o) => selected.has(o.h));
      if (!chosen.length) continue;
      const left = chosen.every((o) => o.b.x + o.b.w <= a + 0.01), rightSide = chosen.every((o) => o.b.x >= b - 0.01);
      if (!left && !rightSide) return null;
      const s = left ? "left" : "right";
      if (side && (side !== s || Math.abs(gap - a) > 10)) return null;
      side = s;
      gap = a;
      gapRight = b;
      for (const o of objects) if (left ? o.b.x >= b - 0.01 : o.b.x + o.b.w <= a + 0.01) foreign.add(o.h);
      break;
    }
  }
  if(foreign.size) for(let i=0;i<engine.objectCount();i++){const o=engine.objectAt(i);if(M._FPDFPageObj_GetType(o.handle)!==1)continue;const b=engine.objectBounds(o.handle);if(b && (side==="right"?b.x+b.w<=gap+0.01:b.x>=gapRight-0.01))foreign.add(o.handle>>>0);}
  if (!foreign.size) return null;
  for (const h of selected) {
    const b = engine.objectBounds(h);
    if (!b || (side === "left" ? b.x + b.w > gap + 0.01 : b.x < gapRight - 0.01)) return null;
  }
  const slots = [];
  for (let i = 0; i < engine.objectCount(); i++) {
    const o = engine.objectAt(i);
    if (o && foreign.has(o.handle >>> 0)) slots.push({ h: o.handle >>> 0, i });
  }
  if (slots.length !== foreign.size) return null;
  let detached = [];
  const restore = () => {
    let failed = false;
    const pending = [];
    for (const item of detached) {
      if (!M._FPDFPage_InsertObjectAtIndex(engine.page, item.h, item.i - pending.length)) {
        failed = true;
        pending.push(item);
      }
    }
    detached = pending;
    if (failed) throw new Error("column_isolation_restore_failed");
  };
  // A failed operation produces no PDF. Release only objects that are still
  // detached; restored objects remain owned by the page.
  restore.disposeDetached = () => {
    if (!detached.length) return;
    for (const item of detached) M._FPDFPageObj_Destroy(item.h);
    detached = [];
  };
  try {
    for (const item of slots) {
      if (!M._FPDFPage_RemoveObject(engine.page, item.h)) throw new Error("column_isolation_remove_failed");
      detached.push(item);
    }
  } catch (e) {
    try { restore(); } catch (restoreError) { restore.disposeDetached(); throw restoreError; }
    throw e;
  }
  return restore;
}


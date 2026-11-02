var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/paragraph-pdf-crypto.mjs
function rotr(x, n) {
  return (x >>> n | x << 32 - n) >>> 0;
}
function sha256(bytes2) {
  const bitLen = bytes2.length * 8, withPad = new Uint8Array(bytes2.length + 9 + 63 >> 6 << 6);
  withPad.set(bytes2);
  withPad[bytes2.length] = 128;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0, false);
  const H = Uint32Array.from([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const w = new Uint32Array(64);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ w[t - 15] >>> 3, s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ w[t - 2] >>> 10;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f ^ ~e >>> 0 & g) >>> 0, t1 = h + s1 + ch + K[t] + w[t] >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b ^ a & c ^ b & c) >>> 0, t2 = s0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] = H[0] + a >>> 0;
    H[1] = H[1] + b >>> 0;
    H[2] = H[2] + c >>> 0;
    H[3] = H[3] + d >>> 0;
    H[4] = H[4] + e >>> 0;
    H[5] = H[5] + f >>> 0;
    H[6] = H[6] + g >>> 0;
    H[7] = H[7] + h >>> 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return out;
}
function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error("Unsupported digest");
  const chunks = [];
  return { update(value) {
    chunks.push(typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
    return this;
  }, digest(format) {
    if (format !== "hex") throw new Error("Unsupported digest encoding");
    const bytes2 = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      bytes2.set(chunk, at);
      at += chunk.length;
    }
    return hex(bytes2);
  } };
}
var K, hex;
var init_paragraph_pdf_crypto = __esm({
  "src/paragraph-pdf-crypto.mjs"() {
    K = Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    hex = (bytes2) => Array.from(sha256(bytes2), (x) => x.toString(16).padStart(2, "0")).join("");
  }
});

// src/paragraph-vendor/engine/shadingsurgery.js
var PROBE_NEEDLES, probeMemo, probePdfBytes, latinMemo, latin, parsePdfMemo, parsePdf, parsePdfUncached, streamData, objStmIndex, objStmMemo, objStmIndexCached, withObjStm, dictAt;
var init_shadingsurgery = __esm({
  "src/paragraph-vendor/engine/shadingsurgery.js"() {
    PROBE_NEEDLES = [
      ["pattern", "/Pattern"],
      ["shading", "/Shading"],
      ["type3", "/Type3"],
      ["form", "/Form"],
      ["quartz", "Quartz PDFContext"],
      ["objStm", "/ObjStm"]
    ];
    probeMemo = /* @__PURE__ */ new WeakMap();
    probePdfBytes = (u8) => {
      const cached = probeMemo.get(u8);
      if (cached) return cached;
      const out = {
        pattern: false,
        shading: false,
        type3: false,
        form: false,
        quartz: false,
        objStm: false,
        contentsArray: false,
        subsetFont: false
      };
      const end = u8.length;
      const match = (at, text3) => {
        if (at + text3.length > end) return false;
        for (let j = 1; j < text3.length; j++) {
          if (u8[at + j] !== text3.charCodeAt(j)) return false;
        }
        return true;
      };
      const skipWs = (at) => {
        while (at < end && (u8[at] === 32 || u8[at] === 10 || u8[at] === 13 || u8[at] === 9))
          at++;
        return at;
      };
      for (let i = 0; i < end; i++) {
        const c = u8[i];
        if (c === 81) {
          if (!out.quartz && match(i, "Quartz PDFContext")) out.quartz = true;
          continue;
        }
        if (c !== 47) continue;
        for (const [key3, text3] of PROBE_NEEDLES) {
          if (!out[key3] && match(i, text3)) out[key3] = true;
        }
        if (!out.contentsArray && match(i, "/Contents")) {
          if (u8[skipWs(i + 9)] === 91) out.contentsArray = true;
        }
        if (!out.subsetFont && match(i, "/BaseFont")) {
          let k = skipWs(i + 9);
          if (u8[k] === 47) {
            k++;
            let upper = k + 6 <= end;
            for (let t = 0; upper && t < 6; t++) {
              if (u8[k + t] < 65 || u8[k + t] > 90) upper = false;
            }
            if (upper && u8[k + 6] === 43) out.subsetFont = true;
          }
        }
      }
      probeMemo.set(u8, out);
      return out;
    };
    latinMemo = /* @__PURE__ */ new WeakMap();
    latin = (u8) => {
      const hit = latinMemo.get(u8);
      if (hit) return hit;
      let s = "";
      for (let i = 0; i < u8.length; i += 32768) {
        s += String.fromCharCode.apply(
          null,
          u8.subarray(i, Math.min(i + 32768, u8.length))
        );
      }
      latinMemo.set(u8, s);
      return s;
    };
    parsePdfMemo = /* @__PURE__ */ new Map();
    parsePdf = (src) => {
      const hit = parsePdfMemo.get(src);
      if (hit !== void 0) return hit;
      const built = parsePdfUncached(src);
      if (parsePdfMemo.size > 4) parsePdfMemo.clear();
      parsePdfMemo.set(src, built);
      return built;
    };
    parsePdfUncached = (src) => {
      const objAt = /* @__PURE__ */ new Map();
      for (const m of src.matchAll(/(\d+)\s+0\s+obj\b/g)) {
        if (m.index > 0 && src[m.index - 1] >= "0" && src[m.index - 1] <= "9")
          continue;
        objAt.set(parseInt(m[1], 10), m.index);
      }
      const objBody = (num) => {
        const at = objAt.get(num);
        if (at == null) return null;
        const start = src.indexOf("obj", at) + 3;
        const end = src.indexOf("endobj", start);
        return end < 0 ? null : { start, end, body: src.slice(start, end) };
      };
      const dictRef = (body, key3) => {
        const m = body.match(new RegExp("/" + key3 + "\\s+(\\d+)\\s+\\d+\\s+R"));
        return m ? parseInt(m[1], 10) : -1;
      };
      let rootNum = -1;
      let size3 = -1;
      for (let tAt = src.length; rootNum < 0; ) {
        tAt = src.lastIndexOf("trailer", tAt - 1);
        if (tAt < 0) break;
        const trailer = src.slice(tAt, tAt + 400);
        if (rootNum < 0) rootNum = dictRef(trailer, "Root");
      }
      for (const m of src.matchAll(/\/Size\s+(\d+)/g))
        size3 = Math.max(size3, parseInt(m[1], 10));
      if (rootNum < 0) {
        const m = src.match(/\/Root\s+(\d+)\s+\d+\s+R/);
        if (m) rootNum = parseInt(m[1], 10);
      }
      if (rootNum < 0 || size3 < 0) return null;
      let pageList = null;
      const pageNum = (pageIndex) => {
        if (!pageList) {
          pageList = [];
          const root = objBody(rootNum);
          if (!root) return -1;
          const seen = /* @__PURE__ */ new Set();
          const walk = (num) => {
            if (seen.has(num) || pageList.length > 8192) return;
            seen.add(num);
            const o = objBody(num);
            if (!o) return;
            if (/\/Type\s*\/Page\b(?!s)/.test(o.body)) {
              pageList.push(num);
              return;
            }
            const kids = o.body.match(/\/Kids\s*\[([^\]]*)\]/);
            if (!kids) return;
            for (const r of kids[1].matchAll(/(\d+)\s+\d+\s+R/g))
              walk(parseInt(r[1], 10));
          };
          walk(dictRef(root.body, "Pages"));
        }
        return pageIndex < pageList.length ? pageList[pageIndex] : -1;
      };
      return { objBody, dictRef, rootNum, size: size3, pageNum };
    };
    streamData = async (bytes2, src, obj) => {
      const si = src.indexOf("stream", obj.start);
      if (si < 0 || si > obj.end) return null;
      let ds = si + 6;
      if (src[ds] === "\r") ds++;
      if (src[ds] === "\n") ds++;
      const indirect = obj.body.match(/\/Length\s+(\d+)\s+\d+\s+R/);
      let len = -1;
      if (indirect) {
        const rx = new RegExp(
          "(?:^|[^0-9])" + indirect[1] + "\\s+0\\s+obj\\s*(\\d+)"
        );
        const rm = src.match(rx);
        if (rm) len = parseInt(rm[1], 10);
      } else {
        const lm = obj.body.match(/\/Length\s+(\d+)/);
        if (lm) len = parseInt(lm[1], 10);
      }
      const de = len >= 0 ? ds + len : src.indexOf("endstream", ds);
      const raw = bytes2.subarray(ds, de);
      if (!/\/Filter\s*\/FlateDecode/.test(obj.body)) {
        return /\/Filter/.test(obj.body) ? null : latin(raw);
      }
      try {
        const stream2 = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"));
        const buf = new Uint8Array(await new Response(stream2).arrayBuffer());
        return latin(buf);
      } catch {
        return null;
      }
    };
    objStmIndex = async (bytes2, src) => {
      const out = /* @__PURE__ */ new Map();
      for (const m of src.matchAll(/(\d+)\s+0\s+obj\b/g)) {
        const start = src.indexOf("obj", m.index) + 3;
        const end = src.indexOf("endobj", start);
        if (end < 0) continue;
        const body = src.slice(start, end);
        if (!/\/Type\s*\/ObjStm/.test(body)) continue;
        const data = await streamData(bytes2, src, { start, end, body });
        if (!data) continue;
        const n = parseInt((body.match(/\/N\s+(\d+)/) || [])[1], 10);
        const first = parseInt((body.match(/\/First\s+(\d+)/) || [])[1], 10);
        if (!Number.isFinite(n) || !Number.isFinite(first)) continue;
        const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i < n; i++) {
          const num = nums[i * 2], off = nums[i * 2 + 1];
          if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
          const nextOff = i + 1 < n ? nums[i * 2 + 3] : data.length - first;
          out.set(
            num,
            data.slice(
              first + off,
              first + (Number.isFinite(nextOff) ? nextOff : data.length - first)
            )
          );
        }
      }
      return out;
    };
    objStmMemo = /* @__PURE__ */ new WeakMap();
    objStmIndexCached = async (bytes2, src) => {
      const hit = objStmMemo.get(bytes2);
      if (hit) return hit;
      const built = await objStmIndex(bytes2, src);
      objStmMemo.set(bytes2, built);
      return built;
    };
    withObjStm = async (bytes2, src, op) => {
      if (!op) return op;
      const idx = await objStmIndexCached(bytes2, src);
      if (!idx.size) return op;
      const base = op.objBody;
      const objBody = (num) => base(num) || (idx.has(num) ? { start: -1, end: -1, body: idx.get(num) } : null);
      const dictRef = op.dictRef;
      let pageList = null;
      const pageNum = (index) => {
        if (!pageList) {
          pageList = [];
          const root = objBody(op.rootNum);
          if (!root) return -1;
          const seen = /* @__PURE__ */ new Set();
          const walk = (num, depth) => {
            if (num < 0 || depth > 32 || seen.has(num) || pageList.length > 8192)
              return;
            seen.add(num);
            const o = objBody(num);
            if (!o) return;
            if (/\/Type\s*\/Page(?![sA-Za-z])/.test(o.body)) {
              pageList.push(num);
              return;
            }
            const kids = o.body.match(/\/Kids\s*\[([^\]]*)\]/);
            if (!kids) return;
            for (const km of kids[1].matchAll(/(\d+)\s+\d+\s+R/g))
              walk(parseInt(km[1], 10), depth + 1);
          };
          walk(dictRef(root.body, "Pages"), 0);
        }
        return index < pageList.length ? pageList[index] : -1;
      };
      return { ...op, objBody, pageNum };
    };
    dictAt = (body, at) => {
      const open = body.indexOf("<<", at);
      if (open < 0) return null;
      let depth = 0;
      for (let i = open; i < body.length - 1; i++) {
        if (body[i] === "<" && body[i + 1] === "<") {
          depth++;
          i++;
          continue;
        }
        if (body[i] === ">" && body[i + 1] === ">") {
          depth--;
          i++;
          if (!depth) return body.slice(open, i + 1);
        }
      }
      return null;
    };
  }
});

// src/paragraph-vendor/engine/streamsplice.js
var streamsplice_exports = {};
__export(streamsplice_exports, {
  applyPlan: () => applyPlan,
  spliceDeletion: () => spliceDeletion
});
function scanShowOperand(txt, at, len) {
  const body = txt.slice(at, at + len);
  const codes = [];
  const slots = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "<") {
      const end = body.indexOf(">", i);
      if (end < 0) return null;
      const rawHex = body.slice(i + 1, end);
      const hex4 = rawHex.replace(/\s+/g, "");
      if (hex4.length % 4 !== 0) return null;
      if (/\s/.test(rawHex)) return null;
      for (let k = 0; k < hex4.length; k += 4) {
        codes.push(parseInt(hex4.slice(k, k + 4), 16));
        slots.push({ at: at + i + 1 + k, len: 4, index: codes.length - 1 });
      }
      i = end + 1;
      continue;
    }
    if (ch === "(") {
      i++;
      let depth = 1;
      while (i < body.length) {
        const c = body[i];
        if (c === "\\") {
          const oct = body.slice(i + 1).match(/^[0-7]{1,3}/);
          const span = oct ? 1 + oct[0].length : 2;
          codes.push(
            oct ? parseInt(oct[0], 8) : ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1)
          );
          slots.push({ at: at + i, len: span, index: codes.length - 1 });
          i += span;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (!depth) {
            i++;
            break;
          }
        }
        codes.push(body.charCodeAt(i));
        slots.push({ at: at + i, len: 1, index: codes.length - 1 });
        i++;
      }
      if (depth) return null;
      continue;
    }
    i++;
  }
  return codes.length ? { codes, slots } : null;
}
function showOperators(txt) {
  const re = /\[(?:[^\][]|\\.)*\]\s*TJ|\((?:[^()\\]|\\.)*\)\s*Tj|<[0-9A-Fa-f\s]*>\s*Tj/g;
  return [...txt.matchAll(re)].map((m) => ({ at: m.index, len: m[0].length }));
}
function lastTmMatch(txt, at) {
  let last = null;
  for (const m of txt.slice(0, at).matchAll(TM_RE)) last = m;
  return last;
}
function tmBefore(txt, at) {
  const m = lastTmMatch(txt, at);
  return m ? m.slice(1, 7).map(Number) : null;
}
function activeSpacing(txt, at) {
  let tc = 0, tw = 0;
  for (const m of txt.slice(0, at).matchAll(/(-?[\d.]+)\s+(Tc|Tw)\b/g)) {
    if (m[2] === "Tc") tc = Number(m[1]);
    else tw = Number(m[1]);
  }
  return Math.abs(tc) > 1e-6 || Math.abs(tw) > 1e-6;
}
function buildTJ(op, wide) {
  const { after, pos, adv, size: size3 } = op;
  if (!after?.length || pos?.length !== after.length || adv?.length !== after.length)
    return null;
  if (!(size3 > 0)) return null;
  if (wide == null) wide = after.some((c) => c > 255);
  if (!wide && after.some((c) => c > 255)) return null;
  const hex4 = (c) => (wide ? c.toString(16).padStart(4, "0") : c.toString(16).padStart(2, "0")).toUpperCase();
  let out = "[";
  let run = "";
  let pen = pos[0];
  for (let i = 0; i < after.length; i++) {
    if (i > 0) {
      const kern = (pen - pos[i]) * 1e3 / size3;
      if (Math.abs(kern) > 1e-4) {
        if (run) {
          out += `<${run}>`;
          run = "";
        }
        out += fmt(kern);
      }
    }
    run += hex4(after[i]);
    pen = pos[i] + adv[i];
  }
  if (run) out += `<${run}>`;
  return out + "] TJ";
}
function inlineDict(body, key3) {
  const m = body.match(new RegExp(`/${key3}\\s*<<`));
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  for (let k = i; k < body.length - 1; k++) {
    if (body[k] === "<" && body[k + 1] === "<") {
      depth++;
      k++;
    } else if (body[k] === ">" && body[k + 1] === ">") {
      depth--;
      if (!depth) return { at: m.index, inner: body.slice(i, k), end: k + 2 };
      k++;
    }
  }
  return null;
}
function resolveFontNames(pdf, pageRec, pageNum, needed, std14Needed, startNum) {
  const resNum = pdf.dictRef(pageRec.body, "Resources");
  let resBody = null, resInline = null;
  if (resNum >= 0) resBody = pdf.objBody(resNum)?.body;
  else {
    resInline = inlineDict(pageRec.body, "Resources");
    resBody = resInline?.inner;
  }
  if (resBody == null) return null;
  const fontNum = pdf.dictRef(resBody, "Font");
  let fontBody = null, fontInline = null;
  if (fontNum >= 0) fontBody = pdf.objBody(fontNum)?.body;
  else {
    fontInline = inlineDict(resBody, "Font");
    fontBody = fontInline ? fontInline.inner : "";
  }
  if (fontBody == null) return null;
  const nameOf = /* @__PURE__ */ new Map();
  const std14NameOf = /* @__PURE__ */ new Map();
  const extraObjs = [];
  const used = /* @__PURE__ */ new Set();
  for (const m of fontBody.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+0\s+R/g)) {
    used.add(m[1]);
    if (!nameOf.has(+m[2])) nameOf.set(+m[2], m[1]);
  }
  let adds = "";
  let seq = 1;
  for (const num of needed) {
    if (!nameOf.has(num) && !pdf.objBody(num)) return null;
    if (nameOf.has(num)) continue;
    let nm;
    do {
      nm = `ECW${seq++}`;
    } while (used.has(nm));
    used.add(nm);
    nameOf.set(num, nm);
    adds += ` /${nm} ${num} 0 R`;
  }
  let free = startNum;
  for (const base of std14Needed || []) {
    if (!STD14.has(base)) return null;
    let nm;
    do {
      nm = `ECW${seq++}`;
    } while (used.has(nm));
    used.add(nm);
    const objn = free++;
    std14NameOf.set(base, nm);
    extraObjs.push({
      num: objn,
      body: `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`
    });
    adds += ` /${nm} ${objn} 0 R`;
  }
  const updates = [];
  if (adds) {
    if (fontNum >= 0) {
      const fb = pdf.objBody(fontNum).body.trim();
      if (!fb.endsWith(">>")) return null;
      updates.push({ num: fontNum, body: fb.slice(0, -2) + adds + " >>" });
    } else if (resNum >= 0) {
      const rb = pdf.objBody(resNum).body.trim();
      if (!rb.endsWith(">>")) return null;
      let nb;
      if (fontInline) {
        const inner2 = rb.slice(2, -2);
        const fi = inlineDict(inner2, "Font");
        if (!fi) return null;
        nb = "<<" + inner2.slice(0, fi.at) + `/Font <<${fi.inner}${adds} >>` + inner2.slice(fi.end) + ">>";
      } else {
        nb = rb.slice(0, -2) + ` /Font <<${adds} >> >>`;
      }
      updates.push({ num: resNum, body: nb });
    } else {
      const pb = pageRec.body;
      let nb;
      const fi = inlineDict(pb, "Font");
      if (fi) {
        nb = pb.slice(0, fi.at) + `/Font <<${fi.inner}${adds} >>` + pb.slice(fi.end);
      } else {
        const ri = inlineDict(pb, "Resources");
        if (!ri) return null;
        nb = pb.slice(0, ri.at) + `/Resources <<${ri.inner} /Font <<${adds} >> >>` + pb.slice(ri.end);
      }
      updates.push({ num: pageNum, body: nb.trim() });
    }
  }
  return { nameOf, std14NameOf, updates, extraObjs, nextFree: free };
}
function danglingCtm(txt) {
  let depth = 0;
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(?:^|[\s>\]])((?:-?[\d.]+\s+){6})cm\b|(?:^|[\s>\])])(q)\b|(?:^|[\s>\])])(Q)\b/g;
  for (const t of txt.matchAll(re)) {
    if (t[2]) depth++;
    else if (t[3]) depth = Math.max(0, depth - 1);
    else if (t[1] && depth === 0) {
      const v = t[1].trim().split(/\s+/).map(Number);
      if (v.length === 6 && v.every((x) => Number.isFinite(x))) {
        const [a, b, c, d, e, f] = v, [A, B, C, D, E, F] = m;
        m = [
          a * A + b * C,
          a * B + b * D,
          c * A + d * C,
          c * B + d * D,
          e * A + f * C + E,
          e * B + f * D + F
        ];
      }
    }
  }
  return m;
}
function invertMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det
  ];
}
function buildDrawBlock(drawOps, nameOf, std14NameOf, ctm) {
  let out = "";
  for (const op of drawOps) {
    if (op.kind === "rectdraw") {
      out += `${col(op.rgb)} rg
${fmt(op.x)} ${fmt(op.y)} ${fmt(op.w)} ${fmt(op.h)} re f
`;
      continue;
    }
    const name = op.std14 ? std14NameOf.get(op.std14) : nameOf.get(op.font);
    if (!name) return null;
    const tj = buildTJ(
      { after: op.codes, pos: op.pos, adv: op.adv, size: op.size },
      !!op.wide
    );
    if (tj == null) return null;
    out += `BT
${col(op.rgb)} rg
`;
    if (op.mode) out += `${op.mode} Tr
`;
    if (op.mode === 1 || op.mode === 2 || op.mode === 5 || op.mode === 6)
      out += `${col(op.srgb)} RG
${fmt(op.sw)} w
`;
    out += `/${name} ${fmt(op.size)} Tf
` + op.tm.map(fmt).join(" ") + " Tm\n" + tj + "\nET\n";
  }
  if (!out) return "";
  let pre = "";
  if (ctm && (Math.abs(ctm[0] - 1) > 1e-6 || Math.abs(ctm[1]) > 1e-6 || Math.abs(ctm[2]) > 1e-6 || Math.abs(ctm[3] - 1) > 1e-6 || Math.abs(ctm[4]) > 1e-6 || Math.abs(ctm[5]) > 1e-6)) {
    const inv = invertMatrix(ctm);
    if (!inv) return null;
    pre = inv.map(fmt).join(" ") + " cm\n";
  }
  return "q\n" + pre + out + "Q\n";
}
function fmt(v) {
  let s = v.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
function locate(txt, want, tm) {
  const hits2 = [];
  for (const op of showOperators(txt)) {
    const s = scanShowOperand(txt, op.at, op.len);
    if (!s || s.codes.length !== want.length) continue;
    if (!s.codes.every((c, i) => c === want[i])) continue;
    hits2.push({ op, scan: s, tm: tmBefore(txt, op.at) });
  }
  if (!hits2.length) return null;
  if (hits2.length === 1) return hits2[0];
  const near7 = hits2.filter(
    (h) => h.tm && tm && Math.abs(h.tm[4] - tm[4]) < 0.01 && Math.abs(h.tm[5] - tm[5]) < 0.01
  );
  return near7.length === 1 ? near7[0] : null;
}
async function findHolderStream(bytes2, src, pdf, pageRec, codes) {
  const resNum = pdf.dictRef(pageRec.body, "Resources");
  const resBody = resNum >= 0 ? pdf.objBody(resNum)?.body : pageRec.body.match(/\/Resources\s*<<([\s\S]*?)>>/)?.[1];
  if (!resBody) return null;
  const xoNum = pdf.dictRef(resBody, "XObject");
  const xoBody = xoNum >= 0 ? pdf.objBody(xoNum)?.body : resBody.match(/\/XObject\s*<<([\s\S]*?)>>/)?.[1];
  if (!xoBody) return null;
  for (const m of xoBody.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+0\s+R/g)) {
    const num = +m[2];
    const rec = pdf.objBody(num);
    if (!rec || !/\/Subtype\s*\/Form/.test(rec.body)) continue;
    const data = await streamData(bytes2, src, { num, ...rec });
    if (!data) continue;
    const text3 = typeof data === "string" ? data : latin(data);
    if (!locate(text3, codes, null)) continue;
    const refs = [...src.matchAll(new RegExp(`\\b${num}\\s+0\\s+R\\b`, "g"))].length;
    let pagesUsing = 0;
    if (resNum >= 0) {
      for (const pm of src.matchAll(/\/Type\s*\/Page\b/g)) {
        const start = src.lastIndexOf("obj", pm.index);
        const end = src.indexOf("endobj", pm.index);
        if (start < 0 || end < 0) continue;
        if (new RegExp(`/Resources\\s+${resNum}\\s+0\\s+R`).test(
          src.slice(start, end)
        ))
          pagesUsing++;
      }
    }
    return {
      num,
      rec,
      text: text3,
      name: m[1],
      xoNum,
      xoBody,
      resNum,
      shared: refs > 1 || pagesUsing > 1
    };
  }
  return null;
}
async function applyPlan(originalBytes, pageIndex, plan) {
  if (!plan || !plan.ops?.length || plan.kind !== "delete" && plan.kind !== "splice" && plan.kind !== "write")
    return null;
  const src = latin(originalBytes);
  if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(src)) return null;
  let pdf = parsePdf(src);
  if (!pdf) return null;
  pdf = await withObjStm(originalBytes, src, pdf);
  if (!pdf) return null;
  const pageNum = pdf.pageNum(pageIndex);
  if (pageNum == null || pageNum < 0) return null;
  const pageRec = pdf.objBody(pageNum);
  if (!pageRec) return null;
  const cm = pageRec.body.match(/\/Contents\s+(\d+)\s+0\s+R/);
  const cArr = pageRec.body.match(/\/Contents\s*\[([^\]]*)\]/);
  const isWritePlan = plan.ops.some(
    (o) => o.kind === "blank" || o.kind === "draw" || o.kind === "rectdraw"
  );
  let cNum, cRec, cow = null, txt;
  let emptyMembers = [];
  if (cm) {
    cNum = +cm[1];
    cRec = pdf.objBody(cNum);
    if (!cRec) return null;
    const raw = await streamData(originalBytes, src, { num: cNum, ...cRec });
    if (!raw) return null;
    txt = typeof raw === "string" ? raw : latin(raw);
  } else if (cArr && isWritePlan) {
    const refs = [...cArr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => +m[1]);
    if (!refs.length) return null;
    let concat = "";
    for (const n of refs) {
      const rec = pdf.objBody(n);
      if (!rec) return null;
      const raw = await streamData(originalBytes, src, { num: n, ...rec });
      if (raw == null) return null;
      concat += (concat ? "\n" : "") + (typeof raw === "string" ? raw : latin(raw));
    }
    cNum = refs[0];
    cRec = pdf.objBody(cNum);
    txt = concat;
    emptyMembers = refs.slice(1);
  } else {
    return null;
  }
  const firstCodes = plan.ops.find((o) => o.codes)?.codes;
  const isWrite = plan.ops.some(
    (o) => o.kind === "blank" || o.kind === "draw" || o.kind === "rectdraw"
  );
  if (!isWrite && firstCodes && !locate(txt, firstCodes, plan.ops[0].tm)) {
    const holder = await findHolderStream(
      originalBytes,
      src,
      pdf,
      pageRec,
      firstCodes
    );
    if (!holder) return null;
    ({ num: cNum, rec: cRec, text: txt } = holder);
    if (holder.shared) cow = { holder, pageNum, pageRec };
  }
  const edits = [];
  const drawOps = [];
  const blankOps = plan.ops.filter((o) => o.kind === "blank");
  if (blankOps.length) {
    const all = showOperators(txt).map((o) => ({
      ...o,
      scan: scanShowOperand(txt, o.at, o.len)
    }));
    const matches = (o, codes) => o.scan && o.scan.codes.length === codes.length && o.scan.codes.every((c, i) => c === codes[i]);
    const chainFrom = (start) => {
      const picks = [];
      let k = start;
      for (const op of blankOps) {
        while (k < all.length && !matches(all[k], op.codes)) k++;
        if (k >= all.length) return null;
        picks.push(all[k]);
        k++;
      }
      return picks;
    };
    let chain = null;
    for (let a = 0; a < all.length; a++) {
      if (!matches(all[a], blankOps[0].codes)) continue;
      const c = chainFrom(a);
      if (c) {
        if (chain) {
          chain = null;
          break;
        }
        chain = c;
        for (let a2 = a + 1; a2 < all.length; a2++) {
          if (!matches(all[a2], blankOps[0].codes)) continue;
          const c2 = chainFrom(a2);
          if (c2 && c2[0].at !== c[0].at && c2[0].at > c[c.length - 1].at) {
            chain = null;
          }
          break;
        }
        break;
      }
    }
    if (!chain) return null;
    for (const pick of chain)
      edits.push({ at: pick.at, len: pick.len, text: "[] TJ" });
  }
  for (const op of plan.ops) {
    if (op.kind === "blank") continue;
    if (op.kind === "draw" || op.kind === "rectdraw") {
      drawOps.push(op);
      continue;
    }
    const hit = locate(txt, op.codes, op.tm);
    if (!hit) return null;
    if (op.kind === "rebuild") {
      if (activeSpacing(txt, hit.op.at)) return null;
      const wide = hit.scan.slots.some((s2) => s2.len === 4);
      const arr = buildTJ(op, wide);
      if (arr == null) return null;
      edits.push({ at: hit.op.at, len: hit.op.len, text: arr });
      if (op.dx || op.dy) {
        const m = lastTmMatch(txt, hit.op.at);
        if (!m) return null;
        const e = Number(m[5]) + (op.dx || 0);
        const f = Number(m[6]) + (op.dy || 0);
        edits.push({
          at: m.index,
          len: m[0].length,
          text: `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${fmt(e)} ${fmt(f)} Tm`
        });
      }
      continue;
    }
    if (op.kind === "tm") {
      const m = lastTmMatch(txt, hit.op.at);
      if (!m) return null;
      const e = Number(m[5]) + (op.dx || 0);
      const f = Number(m[6]) + (op.dy || 0);
      const text3 = `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${fmt(e)} ${fmt(f)} Tm`;
      edits.push({ at: m.index, len: m[0].length, text: text3 });
      continue;
    }
    for (const idx of op.drop) {
      const slot = hit.scan.slots[idx];
      if (!slot) return null;
      edits.push({ at: slot.at, len: slot.len, text: "" });
    }
  }
  if (!edits.length && !drawOps.length) return null;
  const sorted = [...edits].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].at < sorted[i - 1].at + sorted[i - 1].len) return null;
  sorted.reverse();
  for (const e of sorted)
    txt = txt.slice(0, e.at) + e.text + txt.slice(e.at + e.len);
  let resourceUpdates = [];
  let extraFontObjs = [];
  if (drawOps.length) {
    if (cow) return null;
    const needed = new Set(
      drawOps.filter((o) => o.kind === "draw" && !o.std14).map((o) => o.font)
    );
    const std14Needed = new Set(
      drawOps.filter((o) => o.std14).map((o) => o.std14)
    );
    const res = resolveFontNames(
      pdf,
      pageRec,
      pageNum,
      needed,
      std14Needed,
      pdf.size
    );
    if (!res) return null;
    const block = buildDrawBlock(
      drawOps,
      res.nameOf,
      res.std14NameOf,
      danglingCtm(txt)
    );
    if (block == null) return null;
    txt += "\n" + block;
    resourceUpdates = res.updates;
    extraFontObjs = res.extraObjs || [];
  }
  for (const n of emptyMembers) {
    const rec = pdf.objBody(n);
    if (!rec) return null;
    const dict = rec.body.slice(0, rec.body.indexOf("stream")).replace(/\/Filter\s*\/\w+/g, "").replace(/\/Filter\s*\[[^\]]*\]/g, "").replace(/\/DecodeParms\s*<<[^>]*>>/g, "").replace(/\/Length\s+\d+(\s+\d+\s+R)?/g, "").replace(/>>\s*$/, "").replace(/^\s*<</, "");
    extraFontObjs.push({ num: n, stream: "", dict });
  }
  return rewriteStream(originalBytes, src, pdf, cNum, cRec, txt, cow, [
    ...resourceUpdates,
    ...extraFontObjs
  ]);
}
function xrefStyle(src) {
  const i = src.lastIndexOf("startxref");
  if (i < 0) return "classic";
  const m = src.slice(i).match(/startxref\s+(\d+)/);
  if (!m) return "classic";
  const at = +m[1];
  return /^\s*xref/.test(src.slice(at, at + 8)) ? "classic" : "stream";
}
function rewriteStream(originalBytes, src, pdf, num, rec, text3, cow, moreObjs) {
  let targetNum = num;
  const extra = [];
  let nextFree = Math.max(pdf.size, num + 1);
  for (const e of moreObjs || [])
    nextFree = Math.max(nextFree, (e.num || 0) + 1);
  if (cow) {
    const h = cow.holder;
    if (h.xoNum < 0 || h.resNum < 0) return null;
    targetNum = nextFree++;
    const newXo = nextFree++;
    const newRes = nextFree++;
    const xo = h.xoBody.replace(
      new RegExp(`(/${h.name}\\s+)\\d+(\\s+0\\s+R)`),
      `$1${targetNum}$2`
    );
    if (xo === h.xoBody) return null;
    extra.push({ num: newXo, body: `<<${xo}>>` });
    const resRec = pdf.objBody(h.resNum);
    if (!resRec) return null;
    const res = resRec.body.replace(
      new RegExp(`(/XObject\\s+)${h.xoNum}(\\s+0\\s+R)`),
      `$1${newXo}$2`
    );
    if (res === resRec.body) return null;
    extra.push({ num: newRes, body: res.trim() });
    const pageBody = cow.pageRec.body.replace(
      new RegExp(`(/Resources\\s+)${h.resNum}(\\s+0\\s+R)`),
      `$1${newRes}$2`
    );
    if (pageBody === cow.pageRec.body) return null;
    extra.push({ num: cow.pageNum, body: pageBody.trim() });
  }
  for (const e of moreObjs || []) extra.push(e);
  const out = bin(text3);
  const dict = rec.body.slice(0, rec.body.indexOf("stream"));
  let nd = dict.replace(/\/Filter\s*\/\w+/g, "").replace(/\/Filter\s*\[[^\]]*\]/g, "").replace(/\/DecodeParms\s*<<[^>]*>>/g, "").replace(/\/Length\s+\d+(\s+\d+\s+R)?/g, "");
  nd = nd.replace(/>>\s*$/, "").replace(/^\s*<</, "");
  const bytes2 = [];
  const push = (s2) => {
    for (const ch of bin(s2)) bytes2.push(ch);
  };
  const base = originalBytes.length;
  const offsets = /* @__PURE__ */ new Map();
  push("\n");
  offsets.set(targetNum, base + bytes2.length);
  push(`${targetNum} 0 obj
<<${nd} /Length ${out.length}>>
stream
`);
  for (const b2 of out) bytes2.push(b2);
  push("\nendstream\nendobj\n");
  for (const e of extra) {
    offsets.set(e.num, base + bytes2.length);
    if (e.stream !== void 0) {
      const sb = bin(e.stream);
      push(
        `${e.num} 0 obj
<<${e.dict || ""} /Length ${sb.length}>>
stream
`
      );
      for (const b2 of sb) bytes2.push(b2);
      push("\nendstream\nendobj\n");
    } else {
      push(`${e.num} 0 obj
${e.body}
endobj
`);
    }
  }
  const prev = prevStartXref(src);
  const style = xrefStyle(src);
  if (style === "classic") {
    const xrefAt = base + bytes2.length;
    const nums = [...offsets.keys()].sort((x, y) => x - y);
    push("xref\n0 1\n0000000000 65535 f \n");
    for (const n of nums)
      push(
        `${n} 1
` + String(offsets.get(n)).padStart(10, "0") + " 00000 n \n"
      );
    const size3 = Math.max(pdf.size, Math.max(...nums) + 1);
    push(
      `trailer
<< /Size ${size3} /Root ${pdf.rootNum} 0 R /Prev ${prev} >>
`
    );
    push(`startxref
${xrefAt}
%%EOF
`);
  } else {
    const xrefNum = nextFree++;
    const xrefAt = base + bytes2.length;
    offsets.set(xrefNum, xrefAt);
    const nums = [...offsets.keys()].sort((x, y) => x - y);
    const size3 = Math.max(pdf.size, Math.max(...nums) + 1);
    let index = "";
    const rows = [];
    for (const n of nums) {
      index += `${n} 1 `;
      const off = offsets.get(n);
      rows.push(
        1,
        off >>> 24 & 255,
        off >>> 16 & 255,
        off >>> 8 & 255,
        off & 255,
        0,
        0
      );
    }
    push(
      `${xrefNum} 0 obj
<< /Type /XRef /Size ${size3} /Index [ ${index}] /W [1 4 2] /Root ${pdf.rootNum} 0 R /Prev ${prev} /Length ${rows.length} >>
stream
`
    );
    for (const b2 of rows) bytes2.push(b2);
    push("\nendstream\nendobj\n");
    push(`startxref
${xrefAt}
%%EOF
`);
  }
  const res2 = new Uint8Array(base + bytes2.length);
  res2.set(originalBytes, 0);
  res2.set(Uint8Array.from(bytes2), base);
  return res2;
}
function prevStartXref(src) {
  const i = src.lastIndexOf("startxref");
  if (i < 0) return 0;
  const m = src.slice(i).match(/startxref\s+(\d+)/);
  return m ? +m[1] : 0;
}
var ESCAPES, TM_RE, col, STD14, spliceDeletion, bin;
var init_streamsplice = __esm({
  "src/paragraph-vendor/engine/streamsplice.js"() {
    init_shadingsurgery();
    ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    TM_RE = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
    col = (rgb) => rgb.map((v) => fmt(v / 255)).join(" ");
    STD14 = /* @__PURE__ */ new Set([
      "Helvetica",
      "Helvetica-Bold",
      "Helvetica-Oblique",
      "Helvetica-BoldOblique",
      "Courier",
      "Courier-Bold",
      "Courier-Oblique",
      "Courier-BoldOblique",
      "Times-Roman",
      "Times-Bold",
      "Times-Italic",
      "Times-BoldItalic",
      "Symbol",
      "ZapfDingbats"
    ]);
    spliceDeletion = applyPlan;
    bin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
  }
});

// src/paragraph-geometry-conservation.mjs
function userPartition(page) {
  const f = page?.frame, t = f?.transform;
  const matrices = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
  if (!Number.isInteger(f?.rotation) || !matrices[f.rotation] || !Array.isArray(t) || t.length !== 6 || t.some((x) => !valid(x))) return null;
  const upright = f.rotation === 0 && Math.abs(t[1]) <= 1e-6 && Math.abs(t[2]) <= 1e-6 && t[0] > 0 && t[3] > 0;
  if (!upright && matrices[f.rotation].some((x, i) => Math.abs(x - t[i]) > 1e-6)) return null;
  const [a, b, c, d, e, f0] = t, det = a * d - b * c;
  if (!valid(det) || det === 0) return null;
  const inverse = [d / det, -b / det, -c / det, a / det];
  if (!inverse.every(valid) || !valid(-inverse[0] * e - inverse[2] * f0) || !valid(-inverse[1] * e - inverse[3] * f0)) return null;
  const xs = [[0, 0], [page.W, 0], [0, page.H], [page.W, page.H]].map(([x, y]) => inverse[0] * (x - e) + inverse[2] * (y - f0));
  if (!xs.every(valid)) return null;
  const partition = Math.min(...xs) / 2 + Math.max(...xs) / 2;
  return valid(partition) ? partition : null;
}
function canonicalPage(page, partition = userPartition(page)) {
  if (!page || !Array.isArray(page.chars) || !Array.isArray(page.glyphs) || !valid(page.W) || !valid(page.H)) return fail("page_geometry_unavailable");
  if (userPartition(page) === null || !valid(partition)) return fail("unsupported_frame");
  const glyphs2 = /* @__PURE__ */ new Map();
  for (const g of page.glyphs) {
    if (!Number.isInteger(g.i) || g.i < 0 || g.i >= page.chars.length || glyphs2.has(g.i) || g.u !== page.chars[g.i].u || ![g.l, g.r, g.b, g.t, g.origin?.[0], g.origin?.[1]].every(valid) || g.r < g.l || g.t < g.b || !valid(size(g)) || size(g) <= 0) return fail("glyph_geometry_unavailable", g.i);
    glyphs2.set(g.i, g);
  }
  const lines2 = [];
  const ordered = [...glyphs2.values()].sort((a, b) => b.origin[1] - a.origin[1] || a.l - b.l || a.i - b.i);
  const channels = /* @__PURE__ */ new Map(), baselines = /* @__PURE__ */ new Map();
  for (const [order, g] of ordered.entries()) {
    const bucket = Math.floor(g.origin[1] / 0.5), candidates = /* @__PURE__ */ new Set([bucket - 1, bucket, bucket + 1]);
    let prior = null;
    for (const key3 of candidates) {
      const list4 = baselines.get(key3) ?? [];
      for (let j = list4.length - 1; j >= 0; j--) {
        const h = list4[j];
        if (prior && h.g.r < prior.g.r) break;
        if (h.g.l <= g.l && Math.abs(h.g.origin[1] - g.origin[1]) <= 0.5 && Math.abs(size(h.g) - size(g)) <= 0.2 && g.l - h.g.r <= size(g) * 2 && !(h.g.r < partition && g.l >= partition && g.l - h.g.r > size(g)) && (!prior || h.g.r > prior.g.r || h.g.r === prior.g.r && h.order < prior.order)) prior = h;
      }
    }
    channels.set(g.i, prior ? channels.get(prior.g.i) : g.l < partition ? 0 : 1);
    let list3 = baselines.get(bucket);
    if (!list3) baselines.set(bucket, list3 = []);
    let lo = 0, hi = list3.length;
    while (lo < hi) {
      const mid = lo + hi >> 1, h = list3[mid];
      if (h.g.r < g.r || h.g.r === g.r && h.order > order) lo = mid + 1;
      else hi = mid;
    }
    list3.splice(lo, 0, { g, order });
  }
  for (const g of ordered) {
    const channel = channels.get(g.i);
    const candidates = lines2.filter((l) => l.channel === channel && Math.abs(l.y - g.origin[1]) <= 0.5 && Math.abs(l.size - size(g)) <= 0.2);
    if (candidates.length > 1) return fail("ambiguous_baseline", g.i);
    let line = candidates[0];
    if (!line) lines2.push(line = { channel, y: g.origin[1], size: size(g), items: [], aliases: [] });
    line.items.push({ i: g.i, u: g.u, x: g.l, r: g.r, generated: false });
  }
  for (const line of [...lines2]) {
    const first = [...line.items].sort((a, b) => a.x - b.x)[0];
    const candidates = lines2.filter((l) => l !== line && l.channel === line.channel && l.size >= line.size * 1.2 && l.size <= line.size * 3 && l.y < line.y && line.y - l.y <= l.size * 0.8 && l.items.some((g) => g.r <= first.x + 1 && first.x - g.r <= l.size * 1.3));
    if (candidates.length > 1) return fail("ambiguous_marker", first.i);
    if (candidates.length === 1) {
      const owner = candidates[0];
      owner.items.push(...line.items);
      owner.aliases.push({ channel: line.channel, y: line.y, size: line.size, items: [...line.items] }, ...line.aliases);
      lines2.splice(lines2.indexOf(line), 1);
    }
  }
  lines2.sort((a, b) => a.channel - b.channel || b.y - a.y);
  for (const line of lines2) line.items.sort((a, b) => a.x - b.x || a.i - b.i);
  const ignored = [], boundaryWhitespace = [], normalizedDiscretionary = [];
  const itemLine = new Map(lines2.flatMap((line, n) => line.items.map((item) => [item.i, n])));
  const adjacentBreak = (i) => {
    let a = i - 1, b = i + 1;
    while (a >= 0 && !glyphs2.has(a) && isSpace(page.chars[a].u)) a--;
    while (b < page.chars.length && !glyphs2.has(b) && isSpace(page.chars[b].u)) b++;
    const left = glyphs2.get(a), right = glyphs2.get(b), li = itemLine.get(a), ri = itemLine.get(b);
    if (!left || !right || lines2[li].channel !== lines2[ri].channel || ri !== li + 1) return null;
    const last = [...lines2[li].items].sort((x, y) => x.x - y.x).at(-1), first = [...lines2[ri].items].sort((x, y) => x.x - y.x)[0];
    if (last?.i !== a || first?.i !== b) return null;
    return { a, b, li, ri };
  };
  const joins = /* @__PURE__ */ new Set(), literalBoundaries = /* @__PURE__ */ new Set();
  for (let i = 0; i < page.chars.length; i++) {
    const c = page.chars[i];
    if (glyphs2.has(i)) continue;
    if (!Number.isInteger(c.u)) return fail("invalid_character", i);
    if (c.u === 2 && c.discretionary === true) {
      const [x2, y2] = c.origin ?? [];
      const candidates2 = lines2.map((line2, li2) => ({ line: line2, li: li2 })).filter(({ line: line2, li: li2 }) => valid(x2) && valid(y2) && line2.channel === (x2 < partition ? 0 : 1) && Math.abs(line2.y - y2) <= 0.5 && li2 + 1 < lines2.length && lines2[li2 + 1].channel === line2.channel && line2.y - lines2[li2 + 1].y > 0 && line2.y - lines2[li2 + 1].y <= line2.size * 2 && Math.abs(line2.size - lines2[li2 + 1].size) <= 0.5);
      if (candidates2.length !== 1) return fail("discretionary_break_unproven", i);
      const { line, li } = candidates2[0];
      const last = [...line.items].sort((a, b2) => a.x - b2.x).at(-1);
      const first = [...lines2[li + 1].items].sort((a, b2) => a.x - b2.x)[0];
      let before2 = i - 1, after2 = i + 1;
      while (before2 >= 0 && isSpace(page.chars[before2].u)) before2--;
      while (after2 < page.chars.length && isSpace(page.chars[after2].u)) after2++;
      if (!last || !first || x2 < last.x || x2 - last.r > line.size || last.i !== before2 || first.i !== after2 || !/\p{L}/u.test(String.fromCharCode(last.u)) || !/\p{L}/u.test(String.fromCharCode(first.u))) return fail("discretionary_break_unproven", i);
      joins.add(li);
      normalizedDiscretionary.push(i);
      continue;
    }
    if (!isSpace(c.u)) return fail("nonspace_geometry_unavailable", i);
    if (c.generated === true) {
      const left = glyphs2.get(i - 1), right = glyphs2.get(i + 1);
      const li = itemLine.get(i - 1), ri = itemLine.get(i + 1);
      const [x2, y2] = c.origin ?? [];
      const line = lines2[li];
      if (c.u === 32 && left && right && li === ri && line && valid(x2) && valid(y2) && right.l - left.r > 0.01 && x2 >= left.r - 0.5 && x2 <= right.l + 0.5 && [line, ...line.aliases].some((b2) => Math.abs(b2.y - y2) <= 0.5)) {
        line.items.push({ i, u: 32, x: x2, r: x2, generated: true });
      } else {
        const a = glyphs2.get(i - 1), b2 = glyphs2.get(i + 1);
        const line2 = lines2[itemLine.get(i - 1)];
        let inserted = false;
        if (c.u === 32 && a?.obj && b2?.obj && a.obj !== b2.obj && line2 && itemLine.get(i - 1) === itemLine.get(i + 1)) {
          const items = [...line2.items].sort((p, q) => p.x - q.x);
          const boundaries = [];
          for (let k = 1; k < items.length; k++) {
            const l2 = glyphs2.get(items[k - 1].i), r2 = glyphs2.get(items[k].i);
            if (l2 && r2 && (l2.obj === a.obj && r2.obj === b2.obj || l2.obj === b2.obj && r2.obj === a.obj) && r2.l - l2.r > 0.01 && r2.l - l2.r <= line2.size) boundaries.push([l2, r2]);
          }
          if (boundaries.length === 1) {
            const [l2, r2] = boundaries[0], x3 = (l2.r + r2.l) / 2;
            line2.items.push({ i, u: 32, x: x3, r: x3, generated: true });
            inserted = true;
          }
        }
        if (!inserted) ignored.push(i);
      }
      continue;
    }
    const [l, r, b, t] = c.box ?? [];
    const [x, y] = c.origin ?? [];
    if (/[\r\n]/u.test(String.fromCharCode(c.u)) || ![l, r, b, t, x, y].every(valid)) {
      const br = adjacentBreak(i);
      if (!br || !/[\r\n]/u.test(String.fromCharCode(c.u))) return fail("literal_whitespace_geometry_unavailable", i);
      boundaryWhitespace.push(i);
      literalBoundaries.add(br.li);
      continue;
    }
    const neighbours = [glyphs2.get(i - 1), glyphs2.get(i + 1)].filter(Boolean);
    const channel = neighbours.length ? channels.get(neighbours[0].i) : x < partition ? 0 : 1;
    let before = i - 1, after = i + 1;
    while (before >= 0 && isSpace(page.chars[before].u)) before--;
    while (after < page.chars.length && isSpace(page.chars[after].u)) after++;
    const baselines2 = lines2.flatMap((line) => [line, ...line.aliases]).filter((baseline) => baseline.channel === channel && Math.abs(baseline.y - y) <= 0.5);
    if (baselines2.length > 1) return fail("literal_whitespace_line_ambiguous", i, { candidates: baselines2.length });
    const candidates = [];
    for (const line of lines2) {
      if (line.channel === channel && Math.abs(line.y - y) <= 0.5) candidates.push(line);
      for (const alias of line.aliases) {
        if (alias.channel !== channel || Math.abs(alias.y - y) > 0.5) continue;
        if (alias.items.some((item) => item.i === before && l >= item.x && l - item.r <= alias.size || item.i === after && r <= item.r && item.x - r <= alias.size)) candidates.push(line);
      }
    }
    if (candidates.length !== 1) return fail("literal_whitespace_line_ambiguous", i, { candidates: candidates.length });
    candidates[0].items.push({ i, u: c.u, x: l, r, generated: false });
  }
  const chars = [];
  for (let n = 0; n < lines2.length; n++) {
    const line = lines2[n];
    line.items.sort((a, b) => a.x - b.x || a.i - b.i);
    for (let k = 1; k < line.items.length; k++) if (Math.abs(line.items[k].x - line.items[k - 1].x) < 1e-6 && line.items[k].u !== line.items[k - 1].u) return fail("ambiguous_horizontal_order", line.items[k].i);
    if (n && (!joins.has(n - 1) || literalBoundaries.has(n - 1))) chars.push({ u: 32, generated: !literalBoundaries.has(n - 1), virtual: true });
    chars.push(...line.items);
  }
  const mapped = chars.filter((c) => !c.virtual).map((c) => c.i);
  const indices = mapped.concat(ignored, boundaryWhitespace, normalizedDiscretionary);
  if (indices.length !== page.chars.length || new Set(indices).size !== page.chars.length) return fail("index_coverage_incomplete");
  return { ok: true, chars, text: chars.map((c) => String.fromCharCode(c.u)).join(""), partition, evidence: { total: page.chars.length, mapped, generatedWhitespace: ignored, boundaryWhitespace, normalizedDiscretionary } };
}
function compareSourceGeometry(source2, output, edits, { expectedPageText: expectedPageText2, matchesGeneratedWhitespace: matchesGeneratedWhitespace2 } = {}) {
  if (typeof expectedPageText2 !== "function") return fail("expected_page_text_unavailable");
  if (source2?.W !== output?.W || source2?.H !== output?.H || JSON.stringify(source2?.frame) !== JSON.stringify(output?.frame)) return fail("frame_mismatch");
  const s = canonicalPage(source2), o = canonicalPage(output, s.partition);
  if (!s.ok) return { ...s, side: "source" };
  if (!o.ok) return { ...o, side: "output" };
  const expected = expectedPageText2(s.text, edits, { includeSpans: true });
  if (!expected.ok) return { ...expected, side: "source" };
  const actual = o.text.replace(/\s+/gu, " ").trim();
  const match = typeof matchesGeneratedWhitespace2 === "function" ? matchesGeneratedWhitespace2(expected.text, o.chars) : actual === expected.text;
  return { ok: true, match, expected: expected.text, actual, spans: expected.spans, sourceEvidence: s.evidence, outputEvidence: o.evidence };
}
var isSpace, valid, size, fail;
var init_paragraph_geometry_conservation = __esm({
  "src/paragraph-geometry-conservation.mjs"() {
    isSpace = (u) => /\s/u.test(String.fromCharCode(u));
    valid = (n) => Number.isFinite(n);
    size = (g) => g.style?.size * Math.hypot(g.style?.mat?.[2] ?? 0, g.style?.mat?.[3] ?? 1);
    fail = (reason, index, extra = {}) => ({ ok: false, reason, ...index === void 0 ? {} : { index }, ...extra });
  }
});

// src/table-vendor/detection.mjs
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function toCandidates(run) {
  if (run.locked) return [];
  if (!run.text || run.text.trim().length === 0) return [];
  const { x, y, width, height } = run.bounds;
  if (width <= 0 || height <= 0) return [];
  const lines2 = run.paragraphLineCount ?? 1;
  if (lines2 <= 1) {
    return [
      {
        run,
        left: x,
        right: x + width,
        cx: x + width / 2,
        cy: y + height / 2,
        height
      }
    ];
  }
  return expandParagraph(run, lines2);
}
function expandParagraph(run, lines2) {
  const baselines = run.paragraphBaselines;
  const lefts = run.paragraphLineLefts;
  const texts = run.text.split("\n");
  if (!baselines || baselines.length !== lines2 || texts.length < lines2)
    return [];
  const { x, y, width, height } = run.bounds;
  const descent = baselines[lines2 - 1] - y;
  const ascent = y + height - baselines[0];
  const lineHeight = ascent + descent;
  if (lineHeight <= 0) return [];
  const lengths = texts.slice(0, lines2).map((s) => s.trim().length);
  const maxLen = Math.max(...lengths, 1);
  const out = [];
  for (let i = 0; i < lines2; i++) {
    if (lengths[i] === 0) continue;
    const left = lefts?.[i] ?? x;
    const w = Math.max(1, width * lengths[i] / maxLen);
    const bottom = baselines[i] - descent;
    out.push({
      run,
      left,
      right: left + w,
      cx: left + w / 2,
      cy: bottom + lineHeight / 2,
      height: lineHeight
    });
  }
  return out;
}
function groupRows(cands, rowTol) {
  const sorted = [...cands].sort((a, b) => b.cy - a.cy);
  const rows = [];
  let current = [];
  let ref = 0;
  for (const c of sorted) {
    if (current.length === 0 || Math.abs(c.cy - ref) <= rowTol) {
      if (current.length === 0) ref = c.cy;
      current.push(c);
      ref += (c.cy - ref) / current.length;
    } else {
      rows.push(finishRow(current));
      current = [c];
      ref = c.cy;
    }
  }
  if (current.length > 0) rows.push(finishRow(current));
  return rows;
}
function finishRow(cands) {
  const ordered = [...cands].sort((a, b) => a.left - b.left);
  const tops = ordered.map((c) => c.cy + c.height / 2);
  const bottoms = ordered.map((c) => c.cy - c.height / 2);
  return {
    cands: ordered,
    cy: ordered.reduce((s, c) => s + c.cy, 0) / ordered.length,
    top: Math.max(...tops),
    bottom: Math.min(...bottoms)
  };
}
function columnBands(cands, minGap) {
  const intervals = cands.map((c) => ({ left: c.left, right: c.right })).sort((a, b) => a.left - b.left);
  const bands = [];
  for (const iv of intervals) {
    const last = bands[bands.length - 1];
    if (last && iv.left - last.right <= minGap) {
      last.right = Math.max(last.right, iv.right);
    } else {
      bands.push({ left: iv.left, right: iv.right });
    }
  }
  return bands;
}
function mergeAlignmentBands(bands, rows) {
  let merged = bands;
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length - 1; i++) {
      const together = rows.some((r) => {
        let a = false;
        let b = false;
        for (const c of r.cands) {
          const idx = bandIndex(merged, c.cx);
          if (idx === i) a = true;
          else if (idx === i + 1) b = true;
        }
        return a && b;
      });
      if (together) continue;
      merged = [
        ...merged.slice(0, i),
        { left: merged[i].left, right: merged[i + 1].right },
        ...merged.slice(i + 2)
      ];
      changed = true;
      break;
    }
  }
  return merged;
}
function ruleLines(rules, vertical) {
  const pieces = [];
  for (const r of rules) {
    if (r.width <= r.height !== vertical) continue;
    pieces.push(
      vertical ? { at: r.x + r.width / 2, from: r.y, to: r.y + r.height } : { at: r.y + r.height / 2, from: r.x, to: r.x + r.width }
    );
  }
  pieces.sort((a, b) => a.at - b.at || a.from - b.from);
  const out = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && Math.abs(piece.at - last.at) <= RULE_COLLINEAR_EPS && piece.from <= last.to + RULE_JOIN_GAP) {
      last.to = Math.max(last.to, piece.to);
      continue;
    }
    out.push({ ...piece });
  }
  return out;
}
function pinsAcross(lines2, lo, hi, minCover, atLo, atHi) {
  const span = hi - lo;
  if (span <= 0) return [];
  const hits2 = lines2.filter(
    (l) => (
      // Running the length of the table is not enough on its own: a second
      // table further down the page has rules just as wide, and taking those
      // in wrecks the grid. The line must sit within this table's extent too.
      l.at >= atLo - RULE_EDGE_MARGIN_PT && l.at <= atHi + RULE_EDGE_MARGIN_PT && (Math.min(l.to, hi) - Math.max(l.from, lo)) / span >= minCover
    )
  ).map((l) => l.at).sort((a, b) => a - b);
  const merged = [];
  for (const v of hits2) {
    if (merged.length > 0 && v - merged[merged.length - 1] < 0.75) continue;
    merged.push(v);
  }
  return merged;
}
function pinsSeparate(centres, pins) {
  if (pins.length !== centres.length + 1) return false;
  const sorted = [...centres].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= pins[i] || sorted[i] >= pins[i + 1]) return false;
  }
  return true;
}
function snapAxis(edges, pins, centres, tol) {
  if (pins.length === 0) return { edges, drawn: false };
  const descending = edges[0] > edges[edges.length - 1];
  if (pinsSeparate(centres, pins)) {
    return { edges: descending ? [...pins].reverse() : pins, drawn: true };
  }
  const snapped = edges.map((e) => {
    let best = e;
    let bestDist = tol;
    for (const p of pins) {
      const d = Math.abs(p - e);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  });
  for (let i = 1; i < snapped.length; i++) {
    const ordered = descending ? snapped[i] < snapped[i - 1] : snapped[i] > snapped[i - 1];
    if (!ordered) return { edges, drawn: false };
  }
  return { edges: snapped, drawn: false };
}
function rowPins(lines2, colEdges, lo, hi) {
  const cols = colEdges.length - 1;
  const margin = Math.max(
    RULE_EDGE_MARGIN_PT,
    (hi - lo) * PIN_EDGE_MARGIN_FRACTION
  );
  const out = [];
  for (const line of lines2) {
    if (line.at < lo - margin || line.at > hi + margin) continue;
    const covered = /* @__PURE__ */ new Set();
    for (let c = 0; c < cols; c++) {
      const width = colEdges[c + 1] - colEdges[c];
      if (width <= 0) continue;
      const overlap = Math.min(line.to, colEdges[c + 1]) - Math.max(line.from, colEdges[c]);
      if (overlap / width >= PIN_ROW_COVERAGE) covered.add(c);
    }
    if (covered.size === 0) continue;
    const near7 = out.find((p) => Math.abs(p.at - line.at) < 0.75);
    if (near7) {
      for (const c of covered) near7.cols.add(c);
    } else {
      out.push({ at: line.at, cols: covered });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
function clusterRowPins(pins) {
  if (pins.length < 2) return pins.length > 0 ? [pins] : [];
  const gaps = [];
  for (let i = 1; i < pins.length; i++) gaps.push(pins[i - 1].at - pins[i].at);
  const typical = median(gaps.filter((g) => g > 0));
  const limit = typical > 0 ? typical * ROW_GAP_TOLERANCE : Infinity;
  const out = [[pins[0]]];
  for (let i = 1; i < pins.length; i++) {
    if (pins[i - 1].at - pins[i].at > limit) out.push([]);
    out[out.length - 1].push(pins[i]);
  }
  return out;
}
function bandByRules(cands, pins) {
  if (pins.length < 3) return null;
  const rows = [];
  for (let i = 0; i < pins.length - 1; i++) {
    const hi = pins[i].at;
    const lo = pins[i + 1].at;
    const inBand2 = cands.filter((c) => c.cy <= hi && c.cy >= lo);
    rows.push({
      cands: [...inBand2].sort((a, b) => a.left - b.left),
      cy: (hi + lo) / 2,
      top: hi,
      bottom: lo
    });
  }
  return rows;
}
function columnPins(lines2, rows, atLo, atHi) {
  const margin = Math.max(
    RULE_EDGE_MARGIN_PT,
    (atHi - atLo) * PIN_EDGE_MARGIN_FRACTION
  );
  const out = [];
  for (const line of lines2) {
    if (line.at < atLo - margin) continue;
    if (line.at > atHi + margin) continue;
    const covered = /* @__PURE__ */ new Set();
    for (let r = 0; r < rows.length; r++) {
      const band = rows[r].top - rows[r].bottom;
      if (band <= 0) continue;
      const overlap = Math.min(line.to, rows[r].top) - Math.max(line.from, rows[r].bottom);
      if (overlap / band >= PIN_ROW_COVERAGE) covered.add(r);
    }
    if (covered.size === 0) continue;
    const near7 = out.find((p) => Math.abs(p.at - line.at) < 0.75);
    if (near7) {
      for (const r of covered) near7.rows.add(r);
    } else {
      out.push({ at: line.at, rows: covered });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
function rowSpans(pins, cols, row) {
  const out = [];
  let start = 0;
  for (let c = 1; c < cols; c++) {
    const pin = pins[c];
    if (pin && !pin.rows.has(row)) continue;
    out.push({ start, span: c - start });
    start = c;
  }
  out.push({ start, span: cols - start });
  return out;
}
function downSpan(pins, rows, row, start, span) {
  let reach = 1;
  while (row + reach < rows) {
    const pin = pins[row + reach];
    if (!pin) break;
    let dividesAll = true;
    for (let c = start; c < start + span; c++) {
      if (!pin.cols.has(c)) dividesAll = false;
    }
    if (dividesAll) break;
    reach++;
  }
  return reach;
}
function edgeIndex(edges, x) {
  const descending = edges[0] > edges[edges.length - 1];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = descending ? edges[i + 1] : edges[i];
    const hi = descending ? edges[i] : edges[i + 1];
    if (x >= lo && x <= hi) return i;
  }
  const firstMid = (edges[0] + edges[1]) / 2;
  return Math.abs(x - firstMid) <= Math.abs(x - edges[edges.length - 1]) ? 0 : edges.length - 2;
}
function bandIndex(bands, x) {
  for (let i = 0; i < bands.length; i++) {
    if (x >= bands[i].left && x <= bands[i].right) return i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const centre = (bands[i].left + bands[i].right) / 2;
    const d = Math.abs(centre - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
function trimEdgeRows(block) {
  let start = 0;
  let end = block.length;
  while (start < end && block[start].cands.length < 2) start++;
  while (end > start && block[end - 1].cands.length < 2) end--;
  return block.slice(start, end);
}
function splitBlocks(rows, minGap) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    gaps.push(rows[i - 1].bottom - rows[i].top);
  }
  const typical = median(gaps.filter((g) => g > 0));
  const maxGap = Math.max(minGap, typical * ROW_GAP_TOLERANCE);
  const blocks = [];
  let current = [];
  for (let i = 0; i < rows.length; i++) {
    if (current.length === 0) {
      current.push(rows[i]);
      continue;
    }
    const prev = current[current.length - 1];
    const gap = prev.bottom - rows[i].top;
    if (gap > maxGap) {
      blocks.push(current);
      current = [rows[i]];
    } else {
      current.push(rows[i]);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}
function ruledColumnBands(block, rules) {
  const cands = block.flatMap((row) => row.cands);
  if (cands.length === 0) return null;
  const pins = columnPins(
    ruleLines(rules, true),
    block,
    Math.min(...cands.map((c) => c.left)),
    Math.max(...cands.map((c) => c.right))
  );
  if (pins.length < 3) return null;
  const edges = pins.map((pin) => pin.at);
  const horizontal = rowPins(
    ruleLines(rules, false),
    edges,
    block[block.length - 1].bottom,
    block[0].top
  );
  const rows = [block[0].top, ...block.map((row) => row.bottom)];
  if (horizontal.length !== rows.length || horizontal.some((pin, i) => Math.abs(pin.at - rows[i]) > RULE_COLLINEAR_EPS))
    return null;
  const bands = edges.slice(0, -1).map((left, i) => ({
    left,
    right: edges[i + 1]
  }));
  if (bands.some(
    (band) => block.filter(
      (row) => row.cands.some((c) => c.cx > band.left && c.cx < band.right)
    ).length < 2
  ))
    return null;
  return bands;
}
function buildTable(block, bands, pageIndex, index, opts, rules, snapTol) {
  const cols = bands.length;
  const rows = block.length;
  if (rows < opts.minRows || cols < opts.minCols) return null;
  const colGaps = [];
  for (let i = 1; i < cols; i++)
    colGaps.push(bands[i].left - bands[i - 1].right);
  const colPad = Math.max(1, median(colGaps) / 2);
  const derivedCols = [bands[0].left - colPad];
  for (let i = 1; i < cols; i++) {
    derivedCols.push((bands[i - 1].right + bands[i].left) / 2);
  }
  derivedCols.push(bands[cols - 1].right + colPad);
  const rowGaps = [];
  for (let i = 1; i < rows; i++)
    rowGaps.push(block[i - 1].bottom - block[i].top);
  const rowPad = Math.max(1, median(rowGaps) / 2);
  const derivedRows = [block[0].top + rowPad];
  for (let i = 1; i < rows; i++) {
    derivedRows.push((block[i - 1].bottom + block[i].top) / 2);
  }
  derivedRows.push(block[rows - 1].bottom - rowPad);
  const pins = columnPins(
    ruleLines(rules, true),
    block,
    derivedCols[0],
    derivedCols[cols]
  );
  const snappedCols = snapAxis(
    derivedCols,
    pins.map((p) => p.at),
    bands.map((b) => (b.left + b.right) / 2),
    snapTol
  );
  const colEdges = snappedCols.edges;
  const snappedRows = snapAxis(
    derivedRows,
    pinsAcross(
      ruleLines(rules, false),
      colEdges[0],
      colEdges[cols],
      RULE_COVERAGE,
      derivedRows[rows],
      derivedRows[0]
    ),
    block.map((r) => r.cy),
    snapTol
  );
  const rowEdges = snappedRows.edges;
  const spannable = snappedCols.drawn && pins.length === cols + 1;
  const hPins = rowPins(
    ruleLines(rules, false),
    colEdges,
    rowEdges[rows],
    rowEdges[0]
  );
  const downMergeable = spannable && hPins.length === rows + 1;
  const byCol = block.map((row) => {
    const map = /* @__PURE__ */ new Map();
    for (const c of row.cands) {
      const col2 = edgeIndex(colEdges, c.cx);
      const list3 = map.get(col2) ?? [];
      list3.push(c.run.id);
      map.set(col2, list3);
    }
    return map;
  });
  const cells = [];
  const covered = /* @__PURE__ */ new Set();
  let occupiedCells = 0;
  for (let r = 0; r < rows; r++) {
    const spans = spannable ? rowSpans(pins, cols, r) : Array.from({ length: cols }, (_, col2) => ({ start: col2, span: 1 }));
    for (const { start, span } of spans) {
      if (covered.has(`${r},${start}`)) continue;
      const rowSpan = downMergeable ? downSpan(hPins, rows, r, start, span) : 1;
      const runIds = [];
      for (let rr = r; rr < r + rowSpan; rr++) {
        for (let col2 = start; col2 < start + span; col2++) {
          runIds.push(...byCol[rr]?.get(col2) ?? []);
        }
      }
      for (let rr = r; rr < r + rowSpan; rr++) {
        for (let cc = start; cc < start + span; cc++) {
          if (rr !== r || cc !== start) covered.add(`${rr},${cc}`);
        }
      }
      if (runIds.length > 0) occupiedCells++;
      cells.push({
        row: r,
        col: start,
        runIds,
        colSpan: span,
        rowSpan,
        rect: {
          x: colEdges[start],
          y: rowEdges[r + rowSpan],
          width: colEdges[start + span] - colEdges[start],
          height: rowEdges[r] - rowEdges[r + rowSpan]
        }
      });
    }
  }
  const fill = occupiedCells / cells.length;
  if (fill < 0.4) return null;
  const rowsWithMultipleCols = block.filter(
    (r) => new Set(r.cands.map((c) => edgeIndex(colEdges, c.cx))).size >= 2
  ).length;
  if (rowsWithMultipleCols < 2) return null;
  const bounds = {
    x: colEdges[0],
    y: rowEdges[rows],
    width: colEdges[cols] - colEdges[0],
    height: rowEdges[0] - rowEdges[rows]
  };
  const confidence = Math.min(
    1,
    0.5 * fill + 0.5 * (rowsWithMultipleCols / rows)
  );
  return {
    id: `p${pageIndex}-table-${index}`,
    pageIndex,
    rows,
    cols,
    colEdges,
    rowEdges,
    bounds,
    cells,
    confidence,
    synthetic: false,
    // Only adoption can tell: it needs the render modes behind the text.
    scanned: false,
    ruled: false,
    pageRuled: snappedCols.drawn && snappedRows.drawn,
    adopted: false,
    // Styles are read off the runs when the table is adopted for editing.
    columnStyles: [],
    headerStyle: null
  };
}
function detectTables(runs, pageIndex, options = {}, rules = []) {
  const opts = { ...DEFAULT_TABLE_OPTIONS, ...options };
  const cands = runs.flatMap(toCandidates);
  if (cands.length < opts.minRows * opts.minCols) return [];
  const medHeight = median(cands.map((c) => c.height)) || 1;
  const rowTol = medHeight * opts.rowTolFactor;
  const minColGap = Math.max(3, medHeight * opts.colTolFactor);
  const maxGap = medHeight * opts.maxRowGapFactor;
  const allPins = rowPins(
    ruleLines(rules, false),
    [
      Math.min(...cands.map((c) => c.left)),
      Math.max(...cands.map((c) => c.right))
    ],
    Math.min(...cands.map((c) => c.cy)),
    Math.max(...cands.map((c) => c.cy))
  );
  const blocks = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const group of clusterRowPins(allPins)) {
    if (group.length < 3) continue;
    const top = group[0].at;
    const bottom = group[group.length - 1].at;
    const inside = cands.filter((c) => c.cy <= top && c.cy >= bottom);
    if (inside.length < opts.minRows * opts.minCols) continue;
    const banded = bandByRules(inside, group);
    if (!banded) continue;
    blocks.push(banded);
    for (const c of inside) claimed.add(c);
  }
  const loose = cands.filter((c) => !claimed.has(c));
  if (loose.length > 0) {
    blocks.push(
      ...splitBlocks(
        groupRows(loose, rowTol).filter((r) => r.cands.length >= 1),
        maxGap
      )
    );
  }
  const tables = [];
  for (const raw of blocks) {
    const block = trimEdgeRows(raw);
    const multiRunRows = block.filter((r) => r.cands.length >= 2);
    if (multiRunRows.length < opts.minRows) continue;
    const bands = ruledColumnBands(block, rules) ?? mergeAlignmentBands(
      columnBands(
        multiRunRows.flatMap((r) => r.cands),
        minColGap
      ),
      block
    );
    const table = buildTable(
      block,
      bands,
      pageIndex,
      tables.length,
      opts,
      rules,
      Math.max(4, medHeight * 1.5)
    );
    if (table) tables.push(table);
  }
  return tables;
}
var RULE_COVERAGE, RULE_EDGE_MARGIN_PT, ROW_GAP_TOLERANCE, DEFAULT_TABLE_OPTIONS, RULE_COLLINEAR_EPS, RULE_JOIN_GAP, PIN_ROW_COVERAGE, PIN_EDGE_MARGIN_FRACTION;
var init_detection = __esm({
  "src/table-vendor/detection.mjs"() {
    RULE_COVERAGE = 0.5;
    RULE_EDGE_MARGIN_PT = 12;
    ROW_GAP_TOLERANCE = 2;
    DEFAULT_TABLE_OPTIONS = {
      rowTolFactor: 0.6,
      colTolFactor: 0.9,
      maxRowGapFactor: 2.5,
      minRows: 2,
      minCols: 2
    };
    RULE_COLLINEAR_EPS = 0.75;
    RULE_JOIN_GAP = 2;
    PIN_ROW_COVERAGE = 0.6;
    PIN_EDGE_MARGIN_FRACTION = 0.2;
  }
});

// src/table-vendor/model.mjs
var init_model = __esm({
  "src/table-vendor/model.mjs"() {
  }
});

// src/table-vendor/geometry.mjs
var init_geometry = __esm({
  "src/table-vendor/geometry.mjs"() {
  }
});

// src/table-adapter.mjs
function frozen(v) {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
}
async function digest(data) {
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function detectSourceTables({ sourceBytes, sourceSha256, revision, mupdf, readPages } = {}) {
  if (!(sourceBytes instanceof Uint8Array) || sourceBytes.byteLength > TABLE_LIMITS.maxBytes || sourceBytes.byteLength < 5) fail2("invalid-source");
  if (typeof revision !== "string" || !revision || revision.length > 200) fail2("invalid-revision");
  const bytes2 = sourceBytes.slice(), sha = await digest(bytes2);
  if (typeof sourceSha256 !== "string" || sha !== sourceSha256) fail2("stale-source");
  if (readPages !== void 0 && typeof readPages !== "function") fail2("invalid-reader");
  const pages = await (readPages ? readPages(bytes2) : readMuPdfTablePages(bytes2, mupdf));
  if (await digest(bytes2) !== sha) fail2("reader-mutated-source");
  if (!Array.isArray(pages) || !pages.length || pages.length > TABLE_LIMITS.maxPages) fail2("page-limit");
  const tables = [], pageModels = [];
  let charsTotal = 0;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (page.pageIndex !== p || !(page.width > 0 && page.height > 0) || ![page.width, page.height].every(Number.isFinite) || page.coordinateSpace !== "top-left-page") fail2("invalid-page");
    if (!Array.isArray(page.runs) || page.runs.length > TABLE_LIMITS.maxRuns || !Array.isArray(page.rules) || page.rules.length > TABLE_LIMITS.maxRules) fail2("snapshot-limit");
    const seen = /* @__PURE__ */ new Set(), runs = page.runs.map((r) => {
      if (typeof r.id !== "string" || !r.id || seen.has(r.id) || typeof r.text !== "string" || !boxOK(r.bbox) || !contains([0, 0, page.width, page.height], r.bbox, 0.1)) fail2("invalid-run");
      seen.add(r.id);
      charsTotal += r.text.length;
      if (charsTotal > TABLE_LIMITS.maxChars) fail2("character-limit");
      return { id: r.id, text: r.text, bbox: [...r.bbox], horizontal: r.horizontal !== false };
    });
    const rules = page.rules.map((r) => {
      if (!boxOK(r.bbox)) fail2("invalid-rule");
      return rect([r.bbox[0], page.height - r.bbox[3], r.bbox[2], page.height - r.bbox[1]]);
    });
    if (page.chars && (!Array.isArray(page.chars) || page.chars.length > TABLE_LIMITS.maxChars)) fail2("character-limit");
    const pm = { pageIndex: p, width: page.width, height: page.height, rotation: page.rotation, runs, chars: page.chars?.map((c) => ({ c: c.c, bbox: [...c.bbox], lineId: c.lineId })) ?? null };
    if (pm.chars && pm.chars.some((c) => typeof c.c !== "string" || !boxOK(c.bbox) || !Number.isInteger(c.lineId))) fail2("invalid-characters");
    pageModels.push(pm);
    if (page.rotation !== 0) continue;
    const candidates = detectTables(runs.map((r) => ({ id: r.id, text: r.text, bounds: rect([r.bbox[0], page.height - r.bbox[3], r.bbox[2], page.height - r.bbox[1]]), locked: !r.horizontal })), p, {}, rules);
    for (const table of candidates) {
      const numeric = table.cells.filter((c) => c.runIds.some((rid) => /^[\s$€£¥+−\-\d.,()%±:eE/]+$/.test(runs.find((r) => r.id === rid)?.text || "") && /\d/.test(runs.find((r) => r.id === rid)?.text || ""))).length;
      if (!table.pageRuled && (table.rows < 3 || numeric < 2)) continue;
      const bbox = publicBox(table.bounds, page.height), tableId = await id("tbl-", [sha, revision, p, bbox, table.rowEdges, table.colEdges]);
      const cells = [];
      for (const cell of table.cells) {
        const bbox2 = publicBox(cell.rect, page.height), cellId = await id("cell-", [sha, revision, p, tableId, cell.row, cell.col, bbox2, cell.runIds]);
        cells.push({ id: cellId, row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan, bbox: bbox2, runIds: [...cell.runIds] });
      }
      tables.push({ id: tableId, pageIndex: p, bbox, rows: table.rows, cols: table.cols, ruled: table.pageRuled, confidence: table.confidence, cells });
    }
  }
  const model = frozen({ schema: SCHEMA, authority: "structure-hint", sourceBinding: readPages ? "verified-bytes-reader-adapter" : "mupdf-source-read", sourceSha256: sha, revision, coordinateSpace: "top-left-page", tables, pages: pageModels });
  issued.add(model);
  return model;
}
function readMuPdfTablePages(bytes2, mupdf) {
  if (!mupdf?.Document || !mupdf?.Device) fail2("reader-unavailable");
  let doc;
  const pages = [];
  try {
    doc = mupdf.Document.openDocument(bytes2, "application/pdf").asPDF();
    if (!doc || doc.needsPassword()) fail2("unsupported-document");
    if (doc.countPages() > TABLE_LIMITS.maxPages) fail2("page-limit");
    for (let p = 0; p < doc.countPages(); p++) {
      const page = doc.loadPage(p), runs = [], chars = [], rules = [];
      let st, dev;
      try {
        const bounds = page.getBounds(), width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
        const object = page.getObject(), rotation = object.getInheritable("Rotate").asNumber() || 0;
        if (bounds[0] !== 0 || bounds[1] !== 0) fail2("unsupported-page-origin");
        let lineChars = [], horizontal = true, lineId = -1, lastY = null;
        const transform = page.getTransform();
        const finish = () => {
          if (!lineChars.length) return;
          let start = 0;
          for (let i = 1; i <= lineChars.length; i++) {
            const a = lineChars[i - 1], b = lineChars[i];
            if (!b || b.bbox[0] - a.bbox[2] > Math.max(3, a.size * 1.5)) {
              const group = lineChars.slice(start, i);
              while (group.length && !group[0].c.trim()) group.shift();
              while (group.length && !group.at(-1).c.trim()) group.pop();
              if (group.length) runs.push({ id: `p${p}-run${runs.length}`, text: group.map((c) => c.c).join(""), bbox: union(group.map((c) => c.bbox)), horizontal });
              start = i;
            }
          }
          lineChars = [];
        };
        st = page.toStructuredText("preserve-whitespace,preserve-images");
        st.walk({ beginLine(_b, wmode, direction) {
          finish();
          horizontal = wmode === 0 && Math.abs(direction[1]) < 0.01 && direction[0] > 0;
        }, onChar(c, origin, _font, size3, quad) {
          const bbox = [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]), Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
          const y = transform[1] * origin[0] + transform[3] * origin[1] + transform[5];
          if (lastY === null || Math.abs(y - lastY) > 1.25) {
            lineId++;
            lastY = y;
          }
          if (boxOK(bbox)) {
            const item = { c, bbox, lineId, size: size3 };
            chars.push(item);
            lineChars.push(item);
          }
          if (chars.length > TABLE_LIMITS.maxChars) fail2("character-limit");
        }, endLine() {
          finish();
        } });
        finish();
        dev = new mupdf.Device({ strokePath(path, stroke, ctm, _cs, _color, alpha) {
          if (alpha !== 1) return;
          let current = null, first = null;
          const point = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
          const segment = (next) => {
            if (current) {
              const dx = Math.abs(next[0] - current[0]), dy = Math.abs(next[1] - current[1]), t = Math.max(0.1, stroke.getLineWidth() * Math.hypot(ctm[0], ctm[1]));
              if (dx < 0.1 && dy > 2 || dy < 0.1 && dx > 2) rules.push({ bbox: [Math.min(current[0], next[0]) - t / 2, Math.min(current[1], next[1]) - t / 2, Math.max(current[0], next[0]) + t / 2, Math.max(current[1], next[1]) + t / 2] });
            }
            current = next;
            if (rules.length > TABLE_LIMITS.maxRules) fail2("rule-limit");
          };
          path.walk({ moveTo(x, y) {
            current = first = point(x, y);
          }, lineTo(x, y) {
            segment(point(x, y));
          }, curveTo() {
            current = null;
          }, closePath() {
            if (first) segment(first);
          } });
        } });
        page.run(dev, [1, 0, 0, 1, 0, 0]);
        dev.close();
        pages.push({ pageIndex: p, width, height, rotation, coordinateSpace: "top-left-page", runs, rules, chars });
      } finally {
        dev?.destroy();
        st?.destroy();
        page.destroy();
      }
    }
    return pages;
  } finally {
    doc?.destroy();
  }
}
var TABLE_LIMITS, SCHEMA, issued, TableAdapterError, fail2, boxOK, union, contains, id, rect, publicBox;
var init_table_adapter = __esm({
  "src/table-adapter.mjs"() {
    init_detection();
    init_model();
    init_geometry();
    TABLE_LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxPages: 200, maxRuns: 12e3, maxRules: 12e3, maxChars: 15e4, maxCellChars: 4e3 });
    SCHEMA = "falsify.source-tables.v1";
    issued = /* @__PURE__ */ new WeakSet();
    TableAdapterError = class extends Error {
      constructor(code) {
        super(code);
        this.name = "TableAdapterError";
        this.code = code;
      }
    };
    fail2 = (code) => {
      throw new TableAdapterError(code);
    };
    boxOK = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
    union = (bs) => [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
    contains = (outer, inner, tol = 0) => outer[0] - tol <= inner[0] && outer[1] - tol <= inner[1] && outer[2] + tol >= inner[2] && outer[3] + tol >= inner[3];
    id = async (prefix, value) => prefix + (await digest(new TextEncoder().encode(JSON.stringify(value)))).slice(0, 24);
    rect = (b) => ({ x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] });
    publicBox = (r, h) => [r.x, h - r.y - r.height, r.x + r.width, h - r.y];
  }
});

// src/paragraph-source-tables.mjs
async function deriveSourceTables(bytes2, sha, mupdf) {
  const model = await detectSourceTables({ sourceBytes: bytes2, sourceSha256: sha, revision: "paragraph-source", mupdf });
  return {
    sha,
    pages: model.pages.map((p) => ({ width: p.width, height: p.height, rotation: p.rotation })),
    cells: model.tables.filter((t) => t.ruled).flatMap((t) => t.cells.map((c) => ({ pageIndex: t.pageIndex, bbox: [...c.bbox] })))
  };
}
function bindSourceTables(engine, bytes2, provenance) {
  bindings.delete(engine);
  if (bytes2 instanceof Uint8Array && provenance && hex(bytes2) === provenance.sha) bindings.set(engine, provenance);
}
function sourceTableCells(engine) {
  const proof = bindings.get(engine);
  if (!proof) return null;
  if (proof.unavailable || typeof engine.M._FPDF_GetPageCount !== "function" || engine.M._FPDF_GetPageCount(engine.doc) !== proof.pages.length) return null;
  const page = proof.pages[engine.pageIndex];
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  if (!page || page.rotation !== 0 || typeof engine.M._FPDFPage_GetRotation !== "function" || engine.M._FPDFPage_GetRotation(engine.page) !== 0 || t.length !== 6 || t.some((v, i) => !Number.isFinite(v) || Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-4) || Math.abs(engine.pageWidth - page.width) > 0.01 || Math.abs(engine.pageHeight - page.height) > 0.01) return null;
  return proof.cells.filter((c) => c.pageIndex === engine.pageIndex).map(({ bbox: [l, top, r, bottom] }) => ({ l, r, b: page.height - bottom, t: page.height - top }));
}
var bindings, inSourceTableCell;
var init_paragraph_source_tables = __esm({
  "src/paragraph-source-tables.mjs"() {
    init_table_adapter();
    init_paragraph_pdf_crypto();
    bindings = /* @__PURE__ */ new WeakMap();
    inSourceTableCell = (b, cells) => cells.some((c) => b.l >= c.l - 0.1 && b.r <= c.r + 0.1 && b.b >= c.b - 0.1 && b.t <= c.t + 0.1);
  }
});

// src/paragraph-vendor/continuation-template.mjs
function classifyEdgeText(text3) {
  const t = String(text3).trim();
  if (/^\d+$/.test(t)) return "page_number";
  if (t && (NUMBER_LIKE.test(t) || LABELLED_NUMBER.test(t))) return "number_unsupported";
  return "running";
}
function resolvePageFraction(items) {
  const nums = items.filter((i) => /^\d+$/.test(i.text.trim()));
  const slash = items.filter((i) => i.text.trim() === "/");
  if (slash.length !== 1) return null;
  const d = slash[0];
  const a = nums.filter((n) => n.bounds.r <= d.bounds.l + 0.5).sort((a2, b2) => b2.bounds.r - a2.bounds.r)[0];
  const b = nums.filter((n) => n.bounds.l >= d.bounds.r - 0.5).sort((a2, b2) => a2.bounds.l - b2.bounds.l)[0];
  if (!a || !b) return null;
  const baseline = (i) => i.chars?.[0]?.oy;
  if (![a, b, d].every((i) => Number.isFinite(baseline(i))) || Math.abs(baseline(a) - baseline(b)) > 0.5 || Math.abs(baseline(a) - baseline(d)) > 0.5) return null;
  if (!(a.bounds.r <= d.bounds.l + 0.5 && d.bounds.r <= b.bounds.l + 0.5)) return null;
  const size3 = a.bounds.t - a.bounds.b;
  if (!(size3 > 0) || d.bounds.l - a.bounds.r > size3 || b.bounds.l - d.bounds.r > size3 || +a.text > +b.text || +a.text < 1) return null;
  const fixedNumbers = /* @__PURE__ */ new Set([b]);
  const row = items.filter((i) => Math.abs(baseline(i) - baseline(a)) <= 0.5).sort((a2, b2) => a2.bounds.l - b2.bounds.l);
  for (let k = 2; k < row.length; k++) {
    if (/^(19|20)\d{2}$/.test(row[k].text.trim()) && /^\d{1,2},$/.test(row[k - 1].text.trim()) && /^(January|February|March|April|May|June|July|August|September|October|November|December)$/.test(row[k - 2].text.trim()) && row[k].bounds.r < a.bounds.l) fixedNumbers.add(row[k]);
  }
  return { numerator: a, denominator: b, fixedNumbers };
}
function continuationNumberText(source2, ordinal) {
  const t = String(source2).trim();
  if (!/^\d+$/.test(t) || !Number.isInteger(ordinal) || ordinal < 1) return null;
  return t + "." + ordinal;
}
function suffixedText(text3, ordinal) {
  const m = /^(\s*)(\d+)(\s*)$/.exec(text3);
  const n = m && continuationNumberText(m[2], ordinal);
  return n ? m[1] + n + m[3] : null;
}
function anchorOf(bounds, pageW) {
  const c = (bounds.l + bounds.r) / 2;
  if (Math.abs(c - pageW / 2) <= CENTER_TOL) return { anchor: "center", x: c };
  if (c > pageW / 2) return { anchor: "right", x: bounds.r };
  return { anchor: "left", x: bounds.l };
}
function anchorX(anchor, b) {
  return anchor === "center" ? (b.l + b.r) / 2 : anchor === "right" ? b.r : b.l;
}
function inkExtents(chars) {
  const ink = chars.filter((c) => c.u > 32 && c.u !== 160 && c.ll !== null && c.ll !== void 0);
  if (!ink.length) return null;
  return { l: Math.min(...ink.map((c) => c.ll)), r: Math.max(...ink.map((c) => c.lr)) };
}
function objectBox(M, h) {
  const p = M._malloc(16);
  try {
    if (!M._FPDFPageObj_GetBounds(h, p, p + 4, p + 8, p + 12)) return null;
    const f = (k) => M.HEAPF32[(p >> 2) + k];
    return { l: f(0), b: f(1), r: f(2), t: f(3) };
  } finally {
    M._free(p);
  }
}
function readMatrix(M, h) {
  const p = M._malloc(24);
  try {
    if (!M._FPDFPageObj_GetMatrix(h, p)) return null;
    return [0, 1, 2, 3, 4, 5].map((k) => M.HEAPF32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}
function writeMatrix(M, h, m) {
  const p = M._malloc(24);
  try {
    m.forEach((v, k) => M.HEAPF32[(p >> 2) + k] = v);
    return !!M._FPDFPageObj_SetMatrix(h, p);
  } finally {
    M._free(p);
  }
}
function readColor(M, fn, h) {
  const p = M._malloc(16);
  try {
    if (!M[fn](h, p, p + 4, p + 8, p + 12)) return null;
    return [0, 1, 2, 3].map((k) => M.HEAPU32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}
function readFloat(M, fn, ...args) {
  const p = M._malloc(4);
  try {
    return M[fn](...args, p) ? M.HEAPF32[p >> 2] : null;
  } finally {
    M._free(p);
  }
}
function readFontString(M, fn, font) {
  const n = M[fn](font, 0, 0);
  if (!n || n > 4096) return "";
  const p = M._malloc(n);
  try {
    M[fn](font, p, n);
    return M.UTF8ToString(p, n).replace(/\0+$/, "");
  } finally {
    M._free(p);
  }
}
function fontInfo(M, font) {
  const p = M._malloc(4);
  let italicAngle = null;
  try {
    if (M._FPDFFont_GetItalicAngle(font, p)) italicAngle = M.HEAP32[p >> 2];
  } finally {
    M._free(p);
  }
  return {
    baseName: readFontString(M, "_FPDFFont_GetBaseFontName", font),
    family: readFontString(M, "_FPDFFont_GetFamilyName", font),
    weight: M._FPDFFont_GetWeight(font),
    italicAngle,
    flags: M._FPDFFont_GetFlags(font),
    embedded: !!M._FPDFFont_GetIsEmbedded(font)
  };
}
function charsByObject(M, page) {
  const tp = M._FPDFText_LoadPage(page);
  const out = /* @__PURE__ */ new Map();
  if (!tp) return out;
  const b = M._malloc(32);
  try {
    const n = M._FPDFText_CountChars(tp);
    for (let i = 0; i < n; i++) {
      if (M._FPDFText_IsGenerated(tp, i) === 1) continue;
      const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
      if (!h) continue;
      const c = { u: M._FPDFText_GetUnicode(tp, i), ox: null, oy: null, l: null, b: null, r: null, t: null, ll: null, lr: null };
      if (M._FPDFText_GetCharOrigin(tp, i, b, b + 8)) {
        c.ox = M.HEAPF64[b >> 3];
        c.oy = M.HEAPF64[b + 8 >> 3];
      }
      if (M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) {
        c.l = M.HEAPF64[b >> 3];
        c.r = M.HEAPF64[b + 8 >> 3];
        c.b = M.HEAPF64[b + 16 >> 3];
        c.t = M.HEAPF64[b + 24 >> 3];
      }
      if (M._FPDFText_GetLooseCharBox(tp, i, b)) {
        c.ll = M.HEAPF32[b >> 2];
        c.lr = M.HEAPF32[(b >> 2) + 2];
      }
      if (!out.has(h)) out.set(h, []);
      out.get(h).push(c);
    }
  } finally {
    M._free(b);
    M._FPDFText_ClosePage(tp);
  }
  return out;
}
function toTextSpace(m, x, y) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (d * (x - e) - c * (y - f)) / det, y: (-b * (x - e) + a * (y - f)) / det };
}
function glyphAvailable(M, font, size3, u) {
  const w = readFloat(M, "_FPDFFont_GetGlyphWidth", font, u, size3);
  if (!(w > 0)) return false;
  const path = M._FPDFFont_GetGlyphPath(font, u, size3);
  return !!path && M._FPDFGlyphPath_CountGlyphSegments(path) > 0;
}
function snapshotPageEdges(engine, floor, bodyTop, exclude = null, selection = null) {
  const M = engine.M;
  const fail8 = (code, extra = {}) => ({ ok: false, code, items: [], ...extra });
  if (!(Number.isFinite(floor) && Number.isFinite(bodyTop) && bodyTop > floor)) return fail8("continuation_edge_band_invalid");
  const page = engine.page;
  const pageW = M._FPDF_GetPageWidthF(page), pageH = M._FPDF_GetPageHeightF(page);
  const lo = floor - 0.5, hi = bodyTop + 0.5;
  const n = M._FPDFPage_CountObjects(page);
  const tables = selection ? [] : sourceTableCells(engine);
  if (tables === null) return fail8("continuation_table_source_unavailable");
  const order = /* @__PURE__ */ new Map();
  const edges = [];
  for (let i = 0; i < n; i++) {
    const h = M._FPDFPage_GetObject(page, i) >>> 0;
    order.set(h, i);
    if (selection && !selection.has(h)) continue;
    if (exclude?.has(h)) continue;
    const bx = objectBox(M, h);
    if (!bx) continue;
    if (M._FPDFPageObj_GetType(h) === OBJ_TEXT && inSourceTableCell(bx, tables)) continue;
    const cy = (bx.b + bx.t) / 2;
    if (!selection && cy >= lo && cy <= hi) continue;
    edges.push({ h, index: i, bounds: bx, band: cy > hi ? "top" : "bottom" });
  }
  const chars = charsByObject(M, page);
  const items = [];
  let skipped = 0;
  let fixedGraphics = 0;
  for (const e of edges) {
    const at = { index: e.index };
    if (M._FPDFPageObj_GetType(e.h) !== OBJ_TEXT) {
      const b = e.bounds;
      if (!(b.t <= pageH * 0.1 && b.t < floor || b.b >= pageH * 0.9 && b.b > bodyTop)) return fail8("continuation_edge_graphics_unsupported", at);
      fixedGraphics++;
      continue;
    }
    if (typeof M._FPDFPageObj_GetClipPath === "function" && typeof M._FPDFClipPath_CountPaths === "function") {
      const clip = M._FPDFPageObj_GetClipPath(e.h);
      if (clip && M._FPDFClipPath_CountPaths(clip) > 0) return fail8("continuation_edge_clip_unsupported", at);
    }
    const cs = chars.get(e.h) || [];
    const text3 = textOf(cs);
    if (!text3.trim()) {
      skipped++;
      continue;
    }
    const role = selection ? "running" : classifyEdgeText(text3);
    if (role === "number_unsupported") return fail8("continuation_page_number_unsupported", at);
    const font = M._FPDFTextObj_GetFont(e.h);
    const size3 = readFloat(M, "_FPDFTextObj_GetFontSize", e.h);
    const matrix = readMatrix(M, e.h);
    if (!font || !(size3 > 0) || !matrix) return fail8("continuation_edge_text_layout_unsupported", at);
    if (cs.some((c) => c.ox === null || c.l === null)) return fail8("continuation_edge_text_layout_unsupported", at);
    const ts = cs.map((c) => toTextSpace(matrix, c.ox, c.oy));
    if (ts.some((p) => !p || Math.abs(p.y - ts[0].y) > 0.01)) return fail8("continuation_edge_text_layout_unsupported", at);
    const fill = readColor(M, "_FPDFPageObj_GetFillColor", e.h);
    const stroke = readColor(M, "_FPDFPageObj_GetStrokeColor", e.h);
    if (M._FPDFPageObj_HasTransparency(e.h) && (!fill || fill[3] === 255) && (!stroke || stroke[3] === 255)) {
      return fail8("continuation_edge_style_unsupported", at);
    }
    if (role === "page_number") {
      for (let k = 1; k < cs.length; k++) {
        const w = readFloat(M, "_FPDFFont_GetGlyphWidth", font, cs[k - 1].u, size3);
        if (w === null || Math.abs(ts[k].x - ts[k - 1].x - w) > POS_TOL) return fail8("continuation_page_number_spacing_unsupported", at);
      }
    }
    const item = {
      index: e.index,
      role,
      band: e.band,
      text: text3,
      bounds: e.bounds,
      chars: cs.map(({ u, ox, oy, l, b, r, t, ll, lr }) => ({ u, ox, oy, l, b, r, t, ll, lr })),
      style: {
        font: fontInfo(M, font),
        size: size3,
        matrix,
        fill,
        stroke,
        strokeWidth: readFloat(M, "_FPDFPageObj_GetStrokeWidth", e.h),
        renderMode: M._FPDFTextObj_GetTextRenderMode(e.h)
      },
      anchor: role === "page_number" ? anchorOf(inkExtents(cs), pageW) : null
    };
    Object.defineProperty(item, "h", { value: e.h });
    Object.defineProperty(item, "textX", { value: ts.map((p) => p.x) });
    Object.defineProperty(item, "textY", { value: ts[0].y });
    items.push(item);
  }
  const fraction = resolvePageFraction(items);
  if (fraction) for (const item of items) {
    if (item.role === "page_number" && fraction.fixedNumbers.has(item)) item.role = "running";
  }
  const numbers2 = new Set(items.filter((i) => i.role === "page_number").map((i) => i.text.trim()));
  if (numbers2.size > 1) return fail8("continuation_page_number_ambiguous");
  const snap = { ok: true, code: null, version: CONTINUATION_STYLE.version, pageW, pageH, floor, bodyTop, skipped, fixedGraphics, items };
  Object.defineProperty(snap, "order", { value: order });
  return snap;
}
function snapshotTextObjects(engine, handles) {
  const selected = new Set(handles.map((h) => h >>> 0));
  const snapshot = snapshotPageEdges(engine, 0, engine.pageHeight, null, selected);
  if (!snapshot.ok) return snapshot;
  if (snapshot.fixedGraphics || snapshot.skipped || snapshot.items.length !== selected.size) return { ok: false, code: "document_flow_text_snapshot_incomplete" };
  if (snapshot.items.some((it) => {
    const [a, b, c, d] = it.style.matrix;
    return !(a > 0 && d > 0 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6) || ![0, 1, 2].includes(it.style.renderMode) || it.chars.some((c2) => c2.u <= 0 || c2.u > 65535) || engine.M._FPDFPageObj_HasTransparency(it.h);
  })) return { ok: false, code: "document_flow_text_style_unsupported" };
  return snapshot;
}
function cloneTextObject(engine, item) {
  if (item.role !== "running") return null;
  return cloneItem(engine, item, 1);
}
function verifyTextObject(engine, page, item, handle, dy = 0) {
  const M = engine.M;
  const chars = charsByObject(M, page).get(handle >>> 0) || [];
  if (textOf(chars) !== item.text || chars.length !== item.chars.length) return false;
  for (let i = 0; i < chars.length; i++) for (const key3 of ["ox", "oy", "l", "b", "r", "t"]) {
    const delta = ["oy", "b", "t"].includes(key3) ? dy : 0;
    if (!near(chars[i][key3], item.chars[i][key3] + delta, POS_TOL)) return false;
  }
  const matrix = readMatrix(M, handle), expected = [...item.style.matrix];
  expected[5] += dy;
  if (!matrix || matrix.slice(0, 4).some((v, i) => Math.abs(v - expected[i]) > 1e-5)) return false;
  return JSON.stringify(fontInfo(M, M._FPDFTextObj_GetFont(handle))) === JSON.stringify(item.style.font) && Math.abs(readFloat(M, "_FPDFTextObj_GetFontSize", handle) - item.style.size) < 1e-3 && JSON.stringify(readColor(M, "_FPDFPageObj_GetFillColor", handle)) === JSON.stringify(item.style.fill) && JSON.stringify(readColor(M, "_FPDFPageObj_GetStrokeColor", handle)) === JSON.stringify(item.style.stroke) && M._FPDFTextObj_GetTextRenderMode(handle) === item.style.renderMode && Math.abs(readFloat(M, "_FPDFPageObj_GetStrokeWidth", handle) - item.style.strokeWidth) < 1e-3;
}
function expectedPageEdges(snapshot, ordinal) {
  if (!snapshot?.ok || !Array.isArray(snapshot.items)) return { ok: false, code: "continuation_edge_snapshot_invalid", items: [] };
  if (!Number.isInteger(ordinal) || ordinal < 1) return { ok: false, code: "continuation_ordinal_invalid", items: [] };
  const items = [];
  for (const it of snapshot.items) {
    const base = { index: it.index, role: it.role, band: it.band, sourceText: it.text, style: it.style, baseline: it.chars[0]?.oy ?? null };
    if (it.role !== "page_number") {
      items.push({ ...base, text: it.text, bounds: it.bounds, anchor: null, chars: it.chars, prefixChars: null, suffix: null });
      continue;
    }
    const text3 = suffixedText(it.text, ordinal);
    if (text3 === null) return { ok: false, code: "continuation_page_number_unsupported", items: [] };
    const lead = /^\s*/.exec(it.text)[0].length;
    const digits = it.text.trim().length;
    items.push({ ...base, text: text3, bounds: null, anchor: it.anchor, chars: null, prefixChars: it.chars.slice(lead, lead + digits), suffix: "." + ordinal });
  }
  return { ok: true, code: null, items };
}
function preflightPageEdges(engine, snapshot, count) {
  const M = engine.M;
  for (const it of snapshot.items) {
    if (it.role !== "page_number") continue;
    const font = M._FPDFTextObj_GetFont(it.h);
    const need = new Set(".");
    for (let k = 1; k <= count; k++) for (const ch of String(k)) need.add(ch);
    for (const ch of need) {
      if (!font || !glyphAvailable(M, font, it.style.size, ch.codePointAt(0))) {
        return { ok: false, code: "continuation_page_number_glyph_missing", items: [], index: it.index, glyph: ch };
      }
    }
  }
  return { ok: true, code: null, items: [] };
}
function setText(M, obj, text3) {
  if (!text3) return false;
  const p = M._malloc((text3.length + 1) * 2);
  try {
    for (let i = 0; i < text3.length; i++) M.HEAPU16[(p >> 1) + i] = text3.charCodeAt(i);
    M.HEAPU16[(p >> 1) + text3.length] = 0;
    return !!M._FPDFText_SetText(obj, p);
  } finally {
    M._free(p);
  }
}
function setPositions(M, obj, xs) {
  if (!xs.length) return true;
  const p = M._malloc(xs.length * 4);
  try {
    xs.forEach((v, k) => M.HEAPF32[(p >> 2) + k] = v);
    return !!M._FPDFText_SetPositions(obj, p, xs.length);
  } finally {
    M._free(p);
  }
}
function cloneItem(engine, it, ordinal) {
  const M = engine.M;
  const font = M._FPDFTextObj_GetFont(it.h);
  if (!font) return null;
  const obj = M._FPDFPageObj_CreateTextObj(engine.doc, font, it.style.size);
  if (!obj) return null;
  const [a, b, c, d, e, f] = it.style.matrix;
  const x0 = it.textX[0], y0 = it.textY;
  const { fill, stroke, strokeWidth, renderMode } = it.style;
  const built = (it.role === "page_number" ? setText(M, obj, suffixedText(it.text, ordinal)) : setText(M, obj, it.text) && setPositions(M, obj, it.textX.slice(1).map((x) => x - x0))) && writeMatrix(M, obj, [a, b, c, d, e + x0 * a + y0 * c, f + x0 * b + y0 * d]) && (!fill || !!M._FPDFPageObj_SetFillColor(obj, ...fill)) && (!stroke || !!M._FPDFPageObj_SetStrokeColor(obj, ...stroke)) && (!(strokeWidth > 0) || !!M._FPDFPageObj_SetStrokeWidth(obj, strokeWidth)) && (renderMode < 0 || !!M._FPDFTextObj_SetTextRenderMode(obj, renderMode));
  if (!built) {
    M._FPDFPageObj_Destroy(obj);
    return null;
  }
  return obj >>> 0;
}
function translateX(M, h, dx) {
  const m = readMatrix(M, h);
  if (!m) return false;
  m[4] += dx;
  return writeMatrix(M, h, m);
}
function applyPageEdges(engine, newPage, snapshot, ordinal, bodyIndex = Infinity) {
  const M = engine.M;
  const exp = expectedPageEdges(snapshot, ordinal);
  if (!exp.ok) return { ok: false, code: exp.code, items: [] };
  const made = [];
  const abort2 = (index) => {
    for (const m of made) M._FPDFPageObj_Destroy(m.h);
    return { ok: false, code: "continuation_edge_clone_failed", items: [], index };
  };
  for (const it of snapshot.items) {
    const h = cloneItem(engine, it, ordinal);
    if (!h) return abort2(it.index);
    made.push({ index: it.index, role: it.role, h });
    if (it.role === "page_number") {
      M._FPDFPage_InsertObject(newPage, h);
      const ink = inkExtents(charsByObject(M, newPage).get(h) || []);
      if (!M._FPDFPage_RemoveObject(newPage, h) || !ink) return abort2(it.index);
      const dx = it.anchor.x - anchorX(it.anchor.anchor, ink);
      if (Math.abs(dx) > 1e-4 && !translateX(M, h, dx)) return abort2(it.index);
    }
  }
  const before = made.filter((m) => m.index < bodyIndex).map((m) => m.h);
  const after = made.filter((m) => m.index >= bodyIndex).map((m) => m.h);
  for (const h of [...before, ...after]) M._FPDFPage_InsertObject(newPage, h);
  return { ok: true, code: null, items: made, before, after, bodyAt: before.length };
}
function verifyPageEdges(engine, newPage, snapshot, ordinal, applied) {
  const M = engine.M;
  const exp = expectedPageEdges(snapshot, ordinal);
  if (!exp.ok) return { ok: false, code: exp.code, items: [] };
  const got = charsByObject(M, newPage);
  const items = [];
  const bad = (index, reason) => ({ ok: false, code: "continuation_edge_clone_mismatch", items, index, reason });
  for (const [k, e] of exp.items.entries()) {
    const h = applied?.items?.[k]?.h;
    const cs = got.get(h) || [];
    if (!h || textOf(cs) !== e.text) return bad(e.index, "text");
    const bounds = objectBox(M, h);
    items.push({ index: e.index, role: e.role, text: e.text, bounds });
    if (e.role !== "page_number") {
      for (const [i, c] of cs.entries()) {
        for (const key3 of ["ox", "oy", "l", "b", "r", "t"]) if (!near(c[key3], e.chars[i][key3], POS_TOL)) return bad(e.index, "geometry");
      }
      continue;
    }
    const lead = /^\s*/.exec(e.text)[0].length;
    const digits = e.prefixChars.length;
    const dx = cs[lead].ox - e.prefixChars[0].ox;
    for (let i = 0; i < digits; i++) {
      const c = cs[lead + i], s = e.prefixChars[i];
      for (const key3 of ["ox", "l", "r"]) if (!near(c[key3], s[key3] + dx, POS_TOL)) return bad(e.index, "digits");
      for (const key3 of ["oy", "b", "t"]) if (!near(c[key3], s[key3], POS_TOL)) return bad(e.index, "digits");
    }
    for (let i = lead + digits; i < lead + digits + e.suffix.length; i++) {
      const c = cs[i];
      if (!(c.r - c.l > 0.01 && c.t - c.b > 0.01) || !near(c.oy, e.prefixChars[0].oy, POS_TOL)) return bad(e.index, "suffix_glyph");
    }
    const ink = inkExtents(cs);
    if (!bounds || !ink || !near(anchorX(e.anchor.anchor, ink), e.anchor.x, ANCHOR_TOL)) return bad(e.index, "anchor");
  }
  return { ok: true, code: null, items };
}
var OBJ_TEXT, POS_TOL, ANCHOR_TOL, CENTER_TOL, CONTINUATION_STYLE, NUMBER_LIKE, LABELLED_NUMBER, textOf, near;
var init_continuation_template = __esm({
  "src/paragraph-vendor/continuation-template.mjs"() {
    init_paragraph_source_tables();
    OBJ_TEXT = 1;
    POS_TOL = 0.05;
    ANCHOR_TOL = 0.1;
    CENTER_TOL = 2;
    CONTINUATION_STYLE = Object.freeze({ version: 1, policy: "source-number-suffix" });
    NUMBER_LIKE = /^[\s\-–—|/.()]*(\d+|[ivxlcdm]+)([\s\-–—|/.()]*(\d+|of))*[\s\-–—|/.()]*$/i;
    LABELLED_NUMBER = /^(page|pg\.?|p\.)\s*\d+/i;
    textOf = (chars) => chars.map((c) => String.fromCodePoint(c.u)).join("");
    near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
  }
});

// src/paragraph-vendor/document-flow-links.mjs
function validateNativeLinkInventory(engine, pageIndex, model) {
  const M = engine.M, n = M._FPDFPage_GetAnnotCount?.(engine.page);
  if (!Number.isInteger(n) || n < 0 || n > 512) fail3("document_flow_annotations_unsupported");
  if (!n) return;
  if (!model || !Array.isArray(model.annotations)) fail3("document_flow_annotations_unsupported");
  const annotations = model.annotations.filter((a) => a.sourcePageIndex === pageIndex);
  if (annotations.length !== n) fail3("document_flow_annotation_inventory_mismatch");
  const p = M._malloc(16);
  try {
    for (let i = 0; i < n; i++) {
      const descriptor = annotations.find((a2) => a2.annotationIndex === i);
      if (!descriptor || descriptor.kind !== "link" || descriptor.eligible !== true) fail3(descriptor?.reason || "document_flow_annotation_unsupported");
      if (!["uri", "internal"].includes(descriptor.destination?.type) || descriptor.destination.type === "internal" && !Number.isInteger(descriptor.destination.targetSourcePageIndex) && descriptor.preservedMissingDestination !== true) fail3("document_flow_link_destination_unproven");
      const a = M._FPDFPage_GetAnnot(engine.page, i);
      try {
        if (!a || M._FPDFAnnot_GetSubtype(a) !== 2 || !M._FPDFAnnot_GetRect(a, p)) fail3("document_flow_annotation_inventory_mismatch");
        const [l, t, r, b] = Array.from(M.HEAPF32.slice(p >> 2, (p >> 2) + 4));
        if (!Array.isArray(descriptor.rect) || descriptor.rect.length !== 4 || ![l, b, r, t].every((v, k) => near2(v, descriptor.rect[k], 5e-3))) fail3("document_flow_annotation_inventory_mismatch");
      } finally {
        if (a) M._FPDFPage_CloseAnnot(a);
      }
    }
  } finally {
    M._free(p);
  }
}
function readLinkPageCharacters(engine, pageIndex) {
  engine.loadPage(pageIndex);
  const M = engine.M, tp = M._FPDFText_LoadPage(engine.page), p = M._malloc(32), chars = [];
  try {
    if (!tp) fail3("document_flow_link_text_unavailable");
    const n = M._FPDFText_CountChars(tp);
    if (n > 1e5) fail3("document_flow_character_budget_exceeded");
    for (let i = 0; i < n; i++) {
      const u = M._FPDFText_GetUnicode(tp, i);
      let box = null;
      if (u > 32 && M._FPDFText_GetCharBox(tp, i, p, p + 8, p + 16, p + 24)) {
        const [l, r, b, t] = Array.from(M.HEAPF64.slice(p >> 3, (p >> 3) + 4));
        box = { l, r, b, t };
      }
      chars.push({ u, index: i, box, object: box ? M._FPDFText_GetTextObject(tp, i) >>> 0 : 0, generated: M._FPDFText_IsGenerated(tp, i) === 1 });
    }
  } finally {
    M._free(p);
    if (tp) M._FPDFText_ClosePage(tp);
  }
  return chars;
}
function normalizedSource(chars, band) {
  const selected = chars.filter((c) => c.u <= 32 || bodyGlyph(c, band));
  let text3 = "", indices = [];
  for (const c of selected) {
    const ch = String.fromCharCode(c.u);
    if (/\s/.test(ch)) {
      if (!text3 || text3.endsWith(" ")) continue;
      text3 += " ";
      indices.push(null);
    } else {
      text3 += ch;
      indices.push(c.u > 32 ? c.index : null);
    }
  }
  if (text3.endsWith(" ")) {
    text3 = text3.slice(0, -1);
    indices.pop();
  }
  return { text: text3, indices };
}
function mapSourceGlyphs(sourceEngine, sourceBands, targetGlyphs, edits, expectedPageText2, sourceCharacterProvider) {
  const expected = [], mapping2 = /* @__PURE__ */ new Map(), sources = /* @__PURE__ */ new Map();
  for (const band of sourceBands) {
    const chars = readLinkPageCharacters(sourceEngine, band.sourcePageIndex);
    sources.set(band.sourcePageIndex, chars);
    const normalized = normalizedSource(sourceCharacterProvider ? sourceCharacterProvider(band, chars) : chars, band);
    const exp = expectedPageText2(normalized.text, edits.filter((e) => e.pageIndex === band.sourcePageIndex), { includeSpans: true });
    if (!exp.ok) fail3("document_flow_link_edit_mapping_ambiguous");
    const append = (start, end) => {
      for (let i = start; i < end; i++) {
        const u = normalized.text.charCodeAt(i);
        if (u <= 32) continue;
        const original = normalized.indices[i];
        if (original !== null) mapping2.set(`${band.sourcePageIndex}:${original}`, expected.length);
        expected.push(u);
      }
    };
    let at = 0;
    for (const span of exp.spans) {
      append(at, span.a);
      const before = normalized.text.slice(span.a, span.b), after = span.after;
      let prefix = 0, suffix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      append(span.a, span.a + prefix);
      for (let j = prefix; j < after.length - suffix; j++) if (after.charCodeAt(j) > 32) expected.push(after.charCodeAt(j));
      append(span.b - suffix, span.b);
      at = span.b;
    }
    append(at, normalized.text.length);
  }
  if (expected.length !== targetGlyphs.length || expected.some((u, i) => u !== targetGlyphs[i].u)) fail3("document_flow_link_text_mapping_mismatch");
  return { mapping: mapping2, sources };
}
function deriveNativeLinkMoves(sourceEngine, sourceBands, targetGlyphs, edits, model, expectedPageText2, authorizedTargets = /* @__PURE__ */ new Set(), sourceCharacterProvider) {
  if (!model || !model.annotations.some((a) => sourceBands.some((b) => b.sourcePageIndex === a.sourcePageIndex))) return [];
  const ids = sourceBands.map((b) => b.sourcePageIndex);
  const { mapping: mapping2, sources } = mapSourceGlyphs(sourceEngine, sourceBands, targetGlyphs, edits, expectedPageText2, sourceCharacterProvider);
  const moves = [], claimed = /* @__PURE__ */ new Set();
  for (const descriptor of model.annotations.filter((a) => ids.includes(a.sourcePageIndex))) {
    if (descriptor.eligible !== true || descriptor.kind !== "link") fail3(descriptor.reason || "document_flow_annotation_unsupported");
    const targets = descriptor.internalDestinationSourcePageIndices || [descriptor.destination?.targetSourcePageIndex].filter(Number.isInteger);
    if (targets.some((i) => ids.includes(i) && !authorizedTargets.has(i))) fail3("document_flow_link_target_in_changed_body");
    const chars = sources.get(descriptor.sourcePageIndex), band = sourceBands.find((b2) => b2.sourcePageIndex === descriptor.sourcePageIndex);
    const [l, b, r, t] = descriptor.rect, rect2 = { l, b, r, t };
    const owned = chars.filter((c) => c.box && intersects(c.box, rect2));
    const body = owned.filter((c) => bodyGlyph(c, band));
    if (!body.length) {
      if (!(t < band.floor - 0.5 || b > band.bodyTop + 0.5)) fail3("document_flow_link_unowned");
      continue;
    }
    if (body.length !== owned.length) fail3("document_flow_link_crosses_fixed_body");
    let dx, dy, outputPageIndex;
    const linkedTargets = /* @__PURE__ */ new Set();
    for (const c of body) {
      const key3 = `${descriptor.sourcePageIndex}:${c.index}`;
      if (claimed.has(key3)) fail3("document_flow_link_overlapping_ownership");
      claimed.add(key3);
      const at = mapping2.get(key3);
      if (at === void 0) fail3("document_flow_link_edited_label");
      linkedTargets.add(at);
      const target = targetGlyphs[at];
      if (dx === void 0) {
        dx = target.box.l - c.box.l;
        dy = target.box.b - c.box.b;
        outputPageIndex = target.outputPageIndex;
      }
      if (target.outputPageIndex !== outputPageIndex) fail3("document_flow_link_split_page");
      if (!near2(target.box.l, c.box.l + dx) || !near2(target.box.r, c.box.r + dx) || !near2(target.box.b, c.box.b + dy) || !near2(target.box.t, c.box.t + dy)) fail3("document_flow_link_not_rigid_translation");
    }
    const translated = { l: l + dx, r: r + dx, b: b + dy, t: t + dy };
    const outputOwned = targetGlyphs.flatMap((c, i) => c.outputPageIndex === outputPageIndex && intersects(c.box, translated) ? [i] : []);
    if (outputOwned.length !== linkedTargets.size || outputOwned.some((i) => !linkedTargets.has(i))) fail3("document_flow_link_output_ownership_ambiguous");
    moves.push({ sourcePageIndex: descriptor.sourcePageIndex, annotationIndex: descriptor.annotationIndex, outputPageIndex, dx, dy });
  }
  return moves;
}
function deriveNativeFitRMoves(sourceEngine, sourceBands, targetGlyphs, edits, model, expectedPageText2, sourceCharacterProvider) {
  const ids = new Set(sourceBands.map((b) => b.sourcePageIndex));
  const destinations = /* @__PURE__ */ new Map();
  for (const a of model?.annotations || []) for (const d of a.internalDestinations || []) {
    if (!ids.has(d.targetSourcePageIndex)) continue;
    const previous = destinations.get(d.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(d)) fail3("document_flow_destination_alias_mismatch");
    destinations.set(d.id, d);
  }
  if (!destinations.size) return [];
  const { mapping: mapping2, sources } = mapSourceGlyphs(sourceEngine, sourceBands, targetGlyphs, edits, expectedPageText2, sourceCharacterProvider);
  const moves = [];
  for (const d of destinations.values()) {
    if (d.kind !== "FitR" || !Array.isArray(d.operands) || d.operands.length !== 4 || !d.operands.every(Number.isFinite)) fail3("document_flow_destination_unsupported");
    const [l, b, r, t] = d.operands, rect2 = { l, b, r, t };
    if (l >= r || b >= t) fail3("document_flow_destination_unsupported");
    const band = sourceBands.find((x) => x.sourcePageIndex === d.targetSourcePageIndex), chars = sources.get(d.targetSourcePageIndex);
    const owned = chars.filter((c) => c.box && intersects(c.box, rect2));
    if (!owned.length || owned.some((c) => !bodyGlyph(c, band) || !c.object || c.generated)) fail3("document_flow_destination_ownership_ambiguous");
    const object = owned[0].object;
    if (owned.some((c) => c.object !== object || c.box.l < l - 1e-3 || c.box.r > r + 1e-3 || c.box.b < b - 1e-3 || c.box.t > t + 1e-3)) fail3("document_flow_destination_ownership_ambiguous");
    const objectChars = chars.filter((c) => c.box && c.object === object && bodyGlyph(c, band));
    const bounds = { l: Math.min(...objectChars.map((c) => c.box.l)), r: Math.max(...objectChars.map((c) => c.box.r)), b: Math.min(...objectChars.map((c) => c.box.b)), t: Math.max(...objectChars.map((c) => c.box.t)) };
    if (l < bounds.l - 1e-3 || r > bounds.r + 1e-3 || b < bounds.b - 1e-3 || t > bounds.t + 1e-3) fail3("document_flow_destination_ownership_ambiguous");
    let dx, dy, outputPageIndex;
    const targetIndices = /* @__PURE__ */ new Set();
    for (const c of owned) {
      const at = mapping2.get(`${d.targetSourcePageIndex}:${c.index}`);
      if (at === void 0) fail3("document_flow_destination_edited");
      const target = targetGlyphs[at];
      targetIndices.add(at);
      if (dx === void 0) {
        dx = target.box.l - c.box.l;
        dy = target.box.b - c.box.b;
        outputPageIndex = target.outputPageIndex;
      }
      if (target.outputPageIndex !== outputPageIndex || !near2(target.box.l, c.box.l + dx) || !near2(target.box.r, c.box.r + dx) || !near2(target.box.b, c.box.b + dy) || !near2(target.box.t, c.box.t + dy)) fail3("document_flow_destination_not_rigid");
    }
    const translated = { l: l + dx, r: r + dx, b: b + dy, t: t + dy };
    const outputOwned = targetGlyphs.flatMap((c, i) => c.outputPageIndex === outputPageIndex && intersects(c.box, translated) ? [i] : []);
    if (outputOwned.length !== targetIndices.size || outputOwned.some((i) => !targetIndices.has(i))) fail3("document_flow_destination_ownership_ambiguous");
    moves.push({ id: d.id, sourcePageIndex: d.targetSourcePageIndex, outputPageIndex, dx, dy });
  }
  return moves;
}
function deriveNativeXYZMoves(sourceEngine, sourceBands, targetGlyphs, edits, model, expectedPageText2, sourceCharacterProvider) {
  const ids = new Set(sourceBands.map((b) => b.sourcePageIndex)), destinations = /* @__PURE__ */ new Map();
  for (const a of model?.annotations || []) for (const d of a.internalDestinations || []) {
    if (!ids.has(d.targetSourcePageIndex)) continue;
    const old = destinations.get(d.id);
    if (old && JSON.stringify(old) !== JSON.stringify(d)) fail3("document_flow_destination_alias_mismatch");
    destinations.set(d.id, d);
  }
  if (!destinations.size) return [];
  const { mapping: mapping2, sources } = mapSourceGlyphs(sourceEngine, sourceBands, targetGlyphs, edits, expectedPageText2, sourceCharacterProvider);
  const moves = [];
  for (const d of destinations.values()) {
    if (d.kind !== "XYZ" || d.operands.length !== 3 || !Number.isFinite(d.operands[0]) || !Number.isFinite(d.operands[1]) || !(d.operands[2] === null || Number.isFinite(d.operands[2]))) fail3("document_flow_destination_unsupported");
    const [x, y] = d.operands, chars = sources.get(d.targetSourcePageIndex);
    const groups = /* @__PURE__ */ new Map();
    for (const c of chars) if (c.u > 32 && c.object && c.box && !c.generated) {
      const group = groups.get(c.object) || [];
      group.push(c);
      groups.set(c.object, group);
    }
    const candidates = [...groups.values()].filter((g) => {
      const l = Math.min(...g.map((c) => c.box.l)), t = Math.max(...g.map((c) => c.box.t));
      return l >= x - 0.5 && l <= x + 4 && t <= y + 2 && t >= y - 8;
    });
    if (candidates.length !== 1) fail3("document_flow_destination_ownership_ambiguous");
    let dx, dy, outputPageIndex;
    const targetIndices = /* @__PURE__ */ new Set();
    for (const c of candidates[0]) {
      const at = mapping2.get(`${d.targetSourcePageIndex}:${c.index}`);
      if (at === void 0) fail3("document_flow_destination_edited");
      targetIndices.add(at);
      const t = targetGlyphs[at];
      if (dx === void 0) {
        dx = t.box.l - c.box.l;
        dy = t.box.b - c.box.b;
        outputPageIndex = t.outputPageIndex;
      }
      if (t.outputPageIndex !== outputPageIndex || !near2(t.box.l, c.box.l + dx) || !near2(t.box.r, c.box.r + dx) || !near2(t.box.b, c.box.b + dy) || !near2(t.box.t, c.box.t + dy)) fail3("document_flow_destination_not_rigid");
    }
    const bounds = {
      l: Math.min(...candidates[0].map((c) => c.box.l)) + dx,
      r: Math.max(...candidates[0].map((c) => c.box.r)) + dx,
      b: Math.min(...candidates[0].map((c) => c.box.b)) + dy,
      t: Math.max(...candidates[0].map((c) => c.box.t)) + dy
    };
    const overlapping = targetGlyphs.flatMap((c, i) => c.outputPageIndex === outputPageIndex && c.box && intersects(c.box, bounds) ? [i] : []);
    if (overlapping.some((i) => !targetIndices.has(i))) fail3("document_flow_destination_ownership_ambiguous");
    moves.push({ id: d.id, sourcePageIndex: d.targetSourcePageIndex, outputPageIndex, dx, dy });
  }
  return moves;
}
function plannedLinkGlyphs(plan) {
  return plan.pages.flatMap((page, outputPageIndex) => page.lines.flatMap(({ index, dy }) => plan.lines[index].items.flatMap(({ it }) => it.chars.filter((c) => c.u > 32).map((c) => ({ u: c.u, outputPageIndex, box: { l: c.l, r: c.r, b: c.b + dy, t: c.t + dy } })))));
}
function savedLinkGlyphs(engine, outputBands) {
  return outputBands.flatMap((b) => readLinkPageCharacters(engine, b.outputPageIndex).filter((c) => c.u > 32 && bodyGlyph(c, b)).map((c) => ({ ...c, outputPageIndex: b.outputPageIndex })));
}
function nativeFitRTargetPages(model, pages) {
  return new Set(pages.filter((page) => {
    const refs = (model?.annotations || []).filter((a) => (a.internalDestinationSourcePageIndices || [a.destination?.targetSourcePageIndex].filter(Number.isInteger)).includes(page));
    return refs.length > 0 && refs.every((a) => {
      const ds = (a.internalDestinations || []).filter((d) => d.targetSourcePageIndex === page);
      return ds.length > 0 && ds.every((d) => d.kind === "FitR" && d.id !== void 0);
    });
  }));
}
var fail3, near2, bodyGlyph, intersects;
var init_document_flow_links = __esm({
  "src/paragraph-vendor/document-flow-links.mjs"() {
    fail3 = (code) => {
      throw Object.assign(new Error(code), { code });
    };
    near2 = (a, b, t = 0.05) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= t;
    bodyGlyph = (g, b) => g.box && (g.box.b + g.box.t) / 2 >= b.floor - 0.5 && (g.box.b + g.box.t) / 2 <= b.bodyTop + 0.5;
    intersects = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1e-4 && Math.min(a.t, b.t) - Math.max(a.b, b.b) > 1e-4;
  }
});

// src/paragraph-vendor/document-flow-underlines.mjs
function float(M, fn, h) {
  const p = M._malloc(4);
  try {
    return M[fn](h, p) ? M.HEAPF32[p >> 2] : null;
  } finally {
    M._free(p);
  }
}
function color(M, fn, h) {
  const p = M._malloc(16);
  try {
    return M[fn](h, p, p + 4, p + 8, p + 12) ? Array.from(M.HEAPU32.slice(p >> 2, (p >> 2) + 4)) : null;
  } finally {
    M._free(p);
  }
}
function snapshotTinyUnderline(engine, h) {
  const M = engine.M;
  if (M._FPDFPageObj_GetType(h) !== 2) fail4("document_flow_foreign_object_unsupported");
  const b = engine.objectBounds(h), n = M._FPDFPath_CountSegments(h), p = M._malloc(32);
  try {
    const dashPhase = float(M, "_FPDFPageObj_GetDashPhase", h);
    if (!b || b.w <= 0.1 || n < 2 || n > 3 || M._FPDFPageObj_HasTransparency(h) || M._FPDFPageObj_GetDashCount(h) !== 0 || !Number.isFinite(dashPhase) || Math.abs(dashPhase) > 1e-3 || M._FPDFPageObj_CountMarks(h) !== 0) fail4("document_flow_underline_style_unsupported");
    const clip = M._FPDFPageObj_GetClipPath(h), clipCount = clip ? M._FPDFClipPath_CountPaths(clip) : -1;
    if (clipCount > 0 || clipCount < -1) fail4("document_flow_underline_clip_unsupported");
    if (!M._FPDFPageObj_GetMatrix(h, p)) fail4("document_flow_underline_style_unsupported");
    const matrix = Array.from(M.HEAPF32.slice(p >> 2, (p >> 2) + 6));
    if (matrix.some((v) => !Number.isFinite(v)) || matrix.slice(0, 4).some((v, i) => !near3(v, [1, 0, 0, 1][i]))) fail4("document_flow_underline_style_unsupported");
    const segments = [];
    for (let i = 0; i < n; i++) {
      const s = M._FPDFPath_GetPathSegment(h, i), type = M._FPDFPathSegment_GetType(s), close = !!M._FPDFPathSegment_GetClose(s);
      if (type !== (i ? 0 : 2) || !M._FPDFPathSegment_GetPoint(s, p, p + 4)) fail4("document_flow_underline_segments_unsupported");
      const x = M.HEAPF32[p >> 2], y = M.HEAPF32[(p >> 2) + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y) || i && (!near3(y, segments[0].y) || i === 2 && !near3(x, segments[0].x))) fail4("document_flow_underline_segments_unsupported");
      segments.push({ x, y, close });
    }
    if (!M._FPDFPath_GetDrawMode(h, p, p + 4)) fail4("document_flow_underline_style_unsupported");
    const fillMode = M.HEAP32[p >> 2], stroke = !!M.HEAP32[(p >> 2) + 1], fill = color(M, "_FPDFPageObj_GetFillColor", h), strokeColor = color(M, "_FPDFPageObj_GetStrokeColor", h), width = float(M, "_FPDFPageObj_GetStrokeWidth", h), cap = M._FPDFPageObj_GetLineCap(h), join = M._FPDFPageObj_GetLineJoin(h);
    if (![0, 1, 2].includes(fillMode) || !fill || !strokeColor || fill[3] !== 255 || strokeColor[3] !== 255 || !Number.isFinite(width) || !(width >= 0 && width <= 2) || b.h > (stroke ? 2 * width : 0.01) + 0.05 || ![0, 1, 2].includes(cap) || ![0, 1, 2].includes(join)) fail4("document_flow_underline_style_unsupported");
    return { h: h >>> 0, bounds: { ...b }, matrix, segments, fillMode, stroke, fill, strokeColor, width, cap, join };
  } finally {
    M._free(p);
  }
}
function sourceUnderline(engine, h, pageIndex, annotationModel) {
  const path = snapshotTinyUnderline(engine, h);
  if (!annotationModel) fail4("document_flow_foreign_object_unsupported");
  const left = Math.min(...path.segments.map((s) => s.x + path.matrix[4])), right = Math.max(...path.segments.map((s) => s.x + path.matrix[4])), baseline = path.segments[0].y + path.matrix[5];
  const links = annotationModel.annotations.filter((a) => a.sourcePageIndex === pageIndex && a.eligible === true && a.kind === "link" && near3(a.rect[0], left) && near3(a.rect[2], right) && baseline >= a.rect[1] - 0.02 && baseline <= a.rect[3] + 0.02);
  if (links.length !== 1) fail4("document_flow_underline_ownership_ambiguous");
  const link = links[0], chars = readLinkPageCharacters(engine, pageIndex), owned = chars.filter((c) => c.box && Math.min(c.box.r, link.rect[2]) - Math.max(c.box.l, link.rect[0]) > 1e-4 && Math.min(c.box.t, link.rect[3]) - Math.max(c.box.b, link.rect[1]) > 1e-4);
  if (!owned.length) fail4("document_flow_underline_ownership_ambiguous");
  engine.loadPage(pageIndex);
  const M = engine.M, tp = M._FPDFText_LoadPage(engine.page), matrix = M._malloc(24);
  let size3 = 0;
  try {
    for (const c of owned) {
      if (!M._FPDFText_GetMatrix(tp, c.index, matrix)) fail4("document_flow_underline_style_unsupported");
      const [a, b, cx, d] = Array.from(M.HEAPF32.slice(matrix >> 2, (matrix >> 2) + 4));
      size3 = Math.max(size3, M._FPDFText_GetFontSize(tp, c.index) * Math.max(Math.hypot(a, b), Math.hypot(cx, d)));
    }
  } finally {
    M._free(matrix);
    M._FPDFText_ClosePage(tp);
  }
  if (!(size3 > 0) || right - left > 2 * size3 + 0.02) fail4("document_flow_underline_too_long");
  const objects = list(M, engine.page), order = objects.indexOf(h >>> 0), text3 = M._FPDFText_LoadPage(engine.page);
  let owners;
  try {
    owners = owned.map((c) => objects.indexOf(M._FPDFText_GetTextObject(text3, c.index) >>> 0));
  } finally {
    M._FPDFText_ClosePage(text3);
  }
  if (owners.some((i) => i < 0) || !(order < Math.min(...owners) || order > Math.max(...owners))) fail4("document_flow_underline_paint_order_unsupported");
  return { ...path, sourcePageIndex: pageIndex, annotationIndex: link.annotationIndex, ownerRect: [...link.rect], paint: order < Math.min(...owners) ? "before" : "after" };
}
function underlineEqual(actual, source2, dx = 0, dy = 0) {
  if (!near3(actual.bounds.x, source2.bounds.x + dx) || !near3(actual.bounds.y, source2.bounds.y + dy) || !near3(actual.bounds.w, source2.bounds.w) || !near3(actual.bounds.h, source2.bounds.h)) return false;
  for (const key3 of ["fillMode", "stroke", "cap", "join"]) if (actual[key3] !== source2[key3]) return false;
  for (const key3 of ["fill", "strokeColor"]) if (JSON.stringify(actual[key3]) !== JSON.stringify(source2[key3])) return false;
  if (!near3(actual.width, source2.width) || actual.segments.length !== source2.segments.length) return false;
  for (let i = 0; i < actual.segments.length; i++) {
    const a = actual.segments[i], s = source2.segments[i];
    if (a.close !== s.close || !near3(a.x + actual.matrix[4], s.x + source2.matrix[4] + dx) || !near3(a.y + actual.matrix[5], s.y + source2.matrix[5] + dy)) return false;
  }
  return true;
}
function cloneUnderline(engine, source2, dx, dy) {
  const M = engine.M, first = source2.segments[0], h = M._FPDFPageObj_CreateNewPath(first.x, first.y), p = M._malloc(24);
  if (!h) {
    M._free(p);
    fail4("document_flow_underline_clone_failed");
  }
  try {
    for (const [i, s] of source2.segments.entries()) {
      if (i && !M._FPDFPath_LineTo(h, s.x, s.y)) fail4("document_flow_underline_clone_failed");
      if (s.close && !M._FPDFPath_Close(h)) fail4("document_flow_underline_clone_failed");
    }
    const matrix = [...source2.matrix];
    matrix[4] += dx;
    matrix[5] += dy;
    matrix.forEach((v, i) => M.HEAPF32[(p >> 2) + i] = v);
    if (!M._FPDFPageObj_SetFillColor(h, ...source2.fill) || !M._FPDFPageObj_SetStrokeColor(h, ...source2.strokeColor) || !M._FPDFPageObj_SetStrokeWidth(h, source2.width)) fail4("document_flow_underline_clone_failed");
    M._FPDFPageObj_SetLineCap(h, source2.cap);
    M._FPDFPageObj_SetLineJoin(h, source2.join);
    if (!M._FPDFPath_SetDrawMode(h, source2.fillMode, source2.stroke) || !M._FPDFPageObj_SetMatrix(h, p)) fail4("document_flow_underline_clone_failed");
    if (!underlineEqual(snapshotTinyUnderline(engine, h), source2, dx, dy)) fail4("document_flow_underline_clone_mismatch");
    return h >>> 0;
  } catch (error2) {
    M._FPDFPageObj_Destroy(h);
    throw error2;
  } finally {
    M._free(p);
  }
}
function matchStagedUnderlines(sourceBands, parts, stageMoves) {
  const paths = parts.flatMap((part) => (part.paths || []).map((path) => ({ ...path, pageIndex: part.pageIndex }))), claimed = /* @__PURE__ */ new Set(), out = [];
  for (const band of sourceBands) for (const source2 of band.underlines || []) {
    const move = stageMoves.find((m) => m.sourcePageIndex === source2.sourcePageIndex && m.annotationIndex === source2.annotationIndex);
    if (!move) fail4("document_flow_underline_link_move_missing");
    const original = parts.find((p) => p.band.sourcePageIndex === source2.sourcePageIndex);
    const matches = paths.filter((p) => p.pageIndex === move.outputPageIndex && underlineEqual(p, source2, move.dx, move.dy) || p.pageIndex === original?.pageIndex && underlineEqual(p, source2, 0, 0));
    if (matches.length !== 1 || claimed.has(matches[0].h)) fail4("document_flow_underline_staged_match_ambiguous");
    claimed.add(matches[0].h);
    out.push({ source: source2, staged: matches[0] });
  }
  if (claimed.size !== paths.length) fail4("document_flow_underline_unowned_path");
  return out;
}
function verifySavedUnderlines(engine, sourceBands, outputBands, moves) {
  const expected = sourceBands.flatMap((b) => (b.underlines || []).map((source2) => {
    const move = moves.find((m) => m.sourcePageIndex === source2.sourcePageIndex && m.annotationIndex === source2.annotationIndex);
    if (!move) fail4("document_flow_underline_link_move_missing");
    return { source: source2, move };
  }));
  for (const band of outputBands) {
    engine.loadPage(band.outputPageIndex);
    const objects = list(engine.M, engine.page), paths = [];
    for (const h of objects) {
      const b = engine.objectBounds(h);
      if (engine.M._FPDFPageObj_GetType(h) !== 2 || !b || b.y + b.h < band.floor - 0.5 || b.y > band.bodyTop + 0.5) continue;
      paths.push(snapshotTinyUnderline(engine, h));
    }
    const chars = readLinkPageCharacters(engine, band.outputPageIndex), claimed = /* @__PURE__ */ new Set();
    for (const { source: source2, move } of expected.filter((e) => e.move.outputPageIndex === band.outputPageIndex)) {
      const matches = paths.filter((p) => underlineEqual(p, source2, move.dx, move.dy));
      if (matches.length !== 1 || claimed.has(matches[0].h)) fail4("document_flow_underline_saved_mismatch");
      const actual = matches[0], pathOrder = objects.indexOf(actual.h), [l, b, r, t] = source2.ownerRect;
      const owners = chars.filter((c) => c.box && Math.min(c.box.r, r + move.dx) - Math.max(c.box.l, l + move.dx) > 1e-4 && Math.min(c.box.t, t + move.dy) - Math.max(c.box.b, b + move.dy) > 1e-4).map((c) => objects.indexOf(c.object));
      if (pathOrder < 0 || !owners.length || owners.some((i) => i < 0) || (source2.paint === "before" ? !owners.every((i) => pathOrder < i) : !owners.every((i) => pathOrder > i))) fail4("document_flow_underline_paint_order_mismatch");
      claimed.add(actual.h);
    }
    if (claimed.size !== paths.length) fail4("document_flow_underline_unowned_path");
  }
}
var fail4, near3, list;
var init_document_flow_underlines = __esm({
  "src/paragraph-vendor/document-flow-underlines.mjs"() {
    init_document_flow_links();
    fail4 = (code) => {
      throw Object.assign(new Error(code), { code });
    };
    near3 = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.02;
    list = (M, p) => Array.from({ length: M._FPDFPage_CountObjects(p) }, (_, i) => M._FPDFPage_GetObject(p, i) >>> 0);
  }
});

// src/paragraph-vendor/document-flow-band.mjs
function checkDocumentFlowPageBudget(e) {
  const M = e.M;
  if (M._FPDFPage_CountObjects(e.page) > 5e3) fail5("document_flow_object_budget_exceeded");
  const text3 = M._FPDFText_LoadPage(e.page);
  try {
    if (!text3 || M._FPDFText_CountChars(text3) > 1e5) fail5("document_flow_character_budget_exceeded");
  } finally {
    if (text3) M._FPDFText_ClosePage(text3);
  }
}
function deriveDocumentFlowBand(engine, sourcePageIndex, captureLayout, annotationModel = null) {
  engine.loadPage(sourcePageIndex);
  checkDocumentFlowPageBudget(engine);
  if (unsupportedPage(engine)) fail5("document_flow_geometry_unsupported");
  const M = engine.M;
  validateNativeLinkInventory(engine, sourcePageIndex, annotationModel);
  const ctx = captureLayout(engine, sourcePageIndex, engine.buildModel());
  const body = ctx.paras.filter((q) => q.role === "body" && q.box);
  if (!body.length || body.some((q) => !q.editable || q.sharesObjects || !q.topLevel)) fail5("document_flow_body_unsupported");
  for (let i = 0; i < body.length; i++) for (let j = i + 1; j < body.length; j++) {
    const a = body[i].box, b = body[j].box;
    if (Math.min(a.top, b.top) - Math.max(a.top - a.h, b.top - b.h) > 1) fail5("document_flow_table_or_columns_unsupported");
  }
  const edgeTop = ctx.paras.filter((q) => q.role !== "body" && q.box && q.box.top < ctx.pageH / 2).map((q) => q.box.top + 2);
  const handles = body.flatMap((q) => q.handles);
  const bounds = handles.map((h) => engine.objectBounds(h)).filter(Boolean);
  const x0 = Math.min(...bounds.map((b) => b.x)), x1 = Math.max(...bounds.map((b) => b.x + b.w));
  const bodyTop = Math.max(...bounds.map((b) => b.y + b.h));
  const floor = Math.max(0, ...edgeTop, Math.min(ctx.pageH * 0.1, ...bounds.map((b) => b.y)));
  if (!(bodyTop > floor)) fail5("document_flow_band_invalid");
  const owned = new Set(ctx.paras.flatMap((q) => q.handles));
  const underlines = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) {
    const h = M._FPDFPage_GetObject(engine.page, i) >>> 0;
    if (owned.has(h)) continue;
    const b = engine.objectBounds(h);
    if (!b) fail5("document_flow_foreign_object_unsupported");
    if (b.y + b.h >= floor && b.y <= bodyTop) {
      if (!annotationModel || M._FPDFPageObj_GetType(h) !== 2) fail5("document_flow_foreign_object_unsupported");
      underlines.push(sourceUnderline(engine, h, sourcePageIndex, annotationModel));
    }
  }
  return { sourcePageIndex, bodyTop, flowTop: bodyTop, floor, x0, x1, width: ctx.pageW, height: ctx.pageH, underlines };
}
var fail5;
var init_document_flow_band = __esm({
  "src/paragraph-vendor/document-flow-band.mjs"() {
    init_pagination();
    init_document_flow_links();
    init_document_flow_underlines();
    fail5 = (code) => {
      throw Object.assign(new Error(code), { code });
    };
  }
});

// src/paragraph-vendor/quality.mjs
var quality_exports = {};
__export(quality_exports, {
  alignEdgeGlyphs: () => alignEdgeGlyphs,
  authorizedEdgeChanges: () => authorizedEdgeChanges,
  capturePageLayout: () => capturePageLayout,
  cascadeBarrier: () => cascadeBarrier,
  cascadeFloor: () => cascadeFloor,
  cascadeShifts: () => cascadeShifts,
  checkContinuationEdges: () => checkContinuationEdges,
  compareModelNumericEdit: () => compareModelNumericEdit,
  countGlyphLines: () => countGlyphLines,
  edgeGlyphs: () => edgeGlyphs,
  edgeGlyphsEquivalent: () => edgeGlyphsEquivalent,
  expectedPageText: () => expectedPageText,
  findGeneratedWhitespaceMatches: () => findGeneratedWhitespaceMatches,
  inspectSavedPdf: () => inspectSavedPdf,
  joinFlowParts: () => joinFlowParts,
  matchesGeneratedWhitespace: () => matchesGeneratedWhitespace,
  matchesStationaryReorderedGlyphs: () => matchesStationaryReorderedGlyphs,
  modelNumericEditProof: () => modelNumericEditProof,
  modelWordEditProof: () => modelWordEditProof,
  normalizePageMap: () => normalizePageMap,
  readGlyphs: () => readGlyphs,
  repairPageLayout: () => repairPageLayout,
  reserveCascadeSpace: () => reserveCascadeSpace,
  restoreSourceOrder: () => restoreSourceOrder,
  validContinuationStyle: () => validContinuationStyle
});
function ensurePage(engine, pageIndex) {
  if (!engine.page || engine.pageIndex !== pageIndex) engine.loadPage(pageIndex);
}
function listObjects(engine) {
  const M = engine.M;
  const n = M._FPDFPage_CountObjects(engine.page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return out;
}
function unionBounds(engine, handles) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!(x1 > x0)) return null;
  return { x: x0, top: y1, w: x1 - x0, h: y1 - y0 };
}
function hOverlap(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}
function classify(p, pageH, edgeBottomY) {
  if (!p.box) return "unknown";
  const text3 = normStr(paraText(p));
  const short = text3.length <= 60 && text3.split(" ").length <= 12 && (p.lines?.length || 1) <= 2;
  const inTop = bottomOf(p.box) >= edgeBottomY + pageH * (1 - EDGE_BAND);
  const inBottom = p.box.top <= edgeBottomY + pageH * EDGE_BAND;
  if (!short || !(inTop || inBottom)) return "body";
  if (/^[\s\-–—|/.()]*(\d+|[ivxlcdm]+)([\s\-–—|/.()]*(\d+|of))*[\s\-–—|/.()]*$/i.test(text3)) return "page_number";
  return inTop ? "header_uncertain" : "footer_uncertain";
}
function capturePageLayout(engine, pageIndex, paragraphs) {
  ensurePage(engine, pageIndex);
  const pageW = engine.pageWidth, pageH = engine.pageHeight;
  const objects = listObjects(engine);
  const M = engine.M;
  const types = objects.map((h) => M._FPDFPageObj_GetType(h));
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const boxes = (paragraphs || []).filter((p) => p.box).map((p) => p.box);
  const edgeBottomY = boxes.length ? Math.min(0, ...boxes.map(bottomOf)) : 0;
  const paras = (paragraphs || []).map((p) => {
    const handles = (engine.paragraphObjects(p.id) || []).map((h) => h >>> 0);
    const slots = handles.map((h) => indexOf.get(h)).filter((i) => i !== void 0).sort((a, b) => a - b);
    const baselines = (p.lines || []).map((l) => l.y).filter(Number.isFinite);
    const size3 = median2((p.runs || []).map((r) => r.size).filter((s) => s > 0));
    return {
      id: p.id,
      role: classify(p, pageH, edgeBottomY),
      editable: !!p.editable,
      sharesObjects: !!p.sharesObjects,
      box: p.box ? { ...p.box } : null,
      baselines,
      size: size3,
      handles,
      slots,
      topLevel: slots.length === handles.length
    };
  });
  for (const q of paras) {
    if (q.role === "body" || !q.box || q.baselines.length !== 1) continue;
    const y = q.baselines[0];
    const owner = paras.find((p) => {
      if (p.role !== "body" || !p.box || p.baselines.length < 3) return false;
      const gaps = p.baselines.slice(1).map((v, i) => p.baselines[i] - v);
      const pitch = median2(gaps);
      if (!(pitch > 0) || !gaps.every((g) => Math.abs(g - pitch) <= 0.1 * pitch)) return false;
      const horizontalGap = Math.max(0, p.box.x - (q.box.x + q.box.w), q.box.x - (p.box.x + p.box.w));
      const onLine = p.baselines.some((v) => Math.abs(v - y) <= Math.min(5, pitch * 0.5));
      const continuation = Math.abs(Math.min(...p.baselines) - pitch - y) <= 1.5 && Math.abs(q.box.x - p.box.x) <= 2;
      return onLine && horizontalGap <= 0.8 * pitch && (horizontalGap === 0 || q.box.w <= 2 * pitch) || continuation;
    });
    if (owner) q.role = "body";
  }
  const numbers2 = paras.filter((q) => q.role === "page_number" && q.box?.top <= edgeBottomY + pageH * EDGE_BAND);
  for (const q of paras) {
    if (q.role !== "body" || !q.box || q.baselines.length !== 1 || q.box.top > edgeBottomY + pageH * EDGE_BAND) continue;
    if (numbers2.some((n) => n.id !== q.id && n.baselines.some((y) => Math.abs(y - q.baselines[0]) <= 0.5) && hOverlap(n.box, q.box) <= 0)) q.role = "footer_uncertain";
  }
  return { pageIndex, pageW, pageH, objects, types, paras };
}
function columnOf(ctx, box) {
  let right = box.x + box.w;
  for (const q of ctx.paras) {
    if (q.role !== "body" || !q.box) continue;
    if (hOverlap(q.box, box) < 0.35 * Math.min(box.w, q.box.w)) continue;
    right = Math.max(right, q.box.x + q.box.w);
  }
  return { left: box.x, right };
}
function uprightPage(engine) {
  const M = engine.M;
  if (typeof M._FPDFPage_GetRotation === "function" && M._FPDFPage_GetRotation(engine.page) !== 0) return false;
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  return [1, 0, 0, 1, 0, 0].every((v, i) => Math.abs(t[i] - v) <= 1e-4);
}
function lastBaseline(engine, handles) {
  const M = engine.M;
  if (!handles.length || typeof M._FPDFPageObj_GetMatrix !== "function") return null;
  const p = M._malloc(24);
  try {
    let y = Infinity;
    for (const h of handles) {
      if (M._FPDFPageObj_GetType(h) !== OBJ_TEXT2 || !M._FPDFPageObj_GetMatrix(h, p)) return null;
      const [a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5].map((k) => M.HEAPF32[(p >> 2) + k]);
      if (Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4 || !(a > 0) || !(d > 0)) return null;
      y = Math.min(y, typeof engine.toModel === "function" ? engine.toModel(e, f).y : f);
    }
    return Number.isFinite(y) ? y : null;
  } finally {
    M._free(p);
  }
}
function inferPitch(ctx, t, info) {
  const own = (t.sourceLines || info?.baselines || []).map((l) => typeof l === "number" ? l : l?.y).filter(Number.isFinite);
  const gaps = [];
  for (let i = 1; i < own.length; i++) gaps.push(own[i - 1] - own[i]);
  if (gaps.length) {
    const m2 = median2(gaps);
    if (m2 > 0 && gaps.every((g) => Math.abs(g - m2) <= 0.05 * m2)) return { pitch: m2, from: "source_lines" };
    return null;
  }
  const col2 = ctx.paras.filter((q) => q.role === "body" && q.box && q.baselines.length && hOverlap(q.box, t.sourceBox) >= 0.35 * Math.min(q.box.w, t.sourceBox.w)).flatMap((q) => q.baselines).sort((a, b) => b - a);
  const size3 = info?.size || 0;
  const near7 = [];
  for (let i = 1; i < col2.length; i++) {
    const g = col2[i - 1] - col2[i];
    if (g > 0.5 && (!size3 || g < 2.6 * size3)) near7.push(g);
  }
  if (near7.length < 2) return null;
  const m = median2(near7);
  const agree = near7.filter((g) => Math.abs(g - m) <= 0.05 * m).length;
  return agree >= Math.max(2, 0.6 * near7.length) ? { pitch: m, from: "neighbour_lines" } : null;
}
function restorePitch(engine, id2, rz, pitch) {
  const lines2 = (rz.lines || []).map((l) => l.y);
  if (lines2.length < 2) return { ok: true, dyLast: 0, moved: 0 };
  const cur = median2(lines2.slice(1).map((y, i) => lines2[i] - y));
  if (Math.abs(cur - pitch) <= 0.25) return { ok: true, dyLast: 0, moved: 0 };
  const handles = (engine.paragraphObjects(id2) || []).map((h) => h >>> 0);
  const groups = lines2.map(() => []);
  for (const h of handles) {
    const b = engine.objectBounds(h);
    if (!b) return { ok: false, reason: "object_without_bounds" };
    const hits2 = lines2.map((y, k) => y >= b.y - 0.5 && y <= b.y + b.h + 0.5 ? k : -1).filter((k) => k >= 0);
    if (hits2.length !== 1) return { ok: false, reason: "object_line_ambiguous" };
    groups[hits2[0]].push(h);
  }
  let moved = 0;
  for (let k = 1; k < lines2.length; k++) {
    const dy = lines2[0] - k * pitch - lines2[k];
    if (Math.abs(dy) < 0.01) continue;
    for (const h of groups[k]) {
      engine.translateObject(h, 0, dy);
      moved++;
    }
  }
  const last = lines2.length - 1;
  return { ok: true, dyLast: lines2[0] - last * pitch - lines2[last], moved };
}
function repairPageLayout(engine, pageIndex, context2, touched, options = {}) {
  const repairs = [];
  const warnings = [];
  if (!context2 || context2.pageIndex !== pageIndex) {
    warnings.push({ code: "context_mismatch", pageIndex, severity: "error" });
    return { repairs, warnings };
  }
  ensurePage(engine, pageIndex);
  const byId = new Map(context2.paras.map((q) => [q.id, q]));
  const grown = [];
  const order = [...touched || []].filter((t) => t?.sourceBox).sort((a, b) => b.sourceBox.top - a.sourceBox.top);
  for (const t of order) {
    const info = byId.get(t.id);
    const rec = { kind: "paragraph", id: t.id, action: "kept" };
    repairs.push(rec);
    if (info && info.role !== "body") {
      warnings.push({ code: "edited_edge_paragraph", id: t.id, role: info.role, severity: "warning" });
      continue;
    }
    const handles = (engine.paragraphObjects(t.id) || []).map((h) => h >>> 0);
    const cur = unionBounds(engine, handles);
    if (!cur) {
      warnings.push({ code: "paragraph_objects_unavailable", id: t.id, severity: "error" });
      continue;
    }
    const col2 = columnOf(context2, t.sourceBox);
    const widened = cur.x + cur.w > col2.right + TOL || cur.x < t.sourceBox.x - TOL || cur.x + cur.w > context2.pageW;
    if (!widened) {
      rec.action = "kept_surgical";
      const src = (t.sourceLines || []).map((l) => l?.y).filter(Number.isFinite);
      const base = src.length ? lastBaseline(engine, handles) : null;
      const delta2 = base !== null ? Math.min(...src) - base : bottomOf(t.sourceBox) - bottomOf(cur);
      if (delta2 > 0.5) {
        rec.grown = { by: +delta2.toFixed(2), from: base !== null ? "baselines" : "bounds" };
        grown.push({ id: t.id, box: t.sourceBox, delta: delta2 });
      }
      continue;
    }
    const colW = col2.right - t.sourceBox.x;
    let width = t.sourceBox.w >= 0.85 * colW ? t.sourceBox.w : colW;
    let rz = engine.resizeParagraph(t.id, width);
    if (!rz || !rz.box) {
      warnings.push({ code: "resize_failed", id: t.id, severity: "error" });
      continue;
    }
    rec.action = "resized";
    const ink = uprightPage(engine) ? unionBounds(engine, (engine.paragraphObjects(t.id) || []).map((h) => h >>> 0)) : null;
    const over = ink ? ink.x + ink.w - (col2.right + TOL) : 0;
    const fix = over + TOL;
    if (over > 0 && !(fix <= 0.1 * width && width - fix > 0)) {
      warnings.push({ code: "ink_overshoot_unrepaired", id: t.id, overshoot: +over.toFixed(2), width: +width.toFixed(2), severity: "warning" });
    } else if (over > 0) {
      const narrower = engine.resizeParagraph(t.id, width - fix);
      if (!narrower || !narrower.box) {
        warnings.push({ code: "resize_failed", id: t.id, severity: "error" });
        continue;
      }
      rz = narrower;
      width -= fix;
      rec.narrowed = +fix.toFixed(2);
    }
    rec.width = +width.toFixed(2);
    rec.lines = rz.lines?.length || 0;
    let bottom = bottomOf(rz.box);
    const pitch = inferPitch(context2, t, info);
    if (pitch && rec.lines > 1) {
      const r = restorePitch(engine, t.id, rz, pitch.pitch);
      if (r.ok) {
        rec.pitch = { value: +pitch.pitch.toFixed(2), from: pitch.from, objects_moved: r.moved };
        bottom += r.dyLast;
        if (r.moved) warnings.push({ code: "engine_model_lines_stale", id: t.id, severity: "info" });
      } else {
        warnings.push({ code: "line_pitch_not_restored", id: t.id, reason: r.reason, severity: "warning" });
      }
    } else if (rec.lines > 1) {
      warnings.push({ code: "line_pitch_unknown", id: t.id, severity: "warning" });
    }
    const delta = bottomOf(t.sourceBox) - bottom;
    if (delta > 0.5) grown.push({ id: t.id, box: t.sourceBox, delta });
  }
  const paginate = typeof options.paginate === "function" ? options.paginate : null;
  const overflow = grown.length ? cascade(engine, context2, grown, new Set(order.map((t) => t.id)), repairs, warnings, !!paginate) : null;
  restoreSourceOrder(engine, context2, repairs, warnings);
  if (!overflow) return { repairs, warnings };
  const p = paginate(engine, context2, grown, { floor: overflow.floor });
  repairs.push(...p?.repairs ?? []);
  warnings.push(...p?.warnings ?? []);
  if (!p?.ok) return { repairs, warnings, pagination: null };
  const pagination = { added: p.added, lineCounts: p.lineCounts, keptLines: p.keptLines, bodyTop: p.bodyTop, ...p.flowTop !== void 0 ? { flowTop: p.flowTop } : {}, floor: p.floor, ...p.flowColumn ? { flowColumn: p.flowColumn } : {} };
  if (p.continuationStyle !== void 0) {
    if (!validContinuationStyle(p.continuationStyle)) {
      warnings.push({ code: "continuation_style_invalid", pageIndex, severity: "error" });
      return { repairs, warnings, pagination: null };
    }
    pagination.continuationStyle = { ...p.continuationStyle };
  }
  return { repairs, warnings, pagination };
}
function cascadeShifts(ctx, grown, { preserveSourceGaps = false } = {}) {
  const growth = new Map(grown.map((g) => [g.id, g.delta]));
  const ordered = ctx.paras.filter((q) => q.box && q.role === "body").sort((a, b) => b.box.top - a.box.top || a.box.x - b.box.x);
  const shifts = /* @__PURE__ */ new Map();
  for (let i = 0; i < ordered.length; i++) {
    const q = ordered[i];
    let shift = 0;
    for (const prev of ordered.slice(0, i)) {
      const displacement = (shifts.get(prev.id) || 0) + (growth.get(prev.id) || 0);
      if (displacement <= 0.01) continue;
      const overlap = hOverlap(prev.box, q.box);
      const prevLines = prev.baselines || [], lines2 = q.baselines || [];
      const horizontalGap = Math.max(0, -overlap);
      const inline = prevLines.length > 1 && lines2.some((y) => prevLines.some((v) => Math.abs(y - v) <= 1.5)) && horizontalGap <= Math.max(8, 0.8 * Math.max(prev.size || 0, q.size || 0)) && (horizontalGap === 0 || Math.min(prev.box.w, q.box.w) <= 2 * Math.max(prev.size || 0, q.size || 0, 10));
      if (inline) {
        shift = Math.max(shift, displacement);
        continue;
      }
      if (overlap < 0.35 * Math.min(prev.box.w, q.box.w)) continue;
      const metricOverlap = q.box.top - bottomOf(prev.box);
      if (metricOverlap > 0.5 && !(metricOverlap <= 2 && prevLines.length && lines2.length && Math.max(...lines2) < Math.min(...prevLines) - 0.5)) continue;
      const gap = Math.max(0, -metricOverlap);
      const needed = displacement - gap;
      const reserved = displacement - Math.max(0, gap - 2);
      shift = Math.max(shift, preserveSourceGaps && needed > 0.01 ? reserved : needed);
    }
    if (shift > 0.01) shifts.set(q.id, shift);
  }
  return shifts;
}
function cascadeBarrier(engine, ctx, grown, shifts) {
  const bodyHandles = new Set(ctx.paras.filter((q) => q.role === "body").flatMap((q) => (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0)));
  const fixed = listObjects(engine).filter((h) => !bodyHandles.has(h)).map((h) => engine.objectBounds(h));
  if (fixed.some((b) => !b)) return grown[0]?.id ?? "unknown";
  const intersects3 = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01;
  for (const q of ctx.paras) {
    if (!q.box || q.role !== "body") continue;
    const shift = shifts.get(q.id) || 0;
    const delta = grown.find((g) => g.id === q.id)?.delta || 0;
    if (!(shift > 0 || delta > 0)) continue;
    const sweep = { x: q.box.x, y: bottomOf(q.box) - shift - delta, w: q.box.w, h: q.box.h + shift + delta };
    const original = { x: q.box.x, y: bottomOf(q.box) - TOL, w: q.box.w, h: q.box.h + 2 * TOL };
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (fixed.some((b) => intersects3(sweep, b) && area(sweep, b) > area(original, b) + 0.01)) return q.id;
  }
  return null;
}
function cascadeFloor(ctx) {
  const edgeTops = ctx.paras.filter((q) => q.box && q.role !== "body" && q.box.top < ctx.pageH / 2).map((q) => q.box.top);
  const bodyBottoms = ctx.paras.filter((q) => q.box && q.role === "body").map((q) => bottomOf(q.box));
  const pageBottom = Math.min(...ctx.paras.filter((q) => q.box).map((q) => bottomOf(q.box)));
  return edgeTops.length ? Math.max(Math.max(...edgeTops) + 2, Math.min(pageBottom + EDGE_BAND * ctx.pageH, ...bodyBottoms)) : Math.min(ctx.pageH * EDGE_BAND, ...bodyBottoms);
}
function reserveCascadeSpace(engine, ctx, grown, { targetHandles = [] } = {}) {
  const fail8 = (code) => ({ ok: false, code });
  const validBox = (b) => b && [b.x, b.top, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
  if (!ctx || !Number.isFinite(ctx.pageH) || ctx.pageH <= 0 || !Array.isArray(ctx.paras) || !Array.isArray(grown) || grown.length !== 1 || ctx.paras.some((q) => q.box && !validBox(q.box)) || grown.some((g) => !validBox(g?.box) || !Number.isFinite(g.delta) || g.delta <= 0 || !ctx.paras.some((q) => q.id === g.id && q.role === "body"))) return fail8("reserve_invalid");
  if (!uprightPage(engine)) return fail8("reserve_transform_unsupported");
  const live = new Set(listObjects(engine));
  if (!Array.isArray(targetHandles) || targetHandles.some((h) => !live.has(h >>> 0) || engine.M._FPDFPageObj_GetType(h) !== OBJ_TEXT2)) return fail8("reserve_target_invalid");
  const shifts = cascadeShifts(ctx, grown, { preserveSourceGaps: true }), floor = cascadeFloor(ctx);
  const moved = ctx.paras.filter((q) => shifts.has(q.id));
  if (moved.some((q) => !q.editable || q.sharesObjects || !q.topLevel || !q.handles?.length || q.handles.some((h) => !live.has(h >>> 0)))) return fail8("reserve_objects_unavailable");
  const handles = moved.flatMap((q) => q.handles.map((h) => h >>> 0));
  if (new Set(handles).size !== handles.length || handles.some((h) => targetHandles.includes(h))) return fail8("reserve_shared_objects");
  if (moved.some((q) => bottomOf(q.box) - shifts.get(q.id) < floor - 0.01) || grown.some((g) => bottomOf(g.box) - g.delta - (shifts.get(g.id) || 0) < floor - 0.01)) return fail8("reserve_no_room");
  const lookup = new Map(ctx.paras.map((q) => [q.id, (q.handles || []).filter((h) => live.has(h >>> 0))]));
  lookup.set(grown[0].id, [...lookup.get(grown[0].id) || [], ...targetHandles]);
  const view = Object.create(engine);
  view.paragraphObjects = (id2) => lookup.get(id2) || [];
  if (cascadeBarrier(view, ctx, grown, shifts) !== null) return fail8("reserve_foreign_object");
  const next = { ...ctx, paras: ctx.paras.map((q) => {
    const dy = shifts.get(q.id) || 0;
    return dy ? { ...q, box: { ...q.box, top: q.box.top - dy }, baselines: q.baselines?.map((y) => y - dy) } : q;
  }) };
  if (!handles.length) return { ok: true, context: next, shifts, rollback: () => true };
  if (!["historyDepth", "historyBeginStep", "historyEndStep", "historyNoteMatrix", "historyUndo", "translateObject"].every((k) => typeof engine[k] === "function")) return fail8("reserve_history_unavailable");
  const depth = engine.historyDepth().undo;
  const translated = [];
  engine.historyBeginStep("falsify-reserve-flow");
  try {
    for (const q of moved) for (const h of q.handles) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, 0, -shifts.get(q.id));
      translated.push([h, shifts.get(q.id)]);
    }
  } catch (error2) {
    for (const [h, dy] of translated.reverse()) engine.translateObject(h, 0, dy);
    throw error2;
  } finally {
    engine.historyEndStep();
  }
  if (engine.historyDepth().undo !== depth + 1) {
    for (const [h, dy] of translated.reverse()) engine.translateObject(h, 0, dy);
    return fail8("reserve_history_unavailable");
  }
  let pending = true;
  return { ok: true, context: next, shifts, rollback: () => {
    if (!pending || engine.historyDepth().undo !== depth + 1) return false;
    pending = false;
    return engine.historyUndo();
  } };
}
function cascade(engine, ctx, grown, touchedIds, repairs, warnings, allowOverflow = false) {
  const floor = cascadeFloor(ctx);
  const plan = cascadeShifts(ctx, grown);
  for (const [id2] of plan) {
    const q = ctx.paras.find((p) => p.id === id2);
    if (!q.editable || q.sharesObjects) {
      warnings.push({ code: "pagination_unsupported_shared_objects", id: id2, severity: "error" });
      return null;
    }
  }
  const violations = [];
  for (const [id2, dy] of plan) {
    const q = ctx.paras.find((p) => p.id === id2);
    if (bottomOf(q.box) - dy < floor - 0.01) violations.push(id2);
  }
  for (const g of grown) if (bottomOf(g.box) - g.delta - (plan.get(g.id) || 0) < floor - 0.01) violations.push(g.id);
  if (violations.length) {
    if (allowOverflow) {
      warnings.push({ code: "pagination_required", severity: "info", paragraphs: violations, floor: +floor.toFixed(2) });
      repairs.push({ kind: "cascade", action: "deferred_to_pagination", moved: 0 });
      return { floor };
    }
    warnings.push({ code: "pagination_unsupported", severity: "error", paragraphs: violations, floor: +floor.toFixed(2) });
    repairs.push({ kind: "cascade", action: "skipped_no_room", moved: 0 });
    return null;
  }
  const barrier = cascadeBarrier(engine, ctx, grown, plan);
  if (barrier !== null) {
    warnings.push({ code: "pagination_unsupported_foreign_object_in_flow", id: barrier, severity: "error" });
    repairs.push({ kind: "cascade", action: "rejected_foreign_object", moved: 0 });
    return null;
  }
  let moved = 0;
  for (const [id2, dy] of plan) {
    if (!engine.moveParagraph(id2, 0, -dy)) {
      warnings.push({ code: "move_failed", id: id2, severity: "error" });
      continue;
    }
    if (touchedIds.has(id2)) warnings.push({ code: "moved_edited_paragraph", id: id2, severity: "info" });
    moved++;
  }
  repairs.push({ kind: "cascade", action: "shifted", moved, floor: +floor.toFixed(2) });
  return null;
}
function restoreSourceOrder(engine, ctx, repairs, warnings) {
  const M = engine.M;
  const current = listObjects(engine);
  const present = new Set(current);
  const ownerOfSource = /* @__PURE__ */ new Map();
  for (const q of ctx.paras) for (const h of q.handles) {
    if (ownerOfSource.has(h) && ownerOfSource.get(h) !== q.id) {
      warnings.push({ code: "object_shared_between_paragraphs", id: q.id, severity: "warning" });
      repairs.push({ kind: "reading_order", action: "skipped", reason: "object_shared_between_paragraphs" });
      return;
    }
    ownerOfSource.set(h, q.id);
  }
  const changed = [];
  const claimed = /* @__PURE__ */ new Map();
  const fail8 = (code, extra) => {
    warnings.push({ code, severity: "warning", ...extra });
    repairs.push({ kind: "reading_order", action: "skipped", reason: code });
  };
  for (const q of ctx.paras) {
    const now = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    for (const h of now) {
      if (claimed.has(h) && claimed.get(h) !== q.id) return fail8("object_shared_between_paragraphs", { id: q.id });
      claimed.set(h, q.id);
    }
    const same = now.length === q.handles.length && now.every((h, i) => h === q.handles[i]);
    if (same) continue;
    if (!q.topLevel || now.some((h) => !present.has(h))) return fail8("paragraph_not_top_level", { id: q.id });
    if (q.sharesObjects) return fail8("paragraph_shares_objects", { id: q.id });
    if (!q.slots.length) return fail8("paragraph_without_source_slot", { id: q.id });
    const lo = q.slots[0], hi = q.slots[q.slots.length - 1];
    const interleaved = ctx.objects.slice(lo, hi + 1).some((h) => ownerOfSource.get(h) !== q.id);
    for (const h of now) {
      const o = ownerOfSource.get(h);
      if (o !== void 0 && o !== q.id) return fail8("handle_identity_reused", { id: q.id });
      if (o === void 0 && ctx.objects.includes(h)) return fail8("handle_identity_reused", { id: q.id });
    }
    if (interleaved) warnings.push({ code: "interleaved_source_overlay_order", id: q.id, severity: "warning" });
    const source2 = ctx.objects.filter((h) => ownerOfSource.get(h) === q.id);
    const survivors = source2.filter((h) => now.includes(h));
    const currentSurvivors = now.filter((h) => source2.includes(h));
    if (survivors.length !== currentSurvivors.length || survivors.some((h, i) => h !== currentSurvivors[i])) {
      return fail8("surviving_source_order_ambiguous", { id: q.id });
    }
    const insertions = /* @__PURE__ */ new Map();
    let srcStart = 0, nowStart = 0;
    for (const anchor of [...survivors, null]) {
      const srcEnd = anchor === null ? source2.length : source2.indexOf(anchor, srcStart);
      const nowEnd = anchor === null ? now.length : now.indexOf(anchor, nowStart);
      const deleted = source2.slice(srcStart, srcEnd);
      const fresh = now.slice(nowStart, nowEnd);
      if (fresh.length && !deleted.length) return fail8("replacement_without_source_slot", { id: q.id });
      if (fresh.length) {
        const slot = interleaved ? deleted[deleted.length - 1] : deleted[0];
        insertions.set(slot, fresh);
      }
      srcStart = srcEnd + 1;
      nowStart = nowEnd + 1;
    }
    changed.push({ id: q.id, insertions, survivors: new Set(survivors) });
  }
  if (!changed.length) {
    repairs.push({ kind: "reading_order", action: "unchanged", moved: 0 });
    return;
  }
  const changedIds = new Set(changed.map((c) => c.id));
  const byId = new Map(changed.map((c) => [c.id, c]));
  const desired = [];
  for (const h of ctx.objects) {
    const c = byId.get(ownerOfSource.get(h));
    if (c) {
      if (c.insertions.has(h)) desired.push(...c.insertions.get(h));
      if (c.survivors.has(h)) desired.push(h);
      continue;
    }
    if (!present.has(h)) continue;
    if (claimed.has(h) && changedIds.has(claimed.get(h))) continue;
    desired.push(h);
  }
  const desiredSet = new Set(desired);
  const unmapped = current.filter((h) => !desiredSet.has(h));
  if (unmapped.length || desired.length !== current.length) {
    return fail8("unmapped_new_objects", { count: unmapped.length });
  }
  const lost = ctx.objects.filter((h) => !present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  if (lost.length) return fail8("unrelated_object_missing", { count: lost.length });
  const typesBefore = current.filter((h) => !claimedText(M, h)).map((h) => h);
  const work = [...current];
  let moves = 0;
  for (let i = 0; i < desired.length; i++) {
    if (work[i] === desired[i]) continue;
    const j = work.indexOf(desired[i], i + 1);
    const h = desired[i];
    if (j < 0 || !M._FPDFPage_RemoveObject(engine.page, h)) {
      warnings.push({ code: "reorder_remove_failed", severity: "error" });
      break;
    }
    work.splice(j, 1);
    if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, i)) {
      M._FPDFPage_InsertObject(engine.page, h);
      work.push(h);
      warnings.push({ code: "reorder_insert_failed", severity: "error" });
      break;
    }
    work.splice(i, 0, h);
    moves++;
  }
  if (moves) engine._pageDirty = true;
  const after = listObjects(engine);
  const nonText = (list3) => list3.filter((h) => !claimedText(M, h));
  const stackKept = nonText(after).join(",") === typesBefore.join(",");
  const exact = after.length === desired.length && after.every((h, i) => h === desired[i]);
  if (!exact) warnings.push({ code: "reading_order_not_exact", severity: "error" });
  if (!stackKept) warnings.push({ code: "nontext_order_changed", severity: "error" });
  const appended = changed.filter((c) => {
    const last = Math.max(...ctx.paras.find((q) => q.id === c.id).slots);
    return ctx.objects.slice(last + 1).some((h) => present.has(h) && !changedIds.has(ownerOfSource.get(h)));
  });
  if (appended.length) {
    warnings.push({
      code: "content_stream_append_order",
      severity: "warning",
      verification: "saved_text_order_required",
      paragraphs: appended.map((c) => c.id)
    });
  }
  repairs.push({
    kind: "reading_order",
    action: appended.length ? "index_only_stream_order_unresolved" : moves ? "restored" : "unchanged",
    moved: moves,
    paragraphs: changed.map((c) => c.id)
  });
}
function claimedText(M, h) {
  return M._FPDFPageObj_GetType(h) === OBJ_TEXT2;
}
function readStyle(M, tp, i, buf) {
  const n = M._FPDFText_GetFontInfo(tp, i, buf, 128, buf + 128);
  const font = n > 0 && n <= 128 ? M.UTF8ToString(buf, 128) : null;
  const flags = M.HEAP32[buf + 128 >> 2];
  const rgba = (fn, at) => M[fn](tp, i, at, at + 4, at + 8, at + 12) ? [0, 1, 2, 3].map((k) => M.HEAPU32[(at >> 2) + k]) : null;
  const fill = rgba("_FPDFText_GetFillColor", buf + 144);
  const stroke = rgba("_FPDFText_GetStrokeColor", buf + 160);
  const f32 = (at, k) => M.HEAPF32[(at >> 2) + k];
  const mat = M._FPDFText_GetMatrix(tp, i, buf + 176) ? [0, 1, 2, 3].map((k) => f32(buf + 176, k)) : null;
  const origin = M._FPDFText_GetCharOrigin(tp, i, buf + 208, buf + 216) ? [M.HEAPF64[buf + 208 >> 3], M.HEAPF64[buf + 216 >> 3]] : null;
  const loose = M._FPDFText_GetLooseCharBox(tp, i, buf + 224) ? [f32(buf + 224, 0), f32(buf + 224, 2)] : null;
  const obj = M._FPDFText_GetTextObject(tp, i) >>> 0;
  const render = obj ? M._FPDFTextObj_GetTextRenderMode(obj) : null;
  return { obj, origin, loose, style: { font, flags, size: M._FPDFText_GetFontSize(tp, i), fill, stroke, render, mat } };
}
function sameStyle(a, b) {
  if (!a || !b) return a === b;
  const eq = (x, y, tol = 0) => x === null || y === null ? x === y : x.every((v, k) => Math.abs(v - y[k]) <= tol);
  const transform = (s) => s.mat && Number.isFinite(s.size) && s.size > 0 ? s.mat.map((v) => v * s.size) : null;
  const matrixEqual = a.mat && b.mat ? eq(transform(a), transform(b), 0.01) : a.mat === b.mat && Math.abs(a.size - b.size) <= 0.01;
  return a.font !== null && a.font === b.font && a.flags === b.flags && a.render === b.render && eq(a.fill, b.fill) && eq(a.stroke, b.stroke) && matrixEqual;
}
function readGlyphs(engine, pageIndex) {
  ensurePage(engine, pageIndex);
  const M = engine.M;
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const styled = STYLE_FNS.every((f) => typeof M[f] === "function") && typeof M.UTF8ToString === "function";
  const b = M._malloc(32);
  const sb = styled ? M._malloc(256) : 0;
  let text3 = "";
  const glyphs2 = [];
  const chars = [];
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    text3 += String.fromCharCode(u);
    if (u <= 32 || !M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24)) {
      const box = M._FPDFText_GetCharBox(tp, i, b, b + 8, b + 16, b + 24) ? [0, 8, 16, 24].map((k) => M.HEAPF64[b + k >> 3]) : null;
      const origin = typeof M._FPDFText_GetCharOrigin === "function" && M._FPDFText_GetCharOrigin(tp, i, b, b + 8) ? [M.HEAPF64[b >> 3], M.HEAPF64[b + 8 >> 3]] : null;
      chars.push({
        u,
        cy: null,
        box,
        origin,
        generated: typeof M._FPDFText_IsGenerated === "function" && M._FPDFText_IsGenerated(tp, i) === 1,
        discretionary: typeof M._FPDFText_IsHyphen === "function" && M._FPDFText_IsHyphen(tp, i) === 1
      });
      continue;
    }
    const l = M.HEAPF64[b >> 3], r = M.HEAPF64[b + 8 >> 3];
    const bo = M.HEAPF64[b + 16 >> 3], t = M.HEAPF64[b + 24 >> 3];
    glyphs2.push(styled ? { u, l, r, b: bo, t, i, ...readStyle(M, tp, i, sb) } : { u, l, r, b: bo, t, i });
    chars.push({ u, cy: (bo + t) / 2, cx: (l + r) / 2 });
  }
  M._free(b);
  if (sb) M._free(sb);
  if (tp) M._FPDFText_ClosePage(tp);
  return {
    text: text3,
    glyphs: glyphs2,
    chars,
    styled,
    W: M._FPDF_GetPageWidthF(engine.page),
    H: M._FPDF_GetPageHeightF(engine.page),
    frame: { rotation: M._FPDFPage_GetRotation?.(engine.page) ?? null, transform: engine.pageT ? [...engine.pageT] : null }
  };
}
function offPage(g) {
  return g.glyphs.filter((c) => c.r > g.W + 0.5 || c.l < -0.5 || c.b < -0.5 || c.t > g.H + 0.5).length;
}
function overlaps(g, adjacentKerning = false) {
  const cell = 12;
  const grid = /* @__PURE__ */ new Map();
  let count = 0;
  g.glyphs.forEach((c, i) => {
    const area = Math.max(0.01, (c.r - c.l) * (c.t - c.b));
    const seen = /* @__PURE__ */ new Set();
    for (let x = Math.floor(c.l / cell); x <= Math.floor(c.r / cell); x++) {
      for (let y = Math.floor(c.b / cell); y <= Math.floor(c.t / cell); y++) {
        const key3 = x + ":" + y;
        for (const j of grid.get(key3) || []) {
          if (seen.has(j)) continue;
          seen.add(j);
          const d = g.glyphs[j];
          if (adjacentKerning && Math.abs(c.i - d.i) === 1 && Math.abs(c.b - d.b) <= 0.5) continue;
          const iw = Math.min(c.r, d.r) - Math.max(c.l, d.l);
          const ih = Math.min(c.t, d.t) - Math.max(c.b, d.b);
          if (iw <= 0 || ih <= 0) continue;
          const other = Math.max(0.01, (d.r - d.l) * (d.t - d.b));
          if (iw * ih > 0.3 * Math.min(area, other)) count++;
        }
        if (!grid.has(key3)) grid.set(key3, []);
        grid.get(key3).push(i);
      }
    }
  });
  return count;
}
function edgeGlyphs(g) {
  if (!g.glyphs.length) return [];
  const lo = Math.min(...g.glyphs.map((c) => c.b));
  const hi = Math.max(...g.glyphs.map((c) => c.t));
  const band = EDGE_BAND * g.H;
  const inBottom = (c) => (c.b + c.t) / 2 <= lo + band;
  const inTop = (c) => (c.b + c.t) / 2 >= hi - band;
  const keep = /* @__PURE__ */ new Set();
  for (const line of glyphLines(g.glyphs)) {
    if (line.every(inBottom) || line.every(inTop)) for (const c of line) keep.add(c);
  }
  return g.glyphs.filter((c) => keep.has(c));
}
function bodyBoxes(engine, pageIndex, g) {
  ensurePage(engine, pageIndex);
  if (typeof engine.buildModel !== "function" || !uprightPage(engine) || !g.glyphs.length) return null;
  const paras = engine.buildModel();
  const boxes = paras.filter((p) => p.box).map((p) => p.box);
  const edgeBottomY = boxes.length ? Math.min(0, ...boxes.map(bottomOf)) : 0;
  return paras.filter((p) => p.box && classify(p, engine.pageHeight, edgeBottomY) === "body").map((p) => p.box);
}
function edgeBodySplit(src, out, i, oi, s, o, es, eo) {
  const sb = bodyBoxes(src, i, s), ob = bodyBoxes(out, oi, o);
  if (!sb || !ob) return null;
  const matches = alignEdgeGlyphs(es, eo);
  let bodyChanged = 0, edgeMissing = 0, edgeAdded = 0, edgeStyleChanged = 0;
  for (const c of matches.missing) {
    if (inBoxes(c, sb)) bodyChanged++;
    else edgeMissing++;
  }
  for (const d of matches.added) {
    if (inBoxes(d, ob) || inBoxes(d, sb)) bodyChanged++;
    else edgeAdded++;
  }
  for (const [c] of matches.restyled) {
    if (inBoxes(c, sb)) bodyChanged++;
    else edgeStyleChanged++;
  }
  return { bodyChanged, edgeMissing, edgeAdded, edgeStyleChanged };
}
function authorizedEdgeChanges(source2, output, edits, es, eo, body = []) {
  let exp = expectedPageText(source2.text, edits, { includeSpans: true });
  let sn = normalizedSourceChars(source2.chars), on = normalizedSourceChars(output.chars);
  if (!exp.ok || on.map((c) => c.ch).join("") !== exp.text) {
    const verified = compareSourceGeometry(source2, output, edits, { expectedPageText });
    if (!verified.ok || !verified.match) return false;
    const a = canonicalPage(source2), b = canonicalPage(output, a.partition);
    if (!a.ok || !b.ok) return false;
    const normalize2 = (chars) => normalizedSourceChars(chars).map((c) => ({ ...c, sourceIndex: c.sourceIndex === void 0 ? void 0 : chars[c.sourceIndex].i }));
    sn = normalize2(a.chars);
    on = normalize2(b.chars);
    exp = expectedPageText(a.text, edits, { includeSpans: true });
  }
  if (!exp.ok || on.map((c) => c.ch).join("") !== exp.text) return false;
  const sourceIndices = /* @__PURE__ */ new Set(), outputIndices = /* @__PURE__ */ new Set(), shiftedPairs = [];
  const sourceGlyph = new Map(source2.glyphs.map((c) => [c.i, c]));
  const outputGlyph = new Map(output.glyphs.map((c) => [c.i, c]));
  let delta = 0;
  for (const span of exp.spans) {
    const before = sn.slice(span.a, span.b).map((c) => c.ch).join("");
    const after = span.after;
    let prefix = 0, suffix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    for (const c of sn.slice(span.a, span.b)) if (c.sourceIndex !== void 0) sourceIndices.add(c.sourceIndex);
    const start = span.a + delta;
    const changed = sn.slice(span.a + prefix, span.b - suffix).map((c) => sourceGlyph.get(c.sourceIndex)).filter(Boolean);
    const nextSpan = exp.spans.find((s) => s.a >= span.b && s !== span);
    const retainedEnd = nextSpan?.a ?? sn.length;
    let previous = changed.at(-1);
    for (let k = span.b - suffix; k < retainedEnd; k++) {
      const a = sourceGlyph.get(sn[k]?.sourceIndex);
      const b = outputGlyph.get(on[start + after.length - suffix + k - (span.b - suffix)]?.sourceIndex);
      if (!a || !b) continue;
      if (!previous?.origin || !a.origin || Math.abs(previous.origin[1] - a.origin[1]) > 0.1 || source2.chars.slice(previous.i + 1, a.i).some((c) => c.u === 10 || c.u === 13) || a.l - previous.r > (previous.style?.size || 0) * 2) break;
      previous = a;
      const dx = b.l - a.l;
      if (k < span.b && Math.abs(dx) > 1 && changed.some((c) => c.origin && b.origin && Math.abs(c.origin[1] - b.origin[1]) <= 0.1) && b.l >= Math.min(...changed.map((c) => c.l)) - 1 && b.r <= Math.max(a.r, ...changed.map((c) => c.r)) + 1) {
        sourceIndices.add(a.i);
        outputIndices.add(b.i);
        continue;
      }
      if (a.u === b.u && Math.abs(dx) > 0.5 && Math.abs(dx) <= 1 && Math.abs(b.r - a.r - dx) <= 0.1 && Math.abs(a.b - b.b) <= 0.1 && Math.abs(a.t - b.t) <= 0.1 && sameStyle(a.style, b.style)) shiftedPairs.push({ a, b, dx });
    }
    for (const c of on.slice(start, start + after.length)) if (c.sourceIndex !== void 0) outputIndices.add(c.sourceIndex);
    delta += after.length - (span.b - span.a);
  }
  const sourceDiff = alignEdgeGlyphs(es, output.glyphs);
  const outputDiff = alignEdgeGlyphs(source2.glyphs, eo);
  const reflowSource = /* @__PURE__ */ new Set(), reflowOutput = /* @__PURE__ */ new Set();
  const editedGlyphs = [...sourceIndices].map((i) => sourceGlyph.get(i)).filter(Boolean);
  for (const box of body) {
    if (!editedGlyphs.length || editedGlyphs.some((c) => !inBoxes(c, [box]) || body.filter((b) => inBoxes(c, [b])).length !== 1)) continue;
    const members = source2.glyphs.filter((c) => inBoxes(c, [box]) && !sourceIndices.has(c.i));
    if (members.some((c) => body.filter((b) => inBoxes(c, [b])).length !== 1)) continue;
    const ids = new Set(members.map((c) => c.i)), pairs = [];
    for (let k = 0; k < sn.length; k++) {
      const a = sourceGlyph.get(sn[k].sourceIndex);
      if (!a || !ids.has(a.i)) continue;
      let offset = 0;
      for (const span of exp.spans) if (span.b <= k) offset += span.after.length - (span.b - span.a);
      const b = outputGlyph.get(on[k + offset]?.sourceIndex);
      if (!b || a.u !== b.u || !sameStyle(a.style, b.style)) {
        pairs.length = 0;
        break;
      }
      pairs.push([a, b]);
    }
    if (pairs.length !== members.length) continue;
    const placed = [...pairs.map(([, b]) => b), ...[...outputIndices].map((i) => outputGlyph.get(i)).filter(Boolean)];
    const original = source2.glyphs.filter((c) => inBoxes(c, [box]));
    if (!placed.length || !original.length) continue;
    const size3 = Math.max(...original.map((c) => c.style?.size || 0));
    const ys = [...new Set(placed.map((c) => Math.round((c.origin?.[1] ?? c.b) * 10) / 10))].sort((a, b) => b - a);
    const sourceTop = Math.max(...original.map((c) => c.t));
    if (!(size3 > 0) || Math.abs(Math.max(...placed.map((c) => c.t)) - sourceTop) > size3 || ys.some((y, k) => k && ys[k - 1] - y > size3 * 2.5)) continue;
    for (const [a, b] of pairs) {
      reflowSource.add(a.i);
      reflowOutput.add(b.i);
    }
  }
  const edited = [...sourceIndices].map((i) => sourceGlyph.get(i)).filter(Boolean);
  const movedSource = /* @__PURE__ */ new Set(), movedOutput = /* @__PURE__ */ new Set();
  if (edited.length) for (const box of body) {
    if (!edited.some((c) => c.b >= box.top && c.l <= box.x + box.w && c.r >= box.x)) continue;
    const members = source2.glyphs.filter((c) => inBoxes(c, [box]));
    if (!members.length || members.some((c) => sourceIndices.has(c.i) || body.filter((b) => inBoxes(c, [b])).length !== 1)) continue;
    const memberIds = new Set(members.map((c) => c.i));
    const pairs = [];
    for (let k = 0; k < sn.length; k++) {
      const a = sourceGlyph.get(sn[k].sourceIndex);
      if (!a || !memberIds.has(a.i)) continue;
      let offset = 0;
      for (const span of exp.spans) if (span.b <= k) offset += span.after.length - (span.b - span.a);
      const b = outputGlyph.get(on[k + offset]?.sourceIndex);
      if (!b || a.u !== b.u || !sameStyle(a.style, b.style)) {
        pairs.length = 0;
        break;
      }
      pairs.push([a, b]);
    }
    if (pairs.length !== members.length) continue;
    const dy = pairs[0][1].b - pairs[0][0].b;
    if (dy >= -0.5 || pairs.some(([a, b]) => Math.abs(b.l - a.l) > 0.1 || Math.abs(b.r - a.r) > 0.1 || Math.abs(b.b - a.b - dy) > 0.1 || Math.abs(b.t - a.t - dy) > 0.1)) continue;
    for (const [a, b] of pairs) {
      movedSource.add(a.i);
      movedOutput.add(b.i);
    }
  }
  const shifts = shiftedPairs.map((p) => p.dx);
  if (shifts.length && Math.max(...shifts) - Math.min(...shifts) > 0.1) return false;
  return sourceDiff.missing.every((c) => sourceIndices.has(c.i) || reflowSource.has(c.i) || movedSource.has(c.i) || shiftedPairs.some((p) => p.a.i === c.i)) && outputDiff.added.every((c) => outputIndices.has(c.i) || reflowOutput.has(c.i) || movedOutput.has(c.i) || shiftedPairs.some((p) => p.b.i === c.i)) && sourceDiff.restyled.every(([c]) => sourceIndices.has(c.i)) && outputDiff.restyled.every(([, c]) => outputIndices.has(c.i));
}
function extents(g) {
  if (!g.glyphs.length) return null;
  return { left: Math.min(...g.glyphs.map((c) => c.l)), right: Math.max(...g.glyphs.map((c) => c.r)) };
}
function expectedPageText(sourceText, pageEdits, options = {}) {
  const norm = normStr(sourceText);
  let matchText = "";
  const matchMap = [];
  for (let i = 0; i < norm.length; i++) {
    const expanded = norm[i] === "" ? norm[i + 1] === " " ? "-" : "- " : norm[i];
    matchText += expanded;
    for (let j = 0; j < expanded.length; j++) matchMap.push(i);
  }
  let logicalText = "";
  const logicalMap = [];
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] === "") {
      if (norm[i + 1] === " ") i++;
      continue;
    }
    logicalText += norm[i];
    logicalMap.push(i);
  }
  const spans = [];
  for (const e of pageEdits) {
    const needle = normStr(e.before);
    const candidates = /* @__PURE__ */ new Map();
    for (const [text3, map] of [[matchText, matchMap], [logicalText, logicalMap]]) {
      for (let k = needle ? text3.indexOf(needle) : -1; k >= 0; k = text3.indexOf(needle, k + 1)) {
        const a = map[k], b = map[k + needle.length - 1] + 1;
        candidates.set(a + ":" + b, { a, b, after: normStr(e.after), id: e.id });
      }
    }
    if (candidates.size !== 1) return { ok: false, id: e.id, reason: candidates.size ? "before_ambiguous" : "before_not_found" };
    spans.push(candidates.values().next().value);
  }
  spans.sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].a < spans[i - 1].b) return { ok: false, id: spans[i].id, reason: "edits_overlap" };
  }
  let out = "", at = 0;
  for (const s of spans) {
    out += norm.slice(at, s.a) + s.after;
    at = s.b;
  }
  return { ok: true, text: normStr(out + norm.slice(at)), ...options.includeSpans ? { spans: spans.map((s) => ({ ...s })) } : {} };
}
function modelNumericEditProof(source2, output, edits, paragraphs) {
  return modelInlineEditProof(source2, output, edits, paragraphs, "numeric");
}
function modelWordEditProof(source2, output, edits, paragraphs) {
  return modelInlineEditProof(source2, output, edits, paragraphs, "word");
}
function modelInlineEditProof(source2, output, edits, paragraphs, kind) {
  if (edits.length !== 1 || !Array.isArray(paragraphs)) return null;
  if ([...source2.chars, ...output.chars].some((c) => !Number.isInteger(c.u) || c.u < 0 || c.u > 1114111)) return null;
  const e = edits[0], before = normStr(e.before), after = normStr(e.after);
  if (!before) return null;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
  const changed = after.slice(prefix, after.length - suffix);
  const alphabet = kind === "word" ? /^[A-Za-z]*$/ : /^\d*$/;
  if (!alphabet.test(before.slice(prefix, before.length - suffix)) || !alphabet.test(changed) || !changed) return null;
  let start = prefix, end = before.length - suffix;
  const member = kind === "word" ? /[A-Za-z]/ : /[0-9]/;
  while (start > 0 && member.test(before[start - 1])) start--;
  while (end < before.length && member.test(before[end])) end++;
  const old = before.slice(start, end);
  if (!(kind === "word" ? /^[A-Za-z]{2,}$/ : /^[0-9]+$/).test(old)) return null;
  const replacement = before.slice(start, prefix) + changed + before.slice(before.length - suffix, end);
  const hits2 = [];
  for (const p2 of paragraphs) {
    const text4 = normStr(paraText(p2));
    for (let k = text4.indexOf(before); k >= 0; k = text4.indexOf(before, k + 1)) hits2.push({ p: p2, text: text4, k });
  }
  if (hits2.length !== 1 || !hits2[0].p.box) return null;
  const { p, text: text3, k: hit } = hits2[0], box = p.box, tokens2 = [];
  source2.chars.forEach((c, index) => {
    const ch = String.fromCodePoint(c.u);
    if (/\s/.test(ch)) {
      if (tokens2.at(-1)?.ch === " ") tokens2.at(-1).optional &&= c.generated === true;
      else tokens2.push({ ch: " ", optional: c.generated === true });
    } else tokens2.push({ ch, index });
  });
  let anchored = null;
  const max = Math.max(start, before.length - end);
  for (let n = 0; n <= max; n++) {
    const left = Math.min(start, n), right = Math.min(before.length - end, n);
    const context2 = before.slice(start - left, end + right);
    const modelAt = hit + start - left;
    if (text3.indexOf(context2) !== modelAt || text3.indexOf(context2, modelAt + 1) !== -1) continue;
    const candidates = [];
    for (let first = 0; first < tokens2.length; first++) {
      if (tokens2[first].ch !== context2[0]) continue;
      let at = 0, ids = [];
      for (let j2 = first; j2 < tokens2.length && at < context2.length; j2++) {
        const token = tokens2[j2];
        if (token.ch === context2[at]) {
          if (at >= left && at < left + old.length) ids.push(token.index);
          at++;
        } else if (!(token.ch === " " && token.optional)) break;
      }
      if (at !== context2.length || ids.length !== old.length || ids.some((index) => {
        const c = source2.chars[index];
        return !c || !Number.isFinite(c.cx) || !Number.isFinite(c.cy) || c.cx < box.x || c.cx > box.x + box.w || c.cy < box.top - box.h || c.cy > box.top;
      })) continue;
      candidates.push(ids);
    }
    if (candidates.length === 1) {
      anchored = candidates[0];
      break;
    }
  }
  if (!anchored) return null;
  const remove = new Set(anchored);
  const sourceChars = source2.chars.flatMap((c, i2) => i2 === anchored[0] ? [...replacement].map((ch) => ({ u: ch.codePointAt(0), replacement: true })) : remove.has(i2) ? [] : [{ u: c.u, generated: c.generated, sourceIndex: i2 }]);
  const a = generatedWhitespaceTokens(sourceChars, true, true), b = generatedWhitespaceTokens(output.chars, true, true);
  const outputIndices = [], retained = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].ch === b[j].ch) {
      if (a[i].ch !== " ") {
        const c = sourceChars[a[i].index];
        if (c.replacement) outputIndices.push(b[j].index);
        else retained.push({ sourceIndex: c.sourceIndex, outputIndex: b[j].index });
      }
      i++;
      j++;
    } else if (a[i].ch === " " && a[i].optional) i++;
    else if (b[j].ch === " " && b[j].optional) j++;
    else return null;
  }
  while (i < a.length && a[i].ch === " " && a[i].optional) i++;
  while (j < b.length && b[j].ch === " " && b[j].optional) j++;
  if (i !== a.length || j !== b.length) return null;
  return { sourceIndices: anchored, outputIndices, retained };
}
function compareModelNumericEdit(source2, output, edits, paragraphs) {
  return modelNumericEditProof(source2, output, edits, paragraphs) !== null;
}
function normalizedSourceChars(chars) {
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = String.fromCharCode(chars[i].u);
    if (/\s/.test(ch)) {
      if (out.length && out.at(-1).ch !== " ") out.push({ ch: " " });
    } else out.push({ ch, sourceIndex: i });
  }
  if (out.at(-1)?.ch === " ") out.pop();
  return out;
}
function matchesStationaryReorderedGlyphs(source2, output, edits) {
  if (!source2.styled || !output.styled) return false;
  const normalized = normalizedSourceChars(source2.chars);
  const exp = expectedPageText(source2.text, edits, { includeSpans: true });
  if (!exp.ok) return false;
  const planned = [];
  let at = 0;
  for (const span of exp.spans) {
    planned.push(...normalized.slice(at, span.a), ...span.after.split("").map((ch) => ({ ch })));
    at = span.b;
  }
  planned.push(...normalized.slice(at));
  const expected = planned.filter((c, i) => c.ch !== " " || i > 0 && planned[i - 1].ch !== " ");
  if (expected.at(-1)?.ch === " ") expected.pop();
  if (expected.map((x) => x.ch).join("") !== exp.text) return false;
  const sg = new Map(source2.glyphs.map((g) => [g.i, g]));
  const og = new Map(output.glyphs.map((g) => [g.i, g]));
  const actual = [];
  for (let i = 0; i < output.chars.length; i++) {
    const c = output.chars[i], ch = String.fromCharCode(c.u);
    if (/\s/.test(ch)) {
      if (!actual.length) continue;
      if (actual.at(-1).ch === " ") actual.at(-1).optional &&= c.generated === true;
      else actual.push({ ch: " ", optional: c.generated === true });
    } else actual.push({ ch, index: i });
  }
  if (actual.at(-1)?.ch === " ") actual.pop();
  const sameStationary = (a, b) => a.u === b.u && ["l", "r", "b", "t"].every((k) => Math.abs(a[k] - b[k]) <= 0.01) && sameStyle(a.style, b.style);
  const moved = /* @__PURE__ */ new Set();
  let pos = 0, relocations = 0;
  for (const e of expected) {
    while (moved.has(pos)) pos++;
    while (actual[pos]?.ch === " " && actual[pos].optional && e.ch !== " ") pos++;
    if (actual[pos]?.ch === e.ch) {
      pos++;
      continue;
    }
    const src = sg.get(e.sourceIndex);
    if (!src || source2.glyphs.filter((g) => sameStationary(src, g)).length !== 1) return false;
    const candidates = [];
    for (let j = pos + 1; j < actual.length; j++) {
      if (moved.has(j) || actual[j].ch !== e.ch) continue;
      const dst = og.get(actual[j].index);
      if (dst && sameStationary(src, dst)) candidates.push(j);
    }
    if (candidates.length !== 1) return false;
    moved.add(candidates[0]);
    relocations++;
  }
  while (pos < actual.length && (moved.has(pos) || actual[pos].ch === " " && actual[pos].optional)) pos++;
  return pos === actual.length && relocations > 0;
}
async function inspectSavedPdf(engineFactory, sourceBytes, outputBytes, edits, options = {}) {
  const failures = [];
  const warnings = [];
  const pages = [];
  const report = { ok: false, independent: false, method: "same-pdfium-text-geometry", failures, warnings, pages };
  let src = null, out = null;
  try {
    src = await engineFactory();
    out = await engineFactory();
    src.open(sourceBytes);
    out.open(outputBytes);
    const map = normalizePageMap(options.sourcePageMap, src.pageCount);
    const expectedOut = map ? map.reduce((n2, m) => n2 + 1 + m.continuationPageIndices.length, 0) : src.pageCount;
    report.page_count = { source: src.pageCount, output: out.pageCount, expected: expectedOut, added: expectedOut - src.pageCount };
    if (!map) failures.push({ code: "page_map_invalid" });
    if (out.pageCount !== expectedOut) failures.push({ code: expectedOut === src.pageCount ? "page_count_changed" : "page_count_mismatch" });
    const byPage = /* @__PURE__ */ new Map();
    for (const e of edits || []) byPage.set(e.pageIndex, [...byPage.get(e.pageIndex) || [], e]);
    for (const p of byPage.keys()) {
      if (!(p >= 0 && p < src.pageCount)) failures.push({ code: "edit_page_out_of_range", pageIndex: p });
    }
    const n = map && out.pageCount === expectedOut ? src.pageCount : map ? 0 : Math.min(src.pageCount, out.pageCount);
    let annotationModel = null;
    const annotationAdapter = options.annotationAdapter;
    if (annotationAdapter && (options.flowGroups?.length ?? 0) > 0) {
      if (!["inspect", "transport", "validate"].every((k) => typeof annotationAdapter[k] === "function")) throw new Error("document_flow_annotation_adapter_invalid");
      annotationModel = await annotationAdapter.inspect({ sourceBytes, sourceSha256: createHash("sha256").update(sourceBytes).digest("hex") });
      if (!annotationModel || !Array.isArray(annotationModel.annotations)) throw new Error("document_flow_annotation_inventory_mismatch");
    }
    const annotationMoves = [], destinationMoves = [];
    const grouped = inspectDocumentGroups(src, out, map, options.flowGroups ?? [], byPage, failures, warnings, !!options.includeText, annotationModel, annotationMoves, destinationMoves);
    for (let i = 0; i < n; i++) {
      const m = map ? map[i] : { outputPageIndex: i, continuationPageIndices: [] };
      const s = readGlyphs(src, i);
      const o = readGlyphs(out, m.outputPageIndex);
      const pageEdits = byPage.get(i) || [];
      const row = { pageIndex: i, outputPageIndex: m.outputPageIndex, edited: pageEdits.length > 0 };
      pages.push(row);
      if (grouped.has(i)) {
        Object.assign(row, grouped.get(i));
        continue;
      }
      if (m.continuationPageIndices.length) {
        row.continuationPageIndices = [...m.continuationPageIndices];
        if (!pageEdits.length) failures.push({ code: "continuation_without_edit", pageIndex: i });
        else {
          ensurePage(src, i);
          inspectContinued(s, o, out, m, pageEdits, row, failures, warnings, !!options.includeText, sourceTableCells(src));
        }
        continue;
      }
      if (!pageEdits.length) {
        row.text_equal = normStr(s.text) === normStr(o.text);
        if (!row.text_equal) failures.push({ code: "unedited_page_text_changed", pageIndex: i });
        continue;
      }
      const exp = expectedPageText(s.text, pageEdits);
      let modelNumericMatch = false;
      let modelWordMatch = false;
      if (!exp.ok && exp.reason === "before_not_found" && typeof src.buildModel === "function") {
        ensurePage(src, i);
        const model = src.buildModel();
        modelNumericMatch = compareModelNumericEdit(s, o, pageEdits, model);
        modelWordMatch = !modelNumericMatch && modelWordEditProof(s, o, pageEdits, model) !== null;
      }
      if (modelNumericMatch || modelWordMatch) {
        row.text_equal = true;
        row[modelWordMatch ? "model_word_text_conservation" : "model_numeric_text_conservation"] = true;
        warnings.push({ code: modelWordMatch ? "model_word_text_conservation" : "model_numeric_text_conservation", pageIndex: i, severity: "warning", detail: "Unique source paragraph and changed word context matched; complete page extraction conserved with generated whitespace normalization" });
        if (modelWordMatch) row.after_checks = pageEdits.map((e) => ({ id: e.id, present: true, method: "model-word-full-page-proof" }));
      } else if (!exp.ok) {
        failures.push({ code: "expected_text_uncomputable", pageIndex: i, id: exp.id, reason: exp.reason });
      } else {
        row.text_equal = exp.text === normStr(o.text);
        if (!row.text_equal && matchesStationaryReorderedGlyphs(s, o, pageEdits)) {
          row.text_equal = true;
          row.stationary_glyph_order_normalized = true;
          warnings.push({ code: "stationary_glyph_order_normalized", pageIndex: i, severity: "warning" });
        }
        if (!row.text_equal) {
          const spatial = compareSourceGeometry(s, o, pageEdits, { expectedPageText });
          const counts = (evidence) => evidence && {
            total: evidence.total,
            mapped: evidence.mapped.length,
            generatedWhitespace: evidence.generatedWhitespace.length,
            boundaryWhitespace: evidence.boundaryWhitespace.length,
            normalizedDiscretionary: evidence.normalizedDiscretionary.length
          };
          row.spatial_conservation = {
            available: spatial.ok,
            match: spatial.match === true,
            ...spatial.ok ? {
              source: counts(spatial.sourceEvidence),
              output: counts(spatial.outputEvidence),
              expected: digest2(spatial.expected, options.includeText),
              actual: digest2(spatial.actual, options.includeText)
            } : { reason: spatial.reason }
          };
          if (spatial.ok && spatial.match) {
            row.text_equal = true;
            warnings.push({ code: "spatial_text_order_normalized", pageIndex: i, severity: "warning" });
          }
        }
        row.expected_text = digest2(exp.text, options.includeText);
        if (!row.text_equal) failures.push({ code: "edited_page_text_or_order_mismatch", pageIndex: i });
        row.after_checks = [];
        for (const e of pageEdits) {
          const t = normStr(o.text);
          if (!normStr(e.after)) continue;
          const exact = t.includes(normStr(e.after));
          const normalized = !exact && findGeneratedWhitespaceMatches(e.after, o.chars).length > 0;
          const physical = !exact && !normalized && row.spatial_conservation?.match === true && normStr(canonicalPage(o).text ?? "").includes(normStr(e.after));
          row.after_checks.push({
            id: e.id,
            present: exact || normalized || physical,
            method: exact ? "extracted-text" : normalized ? "generated-whitespace" : physical ? "spatial-order" : "not-found"
          });
          if (normalized) warnings.push({ code: "after_generated_whitespace_normalized", pageIndex: i, id: e.id, severity: "warning" });
          if (!exact && !normalized && !physical) failures.push({ code: "after_missing", pageIndex: i, id: e.id });
        }
      }
      row.offpage = { source: offPage(s), output: offPage(o) };
      if (row.offpage.output > row.offpage.source) failures.push({ code: "glyphs_off_page", pageIndex: i, count: row.offpage.output - row.offpage.source });
      row.overlap = { source: overlaps(s), output: overlaps(o) };
      if (row.overlap.output > row.overlap.source) failures.push({ code: "glyph_overlap_increased", pageIndex: i, count: row.overlap.output - row.overlap.source });
      const se = extents(s), oe = extents(o);
      row.extents = { source: se, output: oe };
      if (se && oe && (oe.right > se.right + TOL || oe.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i });
      const es = edgeGlyphs(s), eo = edgeGlyphs(o);
      const stable = edgeGlyphsEquivalent(es, eo);
      row.edge_glyphs = es.length;
      row.edge_stable = stable;
      if (!stable) {
        const editsEdge = authorizedEdgeChanges(s, o, pageEdits, es, eo, bodyBoxes(src, i, s) || []);
        const split = editsEdge ? null : edgeBodySplit(src, out, i, m.outputPageIndex, s, o, es, eo);
        if (split) row.edge_split = split;
        if (editsEdge) warnings.push({ code: "edge_edit_authorized", pageIndex: i });
        else if (!split || split.edgeMissing || split.edgeAdded) failures.push({ code: "header_footer_moved", pageIndex: i, ...split || {} });
        else if (split.edgeStyleChanged) failures.push({ code: "header_footer_style_changed", pageIndex: i, ...split });
        else failures.push({ code: "edge_band_body_changed", pageIndex: i, count: split.bodyChanged });
      }
    }
    if (annotationAdapter && annotationModel) {
      const verified = await annotationAdapter.validate({ model: annotationModel, sourceBytes, outputBytes, sourcePageMap: map, moves: annotationMoves, destinationMoves, reflowedSourcePages: [...grouped.keys()] });
      if (verified?.ok !== true) failures.push({ code: typeof verified?.code === "string" && /^[a-z_]{1,64}$/.test(verified.code) ? verified.code : "document_flow_annotation_verification_failed" });
      report.annotationCheck = { ok: verified?.ok === true, moves: annotationMoves.length };
    }
    report.ok = failures.length === 0;
    warnings.push({ code: "self_check_not_independent", detail: "same PDFium build; independent extraction and rendering review still required" });
  } catch (err) {
    failures.push({ code: "inspection_error", message: String(err?.message || err).slice(0, 200) });
    report.ok = false;
  } finally {
    try {
      src?.close();
    } catch {
    }
    try {
      out?.close();
    } catch {
    }
  }
  return report;
}
function inspectDocumentGroups(src, out, map, groups, byPage, failures, warnings, includeText, annotationModel = null, annotationMoves = [], destinationMoves = []) {
  const covered = /* @__PURE__ */ new Map(), outputs = /* @__PURE__ */ new Set();
  const bad = () => failures.push({ code: "document_flow_map_invalid" });
  if (!Array.isArray(groups) || groups.length > 64) {
    bad();
    return covered;
  }
  for (const group of groups) {
    const ss = group?.sourcePages, oo = group?.outputPages;
    const band = (b) => b && ["bodyTop", "flowTop", "floor", "x0", "x1"].every((k) => Number.isFinite(b[k])) && b.bodyTop === b.flowTop && b.bodyTop > b.floor && b.x1 > b.x0;
    if (group?.version !== 1 || !Array.isArray(ss) || ss.length < 2 || ss.length > 64 || src.pageCount > 64 || !Array.isArray(oo) || oo.length < ss.length || oo.length > ss.length + 32 || !Array.isArray(group.contentMap) || group.contentMap.length !== ss.length || !map) {
      bad();
      continue;
    }
    const ids = ss.map((b) => b.sourcePageIndex), ois = oo.map((b) => b.outputPageIndex);
    const expectedOutputs = ss.flatMap((b) => map[b.sourcePageIndex] ? [map[b.sourcePageIndex].outputPageIndex, ...map[b.sourcePageIndex].continuationPageIndices] : []);
    if (ss.some((b, k) => !band(b) || !Number.isInteger(b.sourcePageIndex) || b.sourcePageIndex < 0 || b.sourcePageIndex >= src.pageCount || k && b.sourcePageIndex !== ids[k - 1] + 1 || covered.has(b.sourcePageIndex)) || oo.some((b, k) => !band(b) || !Number.isInteger(b.outputPageIndex) || b.outputPageIndex < 0 || b.outputPageIndex >= out.pageCount || !Number.isInteger(b.lineCount) || b.lineCount < 1 || outputs.has(b.outputPageIndex) || k && b.outputPageIndex !== ois[k - 1] + 1) || JSON.stringify(ois) !== JSON.stringify(expectedOutputs) || group.contentMap.some((c, k) => c?.sourcePageIndex !== ids[k] || !Array.isArray(c.outputPageIndices) || !c.outputPageIndices.length || c.outputPageIndices.some((x, j) => !ois.includes(x) || j && x <= c.outputPageIndices[j - 1]) || JSON.stringify(c.outputPageIndices) !== JSON.stringify(map[c.sourcePageIndex].contentOutputPageIndices))) {
      bad();
      continue;
    }
    for (const i of ids) covered.set(i, { documentFlow: true, text_equal: false });
    for (const i of ois) outputs.add(i);
    let derived;
    try {
      derived = ids.map((i) => deriveDocumentFlowBand(src, i, capturePageLayout, annotationModel));
    } catch {
      bad();
      continue;
    }
    const keys = ["bodyTop", "flowTop", "floor", "x0", "x1"];
    const near7 = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-4;
    const expectedX0 = Math.min(...derived.map((b) => b.x0)), expectedX1 = Math.max(...derived.map((b) => b.x1));
    if (ss.some((b, k) => keys.some((key3) => !near7(b[key3], derived[k][key3]))) || oo.some((b, k) => {
      const destination = derived[Math.min(k, derived.length - 1)];
      return ["bodyTop", "flowTop", "floor"].some((key3) => !near7(b[key3], destination[key3])) || !near7(b.x0, expectedX0) || !near7(b.x1, expectedX1);
    })) {
      bad();
      continue;
    }
    try {
      const glyphs2 = savedLinkGlyphs(out, oo), edits = [...byPage.values()].flat();
      const destinations = deriveNativeFitRMoves(src, derived, glyphs2, edits, annotationModel, expectedPageText);
      destinationMoves.push(...destinations);
      const moves = deriveNativeLinkMoves(src, derived, glyphs2, edits, annotationModel, expectedPageText, nativeFitRTargetPages(annotationModel, ids));
      annotationMoves.push(...moves);
      verifySavedUnderlines(out, derived, oo, moves);
    } catch (error2) {
      failures.push({ code: error2?.code ?? "document_flow_link_mapping_failed", pageIndex: ids[0] });
    }
    const source2 = ss.map((b) => readGlyphs(src, b.sourcePageIndex)), output = oo.map((b) => readGlyphs(out, b.outputPageIndex));
    const expected = [];
    let valid2 = true;
    for (let k = 0; k < ss.length; k++) {
      const b = ss[k], s = source2[k], m = map[b.sourcePageIndex], o = output[ois.indexOf(m.outputPageIndex)];
      const fixed = outsideBand(s, b.floor - 0.5, b.bodyTop + 0.5), fixedOut = outsideBand(o, b.floor - 0.5, b.bodyTop + 0.5);
      const body = inBand(s, b.floor - 0.5, b.bodyTop + 0.5);
      if (!body.length || b.floor < 0 || b.bodyTop > s.H || b.x0 < 0 || b.x1 > s.W || Math.abs(Math.min(...body.map((c) => c.l)) - b.x0) > 0.5 || Math.abs(Math.max(...body.map((c) => c.r)) - b.x1) > 0.5 || Math.abs(Math.max(...body.map((c) => c.t)) - b.bodyTop) > 0.5) {
        bad();
        valid2 = false;
      }
      if (fixed.some((c) => (c.b + c.t) / 2 > s.H * 0.1 && (c.b + c.t) / 2 < s.H * 0.9)) {
        bad();
        valid2 = false;
      }
      if (!sameGlyphs(fixed, fixedOut) || !sameStyles(fixed, fixedOut)) failures.push({ code: "document_flow_fixed_content_changed", pageIndex: b.sourcePageIndex });
      const exp = expectedPageText(bandText(s, b.floor - 0.5, b.bodyTop + 0.5), byPage.get(b.sourcePageIndex) || []);
      if (!exp.ok) {
        failures.push({ code: "expected_text_uncomputable", pageIndex: b.sourcePageIndex });
        valid2 = false;
      } else expected.push(exp.text);
      if (Math.abs(s.W - o.W) > 0.01 || Math.abs(s.H - o.H) > 0.01) failures.push({ code: "document_flow_page_size_changed", pageIndex: b.sourcePageIndex });
    }
    const want = normStr(expected.join(" "));
    if (oo.some((b, k) => Math.abs(b.x0 - Math.min(...ss.map((s) => s.x0))) > 0.01 || Math.abs(b.x1 - Math.max(...ss.map((s) => s.x1))) > 0.01 || b.bodyTop !== ss[Math.min(k, ss.length - 1)].bodyTop || b.floor !== ss[Math.min(k, ss.length - 1)].floor)) {
      bad();
      valid2 = false;
    }
    const parts = output.map((g, k) => normStr(bandText(g, oo[k].floor - 0.5, oo[k].bodyTop + 0.5)));
    const actual = joinFlowParts(parts, want).text;
    let equal = valid2 && actual === want;
    if (!equal && valid2) {
      const chars = output.flatMap((g, k) => [...k ? [{ u: 32, generated: true }] : [], ...g.chars.filter((c) => c.cy === null || c.cy >= oo[k].floor - 0.5 && c.cy <= oo[k].bodyTop + 0.5)]);
      equal = matchesGeneratedWhitespace(want, chars);
    }
    if (!equal) failures.push({ code: "document_flow_text_or_order_mismatch", pageIndex: ids[0] });
    const actualGlyphs = output.flatMap((g, k) => inBand(g, oo[k].floor - 0.5, oo[k].bodyTop + 0.5));
    let glyphOffset = 0;
    const outputRanges = output.map((g, k) => {
      const start = glyphOffset;
      glyphOffset += inBand(g, oo[k].floor - 0.5, oo[k].bodyTop + 0.5).length;
      return { start, end: glyphOffset, index: oo[k].outputPageIndex };
    });
    let position = 0;
    for (let k = 0; k < ss.length; k++) {
      const start = position;
      const g = inBand(source2[k], ss[k].floor - 0.5, ss[k].bodyTop + 0.5);
      const edits = byPage.get(ids[k]) || [];
      const raw = g.map((c) => String.fromCharCode(c.u)).join("");
      if (!edits.length) {
        const got = actualGlyphs.slice(position, position + g.length);
        if (got.length !== g.length || got.some((c, j) => c.u !== g[j].u || !sameStyle(c.style, g[j].style))) failures.push({ code: "document_flow_unchanged_style_mismatch", pageIndex: ids[k] });
        position += g.length;
      } else {
        const spans = edits.map((e) => {
          const before = e.before.replace(/\s/g, ""), after = e.after.replace(/\s/g, "");
          const at2 = raw.indexOf(before);
          return { at: at2, before, after };
        }).sort((a, b) => a.at - b.at);
        let expected2 = [], at = 0, styleValid = true;
        for (const span of spans) {
          const selected = g.slice(span.at, span.at + span.before.length);
          if (!span.before || span.at < at || raw.indexOf(span.before, span.at + 1) !== -1 || !selected.length || selected.some((c) => !sameStyle(c.style, selected[0].style))) {
            styleValid = false;
            break;
          }
          expected2.push(...g.slice(at, span.at), ...[...span.after].map((c) => ({ u: c.charCodeAt(0), style: selected[0].style })));
          at = span.at + span.before.length;
        }
        expected2.push(...g.slice(at));
        if (!styleValid) failures.push({ code: "document_flow_style_unverifiable", pageIndex: ids[k] });
        const got = actualGlyphs.slice(position, position + expected2.length);
        if (!styleValid || got.length !== expected2.length || got.some((c, j) => c.u !== expected2[j].u || !sameStyle(c.style, expected2[j].style))) failures.push({ code: "document_flow_edited_style_mismatch", pageIndex: ids[k] });
        position += expected2.length;
      }
      const contentPages = outputRanges.filter((r) => r.start < position && r.end > start).map((r) => r.index);
      if (JSON.stringify(contentPages) !== JSON.stringify(group.contentMap[k].outputPageIndices)) failures.push({ code: "document_flow_content_map_mismatch", pageIndex: ids[k] });
    }
    if (position !== actualGlyphs.length) failures.push({ code: "document_flow_style_coverage_mismatch", pageIndex: ids[0] });
    for (let k = 0; k < oo.length; k++) {
      const b = oo[k], g = output[k], body = inBand(g, b.floor - 0.5, b.bodyTop + 0.5);
      if (body.some((c) => c.b < b.floor - 0.5 || c.t > b.bodyTop + 0.5)) failures.push({ code: "document_flow_body_outside_band", outputPageIndex: b.outputPageIndex });
      if (countGlyphLines(body) !== b.lineCount) failures.push({ code: "document_flow_line_count_mismatch", outputPageIndex: b.outputPageIndex });
      if (offPage(g)) failures.push({ code: "glyphs_off_page", outputPageIndex: b.outputPageIndex });
      if (body.some((c) => c.l < Math.min(...ss.map((b2) => b2.x0)) - 1 || c.r > Math.max(...ss.map((b2) => b2.x1)) + 1)) failures.push({ code: "text_outside_source_columns", outputPageIndex: b.outputPageIndex });
      if (overlaps(g, true) > Math.max(...source2.map((s) => overlaps(s, true)))) failures.push({ code: "glyph_overlap_increased", outputPageIndex: b.outputPageIndex });
      if (k >= ss.length) {
        const last = source2.at(-1), band2 = ss.at(-1), edge = outsideBand(g, b.floor - 0.5, b.bodyTop + 0.5);
        checkContinuationEdges(last, outsideBand(last, band2.floor - 0.5, band2.bodyTop + 0.5), g, edge, k - ss.length + 1, ids.at(-1), b.outputPageIndex, failures);
      }
    }
    for (const i of ids) covered.set(i, { documentFlow: true, text_equal: equal, flowSourcePageIndices: ids, flowOutputPageIndices: ois, expected_text: digest2(want, includeText) });
  }
  return covered;
}
function alignEdgeGlyphs(source2, output) {
  const candidates = source2.map((c) => output.map((d, j) => samePlace(c, d) ? j : -1).filter((j) => j >= 0));
  const reverse = output.map((_, j) => candidates.reduce((n, cs) => n + Number(cs.includes(j)), 0));
  const used = /* @__PURE__ */ new Set(), missing = [], restyled = [];
  source2.forEach((c, i) => {
    const cs = candidates[i];
    if (cs.length !== 1 || reverse[cs[0]] !== 1) {
      missing.push(c);
      return;
    }
    const j = cs[0];
    used.add(j);
    if (!sameStyle(c.style ?? null, output[j].style ?? null)) restyled.push([c, output[j]]);
  });
  return { missing, added: output.filter((_, j) => !used.has(j)), restyled };
}
function edgeGlyphsEquivalent(source2, output) {
  if (source2.length === output.length && source2.every((c, i) => samePlace(c, output[i]) && sameStyle(c.style ?? null, output[i].style ?? null))) return true;
  const result = alignEdgeGlyphs(source2, output);
  return !result.missing.length && !result.added.length && !result.restyled.length;
}
function normalizePageMap(map, sourcePageCount) {
  if (map === void 0 || map === null) {
    return Array.from({ length: sourcePageCount }, (_, i) => ({ sourcePageIndex: i, outputPageIndex: i, continuationPageIndices: [] }));
  }
  if (!Array.isArray(map) || map.length !== sourcePageCount) return null;
  let next = 0;
  const out = [];
  for (let i = 0; i < map.length; i++) {
    const m = map[i];
    const cont = m?.continuationPageIndices ?? [];
    if (!m || m.sourcePageIndex !== i || m.outputPageIndex !== next || !Array.isArray(cont)) return null;
    next++;
    for (const c of cont) {
      if (c !== next) return null;
      next++;
    }
    if (cont.length && !(Number.isFinite(m.bodyTop) && Number.isFinite(m.floor) && m.bodyTop > m.floor)) return null;
    if (m.flowTop !== void 0 && !(cont.length && Number.isFinite(m.flowTop) && m.flowTop > m.floor && m.flowTop <= m.bodyTop + 2)) return null;
    if (cont.length && !(Array.isArray(m.lineCounts) && m.lineCounts.length === cont.length)) return null;
    if (m.flowColumn !== void 0 && !(cont.length && Number.isFinite(m.flowColumn?.x0) && Number.isFinite(m.flowColumn?.x1) && m.flowColumn.x1 > m.flowColumn.x0)) return null;
    if (m.continuationStyle !== void 0 && !(cont.length && validContinuationStyle(m.continuationStyle))) return null;
    out.push({ ...m, continuationPageIndices: [...cont] });
  }
  return out;
}
function validContinuationStyle(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === "applied,policy,version" && v.version === 1 && v.policy === "source-number-suffix" && v.applied === true;
}
function bandText(g, floor, bodyTop) {
  let t = "";
  for (const c of g.chars) if (c.cy === null || c.cy >= floor && c.cy <= bodyTop) t += String.fromCharCode(c.u);
  return t;
}
function outsideBand(g, floor, bodyTop) {
  return g.glyphs.filter((c) => {
    const cy = (c.b + c.t) / 2;
    return cy < floor || cy > bodyTop;
  });
}
function inBand(g, floor, bodyTop) {
  return g.glyphs.filter((c) => {
    const cy = (c.b + c.t) / 2;
    return cy >= floor && cy <= bodyTop;
  });
}
function byObject(glyphs2) {
  const m = /* @__PURE__ */ new Map();
  for (const c of glyphs2) m.set(c.obj, [...m.get(c.obj) || [], c]);
  return [...m.values()].map((cs) => cs.sort((a, b) => a.i - b.i));
}
function sourcePageNumbers(es) {
  const groups = byObject(es).map((cs) => ({ glyphs: cs, text: textOf2(cs), chars: cs.map((c) => ({ oy: c.oy ?? c.b })), bounds: { l: Math.min(...cs.map((c) => c.l)), r: Math.max(...cs.map((c) => c.r)), b: Math.min(...cs.map((c) => c.b)), t: Math.max(...cs.map((c) => c.t)) }, style: cs[0]?.style }));
  const fraction = resolvePageFraction(groups);
  const items = groups.filter((g) => /^\d+$/.test(g.text) && !fraction?.fixedNumbers.has(g));
  return { items, ambiguous: new Set(items.map((x) => x.text)).size > 1 };
}
function numberAnchor(L, R, W) {
  const c = (L + R) / 2;
  return Math.abs(c - W / 2) <= 2 ? "center" : c > W / 2 ? "right" : "left";
}
function checkContinuationEdges(s, es, g, edge, ordinal, pageIndex, outputPageIndex, failures) {
  const fail8 = (code, extra2 = {}) => failures.push({ code, pageIndex, outputPageIndex, ...extra2 });
  const res = { expected_glyphs: 0, output_glyphs: edge.length, page_numbers: [] };
  if (!s.styled || !g.styled) {
    fail8("continuation_edge_style_unverifiable");
    return res;
  }
  const numbers2 = sourcePageNumbers(es);
  if (numbers2.ambiguous) {
    fail8("continuation_page_number_ambiguous");
    return res;
  }
  const numbered = new Set(numbers2.items.flatMap((x) => x.glyphs));
  const fixed = es.filter((c) => !numbered.has(c));
  res.expected_glyphs = fixed.length + numbers2.items.reduce((n, x) => n + x.text.length + 1 + String(ordinal).length, 0);
  const left = [...edge];
  let missing = 0, styled = 0;
  for (const c of fixed) {
    const k = left.findIndex((d) => samePlace(c, d));
    if (k < 0) {
      missing++;
      continue;
    }
    if (!sameStyle(c.style, left[k].style)) styled++;
    left.splice(k, 1);
  }
  if (missing) fail8("continuation_edge_missing", { count: missing });
  if (styled) fail8("continuation_edge_style_mismatch", { count: styled });
  const groups = byObject(left);
  for (const x of numbers2.items) {
    const sd = [...x.glyphs].sort((a, b) => a.l - b.l), ref = sd[0];
    const want = x.text + "." + ordinal;
    const k = groups.findIndex((cs) => cs[0].origin && ref.origin && Math.abs(cs[0].origin[1] - ref.origin[1]) <= 0.5);
    const rest = k < 0 ? [] : groups.splice(k, 1)[0];
    const pn = { source: x.text, expected: want, output: textOf2(rest), anchor: null };
    res.page_numbers.push(pn);
    if (pn.output !== want) {
      fail8("continuation_page_number_mismatch", { source: x.text });
      continue;
    }
    const off = rest.filter((c) => !sameStyle(ref.style, c.style)).length;
    if (off) fail8("continuation_edge_style_mismatch", { count: off });
    const n = sd.length;
    let placed = rest.every((c, j) => c.origin && c.loose && Math.abs(c.origin[1] - ref.origin[1]) <= 0.5 && (j === 0 || Math.abs(c.loose[0] - rest[j - 1].loose[1]) <= 0.5 || j < n));
    for (let j = 0; placed && j < n; j++) {
      const c = rest[j], d = sd[j];
      if (c.u !== d.u || Math.abs(c.l - rest[0].l - (d.l - ref.l)) > 0.5 || Math.abs(c.r - c.l - (d.r - d.l)) > 0.5 || Math.abs(c.b - d.b) > 0.5 || Math.abs(c.t - d.t) > 0.5) placed = false;
    }
    if (placed && ref.loose && sd[n - 1].loose) {
      const L = ref.loose[0], R = sd[n - 1].loose[1], L2 = rest[0].loose[0], R2 = rest[rest.length - 1].loose[1];
      pn.anchor = numberAnchor(L, R, s.W);
      const err = pn.anchor === "left" ? L2 - L : pn.anchor === "right" ? R2 - R : (L2 + R2 - L - R) / 2;
      if (Math.abs(err) > 0.5) placed = false;
    } else {
      placed = false;
    }
    if (!placed) fail8("continuation_page_number_moved", { source: x.text });
  }
  const extra = groups.reduce((n, cs) => n + cs.length, 0);
  if (extra) fail8("continuation_edge_extra", { count: extra });
  return res;
}
function glyphLines(glyphs2) {
  const sorted = [...glyphs2].sort((a, b) => b.t - a.t);
  const lines2 = [];
  let top = 0, bottom = 0;
  for (const c of sorted) {
    const cy = (c.b + c.t) / 2;
    if (lines2.length && cy <= top && cy >= bottom) {
      bottom = Math.min(bottom, c.b);
      lines2[lines2.length - 1].push(c);
      continue;
    }
    lines2.push([c]);
    top = c.t;
    bottom = c.b;
  }
  return lines2;
}
function countGlyphLines(glyphs2) {
  return glyphLines(glyphs2).length;
}
function joinFlowParts(parts, expected) {
  let acc = parts[0] ?? "";
  let softJoins = 0;
  for (const part of parts.slice(1)) {
    if (acc.endsWith("-") && expected.startsWith(acc.slice(0, -1) + "")) {
      acc = acc.slice(0, -1) + "" + part;
      softJoins++;
    } else {
      acc = acc + " " + part;
    }
  }
  return { text: normStr(acc), softJoins };
}
function generatedWhitespaceTokens(chars, codePoints = false, includeIndices = false) {
  const tokens2 = [];
  for (const [index, c] of chars.entries()) {
    const ch = codePoints ? String.fromCodePoint(c.u) : String.fromCharCode(c.u);
    if (/\s/.test(ch)) {
      const prev = tokens2[tokens2.length - 1];
      if (prev?.ch === " ") prev.optional &&= c.generated === true;
      else tokens2.push({ ch: " ", optional: c.generated === true });
    } else tokens2.push({ ch, optional: false, ...includeIndices ? { index } : {} });
  }
  if (tokens2[0]?.ch === " ") tokens2.shift();
  if (tokens2[tokens2.length - 1]?.ch === " ") tokens2.pop();
  return tokens2;
}
function findGeneratedWhitespaceMatches(expected, chars) {
  const text3 = normStr(expected);
  if (!text3) return [];
  const tokens2 = generatedWhitespaceTokens(chars), matches = [];
  for (let start = 0; start < tokens2.length; start++) {
    if (tokens2[start].ch !== text3[0]) continue;
    let at = 0;
    for (let end = start; end < tokens2.length; end++) {
      const token = tokens2[end];
      if (token.ch === text3[at]) at++;
      else if (!(token.ch === " " && token.optional)) break;
      if (at === text3.length) {
        matches.push({ start, end: end + 1 });
        break;
      }
    }
  }
  return matches;
}
function matchesGeneratedWhitespace(expected, chars) {
  const tokens2 = generatedWhitespaceTokens(chars);
  const text3 = normStr(expected);
  let at = 0;
  for (const token of tokens2) {
    if (token.ch === text3[at]) at++;
    else if (!(token.ch === " " && token.optional)) return false;
  }
  return at === text3.length;
}
function inspectContinued(s, o, out, m, pageEdits, row, failures, warnings, includeText, sourceTables = []) {
  const i = row.pageIndex;
  if (sourceTables === null) {
    failures.push({ code: "continuation_table_source_unavailable", pageIndex: i });
    return;
  }
  const { floor, bodyTop } = m;
  const lo = floor - 0.5, hi = bodyTop + 0.5;
  const flowHi = m.flowTop === void 0 ? hi : Math.min(hi, m.flowTop + 0.5);
  const column = m.flowColumn;
  const inColumn = (c) => !column || (c.cx ?? (c.l + c.r) / 2) >= column.x0 - 0.5 && (c.cx ?? (c.l + c.r) / 2) <= column.x1 + 0.5;
  const selected = (g, top) => {
    if (!column) return g.chars.filter((c) => c.cy === null || c.cy >= lo && c.cy <= top);
    const visible = (c) => c.cy !== null && c.cy >= lo && c.cy <= top && inColumn(c);
    return g.chars.filter((c, k, cs) => {
      if (c.cy !== null) return visible(c);
      let a = k - 1, b = k + 1;
      while (a >= 0 && cs[a].cy === null) a--;
      while (b < cs.length && cs[b].cy === null) b++;
      return a >= 0 && b < cs.length && visible(cs[a]) && visible(cs[b]);
    });
  };
  const flowText = (g, top) => selected(g, top).map((c) => String.fromCharCode(c.u)).join("");
  const exp = expectedPageText(flowText(s, flowHi), pageEdits);
  if (column) {
    const fixed = (g) => g.glyphs.filter((c) => {
      const cy = (c.b + c.t) / 2;
      return cy >= lo && cy <= hi && !inColumn(c);
    });
    const a = fixed(s), b = fixed(o);
    row.fixed_column_stable = sameGlyphs(a, b) && sameStyles(a, b);
    if (!row.fixed_column_stable) failures.push({ code: "fixed_other_column_changed", pageIndex: i });
  }
  if (flowHi < hi) {
    const fixed = (g) => g.glyphs.filter((c) => c.b + (c.t - c.b) / 2 > flowHi && c.b + (c.t - c.b) / 2 <= hi);
    const a = fixed(s), b = fixed(o);
    row.fixed_body_stable = sameGlyphs(a, b) && sameStyles(a, b);
    if (!row.fixed_body_stable) failures.push({ code: "fixed_body_above_flow_changed", pageIndex: i });
  }
  const conts = m.continuationPageIndices.map((k) => readGlyphs(out, k));
  const parts = [normStr(flowText(o, flowHi)), ...conts.map((g) => normStr(flowText(g, hi)))];
  const joined = joinFlowParts(parts, exp.ok ? exp.text : "");
  const got = joined.text;
  row.body_band = { floor: +floor.toFixed(2), bodyTop: +bodyTop.toFixed(2) };
  row.soft_hyphen_page_joins = joined.softJoins;
  if (!exp.ok) {
    failures.push({ code: "expected_text_uncomputable", pageIndex: i, id: exp.id, reason: exp.reason });
  } else {
    row.text_equal = exp.text === got;
    const sourceWords = new Set([...flowText(s, flowHi).matchAll(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu)].map((m2) => m2[1] + m2[2]));
    const expectedTypography = exp.text.replace(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu, (raw, left, right) => sourceWords.has(left + right) ? left + right : raw);
    if (!row.text_equal) {
      const actual = [selected(o, flowHi), ...conts.map((g) => selected(g, hi))].flatMap((part, k) => k ? [{ u: 32, generated: true }, ...part] : part);
      const raw = actual.map((c) => String.fromCharCode(c.u)).join("");
      const drop = /* @__PURE__ */ new Set();
      for (const match of raw.matchAll(/([\p{L}]+)\u0002\s*([\p{L}]+)/gu)) {
        if (!sourceWords.has(match[1] + match[2])) continue;
        for (let k = match.index + match[1].length; k < match.index + match[0].length - match[2].length; k++) drop.add(k);
      }
      if (matchesGeneratedWhitespace(expectedTypography, actual.filter((_, k) => !drop.has(k)))) {
        row.text_equal = true;
        row.generated_whitespace_normalized = true;
        warnings.push({ code: "continued_flow_generated_whitespace_normalized", pageIndex: i, severity: "warning", detail: "Only source-proven discretionary markers and PDFium-generated extraction whitespace differ; requested characters, literal whitespace and order are preserved" });
      }
    }
    row.expected_text = digest2(exp.text, includeText);
    row.output_parts = parts.map((p) => digest2(p, includeText));
    if (!row.text_equal) failures.push({ code: "edited_flow_text_or_order_mismatch", pageIndex: i });
  }
  if (parts.slice(1).some((p) => !p)) failures.push({ code: "continuation_page_empty", pageIndex: i });
  const es = outsideBand(s, lo, hi), eo = outsideBand(o, lo, hi);
  row.edge_glyphs = es.length;
  row.edge_stable = edgeGlyphsEquivalent(es, eo);
  if (!row.edge_stable) {
    const diff = alignEdgeGlyphs(es, eo);
    failures.push({ code: diff.missing.length || diff.added.length ? "header_footer_moved" : "header_footer_style_changed", pageIndex: i });
  }
  const se = extents(s);
  row.continuation = conts.map((g, k) => {
    const bodyGlyphs = inBand(g, lo, hi);
    if (column && bodyGlyphs.some((c2) => !inColumn(c2))) failures.push({ code: "continuation_text_outside_flow_column", pageIndex: i, outputPageIndex: m.continuationPageIndices[k] });
    const edge = outsideBand(g, lo, hi);
    const c = {
      outputPageIndex: m.continuationPageIndices[k],
      lines: { planned: m.lineCounts[k], measured: countGlyphLines(bodyGlyphs) },
      offpage: offPage(g),
      overlap: overlaps(g, true),
      outside_band: edge.length,
      // Column check on the body only: edge content is verified against the
      // source page position by position, and a page-number suffix may
      // legitimately extend past the source text extent.
      extents: extents({ glyphs: bodyGlyphs }),
      size: { W: g.W, H: g.H }
    };
    if (c.lines.planned !== c.lines.measured) failures.push({ code: "continuation_line_count_mismatch", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (c.offpage) failures.push({ code: "glyphs_off_page", pageIndex: i, outputPageIndex: c.outputPageIndex, count: c.offpage });
    if (c.overlap > overlaps(s, true)) failures.push({ code: "glyph_overlap_increased", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (m.continuationStyle) {
      c.edges = checkContinuationEdges(s, es.filter((c2) => !inSourceTableCell(c2, sourceTables)), g, edge, k + 1, i, c.outputPageIndex, failures);
    } else if (c.outside_band) {
      failures.push({ code: "continuation_outside_body_band", pageIndex: i, outputPageIndex: c.outputPageIndex });
    }
    if (se && c.extents && (c.extents.right > se.right + TOL || c.extents.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i, outputPageIndex: c.outputPageIndex });
    if (Math.abs(g.W - s.W) > 0.01 || Math.abs(g.H - s.H) > 0.01) failures.push({ code: "continuation_page_size_mismatch", pageIndex: i, outputPageIndex: c.outputPageIndex });
    return c;
  });
  row.offpage = { source: offPage(s), output: offPage(o) };
  if (row.offpage.output > row.offpage.source) failures.push({ code: "glyphs_off_page", pageIndex: i, count: row.offpage.output - row.offpage.source });
  row.overlap = { source: overlaps(s, true), output: overlaps(o, true), excludes: "adjacent_same_baseline_pairs" };
  if (row.overlap.output > row.overlap.source) failures.push({ code: "glyph_overlap_increased", pageIndex: i, count: row.overlap.output - row.overlap.source });
  const oe = extents(o);
  if (se && oe && (oe.right > se.right + TOL || oe.left < se.left - TOL)) failures.push({ code: "text_outside_source_columns", pageIndex: i });
}
var TOL, EDGE_BAND, OBJ_TEXT2, normStr, paraText, bottomOf, median2, STYLE_FNS, sameStyles, inBoxes, sameGlyphs, digest2, textOf2, samePlace;
var init_quality = __esm({
  "src/paragraph-vendor/quality.mjs"() {
    init_paragraph_pdf_crypto();
    init_paragraph_geometry_conservation();
    init_continuation_template();
    init_paragraph_source_tables();
    init_document_flow_band();
    init_document_flow_links();
    init_document_flow_underlines();
    TOL = 1;
    EDGE_BAND = 0.1;
    OBJ_TEXT2 = 1;
    normStr = (s) => String(s).replace(/\s+/g, " ").trim();
    paraText = (p) => (p.runs || []).map((r) => r.text || "").join("");
    bottomOf = (b) => b.top - b.h;
    median2 = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    STYLE_FNS = ["_FPDFText_GetFontSize", "_FPDFText_GetFontInfo", "_FPDFText_GetFillColor", "_FPDFText_GetStrokeColor", "_FPDFText_GetMatrix", "_FPDFText_GetCharOrigin", "_FPDFText_GetLooseCharBox", "_FPDFText_GetTextObject", "_FPDFTextObj_GetTextRenderMode"];
    sameStyles = (a, b) => a.length === b.length && a.every((c, k) => sameStyle(c.style ?? null, b[k].style ?? null));
    inBoxes = (c, boxes) => {
      const x = (c.l + c.r) / 2, y = (c.b + c.t) / 2;
      return boxes.some((b) => x >= b.x - 0.5 && x <= b.x + b.w + 0.5 && y >= bottomOf(b) - 0.5 && y <= b.top + 0.5);
    };
    sameGlyphs = (a, b) => a.length === b.length && a.every((c, k) => {
      const d = b[k];
      return c.u === d.u && Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.b - d.b) <= 0.5;
    });
    digest2 = (text3, includeText) => ({
      sha256: createHash("sha256").update(text3, "utf8").digest("hex"),
      chars: text3.length,
      ...includeText ? { text: text3 } : {}
    });
    textOf2 = (cs) => String.fromCharCode(...cs.map((c) => c.u));
    samePlace = (c, d) => c.u === d.u && Math.abs(c.l - d.l) <= 0.5 && Math.abs(c.r - d.r) <= 0.5 && Math.abs(c.b - d.b) <= 0.5 && Math.abs(c.t - d.t) <= 0.5;
  }
});

// src/paragraph-vendor/pagination.mjs
function groupLines(items) {
  const seeds = items.filter((it) => it.top - it.bottom > EPS).sort((a, b) => b.top - a.top || a.order - b.order);
  const lines2 = [];
  for (const it of seeds) {
    const cy = (it.top + it.bottom) / 2;
    const l = lines2[lines2.length - 1];
    const lc = l ? (l.top + l.bottom) / 2 : 0;
    if (l && (cy <= l.top + EPS && cy >= l.bottom - EPS || lc <= it.top + EPS && lc >= it.bottom - EPS)) {
      l.items.push(it);
      l.top = Math.max(l.top, it.top);
      l.bottom = Math.min(l.bottom, it.bottom);
    } else {
      lines2.push({ top: it.top, bottom: it.bottom, items: [it] });
    }
  }
  return { lines: lines2, loose: items.filter((it) => !(it.top - it.bottom > EPS)) };
}
function planFlow(lines2, { bodyTop, floor, maxNewPages }) {
  if (!(bodyTop > floor)) return { ok: false, code: "pagination_body_band_invalid" };
  for (let i = 1; i < lines2.length; i++) {
    const a = lines2[i - 1], b = lines2[i];
    if (!((b.top + b.bottom) / 2 < (a.top + a.bottom) / 2 && b.top <= a.top + EPS)) return { ok: false, code: "pagination_flow_not_monotonic", line: i };
  }
  const pages = [{ offset: 0, lines: [] }];
  for (let i = 0; i < lines2.length; i++) {
    const l = lines2[i];
    const page = pages[pages.length - 1];
    if (l.bottom + page.offset >= floor - EPS) {
      page.lines.push(i);
      continue;
    }
    const offset = bodyTop - l.top;
    if (l.bottom + offset < floor - EPS) return { ok: false, code: "pagination_line_exceeds_body", line: i };
    if (pages.length - 1 >= maxNewPages) return { ok: false, code: "pagination_budget_exceeded", maxNewPages };
    pages.push({ offset, lines: [i] });
  }
  return { ok: true, pages };
}
function listObjects2(M, page) {
  const n = M._FPDFPage_CountObjects(page);
  const out = [];
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(page, i) >>> 0);
  return out;
}
function readBox(M, page, fn) {
  const p = M._malloc(16);
  try {
    if (!M[fn](page, p, p + 4, p + 8, p + 12)) return null;
    return [0, 1, 2, 3].map((k) => M.HEAPF32[(p >> 2) + k]);
  } finally {
    M._free(p);
  }
}
function unsupportedPage(engine) {
  const M = engine.M;
  if (engine._t3seg && Object.keys(engine._t3seg).length) return "pagination_unsupported_type3_segments";
  if (typeof M._FPDFPage_GetRotation === "function" && M._FPDFPage_GetRotation(engine.page) !== 0) return "pagination_unsupported_rotated_page";
  const t = engine.pageT || [1, 0, 0, 1, 0, 0];
  if ([1, 0, 0, 1, 0, 0].some((v, i) => Math.abs(t[i] - v) > 1e-4)) return "pagination_unsupported_cropped_or_offset_page";
  const media = typeof M._FPDFPage_GetMediaBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetMediaBox") : null;
  if (media && (Math.abs(media[0]) > 1e-3 || Math.abs(media[1]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  const crop = typeof M._FPDFPage_GetCropBox === "function" ? readBox(M, engine.page, "_FPDFPage_GetCropBox") : null;
  if (crop && media && crop.some((v, i) => Math.abs(v - media[i]) > 1e-3)) return "pagination_unsupported_cropped_or_offset_page";
  return null;
}
function buildFlowPlan(engine, ctx, grown, { floor, maxNewPages }) {
  const M = engine.M;
  const err = (code, extra = {}) => ({ ok: false, code, ...extra });
  const bad = unsupportedPage(engine);
  if (bad) return err(bad);
  const grownIds = new Set(grown.map((g) => g.id));
  const flowTop = Math.max(...grown.map((g) => g.box.top));
  const anchor = grown.find((g) => g.box.top === flowTop).box;
  if (grown.some((g) => !sameColumn(g.box, anchor))) return err("pagination_unsupported_multi_column_flow");
  const objects = listObjects2(M, engine.page);
  const indexOf = new Map(objects.map((h, i) => [h, i]));
  const bounds = (h) => {
    const b = engine.objectBounds(h);
    return b ? { top: b.y + b.h, bottom: b.y, x: b.x, w: b.w } : null;
  };
  const owner = /* @__PURE__ */ new Map();
  const current = /* @__PURE__ */ new Map();
  for (const q of ctx.paras) {
    const hs = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
    current.set(q.id, hs);
    for (const h of hs) {
      if (owner.has(h) && owner.get(h) !== q.id) return err("pagination_unsupported_shared_objects");
      owner.set(h, q.id);
    }
  }
  const flow = [];
  for (const q of ctx.paras) {
    if (!q.box) continue;
    const cy = q.box.top - q.box.h / 2;
    const below = q.box.top <= flowTop + 0.5;
    if (hOverlap2(q.box, anchor) <= EPS) continue;
    if (q.role !== "body") {
      if (cy > floor + EPS && cy < flowTop && below) return err("pagination_unsupported_edge_paragraph_in_flow");
      continue;
    }
    if (!below) continue;
    if (!sameColumn(q.box, anchor)) return err("pagination_unsupported_multi_column_flow");
    if (!q.editable || q.sharesObjects) return err("pagination_unsupported_shared_objects");
    if (!q.topLevel && !grownIds.has(q.id)) return err("pagination_unsupported_non_top_level_text");
    flow.push(q);
  }
  flow.sort((a, b) => b.box.top - a.box.top || a.box.x - b.box.x);
  const shifts = cascadeShifts(ctx, grown);
  const shiftOf = (q) => shifts.get(q.id) || 0;
  const lines2 = [];
  const untouchedLines = [];
  for (const q of flow) {
    const shift = shiftOf(q);
    const items = [];
    for (const h of current.get(q.id)) {
      if (!indexOf.has(h)) return err("pagination_unsupported_non_top_level_text");
      const b = bounds(h);
      if (!b) return err("pagination_unsupported_non_top_level_text");
      items.push({ h, order: indexOf.get(h), ...b });
    }
    const { lines: ls, loose } = groupLines(items);
    if (!ls.length && loose.length) ls.push({ top: Math.max(...loose.map((i) => i.top)), bottom: Math.min(...loose.map((i) => i.bottom)), items: [] });
    for (const it of loose) {
      const l = ls.find((x) => it.bottom <= x.top + 0.5 && it.bottom >= x.bottom - 0.5) || ls[ls.length - 1];
      l.items.push(it);
    }
    for (const l of ls) {
      const line = { para: q.id, shift, top: l.top, bottom: l.bottom, items: l.items };
      lines2.push(line);
      if (!grownIds.has(q.id) && shift >= 0) untouchedLines.push(line);
    }
  }
  const flowColumn = { x0: Math.min(...flow.map((q) => q.box.x)), x1: Math.max(...flow.map((q) => q.box.x + q.box.w)) };
  let orphans = 0;
  for (const h of objects) {
    if (owner.has(h)) continue;
    const b = bounds(h);
    if (!b) return err("pagination_unsupported_foreign_object_in_flow");
    const cy = (b.top + b.bottom) / 2;
    if (b.top < floor - EPS || b.bottom > flowTop + 0.5) continue;
    if (b.x + b.w < flowColumn.x0 - 0.5 || b.x > flowColumn.x1 + 0.5) {
      continue;
    }
    if (M._FPDFPageObj_GetType(h) !== OBJ_TEXT3) {
      const hits2 = M._FPDFPageObj_GetType(h) === 2 && b.top - b.bottom <= EPS && b.w > EPS ? lines2.filter((line) => {
        const size3 = ctx.paras.find((q) => q.id === line.para)?.size || 0;
        const text3 = line.items.filter((it) => {
          const cx = it.x + it.w / 2;
          return cx >= b.x - 3 && cx <= b.x + b.w + 3 && it.bottom - b.top >= -1 && it.bottom - b.top <= 0.4 * size3;
        });
        const single = text3.some((it) => Math.abs(it.x - b.x) <= 1 && Math.abs(it.x + it.w - b.x - b.w) <= 1);
        return size3 > 0 && b.w <= 2 * size3 && text3.length && (single || Math.abs(Math.min(...text3.map((it) => it.x)) - b.x) <= 3 && Math.abs(Math.max(...text3.map((it) => it.x + it.w)) - b.x - b.w) <= 3);
      }) : [];
      if (hits2.length !== 1) return err("pagination_unsupported_foreign_object_in_flow");
      hits2[0].items.push({ h, order: indexOf.get(h), ...b });
      continue;
    }
    const l = untouchedLines.find((x) => cy <= x.top + 0.5 && cy >= x.bottom - 0.5);
    if (l) {
      l.items.push({ h, order: indexOf.get(h), ...b });
      continue;
    }
    if (b.top - b.bottom <= EPS && b.w <= EPS) {
      orphans++;
      continue;
    }
    return err("pagination_unsupported_foreign_object_in_flow");
  }
  let bodyTop = -Infinity;
  for (const q of ctx.paras) {
    if (q.role !== "body") continue;
    for (const h of current.get(q.id)) {
      const b = indexOf.has(h) ? bounds(h) : null;
      if (b && b.top - b.bottom > EPS) bodyTop = Math.max(bodyTop, b.top);
    }
  }
  const hasFixedColumn = objects.some((h) => {
    const b = bounds(h);
    if (!b) return false;
    const cy = (b.top + b.bottom) / 2;
    return cy >= floor - EPS && cy <= bodyTop + EPS && (b.x + b.w < flowColumn.x0 - 0.5 || b.x > flowColumn.x1 + 0.5);
  });
  const virtual = lines2.map((l) => ({ top: l.top - l.shift, bottom: l.bottom - l.shift }));
  const split = planFlow(virtual, { bodyTop, floor, maxNewPages });
  if (!split.ok) return err(split.code, { line: split.line, maxNewPages: split.maxNewPages });
  return { ok: true, lines: lines2, pages: split.pages, bodyTop, flowTop: Math.min(flowTop, bodyTop), ...hasFixedColumn ? { flowColumn } : {}, floor, orphans, objects };
}
function evictPagesAfter(engine, pageIndex) {
  const M = engine.M;
  const cache = engine._pageCache;
  if (!cache) return;
  for (const [k, h] of [...cache.entries()]) {
    if (k <= pageIndex || !h || h === engine.page) continue;
    M._ec_history_drop_page?.(engine.session, h);
    M._FPDF_ClosePage(h);
    cache.delete(k);
  }
}
function applyFlowPlan(engine, pageIndex, plan, edges = null) {
  const M = engine.M;
  if (engine.pageIndex !== pageIndex) throw new Error("page_not_current");
  for (const [p, page] of plan.pages.entries()) {
    for (const i of page.lines) {
      const l = plan.lines[i];
      const dy = -l.shift + (p ? page.offset : 0);
      if (Math.abs(dy) < 1e-6) continue;
      for (const it of l.items) engine.translateObject(it.h, 0, dy);
    }
  }
  engine._pageDirty = true;
  if (!engine.generateContent()) throw new Error("source_generate_failed");
  const added = plan.pages.length - 1;
  const lineCounts = [];
  if (added > 0) {
    if (edges) {
      const fresh = snapshotPageEdges(engine, plan.floor, plan.bodyTop);
      if (!fresh.ok) throw coded(fresh.code);
      const key3 = (s) => JSON.stringify(s.items.map((i) => [i.role, i.text, i.chars.map((c) => [c.u, c.ox.toFixed(2), c.oy.toFixed(2)])]));
      if (key3(fresh) !== key3(edges)) throw coded("continuation_edge_snapshot_drift");
      const pre = preflightPageEdges(engine, fresh, added);
      if (!pre.ok) throw coded(pre.code);
      edges = fresh;
    }
    evictPagesAfter(engine, pageIndex);
    const W = engine.pageWidth, H = engine.pageHeight;
    const before = M._FPDFPage_CountObjects(engine.page);
    let movedTotal = 0;
    let copiedEdges = 0;
    for (let p = 1; p <= added; p++) {
      const np = M._FPDFPage_New(engine.doc, pageIndex + p, W, H);
      if (!np) throw new Error("page_new_failed");
      try {
        const now = new Map(listObjects2(M, engine.page).map((h, i) => [h, i]));
        const handles = plan.pages[p].lines.flatMap((i) => plan.lines[i].items.map((it) => it.h));
        if (handles.some((h) => !now.has(h))) throw new Error("object_not_on_source_page");
        handles.sort((a, b) => now.get(a) - now.get(b));
        const bodyIndex = edges ? Math.min(...handles.map((h) => edges.order.get(h) ?? Infinity)) : Infinity;
        const applied = edges ? applyPageEdges(engine, np, edges, p, bodyIndex) : { ok: true, items: [], bodyAt: 0 };
        if (!applied.ok) throw coded(applied.code);
        if (applied.items.length && !M._FPDFPage_GenerateContent(np)) throw new Error("continuation_generate_failed");
        let at = applied.bodyAt;
        for (const h of handles) {
          if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new Error("remove_failed");
          if (!M._FPDFPage_InsertObjectAtIndex(np, h, at++)) throw new Error("insert_failed");
        }
        if (M._FPDFPage_CountObjects(np) !== handles.length + applied.items.length) throw new Error("insert_count_mismatch");
        if (edges) {
          const proof = verifyPageEdges(engine, np, edges, p, applied);
          if (!proof.ok) throw coded(proof.code);
        }
        if (!M._FPDFPage_GenerateContent(np)) throw new Error("continuation_generate_failed");
        movedTotal += handles.length;
        copiedEdges += applied.items.length;
        lineCounts.push(plan.pages[p].lines.length);
      } finally {
        M._FPDF_ClosePage(np);
      }
    }
    if (M._FPDFPage_CountObjects(engine.page) !== before - movedTotal) throw new Error("source_count_mismatch");
    engine._pageDirty = true;
    if (!engine.generateContent()) throw new Error("source_generate_failed");
    M._ec_history_drop_page?.(engine.session, engine.page);
    engine._pageStale = true;
    engine.buildModel();
    engine.pageCount = M._FPDF_GetPageCount(engine.doc);
    return { added, lineCounts, keptLines: plan.pages[0].lines.length, copiedEdges };
  }
  return { added, lineCounts, keptLines: plan.pages[0].lines.length, copiedEdges: 0 };
}
function paginateOverflow(engine, ctx, grown, { floor, maxNewPages }) {
  const warnings = [];
  const repairs = [];
  const reject = (code, extra = {}) => {
    warnings.push({ code, severity: "error", ...extra });
    repairs.push({ kind: "pagination", action: "rejected", reason: code });
    return { ok: false, warnings, repairs, added: 0 };
  };
  const plan = buildFlowPlan(engine, ctx, grown, { floor, maxNewPages });
  if (!plan.ok) return reject(plan.code, plan.maxNewPages !== void 0 ? { maxNewPages: plan.maxNewPages } : {});
  let edges = null;
  if (plan.pages.length > 1) {
    const flow = new Set(plan.lines.flatMap((l) => l.items.map((it) => it.h)));
    edges = snapshotPageEdges(engine, plan.floor, plan.bodyTop, flow);
    if (!edges.ok) return reject(edges.code);
    const pre = preflightPageEdges(engine, edges, plan.pages.length - 1);
    if (!pre.ok) return reject(pre.code);
  }
  let r;
  try {
    r = applyFlowPlan(engine, ctx.pageIndex, plan, edges);
  } catch (e) {
    warnings.push(e?.code ? { code: e.code, severity: "error" } : { code: "pagination_apply_failed", severity: "error", reason: String(e?.message || e).slice(0, 80) });
    repairs.push({ kind: "pagination", action: "failed" });
    return { ok: false, warnings, repairs, added: 0 };
  }
  if (edges?.fixedGraphics) warnings.push({ code: "continuation_fixed_edge_graphics_not_repeated", severity: "warning", count: edges.fixedGraphics, policy: "source-graphics-preserved-text-only-continuation" });
  if (plan.orphans) warnings.push({ code: "pagination_empty_objects_kept", severity: "info", count: plan.orphans });
  repairs.push({ kind: "pagination", action: r.added ? "continued" : "shifted", added: r.added, keptLines: r.keptLines, lineCounts: r.lineCounts, copiedEdges: r.copiedEdges, floor: +plan.floor.toFixed(2), bodyTop: +plan.bodyTop.toFixed(2) });
  const continuationStyle = r.added ? { version: CONTINUATION_STYLE.version, policy: CONTINUATION_STYLE.policy, applied: true } : void 0;
  return { ok: true, warnings, repairs, added: r.added, lineCounts: r.lineCounts, keptLines: r.keptLines, bodyTop: plan.bodyTop, flowTop: plan.flowTop, flowColumn: plan.flowColumn, floor: plan.floor, continuationStyle };
}
var OBJ_TEXT3, EPS, PAGINATION_LIMITS, PAGINATION_CAPABILITY, hOverlap2, sameColumn, coded;
var init_pagination = __esm({
  "src/paragraph-vendor/pagination.mjs"() {
    init_quality();
    init_continuation_template();
    OBJ_TEXT3 = 1;
    EPS = 0.01;
    PAGINATION_LIMITS = Object.freeze({ defaultMaxNewPages: 8, maxNewPages: 32 });
    PAGINATION_CAPABILITY = Object.freeze({
      supported: true,
      scope: "single-column top-level body text flow below the edited paragraph on unrotated, uncropped pages",
      continuationPages: "same size as the source page, inserted directly after it; moved body lines plus source-style copies of the source page's header/footer text; a standalone Arabic page number becomes source number plus decimal suffix (10.1, 10.2); no synthesized label",
      fixedEdgeGraphics: "graphics wholly within the physical edge band stay on the original page and are omitted on text-only continuations, with an explicit warning; body-intersecting graphics still refuse",
      sourcePageNumbers: "unchanged; existing page-number objects stay on their source page",
      continuationStyle: Object.freeze({ version: CONTINUATION_STYLE.version, policy: CONTINUATION_STYLE.policy }),
      downstreamPages: "never modified; only their output index shifts, see report.pagination.sourcePageMap",
      maxNewPagesDefault: PAGINATION_LIMITS.defaultMaxNewPages,
      maxNewPagesLimit: PAGINATION_LIMITS.maxNewPages,
      unsupported: Object.freeze([
        "multi_column_flow",
        "foreign_object_in_flow",
        "edge_paragraph_in_flow",
        "rotated_page",
        "cropped_or_offset_page",
        "type3_segments",
        "non_top_level_text",
        "shared_objects",
        "edge_graphics",
        "edge_clip",
        "edge_text_layout",
        "edge_style",
        "ambiguous_page_number",
        "page_number_spacing",
        "page_number_glyph_missing"
      ])
    });
    hOverlap2 = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    sameColumn = (a, b) => hOverlap2(a, b) >= 0.35 * Math.min(a.w, b.w);
    coded = (code) => Object.assign(new Error(code), { code });
  }
});

// src/paragraph-vendor/editor.mjs
init_paragraph_pdf_crypto();

// src/paragraph-vendor/engine/foreign-gap.mjs
function removeForeignObjectGapSpaces(modelRuns, runs, chars, owned) {
  const original = modelRuns.map((r) => r.text).join("");
  const replacement = runs.map((r) => r.text).join("");
  let prefix = 0;
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
  const source2 = chars.filter((c) => owned.has(c.obj) && c.ch && !/\s/.test(c.ch));
  const model = [...original].filter((ch) => !/\s/.test(ch));
  if (model.length !== source2.length || model.some((ch, i) => ch !== source2[i].ch)) return runs;
  const positions = [];
  let gi = 0;
  for (let i = 0; i < original.length; i++) if (!/\s/.test(original[i])) positions[i] = gi++;
  const drops = [];
  for (let i = 1; i + 1 < Math.min(prefix, original.length); i++) {
    if (original[i] !== " " || /\s/.test(original[i - 1]) || /\s/.test(original[i + 1])) continue;
    const a = source2[positions[i - 1]], b = source2[positions[i + 1]];
    if (!a?.box || !b?.box || a.obj === b.obj || a.index >= b.index) continue;
    const between = chars.slice(a.index + 1, b.index);
    if (!between.length || between.some((c) => !c.ch || /\s/.test(c.ch) || owned.has(c.obj) || !c.box)) continue;
    const [al, ar, ab, at] = a.box, [bl, br, bb, bt] = b.box;
    if (!(ar <= bl && Math.min(at, bt) >= Math.max(ab, bb))) continue;
    if (between.some((c) => c.box[0] < ar - 0.1 || c.box[1] > bl + 0.1 || c.box[3] < Math.min(ab, bb) || c.box[2] > Math.max(at, bt))) continue;
    drops.push(i);
  }
  if (!drops.length) return runs;
  let offset = 0;
  return runs.map((r) => {
    const start = offset;
    offset += r.text.length;
    const local = drops.filter((i) => i >= start && i < offset).map((i) => i - start);
    if (!local.length) return r;
    return { ...r, text: [...r.text].filter((_, i) => !local.includes(i)).join("") };
  });
}
function restoreSourceWordGaps(modelRuns, runs, chars, owned) {
  const original = modelRuns.map((r) => r.text).join("");
  const replacement = runs.map((r) => r.text).join("");
  const source2 = chars.filter((c) => owned.has(c.obj) && c.ch && !/\s/.test(c.ch));
  const positions = [];
  for (let i = 0; i < original.length; i++) if (!/\s/.test(original[i])) positions.push(i);
  if (source2.length !== positions.length || positions.some((p, i) => original[p] !== source2[i].ch)) return runs;
  const provenGap = (a, b) => {
    if (!a.box || !b.box || a.index >= b.index) return false;
    const between = chars.slice(a.index + 1, b.index);
    if (!between.length || between.some((c) => c.ch !== " " || !c.box || !owned.has(c.obj) && !c.generated)) return false;
    const [, ar, ab, at2] = a.box, [bl, , bb, bt] = b.box;
    if (!(ar <= bl && Math.min(at2, bt) >= Math.max(ab, bb))) return false;
    return !between.some((c) => c.box[0] < ar - 0.1 || c.box[1] > bl + 0.1 || c.box[3] < Math.min(ab, bb) || c.box[2] > Math.max(at2, bt));
  };
  const shifted = runs.map((r) => ({ ...r }));
  const starts = [];
  let at = 0;
  for (const r of modelRuns) {
    starts.push(at);
    at += r.text.length;
  }
  for (let i = 1; i < shifted.length; i++) {
    const a = shifted[i - 1], b = shifted[i], ai = a.sourceIndex, bi = b.sourceIndex;
    if (!Number.isInteger(ai) || bi !== ai + 1 || !modelRuns[ai] || !modelRuns[bi]) continue;
    const leftText = modelRuns[ai].text, rightText = modelRuns[bi].text;
    if (!leftText || !/^ \S/.test(rightText) || a.text !== leftText || !b.text.startsWith(rightText.slice(0, 2))) continue;
    const p = starts[bi];
    const gi = positions.indexOf(p - 1);
    if (gi < 0 || positions[gi + 1] !== p + 1 || !provenGap(source2[gi], source2[gi + 1])) continue;
    a.text += " ";
    b.text = b.text.slice(1);
  }
  runs = shifted;
  let prefix = 0, suffix = 0;
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
  while (suffix < original.length - prefix && suffix < replacement.length - prefix && original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++;
  const insertions = [];
  for (let i = 0; i + 1 < source2.length; i++) {
    const left = positions[i], right = positions[i + 1];
    if (right !== left + 1) continue;
    let target;
    if (right < prefix) target = right;
    else if (left >= original.length - suffix) target = replacement.length - (original.length - right);
    else continue;
    if (!provenGap(source2[i], source2[i + 1])) continue;
    insertions.push(target);
  }
  if (!insertions.length) return runs;
  let offset = 0;
  return runs.map((r) => {
    const start = offset;
    offset += r.text.length;
    const local = insertions.filter((i) => i >= start && i < offset).map((i) => i - start);
    if (!local.length) return r;
    let text3 = r.text;
    for (const i of local.reverse()) text3 = text3.slice(0, i) + " " + text3.slice(i);
    return { ...r, text: text3 };
  });
}

// src/paragraph-pdf-engine-loader.mjs
function createEngineModule() {
  throw new Error("Use verified paragraph runtime factory");
}

// src/paragraph-vendor/engine/type3surgery.js
init_shadingsurgery();
function applyType3LeftoverSurgery(savedBytes, jobs) {
  jobs = (jobs || []).filter(
    (j) => j && j.seg && (j.state || []).some((o) => o.t3 && o.glyphs && o.glyphs.length)
  );
  if (!jobs.length) return null;
  const saved = latin(savedBytes);
  const sp = parsePdf(saved);
  if (!sp) return null;
  let next = sp.size;
  const newObjs = [], pageRewrites = [];
  const injected = {};
  for (const job of jobs) {
    const leftovers = job.state.filter(
      (o) => o.t3 && o.glyphs && o.glyphs.length
    );
    leftovers.sort((a, b) => {
      const band = (o) => Math.round(-o.m[5] / 6);
      return band(a) - band(b) || a.m[4] - b.m[4];
    });
    const tjs = job.seg.tjs || [];
    const anchors = job.anchors || {};
    const usedTj = /* @__PURE__ */ new Set();
    const lines2 = [];
    const injectedTjs = [];
    for (const o of leftovers) {
      let name = anchors[o.font] ?? null;
      const oCodes = o.glyphs.map((g) => g[0]);
      if (!name) {
        const sameCodes = (tj) => tj.codes.length === oCodes.length && tj.codes.every((c, k) => c === oCodes[k]);
        let hit = tjs.findIndex(
          (tj, i) => !usedTj.has(i) && Math.abs(tj.e - o.m[4]) < 0.05 && Math.abs(tj.f - o.m[5]) < 0.05 && sameCodes(tj)
        );
        if (hit < 0)
          hit = tjs.findIndex((tj, i) => !usedTj.has(i) && sameCodes(tj));
        if (hit < 0) {
          hit = tjs.findIndex(
            (tj, i) => !usedTj.has(i) && tj.codes.length >= oCodes.length && oCodes.every((c, k) => c === tj.codes[k])
          );
        }
        if (hit < 0) {
          console.warn("[type3] leftover glyph unmatched \u2014 skipped");
          continue;
        }
        usedTj.add(hit);
        name = tjs[hit].font;
      }
      const shownCodes = [];
      const num6 = (v) => (Math.round(v * 1e4) / 1e4).toString();
      const hex4 = (c) => "<" + (c > 255 ? c.toString(16).padStart(4, "0") : c.toString(16).padStart(2, "0")) + ">";
      let ops = "q ";
      ops += `${num6(o.fill[0] / 255)} ${num6(o.fill[1] / 255)} ${num6(o.fill[2] / 255)} rg `;
      ops += `${num6(o.stroke[0] / 255)} ${num6(o.stroke[1] / 255)} ${num6(o.stroke[2] / 255)} RG `;
      if (o.sw > 0) ops += `${num6(o.sw)} w `;
      ops += `BT ${o.m.map(num6).join(" ")} Tm /${name} ${num6(o.size)} Tf `;
      if (o.tr) ops += `${o.tr} Tr `;
      const known = /* @__PURE__ */ new Set();
      for (const tj of tjs)
        if (tj.font === name) tj.codes.forEach((c) => known.add(c));
      let px = 0, py = 0;
      o.glyphs.forEach(([c, gx, gy], gi) => {
        if (gi === 0) {
          if (gx || gy) ops += `${num6(gx)} ${num6(gy)} Td `;
        } else ops += `${num6(gx - px)} ${num6(gy - py)} Td `;
        px = gx;
        py = gy;
        if (known.has(c)) {
          ops += hex4(c) + " Tj ";
          shownCodes.push(c);
        }
      });
      ops += "ET Q";
      injectedTjs.push({
        e: o.m[4],
        f: o.m[5],
        font: name,
        size: o.size,
        codes: shownCodes
      });
      lines2.push(ops);
    }
    if (!lines2.length) continue;
    const prefix = "ET Q\n".repeat(leftovers.length);
    const body = prefix + lines2.join("\n") + "\n";
    const pgNum = sp.pageNum(job.pageIndex);
    if (pgNum < 0) continue;
    const spg = sp.objBody(pgNum);
    if (!spg) continue;
    const cOne = spg.body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    const cArr = spg.body.match(/\/Contents\s*\[([^\]]*)\]/);
    if (!cOne && !cArr) continue;
    const snum = next++;
    newObjs.push({
      num: snum,
      body: `<< /Length ${body.length} >>
stream
${body}endstream`
    });
    const refList = cOne ? `${cOne[1]} 0 R` : cArr[1].trim();
    let newPage = spg.body.replace(
      cOne ? cOne[0] : cArr[0],
      `/Contents [ ${refList} ${snum} 0 R ]`
    );
    const usedNames = new Set(
      (lines2.join(" ").match(/\/([A-Za-z0-9_.#-]+)\s+[\d.]+\s+Tf/g) ?? []).map(
        (s) => s.match(/\/([A-Za-z0-9_.#-]+)/)[1]
      )
    );
    const rref = newPage.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (rref) {
      const rnum = parseInt(rref[1], 10);
      const ro = sp.objBody(rnum);
      if (ro) {
        const res = mergeFonts(ro.body, usedNames, job.seg.fonts);
        if (res !== ro.body) pageRewrites.push({ num: rnum, body: res });
      }
    } else {
      newPage = mergeFonts(newPage, usedNames, job.seg.fonts);
    }
    pageRewrites.push({ num: pgNum, body: newPage });
    injected[job.pageIndex] = injectedTjs;
  }
  if (!newObjs.length) return null;
  return {
    bytes: appendRevision(saved, sp.rootNum, next, pageRewrites, newObjs),
    injected
  };
}
function mergeFonts(body, usedNames, fontNums) {
  const resAt = body.indexOf("/Resources");
  const resDict = resAt >= 0 ? dictAt(body, resAt) : dictAt(body, 0);
  if (!resDict) return body;
  const fontDict = dictAt(resDict, resDict.indexOf("/Font"));
  const missing = [...usedNames].filter(
    (n) => fontNums[n] != null && !(fontDict || "").match(
      new RegExp("/" + n.replace(/[^A-Za-z0-9_]/g, "\\$&") + "[\\s/]")
    )
  );
  if (!missing.length) return body;
  const entries2 = missing.map((n) => `/${n} ${fontNums[n]} 0 R`).join(" ");
  let newRes;
  if (fontDict)
    newRes = resDict.replace(
      fontDict,
      fontDict.replace(/^<</, `<< ${entries2} `)
    );
  else newRes = resDict.replace(/^<</, `<< /Font << ${entries2} >> `);
  return body.replace(resDict, newRes);
}
function appendRevision(src, rootNum, size3, pageRewrites, newObjs) {
  let out = src;
  if (!out.endsWith("\n")) out += "\n";
  const offsets = /* @__PURE__ */ new Map();
  const emit = (num, body) => {
    offsets.set(num, out.length);
    out += `${num} 0 obj
${body.trim()}
endobj
`;
  };
  for (const o of pageRewrites) emit(o.num, o.body);
  for (const o of newObjs) emit(o.num, o.body);
  const xrefAt = out.length;
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  let xref = "xref\n";
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}
`;
    for (let k = i; k <= j; k++)
      xref += String(offsets.get(nums[k])).padStart(10, "0") + " 00000 n \n";
    i = j + 1;
  }
  out += xref;
  const prevAt = src.lastIndexOf("startxref");
  const prevNum = parseInt(src.slice(prevAt + 9).trim(), 10);
  const infoM = src.slice(src.lastIndexOf("trailer")).match(/\/Info\s+(\d+)\s+\d+\s+R/);
  out += `trailer
<< /Size ${size3} /Root ${rootNum} 0 R` + (infoM ? ` /Info ${infoM[1]} 0 R` : "") + (Number.isFinite(prevNum) ? ` /Prev ${prevNum}` : "") + ` >>
startxref
${xrefAt}
%%EOF
`;
  const u8 = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 255;
  return u8;
}

// src/paragraph-vendor/engine/core.js
init_shadingsurgery();

// src/paragraph-vendor/utils/freetext-script.ts
var WINANSI_SAFE = /^[ - -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ\r\n\t]*$/;
function needsFontEmbedding(text3) {
  return !WINANSI_SAFE.test(text3 ?? "");
}

// src/paragraph-vendor/engine/core.js
var createEditCore = createEngineModule;
var devBust = "";
var RUN_SIZE = 60;
var FMT_SIZE = 36;
var sfntCoverMemo = /* @__PURE__ */ new WeakMap();
function sfntCovers(bytes2, cps) {
  let per = sfntCoverMemo.get(bytes2);
  if (!per) {
    per = /* @__PURE__ */ new Map();
    sfntCoverMemo.set(bytes2, per);
  }
  const key3 = cps.length ? cps.join(",") : "";
  const hit = per.get(key3);
  if (hit !== void 0) return hit;
  const computed = sfntCoversUncached(bytes2, cps);
  if (per.size < 512) per.set(key3, computed);
  return computed;
}
function sfntCoversUncached(bytes2, cps) {
  try {
    const u16 = (o) => bytes2[o] << 8 | bytes2[o + 1];
    const u32 = (o) => (bytes2[o] << 24 | bytes2[o + 1] << 16 | bytes2[o + 2] << 8 | bytes2[o + 3]) >>> 0;
    let base = 0;
    if (u32(0) === 1953784678) base = u32(12);
    const num = u16(base + 4);
    let cmap = 0;
    for (let i = 0; i < num; i++) {
      const o = base + 12 + i * 16;
      if (u32(o) === 1668112752) {
        cmap = u32(o + 8);
        break;
      }
    }
    if (!cmap) return false;
    const nt = u16(cmap + 2);
    let sub = 0, fmt2 = -1, score = -1;
    for (let i = 0; i < nt; i++) {
      const rec = cmap + 4 + i * 8;
      const pid = u16(rec), eid = u16(rec + 2), off = cmap + u32(rec + 4);
      const f = u16(off);
      const sc = pid === 3 && eid === 10 ? 3 : pid === 3 && eid === 1 ? 2 : pid === 0 ? 1 : 0;
      if (sc > score && (f === 4 || f === 12)) {
        score = sc;
        sub = off;
        fmt2 = f;
      }
    }
    if (!sub) return false;
    const lookup4 = (cp) => {
      if (cp > 65535) return 0;
      const segX2 = u16(sub + 6);
      for (let s2 = 0; s2 < segX2; s2 += 2) {
        const end = u16(sub + 14 + s2);
        if (cp <= end) {
          const start = u16(sub + 16 + segX2 + s2);
          if (cp < start) return 0;
          const delta = u16(sub + 16 + segX2 * 2 + s2);
          const roBase = sub + 16 + segX2 * 3 + s2;
          const ro = u16(roBase);
          if (!ro) return cp + delta & 65535;
          const g = u16(roBase + ro + (cp - start) * 2);
          return g ? g + delta & 65535 : 0;
        }
      }
      return 0;
    };
    const lookup12 = (cp) => {
      const n = u32(sub + 12);
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const mid = lo + hi >> 1, g = sub + 16 + mid * 12;
        const s0 = u32(g), e0 = u32(g + 4);
        if (cp < s0) hi = mid - 1;
        else if (cp > e0) lo = mid + 1;
        else return u32(g + 8) + (cp - s0);
      }
      return 0;
    };
    for (const cp of cps) {
      if (cp === 32 || cp === 10 || cp === 13) continue;
      if ((fmt2 === 12 ? lookup12(cp) : lookup4(cp)) === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
function scriptFallbackFamilies(cps) {
  const TABLE = [
    [
      [
        [1536, 1791],
        [1872, 1919],
        [64336, 65023],
        [65136, 65279]
      ],
      [
        "Geeza Pro",
        "Al Nile",
        "Damascus",
        "Baghdad",
        "Noto Naskh Arabic",
        "Noto Sans Arabic",
        "Arial Unicode MS",
        "Arial"
      ]
    ],
    [
      [
        [1424, 1535],
        [64285, 64335]
      ],
      [
        "Arial Hebrew",
        "Lucida Grande",
        "Noto Sans Hebrew",
        "Arial Unicode MS",
        "Arial"
      ]
    ],
    [
      [[2304, 2431]],
      [
        "Kohinoor Devanagari",
        "Devanagari MT",
        "ITF Devanagari",
        "Nirmala UI",
        "Mangal",
        "Noto Sans Devanagari",
        "Arial Unicode MS"
      ]
    ],
    [
      [[2432, 2559]],
      [
        "Kohinoor Bangla",
        "Bangla MN",
        "Nirmala UI",
        "Vrinda",
        "Noto Sans Bengali",
        "Arial Unicode MS"
      ]
    ],
    [
      [[2560, 2687]],
      [
        "Gurmukhi MN",
        "Nirmala UI",
        "Raavi",
        "Noto Sans Gurmukhi",
        "Arial Unicode MS"
      ]
    ],
    [
      [[2688, 2815]],
      [
        "Kohinoor Gujarati",
        "Gujarati MT",
        "Nirmala UI",
        "Shruti",
        "Noto Sans Gujarati",
        "Arial Unicode MS"
      ]
    ],
    [
      [[2944, 3071]],
      [
        "Tamil MN",
        "InaiMathi",
        "Nirmala UI",
        "Latha",
        "Noto Sans Tamil",
        "Arial Unicode MS"
      ]
    ],
    [
      [[3072, 3199]],
      [
        "Kohinoor Telugu",
        "Telugu MN",
        "Nirmala UI",
        "Gautami",
        "Noto Sans Telugu",
        "Arial Unicode MS"
      ]
    ],
    [
      [[3200, 3327]],
      [
        "Kannada MN",
        "Nirmala UI",
        "Tunga",
        "Noto Sans Kannada",
        "Arial Unicode MS"
      ]
    ],
    [
      [[3328, 3455]],
      [
        "Malayalam MN",
        "Nirmala UI",
        "Kartika",
        "Noto Sans Malayalam",
        "Arial Unicode MS"
      ]
    ],
    [
      [[3584, 3711]],
      [
        "Thonburi",
        "Sukhumvit Set",
        "Leelawadee UI",
        "Tahoma",
        "Noto Sans Thai",
        "Arial Unicode MS"
      ]
    ],
    [
      [
        [12352, 12543],
        [13312, 40959],
        [63744, 64255]
      ],
      [
        "PingFang SC",
        "Hiragino Sans",
        "Hiragino Sans GB",
        "Songti SC",
        "STHeiti",
        "Apple SD Gothic Neo",
        "Microsoft YaHei",
        "Yu Gothic",
        "Meiryo",
        "SimSun",
        "MS Gothic",
        "Malgun Gothic",
        "Noto Sans CJK SC",
        "Noto Sans SC",
        "Arial Unicode MS"
      ]
    ],
    [
      [[44032, 55215]],
      [
        "Apple SD Gothic Neo",
        "AppleGothic",
        "Malgun Gothic",
        "Batang",
        "Noto Sans KR",
        "Noto Sans CJK KR",
        "Arial Unicode MS"
      ]
    ],
    [
      [[2816, 2943]],
      ["Oriya MN", "Nirmala UI", "Kalinga", "Noto Sans Oriya"]
    ],
    [
      [[3456, 3583]],
      ["Sinhala MN", "Nirmala UI", "Iskoola Pota", "Noto Sans Sinhala"]
    ],
    [
      [[3712, 3839]],
      ["Lao MN", "Lao Sangam MN", "Leelawadee UI", "Noto Sans Lao"]
    ],
    [
      [[4096, 4255]],
      ["Myanmar MN", "Myanmar Sangam MN", "Myanmar Text", "Noto Sans Myanmar"]
    ],
    [
      [[6016, 6143]],
      ["Khmer MN", "Khmer Sangam MN", "Leelawadee UI", "Noto Sans Khmer"]
    ],
    [
      [[1328, 1423]],
      ["Mshtakan", "Sylfaen", "Noto Sans Armenian", "Arial Unicode MS"]
    ],
    [[[4256, 4351]], ["Noto Sans Georgian", "Sylfaen", "Arial Unicode MS"]],
    [[[4608, 4991]], ["Kefa", "Nyala", "Noto Sans Ethiopic"]],
    [
      [[3840, 4095]],
      ["Kailasa", "Microsoft Himalaya", "Noto Sans Tibetan"]
    ],
    [[[5024, 5119]], ["Plantagenet Cherokee", "Noto Sans Cherokee"]],
    [[[1792, 1871]], ["Noto Sans Syriac", "Estrangelo Edessa"]],
    [[[1920, 1983]], ["Noto Sans Thaana", "MV Boli"]]
  ];
  const out = [];
  for (const cp of cps) {
    for (const [ranges, fams] of TABLE) {
      if (ranges.some(([a, b]) => cp >= a && cp <= b)) {
        for (const f of fams) if (!out.includes(f)) out.push(f);
      }
    }
  }
  return out;
}
var PAGE_CACHE_MAX = 6;
var PdfEngine = class _PdfEngine {
  static localFonts = /* @__PURE__ */ new Map();
  static fallbackFonts = /* @__PURE__ */ new Map();
  constructor(module, fontSnapshot = null) {
    this.M = module;
    this.fontSnapshot = fontSnapshot;
    this.doc = 0;
    this.page = 0;
    this.session = 0;
    this.pageIndex = 0;
    this.pageCount = 0;
    this.pageWidth = 0;
    this.pageHeight = 0;
    this._docBuf = 0;
    this._providerPtr = 0;
  }
  _makeProvider() {
    const M = this.M;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(psmt|mt|ps)$/, "");
    const normLookup = (fam, styleKey2, want) => {
      const target = norm(fam);
      if (!target) return null;
      let anyStyle = null;
      for (const [k, b] of _PdfEngine.localFonts) {
        if (!b || !b.length) continue;
        const bar = k.indexOf("|");
        const kf = bar < 0 ? k : k.slice(0, bar);
        if (norm(kf) !== target) continue;
        if (want.length && !sfntCovers(b, want)) continue;
        const ks = bar < 0 ? "" : k.slice(bar + 1);
        if (ks === styleKey2) return b;
        if (!anyStyle) anyStyle = b;
      }
      return anyStyle;
    };
    return M.addFunction(
      (ctx, familyPtr, bold, italic, cps, n, outData, outSize) => {
        let fam = M.UTF8ToString(familyPtr);
        fam = fam.replace(/ (serif|mono)$/, "");
        const want = [];
        for (let i = 0; i < n; i++) want.push(M.HEAPU32[(cps >> 2) + i]);
        if (this.fontSnapshot) {
          const key3 = (s) => {
            let name = String(s || "").replace(/^[A-Z]{6}\+/, "");
            name = name.replace(/^(TimesNewRomanPS|Arial)-(BoldItalic|BoldOblique|Bold|Italic|Oblique)MT$/i, (_, family, variant) => `${/^arial$/i.test(family) ? "Arial" : "TimesNewRoman"}-${variant}`);
            name = name.replace(/[-,](?:bolditalic|boldoblique|bold|italic|oblique|regular|roman)$/i, "").toLowerCase().replace(/[\s_-]+/g, "");
            return { timesnewromanpsmt: "timesnewroman", arialmt: "arial" }[name] || name;
          };
          const target = key3(fam);
          const faces = this.fontSnapshot.fonts;
          const matches = (f) => target && (key3(f.family) === target || key3(f.postscriptName) === target);
          const rank = (f) => (f.italic === !!italic ? 0 : 2e3) + Math.abs(f.weight - (bold ? 700 : 400));
          const covering = (f) => f.bytes.length && (!want.length || sfntCovers(f.bytes, want));
          const same = faces.filter(matches).sort((a, b) => rank(a) - rank(b));
          const bestRank = same.length ? rank(same[0]) : Infinity;
          let face = same.find((f) => rank(f) === bestRank && covering(f));
          if (!face) face = faces.filter((f) => !matches(f) && covering(f)).sort((a, b) => rank(a) - rank(b))[0];
          if (!face) return 0;
          const selection = {
            requestedFamily: fam,
            bold: !!bold,
            italic: !!italic,
            family: face.family,
            postscriptName: face.postscriptName || null,
            weight: face.weight,
            faceItalic: face.italic,
            source: face.source,
            sha256: face.sha256,
            fallback: !matches(face),
            styleSubstitution: face.weight >= 600 !== !!bold || face.italic !== !!italic
          };
          if (!this.fontSnapshot.selections.some((s) => JSON.stringify(s) === JSON.stringify(selection)))
            this.fontSnapshot.selections.push(selection);
          const buf2 = M._ec_buffer_alloc(face.bytes.length);
          if (!buf2) return 0;
          M.HEAPU8.set(face.bytes, buf2);
          M.HEAPU32[outData >> 2] = buf2;
          M.HEAPU32[outSize >> 2] = face.bytes.length;
          return 1;
        }
        const styleKey2 = (bold ? 1 : 0) + "" + (italic ? 1 : 0);
        const sk = "|" + styleKey2;
        const names = [fam, ...scriptFallbackFamilies(want)];
        let bytes2 = null;
        for (const nm of names) {
          for (const k of [nm + sk, nm]) {
            const b = _PdfEngine.localFonts.get(k);
            if (b && b.length && (!want.length || sfntCovers(b, want))) {
              bytes2 = b;
              break;
            }
          }
          if (bytes2) break;
        }
        if (!bytes2) bytes2 = normLookup(fam, styleKey2, want);
        if (!bytes2 && want.some((cp) => needsFontEmbedding(String.fromCodePoint(cp)))) {
          for (const b of _PdfEngine.fallbackFonts.values()) {
            if (b && b.length && sfntCovers(b, want)) {
              bytes2 = b;
              break;
            }
          }
        }
        if (!bytes2 || !bytes2.length) return 0;
        const buf = M._ec_buffer_alloc(bytes2.length);
        if (!buf) return 0;
        M.HEAPU8.set(bytes2, buf);
        M.HEAPU32[outData >> 2] = buf;
        M.HEAPU32[outSize >> 2] = bytes2.length;
        return 1;
      },
      "iiiiiiiii"
    );
  }
  static async create() {
    const M = await createEditCore(
      devBust ? {
        locateFile: (f, prefix) => `${prefix}${f}?v=${devBust}`
      } : void 0
    );
    const cfg = M._malloc(48);
    M.HEAPU8.fill(0, cfg, cfg + 48);
    M.HEAPU32[cfg >> 2] = 2;
    M._FPDF_InitLibraryWithConfig(cfg);
    M._free(cfg);
    return new _PdfEngine(M);
  }
  static disambiguateSubsetFonts(bytes2) {
    const probe = probePdfBytes(bytes2);
    if (!probe.subsetFont || !probe.form) return bytes2;
    const s = new TextDecoder("latin1").decode(bytes2);
    const fonts = [];
    for (const m of s.matchAll(/(\d+)\s+0\s+obj\b/g)) {
      const end = s.indexOf("endobj", m.index);
      if (end < 0) continue;
      const body = s.slice(m.index, end);
      if (!/\/Type\s*\/Font\b/.test(body)) continue;
      const bf = body.match(/\/BaseFont\s*\/([A-Z]{6})\+([^\s/\[\]<>()]+)/);
      if (!bf) continue;
      const fd = body.match(/\/FontDescriptor\s+(\d+)\s+0\s+R/);
      fonts.push({
        obj: Number(m[1]),
        tagAt: m.index + bf.index + bf[0].indexOf(bf[1]),
        tag: bf[1],
        name: bf[2],
        desc: fd ? Number(fd[1]) : 0
      });
    }
    if (!fonts.length) return bytes2;
    const containerFonts = /* @__PURE__ */ new Set();
    for (const m of s.matchAll(/(\d+)\s+0\s+obj\b/g)) {
      const end = s.indexOf("endobj", m.index);
      if (end < 0) continue;
      const body = s.slice(m.index, end);
      if (!/\/Subtype\s*\/Form\b/.test(body)) continue;
      const fi = body.indexOf("/Font");
      if (fi < 0) continue;
      for (const r of body.slice(fi, fi + 800).matchAll(/(\d+)\s+0\s+R/g))
        containerFonts.add(Number(r[1]));
    }
    if (!containerFonts.size) return bytes2;
    const groups = /* @__PURE__ */ new Map();
    for (const f of fonts) {
      const k = f.tag + "+" + f.name;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    const taken = new Set(fonts.map((f) => f.tag));
    const tagFor = (n) => {
      let t = "";
      for (let i = 0; i < 6; i++) {
        t = String.fromCharCode(65 + n % 26) + t;
        n = Math.floor(n / 26);
      }
      return t;
    };
    let seq = 0;
    const nextTag = () => {
      let t;
      do {
        t = tagFor(seq++);
      } while (taken.has(t));
      taken.add(t);
      return t;
    };
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const faces = new Set(fonts.map((f) => f.name));
    const edits = [];
    for (const [, list3] of groups) {
      if (list3.length < 2) continue;
      if (!list3.some((f) => containerFonts.has(f.obj)) || !list3.some((f) => !containerFonts.has(f.obj)))
        continue;
      for (const f of list3) {
        if (!containerFonts.has(f.obj) || !f.name.length) continue;
        let face = null;
        for (let c = 0; c < 26 && !face; c++) {
          const cand = f.name.slice(0, -1) + String.fromCharCode(65 + c);
          if (!faces.has(cand)) face = cand;
        }
        if (!face) continue;
        faces.add(face);
        const tag = nextTag(), lastCh = face[face.length - 1];
        edits.push([f.tagAt, tag], [f.tagAt + 7 + f.name.length - 1, lastCh]);
        if (!f.desc) continue;
        const dm = s.match(
          new RegExp("(?:^|[^0-9])(" + f.desc + "\\s+0\\s+obj\\b)")
        );
        if (!dm) continue;
        const dAt = dm.index + dm[0].indexOf(dm[1]);
        const dEnd = s.indexOf("endobj", dAt);
        const dBody = s.slice(dAt, dEnd < 0 ? void 0 : dEnd);
        const fn = dBody.match(
          new RegExp("/FontName\\s*/(" + f.tag + ")\\+" + esc(f.name))
        );
        if (!fn) continue;
        const at = dAt + fn.index + fn[0].indexOf(fn[1]);
        edits.push([at, tag], [at + 7 + f.name.length - 1, lastCh]);
      }
    }
    if (!edits.length) return bytes2;
    const out = new Uint8Array(bytes2);
    for (const [at, text3] of edits) {
      for (let i = 0; i < text3.length; i++) out[at + i] = text3.charCodeAt(i);
    }
    return out;
  }
  open(bytes2, password, _reentrant) {
    bytes2 = _PdfEngine.disambiguateSubsetFonts(bytes2);
    this._originalBytes = bytes2;
    this.close();
    const M = this.M;
    const buf = M._malloc(bytes2.length);
    M.HEAPU8.set(bytes2, buf);
    let pw = 0;
    if (password) {
      const n = M.lengthBytesUTF8(password) + 1;
      pw = M._malloc(n);
      M.stringToUTF8(password, pw, n);
    }
    const doc = M._FPDF_LoadMemDocument64(buf, bytes2.length, pw);
    if (pw) M._free(pw);
    if (!doc) {
      const err = M._FPDF_GetLastError ? M._FPDF_GetLastError() : -1;
      M._free(buf);
      this.lastOpenError = err;
      const e = new Error(
        err === 4 ? "This PDF is password-protected." : "This file could not be opened as a PDF."
      );
      e.passwordRequired = err === 4;
      throw e;
    }
    this._docBuf = buf;
    this.doc = doc;
    if (!this._providerPtr) this._providerPtr = this._makeProvider();
    this.session = M._ec_session_create(doc, this._providerPtr, 0);
    if (M._ec_set_flatten_forms) {
      const usesPattern = probePdfBytes(bytes2).pattern;
      this._usesPattern = usesPattern;
      M._ec_set_flatten_forms(this.session, usesPattern ? 0 : 1);
    }
    this.pageCount = M._FPDF_GetPageCount(doc);
    this._normalized = /* @__PURE__ */ new Set();
    this._reencoded = /* @__PURE__ */ new Set();
    this._regenHostile = /* @__PURE__ */ new Set();
    this._editedPages = /* @__PURE__ */ new Set();
    this._t3seg = null;
    this._t3state = {};
    this._t3anchors = {};
    this._fragilePages = null;
    this.loadPage(0);
    if (!_reentrant) {
      const info = this.documentInfo();
      this.security = info;
      this._encrypted = !!info.encrypted && !info.signatures;
    }
  }
  reopen(bytes2, pageIndex) {
    const keep = this.pageIndex;
    const orig = this._originalBytes;
    const edited = this._editedPages;
    const t3seg = this._t3seg;
    const fragile = this._fragilePages;
    this._splicePlans = null;
    this._spliceOk = false;
    this.open(bytes2);
    if (orig) this._originalBytes = orig;
    if (edited) this._editedPages = edited;
    if (fragile) this.setFragilePages([...fragile]);
    if (t3seg) this._t3seg = t3seg;
    this.loadPage(Math.min(pageIndex ?? keep, this.pageCount - 1));
  }
  setType3Seg(seg) {
    if (seg && Object.keys(seg).length) this._t3seg = seg;
  }
  _t3readState() {
    const ptr = this.M._ec_page_text_state(this.session, this.page);
    if (!ptr) return null;
    let st = null;
    try {
      st = JSON.parse(this.M.UTF8ToString(ptr));
    } catch {
    }
    this.M._ec_string_free(ptr);
    return st;
  }
  _t3anchor(st) {
    const seg = this._t3seg?.[this.pageIndex];
    if (!seg || !st) return;
    const anchors = (this._t3anchors ||= {})[this.pageIndex] ||= {};
    for (const o of st) {
      if (!o.t3 || !o.glyphs || !o.glyphs.length) continue;
      if (anchors[o.font] != null) continue;
      const oCodes = o.glyphs.map((g) => g[0]);
      const hit = seg.tjs.find(
        (tj) => Math.abs(tj.e - o.m[4]) < 0.05 && Math.abs(tj.f - o.m[5]) < 0.05 && tj.codes.length >= oCodes.length && oCodes.every((c, k) => c === tj.codes[k])
      );
      if (hit) anchors[o.font] = hit.font;
    }
  }
  retainDetachedObject(handle) {
    (this._detachedObjects ||= /* @__PURE__ */ new Set()).add(handle >>> 0);
  }
  close() {
    const M = this.M;
    if (this._pageCache) {
      for (const [, handle] of this._pageCache)
        if (handle && handle !== this.page) M._FPDF_ClosePage(handle);
      this._pageCache.clear();
    }
    if (this.page) M._FPDF_ClosePage(this.page);
    if (this.session) M._ec_session_destroy(this.session);
    for (const handle of this._detachedObjects || []) M._FPDFPageObj_Destroy(handle);
    this._detachedObjects?.clear();
    if (this.doc) M._FPDF_CloseDocument(this.doc);
    if (this._docBuf) M._free(this._docBuf);
    this.page = this.session = this.doc = this._docBuf = 0;
  }
  loadPage(index) {
    const M = this.M;
    this.renderParagraphLiveEnd();
    if (this.page && this._pageDirty) this.generateContent();
    const cache = this._pageCache ||= /* @__PURE__ */ new Map();
    if (this.page) cache.set(this.pageIndex, this.page);
    let handle = cache.get(index);
    if (handle) cache.delete(index);
    else handle = M._FPDF_LoadPage(this.doc, index);
    cache.set(index, handle);
    this.page = handle;
    while (cache.size > PAGE_CACHE_MAX) {
      let victim = null;
      for (const key3 of cache.keys()) {
        if (key3 === index || this.pinnedPages?.has(key3)) continue;
        victim = key3;
        break;
      }
      if (victim === null) break;
      const dead = cache.get(victim);
      cache.delete(victim);
      if (dead) {
        this.M._ec_history_drop_page?.(this.session, dead);
        M._FPDF_ClosePage(dead);
      }
      this.onPageEvicted?.(victim);
    }
    this.pageIndex = index;
    this._pageDirty = false;
    this.pageWidth = M._FPDF_GetPageWidthF(this.page);
    this.pageHeight = M._FPDF_GetPageHeightF(this.page);
    if (this._fragilePages?.has(index)) {
      M._ec_mark_fonts_fragile(this.session, this.page);
    }
    this._readPageTransform();
  }
  setFragilePages(pages) {
    this._fragilePages = new Set(pages || []);
    if (this.page && this._fragilePages.has(this.pageIndex)) {
      this.M._ec_mark_fonts_fragile(this.session, this.page);
    }
  }
  pageWasNormalized() {
    return !!this._reencoded?.has(this.pageIndex);
  }
  normalizeFontsForEdit() {
    if (!this.session || this._normalized?.has(this.pageIndex)) return;
    (this._normalized ||= /* @__PURE__ */ new Set()).add(this.pageIndex);
    const lossy = this.M._ec_page_regen_is_lossy(
      this.session,
      this.page,
      this.pageIndex
    );
    if (lossy === 2) {
      (this._regenHostile ||= /* @__PURE__ */ new Set()).add(this.pageIndex);
      return 0;
    }
    if (lossy === 3) {
      return 0;
    }
    if (lossy) {
      const rebuilt = this.M._ec_reencode_page_fonts(this.session, this.page);
      this._pageDirty = true;
      if (rebuilt > 0) (this._reencoded ||= /* @__PURE__ */ new Set()).add(this.pageIndex);
      return rebuilt;
    }
    return 0;
  }
  pageRegenHostile() {
    return !!this._regenHostile?.has(this.pageIndex);
  }
  documentInfo() {
    const M = this.M;
    const ptr = M._ec_document_info(this.doc);
    if (!ptr) return { pages: 0, signatures: 0 };
    const j = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    return JSON.parse(j);
  }
  metaText(tag) {
    const M = this.M;
    const kp = M._malloc(tag.length + 1);
    for (let i = 0; i < tag.length; i++) M.HEAPU8[kp + i] = tag.charCodeAt(i);
    M.HEAPU8[kp + tag.length] = 0;
    const n = M._FPDF_GetMetaText(this.doc, kp, 0, 0);
    let out = "";
    if (n > 2) {
      const bp = M._malloc(n);
      M._FPDF_GetMetaText(this.doc, kp, bp, n);
      const chars = [];
      for (let i = 0; i + 1 < n - 1; i += 2)
        chars.push(M.HEAPU8[bp + i] | M.HEAPU8[bp + i + 1] << 8);
      out = String.fromCharCode(...chars);
      M._free(bp);
    }
    M._free(kp);
    return out;
  }
  static sniffPdfA(bytes2) {
    const probe = "pdfaid:part";
    const limit = Math.min(bytes2.length, 4 << 20);
    outer: for (let i = 0; i + probe.length < limit; i++) {
      if (bytes2[i] !== 112) continue;
      for (let j = 0; j < probe.length; j++) {
        if (bytes2[i + j] !== probe.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }
  buildModel() {
    const M = this.M;
    if (this._pageStale) {
      this.renderParagraphLiveEnd();
      if (this._pageDirty) this.generateContent();
      M._FPDF_ClosePage(this.page);
      this.page = M._FPDF_LoadPage(this.doc, this.pageIndex);
      this._pageCache?.set(this.pageIndex, this.page);
      this.onPageEvicted?.(this.pageIndex);
      this._pageStale = false;
      this._pageDirty = false;
    }
    if (this._t3seg && this._t3seg[this.pageIndex]) {
      const st = this._t3readState();
      if (st) this._t3anchor(st);
    }
    const ptr = M._ec_build_page_model(this.session, this.page);
    if (!ptr) return [];
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    this._readPageTransform();
    const paragraphs = JSON.parse(json).paragraphs;
    this._gapModel = { pageIndex: this.pageIndex, paragraphs: paragraphs.map((p) => ({ id: p.id, runs: p.runs.map((r) => ({ text: r.text })) })) };
    return paragraphs;
  }
  _readPageTransform() {
    const M = this.M;
    if (!this.session || !this.page) return;
    const cp = M._malloc(24);
    M._ec_page_transform(this.session, this.page, cp);
    this.pageT = Array.from(
      { length: 6 },
      (_, i) => M.HEAPF32[cp + i * 4 >> 2]
    );
    M._free(cp);
    this.cropX = -this.pageT[4];
    this.cropY = -this.pageT[5];
  }
  toModel(x, y) {
    const t = this.pageT || [1, 0, 0, 1, 0, 0];
    return { x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5] };
  }
  toUser(x, y) {
    const t = this.pageT || [1, 0, 0, 1, 0, 0];
    const det = t[0] * t[3] - t[1] * t[2] || 1;
    const dx = x - t[4], dy = y - t[5];
    return {
      x: (t[3] * dx - t[2] * dy) / det,
      y: (-t[1] * dx + t[0] * dy) / det
    };
  }
  _allocStr(s) {
    const M = this.M;
    const n = M.lengthBytesUTF8(s || "") + 1;
    const p = M._malloc(n);
    M.stringToUTF8(s || "", p, n);
    return p;
  }
  _writeRuns(runs) {
    const M = this.M;
    const arr = M._malloc(RUN_SIZE * runs.length);
    const strs = [];
    runs.forEach((r, i) => {
      const b = arr + i * RUN_SIZE;
      const tp = this._allocStr(r.text);
      const fp = this._allocStr(r.family || "");
      strs.push(tp, fp);
      M.HEAPU32[b + 0 >> 2] = tp;
      M.HEAPU32[b + 4 >> 2] = fp;
      M.HEAP32[b + 8 >> 2] = r.bold === 2 ? 2 : r.bold ? 1 : 0;
      M.HEAP32[b + 12 >> 2] = r.italic === 2 ? 2 : r.italic ? 1 : 0;
      M.HEAPF32[b + 16 >> 2] = r.size;
      M.HEAPU32[b + 20 >> 2] = r.rgba >>> 0;
      M.HEAP32[b + 24 >> 2] = r.underline ? 1 : 0;
      M.HEAP32[b + 28 >> 2] = r.strike ? 1 : 0;
      M.HEAP32[b + 32 >> 2] = r.script | 0;
      M.HEAP32[b + 36 >> 2] = r.sourceIndex == null ? -1 : r.sourceIndex;
      M.HEAP32[b + 40 >> 2] = r.renderMode | 0;
      M.HEAPU32[b + 44 >> 2] = (r.strokeRgba || 0) >>> 0;
      M.HEAPF32[b + 48 >> 2] = r.strokeWidth || 1;
      M.HEAPF32[b + 52 >> 2] = r.hScale || 1;
      M.HEAPF32[b + 56 >> 2] = r.rise || 0;
    });
    return { arr, strs, count: runs.length };
  }
  _writeFmt(fmt2) {
    const M = this.M;
    const p = M._malloc(FMT_SIZE);
    M.HEAP32[p + 0 >> 2] = fmt2.align | 0;
    M.HEAPF32[p + 4 >> 2] = fmt2.lineSpacing;
    M.HEAPF32[p + 8 >> 2] = fmt2.charSpacing || 0;
    M.HEAPF32[p + 12 >> 2] = fmt2.paraSpacing || 0;
    M.HEAPF32[p + 16 >> 2] = fmt2.wordSpacing || 0;
    M.HEAPF32[p + 20 >> 2] = fmt2.firstIndent || 0;
    M.HEAPF32[p + 24 >> 2] = fmt2.hangIndent || 0;
    M.HEAP32[p + 28 >> 2] = fmt2.dir | 0;
    M.HEAP32[p + 32 >> 2] = fmt2.listLevel | 0;
    return p;
  }
  _free(alloc) {
    for (const s of alloc.strs) this.M._free(s);
    this.M._free(alloc.arr);
  }
  _decode(ptr) {
    if (!ptr) return null;
    const j = this.M.UTF8ToString(ptr);
    this.M._ec_string_free(ptr);
    return JSON.parse(j);
  }
  _sourceGapRuns(id2, runs) {
    const model = this._gapModel?.pageIndex === this.pageIndex && this._gapModel.paragraphs.find((p) => p.id === id2);
    const M = this.M;
    const required = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_GetCharBox", "_FPDFText_ClosePage"];
    if (!model || required.some((f) => typeof M[f] !== "function")) return runs;
    const owned = new Set((this.paragraphObjects(id2) || []).map((h) => h >>> 0));
    if (!owned.size) return runs;
    const tp = M._FPDFText_LoadPage(this.page);
    if (!tp) return runs;
    const ptr = M._malloc(32), chars = [];
    try {
      const n = M._FPDFText_CountChars(tp);
      for (let i = 0; i < n; i++) {
        const u = M._FPDFText_GetUnicode(tp, i), obj = M._FPDFText_GetTextObject(tp, i) >>> 0;
        const ok = M._FPDFText_GetCharBox(tp, i, ptr, ptr + 8, ptr + 16, ptr + 24);
        chars.push({ index: i, ch: String.fromCharCode(u), obj, generated: typeof M._FPDFText_IsGenerated === "function" && M._FPDFText_IsGenerated(tp, i) === 1, box: ok ? [0, 8, 16, 24].map((k) => M.HEAPF64[ptr + k >> 3]) : null });
      }
      const restored = restoreSourceWordGaps(model.runs, runs, chars, owned);
      return removeForeignObjectGapSpaces(model.runs, restored, chars, owned);
    } finally {
      M._free(ptr);
      M._FPDFText_ClosePage(tp);
    }
  }
  previewParagraph(id2, runs, fmt2) {
    const a = this._writeRuns(this._sourceGapRuns(id2, runs));
    const f = this._writeFmt(fmt2);
    const ptr = this.M._ec_preview_paragraph(
      this.session,
      this.page,
      id2,
      a.arr,
      a.count,
      f
    );
    this._free(a);
    this.M._free(f);
    if (!ptr) return null;
    const json = this.M.UTF8ToString(ptr);
    this.M._ec_string_free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  commitParagraph(id2, runs, fmt2) {
    this._pageDirty = true;
    const a = this._writeRuns(this._sourceGapRuns(id2, runs));
    const f = this._writeFmt(fmt2);
    const out = this._decode(
      this.M._ec_commit_paragraph(
        this.session,
        this.page,
        id2,
        a.arr,
        a.count,
        f
      )
    );
    this._free(a);
    this.M._free(f);
    return out;
  }
  renderParagraphLive(id2, runs, fmt2, scale, mx, my, mw, mh) {
    const M = this.M;
    const a = this._writeRuns(runs);
    const f = this._writeFmt(fmt2);
    const wp = M._malloc(8);
    M.HEAP32[wp >> 2] = 0;
    M.HEAP32[wp + 4 >> 2] = 0;
    const ptr = M._ec_render_paragraph_live(
      this.session,
      this.page,
      id2,
      a.arr,
      a.count,
      f,
      scale,
      mx,
      my,
      mw,
      mh,
      wp,
      wp + 4
    );
    const w = M.HEAP32[wp >> 2], h = M.HEAP32[wp + 4 >> 2];
    M._free(wp);
    this._free(a);
    M._free(f);
    if (!ptr || !w || !h) return null;
    const data = new Uint8ClampedArray(M.HEAPU8.subarray(ptr, ptr + w * h * 4));
    M._ec_string_free(ptr);
    return { width: w, height: h, data };
  }
  renderPageRegion(fullW, fullH, px, py, pw, ph) {
    const M = this.M;
    const FPDFBitmap_BGRA = 4;
    const bmp = M._FPDFBitmap_CreateEx(pw, ph, FPDFBitmap_BGRA, 0, 0);
    if (!bmp) return null;
    M._FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 4294967295);
    const FPDF_ANNOT = 1, FPDF_LCD_TEXT = 2, FPDF_REVERSE_BYTE_ORDER = 16;
    const FLAGS = FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_REVERSE_BYTE_ORDER;
    M._FPDF_RenderPageBitmap(bmp, this.page, -px, -py, fullW, fullH, 0, FLAGS);
    M._ec_form_draw(
      this.session,
      this.page,
      bmp,
      -px,
      -py,
      fullW,
      fullH,
      0,
      FLAGS
    );
    const buf = M._FPDFBitmap_GetBuffer(bmp);
    const stride = M._FPDFBitmap_GetStride(bmp);
    const out = new Uint8ClampedArray(pw * ph * 4);
    if (stride === pw * 4) {
      out.set(M.HEAPU8.subarray(buf, buf + pw * ph * 4));
    } else {
      for (let y = 0; y < ph; y++) {
        out.set(
          M.HEAPU8.subarray(buf + y * stride, buf + y * stride + pw * 4),
          y * pw * 4
        );
      }
    }
    M._FPDFBitmap_Destroy(bmp);
    return { width: pw, height: ph, data: out };
  }
  addParagraph(x, yTop, width, runs, fmt2) {
    this._pageDirty = true;
    const a = this._writeRuns(runs);
    const f = this._writeFmt(fmt2);
    const out = this._decode(
      this.M._ec_add_paragraph(
        this.session,
        this.page,
        x,
        yTop,
        width,
        a.arr,
        a.count,
        f
      )
    );
    this._free(a);
    this.M._free(f);
    return out;
  }
  synthRunFont(paraId, runIndex) {
    const M = this.M;
    const sp = M._malloc(4);
    M.HEAPU32[sp >> 2] = 0;
    const ptr = M._ec_synth_run_font(
      this.session,
      this.page,
      paraId,
      runIndex,
      sp
    );
    const size3 = M.HEAPU32[sp >> 2];
    M._free(sp);
    if (!ptr || !size3) return null;
    if (size3 === 1) {
      const flag = M.HEAPU8[ptr];
      M._ec_string_free(ptr);
      return flag === 221 ? "dishonest" : null;
    }
    const bytes2 = M.HEAPU8.slice(ptr, ptr + size3);
    M._ec_string_free(ptr);
    return bytes2;
  }
  duplicateParagraph(id2, dx, dy) {
    this._pageDirty = true;
    return this._decode(
      this.M._ec_duplicate_paragraph(this.session, this.page, id2, dx, dy)
    );
  }
  cloneMarker(srcId, dstId) {
    this._pageDirty = true;
    return this.M._ec_clone_marker(this.session, this.page, srcId, dstId) !== 0;
  }
  moveParagraph(id2, dx, dy) {
    this._pageDirty = true;
    return this.M._ec_move_paragraph(this.session, this.page, id2, dx, dy) !== 0;
  }
  resizeParagraph(id2, width) {
    this._pageDirty = true;
    return this._decode(
      this.M._ec_resize_paragraph(this.session, this.page, id2, width)
    );
  }
  historyBeginStep(label) {
    const M = this.M;
    const lbl = this._allocStr(label || "edit");
    M._ec_history_begin(this.session, this.page, lbl);
    M._free(lbl);
  }
  historyEndStep() {
    const before = this.M._ec_history_depth(this.session, 0);
    this.M._ec_history_end(this.session, this.page);
    if (this._spliceOk === false) return;
    if (this.M._ec_history_depth(this.session, 0) <= before) return;
    const plan = this.lastSplicePlan();
    if (plan) (this._splicePlans ||= []).push({ page: this.pageIndex, plan });
    else this._spliceOk = false;
  }
  lastSplicePlan() {
    const ptr = this.M._ec_last_splice_plan(this.session, this.page);
    if (!ptr) return null;
    const json = this.M.UTF8ToString(ptr);
    this.M._ec_string_free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  editStep(label, fn) {
    this.historyBeginStep(label);
    try {
      return fn();
    } finally {
      this.historyEndStep();
    }
  }
  historyNoteMatrix(handle) {
    this.M._ec_history_note_matrix(this.session, this.page, handle);
  }
  historyNoteZOrder(handle) {
    this.M._ec_history_note_zorder(this.session, this.page, handle);
  }
  historyNoteInsert(handle) {
    this.M._ec_history_note_insert(this.session, this.page, handle);
  }
  historyRemoveObject(handle) {
    this._pageDirty = true;
    return this.M._ec_history_remove_object(this.session, this.page, handle) !== 0;
  }
  historyUndo() {
    this._pageDirty = true;
    const ok = this.M._ec_history_undo(this.session, this.page) !== 0;
    if (ok && this._splicePlans?.length) {
      const last = this._splicePlans[this._splicePlans.length - 1];
      if (last.page === this.pageIndex) this._splicePlans.pop();
      else this._spliceOk = false;
    }
    return ok;
  }
  historyRedo() {
    this._pageDirty = true;
    const ok = this.M._ec_history_redo(this.session, this.page) !== 0;
    if (ok && this._spliceOk !== false) {
      const plan = this.lastSplicePlan();
      if (plan) (this._splicePlans ||= []).push({ page: this.pageIndex, plan });
      else this._spliceOk = false;
    }
    return ok;
  }
  historyDepth() {
    return {
      undo: this.M._ec_history_depth(this.session, 0),
      redo: this.M._ec_history_depth(this.session, 1)
    };
  }
  historyClear() {
    this.M._ec_history_clear(this.session);
  }
  spellLoad(bytes2) {
    const M = this.M;
    const buf = M._malloc(bytes2.length);
    M.HEAPU8.set(bytes2, buf);
    const n = M._ec_spell_load(this.session, buf, bytes2.length);
    M._free(buf);
    return n;
  }
  spellCheckPage() {
    const M = this.M;
    const ptr = M._ec_spell_check_page(this.session, this.page);
    if (!ptr) return null;
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  selectText(x0, y0, x1, y1, mode) {
    const M = this.M;
    const ptr = M._ec_select_text(
      this.session,
      this.page,
      x0,
      y0,
      x1,
      y1,
      mode | 0
    );
    if (!ptr) return null;
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  pageTextJson() {
    const M = this.M;
    const ptr = M._ec_page_text_json(this.session, this.page);
    if (!ptr) return null;
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  buildModelInRegion(x, y, w, h) {
    const M = this.M;
    const ptr = M._ec_build_page_model_region(
      this.session,
      this.page,
      x,
      y,
      w,
      h
    );
    if (!ptr) return [];
    const json = M.UTF8ToString(ptr);
    M._ec_string_free(ptr);
    try {
      return JSON.parse(json).paragraphs || [];
    } catch {
      return [];
    }
  }
  deleteParagraph(id2) {
    this._pageDirty = true;
    return this.M._ec_delete_paragraph(this.session, this.page, id2) !== 0;
  }
  runFontData(paraId, runIndex) {
    const M = this.M;
    const needed = M._ec_get_run_font_data(
      this.session,
      this.page,
      paraId,
      runIndex,
      0,
      0
    );
    if (!needed) return null;
    const buf = M._malloc(needed);
    const written = M._ec_get_run_font_data(
      this.session,
      this.page,
      paraId,
      runIndex,
      buf,
      needed
    );
    const out = written > 0 ? M.HEAPU8.slice(buf, buf + Math.min(needed, written || needed)) : null;
    M._free(buf);
    return out && out.length ? out : null;
  }
  paragraphObjects(id2) {
    const M = this.M;
    const total = M._ec_get_paragraph_objects(
      this.session,
      this.page,
      id2,
      0,
      0
    );
    if (total <= 0) return [];
    const out = M._malloc(total * 4);
    M._ec_get_paragraph_objects(this.session, this.page, id2, out, total);
    const handles = [];
    for (let i = 0; i < total; i++) handles.push(M.HEAPU32[(out >> 2) + i]);
    M._free(out);
    return handles;
  }
  objectCount() {
    return this.M._FPDFPage_CountObjects(this.page);
  }
  objectAt(index) {
    const M = this.M;
    const h = M._FPDFPage_GetObject(this.page, index);
    if (!h) return null;
    return { handle: h, index, type: M._FPDFPageObj_GetType(h) };
  }
  objectBounds(handle) {
    const b = this._rawBounds(handle);
    if (!b) return null;
    const p0 = this.toModel(b.x, b.y);
    const p1 = this.toModel(b.x + b.w, b.y + b.h);
    return {
      ...b,
      x: Math.min(p0.x, p1.x),
      y: Math.min(p0.y, p1.y),
      w: Math.abs(p1.x - p0.x),
      h: Math.abs(p1.y - p0.y)
    };
  }
  _rawBounds(handle) {
    const M = this.M;
    const p = this._boundsScratch ||= M._malloc(16);
    const ok = M._FPDFPageObj_GetBounds(handle, p, p + 4, p + 8, p + 12);
    if (!ok) return null;
    const l = M.HEAPF32[p >> 2], b = M.HEAPF32[p + 4 >> 2];
    const r = M.HEAPF32[p + 8 >> 2], t = M.HEAPF32[p + 12 >> 2];
    return { x: l, y: b, w: r - l, h: t - b };
  }
  deltaToUser(dx, dy) {
    const t = this.pageT || [1, 0, 0, 1, 0, 0];
    const det = t[0] * t[3] - t[1] * t[2] || 1;
    return {
      x: (t[3] * dx - t[2] * dy) / det,
      y: (-t[1] * dx + t[0] * dy) / det
    };
  }
  translateObject(handle, dx, dy) {
    this._pageDirty = true;
    ({ x: dx, y: dy } = this.deltaToUser(dx, dy));
    const M = this.M;
    const m = M._malloc(24);
    M.HEAPF32[m + 0 >> 2] = 1;
    M.HEAPF32[m + 4 >> 2] = 0;
    M.HEAPF32[m + 8 >> 2] = 0;
    M.HEAPF32[m + 12 >> 2] = 1;
    M.HEAPF32[m + 16 >> 2] = dx;
    M.HEAPF32[m + 20 >> 2] = dy;
    M._FPDFPageObj_TransformClipPath(handle, 1, 0, 0, 1, dx, dy);
    M._FPDFPageObj_TransformF(handle, m);
    M._free(m);
  }
  transformObjectAboutCenter(handle, a, b, c, d) {
    this._pageDirty = true;
    const M = this.M;
    const bounds = this._rawBounds(handle);
    if (!bounds) return;
    const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
    const e = cx - a * cx - c * cy;
    const f = cy - b * cx - d * cy;
    const m = M._malloc(24);
    M.HEAPF32[m + 0 >> 2] = a;
    M.HEAPF32[m + 4 >> 2] = b;
    M.HEAPF32[m + 8 >> 2] = c;
    M.HEAPF32[m + 12 >> 2] = d;
    M.HEAPF32[m + 16 >> 2] = e;
    M.HEAPF32[m + 20 >> 2] = f;
    M._FPDFPageObj_TransformClipPath(handle, a, b, c, d, e, f);
    M._FPDFPageObj_TransformF(handle, m);
    M._free(m);
  }
  rotateObject(handle, deg) {
    this._pageDirty = true;
    const r = deg * Math.PI / 180;
    this.transformObjectAboutCenter(
      handle,
      Math.cos(r),
      Math.sin(r),
      -Math.sin(r),
      Math.cos(r)
    );
  }
  rotateObjectsAbout(handles, deg, cx, cy) {
    ({ x: cx, y: cy } = this.toUser(cx, cy));
    this._pageDirty = true;
    const M = this.M;
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const m = M._malloc(24);
    M.HEAPF32[m + 0 >> 2] = c;
    M.HEAPF32[m + 4 >> 2] = s;
    M.HEAPF32[m + 8 >> 2] = -s;
    M.HEAPF32[m + 12 >> 2] = c;
    M.HEAPF32[m + 16 >> 2] = cx - c * cx + s * cy;
    M.HEAPF32[m + 20 >> 2] = cy - s * cx - c * cy;
    for (const h of handles) {
      M._FPDFPageObj_TransformClipPath(
        h,
        c,
        s,
        -s,
        c,
        cx - c * cx + s * cy,
        cy - s * cx - c * cy
      );
      M._FPDFPageObj_TransformF(h, m);
    }
    M._free(m);
  }
  flipObject(handle, horizontal) {
    this._pageDirty = true;
    this.transformObjectAboutCenter(
      handle,
      horizontal ? -1 : 1,
      0,
      0,
      horizontal ? 1 : -1
    );
  }
  replaceImage(handle, bgra, width, height) {
    this._pageDirty = true;
    const M = this.M;
    const buf = M._malloc(bgra.length);
    M.HEAPU8.set(bgra, buf);
    const bmp = M._FPDFBitmap_CreateEx(width, height, 4, buf, width * 4);
    let ok = false;
    if (bmp) {
      const pages = M._malloc(4);
      M.HEAP32[pages >> 2] = this.page;
      ok = !!M._FPDFImageObj_SetBitmap(pages, 1, handle, bmp);
      M._free(pages);
      M._FPDFBitmap_Destroy(bmp);
    }
    M._free(buf);
    return ok;
  }
  renderImageObject(handle) {
    const M = this.M;
    const bmp = M._FPDFImageObj_GetRenderedBitmap(this.doc, this.page, handle);
    if (!bmp) return null;
    const w = M._FPDFBitmap_GetWidth(bmp), h = M._FPDFBitmap_GetHeight(bmp);
    const stride = M._FPDFBitmap_GetStride(bmp);
    const buf = M._FPDFBitmap_GetBuffer(bmp);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = buf + y * stride + x * 4, di = (y * w + x) * 4;
        out[di] = M.HEAPU8[si + 2];
        out[di + 1] = M.HEAPU8[si + 1];
        out[di + 2] = M.HEAPU8[si];
        out[di + 3] = M.HEAPU8[si + 3];
      }
    }
    M._FPDFBitmap_Destroy(bmp);
    return { data: out, width: w, height: h };
  }
  untaggedMarks() {
    const M = this.M;
    const tree = M._FPDF_StructTree_GetForPage(this.page);
    if (!tree) return [];
    const registered = /* @__PURE__ */ new Set();
    const walk = (el) => {
      const id2 = M._FPDF_StructElement_GetMarkedContentID(el);
      if (id2 >= 0) registered.add(id2);
      const n2 = M._FPDF_StructElement_CountChildren(el);
      for (let i = 0; i < n2; i++) {
        const ch = M._FPDF_StructElement_GetChildAtIndex(el, i);
        if (ch) walk(ch);
      }
    };
    const n = M._FPDF_StructTree_CountChildren(tree);
    for (let i = 0; i < n; i++)
      walk(M._FPDF_StructTree_GetChildAtIndex(tree, i));
    M._FPDF_StructTree_Close(tree);
    const out = /* @__PURE__ */ new Map();
    const key3 = M._malloc(8);
    M.stringToUTF8("MCID", key3, 8);
    const val = M._malloc(4);
    for (let i = 0; i < this.objectCount(); i++) {
      const o = this.objectAt(i);
      if (!o) continue;
      const nm = M._FPDFPageObj_CountMarks(o.handle);
      for (let k = 0; k < nm; k++) {
        const mk = M._FPDFPageObj_GetMark(o.handle, k);
        if (!mk) continue;
        const nb = M._malloc(32), need = M._malloc(4);
        let name = "";
        if (M._FPDFPageObjMark_GetName(mk, nb, 32, need)) {
          const len = M.HEAPU32[need >> 2];
          for (let q = 0; q + 2 <= len; q += 2) {
            const c = M.HEAPU8[nb + q] | M.HEAPU8[nb + q + 1] << 8;
            if (c) name += String.fromCharCode(c);
          }
        }
        M._free(nb);
        M._free(need);
        if (name !== "P" && name !== "Figure") continue;
        if (!M._FPDFPageObjMark_GetParamIntValue(mk, key3, val)) continue;
        const mcid = M.HEAP32[val >> 2];
        if (mcid >= 0 && !registered.has(mcid))
          out.set(mcid, { mcid, type: name });
      }
    }
    M._free(key3);
    M._free(val);
    return [...out.values()].sort((a, b) => a.mcid - b.mcid);
  }
  objectMcid(handle) {
    const M = this.M;
    const key3 = M._malloc(8);
    M.stringToUTF8("MCID", key3, 8);
    const val = M._malloc(4);
    let mcid = -1;
    const nm = M._FPDFPageObj_CountMarks(handle);
    for (let k = 0; k < nm && mcid < 0; k++) {
      const mk = M._FPDFPageObj_GetMark(handle, k);
      if (mk && M._FPDFPageObjMark_GetParamIntValue(mk, key3, val)) {
        mcid = M.HEAP32[val >> 2];
      }
    }
    M._free(key3);
    M._free(val);
    return mcid;
  }
  tagObject(handle, name) {
    this._pageDirty = true;
    const M = this.M;
    let maxM = -1;
    for (let i = 0; i < this.objectCount(); i++) {
      const o = this.objectAt(i);
      if (o) maxM = Math.max(maxM, this.objectMcid(o.handle));
    }
    const nbuf = M._malloc(name.length + 1);
    M.stringToUTF8(name, nbuf, name.length + 1);
    const mk = M._FPDFPageObj_AddMark(handle, nbuf);
    let ok = false;
    if (mk) {
      const key3 = M._malloc(8);
      M.stringToUTF8("MCID", key3, 8);
      ok = !!M._FPDFPageObjMark_SetIntParam(
        this.doc,
        handle,
        mk,
        key3,
        maxM + 1
      );
      M._free(key3);
    }
    M._free(nbuf);
    return ok;
  }
  pageIsTagged() {
    const M = this.M;
    const tree = M._FPDF_StructTree_GetForPage(this.page);
    if (!tree) return false;
    const n = M._FPDF_StructTree_CountChildren(tree);
    M._FPDF_StructTree_Close(tree);
    return n > 0;
  }
  structAltFor(mcid) {
    const M = this.M;
    const tree = M._FPDF_StructTree_GetForPage(this.page);
    if (!tree) return null;
    let found = null;
    const walk = (el) => {
      if (found !== null) return;
      if (M._FPDF_StructElement_GetMarkedContentID(el) === mcid) {
        const need = M._FPDF_StructElement_GetAltText(el, 0, 0);
        let txt = "";
        if (need > 2) {
          const buf = M._malloc(need);
          M._FPDF_StructElement_GetAltText(el, buf, need);
          for (let q = 0; q + 2 <= need - 2; q += 2) {
            const c = M.HEAPU8[buf + q] | M.HEAPU8[buf + q + 1] << 8;
            if (c) txt += String.fromCharCode(c);
          }
          M._free(buf);
        }
        found = txt;
        return;
      }
      const n2 = M._FPDF_StructElement_CountChildren(el);
      for (let i = 0; i < n2; i++) {
        const ch = M._FPDF_StructElement_GetChildAtIndex(el, i);
        if (ch) walk(ch);
      }
    };
    const n = M._FPDF_StructTree_CountChildren(tree);
    for (let i = 0; i < n; i++)
      walk(M._FPDF_StructTree_GetChildAtIndex(tree, i));
    M._FPDF_StructTree_Close(tree);
    return found;
  }
  collectShadings() {
    const out = [];
    let firstOther = -1;
    for (let i = 0; i < this.objectCount(); i++) {
      const o = this.objectAt(i);
      if (!o) continue;
      if (o.type === 4) out.push({ index: i });
      else if (firstOther < 0) firstOther = i;
    }
    return out.map((s2) => ({
      ...s2,
      isBackground: firstOther < 0 || s2.index < firstOther
    }));
  }
  pathStyle(handle) {
    const M = this.M;
    const p = M._malloc(24);
    const st = { stroke: false, strokeRgba: 0, strokeWidth: 1, fill: false };
    if (M._FPDFPath_GetDrawMode(handle, p, p + 4)) {
      st.fill = M.HEAP32[p >> 2] !== 0;
      st.stroke = M.HEAP32[p + 4 >> 2] !== 0;
    }
    if (M._FPDFPageObj_GetStrokeColor(handle, p, p + 4, p + 8, p + 12)) {
      st.strokeRgba = ((M.HEAPU32[p >> 2] & 255) << 24 | (M.HEAPU32[p + 4 >> 2] & 255) << 16 | (M.HEAPU32[p + 8 >> 2] & 255) << 8 | M.HEAPU32[p + 12 >> 2] & 255) >>> 0;
    }
    if (M._FPDFPageObj_GetStrokeWidth(handle, p)) {
      st.strokeWidth = M.HEAPF32[p >> 2];
    }
    M._free(p);
    return st;
  }
  setPathStroke(handle, rgba, width) {
    this._pageDirty = true;
    const M = this.M;
    const p = M._malloc(8);
    let fill = 0;
    if (M._FPDFPath_GetDrawMode(handle, p, p + 4)) fill = M.HEAP32[p >> 2];
    M._free(p);
    M._FPDFPageObj_SetStrokeColor(
      handle,
      rgba >>> 24 & 255,
      rgba >>> 16 & 255,
      rgba >>> 8 & 255,
      rgba & 255
    );
    M._FPDFPageObj_SetStrokeWidth(handle, width > 0 ? width : 1);
    M._FPDFPath_SetDrawMode(handle, fill, 1);
  }
  removeObject(handle) {
    this._pageDirty = true;
    if (this.M._FPDFPage_RemoveObject(this.page, handle)) {
      this.M._FPDFPageObj_Destroy(handle);
      return true;
    }
    return false;
  }
  scaleObject(handle, sx, sy, anchorX2, anchorY) {
    ({ x: anchorX2, y: anchorY } = this.toUser(anchorX2, anchorY));
    if (this.pageT && Math.abs(this.pageT[0]) < 0.5) {
      const t2 = sx;
      sx = sy;
      sy = t2;
    }
    this._pageDirty = true;
    const M = this.M;
    const m = M._malloc(24);
    M.HEAPF32[m + 0 >> 2] = sx;
    M.HEAPF32[m + 4 >> 2] = 0;
    M.HEAPF32[m + 8 >> 2] = 0;
    M.HEAPF32[m + 12 >> 2] = sy;
    M.HEAPF32[m + 16 >> 2] = anchorX2 - sx * anchorX2;
    M.HEAPF32[m + 20 >> 2] = anchorY - sy * anchorY;
    M._FPDFPageObj_TransformClipPath(
      handle,
      sx,
      0,
      0,
      sy,
      anchorX2 - sx * anchorX2,
      anchorY - sy * anchorY
    );
    M._FPDFPageObj_TransformF(handle, m);
    M._free(m);
  }
  currentIndexOf(handle) {
    for (let i = 0; i < this.objectCount(); i++)
      if (this.M._FPDFPage_GetObject(this.page, i) === handle) return i;
    return -1;
  }
  arrangeObject(handle, op) {
    this._pageDirty = true;
    const M = this.M;
    const idx = this.currentIndexOf(handle);
    if (idx < 0) return false;
    const last = this.objectCount() - 1;
    const target = op === "front" ? last : op === "back" ? 0 : op === "forward" ? Math.min(last, idx + 1) : Math.max(0, idx - 1);
    if (target === idx) return false;
    if (!M._FPDFPage_RemoveObject(this.page, handle)) return false;
    if (!M._FPDFPage_InsertObjectAtIndex(this.page, handle, target))
      M._FPDFPage_InsertObject(this.page, handle);
    return true;
  }
  insertImage(rgba, pxW, pxH, x, y, w, h) {
    this._pageDirty = true;
    const M = this.M;
    const handle = M._FPDFPageObj_NewImageObj(this.doc);
    if (!handle) return 0;
    const FPDFBitmap_BGRA = 4;
    const bmp = M._FPDFBitmap_Create(pxW, pxH, 1);
    const buf = M._FPDFBitmap_GetBuffer(bmp);
    const stride = M._FPDFBitmap_GetStride(bmp);
    for (let row = 0; row < pxH; row++) {
      let src = row * pxW * 4, dst = buf + row * stride;
      for (let col2 = 0; col2 < pxW; col2++) {
        M.HEAPU8[dst] = rgba[src + 2];
        M.HEAPU8[dst + 1] = rgba[src + 1];
        M.HEAPU8[dst + 2] = rgba[src];
        M.HEAPU8[dst + 3] = rgba[src + 3];
        src += 4;
        dst += 4;
      }
    }
    const pagesPtr = M._malloc(4);
    M.HEAPU32[pagesPtr >> 2] = this.page;
    M._FPDFImageObj_SetBitmap(pagesPtr, 1, handle, bmp);
    M._free(pagesPtr);
    M._FPDFBitmap_Destroy(bmp);
    const m = M._malloc(24);
    M.HEAPF32[m + 0 >> 2] = w;
    M.HEAPF32[m + 4 >> 2] = 0;
    M.HEAPF32[m + 8 >> 2] = 0;
    M.HEAPF32[m + 12 >> 2] = h;
    const at = this.toUser(x, y);
    M.HEAPF32[m + 16 >> 2] = at.x;
    M.HEAPF32[m + 20 >> 2] = at.y;
    M._FPDFPageObj_SetMatrix(handle, m);
    M._free(m);
    M._FPDFPage_InsertObject(this.page, handle);
    return handle;
  }
  duplicateImage(handle, dx, dy) {
    this._pageDirty = true;
    const M = this.M;
    const b = this.objectBounds(handle);
    if (!b) return 0;
    const sz = M._malloc(8);
    let iw = 0, ih = 0;
    if (M._FPDFImageObj_GetImagePixelSize(handle, sz, sz + 4)) {
      iw = M.HEAPU32[sz >> 2];
      ih = M.HEAPU32[sz + 4 >> 2];
    }
    M._free(sz);
    const mp = M._malloc(24);
    let saved = null;
    if (M._FPDFPageObj_GetMatrix(handle, mp)) {
      saved = [0, 1, 2, 3, 4, 5].map((i) => M.HEAPF32[(mp >> 2) + i]);
    }
    const upright = saved && saved[1] === 0 && saved[2] === 0 && saved[0] > 0 && saved[3] > 0;
    let boosted = false;
    if (upright && iw > 0 && ih > 0 && (iw > saved[0] || ih > saved[3])) {
      const s = Math.min(1, 4096 / Math.max(iw, ih));
      M.HEAPF32.set([iw * s, 0, 0, ih * s, saved[4], saved[5]], mp >> 2);
      M._FPDFPageObj_SetMatrix(handle, mp);
      boosted = true;
    }
    const bmp = M._FPDFImageObj_GetRenderedBitmap(this.doc, this.page, handle);
    if (boosted) {
      M.HEAPF32.set(saved, mp >> 2);
      M._FPDFPageObj_SetMatrix(handle, mp);
    }
    M._free(mp);
    if (!bmp) return 0;
    const w = M._FPDFBitmap_GetWidth(bmp), h = M._FPDFBitmap_GetHeight(bmp);
    const stride = M._FPDFBitmap_GetStride(bmp), buf = M._FPDFBitmap_GetBuffer(bmp);
    const rgba = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      let src = buf + row * stride, dst = row * w * 4;
      for (let col2 = 0; col2 < w; col2++) {
        rgba[dst] = M.HEAPU8[src + 2];
        rgba[dst + 1] = M.HEAPU8[src + 1];
        rgba[dst + 2] = M.HEAPU8[src];
        rgba[dst + 3] = M.HEAPU8[src + 3];
        src += 4;
        dst += 4;
      }
    }
    M._FPDFBitmap_Destroy(bmp);
    return this.insertImage(rgba, w, h, b.x + dx, b.y + dy, b.w, b.h);
  }
  objectFill(handle) {
    const M = this.M;
    const p = M._malloc(16);
    const ok = M._FPDFPageObj_GetFillColor(handle, p, p + 4, p + 8, p + 12);
    const r = M.HEAPU32[p >> 2], g = M.HEAPU32[p + 4 >> 2];
    const b = M.HEAPU32[p + 8 >> 2], a = M.HEAPU32[p + 12 >> 2];
    M._free(p);
    return ok ? { r, g, b, a } : null;
  }
  setObjectFill(handle, r, g, b, a) {
    this._pageDirty = true;
    this.M._FPDFPageObj_SetFillColor(handle, r, g, b, a);
  }
  renderPage(scale, hideHandles = null) {
    const M = this.M;
    const s = Math.min(
      scale,
      4096 / Math.max(1, this.pageWidth),
      4096 / Math.max(1, this.pageHeight)
    );
    scale = Math.max(0.05, s);
    const w = Math.max(1, Math.round(this.pageWidth * scale));
    const h = Math.max(1, Math.round(this.pageHeight * scale));
    let saved = null, mp = 0;
    if (hideHandles && hideHandles.length) {
      mp = M._malloc(24);
      saved = [];
      for (const handle of hideHandles) {
        if (!M._FPDFPageObj_GetMatrix(handle, mp)) continue;
        saved.push([handle, M.HEAPF32.slice(mp >> 2, (mp >> 2) + 6)]);
        M.HEAPF32[mp + 0 >> 2] = 1e-6;
        M.HEAPF32[mp + 4 >> 2] = 0;
        M.HEAPF32[mp + 8 >> 2] = 0;
        M.HEAPF32[mp + 12 >> 2] = 1e-6;
        M.HEAPF32[mp + 16 >> 2] = -1e6;
        M.HEAPF32[mp + 20 >> 2] = -1e6;
        M._FPDFPageObj_SetMatrix(handle, mp);
      }
    }
    const FPDFBitmap_BGRA = 4;
    const bmp = M._FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, 0, 0);
    M._FPDFBitmap_FillRect(bmp, 0, 0, w, h, 4294967295);
    const FPDF_ANNOT = 1, FPDF_LCD_TEXT = 2, FPDF_REVERSE_BYTE_ORDER = 16;
    const FLAGS = FPDF_ANNOT | FPDF_LCD_TEXT | FPDF_REVERSE_BYTE_ORDER;
    M._FPDF_RenderPageBitmap(bmp, this.page, 0, 0, w, h, 0, FLAGS);
    M._ec_form_draw(this.session, this.page, bmp, 0, 0, w, h, 0, FLAGS);
    if (saved) {
      for (const [handle, m] of saved) {
        M.HEAPF32.set(m, mp >> 2);
        M._FPDFPageObj_SetMatrix(handle, mp);
      }
      M._free(mp);
    }
    const buf = M._FPDFBitmap_GetBuffer(bmp);
    const stride = M._FPDFBitmap_GetStride(bmp);
    const need = w * h * 4;
    if (this._renderScratch?.length !== need)
      this._renderScratch = new Uint8ClampedArray(need);
    const out = this._renderScratch;
    if (stride === w * 4) {
      out.set(M.HEAPU8.subarray(buf, buf + w * h * 4));
    } else {
      for (let y = 0; y < h; y++) {
        out.set(
          M.HEAPU8.subarray(buf + y * stride, buf + y * stride + w * 4),
          y * w * 4
        );
      }
    }
    M._FPDFBitmap_Destroy(bmp);
    return { width: w, height: h, data: out };
  }
  generateContent() {
    if (!this._pageDirty) return true;
    if (this._t3seg && this._t3seg[this.pageIndex]) {
      const st = this._t3readState();
      if (st) {
        this._t3anchor(st);
        (this._t3state ||= {})[this.pageIndex] = st.filter(
          (o) => o.t3 && !o.inForm && o.glyphs && o.glyphs.length
        );
      }
    }
    if (this.session) this.M._ec_dealias_page_fonts(this.session, this.page);
    this.M._ec_normalize_page_paint(this.page);
    const ok = this.M._FPDFPage_GenerateContent(this.page) !== 0;
    if (ok) this._spliceOk = false;
    if (ok && this._usesPattern) this._pageStale = true;
    if (ok) {
      this._pageDirty = false;
      (this._editedPages ||= /* @__PURE__ */ new Set()).add(this.pageIndex);
    }
    return ok;
  }
  async saveSpliced(opts) {
    if (this._spliceOk === false || !this._splicePlans?.length || !this._originalBytes || this._reencoded?.size || this._normalizedBytes || this._encrypted)
      return this.save(opts);
    try {
      const { applyPlan: applyPlan2 } = await Promise.resolve().then(() => (init_streamsplice(), streamsplice_exports));
      const writeCount = this._splicePlans.filter(
        (e) => e.plan?.kind === "write"
      ).length;
      if (writeCount > 1) return this.save(opts);
      let bytes2 = this._originalBytes;
      for (const { page, plan } of this._splicePlans) {
        const next = await applyPlan2(bytes2, page, plan);
        if (!next) return this.save(opts);
        bytes2 = next;
      }
      return bytes2;
    } catch {
      return this.save(opts);
    }
  }
  renderParagraphLiveEnd() {
    if (this.M._ec_render_paragraph_live_end && this.session && this.page) {
      this.M._ec_render_paragraph_live_end(this.session, this.page);
    }
  }
  save(opts) {
    this.renderParagraphLiveEnd();
    if (this._pageDirty && !opts?.noRegen) this.generateContent();
    const M = this.M;
    const sizePtr = M._malloc(4);
    const hasT3 = this._t3seg && Object.keys(this._t3seg).length > 0;
    const incremental = !this._encrypted && (opts && opts.incremental || hasT3);
    const outPtr = M._ec_save_document(this.doc, incremental ? 1 : 2, sizePtr);
    const size3 = M.HEAPU32[sizePtr >> 2];
    M._free(sizePtr);
    if (!outPtr || !size3) return null;
    let bytes2 = M.HEAPU8.slice(outPtr, outPtr + size3);
    M._ec_string_free(outPtr);
    if (hasT3 && this._t3state) {
      try {
        const jobs = Object.entries(this._t3state).map(([pi, state]) => ({
          pageIndex: Number(pi),
          seg: this._t3seg[pi],
          state,
          anchors: this._t3anchors?.[pi] || {}
        }));
        const fixed = applyType3LeftoverSurgery(bytes2, jobs);
        if (fixed) {
          bytes2 = fixed.bytes;
          for (const [pi, tjEntries] of Object.entries(fixed.injected)) {
            this._t3seg[pi]?.tjs?.push(...tjEntries);
          }
        }
      } catch (e) {
        console.warn("type3 surgery skipped:", e);
      }
    }
    return bytes2;
  }
};
var OBJECT_MUTATORS = [
  "open",
  "reopen",
  "loadPage",
  "buildModel",
  "generateContent",
  "normalizeFontsForEdit",
  "addParagraph",
  "commitParagraph",
  "deleteParagraph",
  "moveParagraph",
  "resizeParagraph",
  "duplicateParagraph",
  "synthRunFont",
  "translateObject",
  "transformObjectAboutCenter",
  "rotateObject",
  "rotateObjectsAbout",
  "flipObject",
  "scaleObject",
  "arrangeObject",
  "removeObject",
  "replaceImage",
  "insertImage",
  "duplicateImage",
  "setPathStroke",
  "setObjectFill",
  "tagObject",
  "historyUndo",
  "historyRedo"
];
for (const name of OBJECT_MUTATORS) {
  const original = PdfEngine.prototype[name];
  if (typeof original !== "function") continue;
  PdfEngine.prototype[name] = function wrapped(...args) {
    this._objEpoch = (this._objEpoch || 0) + 1;
    return original.apply(this, args);
  };
}

// src/paragraph-pdf-runtime.mjs
init_paragraph_pdf_crypto();

// src/paragraph-vendor/overlay.json
var overlay_default = {
  schema: "falsify.paragraph-editor.overlay.v1",
  base: "cd4ba2cdd68ae7e51198f615bd4ac6130206b162",
  commit: "483a9abbd72ed2a7f853b5c0aaf2f2beaad16c5c",
  branch: "feature/fitr-native-wire-20261027",
  repository: "https://github.com/Shinick-Han/falsify-pdf-editor",
  patch: "patches/paragraph-flow-overlay.patch",
  patchSha256: "b0eb108bae54d22a0a44e33e92e5736de2621788d40c8d7ce6b5aace4cc2864e"
};

// src/paragraph-pdf-runtime.mjs
var RUNTIME = Object.freeze({
  engine: "BentoPDF/PDFium",
  license: "AGPL-3.0-only",
  bentopdfCommit: "3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97",
  engineCommit: "813903c93c758dfb8df46dbd34ace3b7f7a8538b",
  moduleCommit: "cd4ba2cdd68ae7e51198f615bd4ac6130206b162",
  moduleOverlayCommit: overlay_default.commit,
  jsSha256: "cbef240d8893fd9624c08eadbb1ffb405a583c96878d6a14d11d8e9816c0832b",
  wasmSha256: "7674fe4cce4a8e15d702b02988610891693ac68f6121b4621e237949736778cb",
  sourceBuildVerified: false,
  trust: "locally-supplied-hash-verified-artifacts"
});
var runtime;
async function loadRuntime() {
  if (!runtime) runtime = initialize().catch((error2) => {
    runtime = null;
    throw error2;
  });
  return runtime;
}
async function initialize() {
  const asset = (name) => {
    const url = new URL("./paragraph-vendor/" + name, import.meta.url);
    url.searchParams.set("sha256", name.endsWith(".wasm") ? RUNTIME.wasmSha256 : RUNTIME.jsSha256);
    return url;
  };
  const fetchBytes = async (name) => {
    const response = await fetch(asset(name), { credentials: "same-origin" });
    if (!response.ok) throw new Error("Paragraph runtime resource unavailable: " + name);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [js, wasm] = await Promise.all([fetchBytes("editcore.js"), fetchBytes("editcore.wasm")]);
  if (hex(js) !== RUNTIME.jsSha256 || hex(wasm) !== RUNTIME.wasmSha256) {
    throw Object.assign(new Error("Paragraph runtime digest mismatch"), { code: "runtime-hash-mismatch" });
  }
  const { default: createModule } = await import(
    /* @vite-ignore */
    asset("editcore.js").href
  );
  const engineFactory = async (bytes2, fontSnapshot = null) => {
    const M = await createModule({ wasmBinary: wasm, print() {
    }, printErr() {
    } });
    const cfg = M._malloc(48);
    M.HEAPU8.fill(0, cfg, cfg + 48);
    M.HEAPU32[cfg >> 2] = 2;
    M._FPDF_InitLibraryWithConfig(cfg);
    M._free(cfg);
    const engine = new PdfEngine(M, fontSnapshot);
    try {
      if (bytes2) engine.open(new Uint8Array(bytes2));
    } catch (error2) {
      engine.close();
      throw error2;
    }
    return engine;
  };
  return { engineFactory, info: RUNTIME };
}

// src/paragraph-vendor/editor.mjs
init_pagination();

// src/paragraph-vendor/document-flow.mjs
init_paragraph_pdf_crypto();
init_quality();
init_pagination();
init_document_flow_band();
init_document_flow_links();
init_document_flow_underlines();
init_continuation_template();
var fail6 = (code) => {
  throw Object.assign(new Error(code), { code });
};
var list2 = (M, p) => Array.from({ length: M._FPDFPage_CountObjects(p) }, (_, i) => M._FPDFPage_GetObject(p, i) >>> 0);
var median3 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] || 14;
function planDocumentLines(lines2, bands, maxNewPages = 32) {
  if (!lines2.length || !bands.length) fail6("document_flow_empty");
  const pages = bands.map((b) => ({ ...b, lines: [] }));
  let at = 0, previous = null;
  for (let i = 0; i < lines2.length; i++) {
    const line = lines2[i];
    let p = pages[at];
    let top = previous ? previous.top - line.gap : p.bodyTop;
    if (top - (line.top - line.bottom) < p.floor - 0.01) {
      at++;
      previous = null;
      if (!pages[at]) {
        if (at - bands.length >= maxNewPages) fail6("pagination_budget_exceeded");
        pages.push({ ...bands.at(-1), lines: [], generated: true });
      }
      p = pages[at];
      top = p.bodyTop;
    }
    if (top - (line.top - line.bottom) < p.floor - 0.01) fail6("pagination_line_exceeds_body");
    p.lines.push({ index: i, dy: top - line.top });
    previous = { top };
  }
  return pages;
}
function readPart(e, pageIndex, band, origin) {
  e.loadPage(pageIndex);
  checkDocumentFlowPageBudget(e);
  const M = e.M;
  const handles = list2(M, e.page).filter((h) => {
    const b = e.objectBounds(h);
    if (!b) return false;
    const cy = b.y + b.h / 2;
    return cy >= band.floor - 0.5 && cy <= band.bodyTop + 0.5;
  });
  const paths = handles.filter((h) => M._FPDFPageObj_GetType(h) !== 1).map((h) => snapshotTinyUnderline(e, h));
  const snap = snapshotTextObjects(e, handles.filter((h) => M._FPDFPageObj_GetType(h) === 1));
  if (!snap.ok) fail6(snap.code);
  const items = snap.items.map((it) => ({ top: it.bounds.t, bottom: it.bounds.b, order: it.index, it }));
  const grouped = groupLines(items);
  if (grouped.loose.length) fail6("document_flow_loose_text_unsupported");
  for (const line of grouped.lines) line.items.sort((a, b) => a.order - b.order);
  for (const line of grouped.lines) {
    const row = [...line.items].sort((a, b) => a.it.bounds.l - b.it.bounds.l);
    const em = (it) => it.style.size * Math.max(Math.hypot(it.style.matrix[0], it.style.matrix[1]), Math.hypot(it.style.matrix[2], it.style.matrix[3]));
    for (let i = 1; i < row.length; i++) if (row[i].it.bounds.l - row[i - 1].it.bounds.r > 2 * Math.max(em(row[i].it), em(row[i - 1].it))) fail6("document_flow_table_or_columns_unsupported");
  }
  return { pageIndex, handle: e.page, handles, paths, items: snap.items, lines: grouped.lines.map((l) => ({ ...l, origin, part: pageIndex })), band };
}
async function compactDocumentFlow(engineFactory, sourceBytes, intermediatePdf, edits, preliminaryMap, maxNewPages = 32, policy = "strict", annotationAdapter = null) {
  const starts = preliminaryMap.filter((m) => !m.flowColumn && m.continuationPageIndices.length && m.sourcePageIndex < preliminaryMap.length - 1);
  if (!starts.length) return { pdf: intermediatePdf, sourcePageMap: preliminaryMap, flowGroups: [], addedPages: preliminaryMap.reduce((n, m) => n + m.continuationPageIndices.length, 0) };
  if (preliminaryMap.length > 64) fail6("document_flow_page_budget_exceeded");
  if (annotationAdapter && !["inspect", "transport", "validate"].every((k) => typeof annotationAdapter[k] === "function")) fail6("document_flow_annotation_adapter_invalid");
  const annotationModel = annotationAdapter ? await annotationAdapter.inspect({ sourceBytes, sourceSha256: createHash("sha256").update(sourceBytes).digest("hex") }) : null;
  if (annotationAdapter && (!annotationModel || !Array.isArray(annotationModel.annotations))) fail6("document_flow_annotation_inventory_mismatch");
  const src = await engineFactory(sourceBytes), e = await engineFactory(intermediatePdf);
  const M = e.M, held = /* @__PURE__ */ new Set(), deleted = /* @__PURE__ */ new Set(), groups = [], warnings = [], unowned = /* @__PURE__ */ new Set();
  for (const a of annotationModel?.annotations || []) if (a.preservedMissingDestination === true) warnings.push({ code: "source_broken_link_preserved", severity: "warning", pageIndex: a.sourcePageIndex, annotationIndex: a.annotationIndex });
  e.pinnedPages = new Set(Array.from({ length: e.pageCount }, (_, i) => i));
  try {
    let plans = [];
    for (let start = 0; start < preliminaryMap.length; start++) {
      if (preliminaryMap[start].flowColumn || !preliminaryMap[start].continuationPageIndices.length || start === preliminaryMap.length - 1) continue;
      const bands = [], parts = [], lines2 = [];
      let end = start, planned;
      try {
        for (; end < preliminaryMap.length; end++) {
          const included = bands.map((b) => b.sourcePageIndex);
          const targetBoundary = annotationModel?.annotations.some((a) => included.includes(a.sourcePageIndex) && (a.internalDestinationSourcePageIndices || [a.destination?.targetSourcePageIndex].filter(Number.isInteger)).includes(end));
          if (end > start && targetBoundary && !nativeFitRTargetPages(annotationModel, [end]).has(end)) {
            if (bands.length < 2) fail6("document_flow_link_target_in_changed_body");
            warnings.push({ code: "document_flow_internal_target_boundary", severity: "info", pageIndex: start, boundarySourcePageIndex: end });
            end--;
            break;
          }
          const band = deriveDocumentFlowBand(src, end, capturePageLayout, annotationModel);
          if (bands.length && (Math.abs(band.width - bands[0].width) > 0.01 || Math.abs(band.height - bands[0].height) > 0.01 || Math.abs(band.x0 - bands[0].x0) > 2)) fail6("document_flow_incompatible_pages");
          bands.push(band);
          const map2 = preliminaryMap[end];
          for (const index of [map2.outputPageIndex, ...map2.continuationPageIndices]) {
            const part = readPart(e, index, band, end);
            parts.push(part);
            held.add(part.handle);
            const pitches = part.lines.slice(1).map((l, i) => part.lines[i].top - l.top).filter((x) => x > 0 && x < 30);
            const pitch = median3(pitches);
            for (let j = 0; j < part.lines.length; j++) lines2.push({ ...part.lines[j], gap: j ? part.lines[j - 1].top - part.lines[j].top : pitch });
            if (lines2.length > 1e4) fail6("document_flow_line_budget_exceeded");
          }
          planned = planDocumentLines(lines2, bands, maxNewPages);
          if (end > start && planned.length === bands.length) break;
        }
        end = Math.min(end, preliminaryMap.length - 1);
        for (const part of parts) if (!part.items.length) fail6("document_flow_empty_body_unsupported");
        const plan = { start, end, bands, parts, lines: lines2, pages: planned };
        const authorized = nativeFitRTargetPages(annotationModel, bands.map((b) => b.sourcePageIndex));
        plan.destinationMoves = deriveNativeFitRMoves(src, bands, plannedLinkGlyphs(plan), edits, annotationModel, expectedPageText);
        plan.linkMoves = deriveNativeLinkMoves(src, bands, plannedLinkGlyphs(plan), edits, annotationModel, expectedPageText, authorized);
        const stagedGlyphs = parts.flatMap((part) => part.lines.flatMap((line) => line.items.flatMap(({ it }) => it.chars.filter((c) => c.u > 32).map((c) => ({ u: c.u, outputPageIndex: part.pageIndex, box: { l: c.l, r: c.r, b: c.b, t: c.t } })))));
        deriveNativeFitRMoves(src, bands, stagedGlyphs, edits, annotationModel, expectedPageText);
        const stagedMoves = deriveNativeLinkMoves(src, bands, stagedGlyphs, edits, annotationModel, expectedPageText, authorized);
        plan.underlines = matchStagedUnderlines(bands, parts, stagedMoves);
        plans.push(plan);
        start = end;
      } catch (error2) {
        if (policy !== "compatible-groups") throw error2;
        warnings.push({ code: "document_flow_barrier_not_compacted", severity: "warning", pageIndex: start, reason: error2?.code || "document_flow_failed" });
      }
    }
    const allSourcePages = plans.flatMap((p) => p.bands.map((b) => b.sourcePageIndex));
    plans = plans.filter((p) => {
      const own = p.bands.map((b) => b.sourcePageIndex);
      const unresolved = annotationModel?.annotations.some((a) => a.destinationUnresolved === true && a.preservedMissingDestination !== true);
      const actionOwnershipUnsupported = annotationModel?.actionOwnershipUnsupported === true;
      const blocked = annotationModel?.annotations.some((a) => {
        const targets = a.internalDestinationSourcePageIndices || [a.destination?.targetSourcePageIndex].filter(Number.isInteger);
        const authorized = nativeFitRTargetPages(annotationModel, own);
        return targets.some((i) => own.includes(i) && !authorized.has(i)) || own.includes(a.sourcePageIndex) && targets.some((i) => allSourcePages.includes(i) && !own.includes(i));
      });
      const reason = actionOwnershipUnsupported ? "document_flow_link_action_ownership_unsupported" : unresolved ? "document_flow_link_unresolved_target" : "document_flow_link_target_in_changed_body";
      if (unresolved || actionOwnershipUnsupported) {
        if (policy !== "compatible-groups") fail6(reason);
        warnings.push({ code: "document_flow_barrier_not_compacted", severity: "warning", pageIndex: p.start, reason });
        return false;
      }
      if (!blocked) return true;
      if (policy !== "compatible-groups") fail6(reason);
      warnings.push({ code: "document_flow_barrier_not_compacted", severity: "warning", pageIndex: p.start, reason });
      return false;
    });
    if (!plans.length) return { pdf: intermediatePdf, sourcePageMap: preliminaryMap, flowGroups: [], addedPages: preliminaryMap.reduce((n, m) => n + m.continuationPageIndices.length, 0), warnings };
    for (const p of plans) {
      const last = p.parts.find((x) => x.pageIndex === preliminaryMap[p.end].outputPageIndex);
      e.loadPage(last.pageIndex);
      p.edges = snapshotPageEdges(e, last.band.floor, last.band.bodyTop, new Set(last.handles));
      if (!p.edges.ok) fail6(p.edges.code);
      p.clones = p.pages.map((page) => page.lines.flatMap(({ index, dy }) => p.lines[index].items.map(({ it }) => {
        const h = cloneTextObject(e, it);
        if (!h) fail6("document_flow_clone_failed");
        unowned.add(h);
        M._FPDFPageObj_Transform(h, 1, 0, 0, 1, 0, dy);
        return { h, it, dy, origin: p.lines[index].origin };
      })));
      p.pathClones = p.pages.map(() => []);
      for (const { source: source2 } of p.underlines) {
        const move = p.linkMoves.find((m) => m.sourcePageIndex === source2.sourcePageIndex && m.annotationIndex === source2.annotationIndex);
        if (!move) fail6("document_flow_underline_link_move_missing");
        const h = cloneUnderline(e, source2, move.dx, move.dy);
        unowned.add(h);
        p.pathClones[move.outputPageIndex].push({ h, source: source2, move });
      }
    }
    for (const p of plans) {
      for (const part of p.parts) for (const h of part.handles) {
        if (!M._FPDFPage_RemoveObject(part.handle, h)) fail6("document_flow_remove_failed");
        unowned.add(h);
      }
      const destinations = p.bands.map((b) => p.parts.find((x) => x.pageIndex === preliminaryMap[b.sourcePageIndex].outputPageIndex));
      let insertion = preliminaryMap[p.end].outputPageIndex + 1 + preliminaryMap[p.end].continuationPageIndices.length;
      const priorInsertions = plans.filter((q) => q.start < p.start).reduce((n, q) => n + Math.max(0, q.pages.length - q.bands.length), 0);
      insertion += priorInsertions;
      for (let k = p.bands.length; k < p.pages.length; k++) {
        const h = M._FPDFPage_New(e.doc, insertion++, p.edges.pageW, p.edges.pageH);
        if (!h) fail6("document_flow_new_page_failed");
        held.add(h);
        const edges = applyPageEdges(e, h, p.edges, k - p.bands.length + 1, Infinity);
        if (!edges.ok) fail6(edges.code);
        if (!M._FPDFPage_GenerateContent(h)) fail6("document_flow_generate_failed");
        if (!verifyPageEdges(e, h, p.edges, k - p.bands.length + 1, edges).ok) fail6("document_flow_edge_clone_mismatch");
        destinations.push({ handle: h, band: p.bands.at(-1), generated: true });
      }
      for (let k = 0; k < destinations.length; k++) {
        const d = destinations[k], remain = list2(M, d.handle);
        let at = remain.findIndex((h) => {
          const b = e.objectBounds(h);
          return b && b.y + b.h / 2 < d.band.floor;
        });
        if (at < 0) at = remain.length;
        const ordered = [...p.pathClones[k].filter((c) => c.source.paint === "before"), ...p.clones[k], ...p.pathClones[k].filter((c) => c.source.paint === "after")];
        for (const c of ordered) {
          if (!M._FPDFPage_InsertObjectAtIndex(d.handle, c.h, at++)) fail6("document_flow_insert_failed");
          unowned.delete(c.h);
        }
        if (!M._FPDFPage_GenerateContent(d.handle)) fail6("document_flow_generate_failed");
        for (const c of p.clones[k]) if (!verifyTextObject(e, d.handle, c.it, c.h, c.dy)) fail6("document_flow_clone_mismatch");
        for (const c of p.pathClones[k]) if (!underlineEqual(snapshotTinyUnderline(e, c.h), c.source, c.move.dx, c.move.dy)) fail6("document_flow_underline_clone_mismatch");
      }
      for (const part of p.parts) {
        if (preliminaryMap.some((m) => m.continuationPageIndices.includes(part.pageIndex))) deleted.add(part.pageIndex);
      }
      p.destinations = destinations;
      for (const part of p.parts) for (const h of part.handles) {
        M._FPDFPageObj_Destroy(h);
        unowned.delete(h);
      }
    }
    for (const h of e._pageCache?.values() || []) held.add(h);
    if (e.page) held.add(e.page);
    for (const h of held) {
      M._ec_history_drop_page?.(e.session, h);
      M._FPDF_ClosePage(h);
    }
    held.clear();
    e._pageCache?.clear();
    e.page = 0;
    e._pageDirty = false;
    const insertions = plans.map((p) => ({ after: p.end, count: Math.max(0, p.pages.length - p.bands.length) }));
    const physicalShift = (old) => insertions.filter((x) => preliminaryMap[x.after].outputPageIndex + 1 + preliminaryMap[x.after].continuationPageIndices.length <= old).reduce((n, x) => n + x.count, 0);
    for (const i of [...deleted].sort((a, b) => b - a)) M._FPDFPage_Delete(e.doc, i + physicalShift(i));
    const map = preliminaryMap.map((m) => ({ ...m, continuationPageIndices: [...m.continuationPageIndices] }));
    let out = 0;
    for (let s = 0; s < map.length; s++) {
      const p = plans.find((p2) => s >= p2.start && s <= p2.end);
      const n = p ? s === p.end ? Math.max(0, p.pages.length - p.bands.length) : 0 : map[s].continuationPageIndices.length;
      map[s].outputPageIndex = out;
      map[s].continuationPageIndices = Array.from({ length: n }, (_, k) => out + k + 1);
      if (p) {
        for (const key3 of ["lineCounts", "keptLines", "bodyTop", "flowTop", "floor", "flowColumn", "continuationStyle"]) delete map[s][key3];
        if (n) Object.assign(map[s], { bodyTop: p.bands.at(-1).bodyTop, flowTop: p.bands.at(-1).bodyTop, floor: p.bands.at(-1).floor, lineCounts: p.pages.slice(p.bands.length).map((q) => q.lines.length), continuationStyle: { version: 1, policy: "source-number-suffix", applied: true } });
      }
      out += 1 + n;
    }
    const annotationMoves = [], destinationMoves = [];
    for (const p of plans) {
      const indices = [...p.bands.map((b) => map[b.sourcePageIndex].outputPageIndex), ...map[p.end].continuationPageIndices];
      annotationMoves.push(...p.linkMoves.map((move) => ({ ...move, outputPageIndex: indices[move.outputPageIndex] })));
      destinationMoves.push(...p.destinationMoves.map((move) => ({ ...move, outputPageIndex: indices[move.outputPageIndex] })));
      const contentMap = p.bands.map((b) => ({ sourcePageIndex: b.sourcePageIndex, outputPageIndices: indices.filter((_, i) => p.clones[i].some((c) => c.origin === b.sourcePageIndex)) }));
      for (const c of contentMap) map[c.sourcePageIndex].contentOutputPageIndices = [...c.outputPageIndices];
      groups.push({ version: 1, sourcePages: p.bands.map(({ sourcePageIndex, bodyTop, flowTop, floor, x0, x1 }) => ({ sourcePageIndex, bodyTop, flowTop, floor, x0, x1 })), outputPages: indices.map((outputPageIndex, i) => ({ outputPageIndex, ...Object.fromEntries(["bodyTop", "flowTop", "floor"].map((k) => [k, p.pages[i][k]])), x0: Math.min(...p.bands.map((b) => b.x0)), x1: Math.max(...p.bands.map((b) => b.x1)), lineCount: p.pages[i].lines.length })), contentMap });
    }
    e.pageCount = M._FPDF_GetPageCount(e.doc);
    let pdf = new Uint8Array(e.save());
    if (!pdf.length) fail6("document_flow_save_failed");
    if (annotationAdapter && annotationModel.annotations.length) {
      const transported = await annotationAdapter.transport({ model: annotationModel, sourceBytes, outputBytes: pdf, sourcePageMap: map, moves: annotationMoves, destinationMoves, reflowedSourcePages: plans.flatMap((p) => p.bands.map((b) => b.sourcePageIndex)) });
      pdf = new Uint8Array(transported?.pdf ?? transported);
      if (!pdf.length) fail6("document_flow_annotation_transport_failed");
    }
    return { pdf, sourcePageMap: map, flowGroups: groups, annotationMoves, addedPages: e.pageCount - map.length, warnings };
  } finally {
    for (const h of unowned) try {
      M._FPDFPageObj_Destroy(h);
    } catch {
    }
    const cached = new Set(e._pageCache?.values() || []);
    if (e.page) cached.add(e.page);
    for (const h of held) if (!cached.has(h)) try {
      M._ec_history_drop_page?.(e.session, h);
      M._FPDF_ClosePage(h);
    } catch {
    }
    try {
      src.close();
    } catch {
    }
    try {
      e.close();
    } catch {
    }
  }
}

// src/paragraph-column-isolation.mjs
function isolateColumns(engine, paragraphs, edits, plan) {
  const M = engine.M;
  const api = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_ClosePage", "_FPDFPage_RemoveObject", "_FPDFPage_InsertObjectAtIndex", "_FPDFPageObj_GetType"];
  if (plan.failures.length || api.some((k) => typeof M?.[k] !== "function") || ["objectCount", "objectAt", "objectBounds", "paragraphObjects"].some((k) => typeof engine[k] !== "function")) return null;
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
  const selected = /* @__PURE__ */ new Set();
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
  const foreign = /* @__PURE__ */ new Set();
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
  if (foreign.size) for (let i = 0; i < engine.objectCount(); i++) {
    const o = engine.objectAt(i);
    if (M._FPDFPageObj_GetType(o.handle) !== 1) continue;
    const b = engine.objectBounds(o.handle);
    if (b && (side === "right" ? b.x + b.w <= gap + 0.01 : b.x >= gapRight - 0.01)) foreign.add(o.handle >>> 0);
  }
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
    try {
      restore();
    } catch (restoreError) {
      restore.disposeDetached();
      throw restoreError;
    }
    throw e;
  }
  return restore;
}

// src/paragraph-inline-markers.mjs
init_quality();
var text = (gs) => gs.map((g) => String.fromCodePoint(g.u)).join("");
var key = (gs) => text(gs).normalize("NFKC").replace(/\s/gu, "").toLowerCase();
var originY = (g) => g.origin?.[1];
var size2 = (g) => g.style.size * Math.hypot(g.style.mat?.[2] ?? 0, g.style.mat?.[3] ?? 1);
var styleKey = (g) => JSON.stringify(g.style);
var near4 = (a, b, t = 0.15) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= t;
function lines(glyphs2) {
  const out = [];
  for (const g of glyphs2.filter((g2) => g2.obj && g2.style && Number.isFinite(originY(g2))).sort((a, b) => originY(b) - originY(a) || a.l - b.l)) {
    let line = out.find((l) => near4(l.y, originY(g), 0.5) && near4(l.size, size2(g), 0.2));
    if (!line) out.push(line = { y: originY(g), size: size2(g), glyphs: [] });
    line.glyphs.push(g);
  }
  for (const line of out) line.glyphs.sort((a, b) => a.l - b.l);
  return out;
}
function clusters(glyphs2) {
  const groups = [];
  for (const line of lines(glyphs2)) {
    let current = [];
    for (const g of line.glyphs) {
      const prev = current.at(-1);
      if (prev && g.l - prev.r > Math.max(2, size2(g) * 0.6)) {
        groups.push(current);
        current = [];
      }
      current.push(g);
    }
    if (current.length) groups.push(current);
  }
  return groups;
}
function stream(page, bodySize, column) {
  const chars = [];
  for (const line of lines(page.glyphs).filter((l) => near4(l.size, bodySize, 0.2))) {
    for (const g of line.glyphs.filter((g2) => g2.l < page.W / 2 === column)) {
      for (const c of key([g])) chars.push({ c, g });
    }
  }
  return chars;
}
function hits(chars, needle) {
  const hay = chars.map((x) => x.c).join(""), found = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) found.push(chars[i + needle.length - 1].g);
  return found;
}
function planInlineMarkers(source2, output, pageIndex = 0) {
  const warnings = [], repairs = [], sl = lines(source2.glyphs);
  const sourceClusters = clusters(source2.glyphs), outputClusters = clusters(output.glyphs);
  for (const marker of sourceClusters) {
    if (!marker.length || marker.length > 12) continue;
    const m = marker[0], left = marker[0].l;
    const candidates = [];
    for (const line2 of sl) {
      if (line2.size < size2(m) * 1.2 || line2.size > size2(m) * 3 || line2.y >= originY(m) || originY(m) - line2.y > line2.size * 0.8) continue;
      const preceding = line2.glyphs.filter((g) => g.r <= left + 1 && left - g.r <= line2.size * 1.3);
      if (!preceding.length) continue;
      const parent2 = preceding.at(-1), gap = left - parent2.r;
      if (gap < -1 || gap > line2.size * 1.3) continue;
      const column2 = parent2.l < source2.W / 2, chars2 = stream(source2, line2.size, column2);
      const end = chars2.findLastIndex((c) => c.g === parent2);
      if (end < 0) continue;
      const anchor2 = chars2.slice(Math.max(0, end - 39), end + 1).map((c) => c.c).join("");
      if (anchor2.length < 12) continue;
      candidates.push({ line: line2, parent: parent2, anchor: anchor2, column: column2, chars: chars2 });
    }
    if (candidates.length !== 1) continue;
    const { line, parent, anchor, column, chars } = candidates[0];
    const sourceHits = hits(chars, anchor), targetHits = hits(stream(output, line.size, column), anchor);
    const same = (gs) => text(gs) === text(marker) && gs.length === marker.length && gs.every((g, i) => styleKey(g) === styleKey(marker[i]));
    const sourceMarkers = sourceClusters.filter(same), targetMarkers = outputClusters.filter(same);
    if (sourceHits.length !== 1 || sourceHits[0] !== parent || targetHits.length !== 1 || sourceMarkers.length !== 1 || targetMarkers.length !== 1) {
      warnings.push({ pageIndex, code: "inline_marker_ambiguous", sourceIndex: m.i, text: text(marker) });
      continue;
    }
    const target = targetHits[0], outMarker = targetMarkers[0], selected = new Set(outMarker);
    const handles = [...new Set(outMarker.map((g) => g.obj))];
    if (handles.some((h) => output.glyphs.some((g) => g.obj === h && !selected.has(g)))) {
      warnings.push({ pageIndex, code: "inline_marker_object_ambiguous", sourceIndex: m.i, text: text(marker) });
      continue;
    }
    const dx = target.r + (left - parent.r) - outMarker[0].l;
    const dy = originY(target) + (originY(m) - line.y) - originY(outMarker[0]);
    if (Math.hypot(dx, dy) >= 1) for (const object of handles) repairs.push({ pageIndex, sourceIndex: m.i, object, dx, dy });
    const next = (page, group) => page.glyphs.filter((g) => g.i > Math.max(...group.map((x) => x.i)) && !/\s/u.test(String.fromCodePoint(g.u))).sort((a, b) => a.i - b.i)[0];
    const punctuation = next(source2, marker);
    if (punctuation && /^[.,;:!?]$/u.test(text([punctuation])) && near4(size2(punctuation), line.size, 0.2) && near4(originY(punctuation), line.y, 0.5) && punctuation.l >= marker.at(-1).r - 0.2 && punctuation.l - marker.at(-1).r <= line.size * 0.5) {
      const match = next(output, outMarker);
      if (!match || text([match]) !== text([punctuation]) || styleKey(match) !== styleKey(punctuation) || !match.obj || output.glyphs.some((g) => g.obj === match.obj && g !== match)) {
        warnings.push({ pageIndex, code: "inline_marker_punctuation_ambiguous", sourceIndex: punctuation.i });
      } else {
        const px = target.r + (punctuation.l - parent.r) - match.l;
        const py = originY(target) + (originY(punctuation) - line.y) - originY(match);
        if (Math.hypot(px, py) >= 1) repairs.push({ pageIndex, sourceIndex: punctuation.i, object: match.obj, dx: px, dy: py });
      }
    }
  }
  return { repairs, warnings };
}
async function repairInlineMarkers({ engineFactory, sourceBytes, outputBytes, pageIndices, sourcePageMap }) {
  let src, out;
  const repairs = [], warnings = [];
  try {
    src = await engineFactory(sourceBytes);
    out = await engineFactory(outputBytes);
    for (const pageIndex of pageIndices) {
      const mapping2 = sourcePageMap?.find((m) => m.sourcePageIndex === pageIndex);
      if (sourcePageMap && (!mapping2 || mapping2.continuationPageIndices?.length)) {
        warnings.push({ pageIndex, code: "inline_marker_continuation_unverified" });
        continue;
      }
      const outputPageIndex = mapping2?.outputPageIndex ?? pageIndex;
      const s = readGlyphs(src, pageIndex), o = readGlyphs(out, outputPageIndex);
      if (!s.styled || !o.styled) {
        warnings.push({ pageIndex, code: "inline_marker_style_unavailable" });
        continue;
      }
      const plan = planInlineMarkers(s, o, pageIndex);
      warnings.push(...plan.warnings);
      const seen = /* @__PURE__ */ new Set(), counts = /* @__PURE__ */ new Map();
      for (const move of plan.repairs) counts.set(move.object, (counts.get(move.object) || 0) + 1);
      const conflicts = new Set(plan.repairs.filter((move) => counts.get(move.object) !== 1).map((move) => move.sourceIndex));
      for (const sourceIndex of conflicts) warnings.push({ pageIndex, code: "inline_marker_object_ambiguous", sourceIndex });
      for (const move of plan.repairs) {
        if (conflicts.has(move.sourceIndex)) continue;
        seen.add(move.object);
        out.M._FPDFPageObj_Transform(move.object, 1, 0, 0, 1, move.dx, move.dy);
        repairs.push({ pageIndex, sourceIndex: move.sourceIndex, dx: move.dx, dy: move.dy });
      }
      if (seen.size) {
        if (!out.M._FPDFPage_GenerateContent(out.page)) throw new Error("inline_marker_generate_failed");
        if (out.M._FPDFPage_GetAnnotCount?.(out.page) > 0) warnings.push({ pageIndex, code: "inline_marker_annotations_unverified" });
      }
    }
    return { pdf: repairs.length ? new Uint8Array(out.save()) : new Uint8Array(outputBytes), repairs, warnings };
  } finally {
    try {
      src?.close();
    } finally {
      out?.close();
    }
  }
}

// src/paragraph-link-transport.mjs
init_paragraph_pdf_crypto();
init_document_flow_links();
init_quality();
init_paragraph_geometry_conservation();

// src/document-flow-annotations.mjs
var ANNOTATION_LIMITS = Object.freeze({
  sourceBytes: 25 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  pages: 200,
  annotations: 2e3,
  depth: 20,
  objects: 2e5,
  streamBytes: 4 * 1024 * 1024,
  stringBytes: 4 * 1024 * 1024
});
var AnnotationTransportError = class extends Error {
  constructor(code) {
    super(code);
    this.name = "AnnotationTransportError";
    this.code = code;
  }
};
var fail7 = (code) => {
  throw new AnnotationTransportError(code);
};
var privateModels = /* @__PURE__ */ new WeakMap();
var hex2 = (bytes2) => [...bytes2].map((n) => n.toString(16).padStart(2, "0")).join("");
var digest3 = async (bytes2) => hex2(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes2)));
var frozen2 = (value) => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) frozen2(v);
    Object.freeze(value);
  }
  return value;
};
var numbers = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-3);
var contains2 = (a, b) => a[0] - 1e-3 <= b[0] && a[1] - 1e-3 <= b[1] && a[2] + 1e-3 >= b[2] && a[3] + 1e-3 >= b[3];
var key2 = (p, i) => p + ":" + i;
var identity = (o) => o.isIndirect() ? "r" + o.asIndirect() : "d" + o.pointer;
function bytes(value, limit) {
  if (!(value instanceof Uint8Array) || value.length < 5 || value.length > limit) fail7("annotation-byte-limit");
  return value.slice();
}
function context(mupdf, source2) {
  if (!mupdf?.PDFDocument) fail7("annotation-engine-unavailable");
  let doc;
  try {
    doc = new mupdf.PDFDocument(source2);
    if (doc.needsPassword() || doc.countPages() < 1 || doc.countPages() > ANNOTATION_LIMITS.pages) fail7("annotation-document-unsupported");
  } catch (error2) {
    doc?.destroy();
    if (error2?.code) throw error2;
    fail7("annotation-document-invalid");
  }
  const arena = [];
  const keep = (o) => {
    if (!o.isNull()) arena.push(o);
    return o;
  };
  return { doc, keep, get: (o, ...p) => keep(o.get(...p)), close() {
    for (const o of arena.reverse()) o.destroy();
    doc.destroy();
  } };
}
function numericArray(c, obj, multiple, minimum = multiple) {
  if (!obj.isArray() || obj.length < minimum || obj.length % multiple) fail7("annotation-geometry-invalid");
  const out = [];
  if (obj.length > ANNOTATION_LIMITS.objects) fail7("annotation-object-limit");
  for (let i = 0; i < obj.length; i++) {
    const n = c.get(obj, i);
    if (!n.isNumber() || !Number.isFinite(n.asNumber()) || Math.abs(n.asNumber()) > 1e5) fail7("annotation-geometry-invalid");
    out.push(n.asNumber());
  }
  return out;
}
function rectangle(c, obj) {
  const r = numericArray(c, obj, 4);
  if (r.length !== 4 || r[0] >= r[2] || r[1] >= r[3]) fail7("annotation-geometry-invalid");
  return r;
}
function annotationRectangle(c, obj) {
  const r = numericArray(c, obj, 4);
  if (r.length !== 4 || r[0] === r[2] || r[1] === r[3]) fail7("annotation-geometry-invalid");
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}
function geometry(c, page) {
  const media = rectangle(c, c.keep(page.getInheritable("MediaBox"))), crop = c.keep(page.getInheritable("CropBox")), rotate = c.keep(page.getInheritable("Rotate")), unit = c.get(page, "UserUnit");
  if (!rotate.isNull() && (!rotate.isNumber() || rotate.asNumber() % 360 !== 0) || media[0] !== 0 || media[1] !== 0 || !crop.isNull() && !numbers(media, rectangle(c, crop)) || !unit.isNull() && unit.asNumber() !== 1) fail7("annotation-page-geometry-unsupported");
  return media;
}
function pageRefs(c, map) {
  const refs = /* @__PURE__ */ new Map(), pages = [];
  for (let i = 0; i < c.doc.countPages(); i++) {
    const page = c.keep(c.doc.findPage(i));
    if (!page.isIndirect()) fail7("annotation-page-identity-invalid");
    pages.push(page);
    refs.set(page.asIndirect(), map?.get(i) ?? ["new-page", i]);
  }
  return { refs, pages };
}
function entries(c, obj) {
  const list3 = [];
  obj.forEach((value, name) => list3.push([name, c.keep(value)]));
  return list3.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en"));
}
async function fingerprint(c, annotation, refs, full = false, budget = { objects: 0, streams: 0, strings: 0 }, omitGeneratedFlag = false) {
  const seen = /* @__PURE__ */ new Map();
  function canonical(obj, depth, root = false) {
    if (depth > ANNOTATION_LIMITS.depth || ++budget.objects > ANNOTATION_LIMITS.objects) fail7("annotation-object-limit");
    if (obj.isNull()) return ["null"];
    if (obj.isIndirect()) {
      const num = obj.asIndirect();
      if (refs.has(num)) return ["page", ...refs.get(num)];
      if (seen.has(num)) return ["ref", seen.get(num)];
      const index = seen.size;
      seen.set(num, index);
      return ["object", index, canonical(c.keep(obj.resolve()), depth + 1, root)];
    }
    if (obj.isBoolean()) return ["bool", obj.asBoolean()];
    if (obj.isNumber()) {
      const n = obj.asNumber();
      if (!Number.isFinite(n)) fail7("annotation-object-invalid");
      return ["number", n];
    }
    if (obj.isName()) return ["name", obj.asName()];
    if (obj.isString()) {
      const data = obj.asByteString();
      budget.strings += data.length;
      if (budget.strings > ANNOTATION_LIMITS.stringBytes) fail7("annotation-string-limit");
      return ["string", hex2(data)];
    }
    if (obj.isArray()) {
      if (obj.length > ANNOTATION_LIMITS.objects) fail7("annotation-object-limit");
      return ["array", Array.from({ length: obj.length }, (_, i) => canonical(c.get(obj, i), depth + 1))];
    }
    if (obj.isDictionary()) return ["dict", entries(c, obj).filter(([name]) => (!omitGeneratedFlag || !root || name !== "PDFIUM_HasGeneratedAP") && (full || !root || !["Rect", "P", "QuadPoints"].includes(name))).map(([name, value2]) => [name, canonical(value2, depth + 1)])];
    fail7("annotation-object-invalid");
  }
  function streamData2(obj, walkSeen = /* @__PURE__ */ new Set(), depth = 0, root = true) {
    if (depth > ANNOTATION_LIMITS.depth) fail7("annotation-object-limit");
    if (obj.isIndirect()) {
      const num = obj.asIndirect();
      if (refs.has(num) || walkSeen.has(num)) return null;
      walkSeen.add(num);
      if (obj.isStream()) {
        const buffer = obj.readRawStream();
        try {
          const raw = buffer.asUint8Array();
          budget.streams += raw.length;
          if (budget.streams > ANNOTATION_LIMITS.streamBytes) fail7("annotation-stream-limit");
          return ["stream", hex2(raw), streamData2(c.keep(obj.resolve()), walkSeen, depth + 1, root)];
        } finally {
          buffer.destroy();
        }
      }
      return streamData2(c.keep(obj.resolve()), walkSeen, depth + 1, root);
    }
    if (obj.isArray()) return Array.from({ length: obj.length }, (_, i) => streamData2(c.get(obj, i), walkSeen, depth + 1, false));
    if (obj.isDictionary()) return entries(c, obj).filter(([name]) => (!omitGeneratedFlag || !root || name !== "PDFIUM_HasGeneratedAP") && (full || !root || !["Rect", "P", "QuadPoints"].includes(name))).map(([name, value2]) => [name, streamData2(value2, walkSeen, depth + 1, false)]);
    return null;
  }
  const value = JSON.stringify([canonical(annotation, 0, true), streamData2(annotation)]);
  return digest3(new TextEncoder().encode(value));
}
function nameDestinations(c) {
  const catalog = c.get(c.doc.getTrailer(), "Root"), lookup = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
  let count = 0;
  const put = (name, value) => {
    if (++count > ANNOTATION_LIMITS.objects) fail7("annotation-object-limit");
    lookup.set(name, lookup.has(name) ? null : value);
  };
  const legacy = c.get(catalog, "Dests");
  if (!legacy.isNull() && !legacy.isDictionary()) fail7("annotation-destination-invalid");
  if (legacy.isDictionary()) for (const [name, value] of entries(c, legacy)) put(name, value);
  function visit(node, depth) {
    if (node.isNull()) return;
    if (depth > ANNOTATION_LIMITS.depth || !node.isDictionary()) fail7("annotation-destination-invalid");
    const id2 = identity(node);
    if (seen.has(id2)) fail7("annotation-destination-invalid");
    seen.add(id2);
    const names = c.get(node, "Names");
    if (!names.isNull()) {
      if (!names.isArray() || names.length % 2 || names.length > 2 * ANNOTATION_LIMITS.objects) fail7("annotation-destination-invalid");
      for (let i = 0; i < names.length; i += 2) {
        const name = c.get(names, i);
        if (!name.isString()) fail7("annotation-destination-invalid");
        put(name.asString(), c.get(names, i + 1));
      }
    }
    const kids = c.get(node, "Kids");
    if (!kids.isNull()) {
      if (!kids.isArray() || kids.length > ANNOTATION_LIMITS.objects) fail7("annotation-destination-invalid");
      for (let i = 0; i < kids.length; i++) visit(c.get(kids, i), depth + 1);
    }
  }
  const namesRoot = c.get(catalog, "Names");
  if (!namesRoot.isNull() && !namesRoot.isDictionary()) fail7("annotation-destination-invalid");
  if (!namesRoot.isNull()) visit(c.get(namesRoot, "Dests"), 0);
  return lookup;
}
function destinationReader(c, refs, names) {
  let usedValues = [], missingNames = [], destinations = [], destinationObjects = [], unexposedTargets = [];
  const destinationIds = /* @__PURE__ */ new Map();
  function resolve(value, seen = /* @__PURE__ */ new Set(), depth = 0) {
    if (depth > ANNOTATION_LIMITS.depth) fail7("annotation-destination-invalid");
    usedValues.push(value);
    if (value.isName() || value.isString()) {
      const name = value.isName() ? value.asName() : value.asString();
      if (!names.has(name)) {
        missingNames.push(name);
        return null;
      }
      if (seen.has(name) || names.get(name) === null) fail7("annotation-destination-unresolved");
      seen.add(name);
      return resolve(names.get(name), seen, depth + 1);
    }
    if (value.isDictionary()) return resolve(c.get(value, "D"), seen, depth + 1);
    if (!value.isArray() || value.length < 2) fail7("annotation-destination-unresolved");
    const page = c.get(value, 0), mode = c.get(value, 1), length = { XYZ: 5, Fit: 2, FitB: 2, FitH: 3, FitBH: 3, FitV: 3, FitBV: 3, FitR: 6 }[mode.asName()];
    if (!page.isIndirect() || !refs.has(page.asIndirect()) || !length || value.length !== length) fail7("annotation-destination-unresolved");
    for (let i = 2; i < value.length; i++) {
      const n = c.get(value, i);
      if (!n.isNull() && (!n.isNumber() || !Number.isFinite(n.asNumber()))) fail7("annotation-destination-invalid");
    }
    const targetSourcePageIndex = refs.get(page.asIndirect())[1], id2 = identity(value);
    if (!destinationIds.has(id2)) destinationIds.set(id2, destinationIds.size);
    const operands = Array.from({ length: value.length - 2 }, (_, i) => {
      const n = c.get(value, i + 2);
      return n.isNull() ? null : n.asNumber();
    });
    if (operands.every((n) => n === null || Math.abs(n) <= 1e5)) {
      destinations.push({ id: destinationIds.get(id2), kind: mode.asName(), targetSourcePageIndex, operands });
      destinationObjects.push(value);
    } else unexposedTargets.push(targetSourcePageIndex);
    return targetSourcePageIndex;
  }
  function actions(action, targets, visited = /* @__PURE__ */ new Set(), depth = 0) {
    if (depth > ANNOTATION_LIMITS.depth) fail7("annotation-destination-invalid");
    if (action.isArray()) {
      if (action.length > ANNOTATION_LIMITS.objects) fail7("annotation-object-limit");
      for (let i = 0; i < action.length; i++) actions(c.get(action, i), targets, visited, depth + 1);
      return null;
    }
    if (!action.isDictionary()) fail7("annotation-action-target-unsupported");
    const id2 = identity(action);
    if (visited.has(id2)) fail7("annotation-destination-invalid");
    visited.add(id2);
    const type = c.get(action, "S").asName();
    let destination;
    if (type === "URI") {
      if (!c.get(action, "URI").isString()) fail7("annotation-action-target-unsupported");
      destination = { type: "uri" };
    } else if (type === "GoTo") {
      const target = resolve(c.get(action, "D"));
      if (target !== null) targets.push(target);
      destination = target === null ? { type: "internal" } : { type: "internal", targetSourcePageIndex: target };
    } else fail7("annotation-action-target-unsupported");
    const next = c.get(action, "Next");
    if (!next.isNull()) actions(next, targets, visited, depth + 1);
    return destination;
  }
  return (annotation) => {
    usedValues = [];
    missingNames = [];
    destinations = [];
    destinationObjects = [];
    unexposedTargets = [];
    const targets = [], dest = c.get(annotation, "Dest"), action = c.get(annotation, "A");
    let destination;
    if (!dest.isNull() && !action.isNull()) fail7("annotation-destination-ambiguous");
    if (!dest.isNull()) {
      const target = resolve(dest);
      if (target !== null) targets.push(target);
      destination = target === null ? { type: "internal" } : { type: "internal", targetSourcePageIndex: target };
    } else if (!action.isNull()) destination = actions(action, targets);
    else fail7("annotation-destination-unresolved");
    return { destination, targets: [...new Set(targets)], destinations, destinationObjects, unexposedTargets, values: usedValues, missingNames: [...new Set(missingNames)] };
  };
}
function unsupportedDocumentActions(c, pages) {
  const catalog = c.get(c.doc.getTrailer(), "Root");
  return !c.get(catalog, "AA").isNull() || !c.get(catalog, "OpenAction").isNull() || pages.some((page) => !c.get(page, "AA").isNull());
}
async function fitOpenAction(c, refs, pages) {
  const catalog = c.get(c.doc.getTrailer(), "Root"), open = c.get(catalog, "OpenAction");
  if (!c.get(catalog, "AA").isNull() || pages.some((page2) => !c.get(page2, "AA").isNull())) return null;
  if (open.isNull()) return { present: false };
  if (!open.isArray() || open.length !== 2) return null;
  const page = c.get(open, 0), mode = c.get(open, 1);
  if (!page.isIndirect() || !refs.has(page.asIndirect()) || !mode.isName() || !["Fit", "FitB"].includes(mode.asName())) return null;
  return { present: true, hash: await fingerprint(c, open, refs, true) };
}
function annotationArray(c, page) {
  const value = c.get(page, "Annots");
  if (!value.isNull() && !value.isArray()) fail7("annotation-array-invalid");
  return value;
}
async function inventory(c, refs, pages, source2 = false) {
  const records = [], byPage = [], shared = /* @__PURE__ */ new Map(), budget = { objects: 0, streams: 0, strings: 0 };
  let count = 0;
  for (let p = 0; p < pages.length; p++) {
    const array = annotationArray(c, pages[p]), list3 = [];
    byPage.push(list3);
    for (let i = 0; i < array.length; i++) {
      if (++count > ANNOTATION_LIMITS.annotations) fail7("annotation-count-limit");
      const annotation = c.get(array, i);
      if (!annotation.isDictionary()) fail7("annotation-object-invalid");
      const id2 = identity(annotation), record = { sourcePageIndex: p, annotationIndex: i, aliasKey: shared.get(id2)?.aliasKey ?? key2(p, i), object: annotation, fingerprint: await fingerprint(c, annotation, refs, false, budget), fullFingerprint: await fingerprint(c, annotation, refs, true, budget) };
      const generated = c.get(annotation, "PDFIUM_HasGeneratedAP"), ap = c.get(annotation, "AP");
      record.generatedMarker = generated.isNull() ? "absent" : generated.isBoolean() && generated.asBoolean() ? "true" : "other";
      if (c.get(annotation, "Subtype").asName() === "Link" && ap.isNull() && record.generatedMarker !== "other") {
        record.noGeneratedFingerprint = await fingerprint(c, annotation, refs, true, budget, true);
        record.noGeneratedMoveFingerprint = await fingerprint(c, annotation, refs, false, budget, true);
      }
      if (shared.has(id2)) {
        record.shared = true;
        shared.get(id2).shared = true;
      } else shared.set(id2, record);
      records.push(record);
      list3.push(record);
    }
  }
  return { records, byPage };
}
function sourceWarnings(records) {
  return records.filter((r) => r.descriptor.preservedMissingDestination).map((r) => ({ code: "source-broken-link-preserved", sourcePageIndex: r.sourcePageIndex, annotationIndex: r.annotationIndex }));
}
async function inspect({ mupdf, sourceBytes, sourceSha256 } = {}) {
  const source2 = bytes(sourceBytes, ANNOTATION_LIMITS.sourceBytes), sha = await digest3(source2);
  if (sha !== sourceSha256) fail7("annotation-stale-source");
  const c = context(mupdf, source2);
  try {
    const identities = new Map(Array.from({ length: c.doc.countPages() }, (_, i) => [i, ["source-page", i]])), { refs, pages } = pageRefs(c, identities), catalog = c.get(c.doc.getTrailer(), "Root");
    const tagged = !c.get(catalog, "StructTreeRoot").isNull() || c.get(catalog, "MarkInfo", "Marked").asBoolean();
    const fitAction = await fitOpenAction(c, refs, pages), actionOwnershipUnsupported = unsupportedDocumentActions(c, pages) && !fitAction, destinationBudget = { objects: 0, streams: 0, strings: 0 };
    const names = nameDestinations(c), readDestination = destinationReader(c, refs, names), snapshot = await inventory(c, refs, pages, true), annotations = [];
    for (const record of snapshot.records) {
      const annotation = record.object, descriptor = { sourcePageIndex: record.sourcePageIndex, annotationIndex: record.annotationIndex, kind: c.get(record.object, "Subtype").asName() === "Link" ? "link" : "unsupported", eligible: true };
      record.actionOwnershipUnsafe = actionOwnershipUnsupported || !c.get(annotation, "AA").isNull() || !c.get(annotation, "PA").isNull();
      try {
        if (record.actionOwnershipUnsafe) fail7("annotation-action-root-unsupported");
        const subtype = c.get(annotation, "Subtype").asName();
        if (subtype !== "Link") {
          descriptor.kind = "unsupported";
          fail7("annotation-subtype-unsupported");
        }
        const media = geometry(c, pages[record.sourcePageIndex]);
        record.media = media;
        descriptor.rect = annotationRectangle(c, c.get(annotation, "Rect"));
        if (!contains2(media, descriptor.rect)) fail7("annotation-geometry-invalid");
        const quads = c.get(annotation, "QuadPoints");
        if (!quads.isNull()) {
          descriptor.quadPoints = numericArray(c, quads, 8);
          for (let i = 0; i < descriptor.quadPoints.length; i += 2) if (!contains2(descriptor.rect, [descriptor.quadPoints[i], descriptor.quadPoints[i + 1], descriptor.quadPoints[i], descriptor.quadPoints[i + 1]])) fail7("annotation-geometry-invalid");
        }
        const owner = c.get(annotation, "P");
        record.hadP = !owner.isNull();
        if (record.hadP && (!owner.isIndirect() || owner.asIndirect() !== pages[record.sourcePageIndex].asIndirect())) fail7("annotation-page-owner-invalid");
        if (record.shared) fail7("annotation-shared-object");
        if (tagged || !c.get(annotation, "StructParent").isNull() || !c.get(annotation, "StructParents").isNull() || !c.get(pages[record.sourcePageIndex], "StructParents").isNull()) fail7("annotation-tagged-ownership");
        const resolved = readDestination(annotation);
        record.destinationFingerprints = await Promise.all(resolved.values.map((value) => fingerprint(c, value, refs, true, destinationBudget)));
        record.missingDestinationNames = resolved.missingNames;
        record.unexposedTargets = resolved.unexposedTargets;
        if (resolved.missingNames.length) descriptor.preservedMissingDestination = true;
        descriptor.destination = resolved.destination;
        descriptor.internalDestinationSourcePageIndices = resolved.targets;
        descriptor.internalDestinations = resolved.destinations;
      } catch (error2) {
        descriptor.eligible = false;
        descriptor.reason = error2?.code || "annotation-object-invalid";
      }
      if (!descriptor.destination) {
        const hasTarget = !c.get(annotation, "Dest").isNull() || !c.get(annotation, "A").isNull();
        if (hasTarget || descriptor.kind === "link") try {
          const resolved = readDestination(annotation);
          record.destinationFingerprints = await Promise.all(resolved.values.map((value) => fingerprint(c, value, refs, true, destinationBudget)));
          record.missingDestinationNames = resolved.missingNames;
          record.unexposedTargets = resolved.unexposedTargets;
          if (resolved.missingNames.length) descriptor.preservedMissingDestination = true;
          descriptor.destination = resolved.destination;
          descriptor.internalDestinationSourcePageIndices = resolved.targets;
          descriptor.internalDestinations = resolved.destinations;
        } catch {
          record.destinationUnsafe = true;
          descriptor.destinationUnresolved = true;
        }
      }
      record.descriptor = descriptor;
      annotations.push(descriptor);
    }
    for (const record of snapshot.records) {
      if (!record.descriptor.rect) try {
        record.descriptor.rect = annotationRectangle(c, c.get(record.object, "Rect"));
      } catch {
      }
      if (record.hadP === void 0) record.hadP = !c.get(record.object, "P").isNull();
    }
    const model = frozen2({ schema: "falsify.flow-annotations.v1", sourceSha256: sha, pageCount: pages.length, actionOwnershipUnsupported: actionOwnershipUnsupported || snapshot.records.some((r) => r.actionOwnershipUnsafe), warnings: sourceWarnings(snapshot.records), annotations });
    privateModels.set(model, { mupdf, sha, fitAction, actionOwnershipUnsupported: model.actionOwnershipUnsupported, records: snapshot.records.map(({ object, ...record }) => record), pageGeometry: pages.map((page) => {
      try {
        return geometry(c, page);
      } catch {
        return null;
      }
    }) });
    return model;
  } catch (error2) {
    if (error2 instanceof AnnotationTransportError) throw error2;
    fail7("annotation-inspection-failed");
  } finally {
    c.close();
  }
}
function mapping(model, map, count) {
  if (!Array.isArray(map) || map.length !== model.pageCount) fail7("annotation-page-map-invalid");
  const result = /* @__PURE__ */ new Map(), output = /* @__PURE__ */ new Set();
  for (const row of map) {
    if (!Number.isInteger(row?.sourcePageIndex) || row.sourcePageIndex < 0 || row.sourcePageIndex >= model.pageCount || result.has(row.sourcePageIndex) || !Number.isInteger(row.outputPageIndex) || row.outputPageIndex < 0 || row.outputPageIndex >= count || output.has(row.outputPageIndex)) fail7("annotation-page-map-invalid");
    result.set(row.sourcePageIndex, row.outputPageIndex);
    output.add(row.outputPageIndex);
  }
  return result;
}
function movementPlan(model, records, map, count, moves, reflowed, destinationMoves = [], preserveUnmovedUnsupported = false) {
  if (!Array.isArray(moves) || moves.length > ANNOTATION_LIMITS.annotations || !Array.isArray(reflowed) || reflowed.some((p) => !Number.isInteger(p) || p < 0 || p >= model.pageCount) || new Set(reflowed).size !== reflowed.length) fail7("annotation-move-invalid");
  const group = new Set(reflowed), byKey = new Map(records.map((r) => [key2(r.sourcePageIndex, r.annotationIndex), r])), planned = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (!move || !["annotationIndex,dx,dy,outputPageIndex,sourcePageIndex", "annotationIndex,dx,dy,outputPageIndex,rect,sourcePageIndex"].includes(Object.keys(move).sort().join(",")) || !Number.isInteger(move.sourcePageIndex) || !Number.isInteger(move.annotationIndex) || !Number.isInteger(move.outputPageIndex) || move.outputPageIndex < 0 || move.outputPageIndex >= count || ![move.dx, move.dy].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e5)) fail7("annotation-move-invalid");
    const id2 = key2(move.sourcePageIndex, move.annotationIndex), record = byKey.get(id2);
    if (!record || planned.has(id2) || !record.descriptor.eligible || !group.has(move.sourcePageIndex)) fail7("annotation-move-invalid");
    if (move.rect !== void 0) {
      const d = record.descriptor, r = move.rect;
      if (d.kind !== "link" || d.quadPoints || !Array.isArray(d.rect) || !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || r[0] >= r[2] || r[1] >= r[3] || move.dx !== 0 || move.dy !== 0 || move.outputPageIndex !== map.get(move.sourcePageIndex) || !contains2(r, d.rect)) fail7("annotation-move-invalid");
      for (const other of records.filter((x) => x.sourcePageIndex === move.sourcePageIndex && x !== record)) {
        const q = other.descriptor.rect;
        if (!Array.isArray(q) || q.length !== 4) fail7("annotation-move-invalid");
        if (Math.min(r[2], q[2]) - Math.max(r[0], q[0]) > 1e-4 && Math.min(r[3], q[3]) - Math.max(r[1], q[1]) > 1e-4) fail7("annotation-move-overlap");
      }
    }
    planned.set(id2, move);
  }
  const expanded = [...planned.values()].filter((m) => m.rect !== void 0);
  for (let i = 0; i < expanded.length; i++) for (let j = i + 1; j < expanded.length; j++) {
    const a = expanded[i], b = expanded[j];
    if (a.outputPageIndex !== b.outputPageIndex) continue;
    if (Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]) > 1e-4 && Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]) > 1e-4) fail7("annotation-move-overlap");
  }
  if (!Array.isArray(destinationMoves) || destinationMoves.length > ANNOTATION_LIMITS.annotations) fail7("annotation-destination-move-invalid");
  const destinations = /* @__PURE__ */ new Map();
  for (const record of records) for (const d of record.descriptor.internalDestinations || []) {
    const old = destinations.get(d.id);
    if (old && JSON.stringify(old) !== JSON.stringify(d)) fail7("annotation-destination-move-invalid");
    destinations.set(d.id, d);
  }
  const destinationPlan = /* @__PURE__ */ new Map();
  for (const move of destinationMoves) {
    if (!move || Object.keys(move).sort().join(",") !== "dx,dy,id,outputPageIndex,sourcePageIndex" || !Number.isInteger(move.id) || !Number.isInteger(move.sourcePageIndex) || !Number.isInteger(move.outputPageIndex) || move.outputPageIndex < 0 || move.outputPageIndex >= count || ![move.dx, move.dy].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e5)) fail7("annotation-destination-move-invalid");
    const d = destinations.get(move.id);
    if (!d || destinationPlan.has(move.id) || d.targetSourcePageIndex !== move.sourcePageIndex || !group.has(move.sourcePageIndex)) fail7("annotation-destination-move-invalid");
    let operands;
    if (d.kind === "FitR" && d.operands.length === 4 && d.operands.every((n) => typeof n === "number" && Number.isFinite(n))) {
      operands = d.operands.map((n, i) => n + (i % 2 ? move.dy : move.dx));
      if (operands[0] >= operands[2] || operands[1] >= operands[3]) fail7("annotation-destination-move-invalid");
    } else if (d.kind === "XYZ" && d.operands.length === 3 && Number.isFinite(d.operands[0]) && Number.isFinite(d.operands[1]) && (d.operands[2] === null || Number.isFinite(d.operands[2]))) {
      operands = [d.operands[0] + move.dx, d.operands[1] + move.dy, d.operands[2]];
    } else fail7("annotation-destination-move-invalid");
    if (!operands.every((n) => n === null || Number.isFinite(n) && Math.abs(n) <= 1e5)) fail7("annotation-destination-move-invalid");
    destinationPlan.set(move.id, { move, descriptor: d, operands });
  }
  for (const record of records) {
    const d = record.descriptor;
    if (record.shared && (preserveUnmovedUnsupported !== true || records.some((r) => r.aliasKey === record.aliasKey && planned.has(key2(r.sourcePageIndex, r.annotationIndex))))) fail7("annotation-shared-object");
    if (group.size && record.actionOwnershipUnsafe) fail7("annotation-action-root-unsupported");
    if (group.size && record.destinationUnsafe) fail7("annotation-destination-unresolved");
    if ((record.unexposedTargets || []).some((p) => group.has(p))) fail7("annotation-destination-reflowed");
    if (group.has(record.sourcePageIndex) && !d.eligible && !(preserveUnmovedUnsupported === true && !planned.has(key2(record.sourcePageIndex, record.annotationIndex)) && (record.shared || d.kind === "unsupported" && d.reason === "annotation-subtype-unsupported"))) fail7(d.reason);
    if ((d.internalDestinationSourcePageIndices || []).some((p) => group.has(p) && (!(d.internalDestinations || []).some((x) => x.targetSourcePageIndex === p) || (d.internalDestinations || []).some((x) => x.targetSourcePageIndex === p && !destinationPlan.has(x.id))))) fail7("annotation-destination-reflowed");
  }
  const expected = Array.from({ length: count }, () => []);
  for (const record of records) {
    const id2 = key2(record.sourcePageIndex, record.annotationIndex), move = planned.get(id2), origin = map.get(record.sourcePageIndex);
    if (!move || move.outputPageIndex === origin) expected[origin].push({ record, move });
  }
  for (const move of moves) {
    const record = byKey.get(key2(move.sourcePageIndex, move.annotationIndex));
    if (move.outputPageIndex !== map.get(move.sourcePageIndex)) expected[move.outputPageIndex].push({ record, move });
  }
  return { expected, planned, destinationPlan };
}
async function bound({ model, sourceBytes, outputBytes, sourcePageMap, moves = [], reflowedSourcePages = [], destinationMoves = [], preserveUnmovedUnsupported = false }) {
  const state = privateModels.get(model);
  if (!state) fail7("annotation-model-unverified");
  if (await digest3(bytes(sourceBytes, ANNOTATION_LIMITS.sourceBytes)) !== state.sha) fail7("annotation-stale-source");
  const c = context(state.mupdf, bytes(outputBytes, ANNOTATION_LIMITS.outputBytes));
  try {
    if (reflowedSourcePages.length && state.actionOwnershipUnsupported) fail7("annotation-action-root-unsupported");
    const map = mapping(model, sourcePageMap, c.doc.countPages()), inverse = new Map([...map].map(([s, o]) => [o, ["source-page", s]])), { refs, pages } = pageRefs(c, inverse), plan = movementPlan(model, state.records, map, pages.length, moves, reflowedSourcePages, destinationMoves, preserveUnmovedUnsupported);
    if (reflowedSourcePages.length) {
      const outputAction = await fitOpenAction(c, refs, pages);
      if (!state.fitAction || !outputAction || JSON.stringify(state.fitAction) !== JSON.stringify(outputAction)) fail7("annotation-action-root-unsupported");
      if (state.fitAction.present && (pages.length !== model.pageCount || [...map].some(([s, o]) => s !== o) || moves.some((m) => m.sourcePageIndex !== m.outputPageIndex) || destinationMoves.some((m) => m.sourcePageIndex !== m.outputPageIndex))) fail7("annotation-action-root-unsupported");
    }
    for (const [s, o] of map) if (state.pageGeometry[s] && !numbers(state.pageGeometry[s], geometry(c, pages[o]))) fail7("annotation-page-identity-invalid");
    return { c, state, map, refs, pages, plan, preserveUnmovedUnsupported };
  } catch (error2) {
    c.close();
    throw error2;
  }
}
async function verifyDocument(ctx, expected, after = false) {
  const { c, refs, pages } = ctx, restore = [], seen = /* @__PURE__ */ new Map(), reader = destinationReader(c, refs, nameDestinations(c));
  try {
    for (const record of ctx.state.records) {
      let found;
      for (let p = 0; p < expected.length && !found; p++) {
        const i = expected[p].findIndex((x) => x.record === record);
        if (i >= 0) found = c.get(annotationArray(c, pages[p]), i);
      }
      if (!found) fail7("annotation-output-count-mismatch");
      if (!record.destinationFingerprints) continue;
      const resolved = reader(found), original = record.descriptor.internalDestinations || [];
      if (resolved.destinations.length !== original.length) fail7("annotation-destination-definition-mismatch");
      for (let i = 0; i < original.length; i++) {
        const old = original[i], current = resolved.destinations[i], obj = resolved.destinationObjects[i], id2 = identity(obj), previous = seen.get(old.id);
        if (previous !== void 0 && previous !== id2) fail7("annotation-destination-definition-mismatch");
        if ([...seen].some(([other, value]) => other !== old.id && value === id2)) fail7("annotation-destination-definition-mismatch");
        seen.set(old.id, id2);
        const change = ctx.plan.destinationPlan.get(old.id), target = after && change ? change.move.outputPageIndex : ctx.map.get(old.targetSourcePageIndex), operands = after && change ? change.operands : old.operands;
        const page = c.get(obj, 0);
        if (current.kind !== old.kind || !page.isIndirect() || page.asIndirect() !== pages[target].asIndirect() || JSON.stringify(current.operands) !== JSON.stringify(operands)) fail7("annotation-destination-definition-mismatch");
        if (after && change && !restore.some((x) => x.id === id2)) restore.push({ id: id2, obj, page, operands: current.operands, old });
      }
    }
    for (const item of restore) {
      item.obj.put(0, pages[ctx.map.get(item.old.targetSourcePageIndex)]);
      item.old.operands.forEach((n, j) => item.obj.put(j + 2, n));
    }
    const actual = await inventory(c, refs, pages), names = nameDestinations(c), readDestination = destinationReader(c, refs, names), destinationBudget = { objects: 0, streams: 0, strings: 0 };
    if (ctx.preserveUnmovedUnsupported !== true && actual.records.some((r) => r.shared)) fail7("annotation-shared-object");
    const aliases = /* @__PURE__ */ new Map(), reverseAliases = /* @__PURE__ */ new Map();
    for (let p = 0; p < pages.length; p++) {
      if (actual.byPage[p].length !== expected[p].length) fail7("annotation-output-count-mismatch");
      for (let i = 0; i < expected[p].length; i++) {
        const { record, move } = expected[p][i], out = actual.byPage[p][i], d = record.descriptor;
        if (aliases.has(record.aliasKey) && aliases.get(record.aliasKey) !== out.aliasKey || reverseAliases.has(out.aliasKey) && reverseAliases.get(out.aliasKey) !== record.aliasKey) fail7("annotation-shared-object");
        aliases.set(record.aliasKey, out.aliasKey);
        reverseAliases.set(out.aliasKey, record.aliasKey);
        if ((move ? out.fingerprint : out.fullFingerprint) !== (move ? record.fingerprint : record.fullFingerprint)) {
          if (record.generatedMarker !== "absent" || out.generatedMarker !== "true" || !(move ? record.noGeneratedMoveFingerprint : record.noGeneratedFingerprint) || (move ? record.noGeneratedMoveFingerprint : record.noGeneratedFingerprint) !== (move ? out.noGeneratedMoveFingerprint : out.noGeneratedFingerprint)) fail7("annotation-semantic-mismatch");
        }
        if (record.destinationFingerprints) {
          const resolved = readDestination(out.object), fingerprints = await Promise.all(resolved.values.map((value) => fingerprint(c, value, refs, true, destinationBudget)));
          if (JSON.stringify(fingerprints) !== JSON.stringify(record.destinationFingerprints) || JSON.stringify(resolved.missingNames) !== JSON.stringify(record.missingDestinationNames)) fail7("annotation-destination-definition-mismatch");
        }
        if (!move) continue;
        if (!d.rect) fail7("annotation-geometry-invalid");
        const rect2 = move?.rect ?? d.rect.map((v, k) => v + (move ? k % 2 ? move.dy : move.dx : 0));
        if (!numbers(rect2, annotationRectangle(c, c.get(out.object, "Rect")))) fail7("annotation-output-geometry-mismatch");
        if (move && !contains2(geometry(c, pages[p]), rect2)) fail7("annotation-output-geometry-mismatch");
        const quads = c.get(out.object, "QuadPoints");
        if (d.quadPoints) {
          const expectedQuads = d.quadPoints.map((v, k) => v + (move ? k % 2 ? move.dy : move.dx : 0));
          if (!numbers(expectedQuads, numericArray(c, quads, 8))) fail7("annotation-output-geometry-mismatch");
        } else if (!quads.isNull()) fail7("annotation-output-geometry-mismatch");
        const owner = c.get(out.object, "P");
        if (move || record.hadP) {
          if (!owner.isIndirect() || owner.asIndirect() !== pages[p].asIndirect()) fail7("annotation-output-owner-mismatch");
        } else if (!owner.isNull()) fail7("annotation-output-owner-mismatch");
      }
    }
    return actual;
  } finally {
    for (const item of restore) {
      item.obj.put(0, item.page);
      item.operands.forEach((n, j) => item.obj.put(j + 2, n));
    }
  }
}
async function transport(request = {}) {
  const ctx = await bound(request);
  try {
    const noMoves = movementPlan(request.model, ctx.state.records, ctx.map, ctx.pages.length, [], request.reflowedSourcePages || [], request.destinationMoves || [], request.preserveUnmovedUnsupported);
    const actual = await verifyDocument(ctx, noMoves.expected), located = /* @__PURE__ */ new Map();
    for (const record of ctx.state.records) located.set(key2(record.sourcePageIndex, record.annotationIndex), actual.byPage[ctx.map.get(record.sourcePageIndex)][record.annotationIndex].object);
    const reader = destinationReader(ctx.c, ctx.refs, nameDestinations(ctx.c)), changed = /* @__PURE__ */ new Set();
    for (const record of ctx.state.records) {
      if (!record.destinationFingerprints) continue;
      const resolved = reader(located.get(key2(record.sourcePageIndex, record.annotationIndex)));
      for (let i = 0; i < resolved.destinations.length; i++) {
        const d = resolved.destinations[i], change = ctx.plan.destinationPlan.get(d.id);
        if (!change || changed.has(d.id)) continue;
        const obj = resolved.destinationObjects[i];
        obj.put(0, ctx.pages[change.move.outputPageIndex]);
        change.operands.forEach((n, j) => obj.put(j + 2, n));
        changed.add(d.id);
      }
    }
    if (changed.size !== ctx.plan.destinationPlan.size) fail7("annotation-destination-move-invalid");
    const touched = /* @__PURE__ */ new Set();
    for (const move of request.moves || []) {
      const object = located.get(key2(move.sourcePageIndex, move.annotationIndex)), record = ctx.state.records.find((r) => r.sourcePageIndex === move.sourcePageIndex && r.annotationIndex === move.annotationIndex), d = record.descriptor;
      const rect2 = move.rect ?? d.rect.map((v, k) => v + (k % 2 ? move.dy : move.dx));
      if (!contains2(geometry(ctx.c, ctx.pages[move.outputPageIndex]), rect2)) fail7("annotation-output-geometry-mismatch");
      object.put("Rect", rect2);
      object.put("P", ctx.pages[move.outputPageIndex]);
      if (d.quadPoints) object.put("QuadPoints", d.quadPoints.map((v, k) => v + (k % 2 ? move.dy : move.dx)));
      touched.add(ctx.map.get(move.sourcePageIndex));
      touched.add(move.outputPageIndex);
    }
    for (const p of touched) {
      const array = ctx.c.keep(ctx.c.doc.newArray());
      for (const { record } of ctx.plan.expected[p]) array.push(located.get(key2(record.sourcePageIndex, record.annotationIndex)));
      ctx.pages[p].put("Annots", array);
    }
    await verifyDocument(ctx, ctx.plan.expected, true);
    const buffer = ctx.c.doc.saveToBuffer("garbage=0,compress=false");
    let pdf;
    try {
      pdf = buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
    const result = await validate({ ...request, outputBytes: pdf });
    if (!result.ok) fail7(result.code);
    return { pdf, report: { check: "passed", moved: (request.moves || []).length, checkedAnnotations: ctx.state.records.length, warnings: sourceWarnings(ctx.state.records) } };
  } catch (error2) {
    if (error2 instanceof AnnotationTransportError) throw error2;
    fail7("annotation-transport-failed");
  } finally {
    ctx.c.close();
  }
}
async function validate(request = {}) {
  let ctx;
  try {
    ctx = await bound(request);
    await verifyDocument(ctx, ctx.plan.expected, true);
    return { ok: true, checkedAnnotations: ctx.state.records.length, moved: (request.moves || []).length, warnings: sourceWarnings(ctx.state.records) };
  } catch (error2) {
    return { ok: false, code: error2 instanceof AnnotationTransportError ? error2.code : "annotation-validation-failed" };
  } finally {
    ctx?.c.close();
  }
}
function createAnnotationTransport({ mupdf } = {}) {
  return Object.freeze({ inspect: (request) => inspect({ ...request, mupdf }), transport, validate });
}

// src/paragraph-link-transport.mjs
var intersects2 = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1e-4 && Math.min(a.t, b.t) - Math.max(a.b, b.b) > 1e-4;
var sameBox = (a, b) => ["l", "r", "b", "t"].every((k) => Number.isFinite(a[k]) && Number.isFinite(b[k]) && Math.abs(a[k] - b[k]) <= 0.05);
function stationaryLinks(links, source2, target) {
  const proved = /* @__PURE__ */ new Set();
  for (const link of links) {
    if (!Array.isArray(link.rect) || link.rect.length !== 4 || !link.rect.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = link.rect, rect2 = { l: Math.min(x1, x2), r: Math.max(x1, x2), b: Math.min(y1, y2), t: Math.max(y1, y2) };
    const owned = source2.chars.filter((c) => c.u > 32 && c.box && intersects2(c.box, rect2));
    if (!owned.length) continue;
    const outputOwned = target.chars.filter((c) => c.u > 32 && c.box && intersects2(c.box, rect2));
    if (outputOwned.length !== owned.length) continue;
    const used = /* @__PURE__ */ new Set();
    let ok = true;
    for (const c of owned) {
      const asGlyph = (c2) => ({ u: c2.u, ...c2.box, style: c2.style });
      const matches = outputOwned.filter((t) => t.u === c.u && sameBox(c.box, t.box) && c.style && t.style && edgeGlyphsEquivalent([asGlyph(c)], [asGlyph(t)]));
      if (matches.length !== 1 || used.has(matches[0].index)) {
        ok = false;
        break;
      }
      used.add(matches[0].index);
    }
    if (ok) proved.add(link.annotationIndex);
  }
  return proved;
}
function numericLink(link, source2, target, proof, allAnnotations, pageIndex, outputPageIndex) {
  if (!proof || !link.eligible || !Array.isArray(link.rect) || link.quadPoints) return null;
  const [l, b, r, t] = link.rect, rect2 = { l, b, r, t };
  const changed = new Set(proof.sourceIndices), replacement = new Set(proof.outputIndices);
  const owned = source2.filter((c) => c.u > 32 && c.box && intersects2(c.box, rect2));
  if (!owned.length || !proof.sourceIndices.every((i) => owned.some((c) => c.index === i)) || !proof.outputIndices.length) return null;
  const retained = new Map(proof.retained.map((x) => [x.sourceIndex, x.outputIndex]));
  const mapped = [];
  for (const c of owned) {
    if (changed.has(c.index)) continue;
    const n = retained.get(c.index), o = target[n];
    if (!o?.box || o.u !== c.u || !sameBox(c.box, o.box) || !c.style || !o.style || !edgeGlyphsEquivalent([{ u: c.u, ...c.box, style: c.style }], [{ u: o.u, ...o.box, style: o.style }])) return null;
    mapped.push(n);
  }
  const old = proof.sourceIndices.map((i) => source2[i]), fresh = proof.outputIndices.map((i) => target[i]);
  if (old.some((c) => !c?.box || !c.style) || fresh.some((c) => !c?.box || !c.style)) return null;
  const exemplar = old[0];
  for (const c of fresh) if (!edgeGlyphsEquivalent([{ u: exemplar.u, ...exemplar.box, style: exemplar.style }], [{ u: exemplar.u, ...exemplar.box, style: c.style }])) return null;
  const bounds = (chars) => ({ l: Math.min(...chars.map((c) => c.box.l)), r: Math.max(...chars.map((c) => c.box.r)), b: Math.min(...chars.map((c) => c.box.b)), t: Math.max(...chars.map((c) => c.box.t)) });
  const before = bounds(owned), after = bounds([...mapped.map((i) => target[i]), ...fresh]);
  const nr = [Math.min(l, after.l - (before.l - l)), Math.min(b, after.b - (before.b - b)), Math.max(r, after.r + (r - before.r)), Math.max(t, after.t + (t - before.t))];
  if (nr.some((n) => !Number.isFinite(n)) || before.l < l - 0.05 || before.r > r + 0.05 || before.b < b - 0.05 || before.t > t + 0.05) return null;
  const box = { l: nr[0], b: nr[1], r: nr[2], t: nr[3] }, allowed = /* @__PURE__ */ new Set([...mapped, ...replacement]);
  const inside = target.filter((c) => c.u > 32 && c.box && intersects2(c.box, box));
  if (inside.length !== allowed.size || inside.some((c) => !allowed.has(c.index))) return null;
  for (const a of allAnnotations.filter((a2) => a2.sourcePageIndex === pageIndex && a2.annotationIndex !== link.annotationIndex)) {
    if (!Array.isArray(a.rect) || a.rect.length !== 4 || !a.rect.every(Number.isFinite)) return null;
    const [al, ab, ar, at] = a.rect;
    if (intersects2(box, { l: Math.min(al, ar), r: Math.max(al, ar), b: Math.min(ab, at), t: Math.max(ab, at) })) return null;
  }
  return { sourcePageIndex: pageIndex, annotationIndex: link.annotationIndex, outputPageIndex, dx: 0, dy: 0, rect: nr };
}
function retainedLink(link, source2, target, proof, pageIndex, outputPageIndex) {
  if (!proof || !link.eligible || !Array.isArray(link.rect) || link.quadPoints) return null;
  const [l, b, r, t] = link.rect, box = { l, b, r, t }, retained = new Map(proof.retained.map((p) => [p.sourceIndex, p.outputIndex]));
  const owned = source2.filter((c) => c.u > 32 && c.box && intersects2(c.box, box));
  if (!owned.length) return null;
  let dx, dy;
  const ids = /* @__PURE__ */ new Set();
  for (const c of owned) {
    const q = target[retained.get(c.index)];
    if (!q?.box || q.u !== c.u || !c.style || !q.style) return null;
    dx ??= q.box.l - c.box.l;
    dy ??= q.box.b - c.box.b;
    if (!sameBox({ ...c.box, l: c.box.l + dx, r: c.box.r + dx, b: c.box.b + dy, t: c.box.t + dy }, q.box) || !edgeGlyphsEquivalent([{ u: c.u, ...c.box, style: c.style }], [{ u: c.u, ...c.box, style: q.style }])) return null;
    ids.add(q.index);
  }
  const next = { l: l + dx, r: r + dx, b: b + dy, t: t + dy }, inside = target.filter((c) => c.u > 32 && c.box && intersects2(c.box, next));
  if (inside.length !== ids.size || inside.some((c) => !ids.has(c.index))) return null;
  return { sourcePageIndex: pageIndex, outputPageIndex, annotationIndex: link.annotationIndex, dx, dy };
}
function changedProofBoxes(source2, target, proof) {
  const boxes = [...proof.sourceIndices.map((i) => source2[i]?.box), ...proof.outputIndices.map((i) => target[i]?.box)];
  if (boxes.some((b) => !b)) return null;
  for (const p of proof.retained) {
    const a = source2[p.sourceIndex], b = target[p.outputIndex];
    if (!a || !b || a.u !== b.u || !!a.box !== !!b.box) return null;
    if (a.box) {
      if (!a.style || !b.style || !edgeGlyphsEquivalent([{ u: a.u, ...a.box, style: a.style }], [{ u: a.u, ...a.box, style: b.style }])) return null;
      if (!sameBox(a.box, b.box)) boxes.push(a.box, b.box);
    }
  }
  return boxes;
}
function stationaryPaint(link, source2, target, sourcePage, outputPage, sourceGeometry, targetGeometry) {
  if (typeof source2.renderPageRegion !== "function" || typeof target.renderPageRegion !== "function" || !Array.isArray(link.rect) || sourceGeometry.frame?.rotation !== 0 || JSON.stringify(sourceGeometry.frame) !== JSON.stringify(targetGeometry.frame) || sourceGeometry.W !== targetGeometry.W || sourceGeometry.H !== targetGeometry.H) return false;
  const [l, b, r, t] = link.rect, W = sourceGeometry.W, H = sourceGeometry.H, scale = 2;
  if (![l, b, r, t, W, H].every(Number.isFinite) || l < 0 || b < 0 || r > W || t > H || l >= r || b >= t) return false;
  const fullW = Math.ceil(W * scale), fullH = Math.ceil(H * scale), x = Math.floor(l * scale), y = Math.floor((H - t) * scale), w = Math.ceil(r * scale) - x, h = Math.ceil((H - b) * scale) - y;
  if (w * h > 1e6 || w < 1 || h < 1) return false;
  source2.loadPage(sourcePage);
  target.loadPage(outputPage);
  const a = source2.renderPageRegion(fullW, fullH, x, y, w, h), z = target.renderPageRegion(fullW, fullH, x, y, w, h);
  if (!a?.data || !z?.data || a.data.length !== z.data.length) return false;
  let painted = false;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== z.data[i]) return false;
    if (i % 4 !== 3 && a.data[i] < 250) painted = true;
  }
  return painted;
}
function stationaryPagePaint(src, out, pageIndex, outputPageIndex, s, t, proof, rawSource, rawTarget) {
  if (!proof || s.frame?.rotation !== 0 || typeof src.renderPageRegion !== "function" || typeof out.renderPageRegion !== "function") return false;
  const styled = (raw, g) => {
    const styles = new Map(g.glyphs.map((c) => [c.i, c.style]));
    return raw.map((c) => ({ ...c, style: styles.get(c.index) }));
  };
  const box = changedProofBoxes(styled(rawSource, s), styled(rawTarget, t), proof);
  if (!box?.length) return false;
  const W = Math.ceil(s.W * 2), H = Math.ceil(s.H * 2);
  if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || W * H > 8e6) return false;
  const left = Math.floor(2 * Math.min(...box.map((b2) => b2.l))) - 3, right = Math.ceil(2 * Math.max(...box.map((b2) => b2.r))) + 3;
  const top = Math.floor(2 * (s.H - Math.max(...box.map((b2) => b2.t)))) - 3, bottom = Math.ceil(2 * (s.H - Math.min(...box.map((b2) => b2.b)))) + 3;
  src.loadPage(pageIndex);
  out.loadPage(outputPageIndex);
  const a = src.renderPageRegion(W, H, 0, 0, W, H), b = out.renderPageRegion(W, H, 0, 0, W, H);
  if (!a?.data || !b?.data || a.data.length !== b.data.length) return false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= left && x <= right && y >= top && y <= bottom) continue;
    const p = (y * W + x) * 4;
    for (let k = 0; k < 4; k++) if (a.data[p + k] !== b.data[p + k]) return false;
  }
  return true;
}
function stationaryXYZ(destinations, source2, target, edits, pageIndex, outputPageIndex, proof, pagePaint) {
  let text3 = "", indices = [];
  for (const c of source2.chars) {
    const ch = String.fromCharCode(c.u);
    if (/\s/u.test(ch)) {
      if (text3 && !text3.endsWith(" ")) {
        text3 += " ";
        indices.push(null);
      }
    } else {
      text3 += ch;
      indices.push(c.index);
    }
  }
  if (text3.endsWith(" ")) {
    text3 = text3.slice(0, -1);
    indices.pop();
  }
  const expected = expectedPageText(text3, edits, { includeSpans: true });
  if (!expected.ok && !proof) return [];
  const edited = proof ? new Set(proof.sourceIndices) : new Set(expected.spans.flatMap((s) => indices.slice(s.a, s.b).filter((i) => i !== null)));
  const retained = proof ? new Map(proof.retained.map((x) => [x.sourceIndex, x.outputIndex])) : null;
  const changedBoxes = proof ? changedProofBoxes(source2.chars, target.chars, proof) : [];
  const pageStable = !!proof && pagePaint && !!changedBoxes;
  const groups = /* @__PURE__ */ new Map();
  for (const c of source2.chars) if (c.u > 32 && c.object && c.box && !c.generated) {
    const g = groups.get(c.object) || [];
    g.push(c);
    groups.set(c.object, g);
  }
  const proved = [];
  for (const d of destinations) {
    if (d.kind !== "XYZ" || d.operands.length !== 3 || !Number.isFinite(d.operands[0]) || !Number.isFinite(d.operands[1]) || !(d.operands[2] === null || Number.isFinite(d.operands[2]))) continue;
    const [x, y] = d.operands;
    if (pageStable && !changedBoxes.some((q) => x >= q.l - 0.5 && x <= q.r + 0.5 && y >= q.b - 0.5 && y <= q.t + 0.5)) {
      proved.push({ id: d.id, sourcePageIndex: pageIndex, outputPageIndex, dx: 0, dy: 0 });
      continue;
    }
    const matches = [...groups.values()].filter((g) => {
      const l = Math.min(...g.map((c) => c.box.l)), t = Math.max(...g.map((c) => c.box.t));
      return l >= x - 0.5 && l <= x + 4 && t <= y + 2 && t >= y - 8;
    });
    if (matches.length !== 1 || matches[0].some((c) => edited.has(c.index))) continue;
    const used = /* @__PURE__ */ new Set();
    let ok = true;
    for (const c of matches[0]) {
      const candidates = target.chars.filter((t) => (!retained || retained.get(c.index) === t.index) && t.u === c.u && t.box && sameBox(c.box, t.box) && c.style && t.style && edgeGlyphsEquivalent([{ u: c.u, ...c.box, style: c.style }], [{ u: t.u, ...t.box, style: t.style }]));
      if (candidates.length !== 1 || used.has(candidates[0].index)) {
        ok = false;
        break;
      }
      used.add(candidates[0].index);
    }
    if (ok) proved.push({ id: d.id, sourcePageIndex: pageIndex, outputPageIndex, dx: 0, dy: 0 });
  }
  return proved;
}
async function transportParagraphLinks({ engineFactory, sourceBytes, outputBytes, edits, sourcePageMap, flowGroups = [], annotationAdapter }) {
  const failures = [], moves = [], destinationMoves = [];
  const skipped = new Set(flowGroups.flatMap((g) => (g.sourcePages || []).map((p) => p.sourcePageIndex)));
  const pages = [...new Set(edits.map((e) => e.pageIndex))].filter((p) => !skipped.has(p));
  let src, out, model;
  try {
    src = await engineFactory(sourceBytes);
    out = await engineFactory(outputBytes);
    for (const pageIndex of pages) {
      src.loadPage(pageIndex);
      const count = src.M._FPDFPage_GetAnnotCount?.(src.page);
      if (!Number.isInteger(count) || count < 0) {
        failures.push({ code: "paragraph_link_inventory_unverified", pageIndex });
        continue;
      }
      if (!count && !annotationAdapter) continue;
      if (!annotationAdapter) {
        failures.push({ code: "paragraph_link_adapter_unavailable", pageIndex });
        continue;
      }
      try {
        if (!model) {
          try {
            model = await annotationAdapter.inspect({ sourceBytes, sourceSha256: createHash("sha256").update(sourceBytes).digest("hex") });
          } catch (error2) {
            if (error2?.code !== "annotation-document-unsupported" || !Number.isInteger(src.pageCount) || src.pageCount <= ANNOTATION_LIMITS.pages) throw error2;
            let empty = true;
            try {
              for (let i = 0; i < src.pageCount; i++) {
                src.loadPage(i);
                const n = src.M._FPDFPage_GetAnnotCount?.(src.page);
                if (!Number.isInteger(n) || n < 0) throw error2;
                if (n) {
                  empty = false;
                  break;
                }
              }
            } finally {
              src.loadPage(pageIndex);
            }
            if (empty) continue;
            throw error2;
          }
        }
        const links = model.annotations.filter((a) => a.sourcePageIndex === pageIndex && a.kind === "link");
        const hasInbound = model.annotations.some((a) => (a.internalDestinationSourcePageIndices || []).includes(pageIndex));
        if (!links.length && !hasInbound) continue;
        const map = sourcePageMap.find((m) => m.sourcePageIndex === pageIndex);
        if (!map || map.continuationPageIndices?.length) throw Object.assign(new Error(), { code: "paragraph_link_continuation_unverified" });
        const pageEdits = edits.filter((e) => e.pageIndex === pageIndex);
        const sourceRaw = readLinkPageCharacters(src, pageIndex), targetRaw = readLinkPageCharacters(out, map.outputPageIndex);
        const sourceGeometry = readGlyphs(src, pageIndex), targetGeometry = readGlyphs(out, map.outputPageIndex);
        const identityMap = sourcePageMap.length === src.pageCount && src.pageCount === out.pageCount && sourcePageMap.every((m) => m.sourcePageIndex === m.outputPageIndex && !m.continuationPageIndices?.length) && sourceGeometry.W === targetGeometry.W && sourceGeometry.H === targetGeometry.H && JSON.stringify(sourceGeometry.frame) === JSON.stringify(targetGeometry.frame);
        let numericProof = null;
        if (identityMap && typeof src.buildModel === "function") {
          try {
            src.loadPage(pageIndex);
            const model2 = src.buildModel();
            numericProof = modelNumericEditProof(sourceGeometry, targetGeometry, pageEdits, model2) || modelWordEditProof(sourceGeometry, targetGeometry, pageEdits, model2);
          } catch {
          }
        }
        const withStyle = (chars, geometry2) => {
          const styles = new Map(geometry2.glyphs.map((g) => [g.i, g.style]));
          return chars.map((c) => ({ ...c, style: styles.get(c.index) }));
        };
        const ownership = /* @__PURE__ */ new Map();
        for (const link of links) if (Array.isArray(link.rect) && link.rect.length === 4 && link.rect.every(Number.isFinite)) {
          const [x1, y1, x2, y2] = link.rect, rect2 = { l: Math.min(x1, x2), r: Math.max(x1, x2), b: Math.min(y1, y2), t: Math.max(y1, y2) };
          for (const c of sourceRaw.filter((c2) => c2.box && intersects2(c2.box, rect2))) {
            const owners = ownership.get(c.index) || [];
            owners.push(link.annotationIndex);
            ownership.set(c.index, owners);
          }
        }
        const overlapping = new Set([...ownership.values()].filter((a) => a.length > 1).flat());
        for (const link of links.filter((a) => overlapping.has(a.annotationIndex))) failures.push({ code: "paragraph_link_unverified", pageIndex, annotationIndex: link.annotationIndex, reason: "document_flow_link_overlapping_ownership" });
        const candidates = links.filter((a) => !overlapping.has(a.annotationIndex));
        const stationary = stationaryLinks(candidates, { chars: withStyle(sourceRaw, sourceGeometry) }, { chars: withStyle(targetRaw, targetGeometry) });
        const styledSource = withStyle(sourceRaw, sourceGeometry), styledTarget = withStyle(targetRaw, targetGeometry);
        for (const link of candidates.filter((a) => !stationary.has(a.annotationIndex))) {
          const rect2 = link.rect;
          if (!Array.isArray(rect2)) continue;
          const [l, b, r, t] = rect2, box = { l: Math.min(l, r), r: Math.max(l, r), b: Math.min(b, t), t: Math.max(b, t) };
          if (identityMap && !sourceRaw.some((c) => c.u > 32 && c.box && intersects2(c.box, box)) && !targetRaw.some((c) => c.u > 32 && c.box && intersects2(c.box, box)) && stationaryPaint(link, src, out, pageIndex, map.outputPageIndex, sourceGeometry, targetGeometry)) stationary.add(link.annotationIndex);
        }
        const numericMoves = [];
        for (const link of candidates.filter((a) => !stationary.has(a.annotationIndex))) {
          const move = retainedLink(link, styledSource, styledTarget, numericProof, pageIndex, map.outputPageIndex) || numericLink(link, styledSource, styledTarget, numericProof, model.annotations, pageIndex, map.outputPageIndex);
          if (move) {
            numericMoves.push(move);
            stationary.add(link.annotationIndex);
          }
        }
        moves.push(...numericMoves);
        const remaining = candidates.filter((a) => !stationary.has(a.annotationIndex));
        const destinations = /* @__PURE__ */ new Map();
        for (const a of model.annotations) for (const d of a.internalDestinations || []) if (d.targetSourcePageIndex === pageIndex) destinations.set(d.id, d);
        const pagePaint = identityMap && numericProof && stationaryPagePaint(src, out, pageIndex, map.outputPageIndex, sourceGeometry, targetGeometry, numericProof, sourceRaw, targetRaw);
        const fixedDestinations = stationaryXYZ([...destinations.values()], { chars: withStyle(sourceRaw, sourceGeometry) }, { chars: withStyle(targetRaw, targetGeometry) }, pageEdits, pageIndex, map.outputPageIndex, numericProof, pagePaint);
        destinationMoves.push(...fixedDestinations);
        const fixedIds = new Set(fixedDestinations.map((d) => d.id));
        if (!remaining.length && fixedIds.size === destinations.size) continue;
        const band = { sourcePageIndex: pageIndex, floor: -1e5, bodyTop: 1e5 };
        let sourcePage, outputPage, expected, targets, globalError;
        const ordered = (canonical, raw) => canonical.chars.map((c) => {
          if (c.virtual) return { u: c.u, index: null, box: null };
          const native = raw[c.i];
          if (!native || native.index !== c.i || native.u !== c.u || c.u > 32 && !native.box) throw Object.assign(new Error(), { code: "document_flow_link_text_mapping_mismatch" });
          return native;
        });
        try {
          sourcePage = canonicalPage(sourceGeometry);
          outputPage = canonicalPage(targetGeometry, sourcePage.partition);
          if (!sourcePage.ok || !outputPage.ok) throw Object.assign(new Error(), { code: "document_flow_link_text_mapping_mismatch" });
          expected = expectedPageText(sourcePage.text, pageEdits, { includeSpans: true });
          if (!expected.ok) throw Object.assign(new Error(), { code: "document_flow_link_edit_mapping_ambiguous" });
          if (expected.text !== outputPage.text.replace(/\s+/gu, " ").trim()) throw Object.assign(new Error(), { code: "document_flow_link_text_mapping_mismatch" });
          targets = ordered(outputPage, targetRaw).filter((c) => c.u > 32);
          const mappedTargets = targets.map((c) => ({ ...c, outputPageIndex: map.outputPageIndex }));
          const kindModel = (kind) => ({ ...model, annotations: model.annotations.map((a) => ({ ...a, internalDestinations: (a.internalDestinations || []).filter((d) => d.kind === kind && !fixedIds.has(d.id)) })) });
          const provide = (_band, raw) => ordered(sourcePage, raw);
          destinationMoves.push(...deriveNativeXYZMoves(src, [band], mappedTargets, edits, kindModel("XYZ"), expectedPageText, provide));
          destinationMoves.push(...deriveNativeFitRMoves(src, [band], mappedTargets, edits, kindModel("FitR"), expectedPageText, provide));
        } catch (error2) {
          globalError = error2;
        }
        if (globalError && !remaining.length) throw globalError;
        for (const link of remaining) {
          try {
            if (globalError) throw globalError;
            const linkModel = { ...model, annotations: [link] };
            const pageMoves = deriveNativeLinkMoves(src, [band], targets.map((c) => ({ ...c, outputPageIndex: map.outputPageIndex })), edits, linkModel, expectedPageText, new Set(destinationMoves.map((d) => d.sourcePageIndex)), (_band, raw) => ordered(sourcePage, raw));
            moves.push(...pageMoves);
          } catch (error2) {
            failures.push({ code: "paragraph_link_unverified", pageIndex, annotationIndex: link.annotationIndex, reason: error2?.code || "paragraph_link_mapping_failed" });
          }
        }
      } catch (error2) {
        const links = model?.annotations?.filter((a) => a.sourcePageIndex === pageIndex && a.kind === "link") || [];
        if (links.length) for (const a of links) failures.push({ code: "paragraph_link_unverified", pageIndex, annotationIndex: a.annotationIndex, reason: error2?.code || "paragraph_link_mapping_failed" });
        else failures.push({ code: "paragraph_link_inventory_unverified", pageIndex, reason: error2?.code || "annotation_inspection_failed" });
      }
    }
    if (model) {
      try {
        const request = { model, sourceBytes, outputBytes, sourcePageMap, moves, destinationMoves, preserveUnmovedUnsupported: true, reflowedSourcePages: pages };
        const pdf = moves.length || destinationMoves.length ? new Uint8Array((await annotationAdapter.transport(request)).pdf) : outputBytes;
        const verified = await annotationAdapter.validate({ ...request, outputBytes: pdf });
        if (!verified?.ok) throw Object.assign(new Error(), { code: verified?.code || "annotation_validation_failed" });
        return { pdf, moves, failures };
      } catch (error2) {
        const affected = moves.length ? moves : model.annotations.filter((a) => a.kind === "link" && pages.includes(a.sourcePageIndex));
        if (!affected.length) failures.push({ code: "paragraph_link_inventory_unverified", reason: error2?.code || "annotation_transport_failed" });
        for (const move of affected) failures.push({ code: "paragraph_link_unverified", pageIndex: move.sourcePageIndex, annotationIndex: move.annotationIndex, reason: error2?.code || "annotation_transport_failed" });
      }
    }
    return { pdf: outputBytes, moves: [], failures };
  } catch (error2) {
    return { pdf: outputBytes, moves: [], failures: [...failures, ...pages.map((pageIndex) => ({ code: "paragraph_link_inventory_unverified", pageIndex, reason: error2?.code || "paragraph_link_check_failed" }))] };
  } finally {
    try {
      src?.close();
    } finally {
      out?.close();
    }
  }
}

// src/paragraph-vendor/inline-preservation.mjs
init_shadingsurgery();
var WS = /^\s+$/;
var tokens = (s) => s.match(/\s+|\S+/g) || [];
var isWs = (c) => /\s/.test(c.ch);
var nfc = (t) => t.normalize("NFC");
var STYLE_KEYS = ["family", "bold", "italic", "size", "rgba", "underline", "strike", "script", "renderMode", "strokeRgba", "strokeWidth", "hScale", "rise"];
var runStyleKey = (r) => STYLE_KEYS.map((k) => String(k === "rgba" || k === "strokeRgba" ? (r?.[k] ?? 0) >>> 0 : r?.[k] ?? "")).join("|");
function planInlineChange(paras, chars, map, hit, needle, after) {
  const bt = [];
  let k = 0;
  for (const t of tokens(needle)) {
    bt.push({ t, k0: k, k1: k + t.length });
    k += t.length;
  }
  const at = tokens(after);
  const rawOf = (tok) => chars.slice(map[hit + tok.k0][0], map[hit + tok.k1 - 1][1] + 1);
  const same = (b, a) => WS.test(b.t) ? WS.test(a) && (a === " " || a === rawOf(b).map((c) => c.ch).join("")) : a === b.t;
  let p = 0;
  while (p < bt.length && p < at.length && same(bt[p], at[p])) p++;
  let s = 0;
  while (s < bt.length - p && s < at.length - p && same(bt[bt.length - 1 - s], at[at.length - 1 - s])) s++;
  const D = bt.slice(p, bt.length - s);
  const X = at.slice(p, at.length - s);
  const text3 = X.join("");
  const del = D.flatMap(rawOf).filter((c) => c.pi >= 0);
  if (!text3) return { del, inserts: [] };
  const style = (c) => runStyleKey(paras[c.pi].runs[c.ri]);
  const place = (c, text4, after2 = false) => ({ pi: c.pi, ri: c.ri, o: c.o + (after2 ? 1 : 0), text: text4 });
  const words = del.filter((c) => !isWs(c));
  if (D.length === 1 && X.length === 1 && !WS.test(D[0].t) && !WS.test(X[0]) && new Set(words.map(style)).size > 1) {
    const b = D[0], a = X[0];
    let first = 0, last = 0;
    while (first < b.t.length && first < a.length && b.t[first] === a[first]) first++;
    while (last < b.t.length - first && last < a.length - first && b.t[b.t.length - 1 - last] === a[a.length - 1 - last]) last++;
    let start = first, end = b.t.length - last;
    let old = b.t.slice(start, end), replacement = a.slice(first, a.length - last);
    if (!old && /^[0-9]+$/.test(replacement)) {
      while (start > 0 && /^[0-9]$/.test(b.t[start - 1])) start--;
      while (end < b.t.length && /^[0-9]$/.test(b.t[end])) end++;
      old = b.t.slice(start, end);
      replacement = b.t.slice(start, first) + replacement + b.t.slice(first, end);
    }
    if ((first || last) && old) {
      const narrow = rawOf({ k0: b.k0 + start, k1: b.k0 + end }).filter((c) => c.pi >= 0);
      if (narrow.length && new Set(narrow.map(style)).size === 1) {
        const numeric = /^[0-9]+$/.test(old) && /^[0-9]+$/.test(replacement);
        return {
          del: narrow,
          inserts: replacement ? [place(narrow[0], replacement)] : [],
          ...numeric ? { warning: "numeric_marker_style_from_digits", numericMarker: { before: old, after: replacement, context: b.t, offset: start } } : {}
        };
      }
    }
  }
  if (words.length) {
    const styles = new Set(words.map(style));
    const paraSet = new Set(del.map((c) => c.pi));
    if (paraSet.size > 1) {
      const lastPi = Math.max(...paraSet);
      const anchor = del.find((c) => c.pi === lastPi);
      return { del, inserts: [place(anchor, text3)], warning: styles.size > 1 ? "style_inherited_across_paragraphs" : void 0 };
    }
    if (styles.size === 1) return { del, inserts: [place(words[0], text3)] };
    const marker = del.map((c) => c.ch).join("");
    const digits = words.filter((c) => /^[0-9]$/.test(c.ch));
    if (/^[0-9]+$/.test(text3) && /^[0-9]+(?:\s*[,;:–-]\s*[0-9]+)+$/.test(marker) && digits.length && new Set(digits.map(style)).size === 1 && new Set(words.map((c) => runStyleKey({ ...paras[c.pi].runs[c.ri], rgba: 0 }))).size === 1) {
      return { del, inserts: [place(digits[0], text3)], warning: "numeric_marker_style_from_digits" };
    }
    const pi = words[0].pi;
    const para = paras[pi], lines2 = para.lines || [];
    const starts = [];
    let total = 0;
    for (const r of para.runs) {
      starts.push(total);
      total += r.text.length;
    }
    const offsets = lines2.map((l) => l.off);
    if (paraSet.size === 1 && offsets.length > 1 && offsets[0] === 0 && offsets.every((v, i) => Number.isInteger(v) && (i === 0 || v > offsets[i - 1]))) {
      const perLine = /* @__PURE__ */ new Map();
      for (const c of words) {
        const off = starts[c.ri] + c.o;
        let line = 0;
        while (line + 1 < offsets.length && offsets[line + 1] <= off) line++;
        const run = para.runs[c.ri], scale = run.hScale;
        const set = perLine.get(line) || /* @__PURE__ */ new Set();
        set.add(scale);
        perLine.set(line, set);
      }
      const base = new Set(words.map((c) => runStyleKey({ ...para.runs[c.ri], hScale: 1 })));
      const affected = [...perLine.keys()].map((i) => lines2[i]);
      const geometry2 = affected.every((l) => Number.isFinite(l.x) && Number.isFinite(l.w) && l.w > 1);
      const justified = geometry2 && Math.max(...affected.map((l) => l.x)) - Math.min(...affected.map((l) => l.x)) <= 1 && Math.max(...affected.map((l) => l.x + l.w)) - Math.min(...affected.map((l) => l.x + l.w)) <= 1;
      if (base.size === 1 && perLine.size > 1 && justified && [...perLine.values()].every((s2) => s2.size === 1 && [...s2].every((v) => Number.isFinite(v) && v > 0))) {
        return { del, inserts: [place(words[0], text3)], requiresPrefix: true };
      }
    }
    if (D.length !== X.length) return { failure: "AMBIGUOUS_STYLE" };
    const sourceStyles = /* @__PURE__ */ new Map();
    for (const b of bt) {
      if (WS.test(b.t)) continue;
      const set = sourceStyles.get(nfc(b.t)) ?? /* @__PURE__ */ new Set();
      for (const c of rawOf(b)) if (c.pi >= 0) set.add(style(c));
      sourceStyles.set(nfc(b.t), set);
    }
    const keep = /* @__PURE__ */ new Set();
    const inserts = [];
    for (let i = 0; i < D.length; i++) {
      const d = D[i], x = X[i];
      if (WS.test(d.t) !== WS.test(x)) return { failure: "AMBIGUOUS_STYLE" };
      if (WS.test(d.t)) {
        if (!same(d, x)) return { failure: "AMBIGUOUS_STYLE" };
        for (const c of rawOf(d)) keep.add(c);
        continue;
      }
      const w = rawOf(d).filter((c) => c.pi >= 0);
      if (new Set(w.map(style)).size !== 1) return { failure: "AMBIGUOUS_STYLE" };
      if (x === d.t) {
        for (const c of w) keep.add(c);
        continue;
      }
      if ([...sourceStyles.get(nfc(x)) ?? []].some((k2) => k2 !== style(w[0]))) return { failure: "AMBIGUOUS_STYLE" };
      inserts.push(place(w[0], x));
    }
    return { del: del.filter((c) => !keep.has(c)), inserts };
  }
  const left = bt.slice(0, p).flatMap(rawOf);
  const right = bt.slice(bt.length - s).flatMap(rawOf);
  const leftWord = left.filter((c) => c.pi >= 0 && !isWs(c)).at(-1);
  const rightWord = right.find((c) => c.pi >= 0 && !isWs(c));
  const lk = leftWord && style(leftWord), rk = rightWord && style(rightWord);
  if (lk && rk && lk !== rk) return { failure: "AMBIGUOUS_STYLE" };
  const viaLeft = left.length && left.at(-1).pi >= 0 ? place(left.at(-1), text3, true) : null;
  const viaRight = right.length && right[0].pi >= 0 ? place(right[0], text3) : null;
  const want = lk || rk;
  if (!want) {
    if (del.length && new Set(del.map(style)).size === 1) return { del, inserts: [place(del[0], text3)] };
    return { failure: "AMBIGUOUS_STYLE" };
  }
  const ins = [rk ? viaRight : null, lk ? viaLeft : null, viaRight, viaLeft].find((c) => c && style(c) === want);
  return ins ? { del, inserts: [ins] } : { failure: "AMBIGUOUS_STYLE" };
}
function commitNumericMarker(engine, para, before, after, scope = null) {
  if (!/^[0-9]+(?:[,;:–-][0-9]+)*$/.test(before) || !/^[0-9]+$/.test(after)) return null;
  const M = engine.M;
  const required = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_GetCharBox", "_FPDFText_ClosePage", "_FPDFText_SetText", "_FPDFPage_RemoveObject"];
  if (!required.every((k) => typeof M?.[k] === "function")) return null;
  const owner = new Set((engine.paragraphObjects(para.id) || []).map((h) => h >>> 0));
  const pageText = M._FPDFText_LoadPage(engine.page);
  if (!pageText) return null;
  const chars = [], buf = M._malloc(32);
  try {
    for (let i = 0; i < M._FPDFText_CountChars(pageText); i++) {
      const u = M._FPDFText_GetUnicode(pageText, i), h = M._FPDFText_GetTextObject(pageText, i) >>> 0;
      const valid2 = M._FPDFText_GetCharBox(pageText, i, buf, buf + 8, buf + 16, buf + 24), v = valid2 ? [0, 1, 2, 3].map((k) => M.HEAPF64[(buf >> 3) + k]) : null;
      chars.push({ u, h, box: v && v.every(Number.isFinite) ? { x: v[0], y: v[2], w: v[1] - v[0], h: v[3] - v[2] } : null });
    }
  } finally {
    M._FPDFText_ClosePage(pageText);
    M._free(buf);
  }
  const text3 = chars.map((c) => String.fromCharCode(c.u)).join("");
  const indexed = scope ? chars.map((c, i) => ({ c, i })).filter(({ c }) => !/\s/.test(String.fromCharCode(c.u))) : null;
  const search = indexed ? indexed.map(({ c }) => String.fromCharCode(c.u)).join("") : text3, needle = scope?.context || before, where = search.indexOf(needle);
  if (where < 0 || search.indexOf(needle, where + 1) >= 0) return null;
  const at = where + (scope?.offset || 0), start = indexed ? indexed[at]?.i : at;
  if (!Number.isInteger(start) || text3.slice(start, start + before.length) !== before) return null;
  const selected = chars.slice(start, start + before.length), handles = [...new Set(selected.map((c) => c.h))];
  if (handles.some((h) => !h || !owner.has(h)) || chars.some((c, i) => handles.includes(c.h) && (i < start || i >= start + before.length))) return null;
  if (handles.length > 1 && typeof engine.retainDetachedObject !== "function" && typeof M._FPDFPageObj_Destroy !== "function") return null;
  const firstText = selected.filter((c) => c.h === handles[0]).map((c) => String.fromCharCode(c.u)).join(""), firstEnd = selected.findIndex((c) => c.h !== handles[0]);
  if (!/^[0-9]+$/.test(firstText) || firstEnd >= 0 && firstEnd !== firstText.length) return null;
  const boxes = handles.map((h) => engine.objectBounds(h));
  if (boxes.some((b) => !b || ![b.x, b.y, b.w, b.h].every(Number.isFinite))) return null;
  const bounds = { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
  bounds.w = Math.max(...boxes.map((b) => b.x + b.w)) - bounds.x;
  bounds.h = Math.max(...boxes.map((b) => b.y + b.h)) - bounds.y;
  const put = (value) => {
    const p = M._malloc((value.length + 1) * 2);
    try {
      for (let i = 0; i < value.length; i++) M.HEAPU16[(p >> 1) + i] = value.charCodeAt(i);
      M.HEAPU16[(p >> 1) + value.length] = 0;
      return !!M._FPDFText_SetText(handles[0], p);
    } finally {
      M._free(p);
    }
  };
  if (!put(after)) throw new LineRetentionError("numeric_marker_write_failed");
  const next = engine.objectBounds(handles[0]), overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  let fits = next && next.x >= bounds.x - 0.5 && next.y >= bounds.y - 0.5 && next.y + next.h <= bounds.y + bounds.h + 0.5;
  if (fits && next.x + next.w > bounds.x + bounds.w + 0.5) {
    fits = Number.isFinite(engine.pageWidth) && next.x + next.w <= engine.pageWidth && chars.every((c, i) => {
      if (i >= start && i < start + before.length || !c.u || /\s/.test(String.fromCharCode(c.u))) return true;
      return !!c.box && overlap(next, c.box) <= overlap(bounds, c.box) + 0.05;
    });
  }
  if (!fits) {
    if (!put(firstText)) throw new LineRetentionError("numeric_marker_restore_failed");
    return null;
  }
  for (const h of handles.slice(1)) {
    if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new LineRetentionError("numeric_marker_remove_failed");
    if (typeof engine.retainDetachedObject === "function") engine.retainDetachedObject(h);
    else M._FPDFPageObj_Destroy(h);
  }
  engine._pageDirty = true;
  engine._spliceOk = false;
  return { status: "source_numeric_marker", objects: handles.length };
}
function commitSourceWord(engine, para, before, after) {
  let first = 0, last = 0;
  while (first < Math.min(before.length, after.length) && before[first] === after[first]) first++;
  while (last < Math.min(before.length, after.length) - first && before.at(-1 - last) === after.at(-1 - last)) last++;
  let start = first, end = before.length - last;
  while (start > 0 && /[A-Za-z]/.test(before[start - 1])) start--;
  while (end < before.length && /[A-Za-z]/.test(before[end])) end++;
  const old = before.slice(start, end), next = before.slice(start, first) + after.slice(first, after.length - last) + before.slice(before.length - last, end);
  if (!/^[A-Za-z]{2,}$/.test(old) || !/^[A-Za-z]{2,}$/.test(next) || old === next) return null;
  const M = engine.M, required = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_ClosePage", "_FPDFText_SetText", "_FPDFPage_CountObjects", "_FPDFPage_GetObject", "_FPDFPageObj_GetType", "_FPDFText_GetCharOrigin", "_FPDFText_GetCharBox", "_FPDFTextObj_GetFont", "_FPDFTextObj_GetFontSize", "_FPDFPageObj_CreateTextObj", "_FPDFPageObj_GetMatrix", "_FPDFPageObj_SetMatrix", "_FPDFPageObj_GetFillColor", "_FPDFPageObj_SetFillColor", "_FPDFTextObj_GetTextRenderMode", "_FPDFPageObj_Destroy", "_FPDFPage_RemoveObject", "_FPDFPage_InsertObjectAtIndex"];
  if (!required.every((k) => typeof M?.[k] === "function") || typeof engine.translateObject !== "function" || typeof engine.retainDetachedObject !== "function" || !Number.isFinite(engine.pageWidth)) return null;
  const owner = new Set((engine.paragraphObjects(para.id) || []).map((h2) => h2 >>> 0)), tp = M._FPDFText_LoadPage(engine.page);
  if (!tp) return null;
  const chars = [], buf = M._malloc(48);
  try {
    for (let i = 0; i < M._FPDFText_CountChars(tp); i++) {
      const originOk = M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8), origin = originOk ? [M.HEAPF64[buf >> 3], M.HEAPF64[(buf >> 3) + 1]] : null;
      const boxOk = M._FPDFText_GetCharBox(tp, i, buf, buf + 8, buf + 16, buf + 24), box = boxOk ? [0, 1, 2, 3].map((k) => M.HEAPF64[(buf >> 3) + k]) : null;
      chars.push({ ch: String.fromCodePoint(M._FPDFText_GetUnicode(tp, i)), h: M._FPDFText_GetTextObject(tp, i) >>> 0, origin, box });
    }
  } finally {
    M._FPDFText_ClosePage(tp);
    M._free(buf);
  }
  const raw = chars.map((c) => c.ch).join(""), hits2 = [];
  const sizes = (para.runs || []).map((r) => r.size).filter((n) => n > 0);
  if (raw.replace(/\s+/g, " ").includes(before.replace(/\s+/g, " ")) && !(sizes.length && Math.min(...sizes) < Math.max(...sizes) * 0.85)) return null;
  for (let i = raw.indexOf(old); i >= 0; i = raw.indexOf(old, i + 1)) {
    const slice = chars.slice(i, i + old.length), h2 = slice[0]?.h;
    if (h2 && owner.has(h2) && slice.every((c) => c.h === h2) && !/[A-Za-z]/.test(raw[i - 1] || "") && !/[A-Za-z]/.test(raw[i + old.length] || "")) hits2.push({ i, h: h2 });
  }
  if (hits2.length !== 1) return null;
  const { h } = hits2[0], full = chars.filter((c) => c.h === h).map((c) => c.ch).join("");
  if (full.indexOf(old) !== full.lastIndexOf(old) || /[\r\n]/.test(full)) return null;
  const bounds = engine.objectBounds(h);
  if (!bounds || ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.h <= 0) return null;
  const objects = [];
  for (let i = 0; i < M._FPDFPage_CountObjects(engine.page); i++) {
    const handle = M._FPDFPage_GetObject(engine.page, i) >>> 0, box = engine.objectBounds(handle);
    if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null;
    objects.push({ h: handle, box, type: M._FPDFPageObj_GetType(handle) });
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const suffix = objects.filter((o) => o.h !== h && o.type === 1 && o.box.x >= bounds.x + bounds.w - 0.1 && overlap({ ...bounds, x: o.box.x, w: o.box.w }, o.box) > 0).sort((a, b) => a.box.x - b.box.x);
  let right = bounds.x + bounds.w;
  const shifted = [];
  for (const o of suffix) {
    const raised = o.box.h < bounds.h * 0.85 && o.box.w < bounds.h * 3 && o.box.y > bounds.y + bounds.h * 0.3;
    if (o.box.x - right > bounds.h * 2 || !owner.has(o.h) && !raised) break;
    shifted.push(o);
    right = Math.max(right, o.box.x + o.box.w);
  }
  if (M._FPDFTextObj_GetTextRenderMode(h) !== 0) return null;
  const p = M._malloc(32), staged = [];
  let committed = false;
  try {
    if (!M._FPDFPageObj_GetMatrix(h, p)) return null;
    const matrix = Array.from(M.HEAPF32.slice(p >> 2, (p >> 2) + 6));
    if (matrix.some((x) => !Number.isFinite(x)) || Math.abs(matrix[1]) > 1e-6 || Math.abs(matrix[2]) > 1e-6 || matrix[0] <= 0 || matrix[3] <= 0) return null;
    if (!M._FPDFTextObj_GetFontSize(h, p)) return null;
    const fontSize = M.HEAPF32[p >> 2], font = M._FPDFTextObj_GetFont(h);
    if (!font || !(fontSize > 0) || !M._FPDFPageObj_GetFillColor(h, p, p + 4, p + 8, p + 12)) return null;
    const rgba = Array.from(M.HEAPU32.slice(p >> 2, (p >> 2) + 4));
    if (rgba[3] !== 255) return null;
    const own = chars.filter((c) => c.h === h);
    let dx = 0;
    for (const match of full.matchAll(/\S+/g)) {
      const selected = own.slice(match.index, match.index + match[0].length), origin = selected[0]?.origin;
      if (!origin || selected.some((c) => !c.box || !c.origin || Math.abs(c.origin[1] - origin[1]) > 0.01)) return null;
      const left = Math.min(...selected.map((c) => c.box[0])), right2 = Math.max(...selected.map((c) => c.box[1])), bottom = Math.min(...selected.map((c) => c.box[2])), top = Math.max(...selected.map((c) => c.box[3]));
      const changed = match[0] === old, text3 = changed ? next : match[0], handle = M._FPDFPageObj_CreateTextObj(engine.doc, font, fontSize);
      if (!handle) return null;
      staged.push({ h: handle });
      const str = M._malloc((text3.length + 1) * 2);
      try {
        for (let i = 0; i < text3.length; i++) M.HEAPU16[(str >> 1) + i] = text3.charCodeAt(i);
        M.HEAPU16[(str >> 1) + text3.length] = 0;
        if (!M._FPDFText_SetText(handle, str)) return null;
      } finally {
        M._free(str);
      }
      M.HEAPF32.set([...matrix.slice(0, 4), origin[0] + dx, origin[1]], p >> 2);
      if (!M._FPDFPageObj_SetMatrix(handle, p) || !M._FPDFPageObj_SetFillColor(handle, ...rgba)) return null;
      const box = engine.objectBounds(handle);
      if (!box) return null;
      if (!changed && [box.x - left - dx, box.x + box.w - right2 - dx, box.y - bottom, box.y + box.h - top].some((v) => Math.abs(v) > 0.05)) return null;
      if (changed) {
        if (Math.abs(box.x - left) > 0.05) return null;
        dx = box.x + box.w - right2;
      }
    }
    if (!Number.isFinite(dx)) return null;
    const moving = /* @__PURE__ */ new Set([h, ...shifted.map((o) => o.h)]), placements = [...staged.map((o) => ({ before: bounds, after: engine.objectBounds(o.h) })), ...shifted.map((o) => ({ before: o.box, after: { ...o.box, x: o.box.x + dx } }))];
    if (placements.some((q) => !q.after || q.after.x < 0 || q.after.x + q.after.w > engine.pageWidth || objects.some((o) => !moving.has(o.h) && overlap(q.after, o.box) > overlap(q.before, o.box) + 0.05))) return null;
    const slot = objects.findIndex((o) => o.h === h);
    if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new LineRetentionError("source_word_remove_failed");
    engine.retainDetachedObject(h);
    committed = true;
    for (const [i, o] of staged.entries()) if (!M._FPDFPage_InsertObjectAtIndex(engine.page, o.h, slot + i)) throw new LineRetentionError("source_word_insert_failed");
    for (const o of shifted) engine.translateObject(o.h, dx, 0);
    engine._pageDirty = true;
    engine._spliceOk = false;
    return { status: "source_word_objects", objects: staged.length, translated: shifted.length, dx };
  } finally {
    M._free(p);
    if (!committed) for (const o of staged) M._FPDFPageObj_Destroy(o.h);
  }
}
function planGeometricShortening(chars, map, hit, before, after) {
  let n = 0;
  while (n < before.length && n < after.length && before[n] === after[n]) n++;
  const punctuation = after.slice(n);
  if (!n || n >= before.length || !/^\p{P}{1,2}$/u.test(punctuation)) return null;
  if (/\s/.test(before[n - 1]) || /\p{L}|\p{N}/u.test(before[n - 1]) && /\p{L}|\p{N}/u.test(before[n] || "")) return null;
  const last = map[hit + n - 1];
  const anchor = chars[last[1]];
  if (!anchor || anchor.pi < 0 || /\s/.test(anchor.ch)) return null;
  const start = map[hit + n][0], end = map[hit + before.length - 1][1];
  const del = chars.slice(start, end + 1).filter((c) => c.pi >= 0);
  return { del, inserts: [{ pi: anchor.pi, ri: anchor.ri, o: anchor.o + 1, text: punctuation }] };
}
async function sourceLineCodes(engine, x, y) {
  const bytes2 = engine._originalBytes;
  if (!bytes2) return null;
  const src = latin(bytes2);
  let pdf = parsePdf(src);
  if (!pdf) return null;
  pdf = await withObjStm(bytes2, src, pdf);
  if (!pdf) return null;
  const page = pdf.objBody(pdf.pageNum(engine.pageIndex));
  if (!page) return null;
  const arr = page.body.match(/\/Contents\s*\[([^\]]*)\]/), single = page.body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  const refs = arr ? [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => +m[1]) : single ? [+single[1]] : [];
  const matches = [], num = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  for (const id2 of refs) {
    const rec = pdf.objBody(id2);
    if (!rec) return null;
    const raw = await streamData(bytes2, src, { num: id2, ...rec });
    if (raw == null) return null;
    const text3 = typeof raw === "string" ? raw : latin(raw);
    const re = new RegExp(`(${num})\\s+(${num})\\s+(${num})\\s+(${num})\\s+(${num})\\s+(${num})\\s+Tm\\b`, "g");
    for (const m of text3.matchAll(re)) {
      if (Math.abs(+m[5] - x) > 0.02 || Math.abs(+m[6] - y) > 0.02) continue;
      const tail = text3.slice(m.index + m[0].length);
      const show = tail.match(/^\s*(\[(?:[^\[\]]|\\.)*\]\s*TJ|\((?:[^()\\]|\\.)*\)\s*Tj)/);
      if (!show) continue;
      const op = show[1], codes = [];
      let valid2 = true;
      for (let i = 0; i < op.length; i++) {
        if (op[i] !== "(") continue;
        let depth = 1;
        for (i++; i < op.length && depth; i++) {
          const ch = op[i];
          if (ch === "\\") {
            const oct = op.slice(i + 1).match(/^[0-7]{1,3}/);
            if (oct) {
              codes.push(parseInt(oct[0], 8));
              i += oct[0].length;
            } else {
              const v = op[++i];
              if (v === "\n" || v === "\r" || v === void 0) {
                valid2 = false;
                break;
              }
              codes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[v] ?? v.charCodeAt(0));
            }
          } else if (ch === "(") {
            depth++;
            codes.push(40);
          } else if (ch === ")") {
            if (--depth) codes.push(41);
          } else codes.push(ch.charCodeAt(0));
        }
        if (depth) valid2 = false;
      }
      if (valid2) matches.push(codes);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
async function commitSourceLineDeletion(engine, para, runs) {
  const lines2 = para.lines || [], old = para.runs.map((r) => r.text).join(""), next = runs.map((r) => r.text).join("");
  let a = 0, b = 0;
  while (a < next.length && old[a] === next[a]) a++;
  while (b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
  if (next.length >= old.length || a + b !== next.length) return null;
  const end = old.length - b, k = lines2.findIndex((l, i) => a >= l.off && end <= (lines2[i + 1]?.off ?? old.length));
  if (k < 0 || /[\r\n]/.test(old.slice(a, end))) return null;
  const start = lines2[k].off, limit = lines2[k + 1]?.off ?? old.length, source2 = old.slice(start, limit).replace(/\s+$/, "");
  if (end > start + source2.length || !source2.length) return null;
  const M = engine.M;
  const api = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_GetCharOrigin", "_FPDFText_ClosePage", "_FPDFText_SetCharcodes", "_FPDFText_SetPositions", "_FPDFPageObj_GetMatrix"];
  if (!api.every((n) => typeof M?.[n] === "function")) return null;
  const handles = new Set((engine.paragraphObjects(para.id) || []).map((h) => h >>> 0)), buf = M._malloc(64);
  const read = () => {
    const tp = M._FPDFText_LoadPage(engine.page), glyph = [];
    if (!tp) return null;
    try {
      for (let i = 0; i < M._FPDFText_CountChars(tp); i++) {
        const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
        if (!handles.has(h) || !M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
        const y = M.HEAPF64[buf + 8 >> 3];
        if (Math.abs(y - lines2[k].y) <= 0.5) glyph.push({ h, u: M._FPDFText_GetUnicode(tp, i), x: M.HEAPF64[buf >> 3], y });
      }
      return glyph;
    } finally {
      M._FPDFText_ClosePage(tp);
    }
  };
  try {
    const glyph = read();
    if (!glyph) return null;
    if (glyph.length !== source2.length || glyph.some((g, i) => g.h !== glyph[0]?.h || g.u !== source2.charCodeAt(i))) return null;
    const h = glyph[0].h, check = M._FPDFText_LoadPage(engine.page);
    if (!check) return null;
    let otherLine = false;
    try {
      for (let i = 0; i < M._FPDFText_CountChars(check); i++) {
        if (M._FPDFText_GetTextObject(check, i) >>> 0 !== h) continue;
        if (!M._FPDFText_GetCharOrigin(check, i, buf, buf + 8) || Math.abs(M.HEAPF64[buf + 8 >> 3] - lines2[k].y) > 0.5) {
          otherLine = true;
          break;
        }
      }
    } finally {
      M._FPDFText_ClosePage(check);
    }
    if (otherLine || !M._FPDFPageObj_GetMatrix(h, buf)) return null;
    const [scale, skew1, skew2, vertical, x, y] = [0, 1, 2, 3, 4, 5].map((i) => M.HEAPF32[(buf >> 2) + i]);
    if (!(scale > 0 && vertical > 0) || Math.abs(skew1) > 1e-4 || Math.abs(skew2) > 1e-4) return null;
    const codes = await sourceLineCodes(engine, x, y);
    if (!codes || codes.length !== glyph.length) return null;
    const left = a - start, right = end - start, kept = glyph.map((_, i) => i).filter((i) => i < left || i >= right);
    if (!kept.length || left === 0 || right >= glyph.length) return null;
    const shift = glyph[right].x - glyph[left].x, cp = M._malloc(kept.length * 4), pp = M._malloc((kept.length - 1) * 4);
    try {
      kept.forEach((j, i) => {
        M.HEAPU32[(cp >> 2) + i] = codes[j];
        if (i) M.HEAPF32[(pp >> 2) + i - 1] = (glyph[j].x - glyph[0].x - (j >= right ? shift : 0)) / scale;
      });
      if (!M._FPDFText_SetCharcodes(h, cp, kept.length) || !M._FPDFText_SetPositions(h, pp, kept.length - 1)) throw new LineRetentionError("source_deletion_write_failed");
    } finally {
      M._free(cp);
      M._free(pp);
    }
    engine._pageDirty = true;
    engine._spliceOk = false;
    const after = read();
    if (!after || after.length !== kept.length || after.some((g, i) => {
      const j = kept[i], expected = glyph[j].x - (j >= right ? shift : 0);
      return g.h !== h || g.u !== glyph[j].u || Math.abs(g.y - glyph[j].y) > 0.02 || Math.abs(g.x - expected) > 0.02;
    })) throw new LineRetentionError("source_deletion_proof_failed");
    return { upd: { id: para.id, surgical: true, lines: lines2 }, lines: { status: "source_line_deletion", line: k } };
  } finally {
    M._free(buf);
  }
}
async function commitGeometricPrefix(engine, para, del, inserts) {
  const M = engine.M, lines2 = para.lines || [];
  const api = ["_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetTextObject", "_FPDFText_GetCharOrigin", "_FPDFText_GetCharBox", "_FPDFText_ClosePage", "_FPDFText_SetCharcodes", "_FPDFText_SetPositions", "_FPDFPageObj_GetMatrix"];
  if (!lines2.length || inserts.length !== 1 || !api.every((k) => typeof M?.[k] === "function")) return null;
  const flat = para.runs.map((r) => r.text).join(""), start = lines2.at(-1).off, offsets = [];
  let offset = 0;
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++, offset++) if (del.has(ri + ":" + o)) offsets.push(offset);
  });
  const ins = inserts[0], at = para.runs.slice(0, ins.ri).reduce((n, r) => n + r.text.length, 0) + ins.o;
  if (!offsets.length || at !== offsets[0] || offsets.some((v, k) => v !== at + k) || offsets.at(-1) !== flat.length - 1 || at <= start || !/^\p{P}$/u.test(ins.text)) return null;
  const line = flat.slice(start), keep = at - start, handles = new Set((engine.paragraphObjects(para.id) || []).map((h) => h >>> 0)), buf = M._malloc(64);
  const read = () => {
    const tp = M._FPDFText_LoadPage(engine.page), rows = [];
    if (!tp) throw new LineRetentionError("glyph_read_failed");
    try {
      for (let i = 0; i < M._FPDFText_CountChars(tp); i++) {
        const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
        if (!handles.has(h) || !M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
        const y = M.HEAPF64[buf + 8 >> 3];
        if (Math.abs(y - lines2.at(-1).y) <= 0.5) {
          const x = M.HEAPF64[buf >> 3];
          if (!M._FPDFText_GetCharBox(tp, i, buf + 16, buf + 24, buf + 32, buf + 40)) throw new LineRetentionError("glyph_box_unavailable");
          rows.push({ h, u: M._FPDFText_GetUnicode(tp, i), x, y, box: [0, 1, 2, 3].map((k) => M.HEAPF64[(buf + 16 >> 3) + k]) });
        }
      }
      return rows;
    } finally {
      M._FPDFText_ClosePage(tp);
    }
  };
  try {
    const before = read();
    if (before.length !== line.length || before.some((g, i) => g.u !== line.charCodeAt(i) || g.h !== before[0]?.h)) return null;
    const h = before[0].h;
    if (!M._FPDFPageObj_GetMatrix(h, buf)) return null;
    const [a, b, c, d, x, y] = [0, 1, 2, 3, 4, 5].map((i) => M.HEAPF32[(buf >> 2) + i]);
    if (!(a > 0 && d > 0) || Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) return null;
    const codes = await sourceLineCodes(engine, x, y);
    if (!codes || codes.length < line.length || codes.length > line.length + 1 || ins.text !== ".") return null;
    const text3 = line.slice(0, keep) + ins.text, tp = M._malloc(text3.length * 4), pp = M._malloc(keep * 4);
    try {
      for (let i = 0; i < keep; i++) M.HEAPU32[(tp >> 2) + i] = codes[i];
      M.HEAPU32[(tp >> 2) + keep] = 46;
      for (let i = 1; i <= keep; i++) M.HEAPF32[(pp >> 2) + i - 1] = (before[i].x - before[0].x) / a;
      if (!M._FPDFText_SetCharcodes(h, tp, text3.length) || !M._FPDFText_SetPositions(h, pp, keep)) throw new LineRetentionError("geometric_prefix_write_failed");
    } finally {
      M._free(tp);
      M._free(pp);
    }
    engine._pageDirty = true;
    engine._spliceOk = false;
    const after = read();
    if (after.length !== text3.length || after.some((g, i) => g.h !== h || g.u !== text3.charCodeAt(i) || Math.abs(g.x - before[i].x) > 0.02 || Math.abs(g.y - before[i].y) > 0.02 || i < keep && g.box.some((v, k) => Math.abs(v - before[i].box[k]) > 0.02))) throw new LineRetentionError("geometric_prefix_proof_failed");
    return { upd: { id: para.id, surgical: true, lines: lines2 }, lines: { status: "geometric_prefix", keptGlyphs: keep } };
  } finally {
    M._free(buf);
  }
}
function removeGeometricFirstLine(engine, para, del, inserts) {
  const M = engine.M, lines2 = para.lines || [];
  if (inserts.length || lines2.length < 2 || typeof M?._FPDFPage_RemoveObject !== "function" || typeof M._FPDFPageObj_Destroy !== "function" || typeof engine.retainDetachedObject !== "function") return false;
  const flat = para.runs.map((r) => r.text).join(""), end = lines2[1].off, line = flat.slice(0, end), visible = line.replace(/\s+$/, "");
  if (!visible || !/^\s*$/.test(line.slice(visible.length))) return false;
  const offsets = [];
  let n = 0;
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++, n++) if (del.has(ri + ":" + o)) offsets.push(n);
  });
  if (offsets.length !== visible.length || offsets.some((v, i) => v !== i)) return false;
  const handles = new Set((engine.paragraphObjects(para.id) || []).map((h2) => h2 >>> 0)), buf = M._malloc(16), tp = M._FPDFText_LoadPage(engine.page), rows = [], other = [];
  if (!tp) {
    M._free(buf);
    return false;
  }
  try {
    for (let i = 0; i < M._FPDFText_CountChars(tp); i++) {
      const h2 = M._FPDFText_GetTextObject(tp, i) >>> 0;
      if (!handles.has(h2) || !M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
      const y = M.HEAPF64[buf + 8 >> 3];
      if (Math.abs(y - lines2[0].y) <= 0.5) rows.push({ h: h2, u: M._FPDFText_GetUnicode(tp, i) });
      else other.push(h2);
    }
  } finally {
    M._FPDFText_ClosePage(tp);
    M._free(buf);
  }
  if (rows.length !== visible.length || other.includes(rows[0]?.h) || rows.some((g, i) => g.h !== rows[0]?.h || g.u !== visible.charCodeAt(i))) return false;
  const h = rows[0].h, before = pageObjectList(engine);
  if (!M._FPDFPage_RemoveObject(engine.page, h)) throw new LineRetentionError("geometric_remove_failed");
  engine.retainDetachedObject(h);
  engine._pageDirty = true;
  engine._spliceOk = false;
  const after = pageObjectList(engine);
  if (before.filter((x) => x !== h).join(",") !== after.join(",")) throw new LineRetentionError("geometric_remove_proof_failed");
  return true;
}
function sourceLinePlan(para, del, inserts) {
  const lines2 = para.lines || [];
  if (!lines2.length || lines2.some((l) => !Number.isFinite(l?.y) || !Number.isFinite(l?.x) || !Number.isInteger(l?.off))) return null;
  const runStart = [];
  const flat = [];
  para.runs.forEach((r, ri) => {
    runStart.push(flat.length);
    for (let o = 0; o < r.text.length; o++) flat.push({ ri, o, ch: r.text[o] });
  });
  const starts = lines2.map((l) => l.off);
  for (let k = 1; k < starts.length; k++) if (!(starts[k] > starts[k - 1]) || starts[k] > flat.length) return { reason: "line_offsets_invalid" };
  const lineOf = (f) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= f) k++;
    return k;
  };
  const breaks = /* @__PURE__ */ new Set();
  for (let k = 1; k < starts.length; k++) {
    const c = flat[starts[k] - 1];
    if (c.ch === "\n") continue;
    if (!/\s/.test(c.ch)) return { reason: "break_inside_word" };
    if (del.has(c.ri + ":" + c.o)) return { reason: "edit_crosses_line" };
    breaks.add(c.ri + ":" + c.o);
  }
  const edited = /* @__PURE__ */ new Set();
  for (const key3 of del) {
    const [ri, o] = key3.split(":").map(Number);
    edited.add(lineOf(runStart[ri] + o));
  }
  for (const ins of inserts) {
    const f = runStart[ins.ri] + ins.o;
    edited.add(lineOf(f));
    if (f > 0) edited.add(lineOf(f - 1));
  }
  return { breaks, edited };
}
var ENGINE_FNS = ["previewParagraph", "historyBeginStep", "historyEndStep", "historyUndo", "paragraphObjects", "objectBounds", "translateObject"];
var TEXT_FNS = ["_FPDFPage_CountObjects", "_FPDFPage_GetObject", "_FPDFText_LoadPage", "_FPDFText_CountChars", "_FPDFText_GetUnicode", "_FPDFText_GetCharOrigin", "_FPDFText_GetTextObject", "_FPDFText_GetFontSize", "_FPDFText_GetFontInfo", "_FPDFText_ClosePage"];
function canRetainLines(engine) {
  return ENGINE_FNS.every((f) => typeof engine?.[f] === "function") && TEXT_FNS.every((f) => typeof engine?.M?.[f] === "function");
}
function lineGlyphs(engine, handles, lines2) {
  const M = engine.M;
  const own = new Set(handles.map((h) => h >>> 0));
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const buf = M._malloc(192);
  const matrix = typeof M._FPDFText_GetMatrix === "function";
  const out = lines2.map(() => []);
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
    if (u <= 32 || !own.has(h)) continue;
    if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
    const x = M.HEAPF64[buf >> 3], y = M.HEAPF64[buf + 8 >> 3];
    const len = M._FPDFText_GetFontInfo(tp, i, buf + 16, 128, buf + 144);
    const font = len > 0 && len <= 128 ? M.UTF8ToString(buf + 16, 128) : null;
    const size3 = M._FPDFText_GetFontSize(tp, i);
    let aspect = null;
    if (matrix && M._FPDFText_GetMatrix(tp, i, buf + 160)) {
      const [a, b, c, d] = [0, 1, 2, 3].map((j) => M.HEAPF32[(buf + 160 >> 2) + j]);
      if (a > 0 && d > 0 && Math.abs(b) <= ASPECT_TOL * d && Math.abs(c) <= ASPECT_TOL * d) aspect = a / d;
    }
    let k = -1, best = Infinity;
    lines2.forEach((l, j) => {
      const d = Math.abs(l.y - y);
      if (d < best) [k, best] = [j, d];
    });
    if (k >= 0 && best <= Math.max(0.5, 0.3 * size3)) out[k].push({ u, x, y, font, size: size3, aspect, h });
  }
  M._free(buf);
  if (tp) M._FPDFText_ClosePage(tp);
  for (const g of out) g.sort((a, b) => a.x - b.x);
  return out;
}
function alignLines(engine, id2, committed, source2, edited) {
  const groups = committed.map(() => []);
  for (const h of (engine.paragraphObjects(id2) || []).map((x) => x >>> 0)) {
    const b = engine.objectBounds(h);
    if (!b) return false;
    const hits2 = committed.map((l, k) => l.y >= b.y - 0.5 && l.y <= b.y + b.h + 0.5 ? k : -1).filter((k) => k >= 0);
    if (hits2.length !== 1) return false;
    groups[hits2[0]].push(h);
  }
  committed.forEach((l, k) => {
    const dx = edited.has(k) ? 0 : source2[k].x - l.x;
    const dy = source2[k].y - l.y;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return;
    for (const h of groups[k]) engine.translateObject(h, dx, dy);
  });
  return true;
}
var KEPT_LINE_TOL = 0.02;
var ASPECT_TOL = 1e-3;
function keptLinesMatch(before, after, edited, source2) {
  let max = 0;
  for (let k = 0; k < before.length; k++) {
    const a = after[k];
    if (edited.has(k)) {
      if (a.some((g) => Math.abs(g.y - source2[k].y) > KEPT_LINE_TOL)) return { ok: false };
      continue;
    }
    const b = before[k];
    if (!b.length || a.length !== b.length) return { ok: false };
    for (let i = 0; i < b.length; i++) {
      const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
      if (a[i].u !== b[i].u || a[i].font !== b[i].font || Math.abs(a[i].size - b[i].size) > 0.01 || d > KEPT_LINE_TOL) return { ok: false };
      max = Math.max(max, d);
    }
  }
  return { ok: true, max };
}
function objectState(engine, id2) {
  const M = engine.M;
  const page = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) page.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return page.join(",") + "|" + (engine.paragraphObjects(id2) || []).map((h) => h >>> 0).join(",");
}
var LineRetentionError = class extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail) this.detail = detail;
  }
};
function commitRetainingLines(engine, para, runs, linePlan) {
  const source2 = para.lines || [];
  const sameCount = (u) => (u?.lines?.length ?? -1) === source2.length;
  if (!linePlan?.breaks || !canRetainLines(engine)) {
    const upd2 = engine.commitParagraph(para.id, runs, para.format);
    if (!linePlan || !upd2 || upd2.surgical || !sameCount(upd2)) return { upd: upd2, lines: null };
    return { upd: upd2, lines: { status: "reflowed", reason: linePlan.reason ?? "engine_capability_missing" } };
  }
  const { breaks, edited, lineRuns: lineRuns2 } = linePlan;
  const step = (id2, r) => {
    engine.historyBeginStep("falsify-inline-edit");
    try {
      return engine.commitParagraph(id2, r, para.format);
    } finally {
      engine.historyEndStep();
    }
  };
  const state = objectState(engine, para.id);
  const undo = () => {
    if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    if (objectState(engine, para.id) !== state) throw new LineRetentionError("state_drift");
    return para.id;
  };
  const fits = breaks.size ? engine.previewParagraph(para.id, lineRuns2, para.format)?.lines?.length === source2.length : true;
  const before = lineGlyphs(engine, engine.paragraphObjects(para.id) || [], source2);
  const upd = step(para.id, runs);
  if (!upd || upd.surgical) return { upd, lines: upd ? { status: "surgical" } : null };
  if (!fits || !breaks.size && !sameCount(upd)) return { upd, lines: { status: "reflowed", reason: sameCount(upd) ? "edited_line_overflows" : "line_count_changed" } };
  let cur = upd;
  if (breaks.size) {
    cur = step(undo(), lineRuns2);
    if (!cur) throw new LineRetentionError("commit_failed");
  }
  let reason = null;
  if (sameCount(cur)) {
    reason = "lines_not_aligned";
    const id2 = cur.id ?? para.id;
    if (alignLines(engine, id2, cur.lines, source2, edited)) {
      const proof = keptLinesMatch(before, lineGlyphs(engine, engine.paragraphObjects(id2) || [], source2), edited, source2);
      if (proof.ok) return { upd: cur, lines: { status: "retained", lines: source2.length, kept: source2.length - edited.size, hardBreaks: breaks.size, maxKeptShift: +proof.max.toFixed(4) } };
      reason = "kept_lines_moved";
    }
  }
  const again = step(undo(), runs);
  reason ??= sameCount(again) ? "edited_line_overflows" : "line_count_changed";
  return { upd: again, lines: again ? { status: "reflowed", reason } : null };
}
var LOCAL_FNS = ["historyNoteMatrix", "historyNoteZOrder", "historyDepth", "buildModel", "resizeParagraph"];
var LOCAL_M = ["_FPDFPage_RemoveObject", "_FPDFPage_InsertObjectAtIndex", "_FPDFPageObj_GetType", "_FPDFText_GetMatrix"];
var LOCAL_JUSTIFY = Object.freeze({ min: 0.12, max: 0.6 });
var WIDTH_TOL = 0.1;
var PLACE_TOL = 0.1;
var OBJ_TEXT4 = 1;
function canCommitLineLocal(engine) {
  return canRetainLines(engine) && LOCAL_FNS.every((f) => typeof engine?.[f] === "function") && LOCAL_M.every((f) => typeof engine?.M?.[f] === "function");
}
function pageObjectList(engine) {
  const M = engine.M;
  const out = [];
  const n = M._FPDFPage_CountObjects(engine.page);
  for (let i = 0; i < n; i++) out.push(M._FPDFPage_GetObject(engine.page, i) >>> 0);
  return out;
}
var textOf3 = (p) => p.runs.map((r) => r.text).join("");
var squash = (s) => s.replace(/\s+/g, " ").trim();
var baseStyle = (r) => runStyleKey({ ...r, hScale: 1 });
var paraKey = (p) => (p.box ? [p.box.x, p.box.top, p.box.w, p.box.h].map((v) => Math.round(v * 100)).join(",") : "-") + "|" + textOf3(p);
function editedLineSpan(para, del, inserts, allowMultiple = false) {
  const lines2 = para.lines || [];
  if (!lines2.length || lines2.some((l) => !Number.isFinite(l?.y) || !Number.isFinite(l?.x) || !Number.isFinite(l?.w) || !Number.isInteger(l?.off))) return null;
  const runStart = [];
  let n = 0;
  for (const r of para.runs) {
    runStart.push(n);
    n += r.text.length;
  }
  const starts = lines2.map((l) => l.off);
  if (starts[0] !== 0) return { reason: "line_offsets_invalid" };
  for (let k2 = 1; k2 < starts.length; k2++) if (!(starts[k2] > starts[k2 - 1]) || starts[k2] > n) return { reason: "line_offsets_invalid" };
  const lineOf = (f) => {
    let k2 = 0;
    while (k2 + 1 < starts.length && starts[k2 + 1] <= f) k2++;
    return k2;
  };
  const delAt = [...del].map((key3) => {
    const [ri, o] = key3.split(":").map(Number);
    return runStart[ri] + o;
  });
  const insAt = inserts.map((ins) => runStart[ins.ri] + ins.o);
  const touched = new Set(delAt.map(lineOf));
  for (const f of insAt) {
    touched.add(lineOf(f));
    if (f > 0) touched.add(lineOf(f - 1));
  }
  if (!touched.size || !allowMultiple && touched.size !== 1) return { reason: "edit_spans_lines" };
  const k = Math.min(...touched);
  const flat = textOf3(para);
  const start = starts[k];
  let end = k + 1 < starts.length ? starts[k + 1] : n;
  while (end > start && /\s/.test(flat[end - 1])) end--;
  if (end === start || !allowMultiple && (delAt.some((f) => f >= end) || insAt.some((f) => f > end))) return { reason: "edit_crosses_line" };
  return { k, start, end };
}
function lineRuns(para, q, span, del, inserts, scale) {
  const { start, end } = span;
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  const runs = [];
  let r0 = 0;
  para.runs.forEach((r, ri) => {
    let t = "";
    let first = -1;
    for (let o = 0; o <= r.text.length; o++) {
      const f = r0 + o;
      if (f < start || f > end) continue;
      for (const ins of inserts) if (ins.ri === ri && ins.o === o) t += ins.text;
      if (o < r.text.length && f < end) {
        if (first < 0) first = f;
        if (!del.has(ri + ":" + o)) t += r.text[o];
      }
    }
    const at = first >= 0 ? first : Math.min(r0 + r.text.length, end) - 1;
    r0 += r.text.length;
    if (!t) return;
    const qi = qRun[Math.min(Math.max(at - start, 0), qRun.length - 1)];
    const src = q.runs[qi];
    const hScale = Math.abs((src.hScale ?? 1) - 1) < 1e-3 ? scale : src.hScale;
    runs.push({ ...src, text: t, rgba: src.rgba >>> 0, sourceIndex: qi, hScale });
  });
  return runs;
}
function commitLineLocal(engine, paras, pi, del, inserts, changed = /* @__PURE__ */ new Set()) {
  if (!canCommitLineLocal(engine)) return { reason: "engine_capability_missing" };
  const para = paras[pi];
  const fmt2 = para.format || {};
  if (![0, 3].includes(fmt2.align ?? 0) || fmt2.dir || para.rotation || para.vertical) return { reason: "alignment_unsupported" };
  const span = editedLineSpan(para, del, inserts);
  if (!span || span.reason) return { reason: span?.reason ?? "line_geometry_missing" };
  const { k, start, end } = span;
  const source2 = para.lines;
  const M = engine.M;
  const handles = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
  const before = lineGlyphs(engine, handles, source2);
  if (!before[k].length) return { reason: "line_objects_unresolved" };
  const linesOf = /* @__PURE__ */ new Map();
  before.forEach((g, j) => g.forEach((c) => linesOf.set(c.h, (linesOf.get(c.h) || /* @__PURE__ */ new Set()).add(j))));
  const em = Math.max(...before[k].map((c) => c.size));
  const band = { lo: source2[k].y - 0.4 * em, hi: source2[k].y + em };
  const own = [];
  for (const h of handles) {
    const on = linesOf.get(h);
    if (on) {
      if (!on.has(k)) continue;
      if (on.size !== 1 || M._FPDFPageObj_GetType(h) !== OBJ_TEXT4) return { reason: "line_objects_unresolved" };
      own.push(h);
      continue;
    }
    const b = engine.objectBounds(h);
    if (!b) return { reason: "line_objects_unresolved" };
    if (b.y <= band.hi && b.y + b.h >= band.lo) return { reason: "line_decoration_present" };
  }
  const pageBefore = pageObjectList(engine);
  const slots = own.map((h) => pageBefore.indexOf(h)).sort((a, b) => a - b);
  if (!own.length || slots[0] < 0 || slots.some((s, i) => s !== slots[0] + i)) return { reason: "line_objects_interleaved" };
  const anchor = slots[0] > 0 ? pageBefore[slots[0] - 1] : null;
  const ownSet = new Set(own);
  const ownBounds = own.map((h) => JSON.stringify(engine.objectBounds(h)));
  const scales = before[k].map((g) => g.aspect);
  if (!scales.length || !scales.every(Number.isFinite)) return { reason: "line_aspect_unsupported" };
  const scale = [...scales].sort((a, b) => a - b)[scales.length >> 1];
  if (scales.some((v) => Math.abs(v - scale) > ASPECT_TOL)) return { reason: "line_aspect_mixed" };
  let steps = 0;
  const step = (label, fn) => {
    const depth = engine.historyDepth().undo;
    engine.historyBeginStep(label);
    try {
      return fn();
    } finally {
      engine.historyEndStep();
      if (engine.historyDepth().undo > depth) steps++;
    }
  };
  const restore = (reason) => {
    for (; steps > 0; steps--) if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    const back = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
    if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects" });
    if (back.join(",") !== handles.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
    if (own.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== ownBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "line_bounds" });
    return { reason };
  };
  const top = Math.max(...own.map((h) => {
    const b = engine.objectBounds(h);
    return b.y + b.h;
  }));
  const away = -(top + 200);
  step("falsify-line-isolate", () => {
    for (const h of own) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, 0, away);
    }
  });
  if (steps !== 1) {
    for (const h of own) engine.translateObject(h, 0, -away);
    return restore("history_unavailable");
  }
  const iso = engine.buildModel();
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "line_isolate", part: "page_objects_rebuilt" });
  const mine = iso.filter((q2) => (engine.paragraphObjects(q2.id) || []).some((h) => ownSet.has(h >>> 0)));
  if (mine.length !== 1) return restore("line_not_isolated");
  const q = mine[0];
  const qh = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
  if (qh.length !== own.length || qh.some((h) => !ownSet.has(h)) || !q.editable || q.lines?.length !== 1) return restore("line_not_isolated");
  const flat = textOf3(para);
  const lineText = flat.slice(start, end);
  if (textOf3(q).replace(/\s+$/, "") !== lineText) return restore("isolated_text_mismatch");
  const pRun = [];
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) pRun.push(ri);
  });
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  for (let j = 0; j < lineText.length; j++) {
    if (baseStyle(q.runs[qRun[j]]) !== baseStyle(para.runs[pRun[start + j]])) return restore("isolated_style_mismatch");
  }
  const runs = lineRuns(para, q, span, del, inserts, scale);
  const newLine = runs.map((r) => r.text).join("");
  const right = Math.max(...source2.map((l) => l.x + l.w), para.box ? para.box.x + para.box.w : -Infinity);
  const justify = fmt2.align === 3 && k < source2.length - 1 && source2[k].x + source2[k].w >= Math.max(...source2.map((l) => l.x + l.w)) - 1;
  const target = justify ? source2[k].w : right - source2[k].x;
  let id2 = q.id;
  if (!(q.box?.w >= target + 1)) {
    const rz = step("falsify-line-width", () => engine.resizeParagraph(id2, target + 2));
    if (!rz) return restore("line_not_isolated");
    id2 = rz.id ?? id2;
  }
  const qfmt = { ...q.format, align: 0, wordSpacing: 0 };
  if (engine.previewParagraph(id2, runs, qfmt)?.lines?.length !== 1) return restore("edited_line_wraps");
  const commit = (ws3) => {
    const u = step("falsify-line-local", () => engine.commitParagraph(id2, runs, { ...qfmt, wordSpacing: ws3 }));
    return u?.lines?.length === 1 && ["x", "y", "w"].every((f) => Number.isFinite(u.lines[0][f])) ? u : null;
  };
  const recommit = (ws3) => {
    if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    steps--;
    return commit(ws3);
  };
  let upd = commit(0);
  if (!upd) return restore("edited_line_wraps");
  const w0 = upd.lines[0].w;
  const spaces = (newLine.match(/ /g) || []).length;
  const size3 = Math.max(...runs.map((r) => r.size || 0)) || 10;
  let ws2 = 0;
  let justified = false;
  if (justify && spaces) {
    if (w0 > target + WIDTH_TOL) return restore("edited_line_too_wide");
    const slope = spaces * scale;
    ws2 = (target - w0) / slope || 1e-3;
    for (let i = 0; i < 3; i++) {
      upd = recommit(ws2);
      if (!upd || Math.abs(upd.lines[0].w - target) <= WIDTH_TOL) break;
      ws2 += (target - upd.lines[0].w) / slope;
    }
    if (!upd || Math.abs(upd.lines[0].w - target) > WIDTH_TOL) return restore("justification_unverified");
    const cx = engine.previewParagraph(upd.id ?? id2, runs, { ...qfmt, wordSpacing: ws2 })?.lines?.[0]?.cx;
    if (!Array.isArray(cx) || cx.length < newLine.length) return restore("justification_unverified");
    for (let j = 0; j + 1 < newLine.length; j++) {
      if (newLine[j] !== " ") continue;
      const gap = cx[j + 1] - cx[j];
      if (!(gap >= LOCAL_JUSTIFY.min * size3 && gap <= LOCAL_JUSTIFY.max * size3)) return restore(gap <= LOCAL_JUSTIFY.min * size3 ? "edited_line_too_wide" : "justification_out_of_range");
    }
    justified = true;
  } else if (w0 > target + WIDTH_TOL) {
    return restore("edited_line_too_wide");
  }
  const fresh = (engine.paragraphObjects(upd.id ?? id2) || []).map((h) => h >>> 0);
  if (!fresh.length) return restore("line_objects_unresolved");
  const dx = source2[k].x - upd.lines[0].x;
  const dy = source2[k].y - upd.lines[0].y;
  let placed = true;
  step("falsify-line-place", () => {
    for (const h of fresh) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, dx, dy);
    }
    const cur = pageObjectList(engine);
    let at = anchor === null ? 0 : cur.indexOf(anchor) + 1;
    if (anchor !== null && at === 0) placed = false;
    for (const h of [...fresh].sort((a, b) => cur.indexOf(a) - cur.indexOf(b))) {
      if (!placed) break;
      engine.historyNoteZOrder(h);
      if (!M._FPDFPage_RemoveObject(engine.page, h)) placed = false;
      else if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, at++)) {
        M._FPDFPage_InsertObject?.(engine.page, h);
        placed = false;
      }
    }
  });
  if (!placed) return restore("line_order_not_restored");
  const after = engine.buildModel();
  if (after.length !== paras.length || after.some((p, j) => j !== pi && !changed.has(j) && paraKey(p) !== paraKey(paras[j]))) return restore("page_model_changed");
  const now = after[pi];
  if (squash(textOf3(now)) !== squash(flat.slice(0, start) + newLine + flat.slice(end))) return restore("edited_text_mismatch");
  if (now.lines?.length !== source2.length) return restore("line_count_changed");
  const nowHandles = (engine.paragraphObjects(now.id) || []).map((h) => h >>> 0);
  const want = /* @__PURE__ */ new Set([...handles.filter((h) => !ownSet.has(h)), ...fresh]);
  if (nowHandles.length !== want.size || nowHandles.some((h) => !want.has(h))) return restore("paragraph_objects_changed");
  const got = lineGlyphs(engine, nowHandles, source2);
  const proof = keptLinesMatch(before, got, /* @__PURE__ */ new Set([k]), source2);
  if (!proof.ok) return restore("kept_lines_moved");
  if (!got[k].length || got[k].some((g) => !Number.isFinite(g.aspect) || Math.abs(g.aspect - scale) > ASPECT_TOL)) return restore("edited_line_aspect_changed");
  const line = now.lines[k];
  if (Math.abs(line.x - source2[k].x) > PLACE_TOL || line.x + line.w > right + 0.5) return restore("edited_line_misplaced");
  if (justified && Math.abs(line.x + line.w - (source2[k].x + source2[k].w)) > 0.5) return restore("justification_unverified");
  return {
    upd: { ...now, surgical: false },
    ids: after.map((p) => p.id),
    lines: {
      status: "line_local",
      line: k,
      lines: source2.length,
      kept: source2.length - 1,
      justified,
      wordSpacing: +ws2.toFixed(4),
      hScale: +scale.toFixed(4),
      maxKeptShift: +proof.max.toFixed(4)
    }
  };
}
var OVERFLOW_REASONS = /* @__PURE__ */ new Set(["edited_line_wraps", "edited_line_too_wide"]);
function sliceRuns(runs, from) {
  const out = [];
  let n = 0;
  for (const r of runs) {
    const a = Math.max(0, from - n);
    n += r.text.length;
    if (a >= r.text.length) continue;
    const text3 = r.text.slice(a);
    if (text3) out.push({ ...r, text: text3 });
  }
  return out;
}
var lettersOf = (s) => s.replace(/\s+/g, "");
var DRAWN_TOL = 0.02;
var drawnSize = (g) => {
  if (!Number.isFinite(g?.size) || !(g.size > 0)) return null;
  if (!Number.isFinite(g?.vd) || !(g.vd > 0)) return null;
  if (!Number.isFinite(g?.aspect)) return null;
  return g.size * g.vd;
};
function collectGlyphs(engine, handles) {
  const M = engine.M;
  const own = new Set(handles.map((h) => h >>> 0));
  const tp = M._FPDFText_LoadPage(engine.page);
  const n = tp ? M._FPDFText_CountChars(tp) : 0;
  const buf = M._malloc(192);
  const matrix = typeof M._FPDFText_GetMatrix === "function";
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = M._FPDFText_GetUnicode(tp, i);
    const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
    if (u < 32 || !own.has(h)) continue;
    if (!M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) continue;
    const x = M.HEAPF64[buf >> 3], y = M.HEAPF64[buf + 8 >> 3];
    const len = M._FPDFText_GetFontInfo(tp, i, buf + 16, 128, buf + 144);
    const font = len > 0 && len <= 128 ? M.UTF8ToString(buf + 16, 128) : null;
    const size3 = M._FPDFText_GetFontSize(tp, i);
    let aspect = null;
    let vd = null;
    if (matrix && M._FPDFText_GetMatrix(tp, i, buf + 160)) {
      const [a, b, c, d] = [0, 1, 2, 3].map((j) => M.HEAPF32[(buf + 160 >> 2) + j]);
      vd = d;
      if (a > 0 && d > 0 && Math.abs(b) <= ASPECT_TOL * d && Math.abs(c) <= ASPECT_TOL * d) aspect = a / d;
    }
    out.push({ u, x, y, font, size: size3, aspect, vd, h });
  }
  M._free(buf);
  if (tp) M._FPDFText_ClosePage(tp);
  out.sort((a, b) => a.y - b.y || a.x - b.x || a.u - b.u || a.h - b.h);
  return out;
}
function sameGlyphs2(a, b) {
  if (a.length !== b.length) return { ok: false, max: Infinity };
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y));
    max = Math.max(max, d);
    if (a[i].u !== b[i].u || a[i].h !== b[i].h || a[i].font !== b[i].font || Math.abs(a[i].size - b[i].size) > 0.01 || d > KEPT_LINE_TOL) return { ok: false, max };
    const aspect = Number.isFinite(a[i].aspect) || Number.isFinite(b[i].aspect);
    if (aspect && !(Number.isFinite(a[i].aspect) && Number.isFinite(b[i].aspect) && Math.abs(a[i].aspect - b[i].aspect) <= ASPECT_TOL)) return { ok: false, max };
  }
  return { ok: true, max };
}
function splitSourceOwnership(context2, index, suffix, stable, fresh) {
  const target = context2.paras[index];
  const shadowId = Math.min(0, ...context2.paras.map((q) => Number.isInteger(q.id) ? q.id : 0)) - 1;
  const slotsOf = (hs) => hs.map((h) => context2.objects.indexOf(h)).sort((a, b) => a - b);
  const suffixSlots = slotsOf(suffix), stableSlots = slotsOf(stable);
  if (!target || !suffix.length || !stable.length || suffixSlots.some((i) => i < 0) || stableSlots.some((i) => i < 0) || (/* @__PURE__ */ new Set([...suffix, ...stable])).size !== suffix.length + stable.length || target.handles.length !== suffix.length + stable.length || target.handles.some((h) => !suffix.includes(h) && !stable.includes(h)) || new Set(fresh).size !== fresh.length || fresh.some((h) => stable.includes(h) || context2.objects.includes(h)) || suffixSlots.some((n, i) => i && n !== suffixSlots[i - 1] + 1)) return null;
  const split = { ...context2, paras: context2.paras.map((q, j) => j === index ? { ...q, handles: suffix, slots: suffixSlots, topLevel: true } : q) };
  split.paras.push({ ...target, id: shadowId, box: null, handles: stable, slots: stableSlots, topLevel: true });
  const ownership = new Map(split.paras.map((q, j) => [q.id, j === index ? fresh : q.handles]));
  return { context: split, ownership };
}
function sourceDiscretionaryHyphens(engine, context2, glyphs2) {
  const M = engine.M;
  if (typeof M._FPDFText_IsHyphen !== "function") return null;
  const owned = new Set(context2.paras.flatMap((q) => q.handles));
  const page = new Set(pageObjectList(engine));
  const tp = M._FPDFText_LoadPage(engine.page), buf = M._malloc(16);
  if (!tp) {
    M._free(buf);
    return null;
  }
  const objects = /* @__PURE__ */ new Map();
  for (let i = 0, n = M._FPDFText_CountChars(tp); i < n; i++) {
    const h = M._FPDFText_GetTextObject(tp, i) >>> 0;
    if (!h || owned.has(h) || !page.has(h)) continue;
    const row = objects.get(h) || [];
    let origin = null;
    if (M._FPDFText_GetCharOrigin(tp, i, buf, buf + 8)) origin = [M.HEAPF64[buf >> 3], M.HEAPF64[buf + 8 >> 3]];
    row.push({ hyphen: M._FPDFText_IsHyphen(tp, i) === 1, origin });
    objects.set(h, row);
  }
  M._free(buf);
  M._FPDFText_ClosePage(tp);
  const result = [];
  for (const [h, rows] of objects) {
    if (!rows.some((r) => r.hyphen)) continue;
    if (rows.length !== 1 || !rows[0].hyphen || !rows[0].origin) return null;
    const [x, y] = rows[0].origin;
    const candidates = [];
    for (let j = 0; j < context2.paras.length; j++) {
      const nearby = glyphs2[j].filter((g) => g.u > 32 && Math.abs(g.y - y) <= 0.2 && g.x < x && x - g.x <= Math.max(2, drawnSize(g) * 1.5));
      if (nearby.length) candidates.push(j);
    }
    if (candidates.length !== 1) return null;
    const bounds = engine.objectBounds(h);
    if (!bounds) return null;
    result.push({ h, owner: context2.paras[candidates[0]].id, bounds, originY: y });
  }
  return result;
}
function commitPrefixSuffix(engine, paras, pi, del, inserts, runs, changed = /* @__PURE__ */ new Set(), options = {}) {
  if (!canCommitLineLocal(engine)) return { reason: "engine_capability_missing" };
  if (options.context && typeof options.reserve !== "function") return { reason: "reserve_unavailable" };
  const para = paras[pi];
  const fmt2 = para.format || {};
  if (![0, 3].includes(fmt2.align ?? 0) || fmt2.dir || para.rotation || para.vertical) return { reason: "alignment_unsupported" };
  const span = editedLineSpan(para, del, inserts, !!options.allowMultiple);
  if (!span || span.reason) return { reason: span?.reason ?? "line_geometry_missing" };
  const { k, start } = span;
  if (k === 0) return { reason: "no_prefix" };
  const source2 = para.lines;
  const M = engine.M;
  const handles = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
  const before = lineGlyphs(engine, handles, source2);
  if (before.slice(0, k).some((g) => !g.length) || before.slice(k).some((g) => !g.length)) return { reason: "prefix_objects_unresolved" };
  const linesOf = /* @__PURE__ */ new Map();
  before.forEach((g, j) => g.forEach((c) => {
    const on = linesOf.get(c.h) || /* @__PURE__ */ new Set();
    on.add(j);
    linesOf.set(c.h, on);
  }));
  const prefix = [];
  const suffix = [];
  for (const h of handles) {
    const on = linesOf.get(h);
    if (on) {
      const lines2 = [...on];
      const inPrefix = lines2.some((j) => j < k);
      const inSuffix = lines2.some((j) => j >= k);
      if (inPrefix && inSuffix) return { reason: "prefix_objects_span_suffix" };
      if (on.size !== 1 || M._FPDFPageObj_GetType(h) !== OBJ_TEXT4) return { reason: inPrefix ? "prefix_objects_unresolved" : "suffix_objects_unresolved" };
      (inPrefix ? prefix : suffix).push(h);
      continue;
    }
    const b2 = engine.objectBounds(h);
    if (!b2) return { reason: "line_objects_unresolved" };
    for (let j = k; j < source2.length; j++) {
      const em = Math.max(...before[j].map((c) => c.size));
      if (b2.y <= source2[j].y + em && b2.y + b2.h >= source2[j].y - 0.4 * em) return { reason: "line_decoration_present" };
    }
  }
  if (!prefix.length || !suffix.length) return { reason: "prefix_objects_unresolved" };
  const pageBefore = pageObjectList(engine);
  const slots = suffix.map((h) => pageBefore.indexOf(h)).sort((a2, b2) => a2 - b2);
  if (slots[0] < 0 || slots.some((s, i) => s !== slots[0] + i)) return { reason: "suffix_objects_interleaved" };
  const anchor = slots[0] > 0 ? pageBefore[slots[0] - 1] : null;
  const suffixOrdered = slots.map((s) => pageBefore[s]);
  const suffixSet = new Set(suffixOrdered);
  const rights = source2.map((l) => l.x + l.w).filter(Number.isFinite);
  if (para.box && Number.isFinite(para.box.x) && Number.isFinite(para.box.w)) rights.push(para.box.x + para.box.w);
  const right = Math.max(...rights);
  const width = right - source2[k].x;
  if (!(width > 1)) return { reason: "suffix_width_unknown" };
  const prefixBounds = prefix.map((h) => JSON.stringify(engine.objectBounds(h)));
  const suffixBounds = suffixOrdered.map((h) => JSON.stringify(engine.objectBounds(h)));
  const prefixGlyphs = collectGlyphs(engine, prefix);
  const suffixGlyphs = collectGlyphs(engine, suffixOrdered);
  const otherGlyphs = options.context?.paras.map((q2) => collectGlyphs(engine, q2.handles || []));
  const hyphens = options.context ? sourceDiscretionaryHyphens(engine, options.context, otherGlyphs) : [];
  if (!hyphens) return { reason: "discretionary_hyphen_ambiguous" };
  if (options.context) {
    const suffixY = source2.slice(k).map((l) => l.y);
    if (hyphens.some((h) => h.owner === para.id && suffixY.some((y) => Math.abs(h.originY - y) <= 0.2)))
      return { reason: "suffix_discretionary_hyphen" };
  }
  const onEdited = suffixGlyphs.filter((g) => g.u > 32 && Math.abs(g.y - source2[k].y) <= 1);
  if (!prefixGlyphs.length || !onEdited.length) return { reason: "prefix_objects_unresolved" };
  if (onEdited.some((g) => drawnSize(g) == null)) return { reason: "suffix_matrix_unavailable" };
  const prior = /* @__PURE__ */ new Map();
  for (const j of changed) {
    if (j === pi) continue;
    const handles2 = (engine.paragraphObjects(paras[j].id) || []).map((h) => h >>> 0).sort((a2, b2) => a2 - b2);
    const glyphs2 = collectGlyphs(engine, handles2);
    if (!handles2.length || !glyphs2.length) return { reason: "page_model_changed" };
    prior.set(j, { handles: handles2, glyphs: glyphs2 });
  }
  const srcSizes = onEdited.map(drawnSize);
  const srcSize = [...srcSizes].sort((a2, b2) => a2 - b2)[srcSizes.length >> 1];
  const flat = textOf3(para);
  const fullNew = runs.map((r) => r.text).join("");
  const suffixRuns = sliceRuns(runs, start);
  if (!suffixRuns.length) {
    if (!options.context || inserts.length || fullNew !== flat.slice(0, start) || typeof engine.historyRemoveObject !== "function") return { reason: "edited_text_mismatch" };
    for (let j = k; j < source2.length; j++) {
      const expected = flat.slice(source2[j].off, source2[j + 1]?.off ?? flat.length).replace(/\s/g, "");
      const actual = before[j].map((g) => String.fromCodePoint(g.u)).join("");
      if (expected !== actual) return { reason: "suffix_text_unresolved" };
    }
    const stable = handles.filter((h) => !suffixSet.has(h));
    const target = options.context.paras[pi];
    if (!stable.length || !target || target.handles.length !== handles.length || target.handles.some((h) => !handles.includes(h))) return { reason: "paragraph_objects_changed" };
    const ownership2 = new Map(options.context.paras.map((q2, j) => [q2.id, j === pi ? stable : q2.handles]));
    const depth = engine.historyDepth().undo;
    engine.historyBeginStep("falsify-delete-suffix");
    let removed = true;
    try {
      for (const h of suffixOrdered) if (!engine.historyRemoveObject(h)) {
        removed = false;
        break;
      }
    } finally {
      engine.historyEndStep();
    }
    const undo = () => {
      if (engine.historyDepth().undo > depth && !engine.historyUndo()) throw new LineRetentionError("undo_failed");
      if (pageObjectList(engine).join(",") !== pageBefore.join(",") || !sameGlyphs2(prefixGlyphs, collectGlyphs(engine, prefix)).ok || !sameGlyphs2(suffixGlyphs, collectGlyphs(engine, suffixOrdered)).ok) throw new LineRetentionError("state_drift");
    };
    const remaining = pageBefore.filter((h) => !suffixSet.has(h));
    const proof2 = sameGlyphs2(prefixGlyphs, collectGlyphs(engine, prefix));
    if (!removed || engine.historyDepth().undo <= depth || pageObjectList(engine).join(",") !== remaining.join(",") || !proof2.ok) {
      undo();
      return { reason: "suffix_deletion_unproven" };
    }
    engine._pageDirty = true;
    engine._spliceOk = false;
    return {
      upd: { ...para, runs, lines: source2.slice(0, k), surgical: true },
      ids: paras.map((p) => p.id),
      ownership: ownership2,
      context: options.context,
      reservedBaseline: source2[k - 1].y,
      lines: { status: "source_suffix_deleted", prefixKept: k, kept: k, maxKeptShift: +proof2.max.toFixed(4) }
    };
  }
  if (squash(flat.slice(0, start) + suffixRuns.map((r) => r.text).join("")) !== squash(fullNew)) return { reason: "edited_text_mismatch" };
  let steps = 0;
  let reservation = null;
  const step = (label, fn) => {
    const depth = engine.historyDepth().undo;
    engine.historyBeginStep(label);
    try {
      return fn();
    } finally {
      engine.historyEndStep();
      if (engine.historyDepth().undo > depth) steps++;
    }
  };
  const restore = (reason) => {
    if (reservation && !reservation.rollback()) throw new LineRetentionError("undo_failed", { after: reason, part: "reservation" });
    reservation = null;
    const mutated = steps > 0;
    for (; steps > 0; steps--) if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
    const back = (engine.paragraphObjects(para.id) || []).map((h) => h >>> 0);
    if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects" });
    if (back.join(",") !== handles.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
    if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "prefix_bounds" });
    if (suffixOrdered.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== suffixBounds[i])) throw new LineRetentionError("state_drift", { after: reason, part: "suffix_bounds" });
    if (!sameGlyphs2(prefixGlyphs, collectGlyphs(engine, prefix)).ok || !sameGlyphs2(suffixGlyphs, collectGlyphs(engine, suffixOrdered)).ok) {
      throw new LineRetentionError("state_drift", { after: reason, part: "glyph_restore" });
    }
    let id3 = para.id;
    let restored = null;
    if (mutated) {
      const snap = pageBefore.join(",");
      const model = engine.buildModel();
      if (pageObjectList(engine).join(",") !== snap) throw new LineRetentionError("state_drift", { after: reason, part: "page_objects_rebuilt" });
      if (!modelMatches(engine, model, paras, pi, squash(textOf3(paras[pi])), changed, prior)) {
        throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_id" });
      }
      const got2 = (engine.paragraphObjects(model[pi].id) || []).map((h) => h >>> 0).sort((a2, b2) => a2 - b2);
      const had = [...handles].sort((a2, b2) => a2 - b2);
      if (got2.join(",") !== had.join(",")) throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_objects" });
      id3 = model[pi].id;
      restored = model[pi];
    }
    return { reason, mutated, id: id3, restored, prior };
  };
  const top = Math.max(...suffixOrdered.map((h) => {
    const b2 = engine.objectBounds(h);
    return b2.y + b2.h;
  }));
  const away = -(top + 200);
  step("falsify-prefix-isolate", () => {
    for (const h of suffixOrdered) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, 0, away);
    }
  });
  if (steps !== 1) {
    for (const h of suffixOrdered) engine.translateObject(h, 0, -away);
    return restore("history_unavailable");
  }
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "prefix_isolate", part: "page_objects_rebuilt" });
  const iso = engine.buildModel();
  if (pageObjectList(engine).join(",") !== pageBefore.join(",")) throw new LineRetentionError("state_drift", { after: "prefix_isolate", part: "page_objects_rebuilt" });
  const mine = iso.filter((q2) => (engine.paragraphObjects(q2.id) || []).some((h) => suffixSet.has(h >>> 0)));
  if (mine.length !== 1) return restore("suffix_not_isolated");
  const q = mine[0];
  const qh = (engine.paragraphObjects(q.id) || []).map((h) => h >>> 0);
  if (!q.editable || qh.length !== suffixOrdered.length || qh.some((h) => !suffixSet.has(h)) || prefix.some((h) => qh.includes(h))) return restore("suffix_not_isolated");
  const suffixText = flat.slice(start);
  const qText = textOf3(q);
  if (lettersOf(qText) !== lettersOf(suffixText)) return restore("isolated_text_mismatch");
  const pRun = [];
  para.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) pRun.push(ri);
  });
  const qRun = [];
  q.runs.forEach((r, ri) => {
    for (let o = 0; o < r.text.length; o++) qRun.push(ri);
  });
  let a = 0;
  let b = 0;
  const isolatedRunOwners = /* @__PURE__ */ new Map();
  while (a < suffixText.length && b < qText.length) {
    if (/\s/.test(suffixText[a])) {
      a++;
      continue;
    }
    if (/\s/.test(qText[b])) {
      b++;
      continue;
    }
    if (suffixText[a] !== qText[b] || baseStyle(q.runs[qRun[b]]) !== baseStyle(para.runs[pRun[start + a]])) return restore(suffixText[a] !== qText[b] ? "isolated_text_mismatch" : "isolated_style_mismatch");
    const sourceIndex = pRun[start + a], owners = isolatedRunOwners.get(sourceIndex) || /* @__PURE__ */ new Set();
    owners.add(qRun[b]);
    isolatedRunOwners.set(sourceIndex, owners);
    a++;
    b++;
  }
  while (a < suffixText.length && /\s/.test(suffixText[a])) a++;
  while (b < qText.length && /\s/.test(qText[b])) b++;
  if (a !== suffixText.length || b !== qText.length) return restore("isolated_text_mismatch");
  const reboundRuns = [];
  for (const run of suffixRuns) {
    const owners = [...isolatedRunOwners.get(run.sourceIndex) || []];
    if (owners.length !== 1) return restore("isolated_font_source_ambiguous");
    reboundRuns.push({ ...run, sourceIndex: owners[0] });
  }
  let id2 = q.id;
  if (!(q.box?.w >= width - 0.5)) {
    const rz = step("falsify-prefix-width", () => engine.resizeParagraph(id2, width));
    if (!rz) return restore("suffix_not_isolated");
    id2 = rz.id ?? id2;
  }
  const upd = step("falsify-prefix-suffix", () => engine.commitParagraph(id2, reboundRuns, fmt2));
  if (!upd?.lines?.length || !["x", "y"].every((f) => Number.isFinite(upd.lines[0][f]))) return restore("suffix_commit_failed");
  if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) return restore("prefix_objects_moved");
  const fresh = (engine.paragraphObjects(upd.id ?? id2) || []).map((h) => h >>> 0);
  if (!fresh.length || fresh.some((h) => prefix.includes(h))) return restore("suffix_objects_unresolved");
  const dx = source2[k].x - upd.lines[0].x;
  const dy = source2[k].y - upd.lines[0].y;
  let placed = true;
  step("falsify-prefix-place", () => {
    for (const h of fresh) {
      engine.historyNoteMatrix(h);
      engine.translateObject(h, dx, dy);
    }
    const cur = pageObjectList(engine);
    let at = anchor === null ? 0 : cur.indexOf(anchor) + 1;
    if (anchor !== null && at === 0) placed = false;
    for (const h of [...fresh].sort((p, qh2) => cur.indexOf(p) - cur.indexOf(qh2))) {
      if (!placed) break;
      engine.historyNoteZOrder(h);
      if (!M._FPDFPage_RemoveObject(engine.page, h)) placed = false;
      else if (!M._FPDFPage_InsertObjectAtIndex(engine.page, h, at++)) {
        M._FPDFPage_InsertObject?.(engine.page, h);
        placed = false;
      }
    }
  });
  if (!placed) return restore("line_order_not_restored");
  if (prefix.some((h, i) => JSON.stringify(engine.objectBounds(h)) !== prefixBounds[i])) return restore("prefix_objects_moved");
  const sourceContext = options.context && { ...options.context, paras: options.context.paras.map((q2) => {
    const added = hyphens.filter((h) => h.owner === q2.id).map((h) => h.h);
    const handles2 = [...q2.handles, ...added];
    const slots2 = handles2.map((h) => options.context.objects.indexOf(h)).filter((i) => i >= 0).sort((a2, b2) => a2 - b2);
    return { ...q2, handles: handles2, slots: slots2, topLevel: slots2.length === handles2.length };
  }) };
  if (options.reserve && sourceContext) {
    const last = Math.min(...upd.lines.map((l) => l.y + dy));
    const delta = Math.max(0, source2.at(-1).y - last);
    if (delta > 0.01) {
      reservation = options.reserve(engine, sourceContext, [{ id: para.id, box: para.box, delta }], { targetHandles: [...prefix, ...fresh] });
      if (!reservation.ok) {
        const code = reservation.code;
        reservation = null;
        return restore(code);
      }
      for (const h of hyphens) {
        const b2 = engine.objectBounds(h.h), shift = reservation.shifts.get(h.owner) || 0;
        if (!b2 || Math.abs(b2.x - h.bounds.x) > 0.02 || Math.abs(b2.y - (h.bounds.y - shift)) > 0.02 || Math.abs(b2.w - h.bounds.w) > 0.02 || Math.abs(b2.h - h.bounds.h) > 0.02) return restore("hyphen_moved_unexpectedly");
      }
    }
  }
  let now, ids, ownership, repairContext;
  if (!options.context) {
    const after = engine.buildModel();
    if (after.length !== paras.length || after.some((p, j) => j !== pi && !changed.has(j) && paraKey(p) !== paraKey(paras[j]))) return restore("page_model_changed");
    now = after[pi];
    if (squash(textOf3(now)) !== squash(fullNew)) return restore("edited_text_mismatch");
    const nowHandles = (engine.paragraphObjects(now.id) || []).map((h) => h >>> 0);
    const want = /* @__PURE__ */ new Set([...prefix, ...fresh]);
    if (nowHandles.length !== want.size || nowHandles.some((h) => !want.has(h))) return restore("paragraph_objects_changed");
    ids = after.map((p) => p.id);
  } else {
    const live = new Set(pageObjectList(engine));
    const owners = /* @__PURE__ */ new Map();
    for (const [j, q2] of sourceContext.paras.entries()) {
      const hs = j === pi ? [...prefix, ...fresh] : q2.handles;
      for (const h of hs) {
        if (!live.has(h) || owners.has(h)) return restore("paragraph_objects_changed");
        owners.set(h, j);
      }
      if (j !== pi) {
        const shift = reservation?.shifts?.get(q2.id) || 0;
        if (!sameGlyphs2(otherGlyphs[j].map((g) => ({ ...g, y: g.y - shift })), collectGlyphs(engine, hs)).ok)
          return restore("reserved_objects_changed");
      }
    }
    if (squash(textOf3(upd)) !== squash(suffixRuns.map((r) => r.text).join(""))) return restore("edited_text_mismatch");
    const retained = sourceContext.paras[pi].handles.filter((h) => !suffixSet.has(h) && !prefix.includes(h));
    if (retained.some((h) => !live.has(h) || owners.has(h))) return restore("paragraph_objects_changed");
    const stable = [...prefix, ...retained];
    const baseContext = reservation?.context ?? sourceContext;
    const split = splitSourceOwnership(baseContext, pi, suffixOrdered, stable, fresh);
    if (!split) return restore("paragraph_objects_changed");
    repairContext = split.context;
    ownership = split.ownership;
    now = { ...para, runs, lines: [...source2.slice(0, k), ...upd.lines.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }))] };
    ids = paras.map((p) => p.id);
  }
  const proof = sameGlyphs2(prefixGlyphs, collectGlyphs(engine, prefix));
  if (!proof.ok) return restore("kept_lines_moved");
  const got = collectGlyphs(engine, fresh).filter((g) => g.u > 32);
  if (!got.length || got.some((g) => drawnSize(g) == null)) return restore("suffix_matrix_unavailable");
  if (got.some((g) => Math.abs(drawnSize(g) - srcSize) > DRAWN_TOL)) return restore("suffix_font_changed");
  if (options.context) {
    const sourceFonts = new Set(onEdited.map((g) => g.font));
    if (sourceFonts.size !== 1 || sourceFonts.has(null) || got.some((g) => !sourceFonts.has(g.font))) return restore("suffix_font_changed");
  }
  const topGlyphs = got.filter((g) => Math.abs(g.y - source2[k].y) <= 0.5);
  if (!topGlyphs.length || Math.abs(Math.min(...topGlyphs.map((g) => g.x)) - source2[k].x) > PLACE_TOL) return restore("suffix_misplaced");
  const inkRight = Math.max(...fresh.map((h) => {
    const b2 = engine.objectBounds(h);
    return b2 ? b2.x + b2.w : -Infinity;
  }));
  if (inkRight > right + 1) return restore("suffix_exceeds_column");
  return {
    upd: { ...now, surgical: false },
    ids,
    ownership,
    reservedBaseline: Math.min(...upd.lines.map((l) => l.y + dy)),
    context: repairContext ?? null,
    lines: {
      status: "reflowed",
      reason: "edited_line_overflows",
      prefixKept: k,
      suffixReflow: true,
      kept: k,
      lines: now.lines?.length ?? null,
      maxKeptShift: +proof.max.toFixed(4)
    }
  };
}
function modelMatches(engine, model, paras, pi, expectPi, changed, prior) {
  if (!model || model.length !== paras.length) return false;
  if (squash(textOf3(model[pi])) !== expectPi) return false;
  for (let j = 0; j < model.length; j++) {
    if (j === pi) continue;
    if (changed.has(j)) {
      const snap = prior?.get(j);
      if (!snap?.handles.length || !snap.glyphs.length) return false;
      const got = (engine.paragraphObjects(model[j].id) || []).map((h) => h >>> 0).sort((a, b) => a - b);
      if (got.join(",") !== snap.handles.join(",")) return false;
      if (!sameGlyphs2(snap.glyphs, collectGlyphs(engine, got)).ok) return false;
      continue;
    }
    if (squash(textOf3(model[j])) !== squash(textOf3(paras[j]))) return false;
  }
  return true;
}
function rebindRuns(edited, original, restored) {
  if (!restored) return edited;
  if (original.length === restored.length && original.every((r, i) => r.text === restored[i].text)) return edited;
  if (original.map((r) => r.text).join("") !== restored.map((r) => r.text).join("")) return null;
  const at = [];
  restored.forEach((r, i) => {
    for (let k = 0; k < r.text.length; k++) at.push(i);
  });
  const from = [];
  original.forEach((r, i) => {
    for (let k = 0; k < r.text.length; k++) from.push(i);
  });
  const hits2 = /* @__PURE__ */ new Map();
  from.forEach((ri, off) => {
    const set = hits2.get(ri) ?? /* @__PURE__ */ new Set();
    set.add(at[off]);
    hits2.set(ri, set);
  });
  const out = [];
  for (const r of edited) {
    const targets = [...hits2.get(r.sourceIndex) ?? []];
    if (targets.length !== 1) return null;
    out.push({ ...r, sourceIndex: targets[0] });
  }
  return out;
}
function replaceReflowWithLineLocal(engine, paras, pi, del, inserts, runs, pre, changed) {
  const para = paras[pi];
  if (!engine.historyUndo()) throw new LineRetentionError("undo_failed");
  if (pageObjectList(engine).join(",") !== pre.join(",")) throw new LineRetentionError("state_drift");
  const local = commitLineLocal(engine, paras, pi, del, inserts, changed);
  if (local.upd) return local;
  let reason = local.reason;
  let id2 = para.id;
  let commitRuns = runs;
  let republish = false;
  let prior = null;
  if (OVERFLOW_REASONS.has(local.reason)) {
    const prefix = commitPrefixSuffix(engine, paras, pi, del, inserts, runs, changed);
    if (prefix.upd) return prefix;
    if (prefix.reason && prefix.reason !== "no_prefix") reason = prefix.reason;
    if (prefix.mutated && prefix.id != null) {
      id2 = prefix.id;
      republish = true;
      prior = prefix.prior;
      commitRuns = rebindRuns(runs, para.runs, prefix.restored?.runs);
      if (!commitRuns) throw new LineRetentionError("state_drift", { after: prefix.reason, part: "font_source" });
    }
  }
  engine.historyBeginStep("falsify-inline-edit");
  let upd;
  try {
    upd = engine.commitParagraph(id2, commitRuns, para.format);
  } finally {
    engine.historyEndStep();
  }
  if (!upd || !republish) return { reason, upd };
  const after = engine.buildModel();
  const fullNew = squash(commitRuns.map((r) => r.text).join(""));
  if (!modelMatches(engine, after, paras, pi, fullNew, changed, prior)) {
    throw new LineRetentionError("state_drift", { after: reason, part: "paragraph_id" });
  }
  return { reason, upd, ids: after.map((p) => p.id) };
}

// src/paragraph-vendor/editor.mjs
var LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxEdits: 64,
  maxTextChars: 4e3,
  maxIdChars: 64
});
var EDITOR_CAPABILITIES = Object.freeze({
  reflow: true,
  pagination: PAGINATION_CAPABILITY,
  documentFlow: Object.freeze({
    supported: true,
    version: 1,
    optIn: true,
    policies: Object.freeze(["strict", "compatible-groups"]),
    scope: "bounded whole-body single-column text chains; original next pages first; tables, figures and ambiguous styles are barriers; Link annotations require a trusted raw dictionary adapter",
    annotations: "optional trusted annotationAdapter; exact unchanged glyph ranges with one rigid translation and preserved raw Link dictionaries; tiny uniquely owned straight citation paths only",
    maxSourcePages: 64
  }),
  continuationStyle: Object.freeze({
    supported: true,
    policy: "source-number-suffix",
    scope: "text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged"
  }),
  limits: LIMITS
});
var EditError = class extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EditError";
    this.code = code;
    this.details = details;
  }
};
var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var EDIT_KEYS = /* @__PURE__ */ new Set(["id", "pageIndex", "before", "after"]);
var REQUEST_KEYS = /* @__PURE__ */ new Set(["sourceBytes", "edits", "reflow"]);
var normalizeText = (s) => s.replace(/\s+/g, " ");
function deletionAlignmentAfter(before, after) {
  let prefix = 0, suffix = 0;
  while (prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const removed = before.slice(prefix, before.length - suffix);
  return before.length > after.length && prefix + suffix === after.length && !/[\r\n]/.test(removed) ? normalizeText(after) : after;
}
function validateRequest(request, limits = LIMITS) {
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
  const seen = /* @__PURE__ */ new Set();
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
  if (![void 0, false, true, "compatible-groups"].includes(options.documentFlow)) bad("documentFlow must be a boolean or compatible-groups");
  if (typeof allow !== "boolean") bad("allowPagination must be a boolean");
  const max = options.maxNewPages ?? PAGINATION_LIMITS.defaultMaxNewPages;
  if (!Number.isInteger(max) || max < 0 || max > PAGINATION_LIMITS.maxNewPages) bad(`maxNewPages must be an integer from 0 to ${PAGINATION_LIMITS.maxNewPages}`);
  return { allow, max };
}
function pageIndexMap(paras) {
  const chars = [];
  paras.forEach((p, pi) => {
    if (pi > 0) chars.push({ ch: "\n", pi: -1 });
    let offset = 0;
    const text3 = p.runs.map((r) => r.text).join("");
    const starts = new Set((p.lines || []).map((l) => l.off));
    p.runs.forEach((r, ri) => {
      for (let o = 0; o < r.text.length; o++) {
        const at = offset + o;
        const lineEndHyphen = text3[at] === "" && /\p{L}/u.test(text3[at - 1] || "") && /\s/.test(text3[at + 1] || "") && /\p{L}/u.test(text3[at + 2] || "") && starts.has(at + 2);
        chars.push({ ch: r.text[o], pi, ri, o, lineEndHyphen });
      }
      offset += r.text.length;
    });
  });
  return chars;
}
function sourceParagraphText(para) {
  const chars = pageIndexMap([para]);
  const drop = new Set(chars.flatMap((c, i) => c.lineEndHyphen ? [i, i + 1] : []));
  return chars.filter((_, i) => !drop.has(i)).map((c) => c.ch).join("");
}
var canonicalParagraphText = sourceParagraphText;
function normalizeChars(chars, logical = false) {
  let norm = "";
  const map = [];
  for (let i = 0; i < chars.length; i++) {
    if (logical && chars[i].lineEndHyphen) {
      i++;
      continue;
    }
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
  const hits2 = [];
  for (let k = norm.indexOf(needle); k >= 0; k = norm.indexOf(needle, k + 1)) hits2.push(k);
  return hits2;
}
function geometricVariants(paras, chars) {
  const byPara = paras.map((_, pi) => chars.flatMap((c, i) => c.pi === pi ? [{ ...c, source: i }] : []));
  const variants = [];
  for (let i = 0; i < paras.length; i++) {
    const a = paras[i], lines2 = a.lines || [], box = a.box;
    if (!box || lines2.length < 2 || !byPara[i].length) continue;
    const steps = lines2.slice(1).map((l, k) => lines2[k].y - l.y);
    const step = steps[0];
    if (!(step > 0) || steps.some((d) => Math.abs(d - step) > 0.5)) continue;
    for (let j = 0; j < paras.length; j++) {
      if (i === j) continue;
      const b = paras[j], first = b.lines?.[0], bb = b.box;
      if (!bb || !first || !byPara[j].length || ![box.x, box.w, bb.x, bb.w, first.y].every(Number.isFinite)) continue;
      if (Math.abs(box.x - bb.x) > 1 || Math.abs(box.w - bb.w) > Math.max(2, box.w * 0.03) || Math.abs(lines2.at(-1).y - first.y - step) > 0.5) continue;
      const competitors = paras.filter((p, k) => k !== i && k !== j && p.box && p.lines?.some((l) => Math.abs(l.y - first.y) <= 0.5) && Math.abs(p.box.x - box.x) <= 1 && p.box.w >= box.w * 0.5);
      if (competitors.length) continue;
      const joined = [...byPara[i], { ch: "\n", pi: -1, source: null }, ...byPara[j]];
      for (const logical of [false, true]) variants.push({ chars: joined, ...normalizeChars(joined, logical) });
    }
  }
  return variants;
}
function rebuildRuns(para, del, inserts, breaks = null) {
  const out = [];
  const sourceChars = !breaks ? pageIndexMap([para]) : [];
  const discretionary = /* @__PURE__ */ new Set();
  sourceChars.forEach((c, i) => {
    if (!c.lineEndHyphen) return;
    discretionary.add(c.ri + ":" + c.o);
    const next = sourceChars[i + 1];
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
function planPageEdits(paras, edits) {
  const chars = pageIndexMap(paras);
  chars.forEach((c, i) => {
    c.source = i;
  });
  const visible = { chars, ...normalizeChars(chars) };
  const logical = { chars, ...normalizeChars(chars, true) };
  const geometry2 = geometricVariants(paras, chars);
  const failures = [];
  const spans = [];
  const plans = [];
  for (const e of edits) {
    const needle = normalizeText(e.before);
    const candidates = /* @__PURE__ */ new Map();
    for (const variant of [visible, logical, ...geometry2]) {
      for (const hit2 of findAll(variant.norm, needle)) {
        const a2 = variant.map[hit2][0], b2 = variant.map[hit2 + needle.length - 1][1];
        const source3 = variant.chars.slice(a2, b2 + 1).filter((c) => c.source != null && c.pi >= 0).map((c) => c.source);
        const key3 = source3.join(":");
        if (!candidates.has(key3)) candidates.set(key3, { ...variant, hit: hit2, a: a2, b: b2, source: source3 });
      }
    }
    if (candidates.size !== 1) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: candidates.size ? "AMBIGUOUS_MATCH" : "NOT_FOUND", hits: candidates.size });
      continue;
    }
    const { map, hit, a, b, source: source2, chars: matchedChars } = candidates.values().next().value;
    const hits2 = [hit];
    const sourceSet = new Set(source2);
    const overlap = spans.find((s) => s.source.some((i) => sourceSet.has(i)));
    if (overlap) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: "OVERLAPPING_EDITS", with: overlap.id });
      continue;
    }
    spans.push({ source: source2, id: e.id });
    const span = matchedChars.slice(a, b + 1).filter((c) => c.pi >= 0);
    const touched = [...new Set(span.map((c) => c.pi))];
    const locked = touched.filter((pi) => paras[pi].editable === false);
    if (locked.length) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: "NOT_EDITABLE", paragraphIds: locked.map((pi) => paras[pi].id) });
      continue;
    }
    const lastPi = touched[touched.length - 1];
    const noop = normalizeText(e.after) === needle;
    const discontiguous = source2.some((v, k) => k > 0 && v > source2[k - 1] + 2);
    const geometricShortening = !noop && discontiguous ? planGeometricShortening(matchedChars, map, hit, needle, e.after) : null;
    const change = noop ? null : geometricShortening || planInlineChange(paras, matchedChars, map, hits2[0], needle, deletionAlignmentAfter(e.before, e.after));
    if (change?.failure) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: change.failure });
      continue;
    }
    if (discontiguous && new Set((change?.del || []).map((c) => c.pi)).size > 1 && !geometricShortening) {
      failures.push({ id: e.id, pageIndex: e.pageIndex, code: "UNSUPPORTED_GEOMETRIC_CHANGE" });
      continue;
    }
    plans.push({ edit: e, span, touched, geometricShortening: !!geometricShortening, insertAt: span.find((c) => c.pi === lastPi), noop, change, start: Math.min(...source2), sourceHyphenNormalization: span.some((c) => c.lineEndHyphen) });
  }
  const perPara = /* @__PURE__ */ new Map();
  const entry = (pi) => {
    if (!perPara.has(pi)) perPara.set(pi, { del: /* @__PURE__ */ new Set(), inserts: [] });
    return perPara.get(pi);
  };
  for (const p of plans) {
    if (p.noop) continue;
    for (const c of p.change.del) entry(c.pi).del.add(c.ri + ":" + c.o);
    p.change.inserts.forEach((ins, k) => entry(ins.pi).inserts.push({ ri: ins.ri, o: ins.o, text: ins.text, start: p.start, k }));
  }
  for (const v of perPara.values()) v.inserts.sort((x, y) => x.start - y.start || x.k - y.k);
  return { failures, plans, perPara };
}
function snapshotKey(paras) {
  const box = (b) => b ? [b.x, b.top, b.w, b.h].map((v) => Math.round(v * 100)).join(",") : "-";
  return paras.map((p) => box(p.box) + "|" + p.runs.map((r) => r.text).join("\0")).join("\n");
}
function groupByPage(edits) {
  const byPage = /* @__PURE__ */ new Map();
  for (const e of edits) byPage.set(e.pageIndex, [...byPage.get(e.pageIndex) || [], e]);
  return [...byPage.entries()].sort((x, y) => x[0] - y[0]);
}
async function loadQuality(override) {
  if (override) return override;
  try {
    return await Promise.resolve().then(() => (init_quality(), quality_exports));
  } catch (err) {
    throw new EditError("QUALITY_UNAVAILABLE", "Quality module src/quality.mjs could not be loaded", { cause: err.code ?? err.name });
  }
}
function captureConsole(keepText) {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  const entries2 = [];
  let count = 0;
  const sink = (level) => (...args) => {
    count++;
    if (keepText) entries2.push(level + ": " + args.map(String).join(" "));
  };
  console.warn = sink("warn");
  console.error = sink("error");
  console.log = sink("log");
  return {
    restore() {
      Object.assign(console, saved);
      return keepText ? { count, entries: entries2 } : { count };
    }
  };
}
var sha256Bytes = (bytes2) => createHash("sha256").update(bytes2).digest("hex");
function readablePdf(pdf) {
  return pdf instanceof Uint8Array && pdf.length >= 5 && pdf[0] === 37 && pdf[1] === 80 && pdf[2] === 68 && pdf[3] === 70 && pdf[4] === 45;
}
function withholdAbsentAfter(report) {
  const failures = Array.isArray(report.selfCheck?.failures) ? report.selfCheck.failures : [];
  const missing = failures.filter((f) => f && f.code === "after_missing");
  if (!missing.length) return;
  const ids = new Set(missing.map((f) => f.id).filter((id2) => typeof id2 === "string"));
  const pages = new Set(missing.filter((f) => f.id == null && Number.isInteger(f.pageIndex)).map((f) => f.pageIndex));
  const unlabeled = ids.size === 0 && pages.size === 0;
  for (const row of report.edits) {
    if ((unlabeled || ids.has(row.id) || pages.has(row.pageIndex)) && (row.status === "applied" || row.status === "noop")) row.status = "after-missing";
  }
}
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
async function editPdf(request, options = {}) {
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
    independentQA: { status: "pending", note: "Same-engine self-check only; independent QA is still required." }
  };
  const editReport = new Map(report.edits.map((r) => [r.id, r]));
  const fail8 = (code, message, details) => {
    const err = new EditError(code, message, details);
    err.report = report;
    return err;
  };
  const logCapture = captureConsole(!!options.includeEngineLog);
  let engine;
  let restoreColumns = null;
  let pdf;
  let sourcePageCount = 0;
  const continued = /* @__PURE__ */ new Map();
  let added = 0;
  try {
    try {
      engine = await engineFactory(sourceBytes);
    } catch (err) {
      throw fail8("OPEN_FAILED", err.passwordRequired ? "Source PDF is password-protected" : "Source PDF could not be opened");
    }
    sourcePageCount = engine.pageCount;
    const outOfRange = edits.filter((e) => e.pageIndex >= engine.pageCount);
    if (outOfRange.length) {
      for (const e of outOfRange) editReport.get(e.id).status = "page-out-of-range";
      throw fail8("PAGE_OUT_OF_RANGE", `Edit page index out of range (document has ${engine.pageCount} pages)`, { ids: outOfRange.map((e) => e.id) });
    }
    const pagePlans = [];
    const failures = [];
    for (const [pageIndex, pageEdits] of groupByPage(edits)) {
      engine.loadPage(pageIndex);
      engine.normalizeFontsForEdit();
      let paras = engine.buildModel();
      let plan = planPageEdits(paras, pageEdits);
      restoreColumns = isolateColumns(engine, paras, pageEdits, plan);
      if (restoreColumns) {
        paras = engine.buildModel();
        plan = planPageEdits(paras, pageEdits);
      }
      failures.push(...plan.failures);
      pagePlans.push({ pageIndex, pageEdits, isolated: !!restoreColumns, paras, plan, key: snapshotKey(paras), regenHostile: engine.pageRegenHostile() });
      restoreColumns?.();
      restoreColumns = null;
    }
    if (failures.length) {
      for (const f of failures) Object.assign(editReport.get(f.id), { status: "rejected", code: f.code, hits: f.hits });
      if (failures.every((f) => f.code === "AMBIGUOUS_STYLE")) {
        throw fail8("STYLE_AMBIGUOUS", `${failures.length} edit(s) replace text of several styles with no justified style mapping`, { failures });
      }
      throw fail8("MATCH_FAILED", `${failures.length} edit(s) could not be matched exactly once or planned`, { failures });
    }
    let mutated = false;
    for (const { pageIndex, pageEdits, isolated, plan, key: key3, regenHostile } of pagePlans) {
      const pageReport = { pageIndex, paragraphs: [], regenHostile };
      report.pages.push(pageReport);
      if (regenHostile) report.warnings.push({ pageIndex, code: "PAGE_REGEN_HOSTILE" });
      for (const p of plan.plans) {
        Object.assign(editReport.get(p.edit.id), {
          status: p.noop ? "noop" : "planned",
          paragraphIndices: [...p.touched]
        });
        if (p.sourceHyphenNormalization) report.warnings.push({ pageIndex, id: p.edit.id, code: "source_line_end_discretionary_hyphen_matched", severity: "info", evidence: "PDFium U+0002 followed by source line boundary", originalBefore: p.edit.before });
        if (p.change?.warning) report.warnings.push({ pageIndex, id: p.edit.id, code: p.change.warning, severity: "warning" });
      }
      if (plan.perPara.size === 0) continue;
      const at = pageIndex + added;
      engine.loadPage(at);
      if (isolated) {
        const initial = engine.buildModel();
        restoreColumns = isolateColumns(engine, initial, pageEdits, planPageEdits(initial, pageEdits));
        if (!restoreColumns) throw fail8("STATE_DRIFT", "Column isolation could not be repeated", { pageIndex });
      }
      const objectsBefore = canCommitLineLocal(engine) ? pageObjectList(engine).join(",") : null;
      const paras = engine.buildModel();
      const localStable = objectsBefore !== null && pageObjectList(engine).join(",") === objectsBefore;
      if (snapshotKey(paras) !== key3) throw fail8("STATE_DRIFT", "Page model changed between planning and commit", { pageIndex });
      let context2 = quality.capturePageLayout(engine, at, paras);
      const touched = [];
      let ownershipView = null;
      const mutations = [...plan.perPara.entries()].sort((x, y) => x[0] - y[0]);
      for (const [mutationIndex, [pi, { del, inserts }]] of mutations.entries()) {
        const para = paras[pi];
        const markerPlans = plan.plans.filter((p) => !p.noop && p.touched.includes(pi));
        if (mutations.length === 1 && markerPlans.length === 1) {
          const word = commitSourceWord(engine, para, markerPlans[0].edit.before, markerPlans[0].edit.after);
          if (word) {
            mutated = true;
            pageReport.paragraphs.push({ index: pi, surgical: true, lineRetention: word });
            continue;
          }
        }
        if (markerPlans.length === 1 && markerPlans[0].change?.warning === "numeric_marker_style_from_digits") {
          const mapped = markerPlans[0].change.numericMarker;
          const marker = commitNumericMarker(engine, para, mapped?.before || markerPlans[0].edit.before, mapped?.after || markerPlans[0].edit.after, mapped);
          if (marker) {
            mutated = true;
            pageReport.paragraphs.push({ index: pi, surgical: true, lineRetention: marker });
            continue;
          }
        }
        const geometric = plan.plans.some((p) => p.geometricShortening && p.touched.includes(pi));
        if (geometric && !inserts.length) {
          if (mutationIndex !== mutations.length - 1 || plan.plans.filter((p) => p.touched.includes(pi) && !p.noop).length !== 1 || !removeGeometricFirstLine(engine, para, del, inserts)) {
            throw fail8("LAYOUT_UNSUPPORTED", "Geometric deletion could not preserve the source objects", { pageIndex, paragraphIndex: pi });
          }
          mutated = true;
          pageReport.paragraphs.push({ index: pi, surgical: true, lineRetention: { status: "geometric_first_line_removed" } });
          continue;
        }
        const runs = rebuildRuns(para, del, inserts);
        const linePlan = sourceLinePlan(para, del, inserts);
        if (linePlan?.breaks) linePlan.lineRuns = rebuildRuns(para, del, inserts, linePlan.breaks);
        mutated = true;
        let committed;
        let lineLocal = null;
        let publishedId = null;
        try {
          const pre = linePlan?.breaks && localStable ? pageObjectList(engine) : null;
          const prefix = plan.plans.some((p) => p.geometricShortening && p.change.inserts.some((ins) => ins.pi === pi));
          const sourceOwner = context2?.paras?.[pi];
          const hasSourceContext = Array.isArray(context2?.objects) && Array.isArray(context2?.types) && Array.isArray(sourceOwner?.handles) && Array.isArray(sourceOwner?.slots) && sourceOwner.slots.length > 0;
          const scalePrefix = hasSourceContext && plan.plans.some((p) => p.change?.requiresPrefix && p.touched.includes(pi));
          const ownerHandles = new Set(hasSourceContext ? sourceOwner.handles : []);
          const deletionSpan = !inserts.length ? editedLineSpan(para, del, inserts) : null;
          const suffixSlots = hasSourceContext && deletionSpan && !deletionSpan.reason ? sourceOwner.slots.filter((slot) => {
            const b = engine.objectBounds(context2.objects[slot]);
            return b && para.lines.slice(deletionSpan.k).some((l) => l.y >= b.y - 1 && l.y <= b.y + b.h + 1);
          }) : [];
          const firstSuffixSlot = suffixSlots.length ? Math.min(...suffixSlots) : -1;
          const maskPrefix = hasSourceContext && deletionSpan && !deletionSpan.reason && deletionSpan.k > 0 && firstSuffixSlot >= 0 && sourceOwner.slots.some((slot) => {
            const prefixHandle = context2.objects[slot], b = engine.objectBounds(prefixHandle);
            if (!b || slot >= firstSuffixSlot || !para.lines.slice(0, deletionSpan.k).some((l) => l.y >= b.y - 1 && l.y <= b.y + b.h + 1)) return false;
            return context2.objects.slice(slot + 1, firstSuffixSlot).some((h, offset) => {
              if (ownerHandles.has(h) || context2.types[slot + 1 + offset] !== 2) return false;
              const m = engine.objectBounds(h);
              return m && Math.min(b.x + b.w, m.x + m.w) > Math.max(b.x, m.x) && Math.min(b.y + b.h, m.y + m.h) > Math.max(b.y, m.y);
            });
          });
          if (scalePrefix || maskPrefix) {
            if (!localStable || mutations.length !== 1 || plan.plans.filter((p) => p.touched.includes(pi) && !p.noop).length !== 1) throw new LineRetentionError("scale_prefix_unavailable");
            committed = commitPrefixSuffix(engine, paras, pi, del, inserts, runs, new Set(touched.map((t) => t.index)), { allowMultiple: true, context: context2, reserve: quality.reserveCascadeSpace });
            if (!committed?.upd) throw new LineRetentionError(committed?.reason || "scale_prefix_unavailable");
            if (committed.context) context2 = committed.context;
            committed.ids.forEach((id2, j) => {
              paras[j].id = id2;
              context2.paras[j].id = id2;
            });
            for (const t of touched) t.id = committed.ids[t.index];
            publishedId = committed.ids[pi];
            ownershipView = Object.create(engine);
            Object.defineProperty(ownershipView, "_pageDirty", { get: () => engine._pageDirty, set: (value) => {
              engine._pageDirty = value;
            } });
            ownershipView.paragraphObjects = (id2) => committed.ownership.get(id2) || [];
            ownershipView.resizeParagraph = () => null;
            ownershipView.moveParagraph = () => false;
          } else if (prefix) {
            if (plan.plans.filter((p) => p.touched.includes(pi) && !p.noop).length !== 1) throw new LineRetentionError("geometric_prefix_shared");
            committed = await commitGeometricPrefix(engine, para, del, inserts);
            if (!committed) throw new LineRetentionError("geometric_prefix_unsupported");
          } else committed = await commitSourceLineDeletion(engine, para, runs) || commitRetainingLines(engine, para, runs, linePlan);
          const lost = committed.lines?.status === "reflowed";
          if (lost && linePlan?.breaks && objectsBefore !== null && !localStable) lineLocal = { status: "declined", reason: "page_model_unstable" };
          if (pre && lost && inserts.length && !scalePrefix && !maskPrefix) {
            const changed = new Set(touched.map((t) => t.index));
            const local = replaceReflowWithLineLocal(engine, paras, pi, del, inserts, runs, pre, changed);
            const applyIds = (ids) => {
              if (!Array.isArray(ids)) return;
              publishedId = ids[pi];
              ids.forEach((id2, j) => {
                paras[j].id = id2;
                context2.paras[j].id = id2;
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
          throw fail8(err.code === "state_drift" ? "STATE_DRIFT" : "COMMIT_FAILED", "Paragraph state could not be re-verified during a line-retaining commit", { pageIndex, paragraphId: para.id, cause: err.code });
        }
        const upd = committed.upd;
        if (!upd) throw fail8("COMMIT_FAILED", "Engine rejected a paragraph commit", { pageIndex, paragraphId: para.id });
        const row = { index: pi, surgical: !!upd.surgical, sourceLines: para.lines?.length ?? null, committedLines: upd.lines?.length ?? null };
        if (committed.lines) row.lineRetention = committed.lines;
        if (lineLocal) row.lineLocal = lineLocal;
        pageReport.paragraphs.push(row);
        if (committed.lines?.status === "reflowed" && committed.lines.reason !== "line_count_changed") {
          report.warnings.push({ pageIndex, code: "source_lines_reflowed", paragraphIndex: pi, reason: committed.lines.reason, severity: "warning" });
        }
        touched.push({ id: publishedId ?? upd.id ?? para.id, index: pi, sourceBox: para.box, sourceLines: ownershipView ? [{ y: committed.reservedBaseline }] : para.lines, sourceFormat: para.format });
      }
      if (reflow) {
        let r;
        let paginated = null;
        const repairOptions = pg.allow ? { paginate: (eng, ctx, grown, info) => {
          restoreColumns?.();
          restoreColumns = null;
          return paginated = paginateOverflow(eng, ctx, grown, { ...info, maxNewPages: pg.max - added });
        } } : {};
        try {
          r = quality.repairPageLayout(ownershipView || engine, at, context2, touched, repairOptions);
        } catch (err) {
          throw fail8("REPAIR_FAILED", "Layout repair raised an error", { pageIndex, cause: err?.code ?? err?.name ?? "Error" });
        }
        report.repairs.push({ pageIndex, repairs: r?.repairs ?? [] });
        const pageWarnings = (r?.warnings ?? []).map((w) => ({ pageIndex, ...w && typeof w === "object" ? w : { message: String(w) } }));
        report.warnings.push(...pageWarnings);
        const errors = pageWarnings.filter((w) => w.severity === "error");
        if (errors.length) {
          if (errors.some((w) => w.code === "pagination_budget_exceeded")) {
            throw fail8("PAGINATION_LIMIT", `Edit on page ${pageIndex} needs more than the ${pg.max} allowed new page(s)`, { pageIndex, maxNewPages: pg.max });
          }
          const unsupported = errors.some((w) => /unsupported/.test(String(w.code)));
          const codes = errors.map((w) => w.code);
          const reasons = [];
          if (codes.includes("pagination_unsupported_edge_paragraph_in_flow")) reasons.push("\uD398\uC774\uC9C0 \uACBD\uACC4\uC758 \uBB38\uB2E8\uC744 \uC774\uC5B4 \uBC30\uCE58\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
          if (codes.includes("pagination_unsupported_multi_column_flow")) reasons.push("\uC5EC\uB7EC \uB2E8\uC73C\uB85C \uB41C \uBCF8\uBB38\uC744 \uC774\uC5B4 \uBC30\uCE58\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
          if (codes.some((code) => !["pagination_unsupported_edge_paragraph_in_flow", "pagination_unsupported_multi_column_flow"].includes(code))) reasons.push("\uD604\uC7AC \uB808\uC774\uC544\uC6C3\uC744 \uC548\uC804\uD558\uAC8C \uBCF5\uAD6C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
          throw fail8(unsupported ? "LAYOUT_UNSUPPORTED" : "REPAIR_FAILED", `PDF ${pageIndex + 1}\uCABD: ${reasons.join("; ")}. \uD574\uB2F9 \uCABD\uC758 \uD3B8\uC9D1 \uB0B4\uC6A9\uC774\uB098 \uBC30\uCE58\uB97C \uD655\uC778\uD574 \uC8FC\uC138\uC694.`, {
            pageIndex,
            codes,
            count: errors.length
          });
        }
        if (r?.pagination?.added > 0) {
          const style = r.pagination.continuationStyle ?? (paginated?.ok ? paginated.continuationStyle : void 0);
          continued.set(pageIndex, { ...r.pagination, continuationStyle: style });
          added += r.pagination.added;
        }
      } else if (typeof quality.restoreSourceOrder === "function") {
        const repairs = [], warnings = [];
        quality.restoreSourceOrder(ownershipView || engine, context2, repairs, warnings);
        report.repairs.push({ pageIndex, repairs });
        const pageWarnings = warnings.map((w) => ({ pageIndex, ...w }));
        report.warnings.push(...pageWarnings);
        if (pageWarnings.some((w) => w.severity === "error") || repairs.some((r) => r.kind === "reading_order" && r.action === "skipped")) throw fail8("REPAIR_FAILED", "Source painter order could not be preserved", { pageIndex });
      }
      for (const p of plan.plans) if (!p.noop) editReport.get(p.edit.id).status = "applied";
      restoreColumns?.();
      restoreColumns = null;
    }
    if (mutated) {
      pdf = engine.save();
      if (!pdf || !pdf.length) throw fail8("SAVE_FAILED", "Engine did not produce output bytes");
      pdf = new Uint8Array(pdf);
    } else {
      pdf = new Uint8Array(sourceBytes);
    }
  } finally {
    try {
      try {
        restoreColumns?.();
      } finally {
        try {
          restoreColumns?.disposeDetached?.();
        } finally {
          engine?.close();
        }
      }
    } catch {
    }
    report.engineLog = logCapture.restore();
  }
  let sourcePageMap = [];
  for (let s = 0, out = 0; s < sourcePageCount; s++) {
    const c = continued.get(s);
    const n = c?.added ?? 0;
    const entry = { sourcePageIndex: s, outputPageIndex: out, continuationPageIndices: Array.from({ length: n }, (_, k) => out + 1 + k) };
    if (c) Object.assign(entry, { lineCounts: [...c.lineCounts], keptLines: c.keptLines, bodyTop: c.bodyTop, ...c.flowTop !== void 0 ? { flowTop: c.flowTop } : {}, ...c.flowColumn ? { flowColumn: { ...c.flowColumn } } : {}, floor: c.floor });
    if (c?.continuationStyle) entry.continuationStyle = { version: c.continuationStyle.version, policy: c.continuationStyle.policy, applied: c.continuationStyle.applied === true };
    sourcePageMap.push(entry);
    out += 1 + n;
  }
  let flowGroups = [], annotationMoves = [];
  const documentFlowEnabled = options.documentFlow === true || options.documentFlow === "compatible-groups";
  if (documentFlowEnabled && added > 0) {
    try {
      const compacted = await compactDocumentFlow(engineFactory, sourceBytes, pdf, edits, sourcePageMap, pg.max, options.documentFlow === "compatible-groups" ? "compatible-groups" : "strict", options.annotationAdapter ?? null);
      pdf = compacted.pdf;
      sourcePageMap = compacted.sourcePageMap;
      added = compacted.addedPages;
      flowGroups = compacted.flowGroups;
      annotationMoves = compacted.annotationMoves ?? [];
      report.warnings.push(...compacted.warnings ?? []);
    } catch (err) {
      throw fail8("LAYOUT_UNSUPPORTED", "Document flow could not preserve the compatible text chain", { cause: err?.code ?? "document_flow_failed" });
    }
  }
  report.pagination = {
    enabled: pg.allow,
    maxNewPages: pg.max,
    pages: { source: sourcePageCount, output: sourcePageCount + added },
    addedPages: added,
    sourcePageMap,
    flowGroups,
    annotationMoves,
    documentFlow: documentFlowEnabled,
    documentFlowPolicy: options.documentFlow === "compatible-groups" ? "compatible-groups" : documentFlowEnabled ? "strict" : "disabled"
  };
  const markerResult = await repairInlineMarkers({
    engineFactory,
    sourceBytes,
    outputBytes: pdf,
    pageIndices: [...new Set(edits.map((e) => e.pageIndex))],
    sourcePageMap
  });
  pdf = markerResult.pdf;
  report.inlineMarkerRepairs = markerResult.repairs;
  report.warnings.push(...markerResult.warnings);
  const paragraphLinks = await transportParagraphLinks({ engineFactory, sourceBytes, outputBytes: pdf, edits, sourcePageMap, flowGroups, annotationAdapter: options.annotationAdapter });
  pdf = paragraphLinks.pdf;
  report.paragraphLinkMoves = paragraphLinks.moves;
  report.paragraphLinkFailures = paragraphLinks.failures;
  const qaCapture = captureConsole(!!options.includeEngineLog);
  let check;
  try {
    check = await quality.inspectSavedPdf(engineFactory, sourceBytes, pdf, edits, { sourcePageMap, flowGroups, annotationAdapter: options.annotationAdapter, includeText: !!options.includeFlowText });
  } catch (err) {
    report.selfCheck = { status: "error", error: err?.code ?? err?.name ?? "Error" };
    if (options.draft === true && readablePdf(pdf)) return finishDraft(report, pdf, sourceBytes, "SELF_CHECK_FAILED", "Saved-PDF self-check could not run");
    throw fail8("SELF_CHECK_FAILED", "Saved-PDF self-check could not run");
  } finally {
    report.selfCheckLog = qaCapture.restore();
  }
  if (paragraphLinks.failures.length) check = { ...check, ok: false, failures: [...check?.failures ?? [], ...paragraphLinks.failures] };
  report.selfCheck = { status: check?.ok === true ? "passed" : "failed", ...check };
  report.pagination.flow = (check?.pages ?? []).filter((row) => row.continuationPageIndices?.length).map((row) => ({
    sourcePageIndex: row.pageIndex,
    outputPageIndices: [row.outputPageIndex, ...row.continuationPageIndices],
    bodyBand: row.body_band,
    expectedText: row.expected_text,
    outputParts: row.output_parts,
    measuredLines: (row.continuation ?? []).map((c) => c.lines),
    textEqual: row.text_equal === true
  }));
  const unapplied = report.edits.filter((r) => r.status !== "applied" && r.status !== "noop");
  if (options.draft === true && check?.ok !== true && readablePdf(pdf)) {
    return finishDraft(report, pdf, sourceBytes, "SELF_CHECK_FAILED", "Saved-PDF self-check reported failures");
  }
  if (unapplied.length) throw fail8("EDIT_NOT_APPLIED", "Some requested edits were not applied", { ids: unapplied.map((r) => r.id) });
  if (check?.ok !== true) throw fail8("SELF_CHECK_FAILED", "Saved-PDF self-check reported failures");
  if (added > 0 && sourcePageMap.every((m) => !m.continuationPageIndices.length || m.continuationStyle?.applied === true)) {
    report.pagination.continuationStyle = { policy: "source-number-suffix", applied: true, copiedPages: added };
  }
  report.ok = true;
  report.status = "self-check-passed";
  return { pdf, report };
}

// src/paragraph-pdf.mjs
init_paragraph_pdf_crypto();

// src/browser-fonts.mjs
var error = (message) => new Error(message);
function parseFont(bytes2) {
  const bad = () => {
    throw error("\uC62C\uBC14\uB978 TTF \uB610\uB294 OTF \uAE00\uAF34 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  };
  if (!(bytes2 instanceof Uint8Array) || bytes2.length < 12) bad();
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const u16 = (o) => {
    if (o < 0 || o + 2 > bytes2.length) bad();
    return view.getUint16(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > bytes2.length) bad();
    return view.getUint32(o);
  };
  const tag = (o) => String.fromCharCode(...bytes2.subarray(o, o + 4));
  const sig = u32(0);
  if (sig === 1953784678) throw error("\uAE00\uAF34 \uCEEC\uB809\uC158(TTC/OTC)\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E8\uC77C TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  if (sig !== 65536 && sig !== 1330926671 && sig !== 1953658213) bad();
  const count = u16(4), tables = /* @__PURE__ */ new Map();
  if (!count || 12 + count * 16 > bytes2.length) bad();
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, name = tag(p), offset = u32(p + 8), length = u32(p + 12);
    if (offset > bytes2.length || length > bytes2.length - offset || tables.has(name)) bad();
    tables.set(name, { offset, length });
  }
  if (tables.has("fvar")) throw error("\uAC00\uBCC0 \uAE00\uAF34\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uACE0\uC815 \uAD75\uAE30\uC758 TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  const names = tables.get("name"), os2 = tables.get("OS/2"), head = tables.get("head");
  if (!names || names.length < 6 || !os2 || os2.length < 64 || !head || head.length < 46) bad();
  const n = names.offset, entries2 = u16(n + 2), strings = n + u16(n + 4), end = n + names.length;
  if (n + 6 + entries2 * 12 > end || strings > end) bad();
  const values = /* @__PURE__ */ new Map();
  for (let i = 0; i < entries2; i++) {
    const p = n + 6 + i * 12, platform = u16(p), encoding = u16(p + 2), language = u16(p + 4), id2 = u16(p + 6), length = u16(p + 8), start = strings + u16(p + 10);
    if (start > end || length > end - start) bad();
    if (![1, 2, 6, 16, 17].includes(id2)) continue;
    let text3;
    if (platform === 0 || platform === 3) {
      if (length % 2) bad();
      text3 = "";
      for (let j = 0; j < length; j += 2) text3 += String.fromCharCode(u16(start + j));
    } else if (platform === 1 && encoding === 0) text3 = String.fromCharCode(...bytes2.subarray(start, start + length));
    else continue;
    text3 = text3.replace(/\0/g, "").trim();
    const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 1033 ? 2 : 0);
    if (text3 && (!values.has(id2) || values.get(id2).score < score)) values.set(id2, { text: text3, score });
  }
  const get = (id2) => values.get(id2)?.text;
  const family = get(16) || get(1), postscriptName = get(6);
  if (!family) bad();
  const weight = u16(os2.offset + 4), fsType = u16(os2.offset + 8), selection = u16(os2.offset + 62), macStyle = u16(head.offset + 44);
  if (weight < 1 || weight > 1e3) bad();
  if (fsType & 512 || fsType & 2 && !(fsType & 12)) throw error("\uC774 \uAE00\uAF34\uC740 \uC784\uBCA0\uB529 \uC81C\uD55C \uB610\uB294 \uBE44\uD2B8\uB9F5 \uC804\uC6A9 \uC81C\uD55C\uC774 \uC788\uC5B4 PDF\uC5D0 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E4\uB978 \uAE00\uAF34\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  return { family, ...postscriptName ? { postscriptName } : {}, weight, italic: Boolean(selection & 1 || macStyle & 2), fsType };
}

// src/paragraph-pdf.mjs
init_paragraph_source_tables();

// src/paragraph-pdf-marker-surgery.mjs
var enc = new TextEncoder();
var near5 = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.025;
var hex3 = (n) => n.toString(16).padStart(4, "0").toUpperCase();
function cmapByte(cmap, byte) {
  if (/\busecmap\b/.test(cmap)) return null;
  const matches = [];
  for (const section of cmap.matchAll(/\d+\s+beginbfchar\b([\s\S]*?)endbfchar/g))
    for (const m of section[1].matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g))
      if (parseInt(m[1], 16) === byte) matches.push(parseInt(m[2], 16));
  for (const section of cmap.matchAll(/\d+\s+beginbfrange\b([\s\S]*?)endbfrange/g))
    for (const m of section[1].matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (byte >= lo && byte <= hi) matches.push(parseInt(m[3], 16) + byte - lo);
    }
  return matches.length === 1 ? matches[0] : null;
}
function copyDict(doc, dict) {
  const copy = doc.newDictionary();
  if (!dict.isNull()) dict.resolve().forEach((v, k) => copy.put(k, v));
  return copy;
}
function readStream(obj) {
  const b = obj.readStream();
  try {
    return b.asUint8Array().slice();
  } finally {
    b.destroy();
  }
}
var text2 = (bytes2) => new TextDecoder("latin1").decode(bytes2);
function pageGlyphs(page, mupdf) {
  const matrix = mupdf.Matrix.invert(page.getTransform()), result = [];
  const structured = page.toStructuredText("preserve-whitespace");
  try {
    structured.walk({ onChar(c, o, f, size3, quad) {
      result.push({ c, fontName: f.getName(), size: size3, pdf: [o[0] * matrix[0] + o[1] * matrix[2] + matrix[4], o[0] * matrix[1] + o[1] * matrix[3] + matrix[5]], quad: [...quad] });
    } });
  } finally {
    structured.destroy();
  }
  return result;
}
function glyphEquals(a, b) {
  return a.c === b.c && a.fontName === b.fontName && near5(a.size, b.size) && near5(a.pdf?.[0], b.pdf?.[0]) && near5(a.pdf?.[1], b.pdf?.[1]);
}
function verifyResult(original, edited, selected, replacement, mupdf) {
  const a = pageGlyphs(original, mupdf), b = pageGlyphs(edited, mupdf);
  const hits2 = [];
  for (let i = 0; i <= a.length - selected.length; i++) if (selected.every((g, j) => glyphEquals(g, a[i + j]))) hits2.push(i);
  if (hits2.length !== 1 || a.length !== b.length) return null;
  const at = hits2[0] + selected.length - 1;
  if (!a.every((g, i) => i === at ? b[i].c === replacement && near5(g.pdf[0], b[i].pdf[0]) && near5(g.pdf[1], b[i].pdf[1]) && near5(g.size, b[i].size) : glyphEquals(g, b[i]))) return null;
  const bounds = [...a[at].quad, ...b[at].quad], xs = bounds.filter((_, i) => i % 2 === 0), ys = bounds.filter((_, i) => i % 2 === 1);
  const pixA = original.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  let pixB;
  try {
    pixB = edited.toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
    if (pixA.getWidth() !== pixB.getWidth() || pixA.getHeight() !== pixB.getHeight() || pixA.getX() !== pixB.getX() || pixA.getY() !== pixB.getY() || pixA.getWidth() * pixA.getHeight() > 5e7) return null;
    const x0 = Math.floor(Math.min(...xs) * 2) - pixA.getX() - 2, x1 = Math.ceil(Math.max(...xs) * 2) - pixA.getX() + 2, y0 = Math.floor(Math.min(...ys) * 2) - pixA.getY() - 2, y1 = Math.ceil(Math.max(...ys) * 2) - pixA.getY() + 2;
    const pa = pixA.getPixels(), pb = pixB.getPixels(), width = pixA.getWidth();
    let changed = 0;
    for (let i = 0; i < pa.length; i += 3) if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) {
      const n = i / 3, x = n % width, y = Math.floor(n / width);
      if (x < x0 || x > x1 || y < y0 || y > y1) return null;
      changed++;
    }
    return changed || null;
  } finally {
    pixA.destroy();
    pixB?.destroy();
  }
}
function sourceMapping(font, bytes2) {
  if (font.get("Subtype").asName() !== "Type1") return null;
  const map = font.get("ToUnicode");
  if (!map.isStream()) return null;
  const cmap = text2(readStream(map));
  return [...bytes2].map((b) => cmapByte(cmap, b));
}
async function validatedFace(snapshot, name) {
  if (!snapshot || !Array.isArray(snapshot.fonts) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return null;
  const digest4 = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (await digest4(enc.encode(JSON.stringify(snapshot.fonts.map(({ bytes: bytes2, ...meta }) => meta)))) !== snapshot.digest?.toLowerCase()) return null;
  for (const f of snapshot.fonts) {
    if (!(f.bytes instanceof Uint8Array) || typeof f.sha256 !== "string" || await digest4(f.bytes) !== f.sha256.toLowerCase()) return null;
    let p;
    try {
      p = parseFont(f.bytes);
    } catch {
      return null;
    }
    if (typeof f.id !== "string" || !["local", "file", "bundled"].includes(f.source) || ["family", "postscriptName", "weight", "italic", "fsType"].some((k) => f[k] !== p[k])) return null;
  }
  return snapshot.fonts.find((f) => f.postscriptName === name) || null;
}
async function replaceMarkerGlyph({ bytes: bytes2, pageIndex, glyphs: glyphs2, after, fontSnapshot, fontPostscriptName, scanTextShows: scanTextShows2, mupdf }) {
  if (!mupdf || !(bytes2 instanceof Uint8Array) || !Number.isInteger(pageIndex) || !Array.isArray(glyphs2) || !glyphs2.length || typeof after !== "string" || [...after].length !== glyphs2.length || typeof scanTextShows2 !== "function") return null;
  bytes2 = bytes2.slice();
  glyphs2 = glyphs2.map((g) => ({ ...g, pdf: Array.isArray(g?.pdf) ? [...g.pdf] : null }));
  const before = glyphs2.map((g) => g.c).join(""), chars = [...after];
  if ([...before].length !== glyphs2.length || chars.slice(0, -1).join("") !== before.slice(0, -1) || chars.at(-1) === glyphs2.at(-1).c || chars.at(-1).codePointAt(0) > 65535) return null;
  if (!Array.isArray(fontSnapshot?.fonts) || fontSnapshot.fonts.some((f) => !(f?.bytes instanceof Uint8Array))) return null;
  const captured = { ...fontSnapshot, fonts: fontSnapshot.fonts.map((f) => ({ ...f, bytes: f.bytes.slice() })) };
  const face = await validatedFace(captured, fontPostscriptName);
  if (!face) return null;
  let doc, font, saved, check, page;
  try {
    doc = mupdf.Document.openDocument(bytes2, "application/pdf").asPDF();
    if (!doc || doc.needsPassword() || pageIndex < 0 || pageIndex >= doc.countPages()) return null;
    page = doc.loadPage(pageIndex);
    const obj = page.getObject();
    if (obj.getInheritable("Rotate").asNumber() % 360 !== 0) return null;
    const contents = obj.get("Contents");
    const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
    if (streams.some((s) => !s.isStream())) return null;
    const resources = obj.getInheritable("Resources"), fontDict = resources.get("Font");
    const candidates = [];
    for (let si2 = 0; si2 < streams.length; si2++) {
      const raw2 = readStream(streams[si2]), parsed = scanTextShows2(raw2);
      if (!parsed || parsed.diagnostics?.length) return null;
      for (const show2 of parsed.shows) {
        if (show2.uncertain || !["Tj", "TJ"].includes(show2.kind) || show2.renderMode !== 0 || show2.parts.length !== 1 || show2.parts[0].type !== "string" || !show2.textMatrix || !show2.ctm) continue;
        const tm = show2.textMatrix, cm = show2.ctm;
        if (![tm[0], tm[3], cm[0], cm[3]].every((n) => near5(n, 1)) || ![tm[1], tm[2], cm[1], cm[2]].every((n) => near5(n, 0))) continue;
        if (!/^[A-Za-z0-9_.-]+$/.test(show2.fontName)) continue;
        const p2 = show2.parts[0], source2 = fontDict.get(show2.fontName), mapping2 = sourceMapping(source2, p2.bytes);
        if (source2.get("BaseFont").asName() !== glyphs2[0].fontName) continue;
        if (!mapping2 || mapping2.length !== glyphs2.length || mapping2.some((v, i) => v !== glyphs2[i].c.codePointAt(0))) continue;
        if (!near5(tm[4] + cm[4], glyphs2[0].pdf?.[0]) || !near5(tm[5] + cm[5] + show2.rise, glyphs2[0].pdf?.[1]) || !near5(show2.fontSize, glyphs2[0].size)) continue;
        let x = glyphs2[0].pdf[0], ok = true;
        const first = source2.get("FirstChar").asNumber(), widths = source2.get("Widths");
        for (let i = 0; i < p2.bytes.length; i++) {
          const g = glyphs2[i], wi = p2.bytes[i] - first, width = widths.get(wi);
          if (!near5(g.pdf?.[0], x) || !near5(g.pdf?.[1], glyphs2[0].pdf[1]) || g.fontName !== glyphs2[0].fontName || !near5(g.size, show2.fontSize) || wi < 0 || wi >= widths.length || !width.isNumber()) {
            ok = false;
            break;
          }
          x += (width.asNumber() / 1e3 * show2.fontSize + show2.charSpace + (p2.bytes[i] === 32 ? show2.wordSpace : 0)) * show2.hScale / 100;
        }
        if (ok) candidates.push({ si: si2, raw: raw2, show: show2, p: p2 });
      }
    }
    if (candidates.length !== 1) return null;
    const { si, raw, show, p } = candidates[0];
    font = new mupdf.Font(face.postscriptName || face.family, face.bytes);
    const gid = font.encodeCharacter(chars.at(-1).codePointAt(0));
    if (!gid || gid > 65535) return null;
    const newResources = copyDict(doc, resources), newFonts = copyDict(doc, fontDict);
    let name = "F" + face.sha256.slice(0, 12);
    while (!newFonts.get(name).isNull()) name += "x";
    const pdfFont = doc.addFont(font), cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Unicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<${hex3(gid)}> <${hex3(chars.at(-1).codePointAt(0))}>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
    pdfFont.put("ToUnicode", doc.addStream(enc.encode(cmap), {}));
    newFonts.put(name, pdfFont);
    newResources.put("Font", newFonts);
    obj.put("Resources", newResources);
    const prefix = [...p.bytes.slice(0, -1)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const replacement = `<${prefix}> Tj /${name} ${show.fontSize} Tf <${hex3(gid)}> Tj /${show.fontName} ${show.fontSize} Tf`;
    const repl = enc.encode(replacement), out = new Uint8Array(show.start + repl.length + raw.length - show.end);
    out.set(raw.slice(0, show.start));
    out.set(repl, show.start);
    out.set(raw.slice(show.end), show.start + repl.length);
    const stream2 = doc.addStream(out, {});
    if (contents.isArray()) {
      const a = doc.newArray();
      streams.forEach((s, i) => a.push(i === si ? stream2 : s));
      obj.put("Contents", a);
    } else obj.put("Contents", stream2);
    saved = doc.saveToBuffer("");
    const result = saved.asUint8Array().slice();
    check = new mupdf.PDFDocument(result);
    const originalDoc = new mupdf.PDFDocument(bytes2);
    let changed, originalPage, checkPage;
    try {
      originalPage = originalDoc.loadPage(pageIndex);
      checkPage = check.loadPage(pageIndex);
      changed = verifyResult(originalPage, checkPage, glyphs2, chars.at(-1), mupdf);
    } finally {
      originalPage?.destroy();
      checkPage?.destroy();
      originalDoc.destroy();
    }
    if (!changed) return null;
    return { bytes: result, report: { method: "source-stream-marker", pageIndex, sourceFont: show.fontName, font: face.postscriptName, changedPixels: changed } };
  } catch {
    return null;
  } finally {
    check?.destroy();
    saved?.destroy();
    font?.destroy();
    page?.destroy();
    doc?.destroy();
  }
}

// src/paragraph-pdf-marker-path.mjs
var near6 = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.025;
function glyphs(doc, index, mupdf) {
  const page = doc.loadPage(index), out = [];
  try {
    const m = mupdf.Matrix.invert(page.getTransform()), s = page.toStructuredText("preserve-whitespace");
    try {
      s.walk({ onChar(c, o, f, size3, quad) {
        out.push({ c, fontName: f.getName(), size: size3, pdf: [o[0] * m[0] + o[1] * m[2] + m[4], o[0] * m[1] + o[1] * m[3] + m[5]], quad: [...quad] });
      } });
    } finally {
      s.destroy();
    }
    return out;
  } finally {
    page.destroy();
  }
}
function normalize(gs) {
  let text3 = "", map = [];
  for (let i = 0; i < gs.length; i++) {
    let c = gs[i].c;
    if (/\s/u.test(c)) {
      if (text3.endsWith(" ")) {
        map[map.length - 1][1] = i;
        continue;
      }
      c = " ";
    }
    for (const unit of c.split("")) {
      text3 += unit;
      map.push([i, i]);
    }
  }
  return { text: text3, map };
}
function abort(signal) {
  if (signal?.aborted) throw new DOMException("PDF editing cancelled.", "AbortError");
}
async function trySourceMarkerEdits({ bytes: bytes2, edits, fontSnapshot, signal }, { mupdf, scanTextShows: scanTextShows2 }) {
  abort(signal);
  if (!(bytes2 instanceof Uint8Array) || !Array.isArray(edits) || !edits.length || !mupdf || !fontSnapshot?.fonts) return null;
  let original;
  try {
    original = new mupdf.PDFDocument(bytes2);
    if (original.needsPassword()) return null;
    const count = original.countPages(), cache = /* @__PURE__ */ new Map(), plans = [];
    for (const edit of edits) {
      abort(signal);
      if (!Number.isInteger(edit.pageIndex) || edit.pageIndex < 0 || edit.pageIndex >= count || typeof edit.before !== "string" || typeof edit.after !== "string" || !edit.before.trim()) return null;
      const before = [...edit.before], after = [...edit.after];
      if (before.length !== after.length) return null;
      const diff = before.map((c, i) => c !== after[i] ? i : -1).filter((i) => i >= 0);
      if (diff.length !== 1 || before[diff[0]].length !== 1 || after[diff[0]].length !== 1) return null;
      const all = cache.get(edit.pageIndex) || glyphs(original, edit.pageIndex, mupdf);
      cache.set(edit.pageIndex, all);
      const { text: text3, map } = normalize(all), needle = edit.before.replace(/\s+/g, " "), first = text3.indexOf(needle);
      if (first < 0 || text3.indexOf(needle, first + 1) >= 0) return null;
      const a = map[first][0], b = map[first + needle.length - 1][1];
      if (plans.some((p) => p.pageIndex === edit.pageIndex && a <= p.b && b >= p.a)) return null;
      const offset = first + before.slice(0, diff[0]).join("").replace(/\s+/g, " ").length, target = map[offset];
      if (!target || target[0] !== target[1] || all[target[0]].c !== before[diff[0]]) return null;
      plans.push({ edit, pageIndex: edit.pageIndex, a, b, target: target[0], replacement: after[diff[0]] });
    }
    let working = bytes2.slice();
    const reports = [];
    for (const plan of plans) {
      abort(signal);
      const current = new mupdf.PDFDocument(working);
      let all;
      try {
        all = glyphs(current, plan.pageIndex, mupdf);
      } finally {
        current.destroy();
      }
      const target = all[plan.target];
      if (!target) return null;
      let start = plan.target, end = plan.target;
      const same = (g) => g && g.fontName === target.fontName && near6(g.size, target.size) && near6(g.pdf[1], target.pdf[1]);
      while (start > 0 && same(all[start - 1])) start--;
      while (end + 1 < all.length && same(all[end + 1])) end++;
      if (end !== plan.target) return null;
      const run = all.slice(start, end + 1), face = fontSnapshot.fonts.find((f) => f.postscriptName === "LMRoman7-Regular");
      if (!face || !/^(?:[A-Z]{6}\+)?(?:CMR7|LMRoman7(?:-Regular)?)$/i.test(target.fontName)) return null;
      const result = await replaceMarkerGlyph({ bytes: working, pageIndex: plan.pageIndex, glyphs: run, after: run.slice(0, -1).map((g) => g.c).join("") + plan.replacement, fontSnapshot, fontPostscriptName: face.postscriptName, scanTextShows: scanTextShows2, mupdf });
      abort(signal);
      if (!result) return null;
      working = result.bytes;
      reports.push({ ...result.report, id: plan.edit.id });
    }
    return { bytes: working, pageCount: count, reports };
  } catch (error2) {
    abort(signal);
    return null;
  } finally {
    original?.destroy();
  }
}

// src/paragraph-pdf-content-operators.mjs
var ws = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
var delim = (c) => ws(c) || c === void 0 || "()<>[]{}/%".includes(String.fromCharCode(c));
var identity2 = () => [1, 0, 0, 1, 0, 0];
var mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
var translate = (m, x, y) => mul([1, 0, 0, 1, x, y], m);
function lexer(data, diagnostics) {
  let i = 0;
  const fail8 = (message, start) => {
    diagnostics.push({ message, offset: start });
    i = data.length;
    return null;
  };
  const skip = () => {
    while (i < data.length) {
      if (ws(data[i])) i++;
      else if (data[i] === 37) {
        while (i < data.length && data[i] !== 10 && data[i] !== 13) i++;
      } else break;
    }
  };
  function next() {
    skip();
    if (i >= data.length) return null;
    const start = i, c = data[i++];
    if (c === 40) {
      let depth = 1, out = [];
      while (i < data.length && depth) {
        let x = data[i++];
        if (x === 92) {
          if (i >= data.length) return fail8("Unterminated literal string", start);
          x = data[i++];
          if (x === 13 || x === 10) {
            if (x === 13 && data[i] === 10) i++;
            continue;
          }
          if (x >= 48 && x <= 55) {
            let n = x - 48, count = 1;
            while (count < 3 && data[i] >= 48 && data[i] <= 55) {
              n = n * 8 + data[i++] - 48;
              count++;
            }
            out.push(n & 255);
            continue;
          }
          out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[x] ?? x);
          continue;
        }
        if (x === 40) depth++;
        else if (x === 41 && --depth === 0) break;
        if (x === 13) {
          if (data[i] === 10) i++;
          x = 10;
        }
        out.push(x);
      }
      if (depth) return fail8("Unterminated literal string", start);
      return { type: "string", bytes: Uint8Array.from(out), start, end: i };
    }
    if (c === 60 && data[i] !== 60) {
      let hex4 = "";
      while (i < data.length && data[i] !== 62) {
        const x = data[i++];
        if (ws(x)) continue;
        const ch = String.fromCharCode(x);
        if (!/[0-9a-f]/i.test(ch)) return fail8("Invalid hex string", start);
        hex4 += ch;
      }
      if (i >= data.length) return fail8("Unterminated hex string", start);
      i++;
      if (hex4.length % 2) hex4 += "0";
      return { type: "string", bytes: Uint8Array.from(hex4.match(/../g) ?? [], (x) => parseInt(x, 16)), start, end: i };
    }
    if (c === 91 || c === 60 && data[i] === 60) {
      const dictionary = c === 60;
      if (dictionary) i++;
      const items = [];
      while (true) {
        skip();
        if (i >= data.length) return fail8("Unterminated composite object", start);
        if (!dictionary && data[i] === 93 || dictionary && data[i] === 62 && data[i + 1] === 62) {
          i += dictionary ? 2 : 1;
          break;
        }
        const t = next();
        if (!t) return null;
        items.push(t);
      }
      return { type: dictionary ? "dict" : "array", items, start, end: i };
    }
    if (c === 47) {
      let name = "";
      while (!delim(data[i])) {
        if (data[i] === 35 && /^[0-9a-f]{2}$/i.test(String.fromCharCode(data[i + 1] ?? 0, data[i + 2] ?? 0))) {
          name += String.fromCharCode(parseInt(String.fromCharCode(data[i + 1], data[i + 2]), 16));
          i += 3;
        } else name += String.fromCharCode(data[i++]);
      }
      return { type: "name", value: name, start, end: i };
    }
    if (delim(c)) return fail8("Unexpected delimiter", start);
    while (!delim(data[i])) i++;
    let value = "";
    for (let k = start; k < i; k++) value += String.fromCharCode(data[k]);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { type: "number", value: Number(value), start, end: i };
    if (["true", "false", "null"].includes(value)) return { type: "value", value, start, end: i };
    return { type: "operator", value, start, end: i };
  }
  return next;
}
function scanTextShows(input, { measure } = {}) {
  const diagnostics = [], shows = [];
  let data;
  if (input instanceof Uint8Array) data = input;
  else if (typeof input === "string") {
    data = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) > 255) {
        diagnostics.push({ message: "Input is not Latin-1", offset: i });
        return { shows, diagnostics };
      }
      data[i] = input.charCodeAt(i);
    }
  } else return { shows, diagnostics: [{ message: "Input must be Uint8Array or Latin-1 string", offset: 0 }] };
  const next = lexer(data, diagnostics);
  let s = { fontName: null, fontSize: 0, textMatrix: identity2(), lineMatrix: identity2(), ctm: identity2(), charSpace: 0, wordSpace: 0, hScale: 100, rise: 0, renderMode: 0, leading: 0 };
  let uncertain = false, lineUncertain = false, stateUncertain = false, inText = false, stack = [], args = [];
  const nums = (n) => args.length === n && args.every((t) => t.type === "number" && Number.isFinite(t.value));
  const bad = (t) => {
    diagnostics.push({ message: `Invalid operands for ${t.value}`, offset: t.start });
    uncertain = lineUncertain = stateUncertain = true;
  };
  const snapshot = () => ({ ...s, textMatrix: [...s.textMatrix], lineMatrix: [...s.lineMatrix], ctm: [...s.ctm] });
  const move = (x, y) => {
    s.lineMatrix = translate(s.lineMatrix, x, y);
    s.textMatrix = [...s.lineMatrix];
    uncertain = lineUncertain;
  };
  const harmless = /* @__PURE__ */ new Set(["w", "J", "j", "M", "d", "ri", "i", "m", "l", "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*", "CS", "cs", "SC", "SCN", "sc", "scn", "G", "g", "RG", "rg", "K", "k", "sh", "Do", "MP", "DP", "BMC", "BDC", "EMC", "BX", "EX", "d0", "d1"]);
  for (let t; t = next(); ) {
    if (t.type !== "operator") {
      args.push(t);
      continue;
    }
    const op = t.value, v = args.map((a) => a.value);
    if (op === "BI") {
      diagnostics.push({ message: "Inline image boundary cannot be proven; scanning stopped", offset: t.start });
      break;
    }
    if (op === "BT") {
      if (args.length) bad(t);
      s.textMatrix = identity2();
      s.lineMatrix = identity2();
      uncertain = lineUncertain = false;
      inText = true;
    } else if (op === "ET") {
      if (args.length) bad(t);
      inText = false;
    } else if (op === "q") {
      stack.push({ s: snapshot(), stateUncertain });
    } else if (op === "Q") {
      if (!stack.length) bad(t);
      else {
        const saved = stack.pop();
        const tm = s.textMatrix, lm = s.lineMatrix, u = uncertain, lu = lineUncertain;
        s = saved.s;
        stateUncertain = saved.stateUncertain;
        s.textMatrix = tm;
        s.lineMatrix = lm;
        uncertain = u;
        lineUncertain = lu;
      }
    } else if (op === "cm") {
      if (nums(6)) s.ctm = mul(v, s.ctm);
      else bad(t);
    } else if (op === "Tm") {
      if (nums(6)) {
        s.textMatrix = [...v];
        s.lineMatrix = [...v];
        uncertain = lineUncertain = false;
      } else bad(t);
    } else if (op === "Td" || op === "TD") {
      if (nums(2)) {
        if (op === "TD") s.leading = -v[1];
        move(...v);
      } else bad(t);
    } else if (op === "T*") {
      if (!args.length) move(0, -s.leading);
      else bad(t);
    } else if (op === "Tf") {
      if (args.length === 2 && args[0].type === "name" && args[1].type === "number") {
        s.fontName = v[0];
        s.fontSize = v[1];
      } else bad(t);
    } else if (["TL", "Tc", "Tw", "Tz", "Ts", "Tr"].includes(op)) {
      if (nums(1)) s[{ TL: "leading", Tc: "charSpace", Tw: "wordSpace", Tz: "hScale", Ts: "rise", Tr: "renderMode" }[op]] = v[0];
      else bad(t);
    } else if (["Tj", "TJ", "'", '"'].includes(op)) {
      const valid2 = op === "TJ" ? args.length === 1 && args[0].type === "array" && args[0].items.every((x) => x.type === "string" || x.type === "number") : op === '"' ? args.length === 3 && args[0].type === "number" && args[1].type === "number" && args[2].type === "string" : args.length === 1 && args[0].type === "string";
      if (!valid2 || !inText) {
        bad(t);
        args = [];
        continue;
      }
      if (op === '"') {
        s.wordSpace = v[0];
        s.charSpace = v[1];
      }
      if (op === "'" || op === '"') move(0, -s.leading);
      const src = op === "TJ" ? args[0].items : [args[args.length - 1]];
      const parts = src.map((x) => x.type === "string" ? { type: "string", bytes: x.bytes, start: x.start, end: x.end } : { type: "adjustment", value: x.value, start: x.start, end: x.end });
      shows.push({ start: args[0].start, end: t.end, operatorStart: t.start, operatorEnd: t.end, kind: op, parts, ...snapshot(), uncertain: uncertain || stateUncertain });
      let advance = 0, known = true;
      for (const p of parts) {
        if (p.type === "adjustment") advance -= p.value / 1e3 * s.fontSize;
        else {
          let n;
          try {
            n = measure?.(s.fontName, p.bytes, snapshot());
          } catch {
            n = NaN;
          }
          if (!Number.isFinite(n)) known = false;
          else advance += n;
        }
      }
      if (known) s.textMatrix = translate(s.textMatrix, advance * s.hScale / 100, 0);
      else uncertain = true;
    } else if (!harmless.has(op)) {
      diagnostics.push({ message: `Unknown operator ${op}`, offset: t.start });
      uncertain = lineUncertain = stateUncertain = true;
    }
    args = [];
  }
  if (args.length) diagnostics.push({ message: "Trailing operands without operator", offset: args[0].start });
  return { shows, diagnostics };
}

// src/paragraph-pdf.mjs
var COORDINATE_SPACE = "top-left-page";
var LIMITS2 = Object.freeze({ maxFileBytes: 25 * 1024 * 1024 });
var ParagraphPdfError = class extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ParagraphPdfError";
    this.code = code;
    this.details = details;
  }
};
function checkAbort(signal) {
  if (signal?.aborted) throw new ParagraphPdfError("aborted", "PDF editing cancelled.");
}
async function source(request) {
  checkAbort(request.signal);
  const file = request.file;
  if (Number.isFinite(file?.size) && file.size > LIMITS2.maxFileBytes) throw new ParagraphPdfError("limit", "PDF exceeds the 25 MiB size limit.");
  if (request.fileHash && (typeof request.fileHash !== "string" || !/^[a-f0-9]{64}$/i.test(request.fileHash))) throw new ParagraphPdfError("invalid", "fileHash must be a SHA-256 hexadecimal digest.");
  const bytes2 = file instanceof Uint8Array ? new Uint8Array(file) : file?.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : typeof file?.arrayBuffer === "function" ? new Uint8Array(await file.arrayBuffer()) : null;
  if (!bytes2?.length || bytes2.length > LIMITS2.maxFileBytes) throw new ParagraphPdfError("invalid", "A PDF within the size limit is required.");
  checkAbort(request.signal);
  const hash = hex(bytes2);
  if (request.fileHash && request.fileHash.toLowerCase() !== hash) throw new ParagraphPdfError("stale-source", "Source PDF differs from the inspected file.", { sourceSha256: hash });
  return { bytes: bytes2, hash };
}
function captureFonts(snapshot) {
  if (snapshot == null) return null;
  const invalid = () => {
    throw new ParagraphPdfError("invalid-font-snapshot", "Font snapshot failed validation.");
  };
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.fonts) || typeof snapshot.digest !== "string") invalid();
  const metadata = [];
  const fonts = snapshot.fonts.map((face) => {
    if (!face || !(face.bytes instanceof Uint8Array) || !face.bytes.length || typeof face.id !== "string" || !["local", "file", "bundled"].includes(face.source)) invalid();
    const bytes2 = face.bytes.slice();
    if (hex(bytes2) !== face.sha256) invalid();
    let parsed;
    try {
      parsed = parseFont(bytes2);
    } catch {
      invalid();
    }
    if (parsed.fsType & 256) throw new ParagraphPdfError("unsupported-font-license", "Paragraph editing cannot guarantee full embedding for this font.");
    for (const field of ["family", "postscriptName", "weight", "italic", "fsType"]) {
      if (face[field] !== parsed[field]) invalid();
    }
    const { bytes: ignored, ...descriptor } = face;
    metadata.push(descriptor);
    return { ...descriptor, bytes: bytes2 };
  });
  if (hex(new TextEncoder().encode(JSON.stringify(metadata))) !== snapshot.digest) invalid();
  return { revision: snapshot.revision, digest: snapshot.digest, fonts, selections: [] };
}
async function inspectPage(request = {}) {
  const fontSnapshot = captureFonts(request.fontSnapshot);
  const { bytes: bytes2, hash } = await source(request);
  const { engineFactory } = await loadRuntime();
  checkAbort(request.signal);
  const engine = await engineFactory(bytes2, fontSnapshot);
  try {
    const pageIndex = request.pageIndex;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= engine.pageCount) throw new ParagraphPdfError("invalid-page", "Page index is outside the document.");
    engine.loadPage(pageIndex);
    const paragraphs = engine.buildModel();
    const rotation = (engine.M._FPDFPage_GetRotation?.(engine.page) || 0) * 90;
    const width = engine.pageWidth, height = engine.pageHeight;
    const pageWidth = rotation % 180 ? height : width;
    const pageHeight = rotation % 180 ? width : height;
    const bbox = (box) => {
      const l = box.x, r = box.x + box.w, t = box.top, b = box.top - box.h;
      if (rotation === 90) return [b, l, t, r];
      if (rotation === 180) return [pageWidth - r, b, pageWidth - l, t];
      if (rotation === 270) return [pageHeight - t, pageWidth - r, pageHeight - b, pageWidth - l];
      return [l, pageHeight - t, r, pageHeight - b];
    };
    checkAbort(request.signal);
    const skippedParagraphs = [];
    const visible = [];
    paragraphs.forEach((p, index) => {
      const b = p?.box;
      if (!b || ![b.x, b.top, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0 || !Array.isArray(p.runs)) {
        skippedParagraphs.push({ index, sourceId: p?.id ?? null, code: "paragraph-geometry-unavailable" });
      } else visible.push({ p, index });
    });
    return {
      fileHash: hash,
      pageIndex,
      width,
      height,
      rotation,
      coordinateSpace: COORDINATE_SPACE,
      skippedParagraphs,
      paragraphs: visible.map(({ p, index }) => ({
        id: `p${pageIndex}-${index}-${hex(new TextEncoder().encode(JSON.stringify([p.box, p.runs.map((r) => r.text)]))).slice(0, 16)}`,
        // The engine resolves only source-proven line-end control markers.
        // IDs above continue to bind the untouched source geometry/raw runs.
        sourceId: p.id,
        text: canonicalParagraphText(p),
        bbox: bbox(p.box),
        fontName: p.runs[0]?.family || "",
        size: p.runs[0]?.size || 0,
        editable: p.editable !== false,
        runs: p.runs.map((r) => ({ text: r.text, fontName: r.family || "", size: r.size, rgba: r.rgba }))
      }))
    };
  } finally {
    engine.close();
  }
}
function lazyAnnotationAdapter(signal) {
  let shared;
  const load = () => shared || (shared = (async () => {
    checkAbort(signal);
    const mupdf = await import("./browser-pdf-vendor/mupdf.js");
    checkAbort(signal);
    return createAnnotationTransport({ mupdf });
  })());
  const invoke = (method) => async (input) => {
    checkAbort(signal);
    const adapter = await load();
    checkAbort(signal);
    const result = await adapter[method](input);
    checkAbort(signal);
    return result;
  };
  return Object.freeze({ inspect: invoke("inspect"), transport: invoke("transport"), validate: invoke("validate") });
}
function reconcileSourceWrap(paragraphs, before) {
  if (typeof before !== "string" || !before.trim()) return null;
  let raw = "", markers = /* @__PURE__ */ new Map();
  paragraphs.forEach((p, pi) => {
    if (pi) raw += "\n";
    const base = raw.length, text3 = p.runs.map((r) => r.text).join("");
    const starts = new Set((p.lines || []).map((l) => l.off));
    for (let i = 0; i < text3.length; i++) {
      if (text3.slice(i, i + 2) === "\uFFFC\xAD" && starts.has(i + 2) && /\p{L}/u.test(text3[i - 1] || "") && /\p{L}/u.test(text3[i + 2] || "")) markers.set(base + i, "pair");
      if (text3[i] === "" && /\p{L}/u.test(text3[i - 1] || "") && /\s/.test(text3[i + 1] || "") && /\p{L}/u.test(text3[i + 2] || "") && starts.has(i + 2)) markers.set(base + i, "control");
    }
    raw += text3;
  });
  if (![...markers.values()].includes("pair")) return null;
  const needle = before.replace(/\s+/g, " "), hits2 = /* @__PURE__ */ new Map();
  for (const pairMode of ["raw", "visible", "logical"]) for (const controlMode of ["visible", "logical"]) {
    const chars = [];
    for (let i = 0; i < raw.length; i++) {
      const kind = markers.get(i);
      if (kind === "pair" && pairMode !== "raw") {
        if (pairMode === "visible") {
          chars.push({ ch: "-", a: i, b: i + 1 }, { ch: " ", a: i, b: i + 1 });
        }
        i++;
        continue;
      }
      if (kind === "control") {
        if (controlMode === "visible") chars.push({ ch: "-", a: i, b: i });
        else {
          i++;
          continue;
        }
      } else chars.push({ ch: raw[i], a: i, b: i });
    }
    let norm = "", map = [];
    for (let i = 0; i < chars.length; i++) {
      let end = i;
      if (/\s/.test(chars[i].ch)) while (end + 1 < chars.length && /\s/.test(chars[end + 1].ch)) end++;
      norm += /\s/.test(chars[i].ch) ? " " : chars[i].ch;
      map.push([chars[i].a, chars[end].b]);
      i = end;
    }
    for (let at = norm.indexOf(needle); at >= 0; at = norm.indexOf(needle, at + 1)) {
      const a = map[at][0], b = map[at + needle.length - 1][1];
      const hasPair = [...markers].some(([offset, kind]) => kind === "pair" && offset >= a && offset + 1 <= b);
      const key3 = `${a}:${b}`;
      const prior = hits2.get(key3);
      hits2.set(key3, { a, b, reconciled: prior?.reconciled || pairMode !== "raw" && hasPair });
    }
  }
  if (![...hits2.values()].some((h) => h.reconciled)) return null;
  if (hits2.size !== 1) return { ambiguous: true, hits: hits2.size };
  const offsets = [...markers.keys()];
  for (let i = 0; i < offsets.length; i++) for (let j = i + 1; j < offsets.length; j++) {
    if (markers.get(offsets[i]) !== "pair" && markers.get(offsets[j]) !== "pair") continue;
    const between = raw.slice(offsets[i] + 2, offsets[j]).replace(/\ufffc\u00ad/g, "").replace(/\u0002\s/g, "").replace(/\s+/g, " ");
    if (between.length <= needle.length) return { unsupported: true };
  }
  const hit = hits2.values().next().value;
  return { before: raw.slice(hit.a, hit.b + 1) };
}
async function reconcileEdits(bytes2, edits, engineFactory, signal) {
  const engine = await engineFactory(bytes2), output = edits.map((e) => ({ ...e })), diagnostics = [];
  try {
    for (const pageIndex of new Set(edits.map((e) => e.pageIndex))) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= engine.pageCount) continue;
      checkAbort(signal);
      engine.loadPage(pageIndex);
      engine.normalizeFontsForEdit();
      const paragraphs = engine.buildModel();
      for (const edit of output.filter((e) => e.pageIndex === pageIndex)) {
        const result = reconcileSourceWrap(paragraphs, edit.before);
        if (result?.unsupported) throw new ParagraphPdfError("MATCH_FAILED", "Mixed source wraps cannot be uniquely reconciled.", { failures: [{ id: edit.id, pageIndex, code: "UNSUPPORTED_WRAP_COMBINATION" }] });
        if (result?.ambiguous) throw new ParagraphPdfError("MATCH_FAILED", "Edit could not be matched exactly once.", { failures: [{ id: edit.id, pageIndex, code: "AMBIGUOUS_MATCH", hits: result.hits }] });
        if (result) {
          diagnostics.push({ id: edit.id, pageIndex, code: "source_wrap_reconciled", originalBefore: edit.before, originalAfter: edit.after, evidence: "U+FFFC U+00AD immediately before source line start" });
          edit.before = result.before;
        }
      }
    }
  } finally {
    engine.close();
  }
  return { edits: output, diagnostics };
}
async function prepare(request = {}) {
  const fontSnapshot = captureFonts(request.fontSnapshot);
  let requestedEdits = request.edits;
  let fileHash = request.fileHash || "";
  if (requestedEdits && !Array.isArray(requestedEdits)) {
    if (requestedEdits.schema && requestedEdits.schema !== "falsify.paper-edits.v1") throw new ParagraphPdfError("invalid", "Unknown edit snapshot schema.");
    const embeddedHash = requestedEdits.fileHash;
    if (embeddedHash) {
      if (typeof embeddedHash !== "string" || !/^[a-f0-9]{64}$/i.test(embeddedHash)) throw new ParagraphPdfError("invalid", "Snapshot fileHash must be a SHA-256 hexadecimal digest.");
      if (fileHash && (typeof fileHash !== "string" || fileHash.toLowerCase() !== embeddedHash.toLowerCase())) throw new ParagraphPdfError("stale-source", "Request and snapshot hashes differ.");
      fileHash = embeddedHash;
    }
    requestedEdits = requestedEdits.edits;
  }
  const { bytes: bytes2, hash } = await source({ ...request, fileHash });
  if (!Array.isArray(requestedEdits)) throw new ParagraphPdfError("invalid", "An edits array or falsify.paper-edits.v1 snapshot is required.");
  const enabled = requestedEdits.filter((edit) => edit?.enabled !== false);
  if (!enabled?.length) throw new ParagraphPdfError("no-edits", "At least one enabled edit is required.");
  const edits = enabled.map((e, index) => ({ id: e?.id || `edit-${index}`, pageIndex: e?.pageIndex, before: e?.before, after: e?.after }));
  let marker = null;
  try {
    const mupdf = await import("./browser-pdf-vendor/mupdf.js");
    checkAbort(request.signal);
    marker = await trySourceMarkerEdits({ bytes: bytes2, edits, fontSnapshot, signal: request.signal }, { mupdf, scanTextShows });
  } catch {
    checkAbort(request.signal);
  }
  checkAbort(request.signal);
  if (marker) {
    const sha2563 = hex(marker.bytes), warnings2 = [];
    const pageMap = Array.from({ length: marker.pageCount }, (_, i) => ({ sourcePageIndex: i, outputPageIndex: i, continuationPageIndices: [] }));
    const verification2 = {
      schema: "falsify.paragraph-pdf.v1",
      engine: "MuPDF",
      license: RUNTIME.license,
      sourceSha256: hash,
      outputSha256: sha2563,
      fontSnapshotDigest: fontSnapshot?.digest ?? null,
      fontSelections: marker.reports.map((r) => ({ id: r.id, font: r.font, reason: "source marker substitution" })),
      status: "applied",
      layoutVerified: false,
      independent: false,
      coordinateSpace: COORDINATE_SPACE,
      pageCount: { source: marker.pageCount, output: marker.pageCount },
      edits: marker.reports,
      checks: [],
      warnings: warnings2,
      runtime: null,
      quality: { independent: false, method: "source-stream glyph origins and localized raster comparison", limitations: "Same-engine verification; independent visual QA is required." },
      reconciliation: [],
      report: { ok: true, method: "source-stream-marker", edits: marker.reports, pagination: { pages: { source: marker.pageCount, output: marker.pageCount }, sourcePageMap: pageMap, addedPages: 0 } }
    };
    const name2 = String(request.file?.name || "document.pdf").replace(/\.pdf$/i, "") + "-edited.pdf";
    return {
      file: new File([marker.bytes], name2, { type: "application/pdf" }),
      sha256: sha2563,
      verification: verification2,
      pageMap,
      warnings: warnings2
    };
  }
  const { engineFactory: createEngine, info } = await loadRuntime();
  let tableProof;
  try {
    const mupdf = await import("./browser-pdf-vendor/mupdf.js");
    checkAbort(request.signal);
    tableProof = await deriveSourceTables(bytes2, hash, mupdf);
  } catch {
    checkAbort(request.signal);
    tableProof = { sha: hash, unavailable: true };
  }
  const proofs = /* @__PURE__ */ new Map([[hash, tableProof]]);
  const engineFactory = async (input) => {
    const digest4 = input instanceof Uint8Array ? hex(input) : null;
    if (digest4 && !proofs.has(digest4)) {
      let proof;
      try {
        const mupdf = await import("./browser-pdf-vendor/mupdf.js");
        checkAbort(request.signal);
        proof = await deriveSourceTables(input, digest4, mupdf);
      } catch {
        checkAbort(request.signal);
        proof = { sha: digest4, unavailable: true };
      }
      proofs.set(digest4, proof);
    }
    const engine = await createEngine(input, fontSnapshot);
    const open = engine.open.bind(engine);
    engine.open = (data, ...args) => {
      const result = open(data, ...args);
      bindSourceTables(engine, data, data instanceof Uint8Array ? proofs.get(hex(data)) : null);
      return result;
    };
    if (input) bindSourceTables(engine, input, proofs.get(digest4));
    return engine;
  };
  checkAbort(request.signal);
  const reconciled = await reconcileEdits(bytes2, edits, engineFactory, request.signal);
  const { pdf, report } = await editPdf({ sourceBytes: bytes2, edits: reconciled.edits, reflow: true }, {
    engineFactory,
    runtimeInfo: info,
    draft: true,
    documentFlow: "compatible-groups",
    annotationAdapter: lazyAnnotationAdapter(request.signal)
  });
  checkAbort(request.signal);
  const sha2562 = hex(pdf);
  const warnings = [
    ...report.warnings || [],
    ...report.selfCheck?.warnings || [],
    { code: "edited_page_color_serialization", severity: "warning" }
  ];
  const status = report.ok === true && report.selfCheck?.status === "passed" ? warnings.some((w) => w.severity === "warning") ? "warning" : "applied" : "failed";
  const verification = {
    schema: "falsify.paragraph-pdf.v1",
    engine: RUNTIME.engine,
    license: RUNTIME.license,
    sourceSha256: hash,
    outputSha256: sha2562,
    fontSnapshotDigest: fontSnapshot?.digest ?? null,
    fontSelections: fontSnapshot?.selections ?? [],
    status,
    layoutVerified: false,
    independent: false,
    coordinateSpace: COORDINATE_SPACE,
    pageCount: report.pagination.pages,
    edits: report.edits,
    checks: (report.selfCheck?.failures || []).map((item) => ({ ...item, status: "failed" })),
    warnings,
    runtime: info,
    quality: { independent: false, method: "PDFium saved-file self-check", limitations: "Same-engine structural checks; independent typography and visual QA are required." },
    reconciliation: reconciled.diagnostics,
    report
  };
  const name = String(request.file?.name || "document.pdf").replace(/\.pdf$/i, "") + "-edited.pdf";
  return {
    file: new File([pdf], name, { type: "application/pdf" }),
    sha256: sha2562,
    verification,
    pageMap: report.pagination.sourcePageMap,
    warnings
  };
}

// src/paragraph-pdf-worker.mjs
self.onmessage = async ({ data }) => {
  const { id: id2, operation, bytes: bytes2, ...request } = data;
  try {
    if (operation !== "inspectPage" && operation !== "prepare") throw new Error("Unknown operation");
    const result = await (operation === "inspectPage" ? inspectPage : prepare)({ ...request, file: { name: request.name, bytes: new Uint8Array(bytes2) } });
    if (operation === "prepare") {
      const output = await result.file.arrayBuffer();
      self.postMessage({ id: id2, ok: true, result: { ...result, file: void 0 }, name: result.file.name, bytes: output }, [output]);
    } else self.postMessage({ id: id2, ok: true, result });
  } catch (error2) {
    self.postMessage({ id: id2, ok: false, error: { message: error2.message, code: error2.code || "engine", details: error2.details || {}, report: error2.report } });
  }
};

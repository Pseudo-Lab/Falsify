(() => {
  // app/src/browser-fonts.mjs
  var error = (message) => new Error(message);
  var key = (value) => String(value || "").replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[\s_-]+/g, "");
  var style = (value) => ({ weight: /bold/i.test(value || "") ? 700 : 400, italic: /italic|oblique/i.test(value || "") });
  function parseFont(bytes) {
    const bad = () => {
      throw error("\uC62C\uBC14\uB978 TTF \uB610\uB294 OTF \uAE00\uAF34 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    };
    if (!(bytes instanceof Uint8Array) || bytes.length < 12) bad();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => {
      if (o < 0 || o + 2 > bytes.length) bad();
      return view.getUint16(o);
    };
    const u32 = (o) => {
      if (o < 0 || o + 4 > bytes.length) bad();
      return view.getUint32(o);
    };
    const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
    const sig = u32(0);
    if (sig === 1953784678) throw error("\uAE00\uAF34 \uCEEC\uB809\uC158(TTC/OTC)\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E8\uC77C TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    if (sig !== 65536 && sig !== 1330926671 && sig !== 1953658213) bad();
    const count = u16(4), tables = /* @__PURE__ */ new Map();
    if (!count || 12 + count * 16 > bytes.length) bad();
    for (let i = 0; i < count; i++) {
      const p = 12 + i * 16, name = tag(p), offset = u32(p + 8), length = u32(p + 12);
      if (offset > bytes.length || length > bytes.length - offset || tables.has(name)) bad();
      tables.set(name, { offset, length });
    }
    if (tables.has("fvar")) throw error("\uAC00\uBCC0 \uAE00\uAF34\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uACE0\uC815 \uAD75\uAE30\uC758 TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    const names = tables.get("name"), os2 = tables.get("OS/2"), head = tables.get("head");
    if (!names || names.length < 6 || !os2 || os2.length < 64 || !head || head.length < 46) bad();
    const n = names.offset, entries = u16(n + 2), strings = n + u16(n + 4), end = n + names.length;
    if (n + 6 + entries * 12 > end || strings > end) bad();
    const values = /* @__PURE__ */ new Map();
    for (let i = 0; i < entries; i++) {
      const p = n + 6 + i * 12, platform = u16(p), encoding = u16(p + 2), language = u16(p + 4), id = u16(p + 6), length = u16(p + 8), start = strings + u16(p + 10);
      if (start > end || length > end - start) bad();
      if (![1, 2, 6, 16, 17].includes(id)) continue;
      let text;
      if (platform === 0 || platform === 3) {
        if (length % 2) bad();
        text = "";
        for (let j = 0; j < length; j += 2) text += String.fromCharCode(u16(start + j));
      } else if (platform === 1 && encoding === 0) text = String.fromCharCode(...bytes.subarray(start, start + length));
      else continue;
      text = text.replace(/\0/g, "").trim();
      const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 1033 ? 2 : 0);
      if (text && (!values.has(id) || values.get(id).score < score)) values.set(id, { text, score });
    }
    const get = (id) => values.get(id)?.text;
    const family = get(16) || get(1), postscriptName = get(6);
    if (!family) bad();
    const weight = u16(os2.offset + 4), fsType = u16(os2.offset + 8), selection = u16(os2.offset + 62), macStyle = u16(head.offset + 44);
    if (weight < 1 || weight > 1e3) bad();
    if (fsType & 512 || fsType & 2 && !(fsType & 12)) throw error("\uC774 \uAE00\uAF34\uC740 \uC784\uBCA0\uB529 \uC81C\uD55C \uB610\uB294 \uBE44\uD2B8\uB9F5 \uC804\uC6A9 \uC81C\uD55C\uC774 \uC788\uC5B4 PDF\uC5D0 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E4\uB978 \uAE00\uAF34\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    return { family, ...postscriptName ? { postscriptName } : {}, weight, italic: Boolean(selection & 1 || macStyle & 2), fsType };
  }
  async function sha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function familyKey(value) {
    let name = String(value || "").replace(/^[A-Z]{6}\+/, "");
    name = name.replace(/^(TimesNewRomanPS|Arial)-(BoldItalic|BoldOblique|Bold|Italic|Oblique)MT$/i, (_, family, variant) => `${/^arial$/i.test(family) ? "Arial" : "TimesNewRoman"}-${variant}`);
    name = name.replace(/[-,](?:bolditalic|boldoblique|bold|italic|oblique|regular|roman)$/i, "");
    const normalized = key(name);
    return { timesnewromanpsmt: "timesnewroman", arialmt: "arial" }[normalized] || normalized;
  }
  function matches(face, req) {
    const wanted = familyKey(req.family);
    return !!wanted && (familyKey(face.family) === wanted || familyKey(face.postscriptName) === wanted);
  }
  function rank(face, req) {
    const suffix = String(req.family || "").match(/[-,](bolditalic|boldoblique|bold|italic|oblique|regular|roman)(?:mt)?$/i)?.[1] || "";
    const bold = req.bold || /bold/i.test(suffix), italic = req.italic || /italic|oblique/i.test(suffix);
    return (face.italic === !!italic ? 0 : 1e3) + Math.abs(face.weight - (bold ? 700 : 400));
  }
  function metadata(face) {
    const { id, family, postscriptName, weight, italic, source, fsType } = face;
    return { id, family, ...postscriptName ? { postscriptName } : {}, weight, italic, source, ...fsType === void 0 ? {} : { fsType } };
  }
  function createBrowserFontStore(options = {}) {
    let revision = 0, faces2 = [], epoch = 0, requestSerial = 0;
    const stale = () => error("\uAE00\uAF34 \uBAA9\uB85D\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.");
    const materialize = async (face, expectedEpoch) => {
      if (!face.bytes) {
        let raw;
        try {
          raw = new Uint8Array(await (await face.fontData.blob()).arrayBuffer());
        } catch {
          throw error("\uB85C\uCEEC \uAE00\uAF34\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uAC70\uB098 \uAE00\uAF34 \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
        }
        const parsed = parseFont(raw);
        const hash = await sha256(raw);
        if (epoch !== expectedEpoch) throw stale();
        Object.assign(face, parsed, { bytes: raw.slice(), sha256: hash });
      }
      return face;
    };
    return {
      get revision() {
        return revision;
      },
      list() {
        return faces2.map(metadata);
      },
      clear() {
        epoch++;
        requestSerial++;
        if (faces2.length) {
          faces2 = [];
          revision++;
        }
      },
      async requestLocalFonts() {
        const query = options.queryLocalFonts ?? globalThis.queryLocalFonts;
        if (typeof query !== "function") throw error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uB294 \uB85C\uCEEC \uAE00\uAF34 \uC811\uADFC\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. TTF \uB610\uB294 OTF \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
        const serial = ++requestSerial, expectedEpoch = ++epoch;
        if (faces2.some((f) => f.source === "local")) {
          faces2 = faces2.filter((f) => f.source !== "local");
          revision++;
        }
        let result;
        try {
          result = await query.call(globalThis);
        } catch {
          throw error("\uB85C\uCEEC \uAE00\uAF34 \uC811\uADFC\uC774 \uAC70\uBD80\uB418\uC5C8\uAC70\uB098 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uBE0C\uB77C\uC6B0\uC800 \uAD8C\uD55C\uC744 \uD655\uC778\uD55C \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
        }
        if (serial !== requestSerial || epoch !== expectedEpoch) throw stale();
        const next = [], existing = /* @__PURE__ */ new Set();
        for (const fontData of result) {
          if (!fontData.family || !fontData.postscriptName || typeof fontData.blob !== "function") continue;
          const id = `local:${fontData.postscriptName}`;
          if (existing.has(id)) continue;
          existing.add(id);
          next.push({ id, family: fontData.family, postscriptName: fontData.postscriptName, ...style(fontData.style), source: "local", fontData });
        }
        const previous = faces2.filter((f) => f.source === "local");
        if (previous.length || next.length) {
          faces2 = [...faces2.filter((f) => f.source !== "local"), ...next];
          revision++;
          epoch++;
        }
        return faces2.map(metadata);
      },
      async addFiles(fileList) {
        const expectedEpoch = epoch;
        const staged = [];
        for (const file of Array.from(fileList || [])) {
          if (!/\.(ttf|otf)$/i.test(file.name || "")) throw error("TTF \uB610\uB294 OTF \uAE00\uAF34 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
          let bytes;
          try {
            bytes = new Uint8Array(await file.arrayBuffer());
          } catch {
            throw error("\uAE00\uAF34 \uD30C\uC77C\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uB2E4\uC2DC \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
          }
          const parsed = parseFont(bytes), hash = await sha256(bytes);
          staged.push({ id: `file:${hash}`, ...parsed, source: "file", bytes: bytes.slice(), sha256: hash });
        }
        if (epoch !== expectedEpoch) throw stale();
        const ids = new Set(faces2.map((f) => f.id));
        let changed = false;
        for (const face of staged) if (!ids.has(face.id)) {
          faces2.push(face);
          ids.add(face.id);
          changed = true;
        }
        if (changed) {
          revision++;
          epoch++;
        }
        return faces2.map(metadata);
      },
      async resolve(requirements, { fallbackFonts = [] } = {}) {
        const selected = [], notes = [], expectedEpoch = epoch, snapshotRevision = revision;
        const snapshot = faces2.slice();
        for (const req of requirements || []) {
          const candidates = snapshot.filter((f) => matches(f, req)).sort((a, b) => rank(a, req) - rank(b, req));
          for (const candidate of candidates) {
            try {
              const face = await materialize(candidate, expectedEpoch);
              if (matches(face, req)) {
                if (!selected.includes(face)) selected.push(face);
                break;
              }
            } catch (cause) {
              if (epoch !== expectedEpoch) throw stale();
              if (candidate.source !== "local") throw cause;
              notes.push({ id: candidate.id, message: cause.message });
            }
          }
        }
        for (const fallback of fallbackFonts) {
          const bytes = new Uint8Array(fallback.bytes).slice(), parsed = parseFont(bytes), hash = await sha256(bytes);
          if (!selected.some((f) => f.sha256 === hash)) selected.push({ id: fallback.id || `bundled:${hash}`, ...parsed, source: "bundled", bytes, sha256: hash });
        }
        const snapshotFaces = selected.map((face) => ({ ...metadata(face), sha256: face.sha256, bytes: face.bytes.slice() }));
        const digestInput = new TextEncoder().encode(JSON.stringify(snapshotFaces.map(({ bytes, ...rest }) => rest)));
        const digest = await sha256(digestInput);
        if (epoch !== expectedEpoch) throw stale();
        return { revision: snapshotRevision, digest, fonts: snapshotFaces, notes };
      }
    };
  }

  // app/src/bundled-fonts.mjs
  var faces = [
    ["Liberation Sans", "LiberationSans-Regular", 400, false, "vendor/standard_fonts/LiberationSans-Regular.ttf", "f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f"],
    ["Liberation Sans", "LiberationSans-Bold", 700, false, "vendor/standard_fonts/LiberationSans-Bold.ttf", "361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc"],
    ["Liberation Sans", "LiberationSans-Italic", 400, true, "vendor/standard_fonts/LiberationSans-Italic.ttf", "832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512"],
    ["Liberation Sans", "LiberationSans-BoldItalic", 700, true, "vendor/standard_fonts/LiberationSans-BoldItalic.ttf", "a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d"],
    ["Liberation Serif", "LiberationSerif-Regular", 400, false, "font-assets/LiberationSerif-Regular.ttf", "9caef765d2e891c10dd73658894f01e660fe0c1c83e0bda7d6edf561d8f623d4"],
    ["Liberation Serif", "LiberationSerif-Bold", 700, false, "font-assets/LiberationSerif-Bold.ttf", "443a4dbd694b6e4689925947b456e0532e10b19c90fa32eb39ea6c2cd9db9ebd"],
    ["Liberation Serif", "LiberationSerif-Italic", 400, true, "font-assets/LiberationSerif-Italic.ttf", "de18fe26337e03241952dca46398d5b66f3c5738d080bfd284f66e67b926f597"],
    ["Liberation Serif", "LiberationSerif-BoldItalic", 700, true, "font-assets/LiberationSerif-BoldItalic.ttf", "4b2635d2ec4d992373dcae577c742a98ecfd841ffc1b8a103b5f10db163dbc7a"],
    ["STIX Two Math", "STIXTwoMath-Regular", 400, false, "font-assets/STIXTwoMath-Regular.otf", "f2076b9f1676438439dd41e23676f5ab99056e83d6b8f8c27841591ef2ccfa72"],
    ["Noto Sans CJK KR", "NotoSansCJKkr-Regular", 400, false, "font-assets/NotoSansCJKkr-Regular.otf", "6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a"],
    ["Noto Serif CJK KR", "NotoSerifCJKkr-Regular", 400, false, "font-assets/NotoSerifCJKkr-Regular.otf", "77b4b741f864d27f15e90f275b17106dde90b2ad28f82bab72dc95805db5fb42"]
  ];
  var caches = /* @__PURE__ */ new WeakMap();
  var cjk = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7ff\uf900-\ufaff]|[\u{20000}-\u{3134f}]/u;
  var math = /[\u2200-\u22ff\u27c0-\u27ef\u2980-\u2aff\u{1d400}-\u{1d7ff}]/u;
  var serifNames = /* @__PURE__ */ new Set(["serif", "liberation serif", "times", "times new roman", "noto serif cjk kr"]);
  var sansNames = /* @__PURE__ */ new Set(["sans-serif", "sans", "liberation sans", "arial", "noto sans cjk kr"]);
  async function load(face, fetcher) {
    let cache = caches.get(fetcher);
    if (!cache) caches.set(fetcher, cache = /* @__PURE__ */ new Map());
    const [family, postscriptName, weight, italic, path, sha2562] = face;
    if (!cache.has(path)) {
      const pending = (async () => {
        const response = await fetcher(`./${path}`);
        if (!response.ok) throw new Error(`Font fetch failed: ${path} (${response.status})`);
        const bytes2 = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes2));
        const actual = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        if (actual !== sha2562) throw new Error(`Font hash mismatch: ${path}`);
        return bytes2;
      })();
      cache.set(path, pending);
      pending.catch(() => {
        if (cache.get(path) === pending) cache.delete(path);
      });
    }
    const bytes = await cache.get(path);
    return { id: `bundled:${postscriptName}`, family, postscriptName, weight, italic, bytes: bytes.slice(), source: "bundled", sha256: sha2562 };
  }
  async function getBundledFonts(requirements, { fetch = globalThis.fetch } = {}) {
    const selected = /* @__PURE__ */ new Set();
    for (const requirement of requirements) {
      const name = String(requirement.family || "").trim().toLowerCase();
      const text = String(requirement.text || "");
      const families = serifNames.has(name) ? ["Liberation Serif"] : sansNames.has(name) ? ["Liberation Sans"] : ["Liberation Sans", "Liberation Serif"];
      for (const family of families) {
        selected.add(faces.find((f) => f[0] === family && f[2] === (requirement.bold ? 700 : 400) && f[3] === !!requirement.italic));
      }
      if (math.test(text) || name === "stix two math") selected.add(faces[8]);
      if (cjk.test(text) || name === "noto sans cjk kr" || name === "noto serif cjk kr") {
        if (!serifNames.has(name)) selected.add(faces[9]);
        if (!sansNames.has(name)) selected.add(faces[10]);
      }
    }
    return Promise.all([...selected].map((face) => load(face, fetch)));
  }

  // app/src/paper-font-service.mjs
  function createPaperFontService({ store = createBrowserFontStore(), bundled = getBundledFonts } = {}) {
    return Object.freeze({
      get revision() {
        return store.revision;
      },
      list: () => store.list(),
      requestLocalFonts: () => store.requestLocalFonts(),
      addFiles: (files) => store.addFiles(files),
      async resolve(requirements) {
        const fallbackFonts = await bundled(requirements);
        const text = requirements.map((r) => r.text || "").join("\n");
        const added = store.list().filter((f) => f.source === "file").map((f) => ({ family: f.family, bold: f.weight >= 600, italic: f.italic, text }));
        return store.resolve([...requirements, ...added], { fallbackFonts });
      },
      clear: () => store.clear()
    });
  }
  if (typeof window !== "undefined") window.FalsifyFonts = createPaperFontService();
})();

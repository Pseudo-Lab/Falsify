// Public fallback faces; see docs/font-catalog.md for provenance and coverage.
const faces = [
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
  ["Noto Serif CJK KR", "NotoSerifCJKkr-Regular", 400, false, "font-assets/NotoSerifCJKkr-Regular.otf", "77b4b741f864d27f15e90f275b17106dde90b2ad28f82bab72dc95805db5fb42"],
];
const caches = new WeakMap();
const cjk = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7ff\uf900-\ufaff]|[\u{20000}-\u{3134f}]/u;
const math = /[\u2200-\u22ff\u27c0-\u27ef\u2980-\u2aff\u{1d400}-\u{1d7ff}]/u;
const serifNames = new Set(["serif", "liberation serif", "times", "times new roman", "noto serif cjk kr"]);
const sansNames = new Set(["sans-serif", "sans", "liberation sans", "arial", "noto sans cjk kr"]);

async function load(face, fetcher) {
  let cache = caches.get(fetcher);
  if (!cache) caches.set(fetcher, cache = new Map());
  const [family, postscriptName, weight, italic, path, sha256] = face;
  if (!cache.has(path)) {
    const pending = (async () => {
      const response = await fetcher(`./${path}`);
      if (!response.ok) throw new Error(`Font fetch failed: ${path} (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
      const actual = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
      if (actual !== sha256) throw new Error(`Font hash mismatch: ${path}`);
      return bytes;
    })();
    cache.set(path, pending);
    pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
  }
  const bytes = await cache.get(path);
  return {id: `bundled:${postscriptName}`, family, postscriptName, weight, italic, bytes: bytes.slice(), source: "bundled", sha256};
}

export async function getBundledFonts(requirements, {fetch = globalThis.fetch} = {}) {
  const selected = new Set();
  for (const requirement of requirements) {
    const name = String(requirement.family || "").trim().toLowerCase();
    const text = String(requirement.text || "");
    const families = serifNames.has(name) ? ["Liberation Serif"] : sansNames.has(name) ? ["Liberation Sans"] : ["Liberation Sans", "Liberation Serif"];
    for (const family of families) {
      selected.add(faces.find(f => f[0] === family && f[2] === (requirement.bold ? 700 : 400) && f[3] === !!requirement.italic));
    }
    if (math.test(text) || name === "stix two math") selected.add(faces[8]);
    if (cjk.test(text) || name === "noto sans cjk kr" || name === "noto serif cjk kr") {
      if (!serifNames.has(name)) selected.add(faces[9]);
      if (!sansNames.has(name)) selected.add(faces[10]);
    }
  }
  return Promise.all([...selected].map(face => load(face, fetch)));
}

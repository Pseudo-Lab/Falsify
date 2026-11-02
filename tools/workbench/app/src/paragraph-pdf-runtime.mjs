import {PdfEngine} from './paragraph-vendor/engine/core.js';
import {hex} from './paragraph-pdf-crypto.mjs';
import overlay from './paragraph-vendor/overlay.json' with {type: 'json'};

export const RUNTIME = Object.freeze({
  engine: 'BentoPDF/PDFium', license: 'AGPL-3.0-only',
  bentopdfCommit: '3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97',
  engineCommit: '813903c93c758dfb8df46dbd34ace3b7f7a8538b',
  moduleCommit: 'cd4ba2cdd68ae7e51198f615bd4ac6130206b162',
  moduleOverlayCommit: overlay.commit,
  jsSha256: 'cbef240d8893fd9624c08eadbb1ffb405a583c96878d6a14d11d8e9816c0832b',
  wasmSha256: '7674fe4cce4a8e15d702b02988610891693ac68f6121b4621e237949736778cb',
  sourceBuildVerified: false, trust: 'locally-supplied-hash-verified-artifacts',
});

let runtime;
export async function loadRuntime() {
  if (!runtime) runtime = initialize().catch(error => { runtime = null; throw error; });
  return runtime;
}

async function initialize() {
  // Only fixed same-origin runtime resources are fetched. PDF bytes never leave
  // the worker. Hash the glue before importing it, and WASM before instantiation.
  const asset = name => {
    const url = new URL('./paragraph-vendor/' + name, import.meta.url);
    url.searchParams.set('sha256', name.endsWith('.wasm') ? RUNTIME.wasmSha256 : RUNTIME.jsSha256);
    return url;
  };
  const fetchBytes = async name => {
    const response = await fetch(asset(name), {credentials: 'same-origin'});
    if (!response.ok) throw new Error('Paragraph runtime resource unavailable: ' + name);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [js, wasm] = await Promise.all([fetchBytes('editcore.js'), fetchBytes('editcore.wasm')]);
  if (hex(js) !== RUNTIME.jsSha256 || hex(wasm) !== RUNTIME.wasmSha256) {
    throw Object.assign(new Error('Paragraph runtime digest mismatch'), {code: 'runtime-hash-mismatch'});
  }
  const {default: createModule} = await import(/* @vite-ignore */ asset('editcore.js').href);
  const engineFactory = async (bytes, fontSnapshot = null) => {
    const M = await createModule({wasmBinary: wasm, print() {}, printErr() {}});
    const cfg = M._malloc(48);
    M.HEAPU8.fill(0, cfg, cfg + 48);
    M.HEAPU32[cfg >> 2] = 2;
    M._FPDF_InitLibraryWithConfig(cfg);
    M._free(cfg);
    const engine = new PdfEngine(M, fontSnapshot);
    try { if (bytes) engine.open(new Uint8Array(bytes)); }
    catch (error) { engine.close(); throw error; }
    return engine;
  };
  return {engineFactory, info: RUNTIME};
}

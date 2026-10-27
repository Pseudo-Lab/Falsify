import {prepare as recompose, bindEdits} from './paper-recompose.mjs';
import {readDocument} from './paper-document.mjs';
import {buildPaperFlow} from './paper-flow.mjs';
import {createTypstCompile} from './paper-typst.mjs';
import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const hashOK=x=>typeof x==='string' && /^[a-f0-9]{64}$/i.test(x);

// The manifest lives in recomposition-vendor; only its descendants are assets.
export function resolveAsset(path, manifestURL) {
  if(typeof path!=='string' || !path || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) fail('asset-path','Invalid bundled asset path');
  const base=new URL('.',manifestURL), url=new URL(path,base);
  if(url.origin!==base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password) fail('asset-path','Asset escapes the bundled vendor directory');
  return url.href;
}
export async function loadAssets(manifestURL, fetcher=fetch) {
  const manifest=new URL(manifestURL), base=new URL('../',manifest);
  const response=await fetcher(manifest.href,{credentials:'omit',redirect:'error'});
  if(!response.ok) fail('asset-load','Cannot load recomposition manifest');
  const m=await response.json();
  if(m?.version!=='falsify.recomposition-runtime.v1' || m.compilerModule!=='../recomposition-typst.mjs' || !m.wasm || !Array.isArray(m.fonts)) fail('asset-manifest','Invalid recomposition manifest');
  const ids=new Set();
  async function asset(x) {
    if(!hashOK(x?.sha256)) fail('asset-manifest','Invalid asset hash');
    const url=resolveAsset(x.url,manifest.href), r=await fetcher(url,{credentials:'omit',redirect:'error'});
    if(!r.ok) fail('asset-load','Cannot load bundled asset');
    const bytes=new Uint8Array(await r.arrayBuffer());
    if(await digest(bytes)!==x.sha256.toLowerCase()) fail('asset-hash','Bundled asset hash mismatch');
    return bytes;
  }
  const wasm=await asset(m.wasm), fonts=[];
  for(const f of m.fonts) {if(typeof f.id!=='string'||!f.id||ids.has(f.id)||typeof f.family!=='string'||!f.family) fail('asset-manifest','Invalid font descriptor');ids.add(f.id);fonts.push({id:f.id,family:f.family,bytes:await asset(f)});}
  return {wasm,fonts,compilerURL:new URL('recomposition-typst.mjs',base).href};
}

// Map native character occurrences only when both scalar and bounding box are unique.
export function remapBindings(original, prepared, selections) {
  const bad=()=>fail('source-binding','Cannot map the original selection exactly after footer cleanup');
  if(original.pages.length!==prepared.pages.length) bad();
  const out=[];
  for(const selection of selections) {
    const parts=[];
    for(const p of selection.parts || []) {
      const ob=original.blocks.find(b=>b.id===p.blockId), op=original.pages[p.pageIndex], np=prepared.pages[p.pageIndex];
      if(!ob || !op || !np || JSON.stringify([op.width,op.height,op.geometry])!==JSON.stringify([np.width,np.height,np.geometry]) || ob.source.pageIndex!==p.pageIndex || ob.text.slice(p.start-ob.source.range.start,p.end-ob.source.range.start)!==p.before) bad();
      const selected=ob.source.characters.filter(c=>c.start>=p.start && c.end<=p.end);
      if(!selected.length || selected[0].start!==p.start || selected.at(-1).end!==p.end || selected.some((c,i)=>i && selected[i-1].end!==c.start)) bad();
      for(const c of selected) {
        const scalar=ob.text.slice(c.start-ob.source.range.start,c.end-ob.source.range.start);
        if([...scalar].length!==1 || !Array.isArray(c.bbox) || c.bbox.length!==4 || !c.bbox.every(Number.isFinite)) bad();
        const matching=(doc)=>doc.blocks.filter(b=>b.text && b.source.pageIndex===p.pageIndex).flatMap(b=>(b.source.characters||[]).filter(x=>JSON.stringify(x.bbox)===JSON.stringify(c.bbox) && b.text.slice(x.start-b.source.range.start,x.end-b.source.range.start)===scalar).map(x=>({b,x})));
        if(matching(original).length!==1) bad();
        const hits=matching(prepared); if(hits.length!==1) bad();
        const {b,x}=hits[0], last=parts.at(-1);
        if(last && last.blockId===b.id && last.end===x.start) {last.end=x.end;last.before+=scalar;}
        else parts.push({blockId:b.id,pageIndex:p.pageIndex,start:x.start,end:x.end,before:scalar});
      }
    }
    if(!parts.length) bad();
    out.push({...selection,sourceSha256:prepared.sourceSha256,parts});
  }
  return out;
}

export async function runRequest(request, deps={}) {
  const input=request.file instanceof Uint8Array?request.file:request.file instanceof ArrayBuffer?new Uint8Array(request.file):request.file?.bytes instanceof Uint8Array?request.file.bytes:new Uint8Array(await request.file.arrayBuffer());
  const original=Uint8Array.from(input), originalHash=await digest(original);
  const snapshot=Array.isArray(request.edits)?{edits:request.edits}:structuredClone(request.edits);
  if(!snapshot || !Array.isArray(snapshot.edits)) fail('invalid','Expected edits');
  if(request.fileHash == null && snapshot.fileHash == null) fail('stale-source','Original source hash is required');
  for(const h of [request.fileHash,snapshot.fileHash].filter(x=>x!==undefined && x!==null)) if(!hashOK(h) || h.toLowerCase()!==originalHash) fail('stale-source','Original source hash mismatch');
  const clean=deps.clean || (await import('../dist/blind-pdf.mjs')).prepare;
  const cleaned=await clean({file:{bytes:original.slice()}}), bytes=cleaned.file?.bytes instanceof Uint8Array?Uint8Array.from(cleaned.file.bytes):new Uint8Array(await cleaned.file.arrayBuffer()), preparedHash=await digest(bytes);
  if(cleaned.sha256!==preparedHash) fail('source-binding','Cleaned source hash mismatch');
  let bindings=structuredClone(request.bindings || []);
  if(cleaned.changed) {
    const read=deps.readDocument || readDocument;
    const old=await read({file:original,fileHash:originalHash}), now=await read({file:bytes,fileHash:preparedHash});
    const originalBindings=bindings.filter(b=>b.sourceSha256===originalHash), cleanedBindings=bindings.filter(b=>b.sourceSha256===preparedHash);
    if(originalBindings.length+cleanedBindings.length!==bindings.length) fail('stale-source','Explicit selection source hash mismatch');
    const covered=new Set(bindings.map(b=>b.id != null ? `id:${b.id}` : `index:${b.index}`));
    const unbound=snapshot.edits.map((e,i)=>({e,i})).filter(({e,i})=>e.enabled!==false && !covered.has(`id:${e.id}`) && !covered.has(`index:${i}`));
    if(unbound.length) {
      const resolved=bindEdits(old,buildPaperFlow(old),unbound.map(x=>x.e));
      for(const [j,b] of resolved.bindings.entries()) originalBindings.push({index:unbound[j].i,sourceSha256:originalHash,parts:b.parts});
    }
    bindings=[...cleanedBindings,...remapBindings(old,now,originalBindings)];
  }
  const assets=deps.assets || await loadAssets(new URL('./recomposition-vendor/manifest.json',import.meta.url).href);
  const facade=deps.facade || await import(assets.compilerURL);
  const module=deps.compile ? null : await WebAssembly.compile(assets.wasm);
  const compile=deps.compile || createTypstCompile({...facade,getModule:()=>module});
  const pdfjs=deps.pdfjs || await import(new URL('./vendor/pdf.mjs',import.meta.url).href);
  if(pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
  const result=await (deps.recompose || recompose)({file:bytes,fileHash:preparedHash,edits:{...snapshot,fileHash:preparedHash,revision:request.revision},bindings,revision:request.revision},{compile,fonts:assets.fonts,mupdf,pdfjs,runningFurniture:true});
  return {...result,sourceBinding:{...result.sourceBinding,originalSha256:originalHash,preparedSha256:preparedHash,cleanup:cleaned.verification}};
}

// Importing this module in Node does not register a handler.
if(typeof WorkerGlobalScope!=='undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage=async ({data})=>{
    if(data?.type!=='prepare' || !Number.isSafeInteger(data.id)) return;
    try {const result=await runRequest(data.request);globalThis.postMessage({id:data.id,type:'result',result});}
    catch(e) {globalThis.postMessage({id:data.id,type:'error',error:{message:String(e?.message || e),code:e?.code,details:e?.details}});}
  };
}

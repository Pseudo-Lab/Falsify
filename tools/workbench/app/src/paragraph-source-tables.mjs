// Internal source-only provenance. A model is derived from verified private
// bytes, never from request-provided rectangles, and is attached only to an
// engine opened on that exact source digest.
import {detectSourceTables} from './table-adapter.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

const bindings=new WeakMap();
export async function deriveSourceTables(bytes, sha, mupdf) {
  const model=await detectSourceTables({sourceBytes:bytes,sourceSha256:sha,revision:'paragraph-source',mupdf});
  return {sha, pages:model.pages.map(p=>({width:p.width,height:p.height,rotation:p.rotation})),
    cells:model.tables.filter(t=>t.ruled).flatMap(t=>t.cells.map(c=>({pageIndex:t.pageIndex,bbox:[...c.bbox]})))};
}
export function bindSourceTables(engine, bytes, provenance) {
  bindings.delete(engine);
  if(bytes instanceof Uint8Array && provenance && hex(bytes)===provenance.sha) bindings.set(engine,provenance);
}
export function sourceTableCells(engine) {
  const proof=bindings.get(engine);
  if(!proof) return null;
  if(proof.unavailable || typeof engine.M._FPDF_GetPageCount!=='function' || engine.M._FPDF_GetPageCount(engine.doc)!==proof.pages.length) return null;
  const page=proof.pages[engine.pageIndex];
  const t=engine.pageT || [1,0,0,1,0,0];
  if(!page || page.rotation!==0 || typeof engine.M._FPDFPage_GetRotation!=='function' || engine.M._FPDFPage_GetRotation(engine.page)!==0 ||
      t.length!==6 || t.some((v,i)=>!Number.isFinite(v)||Math.abs(v-[1,0,0,1,0,0][i])>1e-4) ||
      Math.abs(engine.pageWidth-page.width)>.01 || Math.abs(engine.pageHeight-page.height)>.01) return null;
  return proof.cells.filter(c=>c.pageIndex===engine.pageIndex).map(({bbox:[l,top,r,bottom]})=>({l,r,b:page.height-bottom,t:page.height-top}));
}
export const inSourceTableCell=(b,cells)=>cells.some(c=>b.l>=c.l-.1&&b.r<=c.r+.1&&b.b>=c.b-.1&&b.t<=c.t+.1);

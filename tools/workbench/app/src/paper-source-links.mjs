import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) { const e=new Error('Source link reading cancelled'); e.name='AbortError'; throw e; } };
const box = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<b[2] && b[1]<b[3];
// MuPDF text and annotation bounds can differ by subpixel rounding in display points.
export const SOURCE_LINK_TOLERANCE = 0.1;
export const sourceGlyphInsideLink = (a,b) => a[0]>=b[0]-SOURCE_LINK_TOLERANCE && a[1]>=b[1]-SOURCE_LINK_TOLERANCE && a[2]<=b[2]+SOURCE_LINK_TOLERANCE && a[3]<=b[3]+SOURCE_LINK_TOLERANCE;
const overlaps = (a,b) => a[0]<b[2] && b[0]<a[2] && a[1]<b[3] && b[1]<a[3];
const pointIn = (p,b) => box(b) && p[0]>=b[0] && p[0]<=b[2] && p[1]>=b[1] && p[1]<=b[3];
const freeze = value => { if (value && typeof value==='object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i)=>Number.isFinite(v) && Math.abs(v-b[i])<0.01);

function sourceRelation(document, pageIndex, bounds, verified) {
  if (!verified || !box(bounds)) return {status:'unresolved',reason:verified?'invalid-link-bounds':'page-frame-unverified',ranges:[],assetIds:[]};
  const blocks=(document.blocks || []).filter(b=>b.source?.pageIndex===pageIndex && b.source.range && Array.isArray(b.source.characters));
  const selected=[];
  for (const block of blocks) for (const c of block.source.characters) {
    if (box(c.bbox) && sourceGlyphInsideLink(c.bbox,bounds)) selected.push({block,c});
  }
  // A glyph geometrically shared by multiple characters has no unique owner.
  const ambiguous=selected.some((x,i)=>selected.some((y,j)=>i!==j && same(x.c.bbox,y.c.bbox)));
  const ranges=[];
  if (!ambiguous) for (const {block,c} of selected) {
    const last=ranges.at(-1);
    if (last && last.blockId===block.id && last.end===c.start) last.end=c.end;
    else ranges.push({blockId:block.id,start:c.start,end:c.end});
  }
  const assetIds=(document.assets || []).filter(a=>a.source?.pageIndex===pageIndex && box(a.source.bbox) && overlaps(a.source.bbox,bounds)).map(a=>a.id);
  return {status:ambiguous?'unresolved':ranges.length?'text':assetIds.length?'asset':'unresolved',reason:ambiguous?'ambiguous-character-geometry':ranges.length?'characters-within-subpixel-tolerance':assetIds.length?'overlapping-assets':'no-unique-geometry',ranges,assetIds};
}
function targetRelation(document, pageIndex, point, verified) {
  if (!verified || !point || !point.every(Number.isFinite)) return {status:'page-anchor',reason:verified?'position-unavailable':'page-frame-unverified'};
  const chars=(document.blocks || []).filter(b=>b.source?.pageIndex===pageIndex && b.source.range).flatMap(b=>(b.source.characters || []).filter(c=>pointIn(point,c.bbox)).map(c=>({blockId:b.id,start:c.start,end:c.end})));
  if (chars.length===1) return {status:'text',...chars[0]};
  const assets=(document.assets || []).filter(a=>a.source?.pageIndex===pageIndex && pointIn(point,a.source.bbox));
  if (!chars.length && assets.length===1) return {status:'asset',assetId:assets[0].id};
  return {status:'page-anchor',reason:chars.length>1 || assets.length>1?'ambiguous-geometry':'no-unique-geometry'};
}

/** Inventory original MuPDF link occurrences in the reader's display frame. */
export async function readSourceLinks({bytes,document,signal}={}) {
  abort(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document || !Array.isArray(document.pages) || !Array.isArray(document.blocks)) throw new TypeError('Expected source bytes and document');
  const snapshot=Uint8Array.from(bytes), sourceSha256=hex(snapshot), model=structuredClone(document);
  if (model.sourceSha256!==sourceSha256) throw new Error('Source hash mismatch');
  for (const b of model.blocks) if (b.source?.range) {
    const r=b.source.range, text=model.pages[b.source.pageIndex]?.text;
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start<0 || r.end<r.start || typeof b.text!=='string' || typeof text!=='string' || text.slice(r.start,r.end)!==b.text || !Array.isArray(b.source.characters) || b.source.characters.some(c=>!Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start<r.start || c.end>r.end || c.start>=c.end)) throw new Error('Unsafe source character range');
  }
  let pdf; const links=[], frames=[];
  try {
    pdf=mupdf.Document.openDocument(snapshot,'application/pdf').asPDF();
    if (!pdf || pdf.needsPassword()) throw new Error('Unsupported PDF');
    if (pdf.countPages()!==model.pages.length) throw new Error('Source page count mismatch');
    for (let i=0;i<pdf.countPages();i++) {
      abort(signal); const page=pdf.loadPage(i); let nativeLinks=[];
      try {
        const bounds=page.getBounds(), transform=page.getTransform(), p=model.pages[i], g=p.geometry;
        const verified=g?.frame==='mupdf-display' && same(g.bounds,bounds) && same(g.pageTransform,transform) && Math.abs(p.width-(bounds[2]-bounds[0]))<0.01 && Math.abs(p.height-(bounds[3]-bounds[1]))<0.01;
        frames.push({pageIndex:i,bounds:[...bounds],pageTransform:[...transform],verified});
        nativeLinks=page.getLinks();
        for (let j=0;j<nativeLinks.length;j++) {
          abort(signal); const link=nativeLinks[j], bbox=[...link.getBounds()], uri=link.getURI(), external=link.isExternal();
          let target=null;
          if (!external) {
            try {
              const dest=pdf.resolveLinkDestination(link), pageIndex=pdf.resolveLink(link);
              const pos=dest.type==='XYZ' && Number.isFinite(dest.x) && Number.isFinite(dest.y)?[dest.x,dest.y]:null;
              target={status:Number.isInteger(pageIndex) && pageIndex>=0 && pageIndex<pdf.countPages()?'resolved':'unresolved',pageIndex:Number.isInteger(pageIndex) && pageIndex>=0 && pageIndex<pdf.countPages()?pageIndex:null,position:pos,destination:{type:dest.type,chapter:dest.chapter,page:dest.page,x:Number.isFinite(dest.x)?dest.x:null,y:Number.isFinite(dest.y)?dest.y:null,width:Number.isFinite(dest.width)?dest.width:null,height:Number.isFinite(dest.height)?dest.height:null,zoom:Number.isFinite(dest.zoom)?dest.zoom:null}};
            } catch { target={status:'unresolved',pageIndex:null,position:null}; }
          }
          links.push({id:`link-${hex(new TextEncoder().encode(JSON.stringify([sourceSha256,i,j]))).slice(0,24)}`,source:{pageIndex:i,occurrence:j,bbox,frame:'mupdf-display',frameVerified:verified},uri,external,relation:sourceRelation(model,i,bbox,verified),target});
        }
      } finally { for (const link of nativeLinks) link.destroy(); page.destroy(); }
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    abort(signal);
    for (const link of links) if (link.target?.status==='resolved') link.target.relation=targetRelation(model,link.target.pageIndex,link.target.position,frames[link.target.pageIndex].verified);
    return freeze({schema:'falsify.paper-source-links.v1',sourceSha256,frames,links});
  } finally { pdf?.destroy(); }
}

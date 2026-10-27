import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 25 * 1024 * 1024;
const id = (kind, value) => `${kind}-${hex(new TextEncoder().encode(JSON.stringify(value))).slice(0, 24)}`;
const checkAbort = signal => { if (signal?.aborted) { const e = new Error('Document reading cancelled'); e.name = 'AbortError'; e.code = 'aborted'; throw e; } };
const boxOK = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
const cloneBox = b => boxOK(b) ? [...b] : null;
const quadBox = q => q?.length === 8 ? [Math.min(q[0],q[2],q[4],q[6]),Math.min(q[1],q[3],q[5],q[7]),Math.max(q[0],q[2],q[4],q[6]),Math.max(q[1],q[3],q[5],q[7])] : null;

/** Normalize observed structured-text blocks, retaining reader character order and UTF-16 offsets. */
export function normalizeDocument({sourceSha256, pages, signal} = {}) {
  checkAbort(signal);
  if (typeof sourceSha256 !== 'string' || !HASH.test(sourceSha256) || !Array.isArray(pages)) throw new TypeError('Expected lowercase sourceSha256 and observed pages');
  const model = {schema:'falsify.paper-document.v1',sourceSha256,pages:[],blocks:[],styles:[],assets:[],relations:[],diagnostics:[]};
  const styles = new Map();
  for (let pageIndex=0; pageIndex<pages.length; pageIndex++) {
    checkAbort(signal);
    const page=pages[pageIndex];
    if (!page || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width<=0 || page.height<=0 || !Array.isArray(page.blocks) || !Array.isArray(page.images)) throw new TypeError('Invalid observed page');
    let offset=0, pageText=''; const blocks=[];
    for (let index=0; index<page.blocks.length; index++) {
      checkAbort(signal);
      const item=page.blocks[index]; if (!Array.isArray(item.chars)) throw new TypeError('Invalid observed block characters');
      const start=offset, chars=[], styleIds=[]; let text='';
      for (const c of item.chars) {
        if (typeof c.text !== 'string') throw new TypeError('Invalid observed character');
        const from=offset; offset+=c.text.length; text+=c.text;
        const style={fontName:typeof c.fontName==='string'?c.fontName:null,size:Number.isFinite(c.size)?c.size:null,color:Array.isArray(c.color)?[...c.color]:null};
        const key=JSON.stringify(style); let styleId=styles.get(key);
        if (!styleId) {styleId=id('style',[sourceSha256,style]); styles.set(key,styleId); model.styles.push({id:styleId,...style});}
        styleIds.push(styleId); chars.push({start:from,end:offset,bbox:cloneBox(c.bbox),styleId});
      }
      pageText+=text;
      if (!text.length) continue;
      const bbox=cloneBox(item.bbox);
      if (!bbox || chars.some(c=>!c.bbox)) model.diagnostics.push({code:'text-geometry-unavailable',pageIndex,blockIndex:index});
      if (item.lines && (!Array.isArray(item.lines) || item.lines.some(line=>!Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start<0 || line.start>line.end || line.end>chars.length))) throw new TypeError('Invalid observed line ranges');
      const lines = Array.isArray(item.lines) ? item.lines.map(line => ({
        range:{start:line.start === chars.length ? offset : chars[line.start].start,end:line.end === 0 ? start : chars[line.end-1].end},
        bbox:cloneBox(line.bbox), direction:Array.isArray(line.direction)?[...line.direction]:null,
        writingMode:Number.isFinite(line.writingMode)?line.writingMode:null, baseline:line.baseline ? line.baseline.map(p=>[...p]) : null
      })) : [];
      if (!lines.length) model.diagnostics.push({code:'line-boundaries-unavailable',pageIndex,blockIndex:index});
      blocks.push({id:id('block',[sourceSha256,pageIndex,start,offset]),kind:'paragraph',text,source:{pageIndex,bbox,range:{start,end:offset},characters:chars,lines,readerPosition:Number.isInteger(item.readerPosition)?item.readerPosition:null},styleId:styleIds.every(s=>s===styleIds[0])?styleIds[0]:null,assetIds:[],captionIds:[]});
    }
    // Only order columns when every block falls on one side of an empty vertical strip.
    let ordered=blocks, gutter=null;
    if (blocks.length>=2 && blocks.every(b=>b.source.bbox)) {
      const edges=[...new Set(blocks.flatMap(b=>[b.source.bbox[0],b.source.bbox[2]]))].sort((a,b)=>a-b);
      const candidates=[];
      for(let i=0;i<edges.length-1;i++) {const l=edges[i],r=edges[i+1],mid=(l+r)/2;
        if (r-l>=Math.max(12,page.width*0.025) && blocks.every(b=>b.source.bbox[2]<=mid || b.source.bbox[0]>=mid)) {
          const left=blocks.filter(b=>b.source.bbox[2]<=mid),right=blocks.filter(b=>b.source.bbox[0]>=mid);
          if(left.length>=2 && right.length>=2 && Math.max(...left.map(b=>b.source.bbox[3]))>=Math.min(...right.map(b=>b.source.bbox[1])) && Math.max(...right.map(b=>b.source.bbox[3]))>=Math.min(...left.map(b=>b.source.bbox[1]))) candidates.push({l,r,left,right});
        }
      }
      if(candidates.length===1) {const c=candidates[0]; gutter=[c.l,c.r]; const order=(a,b)=>a.source.bbox[1]-b.source.bbox[1] || a.source.bbox[0]-b.source.bbox[0] || a.source.range.start-b.source.range.start; ordered=[...c.left.sort(order),...c.right.sort(order)];}
    }
    if (!gutter && blocks.length>1) model.diagnostics.push({code:'reading-order-unresolved',pageIndex,detail:'Reader order retained; no unique page-wide column gutter established.'});
    model.pages.push({sourcePageIndex:pageIndex,width:page.width,height:page.height,text:pageText,geometry:page.geometry ?? {frame:'caller-observed',originalPageMapping:'unverified'},readingOrder:gutter?'geometry-columns':'reader',columnGutter:gutter});
    if (gutter) model.diagnostics.push({code:'reading-order-heuristic',pageIndex,detail:'Column gutter ordering is geometric, not semantic proof.'});
    if (page.geometry?.originalPageMapping !== 'verified') model.diagnostics.push({code:'original-page-geometry-unverified',pageIndex,detail:'Source boxes are in the observed frame; mapping to original PDF coordinates is not established.'});
    model.blocks.push(...ordered);
    for (let index=0;index<page.images.length;index++) {
      const image=page.images[index], bbox=cloneBox(image.bbox), assetId=id('asset',[sourceSha256,pageIndex,index,bbox]);
      const source={pageIndex,bbox,occurrence:index,readerPosition:Number.isInteger(image.readerPosition)?image.readerPosition:null,transform:Array.isArray(image.transform)?[...image.transform]:null};
      model.assets.push({id:assetId,kind:'image',source,content:image.content ?? null});
      model.blocks.push({id:id('figure',[sourceSha256,pageIndex,index,bbox]),kind:'figure',text:'',source,styleId:null,assetIds:[assetId],captionIds:[]});
      if(!bbox)model.diagnostics.push({code:'image-geometry-unavailable',pageIndex,occurrence:index});
      if(!image.content)model.diagnostics.push({code:'image-content-unavailable',pageIndex,occurrence:index});
    }
    if (!blocks.length) model.diagnostics.push({code:'no-extracted-text',pageIndex});
  }
  model.diagnostics.push({code:'font-program-unavailable',detail:'Structured-text Font exposes observed names, not source font programs or verified PDF resource identity.'});
  model.diagnostics.push({code:'semantic-structure-unavailable',detail:'Text block kinds are placeholders; caption links, vector assets and OCR are not recovered.'});
  return model;
}

// Compare the complete page raster and character occurrences after removing text
// in one image occurrence on a disposable copy. Fail closed on ambiguous matches.
function probeOcclusion(bytes, model, pageIndex, asset, signal) {
  const pageInfo=model.pages[pageIndex], box=asset.source.bbox, transform=pageInfo.geometry?.pageTransform;
  if (!boxOK(box) || !transform || transform[1]!==0 || transform[2]!==0 || pageInfo.width*pageInfo.height*4>12000000) return null;
  const source=model.blocks.filter(b=>b.text && b.source.pageIndex===pageIndex).flatMap(b=>b.source.characters.map(c=>({c,text:pageInfo.text.slice(c.start,c.end)})));
  const overlaps=b=>boxOK(b) && b[0]<box[2] && box[0]<b[2] && b[1]<box[3] && box[1]<b[3];
  if (!source.some(x=>overlaps(x.c.bbox))) return null;

  let doc,page,annot,st,pix;
  try {
    checkAbort(signal); doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF(); page=doc.loadPage(pageIndex);
    const raster=()=>{pix=page.toPixmap([2,0,0,2,0,0],mupdf.ColorSpace.DeviceRGB,false);try{return {width:pix.getWidth(),height:pix.getHeight(),pixels:Uint8Array.from(pix.getPixels())};}finally{pix.destroy();pix=null;}};
    const before=raster(); annot=page.createAnnotation('Redact');annot.setRect(box);annot.update();
    page.applyRedactions(false,mupdf.PDFPage.REDACT_IMAGE_NONE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_REMOVE);
    const after=raster();if(before.width!==after.width || before.height!==after.height || before.pixels.length!==after.pixels.length || before.pixels.some((v,i)=>v!==after.pixels[i])) return null;
    st=page.toStructuredText('preserve-whitespace,preserve-images');const remaining=[];
    st.walk({onChar(text,origin,font,size,quad){remaining.push({text,bbox:quadBox(quad)});},onImageBlock(b,t,image){image.destroy();}});
    // Match each after-occurrence to one unique original occurrence. Native
    // redaction can shift floating-point coordinates by a few thousandths.
    const matched=new Set();
    for(const x of remaining) {
      const candidates=[];
      for(let i=0;i<source.length;i++) {const y=source[i];if(!matched.has(i) && String.fromCharCode(y.text.codePointAt(0))===x.text && y.c.bbox?.every((v,j)=>Math.abs(v-x.bbox[j])<0.02)) candidates.push(i);}
      if(candidates.length!==1) return null;
      matched.add(candidates[0]);
    }
    const removed=source.filter((x,i)=>!matched.has(i));
    if (!removed.length || removed.some(x=>!overlaps(x.c.bbox))) return null;
    const ranges=[];for(const x of removed) {const last=ranges.at(-1);if(last && last.end===x.c.start) last.end=x.c.end;else ranges.push({start:x.c.start,end:x.c.end});}
    return {sourceSha256:model.sourceSha256,pageIndex,assetId:asset.id,bbox:[...box],ranges,proof:{scale:2,changedChannels:0,removedCharacters:removed.length}};
  } catch (e) {if(e?.name==='AbortError') throw e;return null;}
  finally {pix?.destroy();st?.destroy();annot?.destroy();page?.destroy();doc?.destroy();}
}

/** Read File, Uint8Array, or {bytes: Uint8Array} using the installed MuPDF reader. */
export async function readDocument({file,fileHash,signal} = {}) {
  checkAbort(signal);
  if (fileHash !== undefined && (typeof fileHash!=='string' || !/^[a-f0-9]{64}$/i.test(fileHash))) throw new TypeError('fileHash must be a SHA-256 hex digest');
  if (Number.isFinite(file?.size) && file.size>MAX_BYTES) throw new Error('PDF exceeds 25 MiB');
  const bytes=file instanceof Uint8Array?new Uint8Array(file):file?.bytes instanceof Uint8Array?new Uint8Array(file.bytes):typeof file?.arrayBuffer==='function'?new Uint8Array(await file.arrayBuffer()):null;
  checkAbort(signal);
  if(!bytes?.length || bytes.length>MAX_BYTES) throw new Error('Expected a PDF within 25 MiB');
  const sourceSha256=hex(bytes);
  if(fileHash && sourceSha256!==fileHash.toLowerCase()) {const e=new Error('Source hash mismatch');e.code='stale-source';throw e;}
  let doc; const pages=[];
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF();
    if(!doc || doc.needsPassword()) throw new Error('Unsupported PDF');
    for(let i=0;i<doc.countPages();i++) {
      checkAbort(signal); let page,st;
      try {
        page=doc.loadPage(i); const bounds=page.getBounds();
        if(bounds[0]!==0 || bounds[1]!==0) throw new Error('Unsupported page origin');
        const observed={width:bounds[2]-bounds[0],height:bounds[3]-bounds[1],geometry:{frame:'mupdf-display',bounds:[...bounds],pageTransform:[...page.getTransform()],originalPageMapping:'unverified'},blocks:[],images:[]}; let block,line,readerPosition=0;
        st=page.toStructuredText('preserve-whitespace,preserve-images');
        st.walk({beginTextBlock(bbox){checkAbort(signal);block={bbox:[...bbox],chars:[],lines:[],readerPosition:readerPosition++};observed.blocks.push(block);},
          beginLine(bbox,writingMode,direction){checkAbort(signal);line={bbox:[...bbox],writingMode,direction:[...direction],start:block.chars.length,end:block.chars.length,baseline:null};block.lines.push(line);},
          onChar(text,origin,font,size,quad,color){checkAbort(signal);if(!block || !line) throw new Error('Unexpected character outside text line');block.chars.push({text,bbox:quadBox(quad),fontName:font.getName(),size,color:color?[...color]:null});line.end=block.chars.length;const point=[...origin];if(!line.baseline) line.baseline=[point,point];else line.baseline[1]=point;},
          endLine(){line=null;},endTextBlock(){block=null;},onImageBlock(bbox,transform,image){
            checkAbort(signal); let pixmap,mask,maskPixmap,content=null;
            try {
              pixmap=image.toPixmap(); mask=image.getMask();
              if(mask) maskPixmap=mask.toPixmap();
              content={representation:'mupdf-decoded-png',bytes:pixmap.asPNG().slice(),width:pixmap.getWidth(),height:pixmap.getHeight(),alpha:!!pixmap.getAlpha(),mask:maskPixmap?{bytes:maskPixmap.asPNG().slice(),width:maskPixmap.getWidth(),height:maskPixmap.getHeight(),alpha:!!maskPixmap.getAlpha()}:null};
            } catch { /* Preserve an explicit unavailable occurrence instead of inventing bytes. */ }
            finally {maskPixmap?.destroy();mask?.destroy();pixmap?.destroy();image.destroy();}
            observed.images.push({bbox:[...bbox],transform:[...transform],readerPosition:readerPosition++,content});
          }});
        // JSON is printed from the same native structured-text page using full runes.
        // Require exact one-to-one agreement with the walker's truncated UTF-16 units
        // before transferring scalar values onto its geometry and font observations.
        let scalarText;
        try {
          const json=JSON.parse(st.asJSON());
          if (!Array.isArray(json.blocks)) throw new Error('Missing blocks');
          scalarText=json.blocks.filter(b=>b.type==='text').flatMap(b=>{
            if (!Array.isArray(b.lines)) throw new Error('Missing lines');
            return b.lines.flatMap(l=>{if(typeof l.text!=='string') throw new Error('Missing text'); return [...l.text];});
          });
          const chars=observed.blocks.flatMap(b=>b.chars);
          if (chars.length!==scalarText.length || scalarText.some((s,j)=>{
            const cp=s.codePointAt(0);
            return cp>=0xD800 && cp<=0xDFFF || chars[j].text!==String.fromCharCode(cp);
          })) throw new Error('Reader streams differ');
          chars.forEach((c,j)=>{c.text=scalarText[j];});
        } catch (cause) {
          const e=new Error('Unicode-preserving structured text correspondence unavailable',{cause});
          e.code='unicode-extraction-unavailable'; throw e;
        }
        pages.push(observed);
      } finally {st?.destroy();page?.destroy();}
      // Yield to allow an AbortSignal from the event loop to be observed between pages.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  } finally {doc?.destroy();}
  checkAbort(signal); const model=normalizeDocument({sourceSha256,pages,signal});
  model.occlusions=[];
  // Bounded candidates: image occurrences only; no source bytes are written.
  for (const [index,asset] of model.assets.entries()) {
    checkAbort(signal);
    const b=asset.source.bbox, pi=asset.source.pageIndex;
    const candidate=boxOK(b) && model.blocks.some(x=>x.text && x.source.pageIndex===pi && x.source.characters.some(c=>boxOK(c.bbox) && c.bbox[0]<b[2] && b[0]<c.bbox[2] && c.bbox[1]<b[3] && b[1]<c.bbox[3]));
    if(!candidate) continue;
    const evidence=index<32 ? probeOcclusion(bytes,model,pi,asset,signal) : null;
    if(evidence) model.occlusions.push(evidence);
    else model.diagnostics.push({code:'occlusion-unavailable',pageIndex:pi,assetId:asset.id,detail:'Candidate did not establish unchanged raster and unambiguous removed source characters.'});
  }
  return model;
}

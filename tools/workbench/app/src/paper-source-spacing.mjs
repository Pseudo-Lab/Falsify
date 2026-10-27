import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) throw new DOMException('Source spacing cancelled','AbortError'); };
const near = (a,b,t=0.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=t;
const validBox = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<=b[2] && b[1]<=b[3];
const strip = text => text.replace(/\s/gu,'');

// The second reader is evidence only: never replace, normalize, or edit source text.
export async function recoverSourceSpaces({bytes,document,pdfjs,signal}={}) {
  abort(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document) throw new TypeError('Expected source bytes and document');
  const sourceSha256=hex(bytes);
  if (document.sourceSha256!==sourceSha256) {const e=new Error('Source hash mismatch'); e.code='stale-source'; throw e;}
  const view=structuredClone(document), evidence={pages:0,matchedLines:0,hints:0};
  for(const b of view.blocks||[]) if(b.source) delete b.source.wordSpaceOffsets;
  if (!pdfjs?.getDocument) return {document:view,sourceSha256,evidence};
  const task=pdfjs.getDocument({data:Uint8Array.from(bytes)});
  try {
    const pdf=await task.promise; abort(signal);
    if(pdf.numPages!==view.pages?.length) return {document:view,sourceSha256,evidence};
    for(let p=0;p<pdf.numPages;p++) {
      abort(signal); const page=await pdf.getPage(p+1);
      try {
        const vp=page.getViewport({scale:1}), model=view.pages[p], frame=model?.geometry;
        if(frame?.frame!=='mupdf-display' || !Array.isArray(frame.pageTransform) || !Array.isArray(vp.transform) || frame.pageTransform.length!==6 || vp.transform.length!==6 || !frame.pageTransform.every((v,i)=>near(v,vp.transform[i],0.01)) || !near(model.width,vp.width,0.01) || !near(model.height,vp.height,0.01)) continue;
        evidence.pages++; const content=await page.getTextContent(); abort(signal);
        const lines=[];
        for(const b of view.blocks||[]) if(b.source?.pageIndex===p && typeof b.text==='string') for(const line of b.source.lines||[]) {
          const r=line.range, base=line.baseline, range=b.source.range;
          if(!r || !range || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start<range.start || r.end>range.end || r.start>=r.end || line.writingMode!==0 || !Array.isArray(line.direction) || !near(line.direction[0],1,0.01) || !near(line.direction[1],0,0.01) || !Array.isArray(base) || base.length!==2 || !near(base[0]?.[1],base[1]?.[1],0.1)) continue;
          const chars=(b.source.characters||[]).filter(c=>c.start>=r.start && c.end<=r.end);
          if(!chars.length || chars.some(c=>!validBox(c.bbox)) || chars[0].start!==r.start || chars.at(-1).end!==r.end || chars.some((c,i)=>i && c.start!==chars[i-1].end)) continue;
          const text=b.text.slice(r.start-range.start,r.end-range.start);
          if(view.pages[p].text?.slice(r.start,r.end)!==text) continue;
          lines.push({b,r,base,chars,text});
        }
        for(const item of content.items||[]) {
          if(typeof item.str!=='string' || !/\s/u.test(item.str) || item.dir!=='ltr' || !Array.isArray(item.transform) || item.transform.length!==6 || !item.transform.every(Number.isFinite) || !near(item.transform[1],0,0.01) || !near(item.transform[2],0,0.01) || !Number.isFinite(item.width) || item.width<=0) continue;
          const x=vp.transform[0]*item.transform[4]+vp.transform[2]*item.transform[5]+vp.transform[4], y=vp.transform[1]*item.transform[4]+vp.transform[3]*item.transform[5]+vp.transform[5];
          const candidates=lines.filter(l=>near(l.base[0][1],y,0.5) && near(l.chars[0].bbox[0],x,1) && near(l.chars.at(-1).bbox[2],x+item.width,2) && strip(l.text)===strip(item.str));
          if(candidates.length!==1) continue;
          const l=candidates[0];
          const same=(content.items||[]).filter(q=>q!==item && typeof q.str==='string' && Array.isArray(q.transform) && near(q.transform[4],item.transform[4],0.5) && near(q.transform[5],item.transform[5],0.5) && strip(q.str)===strip(item.str));
          if(same.length) continue;
          const raw=[]; for(let i=0;i<l.text.length;i++) if(!/\s/u.test(l.text[i])) raw.push(i);
          let n=0, pending=false; const offsets=[];
          for(let i=0;i<item.str.length;i++) {
            if(/\s/u.test(item.str[i])) {if(n) pending=true; continue;}
            const pos=raw[n++];
            if(pending && n>1 && pos===raw[n-2]+1) offsets.push(l.r.start+pos);
            pending=false;
          }
          if(offsets.length) { l.b.source.wordSpaceOffsets=[...new Set([...(l.b.source.wordSpaceOffsets||[]),...offsets])].sort((a,b)=>a-b); evidence.hints+=offsets.length; }
          evidence.matchedLines++;
        }
      } finally {page.cleanup?.();}
    }
  } finally {await task.destroy();}
  abort(signal); return {document:view,sourceSha256,evidence};
}

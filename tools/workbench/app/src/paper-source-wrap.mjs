import {hex} from './paragraph-pdf-crypto.mjs';

const box = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<b[2] && b[1]<b[3];
const near = (a,b,t=0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=t;
const tokenChar = c => !!c && /[\p{L}\p{N}\p{M}_\-−–]/u.test(c);
const addressLike = text => /(?:https?:\/\/|www\.|@|[\\/])/iu.test(text);

/**
 * Project only evidenced source line-wrap hyphens. `document` is the original
 * readDocument model (optionally enriched by recoverSourceSpaces); `bytes`,
 * when supplied, must hash to its sourceSha256. Returned offsets are absolute
 * UTF-16 page offsets, with the original block ID, never rewritten text.
 * Callers must omit only unchanged source characters, outside edit ranges.
 */
export function findSourceWrapOmissions({document,bytes}={}) {
  if (!document || !/^[a-f0-9]{64}$/.test(document.sourceSha256 || '') || !Array.isArray(document.pages) || !Array.isArray(document.blocks)) throw new TypeError('Expected source document');
  if (bytes !== undefined) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError('Expected source bytes');
    if (hex(bytes)!==document.sourceSha256) {const e=new Error('Source hash mismatch'); e.code='stale-source'; throw e;}
  }
  const verified=[], styles=new Map((document.styles||[]).map(s=>[s.id,s]));
  for (const block of document.blocks) {
    const s=block.source, p=document.pages[s?.pageIndex], r=s?.range;
    if (!block.text || !r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start<0 || r.end-r.start!==block.text.length || p?.sourcePageIndex!==s.pageIndex || p.geometry?.frame!=='mupdf-display' || !Array.isArray(p.geometry.pageTransform) || p.geometry.pageTransform.length!==6 || !p.geometry.pageTransform.every(Number.isFinite) || !near(p.geometry.pageTransform[1],0) || !near(p.geometry.pageTransform[2],0) || p.geometry.pageTransform[0]<=0 || p.geometry.pageTransform[3]>=0 || p.text?.slice(r.start,r.end)!==block.text || !Array.isArray(s.lines) || !Array.isArray(s.characters)) continue;
    const lines=[]; let cursor=r.start;
    for (const line of s.lines) {
      const lr=line.range, chars=s.characters.filter(c=>c.start>=lr?.start && c.end<=lr?.end);
      if (!lr || lr.start!==cursor || !Number.isInteger(lr.end) || lr.end<=lr.start || lr.end>r.end || !box(line.bbox) || line.writingMode!==0 || !near(line.direction?.[0],1) || !near(line.direction?.[1],0) || !Array.isArray(line.baseline) || line.baseline.length!==2 || !near(line.baseline[0]?.[1],line.baseline[1]?.[1],0.1) || !chars.length || chars[0].start!==lr.start || chars.at(-1).end!==lr.end || chars.some((c,i)=>!box(c.bbox) || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.end<=c.start || /mono|courier|consolas/iu.test(styles.get(c.styleId)?.fontName||'') || (i>0 && c.start!==chars[i-1].end))) {lines.length=0; break;}
      lines.push({line,chars,text:p.text.slice(lr.start,lr.end)}); cursor=lr.end;
    }
    if (lines.length && cursor===r.end && s.characters.length===lines.reduce((n,l)=>n+l.chars.length,0)) verified.push({block,lines});
  }
  const occurrences=(word,exclude) => verified.flatMap(({block,lines})=>lines.flatMap(({line,text})=>{
    const found=[]; let at=-1;
    while ((at=text.indexOf(word,at+1))!==-1) {
      if (!addressLike(text) && !tokenChar(text[at-1]) && !tokenChar(text[at+word.length])) {
        const start=line.range.start+at, end=start+word.length;
        if (!(exclude && block.source.pageIndex===exclude.pageIndex && start<exclude.end && end>exclude.start) && !(block.source.wordSpaceOffsets||[]).some(x=>x>start && x<end)) found.push({pageIndex:block.source.pageIndex,blockId:block.id,start,end});
      }
    }
    return found;
  }));
  const omissions=[];
  for (const {block,lines} of verified) for(let i=0;i+1<lines.length;i++) {
    const a=lines[i], b=lines[i+1], boundary=a.line.range.end;
    if (boundary!==b.line.range.start || b.line.baseline[0][1]<=a.line.baseline[0][1] || b.line.baseline[0][1]-a.line.baseline[0][1]>3*Math.max(a.line.bbox[3]-a.line.bbox[1],b.line.bbox[3]-b.line.bbox[1]) || (block.source.wordSpaceOffsets||[]).includes(boundary)) continue;
    if(addressLike(a.text+b.text)) continue;
    const left=a.text.match(/(?:^|[^\p{L}\p{N}\p{M}_\-−–])([a-z]{3,})-$/u), right=b.text.match(/^([a-z]{2,})(?=$|[^\p{L}\p{N}\p{M}_\-−–])/u);
    if (!left || !right) continue;
    const start=boundary-1-left[1].length, end=boundary+right[1].length;
    if ((block.source.wordSpaceOffsets||[]).some(x=>x>start && x<end)) continue;
    const joined=left[1]+right[1], compound=left[1]+'-'+right[1];
    const corroboration=occurrences(joined,{pageIndex:block.source.pageIndex,start,end});
    if (!corroboration.length || occurrences(compound).length) continue;
    omissions.push({blockId:block.id,pageIndex:block.source.pageIndex,start:boundary-1,end:boundary, evidence:{joined,sourceRange:{start,end},lineRanges:[{...a.line.range},{...b.line.range}],corroboration}});
  }
  return {sourceSha256:document.sourceSha256,omissions};
}

/** Map an omission to an existing parent block or flow fragment without inventing IDs. */
export function sourceWrapOffsetsForBlock(block, omissions) {
  const r=block?.source?.range;
  if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || typeof block.text!=='string' || r.end-r.start!==block.text.length) return [];
  return (omissions || []).filter(o=>o.pageIndex===block.source.pageIndex && (o.blockId===block.id || o.blockId===block.parentBlockId) && o.start>=r.start && o.end===o.start+1 && o.end<=r.end && block.text[o.start-r.start]==='-').map(o=>o.start-r.start);
}

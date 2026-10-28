import {readGlyphs} from './paragraph-vendor/quality.mjs';

const text = gs => gs.map(g => String.fromCodePoint(g.u)).join('');
const key = gs => text(gs).normalize('NFKC').replace(/\s/gu, '').toLowerCase();
const originY = g => g.origin?.[1];
const size = g => g.style.size * Math.hypot(g.style.mat?.[2] ?? 0, g.style.mat?.[3] ?? 1);
const styleKey = g => JSON.stringify(g.style);
const near = (a,b,t=.15) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=t;

function lines(glyphs) {
  const out=[];
  for(const g of glyphs.filter(g => g.obj && g.style && Number.isFinite(originY(g))).sort((a,b)=>originY(b)-originY(a)||a.l-b.l)) {
    let line=out.find(l=>near(l.y,originY(g),.5) && near(l.size,size(g),.2));
    if(!line) out.push(line={y:originY(g),size:size(g),glyphs:[]});
    line.glyphs.push(g);
  }
  for(const line of out) line.glyphs.sort((a,b)=>a.l-b.l);
  return out;
}
// A marker may be split across text objects. Group only adjacent glyphs with
// the same baseline and size; per-glyph styles and object membership are checked separately.
function clusters(glyphs) {
  const groups=[];
  for(const line of lines(glyphs)) {
    let current=[];
    for(const g of line.glyphs) {
      const prev=current.at(-1);
      if(prev && (g.l-prev.r>Math.max(2,size(g)*.6))) {
        groups.push(current); current=[];
      }
      current.push(g);
    }
    if(current.length) groups.push(current);
  }
  return groups;
}
function stream(page, bodySize, column) {
  const chars=[];
  for(const line of lines(page.glyphs).filter(l=>near(l.size,bodySize,.2))) {
    for(const g of line.glyphs.filter(g=>(g.l<page.W/2)===column)) {
      for(const c of key([g])) chars.push({c,g});
    }
  }
  return chars;
}
function hits(chars, needle) {
  const hay=chars.map(x=>x.c).join(''), found=[];
  for(let i=hay.indexOf(needle);i>=0;i=hay.indexOf(needle,i+1)) found.push(chars[i+needle.length-1].g);
  return found;
}
export function planInlineMarkers(source, output, pageIndex=0) {
  const warnings=[], repairs=[], sl=lines(source.glyphs);
  const sourceClusters=clusters(source.glyphs), outputClusters=clusters(output.glyphs);
  for(const marker of sourceClusters) {
    if(!marker.length || marker.length>12) continue;
    const m=marker[0], left=marker[0].l;
    const candidates=[];
    for(const line of sl) {
      if(line.size < size(m)*1.2 || line.size > size(m)*3 || line.y >= originY(m) || originY(m)-line.y > line.size*.8) continue;
      const preceding=line.glyphs.filter(g=>g.r<=left+1 && left-g.r<=line.size*1.3);
      if(!preceding.length) continue;
      const parent=preceding.at(-1), gap=left-parent.r;
      if(gap < -1 || gap > line.size*1.3) continue;
      const column=parent.l<source.W/2, chars=stream(source,line.size,column);
      const end=chars.findLastIndex(c=>c.g===parent);
      if(end<0) continue;
      const anchor=chars.slice(Math.max(0,end-39),end+1).map(c=>c.c).join('');
      if(anchor.length<12) continue;
      candidates.push({line,parent,anchor,column,chars});
    }
    if(candidates.length!==1) continue;
    const {line,parent,anchor,column,chars}=candidates[0];
    const sourceHits=hits(chars,anchor), targetHits=hits(stream(output,line.size,column),anchor);
    const same=gs=>text(gs)===text(marker) && gs.length===marker.length && gs.every((g,i)=>styleKey(g)===styleKey(marker[i]));
    const sourceMarkers=sourceClusters.filter(same), targetMarkers=outputClusters.filter(same);
    if(sourceHits.length!==1 || sourceHits[0]!==parent || targetHits.length!==1 || sourceMarkers.length!==1 || targetMarkers.length!==1) {
      warnings.push({pageIndex,code:'inline_marker_ambiguous',sourceIndex:m.i,text:text(marker)}); continue;
    }
    const target=targetHits[0], outMarker=targetMarkers[0], selected=new Set(outMarker);
    const handles=[...new Set(outMarker.map(g=>g.obj))];
    if(handles.some(h=>output.glyphs.some(g=>g.obj===h && !selected.has(g)))) {
      warnings.push({pageIndex,code:'inline_marker_object_ambiguous',sourceIndex:m.i,text:text(marker)}); continue;
    }
    const dx=(target.r+(left-parent.r))-outMarker[0].l;
    const dy=(originY(target)+(originY(m)-line.y))-originY(outMarker[0]);
    if(Math.hypot(dx,dy)>=1) for(const object of handles) repairs.push({pageIndex,sourceIndex:m.i,object,dx,dy});
  }
  return {repairs,warnings};
}

export async function repairInlineMarkers({engineFactory,sourceBytes,outputBytes,pageIndices,sourcePageMap}) {
  let src,out; const repairs=[],warnings=[];
  try {
    src=await engineFactory(sourceBytes); out=await engineFactory(outputBytes);
    for(const pageIndex of pageIndices) {
      const mapping=sourcePageMap?.find(m=>m.sourcePageIndex===pageIndex);
      if(sourcePageMap && (!mapping || mapping.continuationPageIndices?.length)) {
        warnings.push({pageIndex,code:'inline_marker_continuation_unverified'}); continue;
      }
      const outputPageIndex=mapping?.outputPageIndex ?? pageIndex;
      const s=readGlyphs(src,pageIndex), o=readGlyphs(out,outputPageIndex);
      if(!s.styled || !o.styled) {warnings.push({pageIndex,code:'inline_marker_style_unavailable'});continue;}
      const plan=planInlineMarkers(s,o,pageIndex); warnings.push(...plan.warnings);
      const seen=new Set(), counts=new Map();
      for(const move of plan.repairs) counts.set(move.object,(counts.get(move.object)||0)+1);
      const conflicts=new Set(plan.repairs.filter(move=>counts.get(move.object)!==1).map(move=>move.sourceIndex));
      for(const sourceIndex of conflicts) warnings.push({pageIndex,code:'inline_marker_object_ambiguous',sourceIndex});
      for(const move of plan.repairs) {
        if(conflicts.has(move.sourceIndex)) continue;
        seen.add(move.object);
        out.M._FPDFPageObj_Transform(move.object,1,0,0,1,move.dx,move.dy);
        repairs.push({pageIndex,sourceIndex:move.sourceIndex,dx:move.dx,dy:move.dy});
      }
      if(seen.size) {
        if(!out.M._FPDFPage_GenerateContent(out.page)) throw new Error('inline_marker_generate_failed');
        if(out.M._FPDFPage_GetAnnotCount?.(out.page)>0) warnings.push({pageIndex,code:'inline_marker_annotations_unverified'});
      }
    }
    return {pdf:repairs.length?new Uint8Array(out.save()):new Uint8Array(outputBytes),repairs,warnings};
  } finally {try{src?.close();}finally{out?.close();}}
}

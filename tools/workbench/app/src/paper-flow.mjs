import {sourceGlyphInsideLink} from './paper-source-links.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
const boxOK = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const overlap = (a,b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const contains = (a,b) => b[0]>=a[0]-1 && b[1]>=a[1]-1 && b[2]<=a[2]+1 && b[3]<=a[3]+1;
const median = xs => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
const reading = (a,b) => (a.pos ?? Infinity)-(b.pos ?? Infinity) || a.index-b.index;
const geom = (a,b) => a.box[1]-b.box[1] || a.box[0]-b.box[0] || reading(a,b);
const textKey = b => (b.text || '').trim().replace(/\s+/g,' ');
const sameNumbers = (a,b,tolerance=.01) => Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i)=>Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v-b[i])<tolerance);

// Only whole original blocks, in the verified source frame, can supply link evidence.
function linkedEdgeCandidates(document, inventory) {
  if(inventory?.schema!=='falsify.paper-source-links.v1' || inventory.sourceSha256!==document.sourceSha256 || !Array.isArray(inventory.frames) || !Array.isArray(inventory.links)) return [];
  const result=[];
  for(const link of inventory.links) {
    const s=link.source, page=document.pages.find(p=>p.sourcePageIndex===s?.pageIndex), frame=inventory.frames.find(f=>f.pageIndex===s?.pageIndex), g=page?.geometry;
    if(!page || !frame?.verified || !s?.frameVerified || s.frame!=='mupdf-display' || g?.frame!=='mupdf-display' || !sameNumbers(frame.bounds,g.bounds) || !sameNumbers(frame.pageTransform,g.pageTransform) || !boxOK(s.bbox) || typeof link.uri!=='string' || !link.uri || link.relation?.status!=='text' || !['fully-contained-characters','characters-within-subpixel-tolerance'].includes(link.relation.reason)) continue;
    const ranges=link.relation.ranges;
    if(!Array.isArray(ranges) || ranges.length!==1) continue;
    const r=ranges[0], b=document.blocks.find(b=>b.id===r.blockId && b.source?.pageIndex===s.pageIndex), br=b?.source?.range;
    if(!br || r.start!==br.start || r.end!==br.end || !textKey(b) || !boxOK(b.source.bbox) || page.text?.slice(br.start,br.end)!==b.text) continue;
    const chars=b.source.characters;
    if(!Array.isArray(chars) || !chars.length || chars[0].start!==br.start || chars.at(-1).end!==br.end || chars.some((c,i)=>!boxOK(c.bbox) || (i && chars[i-1].end!==c.start) || !sourceGlyphInsideLink(c.bbox,s.bbox))) continue;
    const edge=b.source.bbox[3]<=page.height*.12?'header':b.source.bbox[1]>=page.height*.88?'footer':null;
    if(edge) result.push({b,link,edge});
  }
  return result.filter(x=>result.some(y=>y!==x && y.b.source.pageIndex!==x.b.source.pageIndex && y.edge===x.edge && y.link.uri===x.link.uri && textKey(y.b)===textKey(x.b) && sameNumbers(y.b.source.bbox,x.b.source.bbox,2) && sameNumbers(y.link.source.bbox,x.link.source.bbox,2)));
}

// Split only on complete, contiguous observed line ranges. Each fragment is a
// view of the original page text and retains the corresponding character data.
function splitBlock(b, hash, styles) {
  const {lines,characters,range}=b.source || {};
  if (!b.text || !Array.isArray(lines) || lines.length<2 || !Array.isArray(characters) || !range || lines.some(l=>!boxOK(l.bbox) || !l.range)) return [b];
  if (lines[0].range.start!==range.start || lines.at(-1).range.end!==range.end || lines.some((l,i)=>l.range.start>=l.range.end || (i && lines[i-1].range.end!==l.range.start))) return [b];
  const groups=[];
  for(const line of lines) {
    const group=groups.at(-1), prev=group?.at(-1), h=line.bbox[3]-line.bbox[1];
    const gap=prev ? line.bbox[1]-prev.bbox[3] : 0;
    const sameColumn=prev && Math.min(line.bbox[2],prev.bbox[2])-Math.max(line.bbox[0],prev.bbox[0]) > Math.min(line.bbox[2]-line.bbox[0],prev.bbox[2]-prev.bbox[0])*.3;
    const indent=prev && line.bbox[0]-prev.bbox[0]>h;
    const lineSize=l=>median(characters.filter(c=>c.start>=l.range.start && c.end<=l.range.end).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite));
    const a=prev && lineSize(prev), z=lineSize(line);
    const sizeChange=a && z && Math.max(a,z)>Math.min(a,z)*1.2;
    if (!prev || !sameColumn || gap < -h*.5 || gap > h*.8 || indent || sizeChange) groups.push([line]); else group.push(line);
  }
  if(groups.length===1) return [b];
  return groups.map(group=>{
    const start=group[0].range.start,end=group.at(-1).range.end;
    const chars=characters.filter(c=>c.start>=start && c.end<=end);
    const id=`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,b.source.pageIndex,start,end]))).slice(0,24)}`;
    return {...b,id,parentBlockId:b.id,text:b.text.slice(start-range.start,end-range.start),source:{...b.source,bbox:union(group.map(l=>l.bbox)),range:{start,end},characters:chars,lines:group}};
  });
}

// Split a parent only at observed character boundaries when another source run
// lies inside one of its lines. All fragments remain exact views of source text.
function inlineFragments(blocks, hash) {
  const replacements=new Map(), groups=[];
  for (const host of blocks) {
    const lines=host.source?.lines, chars=host.source?.characters, range=host.source?.range;
    if (replacements.has(host.id) || !host.text || !Array.isArray(lines) || !Array.isArray(chars) || !range || lines.length<1 || !boxOK(host.source?.bbox)) continue;
    const inserts=[];
    for (const guest of blocks) {
      if (guest===host || replacements.has(guest.id) || !guest.text || guest.text.length>80 || !boxOK(guest.source?.bbox) || guest.source.pageIndex!==host.source.pageIndex) continue;
      const gb=guest.source.bbox;
      if (!contains(host.source.bbox,gb) || gb[2]-gb[0] > (host.source.bbox[2]-host.source.bbox[0])*.45) continue;
      const line=lines.filter(l=>boxOK(l.bbox) && l.range && gb[1]<l.bbox[3] && gb[3]>l.bbox[1] && gb[2]>=l.bbox[0]-20 && gb[0]<=l.bbox[2]+3).sort((a,b)=>Math.min(gb[3],b.bbox[3])-Math.max(gb[1],b.bbox[1])-(Math.min(gb[3],a.bbox[3])-Math.max(gb[1],a.bbox[1])))[0];
      if (!line) continue;
      const lc=chars.filter(c=>c.start>=line.range.start && c.end<=line.range.end && boxOK(c.bbox));
      const next=lc.find(c=>(c.bbox[0]+c.bbox[2])/2 >= (gb[0]+gb[2])/2);
      const at=next?.start ?? line.range.end;
      if (at<range.start || at>=range.end) continue;
      inserts.push({guest,at});
    }
    if (!inserts.length) continue;
    inserts.sort((a,b)=>a.at-b.at || a.guest.source.bbox[0]-b.guest.source.bbox[0]);
    const cuts=[range.start,...new Set(inserts.map(x=>x.at).filter(at=>at>range.start)),range.end], parts=[];
    for(let i=0;i<cuts.length-1;i++) {
      const start=cuts[i],end=cuts[i+1], partChars=chars.filter(c=>c.start>=start && c.end<=end);
      const partLines=lines.filter(l=>l.range && l.range.start<end && l.range.end>start).map(l=>({...l,range:{start:Math.max(start,l.range.start),end:Math.min(end,l.range.end)},bbox:union(partChars.filter(c=>c.start<l.range.end && c.end>l.range.start && boxOK(c.bbox)).map(c=>c.bbox))})).filter(l=>boxOK(l.bbox));
      if (!partLines.length) {parts.length=0;break;}
      const id=`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,host.source.pageIndex,start,end]))).slice(0,24)}`;
      parts.push({...host,id,parentBlockId:host.parentBlockId || host.id,text:host.text.slice(start-range.start,end-range.start),source:{...host.source,bbox:union(partLines.map(l=>l.bbox)),range:{start,end},characters:partChars,lines:partLines}});
    }
    if (!parts.length) continue;
    const order=inserts.filter(x=>x.at===range.start).map(x=>x.guest); for(let i=0;i<parts.length;i++){order.push(parts[i]);order.push(...inserts.filter(x=>x.at===cuts[i+1]).map(x=>x.guest));}
    replacements.set(host.id,parts); for(const x of inserts) replacements.set(x.guest.id,null);
    groups.push(order);
  }
  return {replacements,groups};
}

// Preserve original IDs and text in the model; flow fragments are exact views.
function occlusionFragments(block, evidence, hash) {
  const range=block.source?.range, chars=block.source?.characters, lines=block.source?.lines;
  if(!range || !chars?.length || !lines?.length) return [block];
  const cuts=new Set([range.start,range.end]);
  for(const e of evidence) for(const r of e.ranges) if(r.start>=range.start && r.end<=range.end) {cuts.add(r.start);cuts.add(r.end);}
  const sorted=[...cuts].sort((a,b)=>a-b); if(sorted.length===2) return [block];
  const parts=[];
  for(let i=0;i<sorted.length-1;i++) {
    const start=sorted[i],end=sorted[i+1], cs=chars.filter(c=>c.start>=start && c.end<=end);
    if(!cs.length || cs.some(c=>!boxOK(c.bbox))) return [block];
    const ls=lines.filter(l=>l.range.start<end && l.range.end>start).map(l=>({...l,range:{start:Math.max(start,l.range.start),end:Math.min(end,l.range.end)},bbox:union(cs.filter(c=>c.start<l.range.end && c.end>l.range.start).map(c=>c.bbox))}));
    parts.push({...block,id:`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,block.source.pageIndex,start,end]))).slice(0,24)}`,parentBlockId:block.id,text:block.text.slice(start-range.start,end-range.start),source:{...block.source,range:{start,end},characters:cs,lines:ls,bbox:union(cs.map(c=>c.bbox))}});
  }
  return parts;
}

/** Produce a deterministic, source-bound reading order and ownership proposal. */
export function buildPaperFlow(document, {drawings=document?.drawings || [], links} = {}) {
  if (document?.schema !== 'falsify.paper-document.v1' || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets)) throw new TypeError('Expected falsify.paper-document.v1');
  const items=[],relations=[],diagnostics=[],fragments=[],regions=[];
  const styles=new Map((document.styles || []).map(s=>[s.id,s]));
  const evidence=(document.occlusions || []).filter(e=>e.sourceSha256===document.sourceSha256 && Array.isArray(e.ranges) && e.proof?.changedChannels===0 && e.proof?.removedCharacters>0);
  let flowBlocks=document.blocks.flatMap(b=>occlusionFragments(b,evidence.filter(e=>e.pageIndex===b.source?.pageIndex),document.sourceSha256)).flatMap(b=>splitBlock(b,document.sourceSha256,styles));
  const inline=inlineFragments(flowBlocks,document.sourceSha256);
  flowBlocks=flowBlocks.flatMap(b=>inline.replacements.has(b.id) ? (inline.replacements.get(b.id) || [b]) : [b]);
  fragments.push(...flowBlocks.filter(b=>b.parentBlockId));
  const textBlocks=flowBlocks.filter(b=>b.text);
  const sizeOf=b=>median((b.source?.characters || []).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite)) || styles.get(b.styleId)?.size || 0;
  const bodySize=median(textBlocks.flatMap(b=>(b.source?.characters || []).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite))) || median(textBlocks.map(sizeOf).filter(Boolean));
  const linkedEdges=linkedEdgeCandidates(document,links);
  const repeats=new Map();
  for(const b of textBlocks) {const page=document.pages.find(p=>p.sourcePageIndex===b.source?.pageIndex),box=b.source?.bbox;if(!page || !boxOK(box) || !(box[1]<page.height*.12 || box[3]>page.height*.88)) continue;const key=b.text.trim().replace(/\s+/g,' ');if(key) {if(!repeats.has(key)) repeats.set(key,new Set()); repeats.get(key).add(b.source.pageIndex);}}
  // A shallow page-wide filled band can sit behind several repeated footer
  // lines. Require the same distinct lines and geometry on three pages with
  // central body evidence; nearby image or other drawing content is not a band.
  const decoratedFooter=new Set();
  for(const page of document.pages) {
    const pi=page.sourcePageIndex;
    const candidates=textBlocks.filter(b=>b.source?.pageIndex===pi && boxOK(b.source.bbox) && b.source.bbox[1]>=page.height*.94 && textKey(b) && repeats.get(textKey(b))?.size>=3);
    for(const band of drawings.filter(d=>d.pageIndex===pi && d.operation==='fill' && boxOK(d.bbox) && d.bbox[1]>=page.height*.94 && d.bbox[2]-d.bbox[0]>=page.width*.8 && d.bbox[3]-d.bbox[1]<=page.height*.035)) {
      const members=candidates.filter(b=>overlap(b.source.bbox,band.bbox));
      if(new Set(members.map(textKey)).size<2) continue;
      if(document.assets.some(a=>a.source?.pageIndex===pi && boxOK(a.source.bbox) && overlap(a.source.bbox,band.bbox))) continue;
      if(drawings.some(d=>d!==band && d.pageIndex===pi && boxOK(d.bbox) && overlap(d.bbox,band.bbox))) continue;
      const matchingPages=document.pages.filter(p=>{
        if(p.width!==page.width || p.height!==page.height || !members.every(b=>textBlocks.filter(other=>other.source?.pageIndex===p.sourcePageIndex && textKey(other)===textKey(b) && sameNumbers(other.source.bbox,b.source.bbox,2)).length===1)) return false;
        const decorations=drawings.filter(d=>d.pageIndex===p.sourcePageIndex && d.operation==='fill' && sameNumbers(d.bbox,band.bbox,2));
        if(decorations.length!==1) return false;
        const decoration=decorations[0];
        return !document.assets.some(a=>a.source?.pageIndex===p.sourcePageIndex && boxOK(a.source.bbox) && overlap(a.source.bbox,decoration.bbox)) && !drawings.some(d=>d!==decoration && d.pageIndex===p.sourcePageIndex && boxOK(d.bbox) && overlap(d.bbox,decoration.bbox));
      });
      const bodyPages=matchingPages.filter(p=>textBlocks.some(b=>b.source?.pageIndex===p.sourcePageIndex && boxOK(b.source.bbox) && b.source.bbox[1]>=p.height*.12 && b.source.bbox[3]<=p.height*.88 && (b.text || '').trim().length>=100));
      if(matchingPages.length>=3 && bodyPages.length>=2) for(const b of members) decoratedFooter.add(b.id);
    }
  }
  for (const page of document.pages) {
    const pi=page.sourcePageIndex;
    const blocks=flowBlocks.map((b,index)=>({b,index,box:b.source?.bbox,pos:b.source?.readerPosition})).filter(x=>x.b.source?.pageIndex===pi);
    const assets=document.assets.map((a,index)=>({a,index,box:a.source?.bbox,pos:a.source?.readerPosition})).filter(x=>x.a.source?.pageIndex===pi);
    const owned=new Set(), represented=new Set(); let serial=0;
    const make=(kind,bs,as,box,pos,index)=>({id:`flow-${pi}-${serial++}`,kind,blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id),source:{pageIndex:pi,bbox:boxOK(box)?[...box]:null},columns:1,span:'page',captionIds:[],box,pos,index});
    const entries=[];
    // Connected line grids are evidence of a vector table. Keep captions and
    // notes outside the measured grid and capture the grid with its cell text.
    const paths=drawings.filter(d=>d.pageIndex===pi && boxOK(d.bbox)).map(d=>d.bbox);
    // Outline-heavy forms may have no extractable labels at all. Restrict this
    // classification to pages without ordinary central body text, and include
    // every observed occurrence in the measured crop.
    const centralText=blocks.filter(x=>x.b.text?.trim() && (!boxOK(x.box) || (x.box[1]<page.height*.9 && x.box[3]>page.height*.1)));
    let form=false;
    if(paths.length>=2000 && centralText.length===0 && blocks.every(x=>boxOK(x.box)) && assets.every(x=>boxOK(x.box))) {
      const raw=union([...paths,...blocks.map(x=>x.box),...assets.map(x=>x.box)]);
      const box=[Math.max(0,raw[0]-1),Math.max(0,raw[1]-1),Math.min(page.width,raw[2]+1),Math.min(page.height,raw[3]+1)];
      if(boxOK(box) && box[2]-box[0]>page.width*.5 && box[3]-box[1]>page.height*.5 && [...paths,...blocks.map(x=>x.box),...assets.map(x=>x.box)].every(b=>contains(box,b))) {
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',blocks,assets,box,Math.min(...blocks.map(x=>x.pos ?? Infinity)),0);
        entry.renderAssetId=id; entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:blocks.map(x=>x.b.id),assetIds:assets.map(x=>x.a.id),classification:'outline-artwork'});
        blocks.forEach(x=>owned.add(x.b.id)); assets.forEach(x=>represented.add(x.a.id)); form=true;
      }
    }
    const captions=blocks.filter(x=>boxOK(x.box) && /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d/i.test(x.b.text || ''));
    const plotBottom=Math.min(page.height*.9,...captions.map(x=>x.box[1]));
    const plotText=blocks.filter(x=>x.b.text && boxOK(x.box) && x.box[1]>=page.height*.05 && x.box[3]<=plotBottom);
    const plotPaths=paths.filter(b=>b[0]>=0 && b[1]>=page.height*.05 && b[2]<=page.width && b[3]<=plotBottom);
    let plot=false;
    // Multiple separated image occurrences can be panels of one figure. Use
    // narrative and caption geometry as hard vertical boundaries; a crop is
    // accepted only when no excluded text or image intersects it.
    if(!form) {
      const central=blocks.filter(x=>x.b.text && boxOK(x.box) && x.box[1]>=page.height*.05 && x.box[3]<=page.height*.9);
      const narrative=x=>{
        const lines=x.b.source?.lines || [];
        return captions.includes(x) || (bodySize && sizeOf(x.b)>=bodySize*.88 && x.box[2]-x.box[0]>=page.width*.3 && (lines.length>=2 || x.b.text.trim().length>=55));
      };
      const barriers=central.filter(narrative).sort(geom);
      const limits=[page.height*.05,...barriers.flatMap(x=>[x.box[1],x.box[3]]),page.height*.9].sort((a,b)=>a-b);
      for(let i=0;i<limits.length-1;i++) {
        const top=limits[i],bottom=limits[i+1];
        if(bottom<=top || barriers.some(x=>x.box[1]<bottom && x.box[3]>top)) continue;
        const as=assets.filter(x=>!represented.has(x.a.id) && boxOK(x.box) && x.box[1]>=top && x.box[3]<=bottom);
        if(as.length<2) continue;
        const labels=central.filter(x=>!owned.has(x.b.id) && !narrative(x) && x.box[1]>=top && x.box[3]<=bottom);
        if(labels.length<3) continue;
        const ps=paths.filter(b=>b[1]>=top && b[3]<=bottom);
        const raw=union([...as.map(x=>x.box),...labels.map(x=>x.box),...ps]);
        // Painted strokes and glyph ink can extend beyond their geometric
        // bounds. Include a small margin, subject to the same exclusion check.
        const box=[Math.max(0,raw[0]-2),Math.max(0,raw[1]-2),Math.min(page.width,raw[2]+2),Math.min(page.height,raw[3]+2)];
        if(box[2]-box[0]<page.width*.4 || box[3]-box[1]<page.height*.2) continue;
        if(blocks.some(x=>x.b.text && boxOK(x.box) && overlap(box,x.box) && !labels.includes(x)) || assets.some(x=>boxOK(x.box) && overlap(box,x.box) && !as.includes(x))) continue;
        const bs=[...labels,...blocks.filter(x=>!owned.has(x.b.id) && (x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id)))];
        bs.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',bs,as,box,Math.min(...bs.map(x=>x.pos ?? Infinity)),Math.min(...bs.map(x=>x.index)));
        entry.renderAssetId=id; entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id),classification:'compound-figure'});
        plot=true;
      }
    }
    // Establish the artwork extent before considering text. Nearby short,
    // single-line labels may extend just outside it; prose remains independent.
    if(!form && !plot && plotPaths.length>=1000) {
      const artwork=union(plotPaths);
      const plotBlocks=plotText.filter(x=>{
        const text=x.b.text.trim(), lines=x.b.source?.lines || [];
        const dx=Math.max(artwork[0]-x.box[2],x.box[0]-artwork[2],0);
        const dy=Math.max(artwork[1]-x.box[3],x.box[1]-artwork[3],0);
        const distance=Math.max(10,Math.min(15,(sizeOf(x.b) || x.box[3]-x.box[1])*1.5));
        const smallArtworkText=contains(artwork,x.box) && bodySize && sizeOf(x.b) && sizeOf(x.b)<=bodySize*.9;
        return smallArtworkText || (text.length<=30 && text.split(/\s+/).length<=3 && !/[.!?]\s*$/.test(text) && lines.length<=1 &&
          (text.length<=2 || !bodySize || !sizeOf(x.b) || sizeOf(x.b)<=bodySize*1.1) && dx<=distance && dy<=distance);
      });
      let box=union([artwork,...plotBlocks.map(x=>x.box)]);
      const touching=assets.filter(x=>boxOK(x.box) && overlap(box,x.box));
      if(touching.every(x=>x.box[0]>=0 && x.box[1]>=page.height*.05 && x.box[2]<=page.width && x.box[3]<=plotBottom)) box=union([box,...touching.map(x=>x.box)]);
      if(plotBlocks.length>=20 && !blocks.some(x=>x.b.text && boxOK(x.box) && overlap(box,x.box) && !plotBlocks.includes(x)) && touching.every(x=>contains(box,x.box)) && box[2]-box[0]>page.width*.4 && box[3]-box[1]>page.height*.2) {
        const as=assets.filter(x=>boxOK(x.box) && contains(box,x.box));
        const figureBlocks=blocks.filter(x=>(x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id)));
        plotBlocks.push(...figureBlocks.filter(x=>!plotBlocks.includes(x)));
        plotBlocks.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',plotBlocks,as,box,Math.min(...plotBlocks.map(x=>x.pos ?? Infinity)),plotBlocks[0].index);
        entry.renderAssetId=id;entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:plotBlocks.map(x=>x.b.id),assetIds:as.map(x=>x.a.id)});
        plot=true;
      }
    }
    if(!form && !plot && paths.length>2000) diagnostics.push({code:'dense-vector-region-unresolved',pageIndex:pi});
    const seen=new Set();
    for(let n=0;n<(form || plot || paths.length>2000?0:paths.length);n++) {
      if(seen.has(n)) continue;
      const cluster=[n];seen.add(n);
      for(let k=0;k<cluster.length;k++) for(let j=0;j<paths.length;j++) {
        if(seen.has(j)) continue;
        const a=paths[cluster[k]],b=paths[j];
        if(a[0]<=b[2]+1 && b[0]<=a[2]+1 && a[1]<=b[3]+1 && b[1]<=a[3]+1) {seen.add(j);cluster.push(j);}
      }
      if(cluster.length<10) continue;
      const boxes=cluster.map(i=>paths[i]), box=union(boxes);
      const horizontal=boxes.filter(b=>b[2]-b[0]>10 && b[3]-b[1]<3).length;
      const vertical=boxes.filter(b=>b[3]-b[1]>10 && b[2]-b[0]<3).length;
      if(horizontal<3 || vertical<3 || box[2]-box[0]<40 || box[3]-box[1]<20) continue;
      const bs=blocks.filter(x=>x.b.text && !owned.has(x.b.id) && boxOK(x.box) && contains(box,x.box));
      if(bs.length<4 || blocks.some(x=>x.b.text && boxOK(x.box) && overlap(box,x.box) && !bs.includes(x)) || assets.some(x=>boxOK(x.box) && overlap(box,x.box) && !contains(box,x.box))) continue;
      const as=assets.filter(x=>!represented.has(x.a.id) && boxOK(x.box) && contains(box,x.box));
      bs.push(...blocks.filter(x=>!owned.has(x.b.id) && !bs.includes(x) && (x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id))));
      bs.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
      const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
      const entry=make('asset',bs,as,box,Math.min(...bs.map(x=>x.pos ?? Infinity)),bs[0].index);
      entry.renderAssetId=id; entries.push(entry);
      regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id)});
    }
    // Group overlapping image occurrences. Only fully contained text is owned as artwork.
    for(const a of assets) {
      if(represented.has(a.a.id)) continue;
      const group=[a];represented.add(a.a.id);
      if(boxOK(a.box)) for(let i=0;i<group.length;i++) for(const other of assets) if(!represented.has(other.a.id) && boxOK(other.box) && overlap(group[i].box,other.box)) {group.push(other);represented.add(other.a.id);}
      const box=group.every(x=>boxOK(x.box))?union(group.map(x=>x.box)):null;
      const proofs=evidence.filter(e=>e.pageIndex===pi && group.some(y=>y.a.id===e.assetId));
      const confirmed=x=>x.b.text && x.b.source?.range && proofs.some(e=>{const r=x.b.source.range;return e.ranges.some(z=>z.start<=r.start && z.end>=r.end);});
      const bs=blocks.filter(x=>!owned.has(x.b.id) && ((x.b.assetIds || []).some(id=>group.some(y=>y.a.id===id)) || confirmed(x)));
      bs.forEach(x=>owned.add(x.b.id));
      const entry=make('asset',bs,group,box,a.pos,a.index);
      if(proofs.length && bs.some(confirmed) && boxOK(box)) {
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        entry.renderAssetId=id;regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:group.map(x=>x.a.id),classification:'verified-occlusion'});
      }
      entries.push(entry);
    }
    const artworkNear=x=>paths.some(p=>overlap(p,x.box)) || assets.some(a=>boxOK(a.box) && a.box[0]<x.box[2]+15 && a.box[2]>x.box[0]-15 && a.box[1]<x.box[3]+15 && a.box[3]>x.box[1]-15);
    const repeated=x=>repeats.get(textKey(x.b))?.size>=2;
    const peer=x=>blocks.some(y=>y!==x && y.b.text?.trim() && boxOK(y.box) && repeated(y) && y.box[1]<x.box[3] && x.box[1]<y.box[3] && (y.box[2]<x.box[0] || x.box[2]<y.box[0]) && !artworkNear(y));
    const separatedBody=x=>blocks.some(y=>y!==x && y.b.text && boxOK(y.box) && y.box[1]>=page.height*.12 && y.box[3]<=page.height*.88);
    const linked=x=>linkedEdges.find(e=>e.b.id===x.b.id && e.b.source.range.start===x.b.source.range?.start && e.b.source.range.end===x.b.source.range?.end);
    const inferredEdge=x=>boxOK(x.box) && repeated(x) && bodySize && sizeOf(x.b) && separatedBody(x) && !artworkNear(x) && (sizeOf(x.b)<bodySize*.9 || peer(x) || linked(x));
    for(const x of blocks) {
      if(owned.has(x.b.id)) continue;
      owned.add(x.b.id); const b=x.b, box=x.box;
      let kind='paragraph';
      if(b.kind==='figure' || b.kind==='table') kind='asset';
      else if(b.kind==='caption' || /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d+[\w.:-]*/i.test(b.text || '')) kind='caption';
      else if(b.kind==='header' || b.kind==='footer') kind=b.kind;
      else if(decoratedFooter.has(b.id)) kind='footer';
      else if(inferredEdge(x)) {
        if(box[1]<page.height*.12) kind='header';
        else if(box[3]>page.height*.88) kind='footer';
      }
      else if(b.kind==='heading' || (bodySize>0 && sizeOf(b)>bodySize*1.3 && (b.text || '').trim().length>=12 && (b.text || '').length<150)) kind='heading';
      entries.push(make(kind,[x],[],box,x.pos,x.index));
    }
    // A presumed running edge cannot move past ordinary text already outside it.
    // Explicit source roles remain authoritative; inferred edges stay in body order.
    for(const edge of entries.filter(x=>['header','footer'].includes(x.kind))) {
      if(edge.blockIds.some(id=>flowBlocks.find(b=>b.id===id)?.kind===edge.kind) || !boxOK(edge.box)) continue;
      const ordinary=entries.filter(x=>['paragraph','heading'].includes(x.kind) && boxOK(x.box) && x.blockIds.some(id=>flowBlocks.find(b=>b.id===id)?.text?.trim()));
      if(ordinary.some(x=>edge.kind==='header' ? x.box[3]<=edge.box[1] : x.box[1]>=edge.box[3])) edge.kind='paragraph';
    }
    // Short adjacent fragments from one parent often describe styled runs of
    // a single line cluster (for example, an author list and superscripts).
    const parentGroups=new Map();
    for(const b of flowBlocks.filter(b=>b.parentBlockId && b.source.pageIndex===pi)) {
      if(!parentGroups.has(b.parentBlockId)) parentGroups.set(b.parentBlockId,[]);
      parentGroups.get(b.parentBlockId).push(b);
    }
    for(const group of parentGroups.values()) {
      if(group.length<3 || group.some(b=>inline.groups.some(g=>g.includes(b)))) continue;
      group.sort((a,b)=>a.source.range.start-b.source.range.start);
      const box=union(group.map(b=>b.source.bbox));
      if(!boxOK(box) || box[3]-box[1]>60 || group.some((b,i)=>i && group[i-1].source.range.end!==b.source.range.start)) continue;
      const members=group.map(b=>entries.find(e=>e.blockIds.length===1 && e.blockIds[0]===b.id));
      if(members.some(x=>!x || x.kind!=='paragraph')) continue;
      const first=members[0]; first.blockIds=group.map(b=>b.id); first.inline=true; first.joiners=Array(group.length-1).fill('');
      first.box=box; first.source.bbox=[...box];
      for(const member of members.slice(1)) entries.splice(entries.indexOf(member),1);
    }
    for(const group of inline.groups) {
      const members=group.map(b=>entries.find(e=>e.blockIds.length===1 && e.blockIds[0]===b.id));
      if(members.some(x=>!x || x.kind!=='paragraph')) continue;
      const first=members[0]; first.blockIds=group.map(b=>b.id); first.inline=true; first.joiners=Array(group.length-1).fill('');
      first.box=union(members.map(x=>x.box)); first.source.bbox=[...first.box];
      for(const member of members.slice(1)) entries.splice(entries.indexOf(member),1);
    }
    // Group only source-adjacent caption runs with matching measured font and
    // line geometry. Inline runs retain their exact order and joiners. A column
    // wrap requires aligned tops and a clear target column; other text is a
    // barrier even when it happens to use the same small font.
    const blockMap=new Map(flowBlocks.map(b=>[b.id,b]));
    const signature=e=>{
      const chars=e.blockIds.flatMap(id=>blockMap.get(id)?.source?.characters || []);
      const counts=new Map();
      for(const c of chars) {const s=styles.get(c.styleId); if(!s?.fontName || !Number.isFinite(s.size)) continue; const key=`${s.fontName.replace(/(?:Bold|Semibold|Italic|Oblique)/gi,'')}|${Math.round(s.size*10)/10}`; counts.set(key,(counts.get(key)||0)+1);}
      return [...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
    };
    const bounds=e=>e.blockIds.map(id=>blockMap.get(id)?.source?.range).filter(Boolean);
    const start=e=>Math.min(...bounds(e).map(r=>r.start));
    // Inline inserts can have independent native ranges far from the host.
    // Advance only through the host's contiguous source ranges, including all
    // fragments after such an insert, without treating the insert as an end.
    const end=e=>{
      const ranges=bounds(e).sort((a,b)=>a.start-b.start || a.end-b.end);
      let last=ranges[0]?.end;
      for(const r of ranges.slice(1)) {if(r.start>last) break; last=Math.max(last,r.end);}
      return last;
    };
    const lineCount=e=>e.blockIds.reduce((n,id)=>n+(blockMap.get(id)?.source?.lines?.length || 0),0);
    for(const caption of entries.filter(e=>e.kind==='caption' && boxOK(e.box))) {
      let last=caption;
      const members=[caption];
      while(true) {
        const lastEnd=end(last), sig=signature(last);
        if(!Number.isFinite(lastEnd) || !sig) break;
        const next=entries.filter(e=>e.kind==='paragraph' && !members.includes(e) && boxOK(e.box) && start(e)===lastEnd && signature(e)===sig && lineCount(e)>=1);
        const eligible=next.filter(e=>{
          const h=median(last.blockIds.flatMap(id=>(blockMap.get(id)?.source?.lines || []).map(l=>boxOK(l.bbox)?l.bbox[3]-l.bbox[1]:0)).filter(Boolean));
          if(!h) return false;
          const sameColumn=Math.min(last.box[2],e.box[2])-Math.max(last.box[0],e.box[0])>Math.min(last.box[2]-last.box[0],e.box[2]-e.box[0])*.5;
          const gap=e.box[1]-last.box[3];
          const adjacent=sameColumn && gap>=-h && gap<=h;
          const wrap=!sameColumn && e.box[0]>last.box[2] && lineCount(last)>=2 && lineCount(e)>=2 && Math.abs(e.box[1]-caption.box[1])<=h && last.box[3]>e.box[1]+2*h;
          if(!adjacent && !wrap) return false;
          const corridor=wrap ? [e.box[0],e.box[1],e.box[2],e.box[1]+h] : [Math.min(last.box[0],e.box[0]),Math.min(last.box[3],e.box[1]),Math.max(last.box[2],e.box[2]),Math.max(last.box[3],e.box[1])];
          return !entries.some(x=>x!==last && x!==e && !members.includes(x) && !['header','footer'].includes(x.kind) && boxOK(x.box) && overlap(corridor,x.box));
        });
        if(eligible.length!==1) break;
        last=eligible[0]; members.push(last);
      }
      if(members.length>1) {
        const ids=[],joiners=[];
        for(const member of members) {if(ids.length) joiners.push(' ');ids.push(...member.blockIds);if(member.inline) joiners.push(...member.joiners); else for(let i=1;i<member.blockIds.length;i++) joiners.push('');}
        caption.blockIds=ids; caption.inline=true;caption.joiners=joiners;
        caption.memberBoxes=members.map(e=>[...e.box]);
        caption.box=union(caption.memberBoxes);caption.source.bbox=[...caption.box];
        for(const member of members.slice(1)) entries.splice(entries.indexOf(member),1);
        diagnostics.push({code:'caption-continuation-grouped',pageIndex:pi,itemId:caption.id,memberItemIds:members.map(e=>e.id),blockIds:[...ids]});
      }
    }
    // Match measured caption direction and distance; retain each caption as text.
    for(const caption of entries.filter(x=>x.kind==='caption' && boxOK(x.box))) {
      const text=caption.blockIds.map(id=>flowBlocks.find(b=>b.id===id)?.text || '').join('');
      const table=/^\s*(?:extended\s+data\s+)?table\s*\d/i.test(text);
      const near=entries.filter(x=>x.kind==='asset' && boxOK(x.box) && x.box[0]<caption.box[2] && caption.box[0]<x.box[2]).map(x=>{
        const position=caption.box[3]<=x.box[1]?'above':caption.box[1]>=x.box[3]?'below':null;
        const gap=position==='above'?x.box[1]-caption.box[3]:position==='below'?caption.box[1]-x.box[3]:Infinity;
        const area=(x.box[2]-x.box[0])*(x.box[3]-x.box[1]);
        return {x,position,gap,area};
      }).filter(c=>c.position && c.gap<=Math.max(30,page.height*.05)).sort((a,b)=>a.gap-b.gap || b.area-a.area);
      const best=near[0];
      if(best && (near.length===1 || near[1].gap-best.gap>10 || (table && best.position==='above' && best.area>near[1].area*2 && best.gap<near[1].gap))) {
        best.x.captionIds.push(...caption.blockIds);
        best.x.captionPositions ||= {};
        for(const id of caption.blockIds) best.x.captionPositions[id]=best.position;
        relations.push({kind:'caption',assetItemId:best.x.id,captionItemId:caption.id,position:best.position});
      } else diagnostics.push({code:'caption-association-unresolved',pageIndex:pi,itemId:caption.id});
    }
    const headers=entries.filter(x=>x.kind==='header').sort(geom), footers=entries.filter(x=>x.kind==='footer').sort(geom);
    for(const edge of [...headers,...footers]) entries.splice(entries.indexOf(edge),1);
    let continuousOrder=null;
    if(entries.some(x=>!boxOK(x.box)) || !Number.isFinite(page.width)) {
      diagnostics.push({code:'reading-order-fallback',pageIndex:pi,detail:'Missing geometry; reader order retained.'}); entries.sort(reading);
    } else {
      // Find central gaps using individual source line boxes, excluding wide spanning lines.
      const lineBoxes=blocks.filter(x=>x.b.text && !ownedByAsset(x,entries)).flatMap(x=>{const lines=x.b.source?.lines?.map(l=>l.bbox).filter(boxOK) || [];return lines.length?lines:[x.box];}).filter(boxOK);
      const candidates=[];
      for(let mid=page.width*.25;mid<=page.width*.75;mid+=Math.max(1,page.width/400)) {
        const left=lineBoxes.filter(b=>b[2]<mid && b[2]>page.width*.2 && b[2]-b[0]>page.width*.25),right=lineBoxes.filter(b=>b[0]>mid && b[0]<page.width*.8 && b[2]-b[0]>page.width*.25);
        if(left.length<2 || right.length<2 || !left.some(a=>right.some(b=>a[1]<b[3] && b[1]<a[3]))) continue;
        const l=Math.max(...left.map(b=>b[2])),r=Math.min(...right.map(b=>b[0]));
        if(r-l>=Math.max(8,page.width*.015)) candidates.push({mid:(l+r)/2,l,r,score:Math.min(left.length,right.length)});
      }
      candidates.sort((a,b)=>b.score-a.score || Math.abs(a.mid-page.width/2)-Math.abs(b.mid-page.width/2));
      const g=candidates[0];
      if(!g) {entries.sort(geom); diagnostics.push({code:'single-column-or-unresolved',pageIndex:pi});}
      else {
        // A union across two measured caption columns is not a single wide
        // source line. Keep its first member as the reading-order anchor.
        const splitCaption=x=>x.kind==='caption' && x.memberBoxes?.length>1 && x.memberBoxes.every(b=>b[2]<=g.mid || b[0]>=g.mid) && x.memberBoxes.some(b=>b[2]<=g.mid) && x.memberBoxes.some(b=>b[0]>=g.mid);
        for(const item of entries.filter(splitCaption)) item.measuredColumns=2;
        if(entries.some(splitCaption)) {
          const layoutBox=x=>splitCaption(x)?x.memberBoxes[0]:x.box;
          const spans2=entries.filter(x=>!splitCaption(x) && x.box[0]<g.mid && x.box[2]>g.mid).sort(geom);
          const side2=entries.filter(x=>!spans2.includes(x)), groups2=[];
          for(const s of spans2) {const last=groups2.at(-1); if(last && s.box[1]<last.bottom) {last.items.push(s);last.bottom=Math.max(last.bottom,s.box[3]);} else groups2.push({items:[s],top:s.box[1],bottom:s.box[3]});}
          for(const c of side2.filter(x=>x.kind==='caption')) if(side2.some(x=>x!==c && x.kind==='paragraph' && x.box[3]<c.box[1]-5) && !groups2.some(g=>c.box[1]>=g.top && c.box[1]<g.bottom)) groups2.push({items:[],top:c.box[1],bottom:c.box[1]});
          groups2.sort((a,b)=>a.top-b.top); const bands2=Array.from({length:groups2.length+1},()=>[]);
          for(const x of side2) {let n=groups2.findIndex(g=>x.box[1]<g.bottom && x.box[3]>g.top);if(n>=0) groups2[n].items.push(x);else {n=groups2.findIndex(g=>x.box[3]<=g.top);bands2[n<0?groups2.length:n].push(x);}}
          continuousOrder=[];
          for(let i=0;i<bands2.length;i++) {const xs=bands2[i],left=xs.filter(x=>layoutBox(x)[2]<=g.mid).sort(geom),right=xs.filter(x=>layoutBox(x)[0]>=g.mid).sort(geom),both=(left.length && right.length)||xs.some(splitCaption);for(const x of xs) x.continuousColumns=both?2:1;continuousOrder.push(...left,...right);if(groups2[i]) continuousOrder.push(...groups2[i].items.sort(geom));}
        }
        const spans=entries.filter(x=>x.box[0]<g.mid && x.box[2]>g.mid).sort(geom);
        const side=entries.filter(x=>!spans.includes(x));
        // Spanning objects define local bands; overlapping side objects stay in the same band.
        const groups=[]; for(const s of spans) {const last=groups.at(-1);if(last && s.box[1]<last.bottom) {last.items.push(s);last.bottom=Math.max(last.bottom,s.box[3]);} else groups.push({items:[s],top:s.box[1],bottom:s.box[3]});}
        // A caption beginning below body text starts a new two-column band.
        for(const c of side.filter(x=>x.kind==='caption')) if(side.some(x=>x!==c && x.kind==='paragraph' && x.box[3]<c.box[1]-5) && !groups.some(g=>c.box[1]>=g.top && c.box[1]<g.bottom)) groups.push({items:[],top:c.box[1],bottom:c.box[1]});
        groups.sort((a,b)=>a.top-b.top);
        const bands=Array.from({length:groups.length+1},()=>[]);
        for(const x of side) {let n=groups.findIndex(g=>x.box[1]<g.bottom && x.box[3]>g.top);if(n>=0) {groups[n].items.push(x);diagnostics.push({code:'band-overlap',pageIndex:pi,itemId:x.id});} else {n=groups.findIndex(g=>x.box[3]<=g.top);bands[n<0?groups.length:n].push(x);}}
        const orderBand=xs=>{const left=xs.filter(x=>x.box[2]<=g.mid).sort(geom),right=xs.filter(x=>x.box[0]>=g.mid).sort(geom);const both=left.length && right.length;for(const x of xs) {x.columns=both?2:1;x.span=both?'column':'page';}return [...left,...right];};
        const ordered=[];for(let i=0;i<bands.length;i++){ordered.push(...orderBand(bands[i]));if(groups[i]) ordered.push(...groups[i].items.sort(geom));} entries.splice(0,entries.length,...ordered);
        diagnostics.push({code:'geometry-order-heuristic',pageIndex:pi,gutter:[g.l,g.r]});
      }
    }
    for(const header of headers) {
      const at=entries.findIndex(e=>boxOK(e.box) && e.box[1]>=header.box[1]);
      entries.splice(at<0?entries.length:at,0,header);
      if(continuousOrder) {const n=continuousOrder.findIndex(e=>boxOK(e.box) && e.box[1]>=header.box[1]);continuousOrder.splice(n<0?continuousOrder.length:n,0,header);}
    }
    if(continuousOrder) [...continuousOrder,...footers].forEach((item,i)=>item.continuousPosition=i);
    items.push(...[...entries,...footers].map(({box,pos,index,memberBoxes,...item})=>item));
  }
  // Only a previously established artwork region can follow a bottom caption.
  // Its labels and panels are owned together; independent text is a barrier.
  const blockMap=new Map([...document.blocks,...fragments].map(b=>[b.id,b]));
  const frameOK=p=>p && p.geometry?.frame==='mupdf-display' &&
    sameNumbers(p.geometry.bounds,[0,0,p.width,p.height]) &&
    Array.isArray(p.geometry.pageTransform) && p.geometry.pageTransform.length===6 && p.geometry.pageTransform.every(Number.isFinite);
  for(const page of document.pages) {
    const next=document.pages.find(p=>p.sourcePageIndex===page.sourcePageIndex+1);
    if(!frameOK(page) || !frameOK(next) || !sameNumbers(page.geometry.bounds,next.geometry.bounds) || !sameNumbers(page.geometry.pageTransform,next.geometry.pageTransform)) continue;
    const current=items.filter(i=>i.source.pageIndex===page.sourcePageIndex && !['header','footer'].includes(i.kind));
    const caption=current.at(-1);
    if(caption?.kind!=='caption' || !boxOK(caption.source.bbox) || caption.source.bbox[3]<page.height*.88 || relations.some(r=>r.kind==='caption' && r.captionItemId===caption.id)) continue;
    const blocks=caption.blockIds.map(id=>blockMap.get(id));
    if(blocks.some(b=>!b || b.source?.pageIndex!==page.sourcePageIndex || !b.source.range || page.text?.slice(b.source.range.start,b.source.range.end)!==b.text)) continue;
    const text=blocks.map(b=>b.text).join('');
    if(!/^\s*(?:extended\s+data\s+)?fig(?:ure)?\.?\s*\d/i.test(text) || !/[.!?][)\]"'\u2019\u201d]*\s*$/.test(text)) continue;
    const following=items.filter(i=>i.source.pageIndex===next.sourcePageIndex && !['header','footer'].includes(i.kind));
    if(following.length!==1 || following[0].kind!=='asset') continue;
    const artwork=following[0], box=artwork.source.bbox;
    const region=regions.find(r=>r.id===artwork.renderAssetId && r.pageIndex===next.sourcePageIndex && r.classification==='compound-figure');
    if(!region || !boxOK(box) || !sameNumbers(region.bbox,box) || box[2]-box[0]<next.width*.7 || box[3]-box[1]<next.height*.7 || artwork.captionIds.length ||
      region.blockIds.length!==artwork.blockIds.length || region.assetIds.length!==artwork.assetIds.length ||
      region.blockIds.some(id=>!artwork.blockIds.includes(id)) || region.assetIds.some(id=>!artwork.assetIds.includes(id))) continue;
    artwork.captionIds.push(...caption.blockIds); artwork.captionPositions ||= {};
    for(const id of caption.blockIds) artwork.captionPositions[id]='above';
    relations.push({kind:'caption',assetItemId:artwork.id,captionItemId:caption.id,position:'above',provenance:{rule:'adjacent-page-bottom-caption-full-page-artwork',sourceSha256:document.sourceSha256,captionPageIndex:page.sourcePageIndex,artworkPageIndex:next.sourcePageIndex,frame:'mupdf-display',regionId:region.id}});
    const unresolved=diagnostics.findIndex(d=>d.code==='caption-association-unresolved' && d.itemId===caption.id);
    if(unresolved>=0) diagnostics.splice(unresolved,1);
  }
  return {schema:'falsify.paper-flow.v1',sourceSha256:document.sourceSha256,items,relations,diagnostics,fragments,regions};
}
function ownedByAsset(x,entries) {return entries.some(e=>e.kind==='asset' && e.blockIds.includes(x.b.id));}

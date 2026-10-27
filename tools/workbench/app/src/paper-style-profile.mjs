const median = values => { const a=values.filter(Number.isFinite).sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : null; };

// These values describe source evidence, not measurements of the output PDF.
export function deriveLayoutProfile(document, flow) {
  const styles=new Map((document.styles || []).map(s=>[s.id,s]));
  const blocks=new Map((document.blocks || []).map(b=>[b.id,b]));
  const items=flow?.items || [];
  const byKind=kind=>items.filter(i=>i.kind===kind).flatMap(i=>(i.blockIds || []).map(id=>blocks.get(id)).filter(Boolean));
  const body=byKind('paragraph');
  const stats=bs=>{
    const sizes=[], names=[];
    for(const b of bs) {
      const chars=b.source?.characters || [];
      if(chars.length) for(const c of chars) {const s=styles.get(c.styleId); const n=Math.max(1,(c.end || 0)-(c.start || 0)); if(s?.size>0) for(let i=0;i<Math.min(n,256);i++) sizes.push(s.size); if(s?.fontName) names.push(s.fontName);}
      else {const s=styles.get(b.styleId); if(s?.size>0) sizes.push(s.size); if(s?.fontName) names.push(s.fontName);}
    }
    return {size:median(sizes),fontNames:[...new Set(names)]};
  };
  const rhythm=[];
  for(const b of body) {const lines=b.source?.lines || []; for(let i=1;i<lines.length;i++) {const a=lines[i-1].bbox, z=lines[i].bbox; if(Array.isArray(a) && Array.isArray(z)) {const d=z[1]-a[1]; if(d>0 && d<50) rhythm.push(d);}}}
  const bodyStats=stats(body), headingStats=stats(byKind('heading')), captionStats=stats(byKind('caption'));
  // Aggregate observed column-item rectangles, not guessed output bounds.
  const columnGroups=new Map();
  for(const i of items) {
    const box=i.source?.bbox, pi=i.source?.pageIndex, page=document.pages?.find(p=>p.sourcePageIndex===pi) || document.pages?.[pi];
    if(i.columns!==2 || !Array.isArray(box) || !Number.isFinite(page?.width)) continue;
    const side=(box[0]+box[2])/2 < page.width/2 ? 'left' : 'right', key=`${pi}:${side}`;
    const prev=columnGroups.get(key);
    columnGroups.set(key,{pageIndex:pi,bbox:prev ? [Math.min(prev.bbox[0],box[0]),Math.min(prev.bbox[1],box[1]),Math.max(prev.bbox[2],box[2]),Math.max(prev.bbox[3],box[3])] : [...box]});
  }
  const columns=[...columnGroups.values()];
  const captions=items.filter(i=>i.kind==='asset').flatMap(i=>(i.captionIds || []).map(id=>({text:blocks.get(id)?.text || '',assetPageIndex:i.source?.pageIndex,assetBbox:i.source?.bbox ? [...i.source.bbox] : null})));
  return {coordinateSpace:'source',bodyFontSize:bodyStats.size,bodyFontNames:bodyStats.fontNames,bodyLineHeight:median(rhythm),headingFontSize:headingStats.size,headingFontNames:headingStats.fontNames,captionFontSize:captionStats.size,captionFontNames:captionStats.fontNames,captions,headings:byKind('heading').map(b=>({text:b.text})),columns};
}

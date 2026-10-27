// Geometric suggestions over the source model; never an edit or export authority.
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const yOverlap = (a,b) => a[1] < b[3] && b[1] < a[3];
const byY = (a,b) => a.box[1]-b.box[1] || a.box[0]-b.box[0] || a.index-b.index;
const item = (b,index) => ({blockId:b.id,kind:b.kind,assetIds:[...(b.assetIds || [])],bbox:validBox(b.source?.bbox)?[...b.source.bbox]:null,readerPosition:b.source?.readerPosition ?? null,index});

/** Return candidate orders without modifying the source document. */
export function layoutHints(document) {
  if (document?.schema !== 'falsify.paper-document.v1' || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets)) throw new TypeError('Expected falsify.paper-document.v1');
  const pages = document.pages.map(page => {
    const items=document.blocks.map(item).filter(x=>document.blocks[x.index].source?.pageIndex===page.sourcePageIndex);
    const diagnostics=[];
    const say = (code,detail) => diagnostics.push({code,detail});
    const entries = xs => xs.map(({index,box,...rest})=>rest);
    // Preserve reader observation as an alternative, including null positions and ties.
    const reader=[...items].sort((a,b)=>(a.readerPosition ?? Infinity)-(b.readerPosition ?? Infinity) || a.index-b.index);
    const fallback=()=>({sourcePageIndex:page.sourcePageIndex,status:'unresolved',bands:[],candidates:[{basis:'reader-observation',items:entries(reader)}],diagnostics});
    if (!Number.isFinite(page.width) || page.width<=0 || items.some(x=>!x.bbox)) {say('geometry-unavailable','A page or block lacks usable geometry.'); return fallback();}
    for (const x of items) x.box=x.bbox;
    const represented=new Set(items.flatMap(x=>x.assetIds));
    if (document.assets.some(a=>a.source?.pageIndex===page.sourcePageIndex && !represented.has(a.id))) {say('asset-occurrence-unrepresented','An asset has no corresponding block on this page.'); return fallback();}
    if (!items.length) return {sourcePageIndex:page.sourcePageIndex,status:'candidate',bands:[],candidates:[{basis:'geometry',items:[]}],diagnostics};
    const edges=[...new Set(items.flatMap(x=>[x.box[0],x.box[2]]))].sort((a,b)=>a-b), gaps=[];
    for (let i=0;i<edges.length-1;i++) {
      const l=edges[i],r=edges[i+1],mid=(l+r)/2;
      if (r-l<Math.max(12,page.width*.025)) continue;
      const left=items.filter(x=>x.box[2]<=mid),right=items.filter(x=>x.box[0]>=mid),span=items.filter(x=>x.box[0]<mid && x.box[2]>mid);
      if (left.length<2 || right.length<2) continue;
      if (!left.some(a=>right.some(b=>yOverlap(a.box,b.box)))) continue;
      gaps.push({l,r,left,right,span});
    }
    if (gaps.length>1) {say('multiple-gutters','Multiple column divisions are plausible.');return fallback();}
    let bands=[];
    if (gaps.length===1) {
      const g=gaps[0];
      if (g.span.some(s=>items.some(x=>x!==s && yOverlap(s.box,x.box)))) {say('overlapping-spanning-band','A spanning block overlaps another block vertically.');return fallback();}
      const spans=[...g.span].sort(byY); let top=-Infinity;
      for (const span of [...spans,null]) {
        const bottom=span ? span.box[1] : Infinity;
        const within=x=>x.box[1]>=top && x.box[3]<=bottom;
        const left=g.left.filter(within).sort(byY),right=g.right.filter(within).sort(byY);
        if (left.length || right.length) bands.push({kind:'body',columns:[entries(left),entries(right)],gutter:[g.l,g.r]});
        if (span) {bands.push({kind:'spanning',items:entries([span])});top=span.box[3];}
      }
      if (bands.flatMap(b=>b.items || b.columns.flat()).length!==items.length) {say('band-boundary-ambiguous','Blocks cross a band boundary.');return fallback();}
    } else {
      const sorted=[...items].sort(byY);
      if (sorted.some((a,i)=>sorted.slice(i+1).some(b=>yOverlap(a.box,b.box)))) {say('overlapping-layout','No unique columns and vertically overlapping blocks.');return fallback();}
      bands=[{kind:'body',columns:[entries(sorted)],gutter:null}];
    }
    // Overlapping blocks within a column do not have a reliable geometric order.
    if (bands.some(b=>b.columns?.some(col=>col.some((a,i)=>col.slice(i+1).some(b=>yOverlap(a.bbox,b.bbox)))))) {say('overlapping-column-items','Items in a column overlap vertically.');return fallback();}
    const ordered=bands.flatMap(b=>b.items || b.columns.flat());
    say('geometry-heuristic','Candidate only; geometry does not prove reading order or relations.');
    return {sourcePageIndex:page.sourcePageIndex,status:'candidate',bands,candidates:[{basis:'geometry',items:ordered},{basis:'reader-observation',items:entries(reader)}],diagnostics};
  });
  return {schema:'falsify.paper-document-layout-hints.v1',sourceSha256:document.sourceSha256,pages};
}

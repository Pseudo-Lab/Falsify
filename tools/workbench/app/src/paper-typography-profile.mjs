const median = xs => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : null; };
const valid = (x,min,max) => Number.isFinite(x)&&x>=min&&x<=max;
const roleOf = i => i.extensions?.publicationRole==='title'?'title':i.extensions?.publicationRole==='section-heading'?'heading':i.extensions?.publicationRole==='footnote'?'footnote':i.kind==='heading'?'heading':i.kind==='caption'||i.reason==='caption-proposal'?'caption':i.kind==='footnote'?'footnote':'body';
export function inferTypographyProfile(model, overrides={}) {
  if (!model?.pages?.length || !Array.isArray(model.items)) throw new Error('INVALID_MODEL');
  const diagnostics=[], pages=model.pages;
  const pick=(name, observed, fallback) => { const value=observed??fallback; diagnostics.push({field:name,source:observed==null?'default':'observed',value}); return value; };
  const widthBp=pick('page.widthBp',median(pages.map(p=>p.width).filter(x=>valid(x,1,14400))),612);
  const heightBp=pick('page.heightBp',median(pages.map(p=>p.height).filter(x=>valid(x,1,14400))),792);
  const bodyItems=model.items.filter(i=>roleOf(i)==='body'&&i.kind==='paragraph'&&(!i.extensions?.publicationRole||i.extensions.publicationRole==='body'));
  // Page edges are estimated from the outer body extents, not the median
  // paragraph: otherwise the more populated column becomes the page margin.
  const extents=pages.map((page,index)=>{
    const boxes=bodyItems.flatMap(i=>i.evidence||[]).filter(e=>e.pageIndex===index && e.sourceSha256===model.sourceSha256 && e.frame==='mupdf-display').map(e=>e.bbox).filter(b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<=b[2]);
    return boxes.length?{left:Math.min(...boxes.map(b=>b[0])),right:page.width-Math.max(...boxes.map(b=>b[2]))}:null;
  }).filter(Boolean);
  const margin=(n,fallback)=>pick('page.margins.'+n,median(extents.map(e=>e[n]).filter(x=>valid(x,12,Math.min(widthBp,heightBp)/3))),fallback);
  const margins={left:margin('left',54),right:margin('right',54),top:36,bottom:36};
  diagnostics.push({field:'page.margins.top/bottom',source:'default',value:36});
  const hints=pages.map(p=>p.extensions?.layoutHints).filter(h=>h?.columns===2&&Array.isArray(h.gutterBp)&&h.gutterBp.length===2&&h.gutterBp.every(Number.isFinite)&&h.gutterBp[1]>h.gutterBp[0]);
  const columns=pick('page.columns',hints.length>pages.length/2?2:null,1);
  const gutterBp=pick('page.gutterBp',median(hints.map(h=>h.gutterBp[1]-h.gutterBp[0]).filter(x=>valid(x,1,200))),18);
  const styles={};
  for(const role of ['body','heading','caption','footnote','title']) {
    const its=role==='body'?bodyItems:model.items.filter(i=>roleOf(i)===role), sizes=its.map(i=>i.extensions?.typography?.fontSizeBp).filter(x=>valid(x,6,36));
    const sizeBp=pick(`roles.${role}.sizeBp`,median(sizes),role==='heading'?12:role==='body'?10:9);
    const leads=its.map(i=>i.extensions?.typography).filter(t=>valid(t?.leadingBp,sizeBp*.75,sizeBp*3)&&Array.isArray(t.leadingEvidence)&&t.leadingEvidence.length>=2&&t.leadingEvidence.every(e=>e.sourceSha256===model.sourceSha256)).map(t=>t.leadingBp);
    const leadingBp=pick(`roles.${role}.leadingBp`,median(leads),Math.round(sizeBp*120)/100);
    styles[role]={sizeBp,leadingBp,fontFamily:'serif'};
  }
  const profile={schema:'falsify.paper-typography.v1',page:{widthBp,heightBp,margins,columns,gutterBp},body:{...styles.body,indentEm:1,paragraphGapEm:0},roles:styles,fonts:{serif:'Latin Modern Roman'},packages:{needspace:true,luaWidowControl:true},diagnostics};
  for(const key of ['page','body','roles','fonts','packages']) if(overrides[key]) {
    if(key==='roles') for(const [r,v] of Object.entries(overrides.roles)) profile.roles[r]={...profile.roles[r],...v};
    else if(key==='page') profile.page={...profile.page,...overrides.page,margins:{...profile.page.margins,...overrides.page.margins}};
    else profile[key]={...profile[key],...overrides[key]};
    diagnostics.push({field:key,source:'override'});
  }
  if(overrides.body) profile.roles.body={...profile.roles.body,...Object.fromEntries(Object.entries(overrides.body).filter(([k])=>['sizeBp','leadingBp','fontFamily'].includes(k)))};
  return profile;
}

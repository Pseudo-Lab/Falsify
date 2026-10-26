// Source-only authority for document-flow geometry. Both producer and saved
// checker call this against immutable source bytes. captureLayout is injected
// to keep this module independent of the quality/compaction module graph.
import { unsupportedPage } from './pagination.mjs';
import { validateNativeLinkInventory } from './document-flow-links.mjs';
import { sourceUnderline } from './document-flow-underlines.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
export function checkDocumentFlowPageBudget(e) {
  const M=e.M;
  if(M._FPDFPage_CountObjects(e.page)>5000)fail('document_flow_object_budget_exceeded');
  const text=M._FPDFText_LoadPage(e.page);
  try {if(!text||M._FPDFText_CountChars(text)>100000)fail('document_flow_character_budget_exceeded');}
  finally {if(text)M._FPDFText_ClosePage(text);}
}

export function deriveDocumentFlowBand(engine, sourcePageIndex, captureLayout, annotationModel = null) {
  engine.loadPage(sourcePageIndex);
  checkDocumentFlowPageBudget(engine);
  if (unsupportedPage(engine)) fail('document_flow_geometry_unsupported');
  const M=engine.M;
  validateNativeLinkInventory(engine,sourcePageIndex,annotationModel);
  const ctx=captureLayout(engine,sourcePageIndex,engine.buildModel());
  const body=ctx.paras.filter(q=>q.role==='body'&&q.box);
  if(!body.length||body.some(q=>!q.editable||q.sharesObjects||!q.topLevel))fail('document_flow_body_unsupported');
  for(let i=0;i<body.length;i++)for(let j=i+1;j<body.length;j++){
    const a=body[i].box,b=body[j].box;
    if(Math.min(a.top,b.top)-Math.max(a.top-a.h,b.top-b.h)>1)fail('document_flow_table_or_columns_unsupported');
  }
  const edgeTop=ctx.paras.filter(q=>q.role!=='body'&&q.box&&q.box.top<ctx.pageH/2).map(q=>q.box.top+2);
  const handles=body.flatMap(q=>q.handles);
  const bounds=handles.map(h=>engine.objectBounds(h)).filter(Boolean);
  const x0=Math.min(...bounds.map(b=>b.x)),x1=Math.max(...bounds.map(b=>b.x+b.w));
  const bodyTop=Math.max(...bounds.map(b=>b.y+b.h));
  const floor=Math.max(0,...edgeTop,Math.min(ctx.pageH*.1,...bounds.map(b=>b.y)));
  if(!(bodyTop>floor))fail('document_flow_band_invalid');
  const owned=new Set(ctx.paras.flatMap(q=>q.handles));
  const underlines=[];
  const n=M._FPDFPage_CountObjects(engine.page);
  for(let i=0;i<n;i++){
    const h=M._FPDFPage_GetObject(engine.page,i)>>>0;
    if(owned.has(h))continue;
    const b=engine.objectBounds(h);
    if(!b)fail('document_flow_foreign_object_unsupported');
    if(b.y+b.h>=floor&&b.y<=bodyTop){
      if(!annotationModel||M._FPDFPageObj_GetType(h)!==2)fail('document_flow_foreign_object_unsupported');
      underlines.push(sourceUnderline(engine,h,sourcePageIndex,annotationModel));
    }
  }
  return {sourcePageIndex,bodyTop,flowTop:bodyTop,floor,x0,x1,width:ctx.pageW,height:ctx.pageH,underlines};
}

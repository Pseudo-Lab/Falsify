// Exact native glyph association for a trusted raw-dictionary adapter. This
// module never reads URI targets, follows actions or recreates dictionaries.
const fail=code=>{throw Object.assign(new Error(code),{code});};
const near=(a,b,t=.05)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t;
const bodyGlyph=(g,b)=>g.box&&(g.box.b+g.box.t)/2>=b.floor-.5&&(g.box.b+g.box.t)/2<=b.bodyTop+.5;
const intersects=(a,b)=>Math.min(a.r,b.r)-Math.max(a.l,b.l)>1e-4&&Math.min(a.t,b.t)-Math.max(a.b,b.b)>1e-4;

export function validateNativeLinkInventory(engine,pageIndex,model) {
  const M=engine.M,n=M._FPDFPage_GetAnnotCount?.(engine.page);
  if(!Number.isInteger(n)||n<0||n>512)fail('document_flow_annotations_unsupported');
  if(!n)return;
  if(!model||!Array.isArray(model.annotations))fail('document_flow_annotations_unsupported');
  const annotations=model.annotations.filter(a=>a.sourcePageIndex===pageIndex);
  if(annotations.length!==n)fail('document_flow_annotation_inventory_mismatch');
  const p=M._malloc(16);
  try{
    for(let i=0;i<n;i++){
      const descriptor=annotations.find(a=>a.annotationIndex===i);
      if(!descriptor||descriptor.kind!=='link'||descriptor.eligible!==true)fail(descriptor?.reason||'document_flow_annotation_unsupported');
      if(!['uri','internal'].includes(descriptor.destination?.type)||descriptor.destination.type==='internal'&&!Number.isInteger(descriptor.destination.targetSourcePageIndex)&&descriptor.preservedMissingDestination!==true)fail('document_flow_link_destination_unproven');
      const a=M._FPDFPage_GetAnnot(engine.page,i);
      try{
        if(!a||M._FPDFAnnot_GetSubtype(a)!==2||!M._FPDFAnnot_GetRect(a,p))fail('document_flow_annotation_inventory_mismatch');
        const [l,t,r,b]=Array.from(M.HEAPF32.slice(p>>2,(p>>2)+4));
        if(!Array.isArray(descriptor.rect)||descriptor.rect.length!==4||![l,b,r,t].every((v,k)=>near(v,descriptor.rect[k],.005)))fail('document_flow_annotation_inventory_mismatch');
      }finally{if(a)M._FPDFPage_CloseAnnot(a);}
    }
  }finally{M._free(p);}
}

export function readLinkPageCharacters(engine,pageIndex) {
  engine.loadPage(pageIndex);const M=engine.M,tp=M._FPDFText_LoadPage(engine.page),p=M._malloc(32),chars=[];
  try{
    if(!tp)fail('document_flow_link_text_unavailable');
    const n=M._FPDFText_CountChars(tp);if(n>100000)fail('document_flow_character_budget_exceeded');
    for(let i=0;i<n;i++){
      const u=M._FPDFText_GetUnicode(tp,i);let box=null;
      if(u>32&&M._FPDFText_GetCharBox(tp,i,p,p+8,p+16,p+24)){
        const [l,r,b,t]=Array.from(M.HEAPF64.slice(p>>3,(p>>3)+4));box={l,r,b,t};
      }
      chars.push({u,index:i,box,object:box?M._FPDFText_GetTextObject(tp,i)>>>0:0,generated:M._FPDFText_IsGenerated(tp,i)===1});
    }
  }finally{M._free(p);if(tp)M._FPDFText_ClosePage(tp);}
  return chars;
}

// Build a normalized source string with native character provenance. The
// quality edit planner resolves visible/logical discretionary-hyphen quotes;
// its exact spans are reused instead of fuzzy text searches for link labels.
function normalizedSource(chars,band) {
  const selected=chars.filter(c=>c.u<=32||bodyGlyph(c,band));let text='',indices=[];
  for(const c of selected){
    const ch=String.fromCharCode(c.u);
    if(/\s/.test(ch)){
      if(!text||text.endsWith(' '))continue;
      text+=' ';indices.push(null);
    }else{text+=ch;indices.push(c.u>32?c.index:null);}
  }
  if(text.endsWith(' ')){text=text.slice(0,-1);indices.pop();}
  return {text,indices};
}

function mapSourceGlyphs(sourceEngine,sourceBands,targetGlyphs,edits,expectedPageText) {
  const expected=[],mapping=new Map(),sources=new Map();
  for(const band of sourceBands){
    const chars=readLinkPageCharacters(sourceEngine,band.sourcePageIndex);sources.set(band.sourcePageIndex,chars);
    const normalized=normalizedSource(chars,band);
    const exp=expectedPageText(normalized.text,edits.filter(e=>e.pageIndex===band.sourcePageIndex),{includeSpans:true});
    if(!exp.ok)fail('document_flow_link_edit_mapping_ambiguous');
    const append=(start,end)=>{
      for(let i=start;i<end;i++){
        const u=normalized.text.charCodeAt(i);if(u<=32)continue;
        const original=normalized.indices[i];
        if(original!==null)mapping.set(`${band.sourcePageIndex}:${original}`,expected.length);
        expected.push(u);
      }
    };
    let at=0;
    for(const span of exp.spans){
      append(at,span.a);
      // Even a same-label occurrence in After is not source identity. A link
      // intersecting an explicit replacement is conservatively unsupported.
      for(const ch of span.after)if(ch.charCodeAt(0)>32)expected.push(ch.charCodeAt(0));
      at=span.b;
    }
    append(at,normalized.text.length);
  }
  if(expected.length!==targetGlyphs.length||expected.some((u,i)=>u!==targetGlyphs[i].u))fail('document_flow_link_text_mapping_mismatch');
  return {mapping,sources};
}

export function deriveNativeLinkMoves(sourceEngine,sourceBands,targetGlyphs,edits,model,expectedPageText,authorizedTargets=new Set()) {
  if(!model||!model.annotations.some(a=>sourceBands.some(b=>b.sourcePageIndex===a.sourcePageIndex)))return [];
  const ids=sourceBands.map(b=>b.sourcePageIndex);
  const {mapping,sources}=mapSourceGlyphs(sourceEngine,sourceBands,targetGlyphs,edits,expectedPageText);
  const moves=[],claimed=new Set();
  for(const descriptor of model.annotations.filter(a=>ids.includes(a.sourcePageIndex))){
    if(descriptor.eligible!==true||descriptor.kind!=='link')fail(descriptor.reason||'document_flow_annotation_unsupported');
    const targets=descriptor.internalDestinationSourcePageIndices||[descriptor.destination?.targetSourcePageIndex].filter(Number.isInteger);
    if(targets.some(i=>ids.includes(i)&&!authorizedTargets.has(i)))fail('document_flow_link_target_in_changed_body');
    const chars=sources.get(descriptor.sourcePageIndex),band=sourceBands.find(b=>b.sourcePageIndex===descriptor.sourcePageIndex);
    const [l,b,r,t]=descriptor.rect,rect={l,b,r,t};
    const owned=chars.filter(c=>c.box&&intersects(c.box,rect));
    const body=owned.filter(c=>bodyGlyph(c,band));
    if(!body.length){
      if(!(t<band.floor-.5||b>band.bodyTop+.5))fail('document_flow_link_unowned');
      continue; // Fixed edge annotation remains the original dictionary.
    }
    if(body.length!==owned.length)fail('document_flow_link_crosses_fixed_body');
    let dx,dy,outputPageIndex;const linkedTargets=new Set();
    for(const c of body){
      const key=`${descriptor.sourcePageIndex}:${c.index}`;
      if(claimed.has(key))fail('document_flow_link_overlapping_ownership');claimed.add(key);
      const at=mapping.get(key);if(at===undefined)fail('document_flow_link_edited_label');
      linkedTargets.add(at);
      const target=targetGlyphs[at];
      if(dx===undefined){dx=target.box.l-c.box.l;dy=target.box.b-c.box.b;outputPageIndex=target.outputPageIndex;}
      if(target.outputPageIndex!==outputPageIndex)fail('document_flow_link_split_page');
      if(!near(target.box.l,c.box.l+dx)||!near(target.box.r,c.box.r+dx)||!near(target.box.b,c.box.b+dy)||!near(target.box.t,c.box.t+dy))fail('document_flow_link_not_rigid_translation');
    }
    const translated={l:l+dx,r:r+dx,b:b+dy,t:t+dy};
    const outputOwned=targetGlyphs.flatMap((c,i)=>c.outputPageIndex===outputPageIndex&&intersects(c.box,translated)?[i]:[]);
    if(outputOwned.length!==linkedTargets.size||outputOwned.some(i=>!linkedTargets.has(i)))fail('document_flow_link_output_ownership_ambiguous');
    moves.push({sourcePageIndex:descriptor.sourcePageIndex,annotationIndex:descriptor.annotationIndex,outputPageIndex,dx,dy});
  }
  return moves;
}

// A FitR rectangle is only transportable when its entire area belongs to one
// source text object and every intersecting glyph has one rigid correspondence.
// Multi-object and partial-glyph ownership deliberately remain barriers.
export function deriveNativeFitRMoves(sourceEngine,sourceBands,targetGlyphs,edits,model,expectedPageText) {
  const ids=new Set(sourceBands.map(b=>b.sourcePageIndex));
  const destinations=new Map();
  for(const a of model?.annotations||[])for(const d of a.internalDestinations||[]){
    if(!ids.has(d.targetSourcePageIndex))continue;
    const previous=destinations.get(d.id);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(d))fail('document_flow_destination_alias_mismatch');
    destinations.set(d.id,d);
  }
  if(!destinations.size)return [];
  const {mapping,sources}=mapSourceGlyphs(sourceEngine,sourceBands,targetGlyphs,edits,expectedPageText);
  const moves=[];
  for(const d of destinations.values()){
    if(d.kind!=='FitR'||!Array.isArray(d.operands)||d.operands.length!==4||!d.operands.every(Number.isFinite))fail('document_flow_destination_unsupported');
    const [l,b,r,t]=d.operands,rect={l,b,r,t};
    if(l>=r||b>=t)fail('document_flow_destination_unsupported');
    const band=sourceBands.find(x=>x.sourcePageIndex===d.targetSourcePageIndex),chars=sources.get(d.targetSourcePageIndex);
    const owned=chars.filter(c=>c.box&&intersects(c.box,rect));
    if(!owned.length||owned.some(c=>!bodyGlyph(c,band)||!c.object||c.generated))fail('document_flow_destination_ownership_ambiguous');
    const object=owned[0].object;
    if(owned.some(c=>c.object!==object||c.box.l<l-.001||c.box.r>r+.001||c.box.b<b-.001||c.box.t>t+.001))fail('document_flow_destination_ownership_ambiguous');
    const objectChars=chars.filter(c=>c.box&&c.object===object&&bodyGlyph(c,band));
    const bounds={l:Math.min(...objectChars.map(c=>c.box.l)),r:Math.max(...objectChars.map(c=>c.box.r)),b:Math.min(...objectChars.map(c=>c.box.b)),t:Math.max(...objectChars.map(c=>c.box.t))};
    if(l<bounds.l-.001||r>bounds.r+.001||b<bounds.b-.001||t>bounds.t+.001)fail('document_flow_destination_ownership_ambiguous');
    let dx,dy,outputPageIndex;const targetIndices=new Set();
    for(const c of owned){
      const at=mapping.get(`${d.targetSourcePageIndex}:${c.index}`);if(at===undefined)fail('document_flow_destination_edited');
      const target=targetGlyphs[at];targetIndices.add(at);
      if(dx===undefined){dx=target.box.l-c.box.l;dy=target.box.b-c.box.b;outputPageIndex=target.outputPageIndex;}
      if(target.outputPageIndex!==outputPageIndex||!near(target.box.l,c.box.l+dx)||!near(target.box.r,c.box.r+dx)||!near(target.box.b,c.box.b+dy)||!near(target.box.t,c.box.t+dy))fail('document_flow_destination_not_rigid');
    }
    const translated={l:l+dx,r:r+dx,b:b+dy,t:t+dy};
    const outputOwned=targetGlyphs.flatMap((c,i)=>c.outputPageIndex===outputPageIndex&&intersects(c.box,translated)?[i]:[]);
    if(outputOwned.length!==targetIndices.size||outputOwned.some(i=>!targetIndices.has(i)))fail('document_flow_destination_ownership_ambiguous');
    moves.push({id:d.id,sourcePageIndex:d.targetSourcePageIndex,outputPageIndex,dx,dy});
  }
  return moves;
}

export function plannedLinkGlyphs(plan) {
  return plan.pages.flatMap((page,outputPageIndex)=>page.lines.flatMap(({index,dy})=>plan.lines[index].items.flatMap(({it})=>it.chars.filter(c=>c.u>32).map(c=>({u:c.u,outputPageIndex,box:{l:c.l,r:c.r,b:c.b+dy,t:c.t+dy}})))));
}

export function savedLinkGlyphs(engine,outputBands) {
  return outputBands.flatMap(b=>readLinkPageCharacters(engine,b.outputPageIndex).filter(c=>c.u>32&&bodyGlyph(c,b)).map(c=>({...c,outputPageIndex:b.outputPageIndex})));
}

// A page is eligible only if every reference to it has a corresponding FitR
// descriptor. Missing or mixed destination forms remain a barrier.
export function nativeFitRTargetPages(model, pages) {
  return new Set(pages.filter(page => {
    const refs=(model?.annotations||[]).filter(a=>(a.internalDestinationSourcePageIndices||[a.destination?.targetSourcePageIndex].filter(Number.isInteger)).includes(page));
    return refs.length>0 && refs.every(a=>{
      const ds=(a.internalDestinations||[]).filter(d=>d.targetSourcePageIndex===page);
      return ds.length>0 && ds.every(d=>d.kind==='FitR' && d.id!==undefined);
    });
  }));
}

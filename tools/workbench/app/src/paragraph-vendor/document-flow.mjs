// Bounded post-edit text-chain compaction. Objects are reconstructed with the
// same document's fonts because existing PDFium objects retain foreign stream
// indices when transferred. No rasterization, font scaling or text shortening.
import { createHash } from 'node:crypto';
import { capturePageLayout, expectedPageText } from './quality.mjs';
import { groupLines } from './pagination.mjs';
import { deriveDocumentFlowBand, checkDocumentFlowPageBudget } from './document-flow-band.mjs';
import { deriveNativeLinkMoves, plannedLinkGlyphs } from './document-flow-links.mjs';
import { snapshotTinyUnderline, matchStagedUnderlines, cloneUnderline, underlineEqual } from './document-flow-underlines.mjs';
import { snapshotTextObjects, cloneTextObject, verifyTextObject, snapshotPageEdges, applyPageEdges, verifyPageEdges } from './continuation-template.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const list = (M,p) => Array.from({length:M._FPDFPage_CountObjects(p)},(_,i)=>M._FPDFPage_GetObject(p,i)>>>0);
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)] || 14;

// Pure greedy planner: preserves line spacing within source page parts,
// replaces a physical page boundary with measured line pitch, fills original
// destination bands before allocating any tail page.
export function planDocumentLines(lines, bands, maxNewPages = 32) {
  if (!lines.length || !bands.length) fail('document_flow_empty');
  const pages = bands.map(b=>({...b, lines:[]})); let at=0, previous=null;
  for (let i=0;i<lines.length;i++) {
    const line=lines[i]; let p=pages[at];
    let top=previous ? previous.top - line.gap : p.bodyTop;
    if (top-(line.top-line.bottom)<p.floor-.01) {
      at++; previous=null;
      if (!pages[at]) {
        if (at-bands.length>=maxNewPages) fail('pagination_budget_exceeded');
        pages.push({...bands.at(-1), lines:[], generated:true});
      }
      p=pages[at];top=p.bodyTop;
    }
    if(top-(line.top-line.bottom)<p.floor-.01)fail('pagination_line_exceeds_body');
    p.lines.push({index:i,dy:top-line.top}); previous={top};
  }
  return pages;
}

function readPart(e, pageIndex, band, origin) {
  e.loadPage(pageIndex);
  checkDocumentFlowPageBudget(e);
  const M=e.M;
  const handles=list(M,e.page).filter(h=>{
    const b=e.objectBounds(h);if(!b)return false;
    const cy=b.y+b.h/2;return cy>=band.floor-.5&&cy<=band.bodyTop+.5;
  });
  const paths=handles.filter(h=>M._FPDFPageObj_GetType(h)!==1).map(h=>snapshotTinyUnderline(e,h));
  const snap=snapshotTextObjects(e,handles.filter(h=>M._FPDFPageObj_GetType(h)===1));if(!snap.ok)fail(snap.code);
  const items=snap.items.map(it=>({top:it.bounds.t,bottom:it.bounds.b,order:it.index,it}));
  const grouped=groupLines(items);
  if(grouped.loose.length)fail('document_flow_loose_text_unsupported');
  // Vertical clustering must not reorder mixed runs within a line merely
  // because their glyph ascenders differ. Keep source paint/text order.
  for(const line of grouped.lines)line.items.sort((a,b)=>a.order-b.order);
  // Cell-like gaps within one row are deliberately rejected; normal mixed
  // font runs touch or have a word-space sized gap.
  for(const line of grouped.lines){
    const row=[...line.items].sort((a,b)=>a.it.bounds.l-b.it.bounds.l);
    const em=it=>it.style.size*Math.max(Math.hypot(it.style.matrix[0],it.style.matrix[1]),Math.hypot(it.style.matrix[2],it.style.matrix[3]));
    for(let i=1;i<row.length;i++)if(row[i].it.bounds.l-row[i-1].it.bounds.r>2*Math.max(em(row[i].it),em(row[i-1].it)))fail('document_flow_table_or_columns_unsupported');
  }
  return {pageIndex,handle:e.page,handles,paths,items:snap.items,lines:grouped.lines.map(l=>({...l,origin,part:pageIndex})),band};
}

export async function compactDocumentFlow(engineFactory, sourceBytes, intermediatePdf, edits, preliminaryMap, maxNewPages=32, policy='strict', annotationAdapter=null) {
  const starts=preliminaryMap.filter(m=>m.continuationPageIndices.length&&m.sourcePageIndex<preliminaryMap.length-1);
  if(!starts.length)return {pdf:intermediatePdf,sourcePageMap:preliminaryMap,flowGroups:[],addedPages:preliminaryMap.reduce((n,m)=>n+m.continuationPageIndices.length,0)};
  if(preliminaryMap.length>64)fail('document_flow_page_budget_exceeded');
  if(annotationAdapter&&!['inspect','transport','validate'].every(k=>typeof annotationAdapter[k]==='function'))fail('document_flow_annotation_adapter_invalid');
  const annotationModel=annotationAdapter?await annotationAdapter.inspect({sourceBytes,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')}):null;
  if(annotationAdapter&&(!annotationModel||!Array.isArray(annotationModel.annotations)))fail('document_flow_annotation_inventory_mismatch');
  const src=await engineFactory(sourceBytes),e=await engineFactory(intermediatePdf);
  const M=e.M, held=new Set(), deleted=new Set(), groups=[], warnings=[], unowned=new Set();
  for(const a of annotationModel?.annotations||[])if(a.preservedMissingDestination===true)warnings.push({code:'source_broken_link_preserved',severity:'warning',pageIndex:a.sourcePageIndex,annotationIndex:a.annotationIndex});
  // Pin intermediate pages so model/snapshot handles cannot be evicted.
  e.pinnedPages=new Set(Array.from({length:e.pageCount},(_,i)=>i));
  try {
    let plans=[];
    for(let start=0;start<preliminaryMap.length;start++){
      if(!preliminaryMap[start].continuationPageIndices.length||start===preliminaryMap.length-1)continue;
      const bands=[],parts=[],lines=[];let end=start,planned;
      try {
      for(;end<preliminaryMap.length;end++){
        const included=bands.map(b=>b.sourcePageIndex);
        const targetBoundary=annotationModel?.annotations.some(a=>included.includes(a.sourcePageIndex)&&(a.internalDestinationSourcePageIndices||[a.destination?.targetSourcePageIndex].filter(Number.isInteger)).includes(end));
        if(end>start&&targetBoundary){
          if(bands.length<2)fail('document_flow_link_target_in_changed_body');
          warnings.push({code:'document_flow_internal_target_boundary',severity:'info',pageIndex:start,boundarySourcePageIndex:end});
          end--;break;
        }
        const band=deriveDocumentFlowBand(src,end,capturePageLayout,annotationModel);
        if(bands.length&&(Math.abs(band.width-bands[0].width)>.01||Math.abs(band.height-bands[0].height)>.01||Math.abs(band.x0-bands[0].x0)>2))fail('document_flow_incompatible_pages');
        bands.push(band);
        const map=preliminaryMap[end];
        for(const index of [map.outputPageIndex,...map.continuationPageIndices]){
          const part=readPart(e,index,band,end);parts.push(part);held.add(part.handle);
          const pitches=part.lines.slice(1).map((l,i)=>part.lines[i].top-l.top).filter(x=>x>0&&x<30);
          const pitch=median(pitches);
          for(let j=0;j<part.lines.length;j++)lines.push({...part.lines[j],gap:j?part.lines[j-1].top-part.lines[j].top:pitch});
          if(lines.length>10000)fail('document_flow_line_budget_exceeded');
        }
        planned=planDocumentLines(lines,bands,maxNewPages);
        // Need at least one existing NEXT page. Stop as soon as its capacity
        // absorbs the carry, so unrelated later barriers remain untouched.
        if(end>start&&planned.length===bands.length)break;
      }
      end=Math.min(end,preliminaryMap.length-1);
      // Clone preflight is part of eligibility, before any group mutates.
      for(const part of parts)if(!part.items.length)fail('document_flow_empty_body_unsupported');
      const plan={start,end,bands,parts,lines,pages:planned};
      plan.linkMoves=deriveNativeLinkMoves(src,bands,plannedLinkGlyphs(plan),edits,annotationModel,expectedPageText);
      const stagedGlyphs=parts.flatMap(part=>part.lines.flatMap(line=>line.items.flatMap(({it})=>it.chars.filter(c=>c.u>32).map(c=>({u:c.u,outputPageIndex:part.pageIndex,box:{l:c.l,r:c.r,b:c.b,t:c.t}})))));
      const stagedMoves=deriveNativeLinkMoves(src,bands,stagedGlyphs,edits,annotationModel,expectedPageText);
      plan.underlines=matchStagedUnderlines(bands,parts,stagedMoves);
      plans.push(plan);start=end;
      } catch(error) {
        if(policy!=='compatible-groups')throw error;
        warnings.push({code:'document_flow_barrier_not_compacted',severity:'warning',pageIndex:start,reason:error?.code||'document_flow_failed'});
      }
    }
    const allSourcePages=plans.flatMap(p=>p.bands.map(b=>b.sourcePageIndex));
    plans=plans.filter(p=>{
      const own=p.bands.map(b=>b.sourcePageIndex);
      const unresolved=annotationModel?.annotations.some(a=>a.destinationUnresolved===true&&a.preservedMissingDestination!==true);
      const actionOwnershipUnsupported=annotationModel?.actionOwnershipUnsupported===true;
      const blocked=annotationModel?.annotations.some(a=>{
        const targets=a.internalDestinationSourcePageIndices||[a.destination?.targetSourcePageIndex].filter(Number.isInteger);
        return targets.some(i=>own.includes(i))||own.includes(a.sourcePageIndex)&&targets.some(i=>allSourcePages.includes(i));
      });
      const reason=actionOwnershipUnsupported?'document_flow_link_action_ownership_unsupported':unresolved?'document_flow_link_unresolved_target':'document_flow_link_target_in_changed_body';
      if(unresolved||actionOwnershipUnsupported){
        if(policy!=='compatible-groups')fail(reason);
        warnings.push({code:'document_flow_barrier_not_compacted',severity:'warning',pageIndex:p.start,reason});return false;
      }
      if(!blocked)return true;
      if(policy!=='compatible-groups')fail(reason);
      warnings.push({code:'document_flow_barrier_not_compacted',severity:'warning',pageIndex:p.start,reason});return false;
    });
    if(!plans.length)return {pdf:intermediatePdf,sourcePageMap:preliminaryMap,flowGroups:[],addedPages:preliminaryMap.reduce((n,m)=>n+m.continuationPageIndices.length,0),warnings};
    // Snapshot original destination edges while every original object lives.
    for(const p of plans){
      const last=p.parts.find(x=>x.pageIndex===preliminaryMap[p.end].outputPageIndex);
      e.loadPage(last.pageIndex);
      p.edges=snapshotPageEdges(e,last.band.floor,last.band.bodyTop,new Set(last.handles));
      if(!p.edges.ok)fail(p.edges.code);
      // Reconstruct ALL participating body objects, including ones remaining
      // on their old page, into one streamless ordered block per destination.
      p.clones=p.pages.map(page=>page.lines.flatMap(({index,dy})=>p.lines[index].items.map(({it})=>{
        const h=cloneTextObject(e,it);if(!h)fail('document_flow_clone_failed');
        unowned.add(h);M._FPDFPageObj_Transform(h,1,0,0,1,0,dy);return {h,it,dy,origin:p.lines[index].origin};
      })));
      p.pathClones=p.pages.map(()=>[]);
      for(const {source}of p.underlines){
        const move=p.linkMoves.find(m=>m.sourcePageIndex===source.sourcePageIndex&&m.annotationIndex===source.annotationIndex);
        if(!move)fail('document_flow_underline_link_move_missing');
        const h=cloneUnderline(e,source,move.dx,move.dy);unowned.add(h);p.pathClones[move.outputPageIndex].push({h,source,move});
      }
    }
    for(const p of plans){
      for(const part of p.parts)for(const h of part.handles){if(!M._FPDFPage_RemoveObject(part.handle,h))fail('document_flow_remove_failed');unowned.add(h);}
      const destinations=p.bands.map(b=>p.parts.find(x=>x.pageIndex===preliminaryMap[b.sourcePageIndex].outputPageIndex));
      let insertion=preliminaryMap[p.end].outputPageIndex+1+preliminaryMap[p.end].continuationPageIndices.length;
      // New pages inserted only at this group's true terminal boundary.
      const priorInsertions=plans.filter(q=>q.start<p.start).reduce((n,q)=>n+Math.max(0,q.pages.length-q.bands.length),0);
      insertion+=priorInsertions;
      for(let k=p.bands.length;k<p.pages.length;k++){
        const h=M._FPDFPage_New(e.doc,insertion++,p.edges.pageW,p.edges.pageH);if(!h)fail('document_flow_new_page_failed');
        held.add(h);const edges=applyPageEdges(e,h,p.edges,k-p.bands.length+1,Infinity);if(!edges.ok)fail(edges.code);
        if(!M._FPDFPage_GenerateContent(h))fail('document_flow_generate_failed');
        if(!verifyPageEdges(e,h,p.edges,k-p.bands.length+1,edges).ok)fail('document_flow_edge_clone_mismatch');
        destinations.push({handle:h,band:p.bands.at(-1),generated:true});
      }
      for(let k=0;k<destinations.length;k++){
        const d=destinations[k], remain=list(M,d.handle);
        // Body block follows top edges, precedes bottom edges in list order.
        let at=remain.findIndex(h=>{const b=e.objectBounds(h);return b&&b.y+b.h/2<d.band.floor;});
        if(at<0)at=remain.length;
        const ordered=[...p.pathClones[k].filter(c=>c.source.paint==='before'),...p.clones[k],...p.pathClones[k].filter(c=>c.source.paint==='after')];
        for(const c of ordered){if(!M._FPDFPage_InsertObjectAtIndex(d.handle,c.h,at++))fail('document_flow_insert_failed');unowned.delete(c.h);}
        if(!M._FPDFPage_GenerateContent(d.handle))fail('document_flow_generate_failed');
        for(const c of p.clones[k])if(!verifyTextObject(e,d.handle,c.it,c.h,c.dy))fail('document_flow_clone_mismatch');
        for(const c of p.pathClones[k])if(!underlineEqual(snapshotTinyUnderline(e,c.h),c.source,c.move.dx,c.move.dy))fail('document_flow_underline_clone_mismatch');
      }
      for(const part of p.parts){
        if(preliminaryMap.some(m=>m.continuationPageIndices.includes(part.pageIndex)))deleted.add(part.pageIndex);
      }
      p.destinations=destinations;
      // Destroy removed objects only after the clone proof, so source font
      // references cannot disappear while clones are being constructed.
      for(const part of p.parts)for(const h of part.handles){M._FPDFPageObj_Destroy(h);unowned.delete(h);}
    }
    // Close every page/cache/history handle before deleting by physical index.
    for(const h of e._pageCache?.values()||[])held.add(h);if(e.page)held.add(e.page);
    for(const h of held){M._ec_history_drop_page?.(e.session,h);M._FPDF_ClosePage(h);}
    held.clear();e._pageCache?.clear();e.page=0;e._pageDirty=false;
    const insertions=plans.map(p=>({after:p.end,count:Math.max(0,p.pages.length-p.bands.length)}));
    const physicalShift = old => insertions.filter(x=>preliminaryMap[x.after].outputPageIndex+1+preliminaryMap[x.after].continuationPageIndices.length<=old).reduce((n,x)=>n+x.count,0);
    for(const i of [...deleted].sort((a,b)=>b-a))M._FPDFPage_Delete(e.doc,i+physicalShift(i));
    const map=preliminaryMap.map(m=>({...m,continuationPageIndices:[...m.continuationPageIndices]}));
    let out=0;
    for(let s=0;s<map.length;s++){
      const p=plans.find(p=>s>=p.start&&s<=p.end);
      const n=p?(s===p.end?Math.max(0,p.pages.length-p.bands.length):0):map[s].continuationPageIndices.length;
      map[s].outputPageIndex=out;map[s].continuationPageIndices=Array.from({length:n},(_,k)=>out+k+1);
      if(p){for(const key of ['lineCounts','keptLines','bodyTop','flowTop','floor','continuationStyle'])delete map[s][key];
        if(n)Object.assign(map[s],{bodyTop:p.bands.at(-1).bodyTop,flowTop:p.bands.at(-1).bodyTop,floor:p.bands.at(-1).floor,lineCounts:p.pages.slice(p.bands.length).map(q=>q.lines.length),continuationStyle:{version:1,policy:'source-number-suffix',applied:true}});
      }
      out+=1+n;
    }
    const annotationMoves=[];
    for(const p of plans){
      const indices=[...p.bands.map(b=>map[b.sourcePageIndex].outputPageIndex),...map[p.end].continuationPageIndices];
      annotationMoves.push(...p.linkMoves.map(move=>({...move,outputPageIndex:indices[move.outputPageIndex]})));
      const contentMap=p.bands.map(b=>({sourcePageIndex:b.sourcePageIndex,outputPageIndices:indices.filter((_,i)=>p.clones[i].some(c=>c.origin===b.sourcePageIndex))}));
      for(const c of contentMap)map[c.sourcePageIndex].contentOutputPageIndices=[...c.outputPageIndices];
      groups.push({version:1,sourcePages:p.bands.map(({sourcePageIndex,bodyTop,flowTop,floor,x0,x1})=>({sourcePageIndex,bodyTop,flowTop,floor,x0,x1})),outputPages:indices.map((outputPageIndex,i)=>({outputPageIndex,...Object.fromEntries(['bodyTop','flowTop','floor'].map(k=>[k,p.pages[i][k]])),x0:Math.min(...p.bands.map(b=>b.x0)),x1:Math.max(...p.bands.map(b=>b.x1)),lineCount:p.pages[i].lines.length})),contentMap});
    }
    e.pageCount=M._FPDF_GetPageCount(e.doc);
    let pdf=new Uint8Array(e.save());if(!pdf.length)fail('document_flow_save_failed');
    if(annotationAdapter&&annotationModel.annotations.length){
      const transported=await annotationAdapter.transport({model:annotationModel,sourceBytes,outputBytes:pdf,sourcePageMap:map,moves:annotationMoves,reflowedSourcePages:plans.flatMap(p=>p.bands.map(b=>b.sourcePageIndex))});
      pdf=new Uint8Array(transported?.pdf??transported);if(!pdf.length)fail('document_flow_annotation_transport_failed');
    }
    return {pdf,sourcePageMap:map,flowGroups:groups,annotationMoves,addedPages:e.pageCount-map.length,warnings};
  } finally {
    for(const h of unowned)try{M._FPDFPageObj_Destroy(h);}catch{}
    const cached=new Set(e._pageCache?.values()||[]);if(e.page)cached.add(e.page);
    for(const h of held)if(!cached.has(h))try{M._ec_history_drop_page?.(e.session,h);M._FPDF_ClosePage(h);}catch{}
    try{src.close();}catch{}try{e.close();}catch{}
  }
}

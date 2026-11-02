// Reuse the document-flow glyph provenance and raw annotation adapter for
// ordinary page edits. Unsupported mappings remain explicit failures.
import {createHash} from 'node:crypto';
import {deriveNativeLinkMoves, deriveNativeXYZMoves, deriveNativeFitRMoves, readLinkPageCharacters} from './paragraph-vendor/document-flow-links.mjs';
import {expectedPageText, readGlyphs, edgeGlyphsEquivalent, modelNumericEditProof, modelWordEditProof} from './paragraph-vendor/quality.mjs';
import {canonicalPage} from './paragraph-geometry-conservation.mjs';
import {ANNOTATION_LIMITS} from './document-flow-annotations.mjs';

const intersects=(a,b)=>Math.min(a.r,b.r)-Math.max(a.l,b.l)>1e-4&&Math.min(a.t,b.t)-Math.max(a.b,b.b)>1e-4;
const sameBox=(a,b)=>['l','r','b','t'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=.05);

// Prove an unchanged label by its exact owned glyphs and geometry, without
// relying on a page-wide extraction order. Changed glyphs are never accepted.
function stationaryLinks(links, source, target) {
  const proved=new Set();
  for(const link of links) {
    if(!Array.isArray(link.rect)||link.rect.length!==4||!link.rect.every(Number.isFinite))continue;
    const [x1,y1,x2,y2]=link.rect,rect={l:Math.min(x1,x2),r:Math.max(x1,x2),b:Math.min(y1,y2),t:Math.max(y1,y2)};
    const owned=source.chars.filter(c=>c.u>32&&c.box&&intersects(c.box,rect));
    if(!owned.length)continue;
    const outputOwned=target.chars.filter(c=>c.u>32&&c.box&&intersects(c.box,rect));
    if(outputOwned.length!==owned.length)continue;
    const used=new Set();let ok=true;
    for(const c of owned) {
      const asGlyph=c=>({u:c.u,...c.box,style:c.style});
      const matches=outputOwned.filter(t=>t.u===c.u&&sameBox(c.box,t.box)&&
        c.style&&t.style&&edgeGlyphsEquivalent([asGlyph(c)],[asGlyph(t)]));
      if(matches.length!==1||used.has(matches[0].index)){ok=false;break;}
      used.add(matches[0].index);
    }
    if(ok)proved.add(link.annotationIndex);
  }
  return proved;
}

// Numeric provenance binds every character before geometry is used. Preserve
// the source link's padding around the old label and reject added ownership.
function numericLink(link, source, target, proof, allAnnotations, pageIndex, outputPageIndex) {
  if(!proof||!link.eligible||!Array.isArray(link.rect)||link.quadPoints)return null;
  const [l,b,r,t]=link.rect,rect={l,b,r,t};
  const changed=new Set(proof.sourceIndices), replacement=new Set(proof.outputIndices);
  const owned=source.filter(c=>c.u>32&&c.box&&intersects(c.box,rect));
  if(!owned.length||!proof.sourceIndices.every(i=>owned.some(c=>c.index===i))||!proof.outputIndices.length)return null;
  const retained=new Map(proof.retained.map(x=>[x.sourceIndex,x.outputIndex]));
  const mapped=[];
  for(const c of owned){
    if(changed.has(c.index))continue;
    const n=retained.get(c.index),o=target[n];
    if(!o?.box||o.u!==c.u||!sameBox(c.box,o.box)||!c.style||!o.style||!edgeGlyphsEquivalent([{u:c.u,...c.box,style:c.style}],[{u:o.u,...o.box,style:o.style}]))return null;
    mapped.push(n);
  }
  const old=proof.sourceIndices.map(i=>source[i]), fresh=proof.outputIndices.map(i=>target[i]);
  if(old.some(c=>!c?.box||!c.style)||fresh.some(c=>!c?.box||!c.style))return null;
  // Compare effective font/style without requiring equal numeric glyph shape.
  const exemplar=old[0];
  for(const c of fresh)if(!edgeGlyphsEquivalent([{u:exemplar.u,...exemplar.box,style:exemplar.style}],[{u:exemplar.u,...exemplar.box,style:c.style}]))return null;
  const bounds=chars=>({l:Math.min(...chars.map(c=>c.box.l)),r:Math.max(...chars.map(c=>c.box.r)),b:Math.min(...chars.map(c=>c.box.b)),t:Math.max(...chars.map(c=>c.box.t))});
  const before=bounds(owned),after=bounds([...mapped.map(i=>target[i]),...fresh]);
  const nr=[Math.min(l,after.l-(before.l-l)),Math.min(b,after.b-(before.b-b)),Math.max(r,after.r+(r-before.r)),Math.max(t,after.t+(t-before.t))];
  if(nr.some(n=>!Number.isFinite(n))||before.l<l-.05||before.r>r+.05||before.b<b-.05||before.t>t+.05)return null;
  const box={l:nr[0],b:nr[1],r:nr[2],t:nr[3]}, allowed=new Set([...mapped,...replacement]);
  const inside=target.filter(c=>c.u>32&&c.box&&intersects(c.box,box));
  if(inside.length!==allowed.size||inside.some(c=>!allowed.has(c.index)))return null;
  for(const a of allAnnotations.filter(a=>a.sourcePageIndex===pageIndex&&a.annotationIndex!==link.annotationIndex)){
    if(!Array.isArray(a.rect)||a.rect.length!==4||!a.rect.every(Number.isFinite))return null;
    const [al,ab,ar,at]=a.rect;if(intersects(box,{l:Math.min(al,ar),r:Math.max(al,ar),b:Math.min(ab,at),t:Math.max(ab,at)}))return null;
  }
  return {sourcePageIndex:pageIndex,annotationIndex:link.annotationIndex,outputPageIndex,dx:0,dy:0,rect:nr};
}

function retainedLink(link,source,target,proof,pageIndex,outputPageIndex){
  if(!proof||!link.eligible||!Array.isArray(link.rect)||link.quadPoints)return null;
  const [l,b,r,t]=link.rect,box={l,b,r,t},retained=new Map(proof.retained.map(p=>[p.sourceIndex,p.outputIndex]));
  const owned=source.filter(c=>c.u>32&&c.box&&intersects(c.box,box));
  if(!owned.length)return null;
  let dx,dy;const ids=new Set();
  for(const c of owned){
    const q=target[retained.get(c.index)];if(!q?.box||q.u!==c.u||!c.style||!q.style)return null;
    dx??=q.box.l-c.box.l;dy??=q.box.b-c.box.b;
    if(!sameBox({...c.box,l:c.box.l+dx,r:c.box.r+dx,b:c.box.b+dy,t:c.box.t+dy},q.box)||!edgeGlyphsEquivalent([{u:c.u,...c.box,style:c.style}],[{u:c.u,...c.box,style:q.style}]))return null;
    ids.add(q.index);
  }
  const next={l:l+dx,r:r+dx,b:b+dy,t:t+dy},inside=target.filter(c=>c.u>32&&c.box&&intersects(c.box,next));
  if(inside.length!==ids.size||inside.some(c=>!ids.has(c.index)))return null;
  return {sourcePageIndex:pageIndex,outputPageIndex,annotationIndex:link.annotationIndex,dx,dy};
}

function changedProofBoxes(source,target,proof){
  const boxes=[...proof.sourceIndices.map(i=>source[i]?.box),...proof.outputIndices.map(i=>target[i]?.box)];
  if(boxes.some(b=>!b))return null;
  for(const p of proof.retained){const a=source[p.sourceIndex],b=target[p.outputIndex];
    if(!a||!b||a.u!==b.u||!!a.box!==!!b.box)return null;
    if(a.box){if(!a.style||!b.style||!edgeGlyphsEquivalent([{u:a.u,...a.box,style:a.style}],[{u:a.u,...a.box,style:b.style}]))return null;
      if(!sameBox(a.box,b.box))boxes.push(a.box,b.box);
    }
  }
  return boxes;
}

// Compare local rendered paint for a non-text link, not just the empty text
// inventory. The proof is deliberately restricted to unchanged upright pages.
function stationaryPaint(link,source,target,sourcePage,outputPage,sourceGeometry,targetGeometry) {
  if(typeof source.renderPageRegion!=='function'||typeof target.renderPageRegion!=='function'||!Array.isArray(link.rect)||sourceGeometry.frame?.rotation!==0||JSON.stringify(sourceGeometry.frame)!==JSON.stringify(targetGeometry.frame)||sourceGeometry.W!==targetGeometry.W||sourceGeometry.H!==targetGeometry.H)return false;
  const [l,b,r,t]=link.rect,W=sourceGeometry.W,H=sourceGeometry.H,scale=2;
  if(![l,b,r,t,W,H].every(Number.isFinite)||l<0||b<0||r>W||t>H||l>=r||b>=t)return false;
  const fullW=Math.ceil(W*scale),fullH=Math.ceil(H*scale),x=Math.floor(l*scale),y=Math.floor((H-t)*scale),w=Math.ceil(r*scale)-x,h=Math.ceil((H-b)*scale)-y;
  if(w*h>1000000||w<1||h<1)return false;
  source.loadPage(sourcePage);target.loadPage(outputPage);
  const a=source.renderPageRegion(fullW,fullH,x,y,w,h),z=target.renderPageRegion(fullW,fullH,x,y,w,h);
  if(!a?.data||!z?.data||a.data.length!==z.data.length)return false;
  let painted=false;for(let i=0;i<a.data.length;i++){if(a.data[i]!==z.data[i])return false;if(i%4!==3&&a.data[i]<250)painted=true;}
  return painted;
}

// A destination may point between text objects. In that case require the
// entire page's paint, apart from the proven replacement, to remain identical.
function stationaryPagePaint(src,out,pageIndex,outputPageIndex,s,t,proof,rawSource,rawTarget){
  if(!proof||s.frame?.rotation!==0||typeof src.renderPageRegion!=='function'||typeof out.renderPageRegion!=='function')return false;
  const styled=(raw,g)=>{const styles=new Map(g.glyphs.map(c=>[c.i,c.style]));return raw.map(c=>({...c,style:styles.get(c.index)}));};
  const box=changedProofBoxes(styled(rawSource,s),styled(rawTarget,t),proof);
  if(!box?.length)return false;
  const W=Math.ceil(s.W*2),H=Math.ceil(s.H*2);if(!Number.isSafeInteger(W)||!Number.isSafeInteger(H)||W<1||H<1||W*H>8000000)return false;
  const left=Math.floor(2*Math.min(...box.map(b=>b.l)))-3,right=Math.ceil(2*Math.max(...box.map(b=>b.r)))+3;
  const top=Math.floor(2*(s.H-Math.max(...box.map(b=>b.t))))-3,bottom=Math.ceil(2*(s.H-Math.min(...box.map(b=>b.b))))+3;
  src.loadPage(pageIndex);out.loadPage(outputPageIndex);
  const a=src.renderPageRegion(W,H,0,0,W,H),b=out.renderPageRegion(W,H,0,0,W,H);
  if(!a?.data||!b?.data||a.data.length!==b.data.length)return false;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(x>=left&&x<=right&&y>=top&&y<=bottom)continue;
    const p=(y*W+x)*4;for(let k=0;k<4;k++)if(a.data[p+k]!==b.data[p+k])return false;
  }
  return true;
}

// A destination anchored to an unchanged source object does not require a
// page-wide reading-order guess. Prove every character and style at the exact
// original geometry and exclude the requested edit span before keeping it.
function stationaryXYZ(destinations, source, target, edits, pageIndex, outputPageIndex, proof, pagePaint) {
  let text='', indices=[];
  for (const c of source.chars) {
    const ch=String.fromCharCode(c.u);
    if (/\s/u.test(ch)) { if(text&&!text.endsWith(' ')){text+=' ';indices.push(null);} }
    else {text+=ch;indices.push(c.index);}
  }
  if(text.endsWith(' ')){text=text.slice(0,-1);indices.pop();}
  const expected=expectedPageText(text,edits,{includeSpans:true});
  if (!expected.ok&&!proof) return [];
  const edited=proof?new Set(proof.sourceIndices):new Set(expected.spans.flatMap(s=>indices.slice(s.a,s.b).filter(i=>i!==null)));
  const retained=proof?new Map(proof.retained.map(x=>[x.sourceIndex,x.outputIndex])):null;
  const changedBoxes=proof?changedProofBoxes(source.chars,target.chars,proof):[];
  const pageStable=!!proof&&pagePaint&&!!changedBoxes;
  const groups=new Map();
  for(const c of source.chars) if(c.u>32&&c.object&&c.box&&!c.generated){const g=groups.get(c.object)||[];g.push(c);groups.set(c.object,g);}
  const proved=[];
  for(const d of destinations){
    if(d.kind!=='XYZ'||d.operands.length!==3||!Number.isFinite(d.operands[0])||!Number.isFinite(d.operands[1])||!(d.operands[2]===null||Number.isFinite(d.operands[2])))continue;
    const [x,y]=d.operands;
    if(pageStable&&!changedBoxes.some(q=>x>=q.l-.5&&x<=q.r+.5&&y>=q.b-.5&&y<=q.t+.5)){proved.push({id:d.id,sourcePageIndex:pageIndex,outputPageIndex,dx:0,dy:0});continue;}
    const matches=[...groups.values()].filter(g=>{const l=Math.min(...g.map(c=>c.box.l)), t=Math.max(...g.map(c=>c.box.t));return l>=x-.5&&l<=x+4&&t<=y+2&&t>=y-8;});
    if(matches.length!==1||matches[0].some(c=>edited.has(c.index)))continue;
    const used=new Set();let ok=true;
    for(const c of matches[0]){
      const candidates=target.chars.filter(t=>(!retained||retained.get(c.index)===t.index)&&t.u===c.u&&t.box&&sameBox(c.box,t.box)&&c.style&&t.style&&edgeGlyphsEquivalent([{u:c.u,...c.box,style:c.style}],[{u:t.u,...t.box,style:t.style}]));
      if(candidates.length!==1||used.has(candidates[0].index)){ok=false;break;} used.add(candidates[0].index);
    }
    if(ok)proved.push({id:d.id,sourcePageIndex:pageIndex,outputPageIndex,dx:0,dy:0});
  }
  return proved;
}

export async function transportParagraphLinks({engineFactory, sourceBytes, outputBytes, edits, sourcePageMap, flowGroups=[], annotationAdapter}) {
  const failures=[], moves=[], destinationMoves=[];
  const skipped=new Set(flowGroups.flatMap(g=>(g.sourcePages||[]).map(p=>p.sourcePageIndex)));
  const pages=[...new Set(edits.map(e=>e.pageIndex))].filter(p=>!skipped.has(p));
  let src,out,model;
  try {
    src=await engineFactory(sourceBytes); out=await engineFactory(outputBytes);
    for(const pageIndex of pages){
      src.loadPage(pageIndex);
      const count=src.M._FPDFPage_GetAnnotCount?.(src.page);
      if(!Number.isInteger(count)||count<0){failures.push({code:'paragraph_link_inventory_unverified',pageIndex});continue;}
      if(!count&&!annotationAdapter)continue;
      if(!annotationAdapter){failures.push({code:'paragraph_link_adapter_unavailable',pageIndex});continue;}
      try {
        if (!model) {
          try {
            model = await annotationAdapter.inspect({sourceBytes,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')});
          } catch (error) {
            // The raw adapter has a page limit. Only a complete PDFium inventory
            // can prove there are no incoming links when that limit is hit.
            if (error?.code !== 'annotation-document-unsupported' || !Number.isInteger(src.pageCount) || src.pageCount <= ANNOTATION_LIMITS.pages) throw error;
            let empty = true;
            try {
              for (let i=0; i<src.pageCount; i++) {
                src.loadPage(i);
                const n=src.M._FPDFPage_GetAnnotCount?.(src.page);
                if (!Number.isInteger(n) || n < 0) throw error;
                if (n) { empty=false; break; }
              }
            } finally { src.loadPage(pageIndex); }
            if (empty) continue;
            throw error;
          }
        }
        const links=model.annotations.filter(a=>a.sourcePageIndex===pageIndex&&a.kind==='link');
        const hasInbound=model.annotations.some(a=>(a.internalDestinationSourcePageIndices||[]).includes(pageIndex));
        if(!links.length&&!hasInbound)continue;
        const map=sourcePageMap.find(m=>m.sourcePageIndex===pageIndex);
        if(!map||map.continuationPageIndices?.length)throw Object.assign(new Error(),{code:'paragraph_link_continuation_unverified'});
        const pageEdits=edits.filter(e=>e.pageIndex===pageIndex);
        const sourceRaw=readLinkPageCharacters(src,pageIndex),targetRaw=readLinkPageCharacters(out,map.outputPageIndex);
        const sourceGeometry=readGlyphs(src,pageIndex),targetGeometry=readGlyphs(out,map.outputPageIndex);
        const identityMap=sourcePageMap.length===src.pageCount&&src.pageCount===out.pageCount&&sourcePageMap.every(m=>m.sourcePageIndex===m.outputPageIndex&&!m.continuationPageIndices?.length)&&sourceGeometry.W===targetGeometry.W&&sourceGeometry.H===targetGeometry.H&&JSON.stringify(sourceGeometry.frame)===JSON.stringify(targetGeometry.frame);
        let numericProof=null;
        if(identityMap&&typeof src.buildModel==='function'){try{src.loadPage(pageIndex);const model=src.buildModel();numericProof=modelNumericEditProof(sourceGeometry,targetGeometry,pageEdits,model)||modelWordEditProof(sourceGeometry,targetGeometry,pageEdits,model);}catch{}}
        const withStyle=(chars,geometry)=>{const styles=new Map(geometry.glyphs.map(g=>[g.i,g.style]));return chars.map(c=>({...c,style:styles.get(c.index)}));};
        const ownership=new Map();
        for(const link of links)if(Array.isArray(link.rect)&&link.rect.length===4&&link.rect.every(Number.isFinite)){
          const [x1,y1,x2,y2]=link.rect,rect={l:Math.min(x1,x2),r:Math.max(x1,x2),b:Math.min(y1,y2),t:Math.max(y1,y2)};
          for(const c of sourceRaw.filter(c=>c.box&&intersects(c.box,rect))){
            const owners=ownership.get(c.index)||[];owners.push(link.annotationIndex);ownership.set(c.index,owners);
          }
        }
        const overlapping=new Set([...ownership.values()].filter(a=>a.length>1).flat());
        for(const link of links.filter(a=>overlapping.has(a.annotationIndex)))failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:link.annotationIndex,reason:'document_flow_link_overlapping_ownership'});
        const candidates=links.filter(a=>!overlapping.has(a.annotationIndex));
        const stationary=stationaryLinks(candidates,{chars:withStyle(sourceRaw,sourceGeometry)},{chars:withStyle(targetRaw,targetGeometry)});
        const styledSource=withStyle(sourceRaw,sourceGeometry),styledTarget=withStyle(targetRaw,targetGeometry);
        for(const link of candidates.filter(a=>!stationary.has(a.annotationIndex))){
          const rect=link.rect;if(!Array.isArray(rect))continue;
          const [l,b,r,t]=rect,box={l:Math.min(l,r),r:Math.max(l,r),b:Math.min(b,t),t:Math.max(b,t)};
          if(identityMap&&!sourceRaw.some(c=>c.u>32&&c.box&&intersects(c.box,box))&&!targetRaw.some(c=>c.u>32&&c.box&&intersects(c.box,box))&&stationaryPaint(link,src,out,pageIndex,map.outputPageIndex,sourceGeometry,targetGeometry))stationary.add(link.annotationIndex);
        }
        const numericMoves=[];
        for(const link of candidates.filter(a=>!stationary.has(a.annotationIndex))){const move=retainedLink(link,styledSource,styledTarget,numericProof,pageIndex,map.outputPageIndex)||numericLink(link,styledSource,styledTarget,numericProof,model.annotations,pageIndex,map.outputPageIndex);if(move){numericMoves.push(move);stationary.add(link.annotationIndex);}}
        moves.push(...numericMoves);
        const remaining=candidates.filter(a=>!stationary.has(a.annotationIndex));
        const destinations = new Map();
        for (const a of model.annotations) for (const d of a.internalDestinations||[]) if (d.targetSourcePageIndex===pageIndex) destinations.set(d.id,d);
        const pagePaint=identityMap&&numericProof&&stationaryPagePaint(src,out,pageIndex,map.outputPageIndex,sourceGeometry,targetGeometry,numericProof,sourceRaw,targetRaw);
        const fixedDestinations = stationaryXYZ([...destinations.values()],{chars:withStyle(sourceRaw,sourceGeometry)},{chars:withStyle(targetRaw,targetGeometry)},pageEdits,pageIndex,map.outputPageIndex,numericProof,pagePaint);
        destinationMoves.push(...fixedDestinations);
        const fixedIds=new Set(fixedDestinations.map(d=>d.id));
        if (!remaining.length && fixedIds.size===destinations.size) continue;
        const band={sourcePageIndex:pageIndex,floor:-100000,bodyTop:100000};
        let sourcePage,outputPage,expected,targets,globalError;
        const ordered=(canonical,raw)=>canonical.chars.map(c=>{
          if(c.virtual)return {u:c.u,index:null,box:null};
          const native=raw[c.i];
          if(!native||native.index!==c.i||native.u!==c.u||(c.u>32&&!native.box))throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          return native;
        });
        try {
          sourcePage=canonicalPage(sourceGeometry);
          outputPage=canonicalPage(targetGeometry,sourcePage.partition);
          if(!sourcePage.ok||!outputPage.ok)throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          expected=expectedPageText(sourcePage.text,pageEdits,{includeSpans:true});
          if(!expected.ok)throw Object.assign(new Error(),{code:'document_flow_link_edit_mapping_ambiguous'});
          if(expected.text!==outputPage.text.replace(/\s+/gu,' ').trim())throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          targets=ordered(outputPage,targetRaw).filter(c=>c.u>32);
          const mappedTargets = targets.map(c => ({...c, outputPageIndex:map.outputPageIndex}));
          const kindModel = kind => ({...model, annotations:model.annotations.map(a => ({...a, internalDestinations:(a.internalDestinations||[]).filter(d=>d.kind===kind&&!fixedIds.has(d.id))}))});
          const provide = (_band,raw) => ordered(sourcePage,raw);
          destinationMoves.push(...deriveNativeXYZMoves(src,[band],mappedTargets,edits,kindModel('XYZ'),expectedPageText,provide));
          destinationMoves.push(...deriveNativeFitRMoves(src,[band],mappedTargets,edits,kindModel('FitR'),expectedPageText,provide));
        } catch(error) { globalError=error; }
        if (globalError && !remaining.length) throw globalError;
        for(const link of remaining){
          try {
            if(globalError)throw globalError;
            const linkModel={...model,annotations:[link]};
            const pageMoves=deriveNativeLinkMoves(src,[band],targets.map(c=>({...c,outputPageIndex:map.outputPageIndex})),edits,linkModel,expectedPageText,new Set(destinationMoves.map(d=>d.sourcePageIndex)),(_band,raw)=>ordered(sourcePage,raw));
            moves.push(...pageMoves);
          } catch(error) {failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:link.annotationIndex,reason:error?.code||'paragraph_link_mapping_failed'});}
        }
      } catch(error) {
        const links=model?.annotations?.filter(a=>a.sourcePageIndex===pageIndex&&a.kind==='link')||[];
        if(links.length)for(const a of links)failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:a.annotationIndex,reason:error?.code||'paragraph_link_mapping_failed'});
        else failures.push({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'annotation_inspection_failed'});
      }
    }
    if(model){
      try {
        const request={model,sourceBytes,outputBytes,sourcePageMap,moves,destinationMoves,preserveUnmovedUnsupported:true,reflowedSourcePages:pages};
        const pdf=(moves.length||destinationMoves.length)?new Uint8Array((await annotationAdapter.transport(request)).pdf):outputBytes;
        const verified=await annotationAdapter.validate({...request,outputBytes:pdf});
        if(!verified?.ok)throw Object.assign(new Error(),{code:verified?.code||'annotation_validation_failed'});
        return {pdf,moves,failures};
      } catch(error) {
        const affected=moves.length?moves:model.annotations.filter(a=>a.kind==='link'&&pages.includes(a.sourcePageIndex));
        if (!affected.length) failures.push({code:'paragraph_link_inventory_unverified',reason:error?.code||'annotation_transport_failed'});
        for(const move of affected)failures.push({code:'paragraph_link_unverified',pageIndex:move.sourcePageIndex,annotationIndex:move.annotationIndex,reason:error?.code||'annotation_transport_failed'});
      }
    }
    return {pdf:outputBytes,moves:[],failures};
  } catch(error) {
    return {pdf:outputBytes,moves:[],failures:[...failures,...pages.map(pageIndex=>({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'paragraph_link_check_failed'}))]};
  } finally {try{src?.close();}finally{out?.close();}}
}

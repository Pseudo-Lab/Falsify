import {hex} from './paragraph-pdf-crypto.mjs';

const overlaps = (a,b) => a.start < b.end && b.start < a.end;
const labelFor = key => `link-target-${hex(new TextEncoder().encode(JSON.stringify(key))).slice(0,24)}`;
const validRange = r => Number.isSafeInteger(r?.start) && Number.isSafeInteger(r?.end) && r.start >= 0 && r.start < r.end;

/** Project source annotations onto flow ownership. All offsets are page-absolute UTF-16. */
export function buildLinkPlan({document, flow, links, edits=[]}={}) {
  if (!document || !flow || !links || !Array.isArray(flow.items) || !Array.isArray(links.links) || !Array.isArray(edits)) throw new TypeError('Expected document, flow, link inventory and edits');
  if (!document.sourceSha256 || document.sourceSha256!==flow.sourceSha256 || document.sourceSha256!==links.sourceSha256) throw new Error('Source hash mismatch');
  const blocks=new Map([...(document.blocks||[]),...(flow.fragments||[])].map(b=>[b.id,b]));
  const parents=new Map((document.blocks||[]).map(b=>[b.id,b]));
  const owned=[];
  for (const item of flow.items) for (const id of item.blockIds||[]) {
    const block=blocks.get(id);
    if (block?.source?.range) owned.push({item,block,parentId:block.parentBlockId||id});
  }
  const assetItem=id=>flow.items.find(i=>i.kind==='asset' && (i.assetIds||[]).includes(id));
  const diagnostics=[], targets=[], targetMap=new Map(), raw=[], sourceAssets=[];
  const nativeEdits=[];
  for (const e of edits) {
    if (e.enabled===false) continue;
    const p=parents.get(e.blockId), r=p?.source?.range;
    if (!p || !validRange(e) || e.pageIndex!==p.source.pageIndex || e.start<r.start || e.end>r.end || typeof e.before!=='string' || typeof e.after!=='string' || p.text.slice(e.start-r.start,e.end-r.start)!==e.before) {
      diagnostics.push({code:'edit-unmapped',editId:e.id ?? null}); continue;
    }
    nativeEdits.push(e);
  }
  function target(link) {
    const t=link.target, rel=t?.relation;
    if (t?.status!=='resolved' || !rel) { diagnostics.push({code:'target-unresolved',linkId:link.id}); return null; }
    const page=t.pageIndex; let loc;
    if (rel.status==='text') {
      const matches=owned.filter(o=>o.parentId===rel.blockId && o.item.kind!=='asset' && o.block.source.pageIndex===page && o.block.source.range.start<=rel.start && o.block.source.range.end>=rel.end);
      const changed=nativeEdits.filter(e=>e.blockId===rel.blockId && overlaps(e,rel));
      if(changed.length) {
        const change=changed.some(e=>e.after==='')?'deleted':'replaced';
        targets.push({status:change,sourcePage:page,sourceRelation:{...rel},linkIds:[link.id],editIds:changed.map(e=>e.id??null)});
        diagnostics.push({code:'target-changed',linkId:link.id,editIds:changed.map(e=>e.id??null),change});
        return null;
      }
      if(matches.length===1) loc={blockId:matches[0].block.id,start:rel.start,end:rel.end};
      else { const assets=owned.filter(o=>o.parentId===rel.blockId && o.item.kind==='asset' && o.block.source.pageIndex===page && o.block.source.range.start<=rel.start && o.block.source.range.end>=rel.end); if(assets.length===1) loc={assetItemId:assets[0].item.id}; }
    } else if (rel.status==='asset') {
      const i=assetItem(rel.assetId); if(i && i.source?.pageIndex===page) loc={assetItemId:i.id};
    } else if (rel.status==='page-anchor') {
      // Page destinations follow the first surviving body character or asset.
      for(const i of flow.items) {
        if(i.source?.pageIndex!==page || i.kind==='header' || i.kind==='footer') continue;
        if(i.kind==='asset') {loc={assetItemId:i.id};break;}
        for(const id of i.blockIds||[]) {
          const b=blocks.get(id), r=b?.source?.range; if(!r) continue;
          let at=r.start;
          while(at<r.end) {const edit=nativeEdits.find(e=>e.blockId===(b.parentBlockId||b.id) && e.start<=at && at<e.end); if(!edit) break; at=edit.end;}
          if(at<r.end) {loc={blockId:b.id,start:at,end:at};break;}
        }
        if(loc) break;
      }
    }
    if(!loc) { diagnostics.push({code:'target-unmapped',linkId:link.id,sourcePage:page}); return null; }
    const key=[document.sourceSha256,page,loc], label=labelFor(key);
    if(!targetMap.has(label)) { const x={label,sourcePage:page,...loc}; targetMap.set(label,x); targets.push(x); }
    return label;
  }
  for (const link of links.links) {
    const destinationLabel=link.external ? null : target(link);
    const dest=link.external ? {uri:link.uri} : destinationLabel ? {destinationLabel,uri:link.uri} : {uri:link.uri,destinationStatus:targets.find(t=>t.linkIds?.includes(link.id))?.status || 'unresolved'};
    for(const range of link.relation?.ranges||[]) {
      if(!validRange(range)) {diagnostics.push({code:'source-range-invalid',linkId:link.id});continue;}
      let found=false;
      for(const o of owned) {
        if(o.parentId!==range.blockId || o.block.source.pageIndex!==link.source?.pageIndex || o.item.kind==='asset') continue;
        const r=o.block.source.range, start=Math.max(range.start,r.start), end=Math.min(range.end,r.end);
        if(start<end) { raw.push({blockId:o.block.id,parentBlockId:o.parentId,start,end,...dest,linkIds:[link.id]}); found=true; }
      }
      if(!found && !owned.some(o=>o.parentId===range.blockId && o.item.kind==='asset' && overlaps(o.block.source.range,range))) diagnostics.push({code:'source-unmapped',linkId:link.id,blockId:range.blockId});
    }
    for(const id of link.relation?.assetIds||[]) {const item=assetItem(id); if(item) sourceAssets.push({assetItemId:item.id,assetId:id,...dest,linkIds:[link.id]}); else diagnostics.push({code:'source-asset-unmapped',linkId:link.id,assetId:id});}
  }
  const key = r => JSON.stringify([r.blockId,r.uri,r.destinationLabel,r.destinationStatus]);
  raw.sort((a,b)=>a.blockId.localeCompare(b.blockId)||a.start-b.start||a.end-b.end||key(a).localeCompare(key(b)));
  const sourceRuns=[];
  for(const r of raw) {
    const prior=sourceRuns.find(x=>key(x)===key(r) && r.start<x.end && x.start<r.end);
    if(prior) {prior.start=Math.min(prior.start,r.start); prior.end=Math.max(prior.end,r.end); prior.linkIds=[...new Set([...prior.linkIds,...r.linkIds])];}
    else sourceRuns.push({...r,linkIds:[...r.linkIds]});
  }
  // Merge connected overlaps, including a later range that bridges two earlier ranges.
  for(let i=0;i<sourceRuns.length;i++) for(let j=i+1;j<sourceRuns.length;) {
    const a=sourceRuns[i], b=sourceRuns[j];
    if(key(a)===key(b) && overlaps(a,b)) { a.start=Math.min(a.start,b.start); a.end=Math.max(a.end,b.end); a.linkIds=[...new Set([...a.linkIds,...b.linkIds])]; sourceRuns.splice(j,1); j=i+1; } else j++;
  }
  for(let i=0;i<sourceRuns.length;i++) for(let j=i+1;j<sourceRuns.length;j++) {
    const a=sourceRuns[i], b=sourceRuns[j]; if(a.blockId===b.blockId && key(a)!==key(b) && overlaps(a,b)) {a.conflicted=true;b.conflicted=true;diagnostics.push({code:'source-link-conflict',blockId:a.blockId,start:Math.max(a.start,b.start),end:Math.min(a.end,b.end),linkIds:[...new Set([...a.linkIds,...b.linkIds])]});}
  }
  const changes=nativeEdits.map(e=>{
    const portions=sourceRuns.filter(r=>r.parentBlockId===e.blockId && overlaps(r,e)).map(r=>({blockId:r.blockId,start:Math.max(r.start,e.start),end:Math.min(r.end,e.end),linkIds:[...r.linkIds],...(r.destinationLabel?{destinationLabel:r.destinationLabel,uri:r.uri}:{uri:r.uri}),conflicted:!!r.conflicted}));
    // A union across adjacent flow fragments may represent one original annotation.
    const candidates=links.links.filter(l=>(l.relation?.ranges||[]).some(r=>r.blockId===e.blockId && r.start<=e.start && r.end>=e.end));
    const destinations=new Set(candidates.map(l=>JSON.stringify([l.external,l.uri,l.target])));
    const ordered=[...portions].sort((a,b)=>a.start-b.start); let cursor=e.start;
    for(const p of ordered) if(p.start<=cursor) cursor=Math.max(cursor,p.end);
    const covered=cursor>=e.end && portions.every(p=>!p.conflicted) && candidates.length && destinations.size===1 && candidates.every(l=>l.external || sourceRuns.some(r=>r.linkIds.includes(l.id) && r.destinationLabel));
    return {editId:e.id??null,blockId:e.blockId,start:e.start,end:e.end,portions,inherit:covered?{linkIds:candidates.map(l=>l.id),...((candidates[0].external)?{uri:candidates[0].uri}:{destinationLabel:targetMap.size ? sourceRuns.find(r=>r.linkIds.includes(candidates[0].id))?.destinationLabel : undefined,uri:candidates[0].uri})}:null};
  });
  return {schema:'falsify.paper-link-plan.v1',sourceSha256:document.sourceSha256,sourceRuns,sourceAssets,targets,changes,diagnostics};
}

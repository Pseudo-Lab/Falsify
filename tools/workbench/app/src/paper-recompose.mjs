import {readDocument} from './paper-document.mjs';
import {recoverSourceSpaces} from './paper-source-spacing.mjs';
import {buildPaperFlow} from './paper-flow.mjs';
import {readSourceAssets} from './paper-source-assets.mjs';
import {readSourceLinks} from './paper-source-links.mjs';
import {createFontPlan} from './paper-fonts.mjs';
import {composeDocument} from './paper-compose.mjs';
import {checkRecomposition} from './paper-compose-check.mjs';
import {buildOutputProfile} from './paper-output-profile.mjs';
import {resolveOutputAssetSpans} from './paper-asset-spans.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) throw new DOMException('Recomposition cancelled', 'AbortError'); };
const fail = (code, message, details={}) => { const e=new Error(message); e.code=code; e.details=details; throw e; };
const box = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<b[2] && b[1]<b[3];
const overlaps = (a,b) => a[0]<b[2] && b[0]<a[2] && a[1]<b[3] && b[1]<a[3];

// Keep one map entry per UTF-16 unit. Generated separators have no source.
function pageStreams(document, flow, visibleWrap=false) {
  const lookup=new Map([...document.blocks,...(flow.fragments||[])].map(b=>[b.id,b]));
  const streams=new Map();
  for(const item of flow.items) {
    if(item.kind==='asset') continue;
    const blocks=(item.blockIds||[]).map(id=>lookup.get(id)).filter(b=>b?.text);
    for(const [index,b] of blocks.entries()) {
      const p=b.source.pageIndex, s=streams.get(p)||{chars:[]}; streams.set(p,s);
      if(s.chars.length) {
        const sep=index && item.inline ? item.joiners[index-1] : ' ';
        for(const ch of sep) s.chars.push({ch,source:null});
      }
      const boundaries=new Set((b.source.lines||[]).slice(1).map(l=>l.range.start-b.source.range.start));
      const spaces=new Set(b.source.wordSpaceOffsets||[]);
      for(let i=0;i<b.text.length;i++) {
        if(boundaries.has(i) && i>0 && !/\s/u.test(b.text[i-1]) && !/\s/u.test(b.text[i]) && (visibleWrap || b.text[i-1]!=='-') && !(b.text[i-1]==='−' && /[0-9]/u.test(b.text[i]))) s.chars.push({ch:' ',source:null});
        const offset=b.source.range.start+i;
        const parent=lookup.get(b.parentBlockId||b.id), parentIndex=offset-(parent?.source?.range?.start??offset);
        if(spaces.has(offset) && parentIndex>0 && !/\s/u.test(parent.text[parentIndex-1]) && !/\s/u.test(b.text[i])) s.chars.push({ch:' ',source:null});
        const character=(b.source.characters||[]).find(c=>c.start<=offset && c.end>offset);
        s.chars.push({ch:b.text[i],source:{blockId:b.parentBlockId||b.id,start:offset,end:offset+1,bbox:character?.bbox||null,fragmentId:b.id}});
      }
    }
  }
  for(const s of streams.values()) {
    s.text=''; s.map=[];
    for(const entry of s.chars) {
      if(/\s/u.test(entry.ch)) {
        if(s.text.endsWith(' ')) {s.map.at(-1).push(entry.source); continue;}
        s.text+=' '; s.map.push([entry.source]);
      } else {s.text+=entry.ch; s.map.push([entry.source]);}
    }
  }
  return streams;
}
// Resolve selected native UTF-16 units against the ordered flow, including asset barriers.
function explicitParts(document, flow, edit, selection, index) {
  const bad=(message,code='INVALID_EXPLICIT')=>fail('source-binding',message,{index,id:edit.id,code});
  if(typeof selection.sourceSha256!=='string' || selection.sourceSha256!==document.sourceSha256) fail('stale-source','Explicit selection source hash mismatch.',{index,id:edit.id});
  if(!Array.isArray(selection.parts) || !selection.parts.length) bad('Explicit selection requires parts.');
  const blocks=new Map(document.blocks.map(b=>[b.id,b]));
  const lookup=new Map([...document.blocks,...(flow.fragments||[])].map(b=>[b.id,b]));
  const units=[], assetRanges=[];
  for(const item of flow.items) {
    if(item.kind==='asset') {
      for(const id of item.blockIds||[]) { const b=lookup.get(id); if(b?.source?.range) assetRanges.push({blockId:b.parentBlockId||b.id,...b.source.range}); }
      units.push(null); continue;
    }
    for(const id of item.blockIds||[]) {
      const b=lookup.get(id); if(!b?.text || !b.source?.range) continue;
      for(let offset=b.source.range.start;offset<b.source.range.end;offset++) units.push({blockId:b.parentBlockId||b.id,pageIndex:b.source.pageIndex,offset});
    }
  }
  const parts=selection.parts.map(p=>{
    const b=blocks.get(p?.blockId), r=b?.source?.range;
    if(!b || !r || p.pageIndex!==edit.pageIndex || b.source.pageIndex!==p.pageIndex || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start<r.start || p.end>r.end || p.start>=p.end || typeof p.before!=='string' || b.text.slice(p.start-r.start,p.end-r.start)!==p.before) bad('Explicit part does not match its native source.');
    const splitsScalar=offset=>offset>0 && offset<b.text.length && /[\uD800-\uDBFF]/u.test(b.text[offset-1]) && /[\uDC00-\uDFFF]/u.test(b.text[offset]);
    if(splitsScalar(p.start-r.start) || splitsScalar(p.end-r.start)) bad('Explicit part splits a Unicode scalar.');
    if(assetRanges.some(a=>a.blockId===p.blockId && p.start<a.end && p.end>a.start)) bad('Explicit selection includes asset-owned text.');
    return {blockId:p.blockId,pageIndex:p.pageIndex,start:p.start,end:p.end,before:p.before};
  });
  const selected=parts.flatMap(p=>Array.from({length:p.end-p.start},(_,i)=>({blockId:p.blockId,pageIndex:p.pageIndex,offset:p.start+i})));
  const same=(a,b)=>a && a.blockId===b.blockId && a.pageIndex===b.pageIndex && a.offset===b.offset;
  const counts=new Map();
  for(const u of units) if(u) { const key=JSON.stringify([u.blockId,u.pageIndex,u.offset]); counts.set(key,(counts.get(key)||0)+1); }
  if(selected.some(u=>counts.get(JSON.stringify([u.blockId,u.pageIndex,u.offset]))!==1)) bad('Explicit source units must have unique flow ownership.','AMBIGUOUS_EXPLICIT');
  let hits=0;
  for(let i=0;i<=units.length-selected.length;i++) if(selected.every((u,j)=>same(units[i+j],u))) hits++;
  if(hits!==1) bad('Explicit parts must select one contiguous, uniquely owned text range in flow order.',hits?'AMBIGUOUS_EXPLICIT':'INVALID_EXPLICIT');
  return parts;
}

export function bindEdits(document, flow, edits, explicit=[]) {
  const streams=pageStreams(document,flow), wrapped=pageStreams(document,flow,true), blocks=new Map(document.blocks.map(b=>[b.id,b]));
  const bindings=[], changes=[], used=new Map(), selections=new Map(), ids=new Map();
  for(const [index,e] of edits.entries()) if(e?.id!=null) {
    if(typeof e.id!=='string' || !e.id || ids.has(e.id)) fail('invalid-edit','Edit IDs must be unique nonempty strings.',{index,id:e.id});
    ids.set(e.id,index);
  }
  if(!Array.isArray(explicit)) fail('source-binding','Explicit bindings must be an array.',{code:'INVALID_EXPLICIT'});
  for(const selection of explicit) {
    if(!selection || (selection.id==null && selection.index==null)) fail('source-binding','Explicit binding requires an edit id or index.',{code:'INVALID_EXPLICIT'});
    const byId=selection.id==null?null:ids.get(selection.id), byIndex=selection.index==null?null:selection.index;
    if((selection.id!=null && byId===undefined) || (byIndex!=null && (!Number.isInteger(byIndex) || byIndex<0 || byIndex>=edits.length)) || (byId!=null && byIndex!=null && byId!==byIndex)) fail('source-binding','Explicit binding identifies an unknown or inconsistent edit.',{code:'INVALID_EXPLICIT'});
    const target=byId??byIndex;
    if(selections.has(target)) fail('source-binding','Duplicate explicit binding.',{index:target,code:'INVALID_EXPLICIT'});
    selections.set(target,selection);
  }
  for(const [index,e] of edits.entries()) {
    if(e?.enabled===false) continue;
    if(!Number.isInteger(e.pageIndex) || typeof e.before!=='string' || !e.before.trim() || typeof e.after!=='string') fail('invalid-edit','Edit requires pageIndex, Before and After.',{index,id:e.id});
    const selection=selections.get(index);
    let parts;
    if(selection) parts=explicitParts(document,flow,e,selection,index);
    else {
    const needle=e.before.replace(/\s+/gu,' '), hits=[];
    const variants=/-[^\S\r\n]*[\r\n]/u.test(e.before)?[streams,wrapped]:[streams];
    for(const variant of variants) { const stream=variant.get(e.pageIndex);
    if(stream) for(let at=stream.text.indexOf(needle);at>=0;at=stream.text.indexOf(needle,at+1)) {
      const refs=[];
      for(let pos=at;pos<at+needle.length;pos++) {
        refs.push(...stream.map[pos]);
      }
      const selected=refs.filter(Boolean);
      refs.splice(0,refs.length,...selected);
      if(!refs.length) continue;
      const segmentKnown=blocks.has(e.segmentId) || (flow.fragments||[]).some(f=>f.id===e.segmentId);
      if(segmentKnown && !refs.some(r=>r.blockId===e.segmentId || r.fragmentId===e.segmentId)) continue;
      const geometry=e.anchor?.bbox;
      if(box(geometry) && !refs.some(r=>box(r.bbox) && overlaps(geometry,r.bbox))) continue;
      if(!hits.some(hit=>JSON.stringify(hit.map(r=>[r.blockId,r.start,r.end]))===JSON.stringify(refs.map(r=>[r.blockId,r.start,r.end])))) hits.push(refs);
    }}
    if(hits.length!==1) fail('source-binding',hits.length?'Source quote is ambiguous.':'Source quote was not found.',{index,id:e.id,pageIndex:e.pageIndex,code:hits.length?'AMBIGUOUS_MATCH':'NO_MATCH',hits:hits.length});
    parts=[];
    for(const r of hits[0]) {
      const last=parts.at(-1);
      if(last && last.blockId===r.blockId && last.end===r.start) last.end=r.end;
      else if(!last || last.blockId!==r.blockId || last.end!==r.end) parts.push({blockId:r.blockId,pageIndex:e.pageIndex,start:r.start,end:r.end});
    }
    }
    for(const [i,p] of parts.entries()) {
      const b=blocks.get(p.blockId); if(!b || !b.source.range) fail('source-binding','Source block is unavailable.',{index,id:e.id});
      const before=b.text.slice(p.start-b.source.range.start,p.end-b.source.range.start);
      if(!before || before.length!==p.end-p.start) fail('source-binding','Source range is invalid.',{index,id:e.id});
      const prior=used.get(p.blockId)||[]; if(prior.some(x=>p.start<x.end && p.end>x.start)) fail('source-binding','Selected edits overlap.',{index,id:e.id,code:'OVERLAP'});
      prior.push(p); used.set(p.blockId,prior);
      p.before=before; changes.push({...p,after:i===0?e.after:''});
    }
    bindings.push({id:e.id||`edit-${index}`,matchMethod:selection?'explicit-source':'quote',pageIndex:e.pageIndex,segmentId:e.segmentId??null,before:e.before,after:e.after,request:structuredClone(e),sourceBefore:parts.map(p=>p.before).join(''),parts});
  }
  return {bindings,changes};
}

// Compare detected defects by type, rather than treating a score as proof of quality.
const issueCounts = result => {
  const counts={};
  for(const issue of result.verification.checkReport?.layoutQuality?.issues || []) counts[issue.type]=(counts[issue.type]||0)+1;
  for(const finding of result.verification.checkReport?.findings || []) if(finding.code==='text-outside-page') counts[finding.code]=(counts[finding.code]||0)+1;
  return counts;
};
const attemptSummary = result => ({placement:result.enginePlan.figurePlacement,content:result.verification.outputTextCheck,layout:result.verification.checkReport?.layoutQuality?.status || 'unavailable',issues:issueCounts(result)});
function repairIsBetter(first, candidate) {
  const a=first.verification, b=candidate.verification, report=b.checkReport;
  if(!['pass','normalized'].includes(b.outputTextCheck) || report?.readable!==true || report.checks?.independent?.status!=='declared') return false;
  if(b.coverage?.status!=='covered' || b.sourceGlyphs?.unavailable?.length || b.assetFindings?.length) return false;
  if(report.checks?.furniture?.status==='finding' || (b.furniture?.templates?.length && report.checks?.furniture?.status!=='checked')) return false;
  if(candidate.warnings.some(w=>w.startsWith('Source assets and non-text'))) return false;
  if(report.checks?.bounds?.status!=='checked' || report.layoutQuality?.status==='unavailable' || !report.layoutQuality) return false;
  const before=issueCounts(first), after=issueCounts(candidate);
  if(Object.keys(after).some(type=>after[type]>(before[type]||0))) return false;
  return !['pass','normalized'].includes(a.outputTextCheck) || Object.keys(before).some(type=>(after[type]||0)<before[type]);
}

export async function prepare(request={}, options={}) {
  const signal=request.signal; abort(signal);
  const layoutMode=request.layoutMode;
  if(layoutMode !== undefined && layoutMode !== 'measured-continuous') fail('invalid','Unknown layout mode');
  const candidates=(options.fonts||[]).map(f=>({...f,bytes:f.bytes instanceof Uint8Array?Uint8Array.from(f.bytes):f.bytes instanceof ArrayBuffer?f.bytes.slice(0):f.bytes}));
  const snapshot=Array.isArray(request.edits)?{edits:request.edits}:request.edits;
  if(!snapshot || !Array.isArray(snapshot.edits) || (snapshot.schema && snapshot.schema!=='falsify.paper-edits.v1')) fail('invalid','Expected edit array or paper edit snapshot.');
  const edits=structuredClone(snapshot.edits), explicit=structuredClone(request.bindings??[]), revision=snapshot.revision??request.revision??null;
  const hash=request.fileHash||snapshot.fileHash;
  if(request.fileHash && snapshot.fileHash && request.fileHash.toLowerCase()!==snapshot.fileHash.toLowerCase()) fail('stale-source','Request and snapshot hashes differ.');
  const input=request.file;
  const bytes=input instanceof Uint8Array?Uint8Array.from(input):input?.bytes instanceof Uint8Array?Uint8Array.from(input.bytes):typeof input?.arrayBuffer==='function'?new Uint8Array(await input.arrayBuffer()).slice():null;
  abort(signal); if(!bytes?.length) fail('invalid','Source PDF is required.');
  const observed=await readDocument({file:bytes,fileHash:hash,signal}); abort(signal);
  const spacing=await recoverSourceSpaces({bytes,document:observed,pdfjs:options.pdfjs,signal}); const document=spacing.document; abort(signal);
  const inventory=await readSourceAssets({bytes,document,signal}); abort(signal);
  const links=await readSourceLinks({bytes,document,signal}); abort(signal);
  const flow=buildPaperFlow(document,{drawings:inventory.drawings,links});
  const {bindings,changes}=bindEdits(document,flow,edits,explicit);
  const regions=(flow.regions||[]).map(r=>structuredClone(r));
  const ids=new Set(regions.map(r=>r.id));
  for(const item of flow.items.filter(i=>i.kind==='asset' && !i.renderAssetId)) {
    const p=document.pages[item.source.pageIndex], b=item.source.bbox;
    if(!p || !box(b)) continue;
    const clipped=[Math.max(0,b[0]),Math.max(0,b[1]),Math.min(p.width,b[2]),Math.min(p.height,b[3])];
    if(!box(clipped)) continue;
    const id=`capture-${item.id}`; if(ids.has(id)) fail('invalid','Duplicate capture ID.'); ids.add(id);
    item.source.bbox=clipped; item.renderAssetId=id;
    regions.push({id,pageIndex:item.source.pageIndex,bbox:clipped,blockIds:[...(item.blockIds||[])],assetIds:[...(item.assetIds||[])]});
  }
  const captured=await readSourceAssets({bytes,document:{...document,blocks:[...document.blocks,...(flow.fragments||[])]},regions,signal}); abort(signal);
  const fontPlan=await createFontPlan({text:document.blocks.map(b=>b.text||'').join('\n')+edits.filter(e=>e?.enabled!==false).map(e=>e.after).join('\n'),fonts:candidates},{mupdf:options.mupdf}); abort(signal);
  const composeOptions={compile:options.compile,fonts:fontPlan,outputCheck:async args=>{
    if(!options.pdfjs?.getDocument || !options.mupdf?.Document) return checkRecomposition({...args,pdfjs:options.pdfjs,mupdf:options.mupdf,exporter:'Typst'});
    const outputFlow=args.flow||flow;
    const assets=resolveOutputAssetSpans({bytes:args.bytes,mupdf:options.mupdf,flow:outputFlow,blockSpans:args.blockSpans});
    const {profile,evidence}=buildOutputProfile({bytes:args.bytes,mupdf:options.mupdf,document:args.document||{...document,blocks:[...document.blocks,...(flow.fragments||[])]},flow:outputFlow,expectedBlocks:args.expectedBlocks,fontPlan,assetSpans:assets.spans});
    const floatingCaptionBlockIds=profile.captions.map(c=>c.id);
    const flowExpectations=layoutMode==='measured-continuous' && floatingCaptionBlockIds.length ? {floatingCaptionBlockIds} : undefined;
    const report=await checkRecomposition({...args,flowExpectations,layoutProfile:{...args.layoutProfile,...profile},pdfjs:options.pdfjs,mupdf:options.mupdf,exporter:'Typst'});
    return {...report,outputProfileEvidence:{...evidence,assets:assets.evidence}};
  }};
  const compose = figurePlacement => composeDocument({document,sourceBytes:bytes,flow,assets:captured,links,edits:changes,signal,runningFurniture:options.runningFurniture===true,layoutMode,figurePlacement},composeOptions);
  const first=await compose('float'); abort(signal);
  let result=first, attempts=[attemptSummary(first)], selectedAttempt=1;
  if(first.enginePlan.actual==='measured-continuous' && (!['pass','normalized'].includes(first.verification.outputTextCheck) || Object.keys(issueCounts(first)).length)) {
    try {
      const second=await compose('page'); abort(signal);
      attempts.push(attemptSummary(second));
      if(repairIsBetter(first,second)) {result=second;selectedAttempt=2;}
    } catch(error) {
      abort(signal);
      if(error?.name==='AbortError') throw error;
      attempts.push({placement:'page',status:'failed'});
    }
  }
  const actual=new Uint8Array(await result.file.arrayBuffer()); abort(signal);
  if(hex(actual)!==result.sha256) fail('output-hash','Output bytes do not match their hash.');
  return {...result,repair:{attempts,selectedAttempt},revision,bindings,sourceLinks:links,sourceBinding:{spacing:spacing.evidence,sourceSha256:document.sourceSha256,editCount:bindings.length,partCount:changes.length},sourceAssets:{regions:regions.length,diagnostics:captured.diagnostics}};
}


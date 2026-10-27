import {buildLinkPlan} from './paper-link-plan.mjs';
import {readSourceGlyphs} from './paper-source-glyphs.mjs';
import {inspectFonts} from './paper-fonts.mjs';
const abort = signal => { if (signal?.aborted) throw new DOMException('Composition cancelled', 'AbortError'); };
const fail = message => { throw new Error(message); };
const captionOrder = item => [...(item.captionIds || []).filter(id=>item.captionPositions?.[id]==='above'),...(item.captionIds || []).filter(id=>item.captionPositions?.[id]!=='above')];
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
// Typst strings are data, never parsed as markup. Encode controls in Typst's own escape syntax.
export function typstString(value) {
  return '"' + Array.from(value, c => {
    const n=c.codePointAt(0);
    if (c==='"' || c==='\\') return '\\'+c;
    if (n<32 || n===127) return `\\u{${n.toString(16)}}`;
    return c;
  }).join('') + '"';
}
function lineBoundaries(block) {
  const {range,lines=[]}=block.source;
  if (!range || range.end-range.start!==block.text.length) fail('Invalid block source range');
  let prev=range.start; const bounds=[];
  for (const line of lines) {
    const r=line.range;
    if (!r || r.start!==prev || r.end<r.start || r.end>range.end) fail('Invalid line ranges');
    if (r.start>range.start) bounds.push(r.start-range.start);
    prev=r.end;
  }
  if (lines.length && prev!==range.end) fail('Incomplete line ranges');
  return bounds;
}
function separators(block) {
  const raw=block.text, base=block.source.range.start;
  const hints=new Set((block.source.wordSpaceOffsets || []).filter(x=>Number.isInteger(x) && x>base && x<base+raw.length).map(x=>x-base));
  const guessed=lineBoundaries(block).filter(i=>i>0 && i<raw.length && !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' && !(raw[i-1]==='−' && /[0-9]/u.test(raw[i])));
  return new Set([...guessed,...hints].filter(i=>! /\s/u.test(raw[i-1]) && ! /\s/u.test(raw[i])));
}
function logicalText(block, changes, omitted = new Set(), spaces = separators(block)) {
  const raw=block.text;
  let logical=''; const before=[], after=[];
  // Map each source offset to both sides of any inserted line separator.
  for (let i=0;i<=raw.length;i++) {
    before[i]=logical.length;
    if (spaces.has(i)) logical+=' ';
    after[i]=logical.length;
    if (i<raw.length && !omitted.has(i)) logical+=raw[i];
  }
  let out='', cursor=0;
  for (const edit of [...changes].sort((a,b)=>a.start-b.start)) {
    const start=after[edit.start], end=before[edit.end];
    out+=logical.slice(cursor,start)+edit.after;
    cursor=end;
  }
  return out+logical.slice(cursor);
}
// A source line break without whitespace does not prove whether two fragments
// were separate words. The inserted space is a layout convention, not evidence.
function ambiguousBoundaries(block, changes) {
  const raw=block.text;
  return lineBoundaries(block).filter(i=>!(block.source.wordSpaceOffsets||[]).includes(i+block.source.range.start) && i>0 && i<raw.length &&
    !changes.some(e=>e.start<i && i<e.end) &&
    !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' &&
    !(raw[i-1]==='−' && /[0-9]/u.test(raw[i])));
}
export async function composeDocument({document, edits=[], flow, assets, links, signal, sourceBytes, runningFurniture=false}={}, {compile, fonts={}, outputCheck, furniturePlanner}={}) {
  abort(signal);
  // Own the data used by this attempt before any asynchronous operation.
  if (document) document = structuredClone(document);
  flow = flow == null ? null : structuredClone(flow);
  assets = assets == null ? null : structuredClone(assets);
  links = links == null ? null : structuredClone(links);
  edits = edits.map(e=>({...e}));
  sourceBytes = sourceBytes instanceof Uint8Array ? new Uint8Array(sourceBytes) : sourceBytes;
  const plannerDocument=structuredClone(document);
  const originalFonts=fonts, glyphLookup=fonts.hasGlyph;
  const snapshots=(fonts.candidates || []).map(c=>{const b=c.getBytes?.(); const bytes=b instanceof Uint8Array ? Uint8Array.from(b) : null; return {id:c.id,family:c.family,sha256:c.sha256,getBytes:()=>bytes?.slice() ?? null};});
  const glyphResults=new Map();
  if(typeof glyphLookup==='function') for(const cp of new Set(Array.from((document?.blocks||[]).map(b=>b.text||'').join('')+edits.map(e=>e.after||'').join('')+' ', c=>c.codePointAt(0)))) {
    if(cp===9 || cp===10 || cp===13) continue;
    try { const pending=Promise.resolve(glyphLookup.call(originalFonts,cp)); pending.catch(()=>{}); glyphResults.set(cp,pending); } catch(error) { const pending=Promise.reject(error); pending.catch(()=>{}); glyphResults.set(cp,pending); }
  }
  fonts={...fonts,candidates:snapshots,selected:fonts.selected ? {...fonts.selected} : null,fallback:(fonts.fallback || []).map(x=>({...x})),hasGlyph:typeof glyphLookup==='function' ? cp=>glyphResults.get(cp) : undefined};
  if (document?.schema!=='falsify.paper-document.v1' || !/^[a-f0-9]{64}$/.test(document.sourceSha256) || !Array.isArray(document.blocks) || !Array.isArray(document.pages) || !document.pages.length) fail('Invalid paper document');
  if (!(sourceBytes instanceof Uint8Array) || await hash(sourceBytes)!==document.sourceSha256) fail('Source hash mismatch or source bytes unavailable');
  abort(signal);
  if (typeof compile!=='function') fail('Compiler is required');
  const ids=new Set(); for(const block of document.blocks) {if(!block.id || ids.has(block.id) || (block.text != null && typeof block.text!=='string')) fail('Ambiguous block ID or invalid text'); ids.add(block.id);}
  const linkPlan=links ? buildLinkPlan({document,flow,links,edits}) : null;
  const changes=new Map();
  for (const edit of edits) {
    const matches=document.blocks.filter(b=>b.id===edit.blockId && b.source?.pageIndex===edit.pageIndex && b.source?.range && edit.start>=b.source.range.start && edit.end<=b.source.range.end);
    if(matches.length!==1 || !Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start>=edit.end || typeof edit.before!=='string' || typeof edit.after!=='string') fail('Ambiguous or invalid edit target');
    const b=matches[0], start=edit.start-b.source.range.start, end=edit.end-b.source.range.start;
    if (b.text.slice(start,end)!==edit.before) fail('Edit before text mismatch');
    const list=changes.get(b.id)||[]; if(list.some(e=>start<e.end && end>e.start)) fail('Overlapping edit targets');
    list.push({start,end,after:edit.after,inherit:linkPlan?.changes.find(c=>c.blockId===edit.blockId && c.start===edit.start && c.end===edit.end)?.inherit || null}); changes.set(b.id,list);
  }
  const projectedSpaces=new Map(), projectedAmbiguous=[];
  if (flow?.fragments?.length) {
    const parents=new Map(document.blocks.map(b=>[b.id,b])), groups=new Map();
    for(const f of flow.fragments) {
      const parent=parents.get(f.parentBlockId), r=f.source?.range, pr=parent?.source?.range;
      if(!parent || !r || !pr || f.id===parent.id || ids.has(f.id) || f.source.pageIndex!==parent.source.pageIndex || r.start<pr.start || r.end>pr.end || r.start>=r.end || f.text!==parent.text.slice(r.start-pr.start,r.end-pr.start)) fail('Invalid flow fragment');
      ids.add(f.id); const group=groups.get(parent.id)||[]; group.push(f); groups.set(parent.id,group);
    }
    for(const [id,group] of groups) {
      const parent=parents.get(id), pr=parent.source.range; group.sort((a,b)=>a.source.range.start-b.source.range.start);
      let cursor=pr.start; for(const f of group) {if(f.source.range.start!==cursor) fail('Flow fragments do not cover parent exactly'); cursor=f.source.range.end;} if(cursor!==pr.end) fail('Flow fragments do not cover parent exactly');
      const parentChanges=changes.get(id)||[], parentSpaces=separators(parent);
      const ambiguous=new Set(ambiguousBoundaries(parent,parentChanges));
      for(const f of group) {
        const start=f.source.range.start-pr.start, end=f.source.range.end-pr.start;
        const spaces=new Set([...parentSpaces].filter(i=>i>=start && i<end && !parentChanges.some(e=>e.start<i && i<e.end)).map(i=>i-start));
        projectedSpaces.set(f.id,spaces);
        for(const i of ambiguous) if(i>=start && i<end) projectedAmbiguous.push({blockId:f.id,offset:pr.start+i});
      }
      for(const edit of parentChanges) {
        const a=pr.start+edit.start, b=pr.start+edit.end, overlap=group.filter(x=>a<x.source.range.end && b>x.source.range.start);
        for(const [i,f] of overlap.entries()) {const r=f.source.range, list=changes.get(f.id)||[]; list.push({start:Math.max(a,r.start)-r.start,end:Math.min(b,r.end)-r.start,after:i===0?edit.after:'',inherit:i===0?edit.inherit:null}); changes.set(f.id,list);}
      }
      changes.delete(id);
    }
    document.blocks=document.blocks.flatMap(b=>groups.get(b.id)||[b]);
    for(const id of groups.keys()) ids.delete(id);
  }
  const balanceGroups=[];
  if (flow) {
    if(flow.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items)) fail('Invalid paper flow');
    const owners=new Set();
    for(const item of flow.items) for(const id of item.blockIds || []) {
      if(!ids.has(id) || owners.has(id)) fail('Unknown or duplicate flow block');
      owners.add(id);
      if(item.kind==='asset' && changes.has(id)) fail('Cannot edit text owned by a source asset');
    }
    for(const block of document.blocks) if(block.text && !owners.has(block.id)) fail('Flow omits text block');
  }
  // An inline joiner already ending in whitespace supplies a fragment's leading separator.
  for(const item of flow?.items || []) if(item.inline && Array.isArray(item.joiners)) for(let i=1;i<(item.blockIds||[]).length;i++) {
    if (/\s$/u.test(item.joiners[i-1] || '')) projectedSpaces.get(item.blockIds[i])?.delete(0);
  }
  const spacesFor=b=>projectedSpaces.get(b.id) || separators(b);
  const assetOwned = new Set((flow?.items || []).filter(item=>item.kind==='asset').flatMap(item=>item.blockIds || []));
  const orderedById=new Map(document.blocks.map(b=>[b.id,b]));
  const linked=new Set((flow?.items||[]).filter(i=>i.kind==='asset').flatMap(i=>i.captionIds||[]));
  const orderedBlocks=flow ? flow.items.flatMap(i=>i.kind==='asset' ? captionOrder(i).map(id=>orderedById.get(id)) : (i.blockIds||[]).filter(id=>!linked.has(id)).map(id=>orderedById.get(id))) : document.blocks;
  const sourceGlyphResult=readSourceGlyphs({bytes:sourceBytes,document:{...document,blocks:document.blocks.filter(b=>!assetOwned.has(b.id))},changes});
  const glyphsByBlock=new Map();
  for(const glyph of sourceGlyphResult.glyphs) {const list=glyphsByBlock.get(glyph.blockId)||[]; list.push(glyph); glyphsByBlock.set(glyph.blockId,list);}
  const omittedFor=b=>new Set((glyphsByBlock.get(b.id)||[]).flatMap(g=>Array.from({length:g.end-g.start},(_,i)=>g.start-b.source.range.start+i)));
  let expectedBlocks=orderedBlocks.filter(b=>typeof b?.text==='string' && b.text.length).map(b=>({id:b.id,text:logicalText(b,changes.get(b.id)||[],omittedFor(b),spacesFor(b))}));
  if(flow) for(const item of flow.items.filter(i=>i.inline)) {
    if(!Array.isArray(item.joiners) || item.joiners.length!==(item.blockIds||[]).length-1 || item.joiners.some(j=>typeof j!=='string')) fail('Invalid inline joiners');
    const indexes=item.blockIds.map(id=>expectedBlocks.findIndex(b=>b.id===id));
    if(indexes.some((x,i)=>x<0 || (i && x!==indexes[0]+i))) fail('Inline blocks must be consecutive');
    const text=indexes.map((idx,i)=>expectedBlocks[idx].text+(item.joiners[i]||'')).join('');
    expectedBlocks.splice(indexes[0],indexes.length,{id:item.blockIds[0],text});
  }
  const artworkBlocks=document.blocks.filter(b=>assetOwned.has(b.id) && b.text).map(b=>({id:b.id,text:logicalText(b,[],new Set(),spacesFor(b))}));
  const texts=expectedBlocks.map(b=>b.text);
  const ambiguous=[...projectedAmbiguous,...document.blocks.filter(b=>!projectedSpaces.has(b.id) && typeof b.text==='string' && b.text.length).flatMap(b=>ambiguousBoundaries(b,changes.get(b.id)||[]).map(offset=>({blockId:b.id,offset:offset+b.source.range.start})))];
  const coverage=await inspectFonts(texts.join('\n'),fonts); abort(signal);
  const page=document.pages[0]; if(!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0) fail('Invalid page size');
  let plan=null;
  if(runningFurniture===true && flow) {
    const build=furniturePlanner || (await import('./paper-furniture.mjs')).buildFurniturePlan;
    plan=build({document:{...plannerDocument,assets:plannerDocument.assets || []},flow,editedBlockIds:edits.map(e=>e.blockId)});
    // A separator projected from a parent line belongs between fragments. A
    // separately positioned furniture fragment has its own source anchor.
    for(const id of plan.excludedBlockIds || []) projectedSpaces.get(id)?.delete(0);
  }
  const suppressedLabels=new Set((linkPlan?.targets||[]).filter(t=>t.label && ((t.blockId && plan?.excludedBlockIds?.includes(t.blockId)) || (t.assetItemId && plan?.excludedItemIds?.includes(t.assetItemId)))).map(t=>t.label));
  if(linkPlan) for(const label of suppressedLabels) linkPlan.diagnostics.push({code:'target-furniture-unresolved',label});
  if(linkPlan) for(const id of new Set(linkPlan.sourceAssets.map(a=>a.assetItemId))) { const candidates=linkPlan.sourceAssets.filter(a=>a.assetItemId===id); const destinations=new Set(candidates.map(a=>JSON.stringify([a.destinationLabel||null,a.destinationLabel?null:a.uri,a.destinationStatus||null]))); if(destinations.size>1) linkPlan.diagnostics.push({code:'source-asset-link-conflict',assetItemId:id,linkIds:[...new Set(candidates.flatMap(a=>a.linkIds))]}); }
  const margins=plan?.margins || {top:36,right:36,bottom:36,left:36};
  // Every paper string remains an argument to text(), never executable markup.
  let source=`#set page(width: ${page.width}pt, height: ${page.height}pt, margin: (top: ${margins.top}pt, right: ${margins.right}pt, bottom: ${margins.bottom}pt, left: ${margins.left}pt))\n`;
  const candidates = fonts.candidates?.filter(c=>c.getBytes?.()) || [];
  const families = [...new Set([fonts.selected?.family, ...candidates.map(c=>c.family)].filter(Boolean))];
  if (!families.length && fonts.family) families.push(String(fonts.family));
  if (families.length) source+=`#set text(font: (${families.map(typstString).join(', ')},), size: 10pt)\n`;
  const files = {};
  const assetList = Array.isArray(assets) ? assets : assets?.assets || document.assets || [];
  // Targets on unavailable assets must not produce dangling Typst labels.
  for(const target of linkPlan?.targets||[]) if(target.label && target.assetItemId && !suppressedLabels.has(target.label)) {
    const item=flow?.items.find(i=>i.id===target.assetItemId);
    const id=item?.renderAssetId || (item?.assetIds?.length===1 ? item.assetIds[0] : null);
    const asset=assetList.find(a=>a.id===id), content=asset?.content, bytes=content?.bytes, rep=String(content?.representation||'').toLowerCase();
    const svg=rep.includes('svg') && bytes instanceof Uint8Array && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes));
    const png=rep.includes('png') && bytes instanceof Uint8Array && bytes.length>=45 && [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((b,i)=>bytes[i]===b) && [73,69,78,68,174,66,96,130].every((b,i)=>bytes[bytes.length-8+i]===b);
    const same=(a,b)=>a.length===b.length && a.every(x=>b.includes(x));
    const captureValid=!item?.renderAssetId || (asset && same(asset.source?.assetIds||[],item.assetIds||[]) && same(asset.source?.blockIds||[],item.blockIds||[]) && asset.source?.pageIndex===item.source?.pageIndex && JSON.stringify(asset.source?.bbox)===JSON.stringify(item.source?.bbox));
    const original=(document.assets||[]).find(a=>a.id===id), originalValid=!original?.source || (asset?.source && asset.source.pageIndex===original.source.pageIndex && JSON.stringify(asset.source.bbox)===JSON.stringify(original.source.bbox));
    if(!id || !(svg||png) || content?.mask || asset?.mask || !captureValid || !originalValid) {suppressedLabels.add(target.label);linkPlan.diagnostics.push({code:'target-asset-unavailable',label:target.label,assetItemId:target.assetItemId});}
  }

  const blockById = new Map(document.blocks.map(b=>[b.id,b]));
  const styleById = new Map((document.styles || []).map(s=>[s.id,s]));
  const textById = new Map(document.blocks.filter(b=>typeof b.text==='string' && b.text.length && !assetOwned.has(b.id)).map(b=>[b.id,logicalText(b,changes.get(b.id)||[],new Set(),spacesFor(b))]));
  const furniture={enabled:runningFurniture===true, templates:[], retained:[]};
  const furnitureIds=new Set();
  furniture.plan=plan;
  const placedAssets = new Set(), assetFindings=[];
  if(assets?.sourceSha256 && assets.sourceSha256!==document.sourceSha256) fail('Asset source hash mismatch');
  const suppliedIds=new Set(); for(const a of assetList) {if(!a?.id || suppliedIds.has(a.id)) fail('Unknown or duplicate asset occurrence ID'); suppliedIds.add(a.id);}
  const ownedIds=new Set(); for(const item of flow?.items || []) for(const id of item.assetIds || []) {if(ownedIds.has(id)) fail('Duplicate flow asset ownership'); ownedIds.add(id);}
  for(const a of document.assets || []) if(flow && !ownedIds.has(a.id)) assetFindings.push({code:'asset-unowned',assetId:a.id});
  function spanMarker(id, sourcePage, edge) {
    return `#context [#let p = here().position();#metadata((id: ${typstString(id)}, page: p.page, x: p.x / 1pt, y: p.y / 1pt, sourcePage: ${Number.isInteger(sourcePage) ? sourcePage : 'none'}, edge: ${typstString(edge)}))#label(${typstString(`paper-${edge === 'start' ? 'block' : 'block-end'}`)})]`;
  }
  function renderBlock(block, mark=true) {
    const text=textById.get(block.id); if (!text) return '';
    const marker=mark ? spanMarker(block.id,block.source?.pageIndex,'start') : '';
    const endMarker=mark ? spanMarker(block.id,block.source?.pageIndex,'end') : '';

    const chars=block.source?.characters || [];
    if (!linkPlan && (!chars.length || !styleById.size) && !fonts.fallback?.length && !(glyphsByBlock.get(block.id)||[]).length && !text.includes('\t') && !(changes.get(block.id)||[]).some(e=>e.after.includes('\n'))) return marker+`#text(${typstString(text)})`+endMarker;
    // Build source-indexed styles, then apply the same line separators and edits.
    const raw=block.text, spaces=spacesFor(block);
    let logical='', styles=[], glyphMap=[], destinations=[], offsets=[], before=[], after=[];
    const destinationAt=offset=>{const active=(linkPlan?.sourceRuns||[]).filter(r=>r.blockId===block.id && r.start<=offset && offset<r.end); const keys=new Map(active.map(r=>[JSON.stringify([r.destinationLabel||null,r.destinationLabel?null:r.uri,r.destinationStatus||null]),r])); const r=keys.size===1 ? [...keys.values()][0] : null;return r && !r.destinationStatus && !suppressedLabels.has(r.destinationLabel) ? r : null;};
    const sourceGlyphs=new Map((glyphsByBlock.get(block.id)||[]).map(g=>[g.start-block.source.range.start,g]));
    const styleAt=i=>chars.find(c=>c.start<=i+block.source.range.start && c.end>i+block.source.range.start)?.styleId || block.styleId;
    for(let i=0;i<=raw.length;i++) {
      before[i]=logical.length;
      if(spaces.has(i)) {logical+=' ';styles.push(styleAt(Math.max(0,i-1)));glyphMap.push(null);destinations.push(null);offsets.push(null);}
      after[i]=logical.length;
      if(i<raw.length) {logical+=raw[i];styles.push(styleAt(i));glyphMap.push(sourceGlyphs.get(i)||null);destinations.push(destinationAt(block.source.range.start+i));offsets.push(block.source.range.start+i);}
    }
    let result='', mapped=[], mappedGlyphs=[], mappedDest=[], mappedOffsets=[], cursor=0;
    for(const edit of [...(changes.get(block.id)||[])].sort((a,b)=>a.start-b.start)) {
      const a=after[edit.start], b=before[edit.end]; result+=logical.slice(cursor,a)+edit.after;
      for(let i=cursor;i<a;i++) {mapped.push(styles[i]);mappedGlyphs.push(glyphMap[i]);mappedDest.push(destinations[i]);mappedOffsets.push(offsets[i]);}
      const editStyle=styleAt(edit.start);
      for(let i=0;i<edit.after.length;i++) {mapped.push(editStyle);mappedGlyphs.push(null);mappedDest.push(suppressedLabels.has(edit.inherit?.destinationLabel) ? null : edit.inherit);mappedOffsets.push(null);}
      cursor=b;
    }
    result+=logical.slice(cursor); for(let i=cursor;i<styles.length;i++) {mapped.push(styles[i]);mappedGlyphs.push(glyphMap[i]);mappedDest.push(destinations[i]);mappedOffsets.push(offsets[i]);}
    const familyAt=i=>fonts.fallback?.find(entry=>entry.codepoint===result.codePointAt(i) && entry.kind==='glyph')?.family || null;
    const labels=new Map();
    if(mark) for(const target of linkPlan?.targets||[]) if(target.label && !suppressedLabels.has(target.label) && target.blockId===block.id) {const at=mappedOffsets.indexOf(target.start); if(at>=0) {const list=labels.get(at)||[];list.push(target.label);labels.set(at,list);}}
    const key=d=>d?.destinationLabel ? `label:${d.destinationLabel}` : d?.uri ? `uri:${d.uri}` : '';
    const wrap=(content,d)=>d?.destinationLabel ? `#link(label(${typstString(d.destinationLabel)}))[${content}]` : d?.uri ? `#link(${typstString(d.uri)})[${content}]` : content;
    const emitLabels=i=>(labels.get(i)||[]).map(l=>`#box[]#label(${typstString(l)})`).join('');
    const runs=[]; for(let i=0;i<result.length;) {
      let j=i+(result.codePointAt(i)>0xffff?2:1); const family=familyAt(i), glyph=mappedGlyphs[i];
      const editLineBreak=result[i]==='\n' && mappedOffsets[i]===null, tab=result[i]==='\t';
      while(!glyph && !editLineBreak && !tab && j<result.length && result[j]!=='\t' && !(result[j]==='\n' && mappedOffsets[j]===null) && !labels.has(j) && !mappedGlyphs[j] && mapped[j]===mapped[i] && familyAt(j)===family && key(mappedDest[j])===key(mappedDest[i])) j+=result.codePointAt(j)>0xffff?2:1;
      let content;
      if(glyph) {const path=`source-glyphs/${glyph.pageIndex}-${glyph.start}.svg`;files[path]=new Uint8Array(glyph.bytes);content=`#box(width: ${glyph.advance}pt, height: ${glyph.height}pt, baseline: ${glyph.baselineShift}pt)[#move(dx: ${glyph.offsetX}pt)[#image(${typstString(path)}, width: ${glyph.width}pt)]]`;}
      else {const style=styleById.get(mapped[i]), size=style?.size; let opts=Number.isFinite(size)&&size>0 ? `size: ${size}pt, ` : ''; if(family) opts+=`font: ${typstString(family)}, `; const name=style?.fontName || ''; if(/bold/i.test(name)) opts+='weight: "bold", '; if(/italic|oblique/i.test(name)) opts+='style: "italic", '; content=editLineBreak ? `#text(${opts}${typstString(' ')})#linebreak()` : `#text(${opts}${typstString(tab?' ':result.slice(i,j))})`;}
      runs.push(emitLabels(i)+wrap(content,mappedDest[i])); i=j;
    }
    return marker+runs.join('')+endMarker;
  }
  function renderAsset(id, item, mark=true) {
    const asset=assetList.find(a=>a.id===id); const original=(document.assets||[]).find(a=>a.id===id);
    if(original?.source && (!asset?.source || asset.source.pageIndex!==original.source.pageIndex || JSON.stringify(asset.source.bbox)!==JSON.stringify(original.source.bbox))) {assetFindings.push({code:'asset-source-mismatch',assetId:id}); return '';}
    const content=asset?.content; const bytes=content?.bytes;
    const rep=String(content?.representation || '').toLowerCase();
    const ext=rep.includes('svg')?'svg':rep.includes('png')?'png':null;
    const validPng=ext==='png' && bytes instanceof Uint8Array && bytes.length>=45 && [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((b,i)=>bytes[i]===b) && [73,69,78,68,174,66,96,130].every((b,i)=>bytes[bytes.length-8+i]===b);
    const validSvg=ext==='svg' && bytes instanceof Uint8Array && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes));
    if(!validPng && !validSvg) {assetFindings.push({code:asset?'asset-invalid-format':'asset-missing',assetId:id}); return '';}
    if(content?.mask || asset?.mask) {assetFindings.push({code:'asset-mask-unsupported',assetId:id}); return '';}
    const path=`assets/${placedAssets.size}.${ext}`; files[path]=new Uint8Array(bytes); placedAssets.add(id);
    const bbox=asset.source?.bbox || item?.source?.bbox;
    const sourceWidth=Array.isArray(bbox) ? bbox[2]-bbox[0] : null;
    const sourceHeight=Array.isArray(bbox) ? bbox[3]-bbox[1] : null;
    const available=(page.width-margins.left-margins.right)/(item?.span==='page' || item?.columns!==2 ? 1 : 2);
    // Reserve a line for the caption when a source region is nearly page-high.
    // Scaling the width from the source rectangle preserves the capture's ratio.
    const maxHeight=Math.max(1,page.height-margins.top-margins.bottom-((item?.captionIds || []).length ? 20 : 0));
    const heightLimited=Number.isFinite(sourceHeight) && sourceHeight>0 && Number.isFinite(sourceWidth) && sourceWidth>0 ? maxHeight*sourceWidth/sourceHeight : Infinity;
    const width=Number.isFinite(sourceWidth) && sourceWidth>0 ? `${Math.min(sourceWidth,available,heightLimited)}pt` : '100%';
    const sourcePage=asset.source?.pageIndex ?? item?.source?.pageIndex;
    const marker=mark ? spanMarker(id,sourcePage,'start') : '', endMarker=mark ? spanMarker(id,sourcePage,'end') : '';
    const labels=mark ? (linkPlan?.targets||[]).filter(t=>t.label && !suppressedLabels.has(t.label) && t.assetItemId===item?.id).map(t=>`#box[]#label(${typstString(t.label)})`).join('') : '';
    const candidates=(linkPlan?.sourceAssets||[]).filter(a=>a.assetItemId===item?.id);
    const unique=new Map(candidates.map(a=>[JSON.stringify([a.destinationLabel||null,a.destinationLabel?null:a.uri,a.destinationStatus||null]),a])); const only=unique.size===1 ? [...unique.values()][0] : null; const dest=only && !only.destinationStatus && !suppressedLabels.has(only.destinationLabel) ? only : null;
    const image=`#image(${typstString(path)}, width: ${width})`;
    const linked=dest?.destinationLabel ? `#link(label(${typstString(dest.destinationLabel)}))[${image}]` : dest?.uri ? `#link(${typstString(dest.uri)})[${image}]` : image;
    return `#box[${marker}${labels}${linked}${endMarker}]`;
  }
  if(plan) {
    const excludedItems=new Set(plan.excludedItemIds), excludedBlocks=new Set(plan.excludedBlockIds);
    const rendered=new Map();
    for(const pg of plan.pages) for(const kind of ['header','footer']) for(const entry of pg[kind]) {
      let content='';
      if(entry.kind==='asset') {
        const item=flow.items.find(i=>i.id===entry.itemId);
        const id=entry.renderAssetId || (entry.assetIds?.length===1 ? entry.assetIds[0] : null);
        if(id && item) {
          const capture=assetList.find(a=>a.id===id);
          const same=(a,b)=>a.length===b.length && a.every(x=>b.includes(x));
          const validCapture=!item.renderAssetId || (capture && same(capture.source?.assetIds || [],item.assetIds || []) && same(capture.source?.blockIds || [],item.blockIds || []) && capture.source?.pageIndex===item.source?.pageIndex && JSON.stringify(capture.source?.bbox)===JSON.stringify(item.source?.bbox));
          if(validCapture) content=renderAsset(id,{...item,span:'page',columns:1},false);
          else assetFindings.push({code:'asset-capture-mismatch',assetId:id});
        }
        if(!content) {excludedItems.delete(entry.itemId); for(const id of entry.blockIds || []) excludedBlocks.delete(id); continue;}
        for(const id of entry.assetIds || []) placedAssets.add(id);
      } else {
        const block=blockById.get(entry.blockId);
        if(!block) {excludedItems.delete(entry.itemId); excludedBlocks.delete(entry.blockId); continue;}
        if(entry.kind==='counter') {
          const style=styleById.get(block.source?.characters?.[0]?.styleId || block.styleId), size=style?.size, name=style?.fontName || '';
          let opts=Number.isFinite(size)&&size>0 ? `size: ${size}pt, ` : '';
          if(/bold/i.test(name)) opts+='weight: "bold", '; if(/italic|oblique/i.test(name)) opts+='style: "italic", ';
          content=`#text(${opts}counter(page).display("1 / 1", both: true))`;
        } else content=renderBlock(block,false);
      }
      rendered.set(entry,content);
      furniture.templates.push({kind,sourcePage:pg.sourcePage,text:entry.kind==='text'?textById.get(entry.blockId):entry.text,originalText:entry.text,bbox:entry.bbox,occurrences:[{itemId:entry.itemId,blockId:entry.blockId,source:entry.source}],entryKind:entry.kind});
    }
    for(const id of excludedBlocks) furnitureIds.add(id);
    expectedBlocks=expectedBlocks.filter(b=>!furnitureIds.has(b.id));
    source+=`#let paper-source-page() = { let p = here().page(); let starts = query(<paper-block>).filter(m => m.value.sourcePage != none); let ends = query(<paper-block-end>); let covering = starts.filter(s => { let e = ends.find(x => x.value.id == s.value.id); e != none and s.value.page <= p and e.value.page >= p }); if covering.len() > 0 { covering.first().value.sourcePage } else { none } }\n`;
    for(const kind of ['header','footer']) {
      const cases=plan.pages.filter(pg=>pg[kind].some(e=>rendered.has(e))).map(pg=>{
        const parts=pg[kind].filter(e=>rendered.has(e)).map(entry=>{
          const [x,y]=entry.bbox, dy=kind==='header' ? y : y-(page.height-margins.bottom);
          const id=entry.blockId || entry.itemId;
          return `#place(top + left, dx: ${x-margins.left}pt, dy: ${dy}pt)[#context [#let p = here().position();#metadata((id: ${typstString(id)}, sourcePage: ${pg.sourcePage}, page: p.page, x: p.x / 1pt, y: p.y / 1pt, kind: ${typstString(kind)}))#label("paper-furniture")]${rendered.get(entry)}]`;
        });
        return `if sp == ${pg.sourcePage} [${parts.join('')}]`;
      });
      if(cases.length) source+=`#set page(${kind}-ascent: 0pt, ${kind}: context { let sp = paper-source-page(); box(height: ${kind==='header' ? margins.top : margins.bottom}pt)[#${cases.join(' else ')}] })\n`.replace('footer-ascent','footer-descent');
    }
    plan.excludedItemIds=[...excludedItems];
  }
  if (flow) {
    if(flow.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items)) fail('Invalid paper flow');
    let group=[], groupItems=[], columns=0;
    const flush=next=>{if(!group.length)return; source+=columns===2 ? `#columns(2)[\n${group.join('\n\n')}\n]\n` : group.join('\n\n')+'\n';if(columns===2 && next?.kind==='asset' && next.span==='page') balanceGroups.push(groupItems);group=[];groupItems=[];};
    const captionById=new Map(flow.items.filter(i=>i.kind==='caption').flatMap(i=>(i.blockIds||[]).map(id=>[id,i]))), linkedCaptions=new Set();
    for(const item of flow.items) if(item.kind==='asset') for(const id of item.captionIds||[]) {if(!captionById.has(id) || linkedCaptions.has(id)) fail('Unknown or duplicate caption link'); linkedCaptions.add(id);}
    for(const item of flow.items) {
      if(plan?.excludedItemIds.includes(item.id)) continue;
      const count=item.span==='page'?1:(item.columns===2?2:1); if(count!==columns){flush(item);columns=count;}
      let parts=[];
      if(item.kind==='asset') {
        if(item.renderAssetId) {
          const capture=assetList.find(a=>a.id===item.renderAssetId), owned=capture?.source?.assetIds || [], blocks=capture?.source?.blockIds || [];
          const same=(a,b)=>a.length===b.length && a.every(x=>b.includes(x));
          if(!capture || !same(owned,item.assetIds||[]) || !same(blocks,item.blockIds||[]) || capture.source.pageIndex!==item.source?.pageIndex || JSON.stringify(capture.source.bbox)!==JSON.stringify(item.source?.bbox)) assetFindings.push({code:'asset-capture-mismatch',assetId:item.renderAssetId});
          else {parts=[renderAsset(item.renderAssetId,item)].filter(Boolean); if(parts.length) for(const id of item.assetIds||[]) placedAssets.add(id);}
        } else if((item.assetIds||[]).length>1) assetFindings.push({code:'asset-union-required',assetIds:[...item.assetIds]});
        else parts=(item.assetIds||[]).map(id=>renderAsset(id,item)).filter(Boolean);
        const above=captionOrder(item).filter(id=>item.captionPositions?.[id]==='above').map(id=>renderBlock(blockById.get(id))).filter(Boolean);
        const below=captionOrder(item).filter(id=>item.captionPositions?.[id]!=='above').map(id=>renderBlock(blockById.get(id))).filter(Boolean);
        if(parts.length && below.length) parts=[`#block(sticky: true)[${parts.join('\n')}]`];
        parts=[...above.map(caption=>`#block(sticky: true)[${caption}]`),...parts,...below];
      } else {
        parts=(item.blockIds||[]).filter(id=>!linkedCaptions.has(id)).map(id=>blockById.get(id)).filter(Boolean).map(b=>renderBlock(b));
        if(!item.inline) parts=parts.filter(Boolean);
      }
      if(parts.length) {const rendered=item.inline ? parts.map((p,i)=>p+(i<parts.length-1 ? `#text(${typstString(item.joiners[i])})` : '')).join('') : parts.join(item.kind==='asset'?'\n\n':'\n'); group.push(item.kind==='heading' ? `#block(sticky: true)[${rendered}]` : rendered);groupItems.push({kind:item.kind,inline:!!item.inline,ids:[...(item.blockIds||[])]});}
    }
    flush();
  } else {
    source+=`#columns(2)[\n${document.blocks.map(b=>renderBlock(b)).filter(Boolean).join('\n\n')}\n]`;
  }
  let compiled=await compile({source, fonts, files, signal}); abort(signal);
  // A full-width figure ends a column group. Balance a left-only final page
  // at an existing paragraph boundary, using the measured output.
  if(Array.isArray(compiled?.blockSpans) && balanceGroups.length) {
    const spans=new Map(compiled.blockSpans.map(s=>[s.id,s])); let revised=source;
    for(const items of balanceGroups) {
      const all=items.flatMap(item=>item.ids.map(id=>spans.get(id)));
      if(!all.length || all.some(s=>!s?.start || !s.end || !Number.isInteger(s.end.page))) continue;
      const last=Math.max(...all.map(s=>s.end.page));
      const onPage=all.filter(s=>s.start.page<=last && s.end.page>=last);
      const splitX=margins.left+(page.width-margins.left-margins.right)/2;
      if(onPage.some(s=>(s.start.page===last && s.start.x>=splitX) || (s.end.page===last && s.end.x>=splitX))) continue;
      const bottom=Math.max(...onPage.filter(s=>s.end.page===last).map(s=>s.end.y));
      if(!Number.isFinite(bottom) || bottom>page.height-margins.bottom) continue;
      const target=(margins.top+bottom)/2;
      const eligible=items.filter(item=>!item.inline && ['paragraph','caption'].includes(item.kind) && item.ids.length===1).map(item=>spans.get(item.ids[0])).filter(s=>s?.start?.page===last && s.start.y>margins.top+25 && s.start.y<bottom-25).sort((a,b)=>Math.abs(a.start.y-target)-Math.abs(b.start.y-target));
      const chosen=eligible[0]; if(!chosen) continue;
      const marker=spanMarker(chosen.id,chosen.sourcePage,'start');
      if(revised.includes(marker)) revised=revised.replace(marker,`#colbreak()${marker}`);
    }
    if(revised!==source) {source=revised;compiled=await compile({source,fonts,files,signal});abort(signal);}
  }
  const returnedBytes=compiled instanceof Uint8Array ? compiled : compiled?.bytes;
  const bytes=returnedBytes instanceof Uint8Array ? new Uint8Array(returnedBytes) : returnedBytes;
  if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') fail('Compiler did not return PDF bytes');
  const sha256=await hash(bytes); abort(signal);
  const warnings=['Content, layout and asset preservation have not been independently verified.'];
  if(sourceGlyphResult.glyphs.length) warnings.push('Source glyph artwork has unknown Unicode and is excluded from searchable-text expectations.');
  if(sourceGlyphResult.unavailable.length) warnings.push('Source glyph artwork unavailable for '+sourceGlyphResult.unavailable.length+' character(s).');
  if(compiled?.queryError) warnings.push(`Output location query failed: ${compiled.queryError}`);
  if(document.assets?.some(a=>!placedAssets.has(a.id)) || document.blocks.some(b=>(b.assetIds?.length || b.kind==='figure' || b.kind==='table' || b.kind==='formula') && !(b.assetIds?.length && b.assetIds.every(id=>placedAssets.has(id))))) warnings.push('Source assets and non-text figure, table or formula content are not placed by this candidate, including image blocks without source ranges.');
  if(assetFindings.length) warnings.push('Source asset findings: '+assetFindings.map(f=>`${f.code} (${f.assetId || f.assetIds.join(', ')})`).join('; '));
  if(coverage.status!=='covered') warnings.push(`Font coverage ${coverage.status}; output may lose glyphs.`);
  let outputTextCheck='unavailable', checkReport=null;
  if (typeof outputCheck==='function') {
    try { checkReport=await outputCheck({bytes:new Uint8Array(bytes), expectedBlocks:expectedBlocks.map(b=>({...b})), expectedFurniture:structuredClone(furniture.templates), outputFurniture:structuredClone(compiled?.furnitureMap ?? null),blockSpans:structuredClone(compiled?.blockSpans ?? null),bodyFrame:{left:margins.left,top:margins.top,right:page.width-margins.right,bottom:page.height-margins.bottom}}); abort(signal);
      outputTextCheck=checkReport?.findings?.some(f=>f.code==='content-mismatch') ? 'finding' : checkReport?.checks?.content?.status || 'unavailable';
    } catch (error) { abort(signal); warnings.push(`Output text check unavailable: ${error.message}`); }
  }
  if (ambiguous.length) {
    warnings.push('Ambiguous source line boundaries use a spacing convention; content verification is unavailable.');
  }
  if (outputTextCheck==='finding') warnings.push('Output text check found content loss or mismatch.');
  const verification={status:outputTextCheck==='finding' || assetFindings.length?'finding':'warning', sourceSha256:document.sourceSha256, contentVerified:outputTextCheck==='pass' && !furniture.templates.length && !ambiguous.length && !assetOwned.size && !assetFindings.length && !sourceGlyphResult.glyphs.length && !sourceGlyphResult.unavailable.length, sourceGlyphs:sourceGlyphResult, layoutVerified:false, coverage, outputTextCheck, checkReport, artworkBlocks, assetFindings, ambiguousBoundaries:ambiguous, furniture:{...furniture,margins:{...margins},output:compiled?.furnitureMap ?? null}, edits:edits.map(e=>({blockId:e.blockId,start:e.start,end:e.end,status:'bound'}))};
  return {linkPlan,file:new File([bytes],'recomposed.pdf',{type:'application/pdf'}),sha256,verification,pageMap:null,blockMap:compiled?.blockMap ?? null,blockSpans:compiled?.blockSpans ?? null,furnitureMap:compiled?.furnitureMap ?? null,warnings};
}

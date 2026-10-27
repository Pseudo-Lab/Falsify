import {deriveLayoutProfile} from './paper-style-profile.mjs';
import {parseFont} from './browser-fonts.mjs';

const norm = s => String(s ?? '').replace(/\s+/gu,' ').trim();
const valid = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[2]>b[0] && b[3]>b[1];
const area = b => (b[2]-b[0])*(b[3]-b[1]);
const overlap = (a,b) => Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));

/** Build nominations for inspectLayoutQuality. All coordinates returned are observed in output bytes.
 * assetSpans: [{id,pageIndex,bbox}] in output display coordinates; these are nominations, not proof.
 * expectedBlocks must contain the final edited text. selectedFamilyAliases must come from the selected font, never output observations.
 */
export function buildOutputProfile({bytes,mupdf,document={},flow={},expectedBlocks=[],fontPlan,selectedFamilyAliases,assetSpans=[]}={}) {
  const evidence={body:[],captions:[],headings:[],font:{status:'unavailable'},columns:{status:'unavailable',reason:'Output column bounds are not independently established.'}};
  const profile={coordinateSpace:'output',bodyLines:[],captions:[],columns:[],headings:[]};
  const source=deriveLayoutProfile(document,flow); if(source.bodyFontSize>0) profile.bodyFontSize=source.bodyFontSize;
  const aliases=Array.isArray(selectedFamilyAliases) ? selectedFamilyAliases.filter(x=>typeof x==='string' && x.trim()) : [];
  // A resolved plan's selected family is derived from font bytes by createFontPlan.
  if(!aliases.length && fontPlan) {
    const used=new Set((fontPlan.fallback||[]).filter(x=>x.kind==='glyph' && x.family).map(x=>x.family));
    if(fontPlan.selected?.family) used.add(fontPlan.selected.family);
    for(const candidate of [fontPlan.selected,...(fontPlan.candidates||[])].filter(Boolean)) {
      if(!candidate.getBytes || (candidate!==fontPlan.selected && !used.has(candidate.family))) continue;
      try {const meta=parseFont(candidate.getBytes());if(candidate!==fontPlan.selected && !used.has(meta.family))continue;aliases.push(meta.family);if(meta.postscriptName)aliases.push(meta.postscriptName);}catch{}
    }
  }
  if(aliases.length) {profile.outputBodyFontNames=[...new Set(aliases)];evidence.font={status:'available',aliases:profile.outputBodyFontNames,source:selectedFamilyAliases?.length?'explicit-selected-aliases':'selected-font-plan-family',limitation:'Font family may differ from the name exposed by PDF extraction; supply verified aliases.'};}
  else evidence.font.reason='No independently resolved selected family aliases.';
  let doc; const pages=[];
  try {
    if(!mupdf?.Document) throw Error('MuPDF unavailable');
    doc=mupdf.Document.openDocument(bytes,'application/pdf'); if(doc.countPages()>500) throw Error('page limit exceeded');
    for(let i=0;i<doc.countPages();i++) {const page=doc.loadPage(i); let st; try {
      const lines=[],images=[]; st=page.toStructuredText('preserve-whitespace,preserve-images'); let line;
      st.walk({beginLine(_box,wmode,direction){line={text:'',horizontal:wmode===0 && direction[0]>0 && Math.abs(direction[1])<0.01};},onChar(c){if(line)line.text+=c;},endLine(){if(line?.horizontal && norm(line.text))lines.push(norm(line.text));line=null;},onImageBlock(b,_t,image){try {if(valid(b))images.push([...b]);} finally {image.destroy();}}});
      if(lines.length>10000 || images.length>2000) throw Error('geometry limit exceeded'); pages.push({lines,images});
    } finally {st?.destroy();page.destroy();}}
  } catch(error) {evidence.error=String(error?.message || error); return {profile,evidence};} finally {doc?.destroy();}
  const expected=new Map(), duplicate=new Set(); for(const b of expectedBlocks) {if(expected.has(b.id)) duplicate.add(b.id);else expected.set(b.id,norm(b.text));}
  const occurrence = target => {const found=[]; if(!target)return found; for(let p=0;p<pages.length;p++) {const lines=pages[p].lines; for(let i=0;i<lines.length;i++) {let text=''; for(let j=i;j<lines.length;j++) {text=norm(text+' '+lines[j]); if(text===target){found.push({pageIndex:p,start:i,end:j});break;} if(!target.startsWith(text) || text.length>=target.length) break;}}} return found;};
  const uniqueExpected = target => !!target && [...expected.values()].filter(x=>x===target).length===1;
  const kinds = kind => (flow.items || []).filter(x=>x.kind===kind).flatMap(x=>x.blockIds || []);
  const allLines=pages.flatMap(p=>p.lines), sourceBlocks=new Map((document.blocks||[]).map(b=>[b.id,b])), sourceIds=new Set(sourceBlocks.keys()),styles=new Map((document.styles||[]).map(s=>[s.id,s]));
  const sourceSize=id=>{const b=sourceBlocks.get(id),sizes=[];for(const c of b?.source?.characters||[]){const size=styles.get(c.styleId)?.size;if(Number.isFinite(size)&&size>0)for(let n=0;n<Math.min(256,Math.max(1,c.end-c.start));n++)sizes.push(size);}if(!sizes.length){const size=styles.get(b?.styleId)?.size;if(Number.isFinite(size)&&size>0)sizes.push(size);}sizes.sort((a,b)=>a-b);return sizes[Math.floor(sizes.length/2)];};
  for(const id of kinds('paragraph')) {const target=expected.get(id); if(!sourceIds.has(id) || duplicate.has(id) || !uniqueExpected(target)) {evidence.body.push({id,status:'unavailable',reason:'Missing or ambiguous source/expected block.'});continue;}
    const matches=occurrence(target); if(matches.length!==1) {evidence.body.push({id,status:'unavailable',reason:matches.length?'Ambiguous output block.':'Output block not observed.'});continue;}
    const m=matches[0], lines=pages[m.pageIndex].lines.slice(m.start,m.end+1); let count=0;
    for(const text of lines) if(allLines.filter(x=>x===text).length===1) {profile.bodyLines.push({text,sourceFontSize:sourceSize(id)});count++;}
    evidence.body.push({id,status:count?'observed':'unavailable',pageIndex:m.pageIndex,matchedLines:lines.length,nominatedLines:count,reason:count<lines.length?'Repeated output lines skipped.':undefined});
  }
  for(const id of kinds('heading')) {const target=expected.get(id), matches=occurrence(target); if(sourceIds.has(id) && !duplicate.has(id) && uniqueExpected(target) && matches.length===1 && matches[0].start===matches[0].end && allLines.filter(x=>x===target).length===1) {profile.headings.push({text:target});evidence.headings.push({id,status:'observed'});} else evidence.headings.push({id,status:'unavailable'});}
  for(const item of (flow.items || []).filter(x=>x.kind==='asset')) for(const id of item.captionIds || []) {
    const target=expected.get(id), matches=occurrence(target), ids=[item.renderAssetId,...(item.assetIds || [])].filter(Boolean), spans=assetSpans.filter(s=>ids.includes(s.id) && Number.isInteger(s.pageIndex) && valid(s.bbox));
    const candidates=[]; for(const [pageIndex,page] of pages.entries()) for(const b of page.images) if(spans.some(s=>s.pageIndex===pageIndex && overlap(b,s.bbox)/area(b)>0.9 && overlap(b,s.bbox)/area(s.bbox)>0.9)) candidates.push({pageIndex,bbox:b});
    const reason=!sourceIds.has(id) || duplicate.has(id) || !uniqueExpected(target)?'Missing or ambiguous source/expected caption.':matches.length!==1?'Caption output missing or ambiguous.':matches[0].end-matches[0].start+1>20?'Caption exceeds checker 20-line limit.':candidates.length!==1?'Image placement unavailable or ambiguous (vector assets are unsupported).':null;
    if(reason) evidence.captions.push({id,status:'unavailable',reason}); else {profile.captions.push({id,text:target,assetPageIndex:candidates[0].pageIndex,assetBbox:candidates[0].bbox});evidence.captions.push({id,status:'observed',pageIndex:matches[0].pageIndex,lineCount:matches[0].end-matches[0].start+1});}
  }
  return {profile,evidence};
}

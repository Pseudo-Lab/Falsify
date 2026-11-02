import {readDocument} from './paper-document.mjs';
import {readSourceAssets} from './paper-source-assets.mjs';
import {readSourceLinks} from './paper-source-links.mjs';
import {buildPaperFlow} from './paper-flow.mjs';
import {detectSourceTables, selectTableCell, readMuPdfTablePages} from './table-adapter.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {findPublicationTables} from './paper-publication-tables.mjs';

const MAX_BYTES=25*1024*1024, MAX_REGIONS=256, MAX_PIXELS=16_000_000;
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const abort=s=>{if(s?.aborted){const e=new Error('Reconstruction cancelled');e.name='AbortError';e.code='aborted';throw e;}};
const valid=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];
const same=(a,b,t=.01)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>Number.isFinite(v)&&Number.isFinite(b[i])&&Math.abs(v-b[i])<=t);
const overlap=(a,b)=>a[0]<b[2]&&b[0]<a[2]&&a[1]<b[3]&&b[1]<a[3];
const within=(a,b,t=.2)=>a[0]>=b[0]-t&&a[1]>=b[1]-t&&a[2]<=b[2]+t&&a[3]<=b[3]+t;
const pngSignature=[137,80,78,71,13,10,26,10];
function extractPng(asset){
  if(asset?.content?.representation!=='mupdf-cropped-svg'||asset.content.encoding!=='raster-png') fail('crop-format');
  const svg=new TextDecoder('utf-8',{fatal:true}).decode(asset.content.bytes);
  const m=svg.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox="0 0 [\d.]+ [\d.]+"><image width="[\d.]+" height="[\d.]+" href="data:image\/png;base64,([A-Za-z0-9+/]+={0,2})"\/><\/svg>$/);
  if(!m) fail('crop-format');
  const binary=atob(m[1]), bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(bytes.length<24||!pngSignature.every((v,i)=>bytes[i]===v))fail('crop-format');
  return bytes;
}
function pageProof(bytes,model,mupdf){
  if(!mupdf?.Document)fail('reader-unavailable');
  const doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF();
  if(!doc||doc.needsPassword())fail('unsupported-document');
  try {
    if(doc.countPages()>200)fail('page-limit');
    if(doc.countPages()!==model.pages.length)fail('page-mismatch');
    for(let i=0;i<doc.countPages();i++){
      const page=doc.loadPage(i);
      try {
        const p=model.pages[i],obj=page.getObject(),bounds=[...page.getBounds()],transform=[...page.getTransform()];
        const media=obj.getInheritable('MediaBox'), crop=obj.getInheritable('CropBox');
        const arr=x=>x?.isArray()&&x.length===4?[0,1,2,3].map(n=>x.get(n).asNumber()):null;
        const mb=arr(media), cb=arr(crop)||mb, rotation=obj.getInheritable('Rotate').asNumber()||0;
        if(!p||p.pageIndex!==i||p.frame!=='mupdf-display'||!same(p.transform,transform)||!same(bounds,[0,0,p.width,p.height])||rotation%360!==0||!same(mb,[0,0,p.width,p.height])||!same(cb,mb))fail('unsupported-page-frame');
      } finally {page.destroy();}
    }
  } finally {doc.destroy();}
}
function ref(hash,pageIndex,bbox,extra={}){return {sourceSha256:hash,pageIndex,frame:'mupdf-display',bbox:[...bbox],...extra};}
function safeTable(table, inventory, document, region, hash, revision, rulePages){
  if(!table?.ruled||!table.rows||!table.cols||table.rows*table.cols!==table.cells.length||table.rows*table.cols>400) return null;
  const pg=rulePages[table.pageIndex];
  const rows=Array.from({length:table.rows},()=>Array(table.cols));
  for(const cell of table.cells){
    if(cell.rowSpan!==1||cell.colSpan!==1||rows[cell.row]?.[cell.col])return null;
    const s=selectTableCell(inventory,{tableId:table.id,cellId:cell.id,sourceSha256:hash,revision});
    if(s.status!=='ready')return null;
    const candidates=document.blocks.filter(b=>b.source?.pageIndex===table.pageIndex&&b.text===s.before&&same(b.source.bbox,s.anchor.bbox,.3)&&region.blockIds.includes(b.id));
    if(candidates.length!==1)return null;
    const b=candidates[0];rows[cell.row][cell.col]={text:s.before,evidence:[ref(hash,table.pageIndex,b.source.bbox,{blockId:b.parentBlockId||b.id,range:{...b.source.range}})]};
  }
  if(rows.some(row=>row.some(x=>!x)))return null;
  const used=rows.flat().map(c=>{const e=c.evidence[0];return document.blocks.find(b=>b.source.pageIndex===e.pageIndex&&b.source.range.start===e.range.start&&b.source.range.end===e.range.end)?.id;});
  if(new Set(used).size!==used.length||region.blockIds.some(id=>!used.includes(id)))return null;
  // Detector's ruled classification alone is not proof: require all four sides
  // of every cell to be covered by an observed straight rule.
  for(const c of table.cells){const [x0,y0,x1,y1]=c.bbox,eps=1.5;
    const horizontal=y=>pg.rules.some(r=>Math.abs((r.bbox[1]+r.bbox[3])/2-y)<=eps&&r.bbox[0]<=x0+eps&&r.bbox[2]>=x1-eps);
    const vertical=x=>pg.rules.some(r=>Math.abs((r.bbox[0]+r.bbox[2])/2-x)<=eps&&r.bbox[1]<=y0+eps&&r.bbox[3]>=y1-eps);
    if(!horizontal(y0)||!horizontal(y1)||!vertical(x0)||!vertical(x1))return null;
  }
  return {rows};
}

/** Re-read and bind bounded figure/table crops to the immutable original PDF. */
export async function enrichReconstructionRegions({model,bytes,mupdf,revision,signal}={}){
  abort(signal);
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_BYTES)fail('invalid-source');
  const snapshot=bytes.slice(),hash=hex(snapshot);
  if(!model||model.schema!=='falsify.pdf-latex-reconstruction.v1'||model.sourceSha256!==hash)fail('stale-source');
  if(!Array.isArray(model.pages)||!Array.isArray(model.items)||!Array.isArray(model.assets)||!Array.isArray(model.diagnostics))fail('invalid-model');
  if(typeof revision!=='string'||!revision||revision.length>200)fail('invalid-revision');
  if(model.items.some(i=>!i?.id)||new Set(model.items.map(i=>i.id)).size!==model.items.length||model.assets.some(a=>!a?.id)||new Set(model.assets.map(a=>a.id)).size!==model.assets.length)fail('duplicate-identity');
  pageProof(snapshot,model,mupdf);abort(signal);
  const document=await readDocument({file:snapshot,fileHash:hash,signal});
  const source=await readSourceAssets({bytes:snapshot,document,signal});
  const links=await readSourceLinks({bytes:snapshot,document,signal});
  const flow=buildPaperFlow(document,{drawings:source.drawings,links});
  const output=structuredClone(model),diag=(code,item)=>output.diagnostics.push({code,severity:'warning',itemId:item.id,pageIndex:item.evidence?.[0]?.pageIndex});
  const allBlocks=new Map([...document.blocks,...flow.fragments].map(b=>[b.id,b]));
  let tables=null, rulePages=[];
  try {tables=await detectSourceTables({sourceBytes:snapshot,sourceSha256:hash,revision,mupdf});rulePages=readMuPdfTablePages(snapshot,mupdf);}catch(e){if(e?.name==="AbortError")throw e;abort(signal);output.diagnostics.push({code:"table-inventory-unavailable",severity:"warning"});}
  const planned=[],ids=new Set();
  for(const item of output.items){
    abort(signal);
    if(!['figure','table','unknown'].includes(item.kind)||item.kind==='unknown'&&!item.extensions?.regionId)continue;
    const f=flow.items.find(x=>x.id===item.extensions?.flowId);
    if(!f||!sameIds(f.blockIds,item.extensions?.blockIds)||!sameIds(f.assetIds,item.extensions?.assetIds)){item.status='unsupported';diag('region-source-mismatch',item);continue;}
    let region=f.renderAssetId?flow.regions.find(x=>x.id===f.renderAssetId):null;
    if(!region && f.assetIds?.length===1){const a=document.assets.find(x=>x.id===f.assetIds[0]);if(a&&valid(a.source.bbox))region={id:`crop-${a.id}`,pageIndex:a.source.pageIndex,bbox:a.source.bbox,blockIds:f.blockIds,assetIds:f.assetIds};}
    if(!region||!valid(region.bbox)||ids.has(region.id)||region.pageIndex!==f.source.pageIndex||!same(region.bbox,f.source.bbox,1)){item.status='unsupported';diag('region-unavailable',item);continue;}
    const page=output.pages[region.pageIndex];
    if(!page||!within(region.bbox,[0,0,page.width,page.height],0)||9*(region.bbox[2]-region.bbox[0])*(region.bbox[3]-region.bbox[1])>MAX_PIXELS||planned.length>=MAX_REGIONS){item.status='unsupported';diag('region-budget-or-bounds',item);continue;}
    // Every intersecting source text/image occurrence must be owned by this flow item.
    const colliding=flow.items.filter(other=>other.id!==f.id&&other.source?.pageIndex===region.pageIndex&&valid(other.source.bbox)&&overlap(other.source.bbox,region.bbox));
    const missing=f.blockIds.some(id=>!allBlocks.has(id)) || region.blockIds.some(id=>!f.blockIds.includes(id));
    if(colliding.length||missing||planned.some(x=>x.region.pageIndex===region.pageIndex&&overlap(x.region.bbox,region.bbox))){item.status='unsupported';diag('region-ownership-ambiguous',item);continue;}
    ids.add(region.id);planned.push({item,region,f});
  }
  if(planned.length){
    abort(signal);const crops=await readSourceAssets({bytes:snapshot,document,regions:planned.map(({region:r})=>({...r,blockIds:r.blockIds||[],assetIds:r.assetIds||[]})),signal});
    for(const {item,region} of planned){
      abort(signal);const crop=crops.assets.find(a=>a.id===region.id);const png=extractPng(crop),assetId=`latex-${region.id}`;
      if(output.assets.some(a=>a.id===assetId))fail('duplicate-asset');
      const evidence=[ref(hash,region.pageIndex,region.bbox)];
      output.assets.push({id:assetId,evidence,representation:'region-raster',bytes:png,mediaType:'image/png',sha256:hex(png),editable:false,reason:'source-region-render'});
      item.assetId=assetId;item.status=item.kind==='unknown'?'unsupported':'observed';item.reason='noneditable-region';
      if(item.kind==='unknown' && tables?.tables.some(t=>t.pageIndex===region.pageIndex&&within(t.bbox,region.bbox,2)&&within(region.bbox,t.bbox,2)))item.kind='table';
      if(item.kind==='table'){
        const candidates=tables?.tables.filter(t=>t.pageIndex===region.pageIndex&&within(t.bbox,region.bbox,2)&&within(region.bbox,t.bbox,2))||[];
        const table=candidates.length===1?safeTable(candidates[0],tables,{blocks:[...allBlocks.values()]},region,hash,revision,rulePages):null;
        if(table){item.table=table;item.status='observed';}else {delete item.table;diag('table-structure-unproved',item);}
      }
    }
  }
  // A ruled table may appear as separate flow paragraphs. Only consolidate
  // them into a crop with diagnostics; editable cells require full proof.
  for(const t of tables?.tables||[]){
    abort(signal);if(!t.ruled||planned.some(x=>x.region.pageIndex===t.pageIndex&&overlap(x.region.bbox,t.bbox)))continue;
    const owners=flow.items.filter(f=>f.source?.pageIndex===t.pageIndex&&valid(f.source.bbox)&&overlap(f.source.bbox,t.bbox));
    if(!owners.length||owners.some(f=>f.kind!=='paragraph'||!within(f.source.bbox,t.bbox)||f.assetIds?.length))continue;
    const members=owners.map(f=>output.items.find(i=>i.extensions?.flowId===f.id));
    if(members.some((m,i)=>!m||m.kind!=='paragraph'||!sameIds(m.extensions?.blockIds,owners[i].blockIds)))continue;
    const region={id:`table-region-${t.id}`,pageIndex:t.pageIndex,bbox:[...t.bbox],blockIds:owners.flatMap(f=>f.blockIds),assetIds:[]};
    const table=safeTable(t,tables,{blocks:[...allBlocks.values()]},region,hash,revision,rulePages);
    if(9*(t.bbox[2]-t.bbox[0])*(t.bbox[3]-t.bbox[1])>MAX_PIXELS)continue;
    const cropInventory=await readSourceAssets({bytes:snapshot,document,regions:[region],signal});
    const png=extractPng(cropInventory.assets.find(a=>a.id===region.id)),assetId=`latex-${region.id}`;
    if(output.assets.some(a=>a.id===assetId))fail('duplicate-asset');
    const evidence=[ref(hash,t.pageIndex,t.bbox),...members.flatMap(m=>m.evidence||[])];
    output.assets.push({id:assetId,evidence:[evidence[0]],representation:'region-raster',bytes:png,mediaType:'image/png',sha256:hex(png),editable:false,reason:'source-region-render'});
    const first=Math.min(...members.map(m=>output.items.indexOf(m))),memberIds=new Set(members.map(m=>m.id));
    const item={id:`latex-table-${t.id}`,kind:'table',status:'observed',evidence,assetId,table,order:members[0].order,extensions:{blockIds:region.blockIds,assetIds:[],regionId:region.id}};
    if(!table){delete item.table;item.reason='table-structure-unproved';diag('table-structure-unproved',item);}
    output.items.splice(first,0,item);output.items=output.items.filter(i=>!memberIds.has(i.id));
  }
  // Preserve horizontally ruled academic tables as complete source regions.
  // Cell observations accompany the crop; no PDF-writer authority is granted.
  for(const candidate of findPublicationTables(rulePages,source.drawings)){
    abort(signal);const pi=candidate.pageIndex,box=candidate.bbox;
    if(output.items.some(i=>i.assetId&&i.evidence.some(e=>e.pageIndex===pi&&overlap(e.bbox,box))))continue;
    const members=output.items.filter(i=>!i.assetId&&i.evidence.some(e=>e.pageIndex===pi&&overlap(e.bbox,box)));
    const caption=output.items.find(i=>i.kind==='caption'&&i.evidence.some(e=>e.pageIndex===pi&&overlap(e.bbox,candidate.caption.bbox)));if(caption&&!members.includes(caption))members.push(caption);
    if(!members.length)continue;
    const boxes=members.flatMap(i=>i.evidence.filter(e=>e.pageIndex===pi).map(e=>e.bbox));
    const cropBox=[Math.min(box[0],...boxes.map(b=>b[0])),Math.min(box[1],...boxes.map(b=>b[1])),Math.max(box[2],...boxes.map(b=>b[2])),Math.max(box[3],...boxes.map(b=>b[3]))];
    if(cropBox[0]<box[0]-12||cropBox[2]>box[2]+12||cropBox[3]>box[3]+4||cropBox[1]<candidate.caption.bbox[1]-2||output.items.some(i=>i.assetId&&i.evidence.some(e=>e.pageIndex===pi&&overlap(e.bbox,cropBox))))continue;
    const region={id:`publication-table-${pi}-${hex(new TextEncoder().encode(JSON.stringify(box))).slice(0,16)}`,pageIndex:pi,bbox:cropBox,blockIds:[...new Set(members.flatMap(i=>i.extensions?.blockIds||[]))],assetIds:[]};
    if(9*(cropBox[2]-cropBox[0])*(cropBox[3]-cropBox[1])>MAX_PIXELS)continue;
    const inventory=await readSourceAssets({bytes:snapshot,document,regions:[region],signal}),png=extractPng(inventory.assets.find(a=>a.id===region.id)),assetId=`latex-${region.id}`;
    const rows=candidate.rows.map(row=>row.map(cell=>{
      const evidence=[];
      for(const b of document.blocks.filter(b=>b.text&&b.source.pageIndex===pi)){
        const selected=(b.source.characters||[]).filter(c=>cell.runs.some(r=>within(c.bbox,r.bbox,.4)));let range=null;
        for(const c of selected){if(range&&range.end===c.start)range.end=c.end;else{range={start:c.start,end:c.end};evidence.push(ref(hash,pi,b.source.bbox,{blockId:b.id,range}));}}
      }
      const canonical=evidence.map(e=>document.pages[e.pageIndex].text.slice(e.range.start,e.range.end)).join(' ');
      const text=canonical&&canonical.replace(/\s/gu,'')!==cell.text.replace(/\s/gu,'')?canonical:cell.text;
      return {text,evidence:evidence.length?evidence:[ref(hash,pi,box)]};
    }));
    const evidence=[ref(hash,pi,cropBox),...members.flatMap(i=>i.evidence)],ids=new Set(members.map(i=>i.id)),first=Math.min(...members.map(i=>output.items.indexOf(i)));
    const gutter=output.pages[pi].extensions?.layoutHints?.gutterBp;
    const spanning=Array.isArray(gutter)&&cropBox[0]<gutter[0]&&cropBox[2]>gutter[1]||cropBox[2]-cropBox[0]>output.pages[pi].width*.6;
    const item={id:`latex-${region.id}`,kind:'table',status:'observed',evidence,assetId,table:{rows},order:members[0].order,extensions:{blockIds:region.blockIds,assetIds:[],regionId:region.id,span:spanning?'page':'column',publicationTable:{method:candidate.method,columns:candidate.columns,rows:rows.length,caption:candidate.caption.text,sourceRegion:[...cropBox]}}};
    output.assets.push({id:assetId,evidence:[evidence[0]],representation:'region-raster',bytes:png,mediaType:'image/png',sha256:hex(png),editable:false,reason:'source-table-region'});
    output.items.splice(first,0,item);output.items=output.items.filter(i=>!ids.has(i.id));output.relations=output.relations.filter(r=>!ids.has(r.from)&&!ids.has(r.to));
    diag('source-table-region-preserved',item);
  }
  abort(signal);return output;
}
function sameIds(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v===b[i]);}

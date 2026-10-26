/* Source-derived table candidates. Geometry is a hint, never a PDF writer.
 * MIT recognition/model provenance: table-vendor/NOTICE.md.
 * Public boxes use the existing browser writer's top-left-page coordinates. */
import {detectTables} from './table-vendor/detection.mjs';
export {TableModel} from './table-vendor/model.mjs';
export * as tableGeometry from './table-vendor/geometry.mjs';

export const TABLE_LIMITS = Object.freeze({maxBytes:25*1024*1024,maxPages:200,maxRuns:12000,maxRules:12000,maxChars:150000,maxCellChars:4000});
const SCHEMA='falsify.source-tables.v1', issued=new WeakSet();
export class TableAdapterError extends Error {constructor(code){super(code);this.name='TableAdapterError';this.code=code;}}
const fail=code=>{throw new TableAdapterError(code);};
const boxOK=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[2]>b[0]&&b[3]>b[1];
const union=bs=>[Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))];
const overlap=(a,b)=>Math.min(a[2],b[2])-Math.max(a[0],b[0])>0.05&&Math.min(a[3],b[3])-Math.max(a[1],b[1])>0.05;
const contains=(outer,inner,tol=0)=>outer[0]-tol<=inner[0]&&outer[1]-tol<=inner[1]&&outer[2]+tol>=inner[2]&&outer[3]+tol>=inner[3];
function frozen(v){if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;}
async function digest(data){return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');}
const id=async(prefix,value)=>prefix+(await digest(new TextEncoder().encode(JSON.stringify(value)))).slice(0,24);
const rect=b=>({x:b[0],y:b[1],width:b[2]-b[0],height:b[3]-b[1]});
const publicBox=(r,h)=>[r.x,h-r.y-r.height,r.x+r.width,h-r.y];

/** readPages is a trusted engine adapter, not UI-supplied geometry. It must read
 * the supplied private byte copy. The default MuPDF reader opens those bytes.
 * Snapshot-only callers cannot obtain a verified model by passing pages. */
export async function detectSourceTables({sourceBytes,sourceSha256,revision,mupdf,readPages}={}){
  if(!(sourceBytes instanceof Uint8Array)||sourceBytes.byteLength>TABLE_LIMITS.maxBytes||sourceBytes.byteLength<5)fail('invalid-source');
  if(typeof revision!=='string'||!revision||revision.length>200)fail('invalid-revision');
  const bytes=sourceBytes.slice(),sha=await digest(bytes);
  if(typeof sourceSha256!=='string'||sha!==sourceSha256)fail('stale-source');
  if(readPages!==undefined&&typeof readPages!=='function')fail('invalid-reader');
  const pages=await (readPages?readPages(bytes):readMuPdfTablePages(bytes,mupdf));
  if(await digest(bytes)!==sha)fail('reader-mutated-source');
  if(!Array.isArray(pages)||!pages.length||pages.length>TABLE_LIMITS.maxPages)fail('page-limit');
  const tables=[],pageModels=[];let charsTotal=0;
  for(let p=0;p<pages.length;p++){
    const page=pages[p];
    if(page.pageIndex!==p||!(page.width>0&&page.height>0)||![page.width,page.height].every(Number.isFinite)||page.coordinateSpace!=='top-left-page')fail('invalid-page');
    if(!Array.isArray(page.runs)||page.runs.length>TABLE_LIMITS.maxRuns||!Array.isArray(page.rules)||page.rules.length>TABLE_LIMITS.maxRules)fail('snapshot-limit');
    const seen=new Set(),runs=page.runs.map(r=>{
      if(typeof r.id!=='string'||!r.id||seen.has(r.id)||typeof r.text!=='string'||!boxOK(r.bbox)||!contains([0,0,page.width,page.height],r.bbox,0.1))fail('invalid-run');
      seen.add(r.id);charsTotal+=r.text.length;if(charsTotal>TABLE_LIMITS.maxChars)fail('character-limit');
      return {id:r.id,text:r.text,bbox:[...r.bbox],horizontal:r.horizontal!==false};
    });
    const rules=page.rules.map(r=>{if(!boxOK(r.bbox))fail('invalid-rule');return rect([r.bbox[0],page.height-r.bbox[3],r.bbox[2],page.height-r.bbox[1]]);});
    if(page.chars&&(!Array.isArray(page.chars)||page.chars.length>TABLE_LIMITS.maxChars))fail('character-limit');
    const pm={pageIndex:p,width:page.width,height:page.height,rotation:page.rotation,runs,chars:page.chars?.map(c=>({c:c.c,bbox:[...c.bbox],lineId:c.lineId}))??null};
    if(pm.chars&&pm.chars.some(c=>typeof c.c!=='string'||!boxOK(c.bbox)||!Number.isInteger(c.lineId)))fail('invalid-characters');
    pageModels.push(pm);if(page.rotation!==0)continue;
    const candidates=detectTables(runs.map(r=>({id:r.id,text:r.text,bounds:rect([r.bbox[0],page.height-r.bbox[3],r.bbox[2],page.height-r.bbox[1]]),locked:!r.horizontal})),p,{},rules);
    for(const table of candidates){
      // Aligned prose columns are common. Unruled candidates require repeated
      // numeric evidence, not alignment alone. This deliberately misses text-only tables.
      const numeric=table.cells.filter(c=>c.runIds.some(rid=>/^[\s$€£¥+−\-\d.,()%±:eE/]+$/.test(runs.find(r=>r.id===rid)?.text||'')&&/\d/.test(runs.find(r=>r.id===rid)?.text||''))).length;
      if(!table.pageRuled&&(table.rows<3||numeric<2))continue;
      const bbox=publicBox(table.bounds,page.height),tableId=await id('tbl-',[sha,revision,p,bbox,table.rowEdges,table.colEdges]);
      const cells=[];
      for(const cell of table.cells){
        const bbox=publicBox(cell.rect,page.height),cellId=await id('cell-',[sha,revision,p,tableId,cell.row,cell.col,bbox,cell.runIds]);
        cells.push({id:cellId,row:cell.row,col:cell.col,rowSpan:cell.rowSpan,colSpan:cell.colSpan,bbox,runIds:[...cell.runIds]});
      }
      tables.push({id:tableId,pageIndex:p,bbox,rows:table.rows,cols:table.cols,ruled:table.pageRuled,confidence:table.confidence,cells});
    }
  }
  const model=frozen({schema:SCHEMA,authority:'structure-hint',sourceBinding:readPages?'verified-bytes-reader-adapter':'mupdf-source-read',sourceSha256:sha,revision,coordinateSpace:'top-left-page',tables,pages:pageModels});issued.add(model);return model;
}

/** Exact source text plus tight glyph/run anchor; no edit/after is chosen. */
export function selectTableCell(model,{tableId,cellId,sourceSha256,revision}={}){
  if(!issued.has(model))fail('unverified-model');
  if(model.sourceSha256!==sourceSha256||model.revision!==revision)fail('stale-selection');
  const table=model.tables.find(t=>t.id===tableId),cell=table?.cells.find(c=>c.id===cellId);
  if(!cell)fail('cell-not-found');
  const page=model.pages[table.pageIndex],selected=page.runs.filter(r=>cell.runIds.includes(r.id));
  const unsupported=reason=>frozen({status:'unsupported',reason,tableId,cellId,sourceSha256,revision});
  if(selected.length!==1)return unsupported(selected.length?'multi-run-cell':'empty-cell');
  const run=selected[0],before=run.text;
  if(!before.trim()||before.length>TABLE_LIMITS.maxCellChars)return unsupported('cell-text-limit');
  if(!run.horizontal)return unsupported('rotated-text');
  if(!contains(cell.bbox,run.bbox,0.2))return unsupported('cell-boundary-uncertain');
  if(page.runs.some(r=>r.id!==run.id&&r.text.trim()&&overlap(r.bbox,run.bbox)))return unsupported('overlapping-text');
  // Match the current browser writer's tolerance, including nearby duplicate
  // values. Never choose a page-global occurrence ordinal from detector order.
  const needle=before.replace(/\s+/g,' ').trim(),matching=[];
  const consider=b=>{if(contains(b,run.bbox,Math.max(4,Math.min(8,(b[3]-b[1])/2))))matching.push(b);};
  if(page.chars){
    const {text,map}=normalizeChars(page.chars);let from=0;
    while(matching.length<2){const at=text.indexOf(needle,from);if(at<0)break;const bs=map.slice(at,at+needle.length).filter(n=>n!==null).map(n=>page.chars[n].bbox);if(bs.length)consider(union(bs));from=at+1;}
  }else{
    // Trusted PDFium adapters must keep each run exact. Multi-run and combined
    // quotes are deliberately refused; substring hits within each run count.
    for(const r of page.runs){const text=r.text.replace(/\s+/g,' ').trim();let at=-1;while(matching.length<2&&(at=text.indexOf(needle,at+1))>=0)consider(r.bbox);if(matching.length===2)break;}
  }
  if(matching.length!==1)return unsupported(matching.length?'ambiguous-quote':'quote-mismatch');
  return frozen({status:'ready',tableId,cellId,sourceSha256,revision,before,pageIndex:table.pageIndex,runIds:[run.id],cellBbox:[...cell.bbox],anchor:{bbox:[...run.bbox],coordinateSpace:'top-left-page',origin:'top-left',yAxis:'down',unit:'pt'}});
}

function normalizeChars(chars){let text='',map=[],gap=false,line=null;for(let i=0;i<chars.length;i++){const c=chars[i];if(line!==null&&c.lineId!==line)gap=true;line=c.lineId;if(!c.c.trim()){gap=true;continue;}if(gap&&text){text+=' ';map.push(null);}gap=false;text+=c.c;for(let k=0;k<c.c.length;k++)map.push(i);}return {text,map};}

/** Existing MuPDF runtime is injected; this module imports no second engine. */
export function readMuPdfTablePages(bytes,mupdf){
  if(!mupdf?.Document||!mupdf?.Device)fail('reader-unavailable');
  let doc;const pages=[];
  try{
    doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF();
    if(!doc||doc.needsPassword())fail('unsupported-document');
    if(doc.countPages()>TABLE_LIMITS.maxPages)fail('page-limit');
    for(let p=0;p<doc.countPages();p++){
      const page=doc.loadPage(p),runs=[],chars=[],rules=[];let st,dev;
      try{
        const bounds=page.getBounds(),width=bounds[2]-bounds[0],height=bounds[3]-bounds[1];
        // Current writer does not support rotated/cropped coordinate mappings.
        const object=page.getObject(),rotation=object.getInheritable('Rotate').asNumber()||0;
        if(bounds[0]!==0||bounds[1]!==0)fail('unsupported-page-origin');
        let lineChars=[],horizontal=true,lineId=-1,lastY=null;
        const transform=page.getTransform();
        const finish=()=>{if(!lineChars.length)return;let start=0;for(let i=1;i<=lineChars.length;i++){
          const a=lineChars[i-1],b=lineChars[i];
          if(!b||b.bbox[0]-a.bbox[2]>Math.max(3,a.size*1.5)){
            const group=lineChars.slice(start,i);while(group.length&&!group[0].c.trim())group.shift();while(group.length&&!group.at(-1).c.trim())group.pop();
            if(group.length)runs.push({id:`p${p}-run${runs.length}`,text:group.map(c=>c.c).join(''),bbox:union(group.map(c=>c.bbox)),horizontal});start=i;
          }
        }lineChars=[];};
        st=page.toStructuredText('preserve-whitespace,preserve-images');
        st.walk({beginLine(_b,wmode,direction){finish();horizontal=wmode===0&&Math.abs(direction[1])<0.01&&direction[0]>0;},onChar(c,origin,_font,size,quad){
          const bbox=[Math.min(quad[0],quad[2],quad[4],quad[6]),Math.min(quad[1],quad[3],quad[5],quad[7]),Math.max(quad[0],quad[2],quad[4],quad[6]),Math.max(quad[1],quad[3],quad[5],quad[7])];
          const y=transform[1]*origin[0]+transform[3]*origin[1]+transform[5];if(lastY===null||Math.abs(y-lastY)>1.25){lineId++;lastY=y;}
          if(boxOK(bbox)){const item={c,bbox,lineId,size};chars.push(item);lineChars.push(item);}if(chars.length>TABLE_LIMITS.maxChars)fail('character-limit');
        },endLine(){finish();}});finish();
        // Native straight stroked rules only. Curves and fills are not guessed
        // into table boundaries. Clips do not grant any write authority.
        dev=new mupdf.Device({strokePath(path,stroke,ctm,_cs,_color,alpha){
          if(alpha!==1)return;let current=null,first=null;
          const point=(x,y)=>[ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]];
          const segment=next=>{if(current){const dx=Math.abs(next[0]-current[0]),dy=Math.abs(next[1]-current[1]),t=Math.max(0.1,stroke.getLineWidth()*Math.hypot(ctm[0],ctm[1]));if((dx<0.1&&dy>2)||(dy<0.1&&dx>2))rules.push({bbox:[Math.min(current[0],next[0])-t/2,Math.min(current[1],next[1])-t/2,Math.max(current[0],next[0])+t/2,Math.max(current[1],next[1])+t/2]});}current=next;if(rules.length>TABLE_LIMITS.maxRules)fail('rule-limit');};
          path.walk({moveTo(x,y){current=first=point(x,y);},lineTo(x,y){segment(point(x,y));},curveTo(){current=null;},closePath(){if(first)segment(first);}});
        }});page.run(dev,[1,0,0,1,0,0]);dev.close();
        pages.push({pageIndex:p,width,height,rotation,coordinateSpace:'top-left-page',runs,rules,chars});
      }finally{dev?.destroy();st?.destroy();page.destroy();}
    }
    return pages;
  }finally{doc?.destroy();}
}

/* Source-derived table selections stay inside this operation's worker. */
import * as mupdf from './browser-pdf-vendor/mupdf.js';
import {detectSourceTables, selectTableCell, readMuPdfTablePages} from './table-adapter.mjs';
const MAX_CELLS=500;
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
export async function inspectTables(data){
  if(!Number.isSafeInteger(data.pageIndex)||data.pageIndex<0||typeof data.revision!=='string')throw new Error('invalid-request');
  const model=await detectSourceTables({sourceBytes:new Uint8Array(data.bytes),sourceSha256:data.fileHash,revision:data.revision,mupdf});
  const page=model.pages[data.pageIndex];if(!page)throw new Error('page-not-found');
  const cells=[];let count=0;
  for(const table of model.tables){
    if(table.pageIndex!==data.pageIndex)continue;
    for(const cell of table.cells){
      count++;if(cells.length>=MAX_CELLS)continue;
      const selection=selectTableCell(model,{tableId:table.id,cellId:cell.id,sourceSha256:data.fileHash,revision:data.revision});
      let alias=null;
      if(selection.status==='ready'){
        const key=JSON.stringify([model.sourceSha256,data.pageIndex,selection.anchor.bbox,selection.before]);
        alias='table:'+data.pageIndex+':'+hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))).slice(0,24);
      }
      cells.push({row:cell.row,col:cell.col,cellBbox:cell.bbox,alias,selection});
    }
  }
  return {fileHash:model.sourceSha256,revision:model.revision,pageIndex:data.pageIndex,width:page.width,height:page.height,
    cells,truncated:count>MAX_CELLS,totalCells:count,limit:MAX_CELLS};
}
export async function checkFit(data){
  const bytes=new Uint8Array(data.bytes);
  if(bytes.length>25*1024*1024||!Array.isArray(data.cells)||data.cells.length>24||data.cells.some(c=>typeof c.id!=='string'||!Number.isSafeInteger(c.pageIndex)||c.pageIndex<0||typeof c.after!=='string'||c.after.length>4000||!Array.isArray(c.bbox)||c.bbox.length!==4||!c.bbox.every(Number.isFinite)||c.bbox[0]>=c.bbox[2]||c.bbox[1]>=c.bbox[3]))throw new Error('invalid-request');
  if(hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))!==data.fileHash)throw new Error('stale-source');
  const pages=readMuPdfTablePages(bytes,mupdf),contains=(a,b)=>a[0]-.5<=b[0]&&a[1]-.5<=b[1]&&a[2]+.5>=b[2]&&a[3]+.5>=b[3];
  const results=data.cells.map(cell=>{
    if(!cell.after)return {id:cell.id,status:'empty'};
    const normalized=cell.after.replace(/\s+/g,' ').trim(),runs=pages[cell.pageIndex]?.runs||[];
    const hits=runs.filter(r=>r.text.replace(/\s+/g,' ').includes(normalized)&&r.bbox[0]<cell.bbox[2]&&r.bbox[2]>cell.bbox[0]&&r.bbox[1]<cell.bbox[3]&&r.bbox[3]>cell.bbox[1]);
    return {id:cell.id,status:hits.length===1?(contains(cell.bbox,hits[0].bbox)?'inside':'overflow'):'unverified'};
  });
  return {fileHash:data.fileHash,revision:data.revision,pageIndex:data.pageIndex,results};
}
if(typeof self!=='undefined'){self.onmessage=async event=>{
  const data=event.data||{};
  try{self.postMessage({id:data.id,ok:true,result:await (data.operation==='checkFit'?checkFit(data):inspectTables(data))});}
  catch(error){self.postMessage({id:data.id,ok:false,error:{code:error?.code||'table-inspection-failed'}});}
};

self.postMessage({ready:true});}

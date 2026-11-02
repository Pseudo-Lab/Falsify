import {hex} from './paragraph-pdf-crypto.mjs';
const compact=s=>String(s||'').replace(/\s/gu,'');
const label=s=>String(s||'').match(/^\s*(?:fig(?:ure)?\.?)\s*(\d+[a-z]?)\s*[.:|]/iu)?.[1]?.toLowerCase();
// Compare source pixels, including transparency, independently of PNG encoding.
function imageFingerprint(bytes,maskBytes,mupdf){
  const image=new mupdf.Image(bytes);let pix,mask,mp;
  try{
    pix=image.toPixmap();if(maskBytes){mask=new mupdf.Image(maskBytes);mp=mask.toPixmap();}
    const width=pix.getWidth(),height=pix.getHeight(),n=pix.getNumberOfComponents(),alpha=pix.getAlpha(),data=pix.getPixels(),rgb=new Uint8Array(width*height*3),md=mp?.getPixels(),mn=mp?.getNumberOfComponents();
    if(n-(alpha?1:0)!==3)throw new Error('UNSUPPORTED_IMAGE_COLOR');
    for(let i=0;i<width*height;i++){const a=alpha?data[i*n+n-1]:md?md[i*mn]:255;for(let c=0;c<3;c++)rgb[i*3+c]=alpha?Math.min(255,data[i*n+c]+255-a):Math.round(data[i*n+c]*a/255+255-a);}
    return `${width}x${height}:${hex(rgb)}`;
  }finally{mp?.destroy();mask?.destroy();pix?.destroy();image.destroy();}
}
export function auditReconstructionStructure({model,sourceDocument,document,mupdf}){
  const result={schema:'falsify.reconstruction-structure-audit.v1',sourcePdfHash:sourceDocument.sourceSha256,outputPdfHash:document.sourceSha256,assets:[],captions:[],tables:[],coverage:{sourceRegions:0,captions:0,tableCells:0},status:'partial'};
  if(model?.sourceSha256!==sourceDocument.sourceSha256)throw new Error('STALE_STRUCTURE');
  const observed=[];
  for(const a of document.assets){try{const c=a.content;if(c?.bytes)observed.push({id:a.id,pageIndex:a.source.pageIndex,bbox:a.source.bbox,hash:imageFingerprint(c.bytes,c.mask?.bytes,mupdf)});}catch{}}
  const owned=new Map();
  for(const i of model.items.filter(i=>i.assetId)){
    const asset=model.assets.find(a=>a.id===i.assetId);if(!asset||hex(asset.bytes)!==asset.sha256)throw new Error('STALE_ASSET');
    let fingerprint;try{fingerprint=imageFingerprint(asset.bytes,null,mupdf);}catch{result.assets.push({itemId:i.id,status:'unavailable'});continue;}
    const hits=observed.filter(a=>a.hash===fingerprint);
    const status=hits.length===1?'source-pixels-preserved':hits.length?'ambiguous':'missing';result.assets.push({itemId:i.id,status});if(hits.length===1){owned.set(i.id,hits[0]);result.coverage.sourceRegions++;}
    if(i.kind==='table'){
      let checked=0,total=0;for(const cell of i.table?.rows?.flat()||[]){total++;const refs=(cell.evidence||[]).filter(e=>e.range),text=refs.map(e=>sourceDocument.pages[e.pageIndex]?.text.slice(e.range.start,e.range.end)||'').join('');if(compact(text)===compact(cell.text))checked++;}
      result.coverage.tableCells+=checked;result.tables.push({itemId:i.id,rows:i.table?.rows?.length||0,columns:i.table?.rows?.[0]?.length||0,cellsChecked:checked,cellsTotal:total,status:status==='source-pixels-preserved'?'source-region-preserved':status});
    }
  }
  for(const r of model.relations.filter(r=>r.kind==='caption')){
    const caption=model.items.find(i=>i.id===r.to),number=label(caption?.text),image=owned.get(r.from),matches=[];
    if(number)for(const b of document.blocks.filter(b=>b.text)){for(const l of b.source.lines||[]){const text=document.pages[b.source.pageIndex].text.slice(l.range.start,l.range.end);if(label(text)===number)matches.push({pageIndex:b.source.pageIndex,bbox:b.source.bbox});}}
    const c=matches.length===1?matches[0]:null,gap=c&&image?Math.max(0,c.bbox[1]-image.bbox[3],image.bbox[1]-c.bbox[3]):Infinity,overlap=c&&image?Math.min(c.bbox[2],image.bbox[2])-Math.max(c.bbox[0],image.bbox[0]):0;
    const status=c&&image?c.pageIndex===image.pageIndex&&gap<=36&&overlap>0?'attached':'separated':'unavailable';if(status==='attached')result.coverage.captions++;result.captions.push({itemId:r.to,figureItemId:r.from,label:number||null,status,...(Number.isFinite(gap)?{gap}:{} )});
  }
  result.status=[...result.assets,...result.captions].some(x=>['missing','separated'].includes(x.status))?'failed':'partial';return result;
}

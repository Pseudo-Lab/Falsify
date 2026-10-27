import {hex} from './paragraph-pdf-crypto.mjs';

const boxOK = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<b[2] && b[1]<b[3];
const inside = (b,p) => boxOK(b) && b[0]>=0 && b[1]>=0 && b[2]<=p.width && b[3]<=p.height;
const clone = value => structuredClone(value);
const bytesKey = b => b instanceof Uint8Array && b.length ? `${b.length}:${hex(b)}` : null;
const sameBytes = (a,b) => a instanceof Uint8Array && b instanceof Uint8Array && a.length===b.length && a.every((v,i)=>v===b[i]);

/** Build a source-bound plan; excluded IDs are flow ownership IDs, not parent IDs. */
export function buildFurniturePlan({document,flow,editedBlockIds=[]}={}) {
  if(document?.schema!=='falsify.paper-document.v1' || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets) || flow?.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items) || !Array.isArray(editedBlockIds)) throw new TypeError('Expected source-bound document and flow');
  const blocks=new Map([...document.blocks,...(flow.fragments || [])].map(b=>[b.id,b]));
  const assets=new Map(document.assets.map(a=>[a.id,a]));
  const edited=new Set(editedBlockIds), diagnostics=[], pages=document.pages.map(p=>({sourcePage:p.sourcePageIndex,header:[],footer:[]}));
  const pageMap=new Map(document.pages.map((p,i)=>[p.sourcePageIndex,{page:p,plan:pages[i]}]));
  const selected=new Set();
  const isEdited=b=>edited.has(b.id) || (b.parentBlockId && edited.has(b.parentBlockId));
  const textEntry=(item,b,kind)=>({kind,itemId:item.id,blockId:b.id,source:clone(b.source),bbox:clone(b.source.bbox),sourcePage:b.source.pageIndex,text:b.text,styleId:b.styleId ?? null,parentBlockId:b.parentBlockId ?? null});
  const add=(item,edge,entry)=>{pageMap.get(item.source.pageIndex).plan[edge].push(entry);selected.add(item.id);};
  for(const item of flow.items) {
    if(!['header','footer'].includes(item.kind)) continue;
    const p=pageMap.get(item.source?.pageIndex)?.page, bs=(item.blockIds || []).map(id=>blocks.get(id));
    if(!p || item.inline || item.assetIds?.length || item.blockIds?.length!==1 || !bs[0] || !bs[0].text || isEdited(bs[0]) || bs[0].source?.pageIndex!==item.source.pageIndex || JSON.stringify(bs[0].source?.bbox)!==JSON.stringify(item.source.bbox) || !inside(bs[0].source?.bbox,p) || !inside(item.source?.bbox,p)) {
      diagnostics.push({code:'furniture-retained',itemId:item.id,reason:'edited or unsupported ownership or geometry'}); continue;
    }
    const ordinary=flow.items.filter(x=>x.source?.pageIndex===item.source.pageIndex && ['paragraph','heading'].includes(x.kind) && boxOK(x.source?.bbox) && (x.blockIds || []).some(id=>blocks.get(id)?.text?.trim()));
    if(bs[0].kind!==item.kind && ordinary.some(x=>item.kind==='header' ? x.source.bbox[3]<=item.source.bbox[1] : x.source.bbox[1]>=item.source.bbox[3])) {
      diagnostics.push({code:'furniture-retained',itemId:item.id,reason:'ordinary text outside inferred edge'}); continue;
    }
    add(item,item.kind,textEntry(item,bs[0],'text'));
  }
  // The confirmed edge and ordinary text together bound the decoration envelope.
  const nearEdge=(item,edge)=>{
    const pair=pageMap.get(item.source?.pageIndex), box=item.source?.bbox;
    if(!pair || !inside(box,pair.page)) return false;
    const refs=pair.plan[edge].filter(e=>e.kind==='text'); if(!refs.length) return false;
    const near=refs.some(e=>box[1]<=e.bbox[3]+20 && box[3]>=e.bbox[1]-20);
    if(!near) return false;
    const body=flow.items.filter(x=>x.source?.pageIndex===item.source.pageIndex && !['header','footer','asset'].includes(x.kind) && x.id!==item.id && (x.blockIds || []).some(id=>blocks.get(id)?.text) && boxOK(x.source?.bbox));
    return edge==='header' ? body.every(x=>x.source.bbox[2]<=box[0] || x.source.bbox[0]>=box[2] || box[3]<=x.source.bbox[1]) : body.every(x=>x.source.bbox[2]<=box[0] || x.source.bbox[0]>=box[2] || box[1]>=x.source.bbox[3]);
  };
  const assetGroups=new Map();
  for(const item of flow.items.filter(i=>i.kind==='asset')) {
    const as=(item.assetIds || []).map(id=>assets.get(id)), bs=(item.blockIds || []).map(id=>blocks.get(id));
    if(!as.length || as.some(a=>!a || a.kind!=='image' || a.source?.pageIndex!==item.source?.pageIndex) || bs.some(b=>!b || b.text || isEdited(b)) || bs.some(b=>!(b.assetIds || []).some(id=>item.assetIds.includes(id))) || item.captionIds?.length) continue;
    const keys=as.map(a=>{const c=a.content, png=bytesKey(c?.bytes), mask=c?.mask ? bytesKey(c.mask.bytes) : 'none'; return png && mask && c.representation==='mupdf-decoded-png' && Array.isArray(a.source.transform) ? [png,mask,c.width,c.height,c.alpha,a.source.bbox,a.source.transform] : null;});
    if(keys.some(x=>!x)) continue;
    const key=JSON.stringify([item.source.bbox,keys]); if(!assetGroups.has(key)) assetGroups.set(key,[]); assetGroups.get(key).push(item);
  }
  for(const group of assetGroups.values()) {
    const first=group[0].assetIds.map(id=>assets.get(id).content);
    const identical=group.filter(item=>item.assetIds.every((id,i)=>{const c=assets.get(id).content, ref=first[i];return sameBytes(c.bytes,ref.bytes) && (!c.mask && !ref.mask || c.mask && ref.mask && sameBytes(c.mask.bytes,ref.mask.bytes));}));
    if(new Set(identical.map(i=>i.source.pageIndex)).size<2) continue;
    const supported=identical.filter(item=>nearEdge(item,'header') || nearEdge(item,'footer'));
    for(const item of identical) for(const edge of ['header','footer']) if(nearEdge(item,edge) || (edge==='header' && supported.filter(peer=>nearEdge(peer,edge)).length>=2 && !pageMap.get(item.source.pageIndex).plan[edge].some(e=>e.kind==='text') && inside(item.source.bbox,pageMap.get(item.source.pageIndex).page) && item.source.bbox[1]<pageMap.get(item.source.pageIndex).page.height*.12 && flow.items.filter(x=>x.source?.pageIndex===item.source.pageIndex && !['header','footer','asset'].includes(x.kind) && (x.blockIds || []).some(id=>blocks.get(id)?.text) && boxOK(x.source.bbox)).every(x=>x.source.bbox[2]<=item.source.bbox[0] || x.source.bbox[0]>=item.source.bbox[2] || item.source.bbox[3]<=x.source.bbox[1]))) {
      add(item,edge,{kind:'asset',itemId:item.id,source:clone(item.source),sourcePage:item.source.pageIndex,bbox:clone(item.source.bbox),blockIds:[...(item.blockIds || [])],assetIds:[...item.assetIds],renderAssetId:item.renderAssetId ?? null,assets:item.assetIds.map(id=>({id,source:clone(assets.get(id).source)}))}); break;
    }
  }
  const counters=new Map();
  for(const item of flow.items) {
    if(selected.has(item.id) || item.kind!=='paragraph' || item.inline || item.assetIds?.length || item.blockIds?.length!==1) continue;
    const b=blocks.get(item.blockIds[0]), pi=item.source?.pageIndex;
    if(!b || b.source?.pageIndex!==pi || JSON.stringify(b.source?.bbox)!==JSON.stringify(item.source?.bbox) || isEdited(b) || !nearEdge(item,'footer') || b.text.trim()!==`${pi+1} / ${document.pages.length}` && b.text.trim()!==`${pi+1}/${document.pages.length}`) continue;
    const style=(b.source.characters || []).map(c=>c.styleId).filter((id,i,a)=>i===0 || id!==a[i-1]); const key=JSON.stringify([b.source.bbox,b.styleId,style]);
    if(!counters.has(key)) counters.set(key,[]); counters.get(key).push({item,b});
  }
  for(const group of counters.values()) if(new Set(group.map(x=>x.item.source.pageIndex)).size>=2) for(const {item,b} of group) add(item,'footer',textEntry(item,b,'counter'));
  const margins={top:36,right:36,bottom:36,left:36};
  for(const {sourcePage,header,footer} of pages) {const p=pageMap.get(sourcePage).page; for(const e of header) margins.top=Math.max(margins.top,e.bbox[3]+Math.max(4,e.bbox[3]-e.bbox[1])); for(const e of footer) margins.bottom=Math.max(margins.bottom,p.height-e.bbox[1]+Math.max(4,e.bbox[3]-e.bbox[1]));}
  // Do not exclude content when the combined reservations leave no page area.
  if(document.pages.some(p=>margins.top+margins.bottom>=p.height || margins.left+margins.right>=p.width)) {
    diagnostics.push({code:'furniture-impossible-space',margins:{...margins},pages:document.pages.filter(p=>margins.top+margins.bottom>=p.height || margins.left+margins.right>=p.width).map(p=>({sourcePage:p.sourcePageIndex,width:p.width,height:p.height}))});
    for(const p of pages) {p.header=[];p.footer=[];} selected.clear(); margins.top=36;margins.bottom=36;
  }
  const excludedItemIds=flow.items.filter(i=>selected.has(i.id)).map(i=>i.id);
  const excludedBlockIds=flow.items.filter(i=>selected.has(i.id)).flatMap(i=>i.blockIds || []);
  return {sourceSha256:document.sourceSha256,margins,pages,excludedBlockIds,excludedItemIds,diagnostics};
}

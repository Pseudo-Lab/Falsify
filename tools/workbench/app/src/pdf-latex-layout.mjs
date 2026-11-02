const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const validBox=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];
const union=bs=>[Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))];
const overlapY=(a,b)=>a[1]<b[3]&&b[1]<a[3];
const overlap=(a,b)=>a[0]<b[2]&&b[0]<a[2]&&overlapY(a,b);

/** Source-coordinate proposal only. Never drops an item or proves visual fidelity. */
export function planReconstructionLayout(model){
 if(model?.schema!=='falsify.pdf-latex-reconstruction.v1'||!HASH.test(model.sourceSha256)||!Array.isArray(model.pages)||!model.pages.length||!Array.isArray(model.items))fail('INVALID_LAYOUT_MODEL');
 const pages=model.pages.map((p,i)=>{
  if(p?.pageIndex!==i||p.frame!=='mupdf-display'||!Number.isFinite(p.width)||!Number.isFinite(p.height)||p.width<=0||p.height<=0||!Array.isArray(p.transform)||p.transform.length!==6||!p.transform.every(Number.isFinite))fail('INVALID_LAYOUT_PAGE');
  return {pageIndex:i,width:p.width,height:p.height,bodyBox:null,bands:[],furniture:[]};
 });
 const grouped=pages.map(()=>[]),seen=new Set(),diagnostics=[];
 for(const item of model.items){
  if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id)||!Array.isArray(item.evidence)||!item.evidence.length)fail('INVALID_LAYOUT_ITEM');seen.add(item.id);
  const pi=item.evidence[0]?.pageIndex,page=pages[pi];
  if(!Number.isInteger(pi)||!page||item.evidence.some(e=>e?.sourceSha256!==model.sourceSha256||e.frame!=='mupdf-display'||e.pageIndex!==pi||!validBox(e.bbox)||e.bbox[0]<0||e.bbox[1]<0||e.bbox[2]>page.width||e.bbox[3]>page.height))fail('INVALID_LAYOUT_EVIDENCE');
  grouped[pi].push({item,box:union(item.evidence.map(e=>e.bbox))});
 }
 const say=(pageIndex,code,ids)=>diagnostics.push({code,severity:'warning',pageIndex,itemIds:[...ids]});
 for(const page of pages){
  const all=grouped[page.pageIndex],body=[];
  for(const entry of all){
   if(entry.item.kind!=='furniture'){body.push(entry);continue;}
   const b=entry.box,edge=b[3]<=page.height*.12?'header':b[1]>=page.height*.88?'footer':null;
   if(!edge){say(page.pageIndex,'FURNITURE_POSITION_UNRESOLVED',[entry.item.id]);body.push(entry);continue;}
   if(all.some(other=>other!==entry&&other.item.kind!=='furniture'&&overlap(b,other.box)))say(page.pageIndex,'FURNITURE_OVERLAP',[entry.item.id]);
   page.furniture.push({itemId:entry.item.id,bbox:[...b],placement:edge});
  }
  page.bodyBox=body.length?union(body.map(x=>x.box)):null;
  let prior=page.bodyBox?.[1]??0;
  const add=band=>{if(band.top<prior-.01)say(page.pageIndex,'BAND_VERTICAL_OVERLAP',band.kind==='columns'?[...band.left,...band.right]:band.items);band.gapBeforeBp=Math.max(0,band.top-prior);page.bands.push(band);prior=Math.max(prior,band.bottom);};
  const full=entry=>add({kind:'full-width',items:[entry.item.id],top:entry.box[1],bottom:entry.box[3]});
  const column=entry=>entry.item.extensions?.columns===2&&entry.item.extensions?.span==='column';
  let i=0;
  while(i<body.length){
   if(!column(body[i])){full(body[i++]);continue;}
   let end=i+1;while(end<body.length&&column(body[end]))end++;
   const group=body.slice(i,end),sorted=[...group].sort((a,b)=>a.box[0]-b.box[0]||a.box[2]-b.box[2]);
   const hint=model.pages[page.pageIndex].extensions?.layoutHints, gutter=hint?.gutterBp;
   const hintValid=hint?.status==='proposed'&&hint?.provenance==='paper-flow'&&hint?.columns===2&&Array.isArray(gutter)&&gutter.length===2&&gutter.every(Number.isFinite)&&gutter[0]>=0&&gutter[0]<gutter[1]&&gutter[1]<=page.width;
   if(hintValid){
    const mid=(gutter[0]+gutter[1])/2;
    const left=group.filter(x=>x.box[2]<=mid),right=group.filter(x=>x.box[0]>=mid);
    // Hints are approximate; actual envelopes must remain on their side
    // of the midpoint and leave a measurable physical gutter.
    const separated=left.length&&right.length&&Math.min(...right.map(x=>x.box[0]))-Math.max(...left.map(x=>x.box[2]))>=Math.max(4,page.width*.01);
    const ordered=side=>side.every((x,k)=>!k||side[k-1].box[1]<=x.box[1]);
    const contiguous=!group.some((x,k)=>right.includes(x)&&group.slice(k+1).some(y=>left.includes(y)));
    if(separated&&left.length+right.length===group.length&&contiguous&&ordered(left)&&ordered(right)){
     const overlapping=side=>side.some((a,k)=>side.slice(k+1).some(b=>overlapY(a.box,b.box)));
     if(overlapping(left)||overlapping(right))say(page.pageIndex,'COLUMN_VERTICAL_OVERLAP',group.map(x=>x.item.id));
     const l=union(left.map(x=>x.box)),r=union(right.map(x=>x.box)),box=union([l,r]);
     add({kind:'columns',left:left.map(x=>x.item.id),right:right.map(x=>x.item.id),leftBox:l,rightBox:r,top:box[1],bottom:box[3]});i=end;continue;
    }
    // A trusted-looking hint that contradicts the item geometry is not used to
    // force either a side or a different split. Preserve observed order.
    say(page.pageIndex,'COLUMN_HINT_CONFLICT',group.map(x=>x.item.id));
    for(const entry of group)full(entry);i=end;continue;
   }
   if(hint!=null)say(page.pageIndex,'COLUMN_HINT_INVALID',group.map(x=>x.item.id));
   const candidates=[];
   for(let cut=1;cut<sorted.length;cut++){
    const left=sorted.slice(0,cut),right=sorted.slice(cut),l=union(left.map(x=>x.box)),r=union(right.map(x=>x.box));
    if(r[0]-l[2]<Math.max(4,page.width*.01)||!left.some(a=>right.some(b=>overlapY(a.box,b.box))))continue;
    const validOrder=(side)=>side.every((a,k)=>side.slice(k+1).every(b=>!overlapY(a.box,b.box)&&a.box[1]<=b.box[1]));
    const leftInOrder=group.filter(x=>left.includes(x)),rightInOrder=group.filter(x=>right.includes(x));
    if(!validOrder(leftInOrder)||!validOrder(rightInOrder))continue;
    if(group.some((x,k)=>right.includes(x)&&group.slice(k+1).some(y=>left.includes(y))))continue;
    candidates.push({left:leftInOrder,right:rightInOrder,leftBox:l,rightBox:r});
   }
   if(candidates.length!==1){say(page.pageIndex,'COLUMN_BAND_UNRESOLVED',group.map(x=>x.item.id));for(const entry of group)full(entry);}
   else {const c=candidates[0],box=union([c.leftBox,c.rightBox]);add({kind:'columns',left:c.left.map(x=>x.item.id),right:c.right.map(x=>x.item.id),leftBox:c.leftBox,rightBox:c.rightBox,top:box[1],bottom:box[3]});}
   i=end;
  }
 }
 return {pages,diagnostics};
}

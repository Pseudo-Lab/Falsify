// Tiny straight link decorations only. No table/rule/figure classification is
// inferred from shape alone: every source path needs one exact Link owner.
import { readLinkPageCharacters } from './document-flow-links.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.02;
const list=(M,p)=>Array.from({length:M._FPDFPage_CountObjects(p)},(_,i)=>M._FPDFPage_GetObject(p,i)>>>0);
function float(M,fn,h){const p=M._malloc(4);try{return M[fn](h,p)?M.HEAPF32[p>>2]:null;}finally{M._free(p);}}
function color(M,fn,h){const p=M._malloc(16);try{return M[fn](h,p,p+4,p+8,p+12)?Array.from(M.HEAPU32.slice(p>>2,(p>>2)+4)):null;}finally{M._free(p);}}

export function snapshotTinyUnderline(engine,h){
 const M=engine.M;if(M._FPDFPageObj_GetType(h)!==2)fail('document_flow_foreign_object_unsupported');
 const b=engine.objectBounds(h),n=M._FPDFPath_CountSegments(h),p=M._malloc(32);
 try{
  const dashPhase=float(M,'_FPDFPageObj_GetDashPhase',h);
  if(!b||b.w<=.1||n<2||n>3||M._FPDFPageObj_HasTransparency(h)||M._FPDFPageObj_GetDashCount(h)!==0||!Number.isFinite(dashPhase)||Math.abs(dashPhase)>.001||M._FPDFPageObj_CountMarks(h)!==0)fail('document_flow_underline_style_unsupported');
  // PDFium returns a pointer to a valid object's empty clip holder; CountPaths
  // is -1 when that holder has no reference (no clipping), not one clip path.
  const clip=M._FPDFPageObj_GetClipPath(h),clipCount=clip?M._FPDFClipPath_CountPaths(clip):-1;
  if(clipCount>0||clipCount< -1)fail('document_flow_underline_clip_unsupported');
  if(!M._FPDFPageObj_GetMatrix(h,p))fail('document_flow_underline_style_unsupported');
  const matrix=Array.from(M.HEAPF32.slice(p>>2,(p>>2)+6));
  if(matrix.some(v=>!Number.isFinite(v))||matrix.slice(0,4).some((v,i)=>!near(v,[1,0,0,1][i])))fail('document_flow_underline_style_unsupported');
  const segments=[];
  for(let i=0;i<n;i++){
   const s=M._FPDFPath_GetPathSegment(h,i),type=M._FPDFPathSegment_GetType(s),close=!!M._FPDFPathSegment_GetClose(s);
   if(type!==(i?0:2)||!M._FPDFPathSegment_GetPoint(s,p,p+4))fail('document_flow_underline_segments_unsupported');
   const x=M.HEAPF32[p>>2],y=M.HEAPF32[(p>>2)+1];if(!Number.isFinite(x)||!Number.isFinite(y)||i&&(!near(y,segments[0].y)||i===2&&!near(x,segments[0].x)))fail('document_flow_underline_segments_unsupported');
   segments.push({x,y,close});
  }
  if(!M._FPDFPath_GetDrawMode(h,p,p+4))fail('document_flow_underline_style_unsupported');
  const fillMode=M.HEAP32[p>>2],stroke=!!M.HEAP32[(p>>2)+1],fill=color(M,'_FPDFPageObj_GetFillColor',h),strokeColor=color(M,'_FPDFPageObj_GetStrokeColor',h),width=float(M,'_FPDFPageObj_GetStrokeWidth',h),cap=M._FPDFPageObj_GetLineCap(h),join=M._FPDFPageObj_GetLineJoin(h);
  if(![0,1,2].includes(fillMode)||!fill||!strokeColor||fill[3]!==255||strokeColor[3]!==255||!Number.isFinite(width)||!(width>=0&&width<=2)||b.h>(stroke?2*width:.01)+.05||![0,1,2].includes(cap)||![0,1,2].includes(join))fail('document_flow_underline_style_unsupported');
  return {h:h>>>0,bounds:{...b},matrix,segments,fillMode,stroke,fill,strokeColor,width,cap,join};
 }finally{M._free(p);}
}

export function sourceUnderline(engine,h,pageIndex,annotationModel){
 const path=snapshotTinyUnderline(engine,h);
 if(!annotationModel)fail('document_flow_foreign_object_unsupported');
 const left=Math.min(...path.segments.map(s=>s.x+path.matrix[4])),right=Math.max(...path.segments.map(s=>s.x+path.matrix[4])),baseline=path.segments[0].y+path.matrix[5];
 const links=annotationModel.annotations.filter(a=>a.sourcePageIndex===pageIndex&&a.eligible===true&&a.kind==='link'&&near(a.rect[0],left)&&near(a.rect[2],right)&&baseline>=a.rect[1]-.02&&baseline<=a.rect[3]+.02);
 if(links.length!==1)fail('document_flow_underline_ownership_ambiguous');
 const link=links[0],chars=readLinkPageCharacters(engine,pageIndex),owned=chars.filter(c=>c.box&&Math.min(c.box.r,link.rect[2])-Math.max(c.box.l,link.rect[0])>1e-4&&Math.min(c.box.t,link.rect[3])-Math.max(c.box.b,link.rect[1])>1e-4);
 if(!owned.length)fail('document_flow_underline_ownership_ambiguous');
 // A citation underline is at most two source ems. Wider links can still
 // transport annotations, but their arbitrary path art remains unsupported.
 engine.loadPage(pageIndex);const M=engine.M,tp=M._FPDFText_LoadPage(engine.page),matrix=M._malloc(24);let size=0;
 try{for(const c of owned){
   if(!M._FPDFText_GetMatrix(tp,c.index,matrix))fail('document_flow_underline_style_unsupported');
   const [a,b,cx,d]=Array.from(M.HEAPF32.slice(matrix>>2,(matrix>>2)+4));
   size=Math.max(size,M._FPDFText_GetFontSize(tp,c.index)*Math.max(Math.hypot(a,b),Math.hypot(cx,d)));
 }}finally{M._free(matrix);M._FPDFText_ClosePage(tp);}
 if(!(size>0)||right-left>2*size+.02)fail('document_flow_underline_too_long');
 const objects=list(M,engine.page),order=objects.indexOf(h>>>0),text=M._FPDFText_LoadPage(engine.page);let owners;
 try{owners=owned.map(c=>objects.indexOf(M._FPDFText_GetTextObject(text,c.index)>>>0));}finally{M._FPDFText_ClosePage(text);}
 if(owners.some(i=>i<0)||!(order<Math.min(...owners)||order>Math.max(...owners)))fail('document_flow_underline_paint_order_unsupported');
 return {...path,sourcePageIndex:pageIndex,annotationIndex:link.annotationIndex,ownerRect:[...link.rect],paint:order<Math.min(...owners)?'before':'after'};
}

export function underlineEqual(actual,source,dx=0,dy=0){
 if(!near(actual.bounds.x,source.bounds.x+dx)||!near(actual.bounds.y,source.bounds.y+dy)||!near(actual.bounds.w,source.bounds.w)||!near(actual.bounds.h,source.bounds.h))return false;
 for(const key of ['fillMode','stroke','cap','join'])if(actual[key]!==source[key])return false;
 for(const key of ['fill','strokeColor'])if(JSON.stringify(actual[key])!==JSON.stringify(source[key]))return false;
 if(!near(actual.width,source.width)||actual.segments.length!==source.segments.length)return false;
 for(let i=0;i<actual.segments.length;i++){
  const a=actual.segments[i],s=source.segments[i];
  if(a.close!==s.close||!near(a.x+actual.matrix[4],s.x+source.matrix[4]+dx)||!near(a.y+actual.matrix[5],s.y+source.matrix[5]+dy))return false;
 }
 return true;
}

export function cloneUnderline(engine,source,dx,dy){
 const M=engine.M,first=source.segments[0],h=M._FPDFPageObj_CreateNewPath(first.x,first.y),p=M._malloc(24);
 if(!h){M._free(p);fail('document_flow_underline_clone_failed');}
 try{
  for(const [i,s]of source.segments.entries()){
   if(i&&!M._FPDFPath_LineTo(h,s.x,s.y))fail('document_flow_underline_clone_failed');
   if(s.close&&!M._FPDFPath_Close(h))fail('document_flow_underline_clone_failed');
  }
  const matrix=[...source.matrix];matrix[4]+=dx;matrix[5]+=dy;matrix.forEach((v,i)=>M.HEAPF32[(p>>2)+i]=v);
  if(!M._FPDFPageObj_SetFillColor(h,...source.fill)||!M._FPDFPageObj_SetStrokeColor(h,...source.strokeColor)||!M._FPDFPageObj_SetStrokeWidth(h,source.width))fail('document_flow_underline_clone_failed');
  M._FPDFPageObj_SetLineCap(h,source.cap);M._FPDFPageObj_SetLineJoin(h,source.join);
  // Set draw mode/matrix after width/cap/join so PDFium recalculates the
  // stroked bounds using the complete source graph state.
  if(!M._FPDFPath_SetDrawMode(h,source.fillMode,source.stroke)||!M._FPDFPageObj_SetMatrix(h,p))fail('document_flow_underline_clone_failed');
  if(!underlineEqual(snapshotTinyUnderline(engine,h),source,dx,dy))fail('document_flow_underline_clone_mismatch');
  return h>>>0;
 }catch(error){M._FPDFPageObj_Destroy(h);throw error;}finally{M._free(p);}
}

export function matchStagedUnderlines(sourceBands,parts,stageMoves){
 const paths=parts.flatMap(part=>(part.paths||[]).map(path=>({...path,pageIndex:part.pageIndex}))),claimed=new Set(),out=[];
 for(const band of sourceBands)for(const source of band.underlines||[]){
  const move=stageMoves.find(m=>m.sourcePageIndex===source.sourcePageIndex&&m.annotationIndex===source.annotationIndex);if(!move)fail('document_flow_underline_link_move_missing');
  const original=parts.find(p=>p.band.sourcePageIndex===source.sourcePageIndex);
  // Existing in-page repair can leave a decoration at its original exact
  // position while its label moves. Accept only one complete source-shape/
  // style match there OR one complete match at its proven staged glyph move.
  // Never select by proximity; two possible counterparts are a refusal.
  const matches=paths.filter(p=>p.pageIndex===move.outputPageIndex&&underlineEqual(p,source,move.dx,move.dy)||p.pageIndex===original?.pageIndex&&underlineEqual(p,source,0,0));
  if(matches.length!==1||claimed.has(matches[0].h))fail('document_flow_underline_staged_match_ambiguous');
  claimed.add(matches[0].h);out.push({source,staged:matches[0]});
 }
 if(claimed.size!==paths.length)fail('document_flow_underline_unowned_path');
 return out;
}

export function verifySavedUnderlines(engine,sourceBands,outputBands,moves){
 const expected=sourceBands.flatMap(b=>(b.underlines||[]).map(source=>{
  const move=moves.find(m=>m.sourcePageIndex===source.sourcePageIndex&&m.annotationIndex===source.annotationIndex);
  if(!move)fail('document_flow_underline_link_move_missing');return {source,move};
 }));
 // Verify while each reopened output page is current. Native handles from
 // another cached/evicted page never become authority for its paint order.
 for(const band of outputBands){
  engine.loadPage(band.outputPageIndex);const objects=list(engine.M,engine.page),paths=[];
  for(const h of objects){
   const b=engine.objectBounds(h);if(engine.M._FPDFPageObj_GetType(h)!==2||!b||b.y+b.h<band.floor-.5||b.y>band.bodyTop+.5)continue;
   paths.push(snapshotTinyUnderline(engine,h));
  }
  const chars=readLinkPageCharacters(engine,band.outputPageIndex),claimed=new Set();
  for(const {source,move}of expected.filter(e=>e.move.outputPageIndex===band.outputPageIndex)){
   const matches=paths.filter(p=>underlineEqual(p,source,move.dx,move.dy));
   if(matches.length!==1||claimed.has(matches[0].h))fail('document_flow_underline_saved_mismatch');
   const actual=matches[0],pathOrder=objects.indexOf(actual.h),[l,b,r,t]=source.ownerRect;
   // The native link proof independently establishes the exact output glyph
   // ownership of this translated immutable source rectangle. Compare the
   // path against THOSE actual glyph objects, not every text object on page.
   const owners=chars.filter(c=>c.box&&Math.min(c.box.r,r+move.dx)-Math.max(c.box.l,l+move.dx)>1e-4&&Math.min(c.box.t,t+move.dy)-Math.max(c.box.b,b+move.dy)>1e-4).map(c=>objects.indexOf(c.object));
   if(pathOrder<0||!owners.length||owners.some(i=>i<0)||(source.paint==='before'?!owners.every(i=>pathOrder<i):!owners.every(i=>pathOrder>i)))fail('document_flow_underline_paint_order_mismatch');
   claimed.add(actual.h);
  }
  if(claimed.size!==paths.length)fail('document_flow_underline_unowned_path');
 }
}

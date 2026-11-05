import {hex} from './paragraph-pdf-crypto.mjs';
// Read the existing PDF reference with independent text and unit cursors.
// Keep every returned page below its share of the agent observation budget.
const KINDS=new Set(['paragraph','heading','caption','furniture','figure','table','unknown']);
const ROLES=new Set(['title','heading','caption','footnote','body']);
const SPANS=new Set(['column','page','unknown']);
const high=(s,i)=>i>=0&&i<s.length&&s.charCodeAt(i)>=0xD800&&s.charCodeAt(i)<=0xDBFF;
const low=(s,i)=>i>=0&&i<s.length&&s.charCodeAt(i)>=0xDC00&&s.charCodeAt(i)<=0xDFFF;
function snapEnd(text,start,end){
 if(end>start&&end<text.length&&high(text,end-1)&&low(text,end))return end-1;
 if(end===start&&start<text.length&&high(text,start)&&low(text,start+1))return Math.min(text.length,start+2);
 return end;
}
function sourceUnitPlan(structure,u,group){
 return {sourceOrderIndex:structure.plan?.order?.indexOf(u.id)??-1,sourceFrontMatter:structure.plan?.frontMatter?.includes(u.id)??false,sourcePlacement:structure.plan?.furniture?.find(f=>f.id===u.id)?.placement??null,group:group?.slice(0,4)??null,groupSize:group?.length??0,groupTruncated:(group?.length??0)>4,planScope:'initial-source-proposal'};
}
function applyUnitMetadata(unit,u,bboxOk,kindOk,roleOk,spanOk){
 if(u.kind!==undefined)unit.kind=kindOk?u.kind:null;
 if(u.role!==undefined)unit.role=roleOk?u.role:null;
 if(u.span!==undefined)unit.span=spanOk?u.span:null;
 if(!bboxOk||!kindOk||!roleOk||!spanOk){unit.metadataStatus='invalid';unit.detail='유닛 메타데이터가 허용된 영역·종류·역할을 벗어납니다. 페이지 텍스트는 유지됩니다. next 커서로 다음 유닛을 읽으세요.';}
}
function projectUnit(structure,u){
 const group=structure.groups?.find(g=>Array.isArray(g)&&g.includes(u.id));
 const bboxOk=Array.isArray(u.bbox)&&u.bbox.length===4&&u.bbox.every(n=>typeof n==='number'&&Number.isFinite(n));
 const kindOk=u.kind===undefined||KINDS.has(u.kind);
 const roleOk=u.role===undefined||ROLES.has(u.role);
 const spanOk=u.span===undefined||SPANS.has(u.span);
 const unit={id:u.id,bbox:bboxOk?u.bbox:null,...sourceUnitPlan(structure,u,group)};
 applyUnitMetadata(unit,u,bboxOk,kindOk,roleOk,spanOk);
 return unit;
}
export async function readLayoutReference({bytes,sourcePdfHash,structure,loadPdf,baseUrl,pages=[],offset=0,textOffset,unitOffset,signal}){
 const check=()=>{if(signal?.aborted)throw new DOMException('취소했습니다.','AbortError');};
 check();if(!(bytes instanceof Uint8Array)||hex(bytes)!==sourcePdfHash)throw new Error('원본 PDF가 일치하지 않습니다.');
 function referenceOffsets(){
 const hasText=textOffset!==undefined&&textOffset!==null,hasUnit=unitOffset!==undefined&&unitOffset!==null,explicit=hasText||hasUnit;
 const startText=explicit?(hasText?textOffset:0):offset*1000,startUnit=explicit?(hasUnit?unitOffset:0):offset*20;
 if(![offset,startText,startUnit].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('원본 조회 위치를 확인하세요.');
  return {hasText,hasUnit,explicit,startText,startUnit};
 }
 const {hasText,hasUnit,explicit,startText,startUnit}=referenceOffsets();
 const lib=await loadPdf();check();const task=lib.getDocument({data:bytes.slice(),cMapUrl:new URL('vendor/cmaps/',baseUrl).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',baseUrl).href,wasmUrl:new URL('vendor/wasm/',baseUrl).href});
 try{
  const pdf=await task.promise;check();const selected=pages.length?pages:[0];
  if(selected.length>4||new Set(selected).size!==selected.length||selected.some(p=>!Number.isSafeInteger(p)||p<0||p>=pdf.numPages))throw new Error('요청한 원본 페이지가 없습니다.');
  function pageReference(pageIndex,page,content,budget){
   const text=content.items.map(i=>i.str||'').join(' '),viewport=page.getViewport({scale:1}),units=structure?.units.filter(u=>u.pageIndex===pageIndex)||[];
   let fromText=startText,fromUnit=startUnit;
   if(explicit){if(hasText&&fromText>text.length||hasUnit&&fromUnit>units.length)throw new Error('원본 조회 위치가 이 페이지 길이를 넘었습니다. 0부터 읽거나, 직전에 받은 next 커서로 이어 가세요.');}
   else{if(fromText>text.length)fromText=text.length;if(fromUnit>units.length)fromUnit=units.length;}
   let textCount=Math.min(1000,Math.max(0,text.length-fromText)),unitCount=Math.min(20,Math.max(0,units.length-fromUnit)),entry;
   const make=()=>{const textEnd=snapEnd(text,fromText,fromText+textCount),shown=text.slice(fromText,textEnd),textRemains=textEnd<text.length,unitsRemain=fromUnit+unitCount<units.length;return {pageIndex,width:viewport.width,height:viewport.height,text:shown,textOffset:fromText,textTruncated:textRemains,...(structure?{units:units.slice(fromUnit,fromUnit+unitCount).map(u=>projectUnit(structure,u)),unitOffset:fromUnit,unitsTruncated:unitsRemain}:{}),next:textRemains||unitsRemain?{pages:[pageIndex],textOffset:textEnd,unitOffset:fromUnit+unitCount}:null};};
   entry=make();while(JSON.stringify(entry).length>budget&&(unitCount>1||textCount>1)){if(unitCount>1)unitCount=Math.max(1,Math.floor(unitCount/2));else textCount=Math.max(1,Math.floor(textCount/2));entry=make();}
   if(JSON.stringify(entry).length>budget)throw Object.assign(new Error('원본 영역 정보가 너무 큽니다. unitOffset '+(fromUnit+1)+'으로 다음 유닛을 요청하세요.'),{code:'request_limit'});
   return entry;
  }
  const result=[],budget=Math.floor(9000/selected.length);
  for(const pageIndex of selected){
   const page=await pdf.getPage(pageIndex+1),content=await page.getTextContent();check();
   const entry=pageReference(pageIndex,page,content,budget);
   result.push(entry);
  }
  return {sourcePdfHash,totalPages:pdf.numPages,pages:result};
 }finally{await task.destroy();}
}

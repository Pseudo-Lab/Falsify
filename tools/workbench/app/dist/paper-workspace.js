/* RED paper surface: one original PDF page, direct edits, and the exact generated file.
   Edit core, external import, and browser export are optional globals. Missing ones stay unavailable. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  const doc=typeof document!=='undefined'?document:null;
  if(doc&&typeof doc.querySelector==='function'&&doc.querySelector('#paper-workspace')&&!root.FalsifyPaperWorkspace){
    root.FalsifyPaperWorkspace=api.create({document:doc});
    const fire=()=>doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-ready'));
    if(typeof setTimeout==='function')setTimeout(fire,0);else fire();
  }
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ORIGINS=new Set(['human','external-ai-import','ai-proposal']);
  const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
  const HEX=/^[0-9a-f]{64}$/;
  const SECRET=/^(file|bytes|data|token|password|authorization|secret|pdfbytes)$/i;
  const ZOOMS=[0.75,1,1.25,1.5,2];
  const sourceAlias=id=>/^(paragraph|table|layout):/.test(String(id||''));
  const TTL=12*60*60*1000;
  const SVG='http://www.w3.org/2000/svg';
  const round=n=>Math.round(n*1000)/1000;

  function pageIndexFromLabel(label){
    const m=/^PDF p\. (\d+)$/.exec(String(label||''));
    if(!m)return null;
    const n=Number(m[1]);
    return Number.isSafeInteger(n)&&n>=1?n-1:null;
  }
  function segmentPage(seg){
    if(!seg||typeof seg!=='object')return null;
    if(Number.isSafeInteger(seg.pageIndex)&&seg.pageIndex>=0)return seg.pageIndex;
    return pageIndexFromLabel(seg.label);
  }
  function normalizeOrigin(options){
    const o=options&&typeof options==='object'?options:{};
    const origin=typeof o.origin==='string'&&o.origin?o.origin:'external-ai-import';
    if(!ORIGINS.has(origin))return {ok:false,origin:null,model:undefined};
    const model=origin==='ai-proposal'&&typeof o.model==='string'&&MODEL.test(o.model)?o.model:undefined;
    return {ok:true,origin,model};
  }
  function anchoredResult(p,seg,base,hinted,hintedStart,hintedEnd,before,after){
      const page=segmentPage(seg);
      if(!Number.isSafeInteger(page)||page<0)return {...base,reason:'쪽 번호를 확정하지 못했습니다.'};
      if(Number.isSafeInteger(p.pageIndex)&&p.pageIndex!==page)return {...base,status:'ambiguous',reason:'제안의 쪽 번호와 원문 위치가 다릅니다.'};
      const occurrence=occurrenceOf(seg.text,before,hintedStart);
      if(!Number.isSafeInteger(occurrence))return {...base,reason:'지정한 범위의 occurrence를 세지 못했습니다.'};
      if(Number.isSafeInteger(hinted.occurrence)&&hinted.occurrence!==occurrence)return {...base,reason:'occurrence가 지정한 범위와 다릅니다.'};
      const anchor={start:hintedStart,end:hintedEnd,occurrence};
      return {before,after,segmentId:seg.id,pageIndex:page,anchor,status:'matched',matches:[{segmentId:seg.id,pageIndex:page,start:hintedStart,end:hintedEnd,occurrence}],reason:''};
      }
  function quoteMatches(pool,before,base){
    const matches=[];
    for(const seg of pool){
      if(!seg||typeof seg.text!=='string'||typeof seg.id!=='string')continue;
      const at=seg.text.indexOf(before);
      if(at<0)continue;
      if(seg.text.indexOf(before,at+1)>=0)return {error:{...base,status:'ambiguous',reason:'한 구간 안에 같은 Before가 둘 이상입니다.'}};
      matches.push({segmentId:seg.id,pageIndex:segmentPage(seg),start:at,end:at+before.length});
    }
    return {matches};
  }
  function classifyQuote(p,segs,base,before,after){
    let pool=Array.isArray(segs)?segs:[];
    if(typeof p.segmentId==='string'&&p.segmentId){
      pool=pool.filter(s=>s&&s.id===p.segmentId);
      if(!pool.length)return {...base,reason:'해당 구간이 원문에 없습니다.'};
    }
    const found=quoteMatches(pool,before,base);if(found.error)return found.error;
    const matches=found.matches;
    if(!matches.length)return {...base,reason:'원문에서 정확히 한 번 찾지 못했습니다.'};
    if(matches.length>1)return {...base,status:'ambiguous',matches,reason:'같은 Before가 둘 이상의 구간에 있습니다.'};
    const m=matches[0];
    if(!Number.isSafeInteger(m.pageIndex)||m.pageIndex<0)return {...base,matches,reason:'쪽 번호를 확정하지 못했습니다.'};
    if(Number.isSafeInteger(p.pageIndex)&&p.pageIndex!==m.pageIndex)return {...base,status:'ambiguous',matches,reason:'제안의 쪽 번호와 원문 위치가 다릅니다.'};
    return {before,after,segmentId:m.segmentId,pageIndex:m.pageIndex,anchor:{start:m.start,end:m.end,occurrence:0},status:'matched',matches,reason:''};
  }
  function classifyAnchored(p,segs,base,hinted,hintedStart,hintedEnd,before,after){
      if(hintedStart==null||hintedEnd==null||hintedStart<0||hintedEnd-hintedStart!==before.length)return {...base,reason:'지정한 범위가 Before 길이와 다릅니다.'};
      const id=typeof p.segmentId==='string'&&p.segmentId?p.segmentId:'';
      if(!id)return {...base,reason:'위치를 지정한 제안에는 문단 ID가 필요합니다.'};
      const seg=(Array.isArray(segs)?segs:[]).find(s=>s&&s.id===id);
      if(!seg||typeof seg.text!=='string')return {...base,reason:'해당 구간이 원문에 없습니다.'};
      if(seg.text.slice(hintedStart,hintedEnd)!==before)return {...base,reason:'지정한 위치의 원문이 Before와 다릅니다.'};
      return anchoredResult(p,seg,base,hinted,hintedStart,hintedEnd,before,after);
  }
  function invalidProposal(p,before,after,base){
    if(!p||typeof p!=='object'||!before.trim()||before===after||before.length>4000||after.length>4000)return base;
    if(after!==''&&!after.trim())return {...base,reason:'공백만 있는 After는 삭제가 아닙니다.'};
    return null;
  }
  function classifyOne(p,segs){
    const before=p&&typeof p.before==='string'?p.before:'';
    const after=p&&typeof p.after==='string'?p.after:'';
    const base={before,after,segmentId:null,pageIndex:null,anchor:null,status:'missing',matches:[],reason:'형식이 맞지 않습니다.'};
    const invalid=invalidProposal(p,before,after,base);if(invalid)return invalid;
    const hinted=p.anchor&&typeof p.anchor==='object'?p.anchor:null;
    const hintedStart=hinted&&Number.isSafeInteger(hinted.start)?hinted.start:null;
    const hintedEnd=hinted&&Number.isSafeInteger(hinted.end)?hinted.end:null;
    if(hintedStart!=null||hintedEnd!=null)return classifyAnchored(p,segs,base,hinted,hintedStart,hintedEnd,before,after);
    return classifyQuote(p,segs,base,before,after);
  }

  function classifyProposals(proposals,segments,options){
    const norm=normalizeOrigin(options);
    const segs=Array.isArray(segments)?segments:[];
    const originals=segs.filter(s=>s&&typeof s.id==='string'&&!sourceAlias(s.id));
    const items=(Array.isArray(proposals)?proposals:[]).map(p=>classifyOne(p,segs.filter(s=>{
      if(!s||typeof s.id!=='string'||!sourceAlias(s.id)||p&&p.segmentId===s.id)return true;
      return !originals.some(o=>segmentPage(o)===segmentPage(s)&&s.text&&hitsIn(o.text,s.text).length===1);
    })));
    return {...norm,items};
  }
  function indexItems(items){
    let raw='';
    const spans=[];
    (items||[]).forEach((item,i)=>{
      if(!item||typeof item.str!=='string')return;
      const start=raw.length;
      raw+=item.str;
      if(item.str)spans.push({i,start,end:raw.length,str:item.str});
      raw+=item.hasEOL?'\n':' ';
    });
    const lead=raw.length-raw.trimStart().length;
    const text=raw.trim();
    return {text,spans:spans.map(span=>({i:span.i,start:span.start-lead,end:span.end-lead,str:span.str})).filter(span=>span.end>0&&span.start<text.length)};
  }
  function itemTopLeft(item,viewBox){
    const tr=item&&item.transform;
    if(!tr||tr.length<6||!viewBox||viewBox.length<4)return null;
    const [a,b,c,d,e,f]=tr.map(Number);
    const w=Number(item.width),h=Number(item.height);
    if(![a,b,c,d,e,f,w,h].every(Number.isFinite)||!(w>0)||!(h>0))return null;
    const dir=Math.hypot(a,b)||1,up=Math.hypot(c,d)||1;
    const ux=a/dir,uy=b/dir,vx=c/up,vy=d/up;
    const pts=[[e,f],[e+ux*w,f+uy*w],[e+vx*h,f+vy*h],[e+ux*w+vx*h,f+uy*w+vy*h]];
    const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const left=minX-viewBox[0],right=maxX-viewBox[0];
    const top=viewBox[3]-maxY,bottom=viewBox[3]-minY;
    if(!(left<right&&top<bottom))return null;
    return [round(left),round(top),round(right),round(bottom)];
  }
  function sliceBox(item,viewBox,localStart,localEnd){
    const full=itemTopLeft(item,viewBox);
    if(!full||typeof item.str!=='string'||!item.str.length)return null;
    const len=item.str.length,a=Math.max(0,Math.min(len,localStart)),b=Math.max(0,Math.min(len,localEnd));
    if(!(a<b))return null;
    if(a===0&&b===len)return full;
    const tr=item.transform||[],alongX=Math.abs(Number(tr[1])||0)<0.001;
    if(!alongX)return full;
    const width=full[2]-full[0],x0=full[0]+width*(a/len),x1=full[0]+width*(b/len);
    if(!(x0<x1))return null;
    return [round(x0),full[1],round(x1),full[3]];
  }
  function union(boxes){
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const b of boxes){x0=Math.min(x0,b[0]);y0=Math.min(y0,b[1]);x1=Math.max(x1,b[2]);y1=Math.max(y1,b[3]);}
    return [round(x0),round(y0),round(x1),round(y1)];
  }
  function occurrenceOf(text,needle,start){
    if(!needle)return null;
    let count=0,from=0;
    while(from<=start){
      const at=text.indexOf(needle,from);
      if(at<0||at>start)return null;
      if(at===start)return count;
      count+=1;from=at+1;
    }
    return null;
  }
  function pageRotation(value){
    const n=Number(value);
    if(!Number.isFinite(n))return 0;
    return ((Math.round(n)%360)+360)%360;
  }
  function selectionRange(index,range,hitIndexes){
    let ordered,start,end;
    if(range&&Number.isInteger(range.startItem)&&Number.isInteger(range.endItem)&&Number.isInteger(range.startOffset)&&Number.isInteger(range.endOffset)){
      const a=index.spans.find(s=>s.i===range.startItem),b=index.spans.find(s=>s.i===range.endItem);
      if(!a||!b)return null;
      const first=index.spans.indexOf(a),last=index.spans.indexOf(b);
      if(first<0||last<first)return null;
      ordered=index.spans.slice(first,last+1);
      const aOff=Math.max(0,Math.min(a.str.length,range.startOffset)),bOff=Math.max(0,Math.min(b.str.length,range.endOffset));
      start=a.start+aOff;end=b.start+bOff;
    }else{
      if(!Array.isArray(hitIndexes)||!hitIndexes.length)return null;
      const wanted=new Set(hitIndexes);
      ordered=index.spans.filter(s=>wanted.has(s.i));
      if(ordered.length!==wanted.size)return null;
      const first=index.spans.indexOf(ordered[0]),last=index.spans.indexOf(ordered[ordered.length-1]);
      if(last-first+1!==ordered.length)return null;
      ordered=index.spans.slice(first,last+1);
      start=ordered[0].start;end=ordered[ordered.length-1].end;
    }
    return {ordered,start,end};
  }
  function selectionBox(range,ordered,start,end,items,viewBox){
    let bbox=validBbox(range&&range.domBox)?range.domBox.map(round):null;
    if(!bbox){
      const boxes=[];
      for(const span of ordered){
        const localStart=span===ordered[0]?start-span.start:0;
        const localEnd=span===ordered[ordered.length-1]?end-span.start:span.str.length;
        const piece=sliceBox(items[span.i],viewBox,localStart,localEnd);
        if(!piece)return null;
        boxes.push(piece);
      }
      bbox=union(boxes);
    }
    return bbox;
  }
  function selectionDimensions(items,viewBox,geometry){
    const meta=geometry&&typeof geometry==='object'?geometry:{};
    const rotation=pageRotation(meta.rotation);
    if(rotation!==0)return null;
    const box=Array.isArray(viewBox)&&viewBox.length>=4?viewBox:[0,0,0,0];
    const pageWidth=Number.isFinite(meta.pageWidth)?meta.pageWidth:box[2]-box[0];
    const pageHeight=Number.isFinite(meta.pageHeight)?meta.pageHeight:box[3]-box[1];
    if(!(pageWidth>0&&pageHeight>0))return null;
    if(!Array.isArray(items))return null;
    return {meta,pageWidth,pageHeight};
  }
  function contiguousSelection(index,ordered,start,end){
    if(!(start<end)||start<0||end>index.text.length)return false;
    for(let k=1;k<ordered.length;k++){
      const gap=index.text.slice(ordered[k-1].end,ordered[k].start);
      if(gap!==''&&gap!==' '&&gap!=='\n')return false;
    }
    return true;
  }
  function anchorFromSelection(items,viewBox,hitIndexes,geometry){
    const dimensions=selectionDimensions(items,viewBox,geometry);if(!dimensions)return null;
    const {meta,pageWidth,pageHeight}=dimensions;
    const index=indexItems(items);
    const range=meta.range&&typeof meta.range==='object'?meta.range:null;
    const selected=selectionRange(index,range,hitIndexes);if(!selected)return null;
    const {ordered,start,end}=selected;
    if(!contiguousSelection(index,ordered,start,end))return null;
    const before=index.text.slice(start,end);
    if(!before.trim())return null;
    const occurrence=occurrenceOf(index.text,before,start);
    if(!Number.isSafeInteger(occurrence))return null;
    const bbox=selectionBox(range,ordered,start,end,items,viewBox);if(!bbox)return null;
    return {before,anchor:{bbox,coordinate:'top-left',pageWidth:round(pageWidth),pageHeight:round(pageHeight),rotation:0,occurrence,start,end}};
  }
  function visualAnchor(items,viewBox,before,geometry){
    if(pageRotation(geometry&&geometry.rotation)!==0)return null;
    const index=indexItems(items);
    if(typeof before!=='string'||!before)return null;
    const at=index.text.indexOf(before);
    if(at<0||index.text.indexOf(before,at+before.length)>=0)return null;
    const hits=[];
    for(const span of index.spans){
      if(span.end<=at||span.start>=at+before.length)continue;
      if(span.start<at||span.end>at+before.length)return null;
      hits.push(span.i);
    }
    if(!hits.length)return null;
    const located=anchorFromSelection(items,viewBox,hits,geometry);
    return located&&located.before===before?located.anchor:null;
  }
  function clampScale(base,stageWidth,factor,fitScale){
    if(!base||typeof fitScale!=='function')return 0;
    const fit=fitScale(base,stageWidth>0?stageWidth:720,1);
    let s=(fit>0?fit:0)*(factor>0?factor:1);
    const w=base.width,h=base.height;
    if(!(w>0&&h>0)||!(s>0))return 0;
    const cap=Math.min(2,4096/w,4096/h,Math.sqrt((4096*4096)/(w*h)));
    if(s>cap)s=cap;
    return s>0?s:0;
  }
  function isFile(f){return !!f&&typeof f.arrayBuffer==='function'&&typeof f.size==='number'&&typeof f.name==='string';}
  function isPdf(file){return String(file&&file.name||'').toLowerCase().endsWith('.pdf')||file&&file.type==='application/pdf';}
  function clone(v){try{return JSON.parse(JSON.stringify(v));}catch{return null;}}
  function published(value){
    const copy=clone(value);
    if(!copy||typeof copy!=='object')return copy;
    const walk=o=>{if(!o||typeof o!=='object')return;for(const v of Object.values(o))walk(v);Object.freeze(o);};
    walk(copy);return copy;
  }
  const CAUSE_TEXT={
    'ambiguous-match':'같은 Before가 여러 곳에 있음',
    'not-found':'Before를 출력 위치에 연결하지 못함',
    'not-editable':'문단 흐름 편집을 지원하지 않는 위치',
    'after-missing':'After가 출력에서 확인되지 않음',
    'edited-page-text-or-order-mismatch':'수정한 쪽의 전체 내용·읽기 순서 검사가 일치하지 않음',
    'after-generated-whitespace-normalized':'추출기가 추가한 공백을 구분해 After 문구 확인',
    'spatial-text-order-normalized':'글자 좌표와 줄 경계로 전체 내용 보존 확인',
    'edited-flow-text-or-order-mismatch':'이어지는 본문 내용 또는 순서가 원문·편집과 다름',
    'glyph-overlap-increased':'글자 겹침이 늘어남',
    'header-footer-moved':'머리말 또는 꼬리말 위치가 바뀜',
    'header-footer-style-changed':'머리말 또는 꼬리말의 글꼴·크기가 바뀜',
    'paragraph-link-unverified':'인용 링크의 위치를 확인하지 못함',
    'continued-flow-source-typography-normalized':'원문의 줄끝 하이픈과 추출 공백을 재배치함',
    'continued-flow-generated-whitespace-normalized':'PDF 추출기가 만든 공백을 구분해 검사함',
    'source-line-end-discretionary-hyphen-matched':'원문의 줄끝 하이픈을 연결해 위치를 확인함',
    'pagination-required':'본문이 이어지는 쪽으로 넘어감',
    'content-stream-append-order':'PDF 내부 텍스트 저장 순서를 검사함',
    'self-check-not-independent':'자동 검사와 별도로 사람 검수가 필요함',
    'continuation-fixed-edge-graphics-not-repeated':'이어지는 쪽에는 고정 로고를 반복하지 않음',
    'edited-page-color-serialization':'재저장에 따른 미세한 색상 차이가 있을 수 있음',
    'selection-font-metrics':'미리보기 글꼴의 선택 위치를 보정함',
    'font-substituted':'글꼴을 대체함',
    'wrapped-after':'After가 여러 줄로 바뀜',
    'extraction-gap':'추출 공백이 있어 줄이 어긋날 수 있음',
    'after-extraction-order':'After 단어는 있으나 추출 순서가 다름',
    'page-count':'쪽 수가 원본과 다름',
    'figure-changed':'그림이 바뀜',
    'untouched-text':'편집하지 않은 쪽의 글이 바뀜',
    'present-after':'After가 출력에서 확인되지 않음',
    'removed-before':'Before가 출력에 남아 있음',
    'unchanged-output':'출력 바이트가 원본과 같음'
  };
  function readableCode(code){
    const c=String(code||'').toLowerCase().replace(/_/g,'-');
    return /^[a-z0-9-]{1,64}$/.test(c)?(CAUSE_TEXT[c]||c):'';
  }
  function causePhrase(item){
    if(!item||typeof item!=='object')return '';
    const code=readableCode(item.code);
    if(!code)return '';
    const sev=item.severity==='warning'?'주의':item.severity==='info'?'정보':item.status==='failed'?'실패':'';
    return sev?sev+' '+code:code;
  }
  function diagnosticLine(item){
    if(typeof item==='string'){
      const s=item.trim();
      return s&&s.length<=180&&!/[<>]/.test(s)?s:'';
    }
    const phrase=causePhrase(item);
    if(!phrase)return '';
    const page=Number.isInteger(item.pageIndex)?(item.pageIndex+1)+'쪽':'';
    const raw=typeof item.editId==='string'?item.editId:typeof item.id==='string'?item.id:'';
    const id=/^[A-Za-z0-9._:-]{1,80}$/.test(raw)?raw:'';
    return [phrase,page,id].filter(Boolean).join(' ');
  }
  function diagnosticItems(warnings,verification){
    const items=[];
    if(verification&&Array.isArray(verification.checks))items.push(...verification.checks);
    const failures=verification&&verification.checks&&verification.checks.failures;
    if(Array.isArray(failures))items.push(...failures.map(f=>({...f,status:'failed'})));
    if(verification&&Array.isArray(verification.edits))items.push(...verification.edits.filter(e=>e.status==='failed'||e.code));
    if(Array.isArray(warnings))items.push(...warnings);
    if(verification&&Array.isArray(verification.warnings))items.push(...verification.warnings);
    return items;
  }
  function diagnosticText(warnings,verification){
    const parts=[];
    for(const item of diagnosticItems(warnings,verification)){
      const line=diagnosticLine(item);
      if(!line||parts.includes(line))continue;
      parts.push(line);
      if(parts.length===6)break;
    }
    return parts.length?'진단: '+parts.join(' · ')+'. PDF 내용에는 넣지 않습니다.':'';
  }
  function generationLead(verification,stale){
    const status=verification&&typeof verification.status==='string'?verification.status:'';
    const pages=verification?.report?.selfCheck?.pages;
    const afterChecks=Array.isArray(pages)?pages.flatMap(p=>Array.isArray(p?.after_checks)?p.after_checks:[]):[];
    const confirmed=afterChecks.filter(c=>c?.present===true).length;
    const presence=confirmed?' 변경 문구 '+confirmed+'/'+afterChecks.length+'개는 출력에서 확인했습니다.':'';
    if(verification?.bodyPending===true)return (stale?'그 사이 편집이 바뀌어 마지막 부분 생성본으로 표시합니다. ':'')+'표 편집 단계가 검증을 통과하지 못해 본문 편집은 실행하지 않았습니다. 받은 부분 생성본만 표시하며 다운로드할 수 있습니다.';
    if(status==='draft')return '검증을 통과하지 못한 초안입니다. 진단과 실제 생성본을 확인하세요. 이 파일은 다운로드할 수 있습니다.';
    if(status==='failed'||status==='warning')return (stale?'그 사이 편집이 바뀌어 마지막 생성본으로만 표시합니다. ':'')+'검증 상태는 '+status+'입니다. 이 파일은 받을 수 있습니다.'+presence;
    if(status==='applied')return stale?'생성본을 받았지만 그 사이 편집이 바뀌어 마지막 생성본으로만 표시합니다. 검증 상태는 applied입니다.':'검증 상태는 applied입니다. 미리보기와 다운로드는 이 파일의 바이트입니다.';
    return stale?'생성본을 받았지만 그 사이 편집이 바뀌어 마지막 생성본으로만 표시합니다.':'생성본을 받았습니다. 미리보기와 다운로드는 이 파일의 바이트입니다.';
  }
  function scrub(value,depth){
    if(depth>5)return null;
    if(Array.isArray(value))return value.slice(0,24).map(v=>scrub(v,depth+1));
    if(!value||typeof value!=='object')return typeof value==='string'?value.slice(0,400):value;
    const out={};
    for(const [k,v] of Object.entries(value)){if(SECRET.test(k))continue;out[k]=scrub(v,depth+1);}
    return out;
  }
  function draftUnsafe(value,depth){
    if(depth>8)return true;
    if(typeof value==='string')return value.length>12000;
    if(!value||typeof value!=='object')return false;
    for(const [k,v] of Object.entries(value)){if(SECRET.test(k)||draftUnsafe(v,depth+1))return true;}
    return false;
  }
  function safeMessage(e){
    const m=e&&typeof e.message==='string'?e.message:'';
    if(!m||m.length>240||/[<>]/.test(m))return '이유를 표시하지 않습니다.';
    return m;
  }
  function generationError(e){
    const reasons={NOT_FOUND:'원문 인용의 위치를 찾지 못했습니다',AMBIGUOUS_MATCH:'같은 원문 인용이 여러 곳에 있습니다',OVERLAPPING_EDITS:'다른 변경과 범위가 겹칩니다',NOT_EDITABLE:'이 텍스트 배치를 편집하지 못했습니다',AMBIGUOUS_STYLE:'선택한 구간의 글꼴·크기·색상이 섞여 변경 서식을 정하지 못했습니다',UNSUPPORTED_WRAP_COMBINATION:'원문의 줄바꿈을 연결하지 못했습니다'};
    const failures=e?.details?.failures;
    if(!Array.isArray(failures)||!failures.length)return safeMessage(e);
    return failures.slice(0,6).map(f=>{
      const page=Number.isInteger(f.pageIndex)&&f.pageIndex>=0?'쪽 '+(f.pageIndex+1)+' · ':'';
      return page+(reasons[f.code]||'편집 계획을 만들지 못했습니다')+'.';
    }).join(' ');
  }
  function originText(origin,model){
    if(origin==='ai-proposal')return model?'AI 제안 · '+model:'AI 제안 · 모델 식별 없음';
    if(origin==='human')return '직접 편집';
    return '외부 제안 · 모델 실행으로 기록하지 않음';
  }
  const DRAFT_INDEX='falsify.paper-draft-index.v1';
  function sessionName(value){
    const name=String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,160);
    return name||'document';
  }
  function hitsIn(text,needle){
    const hits=[];
    if(!needle||typeof text!=='string')return hits;
    let from=0;
    while(from<text.length){
      const at=text.indexOf(needle,from);
      if(at<0)break;
      hits.push(at);
      if(hits.length>1000)break;
      from=at+1;
    }
    return hits;
  }
  function validBbox(box){
    if(!Array.isArray(box)||box.length!==4)return false;
    if(!box.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000))return false;
    return box[0]<box[2]&&box[1]<box[3];
  }
  function coreSegmentLabel(s,count){
      let label=typeof s.label==='string'&&s.label.trim()===s.label&&s.label.length>=1&&s.label.length<=200&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s.label)?s.label:'';
      const page=segmentPage(s);
      if(!label)label=Number.isSafeInteger(page)&&page>=0?'PDF p. '+(page+1):'문단 '+(count+1);
      return {label,page};
  }
  function coreSegment(s,i,ids,count){
      if(!s||typeof s!=='object')return null;
      const text=typeof s.text==='string'?s.text:'';
      if(text.length>200000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))return null;
      let id=typeof s.id==='string'&&s.id.trim()===s.id&&s.id.length<=80?s.id:'';
      if(!id)id='s'+i;
      if(ids.has(id))return null;
      ids.add(id);
      const {label,page}=coreSegmentLabel(s,count);
      const row={id,label,text};
      if(Number.isSafeInteger(page)&&page>=0&&page<=9999)row.pageIndex=page;
      return row;
  }
  function coreSegments(raw){
    const list=Array.isArray(raw)?raw:[];
    const out=[],ids=new Set();
    for(let i=0;i<list.length&&out.length<2000;i++){
      const row=coreSegment(list[i],i,ids,out.length);if(row)out.push(row);
    }
    return out;
  }
  function externalSegments(raw){return coreSegments(raw).filter(s=>!sourceAlias(s.id)||s.id.startsWith('layout:'));}
  function attachCoreBox(anchor,visual){
    const rotation=pageRotation(visual&&visual.rotation);
    const coordinate=visual&&visual.coordinate;
    if(rotation===0&&(coordinate==null||coordinate==='top-left')&&validBbox(visual&&visual.bbox))anchor.bbox=visual.bbox.slice();
  }
  function coreAnchor(visual,segment,before){
    const anchor={};
    const hits=segment?hitsIn(segment.text,before):[];
    let start=null,occurrence=null;
    if(visual&&Number.isSafeInteger(visual.start)&&Number.isSafeInteger(visual.end)&&visual.end===visual.start+before.length&&hits.indexOf(visual.start)>=0){
      start=visual.start;occurrence=hits.indexOf(visual.start);
    }else if(hits.length===1){start=hits[0];occurrence=0;}
    if(start==null)return {error:'같은 원문이 한 곳으로 확정되지 않아 편집으로 넣지 않았습니다.'};
    anchor.start=start;anchor.end=start+before.length;anchor.occurrence=occurrence;
    attachCoreBox(anchor,visual);
    return {anchor};
  }

  function create(deps){
    deps=deps||{};
    const doc=deps.document;
    if(!doc||typeof doc.querySelector!=='function')throw new Error('document required');
    const need=id=>{const node=doc.querySelector('#'+id);if(!node)throw new Error('missing #'+id);return node;};
    const ui={
      modeText:need('paper-mode-text'),modeTable:need('paper-mode-table'),modeHelp:need('paper-mode-help'),tableStatus:need('paper-table-status'),
      root:need('paper-workspace'),status:need('paper-workspace-status'),file:need('paper-file'),
      original:need('paper-original-download'),prev:need('paper-page-prev'),pageLabel:need('paper-page-label'),pageJump:need('paper-page-jump'),next:need('paper-page-next'),
      zoomOut:need('paper-zoom-out'),zoomLabel:need('paper-zoom-label'),zoomIn:need('paper-zoom-in'),
      beforeStage:need('paper-before-stage'),beforeStatus:need('paper-before-status'),
      afterLabel:need('paper-after-label'),afterStage:need('paper-after-stage'),afterStatus:need('paper-after-status'),
      inline:need('paper-inline'),inlineMeta:need('paper-inline-meta'),inlineBefore:need('paper-inline-before'),inlineAfter:need('paper-inline-after'),
      inlineApply:need('paper-inline-apply'),inlineCancel:need('paper-inline-cancel'),
      coreNote:need('paper-core-note'),editStatus:need('paper-edit-status'),undo:need('paper-undo'),redo:need('paper-redo'),edits:need('paper-edits'),
      fontLocal:doc.querySelector('#paper-font-local'),fontAdd:doc.querySelector('#paper-font-add'),fontFiles:doc.querySelector('#paper-font-files'),fontStatus:doc.querySelector('#paper-font-status'),
      exportNote:need('paper-export-note'),generate:need('paper-generate'),generateCancel:doc.querySelector('#paper-generate-cancel'),genStatus:need('paper-generate-status'),hash:need('paper-output-hash'),outputNotes:doc.querySelector('#paper-output-notes'),
      current:need('paper-current-download'),team:need('paper-team-share'),blue:need('paper-blue-handoff'),
      draftOpt:need('paper-draft-opt'),draftSource:need('paper-draft-source'),draftSave:need('paper-draft-save'),draftRestore:need('paper-draft-restore'),draftDelete:need('paper-draft-delete'),draftStatus:need('paper-draft-status'),
      proposals:need('paper-proposals'),proposalList:need('paper-proposal-list'),proposalStatus:need('paper-proposal-status')
    };
    const timers=deps.timers||globalThis,urls=deps.urls||globalThis.URL;
    const now=()=>typeof deps.now==='function'?deps.now():Date.now();
    const previewApi=()=>deps.preview||globalThis.FalsifyPreview||null;
    const marksApi=()=>deps.changeMarks||globalThis.FalsifyChangeMarks||null;
    const editsApi=()=>deps.edits||globalThis.FalsifyPaperEdits||null;
    const tableApi=()=>deps.tablePdf||globalThis.FalsifyTablePdf||null;
    const paragraphApi=()=>deps.paragraphPdf||globalThis.FalsifyParagraphPdf||null;
    const fontsApi=()=>deps.fonts||globalThis.FalsifyFonts||null;
    const legacyExporterApi=()=>deps.exporter||globalThis.FalsifyBrowserPdf||null;
    const pipelineApi=()=>deps.pipeline||globalThis.FalsifyPdfEditPipeline||null;
    const recompositionApi=()=>deps.recompositionPdf||globalThis.FalsifyRecompositionPdf||null;
    const useRecomposition=()=>!!doc.querySelector('#paper-recompose')?.checked;
    const tableEdit=e=>String(e.segmentId||'').startsWith('table:');
    const fullFontEmbedding=fonts=>fonts?.fonts?.some(f=>(f.fsType&0x100)!==0);
    function bodyExporter(edits){
      const flow=paragraphApi();
      if(fontsApi()&&flow)return flow;
      if(edits.some(e=>/^(paragraph|layout):/.test(String(e.segmentId||''))))return flow;
      if(flow&&edits.some(e=>e.origin==='ai-proposal'||e.origin==='external-ai-import'))return flow;
      return legacyExporterApi()||flow;
    }
    const exporterApi=()=>{
      if(useRecomposition())return recompositionApi();
      const edits=enabledEdits(),tables=edits.filter(tableEdit),body=edits.filter(e=>!tableEdit(e));
      if(tables.length&&body.length)return pipelineApi()?.prepare&&legacyExporterApi()?.prepare&&bodyExporter(body)?.prepare?pipelineApi():null;
      return tables.length?legacyExporterApi():bodyExporter(body);
    };
    const store=()=>{try{return deps.storage||globalThis.localStorage||null;}catch{return null;}};
    let blobStore=null,disposed=false;
    function blobApi(){
      if(deps.sourceBlobs)return deps.sourceBlobs;
      if(blobStore)return blobStore;
      const idb=globalThis.indexedDB;if(!idb)return null;
      let opening=null;
      const open=()=>{if(disposed)return Promise.reject(Error('Workspace disposed'));return opening??=new Promise((ok,no)=>{
        const req=idb.open('falsify.paper-source.v1',1);
        req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');};
        req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);
      }).catch(e=>{opening=null;throw e;});};
      const transaction=async(mode,operation)=>{const db=await open();if(disposed)throw Error('Workspace disposed');return new Promise((ok,no)=>{
        let value;const tx=db.transaction('files',mode);
        tx.oncomplete=()=>ok(value);tx.onabort=tx.onerror=()=>no(tx.error||Error('Storage transaction failed'));
        try{operation(tx.objectStore('files'),v=>{value=v;});}catch(e){try{tx.abort();}catch{}no(e);}
      });};
      const request=(method,key,record)=>transaction(method==='get'?'readonly':'readwrite',(store,set)=>{
        const q=method==='put'?store.put(record,key):store[method](key);q.onsuccess=()=>set(q.result);
      });
      blobStore={get:hash=>request('get',hash),put:(hash,record)=>request('put',hash,record),delete:hash=>request('delete',hash),
        purgeExpired:at=>transaction('readwrite',store=>{const cursor=store.openCursor();cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(!(row.value?.expiresAt>at))row.delete();row.continue();};}),
        dispose(){opening?.then(db=>db.close(),()=>{});opening=null;}};
      return blobStore;
    }
    const listeners=[];
    function listen(node,type,handler,options){if(!node)return;node.addEventListener(type,handler,options);listeners.push(()=>node.removeEventListener(type,handler,options));}
    let epoch=0,source=null,session=null,unsub=null,snapshot=null,output=null,inline=null,pageText=null,directEditor=null,directControls=null,directStatus=null,directResizeObserver=null,committingDirect=false,committingInline=false,composingDirect=false,selectionClickPending=false;
    let fontRevision=0,fontBusy=false,outputAt=null,generationFailed=false;
    let proposalQueue=null,accepted=new Set(),modelById=new Map(),draftRaw=null,pendingFocus=null,pendingResume=null;
    let external=null, externalRevision=0, draftTimer=null,combineIds=new Set(),suppressExternalPaint=false,proposalInputs=new Map(),atomicSelection=false;
    let selectionHistory=new Map();
    let editMode='text',tableCtl=null,tableSeq=0,tableBindings=new Map();
    let inspectCtl=null,resumeCtl=null,afterPart=0,afterSourcePage=0;
    let page=1,pages=0,zoom=1,drawSeq=0,afterSeq=0,loadTask=null,loadTimer=null,textLayerHandle=null,genCtl=null,genId=0,generating=false,afterTask=null,afterRender=null;
    let beforeMarks=null,afterMarks=null,compareFocus=null,afterCache=null,afterCacheKey=null,generator=null,generatorVersion=0,candidatePreview=null,candidateMarks=null;
    const showChanges=doc.querySelector('#paper-show-changes'),changeStatus=doc.querySelector('#paper-change-status');
    function syncChangeVisibility(){for(const stage of [ui.beforeStage,ui.afterStage])stage.classList.toggle('is-changes-hidden',showChanges?.checked===false);}
    listen(showChanges,'change',syncChangeVisibility);
    function paintBeforeChanges(){
      beforeMarks?.layer?.remove();beforeMarks=null;
      if(pageText&&marksApi()?.paintPage){
        const edits=enabledEdits().filter(e=>e.pageIndex===pageText.pageIndex),ordinary=edits.filter(e=>!source?.layoutSegments?.some(s=>s.id===e.segmentId));
        beforeMarks=marksApi().paintPage({document:doc,container:pageText.pageEl,items:pageText.items,divs:pageText.divs,edits:ordinary,side:'before'});
        for(const edit of edits.filter(e=>!ordinary.includes(e))){const view=layoutView(edit.segmentId);const result=marksApi().paintPage({document:doc,container:pageText.pageEl,...view,edits:[edit],side:'before'});beforeMarks.layer.append(result.layer);beforeMarks.missing.push(...result.missing);}
      }
      paintCandidate();
      pageText?.divs.forEach((div,i)=>{if(div?.dataset)div.dataset.i=String(i);});
      syncChangeVisibility();updateChangeStatus();
    }
    function layoutView(id){
      const indices=source?.layoutSegments?.find(s=>s.id===id)?.itemIndices;
      if(!Array.isArray(indices))return {items:pageText.items,divs:pageText.divs};
      const pairs=indices.map(i=>({item:pageText.items[i],div:pageText.divs[i]})).filter(p=>p.item&&p.div);
      return {items:pairs.map((p,i)=>{const next=pairs[i+1]?.item,a=p.item,b=next,ay=a.transform?.[5],by=b?.transform?.[5],height=Math.min(Math.abs(a.height||a.transform?.[3]||10),Math.abs(b?.height||b?.transform?.[3]||10));return {...a,hasEOL:!!b&&Number.isFinite(ay)&&Number.isFinite(by)&&Math.abs(ay-by)>Math.max(2,height*0.35)};}),divs:pairs.map(p=>p.div)};
    }
    function paintCandidate(){
      candidateMarks?.layer?.remove();candidateMarks=null;
      if(!candidatePreview||!pageText||candidatePreview.pageIndex!==pageText.pageIndex||!marksApi()?.paintPage)return;
      const view=layoutView(candidatePreview.segmentId);
      const segment=source?.segments?.find(s=>s.id===candidatePreview.segmentId);
      const location=segment?{text:segment.text,start:candidatePreview.start,end:candidatePreview.end}:null;
      candidateMarks=marksApi().paintPage({document:doc,container:pageText.pageEl,...view,edits:[{id:'candidate-location',before:candidatePreview.before,after:'',enabled:true,location}],side:'before'});
      candidateMarks.layer?.classList.add('paper-candidate-layer');
      pageText.divs.forEach((div,i)=>{if(div?.dataset)div.dataset.i=String(i);});
    }
    async function showCandidate(item,match){
      if(!canLeaveInline())return;closeInline();
      candidatePreview={...match,before:match.before||source?.segments.find(s=>s.id===match.segmentId)?.text.slice(match.start,match.end)||item.before};
      if(page!==match.pageIndex+1)await drawBefore(match.pageIndex+1);else paintCandidate();
      const node=candidateMarks?.layer?.firstElementChild;if(node?.scrollIntoView)node.scrollIntoView({block:'center',behavior:'instant'});
    }
    function updateChangeStatus(){
      if(!changeStatus)return;
      const edits=enabledEdits().filter(e=>e.pageIndex===page-1),missing=(beforeMarks?.missing?.length||0)+(afterMarks?.missing?.length||0);
      changeStatus.textContent=edits.length?'이 쪽 변경 '+edits.length+'개'+(missing?' · 일부 위치는 아래 문장 비교에서 확인':''):'';
    }
    function focusChange(){
      if(!compareFocus)return;
      for(const [stage,marks] of [[ui.beforeStage,beforeMarks],[ui.afterStage,afterMarks]]){
        const node=Array.from(marks?.layer?.children||[]).find(n=>n.dataset.edit===compareFocus);
        if(node&&typeof stage.scrollTo==='function'){const box=node.getBoundingClientRect(),parent=stage.getBoundingClientRect();stage.scrollTo({top:stage.scrollTop+box.top-parent.top-stage.clientHeight/2,left:stage.scrollLeft+box.left-parent.left-stage.clientWidth/2,behavior:'instant'});}
      }
    }
    async function compareEdit(edit){
      if(!canLeaveInline())return;closeInline();compareFocus=edit.id;if(showChanges)showChanges.checked=true;syncChangeVisibility();
      if(page!==edit.pageIndex+1)await drawBefore(edit.pageIndex+1);else{paintBeforeChanges();await drawAfter();}
      focusChange();
    }

    function emit(name,detail){doc.dispatchEvent(new CustomEvent(name,{detail}));}
    function say(node,text,error){if(!node)return;node.textContent=text||'';node.classList.toggle('error',!!error);}
    function setStatus(text,error){say(ui.status,text,error);}
    function setBeforeStatus(text,error){say(ui.beforeStatus,text,error);}
    function setAfterStatus(text,error){say(ui.afterStatus,text,error);}
    function setEditStatus(text,error){say(ui.editStatus,text,error);}
    function setGenStatus(text,error){say(ui.genStatus,text,error);}
    function setDraftStatus(text,error){say(ui.draftStatus,text,error);}
    function setProposalStatus(text,error){say(ui.proposalStatus,text,error);}
    async function sha256Hex(bytes){
      const subtle=deps.subtle||globalThis.crypto?.subtle;
      if(!subtle)throw new Error('해시를 계산할 수 없습니다.');
      return Array.from(new Uint8Array(await subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    }
    function buttons(node){
      const out=[];
      (function walk(n){for(const c of n.children||[]){if(c.tagName==='button'||c.tagName==='BUTTON')out.push(c);walk(c);}})(node);
      return out;
    }
    function wipe(node){
      if(!node)return;
      for(const c of [...(node.children||[])])wipe(c);
      if(String(node.tagName||'').toLowerCase()==='canvas'){node.width=0;node.height=0;}
    }
    function clearStage(stage){if(!stage)return;wipe(stage);stage.replaceChildren();}
    function fieldTarget(target){
      const tag=target&&target.tagName;
      if(tag==='textarea'||tag==='TEXTAREA'||tag==='select'||tag==='SELECT')return true;
      if(tag==='input'||tag==='INPUT')return target.type!=='checkbox'&&target.type!=='button';
      return false;
    }
    function stale(){if(!output)return false;const g=deps.generation||globalThis.FalsifyPaperGeneration;if(output.key&&g?.key){try{return g.key(captureSpec())!==output.key;}catch{return true;}}return !snapshot||snapshot.revision!==output.revision||(output.fontRevision??0)!==fontRevision||(output.externalRevision??0)!==externalRevision;}
    function fontsChanged(){
      fontRevision++;genId++;genCtl?.abort();generating=false;
      scheduleGeneration();renderChrome();
      if(output)setGenStatus('글꼴이 바뀌었습니다. 미리보기를 다시 만드세요.');
    }
    async function importFonts(local){
      const api=fontsApi();if(!api||fontBusy)return;
      // Invoke local-font access directly in the user's click, before any await.
      let pending;
      try{pending=local?api.requestLocalFonts():api.addFiles(ui.fontFiles?.files||[]);}
      catch(e){say(ui.fontStatus,safeMessage(e),true);return;}
      fontBusy=true;renderChrome();say(ui.fontStatus,'글꼴 확인 중…');
      const revision=api.revision;
      try{
        await pending;fontsChanged();
        const count=api.list?.().length||0;
        say(ui.fontStatus,count?count+'개 글꼴 사용 가능 · 원본과 같은 글꼴을 자동으로 찾습니다.':'글꼴 파일을 추가하세요.');
      }catch(e){
        if(api.revision!==revision)fontsChanged();
        say(ui.fontStatus,safeMessage(e),true);
      }finally{fontBusy=false;if(ui.fontFiles)ui.fontFiles.value='';renderChrome();}
    }
    function appendFontRequirements(requirements,edits,pageIndex,found){
        const text=edits.filter(e=>e.pageIndex===pageIndex).map(e=>e.after).join('\n');
        const start=requirements.length;
        for(const p of found?.paragraphs||[])for(const r of p.runs?.length?p.runs:[p]){
          const family=r.fontName||p.fontName||'';
          if(family)requirements.push({family,bold:/bold|semibold|demi|black/i.test(family),italic:/italic|oblique/i.test(family),text});
        }
        if(requirements.length===start)requirements.push({family:'Liberation Serif',text});
    }
    async function resolveFonts(edits,signal){
      const api=fontsApi();if(!api?.resolve)return undefined;
      const requirements=[],current=source,file=current?.file;
      for(const pageIndex of new Set(edits.map(e=>e.pageIndex))){
        if(signal?.aborted)throw new Error('글꼴 적용을 취소했습니다.');
        let found=current.paragraphPages.get(pageIndex);
        if(!found&&paragraphApi()?.inspectPage){
          found=await paragraphApi().inspectPage({file,fileHash:current.fileHash,pageIndex,signal});
          if(source!==current||signal?.aborted)throw new Error('논문이 바뀌어 글꼴 적용을 취소했습니다.');
          current.paragraphPages.set(pageIndex,found);
        }
        appendFontRequirements(requirements,edits,pageIndex,found);
      }
      const result=await api.resolve(requirements);
      if(source!==current||signal?.aborted)throw new Error('논문이 바뀌어 글꼴 적용을 취소했습니다.');
      return result;
    }
    function enabledEdits(){return (snapshot&&snapshot.edits||[]).filter(e=>e&&e.enabled!==false).concat(external?external.edits():[]);}
    function draftKey(){return source&&source.fileHash?'falsify.paper-draft.v1.'+source.fileHash:null;}

    function paintIcon(node,name){
      if(!node||typeof doc.createElementNS!=='function'||buttons(node).length&&node.querySelector)return;
      if(typeof node.querySelector==='function'&&node.querySelector('svg'))return;
      try{
        const svg=doc.createElementNS(SVG,'svg'),use=doc.createElementNS(SVG,'use');
        svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
        use.setAttribute('href','./vendor/lucide.svg#'+name);svg.append(use);node.prepend(svg);
      }catch{/* the text label remains */}
    }
    function handFocus(active,disabled,alt){
      if(active===disabled&&disabled.disabled&&alt&&!alt.disabled)alt.focus();
    }
    function syncZoom(){
      const zi=ZOOMS.indexOf(zoom);
      ui.zoomOut.disabled=!source||!source.doc||zi<=0;
      ui.zoomIn.disabled=!source||!source.doc||zi<0||zi>=ZOOMS.length-1;
      ui.zoomLabel.textContent=Math.round(zoom*100)+'%';
      handFocus(doc.activeElement,ui.zoomIn,ui.zoomOut);handFocus(doc.activeElement,ui.zoomOut,ui.zoomIn);
    }
    function syncNav(){
      ui.prev.disabled=!(pages>1&&page>1);
      ui.next.disabled=!(pages>1&&page<pages);
      ui.pageLabel.textContent=pages?page+' / '+pages+'쪽':'';
      ui.pageJump.disabled=!pages;
      ui.pageJump.max=pages||1;
      if(doc.activeElement!==ui.pageJump)ui.pageJump.value=pages?String(page):'';
      const active=doc.activeElement;
      handFocus(active,ui.next,ui.prev);handFocus(active,ui.prev,ui.next);
      if((doc.activeElement===ui.prev||doc.activeElement===ui.next)&&ui.prev.disabled&&ui.next.disabled)ui.beforeStage.focus();
      syncZoom();
    }
    const diagnosticPanel=doc.createElement('div');ui.genStatus.after(diagnosticPanel);
    const confirmedChecks=new Set(['figure-changed','untouched-text','page-count','removed-before','unchanged-output','glyph-overlap-increased','header-footer-moved','header-footer-style-changed']);
    function diagnosticKind(item){
      if(!item||typeof item!=='object')return '';
      const code=String(item.code||'').toLowerCase().replace(/_/g,'-');
      if(/unverified|uncomputable|unavailable|ambiguous|unknown/.test(code))return '미확인';
      if(item.status==='failed')return confirmedChecks.has(code)?'확인된 문제':'검사 결과 확인 필요';
      return '';
    }
    function diagnosticTarget(item){
      const id=item.editId||item.id,edit=(output?.edits||[]).find(e=>e.id===id);
      const index=Number.isSafeInteger(edit?.pageIndex)?edit.pageIndex:item.pageIndex;
      if(!Number.isSafeInteger(index)||index<0||index>=pages)return null;
      return {index,edit};
    }
    function addDiagnosticAction(item,kind){
      const target=diagnosticTarget(item),row=doc.createElement('div');
      const code=String(item.code||'').toLowerCase().replace(/_/g,'-');
      row.textContent=kind+' · '+(CAUSE_TEXT[code]||'검사 결과를 확인하세요');
      if(target){const button=doc.createElement('button');button.type='button';button.className='text-button';button.textContent=(target.index+1)+'쪽 확인';
        button.addEventListener('click',()=>{if(target.edit)void compareEdit(target.edit);else if(canLeaveInline())void drawBefore(target.index+1);});row.append(button);}
      diagnosticPanel.append(row);
    }
    function renderDiagnostics(){
      diagnosticPanel.replaceChildren();if(!output||output.blocked)return;
      const items=diagnosticItems(output.warnings,output.verification),seen=new Set();
      for(const item of items){const kind=diagnosticKind(item),key=JSON.stringify(item);if(!kind||seen.has(key))continue;seen.add(key);addDiagnosticAction(item,kind);}
      if(!items.length)return;
      const details=doc.createElement('details'),summary=doc.createElement('summary'),raw=doc.createElement('pre');
      summary.textContent='검사 상세';raw.textContent=JSON.stringify({warnings:output.warnings,verification:output.verification},null,2);details.append(summary,raw);diagnosticPanel.append(details);
    }
    function renderOutputNotes(){
      if(ui.outputNotes){
        const v=output?.verification, final=Array.isArray(v?.stages)?v.stages.at(-1)?.verification:v, counts=final?.pageCount;
        const countText=Number.isSafeInteger(counts?.source)&&counts.source===pages&&Number.isSafeInteger(counts.output)&&counts.output>0?' · 원본 '+counts.source+'쪽 → 출력 '+counts.output+'쪽':'';
        ui.outputNotes.textContent=output&&!output.blocked?('생성 방식: '+(output.recomposition?'전체 논문 새로 배치':'원본에서 선택 구간 편집')+countText+(generationApi()?'':' '+diagnosticText(output.warnings,output.verification))).trim():'';
      }
    }
    function renderPreviousDownload(blocked){
      lastDownload.hidden=!generationApi()||blocked||(!stale()&&!generationFailed);
      const time=outputAt?' · '+new Date(outputAt).toLocaleString():'';
      lastDownload.textContent='이전 생성본 다운로드'+time+(generationFailed?' · 최근 생성 실패':' · 현재 편집과 다름');
    }
    function renderDownloadControls(blocked){
      ui.current.disabled=generationApi()?!(source&&source.pdf&&source.fileHash):blocked;
      ui.current.textContent=generationApi()?'현재 파일 다운로드':output&&stale()?'마지막 생성본 다운로드':'현재 생성본 다운로드';
      if(typeof lastDownload!=='undefined')renderPreviousDownload(blocked);
      ui.team.disabled=blocked;
      ui.blue.disabled=generationApi()?!(source&&source.pdf&&source.fileHash):blocked;
    }
    function renderOutputChrome(){
      const blocked=!output||output.blocked;
      renderDownloadControls(blocked);
      ui.hash.textContent=output&&!output.blocked?'SHA-256 '+output.sha256:'';
      renderOutputNotes();
      renderDiagnostics();
      ui.afterLabel.textContent=!output?'아직 생성본이 없습니다':stale()?'마지막 생성본 · 현재 편집과 다름':'현재 생성본';
    }
    function renderDraftControls(ready){
      ui.draftSave.disabled=!(ui.draftOpt.checked&&session&&ready);
      const hasDraft=!!draftRaw||readIndex().length>0;
      ui.draftRestore.hidden=!hasDraft;
      ui.draftDelete.disabled=!hasDraft;
    }
    function renderModuleNotes(pdf){
      ui.coreNote.textContent=editsApi()?'':'편집 코어가 아직 없습니다. 쪽 보기와 원본 다운로드는 사용할 수 있지만 편집은 저장되지 않습니다.';
      ui.exportNote.textContent=!pdf&&source?'PDF가 아니라 브라우저에서 생성본을 만들지 않습니다.':exporterApi()?'':'브라우저 PDF 편집 모듈이 아직 없습니다. 생성본을 만들지 않으며, 성공으로 표시하지 않습니다.';
    }
    function renderGenerateControl(pdf){
      ui.generate.disabled=generating||fontBusy||!exporterApi()||!pdf||(!enabledEdits().length&&!(directEditor&&inline&&directEditor.value!==inline.after));
      if(ui.generateCancel)ui.generateCancel.hidden=!generating;
    }
    function renderEditingChrome(pdf,ready){
      ui.original.disabled=!source;
      if(ui.fontLocal)ui.fontLocal.disabled=fontBusy||!fontsApi();
      if(ui.fontAdd)ui.fontAdd.disabled=fontBusy||!fontsApi();
      ui.modeTable.disabled=!pdf||!ready||!source.doc||!tableApi();
      renderModuleNotes(pdf);
      renderGenerateControl(pdf);
    }
    function renderChrome(){
      const pdf=!!(source&&source.pdf),ready=!!(source&&source.fileHash);
      renderEditingChrome(pdf,ready);
      renderDraftControls(ready);
      renderOutputChrome();
      syncNav();
    }
    function placeInline(){
      ui.inline.classList.remove('is-open','is-docked');
      if(!inline)return;
      ui.inline.classList.add('is-open');ui.inline.classList.add('is-docked');
    }
    function canLeaveInline(){
      if(directEditor&&inline){commitDirect();return !inline;}
      if(!inline||ui.inlineAfter.value===inline.after)return true;
      const message='입력한 내용을 적용하거나 「닫기」로 취소한 뒤 다른 구간을 선택하세요.';
      ui.inlineMeta.textContent=message;
      ui.inlineAfter.focus();
      return false;
    }
    function renderInline(){
      ui.inline.hidden=!inline;
      if(!inline){ui.inlineBefore.textContent='';ui.inlineMeta.textContent='';ui.inlineAfter.value='';placeInline();return;}
      ui.inlineBefore.textContent=inline.before;
      ui.inlineAfter.value=typeof inline.after==='string'?inline.after:'';
      ui.inlineMeta.textContent=(inline.pageIndex+1)+'쪽 · 선택한 구간';
      placeInline();
    }
    function focusInline(){
      if(globalThis.matchMedia?.('(max-width: 700px)').matches)ui.inline.scrollIntoView?.({block:'start'});
      ui.inlineAfter.focus();
    }
    function segmentFor(before,anchor,pageIndex){
      const all=coreSegments(source&&source.segments).filter(s=>segmentPage(s)===pageIndex);
      // Paragraph discovery must not make a previously unique word selection ambiguous.
      // Keep the original extraction catalog as the first binding choice for selection edits.
      for(const segs of [all.filter(s=>!sourceAlias(s.id)),all.filter(s=>s.id.startsWith('paragraph:'))]){
        if(anchor&&Number.isSafeInteger(anchor.start)&&Number.isSafeInteger(anchor.end)&&anchor.end===anchor.start+before.length){
          const exact=segs.filter(s=>s.text.slice(anchor.start,anchor.end)===before);
          if(exact.length===1)return exact[0];
        }
        const unique=segs.filter(s=>hitsIn(s.text,before).length===1);
        if(unique.length===1)return unique[0];
        if(unique.length>1)return null;
      }
      return null;
    }
    function renderEditRow(edit){
        const li=doc.createElement('li');
        const jump=doc.createElement('button');jump.type='button';jump.className='button secondary';jump.dataset.edit=edit.id;jump.dataset.act='edit';
        jump.textContent='쪽 '+(Number(edit.pageIndex)+1)+' · '+String(edit.before||'').slice(0,40)+' → '+String(edit.after||'').slice(0,40);
        const toggle=doc.createElement('button');toggle.type='button';toggle.className='button secondary';toggle.dataset.edit=edit.id;toggle.dataset.act='toggle';
        toggle.textContent=edit.enabled===false?'켜기':'끄기';toggle.setAttribute('aria-pressed',String(edit.enabled!==false));
        const del=doc.createElement('button');del.type='button';del.className='button secondary';del.dataset.edit=edit.id;del.dataset.act='delete';del.textContent='삭제';
        const note=doc.createElement('span');note.className='paper-edit-origin';note.textContent=originText(edit.origin,modelById.get(edit.id));
        const cause=editCause(edit.id);
        const compare=doc.createElement('button');compare.type='button';compare.className='button secondary';compare.dataset.edit=edit.id;compare.dataset.act='compare';compare.textContent='비교';compare.addEventListener('click',()=>void compareEdit(edit));
        jump.addEventListener('click',()=>loadInline(edit));
        toggle.addEventListener('click',()=>{if(session)session.setEnabled(edit.id,edit.enabled===false);});
        del.addEventListener('click',()=>onDelete(edit));
        li.append(jump,compare,toggle,del,note);if(cause)li.append(cause);ui.edits.append(li);
    }
    function restoreEditFocus(keep){
      if(keep&&keep.act==='undo')ui.undo.focus();
      else if(keep&&keep.id){
        const found=buttons(ui.edits).find(b=>b.dataset.edit===keep.id&&(!keep.act||b.dataset.act===keep.act))||buttons(ui.edits).find(b=>b.dataset.edit===keep.id);
        if(found)found.focus();else ui.undo.focus();
      }
    }
    function renderEdits(){
      const active=doc.activeElement;
      const keep=!pendingFocus&&active&&ui.edits.contains&&ui.edits.contains(active)?{id:active.dataset&&active.dataset.edit,act:active.dataset&&active.dataset.act}:pendingFocus;
      pendingFocus=null;
      ui.edits.replaceChildren();
      const edits=snapshot&&snapshot.edits||[];
      if(!edits.length){const li=doc.createElement('li');li.textContent='아직 편집이 없습니다.';ui.edits.append(li);}
      for(const edit of edits)renderEditRow(edit);
      ui.undo.disabled=!snapshot||!snapshot.canUndo;
      ui.redo.disabled=!snapshot||!snapshot.canRedo;
      restoreEditFocus(keep);
      renderChrome();
    }
    function collectEditWarnings(id,verification,add){
      const warnings=[];
      if(Array.isArray(output.warnings))warnings.push(...output.warnings);
      if(verification&&Array.isArray(verification.warnings))warnings.push(...verification.warnings);
      for(const item of warnings){if(!item||typeof item!=='object'||item.editId!==id)continue;add(causePhrase(item),false);}
    }
    function collectEditCauses(id,verification,add){
      collectEditWarnings(id,verification,add);
      const rows=verification&&Array.isArray(verification.edits)?verification.edits.filter(row=>row&&row.id===id):[];
      const failed=rows.some(row=>row.status==='failed');
      const checks=[];
      if(verification&&Array.isArray(verification.checks))checks.push(...verification.checks);
      for(const row of rows)if(Array.isArray(row.checks))checks.push(...row.checks);
      for(const item of checks){if(!item||typeof item!=='object'||item.id!==id)continue;add(causePhrase(item),item.status==='failed');}
      return failed;
    }
    function editCause(id){
      if(!output||output.blocked||!id)return null;
      const verification=output.verification,phrases=[];let failed=false;
      const add=(phrase,isFailed)=>{if(!phrase||phrases.includes(phrase)||phrases.length>=4)return;phrases.push(phrase);if(isFailed)failed=true;};
      if(collectEditCauses(id,verification,add))failed=true;
      if(!phrases.length)return null;
      const span=doc.createElement('span');span.className=failed?'paper-edit-cause is-failed':'paper-edit-cause';
      const status=verification&&typeof verification.status==='string'?verification.status:'';
      span.textContent=(status==='failed'||status==='warning'?'검증 '+status:'검증')+' · '+phrases.join(' · ');
      return span;
    }
    function paintProposals(){
      const queue=proposalQueue;
      if(external){paintExternal();return;}
      ui.proposals.hidden=!queue||!queue.proposals.length;
      ui.proposalList.replaceChildren();
      if(!queue)return;
      const classified=classifyProposals(queue.proposals,source&&source.segments||[],{origin:queue.origin,model:queue.model});
      classified.items.forEach((item,index)=>{
        const li=doc.createElement('li'),title=doc.createElement('span');
        title.textContent=originText(queue.origin,queue.model)+(item.status==='matched'?' · 한 곳':' · '+item.reason);
        const accept=doc.createElement('button');accept.type='button';accept.className='button secondary';accept.textContent='이 제안 받아들이기';
        accept.disabled=item.status!=='matched'||accepted.has(index);
        accept.addEventListener('click',()=>{if(!accept.disabled)acceptOne(index);});
        const body=doc.createElement('p');body.textContent=String(item.before||'').slice(0,80)+' → '+String(item.after||'').slice(0,80);
        li.append(title,body,accept);ui.proposalList.append(li);
      });
    }
    function bindSuggested(item,match,actual){
      try{
        const binding={segmentId:match.segmentId,pageIndex:match.pageIndex,before:actual,anchor:{start:match.start,end:match.end}};
        external.bind(item.id,binding);const rows=external.snapshot().items,index=rows.findIndex(x=>x.id===item.id),bound=rows[index],conflicts=selectionConflicts(bound);
        if(conflicts.length){showSelectionConflict(ui.proposalList.children[index],bound,conflicts);return;}
        external.setEnabled(item.id,true);candidatePreview=null;candidateMarks?.layer?.remove();candidateMarks=null;paintBeforeChanges();
      }catch(e){setProposalStatus(safeMessage(e),true);}
    }
    function selectionConflicts(item){
      const manual=(snapshot?.edits||[]).filter(e=>e.enabled!==false&&aliasesOverlap(item,e));
      const proposals=(external?.edits()||[]).filter(e=>aliasesOverlap(item,e));
      return [...manual.map(edit=>({kind:'manual',edit})),...proposals.map(edit=>({kind:'proposal',edit}))];
    }
    function conflictDescription(host,title,edit){
      const heading=doc.createElement('strong'),before=doc.createElement('p'),after=doc.createElement('p');
      heading.textContent=title+' · '+originText(edit.origin)+(Array.isArray(edit.sourceRefs)?' · 출처 '+edit.sourceRefs.length+'개':'');before.textContent='Before: '+edit.before;after.textContent='After: '+edit.after;host.append(heading,before,after);
    }
    function showSelectionConflict(host,item,conflicts){
      for(const child of [...host.children])if(child.className==='paper-selection-conflict')child.remove();
      const box=doc.createElement('div'),replace=doc.createElement('button'),keep=doc.createElement('button');box.className='paper-selection-conflict';
      setProposalStatus('기존 변경과 겹칩니다. 비교하고 선택하세요.');
      conflictDescription(box,'선택하려는 제안',item);
      for(const c of conflicts)conflictDescription(box,c.kind==='manual'?'기존 직접 편집':'기존 제안',c.edit);
      replace.type=keep.type='button';replace.className=keep.className='button secondary';replace.textContent='기존 변경을 이 제안으로 교체';keep.textContent='기존 변경 유지';
      replace.addEventListener('click',()=>replaceSelection(item,conflicts));keep.addEventListener('click',()=>box.remove());box.append(replace,keep);host.append(box);
    }
    function selectionChanges(item,conflicts){
      return [...conflicts.filter(c=>c.kind==='proposal').map(c=>({id:c.edit.id,enabled:false})),{id:item.id,enabled:true}];
    }
    function selectionAllowed(items,manual){
      const active=items.filter(x=>x.enabled&&x.anchor);
      for(const item of active){if(manual.some(e=>e.enabled!==false&&aliasesOverlap(item,e)))return false;}
      for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)if(aliasesOverlap(active[i],active[j]))return false;
      return true;
    }
    function publishSelection(){paintExternal();paintBeforeChanges();renderChrome();queueDraft();scheduleGeneration();emit('falsify:paper-external-responses',published(external.snapshot()));}
    function replaceSelection(item,shown){
      try{
        const current=external.snapshot().items.find(x=>x.id===item.id),conflicts=selectionConflicts(current);
        if(!current||JSON.stringify(current)!==JSON.stringify(item)||JSON.stringify(conflicts)!==JSON.stringify(shown))throw Error('충돌이 바뀌었습니다. 다시 선택하세요.');
        if(!session?.disableBatch||!session?.historyTarget)throw Error('편집 기록을 사용할 수 없습니다.');
        const changes=selectionChanges(current,conflicts),before=changes.map(c=>({id:c.id,enabled:!!external.snapshot().items.find(x=>x.id===c.id)?.enabled}));
        const planned=external.validateSelection(changes),ids=conflicts.filter(c=>c.kind==='manual').map(c=>c.edit.id);
        const remaining=(snapshot?.edits||[]).map(e=>ids.includes(e.id)?{...e,enabled:false}:e);
        if(!selectionAllowed(planned,remaining))throw Error('다른 편집과 겹칩니다.');
        const previous=snapshot.revision;atomicSelection=true;
        try{external.setSelection(changes);externalRevision++;session.disableBatch(ids);}catch(e){external.setSelection(before);externalRevision++;throw e;}finally{atomicSelection=false;}
        selectionHistory.set(snapshot.revision,{previous,before,after:changes});publishSelection();
      }catch(e){setProposalStatus(safeMessage(e),true);}
    }
    function historyAction(direction){
      if(!session||!snapshot)return;
      try{
        const target=session.historyTarget?.(direction),transition=direction==='undo'?selectionHistory.get(snapshot.revision):selectionHistory.get(target?.revision);
        if(!target||!transition){session[direction]();return;}
        const changes=direction==='undo'?transition.before:transition.after,rollback=changes.map(c=>({id:c.id,enabled:!!external.snapshot().items.find(x=>x.id===c.id)?.enabled}));
        const planned=external.validateSelection(changes);if(!selectionAllowed(planned,target.edits))throw Error('다른 선택과 겹쳐 실행 취소할 수 없습니다.');
        atomicSelection=true;try{external.setSelection(changes);externalRevision++;session[direction]();}catch(e){external.setSelection(rollback);externalRevision++;throw e;}finally{atomicSelection=false;}publishSelection();
      }catch(e){setEditStatus(safeMessage(e),true);}
    }
    function manualOptions(select,before){
      const empty=doc.createElement('option');empty.value='';empty.textContent='원문 위치 선택';select.replaceChildren(empty);
      if(!before)return;
      for(const seg of externalSegments(source?.segments||[])){
        let at=-1;while((at=seg.text.indexOf(before,at+1))>=0){
          const option=doc.createElement('option'),end=at+before.length,left=seg.text.slice(Math.max(0,at-45),at),right=seg.text.slice(end,Math.min(seg.text.length,end+45));
          const context=(left+'【'+before+'】'+right).replace(/\s+/g,' ');
          option.value=JSON.stringify({segmentId:seg.id,pageIndex:segmentPage(seg),before,anchor:{start:at,end}});
          option.textContent=(segmentPage(seg)+1)+'쪽 · '+context;select.append(option);
        }
      }
    }
    function manualLocation(item,host){
      const select=doc.createElement('select'),before=doc.createElement('input'),search=doc.createElement('button');
      before.value=item.before||'';before.setAttribute('aria-label','연결할 원문');select.setAttribute('aria-label','원문 위치 선택');search.type='button';search.textContent='원문 찾기';
      manualOptions(select,before.value);search.addEventListener('click',()=>manualOptions(select,before.value));
      select.addEventListener('change',()=>{try{if(!select.value)return;const binding=JSON.parse(select.value);void showCandidate(item,{...binding,start:binding.anchor.start,end:binding.anchor.end});external.bind(item.id,binding);setProposalStatus('원문을 연결했습니다. 적용하려면 제안을 선택하세요.');}catch(e){setProposalStatus(safeMessage(e),true);}});
      const manual=doc.createElement('details'),heading=doc.createElement('summary');heading.textContent='원문에서 직접 찾기';manual.append(heading,before,search,select);host.append(manual);
    }
    function paintExternal(){
      const rows=external.snapshot().items;proposalInputs=new Map();ui.proposals.hidden=!rows.length;ui.proposalList.replaceChildren();
      for(const item of rows){
        const li=doc.createElement('li'),label=doc.createElement('label'),check=doc.createElement('input'),body=doc.createElement('span'),after=doc.createElement('textarea');
        check.type='checkbox';check.checked=!!item.enabled;check.disabled=item.matchStatus!=='matched';
        body.textContent=(item.matchStatus==='matched'?(item.enabled?'원문 연결 · 선택됨':'원문 연결 · 선택 안 됨'):item.matches?.length?'이 부분인가요?':'원문 위치 선택')+' · '+String(item.before||'')+' → ';after.value=typeof item.after==='string'?item.after:'';proposalInputs.set(item.id,after);after.setAttribute('aria-label','제안 수정');
        check.addEventListener('change',()=>{try{if(check.checked){const current=external.snapshot().items.find(x=>x.id===item.id),conflicts=selectionConflicts(current);if(conflicts.length){check.checked=false;showSelectionConflict(li,current,conflicts);return;}}external.setEnabled(item.id,check.checked);}catch(e){check.checked=false;setProposalStatus(safeMessage(e),true);}});
        let composing=false;const saveAfter=()=>{try{suppressExternalPaint=true;external.update(item.id,{after:after.value});}catch(e){setProposalStatus(safeMessage(e),true);}finally{suppressExternalPaint=false;paintBeforeChanges();}};after.addEventListener('input',()=>{queueDraft();if(!composing)saveAfter();});after.addEventListener('compositionstart',()=>{composing=true;});after.addEventListener('compositionend',()=>{composing=false;saveAfter();});after.addEventListener('change',saveAfter);
        label.append(check,body);li.append(label,after);
        if(item.matches?.length&&item.matchStatus!=='matched'){
          const candidates=item.matches.filter(m=>source.segments.some(s=>s.id===m.segmentId&&Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start>=0&&m.end>m.start&&m.end<=s.text.length));
          const addCandidate=(host,m)=>{
            const actual=source.segments.find(s=>s.id===m.segmentId).text.slice(m.start,m.end),box=doc.createElement('div'),where=doc.createElement('p'),quote=doc.createElement('blockquote'),show=doc.createElement('button'),apply=doc.createElement('button');
            box.className='paper-location-candidate';where.textContent=(m.pageIndex+1)+'쪽';quote.textContent=actual;show.type=apply.type='button';show.className='text-button';apply.className='button secondary';show.textContent='PDF에서 보기';apply.textContent='이 부분 수정';
            show.addEventListener('click',()=>void showCandidate(item,{...m,before:actual}));
            apply.addEventListener('click',()=>bindSuggested(item,m,actual));
            box.append(where,quote,show,apply);host.append(box);
          };
          if(candidates.length){addCandidate(li,candidates[0]);if(!candidatePreview)void showCandidate(item,candidates[0]);}
          if(candidates.length>1){const more=doc.createElement('details'),title=doc.createElement('summary');title.textContent='다른 후보 '+(candidates.length-1)+'곳';more.append(title);candidates.slice(1).forEach(m=>addCandidate(more,m));li.append(more);}
        }
        if(item.matchStatus!=='matched')manualLocation(item,li);
        const provenance=doc.createElement('small'),combineCheck=doc.createElement('input'),combineLabel=doc.createElement('label');provenance.textContent='출처 '+item.sourceRefs.length+'개';combineCheck.type='checkbox';combineCheck.checked=combineIds.has(item.id);combineCheck.addEventListener('change',()=>{if(combineCheck.checked)combineIds.add(item.id);else combineIds.delete(item.id);});const combineText=doc.createElement('span');combineText.textContent=' 결합할 제안';combineLabel.append(combineCheck,combineText);li.append(provenance,combineLabel);ui.proposalList.append(li);
      }
      if(rows.length>=2){
        const li=doc.createElement('li'),before=doc.createElement('input'),after=doc.createElement('textarea'),find=doc.createElement('button'),select=doc.createElement('select'),combine=doc.createElement('button');
        before.setAttribute('aria-label','결합 대안의 원문');after.setAttribute('aria-label','결합 대안의 수정문');find.type=combine.type='button';find.textContent='결합 원문 찾기';combine.textContent='선택한 제안 결합';
        find.addEventListener('click',()=>{select.replaceChildren();if(!before.value)return;for(const seg of externalSegments(source?.segments||[])){let pos=-1;while((pos=seg.text.indexOf(before.value,pos+1))>=0){const o=doc.createElement('option');o.value=JSON.stringify({segmentId:seg.id,pageIndex:segmentPage(seg),before:before.value,anchor:{start:pos,end:pos+before.value.length}});o.textContent=(segmentPage(seg)+1)+'쪽 · '+seg.id+' @ '+pos;select.append(o);}}});
        combine.addEventListener('click',()=>{try{if(combineIds.size<2||!select.value)throw Error('두 제안과 원문 위치를 선택하세요.');const fields={...JSON.parse(select.value),after:after.value};external.combine([...combineIds],fields);combineIds.clear();paintExternal();}catch(e){setProposalStatus(safeMessage(e),true);}});
        const details=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='제안 결합 (선택 사항)';details.append(summary,before,find,select,after,combine);li.append(details);ui.proposalList.append(li);
      }
    }
    function queueDraft(){if(!ui.draftOpt.checked)return;if(draftTimer)timers.clearTimeout(draftTimer);draftTimer=timers.setTimeout(()=>{draftTimer=null;void saveDraft();},700);}
    function acceptExternalResponse(batch){
      if(!source?.fileHash)throw Error('원본을 먼저 선택하세요.');
      const api=deps.externalProposals||globalThis.FalsifyExternalProposals;if(!api?.create)throw Error('제안 모듈이 없습니다.');
      if(!external){external=api.create({fileHash:source.fileHash,role:'red',segments:externalSegments(source.segments)});external.subscribe(value=>{if(atomicSelection)return;externalRevision++;abortGen();if(!suppressExternalPaint){paintExternal();paintBeforeChanges();}renderChrome();queueDraft();scheduleGeneration();emit('falsify:paper-external-responses',published(value));});}
      return external.append(batch);
    }
    function disableConflictingProposals(changed,snap){if(changed&&external){for(const item of external.snapshot().items.filter(x=>x.enabled&&x.anchor)){const conflict=(snap.edits||[]).some(e=>e.enabled!==false&&e.segmentId===item.segmentId&&e.anchor.start<item.anchor.end&&item.anchor.start<e.anchor.end);if(conflict||crossAliasOverlap(item)){external.setEnabled(item.id,false);setProposalStatus('직접 편집과 겹치는 제안을 해제했습니다. 기존 편집을 끄고 다시 선택하세요.',true);}}}}
    function onSnapshot(snap){
      try{
        const changed=snapshot&&snapshot.revision!==snap.revision;
        snapshot=snap;disableConflictingProposals(changed,snap);if(changed&&inline?.editId&&!(snap.edits||[]).some(e=>e.id===inline.editId))closeInline();
        if(changed){clearTables(true);if(editMode==='table'&&pageText)void inspectTables(pageText,epoch,drawSeq);}
        if(changed){queueDraft();scheduleGeneration();}const copy=published(snap);if(copy)emit('falsify:paper-workspace-edits',copy);renderEdits();paintProposals();paintBeforeChanges();
      }catch(e){setEditStatus('편집 목록을 그리지 못했습니다. '+safeMessage(e),true);}
    }
    function watchSession(next){
      if(typeof unsub==='function')unsub();
      if(session!==next)selectionHistory=new Map();session=next;
      unsub=session&&typeof session.subscribe==='function'?session.subscribe(snap=>{try{onSnapshot(snap);}catch(e){setEditStatus('편집 목록을 그리지 못했습니다. '+safeMessage(e),true);}}):null;
    }
    function ensureSession(force){
      const api=editsApi();
      if(!api||typeof api.create!=='function'||!source||!source.fileHash)return;
      const hasEdits=snapshot&&Array.isArray(snapshot.edits)&&snapshot.edits.length;
      if(session&&!force)return;
      if(session&&hasEdits)return;
      try{
        watchSession(api.create({fileHash:source.fileHash,name:sessionName(source.name),segments:coreSegments(source.segments),now:now()}));
        onSnapshot(typeof session.snapshot==='function'?session.snapshot():{schema:'falsify.paper-edits.v1',fileHash:source.fileHash,name:sessionName(source.name),revision:0,edits:[],canUndo:false,canRedo:false});
      }catch(e){session=null;snapshot=null;setEditStatus('편집 코어가 세션을 만들지 않았습니다. '+safeMessage(e),true);}
    }
    function adoptSegments(raw,matchSegments){
      if(!source)return;
      const layoutSegments=Array.isArray(matchSegments)?published(matchSegments)||[]:source.layoutSegments||[];
      const paragraphs=(source.segments||[]).filter(s=>sourceAlias(s.id));
      const layouts=coreSegments(layoutSegments);
      const nextSegments=coreSegments(raw).filter(s=>!paragraphs.some(p=>p.id===s.id)).concat(paragraphs).filter(s=>!layouts.some(p=>p.id===s.id)).concat(layouts);
      if(session&&typeof session.addSegments==='function'){
        try{session.addSegments(coreSegments(nextSegments));}
        catch(e){setEditStatus('새 원문 구간을 연결하지 못했습니다. '+safeMessage(e),true);return;}
      }
      source.layoutSegments=layoutSegments;source.segments=nextSegments;
      if(pendingResume){applyResume(pendingResume);if(source.fileHash)emit('falsify:paper-workspace-source',{fileHash:source.fileHash,name:source.name});paintProposals();return;}
      ensureSession(!(snapshot&&snapshot.edits&&snapshot.edits.length));
      if(source.fileHash)emit('falsify:paper-workspace-source',{fileHash:source.fileHash,name:source.name});
      paintProposals();
    }
    function stopPdf(){
      clearTables(true);
      drawSeq++;
      if(loadTimer!==null){timers.clearTimeout(loadTimer);loadTimer=null;}
      if(resumeCtl){resumeCtl.abort();resumeCtl=null;}
      if(inspectCtl){inspectCtl.abort();inspectCtl=null;}
      try{source&&source.render&&source.render.cancel&&source.render.cancel();}catch{}
      try{textLayerHandle&&textLayerHandle.cancel&&textLayerHandle.cancel();}catch{}
      try{loadTask&&loadTask.destroy&&loadTask.destroy();}catch{}
      loadTask=null;textLayerHandle=null;
      if(source){source.doc=null;source.render=null;}
    }
    function releaseAfter(){
      try{afterRender&&afterRender.cancel&&afterRender.cancel();}catch{}
      try{if(afterCacheKey&&afterCache)afterCache.release(afterCacheKey);else afterTask&&afterTask.destroy&&afterTask.destroy();}catch{}
      afterCacheKey=null;afterTask=null;afterRender=null;
    }
    function closeAfter(){afterSeq++;releaseAfter();afterCache?.dispose();afterCache=null;generatorVersion++;generator?.dispose();generator=null;afterNav.hidden=true;}
    function abortGen(){genId++;if(genCtl){genCtl.abort();genCtl=null;}generating=false;}
    function clearSource(){
      if(draftTimer){timers.clearTimeout(draftTimer);draftTimer=null;}
      epoch++;tableBindings.clear();abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      if(directEditor){const editor=directEditor;directEditor=null;composingDirect=false;editor.remove();}removeDirectControls();
      unsub=null;session=null;snapshot=null;output=null;outputAt=null;generationFailed=false;inline=null;pageText=null;external=null;externalRevision=0;selectionHistory=new Map();combineIds=new Set();proposalQueue=null;accepted=new Set();draftRaw=null;pendingResume=null;beforeMarks=afterMarks=null;candidatePreview=null;candidateMarks=null;compareFocus=null;updateChangeStatus();
      source=null;pages=0;page=1;zoom=1;
      clearStage(ui.beforeStage);clearStage(ui.afterStage);
      renderInline();renderEdits();paintProposals();renderChrome();
      setStatus('');setBeforeStatus('');setAfterStatus('');setGenStatus('');setEditStatus('');setProposalStatus('');say(ui.tableStatus,'');
      emit('falsify:paper-workspace-source',{fileHash:null,name:''});
      remindDraft();
    }
    function lookDraft(){
      draftRaw=null;
      const key=draftKey(),box=store();
      if(!key||!box){renderChrome();return;}
      try{draftRaw=box.getItem(key)||null;}catch{draftRaw=null;}
      if(draftRaw)setDraftStatus('이 파일의 초안이 있습니다. 복구는 직접 눌렀을 때만, 12시간 검사를 거친 뒤에 됩니다. 초안에는 편집만 있습니다.');
      else remindDraft();
      renderChrome();
    }
    function readIndex(){
      const box=store();if(!box)return [];
      try{
        const rows=JSON.parse(box.getItem(DRAFT_INDEX)||'[]');
        return Array.isArray(rows)?rows.filter(row=>row&&typeof row.fileHash==='string'&&row.fileHash.length===64&&typeof row.expiresAt==='number'&&row.expiresAt>now()):[];
      }catch{return [];}
    }
    function writeIndex(rows){
      const box=store();if(!box)return;
      const live=(rows||[]).filter(row=>row&&row.expiresAt>now()).map(row=>({fileHash:row.fileHash,name:sessionName(row.name),expiresAt:row.expiresAt,source:row.source===true}));
      try{if(live.length)box.setItem(DRAFT_INDEX,JSON.stringify(live));else box.removeItem(DRAFT_INDEX);}catch{}
    }
    function remindDraft(){
      const row=readIndex().find(item=>!source||item.fileHash!==source.fileHash);
      if(!row)return;
      setDraftStatus(row.source?'보관한 '+row.name+' 초안과 원본 PDF가 있습니다. 초안 복구를 누르면 이 브라우저에서 다시 엽니다.':'초안에는 편집만 있습니다. 이름이 '+row.name+' 이고 해시가 '+row.fileHash.slice(0,12)+'… 인 원본 PDF를 다시 선택한 뒤 초안 복구를 누르세요. 서버로 올리지 않습니다.');
    }
    async function openFile(file){
      if(draftTimer){timers.clearTimeout(draftTimer);draftTimer=null;}
      const mine=++epoch;tableBindings.clear();
      abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      if(directEditor){const editor=directEditor;directEditor=null;composingDirect=false;editor.remove();}removeDirectControls();
      unsub=null;session=null;snapshot=null;output=null;outputAt=null;generationFailed=false;inline=null;pageText=null;external=null;externalRevision=0;selectionHistory=new Map();combineIds=new Set();proposalQueue=null;accepted=new Set();draftRaw=null;pendingResume=null;beforeMarks=afterMarks=null;candidatePreview=null;candidateMarks=null;compareFocus=null;updateChangeStatus();
      pages=0;page=1;zoom=1;
      source={file,fileHash:null,name:sessionName(file.name),segments:[],pdf:isPdf(file),doc:null,lib:null,render:null,paragraphPages:new Map()};
      clearStage(ui.beforeStage);clearStage(ui.afterStage);renderInline();renderEdits();paintProposals();renderChrome();
      setGenStatus('');setEditStatus('');setProposalStatus('');say(ui.tableStatus,'');setBeforeStatus('');setAfterStatus('');
      setStatus('원본 파일을 확인하는 중입니다.');
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(epoch!==mine)return;
        const hash=await sha256Hex(bytes);
        if(epoch!==mine)return;
        source.fileHash=hash;
        ensureSession(false);lookDraft();
        emit('falsify:paper-workspace-source',{fileHash:hash,name:source.name});
        if(source.pdf)await openPdf(bytes,mine);
        else{setStatus('이 형식은 쪽 뷰어가 없습니다. 원본 다운로드는 사용할 수 있습니다.');renderChrome();}
      }catch(e){if(epoch===mine)setStatus('원본을 열지 못했습니다. 다운로드는 그대로 사용할 수 있습니다.',true);}
    }
    function canOpenPdf(preview,bytes){
      if(!preview||typeof preview.defaultImport!=='function'||typeof preview.pdfParams!=='function'||typeof preview.fitScale!=='function'){
        setStatus('PDF.js 도우미가 없어 쪽을 그리지 못했습니다. 원본 다운로드는 사용할 수 있습니다.',true);return false;
      }
      if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0){
        setStatus('PDF 서명이 없어 쪽을 그리지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return false;
      }
      return true;
    }
    async function openPdf(bytes,mine){
      const preview=previewApi();
      if(!canOpenPdf(preview,bytes))return;
      setStatus('PDF를 이 브라우저에서 여는 중입니다.');
      let settled=false;
      const timer=timers.setTimeout(()=>{
        if(loadTimer===timer)loadTimer=null;
        if(epoch!==mine||settled)return;settled=true;stopPdf();
        setStatus('60초 안에 PDF를 열지 못해 쪽 보기를 멈췄습니다. 원본 다운로드는 사용할 수 있습니다.',true);
      },60000);
      loadTimer=timer;
      try{
        const lib=await preview.defaultImport();
        if(epoch!==mine||settled)return;
        source.lib=lib;
        if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));
        loadTask=task;
        const pdf=await task.promise;
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);if(loadTimer===timer)loadTimer=null;
        source.doc=pdf;pages=pdf.numPages;renderChrome();
        setStatus('');
        await drawBefore(1,mine);
      }catch(e){
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);if(loadTimer===timer)loadTimer=null;
        const name=e&&e.name;
        const msg=name==='PasswordException'?'암호가 걸린 PDF라 쪽을 그리지 못했습니다.':name==='InvalidPDFException'?'PDF 구조를 읽지 못해 쪽을 그리지 못했습니다.':'이 브라우저에서 쪽을 그리지 못했습니다.';
        setStatus(msg+' 원본 다운로드는 사용할 수 있습니다.',true);
      }
    }
    function beginBeforeRender(pdfPage,viewport,n,scale,setCanvas){
        const pageEl=doc.createElement('div');pageEl.className='paper-page';
        pageEl.style.width=viewport.width+'px';pageEl.style.height=viewport.height+'px';
        pageEl.style.setProperty('--total-scale-factor',String(scale));
        pageEl.style.setProperty('--scale-round-x','1px');pageEl.style.setProperty('--scale-round-y','1px');
        pageEl.style.setProperty('--text-scale-factor','1');
        const canvas=doc.createElement('canvas');setCanvas(canvas);canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label','원본 '+n+'쪽');
        const textEl=doc.createElement('div');textEl.className='paper-text-layer textLayer';
        pageEl.append(canvas,textEl);
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        source.render=renderTask;
        return {pageEl,textEl,canvas,renderTask};
    }
    function installBeforePage({viewport,base,items,divs,content,n,textEl,pageEl,scale,pdfPage,mine,seq}){
        const viewBox=viewport.viewBox||[0,0,base.width,base.height];
        const rotation=pageRotation(viewport.rotation);
        pageText={items,divs,styles:content.styles||{},viewBox,pageIndex:n-1,textEl,pageEl,rotation,pageWidth:viewBox[2]-viewBox[0],pageHeight:viewBox[3]-viewBox[1],scale};
        clearStage(ui.beforeStage);ui.beforeStage.append(pageEl);
        paintBeforeChanges();focusChange();
        pdfPage.cleanup&&pdfPage.cleanup();source.render=null;
        setBeforeStatus(n+' / '+pages+'쪽 · 원본 바이트'+(rotation?' · 회전된 쪽이라 좌표 편집은 받지 않습니다':''));
        renderChrome();void drawAfter();if(editMode==='table')void inspectTables(pageText,mine,seq);else void inspectParagraphs(pageText,mine,seq);
    }
    function beforePageReady(n,mine){
      if(!source||!source.doc||!Number.isSafeInteger(n)||n<1||n>pages||epoch!==mine)return false;
      if(!canLeaveInline())return false;
      return true;
    }
    function beforeRenderLive(live,canvas,pdfPage){if(live())return true;canvas.width=0;canvas.height=0;pdfPage.cleanup&&pdfPage.cleanup();return false;}
    function resetBeforePage(n){
      clearTables(true);clearParagraphs();
      const seq=++drawSeq;
      if(inspectCtl){inspectCtl.abort();inspectCtl=null;}
      pageText=null;
      if(inline&&ui.inlineAfter.value===inline.after){inline=null;renderInline();}
      if(page!==n){afterPart=0;afterSourcePage=n;}
      page=n;renderChrome();
      try{source.render&&source.render.cancel&&source.render.cancel();}catch{}
      try{textLayerHandle&&textLayerHandle.cancel&&textLayerHandle.cancel();}catch{}
      setBeforeStatus(n+' / '+pages+'쪽을 그리는 중입니다.');
      return seq;
    }
    function beforeContentLive(live,pdfPage){if(live())return true;pdfPage.cleanup&&pdfPage.cleanup();return false;}
    function beforeLayerLive(live,handle,pdfPage){if(live())return true;handle.cancel&&handle.cancel();pdfPage.cleanup&&pdfPage.cleanup();return false;}
    function reportBeforeFailure(e,live,canvas,n){
        if(!live()||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        clearStage(ui.beforeStage);
        setBeforeStatus(n+'쪽을 그리지 못했습니다. 다른 쪽은 이전·다음으로 시도할 수 있습니다.',true);
    }
    async function drawBefore(n,mine){
      mine=mine==null?epoch:mine;
      if(!beforePageReady(n,mine))return;
      const seq=resetBeforePage(n);
      const live=()=>epoch===mine&&seq===drawSeq;
      let canvas=null,pdfPage=null;
      try{
        pdfPage=await source.doc.getPage(n);
        if(!live())return;
        const base=pdfPage.getViewport({scale:1});
        const preview=previewApi();
        const scale=clampScale(base,ui.beforeStage.clientWidth||0,zoom,preview&&preview.fitScale);
        if(!(scale>0))throw new Error('scale');
        const viewport=pdfPage.getViewport({scale});
        const drawing=beginBeforeRender(pdfPage,viewport,n,scale,value=>{canvas=value;});
        const {pageEl,textEl,renderTask}=drawing;
        const contentPromise=pdfPage.getTextContent();
        await renderTask.promise;
        if(!beforeRenderLive(live,canvas,pdfPage))return;
        const content=await contentPromise;
        if(!beforeContentLive(live,pdfPage))return;
        const items=Array.isArray(content.items)?content.items:[];
        let divs=[];
        if(source.lib&&source.lib.TextLayer){
          const handle=new source.lib.TextLayer({textContentSource:content,container:textEl,viewport});
          textLayerHandle=handle;
          await handle.render();
          if(!beforeLayerLive(live,handle,pdfPage))return;
          divs=handle.textDivs||[];
          items.forEach((item,i)=>{if(divs[i]&&divs[i].dataset)divs[i].dataset.i=String(i);});
        }
        installBeforePage({viewport,base,items,divs,content,n,textEl,pageEl,scale,pdfPage,mine,seq});
      }catch(e){
        reportBeforeFailure(e,live,canvas,n);
      }
    }
    function installParagraphs(found,display,hash){
        if(found.fileHash!==hash||found.pageIndex!==display.pageIndex||found.rotation||!(found.width>0)||!(found.height>0))throw new Error('문단 위치가 원본과 맞지 않습니다.');
        source.paragraphPages.set(display.pageIndex,found);
        display.paragraphs=(Array.isArray(found.paragraphs)?found.paragraphs:[]).filter(p=>p&&typeof p.id==='string'&&('paragraph:'+display.pageIndex+':'+p.id).length<=80&&typeof p.text==='string'&&p.text.trim()&&validBbox(p.bbox));
        display.paragraphWidth=found.width;display.paragraphHeight=found.height;
        const rows=display.paragraphs.map(p=>({id:'paragraph:'+display.pageIndex+':'+p.id,text:p.text,pageIndex:display.pageIndex,label:'PDF p. '+(display.pageIndex+1)}));
        const clean=coreSegments(rows);
        if(session&&typeof session.addSegments==='function')session.addSegments(clean);
        else if(!(snapshot&&snapshot.edits&&snapshot.edits.length)){
          source.segments=coreSegments(source.segments).filter(s=>!clean.some(p=>p.id===s.id)).concat(clean);
          ensureSession(true);
        }
        source.segments=coreSegments(source.segments).filter(s=>!clean.some(p=>p.id===s.id)).concat(clean);
        renderParagraphs(display);
        setBeforeStatus((display.pageIndex+1)+' / '+pages+'쪽 · 원본 바이트 · 문단을 클릭해 편집');
    }
    function paragraphInspectionReady(api,display){
      if(!api||typeof api.inspectPage!=='function'||!source||display.rotation||editMode!=='text')return false;
      return true;
    }
    function paragraphInspectionLive(mine,seq,display,file,ctl){return epoch===mine&&seq===drawSeq&&pageText===display&&!!source&&source.file===file&&!ctl.signal?.aborted&&editMode==='text';}
    async function inspectParagraphs(display,mine,seq){
      const api=paragraphApi();
      if(!paragraphInspectionReady(api,display))return;
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      inspectCtl=ctl;
      const file=source.file,hash=source.fileHash;
      setBeforeStatus((display.pageIndex+1)+' / '+pages+'쪽 · 편집할 문단을 찾는 중… 글자 선택은 바로 사용할 수 있습니다.');
      try{
        const found=source.paragraphPages.get(display.pageIndex)||await api.inspectPage({file,fileHash:hash,pageIndex:display.pageIndex,signal:ctl.signal});
        if(!paragraphInspectionLive(mine,seq,display,file,ctl))return;
        installParagraphs(found,display,hash);
      }catch(e){
        if(epoch!==mine||seq!==drawSeq||pageText!==display||ctl.signal?.aborted)return;
        setBeforeStatus((display.pageIndex+1)+' / '+pages+'쪽 · 문단을 읽지 못했습니다. 글 선택 편집은 사용할 수 있습니다. '+safeMessage(e),true);
      }finally{if(inspectCtl===ctl)inspectCtl=null;}
    }
    function clearParagraphs(){
      if(!pageText)return;
      pageText.paragraphList?.remove();pageText.paragraphMarker?.remove();
      pageText.paragraphList=null;pageText.paragraphMarker=null;pageText.paragraphs=null;
    }
    function renderParagraphs(display){
      const list=doc.createElement('details');list.className='paper-paragraph-list';
      const summary=doc.createElement('summary');summary.textContent='이 쪽의 문단 선택 ('+display.paragraphs.length+')';list.append(summary);
      const marker=doc.createElement('div');marker.className='paper-paragraph-marker';marker.hidden=true;marker.setAttribute('aria-hidden','true');display.pageEl.append(marker);
      const mark=p=>{
        if(pageText!==display||editMode!=='text')return;
        if(!p){marker.hidden=true;return;}
        const b=p.bbox;marker.style.left=b[0]/display.paragraphWidth*100+'%';marker.style.top=b[1]/display.paragraphHeight*100+'%';
        marker.style.width=(b[2]-b[0])/display.paragraphWidth*100+'%';marker.style.height=(b[3]-b[1])/display.paragraphHeight*100+'%';marker.hidden=false;
      };
      for(const p of display.paragraphs){
        const button=doc.createElement('button');button.type='button';button.className='paper-paragraph-button';
        button.textContent=p.text;button.disabled=p.editable===false;
        if(button.disabled)button.title='이 문단은 흐름 편집을 지원하지 않습니다.';
        button.addEventListener('focus',()=>mark(p));button.addEventListener('blur',()=>mark(null));
        button.addEventListener('mouseenter',()=>mark(p));button.addEventListener('mouseleave',()=>mark(null));
        button.addEventListener('click',()=>openParagraphBinding(display,p));list.append(button);
      }
      display.paragraphList=list;display.paragraphMarker=marker;ui.beforeStage.prepend(list);
    }
    function clearTables(closeInline){
      tableSeq++;if(tableCtl){tableCtl.abort();tableCtl=null;}
      if(pageText?.tableLayer){pageText.tableLayer.remove();pageText.tableLayer=null;}
      if(pageText)pageText.tableCells=null;
      if(closeInline&&inline?.table&&ui.inlineAfter.value===inline.after){if(directEditor){const editor=directEditor;directEditor=null;composingDirect=false;editor.remove();}removeDirectControls();inline=null;renderInline();}
      say(ui.tableStatus,'');
    }
    function setEditMode(mode){
      if(mode==='table'&&ui.modeTable.disabled)return;
      if(!canLeaveInline())return;
      clearTables(true);clearParagraphs();if(inspectCtl){inspectCtl.abort();inspectCtl=null;}
      editMode=mode;ui.modeText.setAttribute('aria-pressed',String(mode==='text'));ui.modeTable.setAttribute('aria-pressed',String(mode==='table'));
      ui.modeHelp.textContent=mode==='table'?'셀을 눌러 값을 고치세요. 점선 셀은 지원 범위를 확인하세요.':'문단을 누르거나 글자를 드래그하세요.';
      if(inline){inline=null;renderInline();}
      if(pageText){if(mode==='table')void inspectTables(pageText,epoch,drawSeq);else void inspectParagraphs(pageText,epoch,drawSeq);}
    }
    const tableReason=reason=>({'multi-run-cell':'여러 글 조각이 있어 직접 셀 편집을 지원하지 않습니다.','empty-cell':'빈 셀은 지원하지 않습니다.','ambiguous-quote':'같은 위치의 원문을 한 곳으로 확정하지 못했습니다.','overlapping-text':'겹친 글자가 있어 지원하지 않습니다.','cell-boundary-uncertain':'셀 경계를 확정하지 못했습니다.','rotated-text':'회전한 글자는 지원하지 않습니다.'}[reason]||'이 셀은 직접 편집을 지원하지 않습니다.');
    function renderTableCell(cell,found,display,layer,live,hash,revision){
          if(!validBbox(cell.cellBbox))return;
          const b=cell.cellBbox,selection=cell.selection,ready=selection?.status==='ready';
          const button=doc.createElement('button');button.type='button';button.className='paper-table-cell';
          button.style.left=b[0]/found.width*100+'%';button.style.top=b[1]/found.height*100+'%';button.style.width=(b[2]-b[0])/found.width*100+'%';button.style.height=(b[3]-b[1])/found.height*100+'%';
          button.setAttribute('aria-label',(cell.row+1)+'행 '+(cell.col+1)+'열'+(ready?' · '+selection.before:' · '+tableReason(selection?.reason)));
          button.setAttribute('aria-disabled',String(!ready));button.title=ready?'이 셀 편집':tableReason(selection?.reason);
          button.addEventListener('click',()=>{
            if(!live()||!canLeaveInline())return;
            if(!ready){say(ui.tableStatus,tableReason(selection?.reason),true);return;}
            if(selection.sourceSha256!==hash||selection.revision!==revision||selection.pageIndex!==display.pageIndex||!validBbox(selection.anchor?.bbox)||!String(cell.alias||'').startsWith('table:'))return;
            tableBindings.set(cell.alias,{fileHash:hash,cellBbox:cell.cellBbox.slice()});
            const row={id:cell.alias,text:selection.before,pageIndex:display.pageIndex,label:'PDF p. '+(display.pageIndex+1)};
            if(!session?.addSegments){say(ui.tableStatus,'편집 코어가 셀 원문을 연결하지 못했습니다.',true);return;}
            try{session.addSegments([row]);source.segments=coreSegments(source.segments).filter(s=>s.id!==row.id).concat([row]);}catch(e){say(ui.tableStatus,'셀 원문을 연결하지 못했습니다.',true);return;}
            const existing=(snapshot?.edits||[]).find(e=>e.segmentId===row.id),rect=display.pageEl.getBoundingClientRect(),anchor={start:0,end:selection.before.length,bbox:selection.anchor.bbox.slice(),coordinate:'top-left',rotation:0};
            inline={table:true,before:selection.before,after:existing?existing.after:selection.before,anchor,pageIndex:display.pageIndex,segmentId:row.id,editId:existing?.id||null,
              clientRect:{left:rect.left+b[0]*rect.width/found.width,bottom:rect.top+b[3]*rect.height/found.height,width:(b[2]-b[0])*rect.width/found.width}};
            renderInline();openDirectEditor(display,{bbox:selection.anchor.bbox,width:found.width,height:found.height});
          });layer.append(button);
    }
    function tableInspectionReady(api,display){return !!(api?.inspectPage&&source&&!display.rotation&&editMode==='table');}
    function validateTablePage(found,hash,revision,display){
        if(found.fileHash!==hash||found.revision!==revision||found.pageIndex!==display.pageIndex||!(found.width>0&&found.height>0)||!Array.isArray(found.cells)||found.cells.length>500)throw new Error('표 위치가 원본과 맞지 않습니다.');
    }
    async function inspectTables(display,mine,seq){
      const api=tableApi();if(!tableInspectionReady(api,display))return;
      clearTables(true);const operation=tableSeq;
      const ctl=new AbortController();tableCtl=ctl;
      const file=source.file,hash=source.fileHash,revision=String(snapshot?.revision??0);
      const live=()=>epoch===mine&&seq===drawSeq&&operation===tableSeq&&pageText===display&&source?.file===file&&source?.fileHash===hash&&String(snapshot?.revision??0)===revision&&editMode==='table'&&!ctl.signal.aborted;
      say(ui.tableStatus,'이 쪽의 표 셀을 찾는 중입니다.');
      try{
        const found=await api.inspectPage({file,fileHash:hash,revision,pageIndex:display.pageIndex,signal:ctl.signal});
        if(!live())return;
        validateTablePage(found,hash,revision,display);
        display.tableCells=found.cells;const layer=doc.createElement('div');layer.className='paper-table-layer';layer.setAttribute('aria-label','원본 표 셀');display.tableLayer=layer;
        for(const cell of found.cells)renderTableCell(cell,found,display,layer,live,hash,revision);
        display.pageEl.append(layer);
        say(ui.tableStatus,found.cells.length?'표 셀 '+found.cells.length+'곳 · 셀을 누르면 원문과 After를 편집합니다.'+(found.truncated?' 이 쪽은 처음 500셀만 표시했습니다.':''):'이 쪽에서 편집할 표를 찾지 못했습니다. 글 편집으로 돌아가 선택하세요.',!!found.truncated);
      }catch(e){if(live())say(ui.tableStatus,'표를 읽지 못했습니다. 글 편집은 사용할 수 있습니다. '+safeMessage(e),true);}
      finally{if(tableCtl===ctl)tableCtl=null;}
    }
    function openParagraph(event){
      if(selectionClickPending){selectionClickPending=false;return;}
      if(editMode!=='text'||!pageText||!pageText.paragraphs||event.detail>1||fieldTarget(event.target))return;
      const sel=typeof doc.getSelection==='function'?doc.getSelection():null;
      if(sel&&!sel.isCollapsed)return;
      const rect=pageText.pageEl.getBoundingClientRect();
      if(!(rect.width>0&&rect.height>0)||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
      const x=(event.clientX-rect.left)*pageText.paragraphWidth/rect.width;
      const y=(event.clientY-rect.top)*pageText.paragraphHeight/rect.height;
      const hits=pageText.paragraphs.filter(p=>x>=p.bbox[0]&&x<=p.bbox[2]&&y>=p.bbox[1]&&y<=p.bbox[3]);
      if(hits.length!==1)return;
      openParagraphBinding(pageText,hits[0]);
    }
    function openParagraphBinding(display,p){
      if(editMode!=='text'||pageText!==display||!display.paragraphs?.includes(p)||!canLeaveInline())return;
      const rect=display.pageEl.getBoundingClientRect(),id='paragraph:'+display.pageIndex+':'+p.id;
      if(p.editable===false){setEditStatus('이 문단은 흐름 편집을 지원하지 않습니다. 글 선택 편집으로 위치를 확인할 수 있습니다.',true);return;}
      const existing=(snapshot&&snapshot.edits||[]).find(e=>e.segmentId===id&&e.before===p.text);
      const anchor={start:0,end:p.text.length,occurrence:0,bbox:p.bbox.slice(),coordinate:'top-left',rotation:0};
      inline={before:p.text,after:existing?existing.after:p.text,anchor,pageIndex:pageText.pageIndex,segmentId:id,editId:existing?existing.id:null,
        clientRect:{left:rect.left+p.bbox[0]*rect.width/pageText.paragraphWidth,bottom:rect.top+p.bbox[3]*rect.height/pageText.paragraphHeight,width:(p.bbox[2]-p.bbox[0])*rect.width/pageText.paragraphWidth}};
      renderInline();openDirectEditor(display,{bbox:p.bbox,width:display.paragraphWidth,height:display.paragraphHeight,source:p});
    }
    function styleDirectEditor(editor,display,geometry,b,w,h){
      const source=geometry.source,hit=(display.items||[]).find(item=>{const box=sliceBox(item,display.viewBox,0,String(item.str||'').length);return box&&box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1];});
      const size=Number(source?.fontSize||source?.runs?.[0]?.fontSize||hit?.height||Math.abs(hit?.transform?.[3]||0));
      const font=(hit&&display.styles?.[hit.fontName]?.fontFamily)||'serif';
      const width=Math.min(100-b[0]/w*100,Math.max((b[2]-b[0])/w*100,140/(w*display.scale)*100));
      Object.assign(editor.style,{position:'absolute',zIndex:'4',left:(b[0]/w*100)+'%',top:(b[1]/h*100)+'%',width:width+'%',minHeight:Math.max(32,(b[3]-b[1])*display.scale)+'px',height:Math.max(32,(b[3]-b[1])*display.scale)+'px',boxSizing:'border-box',resize:'vertical',background:'white',color:'black',padding:'2px',fontFamily:font,fontSize:(Number.isFinite(size)&&size>0?Math.max(8,size*display.scale):14)+'px',lineHeight:'1.25'});
    }
    function openDirectEditor(display,geometry){
      const b=geometry?.bbox,w=geometry?.width||display?.pageWidth,h=geometry?.height||display?.pageHeight;
      if(!display||!validBbox(b)||!(w>0&&h>0)){focusInline();return;}
      const editor=doc.createElement('textarea');
      editor.value=inline.after;editor.maxLength=4000;editor.spellcheck=false;
      editor.setAttribute('aria-label',(display.pageIndex+1)+'쪽 직접 편집');
      styleDirectEditor(editor,display,geometry,b,w,h);
      composingDirect=false;directEditor=editor;display.pageEl.append(editor);ui.inline.hidden=true;
      directControls=makeDirectControls(display,b,w,h,editor);
      editor.addEventListener('input',()=>{ui.inlineAfter.value=editor.value;updateDirectStatus(editor);queueDraft();if(!composingDirect)scheduleGeneration();renderChrome();});
      editor.addEventListener('compositionstart',()=>{if(directEditor===editor)composingDirect=true;});
      editor.addEventListener('compositionend',()=>{if(directEditor===editor){composingDirect=false;if(doc.activeElement!==editor&&!directControls?.contains(doc.activeElement))commitDirect();else scheduleGeneration();}});
      editor.addEventListener('blur',e=>{if(directEditor===editor&&!directControls?.contains(e.relatedTarget))commitDirect();});
      editor.addEventListener('keydown',e=>{if(e.isComposing||composingDirect)return;if(e.key==='Escape'){e.preventDefault();cancelDirect();}});
      doc.getSelection?.()?.removeAllRanges?.();editor.focus();
      if(geometry.selectAll)editor.select?.();
    }
    function updateDirectStatus(editor){
      if(directStatus)directStatus.textContent=editor.value===inline?.after?'변경 없음 · 바깥을 누르면 닫힘':'입력 중 · 바깥을 누르면 기록';
    }
    function cancelDirect(){
      if(composingDirect)return;closeInline();scheduleGeneration();renderChrome();
    }
    function removeDirectControls(){
      directResizeObserver?.disconnect();directResizeObserver=null;directControls?.remove();directControls=null;directStatus=null;
    }
    function positionDirectControls(page,editor,bar){
      if(!Number.isFinite(editor.offsetTop)||!Number.isFinite(editor.offsetHeight))return;
      const top=editor.offsetTop,bottom=top+editor.offsetHeight,above=top-bar.offsetHeight;
      bar.style.top=((bottom+bar.offsetHeight>page.clientHeight&&above>=0)?above:bottom)+'px';
    }
    function makeDirectControls(display,b,w,h,editor){
      const bar=doc.createElement('div'),status=doc.createElement('span'),done=doc.createElement('button'),cancel=doc.createElement('button');
      const left=(b[0]/w*100)+'%';bar.className='paper-direct-controls';
      Object.assign(bar.style,{position:'absolute',zIndex:'5',left,top:(b[1]/h*100)+'%',width:'calc(100% - '+left+')',display:'flex',flexWrap:'wrap',alignItems:'center',gap:'4px',background:'white'});
      status.dataset.directStatus='';status.setAttribute('aria-live','polite');status.textContent='변경 없음 · 바깥을 누르면 닫힘';directStatus=status;
      done.type=cancel.type='button';done.className=cancel.className='button secondary';done.textContent='완료';cancel.textContent='입력 취소';
      for(const button of [done,cancel])button.addEventListener('pointerdown',e=>e.preventDefault());
      done.addEventListener('click',commitDirect);cancel.addEventListener('click',cancelDirect);
      bar.addEventListener('focusout',e=>{if(directEditor===editor&&!bar.contains(e.relatedTarget)&&e.relatedTarget!==editor)commitDirect();});
      const hint=doc.createElement('span');hint.textContent=' · Esc 입력 취소 · 기록 후 실행 취소 가능';bar.append(status,done,cancel,hint);display.pageEl.append(bar);
      const position=()=>positionDirectControls(display.pageEl,editor,bar);position();
      if(typeof globalThis.ResizeObserver==='function'){directResizeObserver=new globalThis.ResizeObserver(position);directResizeObserver.observe(editor);directResizeObserver.observe(bar);directResizeObserver.observe(display.pageEl);}
      return bar;
    }
    function commitDirect(){
      if(!directEditor||!inline||composingDirect)return;
      ui.inlineAfter.value=directEditor.value;
      committingDirect=true;
      try{if(ui.inlineAfter.value===inline.after){closeInline();return;}
      applyInline();}finally{committingDirect=false;}
      if(inline&&directEditor)directEditor.focus();
    }
    function itemElement(node,textEl){
      let n=node&&node.nodeType===3?(node.parentElement||node.parentNode):node;
      while(n&&n!==textEl){
        if(n.dataset&&n.dataset.i!=null)return n;
        n=n.parentElement||n.parentNode;
      }
      return null;
    }
    function childOffset(span,container,at,kids){
      if(container===span){
        if(!kids.length)return at;
        let acc=0;
        for(let i=0;i<Math.min(kids.length,at);i++)acc+=String(kids[i].textContent??kids[i].nodeValue??'').length;
        return acc;
      }
      let acc=0;
      for(const kid of kids){
        if(kid===container)return acc+at;
        acc+=String(kid.textContent??kid.nodeValue??'').length;
      }
      if(container&&(container.parentNode===span||container.parentElement===span))return at;
      return null;
    }
    function charOffset(span,container,offset){
      const at=Number(offset);
      if(!span||!Number.isInteger(at)||at<0)return null;
      const kids=span.childNodes?Array.from(span.childNodes):[];
      return childOffset(span,container,at,kids);
    }
    function clientBox(range){
      if(!range||typeof range.getBoundingClientRect!=='function')return null;
      const rect=range.getBoundingClientRect();
      if(!rect||!(rect.width>0)||!(rect.height>0))return null;
      return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};
    }
    function rangeBox(range){
      if(!range||typeof range.getBoundingClientRect!=='function'||!pageText||!pageText.pageEl||typeof pageText.pageEl.getBoundingClientRect!=='function'||!(pageText.scale>0))return null;
      const rect=range.getBoundingClientRect(),pageRect=pageText.pageEl.getBoundingClientRect();
      if(!rect||!pageRect||!(rect.width>0)||!(pageRect.width>0))return null;
      const box=[round((rect.left-pageRect.left)/pageText.scale),round((rect.top-pageRect.top)/pageText.scale),round((rect.right-pageRect.left)/pageText.scale),round((rect.bottom-pageRect.top)/pageText.scale)];
      return validBbox(box)?box:null;
    }
    function selectionInside(range,sel,textEl){
      const inside=node=>!!(node&&textEl.contains&&textEl.contains(node.nodeType===3?(node.parentElement||node.parentNode):node));
      if(range.startContainer&&range.endContainer){if(!inside(range.startContainer)||!inside(range.endContainer))return false;}
      else if(!inside(range.commonAncestorContainer)&&!inside(sel.anchorNode)&&!inside(range.startContainer))return false;
      return true;
    }
    function setSelectionEndpoints(range,textEl,geometry,hits){
      const startEl=itemElement(range.startContainer,textEl),endEl=itemElement(range.endContainer,textEl);
      if(startEl&&endEl){
        const startOffset=charOffset(startEl,range.startContainer,range.startOffset);
        const endOffset=charOffset(endEl,range.endContainer,range.endOffset);
        const startItem=Number(startEl.dataset.i),endItem=Number(endEl.dataset.i);
        if(Number.isInteger(startOffset)&&Number.isInteger(endOffset)&&Number.isInteger(startItem)&&Number.isInteger(endItem)){
          let a=startItem,b=endItem,ao=startOffset,bo=endOffset;
          if(a>b||a===b&&ao>bo){const swap=a;a=b;b=swap;const swapOff=ao;ao=bo;bo=swapOff;}
          geometry.range={startItem:a,endItem:b,startOffset:ao,endOffset:bo};
          const dom=rangeBox(range);
          if(dom)geometry.range.domBox=dom;
          hits.push(a);
        }
      }
    }
    function addAnchorHit(sel,textEl,hits,inside){
        if(!hits.length&&sel.anchorNode){
          const el=sel.anchorNode.dataset?sel.anchorNode:sel.anchorNode.parentElement;
          if(el&&el.dataset&&el.dataset.i!=null&&inside(el))hits.push(Number(el.dataset.i));
        }
    }
    function selectionHits(range,sel,textEl,geometry){
      const inside=node=>!!(node&&textEl.contains&&textEl.contains(node.nodeType===3?(node.parentElement||node.parentNode):node));
      const hits=[];
      setSelectionEndpoints(range,textEl,geometry,hits);
      if(!geometry.range){
        for(const node of textEl.querySelectorAll?textEl.querySelectorAll('span'):[]){
          if(!node.dataset||node.dataset.i==null)continue;
          let hit=false;
          try{hit=range.intersectsNode?range.intersectsNode(node):false;}catch{hit=false;}
          if(hit)hits.push(Number(node.dataset.i));
        }
        addAnchorHit(sel,textEl,hits,inside);
      }
      return hits;
    }
    function openSelectedText(located,range,event){
      const segment=segmentFor(located.before,located.anchor,pageText.pageIndex);
      const existing=(snapshot?.edits||[]).find(e=>e.pageIndex===pageText.pageIndex&&e.before===located.before&&JSON.stringify(e.anchor?.bbox)===JSON.stringify(located.anchor?.bbox));
      inline={before:located.before,after:existing?existing.after:located.before,anchor:existing?existing.anchor:located.anchor,pageIndex:pageText.pageIndex,segmentId:existing?existing.segmentId:segment?segment.id:undefined,editId:existing?existing.id:null,clientRect:clientBox(range)};
      if(event?.type==='pointerup'||event?.type==='mouseup'){selectionClickPending=true;timers.setTimeout(()=>{selectionClickPending=false;},0);}
      renderInline();openDirectEditor(pageText,{bbox:located.anchor.bbox,selectAll:true});
    }
    function readSelection(event){
      if(editMode!=='text'||fieldTarget(event?.target))return null;
      const sel=typeof doc.getSelection==='function'?doc.getSelection():null;
      if(!sel||sel.isCollapsed||!sel.rangeCount||!pageText||!pageText.textEl)return null;
      const textEl=pageText.textEl;
      let range=null;
      try{range=sel.getRangeAt(0);}catch{range=null;}
      if(!range)return null;
      if(!selectionInside(range,sel,textEl))return null;
      return {sel,textEl,range};
    }
    function captureSelection(event){
      const captured=readSelection(event);if(!captured)return;
      const {sel,textEl,range}=captured;
      if(inline&&ui.inlineAfter.value!==inline.after){canLeaveInline();return;}
      if(pageText.rotation){setEditStatus('회전된 쪽은 위쪽 원점 좌표로 확정할 수 없어 편집으로 넣지 않았습니다.',true);return;}
      const geometry={rotation:0,pageWidth:pageText.pageWidth,pageHeight:pageText.pageHeight};
      const hits=selectionHits(range,sel,textEl,geometry);
      if(!hits.length){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      const located=anchorFromSelection(pageText.items,pageText.viewBox,hits,geometry);
      if(!located){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      openSelectedText(located,range,event);
    }
    function loadInline(edit){
      if(!canLeaveInline())return;
      const mine=epoch,open=()=>{
        if(epoch!==mine||!(snapshot?.edits||[]).some(e=>e.id===edit.id)||!canLeaveInline())return;
        inline={table:String(edit.segmentId||'').startsWith('table:'),before:edit.before,after:edit.after,anchor:edit.anchor,pageIndex:edit.pageIndex,segmentId:edit.segmentId,editId:edit.id};
        renderInline();openDirectEditor(pageText,{bbox:edit.anchor?.bbox});
      };
      if(page===edit.pageIndex+1&&pageText)open();else void drawBefore(edit.pageIndex+1).then(open);
    }
    // Project uniquely identifiable selected text into a shared page catalog. Whitespace
    // differs between the content stream and geometry order, so compare compact offsets.
    function projectedRange(edit,segment){
      const own=(source?.segments||[]).find(s=>s.id===edit.segmentId);
      const a=edit.anchor;
      if(!own||!a||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end>own.text.length||a.end<=a.start)return null;
      const selected=own.text.slice(a.start,a.end);
      if(typeof edit.before==='string'&&selected!==edit.before)return null;
      const compact=text=>text.replace(/\s+/g,'');
      const needle=compact(selected),ownText=compact(own.text),target=compact(segment.text);
      if(!needle)return null;
      const unique=(text,q)=>{const i=text.indexOf(q);return i>=0&&text.indexOf(q,i+1)<0?i:-1;};
      if(unique(ownText,needle)<0)return null;
      const start=unique(target,needle);
      return start<0?null:{start,end:start+needle.length};
    }
    function overlappingBoxes(candidate,e){
        const box=candidate.anchor?.bbox,other=e.anchor?.bbox;
        if(validBbox(box)&&validBbox(other))return box[0]<other[2]&&box[2]>other[0]&&box[1]<other[3]&&box[3]>other[1];
        return false;
    }
    function aliasesOverlap(candidate,e){
        if(e.id===candidate.id||e.id===candidate.editId||e.pageIndex!==candidate.pageIndex)return false;
        if(e.segmentId===candidate.segmentId)return !!(e.anchor&&candidate.anchor&&e.anchor.start<candidate.anchor.end&&candidate.anchor.start<e.anchor.end);
        for(const segment of source?.segments||[]){
          if(segmentPage(segment)!==candidate.pageIndex)continue;
          const a=projectedRange(candidate,segment),b=projectedRange(e,segment);
          if(a&&b)return a.start<b.end&&b.start<a.end;
        }
        return overlappingBoxes(candidate,e);
    }
    function crossAliasOverlap(candidate,includeExternal=false){
      const others=(snapshot?.edits||[]).filter(e=>e.enabled!==false).concat(includeExternal?(external?.edits?.()||[]):[]);
      return others.some(e=>aliasesOverlap(candidate,e));
    }
    function closeInline(){
      if(composingDirect||(!inline&&!directEditor))return;
      if(directEditor){const editor=directEditor;directEditor=null;composingDirect=false;editor.remove();}
      removeDirectControls();
      const id=inline?.editId;inline=null;renderInline();
      const target=id&&buttons(ui.edits).find(b=>b.dataset.edit===id&&b.dataset.act==='edit');
      if(!committingDirect)(target||ui.beforeStage).focus();
    }
    function addInlineEdit(after){
          const segs=coreSegments(source.segments);
          let segment=inline.segmentId?segs.find(s=>s.id===inline.segmentId):null;
          if(segment&&inline.anchor&&segment.text.slice(inline.anchor.start,inline.anchor.end)!==inline.before)segment=null;
          if(!segment)segment=segmentFor(inline.before,inline.anchor,inline.pageIndex);
          if(!segment){setEditStatus(segs.length?'같은 원문이 한 문단으로 확정되지 않아 편집으로 넣지 않았습니다.':'원문 구간이 아직 없어 편집으로 넣지 않았습니다. 추출 뒤에 다시 시도하세요.',true);return false;}
          const built=coreAnchor(inline.anchor,segment,inline.before);
          if(built.error){setEditStatus(built.error,true);return false;}
          session.add({pageIndex:inline.pageIndex,segmentId:segment.id,before:inline.before,after,anchor:built.anchor,origin:'human'});
      return true;    }
    function inlineCoreReady(api){
      if(!api||!session){setEditStatus('편집 코어가 없어 편집을 저장하지 않았습니다.',true);return false;}
      return true;
    }
    function inlineReady(after){
      if(!inline||typeof after!=='string'){setEditStatus('After를 확인하지 못했습니다.',true);return false;}
      if(after!==''&&!after.trim()){setEditStatus('공백만 있는 After는 저장하지 않습니다. 문장을 지우려면 After를 비우세요.',true);return false;}
      if(after===inline.before&&!inline.editId){closeInline();scheduleGeneration();return false;}
      if(!inline.editId&&crossAliasOverlap(inline,true)){setEditStatus('같은 위치에 기록한 편집이 있습니다. 기존 편집을 수정하거나 삭제한 뒤 적용하세요.',true);return false;}
      return true;
    }
    function applyInline(){
      if(composingDirect)return;
      const api=editsApi();
      if(!inlineCoreReady(api))return;
      const after=ui.inlineAfter.value;
      if(!inlineReady(after))return;
      const inlineBefore=inline.before;
      committingInline=true;
      generatorVersion++;generator?.dispose();generator=null;
      try{
        if(after===inline.before)session.remove(inline.editId);
        else if(inline.editId)session.update(inline.editId,{after});
        else{
          if(!addInlineEdit(after))return;
        }
        closeInline();
        setEditStatus(after===inlineBefore?'원문으로 되돌렸습니다.':'직접 편집을 기록했습니다.');
      }catch(e){setEditStatus('편집을 저장하지 않았습니다. '+safeMessage(e),true);}
      finally{committingInline=false;scheduleGeneration();}
    }
    function onJump(edit){
      const n=Number(edit.pageIndex)+1;
      if(!(n>=1&&n<=pages)){setEditStatus('원본에 그 쪽이 없어 이동하지 못했습니다.',true);return;}
      void drawBefore(n);
    }
    function onDelete(edit){
      if(!session||!snapshot)return;
      const items=snapshot.edits||[],idx=items.findIndex(e=>e.id===edit.id);
      const neighbor=items[idx+1]||items[idx-1];
      pendingFocus=neighbor?{id:neighbor.id,act:'edit'}:{act:'undo'};
      session.remove(edit.id);
    }
    function proposalAnchorHint(item){
        const geometry=pageText&&pageText.pageIndex===item.pageIndex?{rotation:pageText.rotation,pageWidth:pageText.pageWidth,pageHeight:pageText.pageHeight}:null;
        const visual=geometry&&!geometry.rotation?visualAnchor(pageText.items,pageText.viewBox,item.before,geometry):null;
        const hinted=Object.assign({},item.anchor||{});
        if(visual&&validBbox(visual.bbox))hinted.bbox=visual.bbox;
        if(geometry&&geometry.rotation)delete hinted.bbox;
      return hinted;
    }
    function acceptOne(index){
      if(!proposalQueue)return;
      const item=classifyProposals(proposalQueue.proposals,source&&source.segments||[],{origin:proposalQueue.origin,model:proposalQueue.model}).items[index];
      if(!item||item.status!=='matched'||accepted.has(index)){setProposalStatus('확정되지 않은 제안은 적용하지 않습니다.',true);return;}
      if(!session){setProposalStatus('편집 코어가 없어 제안을 적용하지 않았습니다.',true);return;}
      try{
        const segs=coreSegments(source.segments);
        const segment=segs.find(s=>s.id===item.segmentId);
        if(!segment){setProposalStatus('문단 ID가 원문에 없어 제안을 적용하지 않았습니다.',true);return;}
        const hinted=proposalAnchorHint(item);
        const built=coreAnchor(hinted,segment,item.before);
        if(built.error){setProposalStatus(built.error,true);return;}
        if(crossAliasOverlap({...item,anchor:built.anchor})){setProposalStatus('같은 위치에 기록한 편집이 있어 제안을 적용하지 않았습니다. 기존 편집을 수정하거나 삭제하세요.',true);return;}
        const id=session.add({pageIndex:item.pageIndex,segmentId:item.segmentId,before:item.before,after:item.after,anchor:built.anchor,origin:proposalQueue.origin});
        if(id&&proposalQueue.model)modelById.set(id,proposalQueue.model);
        accepted.add(index);paintProposals();
        setProposalStatus(originText(proposalQueue.origin,proposalQueue.model)+' 제안을 편집 목록에 넣었습니다.');
      }catch(e){setProposalStatus('제안을 적용하지 않았습니다. '+safeMessage(e),true);}
    }
    function acceptProposals(proposals,options){
      const norm=normalizeOrigin(options);
      if(!norm.ok){setProposalStatus('알 수 없는 제안 출처라 보여 주지 않았습니다.',true);return;}
      proposalQueue={proposals:Array.isArray(proposals)?proposals:[],origin:norm.origin,model:norm.model};
      accepted=new Set();paintProposals();
      ui.proposals.hidden=!proposalQueue.proposals.length;
      if(norm.origin==='external-ai-import'&&options?.confirmed===true){
        proposalQueue.proposals.forEach((_,i)=>acceptOne(i));
        return {applied:accepted.size};
      }
    }
    const lastDownload=doc.createElement('button');lastDownload.type='button';lastDownload.className='button secondary';lastDownload.textContent='마지막 생성본 다운로드';lastDownload.hidden=true;ui.current.after(lastDownload);listen(lastDownload,'click',()=>{if(output&&!output.blocked)download(output.file,true);});
    const afterNav=doc.createElement('div'),afterPrev=doc.createElement('button'),afterNext=doc.createElement('button'),afterPosition=doc.createElement('span');
    afterNav.className='paper-after-nav';afterNav.hidden=true;
    for(const b of [afterPrev,afterNext]){b.type='button';b.className='button secondary';}
    afterPrev.textContent='이전';afterNext.textContent='다음';
    afterPrev.setAttribute('aria-label','생성본의 이전 이어지는 쪽');afterNext.setAttribute('aria-label','생성본의 다음 이어지는 쪽');
    afterNav.append(afterPrev,afterPosition,afterNext);ui.afterLabel.after(afterNav);
    listen(afterPrev,'click',()=>{if(afterPart>0){afterPart--;void drawAfter();}});
    listen(afterNext,'click',()=>{if(!afterNext.disabled){afterPart++;void drawAfter();}});
    function mappedPages(current,count){
      if(current.pageMap==null)return count===pages?[page-1]:null;
      if(!Array.isArray(current.pageMap))return null;
      const rows=current.pageMap.filter(p=>p&&p.sourcePageIndex===page-1);
      if(rows.length!==1)return null;
      const row=rows[0];
      if(Object.hasOwn(row,'contentOutputPageIndices')){const indices=row.contentOutputPageIndices;return Array.isArray(indices)&&indices.length>0&&indices.every((n,i)=>Number.isSafeInteger(n)&&n>=0&&n<count&&(i===0||indices[i-1]<n))?indices.slice():null;}
      if(!Array.isArray(row.continuationPageIndices))return null;
      const indices=[row.outputPageIndex,...row.continuationPageIndices];
      return indices.every(n=>Number.isSafeInteger(n)&&n>=0&&n<count)&&new Set(indices).size===indices.length?indices:null;
    }
    function afterViewLive(seq,mine,current){return seq===afterSeq&&epoch===mine&&output===current;}
    function afterEpochLive(seq,mine){return seq===afterSeq&&epoch===mine;}
    function finishAfterPage(mapped,independent,outputPage){
        afterNav.hidden=mapped.length<2;afterPrev.disabled=afterPart===0;afterNext.disabled=afterPart===mapped.length-1;
        afterPosition.textContent=independent?'출력 '+outputPage+' / '+mapped.length+'쪽':'원본 '+page+'쪽 → 출력 '+outputPage+'쪽 · '+(afterPart+1)+' / '+mapped.length;
        setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+' · 받은 파일 바이트 · 출력 '+outputPage+'쪽'+(independent?' · 원본과 쪽 대응 없음':afterPart?' · 이어지는 쪽':''));
    }
    function afterPreview(current){
      if(!current||current.blocked){clearStage(ui.afterStage);setAfterStatus(current?'생성 파일의 바이트가 해시와 달라 그리지 않았습니다.':'아직 생성본이 없습니다.');return null;}
      const preview=previewApi();
      if(!preview){setAfterStatus('PDF.js 도우미가 없어 생성본을 그리지 못했습니다. 다운로드는 해시가 맞는 동안 사용할 수 있습니다.',true);return null;}
      setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+'을 확인하는 중입니다.');
      return preview;
    }
    function afterTarget(current,pdf){
        const independent=current.recomposition&&current.pageMap==null;
        const mapped=independent?Array.from({length:pdf.numPages},(_,i)=>i):mappedPages(current,pdf.numPages);
        if(!mapped){clearStage(ui.afterStage);setAfterStatus('원본 '+page+'쪽의 출력 위치를 확인할 페이지 대응이 없습니다. 해시가 맞는 파일은 다운로드할 수 있습니다.',true);return null;}
        if(afterSourcePage!==page){afterSourcePage=page;afterPart=0;}
        afterPart=Math.max(0,Math.min(afterPart,mapped.length-1));
        const outputPage=mapped[afterPart]+1;
      return {independent,mapped,outputPage};
    }
    function createAfterOverlay(viewport,scale){
          const textEl=doc.createElement('div');textEl.className='paper-text-layer textLayer';
          const surface=doc.createElement('div');surface.className='paper-page paper-after-page';surface.style.width=viewport.width+'px';surface.style.height=viewport.height+'px';
          surface.style.setProperty('--total-scale-factor',String(viewport.scale||scale));surface.style.setProperty('--scale-round-x','1px');surface.style.setProperty('--scale-round-y','1px');surface.style.setProperty('--text-scale-factor','1');
          surface.append(textEl);ui.afterStage.append(surface);
      return {textEl,surface};
    }
    function paintAfterOverlay(current,independent,surface,textEl,content,layer){
          const edits=(current.edits||[]).filter(e=>independent||e.pageIndex===page-1);
          afterMarks=marksApi().paintPage({document:doc,container:surface,items:content.items,divs:layer.textDivs,edits,side:'after'});
          surface.classList.add('paper-after-overlay');textEl.remove();syncChangeVisibility();updateChangeStatus();focusChange();
    }
    function reportAfterFailure(e,seq,mine,canvas){
        if(!afterEpochLive(seq,mine)||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        setAfterStatus('생성본 쪽을 그리지 못했습니다. 해시가 맞는 파일은 다운로드할 수 있습니다.',true);
    }
    function createAfterCanvas(viewport,outputPage,setCanvas){
        const canvas=doc.createElement('canvas');setCanvas(canvas);canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label',(stale()?'마지막 생성본 ':'현재 생성본 ')+outputPage+'쪽');
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        return ctx;
    }
    function configurePdfWorker(lib){if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;}
    function ensureAfterCache(){const cacheApi=deps.generation||globalThis.FalsifyPaperGeneration;if(!afterCache&&cacheApi?.createDocumentCache)afterCache=cacheApi.createDocumentCache({maxEntries:2});}
    function afterHashValid(hash,current){if(hash===current.sha256)return true;current.blocked=true;clearStage(ui.afterStage);setAfterStatus('생성 파일의 바이트가 해시와 달라 미리보기와 다시 받기를 멈췄습니다.',true);renderChrome();return false;}
    function afterOverlaySupported(lib){return marksApi()?.paintPage&&lib.TextLayer;}
    function loadAfterDocument(lib,preview,bytes,current){if(afterCache){const key=current.sha256;afterCacheKey=key;return afterCache.load(key,()=>lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI)));}const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));afterTask=task;return task.promise;}
    function afterRenderLive(seq,mine,current,canvas){if(afterViewLive(seq,mine,current))return true;canvas.width=0;canvas.height=0;return false;}
    function afterLayerLive(seq,mine,current,layer){if(afterViewLive(seq,mine,current))return true;layer.cancel?.();return false;}
    function afterViewport(pdfPage,preview){
        const base=pdfPage.getViewport({scale:1});
        const scale=clampScale(base,ui.afterStage.clientWidth||ui.beforeStage.clientWidth||0,1,preview.fitScale);
        const viewport=pdfPage.getViewport({scale:scale>0?scale:1});
        return {scale,viewport};
    }
    function cachedSourceLibrary(){return source&&source.lib;}
    async function drawAfter(){
      afterNav.hidden=true;
      afterMarks=null;
      const seq=++afterSeq,mine=epoch,current=output;
      const preview=afterPreview(current);if(!preview)return;
      let canvas=null;
      try{
        const bytes=new Uint8Array(await current.file.arrayBuffer());
        if(!afterViewLive(seq,mine,current))return;
        if(!afterHashValid(await sha256Hex(bytes),current))return;
        const lib=cachedSourceLibrary()||await preview.defaultImport();
        if(!afterEpochLive(seq,mine))return;
        configurePdfWorker(lib);
        releaseAfter();
        ensureAfterCache();
        const pdf=await loadAfterDocument(lib,preview,bytes,current);
        if(!afterViewLive(seq,mine,current))return;
        const target=afterTarget(current,pdf);if(!target)return;
        const {independent,mapped,outputPage}=target;
        const pdfPage=await pdf.getPage(outputPage);
        if(!afterEpochLive(seq,mine))return;
        const {scale,viewport}=afterViewport(pdfPage,preview);
        const ctx=createAfterCanvas(viewport,outputPage,value=>{canvas=value;});
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        afterRender=renderTask;await renderTask.promise;
        if(!afterRenderLive(seq,mine,current,canvas))return;
        clearStage(ui.afterStage);ui.afterStage.append(canvas);
        // Keep the rendered canvas as the first child for existing preview consumers.
        // The absolute DOM overlay is comparison-only; the File remains byte-identical.
        if(afterOverlaySupported(lib)){
          const content=await pdfPage.getTextContent();
          if(!afterViewLive(seq,mine,current))return;
          const {textEl,surface}=createAfterOverlay(viewport,scale);
          const layer=new lib.TextLayer({textContentSource:content,container:textEl,viewport});await layer.render();
          if(!afterLayerLive(seq,mine,current,layer))return;
          paintAfterOverlay(current,independent,surface,textEl,content,layer);
        }
        pdfPage.cleanup&&pdfPage.cleanup();
        finishAfterPage(mapped,independent,outputPage);
      }catch(e){
        reportAfterFailure(e,seq,mine,canvas);
      }
    }
    function validContentPages(row,count){
        if(Object.hasOwn(row,'contentOutputPageIndices')&&(!Array.isArray(row.contentOutputPageIndices)||!row.contentOutputPageIndices.length||row.contentOutputPageIndices.some((n,i,a)=>!Number.isSafeInteger(n)||n<0||n>=count||i>0&&n<=a[i-1])))return false;
        return true;
    }
    function claimTablePages(row,count,owned){
        for(const index of [row.outputPageIndex,...row.continuationPageIndices]){if(!Number.isSafeInteger(index)||index<0||index>=count||owned.has(index))return false;owned.add(index);}
        return true;
    }
    function validTableMapRow(row,count,sources,outputs,owned){
        if(!Number.isSafeInteger(row?.sourcePageIndex)||row.sourcePageIndex<0||row.sourcePageIndex>=pages||sources.has(row.sourcePageIndex)||!Number.isSafeInteger(row.outputPageIndex)||row.outputPageIndex<0||row.outputPageIndex>=count||outputs.has(row.outputPageIndex))return false;
        if(!Array.isArray(row.continuationPageIndices))return false;
        if(!claimTablePages(row,count,owned))return false;
        if(!validContentPages(row,count))return false;
        return true;
    }
    function tableOutputPages(result){
      const map=result.pageMap,v=result.verification,final=Array.isArray(v?.stages)?v.stages.at(-1)?.verification:v;
      const count=final?.pageCount?.output;
      if(!Array.isArray(map)||map.length!==pages||!Number.isSafeInteger(count)||count<1)return null;
      const sources=new Set(),outputs=new Set(),owned=new Set(),lookup=new Map();
      for(const row of map){
        if(!validTableMapRow(row,count,sources,outputs,owned))return null;
        sources.add(row.sourcePageIndex);outputs.add(row.outputPageIndex);lookup.set(row.sourcePageIndex,row.outputPageIndex);
      }
      return owned.size===count?lookup:null;
    }
    async function benchmarkSource(request){
      const helper=deps.blindPdf||globalThis.FalsifyBlindPdf;
      if(!helper?.prepare)return {request,blinding:null};
      const clean=await helper.prepare({file:request.file,signal:request.signal});
      if(request.signal?.aborted)throw new Error('PDF 생성을 취소했습니다.');
      if(!isFile(clean?.file)||!HEX.test(clean.sha256||'')||await sha256Hex(await clean.file.arrayBuffer())!==clean.sha256)throw new Error('실험 표시 정리 결과를 확인하지 못했습니다.');
      return {request:{...request,file:clean.file,fileHash:clean.sha256},blinding:clean.changed?{originalSourceSha256:request.fileHash,cleanSourceSha256:clean.sha256,removed:clean.removed,verification:clean.verification}:null};
    }
    function bindBenchmarkResult(result,prepared,originalHash){
      if(result.verification?.sourceSha256&&result.verification.sourceSha256!==prepared.request.fileHash)throw new Error('생성 결과의 원본 해시가 다릅니다.');
      return prepared.blinding?{...result,originalSourceSha256:originalHash,verification:{...(result.verification||{}),blinding:prepared.blinding}}:result;
    }
    // Render RED's frozen selected batch in an isolated edit session. Workspace edits and undo stay untouched.
    function buildRedBatch(fileHash,patches){
      if(!Array.isArray(patches)||!patches.length)throw new Error('선택한 후보가 없습니다.');
      const isolated=editsApi().create({fileHash,name:sessionName(source.name),segments:coreSegments(source.segments),now:now()});
      const proposals=patches.map(p=>({segmentId:p.segmentId,before:p.before,after:p.after,anchor:{start:p.offset,end:p.offset+p.before.length}}));
      const items=classifyProposals(proposals,source.segments,{origin:'external-ai-import'}).items;
      for(const item of items){
        if(item.status!=='matched')throw new Error('선택 후보의 원본 위치를 확인하지 못했습니다. '+item.reason);
        const segment=coreSegments(source.segments).find(s=>s.id===item.segmentId),built=coreAnchor(item.anchor,segment,item.before);
        if(built.error)throw new Error(built.error);
        isolated.add({pageIndex:item.pageIndex,segmentId:item.segmentId,before:item.before,after:item.after,anchor:built.anchor,origin:'external-ai-import'});
      }
      return isolated;
    }
    function ensureRedBatchLive(live,mine,ctl){if(!live()||mine!==genId||ctl.signal.aborted)throw new Error('원본 또는 편집이 바뀌어 생성을 취소했습니다.');}
    function requireRedBatchSource(fileHash){
      if(!source||!source.pdf||source.fileHash!==fileHash||!snapshot||!editsApi()?.create)throw new Error('현재 PDF 원본을 확인할 수 없습니다.');
      if(generating)throw new Error('다른 PDF 생성이 진행 중입니다.');
    }
    function validateRedBatchBytes(actual,result,bytes){if(actual!==result.sha256||new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)throw new Error('생성 파일을 확인하지 못했습니다.');}
    async function exportRedBatch({fileHash,revision,patches,isCurrent}){
      requireRedBatchSource(fileHash);
      const file=source.file, epochAt=epoch, workspaceRevision=snapshot.revision;
      const live=()=>epoch===epochAt&&source?.file===file&&source?.fileHash===fileHash&&snapshot?.revision===workspaceRevision&&(!isCurrent||isCurrent());
      const isolated=buildRedBatch(fileHash,patches);
      const batch=isolated.snapshot(), edits=batch.edits.filter(e=>e.enabled!==false);let api=bodyExporter(edits);
      if(!api?.prepare)throw new Error('브라우저 PDF 편집 모듈이 없습니다.');
      const mine=++genId,ctl=new AbortController();genCtl=ctl;generating=true;renderChrome();
      try{
        const fontSnapshot=await resolveFonts(edits,ctl.signal);
        if(fullFontEmbedding(fontSnapshot)&&!edits.some(e=>String(e.segmentId||'').startsWith('layout:'))&&legacyExporterApi()?.prepare)api=legacyExporterApi();
        const prepared=await benchmarkSource({file,fileHash,edits:clone(edits),fontSnapshot,signal:ctl.signal});
        ensureRedBatchLive(live,mine,ctl);
        const result=bindBenchmarkResult(await api.prepare(prepared.request),prepared,fileHash);
        ensureRedBatchLive(live,mine,ctl);
        if(!isFile(result?.file)||!HEX.test(result.sha256||''))throw new Error('생성 결과가 실제 파일이 아닙니다.');
        const bytes=new Uint8Array(await result.file.arrayBuffer()),actual=await sha256Hex(bytes);
        ensureRedBatchLive(live,mine,ctl);
        validateRedBatchBytes(actual,result,bytes);
        return {file:result.file,bytes,sha256:actual,verification:result.verification??null,revision,workspaceRevision,batch:published(batch)};
      }finally{if(genCtl===ctl)genCtl=null;if(mine===genId&&epoch===epochAt){generating=false;renderChrome();}}
    }
    const generationApi=()=>deps.generation||globalThis.FalsifyPaperGeneration||null;
    function captureInlineEdit(edits){
      if(inline){const after=directEditor?directEditor.value:ui.inlineAfter.value;if(after!==inline.after){
        if(typeof after!=='string'||(after!==''&&!after.trim()))throw Error('편집할 내용을 확인하세요.');
        if(inline.editId){edits=edits.filter(e=>e.id!==inline.editId);}
        if(after!==inline.before){if(crossAliasOverlap(inline,true))throw Error('기존 편집과 겹칩니다. 기존 편집을 끄고 다시 선택하세요.');const seg=coreSegments(source.segments).find(x=>x.id===inline.segmentId)||segmentFor(inline.before,inline.anchor,inline.pageIndex);const built=coreAnchor(inline.anchor,seg,inline.before);if(!seg||built.error)throw Error('편집 원문 위치를 확인하세요.');edits.push({id:inline.editId||'inline',enabled:true,before:inline.before,after,segmentId:seg.id,pageIndex:inline.pageIndex,anchor:built.anchor,origin:'human'});}
      }}
      return edits;
    }
    function captureSpec(){
      if(!source?.fileHash||!snapshot)throw Error('원본을 먼저 선택하세요.');
      let edits=clone(enabledEdits());
      for(const edit of edits)if(crossAliasOverlap(edit,true))throw Error('편집 위치가 겹칩니다. 기존 편집을 끄고 다시 선택하세요.');
      for(const edit of edits){const editor=proposalInputs.get(edit.id);if(editor){edit.after=editor.value;if(edit.after!==''&&!edit.after.trim())throw Error('제안 수정문을 확인하세요.');}}
      edits=edits.filter(e=>e.after!==e.before);
      edits=captureInlineEdit(edits);
      for(let i=0;i<edits.length;i++)for(let j=i+1;j<edits.length;j++){const a=edits[i],b=edits[j];if(a.segmentId===b.segmentId&&a.anchor.start<b.anchor.end&&b.anchor.start<a.anchor.end)throw Error('겹치는 편집을 선택할 수 없습니다.');}
      return {fileHash:source.fileHash,edits,fontRevision,revision:snapshot.revision,externalRevision,tableBoxes:edits.filter(tableEdit).map(e=>({id:e.id,bbox:clone(tableBindings.get(e.segmentId)?.cellBbox)||null})),exportSettings:{recompose:useRecomposition()}};
    }
    function ensureGenerator(){
      const g=generationApi();if(!g?.create)return null;if(generator)return generator;
      const version=++generatorVersion;
      generator=g.create({generate:generateCaptured,onResult:(candidate,meta)=>{if(version!==generatorVersion||!source||source.fileHash!==meta.spec.fileHash)return;let current;try{current=g.key(captureSpec());}catch{return;}if(current!==meta.key)return;output=candidate;outputAt=now();generationFailed=false;output.key=meta.key;afterPart=0;afterSourcePage=page;setGenStatus(output.edits.length?generationLead(output.verification,false):'선택한 편집이 없어 원본 PDF를 사용합니다.');emit('falsify:paper-workspace-output',published({sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0)}));renderEdits();void drawAfter();},onState:state=>{if(version!==generatorVersion||!source)return;let current;try{current=g.key(captureSpec());}catch{return;}if(current!==state.key)return;generating=state.phase==='running';if(state.phase==='error'){generationFailed=true;setGenStatus('생성하지 못했습니다. '+generationError(state.error),true);}else if(state.phase==='running')generationFailed=false;renderChrome();}});return generator;
    }
    function scheduleGeneration(){if(committingInline||!generationApi()||!source?.pdf||!snapshot)return;try{ensureGenerator().schedule(captureSpec());}catch(e){setGenStatus('현재 편집을 확인하세요. '+safeMessage(e),true);}}
    function planCapturedExport(spec){
      const edits=clone(spec.edits);for(const e of edits)delete e.sourceRefs;
      const tables=edits.filter(tableEdit),body=edits.filter(e=>!tableEdit(e)),mixed=!!tables.length&&!!body.length,recompose=spec.exportSettings.recompose;
      let api=recompose?recompositionApi():mixed?pipelineApi():tables.length?legacyExporterApi():bodyExporter(body);
      if(!api?.prepare)throw Error('PDF 편집 모듈이 없습니다.');
      if(!recompose&&!mixed)for(const edit of edits)if(tableEdit(edit)&&edit.anchor)delete edit.anchor.occurrence;
      if(fontRevision!==spec.fontRevision)throw Error('요청한 글꼴이 바뀌어 다시 생성해야 합니다.');
      return {edits,tables,body,mixed,recompose,api};
    }
    function capturedFontExporter(api,recompose,mixed,fontSnapshot,edits){if(!recompose&&!mixed&&fullFontEmbedding(fontSnapshot)&&!edits.some(e=>String(e.segmentId||'').startsWith('layout:'))&&legacyExporterApi()?.prepare)api=legacyExporterApi();return api;}
    function canFlowMixed(fontSnapshot,bodyApi,rows,e,failures){return !fullFontEmbedding(fontSnapshot)&&bodyApi===legacyExporterApi()&&paragraphApi()&&Array.isArray(rows)&&!rows.some(tableEdit)&&e.code==='unsupported'&&Array.isArray(failures)&&failures.length&&failures.every(f=>f.code==='long-after-no-room');}
    function canFlowCaptured(recompose,mixed,fontSnapshot,tables,api,e,failures,signal){return !recompose&&!mixed&&!fullFontEmbedding(fontSnapshot)&&!tables.length&&api===legacyExporterApi()&&paragraphApi()&&e.code==='unsupported'&&Array.isArray(failures)&&failures.length&&failures.every(f=>f.code==='long-after-no-room')&&!signal.aborted;}
    function checkCapturedResult(result,prepared,spec,file,signal,recompose){
      if(signal.aborted||source?.file!==file)throw Error('생성이 취소되었습니다.');if(recompose&&result?.revision!==spec.revision)throw Error('생성 리비전이 다릅니다.');if(!recompose)result=bindBenchmarkResult(result,prepared,spec.fileHash);
      if(!isFile(result?.file)||!HEX.test(result.sha256||''))throw Error('생성 결과가 실제 파일이 아닙니다.');      return result;
    }
    function capturedCandidate(result,spec,recompose,key){
      const candidate={file:result.file,sha256:result.sha256,edits:clone(spec.edits),originalSourceSha256:HEX.test(result.originalSourceSha256||'')?result.originalSourceSha256:spec.fileHash,verification:result.verification??null,warnings:result.warnings||null,pageMap:clone(result.pageMap)||null,recomposition:recompose,revision:spec.revision,fontRevision:spec.fontRevision,externalRevision:spec.externalRevision,blocked:false,key};
      return candidate;
    }
    function selectMixedBodyApi(fontSnapshot,edits,body){return fullFontEmbedding(fontSnapshot)&&!edits.some(e=>String(e.segmentId||'').startsWith('layout:'))&&legacyExporterApi()?.prepare?legacyExporterApi():bodyExporter(body);}
    function capturedBodyAdapter(bodyApi,fontSnapshot,signal){
        const adapter={prepare:async req=>{try{return await bodyApi.prepare(req);}catch(e){const rows=Array.isArray(req.edits)?req.edits:req.edits?.edits,failures=e?.details?.edits;const canFlow=canFlowMixed(fontSnapshot,bodyApi,rows,e,failures);if(!canFlow||signal.aborted)throw e;return paragraphApi().prepare(req);}}};
      return adapter;
    }
    function ensureCapturedLive(signal,file){if(signal.aborted||source?.file!==file)throw Error('생성이 취소되었습니다.');}
    function canCheckTableFit(mapping,cells){return !!(mapping&&tableApi()?.checkFit&&cells.every(c=>validBbox(c.bbox)&&Number.isSafeInteger(c.pageIndex)));}
    function applyCapturedTableFit(candidate,fit,cells){
        const results=fit?.results||cells.map(c=>({id:c.id,status:'unverified'}));candidate.verification={...(candidate.verification||{}),tableCellFit:{method:'mupdf-output-glyphs-against-source-cell',independent:false,...(!fit?{reason:'output-page-map-or-geometry-unverified'}:{}),results:clone(results)}};candidate.warnings=[...(candidate.warnings||[]),...results.filter(r=>r.status==='overflow'||r.status==='unverified').map(r=>({code:r.status==='overflow'?'table-cell-overflow':'table-cell-fit-unverified',severity:'warning',id:r.id}))];
    }
    function capturedSource(spec){const file=source?.file;if(!file||source.fileHash!==spec.fileHash)throw Error('원본이 바뀌었습니다.');return file;}
    function validateCapturedBytes(hash,result,bytes){if(hash!==result.sha256||new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)throw Error('생성 파일을 확인하지 못했습니다.');}
    async function generateCaptured(spec,{signal,key}){
      const file=capturedSource(spec);
      if(!spec.edits.length)return {file,sha256:spec.fileHash,edits:[],revision:spec.revision,fontRevision:spec.fontRevision,externalRevision:spec.externalRevision,verification:null,pageMap:null,blocked:false,key};
      const plan=planCapturedExport(spec);
      const {edits,tables,body,mixed,recompose}=plan;let api=plan.api;
      const fontSnapshot=recompose?undefined:await resolveFonts(edits,signal);if(fontRevision!==spec.fontRevision)throw Error('요청한 글꼴이 바뀌어 다시 생성해야 합니다.');api=capturedFontExporter(api,recompose,mixed,fontSnapshot,edits);
      const prepared=recompose?{request:{file,fileHash:spec.fileHash,edits,revision:spec.revision,signal},blinding:null}:await benchmarkSource({file,fileHash:spec.fileHash,edits,fontSnapshot,signal});
      let result;
      try{if(mixed&&!recompose){
        const bodyApi=selectMixedBodyApi(fontSnapshot,edits,body);
        const adapter=capturedBodyAdapter(bodyApi,fontSnapshot,signal);
        result=await api.prepare(prepared.request,{selectionPdf:legacyExporterApi(),paragraphPdf:adapter});
      }else result=await api.prepare(prepared.request);}
      catch(e){const failures=e?.details?.edits;if(canFlowCaptured(recompose,mixed,fontSnapshot,tables,api,e,failures,signal))result=await paragraphApi().prepare({...prepared.request,edits});else throw e;}
      result=checkCapturedResult(result,prepared,spec,file,signal,recompose);const bytes=new Uint8Array(await result.file.arrayBuffer());validateCapturedBytes(await sha256Hex(bytes),result,bytes);ensureCapturedLive(signal,file);
      const candidate=capturedCandidate(result,spec,recompose,key);
      if(tables.length&&!recompose){const mapping=tableOutputPages(result),cells=tables.map(e=>({id:e.id,pageIndex:mapping?.get(e.pageIndex),after:e.after,bbox:spec.tableBoxes.find(x=>x.id===e.id)?.bbox}));
        let fit=null;if(canCheckTableFit(mapping,cells)){try{fit=await tableApi().checkFit({file:result.file,fileHash:result.sha256,revision:String(spec.revision),pageIndex:cells[0].pageIndex,cells,signal});}catch(e){if(signal.aborted)throw e;}}
        applyCapturedTableFit(candidate,fit,cells);
      }
      ensureCapturedLive(signal,file);return candidate;
    }
    async function currentAction(action){
      const actionEpoch=epoch;
      try{const spec=captureSpec(),result=await ensureGenerator().flush(spec);if(actionEpoch!==epoch)return;if(action==='download')download(result.file,true);else if(action==='blue'){const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([result.file],'paper.pdf',{type:'application/pdf'})}});if(!doc.dispatchEvent(ev)){setGenStatus('BLUE가 인계를 받지 않았습니다.',true);return;}const nav=[...doc.querySelectorAll('[data-view="blue"]')].find(b=>b.getClientRects&&b.getClientRects().length)||doc.querySelector('[data-view="blue"]');nav?.click();}}
      catch(e){if(actionEpoch===epoch)setGenStatus('현재 파일을 만들지 못했습니다. '+safeMessage(e),true);}
    }
    function prepareGeneration(){
      if(!canLeaveInline())return null;
      let api=exporterApi();
      if(!api||typeof api.prepare!=='function'){setGenStatus('브라우저 PDF 편집 모듈이 없어 생성하지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return null;}
      if(!source||!source.pdf||!source.fileHash){setGenStatus('PDF 원본이 없어 생성하지 않았습니다.',true);return null;}
      const edits=enabledEdits();
      if(!edits.length||!snapshot){setGenStatus('켠 편집이 없어 생성하지 않았습니다.',true);return null;}
      return {api,edits};
    }
    function prepareGenerationPlan(edits,api){
        const exportEdits=JSON.parse(JSON.stringify(edits));
        for(const edit of exportEdits)delete edit.sourceRefs;
        const recompose=useRecomposition()&&api===recompositionApi();
        const mixed=exportEdits.some(tableEdit)&&exportEdits.some(e=>!tableEdit(e));
        if(!recompose&&!mixed)for(const edit of exportEdits)if(tableEdit(edit)&&edit.anchor)delete edit.anchor.occurrence;
      return {exportEdits,recompose,mixed};
    }
    function invalidGenerationFallback(canFlow,ctl,mine,epochAt,hash,revision){return !canFlow||ctl.signal?.aborted||mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash||snapshot?.revision!==revision;}
    function generationBodyAdapter(fontSnapshot,edits,ctl,mine,epochAt,hash,revision){
            const bodyApi=fullFontEmbedding(fontSnapshot)&&!edits.some(e=>String(e.segmentId||'').startsWith('layout:'))&&legacyExporterApi()?.prepare?legacyExporterApi():bodyExporter(edits.filter(e=>!tableEdit(e)));
            const bodyAdapter={prepare:async bodyRequest=>{
              try{return await bodyApi.prepare(bodyRequest);}
              catch(e){
                const rows=Array.isArray(bodyRequest.edits)?bodyRequest.edits:bodyRequest.edits?.edits,failures=e?.details?.edits;
                const canFlow=canFlowMixed(fontSnapshot,bodyApi,rows,e,failures);
                if(invalidGenerationFallback(canFlow,ctl,mine,epochAt,hash,revision))throw e;
                setGenStatus('표 편집을 유지한 파일에서 본문만 문단 흐름으로 생성하는 중입니다.');
                return paragraphApi().prepare(bodyRequest);
              }
            }};
      return bodyAdapter;
    }
    function canFlowWhole(recompose,request,edits,api,e,failures){return !recompose&&!fullFontEmbedding(request.fontSnapshot)&&!edits.some(e=>String(e.segmentId||'').startsWith('table:'))&&api===legacyExporterApi()&&paragraphApi()&&e.code==='unsupported'&&Array.isArray(failures)&&failures.length&&failures.every(f=>f.code==='long-after-no-room');}
    function bindGeneratedResult(result,prepared,hash,recompose,revision){
        if(recompose&&result?.revision!==revision)throw new Error('생성 결과의 편집 revision이 다릅니다.');
        if(!recompose)result=bindBenchmarkResult(result,prepared,hash);
      return result;
    }
    function generatedCandidate(result,edits,hash,recompose,revision){
        const candidate={file:result.file,sha256:result.sha256,edits:clone(edits),originalSourceSha256:HEX.test(result.originalSourceSha256||'')?result.originalSourceSha256:hash,verification:result.verification==null?null:result.verification,warnings:Array.isArray(result.warnings)?result.warnings:null,pageMap:clone(result.pageMap)||null,recomposition:recompose,revision,fontRevision,externalRevision,blocked:false};
      return candidate;
    }
    function generationEpochLive(mine,epochAt){return mine===genId&&epoch===epochAt;}
    function generationSourceLive(mine,epochAt,hash){return mine===genId&&epoch===epochAt&&!!source&&source.fileHash===hash;}
    function generationRevisionLive(mine,epochAt,file,hash,ctl,revision){return mine===genId&&epoch===epochAt&&!!source&&source.file===file&&source.fileHash===hash&&!ctl.signal?.aborted&&snapshot?.revision===revision;}
    function requireGeneratedFile(result){
        if(!isFile(result&&result.file)||typeof result.sha256!=='string'||!HEX.test(result.sha256))throw new Error('생성 결과가 실제 파일이 아닙니다.');
    }
    function validateGeneratedBytes(actualHash,result,bytes){
        if(actualHash!==result.sha256)throw new Error('생성 파일의 바이트와 해시가 달라 받지 않았습니다.');
        if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)throw new Error('생성 결과에 PDF 서명이 없어 받지 않았습니다.');
    }
    function markUnmappedTable(candidate,tableEdits){
            const note=' 경고: 출력 쪽 대응을 확인하지 못해 표 셀 배치를 검증하지 않았습니다. 실제 생성본을 확인하세요.';
            candidate.verification={...(candidate.verification||{}),tableCellFit:{method:'mupdf-output-glyphs-against-source-cell',independent:false,reason:'output-page-map-unverified',results:tableEdits.map(e=>({id:e.id,status:'unverified'}))}};
            candidate.warnings=[...(candidate.warnings||[]),...tableEdits.map(e=>({code:'table-cell-fit-unverified',severity:'warning',id:e.id}))];
      return note;
    }
    function applyGeneratedTableFit(candidate,fit,tableNote){
              candidate.verification={...(candidate.verification||{}),tableCellFit:{method:'mupdf-output-glyphs-against-source-cell',independent:false,results:clone(fit.results)||[]}};
              const cellWarnings=(fit.results||[]).filter(r=>r.status==='overflow'||r.status==='unverified').map(r=>({code:r.status==='overflow'?'table-cell-overflow':'table-cell-fit-unverified',severity:'warning',id:r.id}));
              candidate.warnings=[...(candidate.warnings||[]),...cellWarnings];
              if(fit.results?.some(r=>r.status==='overflow'))return ' 경고: 생성 글자가 원래 표 셀 경계를 넘었습니다. After를 줄이고 다시 생성하세요.';
              else if(fit.results?.some(r=>r.status==='unverified'))return ' 경고: 생성 글자가 원래 표 셀 안에 드는지 확인하지 못했습니다. 생성본을 확인하세요.';
      return tableNote;
    }
    function installGeneratedOutput(candidate,recompose,tableNote){
        output=candidate;afterPart=0;afterSourcePage=page;
        const noted=diagnosticText(output.warnings,output.verification);
        emit('falsify:paper-workspace-output',published({sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0)}));
        if(recompose)setGenStatus(output.verification?.status==='finding'?'PDF를 만들었습니다. 내용 확인 항목은 파일 정보에서 볼 수 있습니다.':'PDF를 만들었습니다.');
        else setGenStatus(generationLead(output.verification,stale())+(noted?' '+noted:'')+tableNote);
        renderEdits();
    }
    function reportGenerationFailure(e,mine,epochAt,hash,ctl){
        if(!generationSourceLive(mine,epochAt,hash))return;
        if(ctl.signal&&ctl.signal.aborted){setGenStatus('생성을 중단했습니다. 마지막 생성본은 그대로입니다.');return;}
        setGenStatus('생성하지 못했습니다. 마지막 생성본은 그대로입니다. '+generationError(e),true);
    }
    function finishGeneration(ctl,mine,epochAt){if(genCtl===ctl)genCtl=null;if(mine===genId&&epoch===epochAt){generating=false;renderChrome();}}
    function planGeneratedTableFit(candidate,result,edits,recompose){
      let note='';
      const tableEdits=edits.filter(e=>String(e.segmentId||'').startsWith('table:'));
      if(!tableEdits.length||recompose)return {note,check:false};
      note=' 표의 원래 칸과 생성 글자를 확인하세요. 셀 크기는 자동으로 늘리지 않습니다.';
      const mapping=tableOutputPages(result),cells=tableEdits.map(e=>({id:e.id,pageIndex:mapping?.get(e.pageIndex),after:e.after,bbox:tableBindings.get(e.segmentId)?.cellBbox}));
      if(!mapping)return {note:markUnmappedTable(candidate,tableEdits),check:false};
      return {note,mapping,cells,check:canCheckTableFit(mapping,cells)};
    }
    function requestGeneratedTableFit(result,revision,mapping,cells,ctl){return tableApi().checkFit({file:result.file,fileHash:result.sha256,revision:String(revision),pageIndex:mapping.get(page-1)??cells[0].pageIndex,cells,signal:ctl.signal});}
    function generationRequestLive(mine,epochAt,ctl){return generationEpochLive(mine,epochAt)&&!ctl.signal.aborted;}
    function generationFailures(e){return e&&e.details&&e.details.edits;}
    function beginGeneration(){
      const mine=++genId,epochAt=epoch,hash=source.fileHash,revision=snapshot.revision,file=source.file;
      if(genCtl)genCtl.abort();
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      genCtl=ctl;generating=true;renderChrome();
      setGenStatus('PDF를 만들고 있습니다.');
      return {mine,epochAt,hash,revision,file,ctl};
    }
    function requestGeneration(api,request,recompose,mixed,fontSnapshot,edits,ctl,mine,epochAt,hash,revision){
      if(recompose)return api.prepare(request);
      if(mixed){
        const bodyAdapter=generationBodyAdapter(fontSnapshot,edits,ctl,mine,epochAt,hash,revision);
        return api.prepare(request,{selectionPdf:legacyExporterApi(),paragraphPdf:bodyAdapter});
      }
      return api.prepare(request);
    }
    function fallbackGeneration(e,recompose,request,edits,api,ctl,mine,epochAt,hash,revision){
          const failures=generationFailures(e);
          const canFlow=canFlowWhole(recompose,request,edits,api,e,failures);
          if(invalidGenerationFallback(canFlow,ctl,mine,epochAt,hash,revision))throw e;
          setGenStatus('선택 편집이 원래 공간에 들어가지 않아 전체 편집을 문단 흐름으로 생성하는 중입니다.');
          return paragraphApi().prepare({...request,edits:JSON.parse(JSON.stringify(edits))});
    }
    async function generate(){
      const setup=prepareGeneration();if(!setup)return;
      let {api}=setup;const {edits}=setup;
      const run=beginGeneration();
      const {mine,epochAt,hash,revision,file,ctl}=run;
      try{
        const plan=prepareGenerationPlan(edits,api);
        const {exportEdits,recompose,mixed}=plan;
        const fontSnapshot=recompose?undefined:await resolveFonts(exportEdits,ctl.signal);
        api=capturedFontExporter(api,recompose,mixed,fontSnapshot,edits);
        const prepared=recompose?{request:{file,fileHash:hash,edits:exportEdits,revision,signal:ctl.signal},blinding:null}:await benchmarkSource({file,fileHash:hash,edits:exportEdits,fontSnapshot,signal:ctl.signal}),request=prepared.request;
        if(!generationRequestLive(mine,epochAt,ctl))return;
        let result;
        try{
          result=await requestGeneration(api,request,recompose,mixed,fontSnapshot,edits,ctl,mine,epochAt,hash,revision);
        }
        catch(e){
          result=await fallbackGeneration(e,recompose,request,edits,api,ctl,mine,epochAt,hash,revision);
        }
        result=bindGeneratedResult(result,prepared,hash,recompose,revision);
        if(!generationSourceLive(mine,epochAt,hash))return;
        requireGeneratedFile(result);
        const bytes=new Uint8Array(await result.file.arrayBuffer());
        if(!generationEpochLive(mine,epochAt))return;
        const actualHash=await sha256Hex(bytes);
        if(!generationRevisionLive(mine,epochAt,file,hash,ctl,revision))return;
        validateGeneratedBytes(actualHash,result,bytes);
        const candidate=generatedCandidate(result,edits,hash,recompose,revision);
        const tablePlan=planGeneratedTableFit(candidate,result,edits,recompose);
        let tableNote=tablePlan.note;
        if(tablePlan.check){
          try{
            const fit=await requestGeneratedTableFit(result,revision,tablePlan.mapping,tablePlan.cells,ctl);
            if(!generationEpochLive(mine,epochAt))return;
            tableNote=applyGeneratedTableFit(candidate,fit,tableNote);
          }catch(e){if(ctl.signal.aborted)return;tableNote=' 표 셀 안의 배치를 확인하지 못했습니다. 생성본에서 칸 경계를 확인하세요.';}
        }
        if(!generationRevisionLive(mine,epochAt,file,hash,ctl,revision))return;
        installGeneratedOutput(candidate,recompose,tableNote);
        await drawAfter();
      }catch(e){
        reportGenerationFailure(e,mine,epochAt,hash,ctl);
      }finally{finishGeneration(ctl,mine,epochAt);}
    }
    function download(file,neutral=false){
      if(!isFile(file))return;
      const url=urls.createObjectURL(file),a=doc.createElement('a');
      a.href=url;a.download=neutral?'paper.pdf':file.name||'download.pdf';(doc.body||ui.root).append(a);a.click();a.remove();
      timers.setTimeout(()=>urls.revokeObjectURL(url),1000);
    }
    function prepareDraft(api){
      let envelope;
      try{envelope=api.draft({snapshot:session.snapshot(),now:now()});}catch(e){setDraftStatus('초안을 만들지 못했습니다. '+safeMessage(e),true);return null;}
      if(!envelope||draftUnsafe(envelope,0)){setDraftStatus('초안에 파일 바이트나 비밀로 보이는 값이 있어 저장하지 않았습니다.',true);return null;}
      const extras={external:external?external.snapshot():null,proposalValues:[...proposalInputs].map(([id,node])=>({id,after:node.value})),inline:inline?{before:inline.before,after:directEditor?directEditor.value:ui.inlineAfter.value,pageIndex:inline.pageIndex,segmentId:inline.segmentId,anchor:inline.anchor,editId:inline.editId||null}:null};
      if(draftUnsafe(extras,0)){setDraftStatus('초안에 보관할 수 없는 값이 있습니다.',true);return null;}
      const raw=JSON.stringify(extras.external||extras.inline?{schema:'falsify.paper-workspace-draft.v1',fileHash:envelope.fileHash,envelope,extras}:envelope);
      if(raw.length>200000){setDraftStatus('초안이 너무 커서 저장하지 않았습니다.',true);return null;}
      return {envelope,raw};
    }
    function draftStoreForSave(api){
      if(!ui.draftOpt.checked){setDraftStatus('초안 보관은 직접 켠 뒤에만 저장합니다.',true);return null;}
      if(!api||typeof api.draft!=='function'||!session||!source||!source.fileHash){setDraftStatus('편집 코어가 없어 초안을 저장하지 않았습니다.',true);return null;}
      const box=store();if(!box){setDraftStatus('이 브라우저 저장소를 쓸 수 없어 초안을 저장하지 않았습니다.',true);return null;}
      return box;
    }
    async function saveDraft(){
      const api=editsApi();
      const box=draftStoreForSave(api);if(!box)return;
      const draftSource=source;
      const prepared=prepareDraft(api);if(!prepared)return;
      const {envelope,raw}=prepared;
      let sourceKept=false;
      if(ui.draftSource.checked){
        const blobs=blobApi();
        if(!blobs)setDraftStatus('편집 초안만 저장합니다. 이 브라우저에 원본 Blob 저장소가 없습니다.',true);
        else{
          try{
            await blobs.put(source.fileHash,{fileHash:source.fileHash,name:source.name,type:source.file.type||'',savedAt:envelope.savedAt,expiresAt:envelope.expiresAt,blob:source.file});
            sourceKept=true;
          }catch(e){setDraftStatus('원본 PDF는 보관하지 못했습니다. '+safeMessage(e),true);}
        }
      }
      if(source!==draftSource)return;
      try{box.setItem(draftKey(),raw);draftRaw=raw;}
      catch(e){setDraftStatus('초안을 저장하지 못했습니다. '+safeMessage(e),true);return;}
      writeIndex(readIndex().filter(row=>row.fileHash!==source.fileHash).concat([{fileHash:source.fileHash,name:source.name,expiresAt:envelope.expiresAt,source:sourceKept}]));
      if(ui.draftSource.checked&&!sourceKept)setDraftStatus('편집 초안은 저장했습니다. 원본 PDF는 보관하지 못했습니다. 서버로 올리지 않습니다.',true);
      else setDraftStatus(sourceKept?'12시간 뒤 만료되는 편집 초안과 원본 PDF를 이 브라우저에만 저장했습니다. 서버로 올리지 않습니다.':'12시간 뒤 만료되는 초안을 이 브라우저에 저장했습니다. 편집만 남고 원본 PDF는 넣지 않았습니다.');
      renderChrome();
    }
    function applyResume(restored){
      const api=editsApi();
      if(!restored||!Array.isArray(restored.edits)){setDraftStatus('초안은 확인됐지만 편집 스냅샷이 없어 복구하지 않았습니다.',true);return;}
      try{
        watchSession(api.create({fileHash:source.fileHash,name:restored.name||sessionName(source.name),segments:coreSegments(source.segments),now:now(),resume:restored}));
        pendingResume=null;
        onSnapshot(session.snapshot());
        setDraftStatus('초안 편집을 이 세션에 다시 넣었습니다. 실행 취소 기록은 복구 이후부터입니다. 초안 JSON에는 원본 PDF 바이트가 없습니다.');
      }catch(e){
        const bound=coreSegments(source.segments).some(s=>restored.edits.some(edit=>edit&&edit.segmentId===s.id));
        if(restored.edits.length&&!bound){pendingResume=restored;setDraftStatus('원본은 열렸습니다. 같은 해시의 구간이 추출되면 편집을 되돌립니다. 초안 JSON에는 PDF 바이트가 없습니다.');return;}
        setDraftStatus('초안을 세션에 넣지 못했습니다. '+safeMessage(e),true);
      }
    }
    function verifyDraftParagraphPage(found,canonical,index,hash){
          if(found.fileHash!==hash||found.pageIndex!==index||found.rotation)throw new Error('초안 문단의 원본 위치를 확인하지 못했습니다.');
          const pageRows=coreSegments((found.paragraphs||[]).map(p=>({id:'paragraph:'+index+':'+p.id,text:p.text,pageIndex:index,label:'PDF p. '+(index+1)})));
          for(const edit of canonical.filter(e=>e.pageIndex===index)){
            const row=pageRows.find(p=>p.id===edit.segmentId),a=edit.anchor;
            if(!row||!a||row.text.slice(a.start,a.end)!==edit.before)throw new Error('초안 Before가 현재 원본 문단과 다릅니다.');
          }
      return pageRows;
    }
    async function discoverDraftParagraphs(restored){
      const canonical=(restored.edits||[]).filter(e=>typeof e.segmentId==='string'&&e.segmentId.startsWith('paragraph:'));
      if(!canonical.length)return true;
      const api=paragraphApi();
      if(!api||typeof api.inspectPage!=='function')throw new Error('문단 편집 모듈이 없어 이 초안의 원문을 확인하지 못했습니다.');
      if(resumeCtl)resumeCtl.abort();
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      resumeCtl=ctl;
      const mine=epoch,file=source.file,hash=source.fileHash,rows=[];
      const live=()=>epoch===mine&&source&&source.file===file&&source.fileHash===hash&&!ctl.signal?.aborted;
      try{
        for(const index of new Set(canonical.map(e=>e.pageIndex))){
          const found=await api.inspectPage({file,fileHash:hash,pageIndex:index,signal:ctl.signal});
          if(!live())return false;
          const pageRows=verifyDraftParagraphPage(found,canonical,index,hash);
          rows.push(...pageRows);
        }
        if(!live())return false;
        // Bind the complete verified catalog in one replacement; partial inspections never leak into the session.
        source.segments=coreSegments(source.segments).filter(s=>!rows.some(p=>p.id===s.id)).concat(rows);
        return true;
      }catch(e){if(!live())return false;throw e;}
      finally{if(resumeCtl===ctl)resumeCtl=null;}
    }
    function verifyDraftTablePage(found,edits,index,hash,revision,rows){
          if(found.fileHash!==hash||found.revision!==revision||found.pageIndex!==index||!Array.isArray(found.cells))throw new Error('초안 표의 원본 위치를 확인하지 못했습니다.');
          for(const edit of edits.filter(e=>e.pageIndex===index)){
            const cell=found.cells.find(c=>c.alias===edit.segmentId),selected=cell?.selection;
            if(selected?.status!=='ready'||selected.sourceSha256!==hash||selected.revision!==revision||selected.pageIndex!==index||selected.before!==edit.before||JSON.stringify(selected.anchor?.bbox)!==JSON.stringify(edit.anchor?.bbox))throw new Error('초안 셀이 현재 원본 표와 다릅니다.');
            tableBindings.set(cell.alias,{fileHash:hash,cellBbox:cell.cellBbox.slice()});
            rows.push({id:cell.alias,text:selected.before,pageIndex:index,label:'PDF p. '+(index+1)});
          }
    }
    async function discoverDraftTables(restored){
      const edits=(restored.edits||[]).filter(e=>String(e.segmentId||'').startsWith('table:'));
      if(!edits.length)return true;
      const api=tableApi();if(!api?.inspectPage)throw new Error('표 편집 모듈이 없어 초안의 셀 원문을 확인하지 못했습니다.');
      if(resumeCtl)resumeCtl.abort();const ctl=new AbortController();resumeCtl=ctl;
      const mine=epoch,file=source.file,hash=source.fileHash,revision='draft:'+restored.revision,rows=[];
      const live=()=>epoch===mine&&source?.file===file&&source?.fileHash===hash&&!ctl.signal.aborted;
      try{
        for(const index of new Set(edits.map(e=>e.pageIndex))){
          const found=await api.inspectPage({file,fileHash:hash,revision,pageIndex:index,signal:ctl.signal});
          if(!live())return false;
          verifyDraftTablePage(found,edits,index,hash,revision,rows);
        }
        if(!live())return false;
        source.segments=coreSegments(source.segments).filter(s=>!rows.some(r=>r.id===s.id)).concat(rows);return true;
      }catch(e){if(!live())return false;throw e;}
      finally{if(resumeCtl===ctl)resumeCtl=null;}
    }
    function restoreDraftExtras(extras){
      if(extras?.external){try{const api=deps.externalProposals||globalThis.FalsifyExternalProposals;if(!api?.create)throw Error('제안 모듈이 없습니다.');external=api.create({fileHash:source.fileHash,role:'red',segments:externalSegments(source.segments)});external.restore(extras.external);external.subscribe(value=>{if(atomicSelection)return;externalRevision++;abortGen();if(!suppressExternalPaint){paintExternal();paintBeforeChanges();}renderChrome();queueDraft();scheduleGeneration();emit('falsify:paper-external-responses',published(value));});paintExternal();for(const row of extras.proposalValues||[]){const node=proposalInputs.get(row.id);if(node&&typeof row.after==='string')node.value=row.after;}emit('falsify:paper-external-responses',external.snapshot());}catch(e){setDraftStatus('제안 초안을 복구하지 못했습니다. '+safeMessage(e),true);}}
      if(extras?.inline){const x=extras.inline,seg=coreSegments(source.segments).find(row=>row.id===x.segmentId);if(seg&&x.anchor&&seg.text.slice(x.anchor.start,x.anchor.end)===x.before&&typeof x.after==='string'){inline={...x};renderInline();ui.inlineAfter.value=x.after;}}
    }
    function readDraftForRestore(api,box){
      let raw=draftRaw,expected=source&&source.fileHash;
      if(!raw){
        const row=readIndex()[0];
        if(row&&box){expected=row.fileHash;try{raw=box.getItem('falsify.paper-draft.v1.'+row.fileHash);}catch{raw=null;}}
      }
      if(!api||typeof api.restoreDraft!=='function'||!raw){setDraftStatus('편집 코어가 없어 초안을 복구하지 않았습니다.',true);return null;}
      let envelope;
      try{envelope=JSON.parse(raw);}catch{setDraftStatus('초안을 읽지 못했습니다.',true);return null;}
      const extras=envelope.schema==='falsify.paper-workspace-draft.v1'?envelope.extras:null;
      if(extras)envelope=envelope.envelope;
      expected=envelope.fileHash||expected;
      return {envelope,extras,expected};
    }
    function reportMissingDraftSource(envelope,expected){
          const name=envelope.snapshot&&envelope.snapshot.name||'원본';
          setDraftStatus('초안에는 편집만 있습니다. 이름이 '+String(name).slice(0,160)+' 이고 해시가 '+String(expected||'').slice(0,12)+'… 인 원본 PDF를 다시 선택한 뒤 초안 복구를 누르세요. 서버로 올리지 않습니다.',true);
    }
    function draftSourceMatches(expected,envelope){if(source&&source.fileHash===expected)return true;reportMissingDraftSource(envelope,expected);return false;}
    function needsDraftSource(expected){return !source||source.fileHash!==expected;}
    function canRestoreThroughInput(){return typeof DataTransfer==='function'&&typeof Event==='function';}
    async function restoreDraft(){
      const api=editsApi();
      const box=store();
      const draft=readDraftForRestore(api,box);if(!draft)return;
      const {envelope,extras,expected}=draft;
      if(needsDraftSource(expected)){
        const kept=await keptSource(expected);
        const file=kept&&fileFromKept(kept);
        if(file){
          setDraftStatus('이 브라우저에 보관한 원본 PDF를 다시 엽니다. 서버로 올리지 않습니다.');
          if(canRestoreThroughInput()){
            const transfer=new DataTransfer();transfer.items.add(file);ui.file.files=transfer.files;
            const selected=ui.file.files[0];
            // The normal input path clears the old source before asynchronously extracting it.
            await new Promise(resolve=>{
              let timeout;
              const finish=()=>{doc.removeEventListener('falsify:document',ready);timers.clearTimeout(timeout);resolve();};
              const ready=event=>{if(event.detail?.file===selected)finish();};
              doc.addEventListener('falsify:document',ready);
              timeout=timers.setTimeout(finish,60000);
              ui.file.dispatchEvent(new Event('change',{bubbles:true}));
            });
          }else await openFile(file);
        }
        if(!draftSourceMatches(expected,envelope))return;
      }
      let restored;
      try{restored=api.restoreDraft(envelope,{fileHash:source.fileHash,now:now()});}
      catch(e){setDraftStatus('초안을 복구하지 않았습니다. '+safeMessage(e),true);return;}
      try{if((restored.edits||[]).some(e=>String(e.segmentId||'').startsWith('table:'))&&!await discoverDraftTables(restored))return;
        if((restored.edits||[]).some(e=>typeof e.segmentId==='string'&&e.segmentId.startsWith('paragraph:'))&&!await discoverDraftParagraphs(restored))return;}
      catch(e){setDraftStatus('초안의 원문을 확인하지 못해 복구하지 않았습니다. '+safeMessage(e),true);return;}
      applyResume(restored);
      restoreDraftExtras(extras);
    }
    async function keptSource(hash){
      const blobs=blobApi();if(!blobs||!hash)return null;
      try{
        const kept=await blobs.get(hash);
        if(!kept||kept.fileHash!==hash||!(kept.expiresAt>now())||!kept.blob)return null;
        return kept;
      }catch{return null;}
    }
    function fileFromKept(kept){
      const blob=kept.blob;
      if(isFile(blob))return blob;
      if(typeof Blob!=='undefined'&&typeof File==='function'&&blob instanceof Blob)return new File([blob],sessionName(kept.name),{type:kept.type||blob.type||'application/pdf'});
      return null;
    }
    function deleteDraft(){
      if(draftTimer){timers.clearTimeout(draftTimer);draftTimer=null;}
      const hash=source&&source.fileHash||readIndex()[0]?.fileHash;
      const key=hash?'falsify.paper-draft.v1.'+hash:null,box=store();
      if(!key||!box){setDraftStatus('지울 초안이 없습니다.',true);return;}
      try{box.removeItem(key);writeIndex(readIndex().filter(row=>row.fileHash!==hash));}catch(e){setDraftStatus('초안을 지우지 못했습니다. '+safeMessage(e),true);return;}
      const blobs=blobApi();if(blobs&&hash)Promise.resolve(blobs.delete(hash)).catch(()=>{});
      draftRaw=null;setDraftStatus('이 브라우저의 초안을 지웠습니다.');renderChrome();
    }
    function share(){
      if(!output||output.blocked)return;
      emit('falsify:paper-team-share',published({sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0),name:output.file.name}));
      setGenStatus('팀 공개 요청만 보냈습니다. 동의 화면 없이 업로드하지 않으며, 비공개 초안은 포함하지 않습니다.');
    }
    function handoff(){
      if(!output||output.blocked||stale()||(inline&&(directEditor?directEditor.value:ui.inlineAfter.value)!==inline.after)){setGenStatus('현재 편집을 먼저 생성하세요.',true);return;}
      const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([output.file],'paper.pdf',{type:'application/pdf'})}});
      if(!doc.dispatchEvent(ev)){setGenStatus('BLUE가 인계를 받지 않았습니다. 생성본은 그대로입니다.');return;}
      const nav=[...doc.querySelectorAll('[data-view="blue"]')].find(b=>b.getClientRects&&b.getClientRects().length)||doc.querySelector('[data-view="blue"]');
      if(nav&&typeof nav.click==='function')nav.click();
    }
    function handleRedoKey(e){
      if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&(e.key==='y'||e.key==='Y')){
        e.preventDefault();
        if(session&&snapshot&&snapshot.canRedo)historyAction('redo');
        return true;
      }
      return false;
    }
    function handleHistoryKey(e){
      if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){
        e.preventDefault();
        if(!session)return true;
        if(e.shiftKey){if(snapshot&&snapshot.canRedo)historyAction('redo');}
        else if(snapshot&&snapshot.canUndo)historyAction('undo');
        return true;
      }
      if(handleRedoKey(e))return true;
      return false;
    }
    function handleNavigationKey(e){
      if(e.key==='ArrowRight'&&page<pages){e.preventDefault();void drawBefore(page+1);}
      else if(e.key==='ArrowLeft'&&page>1){e.preventDefault();void drawBefore(page-1);}
      else if((e.key==='+'||e.key==='=')&&!ui.zoomIn.disabled)ui.zoomIn.click();
      else if(e.key==='-'&&!ui.zoomOut.disabled)ui.zoomOut.click();
    }
    function onKey(e){
      if(e.defaultPrevented||e.isComposing||composingDirect)return;
      if(e.key==='Escape'&&inline){e.preventDefault();closeInline();return;}
      if(fieldTarget(e.target))return;
      if(handleHistoryKey(e))return;
      handleNavigationKey(e);
    }
    function onFileChange(){
      const file=ui.file.files&&ui.file.files[0]||null;
      if(!file){clearSource();return;}
      if(source&&source.file===file)return;
      void openFile(file);
    }
    function onDocument(event){
      const detail=event.detail||{},file=detail.file||null;
      const segments=detail.result&&Array.isArray(detail.result.segments)?detail.result.segments:null,matchSegments=detail.result?.matchSegments;
      if(!segments)return;
      if(source&&file&&source.file&&file!==source.file)return;
      if(!source){
        if(!file)return;
        const pending=openFile(file);
        void Promise.resolve(pending).then(()=>{if(source&&source.file===file)adoptSegments(segments,matchSegments);});
        return;
      }
      adoptSegments(segments,matchSegments);
    }
    listen(ui.file,'change',onFileChange);
    listen(doc,'falsify:document',onDocument);
    listen(doc,'falsify:document-clear',clearSource);
    listen(doc,'falsify:workspace-reset',clearSource);
    function jumpToTyped(){
      const n=Number(String(ui.pageJump.value||'').trim());
      if(!pages||!Number.isInteger(n)||n<1||n>pages){setBeforeStatus('없는 쪽 번호입니다.',true);ui.pageJump.value=pages?String(page):'';return;}
      if(n===page)return;
      void drawBefore(n);
    }
    listen(ui.prev,'click',()=>{if(page>1)void drawBefore(page-1);});
    listen(ui.next,'click',()=>{if(page<pages)void drawBefore(page+1);});
    listen(ui.pageJump,'change',jumpToTyped);
    listen(ui.pageJump,'keydown',e=>{if(e.key==='Enter'){e.preventDefault();jumpToTyped();}else onKey(e);});
    listen(ui.zoomIn,'click',()=>{const i=ZOOMS.indexOf(zoom);if(i<0||i>=ZOOMS.length-1)return;zoom=ZOOMS[i+1];syncNav();if(source&&source.doc)void drawBefore(page);});
    listen(ui.zoomOut,'click',()=>{const i=ZOOMS.indexOf(zoom);if(i<=0)return;zoom=ZOOMS[i-1];syncNav();if(source&&source.doc)void drawBefore(page);});
    listen(ui.original,'click',()=>{if(source)download(source.file);});
    listen(ui.current,'click',()=>{if(generationApi())void currentAction('download');else if(output&&!output.blocked)download(output.file,true);});
    listen(doc.querySelector('#paper-recompose'),'change',()=>{scheduleGeneration();renderChrome();});
    listen(doc,'falsify:recomposition-ready',renderChrome);
    listen(ui.generate,'click',()=>{if(!ui.generate.disabled){if(generationApi())void currentAction('preview');else void generate();}});
    listen(ui.generateCancel,'click',()=>{if(!generating)return;generator?.cancel();abortGen();renderChrome();setGenStatus('생성을 취소했습니다.');});
    listen(ui.fontLocal,'click',()=>{void importFonts(true);});
    listen(ui.fontAdd,'click',()=>{ui.fontFiles?.click();});
    listen(ui.fontFiles,'change',()=>{if(ui.fontFiles.files?.length)void importFonts(false);});
    listen(ui.team,'click',share);
    listen(ui.blue,'click',()=>{if(generationApi())void currentAction('blue');else handoff();});
    listen(ui.undo,'click',()=>{if(session&&snapshot&&snapshot.canUndo)historyAction('undo');});
    listen(ui.redo,'click',()=>{if(session&&snapshot&&snapshot.canRedo)historyAction('redo');});
    listen(ui.modeText,'click',()=>setEditMode('text'));
    listen(ui.modeTable,'click',()=>setEditMode('table'));
    listen(ui.inlineApply,'click',applyInline);
    listen(ui.inlineCancel,'click',closeInline);
    listen(ui.draftOpt,'change',renderChrome);
    listen(ui.draftSave,'click',saveDraft);
    listen(ui.draftRestore,'click',restoreDraft);
    listen(ui.draftDelete,'click',deleteDraft);
    listen(ui.beforeStage,'click',openParagraph);
    listen(ui.beforeStage,'pointerup',captureSelection);
    listen(ui.beforeStage,'mouseup',captureSelection);
    listen(ui.beforeStage,'keyup',captureSelection);
    listen(ui.root,'keydown',onKey);
    listen(ui.beforeStage,'keydown',onKey);
    listen(ui.inline,'keydown',onKey);
    listen(ui.inlineAfter,'keydown',onKey);
    listen(ui.inlineAfter,'input',()=>{queueDraft();scheduleGeneration();});
    for(const [node,name] of [[ui.original,'download'],[ui.generate,'pencil'],[ui.team,'users'],[ui.blue,'arrow-right'],[ui.undo,'refresh-cw'],[ui.current,'download'],[ui.draftDelete,'x']])paintIcon(node,name);
    renderChrome();renderInline();renderEdits();remindDraft();
    try{const blobs=blobApi();if(blobs?.purgeExpired)void blobs.purgeExpired(now()).catch(()=>{});}catch{}
    if(ui.file.files&&ui.file.files[0])void openFile(ui.file.files[0]);
    function publicOutput(){if(!output||output.blocked)return null;return Object.freeze({file:output.file,sha256:output.sha256,originalSourceSha256:output.originalSourceSha256,verification:published(output.verification),revision:output.revision,pageMap:published(output.pageMap),generationKey:output.key||null});}
    const api={
      dispose(){if(disposed)return;disposed=true;clearSource();for(const remove of listeners.splice(0))remove();blobStore?.dispose();lastDownload.remove();diagnosticPanel.remove();afterNav.remove();if(globalThis.FalsifyPaperWorkspace===api)delete globalThis.FalsifyPaperWorkspace;},
      acceptProposals,acceptExternalResponse,exportRedBatch,
      getExternalResponses(){return external?external.snapshot():null;},
      getSource(){if(!source||!source.file||!source.fileHash)return null;return Object.freeze({file:source.file,fileHash:source.fileHash,segments:published(source.segments)||[],externalSegments:published(externalSegments(source.segments))||[]});},
      getEditSnapshot(){const raw=session&&typeof session.snapshot==='function'?session.snapshot():snapshot;return raw?published(raw):null;},
      getOutput:publicOutput,
      getPageIndex(){return source?.pdf&&pages>0&&Number.isSafeInteger(page)&&page>=1&&page<=pages?page-1:null;},
      getCurrentOutput(){const g=generationApi();if(!output||output.blocked||!output.key||!g?.key)return null;try{if(g.key(captureSpec())!==output.key)return null;}catch{return null;}return publicOutput();}
    };
    return api;
  }
  return {create,pageIndexFromLabel,classifyProposals,anchorFromSelection,clampScale,TTL};
});

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
  function classifyOne(p,segs){
    const before=p&&typeof p.before==='string'?p.before:'';
    const after=p&&typeof p.after==='string'?p.after:'';
    const base={before,after,segmentId:null,pageIndex:null,anchor:null,status:'missing',matches:[],reason:'형식이 맞지 않습니다.'};
    if(!p||typeof p!=='object'||!before.trim()||before===after||before.length>4000||after.length>4000)return base;
    if(after!==''&&!after.trim())return {...base,reason:'공백만 있는 After는 삭제가 아닙니다.'};
    const hinted=p.anchor&&typeof p.anchor==='object'?p.anchor:null;
    const hintedStart=hinted&&Number.isSafeInteger(hinted.start)?hinted.start:null;
    const hintedEnd=hinted&&Number.isSafeInteger(hinted.end)?hinted.end:null;
    if(hintedStart!=null||hintedEnd!=null){
      if(hintedStart==null||hintedEnd==null||hintedStart<0||hintedEnd-hintedStart!==before.length)return {...base,reason:'지정한 범위가 Before 길이와 다릅니다.'};
      const id=typeof p.segmentId==='string'&&p.segmentId?p.segmentId:'';
      if(!id)return {...base,reason:'위치를 지정한 제안에는 문단 ID가 필요합니다.'};
      const seg=(Array.isArray(segs)?segs:[]).find(s=>s&&s.id===id);
      if(!seg||typeof seg.text!=='string')return {...base,reason:'해당 구간이 원문에 없습니다.'};
      if(seg.text.slice(hintedStart,hintedEnd)!==before)return {...base,reason:'지정한 위치의 원문이 Before와 다릅니다.'};
      const page=segmentPage(seg);
      if(!Number.isSafeInteger(page)||page<0)return {...base,reason:'쪽 번호를 확정하지 못했습니다.'};
      if(Number.isSafeInteger(p.pageIndex)&&p.pageIndex!==page)return {...base,status:'ambiguous',reason:'제안의 쪽 번호와 원문 위치가 다릅니다.'};
      const occurrence=occurrenceOf(seg.text,before,hintedStart);
      if(!Number.isSafeInteger(occurrence))return {...base,reason:'지정한 범위의 occurrence를 세지 못했습니다.'};
      if(Number.isSafeInteger(hinted.occurrence)&&hinted.occurrence!==occurrence)return {...base,reason:'occurrence가 지정한 범위와 다릅니다.'};
      const anchor={start:hintedStart,end:hintedEnd,occurrence};
      return {before,after,segmentId:seg.id,pageIndex:page,anchor,status:'matched',matches:[{segmentId:seg.id,pageIndex:page,start:hintedStart,end:hintedEnd,occurrence}],reason:''};
    }
    let pool=Array.isArray(segs)?segs:[];
    if(typeof p.segmentId==='string'&&p.segmentId){
      pool=pool.filter(s=>s&&s.id===p.segmentId);
      if(!pool.length)return {...base,reason:'해당 구간이 원문에 없습니다.'};
    }
    const matches=[];
    for(const seg of pool){
      if(!seg||typeof seg.text!=='string'||typeof seg.id!=='string')continue;
      const at=seg.text.indexOf(before);
      if(at<0)continue;
      if(seg.text.indexOf(before,at+1)>=0)return {...base,status:'ambiguous',reason:'한 구간 안에 같은 Before가 둘 이상입니다.'};
      matches.push({segmentId:seg.id,pageIndex:segmentPage(seg),start:at,end:at+before.length});
    }
    if(!matches.length)return {...base,reason:'원문에서 정확히 한 번 찾지 못했습니다.'};
    if(matches.length>1)return {...base,status:'ambiguous',matches,reason:'같은 Before가 둘 이상의 구간에 있습니다.'};
    const m=matches[0];
    if(!Number.isSafeInteger(m.pageIndex)||m.pageIndex<0)return {...base,matches,reason:'쪽 번호를 확정하지 못했습니다.'};
    if(Number.isSafeInteger(p.pageIndex)&&p.pageIndex!==m.pageIndex)return {...base,status:'ambiguous',matches,reason:'제안의 쪽 번호와 원문 위치가 다릅니다.'};
    return {before,after,segmentId:m.segmentId,pageIndex:m.pageIndex,anchor:{start:m.start,end:m.end,occurrence:0},status:'matched',matches,reason:''};
  }
  function classifyProposals(proposals,segments,options){
    const norm=normalizeOrigin(options);
    const segs=Array.isArray(segments)?segments:[];
    const originals=segs.filter(s=>s&&typeof s.id==='string'&&!s.id.startsWith('paragraph:'));
    const items=(Array.isArray(proposals)?proposals:[]).map(p=>classifyOne(p,segs.filter(s=>{
      if(!s||typeof s.id!=='string'||!s.id.startsWith('paragraph:')||p&&p.segmentId===s.id)return true;
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
  function anchorFromSelection(items,viewBox,hitIndexes,geometry){
    const meta=geometry&&typeof geometry==='object'?geometry:{};
    const rotation=pageRotation(meta.rotation);
    if(rotation!==0)return null;
    const box=Array.isArray(viewBox)&&viewBox.length>=4?viewBox:[0,0,0,0];
    const pageWidth=Number.isFinite(meta.pageWidth)?meta.pageWidth:box[2]-box[0];
    const pageHeight=Number.isFinite(meta.pageHeight)?meta.pageHeight:box[3]-box[1];
    if(!(pageWidth>0&&pageHeight>0))return null;
    if(!Array.isArray(items))return null;
    const index=indexItems(items);
    const range=meta.range&&typeof meta.range==='object'?meta.range:null;
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
    if(!(start<end)||start<0||end>index.text.length)return null;
    for(let k=1;k<ordered.length;k++){
      const gap=index.text.slice(ordered[k-1].end,ordered[k].start);
      if(gap!==''&&gap!==' '&&gap!=='\n')return null;
    }
    const before=index.text.slice(start,end);
    if(!before.trim())return null;
    const occurrence=occurrenceOf(index.text,before,start);
    if(!Number.isSafeInteger(occurrence))return null;
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
    'edited-flow-text-or-order-mismatch':'이어지는 본문 내용 또는 순서가 원문·편집과 다름',
    'glyph-overlap-increased':'글자 겹침이 늘어남',
    'header-footer-moved':'머리말 또는 꼬리말 위치가 바뀜',
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
    if(status==='failed'||status==='warning')return (stale?'그 사이 편집이 바뀌어 마지막 생성본으로만 표시합니다. ':'')+'검증 상태는 '+status+'입니다. 이 파일은 받을 수 있습니다.';
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
  function coreSegments(raw){
    const list=Array.isArray(raw)?raw:[];
    const out=[],ids=new Set();
    for(let i=0;i<list.length&&out.length<2000;i++){
      const s=list[i];
      if(!s||typeof s!=='object')continue;
      const text=typeof s.text==='string'?s.text:'';
      if(text.length>200000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))continue;
      let id=typeof s.id==='string'&&s.id.trim()===s.id&&s.id.length<=80?s.id:'';
      if(!id)id='s'+i;
      if(ids.has(id))continue;
      ids.add(id);
      let label=typeof s.label==='string'&&s.label.trim()===s.label&&s.label.length>=1&&s.label.length<=200&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s.label)?s.label:'';
      const page=segmentPage(s);
      if(!label)label=Number.isSafeInteger(page)&&page>=0?'PDF p. '+(page+1):'문단 '+(out.length+1);
      const row={id,label,text};
      if(Number.isSafeInteger(page)&&page>=0&&page<=9999)row.pageIndex=page;
      out.push(row);
    }
    return out;
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
    const rotation=pageRotation(visual&&visual.rotation);
    const coordinate=visual&&visual.coordinate;
    if(rotation===0&&(coordinate==null||coordinate==='top-left')&&validBbox(visual&&visual.bbox))anchor.bbox=visual.bbox.slice();
    return {anchor};
  }

  function create(deps){
    deps=deps||{};
    const doc=deps.document;
    if(!doc||typeof doc.querySelector!=='function')throw new Error('document required');
    const need=id=>{const node=doc.querySelector('#'+id);if(!node)throw new Error('missing #'+id);return node;};
    const ui={
      root:need('paper-workspace'),status:need('paper-workspace-status'),file:need('paper-file'),
      original:need('paper-original-download'),prev:need('paper-page-prev'),pageLabel:need('paper-page-label'),pageJump:need('paper-page-jump'),next:need('paper-page-next'),
      zoomOut:need('paper-zoom-out'),zoomLabel:need('paper-zoom-label'),zoomIn:need('paper-zoom-in'),
      beforeStage:need('paper-before-stage'),beforeStatus:need('paper-before-status'),
      afterLabel:need('paper-after-label'),afterStage:need('paper-after-stage'),afterStatus:need('paper-after-status'),
      inline:need('paper-inline'),inlineMeta:need('paper-inline-meta'),inlineBefore:need('paper-inline-before'),inlineAfter:need('paper-inline-after'),
      inlineApply:need('paper-inline-apply'),inlineCancel:need('paper-inline-cancel'),
      coreNote:need('paper-core-note'),editStatus:need('paper-edit-status'),undo:need('paper-undo'),redo:need('paper-redo'),edits:need('paper-edits'),
      exportNote:need('paper-export-note'),generate:need('paper-generate'),genStatus:need('paper-generate-status'),hash:need('paper-output-hash'),
      current:need('paper-current-download'),team:need('paper-team-share'),blue:need('paper-blue-handoff'),
      draftOpt:need('paper-draft-opt'),draftSource:need('paper-draft-source'),draftSave:need('paper-draft-save'),draftRestore:need('paper-draft-restore'),draftDelete:need('paper-draft-delete'),draftStatus:need('paper-draft-status'),
      proposals:need('paper-proposals'),proposalList:need('paper-proposal-list'),proposalStatus:need('paper-proposal-status')
    };
    const timers=deps.timers||globalThis,urls=deps.urls||globalThis.URL;
    const now=()=>typeof deps.now==='function'?deps.now():Date.now();
    const previewApi=()=>deps.preview||globalThis.FalsifyPreview||null;
    const editsApi=()=>deps.edits||globalThis.FalsifyPaperEdits||null;
    const paragraphApi=()=>deps.paragraphPdf||globalThis.FalsifyParagraphPdf||null;
    const legacyExporterApi=()=>deps.exporter||globalThis.FalsifyBrowserPdf||null;
    const exporterApi=()=>{
      const edits=enabledEdits(),flow=paragraphApi();
      if(edits.some(e=>String(e.segmentId||'').startsWith('paragraph:')))return flow;
      if(flow&&edits.some(e=>e.origin==='ai-proposal'||e.origin==='external-ai-import'))return flow;
      return legacyExporterApi()||flow;
    };
    const store=()=>{try{return deps.storage||globalThis.localStorage||null;}catch{return null;}};
    function blobApi(){
      if(deps.sourceBlobs)return deps.sourceBlobs;
      const idb=globalThis.indexedDB;
      if(!idb)return null;
      const open=()=>new Promise((ok,no)=>{
        const req=idb.open('falsify.paper-source.v1',1);
        req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('files'))db.createObjectStore('files');};
        req.onsuccess=()=>ok(req.result);req.onerror=()=>no(req.error);
      });
      const done=(q,ok,no)=>{q.onsuccess=()=>ok(q.result);q.onerror=()=>no(q.error);};
      return {
        get:hash=>open().then(db=>new Promise((ok,no)=>done(db.transaction('files').objectStore('files').get(hash),ok,no))),
        put:(hash,record)=>open().then(db=>new Promise((ok,no)=>done(db.transaction('files','readwrite').objectStore('files').put(record,hash),ok,no))),
        delete:hash=>open().then(db=>new Promise((ok,no)=>done(db.transaction('files','readwrite').objectStore('files').delete(hash),ok,no))),
        purgeExpired:at=>open().then(db=>new Promise((ok,no)=>{
          const tx=db.transaction('files','readwrite'),cursor=tx.objectStore('files').openCursor();
          cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(!(row.value?.expiresAt>at))row.delete();row.continue();};
          tx.oncomplete=()=>{db.close();ok();};tx.onerror=()=>{db.close();no(tx.error);};
        }))
      };
    }
    let epoch=0,source=null,session=null,unsub=null,snapshot=null,output=null,inline=null,pageText=null;
    let proposalQueue=null,accepted=new Set(),modelById=new Map(),draftRaw=null,pendingFocus=null,pendingResume=null;
    let inspectCtl=null,resumeCtl=null,afterPart=0,afterSourcePage=0;
    let page=1,pages=0,zoom=1,drawSeq=0,afterSeq=0,loadTask=null,textLayerHandle=null,genCtl=null,genId=0,generating=false,afterTask=null,afterRender=null;

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
    function stale(){return !!output&&(!snapshot||snapshot.revision!==output.revision);}
    function enabledEdits(){return (snapshot&&snapshot.edits||[]).filter(e=>e&&e.enabled!==false);}
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
      const zi=ZOOMS.indexOf(zoom);
      ui.zoomOut.disabled=!source||!source.doc||zi<=0;
      ui.zoomIn.disabled=!source||!source.doc||zi<0||zi>=ZOOMS.length-1;
      ui.zoomLabel.textContent=Math.round(zoom*100)+'%';
      handFocus(doc.activeElement,ui.zoomIn,ui.zoomOut);handFocus(doc.activeElement,ui.zoomOut,ui.zoomIn);
    }
    function renderChrome(){
      const pdf=!!(source&&source.pdf),ready=!!(source&&source.fileHash);
      ui.original.disabled=!source;
      ui.coreNote.textContent=editsApi()?'':'편집 코어가 아직 없습니다. 쪽 보기와 원본 다운로드는 사용할 수 있지만 편집은 저장되지 않습니다.';
      ui.exportNote.textContent=!pdf&&source?'PDF가 아니라 브라우저에서 생성본을 만들지 않습니다.':exporterApi()?'':'브라우저 PDF 편집 모듈이 아직 없습니다. 생성본을 만들지 않으며, 성공으로 표시하지 않습니다.';
      ui.generate.disabled=generating||!exporterApi()||!pdf||!enabledEdits().length;
      ui.draftSave.disabled=!(ui.draftOpt.checked&&session&&ready);
      const hasDraft=!!draftRaw||readIndex().length>0;
      ui.draftRestore.hidden=!hasDraft;
      ui.draftDelete.disabled=!hasDraft;
      const blocked=!output||output.blocked;
      ui.current.disabled=blocked;
      ui.current.textContent=output&&stale()?'마지막 생성본 다운로드':'현재 생성본 다운로드';
      ui.team.disabled=blocked;
      ui.blue.disabled=blocked;
      ui.hash.textContent=output&&!output.blocked?'SHA-256 '+output.sha256:'';
      ui.afterLabel.textContent=!output?'아직 생성본이 없습니다':stale()?'마지막 생성본 · 현재 편집과 다름':'현재 생성본';
      syncNav();
    }
    function narrowViewport(){
      try{return typeof matchMedia==='function'&&!!matchMedia('(max-width:700px)').matches;}catch{return false;}
    }
    function placeInline(){
      ui.inline.classList.remove('is-open','is-docked');
      if(ui.inline.style){ui.inline.style.left='';ui.inline.style.top='';}
      if(!inline)return;
      ui.inline.classList.add('is-open');
      const rect=inline.clientRect;
      let rootRect=null;
      try{rootRect=typeof ui.root.getBoundingClientRect==='function'?ui.root.getBoundingClientRect():null;}catch{rootRect=null;}
      if(narrowViewport()||!rect||!(rect.width>0)||!rootRect||!(rootRect.width>0)){ui.inline.classList.add('is-docked');return;}
      ui.inline.style.left=round(Math.max(8,rect.left-rootRect.left))+'px';
      ui.inline.style.top=round(Math.max(8,rect.bottom-rootRect.top+8))+'px';
    }
    function renderInline(){
      ui.inline.hidden=!inline;
      if(!inline){ui.inlineBefore.textContent='';ui.inlineMeta.textContent='';ui.inlineAfter.value='';placeInline();return;}
      ui.inlineBefore.textContent=inline.before;
      ui.inlineAfter.value=typeof inline.after==='string'?inline.after:'';
      const box=inline.anchor&&inline.anchor.bbox;
      ui.inlineMeta.textContent='쪽 '+(inline.pageIndex+1)+(Number.isSafeInteger(inline.anchor&&inline.anchor.occurrence)?' · occurrence '+inline.anchor.occurrence:'')+(box?' · 좌표 '+box.join(', '):'');
      placeInline();
    }
    function segmentFor(before,anchor,pageIndex){
      const all=coreSegments(source&&source.segments).filter(s=>segmentPage(s)===pageIndex);
      // Paragraph discovery must not make a previously unique word selection ambiguous.
      // Keep the original extraction catalog as the first binding choice for selection edits.
      for(const segs of [all.filter(s=>!s.id.startsWith('paragraph:')),all.filter(s=>s.id.startsWith('paragraph:'))]){
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
    function renderEdits(){
      const active=doc.activeElement;
      const keep=!pendingFocus&&active&&ui.edits.contains&&ui.edits.contains(active)?{id:active.dataset&&active.dataset.edit,act:active.dataset&&active.dataset.act}:pendingFocus;
      pendingFocus=null;
      ui.edits.replaceChildren();
      const edits=snapshot&&snapshot.edits||[];
      if(!edits.length){const li=doc.createElement('li');li.textContent='아직 편집이 없습니다.';ui.edits.append(li);}
      for(const edit of edits){
        const li=doc.createElement('li');
        const jump=doc.createElement('button');jump.type='button';jump.className='button secondary';jump.dataset.edit=edit.id;jump.dataset.act='jump';
        jump.textContent='쪽 '+(Number(edit.pageIndex)+1)+' · '+String(edit.before||'').slice(0,40)+' → '+String(edit.after||'').slice(0,40);
        const toggle=doc.createElement('button');toggle.type='button';toggle.className='button secondary';toggle.dataset.edit=edit.id;toggle.dataset.act='toggle';
        toggle.textContent=edit.enabled===false?'켜기':'끄기';toggle.setAttribute('aria-pressed',String(edit.enabled!==false));
        const change=doc.createElement('button');change.type='button';change.className='button secondary';change.dataset.edit=edit.id;change.dataset.act='edit';change.textContent='After 수정';
        const del=doc.createElement('button');del.type='button';del.className='button secondary';del.dataset.edit=edit.id;del.dataset.act='delete';del.textContent='삭제';
        const note=doc.createElement('span');note.className='paper-edit-origin';note.textContent=originText(edit.origin,modelById.get(edit.id));
        const cause=editCause(edit.id);
        jump.addEventListener('click',()=>onJump(edit));
        toggle.addEventListener('click',()=>{if(session)session.setEnabled(edit.id,edit.enabled===false);});
        change.addEventListener('click',()=>loadInline(edit));
        del.addEventListener('click',()=>onDelete(edit));
        li.append(jump,toggle,change,del,note);if(cause)li.append(cause);ui.edits.append(li);
      }
      ui.undo.disabled=!snapshot||!snapshot.canUndo;
      ui.redo.disabled=!snapshot||!snapshot.canRedo;
      if(keep&&keep.act==='undo')ui.undo.focus();
      else if(keep&&keep.id){
        const found=buttons(ui.edits).find(b=>b.dataset.edit===keep.id&&(!keep.act||b.dataset.act===keep.act))||buttons(ui.edits).find(b=>b.dataset.edit===keep.id);
        if(found)found.focus();else ui.undo.focus();
      }
      renderChrome();
    }
    function editCause(id){
      if(!output||output.blocked||!id)return null;
      const verification=output.verification,phrases=[];let failed=false;
      const add=(phrase,isFailed)=>{if(!phrase||phrases.includes(phrase)||phrases.length>=4)return;phrases.push(phrase);if(isFailed)failed=true;};
      const warnings=[];
      if(Array.isArray(output.warnings))warnings.push(...output.warnings);
      if(verification&&Array.isArray(verification.warnings))warnings.push(...verification.warnings);
      for(const item of warnings){if(!item||typeof item!=='object'||item.editId!==id)continue;add(causePhrase(item),false);}
      const rows=verification&&Array.isArray(verification.edits)?verification.edits.filter(row=>row&&row.id===id):[];
      if(rows.some(row=>row.status==='failed'))failed=true;
      const checks=[];
      if(verification&&Array.isArray(verification.checks))checks.push(...verification.checks);
      for(const row of rows)if(Array.isArray(row.checks))checks.push(...row.checks);
      for(const item of checks){if(!item||typeof item!=='object'||item.id!==id)continue;add(causePhrase(item),item.status==='failed');}
      if(!phrases.length)return null;
      const span=doc.createElement('span');span.className=failed?'paper-edit-cause is-failed':'paper-edit-cause';
      const status=verification&&typeof verification.status==='string'?verification.status:'';
      span.textContent=(status==='failed'||status==='warning'?'검증 '+status:'검증')+' · '+phrases.join(' · ');
      return span;
    }
    function paintProposals(){
      const queue=proposalQueue;
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
    function onSnapshot(snap){
      try{
        snapshot=snap;const copy=published(snap);if(copy)emit('falsify:paper-workspace-edits',copy);renderEdits();paintProposals();void drawAfter();
      }catch(e){setEditStatus('편집 목록을 그리지 못했습니다. '+safeMessage(e),true);}
    }
    function watchSession(next){
      if(typeof unsub==='function')unsub();
      session=next;
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
    function adoptSegments(raw){
      if(!source)return;
      const paragraphs=(source.segments||[]).filter(s=>s.id.startsWith('paragraph:'));
      source.segments=coreSegments(raw).filter(s=>!paragraphs.some(p=>p.id===s.id)).concat(paragraphs);
      if(session&&typeof session.addSegments==='function'){
        try{session.addSegments(coreSegments(source.segments));}
        catch(e){setEditStatus('새 원문 구간을 연결하지 못했습니다. '+safeMessage(e),true);return;}
      }
      if(pendingResume){applyResume(pendingResume);if(source.fileHash)emit('falsify:paper-workspace-source',{fileHash:source.fileHash,name:source.name});paintProposals();return;}
      ensureSession(!(snapshot&&snapshot.edits&&snapshot.edits.length));
      if(source.fileHash)emit('falsify:paper-workspace-source',{fileHash:source.fileHash,name:source.name});
      paintProposals();
    }
    function stopPdf(){
      drawSeq++;
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
      try{afterTask&&afterTask.destroy&&afterTask.destroy();}catch{}
      afterTask=null;afterRender=null;
    }
    function closeAfter(){afterSeq++;releaseAfter();afterNav.hidden=true;}
    function abortGen(){genId++;if(genCtl){genCtl.abort();genCtl=null;}generating=false;}
    function clearSource(){
      epoch++;abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      unsub=null;session=null;snapshot=null;output=null;inline=null;pageText=null;proposalQueue=null;accepted=new Set();draftRaw=null;pendingResume=null;
      source=null;pages=0;page=1;zoom=1;
      clearStage(ui.beforeStage);clearStage(ui.afterStage);
      renderInline();renderEdits();paintProposals();renderChrome();
      setStatus('');setBeforeStatus('');setAfterStatus('');
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
      const mine=++epoch;
      abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      unsub=null;session=null;snapshot=null;output=null;inline=null;pageText=null;proposalQueue=null;accepted=new Set();draftRaw=null;pendingResume=null;
      pages=0;page=1;zoom=1;
      source={file,fileHash:null,name:sessionName(file.name),segments:[],pdf:isPdf(file),doc:null,lib:null,render:null};
      clearStage(ui.beforeStage);clearStage(ui.afterStage);renderInline();renderEdits();paintProposals();renderChrome();
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
    async function openPdf(bytes,mine){
      const preview=previewApi();
      if(!preview||typeof preview.defaultImport!=='function'||typeof preview.pdfParams!=='function'||typeof preview.fitScale!=='function'){
        setStatus('PDF.js 도우미가 없어 쪽을 그리지 못했습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;
      }
      if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0){
        setStatus('PDF 서명이 없어 쪽을 그리지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;
      }
      setStatus('PDF를 이 브라우저에서 여는 중입니다.');
      let settled=false;
      const timer=timers.setTimeout(()=>{
        if(epoch!==mine||settled)return;settled=true;stopPdf();
        setStatus('60초 안에 PDF를 열지 못해 쪽 보기를 멈췄습니다. 원본 다운로드는 사용할 수 있습니다.',true);
      },60000);
      try{
        const lib=await preview.defaultImport();
        if(epoch!==mine||settled)return;
        source.lib=lib;
        if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));
        loadTask=task;
        const pdf=await task.promise;
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);
        source.doc=pdf;pages=pdf.numPages;renderChrome();
        setStatus('');
        await drawBefore(1,mine);
      }catch(e){
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);
        const name=e&&e.name;
        const msg=name==='PasswordException'?'암호가 걸린 PDF라 쪽을 그리지 못했습니다.':name==='InvalidPDFException'?'PDF 구조를 읽지 못해 쪽을 그리지 못했습니다.':'이 브라우저에서 쪽을 그리지 못했습니다.';
        setStatus(msg+' 원본 다운로드는 사용할 수 있습니다.',true);
      }
    }
    async function drawBefore(n,mine){
      mine=mine==null?epoch:mine;
      if(!source||!source.doc||!Number.isSafeInteger(n)||n<1||n>pages||epoch!==mine)return;
      const seq=++drawSeq,live=()=>epoch===mine&&seq===drawSeq;
      if(inspectCtl){inspectCtl.abort();inspectCtl=null;}
      pageText=null;
      if(inline&&ui.inlineAfter.value===inline.after){inline=null;renderInline();}
      if(page!==n){afterPart=0;afterSourcePage=n;}
      page=n;renderChrome();
      try{source.render&&source.render.cancel&&source.render.cancel();}catch{}
      try{textLayerHandle&&textLayerHandle.cancel&&textLayerHandle.cancel();}catch{}
      setBeforeStatus(n+' / '+pages+'쪽을 그리는 중입니다.');
      let canvas=null,pdfPage=null;
      try{
        pdfPage=await source.doc.getPage(n);
        if(!live())return;
        const base=pdfPage.getViewport({scale:1});
        const preview=previewApi();
        const scale=clampScale(base,ui.beforeStage.clientWidth||0,zoom,preview&&preview.fitScale);
        if(!(scale>0))throw new Error('scale');
        const viewport=pdfPage.getViewport({scale});
        const pageEl=doc.createElement('div');pageEl.className='paper-page';
        pageEl.style.width=viewport.width+'px';pageEl.style.height=viewport.height+'px';
        pageEl.style.setProperty('--total-scale-factor',String(scale));
        pageEl.style.setProperty('--scale-round-x','1px');pageEl.style.setProperty('--scale-round-y','1px');
        pageEl.style.setProperty('--text-scale-factor','1');
        canvas=doc.createElement('canvas');canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label','원본 '+n+'쪽');
        const textEl=doc.createElement('div');textEl.className='paper-text-layer textLayer';
        pageEl.append(canvas,textEl);
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        source.render=renderTask;
        const contentPromise=pdfPage.getTextContent();
        await renderTask.promise;
        if(!live()){canvas.width=0;canvas.height=0;pdfPage.cleanup&&pdfPage.cleanup();return;}
        const content=await contentPromise;
        if(!live()){pdfPage.cleanup&&pdfPage.cleanup();return;}
        const items=Array.isArray(content.items)?content.items:[];
        if(source.lib&&source.lib.TextLayer){
          const handle=new source.lib.TextLayer({textContentSource:content,container:textEl,viewport});
          textLayerHandle=handle;
          await handle.render();
          if(!live()){handle.cancel&&handle.cancel();pdfPage.cleanup&&pdfPage.cleanup();return;}
          const divs=handle.textDivs||[];
          items.forEach((item,i)=>{if(divs[i]&&divs[i].dataset)divs[i].dataset.i=String(i);});
        }
        const viewBox=viewport.viewBox||[0,0,base.width,base.height];
        const rotation=pageRotation(viewport.rotation);
        pageText={items,viewBox,pageIndex:n-1,textEl,pageEl,rotation,pageWidth:viewBox[2]-viewBox[0],pageHeight:viewBox[3]-viewBox[1],scale};
        clearStage(ui.beforeStage);ui.beforeStage.append(pageEl);
        pdfPage.cleanup&&pdfPage.cleanup();source.render=null;
        setBeforeStatus(n+' / '+pages+'쪽 · 원본 바이트'+(rotation?' · 회전된 쪽이라 좌표 편집은 받지 않습니다':''));
        renderChrome();void drawAfter();void inspectParagraphs(pageText,mine,seq);
      }catch(e){
        if(!live()||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        clearStage(ui.beforeStage);
        setBeforeStatus(n+'쪽을 그리지 못했습니다. 다른 쪽은 이전·다음으로 시도할 수 있습니다.',true);
      }
    }
    async function inspectParagraphs(display,mine,seq){
      const api=paragraphApi();
      if(!api||typeof api.inspectPage!=='function'||!source||display.rotation)return;
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      inspectCtl=ctl;
      const file=source.file,hash=source.fileHash;
      try{
        const found=await api.inspectPage({file,fileHash:hash,pageIndex:display.pageIndex,signal:ctl.signal});
        if(epoch!==mine||seq!==drawSeq||pageText!==display||!source||source.file!==file||ctl.signal?.aborted)return;
        if(found.fileHash!==hash||found.pageIndex!==display.pageIndex||found.rotation||!(found.width>0)||!(found.height>0))throw new Error('문단 위치가 원본과 맞지 않습니다.');
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
        setBeforeStatus((display.pageIndex+1)+' / '+pages+'쪽 · 원본 바이트 · 문단을 클릭해 편집');
      }catch(e){
        if(epoch!==mine||seq!==drawSeq||pageText!==display||ctl.signal?.aborted)return;
        setBeforeStatus((display.pageIndex+1)+' / '+pages+'쪽 · 문단을 읽지 못했습니다. 글 선택 편집은 사용할 수 있습니다. '+safeMessage(e),true);
      }finally{if(inspectCtl===ctl)inspectCtl=null;}
    }
    function openParagraph(event){
      if(!pageText||!pageText.paragraphs||inline||event.detail>1||fieldTarget(event.target))return;
      const sel=typeof doc.getSelection==='function'?doc.getSelection():null;
      if(sel&&!sel.isCollapsed)return;
      const rect=pageText.pageEl.getBoundingClientRect();
      if(!(rect.width>0&&rect.height>0)||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
      const x=(event.clientX-rect.left)*pageText.paragraphWidth/rect.width;
      const y=(event.clientY-rect.top)*pageText.paragraphHeight/rect.height;
      const hits=pageText.paragraphs.filter(p=>x>=p.bbox[0]&&x<=p.bbox[2]&&y>=p.bbox[1]&&y<=p.bbox[3]);
      if(hits.length!==1)return;
      const p=hits[0],id='paragraph:'+pageText.pageIndex+':'+p.id;
      if(p.editable===false){setEditStatus('이 문단은 흐름 편집을 지원하지 않습니다. 글 선택 편집으로 위치를 확인할 수 있습니다.',true);return;}
      const existing=(snapshot&&snapshot.edits||[]).find(e=>e.segmentId===id&&e.before===p.text);
      const anchor={start:0,end:p.text.length,occurrence:0,bbox:p.bbox.slice(),coordinate:'top-left',rotation:0};
      inline={before:p.text,after:existing?existing.after:p.text,anchor,pageIndex:pageText.pageIndex,segmentId:id,editId:existing?existing.id:null,
        clientRect:{left:rect.left+p.bbox[0]*rect.width/pageText.paragraphWidth,bottom:rect.top+p.bbox[3]*rect.height/pageText.paragraphHeight,width:(p.bbox[2]-p.bbox[0])*rect.width/pageText.paragraphWidth}};
      renderInline();ui.inlineAfter.focus();
    }
    function itemElement(node,textEl){
      let n=node&&node.nodeType===3?(node.parentElement||node.parentNode):node;
      while(n&&n!==textEl){
        if(n.dataset&&n.dataset.i!=null)return n;
        n=n.parentElement||n.parentNode;
      }
      return null;
    }
    function charOffset(span,container,offset){
      const at=Number(offset);
      if(!span||!Number.isInteger(at)||at<0)return null;
      const kids=span.childNodes?Array.from(span.childNodes):[];
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
    function captureSelection(){
      if(inline&&ui.inlineAfter.value!==inline.after)return;
      const sel=typeof doc.getSelection==='function'?doc.getSelection():null;
      if(!sel||sel.isCollapsed||!sel.rangeCount||!pageText||!pageText.textEl)return;
      const textEl=pageText.textEl;
      let range=null;
      try{range=sel.getRangeAt(0);}catch{range=null;}
      if(!range)return;
      const inside=node=>!!(node&&textEl.contains&&textEl.contains(node));
      if(!inside(range.commonAncestorContainer)&&!inside(sel.anchorNode)&&!inside(range.startContainer))return;
      if(pageText.rotation){setEditStatus('회전된 쪽은 위쪽 원점 좌표로 확정할 수 없어 편집으로 넣지 않았습니다.',true);return;}
      const geometry={rotation:0,pageWidth:pageText.pageWidth,pageHeight:pageText.pageHeight};
      const hits=[];
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
      if(!geometry.range){
        for(const node of textEl.querySelectorAll?textEl.querySelectorAll('span'):[]){
          if(!node.dataset||node.dataset.i==null)continue;
          let hit=false;
          try{hit=range.intersectsNode?range.intersectsNode(node):false;}catch{hit=false;}
          if(hit)hits.push(Number(node.dataset.i));
        }
        if(!hits.length&&sel.anchorNode){
          const el=sel.anchorNode.dataset?sel.anchorNode:sel.anchorNode.parentElement;
          if(el&&el.dataset&&el.dataset.i!=null&&inside(el))hits.push(Number(el.dataset.i));
        }
      }
      if(!hits.length){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      const located=anchorFromSelection(pageText.items,pageText.viewBox,hits,geometry);
      if(!located){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      const segment=segmentFor(located.before,located.anchor,pageText.pageIndex);
      inline={before:located.before,after:located.before,anchor:located.anchor,pageIndex:pageText.pageIndex,segmentId:segment?segment.id:undefined,editId:null,clientRect:clientBox(range)};
      renderInline();ui.inlineAfter.focus();
    }
    function loadInline(edit){
      inline={before:edit.before,after:edit.after,anchor:edit.anchor,pageIndex:edit.pageIndex,segmentId:edit.segmentId,editId:edit.id};
      onJump(edit);renderInline();ui.inlineAfter.focus();
    }
    function crossAliasOverlap(candidate){
      const box=candidate.anchor&&candidate.anchor.bbox;
      return (snapshot&&snapshot.edits||[]).some(e=>{
        if(e.pageIndex!==candidate.pageIndex||e.segmentId===candidate.segmentId)return false;
        const other=e.anchor&&e.anchor.bbox;
        return validBbox(box)&&validBbox(other)?box[0]<other[2]&&box[2]>other[0]&&box[1]<other[3]&&box[3]>other[1]:candidate.before.includes(e.before)||e.before.includes(candidate.before);
      });
    }
    function applyInline(){
      const api=editsApi();
      if(!api||!session){setEditStatus('편집 코어가 없어 편집을 저장하지 않았습니다.',true);return;}
      const after=ui.inlineAfter.value;
      if(!inline||typeof after!=='string'){setEditStatus('After를 확인하지 못했습니다.',true);return;}
      if(after!==''&&!after.trim()){setEditStatus('공백만 있는 After는 저장하지 않습니다. 문장을 지우려면 After를 비우세요.',true);return;}
      if(after===inline.before){setEditStatus('After가 Before와 같아 저장하지 않았습니다.',true);return;}
      if(!inline.editId&&crossAliasOverlap(inline)){setEditStatus('같은 위치에 기록한 편집이 있습니다. 기존 편집을 수정하거나 삭제한 뒤 적용하세요.',true);return;}
      try{
        if(inline.editId)session.update(inline.editId,{after});
        else{
          const segs=coreSegments(source.segments);
          let segment=inline.segmentId?segs.find(s=>s.id===inline.segmentId):null;
          if(segment&&inline.anchor&&segment.text.slice(inline.anchor.start,inline.anchor.end)!==inline.before)segment=null;
          if(!segment)segment=segmentFor(inline.before,inline.anchor,inline.pageIndex);
          if(!segment){setEditStatus(segs.length?'같은 원문이 한 문단으로 확정되지 않아 편집으로 넣지 않았습니다.':'원문 구간이 아직 없어 편집으로 넣지 않았습니다. 추출 뒤에 다시 시도하세요.',true);return;}
          const built=coreAnchor(inline.anchor,segment,inline.before);
          if(built.error){setEditStatus(built.error,true);return;}
          session.add({pageIndex:inline.pageIndex,segmentId:segment.id,before:inline.before,after,anchor:built.anchor,origin:'human'});
        }
        inline=null;renderInline();ui.beforeStage.focus();
        setEditStatus('직접 편집으로 기록했습니다. 모델 실행으로 기록하지 않습니다.');
      }catch(e){setEditStatus('편집을 저장하지 않았습니다. '+safeMessage(e),true);}
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
      pendingFocus=neighbor?{id:neighbor.id,act:'jump'}:{act:'undo'};
      session.remove(edit.id);
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
        const geometry=pageText&&pageText.pageIndex===item.pageIndex?{rotation:pageText.rotation,pageWidth:pageText.pageWidth,pageHeight:pageText.pageHeight}:null;
        const visual=geometry&&!geometry.rotation?visualAnchor(pageText.items,pageText.viewBox,item.before,geometry):null;
        const hinted=Object.assign({},item.anchor||{});
        if(visual&&validBbox(visual.bbox))hinted.bbox=visual.bbox;
        if(geometry&&geometry.rotation)delete hinted.bbox;
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
    const afterNav=doc.createElement('div'),afterPrev=doc.createElement('button'),afterNext=doc.createElement('button'),afterPosition=doc.createElement('span');
    afterNav.className='paper-after-nav';afterNav.hidden=true;
    for(const b of [afterPrev,afterNext]){b.type='button';b.className='button secondary';}
    afterPrev.textContent='이전';afterNext.textContent='다음';
    afterPrev.setAttribute('aria-label','생성본의 이전 이어지는 쪽');afterNext.setAttribute('aria-label','생성본의 다음 이어지는 쪽');
    afterNav.append(afterPrev,afterPosition,afterNext);ui.afterLabel.after(afterNav);
    afterPrev.addEventListener('click',()=>{if(afterPart>0){afterPart--;void drawAfter();}});
    afterNext.addEventListener('click',()=>{if(!afterNext.disabled){afterPart++;void drawAfter();}});
    function mappedPages(current,count){
      if(current.pageMap==null)return count===pages?[page-1]:null;
      if(!Array.isArray(current.pageMap))return null;
      const rows=current.pageMap.filter(p=>p&&p.sourcePageIndex===page-1);
      if(rows.length!==1)return null;
      const row=rows[0];
      if(!Array.isArray(row.continuationPageIndices))return null;
      const indices=[row.outputPageIndex,...row.continuationPageIndices];
      return indices.every(n=>Number.isSafeInteger(n)&&n>=0&&n<count)&&new Set(indices).size===indices.length?indices:null;
    }
    async function drawAfter(){
      afterNav.hidden=true;
      const seq=++afterSeq,mine=epoch,current=output;
      if(!current||current.blocked){clearStage(ui.afterStage);setAfterStatus(current?'생성 파일의 바이트가 해시와 달라 그리지 않았습니다.':'아직 생성본이 없습니다.');return;}
      const preview=previewApi();
      if(!preview){setAfterStatus('PDF.js 도우미가 없어 생성본을 그리지 못했습니다. 다운로드는 해시가 맞는 동안 사용할 수 있습니다.',true);return;}
      setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+'을 확인하는 중입니다.');
      let canvas=null;
      try{
        const bytes=new Uint8Array(await current.file.arrayBuffer());
        if(seq!==afterSeq||epoch!==mine||output!==current)return;
        if(await sha256Hex(bytes)!==current.sha256){current.blocked=true;clearStage(ui.afterStage);setAfterStatus('생성 파일의 바이트가 해시와 달라 미리보기와 다시 받기를 멈췄습니다.',true);renderChrome();return;}
        const lib=source&&source.lib||await preview.defaultImport();
        if(seq!==afterSeq||epoch!==mine)return;
        if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        releaseAfter();
        const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));
        afterTask=task;
        const pdf=await task.promise;
        if(seq!==afterSeq||epoch!==mine||output!==current)return;
        const mapped=mappedPages(current,pdf.numPages);
        if(!mapped){clearStage(ui.afterStage);setAfterStatus('원본 '+page+'쪽의 출력 위치를 확인할 페이지 대응이 없습니다. 해시가 맞는 파일은 다운로드할 수 있습니다.',true);return;}
        if(afterSourcePage!==page){afterSourcePage=page;afterPart=0;}
        afterPart=Math.max(0,Math.min(afterPart,mapped.length-1));
        const outputPage=mapped[afterPart]+1;
        const pdfPage=await pdf.getPage(outputPage);
        if(seq!==afterSeq||epoch!==mine)return;
        const base=pdfPage.getViewport({scale:1});
        const scale=clampScale(base,ui.afterStage.clientWidth||ui.beforeStage.clientWidth||0,1,preview.fitScale);
        const viewport=pdfPage.getViewport({scale:scale>0?scale:1});
        canvas=doc.createElement('canvas');canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label',(stale()?'마지막 생성본 ':'현재 생성본 ')+outputPage+'쪽');
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        afterRender=renderTask;await renderTask.promise;
        if(seq!==afterSeq||epoch!==mine||output!==current){canvas.width=0;canvas.height=0;return;}
        clearStage(ui.afterStage);ui.afterStage.append(canvas);pdfPage.cleanup&&pdfPage.cleanup();
        afterNav.hidden=mapped.length<2;afterPrev.disabled=afterPart===0;afterNext.disabled=afterPart===mapped.length-1;
        afterPosition.textContent='원본 '+page+'쪽 → 출력 '+outputPage+'쪽 · '+(afterPart+1)+' / '+mapped.length;
        setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+' · 받은 파일 바이트 · 출력 '+outputPage+'쪽'+(afterPart?' · 이어지는 쪽':''));
      }catch(e){
        if(seq!==afterSeq||epoch!==mine||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        setAfterStatus('생성본 쪽을 그리지 못했습니다. 해시가 맞는 파일은 다운로드할 수 있습니다.',true);
      }
    }
    async function generate(){
      const api=exporterApi();
      if(!api||typeof api.prepare!=='function'){setGenStatus('브라우저 PDF 편집 모듈이 없어 생성하지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;}
      if(!source||!source.pdf||!source.fileHash){setGenStatus('PDF 원본이 없어 생성하지 않았습니다.',true);return;}
      const edits=enabledEdits();
      if(!edits.length||!snapshot){setGenStatus('켠 편집이 없어 생성하지 않았습니다.',true);return;}
      const mine=++genId,epochAt=epoch,hash=source.fileHash,revision=snapshot.revision,file=source.file;
      if(genCtl)genCtl.abort();
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      genCtl=ctl;generating=true;renderChrome();
      setGenStatus('생성 중입니다. 끝나기 전에 성공으로 표시하지 않습니다.');
      try{
        const request={file,fileHash:hash,edits:JSON.parse(JSON.stringify(edits)),signal:ctl.signal};
        let result;
        try{result=await api.prepare(request);}
        catch(e){
          const failures=e&&e.details&&e.details.edits;
          const canFlow=api===legacyExporterApi()&&paragraphApi()&&e.code==='unsupported'&&Array.isArray(failures)&&failures.length&&failures.every(f=>f.code==='long-after-no-room');
          if(!canFlow||ctl.signal?.aborted||mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash||snapshot?.revision!==revision)throw e;
          setGenStatus('선택 편집이 원래 공간에 들어가지 않아 전체 편집을 문단 흐름으로 생성하는 중입니다.');
          result=await paragraphApi().prepare({...request,edits:JSON.parse(JSON.stringify(edits))});
        }
        if(mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash)return;
        if(!isFile(result&&result.file)||typeof result.sha256!=='string'||!HEX.test(result.sha256))throw new Error('생성 결과가 실제 파일이 아닙니다.');
        const bytes=new Uint8Array(await result.file.arrayBuffer());
        if(mine!==genId||epoch!==epochAt)return;
        if(await sha256Hex(bytes)!==result.sha256)throw new Error('생성 파일의 바이트와 해시가 달라 받지 않았습니다.');
        if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)throw new Error('생성 결과에 PDF 서명이 없어 받지 않았습니다.');
        output={file:result.file,sha256:result.sha256,verification:result.verification==null?null:result.verification,warnings:Array.isArray(result.warnings)?result.warnings:null,pageMap:clone(result.pageMap)||null,revision,blocked:false};
        afterPart=0;afterSourcePage=page;
        const noted=diagnosticText(output.warnings,output.verification);
        emit('falsify:paper-workspace-output',published({sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0)}));
        setGenStatus(generationLead(output.verification,stale())+(noted?' '+noted:''));
        renderEdits();
        await drawAfter();
      }catch(e){
        if(mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash)return;
        if(ctl.signal&&ctl.signal.aborted){setGenStatus('생성을 중단했습니다. 마지막 생성본은 그대로입니다.');return;}
        setGenStatus('생성하지 못했습니다. 마지막 생성본은 그대로입니다. '+safeMessage(e),true);
      }finally{if(genCtl===ctl)genCtl=null;if(mine===genId&&epoch===epochAt){generating=false;renderChrome();}}
    }
    function download(file){
      if(!isFile(file))return;
      const url=urls.createObjectURL(file),a=doc.createElement('a');
      a.href=url;a.download=file.name||'download.pdf';(doc.body||ui.root).append(a);a.click();a.remove();
      timers.setTimeout(()=>urls.revokeObjectURL(url),1000);
    }
    async function saveDraft(){
      const api=editsApi();
      if(!ui.draftOpt.checked){setDraftStatus('초안 보관은 직접 켠 뒤에만 저장합니다.',true);return;}
      if(!api||typeof api.draft!=='function'||!session||!source||!source.fileHash){setDraftStatus('편집 코어가 없어 초안을 저장하지 않았습니다.',true);return;}
      const box=store();if(!box){setDraftStatus('이 브라우저 저장소를 쓸 수 없어 초안을 저장하지 않았습니다.',true);return;}
      let envelope;
      try{envelope=api.draft({snapshot:session.snapshot(),now:now()});}catch(e){setDraftStatus('초안을 만들지 못했습니다. '+safeMessage(e),true);return;}
      if(!envelope||draftUnsafe(envelope,0)){setDraftStatus('초안에 파일 바이트나 비밀로 보이는 값이 있어 저장하지 않았습니다.',true);return;}
      const raw=JSON.stringify(envelope);
      if(raw.length>200000){setDraftStatus('초안이 너무 커서 저장하지 않았습니다.',true);return;}
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
          if(found.fileHash!==hash||found.pageIndex!==index||found.rotation)throw new Error('초안 문단의 원본 위치를 확인하지 못했습니다.');
          const pageRows=coreSegments((found.paragraphs||[]).map(p=>({id:'paragraph:'+index+':'+p.id,text:p.text,pageIndex:index,label:'PDF p. '+(index+1)})));
          for(const edit of canonical.filter(e=>e.pageIndex===index)){
            const row=pageRows.find(p=>p.id===edit.segmentId),a=edit.anchor;
            if(!row||!a||row.text.slice(a.start,a.end)!==edit.before)throw new Error('초안 Before가 현재 원본 문단과 다릅니다.');
          }
          rows.push(...pageRows);
        }
        if(!live())return false;
        // Bind the complete verified catalog in one replacement; partial inspections never leak into the session.
        source.segments=coreSegments(source.segments).filter(s=>!rows.some(p=>p.id===s.id)).concat(rows);
        return true;
      }catch(e){if(!live())return false;throw e;}
      finally{if(resumeCtl===ctl)resumeCtl=null;}
    }
    async function restoreDraft(){
      const api=editsApi();
      const box=store();
      let raw=draftRaw,expected=source&&source.fileHash;
      if(!raw){
        const row=readIndex()[0];
        if(row&&box){expected=row.fileHash;try{raw=box.getItem('falsify.paper-draft.v1.'+row.fileHash);}catch{raw=null;}}
      }
      if(!api||typeof api.restoreDraft!=='function'||!raw){setDraftStatus('편집 코어가 없어 초안을 복구하지 않았습니다.',true);return;}
      let envelope;
      try{envelope=JSON.parse(raw);}catch{setDraftStatus('초안을 읽지 못했습니다.',true);return;}
      expected=envelope.fileHash||expected;
      if(!source||source.fileHash!==expected){
        const kept=await keptSource(expected);
        const file=kept&&fileFromKept(kept);
        if(file){
          setDraftStatus('이 브라우저에 보관한 원본 PDF를 다시 엽니다. 서버로 올리지 않습니다.');
          if(typeof DataTransfer==='function'&&typeof Event==='function'){
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
        if(!source||source.fileHash!==expected){
          const name=envelope.snapshot&&envelope.snapshot.name||'원본';
          setDraftStatus('초안에는 편집만 있습니다. 이름이 '+String(name).slice(0,160)+' 이고 해시가 '+String(expected||'').slice(0,12)+'… 인 원본 PDF를 다시 선택한 뒤 초안 복구를 누르세요. 서버로 올리지 않습니다.',true);
          return;
        }
      }
      let restored;
      try{restored=api.restoreDraft(envelope,{fileHash:source.fileHash,now:now()});}
      catch(e){setDraftStatus('초안을 복구하지 않았습니다. '+safeMessage(e),true);return;}
      try{if((restored.edits||[]).some(e=>typeof e.segmentId==='string'&&e.segmentId.startsWith('paragraph:'))&&!await discoverDraftParagraphs(restored))return;}
      catch(e){setDraftStatus('초안의 원문을 확인하지 못해 복구하지 않았습니다. '+safeMessage(e),true);return;}
      applyResume(restored);
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
      if(!output||output.blocked)return;
      const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:output.file}});
      if(!doc.dispatchEvent(ev)){setGenStatus('BLUE가 인계를 받지 않았습니다. 생성본은 그대로입니다.');return;}
      const nav=[...doc.querySelectorAll('[data-view="blue"]')].find(b=>b.getClientRects&&b.getClientRects().length)||doc.querySelector('[data-view="blue"]');
      if(nav&&typeof nav.click==='function')nav.click();
    }
    function onKey(e){
      if(e.defaultPrevented)return;
      if(e.key==='Escape'&&inline){e.preventDefault();inline=null;renderInline();ui.beforeStage.focus();return;}
      if(fieldTarget(e.target))return;
      if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){
        e.preventDefault();
        if(!session)return;
        if(e.shiftKey){if(snapshot&&snapshot.canRedo)session.redo();}
        else if(snapshot&&snapshot.canUndo)session.undo();
        return;
      }
      if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&(e.key==='y'||e.key==='Y')){
        e.preventDefault();
        if(session&&snapshot&&snapshot.canRedo)session.redo();
        return;
      }
      if(e.key==='ArrowRight'&&page<pages){e.preventDefault();void drawBefore(page+1);}
      else if(e.key==='ArrowLeft'&&page>1){e.preventDefault();void drawBefore(page-1);}
      else if((e.key==='+'||e.key==='=')&&!ui.zoomIn.disabled)ui.zoomIn.click();
      else if(e.key==='-'&&!ui.zoomOut.disabled)ui.zoomOut.click();
    }
    function onFileChange(){
      const file=ui.file.files&&ui.file.files[0]||null;
      if(!file){clearSource();return;}
      if(source&&source.file===file)return;
      void openFile(file);
    }
    function onDocument(event){
      const detail=event.detail||{},file=detail.file||null;
      const segments=detail.result&&Array.isArray(detail.result.segments)?detail.result.segments:null;
      if(!segments)return;
      if(source&&file&&source.file&&file!==source.file)return;
      if(!source){
        if(!file)return;
        const pending=openFile(file);
        void Promise.resolve(pending).then(()=>{if(source&&source.file===file)adoptSegments(segments);});
        return;
      }
      adoptSegments(segments);
    }
    ui.file.addEventListener('change',onFileChange);
    doc.addEventListener('falsify:document',onDocument);
    doc.addEventListener('falsify:document-clear',clearSource);
    doc.addEventListener('falsify:workspace-reset',clearSource);
    function jumpToTyped(){
      const n=Number(String(ui.pageJump.value||'').trim());
      if(!pages||!Number.isInteger(n)||n<1||n>pages){setBeforeStatus('없는 쪽 번호입니다.',true);ui.pageJump.value=pages?String(page):'';return;}
      if(n===page)return;
      void drawBefore(n);
    }
    ui.prev.addEventListener('click',()=>{if(page>1)void drawBefore(page-1);});
    ui.next.addEventListener('click',()=>{if(page<pages)void drawBefore(page+1);});
    ui.pageJump.addEventListener('change',jumpToTyped);
    ui.pageJump.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();jumpToTyped();}else onKey(e);});
    ui.zoomIn.addEventListener('click',()=>{const i=ZOOMS.indexOf(zoom);if(i<0||i>=ZOOMS.length-1)return;zoom=ZOOMS[i+1];syncNav();if(source&&source.doc)void drawBefore(page);});
    ui.zoomOut.addEventListener('click',()=>{const i=ZOOMS.indexOf(zoom);if(i<=0)return;zoom=ZOOMS[i-1];syncNav();if(source&&source.doc)void drawBefore(page);});
    ui.original.addEventListener('click',()=>{if(source)download(source.file);});
    ui.current.addEventListener('click',()=>{if(output&&!output.blocked)download(output.file);});
    ui.generate.addEventListener('click',()=>{if(!ui.generate.disabled)void generate();});
    ui.team.addEventListener('click',share);
    ui.blue.addEventListener('click',handoff);
    ui.undo.addEventListener('click',()=>{if(session&&snapshot&&snapshot.canUndo)session.undo();});
    ui.redo.addEventListener('click',()=>{if(session&&snapshot&&snapshot.canRedo)session.redo();});
    ui.inlineApply.addEventListener('click',applyInline);
    ui.inlineCancel.addEventListener('click',()=>{inline=null;renderInline();ui.beforeStage.focus();});
    ui.draftOpt.addEventListener('change',renderChrome);
    ui.draftSave.addEventListener('click',saveDraft);
    ui.draftRestore.addEventListener('click',restoreDraft);
    ui.draftDelete.addEventListener('click',deleteDraft);
    ui.beforeStage.addEventListener('click',openParagraph);
    ui.beforeStage.addEventListener('pointerup',captureSelection);
    ui.beforeStage.addEventListener('mouseup',captureSelection);
    ui.beforeStage.addEventListener('keyup',captureSelection);
    ui.root.addEventListener('keydown',onKey);
    ui.beforeStage.addEventListener('keydown',onKey);
    ui.inline.addEventListener('keydown',onKey);
    ui.inlineAfter.addEventListener('keydown',onKey);
    for(const [node,name] of [[ui.original,'download'],[ui.generate,'pencil'],[ui.team,'users'],[ui.blue,'arrow-right'],[ui.undo,'refresh-cw'],[ui.current,'download'],[ui.draftDelete,'x']])paintIcon(node,name);
    renderChrome();renderInline();renderEdits();remindDraft();
    try{const blobs=blobApi();if(blobs?.purgeExpired)void blobs.purgeExpired(now()).catch(()=>{});}catch{}
    if(ui.file.files&&ui.file.files[0])void openFile(ui.file.files[0]);
    return {
      acceptProposals,
      getSource(){if(!source||!source.file||!source.fileHash)return null;return Object.freeze({file:source.file,fileHash:source.fileHash,segments:published(source.segments)||[]});},
      getEditSnapshot(){const raw=session&&typeof session.snapshot==='function'?session.snapshot():snapshot;return raw?published(raw):null;},
      getOutput(){if(!output||output.blocked)return null;return Object.freeze({file:output.file,sha256:output.sha256,verification:published(output.verification),revision:output.revision,pageMap:published(output.pageMap)});}
    };
  }
  return {create,pageIndexFromLabel,classifyProposals,anchorFromSelection,clampScale,TTL};
});

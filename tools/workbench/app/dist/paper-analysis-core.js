/* Advisory PDF pre-analysis contract: strict request and summary shapes, fixed display copy. Hints only, never a render, edit or scientific verdict. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyPaperAnalysis=api;})(globalThis,function(){
  'use strict';
  const REQUEST='falsify.pdf-analysis-request.v1',SUMMARY='falsify.pdf-analysis-summary.v1',DEADLINE_MS=75000,MAX_PATCHES=12,MAX_TEXT=4000,MAX_FILE_BYTES=25*1024*1024,MAX_PAGES=10000,MAX_COUNT=10000000;
  const HEX64=/^[0-9a-f]{64}$/,LABEL=/^PDF p\. ([1-9][0-9]{0,3})$/,STATUSES=['available','partial','unavailable'];
  const LIMITS=Object.freeze(['hint-only','text-only-blue','no-object-export']);
  const TOP=['schema','sourceSha256','status','inventory','objects','layout','structure','limits'],INVENTORY=['pages','textLines','images','vectors','truncated'],OBJECTS=['images','sharedImages','inlineImages','vectors','ambiguous','inspected','complete'];
  // Allow-listed layout probe reasons with fixed Korean phrases; the broker maps anything else to probe-error, so an unknown code is a contract break.
  const OVERFLOW=Object.freeze({height:'원래 줄 수보다 많은 줄이 필요함','unbreakable-width':'끊을 수 없는 단어가 줄 폭보다 김','slot-budget':'배치할 수 있는 줄 자리를 넘음'});
  const UNSUPPORTED=Object.freeze({'missing-glyphs':'원본 글꼴에 없는 글자가 있음','line-bands-overlap':'줄 간격이 좁아 인접 줄과 겹칠 수 있음','unsupported-character':'측정할 수 없는 문자가 있음','font-metrics-unavailable':'원본 글꼴 치수를 읽지 못함',
    'source-not-simple':'원문 위치가 단순한 한 줄 영역이 아님','after-empty':'After가 비어 있음','after-not-text':'After가 텍스트가 아님','after-too-long':'After가 측정 한도보다 김','invalid-bbox':'원문 영역을 확인하지 못함','invalid-font-size':'글자 크기를 확인하지 못함',
    'invalid-line-height':'줄 높이를 확인하지 못함','invalid-obstacles':'주변 개체 정보를 확인하지 못함','too-many-obstacles':'주변 개체가 너무 많음','invalid-edit':'변경 형식을 측정할 수 없음',
    'pymupdf-unavailable':'측정 도구(PyMuPDF)를 사용할 수 없음','font-unavailable':'측정용 글꼴을 사용할 수 없음','source-font-not-found':'원본 글꼴을 쪽에서 찾지 못함','source-font-ambiguous':'원본 글꼴을 하나로 특정하지 못함',
    'source-font-type3':'원본 글꼴이 Type3 글꼴이라 측정하지 않음','source-font-program-unreadable':'원본 글꼴 파일을 읽지 못함','source-font-not-embedded':'원본 글꼴이 PDF에 포함되어 있지 않음','probe-error':'측정 중 오류 (세부 내용은 표시하지 않음)'});
  const SHAPE='사전분석 응답이 약속된 형식과 달라 표시하지 않았습니다. 원본·후보·편집·다운로드 상태는 그대로입니다.';
  function fail(message){const e=new Error(message);e.analysis=true;throw e;}
  const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
  const count=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
  function pageOf(label){const m=typeof label==='string'?LABEL.exec(label):null;return m?Number(m[1])-1:null;}
  // Only the selected RED patches, under fixed request ids (edit-1..N); model-made candidate ids never leave the page.
  function patches(selected){
    if(!Array.isArray(selected)||selected.length>MAX_PATCHES)fail('사전분석은 선택한 후보 12개까지만 요청합니다.');
    return selected.map((p,i)=>{const pageIndex=pageOf(p?.label);if(pageIndex===null)fail('선택한 후보의 PDF 쪽 위치를 확인할 수 없어 사전분석을 요청하지 않았습니다.');
      for(const k of ['before','after'])if(typeof p[k]!=='string'||!p[k].trim()||p[k].length>MAX_TEXT)fail('선택한 후보의 Before/After 형식이 맞지 않아 사전분석을 요청하지 않았습니다.');
      return Object.freeze({id:'edit-'+(i+1),pageIndex,before:p.before,after:p.after});});}
  function request(fileHash,file,list){
    if(typeof fileHash!=='string'||!HEX64.test(fileHash)||typeof file!=='string'||!file)fail('원본 PDF를 확인할 수 없어 사전분석을 요청하지 않았습니다.');
    return {schema:REQUEST,fileHash,file,patches:list.map(p=>({id:p.id,pageIndex:p.pageIndex,before:p.before,after:p.after}))};}
  // Exact summary or nothing: fixed keys, bounded counts, the bound source hash, the requested ids in order and allow-listed reasons only.
  function summary(res,expected){
    if(!exact(res,TOP)||res.schema!==SUMMARY||typeof res.sourceSha256!=='string'||!HEX64.test(res.sourceSha256)||!STATUSES.includes(res.status))fail(SHAPE);
    if(res.sourceSha256!==expected.sourceSha256)fail('사전분석 결과가 현재 원본 PDF와 맞지 않아 버렸습니다.');
    const i=res.inventory,o=res.objects,s=res.structure,ids=expected.ids;
    if(!exact(i,INVENTORY)||!count(i.pages,MAX_PAGES)||!['textLines','images','vectors'].every(k=>count(i[k],MAX_COUNT))||typeof i.truncated!=='boolean')fail(SHAPE);
    if(!exact(o,OBJECTS)||!OBJECTS.slice(0,6).every(k=>count(o[k],MAX_COUNT))||typeof o.complete!=='boolean'||o.sharedImages>o.images||o.inspected+o.ambiguous>o.images+o.inlineImages+o.vectors)fail(SHAPE);
    if(!exact(s,['status','reason'])||s.status!=='unavailable'||s.reason!=='conversion_unconfigured')fail(SHAPE);
    if(!Array.isArray(res.limits)||res.limits.length!==LIMITS.length||res.limits.some((x,k)=>x!==LIMITS[k]))fail(SHAPE);
    if(!Array.isArray(res.layout)||!(res.layout.length===ids.length||res.status==='unavailable'&&res.layout.length===0))fail(SHAPE);
    const layout=res.layout.map((l,k)=>{
      if(!exact(l,['id','status','reason'])||l.id!==ids[k])fail(SHAPE);
      if(l.status==='fits'?l.reason!==null:l.status==='overflow'?!Object.hasOwn(OVERFLOW,l.reason):l.status==='unsupported'?!Object.hasOwn(UNSUPPORTED,l.reason):true)fail(SHAPE);
      return Object.freeze({id:l.id,status:l.status,reason:l.reason});});
    return Object.freeze({status:res.status,inventory:Object.freeze({pages:i.pages,textLines:i.textLines,images:i.images,vectors:i.vectors,truncated:i.truncated}),
      objects:Object.freeze({images:o.images,sharedImages:o.sharedImages,inlineImages:o.inlineImages,vectors:o.vectors,ambiguous:o.ambiguous,inspected:o.inspected,complete:o.complete}),layout:Object.freeze(layout)});}
  const STATUS={available:'사전분석 완료',partial:'사전분석 일부만 완료',unavailable:'이 PDF는 사전분석하지 못했습니다'};
  // Fixed boundary copy: advisory hints, no object export, BLUE stays text-only, structure conversion not run.
  const NOTES=Object.freeze(['참고용 힌트입니다. 렌더링 결과·시각 품질·도형 정확성·과학적 타당성·편집 가능성을 증명하지 않으며, 다운로드를 막거나 허용하는 근거가 아닙니다.',
    '줄 공간 측정은 원본 글꼴 치수로 계산한 추정입니다. 실제 사본의 줄바꿈·페이지 수는 다운로드할 때 엔진 자체검사로만 표시합니다.',
    '이미지·도형 개체는 세기만 하며 교체하거나 내보내지 않습니다.',
    'BLUE는 사본의 텍스트만 읽습니다. 이 사전분석은 BLUE·실행 기록·gold에 전달하지 않습니다.',
    '문서 구조 변환(Docling)은 설정되지 않아 실행하지 않았습니다.']);
  const n=x=>x.toLocaleString('ko-KR');
  // Display model built only from validated numbers, fixed phrases and caller-made candidate labels.
  function view(s,labels={}){const inv=s.inventory,obj=s.objects;
    return Object.freeze({headline:STATUS[s.status]+' · 검사한 쪽 '+n(inv.pages)+'쪽'+(inv.truncated?' (목록 일부 생략)':'')+' · 참고용 힌트이며 판정이 아닙니다.',
      counts:Object.freeze(['텍스트 줄 '+n(inv.textLines)+' · 이미지 '+n(inv.images)+' · 벡터 '+n(inv.vectors),
        '이미지 배치 '+n(obj.images)+'곳 (공유 리소스 배치 '+n(obj.sharedImages)+'곳) · 인라인 이미지 '+n(obj.inlineImages)+' · 벡터 개체 '+n(obj.vectors),
        '단독 사용으로 보이는 이미지 '+n(obj.inspected)+' · 판단 보류 '+n(obj.ambiguous)+(obj.complete?'':' · 개체 목록이 완전하지 않음')]),
      layout:Object.freeze(s.layout.length?s.layout.map(l=>(Object.hasOwn(labels,l.id)?labels[l.id]:l.id)+' · '+(l.status==='fits'?'원래 줄 공간 안에 들어가는 것으로 측정됨':l.status==='overflow'?'원래 줄 공간을 넘침: '+OVERFLOW[l.reason]:'측정 불가: '+UNSUPPORTED[l.reason])):['선택한 후보가 없어 줄 공간은 측정하지 않았습니다.']),
      notes:NOTES});}
  return Object.freeze({REQUEST,SUMMARY,DEADLINE_MS,MAX_PATCHES,MAX_FILE_BYTES,LIMITS,OVERFLOW,UNSUPPORTED,NOTES,pageOf,patches,request,summary,view});
});

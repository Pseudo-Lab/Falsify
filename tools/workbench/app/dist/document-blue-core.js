/* Independent BLUE packet and post-response human assessment. Never scientific gold. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyDocumentBlue=api;})(globalThis,function(){
  'use strict';const VERSION='falsify.document-blue.v1';
  function fail(s){throw new Error(s);}
  function bounded(s,n){return typeof s==='string'&&!!s.trim()&&s.length<=n;}
  function request(doc,maxCalls){if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>32)fail('호출 예산은 1–32회입니다.');return {schema:VERSION,revision:doc.revision,sourceHash:doc.sourceHash,requestId:doc.revision+':'+crypto.randomUUID(),maxCalls,consent:true,segments:doc.segments.map(s=>({id:s.id,label:s.label,text:s.text}))};}
  function validateResponse(doc,res,request){
    if(!res||res.schema!==VERSION||res.revision!==doc.revision||res.sourceHash!==doc.sourceHash)fail('현재 BLUE 문서에 대한 응답이 아닙니다.');
    if(!['ok','refusal','abstain'].includes(res.status)||!Array.isArray(res.findings)||res.findings.length>12||res.status!=='ok'&&res.findings.length)fail('BLUE 응답 형식을 확인하세요.');
    if(res.visualObservations!==undefined){
      const visuals=request?.visualEvidence;
      if(!Array.isArray(visuals)||!Array.isArray(res.visualObservations)||res.visualObservations.length>12||res.status!=='ok'&&res.visualObservations.length)fail('시각 관찰의 요청 참조가 없습니다.');
      const ids=new Set();for(const o of res.visualObservations){if(!bounded(o.id,80)||ids.has(o.id)||!bounded(o.observation,3000)||!bounded(o.uncertainty,1500)||!visuals.some(v=>v.sha256===o.sha256&&v.page===o.page&&JSON.stringify(v.bbox)===JSON.stringify(o.bbox)))fail('시각 관찰 참조가 전달된 이미지와 다릅니다.');ids.add(o.id);}
    }else if(request?.visualEvidence&&res.status==='ok')fail('시각 관찰 결과가 없습니다.');
    const ids=new Set(),source=new Map(doc.segments.map(s=>[s.id,s]));
    return res.findings.map(f=>{
      const s=source.get(f.segmentId);if(!bounded(f.id,80)||ids.has(f.id)||!s||!bounded(f.quote,4000)||!s.text.includes(f.quote)||s.text.indexOf(f.quote)!==s.text.lastIndexOf(f.quote))fail('BLUE 지적 위치/ID가 없거나 중복됩니다.');ids.add(f.id);
      if(!bounded(f.rationale,3000)||!bounded(f.uncertainty,1500)||!Array.isArray(f.evidence)||!f.evidence.length||f.evidence.length>6)fail('BLUE 근거/설명을 확인하세요.');
      const evidence=f.evidence.map(e=>{const s=source.get(e.segmentId);if(!s||!bounded(e.quote,2000)||!s.text.includes(e.quote)||!bounded(e.relation,1500))fail('BLUE 근거가 입력 문서에 없습니다.');return {...e,label:s.label};});return {...f,evidence,label:s.label};
    });
  }
  function validatePlan(doc,plan){
    if(!plan||plan.schema!=='falsify.document-edit-plan.v1'||plan.outputFileHash!==doc.fileHash||!Array.isArray(plan.selected)||!plan.selected.length||plan.selected.length>12)fail('이 수정 파일의 다운로드 때 저장한 변경 계획이 아닙니다. 출력 파일 해시를 확인하세요.');
    const ids=new Set();return plan.selected.map(p=>{if(!bounded(p.id,80)||ids.has(p.id)||!bounded(p.before,4000)||!bounded(p.after,4000)||p.before===p.after||!bounded(p.label,200))fail('변경 계획 형식 오류');ids.add(p.id);const s=doc.segments.find(s=>s.label===p.label&&s.text.includes(p.after));if(!s)fail('변경문이 수정 PDF의 지정 위치에 없습니다.');return {id:p.id,before:p.before,after:p.after,label:p.label,segmentId:s.id};});
  }
  function overlaps(p,findings){return findings.filter(f=>f.segmentId===p.segmentId&&(f.quote.includes(p.after)||p.after.includes(f.quote))).map(f=>f.id);}
  return {VERSION,request,validateResponse,validatePlan,overlaps};
});

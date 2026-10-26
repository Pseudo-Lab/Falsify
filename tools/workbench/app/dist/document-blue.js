(function(){
  'use strict';const C=FalsifyDocumentBlue,B=FalsifyLocalBridge,$=s=>document.querySelector(s);
  let generation=0,doc=null,result=null,findings=[],request=null,busy=false,job=null,jobLink=null,abort=null;
  const P=globalThis.FalsifyPendingJobs||null;let recovering=false;
  function shippedHelper(){try{const nodes=document.scripts?[...document.scripts]:[];return nodes.some(s=>{const src=String(s&&(typeof s.getAttribute==='function'?s.getAttribute('src'):s.src)||'');return src==='pending-job.js'||src.endsWith('/pending-job.js');});}catch{return false;}}
  function helperReady(){return !!(P&&typeof P.hold==='function'&&typeof P.note==='function'&&typeof P.read==='function'&&typeof P.matches==='function'&&typeof P.recover==='function');}
  function expectsHelper(){return !!(P||shippedHelper());}
  // relation is operator-only metadata (RED handoff run ID); it never enters the BLUE request packet.
  let relation=null,epoch=0,savedId=null,saving=false,failure=null,sticky=null,notice=false;
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  function msg(s,error=false,force=false){if((sticky||notice)&&!force)return;$('#doc-blue-progress').textContent=s;$('#doc-blue-progress').classList.toggle('error',error);}
  function reportCaught(e){if(sticky||notice)return;msg(e.message+' 자동 재시도하지 않습니다.',true);}
  function panelLatched(){const n=document.querySelector('#doc-blue-failure');return !!(n&&!n.hidden&&n.textContent);}
  function terminalKind(record){if(!record)return null;if(record.disposition==='failed')return 'failed';if(record.disposition==='cancelled')return 'cancelled';return null;}
  function clearSticky(){sticky=null;notice=false;for(const id of ['doc-blue-failure','doc-blue-pending-discard','doc-blue-failure-diagnostic','doc-blue-failure-request']){const node=document.querySelector('#'+id);if(!node)continue;if(id==='doc-blue-failure')node.textContent='';node.hidden=true;}}
  function ensurePanel(){let n=document.querySelector('#doc-blue-failure');if(!n){n=document.createElement('p');n.id='doc-blue-failure';n.className='form-feedback error';$('#doc-blue-progress').after(n);}return n;}
  function ensureButton(id,label,onClick){let b=document.querySelector('#'+id);if(!b){b=document.createElement('button');b.type='button';b.id=id;b.className='button secondary';$('#doc-blue-progress').after(b);}if(!b.__recoveryBound){b.type='button';b.className=b.className||'button secondary';b.addEventListener('click',onClick);b.__recoveryBound=true;}b.textContent=label;b.hidden=false;return b;}
  function saveJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // A BLUE job keeps the bridge link it started with for polls and cancel; the bridge refuses to switch while busy.
  function link(){const l=B.session();if(!l)throw new Error('로컬 broker 연결이 없습니다. 위 연결 패널에서 연결하거나 수동 JSON 교환을 쓰세요.');return l;}
  function controls(){const active=!!doc&&!busy;B.busy('blue',busy);$('#doc-blue-start').disabled=!active||!B.capabilities()?.blue||!$('#doc-blue-consent').checked||!FalsifyLab.allowed('blue');$('#doc-blue-request').disabled=!active;$('#doc-blue-apply').disabled=!active;$('#doc-blue-cancel').hidden=!job;$('#doc-blue-budget').disabled=busy;$('#doc-blue-record').disabled=!active||!result||saving;FalsifyLab.busy('blue',busy||saving);renderRecord();document.dispatchEvent(new CustomEvent('falsify:blue-state',{detail:{name:doc?.name||'',busy,hasResult:!!result}}));}
  function cancel(){const old=job,l=jobLink;job=null;jobLink=null;if(old&&l)void l.request('/api/blue/jobs/'+encodeURIComponent(old)+'/cancel',{}).catch(()=>{});}
  function invalidate(){epoch++;savedId=null;saving=false;failure=null;result=null;findings=[];request=null;$('#doc-blue-findings').replaceChildren();$('#doc-blue-result-summary').textContent='';$('#doc-blue-record-status').textContent='';}
  function clear(keepFile=false){generation++;cancel();abort?.abort();abort=null;doc=null;relation=null;busy=false;clearSticky();invalidate();if(keepFile!==true)$('#doc-blue-file').value='';$('#doc-blue-response').value='';$('#doc-blue-consent').checked=false;$('#blue-harness-consent').checked=false;$('#doc-blue-summary').textContent='아직 파일을 입력하지 않았습니다. 수정 파일 또는 원본/대조군을 직접 선택하세요.';msg('');controls();restorePending();}
  document.addEventListener('falsify:workspace-reset',clear);$('#doc-blue-clear').addEventListener('click',clear);
  // A user-chosen file is an independent BLUE input: clear() drops any RED relation.
  // Replacing the input asks first while a BLUE job runs or a result has not been recorded.
  function keepResult(){return !(job||result&&!savedId&&(failure||saving))||confirm('BLUE 검토가 진행 중이거나 결과가 아직 기록되지 않았습니다. 새 파일로 바꾸면 이 작업과 결과가 사라집니다. 계속할까요?');}
  $('#doc-blue-file').addEventListener('change',()=>{const file=$('#doc-blue-file').files[0];if(file&&!keepResult()){$('#doc-blue-file').value='';msg('새 파일 입력을 취소했습니다. 기존 BLUE 작업과 결과를 유지합니다.');return;}clear(true);if(file)void extract(file,null);});
  // The RED handoff event is cancelable; RED stays on its view when BLUE keeps its current work.
  document.addEventListener('falsify:blue-file',e=>{const {file,sourceRunId}=e.detail||{};if(!(file instanceof File))return;if(!keepResult()){e.preventDefault();return;}clear();const linked=typeof sourceRunId==='string'&&!!sourceRunId;if(linked)relation=sourceRunId;void extract(file,linked?'RED 실험 사본 · ':'RED 실험 사본 · 인계 관계 미기록(RED 최종 기록 없음) · ');});
  async function extract(file,origin){const current=generation;abort=new AbortController();busy=true;controls();msg('BLUE 파일의 텍스트를 로컬 추출 중');
    try{const imported=await FalsifyImport.extract(file,{signal:abort.signal,onProgress:s=>{if(current===generation)msg(typeof s==='string'?s:'BLUE 텍스트 추출 중');}});const sourceHash=await hash(new TextEncoder().encode(imported.text)),fileHash=await hash(await file.arrayBuffer());if(current!==generation)return;
      doc={revision:crypto.randomUUID(),sourceHash,fileHash,name:file.name.slice(0,160),format:String(imported.format).slice(0,40),segments:imported.segments.map((s,i)=>({id:'s'+i,label:s.label,text:s.text}))};$('#doc-blue-summary').textContent=(origin||'')+file.name+' · '+doc.segments.length+'개 페이지/문단 · '+imported.text.length.toLocaleString()+'자';msg('추출 완료. '+(imported.warnings||[]).join(' ')+' RED 계획·검수 기록은 모델 입력에 포함하지 않습니다.'+(origin?' 실행하려면 아래에서 다시 동의하세요.':''));
    }catch(e){if(current===generation)msg('파일 입력 실패: '+e.message,true);}finally{if(current===generation){busy=false;abort=null;controls();}}}
  async function makeRequest(){return FalsifyLab.bind('blue',C.request(doc,Number($('#doc-blue-budget').value)));}
  // Server progress phase is shown only as a bounded identifier; known phases get fixed Korean names.
  const PHASES={reviewing:'검토',selecting:'근거 구간 선택',reread:'원문 근거 재확인',finalizing:'결과 정리'};
  function phase(p){return typeof p==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(p)?' · 단계: '+(Object.hasOwn(PHASES,p)?PHASES[p]:p):'';}
  // coverage.reread counts only for a local broker run; a manual response is never execution-verified whatever metadata it carries.
  // Completed means the selected raw-evidence segments were sent again, not that detection is complete or accurate. The server meaning text is not echoed.
  function reread(res,provenance){if(provenance!=='local-codex')return ' 원문 재확인 실행 여부 미검증(수동 응답).';
    const r=res.coverage?.reread,ids=new Set(doc.segments.map(s=>s.id));if(r==null)return ' 원문 근거 재확인 보고 없음.';if(typeof r!=='object')return ' 원문 근거 재확인 보고 형식 확인 불가.';
    const segments=Array.isArray(r.selectedSegments)&&r.selectedSegments.length<=ids.size&&r.selectedSegments.every(x=>ids.has(x)),chars=Number.isSafeInteger(r.deliveredChars)&&r.deliveredChars>=0;
    // Direct full text is claimed only with consistent metadata and complete extracted-text delivery.
    if(r.status==='not-needed'&&segments&&!r.selectedSegments.length&&chars&&r.truncated===false&&res.coverage.complete===true)return ' 한 번의 호출로 전체 추출 텍스트를 직접 검토해 별도 원문 재확인은 하지 않았습니다.';
    if(r.status==='completed'&&segments&&r.selectedSegments.length&&chars&&r.deliveredChars>0&&typeof r.truncated==='boolean')
      return ' 원문 근거 재확인 수행 · 구간 '+new Set(r.selectedSegments).size+'개 · '+r.deliveredChars.toLocaleString()+'자'+(r.truncated?' · 일부만 전달됨':'')+'.';
    return r.status==='incomplete'?' 원문 근거 재확인 미완료.':' 원문 근거 재확인 보고 형식 확인 불가.';}
  function apply(res,provenance){const validated=C.validateResponse(doc,res);const list=$('#doc-blue-findings'),bound=request;invalidate();request=bound;findings=validated;result={...res,provenance};list.replaceChildren();
    for(const f of findings){const section=document.createElement('section');section.className='red-proposal';const title=document.createElement('h3');title.textContent=f.id+' · '+f.label;const quote=document.createElement('blockquote');quote.textContent=f.quote;const reason=document.createElement('p');reason.textContent=f.rationale;section.append(title,quote,reason);for(const e of f.evidence){const loc=document.createElement('p');loc.textContent=e.label+' — '+e.relation;const q=document.createElement('blockquote');q.textContent=e.quote;section.append(loc,q);}const uncertainty=document.createElement('p');uncertainty.className='muted';uncertainty.textContent='한계: '+f.uncertainty;section.append(uncertainty);list.append(section);}
    $('#doc-blue-result-summary').textContent=(provenance==='local-codex'?'로컬 broker 실행 · '+res.model:'수동 응답 · 실행 출처 미검증')+' · 상태 '+res.status+' · 지적 '+findings.length+'개 · 사람 평가는 검수 메뉴에서';
    // Every status branch states delivery coverage and reread, so an abstain or refusal never hides an incomplete review.
    const scope=provenance==='local-codex'?'앱 adapter 호출 '+(res.coverage?.calls||'?')+'회. '+(res.coverage?.complete?'전체 추출 텍스트 전달 완료(탐지 보장 아님).':'전달 미완료.'):'수동 응답의 실행·전달 여부 미검증.';
    msg((res.status==='refusal'?'BLUE 요청 거절. 우회·자동 재시도하지 않습니다.':res.status==='abstain'?'BLUE 판단 유보. 탐지 실패로 변환하지 않습니다.':findings.length+'개 지적 · 입력 인용 일치 확인.')+' '+scope+reread(res,provenance));controls();void saveRecord();}
  $('#doc-blue-consent').addEventListener('change',controls);document.addEventListener('falsify:harness-consent',controls);
  document.addEventListener('falsify:harness-change',e=>{if(e.detail.role!=='blue')return;generation++;if(doc)doc.revision=crypto.randomUUID();invalidate();controls();msg('harness 변경: 이전 응답 무효화. 저장한 실행 기록은 보존됩니다.');});
  $('#doc-blue-budget').addEventListener('change',()=>{generation++;if(doc)doc.revision=crypto.randomUUID();invalidate();controls();msg('예산 변경: 이전 응답을 무효화했습니다.');});
  $('#doc-blue-request').addEventListener('click',async()=>{if(!doc||busy)return;const current=generation;try{const next=result&&request?request:await makeRequest();if(current!==generation)return;request=next;saveJSON(request,'falsify-document-blue-request.json');msg('논문과 BLUE harness 요청 저장. 모델은 호출하지 않았습니다. RED 계획·검수 기록은 포함하지 않습니다.');}catch(e){msg(e.message,true);}});
  $('#doc-blue-apply').addEventListener('click',async()=>{if(!doc||busy)return;const current=generation;try{const raw=$('#doc-blue-response').value;if(raw.length>150000)throw new Error('응답 길이 제한 초과');const next=request||await makeRequest();if(current!==generation)return;request=next;apply(JSON.parse(raw),'manual-unverified');}catch(e){msg('응답 적용 차단: '+e.message,true);}});
  async function holdBlue(next){
    const instance=B.capabilities()?.companionInstance||null;
    const held=await P.hold({role:'blue',request:next,doc,companionInstance:instance,hashHarness:h=>FalsifyHarness.hash(h)});
    if(!held.ok)throw new Error(held.message);
    return held;
  }
  async function postBlue(l,held){
    request=held.record.request;
    const wire=JSON.stringify(request);
    if(await hash(new TextEncoder().encode(wire))!==held.record.requestBytesDigest)throw new Error('직렬화한 요청 바이트가 대기 기록과 달라 보내지 않았습니다.');
    let started;try{started=await l.request('/api/blue/jobs',request);}catch(err){await P.note(held.record,{postReceipt:'unknown',disposition:'unknown',finishedAt:Date.now()});const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);throw err;}
    if(!started||started.id!==request.requestId){await P.note(held.record,{postReceipt:'unknown',disposition:'unknown',finishedAt:Date.now()});const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);throw new Error('서버가 저장한 요청 ID와 다른 작업을 돌려줘 그 작업을 이어받지 않았습니다.');}
    await P.note(held.record,{postReceipt:'accepted'});return started;
  }
  async function persistWatch(record,data){
    const kind=data.state==='failed'?'failed':'cancelled';
    const patch={disposition:kind,finishedAt:Date.now()};
    if(kind==='failed'){const detail=P.safeFailure(data.error);if(detail)patch.serverFailure=detail;}
    await P.note(record,patch);
  }
  async function watchBlue(current,l,strict){
    while(current===generation&&job){
      const data=await l.request('/api/blue/jobs/'+encodeURIComponent(job));if(current!==generation||!job)return;
      if(strict){const found=P.read('blue');if(found.status!=='record'||found.record.requestId!==job||!P.matches(found.record,data))throw new Error('조회한 작업의 식별이 저장한 요청과 달라 적용하지 않았습니다.');}
      if(data.state==='completed'){clearSticky();apply(data.result,'local-codex');if(strict){const found=P.read('blue');if(found.status==='record')await P.note(found.record,{disposition:'completed',finishedAt:Date.now()});}break;}
      if(data.state==='failed'||data.state==='cancelled'){
        if(!strict)throw new Error(typeof data.error==='string'?data.error.slice(0,300):'BLUE 취소됨');
        const found=P.read('blue');if(found.status==='record')await persistWatch(found.record,data);
        const saved=P.read('blue');if(saved.status==='record')rememberTerminal(saved.record);return;
      }
      if(strict&&data.state!=='running'){
        const found=P.read('blue');
        if(found.status==='record'){await P.note(found.record,{disposition:'unknown',finishedAt:Date.now()});const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);}
        return;
      }
      if(strict){const found=P.read('blue');if(found.status==='record'&&found.record.disposition!=='running')await P.note(found.record,{disposition:'running'});}
      msg('BLUE 검토 중 · '+(data.progress&&data.progress.completedCalls||0)+' / '+(data.progress&&data.progress.requiredCalls||'?')+'회 완료'+phase(data.progress&&data.progress.phase));await new Promise(r=>setTimeout(r,1500));
    }
  }
  function onDiscard(){
    const found=helperReady()?P.read('blue'):null;
    const detail=found&&found.status==='record'&&found.record.disposition==='failed'&&typeof found.record.serverFailure==='string'?found.record.serverFailure:'';
    generation++;cancel();
    const done=P.discard('blue',{acknowledge:true});
    if(!done.ok){msg((detail?detail+' ':'')+(done.message||'대기 기록을 지우지 못했습니다.'),true,true);return;}
    clearSticky();busy=false;job=null;jobLink=null;
    msg(P.text({status:'discarded'})+' 다시 시작하려면 BLUE 독립 검토 시작을 직접 누르세요.',false,true);controls();
  }
  function exportDiagnostic(){
    const found=P.read('blue');if(!found||found.status!=='record')return;
    const r=found.record;
    saveJSON({schema:'falsify.blue-failure-diagnostic.v1',role:r.role,requestId:r.requestId,disposition:r.disposition,postReceipt:r.postReceipt,sourceHash:r.sourceHash,fileHash:r.fileHash,revision:r.revision,harnessHash:r.harnessHash,requestBytesDigest:r.requestBytesDigest,requestFingerprint:r.requestFingerprint,companionInstance:r.companionInstance,serverFailure:typeof r.serverFailure==='string'?r.serverFailure:null},'falsify-blue-failure-diagnostic.json');
  }
  function exportStoredRequest(){
    const found=P.read('blue');if(!found||found.status!=='record')return;
    const body=P.safeRequest(found.record);if(!body){msg('원래 요청을 저장하지 못했습니다. 실행하지 않았습니다.',true,true);return;}
    saveJSON(body,'falsify-document-blue-request.json');
  }
  function showRecoveryActions(){ensureButton('doc-blue-pending-discard','이 대기 작업 버리기',onDiscard);ensureButton('doc-blue-failure-diagnostic','진단 정보 저장',exportDiagnostic);ensureButton('doc-blue-failure-request','원래 요청 저장',exportStoredRequest);}
  function rememberTerminal(record,opts={}){
    const kind=terminalKind(record);if(!kind)return;
    if(!doc&&record.request)adoptBlue(P.docFrom(record));
    request=record.request;sticky=kind;notice=false;
    const detail=kind==='failed'&&typeof record.serverFailure==='string'?record.serverFailure:'';
    const head=kind==='failed'?'BLUE 실패. '+(detail?detail+' ':'')+'자동으로 다시 보내지 않습니다.':'BLUE 취소. 자동으로 다시 보내지 않습니다.';
    const foreign=opts.foreign?' 이번 조회는 저장된 요청·인스턴스·해시와 달라 서버 문구를 바꾸지 않았습니다.':'';
    const guidance=' 대기 작업은 다시 열거나 연결과 조회가 바뀌어도 버릴 때까지 유지됩니다. 다시 시작하려면 「이 대기 작업 버리기」를 누른 뒤 「BLUE 독립 검토 시작」을 직접 누르세요. 진단 정보와 원래 요청은 저장만 하며 실행하지 않습니다.';
    msg(head+foreign,true,true);
    const box=ensurePanel();box.hidden=false;box.textContent=head+foreign+guidance;
    showRecoveryActions();
  }
  function showUnknown(record){
    if(sticky)return;
    if(record&&record.request)request=record.request;
    notice=true;
    const text='BLUE 상태 미확인. 접수 여부를 확인하지 못했습니다. 성공으로 보지 않았고 자동으로 다시 보내지 않습니다. 대기 작업은 버릴 때까지 유지됩니다. 다시 시작하려면 「이 대기 작업 버리기」 후 「BLUE 독립 검토 시작」을 직접 누르세요. 진단 정보와 원래 요청은 저장만 하며 실행하지 않습니다.';
    msg(text,true,true);
    const box=ensurePanel();box.hidden=false;box.textContent=text;
    showRecoveryActions();
  }
  function showPendingBlue(outcome){
    if(sticky||notice||panelLatched())return;
    msg(P.text(outcome),outcome.status!=='still-running');
    const keep=!!outcome&&outcome.status&&outcome.status!=='absent'&&outcome.status!=='completed'&&outcome.status!=='still-running';
    if(keep)ensureButton('doc-blue-pending-discard','이 대기 작업 버리기',onDiscard);
    else {const b=document.querySelector('#doc-blue-pending-discard');if(b)b.hidden=true;}
  }
  function restorePending(){
    if(!helperReady())return;
    const found=P.read('blue');if(found.status!=='record')return;
    if(terminalKind(found.record))rememberTerminal(found.record);
    else if(found.record.disposition==='unknown'||found.record.postReceipt==='unknown')showUnknown(found.record);
  }
  function adoptBlue(stored){
    doc={revision:stored.revision,sourceHash:stored.sourceHash,fileHash:stored.fileHash,format:stored.format,name:stored.name,segments:stored.segments.map(s=>({id:s.id,label:s.label,text:s.text}))};
    relation=null;$('#doc-blue-summary').textContent=(doc.name||'복구된 BLUE 입력')+' · 추출 텍스트만 복구됨';
  }
  async function probeBlue(id){
    const l=B.session();if(!l)return {httpStatus:0,body:null};
    try{return {httpStatus:200,body:await l.request('/api/blue/jobs/'+encodeURIComponent(id))};}
    catch(e){const m=String(e&&e.message||'');
      if(m.includes('401')||m.includes('403')||m.includes('인증을 거부'))return {httpStatus:403,body:null};
      if(m.includes('404')||m.includes('not_found')||m.includes('찾을 수 없습니다'))return {httpStatus:404,body:null};
      return {httpStatus:0,body:null};}
  }
  async function resumeBlue(outcome){
    const l=B.session();if(!l){showPendingBlue({status:'unpaired',record:outcome.record});return;}
    adoptBlue(outcome.doc);request=outcome.record.request;
    if(outcome.record.postReceipt!=='accepted')await P.note(outcome.record,{postReceipt:'accepted'});
    const current=generation;busy=true;job=outcome.record.requestId;jobLink=l;controls();msg(P.text(outcome));
    try{await watchBlue(current,l,true);}catch(e){if(current===generation)reportCaught(e);}
    finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
  }
  function showRecoveredBlue(outcome){clearSticky();adoptBlue(outcome.doc);request=outcome.record.request;apply(outcome.result,'local-codex');msg(P.text(outcome),false,true);}
  function recoverOptions(){return {role:'blue',companionInstance:B.capabilities()?.companionInstance||null,hashHarness:h=>FalsifyHarness.hash(h),validate:(d,res)=>C.validateResponse(d,res),getJob:probeBlue,currentDoc:doc||undefined};}
  async function absorbTerminal(record,outcome){
    const mismatch=outcome&&['request-mismatch','hash-mismatch','role-mismatch','server-restarted','instance-unverified'].includes(outcome.status);
    if(mismatch){rememberTerminal(record,{foreign:true});return;}
    if(outcome&&record.disposition==='failed'&&outcome.status==='failed'){
      const detail=P.safeFailure(outcome.error);if(detail)await P.note(record,{serverFailure:detail});
      const saved=P.read('blue');rememberTerminal(saved.status==='record'?saved.record:record);return;
    }
    if(outcome&&record.disposition==='cancelled'&&outcome.status==='cancelled'){rememberTerminal(record);return;}
    rememberTerminal(record);
  }
  async function recoverBlue(){
    if(!helperReady()||recovering||busy)return;
    const found=P.read('blue');if(found.status==='absent')return;
    if(found.status!=='record'){if(!sticky&&!notice)showPendingBlue(found);return;}
    const record=found.record;
    if(terminalKind(record)){
      rememberTerminal(record);
      if(!B.state().connected)return;
      recovering=true;
      try{await absorbTerminal(record,await P.recover(recoverOptions()));}finally{recovering=false;}
      return;
    }
    if(doc){
      const same=doc.sourceHash===record.sourceHash&&doc.fileHash===record.fileHash&&doc.revision===record.revision;
      if(same&&(job||record.disposition==='completed'))return;
      if(!same){showPendingBlue({status:'unresolved',record});return;}
    }
    if(!B.state().connected){
      if(record.postReceipt==='unknown'||record.disposition==='unknown'){showUnknown(record);return;}
      showPendingBlue({status:'unpaired',record});return;
    }
    recovering=true;
    try{
      const outcome=await P.recover(recoverOptions());
      if(!outcome||outcome.status==='absent')return;
      if(outcome.status==='still-running'){await resumeBlue(outcome);return;}
      if(outcome.status==='completed'){showRecoveredBlue(outcome);const rec=P.read('blue');if(rec.status==='record')await P.note(rec.record,{disposition:'completed',finishedAt:Date.now()});return;}
      if((outcome.status==='failed'||outcome.status==='cancelled')&&outcome.record){
        const patch={disposition:outcome.status,finishedAt:Date.now()};
        if(outcome.status==='failed'){const detail=P.safeFailure(outcome.error);if(detail)patch.serverFailure=detail;}
        await P.note(outcome.record,patch);
        const saved=P.read('blue');rememberTerminal(saved.status==='record'?saved.record:outcome.record);return;
      }
      if(outcome.status==='receipt-unknown'||outcome.status==='unknown'||record.postReceipt==='unknown'||record.disposition==='unknown'){showUnknown(record);return;}
      showPendingBlue(outcome);
    }finally{recovering=false;}
  }
  $('#doc-blue-start').addEventListener('click',async()=>{if(!doc||busy||!$('#doc-blue-consent').checked||!FalsifyLab.allowed('blue'))return;const current=generation;
    if(expectsHelper()){
      if(!helperReady()){msg('대기 기록 도우미가 없거나 손상되어 실행하지 않았습니다. 요청을 보내지 않습니다.',true);return;}
      const pending=P.read('blue');
      if(pending.status==='record'&&terminalKind(pending.record)){rememberTerminal(pending.record);return;}
      if(pending.status==='record'&&(pending.record.disposition==='unknown'||pending.record.postReceipt==='unknown')){showUnknown(pending.record);return;}
      busy=true;controls();
      let l,held=null;
      try{l=link();const next=await makeRequest();if(current!==generation)return;held=await holdBlue(next);}
      catch(e){if(current===generation)reportCaught(e);}
      finally{if(!held){busy=false;controls();}}
      if(current!==generation){busy=false;controls();return;}
      if(!held)return;
      clearSticky();invalidate();request=held.record.request;controls();
      try{msg('전체 텍스트 호출 예산 확인 후 선택 BLUE harness를 실행합니다.');const started=await postBlue(l,held);if(current!==generation){void l.request('/api/blue/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}job=started.id;jobLink=l;controls();await watchBlue(current,l,true);}
      catch(e){if(current===generation)reportCaught(e);}finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
      return;
    }
    // UNSHIPPED_TEST_ISOLATION: document-blue.js loaded with neither pending-job.js nor the shipped script tag.
    // Standalone page VMs keep this direct POST. index.html always includes the helper and never uses this branch.
    busy=true;invalidate();controls();
    try{const l=link();request=await makeRequest();if(current!==generation)return;msg('전체 텍스트 호출 예산 확인 후 선택 BLUE harness를 실행합니다.');const started=await l.request('/api/blue/jobs',request);if(current!==generation){void l.request('/api/blue/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}job=started.id;jobLink=l;controls();
      await watchBlue(current,l,false);
    }catch(e){if(current===generation)reportCaught(e);}finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}});
  $('#doc-blue-cancel').addEventListener('click',()=>{generation++;cancel();busy=false;invalidate();controls();msg('취소 요청. 진행 중 호출은 최대 180초까지 실행될 수 있으며 응답은 폐기합니다.');});
  $('#doc-blue-record').addEventListener('click',()=>{if(!doc||!result||busy)return;if(savedId){renderRecord('변경이 없어 다시 기록하지 않았습니다. ');return;}void saveRecord();});
  async function saveRecord(){
    if(!doc||!result||savedId||saving)return;const current=generation,at=epoch,live=()=>current===generation&&at===epoch;
    // isCurrent is checked by the ledger immediately before persisting; a source switch cancels a stale save.
    const extras={isCurrent:live};if(relation)extras.sourceRunId=relation;
    saving=true;failure=null;controls();
    try{const id=await FalsifyLab.record('blue',doc,request,result,result.provenance,extras);if(live())savedId=id;}
    catch(e){if(live())failure=e.message;}
    finally{if(live()){saving=false;controls();}}
  }
  function renderRecord(note=''){
    const status=$('#doc-blue-record-status');let text='';
    if(result)text=saving?'실행 결과를 이 브라우저에 기록하는 중입니다.':failure?'기록되지 않음: '+failure+' 결과는 화면에 남아 있습니다. 「BLUE 실행 결과 기록」으로 다시 시도하세요.':savedId?note+'기록됨 · 기록 ID '+savedId.slice(0,8)+(relation?' · RED 기록 '+relation.slice(0,8)+'의 사본(운영 메타데이터, 모델 입력 아님)':'')+'. 논문 추출문도 이 브라우저에 보관됩니다.':'아직 기록되지 않았습니다.';
    status.textContent=text;status.classList.toggle('error',!!result&&!saving&&!!failure);
    let b=$('#doc-blue-evaluate');if(!b){b=document.createElement('button');b.type='button';b.id='doc-blue-evaluate';b.className='text-button';b.textContent='검수에서 이 기록 평가';status.after(b);b.addEventListener('click',()=>{if(!savedId)return;const select=$('#evaluation-run');if(select&&[...select.options].some(o=>o.value===savedId)){select.value=savedId;select.dispatchEvent(new Event('change'));}([...document.querySelectorAll('[data-view=review]')].find(x=>x.getClientRects().length)||$('[data-view=review]'))?.click();});}
    b.hidden=!savedId||!result;
  }
  function connection(){const s=B.state();$('#doc-blue-connection').textContent=s.status==='checking'?'로컬 실행 상태 확인 중':s.connected?(s.cap?.blue?(s.status==='paired'?'페어링된 로컬 broker':'로컬 broker')+' · 선택 harness 사용 · 실행 CLI·모델은 아래 Harness 선택을 따릅니다'+(s.cap.cliSelection?'':' · 이 companion은 기본 Codex CLI(새 일회성 세션)만 지원 (CLI 선택은 최신 companion 필요)'):'실제 BLUE 연결 없음: 최신 코드로 로컬 서버를 재시작하세요.'):'로컬 broker 연결 없음 · 파일 추출과 수동 JSON 교환만 가능합니다. 위 연결 패널을 확인하세요.';}
  document.addEventListener('falsify:local-bridge',()=>{connection();controls();if(helperReady())void recoverBlue();});connection();controls();if(helperReady())void recoverBlue();
})();

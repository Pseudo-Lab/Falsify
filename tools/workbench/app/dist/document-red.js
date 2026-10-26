/* Full-paper RED review, candidate selection and preservation-gated export. */
(function(){
  'use strict';const C=FalsifyDocumentRed,H=FalsifyHarness,B=FalsifyLocalBridge,$=s=>document.querySelector(s);
  let generation=0,doc=null,file=null,candidates=[],response=null,job=null,jobLink=null,busy=false,request=null,binding=null;
  // Run records: one key per (response epoch, final snapshot) so unchanged auto/manual saves never duplicate.
  let epoch=0,exported=null,lastSaved=null,failure=null,guard={};const saved=new Map(),pending=new Map(),settings={level:$('#red-level').value,budget:$('#red-budget').value};
  // Final-PDF preview (optional bundle): shown only for a hash-verified PDF export and cleared with every invalidation of `exported`.
  const preview=globalThis.FalsifyPreview?.createPreview?.()||null;
  // Optional advisory PDF pre-analysis (its core bundle may be absent): explicit click only, never a model call, export gate or BLUE input.
  const A=globalThis.FalsifyPaperAnalysis||null;let analysis=null;
  // Optional single-occurrence image replacement (its bundle may be absent): this module is its only source authority and busy owner.
  // It receives the bound PDF file/hash, never candidates, text exports or the BLUE handoff; clear() cancels it.
  const IMG=globalThis.FalsifyImageEditor?.mount?.({hold:imageHold})||null;
  const P=globalThis.FalsifyPendingJobs||null;let recovering=false,sourceFileRequired=false;
  function shippedHelper(){try{const nodes=document.scripts?[...document.scripts]:[];return nodes.some(s=>{const src=String(s&&(typeof s.getAttribute==='function'?s.getAttribute('src'):s.src)||'');return src==='pending-job.js'||src.endsWith('/pending-job.js');});}catch{return false;}}
  function helperReady(){return !!(P&&typeof P.hold==='function'&&typeof P.note==='function'&&typeof P.read==='function'&&typeof P.matches==='function'&&typeof P.recover==='function');}
  function expectsHelper(){return !!(P||shippedHelper());}
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const msg=(s,error=false)=>{const e=$('#red-progress');e.textContent=s;e.classList.toggle('error',error);};
  // Persistent outcome for a response without candidates: status plus coverage/synthesis, never a generic empty state.
  const EMPTY=$('#red-empty').textContent;
  function emptyNote(){if(!response)return EMPTY;return '후보 없음 · '+(response.status==='abstain'?'모델이 유보했습니다':response.status==='refusal'?'모델이 거절했습니다':'모델이 후보를 내지 않았습니다')+' · '+H.outcomeText('red',response,response.provenance)+'. 자동 재시도하지 않았습니다.';}
  function jsonDownload(value,name){download(new TextEncoder().encode(JSON.stringify(value,null,2)),name,'application/json');}
  function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // Every job/export binds one bridge link for its whole life (start, polls, cancel); the bridge refuses to switch while busy.
  function link(){const l=B.session();if(!l)throw new Error('로컬 broker 연결이 없습니다. 위 연결 패널에서 연결하거나 수동 JSON 교환을 쓰세요.');return l;}
  function connection(){const s=B.state(),cap=s.cap;
    $('#red-connection').textContent=s.status==='checking'?'로컬 실행 상태 확인 중':s.connected?(s.status==='paired'?'페어링된 로컬 broker':'로컬 broker 연결')+(cap?.red?' · 실행 CLI·모델은 아래 Harness 선택을 따릅니다'+(cap.cliSelection?'':' · 이 companion은 기본 Codex CLI'+(cap.model?' ('+cap.model+')':'')+'만 지원 (CLI 선택은 최신 companion 필요)')+' · 사용자 harness는 자체 모델/도구를 사용하며 내부 격리는 미검증':' · 이 broker는 RED 실행을 지원하지 않습니다.'):'로컬 broker 연결 없음 · 파일 추출과 수동 JSON 교환만 가능합니다. 위 연결 패널을 확인하세요.';}
  // The record button is ledger-mounted; bridge changes before that only refresh the connection line.
  document.addEventListener('falsify:local-bridge',()=>{connection();if($('#red-record'))controls();if(helperReady())void recoverRed();});connection();if(helperReady())void recoverRed();
  function controls(){
    const active=!!doc&&!busy;
    const cap=B.capabilities();$('#red-start').disabled=!active||!cap?.red||!$('#red-consent').checked||!FalsifyLab.allowed('red');
    $('#red-record').disabled=!active||!response||pending.size>0;FalsifyLab.busy('red',busy||pending.size>0);B.busy('red',busy);
    $('#red-request').disabled=!active;$('#red-import-response').disabled=!active;
    $('#red-level').disabled=busy;$('#red-budget').disabled=busy;
    $('#red-cancel').hidden=!busy||!job;
    $('#red-plan').disabled=!active||!candidates.some(c=>c.selected);
    const count=candidates.filter(c=>c.selected).length;
    $('#red-selection-summary').textContent=count+'개 선택 · 처음에는 모두 미선택입니다. After를 바꾸면 이전 다운로드 검증은 무효입니다.';
    const plain=doc&&/^(TXT|MD|MARKDOWN|TEXT|TEX|CSV|TSV|RST)$/.test(doc.format);
    const pdf=doc?.format==='PDF'?pdfMode(cap):null,supported=plain||!!pdf&&pdf.kind!=='none';
    $('#red-download').disabled=!active||!count||!$('#red-export-consent').checked||!supported||sourceFileRequired;
    if(sourceFileRequired)ensureReselect();
    const mode=$('#red-export-mode');mode.hidden=!supported||!pdf;mode.replaceChildren();if(supported&&pdf)mode.append(...pdfModeText(pdf));
    // Reflow deliberately changes pagination, so its action never promises preservation or a finished copy.
    $('#red-download').textContent=pdf?.kind==='reflow'?'재배치·자체검사 후 실험용 사본 다운로드':'보존 검사 후 완성본 다운로드';
    if(doc&&!supported)statusText(doc.format==='PDF'?(cap?(pdf.engine?MISSING_ENGINE+' 후보와 편집한 After는 그대로 남고, 변경 계획 JSON은 지금 저장할 수 있습니다.':'PDF 보존 검사는 PyMuPDF가 설치된 로컬 broker가 필요합니다.'):'PDF 보존 검사는 연결된 로컬 broker가 필요합니다. 변경 계획 JSON은 저장할 수 있습니다.'):'이 형식은 레이아웃 검증 렌더러가 아직 없습니다. 완성본 다운로드를 차단하고 변경 계획만 저장합니다.');
    document.querySelectorAll('#red-candidates input,#red-candidates textarea').forEach(e=>e.disabled=busy);
    analysisControls(cap,active,count);IMG?.sync(busy);renderRecord();renderHandoff();
    document.dispatchEvent(new CustomEvent('falsify:document-state',{detail:doc?{name:doc.name,count:candidates.length,selected:count,busy,hasResult:!!response}:null}));
  }
  function cancelCurrent(){const old=job,l=jobLink;job=null;jobLink=null;if(old&&l)void l.request('/api/red/jobs/'+encodeURIComponent(old)+'/cancel',{}).catch(()=>{});}
  function clear(){generation++;cancelCurrent();analysisReset();IMG?.source(null);binding=null;doc=null;file=null;sourceFileRequired=false;candidates=[];response=null;request=null;busy=false;invalidate();$('#document-red').hidden=true;$('#red-candidates').replaceChildren();$('#red-empty').textContent=EMPTY;$('#red-response').value='';$('#red-record-status').textContent='';$('#red-export').hidden=true;$('#red-consent').checked=false;$('#red-harness-consent').checked=false;$('#red-export-consent').checked=false;statusText('');msg('');controls();}
  document.addEventListener('falsify:document-clear',clear);
  // The shell asks before replacing/closing the source; cancelling the discard confirmation keeps everything.
  document.addEventListener('falsify:before-document-change',e=>{if(e.detail?.role==='red'&&!keepEdits())e.preventDefault();});
  // Source binding is a busy phase keyed by its own identity: only clear() (reset/replacement) abandons it, so a harness-change
  // that slips in mid-hash cannot drop the current input, and a stale binding never touches a newer one's busy state.
  document.addEventListener('falsify:document',async event=>{
    clear();const self={};binding=self;busy=true;const {file:source,result}=event.detail;msg('원문 해시 확인 중 · 완료 전에는 harness 변경과 실행이 잠깁니다.');controls();
    try{const sourceHash=await hash(new TextEncoder().encode(result.text)),fileHash=await hash(await source.arrayBuffer());if(binding!==self)return;
      file=source;doc={revision:crypto.randomUUID(),sourceHash,fileHash,format:String(result.format).slice(0,40),name:source.name.slice(0,160),segments:result.segments.map((s,i)=>({...s,id:'s'+i}))};
      IMG?.source({file:source,fileHash,format:doc.format});$('#document-red').hidden=false;$('#red-document-summary').textContent=source.name+' · '+result.segments.length+'개 페이지/문단 · '+result.text.length.toLocaleString()+'자';
      msg('추출 텍스트 전체가 검토 대상입니다. 추출에서 빠진 이미지·수식·머리말 등은 읽었다고 주장하지 않습니다.');
    }catch(e){if(binding===self)msg('문서 바인딩 실패: '+e.message,true);}
    finally{if(binding===self){binding=null;busy=false;controls();}}
  });
  function renderCandidates(){
    const list=$('#red-candidates');list.replaceChildren();$('#red-empty').hidden=!!candidates.length;$('#red-empty').textContent=emptyNote();$('#red-export').hidden=!candidates.length;
    candidates.forEach((c,i)=>{
      const section=document.createElement('section');section.className='red-proposal';
      const choice=document.createElement('label');choice.className='check-row';const check=document.createElement('input');check.type='checkbox';check.checked=c.selected;
      const title=document.createElement('span');title.textContent='후보 '+(i+1)+' · '+c.label+' · L'+c.level;choice.append(check,title);section.append(choice);
      const rationale=document.createElement('p');rationale.textContent='공격 가설: '+c.rationale;section.append(rationale);
      const evidence=document.createElement('details'),summary=document.createElement('summary');summary.textContent='근거 인용 '+c.evidence.length+'개 · 원문 일치 확인';evidence.append(summary);
      c.evidence.forEach(e=>{const location=document.createElement('p');location.textContent=e.label+' — '+e.relation;const quote=document.createElement('blockquote');quote.textContent=e.quote;evidence.append(location,quote);});section.append(evidence);
      const comparison=document.createElement('div');comparison.className='red-ab';const before=document.createElement('div'),beforeTitle=document.createElement('h3'),beforeText=document.createElement('p');beforeTitle.textContent='Before · 원본 인용';beforeText.textContent=c.before;before.append(beforeTitle,beforeText);
      const after=document.createElement('div'),label=document.createElement('label'),area=document.createElement('textarea');area.id='red-after-'+i;area.rows=4;area.maxLength=4000;area.value=c.after;label.htmlFor=area.id;label.textContent='After · 직접 편집 가능';after.append(label,area);comparison.append(before,after);section.append(comparison);
      const uncertainty=document.createElement('p');uncertainty.className='muted';uncertainty.textContent='검증 한계: '+c.uncertainty;section.append(uncertainty);
      check.addEventListener('change',()=>{c.selected=check.checked;changed();});area.addEventListener('input',()=>{c.after=area.value;c.edited=true;changed();});list.append(section);
    });controls();
  }
  const MODEL_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
  // Validated proposals only. Manual JSON is not recorded as a model run; a broker result may carry its own model id.
  function bridgeWorkspace(validated,origin){const ws=globalThis.FalsifyPaperWorkspace;if(!ws||typeof ws.acceptProposals!=='function'||!validated.length)return;
    const modelRun=origin==='local-codex',hinted=modelRun&&typeof response?.model==='string'&&MODEL_ID.test(response.model)?response.model:undefined;
    const proposals=validated.map(c=>({segmentId:c.segmentId,before:c.before,after:c.after,anchor:Number.isInteger(c.offset)?{start:c.offset,end:c.offset+c.before.length}:undefined}));
    try{ws.acceptProposals(proposals,modelRun?{origin:'ai-proposal',...(hinted?{model:hinted}:{})}:{origin:'external-ai-import'});}catch{/* the validated RED response stays either way */}}
  function applyResponse(res,origin,ask=false){const validated=C.validateResponse(doc,res);if(ask&&!keepEdits()){msg('응답 적용 취소: 기존 후보와 편집을 그대로 유지했습니다.');return;}invalidate();candidates=validated;response={...res,provenance:origin};renderCandidates();void save(null);bridgeWorkspace(validated,origin);msg((res.status==='refusal'?'모델이 거절했습니다. 우회하거나 자동 재시도하지 않습니다.':res.status==='abstain'?'모델이 유보했습니다. 후보를 강제로 만들지 않고 자동 재시도하지 않습니다.':validated.length+'개 후보 · 인용 위치 확인 완료, 과학적 타당성 미검증.')+' '+H.outcomeText('red',res,origin)+'.');}
  async function makeRequest(){const budget=Number($('#red-budget').value);if(!Number.isInteger(budget)||budget<1||budget>32)throw new Error('호출 예산은 1–32 사이 정수입니다.');return FalsifyLab.bind('red',C.request(doc,Number($('#red-level').value),budget));}
  // While a response is retained, re-download its bound request so later final snapshots keep the root's requestId; only a fresh start mints a new execution request.
  $('#red-request').addEventListener('click',async()=>{const current=generation;try{const next=response&&request?request:await makeRequest();if(current!==generation)return;request=next;jsonDownload(request,'falsify-document-red-request.json');msg('수동 전달용 요청과 harness를 저장했습니다. 실행·전송은 하지 않았습니다.');}catch(e){msg(e.message,true);}});
  $('#red-import-response').addEventListener('click',async()=>{if(busy||!doc)return;const current=generation;try{const source=$('#red-response').value;if(source.length>150000)throw new Error('응답은 150,000자 이내입니다.');const next=request||await makeRequest();if(current!==generation)return;request=next;applyResponse(JSON.parse(source),'manual-unverified',true);}catch(e){msg('응답 적용 안 됨: '+e.message,true);}});
  async function holdRed(){
    const instance=B.capabilities()?.companionInstance||null;
    const held=await P.hold({role:'red',request,doc,companionInstance:instance,hashHarness:h=>H.hash(h)});
    if(!held.ok)throw new Error(held.message);
    return held;
  }
  async function postRed(l,held){
    request=held.record.request;
    const wire=JSON.stringify(request);
    if(await hash(new TextEncoder().encode(wire))!==held.record.requestBytesDigest)throw new Error('직렬화한 요청 바이트가 대기 기록과 달라 보내지 않았습니다.');
    let started;try{started=await l.request('/api/red/jobs',request);}catch(err){await P.note(held.record,{postReceipt:'unknown'});throw err;}
    if(!started||started.id!==request.requestId){await P.note(held.record,{postReceipt:'unknown'});throw new Error('서버가 저장한 요청 ID와 다른 작업을 돌려줘 그 작업을 이어받지 않았습니다.');}
    await P.note(held.record,{postReceipt:'accepted'});return started;
  }
  async function watchRed(current,l,strict){
    while(current===generation&&job){
      const data=await l.request('/api/red/jobs/'+encodeURIComponent(job));if(current!==generation||!job)return;
      if(strict){const found=P.read('red');if(found.status!=='record'||found.record.requestId!==job||!P.matches(found.record,data))throw new Error('조회한 작업의 식별이 저장한 요청과 달라 적용하지 않았습니다.');}
      if(data.state==='completed'){applyResponse(data.result,'local-codex');if(strict){const found=P.read('red');if(found.status==='record')await P.note(found.record,{disposition:'completed',finishedAt:Date.now()});}break;}
      if(['failed','cancelled'].includes(data.state)){if(strict){const found=P.read('red');if(found.status==='record'){await P.note(found.record,{disposition:data.state==='failed'?'failed':'cancelled',finishedAt:Date.now()});showPending({status:data.state==='failed'?'failed':'cancelled',record:found.record});}}throw new Error(data.error||'검토 취소됨');}
      if(strict){const found=P.read('red');if(found.status==='record'&&found.record.disposition!=='running')await P.note(found.record,{disposition:'running'});}
      msg('Harness 검토 중 · '+(data.progress.completedCalls||0)+' / '+(data.progress.requiredCalls||'?')+'회 완료 · 사용자 harness 내부 호출량은 별도입니다.');
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
  }
  function showPending(outcome){
    msg(P.text(outcome),outcome.status!=='still-running');
    const keep=!!outcome&&outcome.status&&outcome.status!=='absent'&&outcome.status!=='completed'&&outcome.status!=='still-running';
    let b=$('#red-pending-discard');
    if(keep&&!b){b=document.createElement('button');b.type='button';b.id='red-pending-discard';b.className='button secondary';b.textContent='이 대기 작업 버리기';$('#red-progress').after(b);
      b.addEventListener('click',()=>{generation++;cancelCurrent();const done=P.discard('red',{acknowledge:true});b.hidden=true;busy=false;job=null;jobLink=null;msg(done.ok?P.text({status:'discarded'}):done.message,!done.ok);controls();});}
    if(b)b.hidden=!keep;
  }
  function adoptRecovered(stored){
    doc={revision:stored.revision,sourceHash:stored.sourceHash,fileHash:stored.fileHash,format:stored.format,name:stored.name,segments:stored.segments.map(s=>({...s}))};
    file=null;sourceFileRequired=true;binding=null;$('#document-red').hidden=false;
    $('#red-document-summary').textContent=(doc.name||'복구된 문서')+' · 추출 텍스트만 복구됨 · 원본 파일은 다시 선택해야 내보낼 수 있습니다';
    IMG?.source(null);controls();
  }
  async function probe(role,id){
    const l=B.session();if(!l)return {httpStatus:0,body:null};
    try{return {httpStatus:200,body:await l.request('/api/'+role+'/jobs/'+encodeURIComponent(id))};}
    catch(e){const m=String(e&&e.message||'');
      if(m.includes('401')||m.includes('403')||m.includes('인증을 거부'))return {httpStatus:403,body:null};
      if(m.includes('404')||m.includes('not_found')||m.includes('찾을 수 없습니다'))return {httpStatus:404,body:null};
      return {httpStatus:0,body:null};}
  }
  async function resumeRed(outcome){
    const l=B.session();if(!l){showPending({status:'unpaired',record:outcome.record});return;}
    adoptRecovered(outcome.doc);request=outcome.record.request;
    if(outcome.record.postReceipt!=='accepted')await P.note(outcome.record,{postReceipt:'accepted'});
    const current=generation;busy=true;job=outcome.record.requestId;jobLink=l;controls();msg(P.text(outcome));
    try{await watchRed(current,l,true);}catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않았습니다.',true);}
    finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
  }
  function showRecoveredRed(outcome){adoptRecovered(outcome.doc);request=outcome.record.request;applyResponse(outcome.result,'local-codex');msg(P.text(outcome)+' '+$('#red-progress').textContent);}
  async function recoverRed(){
    if(!helperReady()||recovering||busy)return;
    const found=P.read('red');if(found.status==='absent')return;
    if(doc){if(found.status==='record'&&doc.sourceHash===found.record.sourceHash&&doc.fileHash===found.record.fileHash&&doc.revision===found.record.revision&&(job||found.record.disposition==='completed'))return;showPending(found.status==='record'?{status:'unresolved',record:found.record}:found);return;}
    if(!B.state().connected){showPending(found.status==='record'?{status:'unpaired',record:found.record}:found);return;}
    recovering=true;
    try{
      const outcome=await P.recover({role:'red',companionInstance:B.capabilities()?.companionInstance||null,hashHarness:h=>H.hash(h),validate:(d,res)=>C.validateResponse(d,res),getJob:id=>probe('red',id)});
      if(!outcome||outcome.status==='absent')return;
      if(outcome.status==='still-running'){await resumeRed(outcome);return;}
      if(outcome.status==='completed'){showRecoveredRed(outcome);const rec=P.read('red');if(rec.status==='record')await P.note(rec.record,{disposition:'completed',finishedAt:Date.now()});return;}
      if((outcome.status==='failed'||outcome.status==='cancelled')&&outcome.record)await P.note(outcome.record,{disposition:outcome.status,finishedAt:Date.now()});
      showPending(outcome);
    }finally{recovering=false;}
  }
  async function confirmReselect(){
    const input=$('#red-source-reselect');const chosen=input&&input.files&&input.files[0];if(!chosen||!doc||!sourceFileRequired)return;
    try{const next=await hash(await chosen.arrayBuffer());
      if(next!==doc.fileHash){input.value='';exportStatus('다시 고른 파일의 SHA-256이 검토에 쓰인 원본과 다릅니다. 내보내지 않습니다.',true);return;}
      file=chosen;sourceFileRequired=false;IMG?.source({file,fileHash:doc.fileHash,format:doc.format});
      exportStatus('원본 파일 SHA-256이 검토 때와 같습니다. 내보내기를 계속할 수 있습니다.');controls();
    }catch(e){exportStatus('원본 파일을 확인하지 못했습니다: '+e.message,true);}
  }
  function ensureReselect(){
    let input=$('#red-source-reselect');
    if(!input){const row=document.createElement('div');row.className='button-row';row.id='red-source-reselect-row';input=document.createElement('input');input.type='file';input.id='red-source-reselect';input.hidden=true;
      const label=document.createElement('label');label.className='button secondary';label.htmlFor=input.id;label.textContent='원본 파일 다시 선택';row.append(label,input);
      ($('#red-export-status')||$('#red-progress')).after(row);input.addEventListener('change',()=>{void confirmReselect();});}
    const row=$('#red-source-reselect-row');if(row)row.hidden=!sourceFileRequired;
  }
  $('#red-start').addEventListener('click',async()=>{
    if(busy||!doc||!$('#red-consent').checked||!FalsifyLab.allowed('red')||!keepEdits())return;const current=generation;
    if(expectsHelper()){
      if(!helperReady()){msg('대기 기록 도우미가 없거나 손상되어 실행하지 않았습니다. 요청을 보내지 않습니다.',true);return;}
      busy=true;controls();
      let l,held=null;
      try{l=link();request=await makeRequest();if(current!==generation)return;held=await holdRed();}
      catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않았습니다.',true);}
      finally{if(!held){busy=false;controls();}}
      if(current!==generation){busy=false;controls();return;}
      if(!held)return;
      candidates=[];response=null;invalidate();$('#red-export-status').textContent='';$('#red-export-consent').checked=false;renderCandidates();controls();
      try{msg('전체 검토 예산 확인 후 선택 harness를 실행합니다.');const started=await postRed(l,held);
        if(current!==generation){void l.request('/api/red/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}
        job=started.id;jobLink=l;controls();await watchRed(current,l,true);
      }catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않았습니다.',true);}
      finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
      return;
    }
    // UNSHIPPED_TEST_ISOLATION: document-red.js loaded with neither pending-job.js nor the shipped script tag.
    // Standalone page VMs keep this direct POST. index.html always includes the helper and never uses this branch.
    busy=true;candidates=[];response=null;invalidate();$('#red-export-status').textContent='';$('#red-export-consent').checked=false;renderCandidates();controls();
    try{const l=link();request=await makeRequest();if(current!==generation)return;msg('전체 검토 예산 확인 후 선택 harness를 실행합니다.');const started=await l.request('/api/red/jobs',request);
      if(current!==generation){void l.request('/api/red/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}
      job=started.id;jobLink=l;controls();
      await watchRed(current,l,false);
    }catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않았습니다.',true);}
    finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
  });
  $('#red-cancel').addEventListener('click',()=>{generation++;cancelCurrent();busy=!!binding;msg('취소 요청. 이미 시작된 CLI 호출은 종료/최대 180초까지 실행될 수 있지만 결과는 적용하지 않습니다.');controls();});
  for(const id of ['#red-consent','#red-export-consent'])$(id).addEventListener('change',controls);
  document.addEventListener('falsify:harness-consent',controls);
  document.addEventListener('falsify:harness-change',e=>{if(e.detail.role!=='red')return;snapshot();discard();msg('harness 변경: 이전 응답 무효화. 기록한 실행은 별도로 보존됩니다.');});
  $('#red-record').addEventListener('click',()=>{if(!doc||!response||busy)return;let final;try{final=finalState();}catch(e){failure={key:null,message:'현재 선택을 기록할 수 없습니다: '+e.message};renderRecord();return;}if(saved.has(key(final))){failure=null;renderRecord('변경이 없어 다시 기록하지 않았습니다. ');return;}void save(final);});
  for(const [id,name] of [['#red-level','level'],['#red-budget','budget']])$(id).addEventListener('change',()=>{const field=$(id);if(!keepEdits()){field.value=settings[name];return;}settings[name]=field.value;discard();msg('검토 설정이 바뀌어 이전 응답·후보 선택을 무효화했습니다. 새 요청을 만드세요.');});
  function plan(patches,extra={}){return {schema:'falsify.document-edit-plan.v1',revision:doc.revision,sourceHash:doc.sourceHash,sourceFileHash:doc.fileHash,sourceName:doc.name,format:doc.format,selected:patches,
    harness:request?.harness||null,harnessHash:response?.harnessHash||null,
    candidateRationales:candidates.filter(c=>c.selected).map(c=>({id:c.id,rationale:c.rationale,evidence:c.evidence,uncertainty:c.uncertainty})),reviewProvenance:response?.provenance,coverage:response?.coverage||null,
    status:{domainReview:'pending',teamApproval:'pending',gold:'pending',metric:null},...extra};}
  $('#red-plan').addEventListener('click',()=>{try{jsonDownload(plan(C.patches(doc,candidates)),'falsify-document-edit-plan.json');exportStatus('선택 변경과 근거를 저장했습니다. 이 파일은 BLUE에 전달하지 마세요.');}catch(e){exportStatus(e.message,true);}});
  function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
  function statusText(s){const e=$('#red-export-status');e.replaceChildren();e.textContent=s;return e;}
  function exportStatus(s,error=false){statusText(s).classList.toggle('error',error);}
  const node=(tag,className,text)=>{const x=document.createElement(tag);x.className=className;x.textContent=text;return x;};
  // Success hierarchy: one ink outcome line, a separate short added-page line, the self-check boundary as a discrete state, then secondary engine diagnostics. textContent only.
  function successStatus(r,limits){const e=statusText('');e.classList.toggle('error',false);
    const out=[node('span','red-export-outcome','실험용 사본과 별도 변경 계획을 다운로드했습니다.'+(r.facts.length?' '+(r.check?'엔진 자체검사 결과: ':'')+r.facts.join(' · ')+'.':''))];
    if(r.continuation)out.push(node('span','red-export-outcome',continuedText(r)));
    if(r.check){const c=node('span','red-export-check','');c.append(node('span','status-label',r.check.label),' '+r.check.text);out.push(c);}
    if(r.check?.qa){const q=node('span','red-export-check red-export-qa','');q.append(node('span','status-label',QA_LABEL[r.check.qa.state]),' '+qaText(r.check.qa));out.push(q);}
    if(r.notes?.length){const list=node('ul','red-export-notes','');for(const n of r.notes){const li=node('li','','');li.append(node('span',n.severity==='warning'||n.severity==='error'?'note-warning':'note-info',SEVERITY[n.severity]||'심각도 미보고'),' · '+n.phrase+' ',node('span','red-export-code','('+n.detail+')'));list.append(li);}out.push(list);}
    if(limits)out.push(node('span','red-export-limits',limits));
    e.append(...out);}
  // PDF pre-analysis: one request bound to this doc, file, hash and exact selected Before/After under a fixed deadline; any change discards it.
  const ANALYSIS_NEED_LINK='선택 사항 · PDF 사전분석은 연결된 로컬 companion이 필요합니다. 연결 없이도 검토·수동 JSON 교환·변경 계획 저장은 그대로 쓸 수 있습니다.';
  const ANALYSIS_OLD='이 companion은 PDF 사전분석을 지원하지 않습니다(구버전). 위 연결 패널 안내로 companion을 업데이트한 뒤 다시 연결하세요. 다른 작업은 그대로 쓸 수 있습니다.';
  const ANALYSIS_OFF='연결된 companion에서 PDF 사전분석을 지금 쓸 수 없습니다. 다른 작업은 그대로 쓸 수 있습니다.';
  const ANALYSIS_FAILED='사전분석 요청이 실패했습니다(연결·인증·companion 오류 또는 다른 작업 진행 중). 원본·후보·편집·다운로드 상태는 그대로입니다.';
  const ANALYSIS_STALE='사전분석 중 원본이나 선택한 변경이 바뀌어 결과를 버렸습니다.';
  function analysisText(s,error=false){const e=$('#red-analysis-status');if(!e)return;e.textContent=s;e.classList?.toggle('error',error);}
  function analysisReset(){const old=analysis;analysis=null;old?.abort();const box=$('#red-analysis-result');if(box)box.hidden=true;$('#red-analysis-body')?.replaceChildren();analysisText('');}
  function analysisList(){return A.patches(candidates.some(c=>c.selected)?C.patches(doc,candidates):[]);}
  function analysisControls(cap,active,count){const panel=$('#red-analysis');if(!panel)return;const on=!!A&&doc?.format==='PDF';panel.hidden=!on;if(!on)return;
    const s=B.state(),pa=cap?.paperAnalysis,ready=!!s.connected&&pa?.available===true,button=$('#red-analyze'),note=$('#red-analysis-note');if(button)button.disabled=!active||!ready;
    if(note)note.textContent=!s.connected?ANALYSIS_NEED_LINK:!pa?ANALYSIS_OLD:!pa.available?ANALYSIS_OFF:'선택 사항 · 연결된 companion이 원본 PDF'+(count?'와 선택한 후보 '+count+'개의 줄 공간':'')+'을 검사합니다. 모델은 호출하지 않으며 결과는 참고용 힌트입니다.';}
  function renderAnalysis(v){const body=$('#red-analysis-body'),box=$('#red-analysis-result');if(!body||!box)return;
    const group=(title,items)=>{const list=node('ul','red-analysis-list','');for(const t of items)list.append(node('li','',t));return [node('p','red-analysis-label',title),list];};
    body.replaceChildren(...group('개수 요약',v.counts),...group('선택한 후보의 줄 공간',v.layout),...group('한계',v.notes));box.hidden=false;}
  $('#red-analyze')?.addEventListener('click',async()=>{
    if(busy||!doc||!file||doc.format!=='PDF'||!A||!B.state().connected||B.capabilities()?.paperAnalysis?.available!==true)return;
    let list;try{list=analysisList();if(file.size>A.MAX_FILE_BYTES)throw Object.assign(new Error('25MiB를 넘는 PDF는 사전분석하지 않습니다.'),{analysis:true});}
    catch(e){analysisReset();analysisText(e.analysis?e.message:'선택한 변경을 확인할 수 없어 사전분석을 요청하지 않았습니다: '+e.message,true);return;}
    analysisReset();const l=B.session();if(!l){analysisText(ANALYSIS_NEED_LINK,true);return;}
    const current=generation,source=doc,bytes=file,key=JSON.stringify(list),labels={};candidates.filter(c=>c.selected).forEach((c,k)=>{labels['edit-'+(k+1)]='후보 '+(candidates.indexOf(c)+1);});
    const controller=typeof AbortController==='function'?new AbortController():null,self={abort:()=>controller?.abort()};let timer=null,expired=false;
    analysis=self;busy=true;controls();analysisText('원본 PDF'+(list.length?'와 선택한 후보 '+list.length+'개':'')+'를 companion에서 사전분석하는 중입니다. 모델은 호출하지 않으며 '+A.DEADLINE_MS/1000+'초가 지나면 중단합니다.');
    const stale=()=>{let now=null;try{now=JSON.stringify(analysisList());}catch{}return analysis!==self||current!==generation||doc!==source||file!==bytes||now!==key;};
    try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller?.abort();reject(new Error('deadline'));},A.DEADLINE_MS);});
      const body=A.request(source.fileHash,base64(new Uint8Array(await Promise.race([bytes.arrayBuffer(),deadline]))),list);if(stale())return;
      const res=await Promise.race([l.request('/api/paper/inspect',body,controller?{signal:controller.signal}:undefined),deadline]);
      if(stale()){if(analysis===self&&current===generation)analysisText(ANALYSIS_STALE);return;}
      const v=A.view(A.summary(res,{sourceSha256:source.fileHash,ids:list.map(p=>p.id)}),labels);renderAnalysis(v);analysisText(v.headline);}
    catch(e){if(analysis===self&&current===generation)analysisText(expired?'사전분석이 '+A.DEADLINE_MS/1000+'초 안에 끝나지 않아 중단했습니다. 원본·후보·편집·다운로드 상태는 그대로입니다.':e?.analysis?e.message:ANALYSIS_FAILED,true);}
    finally{clearTimeout(timer);if(analysis===self)analysis=null;if(current===generation){busy=false;controls();}}
  });
  // Image replacement holds the same RED busy phase as export/analysis; the release is bound to this generation and runs once.
  function imageHold(){if(busy||!doc||binding)return null;const current=generation;let done=false;busy=true;controls();return ()=>{if(done)return;done=true;if(current===generation){busy=false;controls();}};}
  // PDF export path comes only from authenticated capabilities: reflow-capable editor, editor without reflow, legacy single-line preservation, or none.
  function pdfMode(cap){const e=cap?.pdfEditor||null;return {kind:e?.available?(e.reflow?'reflow':'editor'):cap?.pdf?'legacy':'none',engine:e};}
  const MISSING_ENGINE='줄바꿈 재배치 PDF 편집 엔진이 이 companion에 아직 준비되지 않았습니다. 위 연결 패널의 설치·실행 안내로 companion을 다시 준비한 뒤 연결하세요.';
  const SCOPE='재배치 대상은 1단·회전 없음·잘림 없음인 최상위 본문 텍스트뿐이며, 그 밖의 텍스트는 재배치하지 않습니다.';
  const CONTINUATION='새로 추가되는 이어지는 페이지는 본문만 담고 머리말·꼬리말·쪽번호가 없으며, 뒤쪽 원래 페이지의 쪽번호는 다시 매기지 않습니다.';
  const CONTINUED='추가된 이어지는 페이지에는 본문만 있고 머리말·꼬리말·쪽번호가 없으며, 뒤쪽 원래 페이지의 쪽번호는 다시 매기지 않았습니다.';
  // Engine-declared header/footer copy (policy source-number-suffix). The mode line states the capability; copying is claimed only per output report.
  // Numbering is a conditional engine policy (standalone Arabic source number only); no output report carries a numbering fact.
  const NUMBERING='원래 쪽번호는 바꾸지 않으며, 원본에 단독 아라비아 숫자 쪽번호가 있으면 추가 페이지는 그 번호에 소수 접미(예: 10.1)를 붙입니다.';
  const CONTINUATION_STYLED='추가 페이지에도 원본 머리말·꼬리말 텍스트와 글꼴을 이어갑니다. '+NUMBERING+' 이미지·도형 머리말·꼬리말이 있으면 내보내기를 차단합니다. 실제 적용 여부는 다운로드 결과에 표시합니다.';
  const CONTINUED_UNKNOWN='추가 페이지 머리말·꼬리말·쪽번호 적용 여부는 엔진이 확인 가능한 형태로 보고하지 않았습니다.';
  // Copying is claimed only for a whole-output report (every added page copied), with numbering kept as present-tense policy and no example number.
  // A style-declaring engine with a missing, malformed or mismatched report is unknown; only engines without the style read body-only.
  function continuedText(r){return r.style?'엔진 보고: 추가 페이지 '+r.style.copiedPages+'쪽 모두에 원본 머리말·꼬리말 텍스트를 이어 붙였습니다. 원래 쪽번호는 바꾸지 않으며, 원본에 단독 아라비아 숫자 쪽번호가 있으면 추가 페이지는 그 번호에 소수 접미를 붙입니다.':r.styleCapable?CONTINUED_UNKNOWN:CONTINUED;}
  // Engine source link is display-only and comes from the bridge-sanitized descriptor; re-checked here, never fetched.
  const SOURCE=/^https:\/\/github\.com\/Shinick-Han\/[A-Za-z0-9._~\/-]{1,250}$/;
  const LIMITS={maxEdits:n=>'변경 최대 '+n+'개',maxTextChars:n=>'After 최대 '+n.toLocaleString()+'자',maxAddedPages:n=>'추가 페이지 최대 '+n+'쪽',maxFileBytes:n=>'파일 최대 '+Math.floor(n/1048576)+' MB'};
  function limitText(l){if(typeof l==='string')return l.slice(0,300);if(!l||typeof l!=='object')return '';return Object.entries(LIMITS).filter(([k])=>whole(l[k])).map(([k,f])=>f(l[k])).join(' · ');}
  function engineName(e){const out=['PDF 편집 엔진 '+e.engine+' '+e.version];
    if(typeof e.sourceUrl==='string'&&SOURCE.test(e.sourceUrl)){const a=node('a','red-engine-source','엔진 소스');a.href=e.sourceUrl;a.target='_blank';a.rel='noopener noreferrer';out.push(' (',a,')');}
    return out;}
  // Reflow mode note: scope, added-page behaviour and the self-check/limits boundary as separate sentence groups (existing block class).
  function pdfModeText(m){const e=m.engine,limit=e?limitText(e.limits):'',tail=limit?' 엔진 제한: '+limit+'.':'';
    if(m.kind==='reflow')return [...engineName(e),' · 원래 줄 공간을 넘는 After는 줄바꿈 재배치'+(e.pagination?'와 필요 시 이어지는 페이지 추가':'(페이지 추가는 미지원)')+'를 시도합니다. '+SCOPE,
      ...(e.pagination?[node('span','red-export-outcome',styled(e)?CONTINUATION_STYLED:CONTINUATION)]:[]),node('span','red-export-outcome','실제 줄바꿈·페이지 수는 출력 사본의 엔진 자체검사 결과로만 표시합니다.'+tail)];
    if(m.kind==='editor')return [...engineName(e),' · 이 버전은 줄바꿈 재배치를 지원하지 않아 원래 줄 공간에 들어가는 변경만 가능합니다.'+tail];
    return ['기존 한 줄 보존 편집 · 원래 줄 공간에 들어가는 변경만 가능하며 줄바꿈·페이지 추가가 필요한 After는 차단됩니다.'+(e?' '+MISSING_ENGINE:' 긴 After의 줄바꿈 재배치는 최신 companion이 필요합니다.')];}
  const whole=x=>Number.isSafeInteger(x)&&x>=0;
  const STYLE_POLICY='source-number-suffix',styled=e=>e?.pagination===true&&e.continuationStyle?.supported===true&&e.continuationStyle.policy===STYLE_POLICY;
  // Per-output style report: exact policy, applied === true, layoutVerified === true and copiedPages in 1..32 equal to both the
  // counted page growth and the reported addedPages. Unknown or mismatched counts make no copy claim (unknown under a style-declaring engine).
  const MAX_COPIED_PAGES=32;
  function continuationReport(v,added){const s=v.continuationStyle;
    return v.layoutVerified===true&&s&&typeof s==='object'&&s.policy===STYLE_POLICY&&s.applied===true&&whole(s.copiedPages)&&s.copiedPages>0&&s.copiedPages<=MAX_COPIED_PAGES
      &&s.copiedPages===added&&s.copiedPages===v.addedPages?{copiedPages:s.copiedPages}:null;}
  function diagnostics(v){return Array.isArray(v?.diagnostics)?v.diagnostics.slice(0,5).map(x=>typeof x==='string'?x:x?.message).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.slice(0,300)):[];}
  // Known engine warning codes get fixed Korean phrases; severity is shown only as reported, unknown codes keep their bounded code.
  const NOTES={engine_model_lines_stale:'엔진 내부 줄 모델이 편집 뒤 갱신되지 않았다고 보고됨',pagination_required:'긴 After를 담으려고 이어지는 페이지가 필요했다고 보고됨',content_stream_append_order:'엔진이 추가 콘텐츠의 그리기/추출 순서 확인을 요청함'};
  const SEVERITY={info:'정보',warning:'주의',error:'주의'};
  function engineNotes(v){
    if(Array.isArray(v.warnings)&&v.warnings.some(w=>typeof w?.code==='string'))return v.warnings.filter(w=>typeof w?.code==='string').slice(0,8).map(w=>{const code=w.code.slice(0,64);
      return {severity:typeof w.severity==='string'&&SEVERITY[w.severity]?w.severity:null,phrase:Object.hasOwn(NOTES,code)?NOTES[code]:'알 수 없는 엔진 진단 코드',detail:code+(whole(w.pageIndex)?', p. '+(w.pageIndex+1):'')};});
    return diagnostics(v).map(d=>({severity:null,phrase:'엔진 진단',detail:d}));}
  // The self-check is the same engine re-reading its own output; independence and QA are read from the payload and never claimed.
  // Legacy pending/missing QA stays in the self-check line; a reported independent QA state gets its own label next to it.
  function selfCheck(v,q){return {label:v.selfCheck?.independent===false?'같은 엔진 자체검사':'엔진 자체검사 · 독립성 미보고',
    text:(q.state==='pending'?'독립 추출/렌더링·사람 검수 대기 · ':q.state==='unreported'?'독립 검수 상태 미보고 · ':'')+'레이아웃 검사일 뿐 과학적 타당성·결함 품질 판정이 아닙니다.',qa:Object.hasOwn(QA_LABEL,q.state)?q:null};}
  // Independent QA (falsify.pdf-quality.v1) is a bounded second extraction/render check, never full visual, performance or scientific proof.
  // Only an exact, self-consistent payload reads passed; unknown or malformed reads unverified. Only safe codes and page counts are shown.
  const QA_STATES=['passed','warning','failed','unavailable'],QA_CODE=/^[a-z][a-z0-9_]{0,47}$/,QA_METHOD=/^[a-z0-9][a-z0-9._-]{0,47}$/;
  const QA_LABEL={passed:'독립 검사 통과',warning:'독립 검사 주의',unavailable:'독립 검사 미실행',malformed:'독립 검사 형식 확인 불가'},HUMAN=' 사람의 과학 검수는 아직 대기 중입니다.';
  function qaChecks(x,state){
    if(!x||typeof x!=='object'||x.schema!=='falsify.pdf-quality.v1'||x.status!==state||typeof x.method!=='string'||!Array.isArray(x.checks)||x.checks.length>64||!Array.isArray(x.limitations)||!x.limitations.every(s=>typeof s==='string'))return null;
    const checks=[];for(const c of x.checks){if(!c||typeof c.code!=='string'||!QA_STATES.includes(c.status)||!Array.isArray(c.pages)||c.pages.length>10000||!c.pages.every(p=>Number.isSafeInteger(p)&&p>=1))return null;checks.push({code:QA_CODE.test(c.code)?c.code:null,status:c.status,pages:new Set(c.pages).size});}
    // The overall status must agree with its items: passed has only passed items, and any failed item means failed.
    if(state==='passed'&&(!checks.length||checks.some(c=>c.status!=='passed'))||state!=='failed'&&checks.some(c=>c.status==='failed'))return null;
    return {method:QA_METHOD.test(x.method)?x.method:null,checks};}
  function independentQA(v){const s=v?.independentQA;
    if(s==='failed'||v?.independentChecks?.status==='failed')return {state:'failed',checks:qaChecks(v.independentChecks,'failed')?.checks||[]};
    if(!QA_STATES.includes(s))return {state:s==='pending'?'pending':'unreported'};
    const q=qaChecks(v.independentChecks,s);return q?{state:s,...q}:{state:'malformed'};}
  function qaItems(checks){return checks.filter(c=>c.status!=='passed').slice(0,6).map(c=>(c.code||'형식 외 코드')+(c.pages?' '+c.pages+'쪽':'')).join(', ');}
  function qaText(q){const items=q.checks?qaItems(q.checks):'',method=q.method?' ('+q.method+')':'';
    if(q.state==='passed')return '제한된 독립 추출·렌더 검사 '+q.checks.length+'항목 통과'+method+'. 전체 시각 품질·성능을 증명하지는 않습니다.'+HUMAN;
    if(q.state==='warning')return '제한된 독립 추출·렌더 검사에서 확인할 항목'+(items?': '+items:'이 보고됨')+method+'. 다운로드는 그대로 진행했습니다.'+HUMAN;
    if(q.state==='unavailable')return '이 환경에서 독립 추출·렌더 검사를 하지 못했습니다'+(items?' ('+items+')':'')+'.'+HUMAN;
    return '독립 검사 결과 형식을 확인할 수 없어 통과로 보지 않습니다.'+HUMAN;}
  // Layout facts are read only from the engine's verification of this output; missing or malformed fields read as unverified, never assumed.
  // styleCapable is the export-time descriptor (styled engine), so a bad report under it reads as unknown rather than body-only.
  function layoutReport(v,styleCapable){
    if(v?.engine==='falsify-pdf-editor'){const r=v.reflow,p=v.pagination,facts=[],counted=whole(p?.inputPages)&&whole(p?.outputPages)&&p.outputPages>=p.inputPages,grew=counted&&p.outputPages>p.inputPages;
      facts.push(counted?(grew?'페이지 '+p.inputPages+' → '+p.outputPages+' (새 페이지 '+(p.outputPages-p.inputPages)+'쪽)':'페이지 수 그대로 '+p.outputPages+'쪽'):'페이지 수 변화 미검증');
      facts.push(whole(r?.wrappedLines)?(r.wrappedLines?'줄바꿈 재배치 '+r.wrappedLines+'줄':'줄바꿈 없이 교체'):'줄바꿈 결과 미보고');
      const added=grew?p.outputPages-p.inputPages:0;
      return {facts,continuation:grew,style:grew?continuationReport(v,added):null,styleCapable:styleCapable===true,check:selfCheck(v,independentQA(v)),notes:engineNotes(v)};}
    if(v?.mode==='pdf-original-font-single-line')return {facts:['기존 한 줄 교체 · 줄바꿈·페이지 추가 없음'+(whole(v.pages)?' · '+v.pages+'쪽':'')]};
    return {facts:[]};}
  function recovery(kind){if(!kind)return '';const keep=' 선택한 후보와 직접 편집한 After는 그대로 남아 있습니다.';
    if(kind==='reflow')return keep+' 긴 After의 재배치는 1단·회전 없음·잘림 없음인 최상위 본문 텍스트에서만 됩니다. 해당 후보 선택을 해제하거나 After를 직접 조정해 다시 시도하거나, 변경 계획 JSON만 저장할 수 있습니다. 엔진·연결 오류라면 위 연결 패널에서 companion을 다시 실행·연결하세요.';
    return keep+' 이 companion은 원래 줄 공간에 들어가는 변경만 지원합니다. 줄바꿈 재배치 엔진이 있는 companion으로 다시 연결하거나, 다른 후보를 고르거나, 변경 계획 JSON만 저장할 수 있습니다.';}
  function workspacePdfOpen(){
    const ws=globalThis.FalsifyPaperWorkspace;
    if(!ws||typeof ws.getSource!=='function')return false;
    let src=null;
    try{src=ws.getSource();}catch{return false;}
    const chosen=src&&src.file;
    if(!chosen)return false;
    return String(chosen.name||'').toLowerCase().endsWith('.pdf')||chosen.type==='application/pdf';
  }
  $('#red-download').addEventListener('click',async()=>{
    if(busy||!doc||!$('#red-export-consent').checked)return;
    if(sourceFileRequired||!file){exportStatus('복구된 검토는 원본 파일을 다시 고르고 SHA-256이 같을 때만 내보냅니다.',true);return;}
    if(doc.format==='PDF'&&workspacePdfOpen()){
      exportStatus('PDF 작업대가 이 원본을 열고 있습니다. companion과 레이아웃 검증 없이, 위쪽 「현재 편집으로 생성」으로 생성본을 만든 뒤 그 파일을 받으세요.',true);
      const gen=$('#paper-generate');if(gen&&typeof gen.focus==='function')gen.focus();
      return;
    }
    const current=generation,pdf=doc.format==='PDF'?pdfMode(B.capabilities()):null;busy=true;preview?.clear();controls();exportStatus(pdf?.kind==='reflow'?'선택 변경만 적용하고 재배치·자체검사 중':'선택 변경만 적용하고 보존 검사 중');
    try{const patches=C.patches(doc,candidates);let output,reported=null;
      // Same request body as before: only checked candidates' Before plus the user's current After; progress is staged text, never an invented percentage.
      if(pdf){exportStatus('원본 PDF와 선택 변경 '+patches.length+'개를 companion에서 '+(pdf.kind==='reflow'?'교체·줄바꿈 재배치·엔진 자체검사':'한 줄 교체·보존 검사')+'하는 중입니다. 엔진이 진행률을 알려주지 않아 퍼센트는 표시하지 않습니다.');
        const result=await link().request('/api/export',{format:doc.format,fileHash:doc.fileHash,file:base64(new Uint8Array(await file.arrayBuffer())),patches});if(current!==generation)return;
        exportStatus('companion 결과 수신 · 출력 파일과 레이아웃 검증 확인 중');reported=typeof result.outputFileHash==='string'?result.outputFileHash:null;
        output={bytes:Uint8Array.from(atob(result.file),x=>x.charCodeAt(0)),verification:result.verification};
        // Fail closed: a new-engine export downloads only with explicit layoutVerified === true; missing, null or false proof is never success.
        const v=output.verification,d=diagnostics(v),engine=pdf.kind==='reflow'||pdf.kind==='editor'||v?.engine==='falsify-pdf-editor';
        if(engine&&(v?.engine!=='falsify-pdf-editor'||v.layoutVerified!==true))throw new Error((v?.layoutVerified===false?'엔진이 이 출력의 레이아웃 검증을 통과시키지 못해':'엔진이 이 출력의 레이아웃 검증 통과를 증명하지 않아')+' 다운로드하지 않았습니다.'+(d.length?' 엔진 진단: '+d.join(' / '):''));
        // Defense in depth: a failed independent check never downloads even if the companion still returned bytes; warning/unavailable do not block.
        const qa=independentQA(v);if(qa.state==='failed'){const items=qaItems(qa.checks);throw new Error('독립 추출·렌더 검사가 실패로 보고되어 받은 파일을 다운로드하지 않았습니다.'+(items?' 실패 항목: '+items+'.':''));}}
      else output=await FalsifyExport.textFile(file,patches);
      if(current!==generation)return;
      const outputFileHash=await hash(output.bytes);if(current!==generation)return;
      if(reported&&reported!==outputFileHash)throw new Error('companion이 보고한 출력 해시와 받은 파일이 달라 다운로드하지 않았습니다.');
      const name=file.name.replace(/(\.[^.]+)$/,'-falsify-research$1'),type=file.type||'application/octet-stream';download(output.bytes,name,type);jsonDownload(plan(patches,{outputFileHash,verification:output.verification}),'falsify-document-edit-plan.json');
      exported={outputFileHash,verification:output.verification,file:new File([output.bytes],name,{type})};const final={selected:patches,outputFileHash,verification:output.verification};exported.key=key(final);void save(final);
      successStatus(pdf?layoutReport(output.verification,styled(pdf.engine)):{facts:[]},typeof output.verification?.limits==='string'?output.verification.limits.slice(0,400):'');
      // Preview the exact File just downloaded and handed to BLUE, only for PDF; a preview failure never touches `exported` or the download.
      if(pdf)void preview?.show({file:exported.file,sha256:outputFileHash});
    }catch(e){if(current===generation)exportStatus('다운로드 차단: '+e.message+recovery(pdf?.kind),true);}
    finally{if(current===generation){busy=false;controls();}}
  });
  // Final snapshot = what the user actually selected/edited; output hash only while the exported bytes still match.
  function finalState(){if(!candidates.some(c=>c.selected))return null;return {selected:C.patches(doc,candidates),outputFileHash:exported?.outputFileHash||null,verification:exported?.verification||null};}
  function key(final){return epoch+':'+JSON.stringify(final);}
  function currentKey(){try{return key(finalState());}catch{return null;}}
  function unrecorded(){return !!response&&(pending.size>0||!saved.has(key(null))||candidates.some(c=>c.selected||c.edited)&&!saved.has(currentKey()));}
  function keepEdits(){return !unrecorded()||confirm('선택·편집한 RED 후보가 아직 기록되지 않았습니다. 계속하면 후보와 편집 내용이 사라집니다. 계속할까요?');}
  function invalidate(){epoch++;exported=null;lastSaved=null;failure=null;saved.clear();pending.clear();preview?.clear();}
  function discard(){generation++;cancelCurrent();analysisReset();busy=!!binding;if(doc)doc.revision=crypto.randomUUID();candidates=[];response=null;request=null;invalidate();renderCandidates();}
  function changed(){exported=null;preview?.clear();exportStatus('');analysisReset();controls();}
  // One root per execution: a final snapshot first awaits (or retries) the original response save and links to it via snapshotOf.
  // If the original cannot be persisted the final snapshot is not recorded either, so no second root ever appears.
  // isCurrent is live-only: the ledger checks it right before persisting, so a source/settings reset cancels a stale save.
  function save(final){
    if(!doc||!response)return Promise.resolve(null);const k=key(final);
    if(saved.has(k))return Promise.resolve(saved.get(k));if(pending.has(k))return pending.get(k);
    const current=generation,at=epoch,live=()=>current===generation&&at===epoch,state={doc,request,response};
    const job=Promise.resolve().then(async()=>{
      try{const extras={isCurrent:live};
        if(final){const root=await save(null);if(!live())return null;if(!root)throw new Error('원본 모델 응답이 기록되지 않아 최종 선택·편집도 기록하지 않았습니다.');extras.finalState=final;extras.snapshotOf=root;}
        const id=await FalsifyLab.record('red',state.doc,state.request,state.response,state.response.provenance,extras);if(!live())return null;saved.set(k,id);lastSaved=id;return id;}
      catch(e){if(live())failure={key:k,message:e.message};return null;}
      finally{if(live()){pending.delete(k);controls();}}
    });
    pending.set(k,job);failure=null;controls();return job;
  }
  function action(id,copy,after,className){let b=$('#'+id);if(!b){b=document.createElement('button');b.type='button';b.id=id;b.className=className;b.textContent=copy;after.after(b);}return b;}
  function visibleNav(view){return [...document.querySelectorAll('[data-view='+view+']')].find(b=>b.getClientRects().length)||$('[data-view='+view+']');}
  function renderRecord(note=''){
    const status=$('#red-record-status');if(!status)return;const k=currentKey(),id=saved.get(k),base=saved.get(key(null));let text='',error=false;
    if(response){if(pending.size)text='실행 결과를 이 브라우저에 기록하는 중입니다.';
      else if(failure&&(failure.key===null||failure.key===k||failure.key===key(null)&&!base)){error=true;text=failure.key===null?failure.message:'기록되지 않음: '+failure.message+' 결과는 화면에 남아 있습니다. 「RED 실행 결과 기록」으로 다시 시도하세요.';}
      else if(id)text=note+'기록됨 · 기록 ID '+id.slice(0,8)+(k===key(null)?' · 응답 원본':' · 최종 선택·편집 After 포함')+(exported&&exported.key===k?' · 출력 파일 해시 포함':'')+'. 논문 추출문도 이 브라우저에 보관됩니다.';
      else if(base)text='응답 원본은 기록 ID '+base.slice(0,8)+'로 저장됨 · 현재 선택·편집은 아직 기록되지 않았습니다. 완성본 다운로드 또는 「RED 실행 결과 기록」으로 저장하세요.';
      else text='아직 기록되지 않았습니다.';}
    status.textContent=text;status.classList.toggle('error',error);
    action('red-evaluate','검수에서 이 기록 평가',status,'text-button').hidden=!lastSaved||!response;
  }
  function renderHandoff(){
    // No handoff while the final snapshot is still being saved; a failed save hands off with an explicitly unrecorded relation.
    const status=$('#red-export-status'),ready=!!exported&&!busy&&exported.key===currentKey()&&!pending.has(exported.key),b=action('red-handoff','이 사본으로 BLUE 실행',$('#red-preview')||status,'button secondary');b.hidden=!ready;
    let note=$('#red-handoff-note');if(!note){note=document.createElement('p');note.id='red-handoff-note';note.className='muted';b.after(note);}note.hidden=!ready;
    if(ready)note.textContent='BLUE에는 이 사본 파일만 전달합니다. 변경 계획·후보·근거는 보내지 않으며, BLUE 동의와 실행은 BLUE 화면에서 따로 합니다.'+(saved.has(exported.key)?'':' 최종 선택이 기록되지 않아 BLUE 결과와 이 RED 실행의 인계 관계는 기록되지 않습니다. 먼저 「RED 실행 결과 기록」으로 다시 시도할 수 있습니다.');
  }
  document.addEventListener('click',e=>{
    if(e.target.closest?.('#red-evaluate')){if(!lastSaved)return;const select=$('#evaluation-run');if(select&&[...select.options].some(o=>o.value===lastSaved)){select.value=lastSaved;select.dispatchEvent(new Event('change'));}visibleNav('review')?.click();}
    if(e.target.closest?.('#red-handoff')){if(!exported||exported.key!==currentKey()||busy||pending.has(exported.key))return;const sourceRunId=saved.get(exported.key)||null;
      // BLUE may cancel the handoff to keep its own running job or unrecorded result.
      if(!document.dispatchEvent(new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:exported.file,sourceRunId}}))){statusText('BLUE의 진행 중이거나 기록되지 않은 결과를 유지하려고 인계를 취소했습니다.');return;}visibleNav('blue')?.click();}
  });
  // Harness and CLI controls belong to the ledger; guard them in capture phase so a cancelled change never reaches the ledger handler.
  const GUARDED=['red-harness','red-cli-type','red-cli-model','red-cli-effort'];
  function snapshot(){for(const id of GUARDED){const e=$('#'+id);if(e)guard[id]=e.value;}}
  document.addEventListener('change',e=>{const id=e.target?.id;if(!GUARDED.includes(id))return;const field=e.target,previous=guard[id];if(previous!==undefined&&previous!==field.value&&(id!=='red-harness'||[...field.options].some(o=>o.value===previous))&&!keepEdits()){e.stopImmediatePropagation();field.value=previous;}},true);
  FalsifyLab.ready.then(()=>{snapshot();if(B.state().connected)controls();}).catch(()=>{});
  addEventListener('beforeunload',e=>{if(unrecorded()){e.preventDefault();e.returnValue='';}});
})();

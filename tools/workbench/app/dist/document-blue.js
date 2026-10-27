(function(){
  'use strict';const C=FalsifyDocumentBlue,B=FalsifyLocalBridge,$=s=>document.querySelector(s);
  let sourceFile=null, visualPicker=null;
  let generation=0,doc=null,result=null,findings=[],request=null,busy=false,job=null,jobLink=null,abort=null;
  const P=globalThis.FalsifyPendingJobs||null;let recovering=false;
  function shippedHelper(){try{const nodes=document.scripts?[...document.scripts]:[];return nodes.some(s=>{const src=String(s&&(typeof s.getAttribute==='function'?s.getAttribute('src'):s.src)||'');return src==='pending-job.js'||src.endsWith('/pending-job.js');});}catch{return false;}}
  function observedCalls(job){const n=job?.state==='completed'?job.result?.coverage?.calls:job?.progress?.completedCalls;return Number.isSafeInteger(n)&&n>=0?{observedCalls:n}:{};}
  function helperReady(){return !!(P&&typeof P.hold==='function'&&typeof P.note==='function'&&typeof P.read==='function'&&typeof P.matches==='function'&&typeof P.recover==='function');}
  function expectsHelper(){return !!(P||shippedHelper());}
  // relation is operator-only metadata (RED handoff run ID); it never enters the BLUE request packet.
  let relation=null,epoch=0,savedId=null,saving=false,failure=null,sticky=null,notice=false;
  let handoffMode=false,previousFailure=null,nextAction=null;
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  function msg(s,error=false,force=false){if((sticky||notice)&&!force)return;$('#doc-blue-progress').textContent=s;$('#doc-blue-progress').classList.toggle('error',error);}
  function reportCaught(e){if(sticky||notice)return;msg(e.message+' 자동 재시도하지 않습니다.',true);}
  function panelLatched(){const n=document.querySelector('#doc-blue-failure');return !!(n&&!n.hidden&&n.textContent);}
  function terminalKind(record){if(!record)return null;if(record.disposition==='failed')return 'failed';if(record.disposition==='cancelled')return 'cancelled';return null;}
  function clearSticky(){sticky=null;notice=false;for(const id of ['doc-blue-failure','doc-blue-pending-discard','doc-blue-failure-diagnostic','doc-blue-failure-request','doc-blue-receipt-check','doc-blue-recovery-details']){const node=document.querySelector('#'+id);if(!node)continue;if(id==='doc-blue-failure')node.textContent='';node.hidden=true;}}
  function ensurePanel(){let n=document.querySelector('#doc-blue-failure');if(!n){n=document.createElement('p');n.id='doc-blue-failure';n.className='form-feedback error';$('#doc-blue-progress').after(n);}return n;}
  function ensureButton(id,label,onClick){let b=document.querySelector('#'+id);if(!b){b=document.createElement('button');b.type='button';b.id=id;b.className='button secondary';$('#doc-blue-progress').after(b);}if(!b.__recoveryBound){b.type='button';b.className=b.className||'button secondary';b.addEventListener('click',onClick);b.__recoveryBound=true;}b.textContent=label;b.hidden=false;return b;}
  function saveJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // A BLUE job keeps the bridge link it started with for polls and cancel; the bridge refuses to switch while busy.
  function link(){const l=B.session();if(!l)throw new Error('로컬 broker 연결이 없습니다. 위 연결 패널에서 연결하거나 수동 JSON 교환을 쓰세요.');return l;}
  function controls(){handoffReadiness();visualPicker?.setBusy(busy);const active=!!doc&&!busy;B.busy('blue',busy);$('#doc-blue-start').disabled=!active||!B.capabilities()?.blue||!$('#doc-blue-consent').checked||!FalsifyLab.allowed('blue');$('#doc-blue-request').disabled=!active;$('#doc-blue-apply').disabled=!active;$('#doc-blue-cancel').hidden=!job;$('#doc-blue-budget').disabled=busy;$('#doc-blue-record').disabled=!active||!result||saving;FalsifyLab.busy('blue',busy||saving);renderRecord();document.dispatchEvent(new CustomEvent('falsify:blue-state',{detail:{name:doc?.name||'',busy,hasResult:!!result,file:sourceFile,handoff:handoffMode,phase:busy&&!doc?'import':'review'}}));}
  function cancel(){const old=job,l=jobLink;job=null;jobLink=null;if(old&&l)void l.request('/api/blue/jobs/'+encodeURIComponent(old)+'/cancel',{}).catch(()=>{});}
  function invalidate(){epoch++;savedId=null;saving=false;failure=null;result=null;findings=[];request=null;$('#doc-blue-findings').replaceChildren();$('#doc-blue-result-summary').textContent='';$('#doc-blue-record-status').textContent='';}
  function clear(keepFile=false,restore=true){if(restore){previousFailure=null;const previous=document.querySelector('#doc-blue-retry-previous');if(previous)previous.hidden=true;}handoffMode=false;visualPicker?.clear();generation++;cancel();abort?.abort();abort=null;doc=null;sourceFile=null;relation=null;busy=false;clearSticky();invalidate();if(keepFile!==true)$('#doc-blue-file').value='';$('#doc-blue-response').value='';$('#doc-blue-consent').checked=false;$('#blue-harness-consent').checked=false;if($('#blue-visual-select'))$('#blue-visual-select').checked=false;if($('#blue-visual-consent'))$('#blue-visual-consent').checked=false;if($('#blue-visual-regions'))$('#blue-visual-regions').value='';$('#doc-blue-summary').textContent='아직 파일을 입력하지 않았습니다. 수정 파일 또는 원본/대조군을 직접 선택하세요.';msg('');controls();if(restore)restorePending();}
  document.addEventListener('falsify:workspace-reset',clear);$('#doc-blue-clear').addEventListener('click',clear);
  // A user-chosen file is an independent BLUE input: clear() drops any RED relation.
  // Replacing the input asks first while a BLUE job runs or a result has not been recorded.
  function keepResult(){return !(job||result&&!savedId&&(failure||saving))||confirm('BLUE 검토가 진행 중이거나 결과가 아직 기록되지 않았습니다. 새 파일로 바꾸면 이 작업과 결과가 사라집니다. 계속할까요?');}
  function acceptInput(file,origin,keepFile=false,sourceRunId=null){
    const approved=$('#blue-harness-consent').checked;
    clear(keepFile,false);handoffMode=!!origin;relation=sourceRunId;
    // File consent belongs to this document; harness consent belongs to the unchanged selection.
    $('#blue-harness-consent').checked=approved;
    const current=generation;
    void (async()=>{
      if(helperReady()){
        const found=P.read('blue');
        if(found.status==='record'&&terminalKind(found.record)){
          const done=await P.discard('blue',{acknowledge:true,expectedRequestId:found.record.requestId});
          if(current!==generation)return;
          if(done.ok)previousFailure=found.record;
        }
      }
      if(current!==generation)return;
      await extract(file,origin);
      if(current===generation){restorePending();controls();}
    })().catch(e=>{if(current===generation)msg('파일 준비 실패: '+e.message,true);});
  }
  function revealControl(node){
    if(!node)return;
    for(let p=node.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;
    node.scrollIntoView?.({block:'center'});node.focus?.({preventScroll:true});
  }
  function handoffReadiness(){
    const panel=$('#doc-blue-handoff-ready'),label=$('#doc-blue-handoff-state'),button=$('#doc-blue-next');
    if(!panel||!label||!button)return;
    panel.hidden=!handoffMode;
    const previous=$('#doc-blue-previous-failure');if(previous)previous.hidden=!previousFailure;
    if(!handoffMode)return;
    let text='',action='다음';nextAction=null;
    const pending=helperReady()?P.read('blue'):null;
    if(busy){text=doc?'BLUE 검토 중입니다.':'RED 변경본을 읽고 있습니다.';}
    else if(!doc){text='변경본을 읽지 못했습니다. 파일을 다시 선택하세요.';action='파일 선택';nextAction=()=>$('#doc-blue-file').click();}
    else if(pending&&pending.status!=='absent'&&pending.status!=='record'){
      text='변경본이 준비됐습니다. 이전 요청 기록을 확인하세요.';action='이전 기록 확인';nextAction=()=>revealControl($('#doc-blue-pending-discard'));
    }
    else if(pending?.status==='record'&&pending.record.disposition!=='completed'){
      text='변경본이 준비됐습니다. 이전 BLUE 요청을 먼저 확인하세요.';
      const terminal=terminalKind(pending.record);action=terminal?'이전 요청 정리':'이전 요청 확인';
      nextAction=terminal?()=>void onDiscard():()=>{void recoverBlue();revealControl($('#doc-blue-pending-discard'));};
    }
    else if(!B.capabilities()?.blue){text='변경본이 준비됐습니다. 내 PC를 연결하세요.';action='내 PC 연결';nextAction=()=>revealControl(document.querySelector('.visual-connection-details summary')||$('#bridge-port'));}
    else if(!FalsifyLab.allowed('blue')){text='변경본이 준비됐습니다. 선택한 BLUE 하네스를 확인하세요.';action='하네스 확인';nextAction=()=>revealControl(!$('#blue-harness-consent').checked?$('#blue-harness-consent'):$('#blue-harness'));}
    else if(!$('#doc-blue-consent').checked){text='이 변경본을 선택한 BLUE 도구에 보내 검토합니다.';action='이 파일로 BLUE 검토 시작';nextAction=()=>{$('#doc-blue-consent').checked=true;$('#doc-blue-consent').dispatchEvent(new Event('change'));$('#doc-blue-start').click();};}
    else{text='변경본과 BLUE 도구가 준비됐습니다.';action='BLUE 검토 시작';nextAction=()=>$('#doc-blue-start').click();}
    if(label.textContent!==text)label.textContent=text;
    if(button.textContent!==action)button.textContent=action;
    button.disabled=!nextAction;button.hidden=busy;
  }
  $('#doc-blue-next')?.addEventListener('click',()=>nextAction?.());
  $('#doc-blue-previous-request')?.addEventListener('click',()=>{if(previousFailure){const body=P.safeRequest(previousFailure);if(body)saveJSON(body,'falsify-previous-blue-request.json');}});
  $('#doc-blue-previous-diagnostic')?.addEventListener('click',()=>{if(previousFailure)saveJSON(diagnosticFor(previousFailure),'falsify-previous-blue-diagnostic.json');});
  $('#doc-blue-file').addEventListener('change',()=>{const file=$('#doc-blue-file').files[0];if(file&&!keepResult()){$('#doc-blue-file').value='';msg('새 파일 입력을 취소했습니다. 기존 BLUE 작업과 결과를 유지합니다.');return;}if(file)acceptInput(file,null,true);else clear(true);});
  // The RED handoff event is cancelable; RED stays on its view when BLUE keeps its current work.
  document.addEventListener('falsify:blue-file',e=>{const {file,sourceRunId}=e.detail||{};if(!(file instanceof File))return;if(!keepResult()){e.preventDefault();return;}const linked=typeof sourceRunId==='string'&&!!sourceRunId;acceptInput(file,'RED 변경본 · ',false,linked?sourceRunId:null);});
  async function extract(file,origin){const current=generation;sourceFile=file;abort=new AbortController();busy=true;controls();msg('BLUE 파일의 텍스트를 로컬 추출 중');
    try{const imported=await FalsifyImport.extract(file,{signal:abort.signal,onProgress:s=>{if(current===generation)msg(typeof s==='string'?s:'BLUE 텍스트 추출 중');}});const sourceHash=await hash(new TextEncoder().encode(imported.text)),fileHash=await hash(await file.arrayBuffer());if(current!==generation)return;
      sourceFile=file;
      doc={revision:crypto.randomUUID(),sourceHash,fileHash,name:file.name.slice(0,160),format:String(imported.format).slice(0,40),segments:imported.segments.map((s,i)=>({id:'s'+i,label:s.label,text:s.text}))};$('#doc-blue-summary').textContent=(origin||'')+file.name+' · '+doc.segments.length+'개 페이지/문단 · '+imported.text.length.toLocaleString()+'자';msg('추출 완료. '+(imported.warnings||[]).join(' '));
    }catch(e){if(current===generation)msg('파일 입력 실패: '+e.message,true);}finally{if(current===generation){busy=false;abort=null;controls();if(handoffMode)$('#doc-blue-next')?.focus?.({preventScroll:true});}}}
  async function makeRequest(){
    const frozen=doc, current=generation, visualFile=sourceFile, visualEnabled=!!$('#blue-visual-select')?.checked, visualConsented=!!$('#blue-visual-consent')?.checked, selections=visualEnabled?visualPicker?.selection():null;
    const body=await FalsifyLab.bind('blue',C.request(frozen,Number($('#doc-blue-budget').value)));
    if(current!==generation||doc!==frozen||sourceFile!==visualFile)throw new Error('입력이 바뀌어 요청을 보내지 않았습니다.');
    if(visualEnabled){
      if(!visualConsented)throw new Error('시각 이미지 전송 동의가 필요합니다.');
      if(!visualFile||!globalThis.FalsifyBlueVisual)throw new Error('선택한 PDF 또는 시각 렌더러가 없습니다.');
      if(!selections?.length)throw new Error('미리보기에서 이 쪽 또는 영역을 선택하세요.');
      body.visualEvidence=await FalsifyBlueVisual.renderBlueVisuals({file:visualFile,fileHash:frozen.fileHash,sourceHash:frozen.sourceHash,selections});
      if(current!==generation||doc!==frozen||sourceFile!==visualFile)throw new Error('입력 문서가 바뀌어 시각 증거를 보내지 않았습니다.');
      body.fileHash=frozen.fileHash;body.visualConsent=true;
      if(new TextEncoder().encode(JSON.stringify(body)).length>4000000)throw new Error('요청 크기 상한을 넘었습니다.');
    }
    return body;
  }
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
  function apply(res,provenance){const validated=C.validateResponse(doc,res,request);const list=$('#doc-blue-findings'),bound=request;invalidate();request=bound;findings=validated;result={...res,provenance};list.replaceChildren();
    for(const f of findings){const section=document.createElement('section');section.className='red-proposal';const title=document.createElement('h3');title.textContent=f.id+' · '+f.label;const quote=document.createElement('blockquote');quote.textContent=f.quote;const reason=document.createElement('p');reason.textContent=f.rationale;section.append(title,quote,reason);for(const e of f.evidence){const loc=document.createElement('p');loc.textContent=e.label+' — '+e.relation;const q=document.createElement('blockquote');q.textContent=e.quote;section.append(loc,q);}const uncertainty=document.createElement('p');uncertainty.className='muted';uncertainty.textContent='한계: '+f.uncertainty;section.append(uncertainty);list.append(section);}
    for(const o of res.visualObservations||[]){const section=document.createElement('section');section.className='red-proposal';const title=document.createElement('h3');title.textContent='시각 관찰 · '+o.id+' · '+o.page+'쪽';const detail=document.createElement('p');detail.textContent=o.observation;const limit=document.createElement('p');limit.className='muted';limit.textContent='한계: '+o.uncertainty+' · 이미지 해시 '+o.sha256;section.append(title,detail,limit);list.append(section);}
    if(res.visualObservations){const note=document.createElement('p');note.className='muted';note.textContent='이미지 바이트와 해시는 검증됨. PDF·텍스트와의 연결은 브라우저가 선언하며 시각 판단의 정확성은 검증되지 않았습니다.';list.append(note);}
    $('#doc-blue-result-summary').textContent=(provenance==='local-codex'?'로컬 broker 실행 · '+res.model:'수동 응답 · 실행 출처 미검증')+' · 상태 '+res.status+' · 지적 '+findings.length+'개 · 사람 평가는 검수 메뉴에서';
    // Every status branch states delivery coverage and reread, so an abstain or refusal never hides an incomplete review.
    const scope=provenance==='local-codex'?'앱 adapter 호출 '+(res.coverage?.calls||'?')+'회. '+(res.coverage?.complete?'전체 추출 텍스트 전달 완료(탐지 보장 아님).':'전달 미완료.'):'수동 응답의 실행·전달 여부 미검증.';
    msg((res.status==='refusal'?'BLUE 요청 거절. 우회·자동 재시도하지 않습니다.':res.status==='abstain'?'BLUE 판단 유보. 탐지 실패로 변환하지 않습니다.':findings.length+'개 지적 · 입력 인용 일치 확인.')+' '+scope+reread(res,provenance));controls();void saveRecord();}
  if(globalThis.FalsifyBlueVisual){
    const box=document.createElement('div');box.className='mode-note blue-picker';
    const create=(tag,id,text,parent=box)=>{const el=document.createElement(tag);if(id)el.id='blue-'+id;if(text)el.textContent=text;parent.append(el);return el;};
    const selectLabel=create('label'),selectInput=create('input','visual-select','',selectLabel);selectInput.type='checkbox';selectLabel.append(document.createTextNode(' ▣ PDF 시각 증거 사용'));
    const pickerNode=create('div','picker');pickerNode.hidden=true;create('p',null,'쪽을 고르고 전체 쪽을 사용하거나 미리보기에서 영역을 드래그하세요.',pickerNode);
    const nav=create('div',null,'',pickerNode);nav.className='blue-picker-nav';for(const [id,text] of [['visual-prev','← 이전'],['visual-page',''],['visual-next','다음 →'],['visual-whole','▣ 이 쪽 사용']]){const el=create(id==='visual-page'?'span':'button',id,text,nav);if(el.tagName==='BUTTON')el.type='button';if(id==='visual-page')el.setAttribute('aria-live','polite');}
    create('div','visual-stage','',pickerNode).className='blue-picker-stage';create('p','visual-status','',pickerNode).setAttribute('aria-live','polite');
    const consentLabel=create('label'),consentInput=create('input','visual-consent','',consentLabel);consentInput.type='checkbox';consentLabel.append(document.createTextNode(' 선택한 이미지와 추출 텍스트를 모델에 전송하는 데 동의합니다.'));
    create('p',null,'이미지는 이 브라우저의 대기 기록에도 저장됩니다. 원본 PDF는 저장하지 않습니다.').className='muted';
    $('#doc-blue-consent').closest('label').after(box);
    const q=id=>box.querySelector('#blue-'+id), select=q('visual-select'),consent=q('visual-consent'),picker=q('picker'),stage=q('visual-stage'),status=q('visual-status'),pageLabel=q('visual-page'),prev=q('visual-prev'),next=q('visual-next'),whole=q('visual-whole');
    let serial=0,view=null,chosen=null,drag=null,overlay=null;
    function changed(){generation++;if(doc)doc.revision=crypto.randomUUID();invalidate();controls();}
    function clearPicker(){serial++;view=null;chosen=null;drag=null;stage.replaceChildren();status.textContent='';pageLabel.textContent='';picker.hidden=true;}
    function paint(b){if(!overlay||!view)return;overlay.hidden=!b;if(b){overlay.style.left=(100*b[0]/view.width)+'%';overlay.style.top=(100*b[1]/view.height)+'%';overlay.style.width=(100*b[2]/view.width)+'%';overlay.style.height=(100*b[3]/view.height)+'%';}}
    function choose(b){chosen={page:view.page,bbox:b};paint(b);status.textContent=view.page+'쪽 · '+(b[0]===0&&b[1]===0&&b[2]===view.width&&b[3]===view.height?'전체 쪽':'선택 영역')+' 선택됨';changed();}
    async function draw(n){const mine=++serial,file=sourceFile,current=doc;view=null;chosen=null;stage.replaceChildren();status.textContent='미리보기를 준비 중입니다.';prev.disabled=next.disabled=whole.disabled=true;changed();
      try{const v=await FalsifyBlueVisual.previewBluePage({file,fileHash:current.fileHash,page:n});if(mine!==serial||file!==sourceFile||current!==doc)return;view=v;const frame=document.createElement('div');frame.className='blue-picker-frame';overlay=document.createElement('div');overlay.className='blue-picker-selection';overlay.hidden=true;frame.append(v.canvas,overlay);stage.append(frame);pageLabel.textContent=v.page+' / '+v.pages+'쪽';prev.disabled=v.page<=1;next.disabled=v.page>=v.pages;whole.disabled=!v.wholeFits;if(v.wholeFits)choose([0,0,v.width,v.height]);else status.textContent='전체 쪽이 크기 제한을 넘어갑니다. 미리보기에서 영역을 드래그하세요.';
      }catch(e){if(mine===serial)status.textContent='PDF 미리보기를 열지 못했습니다. PDF 파일을 확인하세요.';}}
    select.addEventListener('change',()=>{clearPicker();changed();if(select.checked){picker.hidden=false;if(doc&&sourceFile)void draw(1);else status.textContent='먼저 PDF를 선택하세요.';}});
    prev.addEventListener('click',()=>{if(view&&view.page>1)void draw(view.page-1);});next.addEventListener('click',()=>{if(view&&view.page<view.pages)void draw(view.page+1);});whole.addEventListener('click',()=>{if(view?.wholeFits)choose([0,0,view.width,view.height]);});
    function point(e){const r=view.canvas.getBoundingClientRect();if(!r.width||!r.height)return null;return {x:Math.max(0,Math.min(view.width,(e.clientX-r.left)/r.width*view.width)),y:Math.max(0,Math.min(view.height,(e.clientY-r.top)/r.height*view.height))};}
    function rectangle(a,b){return [Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(a.x-b.x),Math.abs(a.y-b.y)];}
    stage.addEventListener('pointerdown',e=>{if(busy||!view||e.target!==view.canvas||e.button!==0)return;const p=point(e);if(!p)return;drag={...p,id:e.pointerId};chosen=null;paint(null);changed();stage.setPointerCapture(e.pointerId);});
    stage.addEventListener('pointermove',e=>{if(!view||!drag||e.pointerId!==drag.id)return;const p=point(e);if(p)paint(rectangle(drag,p));});
    stage.addEventListener('pointerup',e=>{if(!view||!drag||e.pointerId!==drag.id)return;const p=point(e),b=p&&rectangle(drag,p);drag=null;if(b&&b[2]>=1&&b[3]>=1)choose(b);else {paint(null);status.textContent='영역을 다시 드래그하세요.';}});
    stage.addEventListener('pointercancel',()=>{drag=null;paint(null);});
    consent.addEventListener('change',changed);visualPicker={clear:clearPicker,setBusy:value=>{select.disabled=consent.disabled=value;prev.disabled=value||!view||view.page<=1;next.disabled=value||!view||view.page>=view.pages;whole.disabled=value||!view||!view.wholeFits;},selection:()=>chosen?[{page:chosen.page,bbox:[...chosen.bbox]}]:[]};
  }
  $('#doc-blue-consent').addEventListener('change',controls);document.addEventListener('falsify:harness-consent',controls);
  document.addEventListener('falsify:harness-change',e=>{if(e.detail.role!=='blue')return;generation++;if(doc)doc.revision=crypto.randomUUID();invalidate();controls();msg('harness 변경: 이전 응답 무효화. 저장한 실행 기록은 보존됩니다.');});
  $('#doc-blue-budget').addEventListener('change',()=>{generation++;if(doc)doc.revision=crypto.randomUUID();invalidate();controls();msg('예산 변경: 이전 응답을 무효화했습니다.');});
  $('#doc-blue-request').addEventListener('click',async()=>{if(!doc||busy)return;const current=generation;try{const next=result&&request?request:await makeRequest();if(current!==generation)return;request=next;saveJSON(request,'falsify-document-blue-request.json');msg('논문과 BLUE harness 요청 저장. 모델은 호출하지 않았습니다. RED 계획·검수 기록은 포함하지 않습니다.');}catch(e){if(current===generation)msg(e.message,true);}});
  $('#doc-blue-apply').addEventListener('click',async()=>{if(!doc||busy)return;const current=generation;try{const raw=$('#doc-blue-response').value;if(raw.length>150000)throw new Error('응답 길이 제한 초과');const next=request||await makeRequest();if(current!==generation)return;request=next;apply(JSON.parse(raw),'manual-unverified');}catch(e){if(current===generation)msg('응답 적용 차단: '+e.message,true);}});
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
    // Verify the authenticated live instance before sending. A connect click in
    // another tab used to restart an idle server underneath this cached link.
    try{
      const live=await l.request('/api/capabilities');
      if(live.companionInstance!==held.record.companionInstance)throw new Error('로컬 서버가 바뀌어 요청을 보내지 않았습니다. 내 PC를 다시 연결하세요.');
    }catch(err){
      const detail=P.safeFailure('요청 전 연결 확인 실패. '+err.message);
      await P.note(held.record,{postReceipt:'rejected',disposition:'failed',serverFailure:detail,finishedAt:Date.now()});
      const saved=P.read('blue');if(saved.status==='record')rememberTerminal(saved.record);throw err;
    }
    let started;try{started=await l.request('/api/blue/jobs',request);}catch(err){
      if([400,401,403,409,413,422,429].includes(err.httpStatus)){
        const detail=P.safeFailure('요청 접수 거부 (HTTP '+err.httpStatus+'). '+err.message);
        await P.note(held.record,{postReceipt:'rejected',disposition:'failed',serverFailure:detail,finishedAt:Date.now()});
        const saved=P.read('blue');if(saved.status==='record')rememberTerminal(saved.record);throw err;
      }
      await P.note(held.record,{postReceipt:'unknown',disposition:'unknown',finishedAt:Date.now()});
      // A lost POST response is not a failed job. Reconcile once with GET only;
      // exact id, instance, harness and wire digest must all match.
      const outcome=await P.recover({...recoverOptions(),getJob:async id=>{
        try{return {httpStatus:200,body:await l.request('/api/blue/jobs/'+encodeURIComponent(id))};}
        catch{return {httpStatus:0,body:null};}
      }});
      if(['still-running','completed','failed','cancelled'].includes(outcome.status)){
        await P.note(held.record,{postReceipt:'accepted'});clearSticky();return {id:request.requestId,state:outcome.job.state};
      }
      const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);throw err;
    }
    if(!started||started.id!==request.requestId){await P.note(held.record,{postReceipt:'unknown',disposition:'unknown',finishedAt:Date.now()});const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);throw new Error('서버가 저장한 요청 ID와 다른 작업을 돌려줘 그 작업을 이어받지 않았습니다.');}
    await P.note(held.record,{postReceipt:'accepted'});return started;
  }
  async function persistWatch(record,data){
    const kind=data.state==='failed'?'failed':'cancelled';
    const patch={disposition:kind,finishedAt:Date.now(),...observedCalls(data)};
    if(kind==='failed'){const detail=P.safeFailure(data.error);if(detail)patch.serverFailure=detail;const f=P.structuredFailure(data.failure);if(f)patch.adapterFailure=f;}
    await P.note(record,patch);
  }
  async function watchBlue(current,l,strict){
    while(current===generation&&job){
      const data=await l.request('/api/blue/jobs/'+encodeURIComponent(job));if(current!==generation||!job)return;
      let matched=null;
      if(strict){const found=P.read('blue');if(found.status!=='record'||found.record.requestId!==job||!P.matches(found.record,data))throw new Error('조회한 작업의 식별이 저장한 요청과 달라 적용하지 않았습니다.');matched=found.record;}
      if(data.state==='completed'){clearSticky();apply(data.result,'local-codex');if(strict){const found={status:'record',record:matched};if(found.status==='record')await P.note(found.record,{disposition:'completed',finishedAt:Date.now(),...observedCalls(data)});}break;}
      if(data.state==='failed'||data.state==='cancelled'){
        if(!strict)throw new Error(typeof data.error==='string'?data.error.slice(0,300):'BLUE 취소됨');
        const found={status:'record',record:matched};if(found.status==='record')await persistWatch(found.record,data);
        const saved=P.read('blue');if(saved.status==='record'&&saved.record.requestId===matched.requestId)rememberTerminal(saved.record);return;
      }
      if(strict&&data.state!=='running'){
        const found={status:'record',record:matched};
        if(found.status==='record'){await P.note(found.record,{disposition:'unknown',finishedAt:Date.now()});const saved=P.read('blue');if(saved.status==='record')showUnknown(saved.record);}
        return;
      }
      if(strict){const found={status:'record',record:matched};if(found.status==='record'&&found.record.disposition!=='running')await P.note(found.record,{disposition:'running'});}
      msg('BLUE 검토 중 · '+(data.progress&&data.progress.completedCalls||0)+' / '+(data.progress&&data.progress.requiredCalls||'?')+'회 완료'+phase(data.progress&&data.progress.phase));await new Promise(r=>setTimeout(r,1500));
    }
  }
  let displayedPending=null;
  async function onDiscard(){
    const found=helperReady()?P.read('blue'):null;
    const detail=found&&found.status==='record'&&found.record.disposition==='failed'&&typeof found.record.serverFailure==='string'?found.record.serverFailure:'';
    generation++;cancel();
    const done=await P.discard('blue',{acknowledge:true,...displayedPending});
    if(!done.ok){msg((detail?detail+' ':'')+(done.message||'대기 기록을 지우지 못했습니다.'),true,true);return;}
    clearSticky();busy=false;job=null;jobLink=null;
    msg(P.text({status:'discarded'})+' 다시 시작하려면 BLUE 독립 검토 시작을 직접 누르세요.',false,true);controls();
  }
  function exportDiagnostic(){
    const found=P.read('blue');if(!found||found.status!=='record')return;
    saveJSON(diagnosticFor(found.record),'falsify-blue-failure-diagnostic.json');
  }
  function attemptIdentity(r){const h=r?.request?.harness;return '실패한 시도 harness: '+(h?.name||'이름 없음')+' · 버전 '+(h?.version||'없음')+' · SHA-256 '+(r?.harnessHash||'없음')+'.';}
  function diagnosticFor(r){return {schema:'falsify.blue-failure-diagnostic.v1',role:r.role,requestId:r.requestId,disposition:r.disposition,postReceipt:r.postReceipt,sourceHash:r.sourceHash,fileHash:r.fileHash,revision:r.revision,harnessHash:r.harnessHash,harnessName:r.request?.harness?.name||null,harnessVersion:r.request?.harness?.version||null,requestBytesDigest:r.requestBytesDigest,requestFingerprint:r.requestFingerprint,companionInstance:r.companionInstance,serverFailure:typeof r.serverFailure==='string'?r.serverFailure:null,adapterFailure:P.structuredFailure(r.adapterFailure)};}
  function exportStoredRequest(){
    const found=P.read('blue');if(!found||found.status!=='record')return;
    const body=P.safeRequest(found.record);if(!body){msg('원래 요청을 저장하지 못했습니다. 실행하지 않았습니다.',true,true);return;}
    saveJSON(body,'falsify-document-blue-request.json');
  }
  function retainPrevious(r){previousFailure=r;let details=document.querySelector('#doc-blue-retry-previous');if(!details){details=document.createElement('details');details.id='doc-blue-retry-previous';const summary=document.createElement('summary');summary.textContent='이전 실패 요청과 진단 정보';const diag=document.createElement('button'),req=document.createElement('button');diag.type=req.type='button';diag.className=req.className='button secondary';diag.textContent='진단 정보 저장';req.textContent='원래 요청 저장';diag.addEventListener('click',()=>{if(previousFailure)saveJSON(diagnosticFor(previousFailure),'falsify-previous-blue-diagnostic.json');});req.addEventListener('click',()=>{const body=previousFailure&&P.safeRequest(previousFailure);if(body)saveJSON(body,'falsify-previous-blue-request.json');});details.append(summary,diag,req);$('#doc-blue-progress').after(details);}details.hidden=false;}
  function showRecoveryActions(){ensureButton('doc-blue-pending-discard','이 대기 작업 버리기',onDiscard);const d=ensureButton('doc-blue-failure-diagnostic','진단 정보 저장',exportDiagnostic),r=ensureButton('doc-blue-failure-request','원래 요청 저장',exportStoredRequest);let details=document.querySelector('#doc-blue-recovery-details');if(!details){details=document.createElement('details');details.id='doc-blue-recovery-details';const summary=document.createElement('summary');summary.textContent='요청과 진단 정보';details.append(summary);$('#doc-blue-progress').after(details);}details.append(d,r);details.hidden=false;ensureButton('doc-blue-receipt-check','접수 상태 다시 확인',()=>void recoverBlue());}
  function rememberTerminal(record,opts={}){
    displayedPending={expectedRequestId:record.requestId};
    const kind=terminalKind(record);if(!kind)return;
    if(!doc&&record.request)adoptBlue(P.docFrom(record));
    request=record.request;sticky=kind;notice=false;
    const detail=kind==='failed'?P.failureText(record):'';
    const head=kind==='failed'?(record.postReceipt==='rejected'?'BLUE 요청이 거부됐습니다.':'BLUE 실패.'):'BLUE 취소.';
    const foreign=opts.foreign?' 이번 조회는 저장된 요청·인스턴스·해시와 달라 서버 문구를 바꾸지 않았습니다.':'';
    msg(head+(detail?' '+detail:'')+(kind==='failed'?' '+attemptIdentity(record):'')+foreign+' BLUE 독립 검토 시작을 누르면 새 요청을 보냅니다.',true,true);
    const box=ensurePanel();box.textContent=detail+foreign;box.hidden=true;
    showRecoveryActions();
  }
  function showUnknown(record,reason=''){
    if(sticky)return;
    displayedPending=record?{expectedRequestId:record.requestId}:null;
    if(record&&record.request)request=record.request;
    notice=true;
    const text='BLUE 접수 상태를 확인하지 못했습니다. '+(reason||'접수 상태를 다시 확인하세요.');
    msg(text,true,true);
    const box=ensurePanel();box.textContent='BLUE 상태 미확인. '+reason;box.hidden=true;
    showRecoveryActions();
  }
  function showPendingBlue(outcome){
    if(sticky||notice||panelLatched())return;
    displayedPending=outcome?.record?{expectedRequestId:outcome.record.requestId}:{expectedStatus:outcome?.status};
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
    clearSticky();adoptBlue(outcome.doc);request=outcome.record.request;
    if(outcome.record.postReceipt!=='accepted')await P.note(outcome.record,{postReceipt:'accepted'});
    const current=generation;busy=true;job=outcome.record.requestId;jobLink=l;controls();msg(P.text(outcome));
    try{await watchBlue(current,l,true);}catch(e){if(current===generation)reportCaught(e);}
    finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
  }
  function showRecoveredBlue(outcome){clearSticky();adoptBlue(outcome.doc);request=outcome.record.request;apply(outcome.result,'local-codex');msg(P.text(outcome),false,true);}
  function recoverOptions(){return {role:'blue',companionInstance:B.capabilities()?.companionInstance||null,hashHarness:h=>FalsifyHarness.hash(h),validate:(d,res)=>C.validateResponse(d,res,P.read('blue')?.record?.request),getJob:probeBlue,currentDoc:doc||undefined};}
  async function absorbTerminal(record,outcome){
    const mismatch=outcome&&['request-mismatch','hash-mismatch','role-mismatch','server-restarted','instance-unverified'].includes(outcome.status);
    if(mismatch){rememberTerminal(record,{foreign:true});return;}
    if(outcome&&record.disposition==='failed'&&outcome.status==='failed'){
      const detail=P.safeFailure(outcome.error);if(detail||outcome.failure)await P.note(record,{...(detail?{serverFailure:detail}:{}),...(outcome.failure?{adapterFailure:outcome.failure}:{})});
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
      if(outcome.status==='server-restarted'){showUnknown(record,'저장된 요청 이후 로컬 서버가 재시작되어 현재 서버에서는 이전 접수를 확인할 수 없습니다.');return;}
      if(outcome.status==='still-running'){await resumeBlue(outcome);return;}
      if(outcome.status==='completed'){showRecoveredBlue(outcome);await P.note(outcome.record,{disposition:'completed',finishedAt:Date.now(),...observedCalls(outcome.job)});return;}
      if((outcome.status==='failed'||outcome.status==='cancelled')&&outcome.record){
        const patch={postReceipt:'accepted',disposition:outcome.status,finishedAt:Date.now()};
        if(outcome.status==='failed'){const detail=P.safeFailure(outcome.error);if(detail)patch.serverFailure=detail;if(outcome.failure)patch.adapterFailure=outcome.failure;}
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
      if(pending.status==='record'&&terminalKind(pending.record)&&pending.record.postReceipt!=='unknown'){if(!B.state().connected||!B.session()){rememberTerminal(pending.record);return;}busy=true;controls();const removed=await P.discard('blue',{acknowledge:true,expectedRequestId:pending.record.requestId});if(!removed.ok||current!==generation){busy=false;if(!removed.ok)msg(removed.message,true,true);controls();return;}retainPrevious(pending.record);clearSticky();}
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

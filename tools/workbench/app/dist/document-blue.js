(function(){
  'use strict';const C=FalsifyDocumentBlue,B=FalsifyLocalBridge,$=s=>document.querySelector(s);
  let generation=0,doc=null,result=null,findings=[],request=null,busy=false,job=null,jobLink=null,abort=null;
  // relation is operator-only metadata (RED handoff run ID); it never enters the BLUE request packet.
  let relation=null,epoch=0,savedId=null,saving=false,failure=null;
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  function msg(s,error=false){$('#doc-blue-progress').textContent=s;$('#doc-blue-progress').classList.toggle('error',error);}
  function saveJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // A BLUE job keeps the bridge link it started with for polls and cancel; the bridge refuses to switch while busy.
  function link(){const l=B.session();if(!l)throw new Error('로컬 broker 연결이 없습니다. 위 연결 패널에서 연결하거나 수동 JSON 교환을 쓰세요.');return l;}
  function controls(){const active=!!doc&&!busy;B.busy('blue',busy);$('#doc-blue-start').disabled=!active||!B.capabilities()?.blue||!$('#doc-blue-consent').checked||!FalsifyLab.allowed('blue');$('#doc-blue-request').disabled=!active;$('#doc-blue-apply').disabled=!active;$('#doc-blue-cancel').hidden=!job;$('#doc-blue-budget').disabled=busy;$('#doc-blue-record').disabled=!active||!result||saving;FalsifyLab.busy('blue',busy||saving);renderRecord();}
  function cancel(){const old=job,l=jobLink;job=null;jobLink=null;if(old&&l)void l.request('/api/blue/jobs/'+encodeURIComponent(old)+'/cancel',{}).catch(()=>{});}
  function invalidate(){epoch++;savedId=null;saving=false;failure=null;result=null;findings=[];request=null;$('#doc-blue-findings').replaceChildren();$('#doc-blue-result-summary').textContent='';$('#doc-blue-record-status').textContent='';}
  function clear(keepFile=false){generation++;cancel();abort?.abort();abort=null;doc=null;relation=null;busy=false;invalidate();if(keepFile!==true)$('#doc-blue-file').value='';$('#doc-blue-response').value='';$('#doc-blue-consent').checked=false;$('#blue-harness-consent').checked=false;$('#doc-blue-summary').textContent='아직 파일을 입력하지 않았습니다. 수정 파일 또는 원본/대조군을 직접 선택하세요.';msg('');controls();}
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
  $('#doc-blue-start').addEventListener('click',async()=>{if(!doc||busy||!$('#doc-blue-consent').checked||!FalsifyLab.allowed('blue'))return;const current=generation;busy=true;invalidate();controls();
    try{const l=link();request=await makeRequest();if(current!==generation)return;msg('전체 텍스트 호출 예산 확인 후 선택 BLUE harness를 실행합니다.');const started=await l.request('/api/blue/jobs',request);if(current!==generation){void l.request('/api/blue/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}job=started.id;jobLink=l;controls();
      while(current===generation&&job){const data=await l.request('/api/blue/jobs/'+encodeURIComponent(job));if(current!==generation||!job)return;if(data.state==='completed'){apply(data.result,'local-codex');break;}if(['failed','cancelled'].includes(data.state))throw new Error(data.error||'BLUE 취소됨');msg('BLUE 검토 중 · '+(data.progress.completedCalls||0)+' / '+(data.progress.requiredCalls||'?')+'회 완료'+phase(data.progress.phase));await new Promise(r=>setTimeout(r,1500));}
    }catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않습니다.',true);}finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}});
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
  document.addEventListener('falsify:local-bridge',()=>{connection();controls();});connection();controls();
})();

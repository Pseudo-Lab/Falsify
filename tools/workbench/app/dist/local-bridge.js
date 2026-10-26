/* Shared local broker link: same-origin session on the companion itself, or explicit token pairing from the hosted page. */
(function(root){
  'use strict';
  const HOST='127.0.0.1',DEFAULT_PORT=7816,WEB_ORIGIN='https://shinick-han.github.io';
  const PATH=/^\/api\/(?:capabilities|export|paper\/(?:inspect|images(?:\/export)?)|harness\/profile\/propose|(?:red|blue)\/jobs(?:\/[A-Za-z0-9%._~-]+(?:\/cancel)?)?)$/;
  // Strict decimal port only; host and scheme are never user input.
  function parsePort(value){const s=String(value??'').trim();if(s==='')return DEFAULT_PORT;if(!/^[1-9][0-9]{3,4}$/.test(s))return null;const n=Number(s);return n>=1024&&n<=65535?n:null;}
  function validToken(t){return typeof t==='string'&&t.length>=16&&t.length<=512&&/^[A-Za-z0-9._~+/-]+=*$/.test(t);}
  function platformKind(platform){const p=String(platform||'').toLowerCase();if(p.includes('win'))return 'windows';if(p.includes('mac'))return 'mac';if(p.includes('linux')||p.includes('x11')||p.includes('cros'))return 'linux';return 'other';}
  function command(port,kind){const extra=port&&port!==DEFAULT_PORT?' --port '+port:'';if(kind==='mac'||kind==='linux')return 'python3 -m venv .venv && .venv/bin/python -m pip install -r app/local/requirements.txt && .venv/bin/python app/local/server.py --web-origin '+WEB_ORIGIN+extra;return 'python app/local/server.py --web-origin '+WEB_ORIGIN+extra;}
  function launcher(port,kind){if(kind==='mac'||kind==='linux')return './open-connection.sh';return 'powershell -NoProfile -ExecutionPolicy Bypass -File ./start-companion.ps1'+(port&&port!==DEFAULT_PORT?' -Port '+port:'');}
  const INSTALL='powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-connection.ps1';
  function installCommand(kind){return kind==='mac'||kind==='linux'?'./install-connection.sh':INSTALL;}
  // The only URI this page opens: fixed scheme, host and path plus a strict port. Never a token, model, origin or command.
  function launchUri(value){const p=typeof value==='number'?(Number.isInteger(value)&&value>=1024&&value<=65535?value:null):parsePort(value);return p===null?null:'falsify://connect?port='+p;}
  const MODEL=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/,EFFORTS=['low','medium','high'];
  // Optional CLI catalogue from a newer broker. Suggestions only, not proof of account access; unknown or malformed entries are dropped.
  function agents(list){if(!Array.isArray(list))return null;const out=[];
    for(const a of list.slice(0,8)){if(!a||typeof a!=='object'||!['codex','claude'].includes(a.id)||out.some(x=>x.id===a.id))continue;
      out.push(Object.freeze({id:a.id,name:typeof a.name==='string'&&a.name.trim()?a.name.slice(0,60):a.id,installed:typeof a.installed==='boolean'?a.installed:null,defaultModel:typeof a.defaultModel==='string'&&MODEL.test(a.defaultModel)?a.defaultModel:null,
        models:Object.freeze((Array.isArray(a.models)?a.models:[]).filter(m=>typeof m==='string'&&MODEL.test(m)).slice(0,40)),efforts:Object.freeze((Array.isArray(a.efforts)?a.efforts:EFFORTS).filter(e=>EFFORTS.includes(e)))}));}
    return Object.freeze(out);}
  // Public per-process companion identity. Not the launcher restart secret and not a pairing secret.
  function companionInstance(v){return typeof v==='string'&&/^ci1\.[0-9a-f]{64}$/.test(v)?v:null;}
  function capSnapshot(d){if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.red!=='boolean'||typeof d.blue!=='boolean')return null;
    return Object.freeze({red:d.red,blue:d.blue,pdf:d.pdf===true,officeLayoutVerifiedExport:d.officeLayoutVerifiedExport===true,model:typeof d.model==='string'?d.model.slice(0,80):null,isolation:typeof d.isolation==='string'?d.isolation.slice(0,200):null,
      cliSelection:d.cliSelection===true,harnessWrapper:d.harnessWrapper===true,cliAgents:d.cliSelection===true?agents(d.cliAgents):null,pdfEditor:pdfEditor(d.pdfEditor),paperAnalysis:paperAnalysis(d.paperAnalysis),imageEditor:imageEditor(d.imageEditor),harnessProfileProposal:profileProposal(d.harnessProfileProposal),workbenchVersion:workbenchVersion(d.workbenchVersion),companionInstance:companionInstance(d.companionInstance)});}
  // Optional advisory PDF pre-analysis from a newer broker: exact descriptor or none. An older broker without it keeps every other path.
  const ANALYSIS_SCHEMA='falsify.pdf-analysis-summary.v1',WORKBENCH_VERSION=/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z]{1,16}(?:\.[0-9A-Za-z]{1,16}){0,3})?$/;
  function paperAnalysis(d){if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length!==2||typeof d.available!=='boolean'||d.schema!==ANALYSIS_SCHEMA)return null;return Object.freeze({available:d.available,schema:ANALYSIS_SCHEMA});}
  // Optional single-occurrence image replacement from a newer broker: exact descriptor or none, like pre-analysis.
  const IMAGE_SCHEMA='falsify.image-list.v1';
  function imageEditor(d){if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length!==2||typeof d.available!=='boolean'||d.schema!==IMAGE_SCHEMA)return null;return Object.freeze({available:d.available,schema:IMAGE_SCHEMA});}
  // Optional AI connection-profile drafting from a newer broker: exact descriptor or none, like pre-analysis.
  const PROFILE_SCHEMA='falsify.harness-profile-proposal.v1';
  // providers lists the CLIs the companion drafts with (Claude only today); unknown names drop the whole descriptor.
  function profileProposal(d){if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).length!==3||typeof d.available!=='boolean'||d.schema!==PROFILE_SCHEMA)return null;
    const p=d.providers;if(!Array.isArray(p)||!p.length||p.length>2||new Set(p).size!==p.length||!p.every(v=>v==='claude'||v==='codex'))return null;
    return Object.freeze({available:d.available,schema:PROFILE_SCHEMA,providers:Object.freeze([...p])});}
  function workbenchVersion(v){return typeof v==='string'&&v.length<=40&&WORKBENCH_VERSION.test(v)?v:null;}
  const HEX64=/^[0-9a-f]{64}$/,ENGINE_VERSION=/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/,LIMIT_KEY=/^[A-Za-z][A-Za-z0-9]{0,31}$/,SOURCE_PATH=/^\/Shinick-Han\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/;
  // Engine source link is display-only: https://github.com/Shinick-Han/... with no credentials, port, query or fragment.
  function sourceUrl(v){if(typeof v!=='string'||v.length>300)return null;let u;try{u=new URL(v);}catch{return null;}
    return u.protocol==='https:'&&u.host==='github.com'&&!u.username&&!u.password&&!u.search&&!u.hash&&SOURCE_PATH.test(u.pathname)?u.href:null;}
  function limits(v){if(typeof v==='string')return v.slice(0,300);if(!v||typeof v!=='object'||Array.isArray(v))return null;const out={};
    for(const [k,n] of Object.entries(v).slice(0,8))if(LIMIT_KEY.test(k)&&Number.isSafeInteger(n)&&n>=0)out[k]=n;return Object.freeze(out);}
  // Continuation header/footer style is engine-declared, never inferred from pagination; scope text is fixed here, not echoed.
  const CONTINUATION_POLICY='source-number-suffix',CONTINUATION_SCOPE='text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged';
  function continuationStyle(v,pagination){if(pagination!==true||!v||typeof v!=='object'||Array.isArray(v)||v.supported!==true||v.policy!==CONTINUATION_POLICY)return null;
    return Object.freeze({supported:true,policy:CONTINUATION_POLICY,scope:CONTINUATION_SCOPE});}
  // Optional reflow-capable PDF editor from a newer broker. A malformed core field drops the whole descriptor; the legacy pdf flag is unaffected.
  function pdfEditor(d){if(!d||typeof d!=='object'||Array.isArray(d)||d.engine!=='falsify-pdf-editor'||typeof d.available!=='boolean'||typeof d.reflow!=='boolean'||typeof d.pagination!=='boolean')return null;
    const version=typeof d.version==='string'&&ENGINE_VERSION.test(d.version)?d.version:null,wasmSha256=typeof d.wasmSha256==='string'&&HEX64.test(d.wasmSha256)?d.wasmSha256:null;
    if(d.available&&(!version||!wasmSha256))return null;
    return Object.freeze({available:d.available,engine:d.engine,version,wasmSha256,reflow:d.reflow,pagination:d.pagination,continuationStyle:continuationStyle(d.continuationStyle,d.pagination),limits:limits(d.limits),sourceUrl:sourceUrl(d.sourceUrl)});}
  function pdfText(c){const e=c.pdfEditor;if(e?.available)return ' · PDF 편집 '+(e.reflow?'줄바꿈 재배치'+(e.pagination?'·페이지 추가':''):'한 줄 교체')+' ('+e.engine+' '+e.version+')';
    return ' · PDF 보존 '+(c.pdf?'한 줄 교체만':'불가')+(e?' · PDF 편집 엔진 미준비':'');}
  function versionText(c){return ' · companion '+(c.workbenchVersion?'버전 '+c.workbenchVersion:'버전 미보고(구버전)')+' · PDF 사전분석 '+(c.paperAnalysis?(c.paperAnalysis.available?'가능':'준비 안 됨'):'미지원(companion 업데이트 필요)')+' · 그림 한 곳 교체 '+(c.imageEditor?(c.imageEditor.available?'가능':'준비 안 됨'):'미지원');}
  const NETWORK='로컬 broker에 닿지 못했습니다. 서버 미실행·포트 불일치·--web-origin 누락(CORS 거부)·브라우저 로컬 네트워크 권한 차단 중 하나일 수 있습니다. 브라우저는 원인을 구분해 알려주지 않습니다.';
  const PORT_ERROR='포트는 1024–65535 사이 정수만 허용합니다. 주소는 항상 http://127.0.0.1입니다.';
  // Image routes only: a fixed companion error code and, for an engine refusal, one allowlisted reason ride the Error as properties.
  // Server text never becomes a code or reason (own string properties only); every other route keeps its existing error semantics.
  const IMAGE_PATH=/^\/api\/paper\/images(?:\/export)?$/;
  const IMAGE_ERRORS=Object.freeze(['image_edit_rejected','image_editor_unavailable','image_edit_timeout','image_edit_failed','companion_busy','invalid_request','invalid_file_hash','invalid_file','source_hash_mismatch',
    'consent_required','invalid_occurrence_id','invalid_replacement']);
  const IMAGE_REASONS=Object.freeze(['form-image','inline-image','rotated-page','cropped-page','clipped-image','transparency','unsupported-transform','overlapping-content','malformed-pdf','scan-limit','dependency-unavailable',
    'occurrence-not-found','not-editable','replacement-transparent','replacement-invalid','replacement-too-large','output-too-large','check-failed','no-op','engine-error']);
  const ownString=(d,k)=>!!d&&typeof d==='object'&&!Array.isArray(d)&&Object.hasOwn(d,k)&&typeof d[k]==='string'?d[k]:null;
  function imageError(e,status,data){const code=status===401||status===403?'unauthorized':ownString(data,'error');e.code=code==='unauthorized'||IMAGE_ERRORS.includes(code)?code:null;
    const why=e.code==='image_edit_rejected'?ownString(data,'reason'):null;e.reason=IMAGE_REASONS.includes(why)?why:null;return e;}

  function create({fetch:fetchImpl,location:loc,emit=()=>{},forget=()=>{}}){
    const local=loc.hostname===HOST;
    let status=local?'checking':'manual',error='',link=null,cap=null,attempt=0,port=local?Number(loc.port)||80:DEFAULT_PORT,launched=false;
    const busy={red:false,blue:false};
    const frozen=()=>busy.red||busy.blue||!!link&&link.inflight>0;
    function state(){return Object.freeze({mode:local?'local':'hosted',status,error,port,frozen:frozen(),busy:Object.freeze({...busy}),connected:status==='local'||status==='paired',cap,command:command(port),launched});}
    const changed=()=>emit(state());
    function drop(l){if(l){l.alive=false;l.token=null;}}
    // One request against a fixed link snapshot. The token travels only in the Authorization header.
    // An optional caller AbortSignal ends the fetch (deadline or stale result) so the in-flight freeze is always released.
    async function call(l,path,body,options){
      if(!l||!l.alive||!l.token)throw new Error(local?'인증된 로컬 작업대 세션이 없습니다.':'로컬 broker에 먼저 연결하세요. 연결 없이는 수동 JSON 교환만 가능합니다.');
      if(typeof path!=='string'||!PATH.test(path)||/\/\.{1,2}(?:\/|$)/.test(path))throw new Error('허용되지 않은 로컬 경로입니다.');
      const init={method:body?'POST':'GET',headers:{Authorization:'Bearer '+l.token,...(body?{'Content-Type':'application/json'}:{})},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'};
      if(body)init.body=JSON.stringify(body);
      if(l.remote){init.mode='cors';init.targetAddressSpace='loopback';}
      const signal=options&&typeof options==='object'?options.signal:undefined;if(signal)init.signal=signal;
      l.inflight++;if(l===link)changed();
      try{
        let res;try{res=await fetchImpl(l.remote?l.base+path:path,init);}catch{if(signal?.aborted)throw aborted();throw new Error(NETWORK);}
        if(res.redirected||res.type==='opaqueredirect')throw new Error('로컬 broker 리디렉션을 거부했습니다.');
        let data=null;try{data=await res.json();}catch{}if(signal?.aborted)throw aborted();
        if(!res.ok){const e=res.status===401||res.status===403?new Error('로컬 broker가 인증을 거부했습니다 ('+res.status+'). 토큰·포트·--web-origin을 확인하세요.'):new Error(typeof data?.error==='string'?data.error.slice(0,300):'로컬 요청 실패 ('+res.status+')');
          throw IMAGE_PATH.test(path)?imageError(e,res.status,data):e;}
        if(!data||typeof data!=='object')throw new Error('로컬 broker 응답이 JSON 객체가 아닙니다.');
        return data;
      }finally{l.inflight--;if(l===link)changed();}
    }
    function aborted(){const e=new Error('로컬 요청을 중단했습니다.');e.name='AbortError';return e;}
    function session(){const l=link;if(!l||!l.alive||!(status==='local'||status==='paired'))return null;return Object.freeze({request:(path,body,options)=>call(l,path,body,options)});}
    async function boot(){
      if(!local){changed();return;}
      try{const r=await fetchImpl('/api/session',{cache:'no-store',redirect:'error'});if(!r.ok)throw new Error();const s=await r.json();if(!validToken(s?.token))throw new Error();
        const l={token:s.token,base:'',remote:false,alive:true,inflight:0},next=capSnapshot(await call(l,'/api/capabilities'));if(!next){drop(l);throw new Error();}
        link=l;cap=next;status='local';error='';}
      catch{status='local-unavailable';error='';}
      changed();
    }
    // Pairing only verifies authenticated capabilities. It never starts jobs, records consent or calls a CLI.
    async function pair(rawToken,rawPort){
      const fail=message=>{error=message;changed();return {ok:false,error:message};};
      if(local)return fail('로컬 작업대는 same-origin 세션을 사용합니다. 페어링이 필요 없습니다.');
      if(frozen())return fail('RED/BLUE 작업 중에는 연결을 바꿀 수 없습니다.');
      const p=parsePort(rawPort);if(p===null)return fail(PORT_ERROR);
      const t=typeof rawToken==='string'?rawToken.trim():'';if(!t)return fail('터미널에 표시된 페어링 토큰을 붙여넣으세요.');if(!validToken(t))return fail('토큰 형식이 올바르지 않습니다. 터미널의 페어링 토큰 한 줄만 붙여넣으세요.');
      const id=++attempt;drop(link);link=null;cap=null;port=p;status='connecting';error='';changed();
      const candidate={token:t,base:'http://'+HOST+':'+p,remote:true,alive:true,inflight:0};
      try{const next=capSnapshot(await call(candidate,'/api/capabilities'));
        if(id!==attempt){drop(candidate);return {ok:false,error:'stale'};}
        if(!next)throw new Error('capabilities 응답 형식이 올바르지 않아 연결하지 않았습니다.');
        link=candidate;cap=next;status='paired';error='';changed();return {ok:true};}
      catch(e){drop(candidate);if(id!==attempt)return {ok:false,error:'stale'};status='manual';return fail(e.message);}
    }
    function disconnect(){if(local)return {ok:false,error:'로컬 작업대 세션은 끊지 않습니다.'};if(frozen()){error='RED/BLUE 작업 중에는 연결을 끊을 수 없습니다.';changed();return {ok:false,error};}
      const revoke=link&&link.remote&&typeof link.token==='string'&&link.token.startsWith('rc1.')?{token:link.token,base:link.base}:null;
      attempt++;drop(link);link=null;cap=null;status='manual';error='';
      let forgotten=null;try{forgotten=forget();}catch{forgotten=null;}
      if(revoke&&revoke.token!==forgotten)void fetchImpl(revoke.base+'/api/pair/revoke',{method:'POST',headers:{Authorization:'Bearer '+revoke.token,'Content-Type':'application/json'},body:JSON.stringify({schema:'falsify.pair-revoke.v1'}),credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',targetAddressSpace:'loopback'}).catch(()=>{});
      changed();return {ok:true};}
    // Click-pairing holds the panel in 'connecting' until redeem finishes. It does not open a model request.
    function hold(rawPort){
      const fail=message=>{error=message;changed();return {ok:false,error:message};};
      if(local)return fail('로컬 작업대는 same-origin 세션을 사용합니다. 페어링이 필요 없습니다.');
      if(frozen())return fail('RED/BLUE 작업 중에는 연결을 바꿀 수 없습니다.');
      if(link||status==='connecting')return fail('이미 연결되었거나 연결 확인 중입니다. 다시 열려면 먼저 연결을 해제하세요.');
      const p=parsePort(rawPort);if(p===null)return fail(PORT_ERROR);
      port=p;status='connecting';error='';launched=true;changed();return {ok:true,port:p};
    }
    function releaseHold(){if(status==='connecting'&&!link){status='manual';changed();}}
    function report(message){error=String(message||'').slice(0,300);changed();return {ok:!error,error};}
    // Explicit user click only (never on load): asks the OS to open the registered companion terminal.
    // Browsers cannot report whether a falsify:// handler exists, so success here only means the request was handed over.
    function launch(rawPort,open){
      const fail=message=>{error=message;changed();return {ok:false,error:message};};
      if(local)return fail('로컬 작업대는 same-origin 세션을 사용합니다. 터미널 열기가 필요 없습니다.');
      if(frozen())return fail('RED/BLUE 작업 중에는 연결을 바꿀 수 없습니다.');
      if(link||status==='connecting')return fail('이미 연결되었거나 연결 확인 중입니다. 다시 열려면 먼저 연결을 해제하세요.');
      const p=parsePort(rawPort);if(p===null)return fail(PORT_ERROR);
      if(typeof open!=='function')return fail('이 브라우저에서는 터미널 열기를 쓸 수 없습니다. 수동 실행을 쓰세요.');
      const uri=launchUri(p);port=p;error='';launched=true;
      try{open(uri);}catch{launched=false;return fail('브라우저가 연결 앱 열기를 막았습니다. 수동 실행을 쓰세요.');}
      changed();return {ok:true,uri};
    }
    function setBusy(role,value){if(!Object.hasOwn(busy,role))return;value=!!value;if(busy[role]===value)return;busy[role]=value;changed();}
    function setPort(value){if(local||status==='connecting'||link)return null;const p=parsePort(value);if(p!==null&&p!==port){port=p;changed();}return p;}
    const ready=boot();
    return Object.freeze({ready,state,session,pair,disconnect,launch,hold,releaseHold,report,busy:setBusy,setPort,capabilities:()=>cap});
  }

  function mount(bridge,doc,options={}){
    const $=id=>doc.getElementById(id),panel=$('local-bridge');if(!panel)return;
    const statusEl=$('bridge-status'),pairEl=$('bridge-pair'),portEl=$('bridge-port'),tokenEl=$('bridge-token'),connectEl=$('bridge-connect'),disconnectEl=$('bridge-disconnect'),commandEl=$('bridge-command'),launcherEl=$('bridge-launcher'),feedbackEl=$('bridge-feedback');
    const launchEl=$('bridge-launch'),launchStatusEl=$('bridge-launch-status'),otherOsEl=$('bridge-other-os'),installEl=$('bridge-install');
    // Windows, macOS and Linux keep the click handler visible after disconnect. The browser still cannot detect whether it is installed.
    const nav=doc.defaultView?.navigator,kind=platformKind(options.platform??nav?.userAgentData?.platform??nav?.platform??''),handler=kind==='windows'||kind==='mac'||kind==='linux';
    const open=options.open||(uri=>{const a=doc.createElement('a');a.href=uri;a.rel='noopener noreferrer';a.click();});
    if(installEl)installEl.textContent=installCommand(kind);
    function text(s){const c=s.cap,detail=c?versionText(c)+' · RED '+(c.red?'가능':'불가')+' · BLUE '+(c.blue?'가능':'불가')+pdfText(c)+' · CLI 선택 '+(c.cliSelection?'가능':'미지원(구버전 companion)'):'';
      if(s.status==='checking')return '로컬 작업대 세션 확인 중';
      if(s.status==='local')return '로컬 작업대 · same-origin 세션 (페어링 불필요)'+detail;
      if(s.status==='local-unavailable')return '정적 미리보기 · 인증된 로컬 broker 없음 · 파일 추출과 수동 JSON 교환만 가능';
      if(s.status==='connecting')return 'http://127.0.0.1:'+s.port+' 인증 확인 중';
      if(s.status==='paired')return '페어링됨 · http://127.0.0.1:'+s.port+' · 인증된 capabilities 확인'+detail;
      return '연결 안 됨 · 아래 순서로 내 PC와 연결하거나 수동 JSON 교환을 쓰세요';}
    function render(s=bridge.state()){
      panel.dataset.state=s.status;statusEl.textContent=text(s)+(s.frozen&&s.connected?' · 작업 중이라 연결 변경 잠김':'');
      if(pairEl)pairEl.hidden=s.mode==='local';
      if(feedbackEl){feedbackEl.textContent=s.error;feedbackEl.classList?.toggle('error',!!s.error);}
      const linked=s.status==='paired'||s.status==='connecting';
      if(portEl)portEl.disabled=s.frozen||linked;if(tokenEl)tokenEl.disabled=s.frozen||linked;
      if(connectEl)connectEl.disabled=s.frozen||linked;if(disconnectEl){disconnectEl.hidden=!linked;disconnectEl.disabled=s.frozen;}
      if(launchEl){launchEl.hidden=s.mode==='local'||!handler;launchEl.disabled=s.frozen||linked;}if(otherOsEl)otherOsEl.hidden=s.mode==='local'||handler;
      if(launchStatusEl)launchStatusEl.textContent=s.launched&&s.status==='manual'?'포트 '+s.port+'로 연결 앱 열기를 요청했습니다. 브라우저와 로컬 승인 창이 뜨면 고정 웹 출처만 허용하세요. 승인 뒤에는 새로고침이 상태만 다시 확인합니다. 창이 없거나 취소하면 아래 수동 토큰을 쓰세요. 브라우저는 설치 여부를 알려주지 않습니다.':'';
      const p=linked?s.port:parsePort(portEl?.value)??s.port;if(commandEl)commandEl.textContent=command(p,kind);if(launcherEl)launcherEl.textContent=launcher(p,kind);
      for(const a of doc.querySelectorAll?.('[data-bridge-local]')||[])a.href='http://127.0.0.1:'+(s.mode==='local'?s.port:p)+'/';
    }
    render();
    doc.addEventListener('falsify:local-bridge',e=>render(e.detail));
    portEl?.addEventListener('input',()=>{bridge.setPort(portEl.value);render();});
    launchEl?.addEventListener('click',()=>{const auto=options.autoPair||doc.defaultView?.FalsifyAutoPair;if(auto&&typeof auto.begin==='function'){void auto.begin({bridge,port:portEl?.value,open});return;}const r=bridge.launch(portEl?.value,open);if(r.ok)tokenEl?.focus?.();});
    // The token field is cleared on every attempt; the value lives only inside the bridge closure after success.
    connectEl?.addEventListener('click',async()=>{const t=tokenEl.value;tokenEl.value='';await bridge.pair(t,portEl?.value);});
    tokenEl?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();connectEl.click();}});
    disconnectEl?.addEventListener('click',()=>bridge.disconnect());
  }

  if(typeof module==='object'&&module.exports){module.exports={create,mount,parsePort,validToken,command,launcher,launchUri,pdfEditor,paperAnalysis,imageEditor,profileProposal,workbenchVersion,companionInstance,platformKind,installCommand,INSTALL,DEFAULT_PORT,IMAGE_ERRORS,IMAGE_REASONS};return;}
  const bridge=create({fetch:(...args)=>root.fetch(...args),location:root.location,emit:detail=>root.document.dispatchEvent(new CustomEvent('falsify:local-bridge',{detail})),forget:()=>{const auto=root.FalsifyAutoPair;if(auto&&typeof auto.forget==='function')auto.forget();}});
  root.FalsifyLocalBridge=bridge;mount(bridge,root.document);
  if(root.FalsifyAutoPair&&typeof root.FalsifyAutoPair.attach==='function')root.FalsifyAutoPair.attach(bridge);
})(typeof window==='object'?window:globalThis);

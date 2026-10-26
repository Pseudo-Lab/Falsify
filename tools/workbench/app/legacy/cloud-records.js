/* Optional team records on the configured server, readable only by signed-in invited members. The local ledger stays authoritative: nothing uploads, migrates or clears automatically, and server records never enter RED/BLUE requests. */
(function(){
  'use strict';
  // INVITE is the operator-issued single-use code (fsi_ + 32 random bytes base64url). It is only ever held in its field and the one register body.
  const SESSION_KEY='falsify.cloud-session.v1',TIMEOUT=15000,MAX_BODY=262144,USERNAME=/^[A-Za-z0-9_-]{3,32}$/,INVITE=/^fsi_[A-Za-z0-9_-]{43}$/,script=document.currentScript;
  const KINDS={harness:'Harness',run:'실행',review:'검수'},COLLECTION={harness:'harnesses',run:'runs',review:'reviews'};
  const VERDICTS={uncertain:'판단 불가',supported:'지지',unsupported:'반박',mixed:'혼재'},STATUSES={ok:'완료',abstain:'유보',refusal:'거절',failed:'실패',cancelled:'취소',unknown:'상태 미상'};
  const ORIGINS={executed:'로컬 broker 실행(보고)',manual:'수동 응답',imported:'가져온 기록'};
  // Korean copy for the core's comparison warning codes; unknown codes fall back to a generic line.
  const WARNINGS={client_reported:'모든 값은 작성자가 보고한 것이며 실행·모델·출처·검수자 이름은 검증되지 않았습니다.',invalid_record:'형식이 맞지 않는 기록은 뺐습니다.',review_run_missing:'대상 실행을 불러오지 않은 검수는 뺐습니다.',review_supersedes_other_owner:'다른 작성자의 검수를 대체한다는 표시는 무시했습니다.',incomparable_missing_condition:'사례 라벨이나 프로토콜이 없는 실행은 비교할 수 없어 뺐습니다.',harness_definition_missing:'공유된 Harness 정의가 보이지 않는 실행이 있습니다.',review_condition_mismatch:'사례 라벨이나 프로토콜이 없거나 대상 실행과 다른 검수는 검수 수·평균에서 뺐습니다.'};
  const PROPS=new Set(['id','className','type','value','checked','disabled','hidden','textContent','name','htmlFor','open','rows','maxLength','tabIndex']);
  // Fixed copy for the two sign-in gates: shared team records and the member check the server applies to every record request.
  const SHARED_LOGIN='공유 기록은 초대받은 팀 멤버만 볼 수 있습니다. 로그인한 뒤 불러오세요.',MINE_LOGIN='내 기록은 로그인한 뒤 볼 수 있습니다.';
  const MEMBER_DENIED='팀 멤버 자격이 확인되지 않아 이 브라우저에서 로그아웃했습니다. 초대 가입 전에 만든 계정이거나 멤버 자격이 해제됐을 수 있습니다. 운영자에게 확인한 뒤 다시 로그인하세요. 로컬 기록은 그대로입니다.';
  const clone=x=>JSON.parse(JSON.stringify(x)),short=h=>typeof h==='string'&&h?h.slice(0,12):'-',str=(v,n=300)=>v===null||v===undefined||v===''?'-':String(v).slice(0,n);
  function el(tag,props,...kids){const e=document.createElement(tag);for(const [k,v] of Object.entries(props||{})){if(k==='dataset')Object.assign(e.dataset,v);else if(PROPS.has(k))e[k]=v;else e.setAttribute(k,v);}e.append(...kids.filter(x=>x!==null&&x!==undefined&&x!==false));return e;}
  const local=message=>Object.assign(Error(message),{code:'local'});
  // Local ko-KR date-time with its zone; the raw ISO stays in datetime/title, and anything unparseable gets fixed copy instead of an exception.
  function when(iso){let text='';try{const ms=typeof iso==='string'?Date.parse(iso):NaN;if(Number.isFinite(ms))text=new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(ms);}catch{}
    return text?el('time',{datetime:iso.slice(0,40),title:iso.slice(0,40)},text):el('span',{},'시각 미상');}
  // '' keeps the feature off; anything but a plain https origin/path is refused instead of guessed.
  function parseBase(value){if(value===undefined||value===null||value==='')return '';if(typeof value!=='string')return null;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||value.trim()!==value)return null;return u.origin+u.pathname.replace(/\/+$/,'');}catch{return null;}}
  // Fixed copy only: server bodies are never shown, so a proxy error page cannot reach the screen.
  function safeErrorCode(text){try{const data=JSON.parse(text);const code=data&&typeof data==='object'&&data.error&&data.error.code;return typeof code==='string'&&/^[a-z0-9_]{1,64}$/.test(code)?code:'';}catch{return '';}}
  function explain(err,ctx){const s=err?.status,write=ctx==='write'||ctx==='register';
    if(err?.code==='local')return err.message;
    if(err?.code==='timeout'||err?.code==='network'){
      if(ctx==='password'||ctx==='revoke')return '서버 응답을 확인하지 못했습니다. 같은 요청을 자동으로 다시 보내지 않습니다. 비밀번호나 세션이 이미 바뀌었을 수 있으니 다시 로그인해 확인하세요. 입력은 저장하지 않았습니다. 로컬 기록은 그대로입니다.';
      if(err.code==='timeout')return write?'서버 응답이 15초 안에 오지 않았습니다. 반영됐는지 알 수 없으니 다시 보내기 전에 내 기록을 불러와 확인하세요.':'서버 응답이 15초 안에 오지 않았습니다. 잠시 후 다시 불러오세요.';
      return '공유 서버에 연결하지 못했습니다. 네트워크를 확인하세요. 로컬 기록은 그대로입니다.';}
    if(s===401&&ctx==='password'&&err?.errorCode==='invalid_credentials')return '현재 비밀번호가 맞지 않습니다. 입력은 지웠고 이 브라우저의 세션 토큰은 그대로 둡니다. 비밀번호는 저장하지 않습니다.';
    if(s===401)return ctx==='login'?'사용자 이름 또는 비밀번호가 맞지 않습니다.':'로그인이 필요하거나 세션이 끝났습니다. 다시 로그인하세요. 로컬 기록은 그대로입니다.';
    if(s===403)return ctx==='register'?'초대 코드가 맞지 않거나 만료·회수·사용된 코드입니다. 운영자에게 새 초대 코드를 받으세요. 입력한 코드는 지웠습니다.':ctx==='login'?'이 계정은 활성 팀 멤버가 아니라 로그인할 수 없습니다. 초대 가입 전에 만든 계정이거나 멤버 자격이 해제됐을 수 있으니 운영자에게 확인하세요.':ctx==='password'?'팀 멤버 자격이 확인되지 않아 비밀번호를 바꾸지 않았습니다. 입력은 지웠고 저장하지 않습니다.':ctx==='read'?MEMBER_DENIED:'이 기록을 바꿀 권한이 없거나 팀 멤버 자격이 확인되지 않습니다. 다시 로그인해 확인하세요.';
    if(s===404)return ctx==='password'?'이 서버에는 비밀번호 변경이 없습니다. 서버 업데이트가 필요합니다. 입력은 지웠고 이 브라우저의 세션 토큰은 그대로 둡니다. 비밀번호는 저장하지 않습니다.':ctx==='revoke'?'이 서버에는 모든 세션 종료가 없습니다. 서버 업데이트가 필요합니다. 이 브라우저의 세션 토큰은 그대로 둡니다.':'기록을 찾을 수 없습니다. 삭제됐거나 비공개입니다.';
    if(s===409||s===412)return ctx==='register'?'이미 쓰는 사용자 이름입니다. 초대 코드는 쓰이지 않았으니 다른 이름과 함께 코드를 다시 붙여 넣으세요.':'다른 곳에서 먼저 바뀌었습니다. 다시 불러온 뒤 시도하세요.';
    if(s===413)return ctx==='password'?'비밀번호 요청이 서버 크기 제한을 넘습니다. 입력은 지웠습니다.':'보내는 내용이 서버 크기 제한(256KiB)을 넘습니다.';
    if(s===429)return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    if(s===400||s===422)return ctx==='register'?'서버가 가입 요청 형식을 받아들이지 않았습니다. 초대 가입을 지원하지 않는 서버일 수 있으니 운영자에게 확인하세요.':ctx==='password'?'새 비밀번호가 서버 조건에 맞지 않습니다. 입력은 지웠고 저장하지 않습니다.':'서버가 요청 형식을 받아들이지 않았습니다.';
    if(s>=500)return '공유 서버 오류입니다. 잠시 후 다시 시도하세요.';
    return '공유 서버 응답을 해석하지 못했습니다.';}
  const validRecord=r=>!!r&&typeof r==='object'&&typeof r.id==='string'&&!!r.id&&r.id.length<=80&&Object.hasOwn(KINDS,r.kind)&&['private','shared'].includes(r.visibility)&&!!r.owner&&typeof r.owner==='object'&&typeof r.owner.id==='string'&&Number.isInteger(r.revision)&&!!r.payload&&typeof r.payload==='object'&&!Array.isArray(r.payload);

  function create(host,deps){
    const cfg=deps.config??globalThis.FalsifyCloudConfig,storage=deps.storage??globalThis.localStorage,fetcher=deps.fetch??globalThis.fetch?.bind(globalThis),lab=deps.lab??globalThis.FalsifyLab;
    const base=parseBase(cfg?.apiBase),hostName=base?new URL(base).host:'';
    // epoch changes whenever server-derived state is purged, so a response that arrives after sign-out is dropped instead of re-filling the screen.
    let session=null,expired=false,denied=false,memoryOnly=false,lastUser='',scope='shared',kind='',shown=[],cursor=null,loaded=false,snapshot=null,confirming=null,confirmingRevoke=false,previewed=null,reviewTarget=null,uploadSeq=0,reviewSeq=0,coreP=null,compared=false,userField=null,fields=null,passwordFields=null,epoch=0;
    // localIds keeps only my runs' local IDs (absent from list projections) so a local review can link to a run uploaded elsewhere.
    // controls maps 'recordId action' to the buttons of the current render so focus can follow a re-render.
    const seen=new Map(),localIds=new Map(),controls=new Map(),busy={list:false,auth:false,upload:false,review:false,op:false},upload={body:null},review={body:null};
    const core=()=>coreP??=(deps.core?Promise.resolve(deps.core):globalThis.FalsifyCloudCore?Promise.resolve(globalThis.FalsifyCloudCore):import(new URL('cloud-records-core.mjs',script?.src||location.href).href)).catch(()=>{coreP=null;throw local('공유 기록 검증 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');});
    const ownedBy=r=>!!session&&r.owner.id===session.author.id;

    // The session token is the only thing stored, under its own key, and only for the configured server.
    function loadSession(){try{const s=JSON.parse(storage.getItem(SESSION_KEY)||'null');if(!s||s.apiBase!==base||typeof s.token!=='string'||!s.token||!s.author||typeof s.author.id!=='string')return null;if(!(Date.parse(s.expiresAt)>Date.now())){storage.removeItem(SESSION_KEY);expired=true;return null;}return s;}catch{return null;}}
    function adopt(data){const a=data?.author;if(typeof data?.token!=='string'||data.token.length<16||data.token.length>1024||!a||typeof a.id!=='string'||typeof a.username!=='string')throw local('서버 로그인 응답 형식이 맞지 않습니다.');
      session={apiBase:base,token:data.token,author:{id:a.id,username:a.username,displayName:typeof a.displayName==='string'&&a.displayName?a.displayName:a.username},expiresAt:typeof data.expiresAt==='string'?data.expiresAt:''};expired=denied=false;
      try{storage.setItem(SESSION_KEY,JSON.stringify(session));memoryOnly=false;}catch{memoryOnly=true;}}
    // Team records are member-only, so signing out or losing the session drops every server record held in memory with the
    // comparison, the review composer and any upload preview built from them. The local ledger is never touched.
    function forget(){session=null;confirmingRevoke=false;passwordFields=null;try{storage.removeItem(SESSION_KEY);}catch{}epoch++;seen.clear();localIds.clear();shown=[];cursor=null;loaded=false;scope='shared';confirming=null;previewed=null;compared=false;
      compareOut.replaceChildren();closeReview();fillItems();connection.textContent='서버 '+hostName+' · 아직 불러오지 않음';}
    function onSignedOut(flag){if(!session)return;forget();if(flag==='denied')denied=true;else expired=true;account.open=true;renderAccount();setBusy();renderList();}
    const live=at=>at===epoch&&!!session;

    async function api(method,path,{body,auth=false,ifMatch,sessionPolicy}={}){
      if(!base||!fetcher)throw local('공유 서버가 설정되지 않았습니다.');
      const headers={accept:'application/json'};if(body!==undefined)headers['content-type']='application/json';
      if(auth){if(!session)throw local('로그인한 뒤 사용할 수 있습니다.');headers.authorization='Bearer '+session.token;}
      if(ifMatch!==undefined)headers['if-match']=String(ifMatch);
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),TIMEOUT);let res,text='';
      try{res=await fetcher(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:ctl.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',mode:'cors'});text=await res.text();}
      catch{throw Object.assign(Error('request'),{code:ctl.signal.aborted?'timeout':'network'});}
      finally{clearTimeout(timer);}
      // 401 ends the session; a 403 on a signed-in read means the account is no longer an active member, which also signs out.
      if(!res.ok){const errorCode=safeErrorCode(text);const wrongPassword=sessionPolicy==='keep'&&res.status===401&&errorCode==='invalid_credentials';if(auth&&!wrongPassword&&(res.status===401||res.status===403&&method==='GET'))onSignedOut(res.status===401?'expired':'denied');throw Object.assign(Error('http'),{code:'http',status:res.status,errorCode});}
      if(res.status===204||!text)return {};
      try{const data=JSON.parse(text);if(data&&typeof data==='object'&&!Array.isArray(data))return data;}catch{}
      throw Object.assign(Error('response'),{code:'response',status:res.status});}

    const say=(message,error=false)=>{status.textContent=message;status.classList.toggle('error',error);};
    const button=(label,variant,fn,props={})=>{const b=el('button',{type:'button',className:variant==='text'?'text-button':'button '+variant,...props},label);b.addEventListener('click',fn);return b;};
    // One section appended after the local ledger: heading, toolbar, status, account, list, review composer, upload and comparison.
    const connection=el('span',{className:'status-label',id:'cloud-connection'}),status=el('p',{id:'cloud-status',className:'ledger-status cloud-status',role:'status',tabIndex:-1});
    const tabShared=el('button',{type:'button',id:'cloud-tab-shared','aria-pressed':'true'},'공유 기록'),tabMine=el('button',{type:'button',id:'cloud-tab-mine','aria-pressed':'false'},'내 기록');
    const kindSelect=el('select',{id:'cloud-kind'},el('option',{value:''},'전체 종류'),...Object.entries(KINDS).map(([k,v])=>el('option',{value:k},v)));kindSelect.value='';
    const refresh=el('button',{type:'button',id:'cloud-refresh',className:'button primary'},'불러오기');
    const toolbar=el('div',{className:'cloud-toolbar'},el('div',{className:'cloud-tabs',role:'group','aria-label':'기록 범위'},tabShared,tabMine),el('label',{className:'cloud-kind'},'종류',kindSelect),refresh);
    const accountSummary=el('summary',{id:'cloud-account-summary'}),accountBody=el('div',{id:'cloud-account-body'}),account=el('details',{id:'cloud-account',className:'cloud-panel'},accountSummary,accountBody);
    const list=el('div',{id:'cloud-list',className:'cloud-list'}),more=el('button',{type:'button',id:'cloud-more',className:'button secondary',hidden:true},'더 불러오기');
    const reviewBox=el('section',{id:'cloud-review',className:'cloud-compose',hidden:true,'aria-labelledby':'cloud-review-title'});
    const uploadBody=el('div',{id:'cloud-upload-body'}),uploadBox=el('details',{id:'cloud-upload',className:'cloud-panel'},el('summary',{},'내 로컬 기록 올리기'),uploadBody);
    const compareBody=el('div',{id:'cloud-compare-body'}),compareBox=el('details',{id:'cloud-compare',className:'cloud-panel'},el('summary',{},'같은 조건 비교'),compareBody);
    const root=el('section',{id:'cloud-records',className:'document-red cloud-records','aria-labelledby':'cloud-records-title'},
      el('div',{className:'section-heading'},el('div',{},el('h2',{id:'cloud-records-title'},'공유 기록'),el('p',{},'초대받은 팀 멤버가 로그인해 팀에 공유된 Harness·실행 요약·검수를 읽습니다. 이 작업대 페이지는 공개돼 있어도 서버 기록은 공개 열람이 아닙니다. 올리기는 고른 기록 하나씩, 보낼 내용을 확인하고 동의해야 진행됩니다.')),connection),
      el('p',{className:'cloud-privacy'},'새 기록은 기본으로 비공개입니다. 공유는 인터넷 공개가 아니라 로그인한 팀 멤버 모두가 읽는다는 뜻입니다. 로컬 기록은 자동으로 올라가거나 지워지지 않으며, 서버 기록의 값은 모두 작성자가 보고한 내용이지 실행 검증이 아닙니다.'),
      toolbar,status,account,list,more,reviewBox,uploadBox,compareBox);
    host.append(root);

    const upKind=el('select',{id:'cloud-upload-kind'},...Object.entries(KINDS).map(([k,v])=>el('option',{value:k},v))),upItem=el('select',{id:'cloud-upload-item'});upKind.value='harness';
    const upVis=el('select',{id:'cloud-upload-visibility'},el('option',{value:'private'},'비공개 · 나만 봄'),el('option',{value:'shared'},'공유 · 팀 멤버 모두 읽음'));upVis.value='private';
    const upEvidence=el('input',{type:'checkbox',id:'cloud-upload-evidence'}),upConsent=el('input',{type:'checkbox',id:'cloud-upload-consent'}),upConsentText=el('span');
    const upCase=el('input',{type:'text',id:'cloud-upload-case',maxLength:160}),upProtocol=el('input',{type:'text',id:'cloud-upload-protocol',maxLength:80});
    const runFields=el('div',{id:'cloud-upload-run-fields'},el('div',{className:'ledger-fields'},el('label',{},'사례 라벨 · 160자 이내',upCase),el('label',{},'프로토콜 버전 · 비우면 응답 schema',upProtocol)),el('p',{className:'muted'},'사례 라벨과 프로토콜이 없는 실행은 같은 조건 비교에서 빠집니다.'));
    // A local review records no protocol: it is sent only when the user confirms the linked run's, never inferred.
    const upRvProtocol=el('input',{type:'checkbox',id:'cloud-upload-review-protocol',disabled:true}),upRvProtocolText=el('span',{},'대상 실행과 같은 프로토콜로 검수했음을 확인합니다'),upRvCond=el('p',{id:'cloud-upload-review-conditions',className:'muted'});
    const reviewFields=el('div',{id:'cloud-upload-review-fields',hidden:true},upRvCond,el('label',{className:'check-row'},upRvProtocol,upRvProtocolText));
    const upPreview=el('pre',{id:'cloud-upload-preview',className:'cloud-preview',tabIndex:0,'aria-label':'보낼 내용'}),upStatus=el('p',{id:'cloud-upload-status',className:'ledger-status',role:'status'});
    const upSend=el('button',{type:'button',id:'cloud-upload-send',className:'button primary',disabled:true},'올리기'),uploadGate=el('p',{className:'muted'},'로그인한 뒤 내 로컬 기록을 골라 올릴 수 있습니다.');
    const uploadForm=el('div',{},el('p',{},'로컬 기록을 자동으로 올리지 않습니다. 하나를 고르고 보낼 내용을 확인한 뒤 동의해야 올라갑니다. 논문 추출문·모델 응답 같은 증거는 기본으로 빼며, 넣더라도 비공개 실행 기록에만 들어갑니다.'),
      button('로컬 기록 읽기','secondary',readSnapshot,{id:'cloud-upload-read'}),
      el('div',{className:'ledger-fields'},el('label',{},'종류',upKind),el('label',{},'로컬 기록',upItem)),runFields,reviewFields,el('label',{},'공개 범위',upVis),
      el('label',{className:'check-row'},upEvidence,el('span',{},'비공개 증거 포함',el('small',{},'실행 기록의 논문 추출문과 모델 응답입니다. 공유로 올릴 때는 넣을 수 없습니다.'))),
      el('h4',{},'보낼 내용'),upPreview,el('label',{className:'check-row'},upConsent,upConsentText),el('div',{className:'button-row'},upSend),upStatus);
    uploadBody.append(uploadGate,uploadForm);
    const upSay=(message,error=false)=>{upStatus.textContent=message;upStatus.classList.toggle('error',error);};

    const rvVerdict=el('select',{id:'cloud-review-verdict'},el('option',{value:''},'판정 선택'),...Object.entries(VERDICTS).map(([k,v])=>el('option',{value:k},v)));rvVerdict.value='';
    const rvScore=el('select',{id:'cloud-review-score'},el('option',{value:''},'점수 없음'),...[1,2,3,4,5].map(n=>el('option',{value:String(n)},n+' / 5')));rvScore.value='';
    const rvVisShared=el('option',{value:'shared'},'공유 · 팀 멤버 모두 읽음'),rvNote=el('textarea',{id:'cloud-review-note',rows:5,maxLength:3000}),rvCase=el('input',{type:'text',id:'cloud-review-case',maxLength:160}),rvVis=el('select',{id:'cloud-review-visibility'},el('option',{value:'private'},'비공개 · 나만 봄'),rvVisShared);rvVis.value='private';
    const rvTarget=el('dl',{id:'cloud-review-target'}),rvPreview=el('pre',{id:'cloud-review-preview',className:'cloud-preview',tabIndex:0,'aria-label':'보낼 검수'}),rvConsent=el('input',{type:'checkbox',id:'cloud-review-consent'}),rvConsentText=el('span');
    const rvSend=el('button',{type:'button',id:'cloud-review-send',className:'button primary',disabled:true},'검수 올리기'),rvStatus=el('p',{id:'cloud-review-status',className:'ledger-status',role:'status'});
    const rvTitle=el('h3',{id:'cloud-review-title'}),rvIntro=el('p',{id:'cloud-review-intro',className:'muted'}),rvCond=el('p',{id:'cloud-review-conditions',className:'muted'});
    reviewBox.append(rvTitle,rvIntro,rvTarget,rvCond,
      el('div',{className:'ledger-fields'},el('label',{},'판정',rvVerdict),el('label',{},'점수',rvScore)),el('label',{},'판정 근거 · 3000자 이내',rvNote),el('label',{},'사례 라벨 · 대상 실행에 있으면 그 값에 묶입니다',rvCase),el('label',{},'공개 범위',rvVis),el('h4',{},'보낼 내용'),rvPreview,
      el('label',{className:'check-row'},rvConsent,rvConsentText),el('div',{className:'button-row'},rvSend,button('닫기','secondary',closeReview,{id:'cloud-review-close'})),rvStatus);
    const rvSay=(message,error=false)=>{rvStatus.textContent=message;rvStatus.classList.toggle('error',error);};

    const compareOut=el('div',{id:'cloud-compare-out'});
    compareBody.append(el('p',{},'입력 해시·역할·모델·난이도·호출 예산·프로토콜·사례가 모두 같은 실행끼리만 나란히 놓습니다. 공식 순위나 정확도 검증이 아니며 모든 값은 작성자가 보고한 것입니다. 조건이 하나라도 다르면 같은 표에 넣지 않습니다.'),
      button('불러온 기록으로 비교','secondary',()=>{compared=true;compare();},{id:'cloud-compare-run'}),compareOut);

    if(!base){connection.textContent=base===null?'꺼짐 · 서버 주소 설정 오류':'꺼짐 · 서버 미설정';for(const e of [toolbar,account,more,uploadBox,compareBox])e.hidden=true;
      say(base===null?'공유 서버 주소 설정이 올바르지 않아 꺼 두었습니다. 로컬 기록은 그대로 사용합니다.':'공유 서버가 설정되지 않아 꺼져 있습니다. 로컬 기록은 그대로 사용합니다.');return {root,enabled:false};}

    function setBusy(){refresh.disabled=more.disabled=kindSelect.disabled=busy.list;refreshTabs();refreshSend();refreshReview();}
    function refreshTabs(){if(!session&&scope==='mine'){scope='shared';shown=[];cursor=null;loaded=false;renderList();}
      tabShared.setAttribute('aria-pressed',String(scope==='shared'));tabMine.setAttribute('aria-pressed',String(scope==='mine'));tabShared.disabled=tabMine.disabled=busy.list;}
    // Signed out, '내 기록' stays reachable and explains itself: it opens the sign-in form and requests nothing.
    // Shared team records are member-only too, so every signed-out load asks for sign-in the same way; the server enforces it regardless.
    function signInFirst(message){account.open=true;say(message,true);userField?.focus?.();}
    function choose(next){if(busy.list||scope===next)return;if(next==='mine'&&!session){signInFirst(MINE_LOGIN);return;}
      scope=next;shown=[];cursor=null;loaded=false;confirming=null;refreshTabs();load(false);}
    async function load(append){
      if(busy.list)return;if(!session){signInFirst(scope==='mine'?MINE_LOGIN:SHARED_LOGIN);return;}
      const q=new URLSearchParams({scope});if(kind)q.set('kind',kind);if(append&&cursor)q.set('cursor',cursor);
      const at=epoch;busy.list=true;setBusy();say(append?'더 불러오는 중…':'불러오는 중…');
      try{const data=await api('GET','/v1/records?'+q,{auth:true});if(!live(at))return;const raw=Array.isArray(data.records)?data.records.slice(0,200):[],good=raw.filter(validRecord);
        if(!append)shown=[];for(const r of good){shown=shown.filter(x=>x.id!==r.id);shown.push(r);seen.set(r.id,r);}
        cursor=typeof data.nextCursor==='string'&&data.nextCursor&&data.nextCursor.length<=512?data.nextCursor:null;loaded=true;
        connection.textContent='서버 '+hostName+' · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})+' 불러옴';
        say((scope==='mine'?'내':'공유')+' 기록 '+shown.length+'건'+(cursor?' · 더 있음':'')+(good.length<raw.length?' · 형식이 맞지 않는 '+(raw.length-good.length)+'건 제외':''));
        if(compared)compare();}
      catch(e){say(explain(e,'read')+(shown.length&&live(at)?' 이미 불러온 기록은 그대로 둡니다.':''),true);}
      finally{busy.list=false;setBusy();renderList();}}
    // Signed out, the gating sentence lives in the status line and the account form; the empty list stays neutral so it is never said twice.
    function renderList(){controls.clear();list.replaceChildren(...(shown.length?shown.map(recordView):[el('p',{className:'muted'},!session?'로그인 후 불러오면 이곳에 팀 공유 기록이 표시됩니다.':loaded?'조건에 맞는 기록이 없습니다.':'아직 불러오지 않았습니다. 불러오기를 누르면 서버에서 팀 공유 기록을 읽습니다.')]));more.hidden=!cursor;}
    function recordView(r){
      const p=r.payload,mine=ownedBy(r),rows=[['작성자',str(r.owner.displayName,80)+(r.owner.username?' (@'+str(r.owner.username,40)+')':'')+' · 자기 보고 이름'],['서버 기록',[when(r.createdAt),' · 버전 '+r.revision]]];let title;
      if(r.kind==='harness'){const c=p.config&&typeof p.config==='object'?p.config:{};title=str(c.name,120)+' · '+str(c.role,10).toUpperCase()+' · v'+str(c.version,40);rows.push(['내용 해시',short(p.hash)]);if(p.parentHash)rows.push(['이전 버전',short(p.parentHash)]);}
      else if(r.kind==='run'){title=str(p.role,10).toUpperCase()+' 실행 · '+str(p.model,120);rows.push(['결과',(STATUSES[p.status]||str(p.status,20))+' · 호출 '+str(p.calls)+' / 예산 '+str(p.maxCalls)],['조건','입력 '+short(p.sourceHash)+' · 난이도 '+str(p.level)+' · 프로토콜 '+str(p.protocolVersion,80)+' · 사례 '+str(p.caseLabel,160)],['Harness',short(p.harnessHash)],['출처(보고)',str(p.provenance,60)],['실행 시각(보고)',when(p.createdAt)]);if(p.evidence)rows.push(['증거','비공개 원문 포함 · 작성자만 봄']);}
      else{title='검수 · '+(VERDICTS[p.verdict]||str(p.verdict,20))+' · '+(p.score===null||p.score===undefined?'점수 없음':'점수 '+str(p.score)+' / 5');rows.push(['대상 실행',short(p.runId)],['조건','사례 '+str(p.caseLabel,160)+' · 프로토콜 '+str(p.protocolVersion,80)]);if(p.supersedes)rows.push(['대체한 검수',short(p.supersedes)]);}
      const dl=el('dl');for(const [k,v] of rows)dl.append(el('dt',{},k),el('dd',{},...[v].flat()));
      const selfReview=r.kind==='review'&&seen.get(p.runId)?.owner.id===r.owner.id;
      const a=el('article',{className:'cloud-record',dataset:{recordId:r.id}},el('div',{className:'cloud-chips'},...[KINDS[r.kind],r.visibility==='shared'?'공유':'비공개',mine?'내 기록':'다른 작성자',selfReview?'자체 평가 · 독립 검수 아님':'','작성자 보고 · 미검증'].filter(Boolean).map(t=>el('span',{className:'status-label'},t))),el('h3',{},title),dl);
      if(r.kind==='review'&&p.note)a.append(el('p',{className:'cloud-note'},str(p.note,3000)));
      if(mine&&r.kind==='run')a.append(el('p',{className:'muted'},'기록 JSON 다운로드는 내 로그인으로 전체 기록을 받습니다. 비공개 증거(논문 추출문·모델 응답)와 로컬 ID가 들어 있을 수 있으니 받은 파일을 공유하지 마세요.'));
      const actions=[button('기록 JSON 다운로드','secondary',()=>download(r),{disabled:busy.op,dataset:{action:'download'}})];
      if(r.kind==='harness'){actions.push(button('편집기로 미리보기','secondary',()=>previewHarness(r),{disabled:busy.op,dataset:{action:'preview'}}));if(previewed===r.id)actions.push(el('button',{type:'button',className:'text-button',dataset:{view:'agents',action:'open-agents'}},'Harness 화면에서 보기'));}
      if(r.kind==='run'&&session&&(mine||r.visibility==='shared'))actions.push(button(mine?'자체 평가 쓰기':'검수 쓰기','secondary',()=>openReview(r),{dataset:{action:'review'}}));
      if(mine&&confirming?.id===r.id){const act=confirming.action;
        a.append(el('p',{className:'cloud-confirm'},act==='delete'?'서버에서 이 기록을 지웁니다. 로컬 기록은 그대로입니다.':act==='shared'?'공유하면 로그인한 팀 멤버 모두가 읽습니다. 인터넷 공개는 아닙니다. 실행의 비공개 증거와 로컬 ID는 공유본에서 빠집니다.':'비공개로 바꿔도 팀 멤버가 이미 받아 간 사본은 회수할 수 없습니다.'));
        actions.push(button(act==='delete'?'삭제 확인':act==='shared'?'공유 확인':'비공개 전환 확인','primary',()=>act==='delete'?remove(r):setVisibility(r,act),{disabled:busy.op,dataset:{action:'confirm'}}),button('취소','secondary',()=>cancel(r),{dataset:{action:'cancel'}}));}
      else if(mine)actions.push(button(r.visibility==='shared'?'비공개로 전환':'공유하기','secondary',()=>ask(r,r.visibility==='shared'?'private':'shared'),{disabled:busy.op,dataset:{action:'visibility'}}),button('삭제','secondary',()=>ask(r,'delete'),{disabled:busy.op,dataset:{action:'delete'}}));
      for(const b of actions)if(b.dataset.action)controls.set(r.id+' '+b.dataset.action,b);
      if(actions.length)a.append(el('div',{className:'button-row'},...actions));
      return a;}
    function ask(r,action){confirming={id:r.id,action};renderList();refocus(r.id,['confirm']);}
    function cancel(r){const back=confirming?.action==='delete'?'delete':'visibility';confirming=null;renderList();refocus(r.id,[back]);}
    // A re-render replaces the activated button: focus returns to that record's control, else the record now in its place, else the status line.
    // Focus the user has moved elsewhere in the meantime is left alone.
    function refocus(id,names,at=shown.findIndex(x=>x.id===id)){const a=document.activeElement;if(a&&a!==document.body&&!list.contains(a))return;
      const next=shown.some(x=>x.id===id)?null:shown[Math.min(at,shown.length-1)],target=next?controls.get(next.id+' download'):names.map(n=>controls.get(id+' '+n)).find(b=>b&&!b.disabled);
      (target||status).focus?.();}
    const recordPath=r=>'/v1/records/'+encodeURIComponent(r.id);
    async function mutate(r,origin,work,done){if(busy.op)return;const at=shown.findIndex(x=>x.id===r.id),era=epoch;busy.op=true;confirming=null;renderList();say('서버에 반영하는 중…');
      try{await work(era);say(done);}catch(e){say(explain(e,'write'),true);}finally{busy.op=false;renderList();refocus(r.id,[origin],at);}}
    function setVisibility(r,visibility){return mutate(r,'visibility',async era=>{const data=await api('PATCH',recordPath(r),{auth:true,body:{expectedRevision:r.revision,visibility}});const rec=data.record;
      if(!validRecord(rec)||rec.id!==r.id)throw local('서버 응답 형식이 맞지 않습니다. 다시 불러와 확인하세요.');if(!live(era))return;seen.set(rec.id,rec);shown=shown.flatMap(x=>x.id!==rec.id?[x]:scope==='shared'&&rec.visibility!=='shared'?[]:[rec]);},visibility==='shared'?'공유했습니다. 이제 로그인한 팀 멤버 모두가 읽을 수 있습니다.':'비공개로 바꿨습니다.');}
    function remove(r){return mutate(r,'delete',async era=>{await api('DELETE',recordPath(r),{auth:true,ifMatch:r.revision});if(!live(era))return;seen.delete(r.id);shown=shown.filter(x=>x.id!==r.id);},'서버에서 삭제했습니다. 로컬 기록은 그대로입니다.');}
    // One record per explicit click, always signed in: the owner gets the full private payload, other members the server's shared projection.
    // The body is saved only if it is the record that was clicked; it is never rendered, kept in the list or sent anywhere else, and
    // another author's copy carrying owner-only fields (evidence, local ID) is refused rather than saved.
    async function download(r){if(busy.op)return;const owner=ownedBy(r),at=epoch;busy.op=true;renderList();say('기록을 받는 중…');
      try{const rec=(await api('GET',recordPath(r),{auth:true})).record;if(!live(at))throw local('로그인이 끝나 받은 기록을 저장하지 않았습니다.');
        if(!validRecord(rec)||rec.id!==r.id||rec.kind!==r.kind||rec.owner.id!==r.owner.id)throw local('받은 기록이 고른 기록과 맞지 않아 저장하지 않았습니다.');
        if(!owner&&('evidence' in rec.payload||'localId' in rec.payload))throw local('받은 공유본에 작성자 전용 필드(비공개 증거·로컬 ID)가 들어 있어 저장하지 않았습니다.');
        if(owner&&rec.kind==='run'&&typeof rec.payload.localId==='string')localIds.set(rec.id,rec.payload.localId);
        save('falsify-'+rec.kind+'-'+rec.id.replace(/[^A-Za-z0-9_-]/g,'_')+'.json',rec);
        say(rec.kind==='run'&&rec.payload.evidence?'기록 JSON을 저장했습니다. 파일에 비공개 증거(논문 추출문·모델 응답)가 들어 있으니 공유하지 마세요.':owner?'내 기록 전체를 JSON으로 저장했습니다. 로컬 ID 같은 비공개 필드가 들어 있을 수 있습니다.':'다른 작성자의 공유본 JSON을 저장했습니다. 비공개 증거와 로컬 ID는 빠져 있고, 작성자가 보고한 내용이라 검증되지 않았습니다. 받은 파일은 서버에서 회수되지 않으니 팀 밖으로 돌리지 마세요.');}
      catch(e){say(e?.code==='local'||e?.code==='http'||e?.code==='timeout'||e?.code==='network'||e?.code==='response'?explain(e,'read'):'기록 JSON을 저장하지 못했습니다.',true);}
      finally{busy.op=false;renderList();refocus(r.id,['download']);}}
    function save(name,data){const href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));el('a',{href,download:name}).click();setTimeout(()=>URL.revokeObjectURL(href),60000);}
    // Preview only: the ledger hook loads the editor without registering, selecting or executing anything.
    async function previewHarness(r){if(busy.op)return;busy.op=true;
      try{if(typeof lab?.previewSharedHarness!=='function')throw local('이 작업대는 공유 Harness 미리보기를 지원하지 않습니다.');const hash=await lab.previewSharedHarness(clone(r.payload.config),typeof r.payload.hash==='string'?r.payload.hash:undefined);previewed=r.id;
        say('Harness 편집기에 미리보기만 불러왔습니다'+(typeof hash==='string'?' (내용 해시 '+short(hash)+')':'')+'. 등록·선택·실행은 하지 않았습니다.');}
      catch(e){say(e?.code==='local'?e.message:'Harness 미리보기 실패: '+str(e?.message,200),true);}finally{busy.op=false;renderList();refocus(r.id,['preview']);}}

    function renderAccount(){accountBody.replaceChildren();userField=null;passwordFields=null;if(!session)confirmingRevoke=false;
      if(session){accountSummary.textContent='로그인됨 · '+str(session.author.displayName,80);
        const current=el('input',{id:'cloud-current-password',type:'password',autocomplete:'current-password',maxLength:128,spellcheck:'false','aria-describedby':'cloud-current-password-hint'}),next=el('input',{id:'cloud-new-password',type:'password',autocomplete:'new-password',maxLength:128,spellcheck:'false','aria-describedby':'cloud-new-password-hint'}),confirm=el('input',{id:'cloud-confirm-password',type:'password',autocomplete:'new-password',maxLength:128,spellcheck:'false','aria-describedby':'cloud-confirm-password-hint'});
        passwordFields={current,next,confirm};
        const passwordForm=el('form',{id:'cloud-password-form',className:'cloud-auth',novalidate:''},el('h3',{id:'cloud-password-title'},'비밀번호 변경'),el('p',{className:'muted'},'현재 비밀번호를 확인한 뒤 바꿉니다. 바꾸면 이 계정의 서버 세션이 모두 끝나고 이 브라우저의 토큰도 지웁니다. 새 비밀번호는 저장하지 않으며 자동으로 다시 로그인하지 않습니다.'),el('label',{},'현재 비밀번호',el('small',{id:'cloud-current-password-hint'},'확인만 하고 저장하지 않습니다'),current),el('label',{},'새 비밀번호',el('small',{id:'cloud-new-password-hint'},'12–128자'),next),el('label',{},'새 비밀번호 확인',el('small',{id:'cloud-confirm-password-hint'},'새 비밀번호와 같아야 합니다'),confirm),el('div',{className:'button-row'},el('button',{type:'submit',id:'cloud-password-change',className:'button primary',disabled:busy.auth},'비밀번호 변경')));
        passwordForm.addEventListener('submit',e=>{e.preventDefault();changePassword(current,next,confirm);});
        const revokeBox=el('div',{id:'cloud-revoke',className:confirmingRevoke?'cloud-confirm':''},el('p',{},'이 계정의 서버 세션만 끝냅니다. 다른 계정, 공유 기록, 소유 권한은 바꾸지 않습니다.'),confirmingRevoke
          ?el('div',{className:'button-row'},button('모든 세션 끝내기 확인','primary',revokeAllSessions,{id:'cloud-revoke-confirm',disabled:busy.auth}),button('취소','secondary',()=>{confirmingRevoke=false;renderAccount();},{id:'cloud-revoke-cancel',disabled:busy.auth}))
          :el('div',{className:'button-row'},button('모든 세션 끝내기','secondary',()=>{confirmingRevoke=true;renderAccount();},{id:'cloud-revoke-all',disabled:busy.auth})));
        accountBody.append(el('dl',{},el('dt',{},'표시 이름'),el('dd',{},str(session.author.displayName,80)+' · 자기 보고'),el('dt',{},'사용자 이름'),el('dd',{},str(session.author.username,40)),el('dt',{},'세션 만료'),el('dd',{},when(session.expiresAt))),
          el('p',{className:'muted'},memoryOnly?'브라우저 저장소를 쓸 수 없어 이 탭을 닫으면 로그아웃됩니다.':'세션 토큰은 이 브라우저 localStorage의 별도 항목('+SESSION_KEY+')에만 있고 '+hostName+'로만 보냅니다. 비밀번호는 저장하지 않습니다.'),
          el('div',{className:'button-row'},button('로그아웃','secondary',logout,{id:'cloud-logout',disabled:busy.auth}),button('이 브라우저에서만 지우기','text',()=>{forget();say('이 브라우저의 세션 토큰과 불러온 서버 기록을 지웠습니다. 서버 세션은 만료될 때까지 남습니다.');renderAccount();setBusy();renderList();status.focus?.();},{id:'cloud-forget',disabled:busy.auth})),
          passwordForm,revokeBox);return;}
      accountSummary.textContent=expired?'다시 로그인 필요':denied?'팀 멤버 확인 필요':'로그인 · 초대 가입 (공유 기록을 보려면 필요)';
      const user=el('input',{id:'cloud-username',type:'text',autocomplete:'username',maxLength:32,spellcheck:'false',autocapitalize:'none','aria-describedby':'cloud-username-hint'}),pass=el('input',{id:'cloud-password',type:'password',autocomplete:'current-password',maxLength:128,'aria-describedby':'cloud-password-hint'}),display=el('input',{id:'cloud-display-name',type:'text',autocomplete:'nickname',maxLength:80});
      // The invitation is masked, never autofilled or saved by the browser, and has no name, so no form submission can carry it.
      const invite=el('input',{id:'cloud-invite',type:'password',autocomplete:'off',maxLength:200,spellcheck:'false',autocapitalize:'none','aria-describedby':'cloud-invite-note'});
      user.value=lastUser;userField=user;fields={user,pass,invite};
      const form=el('form',{id:'cloud-auth-form',className:'cloud-auth',novalidate:''},el('label',{},'사용자 이름',el('small',{id:'cloud-username-hint'},'영문·숫자·_·- 3–32자'),user),el('label',{},'비밀번호',el('small',{id:'cloud-password-hint'},'12–128자 · 저장하지 않습니다'),pass),
        el('label',{className:'cloud-invite'},'초대 코드 · 가입할 때만',el('small',{id:'cloud-invite-note'},'운영자에게 받은 fsi_ 코드 · 로그인에는 보내지 않고 저장하지 않습니다'),invite),
        el('details',{className:'cloud-display'},el('summary',{},'가입할 때 표시 이름 (선택)'),el('label',{},'표시 이름 · 비우면 사용자 이름',display)),
        el('div',{className:'button-row'},el('button',{type:'submit',id:'cloud-login',className:'button primary'},'로그인'),button('가입','secondary',()=>authenticate('register',user,pass,display,invite),{id:'cloud-register'})));
      form.addEventListener('submit',e=>{e.preventDefault();authenticate('login',user,pass,display,invite);});
      if(expired)accountBody.append(el('p',{className:'error',role:'alert'},'세션이 끝났습니다. 다시 로그인하세요. 로컬 기록은 그대로이며, 불러온 서버 기록은 화면에서 지웠습니다.'));
      else if(denied)accountBody.append(el('p',{className:'error',role:'alert'},MEMBER_DENIED));
      accountBody.append(el('p',{className:'muted'},'공유 기록은 초대받은 팀 멤버만 읽습니다. 처음에는 운영자에게 받은 한 번 쓰는 초대 코드로 가입하고, 그 뒤에는 사용자 이름과 비밀번호로 로그인합니다. 초대 코드는 가입을 시도하면 결과와 관계없이 지웁니다. 로그인하면 7일짜리 세션 토큰만 이 브라우저에 남기고, 이메일·실명 확인과 비밀번호 재설정은 없습니다. 공용 PC에서는 쓰고 나서 로그아웃하세요.'),form);}
    // The password and invitation leave their fields before anything else happens, whatever the outcome; only the register body carries the code.
    // Focus lost to the re-render goes to the field to fix, or to the status line once signed in.
    async function authenticate(mode,user,pass,display,invite){if(busy.auth)return;const username=user.value.trim(),password=pass.value,displayName=display.value.trim(),inviteCode=invite.value.trim();pass.value='';invite.value='';lastUser=username;let retry='pass';
      try{if(!USERNAME.test(username)){retry='user';throw local('사용자 이름은 영문·숫자·_·- 3–32자입니다.');}const n=[...password].length;if(n<12||n>128)throw local('비밀번호는 12–128자입니다.');
        if(mode==='register'&&!INVITE.test(inviteCode)){retry='invite';throw local(inviteCode?'초대 코드 형식이 맞지 않습니다. 운영자에게 받은 fsi_로 시작하는 코드를 그대로 붙여 넣으세요. 입력한 코드는 지웠습니다.':'가입하려면 운영자에게 받은 초대 코드가 필요합니다.');}
        busy.auth=true;say(mode==='register'?'가입하는 중…':'로그인하는 중…');
        adopt(await api('POST','/v1/auth/'+mode,{body:mode==='register'?{username,password,inviteCode,...(displayName?{displayName}:{})}:{username,password}}));retry=null;
        say((mode==='register'?'가입했습니다. ':'')+str(session.author.displayName,80)+'(으)로 로그인했습니다. 공유 기록은 불러오기를 눌러 읽습니다. 로컬 기록은 자동으로 올리지 않습니다.');}
      catch(e){if(mode==='register'&&e?.status===403)retry='invite';say(explain(e,mode),true);}
      finally{busy.auth=false;const a=document.activeElement,lost=!a||a===document.body||accountBody.contains(a);renderAccount();setBusy();renderList();if(lost)(retry?fields?.[retry]:status)?.focus?.();}}
    async function logout(){if(busy.auth||!session)return;busy.auth=true;renderAccount();say('로그아웃하는 중…');
      try{await api('POST','/v1/logout',{auth:true});forget();say('로그아웃했습니다. 서버 세션을 끝내고 이 브라우저의 토큰과 불러온 서버 기록을 지웠습니다. 로컬 기록은 그대로입니다.');}
      catch(e){if(!session){expired=false;say('세션이 이미 끝나 있어 이 브라우저의 토큰만 지웠습니다.');}else say(explain(e,'write')+' 서버 세션이 남아 있을 수 있습니다. 필요하면 "이 브라우저에서만 지우기"를 쓰세요.',true);}
      finally{busy.auth=false;const a=document.activeElement,lost=!a||a===document.body||accountBody.contains(a);renderAccount();setBusy();renderList();if(lost)status.focus?.();}}
    // Passwords stay in the request body only. Fields are cleared before validation and before the request.
    // A wrong current password is 401 while the server session remains, so this call keeps the local token.
    // Success revokes every session of this author; the panel then drops the token and does not log in again.
    async function changePassword(current,next,confirm){if(busy.auth||!session)return;const currentPassword=current.value,newPassword=next.value,again=confirm.value;current.value=next.value=confirm.value='';let retry=null;
      try{if([...currentPassword].length<1){retry='current';throw local('현재 비밀번호를 입력하세요. 입력란은 비웠습니다.');}const n=[...newPassword].length;if(n<12||n>128){retry='next';throw local('새 비밀번호는 12–128자입니다. 입력란은 비웠고 서버에는 보내지 않았습니다.');}if(newPassword!==again){retry='confirm';throw local('새 비밀번호 확인이 일치하지 않습니다. 입력란은 비웠고 서버에는 보내지 않았습니다.');}
        busy.auth=true;say('비밀번호를 바꾸는 중…');
        const data=await api('POST','/v1/auth/password',{auth:true,sessionPolicy:'keep',body:{currentPassword,newPassword}});
        if(!data||data.changed!==true)throw local('서버가 비밀번호 변경을 확인하지 않았습니다. 입력은 지웠고 저장하지 않았습니다.');
        forget();expired=true;account.open=true;say('비밀번호를 바꿨습니다. 이 계정의 서버 세션을 모두 끝내고 이 브라우저의 토큰과 불러온 서버 기록을 지웠습니다. 새 비밀번호로 다시 로그인하세요. 비밀번호는 저장하지 않았습니다. 로컬 기록은 그대로입니다.');}
      catch(e){if(session)say(explain(e,'password'),true);else{expired=true;account.open=true;say('세션이 끝나 비밀번호를 바꾸지 못했습니다. 이 브라우저의 토큰을 지웠습니다. 다시 로그인하세요. 비밀번호는 저장하지 않았습니다. 로컬 기록은 그대로입니다.',true);}}
      finally{busy.auth=false;const a=document.activeElement,lost=!a||a===document.body||accountBody.contains(a);renderAccount();setBusy();renderList();if(lost)(retry&&session?passwordFields?.[retry]:status)?.focus?.();}}
    // The first button only reveals confirmation. The request is sent after that second, explicit action.
    async function revokeAllSessions(){if(busy.auth||!session||!confirmingRevoke)return;confirmingRevoke=false;busy.auth=true;renderAccount();say('모든 세션을 끝내는 중…');
      try{const data=await api('POST','/v1/auth/sessions/revoke',{auth:true});if(!data||data.revoked!==true)throw local('서버가 세션 종료를 확인하지 않았습니다.');
        forget();expired=true;account.open=true;say('이 계정의 서버 세션을 모두 끝내고 이 브라우저의 토큰과 불러온 서버 기록을 지웠습니다. 다른 계정의 세션과 기록은 바꾸지 않았습니다. 로컬 기록은 그대로입니다.');}
      catch(e){if(session)say(explain(e,'revoke'),true);else{expired=true;account.open=true;say('세션이 이미 끝나 이 브라우저의 토큰을 지웠습니다. 로컬 기록은 그대로입니다.');}}
      finally{busy.auth=false;const a=document.activeElement,lost=!a||a===document.body||accountBody.contains(a);renderAccount();setBusy();renderList();if(lost)status.focus?.();}}

    async function readSnapshot(){
      try{if(typeof lab?.cloudSnapshot!=='function')throw local('이 작업대는 로컬 기록 읽기를 지원하지 않습니다.');const s=await lab.cloudSnapshot();if(!s||!['harnesses','runs','reviews'].every(k=>Array.isArray(s[k])))throw local('로컬 기록 형식이 맞지 않습니다.');
        snapshot=s;fillItems();upSay('로컬 Harness '+s.harnesses.length+'개 · 실행 '+s.runs.length+'건 · 검수 '+s.reviews.length+'건을 읽었습니다. 아직 아무것도 보내지 않았습니다.');}
      catch(e){upSay(e?.code==='local'?e.message:'로컬 기록을 읽지 못했습니다: '+str(e?.message,200),true);}}
    function itemLabel(k,x){if(k==='harness')return str(x.config?.name,80)+' · '+str(x.config?.role,10).toUpperCase()+' · v'+str(x.config?.version,40)+' · '+short(x.hash);
      if(k==='run')return str(x.role,10).toUpperCase()+' · '+str(x.model,60)+' · '+str(x.createdAt,16)+' · '+str(x.provenance,40);return (VERDICTS[x.verdict]||str(x.verdict,20))+' · '+str(x.caseLabel,60)+' · '+str(x.createdAt,16);}
    function fillItems(){const k=upKind.value,items=snapshot?.[COLLECTION[k]]||[];upRvProtocol.checked=false;
      upItem.replaceChildren(el('option',{value:''},!snapshot?'먼저 로컬 기록 읽기를 누르세요':items.length?'기록 선택':'이 종류의 로컬 기록 없음'),...items.map((x,i)=>[x,i]).reverse().map(([x,i])=>el('option',{value:String(i)},itemLabel(k,x))));upItem.value='';rebuildUpload();}
    async function validate(c,k,payload){const v=await c.validatePayload(k,payload);if(v&&typeof v==='object'&&(v.ok===false||Array.isArray(v.errors)&&v.errors.length))throw local('올리기 전 검증 실패: '+(Array.isArray(v.errors)?v.errors.slice(0,5).map(x=>str(x,120)).join(', '):'형식 오류'));}
    // Every change rebuilds the exact body and clears consent, so consent always refers to the preview on screen.
    async function rebuildUpload(){const seq=++uploadSeq,k=upKind.value,vis=upVis.value==='shared'?'shared':'private';upload.body=null;upConsent.checked=false;upPreview.textContent='';
      runFields.hidden=k!=='run';reviewFields.hidden=k!=='review';upRvCond.textContent='';upEvidence.disabled=k!=='run'||vis!=='private';if(upEvidence.disabled)upEvidence.checked=false;
      upConsentText.textContent='위 내용 그대로 '+hostName+'에 '+(vis==='shared'?'로그인한 팀 멤버 모두가 읽는 공유':'나만 보는 비공개')+' 기록으로 올리는 데 동의합니다.';refreshSend();
      const item=upItem.value===''?null:snapshot?.[COLLECTION[k]]?.[Number(upItem.value)];if(!item)return;
      try{const c=await core();let payload;
        if(k==='harness')payload={config:clone(item.config),hash:item.hash};
        else if(k==='run'){const caseLabel=upCase.value.trim(),protocolVersion=upProtocol.value.trim();
          payload=clone(await c.runFromLocal(clone(item),{includeEvidence:upEvidence.checked,...(caseLabel?{caseLabel}:{}),...(protocolVersion?{protocolVersion}:{})}));if(!upEvidence.checked)delete payload.evidence;else if(!payload.evidence)throw local('이 실행 기록에는 포함할 증거가 없습니다. 체크를 해제하세요.');}
        else{const cloudRun=[...seen.values()].filter(r=>r.kind==='run'&&ownedBy(r)&&(r.payload.localId??localIds.get(r.id))===item.runId).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
          if(!cloudRun)throw local('이 검수가 가리키는 실행 기록을 먼저 올리세요. 다른 곳에서 올렸다면 내 기록에서 그 실행의 "기록 JSON 다운로드"로 전체 기록을 받은 뒤 다시 고르세요.');
          const rp=cloudRun.payload,protocol=typeof rp.protocolVersion==='string'&&rp.protocolVersion?rp.protocolVersion:null,prior=myLatestReview(cloudRun.id),options={};if(seq!==uploadSeq)return;
          upRvProtocol.disabled=!protocol;if(!protocol)upRvProtocol.checked=false;upRvProtocolText.textContent=protocol?'이 검수를 대상 실행과 같은 프로토콜('+str(protocol,80)+')로 했음을 확인합니다':'대상 실행에 프로토콜이 없어 확인할 수 없습니다';
          if(upRvProtocol.checked)options.protocolVersion=protocol;if(prior)options.supersedes=prior.id;
          upRvCond.textContent='대상 실행: 사례 '+str(rp.caseLabel,160)+' · 프로토콜 '+str(protocol,80)+'. 이 검수: 사례 '+str(item.caseLabel,160)+' · 프로토콜 '+(options.protocolVersion?str(options.protocolVersion,80):'미상')+'.'+(options.protocolVersion&&item.caseLabel===rp.caseLabel?'':' 사례나 프로토콜이 없거나 다르면 같은 조건 비교의 검수 수·평균에서 빠집니다.');
          payload=clone(await c.reviewFromLocal(clone(item),cloudRun.id,options));}
        await validate(c,k,payload);const body={kind:k,visibility:vis,payload};
        if(new TextEncoder().encode(JSON.stringify(body)).length>MAX_BODY)throw local('보낼 내용이 256KiB를 넘습니다. 증거를 빼거나 다른 기록을 고르세요.');
        if(seq!==uploadSeq)return;upload.body=body;upPreview.textContent=JSON.stringify(body,null,2);upSay('');}
      catch(e){if(seq===uploadSeq)upSay(e?.code==='local'?e.message:'올리기 전 검증 실패: '+str(e?.message,200),true);}
      finally{if(seq===uploadSeq)refreshSend();}}
    function refreshSend(){uploadGate.hidden=!!session;uploadForm.hidden=!session;upConsent.disabled=!upload.body||busy.upload;upSend.disabled=!session||busy.upload||!upload.body||!upConsent.checked;}
    // A write answered after sign-out is reported but not kept: the purged screen stays empty.
    function adoptRecord(rec,era){if(!live(era))return;seen.set(rec.id,rec);if(ownedBy(rec)&&rec.kind==='run'&&typeof rec.payload.localId==='string')localIds.set(rec.id,rec.payload.localId);if((scope==='mine'||rec.visibility==='shared')&&(!kind||kind===rec.kind))shown=[rec,...shown.filter(x=>x.id!==rec.id)];renderList();}
    // Writes are sent once; a failure or timeout keeps the form and asks the user to check before sending again.
    async function sendUpload(){const body=upload.body;if(!body||!upConsent.checked||busy.upload||!session)return;
      if(body.visibility!=='private'&&'evidence' in body.payload){upSay('증거는 공유 기록에 넣을 수 없습니다.',true);return;}
      busy.upload=true;upConsent.checked=false;refreshSend();upSay('올리는 중…');
      try{const era=epoch,data=await api('POST','/v1/records',{auth:true,body});if(!validRecord(data.record))throw local('서버 응답 형식이 맞지 않습니다. 내 기록을 다시 불러와 확인하세요.');adoptRecord(data.record,era);
        const visibility=data.record.visibility==='shared'?'공유':'비공개';
        upSay(visibility+' 기록으로 올렸습니다 (서버 ID '+short(data.record.id)+'). '+(data.record.visibility!==body.visibility?'같은 내용이 이미 '+visibility+'로 저장돼 있습니다. 내 기록에서 공개 범위를 바꾸세요. ':'')+'로컬 기록은 바뀌지 않았습니다.');}
      catch(e){upSay(explain(e,'write')+' 고른 기록과 보낼 내용은 그대로 둡니다.',true);}
      finally{busy.upload=false;refreshSend();}}

    // The review is bound to the run's case label and protocol; an author may judge their own run, labelled as self-assessment, never as independent.
    function openReview(r){reviewTarget=r;const p=r.payload,self=ownedBy(r),prior=myLatestReview(r.id),hasCase=typeof p.caseLabel==='string'&&!!p.caseLabel,hasProtocol=typeof p.protocolVersion==='string'&&!!p.protocolVersion;
      rvVerdict.value='';rvScore.value='';rvNote.value='';rvCase.value=hasCase?p.caseLabel:'';rvCase.disabled=hasCase;rvVisShared.disabled=r.visibility!=='shared';rvVis.value='private';rvSay('');
      rvTitle.textContent=self?'내 실행 자체 평가 쓰기':'공유 실행 검수 쓰기';
      rvIntro.textContent=(self?'내가 올린 실행을 내가 판단한 자체 평가입니다. 독립 검수가 아니며 비교표의 검수 수에도 작성자 본인 판단으로 더해집니다. ':'내가 직접 판단한 평가만 적습니다. ')+'모델을 자동으로 부르지 않으며, 다른 기록을 고치지 않고 새 기록으로 더합니다. 판단 불가는 점수 없이 기록합니다.';
      rvCond.textContent=hasCase&&hasProtocol?'이 검수는 대상 실행의 사례 라벨과 프로토콜에 묶여 같은 조건 비교에 들어갑니다.':'대상 실행에 '+(hasCase?'프로토콜':hasProtocol?'사례 라벨':'사례 라벨과 프로토콜')+'이 없어 이 검수는 같은 조건 비교의 검수 수·평균에서 빠집니다.'+(hasCase?'':' 사례 라벨은 직접 적어야 올릴 수 있습니다.');
      rvTarget.replaceChildren(el('dt',{},'대상 실행'),el('dd',{},str(p.role,10).toUpperCase()+' · '+str(p.model,120)+' · '+(STATUSES[p.status]||str(p.status,20))),el('dt',{},'작성자'),el('dd',{},self?'나 · 자체 평가':str(r.owner.displayName,80)+' · 자기 보고 이름'),el('dt',{},'조건'),el('dd',{},'사례 '+str(p.caseLabel,160)+' · 프로토콜 '+str(p.protocolVersion,80)),
        ...(prior?[el('dt',{},'내 이전 검수'),el('dd',{},short(prior.id)+'를 대체하는 새 기록으로 더합니다. 이전 검수는 지우지 않습니다.')]:[]));
      reviewBox.hidden=false;rebuildReview();rvVerdict.focus?.();}
    function closeReview(){reviewSeq++;reviewTarget=null;review.body=null;rvPreview.textContent='';rvConsent.checked=false;reviewBox.hidden=true;}
    function myLatestReview(runId){return [...seen.values()].filter(x=>x.kind==='review'&&!!session&&x.owner.id===session.author.id&&x.payload.runId===runId).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).at(-1)||null;}
    async function rebuildReview(){const seq=++reviewSeq,t=reviewTarget,verdict=rvVerdict.value,vis=rvVis.value==='shared'&&!rvVisShared.disabled?'shared':'private';review.body=null;rvConsent.checked=false;rvPreview.textContent='';
      rvScore.disabled=verdict==='uncertain';if(rvScore.disabled)rvScore.value='';
      rvConsentText.textContent='위 검수 그대로 '+hostName+'에 '+(vis==='shared'?'로그인한 팀 멤버 모두가 읽는 공유':'나만 보는 비공개')+' 기록으로 올리는 데 동의합니다.';refreshReview();
      if(!t||!Object.hasOwn(VERDICTS,verdict))return;const note=rvNote.value.trim(),caseLabel=rvCase.disabled?t.payload.caseLabel:rvCase.value.trim();if(!note||!caseLabel){rvSay('판정 근거와 사례 라벨을 적으면 보낼 내용이 만들어집니다.');return;}
      const p=t.payload,payload={runId:t.id,verdict,score:verdict==='uncertain'||!rvScore.value?null:Number(rvScore.value),note,caseLabel};
      if(typeof p.protocolVersion==='string')payload.protocolVersion=p.protocolVersion;const prior=myLatestReview(t.id);if(prior)payload.supersedes=prior.id;
      try{const c=await core();await validate(c,'review',payload);if(seq!==reviewSeq)return;review.body={kind:'review',visibility:vis,payload};rvPreview.textContent=JSON.stringify(review.body,null,2);rvSay('');}
      catch(e){if(seq===reviewSeq)rvSay(e?.code==='local'?e.message:'올리기 전 검증 실패: '+str(e?.message,200),true);}
      finally{if(seq===reviewSeq)refreshReview();}}
    function refreshReview(){if(!session&&!reviewBox.hidden)closeReview();rvConsent.disabled=!review.body||busy.review;rvSend.disabled=!session||busy.review||!review.body||!rvConsent.checked;}
    async function sendReview(){const body=review.body;if(!body||!rvConsent.checked||busy.review||!session)return;busy.review=true;rvConsent.checked=false;refreshReview();rvSay('올리는 중…');
      try{const era=epoch,data=await api('POST','/v1/records',{auth:true,body});if(!validRecord(data.record))throw local('서버 응답 형식이 맞지 않습니다. 내 기록을 다시 불러와 확인하세요.');adoptRecord(data.record,era);
        rvSay((body.visibility==='shared'?'공유':'비공개')+' 검수로 올렸습니다 (서버 ID '+short(data.record.id)+'). 다시 쓰면 새 기록으로 더해집니다.');review.body=null;rvPreview.textContent='';rvNote.value='';}
      catch(e){rvSay(explain(e,'write')+' 쓴 내용은 그대로 둡니다.',true);}
      finally{busy.review=false;refreshReview();}}

    async function compare(){try{const c=await core();renderComparison(await c.compareRecords([...seen.values()].map(clone)));}catch(e){compareOut.replaceChildren(el('p',{className:'error'},e?.code==='local'?e.message:'비교를 만들지 못했습니다: '+str(e?.message,200)));}}
    // The core groups identical conditions; this draws its groups in the core's (hash) order, never ranked.
    function renderComparison(result){const groups=Array.isArray(result?.groups)?result.groups:[],warnings=Array.isArray(result?.warnings)?result.warnings:[],names=new Map([...seen.values()].filter(r=>r.kind==='harness').map(r=>[r.payload.hash,r.payload.config]));
      const out=[el('p',{className:'muted'},'불러온 기록 '+seen.size+'건 기준 · 같은 조건 묶음 '+groups.length+'개 · 행 순서는 해시 순이며 순위가 아닙니다.')];
      for(const [i,g] of groups.slice(0,50).entries()){const c=g?.conditions||{},rows=Array.isArray(g?.harnesses)?g.harnesses.slice(0,100):[];
        const cells=rows.map(h=>{const cfg=names.get(h.hash);return [(cfg?str(cfg.name,80)+' v'+str(cfg.version,40)+' · ':'')+short(h.hash)+(h.harnessAvailable?'':' · 정의 없음'),ORIGINS[h.origin]||str(h.origin,20),str(h.runCount),Object.entries(h.statuses||{}).filter(([,n])=>n).map(([k,n])=>(STATUSES[k]||str(k,20))+' '+n).join(' · ')||'-',
          str(h.calls)+(h.callsUnknown?' · 미상 '+h.callsUnknown+'건':''),str(h.reviewCount)+'건 · 검수자 '+str(h.reviewerCount)+'명',str(h.uncertainCount),typeof h.scoreMean==='number'?h.scoreMean.toFixed(2)+' / 5 (n='+h.scoreCount+')':h.scoreCount?'미표시 · 로컬 broker 실행 아님':'미평가'];});
        out.push(el('div',{className:'ledger-table-wrap',tabIndex:0,role:'region','aria-label':'조건 '+(i+1)+' 비교'},el('table',{className:'ledger-table'},
          el('caption',{},'조건 '+(i+1)+' · '+str(c.role,10).toUpperCase()+' · 모델 '+str(c.model,120)+' · 난이도 '+str(c.level)+' · 예산 '+str(c.maxCalls)+' · 프로토콜 '+str(c.protocolVersion,80)+' · 사례 '+str(c.caseLabel,160)+' · 입력 '+short(c.sourceHash)),
          el('thead',{},el('tr',{},...['Harness','출처(보고)','실행','결과','호출','검수','판단 불가','품질 평균'].map(h=>el('th',{scope:'col'},h)))),el('tbody',{},...cells.map(row=>el('tr',{},...row.map(v=>el('td',{},v))))))));}
      for(const w of warnings.slice(0,20))out.push(el('p',{className:'cloud-warning'},'주의: '+(WARNINGS[w?.code]||'기타 주의 사항이 있습니다.')+(Array.isArray(w?.recordIds)&&w.recordIds.length?' ('+w.recordIds.length+'건)':'')));
      compareOut.replaceChildren(...out);}

    tabShared.addEventListener('click',()=>choose('shared'));tabMine.addEventListener('click',()=>choose('mine'));
    kindSelect.addEventListener('change',()=>{kind=Object.hasOwn(KINDS,kindSelect.value)?kindSelect.value:'';shown=[];cursor=null;loaded=false;load(false);});
    refresh.addEventListener('click',()=>load(false));more.addEventListener('click',()=>load(true));
    upKind.addEventListener('change',fillItems);upItem.addEventListener('change',()=>{upRvProtocol.checked=false;rebuildUpload();});for(const e of [upVis,upEvidence,upRvProtocol])e.addEventListener('change',rebuildUpload);for(const e of [upCase,upProtocol])e.addEventListener('input',rebuildUpload);upConsent.addEventListener('change',refreshSend);upSend.addEventListener('click',sendUpload);
    for(const e of [rvVerdict,rvScore,rvVis])e.addEventListener('change',rebuildReview);for(const e of [rvNote,rvCase])e.addEventListener('input',rebuildReview);rvConsent.addEventListener('change',refreshReview);rvSend.addEventListener('click',sendReview);
    session=loadSession();connection.textContent='서버 '+hostName+' · 아직 불러오지 않음';
    renderAccount();if(expired)account.open=true;renderList();fillItems();setBusy();
    return {root,enabled:true,refresh:()=>load(false)};
  }

  let mounted=null;
  function mount(target,deps={}){if(mounted)return mounted;const host=typeof target==='string'?document.querySelector(target):target||document.querySelector('#view-results');if(!host)throw Error('공유 기록을 붙일 #view-results가 없습니다.');mounted=create(host,deps);return mounted;}
  // Mounts after the local ledger so its results stay first in #view-results.
  const ready=(async()=>{if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));try{await globalThis.FalsifyLab?.ready;}catch{}return document.querySelector('#view-results')?mount():null;})();
  ready.catch(()=>{});
  globalThis.FalsifyCloudRecords={ready,mount};
})();

/* Falsify Confluence is the only remote archive. Local ledger backup/import stays on #ledger-board.
   The session cache is an opaque AES-GCM envelope, separate from falsify.experiment-ledger.v1.
   No Workbench password, API token, private/shared switch, or whole-ledger upload. */
(function(){
  'use strict';
  const SESSION_KEY='falsify.confluence-session.v1',CACHE_KEY='falsify.confluence-cache-key.v1',AUTH_MS=15000,READ_MS=30000,PUBLISH_MS=90000,TEMP_MS=12*60*60*1000,MAX_BYTES=6*1024*1024,MAX_CHARS=4500000;
  const EXPECTED_SITE='https://falsify.atlassian.net',EXPECTED_SPACE='Falsify',EXPECTED_ID='65737';
  const AUTH_HOSTS=new Set(['auth.atlassian.com','login.atlassian.com','falsify.atlassian.net']);
  const SESSION_HEADER='x-falsify-confluence-session',EXPIRES_HEADER='x-falsify-confluence-session-expires';
  const PAGE_ID=/^[A-Za-z0-9_-]{1,128}$/,CURSOR=/^[A-Za-z0-9_-]{1,2048}$/;
  const local=message=>Object.assign(Error(message),{code:'local'});
  const clone=x=>JSON.parse(JSON.stringify(x));
  const script=document.currentScript;

  function el(tag,props,...kids){
    const e=document.createElement(tag);
    for(const [k,v] of Object.entries(props||{})){
      if(v===undefined||v===null) continue;
      if(k==='dataset') Object.assign(e.dataset,v);
      else if(k==='className') e.className=v;
      else if(k==='textContent') e.textContent=v;
      else if(k==='checked'||k==='disabled'||k==='hidden'||k==='value'||k==='id'||k==='type') e[k]=v;
      else e.setAttribute(k, String(v));
    }
    for(const kid of kids) if(kid!==null&&kid!==undefined&&kid!==false) e.append(kid);
    return e;
  }
  function bytesToB64(bytes){let s=''; for(const b of bytes) s+=String.fromCharCode(b); return btoa(s);}
  function b64ToBytes(text){const s=atob(text), out=new Uint8Array(s.length); for(let i=0;i<s.length;i++) out[i]=s.charCodeAt(i); return out;}
  function base64url(bytes){return bytesToB64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function newNonce(){const b=new Uint8Array(32); crypto.getRandomValues(b); return base64url(b);}
  function safeErrorCode(text){try{const data=JSON.parse(text); const code=data&&data.error&&data.error.code; return typeof code==='string'&&/^[a-z0-9_]{1,64}$/.test(code)?code:'';}catch{return '';}}
  function failure(e,phase){
    if(e?.code==='local') return e.message;
    if(e?.code==='timeout'||e?.code==='network'){
      const kind=e.phase||phase;
      if(kind==='write') return '서버 응답을 확인하지 못했습니다. 팀 공간에 올라갔는지 알 수 없어 자동으로 다시 보내지 않습니다. 팀 기록 불러오기로 읽어 확인하세요. 로컬 기록은 그대로입니다.';
      if(kind==='refresh') return '연결 갱신 응답을 확인하지 못했습니다. 보관은 보내지 않았고 자동으로 다시 시도하지 않습니다. 로컬 기록은 그대로입니다.';
      return 'Confluence 게이트웨이 응답을 확인하지 못했습니다. 자동으로 다시 시도하지 않습니다. 로컬 기록은 그대로입니다.';
    }
    const s=e?.status, code=e?.errorCode;
    if(code==='write_unknown') return '팀 보관이 저장되었는지 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. Confluence의 Workbench 실험 기록에서 먼저 확인하세요. 로컬 기록은 그대로입니다.';
    if(code==='write_partial') return '팀 보관을 끝내지 못해 미완성 상태일 수 있습니다. 자동으로 다시 보내지 않습니다. Confluence의 Workbench 실험 기록에서 먼저 확인하세요. 로컬 기록은 그대로입니다.';
    if(s===401) return '세션이 끝났습니다. Confluence에 다시 연결하세요. 로컬 기록은 그대로입니다.';
    if(s===403) return '이 Atlassian 계정으로는 Falsify 팀 보관을 쓸 권한이 없습니다. 운영자에게 공간 권한을 확인하세요. 로컬 기록은 그대로입니다.';
    if(s===404) return '보관을 찾지 못했습니다. 팀 목록을 다시 불러오세요. 로컬 기록은 그대로입니다.';
    if(s===409||code==='conflict') return '같은 보관이 충돌했습니다. 덮어쓰지 않았고 자동으로 다시 보내지 않습니다. 팀 기록 불러오기로 확인하세요. 로컬 기록은 그대로입니다.';
    if(s===410) return '이전 계정 보관은 더 이상 쓰지 않습니다. Confluence 팀 보관만 사용합니다. 로컬 기록은 그대로입니다.';
    if(s===413||code==='payload_too_large') return '보관이 서버 크기 한도를 넘습니다. 잘라서 보내지 않았습니다. 로컬 기록은 그대로입니다.';
    if(s===429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요. 자동으로 다시 보내지 않습니다.';
    if(code==='parent_restricted'||code==='wrong_parent'||code==='wrong_space'||code==='wrong_site') return '팀 보관 부모 페이지나 공간이 허용된 Falsify 위치가 아닙니다. 운영자 설정이 필요합니다. 다른 곳에 올리지 않았습니다.';
    if(code==='partial_archive'||code==='incomplete'||code==='unconfigured') return code==='unconfigured'?'운영자가 Atlassian OAuth 연결을 마쳐야 팀 보관을 쓸 수 있습니다. 이 브라우저는 로컬 기록만 사용합니다.':'미완성 보관입니다. 성공으로 보지 않으며 자동으로 다시 보내지 않습니다. 팀 기록 불러오기로 확인하세요.';
    if(s>=500) return '게이트웨이 오류입니다. 자동으로 다시 보내지 않습니다. 로컬 기록은 그대로입니다.';
    return '게이트웨이 응답을 해석하지 못했습니다. 자동으로 다시 시도하지 않습니다. 로컬 기록은 그대로입니다.';
  }
  function parseBase(value){
    if(typeof value!=='string'||!value) return '';
    try{const u=new URL(value); if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash) return ''; return u.origin+u.pathname.replace(/\/+$/,'');}catch{return '';}
  }
  function checkAuthorizeUrl(value){
    let u; try{u=new URL(value);}catch{throw local('게이트웨이의 로그인 주소가 올바르지 않아 창을 열지 않았습니다.');}
    if(u.protocol!=='https:'||u.username||u.password||!AUTH_HOSTS.has(u.hostname)) throw local('로그인 주소가 Atlassian Falsify 연결이 아니어서 창을 열지 않았습니다.');
    return u.href;
  }
  function allowedPageUrl(value){
    let u; try{u=new URL(value);}catch{return '';}
    if(u.protocol!=='https:'||u.username||u.password||u.hostname!=='falsify.atlassian.net') return '';
    return u.href;
  }

  function create(deps){
    const cfg=deps.config??globalThis.FalsifyCloudConfig??{}, storage=deps.storage??globalThis.localStorage, fetcher=deps.fetch??globalThis.fetch?.bind(globalThis);
    const lab=deps.lab??globalThis.FalsifyLab, win=deps.window??globalThis.window, loc=deps.location??globalThis.location;
    const base=parseBase(cfg.apiBase), gatewayOrigin=base?new URL(base).origin:'';
    const misconfigured=cfg.provider!=='confluence'||!base;
    const state={session:null,stamp:0,pending:null,inflight:null,temp:null,caps:null,busy:false,expiring:false,expiryFailed:false,cacheDeadline:0,cursor:null,items:[],harnessTarget:null,browseAfterAuth:false,banner:{text:'',error:false}};
    const CACHE_FAILURE='이 브라우저에 연결 정보를 저장하지 못했습니다. 연결되었다고 보지 않습니다. 브라우저 저장 공간을 확인한 뒤 다시 연결하세요. 로컬 기록은 그대로입니다.';
    const panels=[];
    let harnessPick=null,teamTimer=0,targetEpoch=0;

    function teamExpired(){return !state.expiryFailed&&!!(state.cacheDeadline&&Date.now()>=state.cacheDeadline||state.temp&&Date.now()>=state.temp.expiresAt);}
    function armTeamTimer(){
      state.expiryFailed=false;
      if(!state.cacheDeadline) state.cacheDeadline=Date.now()+TEMP_MS;
      if(teamTimer) clearTimeout(teamTimer);
      const deadline=Math.min(state.cacheDeadline,state.temp?.expiresAt||Infinity);
      teamTimer=setTimeout(()=>{teamTimer=0; if(teamExpired()) void expireTemp(); else armTeamTimer();},Math.max(0,deadline-Date.now()));
      if(teamTimer&&typeof teamTimer.unref==='function') teamTimer.unref();
    }

    function say(text,error=false){state.banner={text,error}; for(const p of panels){p.status.textContent=text; p.status.classList.toggle('error',!!error);}}
    function paint(){
      if(!state.expiring&&teamExpired()) void expireTemp();
      const connected=!!state.session&&Date.parse(state.session.expiresAt)>Date.now();
      const blocked=state.busy||state.expiring;
      for(const p of panels){
        if(p.tempNotice){p.tempNotice.hidden=!state.temp;p.tempNotice.textContent=state.temp?'임시 열람 중 · 새 검수는 팀에 저장한 뒤 닫아주세요. 새로고침·연결 해제·최대 12시간 후 임시 내용이 사라집니다.':'';}
        p.connection.textContent=misconfigured?'팀 보관 설정 필요':connected?'팀 연결됨':'내 브라우저에만 보관 중';
        p.connect.disabled=blocked||misconfigured;
        p.connect.hidden=connected;
        p.disconnect.disabled=!(connected||state.pending||state.inflight);
        p.load.disabled=blocked||misconfigured;
        p.more.hidden=!state.cursor;
        p.more.disabled=blocked||!state.cursor;
        if(p.closeTemp){p.closeTemp.hidden=!state.temp; p.closeTemp.disabled=blocked||!state.temp;}
        const key=consentIdentity(p.mode);
        if(p.prepare)p.prepare.disabled=blocked||misconfigured||!key;
        if(p.target){const selected=document.querySelector('#evaluation-run')?.selectedOptions?.[0];p.target.textContent=p.mode==='harness'?(state.harnessTarget?.name||'선택한 '+(harnessPick?.value==='red'?'RED':'BLUE')+' 도구'):(selected?.textContent||'검수할 기록을 먼저 고르세요.');}
        p.share.disabled=blocked||misconfigured||!connected||!p.consent.checked||!key||key!==p.consentFor;
        p.consent.disabled=blocked||misconfigured||!connected;
      }
    }
    function targetId(mode){
      if(mode==='harness'&&state.harnessTarget)return state.harnessTarget.role+':'+state.harnessTarget.hash;
      if(mode==='harness'){const role=harnessPick&&(harnessPick.value==='red'||harnessPick.value==='blue')?harnessPick.value:'blue'; const node=document.querySelector('#'+role+'-harness'); const hash=node&&typeof node.value==='string'?node.value.trim():''; return /^[a-f0-9]{64}$/.test(hash)?role+':'+hash:'';}
      const node=document.querySelector('#evaluation-run'); const id=node&&typeof node.value==='string'?node.value.trim():''; return id&&id.length<=160?id:'';
    }
    function clearConsent(mode){for(const p of panels) if(p.mode===mode||(mode!=='harness'&&p.mode!=='harness')){p.consent.checked=false; p.consentFor='';}}
    function tempAlive(){return !!(state.temp&&!state.temp.closing&&Date.now()<state.temp.expiresAt);}
    function consentIdentity(mode){
      const id=targetId(mode); if(!id) return '';
      if(!tempAlive()) return id;
      const same=mode==='harness'?state.temp.kind==='harness'&&state.temp.id===id:state.temp.kind==='experiment'&&state.temp.id===id;
      return same?state.temp.pageId+'|'+id:id;
    }
    async function expireTemp(){
      if(state.expiring||!teamExpired()) return;
      state.expiring=true;
      try{
        if(typeof lab?.closeArchive!=='function') throw local('temporary-view-unavailable');
        await lab.closeArchive();
        state.temp=null; clearRemoteView(); clearConsent('review'); clearConsent('harness');
        say('12시간이 지나 임시 열람과 팀 목록을 닫았습니다. Confluence에 있는 팀 보관은 그대로입니다. 로컬 기록은 지우지 않았습니다.');
      }catch{state.expiryFailed=true;clearRemoteView();say('임시 열람 만료 처리에 실패했습니다. 새로고침하여 임시 내용을 지우세요. 자동으로 다시 시도하지 않습니다. 기존 로컬 기록은 그대로입니다.', true);}
      state.expiring=false;
      paint();
    }
    async function cacheKey(){
      const existing=storage.getItem(CACHE_KEY);
      if(existing) return crypto.subtle.importKey('raw', b64ToBytes(existing), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
      const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
      const raw=new Uint8Array(await crypto.subtle.exportKey('raw', key));
      storage.setItem(CACHE_KEY, bytesToB64(raw));
      return crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, false, ['encrypt','decrypt']);
    }
    async function remember(token, expiresAt, stamp){
      if(state.stamp!==stamp||typeof token!=='string'||!(Date.parse(expiresAt)>Date.now())) return false;
      const iv=new Uint8Array(12); crypto.getRandomValues(iv);
      const key=await cacheKey();
      const plain=new TextEncoder().encode(JSON.stringify({session:token,expiresAt}));
      const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, plain));
      if(state.stamp!==stamp) return false;
      storage.setItem(SESSION_KEY, JSON.stringify({v:1,iv:bytesToB64(iv),ct:bytesToB64(ct)}));
      if(state.stamp!==stamp){storage.removeItem(SESSION_KEY); return false;}
      state.session={token,expiresAt};
      return true;
    }
    async function restore(){
      const raw=storage.getItem(SESSION_KEY); if(!raw) return;
      try{
        const packed=JSON.parse(raw); if(!packed||packed.v!==1) throw Error('shape');
        const key=await cacheKey();
        const buf=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(packed.iv)}, key, b64ToBytes(packed.ct));
        const data=JSON.parse(new TextDecoder().decode(buf));
        if(typeof data.session!=='string'||!(Date.parse(data.expiresAt)>Date.now())) throw Error('expired');
        state.session={token:data.session,expiresAt:data.expiresAt};
      }catch{try{storage.removeItem(SESSION_KEY);}catch{} state.session=null;}
      paint();
    }
    function dropSession(){state.session=null; try{storage.removeItem(SESSION_KEY);}catch{} paint();}
    function clearPending(){if(state.pending?.timer) clearInterval(state.pending.timer); state.pending=null;}
    function closePopup(popup){try{if(popup&&popup.closed!==true&&typeof popup.close==='function') popup.close();}catch{}}
    function forgetPopup(popup){
      if(state.pending?.popup===popup) clearPending();
      if(state.inflight===popup) state.inflight=null;
      closePopup(popup);
    }
    function clearRemoteView(){if(teamTimer)clearTimeout(teamTimer);teamTimer=0;state.cacheDeadline=0;state.items=[]; state.cursor=null; state.items.loaded=false; state.caps=null; renderItems();}
    function header(res,name){try{return res.headers&&typeof res.headers.get==='function'?res.headers.get(name):null;}catch{return null;}}
    function budget(method,path){const bare=String(path||'').split('?')[0]; if(bare.startsWith('/v1/confluence/auth/')) return AUTH_MS; if(method==='POST'&&bare==='/v1/confluence/archives') return PUBLISH_MS; return READ_MS;}
    async function api(method,path,{body,auth=false,stamp=state.stamp,phase='read'}={}){
      if(misconfigured||!fetcher) throw local('Confluence 게이트웨이가 설정되지 않았습니다. 로컬 기록은 그대로입니다.');
      if(!path.startsWith('/v1/confluence/')) throw local('허용되지 않은 원격 주소라 요청하지 않았습니다.');
      const headers={accept:'application/json'};
      if(body!==undefined) headers['content-type']='application/json';
      if(auth){if(!state.session) throw local('Confluence에 연결한 뒤 사용하세요.'); headers.authorization='Bearer '+state.session.token;}
      const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(), budget(method,path));
      let res, text='';
      try{res=await fetcher(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:ctl.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',mode:'cors'}); text=await res.text();}
      catch{throw Object.assign(Error('request'),{code:ctl.signal.aborted?'timeout':'network',phase});}
      finally{clearTimeout(timer);}
      const replacement=header(res,SESSION_HEADER);
      if(replacement&&stamp===state.stamp){const exp=header(res,EXPIRES_HEADER)||state.session?.expiresAt; if(exp) await remember(replacement, exp, stamp);}
      if(!res.ok){const errorCode=safeErrorCode(text); if(res.status===401&&stamp===state.stamp) dropSession(); throw Object.assign(Error('http'),{code:'http',status:res.status,errorCode});}
      if(!text) return {};
      try{const data=JSON.parse(text); if(data&&typeof data==='object'&&!Array.isArray(data)) return data;}catch{}
      throw Object.assign(Error('response'),{code:'response',status:res.status});
    }
    async function loadCaps(stamp){
      const data=await api('GET','/v1/confluence/capabilities',{stamp});
      if(stamp!==state.stamp) return null;
      if(data.provider!=='confluence') throw local('이 작업대의 원격 보관은 Confluence뿐입니다. 다른 저장소로는 연결하지 않습니다.');
      const site=typeof data.siteUrl==='string'?data.siteUrl.replace(/\/+$/,''):'';
      if(site!==EXPECTED_SITE||data.spaceKey!==EXPECTED_SPACE||String(data.spaceId)!==EXPECTED_ID) throw local('게이트웨이가 가리키는 사이트나 공간이 Falsify Confluence가 아니어서 연결하지 않았습니다.');
      if(data.configured!==true){state.caps={configured:false,maxArchiveBytes:MAX_BYTES}; return state.caps;}
      let max=MAX_BYTES;
      if(data.maxArchiveBytes!==undefined){if(!Number.isFinite(data.maxArchiveBytes)||data.maxArchiveBytes<1024) throw local('보관 크기 한도가 없어 올리지 않습니다. 운영자 설정이 필요합니다.'); max=Math.min(MAX_BYTES, Math.floor(data.maxArchiveBytes));}
      state.caps={configured:true,maxArchiveBytes:max};
      return state.caps;
    }
    function codec(){
      if(deps.codec) return Promise.resolve(deps.codec);
      if(globalThis.FalsifyReviewBundle) return Promise.resolve(globalThis.FalsifyReviewBundle);
      const codecUrl=new URL('review-bundle.mjs', script?.src||loc.href);
      codecUrl.search=new URL(script?.src||loc.href).search;
      return import(codecUrl.href).catch(()=>{throw local('보관 형식 모듈을 불러오지 못했습니다. 올리지 않았습니다. 로컬 기록은 그대로입니다.');});
    }
    function validators(){return {harness:globalThis.FalsifyHarness, red:globalThis.FalsifyDocumentRed, blue:globalThis.FalsifyDocumentBlue, review:globalThis.FalsifyReview};}
    function release(){state.busy=false; paint();}
    // app.js hash routes: review -> #review, agents -> #harness. The agents view is not #agents.
    function showView(name){
      const hash=name==='review'?'#review':name==='agents'?'#harness':'';
      if(!hash) return;
      try{
        const all=typeof document.querySelectorAll==='function'?document.querySelectorAll('[data-view="'+name+'"]'):[];
        let button=null;
        for(const node of all){
          let visible=false;
          try{visible=typeof node.getClientRects==='function'&&node.getClientRects().length>0;}catch{visible=false;}
          if(visible){button=node; break;}
        }
        if(!button&&all.length) button=all[0];
        if(button&&typeof button.click==='function') button.click();
      }catch{}
      try{if(loc&&loc.hash!==hash) loc.hash=hash;}catch{}
    }
    async function connect(){
      if(state.busy||misconfigured) return;
      state.busy=true; state.stamp++; const previous=state.inflight, pendingPopup=state.pending?.popup; clearPending(); closePopup(previous); if(pendingPopup&&pendingPopup!==previous) closePopup(pendingPopup); const stamp=state.stamp;
      let popup=null;
      try{popup=win.open('about:blank','falsify-confluence-oauth','popup,width=480,height=720');}catch{popup=null;}
      state.inflight=popup; paint();
      if(!popup||popup.closed){forgetPopup(popup); say('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 연결하세요. 세션은 만들지 않았습니다.', true); release(); return;}
      let waiting=false;
      try{
        const caps=await loadCaps(stamp);
        if(stamp!==state.stamp){forgetPopup(popup); return;}
        if(!caps?.configured){forgetPopup(popup); say('운영자가 Atlassian OAuth 연결을 마쳐야 팀 보관을 쓸 수 있습니다. 이 브라우저는 로컬 기록만 사용합니다. 원장은 올리지 않습니다.', true); return;}
        const nonce=newNonce();
        const data=await api('POST','/v1/confluence/auth/start',{body:{nonce,returnOrigin:loc.origin},stamp,phase:'connect'});
        if(stamp!==state.stamp){forgetPopup(popup); return;}
        const url=checkAuthorizeUrl(data.authorizeUrl);
        if(popup.closed) throw local('연결을 취소했습니다. 세션을 만들지 않았습니다. 로컬 기록은 그대로입니다.');
        if(popup.opener==null||popup.opener!==win) throw local('로그인 창이 이 페이지와 연결되어 있지 않아 세션을 받을 수 없습니다. 세션은 만들지 않았습니다.');
        if(!popup.location||typeof popup.location!=='object') throw local('로그인 창으로 이동하지 못했습니다. 세션은 만들지 않았습니다.');
        popup.location.href=url;
        const timer=setInterval(()=>{
          if(state.stamp!==stamp||state.pending?.nonce!==nonce){clearInterval(timer); return;}
          if(popup.closed){clearInterval(timer); if(state.pending?.nonce===nonce){state.pending=null; if(state.inflight===popup) state.inflight=null; release(); say('연결을 취소했습니다. 세션을 만들지 않았습니다. 로컬 기록은 그대로입니다.');}}
        },300);
        state.pending={nonce,popup,stamp,timer}; waiting=true;
        say('Atlassian 로그인 창에서 Falsify 팀 공간 연결을 마치세요. 로컬 원장은 올리지 않습니다.');
      }catch(e){forgetPopup(popup); if(stamp===state.stamp) say(failure(e,'connect'), true);}
      finally{if(!waiting&&stamp===state.stamp) release(); else paint();}
    }
    async function onMessage(event){
      const pending=state.pending; if(!pending) return;
      if(event.origin!==gatewayOrigin||event.source!==pending.popup) return;
      const data=event.data; if(!data||data.type!=='falsify.confluence.session.v1'||data.nonce!==pending.nonce||pending.stamp!==state.stamp) return;
      const stamp=pending.stamp, popup=pending.popup;
      clearPending(); if(state.inflight===popup) state.inflight=null; closePopup(popup);
      try{
        const token=data.session, exp=data.expiresAt;
        if(typeof token!=='string'||token.length<16||token.length>8192||!(Date.parse(exp)>Date.now())){if(stamp===state.stamp) say('로그인 응답이 맞지 않아 세션을 저장하지 않았습니다. 로컬 기록은 그대로입니다.', true); return;}
        let ok=false;
        try{ok=await remember(token, exp, stamp);}
        catch{state.session=null; try{storage.removeItem(SESSION_KEY);}catch{} ok=false;}
        if(stamp!==state.stamp) return;
        if(ok&&state.session) say('Falsify Confluence 팀 공간에 연결했습니다. 고른 기록은 동의 뒤에만 팀 전체에 공유됩니다. 로컬 원장은 올리지 않았습니다.');
        else say(CACHE_FAILURE, true);
      }catch{state.session=null; try{storage.removeItem(SESSION_KEY);}catch{} if(stamp===state.stamp) say(CACHE_FAILURE, true);}
      finally{if(stamp===state.stamp){release();if(state.session&&state.browseAfterAuth){state.browseAfterAuth=false;void loadList(false);}}}
    }
    async function closeTemporary(){
      if(!state.temp||state.busy) return;
      state.busy=true; const stamp=state.stamp; paint();
      try{
        if(typeof lab?.closeArchive!=='function') throw local('이 작업대는 임시 열람 닫기를 지원하지 않습니다. 로컬 기록은 그대로입니다.');
        await lab.closeArchive();
        if(stamp!==state.stamp) return;
        state.temp=null; clearConsent('review'); clearConsent('harness');
        say('임시 열람을 닫았습니다. Confluence의 팀 보관과 이 브라우저의 로컬 기록은 그대로입니다.');
      }catch(e){if(stamp===state.stamp) say(e?.code==='local'?e.message:'임시 열람을 닫지 못했습니다. 로컬 기록은 그대로입니다.', true);}
      finally{if(stamp===state.stamp) release();}
    }
    async function disconnect(){
      const popup=state.inflight, pendingPopup=state.pending?.popup;
      state.stamp++; state.busy=false; clearPending(); closePopup(popup); if(pendingPopup&&pendingPopup!==popup) closePopup(pendingPopup); state.inflight=null;
      state.session=null;state.browseAfterAuth=false;state.harnessTarget=null;targetEpoch++; try{storage.removeItem(SESSION_KEY);}catch{}
      state.temp=null; clearConsent('review'); clearConsent('harness'); clearRemoteView();
      let closeNote='임시 열람을 닫았습니다.';
      if(typeof lab?.closeArchive==='function'){try{await lab.closeArchive();}catch{closeNote='임시 열람을 닫지 못했습니다.';}}
      else closeNote='이 작업대는 임시 열람 닫기를 지원하지 않습니다.';
      say('이 브라우저의 Confluence 연결만 지웠습니다. '+closeNote+' Atlassian에 부여한 권한 전체가 취소된 것은 아닙니다. 로컬 기록은 그대로입니다.', closeNote!=='임시 열람을 닫았습니다.');
      paint();
    }
    async function refreshSession(stamp){
      if(!state.session||!(Date.parse(state.session.expiresAt)>Date.now())){dropSession(); throw local('세션이 끝났습니다. Confluence에 다시 연결하세요. 보관은 보내지 않았습니다. 로컬 기록은 그대로입니다.');}
      let data; try{data=await api('POST','/v1/confluence/auth/refresh',{auth:true,stamp,phase:'refresh'});}catch(e){if(e&&(e.code==='timeout'||e.code==='network')&&!e.phase) e.phase='refresh'; throw e;}
      if(stamp!==state.stamp) return false;
      if(typeof data.session==='string'){const ok=await remember(data.session, data.expiresAt||state.session?.expiresAt, stamp); if(!ok) throw local('갱신된 세션을 저장하지 못했습니다. 보관은 보내지 않았습니다.');}
      if(!state.session) throw local('세션이 끝나 보관하지 않았습니다. 로컬 기록은 그대로입니다.');
      return true;
    }
    async function share(mode){
      if(state.busy||misconfigured) return;
      const id=targetId(mode), panel=panels.find(p=>p.mode===mode);
      if(!state.session){say('먼저 Confluence에 연결하세요. 연결 전에는 아무것도 올리지 않습니다.', true); return;}
      if(!id||!panel||!panel.consent.checked||panel.consentFor!==consentIdentity(mode)){say('Falsify 팀 전체 공개에 동의한 뒤, 지금 고른 기록만 올릴 수 있습니다. 아직 보내지 않았습니다.', true); return;}
      state.busy=true; panel.consent.checked=false; panel.consentFor=''; const stamp=state.stamp; paint();
      try{
        const caps=await loadCaps(stamp); if(stamp!==state.stamp) return;
        if(!caps?.configured){say('운영자가 Atlassian OAuth 연결을 마쳐야 팀 보관을 쓸 수 있습니다. 올리지 않았습니다. 로컬 기록은 그대로입니다.', true); return;}
        await refreshSession(stamp); if(stamp!==state.stamp) return;
        const c=await codec();
        let built;
        if(mode==='harness'){
          if(typeof lab?.cloudSnapshot!=='function') throw local('이 작업대는 로컬 Harness 읽기를 지원하지 않습니다. 올리지 않았습니다.');
          const snapshot=await lab.cloudSnapshot(); if(stamp!==state.stamp) return;
          const role=id.slice(0,id.indexOf(':')), hash=id.slice(role.length+1);
          const record=(snapshot.harnesses||[]).find(h=>h&&h.hash===hash&&h.config&&h.config.role===role);
          if(!record) throw local('선택한 등록 Harness를 로컬 기록에서 찾지 못했습니다. 올리지 않았습니다.');
          if(typeof c.buildHarnessArchive!=='function') throw local('Harness 보관 형식을 만들지 못했습니다. 올리지 않았습니다.');
          built=await c.buildHarnessArchive(clone(record), validators());
        }else{
          if(typeof lab?.reviewSnapshot!=='function') throw local('검수 화면의 임시 기록을 읽지 못해 올리지 않았습니다. 로컬 기록은 그대로입니다.');
          const snapshot=await lab.reviewSnapshot(id); if(stamp!==state.stamp) return;
          if(typeof c.buildExperimentArchive!=='function') throw local('실험 보관 형식을 만들지 못했습니다. 올리지 않았습니다.');
          built=await c.buildExperimentArchive(clone(snapshot), id, validators());
        }
        if(stamp!==state.stamp) return;
        if(typeof c.validateArchive!=='function'||typeof c.archiveHash!=='function') throw local('보관 검증을 마치지 못해 올리지 않았습니다.');
        const archive=await c.validateArchive(built, validators());
        const hash=await c.archiveHash(archive);
        if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)) throw local('보관 해시가 없어 올리지 않았습니다.');
        const body={archive,teamShare:true};
        const archiveChars=JSON.stringify(archive).length, bytes=new TextEncoder().encode(JSON.stringify(body)).length, cap=caps.maxArchiveBytes||MAX_BYTES;
        if(archiveChars>MAX_CHARS) throw local('보관 글자 수가 로컬 기록 한도(450만 자)를 넘습니다. 잘라서 보내지 않았습니다. 로컬 기록은 그대로입니다.');
        if(bytes>cap||bytes>MAX_BYTES) throw local('보관이 UTF-8 크기 한도를 넘습니다. 잘라서 보내지 않았고 자동으로 다시 보내지 않습니다. 로컬 기록은 그대로입니다.');
        if(stamp!==state.stamp) return;
        const data=await api('POST','/v1/confluence/archives',{auth:true,body,stamp,phase:'write'});
        if(stamp!==state.stamp) return;
        if(data.stored!==true||typeof data.pageId!=='string'||!PAGE_ID.test(data.pageId)||data.archiveSha256!==hash) throw local('보관을 마쳤는지 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 팀 기록 불러오기로 읽어 확인하세요. 로컬 기록은 그대로입니다.');
        say((data.alreadyExisted?'같은 보관이 이미 Falsify 팀 공간에 있습니다. 새로 실행하지 않았습니다. ':'Falsify 팀 공간에 JSON 보관을 올렸습니다. ')+'원본 PDF 파일을 저장한 것은 아닙니다. 팀 전원이 읽을 수 있습니다. 로컬 기록은 그대로입니다.');
        if(panel.confirmation){panel.confirmation.open=false;panel.confirmation.hidden=true;}
      }catch(e){if(stamp===state.stamp) say(failure(e,'write'), true);}
      finally{if(stamp===state.stamp) release();}
    }
    async function publishPaperEdit(record, options={}){
      if(!options||options.teamShare!==true) throw local('Falsify 팀 전체 공개에 동의한 수동 편집만 올릴 수 있습니다. 아직 보내지 않았습니다.');
      if(state.busy||state.expiring||misconfigured) throw local('지금은 수동 편집을 보내지 않습니다. 자동으로 다시 보내지 않습니다.');
      if(!state.session) throw local('먼저 Confluence에 연결하세요. 연결 전에는 아무것도 올리지 않습니다.');
      state.busy=true; const stamp=state.stamp; paint();
      try{
        const caps=await loadCaps(stamp); if(stamp!==state.stamp) return {cancelled:true};
        if(!caps?.configured) throw local('운영자가 Atlassian OAuth 연결을 마쳐야 팀 보관을 쓸 수 있습니다. 올리지 않았습니다.');
        await refreshSession(stamp); if(stamp!==state.stamp) return {cancelled:true};
        const c=await codec();
        if(typeof c.buildPaperEditArchive!=='function'||typeof c.validateArchive!=='function'||typeof c.archiveHash!=='function') throw local('수동 편집 보관 형식을 만들지 못했습니다. 올리지 않았습니다.');
        const built=await c.buildPaperEditArchive(clone(record));
        if(stamp!==state.stamp) return {cancelled:true};
        const archive=await c.validateArchive(built, validators());
        const hash=await c.archiveHash(archive);
        if(!archive||archive.kind!=='paper-edit'||archive.schema!=='falsify.confluence-archive.v1'||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)) throw local('수동 편집 보관이 아니어서 올리지 않았습니다.');
        const encoded=JSON.stringify(archive);
        if(encoded.includes('%PDF-')||/"(?:pdf|pdfBytes|sourcePdf|sourcePDF|binary|bytes|contentBase64|gold|harness|attestation)"\s*:/.test(encoded)) throw local('원본 PDF·gold·Harness는 수동 편집 보관에 넣지 않습니다. 올리지 않았습니다.');
        const body={archive,teamShare:true};
        const bytes=new TextEncoder().encode(JSON.stringify(body)).length, cap=caps.maxArchiveBytes||MAX_BYTES;
        if(encoded.length>MAX_CHARS) throw local('보관 글자 수가 로컬 기록 한도(450만 자)를 넘습니다. 잘라서 보내지 않았습니다. 로컬 기록은 그대로입니다.');
        if(bytes>cap||bytes>MAX_BYTES) throw local('보관이 UTF-8 크기 한도를 넘습니다. 잘라서 보내지 않았고 자동으로 다시 보내지 않습니다. 로컬 기록은 그대로입니다.');
        if(stamp!==state.stamp) return {cancelled:true};
        const data=await api('POST','/v1/confluence/archives',{auth:true,body,stamp,phase:'write'});
        if(stamp!==state.stamp) return {cancelled:true};
        if(data.stored!==true||typeof data.pageId!=='string'||!PAGE_ID.test(data.pageId)||data.archiveSha256!==hash) throw local('보관을 마쳤는지 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 팀 기록 불러오기로 읽어 확인하세요. 로컬 기록은 그대로입니다.');
        say((data.alreadyExisted?'같은 수동 편집 보관이 이미 Falsify 팀 공간에 있습니다. ':'수동 편집 JSON을 Falsify 팀 공간에 올렸습니다. ')+'텍스트와 편집만이며 원본 PDF 바이너리는 올리지 않았습니다. 팀 전원이 읽을 수 있습니다. 로컬 AI 기록은 그대로입니다.');
        return {stored:true,pageId:data.pageId,archiveSha256:hash,alreadyExisted:data.alreadyExisted===true};
      }catch(e){if(stamp!==state.stamp) throw local('연결이 바뀌어 수동 편집 보관을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.'); throw e?.code==='local'?e:local(failure(e,'write'));}
      finally{if(stamp===state.stamp) release();}
    }
    function itemView(item){
      const link=allowedPageUrl(item.webUrl);
      const row=el('article',{className:'confluence-item','data-page-id':item.pageId}, el('h3',{textContent:String(item.title||'제목 없음').slice(0,180)}));
      if(link) row.append(el('a',{href:link,target:'_blank',rel:'noopener noreferrer',textContent:'Confluence에서 보기'}));
      else if(item.webUrl) row.append(el('p',{className:'muted',textContent:'페이지 주소가 Falsify 사이트가 아니어서 링크를 숨겼습니다.'}));
      const open=el('button',{type:'button',className:'button secondary',textContent:'열기'});
      const symbol=globalThis.FalsifyVisual?.icon?.('folder-open');if(symbol)open.append(symbol);
      open.addEventListener('click',()=>openArchive(item.pageId));
      row.append(el('div',{className:'button-row'}, open));
      return row;
    }
    function renderItems(){for(const p of panels){p.list.replaceChildren(...(state.items.length?state.items.map(itemView):[el('p',{className:'muted',textContent:state.items.loaded?'팀 서랍이 비어 있습니다.':'팀 기록을 열어보세요.'})]));if(p.drawer){p.drawer.hidden=!state.items.loaded;p.drawer.open=!!state.items.loaded;}}}
    async function loadList(append){
      if(state.busy||misconfigured) return;
      if(!state.session){say('팀 기록을 보려면 먼저 Confluence에 연결하세요. 목록은 업로드하지 않습니다.', true); return;}
      state.busy=true; const stamp=state.stamp; paint(); say('팀 보관 목록을 불러오는 중… 업로드하거나 모델을 실행하지 않습니다.');
      try{
        const caps=await loadCaps(stamp); if(stamp!==state.stamp) return;
        if(!caps?.configured){say('운영자가 Atlassian OAuth 연결을 마쳐야 팀 목록을 볼 수 있습니다. 로컬 기록은 그대로입니다.', true); return;}
        let path='/v1/confluence/archives';
        if(append){if(!state.cursor||!CURSOR.test(state.cursor)) throw local('다음 목록 주소가 허용된 형식이 아니어서 따라가지 않았습니다.'); path+='?cursor='+encodeURIComponent(state.cursor);}
        const data=await api('GET',path,{auth:true,stamp}); if(stamp!==state.stamp) return;
        const raw=Array.isArray(data.items)?data.items:[];
        if(raw.length>100) throw local('목록 한 응답이 100건을 넘습니다. 초과분을 조용히 버리지 않았습니다. 페이지를 나눠 다시 불러오세요.');
        const good=[], skipped=[];
        for(const item of raw){if(item&&typeof item.pageId==='string'&&PAGE_ID.test(item.pageId)&&typeof item.title==='string') good.push({pageId:item.pageId,title:item.title,updatedAt:typeof item.updatedAt==='string'?item.updatedAt:'',webUrl:typeof item.webUrl==='string'?item.webUrl:''}); else skipped.push(item);}
        if(!append) state.items=[];
        for(const item of good){state.items=state.items.filter(x=>x.pageId!==item.pageId); state.items.push(item);}
        state.items.loaded=true;
        armTeamTimer();
        if(typeof data.nextCursor==='string'&&data.nextCursor){if(!CURSOR.test(data.nextCursor)){state.cursor=null; renderItems(); throw local('다음 목록 주소가 허용된 형식이 아니어서 따라가지 않았습니다. 이미 받은 목록은 그대로 둡니다.');} state.cursor=data.nextCursor;} else state.cursor=null;
        renderItems();
        say('팀 기록 '+state.items.length+'개'+(state.cursor?' · 다음 기록도 있습니다.':'')+(skipped.length?' · 형식이 맞지 않는 '+skipped.length+'건 제외':''));
      }catch(e){if(stamp===state.stamp) say(failure(e,'read'), true);}
      finally{if(stamp===state.stamp) release();}
    }
    async function openArchive(pageId){
      if(state.busy) return;
      if(!PAGE_ID.test(pageId||'')){say('페이지 식별자가 맞지 않아 열지 않았습니다.', true); return;}
      if(!state.session){say('보관을 열려면 Confluence에 연결하세요.', true); return;}
      state.busy=true; const stamp=state.stamp; paint(); say('팀 보관 하나를 확인하는 중… 업로드하거나 모델을 실행하지 않습니다.');
      try{
        const data=await api('GET','/v1/confluence/archives/'+encodeURIComponent(pageId),{auth:true,stamp});
        if(stamp!==state.stamp) return;
        const archive=data.archive;
        if(!archive||typeof archive!=='object'||Array.isArray(archive)) throw local('미완성 보관이라 불러오지 않았습니다. 자동으로 다시 시도하지 않습니다. 로컬 기록은 그대로입니다.');
        const c=await codec();
        const hash=await c.archiveHash(archive);
        if(typeof data.archiveSha256!=='string'||data.archiveSha256!==hash) throw local('보관한 내용의 해시가 맞지 않아 이 브라우저에 넣지 않았습니다. 로컬 기록은 그대로입니다.');
        const normalized=await c.validateArchive(archive, validators());
        if(await c.archiveHash(normalized)!==hash) throw local('검증 결과가 해시와 달라 넣지 않았습니다. 로컬 기록은 그대로입니다.');
        if(stamp!==state.stamp) return;
        if(typeof lab?.openArchive!=='function') throw local('이 작업대는 임시 열람을 지원하지 않습니다. 로컬 기록에 넣지 않았습니다.');
        const opened=await lab.openArchive(clone(normalized));
        if(stamp!==state.stamp) return;
        if(normalized.kind==='experiment'){
          if(!opened||opened.kind!=='experiment'||typeof opened.runId!=='string'||!opened.runId) throw local('실험 임시 열람 결과가 아니어서 검수로 열지 않았습니다. 로컬 기록은 그대로입니다.');
          state.temp={pageId,kind:'experiment',id:opened.runId,expiresAt:Date.now()+TEMP_MS};
          armTeamTimer();
          clearConsent('review'); clearConsent('harness');
          showView('review');
          say('팀 보관을 임시 열람으로 열었습니다. 검수 화면으로 이동했습니다. 로컬 기록에 합치지 않았고 모델을 부르지 않았습니다. 보내지 않은 사람 검수는 Confluence에 팀 공유를 누르기 전에는 저장되지 않습니다. JSON이며 원본 PDF가 아닙니다.');
        }else if(normalized.kind==='harness'){
          const config=normalized.data&&normalized.data.config, hashId=normalized.data&&normalized.data.hash;
          const role=config&&(config.role==='red'||config.role==='blue')?config.role:'';
          if(!opened||opened.kind!=='harness'||opened.hash!==hashId) throw local('Harness 임시 열람 결과가 아니어서 열지 않았습니다. 등록하거나 실행하지 않았습니다.');
          state.temp={pageId,kind:'harness',id:role?role+':'+hashId:hashId,expiresAt:Date.now()+TEMP_MS};
          armTeamTimer();
          clearConsent('harness');
          showView('agents');
          say('Harness를 임시 열람으로 열었습니다. Harness 화면으로 이동했습니다. 등록하거나 실행하지 않았고 로컬 기록에 넣지 않았습니다. 원본 PDF가 아닙니다.');
        }else if(normalized.kind==='paper-edit'){
          if(!opened||opened.kind!=='paper-edit'||typeof opened.id!=='string'||!opened.id) throw local('수동 편집 임시 열람 결과가 아니어서 검수로 열지 않았습니다. 로컬 기록은 그대로입니다.');
          state.temp={pageId,kind:'paper-edit',id:opened.id,expiresAt:Date.now()+TEMP_MS};
          armTeamTimer();
          clearConsent('review'); clearConsent('harness');
          showView('review');
          say('수동 편집 보관을 임시 열람으로 열었습니다. 검수 화면으로 이동했습니다. 로컬 AI 기록에 합치지 않았고 모델을 부르지 않았습니다. 텍스트와 편집만이며 원본 PDF 바이너리는 포함되지 않습니다. 12시간이 지나거나 닫으면 이 브라우저의 임시 열람은 사라집니다.');
        }else throw local('알 수 없는 보관 종류입니다. 넣지 않았습니다.');
      }catch(e){if(stamp===state.stamp) say(e?.code==='local'||e?.code==='http'||e?.code==='timeout'||e?.code==='network'||e?.code==='response'?failure(e,'read'):(typeof e?.message==='string'&&e.message&&e.message.length<=300&&!e.message.includes('<')?e.message+' 로컬 기록은 그대로입니다. 자동으로 다시 시도하지 않습니다.':'검수로 열지 못했습니다. 자동으로 다시 시도하지 않습니다. 로컬 기록은 그대로입니다.'), true);}
      finally{if(stamp===state.stamp) release();}
    }

    function mountPanel(host,mode){
      if(!host||host.querySelector('[data-confluence-mode="'+mode+'"]')) return;
      const consent=el('input',{type:'checkbox',id:'confluence-'+mode+'-consent'});
      const consentText=el('span',{textContent:'이 기록을 팀원 모두에게 공개합니다.'});
      const connectBtn=el('button',{type:'button',id:'confluence-'+mode+'-connect',className:'button secondary',textContent:'팀 연결'});
      const disconnectBtn=el('button',{type:'button',id:'confluence-'+mode+'-disconnect',className:'button secondary',textContent:'이 브라우저 연결 끊기'});
      const shareBtn=el('button',{type:'button',id:'confluence-'+mode+'-share',className:'button primary',textContent:'공개하고 저장'});
      const loadBtn=el('button',{type:'button',id:'confluence-'+mode+'-load',className:'button secondary',textContent:'팀 기록'});
      const prepare=el('button',{type:'button',id:'confluence-'+mode+'-prepare',className:'button secondary',textContent:'팀에 저장'});
      const moreBtn=el('button',{type:'button',id:'confluence-'+mode+'-more',className:'button secondary',hidden:true,textContent:'다음 팀 기록'});
      const closeTempBtn=el('button',{type:'button',id:'confluence-'+mode+'-close-temp',className:'button secondary',hidden:true,textContent:'임시 열람 닫기'});
      const connection=el('p',{id:'confluence-'+mode+'-connection',className:'confluence-connection'});
      const status=el('p',{id:'confluence-'+mode+'-status',className:'confluence-status',role:'status'});
      const list=el('div',{id:'confluence-'+mode+'-list',className:'confluence-list'});
      const intro=mode==='harness'?'선택한 등록 Harness 정의만 팀 공간에 올립니다. 실행하거나 자동 등록하지 않습니다.':mode==='results'?'검수 화면에서 고른 실행과 그 사람 검수를 팀 공간에 올립니다. 결과표의 로컬 백업은 그대로입니다.':'지금 고른 실행과 사람 검수를 팀 공간에 올립니다. RED와 BLUE는 있는 쪽만 포함됩니다.';
      const tempNotice=el('p',{className:'confluence-temporary'});
      const target=el('p',{className:'confluence-target'});
      const confirmation=el('details',{className:'confluence-save',hidden:true});
      const cancelSave=el('button',{type:'button',className:'button secondary',textContent:'취소'});
      cancelSave.addEventListener('click',()=>{confirmation.hidden=true;confirmation.open=false;consent.checked=false;panel.consentFor='';paint();});
      confirmation.append(el('summary',{textContent:'저장할 기록'}),target,el('p',{className:'muted',textContent:'Falsify 팀 서랍에 보관합니다. 원본 PDF 파일은 포함되지 않습니다.'}),connectBtn,el('label',{className:'check-row'},consent,consentText),el('div',{className:'button-row'},shareBtn,cancelSave));
      const drawer=el('details',{className:'confluence-drawer'},el('summary',{textContent:'팀 서랍'}),list,moreBtn);
      const settings=el('details',{className:'confluence-settings'},el('summary',{textContent:'연결 · 저장 범위'}));
      settings.append(el('p',{className:'muted',textContent:'보관은 Confluence 팀 전체 공유입니다. '+intro+' JSON에 논문 추출문·모델 원응답·Harness·검수가 포함됩니다. 원본 PDF 파일은 포함되지 않습니다. 불러온 기록은 임시 열람이며 새로고침·닫기·연결 해제 또는 최대 12시간 후 사라집니다. 새 검수는 팀에 저장하기 전에는 원격 보관되지 않습니다. 기존 로컬 기록과 백업은 유지합니다. 연결만으로 업로드하거나 모델을 실행하지 않습니다.'}),el('div',{className:'button-row'},disconnectBtn));
      const kids=[
        el('div',{className:'confluence-toolbar'},el('h3',{id:'confluence-'+mode+'-title',textContent:'팀 서랍'}),el('div',{className:'button-row'},loadBtn,prepare,closeTempBtn)),
        tempNotice,
        connection,
      ];
      if(mode==='harness'){harnessPick=el('select',{id:'confluence-harness-role'}, el('option',{value:'blue',textContent:'BLUE 선택 Harness'}), el('option',{value:'red',textContent:'RED 선택 Harness'})); harnessPick.value='blue';settings.append(el('label',{textContent:'실행 화면의 선택 도구로 되돌리기'},harnessPick));}
      kids.push(status,confirmation,drawer,settings);
      const section=el('section',{id:'confluence-panel-'+mode,className:'confluence-store','data-confluence-mode':mode,'data-provider':'confluence','aria-labelledby':'confluence-'+mode+'-title'}, ...kids);
      host.append(section);
      const panel={mode,consent,consentFor:'',connect:connectBtn,disconnect:disconnectBtn,share:shareBtn,load:loadBtn,more:moreBtn,closeTemp:closeTempBtn,connection,status,list,tempNotice,prepare,target,confirmation,drawer};
      panels.push(panel);
      consent.addEventListener('change',()=>{panel.consentFor=consent.checked?consentIdentity(mode):''; paint();});
      connectBtn.addEventListener('click',connect);
      disconnectBtn.addEventListener('click',disconnect);
      shareBtn.addEventListener('click',()=>share(mode));
      loadBtn.addEventListener('click',()=>{if(!state.session||Date.parse(state.session.expiresAt)<=Date.now()){state.browseAfterAuth=true;void connect();}else void loadList(false);});
      prepare.addEventListener('click',()=>{confirmation.hidden=false;confirmation.open=true;paint();if(!state.session||Date.parse(state.session.expiresAt)<=Date.now())connectBtn.focus?.();else consent.focus?.();});
      moreBtn.addEventListener('click',()=>loadList(true));
      closeTempBtn.addEventListener('click',()=>closeTemporary());
      if(mode==='harness'&&harnessPick) harnessPick.addEventListener('change',()=>{targetEpoch++;state.harnessTarget=null;clearConsent('harness'); paint();});
      for(const [b,name] of [[loadBtn,'folder-open'],[prepare,'users'],[shareBtn,'upload'],[connectBtn,'plug'],[closeTempBtn,'x']]){const symbol=globalThis.FalsifyVisual?.icon?.(name);if(symbol)b.append(symbol);}
    }

    win.addEventListener('message',onMessage);
    document.querySelector('#evaluation-run')?.addEventListener('change',()=>{clearConsent('review'); paint();});
    for(const id of ['#red-harness','#blue-harness']) document.querySelector(id)?.addEventListener('change',()=>{clearConsent('harness'); paint();});
    mountPanel(document.querySelector('#human-evaluation'),'review');
    mountPanel(document.querySelector('#view-results'),'results');
    mountPanel(document.querySelector('#harness-manager')||document.querySelector('#view-agents'),'harness');
    if(misconfigured) say('원격 보관은 Falsify Confluence만 사용합니다. 설정이 없거나 다른 저장소를 가리키면 연결하지 않습니다. 로컬 백업은 기록판에 그대로 있습니다.', true);
    paint(); renderItems();
    async function requestHarnessShare(hash){
      if(state.busy||state.expiring||misconfigured)return false;
      const epoch=++targetEpoch,stamp=state.stamp;
      try{
        const snapshot=await lab.cloudSnapshot(),record=snapshot.harnesses.find(h=>h.hash===hash);
        if(epoch!==targetEpoch||stamp!==state.stamp)return false;
        if(!record||!['red','blue'].includes(record.config?.role))throw local('저장할 도구를 찾지 못했습니다.');
        state.harnessTarget={hash:record.hash,role:record.config.role,name:record.config.name+' · v'+record.config.version};clearConsent('harness');
        const p=panels.find(p=>p.mode==='harness');p.confirmation.hidden=false;p.confirmation.open=true;paint();showView('agents');p.target.scrollIntoView?.({block:'center'});if(!state.session||Date.parse(state.session.expiresAt)<=Date.now()){p.connect.closest?.('details')?.setAttribute('open','');p.connect.focus?.();}else p.consent.focus?.();return true;
      }catch(e){say(failure(e,'write'),true);return false;}
    }
    return {restore,paint,requestHarnessShare,publishPaperEdit};
  }

  let mounted=null;
  function mount(deps={}){if(mounted) return mounted; mounted=create(deps); return mounted;}
  const ready=(async()=>{if(document.readyState==='loading') await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true})); try{await globalThis.FalsifyLab?.ready;}catch{} const app=mount(); try{await app.restore();}catch{} app.paint(); return app;})();
  ready.catch(()=>{});
  globalThis.FalsifyConfluenceStore={ready,mount};
})();

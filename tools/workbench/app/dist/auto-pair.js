/* Click pairing: the page mints challenge/state and a proof verifier, and opens falsify:// with
   the SHA-256 commitment of that verifier. The link has no raw verifier, bearer, password,
   command, or origin. After local approval the page redeems once. Refresh checks status only.
   The reconnect credential lasts until explicit disconnect or its 12-hour bound. */
(function(root){
  'use strict';
  const ORIGIN='https://shinick-han.github.io',HOST='127.0.0.1',STORE='falsify.reconnect.v1';
  const NONCE=/^[A-Za-z0-9_-]{43}$/,CRED=/^rc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const DEADLINE_MS=120000,INTERVAL_MS=1000;
  const K=Uint32Array.from([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function rotr(x,n){return ((x>>>n)|(x<<(32-n)))>>>0;}
  function sha256(bytes){
    const bitLen=bytes.length*8,withPad=new Uint8Array((((bytes.length+9+63)>>6)<<6));
    withPad.set(bytes);withPad[bytes.length]=0x80;
    const view=new DataView(withPad.buffer);view.setUint32(withPad.length-4,bitLen>>>0,false);
    const H=Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w=new Uint32Array(64);
    for(let i=0;i<withPad.length;i+=64){
      for(let t=0;t<16;t++)w[t]=view.getUint32(i+t*4,false);
      for(let t=16;t<64;t++){const s0=rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3),s1=rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;}
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(let t=0;t<64;t++){
        const s1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=((e&f)^((~e)>>>0&g))>>>0,t1=(h+s1+ch+K[t]+w[t])>>>0;
        const s0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=((a&b)^(a&c)^(b&c))>>>0,t2=(s0+maj)>>>0;
        h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
    }
    const out=new Uint8Array(32),ov=new DataView(out.buffer);for(let i=0;i<8;i++)ov.setUint32(i*4,H[i],false);return out;
  }
  function b64url(bytes){
    let out='',i=0;
    for(;i+3<=bytes.length;i+=3){const n=(bytes[i]<<16)|(bytes[i+1]<<8)|bytes[i+2];out+=ALPHABET[(n>>>18)&63]+ALPHABET[(n>>>12)&63]+ALPHABET[(n>>>6)&63]+ALPHABET[n&63];}
    if(i<bytes.length){const n=(bytes[i]<<16)|((i+1<bytes.length?bytes[i+1]:0)<<8);out+=ALPHABET[(n>>>18)&63]+ALPHABET[(n>>>12)&63];if(i+1<bytes.length)out+=ALPHABET[(n>>>6)&63];}
    return out;
  }
  function commitment(text){
    const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i)&255;
    const shown=b64url(sha256(bytes));if(!NONCE.test(shown)||shown===text)throw new Error('nonce');return shown;
  }
  function mint(random){
    const one=()=>{const b=new Uint8Array(32);random(b);const text=b64url(b);if(!NONCE.test(text))throw new Error('nonce');return text;};
    const triple={challenge:one(),state:one(),proof:one()};
    if(new Set([triple.challenge,triple.state,triple.proof]).size!==3)throw new Error('nonce');
    triple.commitment=commitment(triple.proof);
    return triple;
  }
  function pairingUri(port,triple){
    if(!Number.isInteger(port)||port<1024||port>65535||!triple||!NONCE.test(triple.challenge)||!NONCE.test(triple.state)||!NONCE.test(triple.proof))return null;
    let shown;try{shown=triple.commitment||commitment(triple.proof);}catch{return null;}
    if(!NONCE.test(shown)||shown===triple.proof)return null;
    return 'falsify://connect?port='+port+'&challenge='+triple.challenge+'&state='+triple.state+'&proof='+shown;
  }
  function forbidden(uri){return !uri||/bearer|password|(?:^|[?&])(?:cmd|token|command|model|origin)=/i.test(uri)||uri.includes(ORIGIN)||uri.includes(' ');}
  function memoryBag(){let value=null;return {getItem(){return value;},setItem(_k,v){value=String(v);},removeItem(){value=null;}};}
  function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

  function create(options={}){
    const fetchImpl=options.fetch,random=options.random;
    const step=Number.isFinite(options.interval)&&options.interval>=INTERVAL_MS?options.interval:INTERVAL_MS;
    const deadline=Number.isFinite(options.deadline)&&options.deadline>=DEADLINE_MS?options.deadline:DEADLINE_MS;
    const attempts=Number.isInteger(options.attempts)&&options.attempts>0?options.attempts:Math.floor(deadline/step)+1;
    const sleep=options.sleep||(ms=>delay(ms));
    const clock=options.now||(()=>Date.now());
    if(typeof fetchImpl!=='function'||typeof random!=='function')throw new Error('auto-pair dependencies');
    let storage=null;try{storage=options.storage||null;}catch{storage=null;}
    let memory=null;
    const fallback=()=>memory||(memory=memoryBag());
    if(!storage)fallback();
    function readRaw(){
      if(storage){try{const value=storage.getItem(STORE);if(typeof value==='string'&&value)return value;}catch{storage=null;}}
      try{return memory?memory.getItem(STORE):null;}catch{return null;}
    }
    function read(){
      const raw=readRaw();if(typeof raw!=='string'||!raw)return null;
      let data;try{data=JSON.parse(raw);}catch{return null;}
      if(!data||typeof data!=='object'||data.origin!==ORIGIN||!CRED.test(data.credential)||!Number.isInteger(data.port)||data.port<1024||data.port>65535)return null;
      return {credential:data.credential,port:data.port,origin:ORIGIN,expiresAt:Number.isInteger(data.expiresAt)?data.expiresAt:null};
    }
    function write(data){
      const payload=JSON.stringify({credential:data.credential,port:data.port,origin:ORIGIN,expiresAt:data.expiresAt});
      if(storage){try{storage.setItem(STORE,payload);return;}catch{storage=null;}}
      try{fallback().setItem(STORE,payload);}catch{}
    }
    function dropLocal(){
      if(storage){try{storage.removeItem(STORE);}catch{storage=null;}}
      try{if(memory)memory.removeItem(STORE);}catch{}
    }
    function forget(){
      const saved=read();
      if(saved){
        try{void fetchImpl('http://'+HOST+':'+saved.port+'/api/pair/revoke',{method:'POST',headers:{Authorization:'Bearer '+saved.credential,'Content-Type':'application/json'},body:JSON.stringify({schema:'falsify.pair-revoke.v1'}),credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',referrerPolicy:'no-referrer',targetAddressSpace:'loopback'}).catch(()=>{});}catch{}
      }
      dropLocal();
      return saved?saved.credential:null;
    }
    async function redeemOnce(port,triple){
      const res=await fetchImpl('http://'+HOST+':'+port+'/api/pair/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge:triple.challenge,state:triple.state,proof:triple.proof}),credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',referrerPolicy:'no-referrer',targetAddressSpace:'loopback'});
      if(res.redirected||res.type==='opaqueredirect')return {ok:false,error:'redirect',terminal:true};
      let data=null;try{data=await res.json();}catch{data=null;}
      if(!res.ok){const error=typeof data?.error==='string'?data.error:'rejected';return {ok:false,error,terminal:error!=='unknown_challenge'};}
      const credential=data?.credential;
      if(!CRED.test(credential)||credential.includes(triple.proof)||credential.includes(triple.commitment)||credential.includes(triple.challenge)||credential.includes(triple.state)||data.origin!==ORIGIN||data.port!==port)return {ok:false,error:'malformed',terminal:true};
      return {ok:true,credential,expiresAt:data.expiresAt,port};
    }
    let generation=0;
    async function begin({bridge,port,open}){
      const held=bridge.hold(port);
      if(!held.ok)return held;
      const mine=++generation;
      let success=false;
      const release=()=>{if(mine===generation){try{bridge.releaseHold();}catch{}}};
      try{
        let triple;try{triple=mint(random);}catch{return bridge.report('일회용 연결 값을 만들지 못했습니다.');}
        const uri=pairingUri(held.port,triple);
        if(forbidden(uri)||!uri||uri.includes(triple.proof))return bridge.report('연결 링크가 거절되었습니다.');
        if(typeof open!=='function')return bridge.report('이 브라우저에서는 연결 앱 열기를 쓸 수 없습니다. 수동 실행을 쓰세요.');
        try{open(uri);}catch{return bridge.report('브라우저가 연결 앱 열기를 막았습니다. 수동 실행을 쓰세요.');}
        let last='unknown_challenge';
        for(let i=0;i<attempts;i++){
          if(i)await sleep(step);
          if(mine!==generation)return {ok:false,error:'stale'};
          if(bridge.state().status!=='connecting')return {ok:false,error:'cancelled'};
          try{
            const result=await redeemOnce(held.port,triple);
            if(mine!==generation)return {ok:false,error:'stale'};
            if(result.ok){write(result);const paired=await bridge.pair(result.credential,String(held.port));if(!paired.ok){forget();return paired;}success=true;return paired;}
            last=result.error||last;if(result.terminal)break;
          }catch{last='network';}
        }
        if(last==='unknown_challenge')return bridge.report('로컬 승인이 없거나 취소되었습니다. 연결 앱이 없으면 아무 일도 없을 수 있습니다. 브라우저는 설치 여부를 알려주지 않습니다. 수동 토큰을 쓰세요.');
        if(last==='network')return bridge.report('로컬 broker에 닿지 못했습니다. 브라우저의 로컬 네트워크 권한은 이 페이지가 대신 받을 수 없습니다.');
        return bridge.report('일회용 연결이 거절되었습니다 ('+String(last).slice(0,80)+').');
      }finally{if(!success)release();}
    }
    async function refresh(bridge){
      if(!bridge||bridge.state().mode==='local'||bridge.state().status==='paired'||bridge.state().status==='connecting')return {ok:false,skipped:true};
      const saved=read();
      if(!saved)return {ok:false,skipped:true};
      let res;
      try{res=await fetchImpl('http://'+HOST+':'+saved.port+'/api/pair/status',{method:'GET',headers:{Authorization:'Bearer '+saved.credential},credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',referrerPolicy:'no-referrer',targetAddressSpace:'loopback'});}
      catch{return {ok:false,error:'network'};}
      let data=null;try{data=await res.json();}catch{data=null;}
      if(!res.ok||data?.paired!==true||data.origin!==ORIGIN||data.port!==saved.port){dropLocal();return {ok:false,error:typeof data?.error==='string'?data.error:'rejected'};}
      const paired=await bridge.pair(saved.credential,String(saved.port));
      if(!paired.ok)dropLocal();
      return paired;
    }
    let hooked=false;
    const api={begin,refresh,forget,read,pairingUri,mint,commitment};
    api.attach=(bridge,doc)=>{
      if(hooked)return Promise.resolve({ok:false,skipped:true});
      hooked=true;
      return attach(bridge,doc,api);
    };
    return Object.freeze(api);
  }

  function attach(bridge,doc,api){
    const launch=doc&&typeof doc.getElementById==='function'?doc.getElementById('bridge-launch'):null;
    if(launch)launch.hidden=false;
    if(!bridge||bridge.state().mode==='local')return Promise.resolve({ok:false,skipped:true});
    return Promise.resolve(bridge.ready).then(()=>api.refresh(bridge));
  }

  if(typeof module==='object'&&module.exports){module.exports={create,pairingUri,mint,b64url,attach,forbidden,commitment,sha256,ORIGIN,STORE,NONCE,CRED,DEADLINE_MS,INTERVAL_MS};return;}
  let storage=null;try{storage=root.sessionStorage;}catch{storage=null;}
  const api=create({fetch:(...args)=>root.fetch(...args),storage,random:buf=>root.crypto.getRandomValues(buf)});
  root.FalsifyAutoPair=api;
  if(root.FalsifyLocalBridge)api.attach(root.FalsifyLocalBridge,root.document);
})(typeof window==='object'?window:globalThis);

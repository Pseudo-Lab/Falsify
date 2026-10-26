/* Durable pre-POST record for one RED or BLUE job. Browser storage only.
   Kept: extracted segments, requestId, harness hash, source/file hashes, companion instance descriptor,
   the local canonical checksum, and the SHA-256 of the exact JSON bytes that will be posted.
   Not kept: original file bytes, pairing secret, session secret, bearer token.
   The byte digest is not the canonical checksum and not the server's idempotency fingerprint.
   A running record does not expire on a clock; the companion deletes only finished jobs after 3600s.
   Reload reads with GET. It never POSTs and never starts another model call. */
(function(root){
  'use strict';
  const SCHEMA='falsify.pending-job.v1',RETENTION_MS=3600*1000,MAX_SECRET_DEPTH=64;
  // Same page and JavaScript realm only. Not atomic across tabs. Web Locks are not used.
  const admitting={red:false,blue:false};
  const RETENTION='대기 기록은 이 브라우저에만 있습니다. 추출 텍스트·요청 ID·harness 해시·원본 SHA-256·companion 인스턴스 식별을 보관하고, 원본 바이트와 연결 비밀은 보관하지 않습니다. 실행 중인 작업은 3600초로 지우지 않습니다. companion은 끝난 작업만 3600초 뒤에 메모리에서 지웁니다. 다시 열면 GET으로만 조회하고, 모델을 다시 호출하지 않습니다.';
  // Same request id rule as app/local/red_service.py validate_request.
  const REQUEST_ID=/^[A-Za-z0-9_:-]{1,160}$/;
  const INSTANCE=/^ci1\.[0-9a-f]{64}$/,HEX=/^[0-9a-f]{64}$/;
  const SECRET=/^(token|authorization|bearer|cookie|password|secret|session|sessiontoken|file|bytes|pdf|pdfbytes)$/i;
  const RECEIPTS=['pending','accepted','unknown'];
  const DISPOSITIONS=['open','running','completed','failed','cancelled','expired','unknown'];
  const BLUE_KEYS=['schema','revision','requestId','sourceHash','segments','maxCalls','consent','harness','harnessCanonical','executionConsent'];
  function fail(status,message){const e=new Error(message);e.status=status;throw e;}
  function storageKey(role){return 'falsify.pending-job.'+role+'.v1';}
  function backing(storage){if(storage)return storage;try{return root.localStorage||null;}catch{return null;}}
  function canonical(value){
    if(value===null)return 'null';
    const t=typeof value;
    if(t==='string'||t==='boolean')return JSON.stringify(value);
    if(t==='number'){if(!Number.isFinite(value))fail('invalid','nonfinite');return JSON.stringify(value);}
    if(Array.isArray(value))return '['+value.map(canonical).join(', ')+']';
    if(t==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+': '+canonical(value[k])).join(', ')+'}';
    fail('invalid','unsupported JSON value');
  }
  async function sha256(text){
    const buf=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function secrets(value,depth){
    if(!value||typeof value!=='object')return;
    if(depth>MAX_SECRET_DEPTH)fail('rejected','대기 기록의 중첩이 허용 깊이를 넘습니다. 실행하지 않았습니다.');
    if(!Array.isArray(value))for(const k of Object.keys(value))if(SECRET.test(k))fail('rejected','비밀이나 원본 바이트로 보이는 키는 대기 기록에 넣지 않습니다.');
    for(const item of Array.isArray(value)?value:Object.values(value))secrets(item,depth+1);
  }
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function segments(list){
    if(!Array.isArray(list)||!list.length||list.length>8000)return null;
    const out=[];
    for(const s of list){
      if(!s||typeof s!=='object'||typeof s.id!=='string'||typeof s.label!=='string'||typeof s.text!=='string')return null;
      if(!s.id||s.id.length>80||s.label.length>200||s.text.length>500000)return null;
      out.push({id:s.id,label:s.label,text:s.text});
    }
    return out;
  }
  function put(role,record,storage){
    const box=backing(storage);if(!box)return {ok:false,status:'write-failed',message:'브라우저 저장소를 쓸 수 없어 실행하지 않았습니다.'};
    let raw;try{raw=JSON.stringify(record);}catch{return {ok:false,status:'write-failed',message:'대기 기록을 만들지 못해 실행하지 않았습니다.'};}
    if(raw.length>4500000)return {ok:false,status:'write-failed',message:'대기 기록이 너무 커 저장하지 못했습니다. 실행하지 않았습니다.'};
    try{box.setItem(storageKey(role),raw);}catch{return {ok:false,status:'write-failed',message:'대기 기록을 저장하지 못했습니다. 실행하지 않았고 기존 기록은 덮어쓰지 않았습니다.'};}
    return {ok:true,status:'record',record};
  }
  function read(role,storage){
    if(role!=='red'&&role!=='blue')return {status:'corrupt'};
    const box=backing(storage);if(!box)return {status:'absent'};
    let raw;try{raw=box.getItem(storageKey(role));}catch{return {status:'corrupt'};}
    if(raw==null||raw==='')return {status:'absent'};
    let data;try{data=JSON.parse(raw);}catch{return {status:'corrupt'};}
    if(!valid(data)||data.role!==role)return {status:'corrupt'};
    return {status:'record',record:data};
  }
  function valid(x){
    if(!x||x.schema!==SCHEMA||(x.role!=='red'&&x.role!=='blue'))return false;
    if(!REQUEST_ID.test(x.requestId)||!x.request||typeof x.request!=='object'||x.request.requestId!==x.requestId)return false;
    if(!INSTANCE.test(x.companionInstance)||!HEX.test(x.requestFingerprint)||!HEX.test(x.requestBytesDigest)||!HEX.test(x.harnessHash)||!HEX.test(x.sourceHash)||!HEX.test(x.fileHash))return false;
    if(!RECEIPTS.includes(x.postReceipt)||!DISPOSITIONS.includes(x.disposition)||!Number.isFinite(x.createdAt))return false;
    const open=x.disposition==='open'||x.disposition==='running';
    if(open){if(x.finishedAt!==null||x.expiresAt!==null)return false;}
    else if(!Number.isFinite(x.finishedAt)||x.expiresAt!==x.finishedAt+RETENTION_MS)return false;
    if(typeof x.revision!=='string'||x.revision.length<1||x.revision.length>160||x.revision!==x.request.revision||x.sourceHash!==x.request.sourceHash)return false;
    if(!segments(x.request.segments)||typeof x.name!=='string'||x.name.length>160||typeof x.format!=='string'||x.format.length>40)return false;
    if(x.role==='blue'&&Object.keys(x.request).some(k=>!BLUE_KEYS.includes(k)))return false;
    return true;
  }
  function blocking(found){
    if(found.status==='corrupt')return 'corrupt';
    if(found.status!=='record')return null;
    const r=found.record;
    if(r.postReceipt==='accepted'&&r.disposition==='completed')return null;
    if(r.disposition==='failed')return 'failed';
    if(r.disposition==='cancelled')return 'cancelled';
    if(r.disposition==='expired')return 'expired';
    if(r.postReceipt==='unknown'||r.disposition==='unknown')return 'unknown';
    return 'unresolved';
  }
  function docFrom(record){return {revision:record.revision,sourceHash:record.sourceHash,fileHash:record.fileHash,format:record.format,name:record.name,segments:record.request.segments.map(s=>({id:s.id,label:s.label,text:s.text}))};}
  function blockedResult(why,found){
    const corrupt=why==='corrupt';
    return {ok:false,status:'blocked',blocked:why,record:found&&found.record,message:corrupt?'손상된 대기 기록이 있어 덮어쓰지 않았습니다. 확인 후 버리기 전에는 실행하지 않습니다.':'같은 역할의 끝나지 않은 대기 기록이 있어 덮어쓰지 않았습니다. 확인 후 버리기 전에는 실행하지 않습니다.'};
  }
  async function hold(options={}){
    const role=options.role;
    if(role!=='red'&&role!=='blue')return {ok:false,status:'rejected',message:'역할이 올바르지 않습니다.'};
    if(admitting[role])return blockedResult('unresolved',read(role,options.storage));
    admitting[role]=true;
    try{
      const request=options.request,doc=options.doc,instance=options.companionInstance,storage=options.storage;
      const found=read(role,storage),why=blocking(found);
      if(why)return blockedResult(why,found);
      if(!INSTANCE.test(instance))fail('rejected','연결된 companion의 인스턴스 식별이 없어 실행하지 않았습니다.');
      if(!request||typeof request!=='object'||!doc||typeof doc!=='object')fail('rejected','요청 식별이 없어 실행하지 않았습니다.');
      if(typeof options.hashHarness!=='function')fail('rejected','harness 검증을 재사용하지 못해 실행하지 않았습니다.');
      secrets(request,0);secrets(doc,0);
      const body=clone(request),text=segments(body.segments);
      if(!text||!REQUEST_ID.test(body.requestId))fail('rejected','요청 ID가 서버 규칙과 달라 실행하지 않았습니다.');
      if(role==='blue'&&Object.keys(body).some(k=>!BLUE_KEYS.includes(k)))fail('rejected','BLUE 대기 기록은 허용된 문서 필드만 보관합니다. RED 정답·파일명은 넣지 않습니다.');
      if(body.revision!==doc.revision||body.sourceHash!==doc.sourceHash||!HEX.test(doc.sourceHash)||!HEX.test(doc.fileHash))fail('hash-mismatch','문서 식별이 요청과 달라 실행하지 않았습니다.');
      if(typeof doc.revision!=='string'||doc.revision.length<1||doc.revision.length>160)fail('rejected','문서 리비전이 올바르지 않습니다.');
      if(!body.harness||typeof body.harness!=='object')fail('rejected','harness가 없어 실행하지 않았습니다.');
      body.segments=text;
      const harnessHash=await options.hashHarness(body.harness);
      if(typeof harnessHash!=='string'||!HEX.test(harnessHash))fail('rejected','harness 해시가 올바르지 않습니다.');
      const wire=JSON.stringify(body);
      const requestBytesDigest=await sha256(wire);
      const requestFingerprint=await sha256(canonical(body));
      const again=read(role,storage),whyNow=blocking(again);
      if(whyNow)return blockedResult(whyNow,again);
      const now=Number.isFinite(options.now)?options.now:Date.now();
      const record={schema:SCHEMA,role,requestId:body.requestId,companionInstance:instance,sourceHash:doc.sourceHash,fileHash:doc.fileHash,revision:doc.revision,
        name:String(doc.name||'').slice(0,160),format:String(doc.format||'').slice(0,40),harnessHash,requestFingerprint,requestBytesDigest,
        postReceipt:'pending',disposition:'open',createdAt:now,finishedAt:null,expiresAt:null,request:body};
      secrets(record,0);
      if(!valid(record))fail('rejected','대기 기록을 검사하지 못했습니다. 실행하지 않았습니다.');
      const raced=read(role,storage),whyPut=blocking(raced);
      if(whyPut)return blockedResult(whyPut,raced);
      return put(role,record,storage);
    }catch(e){return {ok:false,status:e.status||'rejected',message:e.message||'대기 기록을 만들지 못했습니다.'};}
    finally{admitting[role]=false;}
  }
  function note(record,patch={},storage){
    if(!record||(record.role!=='red'&&record.role!=='blue'))return {ok:false,status:'rejected',message:'대기 기록이 없습니다.'};
    const found=read(record.role,storage);
    if(found.status==='corrupt')return {ok:false,status:'corrupt',message:'손상된 대기 기록은 덮어쓰지 않았습니다.'};
    if(found.status!=='record'||found.record.requestId!==record.requestId)return {ok:false,status:'absent',message:'저장한 요청 ID를 찾지 못했습니다.'};
    const next={...found.record,request:found.record.request};
    if(Object.hasOwn(patch,'postReceipt')){if(!RECEIPTS.includes(patch.postReceipt))return {ok:false,status:'rejected',message:'접수 상태가 올바르지 않습니다.'};next.postReceipt=patch.postReceipt;}
    if(Object.hasOwn(patch,'disposition')){if(!DISPOSITIONS.includes(patch.disposition))return {ok:false,status:'rejected',message:'대기 상태가 올바르지 않습니다.'};next.disposition=patch.disposition;}
    if(next.disposition==='open'||next.disposition==='running'){next.finishedAt=null;next.expiresAt=null;}
    else if(Object.hasOwn(patch,'finishedAt')){if(!Number.isFinite(patch.finishedAt))return {ok:false,status:'rejected',message:'완료 시각이 올바르지 않습니다.'};next.finishedAt=patch.finishedAt;next.expiresAt=patch.finishedAt+RETENTION_MS;}
    else if(next.finishedAt==null)return {ok:false,status:'rejected',message:'끝난 작업의 시각이 없습니다. 기록은 바꾸지 않았습니다.'};
    if(!valid(next))return {ok:false,status:'rejected',message:'대기 기록 검사가 통과하지 않아 덮어쓰지 않았습니다.'};
    return put(record.role,next,storage);
  }
  function discard(role,options={}){
    if(options.acknowledge!==true)return {ok:false,status:'rejected',message:'버리려면 확인이 필요합니다. 대기 기록은 그대로입니다.'};
    if(role!=='red'&&role!=='blue')return {ok:false,status:'rejected',message:'역할이 올바르지 않습니다.'};
    const box=backing(options.storage);if(!box)return {ok:false,status:'write-failed',message:'브라우저 저장소를 쓸 수 없습니다. 대기 기록은 그대로입니다.'};
    try{box.removeItem(storageKey(role));}catch{return {ok:false,status:'write-failed',message:'대기 기록을 지우지 못했습니다.'};}
    return {ok:true,status:'discarded'};
  }
  function bound(record,body){
    if(!body||typeof body!=='object'||Array.isArray(body))return 'unavailable';
    if(body.id!==record.requestId)return 'request-mismatch';
    if(body.role!==record.role)return 'role-mismatch';
    if(body.sourceHash!==record.sourceHash||body.revision!==record.revision||body.harnessHash!==record.harnessHash||body.requestBytesDigest!==record.requestBytesDigest)return 'hash-mismatch';
    if(body.companionInstance!==record.companionInstance)return 'server-restarted';
    return null;
  }
  async function recover(options={}){
    const role=options.role,found=read(role,options.storage);
    if(found.status!=='record')return {...found,gets:0};
    const record=found.record,now=Number.isFinite(options.now)?options.now:Date.now();
    if(record.role!==role)return {status:'role-mismatch',record,gets:0};
    const instance=options.companionInstance;
    if(typeof instance!=='string'||!INSTANCE.test(instance))return {status:'instance-unverified',record,gets:0};
    if(instance!==record.companionInstance)return {status:'server-restarted',record,gets:0};
    let fingerprint,harnessHash,bytesDigest;
    try{fingerprint=await sha256(canonical(record.request));bytesDigest=await sha256(JSON.stringify(record.request));harnessHash=await options.hashHarness(record.request.harness);}
    catch{return {status:'corrupt',record,gets:0};}
    if(fingerprint!==record.requestFingerprint||bytesDigest!==record.requestBytesDigest||harnessHash!==record.harnessHash)return {status:'hash-mismatch',record,gets:0};
    const current=options.currentDoc;
    if(current&&(current.sourceHash!==record.sourceHash||current.fileHash!==record.fileHash||current.revision!==record.revision))return {status:'hash-mismatch',record,gets:0};
    if(typeof options.getJob!=='function')return {status:'unavailable',record,gets:0};
    let job;
    try{job=await options.getJob(record.requestId);}catch{return {status:record.postReceipt==='accepted'?'unavailable':'receipt-unknown',record,gets:1};}
    const http=job&&job.httpStatus,body=job&&job.body;
    if(http===401||http===403)return {status:'auth-refused',record,gets:1};
    if(http===404){
      const expired=Number.isFinite(record.finishedAt)&&now>=record.expiresAt;
      return {status:record.postReceipt==='accepted'?(expired?'expired':'not-found'):'receipt-unknown',record,gets:1};
    }
    if(http!==200)return {status:record.postReceipt==='accepted'?'unavailable':'receipt-unknown',record,gets:1};
    const mismatch=bound(record,body);
    if(mismatch)return {status:mismatch,record,gets:1};
    const doc=docFrom(record);
    if(body.state==='running')return {status:'still-running',record,gets:1,job:body,doc};
    if(body.state==='failed')return {status:'failed',record,gets:1,job:body,doc,error:typeof body.error==='string'?body.error.slice(0,300):'실패'};
    if(body.state==='cancelled')return {status:'cancelled',record,gets:1,job:body,doc};
    if(body.state==='completed'){
      try{if(typeof options.validate!=='function')fail('invalid-result','검증기가 없습니다.');options.validate(doc,body.result);}
      catch(e){return {status:'invalid-result',record,gets:1,error:String(e&&e.message||e).slice(0,300)};}
      return {status:'completed',record,gets:1,job:body,doc,result:body.result};
    }
    return {status:'unavailable',record,gets:1,job:body};
  }
  function text(outcome){
    const id=outcome&&outcome.record&&outcome.record.requestId?outcome.record.requestId.slice(0,18):'';
    const tail=id?' 요청 '+id+'.':'';
    const base={
      absent:'',
      corrupt:'저장된 대기 작업을 읽지 못했습니다. 그 기록은 지우지 않았고 다시 실행하지 않았습니다.',
      expired:'대기 기록이 만료되었습니다. 결과를 성공으로 보지 않았고 다시 실행하지 않았습니다.'+tail,
      unpaired:'연결이 아직 없습니다. 다시 연결한 뒤에만 같은 작업을 조회합니다. 다시 실행하지 않았습니다.'+tail,
      unresolved:'같은 역할의 대기 기록이 남아 있습니다. 확인 없이 지우거나 다시 실행하지 않았습니다.'+tail,
      blocked:'같은 역할의 대기 기록이 있어 덮어쓰지 않았습니다.'+tail,
      'instance-unverified':'연결된 companion이 인스턴스 식별을 보고하지 않아 작업을 조회하지 않았습니다. 다시 실행하지 않았습니다.'+tail,
      'server-restarted':'companion 인스턴스가 저장된 작업과 다릅니다. 서버가 다시 시작된 것으로 보고 조회하거나 다시 실행하지 않았습니다.'+tail,
      'role-mismatch':'역할이 저장된 작업과 다릅니다. 다른 역할의 작업으로 바꾸지 않았고 다시 실행하지 않았습니다.'+tail,
      'hash-mismatch':'입력·harness·요청 바이트·요청 식별이 저장된 값과 다릅니다. 결과를 적용하지 않았고 다시 실행하지 않았습니다.'+tail,
      'auth-refused':'companion이 조회 인증을 거부했습니다. 결과를 성공으로 보지 않았고 다시 실행하지 않았습니다.'+tail,
      'not-found':'같은 요청을 찾을 수 없습니다. 빠진 결과를 성공으로 보지 않았고 다시 실행하지 않았습니다.'+tail,
      'receipt-unknown':'실행 요청의 접수 여부를 확인하지 못했습니다. 결과를 성공으로 보지 않았고 다시 실행하지 않았습니다.'+tail,
      'request-mismatch':'조회한 작업 ID가 저장한 요청 ID와 다릅니다. 다른 실행으로 바꾸지 않았습니다.'+tail,
      'still-running':'같은 요청이 아직 실행 중입니다. 다시 실행하지 않고 상태만 조회합니다.'+tail,
      completed:'같은 요청의 완료 결과를 검증해 복구했습니다. 다시 실행하지 않았습니다.'+tail,
      failed:'같은 요청이 실패로 남아 있습니다. 실패를 지우지 않았고 다시 실행하지 않았습니다.'+(outcome&&outcome.error?' '+outcome.error:'')+tail,
      cancelled:'같은 요청이 취소로 남아 있습니다. 다시 실행하지 않았습니다.'+tail,
      unknown:'접수하지 못했거나 상태를 확인하지 못한 대기 기록이 남아 있습니다. 지우지 않았고 다시 실행하지 않았습니다.'+tail,
      'invalid-result':'완료로 보이는 응답이 이 문서의 검증을 통과하지 못했습니다. 적용하지 않았고 다시 실행하지 않았습니다.'+tail,
      unavailable:'작업 상태를 확인하지 못했습니다. 결과를 성공으로 보지 않았고 다시 실행하지 않았습니다.'+tail,
      'write-failed':'대기 기록을 저장하지 못했습니다. 실행하지 않았습니다.',
      rejected:'대기 기록을 만들지 못해 실행하지 않았습니다.',
      discarded:'대기 기록을 버렸습니다. 다시 실행하지 않았습니다.'
    };
    return base[outcome&&outcome.status]||base.unavailable;
  }
  const api=Object.freeze({SCHEMA,RETENTION_MS,RETENTION,REQUEST_ID,storageKey,canonical,read,hold,note,discard,recover,matches:(record,body)=>!!record&&bound(record,body)===null,text,docFrom});
  if(typeof module==='object'&&module.exports){module.exports=api;return;}
  root.FalsifyPendingJobs=api;
})(typeof globalThis==='object'?globalThis:this);

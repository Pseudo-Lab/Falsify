/* Optional BLUE paper-evidence control. No build step.
   Root wires create/clear/setBusy/requestEvidence/snapshot. This file does not read RED,
   does not store the PDF or table cells, and does not parse paper text as HTML.
   onChange fires only when the user toggles inclusion, so status renders cannot invalidate BLUE. */
(function(root){
  'use strict';
  const SCHEMA='falsify.paper-evidence.v1';
  const PREPARE='/api/paper/evidence/prepare';
  const QUERY='/api/paper/evidence/query';
  const MAX_PDF=25*1024*1024;
  const MAX_PIXELS=2000000;
  const HEX=/^[0-9a-f]{64}$/;
  const TEXT={
    idle:'현재는 텍스트만 검토합니다.',
    waiting:'PDF를 선택하세요.',
    preparing:'표 셀과 그림 위치를 준비하고 있습니다.',
    textOnly:'텍스트만 검토합니다.',
    unavailable:'PC 연결 후 다시 준비하세요.',
    path:'이 화면의 연결 모듈이 표·그림 경로를 아직 허용하지 않습니다. 텍스트 검토는 계속할 수 있습니다.',
    failed:'표·그림 준비에 실패했습니다. 다시 준비를 누르세요.',
    hash:'원본 파일이 바뀌어 표·그림을 준비하지 않았습니다. 파일을 다시 선택하세요.',
    notPdf:'PDF가 아니라 표·그림을 준비하지 않았습니다. 텍스트 검토는 계속할 수 있습니다.',
    limit:'25 MiB를 넘는 PDF는 표·그림 준비에 쓰지 않습니다.',
    busy:'다른 작업이 끝난 뒤 다시 준비하세요.',
    stale:'입력이 바뀌어 표·그림 근거를 보내지 않았습니다.',
    expired:'준비한 표·그림 근거가 만료되었습니다. 다시 준비하세요.',
    listFailed:'목록을 불러오지 못했습니다. 개수는 준비 결과에 남아 있습니다.',
    listSkip:'목록 일부는 형식이 달라 건너뛰었습니다.',
    listLoading:'목록을 불러오는 중입니다.',
    noItems:'표나 그림을 찾지 못했습니다.',
    cropWait:'영역을 그리는 중입니다.',
    cropFailed:'선택한 영역을 그리지 못했습니다.',
    retry:'다시 준비',
    more:'다음 표·그림'
  };
  const CODES={
    paper_evidence_request_invalid:'failed',
    paper_evidence_hash_invalid:'hash',
    paper_evidence_file_limit:'limit',
    paper_evidence_file_invalid:'notPdf',
    paper_evidence_operation_invalid:'failed',
    paper_evidence_id_invalid:'failed',
    paper_evidence_expired_or_missing:'expired',
    companion_busy:'busy'
  };
  let instances=0;

  function codeOf(e){
    if(e&&typeof e.code==='string'&&TEXT[e.code])return e.code;
    if(e&&typeof e.code==='string'&&CODES[e.code])return CODES[e.code];
    const msg=e&&typeof e.message==='string'?e.message:'';
    if(CODES[msg])return CODES[msg];
    if(msg==='허용되지 않은 로컬 경로입니다.')return 'path';
    if(e&&(e.httpStatus===401||e.httpStatus===403))return 'unavailable';
    return 'failed';
  }
  function clip(value,max){
    const text=String(value).replace(/[\u0000-\u001f]/g,'').trim();
    return text.length>max?text.slice(0,max)+'…':text;
  }
  function isPdf(bytes){
    return bytes.length>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;
  }
  function encode(bytes){
    let s='';
    for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return root.btoa(s);
  }
  function decode(data){
    if(typeof data!=='string'||data.length===0||data.length>12000000||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))return null;
    let bin;
    try{bin=root.atob(data);}catch{return null;}
    const out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i)&255;
    return out;
  }
  async function digest(bytes){
    const buf=await root.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function paperIdOk(id){
    return typeof id==='string'&&id.length>=1&&id.length<=160&&!/[\u0000-\u0020\u007f]/.test(id);
  }
  function countOk(n){return Number.isSafeInteger(n)&&n>=0&&n<=100000;}
  function bboxOk(b){
    return Array.isArray(b)&&b.length===4&&b.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=20000)&&b[2]>b[0]&&b[3]>b[1];
  }

  function create({host,getSession,getSource,onChange}={}){
    if(!host||typeof host.append!=='function'||typeof getSession!=='function'||typeof getSource!=='function')throw new TypeError('표·그림 화면 설정이 올바르지 않습니다.');
    const doc=host.ownerDocument||root.document;
    const radioName='paper-evidence-'+ (++instances);
    const el=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    const say=(node,text,error=false)=>{node.textContent=text;node.classList.toggle('error',!!error);};
    host.classList?.add('paper-evidence');
    if(typeof host.replaceChildren==='function')host.replaceChildren();

    const label=el('label','check-row');
    const box=el('input');
    box.type='checkbox';
    const span=el('span');
    const small=el('small');
    small.textContent='표 셀·그림 설명을 함께 보냅니다. 원본 영역은 목록에서 확인하세요.';
    span.append(doc.createTextNode('표·그림 함께 검토'), small);
    label.append(box, span);
    const status=el('p','form-feedback', TEXT.idle);
    status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');
    const retryRow=el('div','button-row');
    const retry=el('button','button secondary', TEXT.retry);
    retry.type='button';
    retry.hidden=true;
    retryRow.hidden=true;
    retryRow.append(retry);
    const listDetails=el('details','red-help');
    listDetails.hidden=true;
    const listSummary=el('summary', null, '표·그림 목록');
    const listNote=el('p','form-feedback','');
    listNote.setAttribute('role','status');
    const rows=el('div','image-rows');
    const moreRow=el('div','button-row');
    const more=el('button','button secondary', TEXT.more);
    more.type='button';
    more.hidden=true;
    moreRow.append(more);
    const figure=el('figure');
    figure.hidden=true;
    const figcaption=el('figcaption');
    const img=el('img','image-preview');
    img.alt='';
    img.hidden=true;
    const cropNote=el('p','form-feedback','');
    cropNote.setAttribute('role','status');
    figure.append(figcaption, img, cropNote);
    listDetails.append(listSummary, listNote, rows, moreRow, figure);
    const limitDetails=el('details','red-help');
    limitDetails.hidden=true;
    const limitSummary=el('summary', null, '추출 엔진과 한계');
    const engineText=el('p','muted','');
    const limitList=el('ul','image-limits');
    limitDetails.append(limitSummary, engineText, limitList);
    host.append(label, status, retryRow, listDetails, limitDetails);

    let included=false,parentBusy=false,epoch=0,flight=null,cache=null,failedHash=null,errorCode=null;
    let prepareCtl=null,listCtl=null,cropCtl=null,listing=false,listGen=0,listPaperId=null,nextOff=null,selectedId=null,cropSerial=0,objectUrl=null;
    let items=[],radios=[];

    function readSource(){
      let s;
      try{s=getSource();}catch{return null;}
      if(!s||typeof s!=='object'||typeof s.fileHash!=='string'||!s.file)return null;
      return s;
    }
    function fresh(fileHash){
      return cache&&cache.fileHash===fileHash&&cache.companionInstance===readSource()?.companionInstance&&cache.expiresAt>Date.now()?cache:null;
    }
    function revoke(){
      if(objectUrl){root.URL.revokeObjectURL(objectUrl);objectUrl=null;}
      img.removeAttribute?.('src');
      img.src='';
      img.alt='';
      img.hidden=true;
      figcaption.textContent='';
    }
    function conceal(){
      listDetails.hidden=true;
      limitDetails.hidden=true;
      figure.hidden=true;
      more.hidden=true;
      cropSerial++;
      revoke();
      say(cropNote,'');
      say(listNote,'');
    }
    function showRetry(on){retry.hidden=retryRow.hidden=!on;}
    function syncDisabled(){
      box.disabled=!!parentBusy;
      retry.disabled=!!parentBusy;
      more.disabled=!!parentBusy||listing;
      for(const input of radios)input.disabled=!!parentBusy;
    }
    function cancelFlight(){
      epoch++;
      prepareCtl?.abort();
      prepareCtl=null;
      listCtl?.abort();
      listCtl=null;
      listing=false;
      cropCtl?.abort();
      cropCtl=null;
      flight=null;
    }
    function fail(code){
      const e=new Error(TEXT[code]||TEXT.failed);
      e.code=code;
      throw e;
    }
    function paintReady(parsed){
      const kind=parsed.status==='partial'?'일부만 준비됨':'준비됨';
      say(status,'표 '+parsed.counts.tables+' · 그림 '+parsed.counts.figures+' · '+parsed.pageCount+'쪽 · '+kind);
      engineText.textContent='엔진 '+parsed.engine;
      limitList.replaceChildren();
      for(const line of (parsed.limitations.length?parsed.limitations:['보고된 한계 없음']))limitList.append(el('li',null,line));
      if(limitDetails.hidden)limitDetails.open=false;
      limitDetails.hidden=false;
      if(listDetails.hidden)listDetails.open=false;
      listDetails.hidden=false;
      showRetry(false);
      errorCode=null;
    }
    function validateSummary(data, fileHash){
      if(!data||typeof data!=='object'||Array.isArray(data)||data.schema!==SCHEMA||!paperIdOk(data.paperId)||data.fileHash!==fileHash)fail('failed');
      if(data.status!=='ready'&&data.status!=='partial')fail('failed');
      if(!countOk(data.pageCount)||data.pageCount>20000||!data.counts||typeof data.counts!=='object'||!countOk(data.counts.tables)||!countOk(data.counts.figures))fail('failed');
      if(typeof data.engine!=='string'||!data.engine.trim()||data.engine.length>80||/[\u0000-\u001f]/.test(data.engine))fail('failed');
      if(!Array.isArray(data.limitations)||data.limitations.length>10000||data.limitations.some(x=>typeof x!=='string'||x.length>500||/[\u0000-\u001f]/.test(x)))fail('failed');
      const expiresAt=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
      if(!Number.isFinite(expiresAt))fail('failed');
      if(expiresAt<=Date.now())fail('expired');
      return {paperId:data.paperId,fileHash,status:data.status,pageCount:data.pageCount,counts:{tables:data.counts.tables,figures:data.counts.figures},engine:data.engine.trim(),limitations:data.limitations.slice(0,16).map(x=>clip(x,200)).concat(data.limitations.length>16?['추가 항목 '+(data.limitations.length-16)+'개']:[]),expiresAt};
    }
    function validateList(data, parsed, offset){
      if(!data||typeof data!=='object'||data.paperId!==parsed.paperId||data.fileHash!==parsed.fileHash||!Array.isArray(data.items)||!countOk(data.total))return null;
      if(data.total<offset)return null;
      const seen=new Set(items.map(x=>x.id)), out=[];
      let skipped=0;
      for(const raw of data.items){
        const id=raw&&raw.id;
        const caption=raw&&raw.caption!=null?raw.caption:null;
        const provenance=raw&&raw.provenance!=null?raw.provenance:null;
        if(!raw||typeof raw!=='object'||typeof id!=='string'||id.length<1||id.length>160||seen.has(id)||/[\u0000-\u001f]/.test(id)||(raw.type!=='table'&&raw.type!=='figure')||!Number.isSafeInteger(raw.pageIndex)||raw.pageIndex<0||raw.pageIndex>20000||!bboxOk(raw.bbox)||(caption!=null&&(typeof caption!=='string'||caption.length>2000))||(provenance!=null&&typeof provenance!=='string'&&(typeof provenance!=='object'||Array.isArray(provenance)))){skipped++;continue;}
        seen.add(id);
        out.push({id,type:raw.type,pageIndex:raw.pageIndex,bbox:[raw.bbox[0],raw.bbox[1],raw.bbox[2],raw.bbox[3]],caption,provenance:typeof provenance==='object'&&provenance!==null?[provenance.engine,provenance.method].filter(v=>typeof v==='string').join(' · '):provenance});
      }
      if(data.total<offset+out.length)return null;
      let next=null;
      if(data.nextOffset!=null){
        if(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<0||data.nextOffset>100000)return null;
        if(data.nextOffset>offset&&out.length)next=data.nextOffset;
      }
      return {items:out,total:data.total,nextOffset:next,skipped};
    }
    function validateRender(data, parsed, item){
      if(!data||typeof data!=='object'||data.paperId!==parsed.paperId||data.fileHash!==parsed.fileHash||data.pageIndex!==item.pageIndex||data.mimeType!=='image/png'||!bboxOk(data.bbox))return null;
      if(!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||data.width<1||data.height<1||data.width*data.height>MAX_PIXELS)return null;
      if(data.bbox.some((n,i)=>Math.abs(n-item.bbox[i])>1e-6))return null;
      if(typeof data.sha256!=='string'||!HEX.test(data.sha256))return null;
      const bytes=decode(data.data);
      if(!bytes||bytes.length<8||bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71||bytes[4]!==13||bytes[5]!==10||bytes[6]!==26||bytes[7]!==10)return null;
      return {bytes,width:data.width,height:data.height,sha256:data.sha256};
    }
    function paintRows(pageItems){
      for(const item of pageItems){
        const row=el('label','image-row');
        const input=el('input');
        input.type='radio';
        input.name=radioName;
        input.value=item.id;
        input.checked=item.id===selectedId;
        const text=el('span','image-row-text');
        const title=el('span','image-row-title',(item.type==='table'?'표':'그림')+' · '+(item.pageIndex+1)+'쪽');
        text.append(title);
        if(item.caption){const note=el('span','image-row-note',clip(item.caption,400));text.append(note);}
        input.addEventListener('change',()=>{if(!input.checked||parentBusy||!included)return;selectedId=item.id;void showCrop(item);});
        row.append(input, text);
        radios.push(input);
        rows.append(row);
      }
      syncDisabled();
    }
    async function showCrop(item){
      const token=epoch, parsed=cache, id=item.id, mine=++cropSerial;
      if(!parsed||parsed.paperId!==listPaperId)return;
      cropCtl?.abort();
      cropCtl=new AbortController();
      figure.hidden=false;
      revoke();
      say(cropNote, TEXT.cropWait);
      try{
        const session=getSession();
        if(!session||typeof session.request!=='function')fail('unavailable');
        const area=(item.bbox[2]-item.bbox[0])*(item.bbox[3]-item.bbox[1]);
        const dpi=Math.max(1,Math.min(120,Math.floor(72*Math.sqrt(1800000/area))));
        const res=await session.request(QUERY,{paperId:parsed.paperId,operation:'render',pageIndex:item.pageIndex,bbox:[...item.bbox],dpi},{signal:cropCtl.signal});
        if(mine!==cropSerial||token!==epoch||selectedId!==id||!included)return;
        const png=validateRender(res, parsed, item);
        if(!png){say(cropNote, TEXT.cropFailed, true);return;}
        const actual=await digest(png.bytes);
        if(mine!==cropSerial||token!==epoch||selectedId!==id||!included)return;
        if(actual!==png.sha256){say(cropNote, TEXT.cropFailed, true);return;}
        objectUrl=root.URL.createObjectURL(new root.Blob([png.bytes],{type:'image/png'}));
        img.src=objectUrl;
        img.alt=(item.type==='table'?'표':'그림')+' · '+(item.pageIndex+1)+'쪽 영역';
        img.hidden=false;
        figcaption.textContent=(item.type==='table'?'표':'그림')+' · '+(item.pageIndex+1)+'쪽'+(item.caption?' · '+clip(item.caption,400):'');
        say(cropNote, png.width+'×'+png.height+' px');
      }catch(e){
        if(e?.name==='AbortError'||mine!==cropSerial||!included)return;
        say(cropNote, codeOf(e)==='unavailable'?TEXT.unavailable:TEXT.cropFailed, true);
      }
    }
    async function loadList(token, parsed, offset){
      if(!parsed||token!==epoch||!included||listing)return;
      if(offset===0&&listPaperId===parsed.paperId){listDetails.hidden=false;return;}
      const mine=++listGen;
      listing=true;
      listCtl?.abort();
      listCtl=new AbortController();
      const signal=listCtl.signal;
      syncDisabled();
      if(offset===0){items=[];radios=[];selectedId=null;rows.replaceChildren();revoke();figure.hidden=true;say(cropNote,'');say(listNote, TEXT.listLoading);}
      try{
        const session=getSession();
        if(!session||typeof session.request!=='function')fail('unavailable');
        const res=await session.request(QUERY,{paperId:parsed.paperId,operation:'list',offset,limit:50},{signal});
        if(token!==epoch||!included||signal.aborted)return;
        const page=validateList(res, parsed, offset);
        if(!page){say(listNote, TEXT.listFailed, true);return;}
        items.push(...page.items);
        paintRows(page.items);
        listPaperId=parsed.paperId;
        nextOff=page.nextOffset!=null&&items.length<200&&items.length<page.total?page.nextOffset:null;
        more.hidden=moreRow.hidden=nextOff==null;
        listSummary.textContent='표·그림 목록 · '+page.total;
        if(!items.length)rows.append(el('p','muted', TEXT.noItems));
        say(listNote, page.skipped?TEXT.listSkip:'');
        listDetails.hidden=false;
      }catch(e){
        if(e?.name==='AbortError'||token!==epoch||!included)return;
        say(listNote, TEXT.listFailed, true);
      }finally{
        if(mine===listGen)listing=false;
        syncDisabled();
      }
    }
    function follow(token, fileHash, companionInstance){
      if(token!==epoch||!included)return null;
      const s=readSource();
      if(!s||s.fileHash!==fileHash||s.companionInstance!==companionInstance){
        if(included&&!parentBusy&&s)queueMicrotask(()=>kick());
        return null;
      }
      return s;
    }
    async function run(token, file, fileHash, companionInstance){
      try{
        if(file&&typeof file.size==='number'&&file.size>MAX_PDF)fail('limit');
        const raw=await file.arrayBuffer();
        if(!follow(token, fileHash, companionInstance))return null;
        const bytes=raw instanceof Uint8Array?new Uint8Array(raw):new Uint8Array(raw);
        if(bytes.length>MAX_PDF)fail('limit');
        if(!isPdf(bytes))fail('notPdf');
        const actual=await digest(bytes);
        if(!follow(token, fileHash, companionInstance))return null;
        if(actual!==fileHash)fail('hash');
        const session=getSession();
        if(!session||typeof session.request!=='function')fail('unavailable');
        const summary=await session.request(PREPARE,{fileHash,file:encode(bytes)},{signal:prepareCtl.signal});
        if(!follow(token, fileHash, companionInstance))return null;
        const parsed=validateSummary(summary, fileHash);
        parsed.companionInstance=companionInstance;
        cache=parsed;
        listPaperId=null;
        paintReady(parsed);
        void loadList(token, parsed, 0);
        return parsed;
      }catch(e){
        if(e?.name==='AbortError'||!follow(token, fileHash, companionInstance))return null;
        const code=codeOf(e);
        failedHash=fileHash;
        errorCode=code;
        say(status, TEXT[code]||TEXT.failed, true);
        showRetry(true);
        listDetails.hidden=true;
        throw Object.assign(new Error(TEXT[code]||TEXT.failed),{code});
      }
    }
    function begin(){
      if(!included)return Promise.resolve(null);
      const s=readSource();
      if(!s){say(status, TEXT.waiting);return Promise.reject(Object.assign(new Error(TEXT.waiting),{code:'waiting'}));}
      if(!HEX.test(s.fileHash)){errorCode='hash';say(status, TEXT.hash, true);showRetry(true);return Promise.reject(Object.assign(new Error(TEXT.hash),{code:'hash'}));}
      const hit=fresh(s.fileHash);
      if(hit){paintReady(hit);void loadList(epoch, hit, 0);return Promise.resolve(hit);}
      if(flight&&flight.fileHash===s.fileHash&&flight.companionInstance===s.companionInstance)return flight.promise;
      cancelFlight();
      const token=epoch, file=s.file, fileHash=s.fileHash,companionInstance=s.companionInstance;
      prepareCtl=new AbortController();
      say(status, TEXT.preparing);
      errorCode=null;
      showRetry(false);
      const promise=run(token, file, fileHash, companionInstance).finally(()=>{if(flight&&flight.token===token)flight=null;});
      flight={fileHash,companionInstance,token,promise};
      return promise;
    }
    function kick(){
      if(!included||parentBusy)return;
      const s=readSource();
      if(!s){say(status, TEXT.waiting);return;}
      if(failedHash&&failedHash===s.fileHash)return;
      begin().catch(e=>{if(!included||e?.name==='AbortError'||(e?.code&&TEXT[e.code]))return;say(status, TEXT.failed, true);});
    }
    function notify(){if(typeof onChange==='function')onChange();}

    box.addEventListener('change',()=>{
      if(parentBusy){box.checked=included;return;}
      const next=!!box.checked;
      if(next===included)return;
      included=next;
      if(next){failedHash=null;errorCode=null;}
      try{notify();}finally{
        if(!included){cancelFlight();conceal();say(status, TEXT.textOnly);showRetry(false);return;}
        kick();
      }
    });
    retry.addEventListener('click',()=>{if(parentBusy||!included)return;failedHash=null;errorCode=null;kick();});
    more.addEventListener('click',()=>{if(parentBusy||!included||!cache||nextOff==null||listing)return;void loadList(epoch, cache, nextOff);});

    function clear(){
      included=false;
      box.checked=false;
      parentBusy=false;
      failedHash=null;
      errorCode=null;
      cache=null;
      listPaperId=null;
      selectedId=null;
      nextOff=null;
      items=[];
      radios=[];
      cropSerial++;
      cancelFlight();
      rows.replaceChildren();
      conceal();
      say(status, TEXT.idle);
      showRetry(false);
      syncDisabled();
    }
    function setBusy(value){
      parentBusy=!!value;
      syncDisabled();
      if(!parentBusy)kick();
    }
    async function requestEvidence(){
      if(!included)return null;
      const result=await begin();
      if(!included)return null;
      const s=readSource();
      if(!result||!s||result.fileHash!==s.fileHash)throw new Error(TEXT.stale);
      return Object.freeze({paperId:result.paperId,fileHash:result.fileHash});
    }
    function snapshot(){
      const s=readSource();
      const hit=included&&fresh(s&&s.fileHash)?fresh(s.fileHash):null;
      return Object.freeze({
        schema:'falsify.paper-evidence-ui.v1',
        checked:included,
        busy:parentBusy,
        preparing:!!flight,
        paperId:hit?hit.paperId:null,
        fileHash:hit?hit.fileHash:null,
        status:hit?hit.status:null,
        pageCount:hit?hit.pageCount:null,
        counts:hit?Object.freeze({tables:hit.counts.tables,figures:hit.counts.figures}):null,
        selectedId:hit?selectedId:null,
        listed:hit?items.length:0,
        error:errorCode
      });
    }
    syncDisabled();
    async function ensurePrepared(){
      if(!included){included=true;box.checked=true;failedHash=null;errorCode=null;}
      return requestEvidence();
    }
    return Object.freeze({clear,setBusy,requestEvidence,ensurePrepared,snapshot});
  }

  const api=Object.freeze({create});
  root.FalsifyPaperEvidenceUI=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);

/* Optional PDF-only single-occurrence image replacement under RED. Explicit clicks only; owns its own list, preview, result and downloads.
   The RED module passes the bound source and the shared busy hold; this module never reads RED candidates, text exports or the BLUE handoff. */
(function(root){
  'use strict';
  const I=root.FalsifyImageEditorCore||null;
  const NEED_LINK='선택 사항 · 그림 교체는 연결된 로컬 companion이 필요합니다. 연결 없이도 RED 검토·수동 JSON 교환·변경 계획 저장은 그대로 쓸 수 있습니다.';
  const OLD='이 companion은 그림 한 곳 교체를 지원하지 않습니다(구버전). 위 연결 패널 안내로 companion을 업데이트한 뒤 다시 연결하세요. 다른 작업은 그대로 쓸 수 있습니다.';
  const OFF='연결된 companion에 그림 교체 엔진이 준비되지 않았습니다. 위 연결 패널의 설치 안내로 companion을 다시 준비하세요. 다른 작업은 그대로 쓸 수 있습니다.';
  const READY='선택 사항 · 원본 PDF를 연결된 companion에 보내 교체할 수 있는 그림 위치를 셉니다. 모델은 호출하지 않으며 파일을 올리기만 해서는 요청하지 않습니다.';
  const FAILED='요청이 실패했습니다(연결·인증·companion 오류 또는 다른 작업 진행 중). 원본·선택·PNG는 그대로이며 자동으로 다시 시도하지 않습니다.';
  const STALE='진행 중에 원본이나 선택이 바뀌어 결과를 버렸습니다.';
  const EXPORT_FAILED='교체 결과를 확인하지 못해 다운로드하지 않았습니다. 원본·선택·PNG는 그대로입니다.';
  function mount({document:doc=root.document,bridge:B=root.FalsifyLocalBridge,hold}={}){
    const $=id=>doc.getElementById?doc.getElementById(id):doc.querySelector('#'+id),panel=$('image-edit');
    if(!I||!panel||typeof hold!=='function')return null;
    const crypto=root.crypto,URLs=new Set();
    let src=null,occurrences=null,complete=false,selected=null,png=null,output=null,op=null,seq=0,pngSeq=0,locked=false,radios=[];
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const say=(id,s,error=false)=>{const e=$(id);if(!e)return;e.textContent=s;e.classList?.toggle('error',error);};
    const node=(tag,className,text)=>{const x=doc.createElement(tag);if(className)x.className=className;if(text!==undefined)x.textContent=text;return x;};
    function blank(img){if(!img)return;if(img.removeAttribute)img.removeAttribute('src');else img.src='';img.alt='';img.hidden=true;frame(img,null);}
    // Before and After share one frame derived from the selected source box (long side at most 320 px, never wider than the parent);
    // the PNG is stretched into it exactly as the export fills the original box, so its own pixel size never suggests a smaller placement.
    function frame(img,o){const s=img?.style;if(!s)return;if(!o){s.width=s.aspectRatio=s.height=s.objectFit=s.maxHeight='';return;}
      const w=o.bbox[2]-o.bbox[0],h=o.bbox[3]-o.bbox[1];s.width='min(100%, '+Math.floor(320*Math.min(1,w/h)*100)/100+'px)';s.aspectRatio=w+' / '+h;s.height='auto';s.objectFit='fill';s.maxHeight='320px';}
    function revoke(){for(const u of URLs)URL.revokeObjectURL(u);URLs.clear();}
    function save(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type}));URLs.add(url);const a=doc.createElement('a');a.href=url;a.download=name;a.rel='noopener';doc.body.append(a);a.click();a.remove();
      setTimeout(()=>{URL.revokeObjectURL(url);URLs.delete(url);},1000);}
    function cap(){const s=B.state(),c=B.capabilities?.()||s.cap;return {connected:!!s.connected,editor:c?.imageEditor||null};}
    function abort(){const o=op;op=null;seq++;if(o){clearTimeout(o.timer);o.controller?.abort();o.release();}}
    function clearOutput(){output=null;const box=$('image-result');if(box)box.hidden=true;say('image-result-hash','');}
    function clearPng(){pngSeq++;png=null;blank($('image-after'));const input=$('image-png');if(input)input.value='';say('image-png-status','');}
    function reset(){abort();clearOutput();clearPng();blank($('image-before'));occurrences=null;complete=false;selected=null;radios=[];$('image-rows')?.replaceChildren();const field=$('image-occurrences');if(field)field.hidden=true;
      say('image-status','');say('image-export-status','');const consent=$('image-consent');if(consent)consent.checked=false;revoke();render();}
    // The bound root source, or null to cancel everything. Only PDF shows the disclosure; other formats keep it hidden.
    function source(next){reset();src=next&&next.format==='PDF'&&next.file&&typeof next.fileHash==='string'?Object.freeze({file:next.file,fileHash:next.fileHash,token:{}}):null;render();}
    function sync(value){locked=!!value;render();}
    function current(){return occurrences?.find(o=>o.id===selected)||null;}
    function render(){
      panel.hidden=!src;if(!src)return;
      const {connected,editor}=cap(),ready=connected&&editor?.available===true,running=!!op,idle=!running&&!locked,occ=current();
      say('image-note',!connected?NEED_LINK:!editor?OLD:!editor.available?OFF:READY);
      const list=$('image-list');if(list)list.disabled=!idle||!ready;
      for(const r of radios)r.input.disabled=!idle||!r.editable;
      const replace=$('image-replace');if(replace)replace.hidden=!occ;
      const input=$('image-png');if(input)input.disabled=!idle||!occ;
      const consent=$('image-consent');if(consent)consent.disabled=!idle;
      const go=$('image-export');if(go)go.disabled=!idle||!ready||!occ||!png||!consent?.checked;
      for(const id of ['image-download-pdf','image-download-report']){const b=$(id);if(b)b.disabled=!idle||!output;}
      const before=$('image-before');if(before){if(occ?.thumbnail){before.src='data:image/png;base64,'+occ.thumbnail;before.alt='교체 전 그림 미리보기 · '+label(occ);before.hidden=false;frame(before,occ);}else blank(before);}
      const after=$('image-after');if(after&&png)frame(after,occ);
      say('image-before-note',occ&&!occ.thumbnail?'companion이 이 그림의 미리보기를 보내지 않았습니다.':'');
      const warn=$('image-stretch');if(warn){warn.hidden=!occ;warn.textContent=occ?(png&&I.stretch(occ,png.info)?'주의: PNG 비율('+png.info.width+'×'+png.info.height+' px)이 원래 상자 비율과 달라 늘어나거나 눌려 보입니다. ':'')+'교체 그림은 원래 상자(같은 쪽·같은 위치·같은 크기)를 그대로 채웁니다.':'';warn.classList?.toggle('error',!!(occ&&png&&I.stretch(occ,png.info)));}
    }
    function label(o){return I.label(o,occurrences.indexOf(o));}
    // One request at a time against one link snapshot, under the shared RED hold, a 95 s deadline and a sequence check.
    async function run(body,path){
      const {connected,editor}=cap();if(op||locked||!src||!connected||editor?.available!==true)return null;
      const l=B.session();if(!l){say('image-status',NEED_LINK,true);return null;}
      const release=hold();if(!release)return null;
      const id=++seq,controller=typeof AbortController==='function'?new AbortController():null,self={controller,release,timer:null,expired:false};op=self;render();
      const deadline=new Promise((_,reject)=>{self.timer=setTimeout(()=>{self.expired=true;controller?.abort();reject(new Error('deadline'));},I.DEADLINE_MS);});
      try{const payload=await Promise.race([body(),deadline]);if(op!==self||id!==seq)return null;
        const res=await Promise.race([l.request(path,payload,controller?{signal:controller.signal}:undefined),deadline]);
        return op===self&&id===seq?{res}:null;}
      catch(e){if(op!==self||id!==seq)return null;return {error:self.expired?'deadline':e};}
      finally{clearTimeout(self.timer);if(op===self){op=null;release();render();}}
    }
    // Reads the bound file again and refuses if its bytes no longer match the hash bound at upload.
    async function sourceBase64(s){if(s.file.size>I.MAX_FILE_BYTES)throw Object.assign(new Error('25 MiB를 넘는 PDF는 그림 교체에 쓰지 않습니다.'),{image:true});
      const bytes=new Uint8Array(await s.file.arrayBuffer());if(await hash(bytes)!==s.fileHash)throw Object.assign(new Error('원본 파일이 올린 뒤 바뀌어 요청하지 않았습니다. 원본을 다시 올리세요.'),{image:true});return I.encode(bytes);}
    // Fixed copy only: deadline, local preflight, or a fixed companion code/reason kept by the bridge. Error message text is never interpreted.
    function failure(e,kind){if(e==='deadline')return (kind==='list'?'그림 목록 요청':'그림 교체 요청')+'이 '+I.DEADLINE_MS/1000+'초 안에 끝나지 않아 중단했습니다. 원본·선택·PNG는 그대로이며 자동으로 다시 시도하지 않습니다.';
      if(e?.image)return e.message;return I.refusal(kind,e?.code,e?.reason)||FAILED;}
    $('image-list')?.addEventListener('click',async()=>{
      if(!src||op)return;const s=src;clearOutput();
      say('image-status','원본 PDF에서 교체할 수 있는 그림 위치를 찾는 중입니다. 모델은 호출하지 않으며 '+I.DEADLINE_MS/1000+'초가 지나면 중단합니다.');
      const r=await run(async()=>I.listRequest(s.fileHash,await sourceBase64(s)),'/api/paper/images');if(!r||src!==s)return;
      if(r.error){say('image-status',failure(r.error,'list'),true);render();return;}
      let v;try{v=I.list(r.res,{sourceSha256:s.fileHash});}catch(e){say('image-status',e.image?e.message:FAILED,true);render();return;}
      const keep=v.occurrences.some(o=>o.id===selected&&o.editable)?selected:null;occurrences=v.occurrences;complete=v.complete;selected=keep;rows();
      const editable=occurrences.filter(o=>o.editable).length;
      say('image-status','그림 위치 '+occurrences.length+'곳 · 교체 가능 '+editable+'곳'+(complete?'':' · 목록이 완전하지 않습니다. 빠진 그림이 있을 수 있으며 전체를 검사했다고 보지 않습니다.')+(editable?' 한 곳을 고르세요.':''));render();});
    function rows(){const box=$('image-rows'),field=$('image-occurrences');radios=[];if(!box||!field)return;box.replaceChildren();field.hidden=false;
      if(!occurrences.length){box.append(node('p','muted','교체할 수 있는 그림 위치를 찾지 못했습니다.'));return;}
      occurrences.forEach((o,k)=>{const row=node('label','image-row'+(o.editable?'':' unsupported')),input=doc.createElement('input');input.type='radio';input.name='image-occurrence';input.value=o.id;input.checked=o.id===selected;
        const text=node('span','image-row-text');text.append(node('span','image-row-title',I.label(o,k)));
        if(o.shared)text.append(node('span','image-row-note','같은 그림 리소스를 다른 곳에서도 씀 · 이 위치만 교체합니다'));
        if(!o.editable)text.append(node('span','image-row-note image-row-reason','교체 불가 · '+I.reason(o.reason)));
        row.append(input);if(o.thumbnail){const img=doc.createElement('img');img.className='image-thumb';img.src='data:image/png;base64,'+o.thumbnail;img.alt='p. '+(o.pageIndex+1)+' 그림 '+(k+1)+' 미리보기';row.append(img);}
        row.append(text);input.addEventListener('change',()=>{if(!input.checked||op||locked||!o.editable)return;if(selected!==o.id){selected=o.id;clearOutput();say('image-export-status','');}render();});
        radios.push({input,editable:o.editable});box.append(row);});}
    // Manual PNG only: size and IHDR are checked before the browser decodes it; the preview is a data: URL of the same bytes.
    $('image-png')?.addEventListener('change',async()=>{
      const input=$('image-png'),f=input.files?.[0],id=++pngSeq;png=null;clearOutput();say('image-export-status','');const after=$('image-after');blank(after);render();
      if(!f){say('image-png-status','');return;}
      try{if(f.size>I.MAX_PNG_BYTES)throw Object.assign(new Error('교체 PNG는 4 MiB 이하만 쓸 수 있습니다.'),{image:true});
        const bytes=new Uint8Array(await f.arrayBuffer());if(id!==pngSeq)return;const info=I.png(bytes),base64=I.encode(bytes);
        png=Object.freeze({bytes,base64,info,name:String(f.name||'').slice(0,120)});
        if(after){after.src='data:image/png;base64,'+base64;after.alt='교체할 PNG 미리보기 · '+info.width+'×'+info.height+' px';after.hidden=false;}
        say('image-png-status','PNG '+info.width+'×'+info.height+' px'+(info.alpha?' · 알파 채널 포함':''));}
      catch(e){if(id!==pngSeq)return;png=null;say('image-png-status',e.image?e.message:'PNG를 읽지 못했습니다.',true);}
      render();});
    $('image-consent')?.addEventListener('change',render);
    $('image-export')?.addEventListener('click',async()=>{
      const occ=current(),s=src,p=png;if(!s||!occ||!p||op||!$('image-consent')?.checked)return;clearOutput();
      say('image-export-status','선택한 그림 한 곳만 교체하고 엔진 자체 렌더 검사를 하는 중입니다. 퍼센트 진행률은 없으며 '+I.DEADLINE_MS/1000+'초가 지나면 중단합니다.');
      const r=await run(async()=>I.exportRequest(s.fileHash,await sourceBase64(s),occ.id,p.base64),'/api/paper/images/export');
      if(!r||src!==s)return;if(selected!==occ.id||png!==p){say('image-export-status',STALE);render();return;}
      if(r.error){say('image-export-status',failure(r.error,'export'),true);render();return;}
      let v;try{v=I.exportResult(r.res,{sourceSha256:s.fileHash,occurrence:occ});}catch(e){say('image-export-status',e.image?e.message:EXPORT_FAILED,true);render();return;}
      const actual=await hash(v.bytes);if(src!==s||selected!==occ.id||png!==p||op)return;
      if(actual!==v.outputSha256){say('image-export-status','companion이 보고한 출력 해시와 받은 파일이 달라 결과를 버렸습니다.',true);render();return;}
      output=Object.freeze({...v,occurrence:occ});const box=$('image-result');if(box)box.hidden=false;
      say('image-result-hash','출력 SHA-256 '+actual);
      say('image-export-status','교체한 실험용 PDF를 만들었습니다 · 바뀐 그림 1곳 · 엔진 자체 렌더 검사 통과(같은 엔진의 확인이며 독립 검사가 아닙니다) · 도메인 검수 대기. 아래에서 PDF와 보고서 JSON을 따로 내려받으세요.');render();});
    // Each download recomputes the output hash in the browser right before saving.
    async function verified(){const o=output;if(!o||op)return null;const actual=await hash(o.bytes);if(output!==o)return null;
      if(actual!==o.outputSha256){clearOutput();say('image-export-status','출력 해시가 맞지 않아 다운로드하지 않았습니다.',true);render();return null;}return o;}
    $('image-download-pdf')?.addEventListener('click',async()=>{const o=await verified();if(o)save(o.bytes,o.filename,'application/pdf');});
    $('image-download-report')?.addEventListener('click',async()=>{const o=await verified();if(o)save(new TextEncoder().encode(JSON.stringify(o.report,null,2)),I.REPORT_FILENAME,'application/json');});
    doc.addEventListener('falsify:local-bridge',render);
    render();
    return Object.freeze({source,sync});
  }
  const api=Object.freeze({mount});
  if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyImageEditor=api;
})(globalThis);

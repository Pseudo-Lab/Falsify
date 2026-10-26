/* In-memory paper edit session. Classic UMD, CommonJS for tests.
   Records provenance, exact ranges and bounded history. Does not render, persist,
   call a model, or touch browser storage, the DOM or the network.
   Original Workbench code, AGPL-3.0-only. No third-party source. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyPaperEdits=api;
})(globalThis,function(){
  'use strict';
  const SCHEMA='falsify.paper-edits.v1',DRAFT_SCHEMA='falsify.paper-edits-draft.v1',TTL_MS=12*60*60*1000;
  const ORIGINS=Object.freeze(['human','external-ai-import','ai-proposal']);
  const HEX64=/^[0-9a-f]{64}$/;
  const FORBIDDEN_KEY=/^(?:token|authorization|bearer|cookie|password|secret|session|sessiontoken|apikey|api_key|credential|credentials|file|bytes|pdf|pdfbytes|sourcepdf|sourcebytes)$/i;
  const LIMITS=Object.freeze({
    maxName:160,maxSegments:2000,maxSegmentText:200000,maxTotalText:1000000,maxLabel:200,maxId:80,
    maxText:4000,maxEdits:32,maxHistory:12,maxUndo:100,maxPageIndex:9999,maxOccurrences:1000,
    maxCoord:100000,maxFont:128,maxFontSize:1000,maxDraftChars:4000000,maxDepth:32,maxTime:8640000000000000
  });
  const SNAPSHOT_KEYS=['schema','fileHash','name','revision','edits','canUndo','canRedo'];
  const EDIT_KEYS=['id','enabled','before','after','anchor','origin','pageIndex','segmentId','createdAt','updatedAt','history'];
  const ANCHOR_KEYS=['start','end','occurrence','bbox','style'];
  const HISTORY_KEYS=['revision','at','after','enabled','anchor'];
  const STYLE_KEYS=['font','size','color'];
  const ADD_KEYS=['pageIndex','segmentId','before','after','anchor','origin'];
  const UPDATE_KEYS=['after','anchor'];
  const DRAFT_KEYS=['schema','fileHash','savedAt','expiresAt','snapshot'];

  function fail(code,message){const e=new Error(message);e.code=code;e.paperEdits=true;throw e;}
  function isPlain(o){if(!o||typeof o!=='object'||Array.isArray(o))return false;const p=Object.getPrototypeOf(o);return p===Object.prototype||p===null;}
  function forbiddenKey(k){return k==='__proto__'||k==='constructor'||k==='prototype'||FORBIDDEN_KEY.test(k);}
  function hasCtl(s){return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);}
  function clone(value){let raw;try{raw=JSON.stringify(value);}catch{fail('invalid','JSON으로 표현할 수 없는 값입니다.');}if(typeof raw!=='string')fail('invalid','JSON으로 표현할 수 없는 값입니다.');try{return JSON.parse(raw);}catch{fail('invalid','JSON으로 표현할 수 없는 값입니다.');}}
  function integer(value,min,max){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;}
  function time(value,label){if(!integer(value,0,LIMITS.maxTime))fail('invalid',label+' 시각이 유한한 정수 범위가 아닙니다.');return value;}
  function ownKeys(o){if(!isPlain(o))return null;return Object.keys(o);}
  function rejectKeys(keys,code){for(const k of keys)if(forbiddenKey(k))fail(code,'비밀이나 원본 PDF 바이트로 보이는 키는 넣을 수 없습니다.');}
  function allowKeys(o,allowed,required,code,what){
    const keys=ownKeys(o);if(!keys)fail(code,what+' 형식이 올바르지 않습니다.');
    rejectKeys(keys,code);
    for(const k of keys)if(!allowed.includes(k))fail(code,what+'에 허용되지 않은 필드가 있습니다.');
    for(const k of required)if(!Object.hasOwn(o,k))fail(code,what+'에 필수 필드가 없습니다.');
    return keys;
  }
  function dense(list,code,what){
    if(!Array.isArray(list))fail(code,what+' 목록이 올바르지 않습니다.');
    for(let i=0;i<list.length;i++)if(!Object.hasOwn(list,i))fail(code,what+' 목록이 올바르지 않습니다.');
    return list;
  }
  function text(value,max,label,code){
    if(typeof value!=='string'||value.length<1||value.length>max||hasCtl(value)||!value.trim())fail(code||'invalid',label+' 형식/길이가 올바르지 않습니다.');
    return value;
  }
  // "" is a real deletion. Any other blank After is still rejected, and After === Before stays a no-op.
  function afterText(value,code){
    if(typeof value!=='string'||value.length>LIMITS.maxText||hasCtl(value)||(value.length>0&&!value.trim()))fail(code||'invalid','After 형식/길이가 올바르지 않습니다.');
    return value;
  }
  function labelOf(value){if(typeof value!=='string'||value.length<1||value.length>LIMITS.maxLabel||hasCtl(value)||value.trim()!==value)fail('invalid','문단 이름이 올바르지 않습니다.');return value;}
  function idOf(value,label,code){if(typeof value!=='string'||value.length<1||value.length>LIMITS.maxId||hasCtl(value)||value.trim()!==value)fail(code||'invalid',label+'가 올바르지 않습니다.');return value;}
  function pageOf(value,code){if(!integer(value,0,LIMITS.maxPageIndex))fail(code||'invalid','쪽 번호가 올바르지 않습니다.');return value;}
  function hashOf(value,code){if(typeof value!=='string'||!HEX64.test(value))fail(code||'invalid','파일 해시가 올바르지 않습니다.');return value;}
  function nameOf(value,code){if(typeof value!=='string'||value.length<1||value.length>LIMITS.maxName||hasCtl(value)||value.trim()!==value)fail(code||'invalid','문서 이름이 올바르지 않습니다.');return value;}
  function originOf(value,code){if(!ORIGINS.includes(value))fail(code||'invalid','편집 출처는 human, external-ai-import, ai-proposal 중 하나여야 합니다.');return value;}
  function bboxOf(value,code){
    dense(value,code,'영역');if(value.length!==4)fail(code,'영역은 네 개의 유한한 좌표여야 합니다.');
    const n=value.map(v=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>LIMITS.maxCoord)fail(code,'영역 좌표가 유한한 범위를 벗어납니다.');return v;});
    if(!(n[0]<n[2]&&n[1]<n[3]))fail(code,'영역 좌표의 순서가 올바르지 않습니다.');
    return n;
  }
  function styleOf(value,code){
    allowKeys(value,STYLE_KEYS,STYLE_KEYS,code,'글꼴 힌트');
    if(typeof value.font!=='string'||value.font.length<1||value.font.length>LIMITS.maxFont||hasCtl(value.font))fail(code,'글꼴 이름이 올바르지 않습니다.');
    if(typeof value.size!=='number'||!Number.isFinite(value.size)||value.size<=0||value.size>LIMITS.maxFontSize)fail(code,'글꼴 크기가 유한한 범위를 벗어납니다.');
    if(!integer(value.color,0,0xffffff))fail(code,'글꼴 색이 올바르지 않습니다.');
    return {font:value.font,size:value.size,color:value.color};
  }
  function sameAnchor(a,b){return a.start===b.start&&a.end===b.end&&a.occurrence===b.occurrence&&JSON.stringify(a.bbox)===JSON.stringify(b.bbox)&&JSON.stringify(a.style)===JSON.stringify(b.style);}
  function storedAnchor(anchor,code){
    allowKeys(anchor,ANCHOR_KEYS,ANCHOR_KEYS,code,'anchor');
    if(!integer(anchor.start,0,LIMITS.maxSegmentText)||!integer(anchor.end,1,LIMITS.maxSegmentText)||anchor.end<=anchor.start)fail(code,'anchor 범위가 올바르지 않습니다.');
    if(!integer(anchor.occurrence,0,LIMITS.maxOccurrences-1))fail(code,'occurrence가 올바르지 않습니다.');
    if(anchor.bbox!==null)bboxOf(anchor.bbox,code);
    if(anchor.style!==null)styleOf(anchor.style,code);
    return {start:anchor.start,end:anchor.end,occurrence:anchor.occurrence,bbox:anchor.bbox?anchor.bbox.slice():null,style:anchor.style?styleOf(anchor.style,code):null};
  }
  function inputAnchor(anchor,before){
    if(anchor==null)return {start:null,end:null,occurrence:null,bbox:null,style:null};
    allowKeys(anchor,['bbox','occurrence','start','end','style'],[],'invalid','anchor');
    let start=null,end=null,occurrence=null;
    if(Object.hasOwn(anchor,'start')||Object.hasOwn(anchor,'end')){
      if(!Object.hasOwn(anchor,'start')||!Object.hasOwn(anchor,'end'))fail('invalid','anchor의 start와 end는 함께 있어야 합니다.');
      if(!integer(anchor.start,0,LIMITS.maxSegmentText)||!integer(anchor.end,1,LIMITS.maxSegmentText))fail('invalid','anchor 범위가 올바르지 않습니다.');
      if(anchor.end-anchor.start!==before.length)fail('invalid','anchor 범위가 Before 길이와 다릅니다.');
      start=anchor.start;end=anchor.end;
    }
    if(Object.hasOwn(anchor,'occurrence')){if(!integer(anchor.occurrence,0,LIMITS.maxOccurrences-1))fail('invalid','occurrence가 올바르지 않습니다.');occurrence=anchor.occurrence;}
    return {start,end,occurrence,bbox:Object.hasOwn(anchor,'bbox')?bboxOf(anchor.bbox,'invalid'):null,style:Object.hasOwn(anchor,'style')?styleOf(anchor.style,'invalid'):null};
  }
  function hitsOf(hay,needle){
    const hits=[];let from=0;
    while(from<hay.length){
      const i=hay.indexOf(needle,from);if(i<0)break;
      hits.push(i);if(hits.length>LIMITS.maxOccurrences)fail('invalid','한 문단의 같은 인용이 너무 많습니다.');
      from=i+1;
    }
    return hits;
  }
  function rangesOverlap(list,code){
    for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
      const a=list[i],b=list[j];
      if(a.segmentId===b.segmentId&&a.anchor.start<b.anchor.end&&b.anchor.start<a.anchor.end)fail(code||'overlap','같은 문단에서 범위가 겹치는 편집은 둘 다 둘 수 없습니다.');
    }
  }
  function historyEntry(entry,edit,code){
    allowKeys(entry,HISTORY_KEYS,HISTORY_KEYS,code,'이력');
    if(!integer(entry.revision,0,LIMITS.maxTime)||!integer(entry.at,0,LIMITS.maxTime))fail(code,'이력 시각/리비전이 올바르지 않습니다.');
    afterText(entry.after,code);
    if(entry.after===edit.before)fail(code,'Before와 After가 같습니다.');
    if(typeof entry.enabled!=='boolean')fail(code,'enabled는 true 또는 false여야 합니다.');
    const anchor=storedAnchor(entry.anchor,code);
    if(anchor.start!==edit.anchor.start||anchor.end!==edit.anchor.end||anchor.occurrence!==edit.anchor.occurrence)fail(code,'이력의 원문 범위가 편집과 다릅니다.');
    return {revision:entry.revision,at:entry.at,after:entry.after,enabled:entry.enabled,anchor};
  }
  function storedEdit(edit,code){
    allowKeys(edit,EDIT_KEYS,EDIT_KEYS,code,'편집');
    const id=idOf(edit.id,'편집 ID',code),before=text(edit.before,LIMITS.maxText,'Before',code),after=afterText(edit.after,code);
    if(before===after)fail(code,'Before와 After가 같습니다.');
    if(typeof edit.enabled!=='boolean')fail(code,'enabled는 true 또는 false여야 합니다.');
    const anchor=storedAnchor(edit.anchor,code),origin=originOf(edit.origin,code),pageIndex=pageOf(edit.pageIndex,code),segmentId=idOf(edit.segmentId,'문단 ID',code);
    if(anchor.end-anchor.start!==before.length)fail(code,'anchor 범위가 Before 길이와 다릅니다.');
    if(!integer(edit.createdAt,0,LIMITS.maxTime)||!integer(edit.updatedAt,0,LIMITS.maxTime)||edit.createdAt>edit.updatedAt)fail(code,'편집 시각이 올바르지 않습니다.');
    dense(edit.history,code,'이력');
    if(edit.history.length<1||edit.history.length>LIMITS.maxHistory)fail(code,'편집 이력이 한도를 벗어납니다.');
    const base={id,enabled:edit.enabled,before,after,anchor,origin,pageIndex,segmentId,createdAt:edit.createdAt,updatedAt:edit.updatedAt,history:[]};
    const history=edit.history.map(item=>historyEntry(item,base,code));
    const last=history[history.length-1],first=history[0];
    if(first.at!==base.createdAt||last.at!==base.updatedAt||last.after!==after||last.enabled!==base.enabled||!sameAnchor(last.anchor,anchor))fail(code,'편집 이력이 현재 After와 맞지 않습니다.');
    return {...base,history};
  }
  function snapshotValue(value,code){
    allowKeys(value,SNAPSHOT_KEYS,SNAPSHOT_KEYS,code,'스냅샷');
    if(value.schema!==SCHEMA)fail(code,'스냅샷 스키마가 올바르지 않습니다.');
    const fileHash=hashOf(value.fileHash,code),name=nameOf(value.name,code);
    if(!integer(value.revision,0,LIMITS.maxTime))fail(code,'리비전이 올바르지 않습니다.');
    if(typeof value.canUndo!=='boolean'||typeof value.canRedo!=='boolean')fail(code,'undo/redo 상태가 올바르지 않습니다.');
    dense(value.edits,code,'편집');
    if(value.edits.length>LIMITS.maxEdits)fail(code,'편집 수가 한도를 벗어납니다.');
    const edits=value.edits.map(edit=>storedEdit(edit,code)),ids=new Set();
    for(const edit of edits){if(ids.has(edit.id))fail(code,'편집 ID가 중복됩니다.');ids.add(edit.id);}
    rangesOverlap(edits,code);
    return {schema:SCHEMA,fileHash,name,revision:value.revision,edits,canUndo:value.canUndo,canRedo:value.canRedo};
  }
  function walkSecrets(value,depth){
    if(!value||typeof value!=='object')return;
    if(depth>LIMITS.maxDepth)fail('malformed','초안 중첩이 너무 깊습니다.');
    if(!Array.isArray(value)){const keys=ownKeys(value);if(!keys)fail('malformed','초안 형식이 올바르지 않습니다.');rejectKeys(keys,'malformed');for(const k of keys)walkSecrets(value[k],depth+1);return;}
    dense(value,'malformed','초안');
    for(const item of value)walkSecrets(item,depth+1);
  }
  function segmentsOf(list){
    dense(list,'invalid','문단');
    if(list.length>LIMITS.maxSegments)fail('invalid','문단 수가 한도를 벗어납니다.');
    let total=0;const ids=new Set(),out=[];
    for(const raw of list){
      allowKeys(raw,['id','label','text','pageIndex'],['id','label','text'],'invalid','문단');
      const id=idOf(raw.id,'문단 ID');if(ids.has(id))fail('invalid','문단 ID가 중복됩니다.');ids.add(id);
      const label=labelOf(raw.label);
      if(typeof raw.text!=='string'||raw.text.length>LIMITS.maxSegmentText||hasCtl(raw.text))fail('invalid','문단 텍스트가 올바르지 않습니다.');
      total+=raw.text.length;if(total>LIMITS.maxTotalText)fail('invalid','문단 텍스트가 한도를 벗어납니다.');
      const pageIndex=Object.hasOwn(raw,'pageIndex')?pageOf(raw.pageIndex):null;
      out.push(Object.freeze({id,label,text:raw.text,pageIndex}));
    }
    return Object.freeze(out);
  }
  function makeClock(now){
    if(typeof now==='function')return ()=>time(now(),'now');
    if(now!=null)time(now,'now');
    return ()=>time(Date.now(),'now');
  }
  function publicEdit(edit){return clone(edit);}
  function viewOf(state){return {schema:SCHEMA,fileHash:state.fileHash,name:state.name,revision:state.revision,edits:state.edits.map(publicEdit),canUndo:state.past.length>0,canRedo:state.future.length>0};}
  function emit(state){
    const listeners=[...state.subs];
    for(const sub of listeners){
      if(!state.subs.has(sub))continue;
      try{sub.fn(clone(viewOf(state)));}
      catch(error){try{if(sub.onError)sub.onError(error);}catch{/* a notifier must not fail the committed edit */}}
    }
  }
  function commit(state,nextEdits){
    if(state.past.length>=LIMITS.maxUndo)state.past.shift();
    state.past.push({revision:state.revision,edits:clone(state.edits)});
    state.future=[];
    state.edits=nextEdits;
    state.revision=state.nextRevision++;
    emit(state);
  }
  function findEdit(state,id){if(typeof id!=='string')fail('unknown-id','편집 ID가 없습니다.');const edit=state.edits.find(e=>e.id===id);if(!edit)fail('unknown-id','편집 ID가 없습니다.');return edit;}
  function capHistory(history,entry){
    const next=history.map(item=>clone(item));
    next.push(clone(entry));
    while(next.length>LIMITS.maxHistory)next.splice(1,1);
    return next;
  }
  function locate(segments,input){
    allowKeys(input,ADD_KEYS,['pageIndex','before','after','origin'],'invalid','편집');
    const pageIndex=pageOf(input.pageIndex),before=text(input.before,LIMITS.maxText,'Before'),after=afterText(input.after),origin=originOf(input.origin);
    if(before===after)fail('invalid','Before와 After가 같습니다.');
    const hinted=inputAnchor(Object.hasOwn(input,'anchor')?input.anchor:null,before);
    let segmentId=null;
    if(Object.hasOwn(input,'segmentId')){segmentId=idOf(input.segmentId,'문단 ID');if(!segments.some(s=>s.id===segmentId))fail('invalid','문단 ID가 원문에 없습니다.');}
    const pool=[];
    for(const seg of segments){
      if(segmentId&&seg.id!==segmentId)continue;
      if(!segmentId&&seg.pageIndex!==pageIndex)continue;
      if(segmentId&&seg.pageIndex!=null&&seg.pageIndex!==pageIndex)fail('invalid','편집 쪽 번호가 문단의 쪽 번호와 다릅니다.');
      const hits=hitsOf(seg.text,before);
      hits.forEach((start,occurrence)=>pool.push({segmentId:seg.id,start,end:start+before.length,occurrence}));
    }
    if(!pool.length)fail('invalid','원문 인용이 없습니다.');
    let chosen;
    if(hinted.start!=null){
      const found=pool.filter(p=>p.start===hinted.start&&p.end===hinted.end);
      if(found.length!==1)fail('duplicate-anchor','지정한 범위가 원문 인용과 일치하는 한 곳이 아닙니다.');
      chosen=found[0];
      if(hinted.occurrence!=null&&hinted.occurrence!==chosen.occurrence)fail('invalid','occurrence가 지정한 범위와 다릅니다.');
    }else if(hinted.occurrence!=null){
      const segs=new Set(pool.map(p=>p.segmentId));
      if(segs.size!==1)fail('duplicate-anchor','같은 인용이 여러 문단에 있습니다. segmentId로 한 문단을 지정하세요.');
      chosen=pool.find(p=>p.occurrence===hinted.occurrence);
      if(!chosen)fail('invalid','occurrence가 원문 인용 범위를 벗어납니다.');
    }else if(pool.length!==1)fail('duplicate-anchor','원문 인용이 중복됩니다. occurrence 또는 start/end로 한 곳을 지정하세요.');
    else chosen=pool[0];
    return {before,after,origin,pageIndex,segmentId:chosen.segmentId,anchor:{start:chosen.start,end:chosen.end,occurrence:chosen.occurrence,bbox:hinted.bbox,style:hinted.style}};
  }
  function rebind(segments,edit){
    const seg=segments.find(s=>s.id===edit.segmentId);
    if(!seg)fail('invalid','문단 ID가 원문에 없습니다.');
    if(seg.pageIndex!=null&&seg.pageIndex!==edit.pageIndex)fail('invalid','편집 쪽 번호가 문단의 쪽 번호와 다릅니다.');
    if(seg.text.slice(edit.anchor.start,edit.anchor.end)!==edit.before)fail('invalid','원문 범위가 현재 문단과 맞지 않습니다.');
    const hits=hitsOf(seg.text,edit.before);
    if(hits[edit.anchor.occurrence]!==edit.anchor.start)fail('invalid','occurrence가 현재 문단과 맞지 않습니다.');
    return edit;
  }
  function nextIdFrom(edits){
    let next=1;
    for(const edit of edits){
      const m=/^e(\d+)$/.exec(edit.id);if(!m)continue;
      const n=Number(m[1]);
      if(!Number.isSafeInteger(n)||n<1)continue;
      if(n>=Number.MAX_SAFE_INTEGER-1)return Number.MAX_SAFE_INTEGER;
      if(n+1>next)next=n+1;
    }
    return next;
  }
  function create(input){
    allowKeys(input,['fileHash','name','segments','now','id','resume'],['fileHash','name','segments'],'invalid','세션');
    const fileHash=hashOf(input.fileHash),name=nameOf(input.name),segments=segmentsOf(input.segments),clock=makeClock(Object.hasOwn(input,'now')?input.now:null);
    const sessionId=Object.hasOwn(input,'id')?idOf(input.id,'세션 ID'):null;
    let edits=[],revision=0,nextRevision=1;
    if(Object.hasOwn(input,'resume')){
      const resumed=snapshotValue(input.resume,'invalid');
      if(resumed.fileHash!==fileHash||resumed.name!==name)fail('invalid','이어받을 스냅샷이 이 파일/이름과 맞지 않습니다.');
      edits=resumed.edits.map(edit=>rebind(segments,edit));
      rangesOverlap(edits);
      revision=resumed.revision;nextRevision=revision+1;
    }
    const state={fileHash,name,segments,edits,revision,nextRevision,nextId:nextIdFrom(edits),past:[],future:[],subs:new Set()};
    function allocate(){
      if(!Number.isSafeInteger(state.nextId)||state.nextId<1||state.nextId>=Number.MAX_SAFE_INTEGER)fail('invalid','편집 ID 한도를 넘었습니다.');
      return 'e'+state.nextId++;
    }
    function snapshot(){return clone(viewOf(state));}
    function add(edit){
      if(state.edits.length>=LIMITS.maxEdits)fail('invalid','편집 수가 한도를 벗어납니다.');
      const located=locate(state.segments,edit),at=clock();
      const row={id:'',enabled:true,before:located.before,after:located.after,anchor:located.anchor,origin:located.origin,pageIndex:located.pageIndex,segmentId:located.segmentId,createdAt:at,updatedAt:at,
        history:[{revision:state.nextRevision,at,after:located.after,enabled:true,anchor:clone(located.anchor)}]};
      const next=state.edits.concat([row]);
      rangesOverlap(next);
      row.id=allocate();
      commit(state,next);
      return row.id;
    }
    function update(id,changes){
      const current=findEdit(state,id);
      allowKeys(changes,UPDATE_KEYS,[], 'invalid','변경');
      if(!Object.keys(changes).length)fail('invalid','변경 내용이 없습니다.');
      let after=current.after,anchor=clone(current.anchor);
      if(Object.hasOwn(changes,'after')){after=afterText(changes.after);if(after===current.before)fail('invalid','Before와 After가 같습니다.');}
      if(Object.hasOwn(changes,'anchor')){
        if(!isPlain(changes.anchor))fail('invalid','anchor 형식이 올바르지 않습니다.');
        const hinted=inputAnchor(changes.anchor,current.before);
        if(hinted.start!=null&&(hinted.start!==current.anchor.start||hinted.end!==current.anchor.end))fail('invalid','원문 범위는 바꿀 수 없습니다.');
        if(hinted.occurrence!=null&&hinted.occurrence!==current.anchor.occurrence)fail('invalid','occurrence는 바꿀 수 없습니다.');
        anchor={start:current.anchor.start,end:current.anchor.end,occurrence:current.anchor.occurrence,bbox:Object.hasOwn(changes.anchor,'bbox')?hinted.bbox:current.anchor.bbox,style:Object.hasOwn(changes.anchor,'style')?hinted.style:current.anchor.style};
      }
      if(after===current.after&&sameAnchor(anchor,current.anchor))fail('invalid','변경 내용이 없습니다.');
      const at=clock();
      const row={...current,before:current.before,after,anchor,updatedAt:at,history:capHistory(current.history,{revision:state.nextRevision,at,after,enabled:current.enabled,anchor})};
      commit(state,state.edits.map(item=>item.id===id?row:item));
    }
    function remove(id){findEdit(state,id);commit(state,state.edits.filter(item=>item.id!==id));}
    function setEnabled(id,enabled){
      if(typeof enabled!=='boolean')fail('invalid','enabled는 true 또는 false여야 합니다.');
      const current=findEdit(state,id);if(current.enabled===enabled)return;
      const at=clock(),anchor=clone(current.anchor);
      const row={...current,enabled,updatedAt:at,history:capHistory(current.history,{revision:state.nextRevision,at,after:current.after,enabled,anchor})};
      commit(state,state.edits.map(item=>item.id===id?row:item));
    }
    function undo(){if(!state.past.length)fail('undo-empty','되돌릴 편집이 없습니다.');state.future.push({revision:state.revision,edits:clone(state.edits)});const prev=state.past.pop();state.revision=prev.revision;state.edits=prev.edits;emit(state);}
    function redo(){if(!state.future.length)fail('redo-empty','다시 실행할 편집이 없습니다.');state.past.push({revision:state.revision,edits:clone(state.edits)});const nxt=state.future.pop();state.revision=nxt.revision;state.edits=nxt.edits;emit(state);}
    function subscribe(fn,onError){
      if(typeof fn!=='function')fail('invalid','구독 함수가 필요합니다.');
      if(onError!=null&&typeof onError!=='function')fail('invalid','구독 오류 콜백은 함수여야 합니다.');
      const sub={fn,onError:onError||null};
      state.subs.add(sub);let dead=false;
      return function unsubscribe(){if(dead)return;dead=true;state.subs.delete(sub);};
    }
    return Object.freeze({id:sessionId,snapshot,add,update,remove,setEnabled,undo,redo,subscribe});
  }
  function draft(input){
    allowKeys(input,['snapshot','now'],['snapshot'],'malformed','초안');
    const now=time(Object.hasOwn(input,'now')?input.now:Date.now(),'now');
    walkSecrets(input.snapshot,0);
    const snapshot=snapshotValue(clone(input.snapshot),'malformed');
    return clone({schema:DRAFT_SCHEMA,fileHash:snapshot.fileHash,savedAt:now,expiresAt:now+TTL_MS,snapshot});
  }
  function restoreDraft(envelope,options){
    allowKeys(options||{},['fileHash','now'],['fileHash'],'malformed','초안 확인');
    const now=time(Object.hasOwn(options,'now')?options.now:Date.now(),'now'),expected=hashOf(options.fileHash,'hash-mismatch');
    let value=envelope;
    if(typeof envelope==='string'){
      if(envelope.length<2||envelope.length>LIMITS.maxDraftChars)fail('malformed','초안 형식이 올바르지 않습니다.');
      try{value=JSON.parse(envelope);}catch{fail('malformed','초안 형식이 올바르지 않습니다.');}
    }
    if(!isPlain(value))fail('malformed','초안 형식이 올바르지 않습니다.');
    walkSecrets(value,0);
    allowKeys(value,DRAFT_KEYS,DRAFT_KEYS,'malformed','초안');
    if(value.schema!==DRAFT_SCHEMA)fail('malformed','초안 스키마가 올바르지 않습니다.');
    hashOf(value.fileHash,'malformed');
    if(!integer(value.savedAt,0,LIMITS.maxTime-TTL_MS)||value.expiresAt!==value.savedAt+TTL_MS)fail('malformed','초안 만료 시각이 올바르지 않습니다.');
    if(value.fileHash!==expected)fail('hash-mismatch','초안이 이 파일 해시와 맞지 않습니다.');
    const snapshot=snapshotValue(value.snapshot,'malformed');
    if(snapshot.fileHash!==expected)fail('hash-mismatch','초안이 이 파일 해시와 맞지 않습니다.');
    if(now<value.savedAt)fail('malformed','초안 시각이 확인 시각보다 늦습니다.');
    if(now>=value.expiresAt)fail('expired','초안이 만료되었습니다.');
    return clone(snapshot);
  }
  return Object.freeze({SCHEMA,DRAFT_SCHEMA,TTL_MS,ORIGINS,LIMITS,create,draft,restoreDraft});
});

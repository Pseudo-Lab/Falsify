/* Manual edit provenance and human review. Not a model run, harness, or attestation.
   Root includes this script and paper-manual-records.css. This file does not edit index.html.
   Team publication goes through the existing Confluence session and gateway. */
(function(){
  'use strict';
  const script=document.currentScript;
  const BUNDLE_URL=script&&script.src?new URL('./review-bundle.mjs', script.src).href:null;
  const CODEC_URL=BUNDLE_URL?new URL(BUNDLE_URL):null;
  if(CODEC_URL)CODEC_URL.search=new URL(script.src).search;
  const TTL=12*60*60*1000;
  const HEX=/^[a-f0-9]{64}$/;
  const ORIGIN_LABEL={human:'사람 편집', 'external-ai-import':'외부 AI 가져오기', 'ai-proposal':'작업대 AI 제안'};
  const locals=[];
  let imported=null, activeId='', selectedKey='', consentFor='', sharing=false, shareEpoch=0, blues=[], captureEpoch=0;
  const ui={}, state={status:{text:'', error:false}, shareOpen:false};
  let root=null, bundlePromise=null, listening=false;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const stale=()=>Object.assign(Error('이전 수동 편집 열람이 닫혀 반영하지 않았습니다.'),{code:'stale'});

  function el(tag, props){
    const node=document.createElement(tag);
    if(props) for(const [key,value] of Object.entries(props)){
      if(key==='className') node.className=value;
      else if(key==='textContent') node.textContent=value;
      else if(key==='dataset') Object.assign(node.dataset, value);
      else if(['id','type','value','checked','disabled','hidden','placeholder','rows','maxLength','required'].includes(key)) node[key]=value;
      else node.setAttribute(key, value===true?'':String(value));
    }
    for(let i=2;i<arguments.length;i++){const kid=arguments[i]; if(kid===0||kid) node.append(kid);}
    return node;
  }
  function bundle(){
    const ready=globalThis.FalsifyReviewBundle;
    if(ready&&typeof ready.normalizePaperEdit==='function'&&typeof ready.buildPaperEditArchive==='function'&&typeof ready.validateArchive==='function') return Promise.resolve(ready);
    if(bundlePromise) return bundlePromise;
    if(!BUNDLE_URL){
      const missing=Promise.reject(Error('수동 편집 보관 형식 모듈을 찾지 못했습니다.'));
      missing.catch(()=>{});
      return missing;
    }
    const pending=import(CODEC_URL.href).then(module=>{
      if(!module||typeof module.normalizePaperEdit!=='function'||typeof module.buildPaperEditArchive!=='function'||typeof module.validateArchive!=='function') throw Error('수동 편집 보관 형식 모듈을 찾지 못했습니다.');
      return module;
    });
    bundlePromise=pending.catch(error=>{bundlePromise=null; throw error;});
    bundlePromise.catch(()=>{});
    return bundlePromise;
  }
  function setStatus(text, error){
    state.status={text:String(text||''), error:!!error};
    if(ui.status){ui.status.textContent=state.status.text; ui.status.classList.toggle('error', state.status.error);}
  }
  function explain(error){
    if(error&&error.code==='mismatch') return error.message;
    if(error&&error.code==='conflict'&&/Duplicate edit/.test(error.message||'')) return '편집 ID가 중복되어 기록하지 않았습니다.';
    if(error&&error.code==='conflict'&&/Stale output/.test(error.message||'')) return '생성 파일 리비전이 현재 편집과 달라 다운로드 해시를 연결하지 않았습니다.';
    if(error&&error.code==='malformed'&&/PDF/.test(error.message||'')) return '원본 PDF 바이너리는 수동 기록에 넣지 않습니다.';
    return error&&error.message?error.message:'수동 편집 기록을 만들지 못했습니다.';
  }
  function publicOutput(output){
    if(!output||typeof output!=='object'||Array.isArray(output)) return null;
    const verification=output.verification&&typeof output.verification==='object'&&!Array.isArray(output.verification)?output.verification:{};
    return {sha256:output.sha256, revision:output.revision, verification};
  }
  function downloadLink(record){
    if(!record||!record.output||record.output.revision!==record.editRevision) return null;
    if(typeof record.output.sha256!=='string'||!HEX.test(record.output.sha256)) return null;
    return {sha256:record.output.sha256, revision:record.output.revision};
  }
  function hitsOf(text, needle){
    const hits=[];
    if(!needle||typeof text!=='string') return hits;
    let from=0;
    while(from<=text.length){
      const index=text.indexOf(needle, from);
      if(index<0) break;
      hits.push(index);
      from=index+1;
      if(hits.length>1000) break;
    }
    return hits;
  }
  function locateEdit(record, edit){
    if(!edit||typeof edit.segmentId!=='string'||!edit.segmentId) return {status:'source-only'};
    const segment=(record.segments||[]).find(item=>item.id===edit.segmentId);
    if(!segment||typeof segment.text!=='string'||typeof edit.before!=='string') return {status:'mismatch'};
    const hits=hitsOf(segment.text, edit.before);
    const anchor=edit.anchor;
    if(anchor&&Number.isInteger(anchor.start)&&Number.isInteger(anchor.end)){
      if(segment.text.slice(anchor.start, anchor.end)!==edit.before) return {status:'mismatch'};
      const occurrence=Number.isInteger(anchor.occurrence)?anchor.occurrence:hits.indexOf(anchor.start);
      if(!Number.isInteger(occurrence)||occurrence<0||hits[occurrence]!==anchor.start) return {status:'mismatch'};
      return {status:'matched', start:anchor.start, end:anchor.end, occurrence, segmentId:segment.id};
    }
    if(hits.length!==1) return {status:'mismatch'};
    return {status:'matched', start:hits[0], end:hits[0]+edit.before.length, occurrence:0, segmentId:segment.id};
  }
  function matchBlue(record, blue){
    const link=downloadLink(record);
    if(!link) return {status:'source-only', findings:[]};
    if(!blue||typeof blue!=='object'||typeof blue.fileHash!=='string') return {status:'absent', findings:[]};
    if(blue.fileHash!==link.sha256) return {status:'mismatch', findings:[]};
    const findings=Array.isArray(blue.findings)?blue.findings.map(finding=>{
      const row={
        id:typeof finding.id==='string'?finding.id:'',
        segmentId:typeof finding.segmentId==='string'?finding.segmentId:null,
        label:typeof finding.label==='string'?finding.label:'',
        quote:typeof finding.quote==='string'?finding.quote:'',
        rationale:typeof finding.rationale==='string'?finding.rationale:''
      };
      if(Number.isInteger(finding.start)) row.start=finding.start;
      if(Number.isInteger(finding.end)) row.end=finding.end;
      if(Number.isInteger(finding.pageIndex)) row.pageIndex=finding.pageIndex;
      return row;
    }).filter(finding=>finding.id):[];
    return {status:'matched', fileHash:link.sha256, findings};
  }
  function blueHandoff(record){
    const link=downloadLink(record);
    return link?{fileHash:link.sha256}:null;
  }
  function overlaps(record, edit, finding){
    if(!edit||!finding) return null;
    const place=locateEdit(record, edit);
    const segment=(record&&record.segments||[]).find(item=>item.id===edit.segmentId);
    const quote=typeof finding.quote==='string'?finding.quote:'';
    let range=null;
    if(Number.isInteger(finding.start)&&Number.isInteger(finding.end)&&finding.end>finding.start){
      if(!segment||!quote||segment.text.slice(finding.start, finding.end)===quote) range={start:finding.start, end:finding.end};
    }else if(segment&&quote){
      const hits=hitsOf(segment.text, quote);
      if(hits.length===1) range={start:hits[0], end:hits[0]+quote.length};
    }
    if(place.status==='matched'&&range&&place.start===range.start&&place.end===range.end) return 'same-position';
    const sameSegment=!!(edit.segmentId&&finding.segmentId&&edit.segmentId===finding.segmentId);
    const samePage=!!(segment&&Number.isInteger(segment.pageIndex)&&Number.isInteger(finding.pageIndex)&&finding.pageIndex===segment.pageIndex);
    if(sameSegment||samePage) return 'same-page';
    const before=typeof edit.before==='string'?edit.before:'';
    const after=typeof edit.after==='string'?edit.after:'';
    if(quote&&(before&&(quote.includes(before)||before.includes(quote))||after&&(quote.includes(after)||after.includes(quote)))) return 'context';
    return null;
  }
  function mapEdit(edit){
    const before=typeof edit.originalBefore==='string'?edit.originalBefore:edit.before;
    const row={id:edit.id, enabled:edit.enabled, pageIndex:edit.pageIndex, before, after:edit.after, origin:edit.origin, anchor:Object.prototype.hasOwnProperty.call(edit,'anchor')?edit.anchor:null};
    if(typeof edit.segmentId==='string'&&edit.segmentId) row.segmentId=edit.segmentId;
    if(Number.isInteger(edit.createdAt)) row.createdAt=edit.createdAt;
    if(Number.isInteger(edit.updatedAt)) row.updatedAt=edit.updatedAt;
    if(Array.isArray(edit.history)) row.history=copy(edit.history);
    return row;
  }
  function carryReviews(existing, revision, output){
    if(!existing||!Array.isArray(existing.reviews)) return [];
    const hash=output&&typeof output.sha256==='string'?output.sha256:null;
    return existing.reviews.map(review=>{
      const row=copy(review);
      const boundRevision=Number.isInteger(row.editRevision)?row.editRevision:existing.editRevision;
      const boundHash=Object.prototype.hasOwnProperty.call(review,'outputHash')?row.outputHash:(existing.output&&existing.output.sha256||null);
      row.editRevision=boundRevision;
      row.outputHash=boundHash;
      row.stale=boundRevision!==revision||boundHash!==hash;
      return row;
    });
  }
  function mapSegment(segment){
    const row={id:segment.id, label:segment.label, text:segment.text};
    if(Number.isInteger(segment.pageIndex)) row.pageIndex=segment.pageIndex;
    return row;
  }
  function mintId(){return 'pmr-'+crypto.randomUUID();}
  function storeLocal(data){
    const record={...data.record, reviews:data.reviews};
    const sameHash=locals.findIndex(item=>item.sourceFileHash===record.sourceFileHash);
    const sameId=locals.findIndex(item=>item.id===record.id);
    if(sameId>=0&&sameHash>=0&&sameId!==sameHash) throw Error('같은 수동 기록 ID가 이미 있어 덮어쓰지 않았습니다.');
    if(sameHash>=0) locals[sameHash]=record;
    else if(sameId>=0) throw Error('같은 수동 기록 ID가 이미 있어 새 원문에 쓰지 않았습니다.');
    else locals.push(record);
    activeId=record.id;
    if(!selectedKey||selectedKey==='local:'+record.id) selectedKey='local:'+record.id;
    return record;
  }
  async function normalize(record){
    const api=await bundle();
    return api.normalizePaperEdit(record);
  }
  async function capture(input){
    const ticket=++captureEpoch;
    const source=input&&input.source, snapshot=input&&input.snapshot;
    if(!source||typeof source!=='object'||!snapshot||snapshot.schema!=='falsify.paper-edits.v1') throw Object.assign(Error('원문이나 편집 스냅샷이 없어 수동 기록을 만들지 않았습니다.'),{code:'missing'});
    if(source.fileHash!==snapshot.fileHash) throw Object.assign(Error('원문 해시와 편집 스냅샷 해시가 달라 기록하지 않았습니다.'),{code:'mismatch'});
    const existing=locals.find(item=>item.sourceFileHash===source.fileHash);
    const revision=snapshot.revision;
    const incoming=publicOutput(input.output);
    let output=null;
    if(incoming&&incoming.revision===revision&&typeof incoming.sha256==='string'&&HEX.test(incoming.sha256)) output={sha256:incoming.sha256, revision:incoming.revision, verification:incoming.verification};
    else if(existing&&existing.editRevision===revision&&existing.output) output=copy(existing.output);
    const draft={
      id:existing?existing.id:mintId(),
      createdAt:existing?existing.createdAt:new Date(input.now||Date.now()).toISOString(),
      sourceFileHash:source.fileHash,
      sourceName:typeof source.name==='string'?source.name:(typeof snapshot.name==='string'?snapshot.name:''),
      segments:Array.isArray(source.segments)?source.segments.map(mapSegment):[],
      edits:Array.isArray(snapshot.edits)?snapshot.edits.map(mapEdit):[],
      editRevision:revision,
      output,
      reviews:carryReviews(existing, revision, output)
    };
    const data=await normalize(draft);
    if(ticket!==captureEpoch) return {captured:false, reason:'superseded'};
    const record=storeLocal(data);
    render();
    setStatus('수동 편집 기록을 이 브라우저 메모리에 남겼습니다. 모델 실행이나 팀 공유는 하지 않았습니다.');
    return copy(record);
  }
  async function linkOutput(output){
    const ticket=++captureEpoch;
    const current=locals.find(item=>item.id===activeId);
    if(!current) return {linked:false, reason:'no-record'};
    const seenRevision=current.editRevision, seenId=current.id;
    const incoming=publicOutput(output);
    if(!incoming||incoming.revision!==seenRevision||typeof incoming.sha256!=='string'||!HEX.test(incoming.sha256)) return {linked:false, reason:'stale', download:downloadLink(current)};
    const nextOutput={sha256:incoming.sha256, revision:incoming.revision, verification:incoming.verification};
    try{
      const data=await normalize({...current, reviews:carryReviews(current, seenRevision, nextOutput), output:nextOutput});
      const latest=locals.find(item=>item.id===seenId);
      if(ticket!==captureEpoch||!latest||latest.editRevision!==seenRevision) return {linked:false, reason:'superseded', download:downloadLink(latest||current)};
      const record=storeLocal(data);
      render();
      setStatus('생성 PDF SHA-256 '+record.output.sha256.slice(0,12)+'… 를 이 편집 리비전에 연결했습니다. PDF 바이너리는 저장하지 않았습니다.');
      return {linked:true, sha256:record.output.sha256, download:downloadLink(record)};
    }catch(error){
      setStatus(explain(error), true);
      return {linked:false, reason:error.code||'rejected', download:downloadLink(locals.find(item=>item.id===seenId)||current)};
    }
  }
  function readGet(name){
    const workspace=globalThis.FalsifyPaperWorkspace;
    if(!workspace||typeof workspace[name]!=='function') return null;
    try{return workspace[name]();}catch{return null;}
  }
  async function onEdits(event){
    const detail=event&&event.detail&&event.detail.schema==='falsify.paper-edits.v1'?event.detail:readGet('getEditSnapshot');
    try{await capture({source:readGet('getSource'), snapshot:detail, output:readGet('getOutput'), now:Date.now()});}
    catch(error){setStatus(explain(error), true);}
  }
  async function onOutput(event){
    const detail=event&&event.detail?event.detail:readGet('getOutput');
    const result=await linkOutput(detail);
    if(!result.linked&&result.reason==='superseded') return;
    if(!result.linked&&result.reason==='stale') setStatus('생성 파일 리비전이나 해시가 현재 편집과 달라 다운로드 해시를 바꾸지 않았습니다.', true);
    if(!result.linked&&result.reason==='binary') setStatus('생성 결과에 PDF 바이너리가 섞여 있어 해시만 연결하지 않았습니다.', true);
  }
  function onSource(){/* Source text is captured with the edit snapshot. A source event never publishes. */}
  function onTeamShare(){
    showReviewRoute();
    const key=selectedKey||(activeId?'local:'+activeId:'');
    if(!key){setStatus('올릴 수동 편집 기록이 없습니다. 보내지 않았습니다.', true); return;}
    openConsent(key);
  }
  function listen(){
    if(listening||!document.addEventListener) return;
    listening=true;
    document.addEventListener('falsify:paper-workspace-edits', onEdits);
    document.addEventListener('falsify:paper-workspace-output', onOutput);
    document.addEventListener('falsify:paper-workspace-source', onSource);
    document.addEventListener('falsify:paper-team-share', onTeamShare);
  }
  function showReviewRoute(){
    try{if(typeof location!=='undefined'&&location&&location.hash!=='#review') location.hash='#review';}catch{}
    try{document.querySelector('[data-view="review"]')?.click?.();}catch{}
  }
  function sweep(now){
    const time=now===undefined?Date.now():now;
    if(imported&&time>=imported.expiresAt){imported=null; if(selectedKey.startsWith('import:')) selectedKey=activeId?'local:'+activeId:''; render(); return true;}
    return false;
  }
  function views(){
    const rows=locals.map(record=>({key:'local:'+record.id, label:'로컬 수동 기록 · '+(record.sourceName||record.sourceFileHash.slice(0,12))+' · r'+record.editRevision, record, reviews:record.reviews, imported:false}));
    if(imported) rows.push({key:'import:'+imported.record.id, label:'임시 열람 · '+(imported.record.sourceName||imported.record.id)+' · 메모리', record:imported.record, reviews:imported.reviews, imported:true});
    return rows;
  }
  function currentView(){
    sweep();
    return views().find(view=>view.key===selectedKey)||views()[0]||null;
  }
  function chosenBlue(){
    return blues.find(item=>item&&item.id===state.blueId)||null;
  }
  function paintShare(){
    if(!ui.publish) return;
    ui.publish.disabled=sharing||!ui.consent||!ui.consent.checked||consentFor!==selectedKey;
  }
  function openConsent(key){
    selectedKey=key;
    state.shareOpen=true;
    consentFor='';
    render();
    setStatus('팀 전체 공개에 동의하기 전에는 올리지 않습니다. 텍스트와 편집만 대상입니다.');
    try{ui.consent&&ui.consent.focus&&ui.consent.focus();}catch{}
  }
  function cancelShare(){
    shareEpoch++;
    consentFor='';
    state.shareOpen=false;
    if(ui.consent) ui.consent.checked=false;
    render();
    setStatus('팀 공유를 취소했습니다. 보내지 않았습니다.');
  }
  async function share(key){
    if(sharing) return {stored:false, retried:false};
    if(consentFor!==key) throw Error('Falsify 팀 전체 공개에 동의한 뒤 지금 고른 수동 기록만 올릴 수 있습니다. 아직 보내지 않았습니다.');
    const view=views().find(item=>item.key===key);
    if(!view) throw Error('올릴 수동 편집 기록이 없습니다. 보내지 않았습니다.');
    const generation=++shareEpoch;
    sharing=true; consentFor=''; paintShare();
    try{
      const remote=globalThis.FalsifyConfluenceStore;
      if(!remote||!remote.ready||typeof remote.ready.then!=='function') throw Error('기존 팀 보관 연결이 없습니다. 다른 서비스로는 보내지 않습니다.');
      const app=await remote.ready;
      if(generation!==shareEpoch) return {stored:false, cancelled:true};
      if(!app||typeof app.publishPaperEdit!=='function') throw Error('기존 팀 보관 연결이 없습니다. 다른 서비스로는 보내지 않습니다.');
      const result=await app.publishPaperEdit({...copy(view.record), reviews:copy(view.reviews)},{teamShare:true});
      if(generation!==shareEpoch) return {stored:false, cancelled:true};
      if(result&&result.cancelled){setStatus('팀 공유가 끝나기 전에 연결이 바뀌어 결과를 성공으로 보지 않습니다. 자동으로 다시 보내지 않습니다.', true); return result;}
      setStatus('수동 편집 JSON을 팀 공간에 올렸습니다. 텍스트와 편집만이며 원본 PDF 바이너리는 올리지 않았습니다.');
      state.shareOpen=false;
      render();
      return result;
    }catch(error){
      setStatus(error&&error.message?error.message:'팀 보관 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.', true);
      return {stored:false, error:error&&error.message};
    }finally{sharing=false; paintShare();}
  }
  async function addReview(key, input, extras){
    sweep(extras&&extras.now);
    if(!input||typeof input!=='object'||Object.prototype.hasOwnProperty.call(input,'gold')) throw Error('gold는 계산하거나 저장하지 않습니다. 사람이 적은 점수와 이유만 남깁니다.');
    const view=views().find(item=>item.key===key);
    if(!view) throw Error('검수할 수동 기록이 없습니다.');
    const blue=extras&&extras.blue;
    const matched=matchBlue(view.record, blue||null);
    let alignment=null;
    if(blue&&matched.status==='matched'){
      const notes=Array.isArray(input.findingNotes)?input.findingNotes:[];
      const allowed=new Set(matched.findings.map(finding=>finding.id));
      alignment={fileHash:matched.fileHash, findingNotes:notes.map(note=>{
        if(!note||!allowed.has(note.id)) throw Error('선택한 BLUE 지적에 없는 항목은 연결하지 않습니다.');
        return {id:note.id, verdict:note.verdict, note:typeof note.note==='string'?note.note:''};
      })};
    }
    const score=input.verdict==='uncertain'||input.score===''||input.score===undefined?null:input.score;
    const link=downloadLink(view.record);
    const review={id:crypto.randomUUID(), createdAt:new Date((extras&&extras.now)||Date.now()).toISOString(), reviewer:input.reviewer, caseLabel:input.caseLabel, verdict:input.verdict, score, note:input.note, alignment, editRevision:view.record.editRevision, outputHash:link?link.sha256:null, stale:false};
    const data=await normalize({...view.record, reviews:view.reviews.concat([review])});
    if(view.imported){imported.record=data.record; imported.reviews=data.reviews;}
    else storeLocal(data);
    render();
    setStatus(alignment?'사람 검수를 남겼습니다. BLUE 파일 해시가 같은 지적만 옆에 두었고 gold는 만들지 않았습니다.':'사람 검수를 남겼습니다. BLUE를 맞추지 않은 수동 검수입니다. gold는 만들지 않았습니다.');
    return copy(data.reviews[data.reviews.length-1]);
  }
  function editArticle(record, edit, findings){
    const place=locateEdit(record, edit);
    const placeText=place.status==='matched'?'검증된 원문 범위와 같습니다.':place.status==='source-only'?'위치 단서가 없어 원문 위치로 확정하지 않습니다.':'검증된 범위가 없거나 중복 인용을 한 곳으로 확정하지 않습니다.';
    const anchor=edit.anchor?JSON.stringify(edit.anchor):'없음';
    const article=el('article',{className:'paper-manual-edit'},
      el('h4',{textContent:(edit.pageIndex+1)+'쪽 · '+(ORIGIN_LABEL[edit.origin]||edit.origin)+' · '+(edit.enabled?'사용':'사용 안 함')}),
      el('p',{className:'muted', textContent:placeText+' 앵커 '+anchor}),
      el('p',{className:'paper-manual-label', textContent:'Before'}),
      el('pre',{textContent:edit.before}),
      el('p',{className:'paper-manual-label', textContent:'After'}),
      el('pre',{textContent:edit.after})
    );
    const groups={'same-position':[], 'same-page':[], context:[]};
    for(const finding of findings||[]){const kind=overlaps(record, edit, finding); if(kind) groups[kind].push(finding);}
    const labels={'same-position':'같은 자리의 BLUE 지적', 'same-page':'같은 쪽의 BLUE 지적', context:'문맥상 가까운 BLUE 지적'};
    for(const kind of ['same-position','same-page','context']){
      if(!groups[kind].length) continue;
      article.append(el('div',{className:'paper-manual-findings', 'data-relation':kind}, el('p',{className:'paper-manual-label', textContent:labels[kind]}), ...groups[kind].map(finding=>el('p',{textContent:finding.id+' · '+(finding.label||'')+' · '+finding.quote}))));
    }
    return article;
  }
  function reviewArticle(record, review){
    const hash=record.output?record.output.sha256:null;
    const current=review.stale!==true&&review.editRevision===record.editRevision&&review.outputHash===hash;
    const prior=(record.edits||[]).flatMap(edit=>{
      const hit=Array.isArray(edit.history)?edit.history.find(item=>item.revision===review.editRevision):null;
      return hit?[edit.id+' · '+hit.after]:[];
    });
    const heading=current
      ?review.reviewer+' · 이 리비전 r'+review.editRevision+' · '+review.verdict+' · '+(review.score??'미평가')
      :review.reviewer+' · 이전 리비전 r'+review.editRevision+' · 현재 After에 적용하지 않음 · '+review.verdict+' · '+(review.score??'미평가');
    const article=el('article',{'data-review-current':current?'true':'false'}, el('h4',{textContent:heading}), el('p',{textContent:review.note}));
    if(!current) article.append(el('p',{className:'muted', textContent:'이 사람 판정은 리비전 '+review.editRevision+(review.outputHash?' · SHA-256 '+review.outputHash.slice(0,12)+'…':' · 생성 해시 없음')+' 에만 묶여 있습니다.'+(prior.length?' 당시 After '+prior.join(' / '):'')}));
    else article.append(el('p',{className:'muted', textContent:review.alignment?'BLUE 해시 '+review.alignment.fileHash.slice(0,12)+'… 와 사람 메모':'BLUE를 맞추지 않은 검수'}));
    return article;
  }
  function render(){
    if(!root) return;
    const view=currentView();
    if(view) selectedKey=view.key;
    const record=view&&view.record;
    const link=record?downloadLink(record):null;
    const blue=chosenBlue();
    const matched=record?matchBlue(record, blue):{status:'absent', findings:[]};
    const findings=matched.status==='matched'?matched.findings:[];
    ui.status=el('p',{id:'paper-manual-status', className:state.status.error?'paper-manual-status error':'paper-manual-status', role:'status', textContent:state.status.text});
    const picker=el('select',{id:'paper-manual-record'});
    const rows=views();
    if(!rows.length) picker.append(el('option',{value:'', textContent:'아직 수동 편집 기록이 없습니다'}));
    for(const row of rows) picker.append(el('option',{value:row.key, textContent:row.label}));
    if(selectedKey) picker.value=selectedKey;
    picker.addEventListener('change',()=>{selectedKey=picker.value; state.blueId=''; consentFor=''; render();});
    const blueSelect=el('select',{id:'paper-manual-blue'});
    blueSelect.append(el('option',{value:'', textContent:'BLUE 파일을 맞추지 않음 · 수동 검수만'}));
    for(const item of blues) blueSelect.append(el('option',{value:item.id, textContent:(item.sourceName||'BLUE')+' · '+String(item.fileHash||'').slice(0,12)}));
    if(state.blueId) blueSelect.value=state.blueId;
    blueSelect.addEventListener('change',()=>{state.blueId=blueSelect.value; render();});
    const blueStatus=matched.status==='matched'?'BLUE 파일 SHA-256이 생성 PDF와 같습니다. 타당함은 사람이 적습니다.':matched.status==='mismatch'?'고른 BLUE 파일 해시가 생성 PDF 해시와 다릅니다. 맞춘 것으로 표시하지 않습니다.':matched.status==='source-only'?'생성 PDF 해시가 없어 BLUE 파일과 맞추지 않습니다. 원문 해시만으로 맞추지 않습니다.':'BLUE 파일을 고르지 않았습니다. 수동 검수는 그대로 저장할 수 있습니다.';
    const edits=el('div',{id:'paper-manual-edits'});
    if(record) for(const edit of record.edits) edits.append(editArticle(record, edit, findings));
    else edits.append(el('p',{className:'muted', textContent:'논문 작업대의 편집 스냅샷이 오면 Before와 After를 여기 남깁니다. 위치와 원문을 다시 입력하지 않아도 됩니다.'}));
    const history=el('div',{id:'paper-manual-history'});
    for(const review of (view&&view.reviews)||[]) history.append(reviewArticle(record, review));
    ui.consent=el('input',{type:'checkbox', id:'paper-manual-consent'});
    ui.consent.addEventListener('change',()=>{consentFor=ui.consent.checked?selectedKey:''; paintShare();});
    ui.publish=el('button',{type:'button', id:'paper-manual-publish', className:'button primary', textContent:'공개하고 저장'});
    ui.publish.addEventListener('click',()=>{void share(selectedKey);});
    const cancel=el('button',{type:'button', id:'paper-manual-cancel', className:'button secondary', textContent:'취소'});
    cancel.addEventListener('click',cancelShare);
    const shareBox=el('details',{id:'paper-manual-share', className:'paper-manual-share'});
    if(state.shareOpen) shareBox.setAttribute('open','');
    shareBox.append(el('summary',{textContent:'팀에 저장'}), el('p',{textContent:'Falsify 팀 전체 공개입니다. 텍스트와 편집, 사람이 적은 검수 메모만 JSON으로 올립니다. 원본 PDF 바이너리는 올리지 않습니다. 동의 전에는 보내지 않고, 응답을 모르면 자동으로 다시 보내지 않습니다.'}), el('label',{className:'check-row'}, ui.consent, el('span',{textContent:'이 수동 기록을 팀원 모두에게 공개합니다.'})), el('div',{className:'button-row'}, ui.publish, cancel));
    const reviewer=el('input',{id:'paper-manual-reviewer', maxLength:120, placeholder:'이름 또는 식별자'});
    const caseLabel=el('input',{id:'paper-manual-case', maxLength:160, placeholder:'예: 수동 편집 / 인용 수치'});
    const verdict=el('select',{id:'paper-manual-verdict'});
    for(const [value,label] of [['uncertain','유보 / 판단 불가'],['supported','근거 있는 편집'],['unsupported','근거 부족 / 잘못된 편집'],['mixed','일부 적절']]) verdict.append(el('option',{value, textContent:label}));
    const score=el('select',{id:'paper-manual-score'});
    score.append(el('option',{value:'', textContent:'미평가'}));
    for(let value=1;value<=5;value++) score.append(el('option',{value:String(value), textContent:String(value)}));
    verdict.addEventListener('change',()=>{if(verdict.value==='uncertain') score.value='';});
    const note=el('textarea',{id:'paper-manual-note', rows:3, maxLength:3000, placeholder:'이번 검수에서 확인한 이유를 적으세요. 자동 점수는 없습니다.'});
    const findingBox=el('div',{id:'paper-manual-finding-notes'});
    if(matched.status==='matched') for(const finding of findings){
      const select=el('select',{'data-finding-verdict':finding.id});
      for(const [value,label] of [['pending','미판정'],['supported','타당함'],['unsupported','타당하지 않음'],['mixed','일부 타당'],['uncertain','확인필요']]) select.append(el('option',{value, textContent:label}));
      const reason=el('textarea',{'data-finding-note':finding.id, rows:2, maxLength:3000, placeholder:'이 지적에 대한 사람 이유'});
      findingBox.append(el('label',{'data-finding-id':finding.id}, el('span',{textContent:finding.id+' · '+(finding.quote||'').slice(0,80)}), select, reason));
    }
    const form=el('form',{id:'paper-manual-form'});
    const save=el('button',{type:'submit', id:'paper-manual-save', className:'button primary', textContent:'사람 검수 추가', disabled:!record});
    form.append(el('div',{className:'ledger-fields'}, el('label',{textContent:'평가자'}, reviewer), el('label',{textContent:'사례'}, caseLabel), el('label',{textContent:'판정'}, verdict), el('label',{textContent:'전반적 품질 (1–5)'}, score)), note, findingBox, save);
    form.addEventListener('submit',event=>{
      event.preventDefault();
      if(!currentView()) return;
      const findingNotes=[...findingBox.children].map(node=>({id:node.getAttribute('data-finding-id'), verdict:node.querySelector('select').value, note:node.querySelector('textarea').value}));
      const body={reviewer:reviewer.value.trim(), caseLabel:caseLabel.value.trim(), verdict:verdict.value, score:score.value===''?null:Number(score.value), note:note.value.trim(), findingNotes};
      void addReview(selectedKey, body, {blue:chosenBlue()}).catch(error=>setStatus(error.message, true));
    });
    const prepare=el('button',{type:'button', id:'paper-manual-prepare', className:'button secondary', textContent:'팀에 저장', disabled:!record});
    prepare.addEventListener('click',()=>{if(selectedKey) openConsent(selectedKey);});
    const refresh=el('button',{type:'button', id:'paper-manual-blue-refresh', className:'button secondary', textContent:'BLUE 파일 목록'});
    refresh.addEventListener('click',()=>{void refreshBlue();});
    const closeImportedButton=el('button',{type:'button', id:'paper-manual-close-import', className:'button secondary', textContent:'임시 열람 닫기', hidden:!imported});
    closeImportedButton.addEventListener('click',()=>{closeImported(); setStatus('임시 열람을 닫았습니다. 로컬 수동 기록과 로컬 AI 기록은 그대로입니다.');});
    root.replaceChildren(
      el('div',{className:'paper-manual-kicker'}, el('span',{textContent:'H1'}), el('strong',{textContent:'수동 편집 검수'})),
      el('p',{className:'muted', textContent:'모델 실행 기록과 별도입니다. Harness 증명이나 gold를 만들지 않습니다. Before, After, 쪽, 앵커, 출처, 사용 여부, 생성 PDF 해시와 리비전은 작업대 스냅샷에서 가져옵니다.'}),
      ui.status,
      el('label',{textContent:'수동 기록'}, picker),
      el('p',{id:'paper-manual-output', textContent:link?'생성 PDF SHA-256 '+link.sha256+' · revision '+link.revision:'이 편집 리비전의 생성 PDF 해시가 없습니다. 이전 해시를 현재 파일로 연결하지 않습니다.'}),
      edits,
      el('label',{textContent:'BLUE 파일 해시'}, blueSelect),
      refresh,
      el('p',{id:'paper-manual-blue-status', textContent:blueStatus}),
      form,
      el('h3',{textContent:'사람 검수 이력'}),
      history,
      el('div',{className:'button-row'}, prepare, closeImportedButton),
      shareBox
    );
    paintShare();
  }
  async function refreshBlue(){
    const lab=globalThis.FalsifyLab;
    try{const rows=lab&&typeof lab.blueFileChoices==='function'?await lab.blueFileChoices():[]; blues=Array.isArray(rows)?rows.map(item=>({id:item.id, fileHash:item.fileHash, sourceName:item.sourceName, findings:Array.isArray(item.findings)?item.findings:[]})):[]}
    catch{blues=[];}
    render();
    return copy(blues);
  }
  async function openImported(archive, options){
    const live=options&&options.live, now=options&&options.now||Date.now();
    if(typeof live==='function'&&!live()) throw stale();
    const api=await bundle();
    const normalized=await api.validateArchive(archive);
    if(!normalized||normalized.kind!=='paper-edit') throw Error('수동 편집 보관이 아닙니다. 로컬 AI 기록은 그대로입니다.');
    if(typeof live==='function'&&!live()) throw stale();
    const data=api.normalizePaperEdit(normalized.data);
    imported={record:data.record, reviews:data.reviews, openedAt:now, expiresAt:now+TTL};
    selectedKey='import:'+data.record.id;
    state.shareOpen=false; consentFor='';
    render();
    setStatus('팀의 수동 편집 보관을 메모리에서만 열었습니다. 로컬 AI 기록에 넣지 않았습니다. 12시간이 지나거나 닫으면 사라집니다.');
    return {kind:'paper-edit', id:data.record.id};
  }
  function closeImported(){
    imported=null;
    if(selectedKey.startsWith('import:')) selectedKey=activeId?'local:'+activeId:'';
    state.shareOpen=false; consentFor='';
    render();
    return true;
  }
  function mount(){
    if(root) return root;
    const host=document.querySelector&&(document.querySelector('#human-evaluation')||document.querySelector('#view-review'));
    if(!host) return null;
    root=el('section',{id:'paper-manual-records', className:'paper-manual-records', 'aria-labelledby':'paper-manual-title'});
    host.append(root);
    render();
    return root;
  }
  const api={
    ready:null, TTL_MS:TTL,
    capture, linkOutput, downloadLink, locateEdit, overlaps, matchBlue, blueHandoff, addReview, openConsent, cancelShare, share, openImported, closeImported, sweep, refreshBlue, mount,
    records(){return copy(locals);},
    imported(now){sweep(now); return imported?{record:copy(imported.record), reviews:copy(imported.reviews), openedAt:imported.openedAt, expiresAt:imported.expiresAt}:null;}
  };
  api.ready=(async()=>{if(document.readyState==='loading') await new Promise(resolve=>document.addEventListener('DOMContentLoaded', resolve, {once:true})); listen(); mount(); return api;})();
  api.ready.catch(()=>{});
  globalThis.FalsifyPaperManualRecords=api;
})();

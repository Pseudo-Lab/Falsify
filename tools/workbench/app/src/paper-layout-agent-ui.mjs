import {readLayoutReference} from './paper-layout-reference.mjs';
import {runPaperLayoutAgent} from './paper-layout-agent.mjs';
import {createLatexCompiler} from './latex-compiler-adapter.mjs';
import {createReconstructionReader} from './pdf-latex-reader.mjs';
import {exportLatexProject,createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {createLayoutToolHandlers} from './paper-layout-toolbox.mjs';
import {createLayoutRunStore,exportLayoutRun,importLayoutRun,validateLayoutRunState as validateStoredRun,MAX_LAYOUT_TRACE} from './paper-layout-run-store.mjs';
import {createLayoutPreviewController} from './paper-layout-preview.mjs';
import {layoutStepDecision,layoutFailureDetails} from './paper-layout-transport.mjs';

const base=new URL('.',import.meta.url);
const aborted=()=>new DOMException('취소했습니다.','AbortError');
const actionLabels={read_source:'소스 확인',replace_source:'배치 수정',compile_pdf:'PDF 생성',inspect_pdf:'겹침·잘림 검사',render_pages:'페이지 확인',render_reference_pages:'원본 페이지 확인',read_reference:'원본 구조 확인',restructure_source:'구조 배치',inspect_document:'문서 찾기',get_block:'블록 확인',render_region:'확대 비교',update_layout:'블록 배치',compare_document:'내용 대조',checkpoint:'후보 저장',restore_revision:'후보 복원',inspect_fonts:'글꼴 확인',set_typography:'서체 적용',read_table:'표 읽기',rebuild_table:'표 재조판',get_figure:'그림 확인',place_figure:'그림 배치',replace_figure:'그림 교체',finish:'마무리'};
const runLabels={complete:'작업 완료',unresolved:'확인할 부분이 남았습니다',cancelled:'중단했습니다'};

function validateRegionRequest(bytes,args){
 if(!(bytes instanceof Uint8Array)||!['original','candidate'].includes(args?.document)||!Number.isSafeInteger(args.pageIndex)||args.pageIndex<0||!Array.isArray(args.bbox)||args.bbox.length!==4||!args.bbox.every(Number.isFinite))throw new Error('문서·쪽·영역 좌표를 확인하세요.');
 // Untagged calls use the existing PDF.js display-coordinate contract. Numbers
 // alone cannot establish whether an upstream producer supplied this frame.
 const frame=args.coordinateFrame??'pdfjs-display';
 if(!['pdfjs-display','mupdf-display'].includes(frame))throw Object.assign(new Error('표시 좌표를 사용하세요. SyncTeX 원시 좌표는 변환이 필요합니다.'),{code:'INCOMPATIBLE_COORDINATE_FRAME'});
 if(args.scale!==undefined&&(!Number.isFinite(args.scale)||args.scale<0.25||args.scale>4))throw new Error('확대 배율은 0.25–4를 사용하세요.');
 return frame;
}

function validateRegionBounds(natural,left,top,right,bottom){
 if(!Number.isFinite(natural.width)||!Number.isFinite(natural.height)||natural.width<=0||natural.height<=0||left<0||top<0||right>natural.width||bottom>natural.height||right<=left||bottom<=top)throw new Error('페이지 안의 영역 좌표를 사용하세요.');
}

export async function renderLayoutRegion({bytes,args,loadPdf,doc,baseUrl=base,signal}={}){
 const check=()=>{if(signal?.aborted)throw aborted();};check();
 const frame=validateRegionRequest(bytes,args);
 const lib=await loadPdf();check();const task=lib.getDocument({data:bytes.slice(),cMapUrl:new URL('vendor/cmaps/',baseUrl).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',baseUrl).href,wasmUrl:new URL('vendor/wasm/',baseUrl).href});let page;
 try{const pdf=await task.promise;check();if(args.pageIndex>=pdf.numPages)throw new Error('요청한 페이지가 없습니다.');page=await pdf.getPage(args.pageIndex+1);check();const natural=page.getViewport({scale:1}),[left,top,right,bottom]=args.bbox;
  validateRegionBounds(natural,left,top,right,bottom);
  const width=right-left,height=bottom-top;let scale=Math.min(args.scale??2,Math.sqrt(3996001/(width*height)),4095/width,4095/height),encoded='',pixelWidth=0,pixelHeight=0;
  while(Math.ceil(width*scale)*Math.ceil(height*scale)>4000000)scale*=0.999;
  for(let i=0;i<5;i++){
   check();const canvas=doc.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);pixelWidth=canvas.width;pixelHeight=canvas.height;
   let render,cancelled=false;const cancel=()=>{if(!cancelled){cancelled=true;render?.cancel();}};try{render=page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale}),transform:[1,0,0,1,-left*scale,-top*scale]});signal?.addEventListener('abort',cancel,{once:true});check();await render.promise;check();const data=canvas.toDataURL('image/png');if(!data.startsWith('data:image/png;base64,'))throw new Error('영역 이미지를 생성하지 못했습니다.');encoded=data.slice(data.indexOf(',')+1);}catch(error){if(signal?.aborted){cancel();throw aborted();}throw error;}finally{signal?.removeEventListener('abort',cancel);canvas.width=canvas.height=0;}
   if(encoded.length<=699052)break;scale*=0.7;
  }
  if(encoded.length>699052)throw new Error('영역을 더 작게 선택하세요.');
  const geometry={coordinateFrame:'pdfjs-display',inputCoordinateFrame:frame,coordinateUnit:'display-pdf-points',origin:'top-left',pageWidth:natural.width,pageHeight:natural.height,rotation:natural.rotation,userUnit:page.userUnit,viewBox:Array.isArray(natural.viewBox)?[...natural.viewBox]:undefined,frameAssumed:args.coordinateFrame===undefined};
  return {images:[{document:args.document,pageIndex:args.pageIndex,bbox:[...args.bbox],mime:'image/png',base64:encoded}],observation:{document:args.document,pageIndex:args.pageIndex,bbox:[...args.bbox],scale,pixelWidth,pixelHeight,...geometry},coverage:{regions:[{document:args.document,pageIndex:args.pageIndex,bbox:[...args.bbox],coordinateFrame:'pdfjs-display'}],totalPages:pdf.numPages}};
 }finally{try{page?.cleanup?.();}finally{await task.destroy();}}
}

const stepIdToken=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)?v:'';
// Request identity only. The step payload and model output are not receipt fields.
function stepIdentity(source,step){const runId=stepIdToken(source?.runId),stepId=stepIdToken(source?.stepId)||(runId&&Number.isSafeInteger(step)&&step>=0?stepIdToken(runId+'-s'+step):''),fingerprint=/^[0-9a-f]{64}$/.test(source?.fingerprint||'')?source.fingerprint:'';return {...(runId?{runId}:{}),...(stepId?{stepId}:{}),...(fingerprint?{fingerprint}:{})};}

// The companion returns a JSON object through the existing authenticated bridge.
export async function requestLayoutDecision(link,input,signal,onReceipt,identity){
  const response=await link.request('/api/paper/layout-agent/step',{schema:'falsify.paper-layout-agent-step.v1',consent:true,...input},{signal});
  if(signal?.aborted)throw aborted();
  if(response?.schema!=='falsify.paper-layout-agent-action.v1'||response.projectId!==input.projectId||response.step!==input.step||!response.action)throw new Error('레이아웃 응답이 현재 작업과 일치하지 않습니다.');
  onReceipt?.({projectId:response.projectId,step:response.step,model:response.model,skillHash:response.skillHash,...stepIdentity(identity,input?.step)});
  return response.action;
}

/** A saved layout run is embedded only in an archive of the source it was made from. */
export function layoutRunForSource(run,projectId){if(!run||!projectId)return null;const owner=run.sourceContext?.projectId??run.baselineProject?.id??null;return owner===projectId?run:null;}

export function mountPaperLayoutAgent({doc,host,getSession,getEpoch,getReferenceFile=()=>null,download,loadCandidate,onRunState=()=>{},storeFactory=createLayoutRunStore,previewFactory=createLayoutPreviewController,bridge=globalThis.FalsifyLocalBridge,runAgent=runPaperLayoutAgent,compilerFactory=()=>createLatexCompiler({assetBase:new URL('latex-compiler-vendor/',base).href}),readerFactory=createReconstructionReader,loadPdf=async()=>{const lib=await import('./vendor/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs',base).href;return lib;}}){
  const el=(tag,text='')=>{const n=doc.createElement(tag);n.textContent=text;return n;};
  const box=el('details'),title=el('summary','AI 배치 다듬기'),notice=el('p','시작하면 현재 선택된 변경이 반영된 LaTeX 소스와 원본·후보 PDF 페이지 이미지가 연결된 companion의 AI에 전달됩니다. 결과는 별도 후보로 보관됩니다.'),goalLabel=el('label','레이아웃 요청 (선택)'),goal=el('textarea'),start=el('button','AI로 배치 다듬기'),cancel=el('button','중단'),status=el('p'),identity=el('p'),previous=el('button','이전 후보 쪽'),pageLabel=el('span'),next=el('button','다음 후보 쪽'),canvas=el('canvas'),originalCanvas=el('canvas'),originalLabel=el('p','원본 PDF'),pdf=el('button','후보 PDF 다운로드'),source=el('button','후보 소스 ZIP 다운로드'),blue=el('button','이 PDF로 BLUE 검토'),adopt=el('button','후보 소스로 계속 편집'),lineage=el('p','후보 소스로 계속 편집하면 새 소스 작업을 엽니다. 기존 편집 이력과 재구성 원본 계보는 새 작업에 연결되지 않습니다.');
  goal.value='현재 단어와 선택된 RED 편집을 보존하면서 자연스럽고 읽기 좋은 배치로 조정하세요.';goal.maxLength=2000;goalLabel.append(goal);
  const replacementsLabel=el('label','교체할 그림 · 선택 사항'),replacementFiles=el('input');replacementFiles.type='file';replacementFiles.accept='image/png,image/jpeg';replacementFiles.multiple=true;replacementFiles.setAttribute('aria-label','교체할 그림 파일');replacementsLabel.append(replacementFiles);
  for(const b of [start,cancel,previous,next,pdf,source,blue,adopt])b.type='button';status.setAttribute('role','status');pageLabel.setAttribute('role','status');canvas.setAttribute('aria-label','레이아웃 후보 PDF 미리보기');originalCanvas.setAttribute('aria-label','원본 PDF 미리보기');originalLabel.hidden=originalCanvas.hidden=true;const panes=el('div'),originalPane=el('div'),candidatePane=el('div'),candidateLabel=el('p','후보 PDF');panes.className='latex-preview-panes';originalPane.className=candidatePane.className='latex-preview-pane';originalPane.append(originalLabel,originalCanvas);candidatePane.append(candidateLabel,canvas);panes.append(originalPane,candidatePane);
  const resultBox=el('section'),outcome=el('p'),findings=el('ul'),extras=el('details'),extrasTitle=el('summary','작업 파일·기록'),historyLabel=el('label','후보 선택'),historySelect=el('select'),revisionLabel=el('label','저장한 지점'),revisionSelect=el('select'),originalPage=el('input'),candidatePage=el('input'),originalPageLabel=el('label','원본 쪽'),candidatePageLabel=el('label','후보 쪽'),match=el('button','같은 내용으로 이동'),textDetails=el('details'),textSummary=el('summary','페이지 텍스트'),originalText=el('pre'),candidateText=el('pre'),actions=el('div'),navigation=el('div');
  resultBox.setAttribute('aria-label','레이아웃 결과');resultBox.hidden=true;outcome.setAttribute('role','status');historySelect.setAttribute('aria-label','레이아웃 후보 선택');revisionSelect.setAttribute('aria-label','레이아웃 체크포인트 선택');historyLabel.append(historySelect);revisionLabel.append(revisionSelect);for(const input of [originalPage,candidatePage]){input.type='number';input.min='1';input.value='1';}originalPage.setAttribute('aria-label','원본 PDF 쪽');candidatePage.setAttribute('aria-label','후보 PDF 쪽');originalPageLabel.append(originalPage);candidatePageLabel.append(candidatePage);match.type='button';textDetails.append(textSummary,el('h4','원본 페이지 텍스트'),originalText,el('h4','후보 페이지 텍스트'),candidateText);extras.append(extrasTitle,source,adopt,lineage,identity);resultBox.append(outcome,historyLabel,revisionLabel,findings,previous,pageLabel,next,originalPageLabel,candidatePageLabel,match,panes,textDetails,pdf,blue,extras);box.append(title,notice,goalLabel,start,cancel,status,resultBox);host.append(box);
  const originNote=el('p','이전 소스에서 만든 후보입니다. 현재 소스의 BLUE 검토나 계속 편집에는 쓸 수 없습니다.'),pendingNote=el('p'),discardPending=el('button','보류 중인 요청 버리기');originNote.className='paper-layout-origin-note';originNote.hidden=pendingNote.hidden=discardPending.hidden=true;pendingNote.setAttribute('role','status');discardPending.type='button';discardPending.className='button secondary';
  const recordButton=el('button','작업 기록 저장');recordButton.type='button';extras.append(recordButton);
  const previousPdf=el('button','이전 후보 PDF 다운로드');previousPdf.type='button';previousPdf.className='button secondary';previousPdf.hidden=true;previousPdf.onclick=()=>{const a=candidate?.previousCandidate?.artifact;if(a?.pdfBytes)download(a.pdfBytes,'layout-previous-candidate.pdf','application/pdf');};extras.append(previousPdf);
  const saveRun=el('button','레이아웃 작업 저장'),loadRun=el('input'),loadRunLabel=el('label','레이아웃 작업 불러오기'),restoreRun=el('button','저장한 레이아웃 불러오기'),reset=el('button','원본에서 다시 시작');saveRun.type=restoreRun.type=reset.type='button';loadRun.type='file';loadRun.accept='.zip,application/zip';loadRunLabel.append(loadRun);extras.append(saveRun,loadRunLabel,reset);box.append(restoreRun);
  const inputsExtra=el('details');inputsExtra.append(el('summary','교체 그림'),replacementsLabel);box.append(inputsExtra);
  actions.className='paper-layout-actions';navigation.className='paper-layout-navigation';actions.append(pdf,blue);navigation.append(previous,pageLabel,next,originalPageLabel,candidatePageLabel,match);resultBox.replaceChildren(originNote,outcome,pendingNote,discardPending,actions,historyLabel,revisionLabel,findings,navigation,panes,textDetails,extras);
  for(const b of [cancel,source,blue,adopt,previous,next,recordButton,previousPdf,match,saveRun,restoreRun,reset])b.className='button secondary';start.className=pdf.className='button primary';
  canvas.className=originalCanvas.className='paper-layout-agent-preview';identity.className='paper-layout-agent-identity';box.className='paper-layout-agent';box.tabIndex=-1;status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
  function reveal(){box.open=true;box.focus?.({preventScroll:true});box.scrollIntoView?.({block:'start'});}
  let referenceBytes=null,controller=null,candidate=null,signature=null,previewTicket=0,previewPage=0,originalIndex=0,previewPages=0,receipts=[],runGoal='',runState=null,persist=false,forceFresh=false,viewerKey='',pendingSave=null,savePromise=null,pendingStep=null,pendingProblem=null,failedRun=null,previewFocus=null,saveGeneration=0;
  const history=new Map(),store=storeFactory();
  const receiptKey=item=>{const failure=item?.failure&&typeof item.failure==='object'?item.failure:null,request=failure?.request&&typeof failure.request==='object'?failure.request:null;return [item?.projectId??'',item?.step??'',item?.model??'',item?.skillHash??'',failure?.code??'',request?.stepId??'',request?.fingerprint??'',item?.runId??'',item?.stepId??'',item?.fingerprint??''].join('\n');};
  function copyReceipts(list){const out=[],seen=new Set();for(const item of list||[]){if(!item||typeof item!=='object')continue;const key=receiptKey(item);if(seen.has(key))continue;seen.add(key);out.push(item);}return out.length>MAX_LAYOUT_TRACE?out.slice(out.length-MAX_LAYOUT_TRACE):out;}
  function addReceipt(item){if(!item||typeof item!=='object')return;if(receipts.some(r=>receiptKey(r)===receiptKey(item)))return;receipts.push(item);if(receipts.length>MAX_LAYOUT_TRACE)receipts.splice(0,receipts.length-MAX_LAYOUT_TRACE);}
  function recoverableAttempt(base){if(failedRun?.pendingStep)return failedRun;const saved=base?.failedAttempt;if(saved?.pendingStep)return {runId:saved.runId,pendingStep:saved.pendingStep,decisionReceipts:saved.decisionReceipts||[],sessionState:null};return null;}
  // The failed request keeps its own run id. The visible candidate stays the previous PDF.
  function resumeForAttempt(kept,attempt){const pending=attempt?.pendingStep;if(!kept||!pending)return null;const projectId=pending.request?.projectId||pending.projectId;const project=kept.currentProject?.id===projectId?kept.currentProject:kept.baselineProject?.id===projectId?kept.baselineProject:null;if(!project)return null;const artifact=project===kept.currentProject?kept.candidate?.artifact??null:kept.baselineArtifact??null;return {...kept,runId:attempt.runId||pending.runId||kept.runId,currentProject:project,candidate:{project,artifact},pendingStep:pending,decisionReceipts:copyReceipts([...(kept.decisionReceipts||[]),...(attempt.decisionReceipts||[])])};}
  const context=()=>{const session=getSession();if(!session)return null;const s=session.getInputIdentity?.()||session.snapshot?.();if(!s)return null;return {projectId:s.projectId||s.project?.id||null,changesSignature:JSON.stringify(s.changes||[])};};
  const freshCandidate=()=>{const ctx=context(),saved=candidate?.sourceContext;return !!ctx&&!!candidate&&(saved?.projectId?JSON.stringify(ctx)===JSON.stringify(saved):same());};
  const previewLoad=bytes=>{let task,destroyed=false;return {promise:loadPdf().then(lib=>{task=lib.getDocument({data:bytes,cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href});if(destroyed){void task.destroy();throw aborted();}return task.promise;}),destroy(){destroyed=true;return task?.destroy();}};};
  const viewer=previewFactory({doc,originalCanvas,candidateCanvas:canvas,loadPdf:previewLoad,baseUrl:base,onStatus:message=>{pageLabel.textContent=typeof message==='string'?message:message?.message||'';},onPage:info=>{const c=info?.candidate,o=info?.original;if(c){previewPages=c.totalPages||0;candidatePage.max=String(previewPages||1);}if(o)originalPage.max=String(o.totalPages||1);controls();},onText:info=>{if(info?.original!==undefined)originalText.textContent=typeof info.original==='string'?info.original:info.original?.text||'';if(info?.candidate!==undefined)candidateText.textContent=typeof info.candidate==='string'?info.candidate:info.candidate?.text||'';}});
  recordButton.onclick=()=>{if(!candidate)return;download(new TextEncoder().encode(JSON.stringify({schema:'falsify.paper-layout-agent-run.v1',status:candidate.status,runState:candidate.runState,quality:candidate.quality,projectId:candidate.project?.id,pdfHash:candidate.artifact?.pdfHash,goal:candidate.goal||'',decisions:candidate.decisionReceipts||[],trace:candidate.trace||[],coverage:candidate.coverage,message:candidate.message,...(failedRun?{failedRun:{runId:failedRun.runId,runState:failedRun.runState,status:failedRun.status,message:failedRun.message,trace:failedRun.trace||[],pendingStep:failedRun.pendingStep||null,decisionReceipts:failedRun.decisionReceipts||[]}}:{})},null,2)),'layout-agent-run.json','application/json');};
  const same=()=>{const s=getSession();return !!s&&signature&&signature.epoch===getEpoch()&&signature.session===s&&signature.changes===context()?.changesSignature;};
  function controls(){box.setAttribute('aria-busy',String(!!controller));previousPdf.hidden=!candidate?.previousCandidate?.artifact?.pdfBytes;recordButton.disabled=!candidate;const fresh=freshCandidate();resultBox.hidden=!candidate;start.disabled=!!controller;cancel.hidden=!controller;pdf.disabled=!candidate?.artifact?.pdfBytes;source.disabled=!candidate?.project;saveRun.disabled=!candidate?.sessionState;reset.disabled=!!controller;blue.disabled=!!controller||!fresh||!candidate?.artifact?.pdfBytes;adopt.disabled=!!controller||!fresh||!candidate?.project||typeof loadCandidate!=='function';navigationControls(fresh);}
  function navigationControls(fresh){previous.disabled=!previewPages||previewPage===0;next.disabled=!previewPages||previewPage>=previewPages-1;historyLabel.hidden=history.size<2;revisionLabel.hidden=!(candidate?.sessionState?.checkpoints?.length);historySelect.disabled=revisionSelect.disabled=!!controller;originNote.hidden=!candidate||fresh;pendingNote.hidden=discardPending.hidden=!(pendingProblem&&pendingStep);discardPending.disabled=!!controller;if(pendingProblem&&pendingStep)pendingNote.textContent=pendingProblem;if(candidate)identity.textContent=`후보 소스 ${candidate.project?.id||'미확인'} · PDF ${candidate.artifact?.pdfHash||'생성 전'}${fresh?' · 현재 작업':' · 다른 작업에서 만든 후보'}`;else identity.textContent='';}
  function invalidate(){if(controller&&!same()){controller.abort();status.textContent='작업 중 소스가 변경되어 중단했습니다.';}controls();}
  async function preview(){
    const own=++previewTicket,artifact=candidate?.artifact,baseline=candidate?.sessionState?.baselineArtifact,original=candidate?.originalReference;previewPages=0;controls();
    if(!artifact?.pdfBytes){canvas.width=canvas.height=originalCanvas.width=originalCanvas.height=1;pageLabel.textContent='';return;}
    try{
      const before=original?{pdfBytes:original,pdfHash:hex(original)}:baseline?.pdfBytes?baseline:null;
      const key=(before?.pdfHash||'')+'|'+artifact.pdfHash;
      if(key!==viewerKey){await viewer.setDocuments({original:before,candidate:artifact});if(own!==previewTicket)return;viewerKey=key;}if(own!==previewTicket)return;
      originalLabel.hidden=originalCanvas.hidden=originalPageLabel.hidden=!before;originalLabel.textContent=original?'원본 PDF':'배치 전 PDF';
      const shown=await viewer.show({originalPageIndex:originalIndex,candidatePageIndex:previewPage,focus:previewFocus});if(own!==previewTicket)return;
      paintPreviewPages(shown,original);
    }catch(e){if(own===previewTicket&&e.name!=='AbortError'){pageLabel.textContent='미리보기를 표시하지 못했습니다. PDF는 다운로드할 수 있습니다.';previewPages=0;controls();}}
  }
  function paintPreviewPages(shown,original){
      const c=shown?.candidate,o=shown?.original;if(c?.totalPages)previewPages=c.totalPages;if(c?.pageIndex!==undefined)previewPage=c.pageIndex;if(o?.pageIndex!==undefined)originalIndex=o.pageIndex;originalLabel.textContent=`${original?'원본 PDF':'배치 전 PDF'} ${originalIndex+1}${o?.totalPages?' / '+o.totalPages:''}쪽`;
      candidatePage.value=String(previewPage+1);originalPage.value=String(originalIndex+1);candidateLabel.textContent=`후보 PDF ${previewPage+1}${previewPages?' / '+previewPages:''}쪽`;pageLabel.textContent=`후보 ${previewPage+1}${previewPages?' / '+previewPages:''}쪽`;controls();
  }
  function paintOutcome(){
    if(!candidate){outcome.textContent='';findings.replaceChildren?.();return;}
    const q=candidate.quality,content={unchanged:'내용 유지',changed:'내용 차이 있음',unverified:'내용 확인 전'},layout={clear:'검사 범위에서 문제 없음',issues:'배치 확인 필요',unverified:'배치 확인 전'};
    const states={running:'작업 중',completed:'작업 끝',paused:'이어서 조정 가능',cancelled:'중단됨',failed:'실행 실패'};
    outcome.textContent=[states[candidate.runState]||runLabels[candidate.status]||'작업 끝',q?content[q.content]||'내용 확인 전':candidate.message||'',q?layout[q.layout]||'배치 확인 전':'',q?.observedPages?`확인한 후보 ${q.observedPages.length}쪽`:''].filter(Boolean).join(' · ');
    paintFindings(q);paintHistory();paintRevisions();
  }
  function paintFindings(q){
    const labels={TEXT_MISSING:'추출 글자 누락',TEXT_ADDED:'추출 글자 추가',NUMBERS_MISSING:'숫자 누락',NUMBERS_ADDED:'숫자 추가',SOURCE_CONTENT_CHANGED:'소스 내용 차이',SOURCE_NUMBERS_MISSING:'소스 숫자 누락',SOURCE_NUMBERS_ADDED:'소스 숫자 추가',LINKS_MISSING:'인용 링크 누락',ASSETS_CHANGED:'그림·자산 차이',text_overlap:'글자 겹침',text_outside_page:'쪽 영역 밖의 글자','text-overlap':'글자 겹침','ink-outside-page':'쪽 영역 밖의 내용','text-clipped':'잘린 글자','text-image-overlap':'글자·그림 겹침','small-body-text':'작은 본문 글씨','body-font-deviation':'본문 글꼴 차이','caption-separated':'떨어진 캡션','heading-orphan':'홀로 남은 제목','blank-column':'빈 단',TEX_OVERFULL_BOX:'줄 너비 초과'};
    findings.replaceChildren?.();for(const f of q?.findings||[]){const li=el('li'),label=`${Number.isSafeInteger(f.pageIndex)?(f.pageIndex+1)+'쪽 · ':''}${labels[f.code]||f.message||f.code||'확인할 부분'}`;if(Number.isSafeInteger(f.pageIndex)){const b=el('button',label);b.type='button';b.title=f.message||f.code;b.className='button secondary';b.onclick=()=>{previewFocus=Array.isArray(f.bbox)?{document:f.document==='original'?'original':'candidate',bbox:f.bbox}:null;if(f.document==='original')originalIndex=f.pageIndex;else previewPage=f.pageIndex;void preview();};li.append(b);}else li.textContent=label;findings.append(li);}
  }
  function paintHistory(){
    historySelect.replaceChildren?.();for(const [id,h] of history){const option=el('option',`${h.goal||'레이아웃 후보'} · ${runLabels[h.status]||h.runState||'저장됨'}`);option.value=id;historySelect.append(option);}historySelect.value=candidate.runId||candidate.artifact?.pdfHash||candidate.project?.id;
  }
  function paintRevisions(){
    revisionSelect.replaceChildren?.();const first=el('option','지점 선택');first.value='';revisionSelect.append(first);for(const cp of candidate.sessionState?.checkpoints||[]){const option=el('option',`${cp.label||cp.revisionId}${cp.artifact?'':' · PDF 생성 전'}`);option.value=cp.revisionId;revisionSelect.append(option);}revisionSelect.value=candidate.sessionState?.activeRevisionId||'';
  }
  function setCandidate(value){const changed=candidate?.artifact?.pdfHash!==value?.artifact?.pdfHash||candidate?.project?.id!==value?.project?.id;candidate=value?{...value,sourceContext:value.sourceContext||context(),goal:value.goal??runGoal,decisionReceipts:value.decisionReceipts||[...receipts]}:null;if(candidate){const key=candidate.runId||candidate.artifact?.pdfHash||candidate.project?.id;history.set(key,candidate);}if(changed){previewPage=originalIndex=0;previewFocus=null;canvas.width=canvas.height=1;pageLabel.textContent=value?'후보 미리보기 준비 중…':'';}paintOutcome();controls();if(changed)void preview();}
  async function remember(state){if(!state)return;const generation=saveGeneration;runState={...state,pendingStep,sourceContext:state.sourceContext||context(),goal:state.goal??runGoal,decisionReceipts:state.decisionReceipts||copyReceipts(receipts)};if(candidate?.runId===runState.runId){candidate={...candidate,sessionState:runState,decisionReceipts:runState.decisionReceipts||candidate.decisionReceipts};history.set(candidate.runId,candidate);}if(generation!==saveGeneration)return;pendingSave=runState;try{onRunState(runState);}catch{}
    // Re-check after each drain: a state queued while the previous loop was finishing must still be written.
    // reset/dispose bumps saveGeneration so a stale queued snapshot is not submitted after it.
    while(generation===saveGeneration&&(pendingSave||savePromise)){if(!savePromise)savePromise=(async()=>{while(generation===saveGeneration&&pendingSave){const next=pendingSave;pendingSave=null;try{const saved=await store.put(next,{consent:persist});if(generation!==saveGeneration)return;if(saved?.storageError)status.textContent='기기 저장 공간을 확인하세요. 현재 결과는 작업 파일로 받을 수 있습니다.';}catch(e){if(generation===saveGeneration)status.textContent=`현재 결과는 유지됩니다. 임시 저장: ${e.message}`;}}})().finally(()=>{savePromise=null;});await savePromise;}}
  async function restore(state){if(!state)return;state=await validateStoredRun(state);if(!state.sourceContext){const current=await getSession()?.getCurrentProject?.();state={...state,sourceContext:current?.id===state.baselineProject.id?context():{projectId:state.baselineProject.id,changesSignature:"archived-source"}};}pendingStep=state.pendingStep||null;pendingProblem=null;runState=state;box.open=true;runGoal=state.goal||goal.value;goal.value=runGoal;const pair=state.candidate||{project:state.currentProject,artifact:null};setCandidate({...pair,runId:state.runId,status:state.status||'unresolved',runState:state.runState,quality:state.quality,coverage:state.coverage,trace:state.trace,sessionState:state,previousCandidate:state.previousCandidate,sourceContext:state.sourceContext,goal:state.goal,decisionReceipts:state.decisionReceipts||[]});await remember(state);}
  historySelect.onchange=()=>{const selected=history.get(historySelect.value);if(selected)setCandidate(selected);};
  revisionSelect.onchange=()=>{const state=candidate?.sessionState,cp=state?.checkpoints?.find(c=>c.revisionId===revisionSelect.value);if(cp)void restore({...state,currentProject:cp.project,candidate:{project:cp.project,artifact:cp.artifact},quality:{content:'unverified',layout:'unverified',observedPages:[],findings:[]},status:'unresolved',runState:'paused',pendingStep:null,activeRevisionId:cp.revisionId});};
  // A receipt that cannot be recovered is discarded only by the user; no request is resubmitted here.
  discardPending.onclick=async()=>{if(controller||!pendingStep)return;pendingStep=null;pendingProblem=null;if(failedRun)failedRun={...failedRun,pendingStep:null};const state=candidate?.sessionState||runState;status.textContent='보류 중인 요청을 버렸습니다. AI 레이아웃 시작을 누르면 이 후보에서 새 요청으로 이어갑니다.';controls();if(state)await remember({...state,pendingStep:null,failedAttempt:state.failedAttempt?{...state.failedAttempt,pendingStep:null}:null});};
  const selectedPage=(field,current)=>{const n=Number(field.value),max=Number(field.max)||1;return Number.isSafeInteger(n)?Math.max(1,Math.min(max,n))-1:current;};candidatePage.onchange=()=>{previewFocus=null;previewPage=selectedPage(candidatePage,previewPage);candidatePage.value=String(previewPage+1);void preview();};originalPage.onchange=()=>{previewFocus=null;originalIndex=selectedPage(originalPage,originalIndex);originalPage.value=String(originalIndex+1);void preview();};
  match.onclick=async()=>{try{const match=await viewer.findCorrespondingPage?.({from:'candidate',pageIndex:previewPage});if(match?.status==='matched'){originalIndex=match.pageIndex;await preview();}else pageLabel.textContent='대응하는 쪽을 하나로 정하지 못했습니다. 원본 쪽을 선택하세요.';}catch(e){pageLabel.textContent=e.message;}};
  saveRun.onclick=async()=>{try{if(candidate?.sessionState)download(await exportLayoutRun(candidate.sessionState),'layout-work.zip','application/zip');}catch(e){status.textContent=e.message;}};
  loadRun.onchange=async()=>{try{const file=loadRun.files?.[0];if(file)await restore(await importLayoutRun(new Uint8Array(await file.arrayBuffer())));}catch(e){status.textContent=e.message;}finally{loadRun.value='';}};
  restoreRun.onclick=async()=>{try{const saved=await store.get();if(saved)await restore(saved);else status.textContent='저장된 레이아웃 작업이 없습니다.';}catch(e){status.textContent=e.message;}};
  reset.onclick=()=>{forceFresh=true;return start.onclick();};
  previous.onclick=()=>{if(previewPage>0){previewFocus=null;previewPage--;void preview();}};next.onclick=()=>{if(previewPage+1<previewPages){previewFocus=null;previewPage++;void preview();}};
  cancel.onclick=()=>{controller?.abort();status.textContent='중단 요청됨. 마지막 생성 PDF를 확인합니다.';};
  pdf.onclick=()=>{if(candidate?.artifact?.pdfBytes)download(candidate.artifact.pdfBytes,'layout-candidate.pdf','application/pdf');};
  source.onclick=async()=>{if(!candidate?.project)return;try{const zip=await exportLatexProject(candidate.project);download(zip,'layout-candidate-source.zip','application/zip');}catch(e){status.textContent=e.message;}};
  blue.onclick=()=>{if(controller||!freshCandidate()||!candidate?.artifact?.pdfBytes)return;const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([candidate.artifact.pdfBytes],'layout-candidate.pdf',{type:'application/pdf'})}});if(doc.dispatchEvent(ev))doc.querySelector('[data-view="blue"]')?.click();};
  adopt.onclick=async()=>{if(controller||!freshCandidate()||!candidate?.project||!loadCandidate)return;const selected=candidate;adopt.disabled=true;try{const zip=await exportLatexProject(selected.project);if(candidate!==selected||!freshCandidate())return;await loadCandidate(new File([zip],'layout-candidate-source.zip',{type:'application/zip'}));}catch(e){status.textContent=e.message;}finally{controls();}};
  function mergeRunReceipts(baseResume,resume,attempt){return copyReceipts([...(baseResume?.decisionReceipts||[]),...(resume?.decisionReceipts||[]),...(attempt?.decisionReceipts||[])]);}
  function initializeLayoutRun(session){
    const userFresh=forceFresh;forceFresh=false;
    const baseResume=!userFresh&&freshCandidate()&&!(replacementFiles.files?.length)?candidate?.sessionState:null;
    const attempt=!userFresh&&!(replacementFiles.files?.length)?recoverableAttempt(baseResume):null;
    const resume=attempt?.pendingStep?(attempt.sessionState||resumeForAttempt(baseResume,attempt)||baseResume):baseResume;
    const inputContext=context(),own=new AbortController(),runId=globalThis.crypto?.randomUUID?.()||'layout-'+Date.now()+'-'+Math.random().toString(36).slice(2);let recovered=attempt?.pendingStep||resume?.pendingStep||null;const prior=candidate,priorRunState=runState;pendingStep=recovered;pendingProblem=null;controller=own;signature={session,epoch:getEpoch(),changes:inputContext?.changesSignature};referenceBytes=null;receipts=mergeRunReceipts(baseResume,resume,attempt);status.textContent=resume?'선택한 후보에서 작업을 이어갑니다.':'현재 선택된 변경으로 PDF를 준비합니다.';const userGoal=goal.value.trim().slice(0,2000);runGoal=userGoal;controls();
    return {resume,attempt,inputContext,own,runId,recovered,prior,priorRunState,userGoal};
  }
  async function prepareReplacements(project,artifact,compiler,own,check){
      const allowedReplacements=[],extraFiles=[];
      for(const file of [...(replacementFiles.files||[])]){if(!/\.(png|jpe?g)$/i.test(file.name)||file.size>25*1024*1024)throw new Error('교체 그림은 25MB 이하 PNG·JPEG 파일을 선택하세요.');const bytes=new Uint8Array(await file.arrayBuffer());check();const ext=/\.png$/i.test(file.name)?'png':'jpg',path='replacements/'+hex(bytes)+'.'+ext;allowedReplacements.push(path);if(!project.files.some(f=>f.path===path)&&!extraFiles.some(f=>f.path===path))extraFiles.push({path,bytes});}
      if(extraFiles.length){project=await createLatexProject({...project,files:[...project.files,...extraFiles]});artifact=await compiler.compile({project,signal:own.signal});check();if(!artifact.success)throw new Error('교체 그림을 포함한 소스를 생성하지 못했습니다.');}
      return {project,artifact,allowedReplacements};
  }
  async function prepareReference(project,check){
      let referenceBytes=null,reference=null,structure=null;if(project.origin==='reconstructed-pdf'){const file=getReferenceFile();if(!file?.arrayBuffer)throw new Error('재구성 원본 PDF가 필요합니다.');const bytes=new Uint8Array(await file.arrayBuffer());check();if(hex(bytes)!==project.sourcePdfHash)throw new Error('원본 PDF와 현재 소스가 일치하지 않습니다.');referenceBytes=bytes.slice();if(project.files?.some(f=>f.path==='falsify-layout-structure.json')){const api=await import('./paper-layout-structure.mjs');structure=await api.readLayoutStructure(project);}check();reference={schema:'falsify.paper-layout-reference.v1',sourcePdfHash:project.sourcePdfHash,...(structure?{structure:{schema:structure.schema,sourcePdfHash:structure.sourcePdfHash,unitCount:structure.units.length,columns:structure.plan?.columns}}: {})};}
      return {referenceBytes,reference,structure};
  }
  function finishedLayoutResult(result,runId,inputContext,userGoal,handlers){const keptReceipts=copyReceipts(receipts);const finished={...result,runId,sourceContext:inputContext,originalReference:referenceBytes,goal:userGoal,decisionReceipts:keptReceipts,sessionState:result.sessionState?{...result.sessionState,pendingStep,targets:handlers.getTargetMetadata(result.sessionState.currentProject),sourceContext:inputContext,goal:userGoal,decisionReceipts:keptReceipts}:undefined};
    return finished;
  }
  function shouldKeepPrevious(result,initialHash,prior,resume,attempt){
        const noNewPdf=!result.artifact?.pdfHash||result.artifact.pdfHash===initialHash;
        const failedTerminal=['failed','cancelled'].includes(result.runState);
        return failedTerminal&&noNewPdf&&prior?.artifact?.pdfBytes&&prior.artifact.pdfHash!==result.artifact?.pdfHash&&(!resume||attempt);
  }
  function keepPreviousCandidate(result,finished,runId,prior,priorRunState){
          const failedPending=pendingStep,failedReceipts=copyReceipts(receipts);
          failedRun={runId,runState:result.runState,status:result.status,message:result.message,trace:result.trace||[],pendingStep:failedPending,decisionReceipts:failedReceipts,sessionState:finished.sessionState};
          const keptState=prior.sessionState||priorRunState;const merged=copyReceipts([...(keptState?.decisionReceipts||[]),...failedReceipts]);
          const failedAttempt=failedPending||failedReceipts.length?{runId,pendingStep:failedPending||null,decisionReceipts:failedReceipts}:keptState?.failedAttempt||null;
          pendingStep=failedPending??keptState?.pendingStep??null;candidate={...prior,decisionReceipts:merged};history.set(prior.runId||prior.artifact.pdfHash||prior.project?.id,candidate);
    return {keptState,merged,failedAttempt};
  }
  function layoutConnection(){reveal();if(controller)return null;const session=getSession(),link=bridge?.session?.();if(!session||!link){status.textContent=!session?'논문을 먼저 여세요.':'PC 연결이 끊겼습니다. 연결 후 다시 누르세요.';return null;}return {session,link};}
  function layoutHandlers(project,resume,allowedReplacements,check,own){
      return createLayoutToolHandlers({project:resume?.currentProject||project,targetMetadata:resume?.targets,referenceBytes:referenceBytes||undefined,allowedReplacements,renderRegion:async input=>{check();const bytes=input.args.document==='original'?referenceBytes:input.artifact?.pdfBytes;if(!bytes)throw new Error(input.args.document==='original'?'원본 PDF를 입력하세요.':'현재 소스를 먼저 생성하세요.');return renderLayoutRegion({bytes,args:input.args,loadPdf,doc,signal:own.signal});}});
  }
  function previousCandidateStatus(result){return `${result.runState==='cancelled'?'새 실행을 중단해':'새 실행이 실패해'} 이전 후보를 유지합니다 · ${result.message||''}`;}
  function finishedRunStatus(result){return `${runLabels[result.status]||'작업 종료'} · ${result.message||''}`;}
  start.onclick=async()=>{
    const connection=layoutConnection();if(!connection)return false;const {session,link}=connection;
    const initialized=initializeLayoutRun(session);
    const {resume,attempt,inputContext,own,runId,prior,priorRunState,userGoal}=initialized;let recovered=initialized.recovered,deliveredAction=null;
    let compiler,reader;
    const check=()=>{if(own.signal.aborted||!same())throw aborted();};
    const renderDocument=async (bytes,pages,documentKind)=>{check();const lib=await loadPdf();check();const task=lib.getDocument({data:bytes.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href});let document;
          try{document=await task.promise;check();const selected=pages.length?pages.slice(0,4):[0];if(selected.some(p=>p>=document.numPages))throw new Error('요청한 페이지가 없습니다.');const images=[];for(const pageIndex of selected){check();const page=await document.getPage(pageIndex+1),natural=page.getViewport({scale:1});let scale=Math.min(1,2000/natural.width,2000/natural.height),encoded='';for(let attempt=0;attempt<5;attempt++){const viewport=page.getViewport({scale}),canvas=doc.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;check();const data=canvas.toDataURL('image/png');encoded=data.slice(data.indexOf(',')+1);if(encoded.length<=699052)break;scale*=0.7;}if(encoded.length>699052)throw new Error('페이지 이미지가 companion 크기 제한을 넘습니다.');images.push({pageIndex,mime:'image/png',base64:encoded,document:documentKind});}return {images,coverage:{renderedPages:selected,totalPages:document.numPages,visualReview:'agent observation only'}};}finally{await task.destroy();}};
    try{
      compiler=compilerFactory();reader=readerFactory();
      const cancelInitial=()=>session.cancel?.();own.signal.addEventListener('abort',cancelInitial,{once:true});let artifact,project;try{if(resume){artifact=resume.baselineArtifact;project=resume.baselineProject;}else{artifact=await session.compile();project=await session.getCurrentProject();}}finally{own.signal.removeEventListener('abort',cancelInitial);}check();
      const replacement=await prepareReplacements(project,artifact,compiler,own,check);check();
      project=replacement.project;artifact=replacement.artifact;const {allowedReplacements}=replacement;
      const referenceResult=await prepareReference(project,check);check();
      referenceBytes=referenceResult.referenceBytes;const {reference,structure}=referenceResult;
      if(artifact.projectId!==project.id)throw new Error('현재 소스와 PDF가 일치하지 않습니다.');
      if(!candidate)setCandidate({project,artifact,status:'unresolved',runId,sourceContext:inputContext,originalReference:referenceBytes,message:'검사와 렌더링 전 PDF'});
      const handlers=layoutHandlers(project,resume,allowedReplacements,check,own);
      const initialHash=artifact?.pdfHash;
      const result=await runAgent({project,artifact,runId,resumeState:resume||undefined,signal:own.signal,reference,handlers,maxSteps:32,
        onState:state=>{if(own.signal.aborted||!same())return;if(deliveredAction&&state.trace?.at(-1)?.action===deliveredAction){pendingStep=null;deliveredAction=null;}const saved={...state,pendingStep,targets:handlers.getTargetMetadata(state.currentProject),sourceContext:inputContext,goal:userGoal,decisionReceipts:copyReceipts(receipts)};void remember(saved);if(saved.candidate?.artifact?.pdfHash!==initialHash||!candidate){const pair=saved.candidate;if(pair)setCandidate({...pair,runId:saved.runId,status:saved.status,runState:saved.runState,quality:saved.quality,coverage:saved.coverage,trace:saved.trace,sessionState:saved,sourceContext:inputContext,originalReference:referenceBytes,goal:userGoal,decisionReceipts:copyReceipts(receipts),previousCandidate:saved.previousCandidate});}},
        restructure:async ({project:p,plan,signal})=>{check();const api=await import('./paper-layout-structure.mjs');check();const out=await api.applyLayoutStructure({project:p,plan,signal});check();return out;},
        readReference:async args=>{check();return readLayoutReference({...args,bytes:referenceBytes,sourcePdfHash:project.sourcePdfHash,structure,loadPdf,baseUrl:base});},
        renderReference:async ({pages,signal})=>{check();if(!referenceBytes)throw new Error('원본 PDF가 없습니다.');return {...await renderDocument(referenceBytes,pages,'original'),sourcePdfHash:project.sourcePdfHash};},
        decide:async input=>{
          check();status.textContent=recovered?'이전 AI 작업의 결과를 확인합니다.':'AI가 배치를 검토하고 있습니다.';if(deliveredAction){pendingStep=null;deliveredAction=null;}
          const payload={...input,instruction:input.instruction+(userGoal?'\nLayout goal: '+userGoal:'')};
          if(!recovered&&bridge?.state?.().cap?.paperLayoutJobs!==true)return requestLayoutDecision(link,payload,own.signal,addReceipt,{runId});
          try{
            const instance=bridge?.state?.().cap?.companionInstance;
            const out=await layoutStepDecision(link,{schema:'falsify.paper-layout-agent-step.v1',consent:true,...payload},{runId,signal:own.signal,pendingStep:recovered,companionInstance:instance,onPending:async p=>{check();pendingStep=p||null;if(runState)await remember({...runState,pendingStep});}});
            recovered=null;deliveredAction=out.response.action.tool;addReceipt({projectId:out.response.projectId,step:out.response.step,model:out.response.model,skillHash:out.response.skillHash,...stepIdentity(out.pendingStep)});return out.response.action;
          }catch(error){const failure=layoutFailureDetails(error);addReceipt({projectId:input.projectId,step:input.step,failure});if(['failed','cancelled','not-admitted'].includes(error.disposition)){pendingStep=null;recovered=null;if(runState)await remember({...runState,pendingStep:null,decisionReceipts:copyReceipts(receipts)});}else if(recovered&&!own.signal.aborted&&error?.name!=='AbortError')pendingProblem=`보류 중인 요청을 확인하지 못했습니다 (${error.recovery==='not-found'?'접수 기록 없음 또는 만료':error.recovery==='mismatch'?'요청·companion 불일치':'연결 오류'}). 다시 시작하면 같은 요청을 조회만 합니다. 버리면 이 후보에서 새 요청으로 이어갈 수 있습니다.`;throw error;}
        },
        compile:async request=>{check();const out=await compiler.compile(request);check();return out;},
        inspect:async ({artifact:a,signal})=>{check();const out=await reader.compare({bytes:a.pdfBytes,sourceFile:new File([a.pdfBytes],'layout.pdf',{type:'application/pdf'}),signal});check();const audit=out.layoutAudit;return typeof audit?.outputPdfHash==='string'&&/^[0-9a-f]{64}$/.test(audit.outputPdfHash)&&audit.outputPdfHash===a.pdfHash?{schema:'falsify.layout-quality.v1',status:audit.status,pdfHash:audit.outputPdfHash,issues:audit.findings,coverage:audit.coverage,limitations:audit.limitations}:{status:'unavailable'};},
        render:async ({artifact:a,pages,signal})=>renderDocument(a.pdfBytes,pages,'candidate'),
        onProgress:entry=>{if(!own.signal.aborted&&same())status.textContent=`${actionLabels[entry.action]||'작업'} · ${entry.result?.status==='ok'?'완료':entry.result?.status==='rejected'?'적용하지 못해 다시 조정 중':entry.result?.status==='failed'?'실패':'진행 중'}`;}
      });
      if(same()){const finished=finishedLayoutResult(result,runId,inputContext,userGoal,handlers);
        // A fresh run, or a recovered attempt, that stopped before producing its own PDF keeps the preceding candidate primary.
        if(shouldKeepPrevious(result,initialHash,prior,resume,attempt)){
          const {keptState,merged,failedAttempt}=keepPreviousCandidate(result,finished,runId,prior,priorRunState);
          if(keptState)await remember({...keptState,pendingStep,decisionReceipts:merged,...(failedAttempt?{failedAttempt}:{})});else runState=null;paintOutcome();controls();
          status.textContent=previousCandidateStatus(result);
        }else{failedRun=null;setCandidate(finished);if(finished.sessionState)await remember(finished.sessionState);status.textContent=finishedRunStatus(result);}}
    }catch(e){if(e.name!=='AbortError')status.textContent=e.message;else if(same())status.textContent='작업을 중단했습니다.';}finally{compiler?.dispose();reader?.dispose();if(controller===own)controller=null;controls();}
  };
  // Source changes drop the in-memory run; the explicitly saved run store is left for a later explicit restore.
  function resetRun(){saveGeneration++;pendingSave=null;controller?.abort();candidate=null;history.clear();runState=null;pendingStep=null;pendingProblem=null;failedRun=null;receipts=[];signature=null;referenceBytes=null;forceFresh=false;previewTicket++;viewerKey='';previewPage=originalIndex=previewPages=0;previewFocus=null;canvas.width=canvas.height=originalCanvas.width=originalCanvas.height=1;pageLabel.textContent='';status.textContent='';paintOutcome();controls();}
  controls();return {invalidate,reset:resetRun,cancel:()=>controller?.abort(),async start({goal:request}={}){if(controller){reveal();return false;}if(typeof request==='string')goal.value=request.slice(0,2000);return (await start.onclick())!==false;},getCandidate:()=>candidate,getRunState:()=>candidate?.sessionState||runState,getFailedRun:()=>failedRun,restoreRun:restore,async setPersistence(consent){persist=consent===true;await store.setConsent(persist);if(persist&&runState)await remember(runState);},dispose(){saveGeneration++;pendingSave=null;controller?.abort();viewer.dispose();store.dispose();}};
}

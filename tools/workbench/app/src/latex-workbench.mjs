import {importLatexProject,createLatexProject,analyzeProjectFiles} from './latex-project.mjs';
import {analyzeLatexSource,locateSourceText} from './latex-source-model.mjs';
import {applySourceChanges} from './latex-source-patches.mjs';
import {createLatexCompiler} from './latex-compiler-adapter.mjs';
import {parseSynctex,mapPdfToSource,mapSourceToPdf} from './latex-synctex-map.mjs';
import {buildReferencePatch} from './latex-reference-policy.mjs';
import {resolveSourceProposals} from './latex-semantic-edits.mjs';
import {createLatexSession} from './latex-session.mjs';
import {createLatexSourceEditor} from '../dist/latex-source-ui.js';
import {hex} from './paragraph-pdf-crypto.mjs';
import manifest from '../latex-compiler-manifest.json';
import {latexEngineManifest} from './latex-runtime-catalog.mjs';
import {encodeSourceSession,decodeSourceSession,isSourceDraftFresh,projectLegacyExternal} from './latex-session-archive.mjs';
import {mountPdfLatexWorkbench} from './pdf-latex-workbench.mjs';
import {createReconstructionLineage} from './pdf-latex-baseline.mjs';
import {prepareSourceExport} from './latex-source-export.mjs';
import {createReconstructionReader} from './pdf-latex-reader.mjs';
import {mountPaperLayoutAgent,layoutRunForSource} from './paper-layout-agent-ui.mjs';
import {createLatexDraftStore} from './latex-draft-store.mjs';

const base=new URL('.',import.meta.url),dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const textFile=(project,path)=>dec.decode(project.files.find(f=>f.path===path).bytes);
export function clearMissingPreviewPane({canvas,overlay,visibleText,index}){canvas.width=canvas.height=1;visibleText[index]?.element.remove();visibleText[index]=null;overlay.replaceChildren();}
export function pdfClickPoint(rect,canvas,clientX,clientY,scale=1.2){return {x:(clientX-rect.left)*canvas.width/rect.width/scale,y:(clientY-rect.top)*canvas.height/rect.height/scale};}
export function pickSourceLines(map,point,maxDistance=8){
  const exact=mapPdfToSource(map,point).candidates;
  if(exact.length)return exact;
  return map.boxes.filter(b=>b.pageIndex===point.pageIndex).map(b=>{const x=Math.max(b.box.x-point.x,0,point.x-b.box.x-b.box.width),y=Math.max(b.box.y-point.y,0,point.y-b.box.y-b.box.height);return {b,d:Math.hypot(x,y)};}).filter(v=>v.d<=maxDistance).sort((a,b)=>a.d-b.d||a.b.box.width*a.b.box.height-b.b.box.width*b.b.box.height).map(({b})=>b);
}
export async function validateRestoredChanges(project,changes){for(const c of changes){if(c.enabled===false&&c.rebindDiagnostic)continue;const result=await applySourceChanges(project,[{...c,enabled:true}]);if(result.diagnostics.length||result.applied.length!==1)throw new Error('저장된 변경 위치가 원본과 일치하지 않습니다.');}}
export function reconstructionDescriptor(p){return {schema:'falsify.latex-project-descriptor.v1',id:p.id,mainFile:p.mainFile,engine:p.engine,origin:p.origin,sourcePdfHash:p.sourcePdfHash,files:p.files.map(({path,sha256})=>({path,sha256}))};}
export function validateRestoredReconstruction(data){
  const r=data.reconstruction;if(!r){if(data.project?.origin==='reconstructed-pdf')throw new Error('재구성 기준본 기록이 없습니다.');return null;}
  const pending=r.schema==='falsify.reconstruction-pending.v1',record=pending?r.previous:r;let p=data.project;
  if(pending){const descriptor=r.previousProject;if(descriptor?.schema!=='falsify.latex-project-descriptor.v1'||r.reason!=='files-added'||r.sourcePdfHash!==p.sourcePdfHash||descriptor.sourcePdfHash!==p.sourcePdfHash||!Array.isArray(descriptor.files))throw new Error('이전 재구성 기준본 기록이 다릅니다.');p={...descriptor,schema:'falsify.latex-project.v1',files:descriptor.files.map(f=>{const actual=data.project.files.find(a=>a.path===f.path&&a.sha256===f.sha256);if(!actual)throw new Error('이전 기준본 소스가 다릅니다.');return actual;})};}
  const checked=createReconstructionLineage({project:p,artifact:data.baseline,comparison:record.comparison,bindings:record.bindings,decisions:record.decisions});
  if(data.sourceUpload?.sha256!==checked.sourcePdfHash||!(data.sourceUpload.bytes instanceof Uint8Array)||hex(data.sourceUpload.bytes)!==checked.sourcePdfHash)throw new Error('재구성 원본 PDF가 다릅니다.');
  return pending?{...structuredClone(r),previous:checked}:checked;
}
// Rebind only when the unchanged source range and exactly one node prove identity.
export async function rebindChanges(oldProject,newProject,changes) {
  const oldModel=analyzeLatexSource(oldProject), nextModel=analyzeLatexSource(newProject), result=[];
  for(const original of changes){
    const c=structuredClone(original), a=c.anchor, oldFile=oldProject.files.find(f=>f.path===a?.path), newFile=newProject.files.find(f=>f.path===a?.path);
    const oldNode=oldModel.nodes.find(n=>n.id===a?.nodeId && n.path===a.path && n.kind===a.kind && n.kind===c.kind);
    const candidates=nextModel.nodes.filter(n=>n.path===a?.path && n.kind===a?.kind && n.kind===c.kind && a.start >= (typeof c.afterSource==='string'?n.start:n.contentStart) && a.end <= (typeof c.afterSource==='string'?n.end:n.contentEnd));
    const same=oldFile && newFile && oldFile.sha256===newFile.sha256 && textFile(oldProject,a.path).slice(a.start,a.end)===c.before && textFile(newProject,a.path).slice(a.start,a.end)===c.before;
    c.anchor={...a,projectId:newProject.id};
    if(same && oldNode && candidates.length===1){c.anchor.nodeId=candidates[0].id; const verified=await applySourceChanges(newProject,[{...c,enabled:true}]);if(!verified.diagnostics.length && verified.applied.length===1){delete c.rebindDiagnostic;result.push(c);continue;}}
    c.enabled=false;c.rebindDiagnostic='원본 위치를 새 프로젝트에 안전하게 연결하지 못했습니다.';result.push(c);
  }
  return result;
}
export function missingTarget(m){const dir=m.path.includes('/')?m.path.slice(0,m.path.lastIndexOf('/')+1):'';const ref=m.reference;return dir+ref+(ref.includes('.')?'':m.command==='bibliography'||m.command==='addbibresource'?'.bib':m.command==='input'||m.command==='include'?'.tex':'');}
export function sourceLine(project,node){return textFile(project,node.path).slice(0,node.start).split('\n').length;}
export function sourceNodesAtLine(project,model,path,line){const source=textFile(project,path),lines=source.split('\n');const start=lines.slice(0,line-1).join('\n').length+(line>1?1:0),end=start+(lines[line-1]||'').length;return model.nodes.filter(n=>n.path===path&&n.start<=end&&n.end>=start);}

// Build a complete transaction before changing session history.
export function proposalTransaction(changes, proposal, enabled, projectId) {
  const primitives=proposal.sourceChanges || [proposal];
  if (!primitives.length || primitives.some(c=>!c.anchor || c.anchor.projectId!==projectId || typeof c.before!=='string' || typeof c.after!=='string')) throw new Error('이 원본에 연결된 변경이 아닙니다.');
  const overlap=(a,b)=>a.path===b.path && (a.start<b.end && b.start<a.end || a.start===b.start && (a.start===a.end || b.start===b.end));
  if (enabled && primitives.some((c,i)=>primitives.slice(i+1).some(d=>overlap(c.anchor,d.anchor)))) throw new Error('선택한 변경의 원본 범위가 겹칩니다.');
  const next=structuredClone(changes).filter(c=>c.proposalId!==proposal.id);
  const conflicts=new Set();
  if(enabled) for(const old of next) if(old.enabled!==false && primitives.some(c=>overlap(old.anchor,c.anchor))) conflicts.add(old.proposalId || old.id);
  for(const old of next) if(conflicts.has(old.proposalId || old.id)) old.enabled=false;
  return next.concat(primitives.map((c,i)=>({...c,id:proposal.id+':'+i,proposalId:proposal.id,enabled,provenance:proposal.provenance})));
}

// PDF.js item geometry determines whether adjacent extracted runs touch.
export function pdfItemSeparator(item,next){
  if(!next || !item?.transform || !next.transform || !Number.isFinite(item.width))return ' ';
  const a=item.transform,b=next.transform;
  if(Math.abs(a[1])>.01 || Math.abs(b[1])>.01 || a[0]<=0 || b[0]<=0)return ' ';
  const gap=b[4]-(a[4]+item.width), height=Math.max(Math.abs(a[3]),Math.abs(b[3]),1);
  return gap>=-height*.15 && gap<=height*.12 ? '' : ' ';
}
export function highlightEdits(changes,proposals,model){
  const enabled=changes.filter(c=>c.enabled!==false), result=[];
  for(const p of proposals){const group=enabled.filter(c=>c.proposalId===p.id);if(group.length && group.length===changes.filter(c=>c.proposalId===p.id).length)result.push({id:p.id,before:p.before,after:p.after});}
  for(const c of enabled.filter(c=>!c.proposalId)){const node=model?.nodes?.find(n=>n.id===c.anchor?.nodeId);result.push({id:c.id,before:node?.displayText ?? c.before,after:c.after});}
  return result;
}
export function mountLatexWorkbench(doc=globalThis.document){
  const intake=doc.getElementById('paper-file'),pdfWorkspace=doc.getElementById('paper-workspace');
  if(!intake||!pdfWorkspace)return null;
  const host=doc.createElement('section');host.id='latex-source-workbench';host.hidden=true;pdfWorkspace.before(host);
  let active=false,session=null,project=null,model=null,upload=null,epoch=0,currentPage=0,latestState=null,selection=null,externalHome=null,externalPanel=null,renderEpoch=0;
  let batches=[],proposals=[],busyImport=false,importError=null,documentCache=null,pdfjs=null,uploadHash='',mainTicket=0,pendingRestore=null,reconstruction=null,reconstructionTicket=0,restoreTicket=0;
  const reconstructionReader=createReconstructionReader(),draftKey='falsify.latex-source-draft.v1';let draftTimer=null,draftExpiry=null,draftVersion=0;
  try{const stored=JSON.parse(localStorage.getItem(draftKey)||'null');if(stored&&!isSourceDraftFresh(stored))localStorage.removeItem(draftKey);else if(stored)draftExpiry=setTimeout(()=>{localStorage.removeItem(draftKey);refreshDraftEntry();},Math.max(0,stored.savedAt+12*60*60*1000-Date.now()));}catch{}
  const el=(tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const showError=e=>{importError={message:e.message||String(e),code:e.code};if(!active){const target=doc.getElementById('import-status');if(target)target.textContent=importError.message;}paint();};
  function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type})),a=el('a');a.href=url;a.download=name;doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  const layoutSession={
    getInputIdentity:()=>({projectId:project?.id,changes:structuredClone(pendingRestore?.changes||session?.getInputIdentity?.().changes||session?.snapshot().changes||[])}),
    snapshot:()=>({...session.snapshot(),changes:structuredClone(pendingRestore?.changes||session.snapshot().changes)}),
    async compile(){await compileExplicit();return session.getCurrentOutput();},
    async getCurrentProject(){if(pendingRestore){const r=await applySourceChanges(project,pendingRestore.changes);if(r.diagnostics?.length)throw new Error(r.diagnostics[0].message);return r.project;}return session.getCurrentProject();},
    cancel:()=>session?.cancel?.()
  };
  const layoutAgent=mountPaperLayoutAgent({doc,host,getSession:()=>session?layoutSession:null,getEpoch:()=>epoch,getReferenceFile:()=>project?.origin==='reconstructed-pdf'?upload:null,download,loadCandidate:load,onRunState:()=>scheduleDraft()});
  async function exportCurrentSource(){const own=epoch,original=project,changes=structuredClone(pendingRestore?.changes||session.snapshot().changes),lineage=structuredClone(reconstruction);const result=await applySourceChanges(original,changes);if(result.diagnostics.length)throw new Error(result.diagnostics[0].message);const exported=await prepareSourceExport({baselineProject:original,currentProject:result.project,changes,reconstruction:lineage});if(own!==epoch||JSON.stringify(changes)!==JSON.stringify(pendingRestore?.changes||session.snapshot().changes))throw new DOMException('취소했습니다.','AbortError');download(exported.zip,'paper-source.zip','application/zip');}
  const editor=createLatexSourceEditor({container:host,onImport:load,onEdit:edit,onCompile:()=>run(compileExplicit),onDownload:()=>run(async()=>{const a=await session.compile();download(a.pdfBytes,'paper.pdf','application/pdf');}),onDownloadLast:()=>{const a=session?.snapshot().lastArtifact;if(a?.success)download(a.pdfBytes,'paper-last.pdf','application/pdf');},onBlue:()=>run(async()=>{const a=await session.compile(),ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([a.pdfBytes],'paper.pdf',{type:'application/pdf'})}});if(doc.dispatchEvent(ev))doc.querySelector('[data-view="blue"]')?.click();}),onExportSource:()=>run(exportCurrentSource),onUndo:()=>session?.undo(),onRedo:()=>session?.redo(),onSelect:id=>{selection={nodeId:id};}});
  const preview=editor.getPreviewHost(),toolbar=el('div','','latex-preview-toolbar'),prev=el('button','←'),pageLabel=el('span'),next=el('button','→');
  prev.type=next.type='button';prev.setAttribute('aria-label','이전 쪽');next.setAttribute('aria-label','다음 쪽');toolbar.append(prev,pageLabel,next);
  const comparison=el('div','','latex-preview-panes'),left=el('div','','latex-preview-pane'),right=el('div','','latex-preview-pane');
  const leftTitle=el('h3','원본 · 고칠 곳을 누르세요'),rightTitle=el('h3','수정본'),leftCanvas=el('canvas'),rightCanvas=el('canvas'),picker=el('div','','latex-node-picker');
  const leftFrame=el('div','','latex-highlight-frame'),rightFrame=el('div','','latex-highlight-frame'),leftOverlay=el('div','','latex-highlight-overlay'),rightOverlay=el('div','','latex-highlight-overlay'),highlightLabel=el('p','','latex-highlight-label');leftCanvas.setAttribute('aria-label','원본 PDF');rightCanvas.setAttribute('aria-label','수정 PDF');leftFrame.append(leftCanvas,leftOverlay);rightFrame.append(rightCanvas,rightOverlay);left.append(leftTitle,leftFrame);right.append(rightTitle,rightFrame);preview.append(highlightLabel);comparison.append(left,right);preview.append(toolbar,comparison,picker);
  const mainPicker=el('div','','latex-main-picker'),changeList=el('div','','latex-change-list'),cancel=el('button','취소');cancel.type='button';cancel.onclick=()=>{if(busyImport)deactivate();else session?.cancel();};host.append(cancel,mainPicker,changeList);
  const addLabel=el('label','누락된 파일 추가 '),addFiles=el('input'),fileList=el('div','','latex-project-files');addFiles.type='file';addFiles.multiple=true;addLabel.append(addFiles);host.append(addLabel,fileList);addFiles.onchange=()=>run(async()=>{await addProjectFiles([...addFiles.files]);addFiles.value='';});
  const originalDownload=el('button','처음 올린 원본 다운로드');originalDownload.type='button';originalDownload.onclick=()=>{if(upload)download(upload,upload.name,upload.type||'application/octet-stream');};host.append(originalDownload);
  const archive=el('details'),archiveTitle=el('summary','작업 저장 및 불러오기'),saveArchive=el('button','작업 JSON 저장'),loadArchive=el('input'),draftLabel=el('label','이 기기에 12시간 임시 저장'),draftConsent=doc.createElement('input'),restoreDraft=el('button','임시 저장 불러오기');
  saveArchive.type=restoreDraft.type='button';loadArchive.type='file';loadArchive.accept='.json,application/json';draftConsent.type='checkbox';draftLabel.prepend(draftConsent);loadArchive.setAttribute('aria-label','작업 JSON 불러오기');archive.append(archiveTitle,saveArchive,loadArchive,draftLabel,restoreDraft);host.append(archive);
  saveArchive.onclick=()=>run(async()=>download(await encodeArchive(),'latex-session.json','application/json'));
  loadArchive.onchange=()=>run(async()=>{const f=loadArchive.files?.[0],capturedEpoch=epoch,reading=++restoreTicket;if(f){const json=await f.text();if(reading!==restoreTicket||capturedEpoch!==epoch)throw new DOMException('취소했습니다.','AbortError');await restoreArchive(json);}loadArchive.value='';});
  const draftStore=createLatexDraftStore(),draftStatus=el('p');draftStatus.setAttribute('role','status');archive.append(draftStatus);
  const draftEntry=el('section','','latex-draft-entry'),resumeDraft=el('button','저장한 작업 이어서 열기');resumeDraft.type='button';resumeDraft.className='button primary';draftEntry.setAttribute('aria-label','저장한 작업');draftEntry.append(resumeDraft);pdfWorkspace.before(draftEntry);
  function refreshDraftEntry(){let stored;try{stored=JSON.parse(localStorage.getItem(draftKey)||'null');}catch{}draftEntry.hidden=active||!stored||!isSourceDraftFresh(stored);}
  refreshDraftEntry();
  draftConsent.onchange=()=>run(async()=>{const version=++draftVersion,wanted=draftConsent.checked;if(!wanted){clearTimeout(draftTimer);clearTimeout(draftExpiry);localStorage.removeItem(draftKey);const cleared=draftStore.clear();await layoutAgent.setPersistence(false);await cleared;}else{await layoutAgent.setPersistence(true);if(version===draftVersion&&draftConsent.checked)await saveDraft();}refreshDraftEntry();});
  host.addEventListener('input',()=>scheduleDraft());host.addEventListener('change',()=>scheduleDraft());
  function scheduleDraft(){if(!draftConsent.checked)return;clearTimeout(draftTimer);draftTimer=setTimeout(()=>run(saveDraft),500);}
  restoreDraft.onclick=()=>run(async()=>{let draft=await draftStore.get();if(!draft){const raw=localStorage.getItem(draftKey);try{draft=JSON.parse(raw);}catch{}}if(!draft?.archive||!isSourceDraftFresh(draft)){localStorage.removeItem(draftKey);throw new Error('유효한 12시간 임시 저장이 없습니다.');}await restoreArchive(draft.archive);});
  resumeDraft.onclick=()=>restoreDraft.onclick();
  async function saveDraft(){if(!draftConsent.checked||!project||!session)return;const version=++draftVersion,sourceEpoch=epoch,archive=await encodeArchive();if(version!==draftVersion||sourceEpoch!==epoch||!draftConsent.checked)return;const saved=await draftStore.put(archive,{consent:true});if(version!==draftVersion||sourceEpoch!==epoch||!draftConsent.checked)return;const savedAt=saved.savedAt||Date.now();if(saved.persisted)localStorage.setItem(draftKey,JSON.stringify({consent:true,savedAt,storage:'indexeddb'}));else localStorage.removeItem(draftKey);refreshDraftEntry();draftStatus.textContent=saved.storageError?'기기 저장 공간을 확인하세요. 현재 작업은 작업 JSON으로 받을 수 있습니다.':'현재 작업과 레이아웃 후보를 12시간 임시 저장했습니다.';clearTimeout(draftExpiry);draftExpiry=setTimeout(()=>{draftConsent.checked=false;draftVersion++;clearTimeout(draftTimer);localStorage.removeItem(draftKey);void draftStore.clear();void layoutAgent.setPersistence(false);draftStatus.textContent='임시 저장 기간이 끝났습니다. 계속 저장하려면 다시 동의하세요.';refreshDraftEntry();},12*60*60*1000);}
  const changeTitle=el('h3','반영할 변경'),rows=el('div');changeList.append(changeTitle,rows);
  function externalPosition(){const panel=doc.getElementById('external-red');if(active&&panel&&panel.parentNode!==host){externalPanel=panel;externalHome={parent:panel.parentNode,next:panel.nextSibling};host.append(panel);}else if(!active&&externalPanel&&externalHome){externalHome.parent.insertBefore(externalPanel,externalHome.next?.parentNode===externalHome.parent?externalHome.next:null);externalPanel=null;externalHome=null;}}
  function editorDiagnostics(s){return importError?[importError]:s.error?.diagnostics?.length?s.error.diagnostics:s.error?[{message:s.error.message}]:project?analyzeProjectFiles(project).missingFiles.map(m=>({message:`필요한 파일: ${missingTarget(m)} (${m.path}에서 참조)`})) :[];}
  function paint(){layoutAgent.invalidate();refreshDraftEntry();if(!active)return;leftTitle.textContent=project?.origin==='reconstructed-pdf'?'재구성 기준본 · 고칠 곳을 누르세요':'원본 · 고칠 곳을 누르세요';leftCanvas.setAttribute('aria-label',project?.origin==='reconstructed-pdf'?'재구성 기준본 PDF':'원본 PDF');host.hidden=false;pdfWorkspace.hidden=true;externalPosition();const s=latestState||{};cancel.hidden=!(busyImport||s.busy);originalDownload.disabled=!upload;editor.setState({project,model,artifact:s.artifact,lastArtifact:s.lastArtifact,busy:busyImport||s.busy,diagnostics:editorDiagnostics(s),changes:pendingRestore?.changes||s.changes||[],selection,canUndo:s.canUndo,canRedo:s.canRedo});if(selection?.nodeId)editor.selectNode(selection.nodeId);
    rightTitle.textContent=s.busy?'수정본 만드는 중…':s.artifact?'수정본':s.lastArtifact?'이전 생성본 · 갱신 대기':'수정본';
    paintChanges(s);
    void updateHighlights();doc.dispatchEvent(new CustomEvent('falsify:latex-state'));scheduleDraft();
  }
  function paintChanges(s){
    rows.replaceChildren();for(const p of proposals){const row=el('label','','latex-change-row'),check=doc.createElement('input');check.type='checkbox';const group=(pendingRestore?.changes||s.changes||[]).filter(c=>c.proposalId===p.id);check.checked=!!group.length&&group.every(c=>c.enabled!==false);check.disabled=!!pendingRestore||p.status!=='matched';check.addEventListener('change',()=>selectProposal(p,check.checked));row.append(check,el('span',`${p.before} → ${p.after||'(삭제)'}`));if(p.status!=='matched'){row.append(el('small',p.rebindDiagnostic||'위치를 원본에서 선택하세요.'));if(['missing','ambiguous','unresolved'].includes(p.status)){const bind=el('button','선택한 원본에 연결');bind.type='button';bind.disabled=!!pendingRestore;bind.onclick=()=>run(()=>bindProposal(p));row.append(bind);}}rows.append(row);}
    paintManualChanges(s);
  }
  function paintManualChanges(s){
    for(const c of pendingRestore?.changes||s.changes||[]){if(c.proposalId)continue;const row=el('label','','latex-change-row'),check=doc.createElement('input');check.type='checkbox';check.checked=c.enabled!==false;check.disabled=!!pendingRestore||!!c.rebindDiagnostic;check.addEventListener('change',()=>session.setChange({...c,enabled:check.checked}));row.append(check,el('span',`${c.before} → ${c.after||'(삭제)'}`));if(c.rebindDiagnostic)row.append(el('small',c.rebindDiagnostic));rows.append(row);}changeList.hidden=!proposals.length&&!(pendingRestore?.changes||s.changes||[]).length;fileList.textContent=project?`파일: ${project.files.map(f=>f.path).join(', ')} · 시작: ${project.mainFile||'미선택'}`:'';
  }
  async function run(fn){try{importError=null;return await fn();}catch(e){if(e.name!=='AbortError')showError(e);}}
  async function load(file){if(!file)return;if(/\.json$/i.test(file.name))return run(async()=>{const capturedEpoch=epoch,reading=++restoreTicket,json=await file.text();if(reading!==restoreTicket||capturedEpoch!==epoch)throw new DOMException('취소했습니다.','AbortError');await restoreArchive(json);});if(!/\.(tex|zip)$/i.test(file.name))return;const ticket=++epoch;layoutAgent.reset();reconstructionReader.cancel();pendingRestore=null;reconstruction=null;renderEpoch++;mainTicket++;documentCache?.dispose();documentCache=null;clearPreview();session?.dispose();session=null;project=null;model=null;selection=null;latestState=null;batches=[];proposals=[];currentPage=0;upload=file;uploadHash='';active=true;busyImport=true;importError=null;mainPicker.replaceChildren();leftCanvas.width=rightCanvas.width=1;paint();doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));
    try{renderedKey=leftRendered='';const hash=hex(new Uint8Array(await file.arrayBuffer()));if(ticket!==epoch)return;const p=await importLatexProject(file);if(ticket!==epoch)return;uploadHash=hash;const analysis=analyzeProjectFiles(p);if(!p.mainFile){project=p;const label=el('label','시작 파일 '),select=doc.createElement('select');for(const path of analysis.mainCandidates){const option=el('option',path);option.value=path;select.append(option);}const choose=el('button','열기');choose.type='button';choose.onclick=()=>run(async()=>{const choice=++mainTicket,path=select.value;const selected=await createLatexProject({...p,mainFile:path});if(ticket===epoch&&choice===mainTicket)await start(selected,ticket);});label.append(select);mainPicker.append(label,choose);if(!analysis.mainCandidates.length)throw new Error('문서를 시작하는 .tex 파일을 찾지 못했습니다. main.tex와 필요한 파일을 ZIP으로 넣으세요.');return;}await start(p,ticket);
    }catch(e){if(ticket===epoch)showError(e);}finally{if(ticket===epoch){busyImport=false;paint();}}}
  async function start(p,ticket,{compile=true,initialArtifact}={}){if(ticket!==epoch)return;session?.dispose();session=null;mainPicker.replaceChildren();project=p;model=analyzeLatexSource(p);const compiler=createLatexCompiler({assetBase:new URL('latex-compiler-vendor/',base).href});
    session=createLatexSession({project,applyChanges:applySourceChanges,compiler,generationApi:globalThis.FalsifyPaperGeneration,engineManifest:p.engine==='lualatex'?{...manifest,luaProfile:latexEngineManifest(p.engine)}:manifest,...(initialArtifact?{initialArtifact}:{}),onState:s=>{if(ticket!==epoch)return;latestState=s;paint();},onOutput:()=>{if(ticket===epoch)void render();}});latestState=session.snapshot();busyImport=false;paint();if(compile)await session.compile();if(initialArtifact&&ticket===epoch)void render();if(ticket===epoch)scheduleDraft();}
  async function loadReconstructed({project:p,file,initialArtifact,reconstruction:lineage,signal}={}){
    if(p?.origin!=='reconstructed-pdf'||!file?.arrayBuffer)throw new Error('재구성 원본과 소스가 필요합니다.');
    const operation=++reconstructionTicket,startingEpoch=epoch,aborted=()=>new DOMException('취소했습니다.','AbortError');
    const hash=hex(new Uint8Array(await file.arrayBuffer())),verified=await createLatexProject(p);
    if(operation!==reconstructionTicket||startingEpoch!==epoch||signal?.aborted)throw aborted();
    if(hash!==p.sourcePdfHash||verified.id!==p.id)throw new Error('원본 PDF와 재구성 프로젝트가 다릅니다.');
    const checked=createReconstructionLineage({project:verified,artifact:initialArtifact,comparison:lineage?.comparison,bindings:lineage?.bindings,decisions:lineage?.decisions});
    const ticket=++epoch;layoutAgent.reset();renderEpoch++;session?.dispose();session=null;documentCache?.dispose();documentCache=null;clearPreview();
    pendingRestore=null;reconstruction=checked;project=model=null;selection=latestState=null;batches=[];proposals=[];currentPage=0;upload=file;uploadHash=hash;active=true;busyImport=true;importError=null;leftCanvas.width=rightCanvas.width=1;renderedKey=leftRendered='';paint();
    try{await start(verified,ticket,{initialArtifact});if(ticket!==epoch||signal?.aborted)throw aborted();if(session.getBaseline()?.pdfHash!==checked.baselinePdfHash)throw new Error('확인한 기준본과 편집기의 기준본이 다릅니다.');doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));return {projectId:verified.id,pdfHash:checked.baselinePdfHash};}catch(e){if(ticket===epoch)deactivate();throw e;}finally{if(ticket===epoch){busyImport=false;paint();}}
  }
  function rebindSelection(rebound,next,oldSelection){
    for(const c of rebound.filter(c=>c.rebindDiagnostic&&c.proposalId))for(const peer of rebound.filter(v=>v.proposalId===c.proposalId)){peer.enabled=false;peer.rebindDiagnostic??='같은 제안의 다른 위치를 다시 확인하세요.';}
    const nextModel=analyzeLatexSource(next),oldNode=model.nodes.find(n=>n.id===oldSelection?.nodeId);
    const selected=oldNode&&nextModel.nodes.filter(n=>n.path===oldNode.path&&n.kind===oldNode.kind&&n.start===oldNode.start&&n.end===oldNode.end);
    return selected?.length===1?{...oldSelection,nodeId:selected[0].id}:null;
  }
  function updateReboundProposal(p,group){if(group.some(c=>c.rebindDiagnostic)){p.status='unresolved';p.rebindDiagnostic='새 프로젝트에서 위치를 다시 확인하세요.';}else if(group.length){p.anchor=group[0].anchor;if(p.sourceChanges)p.sourceChanges=group.map(c=>({...c}));}}
  function chooseAddedPath(file,missing,paths){
      const matches=missing.map(m=>missingTarget(m)).filter(p=>p.split('/').pop()===file.name);
      const initial=file.webkitRelativePath||([...new Set(matches)].length===1?matches[0]:file.name);
      const path=globalThis.prompt('추가할 프로젝트 상대 경로',initial);if(path===null)return null;
      if(paths.has(path))throw new Error(`이미 존재하는 파일입니다: ${path}`);paths.add(path);return path;
  }
  function pendingReconstruction(previousReconstruction,next,oldProject){return previousReconstruction?{schema:'falsify.reconstruction-pending.v1',sourcePdfHash:next.sourcePdfHash,reason:'files-added',previous:previousReconstruction.previous||previousReconstruction,previousProject:previousReconstruction.previousProject||reconstructionDescriptor(oldProject)}:null;}
  async function addProjectFiles(files){
    if(!project||!session||!files.length)throw new Error('원본을 먼저 선택하세요.');
    const added=[],paths=new Set(project.files.map(f=>f.path)),missing=analyzeProjectFiles(project).missingFiles;
    for(const file of files){
      const path=chooseAddedPath(file,missing,paths);if(path===null)return;added.push({path,bytes:new Uint8Array(await file.arrayBuffer())});
    }
    const oldProject=project,changes=pendingRestore?.changes||session.snapshot().changes,previousBaseline=pendingRestore?.baseline||session.getBaseline(),previousReconstruction=reconstruction;
    const next=await createLatexProject({...project,files:[...project.files,...added]});
    const rebound=await rebindChanges(oldProject,next,changes),oldSelection=editor.getUnfinishedEdit()||selection;
    selection=rebindSelection(rebound,next,oldSelection);
    for(const p of proposals){let group=rebound.filter(c=>c.proposalId===p.id);if(!group.length&&p.status==='matched'){const primitives=p.sourceChanges||[p];group=await rebindChanges(oldProject,next,primitives.map((c,i)=>({...c,id:c.id||`${p.id}:${i}`,kind:c.kind||p.kind})));}updateReboundProposal(p,group);}
    const ticket=++epoch;reconstruction=pendingReconstruction(previousReconstruction,next,oldProject);renderEpoch++;documentCache?.dispose();documentCache=null;clearPreview();leftCanvas.width=rightCanvas.width=1;renderedKey=leftRendered='';currentPage=0;pendingRestore={changes:rebound,baseline:previousReconstruction?previousBaseline:null};await start(next,ticket,{compile:false});
  }
  async function compileExplicit(){if(!session)return;if(pendingRestore){const restore=pendingRestore,own=epoch;if(reconstruction?.schema==='falsify.reconstruction-lineage.v1'&&restore.baseline?.pdfBytes){await start(project,own,{compile:false,initialArtifact:restore.baseline});}await session.compile();if(restore!==pendingRestore||own!==epoch)return;
      if(reconstruction?.schema==='falsify.reconstruction-pending.v1'){const baseline=session.getBaseline(),comparison=await reconstructionReader.compare({sourceFile:upload,bytes:baseline.pdfBytes});if(restore!==pendingRestore||own!==epoch)return;const metadata=JSON.parse(textFile(project,'falsify-reconstruction.json')),bindings=metadata.bindings.map(({bindingScope,...b})=>({...b,projectId:project.id}));reconstruction=createReconstructionLineage({project,artifact:baseline,comparison,bindings,decisions:metadata.decisions});}
      pendingRestore=null;session.setChanges(restore.changes);if(restore.changes.length)await session.compile();}else await session.compile();}
  function archiveState(){if(!project||!session)return null;const changes=pendingRestore?.changes||session.snapshot().changes,baseline=reconstruction?.schema==='falsify.reconstruction-pending.v1'?pendingRestore?.baseline:session.getBaseline()||pendingRestore?.baseline;return {project,changes,responses:{schema:'falsify.latex-responses.v1',projectId:project.id,batches:structuredClone(batches),proposals:structuredClone(proposals),changes:structuredClone(changes)},selection,unfinishedEdit:editor.getUnfinishedEdit(),baseline:baseline||null,reconstruction,layoutRun:layoutRunForSource(layoutAgent.getRunState(),project.id)};}
  async function encodeArchive(){const state=archiveState();if(!state)throw new Error('원본을 먼저 선택하세요.');if(upload)state.sourceUpload={name:upload.name,sha256:uploadHash,bytes:new Uint8Array(await upload.arrayBuffer())};return encodeSourceSession(state,{createLatexProject});}
  async function restoreArchive(json){const operation=++restoreTicket,startingEpoch=epoch,data=await decodeSourceSession(json,{createLatexProject});await validateRestoredChanges(data.project,data.changes);if(operation!==restoreTicket||startingEpoch!==epoch)throw new DOMException('취소했습니다.','AbortError');const nextModel=analyzeLatexSource(data.project);for(const v of [data.selection,data.unfinishedEdit])if(v?.nodeId&&!nextModel.nodes.some(n=>n.id===v.nodeId))throw new Error('저장된 선택 위치가 원본과 일치하지 않습니다.');const checkedReconstruction=validateRestoredReconstruction(data);const ticket=++epoch;layoutAgent.reset();reconstruction=checkedReconstruction;renderEpoch++;documentCache?.dispose();documentCache=null;clearPreview();session?.dispose();active=true;upload=data.sourceUpload?new File([data.sourceUpload.bytes],data.sourceUpload.name):null;uploadHash=data.sourceUpload?.sha256||data.responses?.batches?.[0]?.fileHash||data.project.id;selection=data.unfinishedEdit||data.selection;batches=data.responses?.batches||[];proposals=data.responses?.proposals||[];pendingRestore=data;importError=null;currentPage=0;leftCanvas.width=rightCanvas.width=1;leftOverlay.replaceChildren();rightOverlay.replaceChildren();pageLabel.textContent='PDF 만들기를 눌러 미리보기를 생성하세요.';renderedKey=leftRendered='';await start(data.project,ticket,{compile:false});if(ticket===epoch&&data.layoutRun)await layoutAgent.restoreRun(data.layoutRun);doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));}
  function chooseNode(id){const node=model.nodes.find(n=>n.id===id);if(!node||!editor.selectNode(id))return;selection={nodeId:id};editor.setState({selection});}
  function edit({nodeId,after,mode}){run(async()=>{if(pendingRestore)throw new Error('먼저 PDF 만들기를 눌러 원본을 준비하세요.');const node=model.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('원본을 다시 선택하세요.');const policy=mode==='raw-source'?{anchor:{projectId:project.id,nodeId:node.id,path:node.path,start:node.contentStart,end:node.contentEnd,kind:node.kind},afterSource:after,diagnostics:[]}:buildReferencePatch(project,node,{after,mode});if(policy.diagnostics.length)throw new Error(policy.diagnostics[0].message);const source=textFile(project,node.path);session.setChange({id:'manual-'+node.id,before:source.slice(policy.anchor.start,policy.anchor.end),after,afterSource:policy.afterSource,anchor:policy.anchor,kind:node.kind,mode,provenance:{origin:'human'}});});}
  function selectProposal(p,enabled){try{if(pendingRestore)throw new Error('먼저 PDF 만들기를 눌러 원본을 준비하세요.');session.setChanges(proposalTransaction(session.snapshot().changes,p,enabled,project.id));}catch(e){showError(e);}}
  function bindProposal(p){const node=model?.nodes.find(n=>n.id===selection?.nodeId);if(!node)throw new Error('먼저 원본에서 내용을 선택하세요.');if(!globalThis.confirm('선택한 원본 전체를 이 제안으로 바꾸시겠습니까?'))return;const anchor={projectId:project.id,nodeId:node.id,path:node.path,start:node.contentStart,end:node.contentEnd,kind:node.kind};p.status='matched';p.kind=node.kind;p.anchor=anchor;p.before=textFile(project,node.path).slice(anchor.start,anchor.end);p.sourceChanges=undefined;selectProposal(p,true);}
  let highlightTicket=0;const renderTasks=new Set(),textPages=new Map(),textLayers=new Map(),visibleText=[null,null];
  async function updateHighlights(){
    const ticket=++highlightTicket;leftOverlay.replaceChildren();rightOverlay.replaceChildren();highlightLabel.textContent='';
    if(!session||!project)return;const state=session.snapshot(),changes=state.changes.filter(c=>c.enabled!==false),baseline=state.baseline,current=state.artifact;
    if(!changes.length||!baseline)return;
    const edits=highlightEdits(state.changes,proposals,model),labels=[];
    for(const c of changes){const line=textFile(project,c.anchor.path).slice(0,c.anchor.start).split('\n').length;labels.push(`${c.anchor.path}:${line}`);}
    highlightLabel.textContent=`변경 원본 줄: ${[...new Set(labels)].join(' · ')}`;
    const marks=globalThis.FalsifyChangeMarks;if(!marks?.paintPage)return;
    for(const [i,artifact,overlay,frame] of [[0,baseline,leftOverlay,leftFrame],[1,current,rightOverlay,rightFrame]]){
      if(!artifact)continue;const view=visibleText[i];if(!view||view.key!==artifact.pdfHash+':'+currentPage)continue;
      const scale=frame.getBoundingClientRect().width/view.viewport.width;if(!(scale>0))continue;view.element.style.transform=`scale(${scale})`;
      const result=marks.paintPage({document:doc,container:frame,items:view.items,divs:view.divs,edits,side:i?'after':'before',separator:pdfItemSeparator});
      if(ticket!==highlightTicket){result.layer.remove();return;}overlay.append(result.layer);
    }
  }
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>void updateHighlights()):null;resizeObserver?.observe(leftFrame);resizeObserver?.observe(rightFrame);
  function clearPreview(){highlightTicket++;for(const task of renderTasks){try{task.cancel?.();}catch{}}renderTasks.clear();for(const view of textLayers.values())view.element.remove();textLayers.clear();textPages.clear();visibleText.fill(null);leftOverlay.replaceChildren();rightOverlay.replaceChildren();renderedKey=leftRendered='';leftCanvas.width=rightCanvas.width=1;}
  async function pdfLibrary(ticket){if(!pdfjs){pdfjs=await import('./vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs',base).href;}if(ticket!==renderEpoch)return null;documentCache??=globalThis.FalsifyPaperGeneration.createDocumentCache({maxEntries:3});return pdfjs;}
  let renderedKey='',leftRendered='';
  function previewPane(i,pdf,current,baseline){const canvas=i?rightCanvas:leftCanvas,a=i?current:baseline,key=a.pdfHash+':'+currentPage;if((i?renderedKey:leftRendered)===key||clearUnavailablePane(i,pdf,canvas))return null;return {canvas,key,frame:i?rightFrame:leftFrame};}
  function clearUnavailablePane(i,pdf,canvas){if(currentPage<pdf.numPages)return false;clearMissingPreviewPane({canvas,overlay:i?rightOverlay:leftOverlay,visibleText,index:i});if(i)renderedKey='';else leftRendered='';return true;}
  function previewSnapshot(){if(!active||!session)return null;const ticket=++renderEpoch,s=session.snapshot(),baseline=s.baseline,current=s.artifact||s.lastArtifact;if(!baseline||!current)return null;return {ticket,baseline,current};}
  function cachePreviewText(key,content){textPages.set(key,content);if(textPages.size>12)textPages.delete(textPages.keys().next().value);}
  function releasePreviewDocuments(cache,docs,current,baseline){for(const[i,pdf]of docs.entries())cache.release((i?current:baseline).pdfHash);}
  function markPaneRendered(i,key){if(i)renderedKey=key;else leftRendered=key;}
  function reportPreviewFailure(ticket,error){if(ticket===renderEpoch)showError(error);}
  async function render(){const input=previewSnapshot();if(!input)return;const {ticket,baseline,current}=input;const lib=await pdfLibrary(ticket);if(!lib)return;const cache=documentCache;let docs=[];try{for(const a of[baseline,current])docs.push(await cache.load(a.pdfHash,()=>lib.getDocument({data:a.pdfBytes.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href})));if(ticket!==renderEpoch)return;currentPage=Math.min(currentPage,Math.max(docs[0].numPages,docs[1].numPages)-1);pageLabel.textContent=`${currentPage+1} / ${Math.max(docs[0].numPages,docs[1].numPages)}쪽`;prev.disabled=currentPage===0;next.disabled=currentPage>=Math.max(docs[0].numPages,docs[1].numPages)-1;
      for(const[i,pdf]of docs.entries()){const pane=previewPane(i,pdf,current,baseline);if(!pane)continue;const {canvas,key,frame}=pane;const page=await pdf.getPage(currentPage+1);if(ticket!==renderEpoch)return;const viewport=page.getViewport({scale:1.2}),scratch=doc.createElement('canvas');scratch.width=Math.ceil(viewport.width);scratch.height=Math.ceil(viewport.height);const task=page.render({canvasContext:scratch.getContext('2d'),viewport});renderTasks.add(task);try{await task.promise;}finally{renderTasks.delete(task);}if(ticket!==renderEpoch)return;canvas.width=scratch.width;canvas.height=scratch.height;canvas.getContext('2d').drawImage(scratch,0,0);canvas.dataset.scale='1.2';
        let content=textPages.get(key);if(!content){content=await page.getTextContent();cachePreviewText(key,content);}if(ticket!==renderEpoch)return;
        visibleText[i]?.element.remove();const layerKey=i+':'+key;let view=textLayers.get(layerKey);
        if(!view){const textEl=el('div','','paper-text-layer textLayer latex-pdf-text-layer');textEl.style.width=viewport.width+'px';textEl.style.height=viewport.height+'px';textEl.style.setProperty('--total-scale-factor',String(viewport.scale));textEl.style.setProperty('--scale-round-x','1px');textEl.style.setProperty('--scale-round-y','1px');textEl.style.setProperty('--text-scale-factor','1');frame.append(textEl);const layer=new lib.TextLayer({textContentSource:content,container:textEl,viewport});renderTasks.add(layer);try{await layer.render();}finally{renderTasks.delete(layer);}if(ticket!==renderEpoch){textEl.remove();return;}view={key,element:textEl,items:content.items,divs:layer.textDivs,viewport};textLayers.set(layerKey,view);if(textLayers.size>12){const oldest=textLayers.keys().next().value;textLayers.get(oldest).element.remove();textLayers.delete(oldest);}}else frame.append(view.element);visibleText[i]=view;
        markPaneRendered(i,key);}
      void updateHighlights();
    }catch(e){reportPreviewFailure(ticket,e);}finally{releasePreviewDocuments(cache,docs,current,baseline);}}
  prev.onclick=()=>{currentPage=Math.max(0,currentPage-1);void render();};next.onclick=()=>{currentPage++;void render();};
  leftCanvas.addEventListener('click',e=>{const a=session?.getBaseline();if(!a?.synctex)return;const rect=leftCanvas.getBoundingClientRect(),point=pdfClickPoint(rect,leftCanvas,e.clientX,e.clientY),map=parseSynctex(a.synctex,{project}),hit={candidates:pickSourceLines(map,{pageIndex:currentPage,...point})};picker.replaceChildren();const unique=new Map();const first=hit.candidates.find(c=>sourceNodesAtLine(project,model,c.path,c.line).length);for(const c of first?[first]:[])for(const n of sourceNodesAtLine(project,model,c.path,c.line))unique.set(n.id,n);const nodes=[...unique.values()];if(nodes.length===1)chooseNode(nodes[0].id);else for(const n of nodes){const b=el('button',n.displayText||n.text);b.type='button';b.onclick=()=>chooseNode(n.id);picker.append(b);}if(!nodes.length)picker.append(el('span','원본 및 설정에서 수정할 내용을 선택하세요.'));});
  function deactivate(){layoutAgent.reset();reconstructionReader.cancel();reconstructionTicket++;restoreTicket++;epoch++;if(!active)return;reconstruction=null;renderEpoch++;session?.dispose();session=null;mainTicket++;documentCache?.dispose();documentCache=null;clearPreview();project=null;model=null;upload=null;uploadHash='';selection=null;latestState=null;batches=[];proposals=[];active=false;pendingRestore=null;host.hidden=true;pdfWorkspace.hidden=false;refreshDraftEntry();externalPosition();doc.dispatchEvent(new CustomEvent('falsify:latex-state'));}
  const onIntake=e=>{if(e.target!==intake)return;const file=intake.files?.[0];if(file&&/\.(tex|zip|json)$/i.test(file.name)){e.stopImmediatePropagation();void load(file);intake.value='';}else deactivate();};
  doc.addEventListener('change',onIntake,true);
  function resolveExternalEntries(safe,entries,batch){let result;if(Array.isArray(entries)){result={proposals:[],diagnostics:[]};for(let i=0;i<entries.length;i++){try{const one=Array.isArray(safe)?[entries[i]]:{...safe,changes:[entries[i]],items:undefined,proposals:undefined};const resolved=resolveSourceProposals(project,one,{model:{...model,locateSourceText}});for(const p of resolved.proposals){if(!entries[i].id)p.id='source-change-'+(i+1);p.provenance={...p.provenance,responseId:batch?.id,itemId:entries[i].id};result.proposals.push(p);}result.diagnostics.push(...resolved.diagnostics);}catch(e){result.proposals.push({id:'source-change-'+(i+1),before:entries[i].before,after:entries[i].after,status:'invalid',enabled:false});result.diagnostics.push({code:'invalid-proposal',message:e.message});}}}else result=resolveSourceProposals(project,safe,{model:{...model,locateSourceText}});return result;}
  const api={dispose(){deactivate();clearTimeout(draftTimer);clearTimeout(draftExpiry);draftVersion++;resizeObserver?.disconnect();draftStore.dispose();layoutAgent.dispose();doc.removeEventListener('change',onIntake,true);host.remove();draftEntry.remove();if(globalThis.FalsifyLatexWorkbench===api)delete globalThis.FalsifyLatexWorkbench;},get active(){return active;},load,loadReconstructed,getInputFile:()=>active?upload:null,getSource:()=>active&&project&&model&&session&&uploadHash?{file:upload,fileHash:uploadHash,sourceHash:project.id,segments:model?.documents.map(d=>({id:d.path,label:d.path,text:d.displayText})),externalSegments:model?.documents.map(d=>({id:d.path,label:d.path,text:d.displayText}))}:null,
    acceptExternalResponse(batch){if(!project||!session)throw new Error('원본을 먼저 선택하세요.');batches.push(structuredClone(batch));const safe=structuredClone(batch);const entries=Array.isArray(safe)?safe:safe?.changes||safe?.items||safe?.proposals;if(Array.isArray(entries))for(let i=0;i<entries.length;i++)if(!entries[i]||typeof entries[i]!=='object')entries[i]={};const result=resolveExternalEntries(safe,entries,batch);const prefix=crypto.randomUUID();for(const [i,p] of result.proposals.entries()){p.id=prefix+':'+i+':'+p.id;proposals.push(p);if(p.status==='matched'&&p.enabled!==false)selectProposal(p,true);}paint();return result;},
    getArchiveState:archiveState, getRecordSnapshot(){const state=archiveState();if(!state)return null;const segments=project.files.filter(f=>/\.(tex|bib|sty|cls)$/i.test(f.path)).map(f=>({id:f.path,label:`원본: ${f.path}`,pageIndex:0,text:dec.decode(f.bytes)}));return {segments,external:projectLegacyExternal({fileHash:uploadHash,project,responses:state.responses,segments}),sourceSession:{schema:'falsify.latex-session-sidecar.v1',projectId:project.id,changes:state.changes,responses:state.responses,selection:state.selection,...(state.reconstruction?{reconstruction:state.reconstruction}:{})}};},
    getExternalResponses:()=>({schema:'falsify.latex-responses.v1',projectId:project?.id,batches:structuredClone(batches),proposals:structuredClone(proposals),changes:pendingRestore?.changes||session?.snapshot().changes||[]}),
    getCurrentOutput(){const a=session?.getCurrentOutput();return a?{file:new File([a.pdfBytes],'paper.pdf',{type:'application/pdf'}),sha256:a.pdfHash,generationKey:a.key}:null;},getSession:()=>session,getLayoutAgentCandidate:()=>layoutAgent.getCandidate(),startLayoutReview:options=>layoutAgent.start(options)};
  globalThis.FalsifyLatexWorkbench=api;return api;
}
if(globalThis.document){const mount=()=>{mountLatexWorkbench();mountPdfLatexWorkbench();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}

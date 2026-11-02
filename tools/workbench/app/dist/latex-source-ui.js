/** Independent source editor. The host owns import, preview and persistence. */
export function createLatexSourceEditor({container, onEdit, onCompile, onDownload, onDownloadLast, onBlue, onExportSource, onImport, onUndo, onRedo, onSelect} = {}) {
  if (!container) throw new TypeError('container is required');
  const doc = container.ownerDocument;
  const el = (tag, attrs = {}, text = '') => { const n = doc.createElement(tag); for (const [k,v] of Object.entries(attrs)) { if (k === 'className') n.className = v; else n.setAttribute(k,v); } if (text) n.textContent = text; return n; };
  const section = el('section',{className:'latex-source-editor'});
  const title = el('h2',{},'LaTeX 편집');
  const importLabel = el('label',{className:'latex-source-import'},'원본 파일');
  const input = el('input',{type:'file',accept:'.tex,.zip,.json,application/zip,application/json'}); importLabel.append(input);
  const status = el('p',{className:'latex-source-status',role:'status'});
  const preview = el('div',{className:'latex-source-preview','aria-label':'PDF 미리보기'});
  const list = el('div',{className:'latex-source-nodes','aria-label':'원본 내용'});
  const editLabel = el('label',{},'선택한 내용 수정');
  const edit = el('textarea',{rows:'3'}); editLabel.append(edit);
  const modeLabel = el('label',{},'변경 방식');
  const mode = el('select'); mode.append(el('option',{value:'content'},'내용 변경'),el('option',{value:'display-override'},'표시 번호만 변경'),el('option',{value:'raw-source'},'LaTeX 원본 직접 변경')); modeLabel.append(mode);
  const apply = el('button',{type:'button',className:'button'},'변경 적용');
  const actions = el('div',{className:'latex-source-actions'});
  const undo = el('button',{type:'button',className:'button'},'실행 취소'), redo = el('button',{type:'button',className:'button'},'다시 실행'); undo.addEventListener('click',()=>onUndo?.()); redo.addEventListener('click',()=>onRedo?.()); actions.append(undo,redo);
  const buttons = [['PDF 만들기',onCompile],['PDF 다운로드',onDownload],['BLUE로 보내기',onBlue],['원본 내보내기',onExportSource]].map(([label,fn]) => {const b=el('button',{type:'button',className:'button'},label); b.addEventListener('click',()=>fn?.()); actions.append(b); return b;});
  const advanced = el('details'), advancedSummary=el('summary',{},'원본 및 설정'); advanced.append(advancedSummary, list);
  const lastDownload=el('button',{type:'button',className:'button'},'마지막 생성 PDF 다운로드');lastDownload.hidden=true;lastDownload.addEventListener('click',()=>onDownloadLast?.());advanced.append(lastDownload);
  section.append(title,importLabel,status,preview,editLabel,modeLabel,apply,actions,advanced); container.append(section);
  let state = {}, selected = null, editing = false, composing = false;
  function currentNode() { return state.model?.nodes?.find(n => n.id === selected); }
  function selectNode(id) { const node=state.model?.nodes?.find(n=>n.id===id); if (!node || (composing && selected!==id)) return false; const switched=selected!==id; if(switched)editing=false; selected=id; if (!editing && !composing && (switched || doc.activeElement!==edit)) { const change=(state.changes || []).findLast(c=>c.enabled !== false && c.anchor?.nodeId===id); edit.value=state.selection?.nodeId===id && state.selection.after != null ? state.selection.after : change?.after ?? (node.kind==='citation' ? node.text : node.displayText || node.text) ?? '';  mode.value=state.selection?.nodeId===id && state.selection.mode ? state.selection.mode : change?.mode || (node.kind==='math' ? 'raw-source' : 'content'); } updateSelection(); return true; }
  function updateSelection() { for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed',String(b.dataset.nodeId===selected)); apply.disabled=!!state.busy || !currentNode(); }
  function renderNodes() { list.replaceChildren(); for (const n of state.model?.nodes || []) { const b=el('button',{type:'button',className:'latex-source-node'},n.displayText || (n.kind==='citation' ? `${n.sourceText} (표시 미확인)` : n.text || n.sourceText) || ''); b.dataset.nodeId=n.id; b.addEventListener('click',()=>{if(selectNode(n.id))onSelect?.(n.id);}); list.append(b); } updateSelection(); }
  input.addEventListener('change',()=>{if(input.files?.[0]) onImport?.(input.files[0]); input.value='';});
  section.addEventListener('dragover',e=>{e.preventDefault();}); section.addEventListener('drop',e=>{e.preventDefault(); if(e.dataTransfer?.files?.[0]) onImport?.(e.dataTransfer.files[0]);});
  edit.addEventListener('input',()=>{editing=true;}); edit.addEventListener('blur',()=>{if(!composing)editing=false;}); edit.addEventListener('compositionstart',()=>{composing=true;}); edit.addEventListener('compositionend',()=>{composing=false; editing=true;});
  apply.addEventListener('click',()=>{if(currentNode() && !composing) {editing=false; onEdit?.({nodeId:selected,after:edit.value,mode:mode.value});}});
  function setState(next = {}) { const previousModel=state.model; state={...state,...next}; if (Object.hasOwn(next,'selection') && next.selection?.nodeId && next.selection.nodeId!==selected) {editing=false;selectNode(next.selection.nodeId);} if (previousModel!==state.model) {if (selected && !currentNode()) selected=null; renderNodes();} else updateSelection(); if(selected && !editing && !composing && doc.activeElement!==edit)selectNode(selected); const warnings=(state.artifact?.diagnostics||[]).filter(d=>d.severity==='warning').length;advancedSummary.textContent=`원본 및 설정${warnings?` · 경고 ${warnings}개`:''}`; lastDownload.hidden=!state.lastArtifact?.success || !!state.artifact;status.textContent=(state.diagnostics || []).map(d=>d.message).filter(Boolean).join(' ') || (state.busy?'처리 중…':state.project?'원본 준비됨':'LaTeX 파일을 선택하거나 놓으세요.'); undo.disabled=!!state.busy || !state.canUndo; redo.disabled=!!state.busy || !state.canRedo; for (const [i,b] of buttons.entries()) b.disabled=!!state.busy || (i===0 ? !state.project : i===3 ? !state.project : !state.artifact?.success); }
  setState({});
  return {setState, selectNode, getPreviewHost:()=>preview, getUnfinishedEdit:()=>selected ? {nodeId:selected,after:edit.value,mode:mode.value} : null, destroy:()=>section.remove()};
}

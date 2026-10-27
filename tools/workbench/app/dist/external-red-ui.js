/* External RED import panel. Mounts into the paper workspace when that host exists.
   Copies a prompt locally, parses a paste, and sends only explicitly checked unique matches.
   Origin is external-ai-import. This is not a verified run and does not call a model. */
(function(root){
  'use strict';
  const READY='falsify:paper-workspace-ready',SOURCE='falsify:paper-workspace-source',HOST_ID='paper-workspace',ORIGIN='external-ai-import';
  const FILE_NAME='falsify-external-red-prompt.txt';
  const booted=new WeakSet(),clears=new WeakMap();
  function parser(){return root.FalsifyExternalRed||null;}
  function workspace(){return root.FalsifyPaperWorkspace||null;}
  function el(doc,tag,className,text){
    const node=doc.createElement(tag);
    if(className)node.className=className;
    if(text!==undefined)node.textContent=text;
    return node;
  }
  function mount(doc){
    if(!doc||typeof doc.addEventListener!=='function')return null;
    if(!booted.has(doc)){
      booted.add(doc);
      doc.addEventListener(READY,()=>attach(doc));
      doc.addEventListener(SOURCE,()=>{const clear=clears.get(doc);if(clear)clear();});
    }
    attach(doc);
    return api;
  }
  function attach(doc){
    const host=typeof doc.getElementById==='function'?doc.getElementById(HOST_ID):null;
    if(!host||host.querySelector&&host.querySelector('#external-red'))return;
    const red=parser();
    const section=el(doc,'section','external-red');
    section.id='external-red';
    section.setAttribute('aria-label','외부 모델 응답 가져오기');
    section.append(el(doc,'h2',null,'외부 모델 응답 가져오기'));
    section.append(el(doc,'p','muted','프롬프트를 사용하는 AI에 전달하고 응답을 붙여넣으세요. 위치를 확인한 뒤 선택한 변경을 가져옵니다. 실행 출처는 외부 응답으로 기록됩니다.'));
    const modelLabel=el(doc,'label',null,'사용한 모델 이름 (선택)');
    const modelInput=el(doc,'input');
    modelInput.id='external-red-model';
    modelInput.type='text';
    modelInput.maxLength=red?red.LIMITS.modelLabel:120;
    modelInput.setAttribute('autocomplete','off');
    modelLabel.append(modelInput);
    const copyButton=el(doc,'button','button secondary','원문과 과제 프롬프트 복사');
    copyButton.id='external-red-copy';
    copyButton.type='button';
    const downloadButton=el(doc,'button','button secondary','프롬프트 TXT 내려받기');
    downloadButton.id='external-red-download';
    downloadButton.type='button';
    const actions=el(doc,'div','button-row');
    actions.append(copyButton,downloadButton);
    const copyStatus=el(doc,'p','external-red-status');
    copyStatus.id='external-red-copy-status';
    const pasteLabel=el(doc,'label',null,'붙여넣은 응답');
    const paste=el(doc,'textarea');
    paste.id='external-red-paste';
    paste.rows=8;
    pasteLabel.append(paste);
    const reviewButton=el(doc,'button','button secondary','변경 찾기');
    reviewButton.id='external-red-review';
    reviewButton.type='button';
    const diagnostics=el(doc,'div','external-red-diagnostics');
    diagnostics.id='external-red-diagnostics';
    const proposals=el(doc,'div','external-red-proposals');
    proposals.id='external-red-proposals';
    const acceptButton=el(doc,'button','button primary','선택한 변경 가져오기');
    acceptButton.id='external-red-accept';
    acceptButton.type='button';
    acceptButton.disabled=true;
    const acceptStatus=el(doc,'p','external-red-status');
    acceptStatus.id='external-red-accept-status';
    section.append(modelLabel,actions,copyStatus,pasteLabel,reviewButton,diagnostics,proposals,acceptButton,acceptStatus);
    host.append(section);
    let state=[],notes=[],mapped=null;
    function say(node,message,error){node.textContent=message||'';node.className='external-red-status'+(error?' error':'');}
    function sync(){acceptButton.disabled=!state.some(item=>item.status==='matched'&&item.checked);}
    function pageLabel(pageIndex){return Number.isInteger(pageIndex)&&pageIndex>=0?'PDF p.'+(pageIndex+1):'쪽 미정';}
    function copyMatch(match){
      const out={segmentId:match.segmentId,pageIndex:match.pageIndex,start:match.start,end:match.end};
      if(Number.isInteger(match.occurrence)&&match.occurrence>=0)out.occurrence=match.occurrence;
      return out;
    }
    function copyAnchor(anchor){
      if(!anchor)return null;
      const out={start:anchor.start,end:anchor.end};
      if(Number.isInteger(anchor.occurrence)&&anchor.occurrence>=0)out.occurrence=anchor.occurrence;
      return out;
    }
    function sourceText(segmentId){
      const source=currentSource();
      const segment=source&&Array.isArray(source.segments)?source.segments.find(part=>part&&part.id===segmentId):null;
      return segment&&typeof segment.text==='string'?segment.text:null;
    }
    function snippetFor(match){
      const text=sourceText(match.segmentId);
      if(text===null||!Number.isInteger(match.start)||!Number.isInteger(match.end)||match.end>text.length)return '';
      const pad=16,from=Math.max(0,match.start-pad),to=Math.min(text.length,match.end+pad);
      const show=value=>value.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
      return (from>0?'…':'')+show(text.slice(from,match.start))+'['+show(text.slice(match.start,match.end))+']'+show(text.slice(match.end,to))+(to<text.length?'…':'');
    }
    function render(){
      diagnostics.replaceChildren();
      for(const note of notes){
        const row=el(doc,'p','external-red-diagnostic',note.message);
        diagnostics.append(row);
        if(note.model)diagnostics.append(el(doc,'p','external-red-diagnostic','모델 표시: '+note.model));
      }
      proposals.replaceChildren();
      state.forEach((item,index)=>{
        const card=el(doc,'article','external-red-proposal');
        card.setAttribute('data-status',item.status);
        const label=item.status==='matched'?'한 곳':item.status==='ambiguous'?'여러 곳':'원문에 없음';
        card.append(el(doc,'h3',null,label+' · '+(item.segmentId||'문단 미정')+' · '+pageLabel(item.pageIndex)));
        card.append(el(doc,'p','external-red-before','Before: '+item.before));
        card.append(el(doc,'p','external-red-after','After: '+item.after));
        if(item.status==='matched'){
          const choice=el(doc,'label','check-row');
          const box=el(doc,'input');
          box.type='checkbox';
          box.checked=!!item.checked;
          box.addEventListener('change',()=>{item.checked=!!box.checked;sync();});
          choice.append(box,el(doc,'span',null,'이 변경을 가져오기'));
          card.append(choice);
        }else if(item.status==='ambiguous'&&item.listComplete&&item.matches.length){
          card.append(el(doc,'p',null,'위치를 하나 고르기 전에는 가져오지 않습니다.'));
          let selected=null;
          item.matches.forEach((match,matchIndex)=>{
            const choice=el(doc,'label','check-row');
            const radio=el(doc,'input');
            radio.type='radio';
            radio.name='external-red-match-'+index;
            radio.checked=false;
            radio.addEventListener('change',()=>{if(radio.checked)selected=matchIndex;});
            choice.append(radio,el(doc,'span',null,'위치 '+(matchIndex+1)+' · '+match.segmentId+' · '+pageLabel(match.pageIndex)));
            card.append(choice);
            const snippet=snippetFor(match);
            if(snippet)card.append(el(doc,'p','external-red-snippet',snippet));
          });
          const pick=el(doc,'button','button secondary','고른 위치로 확정');
          pick.type='button';
          pick.addEventListener('click',()=>{
            if(selected===null)return;
            const match=item.matches[selected];
            if(!match)return;
            const slice=sourceText(match.segmentId);
            const before=slice===null?null:slice.slice(match.start,match.end);
            if(before===null||before.length!==match.end-match.start||!before)return;
            item.status='matched';
            item.segmentId=match.segmentId;
            item.pageIndex=match.pageIndex;
            item.before=before;
            item.anchor=copyAnchor({start:match.start,end:match.end,occurrence:match.occurrence});
            item.matches=[copyMatch(match)];
            item.checked=false;
            item.listComplete=true;
            render();
          });
          card.append(pick);
        }else if(item.status==='ambiguous')card.append(el(doc,'p',null,'위치를 모두 표시할 수 없어 고르지 않았습니다. 더 긴 고유 인용을 사용하세요.'));
        else card.append(el(doc,'p',null,'원문에서 유일한 위치를 찾지 못해 보낼 수 없습니다.'));
        proposals.append(card);
      });
      sync();
    }
    function clearMapping(message){
      if(mapped===null&&!state.length)return;
      state=[];notes=[];mapped=null;render();
      say(acceptStatus,message||'원문이 바뀌어 이전 변경을 지웠습니다. 다시 찾아 보세요.',true);
    }
    clears.set(doc,()=>clearMapping());
    function currentSource(){
      const apiWorkspace=workspace();
      if(!apiWorkspace||typeof apiWorkspace.getSource!=='function')return null;
      return apiWorkspace.getSource()||null;
    }
    function promptText(){
      const source=currentSource();
      if(!source)throw new Error('원문이 없습니다.');
      const engine=parser();
      if(!engine)throw new Error('외부 응답 파서가 없습니다.');
      return engine.buildPrompt({segments:source.segments,fileHash:source.fileHash});
    }
    function download(text){
      const blob=new root.Blob([text],{type:'text/plain;charset=utf-8'});
      const url=root.URL.createObjectURL(blob);
      const link=el(doc,'a');
      link.href=url;
      link.download=FILE_NAME;
      link.rel='noopener';
      doc.body.append(link);
      link.click();
      link.remove();
      root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
    }
    async function copyPrompt(){
      let text;
      try{text=promptText();}catch(error){say(copyStatus,error&&error.message?error.message:'프롬프트를 만들지 못했습니다.',true);return;}
      try{
        const clipboard=root.navigator&&root.navigator.clipboard;
        if(!clipboard||typeof clipboard.writeText!=='function')throw new Error('no-clipboard');
        await clipboard.writeText(text);
        say(copyStatus,'프롬프트를 클립보드에 복사했습니다. 모델을 호출하지 않았습니다.');
      }catch{download(text);say(copyStatus,'클립보드 권한이 없어 프롬프트를 TXT로 내려받았습니다. 모델을 호출하지 않았습니다.');}
    }
    function downloadPrompt(){
      let text;
      try{text=promptText();}catch(error){say(copyStatus,error&&error.message?error.message:'프롬프트를 만들지 못했습니다.',true);return;}
      download(text);
      say(copyStatus,'프롬프트를 TXT로 내려받았습니다. 모델을 호출하지 않았습니다.');
    }
    function review(){
      const source=currentSource();
      if(!source){state=[];notes=[];mapped=null;render();say(acceptStatus,'원문이 없습니다.',true);return;}
      const engine=parser();
      if(!engine){say(acceptStatus,'외부 응답 파서가 없습니다.',true);return;}
      const parsed=engine.parse(paste.value,{segments:source.segments,fileHash:source.fileHash});
      mapped=source.fileHash;
      notes=parsed.diagnostics.map(note=>Object.assign({},note));
      state=parsed.proposals.map(item=>({
        segmentId:item.segmentId,pageIndex:item.pageIndex,before:item.before,after:item.after,
        anchor:copyAnchor(item.anchor),
        origin:ORIGIN,status:item.status,listComplete:item.listComplete!==false,checked:false,
        matches:item.matches.map(copyMatch)
      }));
      render();
      if(!state.length){
        acceptButton.disabled=true;
        acceptStatus.setAttribute('data-state','no-changes');
        say(acceptStatus,'변경 0건입니다. 변경이 없어 적용하지 않습니다.',true);
        return;
      }
      acceptStatus.setAttribute('data-state','ready');
      say(acceptStatus,'변경을 찾았습니다. 검증된 실행이 아니며 아직 가져오지 않았습니다.');
    }
    async function accept(){
      if(acceptButton.disabled)return;
      const chosen=state.filter(item=>item.status==='matched'&&item.checked);
      if(!chosen.length)return;
      const overlap=(left,right)=>left.matches.some(match=>right.matches.some(other=>match.segmentId===other.segmentId&&match.start<other.end&&other.start<match.end));
      if(chosen.some((item,index)=>chosen.slice(index+1).some(other=>overlap(item,other)))){say(acceptStatus,'겹치는 변경은 함께 가져오지 않습니다. 하나만 고르세요.',true);return;}
      const apiWorkspace=workspace();
      if(!apiWorkspace||typeof apiWorkspace.acceptProposals!=='function'){say(acceptStatus,'편집 화면이 없어 가져오지 못했습니다.',true);return;}
      const source=currentSource();
      if(!source||source.fileHash!==mapped){clearMapping();return;}
      const payload=chosen.map(item=>({
        segmentId:item.segmentId,pageIndex:item.pageIndex,before:item.before,after:item.after,
        anchor:copyAnchor(item.anchor),
        origin:ORIGIN,status:'matched',
        matches:item.matches.map(copyMatch)
      }));
      const model=modelInput.value.trim().slice(0,modelInput.maxLength||120);
      const options={origin:ORIGIN,confirmed:true};
      if(model)options.model=model;
      const token=mapped;
      try{
        await Promise.resolve().then(()=>apiWorkspace.acceptProposals(payload,options));
        if(mapped!==token){clearMapping();return;}
        say(acceptStatus,'선택한 변경을 작업대로 보냈습니다. 편집 목록에서 확인하세요.');
      }catch{say(acceptStatus,'편집 화면이 받지 못해 가져오지 못했습니다. 적용하지 않았습니다.',true);}
    }
    copyButton.addEventListener('click',()=>{if(!copyButton.disabled)void copyPrompt();});
    downloadButton.addEventListener('click',()=>{if(!downloadButton.disabled)downloadPrompt();});
    reviewButton.addEventListener('click',()=>{if(!reviewButton.disabled)review();});
    acceptButton.addEventListener('click',()=>{if(!acceptButton.disabled)void accept();});
    render();
  }
  const api={mount,ORIGIN};
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.FalsifyExternalRedUI=api;
  if(root.document&&typeof root.document.getElementById==='function')api.mount(root.document);
})(typeof globalThis==='object'?globalThis:this);

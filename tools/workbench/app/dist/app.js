/* Hash navigation, wayfinding sign and browser-local RED file intake. Model actions live in role modules. */
(function(){
  'use strict';
  const $=selector=>document.querySelector(selector);
  const views={workbench:'논문 실험 / RED',blue:'논문 실험 / BLUE',review:'검수',results:'결과 기록',agents:'Harness'};
  const routes={workbench:'red',blue:'blue',review:'review',results:'results',agents:'harness'};
  const fromHash=hash=>Object.keys(routes).find(key=>'#'+routes[key]===hash)||null;
  let view=fromHash(location.hash)||'workbench',documentProgress=null,flapTimer;
  let importEpoch=0,importController=null,importedDocument=null,importedFile=null;

  function focusTarget(element){if(!element)return;element.scrollIntoView({block:'center'});element.focus({preventScroll:true});}
  function navigate(next,push=true){
    if(!Object.hasOwn(views,next))return;
    const changed=next!==view;view=next;
    if(push&&location.hash!=='#'+routes[next])history.pushState({view:next},'','#'+routes[next]);
    render();
    if(changed){scrollTo(0,0);$('#main').focus({preventScroll:true});}
  }
  function followLocation(){const next=fromHash(location.hash);if(next&&next!==view)navigate(next,false);}
  function signSpec(){
    if(view==='review')return {gate:'H1',title:'실행 결과를 사람이 평가하세요',detail:'기록된 RED / BLUE 실행을 골라 판정과 근거를 남깁니다.',label:'평가할 실행 선택',action:()=>focusTarget($('#evaluation-run'))};
    if(view==='results')return {gate:'A1',title:'기록을 저장하고 비교하세요',detail:'내 브라우저 기록과, 직접 공유한 공동 기록을 구분합니다.',label:'공유 기록으로 이동',action:()=>($('#cloud-records')||$('#ledger-board'))?.scrollIntoView({block:'start'})};
    if(view==='agents')return {gate:'C1',title:'Harness를 등록하고 관리하세요',detail:'기본 지침, 로컬 코드, 외부 HTTPS 서버를 같은 입출력 계약으로 등록합니다.',label:'Harness JSON 편집',action:()=>focusTarget($('#harness-editor'))};
    if(view==='blue')return {gate:'B1',title:'BLUE 검토 파일을 입력하세요',detail:'RED와 독립 실행합니다. 검토할 파일을 직접 고르세요.',label:'BLUE 파일 입력',action:()=>focusTarget($('#doc-blue-file'))};
    if(documentProgress){
      const p=documentProgress,detail=p.name+' · '+p.count+'개 후보'+(p.count?' · '+(p.selected||0)+'개 선택':'');
      if(p.busy)return {gate:'R1',title:'RED 검토 중입니다',detail,label:'진행 상태 보기',action:()=>$('#red-progress').scrollIntoView({block:'center'})};
      if(p.count)return {gate:'R1',title:'후보를 선택하고 편집하세요',detail,label:'후보로 이동',action:()=>focusTarget($('#red-candidates input')||$('#red-result-step'))};
      return {gate:'R1',title:'RED 실행 설정을 확인하세요',detail,label:'실행 설정으로',action:()=>focusTarget($('#document-red'))};
    }
    return {gate:'R1',title:'논문 파일을 입력하세요',detail:'RED는 입력 파일에서 근거 있는 해석 왜곡 후보를 준비합니다.',label:'RED 파일 입력',action:()=>focusTarget($('#paper-file'))};
  }
  function animateSign(previous,next){
    const message=$('.sign-message');clearTimeout(flapTimer);
    message.querySelectorAll('.flap-leaf').forEach(e=>e.remove());message.classList.remove('flipping');
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    for(const [kind,copy] of [['flap-old-bottom',previous],['flap-outgoing',previous],['flap-incoming',next]]){
      const panel=document.createElement('div');panel.className='flap-leaf '+kind;panel.setAttribute('aria-hidden','true');
      const heading=document.createElement('h1');heading.textContent=copy.title;
      const detail=document.createElement('p');detail.textContent=copy.detail;panel.append(heading,detail);message.append(panel);
    }
    void message.offsetWidth;message.classList.add('flipping');
    flapTimer=setTimeout(()=>{message.querySelectorAll('.flap-leaf').forEach(e=>e.remove());message.classList.remove('flipping');},300);
  }
  function render(){
    document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!=='view-'+view);
    document.querySelectorAll('.rail [data-view]').forEach(e=>{if(e.dataset.view===view)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});
    $('.paper-nav-group').dataset.current=String(view==='workbench'||view==='blue');
    $('#location-name').textContent=views[view];$('#paper-name').textContent=view==='workbench'&&documentProgress?documentProgress.name:'Falsify';
    const spec=signSpec(),previous={title:$('#sign-title').textContent,detail:$('#sign-detail').textContent};
    $('#gate-code').textContent=spec.gate;$('#sign-title').textContent=spec.title;$('#sign-detail').textContent=spec.detail;$('#sign-action-label').textContent=spec.label;
    if(previous.title!==spec.title)animateSign(previous,spec);
  }
  function cancelImport(keepFile=false){
    importEpoch++;importController?.abort();importController=null;
    $('#import-cancel').hidden=true;if(!keepFile){$('#paper-file').value='';importedFile=null;}
  }
  // Role modules may hold unsaved work; preventDefault on this event keeps the current source.
  function confirmDocumentChange(reason){
    if(!importedDocument&&!importController)return true;
    return document.dispatchEvent(new CustomEvent('falsify:before-document-change',{cancelable:true,detail:{role:'red',reason}}));
  }
  function restoreChooser(){
    const input=$('#paper-file');
    try{if(!importedFile)throw new Error('no file');const transfer=new DataTransfer();transfer.items.add(importedFile);input.files=transfer.files;}
    catch{input.value='';}
  }
  function clearImport(keepFile=false){
    cancelImport(keepFile===true);importedDocument=null;$('#import-preview').hidden=true;$('#import-text').value='';$('#import-segment').replaceChildren();$('#import-status').textContent='';
    document.dispatchEvent(new Event('falsify:document-clear'));
  }
  function showSegment(){
    if(!importedDocument)return;const selected=$('#import-segment').value;
    $('#import-text').value=selected==='all'?importedDocument.text:importedDocument.segments[Number(selected)].text;
  }
  function showImport(result){
    importedDocument=result;$('#import-preview').hidden=false;
    $('#import-summary').textContent=result.name+' · '+result.format+' · '+result.text.length.toLocaleString()+'자 · '+result.segments.length+'개 페이지/문단 · 추출 정확성 미검증';
    $('#import-warning').textContent=result.warnings.join(' ');
    const select=$('#import-segment');select.replaceChildren(new Option('전체 추출 텍스트','all'));
    result.segments.forEach((s,i)=>select.add(new Option(s.label+' · '+s.text.slice(0,60),String(i))));
    select.value=result.format==='PDF'?'0':'all';showSegment();
  }
  $('#paper-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file){if(importedFile)restoreChooser();return;}
    if(!confirmDocumentChange('replace')){restoreChooser();return;}
    clearImport(true);importedFile=file;const epoch=importEpoch;importController=new AbortController();$('#import-cancel').hidden=false;$('#import-status').classList.remove('error');
    try{
      const result=await FalsifyImport.extract(file,{signal:importController.signal,onProgress:message=>{if(epoch===importEpoch)$('#import-status').textContent=message;}});
      if(epoch!==importEpoch)return;showImport(result);
      document.dispatchEvent(new CustomEvent('falsify:document',{detail:{file,result}}));
      $('#import-status').textContent='추출 완료. 2단계에서 전체 텍스트로 RED를 실행합니다.';
    }catch(error){if(epoch===importEpoch){$('#paper-file').value='';importedFile=null;$('#import-status').classList.add('error');$('#import-status').textContent='파일 입력 실패: '+error.message+' 다른 파일을 선택하세요.';}}
    finally{if(epoch===importEpoch){importController=null;$('#import-cancel').hidden=true;}}
  });
  $('#import-cancel').addEventListener('click',()=>{cancelImport();$('#import-status').textContent='추출을 취소했습니다. 파일을 다시 선택하세요.';});
  $('#import-clear').addEventListener('click',()=>{if(confirmDocumentChange('clear'))clearImport();});
  $('#import-segment').addEventListener('change',showSegment);
  document.addEventListener('falsify:document-state',event=>{documentProgress=event.detail;render();});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.view)navigate(button.dataset.view);
  });
  addEventListener('popstate',followLocation);
  addEventListener('hashchange',followLocation);
  $('#sign-action').addEventListener('click',()=>signSpec().action());
  $('#reset').addEventListener('click',()=>$('#reset-dialog').showModal());
  $('#reset-dialog').addEventListener('close',event=>{
    if(event.target.returnValue!=='reset')return;
    clearImport();document.dispatchEvent(new Event('falsify:workspace-reset'));
  });
  $('.brand').addEventListener('click',event=>{event.preventDefault();navigate('workbench');});
  $('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#main').focus();});
  if(!fromHash(location.hash))history.replaceState({view},'','#'+routes[view]);
  render();
})();

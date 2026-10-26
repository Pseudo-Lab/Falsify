/* Airport work surfaces composed from the existing role engines, native controls,
   GoogleChromeLabs file-drop and pinned Lucide SVGs. No model or storage transport. */
(function(){
  'use strict';
  const $=s=>document.querySelector(s),NS='http://www.w3.org/2000/svg';
  function icon(name){const svg=document.createElementNS(NS,'svg'),use=document.createElementNS(NS,'use');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');use.setAttribute('href','./vendor/lucide.svg#'+name);svg.append(use);return svg;}
  function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;}
  function button(name,label,action,cls='button secondary'){const b=el('button',cls);b.type='button';b.append(icon(name),el('span','',label));b.addEventListener('click',action);return b;}
  function disclosure(summary,nodes){const d=el('details','visual-details'),s=el('summary','',summary);d.append(s,...nodes);return d;}
  function decorate(node,name){if(!node)return;const paint=()=>{if(!node.querySelector('svg'))node.prepend(icon(name));};paint();new MutationObserver(paint).observe(node,{childList:true});}
  function choose(role,hash){const s=$('#'+role+'-harness');if(!s||s.disabled)return false;if(![...s.options].some(o=>o.value===hash))return false;if(s.value!==hash){s.value=hash;s.dispatchEvent(new Event('change',{bubbles:true}));}return true;}
  globalThis.FalsifyVisual={icon,choose};

  const ready=(async()=>{
    if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
    await globalThis.FalsifyLab?.ready;
    const state={red:{},blue:{}},steps={};

    // Keep the actual file inputs and their existing listeners. The upstream
    // component supplies drag/paste handling, the browser supplies file picking.
    function intake(id,role){
      const input=$(id),label=input?.closest('label');if(!input||!label)return;
      const drop=document.createElement('file-drop');drop.className='visual-drop';drop.setAttribute('multiple','');
      label.before(drop);drop.append(label);label.classList.add('visual-file-label');
      const portrait=el('span','visual-paper');portrait.append(icon('file-up'));
      const title=el('strong','visual-file-title','논문 놓기'),meta=el('span','visual-file-meta','PDF · Word · 텍스트'),copy=el('span','visual-file-copy');copy.append(title,meta);
      label.replaceChildren(portrait,copy,input);input.classList.add('visual-file-input');
      const error=el('p','form-feedback error');error.setAttribute('role','alert');drop.after(error);
      let epoch=0,task=null,timer=0;
      function clearPreview(){epoch++;clearTimeout(timer);const old=task;task=null;old?.destroy().catch(()=>{});portrait.replaceChildren(icon('file-up'));}
      async function thumbnail(file){
        clearPreview();const current=epoch;
        if(!file||!file.name.toLowerCase().endsWith('.pdf')||!globalThis.FalsifyPreview)return;
        try{
          const bytes=new Uint8Array(await file.arrayBuffer());if(current!==epoch)return;
          const pdf=await FalsifyPreview.defaultImport();if(current!==epoch)return;
          pdf.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',document.baseURI).href;
          const loading=pdf.getDocument(FalsifyPreview.pdfParams(bytes,document.baseURI));task=loading;
          timer=setTimeout(()=>{if(current===epoch){loading.destroy().catch(()=>{});task=null;}},10000);
          const doc=await loading.promise;if(current!==epoch)return;
          const page=await doc.getPage(1),scale=FalsifyPreview.fitScale(page.getViewport({scale:1}),88,1),viewport=page.getViewport({scale});
          const canvas=el('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
          if(current===epoch){canvas.setAttribute('role','img');canvas.setAttribute('aria-label','입력 논문 첫 쪽');portrait.replaceChildren(canvas);}
          page.cleanup();clearTimeout(timer);await loading.destroy();if(task===loading)task=null;
        }catch{if(current===epoch)portrait.replaceChildren(icon('file-text'));} // Picking and extraction remain usable if thumbnail rendering fails.
      }
      let shown=null;
      function sync(){const file=input.files?.[0]||null;if(file===shown)return;shown=file;drop.classList.toggle('has-file',!!file);title.textContent=file?file.name:'논문 놓기';meta.textContent=file?(file.size/1024/1024).toFixed(1)+' MB · 다른 파일로 바꾸기':'PDF · Word · 텍스트';error.textContent='';void thumbnail(file);}
      drop.addEventListener('filedrop',event=>{
        const files=event.files||[];if(!files.length)return;
        if(files.length!==1){error.textContent='논문 한 개만 놓아주세요.';return;}
        const file=files[0],ext='.'+file.name.split('.').pop().toLowerCase(),accepted=input.accept.split(',').map(s=>s.trim());
        if(!accepted.includes(ext)||file.size>25*1024*1024||!file.size){error.textContent='25 MB 이하의 PDF·Word·텍스트 파일을 골라주세요.';return;}
        try{const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));sync();}
        catch{error.textContent='파일을 눌러서 선택해주세요.';}
      });
      input.addEventListener('change',sync);
      document.addEventListener('falsify:workspace-reset',()=>{shown=null;sync();clearPreview();});
      document.addEventListener(role==='red'?'falsify:document-clear':'falsify:blue-state',()=>{sync();});
      // Read-only follow-up of extraction errors and declined replacement.
      const status=$(role==='red'?'#import-status':'#doc-blue-summary');if(status)new MutationObserver(sync).observe(status,{childList:true,subtree:true});
      sync();
    }
    intake('#paper-file','red');intake('#doc-blue-file','blue');

    // Fold extracted text, never the real result or editing controls.
    const preview=$('#import-preview');if(preview){const d=disclosure('논문 내용 보기',[]);d.classList.add('visual-extraction');preview.before(d);d.append(preview);d.hidden=preview.hidden;new MutationObserver(()=>{d.hidden=preview.hidden;}).observe(preview,{attributes:true,attributeFilter:['hidden']});}
    for(const [role,root] of [['red',$('#view-workbench')],['blue',$('#document-blue')]]){
      const items=[...root.querySelectorAll(':scope > .role-step')];steps[role]=items;
      for(const [i,section] of items.entries()){
        section.classList.add('visual-step');const code=section.querySelector('.step-code');if(code)code.replaceChildren(icon(['file-up','play',role==='red'?'pencil':'search'][i]));
        section.querySelector('.step-head h2')?.replaceChildren(document.createTextNode(['논문','실행','결과'][i]));
      }
      const execute=items[1];if(execute){
        const incoming=el('div','visual-route');incoming.setAttribute('aria-hidden','true');incoming.append(icon('file-text'),icon('arrow-right'),icon(role==='red'?'pencil':'search'),icon('arrow-right'),icon('play'));execute.prepend(incoming);
      }
      const start=$(role==='red'?'#red-start':'#doc-blue-start');if(start){start.replaceChildren(icon('play'),el('span','','실행'));start.classList.add('visual-run');}
      const runNote=el('p','visual-next');runNote.setAttribute('role','status');start?.closest('.button-row')?.after(runNote);
      state[role].note=runNote;
      const consent=$(role==='red'?'#red-consent':'#doc-blue-consent');const span=consent?.closest('label')?.querySelector('span');
      if(span){const old=span.textContent;span.textContent='선택한 도구에 논문을 보내 실행';span.title=old;}
      const selection=$('#'+role+'-harness')?.closest('.harness-selection');
      if(selection){
        const native=$('#'+role+'-harness'),trigger=button(role==='red'?'pencil':'search','',()=>{shelf.open=!shelf.open;trigger.setAttribute('aria-expanded',String(shelf.open));},'visual-tool');
        trigger.setAttribute('aria-label',role.toUpperCase()+' 도구 바꾸기');trigger.setAttribute('aria-expanded','false');
        trigger.append(icon('chevron-down'));
        const shelf=disclosure('다른 도구',[]),choices=el('div','visual-tool-list');shelf.classList.add('visual-shelf');shelf.append(choices);
        const nodes=[...selection.children],external=$('#'+role+'-harness-consent')?.closest('label');
        const advanced=disclosure('실행기 · 모델 · 세부 설정',nodes.filter(n=>n!==external));selection.prepend(trigger,shelf,advanced);
        function paint(){const option=native.selectedOptions[0];trigger.querySelector('span').textContent=option?option.textContent.replace(/ · [a-f0-9]{8}$/,''):'도구 준비 중';trigger.disabled=native.disabled;
          for(const b of document.querySelectorAll('.visual-library-use[data-role="'+role+'"]'))b.disabled=native.disabled;
          choices.replaceChildren(...[...native.options].map(o=>{const b=button(role==='red'?'pencil':'search',o.textContent.replace(/ · [a-f0-9]{8}$/,''),()=>{if(choose(role,o.value)){shelf.open=false;trigger.setAttribute('aria-expanded','false');paint();}},'visual-tool-choice');b.setAttribute('aria-pressed',String(native.value===o.value));b.disabled=native.disabled;return b;}));}
        shelf.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(shelf.open)));
        native.addEventListener('change',paint);new MutationObserver(paint).observe(native,{childList:true,attributes:true,attributeFilter:['disabled'],subtree:true});paint();
      }
    }
    function manualSign(){
      const title=$('#sign-title');
      if(!title||title.textContent!=='RED 실행 설정을 확인하세요')return;
      title.textContent='원본에서 직접 고치세요';
      const detail=$('#sign-detail');if(detail)detail.textContent='쪽을 보고 글자를 고칩니다. AI 실행과 외부 제안은 선택입니다.';
      const label=$('#sign-action-label');if(label)label.textContent='원본 편집으로';
    }
    function render(role,detail){
      const s=state[role];if(detail!==undefined)Object.assign(s,detail||{name:'',busy:false,hasResult:false});
      const sections=steps[role];if(!sections?.length)return;
      const hasFile=!!s.name,hasResult=!!s.hasResult;
      // Empty future steps stay as small destinations; no forced RED -> BLUE sequence.
      sections[1]?.classList.toggle('visual-waiting',!hasFile);sections[2]?.classList.toggle('visual-waiting',!hasResult&&!s.busy);
      sections[0]?.classList.toggle('visual-done',hasFile);sections[1]?.classList.toggle('visual-current',hasFile&&!hasResult);sections[2]?.classList.toggle('visual-current',hasResult);
      const start=$(role==='red'?'#red-start':'#doc-blue-start'),connected=FalsifyLocalBridge?.state()?.connected;
      let note='';
      if(s.busy)note='검토 중';
      else if(!hasFile)note='먼저 논문을 놓아주세요.';
      else if(role==='red'&&!hasResult)note='원본 쪽에서 직접 고칠 수 있습니다. AI 실행은 선택입니다.';
      else if(!connected)note='내 PC를 연결하면 실행할 수 있습니다.';
      else if(start?.disabled)note='실행 동의와 도구 설정을 확인해주세요.';
      if(s.note&&s.note.textContent!==note)s.note.textContent=note;
      manualSign();
    }
    document.addEventListener('falsify:document-state',e=>render('red',e.detail));
    document.addEventListener('falsify:blue-state',e=>render('blue',e.detail));
    document.addEventListener('falsify:local-bridge',()=>{render('red');render('blue');});
    for(const role of ['red','blue']){const start=$(role==='red'?'#red-start':'#doc-blue-start');if(start)new MutationObserver(()=>render(role)).observe(start,{attributes:true,attributeFilter:['disabled']});render(role);}
    manualSign();
    const signTitle=$('#sign-title');
    if(signTitle)new MutationObserver(()=>manualSign()).observe(signTitle,{childList:true,characterData:true,subtree:true});
    const signAction=$('#sign-action');
    if(signAction)signAction.addEventListener('click',event=>{
      if($('#sign-title')?.textContent!=='원본에서 직접 고치세요')return;
      event.stopImmediatePropagation();
      const target=$('#paper-before-stage')||$('#paper-workspace');
      if(!target)return;
      if(typeof target.scrollIntoView==='function')target.scrollIntoView({block:'center'});
      if(typeof target.focus==='function')target.focus({preventScroll:true});
    },true);

    // The PC connection is a compact appliance, with the unchanged setup available on demand.
    const bridge=$('#local-bridge');if(bridge){
      const pair=$('#bridge-pair'),head=bridge.querySelector('.step-head'),disclosure=el('details','visual-connection-details'),summary=el('summary');summary.append(icon('plug'),el('strong','','내 PC'),el('span','visual-pc-state'));
      const host=el('div','visual-connection-body');host.append(head,pair);disclosure.append(summary,host);bridge.append(disclosure);bridge.classList.add('visual-connection');
      function connection(){const s=FalsifyLocalBridge.state(),label=summary.querySelector('span');label.textContent=s.connected?'연결됨':'연결하기';summary.classList.toggle('connected',s.connected);if(s.connected)disclosure.open=false;}
      document.addEventListener('falsify:local-bridge',connection);connection();
      const instructions=pair.querySelector('.bridge-steps');if(instructions){const d=el('details','visual-details');d.append(el('summary','','처음 연결하는 PC'),instructions);pair.prepend(d);}
    }
    for(const [id,name] of [['red-download','download'],['doc-blue-record','check'],['red-record','check'],['evaluation-save','check'],['bridge-launch','plug'],['bridge-connect','plug'],['harness-register','plus'],['harness-download','download']])decorate($('#'+id),name);

    // Library first, code authoring on demand. Existing inputs/listeners stay intact.
    const manager=$('#harness-manager');if(manager){
      const library=$('#harness-library'),imported=$('#harness-preview'),feedback=$('#harness-status'),heading=el('h3','','내 도구'),author=disclosure('새 도구 만들기 · 파일 가져오기',[]);author.id='visual-harness-author';
      const introduction=manager.querySelector('p');if(introduction)introduction.hidden=true;
      const keep=new Set([manager.querySelector('h2'),introduction,library,imported,feedback]);
      for(const n of [...manager.children])if(!keep.has(n)&&!n.matches('.confluence-store'))author.append(n);
      manager.append(imported,feedback,heading,library,author);
      function libraryActions(){for(const a of library.children){if(a.dataset.visualReady)continue;a.dataset.visualReady='true';
        const hash=a.querySelector('code')?.textContent,match=a.querySelector('h4')?.textContent.match(/ · (RED|BLUE) · /),role=match?.[1].toLowerCase();if(!role||!hash)continue;
        const paragraphs=[...a.querySelectorAll(':scope > p')];if(paragraphs[1]){const more=disclosure('지침 보기',[paragraphs[1]]);a.append(more);}
        const actions=el('div','button-row'),use=button(role==='red'?'pencil':'search','사용',()=>{if(choose(role,hash))document.querySelector('[data-view="'+(role==='red'?'workbench':'blue')+'"]').click();});use.classList.add('visual-library-use');use.dataset.role=role;use.disabled=$('#'+role+'-harness').disabled;use.setAttribute('aria-label',a.querySelector('h4').textContent+' 사용');actions.append(use,button('users','팀에 저장',async()=>{const cloud=await globalThis.FalsifyConfluenceStore?.ready;await cloud?.requestHarnessShare?.(hash);}));a.prepend(icon(role==='red'?'pencil':'search'));a.append(actions);
        a.querySelector('.text-button')?.addEventListener('click',()=>{author.open=true;$('#harness-editor').focus();});
      }}
      libraryActions();new MutationObserver(libraryActions).observe(library,{childList:true});
      function previewAction(){if(imported.hidden||imported.querySelector('[data-visual-register]'))return;const b=button('plus','내 도구에 추가',()=>$('#harness-register').click());b.dataset.visualRegister='true';imported.append(b);}
      new MutationObserver(previewAction).observe(imported,{childList:true,attributes:true,attributeFilter:['hidden']});previewAction();
    }
    const architecture=$('.connection-plan');if(architecture){const d=disclosure('실행 구조 · 고급 안내',[]);architecture.before(d);d.append(architecture);}
    // Symbolic human judgments delegate to the existing selects/validators. No
    // decision, reason, score or approval is inferred by this presentation layer.
    function verdictButtons(select){
      if(select.dataset.visualVerdict)return;select.dataset.visualVerdict='true';
      // Buttons must not live inside a label: the label's default activation
      // can forward a click to another labelable descendant and change verdict.
      const wrapping=select.closest('label');if(wrapping){const field=el('div','visual-verdict-field'),caption=el('span','visual-field-label','판정');wrapping.before(field);field.append(caption,select);wrapping.remove();}
      const label=document.querySelector('label[for="'+select.id+'"]'),group=el('div','visual-verdicts');group.setAttribute('role','group');group.setAttribute('aria-label',label?.textContent||'사람 판정');
      const names={supported:['check','맞음'],unsupported:['x','아님'],mixed:['check-check','일부'],uncertain:['circle-question-mark','모름'],detected:['check','찾음'],missed:['x','놓침'],pending:['refresh-cw','미판정']};
      for(const option of select.options){const pair=names[option.value];if(!pair)continue;const b=button(pair[0],pair[1],()=>{if(select.disabled)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));paint();},'visual-verdict');b.title=option.textContent;b.setAttribute('aria-label',option.textContent);b.dataset.value=option.value;group.append(b);}
      function paint(){for(const b of group.children){b.disabled=select.disabled;b.setAttribute('aria-pressed',String(b.dataset.value===select.value));}}
      select.hidden=true;select.after(group);select.addEventListener('change',paint);new MutationObserver(paint).observe(select,{attributes:true,attributeFilter:['disabled']});paint();
    }
    const reviewOutput=$('#evaluation-output');const decorateReview=()=>{for(const s of reviewOutput.querySelectorAll('select'))verdictButtons(s);};
    if(reviewOutput){new MutationObserver(decorateReview).observe(reviewOutput,{childList:true,subtree:true});decorateReview();}
    verdictButtons($('#evaluation-verdict'));
    const conditions=$('#evaluation-case').closest('label'),score=$('#evaluation-score').closest('label'),reviewDetails=disclosure('사례 이름 · 점수 (선택)',[]);
    $('#evaluation-form').insertBefore(reviewDetails,$('#evaluation-note').closest('label'));reviewDetails.append(conditions,score);
    function reviewVisibility(){const run=$('#evaluation-run'),has=!!run.value;$('#evaluation-form').hidden=!has;$('#evaluation-history').hidden=!has;const title=$('#evaluation-history').previousElementSibling;if(title?.tagName==='H3')title.hidden=!has;run.closest('label').hidden=![...run.options].some(o=>o.value);}
    $('#evaluation-run').addEventListener('change',reviewVisibility);new MutationObserver(reviewVisibility).observe($('#evaluation-run'),{childList:true});reviewVisibility();
    // Surface team actions beside the selected review, not below a long review form.
    const cloud=await globalThis.FalsifyConfluenceStore?.ready;
    const reviewPanel=$('#confluence-panel-review');if(reviewPanel)$('#evaluation-run').closest('label').after(reviewPanel);
    const harnessPanel=$('#confluence-panel-harness');if(harnessPanel&&manager)manager.querySelector('h2').after(harnessPanel);
    const aiSummary=document.querySelector('#red-ai-optional > summary');if(aiSummary&&!aiSummary.querySelector('svg'))aiSummary.prepend(icon('bot'));
    document.documentElement.classList.add('visual-ready');
    return {render,choose,cloud};
  })();
  ready.catch(()=>{});globalThis.FalsifyVisual.ready=ready;
})();

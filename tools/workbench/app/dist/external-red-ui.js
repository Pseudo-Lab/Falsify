/* External RED exchange panel; selection belongs to the workspace. */
(function(root){'use strict';
  function formatChartVal(val){
    if(val&&typeof val==='object'&&!Array.isArray(val)){
      const parts=['x','y','yLow','yHigh','value'].filter(k=>Object.hasOwn(val,k)).map(k=>k+':'+val[k]);
      return parts.length?parts.join(', '):JSON.stringify(val);
    }
    return String(val??'');
  }
  function statusLabel(status){
    if(status==='matched')return '연결됨';
    if(status==='ambiguous')return '후보 여러 곳';
    if(status==='pending-table')return '표 확인 필요';
    return '위치 없음';
  }
  function formatTableSummary(item){
    const t=item.tableTarget||{};
    const page=Number.isInteger(t.pageIndex)?(t.pageIndex+1)+'쪽':Number.isInteger(item.pageIndex)?(item.pageIndex+1)+'쪽':'쪽 미지정';
    const coords=t.row!=null&&t.column!=null?' · '+(t.row+1)+'행 '+(t.column+1)+'열 (r'+t.row+' c'+t.column+')':'';
    const target=page+' · '+(t.tableId||'표')+coords;
    return {badge:'표 셀',kindClass:'is-table-cell',target,diff:String(t.before??item.before??'')+' → '+String(t.after??item.after??''),status:statusLabel(item.matchStatus)};
  }
  function formatChartSummary(item){
    const v=item.visualTarget||{};
    const page=Number.isInteger(v.pageIndex)?(v.pageIndex+1)+'쪽':Number.isInteger(item.pageIndex)?(item.pageIndex+1)+'쪽':'쪽 미지정';
    const series=v.series?' · '+v.series:'';
    const pt=v.pointIndex!=null?' · 점 #'+v.pointIndex:v.markIndex!=null?' · 마크 #'+v.markIndex:'';
    const target=page+' · '+(v.figureId||'차트')+series+pt;
    return {badge:'차트',kindClass:'is-chart-point',target,diff:formatChartVal(v.beforeValue??item.before)+' → '+formatChartVal(v.afterValue??item.after),status:statusLabel(item.matchStatus)};
  }
  function formatStructuredSummary(item){
    if(!item||typeof item!=='object')return null;
    if(item.kind==='table-cell')return formatTableSummary(item);
    if(item.kind==='chart-point')return formatChartSummary(item);
    return null;
  }
  function renderStructuredList(doc,container,items){
    const structured=(Array.isArray(items)?items:[]).map(item=>({item,summary:formatStructuredSummary(item)})).filter(x=>x.summary);
    container.replaceChildren();
    container.hidden=!structured.length;
    for(const {summary} of structured){
      const li=doc.createElement('li');li.className='external-red-structured-item';
      const badge=doc.createElement('span');badge.className='external-red-badge '+summary.kindClass;badge.textContent=summary.badge;
      const target=doc.createElement('span');target.className='external-red-structured-target';target.textContent=' '+summary.target+' · '+summary.status;
      const diff=doc.createElement('span');diff.className='external-red-structured-diff';diff.textContent=' · '+summary.diff;
      li.append(badge,target,diff);container.append(li);
    }
    return structured.length;
  }
  function importContextOptions(s,ws,instructionsUI){
    const visual=ws?.getVisualContext?.()||{};
    return {role:'red',segments:s.externalSegments||s.segments,fileHash:s.fileHash,tables:s.tables||visual.tables,figures:s.figures||visual.figures,prompt:instructionsUI?.requested()};
  }
  function mount(doc){
    function attach(){const host=doc.getElementById('paper-workspace');if(!host||doc.getElementById('external-red'))return;
      const section=doc.createElement('section');section.id='external-red';section.className='external-red';
      function node(tag,text){const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
      function button(text,fn){const n=node('button',text);n.type='button';n.className='button secondary';n.addEventListener('click',fn);return n;}
      const title=node('h2','외부 RED 응답 가져오기'),instructions=node('p','프롬프트를 복사하고 응답을 붙여넣거나 파일을 선택하세요.');
      const answer=node('textarea');answer.rows=8;answer.id='external-red-paste';answer.setAttribute('aria-label','외부 응답');
      const file=node('input');file.type='file';file.accept='.json,.txt,.md,application/json,text/plain,text/markdown';file.setAttribute('aria-label','응답 파일');
      const status=node('p');status.setAttribute('role','status');
      const structuredList=node('ul');structuredList.className='external-red-structured-list';structuredList.hidden=true;structuredList.setAttribute('aria-label','표·차트 제안 목록');
      const activeWorkspace=()=>root.FalsifyLatexWorkbench?.active?root.FalsifyLatexWorkbench:root.FalsifyPaperWorkspace;
      const source=()=>activeWorkspace()?.getSource?.();
      const instructionsUI=root.FalsifyPromptInstructions?.mount(doc,'red',source,status);
      file.addEventListener('change',async()=>{try{if(file.files[0]){const prior=source(),identity=prior&&prior.fileHash+':'+(prior.sourceHash||'');const raw=await file.files[0].text(),current=source();if(!current||identity!==current.fileHash+':'+(current.sourceHash||'')){status.textContent='파일 읽는 동안 원문이 바뀌어 가져오지 않았습니다.';return;}answer.value=raw;importButton.click();}}catch(e){status.textContent='파일을 읽지 못했습니다: '+e.message;}});
      const before=node('textarea'),after=node('textarea'),completion=node('details');before.rows=2;after.rows=2;before.setAttribute('aria-label','원문 Before');after.setAttribute('aria-label','변경 After');completion.append(node('summary','직접 Before / After 완성'),node('p','원문과 변경을 입력하세요. 빈 After는 삭제입니다.'),before,after);
      let processed=null;const inputKey=s=>JSON.stringify([s.fileHash,s.sourceHash||'',answer.value,before.value,after.value]);
      const importButton=button('응답 가져오기',()=>{const s=source(),w=activeWorkspace();if(!s||!w?.acceptExternalResponse){status.textContent='원문 또는 작업 공간이 준비되지 않았습니다.';return;}try{const key=inputKey(s);if(key===processed){status.textContent='이미 가져온 응답입니다. 내용이 바뀌면 다시 가져올 수 있습니다.';return;}const parseOpts=importContextOptions(s,w,instructionsUI);let batch=root.FalsifyExternalExchange.parse(answer.value,parseOpts);if(before.value.trim()){const manual=root.FalsifyExternalExchange.parse(JSON.stringify({changes:[{before:before.value,after:after.value}]}),{role:'red',segments:s.externalSegments||s.segments,fileHash:s.fileHash});batch.items.push(...manual.items);batch.diagnostics.push(...manual.diagnostics);if(batch.items.length)batch.status='ok';}if(batch.diagnostics.some(d=>d.code==='role-mismatch'))throw Error('응답의 역할이 다릅니다.');if(batch.diagnostics.some(d=>d.code==='file-hash-mismatch')&&!root.confirm('응답의 원문 식별이 다릅니다. 현재 원문에 가져올까요?'))return;w.acceptExternalResponse(batch);processed=key;renderStructuredList(doc,structuredList,w.getExternalResponses?.()?.items||batch.items);status.textContent='응답 저장 · 변경 '+batch.items.length+'개. '+batch.diagnostics.map(d=>d.message).join(' ');}catch(e){status.textContent='가져오지 못했습니다: '+e.message;}});
      answer.addEventListener('paste',e=>{const text=e.clipboardData?.getData('text');if(typeof text==='string'){e.preventDefault();answer.value=text;importButton.click();}});
      doc.addEventListener('falsify:paper-workspace-source',()=>{processed=null;answer.value='';before.value='';after.value='';file.value='';renderStructuredList(doc,structuredList,[]);status.textContent='원문이 바뀌어 입력을 지웠습니다.';});
      doc.addEventListener('falsify:paper-external-responses',e=>{renderStructuredList(doc,structuredList,e.detail?.items||[]);});
      const recordButton=button('외부 RED 응답 기록',async()=>{
        try {
          const ws=activeWorkspace(),s=source(),raw=ws?.getExternalResponses?.();
          if(!s||!raw)throw Error('먼저 응답을 가져오세요.');
          const projection=ws.getRecordSnapshot?.();
          const segments=projection?.segments||s.externalSegments||s.segments;
          const snapshot=projection?{...projection.external,sourceSession:projection.sourceSession}:raw;
          const sourceText=segments.map(x=>x.text).join('\n\n');
          const sourceHash=Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(sourceText)))).map(x=>x.toString(16).padStart(2,'0')).join('');
          const output=ws.getCurrentOutput?.(),outputFileHash=output?.sha256,outputKey=output?.generationKey;
          function current(){try {const now=source();return activeWorkspace()===ws&&now?.fileHash===s.fileHash&&now.sourceHash===s.sourceHash&&JSON.stringify(ws.getExternalResponses())===JSON.stringify(raw)&&JSON.stringify(ws.getRecordSnapshot?.())===JSON.stringify(projection)&&(!projection&&(now.externalSegments||now.segments).map(x=>x.text).join('\n\n')!==sourceText?false:true)&&(!outputFileHash||(ws.getCurrentOutput?.()?.sha256===outputFileHash&&ws.getCurrentOutput?.()?.generationKey===outputKey));}catch{return false;}}
          if(!current())throw Error('원문 또는 선택이 바뀌어 기록하지 않았습니다.');
          const id=await root.FalsifyLab.recordExternal({fileHash:s.fileHash,sourceHash,revision:root.crypto.randomUUID(),name:s.file?.name||'',segments,...(outputFileHash?{outputFileHash}:{})},snapshot,current);
          status.textContent='기록됨 · '+id;
        } catch(e){status.textContent='기록하지 못했습니다: '+e.message;}
      });section.append(title,instructions);if(instructionsUI)section.append(instructionsUI.panel);section.append(answer,file,completion,importButton,recordButton,structuredList,status);host.append(section);
    }
    doc.addEventListener('falsify:paper-workspace-ready',attach);attach();return api;
  }
  const api={mount,formatStructuredSummary,renderStructuredList};root.FalsifyExternalRedUI=api;if(root.document)mount(root.document);
})(typeof globalThis==='object'?globalThis:this);

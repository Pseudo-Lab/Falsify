/* RED visual edits use the existing paper evidence, human provenance and BLUE file handoff. */
(function(root){
  'use strict';
  const hash=async bytes=>[...new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const b64=bytes=>{let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));return root.btoa(raw);};
  function appendChartEdits(edits,base,change){
        const before=[],after=[];
        const old=change.before,next=change.after;
        const meta=value=>({kind:value.kind,title:value.title,xAxis:value.xAxis,yAxis:value.yAxis});
        if(JSON.stringify(meta(old))!==JSON.stringify(meta(next))){before.push({chart:meta(old)});after.push({chart:meta(next)});}
        const ids=[...new Set([...old.series,...next.series].map(x=>x.id))];
        for(const id of ids){
          const a=old.series.find(x=>x.id===id),b=next.series.find(x=>x.id===id);
          if(JSON.stringify([a?.name,a?.color])!==JSON.stringify([b?.name,b?.color])){before.push({series:id,name:a?.name??null,color:a?.color??null});after.push({series:id,name:b?.name??null,color:b?.color??null});}
          for(let i=0;i<Math.max(a?.points?.length||0,b?.points?.length||0);i++){
            const x=a?.points?.[i]??null,y=b?.points?.[i]??null;
            if(JSON.stringify(x)!==JSON.stringify(y)){before.push({series:id,point:i,value:x});after.push({series:id,point:i,value:y});}
          }
        }
        for(let i=0;i<before.length;i+=25)edits.push({...base,id:base.id+'-'+i/25,before:JSON.stringify(before.slice(i,i+25)),after:JSON.stringify(after.slice(i,i+25))});
  }
  function manualEdits(changes){
    const edits=[];
    for(const [index,change] of changes.entries()){
      const base={id:('visual-'+String(change.id||index)).slice(0,65),enabled:true,pageIndex:change.pageIndex,origin:'human',anchor:Array.isArray(change.bbox)?{bbox:[...change.bbox]}:null};
      if(Array.isArray(change.before?.series)&&Array.isArray(change.after?.series)){
        appendChartEdits(edits,base,change);
      }else edits.push({...base,before:describe(change.before),after:describe(change.after)});
    }
    return edits;
  }
  function describe(value){
    if(typeof value==='string'&&value.length<=8000)return value;
    const raw=JSON.stringify(value??null);
    if(raw.length<=8000)return raw;
    if(value&&typeof value==='object'){
      const sha=value.sha256||value.imageSha256||value.hash;
      if(typeof sha==='string')return '이미지 SHA-256 '+sha;
    }
    throw Error('변경 기록은 JSON 파일로 저장하세요.');
  }
  function mappedPage(map,page){
    const rows=Array.isArray(map)?map.filter(row=>row?.sourcePageIndex===page):[];
    if(rows.length!==1||!Number.isSafeInteger(rows[0].outputPageIndex)||rows[0].outputPageIndex<0)return null;
    if(!Array.isArray(rows[0].continuationPageIndices)||rows[0].continuationPageIndices.length)return null;
    if(map.filter(row=>row?.outputPageIndex===rows[0].outputPageIndex||row?.continuationPageIndices?.includes(rows[0].outputPageIndex)).length!==1)return null;
    return rows[0].outputPageIndex;
  }
  function mount(){
    const doc=root.document,host=doc?.getElementById('red-visual-edit-host'),section=doc?.getElementById('red-visual-section');
    const B=root.FalsifyLocalBridge;
    if(!host||!section||!B||!root.FalsifyVisualEditUI)return null;
    const analysisHost=doc.getElementById('red-visual-analysis'),status=doc.getElementById('red-visual-record-status');
    let editor=null,enrichment=null,localBusy=false,enrichmentBusy=false,redBusy=false,announced=false,sourceKey='',prepared=null,recordId=null,recordRevision=0,editorRelease=null,stagedChanges=[],lastRecordHash=null;
    const say=text=>{if(status)status.textContent=text;};
    let fullRecord=null;
    const recordButton=doc.createElement('button');recordButton.type='button';recordButton.className='button secondary';recordButton.textContent='변경 기록 JSON 저장';recordButton.hidden=true;
    section.append(recordButton);
    recordButton.addEventListener('click',()=>{
      if(!fullRecord)return;
      const url=root.URL.createObjectURL(new root.Blob([JSON.stringify(fullRecord,null,2)],{type:'application/json'}));
      const a=doc.createElement('a');a.href=url;a.download='falsify-visual-edits.json';doc.body.append(a);a.click();a.remove();setTimeout(()=>root.URL.revokeObjectURL(url),1000);
    });

    function source(){
      const ws=root.FalsifyPaperWorkspace,original=ws?.getSource?.();
      if(!original?.file||!original.fileHash||!(/\.pdf$/i.test(original.file.name)||original.file.type==='application/pdf'))return null;
      const current=ws.getCurrentOutput?.();
      const snapshot=ws.getEditSnapshot?.();
      if(snapshot?.edits?.some(edit=>edit.enabled!==false)&&(!current?.file||current.originalSourceSha256!==original.fileHash))return null;
      const selected=current?.file&&current.originalSourceSha256===original.fileHash?{file:current.file,fileHash:current.sha256}:original;
      return {file:selected.file,fileHash:selected.fileHash,revision:String(snapshot?.revision??0),name:selected.file.name,
        segments:selected.fileHash===original.fileHash?original.segments:[]};
    }
    function selectionPage(src){
      const ws=root.FalsifyPaperWorkspace,original=ws?.getSource?.(),page=ws?.getPageIndex?.();
      if(!src||!original||!Number.isSafeInteger(page)||page<0)return null;
      if(src.file===original.file&&src.fileHash===original.fileHash)return page;
      const current=ws.getCurrentOutput?.();
      if(!current||current.file!==src.file||current.sha256!==src.fileHash||current.originalSourceSha256!==original.fileHash)return null;
      return mappedPage(current.pageMap,page);
    }
    function sync(){
      editor?.setBusy?.(redBusy||enrichmentBusy);
      enrichment?.setBusy?.(redBusy||localBusy);
      const active=localBusy||enrichmentBusy;
      if(active!==announced){announced=active;doc.dispatchEvent(new CustomEvent('falsify:visual-edit-busy',{detail:{busy:active}}));}
    }
    function hold(){
      if(localBusy||enrichmentBusy||redBusy)return null;
      localBusy=true;sync();let released=false;
      return ()=>{if(released)return;released=true;localBusy=false;sync();};
    }
    async function prepare(){
      const src=source(),session=B.session();if(!src||!session)throw Error('PDF와 PC 연결을 확인하세요.');
      const key=src.fileHash+':'+JSON.stringify(B.capabilities?.()?.companionInstance??null);
      if(prepared?.key===key)return prepared.promise;
      const pending=(async()=>{
        const bytes=new Uint8Array(await src.file.arrayBuffer());if(await hash(bytes)!==src.fileHash)throw Error('원본 파일이 달라졌습니다.');
        const result=await session.request('/api/paper/evidence/prepare',{fileHash:src.fileHash,file:b64(bytes)});
        if(source()?.fileHash!==src.fileHash||result.fileHash!==src.fileHash)throw Error('선택한 PDF가 바뀌었습니다.');
        return result;
      })();prepared={key,promise:pending};
      try{return await pending;}catch(error){if(prepared?.promise===pending)prepared=null;throw error;}
    }
    async function onOutput(output,detail){
      if(detail?.intent==='blue'){
        if(!doc.dispatchEvent(new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:output.file}})))throw Error('BLUE 입력을 유지했습니다.');
        const button=[...doc.querySelectorAll('[data-view=blue]')].find(x=>x.getClientRects().length);button?.click();return;
      }
      const src=source();if(!src||!Array.isArray(output.changes))return;
      if(lastRecordHash===output.outputFileHash)return;
      const changes=output.changes.map(change=>{const staged=stagedChanges.find(x=>x.id===change.id);return staged?{...change,before:staged.before,after:staged.after}:change;});
      fullRecord={schema:'falsify.visual-edit-record.v1',sourceFileHash:src.fileHash,sourceName:src.name,outputFileHash:output.outputFileHash,createdAt:new Date().toISOString(),author:'human',changes,report:output.changes,verification:output.verification};recordButton.hidden=false;
      const records=root.FalsifyPaperManualRecords;
      if(!records?.capture){say('PDF와 변경 기록 JSON을 다운로드할 수 있습니다.');return;}
      recordId=recordId||'pvr-'+root.crypto.randomUUID();recordRevision++;
      try{
        const snapshot={schema:'falsify.paper-edits.v1',fileHash:src.fileHash,revision:recordRevision,edits:manualEdits(changes)};
        await records.capture({recordId,source:{fileHash:src.fileHash,name:src.name,segments:src.segments||[]},snapshot,
          output:{sha256:output.outputFileHash,revision:recordRevision,verification:output.verification||{}},now:Date.now()});
        if(source()?.fileHash===src.fileHash){lastRecordHash=output.outputFileHash;say('변경 전후와 위치를 사람 편집 기록에 남겼습니다.');}
      }catch{say('PDF는 준비됐습니다. 전체 변경 기록은 JSON으로 저장하세요.');}
    }
    editor=root.FalsifyVisualEditUI.create({host,getSource:source,getSelectionPage:selectionPage,getSession:()=>B.session(),hold:request=>{if(!request)return hold();if(request.active){editorRelease=hold();return !!editorRelease;}editorRelease?.();editorRelease=null;return true;},onChange:value=>{stagedChanges=structuredClone(value.changes||[]);},onOutput});
    if(root.FalsifyPaperEnrichmentUI&&analysisHost){
      enrichment=root.FalsifyPaperEnrichmentUI.create({host:analysisHost,getSource:source,getSession:()=>B.session(),getCapabilities:()=>B.capabilities(),preparePaper:prepare,
        onBusyChange:value=>{enrichmentBusy=!!value;sync();},
        onResult:result=>{if(result.kind==='chart'&&editor.setAnalysis)editor.setAnalysis(result);else if(result.kind==='ocr'&&editor.setOcrAnalysis)editor.setOcrAnalysis(result);else void editor.refresh?.();}});
    }
    function refresh(){
      const src=source(),key=src?src.fileHash+':'+src.revision:'';
      section.hidden=!src;
      if(key!==sourceKey){sourceKey=key;prepared=null;recordId=null;recordRevision=0;stagedChanges=[];lastRecordHash=null;fullRecord=null;recordButton.hidden=true;editor.clear?.();enrichment?.clear?.();say('');if(src)void editor.refresh?.();}
      sync();
    }
    doc.addEventListener('falsify:paper-workspace-source',refresh);
    doc.addEventListener('falsify:paper-workspace-output',refresh);
    doc.addEventListener('falsify:document-clear',refresh);
    doc.addEventListener('falsify:local-bridge',()=>{prepared=null;sync();if(source()&&!editor.snapshot?.()?.paperId)void editor.refresh?.();});
    doc.addEventListener('falsify:document-state',event=>{const value=!!event.detail?.busy;if(redBusy!==value){redBusy=value;sync();}});
    refresh();return {refresh,source,editor,enrichment};
  }
  const api={mount,manualEdits};root.FalsifyVisualEditIntegration=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document){const start=()=>{api.instance=mount();};if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});else start();}
})(typeof globalThis==='object'?globalThis:this);

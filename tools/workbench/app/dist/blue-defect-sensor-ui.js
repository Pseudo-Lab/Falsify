/* Browser BLUE Layer 0 deterministic defect sensor & P0/P2 forensic UI. AGPL-3.0-only. */
(function(root){
  'use strict';
  const PREPARE='/api/paper/evidence/prepare';
  const QUERY='/api/paper/evidence/query';
  const MAX_PDF=25*1024*1024;

  function sensorApi(){
    if(root.FalsifyBlueDefectSensor)return root.FalsifyBlueDefectSensor;
    if(typeof require==='function'){try{return require('./blue-defect-sensor-core.js');}catch{}}
    return null;
  }
  function encodeBase64(bytes){
    let s='';
    for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return root.btoa(s);
  }
  function isPdfBytes(bytes){
    return bytes.length>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;
  }
  function isPdfInput(source,file){
    if(file&&(file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')))return true;
    return !!(source&&(source.format==='PDF'||/\.pdf$/i.test(source.name||'')));
  }
  function insertPanel(host,section){
    const steps=host.querySelectorAll?.('.role-step');
    const first=steps?.length?steps[0]:host.children?.find?.(c=>String(c.className||'').includes('role-step'));
    if(first&&typeof first.after==='function')first.after(section);
    else if(first&&typeof host.insertBefore==='function')host.insertBefore(section,first.nextSibling||null);
    else host.append(section);
  }
  function formatForensicText(report){
    const parts=[];
    if(report?.uriLinks){
      parts.push('하이퍼링크(/URI): 총 '+(report.uriLinks.total??0)+'건 · DOI 불일치 '+(report.uriLinks.mismatchCount??0)+'건');
    }
    if(report?.acroForm){
      const a=report.acroForm;
      parts.push('AcroForm 필드: 전체 '+(a.total??0)+'개 · 입력됨 '+(a.filled??0)+'개 · 빈칸 '+(a.blank??0)+'개');
    }
    if(report?.oraclePack){
      const entries=Array.isArray(report.oraclePack.entries)?report.oraclePack.entries:(Array.isArray(report.oraclePack.items)?report.oraclePack.items:[]);
      parts.push('외부 오라클(P2): 단서 '+entries.length+'건 반영 (PDF 대조 필수)');
    }
    return parts.join(' · ');
  }

  function mount(doc,host){
    host=host||doc.getElementById('document-blue');
    if(!host||doc.getElementById('blue-defect-sensor'))return null;
    const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    const section=node('section',undefined,'role-step blue-sensor-panel');
    section.id='blue-defect-sensor';
    const head=node('div',undefined,'blue-sensor-head');
    const titleWrap=node('div',undefined,'blue-sensor-title-wrap');
    const title=node('h3','Layer 0 즉시 감식 (P0 오프라인)');
    const tierBadge=node('span','P0 오프라인','blue-oracle-tier');
    titleWrap.append(title,tierBadge);
    head.append(titleWrap);

    const summary=node('p','파일을 선택하면 Layer 0 수치·통계 및 서지·인용 단서를 즉시 감식합니다.','blue-sensor-summary');
    const forensic=node('p','','blue-sensor-forensic');forensic.hidden=true;
    const actions=node('div',undefined,'blue-sensor-actions');
    const deepBtn=node('button','PDF 심층 포렌식 스캔 (/URI · AcroForm · P0)','button secondary');deepBtn.type='button';deepBtn.disabled=true;
    const oracleBtn=node('button','외부 오라클 대조 실행 (Crossref · 임상등록부 · P2)','button secondary');oracleBtn.type='button';oracleBtn.disabled=true;
    actions.append(deepBtn,oracleBtn);

    const details=node('details',undefined,'blue-sensor-details');
    const detailsSummary=node('summary','감식 단서 목록 (0건)');
    const list=node('ul',undefined,'blue-sensor-list');
    details.append(detailsSummary,list);
    details.hidden=true;

    const status=node('p','','blue-sensor-status');status.setAttribute('role','status');
    section.append(head,summary,forensic,actions,details,status);
    insertPanel(host,section);

    let lastIdentity=null,latestFile=null,preparedPaper=null,busy=false;
    const bridge=()=>root.FalsifyDocumentBlueExternal;
    const currentSource=()=>bridge()?.getSource?.()||null;
    const currentFile=evFile=>bridge()?.getPdfFile?.()||evFile||latestFile||doc.getElementById('doc-blue-file')?.files?.[0]||null;
    const identityOf=s=>s?s.fileHash+':'+(s.sourceHash||''):null;

    function renderSignals(report){
      list.replaceChildren();
      const signals=Array.isArray(report?.signals)?report.signals:[];
      detailsSummary.textContent='감식 단서 목록 ('+signals.length+'건)';
      details.hidden=!signals.length;
      for(const s of signals.slice(0,60)){
        const li=node('li',undefined,'blue-sensor-item');
        const page=Number.isInteger(s.pageIndex)?'p.'+(s.pageIndex+1)+' · ':'';
        li.append(node('div','['+(s.category||'L0')+'] '+page+s.kind+' — '+(s.detail||''),'blue-sensor-item-head'));
        if(s.excerpt)li.append(node('div','인용: '+s.excerpt,'blue-sensor-item-quote'));
        list.append(li);
      }
    }
    function syncButtons(source,file){
      const connected=!!root.FalsifyLocalBridge?.state?.()?.connected&&!!root.FalsifyLocalBridge?.session?.();
      const canPdf=connected&&!!source&&isPdfInput(source,file)&&!busy;
      deepBtn.disabled=!canPdf;
      oracleBtn.disabled=!canPdf;
    }
    function renderReport(source,report){
      if(!source||!report){
        tierBadge.textContent='P0 오프라인';tierBadge.className='blue-oracle-tier';
        summary.textContent='파일을 선택하면 Layer 0 수치·통계 및 서지·인용 단서를 즉시 감식합니다.';
        forensic.hidden=true;forensic.textContent='';
        renderSignals(null);syncButtons(source,latestFile);return;
      }
      const isP2=report.tier==='P2'&&!!report.oraclePack;
      tierBadge.textContent=isP2?'P2 · 오라클 결합':'P0 · 오프라인';
      tierBadge.className=isP2?'blue-oracle-tier is-p2':'blue-oracle-tier';
      const d1=report.counts?.d1??0,d2=report.counts?.d2??0,extra=report.counts?.companion??0;
      summary.textContent='Layer 0 즉시 감식 ('+(isP2?'P2 오라클 결합':'P0 오프라인')+'): D1 수치·통계 단서 '+d1+'건 · D2 서지·인용 단서 '+d2+'건'+(extra?' · PDF/오라클 단서 '+extra+'건':'');
      const forensicText=formatForensicText(report);
      forensic.textContent=forensicText;forensic.hidden=!forensicText;
      renderSignals(report);syncButtons(source,latestFile);
    }
    function scanCurrent(ev){
      const source=currentSource();
      latestFile=currentFile(ev?.detail?.file);
      const nextId=identityOf(source),api=sensorApi();
      if(!source){lastIdentity=null;preparedPaper=null;status.textContent='';status.className='blue-sensor-status';renderReport(null,null);return;}
      if(!api){syncButtons(source,latestFile);return;}
      if(nextId!==lastIdentity){
        if(preparedPaper&&preparedPaper.fileHash!==source.fileHash)preparedPaper=null;
        lastIdentity=nextId;
        const report=api.scanSegments({fileHash:source.fileHash,segments:source.segments||[]});
        api.setActiveReport(source.fileHash,report);
        status.textContent='';status.className='blue-sensor-status';
        renderReport(source,report);
      }else{
        renderReport(source,api.getActiveReport(source.fileHash));
      }
    }
    async function ensurePaperId(session,source,file){
      if(source.paperId)return source.paperId;
      if(preparedPaper&&preparedPaper.fileHash===source.fileHash)return preparedPaper.paperId;
      if(!file)throw new Error('심층 PDF 스캔을 위해 원본 PDF 파일이 필요합니다.');
      if(file.size>MAX_PDF)throw new Error('25 MiB를 초과하는 PDF는 심층 스캔할 수 없습니다.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(!isPdfBytes(bytes))throw new Error('유효한 PDF 파일이 아닙니다.');
      const res=await session.request(PREPARE,{fileHash:source.fileHash,file:encodeBase64(bytes)});
      if(!res?.paperId)throw new Error('Companion paperId를 받지 못했습니다.');
      preparedPaper={fileHash:source.fileHash,paperId:res.paperId};
      return res.paperId;
    }
    async function runCompanionScan(includeExternalOracle){
      const source=currentSource(),api=sensorApi(),session=root.FalsifyLocalBridge?.session?.();
      if(!source||!api||!session)return;
      const startId=identityOf(source),file=currentFile(null);
      busy=true;syncButtons(source,file);
      status.className='blue-sensor-status';
      status.textContent=includeExternalOracle?'외부 오라클(Crossref·임상등록부) 대조를 실행 중입니다...':'PDF 심층 포렌식(/URI·AcroForm) 스캔 중입니다...';
      try{
        const paperId=await ensurePaperId(session,source,file);
        const companion=await session.request(QUERY,{paperId,operation:'blue_sensor',includeExternalOracle});
        if(identityOf(currentSource())!==startId){status.textContent='스캔 중 원문이 변경되어 결과를 반영하지 않았습니다.';return;}
        const base=api.getActiveReport(source.fileHash)||api.scanSegments({fileHash:source.fileHash,segments:source.segments||[]});
        const merged=api.mergeCompanionSensor(base,companion);
        api.setActiveReport(source.fileHash,merged);
        renderReport(source,merged);
        status.textContent=includeExternalOracle?'외부 오라클(P2) 대조를 반영했습니다. 반드시 첨부 PDF 원문과 대조해 확인하세요.':'PDF 심층 포렌식(P0) 스캔을 완료했습니다.';
      }catch(e){
        status.className='blue-sensor-status error';
        status.textContent='스캔 실패: '+(e?.message||'알 수 없는 오류');
      }finally{
        busy=false;syncButtons(currentSource(),currentFile(null));
      }
    }

    deepBtn.addEventListener('click',()=>void runCompanionScan(false));
    oracleBtn.addEventListener('click',()=>void runCompanionScan(true));
    doc.addEventListener('falsify:blue-state',scanCurrent);
    doc.addEventListener('falsify:local-bridge',()=>{syncButtons(currentSource(),currentFile(null));});
    scanCurrent();
    return section;
  }

  root.FalsifyBlueDefectSensorUI={mount};
  if(root.document)mount(root.document);
})(typeof globalThis==='object'?globalThis:this);

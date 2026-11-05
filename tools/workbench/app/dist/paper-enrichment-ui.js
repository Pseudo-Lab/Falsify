/* BLUE scan/chart reading panel. No build step and no new dependency.
   Root wires the host under the evidence controls, the session bridge, preparePaper,
   and onResult. This file does not read RED, does not store the PDF, and does not
   keep a permanent cell cache. Model text is assigned with textContent only.
   Preview: FalsifyBlueVisual.previewBluePage, loaded only while this details is open.
   Drag boxes are PDF.js viewport points at scale 1 (PDF points), XYXY.
   OCR posts bbox null (full page). Chart posts the selected region.
   A lost POST receipt is reconciled by the client-generated job id.
   '보정해서 다시 읽기' posts that same chart request plus chartOptions.
   Axis pixels are the result crop: point() mapped through result.bbox onto inputImage.
   X uses the x pixel and Y uses the y pixel. Curve colors come from the preview canvas.
   Changing file, page, or region drops those picks and does not reuse the old image hash. */
(function(root){
  'use strict';
  const JOBS='/api/paper/evidence/jobs';
  const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const HEX=/^[0-9a-f]{64}$/;
  const AID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const POLL_MS=300;
  const MAX_POLLS=2400;
  const GET_TRIES=3;
  const DERIVATION='모델이 이미지에서 추정해 읽은 결과입니다. 측정값으로 확정하지 않았고 검수된 인용이 아닙니다.';
  const PATH_MSG='허용되지 않은 로컬 경로입니다.';
  function failureText(code){
    const reasons={analysis_dependency_missing:'PC에 OCR·그래프 분석 도구를 설치하세요.',
      analysis_runtime_missing:'PC의 분석 실행 환경을 다시 설치하세요.',
      analysis_engine_unavailable:'분석 모델을 준비하지 못했습니다. PC의 분석 도구 설치 상태를 확인하세요.',
      analysis_timeout:'시간이 초과됐습니다. 더 작은 영역으로 다시 읽어보세요.',
      paper_evidence_expired_or_missing:'논문을 다시 넣어주세요.'};
    return '읽기에 실패했습니다. '+(reasons[code]||'이전 결과는 그대로입니다.');
  }
  const PREVIEW_MSG={
    visual_input_invalid:'PDF를 확인하세요.',
    visual_file_hash_mismatch:'원본 파일이 바뀌어 미리보기를 열지 못했습니다.',
    visual_not_pdf:'PDF가 아니라 미리보기를 열지 못했습니다.',
    visual_selection_invalid:'쪽 번호를 확인하세요.'
  };

  function paperIdOk(id){return typeof id==='string'&&id.length>=1&&id.length<=160&&!/[\u0000-\u0020\u007f]/.test(id);}
  function roundPt(n){return Math.round(n*100)/100;}
  function finite(n){return typeof n==='number'&&Number.isFinite(n);}
  function clip(value,max){
    const text=String(value).replace(/[\u0000-\u001f]/g,'');
    return text.length>max?text.slice(0,max)+'…':text;
  }
  function cleanIssue(value){
    if(typeof value!=='string')return null;
    const text=value.replace(/[\u0000-\u001f]/g,'').trim();
    if(!text)return null;
    return text.length>500?text.slice(0,500)+'…':text;
  }
  function bboxShape(b){
    return Array.isArray(b)&&b.length===4&&b.every(finite)&&b[2]>b[0]&&b[3]>b[1]&&b.every(n=>Math.abs(n)<=20000);
  }
  function sameBox(sent,got){
    return bboxShape(sent)&&bboxShape(got)&&sent.every((n,i)=>Math.abs(n-got[i])<=0.5);
  }
  function freeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
    for(const key of Object.keys(value))freeze(value[key]);
    return Object.freeze(value);
  }
  function jobPath(id){return JOBS+'/'+id;}
  function cancelPath(id){return jobPath(id)+'/cancel';}
  function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}
  function pause(ms,signal){
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(abortError());return;}
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
      const onAbort=()=>{clearTimeout(timer);reject(abortError());};
      signal?.addEventListener('abort',onAbort,{once:true});
    });
  }
  function csvCell(value){
    let text=value==null?'':String(value);
    if(/^[=\-+@\t\r]/.test(text))text="'"+text;
    return /[",\n\r]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
  }
  function csvLine(cells){return cells.map(csvCell).join(',');}
  function progressObjectText(progress){
    if(progress&&typeof progress==='object'&&!Array.isArray(progress)){
      const done=progress.completed??progress.done, total=progress.total??progress.required;
      if(Number.isSafeInteger(done)&&Number.isSafeInteger(total)&&total>=0&&done>=0)return '읽는 중입니다. '+done+'/'+total;
      if(typeof progress.message==='string'&&progress.message.trim())return clip(progress.message,180);
      if(typeof progress.phase==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(progress.phase))return '읽는 중입니다. · '+progress.phase;
    }
    return '읽는 중입니다.';
  }
  function progressText(progress){
    if(typeof progress==='string')return clip(progress,180)||'읽는 중입니다.';
    if(finite(progress))return '읽는 중입니다. '+Math.round(Math.max(0,Math.min(1,progress))*100)+'%';
    return progressObjectText(progress);
  }
  function classify(error){
    if(error?.name==='AbortError')return 'abort';
    if(error?.message===PATH_MSG)return 'path';
    const status=Number.isInteger(error?.httpStatus)?error.httpStatus:0;
    if(status>=400&&status<500)return 'rejected';
    return 'lost';
  }
  function previewMessage(error){
    const code=error&&(PREVIEW_MSG[error.message]||PREVIEW_MSG[error.code]);
    return code||'PDF 미리보기를 열지 못했습니다.';
  }
  function pickedProvenance(value){
    const out={};
    if(!value||typeof value!=='object'||Array.isArray(value))return out;
    for(const key of ['engine','version','method','model','revision','device','language']){
      if(typeof value[key]==='string'&&value[key].trim())out[key]=clip(value[key].trim(),80);
    }
    return out;
  }
  function provenanceLine(p){
    const labels=[['engine','엔진'],['version','버전'],['method','방법'],['model','모델'],['revision','리비전'],['device','장치'],['language','언어']];
    const parts=labels.filter(([key])=>p[key]).map(([key,label])=>label+' '+p[key]);
    return parts.length?'도출 · '+parts.join(' · '):'도출 정보가 없습니다.';
  }
  function takeIssues(list,extra){
    const out=[];
    const source=Array.isArray(list)?list:[];
    for(const item of source){
      if(out.length>=100)break;
      const text=cleanIssue(item);
      if(text)out.push(text);
    }
    for(const item of extra)if(out.length<100&&item)out.push(item);
    if(source.length>100)out.push('화면: 한계 항목 '+(source.length-100)+'개는 생략했습니다.');
    return out;
  }
  function copyImage(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    if(typeof value.sha256!=='string'||!HEX.test(value.sha256))return null;
    if(!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<1||value.height<1)return null;
    if(value.width>30000||value.height>30000)return null;
    return {sha256:value.sha256,width:value.width,height:value.height};
  }
  function copyInputImage(value){
    const image=copyImage(value);
    if(!image||!finite(value.dpi)||value.dpi<=0||value.dpi>2400)return null;
    return {sha256:image.sha256,width:image.width,height:image.height,dpi:value.dpi};
  }
  function copyBBox(value){
    if(!bboxShape(value))return null;
    return value.map(roundPt);
  }
  function normalizeOcrTable(raw,cells){
      const table={cells};
      if(Number.isSafeInteger(raw.rows)&&raw.rows>=0&&raw.rows<=10000)table.rows=raw.rows;
      if(Number.isSafeInteger(raw.columns)&&raw.columns>=0&&raw.columns<=1000)table.columns=raw.columns;
      const bbox=copyBBox(raw.bbox);
      if(bbox)table.bbox=bbox;
      const sourceBbox=copyBBox(raw.sourceBbox);if(sourceBbox)table.sourceBbox=sourceBbox;
    return table;
  }
  function appendOcrCellGeometry(next,cell){
        if(cell.confidence==null||finite(cell.confidence))next.confidence=finite(cell.confidence)?cell.confidence:null;
        const bbox=copyBBox(cell.bbox);
        if(bbox)next.bbox=bbox;
        const sourceBbox=copyBBox(cell.sourceBbox);if(sourceBbox)next.sourceBbox=sourceBbox;
  }
  function normalizeOcrCell(cell,text,extra){
        const rowSpan=cell.rowSpan==null?1:cell.rowSpan;
        const columnSpan=cell.columnSpan==null?1:cell.columnSpan;
        if(!Number.isSafeInteger(rowSpan)||!Number.isSafeInteger(columnSpan)||rowSpan<1||columnSpan<1){extra.push('화면: 병합 정보가 달라 그 칸은 한 칸으로 뒀습니다.');}
        const next={row:cell.row,column:cell.column,rowSpan:Number.isSafeInteger(rowSpan)&&rowSpan>=1?rowSpan:1,columnSpan:Number.isSafeInteger(columnSpan)&&columnSpan>=1?columnSpan:1,text};
        appendOcrCellGeometry(next,cell);
    return next;
  }
  function appendOcrLineGeometry(line,raw){
      const bbox=copyBBox(raw.bbox);
      if(bbox)line.bbox=bbox;
      const sourceBbox=copyBBox(raw.sourceBbox);if(sourceBbox)line.sourceBbox=sourceBbox;
      if(Array.isArray(raw.polygon)&&raw.polygon.length<=16&&raw.polygon.every(p=>Array.isArray(p)&&p.length===2&&p.every(finite)))line.polygon=raw.polygon.map(p=>p.slice());
  }
  function normalizeOcrLine(raw,text,extra){
      let confidence=null;
      if(raw.confidence!=null){
        if(finite(raw.confidence))confidence=raw.confidence;
        else extra.push('화면: 일부 확신 값은 숫자가 아니어서 비웠습니다.');
      }
      const line={text,confidence};
      if(typeof raw.displayText==='string'&&raw.displayText.length<=12000&&raw.displayText.replace(/\s/g,'')===text.replace(/\s/g,''))line.displayText=raw.displayText;
      if(raw.spacing&&Array.isArray(raw.spacing.methods))line.spacing={methods:raw.spacing.methods.filter(x=>typeof x==='string').slice(0,10),numericCuts:(raw.spacing.numericCuts||[]).filter(Number.isSafeInteger),nonWhitespacePreserved:true};
      if(Array.isArray(raw.tokens))line.tokens=raw.tokens.slice(0,8000).filter(t=>t&&typeof t.text==='string').map(t=>({text:t.text,bbox:copyBBox(t.bbox),sourceBbox:copyBBox(t.sourceBbox)}));
      if(typeof raw.id==='string'&&raw.id.length>=1&&raw.id.length<=160&&!/[\u0000-\u001f]/.test(raw.id))line.id=raw.id;
      appendOcrLineGeometry(line,raw);
    return line;
  }
  function normalizeOcrLines(data,extra){
    let budget=500000;
    const lines=[];
    const sourceLines=Array.isArray(data.lines)?data.lines:[];
    for(const raw of sourceLines){
      if(lines.length>=4000||budget<=0){extra.push('화면: 글자 줄이 보관 한도를 넘어 이후는 생략했습니다.');break;}
      if(!raw||typeof raw!=='object'||typeof raw.text!=='string'){extra.push('화면: 글자 줄 일부를 형식이 달라 건너뛰었습니다.');continue;}
      const text=raw.text.length>8000?raw.text.slice(0,8000):raw.text;
      budget-=text.length;
      const line=normalizeOcrLine(raw,text,extra);
      lines.push(line);
    }
    return {lines,budget};
  }
  function validOcrCell(cell,extra){
        if(!cell||typeof cell!=='object'||typeof cell.text!=='string'){extra.push('화면: 표 칸 일부를 형식이 달라 건너뛰었습니다.');return false;}
        if(!Number.isSafeInteger(cell.row)||!Number.isSafeInteger(cell.column)||cell.row<0||cell.column<0||cell.row>10000||cell.column>1000){extra.push('화면: 표 칸 위치를 확인하지 못해 건너뛰었습니다.');return false;}
    return true;
  }
  function normalizeOcrTables(data,extra,budget){
    const tables=[];
    const sourceTables=Array.isArray(data.tables)?data.tables:[];
    for(const raw of sourceTables.slice(0,20)){
      if(!raw||typeof raw!=='object')continue;
      const cells=[];
      for(const cell of Array.isArray(raw.cells)?raw.cells:[]){
        if(cells.length>=4000||budget<=0){extra.push('화면: 표 칸이 보관 한도를 넘어 이후는 생략했습니다.');break;}
        if(!validOcrCell(cell,extra))continue;
        const text=cell.text.length>8000?cell.text.slice(0,8000):cell.text;
        budget-=text.length;
        const next=normalizeOcrCell(cell,text,extra);
        cells.push(next);
      }
      const table=normalizeOcrTable(raw,cells);
      tables.push(table);
    }
    if(sourceTables.length>20)extra.push('화면: 표는 20개까지만 보관했습니다.');
    return tables;
  }
  function normalizeOcr(data){
    const extra=[];
    const {lines,budget}=normalizeOcrLines(data,extra);
    const tables=normalizeOcrTables(data,extra,budget);
    return {
      schema:'falsify.ocr-page.v1',
      status:data.status,
      language:typeof data.language==='string'?clip(data.language,40):null,
      image:copyImage(data.image),
      lines,tables,
      transforms:(Array.isArray(data.transforms)?data.transforms:[]).slice(0,20).map(t=>({op:typeof t.op==='string'?t.op:null,angle:finite(t.angle)?t.angle:null,coordinateSpace:typeof t.coordinateSpace==='string'?t.coordinateSpace:null})),
      provenance:pickedProvenance(data.provenance),
      issues:takeIssues(data.issues,extra)
    };
  }
  function chartNumericCell(raw){
      const cell={row:raw.row,column:raw.column,raw:clip(raw.raw,500),value:raw.value,unit:raw.unit==null?null:(typeof raw.unit==='string'?clip(raw.unit,40):null),origin:raw.origin==='model-estimate'?'model-estimate':(typeof raw.origin==='string'?clip(raw.origin,40):null)};
    return cell;
  }
  function chartNumericCells(data,extra){
    const numericCells=[];
    for(const raw of Array.isArray(data.numericCells)?data.numericCells:[]){
      if(numericCells.length>=5000)break;
      if(!raw||typeof raw!=='object'||!Number.isSafeInteger(raw.row)||!Number.isSafeInteger(raw.column)||raw.row<0||raw.column<0)continue;
      if(typeof raw.raw!=='string'||!finite(raw.value)){extra.push('화면: 유한하지 않은 추정 숫자는 빼 두었습니다.');continue;}
      const cell=chartNumericCell(raw);
      numericCells.push(cell);
    }
    return numericCells;
  }
  function chartRows(data,columns,extra){
    const rows=[];
    for(const raw of data.rows){
      if(rows.length>=500){extra.push('화면: 행은 500개까지만 보관했습니다.');break;}
      if(!Array.isArray(raw)){extra.push('화면: 표의 일부 행이 목록이 아니어서 건너뛰었습니다.');continue;}
      if(columns.length&&raw.length!==columns.length)extra.push('화면: 행 길이가 열 수와 다릅니다.');
      rows.push(raw.slice(0,64).map(cell=>{
        if(cell==null||typeof cell==='string')return cell==null?null:(cell.length>8000?cell.slice(0,8000):cell);
        if(finite(cell)){extra.push('화면: 표의 일부 칸이 문자열이 아니어서 받은 그대로 적었습니다.');return String(cell);}
        extra.push('화면: 표의 일부 칸은 비웠습니다.');
        return null;
      }));
    }
    return rows;
  }
  function normalizeChart(data){
    const extra=[];
    if(!Array.isArray(data.columns)||data.columns.some(cell=>typeof cell!=='string'))return null;
    if(!Array.isArray(data.rows))return null;
    const columns=data.columns.slice(0,64).map(cell=>cell.length>500?cell.slice(0,500)+'…':cell);
    if(data.columns.length>64)extra.push('화면: 열은 64개까지만 보관했습니다.');
    const rows=chartRows(data,columns,extra);
    const numericCells=chartNumericCells(data,extra);
    const axis=value=>{
      const item=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
      const scale=['linear','log','multiple','unknown'].includes(item.scale)?item.scale:null;
      if(item.scale!=null&&scale==null)extra.push('화면: 확인하지 못한 눈금은 미확인으로 뒀습니다.');
      return {label:typeof item.label==='string'?clip(item.label,200):null,scale:scale||'unknown',unit:typeof item.unit==='string'?clip(item.unit,40):null};
    };
    let rawOutput='';
    if(data.rawOutput!=null){
      if(typeof data.rawOutput!=='string')return null;
      rawOutput=data.rawOutput.length>200000?data.rawOutput.slice(0,200000):data.rawOutput;
      if(data.rawOutput.length>200000)extra.push('화면: 모델 원문이 길어 일부만 보관했습니다.');
    }
    return {
      schema:'falsify.chart-data.v1',
      status:data.status,
      image:copyImage(data.image),
      columns,rows,numericCells,
      title:typeof data.title==='string'?clip(data.title,300):null,
      chartType:typeof data.chartType==='string'&&data.chartType.trim()?clip(data.chartType.trim(),80):'unknown',
      axes:{x:axis(data.axes?.x),y:axis(data.axes?.y)},
      provenance:pickedProvenance(data.provenance),
      issues:takeIssues(data.issues,extra),
      rawOutput,
      ...(data.geometry&&typeof data.geometry==='object'?{geometry:JSON.parse(JSON.stringify(data.geometry))}:{})
    };
  }
  function validResultBinding(result,request){
    if(!result||typeof result!=='object'||Array.isArray(result))return false;
    if(result.paperId!==request.paperId||result.fileHash!==request.fileHash||result.kind!==request.kind)return false;
    if(result.pageIndex!==request.pageIndex)return false;
    if(typeof result.analysisId!=='string'||!AID.test(result.analysisId))return false;
    if(request.kind==='chart'){if(!sameBox(request.bbox,result.bbox))return false;}
    else if(!(result.bbox==null||bboxShape(result.bbox)))return false;
    return true;
  }
  function normalizeResult(result,request){
    if(!validResultBinding(result,request))return null;
    const inputImage=copyInputImage(result.inputImage);
    if(!inputImage)return null;
    const data=result.data;
    if(!data||typeof data!=='object'||Array.isArray(data))return null;
    if(data.schema!=null&&data.schema!==(request.kind==='ocr'?'falsify.ocr-page.v1':'falsify.chart-data.v1'))return null;
    if(data.status!=='ready'&&data.status!=='partial'&&data.status!=='unavailable')return null;
    const normalized=request.kind==='ocr'?normalizeOcr(data):normalizeChart(data);
    if(!normalized)return null;
    normalized.status=data.status;
    return {
      paperId:result.paperId,
      fileHash:result.fileHash,
      analysisId:result.analysisId,
      kind:result.kind,
      pageIndex:result.pageIndex,
      bbox:result.bbox==null?null:result.bbox.map(Number),
      inputImage,
      data:normalized
    };
  }

  function create({host,getSource,getSession,getCapabilities,preparePaper,onResult,onChange,onBusyChange}={}){
    if(!host||typeof host.append!=='function'||typeof host.replaceChildren!=='function')throw new TypeError('스캔·그래프 화면 설정이 올바르지 않습니다.');
    if(typeof getSource!=='function'||typeof getSession!=='function'||typeof preparePaper!=='function')throw new TypeError('스캔·그래프 화면 설정이 올바르지 않습니다.');
    const doc=host.ownerDocument||root.document;
    if(!doc||typeof doc.createElement!=='function')throw new TypeError('스캔·그래프 화면 설정이 올바르지 않습니다.');
    const el=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    host.classList?.add('paper-enrichment');
    host.replaceChildren();

    const details=el('details','red-help paper-enrichment');
    const summary=el('summary',null,'스캔·그래프 읽기');
    const note=el('p','muted','글자 읽기는 선택한 쪽 전체를 읽습니다. 그래프는 드래그한 영역만 읽습니다. 열어도 자동으로 실행하지 않습니다.');
    const picker=el('div','blue-picker');
    const nav=el('div','blue-picker-nav');
    const prev=el('button','button secondary','이전 쪽');
    prev.type='button';
    const pageLabel=el('label',null,'쪽 ');
    const pageInput=el('input');
    pageInput.type='number';
    pageInput.min='1';
    pageInput.step='1';
    pageInput.value='1';
    pageInput.setAttribute('aria-label','쪽');
    pageLabel.append(pageInput);
    const next=el('button','button secondary','다음 쪽');
    next.type='button';
    const pageState=el('span');
    pageState.setAttribute('aria-live','polite');
    nav.append(prev,pageLabel,next,pageState);
    const stage=el('div','blue-picker-stage');
    const previewStatus=el('p','form-feedback','미리보기는 이 항목을 열면 불러옵니다.');
    previewStatus.setAttribute('role','status');
    const langLabel=el('label',null,'언어 ');
    const lang=el('select');
    lang.setAttribute('aria-label','언어');
    const optEn=el('option',null,'English');
    optEn.value='en';
    const optKo=el('option',null,'한국어');
    optKo.value='ko';
    lang.append(optEn,optKo);
    lang.value='en';
    langLabel.append(lang);
    const actions=el('div','button-row');
    const ocrBtn=el('button','button primary','글자 읽기 (OCR)');
    ocrBtn.type='button';
    const chartBtn=el('button','button secondary','그래프를 표로 읽기');
    chartBtn.type='button';
    const clearRegionBtn=el('button','text-button','선택 영역 지우기');
    clearRegionBtn.type='button';
    const cancelBtn=el('button','button secondary','읽기 취소');
    cancelBtn.type='button';
    cancelBtn.hidden=true;
    actions.append(ocrBtn,chartBtn,clearRegionBtn,cancelBtn);
    const progress=el('p','form-feedback','');
    progress.setAttribute('role','status');
    progress.setAttribute('aria-live','polite');
    const resultBox=el('section');
    resultBox.hidden=true;
    picker.append(nav,stage,previewStatus,langLabel,actions);
    details.append(summary,note,picker,progress,resultBox);
    const setup=el('a','text-button','OCR·그래프 도구 설치 안내');setup.href='guide.html#ocr-chart';setup.target='_blank';setup.rel='noopener';details.append(setup);
    host.append(details);

    let page=1,pages=null,languageNow='en',region=null,view=null,overlay=null;
    let previewSerial=0,epoch=0,attempt=0,flight=0,flightGen=0;
    let controller=null,held=null,displayed=null,errorCode=null,stopReason=null;
    let parentBusy=false;
    let reportedBusy=false;
    let calView=null;
    const cal={armed:null,xScale:'linear',yScale:'linear',points:{x1:null,x2:null,y1:null,y2:null},series:[],seq:1,bound:null};
    const bound={hash:undefined};

    function say(node,text,isError=false){node.textContent=text;node.classList.toggle('error',!!isError);}
    function emitChange(){if(typeof onChange==='function')onChange();}
    async function emitResult(payload){if(typeof onResult==='function')await onResult(payload);}
    function readSource(){
      try{
        const source=getSource();
        if(!source||typeof source!=='object'||!source.file||typeof source.fileHash!=='string')return null;
        return source;
      }catch{return null;}
    }
    function sourceToken(){
      const source=readSource();
      if(!source||!HEX.test(source.fileHash))return null;
      return {file:source.file,fileHash:source.fileHash,revision:typeof source.revision==='string'?source.revision:''};
    }
    function currentHash(){return sourceToken()?.fileHash||null;}
    function maxPage(){return pages||20000;}
    function syncDisabled(){
      const ownBusy=!!(flight||held);
      if(ownBusy!==reportedBusy){reportedBusy=ownBusy;if(typeof onBusyChange==='function')onBusyChange(ownBusy);}
      const locked=parentBusy||!!flight;
      ocrBtn.disabled=chartBtn.disabled=pageInput.disabled=lang.disabled=locked;
      prev.disabled=locked||page<=1;
      next.disabled=locked||page>=maxPage();
      clearRegionBtn.disabled=locked||!region;
      cancelBtn.hidden=!(flight||held);
      details.setAttribute('aria-busy',flight?'true':'false');
      if(!calView)return;
      for(const node of liveCalButtons())node.disabled=locked||(node===calView.curveBtn&&cal.series.length>=8);
    }
    function sayRegion(){
      if(region)say(previewStatus,'선택 영역 (PDF 점) '+region.bbox.map(n=>String(n)).join(', '));
      else if(!details.open)say(previewStatus,'미리보기는 이 항목을 열면 불러옵니다. 그래프는 영역을 드래그한 뒤 읽습니다.');
      else say(previewStatus,'선택 영역 없음. 그래프는 영역을 드래그한 뒤 읽습니다.');
    }
    function paintOverlay(box){
      if(!overlay||!view)return;
      if(!box){overlay.hidden=true;return;}
      overlay.hidden=false;
      overlay.style.left=(100*box[0]/view.width)+'%';
      overlay.style.top=(100*box[1]/view.height)+'%';
      overlay.style.width=(100*(box[2]-box[0])/view.width)+'%';
      overlay.style.height=(100*(box[3]-box[1])/view.height)+'%';
    }
    function dropPreview(){
      previewSerial++;
      view=null;
      overlay=null;
      pages=null;
      stage.replaceChildren();
      pageState.textContent='';
      sayRegion();
      syncDisabled();
    }
    function wipeOutput(){
      displayed=null;
      calView=null;
      resultBox.hidden=true;
      resultBox.replaceChildren();
    }
    function invalidate(reason){
      attempt++;
      stopReason=reason;
      const session=held?.session,id=held?.id;
      held=null;
      const current=controller;
      controller=null;
      current?.abort();
      if(id&&session&&typeof session.request==='function')void session.request(cancelPath(id),{}).catch(()=>{});
    }
    function reconcile(refreshPreview=true){
      const hash=currentHash();
      if(bound.hash===undefined){bound.hash=hash;return;}
      if(hash===bound.hash)return;
      const previous=bound.hash;
      bound.hash=hash;
      invalidate('switch');
      epoch++;
      region=null;
      if(previous&&hash)page=1;
      if(!hash)page=1;
      pageInput.value=String(page);
      dropPreview();
      wipeOutput();
      resetCalibration();
      if(previous&&hash)say(progress,'다른 파일의 결과는 붙이지 않습니다.');
      else if(!hash)say(progress,'PDF를 선택하세요.');
      else say(progress,'');
      if(hash&&details.open&&refreshPreview)void loadPreview();
      syncDisabled();
    }
    function live(token,src,mineAttempt){
      reconcile();
      if(token!==epoch||mineAttempt!==attempt)return false;
      const now=sourceToken();
      return !!now&&now.fileHash===src.fileHash&&now.revision===src.revision;
    }
    function point(event){
      const rect=view?.canvas?.getBoundingClientRect?.();
      if(!rect||!rect.width||!rect.height)return null;
      const x=Math.max(0,Math.min(view.width,(event.clientX-rect.left)/rect.width*view.width));
      const y=Math.max(0,Math.min(view.height,(event.clientY-rect.top)/rect.height*view.height));
      return {x:roundPt(x),y:roundPt(y)};
    }
    function commitPage(nextPage,fromUser){
      if(parentBusy||flight){pageInput.value=String(page);return;}
      if(!Number.isSafeInteger(nextPage)||nextPage<1||nextPage>20000||(pages&&nextPage>pages)){
        pageInput.value=String(page);
        say(previewStatus,'쪽 번호를 확인하세요.',true);
        return;
      }
      pageInput.value=String(nextPage);
      if(nextPage===page)return;
      page=nextPage;
      region=null;
      paintOverlay(null);
      resetCalibration();
      if(fromUser)emitChange();
      if(details.open)void loadPreview();
      else sayRegion();
      syncDisabled();
    }
    function validPreview(next,wanted){
        if(!next||!next.canvas||!finite(next.width)||!finite(next.height)||next.width<=0||next.height<=0||!Number.isSafeInteger(next.page)||!Number.isSafeInteger(next.pages)||next.pages<1){
          say(previewStatus,'PDF 미리보기를 열지 못했습니다.',true);return false;
        }
        if(next.page!==wanted){say(previewStatus,'쪽 번호를 확인하세요.',true);return false;}
      return true;
    }
    function previewReady(src){
      if(!details.open){sayRegion();return false;}
      if(!src){say(previewStatus,readSource()?'파일 해시를 확인하세요.':'PDF를 선택하세요.',!!readSource());return false;}
      return true;
    }
    async function loadPreview(){
      reconcile(false);
      const mine=++previewSerial;
      const src=sourceToken();
      const wanted=page;
      stage.replaceChildren();
      view=null;overlay=null;pages=null;
      syncDisabled();
      if(!previewReady(src))return;
      const previewFn=root.FalsifyBlueVisual&&root.FalsifyBlueVisual.previewBluePage;
      if(typeof previewFn!=='function'){say(previewStatus,'시각 미리보기가 없습니다.',true);return;}
      say(previewStatus,'미리보기를 준비 중입니다.');
      try{
        const next=await previewFn({file:src.file,fileHash:src.fileHash,page:wanted});
        if(mine!==previewSerial||!details.open||currentHash()!==src.fileHash||page!==wanted)return;
        if(!validPreview(next,wanted))return;
        view={canvas:next.canvas,width:next.width,height:next.height,page:next.page,pages:next.pages,fileHash:src.fileHash};
        pages=next.pages;
        pageState.textContent=next.page+' / '+next.pages+'쪽';
        const frame=el('div','blue-picker-frame');
        overlay=el('div','blue-picker-selection');
        overlay.hidden=true;
        frame.append(next.canvas,overlay);
        stage.append(frame);
        if(region&&region.page===page&&region.fileHash===src.fileHash)paintOverlay(region.bbox);
        sayRegion();
        syncDisabled();
      }catch(error){
        if(mine!==previewSerial)return;
        say(previewStatus,previewMessage(error),true);
      }
    }
    function download(name,mime,text){
      const blob=new root.Blob([text],{type:mime});
      const urlApi=root.URL;
      if(!urlApi||typeof urlApi.createObjectURL!=='function'){say(progress,'이 브라우저에서 파일을 저장하지 못했습니다.',true);errorCode='download';return;}
      const url=urlApi.createObjectURL(blob);
      const link=el('a');
      link.href=url;
      link.download=name;
      link.rel='noopener';
      link.click();
      setTimeout(()=>{try{urlApi.revokeObjectURL(url);}catch{}},1000);
    }
    function renderTable(parent,columns,rows){
      const table=el('table');
      if(columns.length){
        const head=el('thead'),row=el('tr');
        for(const column of columns)row.append(el('th',null,column));
        head.append(row);table.append(head);
      }
      const body=el('tbody');
      for(const cells of rows){
        const row=el('tr');
        for(const cell of cells)row.append(el('td',null,cell==null?'':String(cell)));
        body.append(row);
      }
      table.append(body);
      parent.append(table);
    }
    function markOcrCells(table,rows,cols,occupied,origin){
      for(const cell of table.cells){
        if(cell.row>=rows||cell.column>=cols)continue;
        const rs=Math.min(cell.rowSpan,rows-cell.row),cs=Math.min(cell.columnSpan,cols-cell.column);
        let clash=false;
        for(let i=0;i<rs&&!clash;i++)for(let j=0;j<cs;j++)if(occupied[cell.row+i][cell.column+j])clash=true;
        if(clash||occupied[cell.row][cell.column])continue;
        for(let i=0;i<rs;i++)for(let j=0;j<cs;j++)occupied[cell.row+i][cell.column+j]=true;
        origin[cell.row][cell.column]={text:cell.text,rs,cs};
      }
    }
    function renderOcrTable(parent,table){
      const rows=table.rows,cols=table.columns;
      if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(cols)||rows<1||cols<1||rows>200||cols>40||rows*cols>4000){
        parent.append(el('p','muted','표가 화면 한도를 넘어 칸 목록만 보존합니다. JSON에서 확인할 수 있습니다.'));
        return;
      }
      const occupied=Array.from({length:rows},()=>Array(cols).fill(false));
      const origin=Array.from({length:rows},()=>Array(cols).fill(null));
      markOcrCells(table,rows,cols,occupied,origin);
      const grid=el('table');
      for(let r=0;r<rows;r++){
        const tr=el('tr');
        for(let c=0;c<cols;c++){
          if(occupied[r][c]&&!origin[r][c])continue;
          const td=el('td',null,origin[r][c]?origin[r][c].text:'');
          if(origin[r][c]?.rs>1)td.rowSpan=origin[r][c].rs;
          if(origin[r][c]?.cs>1)td.colSpan=origin[r][c].cs;
          tr.append(td);
        }
        grid.append(tr);
      }
      parent.append(grid);
    }
    function chartCsv(payload){
        const lines=[];
        if(payload.data.columns.length)lines.push(csvLine(payload.data.columns));
        for(const row of payload.data.rows)lines.push(csvLine(row));
        return '\uFEFF'+lines.join('\n');
          }
    function appendOcrTableCsv(payload,lines){
      for(const table of payload.data.tables)for(const cell of table.cells){
        const box=cell.bbox||[];
        lines.push(csvLine(['cell',cell.text,cell.text,cell.confidence??'',cell.row,cell.column,cell.rowSpan,cell.columnSpan,box[0]??'',box[1]??'',box[2]??'',box[3]??'']));
      }
    }
    function csvFor(payload){
      if(payload.kind==='chart')return chartCsv(payload);
      const lines=[csvLine(['record','rawText','text','confidence','row','column','rowSpan','columnSpan','x0','y0','x1','y1'])];
      for(const line of payload.data.lines){
        const box=line.bbox||[];
        lines.push(csvLine(['line',line.text,line.displayText||line.text,line.confidence,'' ,'' ,'' ,'' ,box[0]??'',box[1]??'',box[2]??'',box[3]??'']));
      }
      appendOcrTableCsv(payload,lines);
      return '\uFEFF'+lines.join('\n');
    }
    function parseValue(raw){
      const text=String(raw??'').trim();
      if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text))return null;
      const n=Number(text);
      return finite(n)?n:null;
    }
    function cleanName(value){
      if(typeof value!=='string')return '';
      const text=value.replace(/[\u0000-\u001f]/g,'').trim();
      return text.length>160?text.slice(0,160):text;
    }
    function liveCalButtons(){
      if(!calView)return [];
      const nodes=[calView.xScale,calView.yScale,calView.curveBtn,calView.rereadBtn];
      for(const key of ['x1','x2','y1','y2'])nodes.push(calView.values[key],calView.arms[key]);
      for(const row of calView.seriesBox.children)for(const child of row.children||[])if(child.tagName==='BUTTON'||child.tagName==='INPUT')nodes.push(child);
      return nodes;
    }
    function showArmed(){
      if(!calView)return;
      for(const key of ['x1','x2','y1','y2','curve'])calView.arms[key].setAttribute('aria-pressed',cal.armed===key?'true':'false');
    }
    function showPixel(key){
      if(!calView)return;
      const point=cal.points[key];
      calView.pixels[key].textContent=point&&finite(point.pixel)?String(point.pixel):'미지정';
    }
    function rebuildSeries(){
      if(!calView)return;
      calView.seriesBox.replaceChildren();
      for(const [index,series] of cal.series.entries()){
        const row=el('div','button-row');
        const name=el('input');
        name.type='text';
        name.setAttribute('aria-label','곡선 '+(index+1)+' 이름');
        name.value=series.name??'';
        name.addEventListener('input',()=>{series.name=name.value;});
        const swatch=el('span',null,series.color);
        swatch.setAttribute('data-curve-id',series.id);
        const remove=el('button','text-button','빼기');
        remove.type='button';
        remove.setAttribute('data-curve-id',series.id);
        remove.addEventListener('click',()=>{
          if(parentBusy||flight)return;
          cal.series=cal.series.filter(item=>item.id!==series.id);
          rebuildSeries();
        });
        row.append(name,swatch,remove);
        calView.seriesBox.append(row);
      }
      if(cal.series.length>=8&&cal.armed==='curve'){cal.armed=null;showArmed();}
      syncDisabled();
    }
    function resetCalibration(){
      cal.armed=null;
      cal.xScale='linear';
      cal.yScale='linear';
      cal.points={x1:null,x2:null,y1:null,y2:null};
      cal.series=[];
      cal.seq=1;
      cal.bound=null;
      if(!calView)return;
      calView.xScale.value='linear';
      calView.yScale.value='linear';
      for(const key of ['x1','x2','y1','y2']){
        calView.values[key].value='';
        calView.pixels[key].textContent='미지정';
      }
      showArmed();
      rebuildSeries();
    }
    function rememberValue(key,raw){
      const value=parseValue(raw);
      const pixel=cal.points[key]&&finite(cal.points[key].pixel)?cal.points[key].pixel:null;
      if(pixel==null&&value==null){cal.points[key]=null;return;}
      cal.points[key]={pixel,value};
    }
    function rememberBinding(payload){
      cal.bound={fileHash:payload.fileHash,pageIndex:payload.pageIndex,bbox:payload.bbox.map(Number),imageSha256:payload.inputImage.sha256};
    }
    function cropMatches(payload){
      const src=sourceToken();
      if(!payload||payload.kind!=='chart'||!src)return false;
      if(payload.fileHash!==src.fileHash||payload.pageIndex!==page-1)return false;
      if(!region||region.page!==page||region.fileHash!==src.fileHash)return false;
      return sameBox(region.bbox,payload.bbox);
    }
    function cropPixel(pt,payload){
      const box=payload.bbox,img=payload.inputImage;
      const spanX=box[2]-box[0],spanY=box[3]-box[1];
      if(!(spanX>0)||!(spanY>0))return null;
      const x=(pt.x-box[0])/spanX*img.width;
      const y=(pt.y-box[1])/spanY*img.height;
      const slack=0.05;
      if(x<-slack||y<-slack||x>img.width+slack||y>img.height+slack)return null;
      return {x:roundPt(Math.max(0,Math.min(img.width,x))),y:roundPt(Math.max(0,Math.min(img.height,y)))};
    }
    function samplePixel(event,rect,width,height){
      const x=Math.floor((event.clientX-rect.left)/rect.width*width);
      const y=Math.floor((event.clientY-rect.top)/rect.height*height);
      if(x<0||y<0||x>=width||y>=height)return null;
      return {x,y};
    }
    function sampleCanvas(canvas){
      const width=canvas.width,height=canvas.height;
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)return null;
      const ctx=canvas.getContext('2d');
      if(!ctx||typeof ctx.getImageData!=='function')return null;
      return {width,height,ctx};
    }
    function sampleColor(event){
      const canvas=view?.canvas;
      const rect=canvas?.getBoundingClientRect?.();
      if(!canvas||!rect||!(rect.width>0)||!(rect.height>0)||typeof canvas.getContext!=='function')return null;
      const sample=sampleCanvas(canvas);if(!sample)return null;
      const {width,height,ctx}=sample;
      const pixel=samplePixel(event,rect,width,height);if(!pixel)return null;
      const {x,y}=pixel;
      let data;
      try{data=ctx.getImageData(x,y,1,1)?.data;}catch{return null;}
      if(!data||data.length<3)return null;
      const bytes=[data[0],data[1],data[2]].map(n=>Number.isInteger(n)&&n>=0&&n<=255?n.toString(16).padStart(2,'0'):null);
      if(bytes.some(n=>!n))return null;
      return '#'+bytes.join('');
    }
    function arm(which){
      if(parentBusy||flight)return;
      if(which==='curve'&&cal.series.length>=8){say(progress,'곡선은 8개까지입니다.',true);return;}
      cal.armed=cal.armed===which?null:which;
      showArmed();
      if(!cal.armed)return;
      say(progress,which==='curve'?'원본 미리보기에서 곡선 색을 집으세요.':which.toUpperCase()+' 위치를 원본 미리보기에서 집으세요.');
    }
    function commitPick(event){
      const payload=displayed;
      const pt=point(event);
      if(!pt||!view){say(progress,'미리보기를 연 뒤 원본에서 집으세요.',true);return;}
      if(!cropMatches(payload)){cal.armed=null;showArmed();say(progress,'다른 영역이나 파일의 이미지로는 보정하지 않습니다.',true);return;}
      const px=cropPixel(pt,payload);
      if(!px){say(progress,'집은 점이 선택한 그래프 영역 밖입니다.',true);return;}
      if(cal.armed==='curve'){
        if(cal.series.length>=8){cal.armed=null;showArmed();say(progress,'곡선은 8개까지입니다.',true);return;}
        const color=sampleColor(event);
        if(!color){say(progress,'미리보기 캔버스에서 색을 읽지 못했습니다.',true);return;}
        cal.series.push({id:'c'+cal.seq,color,name:'곡선 '+(cal.series.length+1)});
        cal.seq+=1;
        rememberBinding(payload);
        cal.armed=null;
        showArmed();
        rebuildSeries();
        return;
      }
      const key=cal.armed;
      if(key!=='x1'&&key!=='x2'&&key!=='y1'&&key!=='y2')return;
      const previous=cal.points[key];
      cal.points[key]={pixel:key[0]==='x'?px.x:px.y,value:previous&&finite(previous.value)?previous.value:null};
      rememberBinding(payload);
      cal.armed=null;
      showPixel(key);
      showArmed();
    }
    function axisIncomplete(a,b){
      if(!a||!b||!finite(a.pixel)||!finite(b.pixel)||!finite(a.value)||!finite(b.value))return {error:'X1, X2, Y1, Y2 위치와 값을 모두 지정하세요.'};
      return null;
    }
    function axisPair(a,b,scale,extent){
      const incomplete=axisIncomplete(a,b);if(incomplete)return incomplete;
      if(a.pixel<0||b.pixel<0||a.pixel>extent||b.pixel>extent)return {error:'집은 점이 선택한 그래프 영역 밖입니다.'};
      if(a.pixel===b.pixel||a.value===b.value)return {error:'같은 축의 두 점과 값은 달라야 합니다.'};
      if(scale==='log'&&(a.value<=0||b.value<=0))return {error:'로그 눈금에는 0보다 큰 값이 필요합니다.'};
      return {points:[{pixel:a.pixel,value:a.value},{pixel:b.pixel,value:b.value}]};
    }
    function chartSeries(){
      const series=[];
      const seen=new Set();
      for(const item of cal.series){
        if(!item||typeof item.id!=='string'||!item.id||item.id.length>80||seen.has(item.id)||/[\u0000-\u001f]/.test(item.id)||!/^#[0-9a-f]{6}$/.test(item.color))return {error:'곡선 색을 읽지 못했습니다.'};
        seen.add(item.id);
        const next={id:item.id,color:item.color};
        const name=cleanName(item.name);
        if(name)next.name=name;
        series.push(next);
      }
      return {series};
    }
    function chartBindingError(payload,src,box,boundOk){
      if(!payload||payload.kind!=='chart'||!src||payload.fileHash!==src.fileHash||payload.pageIndex!==page-1||!box||!sameBox(box,payload.bbox)||!boundOk){
        return {error:'다른 영역이나 파일의 이미지로는 보정하지 않습니다.'};
      }
      return null;
    }
    function calibrationBound(payload){return !cal.bound||(cal.bound.imageSha256===payload?.inputImage?.sha256&&cal.bound.fileHash===payload?.fileHash&&cal.bound.pageIndex===payload?.pageIndex&&sameBox(cal.bound.bbox,payload?.bbox));}
    function buildChartOptions(){
      const src=sourceToken();
      const payload=displayed;
      const box=region&&src&&region.page===page&&region.fileHash===src.fileHash?region.bbox:null;
      const boundOk=calibrationBound(payload);
      const bindingError=chartBindingError(payload,src,box,boundOk);if(bindingError)return bindingError;
      const xScale=cal.xScale==='log'?'log':'linear';
      const yScale=cal.yScale==='log'?'log':'linear';
      const x=axisPair(cal.points.x1,cal.points.x2,xScale,payload.inputImage.width);
      if(x.error)return x;
      const y=axisPair(cal.points.y1,cal.points.y2,yScale,payload.inputImage.height);
      if(y.error)return y;
      if(!cal.series.length)return {error:'곡선을 하나 이상 지정하세요.'};
      if(cal.series.length>8)return {error:'곡선은 8개까지입니다.'};
      const builtSeries=chartSeries();if(builtSeries.error)return builtSeries;
      const series=builtSeries.series;
      return {options:{imageSha256:payload.inputImage.sha256,calibration:{x:{scale:xScale,points:x.points},y:{scale:yScale,points:y.points}},series}};
    }
    function reread(){
      if(parentBusy||flight)return;
      reconcile();
      const built=buildChartOptions();
      if(!built.options){say(progress,built.error,true);errorCode='stale';return;}
      void start('chart',built.options);
    }
    function renderCalibration(parent){
      const box=el('details','red-help');
      box.open=false;
      box.append(el('summary',null,'축·곡선 지정'));
      box.append(el('p','muted','원본에서 축의 양끝 눈금과 곡선 색을 고르세요. 고른 눈금 사이의 좌표를 읽습니다.'));
      const xScale=el('select');
      xScale.setAttribute('aria-label','가로축 눈금');
      const yScale=el('select');
      yScale.setAttribute('aria-label','세로축 눈금');
      for(const select of [xScale,yScale]){
        const linear=el('option',null,'선형');linear.value='linear';
        const log=el('option',null,'로그');log.value='log';
        select.append(linear,log);
      }
      xScale.value=cal.xScale==='log'?'log':'linear';
      yScale.value=cal.yScale==='log'?'log':'linear';
      xScale.addEventListener('change',()=>{cal.xScale=xScale.value==='log'?'log':'linear';xScale.value=cal.xScale;});
      yScale.addEventListener('change',()=>{cal.yScale=yScale.value==='log'?'log':'linear';yScale.value=cal.yScale;});
      const xLabel=el('label',null,'가로축 눈금 ');
      xLabel.append(xScale);
      const yLabel=el('label',null,'세로축 눈금 ');
      yLabel.append(yScale);
      const values={},pixels={},arms={};
      const grid=el('div');
      for(const key of ['x1','x2','y1','y2']){
        const row=el('div','button-row');
        const input=el('input');
        input.type='number';
        input.step='any';
        input.setAttribute('aria-label',key.toUpperCase()+' 값');
        input.value=cal.points[key]&&finite(cal.points[key].value)?String(cal.points[key].value):'';
        input.addEventListener('input',()=>rememberValue(key,input.value));
        const pickBtn=el('button','button secondary',key.toUpperCase()+' 집기');
        pickBtn.type='button';
        pickBtn.addEventListener('click',()=>arm(key));
        const pixel=el('span',null,'미지정');
        pixel.setAttribute('data-axis',key);
        row.append(input,pickBtn,pixel);
        grid.append(row);
        values[key]=input;
        pixels[key]=pixel;
        arms[key]=pickBtn;
      }
      const curveBtn=el('button','button secondary','곡선 추가');
      curveBtn.type='button';
      curveBtn.addEventListener('click',()=>arm('curve'));
      arms.curve=curveBtn;
      const seriesBox=el('div');
      const rereadBtn=el('button','button primary','보정해서 다시 읽기');
      rereadBtn.type='button';
      rereadBtn.addEventListener('click',()=>{reread();});
      box.append(xLabel,yLabel,grid,curveBtn,seriesBox,rereadBtn);
      parent.append(box);
      calView={xScale,yScale,values,pixels,arms,seriesBox,curveBtn,rereadBtn};
      for(const key of ['x1','x2','y1','y2'])showPixel(key);
      showArmed();
      rebuildSeries();
    }
    function paintOcr(payload){
        const raw=el('pre',null,payload.data.lines.map(line=>line.displayText||line.text).join('\n'));
        raw.style.whiteSpace='pre-wrap';
        raw.style.overflowWrap='anywhere';
        raw.style.maxHeight='320px';
        raw.style.overflow='auto';
        if(payload.data.tables.length){const textDetails=el('details','red-help');textDetails.append(el('summary',null,'전체 판독문'),raw);resultBox.append(textDetails);}
        else resultBox.append(raw);
        if(payload.data.lines.some(line=>line.displayText&&line.displayText!==line.text)){
          const original=el('details','red-help');original.append(el('summary',null,'띄어쓰기 전 판독문'),el('pre',null,payload.data.lines.map(line=>line.text).join('\n')));resultBox.append(original);
        }
        if(!payload.data.lines.length&&!payload.data.tables.length)resultBox.append(el('p','muted','읽은 글자가 없습니다.'));
        const conf=payload.data.lines.filter(line=>line.confidence!=null);
        if(conf.length){
          const more=el('details','red-help');
          more.append(el('summary',null,'보고된 확신'));
          const list=el('ul');
          for(const line of conf)list.append(el('li',null,(line.id?line.id+' · ':'')+String(line.confidence)));
          more.append(list);
          resultBox.append(more);
        }
        for(const table of payload.data.tables)renderOcrTable(resultBox,table);
    }
    function paintChart(payload,sourceDetails){
        if(payload.data.title)resultBox.append(el('p',null,'읽은 제목: '+payload.data.title));
        const axisText=side=>{
          const item=payload.data.axes[side];
          const scale=item.scale==='linear'?'선형':item.scale==='log'?'로그':item.scale==='multiple'?'다중 축':'미확인';
          return (side==='x'?'가로축':'세로축')+' '+(item.label||'이름 없음')+' · 눈금 '+scale+(item.unit?' · 단위 '+item.unit:'');
        };
        sourceDetails.append(el('p','muted',axisText('x')+' / '+axisText('y')));
        if(payload.data.columns.length||payload.data.rows.length){
          const coordinates=el('details','red-help');
          coordinates.append(el('summary',null,'좌표 '+payload.data.rows.length+'개 보기'));
          const scroll=el('div');
          scroll.style.maxHeight='320px';
          scroll.style.overflow='auto';
          renderTable(scroll,payload.data.columns,payload.data.rows);
          coordinates.append(scroll);
          resultBox.append(coordinates);
        }else resultBox.append(el('p','muted','축·곡선 지정에서 눈금과 곡선 색을 고르면 계속 읽을 수 있습니다.'));
        renderCalibration(resultBox);
        if(payload.data.numericCells.length){
          const more=el('details','red-help');
          more.append(el('summary',null,'추정 숫자'));
          const list=el('ul');
          for(const cell of payload.data.numericCells)list.append(el('li',null,(cell.row+1)+'행 '+(cell.column+1)+'열 · 원문 '+cell.raw+' · 추정 '+String(cell.value)+(cell.unit?' '+cell.unit:'')+' · '+(cell.origin||'origin 없음')));
          more.append(list);
          resultBox.append(more);
        }
        if(payload.data.rawOutput){
          const more=el('details','red-help');
          more.append(el('summary',null,'모델 원문'));
          const raw=el('pre',null,payload.data.rawOutput);
          raw.style.whiteSpace='pre-wrap';
          more.append(raw);
          resultBox.append(more);
        }
    }
    function paint(payload){
      const dropCal=payload.kind!=='chart'||(cal.bound&&(cal.bound.imageSha256!==payload.inputImage.sha256||cal.bound.fileHash!==payload.fileHash||cal.bound.pageIndex!==payload.pageIndex||!sameBox(cal.bound.bbox,payload.bbox)));
      calView=null;
      if(dropCal)resetCalibration();
      resultBox.replaceChildren();
      resultBox.hidden=false;
      const head=el('h3',null,(payload.pageIndex+1)+'쪽 · '+(payload.kind==='ocr'?'글자 읽기':'그래프')+(payload.data.status==='partial'?' · 일부만 읽힘':''));
      const derivation=el('p','muted',DERIVATION);
      const provenance=el('p','muted',provenanceLine(payload.data.provenance)+' · 입력 이미지 '+payload.inputImage.width+'×'+payload.inputImage.height+' px · '+payload.inputImage.dpi+' dpi');
      const hash=el('code',null,payload.inputImage.sha256);
      const sourceDetails=el('details','red-help');sourceDetails.append(el('summary',null,'출처·모델'),derivation,provenance,hash);
      resultBox.append(head,el('p','muted',payload.kind==='ocr'?'이미지에서 읽은 글자입니다. 위 원본과 대조할 수 있습니다.':'그래프에서 읽은 추정값입니다. 위 원본과 대조할 수 있습니다.'));
      if(payload.kind==='ocr')paintOcr(payload);else paintChart(payload,sourceDetails);
      const row=el('div','button-row');
      const jsonBtn=el('button','button secondary','JSON 다운로드');
      jsonBtn.type='button';
      const csvBtn=el('button','button secondary','CSV 다운로드');
      csvBtn.type='button';
      jsonBtn.addEventListener('click',()=>download('falsify-paper-'+payload.kind+'.json','application/json;charset=utf-8',JSON.stringify(payload,null,2)));
      csvBtn.addEventListener('click',()=>download('falsify-paper-'+payload.kind+'.csv','text/csv;charset=utf-8',csvFor(payload)));
      row.append(jsonBtn,csvBtn);
      const issues=el('details','red-help');
      issues.open=false;
      issues.append(el('summary',null,'자세한 한계'));
      const list=el('ul');
      const items=payload.data.issues.length?payload.data.issues:['엔진이 남긴 항목이 없습니다.'];
      for(const item of items)list.append(el('li',null,item));
      issues.append(list);
      resultBox.append(row,sourceDetails,issues);
    }
    async function apply(token,src,mineAttempt,request,result){
      if(!live(token,src,mineAttempt))return false;
      const payload=normalizeResult(result,request);
      if(!payload||payload.fileHash!==currentHash()){say(progress,'결과를 확인하지 못했습니다. 이전 결과는 그대로입니다.',true);errorCode='bad-result';return false;}
      if(payload.data.status==='unavailable'){say(progress,'이 쪽은 읽지 못했습니다. 이전 결과는 그대로입니다.',true);errorCode='unavailable';return false;}
      freeze(payload);
      displayed=payload;
      errorCode=null;
      paint(payload);
      say(progress,payload.data.status==='partial'?'일부만 읽어 표시했습니다.':'결과를 표시했습니다.');
      if(live(token,src,mineAttempt)&&payload.fileHash===currentHash())await emitResult(payload);
      return true;
    }
    function validRunningPoll(data,polls){
          if(ID.test(data.id)&&data.id!==held.id){held=null;say(progress,'작업 식별자가 달라 잇지 않았습니다.',true);errorCode='poll';return false;}

          if(polls>=MAX_POLLS){say(progress,'아직 읽는 중입니다. 다시 누르면 같은 작업을 조회합니다.');errorCode='poll';return false;}
      return true;
    }
    function pollRejected(error){if(classify(error)!=='rejected')return false;held=null;say(progress,'결과를 확인하지 못했습니다. 이전 결과는 그대로입니다.',true);errorCode='poll';return true;}
    function pollRetriesExhausted(failures){if(failures<GET_TRIES)return false;say(progress,'진행을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 다시 누르면 같은 작업을 조회합니다.',true);errorCode='poll';return true;}
    function cancelStalePoll(data){
          const job=held;
          held=null;
          if(data?.state==='running'&&job&&ID.test(job.id))void job.session.request(cancelPath(job.id),{}).catch(()=>{});
    }
    async function watch(token,src,mineAttempt,signal){
      let failures=0,polls=0;
      while(held&&live(token,src,mineAttempt)){
        let data;
        try{data=await held.session.request(jobPath(held.id),null,{signal});failures=0;}
        catch(error){
          if(signal.aborted||!live(token,src,mineAttempt))return;
          if(pollRejected(error))return;
          failures++;
          if(pollRetriesExhausted(failures))return;
          await pause(POLL_MS,signal);
          continue;
        }
        if(!live(token,src,mineAttempt)){
          cancelStalePoll(data);
          return;
        }
        if(data?.progress!=null)say(progress,progressText(data.progress));
        if(data?.state==='running'){
          if(!validRunningPoll(data,polls+1))return;
          polls++;
          await pause(POLL_MS,signal);
          continue;
        }
        const request=held.body,session=held.session,id=held.id;
        held=null;
        if(data?.state==='completed'){await apply(token,src,mineAttempt,request,data.result);return;}
        if(data?.state==='cancelled'){say(progress,'읽기를 취소했습니다.');errorCode='cancelled';return;}
        say(progress,failureText(data?.error),true);errorCode='failed';
        void session;void id;
      }
    }
    async function resume(src){
      const mine=++flightGen;
      flight=mine;
      const token=epoch,mineAttempt=attempt;
      controller=new root.AbortController();
      const signal=controller.signal;
      stopReason=null;
      say(progress,'앞서 접수한 읽기를 조회합니다. 새 요청은 보내지 않습니다.');
      syncDisabled();
      try{await watch(token,src,mineAttempt,signal);}
      catch(error){
        if(error?.name!=='AbortError'&&live(token,src,mineAttempt)){say(progress,'진행을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.',true);errorCode='poll';}
      }finally{
        if(flight===mine){flight=0;controller=null;}
        syncDisabled();
      }
    }
    function freshChartOptions(src,chartOptions){
        const boxNow=region&&region.page===page&&region.fileHash===src.fileHash?region.bbox:null;
        const payload=displayed;
        const fresh=!!(payload&&payload.kind==='chart'&&payload.fileHash===src.fileHash&&payload.pageIndex===page-1&&boxNow&&sameBox(boxNow,payload.bbox)&&chartOptions&&chartOptions.imageSha256===payload.inputImage.sha256);
        if(!fresh){say(progress,'다른 영역이나 파일의 이미지로는 보정하지 않습니다.',true);errorCode='stale';return false;}
      return true;
    }
    function availableSession(session){
      if(!session||typeof session.request!=='function'){say(progress,'PC 연결 후 다시 읽으세요.',true);errorCode='unavailable';return false;}
      if(typeof getCapabilities==='function'&&!getCapabilities()?.paperEnrichment?.supported){say(progress,'PC 연결 프로그램을 최신 버전으로 업데이트하세요.',true);errorCode='unavailable';return false;}
      return true;
    }
    function handlePostFailure(error){
          const why=classify(error);
          if(why==='path'){held=null;say(progress,'이 화면의 연결 모듈이 스캔·그래프 경로를 아직 허용하지 않습니다.',true);errorCode='path';return;}
          if(why==='lost'){say(progress,'연결이 끊겼습니다. 다시 누르면 같은 작업의 결과를 확인합니다.',true);errorCode='lost';return;}
          held=null;
          say(progress,'요청이 접수되지 않았습니다. 이전 결과는 그대로입니다.',true);errorCode='rejected';
          return;
    }
    function handlePostedTerminal(posted){
        if(posted?.state==='cancelled'){held=null;say(progress,'읽기를 취소했습니다.');errorCode='cancelled';return;}
        if(posted?.state==='failed'){held=null;say(progress,failureText(posted.error),true);errorCode='failed';return;}
        say(progress,'접수 상태를 확인하지 못했습니다. 다시 누르면 같은 작업을 조회합니다.',true);errorCode='lost';
    }
    function startSourceReady(src){if(src)return true;say(progress,readSource()?'파일 해시를 확인하세요.':'PDF를 선택하세요.',!!readSource());errorCode='waiting';return false;}
    function resumableJob(src){return held&&held.fileHash===src.fileHash&&held.revision===src.revision;}
    function jobRegion(kind,src){return kind==='chart'?(region&&region.page===page&&region.fileHash===src.fileHash?region.bbox:null):null;}
    function preparedForSource(prepared,src){if(prepared&&prepared.fileHash===src.fileHash&&paperIdOk(prepared.paperId))return true;say(progress,'원본 파일이 바뀌어 보내지 않았습니다. 이전 결과는 그대로입니다.',true);errorCode='stale';return false;}
    function ignorePostFailure(signal,token,src,mineAttempt){return signal.aborted||!live(token,src,mineAttempt)||stopReason;}
    function cancelStalePost(posted,session){
          if(posted&&posted.state==='running'&&ID.test(posted.id))void session.request(cancelPath(posted.id),{}).catch(()=>{});
    }
    function finishFlight(mine){if(flight===mine){flight=0;controller=null;}syncDisabled();}
    function prepareJobSwitch(src,chartOptions){
      if(chartOptions!==undefined){
        if(!freshChartOptions(src,chartOptions))return 'invalid';
        if(held)invalidate('switch');
      }else if(resumableJob(src))return 'resume';
      return 'continue';
    }
    function jobRegionReady(kind,box){if(kind!=='chart'||box)return true;say(progress,'그래프는 미리보기에서 영역을 드래그한 뒤 읽습니다.',true);errorCode='region';return false;}
    function reportPrepareFailure(token,src,mineAttempt){if(live(token,src,mineAttempt)){say(progress,'논문을 준비하지 못했습니다. 이전 결과는 그대로입니다.',true);errorCode='prepare';}}
    function ignoreStartFailure(error,token,src,mineAttempt){return error?.name==='AbortError'||!live(token,src,mineAttempt)||stopReason;}
    function isRunningPost(posted){return posted?.state==='running'&&ID.test(posted.id);}
    function prepareStart(kind,chartOptions){
      if(parentBusy||flight)return null;
      reconcile();
      const src=sourceToken();
      if(!startSourceReady(src))return null;
      const preparation=prepareJobSwitch(src,chartOptions);
      if(preparation==='invalid')return null;
      if(preparation==='resume')return {src,resume:true};
      if(held)invalidate('switch');
      const box=jobRegion(kind,src);
      if(!jobRegionReady(kind,box))return null;
      const session=getSession();
      if(!availableSession(session))return null;
      return {src,box,session};
    }
    function acceptPostReceipt(posted,session,src,request,token,mineAttempt){
      if(!live(token,src,mineAttempt)){cancelStalePost(posted,session);return 'stale';}
      if(posted?.progress!=null)say(progress,progressText(posted.progress));
      if(posted?.state==='completed'){held=null;return 'completed';}
      if(isRunningPost(posted)){
        held={id:posted.id,session,fileHash:src.fileHash,revision:src.revision,body:request};
        return 'running';
      }
      handlePostedTerminal(posted);
      return 'terminal';
    }
    function reportPostFailure(error,signal,token,src,mineAttempt){if(!ignorePostFailure(signal,token,src,mineAttempt))handlePostFailure(error);}
    async function start(kind, chartOptions){
      const preflight=prepareStart(kind,chartOptions);
      if(!preflight)return;
      const {src,box,session}=preflight;
      if(preflight.resume){await resume(src);return;}
      const mine=++flightGen;
      flight=mine;
      const token=epoch,mineAttempt=attempt;
      controller=new root.AbortController();
      const signal=controller.signal;
      stopReason=null;
      const requestId=root.crypto.randomUUID().replace(/-/g,'');
      const request={requestId,paperId:null,fileHash:src.fileHash,kind,pageIndex:page-1,bbox:box?box.slice():null,language:languageNow};
      if(chartOptions!==undefined)request.chartOptions=chartOptions;
      say(progress,'읽는 중입니다.');
      errorCode=null;
      syncDisabled();
      try{
        let prepared;
        try{prepared=await preparePaper();}
        catch{reportPrepareFailure(token,src,mineAttempt);return;}
        if(!live(token,src,mineAttempt))return;
        if(!preparedForSource(prepared,src))return;
        request.paperId=prepared.paperId;
        held={id:requestId,session,fileHash:src.fileHash,revision:src.revision,body:request};
        let posted;
        try{posted=await session.request(JOBS,request,{signal});}
        catch(error){
          reportPostFailure(error,signal,token,src,mineAttempt);
          return;
        }
        const receipt=acceptPostReceipt(posted,session,src,request,token,mineAttempt);
        if(receipt==='completed'){await apply(token,src,mineAttempt,request,posted.result);return;}
        if(receipt==='running'){await watch(token,src,mineAttempt,signal);return;}

      }catch(error){
        if(ignoreStartFailure(error,token,src,mineAttempt))return;
        say(progress,'읽기에 실패했습니다. 이전 결과는 그대로입니다.',true);errorCode='failed';
      }finally{
        finishFlight(mine);
      }
    }
    function userCancel(){
      if(!flight&&!held)return;
      invalidate('cancel');
      say(progress,'읽기를 취소했습니다.');
      errorCode='cancelled';
      syncDisabled();
    }

    details.addEventListener('toggle',()=>{if(!details.open){dropPreview();return;}void loadPreview();});
    prev.addEventListener('click',()=>{if(!prev.disabled)commitPage(page-1,true);});
    next.addEventListener('click',()=>{if(!next.disabled)commitPage(page+1,true);});
    pageInput.addEventListener('change',()=>{commitPage(Number(pageInput.value),true);});
    lang.addEventListener('change',()=>{
      if(parentBusy||flight){lang.value=languageNow;return;}
      const nextLang=lang.value==='ko'?'ko':'en';
      lang.value=nextLang;
      if(nextLang===languageNow)return;
      languageNow=nextLang;
      emitChange();
    });
    ocrBtn.addEventListener('click',()=>{void start('ocr');});
    chartBtn.addEventListener('click',()=>{void start('chart');});
    clearRegionBtn.addEventListener('click',()=>{
      if(clearRegionBtn.disabled||!region)return;
      region=null;paintOverlay(null);sayRegion();resetCalibration();emitChange();syncDisabled();
    });
    cancelBtn.addEventListener('click',userCancel);
    let drag=null,pickPress=null,regionBefore=null;
    stage.addEventListener('pointerdown',event=>{
      if(parentBusy||flight||!view||event.button)return;
      const startPt=point(event);if(!startPt)return;
      if(cal.armed){
        pickPress={x:startPt.x,y:startPt.y,id:event.pointerId};
        stage.setPointerCapture?.(event.pointerId);
        return;
      }
      const had=!!region;
      regionBefore=region?region.bbox.slice():null;
      region=null;paintOverlay(null);sayRegion();
      drag={...startPt,id:event.pointerId};
      if(had)emitChange();
      stage.setPointerCapture?.(event.pointerId);
    });
    stage.addEventListener('pointermove',event=>{
      if(!view||!drag||event.pointerId!==drag.id)return;
      const current=point(event);
      if(!current)return;
      paintOverlay([Math.min(drag.x,current.x),Math.min(drag.y,current.y),Math.max(drag.x,current.x),Math.max(drag.y,current.y)]);
    });
    stage.addEventListener('pointerup',event=>{
      if(pickPress&&event.pointerId===pickPress.id){
        const origin=pickPress;
        pickPress=null;
        const current=point(event);
        if(!current||Math.hypot(current.x-origin.x,current.y-origin.y)>1.5){say(progress,'점이 움직였습니다. 다시 집으세요.',true);return;}
        commitPick(event);
        return;
      }
      if(!view||!drag||event.pointerId!==drag.id)return;
      const current=point(event);
      const box=current?[roundPt(Math.min(drag.x,current.x)),roundPt(Math.min(drag.y,current.y)),roundPt(Math.max(drag.x,current.x)),roundPt(Math.max(drag.y,current.y))]:null;
      drag=null;
      if(!box||box[2]-box[0]<1||box[3]-box[1]<1){paintOverlay(null);resetCalibration();say(previewStatus,'영역이 너무 작습니다. 다시 드래그하세요.',true);return;}
      region={page:view.page,fileHash:view.fileHash,bbox:box};
      paintOverlay(box);sayRegion();
      if(!regionBefore||!sameBox(regionBefore,box))resetCalibration();
      emitChange();syncDisabled();
    });
    stage.addEventListener('pointercancel',()=>{drag=null;pickPress=null;paintOverlay(region&&region.bbox);if(!region)resetCalibration();sayRegion();});

    function clear(){
      invalidate('clear');
      epoch++;
      region=null;
      page=1;pages=null;languageNow='en';
      pageInput.value='1';
      lang.value='en';
      details.open=false;
      dropPreview();
      wipeOutput();
      resetCalibration();
      say(progress,'');
      errorCode=null;
      parentBusy=false;
      bound.hash=currentHash();
      syncDisabled();
    }
    function setBusy(value){
      reconcile();
      parentBusy=!!value;
      syncDisabled();
    }
    function snapshot(){
      reconcile();
      const src=sourceToken();
      return Object.freeze({
        schema:'falsify.paper-enrichment-ui.v1',
        open:!!details.open,
        busy:parentBusy,
        working:!!flight,
        fileHash:src?src.fileHash:null,
        revision:src?src.revision:null,
        page,pages,language:languageNow,
        bbox:region?Object.freeze(region.bbox.slice()):null,
        jobId:held?held.id:null,
        jobKind:held?held.body.kind:null,
        receipt:held?'held':errorCode==='lost'?'lost':'none',
        analysisId:displayed?displayed.analysisId:null,
        resultKind:displayed?displayed.kind:null,
        resultFileHash:displayed?displayed.fileHash:null,
        resultPageIndex:displayed?displayed.pageIndex:null,
        error:errorCode
      });
    }
    bound.hash=currentHash();
    syncDisabled();
    return Object.freeze({clear,setBusy,snapshot});
  }

  const api=Object.freeze({create});
  root.FalsifyPaperEnrichmentUI=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);

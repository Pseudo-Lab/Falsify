/* Single-occurrence image replacement contract: strict list/export shapes, PNG preflight and fixed display copy. Manual RED experiment only, never a model call or BLUE input. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyImageEditorCore=api;})(globalThis,function(){
  'use strict';
  const LIST_REQUEST='falsify.image-list-request.v1',LIST='falsify.image-list.v1',EXPORT_REQUEST='falsify.image-export-request.v1',EXPORT='falsify.image-export.v1',REPORT='falsify.image-edit-report.v1';
  const DEADLINE_MS=95000,MAX_FILE_BYTES=25*1024*1024,MAX_OUTPUT_BYTES=64*1024*1024,MAX_PNG_BYTES=4*1024*1024,MAX_PNG_PIXELS=4000000,MAX_PNG_SIDE=8192;
  // Page-point coordinate and source-pixel bounds equal the companion service limits (maxCoordinate 100000, maxImageSide 2^20).
  const MAX_OCCURRENCES=256,MAX_PAGES=64,MAX_THUMB_BYTES=256*1024,MAX_THUMB_SIDE=320,MAX_LIST_CHARS=16*1024*1024,MAX_COORD=100000,MAX_SOURCE_SIDE=1048576;
  const FILENAME='falsify-image-experiment.pdf',REPORT_FILENAME='falsify-image-edit-report.json';
  const LIST_LIMITS=Object.freeze(['single-occurrence','manual-image','text-only-blue']),REPORT_LIMITS=Object.freeze(['engine-render-check','domain-review-pending','text-only-blue']);
  const HEX64=/^[0-9a-f]{64}$/,B64=/^[A-Za-z0-9+/]*={0,2}$/;
  // Fixed engine reason codes with fixed Korean phrases; anything else is a contract break, never shown.
  const REASONS=Object.freeze({'form-image':'Form XObject 안에 그려진 그림이라 지원하지 않음','inline-image':'인라인 그림이라 지원하지 않음','rotated-page':'회전된 쪽이라 지원하지 않음','cropped-page':'잘린(crop) 쪽이라 지원하지 않음',
    'clipped-image':'잘림(clip) 영역에 걸친 그림이라 지원하지 않음','transparency':'투명도가 있는 그림이라 지원하지 않음','unsupported-transform':'회전·기울임 등 지원하지 않는 배치','overlapping-content':'그림 위나 아래에 다른 내용이 겹쳐 있음',
    'malformed-pdf':'PDF 구조를 확인하지 못함','scan-limit':'검사 한도를 넘어 확인하지 못함','dependency-unavailable':'그림 엔진을 사용할 수 없음'});
  const KEEP='원본·선택·PNG는 그대로이며 자동으로 다시 시도하지 않습니다.';
  // Whole-request engine refusals (422 image_edit_rejected): the list reasons plus export-only reasons, each with a fixed phrase and recovery.
  // Kept apart from REASONS so a list entry never accepts an export-only reason.
  const REFUSALS=Object.freeze({'occurrence-not-found':['선택한 그림 위치를 원본에서 다시 찾지 못함','그림 목록을 다시 불러온 뒤 다시 고르세요.'],
    'not-editable':['엔진이 이 위치를 교체할 수 없다고 판정함','목록에서 교체 가능한 다른 위치를 고르세요.'],'replacement-transparent':['교체 PNG에 투명한 픽셀이 있음','투명 픽셀 없이(불투명하게) 저장한 PNG를 고르세요.'],
    'replacement-invalid':['엔진이 교체 PNG를 읽지 못함','8비트 RGB 또는 RGBA PNG로 다시 저장해 고르세요.'],'replacement-too-large':['교체 PNG가 엔진 한도를 넘음','더 작은 PNG(4 MiB·한 변 8192 px·400만 픽셀 이하)를 고르세요.'],
    'output-too-large':['교체한 PDF가 64 MiB 출력 한도를 넘음','더 작은 PNG를 쓰세요.'],'check-failed':['엔진 자체 렌더 검사가 교체 결과를 통과시키지 않음','다른 PNG나 다른 위치로 시도하세요. 통과하지 못한 결과는 내려받지 않습니다.'],
    'no-op':['교체 PNG가 원래 그림과 보기에 달라지지 않음(시각적으로 같은 결과)','원래 그림과 눈에 띄게 다른 PNG를 고르세요.'],'engine-error':['그림 엔진이 이 요청을 처리하지 못함(세부 사유는 공개하지 않음)','다른 위치나 PNG로 시도하거나 companion을 다시 시작하세요.']});
  const EXPORT_REASONS=Object.freeze([...Object.keys(REASONS),...Object.keys(REFUSALS)]);
  // Fixed companion error codes of the image routes (the bridge keeps only these, plus 'unauthorized' from a 401/403 status).
  const SOURCE_REFUSED='companion이 원본 PDF 요청을 받아들이지 않았습니다. 원본을 다시 올린 뒤 시도하세요.';
  const ERRORS=Object.freeze({'image_edit_rejected':'companion 그림 엔진이 이 요청을 거부했습니다(사유 미확인). 연결 문제가 아닙니다.',
    'image_editor_unavailable':'companion에 그림 교체 엔진이 준비되지 않았습니다. 위 연결 패널의 설치 안내로 companion을 다시 준비하세요.',
    'image_edit_timeout':'companion 그림 엔진이 제한 시간 안에 끝나지 않았습니다. 더 작은 PDF나 PNG로 다시 시도하세요.','image_edit_failed':'companion 그림 엔진 처리 중 오류가 났습니다. companion을 다시 시작한 뒤 시도하세요.',
    'companion_busy':'companion이 다른 작업을 처리 중입니다. 그 작업이 끝난 뒤 다시 누르세요.','unauthorized':'로컬 broker가 인증을 거부했습니다. 위 연결 패널에서 다시 연결하세요.',
    'invalid_request':SOURCE_REFUSED,'invalid_file_hash':SOURCE_REFUSED,'invalid_file':SOURCE_REFUSED,'source_hash_mismatch':SOURCE_REFUSED,
    'consent_required':'companion이 동의 확인을 받지 못했습니다. 동의 상자를 다시 확인하세요.','invalid_occurrence_id':'companion이 선택한 그림 id를 받아들이지 않았습니다. 그림 목록을 다시 불러오세요.',
    'invalid_replacement':'companion이 교체 PNG 구조(청크·CRC)를 받아들이지 않았습니다. 일반 PNG로 다시 저장해 고르세요.'});
  const SHAPE='그림 목록 응답이 약속된 형식과 달라 표시하지 않았습니다. 원본은 그대로입니다.',EXPORT_SHAPE='교체 결과가 약속된 형식과 달라 다운로드하지 않았습니다. 원본·선택·PNG는 그대로입니다.';
  function fail(message){const e=new Error(message);e.image=true;throw e;}
  const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
  const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  const hex=v=>typeof v==='string'&&HEX64.test(v);
  // Canonical base64 only: alphabet, length, padding and zero unused bits, so one byte string has exactly one accepted encoding.
  function canonical(s,maxBytes){if(typeof s!=='string'||!s||s.length%4||s.length>Math.ceil(maxBytes/3)*4||!B64.test(s))return false;
    const pad=s.endsWith('==')?2:s.endsWith('=')?1:0;if(s.slice(0,s.length-pad).includes('='))return false;
    if(pad){const v='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(s[s.length-pad-1]);if(v&(pad===2?15:3))return false;}
    return s.length/4*3-pad<=maxBytes;}
  function decode(s){const raw=atob(s),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
  function encode(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
  const SIGNATURE=[137,80,78,71,13,10,26,10],IHDR=[73,72,68,82];
  // IHDR-only header read: signature, first chunk IHDR of length 13, legal depth/colour/method bytes. No pixel decoding happens here.
  function header(bytes){if(!(bytes instanceof Uint8Array)||bytes.length<33||SIGNATURE.some((b,i)=>bytes[i]!==b))return null;
    const u32=i=>((bytes[i]<<24)>>>0)+(bytes[i+1]<<16)+(bytes[i+2]<<8)+bytes[i+3];
    if(u32(8)!==13||IHDR.some((b,i)=>bytes[12+i]!==b))return null;
    const width=u32(16),height=u32(20),depth=bytes[24],colour=bytes[25],DEPTHS={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if(!width||!height||!Object.hasOwn(DEPTHS,colour)||!DEPTHS[colour].includes(depth)||bytes[26]!==0||bytes[27]!==0||bytes[28]>1)return null;
    return {width,height,alpha:colour===4||colour===6};}
  // Replacement PNG preflight before any browser decode: byte size, IHDR, each side and total pixels.
  function png(bytes){if(!(bytes instanceof Uint8Array)||bytes.length>MAX_PNG_BYTES)fail('교체 PNG는 4 MiB 이하만 쓸 수 있습니다.');
    const h=header(bytes);if(!h)fail('PNG 파일 머리(IHDR)를 확인하지 못했습니다. PNG만 쓸 수 있습니다.');
    if(h.width>MAX_PNG_SIDE||h.height>MAX_PNG_SIDE)fail('교체 PNG의 가로·세로는 각각 8192 px 이하여야 합니다.');
    if(h.width*h.height>MAX_PNG_PIXELS)fail('교체 PNG는 400만 픽셀 이하여야 합니다.');
    return Object.freeze(h);}
  function thumbnail(v){if(v===null)return null;if(!canonical(v,MAX_THUMB_BYTES))fail(SHAPE);const h=header(decode(v));if(!h||h.width>MAX_THUMB_SIDE||h.height>MAX_THUMB_SIDE)fail(SHAPE);return v;}
  function bbox(b){if(!Array.isArray(b)||b.length!==4||!b.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=MAX_COORD)||!(b[0]<b[2]&&b[1]<b[3]))return null;return Object.freeze([...b]);}
  function listRequest(fileHash,file){if(!hex(fileHash)||!canonical(file,MAX_FILE_BYTES))fail('원본 PDF를 확인할 수 없어 그림 목록을 요청하지 않았습니다.');return {schema:LIST_REQUEST,fileHash,file};}
  const OCCURRENCE=['id','pageIndex','bbox','width','height','shared','editable','reason','thumbnail'];
  // Exact list or nothing: fixed keys, bound source hash, unique ids, bounded numbers, editable iff no reason, fixed reasons and bounded PNG thumbnails.
  function list(res,expected){
    if(!exact(res,['schema','sourceSha256','complete','occurrences','limits'])||res.schema!==LIST||!hex(res.sourceSha256)||typeof res.complete!=='boolean'||!Array.isArray(res.occurrences)||res.occurrences.length>MAX_OCCURRENCES)fail(SHAPE);
    if(!Array.isArray(res.limits)||res.limits.length!==LIST_LIMITS.length||res.limits.some((x,i)=>x!==LIST_LIMITS[i]))fail(SHAPE);
    if(res.sourceSha256!==expected.sourceSha256)fail('그림 목록이 현재 원본 PDF와 맞지 않아 버렸습니다.');
    let size=0;try{size=JSON.stringify(res).length;}catch{fail(SHAPE);}if(size>MAX_LIST_CHARS)fail(SHAPE);
    const seen=new Set();
    const occurrences=res.occurrences.map(o=>{
      if(!exact(o,OCCURRENCE)||!hex(o.id)||seen.has(o.id)||!int(o.pageIndex,0,MAX_PAGES-1)||!int(o.width,1,MAX_SOURCE_SIDE)||!int(o.height,1,MAX_SOURCE_SIDE)||typeof o.shared!=='boolean'||typeof o.editable!=='boolean')fail(SHAPE);
      const box=bbox(o.bbox);if(!box)fail(SHAPE);
      if(o.editable?o.reason!==null:typeof o.reason!=='string'||!Object.hasOwn(REASONS,o.reason))fail(SHAPE);
      seen.add(o.id);return Object.freeze({id:o.id,pageIndex:o.pageIndex,bbox:box,width:o.width,height:o.height,shared:o.shared,editable:o.editable,reason:o.reason,thumbnail:thumbnail(o.thumbnail)});});
    return Object.freeze({sourceSha256:res.sourceSha256,complete:res.complete,occurrences:Object.freeze(occurrences)});}
  function exportRequest(fileHash,file,occurrenceId,replacement){
    if(!hex(fileHash)||!canonical(file,MAX_FILE_BYTES)||!hex(occurrenceId)||!canonical(replacement,MAX_PNG_BYTES))fail('원본·선택·PNG를 확인할 수 없어 교체를 요청하지 않았습니다.');
    return {schema:EXPORT_REQUEST,fileHash,file,occurrenceId,replacement,consent:true};}
  const sameBox=(a,b)=>a.length===4&&a.every((n,i)=>Math.abs(n-b[i])<=1e-6);
  const REPORT_KEYS=['schema','sourceSha256','occurrenceId','outputSha256','pageIndex','bbox','changedOccurrences','check','limits'];
  // Exact export or nothing, bound to the source hash and the selected listed occurrence (page and box). The browser still recomputes the output hash.
  function exportResult(res,expected){
    if(!exact(res,['schema','sourceSha256','occurrenceId','outputSha256','filename','file','report'])||res.schema!==EXPORT||res.filename!==FILENAME||!hex(res.sourceSha256)||!hex(res.occurrenceId)||!hex(res.outputSha256))fail(EXPORT_SHAPE);
    if(res.sourceSha256!==expected.sourceSha256||res.occurrenceId!==expected.occurrence.id)fail('교체 결과가 현재 원본이나 선택한 그림과 맞지 않아 버렸습니다.');
    if(res.outputSha256===res.sourceSha256)fail('출력이 원본과 같아 교체된 사본으로 보지 않습니다.');
    const r=res.report;
    if(!exact(r,REPORT_KEYS)||r.schema!==REPORT||r.sourceSha256!==res.sourceSha256||r.occurrenceId!==res.occurrenceId||r.outputSha256!==res.outputSha256||r.changedOccurrences!==1||r.check!=='passed'
      ||!Array.isArray(r.limits)||r.limits.length!==REPORT_LIMITS.length||r.limits.some((x,i)=>x!==REPORT_LIMITS[i]))fail(EXPORT_SHAPE);
    const box=bbox(r.bbox);if(!box||r.pageIndex!==expected.occurrence.pageIndex||!sameBox(box,expected.occurrence.bbox))fail('교체 보고서의 쪽·상자가 선택한 그림과 맞지 않아 버렸습니다.');
    if(!canonical(res.file,MAX_OUTPUT_BYTES))fail(EXPORT_SHAPE);
    const bytes=decode(res.file);if(bytes.length<5||String.fromCharCode(...bytes.subarray(0,5))!=='%PDF-')fail(EXPORT_SHAPE);
    return Object.freeze({bytes,outputSha256:res.outputSha256,filename:FILENAME,
      report:Object.freeze({schema:REPORT,sourceSha256:r.sourceSha256,occurrenceId:r.occurrenceId,outputSha256:r.outputSha256,pageIndex:r.pageIndex,bbox:box,changedOccurrences:1,check:'passed',limits:REPORT_LIMITS})});}
  const n=x=>Number(x.toFixed(1)).toLocaleString('ko-KR');
  // Display strings from validated numbers and fixed phrases only.
  function label(o,k){return 'p. '+(o.pageIndex+1)+' · 그림 '+(k+1)+' · 상자 '+n(o.bbox[2]-o.bbox[0])+'×'+n(o.bbox[3]-o.bbox[1])+' pt (왼쪽 위 '+n(o.bbox[0])+', '+n(o.bbox[1])+') · 원본 '+o.width+'×'+o.height+' px';}
  function reason(code){return Object.hasOwn(REASONS,code)?REASONS[code]:'지원하지 않음';}
  // Failure copy from a fixed error code and, only for an engine refusal, one fixed reason. Unknown codes give null (the caller shows generic copy).
  function refusal(kind,code,why){if(typeof code!=='string'||!Object.hasOwn(ERRORS,code))return null;
    const head=kind==='list'?'그림 목록을 만들지 못했습니다: ':'이 그림을 교체하지 못했습니다: ';
    if(code==='image_edit_rejected'&&typeof why==='string'){
      if(Object.hasOwn(REASONS,why))return head+REASONS[why]+'. '+(kind==='list'?'이 PDF에서는 그림 교체를 쓸 수 없습니다.':'목록에서 교체 가능한 다른 위치를 고르세요.')+' '+KEEP;
      if(Object.hasOwn(REFUSALS,why))return head+REFUSALS[why][0]+'. '+REFUSALS[why][1]+' '+KEEP;}
    return ERRORS[code]+' '+KEEP;}
  // The replacement always fills the same original box; an aspect mismatch above 1% stretches it.
  function stretch(o,h){const box=(o.bbox[2]-o.bbox[0])/(o.bbox[3]-o.bbox[1]),img=h.width/h.height;return Math.abs(Math.log(img/box))>0.01;}
  return Object.freeze({LIST_REQUEST,LIST,EXPORT_REQUEST,EXPORT,REPORT,DEADLINE_MS,MAX_FILE_BYTES,MAX_OUTPUT_BYTES,MAX_PNG_BYTES,MAX_PNG_PIXELS,MAX_PNG_SIDE,MAX_OCCURRENCES,MAX_THUMB_BYTES,MAX_THUMB_SIDE,MAX_COORD,MAX_SOURCE_SIDE,
    FILENAME,REPORT_FILENAME,LIST_LIMITS,REPORT_LIMITS,REASONS,EXPORT_REASONS,ERRORS,canonical,decode,encode,header,png,listRequest,list,exportRequest,exportResult,label,reason,refusal,stretch});
});

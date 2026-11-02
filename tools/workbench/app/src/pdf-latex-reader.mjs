import {hex} from './paragraph-pdf-crypto.mjs';
const HASH=/^[a-f0-9]{64}$/,MAX_BYTES=25*1024*1024;
const error=(code,message)=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError',code:'ABORTED'});
let sequence=0;
/** Each read or comparison gets a fresh Worker and privately owned input bytes. */
export function createReconstructionReader({workerFactory,startupTimeoutMs=30000}={}){
  const create=workerFactory||(()=>{if(typeof Worker!=='function')throw error('WORKER_UNAVAILABLE','이 브라우저에서 PDF 재구성 작업자를 사용할 수 없습니다.');const url=new URL('./pdf-latex-reader-worker.mjs',import.meta.url);url.search=new URL(import.meta.url).search;return new Worker(url,{type:'module'});});
  let active=null,disposed=false;
  function cancel(){active?.abort();}
  function dispose(){disposed=true;cancel();}
  function run(kind,request){
    if(disposed)return Promise.reject(error('READER_DISPOSED','작업자가 종료되었습니다.'));
    cancel();const id=++sequence,signal=request?.signal;
    return new Promise((resolve,reject)=>{
      let worker=null,done=false,posted=false,startupTimer=null;
      const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(startupTimer);signal?.removeEventListener('abort',abort);if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}if(active?.id===id)active=null;fn(value);};
      const abort=()=>finish(reject,aborted());active={id,abort};signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)return abort();
      (async()=>{
        let bytes,file=null,sourceDocument=null,sourceBytes=null,sourceHash=null;
        if(kind==='read'){
          file=request.file;if(!file||typeof file.arrayBuffer!=='function'||(Number.isFinite(file.size)&&file.size>MAX_BYTES))throw error('INVALID_INPUT','PDF 파일을 확인하세요.');
          bytes=new Uint8Array(await file.arrayBuffer()).slice();
        }else{
          if(!(request.bytes instanceof Uint8Array))throw error('INVALID_INPUT','기준 PDF 바이트가 필요합니다.');
          bytes=request.bytes.slice();
          if(request.sourceFile!=null){
            const f=request.sourceFile;
            if(request.sourceDocument!=null||typeof f.arrayBuffer!=='function'||(Number.isFinite(f.size)&&f.size>MAX_BYTES))throw error('INVALID_INPUT','원본 PDF 파일을 확인하세요.');
            sourceBytes=new Uint8Array(await f.arrayBuffer()).slice();
            if(done)return;
            if(!sourceBytes.length||sourceBytes.length>MAX_BYTES)throw error('INVALID_INPUT','원본 PDF 크기가 허용 범위를 벗어났습니다.');
            sourceHash=hex(sourceBytes);
          }else{
            sourceDocument=structuredClone(request.sourceDocument);
            if(!sourceDocument||!HASH.test(sourceDocument.sourceSha256)||!Array.isArray(sourceDocument.pages)||!sourceDocument.pages.length||sourceDocument.pages.some(p=>typeof p?.text!=='string'))throw error('INVALID_INPUT','원본 추출 결과를 확인하세요.');
            sourceHash=sourceDocument.sourceSha256;
          }
        }
        if(done)return;if(!bytes.length||bytes.length>MAX_BYTES)throw error('INVALID_INPUT','PDF 크기가 허용 범위를 벗어났습니다.');
        const sha=hex(bytes);worker=create();if(done){worker.terminate();return;}
        worker.onmessage=({data})=>{
          if(done)return;
          if(data?.type==='ready'){
            if(posted)return;
            posted=true;clearTimeout(startupTimer);
            try{worker.postMessage({id,type:kind,bytes,sourceDocument,sourceBytes,...(request.reconstructionModel?{reconstructionModel:structuredClone(request.reconstructionModel)}:{})},sourceBytes?[bytes.buffer,sourceBytes.buffer]:[bytes.buffer]);}
            catch{return finish(reject,error('WORKER_FAILED','PDF 재구성 작업을 시작하지 못했습니다.'));}
            return;
          }
          if(!posted){if(data?.type==='error')finish(reject,error('WORKER_FAILED','PDF 재구성 작업자를 시작하지 못했습니다.'));return;}
          if(data?.id!==id)return;
          if(data.type==='progress'){try{request.onProgress?.('원본의 글·그림·표를 읽고 있습니다.');}catch{}return;}
          if(data.type==='error')return finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));
          if(data.type!=='result')return finish(reject,error('INVALID_RESULT','PDF 재구성 결과를 확인할 수 없습니다.'));
          const r=data.result;
          if(kind==='read'){
            if(!r||r.sourceSha256!==sha||r.model?.schema!=='falsify.pdf-latex-reconstruction.v1'||r.model.sourceSha256!==sha||r.evidence?.document?.sourceSha256!==sha||!Array.isArray(r.evidence.document.pages)||!r.evidence.document.pages.length||r.evidence.document.pages.some(p=>typeof p?.text!=='string')||!Array.isArray(r.model.assets)||r.model.assets.some(a=>!(a?.bytes instanceof Uint8Array)||!HASH.test(a.sha256)||hex(a.bytes)!==a.sha256))return finish(reject,error('INVALID_RESULT','PDF 재구성 결과가 원본과 다릅니다.'));
            return finish(resolve,{...r,file});
          }
          if(!r||r.schema!=='falsify.reconstruction-comparison.v1'||r.sourcePdfHash!==sourceHash||r.baselinePdfHash!==sha||!Number.isSafeInteger(r.sourcePages)||r.sourcePages<1||(sourceDocument&&r.sourcePages!==sourceDocument.pages.length)||!Number.isSafeInteger(r.baselinePages)||r.baselinePages<1||r.method!=='extracted-token-multiset'||r.readingOrderVerified!==false||r.visualLayoutVerified!==false||![r.text?.missing,r.text?.added,r.numbers?.missing,r.numbers?.added].every(a=>Array.isArray(a)&&a.every(v=>typeof v==='string')))return finish(reject,error('INVALID_RESULT','PDF 비교 결과가 입력과 다릅니다.'));
          if(r.layoutAudit!==undefined){const a=r.layoutAudit;if(a?.schema!=='falsify.latex-layout-audit.v1'||a.outputPdfHash!==sha||!['partial','unavailable'].includes(a.status)||!Array.isArray(a.findings)||a.findings.length>1000||a.findings.some(f=>typeof f?.type!=='string'||!Number.isSafeInteger(f.pageIndex)||f.pageIndex<0||f.pageIndex>=r.baselinePages||!Array.isArray(f.bbox)||f.bbox.length!==4||!f.bbox.every(Number.isFinite)))r.layoutAudit={schema:'falsify.latex-layout-audit.v1',outputPdfHash:sha,status:'unavailable',findings:[],coverage:null,limitations:['배치 점검 결과를 생성 PDF에 연결하지 못했습니다.']};}
          if(r.structureAudit!==undefined&&(r.structureAudit?.schema!=='falsify.reconstruction-structure-audit.v1'||r.structureAudit.sourcePdfHash!==sourceHash||r.structureAudit.outputPdfHash!==sha))delete r.structureAudit;
          finish(resolve,r);
        };
        worker.onerror=()=>finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));
        worker.onmessageerror=()=>finish(reject,error('WORKER_FAILED','PDF 재구성 결과를 읽지 못했습니다.'));
        startupTimer=setTimeout(()=>finish(reject,error('WORKER_START_TIMEOUT','PDF 재구성 작업자가 응답하지 않습니다. 다시 시도하세요.')),Number.isFinite(startupTimeoutMs)&&startupTimeoutMs>0?startupTimeoutMs:30000);
      })().catch(e=>{if(done)return;if(e?.code==='WORKER_UNAVAILABLE'||e?.code==='INVALID_INPUT')finish(reject,e);else finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));});
    });
  }
  return {read:request=>run('read',request||{}),compare:request=>run('compare',request||{}),cancel,dispose};
}

import {prepareReconstruction,compareReconstruction} from './pdf-latex-baseline.mjs';
import {readDocument} from './paper-document.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {auditLatexLayout} from './latex-layout-audit.mjs';
import * as mupdf from 'mupdf';
import {auditReconstructionStructure} from './pdf-latex-structure-audit.mjs';

/** Separate entry point to make the worker protocol testable without a DOM. */
export function installReconstructionReaderWorker(scope,{prepare=prepareReconstruction,read=readDocument,compare=compareReconstruction,audit=auditLatexLayout}={}){
  scope.onmessage=async ({data})=>{
    const {id,type,bytes,sourceDocument,sourceBytes,reconstructionModel}=data||{};
    if(!Number.isSafeInteger(id)||!['read','compare'].includes(type)||!(bytes instanceof Uint8Array)){scope.postMessage({id,type:'error',code:'INVALID_REQUEST'});return;}
    try{
      if(type==='read'){
        const owned=bytes.slice(),file={arrayBuffer:async()=>owned.slice().buffer};
        const draft=await prepare({file,onProgress:()=>scope.postMessage({id,type:'progress'})});
        const document=draft.evidence.document, model=structuredClone(draft.model),transfer=[];
        // Each array gets an independent owned buffer, even for shared/offset views.
        for(const asset of model.assets){asset.bytes=Uint8Array.from(asset.bytes);transfer.push(asset.bytes.buffer);}
        const compact={sourceSha256:draft.sourceSha256,model,evidence:{document:{sourceSha256:document.sourceSha256,pages:document.pages.map(p=>({text:p.text,width:p.width,height:p.height,sourcePageIndex:p.sourcePageIndex}))}}};
        scope.postMessage({id,type:'result',result:compact},transfer);
      }else{
        const original=sourceBytes instanceof Uint8Array?await read({file:sourceBytes.slice(),fileHash:hex(sourceBytes)}):sourceDocument;
        const document=await read({file:bytes.slice(),fileHash:hex(bytes)}),result=compare(original,document);
        if(reconstructionModel){try{result.structureAudit=auditReconstructionStructure({model:reconstructionModel,sourceDocument:original,document,mupdf});}catch{result.structureAudit={schema:'falsify.reconstruction-structure-audit.v1',sourcePdfHash:original.sourceSha256,outputPdfHash:hex(bytes),status:'unavailable'};}}
        try{result.layoutAudit=await audit({bytes:bytes.slice(),mupdf});}
        catch{result.layoutAudit={schema:'falsify.latex-layout-audit.v1',outputPdfHash:hex(bytes),status:'unavailable',findings:[],coverage:null,limitations:['배치 점검을 완료하지 못했습니다.']};}
        scope.postMessage({id,type:'result',result});
      }
    }catch{scope.postMessage({id,type:'error',code:'WORKER_FAILED'});}
  };
  scope.postMessage({type:'ready'});
}
if(typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope)installReconstructionReaderWorker(globalThis);

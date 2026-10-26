/* Fixed same-origin loader. No table engine/WASM until explicit inspectPage. */
(function(root){
  'use strict';
  const current=typeof document!=='undefined'&&document.currentScript&&document.currentScript.src;
  let nextId=1;
  const fail=code=>Object.assign(new Error(code),{code,name:'TablePdfError'});
  function run(operation,request){
    request=request||{};const signal=request.signal,id=nextId++;let worker,done=false,timer,sent=false;
    return new Promise((resolve,reject)=>{
      function finish(error,result){if(done)return;done=true;if(timer)clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker?.terminate();error?reject(error):resolve(result);}
      function cancel(){finish(fail('aborted'));}
      if(signal?.aborted)return cancel();signal?.addEventListener('abort',cancel,{once:true});
      Promise.resolve().then(async()=>{
        if(!current)throw fail('loader-unavailable');
        const file=request.file;if(file?.size>25*1024*1024)throw fail('source-too-large');
        const bytes=file instanceof Uint8Array?file.slice():file?.arrayBuffer?new Uint8Array(await file.arrayBuffer()):null;
        if(done)return;if(!bytes?.length||bytes.length>25*1024*1024)throw fail('invalid-source');
        const url=new URL('./table-pdf-worker.mjs',current);url.search=new URL(current).search;
        if(url.origin!==new URL(current).origin)throw fail('worker-origin');
        worker=new Worker(url,{type:'module'});timer=setTimeout(()=>finish(fail('inspection-timeout')),90000);
        worker.onerror=()=>finish(fail('table-worker-failed'));
        worker.onmessage=event=>{
          const data=event.data||{};if(done)return;
          if(data.ready===true){if(sent)return;sent=true;worker.postMessage({id,operation,cells:request.cells,bytes:bytes.buffer,fileHash:request.fileHash,revision:request.revision,pageIndex:request.pageIndex},[bytes.buffer]);return;}
          if(data.id!==id)return;
          if(!data.ok)return finish(fail(data.error?.code||'table-inspection-failed'));
          const r=data.result;
          if(r?.fileHash!==request.fileHash||r?.revision!==request.revision||r?.pageIndex!==request.pageIndex)return finish(fail('stale-selection'));
          finish(null,r);
        };
      }).catch(error=>finish(error));
    });
  }
  root.FalsifyTablePdf={inspectPage:request=>run('inspect',request),checkFit:request=>run('checkFit',request)};
})(typeof globalThis!=='undefined'?globalThis:this);

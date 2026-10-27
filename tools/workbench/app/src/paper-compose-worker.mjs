// Wrap an owned worker. Aborting terminates it; no claim of native compiler interruption.
export function compileInWorker(worker, payload, signal) {
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(fn,value)=>{if(done)return; done=true; signal?.removeEventListener('abort',onAbort); worker.onmessage=null; worker.onerror=null; worker.onmessageerror=null; worker.terminate(); fn(value);};
    const onAbort=()=>finish(reject,new DOMException('Composition cancelled','AbortError'));
    if(signal?.aborted) return onAbort();
    signal?.addEventListener('abort',onAbort,{once:true});
    worker.onmessage=e=>e.data?.error ? finish(reject,new Error(e.data.error)) : finish(resolve,e.data.bytes);
    worker.onerror=e=>finish(reject,new Error(e.message || 'Worker failed'));
    worker.onmessageerror=()=>finish(reject,new Error('Worker message could not be decoded'));
    try { worker.postMessage(payload); } catch (error) { finish(reject,error); }
  });
}

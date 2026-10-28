/* Serialized, content-keyed paper generation and bounded PDF document reuse. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyPaperGeneration=api;})(globalThis,function(){
  'use strict';
  function stable(v){if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';return JSON.stringify(v)??'null';}
  function key(spec){return stable({fileHash:spec.fileHash,edits:(spec.edits||[]).filter(e=>e.enabled!==false).map(e=>({segmentId:e.segmentId,pageIndex:e.pageIndex,before:e.before,after:e.after,anchor:e.anchor})),fontRevision:spec.fontRevision,exportSettings:spec.exportSettings});}
  function create({generate,onResult=()=>{},onState=()=>{},delayMs=200,maxEntries=4}){
    let timer=null,background=null,running=null,disposed=false,sequence=0;const queue=[],cache=new Map();
    const notify=(job,phase,error)=>{try{onState({key:job.key,phase,...(error?{error}: {})});}catch{/* observer failures must not stall the queue */}};
    const aborted=()=>{const e=new Error('Generation cancelled');e.name='AbortError';return e;};
    function remember(k,v){cache.delete(k);cache.set(k,v);while(cache.size>Math.max(1,maxEntries))cache.delete(cache.keys().next().value);}
    function enqueue(job){queue.push(job);pump();}
    async function pump(){if(running||disposed)return;const job=queue.shift();if(!job)return;running=job;job.controller=new AbortController();notify(job,'running');
      try{let result;if(cache.has(job.key)){result=cache.get(job.key);remember(job.key,result);}else{result=await generate(job.spec,{signal:job.controller.signal,key:job.key});if(!job.cancelled)remember(job.key,result);}
        if(job.cancelled)throw aborted();if(job.seq===sequence){onResult(result,{key:job.key,spec:job.spec});notify(job,'ready');}job.resolve?.(result);
      }catch(e){if(!job.cancelled)notify(job,'error',e);job.reject?.(job.cancelled?aborted():e);}finally{running=null;pump();}}
    function dropBackground(){clearTimeout(timer);timer=null;background=null;for(let i=queue.length-1;i>=0;i--)if(!queue[i].explicit)queue.splice(i,1);if(running&&!running.explicit){running.cancelled=true;running.controller.abort();}}
    function captured(spec){return typeof structuredClone==='function'?structuredClone(spec):JSON.parse(JSON.stringify(spec));}
    function schedule(spec){if(disposed)return;const copy=captured(spec),job={spec:copy,key:key(copy),seq:++sequence,explicit:false};dropBackground();background=job;notify(job,'scheduled');timer=setTimeout(()=>{timer=null;if(background===job){background=null;enqueue(job);}},delayMs);}
    function flush(spec){if(disposed)return Promise.reject(aborted());const copy=captured(spec),job={spec:copy,key:key(copy),seq:++sequence,explicit:true};dropBackground();return new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;queue.push(job);pump();});}
    function cancel(){++sequence;dropBackground();for(const job of queue.splice(0)){job.cancelled=true;job.reject?.(aborted());}if(running){running.cancelled=true;running.controller.abort();running.reject?.(aborted());}}
    function dispose(){if(disposed)return;cancel();disposed=true;cache.clear();}
    return {schedule,flush,cancel,dispose};
  }
  function createDocumentCache({maxEntries=2}={}){
    const entries=new Map();let disposed=false;
    function destroy(e){if(e.destroyed)return;e.destroyed=true;if(e.task&&typeof e.task.destroy==='function'){try{Promise.resolve(e.task.destroy()).catch(()=>{});}catch{}return;}Promise.resolve(e.promise).then(doc=>doc&&typeof doc.destroy==='function'?doc.destroy():undefined).catch(()=>{});}
    function trim(){for(const [k,e] of entries){if(entries.size<=Math.max(1,maxEntries))break;if(!e.refs){entries.delete(k);destroy(e);}}}
    async function load(k,loader){if(disposed)throw new Error('Document cache disposed');let e=entries.get(k);if(!e){const task=loader();e={task,refs:0,destroyed:false,promise:Promise.resolve(task&&task.promise||task)};entries.set(k,e);e.promise.catch(()=>{if(entries.get(k)===e)entries.delete(k);});}else{entries.delete(k);entries.set(k,e);}e.refs++;try{const doc=await e.promise;if(disposed||e.destroyed)throw new Error('Document cache disposed');trim();return doc;}catch(err){e.refs--;throw err;}}
    function release(k){const e=entries.get(k);if(e&&e.refs>0)e.refs--;trim();}
    function dispose(){disposed=true;for(const e of entries.values())destroy(e);entries.clear();}
    return {load,release,dispose};
  }
  return {key,create,createDocumentCache};
});


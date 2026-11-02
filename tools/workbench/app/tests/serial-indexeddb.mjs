// Test helper: an IndexedDB fake whose transactions run one at a time in creation
// order, as real readwrite transactions on one store do. Requests issued before a
// transaction starts are queued; requests issued from a success callback (or a
// microtask after it) join the same transaction. pause()/resume() hold the queue so
// tests can order a late rollback after a newer write deterministically.
export function serialIndexedDB(){
  const dbs=new Map(),later=f=>setTimeout(f,0);let queue=Promise.resolve(),paused=null,created=0;
  const gate=()=>paused?paused.promise:Promise.resolve();
  const database=name=>{const stores=dbs.get(name);return {
    objectStoreNames:{contains:n=>stores.has(n)},
    createObjectStore:(n,{keyPath}={})=>stores.set(n,{keyPath,rows:new Map()}),
    close(){},
    transaction(n,mode){
      const st=stores.get(n);if(!st)throw new DOMException('no store','NotFoundError');
      created++;const t={error:null,mode,abort(){t.failed??=new DOMException('aborted','AbortError');}};
      let started=false,done=false,pending=0,staged;const waiting=[];
      const settle=()=>later(()=>{if(!started||pending||done)return;done=true;if(t.failed){t.error=t.failed;t.onerror?.();t.onabort?.();}else{if(mode==='readwrite')st.rows=staged;t.oncomplete?.();}release();});
      const run=op=>{pending++;later(()=>{try{op.r.result=op.fn(staged);op.r.onsuccess?.();}catch(e){op.r.error=e;t.failed??=e;op.r.onerror?.();}pending--;settle();});};
      const request=fn=>{if(done)throw new DOMException('inactive','TransactionInactiveError');const op={r:{},fn};if(started)run(op);else waiting.push(op);return op.r;};
      const write=fn=>request(s=>{if(mode!=='readwrite')throw new DOMException('ro','ReadOnlyError');return fn(s);});
      let release;const prev=queue;queue=new Promise(r=>{release=r;});
      prev.then(gate).then(()=>{started=true;staged=new Map(st.rows);for(const op of waiting)run(op);waiting.length=0;settle();});
      t.objectStore=()=>({
        put:(v,k)=>write(s=>{s.set(st.keyPath?v[st.keyPath]:k,structuredClone(v));}),
        get:k=>request(s=>structuredClone(s.get(k))),
        getAll:()=>request(s=>[...s.values()].map(v=>structuredClone(v))),
        delete:k=>write(s=>{s.delete(k);}),
        clear:()=>write(s=>{s.clear();})
      });
      return t;
    }
  };};
  return {
    dbs,
    get created(){return created;},
    rows:(name,store)=>[...(dbs.get(name)?.get(store)?.rows.entries()||[])],
    pause(){if(!paused){let resolve;const promise=new Promise(r=>{resolve=r;});paused={promise,resolve};}},
    resume(){const p=paused;paused=null;p?.resolve();},
    open(name){const r={};later(()=>{const fresh=!dbs.has(name);if(fresh)dbs.set(name,new Map());r.result=database(name);if(fresh)r.onupgradeneeded?.();r.onsuccess?.();});return r;}
  };
}
// Resolve once cond() holds, polling on macrotasks (bounded).
export async function until(cond,limit=2000){for(let i=0;i<limit;i++){if(cond())return;await new Promise(r=>setTimeout(r,0));}throw new Error('condition not reached');}

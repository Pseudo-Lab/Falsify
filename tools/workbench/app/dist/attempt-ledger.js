/* Metadata only: never store requests, responses, extracted text or credentials. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyAttemptLedger=api;})(globalThis,function(root){
  'use strict';
  const KEY='falsify.attempt-ledger.v1', HEX=/^[a-f0-9]{64}$/;
  const fields=['id','role','harnessHash','harnessName','harnessVersion','model','effort','budget','level','fileHash','sourceHash','startedAt','finishedAt','durationMs','calls','status'];
  const statuses=['completed','failed','cancelled','unknown'];
  function normalize(x){
    if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join()!==fields.slice().sort().join())throw Error('Invalid attempt shape');
    if(typeof x.id!=='string'||!/^[A-Za-z0-9_:-]{1,160}$/.test(x.id)||!['red','blue'].includes(x.role)||!HEX.test(x.harnessHash)||!HEX.test(x.fileHash)||!HEX.test(x.sourceHash))throw Error('Invalid attempt identity');
    for(const k of ['harnessName','harnessVersion','model','effort'])if(x[k]!==null&&(typeof x[k]!=='string'||x[k].length>160||/[\u0000-\u001f\u007f]/.test(x[k])))throw Error('Invalid attempt metadata');
    if(!Number.isSafeInteger(x.budget)||x.budget<1||x.budget>10000||!(x.level===null||Number.isSafeInteger(x.level)))throw Error('Invalid attempt budget');
    if(!Number.isSafeInteger(x.startedAt)||x.startedAt<0||!Number.isSafeInteger(x.finishedAt)||x.finishedAt<x.startedAt||x.durationMs!==x.finishedAt-x.startedAt||!(x.calls===null||Number.isSafeInteger(x.calls)&&x.calls>=0)||!statuses.includes(x.status))throw Error('Invalid attempt observation');
    return Object.fromEntries(fields.map(k=>[k,x[k]]));
  }
  function fromPending(r,observedAt){
    const h=r.request.harness,adapter=h.adapter||{},settings=h.settings||{},finished=Number.isSafeInteger(r.finishedAt)?r.finishedAt:observedAt;
    return normalize({id:r.requestId,role:r.role,harnessHash:r.harnessHash,harnessName:h.name||null,harnessVersion:h.version||null,model:adapter.model||settings.model||null,effort:adapter.effort||settings.effort||null,budget:r.request.maxCalls,level:r.role==='red'?(r.request.level??null):null,fileHash:r.fileHash,sourceHash:r.sourceHash,startedAt:r.createdAt,finishedAt:finished,durationMs:finished-r.createdAt,calls:Number.isSafeInteger(r.observedCalls)&&r.observedCalls>=0?r.observedCalls:null,status:statuses.includes(r.disposition)?r.disposition:'unknown'});
  }
  function read(storage){const box=storage||root.localStorage,raw=box.getItem(KEY);if(!raw)return [];const data=JSON.parse(raw);if(!data||data.schema!==KEY||!Array.isArray(data.attempts)||Object.keys(data).sort().join()!=='attempts,schema')throw Error('Invalid attempt ledger');const rows=data.attempts.map(normalize);if(new Set(rows.map(x=>x.role+':'+x.id)).size!==rows.length)throw Error('Duplicate attempt');return rows;}
  function capture(record,storage,now=Date.now()){
    const box=storage||root.localStorage,attempt=fromPending(record,now),rows=read(box),index=rows.findIndex(x=>x.id===attempt.id&&x.role===attempt.role);
    if(index>=0){const old=rows[index];for(const k of ['id','role','harnessHash','harnessName','harnessVersion','model','effort','budget','level','fileHash','sourceHash','startedAt'])if(old[k]!==attempt[k])throw Error('Attempt identity changed');if(old.status!=='unknown'){if(old.status!==attempt.status)throw Error('Terminal attempt changed');return old;}rows[index]=attempt;}else rows.push(attempt);
    box.setItem(KEY,JSON.stringify({schema:KEY,attempts:rows}));return attempt;
  }
  return Object.freeze({KEY,normalize,fromPending,read,capture});
});

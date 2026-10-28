/* Additive, document-bound external proposal collection. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyExternalProposals=api;})(globalThis,function(){
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const SCHEMA='falsify.external-proposals.v1';
  function create({fileHash,role='red',segments}){
    if(typeof fileHash!=='string'||!fileHash||!['red','blue'].includes(role)||!Array.isArray(segments))throw Error('Invalid document');
    const source=clone(segments), listeners=new Set();let batches=[],items=[],next=1;
    const snap=()=>clone({schema:SCHEMA,fileHash,role,batches,items});
    const emit=()=>{const s=snap();for(const fn of listeners)try{fn(clone(s));}catch(_){}return s;};
    function valid(item){
      const needle=role==='blue'?item.quote:item.before;if(!item.anchor||typeof needle!=='string'||!needle)return false;
      const s=source.find(x=>x.id===item.segmentId),a=item.anchor;
      if(!s||!Number.isInteger(a.start)||!Number.isInteger(a.end)||a.start<0||a.end<=a.start||a.end>s.text.length||s.text.slice(a.start,a.end)!==needle)return false;
      if(Number.isInteger(s.pageIndex)&&s.pageIndex!==item.pageIndex)return false;
      let count=0,at=-1;while((at=s.text.indexOf(needle,at+1))>=0&&at<a.start)count++;
      if(a.occurrence!=null&&a.occurrence!==count)return false;
      return Number.isInteger(item.pageIndex)&&item.pageIndex>=0;
    }
    const overlap=(a,b)=>a.segmentId===b.segmentId&&a.anchor.start<b.anchor.end&&b.anchor.start<a.anchor.end;
    const find=id=>{const item=items.find(x=>x.id===id);if(!item)throw Error('Unknown proposal');return item;};
    function enable(item,on){
      if(on&&role==='red'&&(item.kind!=='change'||item.matchStatus!=='matched'||!valid(item)||typeof item.after!=='string'||item.after===item.before||(item.after!==''&&!item.after.trim())))throw Error('Proposal is not applicable');
      if(on&&role==='red')for(const other of items)if(other!==item&&other.enabled&&other.anchor&&overlap(item,other))other.enabled=false;
      item.enabled=!!on;
    }
    function append(batch){
      if(!batch||batch.schema!=='falsify.external-batch.v1'||batch.role!==role||batch.fileHash!==fileHash||!Array.isArray(batch.items))throw Error('Batch does not match document');
      const b=clone(batch);batches.push(b);
      for(const raw of b.items){
        const item=clone(raw),ref={batchId:b.id,itemId:item.id};
        const key=x=>JSON.stringify([x.kind,x.before,x.after,x.quote,x.segmentId,x.pageIndex,x.anchor,x.rationale,x.evidence,x.references,x.attackTypes,x.uncertainty]);
        const duplicate=items.find(x=>!x.parentIds&&key(x)===key(item));
        if(duplicate){if(!duplicate.sourceRefs.some(r=>r.batchId===ref.batchId&&r.itemId===ref.itemId))duplicate.sourceRefs.push(ref);continue;}
        item.id='p'+next++;item.sourceRefs=[ref];item.enabled=false;
        if(item.matchStatus==='matched'&&!valid(item))item.matchStatus='missing';
        items.push(item);
      }
      return emit();
    }
    function setEnabled(id,on){enable(find(id),on);return emit();}
    function update(id,fields){
      const item=find(id),allowed=['after','rationale','evidence','references','attackTypes','uncertainty'];
      for(const k of Object.keys(fields||{}))if(!allowed.includes(k))throw Error('Unsupported field');
      const updated={...item,...clone(fields)};if(updated.enabled&&role==='red'&&(typeof updated.after!=='string'||(updated.after!==''&&!updated.after.trim())))throw Error('Invalid after');
      Object.assign(item,updated);return emit();
    }
    function bind(id,binding){
      const item=find(id),nextItem={...item,...clone(binding)};
      if(role==='blue'&&typeof binding.before==='string')nextItem.quote=binding.before;
      if(!valid(nextItem))throw Error('Source range does not match');
      const s=source.find(x=>x.id===nextItem.segmentId);let occurrence=0,pos=-1;while((pos=s.text.indexOf(role==='blue'?nextItem.quote:nextItem.before,pos+1))>=0&&pos<nextItem.anchor.start)occurrence++;
      nextItem.anchor={...nextItem.anchor,occurrence};nextItem.matchStatus='matched';nextItem.enabled=false;Object.assign(item,nextItem);return emit();
    }
    function combine(ids,fields){
      if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw Error('Select at least two proposals');
      const parents=ids.map(find),item={...clone(fields),id:'p'+next++,kind:'change',origin:'human',parentIds:ids.slice(),sourceRefs:parents.flatMap(p=>clone(p.sourceRefs)),enabled:false};
      item.matchStatus=valid(item)?'matched':'missing';items.push(item);emit();return item.id;
    }
    function restore(value){
      const s=clone(value);if(s.schema!==SCHEMA||s.fileHash!==fileHash||s.role!==role||!Array.isArray(s.batches)||!Array.isArray(s.items))throw Error('Snapshot does not match document');
      const seen=new Set();for(const item of s.items){if(typeof item.id!=='string'||seen.has(item.id)||!Array.isArray(item.sourceRefs))throw Error('Invalid proposal');seen.add(item.id);if(item.matchStatus==='matched'&&!valid(item))throw Error('Invalid source range');if(item.enabled&&role==='red'&&(item.matchStatus!=='matched'||!valid(item)||typeof item.after!=='string'||(item.after!==''&&!item.after.trim())))throw Error('Invalid selected proposal');}
      const active=s.items.filter(x=>x.enabled&&role==='red');for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)if(overlap(active[i],active[j]))throw Error('Overlapping selections');
      batches=s.batches;items=s.items;next=Math.max(0,...items.map(x=>/^p\d+$/.test(x.id)?Number(x.id.slice(1)):0))+1;return emit();
    }
    function edits(){return clone(items.filter(x=>role==='red'&&x.enabled&&x.kind==='change'&&x.matchStatus==='matched'&&valid(x)&&x.after!==x.before).map(x=>({id:x.id,enabled:true,before:x.before,after:x.after,segmentId:x.segmentId,pageIndex:x.pageIndex,anchor:x.anchor,origin:x.origin||'external-ai-import',sourceRefs:x.sourceRefs})));}
    return {append,snapshot:snap,setEnabled,update,bind,combine,restore,edits,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  }
  return {create};
});

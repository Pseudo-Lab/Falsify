/* Additive, document-bound external proposal collection. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyExternalProposals=api;})(globalThis,function(){
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const SCHEMA='falsify.external-proposals.v1';
  const isBox=b=>Array.isArray(b)&&b.length===4&&b.every(x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=20000)&&b[2]>b[0]&&b[3]>b[1];
  const canonical=v=>typeof v==='object'&&v!==null?JSON.stringify(Object.keys(v).sort().reduce((a,k)=>{a[k]=v[k];return a;},{})):String(v);
  function validChartValue(val){
    if(typeof val==='number')return Number.isFinite(val);
    if(typeof val==='string')return val.trim().length>0&&!/^(?:NaN|Infinity|-Infinity)$/i.test(val.trim());
    if(!val||typeof val!=='object'||Array.isArray(val))return false;
    const keys=['x','y','yLow','yHigh','value'].filter(k=>Object.hasOwn(val,k)&&val[k]!=null);
    return keys.length>0&&keys.every(k=>typeof val[k]==='number'&&Number.isFinite(val[k]));
  }
  function parseChartAfterText(text){
    if(typeof text!=='string'||!text.trim())return null;
    const t=text.trim();
    if(t.startsWith('{')){try{const obj=JSON.parse(t);return validChartValue(obj)?obj:null;}catch{return null;}}
    if(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)){const n=Number(t);return Number.isFinite(n)?n:null;}
    return validChartValue(t)?t:null;
  }
  function validRange(s,a,needle){
    return !(!s||!Number.isInteger(a.start)||!Number.isInteger(a.end)||a.start<0||a.end<=a.start||a.end>s.text.length||s.text.slice(a.start,a.end)!==needle);
  }
  const validNonNegInt=v=>Number.isInteger(v)&&v>=0;
  function countOccurrence(text,needle,start){let count=0,at=-1;while((at=text.indexOf(needle,at+1))>=0&&at<start)count++;return count;}
  function validTextAnchor(source,role,item){
    const needle=role==='blue'?(item.sourceQuote||item.quote):item.before;
    if(!item.anchor||typeof needle!=='string'||!needle)return false;
    const s=source.find(x=>x.id===item.segmentId),a=item.anchor;
    if(!validRange(s,a,needle)||!validNonNegInt(item.pageIndex))return false;
    if(Number.isInteger(s.pageIndex)&&s.pageIndex!==item.pageIndex)return false;
    return a.occurrence==null||a.occurrence===countOccurrence(s.text,needle,a.start);
  }
  const validOptionalNonNegInt=v=>v==null||validNonNegInt(v);
  const validOptionalId=v=>v==null||(typeof v==='string'&&v.length>0);
  function validTableTarget(source,item){
    const t=item.tableTarget;
    if(!t||typeof t!=='object'||Array.isArray(t)||!validNonNegInt(t.pageIndex)||item.pageIndex!==t.pageIndex)return false;
    if(typeof t.before!=='string'||!t.before||typeof t.after!=='string')return false;
    if((t.bbox!=null&&!isBox(t.bbox))||!validOptionalId(t.tableId))return false;
    return item.anchor?validTextAnchor(source,'red',item):validNonNegInt(t.row)&&validNonNegInt(t.column);
  }
  function validVisualTarget(item){
    const v=item.visualTarget;
    if(!v||typeof v!=='object'||Array.isArray(v)||item.anchor||!validNonNegInt(v.pageIndex)||item.pageIndex!==v.pageIndex)return false;
    if(!validOptionalNonNegInt(v.pointIndex)||!validOptionalNonNegInt(v.markIndex))return false;
    return (v.bbox==null||isBox(v.bbox))&&validChartValue(v.beforeValue)&&validChartValue(v.afterValue);
  }
  function tableOverlap(a,b){
    const x=a.tableTarget,y=b.tableTarget;
    if(!x||!y||x.pageIndex!==y.pageIndex||(x.tableId||'')!==(y.tableId||''))return false;
    return x.row!=null&&x.row===y.row&&x.column!=null&&x.column===y.column;
  }
  function sameChartHeader(x,y){
    return !!(x&&y&&x.pageIndex===y.pageIndex&&(x.figureId||'')===(y.figureId||'')&&(x.series||'')===(y.series||''));
  }
  function chartOverlap(a,b){
    const x=a.visualTarget,y=b.visualTarget;
    if(!sameChartHeader(x,y))return false;
    if(x.pointIndex!=null&&y.pointIndex!=null)return x.pointIndex===y.pointIndex;
    if(x.markIndex!=null&&y.markIndex!=null)return x.markIndex===y.markIndex;
    return x.pointIndex==null&&y.pointIndex==null&&x.markIndex==null&&y.markIndex==null;
  }
  function itemsOverlap(a,b){
    if(a.anchor&&b.anchor&&a.segmentId===b.segmentId&&a.anchor.start<b.anchor.end&&b.anchor.start<a.anchor.end)return true;
    if(a.kind==='table-cell'&&b.kind==='table-cell'&&tableOverlap(a,b))return true;
    if(a.kind==='chart-point'&&b.kind==='chart-point'&&chartOverlap(a,b))return true;
    return false;
  }
  function dedupeKey(x){
    return JSON.stringify([x.kind,x.before,x.after,x.quote,x.sourceQuote,x.segmentId,x.pageIndex,x.anchor,x.tableTarget,x.visualTarget,x.rationale,x.evidence,x.references,x.attackTypes,x.uncertainty,x.findingType,x.severity,x.confidence,x.locationLabel,x.reportNumber,x.verdictLabel,x.zeroDropRecovered,x.defectFamily]);
  }
  function create({fileHash,role='red',segments}){
    if(typeof fileHash!=='string'||!fileHash||!['red','blue'].includes(role)||!Array.isArray(segments))throw Error('Invalid document');
    const source=clone(segments), listeners=new Set();let batches=[],items=[],next=1;
    const snap=()=>clone({schema:SCHEMA,fileHash,role,batches,items});
    const emit=()=>{const s=snap();for(const fn of listeners)try{fn(clone(s));}catch(_){}return s;};
    function valid(item){
      if(role==='red'&&item.kind==='table-cell')return validTableTarget(source,item);
      if(role==='red'&&item.kind==='chart-point')return validVisualTarget(item);
      return validTextAnchor(source,role,item);
    }
    const find=id=>{const item=items.find(x=>x.id===id);if(!item)throw Error('Unknown proposal');return item;};
    function applicable(item){
      if(item.matchStatus!=='matched'||!valid(item))return false;
      if(item.kind==='chart-point')return canonical(item.visualTarget.beforeValue)!==canonical(item.visualTarget.afterValue);
      if(item.kind!=='change'&&item.kind!=='table-cell')return false;
      return typeof item.after==='string'&&item.after!==item.before&&(item.after===''||!!item.after.trim());
    }
    function enable(item,on){
      if(on&&role==='red'&&!applicable(item))throw Error('Proposal is not applicable');
      if(on&&role==='red')for(const other of items)if(other!==item&&other.enabled&&itemsOverlap(item,other))other.enabled=false;
      item.enabled=!!on;
    }
    function pushBatchItem(batchId,raw){
      const item=clone(raw),ref={batchId,itemId:item.id};
      const duplicate=items.find(x=>!x.parentIds&&dedupeKey(x)===dedupeKey(item));
      if(duplicate){if(!duplicate.sourceRefs.some(r=>r.batchId===ref.batchId&&r.itemId===ref.itemId))duplicate.sourceRefs.push(ref);return;}
      item.id='p'+next++;item.sourceRefs=[ref];item.enabled=false;
      if(item.matchStatus==='matched'&&!valid(item))item.matchStatus=item.kind==='table-cell'||item.kind==='chart-point'?'unmatched':'missing';
      items.push(item);
    }
    function append(batch){
      if(!batch||batch.schema!=='falsify.external-batch.v1'||batch.role!==role||batch.fileHash!==fileHash||!Array.isArray(batch.items))throw Error('Batch does not match document');
      const b=clone(batch);batches.push(b);
      for(const raw of b.items)pushBatchItem(b.id,raw);
      return emit();
    }
    function setEnabled(id,on){enable(find(id),on);return emit();}
    function validateSelection(changes){
      if(!Array.isArray(changes)||new Set(changes.map(x=>x.id)).size!==changes.length)throw Error('Invalid selection');
      const next=clone(items);
      for(const change of changes){
        if(!change||typeof change.enabled!=='boolean')throw Error('Invalid selection');
        const item=next.find(x=>x.id===change.id);if(!item)throw Error('Unknown proposal');
        if(change.enabled&&role==='red'&&!applicable(item))throw Error('Proposal is not applicable');
        item.enabled=change.enabled;
      }
      validateRestoredOverlap(next);return next;
    }
    function setSelection(changes){items=validateSelection(changes);return emit();}
    function applyVisualUpdate(updated,fields){
      if(!updated.visualTarget)return;
      if(Object.hasOwn(fields,'afterValue')){
        if(!validChartValue(fields.afterValue))throw Error('Invalid after');
        updated.visualTarget={...updated.visualTarget,afterValue:clone(fields.afterValue)};
        updated.after=typeof fields.afterValue==='string'?fields.afterValue:JSON.stringify(fields.afterValue);
      }else if(Object.hasOwn(fields,'after')){
        const parsed=parseChartAfterText(fields.after);
        if(parsed===null)throw Error('Invalid after');
        updated.visualTarget={...updated.visualTarget,afterValue:parsed};
      }
    }
    function applyUpdateFields(item,updated,fields){
      if(updated.kind==='table-cell'&&updated.tableTarget&&Object.hasOwn(fields,'after'))updated.tableTarget={...updated.tableTarget,after:updated.after};
      if(updated.kind==='chart-point')applyVisualUpdate(updated,fields);
      if(updated.enabled&&role==='red'&&!applicable(updated))throw Error('Invalid after');
      Object.assign(item,updated);
    }
    function update(id,fields){
      const item=find(id),allowed=['after','afterValue','rationale','evidence','references','attackTypes','uncertainty','verdictLabel','defectFamily'];
      for(const k of Object.keys(fields||{}))if(!allowed.includes(k))throw Error('Unsupported field');
      const updated={...item,...clone(fields)};
      applyUpdateFields(item,updated,fields||{});
      return emit();
    }
    function boundTableItem(item,b){
      const prev=item.tableTarget||{};
      const tableTarget=b.tableTarget||{tableId:b.tableId??prev.tableId??null,pageIndex:b.pageIndex??item.pageIndex,row:b.row,column:b.column,bbox:b.bbox??null,before:b.before??item.before,after:item.after};
      return {...item,pageIndex:tableTarget.pageIndex??item.pageIndex,before:tableTarget.before??item.before,anchor:b.anchor??null,tableTarget};
    }
    const fallback=(value,alt)=>value!==undefined?value:alt;
    function boundVisualItem(item,b){
      const prev=item.visualTarget||{};
      const visualTarget=b.visualTarget||{
        figureId:fallback(b.figureId,prev.figureId??null),pageIndex:fallback(b.pageIndex,item.pageIndex),
        bbox:fallback(b.bbox,prev.bbox??null),series:fallback(b.series,prev.series??null),
        pointIndex:fallback(b.pointIndex,prev.pointIndex??null),markIndex:fallback(b.markIndex,prev.markIndex??null),
        beforeValue:fallback(b.beforeValue,prev.beforeValue),afterValue:fallback(b.afterValue,prev.afterValue)
      };
      return {...item,pageIndex:visualTarget.pageIndex??item.pageIndex,anchor:null,visualTarget};
    }
    function bindStructured(item,binding){
      const b=clone(binding||{});
      const nextItem=item.kind==='table-cell'?boundTableItem(item,b):boundVisualItem(item,b);
      if(!valid(nextItem))throw Error('Source range does not match');
      nextItem.matchStatus='matched';nextItem.enabled=false;Object.assign(item,nextItem);return emit();
    }
    function bind(id,binding){
      const item=find(id);
      if(role==='red'&&(item.kind==='table-cell'||item.kind==='chart-point'))return bindStructured(item,binding);
      const nextItem={...item,...clone(binding)};
      if(role==='blue'&&typeof binding.before==='string')nextItem.sourceQuote=binding.before;
      if(!valid(nextItem))throw Error('Source range does not match');
      const s=source.find(x=>x.id===nextItem.segmentId);let occurrence=0,pos=-1;while((pos=s.text.indexOf(role==='blue'?(nextItem.sourceQuote||nextItem.quote):nextItem.before,pos+1))>=0&&pos<nextItem.anchor.start)occurrence++;
      nextItem.anchor={...nextItem.anchor,occurrence};nextItem.matchStatus='matched';nextItem.enabled=false;Object.assign(item,nextItem);return emit();
    }
    function combine(ids,fields){
      if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw Error('Select at least two proposals');
      const parents=ids.map(find),item={...clone(fields),id:'p'+next++,kind:'change',origin:'human',parentIds:ids.slice(),sourceRefs:parents.flatMap(p=>clone(p.sourceRefs)),enabled:false};
      item.matchStatus=valid(item)?'matched':'missing';items.push(item);emit();return item.id;
    }
    function validateRestoredItem(item,seen){
      if(typeof item.id!=='string'||seen.has(item.id)||!Array.isArray(item.sourceRefs))throw Error('Invalid proposal');
      seen.add(item.id);
      if(item.matchStatus==='matched'&&!valid(item))throw Error('Invalid source range');
      if(item.enabled&&role==='red'&&!applicable(item))throw Error('Invalid selected proposal');
    }
    function validateRestoredOverlap(restored){
      const active=restored.filter(x=>x.enabled&&role==='red');
      for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)if(itemsOverlap(active[i],active[j]))throw Error('Overlapping selections');
    }
    function restore(value){
      const s=clone(value);if(s.schema!==SCHEMA||s.fileHash!==fileHash||s.role!==role||!Array.isArray(s.batches)||!Array.isArray(s.items))throw Error('Snapshot does not match document');
      const seen=new Set();for(const item of s.items)validateRestoredItem(item,seen);
      validateRestoredOverlap(s.items);
      batches=s.batches;items=s.items;next=Math.max(0,...items.map(x=>/^p\d+$/.test(x.id)?Number(x.id.slice(1)):0))+1;return emit();
    }
    function edits(){return clone(items.filter(x=>role==='red'&&x.enabled&&(x.kind==='change'||(x.kind==='table-cell'&&x.anchor))&&applicable(x)).map(x=>({id:x.id,enabled:true,before:x.before,after:x.after,segmentId:x.segmentId,pageIndex:x.pageIndex,anchor:x.anchor,origin:x.origin||'external-ai-import',sourceRefs:x.sourceRefs})));}
    function tableEdits(){return clone(items.filter(x=>role==='red'&&x.enabled&&x.kind==='table-cell'&&applicable(x)).map(x=>({id:x.id,enabled:true,kind:'table-cell',before:x.before,after:x.after,pageIndex:x.pageIndex,tableTarget:x.tableTarget,segmentId:x.segmentId??null,anchor:x.anchor??null,origin:x.origin||'external-ai-import',sourceRefs:x.sourceRefs})));}
    function visualEdits(){return clone(items.filter(x=>role==='red'&&x.enabled&&x.kind==='chart-point'&&applicable(x)).map(x=>({id:x.id,enabled:true,kind:'chart-point',before:x.before,after:x.after,pageIndex:x.pageIndex,visualTarget:x.visualTarget,origin:x.origin||'external-ai-import',sourceRefs:x.sourceRefs})));}
    function structuredEdits(){return {text:edits(),tableCells:tableEdits(),chartPoints:visualEdits()};}
    return {append,snapshot:snap,setEnabled,setSelection,validateSelection,update,bind,combine,restore,edits,tableEdits,visualEdits,structuredEdits,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  }
  return {create};
});

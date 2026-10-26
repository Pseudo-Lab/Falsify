import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {createAnnotationTransport,ANNOTATION_LIMITS} from '../src/document-flow-annotations.mjs';
const api=createAnnotationTransport({mupdf}),sha=b=>createHash('sha256').update(b).digest('hex');
function save(doc){const b=doc.saveToBuffer('garbage=0,compress=false');try{return b.asUint8Array().slice();}finally{b.destroy();}}
function source({shared=false,tagged=false,badRect=false,namedTarget=2,unknownAction=false,direct=false}={}){
  const doc=new mupdf.PDFDocument();try{
    for(let p=0;p<3;p++)doc.insertPage(-1,doc.addPage([0,0,300,400],0,{},'q 0 0 0 RG 10 10 m 20 20 l S Q'));
    const pages=Array.from({length:3},(_,i)=>doc.findPage(i)),catalog=doc.getTrailer().get('Root'),dest=[pages[namedTarget],'XYZ',25,375,null];
    // Two supported destination encodings, including a nested raw name tree.
    catalog.put('Dests',{legacyTarget:dest});catalog.put('Names',{Dests:{Kids:[{Names:[doc.newString('namedTarget'),{D:dest}]}]}});
    const stream=doc.addStream(new Uint8Array([0,1,255,23,48]),{PrivateStreamKey:doc.newString('unknown-stream-value')});
    const next={S:'URI',URI:doc.newString('https://other.invalid/never-open'),PrivateUnknown:{Rect:[1,2,3,4],Nested:doc.newString('private-next-value')}};
    const action={S:unknownAction?'JavaScript':'URI',URI:doc.newString('https://example.invalid/never-open'),PrivateUnknown:{Nested:[17,doc.newString('retained-action-data'),pages[2]],Blob:stream},Next:next};
    const firstObj={Type:'Annot',Subtype:'Link',Rect:badRect?[30,265,110,250]:[30,250,110,265],P:pages[0],QuadPoints:[30,265,110,265,30,250,110,250],Contents:doc.newString('Repeated label'),A:action,PrivateUnknown:{Keep:true,Other:doc.newString('do-not-report')}};
    if(tagged)firstObj.StructParent=4;
    const first=direct?doc.newDictionary():doc.addObject(firstObj);if(direct)for(const [k,v]of Object.entries(firstObj))first.put(k,v);
    const second=doc.addObject({Type:'Annot',Subtype:'Link',Rect:[30,200,110,215],P:pages[0],Contents:doc.newString('Repeated label'),Dest:doc.newString('namedTarget'),PrivateUnknown:stream});
    const edge=doc.addObject({Type:'Annot',Subtype:'Link',Rect:[20,380,140,395],P:pages[1],A:{S:'URI',URI:doc.newString('https://edge.invalid/never-open')},Contents:doc.newString('Repeated label')});
    pages[0].put('Annots',[first,second]);pages[1].put('Annots',shared?[edge,first]:[edge]);return save(doc);
  }finally{doc.destroy();}
}
const map=[0,1,2].map(i=>({sourcePageIndex:i,outputPageIndex:i,continuationPageIndices:[]}));
const move={sourcePageIndex:0,annotationIndex:0,outputPageIndex:1,dx:20,dy:-80};
const inspect=src=>api.inspect({sourceBytes:src,sourceSha256:sha(src)});
const args=(model,src,extra={})=>({model,sourceBytes:src,outputBytes:src,sourcePageMap:map,moves:[move],reflowedSourcePages:[0,1],...extra});
function mutate(bytes,fn){const d=new mupdf.PDFDocument(bytes);try{fn(d);return save(d);}finally{d.destroy();}}
const values=o=>Array.from({length:o.length},(_,i)=>o.get(i).asNumber());

test('raw same-document move retains URI, nested unknown A/Next, binary streams and fixed-edge dictionary',async()=>{
  for(const direct of [false,true]){
    const src=source({direct}),original=src.slice(),model=await inspect(src);assert.equal(model.annotations.length,3);assert.ok(model.annotations.every(a=>a.eligible));assert.deepEqual(model.annotations[1].destination,{type:'internal',targetSourcePageIndex:2});assert.ok(!JSON.stringify(model).includes('https://'));assert.ok(!JSON.stringify(model).includes('Repeated label'));
    const out=await api.transport(args(model,src));assert.deepEqual(src,original);assert.equal((await api.validate(args(model,src,{outputBytes:out.pdf}))).ok,true);
    const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(out.pdf);try{
      const old=a.findPage(0).get('Annots',0),moved=b.findPage(1).get('Annots',1);assert.equal(b.findPage(0).get('Annots').length,1);assert.deepEqual(values(moved.get('Rect')),[50,170,130,185]);assert.deepEqual(values(moved.get('QuadPoints')),[50,185,130,185,50,170,130,170]);assert.equal(moved.get('P').asIndirect(),b.findPage(1).asIndirect());
      assert.equal(moved.get('A','URI').asString(),old.get('A','URI').asString());assert.equal(moved.get('A','Next','PrivateUnknown','Nested').asString(),'private-next-value');assert.deepEqual(values(moved.get('A','Next','PrivateUnknown','Rect')),[1,2,3,4]);
      const raw=moved.get('A','PrivateUnknown','Blob').readRawStream();try{assert.deepEqual([...raw.asUint8Array()],[0,1,255,23,48]);}finally{raw.destroy();}
      assert.deepEqual(values(b.findPage(1).get('Annots',0,'Rect')),[20,380,140,395]);
    }finally{a.destroy();b.destroy();}
  }
});
test('named/legacy internal destinations resolve, including URI Next GoTo targets; reflowed targets barrier',async()=>{
  const src=source(),model=await inspect(src);assert.deepEqual(model.annotations[1].internalDestinationSourcePageIndices,[2]);
  await assert.rejects(()=>api.transport(args(model,src,{reflowedSourcePages:[0,1,2]})),{code:'annotation-destination-reflowed'});
  const legacy=mutate(src,d=>d.findPage(0).get('Annots',1).put('Dest',d.newName('legacyTarget')));assert.equal((await inspect(legacy)).annotations[1].destination.targetSourcePageIndex,2);
  const next=mutate(src,d=>d.findPage(0).get('Annots',0,'A','Next').put('S','GoTo')&&d.findPage(0).get('Annots',0,'A','Next').put('D',d.newString('namedTarget')));
  const nm=await inspect(next);assert.deepEqual(nm.annotations[0].destination,{type:'uri'});assert.deepEqual(nm.annotations[0].internalDestinationSourcePageIndices,[2]);
  const missing=mutate(src,d=>d.findPage(0).get('Annots',1).put('Dest',d.newString('missing')));assert.equal((await inspect(missing)).annotations[1].eligible,true);assert.equal((await inspect(missing)).annotations[1].preservedMissingDestination,true);
});
test('identity map normalizes page refs after inserting a generated page',async()=>{
  const src=source(),model=await inspect(src),staged=mutate(src,d=>d.insertPage(1,d.addPage([0,0,300,400],0,{},''))),insertedMap=[{sourcePageIndex:0,outputPageIndex:0},{sourcePageIndex:1,outputPageIndex:2},{sourcePageIndex:2,outputPageIndex:3}];
  const request=args(model,src,{outputBytes:staged,sourcePageMap:insertedMap,moves:[{...move,outputPageIndex:1}]});const out=await api.transport(request);assert.equal((await api.validate({...request,outputBytes:out.pdf})).ok,true);
});
test('wrong source/model/map, duplicate moves, shared annotation ownership, tagged and invalid geometry refuse',async()=>{
  const src=source(),model=await inspect(src);
  await assert.rejects(()=>api.inspect({sourceBytes:src,sourceSha256:'0'.repeat(64)}),{code:'annotation-stale-source'});
  for(const change of [{sourceBytes:source({unknownAction:true})},{model:JSON.parse(JSON.stringify(model))},{sourcePageMap:[map[0],map[0],map[2]]},{moves:[move,move]},{moves:[{...move,dx:NaN}]},{moves:[{...move,split:true}]},{moves:[{...move,dx:1000}]}])assert.equal((await api.validate(args(model,src,change))).ok,false);
  for(const options of [{shared:true},{tagged:true},{badRect:true},{unknownAction:true}]){const bytes=source(options),m=await inspect(bytes);assert.ok(m.annotations.some(a=>!a.eligible));await assert.rejects(()=>api.transport(args(m,bytes)));}
});
test('validation rejects dropped links, altered nested actions/streams and unauthorized fixed-edge geometry',async()=>{
  const src=source(),model=await inspect(src),out=await api.transport(args(model,src));
  const changes=[d=>d.findPage(1).get('Annots').delete(1),d=>d.findPage(1).get('Annots',1,'A','Next','PrivateUnknown').put('Nested',d.newString('altered')),d=>d.findPage(1).get('Annots',1,'A').delete('Next'),d=>d.findPage(1).get('Annots',1,'A','Next','PrivateUnknown').put('Rect',[1,2,30,40]),d=>d.findPage(1).get('Annots',0).put('Rect',[21,380,141,395]),d=>d.findPage(1).get('Annots',1,'A','PrivateUnknown','Blob').writeRawStream(new Uint8Array([9,8,7]))];
  for(const change of changes){const bad=mutate(out.pdf,change),result=await api.validate(args(model,src,{outputBytes:bad}));assert.equal(result.ok,false,result.code);}
});
test('unsupported annotations outside reflowed pages stay intact; in group they are a barrier',async()=>{
  const src=mutate(source(),d=>d.findPage(1).get('Annots',0).put('Subtype','Text')),model=await inspect(src);assert.equal(model.annotations[2].eligible,false);
  const out=await api.transport(args(model,src,{moves:[{...move,outputPageIndex:0,dx:0,dy:-10}],reflowedSourcePages:[0]}));assert.equal((await api.validate(args(model,src,{outputBytes:out.pdf,moves:[{...move,outputPageIndex:0,dx:0,dy:-10}],reflowedSourcePages:[0]}))).ok,true);
  await assert.rejects(()=>api.transport(args(model,src)),{code:'annotation-subtype-unsupported'});
});
test('bounded canonical graph refuses excessive depth without leaking payload',async()=>{
  const src=mutate(source(),d=>{const annotation=d.findPage(0).get('Annots',0);let next={Secret:d.newString('never-return-this')};for(let i=0;i<ANNOTATION_LIMITS.depth+2;i++)next={Next:next};annotation.put('PrivateUnknown',next);});
  await assert.rejects(()=>inspect(src),{code:'annotation-object-limit'});
});

test('two original annotation indices move independently; missing P is added only to moved object',async()=>{
  const src=mutate(source({direct:true}),d=>d.findPage(0).get('Annots',0).delete('P')),model=await inspect(src),moves=[{sourcePageIndex:0,annotationIndex:1,outputPageIndex:1,dx:0,dy:-50},move],out=await api.transport(args(model,src,{moves}));
  const doc=new mupdf.PDFDocument(out.pdf);try{assert.equal(doc.findPage(0).get('Annots').length,0);assert.equal(doc.findPage(1).get('Annots').length,3);assert.equal(doc.findPage(1).get('Annots',1,'Dest').asString(),'namedTarget');assert.deepEqual(values(doc.findPage(1).get('Annots',2,'Rect')),[50,170,130,185]);}finally{doc.destroy();}
});
test('new destination Annots array is localized even if its empty array is shared elsewhere',async()=>{
  const src=source(),model=await inspect(src),staged=mutate(src,d=>{d.insertPage(1,d.addPage([0,0,300,400],0,{},''));const shared=d.addObject([]);d.findPage(1).put('Annots',shared);d.findPage(3).put('Annots',shared);}),sourcePageMap=[{sourcePageIndex:0,outputPageIndex:0},{sourcePageIndex:1,outputPageIndex:2},{sourcePageIndex:2,outputPageIndex:3}];
  const out=await api.transport(args(model,src,{outputBytes:staged,sourcePageMap,moves:[{...move,outputPageIndex:1}]})),doc=new mupdf.PDFDocument(out.pdf);try{assert.equal(doc.findPage(1).get('Annots').length,1);assert.equal(doc.findPage(3).get('Annots').length,0);}finally{doc.destroy();}
});
test('unresolved destinations outside the changed owner page still block a potentially affected target',async()=>{
  const src=mutate(source(),d=>d.findPage(0).get('Annots',1).put('Dest',[0,'XYZ',25,375,null])),model=await inspect(src);assert.equal(model.annotations[1].destinationUnresolved,true);
  await assert.rejects(()=>api.transport(args(model,src,{moves:[],reflowedSourcePages:[1]})),{code:'annotation-destination-unresolved'});
});
test('new rotation, wrong owner, shared output object and changed URI are rejected',async()=>{
  const src=source(),model=await inspect(src),output=(await api.transport(args(model,src))).pdf;
  for(const change of [d=>d.findPage(1).put('Rotate',90),d=>d.findPage(1).get('Annots',1).put('P',d.findPage(0)),d=>d.findPage(2).put('Annots',[d.findPage(1).get('Annots',1)]),d=>d.findPage(1).get('Annots',1,'A').put('URI',d.newString('https://changed.invalid'))])assert.equal((await api.validate(args(model,src,{outputBytes:mutate(output,change)}))).ok,false);
});

test('unknown cyclic private graph survives; raw stream traversal cap refuses instead of dropping data',async()=>{
  const src=mutate(source(),d=>{const cycle=d.addObject({UnknownKey:d.newString('cycle-data')});cycle.put('Self',cycle);d.findPage(0).get('Annots',0).put('PrivateUnknown',cycle);}),model=await inspect(src),out=await api.transport(args(model,src));assert.equal((await api.validate(args(model,src,{outputBytes:out.pdf}))).ok,true);
  const huge=mutate(source(),d=>d.findPage(0).get('Annots',0).put('PrivateUnknown',d.addStream(new Uint8Array(ANNOTATION_LIMITS.streamBytes+1),{})));await assert.rejects(()=>inspect(huge),{code:'annotation-stream-limit'});
});

test('used named destination catalog page, coordinates, mode, definition and key remain source-bound',async()=>{
  const src=source(),model=await inspect(src),output=(await api.transport(args(model,src))).pdf;
  const changes=[
    d=>d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,{D:[d.findPage(0),'XYZ',25,375,null]}),
    d=>d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,{D:[d.findPage(2),'XYZ',250,10,null]}),
    d=>d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,{D:[d.findPage(2),'Fit']}),
    d=>d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(0,d.newString('different-name')),
    d=>d.getTrailer().get('Root','Names','Dests','Kids',0,'Names',1).put('PrivateUnknown',d.newString('changed-definition')),
  ];
  for(const change of changes){assert.equal((await api.validate(args(model,src,{outputBytes:mutate(output,change)}))).ok,false);await assert.rejects(()=>api.transport(args(model,src,{outputBytes:mutate(src,change)})));}
  const unused=mutate(output,d=>d.getTrailer().get('Root','Dests').put('legacyTarget',[d.findPage(2),'XYZ',222,333,null]));assert.equal((await api.validate(args(model,src,{outputBytes:unused}))).ok,true,'unused definitions are not blanket-fingerprinted');
});
test('used legacy destination and alias-chain definitions bind full normalized resolved values',async()=>{
  for(const alias of [false,true]){
    const src=mutate(source(),d=>{if(alias)d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,d.newName('legacyTarget'));else d.findPage(0).get('Annots',1).put('Dest',d.newName('legacyTarget'));}),model=await inspect(src),output=(await api.transport(args(model,src))).pdf;
    for(const target of [0,2]){const bad=mutate(output,d=>d.getTrailer().get('Root','Dests').put('legacyTarget',[d.findPage(target),'XYZ',250,10,null]));assert.equal((await api.validate(args(model,src,{outputBytes:bad}))).ok,false);}
  }
});
test('AA hidden GoTo and other unproved action-owned roots conservatively block transport',async()=>{
  const roots=[
    d=>d.findPage(0).get('Annots',0).put('AA',{E:{S:'GoTo',D:[d.findPage(0),'XYZ',25,375,null]}}),
    d=>d.findPage(0).get('Annots',0).put('PA',{S:'URI',URI:d.newString('https://previous.invalid/never-open')}),
    d=>d.findPage(2).put('AA',{O:{S:'GoTo',D:[d.findPage(0),'XYZ',25,375,null]}}),
    d=>d.getTrailer().get('Root').put('OpenAction',[d.findPage(0),'XYZ',25,375,null]),
    d=>d.getTrailer().get('Root').put('AA',{WC:{S:'GoTo',D:[d.findPage(0),'XYZ',25,375,null]}}),
  ];
  for(const add of roots){const src=mutate(source(),add),model=await inspect(src);assert.equal(model.actionOwnershipUnsupported,true);assert.equal(model.annotations[0].eligible,false);await assert.rejects(()=>api.transport(args(model,src)),{code:'annotation-action-root-unsupported'});}
  const src=source(),model=await inspect(src),output=(await api.transport(args(model,src))).pdf;
  for(const add of roots)assert.equal((await api.validate(args(model,src,{outputBytes:mutate(output,add)}))).ok,false);
});

test('a proven source missing named target remains missing before/after transport, with fixed warning and no raw key',async()=>{
  for(const alias of [false,true]){
    const src=mutate(source(),d=>{if(alias)d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,d.newName('genuinelyMissing'));else d.findPage(0).get('Annots',1).put('Dest',d.newString('genuinelyMissing'));}),model=await inspect(src);assert.equal(model.annotations[1].eligible,true);assert.equal(model.annotations[1].preservedMissingDestination,true);assert.deepEqual(model.annotations[1].internalDestinationSourcePageIndices,[]);assert.ok(!JSON.stringify(model).includes('genuinelyMissing'));
    const out=await api.transport(args(model,src)),check=await api.validate(args(model,src,{outputBytes:out.pdf}));assert.equal(check.ok,true);assert.ok(check.warnings.some(w=>w.code==='source-broken-link-preserved'&&w.annotationIndex===1));assert.ok(out.report.warnings.length);assert.ok(!JSON.stringify(out.report).includes('genuinelyMissing'));
    for(const target of [0,2])for(const legacy of [false,true]){
      const add=d=>{if(legacy)d.getTrailer().get('Root','Dests').put('genuinelyMissing',[d.findPage(target),'XYZ',25,375,null]);else{const arr=d.getTrailer().get('Root','Names','Dests','Kids',0,'Names');arr.push(d.newString('genuinelyMissing'));arr.push([d.findPage(target),'XYZ',25,375,null]);}};
      assert.equal((await api.validate(args(model,src,{outputBytes:mutate(out.pdf,add)}))).ok,false);await assert.rejects(()=>api.transport(args(model,src,{outputBytes:mutate(src,add)})));
    }
    const change=d=>{if(alias)d.getTrailer().get('Root','Names','Dests','Kids',0,'Names').put(1,d.newName('differentMissing'));else d.findPage(0).get('Annots',0).put('Dest',d.newString('differentMissing'));};assert.equal((await api.validate(args(model,src,{outputBytes:mutate(out.pdf,change)}))).ok,false);
  }
});
test('missing-name equality does not allow malformed name catalogs, duplicate definitions, unknown arrays or AA',async()=>{
  for(const change of [d=>d.getTrailer().get('Root').put('Dests',[]),d=>d.getTrailer().get('Root').put('Names',[])]){
    const src=mutate(source(),d=>{d.findPage(0).get('Annots',1).put('Dest',d.newString('missing'));change(d);});await assert.rejects(()=>inspect(src),{code:'annotation-destination-invalid'});
  }
  const duplicate=mutate(source(),d=>{const arr=d.getTrailer().get('Root','Names','Dests','Kids',0,'Names');arr.push(d.newString('namedTarget'));arr.push([d.findPage(2),'XYZ',25,375,null]);}),dm=await inspect(duplicate);assert.equal(dm.annotations[1].eligible,false);assert.notEqual(dm.annotations[1].preservedMissingDestination,true);
  const aa=mutate(source(),d=>{d.findPage(0).get('Annots',1).put('Dest',d.newString('missing'));d.findPage(0).get('Annots',1).put('AA',{E:{S:'GoTo',D:[d.findPage(0),'XYZ',25,375,null]}});}),am=await inspect(aa);assert.equal(am.annotations[1].eligible,false);await assert.rejects(()=>api.transport(args(am,aa)),{code:'annotation-action-root-unsupported'});
});

test('absent Names/Dests allow URI and proved-missing links; legacy-only catalogs still resolve',async()=>{
  const make=kind=>{const d=new mupdf.PDFDocument();try{for(let i=0;i<2;i++)d.insertPage(-1,d.addPage([0,0,300,400],0,{},''));const p0=d.findPage(0),p1=d.findPage(1),catalog=d.getTrailer().get('Root');if(kind==='legacy')catalog.put('Dests',{target:[p1,'XYZ',25,375,null]});const link={Type:'Annot',Subtype:'Link',Rect:[30,250,110,265],P:p0};if(kind==='uri')link.A={S:'URI',URI:d.newString('https://example.invalid/never-open')};else link.Dest=d.newString(kind==='legacy'?'target':'provablyAbsent');p0.put('Annots',[d.addObject(link)]);return save(d);}finally{d.destroy();}};
  for(const kind of ['uri','missing','legacy']){const src=make(kind),model=await inspect(src);assert.equal(model.annotations[0].eligible,true);assert.equal(model.annotations[0].preservedMissingDestination===true,kind==='missing');const request={model,sourceBytes:src,outputBytes:src,sourcePageMap:[{sourcePageIndex:0,outputPageIndex:0},{sourcePageIndex:1,outputPageIndex:1}],moves:[{sourcePageIndex:0,annotationIndex:0,outputPageIndex:1,dx:20,dy:-80}],reflowedSourcePages:[0]};const out=await api.transport(request);assert.equal((await api.validate({...request,outputBytes:out.pdf})).ok,true);}
  const malformed=mutate(make('uri'),d=>d.getTrailer().get('Root').put('Names',[]));await assert.rejects(()=>inspect(malformed),{code:'annotation-destination-invalid'});
});

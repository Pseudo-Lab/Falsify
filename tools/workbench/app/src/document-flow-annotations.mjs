/* AGPL-3.0-only. Annotation transport over the already pinned MuPDF raw PDFObject API.
 * No engine import, action execution, URI opening, or annotation reconstruction. */
export const ANNOTATION_LIMITS=Object.freeze({sourceBytes:25*1024*1024,outputBytes:64*1024*1024,pages:200,
  annotations:2000,depth:20,objects:200000,streamBytes:4*1024*1024,stringBytes:4*1024*1024});
export class AnnotationTransportError extends Error{constructor(code){super(code);this.name='AnnotationTransportError';this.code=code;}}
const fail=code=>{throw new AnnotationTransportError(code);};
const privateModels=new WeakMap();
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
const frozen=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))frozen(v);Object.freeze(value);}return value;};
const numbers=(a,b)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<=0.001);
const contains=(a,b)=>a[0]-.001<=b[0]&&a[1]-.001<=b[1]&&a[2]+.001>=b[2]&&a[3]+.001>=b[3];
const key=(p,i)=>p+':'+i;
const identity=o=>o.isIndirect()?'r'+o.asIndirect():'d'+o.pointer;
function bytes(value,limit){if(!(value instanceof Uint8Array)||value.length<5||value.length>limit)fail('annotation-byte-limit');return value.slice();}
function context(mupdf,source){
  if(!mupdf?.PDFDocument)fail('annotation-engine-unavailable');
  let doc;try{doc=new mupdf.PDFDocument(source);if(doc.needsPassword()||doc.countPages()<1||doc.countPages()>ANNOTATION_LIMITS.pages)fail('annotation-document-unsupported');}
  catch(error){doc?.destroy();if(error?.code)throw error;fail('annotation-document-invalid');}
  const arena=[];const keep=o=>{if(!o.isNull())arena.push(o);return o;};
  return {doc,keep,get:(o,...p)=>keep(o.get(...p)),close(){for(const o of arena.reverse())o.destroy();doc.destroy();}};
}
function numericArray(c,obj,multiple,minimum=multiple){
  if(!obj.isArray()||obj.length<minimum||obj.length%multiple)fail('annotation-geometry-invalid');
  const out=[];if(obj.length>ANNOTATION_LIMITS.objects)fail('annotation-object-limit');
  for(let i=0;i<obj.length;i++){const n=c.get(obj,i);if(!n.isNumber()||!Number.isFinite(n.asNumber())||Math.abs(n.asNumber())>100000)fail('annotation-geometry-invalid');out.push(n.asNumber());}
  return out;
}
function rectangle(c,obj){const r=numericArray(c,obj,4);if(r.length!==4||r[0]>=r[2]||r[1]>=r[3])fail('annotation-geometry-invalid');return r;}
function geometry(c,page){
  const media=rectangle(c,c.keep(page.getInheritable('MediaBox'))),crop=c.keep(page.getInheritable('CropBox')),rotate=c.keep(page.getInheritable('Rotate')),unit=c.get(page,'UserUnit');
  if((!rotate.isNull()&&(!rotate.isNumber()||rotate.asNumber()%360!==0))||media[0]!==0||media[1]!==0||(!crop.isNull()&&!numbers(media,rectangle(c,crop)))||(!unit.isNull()&&unit.asNumber()!==1))fail('annotation-page-geometry-unsupported');
  return media;
}
function pageRefs(c,map){
  const refs=new Map(),pages=[];
  for(let i=0;i<c.doc.countPages();i++){const page=c.keep(c.doc.findPage(i));if(!page.isIndirect())fail('annotation-page-identity-invalid');pages.push(page);refs.set(page.asIndirect(),map?.get(i)??['new-page',i]);}
  return {refs,pages};
}
function entries(c,obj){const list=[];obj.forEach((value,name)=>list.push([name,c.keep(value)]));return list.sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'en'));}
async function fingerprint(c,annotation,refs,full=false,budget={objects:0,streams:0,strings:0}){
  const seen=new Map();
  function canonical(obj,depth,root=false){
    if(depth>ANNOTATION_LIMITS.depth||++budget.objects>ANNOTATION_LIMITS.objects)fail('annotation-object-limit');
    if(obj.isNull())return ['null'];
    if(obj.isIndirect()){
      const num=obj.asIndirect();if(refs.has(num))return ['page',...refs.get(num)];
      if(seen.has(num))return ['ref',seen.get(num)];
      const index=seen.size;seen.set(num,index);return ['object',index,canonical(c.keep(obj.resolve()),depth+1,root)];
    }
    if(obj.isBoolean())return ['bool',obj.asBoolean()];
    if(obj.isNumber()){const n=obj.asNumber();if(!Number.isFinite(n))fail('annotation-object-invalid');return ['number',n];}
    if(obj.isName())return ['name',obj.asName()];
    if(obj.isString()){const data=obj.asByteString();budget.strings+=data.length;if(budget.strings>ANNOTATION_LIMITS.stringBytes)fail('annotation-string-limit');return ['string',hex(data)];}
    if(obj.isArray()){
      if(obj.length>ANNOTATION_LIMITS.objects)fail('annotation-object-limit');
      return ['array',Array.from({length:obj.length},(_,i)=>canonical(c.get(obj,i),depth+1))];
    }
    if(obj.isDictionary())return ['dict',entries(c,obj).filter(([name])=>full||!root||!['Rect','P','QuadPoints'].includes(name)).map(([name,value])=>[name,canonical(value,depth+1)])];
    fail('annotation-object-invalid');
  }
  // Stream tests must use the indirect reference: its resolved dictionary alone cannot read the stream.
  function streamData(obj,walkSeen=new Set(),depth=0,root=true){
    if(depth>ANNOTATION_LIMITS.depth)fail('annotation-object-limit');
    if(obj.isIndirect()){
      const num=obj.asIndirect();if(refs.has(num)||walkSeen.has(num))return null;walkSeen.add(num);
      if(obj.isStream()){
        const buffer=obj.readRawStream();try{const raw=buffer.asUint8Array();budget.streams+=raw.length;if(budget.streams>ANNOTATION_LIMITS.streamBytes)fail('annotation-stream-limit');return ['stream',hex(raw),streamData(c.keep(obj.resolve()),walkSeen,depth+1,root)];}finally{buffer.destroy();}
      }
      return streamData(c.keep(obj.resolve()),walkSeen,depth+1,root);
    }
    if(obj.isArray())return Array.from({length:obj.length},(_,i)=>streamData(c.get(obj,i),walkSeen,depth+1,false));
    if(obj.isDictionary())return entries(c,obj).filter(([name])=>full||!root||!['Rect','P','QuadPoints'].includes(name)).map(([name,value])=>[name,streamData(value,walkSeen,depth+1,false)]);
    return null;
  }
  const value=JSON.stringify([canonical(annotation,0,true),streamData(annotation)]);
  return digest(new TextEncoder().encode(value));
}
function nameDestinations(c){
  const catalog=c.get(c.doc.getTrailer(),'Root'),lookup=new Map(),seen=new Set();let count=0;
  const put=(name,value)=>{if(++count>ANNOTATION_LIMITS.objects)fail('annotation-object-limit');lookup.set(name,lookup.has(name)?null:value);};
  const legacy=c.get(catalog,'Dests');if(!legacy.isNull()&&!legacy.isDictionary())fail('annotation-destination-invalid');if(legacy.isDictionary())for(const [name,value]of entries(c,legacy))put(name,value);
  function visit(node,depth){
    if(node.isNull())return;if(depth>ANNOTATION_LIMITS.depth||!node.isDictionary())fail('annotation-destination-invalid');
    const id=identity(node);if(seen.has(id))fail('annotation-destination-invalid');seen.add(id);
    const names=c.get(node,'Names');if(!names.isNull()){
      if(!names.isArray()||names.length%2||names.length>2*ANNOTATION_LIMITS.objects)fail('annotation-destination-invalid');
      for(let i=0;i<names.length;i+=2){const name=c.get(names,i);if(!name.isString())fail('annotation-destination-invalid');put(name.asString(),c.get(names,i+1));}
    }
    const kids=c.get(node,'Kids');if(!kids.isNull()){if(!kids.isArray()||kids.length>ANNOTATION_LIMITS.objects)fail('annotation-destination-invalid');for(let i=0;i<kids.length;i++)visit(c.get(kids,i),depth+1);}
  }
  const namesRoot=c.get(catalog,'Names');if(!namesRoot.isNull()&&!namesRoot.isDictionary())fail('annotation-destination-invalid');if(!namesRoot.isNull())visit(c.get(namesRoot,'Dests'),0);return lookup;
}
function destinationReader(c,refs,names){
  let usedValues=[],missingNames=[],destinations=[],destinationObjects=[],unexposedTargets=[];
  const destinationIds=new Map();
  function resolve(value,seen=new Set(),depth=0){
    if(depth>ANNOTATION_LIMITS.depth)fail('annotation-destination-invalid');
    usedValues.push(value);
    if(value.isName()||value.isString()){
      const name=value.isName()?value.asName():value.asString();if(!names.has(name)){missingNames.push(name);return null;}if(seen.has(name)||names.get(name)===null)fail('annotation-destination-unresolved');seen.add(name);return resolve(names.get(name),seen,depth+1);
    }
    if(value.isDictionary())return resolve(c.get(value,'D'),seen,depth+1);
    if(!value.isArray()||value.length<2)fail('annotation-destination-unresolved');
    const page=c.get(value,0),mode=c.get(value,1),length={XYZ:5,Fit:2,FitB:2,FitH:3,FitBH:3,FitV:3,FitBV:3,FitR:6}[mode.asName()];
    if(!page.isIndirect()||!refs.has(page.asIndirect())||!length||value.length!==length)fail('annotation-destination-unresolved');
    for(let i=2;i<value.length;i++){const n=c.get(value,i);if(!n.isNull()&&(!n.isNumber()||!Number.isFinite(n.asNumber())))fail('annotation-destination-invalid');}
    const targetSourcePageIndex=refs.get(page.asIndirect())[1], id=identity(value);
    if(!destinationIds.has(id))destinationIds.set(id,destinationIds.size);
    const operands=Array.from({length:value.length-2},(_,i)=>{const n=c.get(value,i+2);return n.isNull()?null:n.asNumber();});
    if(operands.every(n=>n===null||Math.abs(n)<=100000)){destinations.push({id:destinationIds.get(id),kind:mode.asName(),targetSourcePageIndex,operands});destinationObjects.push(value);}else unexposedTargets.push(targetSourcePageIndex);
    return targetSourcePageIndex;
  }
  function actions(action,targets,visited=new Set(),depth=0){
    if(depth>ANNOTATION_LIMITS.depth)fail('annotation-destination-invalid');
    if(action.isArray()){if(action.length>ANNOTATION_LIMITS.objects)fail('annotation-object-limit');for(let i=0;i<action.length;i++)actions(c.get(action,i),targets,visited,depth+1);return null;}
    if(!action.isDictionary())fail('annotation-action-target-unsupported');
    const id=identity(action);if(visited.has(id))fail('annotation-destination-invalid');visited.add(id);
    const type=c.get(action,'S').asName();let destination;
    if(type==='URI'){if(!c.get(action,'URI').isString())fail('annotation-action-target-unsupported');destination={type:'uri'};}
    else if(type==='GoTo'){const target=resolve(c.get(action,'D'));if(target!==null)targets.push(target);destination=target===null?{type:'internal'}:{type:'internal',targetSourcePageIndex:target};}
    else fail('annotation-action-target-unsupported');
    const next=c.get(action,'Next');if(!next.isNull())actions(next,targets,visited,depth+1);
    return destination;
  }
  return annotation=>{
    usedValues=[];missingNames=[];destinations=[];destinationObjects=[];unexposedTargets=[];const targets=[],dest=c.get(annotation,'Dest'),action=c.get(annotation,'A');let destination;
    if(!dest.isNull()&&!action.isNull())fail('annotation-destination-ambiguous');
    if(!dest.isNull()){const target=resolve(dest);if(target!==null)targets.push(target);destination=target===null?{type:'internal'}:{type:'internal',targetSourcePageIndex:target};}
    else if(!action.isNull())destination=actions(action,targets);
    else fail('annotation-destination-unresolved');
    return {destination,targets:[...new Set(targets)],destinations,destinationObjects,unexposedTargets,values:usedValues,missingNames:[...new Set(missingNames)]};
  };
}
function unsupportedDocumentActions(c,pages){const catalog=c.get(c.doc.getTrailer(),'Root');return !c.get(catalog,'AA').isNull()||!c.get(catalog,'OpenAction').isNull()||pages.some(page=>!c.get(page,'AA').isNull());}
function annotationArray(c,page){const value=c.get(page,'Annots');if(!value.isNull()&&!value.isArray())fail('annotation-array-invalid');return value;}
async function inventory(c,refs,pages,source=false){
  const records=[],byPage=[],shared=new Map(),budget={objects:0,streams:0,strings:0};let count=0;
  for(let p=0;p<pages.length;p++){
    const array=annotationArray(c,pages[p]),list=[];byPage.push(list);
    for(let i=0;i<array.length;i++){
      if(++count>ANNOTATION_LIMITS.annotations)fail('annotation-count-limit');
      const annotation=c.get(array,i);if(!annotation.isDictionary())fail('annotation-object-invalid');
      const id=identity(annotation),record={sourcePageIndex:p,annotationIndex:i,object:annotation,fingerprint:await fingerprint(c,annotation,refs,false,budget),fullFingerprint:await fingerprint(c,annotation,refs,true,budget)};
      if(shared.has(id)){record.shared=true;shared.get(id).shared=true;}else shared.set(id,record);
      records.push(record);list.push(record);
    }
  }
  return {records,byPage};
}
function sourceWarnings(records){return records.filter(r=>r.descriptor.preservedMissingDestination).map(r=>({code:'source-broken-link-preserved',sourcePageIndex:r.sourcePageIndex,annotationIndex:r.annotationIndex}));}
/** Returns only fixed-vocabulary descriptors and numeric geometry. All full dictionary fingerprints stay private. */
export async function inspect({mupdf,sourceBytes,sourceSha256}={}){
  const source=bytes(sourceBytes,ANNOTATION_LIMITS.sourceBytes),sha=await digest(source);
  if(sha!==sourceSha256)fail('annotation-stale-source');
  const c=context(mupdf,source);
  try{
    const identities=new Map(Array.from({length:c.doc.countPages()},(_,i)=>[i,['source-page',i]])),{refs,pages}=pageRefs(c,identities),catalog=c.get(c.doc.getTrailer(),'Root');
    const tagged=!c.get(catalog,'StructTreeRoot').isNull()||c.get(catalog,'MarkInfo','Marked').asBoolean();
    const actionOwnershipUnsupported=unsupportedDocumentActions(c,pages),destinationBudget={objects:0,streams:0,strings:0};
    const names=nameDestinations(c),readDestination=destinationReader(c,refs,names),snapshot=await inventory(c,refs,pages,true),annotations=[];
    for(const record of snapshot.records){
      const annotation=record.object,descriptor={sourcePageIndex:record.sourcePageIndex,annotationIndex:record.annotationIndex,kind:c.get(record.object,'Subtype').asName()==='Link'?'link':'unsupported',eligible:true};
      record.actionOwnershipUnsafe=actionOwnershipUnsupported||!c.get(annotation,'AA').isNull()||!c.get(annotation,'PA').isNull();
      try{
        if(record.actionOwnershipUnsafe)fail('annotation-action-root-unsupported');
        const subtype=c.get(annotation,'Subtype').asName();if(subtype!=='Link'){descriptor.kind='unsupported';fail('annotation-subtype-unsupported');}
        const media=geometry(c,pages[record.sourcePageIndex]);record.media=media;descriptor.rect=rectangle(c,c.get(annotation,'Rect'));if(!contains(media,descriptor.rect))fail('annotation-geometry-invalid');
        const quads=c.get(annotation,'QuadPoints');if(!quads.isNull()){descriptor.quadPoints=numericArray(c,quads,8);for(let i=0;i<descriptor.quadPoints.length;i+=2)if(!contains(descriptor.rect,[descriptor.quadPoints[i],descriptor.quadPoints[i+1],descriptor.quadPoints[i],descriptor.quadPoints[i+1]]))fail('annotation-geometry-invalid');}
        const owner=c.get(annotation,'P');record.hadP=!owner.isNull();if(record.hadP&&(!owner.isIndirect()||owner.asIndirect()!==pages[record.sourcePageIndex].asIndirect()))fail('annotation-page-owner-invalid');
        if(record.shared)fail('annotation-shared-object');
        if(tagged||!c.get(annotation,'StructParent').isNull()||!c.get(annotation,'StructParents').isNull()||!c.get(pages[record.sourcePageIndex],'StructParents').isNull())fail('annotation-tagged-ownership');
        const resolved=readDestination(annotation);record.destinationFingerprints=await Promise.all(resolved.values.map(value=>fingerprint(c,value,refs,true,destinationBudget)));record.missingDestinationNames=resolved.missingNames;record.unexposedTargets=resolved.unexposedTargets;if(resolved.missingNames.length)descriptor.preservedMissingDestination=true;descriptor.destination=resolved.destination;descriptor.internalDestinationSourcePageIndices=resolved.targets;descriptor.internalDestinations=resolved.destinations;
      }catch(error){descriptor.eligible=false;descriptor.reason=error?.code||'annotation-object-invalid';}
      if(!descriptor.destination){const hasTarget=!c.get(annotation,'Dest').isNull()||!c.get(annotation,'A').isNull();if(hasTarget||descriptor.kind==='link')try{const resolved=readDestination(annotation);record.destinationFingerprints=await Promise.all(resolved.values.map(value=>fingerprint(c,value,refs,true,destinationBudget)));record.missingDestinationNames=resolved.missingNames;record.unexposedTargets=resolved.unexposedTargets;if(resolved.missingNames.length)descriptor.preservedMissingDestination=true;descriptor.destination=resolved.destination;descriptor.internalDestinationSourcePageIndices=resolved.targets;descriptor.internalDestinations=resolved.destinations;}catch{record.destinationUnsafe=true;descriptor.destinationUnresolved=true;}}
      record.descriptor=descriptor;annotations.push(descriptor);
    }
    // Unsupported annotation geometry is still retained privately for no-op validation.
    for(const record of snapshot.records){
      if(!record.descriptor.rect)try{record.descriptor.rect=rectangle(c,c.get(record.object,'Rect'));}catch{}
      if(record.hadP===undefined)record.hadP=!c.get(record.object,'P').isNull();
    }
    const model=frozen({schema:'falsify.flow-annotations.v1',sourceSha256:sha,pageCount:pages.length,actionOwnershipUnsupported:actionOwnershipUnsupported||snapshot.records.some(r=>r.actionOwnershipUnsafe),warnings:sourceWarnings(snapshot.records),annotations});
    privateModels.set(model,{mupdf,sha,actionOwnershipUnsupported:model.actionOwnershipUnsupported,records:snapshot.records.map(({object,...record})=>record),pageGeometry:pages.map(page=>{try{return geometry(c,page);}catch{return null;}})});return model;
  }catch(error){if(error instanceof AnnotationTransportError)throw error;fail('annotation-inspection-failed');}finally{c.close();}
}
function mapping(model,map,count){
  if(!Array.isArray(map)||map.length!==model.pageCount)fail('annotation-page-map-invalid');
  const result=new Map(),output=new Set();
  for(const row of map){if(!Number.isInteger(row?.sourcePageIndex)||row.sourcePageIndex<0||row.sourcePageIndex>=model.pageCount||result.has(row.sourcePageIndex)||!Number.isInteger(row.outputPageIndex)||row.outputPageIndex<0||row.outputPageIndex>=count||output.has(row.outputPageIndex))fail('annotation-page-map-invalid');result.set(row.sourcePageIndex,row.outputPageIndex);output.add(row.outputPageIndex);}
  return result;
}
function movementPlan(model,records,map,count,moves,reflowed,destinationMoves=[]){
  if(!Array.isArray(moves)||moves.length>ANNOTATION_LIMITS.annotations||!Array.isArray(reflowed)||reflowed.some(p=>!Number.isInteger(p)||p<0||p>=model.pageCount)||new Set(reflowed).size!==reflowed.length)fail('annotation-move-invalid');
  const group=new Set(reflowed),byKey=new Map(records.map(r=>[key(r.sourcePageIndex,r.annotationIndex),r])),planned=new Map();
  for(const move of moves){
    if(!move||Object.keys(move).sort().join(',')!=='annotationIndex,dx,dy,outputPageIndex,sourcePageIndex'||!Number.isInteger(move.sourcePageIndex)||!Number.isInteger(move.annotationIndex)||!Number.isInteger(move.outputPageIndex)||move.outputPageIndex<0||move.outputPageIndex>=count||![move.dx,move.dy].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000))fail('annotation-move-invalid');
    const id=key(move.sourcePageIndex,move.annotationIndex),record=byKey.get(id);if(!record||planned.has(id)||!record.descriptor.eligible||!group.has(move.sourcePageIndex))fail('annotation-move-invalid');planned.set(id,move);
  }
  if(!Array.isArray(destinationMoves)||destinationMoves.length>ANNOTATION_LIMITS.annotations)fail('annotation-destination-move-invalid');
  const destinations=new Map();
  for(const record of records)for(const d of record.descriptor.internalDestinations||[]){
    const old=destinations.get(d.id);if(old&&JSON.stringify(old)!==JSON.stringify(d))fail('annotation-destination-move-invalid');destinations.set(d.id,d);
  }
  const destinationPlan=new Map();
  for(const move of destinationMoves){
    if(!move||Object.keys(move).sort().join(',')!=='dx,dy,id,outputPageIndex,sourcePageIndex'||!Number.isInteger(move.id)||!Number.isInteger(move.sourcePageIndex)||!Number.isInteger(move.outputPageIndex)||move.outputPageIndex<0||move.outputPageIndex>=count||![move.dx,move.dy].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000))fail('annotation-destination-move-invalid');
    const d=destinations.get(move.id);if(!d||destinationPlan.has(move.id)||d.kind!=='FitR'||d.targetSourcePageIndex!==move.sourcePageIndex||!group.has(move.sourcePageIndex)||d.operands.length!==4||!d.operands.every(n=>typeof n==='number'&&Number.isFinite(n)))fail('annotation-destination-move-invalid');
    const operands=d.operands.map((n,i)=>n+(i%2?move.dy:move.dx));if(!operands.every(n=>Number.isFinite(n)&&Math.abs(n)<=100000)||operands[0]>=operands[2]||operands[1]>=operands[3])fail('annotation-destination-move-invalid');
    destinationPlan.set(move.id,{move,descriptor:d,operands});
  }
  for(const record of records){
    const d=record.descriptor;if(record.shared)fail('annotation-shared-object');
    if(group.size&&record.actionOwnershipUnsafe)fail('annotation-action-root-unsupported');
    if(group.size&&record.destinationUnsafe)fail('annotation-destination-unresolved');
    if((record.unexposedTargets||[]).some(p=>group.has(p)))fail('annotation-destination-reflowed');
    if(group.has(record.sourcePageIndex)&&!d.eligible)fail(d.reason);
    if((d.internalDestinationSourcePageIndices||[]).some(p=>group.has(p)&&(!(d.internalDestinations||[]).some(x=>x.targetSourcePageIndex===p)||(d.internalDestinations||[]).some(x=>x.targetSourcePageIndex===p&&!destinationPlan.has(x.id)))))fail('annotation-destination-reflowed');
  }
  const expected=Array.from({length:count},()=>[]);
  for(const record of records){const id=key(record.sourcePageIndex,record.annotationIndex),move=planned.get(id),origin=map.get(record.sourcePageIndex);if(!move||move.outputPageIndex===origin)expected[origin].push({record,move});}
  for(const move of moves){const record=byKey.get(key(move.sourcePageIndex,move.annotationIndex));if(move.outputPageIndex!==map.get(move.sourcePageIndex))expected[move.outputPageIndex].push({record,move});}
  return {expected,planned,destinationPlan};
}
async function bound({model,sourceBytes,outputBytes,sourcePageMap,moves=[],reflowedSourcePages=[],destinationMoves=[]}){
  const state=privateModels.get(model);if(!state)fail('annotation-model-unverified');
  if(await digest(bytes(sourceBytes,ANNOTATION_LIMITS.sourceBytes))!==state.sha)fail('annotation-stale-source');
  const c=context(state.mupdf,bytes(outputBytes,ANNOTATION_LIMITS.outputBytes));
  try{
    if(reflowedSourcePages.length&&state.actionOwnershipUnsupported)fail('annotation-action-root-unsupported');
    const map=mapping(model,sourcePageMap,c.doc.countPages()),inverse=new Map([...map].map(([s,o])=>[o,['source-page',s]])),{refs,pages}=pageRefs(c,inverse),plan=movementPlan(model,state.records,map,pages.length,moves,reflowedSourcePages,destinationMoves);
    if(reflowedSourcePages.length&&unsupportedDocumentActions(c,pages))fail('annotation-action-root-unsupported');
    for(const [s,o]of map)if(state.pageGeometry[s]&&!numbers(state.pageGeometry[s],geometry(c,pages[o])))fail('annotation-page-identity-invalid');
    return {c,state,map,refs,pages,plan};
  }catch(error){c.close();throw error;}
}
async function verifyDocument(ctx,expected,after=false){
  const {c,refs,pages}=ctx, restore=[], seen=new Map(), reader=destinationReader(c,refs,nameDestinations(c));
  try {
    // Resolve in source-record order so opaque IDs and shared array identity stay bound.
    for(const record of ctx.state.records){
      let found;for(let p=0;p<expected.length&&!found;p++){const i=expected[p].findIndex(x=>x.record===record);if(i>=0)found=c.get(annotationArray(c,pages[p]),i);}
      if(!found)fail('annotation-output-count-mismatch');
      if(!record.destinationFingerprints)continue;
      const resolved=reader(found),original=record.descriptor.internalDestinations||[];
      if(resolved.destinations.length!==original.length)fail('annotation-destination-definition-mismatch');
      for(let i=0;i<original.length;i++){
        const old=original[i],current=resolved.destinations[i],obj=resolved.destinationObjects[i],id=identity(obj),previous=seen.get(old.id);
        if(previous!==undefined&&previous!==id)fail('annotation-destination-definition-mismatch');
        if([...seen].some(([other,value])=>other!==old.id&&value===id))fail('annotation-destination-definition-mismatch');seen.set(old.id,id);
        const change=ctx.plan.destinationPlan.get(old.id),target=after&&change?change.move.outputPageIndex:ctx.map.get(old.targetSourcePageIndex),operands=after&&change?change.operands:old.operands;
        const page=c.get(obj,0);if(current.kind!==old.kind||!page.isIndirect()||page.asIndirect()!==pages[target].asIndirect()||JSON.stringify(current.operands)!==JSON.stringify(operands))fail('annotation-destination-definition-mismatch');
        if(after&&change&&!restore.some(x=>x.id===id))restore.push({id,obj,page,operands:current.operands,old});
      }
    }
    for(const item of restore){item.obj.put(0,pages[ctx.map.get(item.old.targetSourcePageIndex)]);item.old.operands.forEach((n,j)=>item.obj.put(j+2,n));}
    const actual=await inventory(c,refs,pages),names=nameDestinations(c),readDestination=destinationReader(c,refs,names),destinationBudget={objects:0,streams:0,strings:0};
  if(actual.records.some(r=>r.shared))fail('annotation-shared-object');
  for(let p=0;p<pages.length;p++){
    if(actual.byPage[p].length!==expected[p].length)fail('annotation-output-count-mismatch');
    for(let i=0;i<expected[p].length;i++){
      const {record,move}=expected[p][i],out=actual.byPage[p][i],d=record.descriptor;
      if((move?out.fingerprint:out.fullFingerprint)!==(move?record.fingerprint:record.fullFingerprint))fail('annotation-semantic-mismatch');
      if(record.destinationFingerprints){const resolved=readDestination(out.object),fingerprints=await Promise.all(resolved.values.map(value=>fingerprint(c,value,refs,true,destinationBudget)));if(JSON.stringify(fingerprints)!==JSON.stringify(record.destinationFingerprints)||JSON.stringify(resolved.missingNames)!==JSON.stringify(record.missingDestinationNames))fail('annotation-destination-definition-mismatch');}
      if(!move)continue;
      if(!d.rect)fail('annotation-geometry-invalid');
      const rect=d.rect.map((v,k)=>v+(move?(k%2?move.dy:move.dx):0));
      if(!numbers(rect,rectangle(c,c.get(out.object,'Rect'))))fail('annotation-output-geometry-mismatch');
      if(move&&!contains(geometry(c,pages[p]),rect))fail('annotation-output-geometry-mismatch');
      const quads=c.get(out.object,'QuadPoints');
      if(d.quadPoints){const expectedQuads=d.quadPoints.map((v,k)=>v+(move?(k%2?move.dy:move.dx):0));if(!numbers(expectedQuads,numericArray(c,quads,8)))fail('annotation-output-geometry-mismatch');}
      else if(!quads.isNull())fail('annotation-output-geometry-mismatch');
      const owner=c.get(out.object,'P');if(move||record.hadP){if(!owner.isIndirect()||owner.asIndirect()!==pages[p].asIndirect())fail('annotation-output-owner-mismatch');}
      else if(!owner.isNull())fail('annotation-output-owner-mismatch');
    }
  }
    return actual;
  } finally {for(const item of restore){item.obj.put(0,item.page);item.operands.forEach((n,j)=>item.obj.put(j+2,n));}}
}
/** Moves existing annotation PDFObjects within a private output document. Caller discards any failed result. */
export async function transport(request={}){
  const ctx=await bound(request);
  try{
    const noMoves=movementPlan(request.model,ctx.state.records,ctx.map,ctx.pages.length,[],request.reflowedSourcePages||[],request.destinationMoves||[]);
    const actual=await verifyDocument(ctx,noMoves.expected),located=new Map();
    for(const record of ctx.state.records)located.set(key(record.sourcePageIndex,record.annotationIndex),actual.byPage[ctx.map.get(record.sourcePageIndex)][record.annotationIndex].object);
    const reader=destinationReader(ctx.c,ctx.refs,nameDestinations(ctx.c)),changed=new Set();
    for(const record of ctx.state.records){if(!record.destinationFingerprints)continue;const resolved=reader(located.get(key(record.sourcePageIndex,record.annotationIndex)));
      for(let i=0;i<resolved.destinations.length;i++){const d=resolved.destinations[i],change=ctx.plan.destinationPlan.get(d.id);if(!change||changed.has(d.id))continue;
        const obj=resolved.destinationObjects[i];obj.put(0,ctx.pages[change.move.outputPageIndex]);change.operands.forEach((n,j)=>obj.put(j+2,n));changed.add(d.id);
      }
    }
    if(changed.size!==ctx.plan.destinationPlan.size)fail('annotation-destination-move-invalid');
    const touched=new Set();
    for(const move of request.moves||[]){
      const object=located.get(key(move.sourcePageIndex,move.annotationIndex)),record=ctx.state.records.find(r=>r.sourcePageIndex===move.sourcePageIndex&&r.annotationIndex===move.annotationIndex),d=record.descriptor;
      const rect=d.rect.map((v,k)=>v+(k%2?move.dy:move.dx));if(!contains(geometry(ctx.c,ctx.pages[move.outputPageIndex]),rect))fail('annotation-output-geometry-mismatch');
      object.put('Rect',rect);object.put('P',ctx.pages[move.outputPageIndex]);
      if(d.quadPoints)object.put('QuadPoints',d.quadPoints.map((v,k)=>v+(k%2?move.dy:move.dx)));
      touched.add(ctx.map.get(move.sourcePageIndex));touched.add(move.outputPageIndex);
    }
    for(const p of touched){const array=ctx.c.keep(ctx.c.doc.newArray());for(const {record}of ctx.plan.expected[p])array.push(located.get(key(record.sourcePageIndex,record.annotationIndex)));ctx.pages[p].put('Annots',array);}
    await verifyDocument(ctx,ctx.plan.expected,true);
    const buffer=ctx.c.doc.saveToBuffer('garbage=0,compress=false');let pdf;try{pdf=buffer.asUint8Array().slice();}finally{buffer.destroy();}
    const result=await validate({...request,outputBytes:pdf});if(!result.ok)fail(result.code);
    return {pdf,report:{check:'passed',moved:(request.moves||[]).length,checkedAnnotations:ctx.state.records.length,warnings:sourceWarnings(ctx.state.records)}};
  }catch(error){if(error instanceof AnnotationTransportError)throw error;fail('annotation-transport-failed');}finally{ctx.c.close();}
}
export async function validate(request={}){
  let ctx;try{ctx=await bound(request);await verifyDocument(ctx,ctx.plan.expected,true);return {ok:true,checkedAnnotations:ctx.state.records.length,moved:(request.moves||[]).length,warnings:sourceWarnings(ctx.state.records)};}
  catch(error){return {ok:false,code:error instanceof AnnotationTransportError?error.code:'annotation-validation-failed'};}
  finally{ctx?.c.close();}
}
export function createAnnotationTransport({mupdf}={}){return Object.freeze({inspect:request=>inspect({...request,mupdf}),transport,validate});}

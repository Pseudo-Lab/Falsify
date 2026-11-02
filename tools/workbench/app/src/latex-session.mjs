// Source-project adapter for the existing serialized generation queue.
import {hex} from './paragraph-pdf-crypto.mjs';
const copy=value=>structuredClone(value);
const abort=()=>Object.assign(new Error('취소했습니다.'),{name:'AbortError'});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createLatexSession({project,applyChanges,compiler,generationApi,engineManifest={},initialArtifact,onState=()=>{},onOutput=()=>{}}){
  if(!project?.id||typeof applyChanges!=='function'||!compiler?.compile||!generationApi?.create||typeof generationApi.key!=='function')throw new Error('LaTeX session dependencies required');
  const original=copy(project),history=[[]];let position=0,changes=[],disposed=false,busy=false,error=null,lastOutput=null,baseline=null,adoptedBaseline=null;
  const spec=()=>({fileHash:original.id,edits:copy(changes),changes:copy(changes),project:copy(original),exportSettings:{latex:{projectId:original.id,engine:original.engine,manifest:copy(engineManifest),sourceChanges:copy(changes)}}});
  const baselineKey=generationApi.key(spec());
  if(initialArtifact!==undefined){
    const bytes=initialArtifact?.pdfBytes;
    if(initialArtifact?.success!==true||!(bytes instanceof Uint8Array)||bytes.length<5||bytes[0]!==37||bytes[1]!==80||bytes[2]!==68||bytes[3]!==70||bytes[4]!==45||initialArtifact.projectId!==original.id||(initialArtifact.engine!=null&&initialArtifact.engine!==original.engine))throw Object.assign(new Error('초기 PDF가 원본 프로젝트와 일치하지 않습니다.'),{code:'invalid-initial-artifact'});
    const owned=bytes.slice(),actual=hex(owned);
    if(initialArtifact.pdfHash!==actual)throw Object.assign(new Error('초기 PDF 해시가 다릅니다.'),{code:'artifact-hash-mismatch'});
    baseline=Object.freeze({...copy(initialArtifact),pdfBytes:owned,pdfHash:actual,key:baselineKey,projectId:original.id});lastOutput=baseline;adoptedBaseline=baseline;
  }
  const publicOutput=value=>value?copy(value):null;
  const emit=()=>{if(!disposed)onState(snapshot());};
  function snapshot(){return {project:copy(original),changes:copy(changes),busy,error:error?{code:error.code||'compile-failed',message:error.message,diagnostics:copy(error.diagnostics||[])}:null,canUndo:position>0,canRedo:position<history.length-1,baseline:publicOutput(baseline),artifact:currentOutput(),lastArtifact:publicOutput(lastOutput)};}
  function currentOutput(){if(!lastOutput||error)return null;return lastOutput.key===generationApi.key(spec())?publicOutput(lastOutput):null;}
  const generator=generationApi.create({delayMs:180,maxEntries:3,
    async generate(captured,{signal,key}){
      if(signal.aborted||disposed)throw abort();
      if(adoptedBaseline&&key===baselineKey)return publicOutput(adoptedBaseline);
      const enabled=captured.changes.filter(c=>c.enabled!==false);
      const derived=await applyChanges(copy(captured.project),copy(enabled));
      if(signal.aborted||disposed)throw abort();
      if(!derived?.project || !Array.isArray(derived.applied) || derived.diagnostics?.length || !same([...derived.applied].sort(),enabled.map(c=>c.id).sort()))throw Object.assign(new Error(derived?.diagnostics?.[0]?.message||'선택한 변경을 적용하지 못했습니다.'),{code:'source-patch-failed',diagnostics:derived?.diagnostics||[]});
      const result=await compiler.compile({project:derived.project||derived,key,signal,engineManifest:copy(engineManifest)});
      if(signal.aborted||disposed)throw abort();
      if(!result?.success||!(result.pdfBytes instanceof Uint8Array)||!result.pdfBytes.length){const e=Object.assign(new Error(result?.diagnostics?.find(d=>d.severity==='error')?.message||'PDF를 만들지 못했습니다.'),{code:'latex-compile-failed',diagnostics:result?.diagnostics||[]});throw e;}
      const bytes=result.pdfBytes.slice(),actual=hex(bytes);
      if(result.pdfHash&&result.pdfHash!==actual)throw Object.assign(new Error('생성한 PDF 해시가 다릅니다.'),{code:'artifact-hash-mismatch'});
      return Object.freeze({...result,pdfBytes:bytes,pdfHash:actual,key,projectId:(derived.project||derived).id});
    },
    onState(event){if(disposed)return;if(event.key===generationApi.key(spec())){busy=event.phase==='scheduled'||event.phase==='running';if(event.phase==='error')error=event.error;else if(event.phase==='scheduled'||event.phase==='running')error=null;emit();}},
    onResult(result){if(disposed||result.key!==generationApi.key(spec()))return;lastOutput=result;if(!changes.some(c=>c.enabled!==false)&&!baseline)baseline=result;error=null;busy=false;emit();onOutput(publicOutput(result));}
  });
  function update(next){if(disposed)throw abort();if(same(changes,next))return;changes=copy(next);history.splice(position+1);history.push(copy(changes));position=history.length-1;error=null;emit();generator.schedule(spec());}
  function setChange(change){if(!change?.id||!change.anchor||change.anchor.projectId!==original.id)throw Object.assign(new Error('이 원본에 연결된 변경이 아닙니다.'),{code:'stale-anchor'});const next=copy(changes),index=next.findIndex(x=>x.id===change.id),candidate={...copy(change),enabled:change.enabled!==false};
    if(candidate.enabled)for(const prior of next){if(prior.id!==candidate.id&&prior.enabled!==false&&prior.anchor?.path===candidate.anchor.path&&(prior.anchor.start<candidate.anchor.end&&candidate.anchor.start<prior.anchor.end || prior.anchor.start===candidate.anchor.start&&(prior.anchor.start===prior.anchor.end||candidate.anchor.start===candidate.anchor.end)))prior.enabled=false;}
    if(index<0)next.push(candidate);else next[index]=candidate;update(next);
  }
  function setChanges(next){if(!Array.isArray(next))throw new Error('changes required');for(const c of next)if(c.anchor?.projectId!==original.id)throw Object.assign(new Error('이 원본에 연결된 변경이 아닙니다.'),{code:'stale-anchor'});update(next);}
  return {snapshot,getInputIdentity:()=>({projectId:original.id,changes:copy(changes)}),getCurrentOutput:currentOutput,getBaseline:()=>publicOutput(baseline),setChange,setChanges,
    undo(){if(position>0){changes=copy(history[--position]);error=null;emit();generator.schedule(spec());}},
    redo(){if(position<history.length-1){changes=copy(history[++position]);error=null;emit();generator.schedule(spec());}},
    async compile(){if(disposed)throw abort();const requested=spec(),key=generationApi.key(requested),result=await generator.flush(requested);if(disposed||key!==generationApi.key(spec()))throw abort();return publicOutput(result);},
    async getCurrentProject(){const enabled=changes.filter(c=>c.enabled!==false),result=await applyChanges(copy(original),copy(enabled));if(!result?.project||!Array.isArray(result.applied)||result.diagnostics?.length||!same([...result.applied].sort(),enabled.map(c=>c.id).sort()))throw Object.assign(new Error(result?.diagnostics?.[0]?.message||'선택한 변경을 적용하지 못했습니다.'),{code:'source-patch-failed',diagnostics:result?.diagnostics||[]});return copy(result.project);},
    cancel(){generator.cancel();compiler.cancel?.();busy=false;emit();},
    dispose(){if(disposed)return;disposed=true;generator.dispose();compiler.dispose?.();lastOutput=null;baseline=null;adoptedBaseline=null;}
  };
}

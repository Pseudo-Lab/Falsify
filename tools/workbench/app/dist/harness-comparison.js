(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyComparison=api;})(globalThis,function(){
  'use strict';
  const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const sorted=x=>Array.isArray(x)?x.map(sorted):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
  function identity(h){
    const p=h?.settings?.portableStrategy;
    if(!plain(p)||Object.keys(p).some(k=>!['schema','name','version','parameters','sourceDigest'].includes(k))||p.schema!=='falsify.portable-strategy.v1'||typeof p.name!=='string'||!p.name.trim()||typeof p.version!=='string'||!p.version.trim()||!plain(p.parameters)||('sourceDigest' in p&&!/^[a-f0-9]{64}$/.test(p.sourceDigest)))return null;
    try{return JSON.stringify(sorted(p));}catch{return null;}
  }
  async function strategyHash(h){const s=identity(h);if(!s)return null;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
  const knownModel=m=>typeof m==='string'&&m.trim()&&!/unknown|unverified/i.test(m);
  const rubric=r=>{const x=r?.harness?.settings?.comparisonRubric;return typeof x==='string'&&x.trim()?x:null;};
  const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
  // A missing visual field is legacy/unknown, not proof that only text was sent.
  function inputIdentity(r){
    if(r?.inputMode==='text' && !Object.hasOwn(r,'visualEvidence'))return 'text';
    if(r?.inputMode!=='visual')return null;
    const items=r?.visualEvidence;
    if(!Array.isArray(items)||!items.length||items.length>2)return null;
    const refs=[];
    for(const v of items){
      if(!plain(v)||v.fileHash!==r.fileHash||v.sourceHash!==r.sourceHash||!hex(v.sha256)||v.mime!=='image/png'||v.provenance!=='client-declared-pdf-association'||v.artifact!=='unavailable'||!Number.isSafeInteger(v.page)||v.page<1||![0,90,180,270].includes(v.rotation)||!Array.isArray(v.bbox)||v.bbox.length!==4||!v.bbox.every(Number.isFinite)||v.bbox[0]<0||v.bbox[1]<0||v.bbox[2]<=0||v.bbox[3]<=0||!Number.isInteger(v.width)||!Number.isInteger(v.height)||v.width!==Math.ceil(v.bbox[2]*2)||v.height!==Math.ceil(v.bbox[3]*2)||v.width>4096||v.height>4096||v.width*v.height>8000000)return null;
      refs.push(JSON.stringify([v.sha256,v.page,v.bbox,v.rotation,v.width,v.height]));
    }
    return 'visual:'+JSON.stringify(refs.sort());
  }
  const typesIdentity=r=>JSON.stringify(r.attackTypes?.slice().sort()??null);
  function differences(a,b){const out=[];for(const [name,x,y] of [['입력 텍스트 해시',a.sourceHash,b.sourceHash],['입력 파일 해시',a.fileHash,b.fileHash],['역할',a.role,b.role],['출처',a.provenance,b.provenance],['예산',a.maxCalls,b.maxCalls],['RED 난이도',a.level??null,b.level??null]])if((name!=='RED 난이도'&&(x==null||y==null))||x!==y)out.push(name);
    if(typesIdentity(a)!==typesIdentity(b))out.push('RED 공격 유형');
    if(!hex(a.sourceHash)||!hex(b.sourceHash))out.push('입력 텍스트 해시 미상');
    if(!hex(a.fileHash)||!hex(b.fileHash))out.push('입력 파일 해시 미상');
    if(a.provenance!=='local-codex'||b.provenance!=='local-codex')out.push('출처 미검증');
    const ai=inputIdentity(a),bi=inputIdentity(b);if(!ai||!bi||ai!==bi)out.push('입력 방식 또는 시각 증거 미상 / 불일치');
    if(!knownModel(a.model)||!knownModel(b.model)||a.model!==b.model)out.push('모델 표기 미상 또는 불일치');
    if(!rubric(a)||!rubric(b)||rubric(a)!==rubric(b))out.push('사람 rubric 미선언 또는 불일치');
    if(!identity(a.harness)||!identity(b.harness))out.push('portable 전략 미선언');return out;}
  function compare(runs,reviews,reference){const root=runs.filter(r=>!r.snapshotOf),byRoot=new Map(runs.map(r=>[r.id,r.snapshotOf||r.id]));const mapped=reviews.map(v=>({...v,runId:byRoot.get(v.runId)||v.runId}));const rows=[];
    for(const r of root){const reasons=differences(reference,r),latest=mapped.filter(v=>v.runId===r.id).at(-1);const a=reference.harness?.settings?.portableStrategy?.parameters,b=r.harness?.settings?.portableStrategy?.parameters;const parameterDifferences=plain(a)&&plain(b)?[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(sorted(a[k]))!==JSON.stringify(sorted(b[k]))):[];rows.push({run:r,reasons,comparable:!reasons.length,review:latest?latest.verdict:'unreviewed',reviewNote:latest?.note||'',parameterDifferences,parameterValues:parameterDifferences.map(k=>({key:k,reference:a[k]??null,observed:b[k]??null})),strategy:identity(r.harness)});}
    const groups=new Map();for(const row of rows.filter(x=>x.comparable)){let g=groups.get(row.strategy);if(!g){g={strategy:row.strategy,runs:[],unreviewed:0,uncertain:0};groups.set(row.strategy,g);}g.runs.push(row.run);if(row.review==='unreviewed')g.unreviewed++;if(row.review==='uncertain')g.uncertain++;}
    return {rows,groups:[...groups.values()],observed:rows.filter(x=>x.comparable).length,excluded:rows.filter(x=>!x.comparable).length,unreviewed:rows.filter(x=>x.comparable&&x.review==='unreviewed').length,uncertain:rows.filter(x=>x.comparable&&x.review==='uncertain').length,missingAttempts:null,cost:null};}
  function observedAttempts(attempts,reference){
    const matching=attempts.filter(a=>a.role===reference.role&&a.sourceHash===reference.sourceHash&&a.fileHash===reference.fileHash&&a.budget===reference.maxCalls&&(a.level??null)===(reference.level??null)&&typesIdentity(a)===typesIdentity(reference)&&knownModel(a.model)&&knownModel(reference.model)&&a.model===reference.model);
    const groups=new Map();for(const a of matching){let g=groups.get(a.harnessHash);if(!g){g={harnessHash:a.harnessHash,name:a.harnessName,version:a.harnessVersion,effort:a.effort,counts:{completed:0,failed:0,cancelled:0,unknown:0},observedMs:0,calls:0,callsUnknown:0};groups.set(a.harnessHash,g);}g.counts[a.status]++;g.observedMs+=a.durationMs;if(a.calls===null)g.callsUnknown++;else g.calls+=a.calls;}
    return {groups:[...groups.values()],matched:matching.length,unmatched:attempts.length-matching.length};
  }
  return {identity,strategyHash,differences,compare,observedAttempts};
});

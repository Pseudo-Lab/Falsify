// Aside cannot set viewports; installed Edge fallback, synthetic manual data only.
// Records go through the shared FalsifyLab API so ledger checks stay independent of role page wiring.
const {chromium}=require(process.argv[2]),assert=require('node:assert/strict'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const base=process.argv[3]||'http://127.0.0.1:7816/',key='falsify.experiment-ledger.v1';let browser,passed=0;const checks=[];
const check=(name,value)=>{assert.ok(value,name);passed++;checks.push(name);},copy=v=>JSON.parse(JSON.stringify(v)),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const nav=(p,v)=>p.locator('.rail [data-view='+v+']:visible').first().click();
async function download(p,selector){const d=p.waitForEvent('download');await p.locator(selector).click();return JSON.parse(await fs.readFile(await(await d).path(),'utf8'));}
async function open(){const context=await browser.newContext({acceptDownloads:true});const p=await context.newPage();p.downloads=0;p.on('download',()=>p.downloads++);await p.goto(base);await p.evaluate(()=>FalsifyLab.ready);return p;}
async function stored(p){return p.evaluate(k=>localStorage.getItem(k),key);}
async function restore(p,data){await nav(p,'results');await p.locator('#ledger-status').evaluate(e=>e.textContent='');await p.locator('#ledger-import').setInputFiles({name:'synthetic-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await p.waitForFunction(()=>document.querySelector('#ledger-status').textContent!=='');return p.locator('#ledger-status').innerText();}
// Synthetic RED source and the BLUE copy RED would export after the user's own edit.
const redSegments=[{id:'s0',label:'¶1',text:'Study does not show benefit.'},{id:'s1',label:'¶2',text:'Only an association was observed.'}];
const blueSegments=[{id:'s0',label:'¶1',text:'Study clearly shows benefit.'},{id:'s1',label:'¶2',text:'Only an association was observed.'}];
const join=s=>s.map(x=>x.text).join('\n\n'),outputHash=sha(join(blueSegments));
const redDoc={revision:'synthetic-red-rev',fileHash:sha('synthetic red file'),sourceHash:sha(join(redSegments)),segments:redSegments,name:'synthetic-paper.txt',format:'text'};
const blueDoc={revision:'synthetic-blue-rev',fileHash:outputHash,sourceHash:sha(join(blueSegments)),segments:blueSegments,name:'synthetic-paper-red.txt',format:'text'};
const evidence=[{segmentId:'s1',quote:'Only an association was observed.',relation:'Synthetic qualification.'}];
const redResponse={schema:'falsify.document-red.v1',revision:redDoc.revision,sourceHash:redDoc.sourceHash,status:'ok',candidates:[{id:'c1',segmentId:'s0',level:1,before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Synthetic contradiction.',evidence,uncertainty:'Synthetic fixture only.'},{id:'c2',segmentId:'s0',level:1,before:'does not show',after:'does show',rationale:'Synthetic overlapping candidate.',evidence,uncertainty:'Synthetic fixture only.'}]};
const blueResponse={schema:'falsify.document-blue.v1',revision:blueDoc.revision,sourceHash:blueDoc.sourceHash,status:'ok',findings:[{id:'f1',segmentId:'s0',quote:'Study clearly shows benefit.',rationale:'Synthetic logical conflict.',evidence,uncertainty:'Synthetic fixture only.'}]};
const edited={id:'c1',segmentId:'s0',label:'¶1',before:'Study does not show benefit.',after:'Study clearly shows benefit.',offset:0,edited:true};
const finalState={selected:[edited],outputFileHash:outputHash,verification:{synthetic:true,preserved:'outside changed region'}};
// Runs inside the page: bind like a role module, then record with optional extras.
// requestId pins one execution (role modules reuse the request for auto/manual/snapshot records); omitted, every call is a new execution.
async function record(p,role,extras={},overrides={},docOverrides={},requestId){return p.evaluate(async({role,redDoc,blueDoc,redResponse,blueResponse,extras,overrides,docOverrides,requestId})=>{const doc={...(role==='red'?redDoc:blueDoc),...docOverrides},response={...(role==='red'?redResponse:blueResponse),...overrides};const request=await FalsifyLab.bind(role,role==='red'?FalsifyDocumentRed.request(doc,1,4):FalsifyDocumentBlue.request(doc,4));if(requestId!==undefined)request.requestId=requestId;if(extras.stale){extras={...extras,isCurrent:()=>false};delete extras.stale;}try{return {id:await FalsifyLab.record(role,doc,request,response,'manual-unverified',extras)};}catch(e){return {error:e.message,name:e.name};}},{role,redDoc,blueDoc,redResponse,blueResponse,extras,overrides,docOverrides,requestId});}
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});const p=await open();
 const exec='synthetic-red-rev:exec-1',root=await record(p,'red',{},{},{},exec);check('root model run recorded',!!root.id);const before=await stored(p);
 const snap=await record(p,'red',{finalState,snapshotOf:root.id},{},{},exec);check('valid final edited snapshot recorded',!!snap.id&&snap.id!==root.id);
 let data=JSON.parse(await stored(p));const rootRun=data.runs.find(r=>r.id===root.id),snapRun=data.runs.find(r=>r.id===snap.id);
 check('original model response immutable',JSON.stringify(JSON.parse(before).runs[0])===JSON.stringify(rootRun)&&!('finalState' in rootRun));
 check('final edit kept separately from model output',snapRun.finalState.selected[0].after==='Study clearly shows benefit.'&&snapRun.finalState.selected[0].edited===true&&snapRun.response.candidates[0].after==='Study does show benefit.');
 check('source name and format captured',snapRun.sourceName==='synthetic-paper.txt'&&snapRun.format==='text');
 check('execution identity stored on root and snapshot',rootRun.requestId===exec&&snapRun.requestId===exec);
 check('unchanged snapshot not duplicated',(await record(p,'red',{finalState,snapshotOf:root.id},{},{},exec)).id===snap.id&&JSON.parse(await stored(p)).runs.length===2);
 check('recording never auto-downloads JSON',p.downloads===0);
 const unchanged=await stored(p);
 for(const [name,role,extras,overrides,docOverrides,requestId] of [
  ['wrong output hash rejected','red',{finalState:{...finalState,outputFileHash:'abc'}}],
  ['unknown candidate rejected','red',{finalState:{...finalState,selected:[{...edited,id:'made-up'}]}}],
  ['changed Before rejected','red',{finalState:{...finalState,selected:[{...edited,before:'Study does not show'}]}}],
  ['overlapping selection rejected','red',{finalState:{...finalState,selected:[{...edited,after:'Study does show benefit.',edited:false},{id:'c2',segmentId:'s0',label:'¶1',before:'does not show',after:'does show',offset:6,edited:false}]}}],
  ['numeric edit rejected','red',{finalState:{...finalState,selected:[{...edited,after:'Study 2 shows benefit.'}]}}],
  ['finalState on BLUE rejected','blue',{finalState}],
  ['unknown extras rejected','red',{plan:{}}],
  ['dangling snapshot rejected','red',{finalState,snapshotOf:'missing'},{},{},exec],
  ['snapshot without final state rejected','red',{snapshotOf:root.id},{},{},exec],
  ['snapshot of different response rejected','red',{finalState,snapshotOf:root.id},{status:'ok',candidates:[redResponse.candidates[0]]},{},exec],
  ['snapshot of different binary file rejected','red',{finalState,snapshotOf:root.id},undefined,{fileHash:sha('other binary layout')},exec],
  ['snapshot of another execution rejected','red',{finalState,snapshotOf:root.id},{},{},'synthetic-red-rev:exec-other'],
  ['oversized request ID rejected','red',{},{},{},'x'.repeat(201)],
  ['non-string request ID rejected','red',{},{},{},42],
  ['BLUE relation to non-matching RED rejected','blue',{sourceRunId:root.id}],
  ['stale caller not recorded','red',{finalState:{...finalState,outputFileHash:null},snapshotOf:root.id,stale:true},{},{},exec]
 ]){const result=await record(p,role,extras,overrides,docOverrides,requestId);check(name,!!result.error&&await stored(p)===unchanged);}
 check('stale guard error is identifiable',(await record(p,'red',{stale:true})).name==='StaleRecordError');
 const bound=await p.evaluate(async d=>FalsifyLab.bind('blue',{...FalsifyDocumentBlue.request(d,4),finalState:{x:1},sourceRunId:'x',plan:{x:1},snapshotOf:'x'}),blueDoc);check('bind keeps plan/final/relation out of request',!['finalState','sourceRunId','plan','snapshotOf'].some(k=>k in bound));
 const blue=await record(p,'blue',{sourceRunId:snap.id});check('BLUE relation to matching RED output recorded',!!blue.id&&JSON.parse(await stored(p)).runs.at(-1).sourceRunId===snap.id);
 // Storage failure keeps prior records, then retry succeeds.
 await p.evaluate(()=>{globalThis.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('synthetic','QuotaExceededError');};});const failing=await stored(p),failed=await record(p,'blue');check('storage error reported, nothing lost',failed.error?.includes('브라우저 저장소에 쓰지 못했습니다')&&await stored(p)===failing);
 await p.evaluate(()=>{Storage.prototype.setItem=globalThis.__setItem;});check('record retry after storage error succeeds',!!(await record(p,'blue')).id&&JSON.parse(await stored(p)).runs.length===4);
 // Human review resolves the RED final output automatically; verdicts stay pending until a person decides.
 await nav(p,'review');check('review API selects saved run',await p.evaluate(id=>FalsifyLab.review(id),blue.id)&&await p.locator('#evaluation-run').inputValue()===blue.id);
 check('BLUE comparison linked from recorded RED final state',(await p.locator('#evaluation-plan-status').innerText()).includes('SHA-256 일치')&&(await p.locator('#evaluation-comparison').innerText()).includes('Study clearly shows benefit.'));
 check('no verdict auto-inference',await p.locator('#evaluation-patch-0').inputValue()==='pending');
 await p.locator('#evaluation-reviewer').fill('Synthetic reviewer');await p.locator('#evaluation-verdict').selectOption('supported');await p.locator('#evaluation-score').selectOption('4');await p.locator('#evaluation-note').fill('Synthetic test only.');await p.locator('#evaluation-patch-0').selectOption('detected');await p.locator('#evaluation-save').click();
 data=JSON.parse(await stored(p));check('linked comparison stored with RED source',data.reviews[0].comparison.sourceRunId===snap.id&&data.reviews[0].comparison.assessments[0].verdict==='detected');
 await p.evaluate(id=>FalsifyLab.review(id),snap.id);check('final snapshot evaluable and shown apart from model output',(await p.locator('#evaluation-final').innerText()).includes('최종 After: Study clearly shows benefit.')&&(await p.locator('#evaluation-binding').innerText()).includes('최종 스냅샷'));
 check('metadata hashes under details',await p.locator('#evaluation-output details.ledger-meta').count()===1&&(await p.locator('#evaluation-output details.ledger-meta').evaluate(e=>e.textContent)).includes(rootRun.harnessHash));
 for(const reviewer of ['Root reviewer','Snapshot reviewer']){await p.evaluate(id=>FalsifyLab.review(id),reviewer==='Root reviewer'?root.id:snap.id);await p.locator('#evaluation-reviewer').fill(reviewer);await p.locator('#evaluation-verdict').selectOption('mixed');await p.locator('#evaluation-score').selectOption(reviewer==='Root reviewer'?'2':'5');await p.locator('#evaluation-note').fill('Synthetic family review.');await p.locator('#evaluation-save').click();}
 await nav(p,'results');const table=await p.locator('#ledger-table-body').innerText();check('snapshot does not inflate sample n; manual scores are not averaged',(await p.locator('#ledger-summary').innerText()).includes('로컬 broker 실행 0건 (앱 adapter 호출 0회) · 수동 응답 3건 · 가져온 기록 0건 · 최종 스냅샷 1건')&&/수동 응답 · 실행 미검증 1건[\s\S]*1건 검수 · 평균 미표시 \(출처 미검증 점수 1건\)/.test(table)&&!/\d\.\d\d \/ 5/.test(table));
 const backup=await download(p,'#ledger-export');check('explicit full backup still downloads',backup.runs.length===4&&backup.reviews.length===3);
 const target=await open();check('valid backup imports links and reviews',(await restore(target,backup)).includes('백업을 병합'));data=JSON.parse(await stored(target));check('import cannot promote provenance',data.runs.every(r=>r.provenance==='imported-unverified'));await nav(target,'results');check('imported records never count as executions',(await target.locator('#ledger-summary').innerText()).includes('로컬 broker 실행 0건 (앱 adapter 호출 0회) · 수동 응답 0건 · 가져온 기록 3건 · 최종 스냅샷 1건'));const original=await stored(target);check('duplicate backup is idempotent',(await restore(target,backup)).includes('백업을 병합')&&await stored(target)===original);
 const reordered=copy(backup);reordered.runs.reverse();const t2=await open();check('link validation is order independent',(await restore(t2,reordered)).includes('백업을 병합'));
 const old=copy(backup);for(const r of old.runs){for(const k of ['sourceName','format','finalState','sourceRunId','snapshotOf','requestId'])delete r[k];}for(const v of old.reviews)if(v.comparison)delete v.comparison.sourceRunId;const t3=await open();check('old v1 backup without new fields imports',(await restore(t3,old)).includes('백업을 병합'));
 const snapIndex=backup.runs.findIndex(r=>r.id===snap.id),blueIndex=backup.runs.findIndex(r=>r.id===blue.id);
 for(const [name,mutate] of [
  ['tampered harness hash rejected',v=>v.harnesses[0].config.instructions='tampered'],
  ['tampered paper hash rejected',v=>v.runs[0].segments[0].text+=' tampered'],
  ['unknown run field rejected',v=>v.runs[0].notes='extra'],
  ['imported unknown final candidate rejected',v=>v.runs[snapIndex].finalState.selected[0].id='made-up'],
  ['imported edited flag mismatch rejected',v=>v.runs[snapIndex].finalState.selected[0].edited=false],
  ['imported finalState on BLUE rejected',v=>v.runs[blueIndex].finalState=copy(v.runs[snapIndex].finalState)],
  ['imported snapshot chain rejected',v=>{const chained=copy(v.runs[snapIndex]);chained.id='chained';chained.snapshotOf=snap.id;v.runs.push(chained);}],
  ['imported tampered binary snapshot rejected',v=>v.runs[snapIndex].fileHash=sha('other binary layout')],
  ['imported snapshot of another execution rejected',v=>v.runs[snapIndex].requestId='synthetic-red-rev:exec-other'],
  ['imported oversized request ID rejected',v=>v.runs[0].requestId='x'.repeat(201)],
  ['imported self cycle rejected',v=>v.runs[snapIndex].snapshotOf=snap.id],
  ['imported dangling relation rejected',v=>v.runs[blueIndex].sourceRunId='missing'],
  ['imported comparison source mismatch rejected',v=>v.reviews[0].comparison.sourceRunId=root.id],
  ['wrong comparison file hash rejected',v=>v.reviews[0].comparison.outputFileHash='0'.repeat(64)],
  ['fabricated finding overlap rejected',v=>v.reviews[0].comparison.assessments[0].quoteOverlapFindingIds=['made-up']],
  ['duplicate run identifiers rejected',v=>v.runs.push(copy(v.runs[0]))],
  ['conflicting immutable run rejected',v=>v.runs[0].createdAt='2026-10-12T00:00:00Z'],
  ['conflicting review history rejected',v=>v.reviews[0].note='Changed old review'],
  ['uncertain score rejected',v=>{v.reviews[0].verdict='uncertain';v.reviews[0].score=5;}]
 ]){const altered=copy(backup);mutate(altered);check(name,(await restore(target,altered)).includes('복원 차단')&&await stored(target)===original);}
 await target.reload();await target.evaluate(()=>FalsifyLab.ready);check('imported history survives reload',await stored(target)===original);
 const runs=await open(),count=async()=>{await nav(runs,'results');return {summary:await runs.locator('#ledger-summary').innerText(),table:await runs.locator('#ledger-table-body').innerText(),stored:JSON.parse(await stored(runs)).runs.length};};
 const first=await record(runs,'red',{},{},{},'synthetic-red-rev:exec-A'),again=await record(runs,'red',{},{},{},'synthetic-red-rev:exec-A');let n=await count();
 check('same execution recorded twice unchanged counts n=1',!!first.id&&again.id===first.id&&n.stored===1&&n.summary.includes('수동 응답 1건')&&/수동 응답 · 실행 미검증 1건[\s\S]*0건 검수/.test(n.table));
 const second=await record(runs,'red',{},{},{},'synthetic-red-rev:exec-B');n=await count();
 check('separate executions with identical output count n=2',!!second.id&&second.id!==first.id&&n.stored===2&&n.summary.includes('수동 응답 2건')&&/수동 응답 · 실행 미검증 2건[\s\S]*0건 검수/.test(n.table));
 const blueA=await record(runs,'blue',{},{},{},'synthetic-blue-rev:exec-A'),blueB=await record(runs,'blue',{},{},{},'synthetic-blue-rev:exec-B');check('BLUE identical outputs from separate executions both kept',!!blueA.id&&!!blueB.id&&blueA.id!==blueB.id&&(await count()).stored===4);
 const broken=await browser.newContext();await broken.addInitScript(k=>{if(!localStorage.getItem(k))localStorage.setItem(k,'{broken');},key);const bp=await broken.newPage();await bp.goto(base);await bp.evaluate(()=>FalsifyLab.ready);check('corrupt existing storage is not overwritten',await stored(bp)==='{broken');check('record blocked until recovery',(await record(bp,'red')).error?.includes('덮어쓰기를 막았습니다')&&await stored(bp)==='{broken');await nav(bp,'agents');await bp.locator('#harness-editor').fill(JSON.stringify({...backup.harnesses[0].config,id:'new-after-error'}));await bp.locator('#harness-register').click();check('write blocked until recovery',(await bp.locator('#harness-status').innerText()).includes('덮어쓰기를 막았습니다')&&await stored(bp)==='{broken');check('valid backup explicitly recovers corrupt storage',(await restore(bp,backup)).includes('백업을 병합')&&JSON.parse(await stored(bp)).reviews.length===3);
 console.log(JSON.stringify({passed,checks},null,2));
})().catch(e=>{console.error(JSON.stringify({passed,checks,error:e.stack},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();});

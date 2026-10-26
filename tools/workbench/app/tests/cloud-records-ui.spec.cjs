'use strict';
// Node VM regression for the shared-records section: synthetic DOM, stubbed fetch/storage/ledger hooks/core. No browser, network, server or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Retired account UI is retained outside the shipped site for migration regression coverage only.
const src=fs.readFileSync(path.resolve(__dirname,'../legacy/cloud-records.js'),'utf8'),BASE='https://api.test',KEY='falsify.cloud-session.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const until=async(f,label)=>{for(let i=0;i<300&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f(),label);};
const H='a'.repeat(64),S='b'.repeat(64),F='c'.repeat(64),FUTURE=new Date(Date.now()+864e5).toISOString(),TOKEN='t'.repeat(43),INVITE='fsi_'+'Q'.repeat(42)+'w';

class El extends EventTarget{
  constructor(tag){super();Object.assign(this,{tagName:tag.toUpperCase(),children:[],parent:null,attrs:{},dataset:{},_text:'',id:'',className:'',value:'',checked:false,disabled:false,hidden:false,open:false});
    const set=()=>new Set(this.className.split(/\s+/).filter(Boolean));this.classList={toggle:(c,on)=>{const s=set();(on??!s.has(c))?s.add(c):s.delete(c);this.className=[...s].join(' ');},contains:c=>set().has(c)};}
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  set textContent(v){this.children=[];this._text=String(v);}
  append(...kids){for(const c of kids){if(typeof c==='object')c.parent=this;this.children.push(c);}}
  prepend(...kids){for(const c of kids)if(typeof c==='object')c.parent=this;this.children.unshift(...kids);}
  // Like a browser, removing the focused node sends focus to body.
  replaceChildren(...kids){const d=this.ownerDocument,a=d?.activeElement;if(a&&a!==this&&this.contains(a))d.activeElement=d.body;for(const c of this.children)if(typeof c==='object')c.parent=null;this.children=[];this._text='';this.append(...kids);}
  contains(n){for(let x=n;x;x=x.parent)if(x===this)return true;return false;}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
  focus(){if(!this.disabled&&this.ownerDocument)this.ownerDocument.activeElement=this;}scrollIntoView(){}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  change(value){if(value!==undefined)this.value=value;this.dispatchEvent(new Event('change'));}
  *walk(){yield this;for(const c of this.children)if(typeof c==='object')yield* c.walk();}
  find(f){for(const n of this.walk())if(f(n))return n;return null;}
  visible(){for(let n=this;n;n=n.parent)if(n.hidden)return false;return true;}
}
const rec=(id,kind,payload,o={})=>({id,owner:{id:o.owner||'author-other',displayName:o.name||'Other',username:o.user||'other'},kind,visibility:o.visibility||'shared',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z',revision:o.revision||1,payload,attestation:'client-reported'});
const harnessConfig={schema:'falsify.harness.v1',id:'syn-blue',name:'Synthetic BLUE',version:'1',role:'blue',instructions:'Synthetic instruction.',maxCalls:4};
const runPayload={role:'blue',harnessHash:H,sourceHash:S,fileHash:F,model:'synthetic-model',level:null,maxCalls:4,status:'ok',calls:2,provenance:'local-codex',caseLabel:'case-A',protocolVersion:'p1',createdAt:'2026-10-18T00:00:00Z'};
const sharedRecords=[rec('rec-h1','harness',{config:harnessConfig,hash:H}),rec('rec-r1','run',runPayload)];
const meSession=(over={})=>JSON.stringify({apiBase:BASE,token:TOKEN,author:{id:'author-me',username:'me',displayName:'Me'},expiresAt:FUTURE,...over});
const localRun={id:'local-run-1',role:'blue',harnessHash:H,sourceHash:S,fileHash:F,model:'synthetic-model',maxCalls:4,provenance:'local-codex',createdAt:'2026-10-18T00:00:00Z',segments:[{id:'s0',label:'p1',text:'Synthetic paper text'}]};
function labStub(){const calls=[],db={harnesses:[{config:harnessConfig,hash:H}],runs:[localRun],reviews:[{id:'local-review-1',runId:'local-run-1',reviewer:'Local label',caseLabel:'case-A',verdict:'supported',score:4,note:'Synthetic note.',createdAt:'2026-10-18T01:00:00Z'}]},before=JSON.stringify(db);
  return {calls,db,unchanged:()=>JSON.stringify(db)===before,ready:Promise.resolve(),cloudSnapshot:async()=>{calls.push('cloudSnapshot');return JSON.parse(JSON.stringify(db));},previewSharedHarness:async(c,expected)=>{calls.push(['preview',c,expected]);return expected;}};}
// Mirrors the contract core signatures (cloud-records-core.mjs); the real core is exercised below when it is present.
function coreStub(){const calls=[];return {calls,
  validatePayload:async(kind,p)=>{calls.push(['validate',kind]);if(kind==='review'&&(p.verdict==='uncertain'&&p.score!==null||typeof p.caseLabel!=='string'))throw Error('Invalid payload field: review');return p;},
  runFromLocal:(r,{includeEvidence=false,caseLabel,protocolVersion}={})=>({localId:r.id,role:r.role,harnessHash:r.harnessHash,sourceHash:r.sourceHash,fileHash:r.fileHash,model:r.model,level:null,maxCalls:r.maxCalls,status:'ok',calls:1,provenance:r.provenance,createdAt:r.createdAt,...(caseLabel!==undefined?{caseLabel}:{}),protocolVersion:protocolVersion??'p1',...(includeEvidence?{evidence:{segments:r.segments,response:{status:'ok'}}}:{})}),
  reviewFromLocal:(v,runId,{protocolVersion,supersedes}={})=>({runId,verdict:v.verdict,score:v.score,note:v.note,caseLabel:v.caseLabel,...(protocolVersion!==undefined?{protocolVersion}:{}),...(supersedes!==undefined?{supersedes}:{})}),
  compareRecords:records=>{calls.push(['compare',records.length]);return {groups:[{conditionKey:'k',conditions:{sourceHash:S,role:'blue',model:'synthetic-model',level:null,maxCalls:4,protocolVersion:'p1',caseLabel:'case-A'},attestation:'client-reported',runCount:1,
    harnesses:[{hash:H,origin:'executed',harnessAvailable:true,runIds:['rec-r1'],runCount:1,statuses:{ok:1,abstain:0},calls:2,callsUnknown:0,reviewCount:0,uncertainCount:0,scoreCount:0,scoreMean:null,reviewerCount:0}]}],
    warnings:[{code:'client_reported',message:'x',recordIds:[]},{code:'incomparable_missing_condition',message:'x',recordIds:['rec-x']},{code:'review_condition_mismatch',message:'x',recordIds:['rec-v9']}]};}};}
// routes(method,path,init) returns {status,body} | 'hang'.
function setup({apiBase=BASE,store=new Map(),routes=()=>({status:404,body:{error:{code:'not_found',message:'x'}}}),lab=labStub(),core=coreStub()}={}){
  const body=new El('body'),results=new El('section');results.id='view-results';const ledger=new El('section');ledger.id='ledger-board';results.append(ledger);body.append(results);
  const anchors=[],saved=[];class TURL extends URL{static createObjectURL(b){saved.push(b);return 'blob:synthetic/'+saved.length;}static revokeObjectURL(){}}
  const document=new EventTarget();Object.assign(document,{readyState:'complete',body,activeElement:body,createElement:t=>{const e=new El(t);e.ownerDocument=document;if(t==='a')anchors.push(e);return e;},querySelector:s=>s.startsWith('#')?body.find(n=>n.id===s.slice(1)):null});body.ownerDocument=document;
  const calls=[],fetch=async(url,init)=>{const u=new URL(url);calls.push({url,method:init.method,headers:{...init.headers},body:init.body===undefined?undefined:JSON.parse(init.body),init});
    const r=await routes(init.method,u.pathname+u.search,init);if(r==='hang')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));
    return {ok:r.status>=200&&r.status<300,status:r.status,text:async()=>r.body===undefined?'':typeof r.body==='string'?r.body:JSON.stringify(r.body)};};
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
  const ctx=vm.createContext({document,FalsifyCloudConfig:{apiBase},localStorage,fetch,FalsifyLab:lab,FalsifyCloudCore:core,URL:TURL,URLSearchParams,Blob,AbortController,TextEncoder,Event,console,setTimeout:(f,ms)=>setTimeout(f,ms>=15000?20:ms),clearTimeout,location:{href:'https://shinick-han.github.io/falsify-workbench/'}});
  vm.runInContext(src,ctx,{filename:'cloud-records.js'});
  const $=id=>body.find(n=>n.id===id),records=()=>[...$('cloud-list').walk()].filter(n=>n.tagName==='ARTICLE'),action=(article,name)=>article.find(n=>n.dataset.action===name);
  // press = keyboard activation: the control takes focus, then clicks.
  const press=b=>{b.focus();b.click();};
  return {ctx,calls,store,lab,core,body,doc:document,results,$,records,action,press,anchors,saved,ready:ctx.FalsifyCloudRecords.ready};}
const sharedRoute=(m,p)=>m==='GET'&&p.startsWith('/v1/records?scope=shared')?{status:200,body:{records:sharedRecords,nextCursor:null}}:null;
async function login(t){t.$('cloud-username').value='synthetic_me';t.$('cloud-password').value='correct horse battery';t.$('cloud-auth-form').dispatchEvent(new Event('submit',{cancelable:true}));await flush();}
const authOk=(m,p)=>m==='POST'&&p==='/v1/auth/login'?{status:200,body:{token:TOKEN,author:{id:'author-me',username:'me',displayName:'Me'},expiresAt:FUTURE}}:null;
const signedIn=()=>new Map([[KEY,meSession()]]);
// Wording that would describe team records as readable without signing in.
const PUBLIC_READ=/누구나|로그인 없이|로그인하지 않은|로그인은 필요 없|공개본/;

test('unconfigured or non-https server stays off and never touches the network',async()=>{
  for(const apiBase of ['','http://api.test','https://user:pw@api.test','https://api.test/?x=1']){const t=setup({apiBase});await t.ready;
    assert.equal(t.results.children[0].id,'ledger-board','local ledger stays first');assert.equal(t.results.children[1].id,'cloud-records');
    assert.match(t.$('cloud-connection').textContent,/꺼짐/);assert.equal(t.$('cloud-refresh').visible(),false);assert.equal(t.$('cloud-account').visible(),false);assert.equal(t.calls.length,0);}});

test('signed out, shared records request nothing: refresh and kind open sign-in with fixed copy',async()=>{
  const t=setup({routes:sharedRoute});await t.ready;await flush();assert.equal(t.calls.length,0,'no automatic read');assert.equal(t.$('cloud-tab-mine').disabled,false,'mine stays reachable and explains sign-in');
  assert.equal(t.$('cloud-list').textContent,'로그인 후 불러오면 이곳에 팀 공유 기록이 표시됩니다.','signed-out list stays neutral');assert.match(t.$('cloud-account-summary').textContent,/공유 기록을 보려면 필요/);
  for(const [id,hint,rule] of [['cloud-username','cloud-username-hint',/영문·숫자·_·- 3–32자/],['cloud-password','cloud-password-hint',/12–128자/]]){assert.equal(t.$(id).getAttribute('aria-describedby'),hint);assert.match(t.$(hint).textContent,rule);}
  const body=t.$('cloud-account-body').textContent;assert.equal(body.split('3–32자').length,2,'username rule only in its hint');assert.equal(body.split('12–128자').length,2,'password rule only in its hint');
  t.press(t.$('cloud-refresh'));await flush();
  assert.equal(t.calls.length,0,'no shared GET without sign-in');assert.equal(t.$('cloud-account').open,true);assert.equal(t.doc.activeElement,t.$('cloud-username'),'sign-in form takes focus');
  assert.equal(t.$('cloud-status').textContent,'공유 기록은 초대받은 팀 멤버만 볼 수 있습니다. 로그인한 뒤 불러오세요.');assert.ok(t.$('cloud-status').classList.contains('error'));
  assert.ok(!t.$('cloud-list').textContent.includes('초대받은 팀 멤버만'),'the gating sentence is said once, in the status line');
  t.$('cloud-kind').change('run');t.press(t.$('cloud-tab-shared'));await flush();assert.equal(t.calls.length,0,'kind change and the shared tab request nothing either');assert.equal(t.records().length,0);
  assert.ok(!PUBLIC_READ.test(t.$('cloud-records').textContent),'no copy claims anonymous or internet-public reads');});

test('shared records are read signed in as a member, only on explicit refresh',async()=>{
  const t=setup({store:signedIn(),routes:sharedRoute});await t.ready;await flush();assert.equal(t.calls.length,0,'no automatic read');
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'two shared records');
  assert.equal(t.calls[0].url,BASE+'/v1/records?scope=shared');assert.equal(t.calls[0].headers.authorization,'Bearer '+TOKEN,'shared reads carry the session');assert.equal(t.calls[0].init.credentials,'omit');
  assert.ok(t.records().every(a=>a.textContent.includes('작성자 보고 · 미검증')),'source badge on every record');assert.ok(t.action(t.records()[1],'review'),'a member can review a shared run');
  assert.ok(!PUBLIC_READ.test(t.$('cloud-records').textContent),'team wording only');});

test('sign-in keeps the token for the configured server only and never stores the password',async()=>{
  const t=setup({routes:(m,p)=>authOk(m,p)||sharedRoute(m,p)||(m==='GET'&&p.startsWith('/v1/records?scope=mine')?{status:200,body:{records:[],nextCursor:null}}:null)});await t.ready;
  t.$('cloud-username').value='bad name';t.$('cloud-password').value='correct horse battery';t.$('cloud-auth-form').dispatchEvent(new Event('submit',{cancelable:true}));await flush();
  assert.equal(t.calls.length,0,'invalid username is refused locally');assert.equal(t.$('cloud-password').value,'','password cleared after refusal');
  await login(t);const auth=t.calls[0];assert.equal(auth.url,BASE+'/v1/auth/login');assert.deepEqual(auth.body,{username:'synthetic_me',password:'correct horse battery'});
  const stored=t.store.get(KEY);assert.ok(stored&&!stored.includes('correct horse'),'password not persisted');assert.equal(JSON.parse(stored).apiBase,BASE);assert.equal(JSON.parse(stored).token,TOKEN);
  assert.ok(![...t.body.walk()].some(n=>n.value==='correct horse battery'),'password not left in any field');assert.match(t.$('cloud-account-summary').textContent,/로그인됨 · Me/);
  t.$('cloud-tab-mine').click();await until(()=>t.calls.length===2&&!t.$('cloud-tab-shared').disabled,'mine read');assert.equal(t.calls[1].headers.authorization,'Bearer '+TOKEN);
  t.$('cloud-tab-shared').click();await until(()=>t.calls.length===3,'shared read');assert.equal(t.calls[2].headers.authorization,'Bearer '+TOKEN,'shared reads are authenticated');
  assert.ok(t.calls.every(c=>c.url.startsWith(BASE+'/v1/')),'no other destination');
  const other=setup({apiBase:'https://other.test',store:new Map([[KEY,meSession()]])});await other.ready;other.$('cloud-tab-mine').click();await flush();assert.equal(other.calls.length,0,'token for another server is ignored');assert.match(other.$('cloud-account-summary').textContent,/로그인 · 초대 가입/);});

test('expired or rejected session asks to sign in again, keeps the local ledger and drops loaded server records',async()=>{
  const old=setup({store:new Map([[KEY,meSession({expiresAt:'2020-01-01T00:00:00Z'})]])});await old.ready;assert.equal(old.store.has(KEY),false);assert.match(old.$('cloud-account-summary').textContent,/다시 로그인 필요/);assert.equal(old.$('cloud-account').open,true);
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>sharedRoute(m,p)||(p.startsWith('/v1/records?scope=mine')?{status:401,body:'<html><body>proxy says hi</body></html>'}:null)});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'shared loaded');t.$('cloud-tab-mine').click();await until(()=>!t.store.has(KEY),'token dropped on 401');await flush();
  assert.match(t.$('cloud-account-body').textContent,/세션이 끝났습니다/);assert.ok(!t.body.textContent.includes('proxy says hi'),'no raw server body');assert.equal(t.$('cloud-tab-shared').getAttribute('aria-pressed'),'true');
  assert.equal(t.records().length,0,'loaded team records are purged');assert.match(t.$('cloud-list').textContent,/로그인 후 불러오면/);t.$('cloud-refresh').click();await flush();assert.equal(t.calls.length,2,'no anonymous fallback read');assert.ok(t.lab.unchanged(),'local ledger untouched');});

test('failed reads and writes keep what is on screen and are never retried',async()=>{
  let page=0;const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>{if(m==='GET'&&p.startsWith('/v1/records?scope=shared')){page++;return page===1?{status:200,body:{records:sharedRecords,nextCursor:'c1'}}:{status:502,body:'<html>Bad gateway from proxy</html>'};}if(m==='POST'&&p==='/v1/records')return 'hang';}});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'first page');assert.equal(t.$('cloud-more').hidden,false);t.$('cloud-more').click();await until(()=>t.$('cloud-status').classList.contains('error'),'error shown');
  assert.equal(t.calls[1].url,BASE+'/v1/records?scope=shared&cursor=c1');assert.equal(t.records().length,2,'loaded records kept');assert.match(t.$('cloud-status').textContent,/공유 서버 오류/);assert.ok(!t.body.textContent.includes('Bad gateway'));
  t.$('cloud-upload').open=true;t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.length>0,'preview');
  t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();t.$('cloud-upload-send').click();await until(()=>/15초/.test(t.$('cloud-upload-status').textContent),'timeout message');await flush();
  assert.equal(t.calls.filter(c=>c.method==='POST').length,1,'write sent once');assert.ok(t.$('cloud-upload-preview').textContent.includes('Synthetic BLUE'),'preview kept');assert.equal(t.$('cloud-upload-consent').checked,false,'resend needs fresh consent');assert.equal(t.$('cloud-upload-send').disabled,true);assert.ok(t.lab.unchanged());});

test('upload is private by default, previews the exact body and needs consent; evidence is opt-in and private only',async()=>{
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>m==='POST'&&p==='/v1/records'?{status:201,body:{record:{...rec('srv-1',JSON.parse(init.body).kind,JSON.parse(init.body).payload,{owner:'author-me',name:'Me',user:'me',visibility:JSON.parse(init.body).visibility})}}}:null});await t.ready;
  assert.equal(t.$('cloud-upload-visibility').value,'private');t.$('cloud-upload-read').click();await flush();assert.deepEqual(t.lab.calls,['cloudSnapshot']);assert.equal(t.calls.length,0,'reading local records sends nothing');
  t.$('cloud-upload-kind').change('run');t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.length>0,'run preview');
  let shown=JSON.parse(t.$('cloud-upload-preview').textContent);assert.equal(shown.visibility,'private');assert.equal('evidence' in shown.payload,false,'evidence off by default');assert.equal(t.$('cloud-upload-send').disabled,true,'consent required');
  t.$('cloud-upload-case').value='case-A';t.$('cloud-upload-case').dispatchEvent(new Event('input'));await until(()=>t.$('cloud-upload-preview').textContent.includes('case-A'),'case label in preview');
  t.$('cloud-upload-evidence').checked=true;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('evidence'),'evidence opt-in');
  t.$('cloud-upload-visibility').change('shared');await until(()=>t.$('cloud-upload-preview').textContent.includes('"shared"'),'shared preview');
  shown=JSON.parse(t.$('cloud-upload-preview').textContent);assert.equal('evidence' in shown.payload,false,'shared never carries evidence');assert.equal(t.$('cloud-upload-evidence').disabled,true);assert.equal(t.$('cloud-upload-consent').checked,false);
  t.$('cloud-upload-visibility').change('private');await until(()=>t.$('cloud-upload-preview').textContent.includes('"private"'),'private again');
  t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();assert.equal(t.$('cloud-upload-send').disabled,false);t.$('cloud-upload-send').click();await until(()=>/올렸습니다/.test(t.$('cloud-upload-status').textContent),'uploaded');
  const post=t.calls.find(c=>c.method==='POST');assert.deepEqual(post.body,JSON.parse(t.$('cloud-upload-preview').textContent),'sent body equals preview');assert.equal(post.headers.authorization,'Bearer '+TOKEN);assert.ok(t.lab.unchanged(),'local ledger untouched');
  t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await until(()=>/먼저 올리고/.test(t.$('cloud-upload-status').textContent)||t.$('cloud-upload-preview').textContent.includes('srv-1'),'review links to cloud run');
  assert.ok(t.$('cloud-upload-preview').textContent.includes('"runId": "srv-1"'),'review points at uploaded cloud run');assert.ok(!t.$('cloud-upload-preview').textContent.includes('Local label'),'local reviewer label not sent');
  assert.ok(!t.$('cloud-upload-preview').textContent.includes('protocolVersion'),'an unconfirmed local review keeps its protocol unknown');assert.match(t.$('cloud-upload-review-conditions').textContent,/프로토콜 미상.*빠집니다/);
  t.$('cloud-upload-review-protocol').checked=true;t.$('cloud-upload-review-protocol').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('"protocolVersion": "p1"'),'confirmed protocol');assert.equal(t.$('cloud-upload-consent').checked,false,'confirming resets consent');});

test('deduplicated upload reports the returned visibility, not the requested sharing state',async()=>{
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>m==='POST'&&p==='/v1/records'?{status:200,body:{deduplicated:true,record:rec('existing-private','harness',JSON.parse(init.body).payload,{owner:'author-me',name:'Me',user:'me',visibility:'private'})}}:null});await t.ready;
  t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-item').change('0');t.$('cloud-upload-visibility').change('shared');await until(()=>t.$('cloud-upload-preview').textContent.includes('shared'),'preview');
  t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();t.$('cloud-upload-send').click();await until(()=>t.$('cloud-upload-status').textContent.includes('같은 내용'),'dedup');
  assert.match(t.$('cloud-upload-status').textContent,/비공개 기록으로 올렸습니다/);assert.ok(!t.$('cloud-upload-status').textContent.includes('공유 기록으로 올렸습니다'));
});

test('public harness preview only loads the editor and links to the existing Harness view',async()=>{
  const t=setup({store:signedIn(),routes:sharedRoute});await t.ready;t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');
  t.press(t.action(t.records()[0],'preview'));await until(()=>t.lab.calls.length===1,'preview called');await flush();assert.equal(t.doc.activeElement,t.action(t.records()[0],'preview'),'focus back on the preview action');
  assert.equal(JSON.stringify(t.lab.calls[0]),JSON.stringify(['preview',harnessConfig,H]),'config and recorded hash only');assert.match(t.$('cloud-status').textContent,/등록·선택·실행은 하지 않았습니다/);
  const go=t.action(t.records()[0],'open-agents');assert.ok(go,'navigation button');assert.equal(go.dataset.view,'agents');assert.equal(t.calls.length,1,'no extra request');assert.ok(t.lab.unchanged());});

test('owner share, unshare and delete send the revision; conflicts change nothing',async()=>{
  const mine=rec('rec-m1','run',{...runPayload,localId:'local-run-1'},{owner:'author-me',name:'Me',user:'me',visibility:'private',revision:3});let patch=0;
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>{if(m==='GET')return {status:200,body:{records:[mine],nextCursor:null}};if(m==='PATCH'){patch++;return patch===1?{status:409,body:{error:{code:'revision_conflict',message:'stale'}}}:{status:200,body:{record:{...mine,visibility:'shared',revision:4}}};}if(m==='DELETE')return {status:204};}});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===1,'mine');t.action(t.records()[0],'visibility').click();assert.match(t.records()[0].textContent,/로그인한 팀 멤버 모두가 읽습니다\. 인터넷 공개는 아닙니다/);assert.equal(t.calls.length,1,'share asks first');
  t.action(t.records()[0],'confirm').click();await until(()=>t.$('cloud-status').classList.contains('error'),'conflict');assert.match(t.$('cloud-status').textContent,/먼저 바뀌었습니다/);assert.deepEqual(t.calls[1].body,{expectedRevision:3,visibility:'shared'});assert.match(t.records()[0].textContent,/비공개/);
  t.action(t.records()[0],'visibility').click();t.action(t.records()[0],'confirm').click();await until(()=>/공유했습니다/.test(t.$('cloud-status').textContent),'shared');assert.match(t.records()[0].textContent,/버전 4/);assert.match(t.$('cloud-status').textContent,/팀 멤버 모두가/);
  t.action(t.records()[0],'visibility').click();assert.match(t.records()[0].textContent,/이미 받아 간 사본은 회수할 수 없습니다/);t.action(t.records()[0],'cancel').click();
  t.action(t.records()[0],'delete').click();t.action(t.records()[0],'confirm').click();await until(()=>t.records().length===0,'deleted');const del=t.calls.at(-1);assert.equal(del.method,'DELETE');assert.equal(del.headers['if-match'],'4');assert.equal(del.url,BASE+'/v1/records/rec-m1');});

test('reviews of others\' shared runs are the author\'s own judgment; uncertain carries no score',async()=>{
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>sharedRoute(m,p)||(m==='POST'?{status:201,body:{record:rec('srv-v1','review',JSON.parse(init.body).payload,{owner:'author-me',visibility:'private'})}}:null)});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.action(t.records()[1],'review').click();assert.equal(t.$('cloud-review').hidden,false);
  t.$('cloud-review-score').change('5');t.$('cloud-review-verdict').change('uncertain');t.$('cloud-review-note').value='Synthetic: cannot judge from the reported summary.';t.$('cloud-review-note').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'review preview');const body=JSON.parse(t.$('cloud-review-preview').textContent);
  assert.equal(body.visibility,'private');assert.equal(body.payload.score,null);assert.equal(body.payload.runId,'rec-r1');assert.equal(body.payload.caseLabel,'case-A');assert.equal(t.$('cloud-review-score').disabled,true);
  assert.equal(t.$('cloud-review-send').disabled,true);t.$('cloud-review-consent').checked=true;t.$('cloud-review-consent').change();t.$('cloud-review-send').click();await until(()=>/검수로 올렸습니다/.test(t.$('cloud-review-status').textContent),'review sent');
  assert.deepEqual(t.calls.at(-1).body,body);assert.equal(t.core.calls.some(c=>c[0]==='compare'),false,'no automatic comparison or model call');});

test('comparison draws the core result with its warnings and no ranking language',async()=>{
  const t=setup({store:signedIn(),routes:sharedRoute});await t.ready;t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.$('cloud-compare-run').click();await until(()=>t.$('cloud-compare-out').textContent.includes('조건 1'),'table');
  const out=t.$('cloud-compare-out').textContent;assert.equal(t.core.calls.find(c=>c[0]==='compare')[1],2);assert.match(out,/Synthetic BLUE v1/);assert.match(out,/로컬 broker 실행\(보고\)/);assert.match(out,/미평가/);
  assert.match(out,/사례 라벨이나 프로토콜이 없는 실행은 비교할 수 없어 뺐습니다\. \(1건\)/);assert.match(out,/대상 실행과 다른 검수는 검수 수·평균에서 뺐습니다\. \(1건\)/);assert.match(out,/검증되지 않았습니다/);assert.ok(!/1위|우승|정확도 검증됨/.test(out.replace('순위가 아닙니다','')));});

test('record JSON download fetches one record only on click, always signed in: owner gets private evidence, others the shared projection, identity checked',async()=>{
  const full={...runPayload,localId:'local-run-1',evidence:{segments:[{id:'s0',label:'p1',text:'Synthetic paper text'}],response:{status:'ok'}}},mine=rec('rec-m1','run',runPayload,{owner:'author-me',name:'Me',user:'me',visibility:'private'});
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>{if(m!=='GET')return null;if(p.startsWith('/v1/records?scope=mine'))return {status:200,body:{records:[mine],nextCursor:null}};if(p.startsWith('/v1/records?scope=shared'))return {status:200,body:{records:sharedRecords,nextCursor:null}};
    if(p==='/v1/records/rec-m1')return {status:200,body:{record:{...mine,payload:full}}};if(p==='/v1/records/rec-r1')return {status:200,body:{record:sharedRecords[1]}};if(p==='/v1/records/rec-h1')return {status:200,body:{record:{...sharedRecords[0],id:'rec-other'}}};return null;}});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===1,'mine');assert.equal(t.calls.length,1,'listing fetches no record detail');assert.equal(t.saved.length,0,'nothing downloads automatically');assert.match(t.records()[0].textContent,/비공개 증거/);
  t.action(t.records()[0],'download').click();await until(()=>t.saved.length===1,'owner saved');const get=t.calls[1];
  assert.equal(get.method,'GET');assert.equal(get.url,BASE+'/v1/records/rec-m1');assert.equal(get.headers.authorization,'Bearer '+TOKEN,'owner reads the full record signed in');
  assert.deepEqual(JSON.parse(await t.saved[0].text()).payload,full);assert.equal(t.anchors.at(-1).getAttribute('download'),'falsify-run-rec-m1.json');assert.match(t.$('cloud-status').textContent,/비공개 증거.*공유하지 마세요/);
  assert.ok(!t.body.textContent.includes('Synthetic paper text'),'private evidence is never rendered');
  t.$('cloud-tab-shared').click();await until(()=>t.records().length===2,'shared');
  t.action(t.records()[1],'download').click();await until(()=>t.saved.length===2,'shared copy saved');assert.equal(t.calls.at(-1).url,BASE+'/v1/records/rec-r1');assert.equal(t.calls.at(-1).headers.authorization,'Bearer '+TOKEN,'other authors are read signed in too');
  assert.match(t.$('cloud-status').textContent,/다른 작성자의 공유본.*비공개 증거와 로컬 ID는 빠져/);assert.ok(!PUBLIC_READ.test(t.$('cloud-status').textContent));
  t.action(t.records()[0],'download').click();await until(()=>t.$('cloud-status').classList.contains('error'),'identity mismatch');assert.equal(t.saved.length,2,'a different record is never saved');assert.match(t.$('cloud-status').textContent,/맞지 않아 저장하지 않았습니다/);
  // The downloaded full record lets a local review link to a run uploaded from another PC.
  t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.includes('"runId": "rec-m1"'),'review linked via downloaded record');
  assert.equal(t.calls.filter(c=>c.method!=='GET').length,0,'no writes');assert.ok(t.lab.unchanged());});

test('own runs can be self-assessed: labelled, bound to the run case and protocol, never claimed independent',async()=>{
  const own=rec('rec-m1','run',runPayload,{owner:'author-me',name:'Me',user:'me',visibility:'private'}),bare=rec('rec-m2','run',{...runPayload,caseLabel:undefined,protocolVersion:undefined},{owner:'author-me',name:'Me',user:'me',visibility:'shared'});
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>m==='GET'&&p.startsWith('/v1/records?scope=mine')?{status:200,body:{records:[own,bare],nextCursor:null}}:null});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===2,'mine');const btn=t.action(t.records()[0],'review');assert.ok(btn,'own private run can be assessed');assert.equal(btn.textContent,'자체 평가 쓰기');btn.click();
  assert.equal(t.$('cloud-review-title').textContent,'내 실행 자체 평가 쓰기');assert.match(t.$('cloud-review-intro').textContent,/독립 검수가 아니며/);assert.match(t.$('cloud-review-target').textContent,/나 · 자체 평가/);
  assert.equal(t.$('cloud-review-case').value,'case-A');assert.equal(t.$('cloud-review-case').disabled,true,'case label bound to the run');assert.equal(t.$('cloud-review-visibility').children[1].disabled,true,'a private run gets no shared review');assert.match(t.$('cloud-review-conditions').textContent,/묶여/);
  t.$('cloud-review-verdict').change('supported');t.$('cloud-review-score').change('4');t.$('cloud-review-note').value='Synthetic self assessment.';t.$('cloud-review-note').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'preview');const body=JSON.parse(t.$('cloud-review-preview').textContent);assert.deepEqual([body.visibility,body.payload.caseLabel,body.payload.protocolVersion],['private','case-A','p1']);
  t.action(t.records()[1],'review').click();assert.match(t.$('cloud-review-conditions').textContent,/사례 라벨과 프로토콜이 없어.*빠집니다/);assert.equal(t.$('cloud-review-case').disabled,false);assert.equal(t.$('cloud-review-case').value,'','nothing filled in for a missing condition');assert.equal(t.$('cloud-review-preview').textContent,'');
  t.$('cloud-review-verdict').change('mixed');t.$('cloud-review-note').value='Synthetic.';t.$('cloud-review-note').dispatchEvent(new Event('input'));t.$('cloud-review-case').value='typed-case';t.$('cloud-review-case').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'bare preview');const bare2=JSON.parse(t.$('cloud-review-preview').textContent).payload;assert.equal(bare2.caseLabel,'typed-case');assert.equal('protocolVersion' in bare2,false,'no protocol invented');
  assert.equal(t.calls.length,1,'nothing sent without consent');assert.equal(t.core.calls.some(c=>c[0]==='compare'),false);});

test('a signed-in browser survives reload; sign-out revokes then clears; another PC signs in again',async()=>{
  const store=new Map([[KEY,meSession()]]),t=setup({store,routes:(m,p)=>m==='POST'&&p==='/v1/logout'?{status:204}:null});await t.ready;await flush();
  assert.match(t.$('cloud-account-summary').textContent,/로그인됨 · Me/);assert.equal(t.calls.length,0,'restoring a session makes no request');
  t.$('cloud-logout').click();await until(()=>!store.has(KEY),'cleared');assert.equal(t.calls[0].url,BASE+'/v1/logout');assert.equal(t.calls[0].headers.authorization,'Bearer '+TOKEN);assert.match(t.$('cloud-status').textContent,/로그아웃했습니다/);
  const failing=setup({store:new Map([[KEY,meSession()]]),routes:()=>({status:503,body:'down'})});await failing.ready;failing.$('cloud-logout').click();await until(()=>failing.$('cloud-status').classList.contains('error'),'logout failure');assert.ok(failing.store.has(KEY),'failed revoke does not pretend');
  failing.$('cloud-forget').click();assert.equal(failing.store.has(KEY),false);
  const pc2=setup({routes:authOk});await pc2.ready;await login(pc2);assert.equal(JSON.parse(pc2.store.get(KEY)).author.id,'author-me','same author on another PC');});

test('keyboard focus follows each record action through the re-render and never pulls focus the user moved',async()=>{
  const m1=rec('rec-m1','run',runPayload,{owner:'author-me',name:'Me',user:'me',visibility:'private'}),m2=rec('rec-m2','harness',{config:harnessConfig,hash:H},{owner:'author-me',name:'Me',user:'me',visibility:'private'});let gate=null;
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>{if(m==='GET'&&p.startsWith('/v1/records?scope=mine'))return {status:200,body:{records:[m1,m2],nextCursor:null}};if(m==='GET'&&p==='/v1/records/rec-m1')return {status:200,body:{record:m1}};
    if(m==='PATCH')return new Promise(r=>{gate=()=>r({status:200,body:{record:{...m1,visibility:'shared',revision:2}}});});if(m==='DELETE')return {status:204};}});await t.ready;
  const at=(i,name)=>t.action(t.records()[i],name),on=(i,name)=>t.doc.activeElement===at(i,name);
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===2,'mine');
  t.press(at(0,'visibility'));assert.ok(on(0,'confirm'),'ask focuses the confirm button');t.press(at(0,'cancel'));assert.ok(on(0,'visibility'),'cancel returns to the visibility action');
  t.press(at(0,'delete'));assert.ok(on(0,'confirm'));t.press(at(0,'cancel'));assert.ok(on(0,'delete'),'cancel returns to delete');assert.equal(t.calls.length,1,'asking and cancelling send nothing');
  t.press(at(0,'download'));await until(()=>t.saved.length===1,'downloaded');await flush();assert.ok(on(0,'download'),'download returns to its button');
  t.press(at(0,'visibility'));t.press(at(0,'confirm'));await until(()=>gate,'patch pending');gate();await until(()=>/공유했습니다/.test(t.$('cloud-status').textContent),'shared');await flush();assert.ok(on(0,'visibility'),'a finished change returns to the same action');
  gate=null;t.press(at(0,'visibility'));t.press(at(0,'confirm'));await until(()=>gate,'second patch pending');t.$('cloud-kind').focus();gate();await until(()=>!t.$('cloud-status').textContent.includes('반영하는 중'),'second done');await flush();
  assert.equal(t.doc.activeElement,t.$('cloud-kind'),'focus moved during the request stays put');
  t.press(at(0,'delete'));t.press(at(0,'confirm'));await until(()=>t.records().length===1,'first deleted');await flush();assert.equal(t.records()[0].dataset.recordId,'rec-m2');assert.ok(on(0,'download'),'delete moves to the neighbouring record');
  t.press(at(0,'delete'));t.press(at(0,'confirm'));await until(()=>t.records().length===0,'all deleted');await flush();assert.equal(t.doc.activeElement,t.$('cloud-status'),'empty list falls back to the status line');
  assert.deepEqual(t.calls.map(c=>c.method),['GET','GET','PATCH','PATCH','DELETE','DELETE'],'only the confirmed actions were sent');});

test('server and session times read as local ko-KR with a zone and keep the raw ISO; record titles are h3 under the section h2',async()=>{
  const iso='2026-10-19T08:15:03.558Z',good={...sharedRecords[0],createdAt:iso},bad={...sharedRecords[1],id:'rec-bad',createdAt:'not-a-date',payload:{...runPayload,createdAt:42}};
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>m==='GET'&&p.startsWith('/v1/records?scope=shared')?{status:200,body:{records:[good,bad],nextCursor:null}}:null});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');
  const time=t.records()[0].find(n=>n.tagName==='TIME'),zone=new Intl.DateTimeFormat('ko-KR',{timeZoneName:'short'}).formatToParts(Date.parse(iso)).find(x=>x.type==='timeZoneName').value;
  assert.ok(time,'time element');assert.equal(time.getAttribute('datetime'),iso);assert.equal(time.getAttribute('title'),iso);assert.match(time.textContent,/2026/);assert.ok(time.textContent.includes(zone),'zone shown');assert.ok(!time.textContent.includes('T08:15')&&!t.records()[0].textContent.includes('.558Z'),'no raw ISO on screen');
  assert.equal(t.records()[1].find(n=>n.tagName==='TIME'),null);assert.equal((t.records()[1].textContent.match(/시각 미상/g)||[]).length,2,'unparseable server and reported times get fixed copy');
  const exp=t.$('cloud-account-body').find(n=>n.tagName==='TIME');assert.equal(exp.getAttribute('datetime'),FUTURE);assert.ok(!t.$('cloud-account-body').textContent.includes(FUTURE),'session expiry is formatted');
  assert.ok(t.$('cloud-records').find(n=>n.tagName==='H2'));for(const a of t.records()){assert.ok(a.find(n=>n.tagName==='H3'),'record title is h3');assert.equal(a.find(n=>n.tagName==='H4'),null);}});

test('signed out, 내 기록 explains sign-in, focuses the username field and requests nothing',async()=>{
  const t=setup({routes:sharedRoute});await t.ready;assert.equal(t.$('cloud-account').open,false);t.press(t.$('cloud-tab-mine'));await flush();
  assert.equal(t.calls.length,0,'no request without sign-in');assert.equal(t.$('cloud-account').open,true);assert.equal(t.doc.activeElement,t.$('cloud-username'));
  assert.match(t.$('cloud-status').textContent,/내 기록은 로그인한 뒤 볼 수 있습니다/);assert.ok(t.$('cloud-status').classList.contains('error'));assert.equal(t.$('cloud-tab-shared').getAttribute('aria-pressed'),'true');assert.equal(t.$('cloud-tab-mine').getAttribute('aria-pressed'),'false');});

test('styles: hover never repaints the active tab, the kind label keeps its gap, record titles are styled as h3',()=>{
  const css=fs.readFileSync(path.resolve(__dirname,'../legacy/cloud-records.css'),'utf8');
  for(const m of css.matchAll(/([^{}]*:hover[^{}]*)\{/g))if(m[1].includes('.cloud-tabs'))assert.match(m[1],/\[aria-pressed=false\]/,'tab hover is limited to inactive tabs');
  assert.match(css,/label\.cloud-kind\{[^}]*gap:12px/);assert.match(css,/\.cloud-record h3\{/);assert.ok(!/\.cloud-record h4/.test(css));});

// Invitation sign-up: what was typed, what was sent and what is left anywhere afterwards.
const register=async(t,{user='synthetic_new',code=INVITE,display=''}={})=>{t.$('cloud-username').value=user;t.$('cloud-password').value='correct horse battery';t.$('cloud-invite').value=code;t.$('cloud-display-name').value=display;t.press(t.$('cloud-register'));await flush();};
const leftovers=(t,code)=>[...t.store.values()].some(v=>v.includes(code))||[...t.body.walk()].some(n=>n.value===code||n.textContent.includes(code))||t.calls.some(c=>c.url.includes(code)||c.url.includes('fsi_'));

test('register sends the invitation once with the account fields; login never sends it; the field is masked and not autofilled',async()=>{
  const t=setup({routes:(m,p)=>m==='POST'&&p==='/v1/auth/register'?{status:201,body:{token:TOKEN,author:{id:'author-new',username:'synthetic_new',displayName:'New'},expiresAt:FUTURE}}:authOk(m,p)});await t.ready;
  const field=t.$('cloud-invite');assert.equal(field.type,'password');assert.equal(field.getAttribute('autocomplete'),'off');assert.equal(field.name,undefined,'no name, so no form submission carries it');assert.match(t.$('cloud-account-body').textContent,/초대 코드 · 가입할 때만/);
  t.$('cloud-invite').value=INVITE;await login(t);assert.deepEqual(t.calls[0].body,{username:'synthetic_me',password:'correct horse battery'},'login omits the invitation');assert.ok(!leftovers(t,INVITE),'typed code cleared on login too');
  const t2=setup({routes:(m,p)=>m==='POST'&&p==='/v1/auth/register'?{status:201,body:{token:TOKEN,author:{id:'author-new',username:'synthetic_new',displayName:'New'},expiresAt:FUTURE}}:null});await t2.ready;
  await register(t2,{display:'New'});await until(()=>t2.store.has(KEY),'registered');
  assert.equal(t2.calls.length,1,'one request');assert.equal(t2.calls[0].url,BASE+'/v1/auth/register');assert.deepEqual(t2.calls[0].body,{username:'synthetic_new',password:'correct horse battery',inviteCode:INVITE,displayName:'New'});
  assert.equal(t2.calls[0].headers.authorization,undefined);assert.ok(!t2.store.get(KEY).includes(INVITE)&&!t2.store.get(KEY).includes('correct horse'),'session holds neither code nor password');
  assert.ok(!leftovers({...t2,calls:[]},INVITE),'nothing on screen or in storage keeps the code');assert.match(t2.$('cloud-status').textContent,/가입했습니다/);assert.equal(t2.doc.activeElement,t2.$('cloud-status'),'focus lands on the outcome');});

test('every register outcome clears the invitation field and shows fixed copy, never the server body',async()=>{
  const outcomes=[[403,/초대 코드가 맞지 않거나 만료·회수·사용된 코드입니다/,'cloud-invite'],[409,/이미 쓰는 사용자 이름입니다\. 초대 코드는 쓰이지 않았으니/,'cloud-password'],[400,/초대 가입을 지원하지 않는 서버일 수 있으니/,'cloud-password'],[429,/요청이 너무 많습니다/,'cloud-password'],[503,/공유 서버 오류/,'cloud-password'],['hang',/15초/,'cloud-password']];
  for(const [status,copy,focus] of outcomes){const t=setup({routes:(m,p)=>m==='POST'&&p==='/v1/auth/register'?(status==='hang'?'hang':{status,body:{error:{code:'invalid_invitation',message:'server says '+INVITE}}}):null});await t.ready;
    await register(t);await until(()=>t.$('cloud-status').classList.contains('error'),'refused '+status);
    assert.equal(t.calls.length,1,'sent once, never retried ('+status+')');assert.equal(t.calls[0].body.inviteCode,INVITE);assert.match(t.$('cloud-status').textContent,copy);
    assert.ok(!t.body.textContent.includes('server says'),'no server message');assert.equal(t.$('cloud-invite').value,'','field cleared ('+status+')');assert.equal(t.$('cloud-password').value,'');assert.equal(t.$('cloud-username').value,'synthetic_new','username kept for the retry');
    assert.ok(!leftovers({...t,calls:[]},INVITE),'code left nowhere ('+status+')');assert.equal(t.store.has(KEY),false);assert.equal(t.doc.activeElement,t.$(focus),'focus on the field to fix ('+status+')');}
  for(const [code,copy] of [['',/초대 코드가 필요합니다/],['fsi_short',/형식이 맞지 않습니다/],['x'.repeat(47),/형식이 맞지 않습니다/]]){const t=setup();await t.ready;await register(t,{code});
    assert.equal(t.calls.length,0,'malformed or missing codes are refused locally');assert.match(t.$('cloud-status').textContent,copy);assert.ok(!t.$('cloud-status').textContent.includes(code||'\u0000'),'the typed value is not echoed');assert.equal(t.$('cloud-invite').value,'');assert.equal(t.doc.activeElement,t.$('cloud-invite'));}
  const login403=setup({routes:(m,p)=>m==='POST'&&p==='/v1/auth/login'?{status:403,body:{error:{code:'membership_required',message:'nope'}}}:null});await login403.ready;await login(login403);
  assert.match(login403.$('cloud-status').textContent,/활성 팀 멤버가 아니라 로그인할 수 없습니다/);assert.equal(login403.store.has(KEY),false);});

test('a 403 on a signed-in read signs out with fixed member copy and purges server records; writes keep the session',async()=>{
  let deny=false;const t=setup({store:signedIn(),routes:(m,p)=>{if(m==='GET'&&p.startsWith('/v1/records?'))return deny?{status:403,body:'<html>membership proxy page</html>'}:{status:200,body:{records:sharedRecords,nextCursor:null}};if(m==='PATCH')return {status:403,body:{error:{code:'forbidden'}}};}});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.$('cloud-compare-run').click();await until(()=>t.$('cloud-compare-out').textContent.includes('조건 1'),'compared');
  deny=true;t.$('cloud-refresh').click();await until(()=>!t.store.has(KEY),'session dropped');await flush();
  assert.equal(t.records().length,0,'records purged');assert.equal(t.$('cloud-compare-out').textContent,'','comparison purged');assert.match(t.$('cloud-account-summary').textContent,/팀 멤버 확인 필요/);assert.equal(t.$('cloud-account').open,true);
  assert.match(t.$('cloud-account-body').textContent,/팀 멤버 자격이 확인되지 않아/);assert.match(t.$('cloud-status').textContent,/운영자에게 확인한 뒤 다시 로그인하세요/);assert.ok(!t.body.textContent.includes('membership proxy page'));assert.ok(t.lab.unchanged());
  const mine=rec('rec-m1','harness',{config:harnessConfig,hash:H},{owner:'author-me',name:'Me',user:'me',visibility:'private'});
  const w=setup({store:signedIn(),routes:(m,p)=>m==='GET'?{status:200,body:{records:[mine],nextCursor:null}}:m==='PATCH'?{status:403,body:{error:{code:'forbidden'}}}:null});await w.ready;
  w.$('cloud-tab-mine').click();await until(()=>w.records().length===1,'mine');w.action(w.records()[0],'visibility').click();w.action(w.records()[0],'confirm').click();await until(()=>w.$('cloud-status').classList.contains('error'),'write refused');
  assert.match(w.$('cloud-status').textContent,/권한이 없거나 팀 멤버 자격이 확인되지 않습니다/);assert.ok(w.store.has(KEY),'an ownership refusal does not sign out');assert.equal(w.records().length,1);});

test('sign-out purges loaded records, comparison, review composer and upload preview; a late response is dropped',async()=>{
  let gate=null;const store=signedIn(),t=setup({store,routes:(m,p)=>{if(m==='POST'&&p==='/v1/logout')return {status:204};if(m==='GET'&&p.startsWith('/v1/records?scope=shared'))return gate===null?{status:200,body:{records:sharedRecords,nextCursor:null}}:new Promise(r=>{gate=()=>r({status:200,body:{records:sharedRecords,nextCursor:null}});});
    if(m==='GET'&&p.startsWith('/v1/records?scope=mine'))return {status:200,body:{records:[rec('rec-m1','run',{...runPayload,localId:'local-run-1'},{owner:'author-me',name:'Me',user:'me',visibility:'private'})],nextCursor:null}};}});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.$('cloud-compare-run').click();await until(()=>t.$('cloud-compare-out').textContent.includes('조건 1'),'compared');
  t.action(t.records()[1],'review').click();assert.equal(t.$('cloud-review').hidden,false);t.press(t.action(t.records()[0],'preview'));await until(()=>t.action(t.records()[0],'open-agents'),'previewed');
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===1&&!t.$('cloud-tab-shared').disabled,'mine');t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.includes('rec-m1'),'review upload preview');
  t.press(t.$('cloud-logout'));await until(()=>!store.has(KEY),'signed out');await flush();
  assert.equal(t.records().length,0);assert.equal(t.$('cloud-compare-out').textContent,'');assert.equal(t.$('cloud-review').hidden,true);assert.equal(t.$('cloud-review-preview').textContent,'');assert.equal(t.$('cloud-upload-preview').textContent,'','upload preview built from server records is cleared');
  assert.equal(t.$('cloud-tab-shared').getAttribute('aria-pressed'),'true');assert.match(t.$('cloud-status').textContent,/불러온 서버 기록을 지웠습니다/);assert.equal(t.doc.activeElement,t.$('cloud-status'),'focus follows the outcome');assert.ok(t.lab.unchanged(),'local ledger untouched');
  const late=setup({store:signedIn(),routes:(m,p)=>m==='POST'&&p==='/v1/logout'?{status:204}:m==='GET'?new Promise(r=>{gate=()=>r({status:200,body:{records:sharedRecords,nextCursor:null}});}):null});await late.ready;
  gate=null;late.$('cloud-refresh').click();await until(()=>gate,'list pending');late.$('cloud-forget').click();gate();await until(()=>!late.$('cloud-refresh').disabled,'list settled');await flush();
  assert.equal(late.records().length,0,'a response after sign-out never re-fills the screen');assert.equal(late.calls.filter(c=>c.method==='GET').length,1);});

test('another author\'s copy carrying owner-only fields is refused, not saved',async()=>{
  const t=setup({store:signedIn(),routes:(m,p)=>m!=='GET'?null:p.startsWith('/v1/records?')?{status:200,body:{records:sharedRecords,nextCursor:null}}:p==='/v1/records/rec-r1'?{status:200,body:{record:{...sharedRecords[1],payload:{...runPayload,localId:'leak',evidence:{segments:[{id:'s0',label:'p1',text:'Leaked paper text'}],response:{}}}}}}:null});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.press(t.action(t.records()[1],'download'));await until(()=>t.$('cloud-status').classList.contains('error'),'refused');await flush();
  assert.equal(t.saved.length,0,'nothing saved');assert.match(t.$('cloud-status').textContent,/작성자 전용 필드.*저장하지 않았습니다/);assert.ok(!t.body.textContent.includes('Leaked paper text'));assert.equal(t.calls.at(-1).headers.authorization,'Bearer '+TOKEN);assert.equal(t.doc.activeElement,t.action(t.records()[1],'download'));});

// With the contract core beside it (after integration, or FALSIFY_CLOUD_CORE before), run the upload/review/compare path through the real validators.
const corePath=process.env.FALSIFY_CLOUD_CORE||path.resolve(__dirname,'../dist/cloud-records-core.mjs');
if(fs.existsSync(corePath))test('real contract core: run, evidence opt-in, linked review and comparison',async()=>{
  const Hc=require('../dist/harness-core.js');globalThis.FalsifyHarness=Hc;const C=await import(require('node:url').pathToFileURL(corePath).href),outer=x=>x===undefined?x:JSON.parse(JSON.stringify(x));
  const core={validatePayload:(k,p)=>C.validatePayload(k,outer(p)),runFromLocal:(r,o)=>C.runFromLocal(outer(r),outer(o)),reviewFromLocal:(v,id,o)=>C.reviewFromLocal(outer(v),id,outer(o)),compareRecords:rs=>C.compareRecords(outer(rs))};
  const harness=Hc.builtin('red'),hash=await Hc.hash(harness),segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'}],sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const run={id:'local-run-1',createdAt:'2026-10-19T01:02:03.000Z',role:'red',revision:'rev',fileHash:F,sourceHash:await sha(segments[0].text),segments,harness,harnessHash:hash,maxCalls:8,level:1,model:'synthetic-model',provenance:'local-codex',
    response:{schema:'falsify.document-red.v1',revision:'rev',sourceHash:'x',status:'abstain',candidates:[],coverage:{complete:true,completedChunks:1,chunks:1,calls:1}}};
  const lab=labStub();lab.db.harnesses=[{config:harness,hash}];lab.db.runs=[run];lab.db.reviews=[{id:'local-review-1',runId:'local-run-1',reviewer:'Local label',caseLabel:'case-1',verdict:'supported',score:4,note:'Synthetic note.',createdAt:'2026-10-19T02:00:00Z'}];const localBefore=JSON.stringify(lab.db);
  let n=0;const posted=[],t=setup({lab,core,store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>{if(m!=='POST')return null;const b=JSON.parse(init.body);posted.push(b);n++;return {status:201,body:{record:rec('00000000-0000-4000-8000-00000000000'+n,b.kind,b.payload,{owner:'author-me',name:'Me',user:'me',visibility:b.visibility})}};}});await t.ready;
  const send=async label=>{await until(()=>t.$('cloud-upload-preview').textContent.length>0,label+' preview');t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();t.$('cloud-upload-send').click();await until(()=>posted.length===n&&/올렸습니다/.test(t.$('cloud-upload-status').textContent),label+' sent');};
  t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-item').change('0');await send('harness');
  t.$('cloud-upload-kind').change('run');t.$('cloud-upload-item').change('0');t.$('cloud-upload-case').value='case-1';t.$('cloud-upload-case').dispatchEvent(new Event('input'));
  t.$('cloud-upload-evidence').checked=true;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('"evidence"'),'real evidence opt-in');
  t.$('cloud-upload-evidence').checked=false;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('case-1')&&!t.$('cloud-upload-preview').textContent.includes('"evidence"'),'evidence off again');await send('run');
  assert.equal(posted[1].payload.protocolVersion,'falsify.document-red.v1');assert.equal(posted[1].payload.localId,'local-run-1');
  t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await send('unconfirmed review');assert.equal(posted[2].payload.runId,'00000000-0000-4000-8000-000000000002');assert.equal('protocolVersion' in posted[2].payload,false,'local review protocol is never inferred');assert.ok(!JSON.stringify(posted[2]).includes('Local label'));
  t.$('cloud-compare-run').click();await until(()=>/대상 실행과 다른 검수는 검수 수·평균에서 뺐습니다/.test(t.$('cloud-compare-out').textContent),'real mismatch warning');assert.match(t.$('cloud-compare-out').textContent,/0건 · 검수자 0명/);
  t.$('cloud-upload-item').change('0');await until(()=>!t.$('cloud-upload-review-protocol').disabled&&t.$('cloud-upload-preview').textContent.length>0,'relinked');t.$('cloud-upload-review-protocol').checked=true;t.$('cloud-upload-review-protocol').change();
  await until(()=>t.$('cloud-upload-preview').textContent.includes('"protocolVersion"'),'confirmed protocol');await send('confirmed review');assert.equal(posted[3].payload.protocolVersion,'falsify.document-red.v1');assert.equal(posted[3].payload.supersedes,'00000000-0000-4000-8000-000000000003');
  t.$('cloud-compare-run').click();await until(()=>/1건 · 검수자 1명/.test(t.$('cloud-compare-out').textContent),'real comparison');assert.match(t.$('cloud-compare-out').textContent,/case-1/);assert.equal(JSON.stringify(lab.db),localBefore,'local ledger untouched');});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('ok - '+name);}catch(e){failed++;console.error('not ok - '+name+'\n'+(e.stack||e));}}
  console.log(JSON.stringify({passed:tests.length-failed,failed}));process.exitCode=failed?1:0;})();

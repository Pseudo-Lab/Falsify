'use strict';
// Node regression for per-role CLI/model/effort selection and the hosted terminal launch URI.
// Synthetic DOM, mocked bridge/fetch; no browser, network, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const H=require('../dist/harness-core.js'),L=require('../dist/local-bridge.js'),dist=path.resolve(__dirname,'../dist');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
// CI hashes off-thread, so derivation can outlast flush(). CLI_SELECTION_DELAY_TICKS=N makes every SHA-256 digest
// (ledger and harness core) resolve N macrotasks late, deterministically reproducing that scheduling.
const DELAY=Number(process.env.CLI_SELECTION_DELAY_TICKS||0);
const slowCrypto=ticks=>({randomUUID:()=>globalThis.crypto.randomUUID(),subtle:{digest:(a,d)=>globalThis.crypto.subtle.digest(a,d).then(async v=>{await flush(ticks);return v;})}});
const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789';
const OLD_CAP={red:true,blue:true,pdf:false,model:'gpt-6.1-sol'};
const NEW_CAP={...OLD_CAP,cliSelection:true,cliAgents:[{id:'codex',name:'Codex CLI',installed:true,defaultModel:'gpt-6.1-sol',models:['gpt-6.1-sol','gpt-6-astra','bad model'],efforts:['low','medium','high']},{id:'claude',name:'Claude Code CLI',installed:true,defaultModel:'claude-opus-5-5',models:['claude-opus-5-5','sonnet'],efforts:['low','medium','high']},{id:'rm -rf',installed:true}]};

test('harness adapter v1: legacy and both CLIs validate, malformed model/effort rejected',()=>{const base=H.builtin('red');
  for(const adapter of [undefined,{type:'codex'},{type:'claude'},{type:'codex',model:'gpt-6.1-sol',effort:'medium'},{type:'claude',model:'claude-opus-5-5',effort:'high'},{type:'claude',model:'a'.repeat(120)},{type:'codex',model:'org/x'.replace('/','.')+':v1_2-3'}])
    assert.doesNotThrow(()=>H.validate(adapter?{...base,adapter}:base),JSON.stringify(adapter));
  for(const adapter of [{type:'claude',model:'opus 4'},{type:'claude',model:'-opus'},{type:'claude',model:'오퍼스'},{type:'codex',model:'a'.repeat(121)},{type:'codex',model:''},{type:'codex',effort:'max'},{type:'codex',effort:'MEDIUM'},{type:'claude',command:'claude --dangerously'},{type:'codex',model:'x',args:[]},{type:'stdio',executable:'C:/x.exe',args:[],model:'x'},{type:'gemini'},[]])
    assert.throws(()=>H.validate({...base,adapter}),JSON.stringify(adapter));});

test('selection derives a new immutable version; custom stdio/http adapters are untouched',async()=>{const base=H.builtin('blue'),before=JSON.stringify(base);
  const sel={type:'claude',model:'claude-opus-5-5',effort:'medium'},derived=H.withCli(base,sel);
  assert.deepEqual(derived.adapter,sel);assert.equal(JSON.stringify(base),before,'base config not mutated');assert.notEqual(await H.hash(derived),await H.hash(base));
  assert.notEqual(await H.hash(H.withCli(base,{...sel,effort:'high'})),await H.hash(derived),'effort is part of the hash');
  assert.equal(H.derivedFrom(derived,base),true);assert.equal(H.derivedFrom({...derived,instructions:'other'},base),false);assert.equal(H.needsCliCaps(derived),true);assert.equal(H.needsCliCaps({...base,adapter:{type:'codex'}}),false);assert.equal(H.needsCliCaps(base),false);
  for(const adapter of [{type:'stdio',executable:'C:/py.exe',args:['h.py']},{type:'http',url:'https://example.com/h'}]){const custom={...base,adapter};assert.deepEqual(H.withCli(custom,sel),custom);assert.equal(H.cliCapable(custom),false);assert.equal(H.derivedFrom(H.withCli(base,sel),custom),false);}
  for(const bad of [{type:'claude'},{type:'claude',model:'x y',effort:'low'},{type:'shell',model:'x',effort:'low'},{type:'codex',model:'x',effort:'max'}])assert.throws(()=>H.withCli(base,bad),JSON.stringify(bad));
  assert.deepEqual(H.CLI.codex.models,['gpt-6.1-sol','gpt-6-astra','gpt-6-luna']);assert.deepEqual(H.CLI.claude.models,['claude-opus-5-5','opus','sonnet','haiku']);assert.equal(H.DEFAULT_EFFORT,'medium');});

test('launch URI is exactly falsify://connect?port=N with a strict port and nothing secret',()=>{
  for(const [p,uri] of [['7816','falsify://connect?port=7816'],['',  'falsify://connect?port=7816'],[' 1024 ','falsify://connect?port=1024'],[65535,'falsify://connect?port=65535']])assert.equal(L.launchUri(p),uri);
  for(const bad of ['80','1023','65536','7816&token=x','7816/evil','０７８１６','7816 7817',1023.5,70000,'1e4',null])assert.equal(L.launchUri(bad),bad===null?'falsify://connect?port=7816':null,String(bad));
  assert.ok(/^powershell -NoProfile -ExecutionPolicy Bypass -File \.\\install-connection\.ps1$/.test(L.INSTALL));});

function bridgeWith(queue=[]){const calls=[],states=[];const fetch=(url,init)=>{calls.push({url,init});const n=queue.shift();return n?Promise.resolve({ok:true,status:200,redirected:false,type:'cors',json:async()=>n}):Promise.reject(new TypeError('no mock'));};
  return {bridge:L.create({fetch,location:{hostname:'shinick-han.github.io',port:''},emit:s=>states.push(s)}),calls,states};}
function panelDom(){const els={},listeners={};const el=id=>els[id]||(els[id]={id,value:'',hidden:false,disabled:false,textContent:'',dataset:{},href:'',_l:{},addEventListener(t,f){this._l[t]=f;},click(){return this._l.click?.();},focus(){this.focused=true;},classList:{toggle(){}}});
  for(const id of ['local-bridge','bridge-status','bridge-pair','bridge-port','bridge-token','bridge-connect','bridge-disconnect','bridge-command','bridge-feedback','bridge-launch','bridge-launch-status','bridge-other-os','bridge-install'])el(id);els['bridge-port'].value='7816';
  return {els,getElementById:id=>els[id]||null,querySelectorAll:()=>[],addEventListener(t,f){listeners[t]=f;},fire(t,detail){listeners[t]?.({detail});}};}

test('terminal launch: never on load, explicit click opens only the URI, locks and port rules hold',async()=>{const {bridge,calls}=bridgeWith([NEW_CAP]);const dom=panelDom(),opened=[];
  L.mount(bridge,dom,{platform:'Windows',open:u=>opened.push(u)});await bridge.ready;assert.deepEqual(opened,[],'nothing opened on load');assert.equal(calls.length,0);
  assert.equal(dom.els['bridge-launch'].hidden,false);assert.equal(dom.els['bridge-other-os'].hidden,true);assert.match(dom.els['bridge-install'].textContent,/install-connection\.ps1/);
  dom.els['bridge-port'].value='99999';dom.els['bridge-launch'].click();assert.deepEqual(opened,[]);assert.match(bridge.state().error,/1024–65535/);
  dom.els['bridge-port'].value='7817';dom.els['bridge-token'].value='typed-but-not-sent';dom.els['bridge-launch'].click();assert.deepEqual(opened,['falsify://connect?port=7817']);assert.ok(!opened[0].includes('typed'));assert.equal(dom.els['bridge-token'].focused,true);
  dom.fire('falsify:local-bridge',bridge.state());assert.match(dom.els['bridge-launch-status'].textContent,/설치 여부를 알려주지 않습니다/);assert.equal(calls.length,0,'launch makes no network call');
  assert.equal((await bridge.pair(TOKEN,'7817')).ok,true);dom.fire('falsify:local-bridge',bridge.state());assert.equal(dom.els['bridge-launch'].disabled,true);assert.equal(bridge.launch('7817',u=>opened.push(u)).ok,false);
  bridge.busy('red',true);assert.equal(bridge.launch('7817',u=>opened.push(u)).ok,false);bridge.busy('red',false);bridge.disconnect();
  bridge.busy('blue',true);assert.equal(bridge.launch('7817',u=>opened.push(u)).ok,false,'frozen while busy');bridge.busy('blue',false);assert.equal(opened.length,1);
  const local=L.create({fetch:()=>Promise.reject(new TypeError('x')),location:{hostname:'127.0.0.1',port:'7816'}});await local.ready;assert.equal(local.launch('7816',u=>opened.push(u)).ok,false);assert.equal(opened.length,1);
  const other=panelDom();const otherBridge=bridgeWith().bridge;L.mount(otherBridge,other,{platform:'macOS',open:u=>opened.push(u)});assert.equal(other.els['bridge-launch'].hidden,false);assert.equal(other.els['bridge-other-os'].hidden,true);assert.equal(other.els['bridge-install'].textContent,'python3 -m venv .venv && .venv/bin/python -m pip install -r app/local/requirements.txt && ./install-connection.sh');assert.match(other.els['bridge-command'].textContent,/python3 -m venv/);otherBridge.disconnect();other.fire('falsify:local-bridge',otherBridge.state());assert.equal(other.els['bridge-launch'].hidden,false,'POSIX handler stays available after disconnect');});

test('capabilities: cliSelection catalogue is sanitized; old brokers report no CLI selection',async()=>{let h=bridgeWith([NEW_CAP]);await h.bridge.pair(TOKEN,'7816');const cap=h.bridge.capabilities();
  assert.equal(cap.cliSelection,true);assert.deepEqual(cap.cliAgents.map(a=>a.id),['codex','claude']);assert.deepEqual(cap.cliAgents[0].models,['gpt-6.1-sol','gpt-6-astra']);assert.ok(Object.isFrozen(cap.cliAgents[0].models));
  h=bridgeWith([OLD_CAP]);await h.bridge.pair(TOKEN,'7816');assert.equal(h.bridge.capabilities().cliSelection,false);assert.equal(h.bridge.capabilities().cliAgents,null);
  h=bridgeWith([{...OLD_CAP,cliSelection:'yes',cliAgents:NEW_CAP.cliAgents}]);await h.bridge.pair(TOKEN,'7816');assert.equal(h.bridge.capabilities().cliSelection,false);});

// Synthetic DOM for the ledger: elements register by id when assigned; querySelector('#id') resolves or creates.
function world(stored){
  const els=new Map(),store=new Map(stored||[]);
  function element(tag){const e=new EventTarget(),classes=new Set();let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;els.set(v,e);}});
    Object.assign(e,{tagName:String(tag).toUpperCase(),disabled:false,hidden:false,checked:false,value:'',textContent:'',placeholder:'',children:[],parent:null,dataset:{},attrs:{},
      classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
      setAttribute(k,v){this.attrs[k]=v;},append(...c){for(const x of c){if(x&&typeof x==='object')x.parent=this;this.children.push(x);}},replaceChildren(...c){this.children=[];this.append(...c);},prepend(...c){this.children.unshift(...c);},after(){},remove(){},reset(){},focus(){},
      closest(sel){let n=this;while(n){if(n.tagName===sel.toUpperCase())return n;n=n.parent;}return null;}});
    Object.defineProperty(e,'innerHTML',{set(){}});Object.defineProperty(e,'firstChild',{get(){return this.children[0]??null;}});return e;}
  const get=id=>{if(!els.has(id))element('div').id=id;return els.get(id);};
  const document=new EventTarget();Object.assign(document,{readyState:'complete',createElement:element,querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],body:element('body')});
  let state={status:'manual',connected:false,cap:null};
  // VM-realm objects are normalized to this realm so deepStrictEqual compares values only.
  const plain=x=>JSON.parse(JSON.stringify(x)),events=[];document.addEventListener('falsify:harness-change',e=>events.push(plain(e.detail)));
  const ctx=vm.createContext({document,FalsifyReview:require('../dist/review-workbench.js'),FalsifyHarness:H,FalsifyLocalBridge:{capabilities:()=>state.cap,state:()=>state},FalsifyDocumentRed:require('../dist/document-red-core.js'),FalsifyDocumentBlue:require('../dist/document-blue-core.js'),
    localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},crypto:DELAY?slowCrypto(DELAY):globalThis.crypto,TextEncoder,CustomEvent,Event,URL,Blob,setTimeout,clearTimeout});
  // With delayed crypto the harness core is loaded in the page realm so its hash() uses the same slow digest.
  if(DELAY)vm.runInContext(fs.readFileSync(path.join(dist,'harness-core.js'),'utf8'),ctx,{filename:'harness-core.js'});
  vm.runInContext(fs.readFileSync(path.join(dist,'experiment-ledger.js'),'utf8'),ctx,{filename:'experiment-ledger.js'});
  const setCap=cap=>{state={status:cap?'paired':'manual',connected:!!cap,cap};document.dispatchEvent(new CustomEvent('falsify:local-bridge',{detail:state}));};
  const change=(id,value)=>{const e=get(id);e.value=value;e.dispatchEvent(new Event('change'));};
  const lab=ctx.FalsifyLab;
  return {get,lab:{...lab,ready:lab.ready,bind:async(...a)=>plain(await lab.bind(...a))},setCap,change,events,store};
}
// Capabilities go through the real bridge sanitizer.
async function capOf(raw){const b=L.create({fetch:async()=>({ok:true,status:200,redirected:false,type:'cors',json:async()=>raw}),location:{hostname:'x.example',port:''}});await b.pair(TOKEN,'7816');return b.capabilities();}
async function live(raw,stored){const w=world(stored);await w.lab.ready;await flush();if(raw)w.setCap(await capOf(raw));return w;}
const consents=(w,role)=>[w.get(role+'-harness-consent'),w.get(role==='red'?'red-consent':'doc-blue-consent')];
// A user picks the next CLI option only after the controls unlock; the UI ignores changes while the hash is derived.
// Bounded wait on bind(), which resolves once the pending derivation settles; then the controls must be ready.
let settleWaits=0;
async function settle(w,role,ms=5000){if(/고정하는 중/.test(w.get(role+'-cli-note').textContent))settleWaits++;let timer;
  try{await Promise.race([w.lab.bind(role,{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(role+' CLI derivation did not settle within '+ms+'ms')),ms);})]);}finally{clearTimeout(timer);}
  assert.doesNotMatch(w.get(role+'-cli-note').textContent,/고정하는 중/);assert.equal(w.get(role+'-cli-type').disabled,false,role+' CLI controls ready');}

test('legacy default: no explicit selection binds the unchanged built-in harness; disconnected choice refused',async()=>{const w=await live(null);
  assert.deepEqual((await w.lab.bind('red',{maxCalls:8})).harness,H.builtin('red'),'no adapter injected');
  assert.equal(w.get('red-cli-type').value,'');assert.equal(w.get('red-cli-model').disabled,true);assert.equal(w.get('red-cli-type').disabled,false);
  w.change('red-cli-type','claude');await flush();assert.equal(w.get('red-cli-type').value,'');assert.equal(w.events.length,0);assert.match(w.get('red-cli-note').textContent,/연결하면/);});

test('old broker: CLI choice disabled with an upgrade message, legacy execution still allowed',async()=>{const w=await live(OLD_CAP);
  assert.match(w.get('blue-cli-note').textContent,/구버전.*업데이트/);assert.equal(w.get('blue-cli-type').children.find(o=>o.value==='claude').disabled,true);
  w.change('blue-cli-type','codex');await flush();assert.equal(w.events.length,0);assert.equal(w.get('blue-cli-type').value,'');assert.equal(w.lab.allowed('blue'),true);
  assert.equal((await w.lab.bind('blue',{maxCalls:8})).harness.adapter,undefined);});

test('provider/model/effort change clears consent, emits harness-change and locks runs until the hash is bound',async()=>{const w=await live(NEW_CAP);
  for(const c of consents(w,'red'))c.checked=true;
  w.change('red-cli-type','claude');
  assert.deepEqual(w.events.at(-1),{role:'red',cli:true});for(const c of consents(w,'red'))assert.equal(c.checked,false,c.id);
  assert.equal(w.lab.allowed('red'),false,'locked while deriving');assert.equal(w.get('red-cli-type').disabled,true);assert.match(w.get('red-cli-note').textContent,/고정하는 중/);
  const first=await w.lab.bind('red',{maxCalls:8});assert.deepEqual(first.harness.adapter,{type:'claude',model:'claude-opus-5-5',effort:'medium'},'bind waits for derivation');
  await flush();assert.equal(w.lab.allowed('red'),true);assert.equal(w.get('red-cli-model').value,'claude-opus-5-5');assert.match(w.get('red-harness-detail').textContent,/Claude Code CLI · claude-opus-5-5 · effort medium/);
  assert.deepEqual(w.get('red-cli-models').children.map(o=>o.value),['claude-opus-5-5','sonnet']);
  for(const [id,value,count] of [['red-cli-effort','high',2],['red-cli-model','sonnet',3],['red-cli-model','bad model!',3],['red-cli-model','sonnet',3]]){w.change(id,value);await settle(w,'red');assert.equal(w.events.length,count,id+'='+value);}
  assert.equal(w.get('red-cli-model').value,'sonnet','invalid model reverted');
  const second=await w.lab.bind('red',{maxCalls:8});assert.deepEqual(second.harness.adapter,{type:'claude',model:'sonnet',effort:'high'});
  assert.deepEqual(first.harness.adapter,{type:'claude',model:'claude-opus-5-5',effort:'medium'},'earlier request unchanged');second.harness.adapter.model='mutated';assert.equal((await w.lab.bind('red',{})).harness.adapter.model,'sonnet','bound copy is immutable');
  assert.notEqual(H.canonical(first.harness),H.canonical(second.harness));assert.deepEqual((await w.lab.bind('blue',{})).harness,H.builtin('blue'),'roles are independent');
  w.change('red-cli-type','');await flush();assert.deepEqual((await w.lab.bind('red',{})).harness,H.builtin('red'),'revert to harness value');});

test('role busy (run, source binding or record) locks CLI controls and ignores changes',async()=>{const w=await live(NEW_CAP);w.change('blue-cli-type','codex');await settle(w,'blue');const n=w.events.length;
  w.lab.busy('blue',true);for(const id of ['blue-harness','blue-harness-consent','blue-cli-type','blue-cli-model','blue-cli-effort'])assert.equal(w.get(id).disabled,true,id);assert.match(w.get('blue-cli-note').textContent,/잠겼습니다/);
  w.change('blue-cli-effort','low');w.change('blue-cli-type','claude');await flush();assert.equal(w.events.length,n);assert.deepEqual((await w.lab.bind('blue',{})).harness.adapter,{type:'codex',model:'gpt-6.1-sol',effort:'medium'});
  assert.equal(w.get('blue-cli-type').value,'codex');assert.equal(w.get('blue-cli-effort').value,'medium','display restored');
  w.lab.busy('blue',false);assert.equal(w.get('blue-cli-effort').disabled,false);w.change('blue-cli-effort','low');await flush();assert.equal(w.events.length,n+1);
  const red=fs.readFileSync(path.join(dist,'document-red.js'),'utf8'),blue=fs.readFileSync(path.join(dist,'document-blue.js'),'utf8');
  assert.ok(red.includes("FalsifyLab.busy('red',busy||pending.size>0)"),'RED locks during record');assert.ok(blue.includes("FalsifyLab.busy('blue',busy||saving)"),'BLUE locks during record');
  assert.ok(/GUARDED=\['red-harness','red-cli-type','red-cli-model','red-cli-effort'\]/.test(red),'RED unrecorded-edit guard covers CLI controls');});

test('custom stdio harness uses its own executor; selection never overrides it',async()=>{
  const base=H.builtin('red'),custom={...base,id:'my-code',name:'내 코드',adapter:{type:'stdio',executable:'C:/py.exe',args:['h.py']}};
  const db={schema:'falsify.experiment-ledger.v1',harnesses:[{config:custom,hash:await H.hash(custom)}],runs:[],reviews:[]};
  const w=await live(NEW_CAP,[['falsify.experiment-ledger.v1',JSON.stringify(db)]]);
  w.change('red-cli-type','claude');await flush();assert.deepEqual((await w.lab.bind('red',{})).harness.adapter,{type:'claude',model:'claude-opus-5-5',effort:'medium'});
  w.change('red-harness',db.harnesses[0].hash);await flush();
  assert.deepEqual((await w.lab.bind('red',{})).harness,custom,'stdio config untouched');assert.equal(w.get('red-cli-type').disabled,true);assert.match(w.get('red-cli-note').textContent,/자체 실행기/);assert.equal(w.lab.external('red'),true);});

test('wrapper runs only on companions explicitly supporting it; registration stays possible',async()=>{
  const custom={...H.builtin('red'),id:'wrapper-gate',adapter:{type:'wrapper',target:{type:'stdio',executable:'C:/py.exe',args:[]},input:{mode:'invocation'},output:{source:'stdout',format:'json'}}};
  const hash=await H.hash(custom),db={schema:'falsify.experiment-ledger.v1',harnesses:[{config:custom,hash}],runs:[],reviews:[]};
  for(const supported of [false,true]){const w=await live({...NEW_CAP,harnessWrapper:supported},[['falsify.experiment-ledger.v1',JSON.stringify(db)]]);w.change('red-harness',hash);await w.lab.bind('red',{});w.get('red-harness-consent').checked=true;assert.equal(w.lab.allowed('red'),supported);assert.equal(w.get('red-cli-type').disabled,true);assert.ok(!w.get('red-harness-detail').textContent.includes('undefined'));}
});

test('recording a selection registers a new version without editing old ones and survives reload',async()=>{const w=await live(NEW_CAP);
  w.change('blue-cli-type','claude');await settle(w,'blue');w.change('blue-cli-effort','low');await settle(w,'blue');
  const text='Only an association was observed.',sourceHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const doc={revision:'r1',sourceHash,fileHash:'f'.repeat(64),name:'a.txt',format:'TXT',segments:[{id:'s0',label:'p1',text}]};
  const request=await w.lab.bind('blue',{schema:'falsify.document-blue.v1',revision:'r1',sourceHash,requestId:'r1:x',maxCalls:8,segments:doc.segments});
  const id=await w.lab.record('blue',doc,request,{schema:'falsify.document-blue.v1',revision:'r1',sourceHash,status:'abstain',findings:[]},'manual-unverified');
  const saved=JSON.parse(w.store.get('falsify.experiment-ledger.v1'));const run=saved.runs.find(r=>r.id===id);
  assert.deepEqual(run.harness.adapter,{type:'claude',model:'claude-opus-5-5',effort:'low'});assert.ok(saved.harnesses.some(h=>h.hash===run.harnessHash));
  for(const role of ['red','blue']){const b=H.builtin(role),hash=await H.hash(b);assert.deepEqual(saved.harnesses.find(h=>h.hash===hash).config,b,'built-in version unchanged');}
  assert.equal(saved.harnesses.length,3,'two built-ins plus one derived version');
  const reloaded=await live(null,[['falsify.experiment-ledger.v1',JSON.stringify(saved)]]);assert.equal(reloaded.get('ledger-status').textContent,'','reload validates without recovery');
  const forged={...request,harness:{...request.harness,instructions:'unregistered'}};await assert.rejects(w.lab.record('blue',doc,forged,{schema:'falsify.document-blue.v1',revision:'r1',sourceHash,status:'refusal',findings:[]},'manual-unverified'),/등록되지 않은/);});
test('library cleanup preserves immutable history, keeps chosen roles across reload, and restores',async()=>{
  const old=H.builtin('blue'),latest={...old,id:'blue-new',version:'0.3.5',name:'최신 BLUE'},hash=await H.hash(latest),oldHash=await H.hash(old);
  const w=await live(null);w.get('harness-editor').value=JSON.stringify(latest);w.get('harness-register').dispatchEvent(new Event('click'));await flush();
  const source='synthetic paper',sourceHash=await require('node:crypto').webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(source)).then(x=>Buffer.from(x).toString('hex'));
  const doc={revision:'history',fileHash:'a'.repeat(64),sourceHash,segments:[{id:'s0',label:'p.1',text:source}]},request=await w.lab.bind('blue',{maxCalls:8});
  await w.lab.record('blue',doc,request,{schema:'falsify.document-blue.v1',revision:'history',sourceHash,status:'refusal',findings:[]},'manual-unverified');
  const before=await w.lab.cloudSnapshot();w.change('blue-harness',hash);w.get('harness-tidy').dispatchEvent(new Event('click'));
  assert.equal(w.get('harness-library').children.length,2);assert.equal(w.get('blue-harness').children.length,1);assert.equal(w.get('blue-harness').value,hash);
  assert.deepEqual(await w.lab.cloudSnapshot(),before,'cleanup never rewrites runs or harness history');
  const reloaded=await live(null,[...w.store]);assert.equal(reloaded.get('blue-harness').value,hash);assert.equal(reloaded.get('harness-library').children.length,2);assert.equal(JSON.stringify((await reloaded.lab.cloudSnapshot()).runs),JSON.stringify(before.runs));
  reloaded.lab.busy('red',true);reloaded.get('harness-restore').dispatchEvent(new Event('click'));assert.equal(reloaded.get('harness-library').children.length,2);reloaded.lab.busy('red',false);
  reloaded.get('harness-restore').dispatchEvent(new Event('click'));assert.equal(reloaded.get('harness-library').children.length,3);assert.ok(reloaded.get('blue-harness').children.some(c=>c.value===oldHash));
  const lastRed=reloaded.get('harness-library').children.find(c=>c.children[0].textContent.includes('RED'));lastRed.children.at(-1).children.at(-1).dispatchEvent(new Event('click'));assert.match(reloaded.get('harness-status').textContent,/하나씩/);
});
(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  if(DELAY&&!settleWaits){console.error('FAIL delayed crypto never outlasted flush(); delay proof missing');process.exitCode=1;}
  console.log(JSON.stringify({passed,total:tests.length,...(DELAY?{delayTicks:DELAY,settleWaits}:{})}));if(passed!==tests.length||process.exitCode)process.exit(1);})();

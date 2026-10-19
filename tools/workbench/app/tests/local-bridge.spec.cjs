'use strict';
// Node-only regression for the hosted→local broker bridge. Mocked fetch; no network, browser, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const L=require('../dist/local-bridge.js'),dist=path.resolve(__dirname,'../dist');
const TOKEN='Abc_def-ghi_JKL-mno_pqr-stu_VWX-yz0123456789';
const CAP={red:true,blue:true,pdf:true,officeLayoutVerifiedExport:false,model:'gpt-6.1-sol',isolation:'x'};
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const reply=(data,status=200,extra={})=>({ok:status>=200&&status<300,status,redirected:false,type:'cors',json:async()=>data,...extra});
function harness(hostname='shinick-han.github.io',port='',queue=[]){
  const calls=[],states=[];
  const fetch=(url,init={})=>{calls.push({url,init});const next=queue.shift();if(!next)return Promise.reject(new TypeError('no mock'));return typeof next==='function'?next(url,init):Promise.resolve(next);};
  const bridge=L.create({fetch,location:{hostname,port,origin:'https://'+hostname},emit:s=>states.push(s)});
  return {bridge,calls,states,queue};
}
const hosted=()=>harness();
const leaks=(h,token=TOKEN)=>JSON.stringify(h.states).includes(token)||JSON.stringify(h.bridge.state()).includes(token);
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('hosted page never bootstraps /api/session or any fetch on load',async()=>{const h=hosted();await h.bridge.ready;assert.equal(h.calls.length,0);assert.equal(h.bridge.state().status,'manual');assert.equal(h.bridge.session(),null);assert.equal(h.bridge.capabilities(),null);});
test('local companion origin bootstraps same-origin session as before',async()=>{const h=harness('127.0.0.1','7816',[reply({token:TOKEN}),reply(CAP)]);await h.bridge.ready;
  assert.deepEqual(h.calls.map(c=>c.url),['/api/session','/api/capabilities']);assert.equal(h.bridge.state().status,'local');assert.equal(h.calls[1].init.headers.Authorization,'Bearer '+TOKEN);assert.equal(h.calls[1].init.headers.Origin,undefined);assert.ok(h.bridge.session());assert.equal(leaks(h),false);
  assert.equal((await h.bridge.pair(TOKEN,'7816')).ok,false);assert.equal(h.bridge.disconnect().ok,false);});
test('local static preview without broker degrades honestly',async()=>{const h=harness('127.0.0.1','8000',[reply({error:'x'},404)]);await h.bridge.ready;assert.equal(h.bridge.state().status,'local-unavailable');assert.equal(h.bridge.session(),null);});
test('authenticated connect verifies capabilities with safe fetch options',async()=>{const h=hosted();h.queue.push(reply(CAP));const r=await h.bridge.pair('  '+TOKEN+'\n','7816');assert.equal(r.ok,true);
  const c=h.calls[0];assert.equal(c.url,'http://127.0.0.1:7816/api/capabilities');assert.equal(c.init.method,'GET');assert.equal(c.init.credentials,'omit');assert.equal(c.init.redirect,'error');assert.equal(c.init.mode,'cors');assert.equal(c.init.targetAddressSpace,'loopback');assert.equal(c.init.cache,'no-store');
  assert.deepEqual(Object.keys(c.init.headers),['Authorization']);assert.equal(c.init.headers.Authorization,'Bearer '+TOKEN);
  const s=h.bridge.state();assert.equal(s.status,'paired');assert.equal(s.connected,true);assert.equal(s.cap.red,true);assert.equal(leaks(h),false);assert.ok(Object.isFrozen(h.bridge.capabilities()));});
test('wrapper capability requires an explicit authenticated boolean',async()=>{for(const [value,expected] of [[undefined,false],['true',false],[true,true]]){const h=hosted();h.queue.push(reply({...CAP,harnessWrapper:value}));await h.bridge.pair(TOKEN,'7816');assert.equal(h.bridge.capabilities().harnessWrapper,expected);}});

test('POST requests keep JSON body, bearer token and no manual Origin/cookies',async()=>{const h=hosted();h.queue.push(reply(CAP),reply({id:'r1',state:'running'},202));await h.bridge.pair(TOKEN,'7816');const out=await h.bridge.session().request('/api/red/jobs',{requestId:'r1'});assert.equal(out.id,'r1');
  const c=h.calls[1];assert.equal(c.url,'http://127.0.0.1:7816/api/red/jobs');assert.equal(c.init.method,'POST');assert.equal(c.init.body,'{"requestId":"r1"}');assert.deepEqual(Object.keys(c.init.headers).sort(),['Authorization','Content-Type']);assert.equal(c.init.credentials,'omit');assert.equal(c.init.redirect,'error');});
test('empty and malformed tokens never touch the network',async()=>{for(const t of ['','   ',null,undefined,'short','has space inside token value','tok\nen'+'x'.repeat(20),'<script>alert(1)</script>xxxxxxxx','x'.repeat(513),{toString:()=>TOKEN}]){const h=hosted();const r=await h.bridge.pair(t,'7816');assert.equal(r.ok,false,String(t));assert.equal(h.calls.length,0);assert.equal(h.bridge.state().status,'manual');}});
test('port input is strict and cannot change host or scheme',async()=>{
  for(const bad of ['7816/evil','127.0.0.1:7816','http://evil.example','evil.example','80','1023','65536','99999','07816','7816.0','1e4','0x1E90','-7816','+7816','７８１６','7816#','7816?x','@evil.example','7816 7817']){assert.equal(L.parsePort(bad),null,bad);const h=hosted();const r=await h.bridge.pair(TOKEN,bad);assert.equal(r.ok,false,bad);assert.equal(h.calls.length,0,bad);}
  assert.equal(L.parsePort(''),7816);assert.equal(L.parsePort(' 7817 '),7817);assert.equal(L.parsePort('1024'),1024);assert.equal(L.parsePort('65535'),65535);
  const h=hosted();h.queue.push(reply(CAP));assert.equal((await h.bridge.pair(TOKEN,'7817')).ok,true);assert.equal(h.calls[0].url,'http://127.0.0.1:7817/api/capabilities');assert.equal(h.bridge.state().command,'python app/local/server.py --web-origin https://shinick-han.github.io --port 7817');
  assert.equal(L.command(7816),'python app/local/server.py --web-origin https://shinick-han.github.io');});
test('only allowlisted broker routes; no absolute or traversal paths',async()=>{const h=hosted();h.queue.push(reply(CAP));await h.bridge.pair(TOKEN,'7816');const s=h.bridge.session();
  for(const p of ['/api/session','http://evil.example/api/capabilities','//evil.example/api/capabilities','/api/red/jobs/../session','/api/red/jobs/..','/api/red/jobs/a/b','/api/shell','api/capabilities','/api/capabilities?x=1','/api/red/jobs/a#b'])await assert.rejects(s.request(p),/허용되지 않은/,p);
  assert.equal(h.calls.length,1);});
test('failed capabilities never enable the connection or keep the token',async()=>{
  for(const [name,mock,pattern] of [['403',reply({error:'unauthorized'},403),/403/],['401',reply({},401),/401/],['500',reply({error:'boom'},500),/boom/],['network/CORS/permission',()=>Promise.reject(new TypeError('Failed to fetch')),/로컬 네트워크 권한/],['bad shape',reply({red:'yes'}),/capabilities/],['array',reply([]),/capabilities/],['non-json',reply(null,200,{json:async()=>{throw new SyntaxError('x');}}),/JSON/],['redirect',reply(CAP,200,{redirected:true}),/리디렉션/]]){
    const h=hosted();h.queue.push(mock);const r=await h.bridge.pair(TOKEN,'7816');assert.equal(r.ok,false,name);assert.match(r.error,pattern,name);const s=h.bridge.state();assert.equal(s.status,'manual',name);assert.equal(s.connected,false);assert.equal(h.bridge.session(),null);assert.equal(h.bridge.capabilities(),null);assert.equal(leaks(h),false,name);}});
test('disconnect clears link; stale handles cannot reuse the token; reconnect works',async()=>{const h=hosted();h.queue.push(reply(CAP));await h.bridge.pair(TOKEN,'7816');const old=h.bridge.session();
  assert.equal(h.bridge.disconnect().ok,true);assert.equal(h.bridge.session(),null);assert.equal(h.bridge.capabilities(),null);await assert.rejects(old.request('/api/capabilities'),/먼저 연결/);assert.equal(h.calls.length,1);
  const other='Zyx_wvu-tsr_QPO-nml_kji-hgf_EDC-ba9876543210';h.queue.push(reply({...CAP,pdf:false}));assert.equal((await h.bridge.pair(other,'7817')).ok,true);assert.equal(h.calls[1].url,'http://127.0.0.1:7817/api/capabilities');assert.equal(h.calls[1].init.headers.Authorization,'Bearer '+other);assert.equal(h.bridge.capabilities().pdf,false);
  await assert.rejects(old.request('/api/capabilities'));assert.equal(h.calls.length,2);});
test('connection is frozen while RED or BLUE (including export) is busy',async()=>{const h=hosted();h.queue.push(reply(CAP));await h.bridge.pair(TOKEN,'7816');
  for(const role of ['red','blue']){h.bridge.busy(role,true);assert.equal(h.bridge.state().frozen,true);assert.equal(h.bridge.disconnect().ok,false);assert.equal((await h.bridge.pair(TOKEN,'7817')).ok,false);assert.equal(h.bridge.setPort('7817'),null);assert.equal(h.bridge.state().status,'paired');assert.equal(h.bridge.state().port,7816);assert.ok(h.bridge.session());h.bridge.busy(role,false);}
  assert.equal(h.calls.length,1);h.bridge.busy('harness',true);assert.equal(h.bridge.state().frozen,false);assert.equal(h.bridge.disconnect().ok,true);});
test('in-flight request (e.g. stale job cancel) freezes the endpoint until it settles',async()=>{const h=hosted();h.queue.push(reply(CAP));await h.bridge.pair(TOKEN,'7816');const d=deferred();h.queue.push(()=>d.promise);
  const pending=h.bridge.session().request('/api/red/jobs/r1/cancel',{});assert.equal(h.bridge.state().frozen,true);assert.equal(h.bridge.disconnect().ok,false);d.resolve(reply({status:'cancel_requested'}));await pending;assert.equal(h.bridge.state().frozen,false);assert.equal(h.bridge.disconnect().ok,true);});
test('stale connect result is discarded after disconnect',async()=>{const h=hosted();const d=deferred();h.queue.push(()=>d.promise);const attempt=h.bridge.pair(TOKEN,'7816');assert.equal(h.bridge.state().status,'connecting');assert.equal(h.bridge.disconnect().ok,true);d.resolve(reply(CAP));const r=await attempt;assert.equal(r.ok,false);assert.equal(h.bridge.state().status,'manual');assert.equal(h.bridge.session(),null);});
test('newer connect wins over an older pending one',async()=>{const h=hosted();const d=deferred();h.queue.push(()=>d.promise,reply({...CAP,pdf:false}));const first=h.bridge.pair(TOKEN,'7816');const second=await h.bridge.pair(TOKEN,'7817');assert.equal(second.ok,true);d.resolve(reply(CAP));assert.equal((await first).ok,false);assert.equal(h.bridge.state().port,7817);assert.equal(h.bridge.capabilities().pdf,false);});

// Minimal DOM double for the panel: token field clearing and port→command preview.
function fakeDom(){const listeners={},els={};const el=id=>els[id]||(els[id]={id,value:'',hidden:false,disabled:false,textContent:'',dataset:{},href:'',_l:{},addEventListener(t,f){this._l[t]=f;},click(){return this._l.click?.();},classList:{toggle(){}}});
  for(const id of ['local-bridge','bridge-status','bridge-pair','bridge-port','bridge-token','bridge-connect','bridge-disconnect','bridge-command','bridge-feedback'])el(id);els['bridge-port'].value='7816';
  return {els,getElementById:id=>els[id]||null,querySelectorAll:()=>[],addEventListener(t,f){listeners[t]=f;},fire(t,detail){listeners[t]?.({detail});}};}
test('panel clears the password field after success and failure; command follows port',async()=>{const dom=fakeDom();const h=hosted();L.mount(h.bridge,dom);const {els}=dom;
  assert.equal(els['bridge-command'].textContent,'python app/local/server.py --web-origin https://shinick-han.github.io');els['bridge-port'].value='7817';els['bridge-port']._l.input();assert.match(els['bridge-command'].textContent,/--port 7817$/);
  els['bridge-token'].value='bad token';await els['bridge-connect'].click();assert.equal(els['bridge-token'].value,'');assert.equal(h.calls.length,0);
  h.queue.push(reply(CAP));els['bridge-token'].value=TOKEN;await els['bridge-connect'].click();assert.equal(els['bridge-token'].value,'');assert.equal(h.bridge.state().status,'paired');dom.fire('falsify:local-bridge',h.bridge.state());
  assert.equal(els['bridge-token'].disabled,true);assert.equal(els['bridge-port'].disabled,true);assert.equal(els['bridge-disconnect'].hidden,false);assert.match(els['bridge-status'].textContent,/127\.0\.0\.1:7817/);
  for(const e of Object.values(els))for(const v of [e.value,e.textContent,e.href])assert.ok(!String(v).includes(TOKEN),e.id);
  h.bridge.busy('blue',true);dom.fire('falsify:local-bridge',h.bridge.state());assert.equal(els['bridge-disconnect'].disabled,true);assert.match(els['bridge-status'].textContent,/잠김/);h.bridge.busy('blue',false);
  await els['bridge-disconnect'].click();dom.fire('falsify:local-bridge',h.bridge.state());assert.equal(h.bridge.state().status,'manual');assert.equal(els['bridge-token'].disabled,false);});

// Static wiring checks for the owned page and role modules.
const read=f=>fs.readFileSync(path.join(dist,f),'utf8');
test('bridge source has no persistence, URL or logging channel for the token',()=>{const src=read('local-bridge.js');for(const bad of ['localStorage','sessionStorage','indexedDB','document.cookie','location.hash','history.','console.','postMessage','searchParams'])assert.ok(!src.includes(bad),bad);});
test('page CSP permits loopback plus the one configured shared API; assets are relative; bridge loads before roles',()=>{const html=read('index.html');const csp=html.match(/Content-Security-Policy" content="([^"]+)"/)[1];const api=read('cloud-config.js').match(/apiBase:\s*'([^']*)'/)[1];assert.deepEqual(csp.match(/connect-src ([^;]+)/)[1].trim().split(/\s+/),["'self'",'http://127.0.0.1:*',...(api?[new URL(api).origin]:[])]);assert.ok(!/connect-src[^;]*(?:https?:\*|\*\.|localhost|0\.0\.0\.0|\bhttps:(?!\/))/.test(csp));
  const scripts=[...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map(m=>m[1]);assert.ok(scripts.every(s=>!/^(?:\/|https?:)/.test(s)),scripts.join());const order=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]);assert.ok(order.indexOf('local-bridge.js')>=0&&order.indexOf('local-bridge.js')<order.indexOf('document-red.js')&&order.indexOf('local-bridge.js')<order.indexOf('document-blue.js'));
  assert.match(html,/id="bridge-token" type="password"/);assert.equal((html.match(/type="password"/g)||[]).length,1);assert.ok(!/<input[^>]+(?:api[-_ ]?key|apikey)/i.test(html));assert.ok(!/비공개 웹/.test(html));
  assert.ok(html.includes('https://github.com/Shinick-Han/falsify-workbench/archive/refs/heads/main.zip'));assert.ok(!/<a[^>]+main\.zip[^>]+download/.test(html));assert.ok(html.includes('https://github.com/Shinick-Han/falsify-workbench/blob/main/docs/local-companion.md'));assert.ok(html.includes('id="bridge-launcher"'));});
test('launcher command runs the root start-companion.ps1 and follows the strict port',()=>{const root=path.resolve(__dirname,'../..'),ps1=path.join(root,'start-companion.ps1');assert.ok(fs.existsSync(ps1));assert.match(fs.readFileSync(ps1,'utf8'),/\[int\]\$Port = 7816,/);
  const argv=c=>c.split(' ');for(const [port,tail] of [[7816,[]],[7817,['-Port','7817']],[8000,['-Port','8000']]]){const a=argv(L.launcher(port));assert.deepEqual(a.slice(0,5),['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File']);assert.equal(a[5],'./start-companion.ps1');assert.equal(path.resolve(root,a[5]),ps1);assert.deepEqual(a.slice(6),tail);}});
test('RED/BLUE route every broker call through the bridge and bind jobs to one link',()=>{for(const f of ['document-red.js','document-blue.js']){const src=read(f);assert.ok(!/\bfetch\(/.test(src),f);assert.ok(!src.includes('/api/session'),f);assert.ok(!/\btoken\b/.test(src),f);assert.ok(src.includes("B.busy('"+(f.includes('red')?'red':'blue')+"',busy)"),f);assert.match(src,/jobLink=l;/);assert.match(src,/const old=job,l=jobLink;job=null;jobLink=null;if\(old&&l\)void l\.request\(/);}});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name);console.error(e);process.exitCode=1;}}
  console.log(JSON.stringify({passed,failed:tests.length-passed,skipped:0}));if(passed!==tests.length)process.exit(1);})();

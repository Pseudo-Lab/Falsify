const assert=require('node:assert/strict'),H=require('../dist/harness-core.js');let passed=0;const checks=[];
function check(name,fn){fn();checks.push(name);passed++;}
// Building and previewing must never reach the network or a process: any attempt fails the whole spec.
globalThis.fetch=()=>{throw Error('network attempted');};require('node:child_process').spawn=()=>{throw Error('process attempted');};
const W=require('../dist/harness-wrapper.js');
const code=(fn,c)=>assert.throws(fn,e=>e.code===c,c);
const stdio={type:'stdio',executable:'C:/Tools/python.exe',args:['C:/Tools/legacy.py','--json']},out={source:'stdout',format:'json'};
const wrap=(d={})=>({type:'wrapper',target:stdio,input:{mode:'invocation'},output:out,...d});
const base={...H.builtin('red'),id:'legacy-red',name:'레거시 RED'};
// Non-Workbench legacy output: different names, nesting and an array that must become candidates with exact quotes preserved.
const legacy={result:{state:'ok',items:[{old:'Study does not show benefit.',new:'Study does show benefit.',why:'Reversal.',quote:'Only an association was observed.'}]}};
const redMap={status:{$from:'/state'},candidates:{$each:'/items',template:{before:{$from:'/old'},after:{$from:'/new'},rationale:{$from:'/why'},evidence:[{quote:{$from:'/quote'}}]}}};
const fields={role:'red',id:'legacy-red',name:'레거시 RED',version:'1',maxCalls:'4',instructions:'Follow the contract.',targetType:'stdio',executable:'C:/Tools/python.exe',args:'["C:/Tools/legacy.py","{input}"]',url:'',
  inputMode:'files',template:'',source:'stdout',format:'json',path:'/result',advanced:JSON.stringify({stageMaps:{red:redMap}}),settings:'{"programCommit":"abc123"}'};
check('valid wrapper adapters validate for every input mode and both targets',()=>{
  for(const input of [{mode:'invocation'},{mode:'prompt'},{mode:'files'},{mode:'template',template:{text:{$from:'/prompt'},n:1}}])assert.equal(H.validateWrapper(wrap({input})).input.mode,input.mode);
  assert.equal(H.validateWrapper(wrap({target:{type:'http',url:'https://example.com/run'}})).target.type,'http');
  assert.equal(H.validate({...base,adapter:wrap({output:{source:'file',format:'json-fence',path:'/result',map:redMap,stageMaps:{scan:{status:'ok'}}}})}).adapter.type,'wrapper');});
check('harness validate accepts wrapper; the four old adapters stay unchanged',()=>{for(const adapter of [{type:'codex'},{type:'claude',model:'opus',effort:'high'},stdio,{type:'http',url:'https://example.com/x'}])assert.deepEqual(H.validate({...base,adapter}).adapter,adapter);});
check('shape negatives: unknown/missing fields, nesting, bad targets',()=>{
  code(()=>H.validateWrapper({...wrap(),extra:1}),'shape');const {input,...noInput}=wrap();code(()=>H.validateWrapper(noInput),'shape');code(()=>H.validateWrapper([]),'shape');
  code(()=>H.validateWrapper(wrap({target:wrap()})),'target');code(()=>H.validateWrapper(wrap({target:{type:'codex'}})),'target');
  code(()=>H.validateWrapper(wrap({target:{...stdio,executable:'python.exe'}})),'target');code(()=>H.validateWrapper(wrap({target:{...stdio,args:'-c x'}})),'target');
  code(()=>H.validateWrapper(wrap({target:{...stdio,env:{}}})),'target');code(()=>H.validateWrapper(wrap({target:{type:'http',url:'https://k@example.com/'}})),'target');
  code(()=>H.validateWrapper(wrap({target:{type:'http',url:'http://example.com/'}})),'target');code(()=>H.validateWrapper(wrap({target:{type:'http',url:'https://example.com/',headers:{}}})),'target');
  assert.throws(()=>H.validate({...base,adapter:{...wrap(),extra:1}}));});
check('input negatives: unknown mode, template only in template mode, unknown field',()=>{
  for(const input of [{mode:'shell'},{mode:'template'},{mode:'prompt',template:{}},{mode:'invocation',extra:1},null])code(()=>H.validateWrapper(wrap({input})),'input');});
check('output negatives: source/format/file-on-http/unknown fields/output path field',()=>{
  for(const output of [{source:'stderr',format:'json'},{source:'stdout',format:'markdown'},{source:'stdout'},{source:'stdout',format:'json',file:'out.json'},{...out,outputPath:'C:/x.json'}])code(()=>H.validateWrapper(wrap({output})),'output');
  code(()=>H.validateWrapper(wrap({target:{type:'http',url:'https://example.com/'},output:{source:'file',format:'json'}})),'output');});
check('placeholders only as whole argument tokens',()=>{assert.ok(H.validateWrapper(wrap({input:{mode:'files'},target:{...stdio,args:['{input}','{prompt}','{schema}','{output}','{other}']}})));
  for(const arg of ['--in={input}','{input}.json','x{output}'])code(()=>H.validateWrapper(wrap({target:{...stdio,args:[arg]}})),'placeholder');});
check('size bound: serialized config over 32000 chars fails',()=>code(()=>H.validateWrapper(wrap({output:{...out,map:{a:'x'.repeat(32000)}}})),'size'));
check('pointer syntax: leading slash, escapes, prototype tokens',()=>{for(const path of ['result','/a~2','/a~']) code(()=>H.validateWrapper(wrap({output:{...out,path}})),'pointer');
  for(const path of ['/__proto__','/a/constructor','/prototype'])code(()=>H.validateWrapper(wrap({output:{...out,path}})),'proto');
  assert.deepEqual(H.transformWrapperOutput({'a/b':{'~':5}},{...out,path:'/a~1b/~0'}),5);});
check('directives: exact shapes only, $-keys and prototype keys rejected',()=>{
  for(const map of [{$from:'/a',x:1},{$each:'/a'},{$each:'/a',template:1,x:2},{$value:1},{a:{$from:3}},{a:{$from:'a'}}])assert.throws(()=>H.validateWrapper(wrap({output:{...out,map}})),e=>['directive','pointer'].includes(e.code));
  for(const map of [JSON.parse('{"__proto__":{"polluted":true}}'),{a:JSON.parse('{"constructor":1}')},{prototype:1}])code(()=>H.validateWrapper(wrap({output:{...out,map}})),'proto');
  code(()=>H.validateWrapper(wrap({input:{mode:'template',template:JSON.parse('{"__proto__":1}')}})),'proto');assert.equal({}.polluted,undefined);});
check('deep and huge mappings fail',()=>{let deep={$from:''};for(let i=0;i<21;i++)deep={k:deep};code(()=>H.validateWrapper(wrap({output:{...out,map:deep}})),'mapSize');
  code(()=>H.validateWrapper(wrap({output:{...out,map:Array.from({length:1001},()=>0)}})),'mapSize');
  code(()=>H.validateWrapper(wrap({output:{...out,stageMaps:{red:Array.from({length:1001},()=>0)}}})),'mapSize');});
check('stageMaps keys limited to scan / selection / red / blue',()=>{code(()=>H.validateWrapper(wrap({output:{...out,stageMaps:{final:{}}}})),'stage');code(()=>H.validateWrapper(wrap({output:{...out,stageMaps:[]}})),'stage');});
check('legacy output maps deterministically with exact quotes preserved',()=>{const o={...out,path:'/result',map:redMap},text=JSON.stringify(legacy);
  const a=H.transformWrapperOutput(text,o,'red'),b=H.transformWrapperOutput(text,o,'red');assert.deepEqual(a,b);
  assert.deepEqual(a,{status:'ok',candidates:[{before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Reversal.',evidence:[{quote:'Only an association was observed.'}]}]});});
check('literals, $from whole value, nested $each relative to element',()=>{const map={kind:'fixed',n:2,flag:false,none:null,all:{$from:''},rows:{$each:'/g',template:{name:{$from:'/n'},tags:{$each:'/t',template:{v:{$from:''}}}}}};
  assert.deepEqual(H.transformWrapperOutput({g:[{n:'a',t:[1,2]},{n:'b',t:[]}]},{...out,map}),{kind:'fixed',n:2,flag:false,none:null,all:{g:[{n:'a',t:[1,2]},{n:'b',t:[]}]},rows:[{name:'a',tags:[{v:1},{v:2}]},{name:'b',tags:[]}]});});
check('missing paths fail; nothing invented, abstain/refusal not upgraded',()=>{code(()=>H.transformWrapperOutput({result:{state:'ok'}},{...out,path:'/result',map:redMap},'red'),'missing');
  code(()=>H.transformWrapperOutput({a:[1]},{...out,path:'/a/1'}),'missing');code(()=>H.transformWrapperOutput({a:[1]},{...out,path:'/a/01'}),'missing');code(()=>H.transformWrapperOutput({a:[1]},{...out,path:'/a/-'}),'missing');
  code(()=>H.transformWrapperOutput({a:'s'},{...out,map:{x:{$from:'/a/0'}}}),'missing');code(()=>H.transformWrapperOutput({items:{}},{...out,map:{x:{$each:'/items',template:1}}}),'notArray');
  code(()=>H.transformWrapperOutput(Object.create({inherited:1}),{...out,path:'/inherited'}),'missing');
  for(const state of ['abstain','refusal'])assert.deepEqual(H.transformWrapperOutput({state,items:[]},{...out,map:redMap},'red'),{status:state,candidates:[]});});
check('stage selection: explicit stage map, fallback to map, then identity',()=>{const o={...out,map:{from:'map'},stageMaps:{scan:{from:'scan'},blue:{from:'blue'}}};
  assert.deepEqual(['scan','blue','red','selection','unknown',undefined].map(s=>H.transformWrapperOutput({},o,s).from),['scan','blue','map','map','map','map']);
  assert.deepEqual(H.transformWrapperOutput({a:1},{...out,stageMaps:{red:{b:2}}},'blue'),{a:1});
  assert.deepEqual(['summary','targets','candidates','findings','other'].map(k=>H.stageForSchema({properties:{status:{},[k]:{}}})),['scan','selection','red','blue',null]);});
check('formats: json whole value, json-fence single whole block, Markdown prose rejected',()=>{const f={...out,format:'json-fence'};
  assert.deepEqual(H.transformWrapperOutput('  {"a":1}\n',out),{a:1});assert.deepEqual(H.transformWrapperOutput('```json\n{"a":1}\n```',f),{a:1});assert.deepEqual(H.transformWrapperOutput('```\r\n[1]\r\n```\n',f),[1]);
  code(()=>H.transformWrapperOutput('Here you go: {"a":1}',out),'parse');code(()=>H.transformWrapperOutput('```json\n{"a":1}\n```',out),'parse');
  for(const t of ['Result:\n```json\n{"a":1}\n```','```json\n{"a":1}\n```\nDone.','```json\n{"a":1}\n```\n```json\n{"b":2}\n```','{"a":1}','```json {"a":1}```'])code(()=>H.transformWrapperOutput(t,f),'fence');
  code(()=>H.transformWrapperOutput('"'+'x'.repeat(150000)+'"',out),'outputSize');});
// Review W1-W8 parity: the browser helper accepts exactly what the backend (harness_wrapper.py) accepts.
check('parity W1: files mode needs stdio; {input}/{prompt}/{schema} only in files mode',()=>{
  code(()=>H.validateWrapper(wrap({target:{type:'http',url:'https://example.com/x'},input:{mode:'files'}})),'input');
  for(const input of [{mode:'invocation'},{mode:'prompt'},{mode:'template',template:{}}])for(const arg of ['{input}','{prompt}','{schema}'])code(()=>H.validateWrapper(wrap({input,target:{...stdio,args:[arg]}})),'filesOnly');
  assert.ok(H.validateWrapper(wrap({target:{...stdio,args:['{output}']}})));});
check('parity W3: size counts UTF-16 units of compact JSON',()=>{const map=Object.fromEntries(Array.from({length:900},(_,i)=>['k'+String(i).padStart(3,'0'),'x'.repeat(25)]));
  assert.ok(H.validateWrapper(wrap({output:{...out,map}})));code(()=>H.validateWrapper(wrap({output:{...out,map:{a:'\u{1F600}'.repeat(16000)}}})),'size');});
check('parity W4: $each over 1000 elements and copied nodes over 100000 fail',()=>{const each=n=>({x:Array.from({length:n},(_,i)=>i)});
  assert.equal(H.transformWrapperOutput(each(1000),{...out,map:{$each:'/x',template:1}}).length,1000);code(()=>H.transformWrapperOutput(each(1001),{...out,map:{$each:'/x',template:1}}),'resultSize');
  assert.equal(H.transformWrapperOutput(each(30000),{...out,map:Array(3).fill({$from:'/x'})}).length,3);code(()=>H.transformWrapperOutput(each(30000),{...out,map:Array(4).fill({$from:'/x'})}),'resultSize');});
check('parity W5: strict shared fence, BOM and non-JSON whitespace rejected',()=>{const f={...out,format:'json-fence'};
  for(const t of ['```json\n{"a":1}```','```json\n{"a":"```"}\n```','﻿```json\n{"a":1}\n```','```json\n﻿{"a":1}\n```',' ```json\n{"a":1}\n```'])assert.throws(()=>H.transformWrapperOutput(t,f),e=>['fence','parse'].includes(e.code),JSON.stringify(t));
  code(()=>H.transformWrapperOutput('﻿{"a":1}',out),'parse');assert.deepEqual(H.transformWrapperOutput(' \n```\r\n[1]\r\n```\n',f),[1]);});
check('parity W6: ambiguous or malformed schema has no stage',()=>{for(const s of [{properties:{summary:{},findings:{}}},{properties:{candidates:{},targets:{}}},{properties:['summary']}])assert.equal(H.stageForSchema(s),null);
  assert.deepEqual(H.transformWrapperOutput({},{...out,map:{from:'map'},stageMaps:{scan:{from:'scan'}}},H.stageForSchema({properties:{summary:{},findings:{}}})),{from:'map'});});
check('parity W7: prototype pointer tokens rejected in path and directives',()=>{for(const p of ['/constructor','/prototype','/a/__proto__']){code(()=>H.validateWrapper(wrap({output:{...out,path:p}})),'proto');code(()=>H.validateWrapper(wrap({output:{...out,map:{v:{$from:p}}}})),'proto');}});
check('parity W8: non-finite numbers rejected after parse',()=>{for(const t of ['{"a":1e400}','[-1e400]','{"a":1'+'0'.repeat(400)+'}'])code(()=>H.transformWrapperOutput(t,out),'parse');
  code(()=>H.transformWrapperOutput('```json\n{"a":1e400}\n```',{...out,format:'json-fence'}),'parse');code(()=>H.transformWrapperOutput({a:[Infinity]},out),'parse');
  assert.deepEqual(H.transformWrapperOutput('{"a":1.5e300,"c":12}',out),{a:1.5e300,c:12});});
check('preview heading is h3 (no skipped level) and styled',()=>{const fs=require('node:fs'),path=require('node:path'),read=f=>fs.readFileSync(path.join(__dirname,'../dist',f),'utf8');
  const js=read('harness-wrapper.js'),css=read('harness-wrapper.css');assert.ok(js.includes("x('h3',{id:'wrapper-preview-title'"));assert.ok(!js.includes("x('h4'"));assert.ok(css.includes('.wrapper-preview h3{'));assert.ok(!css.includes('h4'));});
check('error messages are fixed text and never echo user values',()=>{const secret='sk-SECRET-VALUE';
  for(const fn of [()=>H.transformWrapperOutput(secret,out),()=>H.transformWrapperOutput({},{...out,path:'/'+secret}),()=>H.validateWrapper(wrap({output:{...out,path:secret}}))])
    assert.throws(fn,e=>!e.message.includes(secret)&&Object.values(H.WRAPPER_ERRORS).includes(e.message));
  assert.throws(()=>W.build({...fields,args:'[1,'+secret}),e=>!e.message.includes(secret)&&W.message(e)===W.MSG.args);assert.equal(W.message(Error(secret)),W.MSG.unknown);});
check('builder produces a standard harness accepted by validate and the canonical hash',()=>{const h=W.build(fields);assert.deepEqual(H.validate(h,'red'),h);assert.equal(h.schema,'falsify.harness.v1');assert.equal(h.maxCalls,4);
  assert.deepEqual(h.adapter,{type:'wrapper',target:{type:'stdio',executable:'C:/Tools/python.exe',args:['C:/Tools/legacy.py','{input}']},input:{mode:'files'},output:{source:'stdout',format:'json',path:'/result',stageMaps:{red:redMap}}});
  assert.deepEqual(h.settings,{programCommit:'abc123'});assert.ok(H.canonical(h).includes('"stageMaps"'));});
check('builder http target, template mode, empty optional fields',()=>{const h=W.build({...fields,targetType:'http',url:'https://example.com/run',inputMode:'template',template:'{"text":{"$from":"/prompt"}}',path:'',advanced:'',settings:''});
  assert.deepEqual(h.adapter,{type:'wrapper',target:{type:'http',url:'https://example.com/run'},input:{mode:'template',template:{text:{$from:'/prompt'}}},output:{source:'stdout',format:'json'}});assert.deepEqual(h.settings,{});});
check('builder negatives use fixed recovery messages',()=>{for(const [d,m] of [[{args:'"--x"'},'args'],[{args:'{'},'args'],[{settings:'[]'},'settings'],[{inputMode:'template',template:''},'template'],[{advanced:'{"other":1}'},'advanced'],[{advanced:'[]'},'advanced']])assert.throws(()=>W.build({...fields,...d}),e=>e.message===W.MSG[m],m);
  assert.throws(()=>W.build({...fields,maxCalls:'0'}),e=>e.fixed&&e.message==='호출 한도는 1–32회입니다.');assert.throws(()=>W.build({...fields,executable:'python'}),e=>e.code==='target');
  assert.throws(()=>W.build({...fields,inputMode:'invocation',source:'file',targetType:'http',url:'https://example.com/'}),e=>e.code==='output');
  assert.throws(()=>W.build({...fields,targetType:'http',url:'https://example.com/'}),e=>e.code==='input');});
check('preview: explicit stage, missing/extra top-level keys reported, not certification',()=>{const p=W.preview(fields,JSON.stringify(legacy),'red');assert.deepEqual(p.missing,[]);assert.deepEqual(p.extra,[]);assert.equal(p.value.candidates[0].evidence[0].quote,'Only an association was observed.');
  const s=W.preview({...fields,advanced:JSON.stringify({stageMaps:{scan:{status:{$from:'/state'},note:'x'}}})},JSON.stringify(legacy),'scan');assert.deepEqual(s.missing,['summary','evidence']);assert.deepEqual(s.extra,['note']);
  assert.throws(()=>W.preview(fields,'  ','red'),e=>e.message===W.MSG.sample);assert.throws(()=>W.preview(fields,'{"result":{}}','red'),e=>e.code==='missing');});
check('editor round trip restores wrapper fields; base-only for other adapters',()=>{const h=W.build(fields),f=W.fieldsFrom(h);assert.deepEqual(W.build(f),h);
  const plainFields=W.fieldsFrom(H.builtin('blue'));assert.equal(plainFields.role,'blue');assert.equal(plainFields.targetType,undefined);});
check('module has no DOM side effects in Node and mount refuses without the manager',()=>{assert.equal(W.mount({getElementById:()=>null}),false);W.watch(undefined);});
console.log(JSON.stringify({passed,checks},null,2));

'use strict';
// Synthetic DOM for the external import panel. No browser, network, model, or private paper.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Red=require('../dist/external-red.js');
const HASH='abc123';
const ALPHA='Alpha unique sentence.';
const SEGMENTS=[
  {id:'s0',label:'PDF p. 1',text:ALPHA},
  {id:'s1',label:'PDF p. 2',text:'Beta appears. Beta appears.'}
];
let checks=0;
const tests=[];
function test(name,fn){tests.push([name,fn]);}
function textOf(node){
  let out=node.textContent||'';
  for(const child of node.children||[])out+=textOf(child);
  return out;
}
function matches(node,selector){
  if(selector.startsWith('#'))return node.id===selector.slice(1);
  if(selector.startsWith('.'))return String(node.className||'').split(/\s+/).includes(selector.slice(1));
  return String(node.tagName||'').toLowerCase()===selector.toLowerCase();
}
function query(node,selector){
  if(matches(node,selector))return node;
  for(const child of node.children||[]){const found=query(child,selector);if(found)return found;}
  return null;
}
function queryAll(node,selector,out=[]){
  for(const child of node.children||[]){if(matches(child,selector))out.push(child);queryAll(child,selector,out);}
  return out;
}
function element(tag){
  const node=new EventTarget();
  const children=[];
  Object.assign(node,{
    tagName:String(tag||'div').toUpperCase(),id:'',className:'',textContent:'',value:'',checked:false,disabled:false,hidden:false,type:'',name:'',href:'',download:'',rel:'',rows:0,maxLength:0,children,
    append(...items){children.push(...items);},
    replaceChildren(...items){children.splice(0,children.length,...items);},
    setAttribute(name,value){node[name]=String(value);},
    remove(){},
    click(){if(!this.disabled)this.dispatchEvent(new Event('click'));},
    querySelector(selector){return query(node,selector);},
    querySelectorAll(selector){return queryAll(node,selector);}
  });
  Object.defineProperty(node,'innerHTML',{configurable:true,get(){throw new Error('innerHTML');},set(){throw new Error('innerHTML');}});
  return node;
}
function world({host=true,clipboard}={}){
  const body=element('body');
  const document=new EventTarget();
  const created=[];
  Object.assign(document,{
    body,
    createElement(tag){const node=element(tag);created.push(node);return node;},
    getElementById(id){return query(body,'#'+id);}
  });
  const downloads=[];
  const calls=[];
  let source={file:null,fileHash:HASH,segments:SEGMENTS.map(segment=>({...segment}))};
  const workspace={getSource(){return source;},acceptProposals(proposals,options){calls.push(JSON.parse(JSON.stringify({proposals,options})));}};
  const copied=[];
  let write=clipboard;
  if(!write)write=async value=>{copied.push(value);};
  const context={
    document,FalsifyExternalRed:Red,FalsifyPaperWorkspace:workspace,
    navigator:{clipboard:{writeText:value=>Promise.resolve().then(()=>write(value))}},
    Blob,URL:{createObjectURL(blob){downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}},
    Event,CustomEvent,EventTarget,TextEncoder,TextDecoder,setTimeout,clearTimeout,JSON,Object,Array,String,Number,Promise,Error,Math
  };
  if(host){const panel=document.createElement('div');panel.id='paper-workspace';body.append(panel);}
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../dist/external-red-ui.js'),'utf8'),vm.createContext(context),{filename:'external-red-ui.js'});
  const panel=()=>document.getElementById('paper-workspace');
  return {document,created,downloads,calls,copied,workspace,get source(){return source;},set source(value){source=value;},
    host:()=>panel(),section:()=>panel()&&panel().querySelector('#external-red'),input:id=>document.getElementById(id)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('panel mounts inside the workspace host or on the ready event',()=>{
  const ready=world();
  const section=ready.section();
  assert.ok(section);
  assert.equal(section.parentNode?ready.host().children.includes(section):ready.host().children.includes(section),true);
  assert.match(textOf(section),/검증된 RED 실행이 아닙니다/);
  assert.match(textOf(section),/모델을 호출하지 않으며/);
  const late=world({host:false});
  assert.equal(late.document.getElementById('external-red'),null);
  const host=late.document.createElement('div');
  host.id='paper-workspace';
  late.document.body.append(host);
  late.document.dispatchEvent(new Event('falsify:paper-workspace-ready'));
  assert.ok(host.querySelector('#external-red'));
  late.document.dispatchEvent(new Event('falsify:paper-workspace-ready'));
  assert.equal(queryAll(host,'#external-red').length,1);
});

test('copy uses the clipboard and falls back to a TXT download',async()=>{
  const ok=world();
  ok.input('external-red-copy').click();
  await flush();
  assert.equal(ok.copied.length,1);
  assert.match(ok.copied[0],new RegExp(ALPHA));
  assert.match(ok.copied[0],/pageIndex=0 pageLabel=PDF p\. 1/);
  assert.match(ok.input('external-red-copy-status').textContent,/클립보드에 복사했습니다/);
  assert.equal(ok.downloads.length,0);
  const denied=world({clipboard:async()=>{throw new Error('NotAllowedError');}});
  denied.input('external-red-copy').click();
  await flush();
  assert.equal(denied.downloads.length,1);
  assert.match(await denied.downloads[0].text(),new RegExp(ALPHA));
  assert.equal(denied.created.filter(node=>node.download==='falsify-external-red-prompt.txt').length,1);
  assert.match(denied.input('external-red-copy-status').textContent,/클립보드 권한이 없어/);
  const direct=world();
  direct.input('external-red-download').click();
  assert.equal(direct.downloads.length,1);
  assert.match(direct.input('external-red-copy-status').textContent,/TXT로 내려받았습니다/);
});

test('review shows text, accept sends only a checked unique match, and ambiguous targets wait',async()=>{
  const ui=world();
  const paste=ui.input('external-red-paste');
  paste.value=JSON.stringify({model:'<script>',changes:[
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'<img src=x onerror=alert(1)>'},
    {segmentId:'s1',pageIndex:1,before:'Beta appears.',after:'Everywhere.'},
    {segmentId:'missing',before:ALPHA,after:'Nope.'}
  ]});
  ui.input('external-red-review').click();
  assert.equal(ui.calls.length,0);
  const cards=queryAll(ui.section(),'article');
  assert.equal(cards.length,3);
  assert.deepEqual(cards.map(card=>card['data-status']),['matched','ambiguous','missing']);
  assert.match(textOf(cards[0]),/<img src=x onerror=alert\(1\)>/);
  assert.match(textOf(ui.section()),/원문에 없음/);
  assert.equal(ui.input('external-red-accept').disabled,true);
  ui.input('external-red-accept').click();
  assert.equal(ui.calls.length,0);
  assert.equal(ui.input('external-red-review').textContent,'변경 찾기');
  assert.equal(ui.input('external-red-accept').textContent,'선택한 변경 가져오기');
  assert.match(textOf(ui.section()),/PDF p\.1/);
  assert.match(textOf(ui.section()),/PDF p\.2/);
  assert.doesNotMatch(textOf(ui.section()),/pageIndex/);
  assert.doesNotMatch(textOf(ui.section()),/워크스페이스/);
  assert.doesNotMatch(textOf(ui.section()),/대응/);
  const radios=queryAll(cards[1],'input').filter(node=>node.type==='radio');
  assert.equal(radios.length,2);
  assert.ok(radios.every(radio=>radio.checked===false));
  assert.match(textOf(cards[1]),/\[Beta appears\.\]/);
  radios[1].checked=true;
  radios[1].dispatchEvent(new Event('change'));
  queryAll(cards[1],'button')[0].click();
  const again=queryAll(ui.section(),'article');
  assert.equal(again[1]['data-status'],'matched');
  const boxes=queryAll(ui.section(),'input').filter(node=>node.type==='checkbox');
  assert.equal(boxes.length,2);
  boxes[1].checked=true;
  boxes[1].dispatchEvent(new Event('change'));
  assert.equal(ui.input('external-red-accept').disabled,false);
  ui.input('external-red-model').value='lab-model';
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,1);
  assert.equal(ui.calls[0].options.origin,'external-ai-import');
  assert.equal(ui.calls[0].options.model,'lab-model');
  assert.equal(ui.calls[0].proposals.length,1);
  assert.equal(ui.calls[0].proposals[0].status,'matched');
  assert.equal(ui.calls[0].proposals[0].segmentId,'s1');
  assert.equal(ui.calls[0].proposals[0].pageIndex,1);
  assert.equal(ui.calls[0].proposals[0].matches.length,1);
  assert.equal(ui.calls[0].proposals[0].matches[0].start,'Beta appears. Beta appears.'.indexOf('Beta appears.','Beta appears.'.length));
  assert.equal(ui.calls[0].proposals[0].before,'Beta appears.');
  assert.equal(ui.calls[0].proposals[0].anchor.occurrence,1);
  assert.equal(ui.calls[0].proposals[0].anchor.start,ui.calls[0].proposals[0].matches[0].start);
  assert.equal(ui.calls[0].proposals[0].origin,'external-ai-import');
  assert.equal(ui.calls[0].options.confirmed,true);
  assert.match(ui.input('external-red-accept-status').textContent,/편집 목록에서 확인/);
  assert.equal(ui.calls[0].proposals.some(item=>item.segmentId==='missing'),false);
});

test('a source change drops the stale mapping before another accept',async()=>{
  const ui=world();
  ui.input('external-red-paste').value=JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]});
  ui.input('external-red-review').click();
  const box=queryAll(ui.section(),'input').find(node=>node.type==='checkbox');
  box.checked=true;
  box.dispatchEvent(new Event('change'));
  ui.document.dispatchEvent(new Event('falsify:paper-workspace-source'));
  assert.equal(queryAll(ui.section(),'article').length,0);
  assert.match(ui.input('external-red-accept-status').textContent,/원문이 바뀌어/);
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,0);
  assert.equal(ui.input('external-red-paste').value.includes(ALPHA),true);
});

test('two confirmed replacements of the same span are not sent together',async()=>{
  const ui=world();
  ui.input('external-red-paste').value=JSON.stringify({changes:[
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'One.'},
    {segmentId:'s0',pageIndex:0,before:ALPHA,after:'Two.'}
  ]});
  ui.input('external-red-review').click();
  const cards=queryAll(ui.section(),'article');
  assert.ok(cards.every(card=>card['data-status']==='ambiguous'));
  for(const card of cards){
    const radio=queryAll(card,'input').find(node=>node.type==='radio');
    assert.equal(radio.checked,false);
    queryAll(card,'button')[0].click();
    assert.equal(card['data-status'],'ambiguous');
  }
  for(const card of cards){
    const radio=queryAll(card,'input').find(node=>node.type==='radio');
    radio.checked=true;
    radio.dispatchEvent(new Event('change'));
  }
  for(const card of cards)queryAll(card,'button')[0].click();
  for(const box of queryAll(ui.section(),'input').filter(node=>node.type==='checkbox')){box.checked=true;box.dispatchEvent(new Event('change'));}
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,0);
  assert.match(ui.input('external-red-accept-status').textContent,/겹치는 변경은 함께 가져오지 않습니다/);
});

test('accept without a workspace API does not throw or invent a run',async()=>{
  const ui=world();
  ui.workspace.acceptProposals=undefined;
  ui.input('external-red-paste').value=JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]});
  ui.input('external-red-review').click();
  const box=queryAll(ui.section(),'input').find(node=>node.type==='checkbox');
  box.checked=true;
  box.dispatchEvent(new Event('change'));
  ui.input('external-red-accept').click();
  await flush();
  assert.match(ui.input('external-red-accept-status').textContent,/편집 화면이 없어 가져오지 못했습니다/);
  assert.equal(ui.calls.length,0);
});

test('an empty or unrecognized paste is zero changes and is not applied',async()=>{
  const ui=world();
  ui.input('external-red-paste').value=JSON.stringify({edits:[]});
  ui.input('external-red-review').click();
  assert.equal(queryAll(ui.section(),'article').length,0);
  assert.equal(ui.input('external-red-accept-status')['data-state'],'no-changes');
  assert.match(ui.input('external-red-accept-status').textContent,/변경 0건입니다/);
  assert.match(ui.input('external-red-accept-status').textContent,/적용하지 않습니다/);
  assert.doesNotMatch(ui.input('external-red-accept-status').textContent,/변경을 찾았습니다/);
  assert.equal(ui.input('external-red-accept').disabled,true);
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,0);
  ui.input('external-red-paste').value=JSON.stringify({notes:'no edits'});
  ui.input('external-red-review').click();
  assert.equal(ui.input('external-red-accept-status')['data-state'],'no-changes');
  assert.doesNotMatch(ui.input('external-red-accept-status').textContent,/변경을 찾았습니다/);
  assert.equal(ui.input('external-red-accept').disabled,true);
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,0);
  ui.input('external-red-paste').value=JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:ALPHA}]});
  ui.input('external-red-review').click();
  assert.equal(queryAll(ui.section(),'article').length,0);
  assert.equal(ui.input('external-red-accept-status')['data-state'],'no-changes');
  assert.equal(ui.calls.length,0);
});

test('an edits alias reviews as one exact change',async()=>{
  const ui=world();
  ui.input('external-red-paste').value=JSON.stringify({edits:[{segmentId:'s0',pageIndex:0,before:ALPHA,after:'Changed.'}]});
  ui.input('external-red-review').click();
  assert.equal(ui.input('external-red-accept-status')['data-state'],'ready');
  assert.match(ui.input('external-red-accept-status').textContent,/변경을 찾았습니다/);
  assert.equal(queryAll(ui.section(),'article')[0]['data-status'],'matched');
  const box=queryAll(ui.section(),'input').find(node=>node.type==='checkbox');
  box.checked=true;
  box.dispatchEvent(new Event('change'));
  ui.input('external-red-accept').click();
  await flush();
  assert.equal(ui.calls.length,1);
  assert.equal(ui.calls[0].proposals[0].before,ALPHA);
  assert.equal(ui.calls[0].proposals[0].after,'Changed.');
  assert.equal(ui.calls[0].proposals[0].origin,'external-ai-import');
});

test('the second alpha match is the occurrence the real edit core accepts',async()=>{
  const src=fs.readFileSync(path.resolve(__dirname,'../dist/paper-edits.js'),'utf8');
  const sandbox={module:{exports:{}},exports:{}};
  vm.createContext(sandbox);
  vm.runInContext(src,sandbox,{filename:'paper-edits.js'});
  sandbox.core=sandbox.module.exports;
  const ui=world();
  ui.source={file:null,fileHash:HASH,segments:[{id:'s0',label:'PDF p. 1',text:'alpha alpha',pageIndex:0}]};
  ui.input('external-red-paste').value=JSON.stringify({changes:[{segmentId:'s0',pageIndex:0,before:'alpha',after:'BETA'}]});
  ui.input('external-red-review').click();
  const card=queryAll(ui.section(),'article')[0];
  assert.equal(card['data-status'],'ambiguous');
  const radios=queryAll(card,'input').filter(node=>node.type==='radio');
  assert.equal(radios.length,2);
  assert.ok(radios.every(radio=>radio.checked===false));
  assert.match(textOf(card),/PDF p\.1/);
  assert.match(textOf(card),/alpha \[alpha\]/);
  queryAll(card,'button')[0].click();
  assert.equal(queryAll(ui.section(),'article')[0]['data-status'],'ambiguous');
  radios[1].checked=true;
  radios[1].dispatchEvent(new Event('change'));
  queryAll(card,'button')[0].click();
  const box=queryAll(ui.section(),'input').find(node=>node.type==='checkbox');
  box.checked=true;
  box.dispatchEvent(new Event('change'));
  ui.input('external-red-accept').click();
  await flush();
  const proposal=ui.calls[0].proposals[0];
  assert.equal(proposal.before,'alpha');
  assert.equal(proposal.anchor.start,6);
  assert.equal(proposal.anchor.end,11);
  assert.equal(proposal.anchor.occurrence,1);
  sandbox.before=proposal.before;
  sandbox.after=proposal.after;
  sandbox.pageIndex=proposal.pageIndex;
  sandbox.segmentId=proposal.segmentId;
  sandbox.start=proposal.anchor.start;
  sandbox.end=proposal.anchor.end;
  sandbox.occurrence=proposal.anchor.occurrence;
  const stored=vm.runInContext(`(()=>{
    const session=core.create({fileHash:'${'ab'.repeat(32)}',name:'fixture.txt',segments:[{id:'s0',label:'PDF p. 1',text:'alpha alpha',pageIndex:0}],now:()=>1});
    const id=session.add({pageIndex:pageIndex,segmentId:segmentId,before:before,after:after,origin:'external-ai-import',anchor:{start:start,end:end,occurrence:occurrence}});
    const edit=session.snapshot().edits.find(item=>item.id===id);
    return {before:edit.before,start:edit.anchor.start,end:edit.anchor.end,occurrence:edit.anchor.occurrence};
  })()`,sandbox);
  assert.equal(stored.before,'alpha');
  assert.equal(stored.start,6);
  assert.equal(stored.occurrence,1);
  assert.equal('alpha alpha'.slice(stored.start,stored.end),stored.before);
});

(async()=>{
  for(const [name,fn] of tests){await fn();checks++;console.log('PASS '+name);}
  console.log(JSON.stringify({passed:checks,scope:'external-red ui'}));
})().catch(error=>{console.error(error);process.exit(1);});

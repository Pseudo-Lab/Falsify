'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../dist/app.js'),'utf8');
function shell(hash){
  const nodes=new Map(), listeners={};
  function node(selector){
    if(!nodes.has(selector)) nodes.set(selector,{textContent:'',dataset:{},classList:{remove(){},add(){}},addEventListener(){},querySelectorAll(){return [];},focus(){},scrollIntoView(){},closest(){return this;}});
    return nodes.get(selector);
  }
  const document={querySelector:node,querySelectorAll(){return [];},addEventListener(type,fn){listeners[type]=fn;}};
  const context={document,location:{hash},history:{replaceState(){},pushState(){}},matchMedia:()=>({matches:true}),clearTimeout(){},addEventListener(){},scrollTo(){}};
  vm.runInNewContext(source,context);
  return {node,emit:(name,detail)=>listeners[name]({detail}),context};
}
test('RED sign reflects source and document progress states',()=>{
  const s=shell('#red');
  assert.equal(s.node('#sign-title').textContent,'논문 파일을 입력하세요');
  s.emit('falsify:document-state',{name:'paper.pdf',count:2,selected:1});
  assert.equal(s.node('#sign-title').textContent,'후보를 선택하고 편집하세요');
  assert.equal(s.node('#sign-detail').textContent,'paper.pdf · 2개 후보 · 1개 선택');
  s.context.FalsifyLatexWorkbench={active:true,getSource:()=>({file:{name:'source.tex'}}),getSession:()=>({snapshot:()=>({artifact:true})})};
  s.emit('falsify:latex-state');
  assert.equal(s.node('#sign-title').textContent,'원본을 눌러 수정하세요');
  assert.equal(s.node('#sign-detail').textContent,'source.tex');
});
test('BLUE sign reflects busy, result and ready states',()=>{
  const s=shell('#blue');
  assert.equal(s.node('#sign-title').textContent,'BLUE 검토 파일을 입력하세요');
  for(const [detail,title] of [[{busy:true,phase:'import',name:'p'},'변경본을 읽고 있습니다'],[{hasResult:true,name:'p'},'BLUE 결과를 확인하세요'],[{name:'p'},'논문을 검토할 준비가 됐습니다']]){
    s.emit('falsify:blue-state',detail);
    assert.equal(s.node('#sign-title').textContent,title);
  }
});

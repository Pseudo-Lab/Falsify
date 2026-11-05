import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPaperLayoutAgent} from '../src/paper-layout-agent-ui.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(){}
}
const doc={createElement:tag=>new Element(tag)};
function find(node,predicate){if(predicate(node))return node;for(const child of node.children||[]){const result=find(child,predicate);if(result)return result;}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function setup(project,reference){
  const host=new Element('host');let epoch=1,calls=0;
  const artifact={projectId:project.id,pdfBytes:Uint8Array.of(1),pdfHash:hex(Uint8Array.of(1))};
  const session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};
  const agent=mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>epoch,getReferenceFile:()=>reference,download(){},bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),runAgent:async()=>{calls++;return {project,artifact,status:'complete'};}});
  return {host,agent,invalidate(){epoch++;agent.invalidate();},calls:()=>calls};
}
test('source change during replacement read cancels before compiling or starting the agent',async()=>{
  const pending=deferred(),project={id:'p',files:[]},ctx=setup(project);
  const input=find(ctx.host,n=>n.accept==='image/png,image/jpeg');input.files=[{name:'image.png',size:1,arrayBuffer:()=>pending.promise}];
  const running=ctx.agent.start();await tick();ctx.invalidate();pending.resolve(Uint8Array.of(1).buffer);await running;
  assert.equal(ctx.calls(),0);assert.equal(ctx.agent.getCandidate(),null);
});
test('source change during original reference read cancels before starting the agent',async()=>{
  const pending=deferred(),bytes=Uint8Array.of(2),project={id:'p',files:[],origin:'reconstructed-pdf',sourcePdfHash:hex(bytes)},ctx=setup(project,{arrayBuffer:()=>pending.promise});
  const running=ctx.agent.start();await tick();ctx.invalidate();pending.resolve(bytes.buffer);await running;
  assert.equal(ctx.calls(),0);assert.equal(ctx.agent.getCandidate(),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {runPaperLayoutAgent} from '../src/paper-layout-agent.mjs';

const enc=new TextEncoder();
const action=tool=>({tool,path:'',before:'',after:'',pages:[],message:''});
async function fixture(){
  const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Evidence 63.')}]});
  const bytes=enc.encode('%PDF synthetic');
  return {project,artifact:{success:true,projectId:project.id,engine:project.engine,pdfBytes:bytes,pdfHash:hex(bytes)}};
}

test('cancellation while an injected tool is pending ignores late output and emits no next decision',async()=>{
  const {project,artifact}=await fixture(),controller=new AbortController(),events=[];
  let resolveTool,toolStarted;
  const started=new Promise(resolve=>{toolStarted=resolve;});
  const pending=new Promise(resolve=>{resolveTool=resolve;});
  const run=runPaperLayoutAgent({project,artifact,signal:controller.signal,
    decide:async()=>{events.push('decide');return action('inspect_pdf');},
    compile:async()=>artifact,inspect:async()=>null,render:async()=>null,
    handlers:{inspect_pdf:()=>{events.push('tool');toolStarted();return pending;}},
    onProgress:e=>events.push(e.action)
  });
  await started;controller.abort();resolveTool({observation:{schema:'irrelevant'}});
  const out=await run;
  assert.equal(out.status,'cancelled');assert.equal(out.artifact.pdfHash,artifact.pdfHash);
  assert.deepEqual(events,['decide','tool']);assert.equal(out.trace.length,0);
});

test('a stale injected project is rejected before any replacement or later decision',async()=>{
  const {project,artifact}=await fixture(),events=[];let n=0;
  const out=await runPaperLayoutAgent({project,artifact,
    decide:async()=>{events.push('decide');return action(n++===0?'inspect_pdf':'finish');},
    compile:async()=>artifact,inspect:async()=>null,render:async()=>null,
    handlers:{inspect_pdf:async()=>({project:{...project,id:'0'.repeat(64)}})},
    onProgress:e=>events.push(e.action+':'+e.result.status)
  });
  assert.equal(out.project.id,project.id);assert.equal(out.artifact.pdfHash,artifact.pdfHash);
  assert.equal(out.trace[0].result.code,'SOURCE_CHANGED');
  assert.deepEqual(events.slice(0,3),['decide','inspect_pdf:rejected','decide']);
});

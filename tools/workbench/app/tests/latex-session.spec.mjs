import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createLatexProject} from '../src/latex-project.mjs';
import {locateSourceText,analyzeLatexSource} from '../src/latex-source-model.mjs';
import {applySourceChanges} from '../src/latex-source-patches.mjs';
import {createLatexSession} from '../src/latex-session.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const generationApi=createRequire(import.meta.url)('../dist/paper-generation.js'),enc=new TextEncoder(),dec=new TextDecoder();
async function setup(options={}){
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Hello world \\textsuperscript{62}')} ]});
 const match=locateSourceText(project,{before:'Hello'}).candidates[0];
 const change={id:'one',kind:'text',mode:'content',before:match.before,after:'Goodbye',anchor:match.anchor};
 const calls=[];const compiler=options.compiler||{async compile(req){calls.push(req);return {success:true,pdfBytes:enc.encode(dec.decode(req.project.files[0].bytes)),diagnostics:[]};}};
 const initialArtifact=typeof options.initialArtifact==='function'?options.initialArtifact(project):options.initialArtifact;
 const session=createLatexSession({project,applyChanges:options.applyChanges||applySourceChanges,compiler,generationApi,initialArtifact,onOutput:options.onOutput});return {project,change,calls,session,initialArtifact};
}
test('actual patches, selection, undo, redo and original',async()=>{
 const {project,change,calls,session}=await setup();const original=dec.decode(project.files[0].bytes);
 await session.compile();session.setChange(change);assert.match(dec.decode((await session.compile()).pdfBytes),/Goodbye/);assert.equal(dec.decode(project.files[0].bytes),original);assert.match(dec.decode((await session.getCurrentProject()).files[0].bytes),/Goodbye/);
 session.setChange({...change,id:'two',after:'Other'});assert.equal(session.snapshot().changes[0].enabled,false);assert.match(dec.decode((await session.compile()).pdfBytes),/Other/);
 session.undo();assert.match(dec.decode((await session.compile()).pdfBytes),/Goodbye/);session.redo();assert.match(dec.decode((await session.compile()).pdfBytes),/Other/);
 assert.throws(()=>session.setChange({...change,anchor:{...change.anchor,projectId:'wrong'}}),{code:'stale-anchor'});assert.ok(calls.length>=3);session.dispose();
});
test('invalid and overlapping patches fail before compiler and export',async()=>{
 const {session,change,calls}=await setup();await session.compile();const count=calls.length;
 session.setChanges([{...change,before:'wrong'}]);await assert.rejects(session.compile(),{code:'source-patch-failed'});await assert.rejects(session.getCurrentProject(),{code:'source-patch-failed'});assert.equal(calls.length,count);assert.equal(session.getCurrentOutput(),null);assert.ok(session.snapshot().lastArtifact);
 session.setChanges([change,{...change,id:'second'}]);await assert.rejects(session.compile(),{code:'source-patch-failed'});assert.equal(calls.length,count);
 session.setChanges([{...change,before:'wrong',enabled:false}]);await session.compile();assert.equal(session.snapshot().error,null);session.dispose();
});
test('zero-width selection conflicts match patch semantics',async()=>{
 const {session,project}=await setup();const n=analyzeLatexSource(project).nodes[0],anchor={projectId:project.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.contentStart,end:n.contentStart};
 const c={id:'insert',kind:n.kind,before:'',after:'A',anchor};session.setChange(c);session.setChange({...c,id:'second',after:'B'});assert.equal(session.snapshot().changes[0].enabled,false);assert.match(dec.decode((await session.compile()).pdfBytes),/^BHello/);session.dispose();
});
test('policy enters key and public output copies protect cache',async()=>{
 let seen;const {session,project,calls}=await setup({onOutput:o=>{seen=o;o.pdfBytes[0]=0;}});const n=analyzeLatexSource(project).nodes.find(n=>n.kind==='superscript');const c={id:'p',kind:n.kind,mode:'display-override',before:n.sourceText,after:'63',afterSource:'\\textsuperscript{63}',anchor:{projectId:project.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.start,end:n.end}};
 session.setChange(c);let first=await session.compile();assert.match(dec.decode(first.pdfBytes),/63/);assert.equal(seen.pdfBytes[0],0);first.pdfBytes[0]=0;session.snapshot().artifact.pdfBytes[0]=0;session.snapshot().lastArtifact.pdfBytes[0]=0;assert.notEqual(session.getCurrentOutput().pdfBytes[0],0);
 session.setChange({...c,afterSource:'\\textsuperscript{64}'});assert.match(dec.decode((await session.compile()).pdfBytes),/64/);assert.equal(calls.length,2);session.setChange(c);assert.match(dec.decode((await session.compile()).pdfBytes),/63/);assert.equal(calls.length,2);session.dispose();
});
test('cancelled stale work cannot publish over current work',async()=>{
 let release,started;const began=new Promise(r=>started=r);let count=0;const compiler={async compile({project}){if(++count===1){started();await new Promise(r=>release=r);}return {success:true,pdfBytes:new Uint8Array(project.files[0].bytes)};}};
 const {session,change}=await setup({compiler});const old=session.compile();await began;session.cancel();await assert.rejects(old,{name:'AbortError'});session.setChange(change);const current=session.compile();release();assert.match(dec.decode((await current).pdfBytes),/Goodbye/);assert.match(dec.decode(session.getCurrentOutput().pdfBytes),/Goodbye/);session.dispose();
});
test('unapplied result is rejected without diagnostics',async()=>{
 const {session,change,calls}=await setup({applyChanges:async p=>({project:p,applied:[],diagnostics:[]})});session.setChange(change);await assert.rejects(session.compile(),{code:'source-patch-failed'});await assert.rejects(session.getCurrentProject(),{code:'source-patch-failed'});assert.equal(calls.length,0);session.dispose();
});
test('compiler failure retains previous artifact without exposing it as current',async()=>{
 let count=0;const compiler={async compile({project}){if(++count===1)return {success:true,pdfBytes:new Uint8Array(project.files[0].bytes)};return {success:false,diagnostics:[{severity:'error',message:'bad source'}]};}};
 const {session,change}=await setup({compiler});await session.compile();const baseline=session.getBaseline();baseline.pdfBytes[0]=0;assert.notEqual(session.getBaseline().pdfBytes[0],0);session.setChange(change);await assert.rejects(session.compile(),{code:'latex-compile-failed'});assert.equal(session.getCurrentOutput(),null);assert.ok(session.snapshot().lastArtifact);assert.equal(session.snapshot().error.message,'bad source');session.dispose();
});

test('adopted compared PDF is owned, re-keyed and reused through edits and undo even after cache eviction',async()=>{
 const bytes=enc.encode('%PDF-1.7\ncompared baseline\n%%EOF'),events=[];
 const {session,change,calls,initialArtifact}=await setup({initialArtifact:p=>({success:true,pdfBytes:bytes,pdfHash:hex(bytes),projectId:p.id,engine:p.engine,key:'untrusted'}),onOutput:o=>events.push(o)});
 assert.equal(events.length,0);assert.notEqual(session.getCurrentOutput().key,'untrusted');
 bytes[5]=88;initialArtifact.pdfBytes[6]=88;
 const baseline=session.getBaseline(),expected=dec.decode(baseline.pdfBytes);assert.match(expected,/%PDF-1\.7/);
 baseline.pdfBytes[0]=0;const first=await session.compile();assert.equal(dec.decode(first.pdfBytes),expected);assert.equal(calls.length,0);
 first.pdfBytes[0]=0;assert.equal(dec.decode(session.getCurrentOutput().pdfBytes),expected);
 for(const value of ['A','B','C','D']){session.setChange({...change,after:value});await session.compile();}
 assert.equal(calls.length,4);for(let i=0;i<4;i++)session.undo();
 const restored=await session.compile();assert.equal(dec.decode(restored.pdfBytes),expected);assert.equal(dec.decode(session.getBaseline().pdfBytes),expected);assert.equal(calls.length,4);
 session.redo();assert.match(dec.decode((await session.compile()).pdfBytes),/^A/);assert.equal(dec.decode(session.getBaseline().pdfBytes),expected);session.dispose();
});
test('adoption rejects invalid PDF identity and content',async()=>{
 const bytes=enc.encode('%PDF-1.7\nbody\n%%EOF');
 for(const patch of [{projectId:'wrong'},{pdfHash:'0'.repeat(64)},{success:false},{engine:'other'},{pdfBytes:enc.encode('not a PDF')},{pdfBytes:new Uint8Array()}]){
   await assert.rejects(setup({initialArtifact:p=>({success:true,pdfBytes:bytes,pdfHash:hex(bytes),projectId:p.id,engine:p.engine,...patch})}),e=>['invalid-initial-artifact','artifact-hash-mismatch'].includes(e.code));
 }
});
test('an obsolete explicit compile cannot return success after the source changes',async()=>{
 let release,started;const began=new Promise(r=>started=r);const compiler={async compile({project}){started();await new Promise(r=>release=r);return {success:true,pdfBytes:new Uint8Array(project.files[0].bytes)};}};
 const {session,change}=await setup({compiler});const previous=session.compile();await began;session.setChange(change);release();await assert.rejects(previous,{name:'AbortError'});assert.equal(session.getCurrentOutput(),null);session.cancel();session.dispose();
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'fflate';
import {parseSynctex,mapPdfToSource,mapSourceToPdf} from '../src/latex-synctex-map.mjs';
import {createLatexCompiler} from '../src/latex-compiler-adapter.mjs';
const project={id:'p',mainFile:'main.tex',engine:'pdflatex',files:[{path:'main.tex',bytes:new TextEncoder().encode('hello')}]};
const synctex='SyncTeX Version:1\nInput:1:/project/main.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,12:65536,131072:655360,65536,0\n}\nPostamble:\n';
test('SyncTeX gzip and plain conversion uses zero based page and top-left PDF points',()=>{
 for(const input of [new TextEncoder().encode(synctex),gzipSync(new TextEncoder().encode(synctex))]){
  const map=parseSynctex(input,{project}); const hit=mapSourceToPdf(map,{path:'main.tex',line:12}).candidates[0];
  assert.equal(hit.pageIndex,0); assert.ok(Math.abs(hit.box.x-72/72.27)<1e-8); assert.ok(Math.abs(hit.box.y-72/72.27)<1e-8);
  assert.equal(mapPdfToSource(map,{pageIndex:0,x:2,y:1.5}).candidates[0].line,12); assert.equal(mapPdfToSource(map,{pageIndex:1,x:2,y:1.5}).status,'missing');
 }
});
test('worker dispatch disables remote endpoint and shell and returns worker bytes',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(m){this.sent??=[];this.sent.push(m)},terminate(){this.terminated=true}}});
 const pending=compiler.compile({project,key:'k'}); instance.onmessage({data:{initialized:true}});
 assert.equal(instance.sent[1].shell_escape,false); assert.equal(instance.sent[1].remote_endpoint,''); assert.equal(instance.sent[1].files[0].path,'main.tex');
 instance.onmessage({data:{pdf:new Uint8Array([37,80,68,70]),exit_code:0}}); const result=await pending; assert.equal(result.success,true); assert.equal(result.pdfHash.length,64); assert.equal(instance.terminated,true);
});
test('cancel and failed compilation never return stale PDF',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(){},terminate(){}}});
 let pending=compiler.compile({project}); compiler.cancel(); assert.equal((await pending).diagnostics[0].code,'CANCELLED');
 pending=compiler.compile({project}); instance.onmessage({data:{pdf:new Uint8Array([1]),exit_code:1}}); const result=await pending; assert.equal(result.success,false); assert.equal(result.pdfBytes,undefined);
 compiler.dispose(); await assert.rejects(compiler.compile({project}));
});
test('failure reports a bounded missing file and line without returning source text',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(){},terminate(){}}});
 const pending=compiler.compile({project});
 instance.onmessage({data:{pdf:null,exit_code:1,log:"! LaTeX Error: File `absent.sty' not found.\nl.7 private source text"}});
 const result=await pending; assert.equal(result.diagnostics[0].code,'TEX_MISSING_FILE');
 assert.equal(result.diagnostics[0].line,7); assert.equal(JSON.stringify(result).includes('private source text'),false);
});
test('abort terminates its worker and cannot finish a subsequent compile',async()=>{
 const workers=[]; const compiler=createLatexCompiler({workerFactory:()=>{const worker={postMessage(){},terminate(){this.terminated=true}};workers.push(worker);return worker}});
 const controller=new AbortController(); const first=compiler.compile({project,signal:controller.signal});
 controller.abort(); assert.equal((await first).diagnostics[0].code,'CANCELLED'); assert.equal(workers[0].terminated,true);
 const next=compiler.compile({project,key:'new'}); workers[0].onmessage({data:{pdf:new Uint8Array([1]),exit_code:0}});
 workers[1].onmessage({data:{pdf:new Uint8Array([2]),exit_code:0}}); assert.equal((await next).key,'new');
});
test('snapshot source bytes before asynchronous worker initialization',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(m){this.sent??=[];this.sent.push(m)},terminate(){}}});
 const bytes=new Uint8Array([65]); const input={...project,files:[{path:'main.tex',bytes}]};
 const pending=compiler.compile({project:input}); bytes[0]=66; instance.onmessage({data:{initialized:true}});
 assert.equal(instance.sent[1].files[0].contents[0],65); compiler.cancel(); await pending;
});

test('successful PDF retains bounded unresolved and font diagnostics without source logs',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(){},terminate(){}}});
 const pending=compiler.compile({project});
 instance.onmessage({data:{pdf:new Uint8Array([37,80,68,70]),exit_code:0,log:"LaTeX Warning: Reference `private-key' on page 1 undefined.\nLaTeX Warning: Citation `private-cite' on page 1 undefined.\nMissing character: There is no private-character in font cmr10!"}});
 const result=await pending; assert.equal(result.success,true);
 assert.deepEqual(result.diagnostics.map(d=>d.code),['TEX_UNDEFINED_REFERENCE','TEX_UNDEFINED_CITATION','TEX_FONT_WARNING']);
 assert.equal(JSON.stringify(result).includes('private-'),false);
});
test('SyncTeX prefers exact project path over a suffix match',()=>{
 const input=new TextEncoder().encode(synctex.replace('/project/main.tex','sections/main.tex'));
 const map=parseSynctex(input,{project:{...project,files:[{path:'main.tex'},{path:'sections/main.tex'}]}});
 assert.equal(map.boxes[0].path,'sections/main.tex');
});

test('Lua compilation preloads its static profile and keeps remote execution disabled', async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(m){this.sent??=[];this.sent.push(m)},terminate(){}}});
 const pending=compiler.compile({project:{...project,engine:'lualatex'}});
 assert.deepEqual(instance.sent[0].preload_data_packages_js.map(x=>new URL(x).pathname.split('/').pop()),['texlive-basic.js','texlive-lua-profile.js']);
 instance.onmessage({data:{initialized:true}}); assert.equal(instance.sent[1].driver,'luahbtex_bibtex8'); assert.equal(instance.sent[1].remote_endpoint,''); assert.equal(instance.sent[1].shell_escape,false);
 compiler.cancel(); const cancelled=await pending;assert.equal(cancelled.engineManifest.data,'texlive-basic+falsify-lua-profile');assert.equal(cancelled.engineManifest.manifestSha256.length,64);
});

test('Lua artifact records profile identity and bounded overflow facts without source text',async()=>{
 let instance;const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(){},terminate(){}}});
 const pending=compiler.compile({project:{...project,engine:'lualatex'}});
 instance.onmessage({data:{pdf:new Uint8Array([37,80,68,70]),exit_code:0,log:'Overfull \\hbox (4.25pt too wide) in paragraph at lines 19--24\nprivate body\nOverfull \\vbox (1.0pt too high) detected at line 37\n'}});
 const result=await pending;assert.equal(result.success,true);assert.equal(result.engineManifest.profile,'falsify.latex-lua-profile.v1');assert.equal(result.engineManifest.manifestSha256.length,64);
 const d=result.diagnostics.find(d=>d.code==='TEX_OVERFULL_BOX');assert.equal(d.count,2);assert.equal(d.maxOverflowPt,4.25);assert.deepEqual(d.lines,[19,37]);assert.equal(JSON.stringify(result).includes('private body'),false);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const bundle=await build({entryPoints:[app+'/src/paragraph-vendor/editor.mjs'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'runtime',setup(b){b.onResolve({filter:/^\.\/runtime\.mjs$/},()=>({path:app+'/src/paragraph-pdf-runtime.mjs'}));b.onResolve({filter:/engine-loader\.js$/},()=>({path:app+'/src/paragraph-pdf-engine-loader.mjs'}));}}]});
const {planPageEdits}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const inlineBundle=await build({entryPoints:[app+'/src/paragraph-vendor/inline-preservation.mjs'],bundle:true,platform:'node',format:'esm',write:false});
const {commitSourceLineDeletion}=await import('data:text/javascript;base64,'+Buffer.from(inlineBundle.outputFiles[0].contents).toString('base64'));
const para=text=>({id:'p',editable:true,box:{x:20,top:100,w:180,h:30},lines:[{x:20,y:90,w:180,off:0},{x:20,y:80,w:180,off:text.indexOf('Second')}],runs:[{text,size:10,rgba:0}]});
test('multiline input deletion keeps unchanged source whitespace and narrows the edit',()=>{
 const source='First sentence. Second sentence contains removable words here.';
 const before='First sentence.\nSecond sentence contains removable words here.';
 const after='First sentence.\nSecond sentence contains words here.';
 const result=planPageEdits([para(source)], [{id:'delete',pageIndex:0,before,after}]);
 assert.deepEqual(result.failures,[]);
 const change=result.plans[0].change;
 assert.equal(change.del.map(c=>c.ch).join(''),'removable ');
 assert.deepEqual(change.inserts,[]);
 assert.equal(result.plans[0].edit.after,after);
});
test('a requested line-break change keeps the existing replacement path',()=>{
 const source='First sentence. Second sentence contains removable words here.';
 const before='First sentence.\nSecond sentence contains removable words here.';
 const after='First sentence. Second sentence contains words here.';
 const result=planPageEdits([para(source)], [{id:'replace',pageIndex:0,before,after}]);
 assert.deepEqual(result.failures,[]);
 assert.equal(result.plans[0].edit.after,after);
});
test('newly inserted line breaks remain in the planned replacement',()=>{
 const source='First sentence. Second sentence contains removable words here.';
 const before='First sentence. Second sentence contains removable words here.';
 const after='First sentence. Second sentence contains new\nwords here.';
 const result=planPageEdits([para(source)], [{id:'insert',pageIndex:0,before,after}]);
 assert.deepEqual(result.failures,[]);
 assert.ok(result.plans[0].change.inserts.some(i=>i.text.includes('\n')));
});
test('source glyph deletion declines replacements and deletions crossing a line before touching the engine',async()=>{
 const source='First line. Second line.', p=para(source);
 p.lines=[{off:0,y:90,x:20},{off:12,y:80,x:20}];
 const engine={get M(){throw new Error('engine must not be touched');}};
 assert.equal(await commitSourceLineDeletion(engine,p,[{text:'First line. Changed line.'}]),null);
 assert.equal(await commitSourceLineDeletion(engine,p,[{text:'First line line.'}]),null);
});

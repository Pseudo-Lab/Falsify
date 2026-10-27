import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const dir=fileURLToPath(new URL('../src',import.meta.url));
const built=await build({stdin:{contents:"export {PdfEngine} from './paragraph-vendor/engine/core.js'; export {removeGeometricFirstLine} from './paragraph-vendor/inline-preservation.mjs';",resolveDir:dir},bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'engine-loader',setup(b){b.onResolve({filter:/engine-loader\.js$/},()=>({path:dir+'/paragraph-pdf-engine-loader.mjs'}));}}]});
const {PdfEngine,removeGeometricFirstLine}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));

function fixture({removeFails=false,proofFails=false}={}){
  const events=[],memory=new Float64Array(32);let handles=[10,11];
  const M={HEAPF64:memory,_malloc:()=>16,_free:()=>{},
    _FPDFText_LoadPage:()=>1,_FPDFText_ClosePage:()=>{},_FPDFText_CountChars:()=>4,
    _FPDFText_GetTextObject:(_,i)=>i<2?10:11,_FPDFText_GetUnicode:(_,i)=>'ABCD'.charCodeAt(i),
    _FPDFText_GetCharOrigin:(_,i,x,y)=>{memory[x>>3]=i;memory[y>>3]=i<2?100:90;return true;},
    _FPDFPage_CountObjects:()=>handles.length,_FPDFPage_GetObject:(_,i)=>handles[i],
    _FPDFPage_RemoveObject:(_,h)=>{events.push('remove');if(removeFails)return false;handles=proofFails?[11,99]:[11];return true;},
    _FPDFPageObj_Destroy:h=>events.push('destroy:'+h),_FPDF_ClosePage:()=>events.push('page'),
    _ec_session_destroy:()=>events.push('session'),_FPDF_CloseDocument:()=>events.push('document')};
  const engine=Object.assign(Object.create(PdfEngine.prototype),{M,page:77,session:88,doc:99,_docBuf:0,_pageCache:new Map(),paragraphObjects:()=>[10,11]});
  const para={id:1,runs:[{text:'AB\nCD'}],lines:[{off:0,y:100},{off:3,y:90}]};
  return {engine,events,remove:()=>removeGeometricFirstLine(engine,para,new Set(['0:0','0:1']),[])};
}

for(const proofFails of [false,true])test('removed object is released once after session close, including proof failure '+proofFails,()=>{
  const f=fixture({proofFails});
  if(proofFails)assert.throws(f.remove,/geometric_remove_proof_failed/);else assert.equal(f.remove(),true);
  assert.deepEqual(f.events,['remove']);f.engine.close();f.engine.close();
  assert.deepEqual(f.events,['remove','page','session','destroy:10','document']);
});
test('failed removal does not transfer or destroy page-owned objects',()=>{
  const f=fixture({removeFails:true});assert.throws(f.remove,/geometric_remove_failed/);f.engine.close();
  assert.deepEqual(f.events,['remove','page','session','document']);
});

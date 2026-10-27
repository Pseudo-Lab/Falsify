import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {composeDocument} from '../src/paper-compose.mjs';
import {createTypstCompile} from '../src/paper-typst.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const root=process.env.FALSIFY_TYPST_MODULES, wasm=process.env.FALSIFY_TYPST_WASM, font=process.env.FALSIFY_TYPST_FONT, python=process.env.FALSIFY_PYMUPDF_PYTHON;
const src=new TextEncoder().encode('source'), hash=createHash('sha256').update(src).digest('hex');
async function render(fields) {
 const {createTypstCompiler,createTypstFontBuilder}=await import(pathToFileURL(join(root,'@myriaddreamin/typst.ts/dist/esm/compiler.mjs')));
 const {loadFonts}=await import(pathToFileURL(join(root,'@myriaddreamin/typst.ts/dist/esm/options.init.mjs')));
 const fb=await readFile(font), wb=await readFile(wasm);
 const compile=createTypstCompile({createTypstCompiler,createTypstFontBuilder,loadFonts,getModule:()=>wb});
 const block=(id,text)=>({id,text,styleId:'s',source:{pageIndex:0,range:{start:0,end:text.length},lines:[]}});
 const document={schema:'falsify.paper-document.v1',sourceSha256:hash,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'s',size:10,fontName:'Serif'}],blocks:[block('body','Body text'),...fields.map(f=>block(f.id,f.text))]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items:[{id:'body-item',kind:'paragraph',columns:1,blockIds:['body']} ,...fields.map(f=>({id:'i-'+f.id,kind:'footer',blockIds:[f.id],source:{pageIndex:0,bbox:f.bbox}}))]};
 const planner=()=>({margins:{top:60,bottom:70,left:36,right:36},pages:[{sourcePage:0,header:[],footer:fields.map(f=>({kind:f.counter?'counter':'text',itemId:'i-'+f.id,blockId:f.id,bbox:f.bbox,text:f.text,source:{pageIndex:0}}))}],excludedBlockIds:fields.map(f=>f.id),excludedItemIds:fields.map(f=>'i-'+f.id),diagnostics:[]});
 return composeDocument({document,flow,sourceBytes:src,runningFurniture:true},{furniturePlanner:planner,compile,fonts:{family:'Noto Serif',candidates:[{family:'Noto Serif',getBytes:()=>fb}]}});
}
test('measured footer fields keep a gap, IDs, counter, rows and body clearance', {skip:!(root&&wasm&&font&&python)},async()=>{
 const fields=[{id:'left',text:'WWWWWWWWWWWW',bbox:[36,550,95,560]},{id:'next',text:'Second field',bbox:[100,550,150,560]},{id:'counter',text:'1 / 1',counter:true,bbox:[350,550,375,560]},{id:'row2',text:'Another row',bbox:[36,577,110,587]}];
 const out=await render(fields); assert.deepEqual(out.furnitureMap.map(x=>x.id).sort(),fields.map(x=>x.id).sort());
 assert.deepEqual(out.verification.furniture.templates.map(x=>x.text),fields.map(x=>x.text));
 const dir=await mkdtemp(join(tmpdir(),'furniture-'));try {
  const path=join(dir,'out.pdf');await writeFile(path,new Uint8Array(await out.file.arrayBuffer()));
  const script=String.raw`import pymupdf,sys
p=pymupdf.open(sys.argv[1])[0]
chars=[(chr(c[0]),c[3]) for s in p.get_texttrace() for c in s['chars']]
def word(t):
 s=''.join(c for c,b in chars); i=s.index(t); bs=[b for c,b in chars[i:i+len(t)]]; return (min(b[0] for b in bs),min(b[1] for b in bs),max(b[2] for b in bs),max(b[3] for b in bs))
a,b,c,d,body=map(word,['WWWWWWWWWWWW','Second field','1 / 1','Another row','Body text'])
assert b[0]-a[2]>=2.9,(a,b)
assert c[0]-b[2]>=2.9,(b,c)
assert a[3]<d[1] and body[3]<a[1],(a,d,body)
assert all(0<=z[0]<z[2]<=400 and 530<=z[1]<z[3]<=600 for z in (a,b,c,d))
`;
  const run=spawnSync(python,['-c',script,path],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('unfit rows keep source placement and expose the fallback without blocking PDF output', {skip:!(root&&wasm&&font)},async()=>{
 for(const fields of [[{id:'a',text:'W'.repeat(100),bbox:[36,550,100,560]}],[{id:'a',text:'First',bbox:[36,550,100,554]},{id:'b',text:'Second',bbox:[36,555,100,559]}]]) {
  const out=await render(fields);assert.ok(out.file.size>0);assert.ok(out.verification.furniture.spacing.some(x=>x.status==='source-position-fallback'));
  assert.ok(out.warnings.some(x=>x.includes('원래 위치')));assert.equal(out.furnitureMap.find(x=>x.id==='a').x,36);
 }
});

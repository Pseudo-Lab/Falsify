import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveLayoutProfile} from '../src/paper-style-profile.mjs';

test('profile uses body character and line geometry, keeping heading and caption evidence distinct',()=>{
 const block=(id,text,style,y)=>({id,text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:style}],lines:[{bbox:[10,y,180,y+9]},{bbox:[10,y+12,180,y+21]}]}});
 const document={pages:[{sourcePageIndex:0,width:400}],styles:[{id:'body',size:9,fontName:'Serif'},{id:'title',size:18,fontName:'Serif Bold'},{id:'caption',size:8,fontName:'Sans'}],blocks:[block('p','A long body paragraph','body',20),block('h','Title','title',0),block('c','Figure 1 caption','caption',80)]};
 const flow={items:[{kind:'heading',blockIds:['h']},{kind:'paragraph',columns:2,blockIds:['p'],source:{pageIndex:0,bbox:[10,20,180,41]}},{kind:'asset',captionIds:['c'],source:{pageIndex:0,bbox:[10,50,180,75]}},{kind:'caption',blockIds:['c']}]};
 const p=deriveLayoutProfile(document,flow);assert.equal(p.bodyFontSize,9);assert.equal(p.bodyLineHeight,12);assert.equal(p.headingFontSize,18);assert.equal(p.captionFontSize,8);assert.deepEqual(p.bodyFontNames,['Serif']);assert.equal(p.captions[0].text,'Figure 1 caption');assert.deepEqual(p.columns[0].bbox,[10,20,180,41]);
});
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
test('continuous two-column flow uses native pages and passes source profile to checker',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex');
 const text='A body paragraph';const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{width:400,height:600}],styles:[{id:'s',size:9,fontName:'Serif'}],blocks:[{id:'p',text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:'s'}],lines:[]}}]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,span:'column',blockIds:['p']}]}; let source,checked;
 const out=await composeDocument({document,flow,sourceBytes:src},{compile:async p=>(source=p.source,new TextEncoder().encode('%PDF-1.4')),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 assert.match(source,/#set page\([^\n]+columns: 2/);assert.doesNotMatch(source,/#columns\(2\)/);assert.match(source,/#set text\(size: 9pt\)/);assert.equal(checked.layoutProfile.sourceProfile.bodyFontSize,9);assert.equal(checked.layoutProfile.sourceProfile.coordinateSpace,'source');assert.equal(checked.layoutProfile.bodyFontSize,undefined);assert.deepEqual(out.layoutProfile,checked.layoutProfile);
});

test('repagination and subset font names cannot become output geometry or font assertions',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex'), text='Figure 1. A caption';
 const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'s',size:9,fontName:'ABCDEF+SourceSerif'}],blocks:[{id:'p',text:'A body paragraph',source:{pageIndex:0,range:{start:0,end:16},characters:[{start:0,end:16,styleId:'s'}],lines:[]}},{id:'c',text,source:{pageIndex:0,range:{start:16,end:16+text.length},lines:[]}}]};
 const box=[20,200,300,300], flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,span:'column',blockIds:['p'],source:{pageIndex:0,bbox:[20,30,180,190]}},{kind:'asset',span:'page',assetIds:['pic'],blockIds:[],captionIds:['c'],source:{pageIndex:0,bbox:box}},{kind:'caption',blockIds:['c']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="100"></svg>');let checked;
 await composeDocument({document,flow,sourceBytes:src,assets:[{id:'pic',source:{pageIndex:0,bbox:box},content:{representation:'svg',bytes:svg}}]},{fonts:{family:'Noto Serif'},compile:async()=>({bytes:new TextEncoder().encode('%PDF-1.4'),blockSpans:[{id:'pic',start:{page:3,x:36,y:36},end:{page:3,x:36,y:136}}]}),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(checked.layoutProfile.coordinateSpace,'output');assert.equal(checked.layoutProfile.columns,undefined);assert.equal(checked.layoutProfile.captions,undefined);assert.equal(checked.layoutProfile.bodyFontNames,undefined);assert.equal(checked.layoutProfile.bodyFontSize,undefined);assert.deepEqual(checked.layoutProfile.sourceProfile.bodyFontNames,['ABCDEF+SourceSerif']);assert.equal(checked.layoutProfile.sourceProfile.captions[0].assetPageIndex,0);assert.equal(checked.blockSpans[0].start.page,3);
});

test('layout policy is bounded, source-relative and rejects missing evidence',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex'), text='Body paragraph';
 const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'s',size:10}],blocks:[{id:'p',text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:'s'}],lines:[{range:{start:0,end:7},bbox:[0,0,100,10]},{range:{start:7,end:text.length},bbox:[0,12,100,22]}]}}]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,blockIds:['p']}]};let source;
 const compile=async p=>(source=p.source,new TextEncoder().encode('%PDF-1.4'));
 const result=await composeDocument({document,flow,sourceBytes:src,layoutPolicy:{lineHeightScale:1.05,paragraphSpacingEm:0.5,columnGutterEm:1.2}},{compile});
 assert.match(source,/leading: 0\.6825[0-9]*em/);assert.match(source,/spacing: 5pt/);assert.match(source,/gutter: 12pt/);assert.equal(result.layoutPolicy.lineHeightScale,1.05);
 for(const layoutPolicy of [{lineHeightScale:0.5},{fontScale:0.9},{columnGutterEm:3},{paragraphSpacingEm:NaN}]) await assert.rejects(composeDocument({document,flow,sourceBytes:src,layoutPolicy},{compile}),/Invalid layout policy/);
 const noEvidence=structuredClone(document);noEvidence.styles=[];await assert.rejects(composeDocument({document:noEvidence,flow,sourceBytes:src,layoutPolicy:{columnGutterEm:1}},{compile}),/requires source measurements/);
});
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const compilerRoot=process.env.FALSIFY_TYPST_MODULES, wasmPath=process.env.FALSIFY_TYPST_WASM, fontPath=process.env.FALSIFY_TYPST_FONT, python=process.env.FALSIFY_PYMUPDF_PYTHON;
test('compiled title and body have no interline ink overlap', {skip:!(compilerRoot && wasmPath && fontPath && python)},async()=>{
 const {createTypstCompiler,createTypstFontBuilder}=await import(pathToFileURL(join(compilerRoot,'@myriaddreamin/typst.ts/dist/esm/compiler.mjs')));
 const {loadFonts}=await import(pathToFileURL(join(compilerRoot,'@myriaddreamin/typst.ts/dist/esm/options.init.mjs')));
 const {createTypstCompile}=await import('../src/paper-typst.mjs');
 const wasm=await readFile(wasmPath), font=await readFile(fontPath), compile=createTypstCompile({createTypstCompiler,createTypstFontBuilder,loadFonts,getModule:()=>wasm});
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex');
 const title='Reversible epiblast regionalization determines differentiation potential of human pluripotent stem cells', body='The evidence-based scientific paragraph describes measurements and experimental observations without changing any source content. '.repeat(14);
 const make=(id,text,style,start)=>({id,text,source:{pageIndex:0,range:{start,end:start+text.length},characters:[{start,end:start+text.length,styleId:style}],lines:[]}});
 const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'title',size:26,fontName:'Serif Bold'},{id:'body',size:10,fontName:'Serif'}],blocks:[make('title',title,'title',0),make('body',body,'body',title.length)]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'heading',span:'page',blockIds:['title']},{kind:'paragraph',columns:2,span:'column',blockIds:['body']}]};
 const out=await composeDocument({document,flow,sourceBytes:src},{compile,fonts:{family:'Noto Serif',candidates:[{family:'Noto Serif',getBytes:()=>font}]}});
 const temp=await mkdtemp(join(tmpdir(),'falsify-ink-'));try {
  const path=join(temp,'proof.pdf');await writeFile(path,new Uint8Array(await out.file.arrayBuffer()));
  const script=String.raw`import pymupdf,sys
doc=pymupdf.open(sys.argv[1]); p=doc[0]
assert sum(page.get_text().count('-') for page in doc)==14, 'automatic hyphen changed literal content'
log=p.get_bboxlog()
for target in (26,10):
 spans=[t for t in p.get_texttrace() if abs(t['size']-target)<.1 and t['type']==0 and len(t['chars'])>4]
 assert len(spans)>=2, (target,len(spans))
 boxes=[log[t['seqno']][1] for t in spans]
 for i,a in enumerate(boxes):
  for b in boxes[i+1:]:
   if abs(a[1]-b[1])<1: continue
   assert min(a[2],b[2])-max(a[0],b[0])<=0 or min(a[3],b[3])-max(a[1],b[1])<=0, (target,a,b)
print('title and body paint bounds: no interline overlap')`;
  const run=spawnSync(python,['-c',script,path],{encoding:'utf8'});assert.equal(run.status,0,run.stderr || run.stdout);
 } finally {await rm(temp,{recursive:true,force:true});}
});

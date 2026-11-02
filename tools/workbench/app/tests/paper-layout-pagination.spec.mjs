import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as mupdf from 'mupdf';
import {createLatexProject} from '../src/latex-project.mjs';
import {createReconstructionProject} from '../src/pdf-latex-baseline.mjs';
import {readLayoutStructure,renderStructureRegion} from '../src/paper-layout-structure.mjs';
import {normalizeLayoutAction} from '../src/paper-layout-tool-catalog.mjs';
import {inspectLayoutDocument,getLayoutBlock} from '../src/paper-layout-document-tools.mjs';
import {createLayoutToolHandlers} from '../src/paper-layout-toolbox.mjs';
import {readLayoutReference} from '../src/paper-layout-reference.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';

const enc=new TextEncoder(),dec=new TextDecoder(),hash='b'.repeat(64);
const profile={schema:'falsify.paper-typography.v1',page:{widthBp:300,heightBp:400,columns:1,gutterBp:20,margins:{left:40,right:40,top:36,bottom:36}},body:{indentEm:1,paragraphGapEm:0},roles:Object.fromEntries(['body','heading','caption','footnote'].map(x=>[x,{sizeBp:10,leadingBp:12}])),fonts:{serif:'Latin Modern Roman'},packages:{}};
const observationBytes=value=>JSON.stringify({status:'ok',observation:value}).length;
const lone=s=>{for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xD800&&c<=0xDBFF){const n=s.charCodeAt(i+1);if(!(n>=0xDC00&&n<=0xDFFF))return true;i++;}else if(c>=0xDC00&&c<=0xDFFF)return true;}return false;};
function artifact(project,text,synctex){const d=new mupdf.PDFDocument(),font=new mupdf.Font('Helvetica');try{const f=d.addSimpleFont(font);d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f}},`BT /F 12 Tf 30 330 Td (${text}) Tj ET`));const b=d.saveToBuffer();try{const bytes=b.asUint8Array().slice();return {schema:'falsify.latex-artifact.v1',success:true,projectId:project.id,engine:project.engine,pdfBytes:bytes,pdfHash:hex(bytes),synctex};}finally{b.destroy();}}finally{font.destroy();d.destroy();}}
const item=(id,text)=>({id,kind:'paragraph',status:'observed',evidence:[{sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox:[40,100,200,110]}],text,extensions:{columns:1,span:'column'}});
async function project(items){const model={schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:300,height:400,frame:'mupdf-display'}],items,assets:[],relations:[],diagnostics:[]};return (await createReconstructionProject({sourceSha256:hash,model},[],{layout:'semantic-flow',profile})).project;}

test('geometry and asset cursors survive catalog normalization and page every hit',async()=>{
 const graphics=Array.from({length:5},(_,i)=>`\\includegraphics{fig-${i}.png}`).join('');
 const built=await project([item('u0','Block 0'),item('u1','Block 1')]);
 const tex=dec.decode(built.files.find(f=>f.path==='main.tex').bytes).replace('Block 0','Block 0 '+graphics);
 const p=await createLatexProject({...built,files:built.files.map(f=>({path:f.path,bytes:f.path==='main.tex'?enc.encode(tex):f.bytes}))});
 readLayoutStructure(p);
 const source=dec.decode(p.files.find(f=>f.path==='main.tex').bytes),line=source.slice(0,source.indexOf('Block 0')).split('\n').length;
 const boxes=Array.from({length:6},()=>`h1,${line}:65536,131072:65536,65536,0`).join('\n');
 const synctex=enc.encode(`Input:1:main.tex\nUnit:1\nMagnification:1000\nContent:\n{1\n${boxes}\n}\nPostamble:\n`),a=artifact(p,'Block 0',synctex);
 const catalog=JSON.parse(readFileSync(new URL('../local/layout-agent-tools.json',import.meta.url),'utf8'));
 const tool=catalog.tools.find(t=>t.name==='get_block');
 assert.equal(tool.parameters.properties.geometryOffset.minimum,0);
 assert.equal(tool.parameters.properties.assetOffset.minimum,0);
 assert.equal(catalog.tools.find(t=>t.name==='read_reference').parameters.properties.offset.minimum,0);
 assert.equal(catalog.actionSchema.properties.args.anyOf.find(s=>s.properties?.geometryOffset).properties.geometryOffset.minimum,0);
 assert.equal(normalizeLayoutAction({tool:'get_block',message:'m',args:{blockId:'u0',geometryOffset:-1}}),null);
 assert.equal(normalizeLayoutAction({tool:'get_block',message:'m',args:{blockId:'u0',assetOffset:-1}}),null);
 assert.equal(normalizeLayoutAction({tool:'read_reference',message:'m',args:{pages:[0],offset:-1}}),null);
 const walk=async(pick,arg)=>{const out=[];for(let cursor=0,guard=0;;){assert.ok(++guard<8);const action=normalizeLayoutAction({tool:'get_block',message:'m',args:{blockId:'u0',[arg]:cursor}});assert.ok(action);const page=pick((await getLayoutBlock({project:p,artifact:a,args:action.args})).block);out.push(...page.items);if(page.nextOffset==null)return out;assert.equal(page.offset,cursor);cursor=page.nextOffset;}};
 const hits=await walk(block=>block.currentGeometry.candidates,'geometryOffset');
 const paths=await walk(block=>block.assetPaths,'assetOffset');
 assert.equal(hits.length,6);
 assert.deepEqual(paths.map(path=>path),['fig-0.png','fig-1.png','fig-2.png','fig-3.png','fig-4.png']);
});

test('quote-heavy and surrogate windows stay inside the observation budget and keep every character',async()=>{
 const quotes='"'.repeat(9000);
 const quoted=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode('\\begin{document}\n'+quotes+'\n\\end{document}')}],mainFile:'main.tex'});
 const qid=(await inspectLayoutDocument({project:quoted,artifact:null})).blocks.items[0].id;
 const quotedParts=[];let qOffset=0,qGuard=0;const qTotal=(await getLayoutBlock({project:quoted,artifact:null,args:{blockId:qid,offset:0,limit:4096}})).block.textPage.total;
 while(qOffset<qTotal){assert.ok(++qGuard<20);const result=await getLayoutBlock({project:quoted,artifact:null,args:{blockId:qid,offset:qOffset,limit:4096}});assert.ok(observationBytes(result)<=12000);assert.equal(lone(result.block.text),false);quotedParts.push(result.block.text);const next=result.block.textPage.nextOffset;assert.ok(next==null||next>qOffset);if(next==null)break;qOffset=next;}
 const joined=quotedParts.join('');
 assert.equal(joined.length,qTotal);
 assert.ok(joined.includes(quotes));
 assert.ok(quotedParts[0].length<4096);
 const emoji=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode('\\begin{document}\n😀hello\n\\end{document}\n')}],mainFile:'main.tex'});
 const eid=(await inspectLayoutDocument({project:emoji,artifact:null})).blocks.items[0].id;
 const full=(await getLayoutBlock({project:emoji,artifact:null,args:{blockId:eid,limit:4096}})).block;
 for(let offset=0;offset<full.text.length;offset++){const part=(await getLayoutBlock({project:emoji,artifact:null,args:{blockId:eid,offset,limit:1}})).block.text;assert.equal(lone(part),false);}
 let built='',offset=0,guard=0;while(offset<full.textPage.total){assert.ok(++guard<full.textPage.total+2);const block=(await getLayoutBlock({project:emoji,artifact:null,args:{blockId:eid,offset,limit:1}})).block;assert.equal(lone(block.text),false);built+=block.text;const next=block.textPage.nextOffset;if(next==null)break;assert.ok(next>offset);offset=next;}
 assert.equal(built,full.text);
});

test('legacy offset, explicit cursors, end of page and invalid metadata stay deterministic',async()=>{
 const bytes=Uint8Array.of(9,8,7),sourcePdfHash=hex(bytes),body='ABCDEFGHIJ'.repeat(150);
 const units=['u0','u1','u2'].map(id=>({id,pageIndex:0,bbox:[1,2,3,4],kind:'paragraph',role:'body',span:'column'}));
 const structure={units,groups:[],plan:{order:units.map(u=>u.id),frontMatter:[],furniture:[],columns:1}};
 const loadPdf=async()=>({getDocument:()=>({promise:Promise.resolve({numPages:2,getPage:async n=>({getTextContent:async()=>({items:[{str:n===1?body:'SECOND-PAGE'}]}),getViewport:()=>({width:300,height:400})})}),destroy:async()=>{}})});
 const base={bytes,sourcePdfHash,structure,loadPdf,baseUrl:new URL('https://example.test/')};
 const mixed=(await readLayoutReference({...base,pages:[0],offset:1,textOffset:0})).pages[0];
 assert.equal(mixed.text.startsWith('ABCDE'),true);
 assert.deepEqual(mixed.units.map(u=>u.id),['u0','u1','u2']);
 assert.equal(mixed.unitOffset,0);
 assert.equal(mixed.unitsTruncated,false);
 const many=Array.from({length:25},(_,i)=>({id:'m'+i,pageIndex:0,bbox:[1,2,3,4],kind:'paragraph',role:'body',span:'column'}));
 const legacy=(await readLayoutReference({...base,structure:{units:many,groups:[],plan:{order:many.map(u=>u.id),frontMatter:[],furniture:[],columns:1}},pages:[0],offset:1})).pages[0];
 assert.equal(legacy.textOffset,1000);
 assert.equal(legacy.unitOffset,20);
 assert.deepEqual(legacy.units.map(u=>u.id),many.slice(20).map(u=>u.id));
 const clamped=(await readLayoutReference({...base,pages:[0],offset:1})).pages[0];
 assert.equal(clamped.textOffset,1000);
 assert.equal(clamped.text.length,500);
 assert.equal(clamped.unitOffset,units.length);
 assert.deepEqual(clamped.units,[]);
 assert.equal(clamped.unitsTruncated,false);
 const legacyEof=(await readLayoutReference({...base,pages:[0],offset:2})).pages[0];
 assert.equal(legacyEof.text,'');
 assert.equal(legacyEof.textOffset,body.length);
 assert.equal(legacyEof.unitOffset,units.length);
 assert.equal(legacyEof.next,null);
 const textLoad=async()=>({getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[{str:'X'.repeat(3000)}]}),getViewport:()=>({width:300,height:400})})}),destroy:async()=>{}})});
 const textOnlyLegacy=(await readLayoutReference({...base,structure:undefined,loadPdf:textLoad,pages:[0],offset:1})).pages[0];
 assert.equal(textOnlyLegacy.textOffset,1000);
 assert.equal(textOnlyLegacy.text.length,1000);
 const shortUnits=Array.from({length:45},(_,i)=>({id:'u'+i,pageIndex:0,bbox:[1,2,3,4],kind:'paragraph',role:'body',span:'column'}));
 const shortLoad=async()=>({getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[{str:'ABCDEFG'}]}),getViewport:()=>({width:300,height:400})})}),destroy:async()=>{}})});
 const short=(await readLayoutReference({...base,structure:{units:shortUnits,groups:[],plan:{order:shortUnits.map(u=>u.id),frontMatter:[],furniture:[],columns:1}},loadPdf:shortLoad,pages:[0],offset:1})).pages[0];
 assert.equal(short.text,'');
 assert.equal(short.units[0].id,'u20');
 const textOnly=(await readLayoutReference({...base,pages:[0],textOffset:4})).pages[0];
 assert.equal(textOnly.text.startsWith('EFGHIJ'),true);
 assert.equal(textOnly.unitOffset,0);
 const unitOnly=(await readLayoutReference({...base,pages:[0],unitOffset:1})).pages[0];
 assert.equal(unitOnly.textOffset,0);
 assert.deepEqual(unitOnly.units.map(u=>u.id),['u1','u2']);
 const eof=(await readLayoutReference({...base,pages:[0],textOffset:body.length,unitOffset:units.length})).pages[0];
 assert.equal(eof.text,'');
 assert.equal(eof.textTruncated,false);
 assert.equal(eof.unitsTruncated,false);
 assert.equal(eof.next,null);
 await assert.rejects(readLayoutReference({...base,pages:[0],textOffset:1000000000}),/페이지 길이/);
 let got='',next={pages:[0],textOffset:0,unitOffset:0},guard=0;while(next){assert.ok(++guard<20);const page=(await readLayoutReference({...base,...next})).pages[0];got+=page.text;next=page.next;}
 assert.equal(got,body);
 const second=(await readLayoutReference({...base,pages:[1]})).pages[0];
 assert.equal(second.text,'SECOND-PAGE');
 assert.equal(second.next,null);
 const huge={...structure,units:[{id:'u0',pageIndex:0,bbox:Array.from({length:4000},(_,i)=>i),kind:'paragraph',role:'body',span:'S'.repeat(8000)}]};
 const bounded=(await readLayoutReference({...base,structure:huge,pages:[0],textOffset:0,unitOffset:0})).pages[0];
 assert.ok(JSON.stringify({status:'ok',reference:{pages:[bounded]}}).length<=12000);
 assert.equal(bounded.text.includes('ABCDE'),true);
 assert.equal(bounded.units[0].id,'u0');
 assert.equal(bounded.units[0].metadataStatus,'invalid');
 assert.equal(JSON.stringify(bounded).includes('S'.repeat(80)),false);
});

test('imported unit metadata is rejected and a single oversized item stays bounded',async()=>{
 const built=await project([item('kept','Kept'),item('next','Next')]);
 const parsed=JSON.parse(dec.decode(built.files.find(f=>f.path==='falsify-layout-structure.json').bytes));
 const bad=structuredClone(parsed);bad.units[0].span='S'.repeat(8000);bad.units[0].bbox=Array.from({length:4000},(_,i)=>i);
 const patched=await createLatexProject({...built,files:built.files.map(f=>({path:f.path,bytes:f.path==='falsify-layout-structure.json'?enc.encode(JSON.stringify(bad)):f.bytes}))});
 assert.throws(()=>readLayoutStructure(patched),{code:'INVALID_STRUCTURE'});
 const ok=structuredClone(parsed);ok.units[0].span='page';assert.equal(readLayoutStructure(await createLatexProject({...built,files:built.files.map(f=>({path:f.path,bytes:f.path==='falsify-layout-structure.json'?enc.encode(JSON.stringify(ok)):f.bytes}))})).units[0].span,'page');
 const legacyUnits=[{id:'header0',pageIndex:0,pageHeight:800,bbox:[40,20,180,30],kind:'furniture'},{id:'body',pageIndex:0,pageHeight:800,bbox:[40,70,550,700],kind:'paragraph'}];
 const plan={schema:'falsify.paper-layout-plan.v1',sourcePdfHash:hash,order:legacyUnits.map(u=>u.id),frontMatter:[],furniture:[{id:'header0',placement:'header'}],columns:1};
 renderStructureRegion({schema:'falsify.paper-layout-structure.v1',sourcePdfHash:hash,units:legacyUnits,groups:[],plan},plan,new Map([['header0','Journal\\par\n'],['body','Evidence 63\\par\n']]));
 await assert.rejects(()=>project([item('X'.repeat(6000),'Wide'),item('tail','Tail')]),{code:'INVALID_STRUCTURE'});
 await assert.rejects(()=>project([item('h'.repeat(65),'Over'),item('tail','Tail')]),{code:'INVALID_STRUCTURE'});
 const generated='item-'+'a'.repeat(24),hashId='h'.repeat(64);
 const normal=await project([item(generated,'Kept'),item(hashId,'Hash'),item('tail','Tail')]);
 assert.deepEqual(readLayoutStructure(normal).units.map(u=>u.id),[generated,hashId,'tail']);
 const normalObs=await inspectLayoutDocument({project:normal,artifact:null,args:{limit:20}});
 assert.ok(observationBytes(normalObs)<=12000);
 assert.equal(normalObs.blocks.items.some(i=>i.id===generated),true);
 assert.equal(normalObs.blocks.items.some(i=>i.id===hashId),true);
 assert.equal(normalObs.blocks.items.some(i=>i.id==='tail'),true);
});

test('registered get_block observation stays inside the handler budget and keeps every quote',async()=>{
 const quotes='"'.repeat(9000);
 const quoted=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\n\\begin{document}\n'+quotes+'\n\\end{document}\n')}]});
 const handlers=createLayoutToolHandlers({project:quoted});
 const id=(await handlers.inspect_document({project:quoted,args:{}})).observation.blocks.items[0].id;
 for(const offset of [0,1,2000,3000]){const result=await handlers.get_block({project:quoted,args:{blockId:id,offset,limit:4096}});assert.ok(JSON.stringify({status:'ok',...result}).length<=12000);}
 let offset=0,text='',guard=0;
 while(offset!==null){assert.ok(++guard<40);const result=await handlers.get_block({project:quoted,args:{blockId:id,offset,limit:4096}});assert.ok(JSON.stringify({status:'ok',...result}).length<=12000);text+=result.observation.block.text;const next=result.observation.block.textPage.nextOffset;if(next==null)break;assert.ok(next>offset);offset=next;}
 assert.equal((text.match(/"/g)||[]).length,9000);
});

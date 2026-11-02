import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {prepareReconstruction,createReconstructionProject,compareReconstruction,createReconstructionLineage} from '../src/pdf-latex-baseline.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {encodeSourceSession,decodeSourceSession} from '../src/latex-session-archive.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';

const dir=await mkdtemp(join(tmpdir(),'falsify-workbench-'));
const bundle=await build({entryPoints:[new URL('../src/latex-workbench.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,format:'esm',platform:'node',write:false,external:['./vendor/pdf.mjs'],plugins:[{name:'native-mupdf',setup(b){b.onResolve({filter:/^mupdf$/},()=>({path:import.meta.resolve('mupdf'),external:true}));}}]});
const file=join(dir,'workbench.mjs');await writeFile(file,bundle.outputFiles[0].contents);
const workbench=await import(pathToFileURL(file));
const {proposalTransaction}=workbench;
test('reconstruction archive preserves compared baseline bytes and concrete lineage without compiling',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url))),sourceUpload={name:'synthetic.pdf',bytes,sha256:hex(bytes)};
  const draft=await prepareReconstruction({file:new File([bytes],sourceUpload.name,{type:'application/pdf'})}),prepared=await createReconstructionProject(draft);
  // Synthetic artifact for codec identity only; browser tests compile the emitted source.
  const baseline={schema:'falsify.latex-artifact.v1',success:true,engine:'pdflatex',engineManifest:{name:'test-only'},projectId:prepared.project.id,pdfBytes:bytes,pdfHash:hex(bytes),synctex:Uint8Array.of(31,139,1)};
  const comparison=compareReconstruction(draft.evidence.document,draft.evidence.document),reconstruction=createReconstructionLineage({project:prepared.project,artifact:baseline,comparison,bindings:prepared.bindings,decisions:[]});
  const archive=await encodeSourceSession({project:prepared.project,changes:[],baseline,reconstruction,sourceUpload},{createLatexProject}),restored=await decodeSourceSession(archive,{createLatexProject});
  assert.deepEqual(restored.baseline.pdfBytes,bytes);assert.deepEqual(restored.baseline.synctex,baseline.synctex);assert.equal(restored.baseline.projectId,prepared.project.id);
  assert.deepEqual(workbench.validateRestoredReconstruction(restored),reconstruction);
  const stale=structuredClone(restored);stale.sourceUpload.bytes[0]^=1;assert.throws(()=>workbench.validateRestoredReconstruction(stale));
  const wrong=structuredClone(restored);wrong.baseline.projectId='0'.repeat(64);assert.throws(()=>workbench.validateRestoredReconstruction(wrong));
  const newProject=await createLatexProject({...prepared.project,files:[...prepared.project.files,{path:'extra.txt',bytes:new TextEncoder().encode('new file')}]}),pending={schema:'falsify.reconstruction-pending.v1',sourcePdfHash:prepared.project.sourcePdfHash,reason:'files-added',previous:reconstruction,previousProject:workbench.reconstructionDescriptor(prepared.project)};
  const pendingArchive=await encodeSourceSession({project:newProject,changes:[],baseline,reconstruction:pending,sourceUpload},{createLatexProject}),pendingRestored=await decodeSourceSession(pendingArchive,{createLatexProject});
  assert.equal(workbench.validateRestoredReconstruction(pendingRestored).schema,'falsify.reconstruction-pending.v1');
  const lost=structuredClone(pendingRestored);lost.reconstruction=null;assert.throws(()=>workbench.validateRestoredReconstruction(lost));
  const changedPrior=structuredClone(pendingRestored);changedPrior.reconstruction.previousProject.files[0].sha256='0'.repeat(64);assert.throws(()=>workbench.validateRestoredReconstruction(changedPrior));
});
process.on('exit',()=>{void rm(dir,{recursive:true,force:true});});
const anchor=(start,end)=>({projectId:'p',nodeId:'n',path:'main.tex',kind:'text',start,end});
const part=(start,end)=>({anchor:anchor(start,end),before:'old',after:'new',kind:'text'});
test('multi-part proposals are one transaction and disable entire competing groups',()=>{
  const old=[{...part(1,3),id:'old:0',proposalId:'old',enabled:true},{...part(8,10),id:'old:1',proposalId:'old',enabled:true}];
  const next=proposalTransaction(old,{id:'new',sourceChanges:[part(2,4),part(12,14)]},true,'p');
  assert.deepEqual(next.map(x=>x.enabled),[false,false,true,true]);
  assert.deepEqual(next.slice(2).map(x=>x.id),['new:0','new:1']);
  assert.equal(old[0].enabled,true);
  assert.deepEqual(proposalTransaction(next,{id:'new',sourceChanges:[part(2,4),part(12,14)]},false,'p').slice(2).map(x=>x.enabled),[false,false]);
});
test('invalid and overlapping primitives fail without modifying input',()=>{
  const previous=[{...part(1,3),id:'existing',enabled:true}];
  assert.throws(()=>proposalTransaction(previous,{id:'x',sourceChanges:[part(2,5),part(4,6)]},true,'p'));
  assert.throws(()=>proposalTransaction(previous,{id:'x',sourceChanges:[part(5,6),{...part(7,8),anchor:{...anchor(7,8),projectId:'other'}}]},true,'p'));
  assert.equal(previous[0].enabled,true);
});

test('source editor restores history without overwriting focused typing and labels citations',async()=>{
  const {createLatexSourceEditor}=await import('../dist/latex-source-ui.js');
  class Element {
    constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.value='';this.textContent='';}
    setAttribute(k,v){this.attributes[k]=v;if(k==='value')this.value=v;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
    fire(k){for(const f of this.listeners[k]||[])f({target:this});}
    querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
    remove(){}
  }
  const doc={activeElement:null,createElement(tag){return new Element(tag,this);}};
  let savedLast=0;const container=new Element('div',doc),editor=createLatexSourceEditor({container,onDownloadLast:()=>savedLast++});
  const section=container.children[0], edit=section.querySelectorAll('textarea')[0];
  const n={id:'n',kind:'citation',text:'example',displayText:'',sourceText:'\\cite{example}'};
  editor.setState({model:{nodes:[n]},changes:[],selection:{nodeId:'n'}});
  assert.equal(edit.value,'example');
  assert.ok(section.querySelectorAll('button').some(b=>b.textContent.includes('\\cite{example}')));
  editor.setState({changes:[{anchor:{nodeId:'n'},after:'other',enabled:true}]});assert.equal(edit.value,'other');
  doc.activeElement=edit;edit.value='in progress';edit.fire('input');editor.setState({changes:[]});assert.equal(edit.value,'in progress');
  doc.activeElement=null;edit.fire('blur');editor.setState({changes:[]});assert.equal(edit.value,'example');
  const lastDownload=section.querySelectorAll('button').find(b=>b.textContent==='마지막 생성 PDF 다운로드');
  editor.setState({artifact:null,lastArtifact:{success:true},diagnostics:[{message:'compile failed'}]});
  assert.equal(lastDownload.hidden,false);lastDownload.fire('click');assert.equal(savedLast,1);
  assert.equal(section.querySelectorAll('button').find(b=>b.textContent==='BLUE로 보내기').disabled,true);
  editor.setState({artifact:{success:true}});assert.equal(lastDownload.hidden,true);
  editor.setState({artifact:null,lastArtifact:null});assert.equal(lastDownload.hidden,true);

});

test('source line selection includes nodes on the mapped line only',()=>{
  const {sourceNodesAtLine}=workbench;
  const project={files:[{path:'body.tex',bytes:new TextEncoder().encode('first\nsecond\nthird')}]};
  const model={nodes:[{id:'first',path:'body.tex',start:0,end:5},{id:'second',path:'body.tex',start:6,end:12},{id:'third',path:'body.tex',start:13,end:18}]};
  assert.deepEqual(sourceNodesAtLine(project,model,'body.tex',2).map(n=>n.id),['second']);
});


test('PDF click coordinates and bounded nearest boxes',()=>{
  const point=workbench.pdfClickPoint({left:0,top:0,width:510,height:660},{width:735,height:951},172,220);
  assert.ok(Math.abs(point.x-206.57)<0.1); assert.ok(Math.abs(point.y-264.17)<0.1);
  const map={boxes:[{pageIndex:0,path:'body.tex',line:2,box:{x:201.4,y:262.1,width:8.44,height:4.49}}]};
  assert.equal(workbench.pickSourceLines(map,{pageIndex:0,...point})[0].line,2);
  assert.equal(workbench.pickSourceLines(map,{pageIndex:0,x:400,y:400}).length,0);
});

test('restore validates disabled anchors using the real patch engine',async()=>{
  const {createLatexProject}=await import('../src/latex-project.mjs');
  const {analyzeLatexSource}=await import('../src/latex-source-model.mjs');
  const p=await createLatexProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('Hello world')}]});
  const n=analyzeLatexSource(p).nodes[0],c={id:'one',kind:n.kind,before:n.text,after:'Hi',enabled:false,anchor:{projectId:p.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.contentStart,end:n.contentEnd}};
  await workbench.validateRestoredChanges(p,[c]);
  await assert.rejects(workbench.validateRestoredChanges(p,[{...c,anchor:{...c.anchor,nodeId:'unknown'}}]));
});


test('real archive roundtrip preserves source upload and explicit raw item provenance',async()=>{
  const {createLatexProject}=await import('../src/latex-project.mjs');
  const {encodeSourceSession,decodeSourceSession,projectLegacyExternal}=await import('../src/latex-session-archive.mjs');
  const {hex}=await import('../src/paragraph-pdf-crypto.mjs');
  const bytes=new TextEncoder().encode('Hello world'),p=await createLatexProject({files:[{path:'main.tex',bytes}],mainFile:'main.tex'}),h=hex(bytes);
  const batch={schema:'falsify.external-batch.v1',id:'batch',fileHash:h,role:'red',raw:'response',items:[{id:'raw',before:'Hello',after:'Hi'}]};
  const responses={schema:'falsify.latex-responses.v1',projectId:p.id,batches:[batch],proposals:[{id:'random:0:raw',before:'Hello',after:'Hi',provenance:{responseId:'batch',itemId:'raw'}}],changes:[]};
  const json=await encodeSourceSession({project:p,changes:[],responses,sourceUpload:{name:'main.tex',bytes,sha256:h}},{createLatexProject});
  const restored=await decodeSourceSession(json,{createLatexProject}); assert.deepEqual(restored.sourceUpload.bytes,bytes);
  const snapshot=projectLegacyExternal({fileHash:h,project:p,responses:restored.responses,segments:[{id:'main.tex',text:'Hello world'}]});
  assert.equal(snapshot.items[0].sourceRefs[0].itemId,'raw');
});

test('adding an asset rebinds verified ranges to the new project and preserves conflicts',async()=>{
  const {createLatexProject}=await import('../src/latex-project.mjs');
  const {analyzeLatexSource}=await import('../src/latex-source-model.mjs');
  const bytes=new TextEncoder().encode('Hello world');
  const old=await createLatexProject({files:[{path:'nested/main.tex',bytes}],mainFile:'nested/main.tex'});
  const n=analyzeLatexSource(old).nodes[0];
  const c={id:'one',kind:n.kind,before:n.text,after:'Hi',anchor:{projectId:old.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.contentStart,end:n.contentEnd}};
  const next=await createLatexProject({...old,files:[...old.files,{path:'nested/image.png',bytes:new Uint8Array([1,2])}]});
  const [rebound,conflict]=await workbench.rebindChanges(old,next,[c,{...c,id:'bad',anchor:{...c.anchor,nodeId:'missing'}}]);
  assert.equal(rebound.anchor.projectId,next.id);assert.equal(rebound.enabled,undefined);
  assert.equal(conflict.enabled,false);assert.ok(conflict.rebindDiagnostic);assert.equal(conflict.before,c.before);
  await workbench.validateRestoredChanges(next,[rebound,conflict]);
  const {encodeSourceSession,decodeSourceSession}=await import('../src/latex-session-archive.mjs');
  const changes=[rebound,conflict],responses={schema:'falsify.latex-responses.v1',projectId:next.id,batches:[],proposals:[],changes};
  const saved=await encodeSourceSession({project:next,changes,responses},{createLatexProject});
  assert.equal((await decodeSourceSession(saved,{createLatexProject})).changes[1].rebindDiagnostic,conflict.rebindDiagnostic);
});
test('source highlights use complete proposal context and displayed manual text',()=>{
  const changes=[{id:'p:0',proposalId:'p',enabled:true},{id:'p:1',proposalId:'p',enabled:true},{id:'m',anchor:{nodeId:'n'},before:'\\cite{x}',after:'63'}];
  assert.deepEqual(workbench.highlightEdits(changes,[{id:'p',before:'Claim62 works',after:'Claim63 holds'}],{nodes:[{id:'n',displayText:'62'}]}),[{id:'p',before:'Claim62 works',after:'Claim63 holds'},{id:'m',before:'62',after:'63'}]);
  changes[1].enabled=false;assert.equal(workbench.highlightEdits(changes,[{id:'p',before:'a',after:'b'}],{nodes:[]}).length,1);
});
test('PDF item separator joins touching superscript runs but preserves spaces and line breaks',()=>{
  const item={transform:[10,0,0,10,50,100],width:25};
  assert.equal(workbench.pdfItemSeparator(item,{transform:[7,0,0,7,75,103]}),'');
  assert.equal(workbench.pdfItemSeparator(item,{transform:[10,0,0,10,79,100]}),' ');
});

test('real PDF.js text runs paint precise changed ranges and reject repeated quotes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {createRequire}=await import('node:module');
  const marks=createRequire(import.meta.url)('../dist/paper-change-marks.js');
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url)));
  const document=await pdfjs.getDocument({data:bytes}).promise;
  const items=(await (await document.getPage(1)).getTextContent()).items;
  const before='An initial claim62 remains conditional.',after='An altered claim63 remains provisional.';
  const edits=[{id:'edit',before,after}];
  const hits=marks.ranges(items,edits,'before',workbench.pdfItemSeparator);
  assert.deepEqual(hits.missing,[]);
  assert.deepEqual(hits.found.filter(h=>items[h.itemIndex].str.trim()).map(h=>[items[h.itemIndex].str.slice(h.start,h.end),h.itemIndex]),[['initial claim',8],['62',9],['remains condit',11]]);
  // Preserve PDF.js geometry and explicit whitespace while simulating the revised runs.
  const revised=items.map((item,i)=>({...item,str:i===8?'An altered claim':i===9?'63':i===11?item.str.replace('conditional','provisional'):item.str}));
  const afterHits=marks.ranges(revised,edits,'after',workbench.pdfItemSeparator);
  assert.deepEqual(afterHits.missing,[]);
  assert.deepEqual(afterHits.found.filter(h=>revised[h.itemIndex].str.trim()).map(h=>revised[h.itemIndex].str.slice(h.start,h.end)),['altered claim','63','remains provis']);
  const duplicate=marks.ranges([...items,...items],edits,'before',workbench.pdfItemSeparator);
  assert.deepEqual(duplicate.found,[]);assert.deepEqual(duplicate.missing,['edit']);
  const painted=[];
  const divs=items.filter(i=>typeof i.str==='string').map(i=>({dataset:{},firstChild:{nodeType:3,textContent:i.str}}));
  const doc={createElement(){return {style:{},dataset:{},setAttribute(){},append(el){painted.push(el);}};},createRange(){let node,start,end;return {setStart(n,p){node=n;start=p;},setEnd(n,p){assert.equal(n,node);end=p;},getClientRects(){return [{left:start,top:2,right:end,width:end-start,height:10}];}};}};
  const container={append(){},getBoundingClientRect(){return {left:0,top:0};}};
  const result=marks.paintPage({document:doc,container,items,divs,edits,side:'before',separator:workbench.pdfItemSeparator});
  assert.ok(result.count>=3);assert.ok(painted.every(el=>el.dataset.edit==='edit'));
  await document.cleanup();
});

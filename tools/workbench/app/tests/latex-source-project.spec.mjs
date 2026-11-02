import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLatexProject,importLatexProject,exportLatexProject,analyzeProjectFiles} from '../src/latex-project.mjs';
import {analyzeLatexSource,locateSourceText} from '../src/latex-source-model.mjs';
import {applySourceChanges} from '../src/latex-source-patches.mjs';
const enc=new TextEncoder(),dec=new TextDecoder();
test('graphics macro parameters are unresolved references, not missing filenames',async()=>{
 const p=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\n\\newcommand{\\picture}[1]{\\includegraphics{#1}}\n\\begin{document}Text.\\end{document}')}]});
 const result=analyzeProjectFiles(p);assert.deepEqual(result.missingFiles,[]);assert.ok(result.diagnostics.some(d=>d.code==='UNRESOLVED_REFERENCE'&&d.reference==='#1'));
});
async function fixture(){const root=new URL('./fixtures/latex-source/project/',import.meta.url);return createLatexProject({mainFile:'main.tex',files:await Promise.all(['main.tex','sections/body.tex','refs.bib','figure.png'].map(async path=>({path,bytes:await readFile(new URL(path,root))})))});}
test('fixture ZIP roundtrip retains content and identity',async()=>{const p=await fixture(),zip=await exportLatexProject(p),q=await importLatexProject({name:'project.zip',arrayBuffer:async()=>zip});assert.equal(q.id,p.id);assert.deepEqual(q.files,p.files);assert.deepEqual(analyzeProjectFiles(q).missingFiles,[]);});
test('ambiguous main and missing dependencies are diagnosed',async()=>{let f=s=>enc.encode(s);const p=await createLatexProject({files:[{path:'a.tex',bytes:f('\\documentclass{a}\\begin{document}\\input{missing}\\end{document}')},{path:'b.tex',bytes:f('\\documentclass{a}\\begin{document}\\end{document}')}]});let a=analyzeProjectFiles(p);assert.equal(a.mainCandidates.length,2);assert.equal(a.missingFiles.length,1);assert.ok(a.diagnostics.some(x=>x.code==='AMBIGUOUS_MAIN'));});
test('source spans and immutable escaped patches',async()=>{let p=await fixture(),m=analyzeLatexSource(p);for(const kind of ['superscript','subscript','math','footnote','citation'])assert.ok(m.nodes.some(n=>n.kind===kind),kind);let found=locateSourceText(p,{before:'Following evidence stays readable'});assert.equal(found.status,'matched');let c={id:'one',enabled:true,kind:'text',mode:'content',before:found.candidates[0].before,after:'A & B_2',anchor:found.candidates[0].anchor};let r=await applySourceChanges(p,[c]);assert.deepEqual(r.diagnostics,[]);let old=dec.decode(p.files.find(f=>f.path==='sections/body.tex').bytes),updated=dec.decode(r.project.files.find(f=>f.path==='sections/body.tex').bytes);assert.ok(updated.includes('A \\& B\\_2'));assert.ok(old.includes(c.before));assert.equal(r.project.revision,1);assert.equal((await applySourceChanges(r.project,[c])).diagnostics[0].code,'STALE_ANCHOR');assert.equal((await applySourceChanges(p,[c,{...c,id:'two'}])).diagnostics[0].code,'OVERLAPPING_CHANGES');});
test('UTF-16 offsets, comments and nested syntax',async()=>{let source='😀 café before % secret\n\\footnote{nested \\emph{word}} after';let p=await createLatexProject({files:[{path:'x.tex',bytes:enc.encode(source)}]});let m=analyzeLatexSource(p);assert.equal(m.nodes.some(n=>n.text.includes('secret')),false);let foot=m.nodes.find(n=>n.kind==='footnote');assert.equal(source.slice(foot.start,foot.end),foot.sourceText);assert.equal(foot.text,'nested \\emph{word}');let x=locateSourceText(p,{before:'café before'}).candidates[0];assert.equal(source.slice(x.anchor.start,x.anchor.end),'café before');});
test('BOM and raw policy patch preserve untouched bytes',async()=>{let bytes=Uint8Array.from([0xef,0xbb,0xbf,...enc.encode('😀 Before \\textsuperscript{62} after')]);let p=await createLatexProject({files:[{path:'x.tex',bytes}]});let node=analyzeLatexSource(p).nodes.find(n=>n.kind==='superscript');let anchor={projectId:p.id,nodeId:node.id,path:node.path,kind:node.kind,start:node.start,end:node.end};let change={id:'policy',enabled:true,kind:node.kind,mode:'display-override',before:node.sourceText,after:'63',afterSource:'\\textsuperscript{63}',anchor};let r=await applySourceChanges(p,[change]);assert.deepEqual(r.diagnostics,[]);assert.deepEqual([...r.project.files[0].bytes.slice(0,3)],[0xef,0xbb,0xbf]);assert.equal(dec.decode(r.project.files[0].bytes),'😀 Before \\textsuperscript{63} after');assert.deepEqual([...p.files[0].bytes],[...bytes]);});
test('nested source range and mutated baseline refuse changes',async()=>{let p=await createLatexProject({files:[{path:'x.tex',bytes:enc.encode('\\footnote{nested \\emph{word}}')}]});let n=analyzeLatexSource(p).nodes.find(n=>n.kind==='footnote');let c={id:'n',enabled:true,kind:n.kind,mode:'content',before:n.text,after:'plain',anchor:{projectId:p.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.contentStart,end:n.contentEnd}};assert.equal((await applySourceChanges(p,[c])).diagnostics[0].code,'STRUCTURED_RANGE');p.files[0].bytes[0]=65;assert.equal((await applySourceChanges(p,[c])).diagnostics[0].code,'STALE_PROJECT');});
test('document display map narrows a sentence edit to the superscript content',async()=>{let p=await fixture();let doc=analyzeLatexSource(p).documents.find(d=>d.path==='sections/body.tex');let sentence='An initial claim62 remains conditional.';let at=doc.displayText.indexOf(sentence);assert.ok(at>=0);let offset=at+sentence.indexOf('62'),first=doc.displayMap[offset],last=doc.displayMap[offset+1];assert.equal(first.kind,'superscript');assert.equal(first.nodeId,last.nodeId);let n=analyzeLatexSource(p).nodes.find(x=>x.id===first.nodeId);let c={id:'sup',enabled:true,kind:n.kind,mode:'content',before:'62',after:'63',anchor:{projectId:p.id,nodeId:n.id,path:n.path,kind:n.kind,start:first.start,end:last.end}};let r=await applySourceChanges(p,[c]);assert.deepEqual(r.diagnostics,[]);assert.ok(dec.decode(r.project.files.find(f=>f.path===n.path).bytes).includes('claim\\textsuperscript{63} remains'));});
test('preamble and control arguments never become document display text',async()=>{const source='\\documentclass[12pt]{article}\n\\usepackage{hiddenpkg}\n\\newcommand{\\x}{preamble secret}\n\\begin{document}\n\\section{A \\emph{nested title}} Body \\label{secret-label} \\ref{secret-ref} \\includegraphics[width=1cm]{secret.png} \\input{secret/path} \\mystery{unknown content} \\cite[see]{paper-key} % comment secret\nEnd\\end{document}';const p=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode(source)},{path:'section.tex',bytes:enc.encode('Included \\textbf{body}')}]});const m=analyzeLatexSource(p),doc=m.documents.find(d=>d.path==='main.tex');for(const secret of ['article','hiddenpkg','preamble secret','secret-label','secret-ref','secret.png','secret/path','unknown content','paper-key','comment secret'])assert.ok(!doc.displayText.includes(secret),secret);assert.ok(doc.displayText.includes('nested title'));assert.ok(doc.displayText.includes('Body'));assert.ok(m.documents.find(d=>d.path==='section.tex').displayText.includes('body'));const citation=m.nodes.find(n=>n.kind==='citation');assert.equal(citation.text,'paper-key');assert.equal(citation.displayText,'');assert.equal(citation.displayStatus,'unresolved');assert.equal(dec.decode(p.files.find(f=>f.path==='main.tex').bytes),source);});
test('zero-width insertions are bounded and rejected batches are atomic',async()=>{const p=await createLatexProject({files:[{path:'x.tex',bytes:enc.encode('Hello world')}]});const n=analyzeLatexSource(p).nodes[0];const anchor={projectId:p.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.contentStart,end:n.contentStart};const c={id:'insert',kind:n.kind,before:'',after:'New ',anchor};let r=await applySourceChanges(p,[c]);assert.deepEqual(r.diagnostics,[]);assert.equal(dec.decode(r.project.files[0].bytes),'New Hello world');r=await applySourceChanges(p,[c,{...c,id:'bad',anchor:{...anchor,start:1,end:1}}]);assert.equal(r.project,p);assert.deepEqual(r.applied,[]);assert.equal(r.diagnostics[0].code,'STALE_RANGE');r=await applySourceChanges(p,[c,{...c,id:'duplicate'}]);assert.equal(r.project,p);assert.equal(r.diagnostics[0].code,'OVERLAPPING_CHANGES');});
test('environment options after whitespace are not displayed or editable',async()=>{
 const source='\\begin{document}\\begin{figure} [ht] \\caption{Visible}\\end{figure}\\begin{itemize}[label=x]\\item Entry\\end{itemize}\\end{document}';
 const p=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode(source)}]});
 const text=analyzeLatexSource(p).documents[0].displayText;
 assert.ok(text.includes('Visible')); assert.ok(text.includes('Entry'));
 assert.ok(!text.includes('[ht]')); assert.ok(!text.includes('label=x'));
});
test('dependent assets retain bytes across source edits and ZIP roundtrip',async()=>{
 const files=[{path:'nested/main.tex',bytes:enc.encode('\\documentclass{article}\\begin{document}Hello\\end{document}')},...['refs.bib','refs.bbl','custom.sty','custom.cls','image.png'].map((name,i)=>({path:'nested/'+name,bytes:new Uint8Array([0,255,i,128])}))];
 const p=await createLatexProject({files,mainFile:'nested/main.tex'}); const hit=locateSourceText(p,{before:'Hello'}).candidates[0];
 const r=await applySourceChanges(p,[{id:'edit',kind:'text',before:hit.before,after:'World',anchor:hit.anchor}]);
 assert.deepEqual(r.diagnostics,[]); const zip=await exportLatexProject(r.project);const q=await importLatexProject({name:'p.zip',arrayBuffer:async()=>zip,mainFile:'nested/main.tex'});
 for(const file of files.slice(1))assert.deepEqual(q.files.find(f=>f.path===file.path).bytes,file.bytes);
});
test('explicit math policy preserves raw superscript and subscript syntax',async()=>{
 const p=await createLatexProject({files:[{path:'x.tex',bytes:enc.encode('$x^{2}_{3}$')}]});
 const n=analyzeLatexSource(p).nodes.find(n=>n.kind==='math');
 const c={id:'math',kind:'math',mode:'display-override',before:n.sourceText,after:'x^4_5',afterSource:'$x^{4}_{5}$',anchor:{projectId:p.id,nodeId:n.id,path:n.path,kind:n.kind,start:n.start,end:n.end}};
 const r=await applySourceChanges(p,[c]);assert.deepEqual(r.diagnostics,[]);assert.equal(dec.decode(r.project.files[0].bytes),'$x^{4}_{5}$');
});

test('wrapped ZIP resolves main-relative inputs and graphics paths without changing bytes',async()=>{
 const files=[
  {path:'paper/main.tex',bytes:enc.encode('\\documentclass{article}\n\\graphicspath{{./images/}{./art/}}\n\\begin{document}\\input{./chapters/a}\\end{document}')},
  {path:'paper/chapters/a.tex',bytes:enc.encode('\\input{./shared/a} \\includegraphics{plot} \\includegraphics{./art/other}')},
  {path:'paper/shared/a.tex',bytes:enc.encode('original source')},
  {path:'paper/images/plot.png',bytes:new Uint8Array([0,2,255])},
  {path:'paper/art/other.pdf',bytes:new Uint8Array([37,80,68,70])},
 ];
 const original=await createLatexProject({files});const zip=await exportLatexProject(original);
 const project=await importLatexProject({name:'wrapped.zip',arrayBuffer:async()=>zip});
 assert.equal(project.mainFile,'paper/main.tex'); assert.deepEqual(analyzeProjectFiles(project).missingFiles,[]);
 for(const f of files)assert.deepEqual(project.files.find(x=>x.path===f.path).bytes,f.bytes);
});

test('missing files and paths escaping project root remain missing',async()=>{
 const files=[{path:'main.tex',bytes:enc.encode('\\documentclass{a}\\begin{document}\\input{./missing}\\input{../outside}\\includegraphics{missing-image}\\end{document}')},{path:'outside.tex',bytes:enc.encode('not outside')}];
 const result=analyzeProjectFiles(await createLatexProject({files}));
 assert.deepEqual(result.missingFiles.map(x=>x.reference),['./missing','../outside','missing-image']);
});

test('multiple mains retain independent graphics roots and explicit selection',async()=>{
 const files=[{path:'one/main.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{./figures/}}\\begin{document}\\includegraphics{only-two}\\end{document}')},{path:'two/main.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{./figures/}}\\begin{document}\\includegraphics{only-two}\\end{document}')},{path:'two/figures/only-two.png',bytes:new Uint8Array([1])}];
 const p=await createLatexProject({files});const a=analyzeProjectFiles(p);
 assert.equal(a.mainCandidates.length,2);assert.ok(a.diagnostics.some(x=>x.code==='AMBIGUOUS_MAIN'));
 assert.deepEqual(a.missingFiles.map(x=>x.path),['one/main.tex']);
 const selected=await createLatexProject({files,mainFile:'two/main.tex'});
 assert.ok(!analyzeProjectFiles(selected).diagnostics.some(x=>x.code==='AMBIGUOUS_MAIN'));
});

test('ambiguous graphics paths stay unresolved and cannot borrow another main',async()=>{
 const files=[
  {path:'one/main.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{\\custom/}}\\begin{document}\\includegraphics{not-here}\\end{document}')},
  {path:'two/main.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{./figs/}}\\begin{document}\\includegraphics{not-here}\\end{document}')},
  {path:'two/figs/not-here.png',bytes:new Uint8Array([2])},
 ];
 const result=analyzeProjectFiles(await createLatexProject({files}));
 assert.ok(result.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'&&x.path==='one/main.tex'));
 assert.ok(!result.missingFiles.some(x=>x.path==='one/main.tex'));
});

test('a local graphics path replaces an inherited graphics path',async()=>{
 const files=[
  {path:'main.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{root/}}\\begin{document}\\input{chapter}\\end{document}')},
  {path:'chapter.tex',bytes:enc.encode('\\graphicspath{{local/}}\\includegraphics{only-root}')},
  {path:'root/only-root.pdf',bytes:new Uint8Array([1])},
 ];
 const result=analyzeProjectFiles(await createLatexProject({files}));
 assert.ok(result.missingFiles.some(x=>x.path==='chapter.tex'&&x.reference==='only-root'));
});

test('later or conditional graphics path declarations are unresolved',async()=>{
 for(const source of ['\\includegraphics{figure}\\graphicspath{{figs/}}','\\iftrue\\graphicspath{{figs/}}\\fi\\includegraphics{figure}']) {
  const files=[{path:'main.tex',bytes:enc.encode(source)},{path:'figs/figure.pdf',bytes:new Uint8Array([1])}];
  const result=analyzeProjectFiles(await createLatexProject({files}));
  assert.ok(result.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'));assert.equal(result.missingFiles.length,0);
 }
});

test('shared chapter with different main graphics paths is unresolved until main is selected',async()=>{
 const files=[
  {path:'a.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{figs/}}\\begin{document}\\input{chapter}\\end{document}')},
  {path:'b.tex',bytes:enc.encode('\\documentclass{a}\\graphicspath{{other/}}\\begin{document}\\input{chapter}\\end{document}')},
  {path:'chapter.tex',bytes:enc.encode('\\includegraphics{plot}')},
  {path:'figs/plot.png',bytes:new Uint8Array([1])},
 ];
 let p=await createLatexProject({files});let a=analyzeProjectFiles(p);
 assert.ok(a.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'&&x.path==='chapter.tex'));
 p=await createLatexProject({files,mainFile:'b.tex'});a=analyzeProjectFiles(p);
 assert.ok(a.missingFiles.some(x=>x.path==='chapter.tex'));
 p=await createLatexProject({files,mainFile:'a.tex'});a=analyzeProjectFiles(p);
 assert.equal(a.missingFiles.length,0);
});

test('grouped graphics path declaration stays unresolved',async()=>{
 const files=[{path:'main.tex',bytes:enc.encode('{\\graphicspath{{figs/}}}\\includegraphics{figure}')},{path:'figs/figure.pdf',bytes:new Uint8Array([1])}];
 const result=analyzeProjectFiles(await createLatexProject({files}));
 assert.ok(result.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'));
});

test('dynamic graphics reference is unresolved rather than declared missing',async()=>{
 const p=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode('\\includegraphics{\\figfile}')}]});
 const a=analyzeProjectFiles(p);assert.equal(a.missingFiles.length,0);assert.ok(a.diagnostics.some(d=>d.code==='UNRESOLVED_REFERENCE'));
});

test('main-relative nested inputs inherit graphics path set by an intermediate included source',async()=>{
 const files=[
  {path:'paper/main.tex',bytes:enc.encode('\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\input{parts/section}\\end{document}')},
  {path:'paper/parts/section.tex',bytes:enc.encode('\\graphicspath{{figs/}}\\input{nested/page}')},
  {path:'paper/nested/page.tex',bytes:enc.encode('Example \\includegraphics{diagram}')},
  {path:'paper/figs/diagram.pdf',bytes:new Uint8Array([37,80,68,70])},
 ];
 const p=await createLatexProject({files,mainFile:'paper/main.tex'});
 assert.deepEqual(analyzeProjectFiles(p).missingFiles,[]);
});

test('nested inputs use the selected main directory and cannot borrow a declaring-file path',async()=>{
 const files=[{path:'paper/main.tex',bytes:enc.encode('\\documentclass{article}\\begin{document}\\input{parts/section}\\end{document}')},{path:'paper/parts/section.tex',bytes:enc.encode('\\input{nested/page} \\input{../private}')},{path:'paper/parts/nested/page.tex',bytes:enc.encode('not reachable from cwd')},{path:'private.tex',bytes:enc.encode('inside archive') }];
 const a=analyzeProjectFiles(await createLatexProject({files,mainFile:'paper/main.tex'}));
 assert.ok(a.missingFiles.some(x=>x.path==='paper/parts/section.tex'&&x.reference==='nested/page'));
 assert.ok(!a.missingFiles.some(x=>x.reference==='../private'));
 const escape=await createLatexProject({files:[{path:'paper/main.tex',bytes:enc.encode('\\documentclass{article}\\begin{document}\\input{../../private}\\end{document}')},{path:'private.tex',bytes:enc.encode('inside archive')}],mainFile:'paper/main.tex'});
 assert.equal(analyzeProjectFiles(escape).missingFiles[0].reference,'../../private');
});

test('working-directory graphics paths and earlier include state follow TeX order',async()=>{
 const files=[
  {path:'main.tex',bytes:enc.encode('\\documentclass{article}\\begin{document}\\input{setup}\\input{content}\\end{document}')},
  {path:'setup.tex',bytes:enc.encode('\\graphicspath{{./}{figs/}}')},
  {path:'content.tex',bytes:enc.encode('\\includegraphics{plot}\\includegraphics{local}')},
  {path:'figs/plot.pdf',bytes:new Uint8Array([1])},{path:'local.pdf',bytes:new Uint8Array([2])},
 ];
 const p=await createLatexProject({files,mainFile:'main.tex'});assert.deepEqual(analyzeProjectFiles(p).missingFiles,[]);
});

test('dynamic input leaves subsequent graphics path unknown',async()=>{
 const files=[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\\begin{document}\\input{\\setup}\\includegraphics{figure}\\end{document}')}];
 const a=analyzeProjectFiles(await createLatexProject({files,mainFile:'main.tex'}));
 assert.ok(a.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'&&x.reference==='figure'));
 assert.ok(!a.missingFiles.some(x=>x.reference==='figure'));
});

test('native TeX confirms wrapped main cwd and intermediate graphicspath',async t=>{
 if(spawnSync('pdflatex',['--version']).error?.code==='ENOENT')return t.skip('pdflatex unavailable');
 const image=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'));
 const files=[
  {path:'paper/main.tex',bytes:enc.encode('\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\input{parts/section}\\end{document}')},
  {path:'paper/parts/section.tex',bytes:enc.encode('\\graphicspath{{figs/}}\\input{nested/page}')},
  {path:'paper/nested/page.tex',bytes:enc.encode('Example \\includegraphics{diagram}')},
  {path:'paper/figs/diagram.png',bytes:image},
 ];
 const baseline=await createLatexProject({files});const zip=await exportLatexProject(baseline);
 const p=await importLatexProject({name:'paper.zip',arrayBuffer:async()=>zip});
 assert.equal(p.mainFile,'paper/main.tex');assert.deepEqual(analyzeProjectFiles(p).missingFiles,[]);
 const dir=mkdtempSync(join(tmpdir(),'falsify-tex-cwd-'));
 try {
  for(const file of files){const path=join(dir,...file.path.split('/'));mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,file.bytes);}
  const cwd=join(dir,'paper'),args=['-interaction=nonstopmode','-halt-on-error','main.tex'],opts={cwd,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:30000,stdio:['ignore','pipe','pipe']};
  const good=spawnSync('pdflatex',args,opts);assert.equal(good.status,0,good.stdout+'\n'+good.stderr);
  writeFileSync(join(cwd,'parts','section.tex'),'\\graphicspath{{../figs/}}\\input{../nested/page}');
  const invalid=spawnSync('pdflatex',args,opts);assert.notEqual(invalid.status,0);assert.match(invalid.stdout,/\.\.\/nested\/page/);
  for(const file of files)assert.deepEqual(p.files.find(f=>f.path===file.path).bytes,file.bytes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('macro-based graphics path and unbraced dynamic inputs remain unresolved',async()=>{
 for(const text of ['\\graphicspath\\paths\\includegraphics{image}', '\\input\\setup\\includegraphics{image}']) {
  const p=await createLatexProject({files:[{path:'main.tex',bytes:enc.encode(text)}]});const a=analyzeProjectFiles(p);
  assert.ok(a.diagnostics.some(x=>x.code==='UNRESOLVED_REFERENCE'&&x.reference==='image'));assert.equal(a.missingFiles.length,0);
 }
});

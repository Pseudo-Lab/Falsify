import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReferencePatch} from '../src/latex-reference-policy.mjs';
import {resolveSourceProposals} from '../src/latex-semantic-edits.mjs';
const make = (source, kind, content) => { const start=source.indexOf('\\'); const end=source.length; const contentStart=source.indexOf('{',start)+1, contentEnd=source.lastIndexOf('}'); return {project:{id:'p',files:[{path:'a.tex',bytes:new TextEncoder().encode(source)}]},node:{id:'n',path:'a.tex',kind,start,end,contentStart,contentEnd,sourceText:source.slice(start),text:content}}; };
test('superscript display and footnote display preserve source and counter operation',()=>{
  let {project,node}=make('Text\\textsuperscript{62}','superscript','62');
  assert.equal(buildReferencePatch(project,node,{after:'63',mode:'display-override'}).afterSource,'\\textsuperscript{63}');
  ({project,node}=make('Text\\footnote{Original note.}','footnote','Original note.'));
  const patch=buildReferencePatch(project,node,{after:'63',mode:'display-override'});
  assert.equal(patch.afterSource,'\\begingroup\\renewcommand{\\thefootnote}{63}\\footnotemark\\endgroup\\footnotetext{Original note.}');
  assert.equal(buildReferencePatch(project,node,{after:'New & note',mode:'content'}).afterSource,'\\footnote{New \\& note}');
});
test('citation content keeps command and rejects unsafe override',()=>{
  const {project,node}=make('Text\\cite{old}','citation','old');
  assert.equal(buildReferencePatch(project,node,{after:'new',mode:'content'}).afterSource,'\\cite{new}');
  assert.equal(buildReferencePatch(project,node,{after:'63',mode:'display-override'}).diagnostics[0].code,'unsupported-citation-override');
  node.sourceText='stale'; assert.equal(buildReferencePatch(project,node,{after:'new',mode:'content'}).diagnostics[0].code,'stale-anchor');
});
test('response identity and stale anchors prevent application',()=>{
  const anchor={projectId:'p',nodeId:'n',path:'a.tex',start:4,end:24,kind:'superscript'};
  const project={id:'p'}, node={id:'n',path:'a.tex',start:4,end:24,kind:'superscript'};
  const model={projectId:'p',nodes:[node],locateSourceText:()=>({status:'matched',candidates:[{anchor,before:'62'}]})};
  let r=resolveSourceProposals(project,{id:'response',schema:'falsify.external-batch.v1',items:[{before:'62',after:'63'}]}, {model});
  assert.equal(r.proposals[0].provenance.responseId,'response'); assert.equal(r.proposals[0].kind,'superscript');
  r=resolveSourceProposals(project,{items:[{before:'62',after:'63',anchor:{...anchor,projectId:'old'}}]}, {model}); assert.equal(r.proposals[0].status,'stale-anchor');
  r=resolveSourceProposals(project,{diagnostics:[{code:'file-hash-mismatch'}],items:[{before:'62',after:'63'}]}, {model}); assert.equal(r.proposals[0].enabled,false);
});
test('whole sentence narrows the changed marker without replacing surrounding TeX',()=>{
  const sentence='An initial claim62 remains conditional.', after='An initial claim63 remains conditional.';
  const outer={projectId:'p',nodeId:'sentence',path:'a.tex',start:0,end:60,kind:'text'};
  const marker={projectId:'p',nodeId:'marker',path:'a.tex',start:32,end:33,kind:'superscript'};
  const model={projectId:'p',nodes:[],locateSourceText:(_p,{before})=>before===sentence?{status:'matched',candidates:[{before,anchor:outer}]}:before==='2'?{status:'matched',candidates:[{before,anchor:marker}]}:{status:'missing',candidates:[]}};
  const result=resolveSourceProposals({id:'p'},[{before:sentence,after}],{model});
  assert.equal(result.proposals[0].sourceChanges[0].after,'3');
  assert.equal(result.proposals[0].sourceChanges[0].anchor.kind,'superscript');
});
test('mixed sentence uses display map to preserve the superscript source',()=>{
  const source='An initial claim\\textsuperscript{62} remains conditional.';
  const before='An initial claim62 remains conditional.', after='An initial claim63 remains conditional.';
  const markerStart=source.indexOf('62'), marker={id:'marker',path:'a.tex',kind:'superscript',contentStart:markerStart,contentEnd:markerStart+2};
  const displayMap=Array.from(before,(_,i)=>i<16?{nodeId:'text',start:i,end:i+1}:i<18?{nodeId:'marker',start:markerStart+i-16,end:markerStart+i-15}:{nodeId:'tail',start:source.indexOf(' remains')+i-18,end:source.indexOf(' remains')+i-17});
  const model={projectId:'p',nodes:[marker],documents:[{path:'a.tex',displayText:before,displayMap}]};
  const project={id:'p',files:[{path:'a.tex',bytes:new TextEncoder().encode(source)}]};
  const proposal=resolveSourceProposals(project,[{before,after}],{model}).proposals[0];
  assert.equal(proposal.sourceChanges[0].before,'2'); assert.equal(proposal.sourceChanges[0].after,'3');
  const a=proposal.sourceChanges[0].anchor;
  assert.equal(source.slice(0,a.start)+'3'+source.slice(a.end),'An initial claim\\textsuperscript{63} remains conditional.');
});
test('existing JSON and markdown parser anchors are resolved again against source identity', async()=>{
  const {createRequire}=await import('node:module'); const require=createRequire(import.meta.url); const parser=require('../dist/external-exchange.js');
  const source='An initial claim\\textsuperscript{62} remains conditional.', before='An initial claim62 remains conditional.', after='An initial claim63 remains conditional.';
  const start=source.indexOf('62'); const node={id:'marker',path:'a.tex',kind:'superscript',contentStart:start,contentEnd:start+2};
  const displayMap=Array.from(before,(_,i)=>i<16?{nodeId:'text',start:i,end:i+1}:i<18?{nodeId:'marker',start:start+i-16,end:start+i-15}:{nodeId:'tail',start:source.indexOf(' remains')+i-18,end:source.indexOf(' remains')+i-17});
  const model={projectId:'p',nodes:[node],documents:[{path:'a.tex',displayText:before,displayMap}],parseResponse:parser.parse};
  const project={id:'p',files:[{path:'a.tex',bytes:new TextEncoder().encode(source)}]};
  for (const raw of [JSON.stringify({changes:[{before,after}]}), `Before: ${before}\nAfter: ${after}`]) {
    const result=resolveSourceProposals(project,raw,{model}); assert.equal(result.proposals[0].sourceChanges[0].after,'3'); assert.ok(result.proposals[0].provenance.responseId);
  }
});
test('standard hyperref citation override preserves bibliography registration and target',()=>{
 const original='\\usepackage{hyperref}\nText\\cite{example}';
 const {project,node}=make(original,'citation','example'); node.start=original.indexOf('\\cite'); node.sourceText=original.slice(node.start); node.contentStart=original.indexOf('{example}')+1; node.contentEnd=node.contentStart+7;
 const patch=buildReferencePatch(project,node,{after:'63',mode:'display-override'});
 assert.equal(patch.afterSource,'\\begingroup\\expandafter\\def\\csname b@example\\endcsname{\\hyperlink{cite.example}{63}}\\cite{example}\\endgroup');
});

test('compiled standard references keep display, counters, registration and link destinations', t=>{
 const available=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8'}).status===0;
 if (!available('pdflatex',['--version']) || !available('pdftotext',['-v']) || !available('python',['-c','import pypdf'])) return t.skip('requires pdflatex, pdftotext and Python pypdf');
 const cite=make('\\cite{example}','citation','example');
 cite.project.files.push({path:'preamble.tex',bytes:new TextEncoder().encode('\\usepackage{hyperref}')});
 const note=make('\\footnote{Original note.}','footnote','Original note.');
 const patchedCite=buildReferencePatch(cite.project,cite.node,{after:'63',mode:'display-override'}).afterSource;
 const patchedNote=buildReferencePatch(note.project,note.node,{after:'63',mode:'display-override'}).afterSource;
 const dir=mkdtempSync(join(tmpdir(),'falsify-reference-'));
 try {
  writeFileSync(join(dir,'probe.tex'),String.raw`\documentclass{article}
\usepackage{hyperref}
\begin{document}
Cite ${patchedCite}. Normal \cite{example}.
Mark${patchedNote} Next\footnote{Next note.}
\begin{thebibliography}{9}\bibitem{example} Example.\end{thebibliography}
\end{document}`);
  for (let i=0;i<2;i++) { const r=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','probe.tex'],{cwd:dir,encoding:'utf8',env:{...process.env, MIKTEX_ENABLEINSTALLER:'0'}}); assert.equal(r.status,0,r.stdout+'\n'+r.stderr); }
  const text=spawnSync('pdftotext',['-layout','probe.pdf','-'],{cwd:dir,encoding:'utf8'}); assert.equal(text.status,0,text.stderr);
  assert.match(text.stdout,/Cite \[63\]\. Normal \[1\]\. Mark63 Next2/);
  assert.match(text.stdout,/1 Original note\./); assert.match(text.stdout,/2 Next note\./);
  assert.equal((readFileSync(join(dir,'probe.aux'),'utf8').match(/\\citation\{example\}/g)||[]).length,2);
  const links=spawnSync('python',['-c',"import json,pypdf; r=pypdf.PdfReader('probe.pdf'); print(json.dumps([a.get_object().get('/A',{}).get('/D') for a in r.pages[0].get('/Annots',[])]))"],{cwd:dir,encoding:'utf8'});
  assert.equal(links.status,0,links.stderr);
  assert.deepEqual(JSON.parse(links.stdout),['cite.example','cite.example','Hfootnote.1','Hfootnote.2']);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
import {createLatexProject} from '../src/latex-project.mjs';
import {analyzeLatexSource,locateSourceText} from '../src/latex-source-model.mjs';
import {applySourceChanges} from '../src/latex-source-patches.mjs';
async function actualPatch(source,before,after) {
 const p=await createLatexProject({files:[{path:'main.tex',bytes:new TextEncoder().encode(source)}]});
 const model={...analyzeLatexSource(p),locateSourceText};
 const proposal=resolveSourceProposals(p,[{id:'response',before,after}],{model}).proposals[0];
 if(proposal.status!=='matched') return {p,proposal};
 const changes=proposal.sourceChanges.map((c,i)=>({...c,id:proposal.id+':'+i,proposalId:proposal.id})), result=await applySourceChanges(p,changes);
 return {p,proposal,changes,result,source:new TextDecoder('utf-8',{ignoreBOM:true}).decode(result.project.files[0].bytes)};
}
test('actual project patches multiple body and marker spans atomically',async()=>{
 const original='\\begin{document}An initial claim\\textsuperscript{62} remains conditional.\\end{document}';
 const before='An initial claim62 remains conditional.';
 for(const [after,expected] of [
  ['An revised claim62 remains provisional.','An revised claim\\textsuperscript{62} remains provisional.'],
  ['An revised claim63 remains provisional.','An revised claim\\textsuperscript{63} remains provisional.'],
  ['An claim62 remains conditional.','An claim\\textsuperscript{62} remains conditional.']
 ]) {
  const r=await actualPatch(original,before,after);
  assert.equal(r.proposal.status,'matched'); assert.deepEqual(r.result.diagnostics,[]);
  assert.ok(r.source.includes(expected),r.source); assert.ok(r.changes.every(c=>c.proposalId==='response'));
 }
});
test('actual Unicode, BOM, whitespace and comments retain unchanged source bytes',async()=>{
 const original='\ufeff\\begin{document}😀 café  initial claim\\textsuperscript{62} remains conditional.% preserve\n\\end{document}';
 const r=await actualPatch(original,'😀 café initial claim62 remains conditional.','😀 café revised claim63 remains provisional.');
 assert.equal(r.proposal.status,'matched'); assert.deepEqual(r.result.diagnostics,[]);
 assert.equal(r.source,'\ufeff\\begin{document}😀 café  revised claim\\textsuperscript{63} remains provisional.% preserve\n\\end{document}');
});
test('ambiguous and unknown-rendered passages remain unresolved',async()=>{
 const repeated='\\begin{document}An initial claim\\textsuperscript{62} remains. An initial claim\\textsuperscript{62} remains.\\end{document}';
 assert.equal((await actualPatch(repeated,'An initial claim62 remains.','An revised claim62 remains.')).proposal.status,'ambiguous');
 const unknown='\\begin{document}An initial \\mystery{hidden}claim\\textsuperscript{62} remains.\\end{document}';
 assert.equal((await actualPatch(unknown,'An initial claim62 remains.','An revised claim62 remains.')).proposal.status,'unresolved');
});
test('malformed entries are filtered and identity mismatch is retained',()=>{
 const model={projectId:'p',nodes:[]};
 const r=resolveSourceProposals({id:'p'},{diagnostics:[{code:'file-hash-mismatch'}],items:[null,3,{}, {before:'x',after:''}]},{model});
 assert.equal(r.proposals.length,2);assert.equal(r.proposals[0].status,'invalid');assert.equal(r.proposals[1].status,'identity-mismatch');
});



test('actual whole-node deletion and multiple changes in one node remain source anchored',async()=>{
 for(const [before,after] of [['Remove me',''],['alpha beta gamma','ALPHA beta GAMMA'],['cat','cats']]) {
  const r=await actualPatch('\\begin{document}'+before+'\\end{document}',before,after);
  assert.equal(r.proposal.status,'matched'); assert.deepEqual(r.result.diagnostics,[]);
  assert.equal(r.source,'\\begin{document}'+after+'\\end{document}');
  for(const c of r.changes) assert.equal(new TextDecoder().decode(r.p.files[0].bytes).slice(c.anchor.start,c.anchor.end),c.before);
 }
});
test('patched mixed sentence compiles to the expected PDF text',async t=>{
 if(spawnSync('pdflatex',['--version'],{encoding:'utf8'}).status!==0 || spawnSync('pdftotext',['-v'],{encoding:'utf8'}).status!==0) return t.skip('requires pdflatex and pdftotext');
 const original='\\documentclass{article}\n\\begin{document}An initial claim\\textsuperscript{62} remains conditional.\\end{document}';
 const r=await actualPatch(original,'An initial claim62 remains conditional.','An revised claim63 remains provisional.');
 assert.equal(r.proposal.status,'matched');assert.deepEqual(r.result.diagnostics,[]);
 const dir=mkdtempSync(join(tmpdir(),'falsify-mixed-'));
 try {
  writeFileSync(join(dir,'mixed.tex'),r.source);
  const compile=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','mixed.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'}});
  assert.equal(compile.status,0,compile.stdout+'\n'+compile.stderr);
  const output=spawnSync('pdftotext',['-layout','mixed.pdf','-'],{cwd:dir,encoding:'utf8'});
  assert.equal(output.status,0,output.stderr);assert.match(output.stdout,/An revised claim63 remains provisional\./);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

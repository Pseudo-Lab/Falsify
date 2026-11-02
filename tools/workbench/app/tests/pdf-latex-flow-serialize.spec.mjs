import test from 'node:test';import assert from 'node:assert/strict';import {serializeFlowReconstruction} from '../src/pdf-latex-flow-serialize.mjs';import {inferTypographyProfile} from '../src/paper-typography-profile.mjs';import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {analyzeLatexSource,locateSourceText} from '../src/latex-source-model.mjs';
import {createLatexProject,exportLatexProject,importLatexProject} from '../src/latex-project.mjs';
const hash='a'.repeat(64),ref={sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox:[40,40,500,70]};
const item=(id,text,extra={})=>({id,text,kind:'paragraph',status:'observed',evidence:[ref],...extra});
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'));
const model=items=>({schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:612,height:792,frame:'mupdf-display'}],items,assets:[],relations:[],diagnostics:[]});
const text=r=>new TextDecoder().decode(r.files[0].bytes);
test('source-bound captions stay with their images across interleaved column items',()=>{
 const f=item('f','',{kind:'figure',assetId:'a'}),c=item('c','Figure 1. Correct owner',{kind:'caption',reason:'inline-script-candidate'}),other=item('other','Other column body'),m=model([f,other,c]);m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'image',editable:false,evidence:[ref]}];m.relations=[{kind:'caption',from:'f',to:'c',status:'proposed',evidence:[...f.evidence,...c.evidence]}];const saved=structuredClone(m),r=serializeFlowReconstruction({model:m}),s=text(r);
 assert.deepEqual(m,saved);assert.deepEqual(r.structure.groups,[['f','c']]);assert.deepEqual(r.structure.plan.order,['f','c','other']);assert.match(s,/\\begin\{figure\}[\s\S]*Correct owner[\s\S]*\\end\{figure\}[\s\S]*Other column body/);assert.equal((s.match(/Correct owner/g)||[]).length,1);
});
test('publication roles retain hierarchy, inline markers and a reserved native footnote',()=>{
 const m=model([
 item('title','Paper title',{kind:'heading',extensions:{publicationRole:'title',typography:{fontSizeBp:22,leadingBp:27}}}),
 item('author','Ada Lee1',{extensions:{publicationRole:'authors',typography:{fontSizeBp:11},inlineRuns:[{start:0,end:7,bold:true},{start:7,end:8,script:'super'}]}}),
 item('abstract','AbstractResult 63.50.',{extensions:{publicationRole:'abstract',roleLabel:{start:0,end:8,text:'Abstract'},typography:{fontSizeBp:10},inlineRuns:[{start:0,end:8,bold:true},{start:8,end:21}]}}),
 item('section','1. Introduction',{extensions:{publicationRole:'section-heading',typography:{fontSizeBp:10}}}),
 item('foot','* Correspondence.',{extensions:{publicationRole:'footnote',typography:{fontSizeBp:8}}}),
 item('body','Unchanged RED 71.',{extensions:{publicationRole:'body',typography:{fontSizeBp:10,leadingBp:12}}})]);
 const r=serializeFlowReconstruction({model:m}),s=text(r);
 assert.match(s,/\\fontsize\{22bp\}\{27bp\}/);assert.match(s,/\\textbf\{Ada Lee\}\\textsuperscript\{1\}/);
 assert.match(s,/\\textbf\{Abstract\}\\par\\noindent Result 63\.50\./);
 assert.match(s,/\\footnotetext\{[\s\S]*\* Correspondence\./);assert.equal((s.match(/\* Correspondence\./g)||[]).length,1);
 assert.equal(r.structure.units.find(u=>u.id==='section').role,'heading');
 for(const b of r.bindings)assert.ok(s.slice(b.start,b.end).length);
 const override=serializeFlowReconstruction({model:m,profile:inferTypographyProfile(m,{body:{sizeBp:12,leadingBp:15}})});
 assert.match(text(override),/\\fontsize\{12bp\}\{15bp\}\\selectfont Unchanged RED 71/);
});
test('native long paragraph and document profiles preserve actual content and bindings',()=>{const long='Result 63.5 μ 漢 & 20%. '.repeat(1000),m=model([item('p',long),item('q','Another paragraph.'),item('h','Section 1',{kind:'heading'})]),original=structuredClone(m);for(const columns of [1,2]){const p=inferTypographyProfile(m,{page:{columns},body:{sizeBp:10,leadingBp:12}}),r=serializeFlowReconstruction({model:m,profile:p}),s=text(r);assert.deepEqual(m,original);assert.equal(r.engine,'lualatex');assert.equal(s.includes('twocolumn'),columns===2);assert.doesNotMatch(s,/\\newpage|\\begin\{minipage\}|\\fbox/);assert.match(s,/μ 漢 \\& 20\\%/);assert.equal((s.match(/\\fontsize\{10bp\}\{12bp\}/g)||[]).length,2);assert.equal(s.slice(r.bindings[0].start,r.bindings[0].end),long.replaceAll('&','\\&').replaceAll('%','\\%'));assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_GLYPH_COVERAGE_UNVERIFIED'));assert.match(s,/\\Needspace\{4\\baselineskip\}/);}});
test('figure and caption retained; explicit transcription is evidence bound',()=>{const m=model([item('f','',{kind:'figure',assetId:'a'}),item('c','Figure 1: 63%',{reason:'caption-proposal'}),item('x','x2',{reason:'inline-script-candidate'})]);m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'image',editable:false,evidence:[ref]}];m.relations=[{kind:'caption',from:'f',to:'c',status:'proposed',evidence:[ref,ref]}];const r=serializeFlowReconstruction({model:m,decisions:[{itemId:'x',sourceSha256:hash,evidence:[ref],tex:'$x^2$'}]}),s=text(r);assert.match(s,/\\includegraphics/);assert.match(s,/Figure 1: 63\\%/);assert.equal(s.slice(r.bindings[2].start,r.bindings[2].end),'$x^2$');assert.equal(r.files.length,2);assert.equal((s.match(/\\Needspace\{5\\baselineskip\}/g)||[]).length,2);assert.throws(()=>serializeFlowReconstruction({model:m,decisions:[{itemId:'x',sourceSha256:'b'.repeat(64),evidence:[ref],tex:'$x^2$'}]}),{code:'INVALID_DECISION'});});

test('emitter relation groups adjacent figure and caption; unknown relations stay separate',()=>{
 const f=item('f','raster label',{kind:'figure',assetId:'a'}),c=item('c','Figure one',{reason:'caption-proposal'}),m=model([f,c,item('p','body')]);
 m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref]}];
 m.relations=[{kind:'caption',from:'f',to:'c',status:'proposed',evidence:[...f.evidence,...c.evidence]}];
 let r=serializeFlowReconstruction({model:m}),s=text(r);assert.match(s,/\\begin\{figure\}\[htbp\][\s\S]*\\FalsifyImage[\s\S]*Figure one[\s\S]*\\end\{figure\}/);assert.doesNotMatch(s,/raster label/);assert.ok(r.diagnostics.some(d=>d.code==='RASTER_TEXT_NONEDITABLE'));assert.equal(s.slice(r.bindings[1].start,r.bindings[1].end),'Figure one');
 m.relations=[{kind:'mystery',from:'f',to:'c',status:'proposed'}];r=serializeFlowReconstruction({model:m});assert.doesNotMatch(text(r),/\\begin\{figure\}/);assert.ok(r.diagnostics.some(d=>d.code==='RELATION_REVIEW'));
});
test('oversized image is bounded and long paragraphs remain breakable',()=>{
 const f=item('f','',{kind:'figure',assetId:'a'}),long='long paragraph '.repeat(5000),m=model([f,item('p',long),item('h','Heading',{kind:'heading'}),item('next','Next')]);m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref]}];const r=serializeFlowReconstruction({model:m}),s=text(r);assert.match(s,/height=\\FalsifyHeight,keepaspectratio/);assert.doesNotMatch(s,/\\begin\{minipage\}/);assert.equal(s.slice(r.bindings[1].start,r.bindings[1].end),long);assert.match(s,/Heading\\par\}\s*\\nopagebreak\[4\]/);
});

test('content-hashed font paths use a safe named NFSS family, including all style faces',()=>{
 const m=model([item('p','Real font project')]),fontFiles=['regular','bold','italic','bolditalic'].map((style,n)=>({path:style+'.ttf',bytes:Uint8Array.from([0,1,2,n]),role:'serif',style}));
 const r=serializeFlowReconstruction({model:m,fontFiles}),s=text(r);
 assert.match(s,/NFSSFamily=FalsifyBody,Path=fonts\//);assert.match(s,/UprightFont=\{[a-f0-9]{64}\.ttf\}/);assert.match(s,/BoldItalicFont=\{[a-f0-9]{64}\.ttf\}/);assert.match(s,/\]\{FalsifyPublication\}/);assert.equal(r.files.filter(f=>f.path.startsWith('fonts/')).length,4);
});
test('bundled symbol face preserves math characters without replacing their Unicode content',()=>{
 const m=model([item('p','* ∗ ∼ − 63.50')]),r=serializeFlowReconstruction({model:m,fontFiles:[{path:'body.ttf',bytes:new Uint8Array([1,2]),role:'serif'},{path:'symbols.otf',bytes:new Uint8Array([3,4]),role:'math'}]}),s=text(r);
 assert.match(s,/\\newfontfamily\\FalsifySymbols/);assert.match(s,/\{\\FalsifySymbols ∗\}/);assert.match(s,/\{\\FalsifySymbols ∼\}/);assert.match(s,/63\.50/);
 assert.equal(r.files.filter(f=>f.path.startsWith('fonts/')).length,2);
});

test('layout commands preserve editable headings, author text and captions in the source editor',()=>{
 const m=model([item('h','A paper title',{kind:'heading'}),item('a','First Author, Second Author'),item('c','Figure 1. Exact result',{reason:'caption-proposal'}),item('p','Body result 63.5 percent.')]);
 const serialized=serializeFlowReconstruction({model:m}),project={id:'p',files:serialized.files};
 const analyzed=analyzeLatexSource(project);assert.deepEqual(analyzed.diagnostics,[]);
 for(const before of ['A paper title','Second Author','Figure 1. Exact result','Body result 63.5 percent.'])assert.equal(locateSourceText(project,{before}).status,'matched',before);
 assert.doesNotMatch(analyzed.documents[0].displayText,/\[4\]|\[5\]/);
 assert.ok(serialized.bindings.every(b=>b.status==='exact-text'));
});

test('flow source ZIP retains its compiler choice on reimport, with explicit choice taking precedence',async()=>{
 const serialized=serializeFlowReconstruction({model:model([item('p','Reopen this source')])}),p=await createLatexProject({...serialized,origin:'original-source'});
 const zip=await exportLatexProject(p),file={name:'source.zip',arrayBuffer:async()=>zip.slice().buffer};
 const reopened=await importLatexProject(file);assert.equal(reopened.engine,'lualatex');assert.equal(reopened.id,p.id);
 assert.equal((await importLatexProject(file,{engine:'pdflatex'})).engine,'pdflatex');
});


test('source geometry preserves small and column images and requires corroborated spanning evidence',()=>{
 const ev=bbox=>({...ref,bbox}), left=item('left','Left column',{evidence:[ev([40,100,280,150])]}), right=item('right','Right column',{evidence:[ev([330,100,570,150])]}), caption=item('c','Fig. 01: 63.50%',{kind:'caption',evidence:[ev([40,340,560,355])]});
 const fixture=(box,span='page')=>{const e=ev(box),f=item('f','',{kind:'figure',assetId:'a',evidence:[e],extensions:{columns:span==='page'?1:2,span}}),m=model([left,right,f,caption]);m.pages[0].extensions={layoutHints:{columns:2,gutterBp:[290,320],status:'proposed',provenance:'paper-flow'}};m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'image',editable:false,evidence:[e]}];m.relations=[{kind:'caption',from:'f',to:'c',status:'confirmed',evidence:[...f.evidence,...caption.evidence]}];return m;};
 let m=fixture([50,200,100,225]),r=serializeFlowReconstruction({model:m}),s=text(r);assert.match(s,/\\FalsifyImage\{50bp\}\{25bp\}/);assert.match(s,/\\begin\{figure\}/);assert.doesNotMatch(s,/\\begin\{figure\*\}/);
 m=fixture([40,200,280,320],'column');s=text(serializeFlowReconstruction({model:m}));assert.match(s,/\\FalsifyImage\{240bp\}\{120bp\}/);assert.doesNotMatch(s,/\\begin\{figure\*\}/);
 m=fixture([40,200,570,320]);r=serializeFlowReconstruction({model:m});s=text(r);assert.match(s,/\\begin\{figure\*\}[\s\S]*\\FalsifyImage\{530bp\}\{120bp\}[\s\S]*Fig\. 01: 63\.50\\%[\s\S]*\\end\{figure\*\}/);assert.equal(s.slice(r.bindings[3].start,r.bindings[3].end),'Fig. 01: 63.50\\%');assert.match(s,/\\ifdim\\FalsifyWidth>\\linewidth/);assert.match(s,/\\ifdim\\FalsifyHeight>\.7\\textheight/);
 delete m.pages[0].extensions;s=text(serializeFlowReconstruction({model:m}));assert.doesNotMatch(s,/\\begin\{figure\*\}/);
 m=fixture([40,200,570,320]);m.items=m.items.filter(x=>x.id!=='right');s=text(serializeFlowReconstruction({model:m}));assert.doesNotMatch(s,/\\begin\{figure\*\}/);
});

test('spanning table requires source geometry and keeps its exact caption and cells',()=>{
 const ev=bbox=>({...ref,bbox}),left=item('l','left',{evidence:[ev([40,80,280,95])]}),right=item('r','right',{evidence:[ev([330,80,570,95])]}),table=item('t','',{kind:'table',evidence:[ev([40,200,570,300])],extensions:{columns:1,span:'page'},table:{rows:[[{text:'63.50',evidence:[ev([40,200,80,215])]}]]}}),cap=item('c','Table IV. Exact',{kind:'caption',evidence:[ev([40,185,570,198])]});
 const m=model([left,right,cap,table]);m.pages[0].extensions={layoutHints:{columns:2,gutterBp:[290,320],status:'proposed',provenance:'paper-flow'}};m.relations=[{kind:'caption',from:'t',to:'c',status:'confirmed',evidence:[...table.evidence,...cap.evidence]}];const s=text(serializeFlowReconstruction({model:m}));assert.match(s,/\\begin\{table\*\}[\s\S]*Table IV\. Exact[\s\S]*63\.50[\s\S]*\\end\{table\*\}/);
});

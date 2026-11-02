import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serializeReconstruction} from '../src/pdf-latex-serialize.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {locateSourceText} from '../src/latex-source-model.mjs';
const hash='a'.repeat(64), enc=new TextEncoder(), dec=new TextDecoder();
const ref=(pageIndex=0)=>({sourceSha256:hash,pageIndex,frame:'mupdf-display',bbox:[36,36,pageIndex ? 464 : 576,60],range:{start:0,end:2}});
const item=(id,text,extra={})=>({id,kind:'paragraph',status:'observed',text,evidence:[ref()],...extra});
const make=(items,extra={})=>({schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:612,height:792,frame:'mupdf-display',transform:[1,0,0,-1,0,792]}],items,assets:[],diagnostics:[],relations:[],...extra});
const source=r=>dec.decode(r.files[0].bytes);
const image=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'));
const asset={id:'a',bytes:image,sha256:hex(image),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref()]};
test('deterministic editable source, escaped text and exact UTF-16 bindings',()=>{
 const m=make([item('a','A & B #1 $2 {x} 50% _ ^ ~ \\'),item('b','The effect is 63. The effect is not 63.',{kind:'heading'})]);
 const original=structuredClone(m), r=serializeReconstruction({model:m});
 assert.deepEqual(m,original); assert.deepEqual(r,serializeReconstruction({model:m})); assert.equal(r.status,'needs-review');
 const s=source(r); assert.match(s,/The effect is 63\. The effect is not 63\./);
 assert.equal(s.slice(r.bindings[0].start,r.bindings[0].end),'A \\& B \\#1 \\ensuremath{\\$}2 \\{x\\} 50\\% \\_ \\^{} \\~{} \\ensuremath{\\backslash}');
});
test('reviewed transcription is evidence-bound and scripts are never guessed',()=>{
 const i=item('math','x2',{reason:'inline-script-candidate'}), m=make([i]);
 assert.equal(serializeReconstruction({model:m}).status,'needs-review');
 const decision={itemId:'math',sourceSha256:hash,tex:'$x^2$',evidence:[ref()]};
 const r=serializeReconstruction({model:m,decisions:[decision]}); assert.equal(r.status,'needs-review'); assert.equal(source(r).slice(r.bindings[0].start,r.bindings[0].end),'$x^2$'); assert.equal(r.bindings[0].status,'reviewed');
 assert.throws(()=>serializeReconstruction({model:m,decisions:[{...decision,sourceSha256:'b'.repeat(64)}]}),{code:'INVALID_DECISION'});
 assert.throws(()=>serializeReconstruction({model:m,decisions:[decision,decision]}),{code:'INVALID_DECISION'});
});
test('region PNG, verified table, missing and Unicode remain visible and reviewable',()=>{
 const table=item('t','',{kind:'table',table:{rows:[[{text:'A',evidence:[ref()]},{text:'2 & 3',evidence:[ref()]}],[{text:'B',evidence:[ref()]},{text:'4',evidence:[ref()]}]]}});
 const m=make([table,item('fig','',{kind:'figure',assetId:'a'}),item('unicode','naïve'),item('missing','',{kind:'unknown'})],{assets:[asset]});
 const r=serializeReconstruction({model:m}); assert.equal(r.status,'unsupported'); assert.match(source(r),/\\begin\{tabular\}\{ll\}/); assert.match(source(r),/naïve/); assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_RENDER_REVIEW')); assert.match(source(r),/Content missing/); assert.equal(r.bindings.find(b=>b.itemId==='fig').status,'noneditable'); assert.deepEqual(r.files[1].bytes,image);
 const invalid=structuredClone(m); invalid.assets[0].bytes[9]^=1; assert.throws(()=>serializeReconstruction({model:invalid}),{code:'INVALID_ASSET'});
 const merged=structuredClone(table); merged.table.rows[0][0].colSpan=2; assert.notEqual(serializeReconstruction({model:make([merged])}).status,'ready');
});
test('reject stale evidence, cross-page items, invalid geometry and engine',()=>{
 const two=make([item('x','a',{evidence:[ref(),ref(1)]})],{pages:[...make([]).pages,{pageIndex:1,width:612,height:792,frame:'mupdf-display',transform:[1,0,0,-1,0,792]}]});
 assert.throws(()=>serializeReconstruction({model:two}),{code:'INVALID_ITEM'});
 const bad=make([item('x','x',{evidence:[{...ref(),sourceSha256:'b'.repeat(64)}]})]); assert.throws(()=>serializeReconstruction({model:bad}),{code:'INVALID_ITEM'});
 assert.throws(()=>serializeReconstruction({model:make([]),engine:'xelatex'}),{code:'UNSUPPORTED_ENGINE'});
});
test('page order, missing assets, unresolved relations and Unicode are explicit',()=>{
 const pages=[...make([]).pages,{pageIndex:1,width:500,height:700,frame:'mupdf-display',transform:[1,0,0,-1,0,700]}];
 const m=make([item('second','Second',{evidence:[ref(1)]}),item('first','First')],{pages,relations:[{status:'unresolved'}]});
 const r=serializeReconstruction({model:m}); assert.equal(r.status,'needs-review'); assert.ok(r.diagnostics.some(d=>d.code==='PAGE_ORDER_REVIEW')); assert.ok(r.diagnostics.some(d=>d.code==='RELATION_REVIEW')); assert.match(source(r),/\\newpage/); assert.ok(source(r).indexOf('First')<source(r).indexOf('Second'));
 assert.throws(()=>serializeReconstruction({model:make([item('f','',{kind:'figure',assetId:'missing'})])}),{code:'INVALID_ASSET_REFERENCE'});
 const unicode=serializeReconstruction({model:make([item('u','naïve')])}); assert.equal(unicode.status,'needs-review'); assert.match(source(unicode),/naïve/); assert.equal(unicode.bindings[0].status,'review-required');
});
test('source geometry uses bp, bounded regions, and observed font only with complete evidence',async()=>{
 const small={...asset,evidence:[{...ref(),bbox:[20,30,32,42]}]};
 const text='Observed body'; const styled=item('p',text,{extensions:{columns:1,styles:[{id:'style1',size:9.5}],segments:[{text,styleIds:['style1']}]}});
 const result=serializeReconstruction({model:make([styled,item('f','',{kind:'figure',assetId:'a'})],{assets:[small]})}); const tex=source(result);
 assert.match(tex,/\\pdfpagewidth=612bp\\pdfpageheight=792bp/);
 assert.match(tex,/\\includegraphics\[width=12bp,height=12bp,keepaspectratio\]/);
 assert.match(tex,/\\fontsize\{9\.5bp\}\{11\.4bp\}\\selectfont/);
 const project=await createLatexProject({files:result.files,mainFile:result.mainFile}); assert.equal(locateSourceText(project,{before:text}).status,'matched');
 assert.ok(result.diagnostics.some(d=>d.code==='LEADING_UNVERIFIED')); assert.ok(result.diagnostics.some(d=>d.code==='LAYOUT_OVERFLOW_UNVERIFIED'));
 const large={...small,evidence:[{...ref(),bbox:[0,0,1000,500]}]}; const bounded=serializeReconstruction({model:make([item('f','',{kind:'figure',assetId:'a'})],{assets:[large]})});
 assert.match(source(bounded),/width=540bp,height=270bp/); assert.ok(bounded.diagnostics.some(d=>d.code==='REGION_SCALED_DOWN'));
 const column=structuredClone(styled); column.extensions.columns=2; const r=serializeReconstruction({model:make([column])}); assert.match(source(r),/\\fontsize/); assert.ok(r.diagnostics.some(d=>d.code==='MULTICOLUMN_REVIEW'));
});
test('small image and multi-page text retain measured physical geometry',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const check=spawnSync('python',['-c','import pymupdf'],{encoding:'utf8'}); if(check.status!==0){t.skip('PyMuPDF not installed for geometry inspection');return;}
 const pages=[...make([]).pages,{pageIndex:1,width:500,height:700,frame:'mupdf-display',transform:[1,0,0,-1,0,700]}];
 const small={...asset,evidence:[{...ref(1),bbox:[20,30,32,42]}]};
 const r=serializeReconstruction({model:make([item('long','A sentence with numbers 63 and 64. '.repeat(20)),item('fig','',{kind:'figure',assetId:'a',evidence:[{...ref(1),bbox:[20,30,32,42]}]})],{pages,assets:[small]})});
 const dir=mkdtempSync(join(tmpdir(),'falsify-geometry-')); try {for(const f of r.files){const p=join(dir,...f.path.split('/'));mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,f.bytes);} const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.doesNotMatch(readFileSync(join(dir,'main.log'),'utf8'),/cm-super-ts1|ts1cmr\.fd/i);
 const py=spawnSync('python',['-c',"import pymupdf,json; d=pymupdf.open('main.pdf'); print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d], 'images':[[list(r) for im in p.get_images() for r in p.get_image_rects(im)] for p in d]}))"],{cwd:dir,encoding:'utf8'}); assert.equal(py.status,0,py.stderr); const data=JSON.parse(py.stdout); assert.deepEqual(data.pages,[[612,792],[500,700]]); assert.equal(data.images[1].length,1); const box=data.images[1][0]; assert.ok(Math.abs(box[2]-box[0]-12)<.1 && Math.abs(box[3]-box[1]-12)<.1,JSON.stringify(box));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('mapped Unicode remains editable and unknown glyphs remain reviewable',async()=>{
 const text='Measurement (−3 ± μ µ β × ∞ 9°) naïve ﬀ – ‘x’';
 const r=serializeReconstruction({model:make([item('unicode',text),item('unknown','unknown 漢')])});
 assert.match(source(r),/Measurement \(−3 ± μ µ β × ∞ 9°\) naïve ﬀ – ‘x’/); assert.match(source(r),/U\+6F22/);
 assert.equal(r.bindings[0].status,'review-required'); assert.equal(r.bindings[1].status,'review-required');
 assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_RENDER_REVIEW')); assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_REVIEW'));
 const project=await createLatexProject({files:r.files,mainFile:r.mainFile}); assert.equal(locateSourceText(project,{before:text}).status,'matched');
});
test('pdflatex and MuPDF retain representative mapped glyphs without codepoint boxes',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const check=spawnSync('python',['-c','import pymupdf'],{encoding:'utf8'}); if(check.status!==0){t.skip('PyMuPDF not installed');return;}
 const text='Thin space – minus −1.5 ± 0.2; μ µ β × ∞ ° ﬀ naïve. Measurement (−3 ± μ µ β × ∞ 9°) naïve ﬀ – ‘x’ © $ ~ ^ \\ ` apos\'rophe.'; const result=serializeReconstruction({model:make([item('unicode',text)])});
 const dir=mkdtempSync(join(tmpdir(),'falsify-unicode-'));try{writeFileSync(join(dir,'main.tex'),result.files[0].bytes); const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.doesNotMatch(readFileSync(join(dir,'main.log'),'utf8'),/cm-super-ts1|ts1cmr\.fd/i);
 const py=spawnSync('python',['-c',"import pymupdf,json; d=pymupdf.open('main.pdf'); chars=[c for b in d[0].get_text('rawdict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans'] for c in s['chars']]; print(json.dumps({'text':d[0].get_text(), 'glyphs':len(chars), 'visible':[c['c'] for c in chars if c['bbox'][2]>c['bbox'][0] and c['bbox'][3]>c['bbox'][1]]},ensure_ascii=True))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const observed=JSON.parse(py.stdout);assert.ok(observed.glyphs>15);for(const glyph of ['−','±','μ','µ','β','×','∞','◦','(',')'])assert.ok(observed.text.includes(glyph),JSON.stringify({glyph,observed:observed.text}));for(const glyph of ['−','±','μ','µ','β','×','∞','◦','(',')']) assert.ok(observed.visible.includes(glyph)); assert.equal((observed.text.match(/µ/g)||[]).length,2); assert.equal((observed.text.match(/μ/g)||[]).length,2); assert.match(observed.text,/ff/); assert.doesNotMatch(observed.text,/U\+[0-9A-F]/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous column order retains every item and reports uncertainty',()=>{
 const left=item('left','Left kept',{evidence:[{...ref(),bbox:[40,100,270,130]}],extensions:{columns:2,span:'column'}});
 const right=item('right','Right kept',{evidence:[{...ref(),bbox:[330,100,560,130]}],extensions:{columns:2,span:'column'}});
 const r=serializeReconstruction({model:make([right,left])});assert.ok(r.diagnostics.some(d=>d.code==='COLUMN_BAND_UNRESOLVED'));assert.equal(r.bindings.length,2);assert.equal((source(r).match(/Left kept/g)||[]).length,1);assert.equal((source(r).match(/Right kept/g)||[]).length,1);assert.doesNotMatch(source(r),/\\begin\{minipage\}/);
});
test('column bands, observed typography and page furniture emit once and compile in position',async t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const check=spawnSync('python',['-c','import pymupdf'],{encoding:'utf8'}); if(check.status!==0){t.skip('PyMuPDF not installed');return;}
 const evidence=box=>({...ref(),bbox:box});
 const typography={fontSizeBp:8.5,leadingBp:10,styleCounts:[{styleId:'body',count:100},{styleId:'small',count:3}],leadingEvidence:[evidence([40,100,270,110]),evidence([40,110,270,120])],status:'proposed'};
 const column=(id,text,box)=>item(id,text,{evidence:[evidence(box)],extensions:{columns:2,span:'column',styles:[{id:'body',size:8.5},{id:'small',size:6}],segments:[{text,styleIds:['body','small']}],candidates:[{kind:'script',evidence:[evidence(box)]}],typography}});
 const m=make([item('header','Page Header',{kind:'furniture',evidence:[evidence([40,20,150,30])]}),column('left','Left column words and 63.',[40,100,270,130]),column('right','Right column words and 64.',[330,100,560,130]),item('footer','Footer 7',{kind:'furniture',evidence:[evidence([40,760,150,770])]})]);
 const result=serializeReconstruction({model:m}),tex=source(result);
 assert.match(tex,/\\begin\{minipage\}\[t\]\{230bp\}/);assert.match(tex,/\\hspace\{60bp\}/);assert.match(tex,/\\fontsize\{8\.5bp\}\{10bp\}/);assert.equal(result.bindings.length,4);assert.equal(new Set(result.bindings.map(b=>b.itemId)).size,4);assert.ok(result.diagnostics.some(d=>d.code==='LEADING_UNVERIFIED'));
 for(const b of result.bindings)assert.ok(tex.slice(b.start,b.end).length>0);
 const project=await createLatexProject({files:result.files,mainFile:result.mainFile});assert.equal(locateSourceText(project,{before:'Left column words and 63.'}).status,'matched');assert.equal(locateSourceText(project,{before:'Right column words and 64.'}).status,'matched');
 const dir=mkdtempSync(join(tmpdir(),'falsify-columns-'));try{writeFileSync(join(dir,'main.tex'),result.files[0].bytes);const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf'); print(json.dumps({'pages':len(d),'blocks':[[*b[:4],b[4]] for b in d[0].get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const data=JSON.parse(py.stdout);assert.equal(data.pages,1);const find=x=>data.blocks.find(b=>b[4].includes(x));const header=find('Page'),left=find('Left'),right=find('Right'),footer=find('Footer');assert.ok(header&&left&&right&&footer,JSON.stringify(data));assert.ok(header[1]<50 && footer[1]>730,JSON.stringify(data));assert.ok(left[0]<100 && right[0]>300 && Math.abs(left[1]-right[1])<5,JSON.stringify(data));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('emitted source compiles with local pdflatex when available',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const table=item('t','',{kind:'table',table:{rows:[[{text:'A',evidence:[ref()]},{text:'2',evidence:[ref()]}]]}});
 const r=serializeReconstruction({model:make([item('p','A & B 63%.'),table,item('fig','',{kind:'figure',assetId:'a'})],{assets:[asset]})});
 const dir=mkdtempSync(join(tmpdir(),'falsify-latex-')); try { for(const f of r.files){const p=join(dir,...f.path.split('/')); mkdirSync(join(p,'..'),{recursive:true}); writeFileSync(p,f.bytes);} const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000}); assert.equal(run.status,0,run.stdout+'\n'+run.stderr); assert.ok(readFileSync(join(dir,'main.pdf')).length>0); const extracted=spawnSync('pdftotext',['-layout','main.pdf','-'],{cwd:dir,encoding:'utf8'}); if (!extracted.error) {assert.equal(extracted.status,0); assert.match(extracted.stdout,/A & B 63%/); assert.match(extracted.stdout,/A\s+2/);} } finally {rmSync(dir,{recursive:true,force:true});}
});
test('column items preserve source vertical gaps without losing text',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT')return t.skip('pdflatex not installed');
 if(spawnSync('python',['-c','import pymupdf']).status!==0)return t.skip('PyMuPDF not installed');
 const ev=b=>({...ref(),bbox:b});
 const c=(id,text,b)=>item(id,text,{evidence:[ev(b)],extensions:{columns:2,span:'column'}});
 const m=make([c('l1','Alpha',[40,100,240,112]),c('l2','Bravo',[40,160,240,172]),c('r1','Charlie',[320,100,520,112]),c('r2','Delta',[320,160,520,172])]);
 const r=serializeReconstruction({model:m});const dir=mkdtempSync(join(tmpdir(),'falsify-gaps-'));
 try {writeFileSync(join(dir,'main.tex'),r.files[0].bytes);const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout);
 const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf');print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d],'words':[[*w[:4],w[4]] for p in d for w in p.get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const data=JSON.parse(py.stdout);assert.deepEqual(data.pages,[[612,792]]);for(const [a,b] of [['Alpha','Bravo'],['Charlie','Delta']]){const x=data.words.find(w=>w[4]===a),y=data.words.find(w=>w[4]===b);assert.ok(x&&y,JSON.stringify(data));assert.ok(Math.abs(y[1]-x[1]-60)<5,JSON.stringify(data));}assert.equal(data.words.length,4);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('single source page with text near bottom stays on one page',t=>{
 if(spawnSync('pdflatex',['--version']).error?.code==='ENOENT'||spawnSync('python',['-c','import pymupdf']).status!==0)return t.skip('requires pdflatex and PyMuPDF');
 const ev=b=>({...ref(),bbox:b}); const m=make([item('top','Top line',{evidence:[ev([40,40,500,50])]}),item('bottom','Bottom line',{evidence:[ev([40,750,500,760])]})]);const r=serializeReconstruction({model:m});const dir=mkdtempSync(join(tmpdir(),'falsify-page-'));
 try {writeFileSync(join(dir,'main.tex'),r.files[0].bytes);const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout);const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf');print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d],'words':[[*w[:4],w[4]] for p in d for w in p.get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const data=JSON.parse(py.stdout);assert.deepEqual(data.pages,[[612,792]]);const top=data.words.find(w=>w[4]==='Top'),bottom=data.words.find(w=>w[4]==='Bottom');assert.ok(top&&bottom,JSON.stringify(data));assert.ok(Math.abs(top[1]-40)<5&&Math.abs(bottom[1]-750)<5,JSON.stringify(data));assert.equal(data.words.length,4);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('body near footer retains all words without encroaching on footer',t=>{
 if(spawnSync('pdflatex',['--version']).error?.code==='ENOENT'||spawnSync('python',['-c','import pymupdf']).status!==0)return t.skip('requires pdflatex and PyMuPDF');
 const ev=b=>({...ref(),bbox:b});const m=make([item('top','Top line',{evidence:[ev([40,40,500,50])]}),item('bottom','Bottom line',{evidence:[ev([40,750,500,760])]}),item('footer','Footer seven',{kind:'furniture',evidence:[ev([40,760.5,150,770.5])]})]);const r=serializeReconstruction({model:m});const dir=mkdtempSync(join(tmpdir(),'falsify-footer-'));
 try{writeFileSync(join(dir,'main.tex'),r.files[0].bytes);const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout);const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf');print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d],'words':[[i,*w[:4],w[4]] for i,p in enumerate(d) for w in p.get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const data=JSON.parse(py.stdout);assert.deepEqual(data.pages,[[612,792]]);const word=x=>data.words.find(w=>w[5]===x);const top=word('Top'),bottom=word('Bottom'),footer=word('Footer');assert.ok(top&&bottom&&footer,JSON.stringify(data));assert.equal(data.words.length,6);assert.ok(bottom[4]<=footer[2],JSON.stringify(data));assert.ok(Math.abs(bottom[2]-750)<5&&Math.abs(footer[2]-760.5)<5,JSON.stringify(data));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('wrapped body continues before the reserved footer without losing text',t=>{
 if(spawnSync('pdflatex',['--version']).status!==0 || spawnSync('python',['-c','import pymupdf']).status!==0){t.skip('pdflatex and PyMuPDF required');return;}
 const ev=b=>({...ref(),bbox:b}), text='Bottom line words that will wrap across several lines. '.repeat(3);
 const m=make([item('top','Top line',{evidence:[ev([40,40,500,50])]}),item('bottom',text,{evidence:[ev([40,744,500,756])]}),item('footer','Footer seven',{kind:'furniture',evidence:[ev([40,760,150,770])]})]);
 const r=serializeReconstruction({model:m}),dir=mkdtempSync(join(tmpdir(),'falsify-footer-flow-'));
 try{
  writeFileSync(join(dir,'main.tex'),r.files[0].bytes);
  const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout);
  const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf');print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d],'words':[[i,*w[:4],w[4]] for i,p in enumerate(d) for w in p.get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);
  const data=JSON.parse(py.stdout);assert.deepEqual(data.pages,[[612,792],[612,792]]);
  const words=data.words, footer=words.find(w=>w[5]==='Footer');assert.ok(footer);assert.equal(footer[0],0);assert.ok(Math.abs(footer[2]-760)<5);
  assert.deepEqual(words.filter(w=>!['Top','line','Footer','seven'].includes(w[5])).map(w=>w[5]).sort(),text.trim().split(/\s+/).filter(w=>w!=='line').sort());
  assert.equal(words.filter(w=>w[5]==='line').length,4);
  const body=words.filter(w=>w[0]===0&&!['Footer','seven'].includes(w[5]));assert.ok(body.every(w=>w[4]<=footer[2]),JSON.stringify(data));
  assert.ok(words.some(w=>w[0]===1));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('slightly imprecise gutter reconstructs dense columns on one page without footer collision',t=>{
 if(spawnSync('pdflatex',['--version']).error?.code==='ENOENT'||spawnSync('python',['-c','import pymupdf']).status!==0)return t.skip('requires pdflatex and PyMuPDF');
 const ev=b=>({...ref(),bbox:b});const col=(side,n)=>{const text=`${side}${String(n).padStart(2,'0')}`,y=48+n*16,b=side==='Left'?[40,y,296.7,y+10]:[306.14,y,562,y+10];return item(`${side}${n}`,text,{evidence:[ev(b)],extensions:{columns:2,span:'column',styles:[{id:'body',size:8}],segments:[{text,styleIds:['body']}]}});};
 const m=make([...Array.from({length:43},(_,n)=>col('Left',n)),...Array.from({length:43},(_,n)=>col('Right',n)),item('footer','Footer',{kind:'furniture',evidence:[ev([40,760,150,770])]})]);m.pages[0]={...m.pages[0],width:595,height:791,transform:[1,0,0,-1,0,791],extensions:{layoutHints:{columns:2,gutterBp:[296.1,306.1],status:'proposed',provenance:'paper-flow'}}};
 const r=serializeReconstruction({model:m});assert.equal(r.bindings.length,87);const dir=mkdtempSync(join(tmpdir(),'falsify-dense-columns-'));
 try{writeFileSync(join(dir,'main.tex'),r.files[0].bytes);const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout);const py=spawnSync('python',['-c',"import pymupdf,json;d=pymupdf.open('main.pdf');print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d],'words':[[i,*w[:4],w[4]] for i,p in enumerate(d) for w in p.get_text('words')]}))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const data=JSON.parse(py.stdout);assert.deepEqual(data.pages,[[595,791]]);assert.equal(data.words.length,87);const footer=data.words.find(w=>w[5]==='Footer');assert.ok(footer);for(const side of ['Left','Right'])for(let n=0;n<43;n++){const name=`${side}${String(n).padStart(2,'0')}`,words=data.words.filter(w=>w[5]===name);assert.equal(words.length,1,name);const w=words[0];assert.ok(side==='Left'?w[1]<100:w[1]>300,name);assert.ok(Math.abs(w[2]-(48+n*16))<16,`${name}: ${w[2]}`);assert.ok(w[4]<footer[2],name);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

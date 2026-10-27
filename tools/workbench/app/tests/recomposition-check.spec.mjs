import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {readOutputGlyphs} from '../src/paper-output-glyphs.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {blocks,after,corpus,geometryCorpus,pageCorpus} from './recomposition-corpus.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const check = (variant, options={}) => checkRecomposition({bytes:corpus(variant), expectedBlocks:blocks, pdfjs, exporter:'MuPDF', ...options});
test('byte-derived comparison accepts wrapping and page movement separately', async () => {
  for (const v of ['baseline','wrapped','moved']) assert.equal((await check(v)).checks.content.status,'pass',v);
  assert.deepEqual((await check('moved')).checks.movement.locations[2].pageIndexes,[1]);
});
test('selected After must match exactly', async () => {
  assert.equal((await check('edit',{edits:{c:after}})).checks.content.status,'pass');
  assert.equal((await check('edit',{edits:{c:after+' altered'}})).checks.content.status,'finding');
});
test('missing text, changed number or sign and duplication are findings', async () => {
  for (const v of ['missing','number','sign','duplicate']) assert.equal((await check(v)).checks.content.status,'finding',v);
});
test('out of bounds and unavailable checks are explicit', async () => {
  const r=await check('bounds'); assert.ok(r.findings.some(f=>f.code==='text-outside-page'));
  assert.equal(r.checks.visual.status,'unavailable'); assert.equal(r.checks.overlap.status,'unavailable'); assert.equal(r.checks.captionOwnership.status,'unavailable');
  assert.equal((await check('baseline',{exporter:'PDF.js'})).checks.independent.status,'unavailable');
});

const geometryCheck = (variant, text) => checkRecomposition({bytes:geometryCorpus(variant), expectedBlocks:[{id:'x',text}], pdfjs});
test('styled fragments preserve word boundaries and actual internal spaces', async () => {
  assert.equal((await geometryCheck('split','regulation')).checks.content.status,'pass');
  assert.equal((await geometryCheck('gap','regul ation')).checks.content.status,'pass');
  assert.equal((await geometryCheck('internal-space','regulation')).checks.content.status,'finding');
  assert.equal((await geometryCheck('wrap','hello world')).checks.content.status,'pass');
  assert.equal((await geometryCheck('split','regul ation')).checks.content.status,'finding');
  const ambiguous = await geometryCheck('ambiguous','regulation');
  assert.equal(ambiguous.checks.content.status,'unavailable');
  assert.ok(ambiguous.findings.some(f => f.code === 'ambiguous-text-geometry'));
});
test('upright font bounds detect each page edge and unsupported transforms', async () => {
  for (const v of ['bottom','top','right']) assert.equal((await geometryCheck(v,'control')).checks.bounds.status,'finding',v);
  assert.equal((await geometryCheck('control','control')).checks.bounds.status,'checked');
  assert.equal((await geometryCheck('rotated','control')).checks.bounds.status,'unavailable');
});

test('nonfinite geometry and a baseline below the viewport cannot pass', async () => {
  // Retain real bytes and extraction, then exercise values PDF.js clips before returning.
  const wrap = transform => ({getDocument(options) {
    const task = pdfjs.getDocument(options);
    return {destroy:() => task.destroy(), promise:task.promise.then(doc => ({numPages:doc.numPages, async getPage(n) {
      const page = await doc.getPage(n);
      return {getViewport: options => page.getViewport(options), cleanup:() => page.cleanup(), async getTextContent() {
        const content = await page.getTextContent(); transform(content.items[0]); return content;
      }};
    }}))};
  }});
  const base = {bytes:geometryCorpus('control'),expectedBlocks:[{id:'x',text:'control'}]};
  const below = await checkRecomposition({...base,pdfjs:wrap(item => {item.transform[5] = -3;})});
  assert.equal(below.checks.bounds.status,'finding');
  const bad = await checkRecomposition({...base,pdfjs:wrap(item => {item.transform[4] = NaN;})});
  assert.equal(bad.checks.bounds.status,'unavailable');
  assert.equal(bad.checks.content.status,'unavailable');
});


test('locations require complete validated alignment and supported geometry', async () => {
  const prefix = await geometryCheck('control','con');
  assert.equal(prefix.checks.content.status,'finding');
  assert.deepEqual(prefix.checks.movement.locations,null);
  assert.equal(prefix.checks.movement.status,'unavailable');
  for (const variant of ['ambiguous','rotated']) {
    const r = await geometryCheck(variant,variant === 'ambiguous' ? 'regulation' : 'control');
    assert.equal(r.checks.movement.status,'unavailable',variant);
    assert.equal(r.checks.movement.locations,null,variant);
  }
  const changed = await check('edit',{edits:{c:after+' altered'}});
  assert.equal(changed.checks.movement.status,'unavailable');
  assert.equal(changed.checks.movement.locations,null);
});

test('validated sequence locates repeats, edits, deletions and empty pages deterministically', async () => {
  const expectedBlocks = [{id:'a',text:'same'},{id:'b',text:'same'},{id:'c',text:'old'},{id:'d',text:'deleted'},{id:'e',text:''}];
  const result = await checkRecomposition({bytes:pageCorpus(['same','','same replacement']),expectedBlocks,edits:{c:'replacement',d:''},pdfjs});
  assert.equal(result.checks.content.status,'pass');
  assert.equal(result.checks.movement.status,'observed');
  assert.deepEqual(result.checks.movement.locations,[
    {id:'a',pageIndexes:[0]},{id:'b',pageIndexes:[2]},
    {id:'c',pageIndexes:[2]},{id:'d',pageIndexes:[]},{id:'e',pageIndexes:[]}
  ]);
  const missing = await checkRecomposition({bytes:pageCorpus(['same','replacement']),expectedBlocks,edits:{c:'replacement',d:''},pdfjs});
  assert.equal(missing.checks.content.status,'finding');
  assert.equal(missing.checks.movement.locations,null);
});


test('line ends preserve encoded hyphens, spaces and minus signs', async () => {
  const extract = async variant => {
    const task = pdfjs.getDocument({data:geometryCorpus(variant)});
    try {
      const doc = await task.promise;
      const content = await (await doc.getPage(1)).getTextContent();
      return content.items.map(({str, hasEOL, transform, width, height}) => ({str, hasEOL, transform, width, height}));
    } finally { await task.destroy(); }
  };
  assert.deepEqual(await extract('hyphen-wrap'), await extract('hyphen-space'));
  const ambiguous = await geometryCheck('hyphen-wrap','antero-posterior');
  assert.ok(ambiguous.findings.some(f => f.reason?.includes('discard an encoded space')));
  assert.equal(ambiguous.checks.movement.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-wrap','antero-posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-wrap','antero- posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-space','antero- posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-space','antero-posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('minus-wrap','value - 12')).checks.content.status,'pass');
  assert.equal((await geometryCheck('minus-wrap','value 12')).checks.content.status,'finding');
  assert.notEqual((await geometryCheck('soft-wrap','software')).checks.content.status,'pass');
});


test('encoded glyphs resolve only the matching hard-hyphen boundary', async () => {
  const run = (variant,text,extra={}) => checkRecomposition({bytes:geometryCorpus(variant),expectedBlocks:[{id:'x',text}],pdfjs,mupdf,...extra});
  for (const [variant,correct,opposite] of [
    ['hyphen-wrap','antero-posterior','antero- posterior'],
    ['hyphen-space','antero- posterior','antero-posterior'],
    ['repeat-hyphen','antero-posterior antero- posterior','antero- posterior antero-posterior'],
    ['unrelated-space','other space antero-posterior','other space antero- posterior']
  ]) {
    assert.equal((await run(variant,correct)).checks.content.status,'pass',variant);
    assert.equal((await run(variant,opposite)).checks.content.status,'finding',variant);
  }
  const evidence=(await run('hyphen-wrap','antero-posterior')).checks.content.spacingEvidence;
  assert.deepEqual(evidence.map(x=>[x.action,x.leftScalar,x.rightScalar,x.encodedWhitespace]),[['remove-inferred-space',45,112,[]]]);
  assert.equal((await run('minus-wrap','value - 12')).checks.content.status,'pass');
  assert.equal((await run('minus-wrap','value 12')).checks.content.status,'finding');
  const failed = await run('hyphen-wrap','antero-posterior',{mupdf:{}});
  assert.equal(failed.checks.content.status,'unavailable');
  const mismatch = await run('hyphen-wrap','antero-posterio9',{mupdf:{}});
  assert.ok(mismatch.findings.some(f=>f.code === 'content-mismatch'));
  const glyphs = readOutputGlyphs({bytes:geometryCorpus('hyphen-space'),mupdf});
  assert.deepEqual(glyphs[0].map(g=>g.scalar).slice(5,9),[111,45,32,112]);
  assert.ok(glyphs[0].every(g=>g.pageIndex === 0 && g.origin.every(Number.isFinite)));
});


test('glyph-resolved boundaries retain page movement and reject unknown scalars', async () => {
  const bytes = geometryCorpus('hyphen-page');
  const expectedBlocks = [{id:'a',text:'first'},{id:'b',text:'antero-posterior'}];
  const result = await checkRecomposition({bytes,expectedBlocks,pdfjs,mupdf});
  assert.equal(result.checks.content.status,'pass');
  assert.deepEqual(result.checks.movement.locations,[{id:'a',pageIndexes:[0]},{id:'b',pageIndexes:[1]}]);
  const unknown = {...mupdf, Device:class extends mupdf.Device {
    constructor(callbacks) {
      const wrapped = {...callbacks, fillText(text,ctm,cs) {
        callbacks.fillText({walk(walker) { text.walk({showGlyph(font,trm,gid,scalar) { walker.showGlyph(font,trm,gid,-1); }}); }, destroy() { text.destroy(); }},ctm,cs);
      }};
      super(wrapped);
    }
  }};
  const invalid = await checkRecomposition({bytes,expectedBlocks,pdfjs,mupdf:unknown});
  assert.equal(invalid.checks.content.status,'unavailable');
  assert.equal(invalid.checks.movement.locations,null);
});

test('PDF.js micro sign normalization permits glyph alignment without changing compared text', async () => {
  const pdfReader={getDocument(options) { const task=pdfjs.getDocument(options); return {destroy:()=>task.destroy(),promise:task.promise.then(doc=>({numPages:doc.numPages,async getPage(n) {const page=await doc.getPage(n); return {getViewport:o=>page.getViewport(o),cleanup:()=>page.cleanup(),async getTextContent() {const content=await page.getTextContent();content.items[0].str=content.items[0].str.replace('a','μ');return content;}};}}))}; }};
  const glyphReader={...mupdf,Device:class extends mupdf.Device {constructor(callbacks) {super({...callbacks,fillText(text,ctm,cs) {callbacks.fillText({walk(walker) {text.walk({showGlyph(font,trm,gid,scalar) {walker.showGlyph(font,trm,gid,scalar===97?0xb5:scalar);}});},destroy(){text.destroy();}},ctm,cs);}});}}};
  const run=text=>checkRecomposition({bytes:geometryCorpus('hyphen-wrap'),expectedBlocks:[{id:'x',text}],pdfjs:pdfReader,mupdf:glyphReader});
  assert.equal((await run('μntero-posterior')).checks.content.status,'pass');
  assert.equal((await run('μntero- posterior')).checks.content.status,'finding');
});

test('wrapped citations use encoded spaces rather than inventing a separator', async () => {
  const run=(variant,text,reader=mupdf)=>checkRecomposition({bytes:geometryCorpus(variant),expectedBlocks:[{id:'x',text}],pdfjs,mupdf:reader});
  assert.equal((await run('citation-wrap','modulation.[3]')).checks.content.status,'pass');
  assert.equal((await run('citation-wrap','modulation. [3]')).checks.content.status,'finding');
  assert.equal((await run('citation-space','modulation. [3]')).checks.content.status,'pass');
  assert.equal((await run('citation-space','modulation.[3]')).checks.content.status,'finding');
  assert.equal((await run('citation-wrap','modulation.[3]',{})).checks.content.status,'unavailable');
  assert.equal((await run('number-hyphen','7-point')).checks.content.status,'pass');
  assert.equal((await run('number-hyphen','7- point')).checks.content.status,'finding');
  assert.equal((await run('range-wrap','337–41')).checks.content.status,'pass');
  assert.equal((await run('range-wrap','337– 41')).checks.content.status,'finding');
  assert.equal((await run('url-wrap','site/path/?key=value')).checks.content.status,'pass');
  assert.equal((await run('url-wrap','site/path/? key=value')).checks.content.status,'finding');
  assert.equal((await run('hyphen-paragraph','antero- posterior')).checks.content.status,'pass');
  assert.equal((await run('hyphen-paragraph','antero-posterior')).checks.content.status,'finding');
  assert.equal((await run('url-paragraph','https://site.test Peer review')).checks.content.status,'pass');
  assert.equal((await run('url-paragraph','https://site.testPeer review')).checks.content.status,'finding');
  assert.equal((await run('url-reference','https://site.test/ 2. Reference')).checks.content.status,'pass');
  assert.equal((await run('url-reference','https://site.test/2. Reference')).checks.content.status,'finding');
});

test('synthetic PDF.js quote gaps require matching encoded glyph evidence', async () => {
  const run=async (variant,expected,reader=mupdf)=>{
    const bytes=geometryCorpus(variant), glyphs=readOutputGlyphs({bytes,mupdf}), quote=glyphs[0].find(g=>g.scalar===41);
    const wrapped={getDocument(options) {const task=pdfjs.getDocument(options);return {destroy:()=>task.destroy(),promise:task.promise.then(doc=>({numPages:doc.numPages,async getPage(n){const p=await doc.getPage(n);return {getViewport:o=>p.getViewport(o),cleanup:()=>p.cleanup(),async getTextContent(){const c=await p.getTextContent(), item=c.items[0], x=quote.origin[0];c.items=[{...item,str:'bath',width:x-item.transform[4]},{...item,str:' ',width:0,height:0},{...item,str:'”',transform:[...item.transform.slice(0,4),x,item.transform[5]],width:4}];return c;}};}}))};}};
    const glyphReader={...reader,Device:class extends mupdf.Device {constructor(callbacks){super({...callbacks,fillText(text,ctm,cs){callbacks.fillText({walk(walker){text.walk({showGlyph(font,trm,gid,scalar){walker.showGlyph(font,trm,gid,scalar===41?0x201d:scalar);}});},destroy(){text.destroy();}},ctm,cs);}});}}};
    return checkRecomposition({bytes,expectedBlocks:[{id:'x',text:expected}],pdfjs:wrapped,mupdf:reader===mupdf?glyphReader:{}});
  };
  assert.equal((await run('quote','bath”')).checks.content.status,'pass');
  assert.equal((await run('quote','bath ”')).checks.content.status,'finding');
  assert.equal((await run('quote-space','bath ”')).checks.content.status,'pass');
  assert.equal((await run('quote-space','bath”')).checks.content.status,'finding');
  assert.equal((await run('quote','bath”',{})).checks.content.status,'unavailable');
});

test('representation equivalence is explicit and does not mask scientific changes or spaces', async () => {
  const run=text=>checkRecomposition({bytes:geometryCorpus('micro'),expectedBlocks:[{id:'x',text}],pdfjs,mupdf});
  const result=await run('1 µM ki\u00adnase');
  assert.equal(result.checks.content.status,'normalized');
  assert.deepEqual(result.checks.content.representationDifferences.map(x=>[x.kind,x.sourceOffset,x.outputOffset]),[['micro-sign-to-greek-mu',2,2],['discretionary-soft-hyphen-omitted',7,7]]);
  assert.match(result.checks.content.limitation,/not byte-exact/);
  for(const changed of ['2 µM ki\u00adnase','1 µM ki\u00adnases','1 µMki\u00adnase','1 µm ki\u00adnase']) assert.equal((await run(changed)).checks.content.status,'finding',changed);
});

// Real PDF bytes with independently placed body and running furniture.
test('furniture is removed only after matching bytes and reserved-band geometry', async () => {
  const make = (variant='valid') => {
    const d=new mupdf.PDFDocument(), f=d.addSimpleFont(new mupdf.Font('Helvetica')), g=d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
    const line=(font,text,x,y)=>`BT /${font} 12 Tf ${x} ${y} Td (${text}) Tj ET\n`;
    for(let n=1;n<=2;n++) {
      let stream = variant==='wrapped' ? line('F','Journal',30,380)+line('G','Title',30,365) : variant==='styled' ? line('F','Jour',30,380)+line('G','nal',52.668,380) : line('F',variant==='changed' && n===2?'Changed':'Journal',30,380);
      stream+=line('F','Journal',30,300);
      if (!(variant==='missing' && n===2)) stream+=line('F',`${n} / 2`,250,20);
      if (variant==='duplicate' && n===2) stream+=line('F',`${n} / 2`,180,20);
      if (variant==='unexpected' && n===1) stream+=line('F','Extra',100,380);
      if (variant==='crossing' && n===1) stream+=line('F','Edge',30,341);
      d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f,G:g}},stream));
    }
    const b=d.saveToBuffer(), bytes=b.asUint8Array().slice();b.destroy();d.destroy();return bytes;
  };
  const expectedFurniture=[{kind:'header',entryKind:'text',sourcePage:0,text:'Journal',occurrences:[{blockId:'h'}]}, {kind:'footer',entryKind:'counter',sourcePage:0,text:'old',occurrences:[{blockId:'c'}]}];
  const outputFurniture=[1,2].flatMap(page=>[{id:'h',sourcePage:0,page,x:30,y:20,kind:'header'},{id:'c',sourcePage:0,page,x:250,y:380,kind:'footer'}]);
  const run=(variant,extra={})=>checkRecomposition({bytes:make(variant),expectedBlocks:[{id:'b',text:variant==='crossing'?'Journal Edge Journal':'Journal Journal'}],expectedFurniture:variant==='wrapped' ? [{...expectedFurniture[0],text:'Journal Title'},expectedFurniture[1]] : expectedFurniture,outputFurniture,blockSpans:[{id:'b',sourcePage:0,start:{page:1,x:30,y:100},end:{page:2,x:30,y:100}}],bodyFrame:{left:20,top:55,right:280,bottom:360},pdfjs,...extra});
  for (const v of ['valid','styled','wrapped']) { const r=await run(v); assert.equal(r.checks.content.status,'pass',v);assert.equal(r.checks.furniture.status,'checked',v); }
  for (const v of ['changed','missing','duplicate','unexpected']) { const r=await run(v);assert.notEqual(r.checks.furniture.status,'checked',v); }
  const crossing=await run('crossing');assert.ok(crossing.findings.some(f=>f.code==='content-mismatch' && f.observed.includes('Edge')));assert.equal(crossing.checks.furniture.status,'checked');
  assert.equal((await run('valid',{outputFurniture:null})).checks.furniture.status,'unavailable');
  assert.ok((await run('valid',{outputFurniture:outputFurniture.filter(m=>!(m.page===2 && m.id==='c'))})).findings.some(f=>f.code==='missing-furniture'));
});

test('adjacent furniture merged by PDF.js retains each anchored member', async () => {
  const d=new mupdf.PDFDocument(), font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const stream='BT /F 12 Tf 30 380 Td (JournalDate) Tj ET\nBT /F 12 Tf 30 300 Td (Body) Tj ET\n';
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},stream));
  const buffer=d.saveToBuffer(), bytes=buffer.asUint8Array().slice(); buffer.destroy();d.destroy();
  const expectedFurniture=['Journal','Date'].map((text,i)=>({kind:'header',entryKind:'text',sourcePage:0,text,occurrences:[{blockId:`h${i}`}]}));
  const outputFurniture=[{id:'h0',sourcePage:0,page:1,x:30,y:20,kind:'header'},{id:'h1',sourcePage:0,page:1,x:69.35,y:20,kind:'header'}];
  const args={bytes,pdfjs,expectedBlocks:[{id:'body',text:'Body'}],expectedFurniture,outputFurniture,blockSpans:[{id:'body',sourcePage:0,start:{page:1,x:30,y:100},end:{page:1,x:50,y:100}}],bodyFrame:{left:20,top:55,right:280,bottom:360}};
  assert.equal((await checkRecomposition(args)).checks.furniture.status,'checked');
  assert.notEqual((await checkRecomposition({...args,expectedFurniture:[expectedFurniture[0],{...expectedFurniture[1],text:'Changed'}]})).checks.furniture.status,'checked');
});


test('physical pages select the earliest covering source span', async () => {
  const make = pages => {
    const d=new mupdf.PDFDocument(), f=d.addSimpleFont(new mupdf.Font('Helvetica'));
    const line=(text,x,y)=>`BT /F 12 Tf ${x} ${y} Td (${text}) Tj ET\n`;
    for (const [header,body,footer] of pages) {
      const stream=line(header,30,380)+line(body,30,300)+(footer ? line(footer,250,20) : '');
      d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f}},stream));
    }
    const b=d.saveToBuffer(), bytes=b.asUint8Array().slice(); b.destroy(); d.destroy(); return bytes;
  };
  const templates=[0,1].flatMap(sourcePage=>[
    {kind:'header',entryKind:'text',sourcePage,text:sourcePage?'Other':'Journal',occurrences:[{blockId:`h${sourcePage}`}]},
    {kind:'footer',entryKind:'counter',sourcePage,occurrences:[{blockId:`c${sourcePage}`}]}
  ]);
  const markers=(page,sourcePage)=>[{id:`h${sourcePage}`,sourcePage,page,x:30,y:20,kind:'header'},{id:`c${sourcePage}`,sourcePage,page,x:250,y:380,kind:'footer'}];
  const span=(id,sourcePage,start,end)=>({id,sourcePage,start:{page:start,x:30,y:100},end:{page:end,x:30,y:200}});
  const run=(pages,spans,map)=>checkRecomposition({bytes:make(pages),expectedBlocks:[{id:'body',text:pages.map(p=>p[1]).join(' ')}],expectedFurniture:templates,outputFurniture:map,blockSpans:spans,bodyFrame:{left:20,top:55,right:280,bottom:360},pdfjs});
  const merged=await run([['Journal','Journal','1 / 1']],[span('a',0,1,1),span('b',1,1,1)],markers(1,0));
  assert.equal(merged.checks.content.status,'pass');
  assert.equal(merged.checks.furniture.status,'checked');
  assert.deepEqual(merged.checks.furniture.sourceAssociation.unusedVariants,[1]);
  const spans=[span('a',0,1,2),span('b',1,2,2)];
  const pages=[['Journal','Journal','1 / 2'],['Journal','Journal','2 / 2']];
  const map=[...markers(1,0),...markers(2,0)];
  const continued=await run(pages,spans,map);
  assert.equal(continued.checks.furniture.status,'checked');
  assert.deepEqual(continued.checks.furniture.sourceAssociation.pages,[{page:1,sourcePage:0},{page:2,sourcePage:0}]);
  const missing=await run(pages,spans,map.filter(m=>m.page!==2 || m.kind!=='footer'));
  assert.ok(missing.findings.some(f=>f.code==='missing-furniture' && f.pageIndex===1 && f.id==='c0'));
  const wrong=await run(pages,spans,[...markers(1,0),...markers(2,1)]);
  assert.ok(wrong.findings.some(f=>f.code==='wrong-furniture-source' && f.pageIndex===1));
  for (const bad of [undefined,[],[span('a',0,1,1)],[{...span('a',0,1,2),end:null}],[span('a',0,2,1)]]) {
    const result=await run(pages,bad,map);
    assert.equal(result.checks.furniture.sourceAssociation.status,'unavailable');
    assert.equal(result.checks.furniture.status,'unavailable');
    assert.equal(result.checks.content.status,'pass');
  }
  const extra=await run([['Journal','Journal','1 / 1']],[span('a',0,1,1)],[]);
  assert.ok(extra.findings.some(f=>f.code==='unexpected-margin-text'));
  assert.equal(extra.checks.content.status,'finding');
});

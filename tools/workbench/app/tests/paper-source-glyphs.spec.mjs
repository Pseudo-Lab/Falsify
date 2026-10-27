import {test} from 'node:test'; import assert from 'node:assert/strict'; import {webcrypto,createHash} from 'node:crypto'; import {File} from 'node:buffer';
import {readDocument} from '../src/paper-document.mjs'; import {readSourceGlyphs} from '../src/paper-source-glyphs.mjs'; import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
function fixture(){
 const cmap='/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<2A> <FFFD>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
 const stream='BT /F1 20 Tf 40 140 Td ("a*" "b*") Tj ET';
 const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`];
 let pdf='%PDF-1.4\n', offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;} const xref=pdf.length;pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new TextEncoder().encode(pdf);
}
test('unmapped painted occurrences remain source-bound and edits remove only selected artwork',async()=>{
 const bytes=fixture(), doc=await readDocument({file:bytes}), block=doc.blocks.find(b=>b.text.includes('\ufffd'));assert.ok(block);const glyphs=readSourceGlyphs({bytes,document:doc});assert.equal(glyphs.glyphs.length,2);assert.notEqual(glyphs.glyphs[0].start,glyphs.glyphs[1].start);assert.ok(glyphs.glyphs.every(g=>new TextDecoder().decode(g.bytes).includes('<path') && Number.isFinite(g.baselineShift) && g.advance>0));assert.ok(block.text.includes('\"a\ufffd\"')); 
 const original=structuredClone(doc),g=glyphs.glyphs[0];let compiled,expected;const out=await composeDocument({document:doc,sourceBytes:bytes,edits:[{blockId:block.id,pageIndex:0,start:g.start,end:g.end,before:'\ufffd',after:'X'}]},{compile:async p=>(compiled=p,new TextEncoder().encode('%PDF-1.4\n')),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(Object.keys(compiled.files).length,1);assert.match(compiled.source,/#box\(width:/);assert.ok(compiled.source.includes('aX'));assert.ok(expected[0].text.includes('X'));assert.ok(!expected[0].text.includes('\ufffd'));assert.equal(out.verification.contentVerified,false);assert.deepEqual(doc,original);
 const deleted=await composeDocument({document:doc,sourceBytes:bytes,edits:[{blockId:block.id,pageIndex:0,start:g.start,end:g.end,before:'\ufffd',after:''}]},{compile:async p=>(assert.equal(Object.keys(p.files).length,1),new TextEncoder().encode('%PDF-1.4\n'))});assert.equal(deleted.verification.sourceGlyphs.glyphs.length,1);
});
test('unmatched and ambiguous source geometry is unavailable; new unsupported text is never artwork',async()=>{
 const bytes=fixture(),doc=await readDocument({file:bytes}),block=doc.blocks.find(b=>b.text.includes('\ufffd')),glyph=block.source.characters.find(c=>block.text.slice(c.start-block.source.range.start,c.end-block.source.range.start)==='\ufffd');
 const duplicate=structuredClone(glyph);block.source.characters.push(duplicate);
 const result=readSourceGlyphs({bytes,document:doc});assert.equal(result.glyphs.length,1);assert.equal(result.unavailable.length,2);assert.ok(result.unavailable.every(x=>x.reason==='ambiguous-paint-match'));
 let generated;const out=await composeDocument({document:doc,sourceBytes:bytes,edits:[{blockId:block.id,pageIndex:0,start:glyph.start,end:glyph.end,before:'\ufffd',after:'\u{10ffff}'}]},{compile:async p=>(generated=p,new TextEncoder().encode('%PDF-1.4\n'))});assert.equal(Object.keys(generated.files).length,1);assert.ok(generated.source.includes('\u{10ffff}'));assert.equal(out.verification.sourceGlyphs.glyphs.length,1);
});

test('fragmented source glyphs preserve untargeted artwork across replacement and deletion',async()=>{
 const bytes=fixture(),doc=await readDocument({file:bytes}),block=doc.blocks.find(b=>b.text.includes('\ufffd')),glyphs=readSourceGlyphs({bytes,document:doc}).glyphs;
 const cut=glyphs[0].end,range=block.source.range;
 const fragments=[[range.start,cut],[cut,range.end]].map(([start,end],i)=>({...structuredClone(block),id:`part${i}`,parentBlockId:block.id,text:block.text.slice(start-range.start,end-range.start),source:{...structuredClone(block.source),range:{start,end},characters:block.source.characters.filter(c=>c.start>=start && c.end<=end),lines:block.source.lines.filter(l=>l.range.start<end && l.range.end>start).map(l=>({...l,range:{start:Math.max(start,l.range.start),end:Math.min(end,l.range.end)}}))}}));
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:doc.sourceSha256,fragments,items:doc.blocks.map(b=>b.id===block.id?{kind:'paragraph',inline:true,blockIds:fragments.map(f=>f.id),joiners:['']}:{kind:'paragraph',blockIds:[b.id]})};const snapshot=structuredClone({doc,flow});
 for(const after of ['X','']) {let payload,expected; const start=glyphs[0].start,end=cut+1;
  const out=await composeDocument({document:doc,sourceBytes:bytes,flow,edits:[{blockId:block.id,pageIndex:0,start,end,before:block.text.slice(start-range.start,end-range.start),after}]},{compile:async p=>(payload=p,new TextEncoder().encode('%PDF-1.4\n')),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.equal(out.verification.sourceGlyphs.glyphs.length,1);assert.equal(out.verification.sourceGlyphs.glyphs[0].start,glyphs[1].start);assert.equal(Object.keys(payload.files).length,1);assert.ok(!expected.map(x=>x.text).join('').includes('\ufffd'));
 }
 assert.deepEqual({doc,flow},snapshot);
});

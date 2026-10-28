import test from 'node:test';
import assert from 'node:assert/strict';
import {findGeneratedWhitespaceMatches, matchesGeneratedWhitespace, inspectSavedPdf} from '../src/paragraph-vendor/quality.mjs';

const chars = (text, generated=[]) => [...text].map((c,i)=>({u:c.codePointAt(0),generated:generated.includes(i)}));

test('finds After through extractor-generated spaces while keeping requested word boundaries',()=>{
  assert.equal(findGeneratedWhitespaceMatches('all lines',chars('prefix al l l ines suffix',[9,13])).length,1);
  assert.equal(findGeneratedWhitespaceMatches('all lines',chars('alllines')).length,0);
  assert.equal(findGeneratedWhitespaceMatches('all lines',chars('al l l ines')).length,0);
  assert.equal(findGeneratedWhitespaceMatches('all lines',chars('al l l inez',[2,6])).length,0);
  assert.equal(findGeneratedWhitespaceMatches('all lines',chars('lines all')).length,0);
});

test('presence does not grant whole-page equality or accept missing characters',()=>{
  const output=chars('other n e w extra',[7,9]);
  assert.equal(findGeneratedWhitespaceMatches('new',output).length,1);
  assert.equal(matchesGeneratedWhitespace('new',output),false);
  assert.equal(findGeneratedWhitespaceMatches('new',chars('n e',[1])).length,0);
  assert.equal(findGeneratedWhitespaceMatches('',output).length,0);
});

function factory(){
  let content='';
  const engine={pageCount:1,page:1,pageIndex:0,open(bytes){content=new TextDecoder().decode(bytes);},close(){},loadPage(){}};
  engine.M={_malloc:()=>8,_free(){},_FPDFText_LoadPage:()=>1,_FPDFText_ClosePage(){},
    _FPDFText_CountChars:()=>content.length,_FPDFText_GetUnicode:(_,i)=>content.charCodeAt(i),
    _FPDFText_GetCharBox:()=>false,_FPDFText_IsGenerated:(_,i)=>content[i]===' '?1:0,
    _FPDF_GetPageWidthF:()=>600,_FPDF_GetPageHeightF:()=>800};
  return engine;
}
const bytes=text=>new TextEncoder().encode(text);

test('saved-file report separates confirmed After from an unresolved whole-page mismatch',async()=>{
  const report=await inspectSavedPdf(factory,bytes('prefix old suffix'),bytes('damaged n e w suffix'),[{id:'p1',pageIndex:0,before:'old',after:'new'}]);
  assert.equal(report.ok,false);
  assert.deepEqual(report.failures.map(f=>f.code),['edited_page_text_or_order_mismatch']);
  assert.deepEqual(report.pages[0].after_checks,[{id:'p1',present:true,method:'generated-whitespace'}]);
  assert.ok(report.warnings.some(w=>w.code==='after_generated_whitespace_normalized'));
});

test('saved-file report still fails when the requested After is actually absent',async()=>{
  const report=await inspectSavedPdf(factory,bytes('prefix old suffix'),bytes('prefix n e x suffix'),[{id:'p1',pageIndex:0,before:'old',after:'new'}]);
  assert.equal(report.ok,false);
  assert.ok(report.failures.some(f=>f.code==='after_missing' && f.id==='p1'));
  assert.equal(report.pages[0].after_checks[0].present,false);
});

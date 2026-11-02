import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serializeReconstruction} from '../src/pdf-latex-serialize.mjs';
import {unicodeActualTextPreamble} from '../src/pdf-latex-unicode.mjs';

const hash='a'.repeat(64);
const ref={sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox:[36,36,576,60],range:{start:0,end:2}};
const model=text=>({schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:612,height:792,frame:'mupdf-display',transform:[1,0,0,-1,0,792]}],items:[{id:'p',kind:'paragraph',status:'observed',text,evidence:[ref]}],assets:[],diagnostics:[],relations:[]});
const replacement=(tex,patched)=>tex.replace(/(?:^\\DeclareUnicodeCharacter\{[0-9A-F]+\}\{.*\}\n)+/m, block=>{
  const entries=[...block.matchAll(/^\\DeclareUnicodeCharacter\{([0-9A-F]+)\}\{(.*)\}$/gm)].map(([,cp,glyph])=>[String.fromCodePoint(parseInt(cp,16)),glyph]);
  assert.ok(entries.length>20);
  const plain=entries.map(([ch,glyph])=>[ch,glyph.replace(/^\\pdfliteral direct\{\/Span <<\/ActualText <FEFF[0-9A-F]+>>> BDC\}(.*)\\pdfliteral direct\{EMC\}$/,'$1')]);
  if (patched) return unicodeActualTextPreamble(Object.fromEntries(plain));
  return plain.map(([ch,glyph])=>`\\DeclareUnicodeCharacter{${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}}{${glyph}}`).join('\n')+'\n';
});
function compile(dir,name,tex){
  writeFileSync(join(dir,`${name}.tex`),tex);
  const r=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error',`${name}.tex`],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
}
test('serializer emits the integrated Unicode extraction declarations',()=>{
 const emitted=new TextDecoder().decode(serializeReconstruction({model:model('naïve µ μ –')}).files[0].bytes);
 assert.match(emitted,/\/ActualText <FEFF00EF>/);
 assert.match(emitted,/\/ActualText <FEFF00B5>/);
 assert.match(emitted,/\/ActualText <FEFF03BC>/);
 assert.doesNotMatch(emitted,/\/ActualText <FEFF2013>/);
});
test('ActualText preserves mapped Unicode extraction and rendered pixels',t=>{
  if(spawnSync('pdflatex',['--version']).status!==0 || spawnSync('python',['-c','import pymupdf']).status!==0) return t.skip('requires pdflatex and PyMuPDF');
  const text='naïve ü ö é á µ μ – Plain ASCII 123.';
  const result=serializeReconstruction({model:model(text)});
  const emitted=new TextDecoder().decode(result.files[0].bytes), old=replacement(emitted,false), fixed=replacement(emitted,true);
  if (emitted.includes('/ActualText <FEFF00EF>')) assert.equal(emitted,fixed,'integrated serializer must emit the tested preamble');
  assert.notEqual(fixed,old);
  assert.match(fixed,/\\DeclareUnicodeCharacter\{2013\}\{--\}/, 'keep en dash line breaking unchanged');
  const bad=fixed.replace('/ActualText <FEFF00EF>','/ActualText <FEFF00E9>');
  assert.notEqual(bad,fixed);
  const dir=mkdtempSync(join(tmpdir(),'falsify-actualtext-'));
  try{
    compile(dir,'old',old);compile(dir,'fixed',fixed);compile(dir,'bad',bad);
    const script="import pymupdf,json,hashlib\nD=[pymupdf.open(n+'.pdf') for n in ('old','fixed','bad')]\nprint(json.dumps([{'text':d[0].get_text().strip(),'pixels':hashlib.sha256(d[0].get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False).samples).hexdigest()} for d in D],ensure_ascii=True))";
    const py=spawnSync('python',['-c',script],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);
    const [before,after,wrong]=JSON.parse(py.stdout);
    assert.notEqual(before.text,text,'the unpatched real serializer must expose the defect');
    assert.equal(after.text,text);
    assert.notEqual(wrong.text,text,'a wrong ActualText mapping must fail');
    assert.equal(after.pixels,before.pixels,'marked content must not change the rendered glyphs');
    assert.equal(wrong.pixels,before.pixels);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

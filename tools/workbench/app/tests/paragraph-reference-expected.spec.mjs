import test from 'node:test';
import assert from 'node:assert/strict';
import {compareModelNumericEdit, modelNumericEditProof, modelWordEditProof, expectedPageText} from '../src/paragraph-vendor/quality.mjs';

const before = 'Alice Author 3, Bob Writer marker';
const after = 'Alice Author 45, Bob Writer marker';
const edit = {id:'e',before,after};
const model = [{box:{x:0,top:100,w:500,h:100},runs:[{text:before}]}];
// Simulate ActualText and a raised punctuation fragment extracted out of
// paragraph order, with an extractor-generated gap immediately before 3.
const raw = 'Page Alice Author  3, Bob Writer identifier marker ! tail';
const output = 'Page Alice Author 45, Bob Writer identifier marker ! tail';
function page(text, generated = []) {
  return {chars:[...text].map((c,i)=>({u:c.charCodeAt(0),cx:i,cy:50,generated:generated.includes(i)}))};
}
const source = page(raw,[raw.indexOf(' 3')]);
const matches = (s,o=output, ps=model) => compareModelNumericEdit(s,page(o),[edit],ps);

test('word edits use unique model context while conserving every other page character',()=>{
 const before='Ada Person2,3, Writer marker',after='Ada Persons2,3, Writer marker';
 const source='Page Ada Person2,3, Writer identity marker ! tail',out=source.replace('Person','Persons');
 const p=[{box:{x:0,top:100,w:500,h:100},runs:[{text:before}]}],edits=[{before,after}];
 assert.equal(expectedPageText(source,edits).reason,'before_not_found');
 assert.ok(modelWordEditProof(page(source),page(out),edits,p));
 for(const corrupt of [out.replace('identity ',''),out.replace('identity marker','marker identity'),out+' tail',out.replace('Persons','Personz')])assert.equal(modelWordEditProof(page(source),page(corrupt),edits,p),null);
 assert.equal(modelWordEditProof(page(source),page(out),edits,[...p,...p]),null);
 assert.equal(modelWordEditProof(page(source),page(out),[...edits,...edits],p),null);
});

test('model-selected numeric edit proves full extraction despite displaced marker and generated gap',()=>{
  assert.equal(expectedPageText(raw,[edit]).reason,'before_not_found');
  assert.equal(matches(source),true);
});

test('complete text comparison rejects loss, reordering, duplication and wrong replacement',()=>{
  for (const corrupt of [output.replace('identifier ',''),output.replace('identifier marker','marker identifier'),output+' tail',output.replace('45','46')]) {
    assert.equal(matches(source,corrupt),false);
  }
  assert.equal(matches(page(raw),output.replace('Author 45','Author45')),false, 'literal whitespace cannot disappear');
});

test('source model and marker must be uniquely established',()=>{
  assert.equal(matches(source,output,[...model,...model]),false);
  assert.equal(matches(source,output,[{...model[0],box:{x:400,top:100,w:10,h:100}}]),false);
  assert.equal(compareModelNumericEdit(source,page(output),[edit,edit],model),false);
});


test('numeric insertion and multi-digit replacement preserve the entire page',()=>{
  for (const [b,a] of [['Kim2,3,','Kim2,34,'],['Kim2,3,','Kim2,63,'],['Kim2,34,','Kim2,68,']]) {
    const doc=`Heading ${b} supplementary tail`;
    const result=`Heading ${a} supplementary tail`;
    const model=[{box:{x:0,top:100,w:500,h:100},runs:[{text:b}]}];
    const edit={id:'marker',before:b,after:a};
    const check=text=>compareModelNumericEdit(page(doc),page(text),[edit],model);
    assert.equal(check(result),true, `${b} -> ${a}`);
    for (const corrupt of [result.replace('supplementary ',''),result.replace('supplementary tail','tail supplementary'),result+' tail',result.replace(a,b)]) assert.equal(check(corrupt),false);
  }
});

test('repeated numeric anchors require unique matching source context',()=>{
  const model=[{box:{x:0,top:100,w:500,h:100},runs:[{text:'Kim2,3, Pat2,3,'}]}];
  const edit={before:'Kim2,3,',after:'Kim2,34,'};
  assert.equal(compareModelNumericEdit(page('Kim2,3, Pat2,3,'),page('Kim2,34, Pat2,3,'),[edit],model),true);
  assert.equal(compareModelNumericEdit(page('Kim2,3, Pat2,3,'),page('Kim2,3, Pat2,34,'),[edit],model),false);
  assert.equal(compareModelNumericEdit(page('Kim2,3, Kim2,3,'),page('Kim2,34, Kim2,3,'),[edit],model),false);
});

test('insertion without an adjacent original digit is not a numeric anchor',()=>{
  const b='Kim,',a='Kim4,';
  assert.equal(compareModelNumericEdit(page(b),page(a),[{before:b,after:a}],[{box:{x:0,top:100,w:50,h:100},runs:[{text:b}]}]),false);
});

test('insertion works when the selected paragraph is absent from raw extraction',()=>{
  const before='Ada Kim2,3, Writer marker', after='Ada Kim2,34, Writer marker';
  const source='Page Ada Kim2,3, Writer identity marker ! tail';
  const result='Page Ada Kim2,34, Writer identity marker ! tail';
  const edit={before,after};
  const model=[{box:{x:0,top:100,w:500,h:100},runs:[{text:before}]}];
  assert.equal(expectedPageText(source,[edit]).reason,'before_not_found');
  assert.equal(compareModelNumericEdit(page(source),page(result),[edit],model),true);
  assert.equal(compareModelNumericEdit(page(source),page(result.replace('identity ','')),[edit],model),false);
});

test('full-page numeric proof distinguishes astral characters from matching low UTF-16 bits',()=>{
 const append=(p,u)=>({chars:[...p.chars,{u,cx:450,cy:30}]});
 assert.equal(compareModelNumericEdit(append(source,0x1f600),append(page(output),0x1f600),[edit],model),true);
 assert.equal(compareModelNumericEdit(append(source,0x1f600),append(page(output),0xf600),[edit],model),false);
});

test('provenance covers the complete number and every retained non-whitespace character',()=>{
  for (const [b,a,old,next] of [
    ['Kim2,3,','Kim2,34,','3','34'],
    ['Kim2,3,','Kim2,63,','3','63'],
    ['Kim2,34,','Kim2,68,','34','68'],
    ['Kim2,34,','Kim2,345,','34','345'],
  ]) {
    const src=`😀 Kim2,3, ${b} end`, out=`😀 Kim2,3, ${a} end`;
    const chars=t=>({chars:[...t].map((ch,i)=>({u:ch.codePointAt(0),cx:i,cy:50}))});
    const e={before:b,after:a};
    const model=[{box:{x:0,top:100,w:500,h:100},runs:[{text:`Kim2,3, ${b}`}]}];
    // The model must identify the selected Before uniquely, even for a
    // repeated numeric marker in another name.
    if (b==='Kim2,3,') model[0].runs[0].text=`Pat2,3, ${b}`;
    const sourceText=b==='Kim2,3,' ? src.replace('Kim2,3,','Pat2,3,') : src;
    const outputText=b==='Kim2,3,' ? out.replace('Kim2,3,','Pat2,3,') : out;
    const source=chars(sourceText),output=chars(outputText),proof=modelNumericEditProof(source,output,[e],model);
    assert.ok(proof, `${b} -> ${a}`);
    const get=(p,indices)=>indices.map(i=>String.fromCodePoint(p.chars[i].u)).join('');
    assert.equal(get(source,proof.sourceIndices),old);assert.equal(get(output,proof.outputIndices),next);
    const nonspace=p=>p.chars.flatMap((c,i)=>/\s/u.test(String.fromCodePoint(c.u))?[]:[i]);
    assert.deepEqual([...proof.sourceIndices,...proof.retained.map(x=>x.sourceIndex)].sort((x,y)=>x-y),nonspace(source));
    assert.deepEqual([...proof.outputIndices,...proof.retained.map(x=>x.outputIndex)].sort((x,y)=>x-y),nonspace(output));
    for(const pair of proof.retained)assert.equal(source.chars[pair.sourceIndex].u,output.chars[pair.outputIndex].u);
    assert.equal(proof.retained[0].sourceIndex,0);assert.equal(proof.retained[0].outputIndex,0);
    assert.equal(modelNumericEditProof(source,chars(outputText.replace(' end','')), [e],model),null);
  }
});

test('provenance maps through generated whitespace and rejects altered astral output',()=>{
  const s={chars:[...source.chars,{u:0x1f600,cx:400,cy:50}]};
  const o={chars:[...page(output).chars,{u:0x1f600,cx:400,cy:50}]};
  const proof=modelNumericEditProof(s,o,[edit],model);
  assert.ok(proof);
  assert.deepEqual(proof.sourceIndices,[raw.indexOf('3')]);
  assert.deepEqual(proof.outputIndices,[output.indexOf('45'),output.indexOf('45')+1]);
  assert.deepEqual(proof.retained.at(-1),{sourceIndex:s.chars.length-1,outputIndex:o.chars.length-1});
  o.chars.at(-1).u=0xf600;
  assert.equal(modelNumericEditProof(s,o,[edit],model),null);
  o.chars.at(-1).u=0x110000;
  assert.equal(modelNumericEditProof(s,o,[edit],model),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPage,compareSourceGeometry} from '../src/paragraph-geometry-conservation.mjs';
import {expectedPageText} from '../src/paragraph-vendor/quality.mjs';
const frame={rotation:0,transform:[1,0,0,1,0,0]};
function page(text) {
  const chars=[],glyphs=[]; let x=10;
  for(const [i,ch] of [...text].entries()) {
    const u=ch.charCodeAt(0); chars.push({u,generated:false,box:[x,x+2,10,20],origin:[x,10]});
    if(ch!==' ') glyphs.push({i,u,l:x,r:x+4,b:10,t:20,origin:[x,10],style:{size:10,mat:[1,0,0,1]}});
    x+=6;
  }
  return {W:200,H:200,frame,chars,glyphs};
}
const compare=(a,b,edits=[])=>compareSourceGeometry(a,b,edits,{expectedPageText});
test('complete index coverage and exact edits',()=>{
  const s=page('alpha beta'), o=page('alpha zeta');
  const result=compare(s,o,[{id:'e',before:'beta',after:'zeta'}]);
  assert.equal(result.match,true); assert.equal(result.sourceEvidence.mapped.length,s.chars.length);
  assert.equal(result.outputEvidence.mapped.length,o.chars.length);
});
test('missing extra swapped words and literal space fail',()=>{
  for(const text of ['alpha','alpha beta extra','beta alpha','alphabeta','alpha  beta']) {
    const result=compare(page('alpha beta'),page(text));
    // whitespace runs intentionally normalize like quality.normStr.
    if(text==='alpha  beta') assert.equal(result.match,true); else assert.equal(result.match,false,text);
  }
});
test('generated whitespace is recorded but cannot replace literal space',()=>{
  const a=page('alpha beta'), b=page('alpha beta'); b.chars[5].generated=true;
  assert.equal(compare(a,b).match,false);
  assert.deepEqual(canonicalPage(b).evidence.generatedWhitespace,[5]);
});
test('ambiguities and unsupported geometry fail closed',()=>{
  assert.equal(compare(page('a a'),page('a a'),[{before:'a',after:'b'}]).reason,'before_ambiguous');
  const r=page('abc'); r.frame={...frame,rotation:1}; assert.equal(canonicalPage(r).reason,'unsupported_frame');
  const m=page('a b'); m.chars[1].box=null; assert.equal(canonicalPage(m).reason,'literal_whitespace_geometry_unavailable');
  const c=page('ab'); c.chars[1].u=2; c.chars[1].discretionary=true; c.glyphs.pop(); assert.equal(canonicalPage(c).reason,'discretionary_break_unproven');
});
test('raised marker attaches to the body line before following punctuation',()=>{
  const p=page('ab1.'); const marker=p.glyphs[2]; marker.origin[1]=14; marker.b=14; marker.t=20; marker.style.size=6;
  assert.equal(canonicalPage(p).text,'ab1.');
});


test('discretionary break requires physical letter endpoints and is accounted',()=>{
  const p=page('abXcd'); p.chars[2]={u:2,discretionary:true,generated:false,origin:[22,10]}; p.glyphs=p.glyphs.filter(g=>g.i!==2);
  for(const g of p.glyphs.filter(g=>g.i>2)) {g.l-=18;g.r-=18;g.origin=[g.l,0];}
  const result=canonicalPage(p); assert.equal(result.ok,true); assert.equal(result.text,'abcd'); assert.deepEqual(result.evidence.normalizedDiscretionary,[2]);
  p.chars[2].discretionary=false; assert.equal(canonicalPage(p).reason,'nonspace_geometry_unavailable');
});
test('physical line breaks preserve word boundaries and literal controls',()=>{
  const p=page('ab\ncd'); p.chars[2].box=null; p.chars[2].origin=null; p.glyphs=p.glyphs.filter(g=>g.i!==2);
  for(const g of p.glyphs.filter(g=>g.i>2)) {g.l-=18;g.r-=18;g.origin=[g.l,0];}
  const result=canonicalPage(p); assert.equal(result.ok,true); assert.equal(result.text,'ab cd'); assert.deepEqual(result.evidence.boundaryWhitespace,[2]);
  assert.equal(compare(p,page('abcd')).match,false);
});
test('visible hyphen and unknown controls are never normalized away',()=>{
  assert.equal(compare(page('ab-cd'),page('abcd')).match,false);
  const p=page('abc'); p.chars[1].u=3; p.glyphs=p.glyphs.filter(g=>g.i!==1); assert.equal(canonicalPage(p).reason,'nonspace_geometry_unavailable');
});
test('a physical reflow line break can retain a source word boundary',()=>{
  const s=page('a b c'),o=page('ab d');
  for(const g of o.glyphs.filter(g=>g.i>=1)){g.l-=6;g.r-=6;g.origin=[g.l,0];}
  for(let i=1;i<o.chars.length;i++)if(o.chars[i].u===32){o.chars[i].box=[16,18,0,10];o.chars[i].origin=[16,0];}
  assert.equal(compare(s,o,[{before:'c',after:'d'}]).match,true);
  assert.equal(compare(s,page('ab d'),[{before:'c',after:'d'}]).match,false);
});

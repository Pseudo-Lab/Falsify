import test from 'node:test';
import assert from 'node:assert/strict';
import {edgeGlyphsEquivalent, alignEdgeGlyphs, matchesStationaryReorderedGlyphs} from '../src/paragraph-vendor/quality.mjs';
const style={font:'Font',flags:0,size:8.25,mat:[1,0,0,1],fill:[0,0,0,255],stroke:[0,0,0,255],render:0};
const glyph=(u,x,changes={})=>({u:u.charCodeAt(0),l:x,r:x+1,b:10,t:12,style:{...style},...changes});
const a=[glyph('A',1),glyph('B',3)];
const copy=()=>structuredClone(a);
test('equivalent transforms and append order preserve unique glyphs',()=>{
  const b=copy().reverse(); b[0].style.size=1; b[0].style.mat=[8.25,0,0,8.25];
  assert.equal(edgeGlyphsEquivalent(a,b),true);
});
test('missing, extra, duplicated, shifted or reshaped glyphs fail',()=>{
  for (const b of [copy().slice(1),[...copy(),glyph('C',5)],[...copy(),copy()[0]],copy().map((g,i)=>i?g:{...g,l:g.l+0.6}),copy().map((g,i)=>i?g:{...g,r:g.r+0.6})]) assert.equal(edgeGlyphsEquivalent(a,b),false);
});
test('font, weight, effective size, colour and render changes fail',()=>{
  for (const change of [{font:'Other'},{flags:1},{size:8.4},{fill:[1,0,0,255]},{render:1},{mat:[1.003,0,0,1]}]) {
    const b=copy(); Object.assign(b[0].style,change);
    assert.equal(edgeGlyphsEquivalent(a,b),false);
    assert.equal(alignEdgeGlyphs(a,b).restyled.length,1);
  }
});
test('normalization has a strict absolute 0.01pt component bound',()=>{
  const b=copy(); b[0].style={...style,size:1,mat:[8.259,0,0,8.25]}; assert.equal(edgeGlyphsEquivalent(a,b),true);
  b[0].style.mat[0]=8.261; assert.equal(edgeGlyphsEquivalent(a,b),false);
});
test('coincident glyphs with different styles are ambiguous',()=>{
  const source=[glyph('A',1),glyph('A',1,{style:{...style,flags:1}})];
  assert.equal(edgeGlyphsEquivalent(source,structuredClone(source).reverse()),false);
});
test('unchanged duplicate paint entries preserve their original order and multiplicity',()=>{
  const source=[glyph('A',1),glyph('A',1)];
  assert.equal(edgeGlyphsEquivalent(source,structuredClone(source)),true);
  assert.equal(edgeGlyphsEquivalent(source,source.slice(1)),false);
  const layered=[glyph('A',1),glyph('A',1,{style:{...style,flags:1}})];
  assert.equal(edgeGlyphsEquivalent(layered,structuredClone(layered)),true);
  assert.equal(edgeGlyphsEquivalent(layered,structuredClone(layered).reverse()),false);
});
test('fragment deletion normalizes joined whitespace before proving stationary extraction order',()=>{
  const sourceText='A bad B1',targetText='A 1B';
  const source={styled:true,text:sourceText,chars:[...sourceText].map(ch=>({u:ch.charCodeAt(0),generated:false})),glyphs:[...sourceText].flatMap((ch,i)=>ch===' '?[]:[{...glyph(ch,i*3),i}])};
  const output={styled:true,text:targetText,chars:[...targetText].map(ch=>({u:ch.charCodeAt(0),generated:false})),glyphs:[...targetText].flatMap((ch,i)=>ch===' '?[]:[{...source.glyphs.find(g=>g.u===ch.charCodeAt(0)),i}])};
  assert.equal(matchesStationaryReorderedGlyphs(source,output,[{before:'bad',after:''}]),true);
  const shifted=structuredClone(output);shifted.glyphs.find(g=>g.u===66).l+=1;
  assert.equal(matchesStationaryReorderedGlyphs(source,shifted,[{before:'bad',after:''}]),false);
  const missing={...output,text:'A B',chars:output.chars.slice(0,-1),glyphs:output.glyphs.slice(0,-1)};
  assert.equal(matchesStationaryReorderedGlyphs(source,missing,[{before:'bad',after:''}]),false);
});

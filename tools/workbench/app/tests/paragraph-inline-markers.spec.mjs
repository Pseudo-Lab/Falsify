import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planInlineMarkers} from '../src/paragraph-inline-markers.mjs';
const bodyStyle={size:1,mat:[10,0,0,10],font:'body',fill:[0,0,0,255]};
const markerStyle={size:1,mat:[6,0,0,6],font:'note',fill:[0,0,255,255]};
function fixture({shift=0,duplicate=false}={}) {
 let i=0, gs=[];
 function sentence(y,obj,dx=0) {let x=30+dx; for(const c of 'alpha bravo charlie delta') {if(c===' '){x+=4;continue;} gs.push({u:c.codePointAt(0),l:x,r:x+4,b:y,t:y+8,i:i++,obj,origin:[x,y],style:bodyStyle});x+=4;}return x;}
 const end=sentence(100,1,shift);
 if(duplicate) sentence(80,3,shift);
 const x=end-shift;
 gs.push({u:49,l:x,r:x+3,b:104,t:109,i:i++,obj:2,origin:[x,104],style:markerStyle});
 return {glyphs:gs,W:600};
}
test('moves a uniquely anchored superscript with its reflowed body',()=>{
 const plan=planInlineMarkers(fixture(),fixture({shift:15}));
 assert.equal(plan.repairs.length,1);assert.equal(plan.repairs[0].dx,15);assert.equal(plan.repairs[0].dy,0);
});
test('duplicate body context is left unresolved',()=>{
 const plan=planInlineMarkers(fixture(),fixture({shift:15,duplicate:true}));
 assert.equal(plan.repairs.length,0);assert.ok(plan.warnings.some(w=>w.code==='inline_marker_ambiguous'));
});


test('matches context across changed line wrapping',()=>{
 const source=fixture(), output=fixture({shift:15});
 // Reflow the first half of the source context onto a preceding line.
 const body=source.glyphs.filter(g=>g.obj===1);
 for(const g of body.slice(0,10)){g.origin[1]+=12;g.b+=12;g.t+=12;}
 const plan=planInlineMarkers(source,output);
 assert.equal(plan.repairs.length,1); assert.equal(plan.repairs[0].dx,15);
});
test('moves a marker split into objects together',()=>{
 const source=fixture(), output=fixture({shift:15});
 for(const page of [source,output]) {
  const g=page.glyphs.at(-1);
  page.glyphs.push({...g,u:50,l:g.l+3,r:g.r+3,i:g.i+1,obj:4,origin:[g.origin[0]+3,g.origin[1]]});
 }
 const plan=planInlineMarkers(source,output);
 assert.equal(plan.repairs.length,2); assert.deepEqual(plan.repairs.map(r=>r.dx),[15,15]);
});
test('does not move an object containing unrelated body glyphs',()=>{
 const source=fixture(), output=fixture({shift:15});
 output.glyphs[0].obj=2;
 const plan=planInlineMarkers(source,output);
 assert.equal(plan.repairs.length,0); assert.ok(plan.warnings.some(w=>w.code==='inline_marker_object_ambiguous'));
});

test('anchors to closing punctuation across reflow without losing its geometry',()=>{
 const source=fixture(), output=fixture({shift:15});
 for(const page of [source,output]) {
  const marker=page.glyphs.pop(), parent=page.glyphs.at(-1);
  const x=parent.r;
  page.glyphs.push({...parent,u:41,l:x,r:x+3,i:parent.i+1,origin:[x,parent.origin[1]]});
  if(page===source) {marker.l+=3; marker.r+=3; marker.origin[0]+=3;}
  page.glyphs.push(marker);
 }
 const plan=planInlineMarkers(source,output);
 assert.equal(plan.repairs.length,1); assert.equal(plan.repairs[0].dx,18);
});
test('moves source-proven following punctuation even when the marker is already aligned',()=>{
 const source=fixture(), output=fixture();
 for(const page of [source,output]) {
  const marker=page.glyphs.at(-1), parent=page.glyphs.find(g=>g.obj===1);
  const x=marker.r+1;
  page.glyphs.push({...parent,u:46,l:x,r:x+1,i:marker.i+1,obj:9,origin:[x,100]});
 }
 for(const g of output.glyphs.filter(g=>g.obj!==9)) {g.origin[1]-=20; g.b-=20; g.t-=20;}
 const plan=planInlineMarkers(source,output);
 assert.deepEqual(plan.repairs.map(r=>[r.object,r.dx,r.dy]),[[9,0,-20]]);
});
test('does not move following punctuation in an object shared with other text',()=>{
 const source=fixture(), output=fixture();
 for(const page of [source,output]) {
  const marker=page.glyphs.at(-1), parent=page.glyphs.find(g=>g.obj===1), x=marker.r+1;
  page.glyphs.push({...parent,u:46,l:x,r:x+1,i:marker.i+1,obj:page===output?1:9,origin:[x,100]});
 }
 for(const g of output.glyphs.filter(g=>g.i<output.glyphs.at(-1).i)) {g.origin[1]-=20; g.b-=20; g.t-=20;}
 const plan=planInlineMarkers(source,output);
 assert.ok(plan.warnings.some(w=>w.code==='inline_marker_punctuation_ambiguous'));
 assert.ok(plan.repairs.every(r=>r.object!==1));
});
test('missing output marker does not move punctuation',()=>{
 const source=fixture(), output=fixture({shift:15}); output.glyphs.pop();
 const plan=planInlineMarkers(source,output);
 assert.equal(plan.repairs.length,0); assert.ok(plan.warnings.some(w=>w.code==='inline_marker_ambiguous'));
});

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
test('generated word spaces need a proven physical boundary',()=>{
  const a=page('alpha beta'), b=page('alpha beta'); b.chars[5].generated=true;
  assert.equal(compare(a,b).match,true);
  b.chars[5].origin=[0,100];
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
test('stationary script ownership does not depend on raw PDF object order',()=>{
  const normal=page('a1b');normal.glyphs[1].origin[1]=14;normal.glyphs[1].b=14;normal.glyphs[1].style.size=6;
  const reordered=structuredClone(normal),order=[1,0,2];
  reordered.chars=order.map(i=>normal.chars[i]);
  reordered.glyphs=order.map((old,i)=>({...structuredClone(normal.glyphs[old]),i}));
  assert.equal(canonicalPage(normal).text,'a1b');
  assert.equal(canonicalPage(reordered).text,'a1b');
  const lost=structuredClone(reordered);lost.glyphs.shift();
  assert.equal(canonicalPage(lost).ok,false);
});


test('discretionary break requires physical letter endpoints and is accounted',()=>{
  const p=page('abXcd'); p.chars[2]={u:2,discretionary:true,generated:false,origin:[22,10]}; p.glyphs=p.glyphs.filter(g=>g.i!==2);
  for(const g of p.glyphs.filter(g=>g.i>2)) {g.l-=18;g.r-=18;g.origin=[g.l,0];}
  const result=canonicalPage(p); assert.equal(result.ok,true); assert.equal(result.text,'abcd'); assert.deepEqual(result.evidence.normalizedDiscretionary,[2]);
  p.chars[2].discretionary=false; assert.equal(canonicalPage(p).reason,'nonspace_geometry_unavailable');
});
test('discretionary join remains in its column when a nearby second column starts across midpoint',()=>{
  const p=page('abXcdYZ'); p.chars[2]={u:2,discretionary:true,generated:false,origin:[92,10]};
  p.glyphs=p.glyphs.filter(g=>g.i!==2);
  for(const g of p.glyphs) {
    const x=g.i<2?80+g.i*6:g.i<5?80+(g.i-3)*6:105;
    const y=g.i<3||g.i===5?10:0;
    Object.assign(g,{l:x,r:x+4,b:y,t:y+10,origin:[x,y]});
  }
  const result=canonicalPage(p);
  assert.equal(result.ok,true); assert.equal(result.text,'abcd Y Z');
  assert.deepEqual(result.evidence.normalizedDiscretionary,[2]);
  const bad=structuredClone(p); bad.chars[2].origin[0]=120;
  assert.equal(canonicalPage(bad).reason,'discretionary_break_unproven');
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

test('literal whitespace on an attached script baseline keeps its raw ownership',()=>{
  const make=()=>{
    const p=page('xn+1 should');
    for(const g of p.glyphs.filter(g=>g.i>=1 && g.i<=3)) {g.origin[1]=14;g.b=14;g.t=20;g.style.size=6;}
    p.chars[4].origin[1]=14; p.chars[4].box[2]=14; p.chars[4].box[3]=20;
    return p;
  };
  const p=make(), c=canonicalPage(p);
  assert.equal(c.ok,true); assert.equal(c.text,'xn+1 should');
  assert.equal(c.evidence.mapped.length,p.chars.length);
  assert.equal(compare(p,make()).match,true);
  assert.equal(compare(p,page('xn+1should')).match,false);
  assert.equal(compare(p,page('xn+ 1 should')).match,false);
  assert.equal(compare(p,page('x+ n1 should')).match,false);
  const unrelated=make(); unrelated.chars[4].origin[0]=150; unrelated.chars[4].box[0]=150; unrelated.chars[4].box[1]=152;
  assert.equal(canonicalPage(unrelated).reason,'literal_whitespace_line_ambiguous');
  const different=make(); different.glyphs.find(g=>g.i===3).style.size=11;
  assert.equal(canonicalPage(different).ok,false);
});

test('script alias cannot claim whitespace also owned by another baseline',()=>{
  const p=page('xn a');
  const marker=p.glyphs.find(g=>g.i===1); marker.origin[1]=14; marker.b=14; marker.t=20; marker.style.size=6;
  p.chars[2].origin[1]=14; p.chars[2].box[2]=14; p.chars[2].box[3]=20;
  // Another independently surviving line at the same baseline makes ownership ambiguous.
  const extra={...p.glyphs.find(g=>g.i===3),l:80,r:84,origin:[80,14],style:{size:10,mat:[1,0,0,1]}};
  p.glyphs.push(extra); p.chars[3].u=extra.u;
  p.glyphs=p.glyphs.filter((g,idx)=>g.i!==3 || idx===p.glyphs.length-1);
  assert.equal(canonicalPage(p).reason,'literal_whitespace_line_ambiguous');
});

test('invalid inverses and explicit partitions fail closed',()=>{
  const p=page('a');
  p.frame={rotation:0,transform:[1e-320,0,0,1e-320,0,0]};
  assert.equal(canonicalPage(p).reason,'unsupported_frame');
  assert.equal(canonicalPage(p,100).reason,'unsupported_frame');
  p.frame=frame;
  for(const partition of [NaN,Infinity,-Infinity]) assert.equal(canonicalPage(p,partition).reason,'unsupported_frame');
  for(const [rotation,transform] of [[1,[0,-1,1,0,0,200]],[2,[-1,0,0,-1,200,200]],[3,[0,1,-1,0,200,0]]]) {
    p.frame={rotation,transform}; assert.equal(canonicalPage(p).ok,true);
  }
});

test('columns and midpoint-crossing lines retain physical order at realistic page scale',()=>{
  const make=spec=>{
    const chars=[],glyphs=[];
    for(const [i,{ch,x,y}] of spec.entries()) {
      const u=ch.charCodeAt(0); chars.push({u});
      glyphs.push({i,u,l:x,r:x+4,b:y,t:y+10,origin:[x,y],style:{size:10,mat:[1,0,0,1]}});
    }
    return {W:200,H:1100,frame,chars,glyphs};
  };
  const cols=make([{ch:'A',x:10,y:100},{ch:'A',x:110,y:100},{ch:'B',x:10,y:80},{ch:'B',x:110,y:80}]);
  assert.equal(canonicalPage(cols).text,'A B A B');
  const cross=make([{ch:'A',x:94,y:100},{ch:'B',x:100,y:100},{ch:'C',x:106,y:100}]);
  assert.equal(canonicalPage(cross).text,'ABC');
  const large=make(Array.from({length:6000},(_,i)=>({ch:String.fromCharCode(65+i%26),x:10+(i%100)*5,y:1000-Math.floor(i/100)*12})));
  large.W=600;
  const result=canonicalPage(large);
  assert.equal(result.ok,true); assert.equal(result.evidence.mapped.length,6000);
  assert.equal(result.text.replaceAll(' ','').length,6000);
});

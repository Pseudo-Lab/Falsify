import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizedEdgeChanges,expectedPageText,checkContinuationEdges} from '../src/paragraph-vendor/quality.mjs';
import {compareSourceGeometry} from '../src/paragraph-geometry-conservation.mjs';
const style={font:'T',flags:0,size:10,fill:[0,0,0,255],stroke:[0,0,0,255],render:0,mat:[1,0,0,1]};
test('unexpected continuation edge glyphs remain a failure',()=>{
 const failures=[]; const extra={u:71,l:10,r:14,b:180,t:190,origin:[10,180],obj:1,style};
 checkContinuationEdges({styled:true,W:200},[],{styled:true},[extra],1,0,1,failures);
 assert.ok(failures.some(f=>f.code==='continuation_edge_extra'));
});
function page(text, rotation=0) {
 const chars=[],glyphs=[];let x=10;
 for(let i=0;i<text.length;i++){const u=text.charCodeAt(i);chars.push({u,generated:false,box:[x,x+2,10,20],origin:[x,10]});if(u!==32)glyphs.push({i,u,l:x,r:x+4,b:10,t:20,origin:[x,10],style});x+=6;}
 const matrices=[[1,0,0,1,0,0],[0,-1,1,0,0,200],[-1,0,0,-1,200,200],[0,1,-1,0,200,0]];
 return {text,chars,glyphs,styled:true,W:200,H:200,frame:{rotation,transform:matrices[rotation]}};
}
test('edge authorization uses edited positions and rejects unrelated movement or loss',()=>{
 const a=page('A old text footer'),b=page('A new text footer'),edits=[{before:'A old text',after:'A new text'}];
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs),true);
 const moved=structuredClone(b);let f=moved.glyphs.find(g=>g.i===11);f.l+=4;f.r+=4;
 assert.equal(authorizedEdgeChanges(a,moved,edits,a.glyphs,moved.glyphs),false);
 const missing=structuredClone(b);missing.glyphs=missing.glyphs.filter(g=>g.i!==11);
 assert.equal(authorizedEdgeChanges(a,missing,edits,a.glyphs,missing.glyphs),false);
});
test('only complete rigid downward movement of source body below an edit is authorized',()=>{
 const a=page('A old text footer'),b=page('A new text footer'),edits=[{before:'A old text',after:'A new text'}];
 for(const p of [a,b]) for(const g of p.glyphs) if(g.i<10){g.b+=30;g.t+=30;g.origin[1]+=30;}
 for(const g of b.glyphs) if(g.i>=11){g.b-=5;g.t-=5;g.origin[1]-=5;}
 const box={x:60,top:20,w:50,h:10};
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs,[box]),true);
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs,[box,{...box}]),false);
 const moved=structuredClone(b); moved.glyphs.find(g=>g.i===11).l+=3;
 assert.equal(authorizedEdgeChanges(a,moved,edits,a.glyphs,moved.glyphs,[box]),false);
 const lost=structuredClone(b); lost.glyphs=lost.glyphs.filter(g=>g.i!==11);
 assert.equal(authorizedEdgeChanges(a,lost,edits,a.glyphs,lost.glyphs,[box]),false);
 const restyled=structuredClone(b); restyled.glyphs.find(g=>g.i===11).style.size=14;
 assert.equal(authorizedEdgeChanges(a,restyled,edits,a.glyphs,restyled.glyphs,[box]),false);
 const missingAfter=page('A bad text footer');
 assert.equal(authorizedEdgeChanges(a,missingAfter,edits,a.glyphs,missingAfter.glyphs,[box]),false);
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs,[]),false);
});
test('retained glyphs in edited body reflow with bounded contiguous geometry',()=>{
 const a=page('A old text footer'),b=page('A new text footer'),edits=[{before:'old',after:'new'}];
 const box={x:10,top:20,w:60,h:10};
 for(const g of b.glyphs) if(g.i>=6&&g.i<=9){g.b-=8;g.t-=8;g.origin[1]-=8;}
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs,[box]),true);
 assert.equal(authorizedEdgeChanges(a,b,edits,a.glyphs,b.glyphs,[box,{...box}]),false);
 const displaced=structuredClone(b);for(const g of displaced.glyphs)if(g.i>=6&&g.i<=9){g.b-=100;g.t-=100;g.origin[1]-=100;}
 assert.equal(authorizedEdgeChanges(a,displaced,edits,a.glyphs,displaced.glyphs,[box]),false);
 const styleChanged=structuredClone(b);styleChanged.glyphs.find(g=>g.i===6).style.size=12;
 assert.equal(authorizedEdgeChanges(a,styleChanged,edits,a.glyphs,styleChanged.glyphs,[box]),false);
});
test('quarter-turn frames conserve text and reject missing replacement or invalid transforms',()=>{
 for(const r of [1,2,3]){const a=page('alpha beta',r),b=page('alpha zeta',r),edits=[{before:'beta',after:'zeta'}];
 assert.equal(compareSourceGeometry(a,b,edits,{expectedPageText}).match,true);
 assert.equal(compareSourceGeometry(a,page('alpha',r),edits,{expectedPageText}).match,false);
 const invalid=structuredClone(b);invalid.frame.transform[0]=.25;assert.equal(compareSourceGeometry(a,invalid,edits,{expectedPageText}).ok,false);
 }
});
test('reverse extracted object separator needs a unique physical gap',()=>{
 const p=page('ab cd',2);p.glyphs.forEach(g=>g.obj=g.i<2?1:2);
 // Raw stream: second object, generated separator, first object.
 const order=[3,4,2,0,1];const original=structuredClone(p);
 p.chars=order.map(i=>original.chars[i]);p.chars[2].generated=true;
 p.glyphs=original.glyphs.map(g=>({...g,i:order.indexOf(g.i)}));p.text='cd ab';
 const result=compareSourceGeometry(original,p,[],{expectedPageText});assert.equal(result.match,true);
 const broken=structuredClone(p);broken.glyphs.find(g=>g.i===0).l=100;assert.notEqual(compareSourceGeometry(original,broken,[],{expectedPageText}).match,true);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {resolveOutputAssetSpans as resolve} from '../src/paper-asset-spans.mjs';
function pdf(content,rotation=0) {
 const d=new mupdf.PDFDocument(), pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],false), image=new mupdf.Image(pix);
 try {const ref=d.addImage(image);d.insertPage(-1,d.addPage([0,0,300,400],rotation,{XObject:{im:ref}},content));const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}} finally {image.destroy();pix.destroy();d.destroy();}
}
const placement='q 100 0 0 50 20 250 cm /im Do Q';
const flow={items:[{kind:'asset',renderAssetId:'capture',assetIds:['original'],source:{pageIndex:0,bbox:[2,3,202,103]}}]};
const marker={id:'capture',sourcePage:0,start:{page:1,x:20,y:100},end:{page:1,x:20,y:150}};
const run=(content=placement, f=flow, m=[marker])=>resolve({bytes:pdf(content),mupdf,flow:f,blockSpans:m});
test('unique actual image placement with source-bound aliases',()=>{const r=run();assert.deepEqual(r.spans,[{id:'capture',pageIndex:0,bbox:[20,100,120,150]},{id:'original',pageIndex:0,bbox:[20,100,120,150]}]);assert.equal(r.evidence[0].reason,'resolved');});
test('ambiguous duplicate occurrences are unavailable',()=>{assert.equal(run(placement+' '+placement).evidence[0].reason,'ambiguous-placement');});
test('offset marker, wrong aspect and stale IDs remain unavailable',()=>{assert.equal(run(placement,flow,[{...marker,start:{...marker.start,x:40},end:{...marker.end,x:40}}]).spans.length,0);assert.equal(run(placement,{items:[{...flow.items[0],source:{pageIndex:0,bbox:[0,0,10,100]}}]}).spans.length,0);assert.equal(run(placement,flow,[{...marker,id:'stale'}]).spans.length,0);});
test('cross page, missing end, vector and rotated placement are unavailable',()=>{assert.equal(run(placement,flow,[{...marker,end:{...marker.end,page:2}}]).spans.length,0);assert.equal(run(placement,flow,[{...marker,end:null}]).spans.length,0);assert.equal(run('20 250 100 50 re f').spans.length,0);assert.equal(run('q 0 100 -50 0 120 250 cm /im Do Q').spans.length,0);});
test('same image resource repeated elsewhere only selects nominated occurrence',()=>{assert.deepEqual(run(placement+' q 100 0 0 50 160 250 cm /im Do Q').spans[0].bbox,[20,100,120,150]);});
test('shared source ownership, clipping and wrong scale fail closed',()=>{assert.equal(run(placement,{items:[flow.items[0],{...flow.items[0],renderAssetId:'other'}]}).spans.length,0);assert.equal(run('q 20 260 50 40 re W n '+placement+' Q').spans.length,0);assert.equal(run('q 100 0 0 60 20 240 cm /im Do Q').spans.length,0);});

test('overlapping panel image is not mistaken for a unique capture',()=>{const r=run(placement+' q 30 0 0 20 40 260 cm /im Do Q');assert.equal(r.evidence[0].reason,'overlapping-placement');assert.deepEqual(r.spans,[]);});


test('full rectangular clip including an explicit closing segment preserves placement',()=>{
 const clip='q 10 240 m 130 240 l 130 310 l 10 310 l 10 240 l h W n ';
 assert.equal(run(clip+placement+' Q').evidence[0].reason,'resolved');
});
test('overlapping distinct source figures cannot claim geometry',()=>{
 const other={...flow.items[0],renderAssetId:'other',assetIds:['other-original'],source:{pageIndex:0,bbox:[100,20,220,90]}};
 const r=run(placement,{items:[flow.items[0],other]});
 assert.equal(r.evidence[0].reason,'overlapping-source-assets');
 assert.deepEqual(r.spans,[]);
});

// Device events mimic MuPDF's mask lifecycle, including the pop of the resulting clip.
function maskEvents(events) {
 const image=()=>({destroy(){},getMask(){return null;}});
 const fake={Matrix:{identity:[]},Device:class {constructor(cb){this.cb=cb;} close(){} destroy(){}},Document:{openDocument(){return {countPages:()=>1,loadPage:()=>({getBounds:()=>[0,0,300,400],run(dev){events(dev.cb,image);},destroy(){}}),destroy(){}};}}};
 return resolve({bytes:new Uint8Array([1]),mupdf:fake,flow,blockSpans:[marker]});
}
test('mask scope rejects masked placements but permits later unrelated images',()=>{
 const masked=maskEvents((d,image)=>{d.beginMask([],false,null);d.endMask();d.fillImage(image(),[100,0,0,50,20,100],1);d.popClip();});
 assert.equal(masked.spans.length,0);
 assert.equal(masked.evidence[0].reason,'masked-or-clipped-placement');
 const unrelated=maskEvents((d,image)=>{d.beginMask([],false,null);d.endMask();d.fillImage(image(),[10,0,0,10,200,200],1);d.popClip();d.fillImage(image(),[100,0,0,50,20,100],1);});
 assert.equal(unrelated.evidence[0].reason,'resolved');
});
test('image masks elsewhere do not invalidate a page but overlapping masks do',()=>{
 const unrelated=maskEvents((d,image)=>{d.fillImageMask(image(),[10,0,0,10,200,200]);d.fillImage(image(),[100,0,0,50,20,100],1);});
 assert.equal(unrelated.evidence[0].reason,'resolved');
 const overlap=maskEvents((d,image)=>{d.fillImageMask(image(),[10,0,0,10,30,110]);d.fillImage(image(),[100,0,0,50,20,100],1);});
 assert.equal(overlap.evidence[0].reason,'overlapping-placement');
});


test('real PDF intrinsic soft mask preserves image placement geometry',()=>{
 const d=new mupdf.PDFDocument(), pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],false), alpha=new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray,[0,0,2,2],false);
 alpha.getPixels().set([0,255,128,255]);
 const mask=new mupdf.Image(alpha), image=new mupdf.Image(pix,mask);
 try {const ref=d.addImage(image);d.insertPage(-1,d.addPage([0,0,300,400],0,{XObject:{im:ref}},placement));const buf=d.saveToBuffer();try {const r=resolve({bytes:buf.asUint8Array().slice(),mupdf,flow,blockSpans:[marker]});assert.equal(r.evidence[0].reason,'resolved');} finally {buf.destroy();}} finally {image.destroy();mask.destroy();alpha.destroy();pix.destroy();d.destroy();}
});
test('separate image mask remains unavailable even at the same transform',()=>{
 const fakeMask={pointer:10,destroy(){}};
 const r=maskEvents((d,image)=>{d.clipImageMask(fakeMask,[100,0,0,50,20,100]);d.fillImage(image(),[100,0,0,50,20,100],1);d.popClip();});
 assert.equal(r.evidence[0].reason,'masked-or-clipped-placement');
});

test('real PDF global soft mask is not confused with intrinsic alpha',()=>{
 const d=new mupdf.PDFDocument(), pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],false), image=new mupdf.Image(pix);
 try {
  const ref=d.addImage(image);
  const group=d.addStream('0.5 g 0 0 300 400 re f',{Type:'XObject',Subtype:'Form',BBox:[0,0,300,400],Group:{S:'Transparency',CS:'DeviceGray'}});
  const gs=d.addObject({Type:'ExtGState',SMask:{S:'Luminosity',G:group}});
  d.insertPage(-1,d.addPage([0,0,300,400],0,{XObject:{im:ref},ExtGState:{gs}},'q /gs gs '+placement+' Q'));
  const buf=d.saveToBuffer();try {const r=resolve({bytes:buf.asUint8Array().slice(),mupdf,flow,blockSpans:[marker]});assert.equal(r.evidence[0].reason,'masked-or-clipped-placement');assert.deepEqual(r.spans,[]);} finally {buf.destroy();}
 } finally {image.destroy();pix.destroy();d.destroy();}
});

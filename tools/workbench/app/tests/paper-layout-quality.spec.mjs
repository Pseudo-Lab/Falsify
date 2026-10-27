import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {inspectLayoutQuality} from '../src/paper-layout-quality.mjs';

function fixture({overlap=false,outside=false,small=false,separated=false,clip=false}={}) {
  const d=new mupdf.PDFDocument(), font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);
  const image=new mupdf.Image(pix), im=d.addImage(image);
  const line=(text,x,y,size=12)=>`BT /F ${size} Tf ${x} ${y} Td (${text}) Tj ET\n`;
  let stream='q 100 0 0 80 80 200 cm /Im Do Q\n';
  stream+=line('Figure label',100,240,10);
  stream+=line('Figure 1. A useful illustration',80,separated?90:180,10);
  stream+=line('This is normal body text with enough characters.',30,140,small?6:12);
  if(overlap) stream+=line('Another overlapping sentence',65,140,12);
  if(outside) stream+=line('Outside',-10,320);
  if(clip) stream+='q 30 310 12 20 re W n '+line('Clipped text',30,315)+'Q\n';
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));
  const buf=d.saveToBuffer(),bytes=buf.asUint8Array().slice();buf.destroy();image.destroy();pix.destroy();d.destroy();return bytes;
}
const profile={coordinateSpace:'output',bodyLines:[{text:'This is normal body text with enough characters.'}],bodyFontSize:12,captions:[{text:'Figure 1. A useful illustration',assetPageIndex:0,assetBbox:[80,120,180,200]}]};
test('real output PDF reports localized defects and a corrected candidate improves score',()=>{
  const bad=inspectLayoutQuality({bytes:fixture({overlap:true,outside:true,small:true,separated:true}),mupdf,profile});
  const good=inspectLayoutQuality({bytes:fixture(),mupdf,profile});
  assert.equal(bad.status,'partial',JSON.stringify(bad));
  for(const type of ['text-overlap','ink-outside-page','small-body-text','caption-separated']) assert.ok(bad.issues.some(i=>i.type===type),`${type}: ${JSON.stringify(bad)}`);
  assert.ok(good.detectedIssuesScore>bad.detectedIssuesScore);
  assert.ok(!good.issues.some(i=>['text-image-overlap','small-body-text','caption-separated'].includes(i.type)),JSON.stringify(good));
  assert.ok(bad.issues.every(i=>i.pageIndex===0 && i.bbox.length===4 && i.penalty>0));
});
test('missing engine and unmatched caption never claim verification',()=>{
  assert.equal(inspectLayoutQuality({bytes:fixture()}).status,'unavailable');
  const r=inspectLayoutQuality({bytes:fixture(),mupdf,profile:{coordinateSpace:'output',captions:[{text:'Invented caption',assetPageIndex:0,assetBbox:[80,120,180,200]}]}});
  assert.ok(r.limitations.some(x=>x.includes('could not be uniquely observed')));
  assert.equal(r.coverage.clipping,'partial: axis-aligned rectangular paths only');
});
test('profiled headings and columns report observable orphan and empty column candidates',()=>{
  const r=inspectLayoutQuality({bytes:fixture(),mupdf,profile:{coordinateSpace:'output',headings:[{text:'This is normal body text with enough characters.'}],columns:[{pageIndex:0,bbox:[220,20,290,80],anchorText:'This is normal body text with enough characters.'}]}});
  assert.ok(r.issues.some(i=>i.type==='heading-orphan'));
  assert.ok(r.issues.some(i=>i.type==='blank-column'));
});


test('a real rectangular clip detects clipped text',()=>{
  const r=inspectLayoutQuality({bytes:fixture({clip:true}),mupdf});
  assert.equal(r.coverage.clipping,'partial: axis-aligned rectangular paths only');
  assert.ok(r.issues.some(x=>x.type==='text-clipped'),JSON.stringify(r));
});

test('clipped image is permitted and long caption ink outside page is detected',()=>{
  const make=(oversized=false)=>{
    const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
    const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);const image=new mupdf.Image(pix),im=d.addImage(image);
    const stream=`q 80 200 50 50 re W n 100 0 0 80 80 200 cm /Im Do Q\nBT /F 12 Tf 30 ${oversized?-5:30} Td (Figure 1. Long caption ending at the page edge) Tj ET`;
    d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));const buf=d.saveToBuffer(),bytes=buf.asUint8Array().slice();buf.destroy();image.destroy();pix.destroy();d.destroy();return bytes;
  };
  const good=inspectLayoutQuality({bytes:make(),mupdf}),bad=inspectLayoutQuality({bytes:make(true),mupdf});
  assert.ok(!good.issues.some(i=>i.type==='text-clipped'||i.type==='ink-outside-page'),JSON.stringify(good));
  assert.ok(bad.issues.some(i=>i.type==='ink-outside-page'),JSON.stringify(bad));
});
test('font, column and heading profiles have meaningful positive and negative examples',()=>{
  const bytes=fixture();
  const bad=inspectLayoutQuality({bytes,mupdf,profile:{coordinateSpace:'output',bodyLines:[{text:'This is normal body text with enough characters.'}],outputBodyFontNames:['NotHelvetica'],columns:[{pageIndex:0,bbox:[220,20,290,80],anchorText:'This is normal body text with enough characters.'}],headings:[{text:'This is normal body text with enough characters.'}]}});
  for(const type of ['body-font-deviation','blank-column','heading-orphan']) assert.ok(bad.issues.some(i=>i.type===type),type);
  const good=inspectLayoutQuality({bytes,mupdf,profile:{coordinateSpace:'output',bodyLines:[{text:'This is normal body text with enough characters.'}],outputBodyFontNames:['Helvetica'],columns:[{pageIndex:0,bbox:[20,240,200,280],anchorText:'Figure label'}],headings:[{text:'Figure 1. A useful illustration'}]}});
  for(const type of ['body-font-deviation','blank-column','heading-orphan']) assert.ok(!good.issues.some(i=>i.type===type),JSON.stringify(good));
});

test('source coordinates and subset font names do not claim output geometry after repagination',()=>{
  const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);const image=new mupdf.Image(pix),im=d.addImage(image);
  const line=(t,x,y,size=12)=>`BT /F ${size} Tf ${x} ${y} Td (${t}) Tj ET\n`;
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},line('Earlier page text.',30,300)));
  let stream='q 100 0 0 80 80 200 cm /Im Do Q\n'+line('Figure 1. A useful illustration',80,180,10)+line('This is normal body text with enough characters.',30,120,6);
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));const buf=d.saveToBuffer(),bytes=buf.asUint8Array().slice();buf.destroy();image.destroy();pix.destroy();d.destroy();
  const base={bodyFontSize:12,bodyFontNames:['ABCDEF+SourceFont'],bodyLines:[{text:'This is normal body text with enough characters.'}],captions:[{id:'cap',text:'Figure 1. A useful illustration',assetPageIndex:0,assetBbox:[80,120,180,200]}],columns:[{pageIndex:0,bbox:[220,20,290,80],anchorText:'This is normal body text with enough characters.'}]};
  for(const coordinateSpace of ['source',undefined]) {
    const r=inspectLayoutQuality({bytes,mupdf,profile:{...base,coordinateSpace}});
    assert.ok(r.issues.some(i=>i.type==='small-body-text' && i.pageIndex===1));
    assert.ok(!r.issues.some(i=>['caption-separated','blank-column','body-font-deviation'].includes(i.type)),JSON.stringify(r));
    assert.equal(r.coverage.profile.captions.skipped,1);assert.equal(r.coverage.profile.columns.skipped,1);assert.equal(r.coverage.profile.fontNames.skipped,1);assert.equal(r.captionObservations[0].status,'unavailable');
    assert.equal(r.score,null);
  }
  const output=inspectLayoutQuality({bytes,mupdf,profile:{...base,coordinateSpace:'output',captions:[{...base.captions[0],assetPageIndex:1}],columns:[{pageIndex:1,bbox:[220,20,290,80],anchorText:'This is normal body text with enough characters.'}],outputBodyFontNames:['Helvetica']}});
  assert.equal(output.captionObservations[0].status,'observed');assert.equal(output.coverage.profile.captions.checked,1);assert.ok(output.issues.some(i=>i.type==='blank-column'));assert.ok(!output.issues.some(i=>i.type==='body-font-deviation'));
  const noAnchor=inspectLayoutQuality({bytes,mupdf,profile:{coordinateSpace:'output',columns:[{pageIndex:1,bbox:[220,20,290,80]}]}});assert.equal(noAnchor.coverage.profile.columns.skipped,1);assert.ok(!noAnchor.issues.some(i=>i.type==='blank-column'));
  const noBody=inspectLayoutQuality({bytes,mupdf,profile:{coordinateSpace:'source',bodyFontSize:12,bodyFontNames:['ABCDEF+SourceFont']}});
  assert.ok(!noBody.issues.some(i=>i.type==='small-body-text'||i.type==='body-font-deviation'));assert.equal(noBody.coverage.profile.bodyLines.skipped,1);
});

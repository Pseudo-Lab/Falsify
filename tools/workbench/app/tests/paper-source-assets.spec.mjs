import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {readDocument} from '../src/paper-document.mjs';
import {readSourceAssets} from '../src/paper-source-assets.mjs';

function fixture() {
  const doc=new mupdf.PDFDocument();
  const page=doc.addPage([0,0,200,300],90,{},'0 0 0 RG 2 w 30 40 80 70 re S 30 40 m 110 110 l S\n');
  doc.insertPage(0,page);
  const p=doc.loadPage(0); p.setPageBox('CropBox',[10,20,180,280]); p.destroy();
  const buffer=doc.saveToBuffer(''); const bytes=buffer.asUint8Array().slice(); buffer.destroy(); doc.destroy(); return bytes;
}
test('crop follows rotated display coordinates and preserves source bytes', async()=>{
  const bytes=fixture(), original=bytes.slice(), document=await readDocument({file:bytes});
  const region={id:'plot',pageIndex:0,bbox:[40,20,140,120],blockIds:[]};
  const result=await readSourceAssets({bytes,document,regions:[region]});
  assert.deepEqual(bytes,original);
  const asset=result.assets.find(a=>a.id==='plot'); assert.equal(asset.content.representation,'mupdf-cropped-svg');
  const svg=new TextDecoder().decode(asset.content.bytes);
  assert.match(svg, /<svg\b/); assert.match(svg, /width="100" height="100"/); assert.match(svg, /data:image\/png;base64,/); assert.equal(asset.content.dpi,216); assert.ok(result.drawings.length);
  const source=mupdf.Document.openDocument(bytes,'application/pdf').asPDF(), p=source.loadPage(0);
  const croppedDoc=new mupdf.PDFDocument(); croppedDoc.graftPage(0,source,0); const crop=croppedDoc.loadPage(0);
  crop.setPageBox('CropBox',region.bbox); const saved=croppedDoc.saveToBuffer('');
  const reread=mupdf.Document.openDocument(saved.asUint8Array().slice(),'application/pdf').asPDF(), page=reread.loadPage(0);
  assert.deepEqual(page.getBounds(),[0,0,100,100]);
  const full=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,false);
  const cropped=page.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,false);
  const a=full.getPixels(), b=cropped.getPixels(), stride=full.getStride(), n=full.getNumberOfComponents();
  let diff=0; for(let y=0;y<100;y++) for(let x=0;x<100;x++) for(let c=0;c<n;c++) diff+=Math.abs(b[(y*100+x)*n+c]-a[(y+20)*stride+(x+40)*n+c]); assert.ok(diff/(100*100*n)<1, String(diff/(100*100*n)));
  cropped.destroy(); full.destroy(); page.destroy(); reread.destroy(); saved.destroy(); crop.destroy(); croppedDoc.destroy(); p.destroy(); source.destroy();
});
test('rejects stale source',async()=>{const bytes=fixture(); await assert.rejects(readSourceAssets({bytes,document:{sourceSha256:'bad'}}),/hash mismatch/);});





test('extracts embedded resource bytes with page-scoped identity and measured glyph coverage', async()=>{
  const d=new mupdf.PDFDocument(), font=new mupdf.Font('Helvetica'), ref=d.addFont(font);
  const p=d.addPage([0,0,200,200],0,{Font:{F1:ref}},'BT /F1 14 Tf 20 50 Td (Plot) Tj ET'); d.insertPage(0,p);
  const buffer=d.saveToBuffer(''); const bytes=buffer.asUint8Array().slice(); buffer.destroy(); d.destroy(); font.destroy();
  const document=await readDocument({file:bytes}); const result=await readSourceAssets({bytes,document});
  assert.equal(result.fonts.length,1); const extracted=result.fonts[0];
  assert.equal(extracted.source.resourcePath,'Resources/Font/F1'); assert.ok(extracted.source.objectNumber>0); assert.ok(extracted.bytes.length>100); assert.equal(extracted.embedded,true); assert.equal(extracted.embeddingPermissions,'unknown');
  const {createFontPlan}=await import('../src/paper-fonts.mjs');
  const plan=await createFontPlan({text:'Plot',fonts:[{id:extracted.id,family:extracted.family,bytes:extracted.bytes}]},{mupdf});
  assert.equal(plan.candidates[0].coverage.status,'covered');
});

function combinedFixture() {
  const d=new mupdf.PDFDocument(), font=new mupdf.Font('Helvetica'), f=d.addSimpleFont(font), embedded=d.addFont(font);
  const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);
  pix.getPixels().set([255,0,0,255, 0,128,0,128, 0,0,0,0, 0,0,255,255]);
  const image=new mupdf.Image(pix), im=d.addImage(image);
  const form=d.addStream('BT /F1 10 Tf 5 5 Td (nested) Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,50,20],Resources:{Font:{F1:embedded}}});
  const res={Font:{F1:f},XObject:{Im:im,A:form,B:form},ExtGState:{GS:{Type:'ExtGState',ca:0.5,CA:0.5}}};
  const content='q 0 0 0 RG 1 w 30 40 100 80 re S 30 80 m 130 80 l S 80 40 m 80 120 l S Q\nBT /F1 10 Tf 35 95 Td (Plot label) Tj ET\nBT /F1 9 Tf 35 60 Td (cell) Tj ET\nq /GS gs 1 0 0 rg 50 45 40 30 re f Q\nq 20 0 0 20 90 95 cm /Im Do Q q 20 0 0 20 105 45 cm /Im Do Q\nBT /F1 12 Tf 10 250 Td (UNRELATED BODY TEXT) Tj ET';
  d.insertPage(0,d.addPage([0,0,200,300],90,res,content));
  const p=d.loadPage(0); p.setPageBox('CropBox',[10,20,180,280]); p.destroy();
  const b=d.saveToBuffer(''), bytes=Uint8Array.from(b.asUint8Array()); b.destroy(); image.destroy();pix.destroy();font.destroy();d.destroy(); return bytes;
}

test('combined crop, repeated resources, snapshots and ownership checks',async()=>{
  const bytes=combinedFixture(), original=Uint8Array.from(bytes), doc=await readDocument({file:bytes});
  const region={id:'combined',pageIndex:0,bbox:[15,15,125,125],blockIds:[]};
  const result=await readSourceAssets({bytes:Buffer.from(bytes),document:doc,regions:[region]});
  assert.deepEqual(bytes,original); assert.ok(result.drawings.length>=4);
  assert.ok(result.fonts.some(f=>f.source.resourcePath.includes('/XObject/A/')));
  assert.ok(result.fonts.some(f=>f.source.resourcePath.includes('/XObject/B/')));
  assert.ok(result.fonts.filter(f=>f.bytes?.length>100).length>=2);
  const svg=new TextDecoder().decode(result.assets.find(a=>a.id==='combined').content.bytes);
  assert.doesNotMatch(svg,/UNRELATED|<path|<text/); assert.match(svg,/data:image\/png;base64,/);
  await assert.rejects(readSourceAssets({bytes,document:doc,regions:[region,region]}),/Duplicate or missing region ID/);
  const dup=structuredClone(doc); if(dup.assets.length) { const a=structuredClone(dup.assets[0]); a.id='other'; dup.assets.push(a); await assert.rejects(readSourceAssets({bytes,document:dup}),/Duplicate asset occurrence/); }
  if(doc.assets.length) { const old=doc.assets[0].source.bbox[0]; result.assets[0].source.bbox[0]++; assert.equal(doc.assets[0].source.bbox[0],old); }
  const clone=structuredClone(doc); clone.blocks.find(b=>b.source.range).source.range.end++;
  await assert.rejects(readSourceAssets({bytes,document:clone}),/Unsafe source range/);
  const d=mupdf.Document.openDocument(bytes,'application/pdf').asPDF(),page=d.loadPage(0);
  const full=page.toPixmap([3,0,0,3,0,0],mupdf.ColorSpace.DeviceRGB,true,false);
  if(process.env.ASSET_EVIDENCE_DIR) {
    const fs=await import('node:fs'); fs.mkdirSync(process.env.ASSET_EVIDENCE_DIR,{recursive:true});
    fs.writeFileSync(`${process.env.ASSET_EVIDENCE_DIR}/crop.svg`,svg);
    fs.writeFileSync(`${process.env.ASSET_EVIDENCE_DIR}/full.png`,full.asPNG());
  }
  full.destroy();page.destroy();d.destroy();
});

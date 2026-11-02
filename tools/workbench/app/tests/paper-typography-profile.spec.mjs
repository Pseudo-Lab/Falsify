import test from 'node:test';import assert from 'node:assert/strict';
import {inferTypographyProfile} from '../src/paper-typography-profile.mjs';
const h='a'.repeat(64),ref={sourceSha256:h,pageIndex:0,frame:'mupdf-display',bbox:[50,60,500,80]};
const model={sourceSha256:h,pages:[{width:612,height:792,extensions:{layoutHints:{columns:2,gutterBp:[290,310]}}}],items:[{kind:'paragraph',evidence:[ref],extensions:{typography:{fontSizeBp:9,leadingBp:11,leadingEvidence:[ref,ref]}}},{kind:'heading',evidence:[ref],extensions:{typography:{fontSizeBp:13}}}]};
test('observations and explicit overrides form one document profile',()=>{const p=inferTypographyProfile(model);assert.equal(p.page.columns,2);assert.equal(p.page.gutterBp,20);assert.equal(p.roles.body.sizeBp,9);assert.equal(p.roles.body.leadingBp,11);assert.equal(p.roles.heading.sizeBp,13);assert.equal(inferTypographyProfile(model,{page:{columns:1},body:{leadingBp:14}}).roles.body.leadingBp,14);assert.equal(inferTypographyProfile(model,{page:{columns:1}}).page.columns,1);assert.ok(p.diagnostics.some(d=>d.source==='default'));assert.doesNotThrow(()=>JSON.stringify(p));});

test('two-column margins use outer per-page body extents despite unequal populations',()=>{
 const page={width:612,height:792,extensions:{layoutHints:{columns:2,gutterBp:[290,310]}}};
 const refAt=(pageIndex,bbox)=>({sourceSha256:h,pageIndex,frame:'mupdf-display',bbox});
 const paragraph=(pageIndex,bbox)=>({kind:'paragraph',evidence:[refAt(pageIndex,bbox)]});
 const m={sourceSha256:h,pages:[page,page],items:[paragraph(0,[44,50,280,70]),...Array.from({length:8},()=>paragraph(0,[320,60,565,80])),...Array.from({length:7},()=>paragraph(1,[46,50,280,70])),paragraph(1,[320,60,563,80])]};
 const p=inferTypographyProfile(m);assert.equal(p.page.columns,2);assert.equal(p.page.margins.left,46);assert.equal(p.page.margins.right,49);
});

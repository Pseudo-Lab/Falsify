import {test} from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';

// The source imports the browser vendor path; resolve it to the pinned PDF.js
// legacy build while exercising the source module against an in-memory PDF.
const pdfjs = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).href;
const worker = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === './vendor/pdf.mjs') return {url: ${JSON.stringify(pdfjs)}, shortCircuit: true};
  if (specifier.endsWith('/vendor/pdf.worker.mjs')) return {url: ${JSON.stringify(worker)}, shortCircuit: true};
  return next(specifier, context);
}`));
globalThis.document = {baseURI: new URL('../', import.meta.url).href};
const {extract} = await import('../src/document-import.js');

function pdf(texts) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids=[];
  for (const text of texts) {
    const id=objects.length+1; kids.push(`${id} 0 R`);
    const stream=text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${texts.length} >>`;
  let output='%PDF-1.4\n', offsets=[];
  for (const [i,obj] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output+=`${i+1} 0 obj\n${obj}\nendobj\n`; }
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

test('source PDF extraction retains page text and reports blank pages', async () => {
  const result=await extract(new File([pdf(['Alpha text', '', 'Unaffected page'])], 'synthetic.pdf'));
  assert.equal(result.text, 'Alpha text\n\nUnaffected page');
  assert.deepEqual(result.segments.map(s=>s.label), ['PDF p. 1','PDF p. 3']);
  assert.ok(result.warnings.some(w=>w.includes('텍스트 없는 페이지: 2')));
});

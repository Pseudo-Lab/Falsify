import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
export const blocks = [
  {id:'a',text:'The result was -12 in study [3].'},
  {id:'b',text:'A second paragraph remains intact.'},
  {id:'c',text:'The selected sentence is short.'}
];
export const after = 'The selected sentence is longer and remains exact.';
const esc = s => s.replace(/[\\()]/g, '\\$&');
export function corpus(variant = 'baseline') {
  const d = new mupdf.PDFDocument(), font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  let a = blocks[0].text, b = blocks[1].text, c = variant === 'edit' ? after : blocks[2].text;
  if (variant === 'missing') a = 'The result was -12 in study [ ].';
  if (variant === 'number') a = 'The result was -13 in study [3].';
  if (variant === 'sign') a = 'The result was 12 in study [3].';
  const line = (text,x,y) => `BT /F 12 Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`;
  let p1 = variant === 'wrapped' ? line('The result was -12',30,350)+line('in study [3].',30,330) : line(a,variant === 'bounds' ? -10 : 30,350);
  p1 += line(b,30,300);
  if (variant === 'duplicate') p1 += line(b,30,275);
  if (variant === 'edit') p1 += line('The selected sentence is longer',30,250)+line('and remains exact.',30,230);
  else if (variant !== 'moved') p1 += line(c,30,250);
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},p1));
  if (variant === 'moved') d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},line(c,30,350)));
  const buf=d.saveToBuffer(), bytes=buf.asUint8Array().slice(); buf.destroy(); d.destroy(); return bytes;
}


// Separate text objects and fonts force styled PDF.js runs from real PDF bytes.
export function geometryCorpus(variant) {
  const d = new mupdf.PDFDocument();
  const f = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const g = d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));
  const line = (font, text, x, y, matrix = '1 0 0 1') => `BT /${font} 12 Tf ${matrix} ${x} ${y} Tm (${esc(text)}) Tj ET\n`;
  let stream;
  if (variant === 'split' || variant === 'gap' || variant === 'ambiguous' || variant === 'internal-space') {
    // Helvetica "regul" is 26.676 points at 12pt.
    const x = variant === 'gap' ? 66 : variant === 'ambiguous' ? 55 : 56.676;
    stream = line('F','regul',30,350) + line('G',variant === 'internal-space' ? ' ation' : 'ation',x,350);
  } else if (variant === 'repeat-hyphen') stream = line('F','antero-',30,350) + line('G','posterior',30,330) + line('F','antero- ',30,310) + line('G','posterior',30,290);
  else if (variant === 'unrelated-space') stream = line('F','other space antero-',30,350) + line('G','posterior',30,330);
  else if (variant === 'hyphen-wrap') stream = line('F','antero-',30,350) + line('G','posterior',30,330);
  else if (variant === 'hyphen-space') stream = line('F','antero- ',30,350) + line('G','posterior',30,330);
  else if (variant === 'citation-wrap') stream = line('F','modulation.',30,350) + line('G','[3]',30,330);
  else if (variant === 'citation-space') stream = line('F','modulation. ',30,350) + line('G','[3]',30,330);
  else if (variant === 'number-hyphen') stream = line('F','7-',30,350) + line('G','point',30,330);
  else if (variant === 'range-wrap') stream = `BT /F 12 Tf 1 0 0 1 30 350 Tm (337\\226) Tj ET\n` + line('G','41',30,330);
  else if (variant === 'url-wrap') stream = line('F','site/path/?',30,350) + line('G','key=value',30,330);
  else if (variant === 'quote' || variant === 'quote-space') stream = line('F',variant === 'quote' ? 'bath)' : 'bath )',30,350);
  else if (variant === 'micro') stream = `BT /F 12 Tf 1 0 0 1 30 350 Tm (1 \\265M kinase) Tj ET\n`;
  else if (variant === 'hyphen-paragraph') stream = line('F','antero-',30,350) + line('G','posterior',30,322);
  else if (variant === 'url-paragraph') stream = line('F','https://site.test',30,350) + line('G','Peer review',30,330);
  else if (variant === 'url-reference') stream = line('F','https://site.test/',30,350) + line('G','2. Reference',30,322);
  else if (variant === 'minus-wrap') stream = line('F','value -',30,350) + line('G','12',30,330);
  else if (variant === 'soft-wrap') stream = `BT /F 12 Tf 1 0 0 1 30 350 Tm (soft\\255) Tj ET\n` + line('G','ware',30,330);
  else if (variant === 'hyphen-page') stream = line('F','antero-',30,350) + line('G','posterior',30,330);
  else if (variant === 'wrap') stream = line('F','hello',30,350) + line('G','world',30,330);
  else if (variant === 'bottom') stream = line('F','control',30,0);
  else if (variant === 'top') stream = line('F','control',30,399);
  else if (variant === 'right') stream = line('F','control',290,350);
  else if (variant === 'rotated') stream = line('F','control',30,350,'0 1 -1 0');
  else stream = line('F','control',30,350);
  if (variant === 'hyphen-page') d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f,G:g}},line('F','first',30,350)));
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f,G:g}},stream));
  const buf=d.saveToBuffer(), bytes=buf.asUint8Array().slice(); buf.destroy(); d.destroy(); return bytes;
}

// One logical text line per page, including deliberately empty pages.
export function pageCorpus(pageTexts) {
  const d = new mupdf.PDFDocument(), font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (const text of pageTexts) {
    const stream = text ? `BT /F 12 Tf 30 350 Td (${esc(text)}) Tj ET\n` : '';
    d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},stream));
  }
  const buf=d.saveToBuffer(), bytes=buf.asUint8Array().slice(); buf.destroy(); d.destroy(); return bytes;
}

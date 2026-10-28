'use strict';
// Node contract for the shipped PDF import bundle (dist/document-import.js) against PDF.js text output.
// Usage: node tests/document-import-pdf.spec.cjs NODE_MODULES [REAL_PAPER.pdf]
// NODE_MODULES must hold pdfjs-dist 6.4.299; its legacy build stands in for dist/vendor (the browser build needs
// browser-only APIs). Synthetic in-memory fixtures; the optional real paper is only read and re-hashed.
// No browser, network, server, CLI or model. Passing here is not browser/UI verification.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {register}=require('node:module'),{pathToFileURL}=require('node:url');
const [nodeModules,paper]=process.argv.slice(2);
if(!nodeModules)throw new Error('usage: node tests/document-import-pdf.spec.cjs NODE_MODULES [REAL_PAPER.pdf]');
const legacy=path.resolve(nodeModules,'pdfjs-dist/legacy/build');
assert.equal(JSON.parse(fs.readFileSync(path.resolve(nodeModules,'pdfjs-dist/package.json'),'utf8')).version,'6.4.299','pdfjs-dist version must match dist/vendor');
const dist=path.resolve(__dirname,'../dist');
const map={[pathToFileURL(dist+'/vendor/pdf.mjs').href]:pathToFileURL(legacy+'/pdf.mjs').href,[pathToFileURL(dist+'/vendor/pdf.worker.mjs').href]:pathToFileURL(legacy+'/pdf.worker.mjs').href};
register('data:text/javascript,'+encodeURIComponent('const map='+JSON.stringify(map)+';export async function resolve(s,c,n){const r=await n(s,c);return map[r.url]?{...r,url:map[r.url]}:r;}'));
globalThis.document={baseURI:pathToFileURL(dist+'/').href};
const FalsifyImport=new vm.Script(fs.readFileSync(path.join(dist,'document-import.js'),'utf8')+'\nFalsifyImport',{filename:pathToFileURL(path.join(dist,'document-import.js')).href,importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}).runInThisContext();
const MARK='�';let passed=0;const checks=[];
function check(name,value){assert.ok(value,name);checks.push(name);passed++;}
// pages: arrays of [x,y,literal] runs; literal is raw PDF string bytes (latin1). toUnicode: optional bfchar pairs for F1.
function pdf(pages,{toUnicode}={}){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding'+(toUnicode?' /ToUnicode 4 0 R':'')+' >>'];
  if(toUnicode){const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def /CodeSpaceRange 1 begincodespacerange <00> <FF> endcodespacerange '+toUnicode.length+' beginbfchar '+toUnicode.map(([c,u])=>'<'+c+'> <'+u+'>').join(' ')+' endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';objects.push('<< /Length '+cmap.length+' >>\nstream\n'+cmap+'\nendstream');}
  const kids=[];pages.forEach(runs=>{const id=objects.length+1;kids.push(id+' 0 R');const content=runs.map(([x,y,s])=>'BT /F1 12 Tf '+x+' '+y+' Td ('+s.replace(/[()\\]/g,'\\$&')+') Tj ET').join('\n');objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+(id+1)+' 0 R >>','<< /Length '+Buffer.byteLength(content,'latin1')+' >>\nstream\n'+content+'\nendstream');});
  objects[1]='<< /Type /Pages /Kids ['+kids.join(' ')+'] /Count '+pages.length+' >>';
  let output='%PDF-1.4\n%\xe2\xe3\xcf\xd3\n',offsets=[];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(output,'latin1'));output+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';});
  const xref=Buffer.byteLength(output,'latin1');output+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return Buffer.from(output,'latin1');
}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function read(name,buffer){const before=sha(buffer);try{const r=await FalsifyImport.extract(new File([buffer],name));assert.equal(sha(buffer),before,'input bytes unchanged');return {ok:true,...r};}catch(e){assert.equal(sha(buffer),before,'input bytes unchanged');return {ok:false,error:e.message};}}
const marks=s=>[...s].filter(c=>c===MARK).length;
(async()=>{
  const run=(str,x,y,width=60)=>({str,transform:[1,0,0,1,x,y],width,height:10,hasEOL:true});
  const mixed=[{type:'beginMarkedContent'},run('visible',10,100),{str:'',hasEOL:true},run('old body',10,80),run('new body',10,80),run('tail',10,60)];
  const overlays=FalsifyImport.layoutAliases(mixed,0,600);
  check('overlapping bodies stay separate alternatives',overlays.length===2&&overlays.some(s=>s.text==='visible\nold body\ntail')&&overlays.some(s=>s.text==='visible\nnew body\ntail'));
  check('alias indices use original PDF.js item indices including non-text and empty items',JSON.stringify(overlays.map(s=>s.itemIndices))==='[[1,3,5],[1,4,5]]');
  // ToUnicode maps code 0x41 'A' to U+0000 and 0x42 'B' to U+0001: the shape of an unmapped TeX delimiter glyph.
  let r=await read('nul-glyph.pdf',pdf([[[72,720,'left ( A x B ) right']]],{toUnicode:[['41','0000'],['42','0001']]}));
  check('unmapped U+0000/U+0001 glyphs no longer reject the PDF',r.ok);
  check('each control glyph becomes exactly one mark, neighbours and spaces intact',r.ok&&r.segments[0].text==='left ( '+MARK+' x '+MARK+' ) right');
  check('no NUL or C0 control reaches extracted text',r.ok&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(r.text));
  check('page label and warning name the marked page and count',r.ok&&r.segments[0].label==='PDF p. 1'&&r.warnings.some(w=>w.includes('글리프 2개')&&w.includes('페이지 1')));
  check('provenance stays unverified',r.ok&&r.provenance==='local-extraction-unverified');
  r=await read('clean.pdf',pdf([[[72,720,'Plain caf\xe9 \x93quoted\x94 text.']],[[72,720,'Column one'],[320,720,'column two']]]));
  check('normal WinAnsi text unchanged and no glyph warning',r.ok&&r.segments[0].text==='Plain café “quoted” text.'&&!r.warnings.some(w=>w.includes('글리프')));
  check('multicolumn runs keep their word boundary (spacing is PDF.js-owned)',r.ok&&/^Column one\s+column two$/.test(r.segments[1].text));
  r=await read('overlay.pdf',pdf([[[40,720,'Left opening'],[40,700,'Left ending.'],[320,720,'These results demonstrate'],[320,700,'an important effect'],[320,680,'old trailing words'],[40,400,'Figure caption'],[320,660,'sufficient to restore neural competency in all lines.']]]));
  const visual=r.matchSegments.find(s=>s.id==='layout:p1:column2');
  check('geometry order places appended overlay before caption',r.ok&&visual&&/These results demonstrate\s+an important effect\s+old trailing words\s+sufficient to restore neural competency in all lines\./.test(visual.text));
  check('layout alias retains ordered original item indices',r.ok&&visual.itemIndices.length===4&&visual.itemIndices[3]>visual.itemIndices[2]);
  check('canonical content stream remains unchanged',r.ok&&r.segments[0].text.indexOf('Figure caption')<r.segments[0].text.indexOf('sufficient to restore'));
  r=await read('mapped-unicode.pdf',pdf([[[72,720,'ABC']]],{toUnicode:[['41','D55C'],['42','AE00'],['43','03B1']]}));
  check('non-control Unicode from ToUnicode preserved',r.ok&&r.text==='한글α'&&!r.warnings.some(w=>w.includes('글리프')));
  r=await read('mixed.pdf',pdf([[[72,720,'Page one A']],[]],{toUnicode:[['41','0000']]}));
  check('mark plus blank-page warning coexist',r.ok&&r.segments[0].text==='Page one '+MARK&&r.warnings.some(w=>w.includes('텍스트 없는 페이지: 2'))&&r.warnings.some(w=>w.includes('페이지 1)')));
  r=await read('only-control.pdf',pdf([[[72,720,'A']]],{toUnicode:[['41','0000']]}));
  check('control-only page yields a visible mark, not silent empty text',r.ok&&r.text===MARK);
  r=await read('scan.pdf',pdf([[]]));check('empty PDF still requires OCR',!r.ok&&r.error.includes('OCR'));
  r=await read('junk.pdf',Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(64,0),crypto.randomBytes(256)]));check('binary junk behind a PDF header is rejected, not sanitized',!r.ok&&!/^\s*$/.test(r.error));
  r=await read('binary.txt',Buffer.from('abc\0def'));check('NUL in text files still rejected',!r.ok&&r.error.includes('바이너리'));
  r=await read('controls.txt',Buffer.from('tab\there\nnext line\r\nend'));check('TXT tab/newline controls kept',r.ok&&r.text.includes('tab\there')&&r.text.includes('next line'));
  if(paper){
    const bytes=fs.readFileSync(paper),hash=sha(bytes);
    r=await read(path.basename(paper),bytes);
    const report={sha256:hash,ok:r.ok,error:r.error,pages:r.segments?.length,chars:r.text?.length,marks:r.ok?r.segments.map((s,i)=>[i+1,marks(s.text)]).filter(([,n])=>n):null,
      contexts:r.ok?r.segments.flatMap((s,i)=>[...s.text.matchAll(new RegExp('.{0,24}'+MARK+'.{0,24}','g'))].map(m=>({page:i+1,text:m[0]}))):null,warnings:r.warnings,sha256After:sha(fs.readFileSync(paper))};
    console.log(JSON.stringify({realPaper:report},null,1));
    if(path.basename(paper)==='Falsify_2차_문제집.pdf'){
      const alias=r.matchSegments.find(s=>s.pageIndex===1&&/These\s+results demonstrate/.test(s.text));
      const range=alias?.text.match(/These\s+results demonstrate[\s\S]*?sufficient to restore neural competency in all lines/);
      check('real p2 visual quote reconstructed through appended tail without intervening material',!!range&&range[0].split('\n').length<=4);
      if(range){const match=require('../dist/paper-anchors.js').find({quote:range[0].replace(/\s+/g,' '),segments:r.segments.map((s,i)=>({...s,id:'canonical:'+i,pageIndex:i})).concat(r.matchSegments),pageIndex:1});check('real p2 quote matches the visual alias',match.status==='matched'&&match.matches[0].segmentId===alias.id&&match.matches[0].pageIndex===1);}
    }
    check('real paper extracts without NUL rejection',r.ok&&!r.text.includes('\0'));
    check('real paper bytes unchanged',report.sha256After===hash);
    // RCA for arXiv 2608.01205 (ReBRAC): CMEX10 has no ToUnicode; codes 0x10/0x11 on p.3 and 0x00/0x01 on p.4 are big delimiters.
    if(hash==='006fbadd146f5b9033f32817b0641bce523242ac22259dbbf41ab02b58a8d982')check('ReBRAC marks exactly the four CMEX10 delimiters on pages 3 and 4',JSON.stringify(report.marks)==='[[3,2],[4,2]]'&&r.segments.length===19);
  }
  console.log(JSON.stringify({passed,failed:0,checks},null,1));
})().catch(e=>{console.error(JSON.stringify({passed,failed:e.stack,checks},null,1));process.exitCode=1;});

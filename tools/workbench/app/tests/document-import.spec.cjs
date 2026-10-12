// Browser integration with in-memory synthetic fixtures; no document is uploaded.
const {chromium}=require(process.argv[2]);
const {zipSync,strToU8}=require('fflate');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');
const base=process.argv[3]||'http://127.0.0.1:7815/';
const captures=path.resolve(process.argv[4]||'../.impeccable/review/document-import');
let browser,passed=0;const checks=[];
function check(name,value){assert.ok(value,name);checks.push(name);passed++;}
function pdf(texts){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids=[];texts.forEach(text=>{const id=objects.length+1;kids.push(id+' 0 R');const content=text?'BT /F1 12 Tf 72 720 Td ('+text.replace(/[()\\]/g,'\\$&')+') Tj ET':'';objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+(id+1)+' 0 R >>','<< /Length '+Buffer.byteLength(content)+' >>\nstream\n'+content+'\nendstream');});
  objects[1]='<< /Type /Pages /Kids ['+kids.join(' ')+'] /Count '+texts.length+' >>';
  let output='%PDF-1.4\n',offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(output));output+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';});
  const xref=Buffer.byteLength(output);output+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return Buffer.from(output);
}
function docx(source){return Buffer.from(zipSync({'word/document.xml':strToU8(source)}));}
const word='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>한글 논문 Synthetic source.</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>DELETED SECRET</w:delText></w:r></w:del><w:ins><w:r><w:t>Inserted text.</w:t></w:r></w:ins></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
(async()=>{
  await fs.mkdir(captures,{recursive:true});browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));await page.goto(base);
  const read=async(name,buffer)=>page.evaluate(async({name,data})=>{try{const result=await FalsifyImport.extract(new File([Uint8Array.from(data)],name));return {ok:true,...result};}catch(e){return {ok:false,error:e.message};}},{name,data:[...buffer]});
  let r=await read('synthetic.docx',docx(word));check('DOCX Korean and table paragraphs',r.ok&&r.text.includes('한글 논문')&&r.text.includes('Table cell.'));check('DOCX excludes deletions, includes insertions',!r.text.includes('DELETED SECRET')&&r.text.includes('Inserted text.'));check('unverified provenance and explicit loss warning',r.provenance==='local-extraction-unverified'&&r.warnings[0].includes('수식'));
  r=await read('synthetic.odt',Buffer.from(zipSync({'content.xml':strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>ODT one<text:s text:c="2"/>two.</text:p></office:text></office:body></office:document-content>')})));check('ODT spaces preserved',r.ok&&r.text==='ODT one  two.');
  r=await read('synthetic.html',Buffer.from('<html><head><title>metadata</title></head><body><h1>Paper</h1><p>한글 &amp; evidence.</p><script>window.hacked=true</script><iframe src="https://example.com/leak"></iframe><img src="https://example.com/image"><p onclick="alert(1)">Plain</p></body></html>'));check('HTML inert text, no code',r.ok&&r.text.includes('한글 & evidence.')&&!r.text.includes('hacked')&&!r.text.includes('metadata'));
  r=await read('synthetic.pdf',pdf(['Synthetic paper first page.','Evidence second page.']));check('real PDF.js extraction and page locators',r.ok&&r.segments.length===2&&r.segments[1].label==='PDF p. 2'&&r.text.includes('Evidence second page.'));
  r=await read('scan.pdf',pdf(['']));check('image-only / blank PDF requires OCR',!r.ok&&r.error.includes('OCR'));
  r=await read('mixed.pdf',pdf(['Source text.','']));check('partial missing PDF pages warned',r.ok&&r.warnings.some(w=>w.includes('텍스트 없는 페이지: 2')));
  r=await read('corrupt.pdf',Buffer.from('not PDF'));check('invalid PDF rejected',!r.ok&&r.error.includes('PDF'));
  r=await read('legacy.doc',Buffer.from('OLE'));check('legacy binary conversion guidance',!r.ok&&r.error.includes('변환'));
  r=await read('empty.txt',Buffer.alloc(0));check('empty rejected',!r.ok);
  r=await read('binary.txt',Buffer.from('abc\0def'));check('binary text rejected',!r.ok);
  r=await read('legacy.txt',Buffer.from([0xff,0x80]));check('invalid encoding not silently replaced',!r.ok&&r.error.includes('UTF-8'));
  r=await read('utf16.txt',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('한글 source','utf16le')]));check('UTF16 BOM supported',r.ok&&r.text==='한글 source');
  r=await read('entity.docx',docx('<!DOCTYPE root [<!ENTITY a SYSTEM "https://example.com/leak">]>'+word));check('DTD and external entity denied',!r.ok&&r.error.includes('DTD'));
  r=await read('broken.docx',docx('<broken>'));check('malformed XML denied',!r.ok&&r.error.includes('XML'));
  r=await read('missing.docx',Buffer.from(zipSync({'other.xml':strToU8('irrelevant')})));check('missing DOCX body rejected',!r.ok);
  r=await read('bomb.docx',docx('a'.repeat(9*1024*1024)));check('ZIP body expansion bound',!r.ok&&r.error.includes('제한'));
  check('oversize file rejected before arrayBuffer',await page.evaluate(async()=>{try{await FalsifyImport.extract({name:'large.pdf',size:26*1024*1024,arrayBuffer:()=>{throw new Error('must not read');}});return false;}catch(e){return e.message.includes('25MiB');}}));
  check('aborted import rejected',await page.evaluate(async()=>{const controller=new AbortController();controller.abort();try{await FalsifyImport.extract(new File(['source'],'a.txt'),{signal:controller.signal});return false;}catch(e){return e.name==='AbortError';}}));
  await page.locator('#paper-file').setInputFiles({name:'synthetic.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx(word)});await page.locator('#import-preview').waitFor();
  check('DOCX opens full RED without legacy apply',await page.locator('#document-red').isVisible()&&await page.locator('#paper-form').count()===0);
  await page.locator('#import-segment').selectOption('0');check('DOCX paragraph preview',(await page.locator('#import-text').inputValue()).includes('한글 논문'));
  await page.locator('#import-segment').selectOption('2');check('table paragraph preview',await page.locator('#import-text').inputValue()==='Table cell.');
  await page.locator('#import-segment').selectOption('all');check('whole text preview',(await page.locator('#import-text').inputValue()).includes('Inserted text.'));
  for(const [name,width,height] of [['desktop',1440,900],['mobile',390,844]]){await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));check(width+' no overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(captures,name+'.png'),fullPage:true,animations:'disabled'});}
  await page.locator('#paper-file').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdf(['Page one.','Page two evidence.'])});await page.waitForFunction(()=>document.querySelector('#import-summary').textContent.includes('synthetic.pdf'));check('PDF UI page picker',(await page.locator('#import-text').inputValue()).includes('Page one.'));
  await page.locator('#import-segment').selectOption('1');check('PDF page2 preview',await page.locator('#import-text').inputValue()==='Page two evidence.');
  await page.locator('#red-request').evaluate(e=>{for(let a=e.parentElement;a;a=a.parentElement)if(a.tagName==='DETAILS')a.open=true;});const d=page.waitForEvent('download');await page.locator('#red-request').click();const packet=JSON.parse(await fs.readFile(await(await d).path(),'utf8'));check('preview choice does not narrow model input',packet.segments.length===2&&packet.segments[0].text==='Page one.');
  await page.evaluate(()=>{window.originalImport=FalsifyImport;FalsifyImport={...FalsifyImport,extract:()=>new Promise(resolve=>setTimeout(()=>resolve({name:'late.txt',format:'TXT',text:'stale source',segments:[{label:'p1',text:'stale source'}],warnings:[]}),400))};});
  await page.locator('#paper-file').setInputFiles({name:'late.txt',mimeType:'text/plain',buffer:Buffer.from('late')});await page.locator('#import-cancel').click();await page.waitForTimeout(500);check('canceled completion cannot restore RED',await page.locator('#document-red').isHidden()&&await page.locator('#import-preview').isHidden());
  await page.locator('#paper-file').setInputFiles({name:'late.txt',mimeType:'text/plain',buffer:Buffer.from('late')});await page.locator('#reset').click();await page.locator('#reset-dialog button[value=reset]').click();await page.waitForTimeout(500);check('reset suppresses stale extraction',await page.locator('#import-preview').isHidden()&&await page.locator('#document-red').isHidden());
  await page.evaluate(()=>FalsifyImport=window.originalImport);
  check('no script injection or browser errors',!(await page.evaluate(()=>window.hacked))&&errors.length===0);check('only same-origin static GETs, no upload',requests.every(r=>r.url.startsWith(base)&&r.method==='GET'));
  console.log(JSON.stringify({passed,checks,errors,requests:requests.length,captures},null,2));
})().catch(e=>{console.error(JSON.stringify({passed,failed:e.stack,checks},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();});

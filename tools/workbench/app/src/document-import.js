import {unzipSync} from 'fflate';
import {parse} from 'parse5';

export const LIMITS = Object.freeze({bytes:25*1024*1024, chars:1000000, pages:200, xmlBytes:8*1024*1024, segments:10000});
const TEXT = new Set(['txt','md','markdown','text','csv','tsv','tex','rst']);
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const O='urn:oasis:names:tc:opendocument:xmlns:text:1.0';
function fail(message){throw new Error(message);}
function check(signal){if(signal?.aborted)throw new DOMException('취소됨','AbortError');}
function decode(bytes){
  let encoding='utf-8';
  if(bytes[0]===255&&bytes[1]===254)encoding='utf-16le';
  if(bytes[0]===254&&bytes[1]===255)encoding='utf-16be';
  try{return new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{fail('문자 인코딩을 읽을 수 없습니다. UTF-8 TXT로 저장한 뒤 다시 가져오세요.');}
}
function xml(source){
  if(/<!DOCTYPE|<!ENTITY/i.test(source))fail('외부 엔터티·DTD를 포함한 XML은 읽지 않습니다. 안전한 PDF 또는 TXT로 변환하세요.');
  const doc=new DOMParser().parseFromString(source,'application/xml');
  if(doc.getElementsByTagName('parsererror').length)fail('문서 XML이 손상되었습니다. 원본 앱에서 다시 저장하세요.');
  return doc;
}
function archivePart(bytes,path){
  if(bytes[0]!==80||bytes[1]!==75)fail('DOCX/ODT 파일의 ZIP 서명이 올바르지 않습니다.');
  let count=0,total=0,found=0;
  // Inventory pass before inflation; images, macros, embedded files and relationships are never opened.
  unzipSync(bytes,{filter:f=>{
    if(++count>20000)fail('압축 문서의 항목이 너무 많습니다. TXT로 변환하세요.');
    if(f.name===path){found++;total+=f.originalSize;if(found>1||total>LIMITS.xmlBytes||f.originalSize>Math.max(f.size*200,1000000))fail('압축 문서의 본문 크기·압축률이 제한을 초과했습니다. TXT로 변환하세요.');}
    return false;
  }});
  if(!found)fail('문서 본문을 찾지 못했습니다. 올바른 DOCX/ODT 파일인지 확인하세요.');
  const result=unzipSync(bytes,{filter:f=>f.name===path})[path];
  if(!result||result.length>LIMITS.xmlBytes)fail('문서 본문 크기 제한을 초과했습니다.');
  return xml(decode(result));
}
function wordText(node){
  if(node.nodeType===3)return '';
  if(node.namespaceURI===W&&['del','moveFrom','instrText'].includes(node.localName))return '';
  if(node.namespaceURI===W){if(node.localName==='t')return node.textContent;if(['br','cr'].includes(node.localName))return '\n';if(node.localName==='tab')return '\t';}
  return Array.from(node.childNodes||[]).map(wordText).join('');
}
function odtText(node){
  if(node.nodeType===3)return node.nodeValue;
  if(['tracked-changes','annotation','binary-data'].includes(node.localName))return '';
  if(node.namespaceURI===O){if(node.localName==='s')return ' '.repeat(Math.min(Number(node.getAttributeNS(O,'c'))||1,100));if(node.localName==='tab')return '\t';if(node.localName==='line-break')return '\n';}
  return Array.from(node.childNodes||[]).map(odtText).join('');
}
function htmlText(node){
  if(['script','style','iframe','object','embed','template','head','noscript','svg','math'].includes(node.tagName))return '';
  if(node.nodeName==='#text')return node.value;
  if(node.tagName==='br')return '\n';
  const content=(node.childNodes||[]).map(htmlText).join('');
  return ['p','div','section','article','h1','h2','h3','h4','li','tr'].includes(node.tagName)?'\n\n'+content+'\n\n':content;
}
function paragraphs(text,prefix='문단'){
  return text.replace(/\r\n?/g,'\n').split(/\n\s*\n/).filter(s=>s.trim()).map((s,i)=>({label:prefix+' '+(i+1),text:s.trim()}));
}
function finalize(format,segments,warnings){
  segments=segments.filter(s=>s.text.trim());
  if(segments.length>LIMITS.segments)fail('문단 수가 너무 많습니다. 문서를 나누어 가져오세요.');
  const text=segments.map(s=>s.text).join('\n\n');
  if(!text.trim())fail('추출 가능한 텍스트가 없습니다. 스캔·이미지는 먼저 OCR을 수행하고 TXT 또는 검색 가능한 PDF로 저장하세요.');
  if(text.length>LIMITS.chars)fail('추출 텍스트는 1,000,000자까지 지원합니다. 문서를 나누어 가져오세요.');
  if(text.includes('\0'))fail('바이너리 데이터가 포함되어 있습니다. PDF·DOCX·ODT 또는 UTF-8 TXT로 변환하세요.');
  return {format,text,segments,warnings,provenance:'local-extraction-unverified'};
}
// PDF.js passes a glyph's raw char code through as text when the font has no Unicode mapping
// (e.g. TeX CMEX10 big delimiters at codes 0x00/0x01/0x10/0x11). Those are glyphs, not file bytes:
// mark each one 1:1 so offsets and word boundaries survive. TAB/LF/CR stay as whitespace.
const MARK='�';
const CONTROL=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
function unmapped(str,count){return str.replace(CONTROL,()=>{count();return MARK;});}
async function pdf(bytes,{signal,onProgress}){
  if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)fail('PDF 서명이 없습니다. 손상된 파일인지 확인하세요.');
  const lib=await import('./vendor/pdf.mjs');check(signal);
  lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',document.baseURI).href;
  const task=lib.getDocument({data:bytes,isEvalSupported:false,disableAutoFetch:true,disableStream:true,disableFontFace:true,verbosity:0,
    cMapUrl:new URL('./vendor/cmaps/',document.baseURI).href,cMapPacked:true,
    standardFontDataUrl:new URL('./vendor/standard_fonts/',document.baseURI).href,wasmUrl:new URL('./vendor/wasm/',document.baseURI).href});
  const abort=()=>{void task.destroy().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;abort();},60000);let doc;
  try{
    doc=await task.promise;check(signal);
    if(doc.numPages>LIMITS.pages)fail('PDF는 200페이지까지 지원합니다. 필요한 부분을 나누어 가져오세요.');
    const segments=[],blank=[],glyphPages=[];let length=0,glyphs=0;
    for(let n=1;n<=doc.numPages;n++){
      check(signal);onProgress?.('PDF '+n+' / '+doc.numPages+'페이지 추출 중');
      const page=await doc.getPage(n);const content=await page.getTextContent();let text='',marked=0;
      for(const item of content.items){if(typeof item.str!=='string')continue;text+=unmapped(item.str,()=>marked++)+(item.hasEOL?'\n':' ');if(text.length+length>LIMITS.chars)fail('추출 텍스트는 1,000,000자까지 지원합니다. 문서를 나누어 가져오세요.');}
      if(marked){glyphs+=marked;glyphPages.push(n);}
      text=text.trim();length+=text.length;if(!text)blank.push(n);segments.push({label:'PDF p. '+n,text});page.cleanup();
    }
    return finalize('PDF',segments,['PDF 읽기 순서·다단 편집·표·수식은 원본과 대조하세요. 텍스트 추출은 레이아웃 검증이 아닙니다.',...(blank.length?['텍스트 없는 페이지: '+blank.join(', ')+'. 이미지·스캔 페이지는 OCR이 필요합니다.']:[]),...(glyphs?['유니코드 대응이 없는 PDF 글리프 '+glyphs+'개를 '+MARK+'로 표시했습니다(페이지 '+glyphPages.join(', ')+'). 수식 괄호 등 기호일 수 있으니 원본과 대조하세요.']:[])]);
  }catch(error){
    check(signal);if(timedOut)fail('PDF 추출이 60초를 초과했습니다. 필요한 페이지만 나누거나 TXT로 변환하세요.');if(error.name==='PasswordException')fail('암호화된 PDF입니다. 권한이 있는 원본 앱에서 암호를 해제한 사본을 가져오세요.');
    if(error.name==='InvalidPDFException')fail('PDF를 읽을 수 없습니다. 원본 앱에서 다시 저장하세요.');throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await task.destroy().catch(()=>{});}
}
export async function extract(file,{signal,onProgress}={}){
  if(!file||!file.size)fail('빈 파일입니다. 내용이 있는 논문 파일을 선택하세요.');
  if(file.size>LIMITS.bytes)fail('파일은 25MiB 이내여야 합니다. 필요한 부분을 나누어 가져오세요.');
  const ext=file.name.split('.').pop().toLowerCase();
  if(!TEXT.has(ext)&&!['pdf','docx','odt','html','htm'].includes(ext))fail('이 형식은 자동 추출하지 않습니다. DOC/RTF/HWP/이미지는 원본 앱에서 PDF·DOCX·TXT로 변환하거나 OCR 후 붙여넣으세요.');
  check(signal);onProgress?.('파일을 브라우저에서 읽는 중');const bytes=new Uint8Array(await file.arrayBuffer());check(signal);
  let result;
  if(ext==='pdf')result=await pdf(bytes,{signal,onProgress});
  else if(ext==='docx'){
    const doc=archivePart(bytes,'word/document.xml');
    const nodes=Array.from(doc.getElementsByTagNameNS(W,'p')).filter(p=>{let a=p.parentNode;while(a){if(a.namespaceURI===W&&['del','moveFrom'].includes(a.localName))return false;a=a.parentNode;}return true;});
    result=finalize('DOCX',nodes.map((p,i)=>({label:'DOCX 문단 '+(i+1),text:wordText(p)})),['본문·표의 문단만 추출합니다. 삭제된 변경 내용은 제외하고 삽입된 내용은 포함합니다. 각주·머리말·그림·수식·주석·레이아웃은 원본에서 확인하세요.']);
  }else if(ext==='odt'){
    const doc=archivePart(bytes,'content.xml');
    result=finalize('ODT',Array.from(doc.getElementsByTagName('*')).filter(n=>n.namespaceURI===O&&['p','h'].includes(n.localName)&&!Array.from((function*(p){while(p){yield p;p=p.parentNode;}})(n.parentNode)).some(p=>['tracked-changes','annotation'].includes(p.localName))).map((p,i)=>({label:'ODT 문단 '+(i+1),text:odtText(p)})),['본문 텍스트만 추출합니다. 변경 기록·주석·그림·수식·표 구조는 원본과 대조하세요.']);
  }else{
    let text=decode(bytes);if(ext==='html'||ext==='htm')text=htmlText(parse(text));
    result=finalize(ext.toUpperCase(),paragraphs(text),[ext==='html'||ext==='htm'?'HTML은 텍스트로만 읽습니다. 스크립트·외부 링크·이미지는 실행하거나 가져오지 않습니다.':'텍스트를 그대로 읽습니다. LaTeX 매크로·참조는 실행하거나 해석하지 않습니다.']);
  }
  check(signal);return {...result,name:file.name.slice(0,200),bytes:file.size};
}

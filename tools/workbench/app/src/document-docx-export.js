import {unzipSync, zipSync, strToU8} from 'fflate';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main', MAX=25*1024*1024, XML_MAX=8*1024*1024;
const fail=s=>{throw new Error(s);};
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function mapText(raw){
  const offsets=[0];let decoded='',end=0;const re=/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);|[^&]/gu;let m;
  while((m=re.exec(raw))){if(m.index!==end)fail('지원하지 않는 XML 엔터티입니다.');const value=m[0][0]==='&'?new DOMParser().parseFromString('<x>'+m[0]+'</x>','application/xml').documentElement.textContent:m[0];decoded+=value;for(let i=1;i<value.length;i++)offsets.push(undefined);offsets.push(re.lastIndex);end=re.lastIndex;}
  if(end!==raw.length)fail('지원하지 않는 XML 텍스트입니다.');return {decoded,offsets};
}
function wordText(node){if(node.nodeType===3)return '';if(node.namespaceURI===W&&['del','moveFrom','instrText'].includes(node.localName))return '';if(node.namespaceURI===W){if(node.localName==='t')return node.textContent;if(['br','cr'].includes(node.localName))return '\n';if(node.localName==='tab')return '\t';}return Array.from(node.childNodes||[]).map(wordText).join('');}
export async function docxFile(file,patches,source){
  if(!file||file.size>MAX||!source?.fileHash||!source?.sourceHash||!Array.isArray(source.segments)||!Array.isArray(patches)||!patches.length)fail('원본 바인딩 또는 변경 목록이 없거나 크기 제한을 초과했습니다.');
  const bytes=new Uint8Array(await file.arrayBuffer());if(await hash(bytes)!==source.fileHash)fail('원본 파일 해시가 일치하지 않습니다.');if(bytes[0]!==80||bytes[1]!==75)fail('DOCX ZIP 서명이 올바르지 않습니다.');
  let count=0,total=0;const names=new Set();unzipSync(bytes,{filter:f=>{if(++count>20000||names.has(f.name))fail('ZIP 항목이 너무 많거나 중복됩니다.');names.add(f.name);total+=f.originalSize;if(total>MAX||f.originalSize>Math.max(f.size*200,1000000))fail('ZIP 압축 해제 크기 또는 압축률 제한을 초과했습니다.');return false;}});
  const entries=unzipSync(bytes),part=entries['word/document.xml'];const contentTypes=entries['[Content_Types].xml'];if(Object.keys(entries).some(x=>/(?:^|\/)vbaProject(?:Signature)?\.bin$/i.test(x))||(contentTypes&&/macroEnabled|vbaProject/i.test(new TextDecoder().decode(contentTypes))))fail('매크로가 포함된 DOCX는 수정할 수 없습니다.');if(Object.values(entries).reduce((n,x)=>n+x.length,0)>MAX)fail('ZIP 압축 해제 크기 제한을 초과했습니다.');if(Object.keys(entries).some(x=>x.startsWith('_xmlsignatures/')))fail('서명된 DOCX는 수정할 수 없습니다.');if(!part||part.length>XML_MAX)fail('DOCX 본문이 없거나 크기 제한을 초과했습니다.');
  if(part[0]===0xef&&part[1]===0xbb&&part[2]===0xbf)fail('UTF-8 BOM이 있는 DOCX XML은 지원하지 않습니다.');const xml=new TextDecoder('utf-8',{fatal:true}).decode(part);if(/<!DOCTYPE|<!ENTITY/i.test(xml))fail('DTD 또는 엔터티 선언을 지원하지 않습니다.');const dom=new DOMParser().parseFromString(xml,'application/xml');if(dom.getElementsByTagName('parsererror').length)fail('DOCX XML이 손상되었습니다.');
  const ts=Array.from(dom.getElementsByTagNameNS(W,'t')),lex=[...xml.matchAll(/<w:t(?:\s[^<>]*?)?>([^<>]*)<\/w:t\s*>/g)];if(ts.length!==lex.length||ts.some((t,i)=>t.tagName!=='w:t'||t.textContent!==mapText(lex[i][1]).decoded))fail('지원하지 않는 텍스트 XML 구조입니다.');const indexes=new Map(ts.map((t,i)=>[t,i]));
  const paragraphs=Array.from(dom.getElementsByTagNameNS(W,'p')).filter(p=>{let a=p.parentNode;while(a){if(a.namespaceURI===W&&['del','moveFrom'].includes(a.localName))return false;a=a.parentNode;}return true;}).map(p=>({p,text:wordText(p)})).filter(x=>x.text.trim());
  if(paragraphs.length!==source.segments.length||paragraphs.some((p,i)=>p.text!==source.segments[i].text)||await hash(new TextEncoder().encode(paragraphs.map(p=>p.text).join('\n\n')))!==source.sourceHash)fail('추출 텍스트와 원본 문단 바인딩이 일치하지 않습니다.');
  const edits=[];
  for(const patch of patches){
    const n=source.segments.findIndex(s=>s.id===patch.segmentId),p=paragraphs[n];if(!p||typeof patch.before!=='string'||!patch.before||typeof patch.after!=='string'||!Number.isInteger(patch.offset)||p.text.slice(patch.offset,patch.offset+patch.before.length)!==patch.before||p.text.indexOf(patch.before)!==patch.offset||p.text.indexOf(patch.before,patch.offset+1)!==-1)fail('원문 위치가 없거나 중복됩니다.');
    if(/[\r\n\t]/.test(patch.before+patch.after)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(patch.after)||new TextDecoder('utf-8',{fatal:true}).decode(new TextEncoder().encode(patch.after))!==patch.after)fail('줄바꿈·제어 문자는 지원하지 않습니다.');
    const children=Array.from(p.p.children);if(children.some(e=>e.namespaceURI!==W||!['pPr','r'].includes(e.localName))||children.filter(e=>e.localName==='r').some(r=>Array.from(r.children).some(e=>e.namespaceURI!==W||!['rPr','t'].includes(e.localName))))fail('필드, 링크 또는 복잡한 run 구조의 문단은 지원하지 않습니다.');
    let pre=0,suf=0;while(pre<patch.before.length&&pre<patch.after.length&&patch.before[pre]===patch.after[pre])pre++;while(suf<patch.before.length-pre&&suf<patch.after.length-pre&&patch.before[patch.before.length-1-suf]===patch.after[patch.after.length-1-suf])suf++;
    const start=patch.offset+pre,end=patch.offset+patch.before.length-suf;let cursor=0,hits=[];for(const t of Array.from(p.p.getElementsByTagNameNS(W,'t'))){const a=cursor,b=a+t.textContent.length;cursor=b;if(start>=a&&end<=b)hits.push({t,a});}if(cursor!==p.text.length||hits.length!==1)fail('변경 범위가 여러 run에 걸치거나 위치가 모호합니다.');
    const {t,a}=hits[0],match=lex[indexes.get(t)],map=mapText(match[1]),left=map.offsets[start-a],right=map.offsets[end-a];if(left===undefined||right===undefined)fail('문자 경계가 일치하지 않습니다.');const contentStart=match.index+match[0].indexOf('>')+1,replacement=patch.after.slice(pre,patch.after.length-suf);
    const newText=t.textContent.slice(0,start-a)+replacement+t.textContent.slice(end-a);if((/^\s|\s$/.test(newText))&&t.getAttributeNS('http://www.w3.org/XML/1998/namespace','space')!=='preserve')fail('run 경계 공백 보존 속성이 없어 지원하지 않습니다.');
    edits.push({start:contentStart+left,end:contentStart+right,replacement:escape(replacement)});
  }
  edits.sort((a,b)=>a.start-b.start);for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end||edits[i].start===edits[i-1].start)fail('변경 범위가 겹칩니다.');let changed=xml;for(const e of edits.reverse())changed=changed.slice(0,e.start)+e.replacement+changed.slice(e.end);
  if(new DOMParser().parseFromString(changed,'application/xml').getElementsByTagName('parsererror').length)fail('변경 결과가 유효한 XML이 아닙니다.');entries['word/document.xml']=strToU8(changed);return {bytes:zipSync(entries),verification:{mode:'docx-original-xml-span',untouchedEntryContentsPreserved:true,visualLayoutVerified:false,limits:'변경된 최소 범위가 단일 run에 있는 경우만 지원합니다. 페이지 재배치와 시각 품질은 원본 앱에서 확인해야 합니다.'}};
}

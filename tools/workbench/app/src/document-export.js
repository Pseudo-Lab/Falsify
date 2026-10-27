/* Patch the actual text file; preserve its encoding, BOM and every untouched byte. */
export async function textFile(file, patches){
  const ext=file.name.split('.').pop().toLowerCase();
  if(!['txt','md','markdown','text','tex','csv','tsv','rst'].includes(ext))throw new Error('이 형식은 로컬 레이아웃 검증 경로가 필요합니다.');
  const bytes=new Uint8Array(await file.arrayBuffer());let encoding='utf-8',bom=0;
  if(bytes[0]===255&&bytes[1]===254){encoding='utf-16le';bom=2;}else if(bytes[0]===254&&bytes[1]===255){encoding='utf-16be';bom=2;}else if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)bom=3;
  const source=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(bom));
  // Parser normalizes CRLF for extraction. Map each normalized character back to raw byte ranges.
  const normalized=source.replace(/\r\n?/g,'\n');let positions=[],rawPos=0,bytePos=bom;
  for(const char of source){const length=encoding==='utf-8'?new TextEncoder().encode(char).length:char.length*2;positions.push({rawPos,bytePos,char,length});rawPos+=char.length;bytePos+=length;}
  const units=[];for(let i=0;i<positions.length;i++){const p=positions[i];if(p.char==='\r'){const next=positions[i+1];units.push({char:'\n',start:p.bytePos,end:next?.char==='\n'?next.bytePos+next.length:p.bytePos+p.length});if(next?.char==='\n')i++;}else units.push({char:p.char,start:p.bytePos,end:p.bytePos+p.length});}
  const boundaries=[];let offset=0;for(const u of units){boundaries[offset]=u.start;offset+=u.char.length;boundaries[offset]=u.end;}
  const edits=patches.map(p=>{const start=normalized.indexOf(p.before);if(start<0||normalized.indexOf(p.before,start+1)>=0)throw new Error('원본 파일의 인용이 없거나 중복됩니다. 변경 위치를 자동으로 추측하지 않습니다.');
    // Text layout preservation here means line endings and unchanged bytes; width/reflow in readers is not guaranteed.
    if(/[\r\n\t]/.test(p.before+p.after))throw new Error('텍스트 보존 경로는 한 줄 안의 변경만 지원합니다. 줄바꿈·탭을 포함한 변경은 차단합니다.');
    if(boundaries[start]===undefined||boundaries[start+p.before.length]===undefined)throw new Error('문자 경계가 일치하지 않습니다.');
    let replacement;if(encoding==='utf-8')replacement=new TextEncoder().encode(p.after);else{replacement=new Uint8Array(p.after.length*2);for(let i=0;i<p.after.length;i++){const n=p.after.charCodeAt(i);replacement[i*2+(encoding==='utf-16le'?0:1)]=n&255;replacement[i*2+(encoding==='utf-16le'?1:0)]=n>>8;}}
    return {start:boundaries[start],end:boundaries[start+p.before.length],replacement};}).sort((a,b)=>a.start-b.start);
  for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw new Error('변경 영역이 겹칩니다.');
  const length=bytes.length+edits.reduce((n,e)=>n+e.replacement.length-(e.end-e.start),0);const out=new Uint8Array(length);let input=0,output=0;
  for(const e of edits){out.set(bytes.subarray(input,e.start),output);output+=e.start-input;out.set(e.replacement,output);output+=e.replacement.length;input=e.end;}out.set(bytes.subarray(input),output);
  return {bytes:out,verification:{mode:'original-text-byte-patches',encoding,untouchedBytesPreserved:true,lineEndingsPreserved:true,visualLayoutVerified:false,limits:'글꼴·폭·줄바꿈 렌더링이 없는 원문 텍스트 형식. 표시 앱에서 자동 줄바꿈이 달라질 수 있습니다.'}};
}

export {docxFile} from './document-docx-export.js';

export {htmlFile} from './document-html-export.js';

export {odtFile} from './document-odt-export.js';

/* RED Pre-Injection Baseline Flaw Guard & Lossless PDF /URI Hyperlink Mutator (W5 D2-1 · D2-3). */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyRedBaselineUri=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';

  const SCHEMA='falsify.red-uri-mutator-js.v1';
  const ANSWER_SCHEMA='falsify.red-uri-answer-key.v1';
  const MAX_URI_LEN=1024;
  const OVERLAP_BADGE_TEXT='주의: 원본 기존 오류 의심 구간과 겹침';
  const HINT_WORDS=['intentional','fabricated','fake-doi','red-team','injected','falsify-red','red-plan','answer-key','answer_key','tampered','변조','가짜','함정','정답'];
  const SCRIPT_SRC=typeof document!=='undefined'&&document.currentScript?document.currentScript.src:'';

  function getSensorApi(){
    if(root.FalsifyBlueDefectSensor)return root.FalsifyBlueDefectSensor;
    if(typeof require==='function'){try{return require('./blue-defect-sensor-core.js');}catch{}}
    return null;
  }
  function getTaxonomyApi(){
    if(root.FalsifyAdversarialTaxonomy)return root.FalsifyAdversarialTaxonomy;
    if(typeof require==='function'){try{return require('./adversarial-taxonomy.js');}catch{}}
    return null;
  }

  function toPdfBytes(input){
    const bytes=input instanceof Uint8Array?input:(input instanceof ArrayBuffer?new Uint8Array(input):null);
    if(!bytes||bytes.length<5)throw new Error('유효한 PDF 바이트가 아닙니다.');
    if(bytes[0]!==0x25||bytes[1]!==0x50||bytes[2]!==0x44||bytes[3]!==0x46||bytes[4]!==0x2d)throw new Error('PDF 헤더(%PDF-)가 없습니다.');
    return bytes;
  }
  function bytesToLatin1(bytes){
    let out='';
    for(let i=0;i<bytes.length;i+=16384){
      out+=String.fromCharCode(...bytes.subarray(i,Math.min(i+16384,bytes.length)));
    }
    return out;
  }
  function latin1ToBytes(str){
    const out=new Uint8Array(str.length);
    for(let i=0;i<str.length;i++)out[i]=str.charCodeAt(i)&0xff;
    return out;
  }
  function safeDownloadName(name){
    const base=String(name||'paper.pdf').replace(/\.pdf$/i,'').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80)||'paper';
    return base+'-uri-modified.pdf';
  }

  function hasHintWord(uri){
    const low=uri.toLowerCase();
    return HINT_WORDS.some(w=>low.includes(w));
  }
  function hasControlOrNonAscii(uri){
    for(let i=0;i<uri.length;i++){
      const c=uri.charCodeAt(i);
      if(c<0x21||c>0x7e)return true;
    }
    return false;
  }
  function validateUriTarget(uri){
    if(typeof uri!=='string'||!uri||uri.length>MAX_URI_LEN)throw new Error('유효한 /URI 길이가 아닙니다 (1-1024자).');
    if(!/^https?:\/\/\S+$/i.test(uri))throw new Error('/URI는 http:// 또는 https:// 로 시작해야 하며 공백을 포함할 수 없습니다.');
    if(/[()]/.test(uri))throw new Error('/URI에 괄호를 포함할 수 없습니다.');
    if(hasHintWord(uri))throw new Error('맹검 누출 차단: /URI 대상에 변조 힌트 단어가 포함되어 있습니다.');
    if(hasControlOrNonAscii(uri))throw new Error('/URI는 ASCII 출력 가능 문자만 허용됩니다.');
    const tax=getTaxonomyApi();
    if(tax?.scanBlindnessLeaks){
      const scan=tax.scanBlindnessLeaks({text:uri,metadata:{uri}});
      if(!scan.clean)throw new Error('맹검 누출 차단: /URI 대상이 blindness 검사를 통과하지 못했습니다.');
    }
    let parsed;
    try{parsed=new URL(uri);}catch{throw new Error('올바른 URL 형식이 아닙니다.');}
    if(!parsed.hostname)throw new Error('URL 호스트가 비어 있습니다.');
    return uri;
  }

  function findStreamRanges(str){
    const ranges=[],re=/>>\s*stream\r?\n/g;
    let m;
    while((m=re.exec(str))!==null){
      const start=m.index+m[0].length;
      const end=str.indexOf('endstream',start);
      if(end===-1)break;
      ranges.push([start,end]);
      re.lastIndex=end+9;
    }
    return ranges;
  }
  function inRanges(pos,ranges){
    for(const r of ranges)if(pos>=r[0]&&pos<r[1])return true;
    return false;
  }

  function decodeEscape(str,i){
    const ch=str[i];
    const map={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','(':'(', ')':')', '\\':'\\'};
    if(Object.hasOwn(map,ch))return {ch:map[ch],next:i+1};
    if(ch==='\r'||ch==='\n')return {ch:'',next:ch==='\r'&&str[i+1]==='\n'?i+2:i+1};
    const oct=str.slice(i,i+3).match(/^[0-7]{1,3}/);
    if(oct)return {ch:String.fromCharCode(parseInt(oct[0],8)),next:i+oct[0].length};
    return {ch,next:i+1};
  }
  function readPdfLiteralString(str,openIdx){
    let depth=1,i=openIdx+1,out='';
    while(i<str.length&&depth>0){
      const ch=str[i];
      if(ch==='\\'){const esc=decodeEscape(str,i+1);out+=esc.ch;i=esc.next;}
      else if(ch==='('){depth++;out+=ch;i++;}
      else if(ch===')'){depth--;if(depth>0)out+=ch;i++;}
      else{out+=ch;i++;}
    }
    return depth===0?{value:out,end:i}:null;
  }
  function readPdfHexString(str,openIdx){
    const close=str.indexOf('>',openIdx+1);
    if(close===-1)return null;
    const hex=str.slice(openIdx+1,close).replace(/\s+/g,'');
    if(!/^[0-9a-fA-F]*$/.test(hex))return null;
    const padded=hex.length%2?hex+'0':hex;
    let out='';
    for(let i=0;i<padded.length;i+=2)out+=String.fromCharCode(parseInt(padded.slice(i,i+2),16));
    return {value:out,end:close+1};
  }
  function encodePdfLiteralString(uri){
    return '('+uri.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')+')';
  }

  function collectObjects(str,ranges){
    const objects=[],re=/(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while((m=re.exec(str))!==null){
      const objStart=m.index+(m[0].length-m[0].trimStart().length);
      if(inRanges(objStart,ranges))continue;
      const bodyStart=m.index+m[0].length;
      const endPos=str.indexOf('endobj',bodyStart);
      if(endPos===-1)continue;
      const streamRel=str.slice(bodyStart,endPos).search(/\bstream\r?\n/);
      const dictEnd=streamRel>=0?bodyStart+streamRel:endPos;
      objects.push({objNum:Number(m[1]),genNum:Number(m[2]),start:objStart,dictStart:bodyStart,dictEnd});
    }
    return objects;
  }
  function buildPageLookup(str,objects){
    const annotToPage=new Map();
    let pageIdx=0;
    for(const obj of objects){
      const dict=str.slice(obj.dictStart,obj.dictEnd);
      if(!/\/Type\s*\/Page\b(?!s)/.test(dict))continue;
      const m=/\/Annots\s*\[([^\]]*)\]/.exec(dict);
      if(m){
        const refs=m[1].matchAll(/(\d+)\s+\d+\s+R/g);
        for(const r of refs)annotToPage.set(Number(r[1]),pageIdx);
      }
      pageIdx++;
    }
    return annotToPage;
  }
  function scanObjectUris(str,obj,pageMap,entries){
    const dict=str.slice(obj.dictStart,obj.dictEnd);
    if(!/\/S\s*\/URI\b/.test(dict)&&!/\/Subtype\s*\/Link\b/.test(dict))return;
    const re=/\/URI\s*([(<])/g;
    let m;
    while((m=re.exec(dict))!==null){
      const openRel=m.index+m[0].length-1;
      const openAbs=obj.dictStart+openRel;
      const parsed=m[1]==='('?readPdfLiteralString(str,openAbs):readPdfHexString(str,openAbs);
      if(!parsed)continue;
      const pageIndex=pageMap.has(obj.objNum)?pageMap.get(obj.objNum):null;
      const idx=entries.length;
      entries.push({
        linkId:'p'+(pageIndex??0)+'-o'+obj.objNum+'-'+idx,
        index:idx,
        pageIndex,
        objNum:obj.objNum,
        genNum:obj.genNum,
        uri:parsed.value,
        start:openAbs,
        end:parsed.end,
        encoding:m[1]==='('?'literal':'hex',
      });
      re.lastIndex=parsed.end-obj.dictStart;
    }
  }
  function inspectPdfUriEntries(pdfBytes){
    const bytes=toPdfBytes(pdfBytes),str=bytesToLatin1(bytes);
    const ranges=findStreamRanges(str),objects=collectObjects(str,ranges),pageMap=buildPageLookup(str,objects);
    const entries=[];
    for(const obj of objects)scanObjectUris(str,obj,pageMap,entries);
    const compressed=/\/Type\s*\/(?:ObjStm|XRef)\b/.test(str);
    return {schema:SCHEMA,engine:'pure-js',linkCount:entries.length,entries,compressedObjectsDetected:compressed};
  }

  function matchReplacement(rep,entries){
    if(rep.linkId){
      const byId=entries.find(e=>e.linkId===rep.linkId);
      if(byId)return byId;
    }
    if(Number.isInteger(rep.index)&&entries[rep.index])return entries[rep.index];
    if(Number.isInteger(rep.objNum)){
      const byObj=entries.find(e=>e.objNum===rep.objNum);
      if(byObj)return byObj;
    }
    if(typeof rep.beforeUri==='string'){
      const byUri=entries.find(e=>e.uri===rep.beforeUri);
      if(byUri)return byUri;
    }
    throw new Error('대상 /URI 항목을 찾지 못했습니다.');
  }
  function latestOffsetBefore(objects,objNum,genNum,limit){
    let found=null;
    for(const obj of objects){
      if(obj.start>=limit)break;
      if(obj.objNum===objNum&&obj.genNum===genNum)found=obj.start;
    }
    return found;
  }
  function rewriteXrefBlock(block,xrefPos,objects){
    const lines=block.split(/(\r?\n)/);
    let objNum=0,expectSub=true;
    for(let i=0;i<lines.length;i+=2){
      const line=lines[i];
      if(/^xref\b/.test(line)||!line.trim())continue;
      const sub=/^(\d+)\s+(\d+)\s*$/.exec(line);
      if(sub&&expectSub){objNum=Number(sub[1]);continue;}
      const ent=/^(\d{10})( \d{5} ([nf])[ \t]*)$/.exec(line);
      if(ent){
        expectSub=false;
        if(ent[3]==='n'){
          const gen=Number(ent[2].trim().split(/\s+/)[0]);
          const off=latestOffsetBefore(objects,objNum,gen,xrefPos);
          if(off!==null)lines[i]=String(off).padStart(10,'0')+ent[2];
        }
        objNum++;
      }else{expectSub=true;}
    }
    return lines.join('');
  }
  function findXrefPositions(str){
    const positions=[],re=/(?:^|[\r\n])xref(?=\r?\n)/g;
    let m;
    while((m=re.exec(str))!==null){
      positions.push(m.index+(m[0].startsWith('\r')||m[0].startsWith('\n')?(m[0].startsWith('\r\n')?2:1):0));
    }
    return positions;
  }
  function updateAllXrefs(str){
    for(let pass=0;pass<2;pass++){
      const objects=collectObjects(str,findStreamRanges(str));
      const xrefs=findXrefPositions(str);
      if(!xrefs.length)return str;
      for(let k=xrefs.length-1;k>=0;k--){
        const xPos=xrefs[k],trPos=str.indexOf('trailer',xPos);
        if(trPos===-1)continue;
        const rewritten=rewriteXrefBlock(str.slice(xPos,trPos),xPos,objects);
        str=str.slice(0,xPos)+rewritten+str.slice(trPos);
      }
      const nextXrefs=findXrefPositions(str);
      str=str.replace(/(startxref\r?\n)(\d+)/g,(_,p)=>p+String(nextXrefs[nextXrefs.length-1]));
    }
    return str;
  }
  function mutatePdfUriBytes(pdfBytes,replacements){
    const bytes=toPdfBytes(pdfBytes);
    if(!Array.isArray(replacements))throw new Error('교체 목록이 배열이어야 합니다.');
    const inspected=inspectPdfUriEntries(bytes);
    if(inspected.compressedObjectsDetected&&!inspected.linkCount)throw new Error('압축된 PDF 객체 스트림(/ObjStm)은 순수 JS 파서에서 직접 수정할 수 없습니다.');
    const planned=replacements.map(rep=>{
      const entry=matchReplacement(rep,inspected.entries);
      if(rep.beforeUri!==undefined&&entry.uri!==rep.beforeUri)throw new Error('기존 /URI가 예상값과 다릅니다: '+entry.uri);
      const afterUri=validateUriTarget(rep.afterUri);
      return {entry,afterUri,rationale:typeof rep.rationale==='string'?rep.rationale.trim():''};
    }).sort((a,b)=>b.entry.start-a.entry.start);
    let str=bytesToLatin1(bytes);
    const changes=[];
    for(const item of planned){
      str=str.slice(0,item.entry.start)+encodePdfLiteralString(item.afterUri)+str.slice(item.entry.end);
      changes.unshift({
        linkId:item.entry.linkId,pageIndex:item.entry.pageIndex,annotIndex:item.entry.index,
        beforeUri:item.entry.uri,afterUri:item.afterUri,defectFamily:'D2',subtype:'identifier-hijack',
        ...(item.rationale?{rationale:item.rationale}:{}),
      });
    }
    const updated=planned.length?updateAllXrefs(str):str;
    return {schema:SCHEMA,engine:'pure-js',appliedCount:changes.length,changes,bytes:latin1ToBytes(updated)};
  }

  async function loadMupdf(){
    if(root.mupdf)return root.mupdf;
    if(!SCRIPT_SRC)return null;
    try{return await import(new URL('./browser-pdf-vendor/mupdf.js',SCRIPT_SRC).href);}catch{return null;}
  }
  function mupdfReadUri(action){
    if(!action||!action.isDictionary())return null;
    if(action.get('S')?.asName()!=='URI')return null;
    const u=action.get('URI');
    return u&&!u.isNull()?u.asString():null;
  }
  function inspectWithMupdf(engine,bytes){
    const doc=engine.Document.openDocument(bytes,'application/pdf');
    try{
      if(!(doc instanceof engine.PDFDocument))return null;
      const entries=[],count=doc.countPages();
      for(let p=0;p<count;p++){
        const annots=doc.findPage(p).get('Annots');
        if(!annots||!annots.isArray())continue;
        for(let a=0;a<annots.length;a++){
          const annot=annots.get(a);
          if(!annot||annot.get('Subtype')?.asName()!=='Link')continue;
          const uri=mupdfReadUri(annot.get('A'));
          if(typeof uri!=='string')continue;
          const idx=entries.length;
          entries.push({linkId:'p'+p+'-a'+a,index:idx,pageIndex:p,annotIndex:a,uri});
        }
      }
      return {schema:SCHEMA,engine:'mupdf-wasm',linkCount:entries.length,entries,compressedObjectsDetected:false};
    }finally{doc.destroy();}
  }
  function applyMupdfReplacement(doc,rep,entries){
    const entry=matchReplacement(rep,entries);
    if(rep.beforeUri!==undefined&&entry.uri!==rep.beforeUri)throw new Error('기존 /URI가 예상값과 다릅니다: '+entry.uri);
    const afterUri=validateUriTarget(rep.afterUri);
    const annot=doc.findPage(entry.pageIndex).get('Annots').get(entry.annotIndex);
    annot.get('A').put('URI',doc.newString(afterUri));
    return {
      linkId:entry.linkId,pageIndex:entry.pageIndex,annotIndex:entry.annotIndex,
      beforeUri:entry.uri,afterUri,defectFamily:'D2',subtype:'identifier-hijack',
      ...(typeof rep.rationale==='string'&&rep.rationale.trim()?{rationale:rep.rationale.trim()}:{}),
    };
  }
  function mutateWithMupdf(engine,bytes,replacements){
    const entries=inspectWithMupdf(engine,bytes)?.entries||[];
    const doc=engine.Document.openDocument(bytes,'application/pdf');
    try{
      const changes=replacements.map(r=>applyMupdfReplacement(doc,r,entries));
      const buf=doc.saveToBuffer('');
      try{return {schema:SCHEMA,engine:'mupdf-wasm',appliedCount:changes.length,changes,bytes:buf.asUint8Array().slice()};}
      finally{buf.destroy();}
    }finally{doc.destroy();}
  }
  async function inspectPdfUriEntriesAsync(pdfBytes){
    const bytes=toPdfBytes(pdfBytes);
    const pure=inspectPdfUriEntries(bytes);
    if(!pure.compressedObjectsDetected&&pure.linkCount>0)return pure;
    const engine=await loadMupdf();
    return engine?(inspectWithMupdf(engine,bytes)||pure):pure;
  }
  async function mutatePdfUriBytesAsync(pdfBytes,replacements){
    const bytes=toPdfBytes(pdfBytes);
    const pure=inspectPdfUriEntries(bytes);
    if(!pure.compressedObjectsDetected&&pure.linkCount>0)return mutatePdfUriBytes(bytes,replacements);
    const engine=await loadMupdf();
    if(engine)return mutateWithMupdf(engine,bytes,replacements);
    return mutatePdfUriBytes(bytes,replacements);
  }

  function normText(s){return String(s||'').replace(/\s+/g,' ').trim().toLowerCase();}
  function extractPageFromObj(obj){
    if(Number.isInteger(obj?.pageIndex)&&obj.pageIndex>=0)return obj.pageIndex;
    if(Number.isInteger(obj?.page)&&obj.page>=1)return obj.page-1;
    const m=/(?:PDF p\.|p(?:age)?\.?)\s*(\d+)/i.exec(String(obj?.label||''));
    return m?Math.max(0,Number(m[1])-1):null;
  }
  function resolvePageIndex(item,segments){
    const direct=extractPageFromObj(item);
    if(direct!==null)return direct;
    const seg=Array.isArray(segments)?segments.find(s=>s&&s.id===item?.segmentId):null;
    return seg?extractPageFromObj(seg):null;
  }
  function textOverlaps(a,b){
    const na=normText(a),nb=normText(b);
    if(na.length<6||nb.length<6)return false;
    if(na.includes(nb)||nb.includes(na))return true;
    if(Math.min(na.length,nb.length)<12)return false;
    const short=na.length<=nb.length?na:nb,long=na.length<=nb.length?nb:na;
    for(let i=0;i<=short.length-12;i++)if(long.includes(short.slice(i,i+12)))return true;
    return false;
  }
  function refIndexOverlap(candText,sig){
    const idx=sig?.reported?.refIndex;
    if(Number.isInteger(idx)&&new RegExp('\\['+idx+'\\]').test(candText))return true;
    const indices=sig?.reported?.indices;
    if(Array.isArray(indices)&&indices.some(n=>new RegExp('\\['+n+'\\]').test(candText)))return true;
    return false;
  }
  function candidateQuotes(cand){
    const list=[cand?.before];
    if(Array.isArray(cand?.evidence))for(const e of cand.evidence)if(e?.quote)list.push(e.quote);
    return list.filter(q=>typeof q==='string'&&q.trim());
  }
  function signalCueTerms(sig){
    const r=sig?.reported;
    if(!r||typeof r!=='object')return [];
    const out=[];
    if(Number.isInteger(r.citedIndex))out.push('['+r.citedIndex+']');
    if(Number.isInteger(r.refIndex))out.push('['+r.refIndex+']');
    if(Number.isInteger(r.index))out.push('['+r.index+']');
    if(typeof r.doi==='string'&&r.doi)out.push(r.doi);
    if(r.p!==undefined)out.push(String(r.p).replace(/^0(?=\.)/,''));
    if(r.statValue!==undefined)out.push(String(r.statValue));
    return out.map(s=>s.toLowerCase());
  }
  function narrowExcerpt(sig,sigExcerpt){
    const raw=String(sigExcerpt||'');
    const cues=signalCueTerms(sig);
    if(!cues.length)return raw;
    const parts=raw.split(/(?<=[.!?\n])\s+/).filter(Boolean);
    if(parts.length<=1)return raw;
    const hit=parts.filter(p=>cues.some(c=>p.toLowerCase().includes(c)));
    return hit.length?hit.join(' '):raw;
  }
  function signalMatchesCandidate(sig,cand,candPage,segments){
    const sigPage=resolvePageIndex(sig,segments);
    const quotes=candidateQuotes(cand);
    const sigExcerpt=narrowExcerpt(sig,sig?.excerpt||sig?.detail||'');
    if(quotes.some(q=>textOverlaps(q,sigExcerpt)))return true;
    if(candPage!==null&&sigPage!==null&&candPage===sigPage){
      if(quotes.some(q=>refIndexOverlap(q,sig)))return true;
    }
    return false;
  }
  function summarizeCounts(report){
    const signals=Array.isArray(report?.signals)?report.signals:[];
    const c=report?.counts||{};
    const d1=Number.isInteger(c.d1)?c.d1:signals.filter(s=>(s.category||s.family)==='D1').length;
    const d2=Number.isInteger(c.d2)?c.d2:signals.filter(s=>(s.category||s.family)==='D2').length;
    const total=Number.isInteger(c.total)?c.total:signals.length;
    return {d1,d2,companion:Math.max(0,total-d1-d2),total};
  }
  function checkBaselineOverlap({segments=[],candidates=[],sensorReport=null}={}){
    const segList=Array.isArray(segments)?segments:[],candList=Array.isArray(candidates)?candidates:[];
    const api=getSensorApi();
    const report=sensorReport||(api?api.scanSegments({segments:segList}):{signals:[],counts:{d1:0,d2:0,companion:0,total:0}});
    const signals=Array.isArray(report.signals)?report.signals:[];
    const overlaps=[];
    candList.forEach((cand,idx)=>{
      if(!cand||typeof cand!=='object')return;
      const candPage=resolvePageIndex(cand,segList);
      const matched=signals.filter(sig=>signalMatchesCandidate(sig,cand,candPage,segList));
      if(matched.length)overlaps.push({candidateIndex:idx,candidateId:cand.id??null,pageIndex:candPage,signals:matched,message:OVERLAP_BADGE_TEXT});
    });
    return {report,counts:summarizeCounts(report),overlaps,hasOverlap:overlaps.length>0};
  }

  function resolveMountHost(doc,explicitHost){
    if(explicitHost)return {host:explicitHost,mode:'prepend'};
    const wb=doc.getElementById?.('view-workbench')||doc.querySelector?.('#view-workbench');
    if(wb)return {host:wb,mode:'after-first-step'};
    const dr=doc.getElementById?.('document-red')||doc.querySelector?.('#document-red');
    return dr?{host:dr,mode:'prepend'}:null;
  }
  function insertPanel(hostInfo,section){
    const {host,mode}=hostInfo;
    if(mode==='after-first-step'){
      const first=host.querySelector?.('.role-step')||host.children?.find?.(c=>String(c.className||'').includes('role-step'));
      if(first&&typeof first.after==='function'){first.after(section);return;}
    }
    if(typeof host.prepend==='function')host.prepend(section);
    else host.append(section);
  }
  function makeEl(doc,tag,cls,text){
    const n=doc.createElement(tag);
    if(cls)n.className=cls;
    if(text!==undefined)n.textContent=text;
    return n;
  }
  function visibleNav(doc,view){
    const list=doc.querySelectorAll?.('[data-view='+view+']')||[];
    const visible=[...list].find(b=>b.getClientRects?.().length);
    return visible||doc.querySelector?.('[data-view='+view+']')||null;
  }
  function triggerDownload(doc,bytes,name,type){
    if(!root.URL?.createObjectURL||!root.Blob)return;
    const url=root.URL.createObjectURL(new root.Blob([bytes],{type}));
    const a=doc.createElement('a');
    a.href=url;a.download=name;
    doc.body?.append?.(a);a.click?.();a.remove?.();
    if(typeof setTimeout==='function')setTimeout(()=>root.URL.revokeObjectURL?.(url),1000);
  }

  function extractDomCandidate(card){
    const label=card.querySelector?.('.check-row span')?.textContent||'';
    const before=card.querySelector?.('.red-ab p')?.textContent||'';
    const quotes=[...(card.querySelectorAll?.('blockquote')||[])].map(b=>({quote:b.textContent||''}));
    return {label,before,evidence:quotes};
  }
  function buildPanelDom(doc){
    const section=makeEl(doc,'section','red-baseline-uri-panel');
    section.id='red-baseline-uri-panel';section.hidden=true;
    section.setAttribute?.('aria-labelledby','red-baseline-uri-title');
    const title=makeEl(doc,'h3','red-baseline-uri-title','원본 기존 오류 사전 스캔 (Baseline Guard)');
    title.id='red-baseline-uri-title';
    const summary=makeEl(doc,'p','red-baseline-guard-summary','');
    summary.id='red-baseline-guard-summary';
    const guardDetails=makeEl(doc,'details','red-baseline-guard-details');guardDetails.hidden=true;
    const guardSum=makeEl(doc,'summary','','사전 감지 단서 목록');
    const guardList=makeEl(doc,'ul','red-baseline-guard-list');
    guardDetails.append(guardSum,guardList);
    const uriDetails=makeEl(doc,'details','red-uri-details');
    const uriSummary=makeEl(doc,'summary','','PDF 숨은 하이퍼링크(/URI) 표적 변조 (D2-1 · D2-3)');
    const uriStatus=makeEl(doc,'p','form-feedback','');uriStatus.id='red-uri-status';
    const uriList=makeEl(doc,'div','red-uri-list');uriList.id='red-uri-list';
    const actions=makeEl(doc,'div','button-row red-uri-actions');
    const dlPdf=makeEl(doc,'button','button secondary','변조 PDF 다운로드');dlPdf.type='button';dlPdf.id='red-uri-download';dlPdf.disabled=true;
    const dlKey=makeEl(doc,'button','button secondary','D2 정답지 JSON 저장');dlKey.type='button';dlKey.id='red-uri-answer-download';dlKey.disabled=true;
    const toBlue=makeEl(doc,'button','button primary','BLUE로 보내기');toBlue.type='button';toBlue.id='red-uri-handoff-blue';toBlue.disabled=true;
    actions.append(dlPdf,dlKey,toBlue);
    uriDetails.append(uriSummary,uriStatus,uriList,actions);
    section.append(title,summary,guardDetails,uriDetails);
    return {section,summary,guardDetails,guardSum,guardList,uriStatus,uriList,dlPdf,dlKey,toBlue};
  }

  function mount(doc,explicitHost){
    if(!doc||doc.getElementById?.('red-baseline-uri-panel')||doc.querySelector?.('#red-baseline-uri-panel'))return null;
    const hostInfo=resolveMountHost(doc,explicitHost);
    if(!hostInfo)return null;
    const ui=buildPanelDom(doc);
    insertPanel(hostInfo,ui.section);
    let epoch=0,activeReport=null,activeSegments=[],activeFile=null,activeBytes=null,activeEntries=[],lastMutation=null;

    function renderGuard(report){
      const counts=summarizeCounts(report);
      ui.guardList.replaceChildren();
      if(counts.total===0){
        ui.summary.textContent='감지된 기존 Layer 0 어긋남 0건 — 안전';
        ui.guardDetails.hidden=true;return;
      }
      ui.summary.textContent='주입 전 원문에서 이미 D1 수치 단서 '+counts.d1+'건 · D2 서지 단서 '+counts.d2+'건이 감지되었습니다. 해당 구간에 결함을 겹쳐 심으면 채점이 왜곡될 수 있습니다.';
      ui.guardSum.textContent='사전 감지된 원문 단서 목록 ('+counts.total+'건)';
      for(const s of (report.signals||[]).slice(0,40)){
        const pg=Number.isInteger(s.pageIndex)?'p.'+(s.pageIndex+1)+' · ':'';
        ui.guardList.append(makeEl(doc,'li','red-baseline-guard-item','['+(s.category||s.family||'L0')+'] '+pg+(s.detail||s.kind)+(s.excerpt?' — "'+String(s.excerpt).slice(0,110)+'"':'')));
      }
      ui.guardDetails.hidden=false;
    }
    function annotateCandidates(){
      const container=doc.getElementById?.('red-candidates')||doc.querySelector?.('#red-candidates');
      if(!container||!activeReport)return;
      const cards=[...(container.querySelectorAll?.('.red-proposal')||container.children||[])];
      for(const card of cards){
        card.querySelectorAll?.('.red-baseline-overlap-badge').forEach(b=>b.remove());
        const cand=extractDomCandidate(card);
        const res=checkBaselineOverlap({segments:activeSegments,candidates:[cand],sensorReport:activeReport});
        if(res.hasOverlap){
          const kinds=[...new Set(res.overlaps[0].signals.map(s=>s.category||s.family||'L0'))].join('/');
          card.append(makeEl(doc,'p','red-baseline-overlap-badge',OVERLAP_BADGE_TEXT+' ('+kinds+')'));
        }
      }
    }
    function collectReplacements(){
      const rows=[...(ui.uriList.querySelectorAll?.('.red-uri-row')||[])];
      const out=[];
      for(const row of rows){
        const val=row.querySelector('.red-uri-input')?.value?.trim()||'';
        if(!val)continue;
        const rationale=row.querySelector('.red-uri-rationale')?.value?.trim()||'';
        const linkId=row.dataset?.linkId;
        const entry=activeEntries.find(e=>e.linkId===linkId);
        if(entry)out.push({linkId:entry.linkId,index:entry.index,beforeUri:entry.uri,afterUri:val,rationale});
      }
      return out;
    }
    function syncUriButtons(){
      const hasEdits=collectReplacements().length>0&&!!activeBytes;
      ui.dlPdf.disabled=!hasEdits;
      ui.toBlue.disabled=!hasEdits;
      ui.dlKey.disabled=!lastMutation;
    }
    function setUriStatus(text,isErr){
      ui.uriStatus.textContent=text;
      ui.uriStatus.classList.toggle('error',!!isErr);
    }
    function renderUriEntries(entries){
      ui.uriList.replaceChildren();
      if(!entries.length){
        setUriStatus('감지된 PDF /URI 하이퍼링크가 없습니다.',false);syncUriButtons();return;
      }
      setUriStatus('감지된 /URI 하이퍼링크 '+entries.length+'건 — 교체할 https:// 대상 URL을 입력하세요.',false);
      for(const entry of entries){
        const row=makeEl(doc,'div','red-uri-row');
        if(row.dataset)row.dataset.linkId=entry.linkId;
        const pg=Number.isInteger(entry.pageIndex)?'p.'+(entry.pageIndex+1):'p.?';
        row.append(makeEl(doc,'p','red-uri-current',pg+' · '+entry.linkId+' · 현재: '+entry.uri));
        const input=makeEl(doc,'input','red-uri-input');
        input.type='url';input.placeholder='https://doi.org/...';input.maxLength=MAX_URI_LEN;
        const rat=makeEl(doc,'input','red-uri-rationale');
        rat.type='text';rat.placeholder='D2 정답지 메모 (선택 · PDF에는 미포함)';rat.maxLength=300;
        input.addEventListener('input',()=>{lastMutation=null;syncUriButtons();});
        row.append(input,rat);
        ui.uriList.append(row);
      }
      syncUriButtons();
    }
    async function runMutation(){
      const reps=collectReplacements();
      if(!reps.length||!activeBytes)throw new Error('변조할 /URI 대상 URL을 하나 이상 입력하세요.');
      const res=await mutatePdfUriBytesAsync(activeBytes,reps);
      lastMutation=res;syncUriButtons();
      return res;
    }
    ui.dlPdf.addEventListener('click',async()=>{
      try{
        const res=await runMutation();
        triggerDownload(doc,res.bytes,safeDownloadName(activeFile?.name),'application/pdf');
        setUriStatus('블라인드 /URI 변조 PDF를 다운로드했습니다 ('+res.appliedCount+'건 교체).',false);
      }catch(e){setUriStatus('변조 차단: '+(e?.message||'오류'),true);}
    });
    ui.dlKey.addEventListener('click',()=>{
      if(!lastMutation)return;
      const key={schema:ANSWER_SCHEMA,sourceName:activeFile?.name||null,defectFamily:'D2',changes:lastMutation.changes};
      triggerDownload(doc,new TextEncoder().encode(JSON.stringify(key,null,2)),'falsify-red-uri-answer-key.json','application/json');
    });
    ui.toBlue.addEventListener('click',async()=>{
      try{
        const res=await runMutation();
        const name=safeDownloadName(activeFile?.name);
        const blindFile=typeof root.File==='function'?new root.File([res.bytes],name,{type:'application/pdf'}):{name,type:'application/pdf',bytes:res.bytes};
        const ev=new root.CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:blindFile}});
        if(doc.dispatchEvent(ev))visibleNav(doc,'blue')?.click?.();
        setUriStatus('블라인드 /URI 변조 PDF를 BLUE에 전달했습니다 ('+res.appliedCount+'건).',false);
      }catch(e){setUriStatus('BLUE 전달 차단: '+(e?.message||'오류'),true);}
    });

    function isPdfDocument(file,result){
      if(!file||typeof file.arrayBuffer!=='function')return false;
      return file.type==='application/pdf'||/\.pdf$/i.test(file.name||'')||result?.format==='PDF';
    }
    async function loadPdfUris(file,current){
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(current!==epoch)return;
        activeBytes=bytes;
        const inspected=await inspectPdfUriEntriesAsync(bytes);
        if(current!==epoch)return;
        activeEntries=inspected.entries;
        renderUriEntries(activeEntries);
      }catch(e){if(current===epoch)setUriStatus('PDF /URI 검사 실패: '+(e?.message||'오류'),true);}
    }
    async function handleDocument(event){
      const current=++epoch,detail=event?.detail||{},file=detail.file||null,result=detail.result||{};
      const segs=Array.isArray(detail.segments)?detail.segments:result.segments;
      activeFile=file;activeSegments=Array.isArray(segs)?segs:[];
      activeBytes=null;activeEntries=[];lastMutation=null;
      const api=getSensorApi();
      activeReport=api?api.scanSegments({fileHash:detail.fileHash||null,segments:activeSegments}):{signals:[],counts:{d1:0,d2:0,companion:0,total:0}};
      ui.section.hidden=false;
      renderGuard(activeReport);
      annotateCandidates();
      if(!isPdfDocument(file,result)){
        ui.uriList.replaceChildren();setUriStatus('PDF 파일에서만 /URI 하이퍼링크 검사와 변조를 사용할 수 있습니다.',false);syncUriButtons();return;
      }
      await loadPdfUris(file,current);
    }
    function handleClear(){
      epoch++;activeReport=null;activeSegments=[];activeFile=null;activeBytes=null;activeEntries=[];lastMutation=null;
      ui.section.hidden=true;ui.uriList.replaceChildren();ui.guardList.replaceChildren();setUriStatus('',false);syncUriButtons();
    }

    doc.addEventListener('falsify:document',e=>{void handleDocument(e);});
    doc.addEventListener('falsify:document-clear',handleClear);
    doc.addEventListener('falsify:document-state',annotateCandidates);
    const candRoot=doc.getElementById?.('red-candidates')||doc.querySelector?.('#red-candidates');
    if(candRoot&&typeof root.MutationObserver==='function'){
      new root.MutationObserver(()=>annotateCandidates()).observe(candRoot,{childList:true});
    }
    return ui.section;
  }

  if(root.document){
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>mount(root.document),{once:true});
    else mount(root.document);
  }

  return {
    SCHEMA,
    OVERLAP_BADGE_TEXT,
    validateUriTarget,
    inspectPdfUriEntries,
    mutatePdfUriBytes,
    inspectPdfUriEntriesAsync,
    mutatePdfUriBytesAsync,
    checkBaselineOverlap,
    mount,
  };
});

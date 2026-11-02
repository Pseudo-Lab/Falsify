import {hex} from './paragraph-pdf-crypto.mjs';
import {analyzeLatexSource} from './latex-source-model.mjs';
import {readLayoutStructure} from './paper-layout-structure.mjs';
import {parseSynctex} from './latex-synctex-map.mjs';
import {readDocument} from './paper-document.mjs';
import {readSourceLinks} from './paper-source-links.mjs';
import {compareReconstruction} from './pdf-latex-baseline.mjs';

const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const fail=code=>{throw Object.assign(new Error(code),{code});};
const abort=signal=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
const key=id=>Array.from(enc.encode(id),b=>b.toString(16).padStart(2,'0')).join('');
function validate(project,artifact,{optionalArtifact=false}={}){
 if(project?.schema!=='falsify.latex-project.v1'||!Array.isArray(project.files))fail('INVALID_PROJECT');
 const paths=new Set();for(const f of project.files){if(!f?.path||paths.has(f.path)||!(f.bytes instanceof Uint8Array)||hex(f.bytes)!==f.sha256)fail('STALE_PROJECT');paths.add(f.path);}
 const files=project.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 if(hex(enc.encode(JSON.stringify({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin})))!==project.id)fail('STALE_PROJECT');
 if(optionalArtifact && artifact == null)return;
 if(artifact?.schema!=='falsify.latex-artifact.v1'||artifact.success!==true||artifact.projectId!==project.id||artifact.engine!==project.engine||!(artifact.pdfBytes instanceof Uint8Array)||!artifact.pdfBytes.length||hex(artifact.pdfBytes)!==artifact.pdfHash)fail('INVALID_ARTIFACT');
}
function page(items,args={}){const offset=args.offset??0,limit=args.limit??20;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)fail('INVALID_PAGINATION');return {total:items.length,offset,limit,nextOffset:offset+limit<items.length?offset+limit:null,items:items.slice(offset,offset+limit)};}
const OBSERVATION_BUDGET=12000;
const high=(s,i)=>i>=0&&i<s.length&&s.charCodeAt(i)>=0xD800&&s.charCodeAt(i)<=0xDBFF;
const low=(s,i)=>i>=0&&i<s.length&&s.charCodeAt(i)>=0xDC00&&s.charCodeAt(i)<=0xDFFF;
const observationBytes=value=>JSON.stringify({status:'ok',observation:value}).length;
function snapEnd(source,text,start,end){
 const snap=(value,index)=>index>start&&index<value.length&&high(value,index-1)&&low(value,index)?index-1:index;
 end=snap(source,snap(text,end));
 if(end===start&&(high(source,start)&&low(source,start+1)||high(text,start)&&low(text,start+1)))return Math.min(Math.max(source.length,text.length),start+2);
 return end;
}
function fitInspection(result){
 if(observationBytes(result)<=OBSERVATION_BUDGET)return result;
 const items=result.blocks.items.map(item=>({id:item.id,detail:'이 항목의 부가 정보가 관찰 한도를 넘습니다. 식별자는 유지했습니다. 다음 항목은 offset으로 요청하세요.'}));
 let fitted={...result,blocks:{...result.blocks,items}};
 if(observationBytes(fitted)<=OBSERVATION_BUDGET)return fitted;
 fitted={...fitted,fonts:fitted.fonts?{...fitted.fonts,items:[],detail:'글꼴 목록이 관찰 한도에 들어가지 않습니다. limit를 줄이세요.'}:null,images:fitted.images?{...fitted.images,items:[],detail:'그림 목록이 관찰 한도에 들어가지 않습니다. limit를 줄이세요.'}:null};
 if(observationBytes(fitted)<=OBSERVATION_BUDGET)return fitted;
 const next=result.blocks.nextOffset;
 throw Object.assign(new Error(next==null?'문서 목록의 한 항목이 관찰 한도를 넘고 식별자를 유지한 채 줄일 수 없습니다. 구조를 나누세요.':`문서 목록의 한 항목이 관찰 한도를 넘습니다. offset ${next}으로 다음 항목을 요청하세요.`),{code:'request_limit'});
}
function blocks(project,artifact){
 const files=new Map(project.files.map(f=>[f.path,f]));const texts=new Map(project.files.filter(f=>/\.tex$/i.test(f.path)).map(f=>[f.path,dec.decode(f.bytes)]));
 const map=artifact?.synctex?parseSynctex(artifact.synctex,{project}):null;
 const geometry=(path,start,end)=>{const src=texts.get(path);if(!map||src===undefined)return {status:'unavailable',candidates:[]};const first=src.slice(0,start).split('\n').length,last=src.slice(0,end).split('\n').length;const hits=map.boxes.filter(b=>b.path===path&&b.line>=first&&b.line<=last);return {status:hits.length?'matched':'missing',frame:'synctex-top-left-bp',pageBoxMapping:'unverified',candidates:hits.map(({pageIndex,line,box})=>({pageIndex,line,box,frame:'synctex-top-left-bp',pageBox:'unverified'}))};};
 if(project.origin==='reconstructed-pdf'&&files.has('falsify-layout-structure.json')){
  const structure=readLayoutStructure(project),source=texts.get(project.mainFile);
  return structure.units.map(u=>{const id=key(u.id),begin=`% FALSIFY-UNIT-BEGIN ${id}\n`,end=`% FALSIFY-UNIT-END ${id}\n`,start=source.indexOf(begin)+begin.length,stop=source.indexOf(end,start),payload=source.slice(start,stop);const group=structure.groups.find(g=>g.includes(u.id))||null;return {id:u.id,kind:u.kind,role:u.role,sourceGeometry:{pageIndex:u.pageIndex,bbox:u.bbox,frame:'mupdf-display'},currentGeometry:geometry(project.mainFile,start,stop),path:project.mainFile,sourceRange:{start,end:stop},sourceText:payload,text:payload,group,assetPaths:[...payload.matchAll(/\\(?:FalsifyImage|includegraphics)(?:\[[^\]]*\])?(?:\{[^{}]*\}){0,2}\{([^{}]+)\}/g)].map(m=>m[1]),evidenceStatus:'source-bound'};});
 }
 return analyzeLatexSource(project).nodes.map(n=>({id:n.id,kind:n.kind,role:n.kind,path:n.path,sourceRange:{start:n.start,end:n.end},sourceText:n.sourceText,text:n.text,sourceGeometry:null,currentGeometry:geometry(n.path,n.start,n.end),group:null,assetPaths:[],evidenceStatus:'source-node'}));
}
async function inspect({project,artifact,referenceBytes,signal}){abort(signal);validate(project,artifact,{optionalArtifact:true});if(referenceBytes!==undefined&&(!(referenceBytes instanceof Uint8Array)||!project.sourcePdfHash||hex(referenceBytes)!==project.sourcePdfHash))fail('STALE_REFERENCE');const units=blocks(project,artifact);const doc=artifact?await readDocument({file:artifact.pdfBytes,fileHash:artifact.pdfHash,signal}):null;abort(signal);return {units,doc};}
/** Inspect source-bound blocks and current PDF inventories. */
export async function inspectLayoutDocument({project,artifact,referenceBytes,args={},signal}={}){
 const {units,doc}=await inspect({project,artifact,referenceBytes,signal});let filtered=units;if(args.query){const q=String(args.query).toLocaleLowerCase();filtered=filtered.filter(b=>[b.id,b.text,b.kind,b.role].some(v=>String(v||'').toLocaleLowerCase().includes(q)));}if(args.kind)filtered=filtered.filter(b=>b.kind===args.kind||b.role===args.kind);if(args.pageIndex!==undefined)filtered=filtered.filter(b=>b.sourceGeometry?.pageIndex===args.pageIndex||b.currentGeometry.candidates.some(x=>x.pageIndex===args.pageIndex));
 let limit=args.limit??20;const build=()=>({schema:'falsify.layout-document-inspection.v1',projectId:project.id,outputHash:artifact?.pdfHash??null,blocks:page(filtered.map(({id,kind,role,path,sourceGeometry,currentGeometry,text})=>({id,kind,role,path,sourceGeometry,textPreview:text.slice(0,60),currentGeometry:{status:currentGeometry.status,frame:currentGeometry.frame,pageBoxMapping:currentGeometry.pageBoxMapping,candidates:currentGeometry.candidates.slice(0,1),candidateCount:currentGeometry.candidates.length}})),{...args,limit}),fonts:doc? page(doc.styles.map(({id,fontName,size})=>({id,fontName,size})),{...args,limit}):null,images:doc? page(doc.assets.map(({id,kind,source,content})=>({id,kind,source,width:content?.width??null,height:content?.height??null})),{...args,limit}):null,pageCount:doc?.pages.length??null});let result=build();while((JSON.stringify(result).length>8500||observationBytes(result)>OBSERVATION_BUDGET)&&limit>1){limit=Math.max(1,Math.floor(limit/2));result=build();}return fitInspection(result);
}
/** Return one source-bound block with current SyncTeX candidates. */
export async function getLayoutBlock({project,artifact,referenceBytes,args={},signal}={}){
 const {units}=await inspect({project,artifact,referenceBytes,signal});const block=units.find(b=>b.id===args.blockId);if(!block)fail('BLOCK_NOT_FOUND');
 const offset=args.offset??0,limit=args.limit??2000;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>4096)fail('INVALID_PAGINATION');
 const {sourceText,text,currentGeometry,assetPaths,...detail}=block;
 let start=offset;if(start>0&&(low(sourceText,start)&&high(sourceText,start-1)||low(text,start)&&high(text,start-1)))start--;
 const maxLen=Math.max(sourceText.length,text.length),ceiling=snapEnd(sourceText,text,start,Math.min(maxLen,start+limit));
 const geometry=page(currentGeometry.candidates,{offset:args.geometryOffset??0,limit:2}),assets=page(assetPaths,{offset:args.assetOffset??0,limit:2});
 const build=end=>{
  const sourceEnd=Math.min(end,sourceText.length),textEnd=Math.min(end,text.length);
  const sourceSlice=sourceText.slice(Math.min(start,sourceText.length),sourceEnd),textSlice=text.slice(Math.min(start,text.length),textEnd);
  const body={...detail,sourceText:sourceSlice,text:textSlice,sourceTextPage:{total:sourceText.length,offset:start,limit:sourceSlice.length,nextOffset:sourceEnd<sourceText.length?sourceEnd:null},textPage:{total:text.length,offset:start,limit:textSlice.length,nextOffset:textEnd<text.length?textEnd:null},currentGeometry:{...currentGeometry,candidates:geometry},assetPaths:assets};
  const registeredId='lt1_'+'a'.repeat(64),budgetBlock=block.evidenceStatus==='source-bound'?{...body,targetId:block.id,sourceBlockId:block.id}:{...body,id:registeredId,targetId:registeredId,sourceBlockId:block.id};
  const described={schema:'falsify.layout-block.v1',projectId:project.id,outputHash:artifact?.pdfHash??null,block:budgetBlock};
  return {bytes:observationBytes(described),value:{schema:described.schema,projectId:described.projectId,outputHash:described.outputHash,block:body}};
 };
 if(start>=maxLen)return build(start).value;
 let lo=start,hi=Math.min(maxLen,start+limit),best=start;
 while(lo<=hi){const mid=Math.floor((lo+hi)/2),end=Math.min(ceiling,snapEnd(sourceText,text,start,mid));if(build(end).bytes<=OBSERVATION_BUDGET){best=end;lo=mid+1;}else hi=mid-1;}
 if(best===start&&start<maxLen)throw Object.assign(new Error('이 블록은 한 글자도 관찰 한도에 들어가지 않습니다. blockId를 확인하고 offset으로 다른 구간을 요청하세요.'),{code:'request_limit'});
 return build(best).value;
}
// Accept a generated wrapper only if its options reconstruct its exact shell.
function unwrapBlock(text){
 const m=/^% FALSIFY-BLOCK-OPTIONS ([A-Za-z0-9+/=]+)\n% FALSIFY-BLOCK-BEGIN\n([\s\S]*?)% FALSIFY-BLOCK-CONTENT\n([\s\S]*?)% FALSIFY-BLOCK-CONTENT-END\n([\s\S]*?)% FALSIFY-BLOCK-END\n$/.exec(text);if(!m)return text;
 let o;try{o=JSON.parse(dec.decode(Uint8Array.from(atob(m[1]),c=>c.charCodeAt(0))));}catch{return text;}
 const keys=['fontSizeBp','leadingBp','gapBeforeBp','gapAfterBp','indentBp','widthBp','pageBreakBefore','keepWithNext','align'];if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k)))return text;
 for(const k of ['fontSizeBp','leadingBp','gapBeforeBp','gapAfterBp','indentBp','widthBp'])if(k in o&&(typeof o[k]!=='number'||!Number.isFinite(o[k])))return text;
 for(const k of ['pageBreakBefore','keepWithNext'])if(k in o&&typeof o[k]!=='boolean')return text;
 if('align'in o&&!['left','center','right','justify'].includes(o.align))return text;
 let pre=(o.pageBreakBefore?'\\clearpage\n':'')+(o.gapBeforeBp?`\\vspace*{${o.gapBeforeBp}bp}\n`:'');pre+='\\begingroup\n';if(o.indentBp!==undefined)pre+=`\\setlength{\\parindent}{${o.indentBp}bp}\n`;if(o.widthBp!==undefined)pre+=`\\begin{minipage}{${o.widthBp}bp}\n`;if(o.align)pre+=({left:'\\raggedright',center:'\\centering',right:'\\raggedleft',justify:'\\normalfont'}[o.align])+'\n';
 const post=(o.widthBp!==undefined?'\\end{minipage}\n':'')+'\\endgroup\n'+(o.gapAfterBp?`\\vspace*{${o.gapAfterBp}bp}\n`:'')+(o.keepWithNext?'\\nopagebreak[4]\n':'');
 return m[2]===pre&&m[4]===post?m[3]:text;
}
function protectUnknownArguments(text){
 const known=new Set(['textbf','textit','emph','textrm','textsf','texttt','textsc','fontsize','selectfont','bfseries','itshape','normalfont','centering','raggedright','raggedleft','begingroup','endgroup','noindent','nopagebreak','Needspace','needspace','vspace','hspace','par','setlength']);const saved=[];let out='',i=0;
 while(i<text.length){const m=/^\\([A-Za-z@]+)\*?/.exec(text.slice(i));if(!m||known.has(m[1])){out+=m?m[0]:text[i];i+=m?m[0].length:1;continue;}let end=i+m[0].length,j=end;while(/\s/.test(text[j]||''))j++;if(text[j]!=='{'){out+=m[0];i=end;continue;}let depth=0,k=j;for(;k<text.length;k++){if(text[k]==='\\'){k++;continue;}if(text[k]==='{')depth++;if(text[k]==='}'&&!--depth){k++;break;}}if(depth!==0){out+=text.slice(i);break;}saved.push(text.slice(i,k));out+=`\uE000${saved.length-1}\uE001`;i=k;}
 return {text:out,restore:value=>value.replace(/\uE000(\d+)\uE001/g,(_,n)=>saved[Number(n)])};
}
// Apply supported typography normalization outside math and comments.
function sourceContent(text){
 text=unwrapBlock(text);const parts=text.split(/(\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]*?(?<!\\)\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)%[^\n]*)/g);
 return parts.map((part,i)=>{if(i%2)return part;const protectedPart=protectUnknownArguments(part);part=protectedPart.text;let prior;do{prior=part;part=part.replace(/\\(?:textbf|textit|emph|textrm|textsf|texttt|textsc)\s*\{([^{}]*)\}/g,'$1');}while(part!==prior);return protectedPart.restore(part.replace(/\\setlength\s*\{\s*\\(?:baselineskip|parindent)\s*\}\s*\{\s*[\d.]+(?:bp|pt|mm|cm|in|em|ex)\s*\}/g,'').replace(/\\fontsize\s*\{[\d.]+(?:bp|pt)?\}\s*\{[\d.]+(?:bp|pt)?\}/g,'').replace(/\\(?:selectfont|bfseries|itshape|normalfont|centering|raggedright|raggedleft|begingroup|endgroup|noindent|nopagebreak)\b(?:\s*\[[^\]]*\])?/g,'').replace(/\\(?:Needspace|needspace|vspace|hspace)\*?\s*\{[\d.]+(?:bp|pt|mm|cm|in|em|ex)\}/g,'').replace(/\\par\b/g,'').replace(/\s+/g,' '));}).join('').trim();
}
/** Compare a captured pre-layout artifact with the candidate artifact. */
export async function compareLayoutDocuments({project,artifact,baselineProject,baselineArtifact,args={},signal}={}){
 abort(signal);validate(project,artifact);validate(baselineProject,baselineArtifact);if(project.origin==='reconstructed-pdf'&&baselineProject.origin==='reconstructed-pdf'&&project.sourcePdfHash!==baselineProject.sourcePdfHash)fail('STALE_REFERENCE');const [before,after]=await Promise.all([readDocument({file:baselineArtifact.pdfBytes,fileHash:baselineArtifact.pdfHash,signal}),readDocument({file:artifact.pdfBytes,fileHash:artifact.pdfHash,signal})]);abort(signal);
 const comparison=compareReconstruction(before,after),diff={};for(const category of ['text','numbers']){diff[category]={};for(const side of ['missing','added'])diff[category][side]=page(comparison[category][side],args);}
 const a=blocks(baselineProject,baselineArtifact),b=blocks(project,artifact),byId=new Map(b.map(x=>[x.id,x]));let preservation;
 if(baselineProject.origin==='reconstructed-pdf'&&project.origin==='reconstructed-pdf'&&baselineProject.files.some(f=>f.path==='falsify-layout-structure.json')&&project.files.some(f=>f.path==='falsify-layout-structure.json')){const changes=a.filter(x=>byId.get(x.id)?.sourceText!==x.sourceText).map(x=>x.id);for(const x of b)if(!a.some(y=>y.id===x.id))changes.push(x.id);preservation={method:'exact-structure-unit-payload',unchanged:changes.length===0,changes:page(changes,args)};}else{const af=baselineProject.files.filter(f=>/\.tex$/i.test(f.path)),bf=new Map(project.files.filter(f=>/\.tex$/i.test(f.path)).map(f=>[f.path,f.sha256]));const changes=af.filter(f=>bf.get(f.path)!==f.sha256).map(f=>f.path);for(const f of project.files.filter(f=>/\.tex$/i.test(f.path)))if(!af.some(x=>x.path===f.path))changes.push(f.path);preservation={method:'exact-source-file-bytes',unchanged:changes.length===0,changes:page(changes,args)};}
 const structured=preservation.method==='exact-structure-unit-payload';const sourceEntries=(p,units)=>structured?units.map(x=>({id:x.id,text:x.sourceText})):p.files.filter(f=>/\.tex$/i.test(f.path)).map(f=>({id:f.path,text:dec.decode(f.bytes)}));const oldSource=sourceEntries(baselineProject,a),newSource=sourceEntries(project,b),newById=new Map(newSource.map(x=>[x.id,x])),oldKeys=new Set(oldSource.map(x=>x.id)),normalizedChanges=[];for(const x of oldSource){const y=newById.get(x.id);if(!y||sourceContent(x.text)!==sourceContent(y.text))normalizedChanges.push(x.id);}for(const y of newSource)if(!oldKeys.has(y.id))normalizedChanges.push(y.id);const sourceNumbers=compareReconstruction({pages:[{text:oldSource.map(x=>sourceContent(x.text)).join(' ')}]},{pages:[{text:newSource.map(x=>sourceContent(x.text)).join(' ')}]}).numbers;
 const assets=p=>p.files.filter(f=>!(/\.(?:tex|json)$/i.test(f.path)));const old=assets(baselineProject),now=assets(project),paths=[...new Set([...old,...now].map(f=>f.path))].sort(),assetChanges=paths.map(path=>{const x=old.find(f=>f.path===path),y=now.find(f=>f.path===path);return {path,status:!x?'added':!y?'missing':x.sha256===y.sha256?'unchanged':'changed'};});
 const [oldLinks,newLinks]=await Promise.all([readSourceLinks({bytes:baselineArtifact.pdfBytes,document:before,signal}),readSourceLinks({bytes:artifact.pdfBytes,document:after,signal})]);abort(signal);const linkKey=l=>JSON.stringify({uri:l.uri,external:l.external,targetPage:l.target?.pageIndex??null});const difference=(x,y)=>{const counts=new Map();for(const v of y){const k=linkKey(v);counts.set(k,(counts.get(k)||0)+1);}return x.filter(v=>{const k=linkKey(v),n=counts.get(k)||0;if(n){counts.set(k,n-1);return false;}return true;}).map(v=>({uri:v.uri,external:v.external,targetPage:v.target?.pageIndex??null}));};
 return {schema:'falsify.layout-document-comparison.v1',baselineProjectId:baselineProject.id,baselineHash:baselineArtifact.pdfHash,projectId:project.id,outputHash:artifact.pdfHash,pages:{baseline:before.pages.length,current:after.pages.length},tokens:{method:comparison.method,...diff},readingOrder:{status:'unverified',extractedTextEqual:before.pages.map(p=>p.text).join('\n')===after.pages.map(p=>p.text).join('\n')},exactPayload:preservation,sourceContent:{method:'normalized-source-syntax-with-generated-layout-commands-removed',comparison:'exact-per-block-normalized-syntax',unchanged:normalizedChanges.length===0,changes:page(normalizedChanges,args),numbers:{missing:page(sourceNumbers.missing,args),added:page(sourceNumbers.added,args)}},assets:{counts:Object.fromEntries(['unchanged','changed','added','missing'].map(status=>[status,assetChanges.filter(x=>x.status===status).length])),...page(assetChanges,args)},links:{method:'uri-and-target-page-multiset',missing:page(difference(oldLinks.links,newLinks.links),args),added:page(difference(newLinks.links,oldLinks.links),args)}};
}

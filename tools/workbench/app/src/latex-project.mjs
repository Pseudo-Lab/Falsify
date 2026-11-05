import {unzipSync, zipSync} from 'fflate';
import {hex} from './paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function fail(code,message,details={}) { throw Object.assign(new Error(message),{code,details}); }
function pathOf(p) { if(typeof p!=='string'||!p||p.includes('\\')||p.startsWith('/')||/^[A-Za-z]:/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..')) fail('INVALID_PATH','Invalid project path'); return p; }
export async function createLatexProject({files,mainFile=null,engine='pdflatex',origin='original-source',sourcePdfHash}={}) {
 if(!Array.isArray(files)||!files.length) fail('EMPTY_PROJECT','Project has no files');
 if(!['pdflatex','xelatex','lualatex'].includes(engine)||!['original-source','reconstructed-pdf'].includes(origin)) fail('INVALID_PROJECT','Invalid project options');
 const seen=new Set(); const result=files.map(f=>{const path=pathOf(f.path); if(seen.has(path)) fail('DUPLICATE_PATH','Duplicate path',{path}); seen.add(path); const bytes=new Uint8Array(f.bytes); if(/\.tex$/i.test(path)) try{dec.decode(bytes)}catch{fail('INVALID_UTF8','Source is not UTF-8',{path})} return {path,bytes,sha256:hex(bytes)};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(mainFile!==null) { pathOf(mainFile); if(!seen.has(mainFile)||!/\.tex$/i.test(mainFile)) fail('MISSING_MAIN','Main file is missing',{path:mainFile}); }
 const id=hex(enc.encode(JSON.stringify({files:result.map(({path,sha256})=>[path,sha256]),mainFile,engine,origin})));
 return {schema:'falsify.latex-project.v1',id,revision:0,origin,mainFile,engine,files:result,...(sourcePdfHash?{sourcePdfHash}:{})};
}
// Resolve references separately from stored paths: project entries must remain
// canonical, while TeX references can contain dot segments.
function resolveReference(dir, ref) {
 if(!ref || ref.includes('\\') || ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) return null;
 const parts=dir ? dir.split('/') : [];
 for(const part of ref.split('/')) {
  if(!part || part==='.') continue;
  if(part==='..') { if(!parts.length) return null; parts.pop(); }
  else parts.push(part);
 }
 return parts.length ? parts.join('/') : null;
}
const parentDir=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
function graphicsCommandDepth(text,command) {
 let depth=0;
 for(let i=0;i<command.index;i++) { if(text[i]==='\\') { i++; continue; } if(text[i]==='{')depth++; else if(text[i]==='}')depth--; if(depth<0)break; }
 return depth;
}
function graphicsPaths(text, dir) {
 const commands=[...text.matchAll(/\\graphicspath\b/g)];
 if(!commands.length) return {dirs:[],unknown:false,declared:false};
 // Only one literal preamble declaration is unambiguous without interpreting
 // TeX macros, conditionals, grouping, or runtime assignment order.
 const begin=text.search(/\\begin\s*\{document\}/);
 const command=commands[0], firstUse=text.search(/\\(?:input|include|includegraphics)\b/);
 const depth=graphicsCommandDepth(text,command);
 if(depth!==0 || commands.length!==1 || (firstUse>=0 && command.index>firstUse) || (begin>=0 && command.index>begin) || /\\(?:if\w*|newcommand|def|renewcommand)\b/.test(text.slice(0,command.index))) return {dirs:[],unknown:true,declared:true};
 const tail=text.slice(command.index), match=tail.match(/^\\graphicspath\s*\{((?:\s*\{[^{}\\]*\}\s*)+)\}/);
 if(!match) return {dirs:[],unknown:true,declared:true};
 const dirs=[];
 for(const m of match[1].matchAll(/\{([^{}]*)\}/g)) {
  const raw=m[1].trim();
  // Empty and dot-only paths mean the compiler working directory.
  const resolved=!raw || /^(?:\.\/)*\.?\/?$/.test(raw) ? dir : resolveReference(dir,raw);
  if(resolved===null) return {dirs:[],unknown:true,declared:true};
  dirs.push(resolved);
 }
 return {dirs,unknown:false,declared:true};
}
export function analyzeProjectFiles(project) {
 const paths=new Set(project.files.map(f=>f.path)), mainCandidates=[],missingFiles=[],diagnostics=[],texts=new Map();
 function inspectSource(f) {
  let text;try{text=dec.decode(f.bytes)}catch{diagnostics.push({code:'INVALID_UTF8',message:'Source is not UTF-8',path:f.path});return}
  text=text.replace(/(^|[^\\])%.*/gm,'$1');texts.set(f.path,text);
  if(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(text)&&/\\begin\s*\{document\}/.test(text))mainCandidates.push(f.path);
 }
 for(const f of project.files.filter(f=>/\.tex$/i.test(f.path))) inspectSource(f);
 const roots=project.mainFile ? [project.mainFile,...mainCandidates.filter(x=>x!==project.mainFile)] : mainCandidates;
 const observations=new Map(), visited=new Set();let budget=0;
 const note=(main,path,index,ref,command,status)=>{
  const key=path+'\0'+index+'\0'+ref;
  if(!observations.has(key))observations.set(key,{path,reference:ref,command,results:[]});
  observations.get(key).results.push({main,status});
 };
 const extensions=command=>command==='includegraphics'?['','.pdf','.png','.jpg','.jpeg']:command==='bibliography'||command==='addbibresource'?['','.bib']:['','.tex'];
 const resolve=(root,ref,exts)=>{
  const p=resolveReference(root,ref);
  if(p===null)return null;
  return exts.map(ext=>p+ext).find(path=>paths.has(path)) ?? null;
 };
 const walk=(main,root,path,state,stack)=>{
  if(++budget>10000 || stack.has(path))return {dirs:[],unknown:true};
  const text=texts.get(path);if(text===undefined)return state;
  visited.add(path);const next=new Set(stack);next.add(path);
  const declaration=graphicsPaths(text,root);
  if(declaration.declared)state=declaration;
  const conditional=/\\(?:if\w*|else|fi)\b/.test(text);
  if(conditional || /\\(?:input|include)\b(?!\s*\{)/.test(text))state={dirs:[],unknown:true};
  const re=/\\(input|include|bibliography|addbibresource|includegraphics)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
  function referenceStatus(valid,direct,m,r) {
   let status=direct?'found':'missing';
   if(valid&&!direct&&m[1]==='includegraphics') {
    if(state.unknown)status='unknown';
    else if(state.dirs.some(dir=>resolve(dir,r,extensions(m[1]))))status='found';
   }
   if(conditional && valid)status='unknown';
   return status;
  }
  function inspectReference(m,part) {
   const r=part.trim();if(!r)return;
   if(r.includes('\\')||/#[1-9]/.test(r)) {note(main,path,m.index,r,m[1],'unknown');if(m[1]==='input'||m[1]==='include')state={dirs:[],unknown:true};return;}
   const valid=resolveReference(root,r)!==null, direct=valid?resolve(root,r,extensions(m[1])):null;
   const status=referenceStatus(valid,direct,m,r);
   note(main,path,m.index,r,m[1],status);
   if(direct && !conditional && (m[1]==='input'||m[1]==='include') && texts.has(direct)) state=walk(main,root,direct,state,next);
   else if((m[1]==='input'||m[1]==='include') && status==='unknown') state={dirs:[],unknown:true};
  }
  for(const m of text.matchAll(re)) for(const part of (m[1]==='bibliography'?m[2].split(','):[m[2]])) inspectReference(m,part);
  return state;
 };
 for(const main of roots) if(texts.has(main))walk(main,parentDir(main),main,{dirs:[],unknown:false},new Set());
 // Detached source files have no proven execution root; inspect against their
 // own directory, retaining the existing diagnostics for standalone sources.
 for(const path of texts.keys()) if(!visited.has(path))walk(null,parentDir(path),path,{dirs:[],unknown:false},new Set());
 function inspectObservation({path,reference,command,results}) {
  const selected=project.mainFile && results.some(x=>x.main===project.mainFile) ? results.filter(x=>x.main===project.mainFile) : results;
  const states=new Set(selected.map(x=>x.status));
  if(states.size===1 && states.has('found'))return;
  const detail={path,reference,command};
  if(states.has('unknown')||states.has('found')) diagnostics.push({code:'UNRESOLVED_REFERENCE',message:'Referenced file could not be determined',...detail});
  else missingFiles.push(detail);
 }
 for(const observation of observations.values()) inspectObservation(observation);
 if(!project.mainFile&&mainCandidates.length!==1)diagnostics.push({code:mainCandidates.length?'AMBIGUOUS_MAIN':'MISSING_MAIN',message:mainCandidates.length?'Multiple main files found':'No main file found'});
 for(const m of missingFiles)diagnostics.push({code:'MISSING_FILE',message:'Referenced file is missing',...m}); return {mainCandidates,missingFiles,diagnostics};
}
export async function importLatexProject(file,{mainFile,engine,signal}={}) { if(signal?.aborted) fail('ABORTED','Import cancelled'); const bytes=new Uint8Array(await file.arrayBuffer()); if(signal?.aborted) fail('ABORTED','Import cancelled'); let files; if(/\.tex$/i.test(file.name)) {const name=pathOf(file.name);files=[{path:name,bytes}];mainFile??=name;} else if(/\.zip$/i.test(file.name)) {let entries;try{let count=0,total=0;const names=new Set();unzipSync(bytes,{filter:f=>{if(++count>20000||names.has(f.name))fail('INVALID_ZIP','Duplicate or excessive ZIP entries');names.add(f.name);total+=f.originalSize;if(total>128*1024*1024||f.originalSize>Math.max(f.size*200,1000000))fail('INVALID_ZIP','ZIP size limit exceeded');return false;}});entries=unzipSync(bytes);}catch(e){if(e.code)throw e;fail('INVALID_ZIP','Invalid ZIP archive')} files=Object.entries(entries).filter(([p])=>!p.endsWith('/')).map(([path,bytes])=>({path,bytes}));} else fail('INVALID_FORMAT','Expected a .tex or .zip file');
 let p=await createLatexProject({files,mainFile:mainFile??null,engine}); if(!p.mainFile){const a=analyzeProjectFiles(p);if(a.mainCandidates.length===1)p=await createLatexProject({files,mainFile:a.mainCandidates[0],engine});}
 if(engine===undefined&&p.mainFile){const source=dec.decode(p.files.find(f=>f.path===p.mainFile).bytes),hint=/^\s*%\s*!TeX\s+program\s*=\s*(pdflatex|xelatex|lualatex)\s*$/im.exec(source.split('\n').slice(0,20).join('\n'));if(hint)p=await createLatexProject({...p,engine:hint[1].toLowerCase()});}
 return p;
}
export async function exportLatexProject(project) { const entries=Object.create(null); for(const f of project.files)entries[pathOf(f.path)]=new Uint8Array(f.bytes);return zipSync(entries); }

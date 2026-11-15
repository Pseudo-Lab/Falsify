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
export function readBalanced(text, start, open='{', close='}') {
 if(text[start]!==open) return null;
 let depth=0;
 for(let i=start;i<text.length;i++) {
  if(text[i]==='\\') { i++; continue; }
  if(text[i]===open) depth++;
  else if(text[i]===close && --depth===0) return {content:text.slice(start+1,i),end:i+1};
 }
 return null;
}
function skipSpaces(text, i) { while(i<text.length && /\s/.test(text[i])) i++; return i; }
function readMacroName(text, i) {
 i=skipSpaces(text,i);
 if(text[i]==='{') { const g=readBalanced(text,i); return g?{name:g.content.trim(),end:g.end}:null; }
 const m=/^(\\[A-Za-z@]+)/.exec(text.slice(i));
 return m?{name:m[1],end:i+m[0].length}:null;
}
function readNewCommandMacro(text, cmdStart, kind, path) {
 let i=skipSpaces(text,cmdStart);
 if(text[i]==='*') i=skipSpaces(text,i+1);
 const target=readMacroName(text,i);
 if(!target || !/^\\[A-Za-z@]+$/.test(target.name)) return null;
 i=skipSpaces(text,target.end);
 let arity=0, hasOptionalDefault=false;
 if(text[i]==='[') { const opt=readBalanced(text,i,'[',']'); if(!opt) return null; const n=Number(opt.content.trim()); if(Number.isInteger(n)&&n>=0&&n<=9) arity=n; i=skipSpaces(text,opt.end); }
 if(text[i]==='[') { const def=readBalanced(text,i,'[',']'); if(!def) return null; hasOptionalDefault=true; i=skipSpaces(text,def.end); }
 const body=readBalanced(text,i);
 return body?{macro:{name:target.name,arity,hasOptionalDefault,body:body.content,kind,path},end:body.end}:null;
}
function readDefMacro(text, cmdStart, path) {
 const m=/^\\([A-Za-z@]+)/.exec(text.slice(skipSpaces(text,cmdStart)));
 if(!m) return null;
 const name='\\'+m[1], paramStart=skipSpaces(text,cmdStart)+m[0].length, brace=text.indexOf('{',paramStart);
 if(brace<0 || /[\r\n]/.test(text.slice(paramStart,brace))) return null;
 const params=text.slice(paramStart,brace), body=readBalanced(text,brace);
 if(!body) return null;
 const nums=[...params.matchAll(/#([1-9])/g)].map(x=>Number(x[1]));
 return {macro:{name,arity:nums.length?Math.max(...nums):0,hasOptionalDefault:false,body:body.content,kind:'def',path},end:body.end};
}
function readPairedDelimiterMacro(text, cmdStart, path) {
 let i=skipSpaces(text,cmdStart);
 if(text[i]==='*') i=skipSpaces(text,i+1);
 const target=readMacroName(text,i);
 if(!target || !/^\\[A-Za-z@]+$/.test(target.name)) return null;
 const left=readBalanced(text,skipSpaces(text,target.end)); if(!left) return null;
 const right=readBalanced(text,skipSpaces(text,left.end)); if(!right) return null;
 return {macro:{name:target.name,arity:1,hasOptionalDefault:false,body:`${left.content}#1${right.content}`,kind:'DeclarePairedDelimiter',path},end:right.end};
}
export function extractMacroDefinitions(text, path='') {
 const macros=[], clean=text.replace(/(^|[^\\])%.*/gm,'$1');
 const re=/\\(newcommand|renewcommand|providecommand|DeclarePairedDelimiter|def)\b/g;
 for(const m of clean.matchAll(re)) {
  const after=m.index+m[0].length;
  const parsed=m[1]==='def'?readDefMacro(clean,after,path):m[1]==='DeclarePairedDelimiter'?readPairedDelimiterMacro(clean,after,path):readNewCommandMacro(clean,after,m[1],path);
  if(parsed) macros.push(parsed.macro);
 }
 return macros;
}
function detectCitationPackage(texts) {
 const pkgs=new Set();
 for(const text of texts) {
  for(const m of text.matchAll(/\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
   for(const p of m[1].split(',')) if(p.trim()) pkgs.add(p.trim());
  }
 }
 if(pkgs.has('biblatex')) return 'biblatex';
 if(pkgs.has('natbib')) return 'natbib';
 if(pkgs.has('cite')) return 'cite';
 const joined=texts.join('\n');
 if(/\\(?:addbibresource|autocite|parencite|textcite|footcite)\b/.test(joined)) return 'biblatex';
 if(/\\(?:citep|citet|citealp|citealt|citeauthor|citeyear)\b/.test(joined)) return 'natbib';
 return 'standard';
}
function decodeProjectSources(files, diagnostics) {
 const texts=new Map(), styleTexts=new Map(), mainCandidates=[];
 for(const f of files) {
  if(/\.tex$/i.test(f.path)) {
   let text;try{text=dec.decode(f.bytes)}catch{diagnostics.push({code:'INVALID_UTF8',message:'Source is not UTF-8',path:f.path});continue;}
   text=text.replace(/(^|[^\\])%.*/gm,'$1');texts.set(f.path,text);
   if(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(text)&&/\\begin\s*\{document\}/.test(text))mainCandidates.push(f.path);
  } else if(/\.(?:sty|cls)$/i.test(f.path)) {
   try { styleTexts.set(f.path,dec.decode(f.bytes).replace(/(^|[^\\])%.*/gm,'$1')); } catch {}
  }
 }
 return {texts, styleTexts, mainCandidates};
}
function refExtensions(command) {
 if(command==='includegraphics') return ['','.pdf','.png','.jpg','.jpeg'];
 return command==='bibliography'||command==='addbibresource'?['','.bib']:['','.tex'];
}
function resolvePathWithExts(paths, root, ref, exts) {
 const p=resolveReference(root,ref);
 return p===null?null:(exts.map(ext=>p+ext).find(path=>paths.has(path)) ?? null);
}
function resolveBblFallbackPath(paths, main, path, root, r) {
 const fromRef=resolvePathWithExts(paths,root,r.replace(/\.bib$/i,''),['.bbl']);
 if(fromRef) return fromRef;
 const owner=(main||path).replace(/\.tex$/i,'.bbl');
 return owner!==(main||path)&&paths.has(owner)?owner:null;
}
function collectLocalStyleDeps(paths, root, text, localClasses, localPackages) {
 for(const m of text.matchAll(/\\(documentclass|LoadClass|usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
  const isCls=m[1]==='documentclass'||m[1]==='LoadClass', ext=isCls?'.cls':'.sty';
  for(const part of m[2].split(',')) {
   const r=part.trim();if(!r||r.includes('\\')||/#[1-9]/.test(r))continue;
   const hit=resolvePathWithExts(paths,root,r,[ext]);
   if(hit)(isCls?localClasses:localPackages).add(hit);
  }
 }
}
function summarizeObservations(observations, mainFile, diagnostics, missingFiles) {
 for(const {path,reference,command,results} of observations.values()) {
  const selected=mainFile && results.some(x=>x.main===mainFile) ? results.filter(x=>x.main===mainFile) : results;
  const states=new Set(selected.map(x=>x.status));
  if(states.size===1 && states.has('found'))continue;
  const detail={path,reference,command};
  if(states.has('unknown')||states.has('found')) diagnostics.push({code:'UNRESOLVED_REFERENCE',message:'Referenced file could not be determined',...detail});
  else missingFiles.push(detail);
 }
}
function finalizeMainAndMissingDiagnostics(mainFile, mainCandidates, missingFiles, diagnostics) {
 if(!mainFile&&mainCandidates.length!==1) {
  const hasMain=mainCandidates.length>0;
  diagnostics.push({code:hasMain?'AMBIGUOUS_MAIN':'MISSING_MAIN',message:hasMain?'Multiple main files found':'No main file found'});
 }
 for(const m of missingFiles) diagnostics.push({code:'MISSING_FILE',message:'Referenced file is missing',...m});
}
function buildProjectAnalysisSummary(texts, styleTexts, localClasses, localPackages, bblFiles) {
 const styleEntries=[...localClasses,...localPackages].map(p=>[p,styleTexts.get(p)]).filter(([,t])=>t!==undefined);
 const activeSources=[...texts.entries(),...styleEntries];
 const citationPackage=detectCitationPackage(activeSources.map(([,t])=>t));
 const customMacros=activeSources.flatMap(([p,t])=>extractMacroDefinitions(t,p));
 return {bblFallback:bblFiles.size>0,bblFiles:[...bblFiles].sort(),citationPackage,localPackages:[...localPackages].sort(),localClasses:[...localClasses].sort(),customMacros};
}
export function analyzeProjectFiles(project) {
 const paths=new Set(project.files.map(f=>f.path)), missingFiles=[], diagnostics=[];
 const bblFiles=new Set(), localPackages=new Set(), localClasses=new Set();
 const {texts, styleTexts, mainCandidates}=decodeProjectSources(project.files, diagnostics);
 const roots=project.mainFile ? [project.mainFile,...mainCandidates.filter(x=>x!==project.mainFile)] : mainCandidates;
 const observations=new Map(), visited=new Set();let budget=0;
 const note=(main,path,index,ref,command,status)=>{
  const key=path+'\0'+index+'\0'+ref;
  if(!observations.has(key))observations.set(key,{path,reference:ref,command,results:[]});
  observations.get(key).results.push({main,status});
 };
 const walk=(main,root,path,state,stack)=>{
  if(++budget>10000 || stack.has(path))return {dirs:[],unknown:true};
  const text=texts.get(path);if(text===undefined)return state;
  visited.add(path);const next=new Set(stack);next.add(path);
  collectLocalStyleDeps(paths,root,text,localClasses,localPackages);
  const declaration=graphicsPaths(text,root);
  if(declaration.declared)state=declaration;
  const conditional=/\\(?:if\w*|else|fi)\b/.test(text);
  if(conditional || /\\(?:input|include)\b(?!\s*\{)/.test(text))state={dirs:[],unknown:true};
  const re=/\\(input|include|bibliography|addbibresource|includegraphics)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g;
  function referenceStatus(valid,direct,cmd,r) {
   let status=direct?'found':'missing';
   if(valid&&!direct&&cmd==='includegraphics') {
    if(state.unknown)status='unknown';
    else if(state.dirs.some(dir=>resolvePathWithExts(paths,dir,r,refExtensions(cmd))))status='found';
   } else if(valid&&!direct&&(cmd==='bibliography'||cmd==='addbibresource')) {
    const bbl=resolveBblFallbackPath(paths,main,path,root,r);
    if(bbl){status='found';bblFiles.add(bbl);}
   }
   return conditional && valid ? 'unknown' : status;
  }
  function inspectReference(m,part) {
   const r=part.trim();if(!r)return;
   const cmd=m[1], isTexInclude=cmd==='input'||cmd==='include';
   if(r.includes('\\')||/#[1-9]/.test(r)) {note(main,path,m.index,r,cmd,'unknown');if(isTexInclude)state={dirs:[],unknown:true};return;}
   const valid=resolveReference(root,r)!==null, direct=valid?resolvePathWithExts(paths,root,r,refExtensions(cmd)):null;
   const status=referenceStatus(valid,direct,cmd,r);
   note(main,path,m.index,r,cmd,status);
   if(direct && !conditional && isTexInclude && texts.has(direct)) state=walk(main,root,direct,state,next);
   else if(isTexInclude && status==='unknown') state={dirs:[],unknown:true};
  }
  for(const m of text.matchAll(re)) for(const part of (m[1]==='bibliography'?m[2].split(','):[m[2]])) inspectReference(m,part);
  return state;
 };
 for(const main of roots) walk(main,parentDir(main),main,{dirs:[],unknown:false},new Set());
 for(const path of texts.keys()) if(!visited.has(path))walk(null,parentDir(path),path,{dirs:[],unknown:false},new Set());
 for(const stylePath of [...localClasses,...localPackages]) collectLocalStyleDeps(paths,parentDir(stylePath),styleTexts.get(stylePath)||'',localClasses,localPackages);
 summarizeObservations(observations, project.mainFile, diagnostics, missingFiles);
 finalizeMainAndMissingDiagnostics(project.mainFile, mainCandidates, missingFiles, diagnostics);
 const projectAnalysis=buildProjectAnalysisSummary(texts, styleTexts, localClasses, localPackages, bblFiles);
 return {mainCandidates,missingFiles,diagnostics,...projectAnalysis,projectAnalysis};
}
export async function importLatexProject(file,{mainFile,engine,signal}={}) { if(signal?.aborted) fail('ABORTED','Import cancelled'); const bytes=new Uint8Array(await file.arrayBuffer()); if(signal?.aborted) fail('ABORTED','Import cancelled'); let files; if(/\.tex$/i.test(file.name)) {const name=pathOf(file.name);files=[{path:name,bytes}];mainFile??=name;} else if(/\.zip$/i.test(file.name)) {let entries;try{let count=0,total=0;const names=new Set();unzipSync(bytes,{filter:f=>{if(++count>20000||names.has(f.name))fail('INVALID_ZIP','Duplicate or excessive ZIP entries');names.add(f.name);total+=f.originalSize;if(total>128*1024*1024||f.originalSize>Math.max(f.size*200,1000000))fail('INVALID_ZIP','ZIP size limit exceeded');return false;}});entries=unzipSync(bytes);}catch(e){if(e.code)throw e;fail('INVALID_ZIP','Invalid ZIP archive')} files=Object.entries(entries).filter(([p])=>!p.endsWith('/')).map(([path,bytes])=>({path,bytes}));} else fail('INVALID_FORMAT','Expected a .tex or .zip file');
 let p=await createLatexProject({files,mainFile:mainFile??null,engine}); if(!p.mainFile){const a=analyzeProjectFiles(p);if(a.mainCandidates.length===1)p=await createLatexProject({files,mainFile:a.mainCandidates[0],engine});}
 if(engine===undefined&&p.mainFile){const source=dec.decode(p.files.find(f=>f.path===p.mainFile).bytes),hint=/^\s*%\s*!TeX\s+program\s*=\s*(pdflatex|xelatex|lualatex)\s*$/im.exec(source.split('\n').slice(0,20).join('\n'));if(hint)p=await createLatexProject({...p,engine:hint[1].toLowerCase()});}
 return p;
}
export async function exportLatexProject(project) { const entries=Object.create(null); for(const f of project.files)entries[pathOf(f.path)]=new Uint8Array(f.bytes);return zipSync(entries); }

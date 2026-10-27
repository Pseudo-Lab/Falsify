import {readFile, mkdir, writeFile, realpath, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {File} from 'node:buffer';

const ownRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=async file=>file?.bytes instanceof Uint8Array ? Uint8Array.from(file.bytes) : new Uint8Array(await file.arrayBuffer());
const fail=message=>{throw new Error(message)};
function options(argv) {
 const values={};
 for(let i=0;i<argv.length;i+=2) {
  const k=argv[i]; if(!['--matrix','--case','--output-dir','--layout-mode','--source-tree','--runtime'].includes(k)||!argv[i+1]||values[k]) fail('Invalid or duplicate argument: '+k);
  values[k]=argv[i+1];
 }
 for(const k of ['--matrix','--case','--output-dir']) if(!values[k]) fail('Required: '+k);
 if(values['--layout-mode'] && values['--layout-mode']!=='measured-continuous') fail('Invalid layout mode');
 if(values['--runtime'] && !['source','bundled'].includes(values['--runtime'])) fail('Invalid runtime');
 return values;
}
async function main() {
 const args=options(process.argv.slice(2)), matrixPath=resolve(args['--matrix']), output=resolve(args['--output-dir']);
 const root=await realpath(resolve(args['--source-tree']||ownRoot));
 const gitRoot=await realpath(root), parent=await realpath(dirname(output));
 const reportedRoot=await realpath(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim());
 if(reportedRoot!==gitRoot) fail('Source tree must be the repository root');
 try {await readFile(join(root,'ARCHIVED.json'));fail('Restore the archived source tree first');}catch(error){if(error.code!=='ENOENT')throw error;}
 const fingerprint=async()=>{
  const records=[];
  const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())fail('Source symlinks are not supported');if(entry.isDirectory())await walk(path);else if(/\.(mjs|cjs|js|json)$/u.test(entry.name))records.push([relative(root,path).replaceAll('\\','/'),digest(await readFile(path))]);}};
  await walk(join(root,'app/src'));
  for(const path of ['app/dist/blind-pdf.mjs','app/dist/recomposition-typst.mjs','app/dist/recomposition-vendor/manifest.json','app/package-lock.json'])records.push([path,digest(await readFile(join(root,path)))]);
  records.sort((a,b)=>a[0].localeCompare(b[0]));return digest(Buffer.from(JSON.stringify(records)));
 };
 const sourceFingerprint=await fingerprint();
 const rel=relative(gitRoot,parent); if(!rel || (!rel.startsWith('..')&&!isAbsolute(rel))) fail('Output must be outside the repository');
 const matrixBytes=await readFile(matrixPath), matrix=JSON.parse(matrixBytes), matches=matrix.cases.filter(c=>c.id===args['--case']);
 if(matches.length!==1) fail('Case must match exactly once');
 const item=structuredClone(matches[0]), source=resolve(dirname(matrixPath),item.source), original=await readFile(source);
 if(!/^[a-f0-9]{64}$/.test(item.fileHash)||digest(original)!==item.fileHash) fail('Matrix source hash mismatch');
 // Reserve a new directory atomically before running; existing evidence is never overwritten.
 await mkdir(output);
 globalThis.File ||= File;
 const runtime=args['--runtime']||'source';
 const {build}=await import(pathToFileURL(join(root,'app/node_modules/esbuild/lib/main.js')));
 const enginePath=join(output,'proof-engine.mjs');
 const entry=`export {runRequest,loadAssets} from './paper-recompose-worker.mjs';
export {readDocument} from './paper-document.mjs';
export {recoverSourceSpaces} from './paper-source-spacing.mjs';
export {readSourceAssets} from './paper-source-assets.mjs';
export {readSourceLinks} from './paper-source-links.mjs';
export {buildPaperFlow} from './paper-flow.mjs';`;
 // Match the application's build aliases: the proof and footer cleaner must
 // share one MuPDF module, rather than mixing npm and vendored WASM instances.
 const built=await build({stdin:{contents:entry,resolveDir:join(root,'app/src'),loader:'js'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',legalComments:'eof',plugins:[{name:'application-vendors',setup(b){
  b.onResolve({filter:/^mupdf$/},()=>({path:pathToFileURL(join(root,'app/dist/browser-pdf-vendor/mupdf.js')).href,external:true}));
  b.onResolve({filter:/^\.\.\/dist\/blind-pdf\.mjs$/},()=>({path:pathToFileURL(join(root,'app/dist/blind-pdf.mjs')).href,external:true}));
 }}]});
 await writeFile(enginePath,built.outputFiles[0].contents,{flag:'wx'});
 const readers=await import(pathToFileURL(enginePath));
 const runtimePath=runtime==='bundled'?join(root,'app/dist/paper-recompose-worker-core.mjs'):enginePath;
 const runtimeSha256=digest(await readFile(runtimePath));
 const {runRequest,loadAssets}=await import(pathToFileURL(runtimePath));
 const {createTypstCompile}=await import(pathToFileURL(join(root,'app/src/paper-typst.mjs')));
 const clean=(await import(pathToFileURL(join(root,'app/dist/blind-pdf.mjs')))).prepare;
 const manifestPath=join(root,'app/dist/recomposition-vendor/manifest.json');
 const assets=await loadAssets(pathToFileURL(manifestPath).href,async url=>{
  try { const data=await readFile(fileURLToPath(url)); return {ok:true,json:async()=>JSON.parse(data),arrayBuffer:async()=>Uint8Array.from(data).buffer}; }
  catch {return {ok:false};}
 });
 const facade=await import(pathToFileURL(join(root,'app/dist/recomposition-typst.mjs')));
 const wasm=process.env.FALSIFY_TYPST_WASM ? await readFile(process.env.FALSIFY_TYPST_WASM) : assets.wasm;
 if(digest(wasm)!==digest(assets.wasm)) fail('Compiler WASM differs from pinned manifest');
 const compile=createTypstCompile({...facade,getModule:()=>wasm});
 const pdfjsModule=await import(pathToFileURL(join(root,'app/node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
 pdfjsModule.GlobalWorkerOptions.workerSrc=pathToFileURL(join(root,'app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
 const pdfjs={...pdfjsModule,GlobalWorkerOptions:null};
 let prepared;
 const result=await runRequest({file:original,fileHash:item.fileHash,revision:item.id,bindings:item.bindings||[],layoutMode:args['--layout-mode'],edits:{schema:'falsify.paper-edits.v1',fileHash:item.fileHash,revision:item.id,edits:item.edits}},{assets,facade:{},compile,pdfjs,clean:async request=>{const out=await clean(request); prepared=await bytes(out.file); return out;}});
 if(!prepared || digest(prepared)!==result.sourceBinding.preparedSha256) fail('Captured prepared source hash mismatch');
 if(digest(await readFile(source))!==item.fileHash) fail('Original source changed during run');
 const {file,...metadata}=result, pdf=await bytes(file);
 if(digest(pdf)!==result.sha256) fail('Output hash mismatch');
 const {readDocument,recoverSourceSpaces,readSourceAssets,readSourceLinks,buildPaperFlow}=readers;
 const observed=await readDocument({file:prepared,fileHash:digest(prepared)});
 const {document}=await recoverSourceSpaces({bytes:prepared,document:observed,pdfjs});
 const inventory=await readSourceAssets({bytes:prepared,document}),links=await readSourceLinks({bytes:prepared,document});
 const flow=buildPaperFlow(document,{drawings:inventory.drawings,links});
 for(const item of flow.items.filter(i=>i.kind==='asset'&&!i.renderAssetId)){
  const page=document.pages[item.source.pageIndex],b=item.source.bbox;
  if(!page||!Array.isArray(b)||b.length!==4)continue;
  const clipped=[Math.max(0,b[0]),Math.max(0,b[1]),Math.min(page.width,b[2]),Math.min(page.height,b[3])];
  if(!(clipped[0]<clipped[2]&&clipped[1]<clipped[3]))continue;
  item.source.bbox=clipped;item.renderAssetId=`capture-${item.id}`;
 }
 const sourceFlow={preparedSha256:digest(prepared),method:'Deterministic replay of prepared-source parsing and prepare capture-ID assignment; output geometry is independently observed.',flow};
 if(await fingerprint()!==sourceFingerprint) fail('Source code changed during the proof run');
 const manifest={schema:'falsify.recompose-proof.v1',caseId:item.id,layoutMode:args['--layout-mode']||'existing',sourceTree:root,sourceFingerprint,sourceTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),codeVersion:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),toolSha256:digest(await readFile(fileURLToPath(import.meta.url))),matrixSha256:digest(matrixBytes),originalSha256:item.fileHash,preparedSha256:digest(prepared),outputSha256:digest(pdf),wasmSha256:digest(wasm),node:process.version,files:['prepared.pdf','output.pdf','metadata.json','plan.json']};
 Object.assign(manifest,{runtime,runtimeSha256,pdfjsVersion:pdfjsModule.version,readerDistribution:'legacy-node'});
 manifest.files.push('source-flow.json','proof-engine.mjs');
 for(const [name,data] of [['prepared.pdf',prepared],['output.pdf',pdf],['metadata.json',JSON.stringify(metadata,null,2)],['source-flow.json',JSON.stringify(sourceFlow,null,2)],['plan.json',JSON.stringify(item,null,2)],['manifest.json',JSON.stringify(manifest,null,2)]]) await writeFile(join(output,name),data,{flag:'wx'});
 console.log(JSON.stringify(manifest));
}
main().catch(e=>{console.error(`${e.name||'Error'}: ${e.message||String(e)}`);if(e.stack)console.error(e.stack);process.exitCode=1});



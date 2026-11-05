import * as mupdf from 'mupdf';
import {createFontPlan} from './paper-fonts.mjs';
import {analyzeLatexSource} from './latex-source-model.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {readLayoutStructure,readLayoutUnitPayloads,replaceLayoutUnitPayloads,applyLayoutStructure} from './paper-layout-structure.mjs';
import {createLatexProject} from './latex-project.mjs';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const fail=(code,message)=>{throw Object.assign(new Error(message||code),{code});};
const num=(v,min,max,name)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('INVALID_VALUE',`Invalid ${name}`);return String(Number(v.toFixed(4)));};
const choice=(v,values,name)=>{if(!values.includes(v))fail('INVALID_VALUE',`Invalid ${name}`);};
const decode=f=>dec.decode(f.bytes);
function validateProject(project){if(project?.schema!=='falsify.latex-project.v1'||!Array.isArray(project.files)||!project.mainFile)fail('INVALID_PROJECT');const names=new Set();for(const f of project.files){if(!f?.path||names.has(f.path)||!(f.bytes instanceof Uint8Array)||hex(f.bytes)!==f.sha256)fail('STALE_PROJECT');names.add(f.path);}const files=project.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);if(hex(enc.encode(JSON.stringify({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin})))!==project.id)fail('STALE_PROJECT');}
async function replaceFile(project,path,source){return createLatexProject({...project,files:project.files.map(f=>({path:f.path,bytes:f.path===path?enc.encode(source):f.bytes}))});}
async function originalBlock({project,args,signal}){
 if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
 const node=analyzeLatexSource(project).nodes.find(n=>n.id===args.blockId);
 if(!node||node.kind!=='text')fail('INVALID_UNIT','Choose a text node from the current project');
 if(['columnSpan','placement','orderBefore','orderAfter'].some(k=>k in args))fail('UNSUPPORTED_BLOCK','Choose a reconstructed layout unit');
 const source=decode(project.files.find(f=>f.path===node.path)),payload=source.slice(node.start,node.end);
 let pre=args.pageBreakBefore?'\\clearpage\n':'',post='';
 if(args.gapBeforeBp)pre+=`\\vspace*{${args.gapBeforeBp}bp}\n`;
 pre+='\\begingroup\n';
 if(args.indentBp!==undefined)pre+=`\\setlength{\\parindent}{${args.indentBp}bp}\n`;
 if(args.widthBp!==undefined){pre+=`\\begin{minipage}{${args.widthBp}bp}\n`;post+='\\end{minipage}\n';}
 if(args.align)pre+=({left:'\\raggedright',center:'\\centering',right:'\\raggedleft',justify:'\\normalfont'}[args.align])+'\n';
 if(args.fontSizeBp!==undefined){const size=args.fontSizeBp,lead=args.leadingBp??size*1.2;pre+=`\\fontsize{${size}bp}{${lead}bp}\\selectfont\n`;}
 else if(args.leadingBp!==undefined)pre+=`\\setlength{\\baselineskip}{${args.leadingBp}bp}\n`;
 post='\\par\n'+post+'\\endgroup\n'+(args.gapAfterBp?`\\vspace*{${args.gapAfterBp}bp}\n`:'')+(args.keepWithNext?'\\nopagebreak[4]\n':'');
 const next=await replaceFile(project,node.path,source.slice(0,node.start)+pre+payload+post+source.slice(node.end));
 return {project:next,summary:{blockId:node.id,updated:Object.keys(args).filter(k=>k!=='blockId'),nodeIdsChangeWithProject:true}};
}

function validateBlockOptions(args){
 const allowed=['blockId','fontSizeBp','leadingBp','gapBeforeBp','gapAfterBp','indentBp','widthBp','columnSpan','pageBreakBefore','keepWithNext','placement','align','orderBefore','orderAfter'];
 if(Object.keys(args).some(k=>!allowed.includes(k)))fail('INVALID_VALUE','Unknown block option');
 for(const k of ['pageBreakBefore','keepWithNext'])if(k in args&&typeof args[k]!=='boolean')fail('INVALID_VALUE',`Invalid ${k}`);
 for(const [k,min,max] of [['fontSizeBp',4,72],['leadingBp',4,150],['gapBeforeBp',0,500],['gapAfterBp',0,500],['indentBp',0,500],['widthBp',1,2000]])if(k in args)num(args[k],min,max,k);
 if('align'in args)choice(args.align,['left','center','right','justify'],'align');
 if('placement'in args)choice(args.placement,['flow','header','footer'],'placement');
 if('columnSpan'in args)choice(args.columnSpan,[1,2],'columnSpan');
 if(args.orderBefore&&args.orderAfter)fail('INVALID_VALUE','Choose one order target');
}
function updatePlacement(args,id,group,plan,payloads,replacements){
 if('placement'in args){if(group||plan.frontMatter.includes(id))fail('INVALID_VALUE','Choose an ungrouped body block');plan.furniture=plan.furniture.filter(f=>f.id!==id);if(args.placement==='header')plan.furniture.push({id,placement:args.placement});const original=payloads[id];const old=/^% FALSIFY-FLOW-FOOTER-BEGIN\n\\insert\\footins\{\n([\s\S]*?)% FALSIFY-FLOW-FOOTER-END\n\}\n$/.exec(original);const body=old?old[1]:original;if(args.placement==='footer')replacements[id]=`% FALSIFY-FLOW-FOOTER-BEGIN\n\\insert\\footins{\n${body}% FALSIFY-FLOW-FOOTER-END\n}\n`;else if(old)replacements[id]=body;}
}
function updateSpan(args,group,payloads,replacements){
 if('columnSpan'in args){if(!group)fail('UNSUPPORTED_SPAN','Choose a grouped figure or table');const [first,last]=group;let a=payloads[first],b=payloads[last];const m=/\\begin\{(figure|table)(\*?)\}/.exec(a);if(!m||!b.includes(`\\end{${m[1]}${m[2]}}`))fail('UNSUPPORTED_SPAN','Float framing unavailable');const env=m[1]+(args.columnSpan===2?'*':'');replacements[first]=a.replace(m[0],`\\begin{${env}}`);replacements[last]=(replacements[last]??b).replace(`\\end{${m[1]}${m[2]}}`,`\\end{${env}}`);}
}
function updateStructurePlan({args,id,group,s,plan,payloads,replacements}){
 if(args.orderBefore||args.orderAfter){const target=args.orderBefore||args.orderAfter;if(!plan.order.includes(target)||target===id||group||s.groups.some(g=>g.includes(target)))fail('INVALID_VALUE','Choose ungrouped order targets');plan.order=plan.order.filter(x=>x!==id);plan.order.splice(plan.order.indexOf(target)+(args.orderAfter?1:0),0,id);}
 updatePlacement(args,id,group,plan,payloads,replacements);
 updateSpan(args,group,payloads,replacements);
}
function wrapBlockStyle(payload,opts){
  let pre=(opts.pageBreakBefore?'\\clearpage\n':'')+(opts.gapBeforeBp?`\\vspace*{${opts.gapBeforeBp}bp}\n`:'');
  pre+='\\begingroup\n';if(opts.indentBp!==undefined)pre+=`\\setlength{\\parindent}{${opts.indentBp}bp}\n`;
  if(opts.widthBp!==undefined)pre+=`\\begin{minipage}{${opts.widthBp}bp}\n`;
  if(opts.align)pre+=({left:'\\raggedright',center:'\\centering',right:'\\raggedleft',justify:'\\normalfont'}[opts.align])+'\n';
  let post=(opts.widthBp!==undefined?'\\end{minipage}\n':'')+'\\endgroup\n'+(opts.gapAfterBp?`\\vspace*{${opts.gapAfterBp}bp}\n`:'')+(opts.keepWithNext?'\\nopagebreak[4]\n':'');
  const encoded=btoa(String.fromCharCode(...enc.encode(JSON.stringify(opts))));let result=`% FALSIFY-BLOCK-OPTIONS ${encoded}\n% FALSIFY-BLOCK-BEGIN\n${pre}% FALSIFY-BLOCK-CONTENT\n${payload}% FALSIFY-BLOCK-CONTENT-END\n% FALSIFY-BLOCK-END\n`;
  // End marker must follow the generated suffix while retaining an unambiguous original payload.
  result=result.replace('% FALSIFY-BLOCK-END\n',post+'% FALSIFY-BLOCK-END\n');
 return result;
}
function updateBlockStyle({args,id,group,payloads,replacements}){
 const styleKeys=['fontSizeBp','leadingBp','gapBeforeBp','gapAfterBp','indentBp','widthBp','pageBreakBefore','keepWithNext','align'];
 if(styleKeys.some(k=>k in args)){
  if('placement'in args)fail('INVALID_VALUE','Apply placement and styling separately');
  if(group)fail('UNSUPPORTED_BLOCK','Choose an ungrouped text block');
  let payload=payloads[id],opts={};const marker=/^% FALSIFY-BLOCK-OPTIONS ([A-Za-z0-9+/=]+)\n/;const found=marker.exec(payload);
  if(found){try{opts=JSON.parse(dec.decode(Uint8Array.from(atob(found[1]),c=>c.charCodeAt(0))));}catch{fail('INVALID_UNIT');}const match=/^% FALSIFY-BLOCK-OPTIONS [A-Za-z0-9+/=]+\n% FALSIFY-BLOCK-BEGIN\n[\s\S]*?% FALSIFY-BLOCK-CONTENT\n([\s\S]*?)% FALSIFY-BLOCK-CONTENT-END\n[\s\S]*?% FALSIFY-BLOCK-END\n$/.exec(payload);if(!match)fail('INVALID_UNIT');payload=match[1];}
  for(const k of styleKeys)if(k in args)opts[k]=args[k];
  const fontsize=/\\fontsize\{([\d.]+)(?:bp|pt)?\}\{([\d.]+)(?:bp|pt)?\}\\selectfont/;
  if(('fontSizeBp'in opts||'leadingBp'in opts)&&!fontsize.test(payload))fail('UNSUPPORTED_BLOCK','Block font declaration unavailable');
  // Apply the font command inside the existing unit group so its original size cannot override the selection.
  if('fontSizeBp'in opts||'leadingBp'in opts)payload=payload.replace(fontsize,(_,size,lead)=>`\\fontsize{${opts.fontSizeBp??size}bp}{${opts.leadingBp??lead}bp}\\selectfont`);
  replacements[id]=wrapBlockStyle(payload,opts);
 }
}
export async function updateBlockLayout({project,args={},signal}={}) {
 validateProject(project);const id=args.blockId;
 validateBlockOptions(args);
 if(!project.files.some(f=>f.path==='falsify-layout-structure.json'))return originalBlock({project,args,signal});
 const s=readLayoutStructure(project),payloads=readLayoutUnitPayloads(project);if(!s.units.some(u=>u.id===id))fail('INVALID_UNIT','Choose an existing block ID');
 const group=s.groups.find(g=>g.includes(id));
 const plan=structuredClone(s.plan),replacements={};
 updateStructurePlan({args,id,group,s,plan,payloads,replacements});
 updateBlockStyle({args,id,group,payloads,replacements});
 let current=project;if(Object.keys(replacements).length)current=(await replaceLayoutUnitPayloads({project:current,replacements,signal})).project;
 if(JSON.stringify(plan)!==JSON.stringify(s.plan))current=(await applyLayoutStructure({project:current,plan,signal})).project;
 return {project:current,summary:{blockId:id,updated:Object.keys(args).filter(k=>k!=='blockId')}};
}
function fontPage(args){const offset=args.offset??0,limit=args.limit??20;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('INVALID_PAGINATION','Choose a valid offset and limit');return {offset,limit};}
export async function inspectProjectFonts({project,args={},signal}={}){
 if(signal?.aborted)throw new DOMException('Cancelled','AbortError');validateProject(project);const text=args.text??'';if(typeof text!=='string'||text.length>4096)fail('INVALID_VALUE','Text must be at most 4096 characters');const {offset,limit}=fontPage(args);
 const fonts=project.files.filter(f=>/\.(?:ttf|otf)$/i.test(f.path));const selected=fonts.slice(offset,offset+limit);const plan=await createFontPlan({text,fonts:selected.map(f=>({id:f.path,family:f.path,bytes:f.bytes}))},{mupdf});if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const assets=plan.candidates.map(c=>({path:c.id,family:c.family,sha256:c.sha256,bytes:selected.find(f=>f.path===c.id).bytes.length,coverage:c.coverage}));const meta=project.files.find(f=>f.path==='falsify-reconstruction.json');let declared=null;try{declared=JSON.parse(decode(meta)).typography?.fonts||null;}catch{}if(!declared){const source=decode(project.files.find(f=>f.path===project.mainFile));declared=[...source.matchAll(/^\\setmainfont(?:\[[^\n]*\])?\{[^\n]*\}$/gm)].map(x=>x[0]).slice(0,10);}
 return {assets,declared,total:fonts.length,offset,limit,nextOffset:offset+limit<fonts.length?offset+limit:null,coverage:args.text===undefined?null:{status:plan.status,missing:plan.missing,scope:'returned-fonts'}};
}
function validateTypography(project,args){if(Object.keys(args).some(k=>!['fontPath','family','bodySizeBp','leadingBp'].includes(k)))fail('INVALID_VALUE','Unknown typography option');
 if(args.fontPath&&args.family)fail('INVALID_VALUE','Choose fontPath or family');
 if(args.fontPath&&!project.files.some(f=>f.path===args.fontPath&&/\.(ttf|otf)$/i.test(f.path)))fail('INVALID_FONT','Choose an available project font');
 if(args.family&&args.family!=='Latin Modern Roman')fail('INVALID_FONT','Choose Latin Modern Roman or a project font path');
 if('bodySizeBp'in args)num(args.bodySizeBp,4,72,'bodySizeBp');if('leadingBp'in args)num(args.leadingBp,4,150,'leadingBp');
}
function typographyBodyReplacements(current,s,args){const payloads=readLayoutUnitPayloads(current), replacements={};for(const u of s.units.filter(u=>u.role==='body')){const p=payloads[u.id], re=/\\fontsize\{([\d.]+)(?:bp|pt)?\}\{([\d.]+)(?:bp|pt)?\}\\selectfont/;if(!re.test(p))fail('UNSUPPORTED_BLOCK','Body font declaration unavailable');replacements[u.id]=p.replace(re,(_,size,lead)=>`\\fontsize{${args.bodySizeBp??size}bp}{${args.leadingBp??lead}bp}\\selectfont`);}return replacements;}
function fontOptionChunks(opts){let chunks=[],part='',depth=0;for(const c of opts){if(c==='{')depth++;if(c==='}')depth--;if(c===','&&depth===0){chunks.push(part);part='';}else part+=c;}if(depth!==0)fail('INVALID_FONT','Unsupported font options');if(part)chunks.push(part);return chunks;}
function typographyFontFiles(current,args){let source=decode(current.files.find(f=>f.path===current.mainFile));const re=/^\\setmainfont(?:\[[^\n]*\])?\{[^\n]*\}$/m;if(!re.test(source))fail('INVALID_FONT','Font declaration unavailable');if(args.fontPath&&!/^[A-Za-z0-9_./-]+\.(ttf|otf)$/i.test(args.fontPath))fail('INVALID_FONT','Unsupported font path');const old=source.match(re)[0],opts=/^\\setmainfont(?:\[([^\n]*)\])?/.exec(old)?.[1]||'';const chunks=fontOptionChunks(opts);const previousPath=(chunks.find(x=>/^\s*Path\s*=/.test(x))||'').replace(/^\s*Path\s*=\s*/,'').replace(/^\{|\}$/g,'');if(previousPath&&!/^[A-Za-z0-9_./-]+$/.test(previousPath))fail('INVALID_FONT','Unsupported font path');const preserved=chunks.filter(x=>!/^\s*(?:Path|UprightFont)\s*=/.test(x)).map(x=>x.replace(/^(\s*(?:BoldFont|ItalicFont|BoldItalicFont)\s*=\s*)\{([^{}]+)\}\s*$/,(_,prefix,value)=>`${prefix}{${previousPath}${value}}`));const decl=args.fontPath?`\\setmainfont[${[...preserved,'Path=./',`UprightFont={${args.fontPath}}`].join(',')}]{FalsifyPublication}`:'\\setmainfont{Latin Modern Roman}';source=source.replace(re,()=>decl);const files=current.files.map(f=>({path:f.path,bytes:f.path===current.mainFile?enc.encode(source):f.bytes}));return files;}
function typographySource(current,args){let source=decode(current.files.find(f=>f.path===current.mainFile));const marker=/\\begin\{document\}/;if(!marker.test(source))fail('INVALID_PROJECT','Document start unavailable');const prior=/% FALSIFY-TYPOGRAPHY-BEGIN\n\\fontsize\{([\d.]+)bp\}\{([\d.]+)bp\}\\selectfont\n% FALSIFY-TYPOGRAPHY-END\n/.exec(source);const size=args.bodySizeBp??(prior?Number(prior[1]):10),lead=args.leadingBp??(prior?Number(prior[2]):size*1.2);const command=`% FALSIFY-TYPOGRAPHY-BEGIN\n\\fontsize{${size}bp}{${lead}bp}\\selectfont\n% FALSIFY-TYPOGRAPHY-END\n`;source=prior?source.replace(prior[0],()=>command):source.replace(marker,m=>m+'\n'+command);return source;}
function typographyMetadataFiles(current,metaFile,args){const meta=JSON.parse(decode(metaFile));if(meta.typography){if(args.fontPath||args.family){meta.typography.fonts??={};meta.typography.fonts.serif=args.fontPath||args.family;}for(const [arg,key] of [['bodySizeBp','sizeBp'],['leadingBp','leadingBp']])if(arg in args){meta.typography.body??={};meta.typography.roles??={};meta.typography.roles.body??={};meta.typography.body[key]=args[arg];meta.typography.roles.body[key]=args[arg];}return current.files.map(f=>({path:f.path,bytes:f.path===metaFile.path?enc.encode(JSON.stringify(meta)):f.bytes}));}return null;}
export async function setProjectTypography({project,args={},signal}={}){
 validateProject(project);validateTypography(project,args);
 let current=project;const structured=project.files.some(f=>f.path==='falsify-layout-structure.json');const s=structured?readLayoutStructure(current):null;
 if(args.fontPath){const font=project.files.find(f=>f.path===args.fontPath);const plan=await createFontPlan({text:'A',fonts:[{id:font.path,family:font.path,bytes:font.bytes}]},{mupdf});if(plan.candidates[0].coverage.status==='unavailable')fail('INVALID_FONT','Project font could not be parsed');}
 if(structured&&('bodySizeBp'in args||'leadingBp'in args)){const replacements=typographyBodyReplacements(current,s,args);current=(await replaceLayoutUnitPayloads({project:current,replacements,signal})).project;}
 if(args.fontPath||args.family){const files=typographyFontFiles(current,args);current=await createLatexProject({...current,files});if(structured)current=(await applyLayoutStructure({project:current,plan:readLayoutStructure(current).plan,signal})).project;}
 if(!structured&&('bodySizeBp'in args||'leadingBp'in args)){const source=typographySource(current,args);current=await replaceFile(current,current.mainFile,source);}
 const metaFile=current.files.find(f=>f.path==='falsify-reconstruction.json');
 if(metaFile){const files=typographyMetadataFiles(current,metaFile,args);if(files)current=await createLatexProject({...current,files});}
 return {project:current,summary:{updated:Object.keys(args),fontCoverage:'unknown'}};
}

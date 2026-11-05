import {createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true}),BEGIN='% FALSIFY-LAYOUT-BEGIN\n',END='% FALSIFY-LAYOUT-END\n';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=id=>Array.from(enc.encode(id),b=>b.toString(16).padStart(2,'0')).join('');
const begin=id=>`% FALSIFY-UNIT-BEGIN ${key(id)}\n`,end=id=>`% FALSIFY-UNIT-END ${key(id)}\n`;
const KINDS=new Set(['paragraph','heading','caption','furniture','figure','table','unknown']);
const ROLES=new Set(['title','heading','caption','footnote','body']);
const SPANS=new Set(['column','page','unknown']);
// Generated unit ids are a short prefix plus 24 hex digits. A sha256 token serializes to 66. The registry repeats an id, so a longer id exceeds the observation budget.
const MAX_SERIALIZED_ID=66;
const finiteBox=b=>Array.isArray(b)&&b.length===4&&b.every(n=>typeof n==='number'&&Number.isFinite(n));
function validateGroups(s,p,all,front,furniture){
 for(const group of s.groups)if(!Array.isArray(group)||group.length!==2||group.some(id=>!all.has(id))||p.order.indexOf(group[1])!==p.order.indexOf(group[0])+1||front.has(group[0])||front.has(group[1])||furniture.has(group[0])||furniture.has(group[1]))fail('GROUP_SEPARATED');
}
function validatePlanSets(p,ids,all,order,front,furniture){
 if(order.size!==ids.length||p.order.length!==ids.length||p.order.some(id=>!all.has(id))||front.size!==p.frontMatter.length||p.frontMatter.some(id=>!all.has(id))||furniture.size!==p.furniture.length||p.furniture.some(f=>!all.has(f.id)||!['header','footer'].includes(f.placement)||front.has(f.id)))fail('INVALID_PLAN');
}
function validatePlan(s,p,ids){
 if(p?.schema!=='falsify.paper-layout-plan.v1'||p.sourcePdfHash!==s.sourcePdfHash||![1,2].includes(p.columns)||!Array.isArray(p.order)||!Array.isArray(p.frontMatter)||!Array.isArray(p.furniture))fail('INVALID_PLAN');
 const all=new Set(ids),order=new Set(p.order),front=new Set(p.frontMatter),furniture=new Set(p.furniture.map(f=>f?.id));
 validatePlanSets(p,ids,all,order,front,furniture);
 const flow=p.order.filter(id=>!furniture.has(id));if(p.frontMatter.some((id,n)=>flow[n]!==id)||flow.slice(front.size).some(id=>front.has(id)))fail('INVALID_PLAN');
 validateGroups(s,p,all,front,furniture);
}
function validate(s,p){
 if(s?.schema!=='falsify.paper-layout-structure.v1'||!Array.isArray(s.units)||!Array.isArray(s.groups)||!/^[a-f0-9]{64}$/.test(s.sourcePdfHash||''))fail('INVALID_STRUCTURE');
 const ids=s.units.map(u=>u.id);if(ids.some(id=>typeof id!=='string'||!id||JSON.stringify(id).length>MAX_SERIALIZED_ID)||new Set(ids).size!==ids.length)fail('INVALID_STRUCTURE');
 if(s.units.some(u=>!u||typeof u!=='object'||!finiteBox(u.bbox)||(u.kind!==undefined&&!KINDS.has(u.kind))||(u.role!==undefined&&!ROLES.has(u.role))||(u.span!==undefined&&!SPANS.has(u.span))))fail('INVALID_STRUCTURE');
 validatePlan(s,p,ids);
}
export function renderStructureRegion(s,p,fragments){
 validate(s,p);const front=new Set(p.frontMatter),furn=new Map(p.furniture.filter(f=>!(f.placement==='footer'&&s.units.find(u=>u.id===f.id)?.role==='footnote'&&fragments.get(f.id)?.includes('\\footnotetext{'))).map(f=>[f.id,f.placement])),offsets=new Map();let text=BEGIN;
 const add=id=>{const value=fragments.get(id);if(typeof value!=='string'||value.includes(BEGIN)||value.includes(END)||/^% FALSIFY-UNIT-(?:BEGIN|END) [0-9a-f]+$/m.test(value))fail('INVALID_UNIT');text+=begin(id);offsets.set(id,text.length);text+=value;text+=end(id);};
 // Keep every source payload in its own marked macro. Identical running
 // furniture becomes one page template, so reflow cannot create blank pages
 // merely to print the remaining duplicate headers.
 const templates=new Map();
 function addFurniture(id){const placement=furn.get(id);if(!placement)return;const u=s.units.find(x=>x.id===id),b=u.bbox;if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||!Number.isFinite(u.pageHeight)||!Number.isInteger(u.pageIndex)||u.pageIndex<0||u.pageIndex>10000)fail('INVALID_FURNITURE_GEOMETRY');
  const y=placement==='header'?(b[1]<u.pageHeight/2?b[1]:36):(b[1]>=u.pageHeight/2?b[1]:u.pageHeight-36),name='FalsifyFurniture'+key(id);
  text+=`\\expandafter\\long\\expandafter\\def\\csname ${name}\\endcsname{%\n`;add(id);text+='}\n';
  const templateKey=JSON.stringify([placement,b.map(v=>Number(v.toFixed(2))),fragments.get(id)]),entry={id,name,b,y,page:u.pageIndex+1};
  if(!templates.has(templateKey))templates.set(templateKey,[]);templates.get(templateKey).push(entry);
 }
 for(const id of p.order)addFurniture(id);
 for(const group of templates.values()){const f=group[0],from=Math.min(...group.map(x=>x.page)),repeat=group.length>1;
  const condition=repeat?`\\ifnum\\value{page}>${from-1}`:`\\ifnum\\value{page}=${from}`;
  text+=`\\AddToHook{shipout/foreground}{${condition}\\relax\\put(${f.b[0]}bp,-${f.y}bp){\\parbox[t]{${Math.max(1,f.b[2]-f.b[0])}bp}{\\csname ${f.name}\\endcsname}}\\fi}\n`;
 }
 addBody();
 function addBody(){
 addColumnStart();
 function addColumnStart(){
 if(p.columns===2)text+=front.size?'\\twocolumn[{\n':'\\twocolumn\n';
 if(p.columns===2&&front.size&&Number.isFinite(s.frontTopPaddingBp)&&s.frontTopPaddingBp>0)text+=`\\vspace*{${s.frontTopPaddingBp}bp}\n`;
 }
 for(const id of p.frontMatter)add(id);if(p.columns===2&&front.size)text+='}]\n';
 for(const r of s.bodyReservations||[])if(r.pageIndex===0&&r.column==='left'&&Number.isFinite(r.deltaBp)&&r.deltaBp>0)text+=`\\enlargethispage{-${Number(r.deltaBp.toFixed(4))}bp}\n`;
 for(const id of p.order)if(!front.has(id)&&!furn.has(id))add(id);
 }
 return {text:text+END,offsets};
}
function validateStructureProject(project){
 if(project?.schema!=='falsify.latex-project.v1'||project.origin!=='reconstructed-pdf'||!Array.isArray(project.files)||!project.mainFile||!/^[a-f0-9]{64}$/.test(project.sourcePdfHash||''))fail('INVALID_PROJECT');
 const names=new Set();for(const f of project.files){if(!f?.path||names.has(f.path)||!(f.bytes instanceof Uint8Array)||hex(f.bytes)!==f.sha256)fail('STALE_PROJECT');names.add(f.path);}
 const files=project.files.map(({path,sha256})=>[path,sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);if(hex(enc.encode(JSON.stringify({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin})))!==project.id)fail('STALE_PROJECT');
}
function extractFragments(source,s){
 const start=source.indexOf(BEGIN),stop=source.indexOf(END,start+BEGIN.length);if(start<0||stop<0||source.indexOf(BEGIN,start+1)>=0||source.indexOf(END,stop+1)>=0)fail('INVALID_MARKERS');
 const region=source.slice(start,stop+END.length),fragments=new Map();for(const u of s.units){const a=begin(u.id),b=end(u.id),i=region.indexOf(a),j=region.indexOf(b,i+a.length);if(i<0||j<0||region.indexOf(a,i+1)>=0||region.indexOf(b,j+1)>=0)fail('INVALID_MARKERS');fragments.set(u.id,region.slice(i+a.length,j));}
 return {start,stop,region,fragments};
}
function inspect(project){
 validateStructureProject(project);
 let s,source;try{s=JSON.parse(dec.decode(project.files.find(f=>f.path==='falsify-layout-structure.json').bytes));source=dec.decode(project.files.find(f=>f.path===project.mainFile).bytes);}catch{fail('INVALID_STRUCTURE');}
 if(s.sourcePdfHash!==project.sourcePdfHash)fail('INVALID_STRUCTURE');validate(s,s.plan);
 const {start,stop,region,fragments}=extractFragments(source,s);
 if(renderStructureRegion(s,s.plan,fragments).text!==region)fail('INVALID_MARKERS');return {s,source,start,stop:stop+END.length,fragments};
}
export function readLayoutStructure(project){return structuredClone(inspect(project).s);}
export function readLayoutUnitPayloads(project){return Object.fromEntries(inspect(project).fragments);}
function applyReplacements(project,replacements,extraFiles,fragments){
 if(!replacements || Object.getPrototypeOf(replacements)!==Object.prototype || !Array.isArray(extraFiles))fail('INVALID_REPLACEMENTS');
 for(const [id,payload] of Object.entries(replacements)){if(!fragments.has(id)||typeof payload!=='string')fail('INVALID_UNIT');fragments.set(id,payload);}
 const existing=new Set(project.files.map(f=>f.path));for(const f of extraFiles){if(!f || typeof f.path!=='string'||existing.has(f.path)||!(f.bytes instanceof Uint8Array))fail('INVALID_EXTRA_FILE');existing.add(f.path);}
}
async function updateStructure({project,plan,signal,replacements={},extraFiles=[]}={}){
 if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const {s,source,start,stop,fragments}=inspect(project);plan ??= s.plan;validate(s,plan);
 applyReplacements(project,replacements,extraFiles,fragments);
 // Reserve current-column space for a first-page footer entering the body box.
 // Keep the rest of the document's margins and pagination unchanged.
 const dimensions=[...source.slice(0,start).matchAll(/bottom\s*=\s*([\d.]+)\s*(bp|pt|mm|cm|in)/g)],last=dimensions.at(-1),factor={bp:1,pt:72/72.27,mm:72/25.4,cm:72/2.54,in:72};
 const bottom=last?Number(last[1])*factor[last[2]]:null;let reserve=0;
 function reserveFooter(f){const u=s.units.find(x=>x.id===f.id);if(f.placement!=='footer'||!Number.isFinite(bottom))return;
  if(u.role==='footnote'&&fragments.get(f.id)?.includes('\\footnotetext{'))return;
  const b=u.bbox,bodyUnits=s.units.filter(v=>v.pageIndex===u.pageIndex&&!plan.furniture.some(x=>x.id===v.id)),minX=Math.min(...bodyUnits.map(v=>v.bbox[0])),maxX=Math.max(...bodyUnits.map(v=>v.bbox[2])),leftColumn=plan.columns===1||b[2]<=(minX+maxX)/2;
  const y=b[1]>=u.pageHeight/2?b[1]:u.pageHeight-36,bodyBottom=u.pageHeight-bottom;
  if(y>=bodyBottom)return;
  if(u.pageIndex!==0||!leftColumn)return;
  const font=/\\fontsize\s*\{\s*([\d.]+)(bp|pt)?\s*\}/.exec(fragments.get(f.id)||''),size=font?Number(font[1])*(font[2]==='pt'?factor.pt:1):10;
  reserve=Math.max(reserve,bodyBottom-y+size*1.2+6);
 }
 for(const f of plan.furniture)reserveFooter(f);
 s.bodyReservations=reserve>0?[{pageIndex:0,column:'left',deltaBp:reserve}]:[];
 const rendered=renderStructureRegion(s,plan,fragments),region=rendered.text;s.plan=structuredClone(plan);
 const files=project.files.map(f=>{if(f.path===project.mainFile)return {path:f.path,bytes:enc.encode(source.slice(0,start)+region+source.slice(stop))};if(f.path==='falsify-layout-structure.json')return {path:f.path,bytes:enc.encode(JSON.stringify(s))};
  if(f.path==='falsify-reconstruction.json'){const m=JSON.parse(dec.decode(f.bytes));m.baselineBindings??=structuredClone(m.bindings||[]);m.bindings=(m.bindings||[]).map(b=>{const offset=rendered.offsets.get(b.itemId),payload=fragments.get(b.itemId);if(offset===undefined||typeof payload!=='string')fail('INVALID_BINDING');return {...b,start:start+offset,end:start+offset+payload.length,status:'review-required',scope:'layout-unit',bindingScope:'containing-project'};});m.layoutDerived=true;return {path:f.path,bytes:enc.encode(JSON.stringify(m))};}
  return {path:f.path,bytes:f.bytes.slice()};});
 for(const f of extraFiles)files.push({path:f.path,bytes:f.bytes.slice()});
 if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const next=await createLatexProject({files,mainFile:project.mainFile,engine:project.engine,origin:project.origin,sourcePdfHash:project.sourcePdfHash});return {project:next,summary:{units:s.units.length,frontMatter:plan.frontMatter.length,furniture:plan.furniture.length,columns:plan.columns}};
}

export async function applyLayoutStructure({project,plan,signal}={}){return updateStructure({project,plan,signal});}
export async function replaceLayoutUnitPayloads({project,replacements,extraFiles=[],signal}={}){return updateStructure({project,replacements,extraFiles,signal});}

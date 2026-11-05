import {hex} from './paragraph-pdf-crypto.mjs';
import {inferTypographyProfile} from './paper-typography-profile.mjs';
import {renderStructureRegion} from './paper-layout-structure.mjs';
const enc=new TextEncoder(), fail=code=>{throw Object.assign(new Error(code),{code});};
const escapeMap={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
const escape=text=>Array.from(text, c=>escapeMap[c]??(c==='\r'||c==='\n'||c==='\t'?' ':c)).join('');
const num=n=>Number(n.toFixed(4)).toString();
const good=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
export function serializeFlowReconstruction({model,decisions=[],profile,fontFiles=[]}={}) {
  function validateModel() {
    if(model?.schema!=='falsify.pdf-latex-reconstruction.v1'||!/^[a-f0-9]{64}$/.test(model.sourceSha256||'')||!Array.isArray(model.pages)||!model.pages.length||!Array.isArray(model.items)||!Array.isArray(model.assets)||!Array.isArray(model.relations)||!Array.isArray(model.diagnostics)||!Array.isArray(decisions)||!Array.isArray(fontFiles)) fail('INVALID_MODEL');
  }
  validateModel();
  const pages=new Map(model.pages.map((p,i)=>{if(p.pageIndex!==i||!good(p.width,1,14400)||!good(p.height,1,14400)||p.frame!=='mupdf-display') fail('INVALID_PAGE');return [i,p];}));
  const refs=rs=>Array.isArray(rs)&&rs.length>0&&rs.every(r=>r?.sourceSha256===model.sourceSha256&&pages.has(r.pageIndex)&&r.frame==='mupdf-display'&&Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(Number.isFinite)&&r.bbox[0]<=r.bbox[2]&&r.bbox[1]<=r.bbox[3]);
  function collectItems() {
    for(const i of model.items){if(!i?.id||items.has(i.id)||!refs(i.evidence)||i.evidence.some(r=>r.pageIndex!==i.evidence[0].pageIndex)||!['observed','proposed','confirmed','unsupported'].includes(i.status))fail('INVALID_ITEM');items.set(i.id,i);}
  }
  const items=new Map(); collectItems();
  function collectChoices() {
    for(const d of decisions){const i=items.get(d?.itemId);if(!i||choices.has(d.itemId)||d.sourceSha256!==model.sourceSha256||typeof d.tex!=='string'||!d.tex.trim()||JSON.stringify(d.evidence)!==JSON.stringify(i.evidence))fail('INVALID_DECISION');choices.set(d.itemId,d);}
  }
  const choices=new Map();collectChoices();
  function collectAssets() {
    for(const a of model.assets){if(!a?.id||assets.has(a.id)||!(a.bytes instanceof Uint8Array)||a.mediaType!=='image/png'||!['image','region-raster'].includes(a.representation)||a.editable!==false||!refs(a.evidence)||hex(a.bytes)!==a.sha256||![137,80,78,71,13,10,26,10].every((x,i)=>a.bytes[i]===x))fail('INVALID_ASSET');assets.set(a.id,a);}
  }
  const assets=new Map();collectAssets();
  const t=profile?structuredClone(profile):inferTypographyProfile(model), p=t.page, body=t.body;
  function validatePageTypography() {
    if(t.schema!=='falsify.paper-typography.v1'||!p||![1,2].includes(p.columns)||!good(p.widthBp,72,14400)||!good(p.heightBp,72,14400)||!good(p.gutterBp,0,200)||!p.margins||!['left','right','top','bottom'].every(k=>good(p.margins[k],0,1000))||p.margins.left+p.margins.right>=p.widthBp||p.margins.top+p.margins.bottom>=p.heightBp||!good(body?.indentEm,0,10)||!good(body?.paragraphGapEm,0,10))fail('INVALID_TYPOGRAPHY');
  }
  function validateTypography() {
    validatePageTypography();
    for(const r of ['body','heading','caption','footnote'])if(!good(t.roles?.[r]?.sizeBp,4,72)||!good(t.roles[r].leadingBp,4,150))fail('INVALID_TYPOGRAPHY');
  }
  validateTypography();
  function validateFont(f) {
    if(!(f?.bytes instanceof Uint8Array)||!f.bytes.length||!/\.(otf|ttf)$/i.test(f.path||'')||!['serif','math'].includes(f.role||'serif')||!['regular','bold','italic','bolditalic'].includes(f.style||'regular'))fail('INVALID_FONT');
  }
  function collectFonts() {
    for(const f of fontFiles){validateFont(f);const k=f.style||'regular',path=`fonts/${hex(f.bytes)}.${f.path.split('.').pop().toLowerCase()}`;if(f.role==='math'){if(symbolFont||k!=='regular')fail('INVALID_FONT');symbolFont=path;}else{if(fontPaths.has(k))fail('INVALID_FONT');fontPaths.set(k,path);}files.push({path,bytes:f.bytes.slice()});}
  if(fontPaths.size&&!fontPaths.has('regular'))fail('INVALID_FONT');
  }
  const files=[],fontPaths=new Map();let symbolFont=null;collectFonts();
  const diagnostics=model.diagnostics.map(d=>({...d})),bindings=[];let status=diagnostics.some(d=>d.severity==='error')?'unsupported':diagnostics.some(d=>d.severity==='warning')?'needs-review':'ready';
  const issue=(code,item,severity='warning')=>{diagnostics.push({code,severity,...(item?{itemId:item.id,pageIndex:item.evidence[0].pageIndex}:{})});if(severity==='error')status='unsupported';else if(status==='ready')status='needs-review';};
  function reportRelationDiagnostics() {
    issue('FLOW_LAYOUT_UNVERIFIED');
    for(const rel of model.relations)if(rel.status!=='confirmed')issue('RELATION_REVIEW');
  }
  reportRelationDiagnostics();
  const font=fontPaths.has('regular')?`\\setmainfont[NFSSFamily=FalsifyBody,Path=fonts/,UprightFont={${fontPaths.get('regular').slice(6)}},${[...fontPaths].filter(([k])=>k!=='regular').map(([k,v])=>`${{bold:'BoldFont',italic:'ItalicFont',bolditalic:'BoldItalicFont'}[k]}={${v.slice(6)}}`).join(',')}]{FalsifyPublication}`:'\\setmainfont{Latin Modern Roman}';
  if(!fontPaths.size&&t.fonts?.serif!=='Latin Modern Roman')fail('INVALID_FONT');
  const headerClearance=Math.max(p.margins.top,...model.items.filter(i=>i.kind==='furniture'||i.evidence[0].bbox[3]<pages.get(i.evidence[0].pageIndex).height*.1).filter(i=>i.evidence[0].bbox[1]<pages.get(i.evidence[0].pageIndex).height*.1).map(i=>i.evidence[0].bbox[3]+10));
  const footerClearance=Math.max(p.margins.bottom,...model.items.filter(i=>i.evidence.some(e=>e.bbox[1]>pages.get(e.pageIndex).height*.93)).map(i=>{const e=i.evidence[0];return pages.get(e.pageIndex).height-e.bbox[1]+10;}));
  let source=`% !TeX program = lualatex\n\\documentclass{article}\n\\usepackage{fontspec}\n\\usepackage{microtype}\n\\usepackage{graphicx}\n\\usepackage[paperwidth=${num(p.widthBp)}bp,paperheight=${num(p.heightBp)}bp,left=${num(p.margins.left)}bp,right=${num(p.margins.right)}bp,top=${num(headerClearance)}bp,bottom=${num(footerClearance)}bp]{geometry}\n${font}\n`;
  if(symbolFont)source+=`\\newfontfamily\\FalsifySymbols[Path=fonts/]{${symbolFont.slice(6)}}\n`;
  const escaped=text=>Array.from(text,c=>symbolFont&&/[\u2200-\u22ff]/u.test(c)?`{\\FalsifySymbols ${c}}`:escape(c)).join('');
  function emitPreamble() {
    source+=t.packages?.needspace?'\\IfFileExists{needspace.sty}{\\usepackage{needspace}}{\\newcommand{\\Needspace}[1]{}}\n':'\\newcommand{\\Needspace}[1]{}\n';
    if(t.packages?.luaWidowControl)source+='\\IfFileExists{lua-widow-control.sty}{\\usepackage{lua-widow-control}}{}\n';
    source+='\\widowpenalty=10000\n\\clubpenalty=10000\n\\displaywidowpenalty=10000\n';
    // Use the source display box when known; otherwise cap the image's natural size.
    source+='\\newsavebox{\\FalsifyImageBox}\n\\newcommand{\\FalsifyImage}[3]{%\n\\sbox{\\FalsifyImageBox}{\\includegraphics{#3}}%\n\\def\\FalsifyWidth{#1}\\def\\FalsifyHeight{#2}%\n\\ifdim\\FalsifyWidth>\\linewidth\\def\\FalsifyWidth{\\linewidth}\\fi%\n\\ifdim\\FalsifyHeight>.7\\textheight\\def\\FalsifyHeight{.7\\textheight}\\fi%\n\\includegraphics[width=\\FalsifyWidth,height=\\FalsifyHeight,keepaspectratio]{#3}}\n';
    source+=`\\setlength{\\columnsep}{${num(p.gutterBp)}bp}\n\\setlength{\\parindent}{${num(body.indentEm)}em}\n\\setlength{\\parskip}{${num(body.paragraphGapEm)}em}\n\\pagestyle{empty}\n\\begin{document}\n`;
  }
  emitPreamble();
  const append=(i,s,state)=>{const start=source.length;source+=s;bindings.push({itemId:i.id,projectId:null,path:'main.tex',start,end:source.length,evidence:structuredClone(i.evidence),status:state});};
  const role=i=>i.extensions?.publicationRole==='title'?'title':i.extensions?.publicationRole==='section-heading'?'heading':i.extensions?.publicationRole==='footnote'?'footnote':i.kind==='heading'?'heading':i.kind==='caption'||i.reason==='caption-proposal'?'caption':i.kind==='footnote'?'footnote':'body';
  function styleInlineRun(value, run) {
    if(run?.italic)value=`\\textit{${value}}`;if(run?.bold)value=`\\textbf{${value}}`;
    if(run?.script==='super')value=`\\textsuperscript{${value}}`;else if(run?.script==='sub')value=`\\textsubscript{${value}}`;
    return value;
  }
  const emitText=(i,text)=>{
    if(/[^\x00-\x7f]/u.test(text))issue('UNICODE_GLYPH_COVERAGE_UNVERIFIED',i);if(i.extensions?.candidates?.length||i.reason==='inline-script-candidate')issue('SEMANTIC_TRANSCRIPTION_REVIEW',i);if(i.extensions?.separators?.length)issue('SOURCE_SPACING_PROPOSED',i);
    const runs=i.extensions?.inlineRuns;if(text!==i.text||!runs?.length)return escaped(text);
    if(!runs.every((r,n)=>Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end<=text.length&&r.start<r.end&&(!n||runs[n-1].end<=r.start)))fail('INVALID_INLINE_RUN');
    const publication=i.extensions.publicationRole,label=i.extensions.roleLabel,breaks=['metadata','affiliation'].includes(publication)?i.extensions.lineBreaks||[]:[];
    const cuts=[...new Set([0,text.length,...runs.flatMap(r=>[r.start,r.end]),...breaks,...(label?[label.end]:[])])].filter(n=>Number.isSafeInteger(n)&&n>=0&&n<=text.length).sort((a,b)=>a-b);
    let out='';for(let n=1;n<cuts.length;n++){
      const a=cuts[n-1],b=cuts[n],run=runs.find(r=>r.start<=a&&r.end>=b);let value=escaped(text.slice(a,b));
      value=styleInlineRun(value,run);
      out+=value;if(b<text.length&&(breaks.includes(b)||label?.end===b))out+='\\par\\noindent ';
    }return out;
  };
  // A caption relation owns its pair independently of flat reader order.
  const boxOf=refs=>{const bs=refs.map(e=>e.bbox);return [Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))];};
  const validBox=(b,page)=>b[0]>=0&&b[1]>=0&&b[2]<=page.width&&b[3]<=page.height&&b[2]>b[0]&&b[3]>b[1];
  const assetBox=(a,i)=>{const page=pages.get(i.evidence[0].pageIndex);if(a.evidence.length!==1||a.evidence[0].pageIndex!==page.pageIndex)return null;const b=a.evidence[0].bbox;return validBox(b,page)?b:null;};
  // A proposal is usable only when same-page paragraph geometry independently
  // establishes both sides of its gutter and the object crosses both edges.
  function validSpanHint(h, g, page) {
    if(h?.status!=='proposed'||h?.provenance!=='paper-flow'||h.columns!==2||!Array.isArray(g)||g.length!==2||!g.every(Number.isFinite)||g[0]<=0||g[0]>=g[1]||g[1]>=page.width)return false;
    return true;
  }
  const spans=i=>{if(p.columns!==2||i.extensions?.span!=='page')return false;const page=pages.get(i.evidence[0].pageIndex),h=page.extensions?.layoutHints,g=h?.gutterBp;if(!validSpanHint(h,g,page))return false;const b=i.assetId?assetBox(assets.get(i.assetId)||{evidence:[]},i):boxOf(i.evidence);if(!b||!validBox(b,page)||b[0]>g[0]-4||b[2]<g[1]+4)return false;const boxes=model.items.filter(x=>x.kind==='paragraph'&&x.evidence[0].pageIndex===page.pageIndex).map(x=>boxOf(x.evidence)).filter(x=>validBox(x,page));return boxes.some(x=>x[2]<=g[0])&&boxes.some(x=>x[0]>=g[1]);};
  const groups=new Map(), groupedCaptions=new Set();
  function groupCaptions() {
    for(const rel of model.relations){
      const figure=items.get(rel.from), caption=items.get(rel.to);
      const expected=figure&&caption?[...figure.evidence,...caption.evidence]:null;
      if(rel.kind==='caption' && ['proposed','confirmed'].includes(rel.status) && (figure?.assetId||figure?.kind==='table') && role(caption||{})==='caption' && JSON.stringify(rel.evidence)===JSON.stringify(expected) && !groups.has(figure.id) && !groupedCaptions.has(caption.id) && figure.evidence[0].pageIndex===caption.evidence[0].pageIndex){groups.set(figure.id,caption.id);groupedCaptions.add(caption.id);}
      else if(rel.status==='confirmed')issue('RELATION_REVIEW');
  }
  }
  groupCaptions();
  const orderedItems=[];
  function orderItems() {
    for(const i of model.items){if(groupedCaptions.has(i.id))continue;const caption=items.get(groups.get(i.id));if(caption&&boxOf(caption.evidence)[3]<=boxOf(i.evidence)[1])orderedItems.push(caption,i);else{orderedItems.push(i);if(caption)orderedItems.push(caption);}}
  }
  orderItems();
  const floatStart=new Map(), floatEnd=new Set();
  function planFloats() {
    for(const [fid,cid] of groups){const fi=orderedItems.findIndex(i=>i.id===fid),ci=orderedItems.findIndex(i=>i.id===cid);const figure=items.get(fid),env=(figure.kind==='table'?'table':'figure')+(spans(figure)?'*':'');floatStart.set(Math.min(fi,ci),env);floatEnd.add(JSON.stringify([Math.max(fi,ci),env]));}
    for(const [index,i] of orderedItems.entries())if(i.kind==='table'&&i.assetId&&!groups.has(i.id)){const env='table'+(spans(i)?'*':'');floatStart.set(index,env);floatEnd.add(JSON.stringify([index,env]));}
  }
  planFloats();
  const endings=new Map([...floatEnd].map(x=>JSON.parse(x)));
  const unitFragments=new Map(),unitBindings=new Map();
  function emitAsset(i) {
    const a=assets.get(i.assetId);if(!a||a.evidence.some(e=>e.pageIndex!==i.evidence[0].pageIndex))fail('INVALID_ASSET_REFERENCE');const path=`assets/${a.sha256}.png`;if(!files.some(f=>f.path===path))files.push({path,bytes:a.bytes.slice()});const b=assetBox(a,i),w=b?`${num(b[2]-b[0])}bp`:'\\wd\\FalsifyImageBox',h=b?`${num(b[3]-b[1])}bp`:'\\ht\\FalsifyImageBox';append(i,`\\FalsifyImage{${w}}{${h}}{${path}}`,'noneditable');issue('NONEDITABLE_REGION',i);if(i.text){if(a.representation==='region-raster')issue('RASTER_TEXT_NONEDITABLE',i);else source+=' '+emitText(i,i.text);}
  }
  function emitUnitContent(i, decision) {
    if(decision)append(i,decision.tex,'reviewed');
    else if(i.assetId)emitAsset(i);
    else if(i.kind==='table'&&i.table?.rows?.length){const rows=i.table.rows;if(!rows.every(row=>Array.isArray(row)&&row.length===rows[0].length&&row.every(c=>typeof c?.text==='string'&&refs(c.evidence)&&(c.colSpan??1)===1&&(c.rowSpan??1)===1)))fail('INVALID_TABLE');const content='\\begin{tabular}{'+'l'.repeat(rows[0].length)+'}\n'+rows.map(row=>row.map(c=>emitText(i,c.text)).join(' & ')+' \\\\').join('\n')+'\n\\end{tabular}';append(i,content,'review-required');issue('TABLE_LAYOUT_REVIEW',i);}
    else if(typeof i.text==='string'&&i.text.length)append(i,emitText(i,i.text),/[^\x00-\x7f]/u.test(i.text)||i.extensions?.candidates?.length||i.extensions?.separators?.length||i.reason==='inline-script-candidate'?'review-required':'exact-text');
    else {issue('MISSING_CONTENT',i,'error');source+='% Missing source content';}
  }
  function openUnit(i, r, style, publication) {
    if(r==='heading')source+='\\Needspace{4\\baselineskip}\n';if(i.assetId||r==='caption')source+='\\Needspace{5\\baselineskip}\n';if(r==='footnote')source+='\\begingroup\\renewcommand{\\thefootnote}{}\\footnotetext{';source+=`{\\fontsize{${num(style.sizeBp)}bp}{${num(style.leadingBp)}bp}\\selectfont `;if(['heading','title'].includes(r))source+='\\bfseries ';if(publication&&publication!=='body')source+='\\noindent ';
  }
  function closeUnit(index, r, style, publication) {
    source+='\\par}\n\n';
    if(r==='footnote')source+='}\\endgroup\n';
    const gap=({title:1,authors:.35,affiliation:.5,metadata:.7,abstract:.7,keywords:.7,'section-heading':.35})[publication];if(gap)source+=`\\vspace{${num(gap*style.sizeBp)}bp}\n`;
    if(r==='heading')source+='\\nopagebreak[4]\n';
    if(endings.has(index))source+=`\\end{${endings.get(index)}}\n`;
  }
  function renderUnits() {
    function renderUnit(index, i) {const unitStart=source.length, bindingStart=bindings.length; if(floatStart.has(index))source+=`\\begin{${floatStart.get(index)}}[htbp]\n\\centering\n`; const r=role(i),baseStyle=t.roles[r]||t.roles.body,page=pages.get(i.evidence[0].pageIndex),edgeBox=boxOf(i.evidence),observedSize=i.extensions?.typography?.fontSizeBp,isEdge=i.kind==='furniture'||edgeBox[3]<page.height*.1||edgeBox[1]>page.height*.93,publication=i.extensions?.publicationRole,override=t.diagnostics?.some(d=>d.source==='override'&&(d.field==='roles'||d.field==='body'&&r==='body')),observedLeading=i.extensions?.typography?.leadingBp,style=(i.kind==='furniture'||!override&&(isEdge||publication))&&good(observedSize,4,36)?{sizeBp:observedSize,leadingBp:good(observedLeading,observedSize*.9,observedSize*2)?observedLeading:observedSize*1.2}:baseStyle,decision=choices.get(i.id);openUnit(i, r, style, publication);
      emitUnitContent(i, decision);
      closeUnit(index, r, style, publication);
      unitFragments.set(i.id,source.slice(unitStart)); for(const b of bindings.slice(bindingStart))unitBindings.set(i.id,{binding:b,start:b.start-unitStart,end:b.end-unitStart}); source=source.slice(0,unitStart);
    }
    for (const [index, i] of orderedItems.entries()) renderUnit(index, i);
  }
  renderUnits();
  if(!model.items.length)issue('MISSING_CONTENT',null,'error');
  const units=orderedItems.map(i=>({id:i.id,pageIndex:i.evidence[0].pageIndex,pageHeight:pages.get(i.evidence[0].pageIndex).height,bbox:boxOf(i.evidence),kind:i.kind,role:role(i),span:i.extensions?.span||'unknown'}));
  const first=pages.get(0),g=first.extensions?.layoutHints?.gutterBp;
  const firstItems=units.filter(u=>u.pageIndex===0),left=firstItems.filter(u=>u.kind==='paragraph'&&Array.isArray(g)&&u.bbox[2]<=g[0]),right=firstItems.filter(u=>u.kind==='paragraph'&&Array.isArray(g)&&u.bbox[0]>=g[1]);
  function collectPairedColumns() {
    for(const l of left)for(const r of right){const overlap=Math.min(l.bbox[3],r.bbox[3])-Math.max(l.bbox[1],r.bbox[1]);if(overlap>=Math.min(l.bbox[3]-l.bbox[1],r.bbox[3]-r.bbox[1])*.5&&Math.min(l.bbox[3]-l.bbox[1],r.bbox[3]-r.bbox[1])>=12)paired.push(Math.min(l.bbox[1],r.bbox[1]));}
  }
  const paired=[];collectPairedColumns();
  const bodyTop=paired.length?Math.min(...paired):null;
  const furniture=units.filter(u=>u.kind==='furniture').map(u=>({id:u.id,placement:u.bbox[1]<pages.get(u.pageIndex).height/2?'header':'footer'}));
  const furnitureIds=new Set(furniture.map(f=>f.id));
  // Edge material before a spanning title and below body is not silently discarded.
  // Require repeated furniture on later pages as evidence of page decoration.
  const repeatedTop=units.some(u=>u.pageIndex>0&&u.kind==='furniture'&&u.bbox[1]<pages.get(u.pageIndex).height*.1);
  const firstWide=firstItems.find(u=>Array.isArray(g)&&u.bbox[0]<g[0]&&u.bbox[2]>g[1]&&u.bbox[1]>first.height*.09);
  function inferEdgeFurniture() {
    if(repeatedTop&&firstWide)for(const u of firstItems)if(u.bbox[3]<firstWide.bbox[1]&&u.bbox[3]<first.height*.1&&!furnitureIds.has(u.id)){furniture.push({id:u.id,placement:'header'});furnitureIds.add(u.id);}
    if(repeatedTop&&firstWide)for(const u of firstItems)if(u.bbox[1]>=first.height*.93&&!furnitureIds.has(u.id)){furniture.push({id:u.id,placement:'footer'});furnitureIds.add(u.id);}
  }
  inferEdgeFurniture();
  const above=bodyTop===null?[]:firstItems.filter(u=>u.bbox[3]<=bodyTop&&!furnitureIds.has(u.id));
  const wide=above.some(u=>u.bbox[0]<g[0]&&u.bbox[2]>g[1]);
  const frontMatter=p.columns===2&&wide?above.map(u=>u.id):[];
  const plan={schema:'falsify.paper-layout-plan.v1',sourcePdfHash:model.sourceSha256,frontMatter,order:units.map(u=>u.id),furniture,columns:p.columns};
  const structure={schema:'falsify.paper-layout-structure.v1',sourcePdfHash:model.sourceSha256,units,plan,frontTopPaddingBp:frontMatter.length?Math.max(0,Math.min(150,units.find(u=>u.id===frontMatter[0]).bbox[1]-headerClearance)):0,groups:[...groups].map(([a,b])=>{const order=plan.order;return order.indexOf(a)<order.indexOf(b)?[a,b]:[b,a];})};
  if(furniture.length)issue('FURNITURE_PLACEMENT_UNVERIFIED');
  function updateBindingOffsets(rendered, base) {
    for(const [id,offset] of rendered.offsets){const b=unitBindings.get(id);if(b){b.binding.start=base+offset+b.start;b.binding.end=base+offset+b.end;}}
  }
  const rendered=renderStructureRegion(structure,plan,unitFragments);const base=source.length;source+=rendered.text;updateBindingOffsets(rendered,base);
  source+='\\end{document}\n';files.unshift({path:'main.tex',bytes:enc.encode(source)});return {files,mainFile:'main.tex',engine:'lualatex',bindings,diagnostics,status,typography:t,structure};
}

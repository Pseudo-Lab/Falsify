import {planReconstructionLayout} from './pdf-latex-layout.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {unicodeActualTextPreamble} from './pdf-latex-unicode.mjs';

const enc = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const png = [137,80,78,71,13,10,26,10];
const fail = code => { throw Object.assign(new Error(code), {code}); };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const dimension = n => Number(n.toFixed(6)).toString();
const escapeMap = {'\\':'\\ensuremath{\\backslash}','{':'\\{','}':'\\}','$':'\\ensuremath{\\$}','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\~{}','^':'\\^{}','-':'{-}','`':'\\char96{}',"'":'\\char39{}'};
// Preserve the original Unicode in editable TeX. Isolated glyph declarations
// do not assert equation semantics; PDF glyph mapping still needs comparison.
const unicodeMacros = {
  ' ':'\\thinspace', ' ':'\\kern.05em', '–':'--',
  '−':'\\ensuremath{-}', '±':'\\ensuremath{\\pm}', 'μ':'\\ensuremath{\\mu}',
  'µ':'\\ensuremath{\\mu}', 'β':'\\ensuremath{\\beta}', '∞':'\\ensuremath{\\infty}',
  '×':'\\ensuremath{\\times}', '°':'\\ensuremath{{}^{\\circ}}', '’':"'",
  '‘':'`', 'ï':'\\"{i}', 'á':"\\'{a}", 'é':"\\'{e}",
  'ó':"\\'{o}", 'ú':"\\'{u}", 'í':"\\'{i}", 'ü':'\\"{u}',
  'ä':'\\"{a}', 'ö':'\\"{o}', 'ñ':'\\~{n}', '©':'\\textcircled{c}',
  'ﬀ':'ff'
};
const unicodePreamble=unicodeActualTextPreamble(unicodeMacros);
function plain(text) {
  let unsupported = false, mapped = false, output = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (escapeMap[ch]) output += escapeMap[ch];
    else if (ch === '\n' || ch === '\r' || ch === '\t') output += ' ';
    else if (cp >= 32 && cp <= 126) output += ch;
    else if (Object.hasOwn(unicodeMacros,ch)) { mapped=true; output+=ch; }
    else { unsupported = true; output += `\\fbox{U+${cp.toString(16).toUpperCase()}}`; }
  }
  return {output,unsupported,mapped};
}
function evidenceValid(ref, hash, pages) {
  return ref && ref.sourceSha256 === hash && Number.isInteger(ref.pageIndex) && pages.has(ref.pageIndex) && ref.frame === 'mupdf-display' && Array.isArray(ref.bbox) && ref.bbox.length === 4 && ref.bbox.every(finite) && ref.bbox[0] <= ref.bbox[2] && ref.bbox[1] <= ref.bbox[3] && (!ref.range || Number.isInteger(ref.range.start) && Number.isInteger(ref.range.end) && ref.range.start >= 0 && ref.range.end >= ref.range.start);
}
function validRefs(refs, hash, pages) { return Array.isArray(refs) && refs.length > 0 && refs.every(r=>evidenceValid(r,hash,pages)); }

// Decisions are explicit baseline transcriptions: {itemId, sourceSha256, tex, evidence}.
// The caller binds the resulting project ID after createLatexProject().
export function serializeReconstruction({model, decisions=[], engine='pdflatex'}={}) {
  if (engine !== 'pdflatex') fail('UNSUPPORTED_ENGINE');
  if (!model || model.schema !== 'falsify.pdf-latex-reconstruction.v1' || !hashPattern.test(model.sourceSha256) || !Array.isArray(model.pages) || !model.pages.length || !Array.isArray(model.items) || !Array.isArray(model.assets) || !Array.isArray(model.diagnostics) || !Array.isArray(model.relations) || !Array.isArray(decisions)) fail('INVALID_MODEL');
  const hash=model.sourceSha256, pages=new Map();
  for (const p of model.pages) {
    if (!p || !Number.isInteger(p.pageIndex) || p.pageIndex !== pages.size || !finite(p.width) || !finite(p.height) || p.width < .01 || p.height < .01 || p.width > 14400 || p.height > 14400 || p.frame !== 'mupdf-display' || !Array.isArray(p.transform) || p.transform.length !== 6 || !p.transform.every(finite)) fail('INVALID_PAGE');
    pages.set(p.pageIndex,p);
  }
  const items=new Map();
  for (const item of model.items) {
    if (!item || typeof item.id !== 'string' || !item.id || !['observed','proposed','confirmed','unsupported'].includes(item.status) || items.has(item.id) || !validRefs(item.evidence,hash,pages) || item.evidence.some(r=>r.pageIndex!==item.evidence[0].pageIndex)) fail('INVALID_ITEM');
    items.set(item.id,item);
  }
  const choices=new Map();
  for (const d of decisions) {
    const item=items.get(d?.itemId);
    if (!item || choices.has(d.itemId) || d.sourceSha256!==hash || typeof d.tex!=='string' || !d.tex.trim() || !validRefs(d.evidence,hash,pages) || JSON.stringify(d.evidence)!==JSON.stringify(item.evidence)) fail('INVALID_DECISION');
    choices.set(d.itemId,d);
  }
  const assets=new Map();
  for (const a of model.assets) {
    if (!a || typeof a.id !== 'string' || !a.id || assets.has(a.id) || !(a.bytes instanceof Uint8Array) || a.mediaType!=='image/png' || !['region-raster','image'].includes(a.representation) || a.editable!==false || !validRefs(a.evidence,hash,pages) || !hashPattern.test(a.sha256) || hex(a.bytes)!==a.sha256 || !png.every((v,i)=>a.bytes[i]===v)) fail('INVALID_ASSET');
    assets.set(a.id,a);
  }
  const diagnostics=model.diagnostics.map(d=>({...d})), bindings=[], files=[];
  let status = diagnostics.some(d=>d.severity==='error') ? 'unsupported' : diagnostics.some(d=>d.severity==='warning') ? 'needs-review' : 'ready';
  const issue=(code,item,severity='warning')=>{diagnostics.push({code,severity,...(item?{itemId:item.id,pageIndex:item.evidence[0].pageIndex}:{})}); if(severity==='error') status='unsupported'; else if(status==='ready') status='needs-review';};
  issue('LAYOUT_OVERFLOW_UNVERIFIED');
  let source='\\documentclass{article}\n\\usepackage{graphicx}\n'+unicodePreamble+'\\pagestyle{empty}\n\\setlength{\\parindent}{0pt}\n\\setlength{\\parskip}{0pt}\n\\begin{document}\n';
  const append=(item, body, bindingStatus)=>{const start=source.length; source+=body; bindings.push({itemId:item.id,projectId:null,path:'main.tex',start,end:source.length,evidence:structuredClone(item.evidence),status:bindingStatus}); source+='\n\n';};
  if (!model.items.length) issue('MISSING_CONTENT',null,'error');
  for (const relation of model.relations) if (relation.status!=='confirmed') issue('RELATION_REVIEW');
  let previousPage=-1;
  for (const item of model.items) {const page=item.evidence[0].pageIndex; if(page<previousPage) issue('PAGE_ORDER_REVIEW',item); previousPage=page;}
  const layout=planReconstructionLayout(model);
  for(const d of layout.diagnostics) {diagnostics.push(d); if(d.severity==='error') status='unsupported'; else if(d.severity==='warning'&&status==='ready') status='needs-review';}
  let assetNumber=0;
  function emitItem(item,p,availableWidth) {
    const index=p.pageIndex;
      const decision=choices.get(item.id);
      if (decision) {append(item,decision.tex,'reviewed'); return;}
      if (item.extensions?.columns > 1) issue('MULTICOLUMN_REVIEW',item);
      if (item.kind==='table' && item.table) {
        const rows=item.table.rows;
        const width=Array.isArray(rows)&&rows[0]?.length;
        const valid=width>0 && rows.every(row=>Array.isArray(row)&&row.length===width&&row.every(c=>c&&typeof c.text==='string'&&(c.colSpan===undefined||c.colSpan===1)&&(c.rowSpan===undefined||c.rowSpan===1)&&validRefs(c.evidence,hash,pages)&&c.evidence.every(r=>r.pageIndex===index)));
        if(valid) {
          const cells=rows.map(row=>row.map(c=>plain(c.text)));
          if(cells.flat().some(c=>c.unsupported)) issue('UNICODE_REVIEW',item);
          if(cells.flat().some(c=>c.mapped)) issue('UNICODE_RENDER_REVIEW',item);
          const original=cells.flat().some(c=>c.unsupported) ? rows.flat().map(c=>'% Original UTF-8 cell: '+c.text.replace(/[\r\n]/g,' ')).join('\n')+'\n' : '';
          append(item,original+'\\begin{tabular}{'+('l'.repeat(width))+'}\n'+cells.map(row=>row.map(c=>c.output).join(' & ')+' \\\\').join('\n')+'\n\\end{tabular}',cells.flat().some(c=>c.mapped||c.unsupported)?'review-required':'reviewed');
          return;
        }
        issue('TABLE_STRUCTURE_REVIEW',item);
      }
      if (item.assetId) {
        const a=assets.get(item.assetId);
        if (!a || a.evidence.some(r=>r.pageIndex!==index)) fail('INVALID_ASSET_REFERENCE');
        const path=`assets/region-${++assetNumber}.png`;
        files.push({path,bytes:a.bytes.slice()});
        const box=a.evidence[0].bbox, w=box[2]-box[0], h=box[3]-box[1];
        if (!(finite(w) && finite(h) && w>=.01 && h>=.01)) fail('INVALID_ASSET_REFERENCE');
        const scale=Math.min(1,availableWidth/w,Math.max(1,p.height-72)/h);
        if (!(w*scale>=.00001 && h*scale>=.00001)) fail('INVALID_ASSET_REFERENCE');
        if (scale<1) issue('REGION_SCALED_DOWN',item);
        append(item,`\\includegraphics[width=${dimension(w*scale)}bp,height=${dimension(h*scale)}bp,keepaspectratio]{${path}}`,'noneditable');
        issue('NONEDITABLE_REGION',item); return;
      }
      const semantic = ['math','footnote','citation'].includes(item.kind) || item.reason==='inline-script-candidate' || !!item.extensions?.candidates?.length;
      if (typeof item.text==='string' && item.text.length) {
        const text=plain(item.text);
        if (text.unsupported) issue('UNICODE_REVIEW',item);
        if (text.mapped) issue('UNICODE_RENDER_REVIEW',item);
        if (/\s{2}|[\r\n\t]/.test(item.text)) issue('TEXT_SPACING_REVIEW',item);
        if (semantic) issue('TRANSCRIPTION_REVIEW',item);
        if (!['paragraph','heading'].includes(item.kind)) issue('ITEM_KIND_REVIEW',item);
        if (item.status==='unsupported') issue('UNSUPPORTED_ITEM',item);
        const original=text.unsupported ? '% Original UTF-8 text: '+item.text.replace(/[\r\n]/g,' ')+'\n' : '';
        let content=item.kind==='heading' ? `\\textbf{${text.output}}` : text.output;
        const styles=item.extensions?.styles, sizes=Array.isArray(styles) ? styles.map(style=>style.size) : [];
        const segments=item.extensions?.segments;
        const covered=Array.isArray(segments) && segments.length && segments.map(s=>s.text).join('')===item.text && segments.every(s=>Array.isArray(s.styleIds) && s.styleIds.length && s.styleIds.every(id=>styles?.some(style=>style.id===id)));
        const typography=item.extensions?.typography;
        const counts=typography?.styleCounts, weights=new Map();
        let countValid=Array.isArray(counts) && counts.length>0;
        if (countValid) for (const entry of counts) {
          const style=styles?.find(s=>s.id===entry.styleId);
          if (!style || !finite(style.size) || !Number.isSafeInteger(entry.count) || entry.count<=0) {countValid=false;break;}
          weights.set(style.size,(weights.get(style.size)||0)+entry.count);
        }
        const ranked=[...weights.entries()].sort((a,b)=>b[1]-a[1]);
        const observedSize=countValid && ranked.length && (!ranked[1]||ranked[0][1]>ranked[1][1]) && ranked[0][0]===typography.fontSizeBp && typography.fontSizeBp>=6 && typography.fontSizeBp<=36 ? typography.fontSizeBp : null;
        const uniformSize=covered && sizes.length && sizes.every(size=>finite(size)&&size>=6&&size<=36&&size===sizes[0]) ? sizes[0] : null;
        const size=observedSize ?? uniformSize;
        if (size) {
          const leading=typography && finite(typography.leadingBp) && typography.leadingBp>=size*.75 && typography.leadingBp<=size*3 && typography.leadingEvidence?.length>=2 && validRefs(typography.leadingEvidence,hash,pages) && typography.leadingEvidence.every(e=>e.pageIndex===index) ? typography.leadingBp : size*1.2;
          issue('LEADING_UNVERIFIED',item);
          content=`\\fontsize{${dimension(size)}bp}{${dimension(leading)}bp}\\selectfont ${content}\\par\\normalsize`;
        }
        const body=original+content;
        append(item,body,text.unsupported||text.mapped?'review-required':'exact-text');
      } else {
        issue('MISSING_CONTENT',item,'error');
        source+=`% Content missing for item ${index + 1}; review source evidence.\n`;
      }
  }
  for (const page of layout.pages) {
    const p=pages.get(page.pageIndex), index=p.pageIndex;
    if(index) source+='\\newpage\n';
    const box=page.bodyBox, left=box?box[0]:36, top=box?box[1]:36;
    const width=box?Math.max(1,box[2]-box[0]):Math.max(1,p.width-72);
    // Furniture is painted at shipout, so it must also limit TeX's body flow.
    // With no footer, keep the unused bottom margin available for font metrics.
    const footerTop=Math.min(p.height,...page.furniture.filter(f=>f.placement==='footer').map(f=>f.bbox[1]));
    const height=Math.max(1,footerTop-top);
    source+=`\\pdfpagewidth=${dimension(p.width)}bp\\pdfpageheight=${dimension(p.height)}bp\n\\setlength{\\textwidth}{${dimension(width)}bp}\\setlength{\\textheight}{${dimension(height)}bp}\\hsize=\\textwidth\\vsize=\\textheight\n\\setlength{\\oddsidemargin}{${dimension(left-72)}bp}\\setlength{\\topmargin}{${dimension(top-72)}bp}\\setlength{\\headheight}{0pt}\\setlength{\\headsep}{0pt}\n`;
    if(!page.bands.length && !page.furniture.length) {issue('EMPTY_PAGE_REVIEW');source+='\\null\n';}
    if(page.furniture.length) {
      source+='\\AddToHookNext{shipout/foreground}{%\n';
      for(const entry of page.furniture){const b=entry.bbox, width=Math.max(1,b[2]-b[0]);source+=`\\put(${dimension(b[0])}bp,${dimension(-b[3])}bp){\\makebox[0pt][l]{\\parbox[t]{${dimension(width)}bp}{%\n`;emitItem(items.get(entry.itemId),p,width);source+='}}}\n';}
      source+='}\n';
      if(!page.bands.length) source+='\\null\n';
    }
    for(const band of page.bands){
      // Target the next source top using actual TeX page height so earlier
      // line-height differences do not accumulate in the gaps. Never move
      // backwards when already over the target; overflow remains reviewable.
      if(band.gapBeforeBp>0) source+=`\\par\\dimen0=${dimension(band.top-top)}bp\\advance\\dimen0 by -\\pagetotal\\ifdim\\dimen0>0pt\\vskip\\dimen0\\nointerlineskip\\fi\n`;
      if(band.kind==='full-width') {for(const id of band.items) emitItem(items.get(id),p,width);continue;}
      const leftWidth=band.leftBox[2]-band.leftBox[0],rightWidth=band.rightBox[2]-band.rightBox[0],gap=band.rightBox[0]-band.leftBox[2];
      source+=`\\noindent\\hspace*{${dimension(Math.max(0,band.leftBox[0]-left))}bp}\\begin{minipage}[t]{${dimension(leftWidth)}bp}\n`;
      const emitColumn=(ids,columnWidth)=>{
        let bottom=band.top;
        for(const id of ids){
          const item=items.get(id), top=Math.min(...item.evidence.map(e=>e.bbox[1]));
          const gap=Math.max(0,top-bottom);
          if(gap>0) source+=`\\vspace*{${dimension(gap)}bp}\n`;
          emitItem(item,p,columnWidth);
          bottom=Math.max(bottom,...item.evidence.map(e=>e.bbox[3]));
        }
      };
      emitColumn(band.left,leftWidth);
      source+=`\\end{minipage}\\hspace{${dimension(gap)}bp}\\begin{minipage}[t]{${dimension(rightWidth)}bp}\n`;
      emitColumn(band.right,rightWidth);
      source+='\\end{minipage}\\par\n';
    }
  }
  source+='\\end{document}\n';
  files.unshift({path:'main.tex',bytes:enc.encode(source)});
  return {status,files,mainFile:'main.tex',bindings,diagnostics};
}

/* Bounded source-stream edit. The caller supplies glyphs previously selected from
 * MuPDF structured text in PDF user coordinates; unsupported inputs return null. */
import {parseFont} from './browser-fonts.mjs';

const enc = new TextEncoder();
const near = (a,b) => Number.isFinite(a) && Math.abs(a-b) < 0.025;
const hex = n => n.toString(16).padStart(4,'0').toUpperCase();
function cmapByte(cmap, byte) {
  // Only accept explicit one-byte bfchar or scalar bfrange mappings. Reject
  // duplicates; array destinations, usecmap and multi-code-unit mappings fail.
  if (/\busecmap\b/.test(cmap)) return null;
  const matches = [];
  for (const section of cmap.matchAll(/\d+\s+beginbfchar\b([\s\S]*?)endbfchar/g))
    for (const m of section[1].matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g))
      if (parseInt(m[1],16) === byte) matches.push(parseInt(m[2],16));
  for (const section of cmap.matchAll(/\d+\s+beginbfrange\b([\s\S]*?)endbfrange/g))
    for (const m of section[1].matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g)) {
      const lo=parseInt(m[1],16), hi=parseInt(m[2],16);
      if (byte>=lo && byte<=hi) matches.push(parseInt(m[3],16)+byte-lo);
    }
  return matches.length === 1 ? matches[0] : null;
}
function copyDict(doc, dict) {
  const copy=doc.newDictionary();
  if (!dict.isNull()) dict.resolve().forEach((v,k) => copy.put(k,v));
  return copy;
}
function readStream(obj) { const b=obj.readStream(); try { return b.asUint8Array().slice(); } finally { b.destroy(); } }
const text = bytes => new TextDecoder('latin1').decode(bytes);
function pageGlyphs(page, mupdf) {
  const matrix=mupdf.Matrix.invert(page.getTransform()), result=[];
  const structured=page.toStructuredText('preserve-whitespace');
  try { structured.walk({onChar(c,o,f,size,quad) {
    result.push({c, fontName:f.getName(), size, pdf:[o[0]*matrix[0]+o[1]*matrix[2]+matrix[4],o[0]*matrix[1]+o[1]*matrix[3]+matrix[5]],quad:[...quad]});
  }}); } finally { structured.destroy(); }
  return result;
}
function glyphEquals(a,b) {
  return a.c===b.c && a.fontName===b.fontName && near(a.size,b.size) && near(a.pdf?.[0],b.pdf?.[0]) && near(a.pdf?.[1],b.pdf?.[1]);
}
function verifyResult(original, edited, selected, replacement, mupdf) {
  const a=pageGlyphs(original, mupdf), b=pageGlyphs(edited, mupdf);
  const hits=[];
  for (let i=0;i<=a.length-selected.length;i++) if (selected.every((g,j)=>glyphEquals(g,a[i+j]))) hits.push(i);
  if (hits.length!==1 || a.length!==b.length) return null;
  const at=hits[0]+selected.length-1;
  if (!a.every((g,i)=>i===at ? b[i].c===replacement && near(g.pdf[0],b[i].pdf[0]) && near(g.pdf[1],b[i].pdf[1]) && near(g.size,b[i].size) : glyphEquals(g,b[i]))) return null;
  const bounds=[...a[at].quad,...b[at].quad], xs=bounds.filter((_,i)=>i%2===0), ys=bounds.filter((_,i)=>i%2===1);
  const pixA=original.toPixmap([2,0,0,2,0,0],mupdf.ColorSpace.DeviceRGB,false);
  let pixB;
  try {
    pixB=edited.toPixmap([2,0,0,2,0,0],mupdf.ColorSpace.DeviceRGB,false);
    if (pixA.getWidth()!==pixB.getWidth() || pixA.getHeight()!==pixB.getHeight() || pixA.getX()!==pixB.getX() || pixA.getY()!==pixB.getY() || pixA.getWidth()*pixA.getHeight()>50000000) return null;
    const x0=Math.floor(Math.min(...xs)*2)-pixA.getX()-2, x1=Math.ceil(Math.max(...xs)*2)-pixA.getX()+2, y0=Math.floor(Math.min(...ys)*2)-pixA.getY()-2, y1=Math.ceil(Math.max(...ys)*2)-pixA.getY()+2;
    const pa=pixA.getPixels(), pb=pixB.getPixels(), width=pixA.getWidth(); let changed=0;
    for (let i=0;i<pa.length;i+=3) if (pa[i]!==pb[i] || pa[i+1]!==pb[i+1] || pa[i+2]!==pb[i+2]) {
      const n=i/3, x=n%width, y=Math.floor(n/width); if (x<x0 || x>x1 || y<y0 || y>y1) return null; changed++;
    }
    return changed || null;
  } finally { pixA.destroy(); pixB?.destroy(); }
}
function sourceMapping(font, bytes) {
  if (font.get('Subtype').asName() !== 'Type1') return null;
  const map=font.get('ToUnicode');
  if (!map.isStream()) return null;
  const cmap=text(readStream(map));
  return [...bytes].map(b => cmapByte(cmap,b));
}
async function validatedFace(snapshot, name) {
  if (!snapshot || !Array.isArray(snapshot.fonts) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return null;
  const digest = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if (await digest(enc.encode(JSON.stringify(snapshot.fonts.map(({bytes,...meta})=>meta)))) !== snapshot.digest?.toLowerCase()) return null;
  for (const f of snapshot.fonts) {
    if (!(f.bytes instanceof Uint8Array) || typeof f.sha256 !== 'string' || await digest(f.bytes) !== f.sha256.toLowerCase()) return null;
    let p; try { p=parseFont(f.bytes); } catch { return null; }
    if (typeof f.id !== 'string' || !['local','file','bundled'].includes(f.source) || ['family','postscriptName','weight','italic','fsType'].some(k=>f[k]!==p[k])) return null;
  }
  return snapshot.fonts.find(f => f.postscriptName === name) || null;
}
/** `glyphs`: selected complete source show, each {c,pdf:[x,y],fontName,size}.
 * Exactly the last character may change; scanTextShows is the parser API. */
export async function replaceMarkerGlyph({bytes,pageIndex,glyphs,after,fontSnapshot,fontPostscriptName,scanTextShows,mupdf}) {
  if (!mupdf || !(bytes instanceof Uint8Array) || !Number.isInteger(pageIndex) || !Array.isArray(glyphs) || !glyphs.length || typeof after !== 'string' || [...after].length !== glyphs.length || typeof scanTextShows !== 'function') return null;
  bytes=bytes.slice(); glyphs=glyphs.map(g=>({...g,pdf:Array.isArray(g?.pdf) ? [...g.pdf] : null}));
  const before=glyphs.map(g=>g.c).join(''), chars=[...after];
  if ([...before].length!==glyphs.length || chars.slice(0,-1).join('')!==before.slice(0,-1) || chars.at(-1)===glyphs.at(-1).c || chars.at(-1).codePointAt(0)>0xffff) return null;
  if (!Array.isArray(fontSnapshot?.fonts) || fontSnapshot.fonts.some(f=>!(f?.bytes instanceof Uint8Array))) return null;
  const captured={...fontSnapshot,fonts:fontSnapshot.fonts.map(f=>({...f,bytes:f.bytes.slice()}))};
  const face=await validatedFace(captured,fontPostscriptName); if (!face) return null;
  let doc, font, saved, check, page;
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF();
    if (!doc || doc.needsPassword() || pageIndex<0 || pageIndex>=doc.countPages()) return null;
    page=doc.loadPage(pageIndex); const obj=page.getObject();
    if (obj.getInheritable('Rotate').asNumber() % 360 !== 0) return null;
    const contents=obj.get('Contents');
    const streams=contents.isArray() ? Array.from({length:contents.length},(_,i)=>contents.get(i)) : [contents];
    if (streams.some(s=>!s.isStream())) return null;
    const resources=obj.getInheritable('Resources'), fontDict=resources.get('Font');
    const candidates=[];
    for (let si=0;si<streams.length;si++) {
      const raw=readStream(streams[si]), parsed=scanTextShows(raw);
      if (!parsed || parsed.diagnostics?.length) return null;
      for (const show of parsed.shows) {
        if (show.uncertain || !['Tj','TJ'].includes(show.kind) || show.renderMode!==0 || show.parts.length!==1 || show.parts[0].type!=='string' || !show.textMatrix || !show.ctm) continue;
        const tm=show.textMatrix, cm=show.ctm;
        if (![tm[0],tm[3],cm[0],cm[3]].every(n=>near(n,1)) || ![tm[1],tm[2],cm[1],cm[2]].every(n=>near(n,0))) continue;
        if (!/^[A-Za-z0-9_.-]+$/.test(show.fontName)) continue;
        const p=show.parts[0], source=fontDict.get(show.fontName), mapping=sourceMapping(source,p.bytes);
        if (source.get('BaseFont').asName()!==glyphs[0].fontName) continue;
        if (!mapping || mapping.length!==glyphs.length || mapping.some((v,i)=>v!==glyphs[i].c.codePointAt(0))) continue;
        if (!near(tm[4]+cm[4],glyphs[0].pdf?.[0]) || !near(tm[5]+cm[5]+show.rise,glyphs[0].pdf?.[1]) || !near(show.fontSize,glyphs[0].size)) continue;
        // Confirm every byte's origin from the source font's widths and text state.
        let x=glyphs[0].pdf[0], ok=true; const first=source.get('FirstChar').asNumber(), widths=source.get('Widths');
        for (let i=0;i<p.bytes.length;i++) {
          const g=glyphs[i], wi=p.bytes[i]-first, width=widths.get(wi);
          if (!near(g.pdf?.[0],x) || !near(g.pdf?.[1],glyphs[0].pdf[1]) || g.fontName!==glyphs[0].fontName || !near(g.size,show.fontSize) || wi<0 || wi>=widths.length || !width.isNumber()) { ok=false; break; }
          x += (width.asNumber()/1000*show.fontSize + show.charSpace + (p.bytes[i]===32 ? show.wordSpace : 0))*show.hScale/100;
        }
        if (ok) candidates.push({si,raw,show,p});
      }
    }
    if (candidates.length!==1) return null;
    const {si,raw,show,p}=candidates[0];
    font=new mupdf.Font(face.postscriptName || face.family,face.bytes);
    const gid=font.encodeCharacter(chars.at(-1).codePointAt(0)); if (!gid || gid>65535) return null;
    const newResources=copyDict(doc,resources), newFonts=copyDict(doc,fontDict);
    let name='F'+face.sha256.slice(0,12); while (!newFonts.get(name).isNull()) name+='x';
    const pdfFont=doc.addFont(font), cmap=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Unicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<${hex(gid)}> <${hex(chars.at(-1).codePointAt(0))}>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
    pdfFont.put('ToUnicode',doc.addStream(enc.encode(cmap),{})); newFonts.put(name,pdfFont); newResources.put('Font',newFonts); obj.put('Resources',newResources);
    const prefix=[...p.bytes.slice(0,-1)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const replacement=`<${prefix}> Tj /${name} ${show.fontSize} Tf <${hex(gid)}> Tj /${show.fontName} ${show.fontSize} Tf`;
    const repl=enc.encode(replacement), out=new Uint8Array(show.start+repl.length+raw.length-show.end);
    out.set(raw.slice(0,show.start)); out.set(repl,show.start); out.set(raw.slice(show.end),show.start+repl.length);
    const stream=doc.addStream(out,{});
    if (contents.isArray()) { const a=doc.newArray(); streams.forEach((s,i)=>a.push(i===si?stream:s)); obj.put('Contents',a); } else obj.put('Contents',stream);
    saved=doc.saveToBuffer(''); const result=saved.asUint8Array().slice();
    check=new mupdf.PDFDocument(result);
    const originalDoc=new mupdf.PDFDocument(bytes);
    let changed, originalPage, checkPage; try { originalPage=originalDoc.loadPage(pageIndex); checkPage=check.loadPage(pageIndex); changed=verifyResult(originalPage,checkPage,glyphs,chars.at(-1),mupdf); } finally { originalPage?.destroy(); checkPage?.destroy(); originalDoc.destroy(); }
    if (!changed) return null;
    return {bytes:result,report:{method:'source-stream-marker',pageIndex,sourceFont:show.fontName,font:face.postscriptName,changedPixels:changed}};
  } catch { return null; } finally { check?.destroy(); saved?.destroy(); font?.destroy(); page?.destroy(); doc?.destroy(); }
}

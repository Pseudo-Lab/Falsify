import * as mupdf from 'mupdf';

// Match the reader's character geometry to a single native paint operation.
export function readSourceGlyphs({bytes, document, changes = new Map()}) {
  const styles = new Map((document.styles || []).map(s=>[s.id,s]));
  const targets = [];
  for (const block of document.blocks) for (const c of block.source?.characters || []) {
    const start=c.start-block.source.range.start, end=c.end-block.source.range.start;
    const value=block.text.slice(start,end), cp=value.codePointAt(0);
    if (!(value.length===1 && (cp===0xfffd || cp<32 && cp!==9 && cp!==10 && cp!==13 || cp===127 || cp>=0xd800 && cp<=0xdfff))) continue;
    if ((changes.get(block.id)||[]).some(e=>start<e.end && end>e.start)) continue;
    const line=(block.source.lines||[]).find(l=>l.range.start<=c.start && l.range.end>=c.end);
    targets.push({blockId:block.id,pageIndex:block.source.pageIndex,start:c.start,end:c.end,bbox:c.bbox,font:styles.get(c.styleId)?.fontName,baseline:line?.baseline?.[0]?.[1], matches:[]});
  }
  if (!targets.length) return {glyphs:[], unavailable:[]};
  let doc, failure;
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf');
    for (const pageIndex of new Set(targets.map(t=>t.pageIndex))) {
      const page=doc.loadPage(pageIndex);
      const dev=new mupdf.Device({fillText(text,ctm,cs,color,alpha) {
        try {text.walk({showGlyph(font,trm,gid,scalar,wmode) {
          try {
            if (!(scalar===0xfffd || scalar<32 || scalar===127 || scalar>=0xd800 && scalar<=0xdfff || scalar>0x10ffff)) return;
            const matrix=mupdf.Matrix.concat(trm,ctm), name=font.getName();
            for (const target of targets) {
              const b=target.bbox;
              if (target.pageIndex!==pageIndex || target.font!==name || !b || !Number.isFinite(target.baseline) || !matrix.every(Number.isFinite) || Math.abs(matrix[4]-b[0])>0.05 || matrix[5]<b[1]-0.05 || matrix[5]>b[3]+0.05 || wmode!==0 || Math.abs(matrix[1])>0.001 || Math.abs(matrix[2])>0.001 || matrix[0]<=0 || matrix[3]>=0) continue;
              const glyph=new mupdf.Text(); let buffer,writer,out;
              try {
                glyph.showGlyph(font,trm,gid,scalar,wmode);
                const ink=glyph.getBounds(null,ctm), width=ink[2]-ink[0], height=ink[3]-ink[1];
                const advance=font.advanceGlyph(gid,wmode)*Math.hypot(matrix[0],matrix[1]);
                if (!ink.every(Number.isFinite) || width<=0 || height<=0 || advance<=0) continue;
                buffer=new mupdf.Buffer(); writer=new mupdf.DocumentWriter(buffer,'svg',''); out=writer.beginPage([0,0,width,height]);
                out.fillText(glyph,mupdf.Matrix.concat(ctm,[1,0,0,1,-ink[0],-ink[1]]),cs,color,alpha);
                writer.endPage(); writer.close();
                target.matches.push({gid,scalar,trm:[...trm],ctm:[...ctm],ink,origin:[matrix[4],matrix[5]],width,height,advance,baselineShift:ink[3]-target.baseline,offsetX:ink[0]-matrix[4],bytes:new Uint8Array(buffer.asUint8Array())});
              } finally {out?.destroy();writer?.destroy();buffer?.destroy();glyph.destroy();}
            }
          } finally {font.destroy();}
        }}); } finally {text.destroy();cs?.destroy();}
      }});
      try {page.run(dev,mupdf.Matrix.identity);dev.close();} finally {dev.destroy();page.destroy();}
    }
  } catch(error) {failure=String(error?.message || error);}
  finally {doc?.destroy();}
  const glyphs=[],unavailable=[];
  for(const {matches,...target} of targets) {
    const shared=matches.length===1 && targets.some(other=>other!==targets.find(t=>t.matches===matches) && other.pageIndex===target.pageIndex && other.matches.some(m=>JSON.stringify(m.ctm)===JSON.stringify(matches[0].ctm) && JSON.stringify(m.trm)===JSON.stringify(matches[0].trm) && m.gid===matches[0].gid));
    if(!failure && matches.length===1 && !shared) glyphs.push({...target,...matches[0]});
    else unavailable.push({...target,reason:failure?'paint-read-failed':matches.length||shared?'ambiguous-paint-match':'no-paint-match',...(failure?{detail:failure}:{})});
  }
  return {glyphs,unavailable};
}

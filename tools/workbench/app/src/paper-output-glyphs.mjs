// Read encoded Unicode glyphs in paint order, preserving origins and page numbers.
// The caller supplies the already loaded MuPDF module.
export function readOutputGlyphs({bytes, mupdf}) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pages = [];
  try {
    for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex++) {
      const page = doc.loadPage(pageIndex), glyphs = [];
      let failed = false;
      const collect = (text, ctm, resources) => {
        try {
          text.walk({showGlyph(font, trm, gid, scalar) {
            try {
              const matrix = mupdf.Matrix.concat(trm, ctm);
              if (!Number.isInteger(scalar) || scalar <= 0 || scalar === 0xfffd || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff) || !matrix.every(Number.isFinite)) failed = true;
              else glyphs.push({scalar, origin:[matrix[4], matrix[5]], pageIndex});
            } catch { failed = true; } finally { font.destroy(); }
          }});
        } catch { failed = true; } finally { text.destroy(); for (const resource of resources) resource?.destroy(); }
      };
      const dev = new mupdf.Device({
        fillText(text, ctm, cs) { collect(text, ctm, [cs]); },
        strokeText(text, stroke, ctm, cs) { collect(text, ctm, [stroke, cs]); }
      });
      try { page.run(dev, mupdf.Matrix.identity); dev.close(); }
      catch { failed = true; }
      finally { dev.destroy(); page.destroy(); }
      pages.push(failed ? null : glyphs);
    }
  } finally { doc.destroy(); }
  return pages;
}

import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) { const e = new Error('Source asset reading cancelled'); e.name = 'AbortError'; throw e; } };
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];

// Resource identities are page/path scoped; equal names alone do not establish a match.
function collectFonts(resources, pageIndex, path, fonts, seen, ancestors = new Set()) {
  if (!resources || resources.isNull()) return;
  const dict = resources.get('Font');
  if (dict.isDictionary()) dict.forEach((ref, name) => {
    const obj = ref.resolve(), descendants = obj.get('DescendantFonts');
    const descendant = descendants.isArray() && descendants.length ? descendants.get(0) : null;
    const descriptor = (descendant && !descendant.isNull() ? descendant : obj).get('FontDescriptor');
    const baseName = obj.get('BaseFont').asName() || null;
    const identity = {pageIndex, resourcePath:`${path}/Font/${name}`, objectNumber:ref.isIndirect() ? ref.asIndirect() : null};
    const key = `${pageIndex}:${identity.resourcePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    let bytes = null, format = null;
    for (const field of ['FontFile','FontFile2','FontFile3']) {
      const stream = descriptor.isNull() ? null : descriptor.get(field);
      if (stream?.isStream()) { const buffer = stream.readStream(); try { bytes = buffer.asUint8Array().slice(); } finally { buffer.destroy(); } format = field; break; }
    }
    fonts.push({id:`font-${hex(new TextEncoder().encode(JSON.stringify(identity))).slice(0,24)}`, family:baseName, source:identity, bytes, format, subtype:obj.get('Subtype').asName() || null, flags:!descriptor.isNull() && descriptor.get('Flags').isNumber() ? descriptor.get('Flags').asNumber() : null, embedded:!!bytes, embeddingPermissions:'unknown', subset:!!baseName && /^[A-Z]{6}\+/.test(baseName), coverage:'unverified'});
  });
  const xobjects = resources.get('XObject');
  if (xobjects.isDictionary()) xobjects.forEach((ref, name) => {
    const key = ref.isIndirect() ? ref.asIndirect() : null;
    if (key !== null && ancestors.has(key)) return;
    const obj = ref.resolve();
    if (obj.get('Subtype').asName() !== 'Form') return;
    const next = new Set(ancestors); if (key !== null) next.add(key);
    collectFonts(obj.get('Resources'), pageIndex, `${path}/XObject/${name}/Resources`, fonts, seen, next);
  });
}

/** Extract source-bound page crops and PDF font resources. Boxes use MuPDF display coordinates. */
export async function readSourceAssets({bytes, document, regions=[], signal}={}) {
  abort(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document || !Array.isArray(regions)) throw new TypeError('Expected source bytes, document and regions');
  const snapshot = Uint8Array.from(bytes), sourceSha256 = hex(snapshot);
  document = structuredClone(document); regions = structuredClone(regions);
  if (document.sourceSha256 !== sourceSha256) throw new Error('Source hash mismatch');
  const assets = document.assets || [], fonts=[], diagnostics=[], drawings=[];
  const ids = new Set(), occurrences = new Set();
  for (const asset of assets) {
    if (!asset.id || ids.has(asset.id)) throw new Error(`Duplicate or missing asset ID: ${asset.id}`);
    ids.add(asset.id);
    if (asset.source?.occurrence != null) { const key = `${asset.source.pageIndex}:${asset.source.occurrence}`; if (occurrences.has(key)) throw new Error(`Duplicate asset occurrence: ${key}`); occurrences.add(key); }
  }
  for (const region of regions) { if (!region?.id || ids.has(region.id)) throw new Error(`Duplicate or missing region ID: ${region?.id}`); ids.add(region.id); }
  for (const block of document.blocks || []) { const r = block.source?.range; if (r && (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end < r.start || typeof block.text !== 'string' || r.end-r.start !== block.text.length || document.pages?.[block.source.pageIndex]?.text?.slice(r.start,r.end) !== block.text)) throw new Error(`Unsafe source range for block: ${block.id}`); }
  let pdf;
  try {
    pdf = mupdf.Document.openDocument(snapshot, 'application/pdf').asPDF();
    if (!pdf || pdf.needsPassword()) throw new Error('Unsupported PDF');
    const seen = new Set();
    for (let i=0; i<pdf.countPages(); i++) {
      abort(signal);
      const page = pdf.loadPage(i);
      try {
        collectFonts(page.getObject().getInheritable('Resources'), i, 'Resources', fonts, seen);
        const dev = new mupdf.Device({
          fillPath(path, evenOdd, ctm, colorspace) { try { drawings.push({pageIndex:i,bbox:path.getBounds(null,ctm),operation:'fill'}); } finally { path.destroy(); colorspace.destroy(); } },
          strokePath(path, stroke, ctm, colorspace) { try { drawings.push({pageIndex:i,bbox:path.getBounds(stroke,ctm),operation:'stroke'}); } finally { path.destroy(); stroke.destroy(); colorspace.destroy(); } }
        });
        try { page.run(dev,mupdf.Matrix.identity); dev.close(); } finally { dev.destroy(); }
      } finally { page.destroy(); }
    }
    for (const region of regions) {
      abort(signal);
      if (!region || typeof region.id !== 'string' || !region.id || !Number.isInteger(region.pageIndex) || region.pageIndex<0 || region.pageIndex>=pdf.countPages() || !validBox(region.bbox) || !Array.isArray(region.blockIds)) throw new TypeError('Invalid source region');
      const page = pdf.loadPage(region.pageIndex); let device, pixmap;
      try {
        const bounds = page.getBounds(), b = region.bbox;
        if (b[0]<bounds[0] || b[1]<bounds[1] || b[2]>bounds[2] || b[3]>bounds[3]) throw new RangeError('Region outside source page');
        // A bounded draw device retains PDF clip, mask and blend semantics while emitting
        // only crop pixels. The SVG is a portable container for this 216 dpi raster.
        const scale=3, width=b[2]-b[0], height=b[3]-b[1];
        const pw=Math.ceil(width*scale), ph=Math.ceil(height*scale);
        if (pw*ph > 100000000) throw new RangeError('Region raster exceeds 100 million pixels');
        pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,pw,ph],true); pixmap.clear();
        device = new mupdf.DrawDevice(mupdf.Matrix.identity,pixmap);
        page.run(device,[scale,0,0,scale,-b[0]*scale,-b[1]*scale]); device.close(); device.destroy(); device=null;
        const png=pixmap.asPNG(); let binary='';
        for (let i=0;i<png.length;i+=32768) binary+=String.fromCharCode(...png.subarray(i,i+32768));
        const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${pw/scale}" height="${ph/scale}" href="data:image/png;base64,${btoa(binary)}"/></svg>`;
        assets.push({id:region.id,kind:'region',source:{pageIndex:region.pageIndex,bbox:[...b],blockIds:[...region.blockIds],assetIds:[...(region.assetIds || [])]},content:{representation:'mupdf-cropped-svg',encoding:'raster-png',dpi:216,bytes:new TextEncoder().encode(svg),width,height}});
      } finally { device?.destroy(); pixmap?.destroy(); page.destroy(); }
    }
  } finally { pdf?.destroy(); }
  return {sourceSha256,assets,fonts,drawings,diagnostics};
}

/* BLUE visual evidence from the exact selected PDF. Coordinates are PDF.js viewport
   pixels at scale 1, after the page's intrinsic rotation. Never reduce resolution to
   make a selection fit: oversized pages/regions fail explicitly. */
import {defaultImport, pdfParams, MAX_BYTES} from './document-preview.js';

const HEX = /^[0-9a-f]{64}$/;
const SCALE = 2, MAX_SIDE = 4096, MAX_PIXELS = 8000000, MAX_IMAGE_BYTES = 524288, MAX_COUNT = 2;
const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const hash = async (bytes, subtle) => hex(await subtle.digest('SHA-256', bytes));

export async function renderBlueVisuals({file, fileHash, sourceHash, selections, baseURI=globalThis.document?.baseURI,
  importPdf=defaultImport, subtle=globalThis.crypto.subtle, document=globalThis.document}) {
  if (!file || !HEX.test(fileHash) || !HEX.test(sourceHash) || !Array.isArray(selections) ||
      !selections.length || selections.length > MAX_COUNT || !(file.size > 0 && file.size <= MAX_BYTES)) throw new Error('visual_input_invalid');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || await hash(bytes, subtle) !== fileHash) throw new Error('visual_file_hash_mismatch');
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('visual_not_pdf');
  const lib = await importPdf();
  if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', baseURI).href;
  const task = lib.getDocument(pdfParams(bytes, baseURI));
  try {
    const pdf = await task.promise, out = [];
    for (const selection of selections) {
      if (!selection || Object.keys(selection).some(k => !['page','bbox'].includes(k)) ||
          !Number.isSafeInteger(selection.page) || selection.page < 1 || selection.page > pdf.numPages ||
          !Array.isArray(selection.bbox) || selection.bbox.length !== 4 || !selection.bbox.every(Number.isFinite)) throw new Error('visual_selection_invalid');
      const page = await pdf.getPage(selection.page);
      try {
        const v = page.getViewport({scale: 1}), [x,y,w,h] = selection.bbox;
        if (!(x >= 0 && y >= 0 && w > 0 && h > 0 && x+w <= v.width && y+h <= v.height)) throw new Error('visual_bbox_out_of_bounds');
        const width = Math.ceil(w*SCALE), height = Math.ceil(h*SCALE);
        if (width > MAX_SIDE || height > MAX_SIDE || width*height > MAX_PIXELS) throw new Error('visual_resolution_limit');
        const canvas = document.createElement('canvas'); canvas.width=width; canvas.height=height;
        try {
          const context=canvas.getContext('2d'); if (!context) throw new Error('visual_canvas_unavailable');
          await page.render({canvasContext:context,canvas,viewport:page.getViewport({scale:SCALE}),transform:[1,0,0,1,-x*SCALE,-y*SCALE]}).promise;
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          if (!blob || blob.type !== 'image/png' || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('visual_bytes_limit');
          const image = new Uint8Array(await blob.arrayBuffer());
          let binary=''; for (let i=0;i<image.length;i+=32768) binary+=String.fromCharCode(...image.subarray(i,i+32768));
          out.push({fileHash,sourceHash,page:selection.page,bbox:[x,y,w,h],rotation:v.rotation,width,height,
                    mime:'image/png',sha256:await hash(image,subtle),base64:btoa(binary)});
        } finally {canvas.width=0;canvas.height=0;}
      } finally {page.cleanup();}
    }
    return out;
  } finally {await task.destroy();}
}

// Preview uses the same local PDF.js and verified source bytes; it is not evidence.
export async function previewBluePage({file,fileHash,page=1,baseURI=globalThis.document.baseURI,importPdf=defaultImport,subtle=globalThis.crypto.subtle,document=globalThis.document}) {
  if(!file || !HEX.test(fileHash) || !(file.size>0 && file.size<=MAX_BYTES)) throw new Error('visual_input_invalid');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size || await hash(bytes,subtle)!==fileHash)throw new Error('visual_file_hash_mismatch');
  if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw new Error('visual_not_pdf');
  const lib=await importPdf();if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',baseURI).href;
  const task=lib.getDocument(pdfParams(bytes,baseURI));
  try {const pdf=await task.promise;if(!Number.isSafeInteger(page)||page<1||page>pdf.numPages)throw new Error('visual_selection_invalid');
    const p=await pdf.getPage(page);try {const v=p.getViewport({scale:1}),scale=Math.min(1,600/v.width,700/v.height);
      if(!Number.isFinite(scale)||scale<=0)throw new Error('visual_selection_invalid');
      const canvas=document.createElement('canvas'),display=p.getViewport({scale});canvas.width=Math.ceil(display.width);canvas.height=Math.ceil(display.height);
      await p.render({canvasContext:canvas.getContext('2d'),canvas,viewport:display}).promise;
      return {canvas,page,pages:pdf.numPages,width:v.width,height:v.height,wholeFits:Math.ceil(v.width*SCALE)<=MAX_SIDE&&Math.ceil(v.height*SCALE)<=MAX_SIDE&&Math.ceil(v.width*SCALE)*Math.ceil(v.height*SCALE)<=MAX_PIXELS};
    } finally {p.cleanup();}
  } finally {await task.destroy();}
}

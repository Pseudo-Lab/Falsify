const engineUrl = new URL('./browser-pdf.mjs', import.meta.url);
engineUrl.search = new URL(import.meta.url).search;
const {prepare} = await import(engineUrl.href);

self.onmessage = async (event) => {
  const data = event.data || {};
  const id = data.id;
  try {
    const owned = new Uint8Array(data.bytes);
    const result = await prepare({
      file: {name: data.name || 'document.pdf', bytes: owned, type: data.type || 'application/pdf'},
      edits: data.edits,
      fileHash: data.fileHash || '',
    });
    const out = new Uint8Array(await result.file.arrayBuffer());
    const copy = new ArrayBuffer(out.byteLength);
    new Uint8Array(copy).set(out);
    self.postMessage({
      id,
      ok: true,
      name: result.file.name,
      type: result.file.type,
      sha256: result.sha256,
      verification: result.verification,
      pageMap: result.pageMap,
      warnings: result.warnings,
      bytes: copy,
    }, [copy]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error && error.name || 'Error',
        message: String(error && error.message || 'engine'),
        code: error && error.code || 'engine',
        details: error && error.details || {},
      },
    });
  }
};
self.postMessage({ready: true});

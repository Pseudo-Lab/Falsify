// PdfEngine.create() is deliberately not used: runtime.mjs initializes the
// verified local module and library and invokes the original constructor.
export const ENGINE_BUILD = 'falsify-pdfium-local-cf9f0e9e';
export function createEngineModule() { throw new Error('Use verified paragraph runtime factory'); }

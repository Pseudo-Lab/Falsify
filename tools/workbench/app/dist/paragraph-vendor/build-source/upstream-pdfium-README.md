<div align="center">
  <a href="https://wwww.embedpdf.com">
    <img alt="EmbedPDF logo" src="https://www.embedpdf.com/logo-192.png" height="96">
  </a>
  <h1>EmbedPDF</h1>

<a href="https://www.npmjs.com/package/@embedpdf/pdfium"><img alt="NPM version" src="https://img.shields.io/npm/v/@embedpdf/pdfium.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/pdfium/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@embedpdf/pdfium.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/embedpdf/embed-pdf-viewer/discussions"><img alt="Join the community on GitHub" src="https://img.shields.io/badge/Join%20the%20community-blueviolet.svg?style=for-the-badge&labelColor=000000"></a>

</div>

# @embedpdf/pdfium

PDFium WebAssembly for the web platform. This package provides a powerful JavaScript interface to PDFium, enabling high-quality PDF rendering and manipulation directly in web applications.

## Documentation

For complete documentation, examples, and API reference, please visit:

**[Official Documentation](https://www.embedpdf.com/docs/pdfium/introduction)**

## What is PDFium?

PDFium is an open-source PDF rendering engine originally developed by Foxit Software and later released as open source by Google. Written in C++, it's the same engine that powers PDF viewing in Chrome and numerous other applications. This package brings native-quality PDF capabilities to the browser through WebAssembly, without requiring any server-side processing.

## Features

- High-fidelity rendering of PDF pages
- Text extraction and search
- Form filling and manipulation
- Annotation support
- Digital signature verification
- PDF modification and creation

## Installation

```bash
# npm
npm install @embedpdf/pdfium

# pnpm
pnpm add @embedpdf/pdfium

# yarn
yarn add @embedpdf/pdfium

# bun
bun add @embedpdf/pdfium
```

## Basic Usage

```javascript
import { init, WrappedPdfiumModule } from '@embedpdf/pdfium';

const pdfiumWasm =
  'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium/dist/pdfium.wasm';

let pdfiumInstance = null;

async function initializePdfium() {
  if (pdfiumInstance) return pdfiumInstance;

  const response = await fetch(pdfiumWasm);
  const wasmBinary = await response.arrayBuffer();
  pdfiumInstance = await init({ wasmBinary });

  // Initialize the PDFium extension library
  // This is required before performing any PDF operations
  pdfiumInstance.PDFiumExt_Init();

  return pdfiumInstance;
}

// Usage
async function renderPdf() {
  const pdfium = await initializePdfium();
  // Use pdfium to load and render PDFs
  // See documentation for detailed examples
}
```

## Learn More

Check out our comprehensive documentation at [embedpdf.com/docs/pdfium](https://www.embedpdf.com/docs/pdfium/introduction) for:

- Detailed API reference
- Code examples
- Best practices
- Advanced usage

## License

This package is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

It also bundles [PDFium](https://pdfium.googlesource.com/pdfium/) in WebAssembly form,  
which is licensed under the [Apache License, Version 2.0](LICENSE.pdfium).  

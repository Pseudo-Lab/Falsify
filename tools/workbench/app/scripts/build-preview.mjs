import {build} from 'esbuild';
// Final-PDF preview bundle; PDF.js stays the already vendored dist/vendor copy (see build-import.mjs), loaded lazily on first preview.
await build({entryPoints:['src/document-preview.js'],outfile:'dist/document-preview.js',bundle:true,format:'iife',globalName:'FalsifyPreview',target:'es2022',minify:true,legalComments:'eof',external:['./vendor/*']});

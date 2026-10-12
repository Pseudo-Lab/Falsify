import {build} from 'esbuild';
import {cp, mkdir} from 'node:fs/promises';
await mkdir('dist/vendor', {recursive:true});
await build({entryPoints:['src/document-import.js'],outfile:'dist/document-import.js',bundle:true,format:'iife',globalName:'FalsifyImport',target:'es2022',minify:true,legalComments:'eof',external:['./vendor/*']});
await build({entryPoints:['src/document-export.js'],outfile:'dist/document-export.js',bundle:true,format:'iife',globalName:'FalsifyExport',target:'es2022',minify:true,legalComments:'eof'});
await cp('node_modules/pdfjs-dist/build/pdf.mjs','dist/vendor/pdf.mjs');
await cp('node_modules/pdfjs-dist/build/pdf.worker.mjs','dist/vendor/pdf.worker.mjs');
for (const dir of ['cmaps','standard_fonts','wasm']) await cp('node_modules/pdfjs-dist/'+dir,'dist/vendor/'+dir,{recursive:true});
for (const [pkg,name] of [['pdfjs-dist','PDFJS'],['fflate','FFLATE'],['parse5','PARSE5']]) await cp('node_modules/'+pkg+'/LICENSE','dist/vendor/LICENSE-'+name+'.txt');

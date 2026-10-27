import {build} from 'esbuild';
await build({entryPoints:['src/blue-visual-input.mjs'],outfile:'dist/blue-visual-input.js',bundle:true,format:'iife',globalName:'FalsifyBlueVisual',target:'es2022',minify:true,legalComments:'eof',external:['./vendor/*']});

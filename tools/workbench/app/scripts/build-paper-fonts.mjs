import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const app=new URL('../',import.meta.url);
await build({entryPoints:[fileURLToPath(new URL('src/paper-font-service.mjs',app))],
  outfile:fileURLToPath(new URL('dist/paper-font-service.js',app)),bundle:true,
  format:'iife',platform:'browser',target:'es2022',legalComments:'eof'});
console.log('Browser font service built');

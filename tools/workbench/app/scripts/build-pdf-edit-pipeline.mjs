// Compose the existing local PDF engines; no new engine or runtime is vendored.
import {build} from 'esbuild';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await build({entryPoints:[resolve(app,'src/pdf-edit-pipeline.mjs')],outfile:resolve(app,'dist/pdf-edit-pipeline.js'),
  bundle:true,format:'iife',globalName:'FalsifyPdfEditPipeline',platform:'browser',target:'es2022',legalComments:'eof'});

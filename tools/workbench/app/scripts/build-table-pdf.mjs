/* Thin table adapter bundle; reuses the pinned browser-pdf MuPDF runtime. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vendor=join(app,'dist/table-vendor');mkdirSync(vendor,{recursive:true});
for(const name of ['NOTICE.md','provenance.json']){
  copyFileSync(join(app,'src/table-vendor',name),join(vendor,name));
}
copyFileSync(join(app,'src/table-vendor/upstream/LICENSE'),join(vendor,'LICENSE'));
writeFileSync(join(vendor,'NOTICE.md'),'# Runtime table bundle\n\nThe following source notice describes `app/src/table-vendor` in the corresponding Workbench source. This runtime directory carries the bundled adapter, provenance and a LICENSE copy; no PDF engine is added.\n\n'+readFileSync(join(app,'src/table-vendor/NOTICE.md'),'utf8'));
const runtime=JSON.parse(readFileSync(join(app,'dist/browser-pdf-vendor/manifest.json'),'utf8'));
if(runtime.version!=='1.28.1')throw new Error('Unexpected table runtime');
for(const [name,expected]of Object.entries(runtime.files)){if(createHash('sha256').update(readFileSync(join(app,'dist/browser-pdf-vendor',name))).digest('hex')!==expected.sha256)throw new Error('Shared runtime digest mismatch: '+name);}
writeFileSync(join(vendor,'runtime.json'),JSON.stringify({engine:'mupdf.js',version:runtime.version,shared:'../browser-pdf-vendor',files:runtime.files},null,2)+'\n');
await build({entryPoints:[join(app,'src/table-pdf-worker.mjs')],outfile:join(app,'dist/table-pdf-worker.mjs'),bundle:true,
  format:'esm',platform:'browser',target:'es2022',legalComments:'eof',plugins:[{name:'shared-mupdf',setup(b){
    b.onResolve({filter:/^\.\/browser-pdf-vendor\/mupdf\.js$/},()=>({path:'./browser-pdf-vendor/mupdf.js',external:true}));
  }}]});
copyFileSync(join(app,'src/table-pdf-loader.js'),join(app,'dist/table-pdf.js'));
console.log('table-pdf built; shared pinned MuPDF 1.28.1; no runtime copy or download');

import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {layoutToolCatalog,layoutActionSchema,layoutProviderActionSchema} from '../src/paper-layout-tool-catalog.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Ship the same layout instructions with the companion as with project agents.
await writeFile('local/layout-agent-skill.md',await readFile('../.agents/skills/falsify-paper-layout/SKILL.md'));
await writeFile('local/layout-agent-tools.json',JSON.stringify({schema:'falsify.layout-tool-catalog.v2',tools:layoutToolCatalog,actionSchema:layoutActionSchema,providerActionSchema:layoutProviderActionSchema},null,2)+'\n');
const settings={bundle:true,format:'esm',target:'es2022',minify:true,metafile:true,legalComments:'eof',external:['./vendor/*'],plugins:[{name:'shared-browser-mupdf',setup(build){build.onResolve({filter:/^mupdf$/},()=>({path:'./browser-pdf-vendor/mupdf.js',external:true}));}}]};
const result=await build({...settings,entryPoints:['src/latex-workbench.mjs'],outfile:'dist/latex-workbench.mjs'});
const worker=await build({...settings,entryPoints:['src/pdf-latex-reader-worker.mjs'],outfile:'dist/pdf-latex-reader-worker.mjs'});
const inputs=[];for(const path of [...new Set([...Object.keys(result.metafile.inputs),...Object.keys(worker.metafile.inputs)])].sort())if(!path.startsWith('node_modules/'))inputs.push({path,sha256:digest(await readFile(path))});
const output={path:'latex-workbench.mjs',sha256:digest(await readFile('dist/latex-workbench.mjs'))},workerOutput={path:'pdf-latex-reader-worker.mjs',sha256:digest(await readFile('dist/pdf-latex-reader-worker.mjs'))};
await writeFile('dist/latex-workbench-build.json',JSON.stringify({schema:'falsify.browser-bundle.v1',inputs,output,worker:workerOutput},null,2)+'\n');
let html=await readFile('dist/index.html','utf8');
html=html.replace(/src="latex-workbench\.mjs\?v=([^"&]+)[^"]*"/,`src="latex-workbench.mjs?v=$1&amp;build=${output.sha256.slice(0,12)}"`);
html=html.replace(/href="latex-workbench\.css\?v=([^"&]+)[^"]*"/,`href="latex-workbench.css?v=$1&amp;build=${digest(await readFile('dist/latex-workbench.css')).slice(0,12)}"`);
await writeFile('dist/index.html',html);
await build({entryPoints:['src/latex-synctex-map.mjs'],outfile:'tests/latex-compiler-harness/map-bundle.mjs',bundle:true,format:'esm',target:'es2022',legalComments:'eof'});

import {build,version} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(app,'vendor-sources/plottracer'),out=resolve(app,'dist/plottracer-vendor');
const manifest=JSON.parse(readFileSync(resolve(source,'UPSTREAM.json'),'utf8'));
const curveSource=resolve(app,'vendor-sources/wpd-curve');
const curveManifest=JSON.parse(readFileSync(resolve(curveSource,'UPSTREAM.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
if(version!=='0.28.2')throw Error('PlotTracer build requires esbuild 0.28.2');
for(const f of manifest.files){if(sha(readFileSync(resolve(source,f.path)))!==f.sha256)throw Error('Pinned PlotTracer source mismatch: '+f.path);}
for(const f of curveManifest.files){if(sha(readFileSync(resolve(curveSource,f.path)))!==f.sha256)throw Error('Pinned WPD source mismatch: '+f.path);}
mkdirSync(out,{recursive:true});
const curveBanner='/* WebPlotDigitizer curve extraction, Copyright Ankit Rohatgi, AGPL-3.0-or-later; upstream '+curveManifest.commit+'. See NOTICE.md and LICENSE-WPD. */';
const curve=await build({stdin:{contents:curveManifest.files.filter(f=>f.path.endsWith('.js')).map(f=>readFileSync(resolve(curveSource,f.path),'utf8')).join('\n')+'\n'+readFileSync(resolve(curveSource,'adapter.js'),'utf8'),resolveDir:curveSource},bundle:true,write:false,format:'iife',platform:'neutral',target:'es2020',minify:true,legalComments:'inline',charset:'utf8',banner:{js:curveBanner}});
const result=await build({entryPoints:[resolve(source,'adapter.ts')],bundle:true,write:false,format:'iife',platform:'neutral',target:'es2020',minify:true,legalComments:'inline',charset:'utf8',banner:{js:'/* PlotTracer 2.6.0, AGPL-3.0; upstream '+manifest.commit+'. See NOTICE.md and LICENSE. */'}});
const bytes=Buffer.concat([curve.outputFiles[0].contents,Buffer.from('\n'),result.outputFiles[0].contents]);writeFileSync(resolve(out,'engine.js'),bytes);
copyFileSync(resolve(source,'LICENSE'),resolve(out,'LICENSE'));
copyFileSync(resolve(curveSource,'LICENSE'),resolve(out,'LICENSE-WPD'));
const notice='PlotTracer 2.6.0\nhttps://github.com/katalystnord/plottracer\nCommit '+manifest.commit+'\nAGPL-3.0. Copyright David Sandquist and upstream authors.\nXY/calibration and color extraction include WebPlotDigitizer code, Copyright Ankit Rohatgi, AGPL-3.0.\nVendored sources are unchanged. Falsify adapter and build script are in app/vendor-sources/plottracer and app/scripts.\n\nWebPlotDigitizer curve extraction, Copyright Ankit Rohatgi, AGPL-3.0-or-later.\nhttps://github.com/automeris-io/WebPlotDigitizer\nFork https://github.com/Shinick-Han/WebPlotDigitizer\nCommit '+curveManifest.commit+'\nUnmodified algorithm source; Falsify supplies input/output adapters.\n';
writeFileSync(resolve(out,'NOTICE.md'),notice);
writeFileSync(resolve(out,'manifest.json'),JSON.stringify({schema:'falsify.plottracer-runtime.v1',upstream:manifest.repository,commit:manifest.commit,version:'2.6.0',license:'AGPL-3.0',esbuild:version,curve:curveManifest,engine:{path:'engine.js',bytes:bytes.length,sha256:sha(bytes)},sourceFiles:manifest.files},null,2)+'\n');
console.log('PlotTracer runtime '+bytes.length+' bytes '+sha(bytes));

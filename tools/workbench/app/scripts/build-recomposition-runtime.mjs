import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const app=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args=process.argv.slice(2);
function arg(name) { const i=args.indexOf(name); if(i<0 || !args[i+1]) throw Error(`Required: ${name}`); return resolve(args[i+1]); }
const modules=arg('--node-modules'), staticDir=arg('--static-fonts'), sourceFonts=arg('--font-sources');
const outputIndex=args.indexOf('--output');
const dist=outputIndex<0 ? join(app,'dist') : arg('--output');
const {build}=createRequire(join(modules,'esbuild/package.json'))(join(modules,'esbuild'));
const vendor=join(dist,'recomposition-vendor');
const readJSON=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
if(readJSON(join(modules,'esbuild/package.json')).version!=='0.28.2') throw Error('Unexpected esbuild version');
for(const name of ['typst.ts','typst-ts-web-compiler']) {
 const p=readJSON(join(modules,'@myriaddreamin',name,'package.json'));
 if(p.version!=='0.7.0' || p.license!=='Apache-2.0') throw Error(`Unexpected ${name} version or license`);
}
const mupdf=readJSON(join(modules,'mupdf/package.json'));
if(mupdf.version!=='1.28.1') throw Error('Unexpected MuPDF version');
const proof=readJSON(join(staticDir,'manifest.json'));
const pinned={
'NotoSerif-Regular.ttf':'97f25608791ba8b7e7bcfc761caaed09e54a47ae3d27b57c958a561b98c4306d',
'NotoSerif-Bold.ttf':'bd04ea002ca7d793a4d45f5d7ba81bcd0c4af5c23f50be73479e03b61e876059',
'NotoSerif-Italic.ttf':'67263ab35346d102b5ad7f02743a405f50ff1c0fc2a8ad75bcff8d9bfb894ce1',
'NotoSerif-BoldItalic.ttf':'dc188bc4240fb7a0a342df5022c12524977c252250feed09c2774e63acf5f62a',
'NotoSans-Regular.ttf':'16a1ee5229882c1ba577d265014a85d8a4ddbcf5e45bd30bcfbabfdaf89cabf3',
'NotoSans-Bold.ttf':'5a0ee56d5fa69689702d64bef03a4a24d58a93f5ae950ff5a004705102668833',
'NotoSans-Italic.ttf':'4187bd3eed08928c38695ad7702515c2f4c1999e37958e6001d9a7a6bbba1e55',
'NotoSans-BoldItalic.ttf':'a8749f56b38e50a0073475fab205c0cf174e1d50b2e27fc509098ec57969a108'};
if(proof.sourceCommit!=='e7db6ca603fd4862010383ff17ffd6cc4ffac1c0' || proof.faces.length!==8) throw Error('Unexpected static font manifest');
mkdirSync(vendor,{recursive:true});
function put(name,bytes) {writeFileSync(join(vendor,name),bytes);return {url:name,sha256:hash(bytes)};}
const wasmBytes=readFileSync(join(modules,'@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm'));
if(hash(wasmBytes)!=='1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd') throw Error('Compiler WASM hash mismatch');
const wasm=put('typst_ts_web_compiler_bg.wasm',wasmBytes);
const fonts=[];
for(const [file,sha] of Object.entries(pinned)) {
 const face=proof.faces.find(x=>x.file===file), bytes=readFileSync(join(staticDir,file));
 if(!face || face.sha256!==sha || hash(bytes)!==sha || bytes.length!==face.bytes) throw Error(`Static font hash mismatch: ${file}`);
 fonts.push({id:file.replace('.ttf',''),family:face.family,...put(file,bytes)});
}
for(const style of ['Regular','Bold','Italic','BoldItalic']) {
 const file=`LiberationSans-${style}.ttf`;
 fonts.push({id:file.replace('.ttf',''),family:'Liberation Sans',...put(file,readFileSync(join(app,'dist/vendor/standard_fonts',file)))});
}
for(const family of ['notoserif','notosans']) {
 const license=readFileSync(join(sourceFonts,`${family}-OFL.txt`));
 if(hash(license)!=='cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a') throw Error('Noto license hash mismatch');
 writeFileSync(join(vendor,`${family}-OFL.txt`),license);
}
copyFileSync(join(app,'dist/vendor/standard_fonts/LICENSE_LIBERATION'),join(vendor,'LICENSE_LIBERATION'));
copyFileSync(join(modules,'@myriaddreamin/typst.ts/LICENSE'),join(vendor,'LICENSE_TYPST_APACHE'));
writeFileSync(join(vendor,'static-font-provenance.json'),JSON.stringify(proof,null,2)+'\n');
writeFileSync(join(vendor,'manifest.json'),JSON.stringify({version:'falsify.recomposition-runtime.v1',compilerModule:'../recomposition-typst.mjs',wasm,fonts},null,2)+'\n');
// esbuild includes input labels in output. Stage both trees under stable relative
// names so neither the checkout nor the npm installation path enters bundles.
const stage=mkdtempSync(join(tmpdir(),'falsify-recomposition-'));
try {
cpSync(join(app,'src'),join(stage,'src'),{recursive:true});
cpSync(modules,join(stage,'node_modules'),{recursive:true});
const common={bundle:true,format:'esm',platform:'neutral',target:'es2022',legalComments:'eof',absWorkingDir:stage,metafile:true};
const builds=[];
builds.push(await build({...common,entryPoints:['src/recomposition-typst.mjs'],outfile:join(dist,'recomposition-typst.mjs')}));
builds.push(await build({...common,entryPoints:['src/paper-recompose-runtime.mjs'],outfile:join(dist,'paper-recompose-runtime.mjs')}));
builds.push(await build({...common,entryPoints:['src/paper-recompose-worker.mjs'],outfile:join(dist,'paper-recompose-worker-core.mjs'),plugins:[{name:'local-vendors',setup(b){
 b.onResolve({filter:/^mupdf$/},()=>({path:'./browser-pdf-vendor/mupdf.js',external:true}));
 b.onResolve({filter:/^\.\.\/dist\/blind-pdf\.mjs$/},()=>({path:'./blind-pdf.mjs',external:true}));
}}]}));
builds.push(await build({...common,entryPoints:['src/paper-recompose-worker-entry.mjs'],outfile:join(dist,'paper-recompose-worker.mjs'),external:['./paper-recompose-worker-core.mjs']}));
const inputs={};
for(const name of [...new Set(builds.flatMap(b=>Object.keys(b.metafile.inputs)))].sort()) inputs[name]=hash(readFileSync(join(stage,name)));
const outputs={};
for(const name of ['recomposition-typst.mjs','paper-recompose-runtime.mjs','paper-recompose-worker-core.mjs','paper-recompose-worker.mjs']) outputs[name]=hash(readFileSync(join(dist,name)));
for(const name of readdirSync(vendor).sort()) outputs[`recomposition-vendor/${name}`]=hash(readFileSync(join(vendor,name)));
const packages={};
for(const name of ['esbuild','@myriaddreamin/typst.ts','@myriaddreamin/typst-ts-web-compiler','mupdf']) packages[name]=hash(readFileSync(join(modules,name,'package.json')));
const buildFiles={};
for(const name of ['scripts/build-recomposition-runtime.mjs','vendor-build/package-lock.json']) buildFiles[name]=hash(readFileSync(join(app,name)));
writeFileSync(join(dist,'recomposition-build-receipt.json'),JSON.stringify({version:1,buildFiles,inputs,packages,outputs},null,2)+'\n');
} finally { rmSync(stage,{recursive:true,force:true}); }
console.log('Built recomposition runtime',wasm.sha256);

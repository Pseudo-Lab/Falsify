// Rebuild the pinned local BusyTeX assets. Run from app/ with Node 20+ and tar on PATH.
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFileSync} from 'node:child_process';
const url='https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v1.4.1/busytex-assets.tar.gz';
const expected='4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b';
const files=['busytex.js','busytex.wasm','busytex_worker.js','busytex_pipeline.js','busytex_biber.js','texlive-basic.js','texlive-basic.data'];
const temp=await mkdtemp(join(tmpdir(),'falsify-busytex-'));
try {
 const archive=process.env.FALSIFY_BUSYTEX_ARCHIVE || join(temp,'assets.tar.gz');
 if(!process.env.FALSIFY_BUSYTEX_ARCHIVE) {const response=await fetch(url); if(!response.ok)throw new Error(`Download failed: ${response.status}`); await pipeline(Readable.fromWeb(response.body),createWriteStream(archive));}
 const hash=createHash('sha256'); const {createReadStream}=await import('node:fs'); for await(const chunk of createReadStream(archive))hash.update(chunk);
 if(hash.digest('hex')!==expected)throw new Error('BusyTeX archive SHA-256 mismatch');
 execFileSync('tar',['-xzf',archive,'-C',temp,...files.map(f=>'busytex/'+f)],{stdio:'inherit'});
 const target=resolve('dist/latex-compiler-vendor'); await mkdir(target,{recursive:true});
 for(const f of files) {
  let bytes=await readFile(join(temp,'busytex',f));
  if(f==='busytex_pipeline.js') {
   const source=bytes.toString('utf8');
   const line="        console.log('LOGS', logs);";
   const printLine='        this.print = text => { console.log(text); print(text); };';
   if(!source.includes(line) || !source.includes(printLine))throw new Error('Expected upstream log statement not found');
   bytes=Buffer.from(source.replace(line,'        // Falsify: do not expose document logs in the browser console.').replace(printLine,'        this.print = text => { print(text); };'));
  }
  await writeFile(join(target,f),bytes);
 }
 console.log(`Installed pinned BusyTeX assets to ${target}`);
} finally {await rm(temp,{recursive:true,force:true});}

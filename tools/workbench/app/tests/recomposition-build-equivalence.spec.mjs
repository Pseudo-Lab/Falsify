import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, mkdtempSync, readFileSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const app=resolve(fileURLToPath(new URL('..',import.meta.url)));
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const receipt=JSON.parse(readFileSync(join(app,'dist/recomposition-build-receipt.json')));
test('committed recomposition bundles match their source and receipt',()=>{
  for(const [name,expected] of Object.entries(receipt.buildFiles)) assert.equal(digest(join(app,name)),expected,`build input ${name}`);
  for(const [name,expected] of Object.entries(receipt.inputs)) {
    if(name.startsWith('src/')) assert.equal(digest(join(app,name)),expected,`source input ${name}`);
  }
  for(const [name,expected] of Object.entries(receipt.outputs)) assert.equal(digest(join(app,'dist',name)),expected,`output ${name}`);
});

const modules=process.env.FALSIFY_RECOMPOSITION_MODULES;
const fonts=process.env.FALSIFY_RECOMPOSITION_FONTS;
const sources=process.env.FALSIFY_RECOMPOSITION_FONT_SOURCES;
test('independent source and module roots produce identical committed outputs', {skip: !(modules && fonts && sources)},()=>{
  const root=mkdtempSync(join(tmpdir(),'falsify-two-roots-'));
  try {
    const receipts=[];
    for(const label of ['first','second']) {
      const copy=join(root,label,'app'), deps=join(root,label,'dependencies','node_modules');
      mkdirSync(join(copy,'dist/vendor'),{recursive:true});
      mkdirSync(join(copy,'scripts'),{recursive:true});
      mkdirSync(join(copy,'vendor-build'),{recursive:true});
      cpSync(join(app,'src'),join(copy,'src'),{recursive:true});
      cpSync(join(app,'scripts/build-recomposition-runtime.mjs'),join(copy,'scripts/build-recomposition-runtime.mjs'));
      cpSync(join(app,'vendor-build/package-lock.json'),join(copy,'vendor-build/package-lock.json'));
      cpSync(join(app,'dist/vendor/standard_fonts'),join(copy,'dist/vendor/standard_fonts'),{recursive:true});
      cpSync(modules,deps,{recursive:true});
      const run=spawnSync(process.execPath,[join(copy,'scripts/build-recomposition-runtime.mjs'),'--node-modules',deps,'--static-fonts',fonts,'--font-sources',sources],{encoding:'utf8'});
      assert.equal(run.status,0,`${label} build: ${run.stderr}`);
      receipts.push(JSON.parse(readFileSync(join(copy,'dist/recomposition-build-receipt.json'))));
    }
    assert.deepEqual(receipts[0],receipts[1],'two source/module roots');
    assert.deepEqual(receipts[0],receipt,'committed receipt differs from rebuilt inputs or outputs');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

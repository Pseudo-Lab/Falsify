import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const cli=resolve('tools/layout-evaluation/recompose-proof.mjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
test('stale sources and failed composition preserve existing evidence and source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'falsify-proof-'));
 try {
  const source=join(dir,'source.pdf'), matrix=join(dir,'matrix.json'), out=join(dir,'out'), data=Buffer.from('not a PDF');
  await writeFile(source,data); await mkdir(out); await writeFile(join(out,'sentinel'),'untouched');
  const run=()=>spawnSync(process.execPath,[cli,'--matrix',matrix,'--case','x','--output-dir',out],{encoding:'utf8'});
  const plan=h=>JSON.stringify({cases:[{id:'x',source,fileHash:h,edits:[]}]});
  await writeFile(matrix,plan('0'.repeat(64))); let r=run(); assert.notEqual(r.status,0); assert.match(r.stderr,/Matrix source hash mismatch/);
  await writeFile(matrix,plan(hash(data))); r=run(); assert.notEqual(r.status,0); assert.match(r.stderr,/EEXIST/);
  assert.equal(await readFile(join(out,'sentinel'),'utf8'),'untouched');
  const failed=join(dir,'failed'); r=spawnSync(process.execPath,[cli,'--matrix',matrix,'--case','x','--output-dir',failed],{encoding:'utf8'}); assert.notEqual(r.status,0);
  assert.deepEqual(await readFile(source),data); assert.equal(await readFile(join(out,'sentinel'),'utf8'),'untouched');
 } finally {await rm(dir,{recursive:true,force:true});}
});

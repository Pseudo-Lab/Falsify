import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {javascriptFunctions, pythonFunctions, violations} from './complexity.mjs';

const base=process.argv[2];
if(!base || !/^[a-f0-9]{7,64}$/i.test(base)) throw Error('Expected an explicit base commit SHA');
function git(...args) {
  const result=spawnSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
  if(result.error || result.status!==0) throw Error(`git ${args[0]} failed: ${result.error || result.stderr}`);
  return result.stdout;
}
git('rev-parse','--verify',`${base}^{commit}`);
const paths=git('diff','--no-renames','--name-only','--diff-filter=ACM','-z',base,'HEAD','--','app/src','app/local').split('\0').filter(Boolean).filter(p=>/\.(?:mjs|cjs|js|py)$/.test(p));
const reasons=JSON.parse(readFileSync(new URL('./exceptions.json',import.meta.url),'utf8'));
let failures=0;
for(const path of paths) {
  const parse=path.endsWith('.py')?pythonFunctions:javascriptFunctions;
  const exists=spawnSync('git',['cat-file','-e',`${base}:${path}`]).status===0;
  try {
    const old=exists?parse(git('show',`${base}:${path}`)):[];
    const current=parse(git('show',`HEAD:${path}`));
    for(const item of violations(old,current,50,reasons[path] || {})) {
      console.error(`${path}:${item.id}: CCN ${item.ccn} exceeds allowed baseline/50`); failures++;
    }
  } catch(error) { console.error(`${path}: ${error.message}`); failures++; }
}
if(failures) process.exitCode=1;
else console.log(`Complexity ratchet passed for ${paths.length} changed source files against ${base}`);

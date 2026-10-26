const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const dist=path.resolve(__dirname,'../dist'),html=fs.readFileSync(path.join(dist,'index.html'),'utf8');let passed=0;
const check=(name,condition)=>{assert.ok(condition,name);passed++;};
const scripts=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
const version=fs.readFileSync(path.join(__dirname,'../../VERSION'),'utf8').trim();
const urls=[...html.matchAll(/(?:src|href)="([^"\s]+\?v=[^"\s]+)"/g)].map(m=>new URL(m[1],'https://local.invalid/'));
check('changed entry assets use the current release version',urls.length>=5&&urls.every(u=>u.searchParams.get('v')===version));
for(const source of scripts)check('linked script exists: '+source,fs.existsSync(path.join(dist,source)));
const authored=fs.readdirSync(dist).filter(f=>f.endsWith('.js'));
check('all authored browser modules are reachable',authored.every(f=>scripts.includes(f)));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);check('static IDs are unique',ids.length===new Set(ids).size);
const sources=authored.filter(f=>f!=='document-import.js').map(f=>fs.readFileSync(path.join(dist,f),'utf8')).join('\n');
// paper-workspace is now the independent PDF editor, not the removed AMAS demo.
const legacy=['load-sample','FalsifyCore','SAMPLE_PROFILES','generateRed','runBlue','connectAgent','exportDemo','connectorTimers','legacy-review','blue-mode','blue-outcome','activity-log'];
for(const name of legacy)check('legacy path removed: '+name,!html.includes(name)&&!sources.includes(name));
for(const id of [...html.matchAll(/<symbol id="([^"]+)"/g)].map(m=>m[1]))check('SVG symbol is used: '+id,html.includes('href="#'+id+'"'));
for(const f of ['styles.css','document-red.css','experiment-ledger.css']){const css=fs.readFileSync(path.join(dist,f),'utf8');check('legacy styles removed: '+f,!/\.(?:legacy-review|activity|comparison-arms|agent-row|reading-pane|blue-controls|difficulty)\b|#doc-blue-comparison/.test(css));}
console.log(JSON.stringify({passed,scope:'Authored application modules and removed legacy paths; bundled parser/vendor internals excluded.'}));

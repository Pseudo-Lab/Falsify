// Integration boundary: actual bundled Worker, portable codec, and no persistence bindings.
// Synthetic OAuth settings only. No Atlassian request, deployment or user content.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const api=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://shinick-han.github.io';
const packed=await build({entryPoints:[path.join(api,'src/index.js')],bundle:true,write:false,metafile:true,format:'esm',platform:'browser',external:['node:*'],logLevel:'silent'});

test('deployable module graph contains the real archive codec and validators',()=>{
  const inputs=Object.keys(packed.metafile.inputs).map(x=>x.replaceAll('\\','/'));
  for(const source of ['review-bundle.mjs','harness-core.js','document-red-core.js','document-blue-core.js','review-workbench.js']){
    assert.ok(inputs.some(x=>x.endsWith('/app/dist/'+source)),source+' must be bundled, not resolved from a nonexistent runtime filesystem');
  }
  assert.ok(!Object.values(packed.metafile.outputs).flatMap(x=>x.imports).some(x=>x.path.includes('review-bundle')),'no external archive module');
});

test('deployed-shape OAuth and retired routes run without D1, KV or R2',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({name:'archive-runtime-test',modules:true,script:packed.outputFiles[0].text,compatibilityDate:'2026-10-19',compatibilityFlags:['nodejs_compat'],bindings:{
    ALLOWED_ORIGINS:origin,CONFLUENCE_ONLY:'true',
    ATLASSIAN_CLIENT_ID:'synthetic-client-id',ATLASSIAN_CLIENT_SECRET:'synthetic-only-not-a-real-credential',
    CONFLUENCE_SESSION_KEY:Buffer.alloc(32,7).toString('base64'),CONFLUENCE_PARENT_PAGE_ID:'8355842',
    ATLASSIAN_CALLBACK_URL:'https://api.test/v1/confluence/auth/callback'
  }}));
  try{
    const caps=await mf.dispatchFetch('https://api.test/v1/confluence/capabilities',{headers:{Origin:origin}});
    assert.equal(caps.status,200);assert.equal((await caps.json()).configured,true);
    const start=await mf.dispatchFetch('https://api.test/v1/confluence/auth/start',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({nonce:'synthetic-nonce-for-no-db-check',returnOrigin:origin})});
    assert.equal(start.status,200);const url=new URL((await start.json()).authorizeUrl);
    assert.equal(url.origin,'https://auth.atlassian.com');assert.equal(url.searchParams.get('redirect_uri'),'https://api.test/v1/confluence/auth/callback');
    assert.ok(url.searchParams.get('state').length>24);
    const wrong=await mf.dispatchFetch('https://api.test/v1/confluence/auth/start',{method:'POST',headers:{Origin:'https://foreign.test','Content-Type':'application/json'},body:'{}'});
    assert.equal(wrong.status,403);
    const old=await mf.dispatchFetch('https://api.test/v1/records',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal(old.status,410);assert.equal((await old.json()).error.code,'storage_moved');
    const legacy=await mf.dispatchFetch('https://api.test/v1/confluence/archives',{headers:{Origin:origin,Authorization:'Bearer fss_synthetic-token-cannot-authorize-confluence'}});
    assert.equal(legacy.status,401);
  }finally{await mf.dispose();}
});

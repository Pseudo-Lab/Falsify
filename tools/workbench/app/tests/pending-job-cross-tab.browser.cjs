'use strict';
// Isolated shared-origin Chromium pages; synthetic inputs, no bridge or model calls.
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 let posts=0;const script=fs.readFileSync(path.join(__dirname,'../dist/pending-job.js'));
 const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type',req.url==='/pending-job.js'?'text/javascript':'text/html');res.end(req.url==='/pending-job.js'?script:'<script src="/pending-job.js"></script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),url='http://127.0.0.1:'+server.address().port;
  await Promise.all([a.goto(url),b.goto(url)]);
  await a.evaluate(()=>{localStorage.clear();window.entered=false;window.gate=new Promise(r=>window.release=r);});
  const run=(page,id,slow)=>page.evaluate(({id,slow})=>{const d={revision:'r',sourceHash:'a'.repeat(64),fileHash:'b'.repeat(64),name:'synthetic',format:'TXT',segments:[{id:'s',label:'p',text:'synthetic'}]};const request={requestId:id,revision:d.revision,sourceHash:d.sourceHash,segments:d.segments,harness:{}};return FalsifyPendingJobs.hold({role:'red',request,doc:d,companionInstance:'ci1.'+'c'.repeat(64),hashHarness:async()=>{if(slow){window.entered=true;await window.gate;}return 'd'.repeat(64);}});},{id,slow});
  const first=run(a,'first',true);await a.waitForFunction(()=>window.entered);const second=run(b,'second',false);
  await a.evaluate(()=>window.release());const [winner,loser]=await Promise.all([first,second]);
  assert.equal(winner.ok,true);assert.equal(loser.status,'blocked');assert.equal(await b.evaluate(()=>FalsifyPendingJobs.read('red').record.requestId),'first');assert.equal(posts,0);
  await Promise.all([a.reload(),b.reload()]);assert.equal(posts,0);assert.equal(await b.evaluate(()=>FalsifyPendingJobs.read('red').record.requestId),'first');
  console.log(JSON.stringify({winner:winner.record.requestId,loser:loser.status,posts,afterReload:true}));await context.close();
 }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

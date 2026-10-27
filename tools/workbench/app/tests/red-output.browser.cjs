'use strict';
// Isolated synthetic PDF only; no private documents or model calls.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const http=require('node:http');
const root=path.resolve(__dirname,'../..'),out=path.resolve(process.env.FALSIFY_UI_CAPTURE_DIR||path.join(root,'.local/red-output-captures'));
let url=process.env.FALSIFY_UI_TEST_URL,localServer;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const first='The trial shows a modest benefit in adults.',second='Effects were observed only in the treated cohort.',page2='Second page remains intact.';
const before='shows a modest benefit',after='shows no benefit',marker='FALSIFY RED TEAM TRAINING COPY | INTENTIONALLY ALTERED | NOT ORIGINAL',banner='q\n25 13 562 14 re\nh\n.98 .94 .87 rg f\nQ';
(async()=>{
 await fs.mkdir(out,{recursive:true});
 if(!url){
  const dist=path.join(root,'app/dist'),types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
  localServer=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname),file=path.resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(dist+path.sep)||req.method!=='GET'){res.writeHead(404).end();return;}const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>localServer.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+localServer.address().port+'/';
 }
 const m=await import(pathToFileURL(path.join(root,'app/dist/browser-pdf-vendor/mupdf.js')).href);
 const d=new m.PDFDocument(),font=d.addSimpleFont(new m.Font('Times-Roman')),footerFont=d.addSimpleFont(new m.Font('Helvetica'));
 for(const content of [`BT /F1 12 Tf 72 700 Td (${first}) Tj 0 -50 Td (${second}) Tj ET`,`BT /F1 12 Tf 72 700 Td (${page2}) Tj ET`])d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font,helv:footerFont}},content));
 const p=d.findPage(0),body=p.get('Contents'),markerHex=Buffer.from(marker.replaceAll(' | ','  | '),'ascii').toString('hex');p.put('Contents',[body,d.addStream(banner,{}),d.addStream('q\nBT\n1 0 0 1 30 17.8 Tm\n/helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<'+markerHex+'>]TJ\nET\nQ',{})]);
 const b=d.saveToBuffer(),source=Buffer.from(b.asUint8Array());b.destroy();d.destroy();await fs.writeFile(path.join(out,'synthetic-source.pdf'),source);
 const readPdf=bytes=>{const pdf=m.Document.openDocument(bytes,'application/pdf'),texts=[],streams=[];try{for(let i=0;i<pdf.countPages();i++){const page=pdf.loadPage(i),st=page.toStructuredText();texts.push(st.asText().replace(/\s+/g,' ').trim());st.destroy();const c=page.getObject().get('Contents');for(let j=0;j<(c.isArray()?c.length:1);j++){const obj=c.isArray()?c.get(j):c;const x=obj.readStream();if(x){streams.push(new TextDecoder().decode(x.asUint8Array()));x.destroy();}}page.destroy();}}finally{pdf.destroy();}return {texts,streams};};
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true}),results=[];
 try{for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
  const r={name,checks:{},errors:[],requests:[],downloads:[]};results.push(r);const ctx=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',acceptDownloads:true}),page=await ctx.newPage();
  page.on('pageerror',e=>r.errors.push(e.message));page.on('request',req=>{if(req.method()==='POST'||/\/api\/(?:red|blue)\/jobs/.test(req.url()))r.requests.push({method:req.method(),url:req.url()});});page.on('download',dl=>r.downloads.push(dl));
  await page.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||u.hostname==='localhost'?route.continue():route.fulfill({status:401,body:''});});
  try{
   await page.goto(url);await page.evaluate(()=>FalsifyVisual.ready);await page.locator('#paper-file').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:source});
   await page.locator('#document-red').waitFor({state:'attached',timeout:90000});await page.waitForFunction(()=>!document.querySelector('#document-red').hidden,null,{timeout:90000});
   await page.locator('[data-view=workbench]:visible').first().click();await page.locator('#red-request').evaluate(e=>{for(let a=e;a;a=a.parentElement)if(a.tagName==='DETAILS')a.open=true;});
   const [reqDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#red-request').click()]);const req=JSON.parse(await fs.readFile(await reqDownload.path(),'utf8'));r.downloads.length=0;
   const segment=req.segments.find(s=>s.text.includes(first)&&s.text.includes(second));assert.ok(segment,'both synthetic quotes in request segment');
   const cand=(id,before,after)=>({id,segmentId:segment.id,level:1,before,after,rationale:'Synthetic contradiction.',evidence:[{segmentId:segment.id,quote:before,relation:'Synthetic relation.'}],uncertainty:'Synthetic only; domain review pending.'});
   await page.locator('#red-response').fill(JSON.stringify({schema:req.schema,revision:req.revision,sourceHash:req.sourceHash,status:'ok',candidates:[cand('c1',before,'shows a clear benefit'),cand('c2','only in the treated cohort','in all cohorts')]}));await page.locator('#red-import-response').click();
   await page.locator('#red-candidates input[type=checkbox]').first().check();await page.locator('#red-after-0').fill(after);r.checks.collapsedDetails=await page.locator('#red-candidates details.red-candidate-notes:not([open])').count()===2;r.checks.consentRemoved=await page.locator('#red-export-consent').count()===0;
   await page.screenshot({path:path.join(out,name+'-before-download.png'),fullPage:true});await page.locator('#red-download').scrollIntoViewIfNeeded();const location=await page.evaluate(()=>({href:location.href,y:scrollY}));
   await page.locator('#red-download').click();await page.waitForFunction(()=>!document.querySelector('#red-download').disabled&&/다운로드|차단/.test(document.querySelector('#red-export-status').textContent),null,{timeout:120000});await page.waitForTimeout(750);
   r.status=await page.locator('#red-export-status').innerText();r.checks.onePdf=r.downloads.length===1&&r.downloads[0].suggestedFilename()==='paper.pdf';r.checks.noRedirectOrScroll=await page.evaluate(x=>location.href===x.href&&Math.abs(scrollY-x.y)<2,location);
   assert.equal(r.checks.onePdf,true,'one paper.pdf download');const output=await fs.readFile(await r.downloads[0].path());await fs.writeFile(path.join(out,name+'-output.pdf'),output);r.outputHash=sha(output);
   const parsed=readPdf(output),original=readPdf(source);r.outputTexts=parsed.texts;r.checks.content=parsed.texts[0].includes(after)&&parsed.texts[0].includes(second)&&parsed.texts[1]?.includes(page2);r.checks.markerRemoved=!parsed.texts.join('\n').includes(marker);r.checks.bannerRemoved=!parsed.streams.some(s=>/25\s+13\s+562\s+14\s+re/.test(s));r.checks.originalUnchanged=sha(await fs.readFile(path.join(out,'synthetic-source.pdf')))===sha(source)&&original.texts.join('\n').includes(marker)&&original.streams.some(s=>s.includes(banner));
   const [planDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#red-plan').click()]);const plan=JSON.parse(await fs.readFile(await planDownload.path(),'utf8'));r.checks.explicitPlanHash=plan.outputFileHash===r.outputHash;r.checks.planSelection=plan.selected.length===1&&plan.selected[0].after===after;r.checks.planProvenance=plan.reviewProvenance==='manual-unverified';
   await page.waitForFunction(h=>{const data=JSON.parse(localStorage.getItem('falsify.experiment-ledger.v1')||'{"runs":[]}');return data.runs.some(x=>x.finalState?.outputFileHash===h);},r.outputHash,{timeout:10000});r.checks.recordHash=true;
 }catch(e){r.failure=String(e.stack||e);try{r.status=await page.locator('#red-export-status').innerText();r.importStatus=await page.locator('#import-status').innerText();}catch{}}
  r.checks.noModelPost=r.requests.length===0;r.checks.noPageErrors=r.errors.length===0;r.downloads=r.downloads.map(x=>x.suggestedFilename());await ctx.close();
 }}finally{await browser.close();if(localServer)await new Promise(resolve=>localServer.close(resolve));}
 const report={url,sourceHash:sha(source),results,limitations:['Synthetic fixture and isolated headless contexts only; warnings are not domain approval.']};await fs.writeFile(path.join(out,'red-output-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(results.some(r=>r.failure||Object.values(r.checks).includes(false)))process.exitCode=1;
})().catch(async e=>{console.error(e);if(localServer?.listening)await new Promise(resolve=>localServer.close(resolve));process.exitCode=1;});

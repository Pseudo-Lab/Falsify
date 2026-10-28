const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});try{
 const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.FALSIFY_UI_TEST_URL||'http://127.0.0.1:18806/');await page.evaluate(()=>FalsifyVisual.ready);
 for(const [role,view,file,answer] of [['red','workbench','#paper-file','#external-red-paste'],['blue','blue','#doc-blue-file','#external-blue textarea[aria-label="BLUE 외부 응답"]']]){
  await page.locator('.rail [data-view="'+view+'"]').click();
  const advanced=page.locator('#'+role+'-advanced-tools');assert.equal(await advanced.evaluate(e=>e.open),false);
  assert.ok(await page.locator(file).isVisible());assert.ok(await page.locator('#external-'+role+' .prompt-instructions textarea').first().isVisible());assert.ok(await page.locator(answer).isVisible());
  assert.ok(await advanced.locator('> summary').innerText().then(t=>t.includes('내 PC')));
  assert.equal(await page.locator('#local-bridge').evaluate(e=>e.closest('.visual-advanced-execution').id),role+'-advanced-tools');
  await page.locator(file).setInputFiles({name:role+'.txt',mimeType:'text/plain',buffer:Buffer.from('A synthetic document.')});
  await page.waitForFunction(role=>document.querySelector('#sign-detail').textContent.includes(role+'.txt'),role);
  await page.locator('#sign-action').click();assert.equal(await page.evaluate(()=>document.activeElement.closest('.prompt-instructions')!==null),true);
  if(role==='red'){await page.evaluate(()=>document.addEventListener('falsify:before-document-change',e=>e.preventDefault(),{once:true}));await page.locator(file).setInputFiles({name:'replacement.txt',mimeType:'text/plain',buffer:Buffer.from('Replacement.')});assert.equal(await page.locator(file).evaluate(e=>e.files[0].name),'red.txt');}
  await advanced.locator('> summary').click();const consent=page.locator(role==='red'?'#red-consent':'#doc-blue-consent');await consent.evaluate(e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});assert.ok(await consent.isVisible());
  await page.locator('#visual-'+role+'-external').click();assert.equal(await page.evaluate(()=>document.activeElement.id||document.activeElement.getAttribute('aria-label')),role==='red'?'external-red-paste':'BLUE 외부 응답');
  await advanced.locator('> summary').click();
  await page.evaluate(role=>document.dispatchEvent(new CustomEvent(role==='red'?'falsify:document-state':'falsify:blue-state',{detail:{name:role+'.txt',hasResult:true,count:0,busy:false}})),role);
  await page.locator('#sign-action').click();assert.equal(await advanced.evaluate(e=>e.open),true);
 }
 await page.locator('.rail [data-view="results"]').click();await page.locator('.brand').click();await page.waitForFunction(()=>document.querySelector('#local-bridge').closest('.visual-advanced-execution')?.id==='red-advanced-tools');
 assert.deepEqual(errors,[]);console.log('basic/advanced navigation and bridge checks passed');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

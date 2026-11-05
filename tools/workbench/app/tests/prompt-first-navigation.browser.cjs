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
 for(const role of ['red','blue']){
  await page.locator('.rail [data-view="agents"]').click();
  const article=page.locator('#harness-library article').filter({hasText:' · '+role.toUpperCase()+' · '}).first();
  const instructions=await article.locator('p').nth(1).textContent();
  await article.getByRole('button',{name:'이 버전에서 수정'}).click();
  const prompt=page.locator('#external-'+role+' .prompt-instructions textarea').first();
  assert.equal(await prompt.inputValue(),instructions);assert.equal(await prompt.evaluate(e=>document.activeElement===e),true);
 }
 await page.locator('.rail [data-view="results"]').click();await page.locator('.brand').click();await page.waitForFunction(()=>document.querySelector('#local-bridge').closest('.visual-advanced-execution')?.id==='red-advanced-tools');
 const mobile=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await mobile.goto(process.env.FALSIFY_UI_TEST_URL||'http://127.0.0.1:18806/');await mobile.evaluate(()=>FalsifyVisual.ready);
 await mobile.locator('#paper-file').setInputFiles(require('node:path').join(__dirname,'fixtures/paragraph-audit-synthetic.pdf'));
 await mobile.locator('#paper-before-stage canvas').waitFor({timeout:30000});
 assert.ok(await mobile.locator('#paper-before-stage').evaluate(e=>e.getBoundingClientRect().top<innerHeight));
 assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mobile.locator('#paper-page-next').click();await mobile.waitForFunction(()=>document.querySelector('#paper-before-status').textContent.includes('2 / 2'));
 await mobile.getByRole('button',{name:'수정본',exact:true}).click();assert.equal(await mobile.locator('.paper-compare').getAttribute('data-mobile-side'),'after');
 await mobile.getByRole('button',{name:'원본',exact:true}).click();assert.ok((await mobile.locator('#paper-page-label').innerText()).includes('2 / 2'));
 await mobile.locator('.paper-paragraph-list summary').click();await mobile.locator('.paper-paragraph-button').first().click();
  assert.equal(await mobile.locator('.visual-compare-bar').isVisible(),false);
  await mobile.locator('.paper-page > textarea').fill('Synthetic revised title');await mobile.getByRole('button',{name:'완료',exact:true}).click();
  await mobile.waitForFunction(()=>FalsifyPaperWorkspace.getEditSnapshot().edits.length===1);
  assert.equal(await mobile.locator('.visual-compare-bar').isVisible(),true);
 await mobile.getByRole('button',{name:'수정본',exact:true}).click();
 await mobile.locator('#paper-edits button[data-act=edit]').first().click();
 assert.equal(await mobile.locator('.paper-compare').getAttribute('data-mobile-side'),'before');
 const reopened=mobile.locator('.paper-page > textarea');assert.ok(await reopened.isVisible());
 assert.equal(await reopened.evaluate(e=>document.activeElement===e),true);
 assert.equal(await reopened.inputValue(),'Synthetic revised title');await reopened.press('Escape');
 assert.equal(await mobile.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot().edits.length),1);
 await mobile.locator('#paper-undo').click();assert.equal(await mobile.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot().edits.length),0);
 await mobile.close();
 const desktop=await browser.newPage({viewport:{width:960,height:600},reducedMotion:'reduce'});
 await desktop.goto(process.env.FALSIFY_UI_TEST_URL||'http://127.0.0.1:18806/');await desktop.evaluate(()=>FalsifyVisual.ready);
 assert.ok(await desktop.locator('.paper-intake > .step-head').isVisible());assert.ok(await desktop.locator('#sign-detail').isVisible());
 await desktop.locator('#paper-file').setInputFiles(require('node:path').join(__dirname,'fixtures/paragraph-audit-synthetic.pdf'));
 await desktop.locator('#paper-before-stage canvas').waitFor({timeout:30000});
 const stageTop=await desktop.locator('#paper-before-stage').evaluate(e=>e.getBoundingClientRect().top);
 console.log('desktop paper top:',stageTop);assert.ok(stageTop<=400);
 assert.ok(await desktop.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await desktop.close();
 assert.deepEqual(errors,[]);console.log('basic/advanced navigation and bridge checks passed');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

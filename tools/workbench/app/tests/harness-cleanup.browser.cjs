// Synthetic configs only. No model execution or Confluence writes.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.WORKBENCH_URL||'http://127.0.0.1:18781/#harness');
    await page.evaluate(()=>FalsifyLab.ready);
    const base=await page.evaluate(()=>FalsifyHarness.builtin('blue'));
    await page.locator('#visual-harness-author').evaluate(e=>e.open=true);
    await page.locator('#harness-editor').fill(JSON.stringify({...base,id:'test-latest-blue',name:'최신 BLUE',version:'0.3.5'}));
    await page.locator('#harness-register').click();
    await page.getByRole('button',{name:'최신 BLUE · BLUE · v0.3.5 사용',exact:true}).click();
    await page.locator('[data-view="agents"]').first().click();
    await page.locator('#harness-tidy').click();
    assert.equal(await page.locator('#harness-library > article').count(),2);
    await page.reload();
    await page.evaluate(()=>FalsifyLab.ready);
    assert.equal(await page.locator('#harness-library > article').count(),2);
    assert.match(await page.locator('#blue-harness option:checked').textContent(),/최신 BLUE/);
    await page.waitForFunction(()=>!document.querySelector('.sign-message').classList.contains('flipping'));
    const out=path.resolve(process.env.CHECK_OUTPUT||'../harness-cleanup-ui');await fs.mkdir(out,{recursive:true});
    for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
      await page.setViewportSize({width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,name+' overflow');
      await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
    }
    await page.locator('#harness-restore').click();
    assert.equal(await page.locator('#harness-library > article').count(),3);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,roles:2,reload:true,restore:true,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});

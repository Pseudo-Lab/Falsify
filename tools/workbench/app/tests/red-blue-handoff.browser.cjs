// Local static server only; no CLI, model, real paper or remote writes.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),posts=[];
    page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(?:blue|red)\/jobs/.test(r.url()))posts.push(r.url());});
    await page.goto(process.env.WORKBENCH_URL||'http://127.0.0.1:18780/');
    await page.locator('#paper-file').setInputFiles(path.join(__dirname,'fixtures/handoff-paper.pdf'));
    await page.getByText(/이 쪽의 문단 선택/).click();
    await page.getByRole('button',{name:'Study results show a conditional benefit.',exact:true}).click();
    await page.locator('#paper-inline-after').fill('Study results show a clear benefit.');
    await page.locator('#paper-inline-apply').click();
    await page.locator('#paper-generate').click();
    await page.waitForFunction(()=>!document.querySelector('#paper-blue-handoff').disabled);
    const generated=await page.evaluate(()=>FalsifyPaperWorkspace.getOutput().sha256);
    await page.evaluate(()=>document.addEventListener('falsify:blue-file',e=>{
      window.__handoffHash=e.detail.file.arrayBuffer().then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join(''));
    },{once:true}));
    await page.locator('#paper-blue-handoff').click();
    await page.waitForFunction(()=>document.querySelector('#doc-blue-summary').textContent.includes('RED 변경본'));
    await page.waitForFunction(()=>document.querySelector('#view-blue .visual-file-title')?.textContent==='paper.pdf');
    await page.locator('#view-blue .visual-paper canvas').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('.sign-message').classList.contains('flipping'));
    assert.equal(await page.evaluate(()=>window.__handoffHash),generated);
    assert.match(await page.locator('#sign-title').textContent(),/내 PC를 연결/);
    assert.equal(await page.locator('#sign-action-label').textContent(),'내 PC 연결');
    assert.equal(await page.locator('#doc-blue-consent').isChecked(),false);
    assert.equal(posts.length,0);
    const out=path.resolve(process.env.QA_OUTPUT||'../handoff-ui-check');await fs.mkdir(out,{recursive:true});
    await page.screenshot({path:path.join(out,'desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile has no horizontal overflow');
    await page.screenshot({path:path.join(out,'mobile.png')});
    await page.locator('#doc-blue-next').click();
    assert.equal(await page.locator('.visual-connection-details').evaluate(e=>e.open),true);
    assert.equal(posts.length,0);
    const report={samePdfBytes:true,fileReceipt:true,thumbnail:true,nextAction:true,mobileOverflow:false,modelPosts:posts.length};
    await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

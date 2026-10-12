// Capture actual split-flap motion without relying on application globals.
const {chromium}=require(process.argv[2]),path=require('node:path'),fs=require('node:fs/promises');
const base=process.argv[3]||'http://127.0.0.1:7816/',folder=path.resolve(process.argv[4]||'.impeccable/review/cleanup');let browser;
(async()=>{
  await fs.mkdir(folder,{recursive:true});browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});await page.goto(base);
  const animations=await page.evaluate(()=>{
    const original=setTimeout,handles=[];window.setTimeout=(callback,ms,...args)=>{const handle=original(callback,ms,...args);if(ms===300)handles.push(handle);return handle;};
    document.querySelector('.rail [data-view="blue"]').click();window.setTimeout=original;handles.forEach(clearTimeout);
    window.qaFlaps=document.querySelector('.sign-message').getAnimations({subtree:true});for(const a of window.qaFlaps){a.pause();a.currentTime=60;}return window.qaFlaps.map(a=>a.animationName);
  });
  if(!animations.includes('flap-out')||!animations.includes('flap-in'))throw Error('Hinged animation missing');
  await page.locator('.wayfinding').screenshot({path:path.join(folder,'flap-060ms.png')});
  await page.evaluate(()=>window.qaFlaps.forEach(a=>a.currentTime=180));await page.locator('.wayfinding').screenshot({path:path.join(folder,'flap-180ms.png')});
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.locator('.paper-subnav [data-view="blue"]').click();
  const leaves=await page.locator('.flap-leaf').count();if(leaves)throw Error('Reduced-motion produced flap leaves');
  console.log(JSON.stringify({animations,reducedMotionLeaves:leaves}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>browser?.close());

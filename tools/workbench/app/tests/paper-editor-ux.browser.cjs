const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),out=path.resolve(process.env.FALSIFY_UI_CAPTURE_DIR||path.join(root,'.local/ux-editor-captures')),report=out;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 await fs.mkdir(out,{recursive:true}); await fs.mkdir(report,{recursive:true});
 const mupdf=await import(pathToFileURL(path.join(root,'app/dist/browser-pdf-vendor/mupdf.js')).href);
 const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
 const original='Original paragraph describes the experiment.',replacement='Revised paragraph describes the experiment.';
 for(const content of [`BT /F1 12 Tf 72 700 Td (${original}) Tj 0 -50 Td (Following paragraph remains readable.) Tj 0 -475 Td (Lower body paragraph gives the column room to grow.) Tj ET`,`BT /F1 12 Tf 72 700 Td (Second page remains intact.) Tj ET`]) d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},content));
 const buf=d.saveToBuffer(),source=Buffer.from(buf.asUint8Array());buf.destroy();d.destroy();await fs.writeFile(path.join(out,'synthetic-source.pdf'),source);
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});const results=[];
 try {for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
  const r={name,width,height,checks:{},errors:[],requests:[]};results.push(r);const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',acceptDownloads:true});const page=await context.newPage();
  page.on('pageerror',e=>r.errors.push(e.message));page.on('request',req=>{if(req.method()==='POST'||/\/api\/(?:red|blue)\/jobs/.test(req.url()))r.requests.push({method:req.method(),url:req.url()});});
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1'&&u.hostname!=='localhost')return route.fulfill({status:401,body:''});return route.continue();});
  try{
   await page.goto(process.env.FALSIFY_UI_TEST_URL||'http://127.0.0.1:7851/');await page.evaluate(()=>FalsifyVisual.ready); r.checks.initialWorkspaceHidden=!(await page.locator('#paper-workspace').isVisible());
   await page.locator('#paper-file').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:source});
   await page.locator('.paper-paragraph-button').first().waitFor({state:'attached',timeout:90000});await page.locator('#paper-before-stage .textLayer span').filter({hasText:original}).first().waitFor({state:'visible',timeout:30000});
   r.paragraphs=await page.locator('.paper-paragraph-button').allTextContents();
   const span=page.locator('#paper-before-stage .textLayer span').filter({hasText:original}).first();const editor=page.locator('.paper-page > textarea');
   // Seed a real DOM Range in the rendered PDF, then exercise each app selection event.
   // Native OS caret-browsing/drag mechanics are outside this handler contract.
   for(const type of ['pointerup','mouseup','keyup']){
    await page.locator('#paper-before-stage').focus();
    await span.evaluate((e,type)=>{const s=document.getSelection(),range=document.createRange();range.setStart(e.firstChild,0);range.setEnd(e.firstChild,8);s.removeAllRanges();s.addRange(range);if(type!=='keyup')e.dispatchEvent(new MouseEvent(type,{bubbles:true}));},type);
    if(type==='keyup')await page.keyboard.press('Shift');
    await editor.waitFor({state:'visible',timeout:3000});assert.equal(await editor.inputValue(),original.slice(0,8),'source selection uses real selected PDF text: '+type);
    await editor.press('Escape');assert.equal((await page.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot())).edits.length,0);
   }
   r.checks.sourceSelectionEventContracts=true;
   await span.click();await editor.waitFor({state:'visible'});r.checks.nativeSpanOpensCorrect=(await editor.inputValue())===original;
   const originalNode=await editor.elementHandle(), beforeSnapshot=await page.evaluate(()=>JSON.stringify(FalsifyPaperWorkspace.getEditSnapshot()));
   const assertPending=async(label)=>{assert.ok(await originalNode.evaluate(e=>e.isConnected&&document.activeElement===e),label+': same textarea remains connected and focused');assert.equal(await page.evaluate(()=>JSON.stringify(FalsifyPaperWorkspace.getEditSnapshot())),beforeSnapshot,label+': no committed edit');};
   await originalNode.evaluate(e=>{e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true}));e.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,isComposing:true}));e.dispatchEvent(new FocusEvent('blur'));});
   await assertPending('simulated IME event protection');
   await originalNode.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한'})));
   await assertPending('simulated IME completion');r.checks.simulatedImeEventProtection=true;
   await editor.press('Control+A');
   let typed='';for(const ch of 'Sustained typing'){await page.keyboard.type(ch);typed+=ch;await assertPending('typing '+typed);assert.equal(await originalNode.inputValue(),typed);}
   // A real click emits pointerup and mouseup; keyboard selection stays inside the textarea.
   await editor.click({position:{x:10,y:10}});await assertPending('caret click');
   await editor.press('End');await editor.press('Shift+ArrowLeft');await assertPending('textarea selection');
   assert.ok(await originalNode.evaluate(e=>e.selectionStart<e.selectionEnd),'native textarea selection exists');
   await editor.press('End');await editor.press('Enter');await assertPending('multiline Enter');
   await page.keyboard.type('Second line');await assertPending('multiline typing');assert.ok((await originalNode.inputValue()).includes('\nSecond line'));
   const beforeUndo=await originalNode.inputValue();await editor.press('Control+Z');await assertPending('native undo');assert.notEqual(await originalNode.inputValue(),beforeUndo,'Ctrl+Z performs native textarea undo');
   await editor.press('Control+A');typed='';for(const ch of replacement){await page.keyboard.type(ch);typed+=ch;await assertPending('replacement '+typed);assert.equal(await originalNode.inputValue(),typed);}
   r.checks.sustainedTyping=true;r.checks.caretSelectionMultilineUndo=true;
   r.layout=await page.evaluate(()=>{const e=document.querySelector('.paper-page > textarea'),p=e.parentElement,a=e.getBoundingClientRect(),b=p.getBoundingClientRect();return {position:getComputedStyle(e).position,editor:{left:a.left,top:a.top,right:a.right,bottom:a.bottom,width:a.width},page:{left:b.left,top:b.top,right:b.right,bottom:b.bottom},viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};});
   await page.screenshot({path:path.join(out,name+'-editing.png'),fullPage:true});
   r.checks.layout=r.layout.position==='absolute'&&r.layout.scrollWidth<=width&&r.layout.editor.left>=Math.max(0,r.layout.page.left)-1&&r.layout.editor.right<=Math.min(width,r.layout.page.right)+1&&r.layout.editor.top>=r.layout.page.top-1&&r.layout.editor.bottom<=r.layout.page.bottom+1;
   await editor.press('Tab');r.snapshot=await page.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot());r.checks.humanProvenance=r.snapshot.edits.length===1&&r.snapshot.edits[0].origin==='human';
   const edit=page.locator('#paper-edits [data-act=edit]').first();await edit.click();await editor.waitFor({state:'visible'});r.checks.dirtyPreserved=(await editor.inputValue())===replacement;r.checks.reopenSaved=r.checks.dirtyPreserved;r.checks.noAfterButton=await page.getByRole('button',{name:'After 수정',exact:true}).count()===0;
   const savedSnapshot=await page.evaluate(()=>JSON.stringify(FalsifyPaperWorkspace.getEditSnapshot()));const cancelNode=await editor.elementHandle();await editor.press('Control+A');for(const ch of 'Cancelled text'){await page.keyboard.type(ch);assert.ok(await cancelNode.evaluate(e=>e.isConnected&&document.activeElement===e));assert.equal(await page.evaluate(()=>JSON.stringify(FalsifyPaperWorkspace.getEditSnapshot())),savedSnapshot);}await editor.press('Escape');r.checks.closeFocus=await edit.evaluate(e=>document.activeElement===e);r.checks.escapeCancels=(await page.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot())).edits[0].after===replacement;
   await edit.click();await editor.waitFor({state:'visible'});await editor.press('End');await page.keyboard.type('!');await page.locator('#paper-before-status').click();assert.equal((await page.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot())).edits[0].after,replacement+'!','outside click commits');r.checks.outsideClickCommit=true;
   await edit.click();await editor.waitFor({state:'visible'});await editor.press('End');await editor.press('Backspace');await editor.press('Tab');assert.equal((await page.evaluate(()=>FalsifyPaperWorkspace.getEditSnapshot())).edits[0].after,replacement);
   await page.locator('.paper-paragraph-list summary').click();const second=page.locator('.paper-paragraph-button').filter({hasText:'Following paragraph'}).first();await second.focus();await page.keyboard.press('Enter');await editor.waitFor({state:'visible'});r.checks.keyboardParagraph=(await editor.inputValue()).includes('Following paragraph');await editor.press('Escape');
   await page.locator('#paper-generate').click();await page.waitForFunction(()=>FalsifyPaperWorkspace.getOutput()||/생성하지 못했습니다/.test(document.querySelector('#paper-generate-status').textContent),null,{timeout:120000});r.generationStatus=await page.locator('#paper-generate-status').innerText();const metadata=await page.evaluate(()=>{const o=FalsifyPaperWorkspace.getOutput();return o&&{sha256:o.sha256,originalSourceSha256:o.originalSourceSha256,verification:o.verification};});r.output=metadata;r.checks.generated=!!metadata;
   if(metadata){const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#paper-current-download').click()]);const downloadPath=path.join(out,name+'-output.pdf');await download.saveAs(downloadPath);const bytes=await fs.readFile(downloadPath);r.downloadSha256=sha(bytes);r.checks.hashMatches=r.downloadSha256===metadata.sha256;r.checks.sourceUnchanged=metadata.originalSourceSha256===sha(source)&&sha(await fs.readFile(path.join(out,'synthetic-source.pdf')))===sha(source)&&sha(Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await FalsifyPaperWorkspace.getSource().file.arrayBuffer())))))===sha(source);const pdf=mupdf.Document.openDocument(bytes,'application/pdf');r.outputTexts=[];for(let i=0;i<pdf.countPages();i++){const p=pdf.loadPage(i),st=p.toStructuredText();r.outputTexts.push(st.asText());st.destroy();p.destroy();}pdf.destroy();r.checks.outputText=r.outputTexts[0].includes(replacement)&&r.outputTexts[0].includes('Following paragraph remains readable.')&&r.outputTexts[1]?.includes('Second page remains intact.');}
  }catch(e){r.failure=String(e.stack||e);try{r.status=await page.locator('#paper-before-status').innerText();r.genStatus=await page.locator('#paper-generate-status').innerText();}catch{} }
  r.checks.noPostOrModelJobs=r.requests.length===0;r.checks.noPageErrors=r.errors.length===0;await context.close();
 }}finally{await browser.close();}
 const result={command:'node app/tests/paper-editor-ux.browser.cjs',sourceSha256:sha(source),results,limitations:['Synthetic PDF and isolated headless desktop/mobile viewports; virtual keyboard and real device not tested.','Screenshots require independent human visual review.','Composition events are simulated handler checks; real OS Korean IME and physical touch/caret browsing are not tested.']};await fs.writeFile(path.join(report,'browser-result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(report,'browser-result.md'),'# Browser QA\n\nCommand: `node app/tests/paper-editor-ux.browser.cjs`\n\n'+results.map(r=>`## ${r.name}\n\nChecks: ${JSON.stringify(r.checks)}\n\nFailure: ${r.failure||'none'}\n\nGeneration: ${r.generationStatus||'not reached'}\n\nScreenshot: ${path.join(out,r.name+'-editing.png')}\n`).join('\n')+'\nVirtual keyboard and real device not tested. Screenshots require human visual review. See browser-result.json for actual observations.\n');console.log(JSON.stringify(result,null,2));if(results.some(r=>r.failure||Object.values(r.checks).includes(false)))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});

/* Final-output preview: draws the exact downloaded, hash-verified PDF File on a local canvas with the vendored PDF.js.
   No iframe/object (CSP), no network or remote fonts; every async step is bound to one show() and dropped once stale. */
export const MAX_BYTES=64*1024*1024;
const MAX_SIDE=4096,MAX_PIXELS=4096*4096,MAX_SCALE=2,LOAD_MS=60000,HEX=/^[0-9a-f]{64}$/;
const KEEP=' 다운로드한 사본과 해시는 그대로 유효하며, 「같은 사본 다시 다운로드」로 같은 파일을 다시 받을 수 있습니다.';
// Fixed messages only: engine and PDF.js error text can carry document content, so it is never echoed.
const FAILURE={PasswordException:'암호가 걸린 PDF라 미리보기를 그리지 못했습니다.',InvalidPDFException:'PDF 구조를 읽지 못해 미리보기를 그리지 못했습니다.',timeout:'60초 안에 PDF를 열지 못해 미리보기를 멈췄습니다.'};
const hex=buffer=>Array.from(new Uint8Array(buffer),x=>x.toString(16).padStart(2,'0')).join('');
export function defaultImport(){return import('./vendor/pdf.mjs');}
// Same local-only options as extraction: data bytes only, vendored cmaps/fonts/wasm, no eval, no font-face injection, no streaming.
export function pdfParams(bytes,base){const local=p=>new URL('./vendor/'+p,base).href;
  return {data:bytes,isEvalSupported:false,disableAutoFetch:true,disableStream:true,disableRange:true,disableFontFace:true,enableXfa:false,verbosity:0,
    cMapUrl:local('cmaps/'),cMapPacked:true,standardFontDataUrl:local('standard_fonts/'),wasmUrl:local('wasm/')};}
// Fit the stage width at up to 2x device pixels, bounded per side and in total area so one huge page cannot exhaust memory.
export function fitScale(page,width,ratio){const w=page.width,h=page.height;if(!(w>0&&h>0))return 0;
  let s=Math.min((width>0?width:720)/w,MAX_SCALE)*Math.min(Math.max(ratio||1,1),2);s=Math.min(s,MAX_SIDE/w,MAX_SIDE/h,Math.sqrt(MAX_PIXELS/(w*h)));return Number.isFinite(s)&&s>0?s:0;}
export function createPreview({document:d=globalThis.document,importPdf=defaultImport,maxBytes=MAX_BYTES,subtle=globalThis.crypto?.subtle,urls=globalThis.URL,ratio=()=>globalThis.devicePixelRatio||1,timers=globalThis}={}){
  const $=id=>d.querySelector('#red-preview'+id),root=$('');
  if(!root)return {show:async()=>{},clear(){},current:()=>null};
  const ui={stage:$('-stage'),status:$('-status'),page:$('-page'),hash:$('-hash'),prev:$('-prev'),next:$('-next'),download:$('-download')};
  let state=null;
  const say=(text,error=false)=>{ui.status.textContent=text;ui.status.classList.toggle('error',error);};
  // A focused prev/next that becomes disabled at a page boundary would drop keyboard focus to <body>; hand it to the opposite button instead.
  function nav(){const s=state,ready=!!s?.doc,active=d.activeElement;
    ui.prev.disabled=!ready||s.page<=1;ui.next.disabled=!ready||s.page>=s.pages;ui.download.disabled=!s||!s.downloadable;
    ui.page.textContent=ready?s.page+' / '+s.pages+'쪽':'';
    if(active===ui.next&&ui.next.disabled&&!ui.prev.disabled)ui.prev.focus();else if(active===ui.prev&&ui.prev.disabled&&!ui.next.disabled)ui.next.focus();}
  function wipe(){for(const c of ui.stage.children||[]){c.width=0;c.height=0;}ui.stage.replaceChildren();}
  // Stop releases everything the old show owned: pending render, PDF.js document/worker and the load timer.
  function stop(s){if(!s)return;s.stale=true;timers.clearTimeout(s.timer);timers.clearTimeout(s.pageTimer);s.render?.cancel();s.render=null;const task=s.task;s.task=null;s.doc=null;if(task)void Promise.resolve().then(()=>task.destroy()).catch(()=>{});}
  function clear(){const s=state;state=null;stop(s);root.hidden=true;wipe();say('');ui.hash.textContent='';nav();}
  function fail(s,error){if(state!==s||s.failed)return;s.failed=true;stop(s);wipe();say((FAILURE[error?.name]||'이 브라우저에서 미리보기를 그리지 못했습니다.')+(s.downloadable?KEEP:''),true);nav();}
  async function show({file,sha256,changes=[]}={}){
    clear();if(!file||typeof sha256!=='string'||!HEX.test(sha256))return;
    const s={file,sha256,changes:changes.map(c=>({...c})),page:1,pages:0,seq:0,doc:null,task:null,render:null,timer:null,pageTimer:null,stale:false,downloadable:false};state=s;
    root.hidden=false;ui.hash.textContent='SHA-256 '+sha256;nav();
    if(!(file.size>0&&file.size<=maxBytes)){s.downloadable=true;say(file.size>maxBytes?'출력 사본이 64 MiB를 넘어 미리보기를 생략했습니다.'+KEEP:'빈 출력 사본이라 미리보기를 그리지 않았습니다.',file.size<=0);nav();return;}
    say('다운로드한 사본의 바이트와 해시를 다시 확인하는 중입니다.');
    try{const bytes=new Uint8Array(await file.arrayBuffer());if(state!==s)return;
      if(bytes.length!==file.size||hex(await subtle.digest('SHA-256',bytes))!==sha256){if(state!==s)return;say('미리보기용으로 다시 읽은 바이트가 검증된 해시와 달라 그리지 않았습니다. 이 화면의 다시 다운로드도 막았습니다.',true);return;}
      if(state!==s)return;s.downloadable=true;nav();
      if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0){say('PDF 서명이 없어 미리보기를 그리지 않았습니다.'+KEEP,true);return;}
      say('검증된 사본을 이 브라우저에서 여는 중입니다.');const lib=await importPdf();if(state!==s)return;
      if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',d.baseURI).href;
      // PDF.js transfers (detaches) the buffer it is given; these bytes are a fresh read of the File, which itself stays intact for download/BLUE.
      const task=lib.getDocument(pdfParams(bytes,d.baseURI));s.task=task;
      s.timer=timers.setTimeout(()=>fail(s,{name:'timeout'}),LOAD_MS);
      const doc=await task.promise;if(state!==s||s.stale)return;timers.clearTimeout(s.timer);
      if(!(Number.isSafeInteger(doc.numPages)&&doc.numPages>0))throw new Error('no pages');
      s.doc=doc;s.pages=doc.numPages;await draw(s,1);
    }catch(error){if(state===s&&!s.stale)fail(s,error);}
  }
  // One page at a time into a fresh canvas that replaces the visible one only when it finished for the current page.
  // getPage+render share one 60 s bound; on expiry the render is cancelled and this draw is retired (seq), so a late finish never paints.
  async function draw(s,n){
    if(state!==s||!s.doc||!Number.isSafeInteger(n)||n<1||n>s.pages)return;
    s.render?.cancel();s.render=null;timers.clearTimeout(s.pageTimer);s.page=n;const mine=++s.seq,live=()=>state===s&&!s.stale&&s.seq===mine;nav();say(n+' / '+s.pages+'쪽을 그리는 중입니다.');
    s.pageTimer=timers.setTimeout(()=>{if(!live())return;s.seq++;s.render?.cancel();s.render=null;wipe();say(n+'쪽을 60초 안에 그리지 못해 멈췄습니다. 다른 쪽은 이전·다음으로 시도할 수 있습니다.'+KEEP,true);},LOAD_MS);
    let canvas=null,page=null;
    try{page=await s.doc.getPage(n);if(!live())return;
      const scale=fitScale(page.getViewport({scale:1}),ui.stage.clientWidth,ratio());if(!scale)throw new Error('page size');
      const viewport=page.getViewport({scale});canvas=d.createElement('canvas');canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
      const context=canvas.getContext('2d');if(!context)throw new Error('canvas');
      const task=page.render({canvasContext:context,canvas,viewport});s.render=task;await task.promise;if(!live()){canvas.width=0;canvas.height=0;if(!s.stale)page.cleanup();return;}
      s.render=null;canvas.className='red-preview-canvas';canvas.setAttribute('role','img');canvas.setAttribute('aria-label','다운로드한 사본 '+n+'쪽 미리보기 (전체 '+s.pages+'쪽). 이미지이므로 글자 단위로 읽을 수 없습니다.');
      wipe();ui.stage.append(canvas);say(n+' / '+s.pages+'쪽 · 다운로드한 바이트 그대로 이 브라우저에서 그렸습니다.');
      const marks=globalThis.FalsifyChangeMarks;
      // Find After on the actual rendered output page (pagination may differ from the source).
      if(marks&&s.changes.length){
        const content=await page.getTextContent();if(!live())return;
        const lib=await importPdf();if(!live())return;
        if(lib.TextLayer){
          const surface=d.createElement('div'),text=d.createElement('div');surface.className='red-preview-mark-surface paper-page';text.className='paper-text-layer textLayer';
          surface.style.width=viewport.width+'px';surface.style.height=viewport.height+'px';surface.style.setProperty('--preview-mark-scale',String(canvas.getBoundingClientRect().width/canvas.width));surface.style.setProperty('--total-scale-factor',String(scale));surface.style.setProperty('--scale-round-x','1px');surface.style.setProperty('--scale-round-y','1px');surface.style.setProperty('--text-scale-factor','1');
          surface.append(text);ui.stage.append(surface);
          const layer=new lib.TextLayer({textContentSource:content,container:text,viewport});await layer.render();if(!live()){layer.cancel?.();return;}
          marks.paintPage({document:d,container:surface,items:content.items,divs:layer.textDivs,edits:s.changes,side:'after'});text.remove();
        }
      }
      page.cleanup();
    }catch(error){if(canvas){canvas.width=0;canvas.height=0;}if(!live()||error?.name==='RenderingCancelledException')return;s.render=null;
      wipe();say(n+'쪽을 그리지 못했습니다. 다른 쪽은 이전·다음으로 시도할 수 있습니다.'+KEEP,true);}
    finally{if(s.seq===mine)timers.clearTimeout(s.pageTimer);}
  }
  ui.prev.addEventListener('click',()=>{if(state?.doc)void draw(state,state.page-1);});
  ui.next.addEventListener('click',()=>{if(state?.doc)void draw(state,state.page+1);});
  // Repeat download hands back the same File object the export verified (and the BLUE handoff uses); nothing is regenerated.
  ui.download.addEventListener('click',()=>{const s=state;if(!s?.downloadable)return;const url=urls.createObjectURL(s.file),a=d.createElement('a');a.href=url;a.download=s.file.name;d.body.append(a);a.click();a.remove();timers.setTimeout(()=>urls.revokeObjectURL(url),1000);});
  clear();
  return {show,clear,current:()=>state&&{file:state.file,sha256:state.sha256,page:state.page,pages:state.pages,downloadable:state.downloadable}};
}

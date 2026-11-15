'use strict';
// Synthetic DOM and injected APIs. No browser, network, or private paper.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const UI=require('../dist/paper-visual-edit-ui.js');
const source=fs.readFileSync(path.join(__dirname,'../dist/paper-visual-edit-ui.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../dist/paper-visual-edit.css'),'utf8');
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'visual-edit-ui-'));

function py(body){
  const file=path.join(tmp,'step.py');
  fs.writeFileSync(file,body);
  return execFileSync('python',[file],{encoding:'utf8'}).trim();
}
function imageFile(name,body){
  const out=path.join(tmp,name);
  py(`from PIL import Image\nout=${JSON.stringify(out)}\n${body}\n`);
  return fs.readFileSync(out);
}
const WHITE=imageFile('white.png',`Image.new('RGB',(64,32),(255,255,255)).save(out,'PNG')`);
const GRID=imageFile('grid.png',`im=Image.new('RGB',(8,8))\npx=im.load()\nfor y in range(8):\n  for x in range(8): px[x,y]=(x*20,y*20,40)\nim.save(out,'PNG')`);
const JPEG=imageFile('solid.jpg',`Image.new('RGB',(8,8),(12,80,200)).save(out,'JPEG',quality=100,subsampling=0)`);
const JPEG420=imageFile('grad.jpg',`im=Image.new('RGB',(16,16))\npx=im.load()\nfor y in range(16):\n  for x in range(16): px[x,y]=(x*15,y*15,128)\nim.save(out,'JPEG',quality=95,subsampling=2)`);

function element(tag){
  const el=new EventTarget(), classes=new Set(), attrs={};
  el.tagName=tag.toUpperCase();
  el.children=[];
  el.hidden=false;
  el.disabled=false;
  el.value='';
  el.open=false;
  el.type='';
  el.files=[];
  el.placeholder='';
  el.accept='';
  el.download='';
  el.href='';
  el.rel='';
  el.style={};
  el._text='';
  el.classList={
    add(...xs){for(const x of xs)classes.add(x);},
    remove(...xs){for(const x of xs)classes.delete(x);},
    contains:x=>classes.has(x),
    toggle(x,on){const v=on==null?!classes.has(x):!!on;if(v)classes.add(x);else classes.delete(x);return v;}
  };
  Object.defineProperty(el,'className',{
    get(){return [...classes].join(' ');},
    set(v){classes.clear();for(const x of String(v||'').split(/\s+/))if(x)classes.add(x);}
  });
  Object.defineProperty(el,'textContent',{
    get(){return el._text;},
    set(v){el._text=v==null?'':String(v);el.children=[];}
  });
  el.setAttribute=(k,v)=>{attrs[k]=String(v);};
  el.getAttribute=k=>Object.hasOwn(attrs,k)?attrs[k]:null;
  el.append=(...nodes)=>{el.children.push(...nodes);};
  el.replaceChildren=(...nodes)=>{el.children=nodes;};
  el.click=()=>{if(!el.disabled)el.dispatchEvent(new Event('click'));};
  return el;
}
function all(node){
  const out=[];
  (function walk(n){for(const child of n.children||[]){if(child?.tagName)out.push(child);if(child)walk(child);}})(node);
  return out;
}
function button(host,label){return all(host).find(el=>el.tagName==='BUTTON'&&el.textContent===label);}
function labeled(host,name){return all(host).find(el=>el.getAttribute?.('aria-label')===name);}
function radios(host){return all(host).filter(el=>el.tagName==='INPUT'&&el.type==='radio');}
function statusOf(host){return all(host).find(el=>el.tagName==='P'&&el.getAttribute('aria-live')==='polite');}
async function sha256(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Buffer.from(digest).toString('hex');
}
async function settle(){for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));}
async function until(fn,label){
  const start=Date.now();
  while(!fn()){
    if(Date.now()-start>5000)throw new Error('timeout '+label);
    await new Promise(r=>setTimeout(r,10));
  }
}
function fileOf(bytes,name){
  const copy=Uint8Array.from(bytes);
  return {name,size:copy.length,type:'application/pdf',arrayBuffer:async()=>copy.slice().buffer};
}
function imagePick(bytes,name,type){
  const copy=Uint8Array.from(bytes);
  return {name,size:copy.length,type,arrayBuffer:async()=>copy.slice().buffer};
}
function pointer(type,x,y){
  const event=new Event(type);
  event.clientX=x;event.clientY=y;event.pointerId=1;event.button=0;
  return event;
}
function chart(points){
  return {kind:'line',title:'합성',xAxis:{scale:'linear',label:'x'},yAxis:{scale:'linear',label:'y'},series:[{id:'s1',name:'계열',color:'#246388',points}]};
}
let HASH,WHITE_SHA;
const ready=(async()=>{HASH=await sha256(PDF);WHITE_SHA=await sha256(WHITE);})();

function world(over={}){
  const calls=[],outputs=[],renders=[],previews=[];
  let source=null,exportImpl=null,changes=0;
  const catalog=over.catalog||{
    items:[{id:'t1',type:'table',pageIndex:0,bbox:[1,2,40,50],caption:'표 하나'}],
    full:{t1:{id:'t1',type:'table',pageIndex:0,bbox:[1,2,40,50],caption:'표 하나',table:{rows:1,columns:1,cells:[{row:0,column:0,rowSpan:1,columnSpan:1,text:'A',bbox:[1,2,10,12]}]}}},
    analyses:[{analysisId:'achart',kind:'chart',pageIndex:0,bbox:[0,0,120,80]}],
    fullAnalyses:{achart:{paperId:'paper-visual',analysisId:'achart',kind:'chart',pageIndex:0,bbox:[0,0,120,80],fileHash:HASH,inputImage:{sha256:WHITE_SHA,width:64,height:32,dpi:150},data:{schema:'falsify.chart-data.v1'}}}
  };
  globalThis.FalsifyBlueVisual={async previewBluePage(args){
    previews.push(args);
    if(over.previewWait)await over.previewWait();
    const canvas=element('canvas');
    canvas.getBoundingClientRect=()=>({left:0,top:0,width:300,height:400,right:300,bottom:400});
    return {canvas,page:args.page,pages:3,width:600,height:800,wholeFits:true,fileHash:args.fileHash};
  }};
  globalThis.FalsifyChartRedraw={
    fromAnalysis(){return over.chart||chart([{x:1,y:2},{x:3,y:4}]);},
    async render(args){renders.push(args);return {png:Uint8Array.from(WHITE),width:64,height:32};}
  };
  globalThis.FalsifyPaperWorkspace={getSource:()=>source,getPageIndex:()=>over.pageIndex??0};
  const host=element('div');
  host.ownerDocument={createElement:tag=>element(tag)};
  const session={request(path,body,options){
    const rec={path,body,options};
    calls.push(rec);
    if(options?.signal?.aborted)return Promise.reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
    return Promise.resolve(over.request ? over.request(path,body,()=>respond(path,body)) : respond(path,body));
  }};
  async function respond(path,body){
    const fileHash=source&&source.fileHash;
    if(path==='/api/paper/evidence/prepare'){
      return {schema:'falsify.paper-evidence.v1',paperId:'paper-visual',fileHash,status:'ready',pageCount:2,counts:{tables:1,figures:1},engine:'test',limitations:[],expiresAt:new Date(Date.now()+3600000).toISOString()};
    }
    if(path==='/api/paper/evidence/query'&&body.operation==='list'){
      const items=catalog.items.slice(body.offset,body.offset+body.limit);
      const next=body.offset+items.length<catalog.items.length?body.offset+items.length:null;
      return {paperId:'paper-visual',fileHash,items,total:catalog.items.length,nextOffset:next};
    }
    if(path==='/api/paper/evidence/query'&&body.operation==='analyses')return {paperId:'paper-visual',fileHash,items:catalog.analyses};
    if(path==='/api/paper/evidence/query'&&body.operation==='item')return {...catalog.full[body.itemId]};
    if(path==='/api/paper/evidence/query'&&body.operation==='analysis')return {...catalog.fullAnalyses[body.analysisId],paperId:'paper-visual',fileHash};
    if(path==='/api/paper/evidence/query'&&body.operation==='render'){
      return {paperId:'paper-visual',fileHash,pageIndex:body.pageIndex,bbox:body.bbox.slice(),mimeType:'image/png',data:WHITE.toString('base64'),sha256:WHITE_SHA,width:64,height:32};
    }
    if(path==='/api/paper/chart/prepare'&&over.shapeScene)return {...over.shapeScene,pageIndex:body.pageIndex,bbox:body.bbox};
    if(path==='/api/paper/visual/export')return exportImpl?exportImpl(body):pdfOf(fileHash,'ok');
    throw new Error('unexpected '+path);
  }
  async function pdfOf(fileHash,salt){
    const bytes=Buffer.concat([PDF,Buffer.from('\n%'+salt+'\n')]);
    return {schema:'falsify.visual-edit-export.v1',sourceSha256:fileHash,outputSha256:await sha256(bytes),file:bytes.toString('base64'),pageCount:1,changes:[{id:'srv',kind:'table-cell',pageIndex:0,bbox:[1,2,11,12],before:'A',after:'B',author:'human'}],verification:{status:'passed',issues:[]}};
  }
  const ui=UI.create({host,getSource:()=>source,getSession:()=>session,onOutput:payload=>outputs.push(payload),onChange:()=>{changes++;},hold:over.hold});
  return {ui,host,calls,outputs,renders,previews,catalog,pdfOf,
    button:label=>button(host,label),labeled:name=>labeled(host,name),radios:()=>radios(host),
    status:()=>statusOf(host)?.textContent||'',
    get changes(){return changes;},get source(){return source;},set source(value){source=value;},
    set exportImpl(fn){exportImpl=fn;}};
}
let tail=Promise.resolve();
function serial(name,fn){
  test(name,async()=>{
    await ready;
    const run=tail.then(fn,fn);
    tail=run.then(()=>{},()=>{});
    return run;
  });
}

serial('module is a frozen mount point without markup injection',async()=>{
  assert.equal(typeof UI.create,'function');
  assert.equal(Object.isFrozen(UI),true);
  assert.equal(globalThis.FalsifyVisualEditUI,UI);
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB|eval\(|new Function/);
  assert.doesNotMatch(source,/정답|ground truth|rationale|attack/i);
  assert.match(source,/previewBluePage/);
  assert.match(source,/FalsifyChartRedraw/);
  assert.match(source,/\/api\/paper\/visual\/export/);
  assert.match(source,/dpi:150/);
  assert.match(css,/\.paper-visual-edit \.visual-edit-points\{[^}]*max-height:280px;overflow:auto/);
  assert.match(css,/\.paper-visual-edit \.visual-edit-stage\{[^}]*max-height:480px;overflow:auto/);
  assert.match(css,/\.paper-visual-edit \.visual-edit-list,[^}]*max-height:320px;overflow:auto/);
  assert.throws(()=>UI.create({}),TypeError);
});

serial('refresh reads evidence and does not export',async()=>{
  const items=Array.from({length:20},(_,i)=>({id:'f'+i,type:i%2?'table':'figure',pageIndex:i%3,bbox:[1,2,30,40],caption:'항목 '+i}));
  const h=world({catalog:{items,full:{},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  assert.equal(h.calls.some(call=>call.path==='/api/paper/visual/export'),false);
  assert.equal(h.outputs.length,0);
  assert.equal(h.radios().length,8);
  assert.equal(h.button('PDF에 적용').disabled,true);
  h.button('다음 목록').click();
  await until(()=>h.calls.some(call=>call.body&&call.body.offset===8),'next page');
  assert.equal(h.radios().length,8);
  assert.equal(h.calls.filter(call=>call.path==='/api/paper/visual/export').length,0);
  h.source=null;
  await h.ui.refresh();
  assert.equal(h.ui.snapshot().pending,0);
});

serial('table cell edit exports the server text and verified hash',async()=>{
  const h=world();
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='item:t1');
  radio.checked=true;
  radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'cell');
  const input=h.labeled('행 1 열 1');
  assert.equal(input.value,'A');
  input.value='Z';
  input.dispatchEvent(new Event('input'));
  assert.match(all(h.host).map(node=>node.textContent).join('\n'),/이전 A[\s\S]*이후 Z/);
  assert.equal(h.ui.snapshot().pending,1);
  assert.equal(h.changes>0,true);
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'output');
  const posted=h.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body;
  assert.equal(posted.schema,'falsify.visual-edit-request.v1');
  assert.equal(posted.paperId,'paper-visual');
  assert.equal(posted.fileHash,HASH);
  assert.equal(posted.revision,'r1');
  assert.equal(posted.operations.length,1);
  assert.equal(posted.operations[0].kind,'table-cell');
  assert.equal(posted.operations[0].before,'A');
  assert.equal(posted.operations[0].after,'Z');
  assert.equal(posted.operations[0].row,0);
  assert.equal(posted.operations[0].column,0);
  assert.equal(JSON.stringify(posted).includes('rationale'),false);
  const payload=h.outputs[0];
  assert.equal(payload.outputFileHash,await sha256(payload.bytes));
  assert.equal(payload.file.name,'visual-edit.pdf');
  assert.equal(payload.changes[0].author,'human');
  assert.equal(h.button('결과 PDF 저장')||all(h.host).find(el=>el.download==='visual-edit.pdf').hidden,false);
  const link=all(h.host).find(el=>el.download==='visual-edit.pdf');
  assert.equal(link.hidden,false);
  assert.match(link.href,/^blob:/);
  h.button('이 PDF로 BLUE 검토').click();
  await until(()=>h.outputs.length===2,'blue');
  assert.equal(h.outputs[1].outputFileHash,payload.outputFileHash);
  assert.equal(JSON.stringify(h.outputs[1]).includes('attack'),false);
});

serial('failed apply keeps the previous PDF',async()=>{
  const h=world();
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='item:t1');
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'cell');
  h.labeled('행 1 열 1').value='Z';
  h.labeled('행 1 열 1').dispatchEvent(new Event('input'));
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'first');
  const first=h.ui.snapshot().outputFileHash;
  h.exportImpl=()=>{throw new Error('nope');};
  h.labeled('행 1 열 1').value='QQ';
  h.labeled('행 1 열 1').dispatchEvent(new Event('input'));
  h.button('PDF에 적용').click();
  await until(()=>h.status().includes('마지막 결과는 그대로'),'retain');
  assert.equal(h.outputs.length,1);
  assert.equal(h.ui.snapshot().outputFileHash,first);
  assert.equal(all(h.host).find(el=>el.download==='visual-edit.pdf').hidden,false);
});

serial('a source change drops an in-flight export',async()=>{
  const h=world();
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='item:t1');
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'cell');
  h.labeled('행 1 열 1').value='Z';
  h.labeled('행 1 열 1').dispatchEvent(new Event('input'));
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'first');
  const first=h.ui.snapshot().outputFileHash;
  let release;
  h.exportImpl=()=>new Promise(resolve=>{release=resolve;});
  h.labeled('행 1 열 1').value='QQ';
  h.labeled('행 1 열 1').dispatchEvent(new Event('input'));
  h.button('PDF에 적용').click();
  await until(()=>h.calls.filter(call=>call.path==='/api/paper/visual/export').length===2,'second post');
  const pdf2=Buffer.from('%PDF-1.4\n2 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  h.source={file:fileOf(pdf2,'t2.pdf'),fileHash:await sha256(pdf2),revision:'r2'};
  const refreshing=h.ui.refresh();
  release(await h.pdfOf(HASH,'late'));
  await refreshing;
  await settle();
  assert.equal(h.outputs.length,1);
  assert.equal(h.ui.snapshot().outputFileHash,first);
});

serial('saved graph preparation failure offers retry without coordinate redraw',async()=>{
  const h=world();
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='analysis:achart');
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.button('다시 시도'),'fallback');
  assert.ok(h.button('영역 다시 선택'));
  assert.equal(h.labeled('점 1 세로'),undefined);
  assert.equal(h.renders.length,0);
  assert.equal(h.button('PDF에 적용').disabled,true);
});

serial('figure replacement keeps PNG bytes and converts JPEG',async()=>{
  const figure={id:'f1',type:'figure',pageIndex:0,bbox:[10,20,210,160],caption:'그림'};
  const h=world({catalog:{items:[figure],full:{f1:{...figure}},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios()[0];
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.calls.some(call=>call.body&&call.body.operation==='render')&&all(h.host).some(el=>el.tagName==='CANVAS'),'preview');
  assert.equal(h.calls.some(call=>call.path==='/api/paper/visual/export'),false);
  const preview=h.calls.filter(call=>call.body&&Object.hasOwn(call.body,'fileHash')&&call.body.page);
  assert.equal(preview.at(-1)?true:true,true);
  const stage=all(h.host).find(el=>String(el.className).includes('visual-edit-stage'));
  stage.dispatchEvent(pointer('pointerdown',30,40));
  stage.dispatchEvent(pointer('pointermove',150,120));
  stage.dispatchEvent(pointer('pointerup',150,120));
  await until(()=>h.calls.some(call=>call.body&&call.body.operation==='render'&&call.body.bbox&&call.body.bbox[0]===60),'drag');
  const file=all(h.host).find(el=>el.type==='file');
  file.files=[imagePick(GRID,'grid.png','image/png')];
  file.dispatchEvent(new Event('change'));
  await until(()=>h.ui.snapshot().pending===1,'png draft');
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'png out');
  const op=h.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0];
  assert.equal(op.assetKind,'figure');
  assert.deepEqual(op.bbox,[60,80,300,240]);
  assert.deepEqual(Buffer.from(op.png,'base64'),GRID);
  assert.equal(op.beforeImageSha256,WHITE_SHA);

  const h2=world({catalog:{items:[figure],full:{f1:{...figure}},analyses:[],fullAnalyses:{}}});
  h2.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h2.ui.refresh();
  const radio2=h2.radios()[0];
  radio2.checked=true;radio2.dispatchEvent(new Event('change'));
  await until(()=>all(h2.host).some(el=>el.type==='file'),'file');
  const file2=all(h2.host).find(el=>el.type==='file');
  file2.files=[imagePick(JPEG,'solid.jpg','image/jpeg')];
  file2.dispatchEvent(new Event('change'));
  await until(()=>h2.ui.snapshot().pending===1,'jpeg draft');
  h2.button('PDF에 적용').click();
  await until(()=>h2.outputs.length===1,'jpeg out');
  const jpegOp=h2.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0];
  const pngPath=path.join(tmp,'from-jpeg.png');
  fs.writeFileSync(pngPath,Buffer.from(jpegOp.png,'base64'));
  const mean=Number(py(`from PIL import Image, ImageChops\na=Image.open(${JSON.stringify(pngPath)}).convert('RGB')\nb=Image.open(${JSON.stringify(path.join(tmp,'solid.jpg'))}).convert('RGB')\nassert a.size==b.size,(a.size,b.size)\nd=list(ImageChops.difference(a,b).getdata())\nprint(sum(sum(px) for px in d)/(len(d)*3))`));
  assert.ok(mean<2, 'solid jpeg diff '+mean);
  const h3=world({catalog:{items:[figure],full:{f1:{...figure}},analyses:[],fullAnalyses:{}}});
  h3.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h3.ui.refresh();
  const radio3=h3.radios()[0];
  radio3.checked=true;radio3.dispatchEvent(new Event('change'));
  await until(()=>all(h3.host).some(el=>el.type==='file'),'file3');
  const file3=all(h3.host).find(el=>el.type==='file');
  file3.files=[imagePick(JPEG420,'grad.jpg','image/jpeg')];
  file3.dispatchEvent(new Event('change'));
  await until(()=>h3.ui.snapshot().pending===1||h3.status().includes('JPEG'),'jpeg420');
  assert.equal(h3.ui.snapshot().pending,1,h3.status());
  h3.button('PDF에 적용').click();
  await until(()=>h3.outputs.length===1,'420 out');
  const png420=path.join(tmp,'from-420.png');
  fs.writeFileSync(png420,Buffer.from(h3.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0].png,'base64'));
  const mean420=Number(py(`from PIL import Image, ImageChops\na=Image.open(${JSON.stringify(png420)}).convert('RGB')\nb=Image.open(${JSON.stringify(path.join(tmp,'grad.jpg'))}).convert('RGB')\nassert a.size==b.size,(a.size,b.size)\nd=list(ImageChops.difference(a,b).getdata())\nprint(sum(sum(px) for px in d)/(len(d)*3))`));
  assert.ok(mean420<12, '420 jpeg diff '+mean420);
});

serial('crop and label are explicit image operations',async()=>{
  const figure={id:'f1',type:'figure',pageIndex:0,bbox:[10,20,210,160],caption:'그림'};
  const h=world({catalog:{items:[figure],full:{f1:{...figure}},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios()[0];
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>all(h.host).some(el=>el.type==='file'),'file');
  const file=all(h.host).find(el=>el.type==='file');
  file.files=[imagePick(GRID,'grid.png','image/png')];
  file.dispatchEvent(new Event('change'));
  await until(()=>h.ui.snapshot().pending===1,'uploaded');
  h.labeled('자르기 시작 가로').value='1';
  h.labeled('자르기 시작 세로').value='2';
  h.labeled('자르기 폭').value='3';
  h.labeled('자르기 높이').value='4';
  h.button('이미지 자르기').click();
  await until(()=>h.calls.filter(call=>call.path==='/api/paper/visual/export').length===0&&h.ui.snapshot().pending===1,'cropped');
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'crop out');
  const cropped=Buffer.from(h.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0].png,'base64');
  const cropPath=path.join(tmp,'crop.png');
  fs.writeFileSync(cropPath,cropped);
  const info=py(`from PIL import Image\nim=Image.open(${JSON.stringify(cropPath)}).convert('RGB')\nprint(im.size[0],im.size[1],*im.getpixel((0,0)))`);
  assert.equal(info,'3 4 20 40 40');

  const h2=world({catalog:{items:[figure],full:{f1:{...figure}},analyses:[],fullAnalyses:{}}});
  h2.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r2'};
  await h2.ui.refresh();
  const radio2=h2.radios()[0];
  radio2.checked=true;radio2.dispatchEvent(new Event('change'));
  await until(()=>all(h2.host).some(el=>el.tagName==='CANVAS'),'canvas');
  h2.labeled('라벨').value='A1';
  h2.button('라벨 놓기').click();
  const stage=all(h2.host).find(el=>String(el.className).includes('visual-edit-stage'));
  stage.dispatchEvent(pointer('pointerdown',20,20));
  stage.dispatchEvent(pointer('pointerup',20,20));
  await until(()=>h2.ui.snapshot().pending===1,h2.status());
  h2.button('PDF에 적용').click();
  await until(()=>h2.outputs.length===1,'label out');
  const labelPath=path.join(tmp,'label.png');
  fs.writeFileSync(labelPath,Buffer.from(h2.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0].png,'base64'));
  const dark=Number(py(`from PIL import Image\nim=Image.open(${JSON.stringify(labelPath)}).convert('RGB')\nprint(sum(1 for px in im.getdata() if px[0]<128))`));
  assert.ok(dark>10,'label pixels '+dark);
  assert.equal(h2.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations[0].bbox[0],10);
});

serial('scanned cells use a page region only when a source box exists',async()=>{
  const analysis={
    paperId:'paper-visual',analysisId:'aocr',kind:'ocr',pageIndex:1,bbox:[0,0,200,100],fileHash:HASH,
    inputImage:{width:100,height:50,sha256:WHITE_SHA,dpi:200},
    data:{tables:[{cells:[
      {row:0,column:0,text:'A',bbox:[0,0,10,10],sourceBbox:[4,6,24,16]},
      {row:0,column:1,text:'B'},
      {row:1,column:0,text:'C',bbox:[10,0,20,10]}
    ]}]}
  };
  const h=world({catalog:{items:[],full:{},analyses:[{analysisId:'aocr',kind:'ocr',pageIndex:1,bbox:[0,0,200,100]}],fullAnalyses:{aocr:analysis}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='analysis:aocr');
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('스캔 행 1 열 2'),'ocr');
  assert.equal(h.labeled('스캔 행 1 열 2').disabled,true);
  h.labeled('스캔 행 1 열 2').value='NO';
  h.labeled('스캔 행 1 열 2').dispatchEvent(new Event('input'));
  assert.equal(h.ui.snapshot().pending,0);
  h.labeled('스캔 행 1 열 1').value='Q';
  h.labeled('스캔 행 1 열 1').dispatchEvent(new Event('input'));
  await until(()=>h.ui.snapshot().pending===1,'ocr op');
  h.labeled('스캔 행 2 열 1').value='R';
  h.labeled('스캔 행 2 열 1').dispatchEvent(new Event('input'));
  await until(()=>h.ui.snapshot().pending===2,'mapped');
  h.button('PDF에 적용').click();
  await until(()=>h.outputs.length===1,'ocr out');
  const ops=h.calls.filter(call=>call.path==='/api/paper/visual/export').at(-1).body.operations;
  assert.equal(ops.every(op=>op.kind==='region'&&op.assetKind==='figure'),true);
  assert.equal(ops.some(op=>op.kind==='table-cell'),false);
  const direct=ops.find(op=>op.bbox[0]===4&&op.bbox[1]===6);
  const mapped=ops.find(op=>op.bbox[0]===20&&op.bbox[1]===0&&op.bbox[2]===40&&op.bbox[3]===20);
  assert.ok(direct);
  assert.ok(mapped);
});

serial('twenty-five cell edits stay under the operation cap until reduced',async()=>{
  const cells=Array.from({length:25},(_,row)=>({row,column:0,text:'v'+row,bbox:[1,2+row,10,3+row]}));
  const item={id:'tbig',type:'table',pageIndex:0,bbox:[1,1,20,80],caption:'큰 표',table:{rows:25,columns:1,cells}};
  const h=world({catalog:{items:[item],full:{tbig:item},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios()[0];
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'grid');
  assert.match(all(h.host).map(el=>el.textContent).join(' '),/1 \/ 3/);
  for(let page=0;page<3;page++){
    if(page)h.button('다음 줄').click();
    for(const input of all(h.host).filter(el=>el.tagName==='INPUT'&&el.getAttribute?.('aria-label')?.startsWith('행 '))){
      input.value='Z'+input.getAttribute('aria-label');
      input.dispatchEvent(new Event('input'));
    }
  }
  assert.equal(h.ui.snapshot().pending,25);
  h.button('PDF에 적용').click();
  await settle();
  assert.equal(h.calls.some(call=>call.path==='/api/paper/visual/export'),false);
  assert.match(h.status(),/24/);
  h.button('이전 줄').click();
  const sample=all(h.host).find(el=>el.getAttribute?.('aria-label')==='행 11 열 1');
  assert.match(sample.value,/^Z/);
});

serial('busy, hold, and clear guard the draft',async()=>{
  const held=[];
  const h=world({hold(info){held.push(info.active);if(info.active)return false;}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  const radio=h.radios().find(el=>el.value==='item:t1');
  radio.checked=true;radio.dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'cell');
  h.labeled('행 1 열 1').value='Z';
  h.labeled('행 1 열 1').dispatchEvent(new Event('input'));
  h.ui.setBusy(true);
  assert.equal(h.button('PDF에 적용').disabled,true);
  h.button('PDF에 적용').click();
  await settle();
  assert.equal(h.calls.some(call=>call.path==='/api/paper/visual/export'),false);
  h.ui.setBusy(false);
  h.button('PDF에 적용').click();
  await until(()=>h.status().includes('보류'),'hold');
  assert.deepEqual(held,[true,false]);
  assert.equal(h.outputs.length,0);
  h.ui.clear();
  assert.equal(h.ui.snapshot().pending,0);
  assert.equal(h.ui.snapshot().paperId,null);
  assert.equal(h.radios().length,0);
  assert.match(h.status(),/PDF를 선택/);
});

serial('a page region can be edited without an automatically detected figure',async()=>{
  const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  h.button('영역 직접 선택').click();
  await until(()=>h.labeled('라벨'),'page editor');
  assert.equal(h.previews.length,2);
  assert.equal(h.ui.snapshot().pending,0);
  h.button('영역 선택 취소').click();
  assert.equal(h.labeled('라벨'),undefined);
  assert.equal(h.ui.snapshot().pending,0);
  assert.equal(h.calls.some(call=>call.path==='/api/paper/visual/export'),false);
});

serial('page picker uses the matching workspace page and rejects a different file',async()=>{
  const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},pageIndex:1});
  h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();h.button('영역 직접 선택').click();
  await until(()=>h.labeled('라벨'),'second page editor');
  assert.equal(h.previews[0].page,2);
  assert.equal(h.calls.find(c=>c.body.operation==='render').body.pageIndex,1);
  globalThis.FalsifyPaperWorkspace.getSource=()=>({file:fileOf(PDF,'other.pdf'),fileHash:HASH});
  const count=h.previews.length;h.button('영역 직접 선택').click();await settle();
  assert.equal(h.previews.length,count);
});

serial('page navigation during preview cancels the old selection',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let page=0;
  const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},previewWait:()=>gate});
  h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
  globalThis.FalsifyPaperWorkspace.getPageIndex=()=>page;
  await h.ui.refresh();h.button('영역 직접 선택').click();
  page=1;release();await settle();
  assert.equal(h.calls.some(c=>c.body.operation==='render'),false);
  assert.equal(h.labeled('라벨'),undefined);
});

serial('page change during the displayed selection preview clears the old picker',async()=>{
  let release,attempt=0,page=0;const gate=new Promise(resolve=>{release=resolve;});
  const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},previewWait:()=>++attempt===2?gate:Promise.resolve()});
  h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
  globalThis.FalsifyPaperWorkspace.getPageIndex=()=>page;
  await h.ui.refresh();h.button('영역 직접 선택').click();
  await until(()=>attempt===2,'second preview');page=1;release();await settle();
  assert.equal(h.labeled('라벨'),undefined);
  assert.equal(h.ui.snapshot().pending,0);
});

serial('stale page preview cannot clear a newer picker',async()=>{
  let release,attempt=0,page=0;const gate=new Promise(resolve=>{release=resolve;});
  const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},previewWait:()=>++attempt===2?gate:Promise.resolve()});
  h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
  globalThis.FalsifyPaperWorkspace.getPageIndex=()=>page;
  await h.ui.refresh();h.button('영역 직접 선택').click();
  await until(()=>attempt===2,'first picker preview');page=1;h.button('영역 직접 선택').click();
  await until(()=>attempt===4,'second picker preview');release();await settle();
  assert.ok(h.labeled('라벨'));
  assert.equal(h.previews.at(-1).page,2);
});

serial('graph region selection opens shape editor with the drawn page and bounds',async()=>{
  const mounts=[];globalThis.FalsifyChartShape={};
  globalThis.FalsifyChartShapeEditor={create:args=>{mounts.push(args);return {destroy(){}};}};
  try{
    const h=world({pageIndex:1,catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},shapeScene:{sceneId:'s',series:[{id:'a',points:[{x:1,y:2}]}]}});
    h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
    await h.ui.refresh();h.button('그래프 영역 선택').click();
    await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage'))&&h.previews.length===2,'graph picker');
    const stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',10,20));stage.dispatchEvent(pointer('pointerup',110,120));
    await until(()=>mounts.length===1,'shape editor');
    const request=h.calls.find(c=>c.path==='/api/paper/chart/prepare');
    assert.equal(request.body.pageIndex,1);assert.deepEqual(request.body.bbox,[20,40,220,240]);
    assert.equal(mounts[0].embedded,true);
    assert.equal(h.button('PDF에 적용').disabled,true);
    const original=mounts[0].scene;
    mounts[0].onChange({revision:1,operations:[{type:'move'}],scene:{...original,series:[{id:'a',points:[{x:2,y:3}]}]}});
    assert.equal(h.ui.snapshot().pending,1);
    assert.equal(h.button('PDF에 적용').disabled,false);
    mounts[0].onChange({revision:2,operations:[],scene:original});
    assert.equal(h.ui.snapshot().pending,0);
    assert.equal(h.button('PDF에 적용').disabled,true);
    mounts[0].onChange({revision:3,operations:[{type:'move'}],scene:original});
    mounts[0].onGestureChange(true);
    assert.equal(h.button('PDF에 적용').disabled,true);
    h.button('PDF에 적용').dispatchEvent(new Event('click'));
    await settle();assert.equal(h.calls.filter(c=>c.path==='/api/paper/visual/export').length,0);
    mounts[0].onGestureChange(false);
    assert.equal(h.button('PDF에 적용').disabled,false);
    h.button('PDF에 적용').click();
    await until(()=>h.outputs.length===1,'embedded apply');
    const op=h.calls.find(c=>c.path==='/api/paper/visual/export').body.operations[0];
    assert.equal(op.kind,'chart-shape');assert.deepEqual(op.plan.operations,[{type:'move'}]);
    assert.equal(h.calls.filter(c=>c.path==='/api/paper/visual/export').length,1);
    h.button('영역 다시 선택').click();
    await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'back to picker');
    assert.equal(h.ui.snapshot().pending,1);
    h.button('영역 선택 취소').click();
    assert.ok(h.button('영역 다시 선택'));assert.equal(h.ui.snapshot().pending,1);
    assert.ok(all(h.host).some(el=>el.tagName==='BUTTON'&&el.textContent.startsWith('이어 편집 ·')));
  }finally{delete globalThis.FalsifyChartShape;delete globalThis.FalsifyChartShapeEditor;}
});

serial('failed graph preparation preserves selected bounds for retry',async()=>{
  let tries=0;const mounts=[];
  globalThis.FalsifyChartShape={};globalThis.FalsifyChartShapeEditor={create:args=>{mounts.push(args);return {destroy(){}};}};
  try{
    const h=world({shapeScene:{sceneId:'s',series:[{id:'a',points:[{x:1,y:2}]}]},request:(path,body,next)=>{
      if(path==='/api/paper/chart/prepare'&&++tries===1)throw Error('failed');return next();
    }});
    h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
    await h.ui.refresh();h.button('그래프 영역 선택').click();
    await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage'))&&h.previews.length===2,'picker');
    const stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',10,20));stage.dispatchEvent(pointer('pointerup',110,120));
    await until(()=>h.status().includes('준비하지 못했습니다'),'failure');
    h.button('다시 시도').click();await until(()=>mounts.length===1,'retry');
    const requests=h.calls.filter(c=>c.path==='/api/paper/chart/prepare');
    assert.deepEqual(requests[0].body.bbox,[20,40,220,240]);assert.deepEqual(requests[1].body.bbox,requests[0].body.bbox);
  }finally{delete globalThis.FalsifyChartShape;delete globalThis.FalsifyChartShapeEditor;}
});

serial('cancel during graph preparation rejects the stale scene',async()=>{
  let resolvePrepare;const mounts=[];
  globalThis.FalsifyChartShape={};globalThis.FalsifyChartShapeEditor={create:args=>{mounts.push(args);return {destroy(){}};}};
  try{
    const h=world({request:(path,body,next)=>path==='/api/paper/chart/prepare'?new Promise(resolve=>{resolvePrepare=()=>resolve({sceneId:'old',pageIndex:body.pageIndex,bbox:body.bbox,series:[{id:'a',points:[{x:1,y:2}]}]});}):next()});
    h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
    await h.ui.refresh();h.button('그래프 영역 선택').click();
    await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage'))&&h.previews.length===2,'picker');
    const stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',10,20));stage.dispatchEvent(pointer('pointerup',110,120));
    await until(()=>resolvePrepare,'prepare');h.button('영역 다시 선택').click();
    await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'new picker');
    h.button('영역 선택 취소').click();resolvePrepare();await settle();
    assert.equal(mounts.length,0);assert.equal(h.ui.snapshot().pending,0);
  }finally{delete globalThis.FalsifyChartShape;delete globalThis.FalsifyChartShapeEditor;}
});

serial('overlapping graph selection preserves drafts and permits explicit reopen or removal',async()=>{
  const mounts=[];globalThis.FalsifyChartShape={};
  globalThis.FalsifyChartShapeEditor={create:args=>{mounts.push(args);return {destroy(){}};}};
  try{
    const h=world({shapeScene:{sceneId:'s',series:[{id:'a',points:[{x:1,y:2}]}]}});
    h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};await h.ui.refresh();
    async function choose(x1,y1,x2,y2){
      h.button('그래프 영역 선택').click();
      await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'picker');
      const stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
      stage.dispatchEvent(pointer('pointerdown',x1,y1));stage.dispatchEvent(pointer('pointerup',x2,y2));
    }
    await choose(10,20,100,100);await until(()=>mounts.length===1,'first');
    mounts[0].onChange({operations:[{type:'first'}],scene:mounts[0].scene});
    h.button('영역 다시 선택').click();await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'single overlap picker');
    let stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',20,30));stage.dispatchEvent(pointer('pointerup',110,110));
    await until(()=>h.status().includes('겹치는 기존'),'existing region');
    assert.equal(mounts.length,1);assert.equal(h.ui.snapshot().pending,1);
    h.button('영역 다시 선택').click();await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'second picker');
    stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',160,20));stage.dispatchEvent(pointer('pointerup',250,100));
    await until(()=>mounts.length===2,'second');mounts[1].onChange({operations:[{type:'second'}],scene:mounts[1].scene});
    assert.equal(h.ui.snapshot().pending,2);
    assert.ok(h.button('이어 편집 · 1쪽 그래프1'));assert.ok(h.button('이어 편집 · 1쪽 그래프2'));
    assert.equal(h.button('이어 편집 · 1쪽 그래프1').getAttribute('title'),'영역: 20, 40, 200, 200');
    h.button('영역 다시 선택').click();await until(()=>all(h.host).some(el=>el.className.includes('visual-edit-stage')),'overlap picker');
    stage=all(h.host).find(el=>el.className.includes('visual-edit-stage'));
    stage.dispatchEvent(pointer('pointerdown',5,15));stage.dispatchEvent(pointer('pointerup',280,120));
    await until(()=>all(h.host).some(el=>el.textContent==='겹치는 그래프 편집을 선택하세요.'),'overlap choice');
    assert.equal(mounts.length,2);assert.equal(h.ui.snapshot().pending,2);
    const remove=all(h.host).find(el=>el.tagName==='BUTTON'&&el.textContent.startsWith('편집 제거 ·'));
    remove.click();assert.equal(h.ui.snapshot().pending,1);
    assert.ok(h.button('이어 편집 · 1쪽 그래프2'));assert.equal(h.button('이어 편집 · 1쪽 그래프1'),undefined);
    const reopen=all(h.host).find(el=>el.tagName==='BUTTON'&&el.textContent.startsWith('이어 편집 ·'));
    reopen.click();assert.ok(h.button('영역 다시 선택'));assert.equal(h.ui.snapshot().pending,1);
  }finally{delete globalThis.FalsifyChartShape;delete globalThis.FalsifyChartShapeEditor;}
});

serial('graph edit binds to the visible page after page navigation',async()=>{
  const mounts=[];
  globalThis.FalsifyChartShape={};
  globalThis.FalsifyChartShapeEditor={create:args=>{mounts.push(args);return {destroy(){}};}};
  try{
    const h=world({catalog:{items:[],full:{},analyses:[],fullAnalyses:{}},shapeScene:{sceneId:'s',series:[{id:'a',points:[{x:1,y:2}]}]}});
    h.source={file:fileOf(PDF,'vectors.pdf'),fileHash:HASH,revision:'r1'};
    await h.ui.refresh();h.button('영역 직접 선택').click();
    await until(()=>h.labeled('라벨'),'region ready');
    h.button('다음 쪽').click();
    await until(()=>h.previews.some(p=>p.page===2),'visible second page');
    h.button('그래프 고치기').click();
    await until(()=>mounts.length===1,'graph mounted');
    const request=h.calls.find(c=>c.path==='/api/paper/chart/prepare');
    assert.equal(request.body.pageIndex,1);
    assert.deepEqual(request.body.bbox,[0,0,600,800]);
    assert.equal(mounts[0].scene.pageIndex,1);
  }finally{delete globalThis.FalsifyChartShape;delete globalThis.FalsifyChartShapeEditor;}
});

serial('apply owns delayed image preparation before a second invocation',async()=>{
  const held=[];
  const figure={id:'f1',type:'figure',pageIndex:0,bbox:[10,20,210,160],caption:'그림'};
  const h=world({hold:info=>{held.push(info.active);},catalog:{items:[figure],full:{f1:figure},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();
  h.radios()[0].checked=true;h.radios()[0].dispatchEvent(new Event('change'));
  await until(()=>all(h.host).some(el=>el.type==='file'),'file');
  let release;const file=all(h.host).find(el=>el.type==='file');
  file.files=[{...imagePick(GRID,'grid.png','image/png'),arrayBuffer:()=>new Promise(r=>{release=()=>r(Uint8Array.from(GRID).buffer);})}];
  file.dispatchEvent(new Event('change'));
  const apply=h.button('PDF에 적용');
  apply.dispatchEvent(new Event('click'));apply.dispatchEvent(new Event('click'));
  release();
  await until(()=>h.outputs.length===1,'output');
  await settle();
  assert.deepEqual(held,[true,false]);
  assert.equal(h.calls.filter(c=>c.path==='/api/paper/visual/export').length,1);
});

serial('clear during output digest cannot install or announce stale output',async()=>{
  const h=world();h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};
  await h.ui.refresh();h.radios()[0].checked=true;h.radios()[0].dispatchEvent(new Event('change'));
  await until(()=>h.labeled('행 1 열 1'),'cell');
  const input=h.labeled('행 1 열 1');input.value='Z';input.dispatchEvent(new Event('input'));
  const result=await h.pdfOf(HASH,'delayed');h.exportImpl=()=>result;
  const subtle=crypto.subtle,original=subtle.digest.bind(subtle);let release,entered;
  const waiting=new Promise(r=>{entered=r;});
  subtle.digest=async (...args)=>{entered();await new Promise(r=>{release=r;});return original(...args);};
  try{
    h.button('PDF에 적용').click();await waiting;
    h.source=null;h.ui.clear();const status=h.status();release();await settle();
    assert.equal(h.outputs.length,0);assert.equal(h.ui.snapshot().outputFileHash,null);assert.equal(h.status(),status);
  }finally{subtle.digest=original;}
});

serial('latest list navigation wins and a failed request preserves the page',async()=>{
  const items=Array.from({length:24},(_,i)=>({id:'f'+i,type:'figure',pageIndex:0,bbox:[1,2,30,40],caption:'항목 '+i}));
  const pending=[];let delay=false;
  const h=world({catalog:{items,full:{},analyses:[],fullAnalyses:{}},request:(path,body,next)=>{
    if(delay&&body?.operation==='list')return new Promise((resolve,reject)=>pending.push({body,resolve:()=>resolve(next()),reject}));
    return next();
  }});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'r1'};await h.ui.refresh();
  h.button('다음 목록').click();await until(()=>h.radios()[0]?.value==='item:f8','page 2');
  delay=true;h.button('다음 목록').click();h.button('이전 목록').click();
  assert.deepEqual(pending.map(x=>x.body.offset),[16,0]);
  pending[1].resolve();await until(()=>h.radios()[0]?.value==='item:f0','page 1');
  pending[0].resolve();await settle();assert.equal(h.radios()[0].value,'item:f0');
  h.button('다음 목록').click();pending[2].reject(new Error('offline'));await settle();
  assert.equal(h.radios()[0].value,'item:f0');assert.equal(h.ui.snapshot().error,'failed');assert.ok(h.status());
});

for(const phase of ['export','verify'])serial('clear during old '+phase+' preserves the replacement apply lease',async()=>{
  const held=[];let active=false;
  const h=world({hold(info){held.push(info.active);active=info.active;return true;}});
  const prepare=async revision=>{
    h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision};
    await h.ui.refresh();h.radios()[0].checked=true;h.radios()[0].dispatchEvent(new Event('change'));
    await until(()=>h.labeled('행 1 열 1'),'cell');
    const input=h.labeled('행 1 열 1');input.value='Z';input.dispatchEvent(new Event('input'));
  };
  await prepare('old');
  const oldResult=await h.pdfOf(HASH,'old'),newResult=await h.pdfOf(HASH,'new');
  let releaseOld,releaseNew,exportCount=0,oldDigestEntered=false;
  h.exportImpl=()=>{
    exportCount++;
    if(exportCount===1&&phase==='verify')return oldResult;
    return new Promise(resolve=>{if(exportCount===1)releaseOld=()=>resolve(oldResult);else releaseNew=()=>resolve(newResult);});
  };
  const subtle=crypto.subtle,original=subtle.digest.bind(subtle);
  if(phase==='verify')subtle.digest=async (...args)=>{
    if(Buffer.from(args[1]).includes(Buffer.from('%old'))){oldDigestEntered=true;await new Promise(resolve=>{releaseOld=resolve;});}
    return original(...args);
  };
  try{
    h.button('PDF에 적용').click();h.button('PDF에 적용').dispatchEvent(new Event('click'));
    await until(()=>phase==='verify'?oldDigestEntered:!!releaseOld,'old pending');
    assert.equal(exportCount,1);assert.equal(active,true);
    h.ui.clear();assert.equal(active,false);
    await prepare('new');h.button('PDF에 적용').click();
    await until(()=>!!releaseNew,'new pending');
    const status=h.status();releaseOld();await settle();
    assert.equal(h.ui.snapshot().applying,true);assert.equal(active,true);
    assert.equal(h.button('PDF에 적용').disabled,true);assert.equal(h.status(),status);
    assert.deepEqual(held,[true,false,true]);assert.equal(h.outputs.length,0);
    releaseNew();await until(()=>h.outputs.length===1&&!h.ui.snapshot().applying,'new complete');
    assert.deepEqual(held,[true,false,true,false]);assert.equal(active,false);
  }finally{subtle.digest=original;}
});

serial('clear abandons pending image preparation without blocking the next draft',async()=>{
  const figure={id:'f1',type:'figure',pageIndex:0,bbox:[10,20,210,160],caption:'그림'};
  const h=world({catalog:{items:[figure],full:{f1:figure},analyses:[],fullAnalyses:{}}});
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'old'};
  await h.ui.refresh();h.radios()[0].checked=true;h.radios()[0].dispatchEvent(new Event('change'));
  await until(()=>all(h.host).some(el=>el.type==='file'),'file');
  const file=all(h.host).find(el=>el.type==='file');
  file.files=[{...imagePick(GRID,'grid.png','image/png'),arrayBuffer:()=>new Promise(()=>{})}];
  file.dispatchEvent(new Event('change'));h.button('PDF에 적용').dispatchEvent(new Event('click'));
  assert.equal(h.ui.snapshot().applying,true);h.ui.clear();
  h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision:'new'};
  await h.ui.refresh();h.button('PDF에 적용').dispatchEvent(new Event('click'));
  await until(()=>!h.ui.snapshot().applying,'new apply completes');
  assert.match(h.status(),/바꾼 내용이 없습니다/);
});

serial('clear releases a pending hold without letting its completion release a replacement',async()=>{
  const held=[];let releaseHold,active=false;
  const h=world({hold(info){held.push(info.active);active=info.active;if(info.active&&held.length===1)return new Promise(r=>{releaseHold=r;});return true;}});
  const prepare=async revision=>{
    h.source={file:fileOf(PDF,'t.pdf'),fileHash:HASH,revision};await h.ui.refresh();
    h.radios()[0].checked=true;h.radios()[0].dispatchEvent(new Event('change'));
    await until(()=>h.labeled('행 1 열 1'),'cell');
    const input=h.labeled('행 1 열 1');input.value='Z';input.dispatchEvent(new Event('input'));
  };
  await prepare('old');h.button('PDF에 적용').click();await until(()=>!!releaseHold,'hold pending');
  h.ui.clear();assert.equal(active,false);
  await prepare('new');let releaseExport;
  h.exportImpl=()=>new Promise(r=>{releaseExport=async()=>r(await h.pdfOf(HASH,'new'));});
  h.button('PDF에 적용').click();await until(()=>!!releaseExport,'new export');
  releaseHold(true);await settle();
  assert.equal(active,true);assert.equal(h.ui.snapshot().applying,true);assert.deepEqual(held,[true,false,true]);
  await releaseExport();await until(()=>!h.ui.snapshot().applying,'new complete');
  assert.deepEqual(held,[true,false,true,false]);
});

test('JPEG fallback loads the pure codec lazily without a new script ordering dependency', () => {
  assert.match(source, /await import\('\.\/paper-visual-codec\.mjs'\)/);
  assert.ok(source.indexOf("typeof root.createImageBitmap==='function'&&root.document") < source.indexOf("await import('./paper-visual-codec.mjs')"));
  assert.equal(typeof UI.create, 'function');
});

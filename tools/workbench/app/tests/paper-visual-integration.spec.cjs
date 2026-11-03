const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
test('the page loads chart reading and PDF preview before mounting RED visual integration',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../dist/index.html'),'utf8');
 const mount=html.indexOf('src="paper-visual-integration.js');
 for(const file of ['blue-visual-input.js','paper-enrichment-ui.js','paper-visual-edit-ui.js']){
  const dependency=html.indexOf('src="'+file);assert.ok(dependency>=0&&dependency<mount,file+' must load first');
 }
});
function boot(){
 const nodes=Object.fromEntries(['red-visual-edit-host','red-visual-section','red-visual-analysis','red-visual-record-status'].map(id=>[id,{hidden:false,textContent:'',append(){}}]));
 const document=new EventTarget();document.readyState='complete';document.getElementById=id=>nodes[id]||null;document.createElement=()=>Object.assign(new EventTarget(),{append(){},click(){},remove(){}});document.querySelectorAll=()=>[];
 const source={file:{name:'original.pdf',type:'application/pdf'},fileHash:'a'.repeat(64),segments:[{id:'s0',label:'p1',text:'Original'}]};
 let current=null,revision=0;const seen={requests:[],records:[],locks:[]};
 const context={document,CustomEvent,Event,EventTarget,crypto:globalThis.crypto,Uint8Array,ArrayBuffer,TextEncoder,File,Blob,btoa,console,structuredClone,
  FalsifyLocalBridge:{session:()=>({request:async(...args)=>{seen.requests.push(args);return {fileHash:source.fileHash,paperId:'paper'};}}),busy:(...args)=>seen.locks.push(args),capabilities:()=>({companionInstance:'test'})},
  FalsifyPaperWorkspace:{getSource:()=>source,getCurrentOutput:()=>current,getEditSnapshot:()=>({revision})},
  FalsifyVisualEditUI:{create:options=>{seen.editor=options;return {setBusy(){},clear(){seen.cleared=(seen.cleared||0)+1;},setAnalysis(value){seen.analysis=value;}};}},
  FalsifyPaperEnrichmentUI:{create:options=>{seen.enrichment=options;return {setBusy(){},clear(){}};}},
  FalsifyPaperManualRecords:{capture:async input=>{seen.records.push(input);}}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/paper-visual-integration.js'),'utf8'),context);
 return {context,document,nodes,source,seen,setCurrent:value=>{current=value;},setRevision:value=>{revision=value;}};
}
test('mount keeps PDF uploads read-only until an explicit analysis or apply action',()=>{
 const t=boot();assert.equal(t.nodes['red-visual-section'].hidden,false);assert.equal(t.seen.requests.length,0);assert.equal(t.seen.records.length,0);
 const release=t.seen.editor.hold();assert.equal(typeof release,'function');assert.equal(t.seen.editor.hold(),null);release();release();assert.equal(typeof t.seen.editor.hold(),'function');
});
test('visual edit starts from the current generated PDF only when source lineage matches',()=>{
 const t=boot();t.setCurrent({file:{name:'edited.pdf'},sha256:'b'.repeat(64),originalSourceSha256:t.source.fileHash});
 assert.equal(t.seen.editor.getSource().file.name,'edited.pdf');assert.equal(t.seen.editor.getSource().fileHash,'b'.repeat(64));
 assert.equal(t.seen.editor.getSource().segments.length,0);
 t.setCurrent({file:{name:'foreign.pdf'},sha256:'c'.repeat(64),originalSourceSha256:'d'.repeat(64)});
 assert.equal(t.seen.editor.getSource().file.name,'original.pdf');
});
test('graph analysis reaches the editor and visual output is recorded as a separate human snapshot',async()=>{
 const t=boot(),analysis={kind:'chart',data:{rows:[[1,2]]}};t.seen.enrichment.onResult(analysis);assert.equal(t.seen.analysis,analysis);
 await t.seen.editor.onOutput({outputFileHash:'b'.repeat(64),changes:[{id:'cell1',kind:'table-cell',pageIndex:2,bbox:[10,20,30,40],before:'1',after:'2'}],verification:{status:'passed'}});
 const record=t.seen.records[0];assert.match(record.recordId,/^pvr-/);assert.equal(record.snapshot.edits[0].origin,'human');assert.equal(record.snapshot.edits[0].pageIndex,2);assert.equal(record.output.sha256,'b'.repeat(64));
 assert.equal(t.seen.requests.length,0);
 t.setRevision(1);t.document.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));assert.equal(t.nodes['red-visual-record-status'].textContent,'');
});

test('BLUE handoff contains only the generated file and never the visual change record',async()=>{
 const t=boot();let detail;
 t.document.addEventListener('falsify:blue-file',event=>{detail=event.detail;});
 const file=new File(['%PDF-1.7'],'changed.pdf',{type:'application/pdf'});
 await t.seen.editor.onOutput({file,changes:[{before:'SECRET RED VALUE',after:'OTHER VALUE'}]},{intent:'blue'});
 assert.deepEqual(Object.keys(detail),['file']);assert.equal(detail.file,file);assert.equal(t.seen.records.length,0);
});
test('graph provenance stores the changed source values without copying all unchanged samples',async()=>{
 const t=boot();const before={kind:'line',title:'A',xAxis:{scale:'linear'},yAxis:{scale:'linear'},series:[{id:'s',name:'S',color:'#123456',points:[{x:1,y:2},{x:2,y:4}]}]};
 const after=structuredClone(before);after.series[0].points[1].y=9;
 t.seen.editor.onChange({changes:[{id:'graph1',before,after}]});
 await t.seen.editor.onOutput({outputFileHash:'c'.repeat(64),changes:[{id:'graph1',pageIndex:0,bbox:[10,20,30,40],before:{imageSha256:'a'.repeat(64)},after:{imageSha256:'b'.repeat(64)}}],verification:{status:'passed'}});
 const rows=t.seen.records[0].snapshot.edits;assert.equal(rows.length,1);assert.match(rows[0].before,/"y":4/);assert.match(rows[0].after,/"y":9/);assert.doesNotMatch(rows[0].after,/"y":2/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {buildPaperFlow} from '../src/paper-flow.mjs';

function fixture() {
 const pages=[0,1].map(i=>({sourcePageIndex:i,width:400,height:600,text:'',geometry:{frame:'mupdf-display',bounds:[0,0,400,600],pageTransform:[1,0,0,-1,0,600]}}));
 const d={schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages,blocks:[],assets:[],styles:[{id:'s',fontName:'Serif',size:10}]};
 const add=(id,text,box,pi,kind='paragraph',assetIds=[])=>{const p=pages[pi],start=p.text.length;p.text+=text;const end=p.text.length;d.blocks.push({id,kind,text,assetIds,styleId:'s',source:{pageIndex:pi,bbox:box,range:{start,end},readerPosition:d.blocks.length,characters:[...text].map((_,i)=>({start:start+i,end:start+i+1,bbox:box,styleId:'s'})),lines:text?[{bbox:box,range:{start,end}}]:[]}});};
 add('cap','Figure 1. Caption ',[20,480,180,500],0);add('tail','continued.',[20,501,180,530],0);
 add('label1','a',[25,40,35,50],1);add('label2','b',[200,40,210,50],1);add('label3','c',[25,500,35,510],1);
 for(const [id,box] of [['a',[25,60,180,490]],['b',[210,60,375,490]]]) {d.assets.push({id,source:{pageIndex:1,bbox:box}});add('fig'+id,'',box,1,'figure',[id]);}
 return {d,add};
}
const association=f=>f.relations.find(r=>r.provenance?.rule==='adjacent-page-bottom-caption-full-page-artwork');
test('adjacent full-page region owns the complete grouped source caption',()=>{
 const {d}=fixture(),before=structuredClone(d),f=buildPaperFlow(d),r=association(f),c=f.items.find(x=>x.id===r?.captionItemId),a=f.items.find(x=>x.id===r?.assetItemId);
 assert.ok(r);assert.deepEqual(c.blockIds,['cap','tail']);assert.deepEqual(c.joiners,[' ']);assert.deepEqual(a.captionIds,c.blockIds);assert.deepEqual(a.captionPositions,{cap:'above',tail:'above'});assert.equal(r.provenance.regionId,a.renderAssetId);assert.deepEqual(d,before);
});
test('ambiguous or unverified cross-page evidence remains unpaired',()=>{
 for(const scenario of ['body-after','body-next','caption-next','extra-asset','nonadjacent','frame','incomplete']) {
  const {d,add}=fixture();
  if(scenario==='body-after') add('body','Body after.',[20,565,180,575],0);
  if(scenario==='body-next') add('body','Scientific text outside artwork.',[20,535,300,550],1);
  if(scenario==='caption-next') add('other','Figure 2. Other.',[20,535,300,550],1);
  if(scenario==='extra-asset') {d.assets.push({id:'extra',source:{pageIndex:1,bbox:[10,535,20,545]}});add('extrafig','',[10,535,20,545],1,'figure',['extra']);}
  if(scenario==='nonadjacent') {d.pages[1].sourcePageIndex=2;for(const b of d.blocks.filter(b=>b.source.pageIndex===1)) b.source.pageIndex=2;for(const a of d.assets) a.source.pageIndex=2;}
  if(scenario==='frame') d.pages[1].geometry.frame='caller-observed';
  if(scenario==='incomplete') {const b=d.blocks.find(b=>b.id==='tail');b.text=b.text.slice(0,-1);d.pages[0].text=d.pages[0].text.slice(0,-1);b.source.range.end--;b.source.lines[0].range.end--;b.source.characters.pop();}
  assert.equal(association(buildPaperFlow(d)),undefined,scenario);
 }
});

const actual=process.env.FALSIFY_CROSSPAGE_PREPARED;
test('prepared source links its three observed caption and artwork pairs',{skip:!actual || !existsSync(actual)},async()=>{
 globalThis.crypto ||= webcrypto;
 const {readDocument}=await import('../src/paper-document.mjs'),{readSourceAssets}=await import('../src/paper-source-assets.mjs'),{readSourceLinks}=await import('../src/paper-source-links.mjs');
 const bytes=readFileSync(actual),d=await readDocument({file:bytes}),inventory=await readSourceAssets({bytes,document:d}),links=await readSourceLinks({bytes,document:d});
 const f=buildPaperFlow(d,{drawings:inventory.drawings,links});
 const rs=f.relations.filter(r=>r.provenance?.rule==='adjacent-page-bottom-caption-full-page-artwork');
 assert.deepEqual(rs.map(r=>[r.provenance.captionPageIndex,r.provenance.artworkPageIndex]),[[1,2],[4,5],[6,7]]);
 for(const r of rs) {const c=f.items.find(i=>i.id===r.captionItemId),a=f.items.find(i=>i.id===r.assetItemId);assert.deepEqual(a.captionIds,c.blockIds);assert.ok(c.blockIds.length>=2);}
});


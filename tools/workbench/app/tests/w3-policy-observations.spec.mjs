import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {blocks,after,corpus,geometryCorpus} from './recomposition-corpus.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {buildPaperFlow} from '../src/paper-flow.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const expected=JSON.parse(readFileSync(new URL('./fixtures/w3-policy-objects.json',import.meta.url),'utf8'));
export async function observations() {
  const results={};
  for(const variant of ['baseline','wrapped','moved','edit','missing','number','sign','duplicate','bounds']) {
    results[variant]=await checkRecomposition({bytes:corpus(variant),expectedBlocks:blocks,pdfjs,exporter:'MuPDF',...(variant==='edit'?{edits:{c:after}}:{})});
  }
  for(const [variant,text] of [['split','regulation'],['gap','regul ation'],['internal-space','regulation'],['wrap','hello world'],['ambiguous','regulation']]) {
    results[`geometry-${variant}`]=await checkRecomposition({bytes:geometryCorpus(variant),expectedBlocks:[{id:'x',text}],pdfjs});
  }
  let offset=0;const bs=[];
  const add=(id,text,box,lines=1)=>{const start=offset;offset+=text.length;bs.push({id,kind:'paragraph',text,assetIds:[],source:{pageIndex:0,bbox:box,range:{start,end:offset},readerPosition:bs.length,characters:[...text].map((_,i)=>({start:start+i,end:start+i+1,styleId:'s',bbox:box})),lines:Array.from({length:lines},(_,i)=>({bbox:[box[0],box[1]+i*10,box[2],box[1]+i*10+8],range:{start,end:offset}}))}});};
  add('l1','body left one',[20,40,180,48]);add('l2','body left two',[20,60,180,68]);add('r1','body right one',[220,40,380,48]);add('r2','body right two',[220,60,380,68]);add('cap','Figure 1. caption',[20,110,180,138],3);add('cont','continuation',[220,110,380,138],3);add('wide','A real wide paragraph',[20,180,380,190]);
  results.twoColumn=buildPaperFlow({schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks:bs,assets:[],styles:[{id:'s',fontName:'Times',size:10}]});
  return results;
}
test('policy phases preserve complete checker and two-column flow observations',async()=>{
  // JSON snapshots intentionally omit undefined properties, matching serialized result contracts.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await observations())),expected);
});

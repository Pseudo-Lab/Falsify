import test from 'node:test';
import assert from 'node:assert/strict';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {deriveSourceTables,bindSourceTables,sourceTableCells,inSourceTableCell} from '../src/paragraph-source-tables.mjs';
test('source-table extraction rejects an incorrect byte binding',async()=>{
 await assert.rejects(()=>deriveSourceTables(new Uint8Array([37,80,68,70,45,49]),'0'.repeat(64),{}),{code:'stale-source'});
});
test('table cells bind only matching source bytes and supported page geometry',()=>{
 const bytes=new Uint8Array([1,2,3]), proof={sha:hex(bytes),pages:[{width:200,height:300,rotation:0}],cells:[{pageIndex:0,bbox:[10,20,30,40]}]};
 const e={page:1,doc:1,pageIndex:0,pageWidth:200,pageHeight:300,pageT:[1,0,0,1,0,0],M:{_FPDFPage_GetRotation:()=>0,_FPDF_GetPageCount:()=>1}};
 bindSourceTables(e,bytes,proof);let cells=sourceTableCells(e);assert.deepEqual(cells,[{l:10,r:30,b:260,t:280}]);
 assert.equal(inSourceTableCell({l:11,r:29,b:261,t:279},cells),true);
 assert.equal(inSourceTableCell({l:11,r:31,b:261,t:279},cells),false);
 e.pageT=[1,.05,0,1,0,0];assert.equal(sourceTableCells(e),null);e.pageT=[1,0,0,1,0,0];
 e.pageWidth=201;assert.equal(sourceTableCells(e),null);e.pageWidth=200;
 e.M._FPDFPage_GetRotation=()=>1;assert.equal(sourceTableCells(e),null);e.M._FPDFPage_GetRotation=()=>0;
 e.M._FPDF_GetPageCount=()=>2;assert.equal(sourceTableCells(e),null);e.M._FPDF_GetPageCount=()=>1;
 bindSourceTables(e,bytes,{sha:hex(bytes),unavailable:true});assert.equal(sourceTableCells(e),null);
 bindSourceTables(e,new Uint8Array([1,2,4]),proof);assert.equal(sourceTableCells(e),null);
});

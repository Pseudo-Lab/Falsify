import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findPublicationTables} from '../src/paper-publication-tables.mjs';

const run=(id,text,x,y)=>({id,text,bbox:[x,y,x+20,y+8]});
const rule=y=>({bbox:[10,y,150,y+0.5]});
test('detects aligned table cells while rejecting incomplete evidence on another page',()=>{
  const caption=run('caption','Table 1. Results',10,10);
  const rows=[run('h1','Name',15,35),run('h2','Value',90,35),run('a','A',15,55),run('b','1.2',90,55),run('c','B',15,70),run('d','3.4',90,70)];
  const page={pageIndex:0,height:300,rules:[rule(25),rule(48),rule(85)],runs:[caption,...rows]};
  const incomplete={pageIndex:1,height:300,rules:[rule(25)],runs:[caption,...rows]};
  const tables=findPublicationTables([page,incomplete]);
  assert.equal(tables.length,1);
  assert.equal(tables[0].pageIndex,0);
  assert.deepEqual(tables[0].rows.map(row=>row.map(cell=>cell.text)),[['Name','Value'],['A','1.2'],['B','3.4']]);
});

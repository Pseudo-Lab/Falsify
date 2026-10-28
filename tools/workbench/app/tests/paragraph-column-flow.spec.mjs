import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowPlan } from '../src/paragraph-vendor/pagination.mjs';
import { cascadeShifts, cascadeBarrier, normalizePageMap } from '../src/paragraph-vendor/quality.mjs';

const para = (id, x, top, h = 10, role = 'body') => ({ id, box: { x, top, w: 80, h }, role, editable: true, topLevel: true });

test('cascade consumes real gaps and propagates only remaining growth', () => {
  const ctx = { paras: [para('a', 100, 100), para('b', 100, 85), para('c', 100, 70), para('left', 0, 80)] };
  assert.deepEqual([...cascadeShifts(ctx, [{ id: 'a', box: ctx.paras[0].box, delta: 8 }])], [['b', 3]]);
  assert.deepEqual([...cascadeShifts(ctx, [{ id: 'a', box: ctx.paras[0].box, delta: 13 }])], [['b', 8], ['c', 3]]);
});

function fixture(figure) {
  const paras = [para('right', 110, 100), para('next', 110, 80), para('left', 0, 75), para('caption', 0, 60, 8, 'footer_uncertain')];
  const boxes = new Map([[1,{x:110,y:90,w:80,h:10}],[2,{x:110,y:70,w:80,h:10}],[3,{x:0,y:65,w:80,h:10}],[4,{x:0,y:52,w:80,h:8}], [5,figure]]);
  const handles = new Map(paras.map((p,i)=>[p.id,[i+1]]));
  const objects = figure ? [1,2,3,4,5] : [1,2,3,4];
  const engine = { page: 1, pageT: [1,0,0,1,0,0], M: { _FPDFPage_CountObjects:()=>objects.length, _FPDFPage_GetObject:(_,i)=>objects[i], _FPDFPageObj_GetType:(h)=>h===5?3:1 }, paragraphObjects:(id)=>handles.get(id), objectBounds:(h)=>boxes.get(h) };
  return {engine,ctx:{paras,pageH:120}, grown:[{id:'right',box:paras[0].box,delta:20}]};
}

test('continuation plans one column and preserves disjoint paragraph and object', () => {
  const {engine,ctx,grown}=fixture({x:0,y:40,w:80,h:10});
  const plan=buildFlowPlan(engine,ctx,grown,{floor:65,maxNewPages:3});
  assert.equal(plan.ok,true);
  assert.deepEqual(plan.flowColumn,{x0:110,x1:190});
  assert.ok(plan.pages.length > 1);
  assert.deepEqual(new Set(plan.lines.flatMap(l=>l.items.map(i=>i.h))),new Set([1,2]));
});

test('ordinary one-column continuation leaves whole-page compaction eligible', () => {
  const {engine,ctx,grown}=fixture();
  ctx.paras=ctx.paras.slice(0,2);
  engine.M._FPDFPage_CountObjects=()=>2;
  const plan=buildFlowPlan(engine,ctx,grown,{floor:65,maxNewPages:3});
  assert.equal(plan.ok,true);
  assert.ok(plan.pages.length > 1);
  assert.equal(plan.flowColumn,undefined);
});

test('a disjoint body-band object alone retains the selected-column guard', () => {
  const {engine,ctx,grown}=fixture({x:0,y:70,w:80,h:10});
  ctx.paras=ctx.paras.slice(0,2);
  engine.M._FPDFPage_CountObjects=()=>3;
  engine.M._FPDFPage_GetObject=(_,i)=>[1,2,5][i];
  const plan=buildFlowPlan(engine,ctx,grown,{floor:65,maxNewPages:3});
  assert.equal(plan.ok,true);
  assert.deepEqual(plan.flowColumn,{x0:110,x1:190});
});

test('a figure crossing the flow column is rejected', () => {
  const {engine,ctx,grown}=fixture({x:0,y:60,w:190,h:10});
  assert.equal(buildFlowPlan(engine,ctx,grown,{floor:65,maxNewPages:3}).code,'pagination_unsupported_foreign_object_in_flow');
  const tall=fixture({x:0,y:60,w:190,h:100});
  assert.equal(buildFlowPlan(tall.engine,tall.ctx,tall.grown,{floor:65,maxNewPages:3}).code,'pagination_unsupported_foreign_object_in_flow');
});

test('flow column metadata must be finite and ordered', () => {
  const map=[{sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[1],bodyTop:100,flowTop:90,floor:20,lineCounts:[1],flowColumn:{x0:100,x1:90}}];
  assert.equal(normalizePageMap(map,1),null);
  map[0].flowColumn.x1=180;
  assert.ok(normalizePageMap(map,1));
});


test('continuation respects line capacity and page budget', async () => {
  const { planFlow } = await import('../src/paragraph-vendor/pagination.mjs');
  assert.equal(planFlow([{top:80,bottom:20}],{bodyTop:100,floor:50,maxNewPages:2}).code,'pagination_line_exceeds_body');
  assert.equal(planFlow([{top:45,bottom:35}],{bodyTop:100,floor:50,maxNewPages:0}).code,'pagination_budget_exceeded');
});


test('in-page cascade rejects a foreign figure in the swept area', () => {
  const ctx = { paras: [para('a', 110, 100), para('b', 110, 80)] };
  const boxes = new Map([[1,{x:110,y:90,w:80,h:10}],[2,{x:110,y:70,w:80,h:10}],[3,{x:100,y:62,w:100,h:6}]]);
  const engine = { page: 1, M: { _FPDFPage_CountObjects:()=>3, _FPDFPage_GetObject:(_,i)=>i+1 }, paragraphObjects:(id)=>[id === 'a' ? 1 : 2], objectBounds:(h)=>boxes.get(h) };
  assert.equal(cascadeBarrier(engine,ctx,[{id:'a',box:ctx.paras[0].box,delta:20}],new Map([['b',10]])),'b');
  boxes.set(3,{x:0,y:62,w:80,h:6});
  assert.equal(cascadeBarrier(engine,ctx,[{id:'a',box:ctx.paras[0].box,delta:20}],new Map([['b',10]])),null);
});

test('existing source mask overlap is preserved while newly entered content still blocks', () => {
  const ctx={paras:[para('a',110,100)]};
  const boxes=new Map([[1,{x:110,y:90,w:80,h:10}],[2,{x:110,y:92,w:80,h:5}]]);
  const engine={page:1,M:{_FPDFPage_CountObjects:()=>2,_FPDFPage_GetObject:(_,i)=>i+1},paragraphObjects:()=>[1],objectBounds:h=>boxes.get(h)};
  const grown=[{id:'a',box:ctx.paras[0].box,delta:12}];
  assert.equal(cascadeBarrier(engine,ctx,grown,new Map()),null);
  boxes.set(2,{x:110,y:80,w:80,h:5});
  assert.equal(cascadeBarrier(engine,ctx,grown,new Map()),'a');
});

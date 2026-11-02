import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowPlan } from '../src/paragraph-vendor/pagination.mjs';
import { capturePageLayout, cascadeShifts, cascadeBarrier, cascadeFloor, reserveCascadeSpace, normalizePageMap } from '../src/paragraph-vendor/quality.mjs';

test('cascade floor admits clear lower page space while preserving a footer', () => {
  const body = { role: 'body', box: { x: 40, top: 310, w: 200, h: 12 } };
  assert.equal(cascadeFloor({ pageH: 500, paras: [body] }), 50);
  const low = { ...body, box: { ...body.box, top: 55, h: 12 } };
  assert.equal(cascadeFloor({ pageH: 500, paras: [low] }), 43);
  const footer = { role: 'footer_uncertain', box: { x: 40, top: 80, w: 40, h: 10 } };
  assert.equal(cascadeFloor({ pageH: 500, paras: [body, footer] }), 120);
});

test('reservation checks barriers and rolls back a recorded whole-body move', () => {
  const boxes = new Map([[1,{x:10,y:290,w:80,h:10}],[2,{x:10,y:270,w:80,h:10}]]);
  let depth=0, before;
  const e={page:1,M:{_FPDFPage_CountObjects:()=>boxes.size,_FPDFPage_GetObject:(_,i)=>[...boxes.keys()][i],_FPDFPageObj_GetType:()=>1},
    objectBounds:h=>boxes.get(h), historyDepth:()=>({undo:depth}), historyBeginStep:()=>{before=structuredClone(boxes);},
    historyEndStep:()=>{depth++;}, historyNoteMatrix:()=>{}, translateObject:(h,dx,dy)=>{boxes.get(h).y+=dy;},
    historyUndo:()=>{boxes.clear();for(const [h,b] of before)boxes.set(h,b);depth--;return true;}};
  const ctx={pageH:500,paras:[{id:'a',role:'body',box:{x:10,top:300,w:80,h:10},handles:[1],editable:true,topLevel:true},
    {id:'b',role:'body',box:{x:10,top:280,w:80,h:10},handles:[2],editable:true,topLevel:true,baselines:[275]}]};
  const grown=[{id:'a',box:ctx.paras[0].box,delta:15}];
  const r=reserveCascadeSpace(e,ctx,grown,{targetHandles:[1]});
  assert.equal(r.ok,true); assert.equal(boxes.get(2).y,263); assert.equal(r.context.paras[1].box.top,273);
  assert.equal(ctx.paras[1].box.top,280); assert.equal(r.rollback(),true); assert.equal(boxes.get(2).y,270);
  boxes.set(3,{x:10,y:265,w:80,h:3});
  assert.equal(reserveCascadeSpace(e,ctx,grown,{targetHandles:[1]}).code,'reserve_foreign_object');
  assert.equal(boxes.get(2).y,270);
  boxes.delete(3);
  assert.equal(reserveCascadeSpace({...e,pageT:[0,1,-1,0,0,0]},ctx,grown,{targetHandles:[1]}).code,'reserve_transform_unsupported');
  assert.equal(reserveCascadeSpace(e,ctx,[{...grown[0],delta:260}],{targetHandles:[1]}).code,'reserve_no_room');
  assert.equal(boxes.get(2).y,270);
});

const para = (id, x, top, h = 10, role = 'body') => ({ id, box: { x, top, w: 80, h }, role, editable: true, topLevel: true });

test('cascade consumes real gaps and propagates only remaining growth', () => {
  const ctx = { paras: [para('a', 100, 100), para('b', 100, 85), para('c', 100, 70), para('left', 0, 80)] };
  assert.deepEqual([...cascadeShifts(ctx, [{ id: 'a', box: ctx.paras[0].box, delta: 8 }])], [['b', 3]]);
  assert.deepEqual([...cascadeShifts(ctx, [{ id: 'a', box: ctx.paras[0].box, delta: 13 }])], [['b', 8], ['c', 3]]);
});

test('reservation retains source gaps along the affected chain and leaves separate columns and distant text alone', () => {
  const ctx = { paras: [para('a', 100, 100), para('b', 100, 89.43), para('c', 100, 78.86), para('distant', 100, 40), para('left', 0, 80)] };
  const grown = [{ id: 'a', box: ctx.paras[0].box, delta: 10.75 }];
  assert.deepEqual([...cascadeShifts(ctx, grown, { preserveSourceGaps: true })], [['b', 10.75], ['c', 10.75]]);
  assert.deepEqual([...cascadeShifts(ctx, grown)].map(([id, dy]) => [id, +dy.toFixed(2)]), [['b', 10.18], ['c', 9.61]]);
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


test('source baseline continuity keeps reference fragments with their body and protects furniture', () => {
  const p = (id, x, top, w, h, ys, text) => ({id, box:{x,top,w,h}, lines:ys.map(y=>({y})), runs:[{text,size:10}], editable:true});
  const input = [p('heading',100,208.342,57,13.201,[199],'References'),
    p('marker',100,196.004,10,10.92,[190],'1'),
    p('refs',117,196.004,236,139.944,[190,179.25,168.5,157.75,147,136.25,125.5,114.75,104,93.25,82.5,71.75,61],'reference body'),
    p('edgeMarker',100,66.98,10,10.92,[61],'6'),
    p('edgeLine',117,56.348,175,11.04,[50.25],'last reference line'),
    p('raised',320,69,12,6,[64],'citation'),
    p('footer',100,30,80,8,[24],'publisher footer'),
    p('page',380,30,10,8,[24],'10'),
    p('otherColumn',0,196,89,10,[190],'independent')];
  const handles = new Map(input.map((p,i)=>[p.id,[i+1]]));
  const e={page:1,pageIndex:0,pageWidth:500,pageHeight:800,M:{_FPDFPage_CountObjects:()=>input.length,_FPDFPage_GetObject:(_,i)=>i+1,_FPDFPageObj_GetType:()=>1},paragraphObjects:id=>handles.get(id)};
  const ctx=capturePageLayout(e,0,input);
  const roles=Object.fromEntries(ctx.paras.map(p=>[p.id,p.role]));
  assert.equal(roles.edgeMarker,'body'); assert.equal(roles.edgeLine,'body'); assert.equal(roles.raised,'body');
  assert.equal(roles.footer,'footer_uncertain'); assert.equal(roles.page,'page_number');
  const shifts=cascadeShifts(ctx,[{id:'heading',delta:10.75}],{preserveSourceGaps:true});
  for (const id of ['marker','refs','edgeMarker','edgeLine']) assert.equal(shifts.get(id),10.75,id);
  assert.equal(shifts.has('otherColumn'),false); assert.equal(shifts.has('footer'),false);
});

 test('nearby full-width columns sharing a baseline are not inline fragments', () => {
  const left={...para('left',0,100),baselines:[95,85,75],size:10};
  const right={...para('right',87,100),baselines:[95,85,75],size:10};
  assert.equal(cascadeShifts({paras:[left,right]},[{id:'left',delta:10}],{preserveSourceGaps:true}).has('right'),false);
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const Sensor=require('../dist/blue-defect-sensor-core.js');

const HASH='b'.repeat(64);

test('checkSprite enforces range, GRIM integer feasibility, and Bhatia-Davis SD bounds',()=>{
  const highSd=Sensor.checkSprite(4.00,3.50,10,1,7);
  assert.equal(highSd.consistent,false);
  assert.equal(highSd.reason,'sd_above_max');

  const lowSd=Sensor.checkSprite(4.50,0.20,10,1,7);
  assert.equal(lowSd.consistent,false);
  assert.equal(lowSd.reason,'sd_below_min');

  const oob=Sensor.checkSprite(7.50,1.00,10,1,7);
  assert.equal(oob.consistent,false);
  assert.equal(oob.reason,'mean_out_of_bounds');

  const grim=Sensor.checkSprite(3.45,1.00,10,1,7);
  assert.equal(grim.consistent,false);
  assert.equal(grim.reason,'grim_infeasible');

  const ok=Sensor.checkSprite({mean:4.00,sd:2.00,n:10,minVal:1,maxVal:7});
  assert.equal(ok.consistent,true);
  assert.equal(ok.reason,'ok');
});

test('checkTwoByTwo verifies exact Fisher/Pearson/Yates p-values and crude OR/RR while exempting aOR/aRR',()=>{
  const bad=Sensor.checkTwoByTwo(24,100,10,100,{
    reportedKind:'OR',reportedEst:'5.80',estDecimals:2,
    reportedP:'0.0001',pOp:'=',pDecimals:4
  });
  assert.equal(bad.consistent,false);
  assert.equal(bad.estConsistent,false);
  assert.equal(bad.pConsistent,false);

  const ok=Sensor.checkTwoByTwo(24,100,10,100,{
    reportedKind:'OR',reportedEst:'2.84',estDecimals:2,
    reportedP:'0.01',pOp:'=',pDecimals:2
  });
  assert.equal(ok.consistent,true);

  const adj=Sensor.checkTwoByTwo(24,100,10,100,{
    reportedKind:'aOR',reportedEst:'1.85',estDecimals:2
  });
  assert.equal(adj.consistent,true);
  assert.equal(adj.adjustedExempt,true);

  const zero=Sensor.checkTwoByTwo(0,20,8,20,{reportedKind:'OR',reportedEst:'0.04',estDecimals:2});
  assert.equal(zero.consistent,true);
});

test('checkKmAtRisk flags non-monotonic upward jumps and honors delayed-entry skip',()=>{
  const bad=Sensor.checkKmAtRisk({'Drug A':[150,132,141,98],'Placebo':[150,120,95,70]});
  assert.equal(bad.consistent,false);
  assert.equal(bad.violations.length,1);
  assert.equal(bad.violations[0].arm,'Drug A');
  assert.equal(bad.violations[0].kind,'non_monotonic');

  const clean=Sensor.checkKmAtRisk({'Drug A':[150,132,110,98]});
  assert.equal(clean.consistent,true);

  const skipped=Sensor.checkKmAtRisk({'Drug A':[100,115,90]},{contextText:'Delayed entry cohort'});
  assert.equal(skipped.consistent,true);
  assert.equal(skipped.skipped,true);
});

test('scanSegments integrates P0 deep forensic signals with zero false positives on valid/adjusted inputs',()=>{
  const segs=[
    {id:'s0',pageIndex:0,text:'On the Likert 1-7 scale (n = 10), score was 4.00 ± 3.50.'},
    {id:'s1',pageIndex:1,text:'Response was 24/100 (24.0%) vs 10/100 (10.0%), OR = 5.80, p = 0.0001.'},
    {id:'s2',pageIndex:2,text:'Adjusted multivariable model for 24/100 (24.0%) vs 10/100 (10.0%) had aOR = 1.85, p = 0.12.'},
    {id:'s3',pageIndex:3,text:[
      'No. at risk',
      'Drug A   150   132   141   98',
      'Placebo  150   120    95   70',
      'Months     0     6    12   18'
    ].join('\n')}
  ];
  const r=Sensor.scanSegments({fileHash:HASH,segments:segs});
  const kinds=r.signals.map(s=>s.kind);
  assert.ok(kinds.includes('sprite_bounds_mismatch'));
  assert.ok(kinds.includes('two_by_two_mismatch'));
  assert.ok(kinds.includes('km_at_risk_non_monotonic'));
  assert.equal(r.signals.filter(s=>s.kind==='two_by_two_mismatch').length,1);
  assert.equal(r.signals.filter(s=>s.kind==='km_at_risk_non_monotonic').length,1);
  assert.equal(r.signals.every(s=>s.category==='D1'),true);
});

test('blue-defect-sensor-core passes CCN <= 15 and static safety checks',async()=>{
  const {javascriptFunctions}=await import('../../tools/quality/complexity.mjs');
  const src=fs.readFileSync(path.resolve(__dirname,'../dist/blue-defect-sensor-core.js'),'utf8');
  assert.doesNotMatch(src,/innerHTML|insertAdjacentHTML|outerHTML/);
  for(const fn of javascriptFunctions(src)){
    assert.ok(fn.ccn<=15,`CCN ${fn.ccn} exceeds 15 in ${fn.id}`);
  }
});

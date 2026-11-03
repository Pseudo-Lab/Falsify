import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const vendor=new URL('../dist/plottracer-vendor/',import.meta.url);
const bytes=readFileSync(new URL('engine.js',vendor));
const manifest=JSON.parse(readFileSync(new URL('manifest.json',vendor)));
const ctx=vm.createContext({});vm.runInContext(bytes.toString('utf8'),ctx,{timeout:2000});
test('pinned runtime loads without a browser or Node globals',()=>{
  assert.equal(ctx.FalsifyPlotTracer.UPSTREAM_COMMIT,'dcc28a5da453ff5c4e7cadd4478523560d15c0dc');
  assert.equal(manifest.engine.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.engine.bytes,bytes.length);
  assert.match(readFileSync(new URL('LICENSE',vendor),'utf8'),/GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(vm.runInContext('typeof document+"/"+typeof require',ctx),'undefined/undefined');
});
test('unmodified upstream transforms linear negative and logarithmic values',()=>{
  const axis=(v0,v1,scale='linear')=>({scale,points:[{pixel:0,value:v0},{pixel:100,value:v1}]});
  const run=y=>JSON.parse(ctx.FalsifyPlotTracer.calibrate(JSON.stringify({x:axis(0,10),y}),JSON.stringify([[50,50]]))).points;
  assert.deepEqual(run(axis(1,-5)),[[5,-2]]);
  assert.deepEqual(run(axis(1,100,'log')),[[5,10]]);
  assert.throws(()=>run(axis(0,100,'log')),/invalid-calibration/);
});
test('source files retain the recorded upstream hashes',()=>{
  const root=new URL('../vendor-sources/plottracer/',import.meta.url);
  const upstream=JSON.parse(readFileSync(new URL('UPSTREAM.json',root)));
  for(const file of upstream.files)assert.equal(createHash('sha256').update(readFileSync(new URL(file.path,root))).digest('hex'),file.sha256,file.path);
  assert.equal(upstream.commit,manifest.commit);
});
test('vendored WPD curve core is pinned and callable without Node',()=>{
  assert.equal(typeof ctx.FalsifyWPDCurve.step,'function');
  assert.equal(typeof ctx.FalsifyWPDCurve.interpolate,'function');
  assert.equal(ctx.FalsifyWPDCurve.commit,'3a3ecb11606945d0701c8a488777e6861be70056');
  assert.equal(manifest.curve.commit,ctx.FalsifyWPDCurve.commit);
  assert.equal(manifest.curve.fork,'https://github.com/Shinick-Han/WebPlotDigitizer');
  assert.equal(manifest.curve.repository,'https://github.com/automeris-io/WebPlotDigitizer');
  const root=new URL('../vendor-sources/wpd-curve/',import.meta.url);
  for(const file of manifest.curve.files)assert.equal(createHash('sha256').update(readFileSync(new URL(file.path,root))).digest('hex'),file.sha256,file.path);
  assert.match(readFileSync(new URL('LICENSE-WPD',vendor),'utf8'),/GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(readFileSync(new URL('NOTICE.md',vendor),'utf8'),/3a3ecb11606945d0701c8a488777e6861be70056/);
  assert.match(bytes.toString('utf8'),/AGPL-3.0-or-later/);
});
function paint(width,height,draw){
  const image=Buffer.alloc(width*height*4,255);
  const set=(x,y,rgb,radius=1)=>{
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
      const xx=x+dx,yy=y+dy;
      if(xx<0||yy<0||xx>=width||yy>=height)continue;
      const i=(yy*width+xx)*4;
      image[i]=rgb[0];image[i+1]=rgb[1];image[i+2]=rgb[2];image[i+3]=255;
    }
  };
  draw(set);
  return image.toString('latin1');
}
function routed(image,width,height,colors,region){
  ctx.binary=image;ctx.colors=colors;ctx.region=region;ctx.width=width;ctx.height=height;
  return JSON.parse(vm.runInContext('FalsifyPlotTracer.trace(binary,width,height,JSON.stringify(colors),JSON.stringify(region),480)',ctx));
}
const linear=(pixel0,value0,pixel1,value1,scale='linear')=>({scale,points:[{pixel:pixel0,value:value0},{pixel:pixel1,value:value1}]});
test('isolated linear ink uses WPD step and a log axis does not',()=>{
  const blue=[31,119,180];
  const image=paint(180,100,(set)=>{for(let x=20;x<=150;x++)set(x,70-Math.round((x-20)*40/130),blue,1);});
  const region={x:10,y:10,width:160,height:80,route:'auto',manual:true};
  const linearRun=routed(image,180,100,[{id:'s',rgb:blue,calibration:{x:linear(20,0,150,10),y:linear(80,0,30,10)}}],region).series[0];
  assert.equal(linearRun.route,'wpd-step');
  assert.ok(linearRun.diagnostics.runs>20);
  const logRun=routed(image,180,100,[{id:'s',rgb:blue,calibration:{x:linear(20,0,150,10),y:linear(80,1,30,100,'log')}}],region).series[0];
  assert.equal(logRun.route,'wpd-xstep');
  assert.notEqual(logRun.route,'wpd-step');
  assert.equal(logRun.accepted[0].algorithm,'XStepWithInterpolationAlgo');
  assert.ok(logRun.accepted[0].origins.every(origin=>origin==='curve-interpolated'));
  assert.ok(logRun.accepted[0].roles.every(role=>role!=='measured'));
  assert.ok(logRun.accepted[0].inkSupport.some(Boolean));
  assert.equal(linearRun.accepted[0].algorithm,'AveragingWindowWithStepSizeAlgo');
  assert.ok(linearRun.accepted[0].origins.includes('pixel-calibrated'));
  assert.ok(linearRun.accepted[0].roles.includes('measured'));
});
test('a short end fork is kept and a speck is not a second branch',()=>{
  const blue=[31,119,180];
  const region={x:10,y:8,width:500,height:74,route:'auto',manual:true};
  const calibration={x:linear(20,0,500,10),y:linear(80,0,10,10)};
  const fork=paint(520,90,(set)=>{
    for(let x=20;x<=500;x++)set(x,50,blue,1);
    for(let i=0;i<=24;i++)set(476+i,50-i,blue,1);
  });
  const forked=routed(fork,520,90,[{id:'s',rgb:blue,calibration}],region).series[0];
  assert.equal(forked.route,'find-lines',JSON.stringify(forked.diagnostics));
  const end=forked.accepted.flatMap(line=>line.points).filter(point=>point[0]>=494);
  assert.ok(end.some(point=>Math.abs(point[1]-50)<=5),JSON.stringify(end));
  assert.ok(end.some(point=>point[1]<=36),JSON.stringify(end));
  const speck=paint(520,90,(set)=>{
    for(let x=20;x<=500;x++)set(x,50,blue,1);
    for(let x=300;x<=303;x++)set(x,18,blue,0);
  });
  const noise=routed(speck,520,90,[{id:'s',rgb:blue,calibration}],region).series[0];
  assert.notEqual(noise.route,'find-lines',JSON.stringify(noise.diagnostics));
  assert.equal(noise.accepted.length,1);
});
test('one asymmetric error bar stays on the stroke',()=>{
  const blue=[31,119,180];
  const image=paint(220,110,(set)=>{
    for(let x=20;x<=180;x++)set(x,90-Math.round((x-20)*50/160),blue,1);
    for(let y=18;y<=68;y++)set(100,y,blue,0);
  });
  const series=routed(image,220,110,[{id:'s',rgb:blue,calibration:{x:linear(20,0,180,10),y:linear(100,0,20,10)}}],
    {x:10,y:8,width:200,height:94,route:'auto',manual:true}).series[0];
  assert.equal(series.route,'find-lines',JSON.stringify(series.diagnostics));
  const span=line=>Math.max(...line.points.map(point=>point[0]))-Math.min(...line.points.map(point=>point[0]));
  const main=series.accepted.reduce((best,line)=>span(line)>=span(best)?line:best);
  const near=main.points.filter(point=>Math.abs(point[0]-100)<=3);
  assert.ok(near.length,JSON.stringify(series.diagnostics));
  assert.ok(near.every(point=>Math.abs(point[1]-65)<=5),JSON.stringify(near));
});
test('same-color crossing is not averaged into one nearest-neighbour path',()=>{
  const blue=[31,119,180];
  const image=paint(180,120,(set)=>{
    for(let i=0;i<=120;i++){
      set(20+i,20+Math.round(i*70/120),blue,1);
      set(20+i,90-Math.round(i*70/120),blue,1);
    }
  });
  const series=routed(image,180,120,[{id:'s',rgb:blue,calibration:{x:linear(20,0,140,10),y:linear(100,0,10,10)}}],{x:10,y:5,width:160,height:110,route:'auto',manual:true}).series[0];
  assert.equal(series.route,'find-lines');
  assert.ok(series.accepted.length>=2,JSON.stringify({lines:series.accepted.length,diagnostics:series.diagnostics}));
  const ys=series.accepted.map(line=>line.points[Math.floor(line.points.length/5)][1]);
  assert.ok(Math.abs(ys[0]-ys[1])>12,ys);
});

// Falsify adapter, AGPL-3.0-only. Algorithms below are unmodified PlotTracer.
// WPD curve classes are the separate bundle on globalThis.FalsifyWPDCurve.
import {runColorTrace} from './engine/colorTraceRun';
import {colorFilter, type RGB} from './algorithms/colorFilter';
import {pointsFromColumnRuns} from './algorithms/segmentFill';
import {findLines} from './algorithms/findLines/lines';
import {skeletonize} from './algorithms/findLines/raster';
import {skeletonGraph} from './algorithms/findLines/graph';
import {Calibration} from './core/calibration';
import {XYAxes} from './core/axes/xy';

const UPSTREAM_COMMIT='dcc28a5da453ff5c4e7cadd4478523560d15c0dc';
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const TOLERANCE=31;

function trace(binary:string,width:number,height:number,colorsJson:string,regionJson:string,maxPoints=480):string{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>12000000||binary.length!==width*height*4)throw Error('invalid-image');
  const colors=JSON.parse(colorsJson),region=JSON.parse(regionJson);
  if(!Array.isArray(colors)||colors.length>8||!region||![region.x,region.y,region.width,region.height].every(finite)||region.width<=0||region.height<=0)throw Error('invalid-trace-options');
  const rgba=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)rgba[i]=binary.charCodeAt(i);
  maxPoints=Math.max(3,Math.min(5000,Math.floor(maxPoints)));
  const box={x0:region.x,y0:region.y,x1:region.x+region.width,y1:region.y+region.height};
  const series=region.route==='edit-network'
    ?colors.map((c:any)=>editNetwork(rgba,width,height,c,region))
    :region.route==='auto'
    ?colors.map((c:any)=>routeSeries(rgba,width,height,c,region,box))
    :colors.map((c:any)=>legacySeries(rgba,width,height,c,region,box,maxPoints));
  return JSON.stringify({engine:'plottracer',revision:UPSTREAM_COMMIT,series});
}

// Editing needs every connected stroke, including short joins and error bars.
// Measurement's findLines deliberately prunes those; keep that route unchanged.
function editNetwork(rgba:Uint8Array,width:number,height:number,c:any,region:any){
  if(typeof c.id!=='string'||!Array.isArray(c.rgb)||c.rgb.length!==3||!c.rgb.every((n:unknown)=>finite(n)&&n>=0&&n<=255))throw Error('invalid-color');
  // The editor supplies an ink mask including pale edge coverage. Its tile
  // boundary must survive: local background estimation erodes open tile ends.
  const filtered=colorFilter(rgba,width,height,c.rgb,TOLERANCE,'foreground',region);
  const graph=skeletonGraph(skeletonize(filtered.mask,width,height),width,height);
  if(!hasErrorCaps(graph,width)){
    const box={x0:region.x,y0:region.y,x1:region.x+region.width,y1:region.y+region.height};
    const found=findLines(rgba,width,height,c.rgb,box,{contour:false});
    return {id:c.id,rgb:c.rgb,pixels:[],places:found.places,unresolved:found.unresolved,
      lines:found.lines.map(line=>({...line,nodes:[null,null],endKinds:[null,null]}))};
  }
  const lines=graph.edges.filter(e=>e.pix.length>=2).map(e=>{
    const points=e.pix.map(([y,x])=>[x,y]);
    if(e.a!==null)points[0]=graph.nodes[e.a].c;
    if(e.b!==null)points[points.length-1]=graph.nodes[e.b].c;
    return {points,gaps:[],nodes:[e.a,e.b],endKinds:[e.a===null?null:graph.nodes[e.a].kind,e.b===null?null:graph.nodes[e.b].kind]};
  });
  return {id:c.id,rgb:c.rgb,pixels:[],lines,places:[],unresolved:[]};
}

function hasErrorCaps(graph:ReturnType<typeof skeletonGraph>,width:number){
  return graph.nodes.some((node,id)=>{
    const edges=graph.edges.filter(e=>e.a===id||e.b===id);
    if(edges.length!==3)return false;
    const vectors=edges.map(e=>{
      const point=e.a===id?e.pix[e.pix.length-1]:e.pix[0];
      return [point[1]-node.c[0],point[0]-node.c[1]];
    });
    const caps=vectors.filter(([x,y])=>Math.abs(y)<Math.abs(x)*.4&&Math.abs(x)<=Math.max(12,width*.03));
    return caps.length===2&&caps[0][0]*caps[1][0]<0&&vectors.some(([x,y])=>Math.abs(y)>Math.abs(x)*2);
  });
}

function legacySeries(rgba:Uint8Array,width:number,height:number,c:any,region:any,box:any,maxPoints:number){
  if(typeof c.id!=='string'||!Array.isArray(c.rgb)||c.rgb.length!==3||!c.rgb.every((n:unknown)=>finite(n)&&n>=0&&n<=255))throw Error('invalid-color');
  const traced=runColorTrace(rgba,width,height,c.rgb,TOLERANCE,'foreground',region,maxPoints);
  const lines=c.mode==='color'?{lines:[],places:[],unresolved:[]}:findLines(rgba,width,height,c.rgb,box,{contour:false});
  return {id:c.id,rgb:c.rgb,pixels:'points' in traced?traced.points.map(p=>[p.x,p.y]):[],
    lines:lines.lines,places:lines.places,unresolved:lines.unresolved};
}

function routeSeries(rgba:Uint8Array,width:number,height:number,c:any,region:any,box:any){
  if(typeof c.id!=='string'||!Array.isArray(c.rgb)||c.rgb.length!==3||!c.rgb.every((n:unknown)=>finite(n)&&n>=0&&n<=255))throw Error('invalid-color');
  const requested:RGB=[c.rgb[0],c.rgb[1],c.rgb[2]];
  const effective=dominantInterior(rgba,width,height,requested,region);
  const filtered=colorFilter(rgba,width,height,effective,TOLERANCE,'foreground',region);
  const runs=pointsFromColumnRuns(filtered.mask,width,height).map(p=>({x:p.x,y:p.y}));
  const structure=classifyRuns(filtered.mask,width,height,region,runs);
  const diagnostics={matched:filtered.count,runs:runs.length,multiRunColumns:structure.multi,
    tallSpikes:structure.spikes,medianRunHeight:structure.median,supportedBranches:structure.forks.length};
  const base={id:c.id,rgb:c.rgb,requestedRgb:requested,effectiveRgb:effective,diagnostics,
    pixels:[],lines:[],places:[],unresolved:[],ambiguous:false};
  if(filtered.count<3||runs.length<2)return {...base,route:'column',accepted:[]};
  if(structure.topology){
    const found=findLines(rgba,width,height,effective,box,{contour:false});
    const retained=retainBranches(found,region,structure.forks);
    let accepted=retained.accepted;
    let route:'find-lines'|'column-branches'|'column'='find-lines';
    if(!accepted.length){
      const tracks=splitRuns(runs).filter(track=>track.length>=8&&Math.max(xSpan(track),ySpan(track))>=12);
      if(tracks.length){
        accepted=tracks.map(measuredLine);
        route=tracks.length>1?'column-branches':'column';
      }
    }
    const ambiguous=retained.unresolved.length>0||(found.places||[]).some((p:any)=>p.kind==='split'||p.kind==='unresolved');
    return {...base,route,accepted,lines:found.lines,places:found.places,unresolved:retained.unresolved,ambiguous};
  }
  const calibration=c.calibration;
  if(usableCalibration(calibration)){
    const log=calibration.x.scale==='log'||calibration.y.scale==='log';
    try{
      const kind=log?'interpolate':'step';
      const sampled=runWpd(kind,width,height,filtered.mask,calibration,structure.median);
      const tagged=tagSamples(sampled,filtered.mask,width,height,kind);
      const supported=tagged.points.filter((_,i)=>tagged.inkSupport[i]);
      if(sampled.length>=2&&tracksInk(log?supported:tagged.points,runs)){
        return {...base,route:log?'wpd-xstep':'wpd-step',accepted:[tagged]};
      }
    }catch(error){
      (diagnostics as any).wpdError=error instanceof Error?error.message:String(error);
    }
  }
  return {...base,route:'column',accepted:[columnLine(runs)]};
}

function usableCalibration(calibration:any){
  if(!calibration?.x||!calibration?.y)return false;
  for(const name of ['x','y']){
    const axis=calibration[name];
    if(!axis||!['linear','log'].includes(axis.scale)||!Array.isArray(axis.points)||axis.points.length!==2)return false;
    if(!axis.points.every((p:any)=>p&&finite(p.pixel)&&finite(p.value)&&(axis.scale!=='log'||p.value>0)))return false;
    if(axis.points[0].pixel===axis.points[1].pixel||axis.points[0].value===axis.points[1].value)return false;
  }
  return true;
}

function runWpd(kind:'step'|'interpolate',width:number,height:number,mask:Uint8Array,calibration:any,medianHeight:number){
  const api=(globalThis as any).FalsifyWPDCurve;
  if(!api?.[kind])throw Error('wpd-curve-missing');
  const cal=new Calibration();
  for(const p of calibration.x.points)cal.addPoint(p.pixel,0,p.value,0);
  for(const p of calibration.y.points)cal.addPoint(0,p.pixel,0,p.value);
  const axes=new XYAxes();
  if(!axes.calibrate(cal,calibration.x.scale==='log',calibration.y.scale==='log',true))throw Error('invalid-calibration');
  const indices=new Set<number>();
  for(let i=0;i<mask.length;i++)if(mask[i])indices.add(i);
  const points:number[][]=[];
  const dataSeries={clearAll(){points.length=0},addPixel(x:number,y:number){if(finite(x)&&finite(y))points.push([x,y]);}};
  const algo=new api[kind]();
  const xb=axisBounds(calibration.x),yb=axisBounds(calibration.y);
  const samples=Math.min(1500,Math.max(8,Math.round(xb.pixels/2)));
  let delx=(xb.max-xb.min)/samples;
  if(calibration.x.scale==='log')delx=Math.pow(10,(Math.log10(xb.max)-Math.log10(xb.min))/samples);
  const lineWidth=Math.max(4,Math.min(12,Math.ceil(medianHeight)+2));
  algo.setParams({xmin:xb.min,xmax:xb.max,delx,ymin:yb.min,ymax:yb.max,lineWidth,smoothing:0});
  algo.run({imageWidth:width,imageHeight:height,binaryData:indices},dataSeries,axes,null);
  return points;
}

function axisBounds(axis:any){
  const a=axis.points[0],b=axis.points[1];
  return {min:Math.min(a.value,b.value),max:Math.max(a.value,b.value),pixels:Math.abs(a.pixel-b.pixel)};
}

function classifyRuns(mask:Uint8Array,width:number,height:number,region:any,runs:{x:number,y:number}[]){
  const counts=new Map<number,number>();
  for(const run of runs)counts.set(run.x,(counts.get(run.x)||0)+1);
  let multi=0;
  for(const count of counts.values())if(count>=2)multi++;
  const heights=columnHeights(mask,width,height,region);
  const cols=counts.size;
  const values=[...heights.values()].sort((a,b)=>a-b);
  const median=values.length?values[values.length>>1]:1;
  const cut=Math.max(14,median*3.5);
  const xs=[...heights.keys()].sort((a,b)=>a-b);
  let spikes=0;
  const spikeSpans:{x0:number,x1:number}[]=[];
  for(let i=0;i<xs.length;){
    if((heights.get(xs[i])||0)<cut){i++;continue;}
    let j=i;
    while(j+1<xs.length&&xs[j+1]<=xs[j]+2&&(heights.get(xs[j+1])||0)>=cut)j++;
    const island=xs.slice(i,j+1);
    const peak=Math.max(...island.map(x=>heights.get(x)||0));
    const left=nearestHeight(heights,xs,i,-8),right=nearestHeight(heights,xs,j,8);
    if(xs[j]-xs[i]+1<=6&&left!=null&&right!=null&&left<peak*0.5&&right<peak*0.5){
      spikes++;
      spikeSpans.push({x0:xs[i],x1:xs[j]});
    }
    i=j+1;
  }
  const forks=shortForks(runs,region.width*(region.manual?0.25:0.35),spikeSpans);
  // One thin bar is enough: three-spike gating missed asymmetric error bars and
  // let column midpoints pull the curve off the stroke.
  return {multi,spikes,median,forks,topology:cols>0&&(multi/cols>=0.08||spikes>=1||forks.length>0)};
}

function nearestHeight(heights:Map<number,number>,xs:number[],index:number,reach:number){
  const step=reach<0?-1:1,k=index+step;
  if(k<0||k>=xs.length||Math.abs(xs[k]-xs[index])>Math.abs(reach))return null;
  return heights.get(xs[k])||0;
}

function columnHeights(mask:Uint8Array,width:number,height:number,region:any){
  const x0=Math.max(0,Math.floor(region.x)),y0=Math.max(0,Math.floor(region.y));
  const x1=Math.min(width,Math.floor(region.x+region.width)),y1=Math.min(height,Math.floor(region.y+region.height));
  const heights=new Map<number,number>();
  for(let x=x0;x<x1;x++){
    let start=-1,end=-1,tallest=0,seen=false;
    const push=()=>{if(start>=0)tallest=Math.max(tallest,end-start+1);};
    for(let y=y0;y<y1;y++){
      if(mask[y*width+x]){
        seen=true;
        if(start<0)start=y;
        else if(y-end>2){push();start=y;}
        end=y;
      }
    }
    push();
    if(seen)heights.set(x,tallest);
  }
  return heights;
}

function shortForks(runs:{x:number,y:number}[],minSpan:number,spikeSpans:{x0:number,x1:number}[]){
  const byX=new Map<number,number[]>();
  for(const run of runs){
    const ys=byX.get(run.x);
    if(ys)ys.push(run.y);else byX.set(run.x,[run.y]);
  }
  const xs=[...byX.keys()].sort((a,b)=>a-b);
  const forks:{x0:number,x1:number,points:number[][]}[]=[];
  for(let i=0;i<xs.length;){
    if((byX.get(xs[i])||[]).length<2){i++;continue;}
    let j=i;
    while(j+1<xs.length&&xs[j+1]-xs[j]<=2&&(byX.get(xs[j+1])||[]).length>=2)j++;
    const span=xs.slice(i,j+1);
    const width=span[span.length-1]-span[0]+1;
    const nearSpike=spikeSpans.some(spike=>span[span.length-1]>=spike.x0-10&&span[0]<=spike.x1+10);
    if(width>=12&&width<minSpan&&!nearSpike){
      const track=branchTrack(span,xs,byX);
      if(track)forks.push({x0:span[0],x1:span[span.length-1],points:track});
    }
    i=j+1;
  }
  return forks;
}

function branchTrack(span:number[],xs:number[],byX:Map<number,number[]>){
  const x0=span[0],x1=span[span.length-1];
  let anchor:number|undefined;
  for(let i=xs.length-1;i>=0;i--)if(xs[i]<x0-1&&byX.get(xs[i])!.length===1){anchor=byX.get(xs[i])![0];break;}
  if(anchor==null)for(const x of xs)if(x>x1+1&&byX.get(x)!.length===1){anchor=byX.get(x)![0];break;}
  const primary:number[]=[],secondary:number[]=[];
  for(const x of span){
    const ys=byX.get(x)!;
    const prev=primary.length?primary[primary.length-1]:anchor;
    const main=prev==null?ys.reduce((a,b)=>Math.min(a,b)):ys.reduce((best,y)=>Math.abs(y-prev)<Math.abs(best-prev)?y:best);
    let side=ys[0],sideDist=-1;
    for(const y of ys){const dist=Math.abs(y-main);if(dist>sideDist){side=y;sideDist=dist;}}
    primary.push(main);secondary.push(side);
  }
  const along=secondary.map((y,index)=>Math.abs(y-primary[index]));
  const root=Math.min(along[0]||0,along[along.length-1]||0);
  const tip=Math.max(along[0]||0,along[along.length-1]||0);
  let smooth=0;
  for(let index=1;index<secondary.length;index++)if(Math.abs(secondary[index]-secondary[index-1])<=8)smooth++;
  const smoothEnough=!(secondary.length>1&&smooth<(secondary.length-1)*0.6);
  // The join is still one run, so the first split can already be a stroke-width apart.
  // Caps stay far at both ends; a fork is close at one end and leaves at the other.
  if(root>28||tip<root+12||tip<10||!smoothEnough)return null;
  return secondary.map((y,index)=>[span[index],y]);
}

function retainBranches(found:any,_region:any,forks:{x0:number,x1:number,points:number[][]}[]){
  const accepted:any[]=[];
  const unresolved:number[][][]=[...(found.unresolved||[])];
  const onBranch=(points:number[][])=>forks.some(fork=>branchHit(points,fork));
  // Upstream already separated whiskers and short branches. A width fraction
  // dropped those lines and left only the long stroke.
  for(const line of found.lines||[]){
    if(line?.points&&line.points.length>=2)accepted.push(fromFound(line));
  }
  for(const frag of found.labelInk||[]){
    if(!Array.isArray(frag)||frag.length<2||!onBranch(frag)||accepted.some(line=>covers(line.points,frag)))continue;
    accepted.push(measuredLine(frag));
  }
  for(const fork of forks){
    if(fork.points.length<2||accepted.some(line=>covers(line.points,fork.points)))continue;
    // Upstream dropped the fragment (short-line or label-ink gate). Keep its own
    // measured track; do not average it back into the other branch.
    accepted.push(measuredLine(fork.points));
  }
  return {accepted,unresolved};
}

function branchHit(points:number[][],fork:{x0:number,x1:number,points:number[][]}){
  let hit=0;
  for(const point of points){
    if(point[0]<fork.x0-2||point[0]>fork.x1+2)continue;
    if(fork.points.some(sample=>Math.abs(sample[0]-point[0])<=2&&Math.abs(sample[1]-point[1])<=6))hit++;
  }
  return hit>=2&&hit>=Math.min(points.length,fork.points.length)*0.45;
}

function covers(points:number[][],track:number[][]){
  let hit=0;
  for(const sample of track)if(points.some(point=>Math.abs(point[0]-sample[0])<=3&&Math.abs(point[1]-sample[1])<=6))hit++;
  return hit>=Math.max(2,Math.ceil(track.length*0.6));
}

function measuredLine(points:number[][]){
  return {points,roles:points.map(()=>'measured'),origins:points.map(()=>'pixel-calibrated'),gaps:pixelGaps(points),closed:false,fragment:'supported-branch'};
}

function fromFound(line:any){
  const roles:string[]=line.roles||[];
  const origins=line.points.map((_:number[],index:number)=>roles[index]==='bridged'?'curve-interpolated':'pixel-calibrated');
  return {points:line.points,roles,origins,gaps:line.gaps||[],closed:!!line.closed};
}

function columnLine(runs:{x:number,y:number}[]){
  const points=runs.map(run=>[run.x,run.y]);
  return {points,roles:points.map(()=>'measured'),origins:points.map(()=>'pixel-calibrated'),gaps:pixelGaps(points),closed:false};
}

function tagSamples(points:number[][],mask:Uint8Array,width:number,height:number,kind:'step'|'interpolate'){
  const roles:string[]=[],origins:string[]=[],inkSupport:boolean[]=[];
  for(const [x,y] of points){
    const onInk=nearMask(mask,width,height,x,y);
    inkSupport.push(onInk);
    if(kind==='interpolate'){
      // Cubic XStep emits the spline, even when a sample happens to land on ink.
      roles.push(onInk?'ink-supported':'bridged');
      origins.push('curve-interpolated');
    }else{
      roles.push(onInk?'measured':'bridged');
      origins.push(onInk?'pixel-calibrated':'curve-interpolated');
    }
  }
  return {points,roles,origins,inkSupport,gaps:pixelGaps(points),closed:false,
    algorithm:kind==='interpolate'?'XStepWithInterpolationAlgo':'AveragingWindowWithStepSizeAlgo'};
}

function nearMask(mask:Uint8Array,width:number,height:number,x:number,y:number){
  const xi=Math.round(x),yi=Math.round(y);
  for(let radius=0;radius<=2;radius++){
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==radius)continue;
      const xx=xi+dx,yy=yi+dy;
      if(xx>=0&&yy>=0&&xx<width&&yy<height&&mask[yy*width+xx])return true;
    }
  }
  return false;
}

function tracksInk(points:number[][],runs:{x:number,y:number}[]){
  if(points.length<2||runs.length<2)return false;
  let sum=0,n=0,worst=0;
  for(const [x,y] of points){
    let best=1e9,bestY=0;
    for(const run of runs){
      const dx=Math.abs(run.x-x);
      if(dx<best){best=dx;bestY=run.y;}
    }
    if(best<=2){
      const dy=Math.abs(bestY-y);
      sum+=dy;n++;worst=Math.max(worst,dy);
    }
  }
  return n>=Math.min(points.length,runs.length)*0.6&&sum/n<=2.5&&worst<=8;
}

function pixelGaps(points:number[][]){
  if(points.length<3)return [];
  const steps=[];
  for(let i=1;i<points.length;i++)steps.push(Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
  const ordered=[...steps].sort((a,b)=>a-b);
  const median=ordered[ordered.length>>1]||1;
  const gaps=[];
  for(let i=1;i<points.length;i++)if(steps[i-1]>Math.max(12,median*4))gaps.push([points[i-1],points[i]]);
  return gaps;
}

function xSpan(points:number[][]){
  let lo=Infinity,hi=-Infinity;
  for(const p of points){if(p[0]<lo)lo=p[0];if(p[0]>hi)hi=p[0];}
  return hi-lo;
}

function ySpan(points:number[][]){
  let lo=Infinity,hi=-Infinity;
  for(const p of points){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1];}
  return hi-lo;
}

function splitRuns(runs:{x:number,y:number}[]){
  const byX=new Map<number,number[]>();
  for(const run of runs){
    const ys=byX.get(run.x);
    if(ys)ys.push(run.y);else byX.set(run.x,[run.y]);
  }
  const tracks:{x:number,y:number}[][]=[];
  for(const x of [...byX.keys()].sort((a,b)=>a-b)){
    const ys=byX.get(x)!.slice().sort((a,b)=>a-b);
    const used=new Set<number>();
    for(const track of tracks){
      const last=track[track.length-1];
      let best=-1,bestDist=1e9;
      ys.forEach((y,index)=>{
        if(used.has(index)||x-last.x>3)return;
        const dist=Math.abs(y-last.y);
        if(dist<bestDist){bestDist=dist;best=index;}
      });
      if(best>=0&&bestDist<=14){track.push({x,y:ys[best]});used.add(best);}
    }
    ys.forEach((y,index)=>{if(!used.has(index))tracks.push([{x,y}]);});
  }
  return tracks.filter(track=>track.length>=2).map(track=>track.map(point=>[point.x,point.y]));
}

function dominantInterior(rgba:Uint8Array,width:number,height:number,requested:RGB,region:any):RGB{
  const x0=Math.max(0,Math.floor(region.x)),y0=Math.max(0,Math.floor(region.y));
  const x1=Math.min(width,Math.floor(region.x+region.width)),y1=Math.min(height,Math.floor(region.y+region.height));
  const target=rgbToHsv(requested);
  if(target.s<0.12)return requested;
  const tol2=TOLERANCE*TOLERANCE;
  const seeds:number[]=[];
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const p=y*width+x,i=p*4;
    if(rgba[i+3]===0)continue;
    const dr=rgba[i]-requested[0],dg=rgba[i+1]-requested[1],db=rgba[i+2]-requested[2];
    if(dr*dr+dg*dg+db*db<=tol2)seeds.push(p);
  }
  if(seeds.length<8)return requested;
  const near=new Uint8Array(width*height);
  for(const p of seeds){
    const x=p%width,y=(p-x)/width;
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
      const xx=x+dx,yy=y+dy;
      if(xx>=x0&&yy>=y0&&xx<x1&&yy<y1)near[yy*width+xx]=1;
    }
  }
  const interior:RGB[]=[];
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const p=y*width+x;
    if(!near[p])continue;
    const rgb=pixel(rgba,p);
    const hsv=rgbToHsv(rgb);
    if(hsv.s<0.18||hueDistance(hsv.h,target.h)>16)continue;
    if(interiorNeighbors(rgba,width,height,x,y,x0,y0,x1,y1,target.h)>=6)interior.push(rgb);
  }
  if(interior.length<12)return requested;
  const median=medianRgb(interior);
  const ink=rgbToHsv(median);
  if(hueDistance(ink.h,target.h)>16||ink.s+0.02<target.s)return requested;
  const dr=median[0]-requested[0],dg=median[1]-requested[1],db=median[2]-requested[2];
  if(dr*dr+dg*dg+db*db<=18*18)return requested;
  return median;
}

function interiorNeighbors(rgba:Uint8Array,width:number,height:number,x:number,y:number,x0:number,y0:number,x1:number,y1:number,hue:number){
  let same=0;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;
    const xx=x+dx,yy=y+dy;
    if(xx<x0||yy<y0||xx>=x1||yy>=y1||xx<0||yy<0||xx>=width||yy>=height)continue;
    const hsv=rgbToHsv(pixel(rgba,yy*width+xx));
    if(hsv.s>=0.18&&hueDistance(hsv.h,hue)<=16)same++;
  }
  return same;
}

function pixel(rgba:Uint8Array,p:number):RGB{
  const i=p*4;
  return [rgba[i],rgba[i+1],rgba[i+2]];
}

function medianRgb(colors:RGB[]):RGB{
  const channel=(index:0|1|2)=>{
    const values=colors.map(color=>color[index]).sort((a,b)=>a-b);
    const mid=values.length>>1;
    return values.length%2?values[mid]:Math.round((values[mid-1]+values[mid])/2);
  };
  return [channel(0),channel(1),channel(2)];
}

function rgbToHsv(rgb:RGB){
  const r=rgb[0]/255,g=rgb[1]/255,b=rgb[2]/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  let h=0;
  if(d){
    if(max===r)h=((g-b)/d)%6;
    else if(max===g)h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;if(h<0)h+=360;
  }
  return {h,s:max?d/max:0,v:max};
}

function hueDistance(a:number,b:number){
  const d=Math.abs(a-b)%360;
  return Math.min(d,360-d);
}

function calibrate(calibrationJson:string,pixelsJson:string):string{
  const c=JSON.parse(calibrationJson),pixels=JSON.parse(pixelsJson);
  for(const name of ['x','y']){
    const a=c?.[name];
    if(!a||!['linear','log'].includes(a.scale)||!Array.isArray(a.points)||a.points.length!==2||
      !a.points.every((p:any)=>p&&finite(p.pixel)&&finite(p.value)&&(a.scale!=='log'||p.value>0))||
      a.points[0].pixel===a.points[1].pixel||a.points[0].value===a.points[1].value)throw Error('invalid-calibration');
  }
  if(!Array.isArray(pixels)||pixels.length>10000||!pixels.every(p=>Array.isArray(p)&&p.length===2&&p.every(finite)))throw Error('invalid-points');
  const cal=new Calibration();
  for(const p of c.x.points)cal.addPoint(p.pixel,0,p.value,0);
  for(const p of c.y.points)cal.addPoint(0,p.pixel,0,p.value);
  const axes=new XYAxes();
  if(!axes.calibrate(cal,c.x.scale==='log',c.y.scale==='log',true))throw Error('invalid-calibration');
  const points=pixels.map(p=>axes.pixelToData(p[0],p[1]));
  if(!points.every(p=>p.every(finite)))throw Error('value-out-of-range');
  return JSON.stringify({points});
}
Object.defineProperty(globalThis,'FalsifyPlotTracer',{value:Object.freeze({trace,calibrate,VERSION:'2.6.0',UPSTREAM_COMMIT}),configurable:false});

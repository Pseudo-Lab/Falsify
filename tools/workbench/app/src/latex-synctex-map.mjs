// Based on TeXlyre latexSynctexParser.ts, 92b50ca050af8473f0fd51a048a7e1d60dcdb2dc (AGPL-3.0-or-later).
import {gunzipSync} from 'fflate';

export function parseSynctex(bytes,{project}={}) {
  const input = new Uint8Array(bytes);
  const text = new TextDecoder().decode(input[0]===31 && input[1]===139 ? gunzipSync(input) : input);
  const inputs=new Map(), boxes=[]; let page=0, content=false, unit=1, mag=1000, xOffset=0, yOffset=0;
  const paths=new Set((project?.files||[]).map(f=>f.path));
  const normalize=p=>p.replaceAll('\\','/').replace(/^\.\//,'');
  for (const raw of text.split(/\r?\n/)) {
    if(raw.startsWith('Input:')) { const m=/^Input:(\d+):(.*)$/.exec(raw); if(m) inputs.set(+m[1],normalize(m[2].trim())); continue; }
    if(!content) {
      const m=/^(Unit|Magnification|X Offset|Y Offset):\s*(-?\d+)/.exec(raw);
      if(m) {if(m[1]==='Unit')unit=+m[2]; else if(m[1]==='Magnification')mag=+m[2]; else if(m[1]==='X Offset')xOffset=+m[2]; else yOffset=+m[2];}
      if(raw==='Content:') content=true; continue;
    }
    if(raw.startsWith('Postamble:')) break;
    if(raw[0]==='{') {page=Number.parseInt(raw.slice(1),10); continue;}
    if(raw[0]==='}') {page=0;continue;}
    if(!page || !['h','(','['].includes(raw[0]))continue;
    const m=/^[h(\[](-?\d+),(-?\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/.exec(raw);
    if(!m)continue;
    const source=inputs.get(+m[1]); if(!source)continue;
    const matches=paths.has(source) ? [source] : [...paths].filter(p=>source.endsWith('/'+p));
    if(matches.length!==1)continue;
    // SyncTeX coordinates are scaled TeX points measured from page top-left;
    // PDF points use 72/in instead of TeX's 72.27/in.
    const scale=unit*(mag/1000)/65536*72/72.27;
    const x=(+m[4]+xOffset)*scale, baseline=(+m[5]+yOffset)*scale;
    const width=+m[6]*scale, height=+m[7]*scale, depth=+m[8]*scale;
    if(width<=0 || height+depth<=0)continue;
    boxes.push({path:matches[0],line:+m[2],pageIndex:page-1,box:{x,y:baseline-height,width,height:height+depth}});
  }
  return {schema:'falsify.synctex-map.v1',projectId:project?.id,boxes};
}
export function mapPdfToSource(map,{pageIndex,x,y}) {
  const hits=map.boxes.filter(({pageIndex:p,box:b})=>p===pageIndex && x>=b.x && x<=b.x+b.width && y>=b.y && y<=b.y+b.height).sort((a,b)=>a.box.width*a.box.height-b.box.width*b.box.height);
  return {status:hits.length?'matched':'missing',candidates:hits.map(({path,line,box})=>({path,line,box}))};
}
export function mapSourceToPdf(map,{path,line}) {
  const hits=map.boxes.filter(b=>b.path===path && b.line===line);
  return {status:hits.length?'matched':'missing',candidates:hits.map(({path,line,pageIndex,box})=>({path,line,pageIndex,box}))};
}

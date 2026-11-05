// Locate academic tables from their own captions, horizontal rules and aligned
// data rows. This is source observation, not authority to edit a PDF cell.
const within=(a,b,t=1)=>a[0]>=b[0]-t&&a[1]>=b[1]-t&&a[2]<=b[2]+t&&a[3]<=b[3]+t;
const union=bs=>[Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))];
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
export function findPublicationTables(pages,drawings=[]){
  const out=[];
  for(const p of pages){
    const rules=[...p.rules,...drawings.filter(d=>d.pageIndex===p.pageIndex&&d.operation==='fill'&&d.bbox[2]-d.bbox[0]>60&&d.bbox[3]-d.bbox[1]<1.5).map(d=>({bbox:d.bbox}))].filter(r=>r.bbox[2]-r.bbox[0]>60&&r.bbox[3]-r.bbox[1]<2);
    const captions=p.runs.filter(r=>/^\s*Table\s+\d+[a-z]?[.:|]?\s+/iu.test(r.text)&&!/^\s*Table\s+\d+[a-z]?\s+(?:shows|is|are|was|were|lists|reports|summarizes|compares)\b/iu.test(r.text)).sort((a,b)=>a.bbox[1]-b.bbox[1]);
    function collectTable(caption) {
      const top=rules.filter(r=>r.bbox[1]>=caption.bbox[3]-.5&&r.bbox[1]-caption.bbox[3]<45&&r.bbox[0]<(caption.bbox[0]+caption.bbox[2])/2&&r.bbox[2]>(caption.bbox[0]+caption.bbox[2])/2).sort((a,b)=>a.bbox[1]-b.bbox[1])[0];if(!top)return;
      const next=captions.find(c=>c.bbox[1]>top.bbox[3]&&c.bbox[0]<top.bbox[2]&&c.bbox[2]>top.bbox[0]);
      const peers=rules.filter(r=>Math.abs(r.bbox[0]-top.bbox[0])<2&&Math.abs(r.bbox[2]-top.bbox[2])<2&&r.bbox[1]>=top.bbox[1]-.1&&r.bbox[3]<(next?.bbox[1]??Math.min(p.height*.94,top.bbox[1]+350))).sort((a,b)=>a.bbox[1]-b.bbox[1]);
      const unique=peers.filter((r,i)=>!i||r.bbox[1]-peers[i-1].bbox[1]>2);if(unique.length<3)return;
      const separator=unique[1],bottom=unique.at(-1),bbox=[top.bbox[0],top.bbox[1],top.bbox[2],bottom.bbox[3]],runs=p.runs.filter(r=>within(r.bbox,bbox,.5));
      const data=runs.filter(r=>r.bbox[1]>separator.bbox[3]-.5&&r.bbox[3]<bottom.bbox[1]+.5),lines=[];
      for(const r of [...data].sort((a,b)=>a.bbox[3]-b.bbox[3]||a.bbox[0]-b.bbox[0])){const row=lines.find(x=>Math.abs(x.y-r.bbox[3])<2);if(row)row.runs.push(r);else lines.push({y:r.bbox[3],runs:[r]});}
      if(lines.length<2)return;
      const counts=new Map();for(const l of lines)counts.set(l.runs.length,(counts.get(l.runs.length)||0)+1);
      const cols=[...counts].filter(([n])=>n>=2&&n<=12).sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0]?.[0];if(!cols)return;
      const full=lines.filter(l=>l.runs.length===cols);if(full.length<2||full.length<lines.length*.75)return;
      const anchors=Array.from({length:cols},(_,c)=>median(full.map(l=>[...l.runs].sort((a,b)=>a.bbox[0]-b.bbox[0])[c].bbox[0])));
      if(full.some(l=>[...l.runs].sort((a,b)=>a.bbox[0]-b.bbox[0]).some((r,c)=>Math.abs(r.bbox[0]-anchors[c])>5)))return;
      if(!full.some(l=>l.runs.slice(1).some(r=>/\d/u.test(r.text))))return;
      // Assign by observed left edges; unit-bearing numbers stay verbatim.
      const column=r=>{let best=0;for(let c=1;c<cols;c++)if(Math.abs(r.bbox[0]-anchors[c])<Math.abs(r.bbox[0]-anchors[best]))best=c;return best;};
      const header=runs.filter(r=>r.bbox[3]<separator.bbox[1]+.5),rowRuns=[header,...lines.map(l=>l.runs)];
      const rows=rowRuns.map(rs=>Array.from({length:cols},(_,c)=>{const parts=rs.filter(r=>column(r)===c).sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);return {text:parts.map(r=>r.text).join(' '),runs:parts,bbox:parts.length?union(parts.map(r=>r.bbox)):null};}));
      const used=rows.flat().flatMap(c=>c.runs);if(used.length!==runs.length||new Set(used.map(r=>r.id)).size!==runs.length)return;
      out.push({pageIndex:p.pageIndex,bbox,caption,rows,columns:cols,method:'caption-horizontal-rules-aligned-rows'});
    }
    for(const caption of captions)collectTable(caption);
  }
  return out;
}

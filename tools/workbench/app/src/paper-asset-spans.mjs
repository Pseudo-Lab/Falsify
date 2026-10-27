// Resolve only uniquely nominated, observed output image placements. Coordinates are
// MuPDF display points; Typst marker positions are boundaries, never image boxes.
const box = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const overlaps = (a,b) => a[0]<b[2] && a[2]>b[0] && a[1]<b[3] && a[3]>b[1];
const inside = (b,p,t=0.5) => b[0]>=p[0]-t && b[1]>=p[1]-t && b[2]<=p[2]+t && b[3]<=p[3]+t;

export function resolveOutputAssetSpans({bytes,mupdf,flow,blockSpans}={}) {
  const spans=[], evidence=[];
  if (!mupdf || !(bytes instanceof Uint8Array) || !flow || !Array.isArray(flow.items) || !Array.isArray(blockSpans)) return {spans,evidence:[{reason:'invalid-input'}]};
  const items=flow.items.filter(x=>x?.kind==='asset');
  const idFor=i=>i.renderAssetId || (i.assetIds?.length===1 ? i.assetIds[0] : null);
  const counts=new Map();
  for (const i of items) for (const id of new Set([idFor(i),...(i.assetIds || [])].filter(Boolean))) counts.set(id,(counts.get(id)||0)+1);
  const nominations=new Map();
  for (const s of blockSpans) if (typeof s?.id==='string') nominations.set(s.id,[...(nominations.get(s.id)||[]),s]);
  let doc;
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf');
    const pages=[];
    for(let pi=0;pi<doc.countPages();pi++) {
      const page=doc.loadPage(pi), placements=[], clips=[]; let failed=false, maskDepth=0, dev;
      try {
        const bounds=[...page.getBounds()];
        dev=new mupdf.Device({
          clipPath(path,evenOdd,ctm) { try { const points=[]; let complex=false,closed=false; path.walk({moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},curveTo(){complex=true;},closePath(){closed=true;}}); if (points.length>1 && points[0][0]===points.at(-1)[0] && points[0][1]===points.at(-1)[1]) points.pop(); const xs=new Set(points.map(p=>p[0])),ys=new Set(points.map(p=>p[1])); const axis=Math.abs(ctm[1])<1e-8 && Math.abs(ctm[2])<1e-8; const rect=axis && !complex && closed && points.length===4 && xs.size===2 && ys.size===2 && points.every((p,i)=>{const n=points[(i+1)%4];return (p[0]===n[0]) !== (p[1]===n[1]);}); clips.push(rect ? [...path.getBounds(null,ctm)] : null); } catch {clips.push(null);} finally {path.destroy();} },
          clipStrokePath(path,stroke){path.destroy();stroke.destroy();clips.push(null);},
          clipText(text){text.destroy();clips.push(null);},
          clipStrokeText(text,stroke){text.destroy();stroke.destroy();clips.push(null);},
          clipImageMask(image,ctm){clips.push({mask:image,ctm:[...ctm]});},
          popClip(){if(clips.length) clips.pop()?.mask?.destroy(); else failed=true;},
          fillImage(image,ctm,alpha) { try { const [a,b,c,d,e,f]=ctm; const bbox=[Math.min(e,e+a,e+c,e+a+c),Math.min(f,f+b,f+d,f+b+d),Math.max(e,e+a,e+c,e+a+c),Math.max(f,f+b,f+d,f+b+d)]; if (!maskDepth) { const mask=image.getMask(); let intrinsicMasks=0; const clipOK=clips.every(clip=>{if (clip?.mask) {intrinsicMasks++; return intrinsicMasks===1 && mask && mask.pointer===clip.mask.pointer && clip.ctm.every((v,i)=>Math.abs(v-ctm[i])<1e-5);} return clip && inside(bbox,clip);}); mask?.destroy(); placements.push({bbox,valid:ctm.every(Number.isFinite) && a>0 && d>0 && Math.abs(b)<1e-5 && Math.abs(c)<1e-5 && alpha===1 && box(bbox) && inside(bbox,bounds) && clipOK, uncertainClip:!clipOK}); } } finally {image.destroy();} },
          fillImageMask(image,ctm) { try { if (!maskDepth) { const [a,b,c,d,e,f]=ctm; placements.push({bbox:[Math.min(e,e+a,e+c,e+a+c),Math.min(f,f+b,f+d,f+b+d),Math.max(e,e+a,e+c,e+a+c),Math.max(f,f+b,f+d,f+b+d)],valid:false}); } } finally {image.destroy();} },
          beginMask(area,luminosity,colorspace) {maskDepth++; colorspace?.destroy();},
          endMask(){if (maskDepth) {maskDepth--; clips.push(null);} else failed=true;}
        });
        page.run(dev,mupdf.Matrix.identity); dev.close();
        pages.push({bounds,placements,failed});
      } catch {pages.push({bounds:null,placements:[],failed:true});} finally {for (const clip of clips) clip?.mask?.destroy(); dev?.destroy();page.destroy();}
    }
    const claims=[];
    for(const item of items) {
      const id=idFor(item), ids=item.assetIds || [], ns=nominations.get(id) || [], b=item.source?.bbox;
      let reason=null, candidates=[];
      if (!id || !Array.isArray(ids) || ids.some(x=>typeof x!=='string' || !x) || new Set(ids).size!==ids.length || [id,...ids].some(x=>counts.get(x)!==1)) reason='unbound-or-duplicate-id';
      else if (ns.length!==1) reason='missing-or-duplicate-marker';
      else if (box(b) && items.some(other=>other!==item && other.source?.pageIndex===item.source?.pageIndex && box(other.source?.bbox) && overlaps(b,other.source.bbox))) reason='overlapping-source-assets';
      else {
        const {start:s,end:e,sourcePage}=ns[0];
        if (!s || !e || !Number.isInteger(item.source?.pageIndex) || sourcePage!==item.source.pageIndex || !Number.isInteger(s.page) || s.page!==e.page || s.page<1 || s.page>pages.length || ![s.x,s.y,e.x,e.y].every(Number.isFinite) || e.y-s.y<5 || Math.abs(e.x-s.x)>1 || (sourcePage!=null && sourcePage!==item.source?.pageIndex)) reason='invalid-marker';
        else {
          const pg=pages[s.page-1], height=e.y-s.y, tol=1.5;
          if (pg.failed || !box(pg.bounds) || !inside([s.x,s.y,s.x+0.001,e.y],pg.bounds)) reason='unavailable-page';
          else {
            const matching=pg.placements.filter(p=>Math.abs(p.bbox[0]-s.x)<=tol && Math.abs(p.bbox[1]-s.y)<=tol && Math.abs(p.bbox[3]-e.y)<=tol && Math.abs((p.bbox[3]-p.bbox[1])-height)<=2*tol && (!box(b) || Math.abs(Math.log(((p.bbox[2]-p.bbox[0])/(p.bbox[3]-p.bbox[1]))/((b[2]-b[0])/(b[3]-b[1]))))<=0.02));
            candidates=matching.filter(p=>p.valid);
            if(candidates.length!==1) reason=candidates.length?'ambiguous-placement':matching.some(p=>p.uncertainClip)?'masked-or-clipped-placement':'no-matching-placement';
            else if (pg.placements.some(p=>p!==candidates[0] && box(p.bbox) && overlaps(p.bbox,candidates[0].bbox))) reason='overlapping-placement';
            else claims.push({id,ids,pageIndex:s.page-1,placement:candidates[0]});
          }
        }
      }
      evidence.push({id,reason:reason || 'candidate',candidateCount:candidates.length});
    }
    for(const claim of claims) {
      const shared=claims.filter(c=>c.pageIndex===claim.pageIndex && c.placement===claim.placement).length>1;
      const entry=evidence.find(e=>e.id===claim.id);
      if(shared) {entry.reason='placement-claimed-more-than-once';continue;}
      entry.reason='resolved';
      for(const id of new Set([claim.id,...claim.ids])) spans.push({id,pageIndex:claim.pageIndex,bbox:[...claim.placement.bbox]});
    }
  } catch {return {spans:[],evidence:[{reason:'pdf-unavailable'}]};} finally {doc?.destroy();}
  return {spans,evidence};
}

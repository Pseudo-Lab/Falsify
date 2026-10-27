// Independent, bounded observations of the generated PDF. Boxes use MuPDF display coordinates.
const valid = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2]>b[0] && b[3]>b[1];
const area = b => Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const intersection = (a,b) => [Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
const contains = (a,b) => a[0]<=b[0]+1 && a[1]<=b[1]+1 && a[2]>=b[2]-1 && a[3]>=b[3]-1;
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const norm = s => s.replace(/\s+/gu,' ').trim();
const fontIdentity = name => String(name).replace(/^[A-Z]{6}\+/u,'');

/** Optional profile: bodyFontSize, bodyFontNames, captions [{text, assetPageIndex, assetBbox}], columns.
 * Metadata nominates a relationship; both caption text and an image placement must be observed independently. */
export function inspectLayoutQuality({bytes,mupdf,profile={},sourceBytes,sourcePageIndexes}={}) {
  const issues=[], pages=[], captionObservations=[], limitations=[
    'Text paint bounds are glyph ink extents; structured text character boxes are font metrics.',
    'Only axis-aligned rectangular clip paths are checked; arbitrary clips, transparency, occlusion, rotated text, vector figure ownership, and reading order remain unverified.',
    'Scores measure detected defects only; they are not proof of visual quality.'
  ], profileCoverage={coordinateSpace:profile.coordinateSpace || 'unspecified',bodyLines:{checked:0,skipped:0},fontNames:{checked:0,skipped:0},captions:{checked:0,skipped:0},columns:{checked:0,skipped:0},headings:{checked:0,skipped:0}};
  const add=(type,pageIndex,bbox,penalty,evidence)=>issues.push({type,pageIndex,bbox:bbox.map(x=>Math.round(x*100)/100),penalty,evidence});
  if (!mupdf?.Document || !mupdf?.Device) return {schema:'falsify.layout-quality.v1',status:'unavailable',score:null,penaltyTerms:{},issues,limitations:[...limitations,'MuPDF unavailable.']};
  let doc;
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf');
    if(doc.countPages()>500) throw Error('page limit exceeded');
    for(let p=0;p<doc.countPages();p++) {
      const page=doc.loadPage(p); let st,dev;
      try {
        const bounds=[...page.getBounds()], runs=[],images=[],lines=[],vectors=[], clips=[]; let unsupportedClips=0;
        if(!valid(bounds) || bounds[0]!==0 || bounds[1]!==0) throw Error('unsupported page bounds');
        st=page.toStructuredText('preserve-whitespace,preserve-images');
        let line=null;
        st.walk({beginLine(_box,wmode,direction){line={text:'',chars:[],horizontal:wmode===0 && direction[0]>0 && Math.abs(direction[1])<0.01};},
          onChar(c,_origin,font,size,quad){if(!line)return; const b=[Math.min(quad[0],quad[2],quad[4],quad[6]),Math.min(quad[1],quad[3],quad[5],quad[7]),Math.max(quad[0],quad[2],quad[4],quad[6]),Math.max(quad[1],quad[3],quad[5],quad[7])]; line.text+=c; if(valid(b)&&c.trim())line.chars.push({bbox:b,size,font:font.getName()});},
          endLine(){if(line?.chars.length)lines.push({...line,bbox:union(line.chars.map(c=>c.bbox))});line=null;},
          onImageBlock(bbox,_transform,image){try{if(valid(bbox))images.push([...bbox]);}finally{image.destroy();}}});
        const collect=(text,ctm,resources,alpha)=>{try {if(alpha>0){const b=[...text.getBounds(null,ctm)];if(valid(b)){runs.push(b); const active=clips.filter(Boolean); if(active.length && !clips.includes(null)){const clip=active.reduce(intersection); if(!contains(clip,b) && area(intersection(clip,b)) < area(b)-1) add('text-clipped',p,b,10,{clipBounds:clip,source:'text-paint-and-rectangular-clip'});}}}} finally {text.destroy();resources.forEach(r=>r?.destroy());}};
        const path=(obj,stroke,ctm,cs,alpha)=>{try{if(alpha>0){const b=[...obj.getBounds(stroke,ctm)];if(valid(b))vectors.push(b);}}finally{obj.destroy();stroke?.destroy();cs?.destroy();}};
        dev=new mupdf.Device({clipPath(o,_eo,c){try{const points=[];let closed=false,complex=false;o.walk({moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},curveTo(){complex=true;},closePath(){closed=true;}}); const axis=Math.abs(c[1])<1e-8 && Math.abs(c[2])<1e-8; const xs=[...new Set(points.map(q=>q[0]))],ys=[...new Set(points.map(q=>q[1]))]; const rectangle=!complex && closed && points.length===4 && xs.length===2 && ys.length===2 && points.every((q,i)=>{const n=points[(i+1)%4];return (q[0]===n[0]) !== (q[1]===n[1]);}); const b=[...o.getBounds(null,c)]; if(axis && rectangle && valid(b)) clips.push(b); else {clips.push(null);unsupportedClips++;}}finally{o.destroy();}},clipText(t){t.destroy();clips.push(null);unsupportedClips++;},clipStrokeText(t,stroke){t.destroy();stroke.destroy();clips.push(null);unsupportedClips++;},clipStrokePath(o,stroke){o.destroy();stroke.destroy();clips.push(null);unsupportedClips++;},clipImageMask(image){image.destroy();clips.push(null);unsupportedClips++;},popClip(){clips.pop();},fillText(t,c,cs,_color,a){collect(t,c,[cs],a);},strokeText(t,s,c,cs,_color,a){collect(t,c,[s,cs],a);},fillPath(o,_eo,c,cs,_color,a){path(o,null,c,cs,a);},strokePath(o,s,c,cs,_color,a){path(o,s,c,cs,a);}});
        page.run(dev,mupdf.Matrix.identity);dev.close();
        if(runs.length>2000 || lines.length>10000 || images.length>2000 || vectors.length>20000) throw Error('geometry limit exceeded');
        for(const b of runs) if(b[0]<-1 || b[1]<-1 || b[2]>bounds[2]+1 || b[3]>bounds[3]+1) add('ink-outside-page',p,b,10,{pageBounds:bounds,source:'text-paint-ink'});
        // Multiple text paint operations are compared; containment and near-touching ink are not collisions.
        for(let i=0;i<runs.length;i++) for(let j=i+1;j<runs.length;j++) {
          const a=runs[i],b=runs[j],over=intersection(a,b),n=area(over);
          if(n>4 && over[2]-over[0]>3 && over[3]-over[1]>2 && n/Math.min(area(a),area(b))>0.12 && !contains(a,b) && !contains(b,a)) add('text-overlap',p,over,8,{first:a,second:b,overlapArea:n,source:'text-paint-ink'});
        }
        for(const line of lines) if(line.horizontal) {
          for(const b of images) {const overlap=intersection(line.bbox,b), n=area(overlap); if(n>4 && n/area(line.bbox)>0.2 && !contains(b,line.bbox)) add('text-image-overlap',p,overlap,8,{text:line.text,image:b,overlapArea:n,source:'structured-text-and-image'});}

        }
        pages.push({pageIndex:p,bounds,lines,images,vectorCount:vectors.length,unsupportedClips});
      } finally {dev?.destroy();st?.destroy();page.destroy();}
    }
    // Source text is a nomination only: unique actual output text establishes the candidate.
    for(const body of profile.bodyLines || []) {
      const target=norm(body?.text || '');
      const matches=target ? pages.flatMap(page=>page.lines.filter(line=>line.horizontal && norm(line.text)===target).map(line=>({page,line}))) : [];
      if(matches.length!==1) {profileCoverage.bodyLines.skipped++;continue;}
      const {page,line}=matches[0];profileCoverage.bodyLines.checked++;
      const sizes=line.chars.map(c=>c.size).filter(Number.isFinite).sort((a,b)=>a-b),size=sizes.length?sizes[Math.floor(sizes.length/2)]:null;
      const expectedSize=Number.isFinite(body.sourceFontSize) && body.sourceFontSize>0 ? body.sourceFontSize : profile.bodyFontSize;
      if(Number.isFinite(expectedSize) && size && size<expectedSize*0.8) add('small-body-text',page.pageIndex,line.bbox,5,{text:line.text,size,expectedSize,source:'unique-output-body-line'});
      const aliases=profile.outputBodyFontNames;
      if(Array.isArray(aliases) && aliases.length) {profileCoverage.fontNames.checked++;const allowed=aliases.map(fontIdentity);if(!line.chars.some(c=>allowed.includes(fontIdentity(c.font)))) add('body-font-deviation',page.pageIndex,line.bbox,3,{text:line.text,fonts:[...new Set(line.chars.map(c=>c.font))],expectedFonts:aliases,source:'unique-output-body-line'});}
      else if(profile.bodyFontNames?.length) profileCoverage.fontNames.skipped++;
    }
    if(!(profile.bodyLines || []).length && (profile.bodyFontSize || profile.bodyFontNames?.length || profile.outputBodyFontNames?.length)) {profileCoverage.bodyLines.skipped++;if(profile.bodyFontNames?.length || profile.outputBodyFontNames?.length) profileCoverage.fontNames.skipped++;}
    for(const caption of profile.captions || []) {
      if(profile.coordinateSpace!=='output') {profileCoverage.captions.skipped++;captionObservations.push({id:caption.id,status:'unavailable'});continue;}
      const target=norm(caption.text || '');
      const matches=[];
      if(target) for(const page of pages) for(let i=0;i<page.lines.length;i++) {
        let text=''; const selected=[];
        for(let j=i;j<page.lines.length && j<i+20;j++) {
          const line=page.lines[j], previous=selected.at(-1); if(previous && (line.bbox[1]<previous.bbox[1]-1 || line.bbox[1]-previous.bbox[3]>Math.max(20,(previous.bbox[3]-previous.bbox[1])*1.5) || Math.abs(line.bbox[0]-previous.bbox[0])>30)) break; selected.push(line); text=norm(text+' '+line.text);
          if(text===target) {matches.push({page,line:{text,bbox:union(selected.map(l=>l.bbox))}});break;}
          if(!target.startsWith(text) || text.length>=target.length) break;
        }
      }
      const owner=pages[caption.assetPageIndex], assets=owner?.images.filter(b=>valid(caption.assetBbox) && area(intersection(b,caption.assetBbox))/area(b)>0.9 && area(intersection(b,caption.assetBbox))/area(caption.assetBbox)>0.9);
      if(matches.length!==1 || assets?.length!==1) {profileCoverage.captions.skipped++;captionObservations.push({id:caption.id,status:'unavailable'});limitations.push('Caption or associated image could not be uniquely observed: '+String(caption.text || '').slice(0,80));continue;}
      profileCoverage.captions.checked++;const {page,line}=matches[0], asset=assets[0];
      const gap=page.pageIndex===owner.pageIndex ? Math.max(0,line.bbox[1]-asset[3],asset[1]-line.bbox[3]) : Infinity;
      const horizontalOverlap=Math.min(line.bbox[2],asset[2])-Math.max(line.bbox[0],asset[0]);
      const attached=page.pageIndex===owner.pageIndex && gap<=Math.max(36,(line.bbox[3]-line.bbox[1])*3) && horizontalOverlap>0;
      captionObservations.push({id:caption.id,status:attached?'observed':'separated',text:target,pageIndex:page.pageIndex,bbox:line.bbox,assetBbox:asset});
      if(!attached) add('caption-separated',page.pageIndex,line.bbox,6,{assetPageIndex:owner.pageIndex,assetBbox:asset,gap:Number.isFinite(gap)?gap:null,text:line.text});
    }
    // A source profile nominates the heading and column, but the output must contain it uniquely.
    for(const heading of profile.headings || []) {
      const matches=pages.flatMap(p=>p.lines.filter(l=>norm(l.text)===norm(heading.text || '')).map(line=>({page:p,line})));
      if(matches.length!==1) {profileCoverage.headings.skipped++;limitations.push('Heading could not be uniquely observed: '+String(heading.text || '').slice(0,80));continue;}
      profileCoverage.headings.checked++;const {page,line}=matches[0], next=page.lines.filter(l=>l!==line && l.bbox[1]>=line.bbox[3]-1 && Math.min(l.bbox[2],line.bbox[2])-Math.max(l.bbox[0],line.bbox[0])>0).sort((a,b)=>a.bbox[1]-b.bbox[1])[0];
      if(!next || next.bbox[1]-line.bbox[3]>Math.max(36,(line.bbox[3]-line.bbox[1])*3)) add('heading-orphan',page.pageIndex,line.bbox,4,{text:line.text,nextGap:next?next.bbox[1]-line.bbox[3]:null});
    }
    for(const column of profile.columns || []) {
      if(profile.coordinateSpace!=='output') {profileCoverage.columns.skipped++;continue;}
      const page=pages[column.pageIndex], box=column.bbox;
      if(!page || !valid(box) || !contains(page.bounds,box)) {profileCoverage.columns.skipped++;limitations.push('Column geometry is invalid or unavailable.');continue;}
      const anchor=norm(column.anchorText || ''), anchorMatches=anchor ? pages.flatMap(p=>p.lines.filter(l=>norm(l.text)===anchor).map(line=>({page:p,line}))) : [];
      if(anchorMatches.length!==1 || anchorMatches[0].page.pageIndex!==page.pageIndex || area(intersection(anchorMatches[0].line.bbox,box))>4) {profileCoverage.columns.skipped++;limitations.push('Column anchor is unavailable, ambiguous, on another page, or inside the candidate column.');continue;}
      profileCoverage.columns.checked++;const occupied=page.lines.some(l=>area(intersection(l.bbox,box))>4) || page.images.some(b=>area(intersection(b,box))>4);
      if(!occupied) add('blank-column',column.pageIndex,box,4,{source:'profile-column-with-no-observed-text-or-image',vectorInk:'unverified'});
    }
    // Sparse-page evidence is separate from defect penalties. The ratio measures
    // structured text box area, not visible ink or whitespace by itself. Source
    // comparison requires an explicit output-to-source mapping and source bytes.
    const measure = page => ({pageIndex:page.pageIndex, textCharacters:page.lines.reduce((n,l)=>n+l.chars.length,0), textAreaRatio:Math.min(1,page.lines.reduce((n,l)=>n+area(intersection(l.bbox,page.bounds)),0)/area(page.bounds)), imageCount:page.images.length, vectorCount:page.vectorCount});
    const measurements=pages.map(measure);
    const source = sourceBytes && Array.isArray(sourcePageIndexes) ? inspectLayoutQuality({bytes:sourceBytes,mupdf}) : null;
    const sparsePages=measurements.map((m,i)=>{
      const sparse=m.textAreaRatio<0.08 && m.textCharacters<1200;
      const sourceIndex=sourcePageIndexes?.[i], sm=Number.isInteger(sourceIndex) ? source?.sparsePageEvidence?.pages?.[sourceIndex] : null;
      let classification='not-sparse';
      if(sparse) {
        if(m.textCharacters<40 && (m.imageCount>0 || m.vectorCount>0)) classification='artwork-only';
        else if(i===measurements.length-1) classification='document-final';
        else if(sm && sm.textAreaRatio<0.08 && sm.textCharacters<1200 && sm.textAreaRatio<=Math.max(m.textAreaRatio*1.5,m.textAreaRatio+0.01)) classification='source-equally-sparse';
        else if(sm) classification='candidate';
        else classification='source-context-unavailable';
      }
      return {...m,classification,sourcePageIndex:sm ? sourceIndex : null,sourceTextAreaRatio:sm?.textAreaRatio ?? null};
    });
    const sparsePageEvidence={status:'partial',pages:sparsePages,threshold:{textAreaRatioBelow:0.08,textCharactersBelow:1200},limitation:'Text box area is an approximate occupancy indicator; includes furniture, omits vector/image occupancy and can overlap. Source comparison requires caller-provided page mapping; mappings are not verified ownership. Candidates need visual review.'};
    const penaltyTerms={};for(const issue of issues) penaltyTerms[issue.type]=(penaltyTerms[issue.type]||0)+issue.penalty;
    return {schema:'falsify.layout-quality.v1',status:'partial',score:null,detectedIssuesScore:Math.max(0,100-Object.values(penaltyTerms).reduce((a,b)=>a+b,0)),penaltyTerms,issues,captionObservations,sparsePageEvidence,coverage:{profile:profileCoverage,pages:pages.length,textPaint:true,images:true,vectorPlacements:pages.reduce((n,p)=>n+p.vectorCount,0),captionOwnership:'only unique text and image matches',clipping:'partial: axis-aligned rectangular paths only',unsupportedClipOperations:pages.reduce((n,p)=>n+p.unsupportedClips,0)},limitations};
  } catch(error) {return {schema:'falsify.layout-quality.v1',status:'unavailable',score:null,penaltyTerms:{},issues:[],limitations:[...limitations,String(error?.message || error)]};}
  finally {doc?.destroy();}
}

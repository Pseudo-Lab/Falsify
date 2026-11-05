// Publication roles and inline runs are proposals grounded in source geometry.
// They change typesetting, never the spelling of a source character.
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const bold=s=>/bold|demi|semibold/iu.test(s?.fontName||'');
const italic=s=>/italic|oblique/iu.test(s?.fontName||'');

export function composePublicationText({segments,blocks,styles,joiners=[],separators=[]}) {
  let text='';const inlineRuns=[],lineBreaks=[];
  function segmentJoiner(index,segment){
    let joiner=joiners[index-1]||'';
    if(index&&!joiner){
      const a=segments[index-1].evidence.bbox,z=segment.evidence.bbox,size=styles.get(segment.styleIds[0])?.size||10;
      if((z[0]-a[2]>size*.3&&Math.min(a[3],z[3])>Math.max(a[1],z[1]))||z[1]-a[3]>size*.3)joiner=' ';
    }
    return joiner;
  }
  function appendSegment(index,segment){
    const b=blocks.get(segment.evidence.blockId)||[...blocks.values()].find(b=>b.source?.range?.start===segment.evidence.range.start&&b.source.pageIndex===segment.evidence.pageIndex);
    const joiner=segmentJoiner(index,segment);
    text+=joiner;
    const start=text.length,range=segment.evidence.range;
    const inserts=separators.filter(x=>x.before.blockId===segment.evidence.blockId&&x.offset>range.start&&x.offset<range.end).sort((a,b)=>a.offset-b.offset);
    const position=offset=>start+offset-range.start+inserts.filter(x=>x.offset<=offset).reduce((n,x)=>n+x.separator.length,0);
    let value=segment.text;for(const x of [...inserts].reverse()){const at=x.offset-range.start;value=value.slice(0,at)+x.separator+value.slice(at);}text+=value;
    const chars=(b?.source.characters||[]).filter(c=>c.start>=range.start&&c.end<=range.end),normalSize=median(chars.map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite));
    const lineMetrics=(b?.source.lines||[]).map(line=>{const normal=chars.filter(x=>x.start>=line.range?.start&&x.end<=line.range.end&&Math.abs((styles.get(x.styleId)?.size||0)-normalSize)<.2);return {range:line.range,bottom:median(normal.map(x=>x.bbox[3])),count:normal.length};});
    for(const line of b?.source.lines||[]){if(line.range?.start>range.start&&line.range.start<range.end)lineBreaks.push(position(line.range.start));}
    function appendGlyph(c){
      const style=styles.get(c.styleId);if(!style||!Array.isArray(c.bbox))return;
      const line=lineMetrics.find(l=>l.range?.start<=c.start&&l.range.end>=c.end),bottom=line?.bottom;let script=null;
      if(line?.count&&style.size<normalSize*.85){
        // At a shared baseline, smaller glyph boxes end above the body bottom
        // only by their descent difference. Require a larger measured lift.
        const lift=bottom-c.bbox[3],drop=c.bbox[3]-bottom;
        if(lift>normalSize*.22)script='super';else if(drop>normalSize*.08)script='sub';
      }
      const run={start:position(c.start),end:position(c.end),bold:bold(style),italic:italic(style),script,sizeBp:style.size,evidence:[{...segment.evidence,range:{start:c.start,end:c.end},bbox:[...c.bbox]}]};
      // An inserted boundary space belongs to neither adjacent glyph.
      if(inserts.some(x=>x.offset===c.end))run.end-=inserts.find(x=>x.offset===c.end).separator.length;
      if(run.end<=run.start)return;
      const last=inlineRuns.at(-1);
      if(last&&last.end===run.start&&['bold','italic','script','sizeBp'].every(k=>last[k]===run[k])){last.end=run.end;const a=last.evidence.at(-1),z=run.evidence[0];if(a.blockId===z.blockId&&a.range.end===z.range.start){a.range.end=z.range.end;a.bbox=[Math.min(a.bbox[0],z.bbox[0]),Math.min(a.bbox[1],z.bbox[1]),Math.max(a.bbox[2],z.bbox[2]),Math.max(a.bbox[3],z.bbox[3])];}else last.evidence.push(z);}else inlineRuns.push(run);
    }
    for(const c of chars)appendGlyph(c);
  }
  for(const [index,segment] of segments.entries())appendSegment(index,segment);
  return {text,inlineRuns,lineBreaks};
}

export function assignPublicationRoles(model) {
  const items=model.items.filter(i=>i.text&&!i.assetId),size=i=>i.extensions?.typography?.fontSizeBp||0;
  const bodySize=median(items.filter(i=>i.text.length>200&&i.evidence[0].bbox[1]>model.pages[i.evidence[0].pageIndex].height*.1).map(size).filter(x=>x>0))||10;
  const first=items.filter(i=>i.evidence[0].pageIndex===0),title=first.find(i=>i.kind==='heading'&&size(i)>bodySize*1.4);
  const abstract=first.find(i=>/^\s*(?:Abstract|ABSTRACT)(?:\b|(?=[A-Z]))/u.test(i.text));
  const abstractTop=abstract?.evidence[0].bbox[1]??Infinity;
  function frontMatterRole(i,b,text,e,role){
    if(i.evidence[0].pageIndex===0&&title&&b[1]>=title.evidence[0].bbox[3]&&b[1]<abstractTop){
      if(/(?:department|university|institute|laboratory|school of|college of)/iu.test(text))role='affiliation';
      else if(/^(?:E-mail|Received|Accepted|Published|doi\b)/iu.test(text))role='metadata';
      else if(size(i)>=bodySize&&e.inlineRuns?.some(r=>r.bold))role='authors';
    }
    return role;
  }
  function assignRole(i){
    const e=i.extensions,b=i.evidence[0].bbox,p=model.pages[i.evidence[0].pageIndex],text=i.text;
    let role=i.kind==='heading'?'section-heading':'body';
    if(i===title)role='title';
    else if(i===abstract){role='abstract';const m=text.match(/^\s*Abstract\s*/iu);e.roleLabel={start:0,end:m[0].length,text:m[0]};}
    else if(/^\s*Keywords\s*:/iu.test(text))role='keywords';
    else if(b[1]>p.height*.82&&size(i)<bodySize*.9&&/^\s*(?:[∗*†‡]|\d+)\s*\p{L}/u.test(text))role='footnote';
    else if(text.length<180&&/^(?:\d+(?:\.\d+)*\.?\s+\p{Lu}|References\b|Acknowledg|Appendix\b)/u.test(text)&&e.inlineRuns?.some(r=>r.bold)&&b[3]-b[1]<bodySize*4)role='section-heading';
    else if(e.inlineRuns?.some(r=>r.bold)&&text.length<180&&/^(?:Introduction|Methods|Results|Discussion|Conclusion|References)\b/iu.test(text))role='section-heading';
    else role=frontMatterRole(i,b,text,e,role);
    e.publicationRole=role;
  }
  for(const i of items)assignRole(i);
  return model;
}

/* Comparison-only marks. PDF bytes, export plans and BLUE requests never receive these DOM nodes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyChangeMarks=api;})(globalThis,function(){
  'use strict';
  function difference(before,after){
    before=String(before||'');after=String(after||'');
    let start=0,a=before.length,b=after.length;
    while(start<a&&start<b&&before[start]===after[start])start++;
    // Never split a UTF-16 surrogate pair at a shared edge.
    if(start>0&&/[\uD800-\uDBFF]/.test(before[start-1]))start--;
    while(a>start&&b>start&&before[a-1]===after[b-1]){a--;b--;}
    if(a<before.length&&a>start&&/[\uDC00-\uDFFF]/.test(before[a])){a++;b++;}
    return {before:{start,end:a},after:{start,end:b},changed:before!==after};
  }
  // Only extraction whitespace, soft hyphens and line-end hyphenation are normalized.
  // Offsets always point back into the real text items; no text or layout is rewritten.
  function mapped(text){
    let value='';const starts=[],ends=[];
    for(let i=0;i<text.length;){
      const from=i;
      if(text[i]==='\u00ad'){i++;continue;}
      if(text[i]==='-'&&/^-[ \t]*\r?\n\s*(?=\p{L})/u.test(text.slice(i))){i+=text.slice(i).match(/^-[ \t]*\r?\n\s*/)[0].length;continue;}
      if(/\s/u.test(text[i])){while(i<text.length&&/\s/u.test(text[i]))i++;value+=' ';starts.push(from);ends.push(i);}
      else{value+=text[i];starts.push(i);ends.push(++i);}
    }
    return {value,starts,ends};
  }
  function indexItems(items,separator){let text='';const spans=[];
    (items||[]).forEach((item,i)=>{if(typeof item?.str!=='string')return;const start=text.length;text+=item.str;if(item.str)spans.push({i,start,end:text.length});text+=item.hasEOL?'\n':(typeof separator==='function'?separator(item,(items||[])[i+1],i):' ');});
    return {text,spans};
  }
  function changeBounds(delta,side,wanted,hay,at){
      const change=delta[side],positions=[];
      for(let i=0;i<wanted.length;i++)if(i>=change.start&&i<change.end)positions.push(i);
      let start,end,caret=false;
      if(positions.length){start=hay.starts[at+positions[0]];end=hay.ends[at+positions.at(-1)];}
      else{
        // A deletion has no new glyph. Mark its insertion point in the surviving sentence.
        const offset=Math.max(0,Math.min(wanted.length,change.start));
        start=offset<wanted.length?hay.starts[at+offset]:hay.ends[at+wanted.length-1];end=start;caret=true;
      }
      return {start,end,caret};
  }
  // Bind a candidate only when its complete source segment maps uniquely to the page.
  function validLocation(location,quote){
    if(!location||typeof location.text!=='string'||!Number.isSafeInteger(location.start)||!Number.isSafeInteger(location.end))return false;
    const {text,start,end}=location;return start>=0&&end>start&&end<=text.length&&text.slice(start,end)===quote;
  }
  function anchoredOffset(location,quote,wanted,hay){
    if(!validLocation(location,quote))return -1;
    const {text,start}=location;
    const source=mapped(text),base=hay.value.indexOf(source.value);
    if(!source.value||base<0||hay.value.indexOf(source.value,base+1)>=0)return -1;
    const normalized=mapped(quote),lead=normalized.value.indexOf(wanted);
    const firstStart=start+normalized.starts[lead],lastEnd=start+normalized.ends[lead+wanted.length-1];
    const first=source.starts.findIndex(offset=>offset===firstStart),last=source.ends.findIndex(offset=>offset===lastEnd);
    if(first<0||last<first)return -1;
    if(source.value.slice(first,last+1)!==wanted)return -1;
    return base+first;
  }
  function collectRanges(edit,side,index,hay,found,missing){
      if(edit.enabled===false)return;
      const delta=difference(mapped(String(edit.before||'')).value.trim(),mapped(String(edit.after||'')).value.trim());if(!delta.changed)return;
      const quote=String(edit[side]||''),needle=mapped(quote),wanted=needle.value.trim();
      if(!wanted){missing.push(edit.id);return;}
      const anchored=side==='before'&&edit.location;
      const at=anchored?anchoredOffset(edit.location,quote,wanted,hay):hay.value.indexOf(wanted);
      // Repeated phrases require a uniquely mapped source segment and exact range.
      if(at<0||(!anchored&&hay.value.indexOf(wanted,at+1)>=0)){missing.push(edit.id);return;}
      const {start,end,caret}=changeBounds(delta,side,wanted,hay,at);
      let pieces=index.spans.filter(s=>caret?s.start<=start&&s.end>=start:s.end>start&&s.start<end);
      if(caret)pieces=pieces.slice(-1);
      if(!pieces.length){missing.push(edit.id);return;}
      for(const span of pieces)found.push({id:edit.id,itemIndex:span.i,start:Math.max(0,start-span.start),end:Math.min(span.end-span.start,end-span.start),caret,side});
  }
  function ranges(items,edits,side,separator){
    const index=indexItems(items,separator),hay=mapped(index.text),found=[],missing=[];
    for(const edit of edits||[]) collectRanges(edit,side,index,hay,found,missing);
    return {found,missing};
  }
  function paintText(node,before,after,side){
    const text=String(side==='before'?before:after),range=difference(before,after)[side],d=node.ownerDocument||globalThis.document;
    node.replaceChildren();
    for(const [value,mark] of [[text.slice(0,range.start),false],[text.slice(range.start,range.end),true],[text.slice(range.end),false]]){
      if(!value)continue;const el=d.createElement(mark?'mark':'span');el.textContent=value;if(mark)el.className='paper-change-text is-'+side;node.append(el);
    }
  }
  function paintHit(d,divs,hit,side,pageBox,layer){
    let count=0;
      const span=divs?.[hit.itemIndex],text=span?.firstChild;
      if(!text||text.nodeType!==3||!d.createRange)return 0;
      const range=d.createRange(),length=text.textContent.length;
      let from=Math.max(0,Math.min(length,hit.start)),to=Math.max(from,Math.min(length,hit.end)),endCaret=false;
      if(hit.caret){endCaret=from===length;from=endCaret?Math.max(0,from-1):from;to=Math.min(length,from+1);}
      if(from===to)return 0;range.setStart(text,from);range.setEnd(text,to);
      for(const rect of range.getClientRects()){
        if(!(rect.height>0&&rect.width>0))continue;
        const el=d.createElement('span');el.className='paper-change-mark is-'+side+(hit.caret?' is-caret':'');el.dataset.edit=String(hit.id||'');
        el.style.left=((hit.caret&&endCaret?rect.right:rect.left)-pageBox.left)+'px';el.style.top=(rect.top-pageBox.top)+'px';
        el.style.width=(hit.caret?3:rect.width)+'px';el.style.height=rect.height+'px';layer.append(el);count++;
      }
    return count;
  }
  function paintPage({document:d,container,items,divs,edits,side,separator}){
    for(let i=0;i<(divs?.length||0);i++)if(divs[i].dataset)divs[i].dataset.i=String(i);
    const result=ranges(items,edits,side,separator),layer=d.createElement('div');layer.className='paper-change-layer';layer.setAttribute('aria-hidden','true');
    container.append(layer);const pageBox=container.getBoundingClientRect();let count=0;
    for(const hit of result.found) count+=paintHit(d,divs,hit,side,pageBox,layer);
    return {...result,layer,count};
  }
  return {difference,mapped,ranges,paintText,paintPage};
});

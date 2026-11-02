// Align normalized display text, then accept only independently proven source spans.
function narrowMixed(project, model, item, base) {
  const normalize = value => value.replace(/\s+/g,' ');
  const before=normalize(item.before), after=normalize(item.after);
  if (!before || before===after) return null;
  const matches=[];
  for (const doc of model.documents || []) {
    if ((item.path && item.path!==doc.path) || typeof doc.displayText!=='string' || !Array.isArray(doc.displayMap)) continue;
    let text='', map=[];
    for (let i=0;i<doc.displayText.length;) {
      let j=i+1;
      if (/\s/.test(doc.displayText[i])) { while (j<doc.displayText.length && /\s/.test(doc.displayText[j])) j++; text+=' '; }
      else text+=doc.displayText[i];
      map.push({start:i,end:j}); i=j;
    }
    let at=-1;
    while ((at=text.indexOf(before,at+1))!==-1) matches.push({doc,at,map});
  }
  if (!matches.length) return null;
  const unresolved=status=>({...base,enabled:false,status});
  if (matches.length!==1) return unresolved('ambiguous');
  const {doc,at,map}=matches[0], file=project.files?.find(f=>f.path===doc.path);
  if (!file) return unresolved('unresolved');
  let source; try {source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);} catch {return unresolved('unresolved');}
  const selected=map.slice(at,at+before.length).map(m=>doc.displayMap.slice(m.start,m.end));
  // Do not infer the display of hidden macros, math or footnotes between mapped nodes.
  for (let i=1;i<selected.length;i++) {
    const a=selected[i-1].at(-1), b=selected[i][0];
    if (!a || !b || a.end>b.start) return unresolved('unresolved');
    if (a.nodeId!==b.nodeId) {
      const gap=source.slice(a.end,b.start).replace(/%[^\r\n]*/g,'').replace(/\\(?:textsuperscript|textsubscript|cite|citep|citet)\b/g,'').replace(/[{}\s]/g,'');
      if (gap) return unresolved('unresolved');
    }
  }
  // Code points avoid splitting UTF-16 surrogate pairs, while offsets remain UTF-16.
  const chars=s=>{let offset=0;return Array.from(s,c=>{const x={c,start:offset,end:offset+c.length};offset+=c.length;return x;});};
  const a=chars(before), b=chars(after), n=a.length, m=b.length;
  if ((n+1)*(m+1)>1000000) return unresolved('unresolved');
  const width=m+1, dp=new Uint32Array((n+1)*width);
  for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--) dp[i*width+j]=a[i].c===b[j].c ? 1+dp[(i+1)*width+j+1] : Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
  let i=0,j=0,active=null, spans=[];
  const flush=()=>{if(active){spans.push(active);active=null;}};
  while(i<n || j<m) {
    if(i<n && j<m && a[i].c===b[j].c){flush();i++;j++;continue;}
    active??={from:i,to:i,replacement:''};
    if(j<m && (i===n || dp[i*width+j+1]>dp[(i+1)*width+j])) {active.replacement+=b[j++].c;}
    else {i++;active.to=i;}
  }
  flush();
  // Patcher permits insertion only at a node boundary. Include an adjacent
  // unchanged character for interior insertions, provided the node is proven.
  for(const span of spans) if(span.from===span.to) {
    if(span.from>0 && (!spans.some(x=>x!==span && x.to===span.from))) {span.from--;span.replacement=a[span.from].c+span.replacement;}
    else if(span.to<n && !spans.some(x=>x!==span && x.from===span.to)) {span.replacement+=a[span.to].c;span.to++;}
    else return unresolved('unresolved');
  }
  const changes=[];
  for(const span of spans) {
    const startIndex=a[span.from].start, endIndex=a[span.to-1].end;
    const entries=selected.slice(startIndex,endIndex).flat();
    if(!entries.length || entries.some(x=>!x || x.nodeId!==entries[0].nodeId)) return unresolved('unresolved');
    for(let k=1;k<entries.length;k++) if(entries[k-1].end!==entries[k].start) return unresolved('unresolved');
    const node=(model.nodes || []).find(x=>x.id===entries[0].nodeId && x.path===doc.path);
    const start=entries[0].start,end=entries.at(-1).end;
    if(!node || !['text','superscript','subscript'].includes(node.kind) || start<node.contentStart || end>node.contentEnd) return unresolved('unresolved');
    const raw=source.slice(start,end);
    if(normalize(raw)!==before.slice(startIndex,endIndex) || /[\\{}]/.test(raw)) return unresolved('unresolved');
    const anchor={projectId:project.id,nodeId:node.id,path:doc.path,start,end,kind:node.kind};
    changes.push({...base,before:raw,after:span.replacement,anchor,kind:node.kind});
  }
  if(!changes.length || changes.some((c,i)=>changes.slice(i+1).some(d=>c.anchor.start<d.anchor.end && d.anchor.start<c.anchor.end))) return unresolved('unresolved');
  return {...base,status:'matched',anchor:changes[0].anchor,sourceChanges:changes};
}

/** Resolve imported/manual proposals against an injected source model. */
export function resolveSourceProposals(project, response, {model} = {}) {
  const diagnostics = [];
  if (!model || model.projectId !== project?.id) return {proposals: [], diagnostics: [{code:'stale-model', message:'The source model is stale; analyze this project again.'}]};
  let batch = response;
  if (typeof response === 'string') {
    const parser = model.parseResponse || globalThis.FalsifyExternalExchange?.parse;
    if (!parser) return {proposals: [], diagnostics: [{code:'parser-unavailable', message:'Load the external response parser before importing a response.'}]};
    const segments = model.documents?.length ? model.documents.map(d=>({id:d.path,text:d.displayText})) : (model.nodes || []).map(n => ({id:n.id, text:n.displayText ?? n.text ?? ''}));
    batch = parser(response, {role:'red', fileHash:project.id, segments});
  }
  const entries = Array.isArray(batch) ? batch : batch?.changes || batch?.items || batch?.proposals || [];
  diagnostics.push(...(batch?.diagnostics || []));
  const identityMismatch = diagnostics.some(d => d.code === 'file-hash-mismatch');
  const proposals = (Array.isArray(entries) ? entries : []).filter(item=>item && typeof item==='object' && !Array.isArray(item)).map((item, i) => {
    const provenance = item.provenance || {origin: typeof response === 'string' || batch?.schema === 'falsify.external-batch.v1' ? 'external-ai' : 'human', ...(batch?.id ? {responseId:batch.id} : {})};
    const base = {id:item.id || `source-change-${i+1}`, before:item.before, after:item.after, kind:item.kind && item.kind !== 'change' ? item.kind : 'text', mode:item.mode || 'content', enabled:item.enabled !== false, provenance};
    if (typeof item.before !== 'string' || typeof item.after !== 'string') return {...base, enabled:false, status:'invalid'};
    if (identityMismatch) return {...base, enabled:false, status:'identity-mismatch'};
    if (item.anchor && !(batch?.schema === 'falsify.external-batch.v1' && !item.anchor.projectId && !item.anchor.nodeId)) {
      const node = (model.nodes || []).find(n => n.id === item.anchor.nodeId);
      if (item.anchor.projectId !== project.id || !node || node.path !== item.anchor.path || item.anchor.start < node.start || item.anchor.end > node.end || item.anchor.start > item.anchor.end || node.kind !== item.anchor.kind) return {...base, enabled:false, status:'stale-anchor'};
      return {...base, kind:node.kind, anchor:item.anchor, status:'matched'};
    }
    const mixed=narrowMixed(project,model,item,base); if (mixed) return mixed;
    const locate = model.locateSourceText || model.locate;
    if (typeof locate !== 'function') return {...base, enabled:false, status:'unresolved'};
    const result = locate(project, {before:item.before, ...(item.path ? {path:item.path} : {}), ...(item.nodeId ? {nodeId:item.nodeId} : {})});
    if (result.status !== 'matched' || result.candidates?.length !== 1) return {...base, enabled:false, status:result.status || 'missing'};
    const candidate = result.candidates[0];
    // Reduce a mixed displayed sentence to one independently located source node.
    let left=0, right=0;
    while (left < item.before.length && left < item.after.length && item.before[left] === item.after[left]) left++;
    while (right < item.before.length-left && right < item.after.length-left && item.before[item.before.length-1-right] === item.after[item.after.length-1-right]) right++;
    const changedBefore=item.before.slice(left,item.before.length-right), changedAfter=item.after.slice(left,item.after.length-right);
    if (changedBefore && (left || right)) {
      const narrowed=locate(project,{before:changedBefore,path:candidate.anchor.path});
      const c=narrowed.status==='matched' && narrowed.candidates?.length===1 ? narrowed.candidates[0] : null;
      if (c && c.before === changedBefore && c.anchor.start>=candidate.anchor.start && c.anchor.end<=candidate.anchor.end) {
        const change={...base,before:c.before ?? changedBefore,after:changedAfter,kind:c.anchor.kind,anchor:c.anchor};
        return {...base,anchor:candidate.anchor,status:'matched',sourceChanges:[change]};
      }
    }
    const node=(model.nodes || []).find(n=>n.id===candidate.anchor.nodeId);
    if (node && node.kind === 'text' && /\\[A-Za-z@]+/.test(node.sourceText || '')) return {...base,enabled:false,status:'unsupported-mixed-source'};
    return {...base, before:candidate.before ?? item.before, kind:candidate.anchor.kind, anchor:candidate.anchor, status:'matched'};
  });
  return {proposals, diagnostics};
}

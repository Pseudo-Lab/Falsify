// Compare spatial content with word-preserving whitespace normalization. A
// physical line break may replace a source word space during reflow; this
// proves the word boundary, not byte identity of encoded whitespace. Paint
// visibility and human reading order remain separate checks.
const isSpace = u => /\s/u.test(String.fromCharCode(u));
const valid = n => Number.isFinite(n);
const size = g => g.style?.size * Math.hypot(g.style?.mat?.[2] ?? 0, g.style?.mat?.[3] ?? 1);
const fail = (reason, index, extra = {}) => ({ok:false, reason, ...(index === undefined ? {} : {index}), ...extra});

export function canonicalPage(page, partition = page?.W / 2) {
  if (!page || !Array.isArray(page.chars) || !Array.isArray(page.glyphs) || !valid(page.W) || !valid(page.H) || !valid(partition)) return fail('page_geometry_unavailable');
  const frame = page.frame;
  if (!frame || frame.rotation !== 0 || !Array.isArray(frame.transform) || frame.transform.length !== 6 || frame.transform.some(x => !valid(x)) || Math.abs(frame.transform[1]) > 1e-6 || Math.abs(frame.transform[2]) > 1e-6 || frame.transform[0] <= 0 || frame.transform[3] <= 0) return fail('unsupported_frame');
  const glyphs = new Map();
  for (const g of page.glyphs) {
    if (!Number.isInteger(g.i) || g.i < 0 || g.i >= page.chars.length || glyphs.has(g.i) || g.u !== page.chars[g.i].u || ![g.l,g.r,g.b,g.t,g.origin?.[0],g.origin?.[1]].every(valid) || g.r < g.l || g.t < g.b || !valid(size(g)) || size(g) <= 0) return fail('glyph_geometry_unavailable',g.i);
    glyphs.set(g.i,g);
  }
  const lines = [];
  for (const g of [...glyphs.values()].sort((a,b)=>b.origin[1]-a.origin[1] || a.l-b.l || a.i-b.i)) {
    const channel = g.l < partition ? 0 : 1;
    const candidates = lines.filter(l=>l.channel===channel && Math.abs(l.y-g.origin[1])<=.5 && Math.abs(l.size-size(g))<=.2);
    if (candidates.length > 1) return fail('ambiguous_baseline',g.i);
    let line=candidates[0];
    if (!line) lines.push(line={channel,y:g.origin[1],size:size(g),items:[]});
    line.items.push({i:g.i,u:g.u,x:g.l,r:g.r,generated:false});
  }
  // Attach a raised, smaller marker only when exactly one lower body line has
  // an adjacent preceding glyph. This uses source geometry, never marker text.
  for (const line of [...lines]) {
    const first=[...line.items].sort((a,b)=>a.x-b.x)[0];
    const candidates=lines.filter(l=>l!==line && l.channel===line.channel && l.size>=line.size*1.2 && l.size<=line.size*3 && l.y<line.y && line.y-l.y<=l.size*.8 && l.items.some(g=>g.r<=first.x+1 && first.x-g.r<=l.size*1.3));
    if (candidates.length>1) return fail('ambiguous_marker',first.i);
    if (candidates.length===1) {candidates[0].items.push(...line.items); lines.splice(lines.indexOf(line),1);}
  }
  lines.sort((a,b)=>a.channel-b.channel || b.y-a.y);
  for (const line of lines) line.items.sort((a,b)=>a.x-b.x || a.i-b.i);
  const ignored=[], boundaryWhitespace=[], normalizedDiscretionary=[];
  const itemLine = new Map(lines.flatMap((line, n)=>line.items.map(item=>[item.i,n])));
  const adjacentBreak = i => {
    let a=i-1, b=i+1;
    while (a>=0 && !glyphs.has(a) && isSpace(page.chars[a].u)) a--;
    while (b<page.chars.length && !glyphs.has(b) && isSpace(page.chars[b].u)) b++;
    const left=glyphs.get(a), right=glyphs.get(b), li=itemLine.get(a), ri=itemLine.get(b);
    if (!left || !right || lines[li].channel!==lines[ri].channel || ri!==li+1) return null;
    const last=[...lines[li].items].sort((x,y)=>x.x-y.x).at(-1), first=[...lines[ri].items].sort((x,y)=>x.x-y.x)[0];
    if (last?.i!==a || first?.i!==b) return null;
    return {a,b,li,ri};
  };
  const joins=new Set(), literalBoundaries=new Set();
  for (let i=0;i<page.chars.length;i++) {
    const c=page.chars[i];
    if (glyphs.has(i)) continue;
    if (!Number.isInteger(c.u)) return fail('invalid_character',i);
    if (c.u===2 && c.discretionary===true) {
      const [x,y]=c.origin ?? [];
      const candidates=lines.map((line,li)=>({line,li})).filter(({line,li})=>
        valid(x) && valid(y) && line.channel===(x<partition?0:1) && Math.abs(line.y-y)<=.5 &&
        li+1<lines.length && lines[li+1].channel===line.channel &&
        line.y-lines[li+1].y>0 && line.y-lines[li+1].y<=line.size*2 &&
        Math.abs(line.size-lines[li+1].size)<=.5);
      if (candidates.length!==1) return fail('discretionary_break_unproven',i);
      const {line,li}=candidates[0];
      const last=[...line.items].sort((a,b)=>a.x-b.x).at(-1);
      const first=[...lines[li+1].items].sort((a,b)=>a.x-b.x)[0];
      let before=i-1, after=i+1;
      while (before>=0 && isSpace(page.chars[before].u)) before--;
      while (after<page.chars.length && isSpace(page.chars[after].u)) after++;
      if (!last || !first || x<last.x || x-last.r>line.size ||
          last.i!==before || first.i!==after ||
          !/\p{L}/u.test(String.fromCharCode(last.u)) || !/\p{L}/u.test(String.fromCharCode(first.u))) return fail('discretionary_break_unproven',i);
      joins.add(li); normalizedDiscretionary.push(i); continue;
    }
    if (!isSpace(c.u)) return fail('nonspace_geometry_unavailable',i);
    if (c.generated===true) {ignored.push(i); continue;}
    const [l,r,b,t]=c.box ?? [];
    const [x,y]=c.origin ?? [];
    if (/[\r\n]/u.test(String.fromCharCode(c.u)) || ![l,r,b,t,x,y].every(valid)) {
      const br=adjacentBreak(i);
      if (!br || !/[\r\n]/u.test(String.fromCharCode(c.u))) return fail('literal_whitespace_geometry_unavailable',i);
      boundaryWhitespace.push(i); literalBoundaries.add(br.li); continue;
    }
    const channel=x<partition?0:1;
    const candidates=lines.filter(line=>line.channel===channel && Math.abs(line.y-y)<=.5);
    if (candidates.length!==1) return fail('literal_whitespace_line_ambiguous',i,{candidates:candidates.length});
    candidates[0].items.push({i,u:c.u,x:l,r,generated:false});
  }
  const chars=[];
  for (let n=0;n<lines.length;n++) {
    const line=lines[n];
    line.items.sort((a,b)=>a.x-b.x || a.i-b.i);
    for (let k=1;k<line.items.length;k++) if (Math.abs(line.items[k].x-line.items[k-1].x)<1e-6 && line.items[k].u!==line.items[k-1].u) return fail('ambiguous_horizontal_order',line.items[k].i);
    if (n && (!joins.has(n-1) || literalBoundaries.has(n-1))) chars.push({u:32,generated:!literalBoundaries.has(n-1),virtual:true});
    chars.push(...line.items);
  }
  const mapped=chars.filter(c=>!c.virtual).map(c=>c.i);
  const indices=mapped.concat(ignored,boundaryWhitespace,normalizedDiscretionary);
  if (indices.length!==page.chars.length || new Set(indices).size!==page.chars.length) return fail('index_coverage_incomplete');
  return {ok:true,chars,text:chars.map(c=>String.fromCharCode(c.u)).join(''),partition,evidence:{total:page.chars.length,mapped,generatedWhitespace:ignored,boundaryWhitespace,normalizedDiscretionary}};
}

export function compareSourceGeometry(source, output, edits, {expectedPageText, matchesGeneratedWhitespace} = {}) {
  if (typeof expectedPageText !== 'function') return fail('expected_page_text_unavailable');
  if (source?.W!==output?.W || source?.H!==output?.H || JSON.stringify(source?.frame)!==JSON.stringify(output?.frame)) return fail('frame_mismatch');
  const s=canonicalPage(source), o=canonicalPage(output,s.partition);
  if (!s.ok) return {...s,side:'source'};
  if (!o.ok) return {...o,side:'output'};
  const expected=expectedPageText(s.text,edits,{includeSpans:true});
  if (!expected.ok) return {...expected,side:'source'};
  // Virtual physical line separators are optional on the output side when
  // the caller supplies the existing generated-whitespace matcher.
  const actual=o.text.replace(/\s+/gu,' ').trim();
  const match=typeof matchesGeneratedWhitespace==='function' ? matchesGeneratedWhitespace(expected.text,o.chars) : actual===expected.text;
  return {ok:true,match,expected:expected.text,actual,spans:expected.spans,sourceEvidence:s.evidence,outputEvidence:o.evidence};
}

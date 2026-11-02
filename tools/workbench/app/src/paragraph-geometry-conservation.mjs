// Compare spatial content with word-preserving whitespace normalization. A
// physical line break may replace a source word space during reflow; this
// proves the word boundary, not byte identity of encoded whitespace. Paint
// visibility and human reading order remain separate checks.
const isSpace = u => /\s/u.test(String.fromCharCode(u));
const valid = n => Number.isFinite(n);
const size = g => g.style?.size * Math.hypot(g.style?.mat?.[2] ?? 0, g.style?.mat?.[3] ?? 1);
const fail = (reason, index, extra = {}) => ({ok:false, reason, ...(index === undefined ? {} : {index}), ...extra});

// PDFium glyph boxes and origins are in unrotated PDF user space. The page
// transform maps that space into the displayed page; invert its four corners
// to locate the same two-column partition in user space for each quarter turn.
function userPartition(page) {
  const f = page?.frame, t = f?.transform;
  const matrices = [[1,0,0,1], [0,-1,1,0], [-1,0,0,-1], [0,1,-1,0]];
  if (!Number.isInteger(f?.rotation) || !matrices[f.rotation] || !Array.isArray(t) || t.length !== 6 || t.some(x => !valid(x))) return null;
  const upright = f.rotation === 0 && Math.abs(t[1]) <= 1e-6 && Math.abs(t[2]) <= 1e-6 && t[0] > 0 && t[3] > 0;
  if (!upright && matrices[f.rotation].some((x,i) => Math.abs(x-t[i]) > 1e-6)) return null;
  const [a,b,c,d,e,f0] = t, det = a*d-b*c;
  if (!valid(det) || det === 0) return null;
  const inverse = [d/det, -b/det, -c/det, a/det];
  if (!inverse.every(valid) || !valid(-inverse[0]*e-inverse[2]*f0) || !valid(-inverse[1]*e-inverse[3]*f0)) return null;
  const xs = [[0,0],[page.W,0],[0,page.H],[page.W,page.H]].map(([x,y]) => inverse[0]*(x-e)+inverse[2]*(y-f0));
  if (!xs.every(valid)) return null;
  const partition = Math.min(...xs)/2+Math.max(...xs)/2;
  return valid(partition) ? partition : null;
}

export function canonicalPage(page, partition = userPartition(page)) {
  if (!page || !Array.isArray(page.chars) || !Array.isArray(page.glyphs) || !valid(page.W) || !valid(page.H)) return fail('page_geometry_unavailable');
  if (userPartition(page) === null || !valid(partition)) return fail('unsupported_frame');
  const glyphs = new Map();
  for (const g of page.glyphs) {
    if (!Number.isInteger(g.i) || g.i < 0 || g.i >= page.chars.length || glyphs.has(g.i) || g.u !== page.chars[g.i].u || ![g.l,g.r,g.b,g.t,g.origin?.[0],g.origin?.[1]].every(valid) || g.r < g.l || g.t < g.b || !valid(size(g)) || size(g) <= 0) return fail('glyph_geometry_unavailable',g.i);
    glyphs.set(g.i,g);
  }
  const lines = [];
  const ordered = [...glyphs.values()].sort((a,b)=>b.origin[1]-a.origin[1] || a.l-b.l || a.i-b.i);
  // A physical line can cross the midpoint. Keep adjacent glyphs on one
  // baseline in the channel of its start; a large gap still separates columns.
  const channels = new Map(), baselines = new Map();
  for (const [order,g] of ordered.entries()) {
    const bucket = Math.floor(g.origin[1] / .5), candidates = new Set([bucket-1,bucket,bucket+1]);
    let prior = null;
    // Lists are sorted by right edge; ties retain original processing order.
    // Only neighbouring baseline buckets can satisfy the original tolerance.
    for (const key of candidates) {
      const list = baselines.get(key) ?? [];
      for (let j=list.length-1;j>=0;j--) {
        const h=list[j];
        if (prior && h.g.r < prior.g.r) break;
        if (h.g.l <= g.l && Math.abs(h.g.origin[1]-g.origin[1]) <= .5 &&
            Math.abs(size(h.g)-size(g)) <= .2 && g.l-h.g.r <= size(g)*2 &&
            !(h.g.r < partition && g.l >= partition && g.l-h.g.r > size(g)) &&
            (!prior || h.g.r > prior.g.r || (h.g.r === prior.g.r && h.order < prior.order))) prior=h;
      }
    }
    channels.set(g.i, prior ? channels.get(prior.g.i) : (g.l < partition ? 0 : 1));
    let list=baselines.get(bucket);
    if (!list) baselines.set(bucket,list=[]);
    let lo=0, hi=list.length;
    while (lo<hi) {
      const mid=(lo+hi)>>1, h=list[mid];
      if (h.g.r < g.r || (h.g.r === g.r && h.order > order)) lo=mid+1; else hi=mid;
    }
    list.splice(lo,0,{g,order});
  }
  for (const g of ordered) {
    const channel = channels.get(g.i);
    const candidates = lines.filter(l=>l.channel===channel && Math.abs(l.y-g.origin[1])<=.5 && Math.abs(l.size-size(g))<=.2);
    if (candidates.length > 1) return fail('ambiguous_baseline',g.i);
    let line=candidates[0];
    if (!line) lines.push(line={channel,y:g.origin[1],size:size(g),items:[],aliases:[]});
    line.items.push({i:g.i,u:g.u,x:g.l,r:g.r,generated:false});
  }
  // Saved PDF objects can append a script before or after the body in raw
  // extraction order. Bind it to one adjacent physical baseline, rather than
  // requiring the preceding raw character to belong to that baseline.
  for (const line of [...lines]) {
    const first=[...line.items].sort((a,b)=>a.x-b.x)[0];
    const candidates=lines.filter(l=>l!==line && l.channel===line.channel && l.size>=line.size*1.2 && l.size<=line.size*3 && l.y<line.y && line.y-l.y<=l.size*.8 && l.items.some(g=>g.r<=first.x+1 && first.x-g.r<=l.size*1.3));
    if (candidates.length>1) return fail('ambiguous_marker',first.i);
    if (candidates.length===1) {
      const owner=candidates[0];
      owner.items.push(...line.items);
      owner.aliases.push({channel:line.channel,y:line.y,size:line.size,items:[...line.items]},...line.aliases);
      lines.splice(lines.indexOf(line),1);
    }
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
    if (c.generated===true) {
      // PDF writers may encode a source line break as positioning between
      // text objects. Keep PDFium's resulting word space only when its raw
      // neighbours and geometry prove one physical line and a positive gap.
      const left=glyphs.get(i-1), right=glyphs.get(i+1);
      const li=itemLine.get(i-1), ri=itemLine.get(i+1);
      const [x,y]=c.origin ?? [];
      const line=lines[li];
      if (c.u===32 && left && right && li===ri && line && valid(x) && valid(y) &&
          right.l-left.r>0.01 && x>=left.r-.5 && x<=right.l+.5 &&
          [line,...line.aliases].some(b=>Math.abs(b.y-y)<=.5)) {
        line.items.push({i,u:32,x,r:x,generated:true});
      } else {
        // PDFium can emit the generated separator between two objects in
        // stream order even when those objects extract in reverse visual order.
        // Prove a single adjacent physical boundary between those same objects.
        const a = glyphs.get(i-1), b = glyphs.get(i+1);
        const line = lines[itemLine.get(i-1)];
        let inserted = false;
        if (c.u === 32 && a?.obj && b?.obj && a.obj !== b.obj && line && itemLine.get(i-1) === itemLine.get(i+1)) {
          const items = [...line.items].sort((p,q)=>p.x-q.x);
          const boundaries = [];
          for (let k=1;k<items.length;k++) {
            const l=glyphs.get(items[k-1].i), r=glyphs.get(items[k].i);
            if (l && r && ((l.obj===a.obj && r.obj===b.obj) || (l.obj===b.obj && r.obj===a.obj)) && r.l-l.r>0.01 && r.l-l.r<=line.size) boundaries.push([l,r]);
          }
          if (boundaries.length===1) {
            const [l,r]=boundaries[0], x=(l.r+r.l)/2;
            line.items.push({i,u:32,x,r:x,generated:true}); inserted=true;
          }
        }
        if (!inserted) ignored.push(i);
      }
      continue;
    }
    const [l,r,b,t]=c.box ?? [];
    const [x,y]=c.origin ?? [];
    if (/[\r\n]/u.test(String.fromCharCode(c.u)) || ![l,r,b,t,x,y].every(valid)) {
      const br=adjacentBreak(i);
      if (!br || !/[\r\n]/u.test(String.fromCharCode(c.u))) return fail('literal_whitespace_geometry_unavailable',i);
      boundaryWhitespace.push(i); literalBoundaries.add(br.li); continue;
    }
    const neighbours = [glyphs.get(i-1), glyphs.get(i+1)].filter(Boolean);
    const channel = neighbours.length ? channels.get(neighbours[0].i) : (x<partition?0:1);
    // An attached script keeps its original baseline. Only its immediate raw
    // glyph neighbour can establish ownership of whitespace on that baseline.
    let before=i-1, after=i+1;
    while (before>=0 && isSpace(page.chars[before].u)) before--;
    while (after<page.chars.length && isSpace(page.chars[after].u)) after++;
    const baselines=lines.flatMap(line=>[line,...line.aliases]).filter(baseline=>
      baseline.channel===channel && Math.abs(baseline.y-y)<=.5);
    if (baselines.length>1) return fail('literal_whitespace_line_ambiguous',i,{candidates:baselines.length});
    const candidates=[];
    for (const line of lines) {
      if (line.channel===channel && Math.abs(line.y-y)<=.5) candidates.push(line);
      for (const alias of line.aliases) {
        if (alias.channel!==channel || Math.abs(alias.y-y)>.5) continue;
        if (alias.items.some(item=>
          (item.i===before && l>=item.x && l-item.r<=alias.size) ||
          (item.i===after && r<=item.r && item.x-r<=alias.size))) candidates.push(line);
      }
    }
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

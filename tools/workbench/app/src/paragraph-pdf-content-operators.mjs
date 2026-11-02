// Byte offsets are half-open and refer to the original Latin-1 content stream.
const ws = c => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const delim = c => ws(c) || c === undefined || '()<>[]{}/%'.includes(String.fromCharCode(c));
const identity = () => [1, 0, 0, 1, 0, 0];
// PDF matrices: compose a local transform before its parent transform.
const mul = (a, b) => [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]];
const translate = (m, x, y) => mul([1,0,0,1,x,y], m);

function lexer(data, diagnostics) {
  let i = 0;
  const fail = (message, start) => { diagnostics.push({message, offset:start}); i = data.length; return null; };
  const skip = () => { while (i < data.length) { if (ws(data[i])) i++; else if (data[i] === 37) { while (i < data.length && data[i] !== 10 && data[i] !== 13) i++; } else break; } };
  function next() {
    skip(); if (i >= data.length) return null;
    const start = i, c = data[i++];
    if (c === 40) {
      let depth = 1, out = [];
      while (i < data.length && depth) {
        let x = data[i++];
        if (x === 92) {
          if (i >= data.length) return fail('Unterminated literal string', start);
          x = data[i++];
          if (x === 13 || x === 10) { if (x === 13 && data[i] === 10) i++; continue; }
          if (x >= 48 && x <= 55) { let n = x - 48, count = 1; while (count < 3 && data[i] >= 48 && data[i] <= 55) { n = n*8+data[i++]-48; count++; } out.push(n & 255); continue; }
          out.push(({110:10,114:13,116:9,98:8,102:12})[x] ?? x); continue;
        }
        if (x === 40) depth++; else if (x === 41 && --depth === 0) break;
        if (x === 13) { if (data[i] === 10) i++; x = 10; }
        out.push(x);
      }
      if (depth) return fail('Unterminated literal string', start);
      return {type:'string', bytes:Uint8Array.from(out), start, end:i};
    }
    if (c === 60 && data[i] !== 60) {
      let hex = '';
      while (i < data.length && data[i] !== 62) { const x = data[i++]; if (ws(x)) continue; const ch = String.fromCharCode(x); if (!/[0-9a-f]/i.test(ch)) return fail('Invalid hex string', start); hex += ch; }
      if (i >= data.length) return fail('Unterminated hex string', start);
      i++; if (hex.length % 2) hex += '0';
      return {type:'string', bytes:Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x,16)), start, end:i};
    }
    if (c === 91 || (c === 60 && data[i] === 60)) {
      const dictionary = c === 60; if (dictionary) i++;
      const items = [];
      while (true) {
        skip(); if (i >= data.length) return fail('Unterminated composite object', start);
        if ((!dictionary && data[i] === 93) || (dictionary && data[i] === 62 && data[i+1] === 62)) { i += dictionary ? 2 : 1; break; }
        const t = next(); if (!t) return null; items.push(t);
      }
      return {type:dictionary ? 'dict' : 'array', items, start, end:i};
    }
    if (c === 47) {
      let name = ''; while (!delim(data[i])) { if (data[i] === 35 && /^[0-9a-f]{2}$/i.test(String.fromCharCode(data[i+1] ?? 0, data[i+2] ?? 0))) { name += String.fromCharCode(parseInt(String.fromCharCode(data[i+1],data[i+2]),16)); i += 3; } else name += String.fromCharCode(data[i++]); }
      return {type:'name', value:name, start, end:i};
    }
    if (delim(c)) return fail('Unexpected delimiter', start);
    while (!delim(data[i])) i++;
    let value = ''; for (let k=start; k<i; k++) value += String.fromCharCode(data[k]);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return {type:'number',value:Number(value),start,end:i};
    if (['true','false','null'].includes(value)) return {type:'value',value,start,end:i};
    return {type:'operator',value,start,end:i};
  }
  return next;
}

// measure(fontName, bytes, state) returns the entire string's advance in PDF text
// space before horizontal scaling and CTM, including any character/word spacing.
// A non-finite return or an exception makes subsequent text position uncertain.
export function scanTextShows(input, {measure} = {}) {
  const diagnostics = [], shows = [];
  let data;
  if (input instanceof Uint8Array) data = input;
  else if (typeof input === 'string') { data = new Uint8Array(input.length); for (let i=0;i<input.length;i++) { if (input.charCodeAt(i)>255) { diagnostics.push({message:'Input is not Latin-1',offset:i}); return {shows,diagnostics}; } data[i]=input.charCodeAt(i); } }
  else return {shows,diagnostics:[{message:'Input must be Uint8Array or Latin-1 string',offset:0}]};
  const next = lexer(data, diagnostics);
  let s = {fontName:null,fontSize:0,textMatrix:identity(),lineMatrix:identity(),ctm:identity(),charSpace:0,wordSpace:0,hScale:100,rise:0,renderMode:0,leading:0};
  let uncertain = false, lineUncertain = false, stateUncertain = false, inText = false, stack = [], args = [];
  const nums = n => args.length === n && args.every(t => t.type === 'number' && Number.isFinite(t.value));
  const bad = t => { diagnostics.push({message:`Invalid operands for ${t.value}`,offset:t.start}); uncertain = lineUncertain = stateUncertain = true; };
  const snapshot = () => ({...s, textMatrix:[...s.textMatrix],lineMatrix:[...s.lineMatrix],ctm:[...s.ctm]});
  const move = (x,y) => { s.lineMatrix = translate(s.lineMatrix,x,y); s.textMatrix = [...s.lineMatrix]; uncertain = lineUncertain; };
  const harmless = new Set(['w','J','j','M','d','ri','i','m','l','c','v','y','h','re','S','s','f','F','f*','B','B*','b','b*','n','W','W*','CS','cs','SC','SCN','sc','scn','G','g','RG','rg','K','k','sh','Do','MP','DP','BMC','BDC','EMC','BX','EX','d0','d1']);
  for (let t; (t = next());) {
    if (t.type !== 'operator') { args.push(t); continue; }
    const op=t.value, v=args.map(a=>a.value);
    if (op === 'BI') { diagnostics.push({message:'Inline image boundary cannot be proven; scanning stopped',offset:t.start}); break; }
    if (op === 'BT') { if (args.length) bad(t); s.textMatrix=identity(); s.lineMatrix=identity(); uncertain=lineUncertain=false; inText=true; }
    else if (op === 'ET') { if (args.length) bad(t); inText=false; }
    else if (op === 'q') { stack.push({s:snapshot(),stateUncertain}); }
    else if (op === 'Q') { if (!stack.length) bad(t); else { const saved=stack.pop(); const tm=s.textMatrix, lm=s.lineMatrix, u=uncertain, lu=lineUncertain; s=saved.s; stateUncertain=saved.stateUncertain; s.textMatrix=tm; s.lineMatrix=lm; uncertain=u; lineUncertain=lu; } }
    else if (op === 'cm') { if (nums(6)) s.ctm=mul(v,s.ctm); else bad(t); }
    else if (op === 'Tm') { if (nums(6)) { s.textMatrix=[...v]; s.lineMatrix=[...v]; uncertain=lineUncertain=false; } else bad(t); }
    else if (op === 'Td' || op === 'TD') { if (nums(2)) { if (op==='TD') s.leading=-v[1]; move(...v); } else bad(t); }
    else if (op === 'T*') { if (!args.length) move(0,-s.leading); else bad(t); }
    else if (op === 'Tf') { if (args.length===2 && args[0].type==='name' && args[1].type==='number') { s.fontName=v[0]; s.fontSize=v[1]; } else bad(t); }
    else if (['TL','Tc','Tw','Tz','Ts','Tr'].includes(op)) { if (nums(1)) s[({TL:'leading',Tc:'charSpace',Tw:'wordSpace',Tz:'hScale',Ts:'rise',Tr:'renderMode'})[op]]=v[0]; else bad(t); }
    else if (['Tj','TJ',"'",'"'].includes(op)) {
      const valid = op==='TJ' ? args.length===1 && args[0].type==='array' && args[0].items.every(x=>x.type==='string'||x.type==='number') : op==='"' ? args.length===3 && args[0].type==='number' && args[1].type==='number' && args[2].type==='string' : args.length===1 && args[0].type==='string';
      if (!valid || !inText) { bad(t); args=[]; continue; }
      if (op==='"') { s.wordSpace=v[0]; s.charSpace=v[1]; }
      if (op==="'" || op==='"') move(0,-s.leading);
      const src=op==='TJ' ? args[0].items : [args[args.length-1]];
      const parts=src.map(x=>x.type==='string' ? {type:'string',bytes:x.bytes,start:x.start,end:x.end} : {type:'adjustment',value:x.value,start:x.start,end:x.end});
      shows.push({start:args[0].start,end:t.end,operatorStart:t.start,operatorEnd:t.end,kind:op,parts,...snapshot(),uncertain:uncertain || stateUncertain});
      let advance=0, known=true;
      for (const p of parts) {
        if (p.type==='adjustment') advance -= p.value / 1000 * s.fontSize;
        else { let n; try { n=measure?.(s.fontName,p.bytes,snapshot()); } catch { n=NaN; } if (!Number.isFinite(n)) known=false; else advance+=n; }
      }
      if (known) s.textMatrix=translate(s.textMatrix,advance*s.hScale/100,0); else uncertain=true;
    } else if (!harmless.has(op)) { diagnostics.push({message:`Unknown operator ${op}`,offset:t.start}); uncertain=lineUncertain=stateUncertain=true; }
    args=[];
  }
  if (args.length) diagnostics.push({message:'Trailing operands without operator',offset:args[0].start});
  return {shows,diagnostics};
}

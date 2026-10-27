import {inspectLayoutQuality} from './paper-layout-quality.mjs';
import {readOutputGlyphs} from './paper-output-glyphs.mjs';
// Byte-derived text comparison for full-document recomposition. The caller supplies
// logical content, not a destination map, as the expectation.
const normalize = value => value.replace(/\s+/gu, ' ').trim();

// Only these two representations are treated as equivalent, with their
// original offsets retained. Other character and word-space changes fail.
function representationComparison(expected, observed, prefix=false) {
  let i=0,j=0; const differences=[];
  while(i<expected.length && j<observed.length) {
    const a=expected.codePointAt(i),b=observed.codePointAt(j);
    if(a===b) {i+=a>0xffff?2:1;j+=b>0xffff?2:1;continue;}
    if(a===0x00b5 && b===0x03bc) {differences.push({kind:'micro-sign-to-greek-mu',sourceOffset:i,outputOffset:j,source:'U+00B5',output:'U+03BC'});i++;j++;continue;}
    if(a===0x00ad && expected.codePointAt(i+1)===b) {differences.push({kind:'discretionary-soft-hyphen-omitted',sourceOffset:i,outputOffset:j,source:'U+00AD',output:null});i++;continue;}
    return {matches:false,differences:[]};
  }
  return {matches:i===expected.length && (prefix || j===observed.length),differences,consumed:j};
}

export async function checkRecomposition({bytes, expectedBlocks, edits = {}, pdfjs, exporter, mupdf, expectedFurniture, outputFurniture, bodyFrame, blockSpans, layoutProfile, flowExpectations, sourceBytes, sourcePageIndexes} = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || !pdfjs?.getDocument) throw new TypeError('PDF bytes and PDF.js are required');
  if (!Array.isArray(expectedBlocks) || !expectedBlocks.length || expectedBlocks.some(b => typeof b.id !== 'string' || typeof b.text !== 'string') || new Set(expectedBlocks.map(b => b.id)).size !== expectedBlocks.length) throw new TypeError('unique expected blocks are required');
  if (Object.keys(edits).some(id => !expectedBlocks.some(b => b.id === id) || typeof edits[id] !== 'string')) throw new TypeError('invalid edit');
  const findings = [], pages = [], locations = [], spacingEvidence = [];
  const furnitureEnabled = expectedFurniture !== undefined || outputFurniture !== undefined || bodyFrame !== undefined;
  const furnitureValid = Array.isArray(expectedFurniture) && Array.isArray(outputFurniture) && bodyFrame &&
    ['left','top','right','bottom'].every(k => Number.isFinite(bodyFrame[k])) && bodyFrame.left < bodyFrame.right && bodyFrame.top < bodyFrame.bottom;
  if (furnitureEnabled && !furnitureValid) findings.push({code:'furniture-unavailable', reason:'Furniture declarations, output map or body frame unavailable.'});
  let sourceAssociation = {status:'unavailable', reason:'Complete valid block spans are unavailable.'};
  let selectedSources = null;
  let furnitureAssets = false;
  let inspectedItems = 0;
  let glyphPages = null;
  if (mupdf) {
    try { glyphPages = readOutputGlyphs({bytes:bytes.slice(), mupdf}); } catch { glyphPages = null; }
  }
  const task = pdfjs.getDocument({data: bytes.slice(), useSystemFonts: true, isEvalSupported: false});
  let doc;
  try {
    doc = await task.promise;
    if (furnitureValid) {
      const validSpan = s => typeof s?.id === 'string' && s.id.length > 0 && Number.isInteger(s.sourcePage) && s.sourcePage >= 0 &&
        [s.start,s.end].every(p => Number.isInteger(p?.page) && p.page >= 1 && p.page <= doc.numPages && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.id === undefined || p.id === s.id) && (p.sourcePage === undefined || p.sourcePage === s.sourcePage)) && s.start.page <= s.end.page;
      if (Array.isArray(blockSpans) && blockSpans.length && blockSpans.every(validSpan) &&
          new Set(blockSpans.map(s=>s.id)).size === blockSpans.length &&
          blockSpans.every((s,i)=>i===0 || s.start.page >= blockSpans[i-1].start.page)) {
        const selections = Array.from({length:doc.numPages},(_,i)=>blockSpans.find(s=>s.start.page<=i+1 && s.end.page>=i+1));
        if (selections.every(Boolean)) {
          selectedSources = selections.map(s=>s.sourcePage);
          sourceAssociation = {status:'declared', pages:selectedSources.map((sourcePage,i)=>({page:i+1,sourcePage})),
            unusedVariants:[...new Set(expectedFurniture.map(t=>t.sourcePage))].filter(p=>!selectedSources.includes(p)),
            limitation:'Source association is declared by span metadata; PDF bytes establish text and geometry.'};
        }
      }
    }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({scale: 1});
      const content = await page.getTextContent();
      const parts = [];
      let previous = null, ordinal = 0, pendingQuoteSpace = null, lineHeight = 0;
      const boundaries = [], itemScalars = [];
      const frame = viewport.transform;
      const frameSupported = viewport.rotation === 0 && Array.isArray(frame) && frame.length === 6 && frame.every(Number.isFinite) &&
        frame[0] === 1 && frame[1] === 0 && frame[2] === 0 && frame[3] === -1 &&
        Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0;
      // Match only complete, upright text runs in a reserved vertical band. The
      // map identifies an occurrence, but bytes and geometry establish its text.
      const excluded = new Set();
      if (furnitureValid) {
        const records = content.items.map((item, index) => {
          const t = item.transform, style = content.styles?.[item.fontName];
          if (typeof item.str !== 'string' || !item.str.trim() || !frameSupported || !Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite) ||
              !Number.isFinite(item.width) || item.width < 0 || !Number.isFinite(item.height) || item.height <= 0 || t[0] <= 0 || t[3] <= 0 || Math.abs(t[1]) > 1e-6 || Math.abs(t[2]) > 1e-6 || item.dir !== 'ltr' ||
              !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent < 0 || style.descent > 0) return null;
          const [x,y] = viewport.convertToViewportPoint(t[4],t[5]);
          return {index,item,x,y,top:y-style.ascent*item.height,bottom:y-style.descent*item.height};
        });
        const claimed = new Set(), mergedMarkers = new Set();
        // PDF.js can merge adjacent independently placed furniture into one item.
        // Claim it only when every mapped member and the entire extracted item agree.
        const pageMarkers = outputFurniture.filter(m=>m?.page === n);
        for (const run of records.filter(Boolean)) {
          const group = pageMarkers.filter(m=>m.kind && Math.abs(m.y-run.top)<=Math.max(4,run.item.height) && m.x>=run.x-2 && m.x<run.x+run.item.width-0.01).sort((a,b)=>a.x-b.x);
          if (group.length < 2 || Math.abs(group[0].x-run.x)>2 || group.some(m=>m.kind!==group[0].kind || m.sourcePage!==group[0].sourcePage)) continue;
          const templates=group.map(m=>expectedFurniture.filter(t=>t.sourcePage===m.sourcePage && t.kind===m.kind && t.occurrences?.some(o=>(o.blockId||o.itemId)===m.id)));
          if (templates.some(ts=>ts.length!==1 || !['text','counter'].includes(ts[0].entryKind))) continue;
          const expected=templates.map(ts=>ts[0].entryKind==='counter' ? `${n} / ${doc.numPages}` : ts[0].text);
          // Independently anchored furniture can be merged by PDF.js with or
          // without a synthetic separator. Verify all member text either way.
          if (expected.some(t=>typeof t!=='string') || ![expected.join(' '),expected.join('')].some(text=>normalize(text)===normalize(run.item.str))) continue;
          if (group[0].kind==='header' ? run.top<0 || run.bottom>bodyFrame.top : run.top<bodyFrame.bottom || run.bottom>viewport.height) continue;
          excluded.add(run.index); claimed.add(run.index);
          group.forEach(m=>mergedMarkers.add(m));
        }
        for (const marker of outputFurniture.filter(m => m?.page === n)) {
          if (mergedMarkers.has(marker)) continue;
          const matches = expectedFurniture.filter(t => t?.sourcePage === marker.sourcePage && t.kind === marker.kind &&
            t.occurrences?.some(o => (o.blockId || o.itemId) === marker.id));
          if (matches.length !== 1 || !['header','footer'].includes(marker.kind) || !Number.isFinite(marker.x) || !Number.isFinite(marker.y)) {
            findings.push({code:'furniture-unavailable',pageIndex:n-1,reason:'Invalid or ambiguous furniture map entry.'}); continue;
          }
          const template = matches[0];
          if (template.entryKind === 'asset') { furnitureAssets = true; continue; }
          const target = template.entryKind === 'counter' ? `${n} / ${doc.numPages}` : template.text;
          if (typeof target !== 'string' || !normalize(target)) { findings.push({code:'furniture-unavailable',pageIndex:n-1,reason:'Furniture text unavailable.'}); continue; }
          const candidates = [];
          for (let i=0;i<records.length;i++) {
            const first=records[i];
            if (!first || Math.abs(first.x-marker.x)>2 || Math.abs(first.top-marker.y)>Math.max(4,first.item.height)) continue;
            let value='', previousRun=null, indexes=[];
            for (let j=i;j<records.length;j++) {
              const run=records[j];
              if (!run) { if (content.items[j]?.str?.trim()) break; continue; }
              if (marker.kind === 'header' ? run.top < 0 || run.bottom > bodyFrame.top : run.top < bodyFrame.bottom || run.bottom > viewport.height) break;
              if (previousRun && !/\s$/u.test(value) && !/^\s/u.test(run.item.str)) {
                const dy=Math.abs(run.y-previousRun.y), h=Math.max(run.item.height,previousRun.item.height), gap=run.x-(previousRun.x+previousRun.item.width);
                if (previousRun.item.hasEOL || dy>h*.5 || gap>=h*.3) value+=' ';
                else if (dy>h*.1 || gap < -h*.1 || gap>h*.1) break;
              }
              value+=run.item.str; indexes.push(j); previousRun=run;
              if (normalize(value) === normalize(target)) { candidates.push(indexes.slice()); break; }
              if (normalize(value).length > normalize(target).length) break;
            }
          }
          if (candidates.length !== 1 || candidates[0].some(i=>claimed.has(i))) {
            findings.push({code:candidates.length ? 'ambiguous-furniture' : 'missing-furniture',pageIndex:n-1,id:marker.id}); continue;
          }
          for (const i of candidates[0]) { excluded.add(i); claimed.add(i); }
        }
        if (selectedSources) {
          const sourcePage = selectedSources[n-1];
          for (const marker of pageMarkers) if (marker.sourcePage !== sourcePage)
            findings.push({code:'wrong-furniture-source',pageIndex:n-1,sourcePage:marker.sourcePage,expectedSourcePage:sourcePage});
          for (const t of expectedFurniture.filter(t=>t.sourcePage===sourcePage)) {
            for (const occurrence of t.occurrences || []) {
              const id = occurrence.blockId || occurrence.itemId;
              if (!pageMarkers.some(m=>m.sourcePage===sourcePage && m.kind===t.kind && m.id===id))
                findings.push({code:'missing-furniture',pageIndex:n-1,id,sourcePage,reason:'Template occurrence has no output map entry.'});
            }
          }
        }
        for (const r of records) if (r && !excluded.has(r.index) && (r.bottom <= bodyFrame.top || r.top >= bodyFrame.bottom)) {
          findings.push({code:'unexpected-margin-text',pageIndex:n-1,text:r.item.str});
        }
      }
      for (const [itemIndex, item] of content.items.entries()) {
        if (typeof item.str !== 'string') continue;
        const t = item.transform, style = content.styles?.[item.fontName];
        const supported = frameSupported && Array.isArray(t) && t.length === 6 && t.every(Number.isFinite) &&
          Number.isFinite(item.width) && item.width >= 0 && Number.isFinite(item.height) && item.height > 0 &&
          t[0] > 0 && t[3] > 0 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 &&
          item.dir === 'ltr' && !style?.vertical;
        let position = null;
        if (supported) {
          const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
          if (Number.isFinite(x) && Number.isFinite(y)) position = {x, y, width:item.width, height:item.height};
        }
        if (item.str.trim()) {
          inspectedItems++;
          if (!position || !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent < 0 || style.descent > 0) {
            findings.push({code:'unsupported-text-geometry', pageIndex:n - 1, text:item.str});
          } else {
            const top = position.y - style.ascent * position.height;
            const bottom = position.y - style.descent * position.height;
            if (position.x < -1 || position.x + position.width > viewport.width + 1 || top < -1 || bottom > viewport.height + 1) findings.push({code:'text-outside-page', pageIndex:n - 1, text:item.str});
          }
        }
        if (excluded.has(itemIndex)) {
          for (const scalar of item.str) if (!/\s/u.test(scalar)) { itemScalars.push(scalar); ordinal++; }
          previous = null; continue;
        }
        if (pendingQuoteSpace && item.str && !/^\s+$/u.test(item.str)) {
          if (/^[”’]/u.test(item.str)) { pendingQuoteSpace.rightPosition=position; boundaries.push(pendingQuoteSpace); }
          pendingQuoteSpace=null;
        }
        // PDF.js may synthesize a zero-height space item from glyph positioning
        // immediately before a closing quote. Resolve it from encoded glyphs.
        if (item.str === ' ' && item.height === 0 && previous?.position && !previous.hasEOL && /^[”’]/u.test(content.items[itemIndex+1]?.str || '')) {
          pendingQuoteSpace={part:parts.length,ordinal,leftPosition:previous.position};
        }
        if (previous && item.str && !/\s$/u.test(previous.str) && !/^\s/u.test(item.str)) {
          if (previous.hasEOL) {
            // PDF.js can discard an encoded trailing space before EOL. Resolve
            // hyphenated words and wrapped citations from encoded glyphs.
            const recent=parts.slice(-8).join('');
            const paragraphGap=position && previous.position && Math.abs(position.y-previous.position.y)>Math.max(position.height,previous.position.height,lineHeight)*1.9;
            // A hyphen at a bottom-to-top right-column transition can be a
            // wrapped word. Require glyph alignment and encoded whitespace below.
            const columnTurn=/\S[–\-/]$/u.test(recent) && /^[\p{L}\p{N}_−]/u.test(item.str) && position && previous.position && previous.position.y > viewport.height * 0.8 && position.y < viewport.height * 0.2 && position.x > previous.position.x + previous.position.width;
            const url=/(?:https?:\/\/|www\.)[^\s]*$/iu.test(recent) && (/[./?=&-]$/u.test(recent) || (/\p{L}$/u.test(recent) && /^\p{N}/u.test(item.str)) || /^[\p{L}\p{N}_-]+[./]/u.test(item.str));
            if ((!paragraphGap || columnTurn) && ((/\S[–\-/]$/u.test(recent) && /^[\p{L}\p{N}_−]/u.test(item.str)) || (/(?:^|\s)-$/u.test(recent) && /^\p{L}/u.test(item.str)) || (/\S$/u.test(previous.str) && /^\[/u.test(item.str)) || (/\S*\/\S*[?=&]$/u.test(previous.str) && /^[\p{L}\p{N}]/u.test(item.str)) || (url && /^[\p{L}\p{N}]/u.test(item.str)))) {
              boundaries.push({part:parts.length, ordinal, leftPosition:previous.position, rightPosition:position});
            }
            parts.push(' ');
          }
          else if (!position || !previous.position) findings.push({code:'ambiguous-text-geometry', pageIndex:n - 1});
          else {
            const height = Math.max(position.height, previous.position.height);
            const dy = Math.abs(position.y - previous.position.y);
            const gap = position.x - (previous.position.x + previous.position.width);
            if (dy > height * 0.5) parts.push(' ');
            else if (dy > height * 0.1 || gap < -height * 0.1 || (gap > height * 0.1 && gap < height * 0.3)) findings.push({code:'ambiguous-text-geometry', pageIndex:n - 1});
            else if (gap >= height * 0.3) parts.push(' ');
          }
        }
        if (previous?.hasEOL && item.str) lineHeight = 0;
        if (position) lineHeight = Math.max(lineHeight, position.height);
        parts.push(item.str);
        for (const scalar of item.str) if (!/\s/u.test(scalar)) { itemScalars.push(scalar); ordinal++; }
        if (item.str) previous = {str:item.str, hasEOL:item.hasEOL, position};
        else if (item.hasEOL && previous) previous.hasEOL = true;
      }
      if (boundaries.length) {
        const glyphs = glyphPages?.[n - 1];
        const mapped = [], encoded = [];
        if (Array.isArray(glyphs)) {
          for (let i = 0; i < glyphs.length; i++) {
            const char = String.fromCodePoint(glyphs[i].scalar);
            if (!/\s/u.test(char)) { mapped.push(i); encoded.push(char); }
          }
        }
        // PDF.js normalizes U+00B5 MICRO SIGN to U+03BC GREEK SMALL LETTER MU.
        // This equivalence is used only to align the independent glyph stream;
        // content comparison still uses the extracted text unchanged.
        const glyphKey = char => char === '\u00b5' ? '\u03bc' : char;
        const aligned = encoded.length === itemScalars.length && encoded.every((char, i) => glyphKey(char) === glyphKey(itemScalars[i]));
        for (const boundary of boundaries) {
          const left = mapped[boundary.ordinal - 1], right = mapped[boundary.ordinal];
          const near = (glyph, pos) => pos && glyph && Math.abs(glyph.origin[1] - pos.y) < Math.max(1, pos.height * 0.2) &&
            glyph.origin[0] >= pos.x - 1 && glyph.origin[0] <= pos.x + pos.width + 1;
          if (aligned && left !== undefined && right !== undefined && left < right &&
              near(glyphs[left], boundary.leftPosition) && near(glyphs[right], boundary.rightPosition)) {
            const spaces=glyphs.slice(left + 1, right).filter(g=>/\s/u.test(String.fromCodePoint(g.scalar)));
            const resolved=spaces.length ? ' ' : '';
            if(parts[boundary.part]!==resolved) spacingEvidence.push({pageIndex:n-1,action:resolved?'retain-encoded-space':'remove-inferred-space',leftScalar:glyphs[left].scalar,rightScalar:glyphs[right].scalar,leftOrigin:glyphs[left].origin,rightOrigin:glyphs[right].origin,encodedWhitespace:spaces.map(g=>g.scalar)});
            parts[boundary.part] = resolved;
          } else {
            findings.push({code:'ambiguous-text-geometry', pageIndex:n - 1, reason:'PDF.js may discard an encoded space at a line-final hyphen or citation boundary, or infer one before a closing quote; glyph stream unavailable or misaligned.'});
          }
        }
      }
      pages.push(normalize(parts.join('')));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  if (furnitureValid) {
    for (const m of outputFurniture) if (!Number.isInteger(m?.page) || m.page < 1 || m.page > (doc?.numPages || 0)) findings.push({code:'furniture-unavailable',reason:'Furniture map page is invalid.'});
    if (expectedFurniture.some(t=>t.entryKind === 'asset')) furnitureAssets = true;
  }
  const observed = normalize(pages.join(' '));
  const expected = normalize(expectedBlocks.map(b => Object.hasOwn(edits,b.id) ? edits[b.id] : b.text).join(' '));
  const layoutQuality=inspectLayoutQuality({bytes,mupdf,profile:layoutProfile,sourceBytes,sourcePageIndexes});
  let flow={status:'not-requested'}, flowMatches=false, flowDifferences=[];
  if(flowExpectations !== undefined) {
    const ids=flowExpectations?.floatingCaptionBlockIds, captions=layoutProfile?.captions;
    const removeUnique=(stream,value,allowRepresentations=false)=>{
      const matches=[];
      for(let at=0;at<stream.length;at++) {
        if(at && stream[at-1]!==' ') continue;
        const match=allowRepresentations ? representationComparison(value,stream.slice(at),true) : {matches:stream.startsWith(value,at),consumed:value.length,differences:[]};
        const end=at+match.consumed;
        if(match.matches && (end===stream.length || stream[end]===' ')) matches.push({at,end,differences:match.differences});
      }
      if(matches.length!==1) return null;
      const match=matches[0];return {stream:normalize(stream.slice(0,match.at)+' '+stream.slice(match.end)),differences:match.differences};
    };
    if(Array.isArray(ids) && ids.length && new Set(ids).size===ids.length && Array.isArray(captions)) {
      let left=expected,right=observed,reason=null;
      for(const id of ids) {
        const block=expectedBlocks.find(b=>b.id===id), declarations=captions.filter(c=>c.id===id), observations=layoutQuality.captionObservations?.filter(c=>c.id===id && c.status==='observed');
        const value=block && normalize(Object.hasOwn(edits,id)?edits[id]:block.text);
        if(!value || declarations.length!==1 || normalize(declarations[0].text||'')!==value || observations?.length!==1) {reason='Caption declaration or independent image association is ambiguous or unavailable.';break;}
        const sourceCaption=removeUnique(left,value), outputCaption=removeUnique(right,value,true);
        if(!sourceCaption || !outputCaption) {reason='Caption occurrence is missing or ambiguous.';break;}
        left=sourceCaption.stream; right=outputCaption.stream;
        flowDifferences.push(...outputCaption.differences.map(d=>({...d,scope:'caption',captionId:id})));
      }
      if(reason) flow={status:'unavailable',reason};
      else {const body=representationComparison(left,right);flowMatches=body.matches; if(flowMatches) flowDifferences.push(...body.differences.map(d=>({...d,scope:'body-after-caption-removal'})));flow={status:flowMatches?'checked':'finding',comparison:'Ordered body after removing uniquely observed declared captions, allowing documented representation differences.'};}
    } else flow={status:'unavailable',reason:'Invalid floating caption declarations.'};
  }
  const representation=representationComparison(expected,observed);
  const reportedDifferences=representation.matches ? representation.differences : flowMatches ? flowDifferences : [];
  if (!representation.matches && !flowMatches) findings.push({code:'content-mismatch', expected, observed});
  const alignmentAvailable = observed === expected && !findings.some(f => f.code === 'ambiguous-text-geometry' || f.code === 'unsupported-text-geometry');
  if (alignmentAvailable) {
    // Both sequences are normalized as a whole, with one separator between
    // nonempty entries. Offsets therefore follow the validated sequence itself.
    const pageRanges = []; let offset = 0;
    for (const page of pages) {
      if (!page) { pageRanges.push(null); continue; }
      if (offset) offset++;
      pageRanges.push({start:offset, end:offset + page.length});
      offset += page.length;
    }
    offset = 0;
    for (const block of expectedBlocks) {
      const value = normalize(Object.hasOwn(edits,block.id) ? edits[block.id] : block.text);
      if (!value) { locations.push({id:block.id, pageIndexes:[]}); continue; }
      if (offset) offset++;
      const start = offset, end = start + value.length;
      const pageIndexes = pageRanges.flatMap((range, i) => range && range.start < end && range.end > start ? [i] : []);
      locations.push({id:block.id, pageIndexes});
      offset = end;
    }
  }
  const independent = typeof exporter === 'string' && exporter.trim() && !/pdf\.?js/i.test(exporter) ? {status:'declared', reader:'PDF.js text extraction', exporter, limitation:'Distinct named engines only; exporter identity is caller supplied.'} : {status:'unavailable', reader:'PDF.js text extraction', reason:'Exporter path not supplied or uses PDF.js.'};
  return {schema:'falsify.recomposition-check.v1', readable:true, layoutQuality, checks:{flow, furniture:furnitureEnabled ? {status:findings.some(f=>f.code==='missing-furniture' || f.code==='unexpected-margin-text' || f.code==='wrong-furniture-source') ? 'finding' : !furnitureValid || !selectedSources || findings.some(f=>f.code==='furniture-unavailable' || f.code==='ambiguous-furniture') ? 'unavailable' : 'checked', sourceAssociation, assets:furnitureAssets ? {status:'unavailable',reason:'Furniture assets require independent visual inspection.'} : {status:'not-applicable'}} : undefined,content:{status:findings.some(f=>f.code==='ambiguous-text-geometry' || f.code==='unsupported-text-geometry') ? 'unavailable' : observed===expected || (flowMatches && !flowDifferences.length) ? 'pass' : representation.matches || flowMatches ? 'normalized' : 'finding', comparison:'ordered text with whitespace runs collapsed; ambiguous item geometry is unavailable',representationDifferences:reportedDifferences,spacingEvidence,offsetUnit:'UTF-16 offsets in whitespace-normalized source expectation and PDF.js output; scoped flow differences use caption-local or body-after-caption-removal offsets',limitation:reportedDifferences.length ? 'The listed representation differences are not byte-exact preservation.' : undefined}, bounds:{status:findings.some(f=>f.code==='text-outside-page')?'finding':!inspectedItems || findings.some(f=>f.code==='unsupported-text-geometry')?'unavailable':'checked', limitation:'Extracted upright text items only, estimated from font ascent and descent; PDF.js may omit off-page text. Not clipping or ink bounds.'}, movement:alignmentAvailable ? {status:'observed', locations} : {status:'unavailable', locations:null, reason:'Complete ordered text alignment or supported geometry is unavailable.'}, independent, visual:{status:'unavailable', reason:'No raster or visibility inspection.'}, overlap:{status:'unavailable', reason:'Text and asset ownership not established.'}, captionOwnership:{status:'unavailable', reason:'Relations not established from PDF bytes.'}}, findings};
}

const BIB_HEADING = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:references|bibliography|literature\s+cited|works\s+cited|reference\s+list)\s*:?$/iu;
const PROSE_CONNECTOR = /(?:^|\s)(?:and|or|to|in|see|from|with|by|of|ref\.?|refs\.?|fig\.?|table|eq\.?|vol\.?|no\.?|pp\.?|p\.?)\s*$/iu;

export function isBibliographyHeading(item) {
  if (!item || item.assetId || typeof item.text !== 'string') return false;
  const role = item.extensions?.publicationRole;
  const isHeading = item.kind === 'heading' || role === 'section-heading';
  return isHeading && BIB_HEADING.test(item.text.trim());
}

export function isNonBibliographyHeading(item) {
  if (!item || item.assetId || typeof item.text !== 'string') return false;
  const role = item.extensions?.publicationRole;
  const isHeading = item.kind === 'heading' || role === 'section-heading';
  return isHeading && !BIB_HEADING.test(item.text.trim());
}

function isEntryEndBefore(text, index, breakSet) {
  if (index <= 0) return false;
  const before = text.slice(Math.max(0, index - 80), index);
  if (PROSE_CONNECTOR.test(before)) return false;
  const trimmed = before.replace(/\s+$/u, '');
  if (!trimmed) return false;
  if (breakSet.has(index) && /[.!?;)\d]\s*$/u.test(trimmed)) return true;
  return /(?:[.!?;)]|(?:19|20)\d{2}[a-z]?|doi:\s*\S+|https?:\/\/\S+)\s*$/iu.test(trimmed);
}

function collectBracketSplits(text, inBibliography, breakSet) {
  const matches = [...text.matchAll(/(?:^|(?<=\s))\[(\d{1,4})\]\s+(?=\S)/gu)];
  if (matches.length < 2) return [];
  const firstStarts = matches[0].index === text.search(/\S/);
  if (!inBibliography && !(firstStarts && Number(matches[0][1]) === 1)) return [];
  const splits = [];
  let prevNum = Number(matches[0][1]);
  let prevPos = matches[0].index;
  for (let i = 1; i < matches.length; i++) {
    const num = Number(matches[i][1]);
    const pos = matches[i].index;
    const sequential = num === prevNum + 1;
    if (sequential && pos - prevPos >= 8 && isEntryEndBefore(text, pos, breakSet)) {
      splits.push(pos);
      prevNum = num;
      prevPos = pos;
    }
  }
  return splits;
}

function collectNumberedSplits(text, inBibliography, breakSet) {
  const matches = [...text.matchAll(/(?:^|(?<=\s))(\d{1,4})\.\s+(?=\p{Lu})/gu)];
  if (matches.length < 2) return [];
  const firstStarts = matches[0].index === text.search(/\S/);
  if (!inBibliography && !(firstStarts && Number(matches[0][1]) === 1)) return [];
  const splits = [];
  let prevNum = Number(matches[0][1]);
  let prevPos = matches[0].index;
  for (let i = 1; i < matches.length; i++) {
    const num = Number(matches[i][1]);
    const pos = matches[i].index;
    const sequential = num === prevNum + 1;
    if (sequential && pos - prevPos >= 15 && isEntryEndBefore(text, pos, breakSet)) {
      splits.push(pos);
      prevNum = num;
      prevPos = pos;
    }
  }
  return splits;
}

function collectDoiYearSplits(text, breakSet) {
  const splits = [];
  const re = /(?:(?:19|20)\d{2}[a-z]?[.)]?\.|doi:\s*\S+\.?|https?:\/\/\S+\.?|\b\d+[–-]\d+\.)\s+(?=\p{Lu}[\p{Ll}'’-]+,\s+\p{Lu}\.)/gu;
  for (const m of text.matchAll(re)) {
    const authorStart = m.index + m[0].length;
    if (authorStart > 0 && authorStart < text.length && !PROSE_CONNECTOR.test(text.slice(Math.max(0, authorStart - 40), authorStart))) {
      splits.push(authorStart);
    }
  }
  for (const pos of breakSet) {
    if (pos <= 15 || pos >= text.length || splits.includes(pos)) continue;
    const before = text.slice(Math.max(0, pos - 60), pos);
    const after = text.slice(pos, pos + 40);
    const terminated = /(?:doi:\s*\S+|https?:\/\/\S+|\(\s*(?:19|20)\d{2}[a-z]?\s*\)|(?:19|20)\d{2}[a-z]?\.|\b\d+[–-]\d+\.)\s*$/iu.test(before);
    const newEntry = /^(?:\p{Lu}[\p{Ll}'’-]+,\s+\p{Lu}\.|\p{Lu}\.\s*(?:\p{Lu}\.\s*)?\p{Lu}[\p{Ll}'’-]+,)/u.test(after);
    if (terminated && newEntry) splits.push(pos);
  }
  return splits;
}

/** Detect character split offsets for merged bibliography/reference entries. */
export function detectBibliographySplits(text, {inBibliography = false, lineBreaks = []} = {}) {
  if (typeof text !== 'string' || text.length < 16) return [];
  const breakSet = new Set(Array.isArray(lineBreaks) ? lineBreaks : []);
  const bracket = collectBracketSplits(text, inBibliography, breakSet);
  if (bracket.length) return bracket;
  const numbered = collectNumberedSplits(text, inBibliography, breakSet);
  if (numbered.length) return numbered;
  if (!inBibliography) return [];
  return [...new Set(collectDoiYearSplits(text, breakSet))].filter(n => n > 0 && n < text.length).sort((a, b) => a - b);
}

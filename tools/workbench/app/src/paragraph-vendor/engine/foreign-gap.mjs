// A paragraph model can infer a space across a separate superscript object.
// Drop that model-only space only when the source character inventory proves
// the intervening characters are foreign objects physically in that gap.
export function removeForeignObjectGapSpaces(modelRuns, runs, chars, owned) {
  const original = modelRuns.map(r => r.text).join('');
  const replacement = runs.map(r => r.text).join('');
  let prefix = 0;
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
  const source = chars.filter(c => owned.has(c.obj) && c.ch && !/\s/.test(c.ch));
  const model = [...original].filter(ch => !/\s/.test(ch));
  if (model.length !== source.length || model.some((ch, i) => ch !== source[i].ch)) return runs;
  const positions = []; let gi = 0;
  for (let i = 0; i < original.length; i++) if (!/\s/.test(original[i])) positions[i] = gi++;
  const drops = [];
  for (let i = 1; i + 1 < Math.min(prefix, original.length); i++) {
    if (original[i] !== ' ' || /\s/.test(original[i - 1]) || /\s/.test(original[i + 1])) continue;
    const a = source[positions[i - 1]], b = source[positions[i + 1]];
    if (!a?.box || !b?.box || a.obj === b.obj || a.index >= b.index) continue;
    const between = chars.slice(a.index + 1, b.index);
    if (!between.length || between.some(c => !c.ch || /\s/.test(c.ch) || owned.has(c.obj) || !c.box)) continue;
    const [al, ar, ab, at] = a.box, [bl, br, bb, bt] = b.box;
    if (!(ar <= bl && Math.min(at, bt) >= Math.max(ab, bb))) continue;
    if (between.some(c => c.box[0] < ar - .1 || c.box[1] > bl + .1 || c.box[3] < Math.min(ab, bb) || c.box[2] > Math.max(at, bt))) continue;
    drops.push(i);
  }
  if (!drops.length) return runs;
  let offset = 0;
  return runs.map(r => {
    const start = offset; offset += r.text.length;
    const local = drops.filter(i => i >= start && i < offset).map(i => i - start);
    if (!local.length) return r;
    return {...r, text: [...r.text].filter((_, i) => !local.includes(i)).join('')};
  });
}

// Restore a missing source space only when both adjacent glyphs survive in
// the unchanged prefix or suffix and the text page proves the intervening gap.
export function restoreSourceWordGaps(modelRuns, runs, chars, owned) {
  const original = modelRuns.map(r => r.text).join('');
  const replacement = runs.map(r => r.text).join('');
  const source = chars.filter(c => owned.has(c.obj) && c.ch && !/\s/.test(c.ch));
  const positions = [];
  for (let i = 0; i < original.length; i++) if (!/\s/.test(original[i])) positions.push(i);
  if (source.length !== positions.length || positions.some((p, i) => original[p] !== source[i].ch)) return runs;
  const provenGap = (a, b) => {
    if (!a.box || !b.box || a.index >= b.index) return false;
    const between = chars.slice(a.index + 1, b.index);
    if (!between.length || between.some(c => c.ch !== ' ' || !c.box || (!owned.has(c.obj) && !c.generated))) return false;
    const [, ar, ab, at] = a.box, [bl, , bb, bt] = b.box;
    if (!(ar <= bl && Math.min(at, bt) >= Math.max(ab, bb))) return false;
    return !between.some(c => c.box[0] < ar - .1 || c.box[1] > bl + .1 || c.box[3] < Math.min(ab, bb) || c.box[2] > Math.max(at, bt));
  };
  // The native writer can discard a leading space on a styled run. Move a
  // proven unchanged boundary space to the preceding run without changing
  // the requested text or its non-space styles.
  const shifted = runs.map(r => ({...r}));
  const starts = []; let at = 0;
  for (const r of modelRuns) { starts.push(at); at += r.text.length; }
  for (let i = 1; i < shifted.length; i++) {
    const a = shifted[i - 1], b = shifted[i], ai = a.sourceIndex, bi = b.sourceIndex;
    if (!Number.isInteger(ai) || bi !== ai + 1 || !modelRuns[ai] || !modelRuns[bi]) continue;
    const leftText = modelRuns[ai].text, rightText = modelRuns[bi].text;
    if (!leftText || !/^ \S/.test(rightText) || a.text !== leftText || !b.text.startsWith(rightText.slice(0, 2))) continue;
    const p = starts[bi];
    const gi = positions.indexOf(p - 1);
    if (gi < 0 || positions[gi + 1] !== p + 1 || !provenGap(source[gi], source[gi + 1])) continue;
    a.text += ' '; b.text = b.text.slice(1);
  }
  runs = shifted;
  let prefix = 0, suffix = 0;
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
  while (suffix < original.length - prefix && suffix < replacement.length - prefix && original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++;
  const insertions = [];
  for (let i = 0; i + 1 < source.length; i++) {
    const left = positions[i], right = positions[i + 1];
    if (right !== left + 1) continue;
    let target;
    if (right < prefix) target = right;
    else if (left >= original.length - suffix) target = replacement.length - (original.length - right);
    else continue;
    if (!provenGap(source[i], source[i + 1])) continue;
    insertions.push(target);
  }
  if (!insertions.length) return runs;
  let offset = 0;
  return runs.map(r => {
    const start = offset; offset += r.text.length;
    const local = insertions.filter(i => i >= start && i < offset).map(i => i - start);
    if (!local.length) return r;
    let text = r.text;
    for (const i of local.reverse()) text = text.slice(0, i) + ' ' + text.slice(i);
    return {...r, text};
  });
}

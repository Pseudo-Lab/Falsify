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

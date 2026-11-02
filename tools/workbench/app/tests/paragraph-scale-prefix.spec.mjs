import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInlineChange } from '../src/paragraph-vendor/inline-preservation.mjs';

function plan(runs, offsets, widths = offsets.map(() => 200)) {
  const para = { runs, lines: offsets.map((off, i) => ({ off, x: 10, w: widths[i] })) };
  const chars = runs.flatMap((r, ri) => [...r.text].map((ch, o) => ({ ch, pi: 0, ri, o })));
  const before = chars.map(c => c.ch).join('');
  return planInlineChange([para], chars, chars.map((_, i) => [i, i]), 0, before, 'replacement is longer');
}
const run = (text, hScale, extra = {}) => ({ text, hScale, family: 'Source', size: 10, ...extra });

test('line-specific scaling requires a source-preserving prefix', () => {
  assert.equal(plan([run('before ', 1.1), run('after', 1)], [0, 7]).requiresPrefix, true);
});
test('mixed scale on one line or a true font change stays ambiguous', () => {
  assert.equal(plan([run('be', 1.1), run('fore ', 1), run('after', 1.2)], [0, 7]).failure, 'AMBIGUOUS_STYLE');
  assert.equal(plan([run('before ', 1.1), run('after', 1, { bold: true })], [0, 7]).failure, 'AMBIGUOUS_STYLE');
  assert.equal(plan([run('before ', 1.1), run('after', 1)], [0, 7], [200, 130]).failure, 'AMBIGUOUS_STYLE');
});
import { splitSourceOwnership, sourceDiscretionaryHyphens } from '../src/paragraph-vendor/inline-preservation.mjs';
import { restoreSourceOrder } from '../src/paragraph-vendor/quality.mjs';

test('split ownership preserves retained prefix across an interleaved mask', () => {
  const objects = [1, 2, 4];
  const source = { objects: [1, 2, 3], paras: [{ id: 8, handles: [1, 3], slots: [0, 2], topLevel: true, sharesObjects: false }] };
  const split = splitSourceOwnership(source, 0, [3], [1], [4]);
  const M = {
    _FPDFPage_CountObjects: () => objects.length,
    _FPDFPage_GetObject: (_, i) => objects[i],
    _FPDFPageObj_GetType: h => h === 2 ? 2 : 1,
    _FPDFPage_RemoveObject: (_, h) => { objects.splice(objects.indexOf(h), 1); return 1; },
    _FPDFPage_InsertObjectAtIndex: (_, h, i) => { objects.splice(i, 0, h); return 1; },
  };
  const repairs = [], warnings = [];
  restoreSourceOrder({ M, page: 1, paragraphObjects: id => split.ownership.get(id) || [] }, split.context, repairs, warnings);
  assert.deepEqual(objects, [1, 2, 4]);
  assert.ok(!warnings.some(w => w.severity === 'error' || w.code === 'unmapped_new_objects'));
  assert.equal(splitSourceOwnership(source, 0, [1, 3], [], [4]), null);
});


test('unowned discretionary glyph needs a unique adjacent source owner', () => {
  const memory = new Float64Array(8);
  const M = {
    HEAPF64: memory, _malloc: () => 8, _free: () => {},
    _FPDFPage_CountObjects: () => 3, _FPDFPage_GetObject: (_, i) => [1, 2, 3][i],
    _FPDFText_LoadPage: () => 1, _FPDFText_ClosePage: () => {},
    _FPDFText_CountChars: () => 1, _FPDFText_GetTextObject: () => 3,
    _FPDFText_IsHyphen: () => 1,
    _FPDFText_GetCharOrigin: (_, __, x, y) => { memory[x >> 3] = 30; memory[y >> 3] = 50; return 1; },
  };
  const engine = { M, page: 1, objectBounds: () => ({x: 30, y: 50, w: 1, h: 1}) };
  const context = { paras: [{id: 8, handles: [1]}, {id: 9, handles: [2]}] };
  const glyph = {u: 97, x: 28, y: 50, size: 10, vd: 1, aspect: 1};
  assert.equal(sourceDiscretionaryHyphens(engine, context, [[glyph], []])[0].owner, 8);
  assert.equal(sourceDiscretionaryHyphens(engine, context, [[glyph], [glyph]]), null);
  assert.equal(sourceDiscretionaryHyphens(engine, context, [[], []]), null);
});

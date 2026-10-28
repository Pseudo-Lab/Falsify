import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateColumns } from '../src/paragraph-column-isolation.mjs';

function fixture({ text = [['left', 1], [' ', 0], ['right', 2]], failRemove = 0, failInsert = 0 } = {}) {
  const chars = text.flatMap(([s, h]) => Array.from(s, ch => ({ ch, h })));
  const objects = [1, 3, 2, 4, 5];
  const bounds = new Map([[1, {x: 0, w: 40}], [2, {x: 100, w: 40}], [3, {x: 110, w: 20}], [4, {x: 5, w: 20}], [5, {x: 120, w: 20}]]);
  let removals = 0, inserts = 0;
  const M = {
    _FPDFText_LoadPage: () => 7, _FPDFText_CountChars: () => chars.length,
    _FPDFText_GetUnicode: (_, i) => chars[i].ch.codePointAt(0),
    _FPDFText_GetTextObject: (_, i) => chars[i].h, _FPDFText_ClosePage: () => {},
    _FPDFPageObj_GetType: h => h === 5 ? 3 : 1,
    _FPDFPage_RemoveObject: (_, h) => { if (++removals === failRemove) return 0; objects.splice(objects.indexOf(h), 1); return 1; },
    _FPDFPage_InsertObjectAtIndex: (_, h, i) => { if (++inserts === failInsert) return 0; objects.splice(i, 0, h); return 1; },
  };
  const engine = { M, page: 1, objectCount: () => objects.length,
    objectAt: i => ({handle: objects[i]}), objectBounds: h => bounds.get(h),
    paragraphObjects: () => [1, 2] };
  return { engine, objects, run: before => isolateColumns(engine, [{id: 'p'}], [{before}], {failures: [], plans: [{touched: [0]}]}) };
}

test('isolates either side and restores every foreign text object at its original slot', () => {
  for (const [quote, remaining] of [['left', [1, 4, 5]], ['right', [3, 2, 5]]]) {
    const f = fixture();
    const restore = f.run(quote);
    assert.equal(typeof restore, 'function');
    assert.deepEqual(f.objects, remaining);
    restore();
    assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
    restore();
    assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
  }
});

test('ambiguous, empty, or mixed-side quotes do not mutate the page', () => {
  for (const [text, quote] of [[undefined, 'left right'], [[['left', 1], [' ', 0], ['left', 2]], 'left'], [undefined, '']]) {
    const f = fixture({text});
    assert.equal(f.run(quote), null);
    assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
  }
});

test('failed removal rolls back earlier removals', () => {
  const f = fixture({failRemove: 2});
  assert.throws(() => f.run('left'), /column_isolation_remove_failed/);
  assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
});

test('restore attempts remaining objects after an insertion failure and retries the failed one', () => {
  const f = fixture({failInsert: 1});
  const restore = f.run('left');
  assert.throws(restore, /column_isolation_restore_failed/);
  assert.deepEqual(f.objects, [1, 2, 4, 5]);
  restore();
  assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
});

test('quote mapping accounts for supplementary Unicode characters', () => {
  const f = fixture({text: [['😀left', 1], [' ', 0], ['right', 2]]});
  const restore = f.run('😀left');
  assert.equal(typeof restore, 'function');
  assert.deepEqual(f.objects, [1, 4, 5]);
  restore();
  assert.deepEqual(f.objects, [1, 3, 2, 4, 5]);
});

test('failed rollback releases only objects still detached', () => {
  const f=fixture({failRemove:2}), destroyed=[];
  f.engine.M._FPDFPage_InsertObjectAtIndex=()=>0;
  f.engine.M._FPDFPageObj_Destroy=h=>destroyed.push(h);
  assert.throws(()=>f.run('left'),/column_isolation_restore_failed/);
  assert.deepEqual(destroyed,[3]);
  assert.deepEqual(f.objects,[1,2,4,5]);
});

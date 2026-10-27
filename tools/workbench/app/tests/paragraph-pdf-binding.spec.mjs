import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcileSourceWrap} from '../dist/paragraph-pdf.mjs';

const model = (text, starts=[]) => ({runs:[{text}], lines:starts.map(off=>({off}))});
const pair = '\ufffc\u00ad';
const wrapped = model(`A expres${pair}sion ends`, [10]);

test('source line boundary reconciles visible and logical spellings to exact raw span', () => {
  assert.deepEqual(reconcileSourceWrap([wrapped], 'A expres-\nsion ends'), {before:`A expres${pair}sion ends`});
  assert.deepEqual(reconcileSourceWrap([wrapped], 'A expression ends'), {before:`A expres${pair}sion ends`});
});
test('literal hyphens and markers without source line proof are never reconciled', () => {
  assert.equal(reconcileSourceWrap([model('A expres-sion ends', [9])], 'A expres-\nsion ends'), null);
  assert.equal(reconcileSourceWrap([model(`A expres${pair}sion ends`, [])], 'A expres-\nsion ends'), null);
});
test('all source representations count towards ambiguity', () => {
  assert.deepEqual(reconcileSourceWrap([wrapped, wrapped], 'A expres-\nsion ends'), {ambiguous:true,hits:2});
  assert.deepEqual(reconcileSourceWrap([wrapped, model('A expres- sion ends')], 'A expres-\nsion ends'), {ambiguous:true,hits:2});
  assert.deepEqual(reconcileSourceWrap([wrapped, model('A expression ends')], 'A expression ends'), {ambiguous:true,hits:2});
});
test('reconciliation leaves the input model and caller text untouched', () => {
  const snapshot=JSON.stringify(wrapped), before='A expres-\nsion ends';
  reconcileSourceWrap([wrapped], before);
  assert.equal(JSON.stringify(wrapped),snapshot); assert.equal(before,'A expres-\nsion ends');
});

test('multiple nearby source wraps fail closed instead of hiding mixed-spelling candidates', () => {
  const text=`A ab${pair}cd ef${pair}gh ends`;
  assert.deepEqual(reconcileSourceWrap([model(text,[6,13])], 'A ab-\ncd ef-\ngh ends'), {unsupported:true});
});

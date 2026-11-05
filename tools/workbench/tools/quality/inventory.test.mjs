import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {inventory, productionPath} from './inventory.mjs';

function cleanupFixture(root) {
  const target = resolve(root);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('falsify-ccn-'));
  rmSync(target, {recursive: true, force: true});
}

test('production scope counts authored dist and new helpers while separating known mirrors', () => {
  for (const path of ['app/src/new-policy.mjs', 'app/local/new_policy.py', 'app/dist/paper-workspace.js', 'cloud/api/src/confluence.mjs']) {
    assert.equal(productionPath(path), true, path);
  }
  for (const path of ['app/dist/latex-workbench.mjs', 'app/src/paragraph-vendor/engine/core.js', 'app/tests/example.mjs', 'tools/quality/inventory.mjs']) {
    assert.equal(productionPath(path), false, path);
  }
});

test('inventory counts nested functions separately and applies a strict greater-than threshold', () => {
  const root = mkdtempSync(join(tmpdir(), 'falsify-ccn-'));
  try {
    mkdirSync(join(root, 'app/src'), {recursive: true});
    const source = 'function outer(a){if(a)return inner();return 0;function inner(){if(a)return 1;return 0;}}';
    writeFileSync(join(root, 'app/src/example.mjs'), source);
    const exact = inventory(root, {paths: ['app/src/example.mjs'], threshold: 2});
    assert.equal(exact.functions, 2);
    assert.equal(exact.ccnTotal, 4);
    assert.equal(exact.aboveThreshold, 0);
    const over = inventory(root, {paths: ['app/src/example.mjs'], threshold: 1});
    assert.equal(over.aboveThreshold, 2);
    assert.equal(over.errors.length, 0);
  } finally { cleanupFixture(root); }
});

test('parse failures remain failures rather than disappearing from the scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'falsify-ccn-'));
  try {
    mkdirSync(join(root, 'app/src'), {recursive: true});
    writeFileSync(join(root, 'app/src/broken.mjs'), 'function {');
    const result = inventory(root, {paths: ['app/src/broken.mjs']});
    assert.equal(result.files, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].path, 'app/src/broken.mjs');
  } finally { cleanupFixture(root); }
});

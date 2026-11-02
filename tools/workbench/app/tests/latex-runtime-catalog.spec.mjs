import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latexRuntimeCatalog, latexRuntimeAssets } from '../src/latex-runtime-catalog.mjs';
test('Lua profile adds only pinned local profile; pdfLaTeX retains basic assets', () => {
  assert.deepEqual(latexRuntimeAssets('lualatex'), ['texlive-basic.js', 'texlive-lua-profile.js']);
  assert.deepEqual(latexRuntimeAssets('pdflatex'), ['texlive-basic.js']);
  assert.ok(latexRuntimeCatalog.profiles.lua.packages.includes('fontspec'));
  assert.ok(latexRuntimeCatalog.profiles.lua.packages.includes('microtype'));
  assert.ok(latexRuntimeCatalog.profiles.basic.packages.includes('longtable'));
  assert.ok(latexRuntimeCatalog.profiles.lua.packages.includes('longtable'));
});

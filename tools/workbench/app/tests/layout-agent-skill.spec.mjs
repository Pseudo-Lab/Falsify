import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('packaged agent receives the exact project layout skill',async()=>{
  const [project,packaged]=await Promise.all([
    readFile(new URL('../../.agents/skills/falsify-paper-layout/SKILL.md',import.meta.url)),
    readFile(new URL('../local/layout-agent-skill.md',import.meta.url))
  ]);
  assert.deepEqual(packaged,project);
});

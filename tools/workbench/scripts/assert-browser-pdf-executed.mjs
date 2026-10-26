// Fail when the vendored MuPDF browser test was skipped. node --test exits 0 for skips.
import { readFileSync } from 'node:fs';

export const CHROME_TEST = 'chrome classic loader runs the vendored WASM edit';

export function assertChromeLoaderExecuted(tap) {
  const hits = String(tap).split(/\n/).map(line => line.trim()).filter(line => line.includes(CHROME_TEST) && /^(?:ok|not ok)\b/.test(line));
  if (!hits.length) throw new Error(`MuPDF browser test did not run: ${CHROME_TEST}`);
  if (hits.some(line => /# SKIP\b/i.test(line))) throw new Error('MuPDF browser test was skipped. A skip is not a pass.');
  if (hits.some(line => line.startsWith('not ok'))) throw new Error('MuPDF browser test failed.');
  return hits.length;
}

const invoked = process.argv[1] && process.argv[1].endsWith('assert-browser-pdf-executed.mjs');
if (invoked) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/assert-browser-pdf-executed.mjs TAP_FILE');
  assertChromeLoaderExecuted(readFileSync(file, 'utf8'));
}

import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {javascriptFunctions, pythonFunctions} from './complexity.mjs';

// Keep the production boundary used by the alpha.50 census. New runtime helpers
// are counted automatically; this list only identifies existing build mirrors.
const generated = new Set(`blue-visual-input.js browser-pdf.mjs browser-pdf-worker.mjs browser-pdf.js
chart-mark-editor.js chart-shape-editor.js chart-shape-core.js paper-chart-redraw.js
document-import.js document-export.js document-preview.js latex-workbench.mjs pdf-latex-reader-worker.mjs
paper-font-service.js paragraph-pdf.mjs paragraph-pdf-worker.mjs paragraph-pdf.js table-pdf-worker.mjs
table-pdf.js pdf-edit-pipeline.js recomposition-typst.mjs paper-recompose-runtime.mjs
paper-recompose-worker-core.mjs paper-recompose-worker.mjs`.split(/\s+/));

export function productionPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  if (/(^|\/)(vendor|[^/]*-vendor|vendor-sources)(\/|$)/.test(lower)) return false;
  if (normalized === 'app/tests/latex-compiler-harness/map-bundle.mjs') return false;
  if (normalized.startsWith('app/dist/') && generated.has(normalized.split('/').at(-1))) return false;
  if (/(^|\/)(tests?|__tests__|fixtures)(\/|$)/.test(lower)) return false;
  if (/\.(test|spec)\./.test(lower) || normalized.split('/').at(-1).startsWith('test_')) return false;
  return !/(^|\/)(tools|scripts|examples|experiments|benchmarks?|legacy)(\/|$)/.test(lower);
}

export function trackedPaths(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) throw Error(`Cannot list tracked files: ${result.error || result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function scriptPath(path) {
  return /\.(?:js|mjs|cjs|jsx|ts|tsx|py)$/.test(path);
}

function readFunctions(root, path, python) {
  const bytes = readFileSync(resolve(root, path));
  if (bytes.length > 4_000_000) throw Error('File exceeds the 4 MB census limit');
  const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const parse = path.endsWith('.py') ? text => pythonFunctions(text, python) : javascriptFunctions;
  return parse(source.replace(/^\uFEFF/, '')).map(fn => ({
    path, id: fn.id, ccn: fn.ccn,
    line: source.slice(0, source.indexOf(fn.source)).split('\n').length,
  }));
}

export function inventory(root, {paths = trackedPaths(root), threshold = 15, python} = {}) {
  if (!Number.isInteger(threshold) || threshold < 0) throw Error('Threshold must be a non-negative integer');
  const files = paths.filter(productionPath).filter(scriptPath);
  const functions = [], errors = [];
  for (const path of files) {
    try { functions.push(...readFunctions(root, path, python)); }
    catch (error) { errors.push({path, error: error.message}); }
  }
  const violations = functions.filter(fn => fn.ccn > threshold).sort((a, b) => b.ccn - a.ccn || a.path.localeCompare(b.path));
  return {
    schema: 'falsify.production-ccn.v1', threshold, files: files.length,
    functions: functions.length, ccnTotal: functions.reduce((sum, fn) => sum + fn.ccn, 0),
    max: functions.reduce((max, fn) => Math.max(max, fn.ccn), 0),
    aboveThreshold: violations.length, errors, violations,
  };
}

function options(args) {
  const result = {threshold: 15, check: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') result.check = true;
    else if (args[i] === '--out') result.out = args[++i];
    else if (args[i] === '--threshold') result.threshold = Number(args[++i]);
    else throw Error(`Unknown argument: ${args[i]}`);
  }
  return result;
}

export function main(args = process.argv.slice(2)) {
  const config = options(args);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const result = inventory(root, config);
  if (config.out) writeFileSync(config.out, JSON.stringify(result, null, 2) + '\n');
  console.log(`Production CCN: ${result.files} files, ${result.functions} functions, max ${result.max}, >${result.threshold}: ${result.aboveThreshold}, parse errors: ${result.errors.length}`);
  if (result.errors.length || (config.check && result.aboveThreshold)) process.exitCode = 1;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

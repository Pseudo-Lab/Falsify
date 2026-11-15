import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as mupdf from 'mupdf';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {createLatexProject, exportLatexProject, importLatexProject, analyzeProjectFiles} from '../src/latex-project.mjs';
import {analyzeLatexSource} from '../src/latex-source-model.mjs';
import {resolveSourceProposals} from '../src/latex-semantic-edits.mjs';
import {applySourceChanges} from '../src/latex-source-patches.mjs';
import {createReconstructionProject} from '../src/pdf-latex-baseline.mjs';
import {readLayoutStructure, applyLayoutStructure, replaceLayoutUnitPayloads} from '../src/paper-layout-structure.mjs';
import {inspectLayoutQuality} from '../src/paper-layout-quality.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {setProjectTypography} from '../src/paper-layout-edit-tools.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

const enc = new TextEncoder(), dec = new TextDecoder();
const hash = 'b'.repeat(64);

test('arXiv-style multi-file ZIP with bbl fallback, local styles, natbib, macros and opt-in typography', async () => {
  const mainTex = [
    '\\documentclass{customvenue}',
    '\\usepackage{custommacros}',
    '\\usepackage{natbib}',
    '\\usepackage{fontspec}',
    '\\setmainfont{OldMain}',
    '\\setsansfont{KeepSans}',
    '\\newcommand{\\sysname}{HyperFlow}',
    '\\begin{document}',
    '\\input{sections/intro}',
    '\\bibliography{refs,appendix_refs}',
    '\\end{document}',
    ''
  ].join('\n');
  const introTex = [
    '\\section{Introduction}',
    'Our \\sysname{} pipeline improves accuracy \\citep[see][Table~2]{doe2024} under budget. {\\fontfamily{phv}\\selectfont Note.}',
    ''
  ].join('\n');
  const project = await createLatexProject({
    files: [
      {path: 'paper/main.tex', bytes: enc.encode(mainTex)},
      {path: 'paper/sections/intro.tex', bytes: enc.encode(introTex)},
      {path: 'paper/customvenue.cls', bytes: enc.encode('\\ProvidesClass{customvenue}\\LoadClass{article}')},
      {path: 'paper/custommacros.sty', bytes: enc.encode('\\ProvidesPackage{custommacros}\\usepackage{amsmath}')},
      {path: 'paper/main.bbl', bytes: enc.encode('\\begin{thebibliography}{1}\\bibitem{doe2024}Doe 2024\\end{thebibliography}')},
    ],
  });
  const zipped = await exportLatexProject(project);
  const imported = await importLatexProject({name: 'arxiv.zip', arrayBuffer: async () => zipped});
  assert.equal(imported.mainFile, 'paper/main.tex');

  const analysis = analyzeProjectFiles(imported);
  assert.deepEqual(analysis.missingFiles, []);
  assert.equal(analysis.projectAnalysis.bblFallback, true);
  assert.equal(analysis.projectAnalysis.citationPackage, 'natbib');
  assert.deepEqual(analysis.projectAnalysis.localClasses, ['paper/customvenue.cls']);
  assert.deepEqual(analysis.projectAnalysis.localPackages, ['paper/custommacros.sty']);
  assert.ok(analysis.projectAnalysis.customMacros.some(m => m.name === '\\sysname' && m.arity === 0));

  const model = analyzeLatexSource(imported);
  const resolved = resolveSourceProposals(imported, [
    {id: 'e1', path: 'paper/sections/intro.tex', before: 'Our HyperFlow pipeline improves accuracy under budget.', after: 'Our HyperFlow pipeline improves throughput under budget.'},
    {id: 'e2', path: 'paper/sections/intro.tex', before: 'Our HyperFlow pipeline improves accuracy under budget.', after: 'Our MetaFlow pipeline improves accuracy under budget.'},
  ], {model});
  assert.equal(resolved.proposals[0].status, 'matched');
  assert.equal(resolved.proposals[1].status, 'unresolved');
  const patched = await applySourceChanges(imported, resolved.proposals[0].sourceChanges);
  assert.equal(patched.diagnostics.length, 0);
  const patchedIntro = dec.decode(patched.project.files.find(f => f.path === 'paper/sections/intro.tex').bytes);
  assert.match(patchedIntro, /Our \\sysname\{\} pipeline improves throughput \\citep\[see\]\[Table~2\]\{doe2024\} under budget\./);

  const nonUnified = await setProjectTypography({project: patched.project, args: {family: 'Latin Modern Roman'}});
  const nonUnifiedMain = dec.decode(nonUnified.project.files.find(f => f.path === 'paper/main.tex').bytes);
  assert.match(nonUnifiedMain, /\\setsansfont\{KeepSans\}/);
  const unified = await setProjectTypography({project: patched.project, args: {family: 'Latin Modern Roman', unifyDocumentFont: true}});
  assert.match(dec.decode(unified.project.files.find(f => f.path === 'paper/main.tex').bytes), /\\setsansfont\{Latin Modern Roman\}/);
  assert.doesNotMatch(dec.decode(unified.project.files.find(f => f.path === 'paper/sections/intro.tex').bytes), /\\fontfamily\{phv\}/);
});

test('two-column multi-page footnote collision is detected and cleared after right and full-width reservation', async t => {
  if (spawnSync('lualatex', ['--version']).error || spawnSync('pdftotext', ['-v']).error) {
    t.skip('LuaLaTeX and pdftotext are required');
    return;
  }
  const ev = (pageIndex, bbox) => ({sourceSha256: hash, pageIndex, frame: 'mupdf-display', bbox});
  const bodySentence = 'Experimental validation confirms stable two-column pagination behavior across every block. ';
  const pages = [0, 1].map(pageIndex => ({
    pageIndex, width: 600, height: 800, frame: 'mupdf-display',
    extensions: {layoutHints: {columns: 2, gutterBp: [290, 310], status: 'proposed', provenance: 'paper-flow'}},
  }));
  const items = [
    {id: 'b0', kind: 'paragraph', status: 'observed', evidence: [ev(0, [40, 72, 280, 690])], text: 'Left col one. ' + bodySentence.repeat(32)},
    {id: 'b1', kind: 'paragraph', status: 'observed', evidence: [ev(0, [320, 72, 560, 720])], text: 'Right col one. ' + bodySentence.repeat(48)},
    {id: 'foot0r', kind: 'paragraph', status: 'observed', evidence: [ev(0, [320, 695, 560, 718])], text: 'FOOTNOTE-P1-RIGHT correspondence note'},
    {id: 'b2', kind: 'paragraph', status: 'observed', evidence: [ev(1, [40, 72, 280, 720])], text: 'Left col two. ' + bodySentence.repeat(36)},
    {id: 'b3', kind: 'paragraph', status: 'observed', evidence: [ev(1, [320, 72, 560, 720])], text: 'Right col two. ' + bodySentence.repeat(36)},
    {id: 'foot1full', kind: 'paragraph', status: 'observed', evidence: [ev(1, [40, 692, 560, 718])], text: 'FOOTNOTE-P2-FULL full-width copyright and reproduction notice spanning across page columns'},
  ];

  const initial = (await createReconstructionProject({sourceSha256: hash, model: {schema: 'falsify.pdf-latex-reconstruction.v1', sourceSha256: hash, pages, items, assets: [], relations: [], diagnostics: []}}, [], {layout: 'semantic-flow'})).project;
  const base = (await replaceLayoutUnitPayloads({
    project: initial,
    replacements: {
      foot0r: '{\\fontsize{8bp}{10bp}\\selectfont FOOTNOTE-P1-RIGHT correspondence note}\\par\n',
      foot1full: '{\\fontsize{8bp}{10bp}\\selectfont \\noindent\\rule{480bp}{0.4bp}\\\\\nFOOTNOTE-P2-FULL full-width copyright and reproduction notice spanning across page columns}\\par\n',
    },
  })).project;
  const s0 = readLayoutStructure(base);
  const plan = {...s0.plan, furniture: [{id: 'foot0r', placement: 'footer'}, {id: 'foot1full', placement: 'footer'}]};
  const reserved = await applyLayoutStructure({project: base, plan});
  const st = readLayoutStructure(reserved.project);
  assert.equal(st.bodyReservations.length, 2);
  assert.deepEqual(st.bodyReservations.map(r => [r.pageIndex, r.column]), [[0, 'right'], [1, 'full']]);

  const compile = (texSource, tag) => {
    const dir = mkdtempSync(join(tmpdir(), `falsify-${tag}-`));
    try {
      writeFileSync(join(dir, 'main.tex'), texSource);
      const res = spawnSync('lualatex', ['--disable-installer', '--no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'], {cwd: dir, encoding: 'utf8', timeout: 30000});
      assert.equal(res.status, 0, res.stdout?.slice(-2000));
      const pdfBytes = new Uint8Array(readFileSync(join(dir, 'main.pdf')));
      const ext = spawnSync('pdftotext', ['-bbox', 'main.pdf', 'out.html'], {cwd: dir, encoding: 'utf8'});
      assert.equal(ext.status, 0);
      const html = readFileSync(join(dir, 'out.html'), 'utf8');
      return {pdfBytes, html};
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  };

  const reservedTex = dec.decode(reserved.project.files.find(f => f.path === 'main.tex').bytes);
  // Simulate unreserved layout by stripping the emitted reservation hook
  const unreservedTex = reservedTex.replace(/\\makeatletter\\def\\FalsifyBodyReservations[\s\S]*?\\makeatother\n/, '');

  const unres = compile(unreservedTex, 't0158-unres');
  const qBefore = inspectLayoutQuality({bytes: unres.pdfBytes, mupdf, profile: {columnCount: 2}});
  const overBefore = qBefore.issues.filter(i => i.type === 'footnote-body-overlap');
  assert.ok(overBefore.some(i => i.pageIndex === 0 && i.evidence.column === 'right' && i.evidence.deltaBp > 0), JSON.stringify(overBefore));
  assert.ok(overBefore.some(i => i.pageIndex === 1 && i.evidence.column === 'full' && i.evidence.deltaBp > 0), JSON.stringify(overBefore));

  const resComp = compile(reservedTex, 't0158-res');
  const qAfter = inspectLayoutQuality({bytes: resComp.pdfBytes, mupdf, profile: {columnCount: 2}});
  const overAfter = qAfter.issues.filter(i => i.type === 'footnote-body-overlap');
  assert.equal(overAfter.length, 0, JSON.stringify(overAfter));

  const pageBlocks = resComp.html.match(/<page\b[\s\S]*?<\/page>/g) || [];
  assert.ok(pageBlocks.length >= 2);
  const foot1Y = Number(/<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>FOOTNOTE-P1-RIGHT<\/word>/.exec(pageBlocks[0])[1]);
  const rightWordsP1 = [...pageBlocks[0].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)"[^>]*>(?:Right|Experimental|validation|confirms)[^<]*<\/word>/g)]
    .filter(m => Number(m[1]) >= 290 && Number(m[2]) < foot1Y);
  assert.ok(rightWordsP1.length > 0);
  assert.ok(rightWordsP1.every(m => Number(m[3]) <= foot1Y + 1));

  // Verify checkRecomposition reports zero footnote-body-overlap after reservation and surfaces it when overlapping
  const expectedBlocks = [{id: 'doc', text: 'Placeholder'}];
  const compReportBefore = await checkRecomposition({bytes: unres.pdfBytes, expectedBlocks, edits: {doc: 'Placeholder'}, pdfjs, mupdf, layoutProfile: {columnCount: 2}});
  assert.ok(compReportBefore.findings.some(f => f.code === 'footnote-body-overlap' && f.pageIndex === 0 && f.column === 'right'));
  assert.ok(compReportBefore.findings.some(f => f.code === 'footnote-body-overlap' && f.pageIndex === 1 && f.column === 'full'));
  const compReportAfter = await checkRecomposition({bytes: resComp.pdfBytes, expectedBlocks, edits: {doc: 'Placeholder'}, pdfjs, mupdf, layoutProfile: {columnCount: 2}});
  assert.equal(compReportAfter.findings.filter(f => f.code === 'footnote-body-overlap').length, 0);
});

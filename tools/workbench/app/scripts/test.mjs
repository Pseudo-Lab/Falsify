import {spawnSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
// Browser harnesses require manual setup; font checks run separately in Pages CI.
const exemptions = new Map(Object.entries({
  'cleanup-browser.spec.cjs': 'manual browser harness',
  'document-blue-browser.spec.cjs': 'manual browser harness',
  'document-import-pdf.spec.cjs': 'manual browser harness',
  'document-import.spec.cjs': 'manual browser harness',
  'document-red-browser.spec.cjs': 'manual browser harness',
  'harness-ledger.spec.cjs': 'manual browser harness',
  'independent-runs.spec.cjs': 'manual browser harness',
  'ledger-import.spec.cjs': 'manual browser harness',
  'paper-navigation.spec.cjs': 'manual browser harness',
  'browser-fonts.spec.mjs': 'Pages font contracts',
  'browser-pdf-fonts.spec.mjs': 'Pages font contracts',
  'bundled-fonts.spec.mjs': 'Pages font contracts',
  'paragraph-fonts.spec.mjs': 'Pages font contracts',
}));
const discovered = readdirSync(new URL('../tests/', import.meta.url)).filter(f => /\.(?:spec|test)\.(?:mjs|cjs)$/.test(f));
const runnerSource = readFileSync(new URL(import.meta.url), 'utf8');
const registeredSource = runnerSource.slice(runnerSource.lastIndexOf('// BEGIN REGISTERED TESTS'));
const registered = new Set([...registeredSource.matchAll(/[\w.-]+\.(?:spec|test)\.(?:mjs|cjs)/g)].map(m => m[0]));
const ccn15Tests = discovered.filter(file => /^ccn15-(?:src|ui)-.+\.spec\.(?:mjs|cjs)$/.test(file));
for (const file of ccn15Tests) registered.add(file);
const missing = discovered.filter(f => !registered.has(f) && !exemptions.has(f));
const stale = [...exemptions.keys()].filter(f => !discovered.includes(f) || registered.has(f));
if (missing.length || stale.length) throw new Error(`Test registration mismatch: missing=${missing.join(', ')} stale exemptions=${stale.join(', ')}`);
if (process.argv.includes('--check-registration')) { console.log(`Test registration: ${discovered.length} discovered, ${exemptions.size} explicit exemptions`); process.exit(0); }
// BEGIN REGISTERED TESTS
if (ccn15Tests.length) {
  const result = spawnSync(process.execPath, ['--test', ...ccn15Tests.map(file => 'tests/' + file)], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const buildEquivalence = spawnSync(process.execPath, ['--test','tests/recomposition-build-equivalence.spec.mjs','tests/paper-visual-codec.spec.mjs','tests/w3-policy-observations.spec.mjs'], {stdio:'inherit'});
if(buildEquivalence.error || buildEquivalence.status!==0)process.exit(buildEquivalence.status||1);
const shape = spawnSync(process.execPath, ['--test','tests/chart-shape-core.spec.mjs','tests/chart-shape-editor.spec.mjs','tests/chart-mark-editor.spec.mjs'], {stdio:'inherit'});
if(shape.error || shape.status!==0)process.exit(shape.status||1);
const visual = spawnSync(process.execPath, ['--test','tests/paper-chart-redraw.spec.cjs','tests/paper-chart-correction-ui.spec.cjs','tests/paper-visual-edit-ui.spec.cjs','tests/paper-visual-integration.spec.cjs'], {stdio:'inherit'});
if(visual.error || visual.status!==0)process.exit(visual.status||1);
const plottracer = spawnSync(process.execPath, ['--test','tests/plottracer-vendor.spec.mjs','tests/paper-plottracer-ui.spec.cjs'], {stdio:'inherit'});
if(plottracer.error || plottracer.status!==0)process.exit(plottracer.status||1);
const paperEvidence = spawnSync(process.execPath, ['--test','tests/paper-evidence-transport.spec.cjs','tests/test_paper_evidence_ui.mjs','tests/paper-enrichment-ui.spec.cjs'], {stdio:'inherit'});
if(paperEvidence.error || paperEvidence.status!==0)process.exit(paperEvidence.status||1);
const latex = spawnSync(process.execPath, ['--test','tests/latex-source-project.spec.mjs','tests/latex-compiler.spec.mjs','tests/latex-semantic-edits.spec.mjs','tests/latex-session.spec.mjs','tests/latex-workbench.spec.mjs','tests/latex-session-archive.spec.mjs'], {stdio:'inherit'});
if(latex.error || latex.status!==0)process.exit(latex.status||1);
const runtime = spawnSync(process.execPath, ['--test','tests/latex-runtime-catalog.spec.mjs'], {stdio:'inherit'});
if(runtime.error || runtime.status!==0)process.exit(runtime.status||1);
const layoutAudit = spawnSync(process.execPath, ['--test','tests/latex-layout-audit.spec.mjs'], {stdio:'inherit'});
if(layoutAudit.error || layoutAudit.status!==0)process.exit(layoutAudit.status||1);
const layoutAgent = spawnSync(process.execPath, ['--test','tests/paper-layout-outcome.spec.mjs','tests/paper-layout-resume.spec.mjs','tests/paper-layout-run-store.spec.mjs','tests/latex-draft-store.spec.mjs','tests/paper-layout-preview.spec.mjs','tests/paper-layout-targets.spec.mjs','tests/paper-layout-reliability.spec.mjs','tests/paper-layout-agent.spec.mjs','tests/paper-layout-agent-ui.spec.mjs','tests/paper-layout-structure.spec.mjs','tests/paper-layout-toolkit.spec.mjs','tests/paper-layout-document-tools.spec.mjs','tests/paper-layout-pagination.spec.mjs','tests/paper-layout-edit-tools.spec.mjs','tests/paper-layout-asset-tools.spec.mjs','tests/paper-layout-region.spec.mjs','tests/layout-agent-skill.spec.mjs'], {stdio:'inherit'});
if(layoutAgent.error || layoutAgent.status!==0)process.exit(layoutAgent.status||1);
const reconstruction = spawnSync(process.execPath, ['--test','tests/browser-pdf-loader.spec.mjs','tests/pdf-latex-layout.spec.mjs','tests/pdf-latex-evidence.spec.mjs','tests/pdf-latex-regions.spec.mjs','tests/pdf-latex-serialize.spec.mjs','tests/pdf-latex-unicode.spec.mjs','tests/pdf-latex-baseline.spec.mjs','tests/pdf-latex-reader.spec.mjs','tests/pdf-latex-preview-lifecycle.spec.mjs','tests/latex-source-export.spec.mjs','tests/paper-typography-profile.spec.mjs','tests/pdf-latex-flow-serialize.spec.mjs','tests/pdf-latex-fonts.spec.mjs'], {stdio:'inherit'});
if(reconstruction.error || reconstruction.status!==0)process.exit(reconstruction.status||1);
const marker = spawnSync(process.execPath, ['--test','tests/paragraph-pdf-content-operators.spec.mjs','tests/paragraph-pdf-marker-surgery.spec.mjs','tests/paragraph-pdf-marker-path.spec.mjs'], {stdio:'inherit'});
if(marker.error || marker.status!==0)process.exit(marker.status||1);
for (const file of ['paragraph-quality-repair.spec.mjs', 'browser-pdf-crop-table.spec.mjs', 'table-crop-fit.spec.mjs', 'paper-structured-table.spec.mjs', 'paragraph-mixed-table-repair.spec.mjs', 'paragraph-ruled-table.spec.mjs', 'paragraph-fixed-font-regression.spec.mjs', 'paragraph-scale-prefix.spec.mjs', 'paragraph-reference-style.spec.mjs', 'paragraph-reference-expected.spec.mjs', 'paragraph-reference-link-proof.spec.mjs', 'paragraph-reference-style-integration.spec.mjs', 'paragraph-scale-prefix-integration.spec.mjs']) {
  const result = spawnSync(process.execPath, ['--test', 'tests/' + file], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const externalWorkflow = spawnSync(process.execPath, ['--test', 'tests/paper-anchors.test.cjs', 'tests/external-exchange.test.cjs', 'tests/external-proposals-b.spec.cjs', 'tests/external-exchange-ui.test.cjs', 'tests/external-archive.test.cjs', 'tests/paper-generation.spec.cjs', 'tests/paper-workspace-external-b.spec.cjs', 'tests/external-workflow.integration.test.cjs'], {stdio: 'inherit'});
if (externalWorkflow.error || externalWorkflow.status !== 0) process.exit(externalWorkflow.status || 1);
const marks = spawnSync(process.execPath, ['--test', 'tests/paper-change-marks.spec.cjs'], {stdio: 'inherit'});
if (marks.error || marks.status !== 0) process.exit(marks.status || 1);

for (const file of ['paper-academic-flow.spec.mjs', 'paper-layout-quality.spec.mjs', 'paper-sparse-evidence.spec.mjs', 'paper-float-ownership.spec.mjs', 'line-identity.spec.mjs', 'paper-output-profile.spec.mjs', 'paper-output-profile-pipeline.spec.mjs', 'paper-asset-spans.spec.mjs', 'paper-native-flow.spec.mjs', 'paper-caption-flow.spec.mjs', 'paper-caption-columns.spec.mjs', 'paper-caption-continuity.spec.mjs', 'paper-frontmatter-flow.spec.mjs', 'paper-crosspage-caption.spec.mjs', 'paper-figure-fit.spec.mjs', 'paper-layout-repair.spec.mjs', 'paper-keep-next.spec.mjs', 'paper-source-wrap.spec.mjs', 'paper-furniture-spacing.spec.mjs', 'paper-repeated-furniture.spec.mjs', 'paragraph-repair-error.spec.mjs', 'after-presence.spec.mjs', 'paragraph-column-flow.spec.mjs', 'paragraph-column-compaction.spec.mjs', 'paragraph-column-isolation.spec.mjs', 'paragraph-inline-markers.spec.mjs', 'paragraph-source-word-gaps.spec.mjs', 'paragraph-geometry-conservation.spec.mjs', 'paragraph-native-font-encoding.spec.mjs', 'paragraph-native-inline.spec.mjs', 'paragraph-composite-inline.spec.mjs', 'paragraph-horizontal-scale.spec.mjs', 'paragraph-edge-equivalence.spec.mjs', 'paragraph-link-transport.spec.mjs', 'paragraph-overlay-order.spec.mjs', 'paragraph-preserve-alignment.spec.mjs', 'paragraph-preserve-two-column.spec.mjs']) {
  const result = spawnSync(process.execPath, ['--test', 'tests/' + file], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

for (const file of ['recomposition-worker-startup.spec.mjs', 'attempt-ledger.spec.cjs', 'paper-compose.spec.mjs', 'paper-document-layout.spec.mjs', 'paper-document.spec.mjs', 'paper-flow.spec.mjs', 'paper-fonts.spec.mjs', 'paper-furniture.spec.mjs', 'paper-link-plan.spec.mjs', 'paper-recompose-runtime.spec.mjs', 'paper-recompose.spec.mjs', 'paper-source-assets.spec.mjs', 'paper-source-glyphs.spec.mjs', 'paper-source-links.spec.mjs', 'paper-source-spacing.spec.mjs', 'recomposition-check.spec.mjs', 'paragraph-object-lifecycle.spec.mjs', 'paragraph-matching.spec.mjs', 'quote-integrity.spec.mjs', 'paragraph-pdf-binding.spec.mjs', 'blind-pdf.spec.mjs', 'red-direct-batch.spec.cjs', 'red-direct-click.spec.cjs', 'document-odt-export.spec.cjs', 'document-html-export.spec.cjs', 'document-docx-export.spec.cjs', 'harness-comparison.spec.cjs', 'blue-visual-input.spec.mjs', 'blue-visual-reference.spec.cjs', 'document-red.spec.cjs', 'document-blue.spec.cjs', 'harness-core.spec.cjs', 'harness-wrapper.spec.cjs', 'harness-profile.spec.cjs', 'cleanup-static.spec.cjs', 'local-bridge.spec.cjs', 'red-binding.spec.cjs', 'cli-selection.spec.cjs', 'ledger-provenance.spec.cjs', 'cloud-records-core.spec.mjs', 'review-bundle.spec.mjs', 'confluence-store.spec.cjs', 'cloud-ledger-hooks.spec.cjs', 'cloud-records-ui.spec.cjs', 'account-password.spec.cjs', 'pending-job-recovery.spec.cjs', 'editor-export.spec.cjs', 'quality-reread.spec.cjs', 'pdf-preview.spec.cjs', 'paper-analysis.spec.cjs', 'image-editor.spec.cjs', 'paper-edits.spec.cjs', 'external-red.spec.cjs', 'external-red-ui.spec.cjs', 'paper-manual-records.spec.cjs', 'auto-pair.spec.cjs', 'paper-workspace.spec.cjs', 'browser-pdf.spec.mjs', 'paragraph-pdf.spec.mjs', 'annotation-transport.spec.mjs', 'table-adapter.spec.mjs', 'table-worker.spec.mjs', 'pdf-edit-pipeline.spec.mjs', 'guide.spec.cjs']) {
  const result = spawnSync(process.execPath, ['tests/' + file], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

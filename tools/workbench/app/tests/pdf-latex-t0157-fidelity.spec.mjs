import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import * as mupdf from 'mupdf';

import {calibrateFontLineFit, resolveFlowFontFamily} from '../src/pdf-latex-fonts.mjs';
import {orderFloatUnits, planReconstructionLayout} from '../src/pdf-latex-layout.mjs';
import {prepareReconstruction} from '../src/pdf-latex-baseline.mjs';
import {enrichReconstructionRegions} from '../src/pdf-latex-regions.mjs';
import {serializeReconstruction} from '../src/pdf-latex-serialize.mjs';
import {serializeFlowReconstruction} from '../src/pdf-latex-flow-serialize.mjs';
import {analyzeLatexSource} from '../src/latex-source-model.mjs';
import {validateTableGrid} from '../src/pdf-latex-tables.mjs';

const SHA = 'a'.repeat(64);
const ev = (pageIndex, bbox) => [{sourceSha256: SHA, pageIndex, frame: 'mupdf-display', bbox}];

function makeBaseModel({items = [], relations = [], pages = null, width = 612, height = 792} = {}) {
  return {
    schema: 'falsify.pdf-latex-reconstruction.v1',
    sourceSha256: SHA,
    pages: pages || [{pageIndex: 0, width, height, frame: 'mupdf-display', transform: [1, 0, 0, -1, 0, height]}],
    items,
    assets: [],
    relations,
    diagnostics: []
  };
}

function makeBaseProfile(columns = 1, extra = {}) {
  return {
    schema: 'falsify.paper-typography.v1',
    page: {
      columns,
      widthBp: 612,
      heightBp: 792,
      gutterBp: 18,
      margins: {left: 54, right: 54, top: 54, bottom: 54}
    },
    fonts: {serif: 'Latin Modern Roman'},
    body: {indentEm: 1, paragraphGapEm: 0.4},
    roles: {
      body: {sizeBp: 10, leadingBp: 12},
      heading: {sizeBp: 12, leadingBp: 14},
      caption: {sizeBp: 9, leadingBp: 11},
      footnote: {sizeBp: 8, leadingBp: 10}
    },
    packages: {needspace: false, luaWidowControl: false},
    diagnostics: [],
    ...extra
  };
}

function hasBinary(cmd) {
  const res = spawnSync(cmd, ['--version'], {encoding: 'utf8'});
  return res.status === 0;
}

function compileLatex(engine, texSource) {
  const dir = mkdtempSync(join(tmpdir(), 'falsify-t0157-'));
  try {
    writeFileSync(join(dir, 'main.tex'), texSource, 'utf8');
    const res = spawnSync(engine, ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000
    });
    return {status: res.status, stdout: res.stdout || '', stderr: res.stderr || ''};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('T-0157 Spec 1: figure numeric ordering fixes 2-before-1 and 10-before-2 inversions while separating S1 supplements and preserving bindings', () => {
  const items = [
    {id: 'intro', kind: 'paragraph', text: 'Introduction text.', status: 'observed', evidence: ev(0, [54, 100, 280, 130])},
    {id: 'cap10', kind: 'caption', text: 'Figure 10. Tenth result.', status: 'observed', evidence: ev(0, [54, 150, 280, 170])},
    {id: 'fig10', kind: 'figure', text: '[Fig 10 placeholder]', status: 'observed', evidence: ev(0, [54, 175, 280, 240])},
    {id: 'cap2', kind: 'caption', text: 'Figure 2. Second result.', status: 'observed', evidence: ev(0, [54, 260, 280, 280])},
    {id: 'fig2', kind: 'figure', text: '[Fig 2 placeholder]', status: 'observed', evidence: ev(0, [54, 285, 280, 340])},
    {id: 'cap1', kind: 'caption', text: 'Figure 1. First result.', status: 'observed', evidence: ev(0, [310, 150, 550, 170])},
    {id: 'fig1', kind: 'figure', text: '[Fig 1 placeholder]', status: 'observed', evidence: ev(0, [310, 175, 550, 240])},
    {id: 'caps2', kind: 'caption', text: 'Figure S2. Supplement two.', status: 'observed', evidence: ev(0, [310, 260, 550, 280])},
    {id: 'caps1', kind: 'caption', text: 'Figure S1. Supplement one.', status: 'observed', evidence: ev(0, [310, 300, 550, 320])},
    {id: 'tab_ii', kind: 'caption', text: 'Table II. Second Roman table.', status: 'observed', evidence: ev(0, [54, 400, 280, 420])},
    {id: 'tab_i', kind: 'caption', text: 'Table I. First Roman table.', status: 'observed', evidence: ev(0, [54, 430, 280, 450])}
  ];
  const relations = [
    {kind: 'caption', status: 'confirmed', from: 'fig10', to: 'cap10', evidence: [...items[2].evidence, ...items[1].evidence]},
    {kind: 'caption', status: 'confirmed', from: 'fig2', to: 'cap2', evidence: [...items[4].evidence, ...items[3].evidence]},
    {kind: 'caption', status: 'confirmed', from: 'fig1', to: 'cap1', evidence: [...items[6].evidence, ...items[5].evidence]}
  ];

  // Check unit-level orderFloatUnits with paired groups
  const {reordered} = orderFloatUnits([items[0], items[1], items[2], items[3], items[4], items[5], items[6]], new Map([['fig10', 'cap10'], ['fig2', 'cap2'], ['fig1', 'cap1']]));
  assert.ok(reordered > 0);

  // Check source planReconstructionLayout emits FLOAT_ORDER_INVERSION
  const layout = planReconstructionLayout(makeBaseModel({items}));
  assert.ok(layout.diagnostics.some(d => d.code === 'FLOAT_ORDER_INVERSION'));

  // Check flow serializer preserves paired caption/figure groups in numeric order and exact bindings
  const flow = serializeFlowReconstruction({
    model: makeBaseModel({items, relations}),
    profile: makeBaseProfile(1)
  });
  const captionIds = flow.structure.plan.order.filter(id => items.find(x => x.id === id)?.kind === 'caption');
  assert.deepEqual(captionIds, ['cap1', 'cap2', 'cap10', 'caps1', 'caps2', 'tab_i', 'tab_ii']);
  const tex = new TextDecoder().decode(flow.files[0].bytes);
  const idx1 = tex.indexOf('Figure 1. First result.');
  const idx2 = tex.indexOf('Figure 2. Second result.');
  const idx10 = tex.indexOf('Figure 10. Tenth result.');
  const idxS1 = tex.indexOf('Figure S1. Supplement one.');
  const idxS2 = tex.indexOf('Figure S2. Supplement two.');
  assert.ok(idx1 > 0 && idx1 < idx2 && idx2 < idx10);
  assert.ok(idx10 < idxS1 && idxS1 < idxS2);

  for (const b of flow.bindings) {
    const expectedText = items.find(x => x.id === b.itemId).text;
    assert.ok(tex.slice(b.start, b.end).includes(expectedText.replace(/[\[\]]/g, m => m)));
  }
});

test('T-0157 Spec 2: bibliography entries split cleanly across both serializers without splitting body citations', () => {
  const items = [
    {
      id: 'prose',
      kind: 'paragraph',
      text: 'As shown in prior work, see [1] and [2] for empirical bounds. Also compare Section 1. Overview and 2. Setup.',
      status: 'observed',
      evidence: ev(0, [54, 100, 550, 140])
    },
    {
      id: 'ref_hdr',
      kind: 'heading',
      text: 'References',
      status: 'observed',
      evidence: ev(0, [54, 160, 200, 180]),
      extensions: {publicationRole: 'section-heading'}
    },
    {
      id: 'bib_bracket',
      kind: 'paragraph',
      text: '[1] Ada Lovelace, Note on the Analytical Engine, 1843. [2] Alan Turing, On Computable Numbers, Proc. LMS, 1936.',
      status: 'observed',
      evidence: ev(0, [54, 190, 550, 230]),
      extensions: {
        inlineRuns: [
          {start: 0, end: 18, italic: false},
          {start: 18, end: 47, italic: true},
          {start: 47, end: 111, italic: false}
        ]
      }
    },
    {
      id: 'bib_num',
      kind: 'paragraph',
      text: '1. Shannon, C. E. A Mathematical Theory of Communication (1948). 2. Hamming, R. W. Error Detecting Codes (1950).',
      status: 'observed',
      evidence: ev(0, [54, 240, 550, 280])
    },
    {
      id: 'bib_doi',
      kind: 'paragraph',
      text: 'Smith, J. Quantum Bounds in Practice. doi:10.1000/qbp.1. Jones, M. Classical Comparisons. https://doi.org/10.1000/cc.2.',
      status: 'observed',
      evidence: ev(0, [54, 290, 550, 330])
    },
    {
      id: 'app_hdr',
      kind: 'heading',
      text: 'Appendix A Proofs',
      status: 'observed',
      evidence: ev(0, [54, 350, 250, 370]),
      extensions: {publicationRole: 'section-heading'}
    },
    {
      id: 'app_body',
      kind: 'paragraph',
      text: 'Returning to [1] and [2] inside normal appendix text does not trigger splits.',
      status: 'observed',
      evidence: ev(0, [54, 380, 550, 410])
    }
  ];

  const flowOut = serializeFlowReconstruction({model: makeBaseModel({items}), profile: makeBaseProfile(1)});
  const srcOut = serializeReconstruction({model: makeBaseModel({items})});
  for (const out of [flowOut, srcOut]) {
    const tex = new TextDecoder().decode(out.files[0].bytes);
    // Body prose before References and Appendix after References must NOT split before [2]
    assert.ok(tex.includes('see [1] and [2] for empirical bounds'));
    assert.ok(tex.includes('Returning to [1] and [2] inside normal appendix text'));
    // Merged entries under References MUST be separated via \par\noindent
    assert.match(tex, /1843\.\s*\\par\\noindent\s+\[2\] Alan Turing/);
    assert.match(tex, /\(1948\)\.\s*\\par\\noindent\s+2\. Hamming/);
    assert.match(tex, /doi:10\.1000\/qbp\.1\.\s*\\par\\noindent\s+Jones, M\./);
    const bibBinding = out.bindings.find(b => b.itemId === 'bib_bracket');
    assert.ok(bibBinding && tex.slice(bibBinding.start, bibBinding.end).includes('[2] Alan Turing'));
  }
  const flowTex = new TextDecoder().decode(flowOut.files[0].bytes);
  assert.ok(flowTex.includes('\\textit{Note on the Analytical Engine}'));
});

test('T-0157 Spec 3a: verified ruled PDF with colSpan>1 and rowSpan>1 extracts, serializes with conditional multirow, and compiles cleanly', async () => {
  // Construct a synthetic 3-column, 4-row ruled PDF where row 0 spans cols 0..1 (colSpan=2)
  // and col 0 rows 1..2 have no internal horizontal rule (rowSpan=2).
  const doc = new mupdf.PDFDocument();
  const pdfY = dy => 792 - dy;
  const lines = [
    [60, 100, 360, 100], [60, 125, 360, 125], [160, 150, 360, 150], [60, 175, 360, 175], [60, 200, 360, 200],
    [60, 100, 60, 200], [160, 125, 160, 200], [260, 100, 260, 200], [360, 100, 360, 200]
  ];
  const drawCmds = lines.map(([x0, y0, x1, y1]) => `${x0} ${pdfY(y0)} m ${x1} ${pdfY(y1)} l S`).join('\n');
  const texts = [
    [120, 115, 'Combined AB'], [290, 115, 'Metric C'],
    [85, 152, 'RowSpan2'], [185, 140, '10.1'], [285, 140, '20.2'],
    [185, 165, '11.3'], [285, 165, '21.4'],
    [85, 190, 'Single'], [185, 190, '12.5'], [285, 190, '22.6']
  ];
  const textCmds = texts.map(([x, y, s]) => `BT /F1 9 Tf ${x} ${pdfY(y)} Td (${s}) Tj ET`).join('\n');
  const contentStream = `1 w 0 0 0 RG\n${drawCmds}\n${textCmds}\n`;
  const fontRef = doc.addObject({Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica'});
  const resources = doc.addObject({Font: {F1: fontRef}});
  const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, contentStream);
  doc.insertPage(-1, pageObj);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  const base = await prepareReconstruction({file: new Blob([bytes], {type: 'application/pdf'}), revision: 'rev-1'});
  const regionOut = await enrichReconstructionRegions({bytes, mupdf, model: base.model, revision: 'rev-1'});
  const tableItem = regionOut.items.find(i => i.kind === 'table' && i.table?.rows);
  assert.ok(tableItem?.table?.rows?.length === 4, 'Ruled merged PDF table must extract structured 4-row grid');
  assert.equal(tableItem.table.rows[0][0].colSpan, 2);
  assert.equal(tableItem.table.rows[0][0].text, 'Combined AB');
  assert.equal(tableItem.table.rows[1][0].rowSpan, 2);
  assert.equal(tableItem.table.rows[1][0].text, 'RowSpan2');

  // Verify validation rejects overlapping/gap spans (width mismatch or rowSpan collision)
  assert.equal(validateTableGrid([
    [{text: 'a', colSpan: 2, evidence: ev(0, [60, 100, 180, 130])}, {text: 'b', evidence: ev(0, [180, 100, 300, 130])}],
    [{text: 'c', evidence: ev(0, [60, 130, 180, 160])}, {text: 'd', evidence: ev(0, [180, 130, 300, 160])}]
  ], () => true).valid, false);
  assert.equal(validateTableGrid([
    [{text: 'a', rowSpan: 2, evidence: ev(0, [60, 100, 180, 160])}, {text: 'b', evidence: ev(0, [180, 100, 300, 130])}],
    [{text: 'c', evidence: ev(0, [60, 130, 180, 160])}, {text: 'd', evidence: ev(0, [180, 130, 300, 160])}]
  ], () => true).valid, false);
  assert.throws(() => serializeFlowReconstruction({
    model: makeBaseModel({
      items: [{
        id: 'bad',
        kind: 'table',
        status: 'observed',
        evidence: ev(0, [60, 100, 300, 160]),
        table: {
          rows: [
            [{text: 'A', colSpan: 2, evidence: ev(0, [60, 100, 180, 130])}, {text: 'B', evidence: ev(0, [180, 100, 300, 130])}],
            [{text: 'C', evidence: ev(0, [60, 130, 180, 160])}, {text: 'D', evidence: ev(0, [180, 130, 300, 160])}]
          ]
        }
      }]
    }),
    profile: makeBaseProfile(1)
  }), {code: 'INVALID_TABLE'});

  // Verify preamble omits multirow when rowSpan === 1 only, and emits multirow when rowSpan > 1
  const colOnlyOut = serializeFlowReconstruction({
    model: makeBaseModel({
      items: [{
        id: 't_col',
        kind: 'table',
        status: 'observed',
        evidence: ev(0, [60, 100, 300, 160]),
        table: {
          rows: [
            [{text: 'Merged', colSpan: 2, evidence: ev(0, [60, 100, 300, 130])}],
            [{text: 'Left', evidence: ev(0, [60, 130, 180, 160])}, {text: 'Right', evidence: ev(0, [180, 130, 300, 160])}]
          ]
        }
      }]
    }),
    profile: makeBaseProfile(1)
  });
  const colOnlyTex = new TextDecoder().decode(colOnlyOut.files[0].bytes);
  assert.ok(colOnlyTex.includes('\\multicolumn{2}{l}{Merged}'));
  assert.ok(!colOnlyTex.includes('multirow'));

  // Serialize extracted colSpan+rowSpan table in both flow & source serializers and check conditional multirow
  const mergedFlow = serializeFlowReconstruction({model: regionOut, profile: makeBaseProfile(1)});
  const mergedTex = new TextDecoder().decode(mergedFlow.files[0].bytes);
  assert.ok(mergedTex.includes('\\usepackage{multirow}'));
  assert.ok(mergedTex.includes('\\multicolumn{2}{l}{Combined AB}'));
  assert.ok(mergedTex.includes('\\multirow{2}{*}{RowSpan2}'));
  assert.ok(mergedTex.includes('& 11.3 & 21.4 \\\\'));

  const mergedSrc = serializeReconstruction({model: regionOut});
  const mergedSrcTex = new TextDecoder().decode(mergedSrc.files[0].bytes);
  assert.ok(mergedSrcTex.includes('\\usepackage{multirow}'));
  assert.ok(mergedSrcTex.includes('\\multicolumn{2}{l}{Combined AB}'));
  assert.ok(mergedSrcTex.includes('\\multirow{2}{*}{RowSpan2}'));

  if (hasBinary('lualatex')) {
    const res = compileLatex('lualatex', mergedTex);
    assert.equal(res.status, 0, `lualatex failed:\n${res.stdout}\n${res.stderr}`);
  }
});

test('T-0157 Spec 3b: two-column wide tables use table*/resizebox and tall tables split into breakable chunks without losing rows', () => {
  const twoColPage = [{
    pageIndex: 0,
    width: 612,
    height: 792,
    frame: 'mupdf-display',
    extensions: {layoutHints: {status: 'proposed', provenance: 'paper-flow', columns: 2, gutterBp: [297, 315]}}
  }];
  const longHeader = Array.from({length: 6}, (_, k) => ({
    text: `MeasurementColumn_${k}_WideHeader`,
    evidence: ev(0, [54 + k * 40, 200, 90 + k * 40, 215])
  }));
  const makeRow = r => Array.from({length: 6}, (_, k) => ({
    text: `Val_${r}_${k}_LongEntry`,
    evidence: ev(0, [54 + k * 40, 220 + (r % 20) * 14, 90 + k * 40, 232 + (r % 20) * 14])
  }));

  const items = [
    {id: 'p_left', kind: 'paragraph', text: 'Left column body.', status: 'observed', evidence: ev(0, [54, 120, 290, 150])},
    {id: 'p_right', kind: 'paragraph', text: 'Right column body.', status: 'observed', evidence: ev(0, [320, 120, 558, 150])},
    {
      id: 't_wide_span',
      kind: 'table',
      status: 'observed',
      evidence: ev(0, [54, 180, 558, 260]),
      extensions: {span: 'page'},
      table: {
        rows: [longHeader.map(c => ({text: c.text + '_VeryWideExtraHeadingName', evidence: ev(0, [54, 180, 558, 200])})), makeRow(1)]
      }
    },
    {
      id: 't_narrow_tall',
      kind: 'table',
      status: 'observed',
      evidence: ev(0, [54, 280, 290, 760]),
      table: {
        rows: [longHeader, ...Array.from({length: 65}, (_, r) => makeRow(r + 1))]
      }
    }
  ];

  const out = serializeFlowReconstruction({
    model: makeBaseModel({items, pages: twoColPage}),
    profile: makeBaseProfile(2)
  });
  const tex = new TextDecoder().decode(out.files[0].bytes);
  assert.ok(tex.includes('\\begin{table*}[htbp]'));
  assert.ok(tex.includes('\\resizebox{\\textwidth}{!}{'));
  assert.ok(tex.includes('\\resizebox{\\columnwidth}{!}{'));
  // Tall table splits into multiple tabular chunks retaining the last row instead of clipping
  assert.ok((tex.match(/\\begin\{tabular\}/g) || []).length >= 3);
  assert.ok(tex.includes('Val\\_65\\_5\\_LongEntry'));
  assert.ok(tex.includes('\\par\\medskip'));
});

test('T-0157 Spec 4: opt-in font family guard and calibrated line-fit prevent expansion without corrupting glyphs or analyzeLatexSource text', () => {
  // Whole-document font family override remains strictly opt-in
  assert.equal(resolveFlowFontFamily({fonts: {serif: 'TeX Gyre Termes'}}, new Map()), null);
  assert.throws(() => serializeFlowReconstruction({
    model: makeBaseModel({items: [{id: 'p1', kind: 'paragraph', text: 'Hello.', status: 'observed', evidence: ev(0, [54, 100, 300, 120])}]}),
    profile: makeBaseProfile(1, {fonts: {serif: 'TeX Gyre Termes'}})
  }), {code: 'INVALID_FONT'});

  const optInFont = resolveFlowFontFamily({fonts: {serif: 'TeX Gyre Termes', allowOverride: true}}, new Map());
  assert.deepEqual(optInFont, {customFiles: false, family: 'TeX Gyre Termes', overridden: true});

  // Short sparse document should NOT auto-apply line fit unless explicitly opted in
  const sparseModel = makeBaseModel({
    items: [{id: 'p0', kind: 'paragraph', text: 'Short paragraph.', status: 'observed', evidence: ev(0, [54, 100, 300, 120])}]
  });
  assert.equal(calibrateFontLineFit(sparseModel, makeBaseProfile(1)).applied, false);
  assert.equal(calibrateFontLineFit(sparseModel, makeBaseProfile(1, {lineFit: true})).applied, true);

  // Dense multi-paragraph model whose measured char width (~0.425em) is narrower than Latin Modern Roman (0.48em)
  const sampleSentence = 'Experimental measurements in dense academic typography show consistent character counts per column width across consecutive lines. ';
  const denseParaText = sampleSentence.repeat(4); // ~528 chars across 10 source lines in width 240bp at 10bp font -> (240 * 9.55) / (528 * 10) = 0.434em
  const denseItems = Array.from({length: 14}, (_, idx) => ({
    id: `dp_${idx}`,
    kind: 'paragraph',
    text: `Paragraph ${idx + 1}: ${denseParaText}`,
    status: 'observed',
    evidence: ev(idx < 7 ? 0 : 1, [54, 90 + (idx % 7) * 90, 294, 175 + (idx % 7) * 90]),
    extensions: {lineCount: 10, typography: {fontSizeBp: 10, leadingBp: 12}}
  }));
  const denseModel = makeBaseModel({
    items: denseItems,
    pages: [{pageIndex: 0, width: 612, height: 792, frame: 'mupdf-display'}, {pageIndex: 1, width: 612, height: 792, frame: 'mupdf-display'}]
  });

  const calibrated = calibrateFontLineFit(denseModel, makeBaseProfile(1));
  assert.equal(calibrated.applied, true);
  assert.ok(calibrated.wordSpaceScale < 1 && calibrated.horizontalScale < 1 && calibrated.emergencystretchBp > 0);

  const flowFit = serializeFlowReconstruction({model: denseModel, profile: makeBaseProfile(1)});
  const texFit = new TextDecoder().decode(flowFit.files[0].bytes);
  assert.ok(texFit.includes('WordSpace={'));
  assert.ok(texFit.includes('FakeStretch='));
  assert.ok(texFit.includes('\\setlength{\\emergencystretch}{'));
  assert.ok(texFit.includes('\\newcommand{\\FalsifyLineFit}{\\fontdimen2\\font='));
  assert.ok(texFit.includes('\\FalsifyLineFit '));

  // Source model text extraction must NOT leak \FalsifyLineFit control code into displayText
  const analyzed = analyzeLatexSource({id: 'proj-t0157', files: flowFit.files});
  const displayJoined = analyzed.nodes.map(n => n.displayText).join(' ');
  assert.ok(displayJoined.includes('Experimental measurements'));
  assert.ok(!displayJoined.includes('FalsifyLineFit'));
  assert.ok(!displayJoined.includes('fontdimen'));

  if (hasBinary('lualatex')) {
    const res = compileLatex('lualatex', texFit);
    assert.equal(res.status, 0, `lualatex line-fit failed:\n${res.stdout}\n${res.stderr}`);
  }
});

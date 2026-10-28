import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const app = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({ entryPoints: [app + "/src/paragraph-vendor/editor.mjs"], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "browser-runtime", setup(b) {
    b.onResolve({ filter: /^\.\/runtime\.mjs$/ }, () => ({ path: app + "/src/paragraph-pdf-runtime.mjs" }));
    b.onResolve({ filter: /engine-loader\.js$/ }, () => ({ path: app + "/src/paragraph-pdf-engine-loader.mjs" }));
  } }] });
const { editPdf } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));

for (const [pageIndex, codes, reason] of [
  [4, ["pagination_unsupported_edge_paragraph_in_flow"], "페이지 경계의 문단"],
  [9, ["pagination_unsupported_multi_column_flow"], "여러 단으로 된 본문"],
  [0, ["unknown_failure", "pagination_unsupported_multi_column_flow"], "안전하게 복구할 수 없습니다"],
]) {
  test(`repair errors show PDF page ${pageIndex + 1} and retain diagnostics`, async () => {
    const para = { id: 1, runs: [{ text: "Original text", font: "Helvetica" }], lines: [], format: {} };
    let closed = false;
    const engine = {
      pageCount: 10, loadPage() {}, normalizeFontsForEdit() {},
      buildModel: () => [para], pageRegenHostile: () => false,
      commitParagraph: () => ({ id: 1, surgical: true }),
      close: () => { closed = true; },
    };
    const quality = {
      capturePageLayout: () => ({}),
      repairPageLayout: () => ({ warnings: codes.map(code => ({ code, severity: "error" })) }),
      inspectSavedPdf: () => { throw new Error("must not inspect failed repair"); },
    };
    await assert.rejects(editPdf({ sourceBytes: new Uint8Array([1]), reflow: true,
      edits: [{ id: "edit", pageIndex, before: "Original text", after: "Replacement text" }] },
      { engineFactory: async () => engine, quality }), error => {
        assert.equal(error.code, codes.some(code => code.includes("unsupported")) ? "LAYOUT_UNSUPPORTED" : "REPAIR_FAILED");
        assert.match(error.message, new RegExp(`PDF ${pageIndex + 1}쪽`));
        assert.ok(error.message.includes(reason));
        assert.deepEqual(error.details, { pageIndex, codes, count: codes.length });
        assert.equal(error.report.ok, false);
        return true;
      });
    assert.equal(closed, true);
  });
}

test('continuation column reaches the saved-file check and public page map', async () => {
  const para = { id: 1, runs: [{ text: 'Original text', font: 'Helvetica' }], lines: [], format: {} };
  const column = { x0: 300, x1: 550 };
  const engine = { pageCount: 1, loadPage() {}, normalizeFontsForEdit() {}, buildModel: () => [para],
    pageRegenHostile: () => false, commitParagraph: () => ({ id: 1, surgical: true }),
    save: () => new Uint8Array([1, 2]), close() {} };
  let checkedMap;
  const quality = { capturePageLayout: () => ({}),
    repairPageLayout: () => ({ pagination: { added: 1, lineCounts: [1], keptLines: 1, bodyTop: 700, floor: 50, flowColumn: column } }),
    inspectSavedPdf: (_factory, _source, _pdf, _edits, options) => { checkedMap = options.sourcePageMap; return { ok: true }; } };
  const { report } = await editPdf({ sourceBytes: new Uint8Array([1]), reflow: true,
    edits: [{ id: 'edit', pageIndex: 0, before: 'Original text', after: 'Replacement text' }] },
    { engineFactory: async () => engine, quality });
  assert.deepEqual(report.pagination.sourcePageMap[0].flowColumn, column);
  assert.deepEqual(checkedMap[0].flowColumn, column);
  assert.notEqual(report.pagination.sourcePageMap[0].flowColumn, column);
});

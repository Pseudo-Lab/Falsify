# Table adapter integration contract

```js
import {detectSourceTables, selectTableCell} from './table-adapter.mjs';
const model = await detectSourceTables({
  sourceBytes, sourceSha256, revision, mupdf: existingMuPdfModule,
});
const selected = selectTableCell(model, {
  tableId, cellId, sourceSha256, revision,
});
if (selected.status === 'ready') {
  // Human chooses after explicitly. Existing writer independently relocates
  // and validates the quote/anchor in source bytes, then performs its checks.
  const edit = {
    id: selected.cellId, pageIndex: selected.pageIndex,
    before: selected.before, after: humanAfter, anchor: selected.anchor,
  };
}
```

No engine is imported by the adapter. Pass the existing pinned MuPDF ESM to
the worker. Its default reader opens the exact hash-verified bytes and returns
structured-text runs and native straight stroked rules. It does not run OCR,
render scanned tables into editable objects, or write PDFs. All returned
tables have `authority: structure-hint`; hashing bytes alone never authenticates
externally supplied geometry. The optional `readPages(bytes)` is a **trusted
engine adapter callback**, not UI-supplied JSON, for PDFium integration. It must
read the supplied private copy and return pages indexed consecutively, each
with `coordinateSpace:'top-left-page', width,height,rotation,runs,rules`.
Run shape is `{id,text,bbox:[x0,y0,x1,y1],horizontal?:boolean}`; rules are
`{bbox}`. IDs are unique per page. Optional page `chars` is in source extraction
order with `{c,bbox,lineId}`; retain exact source text, not display substitutes.

`model.tables[]` has stable source+revision-derived `id,pageIndex,bbox,rows,cols,
ruled,confidence,cells`. Each cell has `id,row,col,rowSpan,colSpan,bbox,runIds`.
All boxes are top-left/y-down/page-view points. Revision is a nonempty string
controlled by the caller; change it on any source/editor revision. Table/cell
IDs, source hash, and revision must all match at selection. Changing the source
invalidates the model. Keep the model object in its worker: serialized copies
cannot be passed back to `selectTableCell` as verified models. A worker can keep
it until selection, or inspect/select then terminate; do not terminate between
inspection and selection and expect to reconstruct the private issued identity.

Ready selections return exact `before`, tight **run glyph bbox** in `anchor`,
separate `cellBbox` for overlay, pageIndex, runIds, source hash and revision.
No occurrence ordinal is guessed. Multi-run/empty/overlapping/ambiguous cells,
rotations and uncertain cell bounds are refused. This is more conservative
than upstream recognition: unruled candidates need at least three rows and
two numeric cells, so normal aligned two-column prose is rejected. Text-only
borderless tables and sparse merged headers may be missed. Detector spans do
not authorize object ownership or grid rewriting.

Selection scans all source quote matches, applies the tight anchor, and stops
at two surviving matches to report true ambiguity. It never chooses an ordinal
from table order. The coordinator repaired the writer's earlier eight-hit cap;
the real 12-repeated-number regression edits the last cell through that rebuilt
writer and verifies the other eleven numbers remain unchanged.

Tests: `node --test app/tests/table-adapter.spec.mjs`. Tests use the current checkout's installed MuPDF and built browser writer.
An isolated worktree may set `FALSIFY_TEST_WORKBENCH` to an existing checkout
with the same pinned dependencies and candidate browser writer. No package,
build, UI, index or global test files were modified. Tests use synthetic PDFs
and source snapshots only. Current evidence is same-engine extraction/write
and original-byte/control-text preservation, not independent pixel/scientific
verification or paragraph reflow. Engine-native materialization is bounded by
counts/worker lifetime, not an OS memory sandbox.

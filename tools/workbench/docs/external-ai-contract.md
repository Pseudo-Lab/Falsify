# External AI workflow module contract

2026-10-28 S0. This is an implementation interface for the assigned work, not a project-wide agent instruction. Classic UMD modules; keep current editor/PDF engines and existing JSON inputs working. No dependency additions are planned.

## Normalized external response

`FalsifyExternalExchange.parse(raw, {role, segments, fileHash, model?, prompt?, harness?, requestId?})` returns a JSON-safe batch:

```
{schema:'falsify.external-batch.v1', id, role:'red'|'blue', fileHash,
 raw, importedAt, model?, prompt?, harness?, status:'ok'|'abstain'|'refusal'|'unparsed',
 items:[{id, kind:'change'|'finding', before?, after?, quote?, rationale:'',
         evidence:[], references:[], attackTypes:[], uncertainty:'',
         segmentId:null|string, pageIndex:null|integer,
         matchStatus:'matched'|'ambiguous'|'missing',
         anchor:null|{start,end,occurrence?}, matches:[]}], diagnostics:[]}
```

`raw` is unchanged input. Metadata missing from the external answer stays absent. RED requires an explicit before/after pair to become an editable change; empty after is deletion. BLUE prose without a quote becomes an unlocated finding. Unparsed RED text is retained for manual completion. Preserve rationale/evidence/references even when location is unresolved. Normalize line endings, extraction whitespace and line-end hyphens only with a source-offset map. Never choose the first of multiple source matches. A matched before/quote and anchor refer to the actual source slice. Mixed valid/invalid items are returned individually. No model/network call during import.

`FalsifyExternalExchange.buildPrompt({role,segments,fileHash,prompt?,harness?,attackTypes?,includeSource?})` returns optional portable instructions with a recommended response shape. Users may skip this and import directly. Legacy Falsify RED/BLUE responses and explicit Before/After prose remain accepted. A mismatching explicitly supplied source identity is returned as a diagnostic requiring confirmation, not silently rebound.

## Proposal collection

`FalsifyExternalProposals.create({fileHash, role='red', segments})` returns:

- `append(batch)` (add by default; preserve raw batch, merge exact duplicate proposals with source references).
- `snapshot()` -> `{schema:'falsify.external-proposals.v1',fileHash,role,batches,items}`. Collection item IDs are globally stable and carry `sourceRefs` and `enabled`.
- `setEnabled(id, bool)` atomically disables overlapping enabled alternatives before enabling a matched RED change. Unlocated RED items are retained but need binding before application. BLUE findings can be selected without a location.
- `update(id, fields)`, `bind(id, {segmentId,pageIndex,anchor,before?})`, `combine(ids, fields)` (new human-authored alternative with parent IDs), `restore(snapshot)`, `subscribe(fn)` -> unsubscribe.
- `edits()` -> selected, located RED edit fields accepted by the existing paper edit core. Stable IDs/sourceRefs link projected edits back to proposals. Evidence and raw batches do not enter the PDF.

Keep this collection separate from the strict active PDF edits so unlocated/overlapping proposals can coexist. Snapshot/restore must validate document identity and source ranges; do not invent locations. Coordinate exact add/update adapter details within B's workspace ownership.

## Workspace bridge

B adds `FalsifyPaperWorkspace.acceptExternalResponse(batch)` -> collection snapshot and `getExternalResponses()` -> collection snapshot|null. The existing `getSource()` and `acceptProposals()` remain compatible. Event `falsify:paper-external-responses` carries the collection snapshot after changes. A's external RED panel delegates to this bridge and does not own selection UI or manipulate workspace internals.

For unlocated RED changes the workspace offers source selection/manual before/after binding. Matching, checkbox selection, overlap resolution and explicit combined alternatives belong to B. A displays parsing diagnostics and preserves unparsed input for completion. The panel can be used without companion, registered harness or exported request.

## BLUE bridge

A owns `FalsifyDocumentBlueExternal.getSource()` -> `{fileHash,segments,revision,name}`|null and `acceptExternalResponse(batch)` -> snapshot. Its independent external panel is mounted in `#document-blue-workbench` (verify actual host; expose a separate mount hook if the incumbent uses a different ID). A owns BLUE accumulation/checkboxes, unlocated findings and record integration using the shared proposal collection module. Never add RED plan/source comparisons to model request packets. Preserve the legacy manual/local BLUE path.

## Automatic generation

C adds `FalsifyPaperGeneration.key(spec)` (deterministic string from fileHash, enabled edit content/anchors/order, fontRevision and export settings, excluding revision counters and transient UI metadata).

`create({generate,onResult,onState,delayMs?})` returns `schedule(spec)`, `flush(spec)` -> Promise of the exact requested result, `cancel()`, `dispose()`. `generate(spec,{signal,key})` is supplied by B using the existing PDF exporter. Serialize work, debounce, cancel/discard obsolete jobs, reuse exact-key results. State callbacks identify key and phase. A direct flush has priority over background schedules; bind each explicit download/handoff to its captured spec even if later edits occur. Unselected identity input yields the original PDF, not a fake edited file. B owns the workspace events and commit of inline editing before output capture.

C provides a bounded PDF document cache helper in this module (or `paper-preview-cache.js`) and coordinates its exact `load`/`release` API with B. Do not share mutable PDF.js render tasks between canvases. Dispose on source replacement and cache eviction.

## RED attack selection

`attackTypes` uses `contradiction`, `condition-omission`, `unsupported-inference`. Requests allow one or more; candidates may use one or multiple chosen types. Existing numeric level remains a legacy adapter, not a ban on mixed candidates. Allow numeric/citation text changes and empty-after deletion. C owns front/backend validation and prompts. Coordinator replaces index `#red-level` with `#red-types` fieldset containing checkboxes with those values (contradiction checked initially). C may keep hidden legacy support where required. Type metadata on external answers is optional.

## Exclusive ownership and coordinator wiring

A: external exchange/parser/UI files, document-blue.js, necessary paper-manual-records/experiment-ledger/confluence-store integration and own tests.

B: external-proposals.js, paper-edits.js, paper-workspace.js/css and own tests.

C: paper-generation.js / optional paper-preview-cache.js, document-red-core.js, document-red.js, app/local/red_service.py and own tests.

Coordinator: index.html, package/test registration, common fixtures/contracts, integration tests, version/release files. No worker changes the North Star or another owner's files. Request an API adjustment rather than editing another branch's file. Report exact expected script order/markup to coordinator.

## Acceptance fixtures

Use synthetic sources with a repeated quote, numeric and citation text, a line-end hyphen, and unlocated prose. Test multiple imported answers, duplicates with different sources, atomic alternative selection, manual binding, human combined alternatives, empty-after deletion, no-request import, incomplete metadata, and partial item errors. Use deferred async generation to test rapid edits, cancellation, undo/redo identity, exact flush and late completion. Real paid model execution is not part of these module tests.

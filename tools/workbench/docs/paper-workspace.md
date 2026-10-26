# Paper workspace UI

Candidate RED surface for one original PDF page at a time, direct edits, and an explicit generated-file handoff. This is not an acceptance report and it does not publish anything.

The controller is `app/dist/paper-workspace.js` (`FalsifyPaperWorkspace`). It edits no package, bridge, Python, or Confluence module. `paper-edits.js`, `external-red.js`, `browser-pdf.js`, and `external-red-ui.js` are loaded in that order and may be absent. Absence is an unavailable state: the page does not invent a PDF or a saved edit.

## Public API

`acceptProposals(proposals, {origin, model}?)` only shows proposals. Origin defaults to `external-ai-import`. `ai-proposal` records a model id only when the caller passes one matching the harness model pattern. `manual-unverified` RED responses are bridged as `external-ai-import` with no model. Ambiguous and missing targets stay disabled. The workspace rechecks the current segments; a caller's `status` is not trusted.

`getSource()` returns a frozen `{file, fileHash, segments}` after the chosen file has been hashed, or `null`. `file` is the same File the user chose. `segments` is a deep copy of `{id, label, text, pageIndex?}` only. `getEditSnapshot()` returns a frozen deep copy of the current edit snapshot, or `null`. `revision` is the edit-core integer. `getOutput()` returns a frozen `{file, sha256, verification, revision}` for the last verified generated PDF, or `null` when there is none or the stored bytes no longer match the hash. `file`, `sha256`, and `revision` are the exact values from that generation. `verification` is a copy. None of these getters share nested objects with later callers. A restored draft uses `create({resume})` so the edit ids and that integer stay. Resume does not rebuild the edits with `add`, and the undo stack starts empty. An empty After is a deletion. Whitespace-only After is refused. A repeated quote is accepted only at the supplied `start` / `end` / `occurrence` / segment / page.

Events, none of which carry PDF bytes:

- `falsify:paper-workspace-ready` after the global is set (dispatched on a timer so a later script can listen)
- `falsify:paper-workspace-source` with `{fileHash, name}`
- `falsify:paper-workspace-edits` with a frozen edit snapshot
- `falsify:paper-workspace-output` with `{sha256, revision, verification}` after a verified generation
- `falsify:paper-team-share` from the team button, with hash, revision, verification, and file name only. The button does not upload. `paper-manual-records.js` owns the consent screen.
- `falsify:blue-file` with `{file}` only

`index.html` loads `auto-pair.js` after `local-bridge.js`, and `paper-manual-records.css` / `paper-manual-records.js` after the workspace. Those files belong to their owners and may be absent. `#paper-external-mount` stays empty for the import UI.

## Reader and coordinates

`#paper-file` opens a PDF with the vendored PDF.js helpers (`FalsifyPreview.pdfParams`, `fitScale`, `defaultImport`, and `TextLayer` from pdfjs-dist 6.4.299, Apache-2.0). One page is drawn. Previous, next, and the page-number field jump within the document. Zoom is a factor on the fit scale, then clamped to the preview side and area caps. The stage scrolls inside `max-height: min(70vh, 720px)`.

Selection uses the text layer. The page string is the same shape document import stores: each text item, then a newline when `hasEOL` is set and a space otherwise, then trim. A DOM range stores the selected substring, not the whole item. Its `start` / `end` are indexes into that trimmed page segment. The inline After field starts as that substring. Applying it unchanged is refused. Clearing it to `""` deletes that range.

A bbox is `[x0, y0, x1, y1]` in top-left page coordinates: the origin is the top left of the unrotated page, y grows downward, and the units are PDF points. PDF.js `width` and `height` are already page points, so the font matrix is used only as a direction. A DOM range rect is converted with the page element and the viewport scale. Otherwise a partial range takes the matching fraction of the item box. PDF user space (origin bottom left, y up) is converted with the page `viewBox` and is never stored in `bbox`. A page whose rotation is not 0 is still drawn, and both direct selection and visual bbox attachment are refused, so a bottom-left box is never mixed with a top-left box. The edit core stores `start`, `end`, `occurrence`, and optional `bbox`/`style`; `bbox` and `style` are omitted from the input when null. Page width, page height, and rotation are checked before the edit is added and are not extra anchor fields. A second occurrence is kept when the anchor names it.

The inline editor is positioned over the selection. A viewport at most 700px wide, or a selection without a rectangle, docks it to the bottom of the screen. Escape and the cancel control close it and return focus to the page. Ctrl or Cmd+Z undoes, Ctrl or Cmd+Shift+Z and Ctrl or Cmd+Y redo, except while a text field has focus.

The browser exporter should paint a bbox only when `coordinate` is `top-left` and `rotation` is 0. Provenance, attack labels, and quality warnings stay in the workspace status and the edit list. They are not written into `after` and they are not drawn into the PDF. Generator warnings may be plain strings or `{code, severity, pageIndex, editId}` objects. Known codes are shown in Korean. `verification.status` of `failed` or `warning` is the status sentence beside that candidate file. The matching edit row shows the same cause. Download of the returned candidate stays enabled. A missing status still uses the received-file sentence.

## Generated file

`FalsifyBrowserPdf.prepare({file, edits, signal})` is the only generator for a PDF opened in this workspace. The preview and the generated download use that `File` after the bytes hash to the returned `sha256` and start with a PDF signature. A later edit keeps the file downloadable and labels it as the last generated file. A thrown prepare, a hash mismatch, or a missing exporter leaves the previous real file in place and does not report success. A returned file whose `verification.status` is `failed` or `warning` is kept and downloadable, and the status does not call that file a successful generation. The original file stays downloadable on its own control. While that PDF source is open, the older RED download control does not call the companion or require `layoutVerified`; it points at this generator. TXT export and the RED AI evidence record stay on that older control. AI review is still optional and is never started from this surface. After a RED file is loaded and there is no RED result yet, `visual-workflow.js` shows direct page editing as the next step. If the wayfinding title is `RED 실행 설정을 확인하세요`, it is rewritten to the original page and its action focuses that page. The AI run control stays available and is not started automatically.

Draft storage is `localStorage` key `falsify.paper-draft.v1.<fileHash>`. It is written only while the 12-hour checkbox is checked, only with the object returned by `FalsifyPaperEdits.draft`, and it is deleted by the delete control. That object is edit metadata. Restore calls `restoreDraft` and `create({resume})`, and it does not run on load. If the open file hash differs, the status asks for the PDF with that hash to be chosen again. A second checkbox may also keep the source PDF in a separate 12-hour Blob store (`falsify.paper-source.v1` or the injected store). That copy is not uploaded. Envelopes with file bytes, tokens, or very long strings are refused.

## Provenance

No new dependency and no new network service. PDF.js 6.4.299 is the existing vendored copy (`app/dist/vendor/LICENSE-PDFJS.txt`, Apache-2.0). The Lucide sprite is the existing vendored copy (`app/dist/vendor/LICENSE-LUCIDE.txt`, ISC). Text-layer CSS is the small set required by PDF.js inline custom properties, not a copy of `pdf_viewer.css`. The controller itself is project code under AGPL-3.0-only.

## Limits

Other workers own the edit core, the external parser, the browser exporter, the import section, manual records, auto-pair, the CSP `wasm-unsafe-eval` allowance, the global test runner, and the release version. This change does not copy those files or retitle a release. When those sibling files are absent from a checkout, their script tags 404 and this UI keeps the unavailable copy. `app/tests/cleanup-static.spec.cjs` still rejects the literal `paper-workspace` and requires every script to exist; that test is outside this change. `app/scripts/test.mjs` does not list the new spec. Rotated pages are visible but not editable until a later coordinate handler exists. Draft resume keeps the core revision and edit ids and does not restore the core undo stack. A metadata-only draft still asks for the same source PDF when the separate Blob was not stored. This report is not release certification.

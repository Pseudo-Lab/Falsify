# PDF paragraph editor and local export adapter

## Browser paragraph editor (alpha.14)

1. Open RED and select a PDF. Move to the desired page.
2. Click a paragraph, edit its text, and apply. Drag selection remains available for short edits.
3. Generate, compare Before/After, and download the actual previewed PDF. Use the After page controls to inspect added continuation pages.

The browser reuses the source font runs and size, wraps longer paragraphs and moves the following body into source-style continuation pages when needed. Before/After, source position and human provenance are recorded automatically. External AI changes use the same paragraph engine; importing them does not call a model. Duplicate source locations and overlapping edits require correction instead of silently editing a different passage.

The engine runs in a separate browser worker with fixed same-origin, SHA-256-verified JS/WASM assets. No PDF is uploaded, no local companion is required, and cancelling terminates only that operation's worker. Input limit: 25 MiB. The runtime is a locally supplied, hash-verified build; its source build provenance is not independently verified. Corresponding source, pins, patches and notices are in `app/src/paragraph-vendor/`; regenerate with `npm run build:paragraph-pdf --prefix app`.

Support is bounded to identifiable, unrotated, uncropped single-column body flow. Overflow is inserted immediately after the edited source page, with text headers/footers and decimal source-page suffixes. Other original pages retain their contents and numbering. This is not full-document Word pagination or general table/figure migration. Publisher artwork is kept on the source page and is not repeated on continuation pages. Edited-page ICC colors may undergo slight RGB conversion. Missing glyphs, mixed or ambiguous layouts, scanned pages and formulas are not universally supported.

The saved-file self-check verifies applied text and order using PDFium, so it is not independent typography verification. Readable failed drafts retain their warnings and can be downloaded; an operation that produces no readable PDF cannot invent a generated file. Original bytes and selected edits remain intact. Review the actual After preview before use.

## Optional local companion adapter

The local companion can route the existing authenticated `/api/export` request through the
patched `falsify-pdf-editor` (Node 24+, verified WASM) instead of the legacy single-line
PyMuPDF path. This is opt-in at server startup; nothing in an HTTP request selects paths,
executables or the manifest.

## Configuration

```
python app/local/server.py \
  --pdf-editor-root <ABS module checkout containing src/web-bridge.mjs> \
  --pdf-editor-manifest <ABS .../candidate-manifest.json> \
  [--pdf-editor-source-root <ABS pinned app source with upstream/ checked out>] \
  [--pdf-editor-node <ABS node executable>]
```

Environment equivalents: `FALSIFY_PDF_EDITOR_ROOT`, `FALSIFY_PDF_EDITOR_MANIFEST`,
`FALSIFY_PDF_EDITOR_SOURCE_ROOT`, `FALSIFY_PDF_EDITOR_NODE`. Root and manifest must be given
together and be absolute; a partial or relative configuration refuses to start. Without them
the companion keeps the legacy export path (old/unconfigured companions).

## Behaviour

Windows click-to-launch reads an optional local `.pdf-editor.local.json` in the extracted
Workbench root. It is ignored by Git and must contain exactly two absolute paths:

```json
{"root":"C:/path/to/falsify-pdf-editor","manifest":"C:/path/to/candidate-manifest.json"}
```

Alternatively pass `-PdfEditorRoot` and `-PdfEditorManifest` to `start-companion.ps1`.
The launcher requires Node 24+ when configured and does not install it automatically.
The protocol link still accepts only a port, never a path, token, executable or command.
For the module, clone with `--recurse-submodules` and follow its
[candidate build instructions](https://github.com/Shinick-Han/falsify-pdf-editor/blob/main/docs/BUILD.md).
This source release does **not** bundle or automatically download a patched WASM: selecting
the upstream default binary is not a substitute for the stream-order-patched candidate.
Workbench 0.2.0-alpha.3 was checked against editor 0.1.0-alpha.5 (repeated same-line re-edits and
word-spacing source patches); that runtime was verified on the maintainer host only and is not bundled.

- Capability probe (`/api/capabilities` → `pdfEditor`, also warmed in the background at
  start): checks module/manifest presence, `node --version` >= 24, then runs the fixed
  `node src/web-bridge.mjs --capabilities`, which verifies the manifest, artifact digests and
  pinned app source and instantiates the WASM once. It opens no PDF and starts no agent.
  Successes are cached; failures are retried after 15 s. `available` is true only after a
  successful probe. No filesystem paths are exposed.
- `pdfEditor` = `{available, configured, engine:'falsify-pdf-editor', version, wasmSha256,
  reflow, pagination, continuationStyle, draft, limits, sourceUrl[, runtime][, error]}`. `reflow`/`pagination` are
  booleans; a module descriptor counts only when `.supported === true`. Until the editor
  exports `EDITOR_CAPABILITIES`, reflow is true and pagination false. `draft` is true
  only when this bridge's `--capabilities` output says `draft: true` (an explicit
  web-request opt-in that can keep a readable PDF after a failed self-check). It is
  false for an unconfigured companion and for an older probe that does not advertise
  it. The legacy `pdf` boolean reflects editor availability when configured.
- `continuationStyle` is `null` unless the engine's `--capabilities` output declares
  `continuationStyle:{supported:true, policy:'source-number-suffix'}` and `pagination` is true;
  it is never inferred from pagination. When declared it is `{supported:true,
  policy:'source-number-suffix', scope}` with a fixed scope text (text-only source-style
  header/footer; standalone Arabic source number plus decimal suffix; originals unchanged).
  The engine's own scope string is not echoed, so no document text or path reaches the page.
- Export: same wire format `{format:'PDF', fileHash, file, patches:[{label:'PDF p. N',
  before, after, …}]}` plus optional boolean `draft`. Unknown fields are rejected; labels must be exactly `PDF p. N`
  (N >= 1, no leading zero) and map to `pageIndex = N-1`; edit ids are `edit-<i>` by order.
  Before/After are passed exactly; number/citation/URL scope checks match the legacy path.
  Only edit spans reach the bridge request (no model, provider, harness, rationale or label).
- Execution: own temp directory (`source.pdf`, `request.json`, `output.pdf`, `report.json`),
  fixed argv with `shell=False`, minimal environment (no `NODE_OPTIONS`), 180 s timeout,
  stdout/report/output size budgets. Only those four names and the directory are removed.
- Result: output must start with `%PDF-`, the report must say self-check passed, its
  `outputSha256` must match, its WASM digest must equal the probed one and every edit must be
  `applied`. Response keeps `file`, `sourceFileHash`, `outputFileHash`, `verification`.
- `verification` (per output, as the UI reads it): `engine:'falsify-pdf-editor'`,
  `layoutVerified` (true only when the mandatory saved-file text/layout self-check passed with
  no failures and no error-severity warnings), `reflow:{wrappedLines}` and
  `pagination:{inputPages, outputPages}` (from the self-check page count), `addedPages`,
  `sourcePageMap` (`report.pagination.sourcePageMap` reduced to `{sourcePageIndex,
  outputPageIndex, continuationPageIndices}`; flow digests/text dropped; else null), `capabilities:{reflow,pagination}`
  booleans, runtime hashes, edit statuses, warning codes, `diagnostics` (codes only),
  `independentQA`/`independentChecks` (below) and the check boundary. Missing facts are null, never
  invented (`wrappedLines` stays null until the editor reports it).
- `verification.continuationStyle` is `{policy:'source-number-suffix', applied:true,
  copiedPages}` only when the capability was declared, `layoutVerified` is true, the report's
  `continuationStyle` has that policy with `applied === true`, and `copiedPages` is an
  integer in 1..32 equal to both the reported `addedPages` and the counted page growth.
  Otherwise it is null (unknown or mismatched counts make no claim; there is no partial
  success). Under an engine that declared the style, the UI then says the added-page
  header/footer/page-number state was not reported in a verifiable form (neither copied nor
  body-only); engines without the declared style keep the body-only continuation wording.
- Any strict editor failure is a 400 error; there is no automatic fallback to the legacy path.

## Explicit draft mode

`draft` is an optional boolean on the existing `/api/export` body. Only `true` opts in.
Absent and `false` keep the strict result above, and the bridge request then omits the
field so an older engine still accepts it. A non-boolean is rejected before the editor
runs. The companion does not select another executable, and it does not fall back to
the legacy single-line path, a white overlay, or a raster rewrite.

`true` is forwarded as the web-bridge field `draft: true` on schema
`falsify-web-bridge-request/1`. The editor CLI does not accept that field and stays
strict. When the bridge has already saved readable `%PDF-` bytes and the self-check
status is `failed` or `error`, it writes those bytes, exits 1, and prints one object
`{ok:false, code, draft:true}`. The report stays `ok: false` with `status: "draft"`,
`quality` of `failed` or `error`, the machine `selfCheck.status`, `error.code`,
per-edit statuses, `outputSha256`, `inputSha256` and the runtime digests. This
service returns that file so a UI can download it with warnings. `layoutVerified`
stays false, `selfCheck.status` is not rewritten to `passed`, and `verification.draft`
is true only on this path. `verification.quality` is `failed` or `error`,
`verification.error` is `{code}`, and `verification.sourceBinding` is
`{inputSha256, outputSha256}`.

An edit whose self-check failure is `after_missing` is not labeled `applied` or
`noop`; the returned status is `after-missing`. A read-order failure such as
`edited_page_text_or_order_mismatch` can keep the machine status `applied` when the
After text is present, while the export itself stays unsuccessful. A report that
claims `ok: true`, `layoutVerified: true` or a passed self-check is refused rather
than relabeled. Independent MuPDF QA still runs. `failed` does not delete this
draft download and is not rewritten to `passed`; strict exports still refuse it.

These defenses still refuse the draft, delete the temp directory, and do not return
a file: unreadable report or stdout, a missing or non-PDF output, an output over
the size budget, an `outputSha256` or `inputSha256` mismatch, a WASM digest that
is not the probed runtime, or a source file whose bytes changed. The caller's
original bytes are only read. The temp directory (`source.pdf`, `request.json`,
`output.pdf`, `report.json`) is removed after the bytes have been copied into the
response. A failure before any PDF exists, including a pre-save read-order repair
error, still produces no file.

## Independent per-output QA (MuPDF)

After the editor's same-engine self-check passes, the companion re-reads the source and the
saved output with the installed PyMuPDF/MuPDF (a different engine from the editor's PDFium)
in `app/local/pdf_quality.py`. Production runs it as a child of the server's own Python
(`-I`, fixed argv, minimal environment, 90 s timeout, bounded stdout); nothing in the HTTP
request selects an executable. `verify_pdf_quality(source_bytes, output_bytes, edits,
page_map, page_count=None)` is the in-process helper.

- `verification.independentQA` is `passed|warning|failed|unavailable` and
  `verification.independentChecks` is `{schema:'falsify.pdf-quality.v1', status, method,
  checks:[{code, status, pages}], limitations}`: fixed check codes, 1-based output page
  numbers and fixed limitation sentences only, never document text or paths.
- Page map: the reported `sourcePageMap` (indices only; no body-band metadata is assumed) is
  used only if it is an in-order partition of the actual output pages, with integer
  (non-boolean) indices and continuations only on edited pages. Otherwise it is a warning;
  with equal page counts an identity mapping is assumed and differences are warnings only,
  else unedited pages are not compared. A reported page count is compared with the actual one.
- Unedited mapped pages: page boxes/rotation within 0.01 pt (the known float32 MediaBox
  drift is tolerated), normalized text, and the same MuPDF RGB render at bounded resolution
  (any sample moving more than 40 levels is a change). Not cross-renderer pixel identity.
- Edited pages plus continuations: the exact selected After must appear (a long After may
  cross pages: only source-matching header/footer edges, including a `.N` page-number suffix,
  are stripped; an interleaved but complete After is a warning), the Before must not remain,
  and the source text with Before replaced must survive in order (only insertions such as
  copied headers/footers are tolerated). Invisible, white and covered text (MuPDF text trace
  and draw-order bbox log) is a warning only when it increases over the source page, so
  pre-existing source defects are not reported as new.
- `failed` is only definite: unreadable output, a changed unedited page under a valid map, an
  After missing although MuPDF finds the Before in the source, or original text that vanished
  from the whole output. The export is then refused with a fixed message naming the check codes
  and pages and stating that no safe automatic repair is available; nothing is rewritten,
  flattened or rasterized. `warning` and `unavailable` (QA could not run, timed out or
  returned a malformed report) keep the download and never read as passed.
- Budgets: 2000 pages, 120 rendered unedited pages, 1000 px raster side, 60 s work budget,
  20000 normalized characters per edited group; beyond them checks become warnings.

## Limits

The same-engine self-check plus the bounded MuPDF QA above are not full scientific,
typographic or human verification; domain review remains required.
Long After text wraps and can continue onto added pages in a bounded, single-column,
unrotated, uncropped top-level body flow. Default budget: eight added pages per document;
each Before/After remains limited to 4000 characters and the web request to 12 selected edits.
Original page headers, footers and downstream page contents remain unchanged. Added pages
contain body lines only unless the engine declares the `source-number-suffix` continuation
style and the output report confirms it for every added page: then the source text headers
and footers continue on added pages in the source fonts, original page numbers stay as they
are, and a standalone Arabic page number on an added page reads as the source number plus a
decimal suffix (e.g. 10.1). Image or vector header/footer graphics are not supported and the
engine refuses the export instead of omitting them. Existing page numbers are never
renumbered. The UI states header/footer copying only when the output report declares it;
the report carries no page-number fact, so the UI states the numbering only as the engine's
conditional policy, never as an applied result or with this output's numbers;
it is a same-engine report, not independent verification. This is not invisible editing or complete
original-layout preservation. Tables, images inside the continued flow, ambiguous columns
and other unsupported layouts fail explicitly without truncation, flattening or legacy fallback.
See [pagination scope](https://github.com/Shinick-Han/falsify-pdf-editor/blob/main/docs/PAGINATION.md).

The integration was exercised with actual browser upload, editable After, authenticated
PDF export and explicit BLUE file handoff using synthetic data, without model calls. This
does not establish RED/BLUE model performance. The bounded MuPDF QA is separate from the
same-engine self-check; human and domain review remain separate from both.

An inherited PDFium save limitation remains: decimal page-box numbers can be reserialized
at float32 precision (the tested synthetic A4 MediaBox differed by about 0.00003 pt).
Unselected content streams and text remained identical, and MuPDF/PDFium rendered the
mapped unselected pages identically; Poppler showed raster differences for that synthetic
fixture despite visually stable layout. An isolated restore/perturb control attributed the
differences to the page box, not to changed words or font resources. Therefore this release
does not promise byte-identical page geometry or pixel identity in every renderer.

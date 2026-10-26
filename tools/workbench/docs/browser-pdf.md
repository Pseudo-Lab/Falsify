# Browser PDF content edit

`FalsifyBrowserPdf.prepare({file, edits, signal})` edits PDF content in the
browser (and in Node, for tests) with the pinned MuPDF.js WASM build. It does
not call a companion, upload the file, or run a model.

## Call

`file` is a `File` or `{name, bytes}`. `edits` is an array, or a
`falsify.paper-edits.v1` snapshot. Only objects with `enabled !== false` are
applied. A snapshot `fileHash`, or a top-level `fileHash`, must match the
SHA-256 of the bytes or the call throws `stale-source`. An aborted `signal`
throws `aborted`. No output file is returned for those errors.

The result is `{file, sha256, verification, pageMap, warnings}`. `file` is the
exact PDF bytes named in `sha256`. `pageMap` keeps the identity fields
`{sourcePageIndex, outputPageIndex, continuationPageIndices: []}` because this
editor does not add pages, and adds the agreed geometry: `coordinateSpace`,
`origin`, `yAxis`, `unit`, `width`, `height`, and `rotation`.
`coordinateSpace` is `top-left-page` (origin at the top-left of the page view,
y down, points). `width` and `height` are that view box. `rotation` is the
page `/Rotate` in degrees. `verification.coordinateSpace` is the same space.
`verification.pages` repeats the geometry and sets `editable` only when
`rotation` is 0. `verification.schema` is `falsify.browser-pdf.v1`.
`verification.independent` is false: the structural check reopens the save
with the same MuPDF.js engine. `layoutVerified` is true only when that check
passed and every warning is informational. It is not typographic, pixel, or
scientific verification.

Text-order and extraction-gap warnings are returned with the candidate. They
do not turn a readable file into a failure. A missing After, a Before that is
still extracted, a changed figure, a changed unedited page, or an unchanged
byte copy sets `verification.status` to `failed`, `layoutVerified` to false,
and still returns that exact candidate `File`. `sha256` is the hash of those
bytes. `verification.checks` and each edit's `checks` name the failed code.
An edit whose own check failed has `status: "failed"` and is never
`applied`. A readable candidate with only warning-severity notes, such as
`font-substituted`, has `status: "warning"` and `layoutVerified: false`.
Info-only notes stay `applied`. Invalid source, a stale or malformed hash, a
body that is not a PDF, a limit, abort, and an engine or reopen failure still
throw and return no file. Unsupported edits throw `unsupported` with
`details.edits[].code` before any PDF is written.

## What the engine does

For each enabled edit it finds one exact whitespace-normalized match of
`before` on that page. Zero matches is `not-found`. More than one match, after
the anchor filters, is `ambiguous` (no first-hit guess). The anchor may set
`bbox` in the agreed top-left page space only (y down, points; the same
numbers as a PDF.js viewport at scale 1 on an unrotated page), and
`occurrence` (0-based among all normalized page hits, before bbox filtering).
Browser selection font metrics may differ from PDF glyph metrics by up to half
a glyph height, capped at 8pt; a match outside the usual 4pt tolerance is marked
`selection-font-metrics`, with `layoutVerified: false`. Redaction always uses the
engine's exact glyph quads, not the browser selection rectangle. A remote bbox or
an inconsistent occurrence still refuses the edit. Omit `coordinateSpace` to
use that space. `coordinateSpace: "top-left-page"`, `origin: "top-left"`,
`yAxis: "down"`, and `unit: "pt"` are accepted. Any other `coordinateSpace`,
a bottom-left `origin`, or an upward `yAxis` is `invalid-anchor`. Those
numbers are never read as PDF user space. On an unrotated letter page the
sample word `REPLACE` in the fixture sits near `[136, 79, 192, 96]`, not near
the PDF baseline around y 700.

`anchor.start` and `anchor.end` are the raw half-open offsets into the source
segment string stored by `FalsifyPaperEdits`. They are not offsets into the
normalized MuPDF page string. The editor checks that the pair is a valid
integer range and then ignores it for location. A bbox or an occurrence
chooses the hit. Overlapping matches, such as `XXX` inside `XXXX`, stay
`ambiguous` until `occurrence` selects one. An empty After deletes the
matched glyphs and writes no replacement text.

Matched glyphs are removed with MuPDF redaction:
`applyRedactions(false, REDACT_IMAGE_NONE, REDACT_LINE_ART_NONE, REDACT_TEXT_REMOVE)`.
Images and line art are not redacted. The save uses `garbage=compact`, so the
removed text operators are not kept as unreferenced streams. The After string
is appended as a real text showing operator at the sampled size and RGB
color. WinAnsi Type1 is used when every After character fits that encoding.
Other characters, including Hangul, use MuPDF's built-in Korean font
(`Font("ko")` and `PDFDocument.addCJKFont(..., "ko")`) as a Type0 font with
`/Encoding /UniKS-UTF16-H` and a UTF-16BE hex string. That is a text operator,
not a raster, an annotation, or a hidden copy of Before. The face is not the
sampled source font, so the edit is `font-substituted` and the status is
`warning`. Characters that this CJK font cannot encode are `missing-glyphs`
and no file is written.

The face is the source Base-14 font when MuPDF reports one and the After text
fits WinAnsi. Other Latin faces are substituted with a Base-14 metric class.
Either substitution is `font-substituted` (a warning, so `layoutVerified` is
false). A longer After stays on the same PDF baseline when
it fits the hole or the clear space to the right. Otherwise it wraps downward
only when the extra lines do not hit other text, images, or the page edge, and
only on an unrotated page. If it does not fit, the code is `long-after-no-room`.
A page with non-zero `/Rotate` is not edited. The call throws `unsupported`
with `rotated-page`, includes the page geometry, and returns no file. Rotation
stays rejected until top-left view coordinates and the PDF text matrix are
handled together. An edit aimed at an unrotated page can still proceed while
another rotated page stays untouched. Vertical or mixed-direction text on an
unrotated page is `rotated-text`.

The painted page does not gain attack labels, quality labels, or provenance
stamps. Diagnostics and provenance stay on the returned verification object
for the UI to show separately. The editor does not write a Falsify info entry
or a stamp annotation. MuPDF may still set its own document Producer; that
string is not painted on the page.

## Build

`npm run build:browser-pdf` copies `mupdf@1.28.1` `dist/mupdf.js`,
`mupdf-wasm.js`, and `mupdf-wasm.wasm` into `dist/browser-pdf-vendor/` and
writes `manifest.json` plus `NOTICE.md`. `dist/browser-pdf.mjs` is the ES
module. `dist/browser-pdf.js` is the classic loader. Evaluating it does not import
MuPDF or fetch the WASM, including on BLUE and review routes that only include
the script. The first `prepare` starts `dist/browser-pdf-worker.mjs`. That
module worker imports `dist/browser-pdf.mjs`, which loads the vendor WASM.
No MuPDF source build and no falsify-pdf-editor candidate runtime is downloaded.

Browser cancellation: the worker posts `{ready: true}` after its message handler is installed. The loader then sends one numeric `id`. The loader copies the
file into a fresh `ArrayBuffer` and transfers that copy, so the caller's bytes
stay intact. One `finish` function settles every success and failure: it marks
the request settled, removes that request's `AbortSignal` listener, and deletes
the job. Aborting a signal after `finish` does not terminate the worker a later
`prepare` is using. A `Worker` constructor failure or a `postMessage` failure
rejects `prepare` with `engine` immediately and resets that worker. A worker
`error` or reset terminates it, settles its ready promise, and finishes every
job still recorded for it. In-flight abort still rejects with `aborted`,
returns no file, and the next `prepare` starts a new worker. Node engine tests
import `dist/browser-pdf.mjs` and run MuPDF on the main thread. The loader
lifecycle tests stub `Worker`, run in their own process, and do not import the
engine or fetch the WASM.

License: MuPDF.js is AGPL-3.0-or-later. Corresponding source is the upstream
1.28.1 tag recorded in the manifest. The workbench itself is AGPL-3.0-only.
`dist/browser-pdf.js` is the classic script the UI can include. It does not
load the vendor WASM until `prepare`. Root packaging owns the pinned WASM
allowlist; this build only copies the already pinned `mupdf@1.28.1` artifacts.

## Limits

25 MB, 200 pages, 24 enabled edits, 4000 characters per Before/After, at most
8 wrapped lines. No encrypted PDFs, no added continuation pages, no CMYK text
color, no claim that unedited content streams are byte-identical after
MuPDF's save. Tests cover a synthetic multi-page file with pdf.js and, when
`pymupdf` imports, PyMuPDF, including the exact top-left unrotated bbox, a
rejected bottom-left bbox, a rejected rotated page, overlapping hits, empty
After deletion, a failed check that still returns the candidate, Korean
UTF-16 text, and browser-worker cancellation. The browser launch uses
`BROWSER_EXECUTABLE` when that environment variable is set, otherwise the
installed Edge, Chrome, or Chromium for the platform. PyMuPDF uses
`PYTHON_EXECUTABLE` when set, otherwise `python3`, `python`, or the Windows
`py` launcher. A missing browser or interpreter skips only that check. These
tests are candidate evidence, not a release certification.

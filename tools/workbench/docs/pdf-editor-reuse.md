# PDF editor: search-first and reuse decisions

Research baseline: Workbench `ceba792` and editor `50abc7c`, checked 2026-10-27.
The accepted alpha.15 implementation is described below. Research/forking alone
does not establish integration or runtime acceptance.

## Required behavior

Keep source fonts and sizes while editing scientific papers. Repack overflowing
body text into compatible existing pages before adding terminal pages. Select
table cells and individual shared figure placements. Keep the original immutable,
record Before/After and human provenance automatically, and preview/download the
actual saved bytes. Preserve the existing RED/BLUE/review separation and airport UI.

Existing browser MuPDF and BentoPDF/PDFium are the primary engines. No new paid
model, remote PDF upload, native build or heavyweight desktop runtime is required
for the table interface. Advanced figure operations use the optional local service.

## Comparison and decisions

Ratings: 2 strong, 1 partial, 0 unsuitable, ? unverified. These are scoped fit
assessments, not quality rankings. License and actual runtime support are gates.

| Candidate | Functional fit | Browser compatibility | Maintenance/docs | License/trust | Integration cost | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Existing PDFium paragraph engine | 2: accepted bounded source-font flow through compatible existing pages; barriers remain explicit | 2: existing pinned worker | 2: local regressions and source pins | AGPL; hash-verified runtime, independent source rebuild unverified | 2: reuse current object/style snapshots and checks | Post-edit compaction with explicit source/content provenance groups |
| [Stirling MIT table core](https://github.com/Stirling-Tools/Stirling-PDF/tree/cd48ccb288f66ff884cbb084bf101b875ed7ded7/frontend/src/editor/core/tools/pdfTextEditor) | 2: detection, geometry and merged-cell model; not a writer | 2: selected modules are pure TypeScript | 2: upstream table detection/geometry tests | MIT **selected paths only**; restricted engine and commercial directories excluded | 2: narrow model/reader adapter, no second PDFium | Extract pinned pure core, retain original source/license, adapt to current source-bound writer |
| [PDF4QT](https://github.com/JakubMelka/PDF4QT/tree/67b6b9903cb4e318803342f2d428f02e1bb124e3) | 1: object writer and image/form/clip tests; no ready document paginator | 0: C++/Qt native stack | 2: source and targeted editor tests inspected | MIT core; Qt/dependency terms separate | 0: new native build/runtime | Fork for writer/fixture reference; no default runtime integration |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC/tree/38d3896dcde9b5a940c62cf5563cadea673a64d3) | 1: formula-aware layout; typesetting can shrink to fit, no ready cross-existing-page flow | 0: Python/ML/native stack | 2: typesetting source/docs | AGPL; model licenses separate | 1: reusable design reference, expensive replacement | Fork as reference; do not inherit shrinking behavior |
| [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx/tree/3e1c2319d6a3fbf2ae4d46c3ab734b7fc87bd9b4) | 1: paragraph/table/image structure; source pages become Word sections | 0: Python conversion | 1: useful code, explicitly no longer maintained by Artifex | MIT own code; PyMuPDF terms separate | 1: optional extraction adapter; layout round-trip uncertain | Fork for structure experiments; not original-PDF edit authority |
| [pdfplumber](https://github.com/jsvine/pdfplumber/tree/4c64b92d5caccd71c645e98e0fabb0c4dba7ff45) | 1: detailed table/character geometry; extraction only | 0: Python | 2: tablefinder/debug documentation | MIT | 1: optional independent extraction comparator | Fork for comparison; no writeback claim |
| Existing pikepdf image writer | 2: exact placement isolation through supported simple opaque Form ancestry | 0: optional local Python service | 2: local focused tests | MPL dependency; application AGPL; retain notices | 2: current ancestry/resource cloning | Keep the bounded writer and rendering/stream checks |

The decisive source files were inspected, not just repository descriptions. No
researched upstream product was demonstrated to be a drop-in browser paginator
that preserves arbitrary imported PDF layouts across existing pages. A thin
extension of the already tested engine is preferable to replacing the editor.

## Remote forks

These forks were created under the user's GitHub account and parent identities
were read back through the GitHub API. Forking does not mean all their code or
licenses are included in Workbench. They were not cloned wholesale to the PC.

| Fork | Intended role |
| --- | --- |
| [bentopdf](https://github.com/Shinick-Han/bentopdf) | Existing source editor lineage |
| [bentopdf-pdfium-viewer](https://github.com/Shinick-Han/bentopdf-pdfium-viewer) | Existing native engine lineage |
| [Stirling-PDF](https://github.com/Shinick-Han/Stirling-PDF) | Selected MIT table recognition/model |
| [PDF4QT](https://github.com/Shinick-Han/PDF4QT) | Native object-writer comparison and fixtures |
| [BabelDOC](https://github.com/Shinick-Han/BabelDOC) | Formula and layout reference |
| [docling](https://github.com/Shinick-Han/docling) | Optional structure hints; ML conversion remains separate |
| [pdfplumber](https://github.com/Shinick-Han/pdfplumber) | Geometry/extraction comparator |
| [pdf2docx](https://github.com/Shinick-Han/pdf2docx) | Optional document structure extraction |
| [pdfcpu](https://github.com/Shinick-Han/pdfcpu) | PDF object/content manipulation comparison |
| [PyMuPDF](https://github.com/Shinick-Han/PyMuPDF) | Existing local reader and independent renderer lineage |
| [mupdf.js](https://github.com/Shinick-Han/mupdf.js) | Existing browser writer lineage |
| [mupdf](https://github.com/Shinick-Han/mupdf) | Existing native renderer lineage |
| [pikepdf](https://github.com/Shinick-Han/pikepdf) | Existing painting-operator parser/writer lineage |

## Accepted alpha.15 implementation

- **Browser text flow:** the existing pinned BentoPDF/PDFium worker first applies
  edits against original source pages, then compacts eligible full-body,
  single-column text chains into compatible existing original pages before
  adding terminal pages. Source fonts/sizes and fixed original headers/footers
  are checked. Original page identities and content destinations are recorded
  separately. A barrier leaves ordinary continuation pages with an explicit
  warning; it is not counted as a compacted group.
- **Links and tiny citation paths:** an optional trusted raw MuPDF adapter keeps
  existing Link dictionaries and unknown metadata while native source glyph
  mapping proves one rigid translation. Owned tiny horizontal citation paths
  require exact source/staged/saved shape, style and paint relation. Targets
  inside changed text, unknown action ownership, split/edited labels and
  ambiguous paths remain barriers. Proven originally missing named targets
  remain missing with a warning; no destination is invented.
- **Table cells:** the grid-icon **표 셀 편집** mode uses the pinned selected
  Stirling MIT recognition/geometry/model core. Its worker reads the exact
  source and returns tight glyph anchors, separate cell bounds and stable
  source aliases. A person chooses a supported cell and types After. MuPDF
  changes that selected text; detection alone is not editing authority. Empty,
  multi-run, overlapping or uncertain cells can refuse, and borders/cell sizes
  do not automatically grow. Output fit warnings remain visible.
- **Mixed table/body export:** table edits run first on original bytes. Only
  an accepted identity-page result can feed its actual bytes/hash to the body
  paragraph stage, retaining original source indices. The composite records
  both input/output hash links and engine statuses. Failed table quality stops
  the body stage and can return a readable failed table candidate with body
  edits explicitly pending. A readable failed body draft retains that status.
  Mixed results are immutable files of the verified bytes; no stage claims
  independent or general layout verification.
- **One figure placement:** the optional local companion isolates the selected
  opaque raster painting invocation, including at most three simple Form
  ancestors and shared resource uses. It keeps the original placement box.
  Inline images, masks/complex clips, optional-content/tagged ownership,
  unsupported page transforms and arbitrary vector figures remain unsupported.
  This separate manual image export does not move figures/tables and captions
  atomically with paragraph flow.

The real cold-shower eight-edit check still produces **18 pages from 15 original
pages, with zero compacted flow groups**. Its table and bibliography backlinks
remain protected barriers. Synthetic four-original-page link/underline flows
have passed the bounded checks; the real-paper result still needs those barriers
to be resolved before natural existing-page flow can be claimed for that case.

Browser text/table editing uses shipped pinned runtimes without a companion or
model call. The optional local image writer requires its separately installed
dependencies. No new desktop engine or paid model was integrated.

## Remaining boundaries and evidence

Document flow uses source-to-content provenance; a page identity map alone cannot
describe mixed-origin destination bodies. Saved text order, source font/style
and fixed headers/footers are checked; independent unaffected-region rendering
review remains necessary. An
existing PDFium object-list insertion order does not guarantee saved stream order.

Table detection is a hint. Exact source bytes and the writer's quote/geometry
checks authorize a cell replacement. Repeated values must be disambiguated by
their source positions, not the detector's row order. Unsupported multi-run cells
and uncertain boundaries remain explicit.

Figure replacement must isolate the selected painting invocation and each shared
Form/resource ancestor. A global image-xref replacement or hidden-original overlay
does not meet this contract. Masks, complex clips, arbitrary vector figures and
table/figure movement with captions need separate ownership and rendering proof.

Runtime tests and release receipts are recorded per accepted implementation;
this research document does not certify general typography or scientific validity.

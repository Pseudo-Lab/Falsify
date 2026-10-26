# Changelog

## 0.2.0-alpha.10

- Version the changed role, navigation and Confluence entry assets so browsers load the matching visual workflow implementation after an upgrade. Release packaging rejects stale asset version suffixes.
- The alpha.9 visual workflow, OSS components, storage semantics and regression coverage remain unchanged.

## 0.2.0-alpha.9

- Airport-style visual file intake: drop, paste or pick a paper; actual first-page PDF thumbnail; empty future stages collapse.
- Selected Harness shelf, large play control, compact PC connection, library-first tools and per-item team save without changing either execution selection.
- Team drawer starts user-delegated connection when needed. Explicit destination/consent gates publication; technical details are disclosed on demand.
- Symbolic human verdicts delegate to existing validated records. A real-browser regression covers overall label activation, independent RED/BLUE input, multi-file refusal and responsive layouts.
- Reused GoogleChromeLabs file-drop 1.0.1 and pinned Lucide SVG sources with license/provenance receipts. No new frontend framework. See docs/release-alpha9.md.

## 0.2.0-alpha.8

- Confluence is the only remote archive: explicit team publication of selected experiments, Harnesses and detailed reviews.
- Fetched records open in temporary native review without merging into original local storage; publish draft reviews explicitly to retain them.
- Central user-delegated Atlassian OAuth, stateless bounded relay, immutable hash-checked attachments and legacy write retirement. Existing local and historical database records remain preserved.
- Synthetic real-OAuth and independent-browser-origin roundtrips verified; original/edited PDF bytes are not included in JSON archives. See docs/release-alpha8.md.

## 0.2.0-alpha.7

- Native human review pairs RED before/after and recorded attack intent with all BLUE findings. Changed expressions are marked and quote overlaps displayed first without automatic scoring.
- Per-finding and per-attack judgments/reasons persist with the existing append-only review history and JSON backup; old records remain supported.
- RED-assisted review records its exposure and carries that disclosure into a shared review's overall note. Detailed per-finding/RED comparison remains local, not automatically shared.
- Review requires no companion connection. The connection panel is hidden in this destination; desktop columns stack on small screens. RED-only/BLUE-only use stays independent.

## 0.2.0-alpha.6

- Host-bound evidence references make repeated BLUE selection quotes unambiguous without weakening final grounding.
- Matched BLUE failures remain visible across reload, with explicit request/diagnostic export and discard guidance.
- Experimental BLUE Evidence v0.3.4 uses a self-contained source bundle and preserves immutable inherited audit records.
- Offline controlled-comparison preparation distinguishes machine configuration, strategy, failures and unreviewed findings.
- Source ZIP preservation checks work without Git history. Human gold, full comparison UI and another-PC validation remain pending.

See docs/release-alpha6.md for verification and limitations.

## 0.2.0-alpha.5

- Password change/revoke-all sessions; exact-request RED/BLUE reload recovery and same-page double-click admission.
- Portable BLUE Evidence v0.3.3 sources and per-PC profile generation with explicit external-literature opt-in.
- Quick-first hosted HTML guide, account/recovery documentation, and PDF Editor alpha.6 compatibility.
- Source-only distribution excludes private records, machine profiles and patched editor WASM.

See docs/release-alpha5.md for verification and limitations.

## 0.2.0-alpha.4

- Optional team records in Results: invite-only username/password accounts, private-by-default uploads, explicit team sharing,
  immutable payload versions, owner-only revision-checked changes, and subjective reviews grouped by matching conditions.
- Team harness preview remains separate from registration and local CLI execution. Local papers and records are not
  automatically uploaded or replaced. Server records are client-reported, not execution attestations or scientific scores.
- Worker/D1 source, bounded request and account quotas, salted scrypt password hashes and expiring hashed sessions.
- Shared run summaries exclude private evidence and local IDs on the server, including when listing an owner's records.
- Shared API reads require an active invited-member session. Operator-only invitation issuance/admission/revocation;
  no public admin endpoint. Static GitHub Pages and source remain public, not private hosting.
- Flexible wrapper profiles adapt existing stdio/HTTPS programs: prompt/JSON/template/extracted-text files as input,
  JSON or a single fenced JSON block as output, deterministic pointer/field/array/stage mappings and preview-only builder.
  Original binary PDFs, arbitrary prose interpretation and automatic README-to-wrapper generation are not included.
  Wrapper execution requires a companion advertising support; registration never executes code. See docs/harness-wrapper.md.

Requires a configured shared API. No email/GitHub identity verification, email password recovery, automatic complete
cross-device ledger sync, model execution certification, or causal harness ranking. PDF editor remains 0.1.0-alpha.5.

## 0.2.0-alpha.3

Source-only prerelease. See docs/release-alpha3.md. The separately configured PDF editor is 0.1.0-alpha.5.

- Experiment records separate local-broker runs, manual responses and imported records; a harness-hash mismatch or
  missing hash is shown as an unconfirmed harness and excluded from averages. Model-call correctness stays unknown.
- PDF import warns about glyphs without a Unicode mapping instead of silently using their text.
- PDF export refusals carry fixed refusal codes; regional, typography and reading-order QA gained a bounded
  rigid-run tolerance (0.02 pt, warning only) and a block-order proof for reordered-but-complete text.
- Legacy editor/export fixes in the local companion, with focused regressions.

Not claimed: complete DOCX/ODT/HTML layout output, figure-aware BLUE, a shared database, full-model benchmarks or
AMAS documents being fixed. No arbitrary-PDF, invisibility or scientific performance claims.

## 0.2.0-alpha.2

- Optional manual raster-image placement selection in RED, separate from text candidates and BLUE.
- Source-bound painting IDs and single-occurrence resource isolation, including shared page resources.
- PNG Before/After and experimental-copy consent; PDF and separate rendering-check report downloads.
- Authenticated isolated image service with bounded input, fixed errors and temporary cleanup.

Requires optional image dependencies on Python3.11+. Forms/inline images, complex clipping/masks, vector figures and tables
are outside the initial supported boundary. BLUE remains text-only, and rendering checks are not scientific approval.
See docs/pdf-image-editing.md. Six synthetic shared/inherited placements were each replaced separately: MuPDF and the
configured PDFium runtime found zero changed pixels outside the selected region. This is not arbitrary-paper fidelity or
domain approval. The separate PDF editor remains0.1.0-alpha.4; image writing is an optional companion operation.

## 0.2.0-alpha.1

Source-only prerelease of the Workbench and local companion. The separate PDF editor remains 0.1.0-alpha.4.

- Source-derived text edit plans and independent edited-page/region quality checks.
- Exact downloaded-PDF preview using the verified output bytes, with cancellation and bounded page rendering.
- Optional structure, fixed-area layout and object-occurrence analysis modules, with synthetic regression coverage.
- Explicit authenticated PDF preflight from RED: source inventory, shared-image counts and advisory selected-text layout.
  Does not run a model, authorize a scientific attack, block text export or pass RED information into BLUE.
- Companion version and feature reporting, while retaining old-companion/manual operation compatibility.

Docling ML conversion is not enabled; structure schema compatibility was tested separately. The layout planner is metrics-only,
not a new PDF writer. Object replacement is still a synthetic-only unique-XObject prototype at this release boundary; shared
per-occurrence writing is the next implementation. BLUE remains text-only.

The source archive excludes local environments, private papers/harnesses/records, model artifacts and the locally patched WASM.
Longer PDF export requires the separately configured editor described in docs/pdf-editor.md. Existing user installations must
restart idle companions through the supported launcher; pairing tokens change on restart and browser-local records are retained.

# Selected Stirling PDF MIT table core

Upstream: https://github.com/Stirling-Tools/Stirling-PDF
Commit: cd48ccb288f66ff884cbb084bf101b875ed7ded7 (2026-10-26).
Retrieved with GitHub CLI contents API at that exact ref on 2026-10-27.

Copyright (c) 2025 Stirling PDF Inc. MIT License, retained verbatim in
`upstream/LICENSE`. Only `frontend/src/editor/core/tools/pdfTextEditor/` files
are included. The upstream root license explicitly applies MIT outside its
listed carve-outs. No `engine/`, proprietary, desktop, cloud, saas, or processor
code is incorporated here. Native dependencies have not been added.

`upstream/` retains byte-for-byte source inputs and two upstream test sources.
`detection.mjs` is esbuild 0.28.2's unminified browser/ES2022 ESM output of
`util/tableDetection.ts`; `geometry.mjs` is the same for `util/tableGeometry.ts`.
`model.mjs` bundles `model/TableModel.ts` and `model/Color.ts`, with the Color
runtime alias replaced by `./Color.ts` before bundling. Type imports are erased.
No behavior changes were made to these three generated modules. The retained
types.ts is provenance only; browser code requires no upstream engine or types.

Falsify's `table-adapter.mjs` adds source hashing, revision binding, coordinate
mapping, conservative prose/ambiguity gates and explicit selection. It is not
an upstream writer and does not serialize a PDF. Candidate confidence does not
authorize editing. Existing MuPDF/PDFium write and quality checks still apply.

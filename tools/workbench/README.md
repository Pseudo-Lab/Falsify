# Falsify Paper Workbench

Browser-local RED and BLUE scientific-document experiments, independent human review, and versioned user-defined harnesses. RED and BLUE may be used independently.

This repository contains only the application code. Private project notes, research papers, answer keys, meeting recordings and execution records are not included. The original private research repository remains private.

The hosted frontend is static. Files are parsed in your browser; original local drafts and saved runs stay local until you explicitly publish a selected case to Confluence. Confluence is the only remote archive, and publication means sharing with the Falsify team. Fetched records open temporarily in native review, without automatic persistent browser copies; publish new review notes explicitly before closing or reloading. A thin OAuth/API relay stores no experiment database or files. Historical private records are not automatically published. Explicit execution sends the supplied paper text through your own local CLI or selected trusted harness to its model provider. GitHub is not an execution backend or shared experiment database.

Use the [hosted platform](https://shinick-han.github.io/falsify-workbench/) and [quick-first HTML guide](https://shinick-han.github.io/falsify-workbench/guide.html). Follow [local companion setup](docs/local-companion.md) to connect your own Codex CLI or Claude Code subscription login, or use manual JSON exchange. Optional [BLUE Evidence v0.3.3 setup](docs/blue-evidence.md) uses each participant's own CLI login. Windows users can run `start-companion.ps1` from an extracted source download, or once install the optional per-user `falsify://connect` click-to-launch link with `install-connection.ps1` (no administrator rights; `uninstall-connection.ps1` removes it). The pairing token is always pasted from the terminal, never sent in a link. No account credentials or API keys should be entered into a harness JSON or committed to this repository.

[Deployment architecture](docs/deployment.md) · [Harness protocol](docs/harness-contract.md)

## Third-party components

The original Workbench application code is licensed under AGPL-3.0-only; see [LICENSE](LICENSE) and [NOTICE](NOTICE). This grants no license to user-uploaded papers, private harnesses, recordings or research records. The complete application source is available in this repository, including the static frontend and local companion.

Browser parser license notices are retained in `app/dist/vendor/`. Python dependencies are installed by the user, not bundled. Short browser edits use MuPDF; paragraph edits reuse [Falsify PDF Editor](https://github.com/Shinick-Han/falsify-pdf-editor) and BentoPDF/PDFium under AGPL-3.0-only. Since alpha.14, its pinned JS/WASM and corresponding source overlay are shipped to GitHub Pages and run in a browser worker. Editing needs no PC connection or model call. The optional local companion export adapter remains available. See [PDF editor setup and limits](docs/pdf-editor.md).

Alpha.15 adds bounded flow through compatible existing single-column pages before terminal pages, with original source/content page mappings and explicit table, figure and link-target barriers. The grid-icon **표 셀 편집** mode reuses selected [Stirling MIT table modules](docs/pdf-editor-reuse.md) to locate cells; a human edit is bound to exact source text and geometry. Cell sizes/borders do not automatically expand. Mixed table/body export records a table-first, then paragraph-stage hash/status chain; a readable failed stage stays marked failed or draft, and pending body edits remain explicit.

The optional local companion can replace one opaque raster placement inside supported simple nested Forms, isolating shared uses. This remains separate from browser text/table export; arbitrary figures, multi-column layouts and moving tables/figures together with captions are outside the accepted scope. In the real cold-shower eight-edit check, 15 original pages still yield 18 output pages and zero compacted flow groups because table and backlink barriers remain. See [implementation and reuse boundaries](docs/pdf-editor-reuse.md) and [figure replacement limits](docs/pdf-image-editing.md).

Model results and human reviews are not scientific gold, domain approval, or verified performance metrics. Custom harness code must be trusted: the companion is not an OS sandbox.

# Workbench 0.2.0-alpha.5

Source-only prerelease, paired with PDF Editor 0.1.0-alpha.6. The shared API is a separate deployment.

## Use it

1. Open the [Workbench](https://shinick-han.github.io/falsify-workbench/) and its [quick-first guide](https://shinick-han.github.io/falsify-workbench/guide.html).
2. Start this release's companion and pair it. RED, BLUE and human review remain independent.
3. For optional BLUE Evidence v0.3.3, follow [the per-PC setup](blue-evidence.md). A shared definition does not install code or transfer the author's login.

## Changes

- Password change with current-password verification and revoke-all-sessions. Successful changes require login again. Wrong passwords retain the valid session. An uncertain response is never automatically resent. No new D1 migration is required.
- RED/BLUE pre-POST pending records and reload recovery through GET only. Results must match role, request ID, document, harness, exact request-byte digest and companion instance.
- Same-page admission prevents rapid double-clicks. RED export after reload requires reselecting the same original file. Pending records retain extracted text, not PDF bytes or pairing credentials.
- README/sample-driven profile assistance already exists; a proposed command is not automatically installed or executed.
- Reusable BLUE Evidence v0.3.3 source, attributed methodology corpus, install-time template and offline tests. Selected trusted stdio code can opt into Crossref/Europe PMC lookup; built-in BLUE permissions stay unchanged.
- PDF Editor alpha.6 fixes measured prefix movement and rollback state/identity for ordered multiple edits. A patched WASM is not bundled.

## Verification boundary

Local checks covered API 36 cases; Workbench 20 test files; Python 535 cases (7 optional/platform exclusions); PDF engine 206 cases (one optional fixture exclusion); and four independent rollback/order cases. Deployment-specific checks are recorded separately.

Same-page admission is not a cross-tab lock. Server restart does not persist in-memory jobs. Account deletion/recovery/HttpOnly policy, complete ledger sync/restore, arbitrary PDFs/AMAS, visual BLUE, and DOCX/ODT/HTML layout-preserving output remain separate work. A calibration run is not human gold or a verified performance metric. The same-host candidate runtime still reports sourceBuildVerified=false.

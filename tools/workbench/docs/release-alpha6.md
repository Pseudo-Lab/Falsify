# Workbench 0.2.0-alpha.6

Source-only prerelease, based on the accepted integration `39a1076970f1704fc8249666631d725df37dfb73`.
The PDF editor remains 0.1.0-alpha.6; the shared API is unchanged by this release.

## Quick start

1. Open the [Workbench](https://shinick-han.github.io/falsify-workbench/) and [guide](https://shinick-han.github.io/falsify-workbench/guide.html).
2. Back up your current installation and configuration, then start this release's local companion and pair it.
3. For experimental BLUE v0.3.4, follow [per-PC setup](blue-evidence-v034.md). A shared Harness definition does not install a runner or transfer a CLI login. Regenerate the profile for your own source path and interpreter.
4. Keep RED, BLUE and human review independent. Preserve failed requests and raw responses before discarding a pending attempt.

## Changes and verification

BLUE selection uses host-issued evidence references for the exact text delivered to the selector, disambiguating repeated literals. Unknown/stale references still fail; final grounding stays strict. See [selection contract](blue-selection.md).

Matched terminal errors stay visible after reload. Request and bounded diagnostics can be downloaded before explicit discard. There is no automatic retry or extra model call. See [recovery](blue-recovery.md).

v0.3.4 includes its helper dependencies and retains the predecessor implementations and original inherited audit files. Source ZIP tests require no Git history. Existing v0.3.3 definitions and records remain separate.

The offline [controlled-evaluation tool](controlled-blue-evaluation.md) prepares ORIGINAL/E1/H1 comparisons. It does not implement a full comparison screen, supply scientific gold or prove independent repeats.

Integration verification covered 20 Node app test files, 572 Python cases (6 skipped), 10 v0.3.3, 6 v0.3.4 and 24 comparison offline checks. Source ZIP checks also passed without `.git`. Live lifecycle probes used synthetic adapters without model calls. One separate v0.3.4 trial completed and produced findings; scientific adjudication and controlled repeats remain pending. These are verification boundaries, not performance claims.

## Remaining limits

- After reload, the current Harness dropdown can differ from the retained failed attempt. The preserved request is authoritative; clearer attempt context is a follow-up.
- Requested model identity is not independently verified for custom stdio code. External literature lookup may be partial.
- Another person's PC/CLI installation is not verified. Server restarts do not persist in-memory jobs; back up recent results first.
- Full browser comparison/sync, advanced PDF/table/figure handling, visual BLUE and layout-preserving non-PDF output remain separate work.
- This source ZIP excludes private papers, machine profiles, records, credentials and patched native editor WASM. Release publication and installed/hosted verification are separately recorded.

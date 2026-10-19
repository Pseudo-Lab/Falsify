# Workbench runner proposal

This subtree contains an isolated source snapshot of the runner-developed **Falsify Paper Workbench 0.2.0-alpha.3** plus its
quickstart-first Korean HTML usage guide. It does not replace the team's existing README, research plan, defect taxonomy,
evaluation gates, corpus or licensing decisions. Inclusion in this proposal branch is not team approval, scientific validation
or a benchmark score. RED, BLUE and human review are separate workflows.

## Open the guide / use the application

Download `app/dist/guide.html` and open it in a browser to read the standalone guide. GitHub's file viewer displays HTML source,
not a hosted application. The branch preview is https://shinick-han.github.io/falsify-branch-preview/ and its online guide is
https://shinick-han.github.io/falsify-branch-preview/guide.html . The deployment source is the separate runner-owned
repository https://github.com/Shinick-Han/falsify-branch-preview . This is not a Pseudo-Lab official site, and this branch does
**not** deploy a Pseudo-Lab GitHub Pages site. Model invocation and PDF export require each participant's own local companion;
CLI login is required only for model invocation. The existing runner app at https://shinick-han.github.io/falsify-workbench/
is published separately from the same application snapshot. Both personal Pages apps share one origin and browser storage; use a separate browser profile for isolated records.

To get this branch rather than the main branch (which does not include this proposal):

```sh
git clone --branch feat/workbench-html-guide-20261012 https://github.com/Pseudo-Lab/Falsify.git
cd Falsify/tools/workbench
```

Windows, from that folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-companion.ps1
```

The optional click-to-launch registration belongs to one fixed checkout. Read `docs/local-companion.md` before installing it;
do not overwrite another registration or move the registered folder. Existing installations may continue using their original
checkout. Pairing tokens must never be committed. Use `-LocalOnly` if you want only the loopback app and no hosted-origin access.

Python3.10+ is sufficient for the basic companion; the optional raster-image writer requires Python3.11+ and explicit
`app/local/requirements-images.txt` installation. The separately configured text reflow editor needs Node24+ and a verified
runtime. This snapshot does not bundle its patched WASM, so a fresh installation must not assume long-PDF export is ready.
See the HTML guide and `docs/pdf-editor.md` for the real boundaries. The app itself should be served by a companion or an
appropriate static host, not assumed fully functional when `index.html` is double-clicked as a local file.

## Source and scope

- Upstream: https://github.com/Shinick-Han/falsify-workbench
- Frozen application snapshot: `352cee83a0ec3d35a88d6df1bd3d6eb8a2735da5` (tag `v0.2.0-alpha.3`).
- The HTML guide and its focused test are a documentation-only overlay; its exact source commit and guide file hash are recorded in `INTEGRATION-SOURCE.json`.
- `LICENSE`, `NOTICE`, vendor notices and the original source layout are retained here. Workbench is AGPL-3.0-only; this does
  not relabel all code in the team repository. Native optional dependencies retain their own licenses and are not bundled.
- No private research papers, changed papers, gold labels, harnesses, recordings, run/review backups, tokens, environments,
  `.pdf-editor.local.json`, model artifacts or locally patched editor WASM are included.
- The nested `.github/workflows/` files are upstream CI templates, not active root workflows. Team automation or deployment
  needs a separately reviewed change; none was installed or triggered by moving the template files into this subtree.

## Maintainer checks

From `tools/workbench/app`, `node scripts/test.mjs` checks the browser contracts; the guide's focused check is
`node tests/guide.spec.cjs`. From `tools/workbench`, install the pinned Python requirements into your own `.venv`, then run
`python -m unittest discover -s app/tests -p 'test_*.py'`. Do not upload the environment or test output.

Rendering checks are not scientific approval. BLUE currently consumes extracted text, not figure pixels; manual raster
replacement must not be counted as model-driven RED performance or as reasoning evasion. Runtime/source-only and support
limits are detailed in the guide and retained technical docs.

# GitHub Pages release

The public repository is application-only, with a new Git history. It is not a mirror of the private research repository. Only `app/dist` is uploaded as the Pages artifact; Python, research notes, local records and answer keys are not served by Pages. The local companion and synthetic tests are source downloads from the public repository.

Enable Pages with GitHub Actions as source. Push to `main` triggers `.github/workflows/pages.yml`, which runs synthetic Python and browser contract tests before deploying the static directory. No model calls are made by CI. The source must retain relative asset URLs so it works under `/falsify-workbench/`.

No third-party binaries for Python dependencies are bundled. Browser parser assets retain their license notices. Optional PyMuPDF is installed by users and has AGPL/commercial license obligations. Authored Workbench application code is AGPL-3.0-only; the hosted frontend links to the complete source repository. Uploaded user documents, harnesses and records are excluded. The separate AGPL PDF editor runs only in an explicitly configured local companion; its corresponding source and notices are linked in `NOTICE` and `docs/pdf-editor.md`.

The separate private research repository and private hosted Site are unchanged. Changes made to this public companion are not silently applied to the user's existing live experiment tab or broker. An explicit later integration/restart should preserve or back up origin-local records before switching origins.

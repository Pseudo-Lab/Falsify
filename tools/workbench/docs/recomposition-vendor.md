# Recomposition runtime vendor

The build inputs are isolated from the app's package dependencies. From the repository root, with Node.js and Python available:

```sh
npm ci --prefix app/vendor-build
python -m venv /tmp/falsify-font-venv
/tmp/falsify-font-venv/bin/python -m pip install -r app/vendor-build/requirements.txt
/tmp/falsify-font-venv/bin/python app/scripts/generate-recomposition-fonts.py --sources /tmp/falsify-font-sources --output /tmp/falsify-static-fonts
node app/scripts/build-recomposition-runtime.mjs --node-modules app/vendor-build/node_modules --static-fonts /tmp/falsify-static-fonts --font-sources /tmp/falsify-font-sources --output /tmp/falsify-recomposition-dist
node --test scripts/packaging.spec.mjs
```

On Windows use the virtual environment's `Scripts/python.exe` and suitable temporary paths. `npm ci` uses the dedicated lockfile; the font generator fetches four variable fonts and two notices from the exact Google Fonts commit when absent. Both tools can run offline after these inputs are cached. The generator verifies source, license and generated face hashes against the committed provenance, and fails on byte drift. It never substitutes another font. It uses fonttools 4.66.0, instantiated at width 100 and weights 400/700, with explicit static name and style metadata. The generated manifest is the committed `static-font-provenance.json`, including source hashes, coverage and notices. The eight modified Noto fonts and their SIL OFL 1.1 notices originate from [Google Fonts at e7db6ca603fd4862010383ff17ffd6cc4ffac1c0](https://github.com/google/fonts/tree/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl). Static faces avoid the previous Typst selection of regular for variable bold.

The build verifies the pinned compiler WASM and font hashes, and writes to `--output`; omit it to write to `app/dist`. It uses Typst.ts and web compiler 0.7.0 (Apache-2.0, [source](https://github.com/Myriad-Dreamin/typst.ts)), esbuild 0.28.2 and MuPDF 1.28.1. Four Liberation Sans faces and their license are read from the committed PDF.js `app/dist/vendor/standard_fonts` distribution. The worker uses the existing MuPDF vendor at `../browser-pdf-vendor/` (AGPL-3.0-or-later; see its NOTICE and manifest) and PDF.js under `../vendor/`. The output includes the Typst and font notices. The font set is finite and does not guarantee coverage for every paper or language.

The runtime manifest pins the compiler and distributed fonts; URLs remain relative to the manifest. The build stages source and npm inputs under stable relative names before invoking esbuild, and writes `recomposition-build-receipt.json` with hashes of the actual bundled inputs, package manifests, and outputs. The ordinary test checks the committed source and outputs against that receipt. To additionally rebuild from two separate source and module roots, set `FALSIFY_RECOMPOSITION_MODULES`, `FALSIFY_RECOMPOSITION_FONTS`, and `FALSIFY_RECOMPOSITION_FONT_SOURCES` to the corresponding absolute input directories before running `node --test app/tests/recomposition-build-equivalence.spec.mjs`. Without those inputs that rebuild test is explicitly skipped. The packaging test checks the committed package, not an arbitrary temporary output. A successful build is not by itself a browser activation or real-paper roundtrip test.

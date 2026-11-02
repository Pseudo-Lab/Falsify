# DocVortex PDF source-project adapter

The bridge uses the released `docvortex==0.6.9` Python wheel. The assigned fork's `v0.6.9` tag points to `a4f6e7a42268f1676b53d3640f45e21bf3cb1070` (https://github.com/Shinick-Han/DocVortex); the wheel is the PyPI release, not a wheel built from that checkout. The source was inspected at that commit; binary equivalence to a locally built fork wheel has not been established. DocVortex is MIT AND Apache-2.0 AND BSD-3-Clause according to its metadata.

From the repository root on Windows:

```powershell
python -m venv app/.local/docvortex-env
app/.local/docvortex-env/Scripts/python.exe -m pip install -r app/local/requirements-docvortex.txt
app/.local/docvortex-env/Scripts/python.exe app/local/docvortex_bridge.py INPUT.pdf --output PROJECT.zip
app/.local/docvortex-env/Scripts/python.exe -m unittest discover -s app/local/tests -p test_docvortex_bridge.py -v
```

No input is uploaded. The ZIP contains upstream-generated `main.tex` and its genuine image assets. A separate `PROJECT.zip.diagnostics.json` contains bounded diagnostics and counts. Existing output and sidecar are never deliberately overwritten. Errors return a nonzero exit status. Source content, formulas, reading order and images must be reviewed; this is not a faithful-layout guarantee. The upstream renderer emits XeLaTeX/`ctexart` with Fandol and other packages; they must be installed locally to compile. It does not preserve original page geometry or type sizes. OCR is unsupported upstream. `--parse-mode txt` bypasses automatic OCR detection and can omit scanned content; use only on known text PDFs and inspect the result. The bridge rejects upstream content placeholders instead of claiming success.

DocVortex declares `mineru-magika` and ONNX Runtime as transitive dependencies in its distribution, despite this wave excluding the MinerU parsing framework; no MinerU parser or network inference is called here. This dependency footprint needs an integration decision. The adapter has not been wired into the app, and its LaTeX is not the Lua compiler's native contract.

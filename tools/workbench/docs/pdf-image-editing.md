# Replace one raster-image placement

This optional manual RED operation is separate from model-generated text candidates and their download. It does not run a
CLI, generate a scientific figure, approve an attack, or automatically send a result to BLUE. Keep the source and the edit
report private to RED/review; only share the downloaded experimental PDF when the team has approved its scope.

## Local setup

The image writer uses pikepdf/QPDF, Pillow and the existing PyMuPDF checker. In the project-local virtual environment with
Python **3.11+**, install the optional pinned dependencies explicitly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r app/local/requirements-images.txt
.\start-companion.ps1 -NoInstall
```

The ordinary launcher does not download these dependencies or models silently. Basic companion/text workflows retain their
existing Python requirement. Without image dependencies, the image capability is unavailable; other features remain usable.
After restarting, pair the hosted Workbench with the new terminal token. Do not put that token in a link or share it.

## Workflow

1. In RED, load a PDF and open **그림 한 곳 교체**.
2. Explicitly list its image placements. Each entry identifies a page and a position, not just a shared resource.
3. Select one supported placement and upload an **8-bit RGB or fully opaque RGBA PNG** replacement. Palette, grayscale,
   16-bit and transparent PNGs are outside this initial writer boundary. Check Before/After. The original placement size
   stays fixed: a different aspect ratio can stretch the PNG, so prepare a matching aspect ratio for scientific figures.
4. Confirm that this is an experimental copy and export it. The PDF and a separate JSON report are downloaded. Neither
   the source file nor the text-candidate download is overwritten; the report is not embedded in the PDF.

## Supported boundary

The first version targets **direct page-level, opaque raster Image XObjects**. A resource reused on the same page or across
pages can have one selected painting invocation changed: the replacement image and page resource dictionary are localized,
and only that invocation points at the new image. Image geometry, page size and unselected content must be preserved.

Form-contained/inline images, ambiguous clipping, transparent masks, unsupported transforms, cropped/rotated page mappings
and overlapping content require separate support; they are not silently reconstructed or flattened. Vector figures and
tables are not raster placements. A bounded or incomplete inventory is not evidence that every figure was inspected.

Inputs are capped at PDF25 MiB and PNG4 MiB/4 million pixels. Output is capped at64 MiB. Source hashes and painting-derived
IDs bind selection to the exact original. The companion re-derives the placement and quality region from source bytes,
not from a client-provided rectangle. The native child has a timeout and temporary-file cleanup, **not an OS memory sandbox**.

The writer checks page count/geometry, extracted text and rendered pixels outside the tight selected region; the selected
region must actually change. Its report calls this an **engine rendering check**, not independent scientific verification.
Coordinator cross-renderer checks on synthetic shared-image fixtures are separate evidence, not arbitrary-paper fidelity.
Current BLUE is **text-only**. Failure to read a changed image is not proof of sophisticated reasoning evasion or BLUE quality.

## OSS and distribution

The writer uses [pikepdf's content-stream/token APIs](https://pikepdf.readthedocs.io/en/latest/topics/content_streams.html),
not global shared-xref replacement or whole-page rasterization. pikepdf is MPL-2.0; underlying QPDF and native dependencies
have their own notices. Pillow has its own license. PyMuPDF remains AGPL/commercial; the Workbench source is AGPL-3.0.
The source release does not bundle the optional native wheels, private paper assets or the separate patched text-editor WASM.

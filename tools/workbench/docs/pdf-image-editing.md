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
3. Select one supported placement and upload an **8-bit RGB or RGBA PNG** replacement. RGB retains a supported original soft mask, mapped over the image regardless of replacement dimensions. RGBA uses the PNG alpha instead, including when fully opaque; it replaces any original mask. Palette, grayscale and 16-bit PNGs are unsupported. Check Before/After. The original placement size
   stays fixed: a different aspect ratio can stretch the PNG, so prepare a matching aspect ratio for scientific figures.
4. Confirm that this is an experimental copy and export it. The PDF and a separate JSON report are downloaded. Neither
   the source file nor the text-candidate download is overwritten; the report is not embedded in the PDF.

## Supported boundary

The writer supports **raster Image XObjects painted directly on a page or inside simple Form XObjects** (at most
three nested Forms). A resource or Form reused on the same page or across pages can have one selected painting invocation
changed. The writer clones only the selected Form ancestry, with separate Resources/XObject dictionaries at every level,
and renames exactly that chain's painting operands with pikepdf/QPDF raw tokens. Original shared Forms/images keep their
original references for all other uses. Image geometry, page size and unselected content must be preserved. Form matrices
and containing rectangular BBoxes are retained; the image's final affine transform must be nonsingular.

Existing clipping and later overlapping paint stay in place at the original operator. Inline images, Form transparency groups/masks, image stencils, explicit masks, soft masks with matte, unsupported transforms and cropped/rotated page mappings require separate support; they are not silently reconstructed or flattened. Vector figures and
tables are not raster placements. A bounded or incomplete inventory is not evidence that every figure was inspected.

Inputs are capped at PDF25 MiB and PNG4 MiB/4 million pixels. Output is capped at64 MiB. Source hashes and painting-derived
IDs bind selection to the exact original. The companion re-derives the placement and quality region from source bytes,
not from a client-provided rectangle. The native child has a timeout and temporary-file cleanup, **not an OS memory sandbox**.

The writer checks page count/geometry, extracted text and rendered pixels outside the tight selected region; the selected
region must actually change. For complex clips the region is the conservative image bounding box. For RGBA, an independently
rewritten opaque-alpha control must match the output exactly outside that region; its differences from the source are
limited to two values per channel. Both outputs must pass the same exact stream checks. Other pages remain pixel-identical. Decoded page and reachable Form streams are also compared by painting invocation: only the
selected ancestry's exact operand renames are allowed, so a shared Form changing elsewhere fails even if it causes no pixel
difference. Malformed painting operands or unbalanced graphics state make the affected scan incomplete and non-editable.
Its report calls this an **engine rendering check**, not independent scientific verification.
Coordinator cross-renderer checks on synthetic shared-image fixtures are separate evidence, not arbitrary-paper fidelity.
Current BLUE is **text-only**. Failure to read a changed image is not proof of sophisticated reasoning evasion or BLUE quality.

## OSS and distribution

The writer uses [pikepdf's content-stream/token APIs](https://pikepdf.readthedocs.io/en/latest/topics/content_streams.html),
not global shared-xref replacement or whole-page rasterization. pikepdf is MPL-2.0; underlying QPDF and native dependencies
have their own notices. Pillow has its own license. PyMuPDF remains AGPL/commercial; the Workbench source is AGPL-3.0.
The source release does not bundle the optional native wheels, private paper assets or the separate patched text-editor WASM.

Synthetic engine tests exercise one and two nested Forms repeated on the same and other pages, source immutability,
retained matrices/BBoxes/metadata, exact stream isolation and unselected pixel equality. They also exercise soft masks, alpha, complex clips, affine transforms and later paint, and refuse unsupported masks, transparency groups, singular transforms and ambiguous operators. This does not establish general publisher-figure
editing: vector/table reconstruction, annotations and complex compositing remain separate work.


## Layer and structure boundaries

Simple Form replacement excludes optional-content membership (`/OC`), tagged
Form/image ownership (`/StructParent`, `/StructParents`) and marked-content
operators inside a cloned Form. A default visible render cannot validate hidden
layer behavior or ParentTree/MCR associations. These cases retain the existing
`form-image` unsupported reason until their graphs can be cloned and verified.

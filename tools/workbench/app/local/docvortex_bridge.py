"""Convert a PDF into a DocVortex LaTeX project without uploading it."""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
import zipfile

VERSION = "0.6.9"


def convert(source: Path, output: Path, parse_mode: str = "auto") -> dict:
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise ValueError("Source must be an existing PDF file")
    if output.suffix.lower() != ".zip":
        raise ValueError("Output must have a .zip extension")
    sidecar = Path(str(output) + ".diagnostics.json")
    if output.exists() or sidecar.exists():
        raise FileExistsError("Output or diagnostics already exists; choose a new path")
    if not output.parent.is_dir():
        raise ValueError("Output directory does not exist")
    try:
        import docvortex
    except ImportError as exc:
        raise RuntimeError("DocVortex dependency unavailable; install app/local/requirements-docvortex.txt in the isolated environment") from exc
    if docvortex.__version__ != VERSION:
        raise RuntimeError(f"Expected docvortex {VERSION}, found {docvortex.__version__}")
    from docvortex.api import parse, render
    result = parse(source, parse_mode=parse_mode)
    artifact = render(result.middle_json, "latex", assets=result.assets)
    tex = artifact.content.decode("utf-8")
    if not tex.strip() or r"\begin{document}" not in tex or r"\end{document}" not in tex:
        raise ValueError("DocVortex returned an incomplete LaTeX document")
    # Upstream defines this macro in every preamble; actual uses mean missing content.
    if tex.count(r"\DocVortexPlaceholder{"):
        raise ValueError("DocVortex emitted a content placeholder; conversion is incomplete")
    diagnostics = list(result.diagnostics) + list(artifact.diagnostics)
    info = {
        "schema": "falsify.docvortex-diagnostics.v1", "docvortex_version": VERSION,
        "page_count": len(result.middle_json.pages), "asset_count": len(artifact.assets), "parse_mode": parse_mode,
        "diagnostics": [{"code": str(d.code)[:120], "message": str(d.message)[:500],
                         "page_index": d.page_index} for d in diagnostics[:100]],
        "diagnostics_truncated": max(0, len(diagnostics) - 100),
        "limitations": ["DocVortex extraction is a reconstruction; layout and content require review.",
                        "OCR is unsupported; LaTeX output requires XeLaTeX and ctexart."],
    }
    # Validate before creating a ZIP. AssetStore validates paths too, but keep the
    # archive boundary independent of package internals.
    assets = []
    for name, data in artifact.assets.items():
        p = PurePosixPath(name)
        if p.is_absolute() or ".." in p.parts or "\\" in name or name == "main.tex":
            raise ValueError("Unsafe or conflicting asset path")
        assets.append((name, data))
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".docvortex-", suffix=".zip", delete=False) as f:
            tmp = Path(f.name)
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("main.tex", artifact.content)
            for name, data in assets:
                z.writestr(name, data)
        # Exclusive creation prevents accidental overwrite, including races.
        import shutil
        with output.open("xb") as dest:
            try:
                with tmp.open("rb") as src:
                    shutil.copyfileobj(src, dest)
            except Exception:
                dest.close()
                output.unlink(missing_ok=True)
                raise
        try:
            with sidecar.open("x", encoding="utf-8", newline="\n") as f:
                json.dump(info, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception:
            output.unlink(missing_ok=True)
            raise
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    return info


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parse-mode", choices=("auto", "txt"), default="auto", help="txt bypasses OCR detection and may omit scanned content")
    args = parser.parse_args(argv)
    try:
        info = convert(args.source, args.output, args.parse_mode)
    except Exception as exc:
        print(f"DocVortex conversion failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"Created {args.output} ({info['page_count']} pages, {info['asset_count']} assets); diagnostics: {args.output}.diagnostics.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

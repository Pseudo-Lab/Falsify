"""Read-only figure/panel forensic sensor for the BLUE Layer 0 offline path.

Deterministic, network-free audit of figure panels placed in a prepared paper:
duplicate / mirrored / rotated / cropped panel reuse plus chart printed-value
versus prose claims. Perceptual hashes are computed from the rendered region
pixels, so no new dependency is required (``numpy`` is used when present and a
pure-Python fallback runs otherwise).
"""
import hashlib
import math
import re

import pymupdf

from paper_evidence_blue import require_summary
from paper_evidence_text import _open_pdf, _require_bound_pdf
from paper_stat_math import count_decimals

SCHEMA = "falsify.figure-forensics.v1"

MAX_FORENSIC_PAGES = 80
MAX_FIGURE_ITEMS = 500
MAX_PANEL_PIXELS = 24_000_000
NEAR_DUPLICATE_HAMMING = 6
AHASH_CONFIRM_HAMMING = 10
CROP_AREA_RATIO = 2.0
DHASH_COLS, DHASH_ROWS = 9, 8
AHASH_COLS, AHASH_ROWS = 8, 8

SKIP_BBOX_INVALID = "bbox_invalid"
SKIP_ZERO_AREA = "zero_area_bbox"
SKIP_STREAM_UNREADABLE = "image_stream_unreadable"
SKIP_RENDER_FAILED = "render_failed"
SKIP_PANEL_TOO_LARGE = "panel_too_large"
SKIP_HASH_FAILED = "hash_failed"

_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_CAPTION_RE = re.compile(r"^\s*(?:Figure|Fig\.?)\s*(\d{1,3}[A-Za-z]?)\s*[:.\-]", re.IGNORECASE)
_FIG_REF_RE = re.compile(r"\b(?:Figure|Fig\.?)\s*(\d{1,3}[A-Za-z]?)\b", re.IGNORECASE)
_PCT_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*%")
_ROW_SPLIT_RE = re.compile(r"[.!?]\s+|\r?\n{2,}")

_PAIR_SUBTYPES = {
    "duplicate_figure_panel": "image-reuse",
    "mirrored_figure_panel": "image-mirror",
    "rotated_figure_panel": "image-rotate",
    "cropped_figure_panel": "image-crop",
}


class _SkipPanel(Exception):
    """Internal control flow carrying a fixed skip reason code."""


def _default_store():
    from paper_evidence import default_store
    return default_store


def _assert_no_red_keys(obj):
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key in _FORBIDDEN_RED_KEYS:
                raise ValueError("forbidden_red_key")
            _assert_no_red_keys(val)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_red_keys(item)


def _signal(kind, page_index, excerpt, detail, reported, computed, subtype, item_id=None):
    sig = {
        "family": "D1" if kind == "chart_printed_value_mismatch" else "D4-1",
        "kind": kind,
        "subtype": subtype,
        "pageIndex": page_index,
        "excerpt": " ".join(str(excerpt or "").split())[:220],
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }
    if item_id is not None:
        sig["itemId"] = item_id
    return sig


def _validate_options(max_signals, dpi, max_figures):
    if isinstance(max_signals, bool) or type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")
    if isinstance(dpi, bool) or type(dpi) is not int or not 36 <= dpi <= 600:
        raise ValueError("dpi")
    if isinstance(max_figures, bool) or type(max_figures) is not int or not 1 <= max_figures <= 200:
        raise ValueError("max_figures")


def _numpy_module():
    try:
        import numpy
    except Exception:
        return None
    return numpy


def _bucket(size, count):
    if size <= 0 or count <= 0:
        raise ValueError("bucket_size")
    return [min(count - 1, (idx * count) // size) for idx in range(size)]


def _cell_means_pure(samples, width, height, ncomp, cols, rows):
    col_of = _bucket(width, cols)
    row_of = _bucket(height, rows)
    sums = [[0.0] * cols for _ in range(rows)]
    counts = [[0] * cols for _ in range(rows)]
    for y in range(height):
        base = y * width * ncomp
        cy = row_of[y]
        sum_row, count_row = sums[cy], counts[cy]
        for x in range(width):
            off = base + x * ncomp
            if ncomp >= 3:
                grey = 0.299 * samples[off] + 0.587 * samples[off + 1] + 0.114 * samples[off + 2]
            else:
                grey = samples[off]
            cx = col_of[x]
            sum_row[cx] += grey
            count_row[cx] += 1
    return [
        [sums[r][c] / counts[r][c] if counts[r][c] else 0.0 for c in range(cols)]
        for r in range(rows)
    ]


def _cell_means_numpy(numpy, samples, width, height, ncomp, cols, rows):
    flat = numpy.frombuffer(samples, dtype=numpy.uint8)
    arr = flat[: width * height * ncomp].reshape(height, width, ncomp).astype(numpy.float64)
    if ncomp >= 3:
        grey = arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114
    else:
        grey = arr[..., 0]
    col_of = numpy.asarray(_bucket(width, cols), dtype=numpy.int64)
    row_of = numpy.asarray(_bucket(height, rows), dtype=numpy.int64)
    index = row_of[:, None] * cols + col_of[None, :]
    totals = numpy.bincount(index.ravel(), weights=grey.ravel(), minlength=rows * cols)
    counts = numpy.bincount(index.ravel(), minlength=rows * cols)
    safe = numpy.where(counts == 0, 1, counts)
    return (totals / safe).reshape(rows, cols).tolist()


def _cell_means(samples, width, height, ncomp, cols, rows):
    """Box-downsample a rendered region to a grayscale ``rows`` x ``cols`` mean grid."""
    if width <= 0 or height <= 0 or ncomp <= 0 or not samples:
        raise ValueError("pixmap_empty")
    numpy = _numpy_module()
    if numpy is not None:
        try:
            return _cell_means_numpy(numpy, samples, width, height, ncomp, cols, rows)
        except Exception:
            pass
    return _cell_means_pure(samples, width, height, ncomp, cols, rows)


def _dhash(grid):
    bits = 0
    for row in grid:
        for idx in range(len(row) - 1):
            bits = (bits << 1) | (1 if row[idx] < row[idx + 1] else 0)
    return bits


def _ahash(grid):
    flat = [value for row in grid for value in row]
    mean = sum(flat) / len(flat)
    bits = 0
    for value in flat:
        bits = (bits << 1) | (1 if value >= mean else 0)
    return bits


def _hamming(left, right):
    return bin(int(left) ^ int(right)).count("1")


def _flip_grid(grid, mode):
    """Return the horizontally/vertically mirrored or 180-degree rotated grid."""
    if mode == "h":
        return [list(reversed(row)) for row in grid]
    if mode == "v":
        return [list(row) for row in reversed(grid)]
    return [list(reversed(row)) for row in reversed(grid)]


def _grid_hashes(pix):
    """Perceptual hashes (plain dHash/aHash plus mirrored and rotated variants)."""
    coarse = _cell_means(pix.samples, pix.width, pix.height, pix.n, DHASH_COLS, DHASH_ROWS)
    fine = _cell_means(pix.samples, pix.width, pix.height, pix.n, AHASH_COLS, AHASH_ROWS)
    return {
        "dhash": _dhash(coarse),
        "ahash": _ahash(fine),
        "dhashH": _dhash(_flip_grid(coarse, "h")),
        "dhashV": _dhash(_flip_grid(coarse, "v")),
        "dhashR": _dhash(_flip_grid(coarse, "r")),
        "ahashH": _ahash(_flip_grid(fine, "h")),
        "ahashV": _ahash(_flip_grid(fine, "v")),
        "ahashR": _ahash(_flip_grid(fine, "r")),
    }


def _image_sha(doc, xref):
    """sha256 of the placed image stream, or ``None`` when the panel carries no xref."""
    if isinstance(xref, bool) or not isinstance(xref, int) or xref <= 0:
        return None
    if not hasattr(doc, "xref_stream"):
        return None
    try:
        stream = doc.xref_stream(xref)
    except Exception:
        raise _SkipPanel(SKIP_STREAM_UNREADABLE) from None
    if not stream:
        raise _SkipPanel(SKIP_STREAM_UNREADABLE)
    return hashlib.sha256(stream).hexdigest()


def _skip(page_index, reason, bbox=None, xref=None):
    return {"pageIndex": page_index, "reason": reason, "bbox": bbox, "xref": xref}


def _panel_bbox(info):
    raw = info.get("bbox")
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        raise _SkipPanel(SKIP_BBOX_INVALID)
    bbox = [round(float(value), 3) for value in raw]
    if bbox[2] - bbox[0] <= 0 or bbox[3] - bbox[1] <= 0:
        raise _SkipPanel(SKIP_ZERO_AREA)
    return bbox


def _render_panel(doc, page_index, bbox, dpi):
    page = doc[page_index]
    pix = page.get_pixmap(clip=pymupdf.Rect(bbox), dpi=dpi, alpha=False)
    if pix.width <= 0 or pix.height <= 0 or not pix.samples:
        raise _SkipPanel(SKIP_RENDER_FAILED)
    if pix.width * pix.height > MAX_PANEL_PIXELS:
        raise _SkipPanel(SKIP_PANEL_TOO_LARGE)
    return pix


def _panel_record(doc, page_index, index_on_page, info, dpi, skipped):
    bbox = xref = None
    try:
        bbox = _panel_bbox(info)
        xref = info.get("xref") if isinstance(info.get("xref"), int) else None
        image_sha = _image_sha(doc, xref)
        pix = _render_panel(doc, page_index, bbox, dpi)
        hashes = _grid_hashes(pix)
    except _SkipPanel as exc:
        skipped.append(_skip(page_index, exc.args[0], bbox, xref))
        return None
    except Exception:
        skipped.append(_skip(page_index, SKIP_HASH_FAILED, bbox, xref))
        return None
    record = {
        "label": f"p{page_index + 1}-{index_on_page + 1}",
        "pageIndex": page_index,
        "bbox": bbox,
        "xref": xref,
        "imageSha": image_sha,
        "area": (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]),
    }
    record.update(hashes)
    return record


def _page_panels(doc, page_index, dpi, remaining, skipped):
    panels, done = [], False
    try:
        infos = doc[page_index].get_image_info(xrefs=True)
    except Exception:
        skipped.append(_skip(page_index, SKIP_RENDER_FAILED))
        return panels, done
    for index_on_page, info in enumerate(infos or []):
        if len(panels) >= remaining:
            done = True
            break
        if not isinstance(info, dict):
            skipped.append(_skip(page_index, SKIP_BBOX_INVALID))
            continue
        record = _panel_record(doc, page_index, index_on_page, info, dpi, skipped)
        if record is not None:
            panels.append(record)
    return panels, done


def _enumerate_panels(doc, dpi, max_figures):
    panels, skipped, truncated = [], [], False
    for page_index in range(min(doc.page_count, MAX_FORENSIC_PAGES)):
        remaining = max_figures - len(panels)
        if remaining <= 0:
            truncated = True
            break
        found, full = _page_panels(doc, page_index, dpi, remaining, skipped)
        panels.extend(found)
        if full:
            truncated = True
            break
    return panels, skipped, truncated


def _crop_hamming(doc, big, small, dpi):
    """Hamming distance between the centred sub-window of the larger panel and the smaller one."""
    if small["area"] <= 0 or big["area"] < CROP_AREA_RATIO * small["area"]:
        return None
    scale = math.sqrt(small["area"] / big["area"])
    center_x = 0.5 * (big["bbox"][0] + big["bbox"][2])
    center_y = 0.5 * (big["bbox"][1] + big["bbox"][3])
    half_w = 0.5 * (big["bbox"][2] - big["bbox"][0]) * scale
    half_h = 0.5 * (big["bbox"][3] - big["bbox"][1]) * scale
    clip = pymupdf.Rect(center_x - half_w, center_y - half_h, center_x + half_w, center_y + half_h)
    try:
        pix = doc[big["pageIndex"]].get_pixmap(clip=clip, dpi=dpi, alpha=False)
        grid = _cell_means(pix.samples, pix.width, pix.height, pix.n, DHASH_COLS, DHASH_ROWS)
    except Exception:
        return None
    return _hamming(_dhash(grid), small["dhash"])


def _flip_hamming(a, b, axis):
    """Smallest dHash distance between one panel's axis flip and the other panel."""
    return min(
        _hamming(a[f"dhash{axis}"], b["dhash"]),
        _hamming(a["dhash"], b[f"dhash{axis}"]),
    )


def _flip_confirmed(a, b, axis):
    """aHash confirmation for an axis flip, so a 180-degree rotation is not read as a mirror."""
    return min(
        _hamming(a[f"ahash{axis}"], b["ahash"]),
        _hamming(a["ahash"], b[f"ahash{axis}"]),
    ) <= AHASH_CONFIRM_HAMMING


def _rotation_relation(a, b):
    distance = min(_hamming(a["dhashR"], b["dhash"]), _hamming(a["dhash"], b["dhashR"]))
    confirmed = min(_hamming(a["ahashR"], b["ahash"]), _hamming(a["ahash"], b["ahashR"])) <= AHASH_CONFIRM_HAMMING
    if distance <= NEAR_DUPLICATE_HAMMING and confirmed:
        return "rotated_figure_panel", distance
    return None


def _classify_pair(doc, a, b, dpi):
    """Return ``(kind, hamming)`` for the strongest detected panel relation, else ``None``."""
    hamming = _hamming(a["dhash"], b["dhash"])
    if hamming <= NEAR_DUPLICATE_HAMMING and _hamming(a["ahash"], b["ahash"]) <= AHASH_CONFIRM_HAMMING:
        return "duplicate_figure_panel", hamming
    for axis in ("H", "V"):
        distance = _flip_hamming(a, b, axis)
        if distance <= NEAR_DUPLICATE_HAMMING and _flip_confirmed(a, b, axis):
            return "mirrored_figure_panel", distance
    rotated = _rotation_relation(a, b)
    if rotated is not None:
        return rotated
    big, small = (a, b) if a["area"] >= b["area"] else (b, a)
    cropped = _crop_hamming(doc, big, small, dpi)
    if cropped is not None and cropped <= NEAR_DUPLICATE_HAMMING:
        return "cropped_figure_panel", cropped
    return None


def _pair_signal(a, b, kind, hamming):
    shared = bool(
        (a.get("xref") and a.get("xref") == b.get("xref"))
        or (a.get("imageSha") and a.get("imageSha") == b.get("imageSha"))
    )
    pages = [a["pageIndex"], b["pageIndex"]]
    bboxes = [a["bbox"], b["bbox"]]
    label = f"panels {a['label']} and {b['label']}"
    detail = {
        "duplicate_figure_panel": f"Figure {label} share near-identical rendered content (hamming {hamming}).",
        "mirrored_figure_panel": f"Figure {label} match after mirroring (hamming {hamming}).",
        "rotated_figure_panel": f"Figure {label} match after a 180-degree rotation (hamming {hamming}).",
        "cropped_figure_panel": f"Figure {label} match as a centred crop of the larger panel (hamming {hamming}).",
    }[kind]
    return _signal(
        kind,
        a["pageIndex"],
        f"{a['label']} {a['bbox']} vs {b['label']} {b['bbox']}",
        detail,
        {"panels": [a["label"], b["label"]], "xrefs": [a.get("xref"), b.get("xref")], "sharedImage": shared},
        {
            "pageIndexes": pages,
            "bboxes": bboxes,
            "hamming": int(hamming),
            "hashKind": "dhash",
            "imageShas": [a.get("imageSha"), b.get("imageSha")],
            "sharedImage": shared,
        },
        _PAIR_SUBTYPES[kind],
    )


def _pair_checks(doc, panels, dpi):
    signals, pairs, seen = [], [], set()
    for left in range(len(panels)):
        for right in range(left + 1, len(panels)):
            a, b = panels[left], panels[right]
            relation = _classify_pair(doc, a, b, dpi)
            if relation is None:
                continue
            kind, hamming = relation
            key = tuple(sorted((a["label"], b["label"])))
            if key in seen:
                continue
            seen.add(key)
            pairs.append({"a": a["label"], "b": b["label"], "relation": kind, "hamming": int(hamming)})
            signals.append(_pair_signal(a, b, kind, hamming))
    return signals, pairs


def _figure_label(item):
    caption = item.get("caption")
    if not isinstance(caption, str):
        return None
    match = _CAPTION_RE.match(caption) or _FIG_REF_RE.search(caption)
    return match.group(1) if match else None


def _item_bbox(item):
    raw = item.get("bbox")
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            return [round(float(value), 3) for value in raw]
        except (TypeError, ValueError):
            return []
    return []


def _printed_percentages(item):
    """Percentages already extracted on the item (printed, then vector/reconciled values)."""
    found = []
    for source in (item, item.get("chart")):
        if not isinstance(source, dict):
            continue
        for key in ("printedValues", "vectorValues", "reconciledValues"):
            for entry in source.get(key) or []:
                if not isinstance(entry, dict):
                    continue
                for match in _PCT_RE.finditer(str(entry.get("rawText") or "")):
                    found.append((float(match.group(1)), count_decimals(match.group(1))))
                unit = str(entry.get("unit") or "").strip()
                if not entry.get("rawText") and unit == "%" and isinstance(entry.get("value"), (int, float)):
                    found.append((float(entry["value"]), count_decimals(entry["value"])))
    return sorted(set(found))


def _pct_matches(target, decimals, pool):
    tolerance = max(0.15, 0.5 * (10.0 ** (-decimals)))
    return any(abs(target - cand) <= max(tolerance, 0.5 * (10.0 ** (-cand_dec))) for cand, cand_dec in pool)


def _prose_sentences(text):
    return [" ".join(chunk.split()) for chunk in _ROW_SPLIT_RE.split(str(text or "")) if chunk.strip()]


def _prose_bbox(blocks, needle):
    for block in blocks or []:
        if not isinstance(block, dict) or needle not in str(block.get("text") or ""):
            continue
        bbox = block.get("bbox")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            try:
                return [round(float(value), 3) for value in bbox]
            except (TypeError, ValueError):
                return []
    return []


def _chart_claim_signals(item, page_index, page_text, blocks):
    label, printed = _figure_label(item), _printed_percentages(item)
    if not label or not printed:
        return []
    figure_bbox = _item_bbox(item)
    signals = []
    for sentence in _prose_sentences(page_text):
        if _CAPTION_RE.match(sentence):
            continue
        if not any(match.group(1).lower() == label.lower() for match in _FIG_REF_RE.finditer(sentence)):
            continue
        for match in _PCT_RE.finditer(sentence):
            value = float(match.group(1))
            if _pct_matches(value, count_decimals(match.group(1)), printed):
                continue
            nearest = min(printed, key=lambda cand: abs(cand[0] - value))
            signals.append(_signal(
                "chart_printed_value_mismatch", page_index, sentence,
                f"Prose citing Figure {label} states {value}% while the figure prints {nearest[0]}%.",
                {"printed": nearest[0], "bbox": figure_bbox, "figure": f"Figure {label}"},
                {"proseValue": value, "proseBbox": _prose_bbox(blocks, match.group(0)), "pageIndex": page_index},
                "chart-claim", item.get("id"),
            ))
    return signals


def _collect_items(store, paper_id, file_hash):
    items, offset = [], 0
    for _ in range(64):
        page = store.list_items(paper_id, kind=None, page_index=None, offset=offset, limit=50)
        batch = page.get("items") or []
        for meta in batch:
            if not isinstance(meta, dict) or "id" not in meta:
                continue
            item = store.read_item(paper_id, meta["id"])
            if "fileHash" in item and item.get("fileHash") != file_hash:
                raise ValueError("paper_evidence_hash_mismatch")
            items.append(item)
            if len(items) >= MAX_FIGURE_ITEMS:
                return items
        next_offset = page.get("nextOffset")
        if next_offset is None or not batch or type(next_offset) is not int or next_offset <= offset:
            break
        offset = next_offset
    return items


def _page_context(store, paper_id, page_index, cache):
    if page_index in cache:
        return cache[page_index]
    context = {"text": "", "blocks": []}
    try:
        from paper_evidence_text import read_page_text
        page = read_page_text(paper_id, page_index, store=store)
        context = {"text": page.get("text") or "", "blocks": page.get("blocks") or []}
    except Exception:
        context = {"text": "", "blocks": []}
    cache[page_index] = context
    return context


def _chart_claim_signals_all(store, paper_id, file_hash, max_figures):
    if not hasattr(store, "list_items") or not hasattr(store, "read_item"):
        return []
    try:
        items = _collect_items(store, paper_id, file_hash)
    except Exception:
        return []
    figures = [item for item in items if isinstance(item, dict) and item.get("type") == "figure"]
    cache, signals = {}, []
    for item in figures[:max_figures]:
        page_index = item.get("pageIndex")
        if type(page_index) is not int or page_index < 0:
            page_index = 0
        context = _page_context(store, paper_id, page_index, cache)
        signals.extend(_chart_claim_signals(item, page_index, context["text"], context["blocks"]))
    return signals


def _dedupe_and_cap(signals, max_signals):
    seen, unique = set(), []
    for sig in signals:
        key = (sig["kind"], sig["pageIndex"], sig.get("itemId"), sig["excerpt"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    truncated = len(unique) > max_signals
    numbered = [{"id": f"fig-{index + 1}", **sig} for index, sig in enumerate(unique[:max_signals])]
    return numbered, truncated


def audit_figure_forensics(paper_id, file_hash=None, *, max_signals=30, dpi=96, max_figures=24, store=None):
    """Deterministically audit placed figure panels and chart printed values (offline, read-only)."""
    _validate_options(max_signals, dpi, max_figures)
    store = _default_store() if store is None else store
    paper_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)

    with _open_pdf(raw) as doc:
        panels, skipped, panels_truncated = _enumerate_panels(doc, dpi, max_figures)
        pair_signals, pairs = _pair_checks(doc, panels, dpi)
    chart_signals = _chart_claim_signals_all(store, paper_id, actual_hash, max_figures)
    numbered, signals_truncated = _dedupe_and_cap(pair_signals + chart_signals, max_signals)
    result = {
        "schema": SCHEMA,
        "paperId": paper_id,
        "fileHash": actual_hash,
        "figureCount": len(panels),
        "signalCount": len(numbered),
        "truncated": bool(panels_truncated or signals_truncated),
        "signals": numbered,
        "pairs": pairs,
        "skipped": skipped,
    }
    _assert_no_red_keys(result)
    return result

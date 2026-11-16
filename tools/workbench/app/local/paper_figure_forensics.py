"""Read-only figure/panel forensic sensor for the BLUE Layer 0 offline path.

Deterministic, network-free audit of figure panels placed in a prepared paper:
duplicate / mirrored / rotated / cropped panel reuse, intra-figure sub-panel
reuse, distorted chart axes, plus chart printed-value versus prose claims.
Perceptual hashes are computed from the rendered region pixels, so no new
dependency is required (``numpy`` is used when present and a pure-Python
fallback runs otherwise).
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
_KIND_FAMILY = {
    "chart_printed_value_mismatch": "D1",
    "axis_scale_distortion": "D4-2",
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
        "family": _KIND_FAMILY.get(kind, "D4-1"),
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


class _PixView:
    """Attribute view so cropped samples can reuse ``_grid_hashes``."""

    def __init__(self, samples, width, height, ncomp):
        self.samples = samples
        self.width = width
        self.height = height
        self.n = ncomp


def _grey(samples, width, ncomp, x, y):
    off = (y * width + x) * ncomp
    if ncomp >= 3:
        return 0.299 * samples[off] + 0.587 * samples[off + 1] + 0.114 * samples[off + 2]
    return float(samples[off])


def _population_std(samples, width, height, ncomp):
    count = width * height
    if count <= 0 or ncomp <= 0:
        return 0.0
    total = 0.0
    total_sq = 0.0
    for y in range(height):
        for x in range(width):
            grey = _grey(samples, width, ncomp, x, y)
            total += grey
            total_sq += grey * grey
    mean = total / count
    variance = max(0.0, total_sq / count - mean * mean)
    return math.sqrt(variance)


def _line_stats(samples, width, height, ncomp, along):
    """Per-column (``along='x'``) or per-row mean and population stddev."""
    count = width if along == "x" else height
    span = height if along == "x" else width
    stats = []
    for index in range(count):
        total = 0.0
        total_sq = 0.0
        for step in range(span):
            x, y = (index, step) if along == "x" else (step, index)
            grey = _grey(samples, width, ncomp, x, y)
            total += grey
            total_sq += grey * grey
        mean = total / span if span else 0.0
        variance = max(0.0, total_sq / span - mean * mean) if span else 0.0
        stats.append((mean, math.sqrt(variance)))
    return stats


def _gutter_mask(stats):
    flags = [False] * len(stats)
    start = None
    padded = list(stats) + [(None, None)]
    for index, (mean, std) in enumerate(padded):
        gutter = std is not None and std < 3.0 and (mean >= 240.0 or mean <= 15.0)
        if gutter and start is None:
            start = index
        if not gutter and start is not None:
            if index - start >= 4:
                flags[start:index] = [True] * (index - start)
            start = None
    return flags


def _content_runs(flags):
    runs, start = [], None
    for index, gutter in enumerate(flags):
        if gutter and start is not None:
            runs.append((start, index))
            start = None
        elif not gutter and start is None:
            start = index
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _boxes_for(runs, full, vertical):
    boxes = []
    for start, end in runs:
        if vertical:
            box = (start, 0, end, full)
            wide, tall = end - start, full
        else:
            box = (0, start, full, end)
            wide, tall = full, end - start
        if wide >= 32 and tall >= 24:
            boxes.append(box)
    if 2 <= len(boxes) <= 6:
        return boxes
    return []


def _split_boxes(samples, width, height, ncomp):
    columns = _boxes_for(_content_runs(_gutter_mask(_line_stats(samples, width, height, ncomp, "x"))), height, True)
    if columns:
        return columns
    return _boxes_for(_content_runs(_gutter_mask(_line_stats(samples, width, height, ncomp, "y"))), width, False)


def _crop_samples(samples, width, ncomp, box):
    x0, y0, x1, y1 = box
    rows = []
    row_bytes = (x1 - x0) * ncomp
    for y in range(y0, y1):
        start = (y * width + x0) * ncomp
        rows.append(bytes(samples[start:start + row_bytes]))
    return b"".join(rows), x1 - x0, y1 - y0


def _textured(samples, width, height, ncomp, boxes):
    kept = []
    for box in boxes:
        crop, crop_w, crop_h = _crop_samples(samples, width, ncomp, box)
        if _population_std(crop, crop_w, crop_h, ncomp) < 12.0:
            continue
        kept.append((box, crop, crop_w, crop_h))
    if 2 <= len(kept) <= 6:
        return kept
    return []


def _subpanel_hashes(crop, crop_w, crop_h, ncomp):
    return _grid_hashes(_PixView(crop, crop_w, crop_h, ncomp))


def _hash_distance(left, right):
    plain_d = _hamming(left["dhash"], right["dhash"])
    plain_a = _hamming(left["ahash"], right["ahash"])
    if plain_d <= NEAR_DUPLICATE_HAMMING and plain_a <= AHASH_CONFIRM_HAMMING:
        return plain_d, False
    mirror_d = min(_hamming(left["dhashH"], right["dhash"]), _hamming(left["dhash"], right["dhashH"]))
    mirror_a = min(_hamming(left["ahashH"], right["ahash"]), _hamming(left["ahash"], right["ahashH"]))
    if mirror_d <= NEAR_DUPLICATE_HAMMING and mirror_a <= AHASH_CONFIRM_HAMMING:
        return mirror_d, True
    return None


def _page_box(panel_bbox, pix_w, pix_h, box):
    x0, y0, x1, y1 = panel_bbox
    scale_x = (x1 - x0) / pix_w if pix_w else 0.0
    scale_y = (y1 - y0) / pix_h if pix_h else 0.0
    return [
        round(x0 + box[0] * scale_x, 3),
        round(y0 + box[1] * scale_y, 3),
        round(x0 + box[2] * scale_x, 3),
        round(y0 + box[3] * scale_y, 3),
    ]


def _subpanel_signal(panel, left, right, distance, mirrored):
    label = panel["label"]
    return _signal(
        "composite_subpanel_duplicate",
        panel["pageIndex"],
        f"{label} subpanels {left['page']} vs {right['page']}",
        f"Sub-panels of {label} match within dHash hamming {distance}.",
        {"panel": label, "bboxes": [left["page"], right["page"]], "mirrored": mirrored},
        {
            "bboxes": [left["page"], right["page"]],
            "pixelBoxes": [list(left["pixel"]), list(right["pixel"])],
            "hamming": int(distance),
            "hashKind": "dhash",
            "mirrored": mirrored,
        },
        "intra-figure-subpanel-reuse",
    )


def _hashed_subpanels(panel, textured, pix_w, pix_h, ncomp):
    hashed = []
    for box, crop, crop_w, crop_h in textured:
        record = {"pixel": box, "page": _page_box(panel["bbox"], pix_w, pix_h, box)}
        record.update(_subpanel_hashes(crop, crop_w, crop_h, ncomp))
        hashed.append(record)
    return hashed


def _subpanel_pairs(panel, hashed):
    signals = []
    for left_index in range(len(hashed)):
        for right_index in range(left_index + 1, len(hashed)):
            relation = _hash_distance(hashed[left_index], hashed[right_index])
            if relation is None:
                continue
            distance, mirrored = relation
            signals.append(_subpanel_signal(panel, hashed[left_index], hashed[right_index], distance, mirrored))
    return signals


def _render_subpanel(doc, panel, dpi):
    try:
        return _render_panel(doc, panel["pageIndex"], panel["bbox"], max(int(dpi), 120))
    except (_SkipPanel, Exception):
        return None


def _panel_subpanel_signals(doc, panel, dpi):
    pix = _render_subpanel(doc, panel, dpi)
    if pix is None or pix.width < 120 or pix.height < 50:
        return []
    boxes = _split_boxes(pix.samples, pix.width, pix.height, pix.n)
    textured = _textured(pix.samples, pix.width, pix.height, pix.n, boxes)
    if not textured:
        return []
    hashed = _hashed_subpanels(panel, textured, pix.width, pix.height, pix.n)
    return _subpanel_pairs(panel, hashed)


def _subpanel_signals(doc, panels, dpi):
    signals = []
    for panel in panels:
        signals.extend(_panel_subpanel_signals(doc, panel, dpi))
    return signals


_TICK_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$")


def _tick_value(text):
    if _TICK_RE.fullmatch(text):
        return float(text)
    return None


def _page_words(page):
    try:
        return page.get_text("words") or []
    except Exception:
        return []


def _word_ticks(page):
    ticks = []
    for word in _page_words(page):
        if not isinstance(word, (list, tuple)) or len(word) < 5:
            continue
        value = _tick_value(str(word[4]))
        if value is None:
            continue
        x0, y0, x1, y1 = (float(word[0]), float(word[1]), float(word[2]), float(word[3]))
        ticks.append({
            "value": value,
            "text": str(word[4]),
            "bbox": (x0, y0, x1, y1),
            "cx": (x0 + x1) / 2.0,
            "cy": (y0 + y1) / 2.0,
        })
    return ticks


def _clusters(ticks, key, tol):
    groups, current, anchor = [], [], None
    for tick in sorted(ticks, key=lambda item: item[key]):
        if anchor is None or abs(tick[key] - anchor) <= tol:
            current.append(tick)
            if anchor is None:
                anchor = tick[key]
            continue
        groups.append(current)
        current, anchor = [tick], tick[key]
    if current:
        groups.append(current)
    return groups


def _ordered_sequence(ticks, axis):
    key = "cx" if axis == "h" else "cy"
    ordered, seq = sorted(ticks, key=lambda item: item[key]), []
    for tick in ordered:
        if seq and tick[key] - seq[-1][key] < 2.0:
            continue
        seq.append(tick)
    return seq


def _axis_gaps(seq, axis):
    key = "cx" if axis == "h" else "cy"
    return [seq[index + 1][key] - seq[index][key] for index in range(len(seq) - 1)]


def _values_reverse(values):
    diffs = [values[index + 1] - values[index] for index in range(len(values) - 1)]
    return any(diff > 1e-9 for diff in diffs) and any(diff < -1e-9 for diff in diffs)


def _consistent_ratios(values):
    if any(value <= 0 for value in values):
        return False
    ratios = [values[index + 1] / values[index] for index in range(len(values) - 1)]
    if not ratios or min(ratios) <= 0:
        return False
    return max(ratios) / min(ratios) <= 1.2


def _equal_spacing(gaps):
    if not gaps or any(gap <= 0.5 for gap in gaps):
        return False
    return max(gaps) / min(gaps) <= 1.25


def _slope_ratio_exceeds(slopes):
    for left, right in zip(slopes, slopes[1:]):
        low, high = min(left, right), max(left, right)
        if low > 0 and high / low > 2.5:
            return True
    return False


def _slope_jump(values, gaps):
    slopes = []
    for gap, left, right in zip(gaps, values, values[1:]):
        delta = abs(right - left)
        if delta < 1e-9:
            return False
        slopes.append(gap / delta)
    return _slope_ratio_exceeds(slopes)


def _break_near(page, seq):
    xs = [tick["bbox"][0] for tick in seq] + [tick["bbox"][2] for tick in seq]
    ys = [tick["bbox"][1] for tick in seq] + [tick["bbox"][3] for tick in seq]
    box = (min(xs) - 48.0, min(ys) - 36.0, max(xs) + 48.0, max(ys) + 36.0)
    for word in _page_words(page):
        if not isinstance(word, (list, tuple)) or len(word) < 5:
            continue
        text = str(word[4])
        if "//" not in text and "≈" not in text:
            continue
        cx = (float(word[0]) + float(word[2])) / 2.0
        cy = (float(word[1]) + float(word[3])) / 2.0
        if box[0] <= cx <= box[2] and box[1] <= cy <= box[3]:
            return True
    return False


def _distortion_reason(values, gaps, broken):
    if _values_reverse(values):
        return "nonmonotonic"
    if broken or _consistent_ratios(values) or not _equal_spacing(gaps):
        return None
    if _slope_jump(values, gaps):
        return "slope"
    return None


def _axis_signal(page_index, seq, axis, reason, values, extra):
    excerpt = ", ".join(tick["text"] for tick in seq)
    bboxes = [[round(value, 3) for value in tick["bbox"]] for tick in seq]
    return _signal(
        "axis_scale_distortion",
        page_index,
        excerpt,
        f"Axis ticks {excerpt} are {reason.replace('-', ' ')}.",
        {"values": values, "axis": axis, "reason": reason, "bboxes": bboxes},
        {"values": values, "axis": axis, "reason": reason, "bboxes": bboxes, **extra},
        "truncated-or-nonmonotonic-axis",
    )


def _sequence_signal(page, page_index, group, axis):
    seq = _ordered_sequence(group, axis)
    if len(seq) < 4:
        return None
    values = [tick["value"] for tick in seq]
    gaps = _axis_gaps(seq, axis)
    reason = _distortion_reason(values, gaps, _break_near(page, seq))
    if reason is None:
        return None
    return _axis_signal(page_index, seq, axis, reason, values, {"gaps": [round(gap, 3) for gap in gaps]})


def _tick_axis_signals(page, page_index, ticks):
    signals = []
    for axis, key, tol in (("h", "cy", 8.0), ("v", "cx", 12.0)):
        for group in _clusters(ticks, key, tol):
            signal = _sequence_signal(page, page_index, group, axis)
            if signal is not None:
                signals.append(signal)
    return signals


def _drawings(page):
    try:
        return page.get_drawings() or []
    except Exception:
        return []


def _is_vertical_bar(rect, page_w, page_h):
    width, height = rect.x1 - rect.x0, rect.y1 - rect.y0
    if height < 12 or width < 2 or height < width * 1.15:
        return False
    return not (width > page_w * 0.85 and height > page_h * 0.85)


def _vertical_bars(drawings, page):
    bars = []
    page_w, page_h = float(page.rect.width), float(page.rect.height)
    for draw in drawings:
        rect = draw.get("rect") if isinstance(draw, dict) else None
        if rect is None or draw.get("fill") is None:
            continue
        if _is_vertical_bar(rect, page_w, page_h):
            bars.append(rect)
    return bars


def _baseline_groups(bars):
    groups = []
    for rect in sorted(bars, key=lambda item: float(item.y1)):
        if groups and abs(float(rect.y1) - float(groups[-1][0].y1)) <= 3.0:
            groups[-1].append(rect)
            continue
        groups.append([rect])
    return [group for group in groups if len(group) >= 2]


def _near_baseline(tick, y_base):
    return min(abs(tick["cy"] - y_base), abs(tick["bbox"][3] - y_base), abs(tick["bbox"][1] - y_base)) <= 12.0


def _baseline_values(group, y_base):
    if len(group) < 2:
        return None
    nearest = min(group, key=lambda tick: abs(tick["cy"] - y_base))
    if not _near_baseline(nearest, y_base):
        return None
    values = [tick["value"] for tick in group]
    if nearest["value"] > min(values) + 1e-9:
        return None
    return min(values), max(values), group


def _matching_baseline(ticks, y_base):
    for group in _clusters(ticks, "cx", 12.0):
        found = _baseline_values(group, y_base)
        if found is not None:
            return found
    return None


def _truncated_signal(page_index, ticks, bars):
    y_base = sum(float(bar.y1) for bar in bars) / len(bars)
    found = _matching_baseline(ticks, y_base)
    if found is None:
        return None
    v_min, v_max, group = found
    if v_min <= 0 or v_max <= v_min or v_min / (v_max - v_min) < 1.5:
        return None
    ordered = _ordered_sequence(group, "v")
    return _axis_signal(
        page_index,
        ordered or group,
        "v",
        "truncated-baseline",
        [tick["value"] for tick in (ordered or group)],
        {"vMin": v_min, "vMax": v_max, "yBase": round(y_base, 3), "barCount": len(bars)},
    )


def _baseline_signals(page_index, ticks, drawings, page):
    signals = []
    for bars in _baseline_groups(_vertical_bars(drawings, page)):
        signal = _truncated_signal(page_index, ticks, bars)
        if signal is not None:
            signals.append(signal)
    return signals


def _image_boxes(page):
    boxes = []
    try:
        infos = page.get_image_info() or []
    except Exception:
        return boxes
    for info in infos:
        bbox = info.get("bbox") if isinstance(info, dict) else None
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            boxes.append(bbox)
    return boxes


def _page_is_chart(page):
    if _image_boxes(page):
        return True
    return bool(_vertical_bars(_drawings(page), page))


def _page_axis_signals(page, page_index):
    if not _page_is_chart(page):
        return []
    ticks = _word_ticks(page)
    drawings = _drawings(page)
    signals = _tick_axis_signals(page, page_index, ticks)
    signals.extend(_baseline_signals(page_index, ticks, drawings, page))
    return signals


def _axis_signals(doc):
    signals = []
    for page_index in range(min(doc.page_count, MAX_FORENSIC_PAGES)):
        signals.extend(_page_axis_signals(doc[page_index], page_index))
    return signals


def _layout_signals(doc, panels, dpi):
    return _subpanel_signals(doc, panels, dpi) + _axis_signals(doc)


def audit_figure_forensics(paper_id, file_hash=None, *, max_signals=30, dpi=96, max_figures=24, store=None):
    """Deterministically audit placed figure panels and chart printed values (offline, read-only)."""
    _validate_options(max_signals, dpi, max_figures)
    store = _default_store() if store is None else store
    paper_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)

    with _open_pdf(raw) as doc:
        panels, skipped, panels_truncated = _enumerate_panels(doc, dpi, max_figures)
        pair_signals, pairs = _pair_checks(doc, panels, dpi)
        layout_signals = _layout_signals(doc, panels, dpi)
    chart_signals = _chart_claim_signals_all(store, paper_id, actual_hash, max_figures)
    numbered, signals_truncated = _dedupe_and_cap(pair_signals + layout_signals + chart_signals, max_signals)
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

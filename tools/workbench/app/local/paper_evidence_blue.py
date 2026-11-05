"""Bounded table and figure text for the existing text-only BLUE transport.

context_for_review reads an EvidenceStore and returns {"text", "coverage"}.
It does not call a model. It is not an MCP tool. Image bytes stay out of the
text; crop objects name regions for a separate render. Callers that need tool
calls use paper_mcp.py instead.
"""
import json
import re

SCHEMA = "falsify.paper-evidence.v1"
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_CODE = re.compile(r"[a-z0-9_]{1,80}\Z")
_DELIVERY = "delivery: text for an existing text-only review; not a model tool call; no image bytes in this text"
_CURVE_KEYS = ('id', 'name', 'color', 'requestedColor', 'effectiveColor', 'axisBinding', 'traceAmbiguous', 'pointKind')


def _curve_source(series):
    """Compact series provenance. Points and numeric cells stay out of this copy."""
    summary = {key: series[key] for key in _CURVE_KEYS if key in series}
    points = series.get('points') if isinstance(series.get('points'), list) else []
    origins, roles = [], []
    for point in points:
        if not isinstance(point, dict):
            continue
        origin, role = point.get('origin'), point.get('role')
        if isinstance(origin, str) and origin not in origins:
            origins.append(origin)
        if isinstance(role, str) and role not in roles:
            roles.append(role)
    if origins:
        summary['origins'] = origins
    if roles:
        summary['roles'] = roles
    if isinstance(series.get('sampling'), dict):
        summary['sampling'] = series['sampling']
    if isinstance(series.get('sourceStroke'), dict):
        summary['sourceStroke'] = series['sourceStroke']
    summary['pointCount'] = len(points)
    return summary


class _Block:
    def __init__(self, item_id, kind, text, complete):
        self.item_id = item_id
        self.kind = kind
        self.text = text
        self.complete = complete


def _validate_summary_counts(summary):
    counts = summary.get("counts")
    if (not isinstance(counts, dict) or type(counts.get("tables")) is not int or type(counts.get("figures")) is not int
            or counts["tables"] < 0 or counts["figures"] < 0):
        raise ValueError("paper_evidence_summary_invalid")


def _validate_summary_facts(summary):
    if summary.get("status") not in ("ready", "partial"):
        raise ValueError("paper_evidence_summary_invalid")
    if type(summary.get("pageCount")) is not int or summary["pageCount"] < 0:
        raise ValueError("paper_evidence_summary_invalid")
    _validate_summary_counts(summary)
    if type(summary.get("engine")) is not str or not summary["engine"]:
        raise ValueError("paper_evidence_summary_invalid")
    limitations = summary.get("limitations")
    if not isinstance(limitations, list) or any(type(item) is not str for item in limitations):
        raise ValueError("paper_evidence_summary_invalid")
    if type(summary.get("expiresAt")) is not str or not summary["expiresAt"]:
        raise ValueError("paper_evidence_summary_invalid")


def require_summary(summary, paper_id=None, file_hash=None):
    """Reject a store summary that is not the shared evidence contract."""
    if not isinstance(summary, dict) or summary.get("schema") != SCHEMA:
        raise ValueError("paper_evidence_summary_invalid")
    found_id, found_hash = summary.get("paperId"), summary.get("fileHash")
    if type(found_id) is not str or not 1 <= len(found_id) <= 160:
        raise ValueError("paper_evidence_id_invalid")
    if type(found_hash) is not str or _HEX.fullmatch(found_hash) is None:
        raise ValueError("paper_evidence_hash_invalid")
    if paper_id is not None and found_id != paper_id:
        raise ValueError("paper_evidence_unknown_id")
    if file_hash is not None and found_hash != file_hash:
        raise ValueError("paper_evidence_hash_mismatch")
    _validate_summary_facts(summary)
    return summary


def _fixed(exc):
    code = exc.args[0] if exc.args and type(exc.args[0]) is str else ""
    if _CODE.fullmatch(code):
        raise ValueError(code) from None
    raise ValueError("paper_evidence_failed") from None


def _default_store():
    from paper_evidence import default_store
    return default_store


def _require_page(page, paper_id, file_hash):
    if not isinstance(page, dict) or page.get("paperId") != paper_id or page.get("fileHash") != file_hash:
        raise ValueError("paper_evidence_hash_mismatch")
    total, items = page.get("total"), page.get("items")
    if type(total) is not int or total < 0 or not isinstance(items, list):
        raise ValueError("paper_evidence_summary_invalid")
    for meta in items:
        if not isinstance(meta, dict) or type(meta.get("id")) is not str or not meta["id"] or type(meta.get("type")) is not str:
            raise ValueError("paper_evidence_summary_invalid")
    return items, total, page.get("nextOffset")


def _collect(store, paper_id, file_hash):
    items, offset, total, capped = [], 0, 0, True
    for _ in range(10000):
        try:
            page = store.list_items(paper_id, kind=None, page_index=None, offset=offset, limit=50)
        except KeyError:
            raise ValueError("paper_evidence_unknown_id") from None
        except ValueError as exc:
            _fixed(exc)
        batch, total, nxt = _require_page(page, paper_id, file_hash)
        items.extend(batch)
        if len(items) >= total or not batch or nxt is None or type(nxt) is not int or nxt <= offset:
            capped = False
            break
        offset = nxt
    return items, max(0, total - len(items)), capped


def _format_table(item, lines, complete):
    table = item.get("table")
    cells = table.get("cells") if isinstance(table, dict) else None
    if isinstance(table, dict) and "rows" in table:
        lines.append("storeRows: " + json.dumps(table.get("rows"), ensure_ascii=False))
    if isinstance(table, dict) and "columns" in table:
        lines.append("storeColumns: " + json.dumps(table.get("columns"), ensure_ascii=False))
    if not isinstance(cells, list):
        lines.append("cells: unavailable")
        complete = False
    else:
        lines.append("cells:")
        for cell in cells:
            if not isinstance(cell, dict):
                lines.append("cell unavailable")
                complete = False
                continue
            lines.append("cell " + json.dumps(cell, ensure_ascii=False, separators=(",", ":")))
    return complete


def _format_block(paper_id, item, kind):
    item_id = item["id"]
    page, bbox = item.get("pageIndex"), item.get("bbox")
    caption, provenance = item.get("caption"), item.get("provenance")
    complete = (type(page) is int and page >= 0 and (caption is None or type(caption) is str)
                and (provenance is None or isinstance(provenance, (str, dict))))
    try:
        crop = {"paperId": paper_id, "itemId": item_id, "pageIndex": page, "bbox": bbox}
        lines = [
            f"{kind.upper()} id={json.dumps(item_id, ensure_ascii=False)} pageIndex={json.dumps(page)} bbox={json.dumps(bbox, ensure_ascii=False)}",
            "crop: " + json.dumps(crop, ensure_ascii=False, separators=(",", ":")),
            "caption: " + json.dumps(caption, ensure_ascii=False),
            "provenance: " + json.dumps(provenance, ensure_ascii=False),
        ]
        if kind == "table":
            complete = _format_table(item, lines, complete)
        elif kind != "figure":
            lines.append("cells: unavailable")
            complete = False
        text = "\n".join(lines)
    except (TypeError, ValueError):
        return _Block(item_id, kind if kind in ("table", "figure") else "other",
                      f"ITEM id={json.dumps(item_id, ensure_ascii=False)} unavailable", False)
    return _Block(item_id, kind if kind in ("table", "figure") else "other", text, complete)


def _load_block(store, paper_id, file_hash, meta):
    item_id, kind = meta["id"], meta["type"] if meta["type"] in ("table", "figure") else "other"
    try:
        item = store.read_item(paper_id, item_id)
    except KeyError:
        return _Block(item_id, kind, f"ITEM id={json.dumps(item_id, ensure_ascii=False)} unavailable", False)
    except ValueError as exc:
        _fixed(exc)
    if not isinstance(item, dict) or item.get("id") != item_id:
        raise ValueError("paper_evidence_summary_invalid")
    if "fileHash" in item and item.get("fileHash") != file_hash:
        raise ValueError("paper_evidence_hash_mismatch")
    return _format_block(paper_id, item, kind)


def _header(summary, facts, omitted_ids, limitations_in_text):
    count = len(omitted_ids) + facts["list_gap"]
    lines = [
        "prepared-evidence falsify.paper-evidence.v1",
        _DELIVERY,
        f"paperId: {summary['paperId']}",
        f"fileHash: {summary['fileHash']}",
        f"status: {summary['status']}",
        f"pageCount: {summary['pageCount']}",
        f"engine: {summary['engine']}",
        f"expiresAt: {summary['expiresAt']}",
        f"counts: tables={summary['counts']['tables']} figures={summary['counts']['figures']}",
        f"listed: tables={facts['listed_tables']} figures={facts['listed_figures']}",
        "captions are label heuristics, not verified associations. cell text is raw and uncorrected.",
        "limitationsInText: " + ("true" if limitations_in_text else "false"),
    ]
    if limitations_in_text:
        lines.append("limitations:")
        lines.extend(f"- {item}" for item in summary["limitations"])
    lines.extend([
        f"truncationCount: {count}",
        "omittedIds: " + json.dumps(omitted_ids, ensure_ascii=False),
        f"listGap: {facts['list_gap']}",
        f"unlisted: {facts['unlisted']}",
        f"countGap: {facts['count_gap']}",
        f"unavailableItems: {facts['unavailable']}",
        "listIncomplete: " + ("true" if facts["list_incomplete"] else "false"),
    ])
    return "\n".join(lines)


def _tally(blocks):
    return {"tables": sum(block.kind == "table" for block in blocks),
            "figures": sum(block.kind == "figure" for block in blocks)}


def _result(summary, text, facts, included, omitted, max_chars, limitations_in_text):
    if len(text) > max_chars:
        raise ValueError("paper_evidence_failed")
    omitted_ids = [block.item_id for block in omitted]
    other_in, other_out = sum(block.kind == "other" for block in included), sum(block.kind == "other" for block in omitted)
    coverage = {
        "paperId": summary["paperId"], "fileHash": summary["fileHash"], "engine": summary["engine"],
        "status": summary["status"], "limitations": list(summary["limitations"]), "pageCount": summary["pageCount"],
        "counts": {"tables": summary["counts"]["tables"], "figures": summary["counts"]["figures"]},
        "expiresAt": summary["expiresAt"],
        "listed": {"tables": facts["listed_tables"], "figures": facts["listed_figures"]},
        "included": _tally(included), "omitted": _tally(omitted), "omittedIds": omitted_ids,
        "unlisted": facts["unlisted"], "countGap": facts["count_gap"], "listGap": facts["list_gap"],
        "listIncomplete": facts["list_incomplete"], "unavailableItems": facts["unavailable"],
        "limitationsInText": limitations_in_text, "maxChars": max_chars, "charCount": len(text),
        "truncationCount": len(omitted_ids) + facts["list_gap"],
    }
    coverage["truncated"] = bool(coverage["truncationCount"] or not limitations_in_text or facts["list_incomplete"] or facts["unavailable"])
    if other_in or other_out:
        coverage["other"] = {"included": other_in, "omitted": other_out}
    return {"text": text, "coverage": coverage}


def _try_pack(summary, blocks, facts, max_chars, limitations_in_text):
    """Grow the omitted-id list until the header and the kept items agree.

    A longer header can only drop more items, so the omitted set grows until
    it matches the header that announced it.
    """
    omitted_ids = []
    for _ in range(len(blocks) + 2):
        header = _header(summary, facts, omitted_ids, limitations_in_text)
        if len(header) > max_chars:
            return None
        room, used, chosen, new_ids = max_chars - len(header), 0, [], []
        for block in blocks:
            piece = len(block.text) + 1
            if used + piece <= room:
                chosen.append(block)
                used += piece
            else:
                new_ids.append(block.item_id)
        if new_ids == omitted_ids:
            text = header if not chosen else header + "\n" + "\n".join(block.text for block in chosen)
            omitted = [block for block in blocks if block not in chosen]
            return _result(summary, text, facts, chosen, omitted, max_chars, limitations_in_text)
        omitted_ids = new_ids
    return None


def _last_resort(summary, blocks, facts, max_chars):
    count = len(blocks) + facts["list_gap"]
    options = [
        f"paperId: {summary['paperId']}\nfileHash: {summary['fileHash']}\ntruncationCount: {count}\nlimitationsInText: false",
        f"truncationCount: {count}",
    ]
    text = next((option for option in options if len(option) <= max_chars), "")
    return _result(summary, text, facts, [], list(blocks), max_chars, False)


def _analysis_header(kind, native, method):
    header = ('DERIVED OCR transcription; may contain recognition errors; confidence is engine-reported.' if kind == 'ocr'
              else 'DERIVED PDF path geometry; source endpoints keep their page coordinates and cubic interiors are interpolated samples with a recorded pixel error. This is not experimental observation data or a confidence interval.'
              if native
              else 'DERIVED curve samples; PlotTracer pixel coordinates and source-bound axis calibration. Samples are not independent observations or confidence-interval endpoints. Point origin and role distinguish measured pixels from interpolated samples such as WPD XStep.'
              if method == 'oss-pixel-calibration'
              else 'DERIVED chart table; caller-selected axis ticks and image points, pixel-calibrated estimates, not measured source data.'
              if method == 'caller-selected-ticks-and-points'
              else 'DERIVED chart table; OCR axis ticks and original curve pixels, calibrated raster estimates. Inspect axis fits, rejected ticks and series binding.'
              if method == 'ocr-tick-pixel-calibration'
              else 'DERIVED chart table; numeric values are model estimates, not measured source data.')
    return header


def _analysis_context_entry(entry, kind, native, method):
    context_entry = entry
    # Pixel-calibrated rows already have their full numeric values and
    # original point bounds in geometry.series.points. Repeating them
    # again as numericCells can evict the entire recovered chart from
    # BLUE's context. Keep the original analysis intact for MCP/export.
    # Native path context keeps the source stroke and a per-series
    # origin summary instead of a second copy of the sample arrays.
    if kind == 'chart' and isinstance(entry['data'].get('geometry'), dict) and (native or method in ('ocr-tick-pixel-calibration','oss-pixel-calibration')):
        context_data = {key: value for key, value in entry['data'].items() if key != 'numericCells'}
        context_data.update(schema='falsify.chart-context.v1', sourceSchema=entry['data']['schema'],
                            representation='table-and-original-curve-points')
        context_entry = {**entry, 'data': context_data}
        if native or method == 'oss-pixel-calibration':
            geometry = entry['data']['geometry']
            context_data.pop('geometry', None)
            context_data['geometrySummary'] = {key: geometry[key] for key in ('plotBbox','sourcePlotBbox','axes','calibrationSource','pointKind','provenance','vectorSource') if key in geometry}
            context_data['curveSources'] = [_curve_source(series) for series in geometry.get('series', [])]
            context_data['representation'] = 'table-and-vector-summary' if native else 'table-and-geometry-summary'
    return context_entry


def _append_analyses(store, paper_id, file_hash, blocks):
    analyses = []
    if hasattr(store, 'list_analyses'):
        listing = store.list_analyses(paper_id)
        if listing.get('fileHash') != file_hash: raise ValueError('paper_evidence_hash_mismatch')
        for meta in listing.get('items', []):
            entry = store.read_analysis(paper_id, meta['analysisId'])
            if entry.get('fileHash') != file_hash: raise ValueError('paper_evidence_hash_mismatch')
            analysis_id = entry['analysisId']
            kind = entry['kind']
            provenance = entry['data'].get('provenance') if isinstance(entry['data'].get('provenance'), dict) else {}
            method = provenance.get('method')
            native = provenance.get('vector') == 'pdf-native-path'
            header = _analysis_header(kind, native, method)
            context_entry = _analysis_context_entry(entry, kind, native, method)
            text = header + '\n' + json.dumps(context_entry, ensure_ascii=False, separators=(',', ':'))
            blocks.append(_Block(analysis_id, 'other', text, True))
            analyses.append({'analysisId':analysis_id, 'kind':kind, 'pageIndex':entry['pageIndex'],
                             'imageSha256':entry['inputImage']['sha256'], 'provenance':entry['data'].get('provenance')})
            if context_entry is not entry:
                analyses[-1]['representation'] = context_entry['data']['representation']
    return analyses


def _coverage_facts(summary, metas, blocks, unlisted, capped):
    listed_tables = sum(meta.get("type") == "table" for meta in metas)
    listed_figures = sum(meta.get("type") == "figure" for meta in metas)
    counts = summary["counts"]
    count_gap = max(0, counts["tables"] - listed_tables) + max(0, counts["figures"] - listed_figures)
    facts = {
        "listed_tables": listed_tables, "listed_figures": listed_figures, "unlisted": unlisted,
        "count_gap": count_gap, "list_gap": max(unlisted, count_gap),
        "list_incomplete": bool(capped or unlisted or count_gap),
        "unavailable": sum(not block.complete for block in blocks),
    }
    return facts


def _validate_context_request(paper_id, file_hash, max_chars):
    if type(paper_id) is not str or not 1 <= len(paper_id) <= 160:
        raise ValueError("paper_evidence_id_invalid")
    if type(file_hash) is not str or _HEX.fullmatch(file_hash) is None:
        raise ValueError("paper_evidence_hash_invalid")
    if type(max_chars) is not int or max_chars < 0:
        raise ValueError("paper_evidence_budget_invalid")


def context_for_review(paper_id, file_hash, store=None, max_chars=24000):
    """Return bounded raw table cells and figure captions for one prepared PDF.

    Hash mismatch and an unknown paper id are rejected. truncationCount counts
    items left out of text: budget omissions plus the list gap. Limitations
    that do not fit stay in coverage and limitationsInText is false.
    """
    _validate_context_request(paper_id, file_hash, max_chars)
    store = _default_store() if store is None else store
    try:
        summary = store.status(paper_id)
    except KeyError:
        raise ValueError("paper_evidence_unknown_id") from None
    except ValueError as exc:
        _fixed(exc)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)
    metas, unlisted, capped = _collect(store, paper_id, file_hash)
    blocks = [_load_block(store, paper_id, file_hash, meta) for meta in metas]
    analyses = _append_analyses(store, paper_id, file_hash, blocks)
    facts = _coverage_facts(summary, metas, blocks, unlisted, capped)
    packed = _try_pack(summary, blocks, facts, max_chars, True)
    if packed is None:
        packed = _try_pack(summary, blocks, facts, max_chars, False)
    if packed is None:
        packed = _last_resort(summary, blocks, facts, max_chars)
    if analyses:
        omitted = set(packed['coverage']['omittedIds'])
        packed['coverage']['analyses'] = {'available':len(analyses), 'included':[x for x in analyses if x['analysisId'] not in omitted],
                                         'omitted':[x['analysisId'] for x in analyses if x['analysisId'] in omitted]}
    return packed

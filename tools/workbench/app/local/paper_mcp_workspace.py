"""Read-only multi-document workspace mode for the paper MCP server.

``paper_mcp.py --pdf PATH`` opens exactly one file. ``--workspace DIR`` is the
additive directory mode implemented here: a bounded read-only scan of the PDFs
under DIR, blind masking of answer-key-like names, and one selection at a time
so the ordinary read tools follow ``select_paper`` without restarting the
process.

Nothing here writes, browses, or shells out. A scanned entry carries a file
name, its byte length and a content-derived id; the workspace root path itself
never leaves the process. Files whose name looks like an answer key, ledger, or
solution are listed as masked and are never read.
"""
import hashlib
from pathlib import Path

from mcp.types import CallToolResult

import paper_mcp

SCHEMA = "falsify.mcp-workspace.v1"
TRIAGE_SCHEMA = "falsify.mcp-workspace-triage.v1"
MAX_WORKSPACE_PAPERS = 32
MAX_SCAN_DEPTH = 2
MASKED_REASON = "answer_key_name"
MASK_NAME_PARTS = ("gold", "ledger", "answer", "answerkey", "solution", "red-plan", "whythard")
_PRIORITY_WEIGHTS = {"D1": 5, "D2": 4, "D6": 4, "D4-1": 3, "D7": 5, "D5": 3, "D4-2": 3}
_CHUNK = 1 << 20


def is_masked_name(name):
    """True when a file name looks like an answer key, ledger, or solution."""
    if not isinstance(name, str) or not name:
        return True
    lowered = name.lower()
    return any(part in lowered for part in MASK_NAME_PARTS)


def _child_paths(folder):
    try:
        return sorted(Path(folder).iterdir(), key=lambda item: item.name.lower())
    except OSError:
        return []


def _walk(root, max_depth):
    """Yield candidate paths from a bounded, cycle-free breadth-first walk."""
    pending = [(Path(root), 0)]
    while pending:
        folder, depth = pending.pop(0)
        for path in _child_paths(folder):
            if path.is_dir() and not path.is_symlink():
                if depth < max_depth:
                    pending.append((path, depth + 1))
                continue
            yield path


def _file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _masked_id(relative_name):
    """Id for a masked entry: derived from its relative name, never from the file bytes."""
    return "masked-" + hashlib.sha256(relative_name.lower().encode("utf-8")).hexdigest()[:16]


def _entry_for(resolved_root, path):
    """Build one scan entry for path, or None when the path is refused."""
    try:
        resolved = Path(path).resolve()
    except OSError:
        return None
    if not resolved.is_relative_to(resolved_root) or not resolved.is_file():
        return None
    masked = is_masked_name(path.name) or is_masked_name(resolved.name)
    if not masked and resolved.suffix.lower() != ".pdf":
        return None
    try:
        byte_length = resolved.stat().st_size
    except OSError:
        return None
    if byte_length <= 0 or byte_length > paper_mcp.MAX_PDF_BYTES:
        return None
    if masked:
        paper_id = _masked_id(path.relative_to(resolved_root).as_posix())
    else:
        try:
            paper_id = "ws-" + _file_hash(resolved)[:16]
        except OSError:
            return None
    entry = {"paperId": paper_id, "name": path.name, "byteLength": byte_length, "masked": masked}
    if masked:
        entry["reason"] = MASKED_REASON
    return entry, resolved


def _supplement_extensions():
    cached = getattr(_supplement_extensions, "cached", None)
    if cached is None:
        from paper_mcp_bundle import TEXT_EXTENSIONS
        cached = TEXT_EXTENSIONS | frozenset({".docx", ".xlsx", ".ipynb", ".rmd", ".qmd"})
        _supplement_extensions.cached = cached
    return cached


def _is_link(path):
    try:
        if path.is_symlink():
            return True
        junction = getattr(path, "is_junction", None)
        return bool(callable(junction) and junction())
    except OSError:
        return True


def _resolved_inside(resolved_root, path):
    try:
        resolved = path.resolve()
        if not resolved.is_relative_to(resolved_root):
            return None
    except (OSError, ValueError):
        return None
    return resolved


def _masked_relative(resolved_root, path):
    resolved = _resolved_inside(resolved_root, path)
    if resolved is None:
        return True
    try:
        parts = resolved.relative_to(resolved_root).parts
    except ValueError:
        return True
    return any(is_masked_name(part) for part in parts)


def _rejected_candidate(resolved_root, path):
    if _is_link(path) or is_masked_name(path.name) or is_masked_name(path.parent.name):
        return True
    return _masked_relative(resolved_root, path)


def _safe_file(resolved_root, path):
    if _rejected_candidate(resolved_root, path):
        return None
    resolved = _resolved_inside(resolved_root, path)
    if resolved is None or not resolved.is_file() or _is_link(resolved):
        return None
    return resolved


def _safe_dir(resolved_root, path):
    if _is_link(path) or is_masked_name(path.name):
        return None
    resolved = _resolved_inside(resolved_root, path)
    if resolved is None or not resolved.is_dir() or _is_link(resolved):
        return None
    if _masked_relative(resolved_root, resolved):
        return None
    return resolved


def _name_pairs(filename, stem):
    suffix = Path(filename).suffix.lower()
    if suffix not in _supplement_extensions() or is_masked_name(filename):
        return False
    lowered = filename.lower()
    stem_l = stem.lower()
    if lowered == f"{stem_l}{suffix}":
        return True
    return lowered.startswith(f"{stem_l}_") or lowered.startswith(f"{stem_l}-")


def _same_dir_candidates(resolved_root, pdf_path):
    found = []
    stem = pdf_path.stem
    for path in _child_paths(pdf_path.parent):
        if not _name_pairs(path.name, stem):
            continue
        safe = _safe_file(resolved_root, path)
        if safe is None or safe == pdf_path:
            continue
        found.append(safe)
    return found


def _companion_files(resolved_root, folder):
    found = []
    allowed = _supplement_extensions()
    for path in _child_paths(folder):
        if Path(path.name).suffix.lower() not in allowed:
            continue
        safe = _safe_file(resolved_root, path)
        if safe is not None:
            found.append(safe)
    return found


def _companion_candidates(resolved_root, pdf_path):
    stem = pdf_path.stem.lower()
    wanted = {stem, f"{stem}_supplements", f"{stem}-supplements"}
    found = []
    for path in _child_paths(pdf_path.parent):
        if path.name.lower() not in wanted:
            continue
        folder = _safe_dir(resolved_root, path)
        if folder is None:
            continue
        found.extend(_companion_files(resolved_root, folder))
    return found


def _probe_supplement_size(path, loader):
    if is_masked_name(path.name) or is_masked_name(path.parent.name):
        return None
    try:
        loaded = loader([path])
    except ValueError:
        return None
    if len(loaded) != 1 or not isinstance(loaded[0], dict):
        return None
    size = loaded[0].get("byteLength")
    if type(size) is not int or size <= 0:
        return None
    return size


def _reload_accepted(accepted, loader):
    if not accepted:
        return []
    try:
        loaded = loader(accepted)
    except ValueError:
        return []
    if len(loaded) != len(accepted):
        return []
    return list(accepted)


def _load_accepted(candidates):
    from paper_mcp_bundle import MAX_BUNDLE_BYTES, MAX_SUPPLEMENTS, load_selected_supplements
    ordered = sorted(set(candidates), key=lambda item: (item.name.lower(), item.as_posix().lower()))
    accepted, running = [], 0
    for path in ordered:
        if len(accepted) >= MAX_SUPPLEMENTS:
            break
        size = _probe_supplement_size(path, load_selected_supplements)
        if size is None or running + size > MAX_BUNDLE_BYTES:
            continue
        accepted.append(path)
        running += size
    return _reload_accepted(accepted, load_selected_supplements)


def _paired_supplement_paths(resolved_root, pdf_path):
    candidates = _same_dir_candidates(resolved_root, pdf_path)
    candidates.extend(_companion_candidates(resolved_root, pdf_path))
    return _load_accepted(candidates)


def _remember_pairs(resolved_root, entry, resolved, paired_map):
    if entry["masked"]:
        return
    matches = _paired_supplement_paths(resolved_root, resolved)
    paired_map[entry["paperId"]] = tuple(matches)
    if not matches:
        return
    entry["pairedSupplementCount"] = len(matches)
    entry["pairedSupplementNames"] = [item.name for item in matches]


def _scan(root, max_papers):
    """Internal scan: the public summary plus the resolved path behind each id."""
    if type(max_papers) is not int or not 1 <= max_papers <= MAX_WORKSPACE_PAPERS:
        raise ValueError("workspace_invalid")
    try:
        base = Path(root)
        if not base.is_dir():
            raise ValueError("workspace_invalid")
        resolved_root = base.resolve()
    except OSError:
        raise ValueError("workspace_invalid") from None
    papers, paths, paired, seen, truncated = [], {}, {}, set(), False
    for path in _walk(resolved_root, MAX_SCAN_DEPTH):
        found = _entry_for(resolved_root, path)
        if found is None:
            continue
        entry, resolved = found
        if entry["paperId"] in seen:
            continue
        if len(papers) >= max_papers:
            truncated = True
            break
        seen.add(entry["paperId"])
        papers.append(entry)
        paths[entry["paperId"]] = resolved
        _remember_pairs(resolved_root, entry, resolved, paired)
    papers.sort(key=lambda item: (item["name"].lower(), item["paperId"]))
    summary = {
        "schema": SCHEMA,
        "paperCount": len(papers),
        "maskedCount": sum(1 for item in papers if item["masked"]),
        "truncated": truncated,
        "papers": papers,
    }
    return summary, paths, paired


def scan_workspace(root, *, max_papers=MAX_WORKSPACE_PAPERS):
    """Enumerate the workspace read-only; no entry ever contains a filesystem path."""
    return _scan(root, max_papers)[0]


class WorkspaceSession:
    """Read-only state for one workspace process: store, root, selection, masked ids."""

    def __init__(self, store, root, *, max_papers=MAX_WORKSPACE_PAPERS, startup_supplements=()):
        if type(max_papers) is not int or not 1 <= max_papers <= MAX_WORKSPACE_PAPERS:
            raise ValueError("workspace_invalid")
        try:
            if not Path(root).is_dir():
                raise ValueError("workspace_invalid")
        except OSError:
            raise ValueError("workspace_invalid") from None
        self.store = store
        self.root = Path(root)
        self.max_papers = max_papers
        self.current = None
        self.masked = frozenset()
        self.startup_supplements = tuple(startup_supplements or ())
        self.paired_supplements = ()

    @property
    def paper_id(self):
        return None if self.current is None else self.current[0]

    @property
    def file_hash(self):
        return None if self.current is None else self.current[1]

    def remember_scan(self, summary):
        """Track which ids the latest scan masked; a masked id is never opened."""
        self.masked = frozenset(item["paperId"] for item in summary["papers"] if item["masked"])

    def select(self, paper_id, file_hash):
        """Bind the prepared paper that the ordinary read tools resolve per call."""
        if type(paper_id) is not str or type(file_hash) is not str:
            raise ValueError("paper_evidence_failed")
        self.current = (paper_id, file_hash)

    @property
    def supplements(self):
        from paper_mcp_bundle import MAX_SUPPLEMENTS
        return _merge_supplements(self.startup_supplements, self.paired_supplements, MAX_SUPPLEMENTS)


def open_in_workspace(session, paper_id):
    """Select one scanned workspace PDF and prepare it read-only."""
    if type(paper_id) is not str or not 1 <= len(paper_id) <= 160:
        raise ValueError("paper_evidence_id_invalid")
    summary, paths, paired = _scan(session.root, session.max_papers)
    session.remember_scan(summary)
    entry = next((item for item in summary["papers"] if item["paperId"] == paper_id), None)
    if entry is None:
        raise ValueError("paper_evidence_unknown_id")
    if entry["masked"]:
        raise ValueError("workspace_file_masked")
    opened = paper_mcp.open_selected(session.store, paths[paper_id])
    session.select(opened["paperId"], opened["fileHash"])
    session.paired_supplements = tuple(_load_paired_bundle(paired.get(paper_id, ())))
    return {
        "paperId": opened["paperId"],
        "fileHash": opened["fileHash"],
        "name": entry["name"],
        "pageCount": opened["pageCount"],
    }


def _load_paired_bundle(paths):
    from paper_mcp_bundle import load_selected_supplements
    if not paths:
        return []
    try:
        return list(load_selected_supplements(list(paths)))
    except ValueError:
        return []


def _merge_supplements(startup, paired, limit):
    merged, seen = [], set()
    for item in tuple(startup or ()) + tuple(paired or ()):
        if not isinstance(item, dict):
            continue
        key = (item.get("sha256"), item.get("name"))
        if key in seen:
            continue
        seen.add(key)
        merged.append(dict(item))
        if len(merged) >= limit:
            break
    for index, item in enumerate(merged):
        item["supplementId"] = f"supp-{index + 1}"
    return tuple(merged)


def _require_bool(value, code):
    if type(value) is not bool:
        raise ValueError(code)


def _validate_triage_limits(max_signals, include_figure_forensics, recompute_raw,
                            include_flow_triage=True, include_internal_consistency=True):
    if type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")
    _require_bool(include_figure_forensics, "include_figure_forensics")
    _require_bool(recompute_raw, "recompute_raw")
    _require_bool(include_flow_triage, "include_flow_triage")
    _require_bool(include_internal_consistency, "include_internal_consistency")


def _triage_store(store, max_papers):
    if store is not None:
        return store
    from paper_evidence import EvidenceStore
    return EvidenceStore(max_documents=max_papers)


def _signals_of(payload):
    if not isinstance(payload, dict):
        return []
    signals = payload.get("signals")
    if not isinstance(signals, list):
        return []
    return [item for item in signals if isinstance(item, dict)]


def _extend_signals(signals, action):
    try:
        signals.extend(_signals_of(action()))
    except ValueError:
        return


def _extend_code_audit(signals, bundle_mod, store, opened, bundle, max_signals):
    audit_code = getattr(bundle_mod, "audit_code_supplements_payload", None)
    if not callable(audit_code):
        return
    _extend_signals(signals, lambda: audit_code(
        store, opened["paperId"], opened["fileHash"], bundle, max_signals=max_signals))


def _accept_sensor_flag(params, kwargs, name, value):
    if name in params:
        kwargs[name] = value
        return
    if type(value) is not bool:
        raise ValueError(name)


def _sensor_kwargs(max_signals, include_figure_forensics, include_flow_triage, include_internal_consistency):
    import inspect
    import paper_mcp_bundle as bundle_mod
    params = inspect.signature(bundle_mod.run_blue_sensor_payload).parameters
    kwargs = {
        "max_signals": max_signals,
        "digest_only": True,
        "include_figure_forensics": include_figure_forensics,
    }
    _accept_sensor_flag(params, kwargs, "include_flow_triage", include_flow_triage)
    _accept_sensor_flag(params, kwargs, "include_internal_consistency", include_internal_consistency)
    return bundle_mod, kwargs


def _paper_signals(store, opened, bundle, options):
    bundle_mod, kwargs = _sensor_kwargs(
        options["maxSignals"], options["includeFigureForensics"],
        options["includeFlowTriage"], options["includeInternalConsistency"])
    signals = _signals_of(bundle_mod.run_blue_sensor_payload(
        store, opened["paperId"], opened["fileHash"], **kwargs))
    if not bundle:
        return signals
    limit = options["maxSignals"]
    _extend_signals(signals, lambda: bundle_mod.audit_supplements_payload(
        store, opened["paperId"], opened["fileHash"], bundle, max_signals=limit))
    if options["recomputeRaw"]:
        _extend_signals(signals, lambda: bundle_mod.recompute_raw_supplement_payload(
            store, opened["paperId"], opened["fileHash"], bundle, max_signals=limit))
    _extend_code_audit(signals, bundle_mod, store, opened, bundle, limit)
    return signals


def _triage_options(max_signals, include_figure_forensics, recompute_raw, include_flow_triage,
                    include_internal_consistency):
    return {
        "maxSignals": max_signals,
        "includeFigureForensics": include_figure_forensics,
        "recomputeRaw": recompute_raw,
        "includeFlowTriage": include_flow_triage,
        "includeInternalConsistency": include_internal_consistency,
    }


def _supplement_row(item):
    if not isinstance(item, dict):
        return None
    name, digest = item.get("name"), item.get("sha256")
    if isinstance(name, str) and isinstance(digest, str) and digest:
        return {"name": name, "sha256": digest}
    return None


def _supplement_rows(bundle):
    rows = []
    for item in bundle:
        row = _supplement_row(item)
        if row is not None:
            rows.append(row)
    return rows


def _signal_payload(store, opened, bundle, options):
    return {"signals": _paper_signals(store, opened, bundle, options)}


def _signals_from_payload(payload):
    if not isinstance(payload, dict):
        return []
    signals = payload.get("signals")
    if not isinstance(signals, list):
        return []
    return [item for item in signals if isinstance(item, dict)]


def _load_signals(cache, store, opened, bundle, options):
    if cache is None:
        return _signals_from_payload(_signal_payload(store, opened, bundle, options))
    from paper_evidence_cache import compute_cache_key
    key = compute_cache_key(
        "workspace-triage", opened["fileHash"],
        supplements=_supplement_rows(bundle), options=options)
    payload, _hit = cache.get_or_compute(key, lambda: _signal_payload(store, opened, bundle, options))
    return _signals_from_payload(payload)


def _rank_from_signals(opened, entry, bundle, signals):
    by_family = _family_counts(signals)
    return {
        "paperId": opened["paperId"],
        "name": entry["name"],
        "totalSignals": len(signals),
        "byFamily": by_family,
        "pairedSupplementCount": len(bundle),
        "priorityScore": _priority_score(by_family),
    }


def _rank_body(store, path, entry, paired_paths, cache, options):
    opened = paper_mcp.open_selected(store, path)
    bundle = _load_paired_bundle(paired_paths)
    signals = _load_signals(cache, store, opened, bundle, options)
    return _rank_from_signals(opened, entry, bundle, signals)


def _open_triage_cache(cache_dir):
    if cache_dir is None:
        return None
    from paper_evidence_cache import EvidenceCache
    return EvidenceCache(cache_dir)


def _triage_payload(summary, ranked, cache):
    payload = {
        "schema": TRIAGE_SCHEMA,
        "paperCount": summary["paperCount"],
        "maskedCount": summary["maskedCount"],
        "truncated": summary["truncated"],
        "rankedPapers": ranked,
    }
    if cache is not None:
        payload["cacheStats"] = cache.stats()
    return payload


def _family_counts(signals):
    counts = {}
    for item in signals:
        family = item.get("family")
        if type(family) is not str or not family:
            family = "unknown"
        counts[family] = counts.get(family, 0) + 1
    return counts


def _priority_score(by_family):
    total = 0
    for family, count in by_family.items():
        total += count * _PRIORITY_WEIGHTS.get(family, 1)
    return total


def _blank_rank(entry):
    count = entry.get("pairedSupplementCount")
    return {
        "paperId": entry["paperId"],
        "name": entry["name"],
        "totalSignals": 0,
        "byFamily": {},
        "pairedSupplementCount": count if type(count) is int else 0,
        "priorityScore": 0,
    }


def _rank_paper(store, path, entry, paired_paths, cache, options):
    if path is None:
        return _blank_rank(entry)
    try:
        return _rank_body(store, path, entry, paired_paths, cache, options)
    except ValueError:
        return _blank_rank(entry)


def _rank_key(item):
    return (item["totalSignals"], item["priorityScore"], item["name"])


def triage_workspace(root, *, max_papers=MAX_WORKSPACE_PAPERS, max_signals_per_paper=25,
                     include_figure_forensics=False, recompute_raw=True, store=None,
                     include_flow_triage=True, include_internal_consistency=True, cache_dir=None):
    """Rank unmasked workspace PDFs. The result never contains a filesystem path."""
    _validate_triage_limits(
        max_signals_per_paper, include_figure_forensics, recompute_raw,
        include_flow_triage, include_internal_consistency)
    summary, paths, paired = _scan(root, max_papers)
    active = _triage_store(store, max_papers)
    cache = _open_triage_cache(cache_dir)
    options = _triage_options(
        max_signals_per_paper, include_figure_forensics, recompute_raw,
        include_flow_triage, include_internal_consistency)
    ranked = []
    for entry in summary["papers"]:
        if entry["masked"]:
            continue
        ranked.append(_rank_paper(
            active, paths.get(entry["paperId"]), entry, paired.get(entry["paperId"], ()),
            cache, options))
    ranked.sort(key=_rank_key, reverse=True)
    return _triage_payload(summary, ranked, cache)


def load_workspace_supplements(paths):
    """Load workspace supplements, refusing answer-key-like names before any read."""
    if not paths:
        return []
    for raw_path in paths:
        if is_masked_name(Path(raw_path).name):
            raise ValueError("workspace_file_masked")
    from paper_mcp_bundle import load_selected_supplements

    return load_selected_supplements(paths)


def register_workspace_tools(server, session):
    """Register workspace list, selection, and batch triage tools."""

    @server.tool(annotations=paper_mcp._READONLY)
    def list_papers() -> CallToolResult:
        """Read-only list of workspace PDFs. Answer-key names stay masked and no path is returned."""
        try:
            summary = scan_workspace(session.root, max_papers=session.max_papers)
        except ValueError as exc:
            return paper_mcp._error(paper_mcp._fixed(exc))
        except Exception:
            return paper_mcp._error("paper_evidence_failed")
        session.remember_scan(summary)
        return paper_mcp._ok(summary)

    @server.tool(annotations=paper_mcp._READONLY)
    def select_paper(paperId: str) -> CallToolResult:
        """Read-only selection of one scanned workspace PDF. Later tools follow it until the next choice."""
        try:
            return paper_mcp._ok(open_in_workspace(session, paperId))
        except ValueError as exc:
            return paper_mcp._error(paper_mcp._fixed(exc))
        except Exception:
            return paper_mcp._error("paper_evidence_failed")

    @server.tool(name="triage_workspace", annotations=paper_mcp._READONLY)
    def triage_workspace_tool(maxSignalsPerPaper: int = 25, includeFigureForensics: bool = False,
                              recomputeRaw: bool = True, includeFlowTriage: bool = True,
                              includeInternalConsistency: bool = True) -> CallToolResult:
        """Read-only batch ranking of unmasked workspace PDFs. No filesystem path is returned."""
        try:
            payload = triage_workspace(
                session.root, max_papers=session.max_papers, max_signals_per_paper=maxSignalsPerPaper,
                include_figure_forensics=includeFigureForensics, recompute_raw=recomputeRaw,
                include_flow_triage=includeFlowTriage, include_internal_consistency=includeInternalConsistency,
                store=session.store)
        except ValueError as exc:
            return paper_mcp._error(paper_mcp._fixed(exc))
        except Exception:
            return paper_mcp._error("paper_evidence_failed")
        return paper_mcp._ok(payload)

    return server

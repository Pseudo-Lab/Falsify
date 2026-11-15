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
MAX_WORKSPACE_PAPERS = 32
MAX_SCAN_DEPTH = 2
MASKED_REASON = "answer_key_name"
MASK_NAME_PARTS = ("gold", "ledger", "answer", "answerkey", "solution", "red-plan", "whythard")
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
    papers, paths, seen, truncated = [], {}, set(), False
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
    papers.sort(key=lambda item: (item["name"].lower(), item["paperId"]))
    summary = {
        "schema": SCHEMA,
        "paperCount": len(papers),
        "maskedCount": sum(1 for item in papers if item["masked"]),
        "truncated": truncated,
        "papers": papers,
    }
    return summary, paths


def scan_workspace(root, *, max_papers=MAX_WORKSPACE_PAPERS):
    """Enumerate the workspace read-only; no entry ever contains a filesystem path."""
    return _scan(root, max_papers)[0]


class WorkspaceSession:
    """Read-only state for one workspace process: store, root, selection, masked ids."""

    def __init__(self, store, root, *, max_papers=MAX_WORKSPACE_PAPERS):
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


def open_in_workspace(session, paper_id):
    """Select one scanned workspace PDF and prepare it read-only."""
    if type(paper_id) is not str or not 1 <= len(paper_id) <= 160:
        raise ValueError("paper_evidence_id_invalid")
    summary, paths = _scan(session.root, session.max_papers)
    session.remember_scan(summary)
    entry = next((item for item in summary["papers"] if item["paperId"] == paper_id), None)
    if entry is None:
        raise ValueError("paper_evidence_unknown_id")
    if entry["masked"]:
        raise ValueError("workspace_file_masked")
    opened = paper_mcp.open_selected(session.store, paths[paper_id])
    session.select(opened["paperId"], opened["fileHash"])
    return {
        "paperId": opened["paperId"],
        "fileHash": opened["fileHash"],
        "name": entry["name"],
        "pageCount": opened["pageCount"],
    }


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
    """Register the two workspace-only read-only tools on a workspace server."""

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

    return server

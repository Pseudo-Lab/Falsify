"""Gate D2: Citation existence and metadata consistency verification."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from typing import Any, Callable, Protocol

from .models import VERDICT_DEFECT, VERDICT_NEEDS_REVIEW, VERDICT_VALID, GateFinding

USER_AGENT = "Falsify-gates/0.1 (Pseudo-Lab Season 13; contact via GitHub issues)"
CROSSREF_WORKS_URL = "https://api.crossref.org/works/{doi}"
EPMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={query}&format=json&resultType=core&pageSize=5"

_DOI_RE = re.compile(r"(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/[^\s\]\)>,;\"']+)", flags=re.I)
_YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})\b")
_REF_LINE_RE = re.compile(r"^\s*(?:-\s*)?(?:\[(?P<id1>\d+)\]|(?P<id2>\d+)\.)\s+(?P<body>.+)$")
_TOKEN_RE = re.compile(r"[a-z0-9]+")


class LookupUnavailableError(RuntimeError):
    """Raised when an external or injected citation lookup service is unavailable."""


class CitationResolver(Protocol):
    """Interface for DOI lookup and metadata search adapters."""

    def lookup_doi(self, doi: str) -> dict[str, Any] | None: ...

    def search_pubmed_or_crossref(self, query: dict[str, Any]) -> list[dict[str, Any]]: ...


def normalize_doi(doi: str | None) -> str:
    """Normalize a DOI string by stripping URL/prefix wrappers and trailing punctuation."""
    s = (doi or "").strip()
    s = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", s, flags=re.I)
    s = re.sub(r"^doi:\s*", "", s, flags=re.I)
    return s.rstrip(".,;:)]}").lower()


def _normalize_text(text: str | None) -> str:
    return " ".join(_TOKEN_RE.findall((text or "").lower()))


def _title_similarity(a: str | None, b: str | None) -> float:
    na, nb = _normalize_text(a), _normalize_text(b)
    if not na or not nb:
        return 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    ta, tb = set(na.split()), set(nb.split())
    jaccard = len(ta & tb) / len(ta | tb) if (ta | tb) else 0.0
    return max(seq, jaccard)


def _surname(author: str | None) -> str:
    s = (author or "").strip()
    if not s:
        return ""
    if "," in s:
        return _normalize_text(s.split(",", 1)[0])
    parts = s.split()
    if len(parts) >= 2 and len(parts[-1]) <= 3 and parts[-1].replace(".", "").isalpha():
        return _normalize_text(parts[0])
    return _normalize_text(parts[-1])


def _extract_year(val: Any) -> int | None:
    if isinstance(val, int):
        return val
    m = _YEAR_RE.search(str(val or ""))
    return int(m.group(1)) if m else None


class DictCitationResolver:
    """Deterministic offline resolver backed by an in-memory dictionary/list."""

    def __init__(
        self,
        doi_index: dict[str, dict[str, Any] | None] | None = None,
        records: list[dict[str, Any]] | None = None,
        *,
        unavailable: bool = False,
    ) -> None:
        self.doi_index: dict[str, dict[str, Any] | None] = {
            normalize_doi(k): v for k, v in (doi_index or {}).items()
        }
        self.records: list[dict[str, Any]] = list(records or [])
        for rec in self.doi_index.values():
            if rec is not None and rec not in self.records:
                self.records.append(rec)
        self.unavailable = unavailable

    def lookup_doi(self, doi: str) -> dict[str, Any] | None:
        if self.unavailable:
            raise LookupUnavailableError("Citation lookup service unavailable")
        return self.doi_index.get(normalize_doi(doi))

    def _matches_query(self, rec: dict[str, Any], q_title: str, q_author: str, q_year: int | None) -> bool:
        title_sim = _title_similarity(q_title, rec.get("title")) if q_title else 0.0
        if title_sim >= 0.85:
            return True
        score = 2 if title_sim >= 0.7 else 0
        authors = rec.get("authors") or [""]
        rec_author = _surname(rec.get("first_author") or authors[0])
        if q_author and rec_author and q_author == rec_author:
            score += 1
        rec_year = _extract_year(rec.get("year"))
        if q_year is not None and rec_year is not None and abs(q_year - rec_year) <= 1:
            score += 1
        return score >= 2

    def search_pubmed_or_crossref(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        if self.unavailable:
            raise LookupUnavailableError("Citation search service unavailable")
        q_title = _normalize_text(query.get("title"))
        q_author = _surname(query.get("first_author"))
        q_year = _extract_year(query.get("year"))
        if not q_title and not q_author:
            return []
        return [r for r in self.records if self._matches_query(r, q_title, q_author, q_year)]


class LiveCitationResolver:
    """Optional stdlib urllib client for Crossref and Europe PMC."""

    def __init__(self, timeout: float = 10.0) -> None:
        self.timeout = timeout

    def _get_json(self, url: str) -> dict[str, Any] | None:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise LookupUnavailableError(f"HTTP {exc.code} from {url}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise LookupUnavailableError(f"Lookup error for {url}: {exc}") from exc

    def lookup_doi(self, doi: str) -> dict[str, Any] | None:
        ndoi = normalize_doi(doi)
        if not ndoi:
            return None
        data = self._get_json(CROSSREF_WORKS_URL.format(doi=urllib.parse.quote(ndoi, safe="/")))
        if data is None:
            return None
        msg = data.get("message") or {}
        titles = msg.get("title") or []
        authors = msg.get("author") or []
        first_author = authors[0].get("family", "") if authors else ""
        issued = (msg.get("issued") or {}).get("date-parts") or [[]]
        year = issued[0][0] if issued and issued[0] else None
        return {
            "doi": ndoi,
            "title": titles[0] if titles else "",
            "first_author": first_author,
            "year": year,
            "journal": (msg.get("container-title") or [""])[0],
        }

    def search_pubmed_or_crossref(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        parts = []
        if query.get("title"):
            parts.append(f'TITLE:"{query["title"]}"')
        if query.get("first_author"):
            parts.append(f'AUTH:"{query["first_author"]}"')
        if not parts:
            return []
        url = EPMC_SEARCH_URL.format(query=urllib.parse.quote(" AND ".join(parts)))
        data = self._get_json(url)
        if not data:
            return []
        out = []
        for item in (data.get("resultList") or {}).get("result") or []:
            out.append({
                "doi": normalize_doi(item.get("doi")),
                "title": item.get("title", ""),
                "first_author": (item.get("authorString") or "").split(",")[0].strip(),
                "year": _extract_year(item.get("pubYear")),
                "journal": item.get("journalTitle", ""),
            })
        return out


def extract_citations(text: str) -> list[dict[str, Any]]:
    """Extract reference entries (with optional DOI, author, year, title) from Markdown text."""
    lines = (text or "").splitlines()
    in_refs = False
    citations: list[dict[str, Any]] = []
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if re.match(r"^#{1,4}\s+(references|bibliography|참고문헌)\b", stripped, flags=re.I):
            in_refs = True
            continue
        if in_refs and stripped.startswith("#"):
            in_refs = False
        m = _REF_LINE_RE.match(stripped) if in_refs else None
        if m:
            citations.append(_parse_reference_entry(m.group("id1") or m.group("id2"), m.group("body"), f"L{idx}"))
        elif not in_refs:
            for dm in _DOI_RE.finditer(stripped):
                citations.append({
                    "ref_id": f"inline-{len(citations) + 1}",
                    "doi": normalize_doi(dm.group(1)),
                    "raw": stripped,
                    "location": f"L{idx}",
                })
    return citations


def _parse_reference_entry(ref_id: str, body: str, location: str) -> dict[str, Any]:
    doi_m = _DOI_RE.search(body)
    doi = normalize_doi(doi_m.group(1)) if doi_m else ""
    year = _extract_year(body)
    cleaned = _DOI_RE.sub("", body).strip(" .")
    first_author = ""
    title = ""
    parts = [p.strip() for p in re.split(r"\.\s+", cleaned) if p.strip()]
    if parts:
        first_author = parts[0].split(",")[0].split(" et al")[0].strip()
    if len(parts) >= 2:
        title = parts[1] if not _YEAR_RE.fullmatch(parts[1]) else (parts[2] if len(parts) >= 3 else "")
    return {
        "ref_id": str(ref_id),
        "doi": doi,
        "first_author": first_author,
        "year": year,
        "title": title,
        "raw": body,
        "location": location,
    }


def _resolved_author(resolved: dict[str, Any]) -> str:
    authors = resolved.get("authors") or [""]
    return _surname(resolved.get("first_author") or authors[0])


def _find_metadata_mismatches(
    cited_title: str,
    res_title: str,
    cited_author: str,
    res_author: str,
    cited_year: int | None,
    res_year: int | None,
) -> tuple[list[str], float | None]:
    mismatches: list[str] = []
    title_sim = _title_similarity(cited_title, res_title) if (cited_title and res_title) else None
    if title_sim is not None and title_sim < 0.72:
        mismatches.append(f"title mismatch (similarity={title_sim:.2f})")
    if cited_author and res_author and cited_author != res_author:
        mismatches.append(f"first author mismatch (cited={cited_author!r}, resolved={res_author!r})")
    if cited_year is not None and res_year is not None and abs(cited_year - res_year) > 1:
        mismatches.append(f"year mismatch (cited={cited_year}, resolved={res_year})")
    return mismatches, title_sim


def _compare_metadata(citation: dict[str, Any], resolved: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    cited_title = (citation.get("title") or "").strip()
    res_title = (resolved.get("title") or "").strip()
    cited_author = _surname(citation.get("first_author"))
    res_author = _resolved_author(resolved)
    cited_year = _extract_year(citation.get("year"))
    res_year = _extract_year(resolved.get("year"))

    mismatches, title_sim = _find_metadata_mismatches(
        cited_title, res_title, cited_author, res_author, cited_year, res_year
    )
    ev = {
        "doi": normalize_doi(citation.get("doi") or resolved.get("doi")),
        "title_similarity": round(title_sim, 3) if title_sim is not None else None,
        "cited": {"title": cited_title, "first_author": cited_author, "year": cited_year},
        "resolved": {"title": res_title, "first_author": res_author, "year": res_year},
    }
    if mismatches:
        return VERDICT_DEFECT, "; ".join(mismatches), ev
    return VERDICT_VALID, "Citation metadata matches resolved record", ev


def _check_with_doi(
    citation: dict[str, Any],
    doi: str,
    doi_fn: Callable[[str], dict[str, Any] | None] | None,
    case_id: str,
    loc: str,
    paper_id: str,
) -> GateFinding:
    if doi_fn is None:
        return GateFinding(case_id, "D2", VERDICT_NEEDS_REVIEW, 0.3, {"doi": doi}, "No DOI lookup resolver available", loc, paper_id)
    try:
        resolved = doi_fn(doi)
    except LookupUnavailableError as exc:
        return GateFinding(case_id, "D2", VERDICT_NEEDS_REVIEW, 0.3, {"doi": doi}, str(exc), loc, paper_id)
    if resolved is None:
        return GateFinding(case_id, "D2", VERDICT_DEFECT, 0.96, {"doi": doi}, f"DOI does not exist (404): {doi}", loc, paper_id)
    verdict, reason, ev = _compare_metadata(citation, resolved)
    conf = 0.94 if verdict == VERDICT_DEFECT else 0.92
    return GateFinding(case_id, "D2", verdict, conf, ev, reason, loc, paper_id)


def _check_without_doi(
    citation: dict[str, Any],
    search_fn: Callable[[dict[str, Any]], list[dict[str, Any]]] | None,
    case_id: str,
    loc: str,
    paper_id: str,
) -> GateFinding:
    if search_fn is None:
        return GateFinding(case_id, "D2", VERDICT_NEEDS_REVIEW, 0.35, {"citation": citation}, "Missing DOI and no search resolver available", loc, paper_id)
    try:
        candidates = search_fn(citation)
    except LookupUnavailableError as exc:
        return GateFinding(case_id, "D2", VERDICT_NEEDS_REVIEW, 0.3, {"citation": citation}, str(exc), loc, paper_id)

    if len(candidates) != 1:
        reason = "Missing DOI and no matching reference found" if not candidates else f"Missing DOI with ambiguous metadata ({len(candidates)} candidates)"
        return GateFinding(case_id, "D2", VERDICT_NEEDS_REVIEW, 0.4, {"candidates": len(candidates)}, reason, loc, paper_id)

    verdict, reason, ev = _compare_metadata(citation, candidates[0])
    conf = 0.9 if verdict == VERDICT_DEFECT else 0.85
    return GateFinding(case_id, "D2", verdict, conf, ev, reason, loc, paper_id)


def check_citation(
    citation: dict[str, Any],
    resolver: CitationResolver | None = None,
    *,
    lookup_doi: Callable[[str], dict[str, Any] | None] | None = None,
    search_pubmed_or_crossref: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None,
    case_id: str = "d2-case",
    paper_id: str = "",
) -> GateFinding:
    """Verify a single citation entry against an injected resolver or lookup callables."""
    doi_fn = lookup_doi or (resolver.lookup_doi if resolver else None)
    search_fn = search_pubmed_or_crossref or (resolver.search_pubmed_or_crossref if resolver else None)
    doi = normalize_doi(citation.get("doi"))
    loc = str(citation.get("location") or citation.get("ref_id") or "")
    if doi:
        return _check_with_doi(citation, doi, doi_fn, case_id, loc, paper_id)
    return _check_without_doi(citation, search_fn, case_id, loc, paper_id)


def verify_d2_citations(
    citations_or_text: list[dict[str, Any]] | str,
    resolver: CitationResolver | None = None,
    *,
    lookup_doi: Callable[[str], dict[str, Any] | None] | None = None,
    search_pubmed_or_crossref: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None,
    paper_id: str = "",
) -> list[GateFinding]:
    """Run D2 citation verification over a list of citation dicts or a Markdown document."""
    entries = extract_citations(citations_or_text) if isinstance(citations_or_text, str) else list(citations_or_text)
    findings: list[GateFinding] = []
    for idx, entry in enumerate(entries, 1):
        cid = f"{paper_id or 'doc'}-d2-{entry.get('ref_id') or idx}"
        findings.append(
            check_citation(
                entry,
                resolver=resolver,
                lookup_doi=lookup_doi,
                search_pubmed_or_crossref=search_pubmed_or_crossref,
                case_id=cid,
                paper_id=paper_id,
            )
        )
    return findings

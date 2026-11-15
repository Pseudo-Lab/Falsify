"""Bounded bibliography verification and in-text claim grounding via fixed HTTPS APIs."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import html
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
from urllib.parse import quote, urlencode

PROVIDERS = ('crossref', 'europepmc')
HOSTS = {'crossref': 'api.crossref.org', 'europepmc': 'www.ebi.ac.uk'}
MAX_BYTES = 500_000
MAX_ABSTRACT_CHARS = 3500
MAX_REFS = 50
MAX_CLAIMS = 24
TIMEOUT_SECONDS = 7
USER_AGENT = 'Falsify-Blue-Evidence/0.3.6 (bounded scholarly lookup)'

SCOPE_NOTE = 'API metadata/abstract only; not full text, peer-review confirmation, or independent scientific truth.'
MISSING_MATCH_NOTE = 'Missing search match is not proof of fabrication.'
CROSSREF_404_NOTE = (
    'Crossref /works returned 404 for this DOI; API coverage is bounded and 404 does not prove '
    'absolute non-existence across all DOI agencies, though an unresolvable 10.xxxx DOI is a high-priority D2 candidate.'
)

_DOI_RE = re.compile(r'(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/[^\s,;\[\]>"]+)', re.IGNORECASE)
_PMID_RE = re.compile(r'\bPMID\s*[:#]?\s*(\d{5,10})\b', re.IGNORECASE)
_PMCID_RE = re.compile(r'\b(PMC\d{5,10})\b', re.IGNORECASE)
_YEAR_RE = re.compile(r'\b(19\d{2}|20\d{2})[a-z]?\b')
_LEADING_INDEX_RE = re.compile(r'^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)])\s*(.*)$')
_QUOTED_TITLE_RE = re.compile(r'["\u201c]([^"\u201d]{10,300})["\u201d]')
_BRACKET_CITE_RE = re.compile(r'\[(\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*)\]')
_AUTHOR_YEAR_CITE_RE = re.compile(
    r'\(([A-Z\u00c0-\u024f][A-Za-z\u00c0-\u024f\'\-]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][A-Za-z\'\-]+|&\s+[A-Z][A-Za-z\'\-]+))?)'
    r'[,\s]+((?:19|20)\d{2}[a-z]?)\)'
)
_NARRATIVE_CITE_RE = re.compile(
    r'\b([A-Z\u00c0-\u024f][A-Za-z\u00c0-\u024f\'\-]+)\s+et\s+al\.?\s*\(((?:19|20)\d{2}[a-z]?)\)'
)
_QUANT_CLAIM_RE = re.compile(
    r'(?:\b(?:increase[ds]?|decrease[ds]?|significan(?:t|tly)|outperform(?:s|ed)?|contrary|'
    r'previously\s+shown|higher|lower|reduc(?:e[ds]?|tion)|improv(?:e[ds]?|ement)|'
    r'associat(?:ed|ion)|caus(?:e[ds]?|al)|mortalit(?:y|ies)|surviv(?:al|e)|'
    r'odds\s+ratio|hazard\s+ratio|relative\s+risk|OR|HR|RR|CI)\b|'
    r'\bp\s*[<≤=]\s*0?\.\d+|\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*(?:fold|times)\b|'
    r'결과|유의|감소|증가|향상|차이|효과|위험|연관|대조|기존\s*연구|선행\s*연구)',
    re.IGNORECASE,
)
_STOPWORDS = frozenset({
    'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'not',
    'have', 'has', 'had', 'into', 'than', 'then', 'between', 'among', 'during',
    'using', 'based', 'study', 'studies', 'analysis', 'effect', 'effects', 'after',
})
_NON_SURNAME_PREFIXES = frozenset({'van', 'von', 'der', 'den', 'de', 'del', 'la', 'le', 'da', 'di'})
_RETRACTION_UPDATE_TYPES = frozenset({
    'retraction', 'withdrawal', 'removal',
    'expression-of-concern', 'expression_of_concern',
})
_EOC_UPDATE_TYPES = frozenset({'expression-of-concern', 'expression_of_concern'})
_RETRACTED_TITLE_RE = re.compile(
    r'^\s*(?:\[?\s*retracted(?:\s+article)?\s*\]?|retraction\s*:|withdrawn\s*:)',
    re.IGNORECASE,
)
_EOC_TITLE_RE = re.compile(
    r'^\s*(?:\[\s*expression\s+of\s+concern\s*\]|expression\s+of\s+concern\s*:)',
    re.IGNORECASE,
)
_RAW_RETRACTION_ACK_RE = re.compile(r'(?:\bretracted\b|\bretraction\b|철회)', re.IGNORECASE)


def plain(value):
    """Strip HTML tags/entities and normalize whitespace."""
    if value is None:
        return ''
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', str(value)))).strip()


def _validate_request(provider, path):
    if provider not in HOSTS:
        raise ValueError('unknown_provider')
    if not isinstance(path, str) or not path.startswith('/') or any(ord(c) < 32 for c in path):
        raise ValueError('invalid_api_path')
    return HOSTS[provider]


def _resolve_global_ip(host):
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('non_public_api_address')
    return addresses[0][4][0]


def _read_bounded_body(response, tls, deadline):
    parts, size = [], 0
    while True:
        tls.settimeout(max(0.01, deadline - time.monotonic()))
        if time.monotonic() >= deadline:
            raise TimeoutError('api_deadline')
        chunk = response.read1(min(16384, MAX_BYTES + 1 - size))
        if not chunk:
            break
        parts.append(chunk)
        size += len(chunk)
        if size > MAX_BYTES:
            raise ValueError('api_response_bound')
    return b''.join(parts)


def fetch_json(provider, path):
    """Bounded HTTPS GET on fixed scholarly API hosts. No redirects, cookies, or auth."""
    host = _validate_request(provider, path)
    ip = _resolve_global_ip(host)
    connection = http.client.HTTPSConnection(host, timeout=TIMEOUT_SECONDS)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        sock = socket.create_connection((ip, 443), timeout=TIMEOUT_SECONDS)
        connection.sock = sock
        sock.settimeout(max(0.01, deadline - time.monotonic()))
        tls = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        connection.sock = tls
        tls.settimeout(max(0.01, deadline - time.monotonic()))
        connection.request('GET', path, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status == 404:
            raw = _read_bounded_body(response, tls, deadline)
            return 404, None, hashlib.sha256(raw).hexdigest()
        if response.status != 200:
            raise ValueError(f'api_status_{response.status}')
        if 'json' not in response.getheader('Content-Type', '').lower():
            raise ValueError('api_content_type')
        raw = _read_bounded_body(response, tls, deadline)
        return 200, json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        connection.close()


def _error_code(error):
    text = str(error)
    allowed = {'api_content_type', 'api_response_bound', 'api_records_shape', 'non_public_api_address'}
    if isinstance(error, ValueError) and (re.fullmatch(r'api_status_\d{3}', text) or text in allowed):
        return text
    return type(error).__name__


def _call_transport(transport, provider, path):
    try:
        result = transport(provider, path)
    except ValueError as error:
        if str(error) == 'api_status_404':
            return 404, None, hashlib.sha256(b'').hexdigest(), None
        return None, None, None, _error_code(error)
    except Exception as error:
        return None, None, None, _error_code(error)
    if isinstance(result, tuple) and len(result) == 3:
        return result[0], result[1], result[2], None
    if isinstance(result, tuple) and len(result) == 2:
        return 200, result[0], result[1], None
    return None, None, None, 'transport_shape_invalid'


def _clean_doi(raw):
    if not raw or not isinstance(raw, str):
        return None
    m = _DOI_RE.search(raw.strip())
    if not m:
        return None
    doi = m.group(1).rstrip('.,;]}"\'')
    while doi.endswith(')') and doi.count(')') > doi.count('('):
        doi = doi[:-1].rstrip('.,;]}"\'')
    return doi or None


def _extract_surname(author_text):
    if not author_text:
        return None
    head = re.split(r'\s*(?:,|;|et\s+al\b|\(\d{4}\))', author_text.strip(), maxsplit=1)[0].strip()
    tokens = [t.strip('.,;:') for t in head.split() if t.strip('.,;:')]
    for tok in tokens:
        if len(tok) <= 1 or tok.lower() in _NON_SURNAME_PREFIXES:
            continue
        if tok.isupper() and len(tok) <= 3:
            continue
        return tok
    return tokens[0] if tokens else None


def _strip_ref_ids(raw_text):
    cleaned = _DOI_RE.sub(' ', raw_text)
    cleaned = _PMID_RE.sub(' ', cleaned)
    cleaned = _PMCID_RE.sub(' ', cleaned)
    cleaned = re.sub(r'https?://\S+', ' ', cleaned)
    return re.sub(r'\s+', ' ', cleaned).strip()


def _extract_title_candidate(body):
    quoted = _QUOTED_TITLE_RE.search(body)
    if quoted:
        return quoted.group(1).strip()
    stripped = _strip_ref_ids(body)
    after_year = re.search(r'\(\s*(?:19|20)\d{2}[a-z]?\s*\)[.,:\s]+(.+)$', stripped)
    text = after_year.group(1) if after_year else stripped
    parts = [p.strip(' .;:') for p in re.split(r'(?<=[a-zA-Z0-9\)\]])\.\s+', text) if p.strip(' .;:')]
    if not after_year and len(parts) >= 2:
        parts = parts[1:]
    for part in parts:
        if len(part) >= 12 and not re.fullmatch(r'[\d\s:;,-]+', part):
            return part[:300]
    return parts[0][:300] if parts else ''


def parse_reference_entry(ref):
    """Normalize a bibliography entry dict or raw reference line into structured fields."""
    if isinstance(ref, dict):
        raw = plain(ref.get('rawText', ''))
        idx = ref.get('index') if type(ref.get('index')) is int else None
        doi = _clean_doi(ref.get('doi')) or _clean_doi(raw)
        year = ref.get('year') if type(ref.get('year')) is int else None
    elif isinstance(ref, str):
        raw, idx, doi, year = plain(ref), None, _clean_doi(ref), None
    else:
        raise ValueError('reference_entry_invalid')

    m = _LEADING_INDEX_RE.match(raw)
    body = raw
    if m:
        idx = idx if idx is not None else int(m.group(1) or m.group(2))
        body = m.group(3).strip()
    if year is None:
        years = _YEAR_RE.findall(raw)
        year = int(years[-1]) if years else None
    pmid_m = _PMID_RE.search(raw)
    pmcid_m = _PMCID_RE.search(raw)
    return {
        'index': idx,
        'doi': doi,
        'pmid': pmid_m.group(1) if pmid_m else None,
        'pmcid': pmcid_m.group(1).upper() if pmcid_m else None,
        'year': year,
        'titleCandidate': _extract_title_candidate(body),
        'firstAuthorSurname': _extract_surname(body),
        'rawText': raw,
    }


def _crossref_year(row):
    for field in ('published', 'published-print', 'published-online', 'issued'):
        parts = (row.get(field) or {}).get('date-parts')
        if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
            val = parts[0][0]
            if isinstance(val, int) or (isinstance(val, str) and val.isdigit()):
                return int(val)
    return None


def _crossref_authors(row):
    authors_list, surnames = [], []
    for a in (row.get('author') or [])[:12]:
        if not isinstance(a, dict):
            continue
        given = plain(a.get('given', ''))
        family = plain(a.get('family', ''))
        full = plain(f'{given} {family}')
        if full:
            authors_list.append(full)
        if family:
            surnames.append(family)
    return '; '.join(authors_list)[:1000], surnames


def _title_retraction_kind(title):
    if _RETRACTED_TITLE_RE.match(title or ''):
        return 'retraction'
    if _EOC_TITLE_RE.match(title or ''):
        return 'expression_of_concern'
    return None


def _collect_crossref_updates(row):
    kinds, details = [], []
    for field in ('update-to', 'updated-by'):
        items = row.get(field)
        if not isinstance(items, list):
            continue
        for item in items[:10]:
            if not isinstance(item, dict):
                continue
            utype = str(item.get('type') or '').strip().lower()
            if utype in _RETRACTION_UPDATE_TYPES:
                kinds.append('expression_of_concern' if utype in _EOC_UPDATE_TYPES else 'retraction')
                details.append({'source': field, 'type': utype, 'doi': plain(item.get('DOI', ''))})
    return kinds, details


def _collect_crossref_relations(row):
    rel = row.get('relation')
    if not isinstance(rel, dict):
        return [], []
    kinds, details = [], []
    for key in ('is-retracted-by', 'has-retraction'):
        items = rel.get(key)
        if isinstance(items, list) and items:
            ids = [plain(x.get('id', '')) for x in items[:5] if isinstance(x, dict) and x.get('id')]
            kinds.append('retraction')
            details.append({'source': f'relation.{key}', 'ids': ids})
    return kinds, details


def _crossref_retraction_info(row, title):
    u_kinds, u_details = _collect_crossref_updates(row)
    r_kinds, r_details = _collect_crossref_relations(row)
    kinds = u_kinds + r_kinds
    details = u_details + r_details
    title_kind = _title_retraction_kind(title)
    if title_kind:
        kinds.append(title_kind)
        details.append({'source': 'title_prefix', 'type': title_kind})
    if not kinds:
        return False, None, None
    rtype = 'retraction' if 'retraction' in kinds else 'expression_of_concern'
    return True, rtype, {'sources': details}


def _epmc_retraction_info(row, title):
    kinds, details = [], []
    pub_list = (row.get('pubTypeList') or {}).get('pubType') if isinstance(row.get('pubTypeList'), dict) else None
    pub_types = [pub_list] if isinstance(pub_list, str) else (pub_list if isinstance(pub_list, list) else [])
    for pt in pub_types[:20]:
        low = plain(pt).lower()
        if 'retracted publication' in low or 'retraction of' in low:
            kinds.append('retraction')
            details.append({'source': 'pubTypeList', 'type': plain(pt)})
        elif 'expression of concern' in low:
            kinds.append('expression_of_concern')
            details.append({'source': 'pubTypeList', 'type': plain(pt)})
    if str(row.get('isRetracted') or '').strip().upper() == 'Y':
        kinds.append('retraction')
        details.append({'source': 'isRetracted', 'value': 'Y'})
    title_kind = _title_retraction_kind(title)
    if title_kind:
        kinds.append(title_kind)
        details.append({'source': 'title_prefix', 'type': title_kind})
    if not kinds:
        return False, None, None
    rtype = 'retraction' if 'retraction' in kinds else 'expression_of_concern'
    return True, rtype, {'sources': details}


def _normalize_crossref_work(row, response_hash, retrieved_at):
    if not isinstance(row, dict):
        return None
    doi = _clean_doi(plain(row.get('DOI', ''))) or ''
    titles = row.get('title', [])
    title = plain(titles[0]) if isinstance(titles, list) and titles else ''
    authors, surnames = _crossref_authors(row)
    year = _crossref_year(row)
    abstract_full = plain(row.get('abstract', ''))
    truncated = len(abstract_full) > MAX_ABSTRACT_CHARS
    abstract = abstract_full[:MAX_ABSTRACT_CHARS]
    url = 'https://doi.org/' + quote(doi, safe='/') if doi else ''
    if not title and not doi:
        return None
    retracted, rtype, rdetails = _crossref_retraction_info(row, title)
    text = f"Title: {title}\nAuthors: {authors}\nYear: {year or ''}\nDOI: {doi}"
    if abstract:
        text += f"\nAbstract{' (TRUNCATED PREFIX)' if truncated else ''}: {abstract}"
    return {
        'provider': 'crossref', 'doi': doi, 'title': title,
        'authors': authors, 'authorSurnames': surnames,
        'year': year, 'abstract': abstract, 'abstractTruncated': truncated, 'url': url,
        'retracted': retracted, 'retractionType': rtype, 'retractionDetails': rdetails,
        'kind': 'metadata-and-abstract' if abstract else 'metadata-only',
        'text': text, 'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        'responseSha256': response_hash, 'retrievedAt': retrieved_at,
    }


def _normalize_epmc_work(row, response_hash, retrieved_at):
    if not isinstance(row, dict):
        return None
    doi = _clean_doi(plain(row.get('doi', ''))) or ''
    title = plain(row.get('title', ''))
    authors = plain(row.get('authorString', ''))
    surnames = _epmc_surnames(row, authors)
    year_raw = plain(row.get('pubYear', ''))
    year = int(year_raw) if year_raw.isdigit() else None
    abstract_full = plain(row.get('abstractText', ''))
    truncated = len(abstract_full) > MAX_ABSTRACT_CHARS
    abstract = abstract_full[:MAX_ABSTRACT_CHARS]
    source, ident = plain(row.get('source', '')), plain(row.get('id', ''))
    url = ('https://doi.org/' + quote(doi, safe='/')) if doi else (
        f"https://europepmc.org/article/{quote(source, safe='')}/{quote(ident, safe='')}" if source and ident else ''
    )
    if not title and not doi:
        return None
    retracted, rtype, rdetails = _epmc_retraction_info(row, title)
    text = f"Title: {title}\nAuthors: {authors[:1000]}\nYear: {year or ''}\nDOI: {doi}"
    if abstract:
        text += f"\nAbstract{' (TRUNCATED PREFIX)' if truncated else ''}: {abstract}"
    return {
        'provider': 'europepmc', 'doi': doi, 'title': title,
        'authors': authors[:1000], 'authorSurnames': surnames,
        'year': year, 'abstract': abstract, 'abstractTruncated': truncated, 'url': url,
        'retracted': retracted, 'retractionType': rtype, 'retractionDetails': rdetails,
        'kind': 'metadata-and-abstract' if abstract else 'metadata-only',
        'text': text, 'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        'responseSha256': response_hash, 'retrievedAt': retrieved_at,
    }


def _epmc_surnames(row, author_string):
    author_list = (row.get('authorList') or {}).get('author') or []
    surnames = [plain(a.get('lastName', '')) for a in author_list[:12] if isinstance(a, dict) and a.get('lastName')]
    if surnames:
        return surnames
    out = []
    for part in author_string.split(',')[:12]:
        surname = _extract_surname(part)
        if surname:
            out.append(surname)
    return out


def _tokens(text):
    return [t for t in re.findall(r'[a-z0-9]{3,}', (text or '').lower()) if t not in _STOPWORDS]


def _token_overlap(retrieved_title, raw_text, title_candidate=''):
    ret = set(_tokens(retrieved_title))
    if not ret:
        return None
    raw_set = set(_tokens(raw_text))
    overlap_raw = len(ret & raw_set) / len(ret)
    cand_set = set(_tokens(title_candidate))
    if cand_set:
        overlap_cand = len(ret & cand_set) / max(len(ret), len(cand_set))
        return round(max(overlap_raw, overlap_cand), 4)
    return round(overlap_raw, 4)


def _surname_in_text(surname, text):
    if not surname or not text:
        return False
    return bool(re.search(rf'\b{re.escape(surname.lower())}\b', text.lower()))


def _compare_record(parsed, record):
    overlap = _token_overlap(record.get('title', ''), parsed['rawText'], parsed.get('titleCandidate', ''))
    surnames = record.get('authorSurnames') or []
    first_surname = surnames[0] if surnames else _extract_surname(record.get('authors', ''))
    first_in_raw = _surname_in_text(first_surname, parsed['rawText']) if first_surname else None
    parsed_surname = parsed.get('firstAuthorSurname')
    any_author_match = bool(
        first_in_raw
        or (parsed_surname and any(_surname_in_text(parsed_surname, s) for s in surnames))
        or (parsed_surname and _surname_in_text(parsed_surname, record.get('authors', '')))
    )
    year_diff = abs(parsed['year'] - record['year']) if (parsed.get('year') and record.get('year')) else None
    return {
        'titleOverlap': overlap,
        'firstAuthorInRaw': first_in_raw,
        'anyAuthorMatch': any_author_match,
        'yearDiff': year_diff,
        'retrievedTitle': record.get('title', ''),
        'retrievedAuthors': record.get('authors', ''),
        'retrievedYear': record.get('year'),
    }


def _is_chimera_mismatch(comparison):
    overlap = comparison['titleOverlap']
    if overlap is None or overlap >= 0.25:
        return False
    first_absent = comparison['firstAuthorInRaw'] is False
    year_far = comparison['yearDiff'] is not None and comparison['yearDiff'] >= 3
    return first_absent or year_far


def _query_crossref_doi(doi, transport):
    at = datetime.now(timezone.utc).isoformat()
    path = '/works/' + quote(doi, safe='')
    status, data, sha, err = _call_transport(transport, 'crossref', path)
    receipt = {'provider': 'crossref', 'queryType': 'doi', 'status': 'ok' if status == 200 else 'not_found' if status == 404 else 'failed',
               'httpStatus': status, 'responseSha256': sha, 'retrievedAt': at}
    if err:
        receipt['errorCode'] = err
        return None, receipt
    if status == 404:
        return None, receipt
    msg = (data or {}).get('message') if isinstance(data, dict) else None
    rec = _normalize_crossref_work(msg, sha, at) if isinstance(msg, dict) else None
    return rec, receipt


def _query_epmc(query_str, transport, query_type='query'):
    at = datetime.now(timezone.utc).isoformat()
    path = '/europepmc/webservices/rest/search?' + urlencode({
        'query': query_str, 'format': 'json', 'resultType': 'core', 'pageSize': 3,
    })
    status, data, sha, err = _call_transport(transport, 'europepmc', path)
    receipt = {'provider': 'europepmc', 'queryType': query_type, 'status': 'ok' if status == 200 else 'failed',
               'httpStatus': status, 'responseSha256': sha, 'retrievedAt': at}
    if err:
        receipt['errorCode'] = err
        return [], receipt
    results = ((data or {}).get('resultList') or {}).get('result') if isinstance(data, dict) else None
    if not isinstance(results, list):
        receipt.update(status='failed', errorCode='api_records_shape')
        return [], receipt
    rows = [r for item in results[:3] if (r := _normalize_epmc_work(item, sha, at)) is not None]
    return rows, receipt


def _query_crossref_bib(query_str, transport):
    at = datetime.now(timezone.utc).isoformat()
    path = '/works?' + urlencode({
        'query.bibliographic': query_str[:220], 'rows': 3,
        'select': 'DOI,title,author,published,abstract,type,update-to,relation',
    })
    status, data, sha, err = _call_transport(transport, 'crossref', path)
    receipt = {'provider': 'crossref', 'queryType': 'bibliographic', 'status': 'ok' if status == 200 else 'failed',
               'httpStatus': status, 'responseSha256': sha, 'retrievedAt': at}
    if err:
        receipt['errorCode'] = err
        return [], receipt
    items = ((data or {}).get('message') or {}).get('items') if isinstance(data, dict) else None
    if not isinstance(items, list):
        receipt.update(status='failed', errorCode='api_records_shape')
        return [], receipt
    rows = [r for item in items[:3] if (r := _normalize_crossref_work(item, sha, at)) is not None]
    return rows, receipt


def _pick_primary_receipt(receipts, preferred_provider=None):
    if preferred_provider:
        for r in receipts:
            if r['provider'] == preferred_provider and r.get('responseSha256') is not None:
                return r
    for r in receipts:
        if r.get('responseSha256') is not None:
            return r
    return receipts[0] if receipts else {'provider': 'none', 'responseSha256': None, 'retrievedAt': datetime.now(timezone.utc).isoformat()}


def _resolve_entry_retraction(raw_text, records):
    retracted_recs = [r for r in records if r and r.get('retracted')]
    if not retracted_recs:
        return {'retracted': False, 'retractionType': None}
    if _RAW_RETRACTION_ACK_RE.search(raw_text or ''):
        return {'retracted': False, 'retractionType': None, 'retractionAcknowledged': True}
    types = [r.get('retractionType') for r in retracted_recs if r.get('retractionType')]
    rtype = 'retraction' if 'retraction' in types else (types[0] if types else 'retraction')
    details = [r.get('retractionDetails') for r in retracted_recs if r.get('retractionDetails')]
    return {'retracted': True, 'retractionType': rtype, 'retractionDetails': details}


def _verify_doi_entry(parsed, transport):
    doi = parsed['doi']
    cr_rec, cr_receipt = _query_crossref_doi(doi, transport)
    epmc_rows, epmc_receipt = _query_epmc(f'DOI:"{doi}"', transport, query_type='doi')
    receipts = [cr_receipt, epmc_receipt]
    epmc_rec = next((r for r in epmc_rows if r['doi'].lower() == doi.lower()), epmc_rows[0] if epmc_rows else None)
    record = epmc_rec if (epmc_rec and epmc_rec['abstract'] and (not cr_rec or not cr_rec['abstract'])) else (cr_rec or epmc_rec)
    primary = _pick_primary_receipt(receipts, record['provider'] if record else 'crossref')
    base = {'index': parsed['index'], 'rawText': parsed['rawText'], 'parsed': parsed, 'requests': receipts,
            'provider': primary['provider'], 'responseSha256': primary['responseSha256'], 'retrievedAt': primary['retrievedAt']}
    if cr_receipt['httpStatus'] == 404:
        ret_meta = _resolve_entry_retraction(parsed['rawText'], [epmc_rec] if epmc_rec else [])
        return {**base, 'status': 'doi_not_found_in_crossref', 'retrievedRecord': record, 'scope': CROSSREF_404_NOTE, **ret_meta}
    if record is None:
        return {**base, 'status': 'lookup_failed', 'retrievedRecord': None, 'scope': SCOPE_NOTE, 'retracted': False, 'retractionType': None}
    comp = _compare_record(parsed, record)
    if _is_chimera_mismatch(comp):
        return {**base, 'status': 'metadata_mismatch', 'retrievedRecord': record, 'mismatchDetails': comp,
                'retracted': False, 'retractionType': None,
                'scope': SCOPE_NOTE + ' Retrieved DOI metadata strongly diverges from reference text (D2/chimera candidate).'}
    ret_meta = _resolve_entry_retraction(parsed['rawText'], [cr_rec, epmc_rec])
    return {**base, 'status': 'verified_match', 'retrievedRecord': record, 'matchDetails': comp, 'scope': SCOPE_NOTE, **ret_meta}


def _metadata_query_string(parsed):
    parts = [parsed.get('titleCandidate') or '', parsed.get('firstAuthorSurname') or '', str(parsed.get('year') or '')]
    q = ' '.join(p for p in parts if p).strip()
    return q if len(q) >= 6 else parsed['rawText'][:180]


def _is_high_metadata_match(parsed, comparison):
    overlap = comparison['titleOverlap']
    if overlap is None or overlap < 0.55:
        return False
    if parsed.get('firstAuthorSurname') and not comparison['anyAuthorMatch']:
        return False
    if comparison['yearDiff'] is not None and comparison['yearDiff'] > 2:
        return False
    return True


def _rank_best_candidate(parsed, candidates):
    best, best_score, best_comp = None, -1.0, None
    for rec in candidates:
        comp = _compare_record(parsed, rec)
        score = (comp['titleOverlap'] or 0.0) + (0.25 if comp['anyAuthorMatch'] else 0.0) + (0.15 if rec.get('abstract') else 0.0)
        if score > best_score:
            best, best_score, best_comp = rec, score, comp
    return best, best_comp


def _verify_metadata_entry(parsed, transport):
    query = _metadata_query_string(parsed)
    cr_rows, cr_receipt = _query_crossref_bib(query, transport)
    epmc_query = f'TITLE:"{parsed["titleCandidate"][:140]}"' if len(parsed.get('titleCandidate') or '') >= 15 else query
    epmc_rows, epmc_receipt = _query_epmc(epmc_query, transport, query_type='bibliographic')
    receipts = [cr_receipt, epmc_receipt]
    candidates = cr_rows + epmc_rows
    best, comp = _rank_best_candidate(parsed, candidates)
    primary = _pick_primary_receipt(receipts, best['provider'] if best else None)
    base = {'index': parsed['index'], 'rawText': parsed['rawText'], 'parsed': parsed, 'requests': receipts,
            'provider': primary['provider'], 'responseSha256': primary['responseSha256'], 'retrievedAt': primary['retrievedAt']}
    if not any(r['status'] == 'ok' for r in receipts):
        return {**base, 'status': 'lookup_failed', 'retrievedRecord': None, 'scope': SCOPE_NOTE,
                'retracted': False, 'retractionType': None}
    if best and comp and _is_high_metadata_match(parsed, comp):
        ret_meta = _resolve_entry_retraction(parsed['rawText'], [best])
        return {**base, 'status': 'verified_by_metadata', 'retrievedRecord': best, 'matchDetails': comp,
                'scope': SCOPE_NOTE, **ret_meta}
    return {**base, 'status': 'unverified_no_match', 'retrievedRecord': best,
            'retracted': False, 'retractionType': None,
            'scope': f'{SCOPE_NOTE} {MISSING_MATCH_NOTE}'}


def _verify_one(parsed, transport):
    if parsed['doi']:
        return _verify_doi_entry(parsed, transport)
    return _verify_metadata_entry(parsed, transport)


def _summarize_bib_results(results, truncated):
    status_keys = {
        'verified_match': 'verifiedMatch',
        'verified_by_metadata': 'verifiedByMetadata',
        'metadata_mismatch': 'metadataMismatch',
        'doi_not_found_in_crossref': 'doiNotFoundInCrossref',
        'unverified_no_match': 'unverifiedNoMatch',
        'lookup_failed': 'lookupFailed',
    }
    counts = {key: 0 for key in status_keys.values()}
    retracted_count = 0
    for item in results:
        mapped = status_keys.get(item['status'])
        if mapped:
            counts[mapped] += 1
        if item.get('retracted') is True:
            retracted_count += 1
    counts['retractedCount'] = retracted_count
    non_failed = len(results) - counts['lookupFailed']
    status = 'completed' if non_failed == len(results) else 'partial' if non_failed > 0 else 'failed'
    return {
        'status': status,
        'checkedCount': len(results),
        'truncated': truncated,
        'summary': counts,
        'results': results,
        'limitations': f'{SCOPE_NOTE} {MISSING_MATCH_NOTE}',
    }


def verify_bibliography(references, *, max_refs=25, transport=fetch_json):
    """Deterministically verify up to max_refs (1..50) bibliography entries against Crossref and Europe PMC."""
    if type(max_refs) is not int or not 1 <= max_refs <= MAX_REFS:
        raise ValueError('max_refs_bound')
    if not isinstance(references, list):
        raise ValueError('references_invalid')
    sliced = [parse_reference_entry(r) for r in references[:max_refs]]
    if not sliced:
        return {
            'status': 'empty', 'checkedCount': 0, 'truncated': False,
            'summary': {'verifiedMatch': 0, 'verifiedByMetadata': 0, 'metadataMismatch': 0,
                        'doiNotFoundInCrossref': 0, 'unverifiedNoMatch': 0, 'lookupFailed': 0,
                        'retractedCount': 0},
            'results': [], 'limitations': f'{SCOPE_NOTE} {MISSING_MATCH_NOTE}',
        }
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda p: _verify_one(p, transport), sliced))
    return _summarize_bib_results(results, len(references) > max_refs)


def _iter_segments(segments_or_text):
    if isinstance(segments_or_text, str):
        return [(None, segments_or_text)]
    if isinstance(segments_or_text, dict) and isinstance(segments_or_text.get('segments'), list):
        segments_or_text = segments_or_text['segments']
    if isinstance(segments_or_text, list):
        out = []
        for s in segments_or_text:
            if isinstance(s, dict) and isinstance(s.get('text'), str):
                out.append((s.get('id'), s['text']))
        return out
    raise ValueError('segments_or_text_invalid')


def _split_sentences(text):
    norm = re.sub(r'\s+', ' ', text).strip()
    if not norm:
        return []
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9\u3131-\uD79D\[])', norm) if s.strip()]


def _expand_bracket_nums(spec):
    nums = []
    for part in spec.split(','):
        part = part.strip()
        range_m = re.fullmatch(r'(\d{1,4})\s*[-–—]\s*(\d{1,4})', part)
        if range_m:
            a, b = int(range_m.group(1)), int(range_m.group(2))
            if a <= b and b - a <= 20:
                nums.extend(range(a, b + 1))
        elif part.isdigit():
            nums.append(int(part))
    return nums


def _match_author_year(surname, year_str, parsed_refs):
    year = int(year_str[:4])
    s_low = surname.lower()
    for p in parsed_refs:
        if p['year'] == year and (
            (p['firstAuthorSurname'] and p['firstAuthorSurname'].lower() == s_low)
            or _surname_in_text(surname, p['rawText'])
        ):
            return p['index']
    return None


def _sentence_citations(sentence, parsed_refs, ref_by_index):
    hits, seen = [], set()
    for m in _BRACKET_CITE_RE.finditer(sentence):
        marker = m.group(0)
        for idx in _expand_bracket_nums(m.group(1)):
            if idx in ref_by_index and (idx, marker) not in seen:
                seen.add((idx, marker))
                hits.append((idx, marker))
    for pattern in (_AUTHOR_YEAR_CITE_RE, _NARRATIVE_CITE_RE):
        for m in pattern.finditer(sentence):
            idx = _match_author_year(m.group(1), m.group(2), parsed_refs)
            marker = m.group(0)
            if idx is not None and (idx, marker) not in seen:
                seen.add((idx, marker))
                hits.append((idx, marker))
    return hits


def _claim_priority(sentence):
    matches = _QUANT_CLAIM_RE.findall(sentence)
    return len(matches) * 10 + (2 if len(sentence) >= 40 else 0)


def _retrieved_payload(record):
    if not record:
        return None
    return {
        'title': record.get('title', ''),
        'authors': record.get('authors', ''),
        'year': record.get('year'),
        'doi': record.get('doi', ''),
        'abstract': record.get('abstract', ''),
        'abstractTruncated': bool(record.get('abstractTruncated')),
        'url': record.get('url', ''),
        'textSha256': record.get('textSha256'),
        'responseSha256': record.get('responseSha256'),
    }


def _normalize_ref_indices(parsed_refs):
    used = {p['index'] for p in parsed_refs if p['index'] is not None}
    normalized = []
    next_idx = 1
    for p in parsed_refs:
        if p['index'] is not None:
            normalized.append(p)
            continue
        while next_idx in used:
            next_idx += 1
        used.add(next_idx)
        normalized.append({**p, 'index': next_idx})
        next_idx += 1
    return normalized


def _collect_prioritized_claims(segments_or_text, parsed_refs):
    ref_by_index = {p['index']: p for p in parsed_refs if p['index'] is not None}
    candidates = []
    order = 0
    for seg_id, text in _iter_segments(segments_or_text):
        for sentence in _split_sentences(text):
            cites = _sentence_citations(sentence, parsed_refs, ref_by_index)
            if not cites:
                continue
            score = _claim_priority(sentence)
            for ref_idx, marker in cites:
                candidates.append((-score, order, seg_id, sentence, ref_idx, marker))
                order += 1
    candidates.sort()
    return candidates, ref_by_index


def ground_cited_claims(segments_or_text, references, *, max_claims=12, transport=fetch_json):
    """Link prioritized quantitative/causal citing sentences to bounded retrieved abstracts (T2)."""
    if type(max_claims) is not int or not 1 <= max_claims <= MAX_CLAIMS:
        raise ValueError('max_claims_bound')
    if not isinstance(references, list):
        raise ValueError('references_invalid')
    parsed_refs = _normalize_ref_indices([parse_reference_entry(r) for r in references])
    candidates, ref_by_index = _collect_prioritized_claims(segments_or_text, parsed_refs)
    selected = candidates[:max_claims]
    unique_indices = list(dict.fromkeys(c[4] for c in selected if c[4] in ref_by_index))
    with ThreadPoolExecutor(max_workers=4) as pool:
        verified_list = list(pool.map(lambda idx: (idx, _verify_one(ref_by_index[idx], transport)), unique_indices))
    verified_map = dict(verified_list)
    groundings = []
    for neg_score, _order, seg_id, sentence, ref_idx, marker in selected:
        v = verified_map.get(ref_idx)
        groundings.append({
            'refIndex': ref_idx,
            'citingSentence': sentence,
            'segmentId': seg_id,
            'citationMarker': marker,
            'priorityScore': -neg_score,
            'verificationStatus': v['status'] if v else 'reference_not_found_in_bibliography',
            'retrievedRecord': _retrieved_payload(v['retrievedRecord']) if v else None,
            'provider': v['provider'] if v else None,
            'retrievedAt': v['retrievedAt'] if v else None,
            'scope': v['scope'] if v else SCOPE_NOTE,
        })
    return {
        'status': 'completed' if groundings else 'empty',
        'totalDetected': len(candidates),
        'claimGroundings': groundings,
        'limitations': (
            f'{SCOPE_NOTE} Abstracts are truncated at {MAX_ABSTRACT_CHARS} characters. '
            'Check study population, intervention, and endpoint definitions before flagging T2 citation distortion.'
        ),
    }

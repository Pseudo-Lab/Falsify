"""Bounded public scholarly lookup. Fixed HTTPS API hosts, no arbitrary URL fetches."""
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
from urllib.parse import urlencode, quote

PROVIDERS = ('crossref', 'europepmc')
HOSTS = {'crossref': 'api.crossref.org', 'europepmc': 'www.ebi.ac.uk'}
MAX_BYTES = 500000


def plain(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', str(value)))).strip()


def request_path(provider, query):
    if provider == 'crossref':
        return '/works?' + urlencode({'query.bibliographic': query, 'rows': 3,
            'select': 'DOI,title,author,published,abstract,type,license'})
    if provider == 'europepmc':
        return '/europepmc/webservices/rest/search?' + urlencode({
            'query': query, 'format': 'json', 'resultType': 'core', 'pageSize': 3})
    raise ValueError('unknown_provider')


def fetch(provider, query):
    """No cookies, auth, proxy, redirects, retries, paper upload or model-provided URLs."""
    host = HOSTS[provider]
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('non_public_api_address')
    connection = http.client.HTTPSConnection(host, timeout=7)
    deadline = time.monotonic() + 7
    try:
        sock = socket.create_connection((addresses[0][4][0], 443), timeout=7)
        connection.sock = sock
        sock.settimeout(max(.01, deadline - time.monotonic()))
        connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        tls = connection.sock
        tls.settimeout(max(.01, deadline - time.monotonic()))
        connection.request('GET', request_path(provider, query), headers={
            'User-Agent': 'Falsify-Blue-Evidence/0.3 (bounded scholarly lookup)', 'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError('api_status_' + str(response.status))
        if 'json' not in response.getheader('Content-Type', '').lower():
            raise ValueError('api_content_type')
        parts, size = [], 0
        while True:
            tls.settimeout(max(.01, deadline - time.monotonic()))
            if time.monotonic() >= deadline:
                raise TimeoutError('api_deadline')
            chunk = response.read1(min(16384, MAX_BYTES + 1 - size))
            if not chunk:
                break
            parts.append(chunk); size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError('api_response_bound')
        raw = b''.join(parts)
        return json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        connection.close()


def normalize(provider, data, response_hash, retrieved_at):
    records = data.get('message', {}).get('items', []) if provider == 'crossref' else data.get('resultList', {}).get('result', [])
    if not isinstance(records, list):
        raise ValueError('api_records_shape')
    output = []
    for row in records[:3]:
        if not isinstance(row, dict):
            continue
        if provider == 'crossref':
            doi = plain(row.get('DOI', ''))
            titles = row.get('title', [])
            title = plain(titles[0]) if isinstance(titles, list) and titles else ''
            authors = '; '.join(plain(a.get('given', '') + ' ' + a.get('family', '')) for a in row.get('author', [])[:8])
            year = str(row.get('published', {}).get('date-parts', [['']])[0][0])
            abstract = plain(row.get('abstract', ''))
            url = 'https://doi.org/' + quote(doi, safe='/') if doi else ''
            rights = row.get('license', [])
        else:
            doi, title = plain(row.get('doi', '')), plain(row.get('title', ''))
            authors, year = plain(row.get('authorString', '')), plain(row.get('pubYear', ''))
            abstract = plain(row.get('abstractText', ''))
            source, identifier = plain(row.get('source', '')), plain(row.get('id', ''))
            url = ('https://doi.org/' + quote(doi, safe='/')) if doi else (
                'https://europepmc.org/article/' + quote(source, safe='') + '/' + quote(identifier, safe='') if source and identifier else '')
            rights = {'isOpenAccess': row.get('isOpenAccess', 'unknown')}
        if not title or not url or len(title) > 1000:
            continue
        # The delivered prefix is explicitly marked: never imply the full paper was read.
        truncated = len(abstract) > 3500
        abstract = abstract[:3500]
        metadata = 'Title: ' + title + '\nAuthors: ' + authors[:1000] + '\nYear: ' + year[:40] + '\nDOI: ' + doi[:300]
        text = metadata + ('\nAbstract' + (' (TRUNCATED PREFIX)' if truncated else '') + ': ' + abstract if abstract else '\nNo abstract supplied by API.')
        output.append({'provider': provider, 'doi': doi, 'title': title, 'url': url,
            'kind': 'metadata-and-abstract' if abstract else 'metadata-only', 'abstractTruncated': truncated,
            'text': text, 'textSha256': hashlib.sha256(text.encode()).hexdigest(),
            'responseSha256': response_hash, 'retrievedAt': retrieved_at, 'rights': rights,
            'scope': 'API metadata/abstract only; not full text, peer-review confirmation or independent scientific truth'})
    return output


def lookup(plans, transport=fetch):
    """At most one short query/role, two providers/query, deterministic ordering, no retry."""
    if set(plans) != {'statistics', 'methods'} or any(not isinstance(v, str) or not 3 <= len(v.strip()) <= 180 or any(ord(c) < 32 for c in v) for v in plans.values()):
        raise ValueError('query_contract')
    jobs = [(role, provider, query.strip()) for role, query in plans.items() for provider in PROVIDERS]
    def one(job):
        role, provider, query = job
        at = datetime.now(timezone.utc).isoformat()
        receipt = {'role': role, 'provider': provider, 'query': query, 'retrievedAt': at}
        try:
            data, sha = transport(provider, query)
            rows = normalize(provider, data, sha, at)
            receipt.update(status='ok', returnedRecords=len(rows), responseSha256=sha)
            return rows, receipt
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) and (re.fullmatch(r'api_status_\d{3}', str(error)) or str(error) in {
                'api_content_type', 'api_response_bound', 'api_records_shape', 'non_public_api_address'}) else type(error).__name__
            receipt.update(status='failed', errorCode=code)
            return [], receipt
    with ThreadPoolExecutor(max_workers=4) as pool:
        answers = list(pool.map(one, jobs))
    keys, sources, receipts = {r: [] for r in plans}, {}, []
    for (role, _, _), (rows, receipt) in zip(jobs, answers):
        receipts.append(receipt)
        for row in rows:
            key = row['doi'].lower() or row['url']
            if key not in sources:
                row['sourceId'] = 'E' + str(len(sources) + 1)
                sources[key] = row
            elif sources[key]['kind'] == 'metadata-only' and row['kind'] == 'metadata-and-abstract':
                row['sourceId'] = sources[key]['sourceId']
                sources[key] = row
            if key not in keys[role]:
                keys[role].append(key)
    packets = {role: sorted([sources[k] for k in ks], key=lambda s: s['kind'] == 'metadata-only')[:4] for role, ks in keys.items()}
    return {'status': 'completed' if all(r['status'] == 'ok' for r in receipts) else 'partial' if any(r['status'] == 'ok' for r in receipts) else 'failed',
            'requests': receipts, 'packets': packets, 'sources': list(sources.values()),
            'limitations': 'Search coverage is bounded. Missing matches are not proof of fabrication. Relevance, populations, dates and qualifications still need review. Queries leave this PC; API excerpts remain in a private local audit.'}

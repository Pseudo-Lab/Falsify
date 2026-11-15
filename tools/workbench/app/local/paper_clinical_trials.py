"""Bounded ClinicalTrials.gov v2 lookup and protocol/outcome-switching comparison."""
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time

HOST = 'clinicaltrials.gov'
MAX_TRIAL_IDS = 10
MAX_BYTES = 500_000
TIMEOUT_SECONDS = 7
USER_AGENT = 'Falsify-Blue-Evidence/0.3.6 (bounded registry lookup)'
COMPARISON_FRAMING = 'Registry protocol comparison; check published protocol amendments before concluding outcome switching.'
REGISTRY_SCOPE = 'ClinicalTrials.gov API v2 protocolSection summary only; not full published protocol amendments or statistical analysis plan.'

_NCT_EXTRACT_RE = re.compile(r'(?<![A-Za-z0-9])(NCT\d{8})(?!\d)', re.IGNORECASE)
_NCT_FULL_RE = re.compile(r'^NCT\d{8}\Z')
_PRIMARY_MENTION_RE = re.compile(
    r'(?:\bprimary\s+(?:efficacy\s+|safety\s+)?(?:outcome|endpoint)s?\b|1차\s*평가변수|주평가변수|일차\s*평가변수)',
    re.IGNORECASE,
)
_ENROLLMENT_MENTION_RE = re.compile(
    r'(?:\b[Nn]\s*=\s*(\d{1,7})\b|'
    r'\b(?:enrolled|randomized|randomised|included|recruited|total\s+of)\s+(\d{1,7})\s+(?:participants?|patients?|subjects?|individuals?|adults?)\b|'
    r'(?:총|등록|무작위\s*배정)\s*(\d{1,7})\s*명)',
    re.IGNORECASE,
)
_SUBGROUP_HINT_RE = re.compile(r'\b(?:arm|group|cohort|subgroup|placebo|control|treatment\s+group)\b', re.IGNORECASE)
_TOTAL_HINT_RE = re.compile(r'\b(?:total|overall|enrolled|randomized|randomised)\b|총', re.IGNORECASE)
_GENERIC_ENDPOINT_WORDS = frozenset({
    'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'not',
    'have', 'has', 'had', 'primary', 'outcome', 'outcomes', 'endpoint', 'endpoints',
    'assessed', 'measured', 'evaluated', 'defined', 'between', 'among', 'during',
    'after', 'before', 'patients', 'participants', 'subjects', 'study', 'trial',
    'week', 'weeks', 'month', 'months', 'day', 'days', 'year', 'years', 'change',
    'rate', 'score', 'scores', 'all', 'total', 'within', 'over', 'time', 'frame',
})


def extract_trial_ids(text):
    """Extract up to 10 unique uppercase NCT######## identifiers from text in first-seen order."""
    if not isinstance(text, str) or not text:
        return []
    found, seen = [], set()
    for m in _NCT_EXTRACT_RE.finditer(text):
        nct = m.group(1).upper()
        if nct in seen:
            continue
        seen.add(nct)
        found.append(nct)
        if len(found) >= MAX_TRIAL_IDS:
            break
    return found


def _validate_nct_id(nct_id):
    if not isinstance(nct_id, str):
        raise ValueError('invalid_nct_id')
    norm = nct_id.strip().upper()
    if not _NCT_FULL_RE.fullmatch(norm):
        raise ValueError('invalid_nct_id')
    return norm


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


def fetch_study_json(nct_id):
    """Bounded HTTPS GET to clinicaltrials.gov/api/v2/studies/NCT########. No redirects/cookies/auth."""
    norm = _validate_nct_id(nct_id)
    ip = _resolve_global_ip(HOST)
    path = f'/api/v2/studies/{norm}?format=json'
    connection = http.client.HTTPSConnection(HOST, timeout=TIMEOUT_SECONDS)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        sock = socket.create_connection((ip, 443), timeout=TIMEOUT_SECONDS)
        connection.sock = sock
        sock.settimeout(max(0.01, deadline - time.monotonic()))
        tls = ssl.create_default_context().wrap_socket(sock, server_hostname=HOST)
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


def _call_transport(transport, norm):
    try:
        res = transport(norm)
    except ValueError as error:
        if str(error) == 'api_status_404':
            return 404, None, hashlib.sha256(b'').hexdigest()
        raise
    if isinstance(res, tuple) and len(res) == 3:
        return res[0], res[1], res[2]
    if isinstance(res, tuple) and len(res) == 2:
        return 200, res[0], res[1]
    raise ValueError('transport_shape_invalid')


def _normalize_primary_outcomes(raw_list):
    out = []
    for item in (raw_list or [])[:10]:
        if isinstance(item, dict):
            out.append({
                'measure': str(item.get('measure') or '').strip(),
                'timeFrame': str(item.get('timeFrame') or '').strip(),
                'description': str(item.get('description') or '').strip()[:800],
            })
    return out


def _normalize_secondary_outcomes(raw_list):
    out = []
    for item in (raw_list or [])[:8]:
        if isinstance(item, dict):
            out.append({
                'measure': str(item.get('measure') or '').strip(),
                'timeFrame': str(item.get('timeFrame') or '').strip(),
            })
    return out


def _build_record_text(rec):
    prim = '; '.join(f"{o['measure']} ({o['timeFrame']})" if o['timeFrame'] else o['measure'] for o in rec['primaryOutcomes'])
    sec = '; '.join(o['measure'] for o in rec['secondaryOutcomes'])
    enr = rec['enrollment']
    lines = [
        f"NCT: {rec['nctId']}",
        f"Title: {rec['briefTitle']}",
        f"OfficialTitle: {rec['officialTitle']}",
        f"Status: {rec['overallStatus']} | StudyType: {rec['studyType']}",
        f"Enrollment: {enr['count']} ({enr['type']})",
        f"RegistrationDate: {rec['registrationDate']} | PrimaryCompletionDate: {rec['primaryCompletionDate']}",
        f"PrimaryOutcomes: {prim or 'None listed'}",
        f"SecondaryOutcomes: {sec or 'None listed'}",
    ]
    return '\n'.join(lines)


def _clean_str(value):
    return '' if value is None else str(value).strip()


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _normalize_protocol(norm, data, response_sha, retrieved_at):
    if not isinstance(data, dict) or not isinstance(data.get('protocolSection'), dict):
        raise ValueError('api_records_shape')
    ps = data['protocolSection']
    ident = _as_dict(ps.get('identificationModule'))
    status_mod = _as_dict(ps.get('statusModule'))
    design_mod = _as_dict(ps.get('designModule'))
    outcomes_mod = _as_dict(ps.get('outcomesModule'))
    enr_info = _as_dict(design_mod.get('enrollmentInfo'))
    post_struct = _as_dict(status_mod.get('studyFirstPostDateStruct'))
    comp_struct = _as_dict(status_mod.get('primaryCompletionDateStruct'))
    reg_date = _clean_str(post_struct.get('date')) or _clean_str(status_mod.get('studyFirstSubmitDate'))
    rec = {
        'status': 'ok',
        'nctId': _clean_str(ident.get('nctId') or norm).upper(),
        'briefTitle': _clean_str(ident.get('briefTitle')),
        'officialTitle': _clean_str(ident.get('officialTitle')),
        'overallStatus': _clean_str(status_mod.get('overallStatus')),
        'studyType': _clean_str(design_mod.get('studyType')),
        'enrollment': {'count': enr_info.get('count'), 'type': _clean_str(enr_info.get('type'))},
        'primaryOutcomes': _normalize_primary_outcomes(outcomes_mod.get('primaryOutcomes')),
        'secondaryOutcomes': _normalize_secondary_outcomes(outcomes_mod.get('secondaryOutcomes')),
        'registrationDate': reg_date,
        'primaryCompletionDate': _clean_str(comp_struct.get('date')),
        'responseSha256': response_sha,
        'retrievedAt': retrieved_at,
        'scope': REGISTRY_SCOPE,
    }
    text = _build_record_text(rec)
    rec['text'] = text
    rec['textSha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
    return rec


def fetch_trial_record(nct_id, *, transport=fetch_study_json):
    """Fetch and normalize one ClinicalTrials.gov v2 study record by NCT ID."""
    norm = _validate_nct_id(nct_id)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    status, data, response_sha = _call_transport(transport, norm)
    if status == 404:
        text = f'NCT: {norm}\nStatus: not_found_in_clinicaltrials_v2'
        return {
            'status': 'not_found',
            'nctId': norm,
            'responseSha256': response_sha,
            'text': text,
            'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
            'retrievedAt': retrieved_at,
            'scope': REGISTRY_SCOPE,
        }
    if status != 200:
        raise ValueError(f'api_status_{status}')
    return _normalize_protocol(norm, data, response_sha, retrieved_at)


def _split_sentences(text):
    norm = re.sub(r'\s+', ' ', text or '').strip()
    if not norm:
        return []
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+(?=[A-Z0-9\u3131-\uD79D])', norm) if s.strip()]


def _endpoint_tokens(text):
    return {t for t in re.findall(r'[a-z0-9]{3,}', (text or '').lower()) if t not in _GENERIC_ENDPOINT_WORDS}


def _outcome_overlap(sentence_tokens, outcome_list):
    best_score, best_measure = 0.0, ''
    for item in outcome_list:
        measure = item.get('measure', '')
        m_tokens = _endpoint_tokens(measure)
        if not m_tokens:
            continue
        score = len(sentence_tokens & m_tokens) / len(m_tokens)
        if score > best_score:
            best_score, best_measure = score, measure
    return round(best_score, 4), best_measure


def _extract_enrollment_numbers(sentence):
    nums = []
    for m in _ENROLLMENT_MENTION_RE.finditer(sentence):
        raw = m.group(1) or m.group(2) or m.group(3)
        if raw and raw.isdigit():
            nums.append(int(raw))
    return nums


def _check_primary_sentence(sentence, record):
    s_tokens = _endpoint_tokens(sentence)
    prim_score, prim_measure = _outcome_overlap(s_tokens, record.get('primaryOutcomes') or [])
    sec_score, sec_measure = _outcome_overlap(s_tokens, record.get('secondaryOutcomes') or [])
    flags = []
    has_registered_primary = bool(record.get('primaryOutcomes'))
    if has_registered_primary and len(s_tokens) >= 2:
        switched_to_secondary = sec_score > prim_score and sec_score >= 0.4 and (sec_score - prim_score) >= 0.2
        zero_primary_overlap = prim_score < 0.25
        if switched_to_secondary or zero_primary_overlap:
            flags.append('potential_outcome_switch')
    return {
        'kind': 'primary_outcome_check',
        'paperExcerpt': sentence[:400],
        'bestPrimaryOverlap': prim_score,
        'bestPrimaryMeasure': prim_measure,
        'bestSecondaryOverlap': sec_score,
        'bestSecondaryMeasure': sec_measure,
        'flags': flags,
    }


def _check_enrollment_sentence(sentence, record):
    nums = _extract_enrollment_numbers(sentence)
    enr = record.get('enrollment') or {}
    reg_count, reg_type = enr.get('count'), enr.get('type')
    flags = []
    is_subgroup_only = _SUBGROUP_HINT_RE.search(sentence) and not _TOTAL_HINT_RE.search(sentence)
    if (
        reg_type == 'ACTUAL'
        and isinstance(reg_count, int)
        and reg_count > 0
        and nums
        and not is_subgroup_only
    ):
        closest_diff = min(abs(n - reg_count) for n in nums)
        if closest_diff >= 5 and (closest_diff / reg_count) >= 0.15:
            flags.append('enrollment_discrepancy_candidate')
    return {
        'kind': 'enrollment_check',
        'paperExcerpt': sentence[:400],
        'statedCounts': nums,
        'registeredEnrollment': enr,
        'flags': flags,
    }


def _compare_single_record(sentences, record):
    nct_id = record.get('nctId', '')
    if record.get('status') != 'ok':
        return {
            'nctId': nct_id, 'status': record.get('status', 'unavailable'),
            'flags': [], 'checks': [], 'note': COMPARISON_FRAMING,
        }
    checks, flags = [], []
    for sent in sentences:
        if _PRIMARY_MENTION_RE.search(sent):
            chk = _check_primary_sentence(sent, record)
            checks.append(chk)
            flags.extend(f for f in chk['flags'] if f not in flags)
        if _ENROLLMENT_MENTION_RE.search(sent):
            chk = _check_enrollment_sentence(sent, record)
            checks.append(chk)
            flags.extend(f for f in chk['flags'] if f not in flags)
    return {
        'nctId': nct_id,
        'status': 'compared',
        'briefTitle': record.get('briefTitle', ''),
        'overallStatus': record.get('overallStatus', ''),
        'registeredEnrollment': record.get('enrollment'),
        'registeredPrimaryOutcomes': record.get('primaryOutcomes', []),
        'registeredSecondaryOutcomes': record.get('secondaryOutcomes', []),
        'flags': flags,
        'checks': checks,
        'responseSha256': record.get('responseSha256'),
        'textSha256': record.get('textSha256'),
        'note': COMPARISON_FRAMING,
    }


def compare_paper_with_registry(paper_text, trial_records):
    """Compare paper primary-outcome and enrollment statements against ClinicalTrials.gov records."""
    if not isinstance(paper_text, str):
        raise ValueError('paper_text_invalid')
    if not isinstance(trial_records, list):
        raise ValueError('trial_records_invalid')
    sentences = _split_sentences(paper_text)
    relevant = [s for s in sentences if _PRIMARY_MENTION_RE.search(s) or _ENROLLMENT_MENTION_RE.search(s)]
    comparisons = [_compare_single_record(relevant, rec) for rec in trial_records if isinstance(rec, dict)]
    return {
        'status': 'completed' if comparisons else 'empty',
        'registryComparisons': comparisons,
        'extractedSentenceCount': len(relevant),
        'note': COMPARISON_FRAMING,
    }

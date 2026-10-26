"""Offline preparation for a controlled BLUE comparison of ORIGINAL, E1 and H1.

Stdlib only. This module does not call a model, read a private paper, or decide
detection correctness. It checks a synthetic or operator-supplied packet against
the existing BLUE result, harness digest, source-text hash and review vocabulary,
then counts outcomes under one fixed portable strategy, requested model and budget.

A failed or cancelled job is never a successful zero-findings result. Machine
config hashes are recorded and are not strategy identity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

SCHEMA = 'falsify.controlled-blue-prep.v1'
SUMMARY_SCHEMA = 'falsify.controlled-blue-summary.v1'
BLUE_SCHEMA = 'falsify.document-blue.v1'
HARNESS_SCHEMA = 'falsify.harness.v1'
ARMS = ('ORIGINAL', 'E1', 'H1')
JOB_STATES = ('completed', 'failed', 'cancelled')
RESPONSE_STATUSES = ('ok', 'abstain', 'refusal')
PROVENANCES = ('local-codex', 'manual-unverified', 'imported-unverified')
VERDICTS = ('uncertain', 'supported', 'unsupported', 'mixed')
JUDGMENTS = ('matched', 'unmatched', 'duplicate')
PRIMARY = (
    'failed', 'cancelled', 'refusal', 'abstain', 'completed-zero-findings',
    'human-unreviewed', 'matched-findings', 'human-reviewed-no-match', 'gold-unknown',
)
OK_CLASSES = (
    'completed-zero-findings', 'human-unreviewed', 'matched-findings',
    'human-reviewed-no-match', 'gold-unknown',
)
# Same allow-list as pending-job BLUE_KEYS. harnessCanonical is the browser's exact
# canonical string; harness.resolve hashes those bytes and does not re-encode them.
REQUEST_REQUIRED = (
    'schema', 'revision', 'requestId', 'sourceHash', 'segments', 'maxCalls',
    'consent', 'harness', 'executionConsent',
)
REQUEST_OPTIONAL = ('harnessCanonical',)
REQUEST_KEYS = set(REQUEST_REQUIRED) | set(REQUEST_OPTIONAL)
CANONICAL_LIMIT = 60000
SEGMENT_KEYS = {'id', 'label', 'text'}
FINDING_KEYS = {'id', 'segmentId', 'quote', 'rationale', 'uncertainty', 'evidence'}
EVIDENCE_KEYS = {'segmentId', 'quote', 'relation'}
RESULT_REQUIRED = {'schema', 'revision', 'sourceHash', 'status', 'findings', 'harnessHash', 'model', 'harness'}
# Keys blue_service.finish adds beyond the findings contract. cliSelection is harness.record
# for an explicit CLI selection (provider, model, effort). isolation is always set.
# coverage is the call record. These are kept verbatim; the preparer does not drop them before hashing.
RESULT_OPTIONAL = {'coverage', 'isolation', 'cliSelection'}
MACHINE_SETTINGS = {'auditDirectory'}
# Joined supplied text and segment count match app/local/red_service.py validate_request,
# which BLUE reuses. A packet holds several full copies, so it is larger than one paper.
MAX_SOURCE_CHARS = 1_000_000
MAX_SEGMENTS = 10000
MAX_PACKET = 16 * 1024 * 1024
FORBIDDEN_REQUEST_KEYS = {
    'gold', 'plan', 'comparison', 'reviews', 'assessments', 'answer', 'answerkey',
    'redplan', 'priorresponse', 'filename', 'sourcename', 'file', 'bytes', 'pdf',
    'pdfbytes', 'token', 'authorization', 'secret', 'password', 'apikey', 'api_key',
    'bearer', 'cookie', 'session', 'findings', 'candidates',
}
SECRET_KEYS = {'token', 'authorization', 'secret', 'password', 'apikey', 'api_key', 'bearer', 'cookie', 'session'}
HEX64 = 64
NOTICE = (
    'Preparation only. Successful execution is not detection. '
    'A failed or cancelled job with no final findings is not completed-zero-findings. '
    'Portable strategy id, version and bundle hash are the strategy identity; '
    'machine config hashes are not. Requested model, verified model, calls, cost, '
    'source hash, gold version and human judgment stay explicit. '
    'Packet gold is not scientific gold. No ranking is computed.'
)


class PrepError(Exception):
    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__('; '.join(self.errors))


def _repo_local():
    return Path(__file__).resolve().parents[2] / 'app' / 'local'


def _harness_module():
    local = str(_repo_local())
    if local not in sys.path:
        sys.path.insert(0, local)
    import harness
    return harness


def _blue_module():
    local = str(_repo_local())
    if local not in sys.path:
        sys.path.insert(0, local)
    import blue_service
    return blue_service


def canonical_digest(value):
    """Same digest as app/local/harness.py digest: sorted JSON, no ASCII escaping."""
    return _harness_module().digest(value)


def source_text_hash(segments):
    """Same join as cloud-records-core checkRun: segment texts separated by a blank line."""
    return hashlib.sha256('\n\n'.join(segment['text'] for segment in segments).encode('utf-8')).hexdigest()


def outcome_class(job_state, status, finding_count, reviewed, matched):
    """One primary class. Job failure wins over an empty findings list."""
    if job_state == 'failed':
        return 'failed'
    if job_state == 'cancelled':
        return 'cancelled'
    if job_state != 'completed':
        return 'unknown'
    if status == 'refusal':
        return 'refusal'
    if status == 'abstain':
        return 'abstain'
    if status != 'ok':
        return 'unknown'
    if finding_count == 0:
        return 'completed-zero-findings'
    if not reviewed:
        return 'human-unreviewed'
    if matched:
        return 'matched-findings'
    return 'human-reviewed-no-match'


def portable_projection(harness, path_map=None, machine_setting_keys=None):
    """Map only exact path tokens named in path_map. Flags and unmapped args stay."""
    path_map = {} if path_map is None else path_map
    if machine_setting_keys is None:
        machine_setting_keys = ('auditDirectory',)
    projected = json.loads(json.dumps(harness))
    adapter = projected.get('adapter')
    if isinstance(adapter, dict):
        if isinstance(adapter.get('executable'), str) and adapter['executable'] in path_map:
            adapter['executable'] = path_map[adapter['executable']]
        args = adapter.get('args')
        if isinstance(args, list):
            adapter['args'] = [path_map[arg] if isinstance(arg, str) and arg in path_map else arg for arg in args]
    settings = projected.get('settings')
    if isinstance(settings, dict):
        for key in machine_setting_keys:
            settings.pop(key, None)
    return projected


def unmapped_adapter_paths(harness, path_map):
    """Path-like executable/args that the packet did not explicitly map. Flags are never listed."""
    adapter = harness.get('adapter') if isinstance(harness.get('adapter'), dict) else {}
    tokens = []
    if isinstance(adapter.get('executable'), str):
        tokens.append(adapter['executable'])
    args = adapter.get('args')
    if isinstance(args, list):
        tokens.extend(arg for arg in args if isinstance(arg, str))
    missing = []
    for token in tokens:
        if token in path_map or token.startswith('-'):
            continue
        if '/' in token or '\\' in token or (len(token) > 2 and token[1] == ':'):
            missing.append(token)
    return missing


def _reject_constants(text):
    raise PrepError(['nonfinite_number'])


def _no_duplicates(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise PrepError([f'duplicate_key:{key}'])
        seen[key] = value
    return seen


def load_packet(raw):
    if not isinstance(raw, (bytes, bytearray)):
        raw = raw.encode('utf-8')
    if not raw or len(raw) > MAX_PACKET:
        raise PrepError(['packet_size'])
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_no_duplicates, parse_constant=_reject_constants)
    except PrepError:
        raise
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PrepError(['packet_json']) from error
    return value


def _exact(value, required, optional, field, errors):
    if not isinstance(value, dict):
        errors.append(field)
        return False
    missing = [key for key in required if key not in value]
    extra = [key for key in value if key not in required and key not in optional]
    if missing or extra:
        errors.append(field + ('' if not missing else ':' + ','.join(missing)))
        return False
    return True


def _hex(value, field, errors):
    if not isinstance(value, str) or len(value) != HEX64 or any(ch not in '0123456789abcdef' for ch in value):
        errors.append(field)
        return None
    return value


def _text(value, limit, field, errors):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or '\x00' in value:
        errors.append(field)
        return None
    return value


def _arm_name(value, field, errors):
    if value not in ARMS:
        errors.append(field)
        return None
    return value


def _secret_keys(value, field, errors, depth=0):
    if depth > 8 or not isinstance(value, (dict, list)):
        return
    items = value.items() if isinstance(value, dict) else ()
    for key, child in items:
        if str(key).lower() in SECRET_KEYS:
            errors.append(field + ':secret')
        _secret_keys(child, field, errors, depth + 1)
    if isinstance(value, list):
        for child in value:
            _secret_keys(child, field, errors, depth + 1)


def _forbidden_request(value, errors, depth=0):
    if depth > 12:
        errors.append('request:depth')
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in FORBIDDEN_REQUEST_KEYS:
                errors.append('blind_violation:' + str(key))
            _forbidden_request(child, errors, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _forbidden_request(child, errors, depth + 1)


def _check_strategy(packet, errors):
    strategy = packet.get('strategy')
    if not _exact(strategy, ('id', 'version', 'bundleSha256', 'portable'), ('pathMap', 'machineSettingKeys'), 'strategy', errors):
        return None
    if not isinstance(strategy['id'], str) or not strategy['id'].strip() or len(strategy['id']) > 80:
        errors.append('strategy.id')
    if not isinstance(strategy['version'], str) or not strategy['version'].strip() or len(strategy['version']) > 80:
        errors.append('strategy.version')
    _hex(strategy['bundleSha256'], 'strategy.bundleSha256', errors)
    portable = strategy['portable']
    if not isinstance(portable, dict):
        errors.append('strategy.portable')
        return None
    _secret_keys(portable, 'strategy.portable', errors)
    if portable.get('schema') != HARNESS_SCHEMA or portable.get('role') != 'blue':
        errors.append('strategy.portable.schema')
    if portable.get('id') != strategy['id'] or portable.get('version') != strategy['version']:
        errors.append('strategy.portable.identity')
    settings = portable.get('settings')
    if not isinstance(settings, dict) or settings.get('bundleSha256') != strategy['bundleSha256']:
        errors.append('strategy.bundle')
    adapter = portable.get('adapter')
    if not isinstance(adapter, dict):
        errors.append('strategy.portable.adapter')
    keys = strategy.get('machineSettingKeys', ['auditDirectory'])
    if not isinstance(keys, list) or any(key != 'auditDirectory' for key in keys):
        errors.append('strategy.machineSettingKeys')
    elif isinstance(settings, dict) and any(key in settings for key in keys):
        errors.append('strategy.portable.machine')
    path_map = strategy.get('pathMap', {})
    if not isinstance(path_map, dict) or len(path_map) > 64:
        errors.append('strategy.pathMap')
    else:
        for source, target in path_map.items():
            if not isinstance(source, str) or not source or source.startswith('-') or len(source) > 2000:
                errors.append('strategy.pathMap')
            if not isinstance(target, str) or not target.strip() or target.startswith('-') or len(target) > 200:
                errors.append('strategy.pathMap')
    return strategy


def _check_fixed(packet, errors):
    fixed = packet.get('fixed')
    required = ('requestedModel', 'maxCalls', 'internalMaxCalls', 'goldVersion', 'protocolVersion', 'caseLabel')
    if not _exact(fixed, required, (), 'fixed', errors):
        return None
    _text(fixed['requestedModel'], 120, 'fixed.requestedModel', errors)
    if type(fixed['maxCalls']) is not int or not 1 <= fixed['maxCalls'] <= 32:
        errors.append('fixed.maxCalls')
    if type(fixed['internalMaxCalls']) is not int or not 1 <= fixed['internalMaxCalls'] <= 32:
        errors.append('fixed.internalMaxCalls')
    if fixed['goldVersion'] is not None:
        _text(fixed['goldVersion'], 80, 'fixed.goldVersion', errors)
    if fixed['protocolVersion'] != BLUE_SCHEMA:
        errors.append('fixed.protocolVersion')
    _text(fixed['caseLabel'], 160, 'fixed.caseLabel', errors)
    return fixed


def _check_arms(packet, errors):
    arms = packet.get('arms')
    if not isinstance(arms, dict) or set(arms) != set(ARMS):
        errors.append('arms')
        return None
    for name in ARMS:
        arm = arms[name]
        if not _exact(arm, ('sourceHash', 'fileHash', 'revision'), (), 'arms.' + name, errors):
            continue
        _hex(arm['sourceHash'], f'arms.{name}.sourceHash', errors)
        _hex(arm['fileHash'], f'arms.{name}.fileHash', errors)
        _text(arm['revision'], 160, f'arms.{name}.revision', errors)
    return arms


def _check_segments(segments, field, errors):
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_SEGMENTS:
        errors.append(field)
        return None
    ids = set()
    total = 0
    for index, segment in enumerate(segments):
        where = f'{field}[{index}]'
        if not isinstance(segment, dict) or set(segment) != SEGMENT_KEYS:
            errors.append(where)
            continue
        if not isinstance(segment['id'], str) or not segment['id'] or len(segment['id']) > 80 or segment['id'] in ids:
            errors.append(where + '.id')
        ids.add(segment['id'])
        if not isinstance(segment['label'], str) or len(segment['label']) > 200:
            errors.append(where + '.label')
        text = segment.get('text')
        if not isinstance(text, str) or not text.strip() or '\x00' in text:
            errors.append(where + '.text')
            continue
        total += len(text) + (2 if index else 0)
    if total > MAX_SOURCE_CHARS:
        errors.append(field + '.source')
    return segments


def _check_findings(findings, errors):
    if not isinstance(findings, list) or len(findings) > 12:
        errors.append('result.findings')
        return False
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict) or set(finding) != FINDING_KEYS:
            errors.append(f'result.findings[{index}]')
            return False
        evidence = finding['evidence']
        if not isinstance(evidence, list) or not 1 <= len(evidence) <= 6:
            errors.append(f'result.findings[{index}].evidence')
            return False
        for item in evidence:
            if not isinstance(item, dict) or set(item) != EVIDENCE_KEYS:
                errors.append(f'result.findings[{index}].evidence')
                return False
    return True


def _check_trial_shape(trial, index, errors):
    field = f'trials[{index}]'
    required = (
        'id', 'arm', 'repeat', 'provenance', 'harness', 'job', 'request', 'result',
        'rawResponseSha256', 'model', 'calls', 'cost',
    )
    if not _exact(trial, required, (), field, errors):
        return False
    _text(trial['id'], 80, field + '.id', errors)
    _arm_name(trial['arm'], field + '.arm', errors)
    if type(trial['repeat']) is not int or not 1 <= trial['repeat'] <= 32:
        errors.append(field + '.repeat')
    if trial['provenance'] not in PROVENANCES:
        errors.append(field + '.provenance')
    if not isinstance(trial['harness'], dict):
        errors.append(field + '.harness')
    else:
        _secret_keys(trial['harness'], field + '.harness', errors)
    job = trial['job']
    if _exact(job, ('id', 'state', 'role', 'sourceHash', 'fileHash', 'revision', 'harnessHash', 'requestBytesDigest', 'companionInstance'), (), field + '.job', errors):
        _text(job['id'], 160, field + '.job.id', errors)
        if job['state'] not in JOB_STATES:
            errors.append(field + '.job.state')
        if job['role'] != 'blue':
            errors.append(field + '.job.role')
        _hex(job['sourceHash'], field + '.job.sourceHash', errors)
        _hex(job['fileHash'], field + '.job.fileHash', errors)
        _text(job['revision'], 160, field + '.job.revision', errors)
        _hex(job['harnessHash'], field + '.job.harnessHash', errors)
        _hex(job['requestBytesDigest'], field + '.job.requestBytesDigest', errors)
        instance = job['companionInstance']
        if not isinstance(instance, str) or len(instance) != 4 + 64 or not instance.startswith('ci1.') or any(ch not in '0123456789abcdef' for ch in instance[4:]):
            errors.append(field + '.job.companionInstance')
    request = trial['request']
    if isinstance(request, dict):
        _forbidden_request(request, errors)
        if not _exact(request, REQUEST_REQUIRED, REQUEST_OPTIONAL, field + '.request', errors):
            pass
        elif request['schema'] != BLUE_SCHEMA or request['consent'] is not True:
            errors.append(field + '.request.contract')
        else:
            _check_segments(request['segments'], field + '.request.segments', errors)
            if 'harnessCanonical' in request:
                canonical = request['harnessCanonical']
                if not isinstance(canonical, str) or not canonical.strip() or len(canonical) > CANONICAL_LIMIT or '\x00' in canonical:
                    errors.append(field + '.request.harnessCanonical')
    else:
        errors.append(field + '.request')
    model = trial['model']
    if _exact(model, ('requested', 'verified'), (), field + '.model', errors):
        _text(model['requested'], 120, field + '.model.requested', errors)
        if model['verified'] is not None:
            _text(model['verified'], 120, field + '.model.verified', errors)
    if trial['calls'] is not None and (type(trial['calls']) is not int or trial['calls'] < 0 or trial['calls'] > 100000):
        errors.append(field + '.calls')
    if trial['cost'] is not None:
        errors.append(field + '.cost')
    state = job.get('state') if isinstance(job, dict) else None
    if state in ('failed', 'cancelled'):
        if trial['result'] is not None or trial['rawResponseSha256'] is not None:
            errors.append(field + '.discarded_result')
    elif state == 'completed':
        _hex(trial['rawResponseSha256'], field + '.rawResponseSha256', errors)
        result = trial['result']
        if _exact(result, RESULT_REQUIRED, RESULT_OPTIONAL, field + '.result', errors):
            if result['schema'] != BLUE_SCHEMA or result['status'] not in RESPONSE_STATUSES:
                errors.append(field + '.result.status')
            _check_findings(result['findings'], errors)
            coverage = result.get('coverage')
            if coverage is not None and (not isinstance(coverage, dict) or not isinstance(coverage.get('complete'), bool)):
                errors.append(field + '.result.coverage')
            if 'isolation' in result and (not isinstance(result['isolation'], str) or not result['isolation'].strip() or len(result['isolation']) > 300):
                errors.append(field + '.result.isolation')
            if 'cliSelection' in result:
                selection = result['cliSelection']
                if not isinstance(selection, dict) or set(selection) != {'provider', 'model', 'effort'}:
                    errors.append(field + '.result.cliSelection')
                elif any(not isinstance(selection[key], str) or not selection[key].strip() for key in ('provider', 'model', 'effort')):
                    errors.append(field + '.result.cliSelection')
    return True


def _check_gold(packet, fixed, errors):
    if 'gold' not in packet:
        if fixed and fixed.get('goldVersion') is not None:
            errors.append('gold_missing')
        return None
    gold = packet['gold']
    if not _exact(gold, ('version', 'scientificGold', 'items'), (), 'gold', errors):
        return None
    if gold['scientificGold'] is not False:
        errors.append('gold.scientificGold')
    _text(gold['version'], 80, 'gold.version', errors)
    if fixed and gold.get('version') != fixed.get('goldVersion'):
        errors.append('gold.version_mismatch')
    if not isinstance(gold['items'], list) or len(gold['items']) > 64:
        errors.append('gold.items')
        return None
    for index, item in enumerate(gold['items']):
        if not _exact(item, ('id', 'segmentId', 'quote'), (), f'gold.items[{index}]', errors):
            continue
        _text(item['id'], 80, f'gold.items[{index}].id', errors)
        _text(item['segmentId'], 80, f'gold.items[{index}].segmentId', errors)
        _text(item['quote'], 4000, f'gold.items[{index}].quote', errors)
    return gold


def _check_reviews(packet, errors):
    reviews = packet.get('reviews', [])
    if not isinstance(reviews, list) or len(reviews) > 300:
        errors.append('reviews')
        return []
    for index, review in enumerate(reviews):
        field = f'reviews[{index}]'
        if not _exact(review, ('id', 'trialId', 'reviewer', 'caseLabel', 'protocolVersion', 'verdict', 'score', 'note', 'judgments'), (), field, errors):
            continue
        _text(review['id'], 80, field + '.id', errors)
        _text(review['trialId'], 80, field + '.trialId', errors)
        _text(review['reviewer'], 120, field + '.reviewer', errors)
        _text(review['caseLabel'], 160, field + '.caseLabel', errors)
        if review['protocolVersion'] != BLUE_SCHEMA:
            errors.append(field + '.protocolVersion')
        if review['verdict'] not in VERDICTS:
            errors.append(field + '.verdict')
        score = review['score']
        if review.get('verdict') == 'uncertain':
            if score is not None:
                errors.append(field + '.score')
        elif score is not None and (type(score) is not int or not 1 <= score <= 5):
            errors.append(field + '.score')
        _text(review['note'], 3000, field + '.note', errors)
        judgments = review['judgments']
        if not isinstance(judgments, list) or len(judgments) > 64:
            errors.append(field + '.judgments')
            continue
        for jndex, judgment in enumerate(judgments):
            where = f'{field}.judgments[{jndex}]'
            if not _exact(judgment, ('goldId', 'findingId', 'judgment'), (), where, errors):
                continue
            _text(judgment['goldId'], 80, where + '.goldId', errors)
            if judgment['findingId'] is not None:
                _text(judgment['findingId'], 80, where + '.findingId', errors)
            if judgment['judgment'] not in JUDGMENTS:
                errors.append(where + '.judgment')
    return reviews


def validate_structure(packet):
    errors = []
    if not isinstance(packet, dict) or packet.get('schema') != SCHEMA:
        raise PrepError(['schema'])
    allowed = {'schema', 'strategy', 'fixed', 'arms', 'trials', 'gold', 'reviews'}
    if set(packet) - allowed:
        errors.append('unknown_field')
    strategy = _check_strategy(packet, errors)
    fixed = _check_fixed(packet, errors)
    arms = _check_arms(packet, errors)
    trials = packet.get('trials')
    if not isinstance(trials, list) or not trials or len(trials) > 96:
        errors.append('trials')
        trials = []
    else:
        for index, trial in enumerate(trials):
            _check_trial_shape(trial, index, errors)
    _check_gold(packet, fixed, errors)
    _check_reviews(packet, errors)
    if errors:
        raise PrepError(errors)
    return packet


def _warn(bucket, code, trial_id):
    bucket.setdefault(code, set())
    if trial_id is not None:
        bucket[code].add(trial_id)


def _usable_gold(gold):
    if not gold:
        return set(), set()
    counts = {}
    for item in gold['items']:
        counts[item['id']] = counts.get(item['id'], 0) + 1
    duplicate = {item_id for item_id, count in counts.items() if count > 1}
    usable = set(counts) - duplicate
    return usable, duplicate


def _selected_review(reviews, trial, fixed, warnings):
    matched = []
    for review in reviews:
        if review['trialId'] != trial['id']:
            continue
        if review['caseLabel'] != fixed['caseLabel'] or review['protocolVersion'] != fixed['protocolVersion']:
            _warn(warnings, 'review_condition_mismatch', trial['id'])
            continue
        matched.append(review)
    if len(matched) > 1:
        _warn(warnings, 'multiple_reviews', trial['id'])
        return None
    return matched[0] if matched else None


def _accepted_judgments(review, finding_ids, usable, duplicate, warnings, trial_id):
    matched = unmatched = duplicates = 0
    seen = set()
    if review is None:
        return matched, unmatched, duplicates
    for judgment in review['judgments']:
        gold_id = judgment['goldId']
        key = (gold_id, judgment['findingId'], judgment['judgment'])
        if key in seen:
            _warn(warnings, 'duplicate_judgment', trial_id)
            continue
        seen.add(key)
        if gold_id in duplicate:
            _warn(warnings, 'duplicate_gold', trial_id)
            continue
        if gold_id not in usable:
            _warn(warnings, 'unmatched_gold', trial_id)
            continue
        kind = judgment['judgment']
        finding_id = judgment['findingId']
        if kind == 'matched':
            if finding_id not in finding_ids:
                _warn(warnings, 'match_without_finding', trial_id)
                continue
            matched += 1
        elif kind == 'unmatched':
            unmatched += 1
        else:
            duplicates += 1
    return matched, unmatched, duplicates


def _harness_requested_model(harness, label):
    settings = harness.get('settings') if isinstance(harness.get('settings'), dict) else {}
    if isinstance(settings.get('model'), str):
        return settings['model']
    adapter = harness.get('adapter') if isinstance(harness.get('adapter'), dict) else {}
    if isinstance(adapter.get('model'), str):
        return adapter['model']
    if isinstance(label, str) and not label.endswith('model-unverified'):
        return label
    return None


def _recorded_machine_hash(trial):
    """Hash the service records for this harness.

    With no harnessCanonical, that is harness.digest of the stored object.
    With a canonical string, harness.resolve hashes that exact UTF-8 text.
    Re-dumping the object is a different hash when spacing or key order differs.
    """
    request = trial['request'] if isinstance(trial.get('request'), dict) else {}
    if 'harnessCanonical' not in request:
        try:
            return canonical_digest(trial.get('harness')), False
        except (TypeError, ValueError):
            return None, False
    try:
        _resolved, recorded = _harness_module().resolve(
            {'harness': request.get('harness'), 'harnessCanonical': request['harnessCanonical']},
            'blue',
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return None, True
    return recorded, False


def _condition_reasons(trial, strategy, fixed, arms):
    reasons = []
    harness = trial['harness']
    path_map = strategy.get('pathMap') or {}
    machine_keys = strategy.get('machineSettingKeys', ['auditDirectory'])
    projected = portable_projection(harness, path_map, machine_keys)
    if projected != strategy['portable']:
        reasons.append('portable_strategy')
    if unmapped_adapter_paths(harness, path_map):
        reasons.append('unmapped_adapter_path')
    settings = harness.get('settings') if isinstance(harness.get('settings'), dict) else {}
    if _harness_requested_model(harness, None) != fixed['requestedModel'] or trial['model']['requested'] != fixed['requestedModel']:
        reasons.append('requested_model')
    if harness.get('maxCalls') != fixed['maxCalls'] or trial['request'].get('maxCalls') != fixed['maxCalls']:
        reasons.append('budget')
    if settings.get('internalMaxCalls') != fixed['internalMaxCalls']:
        reasons.append('budget')
    arm = arms.get(trial['arm']) if isinstance(trial.get('arm'), str) else None
    job = trial['job']
    request = trial['request']
    if not isinstance(arm, dict) or job.get('sourceHash') != arm['sourceHash'] or request.get('sourceHash') != arm['sourceHash']:
        reasons.append('source_hash')
    elif request.get('segments') and source_text_hash(request['segments']) != arm['sourceHash']:
        reasons.append('source_hash')
    if not isinstance(arm, dict) or job.get('fileHash') != arm['fileHash']:
        reasons.append('file_hash')
    if not isinstance(arm, dict) or job.get('revision') != arm['revision'] or request.get('revision') != arm['revision']:
        reasons.append('revision')
    machine, canonical_failed = _recorded_machine_hash(trial)
    if canonical_failed or ('harnessCanonical' in request and job.get('harnessHash') != machine):
        reasons.append('harness_canonical')
    elif machine is None or job.get('harnessHash') != machine:
        reasons.append('machine_hash_unverified')
    if request.get('harness') != harness:
        reasons.append('harness_not_frozen')
    if request.get('requestId') != job.get('id'):
        reasons.append('request_id')
    if request.get('executionConsent') is not True:
        reasons.append('consent')
    return reasons, machine


def _result_reasons(trial, machine, label):
    reasons = []
    result = trial['result']
    if canonical_digest(result) != trial['rawResponseSha256']:
        reasons.append('response_not_immutable')
    if result.get('harness') != trial['harness'] or result.get('harnessHash') != machine:
        reasons.append('harness_not_frozen')
    if result.get('sourceHash') != trial['job'].get('sourceHash') or result.get('revision') != trial['job'].get('revision'):
        reasons.append('result_binding')
    if result.get('model') != label:
        reasons.append('app_model_label')
    recorded = _harness_module().record(trial['harness'])
    if ('cliSelection' in result or 'cliSelection' in recorded) and result.get('cliSelection') != recorded.get('cliSelection'):
        reasons.append('recorded_metadata')
    if result['status'] != 'ok' and result['findings']:
        reasons.append('non_ok_findings')
        return reasons
    try:
        _blue_module().validate_findings(result, trial['request']['segments'])
    except (ValueError, KeyError, TypeError):
        reasons.append('evidence_rejected')
    return reasons


def _verified_model(trial, warnings):
    claimed = trial['model']['verified']
    if trial['provenance'] != 'local-codex':
        if claimed is not None:
            _warn(warnings, 'unverified_model', trial['id'])
        return 'unknown'
    if claimed is None:
        return 'unknown'
    return {'observed': claimed, 'certified': False}


def evaluate(packet):
    packet = validate_structure(packet)
    strategy = packet['strategy']
    fixed = packet['fixed']
    arms = packet['arms']
    gold = packet.get('gold')
    reviews = packet.get('reviews', [])
    warnings = {}
    usable, duplicate = _usable_gold(gold)
    if duplicate:
        _warn(warnings, 'duplicate_gold', None)
    if fixed['goldVersion'] is None:
        _warn(warnings, 'gold_missing', None)
    trial_ids = {trial['id'] for trial in packet['trials']}
    for review in reviews:
        if review['trialId'] not in trial_ids:
            _warn(warnings, 'review_run_missing', None)
    rows = []
    seen_ids = set()
    seen_repeats = set()
    for trial in packet['trials']:
        if trial['id'] in seen_ids or (trial['arm'], trial['repeat']) in seen_repeats:
            raise PrepError(['duplicate_trial'])
        seen_ids.add(trial['id'])
        seen_repeats.add((trial['arm'], trial['repeat']))
        reasons, machine = _condition_reasons(trial, strategy, fixed, arms)
        label = None
        try:
            label = _harness_module().model_label(trial['harness'])
        except (TypeError, ValueError, KeyError):
            reasons.append('app_model_label')
        verified = _verified_model(trial, warnings)
        review = None
        matched = unmatched = duplicates = 0
        finding_ids = set()
        if trial['job']['state'] == 'completed' and 'response_not_immutable' not in reasons:
            result_reasons = _result_reasons(trial, machine, label)
            reasons.extend(result_reasons)
            if 'evidence_rejected' not in reasons and 'non_ok_findings' not in reasons and 'response_not_immutable' not in reasons:
                finding_ids = {finding['id'] for finding in trial['result']['findings']}
        if reasons:
            for reason in reasons:
                _warn(warnings, 'incompatible_condition:' + reason, trial['id'])
        else:
            review = _selected_review(reviews, trial, fixed, warnings)
            if fixed['goldVersion'] is None:
                matched = unmatched = duplicates = 0
            else:
                matched, unmatched, duplicates = _accepted_judgments(
                    review, finding_ids, usable, duplicate, warnings, trial['id'])
        reviewed = review is not None and fixed['goldVersion'] is not None
        if trial['job']['state'] == 'completed' and not reasons:
            status = trial['result']['status']
            finding_count = len(trial['result']['findings'])
        else:
            status = None
            finding_count = 0
        kind = outcome_class(trial['job']['state'], status, finding_count, reviewed, matched > 0)
        # A stored review cannot become a match, or a claim of no match, while gold is absent.
        if not reasons and fixed['goldVersion'] is None and review is not None and status == 'ok' and finding_count > 0:
            kind = 'gold-unknown'
        if reasons:
            kind_for_counts = None
        else:
            kind_for_counts = kind
        rows.append({
            'id': trial['id'],
            'arm': trial['arm'],
            'repeat': trial['repeat'],
            'included': not reasons,
            'class': kind if not reasons else 'excluded',
            'countedClass': kind_for_counts,
            'reasons': reasons,
            'machineConfigHash': machine,
            'verifiedModel': verified if not reasons else 'unknown',
            'calls': trial['calls'] if not reasons else None,
            'cost': 'unknown',
            'matchedJudgments': matched if not reasons else 0,
            'unmatchedJudgments': unmatched if not reasons else 0,
            'duplicateJudgments': duplicates if not reasons else 0,
            'findingCount': finding_count if not reasons else 0,
            'appModelLabel': label,
            'requestId': trial['job'].get('id'),
            'requestBytesDigest': trial['job']['requestBytesDigest'],
            'rawResponseSha256': trial['rawResponseSha256'],
            'companionInstance': trial['job']['companionInstance'],
            'independence': 'distinct-request',
        })
    _mark_repeats(rows, warnings)
    return _summarize(packet, rows, warnings, usable, duplicate)


def _exclude_replay(row):
    row['included'] = False
    row['countedClass'] = None
    row['class'] = 'excluded'
    row['independence'] = 'replay'
    row['reasons'] = list(dict.fromkeys([*row['reasons'], 'repeat_replay']))
    row['matchedJudgments'] = 0
    row['unmatchedJudgments'] = 0
    row['duplicateJudgments'] = 0


def _mark_repeats(rows, warnings):
    included = [row for row in rows if row['included']]
    replay_ids = set()
    for left in included:
        for right in included:
            if left['id'] >= right['id']:
                continue
            same_request = left['requestId'] == right['requestId'] or left['requestBytesDigest'] == right['requestBytesDigest']
            if same_request:
                _warn(warnings, 'repeat_replay', left['id'])
                _warn(warnings, 'repeat_replay', right['id'])
                replay_ids.add(left['id'])
                replay_ids.add(right['id'])
            elif left['rawResponseSha256'] and left['rawResponseSha256'] == right['rawResponseSha256']:
                _warn(warnings, 'independence_unknown', left['id'])
                _warn(warnings, 'independence_unknown', right['id'])
                left['independence'] = 'unknown'
                right['independence'] = 'unknown'
    for row in included:
        if row['id'] in replay_ids:
            _exclude_replay(row)


def _calls_report(rows):
    included = [row for row in rows if row['included']]
    if not included or any(row['calls'] is None for row in included):
        return 'unknown'
    return {'sum': sum(row['calls'] for row in included), 'unknown': 0, 'verified': False, 'clientReported': True}


def _empty_counts():
    return {name: 0 for name in PRIMARY}


def _summarize(packet, rows, warnings, usable, duplicate):
    fixed = packet['fixed']
    strategy = packet['strategy']
    portable_hash = canonical_digest(strategy['portable'])
    by_arm = {arm: [] for arm in ARMS}
    for row in rows:
        by_arm[row['arm']].append(row)
    arm_reports = {}
    machine_hashes = {}
    for arm in ARMS:
        group = by_arm[arm]
        included = [row for row in group if row['included']]
        counts = _empty_counts()
        for row in included:
            counts[row['countedClass']] += 1
        hashes = sorted({row['machineConfigHash'] for row in included if row['machineConfigHash']})
        machine_hashes[arm] = hashes
        if len(hashes) > 1:
            for row in included:
                _warn(warnings, 'machine_config_not_strategy_identity', row['id'])
        ok_rows = [row for row in included if row['countedClass'] in OK_CLASSES]
        failed = counts['failed']
        cancelled = counts['cancelled']
        gold_known = fixed['goldVersion'] is not None
        matched_trials = counts['matched-findings'] if gold_known else 'unknown'
        counts['matched-findings'] = matched_trials
        arm_reports[arm] = {
            'sourceHash': packet['arms'][arm]['sourceHash'],
            'fileHash': packet['arms'][arm]['fileHash'],
            'revision': packet['arms'][arm]['revision'],
            'attempts': len(included),
            'excluded': len(group) - len(included),
            'counts': counts,
            'denominators': {
                'attempts': len(included),
                'completedResponses': len(included) - failed - cancelled,
                'failedExcludedFromZeroFindings': failed,
                'cancelledExcludedFromZeroFindings': cancelled,
                'zeroFindings': {
                    'numerator': counts['completed-zero-findings'],
                    'denominator': len(ok_rows),
                },
            },
            'matchedFindingJudgments': sum(row['matchedJudgments'] for row in included) if gold_known else 'unknown',
            'unmatchedGoldJudgments': sum(row['unmatchedJudgments'] for row in included) if gold_known else 'unknown',
            'duplicateGoldJudgments': sum(row['duplicateJudgments'] for row in included) if gold_known else 'unknown',
            'verifiedModel': _arm_verified(included),
            'calls': _calls_report(included),
            'cost': 'unknown',
            'machineConfigHashes': hashes,
            'independence': 'unknown' if any(row['independence'] == 'unknown' for row in included) else ('replay' if any(row['independence'] == 'replay' for row in group) and not included else 'distinct-request'),
        }
        if not included:
            _warn(warnings, 'arm_missing', None)
    sources = [packet['arms'][arm]['sourceHash'] for arm in ARMS]
    blocking = ('repeat_replay', 'gold_missing', 'arm_missing', 'duplicate_gold')
    ready = all(arm_reports[arm]['attempts'] for arm in ARMS) and fixed['goldVersion'] is not None
    ready = ready and not any(code.startswith('incompatible_condition') or code in blocking for code in warnings)
    messages = {
        'duplicate_gold': 'A gold id occurs more than once. Judgments on that id are not matches.',
        'gold_missing': 'Gold version is absent. Matched findings are unknown, not zero.',
        'unmatched_gold': 'A judgment names a gold id that is not in the usable gold list.',
        'duplicate_judgment': 'A repeated human judgment was counted once.',
        'match_without_finding': 'A matched judgment has no finding on that completed response.',
        'review_condition_mismatch': 'A review case label or protocol version differs from the fixed conditions and was left out.',
        'multiple_reviews': 'More than one condition-matched review exists for a trial. None was applied.',
        'review_run_missing': 'A review names a trial that is not in this packet and was ignored.',
        'unverified_model': 'A verified model was claimed without local-codex provenance and is reported unknown.',
        'repeat_replay': 'The same request id or request-byte digest was repeated. Those trials are replays and are outside the denominators.',
        'independence_unknown': 'Final response hashes match across separate request ids. Deterministic or zero-finding runs can match. The trials stay counted and independence is unknown.',
        'machine_config_not_strategy_identity': 'Machine config hashes differ. They are not a second strategy. Portable id, version and bundle hash are unchanged.',
        'incompatible_condition:harness_canonical': 'harnessCanonical is not JSON-equal to the request harness, or the recorded harness hash is not the SHA-256 of that exact string. The string is not re-encoded.',
        'arm_missing': 'An arm has no included trial. Side-by-side preparation is not ready.',
    }
    warning_rows = []
    for code in sorted(warnings):
        message = messages.get(code)
        if message is None and code.startswith('incompatible_condition:'):
            message = 'A trial differs from the fixed strategy, requested model, budget, source hash or frozen harness and is outside the denominators.'
        elif message is None:
            message = code
        warning_rows.append({'code': code, 'message': message, 'trialIds': sorted(item for item in warnings[code] if item)})
    return {
        'schema': SUMMARY_SCHEMA,
        'ok': True,
        'notice': NOTICE,
        'comparisonReady': ready,
        'ranking': 'not-computed',
        'detectionCorrectness': 'not-inferred',
        'scientificGold': False,
        'grouping': 'portable-strategy-version-bundle',
        'machineConfigIsStrategyIdentity': False,
        'fixed': {
            'strategyId': strategy['id'],
            'strategyVersion': strategy['version'],
            'bundleSha256': strategy['bundleSha256'],
            'portableHash': portable_hash,
            'requestedModel': fixed['requestedModel'],
            'verifiedModel': _arm_verified([row for row in rows if row['included']]),
            'maxCalls': fixed['maxCalls'],
            'internalMaxCalls': fixed['internalMaxCalls'],
            'goldVersion': fixed['goldVersion'] if fixed['goldVersion'] is not None else 'unknown',
            'protocolVersion': fixed['protocolVersion'],
            'caseLabel': fixed['caseLabel'],
        },
        'arms': arm_reports,
        'gold': {
            'version': fixed['goldVersion'] if fixed['goldVersion'] is not None else 'unknown',
            'scientificGold': False,
            'usableItems': len(usable) if fixed['goldVersion'] is not None else 'unknown',
            'duplicateIds': sorted(duplicate),
        },
        'trials': [{
            'id': row['id'], 'arm': row['arm'], 'repeat': row['repeat'], 'included': row['included'],
            'class': row['class'], 'reasons': row['reasons'], 'verifiedModel': row['verifiedModel'],
            'calls': row['calls'] if row['included'] else 'unknown', 'cost': 'unknown',
            'appModelLabel': row['appModelLabel'], 'machineConfigHash': row['machineConfigHash'],
            'independence': row['independence'], 'sourceComparedAsTextHash': True,
        } for row in rows],
        'warnings': warning_rows,
    }


def _arm_verified(included):
    values = []
    for row in included:
        value = row['verifiedModel']
        if value != 'unknown':
            values.append(value['observed'])
    if not included or len(values) != len(included) or len(set(values)) != 1:
        return 'unknown'
    return {'observed': values[0], 'certified': False}


def prepare(packet):
    return evaluate(packet)


def prepare_bytes(raw):
    return prepare(load_packet(raw))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Validate and summarize an ORIGINAL/E1/H1 controlled BLUE packet. No model calls.')
    parser.add_argument('packet', help='Path to a falsify.controlled-blue-prep.v1 JSON packet')
    parser.add_argument('--out', help='Write the summary JSON to this path as well as stdout')
    args = parser.parse_args(argv)
    path = Path(args.packet)
    try:
        raw = path.read_bytes()
        summary = prepare_bytes(raw)
    except PrepError as error:
        payload = {'schema': SUMMARY_SCHEMA, 'ok': False, 'errors': error.errors, 'notice': NOTICE}
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        print(text)
        return 2
    except OSError:
        payload = {'schema': SUMMARY_SCHEMA, 'ok': False, 'errors': ['packet_unreadable'], 'notice': NOTICE}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

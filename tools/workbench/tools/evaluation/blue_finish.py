"""Capture one BLUE result from blue_service.run_review and a fake backend.

No provider process, network, or model call. The returned object is the service
finish payload, including isolation and harness.record cliSelection.
"""
import hashlib
import threading

from controlled_blue import BLUE_SCHEMA, canonical_digest, portable_projection, source_text_hash
from controlled_blue import _blue_module, _harness_module

from synthetic_packet import BUNDLE, CASE_LABEL, GOLD_VERSION, STRATEGY_ID, STRATEGY_VERSION

FINISH_TEXT = 'Synthetic finish document. The count is two.'
FINISH_MODEL = 'gpt-6.1-sol'


class _FakeBackend:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def infer(self, prompt, schema):
        return {'status': 'ok', 'response': {'status': 'ok', 'findings': []}}


def finish_harness():
    return {
        'schema': 'falsify.harness.v1',
        'id': STRATEGY_ID,
        'name': 'Synthetic BLUE fixed',
        'version': STRATEGY_VERSION,
        'role': 'blue',
        'instructions': 'Review only the supplied synthetic text. Do not use an answer key.',
        'maxCalls': 8,
        'adapter': {'type': 'codex', 'model': FINISH_MODEL, 'effort': 'medium'},
        'settings': {
            'strategy': 'fixed-synthetic',
            'model': FINISH_MODEL,
            'bundleSha256': BUNDLE,
            'internalMaxCalls': 4,
            'scope': 'document-only-synthetic',
        },
    }


def capture_result(text=FINISH_TEXT, revision='rev-original', request_id='req-finish-original', harness_canonical=None):
    blue = _blue_module()
    source = hashlib.sha256(text.encode('utf-8')).hexdigest()
    data = {
        'schema': blue.VERSION,
        'revision': revision,
        'requestId': request_id,
        'sourceHash': source,
        'segments': [{'id': 's1', 'label': 'Synthetic', 'text': text}],
        'maxCalls': 8,
        'consent': True,
        'executionConsent': True,
        'harness': finish_harness(),
    }
    if harness_canonical is not None:
        data['harnessCanonical'] = harness_canonical
    return blue.run_review(data, lambda _progress: None, threading.Event(), _FakeBackend)


def packet_with_live_results(harness_canonical=None):
    """Three arms. ORIGINAL carries the captured finish object unchanged."""
    original = capture_result(harness_canonical=harness_canonical)
    epsilon = capture_result('Synthetic finish epsilon states the count is four.', 'rev-e1', 'req-finish-e1', harness_canonical)
    eta = capture_result('Synthetic finish eta states the count is five.', 'rev-h1', 'req-finish-h1', harness_canonical)
    results = {'ORIGINAL': original, 'E1': epsilon, 'H1': eta}
    texts = {
        'ORIGINAL': FINISH_TEXT,
        'E1': 'Synthetic finish epsilon states the count is four.',
        'H1': 'Synthetic finish eta states the count is five.',
    }
    harness = original['harness']
    trials = []
    arms = {}
    for arm, result in results.items():
        segments = [{'id': 's1', 'label': 'Synthetic', 'text': texts[arm]}]
        source = source_text_hash(segments)
        file_hash = hashlib.sha256(f'synthetic-finish-file-{arm}'.encode('utf-8')).hexdigest()
        revision = result['revision']
        request_id = f'req-finish-{arm.lower()}'
        machine = result['harnessHash']
        trials.append({
            'id': f'{arm.lower()}-finish',
            'arm': arm,
            'repeat': 1,
            'provenance': 'local-codex',
            'harness': result['harness'],
            'job': {
                'id': request_id,
                'state': 'completed',
                'role': 'blue',
                'sourceHash': source,
                'fileHash': file_hash,
                'revision': revision,
                'harnessHash': machine,
                'requestBytesDigest': hashlib.sha256(f'finish-bytes-{arm}'.encode('utf-8')).hexdigest(),
                'companionInstance': 'ci1.' + hashlib.sha256(f'finish-{arm}'.encode('utf-8')).hexdigest(),
            },
            'request': {
                'schema': BLUE_SCHEMA,
                'revision': revision,
                'requestId': request_id,
                'sourceHash': source,
                'segments': segments,
                'maxCalls': 8,
                'consent': True,
                'executionConsent': True,
                'harness': result['harness'],
                **({'harnessCanonical': harness_canonical} if harness_canonical is not None else {}),
            },
            'result': result,
            'rawResponseSha256': canonical_digest(result),
            'model': {'requested': FINISH_MODEL, 'verified': None},
            'calls': None,
            'cost': None,
        })
        arms[arm] = {'sourceHash': source, 'fileHash': file_hash, 'revision': revision}
    return {
        'schema': 'falsify.controlled-blue-prep.v1',
        'strategy': {
            'id': STRATEGY_ID,
            'version': STRATEGY_VERSION,
            'bundleSha256': BUNDLE,
            'portable': portable_projection(harness, {}, ['auditDirectory']),
            'pathMap': {},
            'machineSettingKeys': ['auditDirectory'],
        },
        'fixed': {
            'requestedModel': FINISH_MODEL,
            'maxCalls': 8,
            'internalMaxCalls': 4,
            'goldVersion': GOLD_VERSION,
            'protocolVersion': BLUE_SCHEMA,
            'caseLabel': CASE_LABEL,
        },
        'arms': arms,
        'trials': trials,
        'reviews': [],
        'gold': {
            'version': GOLD_VERSION,
            'scientificGold': False,
            'items': [{'id': 'g-finish', 'segmentId': 's1', 'quote': 'Synthetic finish token.'}],
        },
    }

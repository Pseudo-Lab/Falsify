"""Synthetic ORIGINAL/E1/H1 packet builder.

The sentences, gold items and reviews are fixtures for the offline preparer.
They are not a paper, not scientific gold, and not model output.
"""
import hashlib
from copy import deepcopy

from controlled_blue import BLUE_SCHEMA, canonical_digest, source_text_hash
from controlled_blue import _harness_module

BUNDLE = hashlib.sha256(b'synthetic-fixed-bundle-not-a-working-tree').hexdigest()
STRATEGY_ID = 'synthetic-blue-fixed'
STRATEGY_VERSION = '0.3.3'
REQUESTED_MODEL = 'claude-opus-5-5'
CASE_LABEL = 'synthetic-controlled-blue'
GOLD_VERSION = 'synthetic-fixture-1'

TEXTS = {
    'ORIGINAL': 'Synthetic alpha states the count is two.',
    'E1': 'Synthetic epsilon states the count is four.',
    'H1': 'Synthetic eta states the count is five.',
}
PORTABLE_PYTHON = 'portable-python'
PORTABLE_RUNNER = 'portable-runner.py'
FLAGS = ('--diagnostic', '0.3.3')


def portable(bundle=BUNDLE):
    return {
        'schema': 'falsify.harness.v1',
        'id': STRATEGY_ID,
        'name': 'Synthetic BLUE fixed',
        'version': STRATEGY_VERSION,
        'role': 'blue',
        'instructions': 'Review only the supplied synthetic text. Do not use an answer key.',
        'maxCalls': 8,
        'adapter': {
            'type': 'stdio',
            'executable': PORTABLE_PYTHON,
            'args': [PORTABLE_RUNNER, *FLAGS],
        },
        'settings': {
            'strategy': 'fixed-synthetic',
            'model': REQUESTED_MODEL,
            'bundleSha256': bundle,
            'internalMaxCalls': 4,
            'scope': 'document-only-synthetic',
        },
    }


def full_harness(executable, audit_directory, bundle=BUNDLE):
    harness = portable(bundle)
    harness['adapter'] = {
        'type': 'stdio',
        'executable': executable,
        'args': [executable + '-runner.py', *FLAGS],
    }
    harness['settings'] = dict(harness['settings'])
    harness['settings']['auditDirectory'] = audit_directory
    return harness


def path_entries(trial):
    adapter = trial['harness'].get('adapter') or {}
    mapping = {}
    executable = adapter.get('executable')
    if isinstance(executable, str) and ('/' in executable or '\\' in executable):
        mapping[executable] = PORTABLE_PYTHON
    for arg in adapter.get('args') or []:
        if isinstance(arg, str) and ('/' in arg or '\\' in arg):
            mapping[arg] = PORTABLE_RUNNER
    return mapping


def note_paths(packet, trial):
    packet['strategy']['pathMap'].update(path_entries(trial))
    return packet


def _segments(arm, text=None):
    return [{'id': 's1', 'label': 'Synthetic', 'text': TEXTS[arm] if text is None else text}]


def _finding(quote):
    return {
        'id': 'f1',
        'segmentId': 's1',
        'quote': quote,
        'rationale': 'Synthetic rationale for a fixture finding.',
        'uncertainty': 'Synthetic uncertainty. Not a scientific judgment.',
        'evidence': [{
            'segmentId': 's1',
            'quote': quote,
            'relation': 'Synthetic relation between the fixture quote and itself.',
        }],
    }


def _instance(marker):
    return 'ci1.' + hashlib.sha256(marker.encode('utf-8')).hexdigest()


def make_trial(arm, repeat, state, status=None, findings=None, executable=None, audit=None, calls=None, verified=None, provenance='local-codex', text=None):
    executable = executable or f'/opt/synthetic/{arm.lower()}-python'
    audit = audit or f'/opt/synthetic/{arm.lower()}-audits'
    harness = full_harness(executable, audit)
    machine = canonical_digest(harness)
    segments = _segments(arm, text)
    source = source_text_hash(segments)
    file_hash = hashlib.sha256(f'synthetic-file-{arm}'.encode('utf-8')).hexdigest()
    revision = f'rev-{arm.lower()}'
    request_id = f'req-{arm.lower()}-{repeat}'
    request = {
        'schema': BLUE_SCHEMA,
        'revision': revision,
        'requestId': request_id,
        'sourceHash': source,
        'segments': segments,
        'maxCalls': 8,
        'consent': True,
        'executionConsent': True,
        'harness': harness,
    }
    result = None
    raw_hash = None
    if state == 'completed':
        label = _harness_module().model_label(harness)
        result = {
            'schema': BLUE_SCHEMA,
            'revision': revision,
            'sourceHash': source,
            'status': status,
            'findings': findings if findings is not None else [],
            'harnessHash': machine,
            'model': label,
            'harness': harness,
            'coverage': {'complete': True, 'calls': 1, 'chunks': 1, 'completedChunks': 1},
        }
        raw_hash = canonical_digest(result)
    return {
        'id': f'{arm.lower()}-r{repeat}',
        'arm': arm,
        'repeat': repeat,
        'provenance': provenance,
        'harness': harness,
        'job': {
            'id': request_id,
            'state': state,
            'role': 'blue',
            'sourceHash': source,
            'fileHash': file_hash,
            'revision': revision,
            'harnessHash': machine,
            'requestBytesDigest': hashlib.sha256(f'bytes-{arm}-{repeat}-{state}'.encode('utf-8')).hexdigest(),
            'companionInstance': _instance(f'{executable}:{repeat}'),
        },
        'request': request,
        'result': result,
        'rawResponseSha256': raw_hash,
        'model': {'requested': REQUESTED_MODEL, 'verified': verified},
        'calls': calls,
        'cost': None,
    }


def base_packet(trials, reviews=None, gold=True, gold_version=GOLD_VERSION):
    arms = {}
    path_map = {}
    for name in ('ORIGINAL', 'E1', 'H1'):
        sample = next((trial for trial in trials if trial['arm'] == name), None)
        if sample is None:
            sample = make_trial(name, 1, 'completed', 'abstain')
        arms[name] = {
            'sourceHash': sample['job']['sourceHash'],
            'fileHash': sample['job']['fileHash'],
            'revision': sample['job']['revision'],
        }
    for trial in trials:
        path_map.update(path_entries(trial))
    packet = {
        'schema': 'falsify.controlled-blue-prep.v1',
        'strategy': {
            'id': STRATEGY_ID,
            'version': STRATEGY_VERSION,
            'bundleSha256': BUNDLE,
            'portable': portable(),
            'pathMap': path_map,
            'machineSettingKeys': ['auditDirectory'],
        },
        'fixed': {
            'requestedModel': REQUESTED_MODEL,
            'maxCalls': 8,
            'internalMaxCalls': 4,
            'goldVersion': gold_version if gold else None,
            'protocolVersion': BLUE_SCHEMA,
            'caseLabel': CASE_LABEL,
        },
        'arms': arms,
        'trials': trials,
        'reviews': [] if reviews is None else reviews,
    }
    if gold:
        packet['gold'] = {
            'version': gold_version,
            'scientificGold': False,
            'items': [{
                'id': 'g-alpha',
                'segmentId': 's1',
                'quote': TEXTS['ORIGINAL'],
            }],
        }
    return packet


def comparable_packet():
    original = make_trial(
        'ORIGINAL', 1, 'completed', 'ok', findings=[_finding(TEXTS['ORIGINAL'])], calls=None, verified=None,
    )
    epsilon = make_trial('E1', 1, 'completed', 'ok', findings=[], calls=None, verified=None)
    eta = make_trial('H1', 1, 'completed', 'abstain', findings=[], calls=None, verified=None)
    review = {
        'id': 'rev-original-1',
        'trialId': original['id'],
        'reviewer': 'synthetic-reviewer',
        'caseLabel': CASE_LABEL,
        'protocolVersion': BLUE_SCHEMA,
        'verdict': 'mixed',
        'score': 3,
        'note': 'Synthetic human note. This is not scientific gold and not a detection rate.',
        'judgments': [{'goldId': 'g-alpha', 'findingId': 'f1', 'judgment': 'matched'}],
    }
    return base_packet([original, epsilon, eta], reviews=[review])


def packet_copy():
    return deepcopy(comparable_packet())

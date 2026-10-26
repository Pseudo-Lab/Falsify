"""Reuse v0.3.1; reanchor only document-scan quotes to explicitly delivered text."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import sys

from reanchor import reanchor_scan

BASE = Path(__file__).resolve().parent.parent / 'evidence_blue_v031'
sys.path.insert(0, str(BASE))
spec = importlib.util.spec_from_file_location('falsify_blue_v031_for_v032', BASE / 'core.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
v2, SCOPE, MARKER = base.v2, base.SCOPE, base.MARKER
VERSION = '0.3.3'


def run(invocation, corpus, infer, audit, search=base.lookup):
    def derived_infer(stage, prompt, schema):
        is_scan = stage == 'document-stage' and set(schema.get('properties', {})) == {'status', 'summary', 'evidence'}
        if not is_scan:
            return infer(stage, prompt, schema)
        bounded = copy.deepcopy(schema)
        bounded['properties']['summary']['maxLength'] = 2500
        evidence = bounded['properties']['evidence']
        evidence['maxItems'] = 4
        evidence['items']['properties']['quote']['maxLength'] = 600
        evidence['items']['properties']['relation']['maxLength'] = 1500
        raw = infer(stage, prompt, bounded)
        from jsonschema import Draft202012Validator
        if not Draft202012Validator(bounded).is_valid(raw):
            audit['scanContract'] = {'state': 'failed', 'code': 'scan_contract_failed',
                                     'summaryMaxLength': 2500, 'quoteMaxLength': 600,
                                     'relationMaxLength': 1500, 'evidenceMaxItems': 4}
            raise ValueError('scan_contract_failed')
        payload = v2.document_payload(prompt)
        derived, provenance = reanchor_scan(raw, {'segments': payload.get('segments', [])})
        audit['scanDerivation'] = {
            'runtimePolicy': 'whitespace-only',
            'rawResponseSha256': hashlib.sha256(v2.canonical(raw).encode()).hexdigest(),
            'derivedResponseSha256': hashlib.sha256(v2.canonical(derived).encode()).hexdigest(),
            'derivedResponse': derived, 'provenance': provenance,
            'meaning': 'Formatting-only source binding, not scientific or semantic validation.',
        }
        if not provenance.get('applied') or any(r['decision'] == 'rejected' for r in provenance['items']):
            raise ValueError('scan_reanchor_failed')
        # A line-end '-' can be a mathematical operator; runtime keeps every sign.
        if any(''.join(before['quote'].split()) != ''.join(after['quote'].split())
               for before, after in zip(raw['evidence'], derived['evidence'])):
            audit['scanDerivation']['blockedByRuntimePolicy'] = True
            raise ValueError('scan_reanchor_failed')
        from red_service import evidence_check
        grouped = {}
        for segment in payload.get('segments', []):
            grouped.setdefault(segment['id'], []).append(segment['text'])
        for item in derived['evidence']:
            fragment = next((text for text in grouped.get(item['segmentId'], [])
                             if item['quote'] in text), None)
            if fragment is None:
                raise ValueError('scan_reanchor_failed')
            evidence_check([item], {item['segmentId']: fragment}, 600)
        return derived

    return base.run(invocation, corpus, derived_infer, audit, search)

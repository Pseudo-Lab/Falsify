"""Unit and integration tests for expanded RED defect families and PDF blindness leak audit."""
import hashlib
import sys
import threading
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

from paper_stealth_audit import (
    BLINDNESS_SCHEMA,
    audit_blindness_leaks,
    audit_pdf_stealth,
)
from red_service import (
    TYPES,
    VERSION,
    attack_types,
    _build_red_policy,
    _candidate_request,
    run_review,
)


def _req(text, **overrides):
    data = {
        'schema': VERSION,
        'revision': 'r1',
        'requestId': 'req-1',
        'sourceHash': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        'segments': [{'id': 's0', 'label': 'p1', 'text': text}],
        'maxCalls': 8,
        'consent': True,
    }
    data.update(overrides)
    return data


def _pdf_with_text(text='Baseline study results (p = 0.04).'):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), text)
    raw = doc.tobytes()
    doc.close()
    return raw


class RedServiceTaxonomyTests(unittest.TestCase):
    def test_types_and_level_4_mapping(self):
        self.assertEqual(TYPES, [
            'contradiction',
            'condition-omission',
            'unsupported-inference',
            'numeric-drift',
            'citation-distortion',
            'outcome-status-mislabeling',
            'semantic-inversion',
        ])
        self.assertEqual(attack_types({'level': 1}), ['contradiction'])
        self.assertEqual(attack_types({'level': 2}), ['condition-omission'])
        self.assertEqual(attack_types({'level': 3}), ['unsupported-inference'])
        self.assertEqual(attack_types({'level': 4}), [
            'contradiction', 'condition-omission', 'unsupported-inference', 'numeric-drift',
        ])
        self.assertEqual(
            attack_types({'level': 4, 'attackTypes': ['numeric-drift', 'semantic-inversion']}),
            ['numeric-drift', 'semantic-inversion'],
        )
        with self.assertRaises(ValueError):
            attack_types({'level': 5, 'attackTypes': ['numeric-drift']})

    def test_candidate_schema_supports_all_7_types_and_policy_includes_w5_rules(self):
        text = 'H3K27me3 suppressed expression (p = 0.04) in exploratory cohort [1].'
        data = _req(text, attackTypes=list(TYPES))
        selected, payload, schema = _candidate_request(data, [data['segments']], [])
        self.assertEqual(selected, TYPES)
        cand_props = schema['properties']['candidates']['items']['properties']
        self.assertEqual(cand_props['attackTypes']['maxItems'], 7)

        cand = {
            'id': 'c1',
            'segmentId': 's0',
            'attackTypes': ['numeric-drift', 'citation-distortion', 'outcome-status-mislabeling', 'semantic-inversion'],
            'before': 'H3K27me3 suppressed expression (p = 0.04) in exploratory cohort [1].',
            'after': 'H3K4me3 activated expression (p = 0.40) in pre-specified cohort [99].',
            'rationale': 'Combines D1/D2/D4-1/S1.',
            'evidence': [{'segmentId': 's0', 'quote': 'H3K27me3 suppressed expression', 'relation': 'Source.'}],
            'uncertainty': None,
        }
        Draft202012Validator(schema).validate({'status': 'ok', 'candidates': [cand]})

        class AllSevenBackend:
            prompts = []

            def __init__(self, **_kwargs):
                pass

            def infer(self, prompt, _schema):
                self.prompts.append(prompt)
                return {'status': 'ok', 'response': {'status': 'ok', 'candidates': [cand]}}

        res = run_review(data, lambda _: None, threading.Event(), AllSevenBackend)
        self.assertEqual(res['candidates'][0]['attackTypes'], cand['attackTypes'])
        policy = _build_red_policy(data, {'instructions': 'Use oracle checks.'}, None)
        for token in ('numeric-drift', 'citation-distortion', 'outcome-status-mislabeling', 'semantic-inversion', 'H3K27me3 vs H3K4me3', 'intentional error', '변조본'):
            self.assertIn(token, policy)


class BlindnessAuditTests(unittest.TestCase):
    def test_clean_pdf_passes_blindness_audit(self):
        src = _pdf_with_text('Patients showed p = 0.04 in cohort A.')
        out = _pdf_with_text('Patients showed p = 0.40 in cohort A.')
        res = audit_blindness_leaks(src, out)
        self.assertEqual(res['schema'], BLINDNESS_SCHEMA)
        self.assertTrue(res['clean'])
        self.assertEqual(res['issues'], [])

    def test_metadata_annotation_uri_and_visible_text_leaks_detected(self):
        src = _pdf_with_text('Baseline observation in treated group.')

        # 1. Metadata leak (English + Korean)
        doc = pymupdf.open(stream=src, filetype='pdf')
        doc.set_metadata({'title': '5 intentional errors', 'subject': '변조본 정답지'})
        meta_leaked = doc.tobytes()
        doc.close()
        meta_audit = audit_blindness_leaks(src, meta_leaked)
        self.assertFalse(meta_audit['clean'])
        self.assertTrue(any(i['surface'] == 'metadata' for i in meta_audit['issues']))
        stealth_meta = audit_pdf_stealth(src, meta_leaked, modified_regions=[])
        self.assertEqual(stealth_meta['status'], 'detectable_artifact')
        self.assertFalse(stealth_meta['checks']['metadataClean'])
        self.assertFalse(stealth_meta['checks']['blindnessClean'])
        self.assertTrue(any(i['code'] == 'blindness_hint_leak' for i in stealth_meta['issues']))

        # 2. Annotation & link URI leak
        doc = pymupdf.open(stream=src, filetype='pdf')
        doc[0].add_text_annot((100, 140), 'Injected defect for RED review')
        doc[0].insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(72, 95, 220, 110), 'uri': 'https://example.org/tampered-red-plan'})
        annot_leaked = doc.tobytes()
        doc.close()
        annot_audit = audit_blindness_leaks(src, annot_leaked)
        self.assertFalse(annot_audit['clean'])
        self.assertGreaterEqual(sum(1 for i in annot_audit['issues'] if i['surface'] == 'annotation'), 2)

        # 3. Newly introduced visible text line leak
        doc = pymupdf.open(stream=src, filetype='pdf')
        doc[0].insert_text((72, 160), 'Note: contains 5 intentional errors and 의도적 오류.')
        text_leaked = doc.tobytes()
        doc.close()
        text_audit = audit_blindness_leaks(src, text_leaked)
        self.assertFalse(text_audit['clean'])
        self.assertTrue(any(i['surface'] == 'text' and i['pageIndex'] == 0 for i in text_audit['issues']))
        stealth_text = audit_pdf_stealth(src, text_leaked, modified_regions=[{'pageIndex': 0, 'bbox': [60, 145, 420, 175]}])
        self.assertEqual(stealth_text['status'], 'detectable_artifact')
        self.assertTrue(any(i['code'] == 'blindness_hint_leak' for i in stealth_text['issues']))

    def test_source_phrase_not_falsely_flagged(self):
        src = _pdf_with_text('The benchmark excludes 5 intentional errors from baseline.')
        res = audit_blindness_leaks(src, src)
        self.assertTrue(res['clean'])
        self.assertEqual(res['issues'], [])


if __name__ == '__main__':
    unittest.main()

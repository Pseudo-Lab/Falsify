"""Offline tests for BLUE Evidence v0.3.6. Zero real network or model calls."""
import hashlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_profile
import runner

ID_SELECTION = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['status', 'targets'],
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'targets': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['referenceId', 'reason'],
                'properties': {'referenceId': {'type': 'string'}, 'reason': {'type': 'string'}},
            },
        },
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_network_call')


class OfflineV036Tests(unittest.TestCase):
    def setUp(self):
        self._net_patcher = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net_patcher.start()

    def tearDown(self):
        self._net_patcher.stop()

    def _payload(self, text='Alpha', settings=None):
        return json.dumps({
            'schema': 'falsify.harness-invocation.v1',
            'role': 'blue',
            'call': 1,
            'maxCalls': 7,
            'settings': settings if settings is not None else runner.contract_settings(),
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': [{'id': 's0', 'text': text}]}, ensure_ascii=False),
            'outputSchema': ID_SELECTION,
        }, ensure_ascii=False).encode('utf-8')

    def test_bundle_tamper_changes_v036_only(self):
        before = runner.bundle_identity()
        v035_before = runner.v035.v034.v033.v2.digest(runner.v035.source_map())
        self.assertNotEqual(before, v035_before)
        self.assertIn(runner.GROUNDING_REL, runner.source_map())
        self.assertIn(runner.TRIALS_REL, runner.source_map())
        self.assertIn(runner.RUNNER_REL, runner.source_map())
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name in ('paper_external_grounding.py', 'paper_clinical_trials.py'):
                return data + b'\n# tamper\n'
            return data

        with patch.object(runner, 'read_bytes', side_effect=tampered):
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v035.v034.v033.v2.digest(runner.v035.source_map()), v035_before)
        self.assertEqual(runner.bundle_identity(), before)

    def test_nct_and_bib_grounding_appended_as_untrusted_data(self):
        paper_text = (
            'In trial NCT01234567, we enrolled 180 patients. '
            'The primary outcome was progression-free survival at 12 months [1, 2].\n'
            'References\n'
            '[1] Doe J. Fabricated study on moon dust. Nature. 2024; doi:10.1000/missing999\n'
            '[2] Smith A. Quantum baking recipes in space. Science. 2023; doi:10.1000/chimera123\n'
        )
        ct_raw = {
            'protocolSection': {
                'identificationModule': {'nctId': 'NCT01234567', 'briefTitle': 'Aspirin Trial'},
                'statusModule': {'overallStatus': 'COMPLETED', 'studyFirstPostDateStruct': {'date': '2020-01-10'}},
                'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 300, 'type': 'ACTUAL'}},
                'outcomesModule': {
                    'primaryOutcomes': [{'measure': 'All-cause mortality at 24 months', 'timeFrame': '24 months'}],
                    'secondaryOutcomes': [{'measure': 'Progression-free survival at 12 months', 'timeFrame': '12 months'}],
                },
            }
        }
        ct_sha = hashlib.sha256(json.dumps(ct_raw).encode()).hexdigest()

        def reg_transport(nct_id):
            self.assertEqual(nct_id, 'NCT01234567')
            return 200, ct_raw, ct_sha

        def bib_transport(provider, path):
            if provider == 'crossref' and '10.1000%2Fmissing999' in path:
                return 404, None, hashlib.sha256(b'Resource not found.').hexdigest()
            if provider == 'crossref' and '10.1000%2Fchimera123' in path:
                work = {
                    'message': {
                        'DOI': '10.1000/chimera123',
                        'title': ['Genome-wide association study of rice drought tolerance'],
                        'author': [{'given': 'Wei', 'family': 'Zhang'}],
                        'published': {'date-parts': [[2018]]},
                    }
                }
                return 200, work, hashlib.sha256(json.dumps(work).encode()).hexdigest()
            if provider == 'europepmc':
                empty = {'resultList': {'result': []}}
                return 200, empty, hashlib.sha256(b'{}').hexdigest()
            raise AssertionError((provider, path))

        seen_prompts = []

        def fake_model(stage, prompt, schema, seconds):
            seen_prompts.append((stage, prompt, seconds))
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        with tempfile.TemporaryDirectory() as folder:
            answer = runner.execute(
                self._payload(paper_text),
                fake_model,
                no_network,
                folder,
                registry_transport=reg_transport,
                bib_transport=bib_transport,
            )
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))

        self.assertEqual(answer, {'status': 'abstain', 'targets': []})
        self.assertEqual(len(seen_prompts), 1)
        stage, sent_prompt, seconds = seen_prompts[0]
        self.assertEqual(stage, 'document-stage')
        self.assertGreater(seconds, 110)
        self.assertIn('UNTRUSTED EXTERNAL REGISTRY/BIBLIOGRAPHY RECORDS', sent_prompt)
        self.assertIn('potential_outcome_switch', sent_prompt)
        self.assertIn('enrollment_discrepancy_candidate', sent_prompt)
        self.assertIn('doi_not_found_in_crossref', sent_prompt)
        self.assertIn('metadata_mismatch', sent_prompt)
        self.assertIn(ct_sha, sent_prompt)

        eg = audit['externalGrounding']
        self.assertEqual(eg['nctIds'], ['NCT01234567'])
        self.assertEqual(eg['bibliographyVerification']['summary']['doiNotFoundInCrossref'], 1)
        self.assertEqual(eg['bibliographyVerification']['summary']['metadataMismatch'], 1)
        self.assertEqual(eg['clinicalTrials'][0]['responseSha256'], ct_sha)
        self.assertTrue(eg['contextSha256'])
        self.assertEqual(audit['diagnosticVersion'], '0.3.6')

    def test_final_review_pipeline_appends_grounding_to_experts_and_challenge(self):
        final_schema = {
            'type': 'object', 'additionalProperties': False, 'required': ['status', 'findings'],
            'properties': {
                'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
                'findings': {'type': 'array', 'items': {
                    'type': 'object', 'additionalProperties': False,
                    'required': ['id', 'segmentId', 'quote', 'rationale', 'evidence', 'uncertainty'],
                    'properties': {
                        'id': {'type': 'string'}, 'segmentId': {'type': 'string'}, 'quote': {'type': 'string'},
                        'rationale': {'type': 'string'}, 'uncertainty': {'type': 'string'},
                        'evidence': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                                     'required': ['segmentId', 'quote', 'relation'],
                                     'properties': {'segmentId': {'type': 'string'}, 'quote': {'type': 'string'}, 'relation': {'type': 'string'}}}},
                    },
                }},
            },
        }
        payload = json.dumps({
            'schema': 'falsify.harness-invocation.v1', 'role': 'blue', 'call': 1, 'maxCalls': 8,
            'settings': runner.contract_settings(),
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': [{'id': 's0', 'text': 'Trial NCT01234567 enrolled 100 patients.'}]}),
            'outputSchema': final_schema,
        }, ensure_ascii=False).encode('utf-8')
        stages_seen = {}

        def fake_model(stage, prompt, schema, seconds):
            stages_seen[stage] = prompt
            if stage == 'literature-plan':
                return {'status': 'ok', 'response': {'statistics': 'trial sample size', 'methods': 'randomized trial protocol'}}
            if stage in ('statistics', 'methods'):
                return {'status': 'ok', 'response': {'status': 'abstain', 'findings': []}}
            raise AssertionError(stage)

        ct_raw = {'protocolSection': {
            'identificationModule': {'nctId': 'NCT01234567', 'briefTitle': 'Demo Trial'},
            'statusModule': {'overallStatus': 'COMPLETED'},
            'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 200, 'type': 'ACTUAL'}},
            'outcomesModule': {'primaryOutcomes': [{'measure': 'Mortality', 'timeFrame': '12m'}], 'secondaryOutcomes': []},
        }}

        def fake_search(plans):
            return {'status': 'completed', 'requests': [], 'packets': {'statistics': [], 'methods': []}, 'sources': []}

        with tempfile.TemporaryDirectory() as folder:
            answer = runner.execute(
                payload, fake_model, fake_search, folder,
                registry_transport=lambda nid: (200, ct_raw, hashlib.sha256(b'ct').hexdigest()),
            )
        self.assertEqual(answer, {'status': 'abstain', 'findings': []})
        self.assertIn('UNTRUSTED EXTERNAL REGISTRY/BIBLIOGRAPHY RECORDS', stages_seen['statistics'])
        self.assertIn('UNTRUSTED EXTERNAL REGISTRY/BIBLIOGRAPHY RECORDS', stages_seen['methods'])

    def test_timeout_124_exit_and_no_stdout_leak(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(runner.AuditFailure) as caught:
                runner.execute(
                    self._payload('Simple text without refs.'),
                    lambda *_: {'status': 'timeout', 'error_code': 'timeout', 'response': None},
                    no_network,
                    folder,
                )
        self.assertEqual(caught.exception.code, 'model_timeout')
        for code, expected in [('model_timeout', 124), ('model_stage_failed', 1)]:
            with self.subTest(code=code), patch.object(runner.sys, 'platform', 'linux'), \
                    patch.object(runner.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'{}'))), \
                    patch.object(runner.sys, 'stdout', io.StringIO()) as out, \
                    patch.object(runner, 'execute', side_effect=runner.AuditFailure(code, {})):
                with self.assertRaises(SystemExit) as exited:
                    runner.main()
                self.assertEqual(exited.exception.code, expected)
                self.assertEqual(out.getvalue(), '')

    def test_profile_build_and_settings_contract_drift(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        self.assertEqual(profile['id'], 'shinick-blue-evidence-external-v036')
        self.assertEqual(profile['version'], '0.3.6')
        self.assertEqual(profile['settings']['externalLookup'], {
            'enabled': True, 'providers': ['crossref', 'europepmc', 'clinicaltrials'],
        })
        runner.check_settings(profile['settings'])
        drifted = dict(profile['settings'], diagnosticVersion='0.3.5')
        with self.assertRaisesRegex(ValueError, 'settings_contract'):
            runner.check_settings(drifted)


if __name__ == '__main__':
    unittest.main()

"""Offline checks for the experimental 0.3.4 bundle. No model or network calls."""
import copy
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_profile
import runner

ID_SELECTION = {
    'type': 'object', 'additionalProperties': False, 'required': ['status', 'targets'],
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'targets': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['referenceId', 'reason'],
            'properties': {'referenceId': {'type': 'string'}, 'reason': {'type': 'string'}},
        }},
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('network')


class OfflineTests(unittest.TestCase):
    def invocation(self, settings, schema, prompt_body):
        return {
            'schema': 'falsify.harness-invocation.v1', 'role': 'blue', 'call': 1, 'maxCalls': 4,
            'prompt': runner.MARKER + '. ' + json.dumps(prompt_body, ensure_ascii=False),
            'outputSchema': schema, 'settings': settings,
        }

    def execute(self, settings, schema, response, fixture=None):
        raw_response = copy.deepcopy(response)
        stages = []

        def default_fixture(stage, prompt, out_schema, remaining):
            stages.append(stage)
            if stage != 'document-stage':
                raise AssertionError(stage)
            return {'status': 'ok', 'response': response, 'observed_tool_calls': 0}

        payload = json.dumps(self.invocation(settings, schema, {'segments': [{'id': 's1', 'text': 'Alpha'}]})).encode()
        with tempfile.TemporaryDirectory() as folder:
            try:
                answer = runner.execute(payload, fixture or default_fixture, no_network, folder)
                failure = None
            except runner.AuditFailure as error:
                answer, failure = None, error.code
            audits = list(Path(folder).glob('*.json'))
            self.assertEqual(len(audits), 1)
            audit = json.loads(audits[0].read_text(encoding='utf-8'))
        return answer, audit, failure, stages, raw_response

    def test_helper_tamper_changes_v034_bundle_only(self):
        before = runner.bundle_identity()
        inherited_before = runner.v033.bundle_identity()
        self.assertNotEqual(before, inherited_before)
        self.assertEqual(runner.v033.v2.digest(runner.inherited_sources()), inherited_before)
        self.assertNotIn(runner.HELPER_REL, runner.inherited_sources())
        self.assertIn('app/local/blue_service.py', runner.inherited_sources())
        self.assertIn(runner.HELPER_REL, runner.source_map())
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name == 'blue_evidence_refs.py':
                return data + b'\n# tampered\n'
            return data

        runner.read_bytes = tampered
        try:
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v033.bundle_identity(), inherited_before)
            self.assertNotIn('blue_evidence_refs', (runner.V033_DIR / 'runner.py').read_text(encoding='utf-8'))
        finally:
            runner.read_bytes = real
        self.assertEqual(runner.bundle_identity(), before)

    def test_missing_unknown_and_stale_helper_fail_clearly(self):
        settings = runner.contract_settings()
        missing = settings
        real_path = runner.helper_path
        runner.helper_path = lambda: Path(tempfile.gettempdir()) / 'missing-blue-evidence-refs.py'
        try:
            answer, audit, failure, stages, _ = self.execute(missing, ID_SELECTION, {'status': 'abstain', 'targets': []})
        finally:
            runner.helper_path = real_path
        self.assertEqual((answer, failure, stages, audit['errorCode']), (None, 'helper_missing', [], 'helper_missing'))
        self.assertEqual(audit['modelCalls'], [])

        unknown = dict(settings)
        unknown['helper'] = 'app/local/not_the_evidence_helper.py'
        answer, audit, failure, stages, _ = self.execute(unknown, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'helper_unknown')
        self.assertEqual(audit['errorCode'], 'helper_unknown')
        self.assertEqual(str(runner.AuditFailure('helper_unknown', {})), 'helper_unknown')

        alien = Path(tempfile.gettempdir()) / 'alien-blue-evidence-refs.py'
        alien.write_bytes(b'print("not the helper")\n')
        runner.helper_path = lambda: alien
        try:
            _, audit, failure, _, _ = self.execute(settings, ID_SELECTION, {'status': 'abstain', 'targets': []})
        finally:
            runner.helper_path = real_path
            alien.unlink(missing_ok=True)
        self.assertEqual((failure, audit['errorCode']), ('helper_unknown', 'helper_unknown'))

        stale = dict(settings)
        stale['helperSha256'] = '0' * 64
        _, audit, failure, stages, _ = self.execute(stale, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'helper_stale')
        self.assertEqual(audit['errorCode'], 'helper_stale')
        self.assertEqual(stages, [])

    def test_profile_version_and_settings_agree(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        settings = profile['settings']
        self.assertEqual(profile['id'], 'shinick-blue-evidence-external-v034')
        self.assertEqual(profile['version'], '0.3.4')
        self.assertEqual(settings['diagnosticVersion'], profile['version'])
        self.assertEqual(settings['auditSchema'], 'falsify.blue-evidence-audit.v0.3.4')
        self.assertEqual(settings['model'], 'claude-opus-5-5')
        self.assertEqual(settings['effort'], 'medium')
        self.assertEqual(settings['externalLookup'], {'enabled': True, 'providers': ['crossref', 'europepmc']})
        self.assertEqual(settings['internalMaxCalls'], 4)
        self.assertEqual(settings['scope'], runner.SCOPE)
        self.assertTrue(settings['experimental'])
        self.assertEqual(settings['bundleSha256'], runner.bundle_identity())
        self.assertEqual(settings['helper'], runner.HELPER_REL)
        self.assertEqual(settings['helperSha256'], runner.helper_digest())
        self.assertEqual(settings['inheritedSources'], runner.inherited_sources())
        self.assertEqual(profile['instructions'], runner.INSTRUCTIONS)
        self.assertTrue(Path(profile['adapter']['executable']).is_file())
        self.assertEqual(profile['adapter']['args'], [str(HERE / 'runner.py')])
        self.assertTrue(Path(profile['adapter']['args'][0]).is_absolute())
        audit_dir = Path(settings['auditDirectory'])
        self.assertTrue(audit_dir.is_absolute())
        self.assertEqual(audit_dir, runner.v033.REPO / '.local' / 'blue-evidence-v034-audits')
        self.assertNotIn(runner.HELPER_REL, settings['inheritedSources'])
        self.assertIn('app/local/blue_service.py', settings['inheritedSources'])
        template = (HERE / 'profile-template.json').read_text(encoding='utf-8')
        self.assertIn('"INSTALL_PY"', template)
        self.assertIn('"INSTALL_RUNNER"', template)
        self.assertIn('"INSTALL_AUDIT_DIR"', template)
        self.assertIn('GENERATED_AT_INSTALL', template)
        self.assertNotIn(str(runner.v033.REPO), template)
        self.assertNotIn(sys.executable, template)
        self.assertNotIn('sk-', template)
        built = json.dumps(profile)
        self.assertNotIn('INSTALL_', built)
        self.assertNotIn('GENERATED_AT_INSTALL', built)
        drifted = copy.deepcopy(settings)
        drifted['diagnosticVersion'] = '0.3.3'
        _, audit, failure, _, _ = self.execute(drifted, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'settings_contract')
        self.assertEqual(audit['errorCode'], 'settings_contract')

    def test_targets_id_selection_skips_final_experts_and_keeps_raw_response(self):
        from blue_service import SELECTION
        self.assertIn('targets', SELECTION['properties'])
        self.assertNotIn('findings', SELECTION['properties'])
        response = {'status': 'ok', 'targets': [{'referenceId': 'er000000000001', 'reason': 'reread this span'}]}
        answer, audit, failure, stages, raw = self.execute(runner.contract_settings(), ID_SELECTION, response)
        self.assertIsNone(failure)
        self.assertEqual(stages, ['document-stage'])
        self.assertEqual(answer, raw)
        self.assertEqual(audit['modelCalls'][0]['response'], raw)
        self.assertIsNot(audit['modelCalls'][0]['response'], response)
        self.assertNotIn('scanDerivation', audit)
        self.assertEqual(audit['pipeline'], 'single-original-scan-or-selection; external lookup only at final review')
        self.assertEqual(audit['diagnosticVersion'], '0.3.4')
        self.assertEqual(audit['schema'], runner.AUDIT_SCHEMA)
        self.assertNotIn('statistics', json.dumps(stages))
        response['targets'][0]['reason'] = 'mutated after return'
        self.assertEqual(audit['modelCalls'][0]['response'], raw)
        self.assertEqual(audit['modelCalls'][0]['response']['targets'][0]['referenceId'], 'er000000000001')

    def _linked_inner(self, folder, audit):
        self.assertEqual(len(audit.get('inheritedAudits', [])), 1)
        link = audit['inheritedAudits'][0]
        self.assertEqual(link['path'].split('/'), ['inherited', audit['id'], link['path'].split('/')[-1]])
        file = folder / link['path']
        self.assertTrue(file.is_file())
        self.assertNotEqual(file.parent, folder)
        blob = file.read_bytes()
        inner = json.loads(blob.decode('utf-8'))
        self.assertEqual(link['fileSha256'], hashlib.sha256(blob).hexdigest())
        self.assertEqual(link['inputSha256'], inner['inputSha256'])
        self.assertEqual(audit['modelCalls'][0]['response'], inner['modelCalls'][0]['response'])
        return blob, inner

    def test_concurrent_calls_keep_separate_immutable_inner_audits(self):
        barrier = threading.Barrier(2)
        settings = runner.contract_settings()
        responses = [
            {'status': 'ok', 'targets': [{'referenceId': 'er000000000001', 'reason': 'left span'}]},
            {'status': 'ok', 'targets': [{'referenceId': 'er000000000002', 'reason': 'right span'}]},
        ]
        payload = json.dumps(self.invocation(
            settings, ID_SELECTION, {'segments': [{'id': 's1', 'text': 'Alpha'}]})).encode()
        results = [None, None]

        def run_one(index):
            def fixture(stage, prompt, out_schema, remaining):
                self.assertEqual(stage, 'document-stage')
                barrier.wait(5)
                return {'status': 'ok', 'response': responses[index], 'observed_tool_calls': 0}

            try:
                answer = runner.execute(payload, fixture, no_network, folder)
                results[index] = answer
            except Exception as error:
                results[index] = error

        with tempfile.TemporaryDirectory() as folder_name:
            folder = Path(folder_name)
            threads = [threading.Thread(target=run_one, args=(index,)) for index in (0, 1)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
                self.assertFalse(thread.is_alive())
            self.assertEqual([type(item) for item in results], [dict, dict])
            self.assertEqual(sorted(item['targets'][0]['referenceId'] for item in results),
                             ['er000000000001', 'er000000000002'])
            outers = [json.loads(path.read_text(encoding='utf-8')) for path in folder.glob('*.json')]
            self.assertEqual(len(outers), 2)
            blobs = []
            for audit in outers:
                blob, inner = self._linked_inner(folder, audit)
                blobs.append(blob)
                self.assertEqual(inner['state'], 'completed')
                self.assertEqual(audit['modelCalls'][0]['response']['targets'][0]['referenceId'],
                                 inner['modelCalls'][0]['response']['targets'][0]['referenceId'])
            self.assertEqual(len({hashlib.sha256(blob).hexdigest() for blob in blobs}), 2)
            self.assertEqual(len({audit['inheritedAudits'][0]['path'] for audit in outers}), 2)
            kept = {audit['inheritedAudits'][0]['path']: (folder / audit['inheritedAudits'][0]['path']).read_bytes()
                    for audit in outers}

            def failing(stage, prompt, out_schema, remaining):
                self.assertEqual(stage, 'document-stage')
                return {'status': 'error', 'error_code': 'backend', 'response': {'marker': 'raw-failure', 'kept': True}}

            with self.assertRaises(runner.AuditFailure) as caught:
                runner.execute(payload, failing, no_network, folder)
            self.assertEqual(caught.exception.code, 'model_stage_failed')
            failed = [json.loads(path.read_text(encoding='utf-8'))
                      for path in folder.glob('*.json') if json.loads(path.read_text(encoding='utf-8')).get('state') == 'failed']
            self.assertEqual(len(failed), 1)
            failed_blob, failed_inner = self._linked_inner(folder, failed[0])
            self.assertEqual(failed[0]['errorCode'], 'model_stage_failed')
            self.assertEqual(failed_inner['errorCode'], 'model_stage_failed')
            self.assertEqual(failed[0]['modelCalls'][0]['response'], {'marker': 'raw-failure', 'kept': True})
            self.assertEqual(hashlib.sha256(failed_blob).hexdigest(), failed[0]['inheritedAudits'][0]['fileSha256'])
            for rel, previous in kept.items():
                self.assertEqual((folder / rel).read_bytes(), previous)
            self.assertEqual(len(list(folder.glob('*.json'))), 3)
            self.assertEqual(len(list((folder / 'inherited').glob('*/*.json'))), 3)

    def test_old_source_files_unchanged(self):
        for rel, digest in runner.inherited_sources().items():
            disk = hashlib.sha256((runner.v033.REPO / rel).read_bytes()).hexdigest()
            self.assertEqual(disk, digest)
        # Source ZIPs have no Git history. Pin frozen predecessor content while
        # allowing Windows checkout line endings and unrelated integration work.
        frozen = json.loads((HERE / 'frozen-source-sha256.json').read_text(encoding='utf-8'))
        for rel, expected in frozen['files'].items():
            raw = (runner.v033.REPO / rel).read_bytes().replace(b'\r\n', b'\n')
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected, rel)


if __name__ == '__main__':
    unittest.main()

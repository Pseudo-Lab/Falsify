"""Offline tests for BLUE Evidence v0.3.7. Zero pytest, zero real network or model calls."""
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
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

FINAL_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['status', 'findings'],
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'findings': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['id', 'segmentId', 'quote', 'rationale', 'evidence', 'uncertainty'],
                'properties': {
                    'id': {'type': 'string'},
                    'segmentId': {'type': 'string'},
                    'quote': {'type': 'string'},
                    'rationale': {'type': 'string'},
                    'uncertainty': {'type': 'string'},
                    'evidence': {
                        'type': 'array',
                        'items': {
                            'type': 'object',
                            'additionalProperties': False,
                            'required': ['segmentId', 'quote', 'relation'],
                            'properties': {
                                'segmentId': {'type': 'string'},
                                'quote': {'type': 'string'},
                                'relation': {'type': 'string'},
                            },
                        },
                    },
                },
            },
        },
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_network_call')


def _sha_json(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode('utf-8')).hexdigest()


def _parse_digest_json(prompt):
    marker = runner.DIGEST_HEADER.strip()
    idx = prompt.find(marker)
    assert idx != -1, 'digest header missing'
    raw_json = prompt[idx + len(marker):].lstrip('\n')
    return json.loads(raw_json)


def _mock_bib_transport(provider, path):
    if provider == 'crossref' and '10.1000%2Fret-cr' in path:
        data = {
            'message': {
                'DOI': '10.1000/ret-cr',
                'title': ['Hydroxychloroquine Observational Trial'],
                'author': [{'given': 'J', 'family': 'Doe'}],
                'published': {'date-parts': [[2020]]},
                'update-to': [{'type': 'retraction', 'DOI': '10.1000/ret-notice'}],
            }
        }
        return 200, data, _sha_json(data)
    if provider == 'crossref' and '10.1000%2Feoc-epmc' in path:
        data = {
            'message': {
                'DOI': '10.1000/eoc-epmc',
                'title': ['Sepsis Biomarker Cohort'],
                'author': [{'given': 'M', 'family': 'Chen'}],
                'published': {'date-parts': [[2022]]},
            }
        }
        return 200, data, _sha_json(data)
    if provider == 'europepmc':
        if '10.1000%2Feoc-epmc' in path or '10.1000/eoc-epmc' in path:
            data = {
                'resultList': {
                    'result': [{
                        'doi': '10.1000/eoc-epmc',
                        'title': 'Sepsis Biomarker Cohort',
                        'authorString': 'Chen M',
                        'pubYear': '2022',
                        'pubTypeList': {'pubType': ['Journal Article', 'Expression of Concern']},
                        'abstractText': 'Biomarker findings under investigation.',
                    }]
                }
            }
            return 200, data, _sha_json(data)
        empty = {'resultList': {'result': []}}
        return 200, empty, _sha_json(empty)
    raise AssertionError((provider, path))


def _mock_identifier_fetcher(provider, path):
    if provider == 'osf' and path == '/v2/nodes/abc12/':
        return 404, None, hashlib.sha256(b'404').hexdigest()
    if provider == 'osf' and path == '/v2/registrations/abc12/':
        data = {'data': {'type': 'registrations', 'attributes': {'title': 'OSF Pre-Reg', 'registration': True}}}
        return 200, data, _sha_json(data)
    if provider == 'osf' and 'miss9' in path:
        return 404, None, hashlib.sha256(b'404').hexdigest()
    if provider == 'ncbi' and 'GSE123456' in path:
        data = {'esearchresult': {'count': '1', 'idlist': ['200123456']}}
        return 200, data, _sha_json(data)
    if provider == 'rcsb' and path.endswith('/1ABC'):
        data = {'struct': {'title': 'Crystal structure of test enzyme'}}
        return 200, data, _sha_json(data)
    raise AssertionError((provider, path))


def _mock_ct_transport(nct_id):
    raw = {
        'protocolSection': {
            'identificationModule': {'nctId': nct_id, 'briefTitle': 'Aspirin Trial'},
            'statusModule': {'overallStatus': 'COMPLETED', 'studyFirstPostDateStruct': {'date': '2020-01-10'}},
            'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 300, 'type': 'ACTUAL'}},
            'outcomesModule': {
                'primaryOutcomes': [{'measure': 'All-cause mortality at 24 months', 'timeFrame': '24 months'}],
                'secondaryOutcomes': [{'measure': 'Progression-free survival at 12 months', 'timeFrame': '12 months'}],
            },
        }
    }
    return 200, raw, _sha_json(raw)


class OfflineV037Tests(unittest.TestCase):
    def setUp(self):
        self._net_patcher = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net_patcher.start()

    def tearDown(self):
        self._net_patcher.stop()

    def _payload(self, segments, settings=None, schema=None):
        return json.dumps({
            'schema': 'falsify.harness-invocation.v1',
            'role': 'blue',
            'call': 1,
            'maxCalls': 8,
            'settings': settings if settings is not None else runner.contract_settings(),
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': segments}, ensure_ascii=False),
            'outputSchema': schema or ID_SELECTION,
        }, ensure_ascii=False).encode('utf-8')

    def test_profile_build_and_contract_sha256_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        self.assertEqual(profile['id'], 'shinick-blue-evidence-triage-v037')
        self.assertEqual(profile['version'], '0.3.7')
        self.assertEqual(profile['settings']['externalLookup'], {
            'enabled': True,
            'providers': ['crossref', 'europepmc', 'clinicaltrials', 'osf', 'ncbi_geo', 'rcsb_pdb'],
        })
        runner.check_settings(profile['settings'])
        for rel in runner.TRACKED_SOURCES:
            self.assertIn(rel, runner.source_map())
        drifted = dict(profile['settings'], diagnosticVersion='0.3.6')
        with self.assertRaisesRegex(ValueError, 'settings_contract'):
            runner.check_settings(drifted)

        before = runner.bundle_identity()
        v036_before = runner.v036.bundle_identity()
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name in ('paper_stat_audit.py', 'paper_supplement_audit.py', 'paper_registry_identifiers.py'):
                return data + b'\n# tamper\n'
            return data

        with patch.object(runner, 'read_bytes', side_effect=tampered):
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v036.bundle_identity(), v036_before)
        self.assertEqual(runner.bundle_identity(), before)

    def test_layer0_stat_triage_and_antifp_exemptions(self):
        segments = [
            {
                'id': 's-sprite',
                'text': 'Participants (N = 10, 5-point Likert scale 1-5) reported mean = 4.50, SD = 0.10.',
            },
            {
                'id': 's-2x2-bad',
                'text': 'Events occurred in 20/40 vs 2/40 patients (OR = 19.00, p = 0.50).',
            },
            {
                'id': 's-2x2-aor',
                'text': 'In multivariable logistic regression, events were 20/40 vs 2/40 (aOR = 2.10, p = 0.50).',
            },
            {
                'id': 's-fdr-padj',
                'text': 'Group difference was t(28) = 2.50, FDR-adjusted p_adj = 0.08.',
            },
            {
                'id': 's-km',
                'text': 'Number at risk\nTreatment 50 40 45 30\nControl 50 38 30 20',
            },
        ]
        seen = []

        def fake_model(stage, prompt, schema, seconds):
            seen.append((stage, prompt))
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        with tempfile.TemporaryDirectory() as folder:
            runner.execute(self._payload(segments), fake_model, no_network, folder)
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))

        triage = audit['deterministicTriage']
        sigs = triage['statAudit']['signals']
        kinds_by_seg = {(s['segmentId'], s['kind']) for s in sigs}
        self.assertIn(('s-sprite', 'sprite_bounds_mismatch'), kinds_by_seg)
        self.assertIn(('s-2x2-bad', 'two_by_two_mismatch'), kinds_by_seg)
        self.assertIn(('s-km', 'km_at_risk_non_monotonic'), kinds_by_seg)
        self.assertFalse(any(s['segmentId'] == 's-2x2-aor' for s in sigs))
        self.assertFalse(any(s['segmentId'] == 's-fdr-padj' for s in sigs))

        digest = _parse_digest_json(seen[0][1])
        self.assertEqual(len(digest['layer0StatSignals']), len(sigs))
        self.assertIn('respect multivariable aOR/aRR', seen[0][1])

    def test_supplement_segment_cross_audit_injected_into_prompt(self):
        segments = [
            {
                'id': 's0',
                'text': 'We enrolled N = 240 patients. Table S1 reports AUC = 0.94. See Table S4.',
            },
            {
                'id': 'supp-0-0',
                'label': '[보충: Table_S1.csv · Main]',
                'text': 'Model,AUC\nProposed,0.81\n',
            },
            {
                'id': 'supp-1-0',
                'label': '[보충: run_eval.log · Log]',
                'text': 'Loaded 185 rows\nTable S1 summary.\n',
            },
        ]
        seen = []

        def fake_model(stage, prompt, schema, seconds):
            seen.append(prompt)
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        with tempfile.TemporaryDirectory() as folder:
            runner.execute(self._payload(segments), fake_model, no_network, folder)
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))

        supp_audit = audit['deterministicTriage']['supplementAudit']
        self.assertEqual(supp_audit['supplementCount'], 2)
        kinds = {s['kind'] for s in supp_audit['signals']}
        self.assertIn('missing_supplementary_item', kinds)
        self.assertIn('cross_file_sample_size_mismatch', kinds)
        self.assertIn('cross_file_metric_mismatch', kinds)

        digest = _parse_digest_json(seen[0])
        digest_kinds = {s['kind'] for s in digest['supplementSignals']}
        self.assertEqual(digest_kinds, kinds)
        self.assertIn('Table S4', json.dumps(digest['supplementSignals']))

    def test_retraction_identifiers_and_trials_in_full_pipeline(self):
        paper = (
            'In trial NCT01234567 we enrolled 180 patients; primary outcome was progression-free survival at 12 months [1, 2]. '
            'Data at osf.io/abc12 and osf.io/miss9, GEO GSE123456, PDB ID: 1ABC, PROSPERO CRD42023123456 and CRD4209900001.\n'
            'References\n'
            '[1] Doe J. Hydroxychloroquine Observational Trial. Lancet. 2020; doi:10.1000/ret-cr\n'
            '[2] Chen M. Sepsis Biomarker Cohort. BMJ. 2022; doi:10.1000/eoc-epmc\n'
        )
        stages_seen = {}

        def fake_model(stage, prompt, schema, seconds):
            stages_seen[stage] = prompt
            if stage == 'literature-plan':
                return {'status': 'ok', 'response': {'statistics': 'sepsis trial sample', 'methods': 'randomized protocol'}}
            if stage in ('statistics', 'methods'):
                return {'status': 'ok', 'response': {'status': 'abstain', 'findings': []}}
            raise AssertionError(stage)

        def fake_search(plans):
            return {'status': 'completed', 'requests': [], 'packets': {'statistics': [], 'methods': []}, 'sources': []}

        with tempfile.TemporaryDirectory() as folder:
            answer = runner.execute(
                self._payload([{'id': 's0', 'text': paper}], schema=FINAL_SCHEMA),
                fake_model,
                fake_search,
                folder,
                registry_transport=_mock_ct_transport,
                bib_transport=_mock_bib_transport,
                identifier_fetcher=_mock_identifier_fetcher,
            )
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))

        self.assertEqual(answer, {'status': 'abstain', 'findings': []})
        self.assertNotIn('DETERMINISTIC TRIAGE & EXTERNAL ORACLE DIGEST', stages_seen['literature-plan'])
        for st in ('statistics', 'methods'):
            self.assertIn('DETERMINISTIC TRIAGE & EXTERNAL ORACLE DIGEST', stages_seen[st])
            self.assertIn('embargoed-registry caveats', stages_seen[st])

        digest = _parse_digest_json(stages_seen['statistics'])
        self.assertEqual(len(digest['retractedReferences']), 2)
        self.assertEqual({r['retractionType'] for r in digest['retractedReferences']}, {'retraction', 'expression_of_concern'})
        self.assertEqual(digest['bibliographySummary']['retractedCount'], 2)
        self.assertEqual(digest['clinicalTrials'][0]['nctId'], 'NCT01234567')
        self.assertEqual(digest['scientificIdentifiers']['summary']['osfVerified'], 1)
        self.assertEqual(digest['scientificIdentifiers']['summary']['osfUnresolved'], 1)
        self.assertEqual(digest['scientificIdentifiers']['summary']['lookupFailed'], 0)
        self.assertEqual(digest['scientificIdentifiers']['summary']['geoVerified'], 1)
        self.assertEqual(digest['scientificIdentifiers']['summary']['pdbVerified'], 1)
        self.assertEqual(digest['scientificIdentifiers']['summary']['prosperoChecked'], 2)
        self.assertIn('prosperoNote', digest['scientificIdentifiers'])
        self.assertTrue(any(s['kind'] == 'malformed_prospero_id' for s in digest['layer0StatSignals']))
        self.assertEqual(audit['diagnosticVersion'], '0.3.7')

    def test_prompt_ceiling_digest_cap_timeout_124_and_ccn(self):
        big_compact = {
            'retractedReferences': [{'index': 1, 'doi': '10.1000/ret'}],
            'layer0StatSignals': [{'id': f'stat-{i}', 'excerpt': 'x' * 400, 'detail': 'y' * 400} for i in range(40)],
            'claimGroundings': [{'refIndex': i, 'retrievedRecord': {'abstract': 'z' * 2000}} for i in range(6)],
        }
        bounded = runner._format_bounded_digest(big_compact)
        self.assertLessEqual(len(bounded), runner.MAX_DIGEST_BLOCK_CHARS)
        self.assertIn('retractedReferences', bounded)
        self.assertEqual(runner.v036._append_grounding('a' * 99_950, bounded), 'a' * 99_950)
        self.assertLessEqual(len(runner.v036._append_grounding('a' * 95_000, bounded)), runner.MAX_PROMPT_CHARS)

        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(runner.AuditFailure) as caught:
                runner.execute(
                    self._payload([{'id': 's0', 'text': 'Clean text.'}]),
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

        py_fns_script = REPO / 'tools' / 'quality' / 'python-functions.py'
        for name in ('runner.py', 'build_profile.py', 'test_offline.py'):
            proc = subprocess.run(
                [sys.executable, str(py_fns_script)],
                input=(HERE / name).read_bytes(),
                capture_output=True,
                check=True,
            )
            fns = json.loads(proc.stdout.decode('utf-8'))
            over = [f"{f['id']}:{f['ccn']}" for f in fns if f['ccn'] > 15]
            self.assertEqual(over, [], f'CCN > 15 in {name}: {over}')


if __name__ == '__main__':
    unittest.main()

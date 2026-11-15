"""Offline tests for BLUE Evidence v0.4.0. Zero pytest and zero live network."""
import importlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
import build_profile
import runner

EXACT_LINE = 'Primary endpoint was hemoglobin stability.'
LEDGER_QUOTE = 'We enrolled N = 40 patients.'
ABSTRACT = '\n'.join((
    'Abstract',
    'N = 240.',
    'Mortality was 8.2% (p = 0.012).',
))
METHODS = '\n'.join((
    'Methods',
    'The primary endpoint was assessed at 12 months.',
    'The primary endpoint was 12-month mortality.',
))
RESULTS = '\n'.join((
    'Results',
    'A total of N = 180 patients were randomized.',
    'Mortality was 14.5% (p = 0.18).',
    'The primary endpoint at 6 months was reported.',
    '12-month mortality was not significant (p = 0.22).',
))
CONCLUSION = 'Conclusion\nThe secondary endpoint of response rate improved significantly.'
SCAN_SCHEMA = {
    'type': 'object',
    'additionalProperties': True,
    'required': ['summary', 'targets'],
    'properties': {
        'summary': {'type': 'string'},
        'targets': {'type': 'array'},
    },
}
ID_SELECTION = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['status', 'targets'],
    'properties': {
        'status': {'type': 'string'},
        'targets': {'type': 'array'},
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_network_call')


def _kinds(signals):
    return [sig.get('kind') for sig in signals]


def _paper_segments():
    return [
        {'id': 's0', 'pageIndex': 0, 'text': ABSTRACT},
        {'id': 's1', 'pageIndex': 1, 'text': METHODS},
        {'id': 's2', 'pageIndex': 2, 'text': RESULTS},
        {'id': 's3', 'pageIndex': 3, 'text': CONCLUSION},
    ]


def _loader_module(calls):
    fake = types.ModuleType('paper_tabular_notebook_loader')

    def parse_xlsx_workbook(raw_bytes, *, name='workbook.xlsx'):
        calls.append(('xlsx', name, bytes(raw_bytes)))
        return {
            'text': 'a\tb\n1\t2\n',
            'sheets': [{'sheetName': 'S', 'tsvText': 'a\tb\n1\t2\n1\t3\n1\t4\n'}],
        }

    def parse_ipynb_notebook(raw_bytes, *, name='notebook.ipynb'):
        calls.append(('ipynb', name, bytes(raw_bytes)))
        return {'text': 'print(1)\n', 'combinedCode': 'print(1)\n', 'language': 'python'}

    fake.parse_xlsx_workbook = parse_xlsx_workbook
    fake.parse_ipynb_notebook = parse_ipynb_notebook
    return fake


def _capture_audits(seen):
    def raw_audit(main, supps, **kwargs):
        seen['raw'] = list(supps)
        return {'signals': []}

    def code_audit(main, supps, **kwargs):
        seen['code'] = list(supps)
        return {'signals': []}

    return raw_audit, code_audit


class OfflineV040Tests(unittest.TestCase):
    def setUp(self):
        self._net_patcher = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net_patcher.start()

    def tearDown(self):
        self._net_patcher.stop()

    def _payload(self, segments, schema=None):
        return json.dumps({
            'schema': 'falsify.harness-invocation.v1',
            'role': 'blue',
            'call': 1,
            'maxCalls': 8,
            'settings': runner.contract_settings(),
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': segments}, ensure_ascii=False),
            'outputSchema': schema or ID_SELECTION,
        }, ensure_ascii=False).encode('utf-8')

    def _run(self, segments, model, schema=None):
        with tempfile.TemporaryDirectory() as folder:
            answer = runner.execute(self._payload(segments, schema), model, no_network, folder)
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))
        return answer, audit

    def test_profile_contract_and_bundle_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        self.assertEqual(profile['id'], 'shinick-blue-evidence-triage-v040')
        self.assertEqual(profile['version'], '0.4.0')
        self.assertEqual(profile['name'], runner.PROFILE_NAME)
        self.assertEqual(profile['settings']['auditSchema'], runner.AUDIT_SCHEMA)
        self.assertEqual(profile['settings']['internalConsistencyHelper'], runner.INTERNAL_REL)
        runner.check_settings(profile['settings'])
        self.assertEqual(runner.TRACKED_SOURCES, (runner.INTERNAL_REL, runner.RUNNER_REL))
        self.assertNotIn('paper_tabular_notebook_loader.py', ''.join(runner.TRACKED_SOURCES))
        drifted = dict(profile['settings'], diagnosticVersion='0.3.9')
        with self.assertRaisesRegex(ValueError, 'settings_contract'):
            runner.check_settings(drifted)
        before = runner.bundle_identity()
        previous = runner.v039.bundle_identity()
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name == 'paper_internal_consistency.py':
                return data + b'\n# tamper\n'
            return data

        with patch.object(runner, 'read_bytes', side_effect=tampered):
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v039.bundle_identity(), previous)
        self.assertEqual(runner.bundle_identity(), before)

    def test_internal_consistency_is_in_triage_and_bounded_digest(self):
        seen = []

        def fake_model(stage, prompt, schema, seconds):
            seen.append((stage, prompt))
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        answer, audit = self._run(_paper_segments(), fake_model)
        triage = audit['deterministicTriage']
        report = triage['internalConsistency']
        self.assertEqual(triage['schema'], runner.TRIAGE_SCHEMA)
        self.assertEqual(report['schema'], 'falsify.internal-consistency.v1')
        self.assertIn('abstract_results_sample_size_mismatch', _kinds(report['signals']))
        self.assertIn('abstract_results_effect_or_p_mismatch', _kinds(report['signals']))
        self.assertIn('methods_results_protocol_drift', _kinds(report['signals']))
        self.assertNotIn('primary_endpoint_emphasis_shift', _kinds(report['signals']))
        self.assertTrue(report['triageHints'][0]['advisoryOnly'])
        self.assertEqual(answer['status'], 'abstain')
        self.assertLessEqual(len(seen[0][1]), runner.MAX_PROMPT_CHARS)
        start = seen[0][1].find(runner.DIGEST_HEADER)
        self.assertGreaterEqual(start, 0)
        block = seen[0][1][start:]
        self.assertLessEqual(len(block), runner.MAX_DIGEST_BLOCK_CHARS)
        digest = json.loads(block[len(runner.DIGEST_HEADER):])
        self.assertIn('abstract_results_sample_size_mismatch', _kinds(digest['internalConsistencySignals']))
        self.assertTrue(all(item['advisoryOnly'] is True for item in digest['internalConsistencyHints']))
        self.assertIn('internalConsistencyHints are advisoryOnly', seen[0][1])

    def test_digest_shrink_respects_block_limit(self):
        bulky = {
            'internalConsistencySignals': [{'id': str(i), 'excerpt': 'x' * 400} for i in range(80)],
            'internalConsistencyHints': [
                {'id': str(i), 'advisoryOnly': True, 'verificationPrompt': 'y' * 300} for i in range(40)
            ],
        }
        text = runner._format_bounded_digest(bulky)
        self.assertLessEqual(len(text), runner.MAX_DIGEST_BLOCK_CHARS)
        self.assertTrue(text.startswith(runner.DIGEST_HEADER))
        parsed = json.loads(text[len(runner.DIGEST_HEADER):])
        self.assertLessEqual(len(parsed.get('internalConsistencySignals') or []), 8)
        self.assertTrue(all(item.get('advisoryOnly') is True for item in parsed.get('internalConsistencyHints') or []))

    def test_quote_status_folds_pdf_typography(self):
        blob = 'The \ufb01nal two\u2010sided result used a \u00b5 scale and \u201calpha\u201d.'
        quote = 'The final two-sided result used a \u03bc scale and "alpha".'
        status = runner._quote_status(quote, runner.brv.collapse_ws(blob), runner._fold_match(blob))
        self.assertEqual(status, 'normalized')
        wrapped = 'Primary hemo-\nglobin remained stable.'
        status2 = runner._quote_status(
            'Primary hemoglobin remained stable.',
            runner.brv.collapse_ws(wrapped),
            runner._fold_match(wrapped),
        )
        self.assertEqual(status2, 'normalized')

    def test_typographic_defect_quote_stays_grounded(self):
        text = 'The \ufb01nal two\u2010sided result used a \u00b5 scale and \u201calpha\u201d.'
        quote = 'The final two-sided result used a \u03bc scale and "alpha".'

        def fake_model(stage, prompt, schema, seconds):
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'findings': [{
                    'id': 'F1',
                    'verdictLabel': 'defect',
                    'quote': quote,
                    'rationale': 'typographic match',
                }],
            }}

        answer, audit = self._run([{'id': 's0', 'text': text}], fake_model, SCAN_SCHEMA)
        finding = answer['findings'][0]
        self.assertEqual(finding['verdictLabel'], '아님')
        self.assertFalse(finding['rationale'].startswith(runner.DOWNGRADE_PREFIX))
        self.assertEqual(audit['reportValidation']['quoteChecks'][0]['status'], 'normalized')
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])

    def test_zero_drop_restores_missing_ledger_candidate(self):
        segments = [{'id': 's0', 'text': LEDGER_QUOTE + ' Follow-up was complete.'}]

        def fake_model(stage, prompt, schema, seconds):
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'candidateLedger': [{
                    'candidateId': 'C9',
                    'quote': LEDGER_QUOTE,
                    'defectFamily': 'D6',
                    'pageIndex': 0,
                    'locationLabel': 'Results',
                }],
                'findings': [],
            }}

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        restored = answer['findings'][0]
        self.assertEqual(restored['verdictLabel'], '확인필요')
        self.assertTrue(restored['zeroDropRecovered'])
        self.assertEqual(audit['reportValidation']['zeroDrop']['recoveredCount'], 1)
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])

    def test_hallucinated_quote_is_downgraded_after_one_repair(self):
        stages = []

        def fake_model(stage, prompt, schema, seconds):
            stages.append(stage)
            if stage == 'quote-repair':
                return {'status': 'ok', 'response': {'findings': [{
                    'id': 'F1',
                    'quote': 'still invented after the repair turn',
                    'verdictLabel': 'defect',
                    'rationale': 'still wrong',
                }]}}
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'findings': [{
                    'id': 'F1',
                    'verdictLabel': 'defect',
                    'quote': 'original hallucination',
                    'rationale': 'bad',
                }],
            }}

        answer, audit = self._run([{'id': 's0', 'text': EXACT_LINE}], fake_model, SCAN_SCHEMA)
        self.assertEqual(stages.count('quote-repair'), 1)
        finding = answer['findings'][0]
        self.assertEqual(finding['verdictLabel'], '확인필요')
        self.assertTrue(finding['rationale'].startswith('[인용 미검증 자동 강등] '))
        self.assertEqual(audit['reportValidation']['downgradedIds'], ['F1'])

    def test_absent_loader_keeps_original_bytes(self):
        seg = {'id': 'supp-0-0', 'name': 'book.xlsx', 'text': '', 'bytes': b'not-a-real-zip'}
        with patch.object(importlib.util, 'find_spec', return_value=None):
            prepared = runner._prepare_supplement_items([seg])
        self.assertEqual(prepared[0]['name'], 'book.xlsx')
        self.assertEqual(prepared[0]['bytes'], b'not-a-real-zip')
        self.assertNotIn('paper_tabular_notebook_loader.py', runner.TRACKED_SOURCES)

    def test_loader_decodes_xlsx_and_ipynb_before_audits(self):
        calls = []
        seen = {}
        raw_audit, code_audit = _capture_audits(seen)
        segs = [
            {'id': 'supp-0-0', 'name': 'book.xlsx', 'text': '', 'bytes': b'xlsx-bytes'},
            {'id': 'supp-1-0', 'name': 'nb.ipynb', 'text': '', 'bytes': b'ipynb-bytes'},
        ]
        with patch.object(importlib.util, 'find_spec', return_value=object()), \
             patch.object(importlib, 'import_module', return_value=_loader_module(calls)), \
             patch.object(runner.pra, 'audit_raw_datasets', side_effect=raw_audit), \
             patch.object(runner.pca, 'audit_code_supplements', side_effect=code_audit):
            runner._attach_dataset_audits({'totalSignals': 0}, [{'id': 's0', 'text': 'N = 1'}], segs)
        self.assertEqual([item[0] for item in calls], ['xlsx', 'ipynb'])
        self.assertEqual(calls[0][2], b'xlsx-bytes')
        self.assertEqual(calls[1][2], b'ipynb-bytes')
        raw_text = '\n'.join(item.get('text', '') for item in seen['raw'])
        code_text = '\n'.join(item.get('text', '') for item in seen['code'])
        self.assertIn('a\tb', raw_text)
        self.assertIn('print(1)', code_text)

    def test_owned_functions_stay_within_ccn_limit(self):
        script = REPO / 'tools' / 'quality' / 'python-functions.py'
        paths = [
            HERE / 'runner.py',
            HERE / 'build_profile.py',
            HERE / 'test_offline.py',
            REPO / 'app' / 'local' / 'paper_internal_consistency.py',
            REPO / 'app' / 'tests' / 'test_paper_internal_consistency.py',
        ]
        over = []
        for path in paths:
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=path.read_bytes(),
                capture_output=True,
                check=True,
            )
            functions = json.loads(proc.stdout.decode('utf-8'))
            over.extend(f"{path.name}:{item['id']}:{item['ccn']}" for item in functions if item['ccn'] > 15)
        self.assertEqual(over, [])


if __name__ == '__main__':
    unittest.main()

"""Offline tests for BLUE Evidence v0.3.9. Zero pytest and zero live network."""
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
BAD = (
    'All hypothesis tests were two-sided with alpha = 0.05, '
    'and feature standardization was fit strictly on the training split after train-test partitioning.'
)
LEAK_PY = (
    'from sklearn.preprocessing import StandardScaler\n'
    'from sklearn.model_selection import train_test_split\n'
    'from scipy.stats import ttest_ind\n'
    'X = StandardScaler().fit_transform(df[["age", "biomarker"]])\n'
    'X_train, X_test, y_train, y_test = train_test_split(X, y)\n'
    'ttest_ind(y_train, y_test, alternative="greater")\n'
)
R_SCRIPT = 'result <- t.test(x, y, alternative = "less")\n'
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


def _parse_digest_json(prompt):
    marker = runner.DIGEST_HEADER.strip()
    idx = prompt.find(marker)
    assert idx != -1, 'digest header missing'
    return json.loads(prompt[idx + len(marker):].lstrip('\n'))


def _kinds(signals):
    return [sig.get('kind') for sig in signals]


class OfflineV039Tests(unittest.TestCase):
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
        self.assertEqual(profile['id'], 'shinick-blue-evidence-triage-v039')
        self.assertEqual(profile['version'], '0.3.9')
        self.assertEqual(profile['settings']['auditSchema'], runner.AUDIT_SCHEMA)
        self.assertEqual(profile['settings']['codeAuditHelper'], runner.CODE_REL)
        runner.check_settings(profile['settings'])
        for rel in runner.TRACKED_SOURCES:
            self.assertIn(rel, runner.source_map())
        drifted = dict(profile['settings'], diagnosticVersion='0.3.8')
        with self.assertRaisesRegex(ValueError, 'settings_contract'):
            runner.check_settings(drifted)
        before = runner.bundle_identity()
        previous = runner.v038.bundle_identity()
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name == 'paper_code_audit.py':
                return data + b'\n# tamper\n'
            return data

        with patch.object(runner, 'read_bytes', side_effect=tampered):
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v038.bundle_identity(), previous)
        self.assertEqual(runner.bundle_identity(), before)

    def test_py_and_r_code_audit_signals_are_injected_into_digest(self):
        segments = [
            {'id': 's0', 'text': BAD},
            {
                'id': 'supp-0-0',
                'label': '[보충: analysis.py · Main]',
                'name': 'analysis.py',
                'text': LEAK_PY,
            },
            {
                'id': 'supp-1-0',
                'label': '[보충: analysis.R · Main]',
                'name': 'analysis.R',
                'text': R_SCRIPT,
            },
        ]
        seen = []

        def fake_model(stage, prompt, schema, seconds):
            seen.append((stage, prompt))
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        answer, audit = self._run(segments, fake_model)
        triage = audit['deterministicTriage']
        self.assertEqual(triage['schema'], runner.TRIAGE_SCHEMA)
        self.assertEqual(triage['codeAudit']['scriptCount'], 2)
        self.assertGreaterEqual(triage['codeAudit']['signalCount'], 2)
        self.assertEqual(answer['status'], 'abstain')
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])
        digest = _parse_digest_json(seen[0][1])
        kinds = _kinds(digest['codeAuditSignals'])
        self.assertIn('code_tailness_mismatch', kinds)
        self.assertIn('code_preprocessing_leakage', kinds)
        self.assertIn('code supplement audit is static AST/regex only', seen[0][1])
        self.assertIn('two-sided', digest['codeAuditSignals'][0]['excerpt'])

    def test_quote_status_folds_pdf_typography(self):
        blob = 'The \ufb01nal two\u2010sided result used a \u00b5 scale and \u201calpha\u201d.'
        quote = 'The final two-sided result used a \u03bc scale and "alpha".'
        status = runner._quote_status(quote, runner.brv.collapse_ws(blob), runner._fold_match(blob))
        self.assertEqual(status, 'normalized')
        wrapped = 'Primary hemo-\nglobin remained stable.'
        quote2 = 'Primary hemoglobin remained stable.'
        status2 = runner._quote_status(quote2, runner.brv.collapse_ws(wrapped), runner._fold_match(wrapped))
        self.assertEqual(status2, 'normalized')

    def test_typographic_defect_quote_stays_grounded(self):
        text = 'The \ufb01nal two\u2010sided result used a \u00b5 scale and \u201calpha\u201d.'
        quote = 'The final two-sided result used a \u03bc scale and "alpha".'
        segments = [{'id': 's0', 'text': text}]

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

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        finding = answer['findings'][0]
        self.assertEqual(finding['verdictLabel'], '아님')
        self.assertEqual(finding['quote'], quote)
        self.assertFalse(finding['rationale'].startswith(runner.DOWNGRADE_PREFIX))
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])
        self.assertEqual(audit['reportValidation']['downgradedIds'], [])
        self.assertEqual(audit['reportValidation']['quoteChecks'][0]['status'], 'normalized')

    def test_zero_drop_restores_missing_ledger_candidate(self):
        segments = [{'id': 's0', 'text': LEDGER_QUOTE + ' Follow-up was complete.'}]
        stages = []

        def fake_model(stage, prompt, schema, seconds):
            stages.append(stage)
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
        self.assertEqual(stages, ['document-stage'])
        self.assertEqual(len(answer['findings']), 1)
        restored = answer['findings'][0]
        self.assertEqual(restored['verdictLabel'], '확인필요')
        self.assertTrue(restored['zeroDropRecovered'])
        self.assertTrue(audit['reportValidation']['zeroDropRecovered'])
        self.assertEqual(audit['reportValidation']['zeroDrop']['recoveredCount'], 1)
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])

    def test_hallucinated_quote_is_downgraded_after_one_repair(self):
        segments = [{'id': 's0', 'text': EXACT_LINE}]
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

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        self.assertEqual(stages.count('quote-repair'), 1)
        finding = answer['findings'][0]
        self.assertEqual(finding['verdictLabel'], '확인필요')
        self.assertTrue(finding['rationale'].startswith('[인용 미검증 자동 강등] '))
        self.assertEqual(audit['reportValidation']['downgradedIds'], ['F1'])
        self.assertEqual(audit['reportValidation']['quoteChecks'][0]['status'], 'missing')

    def test_optional_flow_module_is_packed_without_being_tracked(self):
        fake = types.ModuleType('paper_flow_and_spin_triage')

        def audit_flow_and_spin_triage(main_segs):
            return {
                'flowSignals': [{'id': 'f1', 'excerpt': 'overstated benefit'}],
                'spinTriageHints': [{'id': 'h1'}],
            }

        fake.audit_flow_and_spin_triage = audit_flow_and_spin_triage
        with patch.object(runner.importlib.util, 'find_spec', return_value=None):
            self.assertIsNone(runner._run_flow([{'id': 's0', 'text': 'x'}]))
        self.assertNotIn('paper_flow_and_spin_triage', runner.TRACKED_SOURCES)
        with patch.object(runner.importlib.util, 'find_spec', return_value=object()), \
             patch.object(runner.importlib, 'import_module', return_value=fake):
            triage = {'totalSignals': 0}
            packed = runner._attach_flow(triage, [{'id': 's0', 'text': 'x'}])
        self.assertEqual(packed['flowSignals'][0]['id'], 'f1')
        self.assertEqual(triage['flowAndSpinTriage']['spinTriageHints'][0]['id'], 'h1')
        self.assertEqual(triage['totalSignals'], 1)
        real_triage = {'totalSignals': 0}
        real_packed = runner._attach_flow(real_triage, [{
            'id': 's0',
            'text': (
                'This observational retrospective study enrolled N = 80 patients '
                '(p = 0.42, non-significant). Treatment causally proves survival benefit. '
                '200 patients were screened, 20 were excluded before randomization, '
                'and 170 were randomized.'
            ),
        }])
        self.assertEqual(len(real_packed['flowSignals']), 1)
        self.assertEqual(len(real_packed['spinTriageHints']), 1)

    def test_runner_functions_stay_within_ccn_limit(self):
        script = REPO / 'tools' / 'quality' / 'python-functions.py'
        for name in ('runner.py', 'build_profile.py', 'test_offline.py'):
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=(HERE / name).read_bytes(),
                capture_output=True,
                check=True,
            )
            fns = json.loads(proc.stdout.decode('utf-8'))
            over = [f"{item['id']}:{item['ccn']}" for item in fns if item['ccn'] > 15]
            self.assertEqual(over, [], name)


if __name__ == '__main__':
    unittest.main()

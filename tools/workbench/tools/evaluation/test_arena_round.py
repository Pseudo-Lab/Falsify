"""Tests for the cleanroom arena round runner and the answer-key-free distiller.

Fixtures are built in-process: a synthetic PDF (pymupdf when available, raw bytes
otherwise) and a fake stdio agent that speaks ``falsify.harness-invocation.v1`` in
and ``falsify.blue-report.v1`` out. No pytest, no skips, stdlib only.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import arena_round as mod  # noqa: E402

CLI_PATH = EVAL_DIR / 'arena_round.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'

try:
    import pymupdf  # type: ignore
except ImportError:
    pymupdf = None

FAKE_AGENT = '''"""Fake stdio BLUE agent: ``fake_agent.py MODE [PROBE_OUT] [STATE] [MARKER]``."""
import json
import os
import sys
import time

MODE = sys.argv[1] if len(sys.argv) > 1 else 'happy'
PROBE_OUT = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '-' else None
STATE = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != '-' else None
MARKER = sys.argv[4] if len(sys.argv) > 4 else ''

raw = sys.stdin.buffer.read()
try:
    payload = json.loads(raw.decode('utf-8'))
except Exception:
    payload = {}

if PROBE_OUT:
    probe = {
        'cwd': os.getcwd(),
        'entries': sorted(os.listdir('.')),
        'envHits': sorted(key for key, value in os.environ.items() if MARKER and MARKER in str(value)),
        'invocationSchema': payload.get('schema'),
        'role': payload.get('role'),
        'findingSlots': len((payload.get('outputSchema') or {}).get('properties', {})),
        'callIndex': payload.get('call'),
    }
    with open(PROBE_OUT, 'w', encoding='utf-8') as handle:
        json.dump(probe, handle)

if MODE == 'sleep':
    time.sleep(30)
if MODE == 'crash':
    sys.exit(7)

NUM = {'id': 'f-num', 'decision': 'defect', 'pageIndex': 0,
       'quote': 'Overall mortality was 14.2% in the intervention arm.'}
FP = {'id': 'f-fp', 'decision': 'defect', 'pageIndex': 9,
      'quote': 'Unrelated hallucinated inconsistency in the appendix narrative section.'}
TAB = {'id': 'f-tab', 'decision': 'defect', 'pageIndex': 2, 'itemId': 'table-2',
       'quote': 'The primary outcome label differs from the registered outcome.'}

if MODE == 'flip':
    seen = 0
    if STATE and os.path.exists(STATE):
        with open(STATE, encoding='utf-8') as handle:
            seen = int(handle.read().strip() or '0')
    if STATE:
        with open(STATE, 'w', encoding='utf-8') as handle:
            handle.write(str(seen + 1))
    findings = [NUM, TAB] if seen == 0 else [NUM]
elif MODE == 'happy':
    findings = [NUM, FP]
else:
    findings = [NUM]

print(json.dumps({'schema': 'falsify.blue-report.v1', 'findings': findings}))
'''

GOLD = {
    'defects': [
        {
            'defectId': 'g-num',
            'world': 'W1',
            'family': 'D1',
            'difficulty': 'L1',
            'pageIndex': 0,
            'after': 'Overall mortality was 14.2% in the intervention arm.',
            'stealthStatus': 'detectable_artifact',
        },
        {
            'defectId': 'g-cite',
            'world': 'W2',
            'family': 'D2',
            'difficulty': 'L2',
            'pageIndex': 1,
            'after': 'The inline citation link disagrees with the reference list entry.',
            'stealthPass': True,
        },
        {
            'defectId': 'g-table',
            'world': 'W3',
            'family': 'D4-1',
            'difficulty': 'L3',
            'pageIndex': 2,
            'itemId': 'table-2',
            'after': 'The primary outcome label differs from the registered outcome.',
            'stealthPass': True,
        },
    ],
}

CRAFTED_QUOTE = 'The appendix reports a different denominator than the main table.'


def _raw_pdf_bytes(title: str) -> bytes:
    parts = [
        b'%PDF-1.4\n',
        b'1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
        b'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
        b'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n',
        f'4 0 obj << /Title ({title}) /Author (Trial Consortium) >> endobj\n'.encode('utf-8'),
        b'trailer << /Root 1 0 R /Info 4 0 R >>\n%%EOF\n',
    ]
    return b''.join(parts)


def _pdf_bytes(title: str = 'Clean Clinical Trial') -> bytes:
    if pymupdf is None:
        return _raw_pdf_bytes(title)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), 'Clinical outcome report body text.')
    doc.set_metadata({'title': title, 'author': 'Trial Consortium'})
    raw = doc.tobytes()
    doc.close()
    return raw


def _write_agent(root: Path) -> Path:
    path = root / 'fake_agent.py'
    path.write_text(FAKE_AGENT, encoding='utf-8')
    return path


def _crafted_record(family: str, difficulty: str, world: str, defect_id: str, gold: dict) -> dict:
    evaluation = {
        'schema': 'falsify.arena-evaluation.v1',
        'goldCount': 1,
        'runCount': 1,
        'baselineSignalCount': 0,
        'runs': [{
            'runId': 'r1',
            'agentId': 'fake',
            'tp': 0,
            'fn': 1,
            'pureFp': 0,
            'preExistingExempted': 0,
            'abstainedCount': 0,
            'matchedPairs': [],
            'missedDefectIds': [defect_id],
            'uncertainMatchedDefectIds': [],
        }],
        'aggregate': {
            'tp': 0, 'fn': 1, 'pureFp': 0, 'preExistingExempted': 0, 'abstainedCount': 0,
            'recall': 0.0, 'precision': None, 'stealthYield': None,
        },
        'feedbackDigest': {
            'evadedGoldDefectIds': [defect_id], 'pureFalsePositives': [], 'triviallyCaughtDefectIds': [],
        },
    }
    return {
        'schema': mod.ROUND_SCHEMA,
        'ok': True,
        'roundId': 'round-crafted',
        'finishedAt': '2026-11-16T00:00:00Z',
        'evaluation': evaluation,
        'gold': gold,
        'family': family,
        'difficulty': difficulty,
        'world': world,
    }


class RoundRunnerTests(unittest.TestCase):
    def test_happy_path_scores_runs_and_feedback_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = _write_agent(Path(tmp))
            record = mod.run_round(
                _pdf_bytes(),
                [sys.executable, str(agent), 'happy'],
                gold_ledger=GOLD,
                run_id='round-happy',
            )
        self.assertEqual(record['schema'], mod.ROUND_SCHEMA)
        self.assertTrue(record['ok'], record.get('error'))
        self.assertEqual(record['roundId'], 'round-happy')
        self.assertEqual(record['runCount'], 1)
        run = record['runs'][0]
        self.assertEqual(run['exitCode'], 0)
        self.assertEqual(run['findingCount'], 2)
        self.assertEqual(run['agentId'], Path(sys.executable).name)
        self.assertEqual(len(run['stdoutSha256']), 64)
        self.assertGreaterEqual(run['durationMs'], 0)
        scored = record['evaluation']['runs'][0]
        self.assertEqual((scored['tp'], scored['fn'], scored['pureFp']), (1, 2, 1))
        digest = record['evaluation']['feedbackDigest']
        self.assertEqual(digest['triviallyCaughtDefectIds'], ['g-num'])
        self.assertEqual(digest['evadedGoldDefectIds'], ['g-cite', 'g-table'])
        self.assertEqual(len(digest['pureFalsePositives']), 1)
        self.assertEqual(record['leaks'], [])
        self.assertFalse(record['isolation']['osSandbox'])
        self.assertIn('Not an OS sandbox', record['isolation']['notice'])
        self.assertEqual(record['adapter']['argvShape'], [3])
        self.assertFalse(record['cleanroomRetained'])
        self.assertEqual(len(record['harnessHash']), 64)

    def test_cleanroom_holds_only_blind_bytes_and_drops_gold_environment(self):
        marker = 'probe7a1c'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent = _write_agent(root)
            probe_path = root / 'probe.json'
            gold_path = root / 'gold.json'
            gold_path.write_text(json.dumps(GOLD), encoding='utf-8')
            os.environ['FALSIFY_GOLD_LEDGER_PATH'] = f'{marker}:{gold_path}'
            try:
                record = mod.run_round(
                    _pdf_bytes(),
                    [sys.executable, str(agent), 'happy', str(probe_path), '-', marker],
                    gold_ledger=GOLD,
                    blind_supplements=[{'name': 'Table_S1.csv', 'text': 'arm,n\nA,10\nB,12\n'}],
                )
            finally:
                os.environ.pop('FALSIFY_GOLD_LEDGER_PATH', None)
            probe = json.loads(probe_path.read_text(encoding='utf-8'))
            rendered = json.dumps(record)
            cleanroom = Path(probe['cwd'])
            self.assertFalse(str(cleanroom).startswith(str(root)))
            self.assertNotIn(str(cleanroom), rendered)
            self.assertNotIn(str(root), rendered)
            self.assertTrue(record['ok'], record.get('error'))
        self.assertEqual(probe['entries'], ['blind.pdf', 'supplements'])
        self.assertEqual(probe['envHits'], [])
        self.assertEqual(probe['invocationSchema'], 'falsify.harness-invocation.v1')
        self.assertEqual(probe['role'], 'blue')
        self.assertEqual(probe['callIndex'], 1)
        self.assertEqual(record['isolation']['filesWritten'], ['blind.pdf', 'supplements/Table_S1.csv'])
        self.assertFalse(record['isolation']['osSandbox'])

    def test_blind_leak_blocks_the_agent_and_returns_exit_3(self):
        leaked = _pdf_bytes(title='Leaked falsify red-plan copy')
        record = mod.run_round(leaked, ['definitely-missing-agent-binary-xyz'])
        self.assertFalse(record['ok'])
        self.assertEqual(record['error'], 'blindness_leak_detected')
        self.assertEqual(record['runCount'], 0)
        self.assertEqual(record['runs'], [])
        self.assertIsNone(record['evaluation'])
        self.assertFalse(record['blindVerification']['blindClean'])
        self.assertTrue(record['leaks'])
        self.assertFalse(record['cleanroomRetained'])
        self.assertEqual(mod._error_exit('blindness_leak_detected'), 3)
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / 'leaked.pdf'
            pdf_path.write_bytes(leaked)
            proc = subprocess.run(
                [sys.executable, str(CLI_PATH), 'run-round', '--pdf', str(pdf_path),
                 '--agent-cmd', 'definitely-missing-agent-binary-xyz'],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc.returncode, 3)
            self.assertEqual(json.loads(proc.stdout)['error'], 'blindness_leak_detected')

    def test_timeout_maps_to_124_and_process_exit_to_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = _write_agent(Path(tmp))
            timed_out = mod.run_round(_pdf_bytes(), [sys.executable, str(agent), 'sleep'], timeout=1)
            crashed = mod.run_round(_pdf_bytes(), [sys.executable, str(agent), 'crash'])
        self.assertFalse(timed_out['ok'])
        self.assertEqual(timed_out['error'], 'timeout')
        self.assertEqual(mod._error_exit('timeout'), 124)
        self.assertEqual(timed_out['runs'], [])
        self.assertFalse(crashed['ok'])
        self.assertEqual(crashed['error'], 'process_exit')
        self.assertEqual(mod._error_exit('process_exit'), 2)
        self.assertTrue(crashed['evaluation'] is None)

    def test_injected_adapter_receives_env_allow_and_skips_gold_scoring(self):
        seen = {}

        def adapter(argv, payload, cwd, stdout_path, env_allow=None):
            seen['env'] = env_allow
            seen['entries'] = sorted(os.listdir(cwd))
            seen['payload'] = json.loads(payload)
            seen['stdoutPath'] = Path(stdout_path).exists()
            return json.dumps({'schema': 'falsify.blue-report.v1', 'findings': []}).encode('utf-8')

        record = mod.run_round(
            _pdf_bytes(), ['fake-agent', '--flag'], adapter=adapter, runs=2, env_allow=['MY_ROUND_FLAG'],
        )
        self.assertTrue(record['ok'], record.get('error'))
        self.assertEqual(record['warning'], 'gold_ledger_absent')
        self.assertIsNone(record['evaluation'])
        self.assertEqual(record['adapter']['type'], 'stdio-injected')
        self.assertEqual(record['isolation']['envAllowRequested'], ['MY_ROUND_FLAG'])
        self.assertEqual(seen['env'], ('MY_ROUND_FLAG',))
        self.assertEqual(seen['entries'], ['blind.pdf'])
        self.assertEqual(seen['payload']['schema'], 'falsify.harness-invocation.v1')
        self.assertEqual(seen['payload']['maxCalls'], 2)
        self.assertEqual(seen['payload']['call'], 2)
        self.assertFalse(seen['stdoutPath'])
        with self.assertRaises(mod.ArenaRoundError) as caught:
            mod.run_round(_pdf_bytes(), ['fake-agent'], env_allow=['MY_ROUND_FLAG'])
        self.assertEqual(caught.exception.code, 'env_allow_unsupported')
        self.assertEqual(caught.exception.exit_code, 2)


class DistillTests(unittest.TestCase):
    def _round_with_flip(self, root: Path) -> dict:
        agent = _write_agent(root)
        return mod.run_round(
            _pdf_bytes(),
            [sys.executable, str(agent), 'flip', '-', str(root / 'state.txt')],
            gold_ledger=GOLD,
            runs=2,
            run_id='round-flip',
        )

    def test_two_runs_produce_flip_rules_and_escalation_briefs(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = self._round_with_flip(Path(tmp))
        self.assertTrue(record['ok'], record.get('error'))
        self.assertEqual(record['runCount'], 2)
        patch = mod.distill_round(record, gold_ledger=GOLD)
        self.assertEqual(patch['schema'], mod.PATCH_SCHEMA)
        self.assertEqual(patch['basedOnRoundId'], 'round-flip')
        self.assertEqual(patch['source'], mod.ROUND_SCHEMA)
        self.assertTrue(patch['scrubbed'])
        self.assertTrue(patch['answerKeyFree'])
        self.assertEqual(patch['summary']['flipUnion'], 1)
        self.assertEqual(patch['summary']['missedUnion'], 1)
        self.assertEqual(patch['summary']['earlyRedCount'], 1)
        classes = {rule['failureClass'] for rule in patch['rules']}
        self.assertIn('flip', classes)
        self.assertIn('early_red', classes)
        self.assertIn('fn', classes)
        self.assertIn('D4-1', {rule.get('family') for rule in patch['rules']})
        self.assertIn('L1 → L2 → L3 → L4', patch['redBrief']['instructionsText'])
        blue_text = patch['blueBrief']['instructionsText']
        self.assertIn('미탐 1건', blue_text)
        self.assertIn('순수 오탐 0건', blue_text)
        self.assertIn('Zero-Drop 복구 0건', blue_text)
        self.assertTrue(patch['patchId'].startswith('patch-'))
        self.assertEqual(patch['generatedAt'], record['finishedAt'])

    def test_distill_is_byte_identical_for_identical_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = self._round_with_flip(Path(tmp))
        first = json.dumps(mod.distill_round(record, gold_ledger=GOLD), ensure_ascii=False)
        second = json.dumps(mod.distill_round(record, gold_ledger=GOLD), ensure_ascii=False)
        self.assertEqual(first, second)

    def test_max_rules_caps_and_ordering_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            record = self._round_with_flip(Path(tmp))
        capped = mod.distill_round(record, gold_ledger=GOLD, max_rules=2)
        self.assertEqual(len(capped['rules']), 2)
        keys = [(rule.get('family') or '', rule['failureClass'], rule['ruleId']) for rule in capped['rules']]
        self.assertEqual(keys, sorted(keys))
        with self.assertRaises(mod.ArenaRoundError) as caught:
            mod.distill_round(record, gold_ledger=GOLD, max_rules=0)
        self.assertEqual(caught.exception.code, 'max_rules_invalid')

    def test_scrubber_fails_closed_on_leaked_material(self):
        cases = [
            ('answer-key literal', 'D1 Treatment reduced mortality', 'L1', 'W1', 'g-x'),
            ('p-value', 'D1', 'L2 p = 0.08', 'W2', 'g-x'),
            ('doi', 'D3 10.1000/xyz.123', 'L3', 'W3', 'g-x'),
            ('quote', 'D1 ' + CRAFTED_QUOTE, 'L1', 'W1', 'g-x'),
            ('defect id as code', 'D1', 'L1', 'g-77', 'g-77'),
        ]
        for label, family, difficulty, world, defect_id in cases:
            gold = {'defects': [{
                'defectId': defect_id, 'family': family, 'difficulty': difficulty, 'world': world,
                'after': CRAFTED_QUOTE,
            }]}
            record = _crafted_record(family, difficulty, world, defect_id, gold)
            with self.subTest(label=label):
                with self.assertRaises(mod.DistillScrubError) as caught:
                    mod.distill_round(record, gold_ledger=gold)
                self.assertEqual(caught.exception.code, 'distill_scrub_failed')
                self.assertTrue(caught.exception.hits)

    def test_scrub_failure_exits_3_without_a_patch(self):
        gold = {'defects': [{
            'defectId': 'g-x', 'family': 'D1 Treatment reduced mortality', 'difficulty': 'L1',
            'world': 'W1', 'after': CRAFTED_QUOTE,
        }]}
        record = _crafted_record('D1 Treatment reduced mortality', 'L1', 'W1', 'g-x', gold)
        with tempfile.TemporaryDirectory() as tmp:
            round_path = Path(tmp) / 'round.json'
            gold_path = Path(tmp) / 'gold.json'
            round_path.write_text(json.dumps(record), encoding='utf-8')
            gold_path.write_text(json.dumps(gold), encoding='utf-8')
            proc = subprocess.run(
                [sys.executable, str(CLI_PATH), 'distill', '--round', str(round_path), '--gold', str(gold_path)],
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(proc.returncode, 3)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload['error'], 'distill_scrub_failed')
        self.assertNotIn('rules', payload)
        self.assertNotIn('redBrief', payload)

    def test_scored_round_without_gold_cannot_be_distilled(self):
        with tempfile.TemporaryDirectory() as tmp:
            agent = _write_agent(Path(tmp))
            record = mod.run_round(_pdf_bytes(), [sys.executable, str(agent), 'happy'])
        self.assertEqual(record['warning'], 'gold_ledger_absent')
        with self.assertRaises(mod.ArenaRoundError) as caught:
            mod.distill_round(record)
        self.assertEqual(caught.exception.code, 'evaluation_absent')


class CliTests(unittest.TestCase):
    def test_help_exits_zero_for_root_and_subcommands(self):
        for args in (['--help'], ['run-round', '--help'], ['distill', '--help']):
            with self.subTest(args=args):
                proc = subprocess.run(
                    [sys.executable, str(CLI_PATH), *args], capture_output=True, text=True, check=False,
                )
                self.assertEqual(proc.returncode, 0)
                self.assertIn('usage:', proc.stdout)

    def test_cli_run_round_then_distill_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent = _write_agent(root)
            pdf_path = root / 'blind.pdf'
            gold_path = root / 'gold.json'
            round_path = root / 'round.json'
            patch_path = root / 'patch.json'
            pdf_path.write_bytes(_pdf_bytes())
            gold_path.write_text(json.dumps(GOLD), encoding='utf-8')
            run_proc = subprocess.run(
                [sys.executable, str(CLI_PATH), 'run-round', '--pdf', str(pdf_path), '--gold', str(gold_path),
                 '--agent-cmd', sys.executable, '--agent-arg', str(agent), 'happy',
                 '--runs', '1', '--timeout', '60', '--out', str(round_path)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(run_proc.returncode, 0, run_proc.stderr)
            record = json.loads(run_proc.stdout)
            self.assertEqual(record['schema'], mod.ROUND_SCHEMA)
            self.assertTrue(record['ok'])
            self.assertEqual(json.loads(round_path.read_text(encoding='utf-8'))['roundId'], record['roundId'])
            dist_proc = subprocess.run(
                [sys.executable, str(CLI_PATH), 'distill', '--round', str(round_path), '--gold', str(gold_path),
                 '--out', str(patch_path)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(dist_proc.returncode, 0, dist_proc.stderr)
            patch = json.loads(dist_proc.stdout)
            self.assertEqual(patch['schema'], mod.PATCH_SCHEMA)
            self.assertEqual(json.loads(patch_path.read_text(encoding='utf-8'))['patchId'], patch['patchId'])

    def test_cli_run_round_without_gold_warns_and_cli_timeout_is_124(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent = _write_agent(root)
            pdf_path = root / 'blind.pdf'
            pdf_path.write_bytes(_pdf_bytes())
            no_gold = subprocess.run(
                [sys.executable, str(CLI_PATH), 'run-round', '--pdf', str(pdf_path),
                 '--agent-cmd', sys.executable, '--agent-arg', str(agent), 'happy'],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(no_gold.returncode, 0, no_gold.stderr)
            payload = json.loads(no_gold.stdout)
            self.assertIsNone(payload['evaluation'])
            self.assertEqual(payload['warning'], 'gold_ledger_absent')
            timed_out = subprocess.run(
                [sys.executable, str(CLI_PATH), 'run-round', '--pdf', str(pdf_path),
                 '--agent-cmd', sys.executable, '--agent-arg', str(agent), 'sleep', '--timeout', '1'],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(timed_out.returncode, 124)
            self.assertEqual(json.loads(timed_out.stdout)['error'], 'timeout')


class ComplexityGateTests(unittest.TestCase):
    def test_arena_round_ccn_within_gate(self):
        source = CLI_PATH.read_bytes()
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source, capture_output=True, check=True,
        )
        functions = json.loads(proc.stdout.decode('utf-8'))
        violations = [fn for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])
        self.assertGreater(len(functions), 20)


if __name__ == '__main__':
    unittest.main()

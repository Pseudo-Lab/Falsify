"""Tests for the rollback-safe multi-generation co-evolution campaign.

Fixtures are in-process synthetic records plus one subprocess CLI. No pytest.
"""
from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import pymupdf

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import arena_campaign as mod  # noqa: E402
import arena_duel  # noqa: E402
import arena_round  # noqa: E402

PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
PDF = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
QUOTE = 'Mortality stayed stable across both study arms.'

RED_SCRIPT = '''import json
import pathlib
import sys
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
root = pathlib.Path.cwd()
raw = (root / payload["sourcePdf"]).read_bytes()
(root / payload["outPdf"]).write_bytes(raw)
gold = {
    "schema": "falsify.red-gold-ledger.v1",
    "defects": [{
        "defectId": "g-cli",
        "world": "W1",
        "family": "D1",
        "difficulty": "L3",
        "pageIndex": 0,
        "after": "Mortality stayed stable across both study arms.",
        "stealthPass": True,
    }],
}
(root / payload["outGold"]).write_text(json.dumps(gold), encoding="utf-8")
'''

BLUE_SCRIPT = '''import json
print(json.dumps({
    "schema": "falsify.blue-report.v1",
    "findings": [{
        "id": "f-cli",
        "decision": "defect",
        "pageIndex": 0,
        "quote": "Mortality stayed stable across both study arms.",
    }],
}))
'''


def _pdf(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), text)
    doc.set_metadata({'title': 'Clean Clinical Trial', 'author': 'Trial Consortium'})
    raw = doc.tobytes()
    doc.close()
    return raw


def _base() -> dict:
    return {
        'schema': 'falsify.harness.v1',
        'id': 'harness-blue',
        'role': 'blue',
        'instructions': 'Review only the blind bundle.',
        'generation': 0,
        'appliedRuleIds': [],
        'appliedPatches': [],
    }


def _patch(rule_id: str, statement: str, patch_id: str) -> dict:
    return {
        'schema': 'falsify.harness-patch.v1',
        'patchId': patch_id,
        'generatedAt': '2026-11-16T00:00:00Z',
        'basedOnRoundId': 'round-1',
        'source': 'falsify.arena-round.v1',
        'summary': {'axes': {'family': {'D1': {'total': 1, 'missed': 1}}}},
        'rules': [{
            'ruleId': rule_id,
            'failureClass': 'missed',
            'family': 'D1',
            'surface': 'TEXT',
            'statement': statement,
            'procedure': ['Recompute the reported total from the source table.'],
            'rationale': 'Missed numeric defects need a second pass.',
        }],
        'redBrief': {
            'title': 'RED brief',
            'summary': 'Observe missed numeric checks.',
            'rules': [statement],
            'instructionsText': '[RED Co-Evolution Brief]\n' + statement,
        },
        'blueBrief': {
            'title': 'BLUE brief',
            'summary': 'Observe missed numeric checks.',
            'rules': [statement],
            'instructionsText': '[BLUE Co-Evolution Brief]\n' + statement,
        },
        'scrubbed': True,
        'answerKeyFree': True,
    }


def _duel(patch: dict, holdout_fp: int) -> dict:
    return {
        'schema': 'falsify.arena-duel.v1',
        'ok': True,
        'harnessPatch': patch,
        'holdoutSummary': {'paperCount': 0, 'totalPureFp': holdout_fp},
    }


def _report(recall: float, holdout_fp: int, aurc: float) -> dict:
    return {
        'schema': 'falsify.benchmark-report.v1',
        'goldSummary': {
            'recall': recall,
            'layer0Recall': recall,
            'semanticRecall': recall,
            'stealthYield': None,
            'selective': {'aurc': aurc},
        },
        'holdoutSummary': {'totalPureFp': holdout_fp},
    }


def _run(generations, duel_fn, benchmark_fn, **kwargs):
    params = {
        'base_harness': _base(),
        'red_argv': ['red-agent'],
        'blue_argv': ['blue-agent'],
        'generations': generations,
        'duel_fn': duel_fn,
        'benchmark_fn': benchmark_fn,
    }
    params.update(kwargs)
    return mod.run_evolution_campaign([PDF], **params)


class GenerationCapTests(unittest.TestCase):
    def test_generations_hard_cap_and_input_contract(self):
        for value in (0, 4, -1, True, False):
            with self.assertRaises(mod.ArenaCampaignError) as caught:
                _run(value, lambda *_args: {}, lambda *_args: {})
            self.assertEqual(caught.exception.code, 'max_generations_invalid')
            self.assertEqual(caught.exception.exit_code, 2)

        with self.assertRaises(mod.ArenaCampaignError) as role:
            _run(1, lambda *_args: {}, lambda *_args: {}, role='judge')
        self.assertEqual(role.exception.code, 'role_invalid')
        self.assertEqual(role.exception.exit_code, 2)

        with self.assertRaises(mod.ArenaCampaignError) as empty:
            mod.run_evolution_campaign(
                [],
                base_harness=_base(),
                red_argv=['red-agent'],
                blue_argv=['blue-agent'],
                generations=1,
                duel_fn=lambda *_args: {},
                benchmark_fn=lambda *_args: {},
            )
        self.assertEqual(empty.exception.code, 'source_pdfs_invalid')

        seen = {}

        def duel_fn(source, generation, harness):
            del generation, harness
            seen['name'] = source['name']
            seen['prefix'] = source['bytes'][:5]
            return _duel(_patch('rule-dict', 'Recheck numeric totals against the registered outcome.', 'patch-dict'), 0)

        lineage = mod.run_evolution_campaign(
            [{'name': 'cohort', 'bytes': PDF, 'supplements': []}],
            base_harness=_base(),
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            generations=1,
            duel_fn=duel_fn,
            benchmark_fn=lambda generation, harness: _report(0.4 if generation == 0 else 0.5, 0, 0.2),
        )
        self.assertEqual(seen['name'], 'cohort')
        self.assertEqual(seen['prefix'], b'%PDF-')
        self.assertEqual(lineage['generations'][1]['status'], 'promoted')


class PromotionTests(unittest.TestCase):
    def test_promotes_gen1_and_gen3_while_gen2_holdout_rolls_back(self):
        seen = []

        def duel_fn(source, generation, harness):
            del source
            seen.append((generation, harness['generation'], list(harness['appliedRuleIds'])))
            if generation == 2:
                patch = _patch('rule-gen2', 'Recheck the second numeric pass against the table.', 'patch-gen2')
                return _duel(patch, 5)
            rule_id = 'rule-gen1' if generation == 1 else 'rule-gen3'
            statement = {
                1: 'Recheck numeric totals against the registered outcome.',
                3: 'Recheck direction words against the methods section.',
            }[generation]
            return _duel(_patch(rule_id, statement, 'patch-' + rule_id), 0)

        def benchmark_fn(generation, harness):
            del harness
            recalls = {0: 0.40, 1: 0.55, 3: 0.80}
            return _report(recalls[generation], 0, 0.30)

        lineage = _run(3, duel_fn, benchmark_fn)
        statuses = [row['status'] for row in lineage['generations']]
        self.assertEqual(statuses, ['baseline', 'promoted', 'rolled_back', 'promoted'])
        self.assertEqual(lineage['generations'][2]['rollbackReason'], 'holdout_fp_regression')
        self.assertEqual(lineage['generations'][2]['harnessSha256'], lineage['generations'][1]['harnessSha256'])
        final = lineage['finalHarness']
        self.assertEqual(final['generation'], 2)
        self.assertEqual(final['appliedRuleIds'], ['rule-gen1', 'rule-gen3'])
        self.assertNotIn('rule-gen2', final['instructions'])
        self.assertIn('Recheck numeric totals', final['instructions'])
        self.assertIn('Recheck direction words', final['instructions'])
        self.assertEqual(seen[2][1], 1)
        self.assertEqual(seen[2][2], ['rule-gen1'])
        arena_round._scrub(lineage, [], set())


class RegressionTests(unittest.TestCase):
    def test_benchmark_and_distill_failures_roll_back_without_crashing(self):
        def duel_fn(source, generation, harness):
            del source, harness
            if generation == 3:
                raise arena_duel.ArenaDuelError('distill_scrub_failed', 3, {'hitCount': 1})
            return _duel(
                _patch(f'rule-g{generation}', 'Recheck numeric totals against the registered outcome.', f'patch-g{generation}'),
                0,
            )

        def benchmark_fn(generation, harness):
            del harness
            if generation == 0:
                return _report(0.80, 0, 0.20)
            if generation == 1:
                return _report(0.10, 0, 0.20)
            return _report(0.80, 4, 0.20)

        lineage = _run(3, duel_fn, benchmark_fn)
        reasons = [row.get('rollbackReason') for row in lineage['generations'][1:]]
        self.assertEqual(reasons, [
            'benchmark_regression:recall_drop',
            'benchmark_regression:holdout_pure_fp_increase',
            'distill_scrub_failed',
        ])
        self.assertEqual(lineage['finalHarness']['generation'], 0)
        self.assertEqual(lineage['finalHarness']['appliedRuleIds'], [])
        self.assertTrue(lineage['ok'])


class BlindnessTests(unittest.TestCase):
    def test_blindness_aborts_immediately(self):
        calls = []

        def duel_fn(source, generation, harness):
            del source, harness
            calls.append(generation)
            raise arena_duel.ArenaDuelError('blindness_leak_detected', 3, {'marker': 'stop'})

        with self.assertRaises(mod.ArenaCampaignError) as caught:
            _run(3, duel_fn, lambda generation, harness: _report(0.5, 0, 0.2))
        self.assertEqual(caught.exception.code, 'blindness_leak_detected')
        self.assertEqual(caught.exception.exit_code, 3)
        self.assertEqual(caught.exception.extra['marker'], 'stop')
        self.assertEqual(calls, [1])


class ParetoTests(unittest.TestCase):
    def test_pareto_frontier_and_lineage_scrub(self):
        points = {
            0: (0.90, 5, 0.10),
            1: (0.40, 0, 0.20),
            2: (0.20, 9, 0.80),
            3: (0.85, 5, 0.05),
        }

        def duel_fn(source, generation, harness):
            del source, harness
            return _duel(
                _patch(f'rule-p{generation}', 'Recheck numeric totals against the registered outcome.', f'patch-p{generation}'),
                0,
            )

        def benchmark_fn(generation, harness):
            del harness
            recall, holdout_fp, aurc = points[generation]
            return _report(recall, holdout_fp, aurc)

        lineage = _run(3, duel_fn, benchmark_fn)
        self.assertEqual(lineage['schema'], mod.CAMPAIGN_SCHEMA)
        self.assertTrue(lineage['answerKeyFree'])
        self.assertTrue(lineage['scrubbed'])
        frontier = {point['generation'] for point in lineage['paretoFrontier']}
        self.assertEqual(frontier, {0, 1, 3})
        self.assertEqual(lineage['generations'][0]['metrics']['recall'], 0.90)
        self.assertEqual(lineage['generations'][0]['metrics']['layer0Recall'], 0.90)
        self.assertEqual(lineage['generations'][0]['metrics']['semanticRecall'], 0.90)
        self.assertEqual(lineage['generations'][0]['metrics']['holdoutPureFp'], 5)
        self.assertEqual(lineage['generations'][0]['metrics']['aurc'], 0.10)
        self.assertIn('stealthYield', lineage['generations'][0]['metrics'])
        arena_round._scrub(lineage, [], set())
        rendered = json.dumps(lineage)
        self.assertNotIn('gold_ledger', rendered)
        self.assertNotIn('answer-key', rendered)


class CliTests(unittest.TestCase):
    def test_main_rejects_generation_cap(self):
        with redirect_stdout(io.StringIO()):
            code = mod.main(['--source-pdf', 'unused.pdf', '--generations', '4'])
        self.assertEqual(code, 2)

    def test_subprocess_cli_completes_one_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.pdf'
            source.write_bytes(_pdf(QUOTE))
            red = root / 'red_agent.py'
            blue = root / 'blue_agent.py'
            red.write_text(RED_SCRIPT, encoding='utf-8')
            blue.write_text(BLUE_SCRIPT, encoding='utf-8')
            out = root / 'lineage.json'
            harness = root / 'harness.json'
            invalid = subprocess.run(
                [sys.executable, str(EVAL_DIR / 'arena_campaign.py'), '--source-pdf', str(source), '--generations', '9'],
                capture_output=True,
                cwd=str(REPO_ROOT),
                check=False,
            )
            invalid_err = invalid.stderr.decode('utf-8', errors='replace')
            self.assertEqual(invalid.returncode, 2, invalid_err)
            proc = subprocess.run(
                [
                    sys.executable, str(EVAL_DIR / 'arena_campaign.py'),
                    '--source-pdf', str(source),
                    '--red-cmd', sys.executable, '--red-arg', str(red),
                    '--blue-cmd', sys.executable, '--blue-arg', str(blue),
                    '--generations', '1',
                    '--min-difficulty', 'L3',
                    '--out', str(out),
                    '--out-harness', str(harness),
                ],
                capture_output=True,
                cwd=str(REPO_ROOT),
                check=False,
            )
            stdout = proc.stdout.decode('utf-8', errors='replace')
            stderr = proc.stderr.decode('utf-8', errors='replace')
            self.assertEqual(proc.returncode, 0, stderr + stdout[:800])
            payload = json.loads(stdout)
            self.assertEqual(payload['schema'], mod.CAMPAIGN_SCHEMA)
            self.assertTrue(payload['ok'])
            self.assertEqual(payload['generations'][1]['status'], 'promoted')
            self.assertEqual(payload['finalHarness']['generation'], 1)
            saved = json.loads(out.read_text(encoding='utf-8'))
            saved_harness = json.loads(harness.read_text(encoding='utf-8'))
            self.assertEqual(saved['finalHarnessSha256'], payload['finalHarnessSha256'])
            self.assertEqual(saved_harness['generation'], 1)


class ComplexityGateTests(unittest.TestCase):
    def test_arena_campaign_ccn_within_gate(self):
        source = (EVAL_DIR / 'arena_campaign.py').read_bytes()
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source,
            capture_output=True,
            check=True,
        )
        functions = json.loads(proc.stdout.decode('utf-8'))
        violations = [f"{fn['id']}:{fn['ccn']}" for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])
        self.assertGreater(len(functions), 20)


if __name__ == '__main__':
    unittest.main()

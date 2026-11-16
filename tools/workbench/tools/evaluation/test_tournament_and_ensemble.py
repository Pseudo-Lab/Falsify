"""Tournament ratings, BLUE ensemble arbitration, and campaign checkpoints.

Stdlib unittest only. Duel and benchmark calls are in-process fakes.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import pymupdf

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import arena_campaign as campaign  # noqa: E402
import arena_round  # noqa: E402
import arena_tournament as tournament  # noqa: E402
import blue_ensemble as ensemble  # noqa: E402

PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
PDF = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
QUOTE = 'Mortality stayed stable across both study arms.'
MISSING = 'Fabricated claim missing from every page of this paper.'
_FORBIDDEN = ('before', 'after', 'gold', 'goldLedger', 'why_hard', 'candidateRationales', 'quote')


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


def _patch(rule_id: str, patch_id: str) -> dict:
    statement = 'Recheck numeric totals against the registered outcome.'
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


def _duel(generation: int) -> dict:
    return {
        'schema': 'falsify.arena-duel.v1',
        'ok': True,
        'harnessPatch': _patch(f'rule-g{generation}', f'patch-g{generation}'),
        'holdoutSummary': {'paperCount': 0, 'totalPureFp': 0},
    }


def _report(recall: float) -> dict:
    return {
        'schema': 'falsify.benchmark-report.v1',
        'goldSummary': {
            'recall': recall,
            'layer0Recall': recall,
            'semanticRecall': recall,
            'stealthYield': None,
            'selective': {'aurc': 0.2},
        },
        'holdoutSummary': {'totalPureFp': 0},
    }


def _keys(node, found: list[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            found.append(str(key))
            _keys(value, found)
        return
    if isinstance(node, list):
        for item in node:
            _keys(item, found)


def _ccn(path: Path) -> list[dict]:
    proc = subprocess.run(
        [sys.executable, str(PY_CCN_PATH)],
        input=path.read_bytes(),
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout.decode('utf-8'))


class BradleyTerryEloTests(unittest.TestCase):
    def test_order_invariance_tie_and_undefeated(self):
        ids = ['A', 'B', 'C']
        matchups = [
            {'a': 'A', 'b': 'B', 'scoreA': 1.0},
            {'a': 'A', 'b': 'C', 'scoreA': 1.0},
            {'a': 'B', 'b': 'C', 'scoreA': 0.25},
        ]
        forward = tournament.compute_bradley_terry_and_elo(matchups, ids)
        backward = tournament.compute_bradley_terry_and_elo(list(reversed(matchups)), ['C', 'A', 'B'])
        flipped = [
            {'a': item['b'], 'b': item['a'], 'scoreA': 1.0 - item['scoreA']}
            for item in matchups
        ]
        mirror = tournament.compute_bradley_terry_and_elo(flipped, ids)
        self.assertEqual(forward['elo'], backward['elo'])
        self.assertEqual(forward['bradleyTerry'], backward['bradleyTerry'])
        self.assertEqual(forward['elo'], mirror['elo'])
        self.assertEqual(forward['bradleyTerry'], mirror['bradleyTerry'])

        strengths = forward['bradleyTerry']
        self.assertEqual(round(sum(strengths.values()), 6), 1.0)
        self.assertGreater(strengths['A'], strengths['B'])
        self.assertGreater(strengths['A'], strengths['C'])
        for value in strengths.values():
            self.assertGreater(value, 0.0)
            self.assertTrue(math.isfinite(value))
            self.assertEqual(value, round(value, 6))

        tied = tournament.compute_bradley_terry_and_elo(
            [{'a': 'A', 'b': 'B', 'scoreA': 0.5}],
            ['A', 'B'],
        )
        self.assertEqual(tied['bradleyTerry']['A'], tied['bradleyTerry']['B'])
        self.assertEqual(tied['elo']['A'], 1500.0)
        self.assertEqual(tied['elo']['B'], 1500.0)
        self.assertEqual(round(sum(tied['bradleyTerry'].values()), 6), 1.0)

        decisive = tournament.compute_bradley_terry_and_elo(
            [{'a': 'A', 'b': 'B', 'scoreA': 1.0}],
            ['A', 'B'],
            base_elo=1500.0,
            k_factor=32.0,
        )
        self.assertEqual(decisive['elo']['A'], 1516.0)
        self.assertEqual(decisive['elo']['B'], 1484.0)
        self.assertGreater(decisive['bradleyTerry']['A'], 0.0)
        self.assertGreater(decisive['bradleyTerry']['B'], 0.0)

    def test_invalid_matchup_rejected(self):
        with self.assertRaises(ValueError):
            tournament.compute_bradley_terry_and_elo(
                [{'a': 'A', 'b': 'B', 'scoreA': 1.4}],
                ['A', 'B'],
            )


class TournamentTests(unittest.TestCase):
    def _run(self):
        table = {
            ('red-s', 'blue-a'): (0.8, 0.7, 1, 0.2, 100),
            ('red-s', 'blue-b'): (0.2, 0.9, 0, 0.1, 10),
            ('red-s', 'blue-c'): (0.1, 0.95, 4, 0.4, 300),
            ('red-l', 'blue-a'): (1.0, 0.1, 1, 0.2, 100),
            ('red-l', 'blue-b'): (0.6, 0.2, 0, 0.1, 10),
            ('red-l', 'blue-c'): (0.3, 0.3, 4, 0.5, 300),
        }

        def duel_fn(source, red, blue):
            del source
            recall, stealth, fp, aurc, elapsed = table[(red['id'], blue['id'])]
            return {
                'recall': recall,
                'stealthYield': stealth,
                'holdoutPureFp': fp,
                'aurc': aurc,
                'elapsedMs': elapsed,
                'gold': 'SECRET-LEAK-TOKEN',
                'quote': QUOTE,
                'worldDifficulty': [
                    {'world': 'W1', 'difficulty': 'L1', 'total': 2, 'detected': 2},
                    {'world': 'W5', 'difficulty': 'L4', 'total': 4, 'detected': 1},
                ],
            }

        reds = [{'id': 'red-s', 'argv': ['red']}, {'id': 'red-l', 'argv': ['red']}]
        blues = [
            {'id': 'blue-a', 'argv': ['blue']},
            {'id': 'blue-b', 'argv': ['blue']},
            {'id': 'blue-c', 'argv': ['blue']},
        ]
        return tournament.run_arena_tournament(
            source_pdfs=['paper-a', 'paper-b'],
            red_entries=reds,
            blue_entries=blues,
            duel_fn=duel_fn,
        )

    def test_round_robin_pareto_matrix_and_scrub(self):
        result = self._run()
        self.assertEqual(result['schema'], tournament.SCHEMA)
        self.assertTrue(result['answerKeyFree'])
        self.assertTrue(result['scrubbed'])
        self.assertEqual(result['sourceCount'], 2)
        self.assertEqual(len(result['matrix']), 6)
        self.assertTrue(all(cell['paperCount'] == 2 for cell in result['matrix']))

        blues = {row['id']: row for row in result['blueLeaderboard']}
        self.assertEqual([row['id'] for row in result['blueLeaderboard']], ['blue-a', 'blue-b', 'blue-c'])
        self.assertEqual(blues['blue-a']['meanRecall'], 0.9)
        self.assertEqual(blues['blue-b']['meanRecall'], 0.4)
        self.assertEqual(blues['blue-c']['meanRecall'], 0.2)
        self.assertEqual(blues['blue-a']['totalHoldoutPureFp'], 4)
        self.assertEqual(blues['blue-b']['totalHoldoutPureFp'], 0)
        self.assertEqual(blues['blue-c']['totalHoldoutPureFp'], 16)
        self.assertTrue(blues['blue-a']['paretoOptimal'])
        self.assertTrue(blues['blue-b']['paretoOptimal'])
        self.assertFalse(blues['blue-c']['paretoOptimal'])
        self.assertGreater(blues['blue-a']['elo'], blues['blue-b']['elo'])
        self.assertGreater(blues['blue-b']['elo'], blues['blue-c']['elo'])

        reds = {row['id']: row for row in result['redLeaderboard']}
        self.assertEqual(reds['red-s']['meanEvasionRate'], 0.633333)
        self.assertEqual(reds['red-l']['meanEvasionRate'], 0.366667)
        self.assertEqual(reds['red-s']['meanStealthYield'], 0.85)
        self.assertEqual(reds['red-l']['meanStealthYield'], 0.2)
        self.assertTrue(reds['red-s']['paretoOptimal'])
        self.assertFalse(reds['red-l']['paretoOptimal'])
        self.assertGreater(reds['red-s']['elo'], reds['red-l']['elo'])
        self.assertGreater(reds['red-s']['bradleyTerry'], 0.0)

        matrix = result['worldDifficultyMatrix']
        self.assertEqual(set(matrix), set(tournament.WORLDS))
        self.assertEqual(set(matrix['W1']), set(tournament.LEVELS))
        self.assertEqual(matrix['W1']['L1'], 1.0)
        self.assertEqual(matrix['W5']['L4'], 0.25)
        self.assertIsNone(matrix['W2']['L3'])

        arena_round._scrub(result, [], set())
        rendered = json.dumps(result)
        self.assertNotIn('SECRET-LEAK-TOKEN', rendered)
        self.assertNotIn('paper-a', rendered)
        self.assertNotIn(QUOTE, rendered)
        found = []
        _keys(result, found)
        for key in _FORBIDDEN:
            self.assertNotIn(key, found)
        poison = json.loads(rendered)
        poison['gold'] = 'hidden'
        with self.assertRaises(arena_round.DistillScrubError):
            arena_round._scrub(poison, [], set())

    def test_bounds_and_argv_contract(self):
        with self.assertRaises(ValueError) as sources:
            tournament.run_arena_tournament(
                source_pdfs=[],
                red_entries=[{'id': 'red-a', 'argv': ['red']}],
                blue_entries=[{'id': 'blue-a', 'argv': ['blue']}],
                duel_fn=lambda *_args: {},
            )
        self.assertEqual(str(sources.exception), 'invalid_source_pdfs')
        with self.assertRaises(ValueError) as dupes:
            tournament.run_arena_tournament(
                source_pdfs=['paper-a'],
                red_entries=[{'id': 'same', 'argv': ['red']}],
                blue_entries=[{'id': 'same', 'argv': ['blue']}],
                duel_fn=lambda *_args: {},
            )
        self.assertEqual(str(dupes.exception), 'invalid_contender_id')
        with self.assertRaises(ValueError) as argv:
            tournament.run_arena_tournament(
                source_pdfs=['paper-a'],
                red_entries=[{'id': 'red-a', 'argv': []}],
                blue_entries=[{'id': 'blue-a', 'argv': ['blue']}],
            )
        self.assertEqual(str(argv.exception), 'invalid_argv')


def _finding(ident: str, label: str, quote: str, page: int = 0) -> dict:
    return {
        'candidateId': ident,
        'verdictLabel': label,
        'quote': quote,
        'pageIndex': page,
        'family': 'D1',
    }


class EnsembleTests(unittest.TestCase):
    def test_unanimous_split_and_alpha_modes(self):
        shared = _finding('c-shared', '아님', QUOTE)
        only = _finding('c-only', '맞음', 'Platelet counts remained within the reference interval.', 1)
        reports = [
            {'raterId': 'r1', 'findings': [shared]},
            {'raterId': 'r2', 'findings': [dict(shared)]},
            {'raterId': 'r3', 'findings': [only]},
        ]
        result = ensemble.ensemble_blue_reports(reports, rater_ids=['r1', 'r2', 'r3'])
        self.assertEqual(result['schema'], ensemble.SCHEMA)
        self.assertEqual(result['minConsensus'], 2)
        by_id = {row['id']: row for row in result['findings']}
        self.assertEqual(by_id['c-shared']['verdictLabel'], '아님')
        self.assertEqual(by_id['c-shared']['decision'], 'defect')
        self.assertTrue(by_id['c-shared']['corroborated'])
        self.assertEqual(by_id['c-shared']['voteBreakdown']['아님'], 2)
        self.assertNotIn('arbitrationReason', by_id['c-shared'])
        self.assertEqual(by_id['c-only']['decision'], 'verified_clean')
        complete = result['krippendorffAlpha']['completeUnitAlpha']
        observed = result['krippendorffAlpha']['observedPairAlpha']
        self.assertIsNotNone(complete['alpha'])
        self.assertIsNotNone(observed['alpha'])
        self.assertNotEqual(complete['alpha'], observed['alpha'])

        split_reports = [
            {'findings': [_finding('c-split', '아님', QUOTE)]},
            {'findings': [_finding('c-split', '맞음', QUOTE)]},
            {'findings': [_finding('c-split', '확인필요', QUOTE)]},
        ]
        split = ensemble.ensemble_blue_reports(split_reports)
        row = split['findings'][0]
        self.assertEqual(row['verdictLabel'], '확인필요')
        self.assertEqual(row['decision'], 'needs_verification')
        self.assertEqual(row['arbitrationReason'], 'split_ensemble_verdict')
        self.assertEqual(row['voteBreakdown'], {'아님': 1, '확인필요': 1, '맞음': 1})
        self.assertLess(split['krippendorffAlpha']['completeUnitAlpha']['alpha'], 1.0)

    def test_quote_overlap_clusters_without_shared_id(self):
        longer = QUOTE + ' Follow up remained uneventful.'
        reports = [
            {'findings': [{'id': 'local-a', 'verdictLabel': '아님', 'quote': QUOTE, 'pageIndex': 0}]},
            {'findings': [{'id': 'local-b', 'verdictLabel': '아님', 'quote': longer, 'pageIndex': 0}]},
        ]
        result = ensemble.ensemble_blue_reports(reports)
        self.assertEqual(len(result['findings']), 1)
        self.assertEqual(result['findings'][0]['decision'], 'defect')
        self.assertTrue(result['findings'][0]['corroborated'])
        self.assertEqual(result['findings'][0]['quote'], longer)

    def test_pdf_finalize_and_red_key_rejection(self):
        pdf = _pdf(QUOTE)
        real = _finding('c-real', '아님', QUOTE)
        fake = _finding('c-fake', '아님', MISSING)
        reports = [{'findings': [real, fake]} for _ in range(3)]
        result = ensemble.ensemble_blue_reports(reports, pdf_bytes=pdf, ledger_candidates=[])
        finalized = {row['id']: row for row in result['finalReport']['findings']}
        self.assertEqual(finalized['c-real']['verdictLabel'], '아님')
        self.assertEqual(finalized['c-real']['quote'], QUOTE)
        self.assertEqual(finalized['c-fake']['verdictLabel'], '확인필요')
        self.assertGreaterEqual(result['autoDowngradedCount'], 1)
        self.assertIn(QUOTE, result['csvText'])
        self.assertIn('paper_id', result['csvText'])

        leaked = {'findings': [_finding('c-real', '맞음', QUOTE)], 'goldLedger': {'rows': []}}
        clean = {'findings': [_finding('c-real', '맞음', QUOTE)]}
        with self.assertRaises(ValueError) as caught:
            ensemble.ensemble_blue_reports([clean, leaked])
        self.assertEqual(str(caught.exception), 'forbidden_red_key')
        nested = {'findings': [{'id': 'x', 'verdictLabel': '맞음', 'before': 'hidden'}]}
        with self.assertRaises(ValueError) as nested_caught:
            ensemble.ensemble_blue_reports([clean, nested])
        self.assertEqual(str(nested_caught.exception), 'forbidden_red_key')


class CampaignCheckpointTests(unittest.TestCase):
    def _run(self, generations, duel_fn, benchmark_fn, **kwargs):
        return campaign.run_arena_campaign(
            [PDF],
            base_harness=_base(),
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            generations=generations,
            duel_fn=duel_fn,
            benchmark_fn=benchmark_fn,
            **kwargs,
        )

    def test_budget_stop_then_resume_skips_completed(self):
        calls = []

        def duel_fn(source, generation, harness):
            del source, harness
            calls.append(generation)
            time.sleep(0.2)
            return _duel(generation)

        def benchmark_fn(generation, harness):
            del harness
            return _report(0.4 + 0.1 * generation)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stopped = self._run(
                3, duel_fn, benchmark_fn, checkpoint_dir=root, max_total_seconds=0.05,
            )
            self.assertEqual(calls, [1])
            self.assertTrue(stopped['stoppedEarly'])
            self.assertEqual(stopped['stoppedReason'], 'budget_exhausted')
            self.assertEqual([row['generation'] for row in stopped['generations']], [0, 1])
            checkpoint = json.loads((root / 'campaign-checkpoint.json').read_text(encoding='utf-8'))
            self.assertEqual(checkpoint['schema'], campaign.CHECKPOINT_SCHEMA)
            self.assertEqual(checkpoint['completedGenerations'], [0, 1])
            self.assertEqual(checkpoint['generationsTarget'], 3)
            self.assertEqual(checkpoint['role'], 'blue')
            self.assertTrue(checkpoint['scrubbed'])
            self.assertTrue(checkpoint['answerKeyFree'])
            arena_round._scrub(checkpoint, [], set())

            calls.clear()

            def resume_duel(source, generation, harness):
                del source, harness
                calls.append(generation)
                return _duel(generation)

            resumed = self._run(3, resume_duel, benchmark_fn, checkpoint_dir=root, resume=True)
            self.assertEqual(calls, [2, 3])
            self.assertEqual(resumed['resumedFromGeneration'], 1)
            self.assertNotIn('stoppedEarly', resumed)
            self.assertEqual([row['status'] for row in resumed['generations']], ['baseline', 'promoted', 'promoted', 'promoted'])
            self.assertEqual(resumed['finalHarness']['appliedRuleIds'], ['rule-g1', 'rule-g2', 'rule-g3'])
            arena_round._scrub(resumed, [], set())

            calls.clear()
            again = self._run(3, resume_duel, benchmark_fn, checkpoint_dir=root, resume=True)
            self.assertEqual(calls, [])
            self.assertEqual(again['resumedFromGeneration'], 3)

    def test_budget_can_stop_before_first_duel(self):
        calls = []

        def duel_fn(source, generation, harness):
            del source, harness
            calls.append(generation)
            return _duel(generation)

        def benchmark_fn(generation, harness):
            del harness
            if generation == 0:
                time.sleep(0.05)
            return _report(0.5)

        lineage = self._run(2, duel_fn, benchmark_fn, max_total_seconds=0.01)
        self.assertEqual(calls, [])
        self.assertEqual([row['generation'] for row in lineage['generations']], [0])
        self.assertTrue(lineage['stoppedEarly'])
        self.assertEqual(lineage['stoppedReason'], 'budget_exhausted')

    def test_budget_and_resume_flags_reject_bad_values(self):
        duel_fn = lambda *_args: _duel(1)
        benchmark_fn = lambda generation, harness: _report(0.5)
        for bad in (0, -1, float('nan'), float('inf'), True, '1'):
            with self.assertRaises(campaign.ArenaCampaignError) as caught:
                self._run(1, duel_fn, benchmark_fn, max_total_seconds=bad)
            self.assertEqual(caught.exception.code, 'invalid_budget')
            self.assertIsInstance(caught.exception, ValueError)
        with self.assertRaises(campaign.ArenaCampaignError) as resume:
            self._run(1, duel_fn, benchmark_fn, resume='yes')
        self.assertEqual(str(resume.exception), 'resume_invalid')


class ComplexityGateTests(unittest.TestCase):
    def test_owned_modules_stay_within_ccn_gate(self):
        for name in ('arena_tournament.py', 'blue_ensemble.py', 'arena_campaign.py'):
            functions = _ccn(EVAL_DIR / name)
            violations = [f"{fn['id']}:{fn['ccn']}" for fn in functions if fn['ccn'] > 15]
            self.assertEqual(violations, [])
            self.assertGreater(len(functions), 10)


if __name__ == '__main__':
    unittest.main()

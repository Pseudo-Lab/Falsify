"""Alternating RED/BLUE co-evolution: compact rules, redBrief forwarding, role=both.

Stdlib unittest only. Fixtures are synthetic records plus one subprocess CLI.
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

import arena_campaign  # noqa: E402
import arena_duel  # noqa: E402
import arena_round  # noqa: E402

PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
PDF = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
QUOTE = 'Mortality stayed stable across both study arms.'
BLUE_MARKER = 'Blue cleanroom marker stays local.'
RED_BRIEF_TEXT = 'Prefer cross-surface mutations.'

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


def _base(role: str = 'blue') -> dict:
    return {
        'schema': 'falsify.harness.v1',
        'id': 'harness-blue' if role == 'blue' else 'harness-red',
        'role': role,
        'instructions': 'Review only the blind bundle.' if role == 'blue' else 'Generate stealth-clean blind mutations.',
        'generation': 0,
        'appliedRuleIds': [],
        'appliedPatches': [],
    }


def _brief(statement: str, title: str) -> dict:
    return {
        'title': title,
        'summary': statement,
        'rules': [statement],
        'instructionsText': statement,
    }


def _patch(rule_id: str, statement: str, *, failure: str = 'missed', family: str = 'D1',
           surface: str = 'TEXT', priority: int | None = None, red_brief: dict | None = None) -> dict:
    rule = {
        'ruleId': rule_id,
        'failureClass': failure,
        'family': family,
        'surface': surface,
        'statement': statement,
        'procedure': ['Recompute the reported total from the source table.'],
        'rationale': 'Repeated misses need a fixed procedure.',
    }
    if priority is not None:
        rule['priority'] = priority
    patch = {
        'schema': 'falsify.harness-patch.v1',
        'patchId': 'patch-' + rule_id,
        'generatedAt': '2026-11-16T00:00:00Z',
        'basedOnRoundId': 'round-1',
        'source': 'falsify.arena-round.v1',
        'summary': {'axes': {}},
        'rules': [rule],
        'blueBrief': _brief(statement, 'BLUE brief'),
        'redBrief': red_brief if red_brief is not None else _brief(statement, 'RED brief'),
        'scrubbed': True,
        'answerKeyFree': True,
    }
    return patch


def _duel(patch: dict, holdout_fp: int = 0, stealth: float | None = None) -> dict:
    payload = {
        'schema': 'falsify.arena-duel.v1',
        'ok': True,
        'harnessPatch': patch,
        'holdoutSummary': {'paperCount': 0, 'totalPureFp': holdout_fp},
    }
    if stealth is not None:
        payload['stealthYield'] = stealth
        payload['roundRecord'] = {'stealthYield': stealth}
    return payload


def _report(recall: float, holdout_fp: int = 0, aurc: float = 0.2, stealth: float = 0.8) -> dict:
    return {
        'schema': 'falsify.benchmark-report.v1',
        'goldSummary': {
            'recall': recall,
            'layer0Recall': recall,
            'semanticRecall': recall,
            'stealthYield': stealth,
            'selective': {'aurc': aurc},
        },
        'holdoutSummary': {'totalPureFp': holdout_fp},
    }


def _run_both(duel_fn, benchmark_fn, **kwargs):
    params = {
        'base_harness': _base('blue'),
        'red_argv': ['red-agent'],
        'blue_argv': ['blue-agent'],
        'generations': 3,
        'role': 'both',
        'compact_rules': True,
        'duel_fn': duel_fn,
        'benchmark_fn': benchmark_fn,
    }
    params.update(kwargs)
    return arena_campaign.run_evolution_campaign([PDF], **params)


class CompactRulesTests(unittest.TestCase):
    def test_merges_orders_caps_and_rejects_answer_keys(self):
        longer = 'Recompute chart marks against the surrounding prose.'
        winner = 'Short priority.'
        rules = [
            {'ruleId': 'e1', 'failureClass': 'early_caught', 'family': 'D1', 'surface': 'TEXT',
             'statement': 'Redesign injections that were exposed too early.', 'count': 4},
            {'ruleId': 'p1', 'failureClass': 'pure_fp', 'family': 'D2', 'surface': 'TEXT',
             'statement': 'Confirm the cited claim already exists in the source.', 'count': 3},
            {'ruleId': 'f1', 'failureClass': 'flip', 'family': 'D3', 'surface': 'TEXT',
             'statement': 'Repeat the check until the decision stays stable.', 'count': 2},
            {'ruleId': 'm1', 'failureClass': 'missed', 'family': 'D4', 'surface': 'TEXT',
             'statement': 'Recompute the table total from the source.', 'count': 1},
            {'ruleId': 'm2', 'failureClass': 'missed', 'family': 'D5', 'surface': 'TEXT',
             'statement': longer, 'count': 9},
            {'ruleId': 'm2b', 'failureClass': 'missed', 'family': 'D5', 'surface': 'TEXT',
             'statement': winner, 'count': 2, 'priority': 5},
        ]
        first = arena_round.compact_harness_rules(rules, max_rules=3)
        second = arena_round.compact_harness_rules(rules, max_rules=3)
        self.assertEqual(first['schema'], arena_round.COMPACT_RULES_SCHEMA)
        self.assertTrue(first['scrubbed'])
        self.assertEqual(first['inputRuleCount'], 6)
        self.assertEqual(first['outputRuleCount'], 3)
        self.assertEqual(first['droppedCount'], 3)
        chosen = first['rules']
        self.assertEqual([rule['failureClass'] for rule in chosen], ['missed', 'missed', 'flip'])
        self.assertEqual([rule['family'] for rule in chosen], ['D5', 'D4', 'D3'])
        self.assertEqual(chosen[0]['supportCount'], 11)
        self.assertEqual(chosen[0]['mergedRuleIds'], ['m2', 'm2b'])
        self.assertEqual(chosen[0]['statement'], winner)
        self.assertEqual(chosen[0]['ruleId'], second['rules'][0]['ruleId'])
        self.assertNotIn(longer, chosen[0]['statement'])

        inferred = arena_round.compact_harness_rules([
            {'ruleId': 'fn-d1', 'failureClass': 'missed',
             'statement': 'Recompute totals against the source table.'},
            {'ruleId': 'fn-family-d1', 'kind': 'missed',
             'statement': 'Recompute totals against the source table with a second pass.'},
            {'ruleId': 'fn-surface-text', 'failureClass': 'flip',
             'statement': 'Repeat the surface check until it stays stable.'},
            {'ruleId': 'loose', 'failureClass': 'pure_fp',
             'axes': {'family': 'd6', 'surface': 'note'},
             'statement': 'Separate preexisting issues from new claims.'},
            {'ruleId': 'loose-ko', 'failureClass': 'missed',
             'statement': '계열 코드 D7 항목을 원문과 대조한다.'},
        ])
        grouped = inferred['rules']
        self.assertEqual([rule['failureClass'] for rule in grouped], ['missed', 'missed', 'flip', 'pure_fp'])
        self.assertEqual(grouped[0]['family'], 'D1')
        self.assertEqual(grouped[0]['surface'], 'NA')
        self.assertEqual(grouped[0]['supportCount'], 2)
        self.assertEqual(grouped[0]['mergedRuleIds'], ['fn-d1', 'fn-family-d1'])
        self.assertIn('second pass', grouped[0]['statement'])
        self.assertEqual(grouped[1]['family'], 'D7')
        self.assertEqual(grouped[2]['surface'], 'TEXT')
        self.assertEqual(grouped[3]['family'], 'D6')
        self.assertEqual(grouped[3]['surface'], 'NOTE')

        empty = arena_round.compact_harness_rules([])
        self.assertEqual(empty['outputRuleCount'], 0)
        self.assertEqual(empty['droppedCount'], 0)

        with self.assertRaises(arena_round.ArenaRoundError) as bad_rules:
            arena_round.compact_harness_rules('not-a-list')
        self.assertEqual(bad_rules.exception.code, 'rules_invalid')
        for value in (True, 0, 101):
            with self.assertRaises(arena_round.ArenaRoundError) as bad_max:
                arena_round.compact_harness_rules([], max_rules=value)
            self.assertEqual(bad_max.exception.code, 'max_rules_invalid')

        leaks = [
            {'ruleId': 'doi', 'failureClass': 'missed', 'family': 'D1', 'surface': 'TEXT',
             'statement': 'See 10.1371/journal.pone.0000001 in the note.'},
            {'ruleId': 'word', 'failureClass': 'missed', 'family': 'D1', 'surface': 'TEXT',
             'statement': 'The answer is hidden.'},
            {'ruleId': 'q', 'failureClass': 'missed', 'family': 'D1', 'surface': 'TEXT',
             'statement': 'Recompute the table total from the source.', 'quote': 'secret quote'},
        ]
        for leak in leaks:
            with self.assertRaises(arena_round.ArenaRoundError) as scrubbed:
                arena_round.compact_harness_rules([leak])
            self.assertEqual(scrubbed.exception.code, 'distill_scrub_failed')
            self.assertEqual(scrubbed.exception.exit_code, 3)


class CompactApplyTests(unittest.TestCase):
    def test_compact_instructions_stay_flat_and_red_brief_is_carried(self):
        statements = [
            ('rule-a', 'Alpha pass over the registered total.', None),
            ('rule-b', 'Beta pass over the registered total with extra context.', None),
            ('rule-c', 'Gamma consolidated check.', 4),
        ]
        compact = _base()
        plain = _base()
        compact['instructions'] = 'Base review.'
        plain['instructions'] = 'Base review.'
        last_compact = None
        for rule_id, statement, priority in statements:
            patch = _patch(rule_id, statement, priority=priority)
            last_compact = arena_duel.apply_harness_patch(compact, patch, role='blue', compact_rules=True)
            plain_result = arena_duel.apply_harness_patch(plain, patch, role='blue', compact_rules=False)
            compact = last_compact['harness']
            plain = plain_result['harness']
        compact_text = compact['instructions']
        plain_text = plain['instructions']
        self.assertLess(len(compact_text), len(plain_text))
        self.assertEqual(compact_text.count('[Co-Evolution'), 1)
        self.assertGreaterEqual(plain_text.count('[Co-Evolution'), 3)
        self.assertIn('Base review.', compact_text)
        self.assertIn('[Co-Evolution blue compacted gen 3]', compact_text)
        self.assertNotIn('compacted gen 1', compact_text)
        self.assertIn('Gamma consolidated check.', compact_text)
        self.assertNotIn('Alpha pass', compact_text)
        self.assertNotIn('Beta pass', compact_text)
        self.assertIn('Alpha pass', plain_text)
        self.assertIn('Beta pass', plain_text)
        self.assertIn('gen 1', plain_text)
        self.assertIn('gen 3', plain_text)
        self.assertEqual(last_compact['compactedRuleCount'], 1)
        self.assertEqual(compact['accumulatedRules'][0]['supportCount'], 3)
        self.assertEqual(compact['accumulatedRules'][0]['mergedRuleIds'], ['rule-a', 'rule-b', 'rule-c'])
        self.assertEqual(compact['rootInstructions'], 'Base review.')

        carried = {
            'title': 'RED brief',
            'summary': RED_BRIEF_TEXT,
            'rules': [RED_BRIEF_TEXT],
            'instructionsText': RED_BRIEF_TEXT,
        }
        red = _base('red')
        first = arena_duel.apply_harness_patch(
            red, _patch('rule-r1', 'Shift mutations onto a fresh surface.', family='D2', red_brief=carried),
            role='red', compact_rules=True,
        )
        self.assertEqual(first['harness']['redBrief']['summary'], RED_BRIEF_TEXT)
        second_patch = _patch('rule-r2', 'Keep the mutation pressure stable.', family='D3')
        second_patch.pop('redBrief')
        second = arena_duel.apply_harness_patch(first['harness'], second_patch, role='red', compact_rules=True)
        red_text = second['harness']['instructions']
        self.assertEqual(second['harness']['redBrief']['summary'], RED_BRIEF_TEXT)
        self.assertEqual(red_text.count('[Co-Evolution'), 1)
        self.assertIn('Shift mutations onto a fresh surface.', red_text)
        self.assertIn('Keep the mutation pressure stable.', red_text)
        self.assertEqual(second['compactedRuleCount'], 2)
        self.assertIn('Generate stealth-clean blind mutations.', red_text)

        with self.assertRaises(arena_duel.ArenaDuelError) as invalid:
            arena_duel.apply_harness_patch(_base(), _patch('rule-x', 'Recheck the registered total.'), compact_rules=1)
        self.assertEqual(invalid.exception.code, 'compact_rules_invalid')
        self.assertEqual(invalid.exception.exit_code, 2)

    def test_apply_patch_cli_accepts_compact_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            harness_path = root / 'harness.json'
            patch_path = root / 'patch.json'
            harness_path.write_text(json.dumps(_base()), encoding='utf-8')
            patch_path.write_text(
                json.dumps(_patch('rule-cli', 'Gamma consolidated check.', priority=1)),
                encoding='utf-8',
            )
            out = io.StringIO()
            with redirect_stdout(out):
                code = arena_duel.main([
                    'apply-patch', '--harness', str(harness_path), '--patch', str(patch_path),
                    '--role', 'blue', '--compact-rules',
                ])
            self.assertEqual(code, 0)
            payload = json.loads(out.getvalue())
            self.assertEqual(payload['compactedRuleCount'], 1)
            self.assertIn('compacted gen 1', payload['harness']['instructions'])


class AlternatingCampaignTests(unittest.TestCase):
    def test_role_both_promotes_blue_red_blue_and_keeps_a_clean_lineage(self):
        seen = []

        def duel_fn(source, generation, active_blue, active_red):
            del source
            seen.append((generation, active_blue['generation'], active_red['generation'], active_red['id']))
            if generation == 2:
                brief = {
                    'title': 'RED brief',
                    'summary': RED_BRIEF_TEXT,
                    'rules': [RED_BRIEF_TEXT],
                    'instructionsText': RED_BRIEF_TEXT,
                }
                patch = _patch('rule-red', RED_BRIEF_TEXT, family='D8', red_brief=brief)
                return _duel(patch, 0, 0.90)
            rule_id = 'rule-b1' if generation == 1 else 'rule-b3'
            statement = {
                1: 'Recheck numeric totals against the registered outcome.',
                3: 'Recheck direction words against the methods section.',
            }[generation]
            family = 'D1' if generation == 1 else 'D9'
            return _duel(_patch(rule_id, statement, family=family), 0, 0.90)

        def benchmark_fn(generation, harness):
            del harness
            recalls = {0: 0.40, 1: 0.55, 3: 0.80}
            return _report(recalls[generation], 0, 0.20, 0.60)

        lineage = _run_both(duel_fn, benchmark_fn)
        self.assertEqual([row['status'] for row in lineage['generations']], ['baseline', 'promoted', 'promoted', 'promoted'])
        self.assertEqual([row['targetRole'] for row in lineage['generations'][1:]], ['blue', 'red', 'blue'])
        self.assertNotIn('targetRole', lineage['generations'][0])
        self.assertEqual(seen, [
            (1, 0, 0, 'harness-red'),
            (2, 1, 0, 'harness-red'),
            (3, 1, 1, 'harness-red-gen1'),
        ])
        blue = lineage['finalBlueHarness']
        red = lineage['finalRedHarness']
        self.assertEqual(lineage['finalHarness']['generation'], 2)
        self.assertEqual(blue['generation'], 2)
        self.assertEqual(blue['appliedRuleIds'], ['rule-b1', 'rule-b3'])
        self.assertEqual(blue['instructions'].count('[Co-Evolution'), 1)
        self.assertIn('Recheck numeric totals', blue['instructions'])
        self.assertIn('Recheck direction words', blue['instructions'])
        self.assertNotIn(RED_BRIEF_TEXT, blue['instructions'])
        self.assertEqual(red['generation'], 1)
        self.assertEqual(red['redBrief']['summary'], RED_BRIEF_TEXT)
        self.assertEqual(red['instructions'].count('[Co-Evolution'), 1)
        self.assertIn(RED_BRIEF_TEXT, red['instructions'])
        frontier = {point['generation'] for point in lineage['paretoFrontier']}
        self.assertIn(3, frontier)
        self.assertNotIn(0, frontier)
        arena_round._scrub(lineage, [], set())
        rendered = json.dumps(lineage)
        self.assertNotIn('gold_ledger', rendered)
        self.assertNotIn('answer-key', rendered)

    def test_red_rollback_leaves_promoted_blue_intact(self):
        seen = []

        def duel_fn(source, generation, harness):
            del source
            seen.append((generation, harness['role'], harness['generation']))
            if generation == 2:
                return _duel(_patch('rule-red', RED_BRIEF_TEXT, family='D8'), 0, 0.10)
            rule_id = 'rule-b1' if generation == 1 else 'rule-b3'
            statement = {
                1: 'Recheck numeric totals against the registered outcome.',
                3: 'Recheck direction words against the methods section.',
            }[generation]
            family = 'D1' if generation == 1 else 'D9'
            return _duel(_patch(rule_id, statement, family=family), 0)

        def benchmark_fn(generation, harness):
            del harness
            recalls = {0: 0.50, 1: 0.60, 3: 0.70}
            return _report(recalls[generation], 0, 0.20, 0.80)

        lineage = _run_both(duel_fn, benchmark_fn)
        self.assertEqual([row['status'] for row in lineage['generations']], ['baseline', 'promoted', 'rolled_back', 'promoted'])
        self.assertEqual(lineage['generations'][2]['rollbackReason'], 'stealth_yield_regression')
        self.assertEqual(lineage['generations'][2]['targetRole'], 'red')
        self.assertEqual(seen, [(1, 'blue', 0), (2, 'red', 0), (3, 'blue', 1)])
        self.assertEqual(lineage['finalBlueHarness']['generation'], 2)
        self.assertEqual(lineage['finalBlueHarness']['appliedRuleIds'], ['rule-b1', 'rule-b3'])
        red = lineage['finalRedHarness']
        self.assertEqual(red['generation'], 0)
        self.assertEqual(red['instructions'], 'Generate stealth-clean blind mutations.')
        self.assertNotIn('redBrief', red)

    def test_blue_holdout_rollback_leaves_promoted_red_intact(self):
        def duel_fn(source, generation, harness):
            del source, harness
            if generation == 2:
                brief = {
                    'title': 'RED brief',
                    'summary': RED_BRIEF_TEXT,
                    'rules': [RED_BRIEF_TEXT],
                    'instructionsText': RED_BRIEF_TEXT,
                }
                return _duel(_patch('rule-red', RED_BRIEF_TEXT, family='D8', red_brief=brief), 0, 0.95)
            if generation == 3:
                return _duel(_patch('rule-b3', 'Recheck direction words against the methods section.'), 5)
            return _duel(_patch('rule-b1', 'Recheck numeric totals against the registered outcome.'), 0)

        def benchmark_fn(generation, harness):
            del harness
            recalls = {0: 0.50, 1: 0.60, 3: 0.70}
            return _report(recalls[generation], 0, 0.20, 0.80)

        lineage = _run_both(duel_fn, benchmark_fn)
        self.assertEqual([row['status'] for row in lineage['generations'][1:]], ['promoted', 'promoted', 'rolled_back'])
        self.assertEqual(lineage['generations'][3]['rollbackReason'], 'holdout_fp_regression')
        self.assertEqual(lineage['generations'][3]['targetRole'], 'blue')
        blue = lineage['finalBlueHarness']
        red = lineage['finalRedHarness']
        self.assertEqual(blue['generation'], 1)
        self.assertEqual(blue['appliedRuleIds'], ['rule-b1'])
        self.assertNotIn('direction words', blue['instructions'])
        self.assertEqual(red['generation'], 1)
        self.assertEqual(red['redBrief']['summary'], RED_BRIEF_TEXT)
        self.assertIn(RED_BRIEF_TEXT, red['instructions'])

    def test_blindness_aborts_the_campaign(self):
        calls = []

        def duel_fn(source, generation, harness):
            del source, harness
            calls.append(generation)
            if generation >= 2:
                raise arena_duel.ArenaDuelError('blindness_leak_detected', 3, {'marker': 'stop'})
            return _duel(_patch('rule-b1', 'Recheck numeric totals against the registered outcome.'), 0)

        def benchmark_fn(generation, harness):
            del harness
            return _report(0.50 + (0.05 * generation), 0, 0.20, 0.80)

        with self.assertRaises(arena_campaign.ArenaCampaignError) as caught:
            _run_both(duel_fn, benchmark_fn)
        self.assertEqual(caught.exception.code, 'blindness_leak_detected')
        self.assertEqual(caught.exception.exit_code, 3)
        self.assertEqual(caught.exception.extra['marker'], 'stop')
        self.assertEqual(calls, [1, 2])

    def test_invalid_campaign_flags(self):
        with self.assertRaises(arena_campaign.ArenaCampaignError) as bad_flag:
            arena_campaign.run_evolution_campaign(
                [PDF], base_harness=_base(), red_argv=['red'], blue_argv=['blue'],
                generations=1, role='both', compact_rules=1,
            )
        self.assertEqual(bad_flag.exception.code, 'compact_rules_invalid')
        self.assertEqual(bad_flag.exception.exit_code, 2)
        with self.assertRaises(arena_campaign.ArenaCampaignError) as capped:
            arena_campaign.run_evolution_campaign(
                [PDF], base_harness=_base(), red_argv=['red'], blue_argv=['blue'],
                generations=4, role='both',
            )
        self.assertEqual(capped.exception.code, 'max_generations_invalid')


class RedBriefForwardingTests(unittest.TestCase):
    def test_red_brief_reaches_red_payload_and_not_the_blue_cleanroom(self):
        seen = {}

        def red_adapter(argv, payload, cwd, stdout_path, env_allow=None):
            del argv, stdout_path, env_allow
            body = json.loads(payload.decode('utf-8'))
            root = Path(cwd)
            seen['red'] = str(root)
            seen['invocation'] = body
            source = (root / 'source.pdf').read_bytes()
            (root / 'blind.pdf').write_bytes(source)
            gold = {
                'schema': 'falsify.red-gold-ledger.v1',
                'defects': [{
                    'defectId': 'g-brief',
                    'world': 'W1',
                    'family': 'D1',
                    'difficulty': 'L2',
                    'pageIndex': 0,
                    'after': QUOTE,
                    'stealthPass': True,
                }],
            }
            (root / 'gold.json').write_text(json.dumps(gold), encoding='utf-8')
            return b''

        def blue_adapter(argv, payload, cwd, stdout_path, env_allow=None):
            del argv, stdout_path, env_allow
            root = Path(cwd)
            seen['blue'] = str(root)
            seen['blue_payload'] = payload.decode('utf-8')
            seen['names'] = sorted(path.name for path in root.iterdir())
            return json.dumps({
                'schema': 'falsify.blue-report.v1',
                'findings': [{
                    'id': 'f-brief',
                    'decision': 'defect',
                    'pageIndex': 0,
                    'quote': QUOTE,
                }],
            }).encode('utf-8')

        red_harness = _base('red')
        red_harness['generation'] = 2
        red_harness['redBrief'] = {
            'title': 'RED brief',
            'summary': RED_BRIEF_TEXT,
            'rules': [RED_BRIEF_TEXT],
            'instructionsText': RED_BRIEF_TEXT,
        }
        blue_harness = _base('blue')
        blue_harness['instructions'] = BLUE_MARKER
        result = arena_duel.run_duel(
            _pdf(QUOTE),
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            red_adapter=red_adapter,
            blue_adapter=blue_adapter,
            red_harness=red_harness,
            blue_harness=blue_harness,
        )
        invocation = seen['invocation']
        self.assertEqual(invocation['schema'], 'falsify.red-invocation.v1')
        self.assertEqual(invocation['redBrief']['summary'], RED_BRIEF_TEXT)
        self.assertEqual(invocation['harnessGeneration'], 2)
        self.assertNotIn(BLUE_MARKER, json.dumps(invocation))
        self.assertNotIn(RED_BRIEF_TEXT, seen['blue_payload'])
        self.assertNotIn(BLUE_MARKER, seen['blue_payload'])
        self.assertEqual(seen['names'], ['blind.pdf'])
        self.assertNotIn('gold.json', seen['names'])
        self.assertNotIn('source.pdf', seen['names'])
        self.assertNotEqual(seen['red'], seen['blue'])
        self.assertTrue(result['ok'])
        self.assertTrue(result['harnessPatch']['scrubbed'])


class CliAndComplexityTests(unittest.TestCase):
    def test_cli_role_both_compact_rules_writes_red_harness(self):
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
            red_out = root / 'red-harness.json'
            proc = subprocess.run(
                [
                    sys.executable, str(EVAL_DIR / 'arena_campaign.py'),
                    '--source-pdf', str(source),
                    '--red-cmd', sys.executable, '--red-arg', str(red),
                    '--blue-cmd', sys.executable, '--blue-arg', str(blue),
                    '--generations', '1',
                    '--role', 'both',
                    '--compact-rules',
                    '--min-difficulty', 'L3',
                    '--out', str(out),
                    '--out-harness', str(harness),
                    '--out-red-harness', str(red_out),
                ],
                capture_output=True,
                cwd=str(REPO_ROOT),
                check=False,
            )
            stdout = proc.stdout.decode('utf-8', errors='replace')
            stderr = proc.stderr.decode('utf-8', errors='replace')
            self.assertEqual(proc.returncode, 0, stderr + stdout[:800])
            payload = json.loads(stdout)
            self.assertEqual(payload['role'], 'both')
            self.assertEqual(payload['generations'][1]['targetRole'], 'blue')
            self.assertEqual(payload['generations'][1]['status'], 'promoted')
            self.assertIn('compacted gen', payload['finalHarness']['instructions'])
            self.assertEqual(payload['finalHarness']['instructions'].count('[Co-Evolution'), 1)
            self.assertEqual(payload['finalRedHarness']['id'], 'harness-red')
            self.assertEqual(payload['finalRedHarness']['role'], 'red')
            self.assertEqual(payload['finalRedHarness']['generation'], 0)
            saved_red = json.loads(red_out.read_text(encoding='utf-8'))
            self.assertEqual(saved_red['id'], 'harness-red')
            self.assertEqual(saved_red['generation'], 0)
            arena_round._scrub(payload, [], set())

    def test_ccn_gate_on_owned_modules(self):
        for name in ('arena_round.py', 'arena_duel.py', 'arena_campaign.py'):
            source = (EVAL_DIR / name).read_bytes()
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

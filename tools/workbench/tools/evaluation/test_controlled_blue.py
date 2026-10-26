"""Offline checks for ORIGINAL/E1/H1 comparison preparation. No model calls."""
import hashlib
import json
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path

import blue_finish
import controlled_blue as prep
import synthetic_packet as synthetic

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'comparable.json'
FINISH_FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'blue_finish_result.json'
CLI = Path(__file__).resolve().parent / 'cli.py'


def codes(summary):
    return {warning['code'] for warning in summary['warnings']}


class OutcomeTests(unittest.TestCase):
    def test_failed_empty_findings_are_not_zero(self):
        self.assertEqual(prep.outcome_class('failed', 'ok', 0, False, False), 'failed')
        self.assertEqual(prep.outcome_class('failed', None, 0, True, True), 'failed')
        self.assertEqual(prep.outcome_class('cancelled', 'ok', 0, False, False), 'cancelled')
        self.assertEqual(prep.outcome_class('completed', 'ok', 0, False, False), 'completed-zero-findings')

    def test_failed_and_cancelled_stay_out_of_the_zero_denominator(self):
        failed = synthetic.make_trial('ORIGINAL', 1, 'failed')
        cancelled = synthetic.make_trial('ORIGINAL', 2, 'cancelled')
        zero = synthetic.make_trial('ORIGINAL', 3, 'completed', 'ok', findings=[])
        others = [
            synthetic.make_trial('E1', 1, 'completed', 'ok', findings=[]),
            synthetic.make_trial('H1', 1, 'completed', 'abstain'),
        ]
        summary = prep.prepare(synthetic.base_packet([failed, cancelled, zero, *others]))
        arm = summary['arms']['ORIGINAL']
        self.assertEqual(arm['counts']['failed'], 1)
        self.assertEqual(arm['counts']['cancelled'], 1)
        self.assertEqual(arm['counts']['completed-zero-findings'], 1)
        self.assertEqual(arm['denominators']['attempts'], 3)
        self.assertEqual(arm['denominators']['completedResponses'], 1)
        self.assertEqual(arm['denominators']['zeroFindings'], {
            'numerator': 1,
            'denominator': 1,
        })
        self.assertEqual(arm['denominators']['failedExcludedFromZeroFindings'], 1)
        self.assertEqual(arm['denominators']['cancelledExcludedFromZeroFindings'], 1)
        self.assertEqual(summary['detectionCorrectness'], 'not-inferred')


class ConditionTests(unittest.TestCase):
    def test_comparable_fixture_keeps_three_arms(self):
        summary = prep.prepare(synthetic.comparable_packet())
        self.assertTrue(summary['comparisonReady'])
        self.assertEqual(summary['ranking'], 'not-computed')
        self.assertFalse(summary['machineConfigIsStrategyIdentity'])
        self.assertEqual(summary['grouping'], 'portable-strategy-version-bundle')
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 1)
        self.assertEqual(summary['arms']['E1']['counts']['completed-zero-findings'], 1)
        self.assertEqual(summary['arms']['H1']['counts']['abstain'], 1)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['human-unreviewed'], 0)
        self.assertNotEqual(summary['arms']['ORIGINAL']['sourceHash'], summary['arms']['E1']['sourceHash'])
        self.assertEqual(summary['fixed']['verifiedModel'], 'unknown')
        self.assertEqual(summary['fixed']['requestedModel'], synthetic.REQUESTED_MODEL)
        self.assertEqual(summary['arms']['ORIGINAL']['calls'], 'unknown')
        self.assertEqual(summary['arms']['ORIGINAL']['cost'], 'unknown')
        self.assertFalse(summary['scientificGold'])

    def test_success_with_findings_is_not_detection(self):
        packet = synthetic.comparable_packet()
        packet['reviews'] = []
        summary = prep.prepare(packet)
        original = summary['arms']['ORIGINAL']
        self.assertEqual(original['counts']['human-unreviewed'], 1)
        self.assertEqual(original['counts']['matched-findings'], 0)
        self.assertEqual(original['matchedFindingJudgments'], 0)
        self.assertEqual(summary['detectionCorrectness'], 'not-inferred')

    def test_mismatched_budget_is_excluded(self):
        packet = synthetic.comparable_packet()
        extra = synthetic.make_trial('ORIGINAL', 2, 'completed', 'ok', findings=[])
        extra['harness']['maxCalls'] = 4
        extra['request']['maxCalls'] = 4
        extra['request']['harness'] = extra['harness']
        extra['result']['harness'] = extra['harness']
        extra['result']['harnessHash'] = prep.canonical_digest(extra['harness'])
        extra['job']['harnessHash'] = extra['result']['harnessHash']
        extra['rawResponseSha256'] = prep.canonical_digest(extra['result'])
        packet['trials'].append(extra)
        summary = prep.prepare(packet)
        self.assertIn('incompatible_condition:budget', codes(summary))
        self.assertFalse(summary['comparisonReady'])
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['completed-zero-findings'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['denominators']['zeroFindings']['denominator'], 1)
        excluded = [row for row in summary['trials'] if row['id'] == extra['id']]
        self.assertEqual(excluded[0]['class'], 'excluded')

    def test_machine_hash_is_not_strategy_identity(self):
        packet = synthetic.comparable_packet()
        second = synthetic.make_trial(
            'ORIGINAL', 2, 'completed', 'refusal',
            executable='/opt/synthetic/other-pc/python',
            audit='/var/synthetic/other-pc/audits',
        )
        synthetic.note_paths(packet, second)
        packet['trials'].append(second)
        summary = prep.prepare(packet)
        self.assertIn('machine_config_not_strategy_identity', codes(summary))
        self.assertTrue(summary['comparisonReady'])
        hashes = summary['arms']['ORIGINAL']['machineConfigHashes']
        self.assertEqual(len(hashes), 2)
        self.assertNotIn(summary['fixed']['portableHash'], hashes)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['refusal'], 1)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 1)
        projected = prep.portable_projection(second['harness'], packet['strategy']['pathMap'], packet['strategy']['machineSettingKeys'])
        self.assertEqual(projected, packet['strategy']['portable'])
        self.assertIn('--diagnostic', projected['adapter']['args'])
        self.assertNotEqual(prep.canonical_digest(second['harness']), prep.canonical_digest(packet['trials'][0]['harness']))

    def test_adapter_flags_stay_in_the_strategy(self):
        packet = synthetic.comparable_packet()
        trial = packet['trials'][1]
        trial['harness']['adapter']['args'] = [*trial['harness']['adapter']['args'], '--effort', 'high']
        trial['request']['harness'] = trial['harness']
        trial['result']['harness'] = trial['harness']
        trial['result']['harnessHash'] = prep.canonical_digest(trial['harness'])
        trial['job']['harnessHash'] = trial['result']['harnessHash']
        trial['rawResponseSha256'] = prep.canonical_digest(trial['result'])
        projected = prep.portable_projection(trial['harness'], packet['strategy']['pathMap'], packet['strategy']['machineSettingKeys'])
        self.assertEqual(projected['adapter']['args'][-2:], ['--effort', 'high'])
        self.assertNotEqual(projected, packet['strategy']['portable'])
        summary = prep.prepare(packet)
        self.assertIn('incompatible_condition:portable_strategy', codes(summary))
        self.assertEqual(summary['arms']['E1']['excluded'], 1)

    def test_same_machine_hash_does_not_merge_a_different_bundle(self):
        packet = synthetic.comparable_packet()
        other = synthetic.make_trial('E1', 2, 'completed', 'ok', findings=[])
        other['harness']['settings']['bundleSha256'] = hashlib.sha256(b'other-bundle').hexdigest()
        other['request']['harness'] = other['harness']
        other['result']['harness'] = other['harness']
        other['result']['harnessHash'] = prep.canonical_digest(other['harness'])
        other['job']['harnessHash'] = other['result']['harnessHash']
        other['rawResponseSha256'] = prep.canonical_digest(other['result'])
        packet['trials'].append(other)
        summary = prep.prepare(packet)
        self.assertIn('incompatible_condition:portable_strategy', codes(summary))
        self.assertEqual(summary['arms']['E1']['counts']['completed-zero-findings'], 1)
        self.assertEqual(summary['arms']['E1']['excluded'], 1)
        self.assertFalse(summary['machineConfigIsStrategyIdentity'])

    def test_same_request_digest_is_a_replay(self):
        packet = synthetic.comparable_packet()
        copy = deepcopy(packet['trials'][0])
        copy['id'] = 'original-r2'
        copy['repeat'] = 2
        copy['job']['id'] = 'req-original-2'
        copy['request']['requestId'] = 'req-original-2'
        packet['trials'].append(copy)
        summary = prep.prepare(packet)
        self.assertIn('repeat_replay', codes(summary))
        self.assertNotIn('independence_unknown', codes(summary))
        self.assertEqual(summary['arms']['ORIGINAL']['attempts'], 0)
        self.assertFalse(summary['comparisonReady'])

    def test_identical_outputs_from_separate_requests_stay_counted(self):
        packet = synthetic.comparable_packet()
        second = synthetic.make_trial('E1', 2, 'completed', 'ok', findings=[])
        packet['trials'].append(second)
        first = next(trial for trial in packet['trials'] if trial['id'] == 'e1-r1')
        self.assertNotEqual(first['job']['id'], second['job']['id'])
        self.assertNotEqual(first['job']['requestBytesDigest'], second['job']['requestBytesDigest'])
        self.assertEqual(first['rawResponseSha256'], second['rawResponseSha256'])
        summary = prep.prepare(packet)
        self.assertIn('independence_unknown', codes(summary))
        self.assertNotIn('repeat_replay', codes(summary))
        self.assertEqual(summary['arms']['E1']['counts']['completed-zero-findings'], 2)
        self.assertEqual(summary['arms']['E1']['attempts'], 2)
        self.assertEqual(summary['arms']['E1']['independence'], 'unknown')
        self.assertTrue(summary['comparisonReady'])


class GoldAndModelTests(unittest.TestCase):
    def test_duplicate_and_unknown_gold_are_not_matches(self):
        packet = synthetic.comparable_packet()
        packet['gold']['items'].append(deepcopy(packet['gold']['items'][0]))
        packet['gold']['items'].append({
            'id': 'g-beta',
            'segmentId': 's1',
            'quote': 'Synthetic beta is a second fixture item.',
        })
        packet['reviews'][0]['judgments'] = [
            {'goldId': 'g-alpha', 'findingId': 'f1', 'judgment': 'matched'},
            {'goldId': 'g-missing', 'findingId': 'f1', 'judgment': 'matched'},
            {'goldId': 'g-beta', 'findingId': None, 'judgment': 'unmatched'},
        ]
        summary = prep.prepare(packet)
        self.assertIn('duplicate_gold', codes(summary))
        self.assertIn('unmatched_gold', codes(summary))
        self.assertFalse(summary['comparisonReady'])
        self.assertEqual(summary['gold']['duplicateIds'], ['g-alpha'])
        self.assertEqual(summary['arms']['ORIGINAL']['matchedFindingJudgments'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['unmatchedGoldJudgments'], 1)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['human-reviewed-no-match'], 1)

    def test_missing_gold_is_unknown_not_zero(self):
        packet = synthetic.comparable_packet()
        del packet['gold']
        packet['fixed']['goldVersion'] = None
        summary = prep.prepare(packet)
        self.assertIn('gold_missing', codes(summary))
        self.assertEqual(summary['fixed']['goldVersion'], 'unknown')
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['gold-unknown'], 1)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['human-unreviewed'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 'unknown')
        self.assertEqual(summary['arms']['ORIGINAL']['matchedFindingJudgments'], 'unknown')
        self.assertEqual(summary['gold']['usableItems'], 'unknown')
        self.assertNotEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 0)
        self.assertFalse(summary['comparisonReady'])

    def test_unverified_model_stays_unknown(self):
        packet = synthetic.comparable_packet()
        packet['trials'][0]['model']['verified'] = 'claude-opus-5-5'
        packet['trials'][0]['provenance'] = 'manual-unverified'
        summary = prep.prepare(packet)
        self.assertIn('unverified_model', codes(summary))
        row = next(item for item in summary['trials'] if item['id'] == 'original-r1')
        self.assertEqual(row['verifiedModel'], 'unknown')
        self.assertEqual(row['appModelLabel'], 'custom-stdio-model-unverified')
        self.assertEqual(summary['fixed']['requestedModel'], synthetic.REQUESTED_MODEL)
        self.assertEqual(summary['fixed']['verifiedModel'], 'unknown')

    def test_explicit_calls_stay_unknown_when_any_trial_omits_them(self):
        packet = synthetic.comparable_packet()
        packet['trials'][0]['calls'] = 0
        packet['trials'].append(synthetic.make_trial('ORIGINAL', 2, 'completed', 'refusal', calls=None))
        summary = prep.prepare(packet)
        self.assertEqual(summary['arms']['ORIGINAL']['calls'], 'unknown')
        self.assertNotEqual(summary['arms']['ORIGINAL']['calls'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['cost'], 'unknown')

    def test_calls_sum_only_when_every_included_trial_reports_one(self):
        packet = synthetic.base_packet([
            synthetic.make_trial('ORIGINAL', 1, 'completed', 'abstain', calls=0),
            synthetic.make_trial('E1', 1, 'completed', 'abstain', calls=2),
            synthetic.make_trial('H1', 1, 'completed', 'abstain', calls=2),
        ])
        summary = prep.prepare(packet)
        self.assertEqual(summary['arms']['ORIGINAL']['calls']['sum'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['calls']['verified'], False)
        self.assertEqual(summary['arms']['E1']['calls']['sum'], 2)

    def test_blind_request_rejects_gold(self):
        packet = synthetic.comparable_packet()
        packet['trials'][0]['request']['gold'] = {'items': []}
        with self.assertRaises(prep.PrepError) as caught:
            prep.prepare(packet)
        self.assertTrue(any(item.startswith('blind_violation:gold') for item in caught.exception.errors))

    def test_response_hash_mismatch_is_excluded(self):
        packet = synthetic.comparable_packet()
        packet['trials'][0]['rawResponseSha256'] = hashlib.sha256(b'not-the-response').hexdigest()
        summary = prep.prepare(packet)
        self.assertIn('incompatible_condition:response_not_immutable', codes(summary))
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 0)
        self.assertEqual(summary['arms']['ORIGINAL']['attempts'], 0)

    def test_duplicate_quote_is_rejected_evidence(self):
        packet = synthetic.comparable_packet()
        text = packet['trials'][0]['request']['segments'][0]['text']
        packet['trials'][0]['request']['segments'][0]['text'] = text + ' ' + text
        packet['arms']['ORIGINAL']['sourceHash'] = prep.source_text_hash(packet['trials'][0]['request']['segments'])
        packet['trials'][0]['job']['sourceHash'] = packet['arms']['ORIGINAL']['sourceHash']
        packet['trials'][0]['request']['sourceHash'] = packet['arms']['ORIGINAL']['sourceHash']
        packet['trials'][0]['result']['sourceHash'] = packet['arms']['ORIGINAL']['sourceHash']
        packet['trials'][0]['rawResponseSha256'] = prep.canonical_digest(packet['trials'][0]['result'])
        summary = prep.prepare(packet)
        self.assertIn('incompatible_condition:evidence_rejected', codes(summary))
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 0)

    def test_review_condition_mismatch_does_not_count(self):
        packet = synthetic.comparable_packet()
        packet['reviews'][0]['caseLabel'] = 'other-case'
        summary = prep.prepare(packet)
        self.assertIn('review_condition_mismatch', codes(summary))
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['human-unreviewed'], 1)
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['matched-findings'], 0)

    def test_scientific_gold_flag_is_rejected(self):
        packet = synthetic.comparable_packet()
        packet['gold']['scientificGold'] = True
        with self.assertRaises(prep.PrepError) as caught:
            prep.prepare(packet)
        self.assertIn('gold.scientificGold', caught.exception.errors)

    def test_real_finish_metadata_is_kept(self):
        live = blue_finish.capture_result()
        saved = json.loads(FINISH_FIXTURE.read_text(encoding='utf-8'))
        self.assertEqual(saved, live)
        self.assertIn('isolation', live)
        self.assertEqual(set(live['cliSelection']), {'provider', 'model', 'effort'})
        packet = blue_finish.packet_with_live_results()
        original = packet['trials'][0]['result']
        self.assertEqual(original, live)
        snapshot = json.loads(json.dumps(original))
        digest = packet['trials'][0]['rawResponseSha256']
        summary = prep.prepare(packet)
        self.assertEqual(original, snapshot)
        self.assertEqual(digest, prep.canonical_digest(original))
        self.assertIn('isolation', snapshot)
        self.assertIn('cliSelection', snapshot)
        row = next(item for item in summary['trials'] if item['id'] == 'original-finish')
        self.assertTrue(row['included'])
        self.assertEqual(row['class'], 'completed-zero-findings')
        self.assertEqual(summary['arms']['ORIGINAL']['counts']['completed-zero-findings'], 1)

    def test_browser_harness_canonical_uses_resolve_hash(self):
        harness = blue_finish.finish_harness()
        compact = json.dumps(harness, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        spaced = compact.replace(':', ': ', 1)
        self.assertEqual(json.loads(spaced), harness)
        self.assertNotEqual(spaced, compact)
        recorded = hashlib.sha256(spaced.encode()).hexdigest()
        self.assertNotEqual(recorded, prep.canonical_digest(harness))
        live = blue_finish.capture_result(harness_canonical=spaced)
        self.assertEqual(live['harnessHash'], recorded)
        self.assertNotEqual(live['harnessHash'], prep.canonical_digest(live['harness']))
        self.assertEqual(live['isolation'], prep._blue_module().ISOLATION)
        self.assertEqual(live['cliSelection'], prep._harness_module().record(live['harness'])['cliSelection'])
        self.assertTrue(set(live) <= prep.RESULT_REQUIRED | prep.RESULT_OPTIONAL)
        for invented in ('executionProvider', 'executionMethod', 'requestedModel'):
            self.assertNotIn(invented, live)
        packet = blue_finish.packet_with_live_results(harness_canonical=spaced)
        request = packet['trials'][0]['request']
        self.assertIs(request['harnessCanonical'], spaced)
        snapshot = json.loads(json.dumps(packet['trials'][0]['result']))
        summary = prep.prepare(packet)
        self.assertEqual(request['harnessCanonical'], spaced)
        self.assertEqual(packet['trials'][0]['result'], snapshot)
        row = next(item for item in summary['trials'] if item['id'] == 'original-finish')
        self.assertTrue(row['included'])
        self.assertEqual(row['machineConfigHash'], recorded)
        self.assertNotIn('incompatible_condition:harness_canonical', codes(summary))
        self.assertNotIn('incompatible_condition:machine_hash_unverified', codes(summary))
        self.assertTrue(summary['comparisonReady'])
        compact_summary = prep.prepare(blue_finish.packet_with_live_results(harness_canonical=compact))
        compact_row = next(item for item in compact_summary['trials'] if item['id'] == 'original-finish')
        self.assertTrue(compact_row['included'])
        self.assertEqual(compact_row['machineConfigHash'], hashlib.sha256(compact.encode()).hexdigest())
        mismatched = blue_finish.packet_with_live_results(harness_canonical=spaced)
        bad = spaced.replace('Synthetic BLUE fixed', 'Synthetic BLUE other', 1)
        self.assertNotEqual(json.loads(bad), harness)
        for trial in mismatched['trials']:
            trial['request']['harnessCanonical'] = bad
        rejected = prep.prepare(mismatched)
        self.assertIn('incompatible_condition:harness_canonical', codes(rejected))
        self.assertNotIn('incompatible_condition:machine_hash_unverified', codes(rejected))
        self.assertTrue(all(not item['included'] for item in rejected['trials']))
        recoded = blue_finish.packet_with_live_results(harness_canonical=spaced)
        digest = prep.canonical_digest(recoded['trials'][0]['harness'])
        self.assertNotEqual(digest, recorded)
        for trial in recoded['trials']:
            trial['job']['harnessHash'] = digest
            trial['result']['harnessHash'] = digest
            trial['rawResponseSha256'] = prep.canonical_digest(trial['result'])
        recoded_summary = prep.prepare(recoded)
        self.assertIn('incompatible_condition:harness_canonical', codes(recoded_summary))
        self.assertNotIn('incompatible_condition:machine_hash_unverified', codes(recoded_summary))
        self.assertFalse(any(item['included'] for item in recoded_summary['trials']))
        broken = synthetic.comparable_packet()
        broken['trials'][0]['request']['harnessCanonical'] = {'not': 'a string'}
        with self.assertRaises(prep.PrepError) as caught:
            prep.prepare(broken)
        self.assertIn('trials[0].request.harnessCanonical', caught.exception.errors)

    def test_three_by_three_full_paper_packet(self):
        trials = []
        for arm in ('ORIGINAL', 'E1', 'H1'):
            sentence = f'Synthetic {arm} paragraph states a fixed count. '
            text = (sentence * ((50000 // len(sentence)) + 1))[:50000]
            self.assertGreater(len(text), 8000)
            for repeat in (1, 2, 3):
                trials.append(synthetic.make_trial(arm, repeat, 'completed', 'ok', findings=[], text=text))
        packet = synthetic.base_packet(trials, reviews=[])
        raw = json.dumps(packet).encode('utf-8')
        self.assertGreater(len(raw), 256 * 1024)
        summary = prep.prepare_bytes(raw)
        self.assertTrue(summary['ok'])
        for arm in ('ORIGINAL', 'E1', 'H1'):
            self.assertEqual(summary['arms'][arm]['attempts'], 3)
            self.assertEqual(summary['arms'][arm]['counts']['completed-zero-findings'], 3)
            self.assertEqual(summary['arms'][arm]['independence'], 'unknown')
        self.assertTrue(summary['comparisonReady'])

    def test_fixture_file_and_cli(self):
        self.assertEqual(json.loads(FIXTURE.read_text(encoding='utf-8')), synthetic.comparable_packet())
        completed = subprocess.run(
            [sys.executable, str(CLI), str(FIXTURE)],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload['comparisonReady'])
        self.assertEqual(payload['schema'], prep.SUMMARY_SCHEMA)
        refused = subprocess.run(
            [sys.executable, str(CLI), str(FIXTURE) + '.missing'],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(refused.returncode, 2)
        self.assertFalse(json.loads(refused.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()

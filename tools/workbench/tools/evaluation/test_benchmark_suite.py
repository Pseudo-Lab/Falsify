"""Unittest suite for the synthetic benchmark corpus and regression gate."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import benchmark_suite as bench  # noqa: E402

CLI_PATH = EVAL_DIR / 'benchmark_suite.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'

V1_LAYER0_CASES = (
    'gold-w1-d1-stat-pvalue',
    'gold-w2-d2-uri-hijack',
    'gold-w3-d6-supplement-mismatch',
    'gold-w4-d41-figure-duplicate',
)
V1_SEMANTIC_CASES = (
    'gold-w5-d3-overclaim',
    'gold-w5-s1-direction-inversion',
)
V2_GOLD_CASES = (
    'gold-w3-d1-rawdata-row-mismatch',
    'gold-w1-d1-consort-attrition',
    'gold-w3-d6-code-onesided-leak',
    'gold-w3-d6-coordinated-l3-stealth',
)
V1_HOLDOUT_CASES = (
    'holdout-benign-multivariable-aor',
    'holdout-benign-fdr-padj',
    'holdout-benign-left-truncated-km',
    'holdout-benign-consistent-trial',
)
V2_HOLDOUT_CASES = (
    'holdout-benign-rawdata-na-exclusion',
    'holdout-benign-consort-multiselect',
    'holdout-benign-clean-twosided-code',
    'holdout-benign-exploratory-secondary',
)
SENSOR_LAYER0_CASES = V1_LAYER0_CASES + ('gold-w3-d1-rawdata-row-mismatch',)
HOOK_LAYER0_CASES = SENSOR_LAYER0_CASES + (
    'gold-w1-d1-consort-attrition',
    'gold-w3-d6-code-onesided-leak',
)
SEMANTIC_CASES = V1_SEMANTIC_CASES + ('gold-w3-d6-coordinated-l3-stealth',)
CASE_IDS = V1_LAYER0_CASES + V1_SEMANTIC_CASES + V2_GOLD_CASES + V1_HOLDOUT_CASES + V2_HOLDOUT_CASES
HOLDOUT_CASES = V1_HOLDOUT_CASES + V2_HOLDOUT_CASES


def _semantic_runner(case):
    findings = []
    for defect in case['goldLedger']['defects']:
        findings.append({
            'id': defect['defectId'],
            'excerpt': defect['excerpt'],
            'quote': defect['excerpt'],
            'pageIndex': defect.get('pageIndex', 0),
            'family': defect['family'],
            'decision': 'defect',
        })
    return {'findings': findings}


def _naive_runner(case):
    if case['caseId'] != 'holdout-benign-multivariable-aor':
        return {'findings': []}
    return {
        'findings': [{
            'id': 'fp-aor',
            'excerpt': 'adjusted aOR treated as a defect',
            'pageIndex': 0,
            'decision': 'defect',
        }],
    }


def _wave9_sensors_available() -> bool:
    bench._ensure_local()
    flow = importlib.util.find_spec('paper_flow_and_spin_triage')
    code = importlib.util.find_spec('paper_code_audit')
    return flow is not None and code is not None


def _gold_excerpt(case_id) -> str:
    cached = getattr(_gold_excerpt, 'cache', None)
    if cached is None:
        cached = {
            case['caseId']: case['goldLedger']['defects'][0]['excerpt']
            for case in bench.build_benchmark_corpus()
            if case['goldLedger']['defects']
        }
        _gold_excerpt.cache = cached
    return cached[case_id]


def _flow_stub_audit(pages):
    excerpt = _gold_excerpt('gold-w1-d1-consort-attrition')
    blob = '\n'.join(str(page) for page in pages)
    signals = []
    if excerpt in blob:
        signals.append({'id': 'flow-consort', 'family': 'D1', 'pageIndex': 0, 'excerpt': excerpt})
    return {
        'signals': signals,
        'triageHints': [{
            'id': 'hint-1',
            'family': 'D1',
            'pageIndex': 0,
            'excerpt': 'triage hint should not score as a defect',
            'decision': 'defect',
        }],
    }


def _code_stub_audit(pages, supplements):
    excerpt = _gold_excerpt('gold-w3-d6-code-onesided-leak')
    blob = '\n'.join(str(page) for page in pages)
    code = '\n'.join(str(item.get('text') or '') for item in supplements)
    signals = []
    if excerpt in blob and 'alternative="greater"' in code:
        signals.append({'id': 'code-onesided', 'family': 'D6', 'pageIndex': 0, 'excerpt': excerpt})
    return {'signals': signals}


def _stub_modules():
    flow = types.ModuleType('paper_flow_and_spin_triage')
    flow.audit_flow_and_spin_triage = _flow_stub_audit
    code = types.ModuleType('paper_code_audit')
    code.audit_code_supplements = _code_stub_audit
    return {'paper_flow_and_spin_triage': flow, 'paper_code_audit': code}


def _report_shell(recall, pure_fp, aurc=0.0):
    return {
        'goldSummary': {'recall': recall, 'selective': {'aurc': aurc}},
        'holdoutSummary': {'totalPureFp': pure_fp},
    }


class CorpusTests(unittest.TestCase):
    def test_corpus_has_ten_gold_and_eight_holdout_cases(self):
        corpus = bench.build_benchmark_corpus()
        ids = [case['caseId'] for case in corpus]
        self.assertEqual(ids, list(CASE_IDS))
        gold = [case for case in corpus if not case['isHoldout']]
        holdout = [case for case in corpus if case['isHoldout']]
        self.assertEqual(len(gold), 10)
        self.assertEqual(len(holdout), 8)
        for case in gold:
            self.assertEqual(case['goldLedger']['schema'], bench.GOLD_SCHEMA)
            self.assertGreater(len(case['goldLedger']['defects']), 0)
            self.assertTrue(case['blindPdfBytes'].startswith(b'%PDF'))
        for case in holdout:
            self.assertEqual(case['goldLedger']['defects'], [])


class SensorBenchmarkTests(unittest.TestCase):
    def test_sensor_mode_layer0_recall_and_clean_holdout(self):
        report = bench.run_benchmark_suite(mode='sensor')
        self.assertEqual(report['schema'], bench.SCHEMA)
        self.assertEqual(report['corpusVersion'], 'v2')
        gold = report['goldSummary']
        holdout = report['holdoutSummary']
        self.assertEqual(gold['caseCount'], 10)
        self.assertEqual(holdout['caseCount'], 8)
        self.assertEqual(gold['semanticRecall'], 0.0)
        self.assertEqual(holdout['totalPureFp'], 0)
        self.assertEqual(holdout['pureFpRatePerPaper'], 0.0)
        self.assertEqual(gold['selective']['tier1Precision'], 1.0)
        self.assertIn('aurc', gold['selective'])
        self.assertIn('coverage', gold['selective'])
        self.assertIn('overallAccuracy', gold['selective'])
        self.assertEqual(gold['stealthYield'], 1.0)
        by_id = {row['caseId']: row for row in report['caseResults']}
        for case_id in SENSOR_LAYER0_CASES:
            self.assertEqual(by_id[case_id]['fn'], 0)
            self.assertGreater(by_id[case_id]['tp'], 0)
        for case_id in SEMANTIC_CASES:
            self.assertEqual(by_id[case_id]['tp'], 0)
            self.assertGreater(by_id[case_id]['fn'], 0)
        for case_id in HOLDOUT_CASES:
            self.assertEqual(by_id[case_id]['pureFp'], 0)

    def test_rawdata_sentence_flags_summary_and_p_value(self):
        bench._ensure_local()
        import paper_raw_dataset_audit as audit

        case = next(
            item for item in bench.build_benchmark_corpus()
            if item['caseId'] == 'gold-w3-d1-rawdata-row-mismatch'
        )
        pages = [
            {'pageIndex': index, 'text': text}
            for index, text in enumerate(bench._pdf_page_texts(case['blindPdfBytes']))
        ]
        audited = audit.audit_raw_datasets(pages, case['supplements'])
        kinds = {signal['kind'] for signal in audited['signals']}
        excerpt = case['goldLedger']['defects'][0]['excerpt']
        self.assertIn('raw_dataset_summary_mismatch', kinds)
        self.assertIn('raw_dataset_p_mismatch', kinds)
        self.assertGreaterEqual(audited['signalCount'], 1)
        self.assertTrue(all(signal['excerpt'] == excerpt for signal in audited['signals']))

    def test_merged_wave9_sensors_lift_layer0_recall(self):
        if not _wave9_sensors_available():
            return
        report = bench.run_benchmark_suite(mode='sensor')
        self.assertEqual(report['goldSummary']['layer0Recall'], 1.0)
        by_id = {row['caseId']: row for row in report['caseResults']}
        for case_id in HOOK_LAYER0_CASES:
            self.assertEqual(by_id[case_id]['fn'], 0)
            self.assertGreater(by_id[case_id]['tp'], 0)

    def test_dynamic_hooks_ignore_triage_hints(self):
        with patch.dict(sys.modules, _stub_modules()):
            report = bench.run_benchmark_suite(mode='sensor')
        gold = report['goldSummary']
        self.assertEqual(gold['layer0Recall'], 1.0)
        self.assertEqual(report['holdoutSummary']['totalPureFp'], 0)
        self.assertEqual(gold['selective']['tier1Precision'], 1.0)
        by_id = {row['caseId']: row for row in report['caseResults']}
        for case_id in HOOK_LAYER0_CASES:
            self.assertEqual(by_id[case_id]['fn'], 0)


class AgentRunnerTests(unittest.TestCase):
    def test_semantic_runner_recalls_l4_and_naive_runner_flags_holdout(self):
        semantic = bench.run_benchmark_suite(mode='agent', runner_fn=_semantic_runner)
        self.assertEqual(semantic['goldSummary']['recall'], 1.0)
        self.assertEqual(semantic['goldSummary']['semanticRecall'], 1.0)
        self.assertEqual(semantic['holdoutSummary']['totalPureFp'], 0)

        naive = bench.run_benchmark_suite(mode='agent', runner_fn=_naive_runner)
        self.assertGreaterEqual(naive['holdoutSummary']['totalPureFp'], 1)
        flagged = [
            row for row in naive['holdoutSummary']['cases']
            if row['caseId'] == 'holdout-benign-multivariable-aor'
        ]
        self.assertEqual(flagged[0]['pureFp'], 1)


class ComparisonTests(unittest.TestCase):
    def test_compare_passes_on_parity_or_improvement_and_fails_on_regression(self):
        current = _report_shell(0.8, 1, 0.1)
        parity = bench.compare_benchmark_reports(_report_shell(0.8, 1, 0.1), current)
        self.assertTrue(parity['passed'])
        self.assertEqual(parity['code'], 'ok')
        self.assertEqual(parity['deltas']['recallDelta'], 0.0)
        self.assertEqual(parity['deltas']['holdoutPureFpDelta'], 0.0)

        better = bench.compare_benchmark_reports(_report_shell(0.5, 2, 0.4), current)
        self.assertTrue(better['passed'])
        self.assertGreater(better['deltas']['recallDelta'], 0.0)
        self.assertLess(better['deltas']['holdoutPureFpDelta'], 0.0)

        recall_drop = bench.compare_benchmark_reports(_report_shell(1.0, 1, 0.1), current)
        self.assertFalse(recall_drop['passed'])
        self.assertEqual(recall_drop['code'], 'benchmark_regression_detected')
        self.assertIn('recall_drop', recall_drop['regressions'])

        tolerated = bench.compare_benchmark_reports(
            _report_shell(0.9, 1, 0.1), current, max_recall_drop=0.1,
        )
        self.assertTrue(tolerated['passed'])

        fp_rise = bench.compare_benchmark_reports(_report_shell(0.8, 0, 0.1), current)
        self.assertFalse(fp_rise['passed'])
        self.assertEqual(fp_rise['code'], 'benchmark_regression_detected')
        self.assertIn('holdout_pure_fp_increase', fp_rise['regressions'])

        allowed = bench.compare_benchmark_reports(
            _report_shell(0.8, 0, 0.1), current, allow_holdout_fp_increase=True,
        )
        self.assertTrue(allowed['passed'])


class CliTests(unittest.TestCase):
    def test_cli_baseline_exit_codes(self):
        report = bench.run_benchmark_suite(mode='sensor')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = root / 'baseline.json'
            weaker = root / 'weaker.json'
            higher = root / 'higher-recall.json'
            lower_fp = root / 'lower-fp.json'
            baseline.write_text(json.dumps(report), encoding='utf-8')
            weaker_report = json.loads(json.dumps(report))
            weaker_report['goldSummary']['recall'] = 0.1
            weaker_report['holdoutSummary']['totalPureFp'] = report['holdoutSummary']['totalPureFp']
            weaker.write_text(json.dumps(weaker_report), encoding='utf-8')
            higher_report = json.loads(json.dumps(report))
            higher_report['goldSummary']['recall'] = 1.0
            higher.write_text(json.dumps(higher_report), encoding='utf-8')
            lower_report = json.loads(json.dumps(report))
            lower_report['holdoutSummary']['totalPureFp'] = report['holdoutSummary']['totalPureFp'] - 1
            lower_fp.write_text(json.dumps(lower_report), encoding='utf-8')

            parity = self._run('--baseline-report', str(baseline))
            self.assertEqual(parity.returncode, 0)
            self.assertTrue(json.loads(parity.stdout)['comparison']['passed'])

            improved = self._run('--baseline-report', str(weaker))
            self.assertEqual(improved.returncode, 0)
            self.assertTrue(json.loads(improved.stdout)['comparison']['passed'])

            dropped = self._run('--baseline-report', str(higher))
            self.assertEqual(dropped.returncode, 3)
            dropped_body = json.loads(dropped.stdout)
            self.assertEqual(dropped_body['comparison']['code'], 'benchmark_regression_detected')
            self.assertIn('recall_drop', dropped_body['comparison']['regressions'])

            fp_up = self._run('--baseline-report', str(lower_fp))
            self.assertEqual(fp_up.returncode, 3)
            fp_body = json.loads(fp_up.stdout)
            self.assertEqual(fp_body['comparison']['code'], 'benchmark_regression_detected')
            self.assertIn('holdout_pure_fp_increase', fp_body['comparison']['regressions'])

            invalid = self._run('--mode', 'agent')
            self.assertEqual(invalid.returncode, 2)

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(CLI_PATH), *args],
            capture_output=True, text=True, check=False,
        )


class ComplexityGateTests(unittest.TestCase):
    def test_benchmark_suite_ccn_within_gate(self):
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=CLI_PATH.read_bytes(), capture_output=True, check=True,
        )
        functions = json.loads(proc.stdout.decode('utf-8'))
        violations = [fn for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])
        self.assertGreater(len(functions), 20)


if __name__ == '__main__':
    unittest.main()

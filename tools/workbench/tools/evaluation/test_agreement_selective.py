"""Unit and CLI tests for Krippendorff's alpha and selective prediction (Risk-Coverage / AURC)."""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agreement_selective as mod

CLI_PATH = Path(__file__).resolve().parent / 'agreement_selective.py'
CSV_HEADERS = [
    'paper_id', 'team', 'judge_type', 'model', 'iteration',
    'location', 'defect_type', 'label', 'evidence', 'time_sec', 'tokens', 'is_holdout',
]

# Krippendorff (2011) "Computing Krippendorff's Alpha-Reliability", 4 observers, 12 units (1 unpairable).
KRIPPENDORFF_2011_UNITS = [
    [1, 1, None, 1],
    [2, 2, 3, 2],
    [3, 3, 3, 3],
    [3, 3, 3, 3],
    [2, 2, 2, 2],
    [1, 2, 3, 4],
    [4, 4, 4, 4],
    [1, 1, 2, 1],
    [2, 2, 2, 2],
    [None, 5, 5, 5],
    [None, None, 1, 1],
    [None, None, 3, None],
]

# Two-observer binary example (Krippendorff 2011 Section A): n = 20, alpha = 0.7467.
BINARY_TWO_OBSERVER_UNITS = [
    [0, 0], [1, 1], [0, 1], [0, 0], [0, 0],
    [0, 0], [0, 0], [0, 0], [1, 1], [0, 0],
]


class KrippendorffAlphaTests(unittest.TestCase):
    def test_textbook_nominal_and_ordinal_examples(self):
        nom = mod.compute_krippendorff_alpha(KRIPPENDORFF_2011_UNITS, level='nominal')
        self.assertEqual(nom['status'], 'ok')
        self.assertEqual(nom['pairable_units'], 11)
        self.assertEqual(nom['total_pairs'], 40)
        self.assertAlmostEqual(nom['alpha'], 0.7434, places=4)
        self.assertEqual(nom['band'], '잠정 합의 (0.67–0.80)')

        ord_res = mod.compute_krippendorff_alpha(KRIPPENDORFF_2011_UNITS, level='ordinal')
        self.assertEqual(ord_res['status'], 'ok')
        self.assertEqual(ord_res['pairable_units'], 11)
        self.assertAlmostEqual(ord_res['alpha'], 0.8154, places=4)
        self.assertEqual(ord_res['band'], '신뢰 가능 (≥0.80)')

        bin_nom = mod.compute_krippendorff_alpha(BINARY_TWO_OBSERVER_UNITS, level='nominal')
        self.assertAlmostEqual(bin_nom['alpha'], 0.7467, places=4)

    def test_missing_values_unanimous_and_insufficient_pairs(self):
        ins = mod.compute_krippendorff_alpha([[None, '아님'], ['pending', ''], ['맞음']])
        self.assertEqual(ins['status'], 'insufficient_pairs')
        self.assertIsNone(ins['alpha'])
        self.assertEqual(ins['pairable_units'], 0)
        self.assertEqual(ins['categories'], [])

        una = mod.compute_krippendorff_alpha([['아님', '아님', 'pending'], {'unitId': 'u2', 'ratings': ['아님', '', '아님']}])
        self.assertEqual(una['status'], 'unanimous')
        self.assertEqual(una['alpha'], 1.0)
        self.assertEqual(una['observed_disagreement'], 0.0)
        self.assertEqual(una['expected_disagreement'], 0.0)
        self.assertEqual(una['pairable_units'], 2)

    def test_falsify_ordinal_scale_rewards_adjacent_disagreement(self):
        adjacent = [
            ['맞음', '맞음'],
            ['아님', '아님'],
            ['확인필요', '아님'],
            ['맞음', '확인필요'],
        ]
        extreme = [
            ['맞음', '맞음'],
            ['아님', '아님'],
            ['맞음', '아님'],
            ['아님', '맞음'],
        ]
        adj_nom = mod.compute_krippendorff_alpha(adjacent, level='nominal')
        adj_ord = mod.compute_krippendorff_alpha(adjacent, level='ordinal')
        ext_ord = mod.compute_krippendorff_alpha(extreme, level='ordinal')
        self.assertGreater(adj_ord['alpha'], adj_nom['alpha'])
        self.assertGreater(adj_ord['alpha'], ext_ord['alpha'])


class SelectivePredictionTests(unittest.TestCase):
    def test_positive_abstention_gain_and_trapezoidal_aurc(self):
        items = [
            {'tier': 1, 'isCorrect': True},
            {'tier': 1, 'isCorrect': True},
            {'tier': 1, 'isCorrect': True},
            {'tier': 1, 'isCorrect': True},
            {'tier': 2, 'isCorrect': True},
            {'tier': 2, 'isCorrect': False},
            {'tier': 2, 'isCorrect': False},
            {'tier': 3, 'isCorrect': False},
            {'tier': 3, 'isCorrect': False},
            {'tier': 3, 'isCorrect': False},
        ]
        res = mod.compute_selective_prediction(items)
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(res['total_evaluated'], 10)
        self.assertEqual(res['committed_count'], 4)
        self.assertEqual(res['abstained_count'], 6)
        self.assertEqual(res['abstention_rate'], 0.6)
        self.assertEqual(res['coverage_at_committed'], 0.4)
        self.assertEqual(res['selective_accuracy'], 1.0)
        self.assertEqual(res['selective_risk'], 0.0)
        self.assertEqual(res['full_coverage_accuracy'], 0.5)
        self.assertEqual(res['full_coverage_risk'], 0.5)
        self.assertEqual(res['abstention_gain'], 0.5)
        # Curve points: (0.4, 0.0), (0.7, 2/7=0.2857), (1.0, 0.5)
        # Trapezoid: 0.4*0 + 0.3*(0 + 2/7)/2 + 0.3*(2/7 + 0.5)/2 = 3/70 + 33/280 = 45/280 = 0.160714...
        self.assertAlmostEqual(res['aurc'], 0.1607, places=4)
        self.assertEqual(len(res['risk_coverage_curve']), 3)

    def test_negative_abstention_gain_and_empty_input(self):
        empty = mod.compute_selective_prediction([])
        self.assertEqual(empty['status'], 'insufficient_data')
        self.assertIsNone(empty['aurc'])

        bad_deferral = [
            {'tier': 1, 'isCorrect': False},
            {'tier': 1, 'isCorrect': False},
            {'tier': 2, 'isCorrect': True},
            {'tier': 2, 'isCorrect': True},
        ]
        res = mod.compute_selective_prediction(bad_deferral)
        self.assertEqual(res['selective_accuracy'], 0.0)
        self.assertEqual(res['full_coverage_accuracy'], 0.5)
        self.assertEqual(res['abstention_gain'], -0.5)


class CliIntegrationTests(unittest.TestCase):
    def _write_csv(self, path: Path, rows: list[list[str]]) -> None:
        with path.open('w', encoding='utf-8', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(CSV_HEADERS)
            writer.writerows(rows)

    def test_cli_with_twelve_column_blue_csvs_and_gold(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            csv1 = root / 'rater1.csv'
            csv2 = root / 'rater2.csv'
            gold = root / 'gold.json'
            out_json = root / 'summary.json'
            self._write_csv(csv1, [
                ['P1', 'falsify', 'harness', 'm1', '1', 'Results p.2', 'D1', '아님', 'numeric drift', '1.2', '500', 'false'],
                ['P1', 'falsify', 'harness', 'm1', '1', 'Table 1', 'D3', '확인필요', 'borderline', '1.2', '500', 'false'],
                ['P1', 'falsify', 'harness', 'm1', '1', 'Methods p.1', 'D2', '맞음', 'clean ref', '1.2', '500', 'false'],
                ['P1', 'falsify', 'harness', 'm1', '1', 'Discussion p.5', 'S1', '확인필요', 'zero-drop recovered', '1.2', '500', 'false'],
            ])
            self._write_csv(csv2, [
                ['P1', 'falsify', 'harness', 'm2', '1', 'Results p.2', 'D1', '아님', 'confirmed drift', '1.4', '520', 'false'],
                ['P1', 'falsify', 'harness', 'm2', '1', 'Table 1', 'D3', '아님', 'table mismatch', '1.4', '520', 'false'],
                ['P1', 'falsify', 'harness', 'm2', '1', 'Methods p.1', 'D2', '맞음', 'clean ref', '1.4', '520', 'false'],
                ['P1', 'falsify', 'harness', 'm2', '1', 'Discussion p.5', 'S1', '확인필요', 'zero-drop recovered', '1.4', '520', 'false'],
            ])
            gold.write_text(json.dumps([
                {'paper_id': 'P1', 'location': 'Results p.2', 'defect_type': 'D1', 'verdict': 'supported'},
                {'paper_id': 'P1', 'location': 'Table 1', 'defect_type': 'D3', 'verdict': 'unsupported'},
                {'paper_id': 'P1', 'location': 'Discussion p.5', 'defect_type': 'S1', 'verdict': 'unsupported'},
            ]), encoding='utf-8')

            proc = subprocess.run(
                [sys.executable, str(CLI_PATH), '--csv', str(csv1), str(csv2), '--gold', str(gold), '--out', str(out_json)],
                capture_output=True, text=True, check=True,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(payload['schema'], mod.SCHEMA)
            self.assertEqual(payload['units_count'], 4)
            self.assertIsNotNone(payload['nominal_alpha'])
            self.assertGreater(payload['ordinal_alpha'], payload['nominal_alpha'])
            self.assertGreater(payload['abstention_gain'], 0.0)
            self.assertIsNotNone(payload['aurc'])
            self.assertTrue(out_json.exists())

    def test_cli_with_units_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            units_file = Path(tmp) / 'units.json'
            units_file.write_text(json.dumps({
                'units': KRIPPENDORFF_2011_UNITS,
                'items': [
                    {'tier': 1, 'isCorrect': True},
                    {'tier': 2, 'isCorrect': False},
                ],
            }), encoding='utf-8')
            rc = mod.main(['--units-json', str(units_file)])
            self.assertEqual(rc, 0)


if __name__ == '__main__':
    unittest.main()

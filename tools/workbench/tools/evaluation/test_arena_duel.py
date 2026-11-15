"""Tests for the unattended RED/BLUE duel and the generation-capped patch applier.

Fixtures are in-process synthetic PDFs and injected stdio adapters. No pytest.
"""
from __future__ import annotations

import base64
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

import arena_duel as mod  # noqa: E402

PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
QUOTE = 'Mortality stayed stable across both study arms.'
HALLUCINATED = 'Invented mortality claim absent from this blind document.'
EXEMPT_QUOTE = 'AcroForm fields: 3 total, 2 empty'
PURE_QUOTE = 'Novel unsupported sample-size drift in the untouched holdout narrative.'

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
        "difficulty": "L2",
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


def _pdf(text: str, title: str = 'Clean Clinical Trial') -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), text)
    doc.set_metadata({'title': title, 'author': 'Trial Consortium'})
    raw = doc.tobytes()
    doc.close()
    return raw


def _leaky_pdf() -> bytes:
    return _pdf('Visible body stays ordinary.', title='answer-key')


def _holdout_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 60), 'Nature Research Reporting Summary', fontsize=12)
    specs = [
        ('author_name', 'Corresponding author', 'Dr. Jane Doe', 100),
        ('code_avail', 'Code availability', '', 130),
        ('data_avail', 'Data availability', '', 160),
    ]
    for name, label, value, ypos in specs:
        widget = pymupdf.Widget()
        widget.rect = pymupdf.Rect(72, ypos, 300, ypos + 20)
        widget.field_name = name
        widget.field_label = label
        widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.field_value = value
        page.add_widget(widget)
    raw = doc.tobytes()
    doc.close()
    return raw


def _gold(defect_id: str, quote: str, difficulty: str = 'L2') -> dict:
    return {
        'schema': 'falsify.red-gold-ledger.v1',
        'defects': [{
            'defectId': defect_id,
            'world': 'W1',
            'family': 'D1',
            'difficulty': difficulty,
            'pageIndex': 0,
            'after': quote,
            'stealthPass': True,
        }],
    }


def _finding(finding_id: str, quote: str, decision: str = 'defect') -> dict:
    return {
        'schema': 'falsify.blue-report.v1',
        'findings': [{
            'id': finding_id,
            'decision': decision,
            'pageIndex': 0,
            'quote': quote,
        }],
    }


def _file_red(gold: dict, blind: bytes | None = None, seen: dict | None = None):
    def red_adapter(argv, payload, cwd, stdout_path, env_allow=None):
        body = json.loads(payload.decode('utf-8'))
        root = Path(cwd)
        if seen is not None:
            seen['red'] = str(root)
            seen['invocation'] = body
        source = (root / 'source.pdf').read_bytes()
        (root / 'blind.pdf').write_bytes(blind if blind is not None else source)
        (root / 'gold.json').write_text(json.dumps(gold), encoding='utf-8')
        return b''

    return red_adapter


def _stdio_red(gold: dict):
    def red_adapter(argv, payload, cwd, stdout_path, env_allow=None):
        raw = (Path(cwd) / 'source.pdf').read_bytes()
        return json.dumps({
            'blindPdfBase64': base64.b64encode(raw).decode('ascii'),
            'goldLedger': gold,
        }).encode('utf-8')

    return red_adapter


def _blue(report: dict, seen: dict | None = None):
    def blue_adapter(argv, payload, cwd, stdout_path, env_allow=None):
        if seen is not None:
            seen['blue'] = str(cwd)
            seen['names'] = sorted(Path(cwd).iterdir(), key=lambda path: path.name)
            seen['called'] = seen.get('called', 0) + 1
        return json.dumps(report).encode('utf-8')

    return blue_adapter


def _branching_blue(main_report: dict, holdout_report: dict, seen: dict):
    def blue_adapter(argv, payload, cwd, stdout_path, env_allow=None):
        root = Path(cwd)
        names = sorted(path.name for path in root.iterdir())
        seen.setdefault('names', []).append(names)
        raw = (root / 'blind.pdf').read_bytes()
        report = holdout_report if b'author_name' in raw else main_report
        return json.dumps(report).encode('utf-8')

    return blue_adapter


def _base_harness() -> dict:
    return {
        'schema': 'falsify.harness.v1',
        'id': 'harness-blue',
        'role': 'blue',
        'instructions': 'Review only the blind bundle.',
        'generation': 0,
        'appliedRuleIds': [],
        'appliedPatches': [],
    }


def _patch(statement: str = 'Recheck numeric totals against the registered outcome.') -> dict:
    return {
        'schema': 'falsify.harness-patch.v1',
        'patchId': 'patch-clean-1',
        'generatedAt': '2026-11-16T00:00:00Z',
        'basedOnRoundId': 'round-1',
        'source': 'falsify.arena-round.v1',
        'summary': {'axes': {'family': {'D1': {'total': 1, 'missed': 1}}}},
        'rules': [{
            'ruleId': 'rule-d1-miss',
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


class DuelTests(unittest.TestCase):
    def test_file_red_isolates_gold_and_distills_a_scored_round(self):
        seen = {}
        source = _pdf(QUOTE)
        gold = _gold('g-mortality', QUOTE)
        result = mod.run_duel(
            source,
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            supplements=[{'name': 'cohort-notes.txt', 'text': 'Cohort size notes for the source bundle only.'}],
            red_adapter=_file_red(gold, seen=seen),
            blue_adapter=_blue(_finding('f-mortality', QUOTE), seen),
        )
        self.assertEqual(result['schema'], mod.DUEL_SCHEMA)
        self.assertTrue(result['ok'])
        self.assertEqual(result['redSummary']['outputMode'], 'files')
        self.assertTrue(result['redSummary']['workspaceDisposed'])
        self.assertTrue(result['redSummary']['blindClean'])
        self.assertEqual(result['redSummary']['sourceSupplementNames'], ['cohort-notes.txt'])
        self.assertEqual(seen['invocation']['schema'], 'falsify.red-invocation.v1')
        self.assertEqual(seen['invocation']['outGold'], 'gold.json')
        self.assertFalse(Path(seen['red']).exists())
        self.assertNotEqual(seen['red'], seen['blue'])
        self.assertEqual([path.name for path in seen['names']], ['blind.pdf'])
        self.assertNotIn('gold.json', [path.name for path in seen['names']])
        self.assertNotIn('source.pdf', [path.name for path in seen['names']])
        scored = result['round']['evaluation']
        self.assertEqual(scored['schema'], 'falsify.arena-evaluation.v1')
        self.assertEqual(scored['runs'][0]['tp'], 1)
        self.assertEqual(result['harnessPatch']['schema'], 'falsify.harness-patch.v1')
        self.assertTrue(result['harnessPatch']['scrubbed'])
        self.assertTrue(result['harnessPatch']['answerKeyFree'])
        self.assertEqual(result['quoteValidation']['missingCount'], 0)
        self.assertGreaterEqual(
            result['quoteValidation']['exactCount'] + result['quoteValidation']['normalizedCount'],
            1,
        )

    def test_stdio_red_output_scores_without_workspace_files(self):
        gold = _gold('g-stdio', QUOTE)
        result = mod.run_duel(
            _pdf(QUOTE),
            red_argv=['red-stdio'],
            blue_argv=['blue-stdio'],
            red_adapter=_stdio_red(gold),
            blue_adapter=_blue(_finding('f-stdio', QUOTE)),
        )
        self.assertEqual(result['redSummary']['outputMode'], 'stdio')
        self.assertEqual(result['round']['evaluation']['runs'][0]['tp'], 1)
        self.assertEqual(result['harnessPatch']['schema'], 'falsify.harness-patch.v1')

    def test_hallucinated_quote_is_downgraded_and_cannot_score_tp(self):
        gold = _gold('g-hallu', HALLUCINATED)
        result = mod.run_duel(
            _pdf('Registered protocol text remains the only visible body.'),
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            red_adapter=_file_red(gold),
            blue_adapter=_blue(_finding('f-hallu', HALLUCINATED)),
        )
        quotes = result['quoteValidation']
        self.assertGreaterEqual(quotes['missingCount'], 1)
        finding = quotes['runs'][0]['findings'][0]
        self.assertEqual(finding['decision'], '확인필요')
        self.assertEqual(finding['verdictLabel'], '확인필요')
        scored = result['round']['evaluation']['runs'][0]
        self.assertEqual(scored['tp'], 0)
        self.assertEqual(scored['matchedPairs'], [])
        self.assertIn('g-hallu', scored['uncertainMatchedDefectIds'])

    def test_min_difficulty_and_blind_leak_stop_before_blue(self):
        seen = {'called': 0}
        source = _pdf(QUOTE)
        with self.assertRaises(mod.ArenaDuelError) as low:
            mod.run_duel(
                source,
                red_argv=['red-agent'],
                blue_argv=['blue-agent'],
                min_difficulty='L3',
                red_adapter=_file_red(_gold('g-easy', QUOTE, difficulty='L1')),
                blue_adapter=_blue(_finding('f-easy', QUOTE), seen),
            )
        self.assertEqual(low.exception.code, 'difficulty_below_minimum')
        self.assertEqual(low.exception.exit_code, 3)
        self.assertEqual(low.exception.extra['minDifficulty'], 'L3')
        self.assertIn('L1', low.exception.extra['difficulties'])
        self.assertEqual(seen['called'], 0)

        with self.assertRaises(mod.ArenaDuelError) as leaked:
            mod.run_duel(
                source,
                red_argv=['red-agent'],
                blue_argv=['blue-agent'],
                red_adapter=_file_red(_gold('g-leak', QUOTE), blind=_leaky_pdf()),
                blue_adapter=_blue(_finding('f-leak', QUOTE), seen),
            )
        self.assertEqual(leaked.exception.code, 'blindness_leak_detected')
        self.assertEqual(leaked.exception.exit_code, 3)
        self.assertFalse(leaked.exception.extra['verification']['blindClean'])
        self.assertEqual(seen['called'], 0)

    def test_holdout_separates_preexisting_signals_from_pure_fp(self):
        seen = {}
        holdout = _holdout_pdf()
        self.assertIn(b'author_name', holdout)
        result = mod.run_duel(
            _pdf(QUOTE),
            red_argv=['red-agent'],
            blue_argv=['blue-agent'],
            holdout_pdfs=[{'name': 'reporting-summary.pdf', 'bytes': holdout}],
            red_adapter=_file_red(_gold('g-main', QUOTE)),
            blue_adapter=_branching_blue(
                _finding('f-main', QUOTE),
                {
                    'schema': 'falsify.blue-report.v1',
                    'findings': [
                        {'id': 'f-base', 'decision': 'defect', 'pageIndex': 0, 'quote': EXEMPT_QUOTE},
                        {'id': 'f-novel', 'decision': 'defect', 'pageIndex': 0, 'quote': PURE_QUOTE},
                    ],
                },
                seen,
            ),
        )
        summary = result['holdoutSummary']
        self.assertEqual(summary['paperCount'], 1)
        paper = summary['papers'][0]
        self.assertEqual(paper['name'], 'reporting-summary.pdf')
        self.assertEqual(paper['preExistingExempted'], 1)
        self.assertEqual(paper['pureFp'], 1)
        self.assertEqual(summary['totalPureFp'], 1)
        self.assertEqual(summary['totalPreExistingExempted'], 1)
        seen_names = {name for names in seen['names'] for name in names}
        self.assertNotIn('gold.json', seen_names)
        self.assertNotIn('source.pdf', seen_names)
        self.assertIn('blind.pdf', seen_names)


class PatchTests(unittest.TestCase):
    def test_generation_cap_and_holdout_guard_and_scrub(self):
        current = _base_harness()
        for expected in (1, 2, 3):
            promoted = mod.apply_harness_patch(current, _patch())
            self.assertTrue(promoted['promoted'])
            self.assertEqual(promoted['schema'], mod.PATCH_APPLY_SCHEMA)
            self.assertEqual(promoted['generation'], expected)
            self.assertEqual(promoted['harness']['generation'], expected)
            self.assertEqual(promoted['harness']['parentId'], current.get('id'))
            current = promoted['harness']
        self.assertIn('rule-d1-miss', current['appliedRuleIds'])
        self.assertIn('Recheck numeric totals', current['instructions'])
        with self.assertRaises(mod.ArenaDuelError) as capped:
            mod.apply_harness_patch(current, _patch())
        self.assertEqual(capped.exception.code, 'generation_cap_exceeded')
        self.assertEqual(capped.exception.exit_code, 3)
        self.assertEqual(capped.exception.extra['currentGeneration'], 3)

        with self.assertRaises(mod.ArenaDuelError) as invalid:
            mod.apply_harness_patch(_base_harness(), _patch(), max_generations=4)
        self.assertEqual(invalid.exception.code, 'max_generations_invalid')
        self.assertEqual(invalid.exception.exit_code, 2)

        clean = mod.apply_harness_patch(
            _base_harness(), _patch(), baseline_holdout_fp=0, candidate_holdout_fp=0,
        )
        self.assertTrue(clean['promoted'])
        self.assertEqual(clean['holdoutGuard']['rolledBack'], False)
        with self.assertRaises(mod.ArenaDuelError) as regressed:
            mod.apply_harness_patch(
                _base_harness(), _patch(), baseline_holdout_fp=0, candidate_holdout_fp=2,
            )
        self.assertEqual(regressed.exception.code, 'holdout_fp_regression')
        self.assertEqual(regressed.exception.exit_code, 3)
        self.assertEqual(regressed.exception.extra['rolledBack'], True)

        for tainted in ('p = 0.03', '10.1371/journal.pone.0000001'):
            patch = _patch()
            patch['blueBrief']['summary'] = tainted
            with self.assertRaises(mod.ArenaDuelError) as scrubbed:
                mod.apply_harness_patch(_base_harness(), patch)
            self.assertEqual(scrubbed.exception.code, 'patch_not_scrubbed')
            self.assertEqual(scrubbed.exception.exit_code, 3)

    def test_cli_duel_and_apply_patch_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.pdf'
            source.write_bytes(_pdf(QUOTE))
            red = root / 'red_agent.py'
            blue = root / 'blue_agent.py'
            red.write_text(RED_SCRIPT, encoding='utf-8')
            blue.write_text(BLUE_SCRIPT, encoding='utf-8')
            duel_out = io.StringIO()
            with redirect_stdout(duel_out):
                duel_code = mod.main([
                    'duel', '--source-pdf', str(source),
                    '--red-cmd', sys.executable, '--red-arg', str(red),
                    '--blue-cmd', sys.executable, '--blue-arg', str(blue),
                ])
            self.assertEqual(duel_code, 0)
            duel = json.loads(duel_out.getvalue())
            self.assertEqual(duel['schema'], mod.DUEL_SCHEMA)
            self.assertEqual(duel['round']['evaluation']['runs'][0]['tp'], 1)

            harness_path = root / 'harness.json'
            patch_path = root / 'patch.json'
            harness_path.write_text(json.dumps(_base_harness()), encoding='utf-8')
            patch_path.write_text(json.dumps(_patch()), encoding='utf-8')
            apply_out = io.StringIO()
            with redirect_stdout(apply_out):
                apply_code = mod.main([
                    'apply-patch', '--harness', str(harness_path), '--patch', str(patch_path),
                    '--role', 'blue', '--baseline-holdout-fp', '0', '--candidate-holdout-fp', '0',
                ])
            self.assertEqual(apply_code, 0)
            applied = json.loads(apply_out.getvalue())
            self.assertEqual(applied['schema'], mod.PATCH_APPLY_SCHEMA)
            self.assertEqual(applied['generation'], 1)
            self.assertEqual(applied['harness']['id'], 'harness-blue-gen1')


class ComplexityGateTests(unittest.TestCase):
    def test_arena_duel_ccn_within_gate(self):
        source = (EVAL_DIR / 'arena_duel.py').read_bytes()
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source, capture_output=True, check=True,
        )
        functions = json.loads(proc.stdout.decode('utf-8'))
        violations = [f"{fn['id']}:{fn['ccn']}" for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])
        self.assertGreater(len(functions), 20)


if __name__ == '__main__':
    unittest.main()

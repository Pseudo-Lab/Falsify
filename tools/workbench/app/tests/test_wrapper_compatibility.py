"""Wrapper adapter compatibility: a real legacy program (examples/wrapper_legacy_demo.py) and
synthetic fixtures run as subprocesses through harness_wrapper. No model, network or paper file.

Before harness_wrapper.py is integrated every test ERRORS in setUpModule; nothing passes or skips.
"""
import copy
import hashlib
import json
import sys
import threading
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'local'))
import harness
import red_service
import blue_service
try:
    import harness_wrapper
except ImportError:
    harness_wrapper = None

DEMO = APP / 'examples' / 'wrapper_legacy_demo.py'
PROFILE = APP / 'examples' / 'wrapper-profile.json'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
FILES_ARGS = ['--in', 'files', '--invocation', '{input}', '--prompt-file', '{prompt}', '--schema', '{schema}']
SEGMENTS = [
    {'id': 's0', 'label': 'p1', 'text': 'The treatment increases yield by 12% in field A [3]. '
                                        'The method always produces “stable” results — even under drought.'},
    {'id': 's1', 'label': 'p2', 'text': '결과는 항상 재현된다. Soil moisture was measured daily.'},
]
INCREASE = 'The treatment increases yield by 12% in field A [3].'
ALWAYS = 'The method always produces “stable” results — even under drought.'
KOREAN = '결과는 항상 재현된다.'


def setUpModule():
    if harness_wrapper is None:
        raise AssertionError('app/local/harness_wrapper.py is not integrated yet: wrapper compatibility is NOT verified.')


def profile(role='blue'):
    value = json.loads(PROFILE.read_text(encoding='utf-8'))
    value['adapter']['target']['executable'] = sys.executable
    value['adapter']['target']['args'][0] = str(DEMO)
    return {**value, 'role': role, 'id': 'legacylint-' + role}


def variant(role, args, input=None, output=None):
    value = profile(role)
    value['adapter']['target']['args'] = [str(DEMO), *args]
    if input is not None: value['adapter']['input'] = input
    value['adapter']['output'].update(output or {})
    return value


def fixture(name, args, output=None, role='blue'):
    adapter = {'type': 'wrapper', 'target': {'type': 'stdio', 'executable': sys.executable, 'args': [str(FIXTURES / name), *args]},
               'input': {'mode': 'invocation'}, 'output': {'source': 'stdout', 'format': 'json', **(output or {})}}
    return {**harness.default(role), 'adapter': adapter}


MODES = {
    'invocation/stdout/json': lambda role: variant(role, ['--in', 'invocation']),
    'invocation/stdout/json-fence': lambda role: variant(role, ['--in', 'invocation', '--out', 'fence'], output={'format': 'json-fence'}),
    'prompt/stdout/json': lambda role: variant(role, ['--in', 'prompt'], input={'mode': 'prompt'}),
    'template/stdout/json': lambda role: variant(role, ['--in', 'job'], input={'mode': 'template', 'template': {
        'job': {'text': {'$from': '/prompt'}, 'role': {'$from': '/role'}, 'hint': 'literal'}}}),
    'files/stdout/json': lambda role: variant(role, FILES_ARGS, input={'mode': 'files'}),
    'files/file/json': lambda role: variant(role, FILES_ARGS + ['--out', 'file', '--out-file', '{output}'],
                                            input={'mode': 'files'}, output={'source': 'file'}),
}


def infer(value, prompt, schema):
    result = harness_wrapper.WrapperBackend(value, 8).infer(prompt, schema)
    assert result['status'] == 'ok', result
    return result['response']


def request(role, segments, **extra):
    d = {'schema': 'falsify.document-' + role + '.v1', 'revision': 'r1', 'requestId': 'wrap1', 'segments': segments,
         'sourceHash': hashlib.sha256('\n\n'.join(s['text'] for s in segments).encode()).hexdigest(),
         'maxCalls': 8, 'consent': True, 'executionConsent': True, 'harness': profile(role), **extra}
    if role == 'red': d['level'] = 1
    return d


def long_document():
    filler = [{'id': 'f%d' % i, 'label': 'f%d' % i, 'text': 'Logistics note %d: ' % i + 'routine handling ' * 1100} for i in range(2)]
    tail = {'id': 's9', 'label': 'p9', 'text': 'Fertilizer improves growth. Our model proves causality.'}
    return SEGMENTS + filler + [tail]


def run(service, d):
    return service.run_review(d, lambda _: None, threading.Event())


class ProfileExample(unittest.TestCase):
    def test_placeholder_paths_are_documented_not_portable(self):
        raw = json.loads(PROFILE.read_text(encoding='utf-8'))
        self.assertIn('ABSOLUTE/PATH', raw['adapter']['target']['executable'])
        with self.assertRaises(ValueError):  # backend checks the executable exists
            harness.validate(raw, 'blue')
        self.assertEqual(harness.validate(profile(), 'blue')['adapter']['type'], 'wrapper')
        harness_wrapper.validate_adapter(profile('red')['adapter'])

    def test_every_mode_variant_is_a_valid_adapter(self):
        for name, make in MODES.items():
            with self.subTest(name):
                harness_wrapper.validate_adapter(make('blue')['adapter'])

    def test_execution_consent_required(self):
        for role, service in [('red', red_service), ('blue', blue_service)]:
            d = request(role, SEGMENTS)
            del d['executionConsent']
            with self.assertRaises(ValueError):
                service.validate_request(d)


class StageMapping(unittest.TestCase):
    def prompts(self):
        scan = 'policy ' + json.dumps({'part': 1, 'parts': 1, 'segments': SEGMENTS}, ensure_ascii=False)
        red = 'policy ' + json.dumps({'level': 2, 'format': None, 'segments': SEGMENTS}, ensure_ascii=False)
        blue = 'policy ' + json.dumps({'segments': SEGMENTS}, ensure_ascii=False)
        return scan, red, blue

    def test_same_sample_maps_identically_in_every_mode(self):
        scan, red, blue = self.prompts()
        baseline = None
        for name, make in MODES.items():
            with self.subTest(name):
                note = infer(make('blue'), scan, red_service.SCAN)
                selection_prompt = 'policy ' + json.dumps({'allChunkNotes': [note], 'indexTruncated': False, 'segmentIndex': []},
                                                          ensure_ascii=False)
                got = {'scan': note,
                       'selection': infer(make('blue'), selection_prompt, blue_service.SELECTION),
                       'red': infer(make('red'), red, red_service.RESULT),
                       'blue': infer(make('blue'), blue, blue_service.RESULT)}
                baseline = baseline or got
                self.assertEqual(got, baseline)

    def test_exact_quotes_and_stage_shapes(self):
        scan, red, blue = self.prompts()
        make = MODES['invocation/stdout/json']
        note = infer(make('blue'), scan, red_service.SCAN)
        self.assertEqual(note['status'], 'ok')
        self.assertEqual([e['quote'] for e in note['evidence']], [INCREASE, ALWAYS, KOREAN])
        candidates = infer(make('red'), red, red_service.RESULT)['candidates']
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['before'], INCREASE)
        self.assertEqual(candidates[0]['after'], INCREASE.replace('increases', 'decreases'))
        self.assertEqual(candidates[0]['level'], 2)
        red_service.validate_candidates({'status': 'ok', 'candidates': candidates}, SEGMENTS)
        findings = infer(make('blue'), blue, blue_service.RESULT)
        self.assertEqual([(f['segmentId'], f['quote']) for f in findings['findings']], [('s0', ALWAYS), ('s1', KOREAN)])
        blue_service.validate_findings(findings, SEGMENTS)


class EndToEnd(unittest.TestCase):
    def test_red_single_and_multi_chunk(self):
        single = run(red_service, request('red', SEGMENTS))
        self.assertEqual([c['before'] for c in single['candidates']], [INCREASE])
        self.assertEqual(single['harnessHash'], harness.digest(profile('red')))
        multi = run(red_service, request('red', long_document()))
        self.assertEqual(multi['coverage']['chunks'], 2)
        self.assertEqual({c['before'] for c in multi['candidates']}, {INCREASE, 'Fertilizer improves growth.'})

    def test_blue_single_and_multi_chunk_reread(self):
        single = run(blue_service, request('blue', SEGMENTS))
        self.assertEqual([f['quote'] for f in single['findings']], [ALWAYS, KOREAN])
        self.assertEqual(single['coverage']['reread']['status'], 'not-needed')
        multi = run(blue_service, request('blue', long_document()))
        self.assertEqual(multi['coverage']['calls'], 4)  # 2 scans + selection + final
        self.assertEqual(multi['coverage']['reread']['status'], 'completed')
        self.assertEqual({f['quote'] for f in multi['findings']}, {ALWAYS, KOREAN, 'Our model proves causality.'})

    def test_abstain_and_refusal_are_not_manufactured(self):
        for marker, status in [('LEGACY-NOTHING', 'abstain'), ('LEGACY-DECLINE', 'refusal')]:
            segments = [{**SEGMENTS[0], 'text': SEGMENTS[0]['text'] + ' ' + marker}]
            for role, service, key in [('red', red_service, 'candidates'), ('blue', blue_service, 'findings')]:
                with self.subTest(marker=marker, role=role):
                    result = run(service, request(role, segments))
                    self.assertEqual((result['status'], result[key]), (status, []))

    def test_dishonest_legacy_output_is_rejected_not_repaired(self):
        for mode in ['abstain-with-items', 'invented-quote']:
            with self.subTest(mode):
                d = request('blue', SEGMENTS)
                d['harness']['adapter']['target']['args'] = [str(FIXTURES / 'wrapper_compat_bad.py'), mode]
                with self.assertRaises(ValueError):
                    run(blue_service, d)


class OutputFraming(unittest.TestCase):
    def outcome(self, args, output=None):
        try:
            return infer(fixture('wrapper_compat_noise.py', args, output), 'policy {"segments": []}', blue_service.RESULT)
        except ValueError:
            return 'rejected'

    def test_json_and_fence_framing(self):
        ok = {'status': 'ok', 'findings': []}
        fence = {'format': 'json-fence'}
        cases = [(['pretty'], None, ok), (['prose-json'], None, 'rejected'), (['json-lines'], None, 'rejected'),
                 (['fence'], None, 'rejected'), (['fence'], fence, ok), (['pretty'], fence, 'rejected'),
                 (['prose-fence'], fence, 'rejected'), (['two-fences'], fence, 'rejected'),
                 (['huge'], None, 'rejected')]
        for args, output, expected in cases:
            with self.subTest(args=args, output=output):
                self.assertEqual(self.outcome(args, output), expected)

    def test_output_path_applies_before_identity(self):
        self.assertEqual(self.outcome(['envelope']), 'rejected')
        self.assertEqual(self.outcome(['envelope'], {'path': '/envelope/report'}), {'status': 'ok', 'findings': []})

    def test_files_mode_contract(self):
        value = fixture('wrapper_compat_probe.py', ['{input}', '{prompt}', '{schema}', '{output}'], {'source': 'file'})
        value['adapter']['input'] = {'mode': 'files'}
        for schema, key in [(blue_service.RESULT, 'findings'), (blue_service.SELECTION, 'targets'), (red_service.RESULT, 'candidates')]:
            with self.subTest(key):
                self.assertEqual(infer(value, 'policy {"segments": []}', schema), {'status': 'abstain', key: []})


class MappingFailures(unittest.TestCase):
    def blue(self, findings_map):
        value = profile('blue')
        value['adapter']['output']['stageMaps']['blue'] = {'status': {'$from': '/outcome'}, 'findings': findings_map}
        return value

    def test_missing_or_malformed_directives_fail(self):
        prompt = 'policy ' + json.dumps({'segments': SEGMENTS}, ensure_ascii=False)
        for bad in [{'$from': '/no-such-field'}, {'$each': '/digest', 'template': {}}, {'$each': '/nope', 'template': {}}]:
            with self.subTest(bad):
                with self.assertRaises(ValueError):
                    harness_wrapper.WrapperBackend(self.blue(bad), 1).infer(prompt, blue_service.RESULT)

    def test_validate_adapter_rejects(self):
        base = profile()['adapter']
        bad = []
        for change in [lambda a: a.update(extra=1),
                       lambda a: a.update(target={'type': 'wrapper', 'target': copy.deepcopy(base['target'])}),
                       lambda a: a.update(target={'type': 'http', 'url': 'https://example.com/x'}, output={'source': 'file', 'format': 'json'}),
                       lambda a: a.update(input={'mode': 'template'}),
                       lambda a: a.update(input={'mode': 'shell'}),
                       lambda a: a['output'].update(path='no-leading-slash'),
                       lambda a: a['output'].update(format='yaml'),
                       lambda a: a['output']['stageMaps'].update(final={}),
                       lambda a: a['output']['stageMaps']['blue'].update(status={'$from': 5}),
                       lambda a: a['target'].update(executable='python.exe')]:
            a = copy.deepcopy(base)
            change(a)
            bad.append(a)
        for i, a in enumerate(bad):
            with self.subTest(i):
                with self.assertRaises(ValueError):
                    harness_wrapper.validate_adapter(a)


if __name__ == '__main__':
    unittest.main()

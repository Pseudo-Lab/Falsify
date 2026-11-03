"""Chart extraction with injected engines. No model download and no real inference."""
import hashlib
import os
import struct
import subprocess
import sys
import types
import unittest
import zlib
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart as chart


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff'))
        + chunk(b'IEND', b''))


PNG = png()
SHA = hashlib.sha256(PNG).hexdigest()


def engine(raw):
    def generate(png_bytes, prompt, options):
        generate.png_bytes = png_bytes
        generate.prompt = prompt
        generate.options = options
        return raw
    return generate


class ChartTests(unittest.TestCase):
    def tearDown(self):
        chart._default_engine = None

    def test_import_does_not_load_model_runtime(self):
        local = Path(__file__).resolve().parents[1] / 'local'
        code = (
            'import sys\n'
            'before=set(sys.modules)\n'
            'import paper_chart\n'
            'added=set(sys.modules)-before\n'
            'banned=[name for name in added if name.split(".")[0] in '
            '{"torch","transformers","huggingface_hub","PIL","cv2"}]\n'
            'assert not banned, banned\n'
            'assert paper_chart.MODEL_ID=="google/deplot"\n'
            'assert paper_chart.MODEL_REVISION=="6e76d62430da16986be3426bae32301fb9115397"\n'
            'assert paper_chart.PROMPT=="Generate underlying data table of the figure below:"\n'
        )
        env = os.environ.copy()
        env['PYTHONPATH'] = str(local)
        env['HF_HUB_OFFLINE'] = '1'
        env['TRANSFORMERS_OFFLINE'] = '1'
        env['HF_HUB_DISABLE_TELEMETRY'] = '1'
        completed = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)

    def test_ready_table_keeps_raw_and_does_not_infer_scale(self):
        raw = 'x | y <0x0A> 1 | 1 <0x0A> 10 | 2 <0x0A> 100 | 3 <0x0A> 1000 | 4'
        result = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(set(result), set(chart.result_keys()))
        self.assertEqual(result['schema'], 'falsify.chart-data.v1')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['rawOutput'], raw)
        self.assertEqual(result['image'], {'sha256': SHA, 'width': 1, 'height': 1})
        self.assertEqual(result['columns'], ['x', 'y'])
        self.assertEqual(result['rows'], [['1', '1'], ['10', '2'], ['100', '3'], ['1000', '4']])
        self.assertEqual(result['title'], None)
        self.assertEqual(result['chartType'], 'unknown')
        self.assertEqual(result['axes']['x']['scale'], 'unknown')
        self.assertEqual(result['axes']['y']['scale'], 'unknown')
        self.assertEqual(result['provenance']['engine'], 'injected')
        self.assertTrue(result['numericCells'])
        self.assertTrue(all(cell['origin'] == 'model-estimate' for cell in result['numericCells']))
        self.assertNotIn('confidence', result)
        self.assertNotIn('groundTruth', result)

    def test_units_exponents_unicode_minus_and_nonfinite(self):
        raw = '\n'.join([
            'Item | Reading',
            'exp | 1.2e-3',
            'big | 6.02E+23',
            'minus | −2.5',
            'percent | 12%',
            'unit | 3.5 kg',
            'money | $1,234.50',
            'times | 1.5×10⁻³',
            'caret | 2 × 10^2',
            'label | Group A',
            'gap | n/a',
            'missing | ',
            'nan-token | NaN',
            'inf-token | -inf',
            'overflow | 1e309',
        ])
        result = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(result['rawOutput'], raw)
        self.assertEqual(result['status'], 'partial')
        by_row = {cell['row']: cell for cell in result['numericCells']}
        self.assertEqual(by_row[0]['value'], float('1.2e-3'))
        self.assertEqual(by_row[0]['raw'], '1.2e-3')
        self.assertIsNone(by_row[0]['unit'])
        self.assertEqual(by_row[1]['value'], float('6.02E+23'))
        self.assertEqual(by_row[2]['raw'], '−2.5')
        self.assertEqual(by_row[2]['value'], -2.5)
        self.assertEqual(by_row[3]['value'], 12.0)
        self.assertEqual(by_row[3]['unit'], '%')
        self.assertEqual(by_row[4], {'row': 4, 'column': 1, 'raw': '3.5 kg', 'value': 3.5,
            'unit': 'kg', 'origin': 'model-estimate'})
        self.assertEqual(by_row[5]['value'], 1234.5)
        self.assertEqual(by_row[5]['unit'], '$')
        self.assertEqual(by_row[6]['value'], float('1.5e-3'))
        self.assertEqual(by_row[6]['raw'], '1.5×10⁻³')
        self.assertEqual(by_row[7]['value'], 200.0)
        self.assertNotIn(8, by_row)
        self.assertNotIn(9, by_row)
        self.assertEqual(result['rows'][10][1], None)
        self.assertEqual(result['issues'], [
            'nonfinite value at row 11 column 1',
            'nonfinite value at row 12 column 1',
            'nonfinite value at row 13 column 1',
        ])

    def test_missing_and_duplicate_labels(self):
        raw = 'Year | Year | \n1 | 2 | 3'
        result = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['columns'], ['Year', 'Year', ''])
        self.assertEqual(result['issues'], [
            'duplicate label at column 1: Year',
            'missing label at column 2',
        ])
        self.assertEqual([cell['value'] for cell in result['numericCells']], [1.0, 2.0, 3.0])

    def test_uneven_rows_and_markdown_rules(self):
        raw = '| A | B | C |\n| --- | --- | --- |\n1 | 2\n3 | 4 | 5 | 6'
        result = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(result['columns'], ['A', 'B', 'C', ''])
        self.assertEqual(result['rows'], [['1', '2', None, None], ['3', '4', '5', '6']])
        self.assertEqual(result['issues'], [
            'missing label at column 3',
            'malformed width at row 0: expected 3, got 2',
            'malformed width at row 1: expected 3, got 4',
        ])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['rows'][1][3], '6')

    def test_unsupported_and_empty_output_keep_raw(self):
        prose = 'This figure is a photograph of a cathedral.'
        unsupported = chart.extract_chart(PNG, engine=engine(prose))
        self.assertEqual(unsupported['status'], 'unavailable')
        self.assertEqual(unsupported['issues'], ['unsupported output'])
        self.assertEqual(unsupported['rawOutput'], prose)
        self.assertEqual(unsupported['columns'], [])
        self.assertEqual(unsupported['numericCells'], [])
        empty = chart.extract_chart(PNG, engine=engine('  \n<0x0A> '))
        self.assertEqual(empty['status'], 'unavailable')
        self.assertEqual(empty['issues'], ['empty output'])
        self.assertEqual(empty['rawOutput'], '  \n<0x0A> ')

    def test_header_only_and_single_column(self):
        header = chart.extract_chart(PNG, engine=engine('OnlyHeader'))
        self.assertEqual(header['status'], 'partial')
        self.assertEqual(header['columns'], ['OnlyHeader'])
        self.assertEqual(header['rows'], [])
        self.assertEqual(header['issues'], ['no data rows'])
        column = chart.extract_chart(PNG, engine=engine('City\nSeoul\nBusan'))
        self.assertEqual(column['status'], 'ready')
        self.assertEqual(column['columns'], ['City'])
        self.assertEqual(column['rows'], [['Seoul'], ['Busan']])
        self.assertEqual(column['numericCells'], [])

    def test_failure_non_string_and_bad_engine(self):
        def boom(png_bytes, prompt, options):
            raise RuntimeError('cuda oom')
        failed = chart.extract_chart(PNG, engine=boom)
        self.assertEqual(failed['status'], 'unavailable')
        self.assertEqual(failed['rawOutput'], '')
        self.assertEqual(failed['issues'], ['engine failure: RuntimeError: cuda oom'])
        self.assertEqual(failed['image']['sha256'], SHA)
        class Box:
            def generate(self, png_bytes, prompt, options):
                return 5
        non_string = chart.extract_chart(PNG, engine=Box())
        self.assertEqual(non_string['issues'], ['engine returned non-string output'])
        self.assertEqual(non_string['provenance']['method'], 'injected')
        class Neither:
            pass
        bad = chart.extract_chart(PNG, engine=Neither())
        self.assertEqual(bad['issues'], ['engine failure: TypeError: engine must be callable or provide generate'])

    def test_input_and_options_guards_do_not_call_engine(self):
        def boom(png_bytes, prompt, options):
            raise AssertionError('engine called')
        invalid = chart.extract_chart(b'not-a-png', engine=boom)
        self.assertEqual(invalid['status'], 'unavailable')
        self.assertEqual(invalid['issues'], ['invalid png'])
        self.assertEqual(invalid['image']['sha256'], hashlib.sha256(b'not-a-png').hexdigest())
        typed = chart.extract_chart(bytearray(PNG), engine=boom)
        self.assertEqual(typed['issues'], ['png_bytes must be bytes'])
        self.assertIsNone(typed['image']['sha256'])
        options = chart.extract_chart(PNG, engine=boom, options=['en'])
        self.assertEqual(options['issues'], ['options must be a dict'])
        huge = b'\x89PNG\r\n\x1a\n' + b'0' * (chart.MAX_ENCODED_BYTES - 7)
        self.assertEqual(len(huge), chart.MAX_ENCODED_BYTES + 1)
        sized = chart.extract_chart(huge, engine=boom)
        self.assertEqual(sized['issues'], ['input exceeds 30MB'])
        pixels = chart.extract_chart(png(4000, 3001), engine=boom)
        self.assertEqual(pixels['issues'], ['input exceeds 12M pixels'])
        self.assertEqual(pixels['image']['width'], 4000)
        self.assertEqual(pixels['image']['height'], 3001)

    def test_row_cap_and_token_truncation(self):
        raw = '\n'.join(['Label | Value'] + ['r%d | %d' % (index, index) for index in range(501)])
        capped = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(len(capped['rows']), 500)
        self.assertEqual(capped['rows'][-1], ['r499', '499'])
        self.assertEqual(capped['issues'], ['truncated to 500 rows'])
        self.assertEqual(capped['status'], 'partial')
        self.assertEqual(capped['rawOutput'], raw)
        self.assertEqual(len(capped['numericCells']), 500)
        class Truncating:
            generation_truncated = True
            generation_token_limit = 1024
            def generate(self, png_bytes, prompt, options):
                return 'A | B\n1 | 2'
        flagged = chart.extract_chart(PNG, engine=Truncating())
        self.assertEqual(flagged['issues'], ['generation truncated at 1024 tokens'])
        self.assertEqual(flagged['status'], 'partial')
        self.assertEqual(flagged['rows'], [['1', '2']])
        lowered = chart.extract_chart(PNG, engine=engine('A | B\n1 | 2\n3 | 4\n5 | 6'), options={'max_rows': 2})
        self.assertEqual(lowered['rows'], [['1', '2'], ['3', '4']])
        self.assertEqual(lowered['issues'], ['truncated to 2 rows'])
        refused = chart.extract_chart(PNG, engine=engine(raw), options={'max_rows': 5000})
        self.assertEqual(len(refused['rows']), 500)
        self.assertIn('truncated to 500 rows', refused['issues'])

    def test_grounded_options_do_not_come_from_the_table(self):
        raw = 'Year | Revenue\n2020 | 10\n2021 | 100'
        plain = chart.extract_chart(PNG, engine=engine(raw))
        self.assertEqual(plain['chartType'], 'unknown')
        self.assertIsNone(plain['title'])
        self.assertEqual(plain['axes']['y']['scale'], 'unknown')
        grounded = chart.extract_chart(PNG, engine=engine(raw), options={
            'title': ' Revenue ',
            'chartType': 'line',
            'axes': {'y': {'label': 'Revenue', 'scale': 'log', 'unit': 'USD'}},
        })
        self.assertEqual(grounded['status'], 'ready')
        self.assertEqual(grounded['title'], 'Revenue')
        self.assertEqual(grounded['chartType'], 'line')
        self.assertEqual(grounded['axes']['y'], {'label': 'Revenue', 'scale': 'log', 'unit': 'USD'})
        self.assertEqual(grounded['axes']['x']['scale'], 'unknown')
        invalid = chart.extract_chart(PNG, engine=engine(raw), options={'axes': {'y': {'scale': 'sqrt'}}})
        self.assertEqual(invalid['status'], 'partial')
        self.assertEqual(invalid['axes']['y']['scale'], 'unknown')
        self.assertEqual(invalid['issues'], ['invalid axis scale for y'])

    def test_generate_wins_and_default_engine_stays_unloaded(self):
        class Both:
            def __call__(self, *args):
                raise AssertionError('callable path')
            def generate(self, png_bytes, prompt, options):
                self.prompt = prompt
                return 'A | B\n1 | 2%'
        both = Both()
        chosen = chart.extract_chart(PNG, engine=both)
        self.assertEqual(both.prompt, chart.PROMPT)
        self.assertEqual(chosen['numericCells'][1]['unit'], '%')
        self.assertIsNone(chart._default_engine)
        chart._default_engine = None
        with patch.object(chart.DeplotEngine, 'generate', return_value='A | B\n1 | 2') as generate, \
                patch.object(chart, '_load_deplot_stack') as load:
            first = chart.extract_chart(PNG, engine=chart.default_engine())
            second = chart.extract_chart(PNG, engine=chart.default_engine())
        load.assert_not_called()
        self.assertEqual(generate.call_count, 2)
        self.assertIs(first['provenance']['engine'], 'transformers')
        self.assertEqual(second['provenance']['model'], chart.MODEL_ID)
        self.assertEqual(second['provenance']['revision'], chart.MODEL_REVISION)
        self.assertIsNone(second['provenance']['device'])
        self.assertEqual(generate.call_args.args[1], chart.PROMPT)

    def test_deplot_engine_pins_revision_without_downloading(self):
        calls = {}

        class Move:
            def to(self, device):
                return self

        class Tokens:
            def __init__(self, length):
                self.shape = (1, length)
            def __getitem__(self, index):
                return self

        class Model:
            def to(self, device):
                calls['device'] = device
                return self
            def eval(self):
                return self
            def generate(self, **kwargs):
                calls['generate'] = kwargs
                return Tokens(calls['length'])

        class Processor:
            def __call__(self, **kwargs):
                calls['processor_call'] = kwargs
                return {'pixel_values': Move()}
            def decode(self, tokens, skip_special_tokens=True):
                calls['skip_special_tokens'] = skip_special_tokens
                return 'A | B <0x0A> 1 | 2%'

        def load(available):
            def loader():
                def processor_from_pretrained(*args, **kwargs):
                    calls['processor'] = (args, kwargs)
                    return Processor()
                def model_from_pretrained(*args, **kwargs):
                    calls['model'] = (args, kwargs)
                    return Model()
                torch = types.SimpleNamespace(
                    cuda=types.SimpleNamespace(is_available=lambda: available),
                    inference_mode=lambda: nullcontext())
                return (torch, types.SimpleNamespace(from_pretrained=processor_from_pretrained),
                    types.SimpleNamespace(from_pretrained=model_from_pretrained))
            return loader

        calls['length'] = 4
        engine_cpu = chart.DeplotEngine()
        with patch.object(chart, '_load_deplot_stack', load(False)), patch.object(chart, '_open_rgb', lambda raw: 'image'):
            text = engine_cpu.generate(PNG, chart.PROMPT, {'max_new_tokens': 5000})
            self.assertEqual(text, 'A | B <0x0A> 1 | 2%')
            self.assertEqual(calls['processor'], ((chart.MODEL_ID,), {
                'revision': chart.MODEL_REVISION, 'trust_remote_code': False, 'local_files_only': True}))
            self.assertEqual(calls['model'][0], (chart.MODEL_ID,))
            self.assertEqual(calls['model'][1], {
                'revision': chart.MODEL_REVISION, 'trust_remote_code': False,
                'use_safetensors': True, 'local_files_only': True})
            self.assertEqual(calls['device'], 'cpu')
            self.assertEqual(engine_cpu.device, 'cpu')
            self.assertEqual(calls['generate']['max_new_tokens'], 1024)
            self.assertEqual(calls['processor_call']['text'], chart.PROMPT)
            self.assertEqual(calls['processor_call']['images'], 'image')
            self.assertTrue(calls['skip_special_tokens'])
            self.assertFalse(engine_cpu.generation_truncated)
            parsed = chart.extract_chart(PNG, engine=engine_cpu)
        self.assertEqual(parsed['status'], 'ready')
        self.assertEqual(parsed['provenance']['device'], 'cpu')
        self.assertEqual(parsed['provenance']['revision'], chart.MODEL_REVISION)
        self.assertEqual(parsed['numericCells'][1]['value'], 2.0)

        calls['length'] = 32
        engine_cuda = chart.DeplotEngine()
        with patch.object(chart, '_load_deplot_stack', load(True)), patch.object(chart, '_open_rgb', lambda raw: 'image'):
            flagged = chart.extract_chart(PNG, engine=engine_cuda, options={'max_new_tokens': 32})
        self.assertEqual(calls['device'], 'cuda')
        self.assertEqual(calls['generate']['max_new_tokens'], 32)
        self.assertTrue(engine_cuda.generation_truncated)
        self.assertEqual(flagged['issues'], ['generation truncated at 32 tokens'])


class GeometryTableTests(unittest.TestCase):
    def test_same_color_traces_keep_distinct_ids_in_rows_and_pixel_provenance(self):
        geometry = {'status': 'ready', 'issues': [], 'axes': {'x': {'scale': 'linear'}, 'left': {'scale': 'log'}},
                    'series': []}
        for index, y in enumerate((10.0, 7.071), 1):
            geometry['series'].append({'id': 'series-' + str(index), 'color': '#1a7cbe', 'axisBinding': 'left',
                'points': [{'x': 1.0, 'y': y, 'xPixel': 120.0, 'yPixel': 320.0 + (index - 1) * 40,
                            'valueCandidates': {'left': y}, 'pixelInterval': [y - .1, y + .1]}]})
        result = chart._geometry_result(geometry, {'sha256': SHA, 'width': 640, 'height': 480})
        self.assertEqual([row[0] for row in result['rows']], ['series-1', 'series-2'])
        self.assertEqual([row[3] for row in result['rows']], ['10', '7.071'])
        self.assertEqual(result['numericCells'][1]['sourcePixel'], [120.0, 320.0])
        self.assertEqual(result['numericCells'][3]['sourcePixel'], [120.0, 360.0])
        self.assertEqual(result['geometry']['series'][0]['color'], result['geometry']['series'][1]['color'])
        self.assertTrue(all(cell['origin'] == 'pixel-calibrated' for cell in result['numericCells']))


if __name__ == '__main__':
    unittest.main()

"""Injected-engine tests for paper_ocr. No model download and no network."""
import ast
import hashlib
import json
import struct
import sys
import types
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_BEFORE_IMPORT = set(sys.modules)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_ocr as po


def _chunk(tag, payload):
    crc = zlib.crc32(tag + payload) & 0xffffffff
    return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', crc)


def png(width=2, height=2, color=(255, 255, 255)):
    rows = b''.join(b'\x00' + bytes(color) * width for _ in range(height))
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', zlib.compress(rows)) + _chunk(b'IEND', b'')


def png_claim(width, height):
    """IHDR reports width and height; the IDAT is only 1x1. The gate reads IHDR."""
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    rows = b'\x00' + bytes((0, 0, 0))
    return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', zlib.compress(rows)) + _chunk(b'IEND', b'')


def _box(x1, y1, x2, y2):
    return SimpleNamespace(x1=x1, y1=y1, x2=x2, y2=y2)


def _cell(x1, y1, x2, y2, value):
    return SimpleNamespace(bbox=_box(x1, y1, x2, y2), value=value)


class LangRec:
    EN = 'en-enum'
    KOREAN = 'korean-enum'


class EngineType:
    ONNXRUNTIME = 'onnxruntime-enum'


class ModelType:
    MOBILE = 'mobile-enum'


class OCRVersion:
    PPOCRV5 = 'ppocrv5-enum'


class LineRapid:
    inits = 0

    def __init__(self, params=None, config_path=None):
        LineRapid.inits += 1
        self.params = params
        self.calls = []

    def __call__(self, data, text_score=None, **kwargs):
        self.calls.append(text_score)
        self.data = data
        return SimpleNamespace(boxes=None, txts=None, scores=None)


class TableRapid:
    inits = 0

    def __init__(self, params=None):
        TableRapid.inits += 1
        self.params = params


class FakeImage:
    last = None

    def __init__(self, src, detect_rotation=False):
        self.src = src
        self.detect_rotation = detect_rotation
        self.kwargs = None

    def extract_tables(self, **kwargs):
        self.kwargs = kwargs
        FakeImage.last = self
        return []


def _empty_lines(_data):
    return SimpleNamespace(boxes=None, txts=None, scores=None)


def _install_fakes():
    saved = {name: sys.modules.get(name) for name in (
        'rapidocr', 'img2table', 'img2table.document', 'img2table.ocr')}
    rapid = types.ModuleType('rapidocr')
    rapid.LangRec = LangRec
    rapid.EngineType = EngineType
    rapid.ModelType = ModelType
    rapid.OCRVersion = OCRVersion
    rapid.RapidOCR = LineRapid
    package = types.ModuleType('img2table')
    package.__path__ = []
    document = types.ModuleType('img2table.document')
    document.Image = FakeImage
    ocr = types.ModuleType('img2table.ocr')
    ocr.RapidOCR = TableRapid
    sys.modules['rapidocr'] = rapid
    sys.modules['img2table'] = package
    sys.modules['img2table.document'] = document
    sys.modules['img2table.ocr'] = ocr
    return saved


def _restore(saved):
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module
    po._LINE_ENGINES.clear()
    po._TABLE_ENGINES.clear()


class PaperOcrTests(unittest.TestCase):
    def setUp(self):
        po._LINE_ENGINES.clear()
        po._TABLE_ENGINES.clear()
        LineRapid.inits = 0
        TableRapid.inits = 0
        FakeImage.last = None

    def test_import_does_not_load_ocr_packages(self):
        source = Path(po.__file__).read_text(encoding='utf-8')
        tree = ast.parse(source)
        imported = []
        for node in tree.body:
            if isinstance(node, ast.Import):
                imported.extend(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module.split('.')[0])
        for name in ('rapidocr', 'img2table', 'cv2', 'numpy', 'torch', 'transformers'):
            self.assertNotIn(name, imported)
        added = set(sys.modules) - _BEFORE_IMPORT
        for name in added:
            self.assertFalse(name == 'rapidocr' or name.startswith('rapidocr.'))
            self.assertFalse(name == 'img2table' or name.startswith('img2table.'))

    def test_constants_match_contract(self):
        self.assertEqual(po.MAX_ENCODED_BYTES, 30 * 1024 * 1024)
        self.assertEqual(po.MAX_PIXELS, 12_000_000)
        self.assertEqual(po.RAPIDOCR_VERSION, '3.10.0')
        self.assertEqual(po.IMG2TABLE_VERSION, '2.0.0')
        self.assertEqual(po.MIN_TABLE_CONFIDENCE, 1)

    def test_rejects_input_before_engines(self):
        def explode(_data):
            raise AssertionError('engine called')

        image = png()
        self.assertEqual(po.recognize(None, engine=explode, table_engine=explode)['issues'], ['input-type'])
        self.assertEqual(po.recognize(image, language='ja', engine=explode, table_engine=explode)['issues'],
            ['language-unsupported'])
        self.assertEqual(po.recognize(b'GIF89a', engine=explode, table_engine=explode)['issues'], ['png-only'])
        truncated = image[:20]
        self.assertEqual(po.recognize(truncated, engine=explode, table_engine=explode)['issues'], ['png-invalid'])
        with patch.object(po, 'MAX_ENCODED_BYTES', 8):
            rejected = po.recognize(image, engine=explode, table_engine=explode)
        self.assertEqual(rejected['issues'], ['encoded-size'])
        self.assertIsNone(rejected['image']['sha256'])
        too_many = po.recognize(png_claim(3000, 4001), engine=explode, table_engine=explode)
        self.assertEqual(too_many['issues'], ['pixel-count'])
        self.assertEqual(too_many['image']['width'], 3000)
        self.assertEqual(too_many['image']['height'], 4001)
        allowed = po.recognize(png_claim(3000, 4000), engine=_empty_lines, table_engine=lambda _data: [])
        self.assertEqual(allowed['status'], 'ready')
        self.assertEqual(allowed['image']['width'] * allowed['image']['height'], 12_000_000)

    def test_raw_text_low_confidence_and_polygon(self):
        def engine(_data):
            return SimpleNamespace(
                boxes=[[(1, 2), (5, 2), (4, 6), (1, 5)], [(0, 0), (2, 0), (2, 1), (0, 1)]],
                txts=('1e-3', ' 00.10 '),
                scores=(0.01, 0.0),
            )

        result = po.recognize(bytearray(png()), engine=engine, table_engine=lambda _data: None)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['lines'][0]['text'], '1e-3')
        self.assertEqual(result['lines'][0]['confidence'], 0.01)
        self.assertEqual(result['lines'][0]['bbox'], [1, 2, 5, 6])
        self.assertEqual(result['lines'][0]['polygon'], [[1, 2], [5, 2], [4, 6], [1, 5]])
        self.assertEqual(result['lines'][1]['text'], ' 00.10 ')
        self.assertEqual(result['lines'][1]['confidence'], 0)
        self.assertEqual(result['image']['sha256'], hashlib.sha256(png()).hexdigest())
        json.dumps(result)

    def test_does_not_stringify_numbers_or_invent_confidence(self):
        def engine(_data):
            return {
                'boxes': [[0, 0, 1, 1], [1, 1, 2, 2]],
                'txts': (1.0, 'O0'),
                'scores': (float('nan'), 0.2),
            }

        result = po.recognize(png(), engine=engine, table_engine=lambda _data: [])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['lines'][0]['text'], None)
        self.assertIsNone(result['lines'][0]['confidence'])
        self.assertEqual(result['lines'][1]['text'], 'O0')
        self.assertIn('line-text-type', result['issues'])
        self.assertIn('nonfinite-confidence', result['issues'])
        self.assertNotIn('1.0', json.dumps(result['lines']))

    def test_mismatch_keeps_partial_fields(self):
        def engine(_data):
            return SimpleNamespace(
                boxes=[[(0, 0), (1, 0), (1, 1)]],
                txts=('a', 'b'),
                scores=(0.4,),
            )

        result = po.recognize(png(), engine=engine, table_engine=lambda _data: [])
        self.assertEqual(result['status'], 'partial')
        self.assertIn('line-field-mismatch', result['issues'])
        self.assertEqual(result['lines'][1]['text'], 'b')
        self.assertIsNone(result['lines'][1]['bbox'])
        self.assertIsNone(result['lines'][1]['confidence'])

    def test_orientation_is_recorded_only_when_supplied(self):
        def engine(_data):
            return {
                'lines': [{
                    'text': '−5%',
                    'confidence': 0.3,
                    'bbox': [0, 0, 3, 1],
                    'angle': 180,
                }],
                'transforms': [
                    {'op': 'deskew', 'angle': 1.5, 'coordinateSpace': 'original'},
                    {'op': 'page-rotate', 'angle': 90, 'coordinateSpace': 'rotated-image'},
                ],
            }

        result = po.recognize(png(), engine=engine, table_engine=lambda _data: [])
        self.assertEqual(result['lines'][0]['text'], '−5%')
        self.assertEqual(result['transforms'][0]['op'], 'deskew')
        self.assertEqual(result['transforms'][1]['coordinateSpace'], 'rotated-image')
        self.assertEqual(result['transforms'][2], {
            'op': 'textline-orientation', 'angle': 180, 'lineId': 'line-0',
            'coordinateSpace': 'original'})
        self.assertEqual(result['issues'], ['transform-coordinate-space'])
        self.assertEqual(result['status'], 'partial')

    def test_table_merge_empty_cell_and_distinct_repeats(self):
        merged = SimpleNamespace(
            bbox=_box(0, 0, 4, 4),
            title=None,
            content={
                0: [_cell(0, 0, 4, 2, '1.50'), _cell(0, 0, 4, 2, '1.50')],
                1: [_cell(0, 2, 2, 4, None), _cell(2, 2, 4, 4, '')],
            },
        )
        distinct = SimpleNamespace(
            bbox=_box(0, 0, 1, 2),
            title=None,
            content={0: [_cell(0, 0, 1, 1, '5')], 1: [_cell(0, 1, 1, 2, '5')]},
        )
        bent = SimpleNamespace(
            bbox=_box(0, 0, 2, 2),
            title='caption',
            content={
                0: [
                    SimpleNamespace(bbox=_box(0, 0, 2, 1), value='9'),
                    SimpleNamespace(bbox=_box(0, 0, 2, 1), value='9'),
                ],
                1: [
                    SimpleNamespace(bbox=_box(0, 0, 2, 1), value='9'),
                    SimpleNamespace(bbox=_box(1, 1, 2, 2), value='x'),
                ],
            },
        )

        def tables(data):
            return [merged, distinct] if data[:1] else [bent]

        straight = po.recognize(png(), engine=_empty_lines, table_engine=tables)
        self.assertEqual(straight['status'], 'ready')
        span = straight['tables'][0]['cells']
        self.assertEqual(span[0]['rowSpan'], 1)
        self.assertEqual(span[0]['columnSpan'], 2)
        self.assertEqual(span[0]['text'], '1.50')
        self.assertIsNone(span[0]['confidence'])
        self.assertIsNone(span[1]['text'])
        self.assertEqual(span[2]['text'], '')
        self.assertEqual(straight['tables'][0]['rows'], 2)
        self.assertEqual(straight['tables'][0]['columns'], 2)
        self.assertEqual(len(straight['tables'][1]['cells']), 2)
        self.assertTrue(all(cell['columnSpan'] == 1 for cell in straight['tables'][1]['cells']))

        bent_result = po.recognize(png(color=(1, 2, 3)), engine=_empty_lines, table_engine=lambda _data: [bent])
        self.assertEqual(bent_result['status'], 'partial')
        self.assertIn('table-span-nonrectangular', bent_result['issues'])
        self.assertEqual(bent_result['tables'][0]['title'], 'caption')
        self.assertEqual(sum(cell['text'] == '9' for cell in bent_result['tables'][0]['cells']), 3)

    def test_explicit_cells_keep_spans_and_raw_text(self):
        def tables(_data):
            return {
                'bbox': [0, 0, 4, 4],
                'title': 'Table 1',
                'cells': [
                    {'row': 0, 'column': 0, 'rowSpan': 1, 'columnSpan': 2, 'text': '1O0', 'bbox': [0, 0, 4, 2]},
                    {'row': 1, 'column': 0, 'text': None, 'bbox': [0, 2, 2, 4], 'confidence': 0.2},
                ],
            }

        class ByMethod:
            def extract_tables(self, data):
                return tables(data)

        result = po.recognize(png(), engine=_empty_lines, table_engine=ByMethod())
        cells = result['tables'][0]['cells']
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(cells[0]['text'], '1O0')
        self.assertEqual(cells[0]['columnSpan'], 2)
        self.assertIsNone(cells[0]['confidence'])
        self.assertIsNone(cells[1]['text'])
        self.assertEqual(cells[1]['confidence'], 0.2)
        self.assertEqual(result['tables'][0]['rows'], 2)
        self.assertEqual(result['tables'][0]['columns'], 2)
        self.assertEqual(result['provenance']['engine'], 'injected')
        self.assertEqual(result['provenance']['version'], 'injected')

    def test_engine_failure_is_partial_and_both_failures_are_unavailable(self):
        def boom(_data):
            raise RuntimeError('disk path')

        def tables(_data):
            return [{'bbox': [0, 0, 1, 1], 'title': None, 'cells': [
                {'row': 0, 'column': 0, 'text': '4', 'bbox': [0, 0, 1, 1]}]}]

        partial = po.recognize(png(), engine=boom, table_engine=tables)
        self.assertEqual(partial['status'], 'partial')
        self.assertEqual(partial['issues'], ['line-engine:RuntimeError'])
        self.assertEqual(partial['tables'][0]['cells'][0]['text'], '4')
        self.assertNotIn('disk', json.dumps(partial['issues']))
        both = po.recognize(png(), engine=boom, table_engine=boom)
        self.assertEqual(both['status'], 'unavailable')
        self.assertEqual(both['issues'], ['line-engine:RuntimeError', 'table-engine:RuntimeError'])

    def test_default_engines_use_pinned_apis_and_cache(self):
        saved = _install_fakes()
        versions = {'rapidocr': po.RAPIDOCR_VERSION, 'img2table': po.IMG2TABLE_VERSION}
        try:
            with patch.object(po, '_distribution_version', side_effect=versions.__getitem__):
                image = png()
                first = po.recognize(image, language='en')
                second = po.recognize(image, language='korean')
            self.assertEqual(first['status'], 'ready')
            self.assertEqual(first['language'], 'en')
            self.assertEqual(first['transforms'], [])
            self.assertEqual(first['provenance']['engine'], 'rapidocr+img2table')
            self.assertEqual(first['provenance']['version'], 'rapidocr==3.10.0,img2table==2.0.0')
            self.assertEqual(first['provenance']['model'], 'en_PP-OCRv5_rec_mobile')
            self.assertIn('text_score=0', first['provenance']['method'])
            self.assertIn('min_confidence=1', first['provenance']['method'])
            self.assertIn('detect_rotation=false', first['provenance']['method'])
            params = FakeImage.last.kwargs['ocr'].params
            self.assertIs(params['Rec.lang_type'], LangRec.KOREAN)
            self.assertIs(params['Rec.model_type'], ModelType.MOBILE)
            self.assertIs(params['Rec.ocr_version'], OCRVersion.PPOCRV5)
            self.assertIs(params['Det.engine_type'], EngineType.ONNXRUNTIME)
            self.assertEqual(params['Global.text_score'], 0.0)
            self.assertEqual(params['EngineConfig.onnxruntime.intra_op_num_threads'], 1)
            self.assertEqual(params['EngineConfig.onnxruntime.inter_op_num_threads'], 1)
            self.assertFalse(FakeImage.last.detect_rotation)
            self.assertEqual(FakeImage.last.kwargs['min_confidence'], 1)
            self.assertEqual(FakeImage.last.kwargs['max_workers'], 1)
            self.assertTrue(FakeImage.last.kwargs['implicit_rows'])
            self.assertTrue(FakeImage.last.kwargs['implicit_columns'])
            self.assertTrue(FakeImage.last.kwargs['borderless_tables'])
            self.assertEqual(FakeImage.last.src, image)
            self.assertIs(po._LINE_ENGINES['en'].params['Rec.lang_type'], LangRec.EN)
            self.assertEqual(second['language'], 'ko')
            self.assertEqual(second['provenance']['model'], 'korean_PP-OCRv5_rec_mobile')
            self.assertEqual(LineRapid.inits, 2)
            self.assertEqual(TableRapid.inits, 2)
            with patch.object(po, '_distribution_version', side_effect=versions.__getitem__):
                po.recognize(image, language='en')
            self.assertEqual(LineRapid.inits, 2)
            self.assertEqual(po._LINE_ENGINES['en'].calls, [0.0, 0.0])
        finally:
            _restore(saved)

    def test_version_mismatch_still_returns_output(self):
        saved = _install_fakes()
        try:
            def versions(name):
                return {'rapidocr': '3.9.0', 'img2table': '2.0.0'}[name]

            with patch.object(po, '_distribution_version', side_effect=versions):
                result = po.recognize(png())
            self.assertEqual(result['status'], 'partial')
            self.assertIn('rapidocr-version:3.9.0', result['issues'])
            self.assertEqual(result['provenance']['version'], 'rapidocr==3.9.0,img2table==2.0.0')
            self.assertEqual(result['lines'], [])
            self.assertEqual(result['tables'], [])
        finally:
            _restore(saved)

    def test_missing_default_package_is_unavailable(self):
        saved = {name: sys.modules.get(name) for name in (
            'rapidocr', 'img2table', 'img2table.document', 'img2table.ocr')}
        for name in saved:
            sys.modules.pop(name, None)
        real_import = __import__

        def guarded(name, globals=None, locals=None, fromlist=(), level=0):
            root = name.split('.')[0]
            if root in ('rapidocr', 'img2table'):
                error = ModuleNotFoundError(f'No module named {name}')
                error.name = name
                raise error
            return real_import(name, globals, locals, fromlist, level)

        try:
            with patch('builtins.__import__', side_effect=guarded):
                result = po.recognize(png())
            self.assertEqual(result['status'], 'unavailable')
            self.assertIn('rapidocr-missing', result['issues'])
        finally:
            _restore(saved)


    def test_majority_vertical_is_strict_and_unmap_is_clockwise_inverse(self):
        self.assertFalse(po._majority_vertical([
            {'bbox': [0, 0, 1, 4]},
            {'bbox': [0, 0, 4, 1]},
        ]))
        self.assertTrue(po._majority_vertical([
            {'bbox': [0, 0, 1, 4]},
            {'bbox': [0, 0, 2, 5]},
            {'bbox': [0, 0, 4, 1]},
        ]))
        self.assertFalse(po._majority_vertical([{'bbox': [0, 0, 2, 2]}]))
        self.assertEqual(po._unmap_cw90(44, 49, 1200), (49, 1156))
        self.assertEqual(po._unmap_box([44, 49, 550, 100], 1200), [49, 650, 100, 1156])
        self.assertEqual(
            po._unmap_polygon([[44, 49], [550, 49], [550, 100], [44, 100]], 1200),
            [[49, 1156], [49, 650], [100, 650], [100, 1156]])

    def test_default_page_maps_clockwise_rotation_back_to_input(self):
        image = png(width=800, height=1200)
        turned = b'rotated-png'
        seen = []

        def lines(data, language, issues, versions):
            seen.append(data)
            if data == image:
                return True, [{
                    'id': 'line-0',
                    'text': 'N',
                    'confidence': 0.2,
                    'bbox': [0, 0, 10, 40],
                }], []
            return True, [{
                'id': 'line-0',
                'text': '7.8',
                'confidence': 0.2,
                'bbox': [44, 49, 550, 100],
                'polygon': [[44, 49], [550, 49], [550, 100], [44, 100]],
            }], []

        def tables(data, language, issues, versions):
            seen.append(('tables', data))
            return True, [{
                'bbox': [44, 49, 550, 100],
                'rows': 1,
                'columns': 1,
                'title': None,
                'cells': [{
                    'row': 0, 'column': 0, 'rowSpan': 1, 'columnSpan': 1,
                    'text': '6.2', 'bbox': [44, 49, 550, 100], 'confidence': None,
                }],
            }], []

        with patch.object(po, '_default_lines', side_effect=lines), \
                patch.object(po, '_default_tables', side_effect=tables), \
                patch.object(po, '_rotate_png_90_cw', return_value=turned):
            result = po.recognize(image)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['image']['sha256'], hashlib.sha256(image).hexdigest())
        self.assertEqual(result['image']['width'], 800)
        self.assertEqual(result['image']['height'], 1200)
        self.assertEqual(result['lines'][0]['text'], '7.8')
        self.assertEqual(result['lines'][0]['bbox'], [49, 650, 100, 1156])
        self.assertEqual(result['lines'][0]['polygon'][0], [49, 1156])
        self.assertEqual(result['tables'][0]['cells'][0]['text'], '6.2')
        self.assertEqual(result['tables'][0]['bbox'], [49, 650, 100, 1156])
        self.assertEqual(result['transforms'], [{
            'op': 'page-rotate',
            'angle': 90,
            'direction': 'clockwise',
            'coordinateSpace': 'original',
        }])
        self.assertEqual(seen[0], image)
        self.assertEqual(seen[1], turned)
        self.assertEqual(seen[2], ('tables', turned))

    def test_horizontal_default_page_is_not_rotated(self):
        image = png(width=8, height=4)

        def lines(data, language, issues, versions):
            return True, [{
                'id': 'line-0', 'text': '7.8', 'confidence': 0.4, 'bbox': [0, 0, 6, 1],
            }], []

        def tables(data, language, issues, versions):
            tables.data = data
            return True, [], []

        with patch.object(po, '_default_lines', side_effect=lines), \
                patch.object(po, '_default_tables', side_effect=tables), \
                patch.object(po, '_rotate_png_90_cw', side_effect=AssertionError('rotated')):
            result = po.recognize(image)
        self.assertEqual(result['transforms'], [])
        self.assertEqual(result['lines'][0]['text'], '7.8')
        self.assertIs(tables.data, image)

    def test_still_vertical_after_rotation_keeps_the_first_pass(self):
        image = png(width=4, height=10)
        calls = []

        def lines(data, language, issues, versions):
            calls.append(data)
            return True, [{
                'id': 'line-0', 'text': 'N', 'confidence': 0.2, 'bbox': [0, 0, 1, 8],
            }], []

        def tables(data, language, issues, versions):
            tables.data = data
            return True, [], []

        with patch.object(po, '_default_lines', side_effect=lines), \
                patch.object(po, '_default_tables', side_effect=tables), \
                patch.object(po, '_rotate_png_90_cw', return_value=b'rot'):
            result = po.recognize(image)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result['transforms'], [])
        self.assertEqual(result['lines'][0]['bbox'], [0, 0, 1, 8])
        self.assertEqual(result['lines'][0]['text'], 'N')
        self.assertIs(tables.data, image)

    def test_rotate_failure_keeps_original_boxes(self):
        image = png(width=4, height=10)

        def lines(data, language, issues, versions):
            return True, [{
                'id': 'line-0', 'text': '7.8', 'confidence': 0.2, 'bbox': [0, 0, 1, 8],
            }], []

        def tables(data, language, issues, versions):
            tables.data = data
            return True, [], []

        with patch.object(po, '_default_lines', side_effect=lines), \
                patch.object(po, '_default_tables', side_effect=tables), \
                patch.object(po, '_rotate_png_90_cw', return_value=None):
            result = po.recognize(image)
        self.assertEqual(result['status'], 'partial')
        self.assertIn('page-rotate-unavailable', result['issues'])
        self.assertEqual(result['lines'][0]['bbox'], [0, 0, 1, 8])
        self.assertEqual(result['transforms'], [])
        self.assertIs(tables.data, image)

    def test_injected_engines_are_not_rotated(self):
        image = png(width=4, height=10)
        seen = []

        def engine(data):
            seen.append(('line', data))
            return {'lines': [{
                'text': '7.8', 'confidence': 0.2, 'bbox': [0, 0, 1, 8],
            }]}

        def tables(data):
            seen.append(('table', data))
            return []

        with patch.object(po, '_rotate_png_90_cw', side_effect=AssertionError('rotated')):
            both = po.recognize(image, engine=engine, table_engine=tables)
        self.assertEqual(both['transforms'], [])
        self.assertEqual(both['lines'][0]['bbox'], [0, 0, 1, 8])
        self.assertEqual(both['lines'][0]['text'], '7.8')
        self.assertEqual(seen, [('line', image), ('table', image)])

        def default_lines(data, language, issues, versions):
            return True, [{
                'id': 'line-0', 'text': '7.8', 'confidence': 0.2, 'bbox': [0, 0, 1, 8],
            }], []

        seen.clear()
        with patch.object(po, '_default_lines', side_effect=default_lines), \
                patch.object(po, '_rotate_png_90_cw', side_effect=AssertionError('rotated')):
            mixed = po.recognize(image, table_engine=tables)
        self.assertEqual(mixed['provenance']['engine'], 'rapidocr+injected')
        self.assertEqual(mixed['transforms'], [])
        self.assertEqual(mixed['lines'][0]['bbox'], [0, 0, 1, 8])
        self.assertEqual(seen, [('table', image)])


if __name__ == '__main__':
    unittest.main()

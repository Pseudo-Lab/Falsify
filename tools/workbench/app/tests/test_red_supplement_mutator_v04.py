"""Surgical xlsx/ipynb RED mutations, planner L4 semantics, and the v0.4 runner."""
import ast
import base64
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
V04 = ROOT / 'app' / 'examples' / 'adversarial_red_v04'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

from paper_evidence import EvidenceStore  # noqa: E402
from paper_red_errors import VALID_KINDS, error_surface  # noqa: E402
from paper_red_mcp import build_server  # noqa: E402
from paper_red_planner import plan_coordinated_mutations  # noqa: E402
from paper_supplement_mutator import (  # noqa: E402
    SpanMutationError,
    apply_extended_supplement_mutations,
    load_red_supplements_extended,
)
from paper_tabular_notebook_loader import parse_xlsx_workbook  # noqa: E402

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
_PRODUCTION = (
    LOCAL / 'paper_supplement_mutator.py',
    LOCAL / 'paper_red_errors.py',
    LOCAL / 'paper_red_mcp.py',
    LOCAL / 'paper_red_planner.py',
    V04 / 'runner.py',
    V04 / 'build_profile.py',
)


def _pdf(lines):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for index, line in enumerate(lines):
        page.insert_text((72, 72 + index * 22), line, fontsize=11, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _bind(raw):
    store = EvidenceStore()
    digest = hashlib.sha256(raw).hexdigest()
    paper_id = store.prepare(raw, digest)['paperId']
    return store, paper_id, digest


def _sheet_xml(rows):
    body = []
    for ref, value, formula, shared, style in rows:
        attrs = f' r="{ref}"'
        if style:
            attrs += f' s="{style}"'
        if shared:
            attrs += ' t="s"'
        formula_xml = f'<f>{formula}</f>' if formula else ''
        body.append(f'<c{attrs}>{formula_xml}<v>{value}</v></c>')
    inner = ''.join(body)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{NS}"><sheetData><row r="1">{inner}</row></sheetData></worksheet>'
    )


def _workbook(sheets, shared=('Panel',), note=b'zip-note'):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as book:
        for name, xml in sheets.items():
            book.writestr(name, xml)
        items = ''.join(f'<si><t>{text}</t></si>' for text in shared)
        book.writestr(
            'xl/sharedStrings.xml',
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<sst xmlns="{NS}">{items}</sst>',
        )
        book.writestr('xl/media/note.txt', note)
    return buf.getvalue()


def _sample_workbook():
    sheet = _sheet_xml((
        ('C15', '84', 'SUM(C2:C7)', False, '4'),
        ('A3', '0', None, True, '2'),
        ('B4', 'keep-me', None, False, None),
        ('D5', 'other', None, False, None),
        ('E6', 'anchor', None, False, None),
        ('F7', '0.94', None, False, None),
    ))
    notes = _sheet_xml((('A1', 'NotesMarker', None, False, None),))
    return _workbook({
        'xl/worksheets/sheet1.xml': sheet,
        'xl/worksheets/sheet2.xml': notes,
    })


def _members(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as book:
        return {info.filename: book.read(info) for info in book.infolist()}


def _parsed_values(raw):
    parsed = parse_xlsx_workbook(raw, name='cohort.xlsx')
    return parsed['sheets']


def _notebook(count='3'):
    return {
        'nbformat': 4,
        'nbformat_minor': 5,
        'metadata': {},
        'cells': [
            {
                'cell_type': 'code',
                'execution_count': int(count),
                'source': ['AUC = 0.94\n'],
                'outputs': [{'output_type': 'stream', 'name': 'stdout', 'text': ['84\n']}],
            },
            {'cell_type': 'markdown', 'metadata': {}, 'source': ['keep this cell\n']},
        ],
    }


def _apply(records, op):
    return apply_extended_supplement_mutations(records, [op])


def _decode(record):
    return base64.b64decode(record['contentBase64'])


def _load_module(filename, module_name):
    spec = importlib.util.spec_from_file_location(module_name, V04 / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _function_rows(path):
    tool = ROOT / 'tools' / 'quality' / 'python-functions.py'
    proc = subprocess.run(
        [sys.executable, str(tool)], input=path.read_bytes(), capture_output=True, check=True,
    )
    return json.loads(proc.stdout.decode('utf-8'))


class SupplementMutatorV04Tests(unittest.TestCase):
    def test_error_surface_names_xlsx_and_ipynb(self):
        self.assertIn('xlsx-cell', VALID_KINDS)
        self.assertIn('ipynb-cell', VALID_KINDS)
        self.assertEqual(error_surface('xlsx_cell_before_mismatch'), 'xlsx')
        self.assertEqual(error_surface('xlsx_sheet_not_found'), 'xlsx')
        self.assertEqual(error_surface('ipynb_cell_before_mismatch'), 'ipynb')
        self.assertEqual(error_surface('ipynb_cell_out_of_range'), 'ipynb')

    def test_xlsx_cell_keeps_formula_style_and_other_entries(self):
        raw = _sample_workbook()
        other = _sample_workbook()
        folder_note = b'zip-note'
        loaded = load_red_supplements_extended([])
        self.assertEqual(loaded, [])
        records = [
            {'name': 'cohort.xlsx', 'format': 'xlsx', 'contentBase64': base64.b64encode(raw).decode('ascii')},
            {'name': 'other.xlsx', 'format': 'xlsx', 'contentBase64': base64.b64encode(other).decode('ascii')},
        ]
        from paper_supplement_mutator import normalize_red_supplements_extended
        loaded = normalize_red_supplements_extended(records)
        result = _apply(loaded, {
            'kind': 'xlsx-cell',
            'supplementId': loaded[0]['supplementId'],
            'sheet': 'Sheet1',
            'cell': 'C15',
            'before': '84',
            'after': '168',
        })
        mutated = _decode(result['blindSupplements'][0])
        untouched = _decode(result['blindSupplements'][1])
        self.assertEqual(untouched, other)
        self.assertNotEqual(mutated, raw)
        sheets = _parsed_values(mutated)
        self.assertEqual(sheets[0]['values']['C15'], '168')
        self.assertEqual(sheets[0]['formulaCells'][0]['formula'], 'SUM(C2:C7)')
        self.assertEqual(sheets[0]['values']['A3'], 'Panel')
        xml = _members(mutated)['xl/worksheets/sheet1.xml'].decode('utf-8')
        self.assertIn('s="4"', xml)
        self.assertIn('SUM(C2:C7)', xml)
        before = _members(raw)
        after = _members(mutated)
        self.assertEqual(after['xl/media/note.txt'], folder_note)
        self.assertEqual(after['xl/sharedStrings.xml'], before['xl/sharedStrings.xml'])
        self.assertEqual(after['xl/worksheets/sheet2.xml'], before['xl/worksheets/sheet2.xml'])
        again = _apply(loaded, {
            'kind': 'xlsx-cell', 'name': 'cohort.xlsx', 'cell': 'C15', 'before': '84', 'after': '168',
        })
        self.assertEqual(again['blindSupplements'][0]['contentBase64'], result['blindSupplements'][0]['contentBase64'])

    def test_xlsx_shared_string_formula_and_self_healing(self):
        raw = _sample_workbook()
        from paper_supplement_mutator import normalize_red_supplements_extended
        loaded = normalize_red_supplements_extended([{
            'name': 'cohort.xlsx', 'contentBase64': base64.b64encode(raw).decode('ascii'),
        }])
        sid = loaded[0]['supplementId']
        shared = _apply(loaded, {
            'kind': 'xlsx-cell', 'supplementId': sid, 'sheet': 'sheet1', 'cell': 'A3',
            'before': 'Panel', 'after': 'Cohort',
        })
        mutated = _decode(shared['blindSupplements'][0])
        xml = _members(mutated)['xl/worksheets/sheet1.xml'].decode('utf-8')
        self.assertIn('inlineStr', xml)
        self.assertIn('Cohort', xml)
        self.assertIn('s="2"', xml)
        self.assertEqual(_parsed_values(mutated)[0]['values']['A3'], 'Cohort')
        revised = _apply(loaded, {
            'kind': 'xlsx-cell', 'supplementId': sid, 'cell': 'C15',
            'before': '84', 'after': '168', 'afterFormula': 'SUM(C2:C8)',
        })
        formula = _parsed_values(_decode(revised['blindSupplements'][0]))[0]['formulaCells'][0]
        self.assertEqual(formula['formula'], 'SUM(C2:C8)')
        self.assertEqual(formula['cachedValue'], '168')
        cleared = _apply(loaded, {
            'kind': 'xlsx-cell', 'supplementId': sid, 'cell': 'C15',
            'before': '84', 'after': '168', 'afterFormula': '',
        })
        self.assertEqual(_parsed_values(_decode(cleared['blindSupplements'][0]))[0]['formulaCells'], [])
        with self.assertRaises(SpanMutationError) as mismatch:
            _apply(loaded, {
                'kind': 'xlsx-cell', 'supplementId': sid, 'cell': 'C15', 'before': '99', 'after': '1',
            })
        details = mismatch.exception.details
        self.assertEqual(details['error'], 'xlsx_cell_before_mismatch')
        self.assertLessEqual(len(details['nearestCandidates']), 5)
        self.assertGreaterEqual(len(details['nearestCandidates']), 1)
        self.assertIn('sheet', details['nearestCandidates'][0])
        self.assertIn('recoveryHint', details)
        with self.assertRaises(SpanMutationError) as missing:
            _apply(loaded, {
                'kind': 'xlsx-cell', 'supplementId': sid, 'sheet': 'Missing', 'cell': 'A1',
                'before': 'x', 'after': 'y',
            })
        self.assertEqual(missing.exception.details['error'], 'xlsx_sheet_not_found')
        with self.assertRaises(SpanMutationError) as hinted:
            _apply(loaded, {
                'kind': 'xlsx-cell', 'supplementId': sid, 'cell': 'C15',
                'before': '84', 'after': 'falsify-red',
            })
        self.assertEqual(hinted.exception.details['error'], 'blindness_hint_token_forbidden')

    def test_ipynb_cell_targets_and_errors(self):
        raw = (json.dumps(_notebook()) + '\n').encode('utf-8')
        other = raw
        from paper_supplement_mutator import normalize_red_supplements_extended
        loaded = normalize_red_supplements_extended([
            {'name': 'notes.ipynb', 'contentBase64': base64.b64encode(raw).decode('ascii')},
            {'name': 'other.ipynb', 'contentBase64': base64.b64encode(other).decode('ascii')},
        ])
        sid = loaded[0]['supplementId']
        output = _apply(loaded, {
            'kind': 'ipynb-cell', 'supplementId': sid, 'cellIndex': 0,
            'target': 'output', 'before': '84\n', 'after': '168\n',
        })
        changed = json.loads(output['blindSupplements'][0]['text'])
        self.assertEqual(changed['cells'][0]['outputs'][0]['text'], ['168\n'])
        self.assertEqual(_decode(output['blindSupplements'][1]), other)
        source = _apply(loaded, {
            'kind': 'ipynb-cell', 'name': 'notes.ipynb', 'cellIndex': 0,
            'target': 'source', 'before': '0.94', 'after': '0.91',
        })
        edited = json.loads(source['blindSupplements'][0]['text'])
        self.assertIsInstance(edited['cells'][0]['source'], list)
        self.assertIn('0.91', ''.join(edited['cells'][0]['source']))
        counted = _apply(loaded, {
            'kind': 'ipynb-cell', 'supplementId': sid, 'cellIndex': 0,
            'target': 'execution_count', 'before': '3', 'after': '9',
        })
        self.assertEqual(json.loads(counted['blindSupplements'][0]['text'])['cells'][0]['execution_count'], 9)
        with self.assertRaises(SpanMutationError) as out_of_range:
            _apply(loaded, {
                'kind': 'ipynb-cell', 'supplementId': sid, 'cellIndex': 9,
                'target': 'source', 'before': '0.94', 'after': '0.91',
            })
        self.assertEqual(out_of_range.exception.details['error'], 'ipynb_cell_out_of_range')
        self.assertIn('cellIndex', out_of_range.exception.details['nearestCandidates'][0])
        with self.assertRaises(SpanMutationError) as mismatch:
            _apply(loaded, {
                'kind': 'ipynb-cell', 'supplementId': sid, 'cellIndex': 0,
                'target': 'source', 'before': 'missing-token', 'after': '0.91',
            })
        self.assertEqual(mismatch.exception.details['error'], 'ipynb_cell_before_mismatch')
        with self.assertRaises(SpanMutationError) as hinted:
            _apply(loaded, {
                'kind': 'ipynb-cell', 'supplementId': sid, 'cellIndex': 0,
                'target': 'output', 'before': '84\n', 'after': 'answer-key',
            })
        self.assertEqual(hinted.exception.details['error'], 'blindness_hint_token_forbidden')

    def test_mcp_red_brief_plan_and_structured_export(self):
        import anyio
        raw = _pdf(['Primary cohort showed AUC = 0.94 in training.'])
        store, paper_id, digest = _bind(raw)
        workbook = _sample_workbook()
        notebook = (json.dumps(_notebook()) + '\n').encode('utf-8')
        server = build_server(store, paper_id, digest, supplements=[
            {'name': 'cohort.xlsx', 'contentBase64': base64.b64encode(workbook).decode('ascii')},
            {'name': 'notes.ipynb', 'contentBase64': base64.b64encode(notebook).decode('ascii')},
        ])
        tool = server._tool_manager._tools['plan_coordinated_mutation']
        self.assertEqual(
            set(tool.parameters['properties']),
            {'paperId', 'targetDifficulty', 'maxBundles', 'claimQuery'},
        )

        async def planned():
            return await tool.fn(
                paper_id, 'L3', 5, None, redBrief={'preferredSurfaces': ['prose', 'supplement']},
            )

        result = anyio.run(planned)
        self.assertFalse(result.isError, result)
        bundles = result.structuredContent['bundles']
        kinds = {op['kind'] for bundle in bundles for op in bundle['operations']}
        self.assertIn('text-span', kinds)
        self.assertTrue(kinds & {'xlsx-cell', 'ipynb-cell'})

        async def rejected():
            return await tool.fn(paper_id, redBrief={'gold': 'hidden'})

        denied = anyio.run(rejected)
        self.assertTrue(denied.isError)
        self.assertEqual(denied.structuredContent['error'], 'red_brief_forbidden_key')

        export = server._tool_manager._tools['export_coordinated_edits']

        async def exported():
            return await export.fn(paper_id, [
                {
                    'id': 'xlsx-export', 'kind': 'xlsx-cell', 'name': 'cohort.xlsx',
                    'sheet': 'Sheet1', 'cell': 'A3', 'before': 'Panel', 'after': 'Cohort',
                },
                {
                    'id': 'ipynb-export', 'kind': 'ipynb-cell', 'name': 'notes.ipynb',
                    'cellIndex': 0, 'target': 'output', 'before': '84\n', 'after': '168\n',
                },
            ], False)

        saved = anyio.run(exported)
        self.assertFalse(saved.isError, saved)
        blind = {rec['name']: rec for rec in saved.structuredContent['blindSupplements']}
        edited_book = _decode(blind['cohort.xlsx'])
        self.assertEqual(_parsed_values(edited_book)[0]['values']['A3'], 'Cohort')
        self.assertIn('168', blind['notes.ipynb']['text'])
        self.assertNotIn('pdfBytes', json.dumps(saved.structuredContent))

    def test_l4_semantic_templates_stay_silent(self):
        raw = _pdf([
            'Abstract. The marker was correlated with recovery.',
            'Result. The assay had a higher error than control.',
            'Conclusion. The secondary outcome stayed descriptive.',
        ])
        store, paper_id, digest = _bind(raw)
        plan = plan_coordinated_mutations(
            paper_id, file_hash=digest, store=store, target_difficulty='L4', max_bundles=8,
            red_brief={'targetFamilies': ['D5']},
        )
        bundles = plan['bundles']
        self.assertGreaterEqual(len(bundles), 1)
        first = bundles[0]
        self.assertEqual(first['operations'][0]['family'], 'D5')
        self.assertFalse(first['layer0Triggered'])
        self.assertEqual(first['effectiveDifficulty'], 'L4')
        families = {op['family'] for bundle in bundles for op in bundle['operations']}
        self.assertTrue({'D3', 'S1', 'D5'} <= families)
        for bundle in bundles:
            if bundle['operations'][0]['family'] not in ('D3', 'S1', 'D5'):
                continue
            self.assertFalse(bundle['layer0Triggered'])
            self.assertEqual(bundle['effectiveDifficulty'], 'L4')

    def test_v04_profile_offline_count_and_ccn(self):
        previous = sys.modules.get('runner')
        runner = _load_module('runner.py', 'falsify_test_red_v04_runner')
        sys.modules['runner'] = runner
        try:
            profile_mod = _load_module('build_profile.py', 'falsify_test_red_v04_build_profile')
            profile = profile_mod.build()
        finally:
            if previous is None:
                sys.modules.pop('runner', None)
            else:
                sys.modules['runner'] = previous
        self.assertEqual(runner.VERSION, '0.4.0')
        self.assertEqual(runner.PROFILE_ID, 'shinick-adversarial-red-v04')
        self.assertEqual(runner.AUDIT_SCHEMA, 'falsify.red-runner-audit.v0.4')
        self.assertEqual(profile['id'], runner.PROFILE_ID)
        self.assertEqual(profile['version'], runner.VERSION)
        self.assertEqual(profile['role'], 'red')
        tree = ast.parse((V04 / 'test_offline.py').read_text(encoding='utf-8'))
        names = [
            node.name
            for klass in tree.body if isinstance(klass, ast.ClassDef)
            for node in klass.body if isinstance(node, ast.FunctionDef) and node.name.startswith('test_')
        ]
        self.assertGreaterEqual(len(names), 7)
        hot = []
        for path in _PRODUCTION:
            for row in _function_rows(path):
                if row['ccn'] > 15:
                    hot.append(path.name + ':' + row['id'] + ':' + str(row['ccn']))
        self.assertEqual(hot, [])
        self.assertIs(sys.modules.get('runner'), previous)


if __name__ == '__main__':
    unittest.main()

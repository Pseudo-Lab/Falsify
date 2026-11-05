"""Evidence store tests on synthetic in-memory PDFs. No private papers, no disk fixtures."""
import base64
import hashlib
import json
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_evidence as pe
import paper_evidence_http as http
import pymupdf

sha = lambda data: hashlib.sha256(data).hexdigest()


def draw_table(page):
    specs = [(0, 0, 1, 1, 'Metric'), (0, 1, 1, 2, 'Groups'), (1, 0, 2, 1, 'span'),
        (1, 1, 1, 1, '1'), (1, 2, 1, 1, '2'), (2, 1, 1, 1, ''), (2, 2, 1, 1, '5')]
    origin, col_w, row_h = (72, 90), 100, 28
    for r, c, rs, cs, text in specs:
        rect = pymupdf.Rect(origin[0] + c * col_w, origin[1] + r * row_h,
            origin[0] + (c + cs) * col_w, origin[1] + (r + rs) * row_h)
        page.draw_rect(rect, color=(0, 0, 0), width=1)
        if text:
            page.insert_textbox(pymupdf.Rect(rect.x0 + 3, rect.y0 + 6, rect.x1 - 3, rect.y1 - 3),
                text, fontsize=10, fontname='helv')


def sample_pdf(rotate=0, crop=None, pages=1):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 78), 'Table 1. Merged', fontsize=11)
    draw_table(page)
    page.insert_text((72, 328), 'Figure 1. Mark', fontsize=11)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
    pix.clear_with(80)
    page.insert_image(pymupdf.Rect(72, 336, 160, 420), pixmap=pix)
    page.draw_rect(pymupdf.Rect(400, 500, 520, 620), color=(0, 0, 1), width=1.2)
    if crop:
        page.set_cropbox(pymupdf.Rect(*crop))
    if rotate:
        page.set_rotation(rotate)
    for _ in range(pages - 1):
        extra = doc.new_page(width=595, height=842)
        extra.insert_text((72, 80), 'second page', fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def page_rect(data, index=0):
    doc = pymupdf.open(stream=data, filetype='pdf')
    try:
        return pymupdf.Rect(doc[index].rect)
    finally:
        doc.close()


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class EvidenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = pe.EvidenceStore(ttl_seconds=100, max_documents=4, clock=self.clock)
        self.pdf = sample_pdf()
        self.hash = sha(self.pdf)

    def prepare(self, data=None):
        data = self.pdf if data is None else data
        return self.store.prepare(data, sha(data))

    def table_item(self, summary=None):
        summary = self.prepare() if summary is None else summary
        listed = self.store.list_items(summary['paperId'], kind='table')
        self.assertGreaterEqual(listed['total'], 1)
        body = self.store.read_item(summary['paperId'], listed['items'][0]['id'])
        return summary, body

    def test_merged_missing_cells_and_raw_text(self):
        summary, body = self.table_item()
        self.assertEqual(set(summary), {'schema', 'paperId', 'fileHash', 'status', 'pageCount', 'counts',
            'engine', 'limitations', 'expiresAt'})
        self.assertEqual(summary['schema'], pe.SCHEMA)
        self.assertEqual(summary['status'], 'ready')
        self.assertEqual(summary['engine'], 'pymupdf')
        self.assertEqual(summary['fileHash'], self.hash)
        self.assertEqual(summary['pageCount'], 1)
        self.assertEqual(summary['counts']['figures'], 1)
        self.assertIn('vector_figures_not_detected', summary['limitations'])
        self.assertTrue(summary['paperId'])
        self.assertNotIn(self.hash, summary['paperId'])
        table = body['table']
        self.assertEqual((table['rows'], table['columns']), (3, 3))
        by_pos = {(cell['row'], cell['column']): cell for cell in table['cells']}
        self.assertEqual(set(by_pos), {(0, 0), (0, 1), (1, 0), (1, 1), (1, 2), (2, 1), (2, 2)})
        self.assertEqual(by_pos[(0, 1)]['text'], 'Groups')
        self.assertEqual((by_pos[(0, 1)]['rowSpan'], by_pos[(0, 1)]['columnSpan']), (1, 2))
        self.assertEqual(by_pos[(0, 1)]['bbox'], [172.0, 90.0, 372.0, 118.0])
        self.assertEqual(by_pos[(1, 0)]['text'], 'span')
        self.assertEqual((by_pos[(1, 0)]['rowSpan'], by_pos[(1, 0)]['columnSpan']), (2, 1))
        self.assertEqual(by_pos[(2, 1)]['text'], '')
        self.assertTrue(all(cell['header'] is None for cell in table['cells']))
        self.assertTrue(all(isinstance(cell['text'], str) for cell in table['cells']))
        self.assertEqual(body['caption'].split('\n')[0], 'Table 1. Merged')
        self.assertFalse(body['provenance']['captionCertain'])
        self.assertEqual(body['provenance']['captionAssociation'], 'label-heuristic')
        self.assertEqual(body['provenance']['method'], 'Page.find_tables')
        self.assertEqual(body['provenance']['coordinateSpace'], 'page.rect')
        figures = self.store.list_items(summary['paperId'], kind='figure')
        self.assertEqual(figures['total'], 1)
        figure = figures['items'][0]
        self.assertEqual(figure['caption'].split('\n')[0], 'Figure 1. Mark')
        self.assertEqual(figure['provenance']['method'], 'Page.get_image_info')
        self.assertLess(figure['bbox'][0], 200)
        self.assertGreater(figure['bbox'][1], 300)
        listed = json.dumps(self.store.list_items(summary['paperId']))
        self.assertNotIn('"cells"', listed)
        self.assertNotIn('span', listed)

    def test_repeat_same_hash_reuses_and_other_hash_is_new(self):
        first = self.prepare()
        second = self.prepare()
        self.assertEqual(first['paperId'], second['paperId'])
        self.assertIn(self.store.read_item(first['paperId'],
            self.store.list_items(first['paperId'], kind='table')['items'][0]['id'])['table']['cells'][0]['text'],
            ('Metric', 'Groups'))
        doc = pymupdf.open()
        doc.new_page().insert_text((72, 80), 'other', fontsize=11)
        raw = doc.tobytes()
        doc.close()
        nxt = self.store.prepare(raw, sha(raw))
        self.assertNotEqual(nxt['paperId'], first['paperId'])
        self.assertEqual(self.store.status(first['paperId'])['paperId'], first['paperId'])
        self.clock.t += 1
        refreshed = self.store.prepare(self.pdf, self.hash)
        self.assertEqual(refreshed['paperId'], first['paperId'])
        self.assertGreater(refreshed['expiresAt'], first['expiresAt'])

    def test_expiry_eviction_and_invalid_ids(self):
        store = pe.EvidenceStore(ttl_seconds=10, max_documents=2, clock=self.clock)
        first = store.prepare(self.pdf, self.hash)
        self.clock.t += 9
        self.assertEqual(store.status(first['paperId'])['status'], 'ready')
        self.clock.t += 1
        with self.assertRaises(KeyError):
            store.status(first['paperId'])
        self.clock.t += 1
        again = store.prepare(self.pdf, self.hash)
        self.assertNotEqual(again['paperId'], first['paperId'])
        doc = pymupdf.open()
        doc.new_page().insert_text((72, 72), 'b', fontsize=11)
        b = doc.tobytes()
        doc.close()
        doc = pymupdf.open()
        doc.new_page().insert_text((72, 72), 'c', fontsize=11)
        c = doc.tobytes()
        doc.close()
        self.clock.t += 1
        second = store.prepare(b, sha(b))
        self.clock.t += 1
        third = store.prepare(c, sha(c))
        with self.assertRaises(KeyError):
            store.status(again['paperId'])
        self.assertEqual(store.status(second['paperId'])['fileHash'], sha(b))
        self.assertEqual(store.status(third['paperId'])['fileHash'], sha(c))
        with self.assertRaises(KeyError):
            store.read_item(third['paperId'], 'missing')
        with self.assertRaises(KeyError):
            store.status('not-a-real-paper')
        for bad in ('', None, 3):
            with self.assertRaises(ValueError) as caught:
                store.status(bad)
            self.assertEqual(caught.exception.args[0], 'paper_id')
        with self.assertRaises(ValueError) as caught:
            store.read_item(third['paperId'], '')
        self.assertEqual(caught.exception.args[0], 'item_id')

    def test_hash_and_pdf_rejection_stores_nothing(self):
        with self.assertRaises(ValueError) as caught:
            self.store.prepare(self.pdf, 'ab' * 32)
        self.assertEqual(caught.exception.args[0], 'hash_mismatch')
        with self.assertRaises(ValueError) as caught:
            self.store.prepare(self.pdf, 'AB' * 32)
        self.assertEqual(caught.exception.args[0], 'hash_invalid')
        with self.assertRaises(ValueError) as caught:
            self.store.prepare(b'hello', sha(b'hello'))
        self.assertEqual(caught.exception.args[0], 'pdf_invalid')
        enc = pymupdf.open(stream=self.pdf)
        secret = enc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw='u', owner_pw='o')
        enc.close()
        with self.assertRaises(ValueError) as caught:
            self.store.prepare(secret, sha(secret))
        self.assertEqual(caught.exception.args[0], 'pdf_invalid')
        with self.assertRaises(ValueError) as caught:
            self.store.list_items('missing', kind='paragraph')
        self.assertEqual(caught.exception.args[0], 'kind')
        self.assertEqual(self.store._docs, {})

    def test_crop_bounds_and_rotation_keep_text_in_page_rect(self):
        cropped = sample_pdf(crop=(40, 40, 500, 700))
        summary = self.store.prepare(cropped, sha(cropped))
        self.assertIn('cropped_or_offset_page:0', summary['limitations'])
        _summary, body = self.table_item(summary)
        self.assertEqual(body['table']['cells'][0]['text'] in ('Metric', 'Groups') or
            any(cell['text'] == 'Groups' for cell in body['table']['cells']), True)
        self.assertTrue(any(cell['text'] == 'Groups' and cell['columnSpan'] == 2 for cell in body['table']['cells']))
        self.assertLess(body['bbox'][0], 50)
        self.assertGreater(body['bbox'][0], 15)
        rect = page_rect(cropped)
        with self.assertRaises(ValueError) as caught:
            self.store.render_region(summary['paperId'], 0, bbox=[0, 0, 1000, 1000], dpi=72)
        self.assertEqual(caught.exception.args[0], 'bbox')
        self.assertLessEqual(body['bbox'][2], rect.x1 + 1)

        rotated = sample_pdf(rotate=90)
        summary = self.store.prepare(rotated, sha(rotated))
        self.assertIn('rotated_page:0', summary['limitations'])
        _summary, body = self.table_item(summary)
        self.assertTrue(any(cell['text'] == 'Groups' for cell in body['table']['cells']))
        self.assertTrue(any(cell['text'] == 'span' and cell['rowSpan'] == 2 for cell in body['table']['cells']))
        self.assertTrue(any(cell['text'] == '' for cell in body['table']['cells']))
        self.assertGreater(body['bbox'][0], 500)
        rot_rect = page_rect(rotated)
        for value in body['bbox']:
            self.assertGreaterEqual(value, -1)
        self.assertLessEqual(body['bbox'][2], rot_rect.x1 + 1)
        self.assertLessEqual(body['bbox'][3], rot_rect.y1 + 1)
        self.assertTrue(body['provenance']['rotationNormalized'])
        rendered = self.store.render_region(summary['paperId'], 0, bbox=body['bbox'], dpi=72)
        png = base64.b64decode(rendered['data'])
        self.assertEqual(rendered['sha256'], sha(png))
        self.assertTrue(png.startswith(b'\x89PNG\r\n\x1a\n'))
        width, height = struct.unpack('>II', png[16:24])
        self.assertEqual((rendered['width'], rendered['height'], rendered['mimeType']), (width, height, 'image/png'))
        self.assertLess(width, 200)
        self.assertGreater(height, 20)
        again = self.store.render_region(summary['paperId'], 0, bbox=body['bbox'], dpi=72)
        self.assertEqual(again['sha256'], rendered['sha256'])

        both = sample_pdf(rotate=90, crop=(40, 40, 500, 700))
        summary = self.store.prepare(both, sha(both))
        self.assertIn('rotated_page:0', summary['limitations'])
        self.assertIn('cropped_or_offset_page:0', summary['limitations'])
        _summary, body = self.table_item(summary)
        self.assertTrue(any(cell['text'] == 'Groups' and cell['columnSpan'] == 2 for cell in body['table']['cells']))
        rect = page_rect(both)
        self.assertGreaterEqual(body['bbox'][0], rect.x0 - 1)
        self.assertLessEqual(body['bbox'][2], rect.x1 + 1)
        self.assertLessEqual(body['bbox'][3], rect.y1 + 1)
        self.assertNotEqual([round(v, 1) for v in body['bbox']], [72.0, 90.0, 372.0, 174.0])

    def test_render_budget_and_full_page(self):
        summary = self.prepare()
        full = self.store.render_region(summary['paperId'], 0, dpi=72)
        self.assertEqual(full['bbox'][0], 0)
        self.assertGreater(full['width'] * full['height'], 1000)
        self.assertLessEqual(full['width'] * full['height'], pe.MAX_PIXELS)
        with self.assertRaises(ValueError) as caught:
            self.store.render_region(summary['paperId'], 0, dpi=300)
        self.assertEqual(caught.exception.args[0], 'pixels')
        with self.assertRaises(ValueError) as caught:
            self.store.render_region(summary['paperId'], 0, bbox=[72, 90, 272, 290], dpi=600)
        self.assertEqual(caught.exception.args[0], 'pixels')
        for bad in (0, -1, float('nan'), True, '120'):
            with self.assertRaises(ValueError) as caught:
                self.store.render_region(summary['paperId'], 0, dpi=bad)
            self.assertEqual(caught.exception.args[0], 'dpi')
        with self.assertRaises(ValueError) as caught:
            self.store.render_region(summary['paperId'], 3, dpi=72)
        self.assertEqual(caught.exception.args[0], 'page_index')
        with self.assertRaises(ValueError) as caught:
            self.store.render_region(summary['paperId'], 0, bbox=[10, 10, 4, 20])
        self.assertEqual(caught.exception.args[0], 'bbox')

    def test_source_bytes_stay_immutable(self):
        buf = bytearray(self.pdf)
        before = bytes(buf)
        summary = self.store.prepare(buf, self.hash)
        buf[0] = 0
        self.assertEqual(bytes(buf[:1]), b'\x00')
        self.assertEqual(before[:8], b'%PDF-1.7')
        body = self.store.read_item(summary['paperId'], self.store.list_items(summary['paperId'], kind='table')['items'][0]['id'])
        self.assertTrue(any(cell['text'] == 'Groups' for cell in body['table']['cells']))
        self.assertEqual(self.store._docs[summary['paperId']]['pdf'], before)
        body['table']['cells'][0]['text'] = 'mutated'
        fresh = self.store.read_item(summary['paperId'], body['id'])
        self.assertNotEqual(fresh['table']['cells'][0]['text'], 'mutated')

    def test_partial_page_keeps_the_other_page(self):
        data = sample_pdf(pages=2)
        real = pe._find_tables

        def boom(page, real=real):
            if page.number == 1:
                raise RuntimeError('synthetic page failure: do not leak')
            return real(page)

        with patch('paper_evidence._find_tables', boom), patch('paper_native_worker.run', side_effect=lambda operation,args,**kwargs: self.store._extract(*args)):
            summary = self.store.prepare(data, sha(data))
        self.assertEqual(summary['status'], 'partial')
        self.assertIn('page_extract_failed:1', summary['limitations'])
        self.assertNotIn('synthetic', json.dumps(summary))
        self.assertNotIn('do not leak', json.dumps(self.store.list_items(summary['paperId'])))
        self.assertGreaterEqual(self.store.list_items(summary['paperId'], page_index=0)['total'], 1)
        self.assertEqual(self.store.list_items(summary['paperId'], page_index=1)['total'], 0)
        listed = self.store.list_items(summary['paperId'], offset=0, limit=1)
        self.assertEqual(listed['total'] > 1, True)
        self.assertEqual(len(listed['items']), 1)
        self.assertEqual(listed['nextOffset'], 1)
        rest = self.store.list_items(summary['paperId'], offset=listed['total'], limit=1)
        self.assertEqual(rest['items'], [])
        self.assertIsNone(rest['nextOffset'])

    def test_http_adapter_uses_the_store(self):
        summary = http.prepare({'fileHash': self.hash, 'file': base64.b64encode(self.pdf).decode()}, store=self.store)
        listed = http.query({'paperId': summary['paperId'], 'operation': 'list', 'kind': 'table'}, store=self.store)
        item = http.query({'paperId': summary['paperId'], 'operation': 'item', 'itemId': listed['items'][0]['id']}, store=self.store)
        self.assertTrue(any(cell['text'] == '5' for cell in item['table']['cells']))
        self.clock.t += 100
        with self.assertRaises(ValueError) as caught:
            http.query({'paperId': summary['paperId'], 'operation': 'status'}, store=self.store)
        self.assertEqual(caught.exception.args[0], 'paper_evidence_expired_or_missing')

    def test_bounds_and_default_store(self):
        self.assertIsInstance(pe.default_store, pe.EvidenceStore)
        self.assertEqual((pe.default_store._ttl, pe.default_store._max), (43200, 4))
        with patch.object(pe, 'MAX_FILE_BYTES', 32):
            raw = b'%PDF-' + b'0' * 64
            with self.assertRaises(ValueError) as caught:
                self.store.prepare(raw, sha(raw))
            self.assertEqual(caught.exception.args[0], 'over_budget')
        doc = pymupdf.open()
        for _ in range(3):
            doc.new_page()
        raw = doc.tobytes()
        doc.close()
        with patch.object(pe, 'MAX_PAGES', 2), patch('paper_native_worker.run', side_effect=lambda operation,args,**kwargs: self.store._extract(*args)):
            with self.assertRaises(ValueError) as caught:
                self.store.prepare(raw, sha(raw))
            self.assertEqual(caught.exception.args[0], 'over_budget')


if __name__ == '__main__':
    unittest.main()

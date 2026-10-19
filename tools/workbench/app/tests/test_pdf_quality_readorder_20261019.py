"""edited_text_order on a two-column page whose left column grew (synthetic in-memory PDFs; no editor, no server).

MuPDF's line-sorted extraction joins the lines of side-by-side columns, so a cascaded left column re-pairs its lines with
the right column's and splits source runs (e.g. 'all. the regression matrix.') that are all still on the page. That
extraction reorder is a warning only when the page read block by block is exactly the source with exactly the edit;
deleted, repeated, substituted, re-signed or clipped-out text keeps failing."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import pymupdf
import pdf_quality

LEFT = ['Left column toy text starts', 'here and keeps going for a', 'few short lines about the', 'felt mat and the toy rover',
    'that never existed at all.']
GROWN = LEFT[:3] + ['felt mat The toy rover then', 'circled the felt mat a', 'second time, paused', 'beside the wooden shelf.',
    'and the toy rover that', 'never existed at all.']
RIGHT = ['Right column toy text sits', 'beside the left one and', 'must never move when the', 'left column is edited by 12',
    'the regression matrix.']
EDIT = [{'pageIndex': 0, 'before': 'felt mat',
    'after': 'felt mat The toy rover then circled the felt mat a second time, paused beside the wooden shelf.'}]
MAP = [{'sourcePageIndex': 0, 'outputPageIndex': 0, 'continuationPageIndices': []}]

def page(left, right=RIGHT, clip_right=None):
    """Columns as two text blocks (x 72 and 309.6, 13 pt pitch from y 100), a full-width line below the longer column,
    header and footer. clip_right=k draws right line k below the MediaBox."""
    d = pymupdf.open(); p = d.new_page(width=595, height=842)
    p.insert_text((72, 40), 'SYNTHETIC QA FIXTURE - not a real paper - columns', fontsize=10)
    for k, line in enumerate(left): p.insert_text((72, 100 + 13 * k), line, fontsize=10)
    for k, line in enumerate(right): p.insert_text((309.6, 900 if k == clip_right else 100 + 13 * k), line, fontsize=10)
    p.insert_text((72, 100 + 13 * max(len(left), len(right)) + 30), 'A full-width toy line closes the two-column block.', fontsize=10)
    p.insert_text((72, 805), 'Synthetic page 1', fontsize=10)
    return d.tobytes()

def order(output, edits=EDIT):
    report = pdf_quality.verify_pdf_quality(page(LEFT), output, edits, MAP, {'source': 1, 'output': 1})
    return {c['code']: c['status'] for c in report['checks']}

class ColumnReadOrder(unittest.TestCase):
    def test_line_sorted_extraction_really_splits_a_source_run(self):
        src = pdf_quality._norm(pymupdf.open(stream=page(LEFT), filetype='pdf')[0].get_text('text', sort=True))
        out = pdf_quality._norm(pymupdf.open(stream=page(GROWN), filetype='pdf')[0].get_text('text', sort=True))
        self.assertIn('all.theregressionmatrix.', src)
        self.assertNotIn('all.theregressionmatrix.', out)

    def test_cascaded_left_column_is_an_order_warning_not_a_definite_loss(self):
        checks = order(page(GROWN))
        self.assertEqual(checks['edited_text_order'], 'warning')
        self.assertNotEqual(checks['edited_after_present'], 'failed')

    def test_unchanged_two_column_page_with_a_same_length_edit_still_passes(self):
        edits = [{'pageIndex': 0, 'before': 'felt mat', 'after': 'felt rug'}]
        self.assertEqual(order(page([l.replace('felt mat', 'felt rug') for l in LEFT]), edits)['edited_text_order'], 'passed')

    def test_real_differences_under_the_same_cascade_still_fail(self):
        right = lambda k, line: RIGHT[:k] + [line] + RIGHT[k + 1:]
        cases = {
            'right_word_deleted': page(GROWN, right(4, 'the matrix.')),
            'repeated_token_dropped': page(GROWN, right(2, 'must never move when')),
            'left_word_deleted': page(GROWN[:-1] + ['never at all.']),
            'word_substituted': page(GROWN, right(2, 'must always move when the')),
            'signed_number': page(GROWN, right(3, 'left column is edited by -12')),
            'number_changed': page(GROWN, right(3, 'left column is edited by 13')),
            'line_repeated': page(GROWN, RIGHT + [RIGHT[1]]),
            'right_line_clipped_out': page(GROWN, clip_right=1),
            'after_reworded': page(GROWN[:5] + ['second time, halted'] + GROWN[6:]),
        }
        for name, output in cases.items():
            with self.subTest(name): self.assertEqual(order(output)['edited_text_order'], 'failed')

    def test_block_proof_rejects_reordered_blocks_and_extra_text(self):
        mupdf, src = pymupdf, pymupdf.open(stream=page(LEFT), filetype='pdf')[0]
        out = lambda raw: [pymupdf.open(stream=raw, filetype='pdf')[0]]
        self.assertTrue(pdf_quality._block_order_exact(src, out(page(GROWN)), EDIT, mupdf))
        self.assertFalse(pdf_quality._block_order_exact(src, out(page(GROWN, LEFT)), EDIT, mupdf))
        self.assertFalse(pdf_quality._block_order_exact(src, out(page(GROWN + ['extra'])), EDIT, mupdf))
        self.assertFalse(pdf_quality._block_order_exact(src, out(page(LEFT)), EDIT, mupdf))

if __name__ == '__main__':
    unittest.main()

"""Experimental fixed-area layout probe: exact After binding, no shrink, no guessed glyphs, deterministic positions."""
import json
import math
import random
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pymupdf
import pdf_foundation_corpus as corpus
from pdf_layout_probe import EPS, SCHEMA, propose_from_source, propose_layout, reconstruct

BOX = [72.0, 100.0, 272.0, 300.0]
HELV = pymupdf.Font('helv')
# Multi-line pitches below are at least one line band (ascender - descender: Helvetica 1.374 em, cjk 1.3086 em), e.g. 14 at
# 10 pt and 15.2 at 11 pt; the usual 1.2 em pitch would overlap those bands and is refused as 'line-bands-overlap'.
HELV_BAND = HELV.ascender - HELV.descender

def drawn(result, after): return [after[l['start']:l['end']] for l in result['lines']]

def numbers(value):
    if isinstance(value, dict): return [n for v in value.values() for n in numbers(v)]
    if isinstance(value, list): return [n for v in value for n in numbers(v)]
    return [value] if type(value) is float else []

class FitTests(unittest.TestCase):
    def assert_inside(self, result, box, obstacles=()):
        for l in result['lines']:
            self.assertGreaterEqual(l['x'], box[0] - EPS); self.assertLessEqual(l['x'] + l['width'], box[2] + EPS)
            self.assertGreaterEqual(l['top'], box[1] - EPS); self.assertLessEqual(l['bottom'], box[3] + EPS)
            for ox0, oy0, ox1, oy1 in obstacles:
                if l['width'] > 0 and oy0 < l['bottom'] and oy1 > l['top']:
                    self.assertTrue(l['x'] + l['width'] <= ox0 + EPS or l['x'] >= ox1 - EPS, (l, (ox0, oy0, ox1, oy1)))

    def test_short_after_fits_on_one_line_with_fixed_metrics(self):
        after = 'The measured response fails under the stated assumptions.'
        r = propose_layout(after, [72, 88, 400, 104], 'helv', 11, 13.2)
        self.assertEqual((r['schema'], r['status'], r['reason']), (SCHEMA, 'fits', None))
        self.assertEqual(len(r['lines']), 1)
        line = r['lines'][0]
        self.assertAlmostEqual(line['width'], HELV.text_length(after, fontsize=11), places=3)
        self.assertAlmostEqual(line['baseline'], 88 + HELV.ascender * 11, places=3)
        self.assertEqual((r['fixed']['fontSize'], r['fixed']['lineHeight']), (11.0, 13.2))
        self.assertEqual(r['metrics']['kind'], 'metrics-only')
        self.assertFalse(r['metrics']['sourceShapeGuarantee'] or r['metrics']['kerning'] or r['region']['editAuthority'])
        self.assertTrue(r['experimental'])
        self.assertFalse(any(r['policy'].values()))
        self.assertNotIn(after, json.dumps(r))   # private result carries offsets and hashes, never the text
        self.assertEqual(reconstruct(r, after), after)

    def test_long_after_overflows_without_shrinking_or_adding_space(self):
        after = ' '.join(['measured response'] * 60)
        r = propose_layout(after, BOX, 'helv', 11, 13.2)
        self.assertEqual((r['status'], r['reason']), ('overflow', 'height'))
        self.assertIsNone(r['lines'])
        self.assertEqual((r['fixed']['fontSize'], r['fixed']['lineHeight'], r['fixed']['bbox']), (11.0, 13.2, BOX))
        self.assertGreater(r['overflow']['requiredLines'], r['overflow']['availableLines'])
        self.assertEqual(r['overflow']['availableLines'], 15)   # (200 - 1.374 em) // 13.2 + 1
        self.assertFalse(r['policy']['fontShrink'] or r['policy']['lineHeightShrink'] or r['policy']['pageAddition'])
        self.assertIsNone(reconstruct(r, after))
        self.assertEqual(propose_layout(after, BOX, 'helv', 4, 5.6)['status'], 'fits')   # a shrink would fit; the probe never does it

    def test_reconstruction_keeps_every_space_and_line_break(self):
        after = '  Indented  start with  double  spaces\n\nafter a blank line\r\nCRLF line and   trailing   \nend\n'
        for box in (BOX, [72.0, 100.0, 140.0, 500.0]):
            r = propose_layout(after, box, 'helv', 10, 14)
            self.assertEqual(r['status'], 'fits')
            self.assertEqual(reconstruct(r, after), after)
            self.assert_inside(r, box)
            self.assertTrue(drawn(r, after)[0].startswith('  Indented'))   # paragraph-leading spaces are drawn
            for text in drawn(r, after)[1:]: self.assertFalse(text.startswith(' ') or '\n' in text or '\r' in text)
        r = propose_layout(after, BOX, 'helv', 10, 14)
        self.assertEqual(drawn(r, after)[1], '')   # the blank paragraph still takes a line slot
        self.assertEqual([l['slot'] for l in r['lines']], list(range(len(r['lines']))))

    def test_words_never_split_and_unbreakable_overflow(self):
        after = 'aaa bbbbbbbbbb cc -0.42 dd'
        r = propose_layout(after, [0, 0, 60, 200], 'helv', 10, 14)
        self.assertEqual(r['status'], 'fits')
        lines = drawn(r, after)
        self.assertEqual([w for t in lines for w in t.split(' ')], after.split(' '))   # every line holds whole words
        self.assertIn('bbbbbbbbbb', lines)
        self.assertTrue(any('-0.42' in t for t in lines))
        long_word = 'https://example.invalid/' + 'x' * 40
        r = propose_layout('see ' + long_word, [0, 0, 100, 400], 'helv', 10, 14)
        self.assertEqual((r['status'], r['reason'], r['overflow']['firstUnplacedOffset']), ('overflow', 'unbreakable-width', 4))
        self.assertIsNone(r['lines'])

    def test_cjk_and_mixed_breaks_with_glyph_support(self):
        after = '결과는 유지된다。(주) 값 -0.42이다 and the effect is clear'
        r = propose_layout(after, [0, 0, 64, 300], 'cjk', 10, 13.1)
        self.assertEqual(r['status'], 'fits')
        self.assertEqual(reconstruct(r, after), after)
        lines = drawn(r, after)
        self.assertTrue(any('-0.42' in t for t in lines))   # sign and digits stay on one line
        for t in lines:
            self.assertFalse(t[:1] in '。),.' or t[-1:] in '(')
        r = propose_layout(after, [0, 0, 64, 300], 'helv', 10, 13)
        self.assertEqual((r['status'], r['reason'], r['lines']), ('unsupported', 'missing-glyphs', None))
        self.assertIn('U+ACB0', r['characters']['missingGlyphs'])
        self.assertNotIn('U+0041', r['characters']['missingGlyphs'])

    def test_absent_or_invisible_characters_are_never_a_pass(self):
        for after, reason in (('tab\there', 'unsupported-character'), ('zero‍width', 'unsupported-character'),
                ('soft­hyphen', 'unsupported-character'), ('emoji \U0001F600', 'missing-glyphs'), ('\ud800x', 'unsupported-character')):
            r = propose_layout(after, BOX, 'helv', 10, 12)
            self.assertEqual((r['status'], r['reason'], r['lines']), ('unsupported', reason, None), after)

    def test_invalid_limits_and_coordinates_are_unsupported(self):
        cases = [([72, 100, 72, 300], 11, 13), ([72, 100, 60, 300], 11, 13), ([0, 0, math.inf, 10], 11, 13),
            ([0, 0, math.nan, 10], 11, 13), ([0, 0, True, 10], 11, 13), ([0, 0, 10], 11, 13), (BOX, 0, 13), (BOX, -2, 13),
            (BOX, math.nan, 13), (BOX, 11, 0), (BOX, 11, -13), (BOX, 11, math.inf)]
        reasons = set()
        for box, size, pitch in cases:
            r = propose_layout('valid text', box, 'helv', size, pitch)
            self.assertEqual((r['status'], r['lines']), ('unsupported', None), (box, size, pitch))
            reasons.add(r['reason'])
        self.assertEqual(reasons, {'invalid-bbox', 'invalid-font-size', 'invalid-line-height'})
        for after in ('', '   \n', None, 7): self.assertEqual(propose_layout(after, BOX, 'helv', 11, 13)['status'], 'unsupported')
        self.assertEqual(propose_layout('x', BOX, 'not-a-font', 11, 13)['reason'], 'font-unavailable')
        self.assertEqual(propose_layout('x' * 4001, BOX, 'helv', 11, 13)['reason'], 'after-too-long')
        short = propose_layout('valid text', [0, 0, 100, 10], 'helv', 11, 13)   # box lower than one glyph line
        self.assertEqual((short['status'], short['overflow']['availableLines']), ('overflow', 0))
        r = propose_layout('valid text that wraps across a few lines here', [0, 0, 80, 200], 'helv', 11, 15.2)
        self.assertEqual(r['status'], 'fits')
        self.assertTrue(all(math.isfinite(v) for v in numbers(r)))
        json.dumps(r, allow_nan=False)

    def test_obstacles_reduce_space_and_are_never_entered(self):
        after = 'one two three four five six seven eight nine ten eleven twelve'
        free = propose_layout(after, BOX, 'helv', 11, 15.2)
        notch = [[172.0, 100.0, 272.0, 126.0]]   # right half of the first two line bands
        r = propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=notch)
        self.assertEqual(r['status'], 'fits')
        self.assert_inside(r, BOX, notch)
        self.assertGreater(len(r['lines']), len(free['lines']))
        blocked = [[0.0, 99.0, 600.0, 101.0]]   # meets the first line band across the full width
        r = propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=blocked)
        self.assertEqual(r['lines'][0]['slot'], 1)
        self.assert_inside(r, BOX, blocked)
        self.assertEqual(reconstruct(r, after), after)
        many = notch + blocked + [[100.0, 200.0, 120.0, 230.0]]
        self.assertEqual(json.dumps(propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=many)),
            json.dumps(propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=list(reversed(many)))))
        wall = [[72.0, 100.0, 272.0, 300.0]]
        self.assertEqual(propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=wall)['status'], 'overflow')
        for bad in ([[0, 0, math.nan, 1]], [[5, 0, 1, 1]], 'x', [[0, 0, 1, 1]] * 257):
            self.assertEqual(propose_layout(after, BOX, 'helv', 11, 15.2, obstacles=bad)['status'], 'unsupported')

    def test_seeded_inputs_are_deterministic_and_reconstruct_exactly(self):
        alphabet = ['alpha', 'beta', '-0.42', 'x', 'longerword', '결과', '유지된다', '。', '(주)', '\n', '  ', ' ']
        for seed in range(25):
            rng = random.Random(seed)
            after = 'a' + ''.join(rng.choice(alphabet) + (' ' if rng.random() < 0.6 else '') for _ in range(rng.randint(5, 60)))
            box = [10.0, 20.0, 10.0 + rng.choice((60, 120, 240)), 20.0 + rng.choice((40, 200, 600))]
            obstacles = [[rng.uniform(0, 200), rng.uniform(0, 400), rng.uniform(200, 260), rng.uniform(400, 420)]
                for _ in range(rng.randint(0, 3))]
            first = propose_layout(after, box, 'cjk', 10, 13.1, obstacles)
            again = propose_layout(after, list(box), pymupdf.Font('cjk'), 10, 13.1, [list(o) for o in obstacles])
            self.assertEqual(first['status'], again['status'])
            self.assertEqual(first['lines'], again['lines'])
            self.assertEqual(json.dumps(propose_layout(after, box, 'cjk', 10, 13.1, obstacles)), json.dumps(first))
            self.assertNotEqual(first['reason'], 'line-bands-overlap')
            if first['status'] == 'fits':
                self.assertEqual(reconstruct(first, after), after, seed)
                self.assert_inside(first, box, obstacles)

    def test_reconstruct_rejects_unbound_or_tampered_results(self):
        after = 'alpha beta gamma delta'
        r = propose_layout(after, [0, 0, 60, 200], 'helv', 10, 14)
        self.assertEqual(reconstruct(r, after), after)
        self.assertIsNone(reconstruct(r, after + ' '))
        tampered = json.loads(json.dumps(r)); tampered['lines'][1]['start'] += 1
        self.assertIsNone(reconstruct(tampered, after))
        dropped = json.loads(json.dumps(r)); del dropped['lines'][1]
        self.assertIsNone(reconstruct(dropped, after))

class LineBandTests(unittest.TestCase):
    """Metrics cannot prove the ink of adjacent lines stays apart, so overlapping line bands are refused, never adjusted."""
    def assert_refused(self, r, size, pitch):
        self.assertEqual((r['status'], r['reason'], r['lines'], r['overflow']), ('unsupported', 'line-bands-overlap', None, None))
        self.assertEqual((r['fixed']['fontSize'], r['fixed']['lineHeight']), (float(size), float(pitch)))   # never raised or shrunk
        self.assertIsNone(reconstruct(r, 'unused'))

    def test_reported_overlapping_baselines_are_refused(self):
        after = 'hello world hello world'
        r = propose_layout(after, [0, 0, 40, 100], 'helv', 12, 0.1)   # was 'fits' with baselines 12.9, 13.0, 13.1, 13.2
        self.assert_refused(r, 12, 0.1)
        self.assertIsNone(reconstruct(r, after))
        self.assertNotIn(after, json.dumps(r))

    def test_leading_below_equal_and_above_the_band(self):
        after, box, band = 'alpha beta gamma delta', [0, 0, 60, 400], HELV_BAND * 10
        for pitch in (10.5, 12, band - 0.001):   # positive typographic leading over the font size can still overlap the bands
            self.assert_refused(propose_layout(after, box, 'helv', 10, pitch), 10, pitch)
        for pitch in (band, band + 0.001, 20):   # bands that touch or are apart: fits, at exactly the caller's pitch
            r = propose_layout(after, box, 'helv', 10, pitch)
            self.assertEqual(r['status'], 'fits', pitch)
            self.assertGreater(len(r['lines']), 1)
            self.assertEqual(reconstruct(r, after), after)
            tops = [l['top'] for l in r['lines']]
            self.assertTrue(all(abs(b - a - pitch) < 1e-3 for a, b in zip(tops, tops[1:])))
            self.assertTrue(all(b['top'] >= a['bottom'] - 1e-3 for a, b in zip(r['lines'], r['lines'][1:])))

    def test_one_line_may_use_a_small_pitch(self):
        after = 'hello world'
        r = propose_layout(after, [0, 0, 200, 100], 'helv', 12, 0.1)
        self.assertEqual((r['status'], len(r['lines'])), ('fits', 1))
        self.assertEqual(reconstruct(r, after), after)

    def test_empty_lines_still_own_a_band(self):
        for after in ('a\n\nb', 'a\n', '\nb'):
            self.assert_refused(propose_layout(after, BOX, 'helv', 10, 12), 10, 12)
            r = propose_layout(after, BOX, 'helv', 10, 14)
            self.assertEqual(r['status'], 'fits', after)
            self.assertEqual(reconstruct(r, after), after)

    def test_slots_skipped_for_an_obstacle_count_their_real_distance(self):
        band = HELV_BAND * 10
        pitch = 0.6 * band   # adjacent slots overlap, but slot 0 and slot 2 are 1.2 bands apart
        only_slot_1 = [[0.0, band + 0.01, 600.0, 2 * pitch - 0.01]]
        r = propose_layout('a\nb', BOX, 'helv', 10, pitch, obstacles=[[0.0, 100 + band + 0.01, 600.0, 100 + 2 * pitch - 0.01]])
        self.assertEqual((r['status'], [l['slot'] for l in r['lines']]), ('fits', [0, 2]))
        self.assertEqual(reconstruct(r, 'a\nb'), 'a\nb')
        r = propose_layout('a\nb', [0.0, 0.0, 200.0, 200.0], 'helv', 10, pitch, obstacles=only_slot_1)
        self.assertEqual([l['slot'] for l in r['lines']], [0, 2])
        self.assert_refused(propose_layout('a\nb\nc', BOX, 'helv', 10, pitch, obstacles=[]), 10, pitch)

    def test_overflow_is_still_reported_before_the_band_check(self):
        r = propose_layout(' '.join(['measured response'] * 60), BOX, 'helv', 11, 13.2)
        self.assertEqual((r['status'], r['reason']), ('overflow', 'height'))

def embedded_source(subset):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname='F0', fontbuffer=pymupdf.Font('cjk').buffer)
    page.insert_text((72, 100), '결과는 유지된다 그리고 끝.', fontname='F0', fontsize=11)
    if subset: doc.subset_fonts()
    return doc.tobytes(garbage=4, deflate=True, no_new_id=True)

class SourceWrapperTests(unittest.TestCase):
    """Synthetic foundation cases through the existing read-only edit-plan contract; no export, no PDF is written."""
    SIMPLE = ('valid_same_length_wording', 'two_column', 'minus_sign_preservation')

    def test_simple_foundation_cases_fit_and_match_the_simulated_output_width(self):
        for case_id in self.SIMPLE:
            case = corpus.build_case(case_id)
            source = bytes(case['source'])
            edit = dict(case['edits'][0], id='e0')
            r = propose_from_source(case['source'], edit, 13.2)
            self.assertEqual((r['status'], r['metrics']['fontOrigin'], r['region']['owner']),
                ('fits', 'base14-builtin-metrics', 'source-edit-plan'), case_id)
            self.assertFalse(r['region']['editAuthority'])
            self.assertEqual(case['source'], source)
            self.assertEqual(r['fixed']['bbox'], case['selected'][0]['regions'][0])
            self.assertEqual(r['fixed']['fontSize'], case['selected'][0]['styles'][0]['size'])
            out_page = pymupdf.open(stream=case['output'], filetype='pdf')[0]
            measured = out_page.search_for(edit['after'])
            self.assertEqual(len(measured), 1, case_id)
            self.assertAlmostEqual(r['lines'][0]['width'], measured[0].width, delta=0.05)
            self.assertAlmostEqual(r['lines'][0]['baseline'], r['lines'][0]['top'] + 1.075 * r['fixed']['fontSize'], places=2)
            longer = dict(edit, after=edit['after'] + ' and considerably more words than the region holds')
            r = propose_from_source(case['source'], longer, 13.2)
            self.assertEqual((r['status'], r['reason']), ('overflow', 'height'), case_id)

    def test_wider_after_in_tight_source_region_overflows_like_the_simulated_output(self):
        case = corpus.build_case('shared_image_occurrence')   # 'shown twice' -> 'shown again' is wider in Helvetica
        edit = dict(case['edits'][0], id='e0')
        r = propose_from_source(case['source'], edit, 13.2)
        self.assertEqual((r['status'], r['reason'], r['lines']), ('overflow', 'height', None))
        region = case['selected'][0]['regions'][0]
        measured = pymupdf.open(stream=case['output'], filetype='pdf')[0].search_for(edit['after'])[0]
        self.assertGreater(measured.width, region[2] - region[0])   # the simulated editor output also leaves the region
        wider = propose_from_source(case['source'], edit, 13.2, bbox=[region[0], region[1], region[2] + 5, region[3]])
        self.assertEqual((wider['status'], wider['region']['owner']), ('fits', 'caller'))

    def test_unresolved_or_complex_foundation_cases_are_unsupported(self):
        for case_id in ('multiline_mixed_font', 'ambiguous_repeated_quote', 'rotated_cropped'):
            case = corpus.build_case(case_id)
            r = propose_from_source(case['source'], dict(case['edits'][0], id='e0'), 13.2)
            self.assertEqual((r['status'], r['reason'], r['lines']), ('unsupported', 'source-not-simple', None), case_id)
        self.assertEqual(propose_from_source(b'not a pdf', {'id': 'e', 'pageIndex': 0, 'before': 'a', 'after': 'b'}, 12)['reason'],
            'source-not-simple')
        self.assertEqual(propose_from_source(b'%PDF-', {'id': 'e', 'pageIndex': 0, 'before': '', 'after': 'b'}, 12)['reason'], 'invalid-edit')

    def test_embedded_source_font_program_and_subset_coverage(self):
        edit = {'id': 'e', 'pageIndex': 0, 'before': '결과는 유지된다', 'after': '결과는 유지된다'}
        full = propose_from_source(embedded_source(False), edit, 14)
        self.assertEqual((full['status'], full['metrics']['fontOrigin'], full['metrics']['verticalMetrics']),
            ('fits', 'source-embedded-program', 'source-span'))
        longer = propose_from_source(embedded_source(False), dict(edit, after='결과는 실패한다 아주 길게 늘어난 문장입니다'), 14)
        self.assertEqual((longer['status'], longer['overflow']['availableLines']), ('overflow', 1))
        subset = propose_from_source(embedded_source(True), edit, 14)   # CID subset: no Unicode cmap, so no guessed glyphs
        self.assertEqual((subset['status'], subset['reason'], subset['lines']), ('unsupported', 'missing-glyphs', None))

if __name__ == '__main__':
    unittest.main()

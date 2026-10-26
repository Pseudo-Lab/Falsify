import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / 'local'))
import reanchor
from red_service import evidence_check

TEXT = 'The measured value was 0.80 and was not final across range.'
JOINED = 'The preoperative method remained stable across repeated visits today.'
BROKEN = JOINED.replace('preoperative', 'pre-\noperative', 1)
ORDINARY = 'The well-known method remained stable across repeated visits today.'


class ReanchorTests(unittest.TestCase):
    def go(self, quote, text, segment='s0', segments=None, **extra):
        if segments is None:
            segments = [{'id': segment, 'text': text}]
        raw = {'status': 'ok', 'summary': 'S', 'evidence': [
            {'segmentId': segment, 'quote': quote, 'relation': 'R', **extra}]}
        saved = json.loads(json.dumps(raw))
        derived, prov = reanchor.reanchor_scan(raw, {'segments': segments})
        self.assertEqual(raw, saved)
        self.assertIsNot(derived, raw)
        self.assertEqual(len(derived['evidence']), 1)
        self.assertEqual(derived['summary'], 'S')
        self.assertEqual(derived['evidence'][0]['relation'], 'R')
        self.assertNotIn('quote', prov['items'][0])
        self.assertNotIn(quote, json.dumps(prov))
        return derived, prov

    def test_normalize_keeps_meaningful_characters(self):
        self.assertEqual(reanchor.normalize('ab-\ncd'), ('abcd', [0, 1, 4, 5]))
        self.assertEqual(reanchor.normalize('a b')[0], 'ab')
        self.assertEqual(reanchor.normalize('well-known')[0], 'well-known')
        self.assertEqual(reanchor.normalize('A-B')[0], 'A-B')
        self.assertEqual(reanchor.normalize('1-\n2')[0], '1-2')
        self.assertEqual(reanchor.normalize('p<0.05')[0], 'p<0.05')
        self.assertEqual(reanchor.normalize('Na\u0308')[0], 'Na\u0308')

    def test_whitespace_and_line_end_hyphen(self):
        quote = TEXT.replace('value was', 'value\nwas', 1)
        derived, prov = self.go(quote, TEXT, externalEvidence=[{'quote': 'Outside source stays put.'}])
        self.assertEqual(derived['evidence'][0]['quote'], TEXT)
        self.assertEqual(derived['evidence'][0]['externalEvidence'][0]['quote'], 'Outside source stays put.')
        self.assertEqual(prov['items'][0]['decision'], 'reanchored')
        evidence_check(derived['evidence'], {'s0': TEXT}, 600)
        with self.assertRaises(ValueError):
            evidence_check([{'segmentId': 's0', 'quote': quote, 'relation': 'R'}], {'s0': TEXT}, 600)
        derived, prov = self.go(JOINED, BROKEN)
        self.assertEqual(derived['evidence'][0]['quote'], BROKEN)
        self.assertIn('pre-\noperative', derived['evidence'][0]['quote'])
        self.assertEqual(prov['items'][0]['decision'], 'reanchored')
        evidence_check(derived['evidence'], {'s0': BROKEN}, 600)

    def test_exact_quote_unchanged(self):
        derived, prov = self.go(TEXT, TEXT)
        self.assertEqual(derived['evidence'][0]['quote'], TEXT)
        self.assertEqual(prov['items'][0]['decision'], 'exact')
        evidence_check(derived['evidence'], {'s0': TEXT}, 600)

    def reject(self, quote, text, reason, segment='s0', segments=None):
        derived, prov = self.go(quote, text, segment, segments)
        self.assertEqual(derived['evidence'][0]['quote'], quote)
        self.assertEqual(prov['items'][0]['decision'], 'rejected')
        self.assertEqual(prov['items'][0]['reason'], reason)
        with self.assertRaises(ValueError):
            evidence_check(derived['evidence'], {segment: text}, 600)
        return derived

    def test_semantic_and_scope_rejections(self):
        self.reject(TEXT.replace('0.80', '0.81'), TEXT, 'missing')
        self.reject(TEXT.replace(' not ', ' '), TEXT, 'missing')
        self.reject(TEXT.replace('The', 'the', 1), TEXT, 'missing')
        self.reject(TEXT.replace('range.', 'range,'), TEXT, 'missing')
        self.reject(ORDINARY.replace('well-known', 'wellknown'), ORDINARY, 'missing')
        doubled = TEXT + ' ' + TEXT
        quote = TEXT.replace('value was', 'value\nwas', 1)
        self.reject(quote, doubled, 'ambiguous')
        other = 'Completely different wording occupies the declared segment here today.'
        self.reject(quote, other, 'missing', segments=[{'id': 's0', 'text': other}, {'id': 's1', 'text': TEXT}])
        self.reject(quote, TEXT, 'undelivered', segment='s0', segments=[{'id': 's1', 'text': TEXT}])
        short = 'Short phrase.'
        self.reject(short.replace(' ', '\n', 1), short, 'short')


if __name__ == '__main__':
    unittest.main()

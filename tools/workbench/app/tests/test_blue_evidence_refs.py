"""Host evidence-ref catalog for BLUE selection. Fake models only; no real LLM calls."""
import copy
import hashlib
import json
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local'))
import harness
import blue_evidence_refs as refs
import blue_service as blue

NUM = '0.003   0.001'
NEAR1 = 'FIRSTMARK unique beside the first value.'
NEAR2 = 'SECONDMARK unique beside the second value.'
HIDDEN = 'HIDDENMARKER-not-delivered'


def filler(n, ch='z'):
    return ch * n


def request(segments, max_calls=32):
    segs = [{'id': i, 'label': label, 'text': text} for i, label, text in segments]
    return {'schema': blue.VERSION, 'revision': 'r1', 'requestId': 'b-refs', 'segments': segs, 'maxCalls': max_calls,
            'consent': True, 'sourceHash': hashlib.sha256('\n\n'.join(s['text'] for s in segs).encode()).hexdigest()}


def ok(**kw):
    return {'status': 'ok', **kw}


def fake(select, final, scan=None):
    log = {'calls': []}
    class Fake:
        def __init__(self, **kwargs): pass
        def infer(self, prompt, schema):
            log['calls'].append((schema, prompt))
            if schema is blue.SCAN:
                return {'status': 'ok', 'response': scan(prompt) if scan else ok(summary='Chunk read.', evidence=[])}
            if schema is blue.SELECTION:
                return {'status': 'ok', 'response': select(prompt)}
            return {'status': 'ok', 'response': final(prompt)}
    return Fake, log


def run(data, Fake):
    return blue.run_review(data, lambda _: None, threading.Event(), Fake)


def payload_of(prompt):
    decoder, marker, start, found = json.JSONDecoder(), '{"allChunkNotes": ', 0, None
    while True:
        i = prompt.find(marker, start)
        if i < 0:
            break
        try:
            value, end = decoder.raw_decode(prompt, i)
        except json.JSONDecodeError:
            start = i + 1
            continue
        if end == len(prompt) and isinstance(value, dict):
            found = value
        start = i + 1
    if found is None:
        raise AssertionError('selection payload missing')
    return found


def part(head, n):
    if len(head) > n:
        raise AssertionError('part head exceeds index part')
    return head + filler(n - len(head))


def repeated_document():
    """Two deliveries of NUM at index-part boundaries, with a marker past the first preview."""
    p0 = part(NUM + ' ' + NEAR1 + ' ', blue.INDEX_PART)
    hidden_at = 400
    p0 = p0[:hidden_at] + HIDDEN + p0[hidden_at + len(HIDDEN):]
    p1 = part(NUM + ' ' + NEAR2 + ' ', blue.INDEX_PART)
    s7 = p0 + p1
    s8 = 'tail ' + filler(30000, 'y')
    return request([('s7', 'Results', s7), ('s8', 'Appendix', s8)]), s7


def selection_prompt(log):
    prompts = [p for schema, p in log['calls'] if schema is blue.SELECTION]
    if len(prompts) != 1:
        raise AssertionError('expected one selection call')
    return prompts[0]


def num_refs(catalog, start=None):
    found = [r for r in catalog if r['text'] == NUM and r['segmentId'] == 's7']
    if start is not None:
        found = [r for r in found if r['start'] == start]
    return found


def target(ref, reason='reread this span'):
    return {'segmentId': ref['segmentId'], 'anchor': ref['id'], 'reason': reason}


def finding(quote, evidence_quote):
    return {'id': 'f1', 'segmentId': 's7', 'quote': quote, 'rationale': 'Compared with the delivered window.',
            'evidence': [{'segmentId': 's7', 'quote': evidence_quote, 'relation': 'same paragraph'}],
            'uncertainty': 'Text comparison only.'}


class CatalogTests(unittest.TestCase):
    def test_repeated_numeric_string_has_two_stable_ids(self):
        text = NUM + ' LEFTCONTEXT ' + filler(80, 'a') + NUM + ' RIGHTCONTEXT ' + filler(80, 'b')
        preview = text[:240]
        self.assertEqual(preview.count(NUM), 2)
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': preview}]
        built, truncated, spans = refs.build_evidence_refs(segments, index, [], 10**7)
        again, _, _ = refs.build_evidence_refs(segments, index, [], 10**7)
        self.assertEqual(built, again)
        self.assertFalse(truncated)
        hits = [r for r in built if r['text'] == NUM]
        self.assertEqual(len(hits), 2)
        self.assertEqual([h['start'] for h in hits], [text.find(NUM), text.find(NUM, text.find(NUM) + 1)])
        self.assertNotEqual(hits[0]['id'], hits[1]['id'])
        self.assertIn('LEFTCONTEXT', hits[0]['after'])
        self.assertIn('RIGHTCONTEXT', hits[1]['after'])
        self.assertTrue(all(len(h['before']) <= 40 and len(h['after']) <= 40 for h in built))
        self.assertTrue(all(r['id'] == refs.ref_id(r['segmentId'], r['start'], r['end'], r['text']) for r in built))
        self.assertEqual(len({r['id'] for r in built}), len(built))
        self.assertEqual(len({(r['segmentId'], r['start'], r['end']) for r in built}), len(built))
        self.assertTrue(any(a <= hits[1]['start'] and hits[1]['end'] <= b for sid, a, b in spans if sid == 's7'))
        self.assertNotIn('not-in-source', json.dumps(built))

    def test_context_stays_inside_the_delivered_preview(self):
        preview = 'A' * 200 + 'EDGE'
        text = preview + 'UNDISCLOSED-TAIL'
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': preview}]
        built, _, _ = refs.build_evidence_refs(segments, index, [], 10**7)
        self.assertTrue(built)
        for ref in built:
            self.assertNotIn('UNDISCLOSED', ref['text'] + ref['before'] + ref['after'])
            self.assertLessEqual(ref['end'], len(preview))
            self.assertEqual(text[ref['start']:ref['end']], ref['text'])

    def test_note_quote_does_not_bind_the_first_hidden_occurrence(self):
        first = 400
        text = filler(blue.INDEX_PART, 'q')
        text = text[:first] + NUM + text[first + len(NUM):]
        text += NUM + ' INSIDE'
        self.assertEqual(text.find(NUM), first)
        self.assertGreaterEqual(text.find(NUM, first + 1), blue.INDEX_PART)
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': text[:240]},
                 {'segmentId': 's7', 'offset': blue.INDEX_PART, 'preview': text[blue.INDEX_PART:blue.INDEX_PART + 240]}]
        self.assertNotIn(NUM, index[0]['preview'])
        self.assertIn(NUM, index[1]['preview'])
        built, _, _ = refs.build_evidence_refs(segments, index, [('s7', NUM)], 10**7)
        hits = [r for r in built if r['text'] == NUM]
        self.assertEqual([h['start'] for h in hits], [text.find(NUM, blue.INDEX_PART)])
        self.assertNotEqual(hits[0]['start'], first)

    def test_unique_note_quote_outside_preview_has_no_neighbor_text(self):
        quote = 'UNIQUE-QUOTE-OUTSIDE-PREVIEW'
        text = filler(240, 'p') + 'BEFORE-SECRET ' + quote + ' AFTER-SECRET'
        start = text.index(quote)
        self.assertGreaterEqual(start, 240)
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': text[:240]}]
        built, truncated, _ = refs.build_evidence_refs(segments, index, [('s7', quote)], 10**7)
        hits = [r for r in built if r['text'] == quote]
        self.assertEqual(len(hits), 1)
        self.assertEqual((hits[0]['start'], hits[0]['before'], hits[0]['after'], truncated), (start, '', '', False))
        self.assertNotIn('SECRET', json.dumps(hits))

    def test_repeated_note_quote_outside_previews_is_not_catalogued(self):
        text = 'AAA ' + NUM + ' BBB ' + NUM
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': 'AAA '}]
        built, _, _ = refs.build_evidence_refs(segments, index, [('s7', NUM)], 10**7)
        self.assertFalse(any(r['text'] == NUM for r in built))

    def test_truncation_keeps_prefix_ids_and_reports(self):
        text = ' '.join(f'{i}.000   0.00{i}' for i in range(30))
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': text}]
        full, truncated, _ = refs.build_evidence_refs(segments, index, [], 10**7)
        self.assertFalse(truncated)
        self.assertGreaterEqual(len(full), 2)
        size = len(json.dumps(full, ensure_ascii=False))
        tiny = None
        for denom in (2, 3, 4, 8, 16, 32):
            got, cut, _ = refs.build_evidence_refs(segments, index, [], max(2, size // denom))
            self.assertLessEqual(len(json.dumps(got, ensure_ascii=False)), max(2, size // denom))
            if cut and got:
                tiny = got
                break
        self.assertIsNotNone(tiny)
        self.assertEqual([r['id'] for r in tiny], [r['id'] for r in full[:len(tiny)]])
        empty, cut, _ = refs.build_evidence_refs(segments, index, [], 0)
        self.assertEqual((empty, cut), ([], True))
        none, cut, _ = refs.build_evidence_refs(segments, [], [], 10**7)
        self.assertEqual((none, cut), ([], False))

    def test_changed_literal_retires_the_old_id(self):
        text = NUM + ' alpha ' + NUM + ' beta'
        other = text.replace(NUM, '0.004   0.001', 1)
        self.assertEqual(len(other), len(text))

        def build(body):
            segments = [{'id': 's7', 'label': 'Results', 'text': body}]
            index = [{'segmentId': 's7', 'offset': 0, 'preview': body}]
            return refs.build_evidence_refs(segments, index, [], 10**7)[0]

        before, after = build(text), build(other)
        old = next(r['id'] for r in before if r['text'] == NUM and r['start'] == 0)
        self.assertNotIn(old, {r['id'] for r in after})
        self.assertEqual(next(r['start'] for r in before if r['start'] == text.find(NUM, 1)),
                         next(r['start'] for r in after if r['text'] == NUM))


class ResolveTests(unittest.TestCase):
    def catalog(self):
        text = NUM + ' LEFT ' + filler(40, 'a') + NUM + ' RIGHT'
        segments = [{'id': 's7', 'label': 'Results', 'text': text}]
        index = [{'segmentId': 's7', 'offset': 0, 'preview': text}]
        built, truncated, spans = refs.build_evidence_refs(segments, index, [], 10**7)
        hits = [r for r in built if r['text'] == NUM]
        self.assertEqual(len(hits), 2)
        self.assertFalse(truncated)
        return text, hits, {r['id']: r for r in built}, spans, {'s7': [text]}

    def test_each_id_resolves_only_its_offset(self):
        text, hits, catalog, spans, visible = self.catalog()
        raw = {'status': 'ok', 'targets': [target(hits[1]), target(hits[0]), target(hits[1])]}
        snapshot = copy.deepcopy(raw)
        got = blue.validate_targets(raw, {'s7': text}, visible, catalog, spans)
        self.assertEqual(raw, snapshot)
        self.assertEqual([(t['offset'], t['anchor']) for t in got], [(hits[1]['start'], NUM), (hits[0]['start'], NUM)])
        self.assertNotEqual(got[0]['offset'], text.find(NUM))

    def test_unknown_stale_malformed_and_invisible_ids_reject(self):
        text, hits, catalog, spans, visible = self.catalog()
        second = hits[1]
        source = {'s7': text}

        def reject(anchor, message, catalog_=catalog, spans_=spans, visible_=visible, segment='s7', body=text):
            selection = {'status': 'ok', 'targets': [{'segmentId': segment, 'anchor': anchor, 'reason': 'because'}]}
            with self.assertRaisesRegex(ValueError, message):
                blue.validate_targets(selection, {'s7': body}, {'s7': visible_['s7']}, catalog_, spans_)

        reject('er12', '형식')
        reject('er0000', '목록에 없습니다')
        reject(refs.ref_id('s7', 0, 1, 'missing'), '목록에 없습니다')
        moved = dict(second, start=hits[0]['start'], end=hits[0]['end'])
        reject(second['id'], '묶인 범위', {second['id']: moved})
        corrupt = text[:second['start']] + 'X' + text[second['start'] + 1:]
        reject(second['id'], '원문 위치', body=corrupt)
        reject(second['id'], '범위 밖', spans_=[])
        reject(second['id'], '전달된 텍스트에 없습니다', visible_={'s7': ['unrelated preview']})
        mismatch = {'status': 'ok', 'targets': [{'segmentId': 's0', 'anchor': second['id'], 'reason': 'because'}]}
        with self.assertRaisesRegex(ValueError, '대상과 다릅니다'):
            blue.validate_targets(mismatch, {'s7': text, 's0': 'other segment'}, {'s7': [text], 's0': ['other segment']}, catalog, spans)
        with self.assertRaisesRegex(ValueError, '중복'):
            blue.validate_targets({'status': 'ok', 'targets': [{'segmentId': 's7', 'anchor': NUM, 'reason': 'literal'}]},
                                  source, visible, catalog, spans)
        legacy = {'status': 'ok', 'targets': [{'segmentId': 's7', 'anchor': 'LEFT', 'reason': 'once'}]}
        before = copy.deepcopy(legacy)
        got = blue.validate_targets(legacy, source, visible, catalog, spans)
        self.assertEqual(legacy, before)
        self.assertEqual(got, [{'segmentId': 's7', 'offset': text.index('LEFT'), 'anchor': 'LEFT'}])

    def test_invalid_id_is_not_dropped_from_a_mixed_selection(self):
        text, hits, catalog, spans, visible = self.catalog()
        selection = {'status': 'ok', 'targets': [target(hits[0]), {'segmentId': 's7', 'anchor': 'er0000', 'reason': 'stale'}]}
        with self.assertRaisesRegex(ValueError, '목록에 없습니다'):
            blue.validate_targets(selection, {'s7': text}, visible, catalog, spans)


class SelectionFlowTests(unittest.TestCase):
    def test_repeated_offsets_are_selectable_and_grounded(self):
        data, s7 = repeated_document()
        self.assertEqual(s7.count(NUM), 2)
        self.assertNotIn(HIDDEN, s7[:240])
        self.assertEqual(blue.validate_request(data)[1], 4)
        holder = {}

        def select(prompt):
            self.assertLessEqual(len(prompt), blue.MAX_PROMPT)
            self.assertNotIn(HIDDEN, prompt)
            body = payload_of(prompt)
            self.assertIn('evidenceRefs', body)
            hits = num_refs(body['evidenceRefs'])
            self.assertEqual(sorted(h['start'] for h in hits), [0, blue.INDEX_PART])
            chosen = hits + [r for r in body['evidenceRefs'] if r not in hits][:6]
            self.assertLessEqual(len(chosen), blue.MAX_TARGETS)
            self.assertGreaterEqual(len(chosen), 2)
            holder['raw'] = ok(targets=[target(r) for r in chosen])
            holder['sent'] = copy.deepcopy(holder['raw'])
            return holder['raw']

        def final(prompt):
            self.assertLessEqual(len(prompt), blue.MAX_PROMPT)
            self.assertIn(NUM, prompt)
            return ok(findings=[])

        Fake, log = fake(select, final)
        result = run(data, Fake)
        self.assertEqual(holder['raw'], holder['sent'])
        self.assertEqual([schema for schema, _ in log['calls']], [blue.SCAN, blue.SCAN, blue.SELECTION, blue.RESULT])
        self.assertEqual(result['coverage']['calls'], 4)
        self.assertEqual(result['coverage']['reread']['status'], 'completed')
        windows = [w for w in result['coverage']['rereadWindows'] if w['segmentId'] == 's7']
        for start in (0, blue.INDEX_PART):
            self.assertTrue(any(w['start'] <= start and w['end'] >= start + len(NUM) for w in windows))

    def test_second_occurrence_window_excludes_the_first(self):
        data, s7 = repeated_document()

        def select(prompt):
            hit = num_refs(payload_of(prompt)['evidenceRefs'], blue.INDEX_PART)
            self.assertEqual(len(hit), 1)
            return ok(targets=[target(hit[0])])

        def final(prompt):
            self.assertEqual(prompt.count(NUM), 1)
            self.assertIn(NEAR2, prompt)
            self.assertNotIn(NEAR1, prompt)
            self.assertNotIn(HIDDEN, prompt)
            return ok(findings=[])

        Fake, log = fake(select, final)
        result = run(data, Fake)
        window = next(w for w in result['coverage']['rereadWindows'] if w['segmentId'] == 's7')
        share = min(len(s7), blue.WINDOW)
        centre = max(0, min(blue.INDEX_PART - (share - len(NUM)) // 2, len(s7) - share))
        self.assertEqual(window['start'], centre)
        self.assertGreater(window['start'], 240)
        self.assertEqual(s7[window['start']:window['end']].index(NUM), blue.INDEX_PART - window['start'])
        self.assertNotIn(blue.RESULT, [s for s, _ in log['calls']][:-1])

    def test_final_grounding_stays_strict(self):
        data, _ = repeated_document()

        def select(prompt):
            hit = num_refs(payload_of(prompt)['evidenceRefs'], blue.INDEX_PART)[0]
            return ok(targets=[target(hit)])

        cases = {
            'duplicate-literal': finding(NUM, NEAR2),
            'outside-window': finding(NEAR1, NEAR2),
            'inside-window': finding(NEAR2, NEAR2),
        }
        for name, item in cases.items():
            with self.subTest(name):
                Fake, _ = fake(select, lambda _p, item=item: ok(findings=[item]))
                if name == 'inside-window':
                    result = run(data, Fake)
                    self.assertEqual(result['findings'][0]['quote'], NEAR2)
                else:
                    with self.assertRaises(ValueError):
                        run(data, Fake)

    def test_bad_ids_and_repeated_literals_do_not_reach_final(self):
        data, _ = repeated_document()

        def prompts(anchor, segment='s7'):
            def select(prompt):
                return ok(targets=[{'segmentId': segment, 'anchor': anchor, 'reason': 'bad'}])
            return select

        real = {}

        def capture(prompt):
            real['id'] = num_refs(payload_of(prompt)['evidenceRefs'], 0)[0]['id']
            return ok(targets=[{'segmentId': 's8', 'anchor': real['id'], 'reason': 'wrong segment'},
                               {'segmentId': 's7', 'anchor': real['id'], 'reason': 'would have been valid'}])

        for name, select in [('malformed', prompts('er12')), ('unknown', prompts('er0000')),
                             ('literal', prompts(NUM)), ('mismatch', capture)]:
            with self.subTest(name):
                Fake, log = fake(select, lambda _p: ok(findings=[]))
                with self.assertRaises(ValueError):
                    run(data, Fake)
                self.assertNotIn(blue.RESULT, [schema for schema, _ in log['calls']])

    def test_prompt_bound_holds_with_refs(self):
        def body(k):
            return '"q" ' * 1500 + f'ANCHOR-{k} marker.' + ' "q"' * 1500
        data = request([(f's{k}', f'p{k}', body(k)) for k in range(8)])
        data['harness'] = {**harness.default('blue'), 'instructions': 'i' * 8000, 'maxCalls': 32}
        texts = [s['text'] for s in data['segments']]
        count = [0]

        def scan(prompt):
            k = count[0]
            count[0] += 1
            return ok(summary='s' * 2500, evidence=[{'segmentId': f's{min(k, 7)}', 'quote': texts[min(k, 7)][o:o + 600],
                       'relation': 'r' * 200} for o in (0, 600)])

        def select(prompt):
            self.assertLessEqual(len(prompt), blue.MAX_PROMPT)
            body_json = payload_of(prompt)
            self.assertIn('evidenceRefsTruncated', body_json)
            self.assertLessEqual(len(json.dumps(body_json['evidenceRefs'], ensure_ascii=False)), blue.MAX_PROMPT)
            return ok(targets=[{'segmentId': f's{k}', 'anchor': f'ANCHOR-{k} marker.', 'reason': 'legacy unique anchor'} for k in range(8)])

        Fake, log = fake(select, lambda _p: ok(findings=[]), scan)
        result = run(data, Fake)
        self.assertTrue(all(len(p) <= blue.MAX_PROMPT for _, p in log['calls']))
        self.assertEqual(result['coverage']['reread']['selectedSegments'], [f's{k}' for k in range(8)])
        self.assertLessEqual(result['coverage']['calls'], data['maxCalls'])


if __name__ == '__main__':
    unittest.main()

"""Multi-chunk BLUE evidence reread with fake models only (no real/paid agent calls)."""
import hashlib
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local'))
import harness
import blue_service as blue

QUAL = 'Efficacy was assessed only in patients younger than 40 years.'
CLAIM = 'We conclude that the treatment is effective for all adult patients regardless of age.'

def filler(n, tag):
    out, i = [], 0
    while sum(map(len, out)) < n:
        out.append(f'{tag} background sentence {i}. '); i += 1
    return ''.join(out)

def request(segments, max_calls=32, harness_calls=None):
    segs = [{'id': i, 'label': label, 'text': text} for i, label, text in segments]
    d = {'schema': blue.VERSION, 'revision': 'r1', 'requestId': 'b1', 'segments': segs, 'maxCalls': max_calls, 'consent': True,
         'sourceHash': hashlib.sha256('\n\n'.join(s['text'] for s in segs).encode()).hexdigest()}
    if harness_calls is not None: d['harness'] = {**harness.default('blue'), 'maxCalls': harness_calls}
    return d

def paper():  # 2 scan chunks; the Methods qualifier sits deep inside s1
    return request([('s0', 'Abstract', 'The treatment is effective for all adult patients. ' + filler(5000, 'abs')),
                    # The qualifier starts an index part (offset 18000), so only the index preview exposes it.
                    ('s1', 'Methods', filler(18000, 'met')[:18000] + QUAL + ' ' + filler(10000, 'mtw')),
                    ('s2', 'Results', filler(30000, 'res')),
                    ('s3', 'Discussion', CLAIM + ' ' + filler(2000, 'dis'))])

def ok(**kw): return {'status': 'ok', **kw}

def fake(select, final, scan=None, after=None):
    log = {'instances': [], 'calls': []}
    class Fake:
        def __init__(self, **kwargs): log['instances'].append(kwargs)
        def infer(self, prompt, schema):
            log['calls'].append((schema, prompt))
            if schema is blue.SCAN: r = scan(prompt) if scan else ok(summary='Chunk discusses a treatment.', evidence=[])
            elif schema is blue.SELECTION: r = select(prompt)
            else: r = final(prompt)
            if after: after(schema)
            return {'status': 'ok', 'response': r}
    return Fake, log

def target(sid, anchor, reason='check qualifier'): return {'segmentId': sid, 'anchor': anchor, 'reason': reason}

def finding(evidence_sid='s1', evidence_quote=QUAL):
    return {'id': 'f1', 'segmentId': 's3', 'quote': CLAIM, 'rationale': 'Conclusion drops the Methods age restriction.',
            'evidence': [{'segmentId': evidence_sid, 'quote': evidence_quote, 'relation': 'restricts population'}],
            'uncertainty': 'Internal text comparison only.'}

def run(data, Fake, event=None, progress=None):
    return blue.run_review(data, progress or (lambda _: None), event or threading.Event(), Fake)

def schemas(log): return [s for s, _ in log['calls']]

class RereadTests(unittest.TestCase):
    def test_cross_section_qualifier_reread_raw(self):
        def final(prompt):
            self.assertIn(QUAL, prompt)
            return ok(findings=[finding()])
        Fake, log = fake(lambda _: ok(targets=[target('s1', QUAL), target('s3', CLAIM)]), final)
        seen = []
        r = run(paper(), Fake, progress=seen.append)
        self.assertEqual(schemas(log), [blue.SCAN, blue.SCAN, blue.SELECTION, blue.RESULT])
        self.assertEqual(r['status'], 'ok'); self.assertEqual(len(r['findings']), 1)
        cov = r['coverage']; rr = cov['reread']
        self.assertEqual(set(rr), {'status', 'selectedSegments', 'deliveredChars', 'truncated', 'meaning'})
        self.assertEqual((cov['complete'], cov['calls'], cov['chunks']), (True, 4, 2))
        self.assertEqual((rr['status'], rr['selectedSegments'], rr['truncated']), ('completed', ['s1', 's3'], False))
        s1 = paper()['segments'][1]['text']; w = cov['rereadWindows'][0]
        self.assertTrue(w['start'] <= s1.index(QUAL) and w['end'] >= s1.index(QUAL) + len(QUAL))
        self.assertEqual(rr['deliveredChars'], sum(x['end'] - x['start'] for x in cov['rereadWindows']))
        self.assertEqual(rr['deliveredChars'], blue.WINDOW + len(paper()['segments'][3]['text']))
        self.assertEqual({p['requiredCalls'] for p in seen}, {4}); self.assertEqual([p['completedCalls'] for p in seen], [0, 1, 2, 3, 3])
        self.assertEqual([p['phase'] for p in seen], ['reviewing', 'reviewing', 'selecting', 'reread', 'finalizing'])
        self.assertTrue({p['phase'] for p in seen} <= set(blue.PHASES))
        self.assertEqual(log['instances'][0]['max_calls'], 4)

    def test_multichunk_empty_selection_abstains_without_final(self):
        Fake, log = fake(lambda _: ok(targets=[]), lambda _: self.fail('summary-only final must not run'))
        r = run(paper(), Fake)
        self.assertEqual((r['status'], r['findings'], r['coverage']['calls']), ('abstain', [], 3))
        self.assertEqual(r['coverage']['reread'], blue.reread_record('incomplete'))
        self.assertNotIn(blue.RESULT, schemas(log))

    def test_anchor_not_visible_to_selection_rejected(self):
        hidden = 'mtw background sentence 40.'  # unique in s1 but in neither a preview nor a note quote
        self.assertEqual(paper()['segments'][1]['text'].count(hidden), 1)
        Fake, log = fake(lambda _: ok(targets=[target('s1', hidden)]), lambda _: ok(findings=[]))
        with self.assertRaises(ValueError): run(paper(), Fake)
        self.assertNotIn(blue.RESULT, schemas(log))

    def test_scan_and_single_chunk_escape_bound_before_model(self):
        for text in ['\x01' * 20000, '\x01' * 72001]:  # JSON escaping expands each char to 6
            Fake, log = fake(lambda _: ok(targets=[]), lambda _: ok(findings=[]))
            with self.assertRaises(ValueError): run(request([('s0', 'p1', text)]), Fake)
            self.assertEqual((log['instances'], log['calls']), ([], []))

    def test_normal_control_zero_findings(self):
        Fake, _ = fake(lambda _: ok(targets=[target('s3', CLAIM)]), lambda _: ok(findings=[]))
        r = run(paper(), Fake)
        self.assertEqual((r['status'], r['findings'], r['coverage']['reread']['status']), ('ok', [], 'completed'))

    def test_finding_outside_final_context_rejected(self):
        Fake, _ = fake(lambda _: ok(targets=[target('s3', CLAIM)]), lambda _: ok(findings=[finding()]))
        with self.assertRaises(ValueError): run(paper(), Fake)

    def test_validated_scan_quote_counts_as_delivered(self):
        scan = lambda p: ok(summary='Methods restrict age.', evidence=[{'segmentId': 's1', 'quote': QUAL, 'relation': 'age limit'}] if QUAL in p else [])
        Fake, _ = fake(lambda _: ok(targets=[target('s3', CLAIM)]), lambda _: ok(findings=[finding()]), scan)
        self.assertEqual(len(run(paper(), Fake)['findings']), 1)

    def test_false_id_or_anchor_rejected_before_final(self):
        for bad in [target('s9', QUAL), target('s1', 'Invented sentence that is not supplied.'), target('s1', 'met background sentence')]:
            Fake, log = fake(lambda _, bad=bad: ok(targets=[bad]), lambda _: ok(findings=[]))
            with self.assertRaises(ValueError): run(paper(), Fake)
            self.assertNotIn(blue.RESULT, schemas(log))

    def test_long_same_id_segment_anchored_window(self):
        text = ('BEGINMARK opening. ' + filler(72000, 'lng'))[:72000] + QUAL + ' ' + filler(20000, 'tal')
        data = request([('s0', 'Body', text)])
        def select(prompt):
            self.assertIn('"offset": 84000', prompt)  # later parts of the same ID are indexed
            return ok(targets=[target('s0', QUAL)])
        def final(prompt):
            self.assertIn(QUAL, prompt); self.assertNotIn('BEGINMARK', prompt)
            return ok(findings=[])
        Fake, log = fake(select, final)
        r = run(data, Fake)
        w = r['coverage']['rereadWindows']
        self.assertEqual(len(w), 1); self.assertGreater(w[0]['start'], 60000)
        self.assertEqual(w[0]['end'] - w[0]['start'], blue.WINDOW); self.assertEqual(r['coverage']['calls'], 5)

    def test_budget_preflight_before_any_model(self):
        self.assertEqual(blue.validate_request(paper() | {'maxCalls': 4})[1], 4)
        for data in [paper() | {'maxCalls': 3}, request(paper()['segments'] and [(s['id'], s['label'], s['text']) for s in paper()['segments']], 32, 3)]:
            Fake, log = fake(lambda _: ok(targets=[]), lambda _: ok(findings=[]))
            with self.assertRaises(ValueError): run(data, Fake)
            self.assertEqual((log['instances'], log['calls']), ([], []))
        self.assertEqual(blue.validate_request(request([(s['id'], s['label'], s['text']) for s in paper()['segments']], 32, 4))[1], 4)

    def test_cancel_between_passes(self):
        event = threading.Event()
        Fake, log = fake(lambda _: ok(targets=[]), lambda _: ok(findings=[]),
                         after=lambda s: event.set() if schemas(log).count(blue.SCAN) == 2 else None)
        with self.assertRaises(ValueError): run(paper(), Fake, event)
        self.assertNotIn(blue.SELECTION, schemas(log))

    def test_selection_refusal_abstain_propagate(self):
        for status in ['refusal', 'abstain']:
            Fake, log = fake(lambda _, s=status: {'status': s, 'targets': []}, lambda _: ok(findings=[]))
            r = run(paper(), Fake)
            self.assertEqual((r['status'], r['findings'], r['coverage']['calls']), (status, [], 3))
            self.assertEqual(r['coverage']['reread']['status'], 'incomplete'); self.assertNotIn(blue.RESULT, schemas(log))
        Fake, _ = fake(lambda _: {'status': 'refusal', 'targets': [target('s3', CLAIM)]}, lambda _: ok(findings=[]))
        with self.assertRaises(ValueError): run(paper(), Fake)

    def test_final_abstain_and_scan_refusal(self):
        Fake, _ = fake(lambda _: ok(targets=[target('s1', QUAL)]), lambda _: {'status': 'abstain', 'findings': []})
        r = run(paper(), Fake)
        self.assertEqual((r['status'], r['findings']), ('abstain', []))
        Fake, _ = fake(lambda _: ok(targets=[target('s3', CLAIM)]), lambda _: {'status': 'refusal', 'findings': [finding()]})
        with self.assertRaises(ValueError): run(paper(), Fake)
        Fake, log = fake(lambda _: ok(targets=[]), lambda _: ok(findings=[]), scan=lambda _: {'status': 'refusal', 'summary': '', 'evidence': []})
        r = run(paper(), Fake)
        self.assertEqual((r['status'], r['coverage']['complete'], r['coverage']['reread']['status']), ('refusal', False, 'incomplete'))

    def test_one_chunk_backward_compatible(self):
        text = 'Short synthetic document. ' + CLAIM
        Fake, log = fake(lambda _: self.fail('no selection'), lambda p: (self.assertIn(text, p), ok(findings=[]))[1])
        r = run(request([('s0', 'p1', text)]), Fake)
        self.assertEqual(schemas(log), [blue.RESULT]); self.assertEqual(r['coverage']['calls'], 1)
        self.assertEqual(r['coverage']['reread'], blue.reread_record('not-needed'))
        self.assertEqual(r['coverage']['rereadWindows'], [])

    def test_max_prompt_bound_truncates_honestly(self):
        body = lambda k: '"q" ' * 1500 + f'ANCHOR-{k} marker.' + ' "q"' * 1500
        data = request([(f's{k}', f'p{k}', body(k)) for k in range(8)])
        data['harness'] = {**harness.default('blue'), 'instructions': 'i' * 8000, 'maxCalls': 32}
        texts = [s['text'] for s in data['segments']]; count = [0]
        def scan(prompt):
            k = 2 * count[0]; count[0] += 1
            return ok(summary='s' * 2500, evidence=[{'segmentId': f's{k}', 'quote': texts[k][o:o + 600], 'relation': 'r' * 1500} for o in (0, 600, 1200, 1800)])
        Fake, log = fake(lambda _: ok(targets=[target(f's{k}', f'ANCHOR-{k} marker.') for k in range(8)]), lambda _: ok(findings=[]), scan)
        r = run(data, Fake)
        self.assertTrue(all(len(p) <= blue.MAX_PROMPT for _, p in log['calls']))
        rr = r['coverage']['reread']
        self.assertEqual((rr['status'], rr['truncated']), ('incomplete', True))
        self.assertLessEqual(rr['deliveredChars'], blue.MAX_CONTEXT); self.assertGreater(rr['deliveredChars'], 0)
        self.assertEqual(rr['selectedSegments'], [f's{k}' for k in range(8)])

if __name__ == '__main__': unittest.main()

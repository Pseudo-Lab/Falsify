import hashlib
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local'))
import blue_service as blue

class Fake:
    instances = []
    def __init__(self, **kwargs): self.prompts=[]; self.__class__.instances.append(self)
    def infer(self, prompt, schema):
        self.prompts.append(prompt)
        if schema == blue.SCAN:
            return {'status':'ok','response':{'status':'ok','summary':'Read synthetic chunk.', 'evidence':[]}}
        if schema == blue.SELECTION:
            return {'status':'ok','response':{'status':'ok','targets':[]}}
        return {'status':'ok','response':{'status':'ok','findings':[]}}

class BlueTests(unittest.TestCase):
    def request(self, text='Synthetic document.'):
        return {'schema':blue.VERSION,'revision':'r1','requestId':'b1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'PDF p. 1','text':text}], 'maxCalls':8,'consent':True}
    def test_requires_consent(self):
        with self.assertRaises(ValueError): blue.validate_request({**self.request(),'consent':False})
    def test_rejects_red_metadata(self):
        for field in ['level','candidateRationales','gold','sourceName','fileHash','instructions']:
            with self.assertRaises(ValueError): blue.validate_request({**self.request(),field:'secret'})
    def test_rejects_segment_metadata(self):
        data=self.request();data['segments'][0]['gold']='secret'
        with self.assertRaises(ValueError): blue.validate_request(data)
    def test_budget_preflight(self):
        data=self.request('x'*72001);data['maxCalls']=1
        with self.assertRaises(ValueError): blue.run_review(data,lambda _:None,threading.Event(),Fake)
    def test_fresh_no_red_prompt(self):
        a=blue.run_review(self.request(),lambda _:None,threading.Event(),Fake)
        b=blue.run_review(self.request(),lambda _:None,threading.Event(),Fake)
        self.assertEqual(a['coverage']['calls'],1);self.assertEqual(b['coverage']['complete'],True)
        self.assertIsNot(Fake.instances[-1],Fake.instances[-2]);self.assertNotIn('candidateRationales',Fake.instances[-1].prompts[0])
    def test_complete_chunk_reads(self):
        r=blue.run_review(self.request('x'*72001),lambda _:None,threading.Event(),Fake)
        # 3 scans + reread selection; an empty selection abstains instead of a summary-only final (5 calls reserved)
        self.assertEqual(r['coverage']['calls'],4);self.assertEqual(len(Fake.instances[-1].prompts),4)
        self.assertEqual((r['status'],r['findings'],r['coverage']['reread']['status']),('abstain',[],'incomplete'))
    def test_cancelled(self):
        event=threading.Event();event.set()
        with self.assertRaises(ValueError): blue.run_review(self.request(),lambda _:None,event,Fake)
    def test_anchored_findings(self):
        f={'id':'f1','segmentId':'s0','quote':'Synthetic document.','rationale':'Reason','evidence':[{'segmentId':'s0','quote':'Synthetic','relation':'reason'}],'uncertainty':'Review pending'}
        blue.validate_findings({'status':'ok','findings':[f]},self.request()['segments'])
        with self.assertRaises(ValueError): blue.validate_findings({'status':'refusal','findings':[f]},self.request()['segments'])
        f['quote']='Invented'
        with self.assertRaises(ValueError): blue.validate_findings({'status':'ok','findings':[f]},self.request()['segments'])

if __name__=='__main__': unittest.main()

import hashlib
import json
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import harness
import red_service
import blue_service
from harness_adapter import AdapterBackend, validate_shape

class HarnessTests(unittest.TestCase):
    def request(self, role='red', text='Synthetic paper.'):
        d={'schema':'falsify.document-'+role+'.v1','revision':'r1','requestId':'t1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),
           'segments':[{'id':'s0','label':'p1','text':text}],'maxCalls':8,'consent':True,'harness':harness.default(role)}
        if role=='red':d['level']=1
        return d
    def test_role_and_fields(self):
        with self.assertRaises(ValueError):harness.validate(harness.default('red'),'blue')
        with self.assertRaises(ValueError):harness.validate({**harness.default('red'),'shell':'bad'},'red')
    def test_budget_preflight(self):
        d=self.request(text='x'*72001);d['harness']['maxCalls']=1
        with self.assertRaises(ValueError):red_service.validate_request(d)
    def test_blue_large_budget(self):
        d=self.request('blue','x'*360001);d['maxCalls']=32;d['harness']['maxCalls']=32
        self.assertEqual(blue_service.validate_request(d)[1],13)  # 11 scans + reread selection + final
    def test_digest_canonical(self):
        d=self.request();d['harness']['settings']={'temperature':0.00001};raw=json.dumps(d['harness'],ensure_ascii=False,sort_keys=True,separators=(',',':'));d['harnessCanonical']=raw
        self.assertEqual(harness.resolve(d,'red')[1],hashlib.sha256(raw.encode()).hexdigest())
        d['harnessCanonical']='{}'
        with self.assertRaises(ValueError):harness.resolve(d,'red')
    def custom(self,role):
        d=self.request(role);d['harness']['adapter']={'type':'stdio','executable':sys.executable,'args':[str(Path(__file__).parent/'fixtures'/'harness_stdout.py')]}
        return d
    def test_execution_consent(self):
        for role, service in [('red',red_service),('blue',blue_service)]:
            with self.assertRaises(ValueError):service.validate_request(self.custom(role))
    def test_stdio_red_and_blue_real_process(self):
        for role,service,key in [('red',red_service,'candidates'),('blue',blue_service,'findings')]:
            d=self.custom(role);d['executionConsent']=True
            r=service.run_review(d,lambda _:None,threading.Event())
            self.assertEqual(r[key],[]);self.assertEqual(r['model'],'custom-stdio-model-unverified');self.assertEqual(r['harnessHash'],harness.digest(d['harness']))
    def test_blue_rejects_metadata(self):
        d=self.request('blue')
        for k in ['gold','assessments','reviews','comparison','sourceName']:
            with self.assertRaises(ValueError):blue_service.validate_request({**d,k:'secret'})
    def test_shape_no_extra_fields(self):
        with self.assertRaises(ValueError):validate_shape({'status':'ok','findings':[],'hidden':True},blue_service.RESULT)
    def test_http_private_target_denied(self):
        h={**harness.default('blue'),'adapter':{'type':'http','url':'https://127.0.0.1/review'}}
        with self.assertRaises(ValueError):AdapterBackend(h,1).infer('Synthetic',blue_service.RESULT)

if __name__=='__main__':unittest.main()

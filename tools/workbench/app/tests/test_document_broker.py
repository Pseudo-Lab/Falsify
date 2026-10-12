"""Transport/auth/concurrency tests. Fake backend only; never invokes Codex."""
import hashlib
import http.client
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import server

class BrokerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);cls.port=cls.http.server_port
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.http.shutdown();cls.http.server_close();cls.thread.join()
    def call(self,path,method='GET',body=None,headers=None,auth=False):
        h={'Host':f'127.0.0.1:{self.port}',**(headers or {})}
        if auth:h.update({'Origin':f'http://127.0.0.1:{self.port}','Authorization':'Bearer '+server.TOKEN})
        if body is not None:h['Content-Type']='application/json'
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5);conn.request(method,path,body=json.dumps(body).encode() if isinstance(body,dict) else body,headers=h);res=conn.getresponse();raw=res.read();conn.close()
        return res.status,json.loads(raw) if res.getheader('Content-Type','').startswith('application/json') else raw
    def test_wrong_host(self):self.assertEqual(self.call('/',headers={'Host':'attacker.example'})[0],403)
    def test_bootstrap_sameorigin_browser(self):
        self.assertEqual(self.call('/api/session')[0],403)
        status,data=self.call('/api/session',headers={'Sec-Fetch-Site':'same-origin'});self.assertEqual(status,200);self.assertEqual(data['token'],server.TOKEN)
    def test_no_token(self):self.assertEqual(self.call('/api/red/jobs','POST',{})[0],403)
    def test_wrong_origin(self):
        self.assertEqual(self.call('/api/red/jobs','POST',{},headers={'Origin':'https://attacker.example','Authorization':'Bearer '+server.TOKEN})[0],403)
    def test_no_cors_preflight(self):self.assertEqual(self.call('/api/red/jobs','OPTIONS')[0],403)
    def test_capabilities_get(self):self.assertEqual(self.call('/api/capabilities',auth=True)[0],200)
    def test_blue_capability(self):self.assertIs(self.call('/api/capabilities',auth=True)[1]['blue'],True)
    def test_blue_rejects_plan(self):
        self.assertEqual(self.call('/api/blue/jobs','POST',{'schema':'falsify.document-edit-plan.v1'},auth=True)[0],400)
    def test_role_route_separation(self):
        server.JOBS['role-check']={'id':'role-check','role':'red','state':'completed','cancel':threading.Event()}
        try:
            self.assertEqual(self.call('/api/blue/jobs/role-check',auth=True)[0],404)
            self.assertEqual(self.call('/api/blue/jobs/role-check/cancel','POST',{},auth=True)[0],400)
            self.assertEqual(self.call('/api/red/jobs/role-check',auth=True)[0],200)
        finally:server.JOBS.pop('role-check')
    def test_sameorigin_get_without_origin(self):
        self.assertEqual(self.call('/api/capabilities',headers={'Sec-Fetch-Site':'same-origin','Authorization':'Bearer '+server.TOKEN})[0],200)
    def test_encoded_job_id_lookup_and_cancel(self):
        key='revision:request';server.JOBS[key]={'id':key,'role':'blue','state':'completed','cancel':threading.Event(),'result':{}}
        try:
            self.assertEqual(self.call('/api/blue/jobs/revision%3Arequest',auth=True)[0],200)
            self.assertEqual(self.call('/api/blue/jobs/revision%3Arequest/cancel','POST',{},auth=True)[0],200)
            self.assertTrue(server.JOBS[key]['cancel'].is_set())
        finally:server.JOBS.pop(key)
    def test_no_arbitrary_shell_route(self):self.assertEqual(self.call('/api/shell','POST',{'command':'anything'},auth=True)[0],404)
    def test_no_repository_source_serving(self):
        for path in ['/../local/server.py','/.git/config','/node_modules/','/local/server.py']:self.assertEqual(self.call(path)[0],404)
    def test_duplicate_json(self):self.assertEqual(self.call('/api/red/jobs','POST',b'{"schema":1,"schema":2}',auth=True)[0],400)
    def test_bad_contentlength(self):
        self.assertEqual(self.call('/api/red/jobs','POST',b'{}',headers={'Content-Length':'999999999'},auth=True)[0],400)
    def test_idempotent_and_cancel(self):
        text='Synthetic source.';data={'schema':'falsify.document-red.v1','revision':'r1','requestId':'synthetic-broker-1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'p1','text':text}],'level':1,'maxCalls':1,'consent':True}
        entered=threading.Event();exited=threading.Event();calls=[]
        def fake(d,progress,cancel):
            calls.append(d);entered.set();cancel.wait(2);exited.set();return {'status':'abstain','candidates':[]}
        with patch.object(server,'run_review',fake):
            self.assertEqual(self.call('/api/red/jobs','POST',data,auth=True)[0],202);self.assertTrue(entered.wait(1))
            self.assertEqual(self.call('/api/red/jobs','POST',data,auth=True)[0],200);self.assertEqual(len(calls),1)
            self.assertEqual(self.call('/api/red/jobs','POST',{**data,'requestId':'second-broker'},auth=True)[0],409)
            self.assertEqual(self.call('/api/red/jobs/synthetic-broker-1/cancel','POST',{},auth=True)[0],200);self.assertTrue(exited.wait(1))

if __name__=='__main__':unittest.main()

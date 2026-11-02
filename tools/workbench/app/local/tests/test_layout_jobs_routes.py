import http.client
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import layout_agent_service as service
from layout_agent_jobs import LayoutStepLedger
from test_layout_agent_jobs import LedgerTests  # included in normal discovery

def request():
    return {'schema': service.REQUEST_SCHEMA, 'consent': True, 'projectId': 'a'*64, 'step': 0,
            'maxSteps': 8, 'instruction': 'Arrange existing content', 'tools': ['finish'],
            'observations': [], 'images': [], 'sourceFiles': [{'path':'main.tex','text':'RED 71'}]}

class LayoutJobRoutes(unittest.TestCase):
    def test_authenticated_submit_lookup_idempotency_and_cors(self):
        calls=[]
        def decide(r):
            calls.append(r)
            return {'schema':service.RESPONSE_SCHEMA,'projectId':r['data']['projectId'],'step':0,
                    'action':{'tool':'finish','args':{},'message':'done'}}
        ledger=LayoutStepLedger(decide)
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        httpd.web_origin='https://allowed.example'
        worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start()
        def call(method,path,data=None,authorized=True):
            connection=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=5)
            headers={'Origin':httpd.web_origin}
            if authorized:headers['Authorization']='Bearer '+server.TOKEN
            if data is not None:headers['Content-Type']='application/json'
            connection.request(method,path,json.dumps(data) if data is not None else None,headers)
            response=connection.getresponse();body=json.loads(response.read());headers=dict(response.getheaders());connection.close()
            return response.status,body,headers
        try:
            with patch.object(server,'LAYOUT_JOBS',ledger):
                path=server.LAYOUT_JOBS_ROUTE
                self.assertEqual(call('POST',path,{'runId':'r1','stepId':'r1-s0','request':request()},False)[0],403)
                packet={'runId':'r1','stepId':'r1-s0','request':request()}
                status,receipt,headers=call('POST',path,packet)
                self.assertIn(status,(200,202));self.assertEqual(headers.get('Access-Control-Allow-Origin'),httpd.web_origin)
                for _ in range(20):
                    status,receipt,_=call('GET',path+'/r1-s0')
                    if receipt.get('state')=='completed':break
                self.assertEqual(receipt['state'],'completed');self.assertTrue(receipt['companionInstance'].startswith('ci1.'))
                self.assertEqual(call('POST',path,packet)[1]['fingerprint'],receipt['fingerprint']);self.assertEqual(len(calls),1)
                changed={**packet,'request':{**request(),'instruction':'Different'}}
                self.assertEqual(call('POST',path,changed)[0],409)
                self.assertEqual(call('GET',path+'/missing')[0],404)
                self.assertTrue(server.cors_route('GET',path+'/r1-s0'));self.assertFalse(server.cors_route('GET',path+'/r1-s0/cancel'))
        finally:httpd.shutdown();worker.join();httpd.server_close()

if __name__=='__main__':unittest.main()

"""Opt-in web-origin (GitHub Pages) CORS bridge tests. Ephemeral ports and fake backends only;
never invokes Codex and never touches a server on 7816. Assertions avoid echoing token contents."""
import hashlib
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import server

WEB='https://shinick-han.github.io'

def start(web_origin):
    http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
    if web_origin is not None:http.web_origin=web_origin
    thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
    return http,thread

def stop(http,thread):http.shutdown();http.server_close();thread.join()

class Client:
    def call(self,path,method='GET',body=None,headers=None,origin=WEB,token=True,host=None):
        h={'Host':host or f'127.0.0.1:{self.port}'}
        if origin is not None:h['Origin']=origin
        if token is True:h['Authorization']='Bearer '+server.TOKEN
        elif token:h['Authorization']=token
        if body is not None:h['Content-Type']='application/json'
        h.update(headers or {})
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        conn.request(method,path,body=json.dumps(body).encode() if isinstance(body,dict) else body,headers=h)
        res=conn.getresponse();raw=res.read();conn.close()
        data=json.loads(raw) if res.getheader('Content-Type','').startswith('application/json') else raw
        return res.status,{k.lower():v for k,v in res.getheaders()},data
    def preflight(self,path,method='POST',req_headers='authorization, content-type',origin=WEB,extra=None,host=None):
        h={'Access-Control-Request-Method':method,**(extra or {})}
        if req_headers is not None:h['Access-Control-Request-Headers']=req_headers
        return self.call(path,'OPTIONS',headers=h,origin=origin,token=False,host=host)

class ParseOriginTests(unittest.TestCase):
    def test_accepts_exact_https_origin(self):
        self.assertEqual(server.parse_web_origin(WEB),WEB)
        self.assertEqual(server.parse_web_origin('https://pages.example.com:8443'),'https://pages.example.com:8443')
    def test_rejects_invalid_origins(self):
        bad=['', 'http://shinick-han.github.io', WEB+'/', WEB+'/falsify', WEB+'?x=1', WEB+'#f', 'https://user:pw@shinick-han.github.io',
            'https://user@shinick-han.github.io', '*', 'https://*.github.io', 'https://*', WEB+','+WEB, WEB+' https://a.example', 'null',
            'https://Shinick-Han.github.io', WEB+':443', WEB+':0', WEB+':65536', WEB+':08443', WEB+':', ' '+WEB, WEB+' ', WEB+'\n',
            'https://localhost', 'https://.github.io', 'https://a..b', 'https://-a.example', 'https://exa mple.com', 'https:shinick-han.github.io',
            'https://ｓhinick.github.io', None]
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):server.parse_web_origin(value)

class CliTests(unittest.TestCase):
    class FakeServer:
        def __init__(self,*a,**k):self.web_origin='unset'
        def serve_forever(self):raise KeyboardInterrupt
        def server_close(self):pass
    def run_main(self,argv,factory=None):
        out=io.StringIO();err=io.StringIO();created=[]
        def make(*a,**k):
            s=(factory or self.FakeServer)(*a,**k);created.append(s);return s
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'FALSIFY_PAIRING_DIR':str(Path(tmp)/'pairing')}),\
                patch.object(sys,'argv',['server.py',*argv]),patch.object(server,'ThreadingHTTPServer',make),redirect_stdout(out),patch.object(sys,'stderr',err):
            try:server.main();code=0
            except SystemExit as e:code=e.code
        return code,out.getvalue(),err.getvalue(),created
    def test_invalid_origin_config_refuses_before_bind(self):
        for value in [WEB+'/', 'http://shinick-han.github.io', '*', WEB+','+WEB]:
            with self.subTest(value=value):
                code,out,err,created=self.run_main(['--port','40123','--web-origin',value])
                self.assertEqual(code,2);self.assertEqual(created,[]);self.assertFalse(server.TOKEN in out+err)
    def test_default_mode_prints_no_token(self):
        code,out,err,created=self.run_main(['--port','40123'])
        self.assertEqual(code,0);self.assertIsNone(created[0].web_origin);self.assertFalse(server.TOKEN in out+err)
    def test_opt_in_prints_token_after_bind_with_origin_trust_note(self):
        code,out,err,created=self.run_main(['--port','40123','--web-origin',WEB])
        self.assertEqual(code,0);self.assertEqual(created[0].web_origin,WEB)
        self.assertEqual(out.count(server.TOKEN),1);self.assertFalse(server.TOKEN in err)
        self.assertIn('origin-level, not path-level',out)
    def test_no_token_when_bind_fails(self):
        def fail(*a,**k):raise OSError('address in use')
        out=io.StringIO()
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,{'FALSIFY_PAIRING_DIR':str(Path(tmp)/'pairing')}),\
                patch.object(sys,'argv',['server.py','--port','40123','--web-origin',WEB]),patch.object(server,'ThreadingHTTPServer',fail),redirect_stdout(out):
            with self.assertRaises(OSError):server.main()
        self.assertFalse(server.TOKEN in out.getvalue())

class WebOriginTests(Client,unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.http,cls.thread=start(WEB);cls.port=cls.http.server_port
    @classmethod
    def tearDownClass(cls):stop(cls.http,cls.thread)
    def assertCors(self,headers):
        self.assertEqual(headers.get('access-control-allow-origin'),WEB);self.assertEqual(headers.get('vary'),'Origin')
        self.assertNotIn('access-control-allow-credentials',headers)
    def assertNoCors(self,headers):
        self.assertNotIn('access-control-allow-origin',headers);self.assertNotIn('access-control-allow-private-network',headers)
    def test_preflight_allowlisted_routes(self):
        for path,method in [('/api/capabilities','GET'),('/api/red/jobs','POST'),('/api/blue/jobs','POST'),('/api/export','POST'),
                ('/api/red/jobs/abc','GET'),('/api/blue/jobs/abc','GET'),('/api/red/jobs/abc/cancel','POST'),('/api/blue/jobs/a%3Ab/cancel','POST')]:
            with self.subTest(path=path,method=method):
                status,h,_=self.preflight(path,method)
                self.assertEqual(status,204);self.assertCors(h)
                self.assertEqual(h['access-control-allow-methods'],method);self.assertEqual(h['access-control-allow-headers'],'Authorization, Content-Type')
                self.assertNotIn('access-control-allow-private-network',h)
    def test_preflight_private_network_only_when_approved(self):
        status,h,_=self.preflight('/api/red/jobs',extra={'Access-Control-Request-Private-Network':'true'})
        self.assertEqual(status,204);self.assertEqual(h['access-control-allow-private-network'],'true')
        status,h,_=self.preflight('/api/session','GET',extra={'Access-Control-Request-Private-Network':'true'})
        self.assertEqual(status,403);self.assertNoCors(h)
        status,h,_=self.preflight('/api/red/jobs',origin='https://attacker.example',extra={'Access-Control-Request-Private-Network':'true'})
        self.assertEqual(status,403);self.assertNoCors(h)
    def test_preflight_rejections(self):
        cases=[('/api/red/jobs','POST','authorization, x-custom',WEB,None),('/api/red/jobs','POST','cookie',WEB,None),
            ('/api/red/jobs','PUT','authorization',WEB,None),('/api/red/jobs','DELETE',None,WEB,None),('/api/red/jobs','',None,WEB,None),
            ('/api/red/jobs','GET','authorization',WEB,None),('/api/capabilities','POST','authorization',WEB,None),
            ('/api/session','GET','authorization',WEB,None),('/api/shell','POST','authorization',WEB,None),('/','GET',None,WEB,None),
            ('/index.html','GET',None,WEB,None),('/api/red/jobs','POST','authorization','https://attacker.example',None),
            ('/api/red/jobs','POST','authorization','null',None),('/api/red/jobs','POST','authorization',WEB+'/',None),
            ('/api/red/jobs','POST','authorization','http://shinick-han.github.io',None),('/api/red/jobs','POST','authorization',None,None),
            ('/api/red/jobs','POST','authorization',WEB,'shinick-han.github.io'),('/api/red/jobs','POST','authorization',WEB,'localhost:1')]
        for path,method,hdrs,origin,host in cases:
            with self.subTest(path=path,method=method,hdrs=hdrs,origin=origin,host=host):
                status,h,_=self.preflight(path,method,hdrs,origin=origin,host=host)
                self.assertEqual(status,403);self.assertNoCors(h)
    def test_capabilities_with_token_and_origin(self):
        status,h,data=self.call('/api/capabilities')
        self.assertEqual(status,200);self.assertCors(h);self.assertIs(data['red'],True)
        self.assertEqual(h['x-content-type-options'],'nosniff');self.assertEqual(h['cache-control'],'no-store');self.assertEqual(h['referrer-policy'],'no-referrer')
    def test_missing_and_bad_tokens(self):
        for name,token in [('missing',False),('wrong','Bearer wrong'),('empty','Bearer '),('basic','Basic '+server.TOKEN),
                ('bare',server.TOKEN),('lowercase','bearer '+server.TOKEN),('suffixed','Bearer '+server.TOKEN+'x')]:
            with self.subTest(case=name):
                for path,method,body in [('/api/capabilities','GET',None),('/api/red/jobs','POST',{})]:
                    status,h,data=self.call(path,method,body,token=token)
                    self.assertEqual(status,403);self.assertCors(h);self.assertEqual(data,{'error':'unauthorized'})
    def test_wrong_or_opaque_origin_with_token(self):
        for origin in ['https://attacker.example','null','https://shinick-han.github.io.attacker.example','http://shinick-han.github.io',WEB+':8443',WEB.upper()]:
            with self.subTest(origin=origin):
                for path,method,body in [('/api/capabilities','GET',None),('/api/red/jobs','POST',{})]:
                    status,h,_=self.call(path,method,body,origin=origin)
                    self.assertEqual(status,403);self.assertNoCors(h)
    def test_session_bootstrap_never_served_to_web_origin(self):
        for fetch_site in [None,'same-origin','cross-site','same-site','none']:
            with self.subTest(fetch_site=fetch_site):
                status,h,raw=self.call('/api/session',headers={'Sec-Fetch-Site':fetch_site} if fetch_site else None,token=False)
                self.assertEqual(status,403);self.assertNoCors(h);self.assertFalse(server.TOKEN.encode() in json.dumps(raw).encode())
        status,_,raw=self.call('/api/session',origin='https://attacker.example',headers={'Sec-Fetch-Site':'same-origin'},token=False)
        self.assertEqual(status,403);self.assertFalse(server.TOKEN in json.dumps(raw))
    def test_local_same_origin_unchanged_when_web_origin_configured(self):
        status,h,data=self.call('/api/session',origin=None,token=False,headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,200);self.assertNoCors(h);self.assertTrue(data['token']==server.TOKEN)
        status,h,_=self.call('/api/capabilities',origin=f'http://127.0.0.1:{self.port}')
        self.assertEqual(status,200);self.assertNoCors(h)
    def test_host_rebind_protection(self):
        for host in ['shinick-han.github.io','attacker.example',f'localhost:{self.port}',f'127.0.0.1:{self.port+1}']:
            with self.subTest(host=host):
                status,h,_=self.call('/api/capabilities',host=host)
                self.assertEqual(status,403);self.assertNoCors(h)
                status,h,_=self.call('/api/session',host=host,origin=None,token=False,headers={'Sec-Fetch-Site':'same-origin'})
                self.assertEqual(status,403);self.assertNoCors(h)
    def test_unlisted_routes_and_methods(self):
        for path,method,body in [('/api/shell','POST',{'command':'x'}),('/api/session','GET',None),('/api/red/jobs','GET',None),
                ('/api/capabilities','POST',{}),('/','GET',None),('/index.html','GET',None),('/local/server.py','GET',None)]:
            with self.subTest(path=path,method=method):
                status,h,_=self.call(path,method,body)
                self.assertNoCors(h)
                if path.startswith('/api/'):self.assertIn(status,[403,404])
        for method in ['PUT','DELETE','PATCH']:
            with self.subTest(method=method):
                status,h,_=self.call('/api/red/jobs',method,{})
                self.assertNoCors(h);self.assertNotEqual(status//100,2)
    def test_cors_on_error_responses(self):
        status,h,_=self.call('/api/red/jobs/does-not-exist');self.assertEqual(status,404);self.assertCors(h)
        status,h,_=self.call('/api/red/jobs','POST',b'{"a":1,"a":2}');self.assertEqual(status,400);self.assertCors(h)
        status,h,_=self.call('/api/red/jobs','POST',{'schema':'nope'});self.assertEqual(status,400);self.assertCors(h)
    def test_export_with_fake_handler(self):
        with patch.object(server,'handle_export',lambda d:{'synthetic':True,'format':d.get('format')}):
            status,h,data=self.call('/api/export','POST',{'format':'PDF'})
        self.assertEqual(status,200);self.assertCors(h);self.assertEqual(data,{'synthetic':True,'format':'PDF'})
    def test_red_job_flow_semantics_unchanged(self):
        text='Synthetic web source.';data={'schema':'falsify.document-red.v1','revision':'r1','requestId':'synthetic-web-1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'p1','text':text}],'level':1,'maxCalls':1,'consent':True}
        entered=threading.Event();exited=threading.Event();calls=[]
        def fake(d,progress,cancel):
            calls.append(d);entered.set();cancel.wait(2);exited.set();return {'status':'abstain','candidates':[]}
        try:
            with patch.object(server,'run_review',fake):
                status,h,body=self.call('/api/red/jobs','POST',data);self.assertEqual(status,202);self.assertCors(h);self.assertTrue(entered.wait(1))
                status,h,_=self.call('/api/red/jobs','POST',data);self.assertEqual(status,200);self.assertEqual(len(calls),1)
                status,h,_=self.call('/api/red/jobs','POST',{**data,'requestId':'synthetic-web-2'});self.assertEqual(status,409);self.assertCors(h)
                status,h,job=self.call('/api/red/jobs/synthetic-web-1');self.assertEqual(status,200);self.assertCors(h);self.assertEqual(job['role'],'red')
                self.assertNotIn('fingerprint',job)
                status,h,_=self.call('/api/blue/jobs/synthetic-web-1');self.assertEqual(status,404);self.assertCors(h)
                status,h,_=self.call('/api/red/jobs/synthetic-web-1/cancel','POST',{});self.assertEqual(status,200);self.assertCors(h);self.assertTrue(exited.wait(1))
        finally:
            server.JOBS.pop('synthetic-web-1',None)

class DefaultDenialTests(Client,unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.http,cls.thread=start(None);cls.port=cls.http.server_port
    @classmethod
    def tearDownClass(cls):stop(cls.http,cls.thread)
    def test_web_origin_denied_without_opt_in(self):
        status,h,_=self.preflight('/api/red/jobs',extra={'Access-Control-Request-Private-Network':'true'})
        self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h);self.assertNotIn('access-control-allow-private-network',h)
        for path,method,body in [('/api/capabilities','GET',None),('/api/red/jobs','POST',{})]:
            status,h,_=self.call(path,method,body)
            self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h);self.assertNotIn('vary',h)
        status,_,raw=self.call('/api/session',token=False,headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,403);self.assertFalse(server.TOKEN in json.dumps(raw))

if __name__=='__main__':unittest.main()

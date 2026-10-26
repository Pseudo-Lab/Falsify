"""Native-launcher companion lifecycle: GET /api/launcher/instance and POST /api/launcher/restart.
Ephemeral ports and fake backends only; never invokes Codex/Claude and never touches a server on 7816.
Assertions avoid echoing token contents. Global ACTIVE/JOBS are restored after every test."""
import http.client
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
LOCAL=Path(__file__).resolve().parents[1]/'local'
sys.path.insert(0,str(LOCAL))
import server
import editor_service

WEB='https://shinick-han.github.io'
SCHEMA='falsify-companion-lifecycle/1'
KEYS={'schema','pid','instanceId','serverPath','webOrigin','busy'}

def active_free():
    if not server.ACTIVE.acquire(blocking=False):return False
    server.ACTIVE.release();return True

class Base(unittest.TestCase):
    web_origin=None
    def setUp(self):
        self.assertTrue(active_free(),'ACTIVE leaked from an earlier test')
        jobs=patch.dict(server.JOBS,clear=True);jobs.start();self.addCleanup(jobs.stop)
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);self.http.daemon_threads=True
        if self.web_origin is not None:self.http.web_origin=self.web_origin
        self.port=self.http.server_port
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.stop)
    def stop(self):
        if self.thread.is_alive():self.http.shutdown()
        self.thread.join(5);self.http.server_close()
        self.assertTrue(active_free(),'ACTIVE still held after server_close')
    def call(self,path,method='GET',body=None,headers=None,token=True,launcher=True,host=None,content_type='application/json'):
        h={'Host':host or f'127.0.0.1:{self.port}'}
        if launcher:h['X-Falsify-Launcher']='1'
        if token is True:h['Authorization']='Bearer '+server.TOKEN
        elif token:h['Authorization']=token
        if body is not None and content_type:h['Content-Type']=content_type
        h.update(headers or {})
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        try:
            raw_body=json.dumps(body).encode() if isinstance(body,(dict,list)) else body
            conn.request(method,path,body=raw_body,headers=h)
            res=conn.getresponse();raw=res.read()
        finally:conn.close()
        data=json.loads(raw) if res.getheader('Content-Type','').startswith('application/json') else raw
        return res.status,{k.lower():v for k,v in res.getheaders()},data
    def instance(self,**kw):return self.call('/api/launcher/instance',**kw)
    def restart(self,body=None,**kw):
        if body is None:body={'schema':SCHEMA,'instanceId':self.http.instance_id}
        return self.call('/api/launcher/restart','POST',body,**kw)
    def assertAlive(self):
        self.assertFalse(self.http.closing);self.assertTrue(self.thread.is_alive());self.assertTrue(active_free())
        status,_,data=self.instance();self.assertEqual(status,200);self.assertIs(data['busy'],False)

class DescriptorTests(Base):
    def test_exact_descriptor(self):
        status,h,data=self.instance()
        self.assertEqual(status,200);self.assertEqual(set(data),KEYS)
        self.assertEqual(data['schema'],SCHEMA);self.assertEqual(data['pid'],os.getpid())
        self.assertEqual(data['instanceId'],self.http.instance_id);self.assertIsInstance(data['instanceId'],str)
        self.assertEqual(data['serverPath'],str((LOCAL/'server.py').resolve()))
        self.assertIsNone(data['webOrigin']);self.assertIs(data['busy'],False)
        self.assertNotIn('access-control-allow-origin',h);self.assertEqual(h['cache-control'],'no-store')
        self.assertFalse(server.TOKEN in json.dumps(data))
    def test_instance_id_is_per_server(self):
        other=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        try:self.assertNotEqual(other.instance_id,self.http.instance_id)
        finally:other.server_close()
    def test_identity_not_in_public_capabilities(self):
        status,_,raw=self.call('/api/session',token=False,launcher=False,headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,200)
        status,_,caps=self.call('/api/capabilities',launcher=False,headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,200);self.assertFalse(self.http.instance_id in json.dumps(caps))
        self.assertFalse(server.TOKEN in json.dumps(caps));self.assertNotIn('instanceId',caps)

class AuthTests(Base):
    def denied_cases(self):
        own=f'http://127.0.0.1:{self.port}'
        return [('no marker',{'launcher':False}),('marker 0',{'headers':{'X-Falsify-Launcher':'0'}}),
            ('marker true',{'headers':{'X-Falsify-Launcher':'true'}}),('no token',{'token':False}),('wrong token',{'token':'Bearer wrong'}),
            ('lowercase bearer',{'token':'bearer '+server.TOKEN}),('suffixed token',{'token':'Bearer '+server.TOKEN+'x'}),
            ('bare token',{'token':server.TOKEN}),('own origin',{'headers':{'Origin':own}}),('web origin',{'headers':{'Origin':WEB}}),
            ('null origin',{'headers':{'Origin':'null'}}),('empty origin',{'headers':{'Origin':''}}),
            ('fetch same-origin',{'headers':{'Sec-Fetch-Site':'same-origin'}}),('fetch none',{'headers':{'Sec-Fetch-Site':'none'}}),
            ('fetch cross-site',{'headers':{'Sec-Fetch-Site':'cross-site'}}),('fetch empty',{'headers':{'Sec-Fetch-Site':''}}),
            ('localhost host',{'host':f'localhost:{self.port}'}),('other port host',{'host':f'127.0.0.1:{self.port+1}'}),
            ('remote host',{'host':'attacker.example'})]
    def test_get_denied(self):
        for name,kw in self.denied_cases():
            with self.subTest(case=name):
                status,h,data=self.instance(**kw)
                self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h)
                self.assertFalse(isinstance(data,dict) and 'instanceId' in data)
    def test_post_denied_without_effect(self):
        for name,kw in self.denied_cases():
            with self.subTest(case=name):
                status,h,_=self.restart(**kw)
                self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h)
        self.assertAlive()
    def test_browser_session_token_works_only_with_launcher_shape(self):
        status,_,data=self.call('/api/session',token=False,launcher=False,headers={'Sec-Fetch-Site':'same-origin'})
        self.assertEqual(status,200);self.assertTrue(data['token']==server.TOKEN)
        self.assertEqual(self.instance()[0],200)
        self.assertEqual(self.instance(headers={'Sec-Fetch-Site':'same-origin'})[0],403)

class CorsTests(Base):
    web_origin=WEB
    def test_preflight_denied(self):
        for path,method in [('/api/launcher/instance','GET'),('/api/launcher/restart','POST')]:
            for origin in [WEB,f'http://127.0.0.1:{self.port}','https://attacker.example']:
                with self.subTest(path=path,origin=origin):
                    status,h,_=self.call(path,'OPTIONS',token=False,launcher=False,headers={'Origin':origin,
                        'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'authorization, content-type, x-falsify-launcher',
                        'Access-Control-Request-Private-Network':'true'})
                    self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h)
                    self.assertNotIn('access-control-allow-private-network',h)
    def test_configured_web_origin_rejected_and_reported(self):
        status,h,_=self.instance(headers={'Origin':WEB});self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h)
        status,h,_=self.restart(headers={'Origin':WEB});self.assertEqual(status,403);self.assertNotIn('access-control-allow-origin',h)
        status,_,data=self.instance();self.assertEqual(status,200);self.assertEqual(data['webOrigin'],WEB)
        self.assertAlive()
    def test_existing_cors_route_unchanged(self):
        status,h,_=self.call('/api/capabilities',launcher=False,headers={'Origin':WEB})
        self.assertEqual(status,200);self.assertEqual(h.get('access-control-allow-origin'),WEB)

class BodyTests(Base):
    def test_invalid_bodies_400(self):
        good=lambda:self.http.instance_id
        cases=[('wrong content type',{'body':{'schema':SCHEMA,'instanceId':good()},'content_type':'text/plain'}),
            ('charset content type',{'body':{'schema':SCHEMA,'instanceId':good()},'content_type':'application/json; charset=utf-8'}),
            ('no content type',{'body':{'schema':SCHEMA,'instanceId':good()},'content_type':None}),
            ('empty',{'body':b''}),('oversized',{'body':json.dumps({'schema':SCHEMA,'instanceId':good()+' '*1100}).encode()}),
            ('not json',{'body':b'{schema'}),('bad utf8',{'body':b'{"schema":"\xff"}'}),('array',{'body':[SCHEMA,good()]}),
            ('string',{'body':b'"x"'}),('missing id',{'body':{'schema':SCHEMA}}),('missing schema',{'body':{'instanceId':good()}}),
            ('extra key',{'body':{'schema':SCHEMA,'instanceId':good(),'force':True}}),
            ('duplicate key',{'body':('{"schema":"%s","instanceId":"x","instanceId":"%s"}'%(SCHEMA,good())).encode()}),
            ('wrong schema',{'body':{'schema':'falsify-companion-lifecycle/2','instanceId':good()}}),
            ('numeric id',{'body':{'schema':SCHEMA,'instanceId':1}}),('null id',{'body':{'schema':SCHEMA,'instanceId':None}}),
            ('nan',{'body':('{"schema":"%s","instanceId":NaN}'%SCHEMA).encode()})]
        for name,kw in cases:
            with self.subTest(case=name):
                status,_,data=self.call('/api/launcher/restart','POST',**kw)
                self.assertEqual(status,400);self.assertEqual(data,{'error':'invalid_request'})
        self.assertAlive()
    def test_identity_mismatch_409(self):
        for value in ['', 'x'*32, self.http.instance_id+'x', self.http.instance_id.upper() if self.http.instance_id.upper()!=self.http.instance_id else 'Y', 'é']:
            with self.subTest(value=len(value)):
                status,_,data=self.restart({'schema':SCHEMA,'instanceId':value})
                self.assertEqual(status,409);self.assertEqual(data,{'error':'instance_mismatch'})
        other=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        try:status,_,_=self.restart({'schema':SCHEMA,'instanceId':other.instance_id})
        finally:other.server_close()
        self.assertEqual(status,409);self.assertAlive()

class BusyTests(Base):
    def assertBusyRefusal(self):
        status,_,data=self.instance();self.assertEqual(status,200);self.assertIs(data['busy'],True)
        status,_,data=self.restart();self.assertEqual(status,409);self.assertEqual(data,{'error':'companion_busy'})
        self.assertFalse(self.http.closing);self.assertTrue(self.thread.is_alive())
    def test_active_in_use(self):
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        try:self.assertBusyRefusal()
        finally:server.ACTIVE.release()
        self.assertAlive()
    def test_running_job_not_cancelled(self):
        cancel=threading.Event();server.JOBS['running']={'id':'running','role':'red','state':'running','cancel':cancel}
        self.assertBusyRefusal();self.assertFalse(cancel.is_set())
    def test_recent_finished_results_protected(self):
        for state in ['completed','failed','cancelled']:
            with self.subTest(state=state):
                server.JOBS.clear()
                cancel=threading.Event()
                server.JOBS['done']={'id':'done','role':'blue','state':state,'cancel':cancel,'result':{'x':1},'finished':time.monotonic()-3500}
                self.assertBusyRefusal();self.assertFalse(cancel.is_set());self.assertEqual(server.JOBS['done']['result'],{'x':1})
    def test_expired_results_not_busy(self):
        server.JOBS['old']={'id':'old','role':'red','state':'completed','cancel':threading.Event(),'finished':time.monotonic()-3601}
        status,_,data=self.instance();self.assertEqual(status,200);self.assertIs(data['busy'],False)
    def test_busy_reply_has_no_job_details(self):
        server.JOBS['secret-request']={'id':'secret-request','role':'red','state':'completed','cancel':threading.Event(),'result':{'paper':'P'},'finished':time.monotonic()}
        status,_,data=self.instance();self.assertEqual(set(data),KEYS)
        self.assertNotIn('secret-request',json.dumps(data));self.assertNotIn('paper',json.dumps(data))

class RestartTests(Base):
    def gate_shutdown(self):
        gate=threading.Event();orig=self.http.shutdown;called=threading.Event()
        def gated():
            called.set();gate.wait(10);orig()
        self.http.shutdown=gated
        self.addCleanup(gate.set)
        return gate,called
    def test_idle_restart_shuts_down_and_releases_port(self):
        status,_,data=self.restart();self.assertEqual(status,200);self.assertEqual(data,{'restarting':True})
        self.thread.join(5);self.assertFalse(self.thread.is_alive())
        self.assertFalse(active_free())  # reservation held until the server closes
        self.http.server_close();self.assertTrue(active_free())
        # Match the replacement companion's platform socket policy. On Linux a
        # bare non-reuse socket can fail on TIME_WAIT after the listener closes;
        # Windows retains the production class's exclusive binding behavior.
        replacement=server.ThreadingHTTPServer(('127.0.0.1',self.port),server.Handler)
        replacement.server_close()
    def test_reserved_restart_blocks_admission_and_repeats(self):
        gate,called=self.gate_shutdown()
        self.assertEqual(self.restart()[0],200);self.assertTrue(called.wait(5))
        status,_,data=self.instance();self.assertEqual(status,200);self.assertIs(data['busy'],True)
        status,_,data=self.restart();self.assertEqual(status,409);self.assertEqual(data,{'error':'companion_busy'})
        ran=[]
        with patch.object(server,'run_review',lambda *a:ran.append(1)),patch.object(server,'run_blue_review',lambda *a:ran.append(1)),patch.object(server,'handle_export',lambda d:ran.append(1) or {}):
            for path in ['/api/red/jobs','/api/blue/jobs']:
                status,_,_=self.call(path,'POST',{'requestId':'r'},launcher=False,headers={'Origin':f'http://127.0.0.1:{self.port}'})
                self.assertIn(status,[400,409])
            text='Synthetic.';import hashlib
            red={'schema':'falsify.document-red.v1','revision':'r1','requestId':'admit-1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'p1','text':text}],'level':1,'maxCalls':1,'consent':True}
            status,_,_=self.call('/api/red/jobs','POST',red,launcher=False,headers={'Origin':f'http://127.0.0.1:{self.port}'});self.assertEqual(status,409)
            status,_,_=self.call('/api/export','POST',{'format':'PDF'},launcher=False,headers={'Origin':f'http://127.0.0.1:{self.port}'});self.assertEqual(status,409)
        self.assertEqual(ran,[]);self.assertNotIn('admit-1',server.JOBS)
        gate.set();self.thread.join(5);self.assertFalse(self.thread.is_alive())
    def test_concurrent_restarts_exactly_one(self):
        gate,_=self.gate_shutdown();n=8;barrier=threading.Barrier(n);results=[None]*n
        def go(i):
            barrier.wait(5);results[i]=self.restart()[:3:2]
        threads=[threading.Thread(target=go,args=(i,)) for i in range(n)]
        for t in threads:t.start()
        for t in threads:t.join(10)
        self.assertEqual(sum(1 for r in results if r==(200,{'restarting':True})),1)
        self.assertEqual(sum(1 for r in results if r==(409,{'error':'companion_busy'})),n-1)
        gate.set();self.thread.join(5);self.assertFalse(self.thread.is_alive())
    def test_restart_races_job_admission(self):
        import hashlib
        for round_ in range(6):
            with self.subTest(round=round_):
                release=threading.Event();text='Synthetic race.'
                red={'schema':'falsify.document-red.v1','revision':'r1','requestId':f'race-{round_}','sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'p1','text':text}],'level':1,'maxCalls':1,'consent':True}
                gate,_=self.gate_shutdown();barrier=threading.Barrier(2);out={}
                def fake(d,progress,cancel):release.wait(10);return {'status':'abstain','candidates':[]}
                with patch.object(server,'run_review',fake):
                    def job():barrier.wait(5);out['job']=self.call('/api/red/jobs','POST',red,launcher=False,headers={'Origin':f'http://127.0.0.1:{self.port}'})[0]
                    def rst():barrier.wait(5);out['restart']=self.restart()[0]
                    ts=[threading.Thread(target=job),threading.Thread(target=rst)]
                    for t in ts:t.start()
                    for t in ts:t.join(10)
                    self.assertIn((out['job'],out['restart']),[(202,409),(409,200)])
                    release.set()
                    if out['restart']==200:
                        gate.set();self.thread.join(5);self.assertFalse(self.thread.is_alive())
                        self.http.server_close();self.assertTrue(active_free())
                        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);self.http.daemon_threads=True;self.port=self.http.server_port
                        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
                    else:
                        gate.set()  # unblock this round's shutdown wrapper so a later round's restart can chain through it
                        deadline=time.monotonic()+5
                        while not active_free() and time.monotonic()<deadline:time.sleep(0.01)
                        self.assertTrue(active_free())
                server.JOBS.clear()

    def test_late_admission_after_server_close(self):
        """A request accepted before restart but delayed in body parsing must never start work, even after
        server_close has released the restart reservation."""
        import hashlib
        text='Synthetic late.';marker='late-admission-marker'
        red={'schema':'falsify.document-red.v1','revision':'r1','requestId':marker,'sourceHash':hashlib.sha256(text.encode()).hexdigest(),'segments':[{'id':'s0','label':'p1','text':text}],'level':1,'maxCalls':1,'consent':True}
        orig=json.loads;entered=threading.Semaphore(0);hold=threading.Event();self.addCleanup(hold.set)
        def slow(s,*a,**k):
            if isinstance(s,str) and marker in s:entered.release();hold.wait(10)
            return orig(s,*a,**k)
        ran=[];out={}
        own={'Origin':f'http://127.0.0.1:{self.port}'}
        with patch.object(server.json,'loads',slow),patch.object(server,'run_review',lambda *a:ran.append('red')),patch.object(server,'handle_export',lambda d:ran.append('export') or {}):
            def job():out['job']=self.call('/api/red/jobs','POST',red,launcher=False,headers=own)
            def exp():out['export']=self.call('/api/export','POST',{'format':'PDF','tag':marker},launcher=False,headers=own)
            ts=[threading.Thread(target=job),threading.Thread(target=exp)]
            for t in ts:t.start()
            self.assertTrue(entered.acquire(timeout=5));self.assertTrue(entered.acquire(timeout=5))
            self.assertEqual(self.restart()[0],200)
            self.thread.join(5);self.assertFalse(self.thread.is_alive())
            self.http.server_close();self.assertTrue(active_free())
            hold.set()
            for t in ts:t.join(10)
        self.assertEqual(out['job'][0],409);self.assertEqual(out['export'][0],409)
        self.assertEqual(ran,[]);self.assertNotIn(marker,server.JOBS);self.assertTrue(active_free())

@unittest.skipUnless(os.environ.get('FALSIFY_SKIP_PROCESS_TESTS')!='1','process test disabled')
class ProcessRestartTests(unittest.TestCase):
    def free_port(self):
        s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();return port
    def req(self,port,method,path,headers,body=None):
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
        try:
            conn.request(method,path,body=body,headers={'Host':f'127.0.0.1:{port}',**headers});res=conn.getresponse()
            return res.status,json.loads(res.read())
        finally:conn.close()
    def test_real_process_restart_exits_and_releases_port(self):
        port=self.free_port()
        env={k:v for k,v in os.environ.items() if k not in {editor_service.ENV_ROOT,editor_service.ENV_MANIFEST,editor_service.ENV_SOURCE_ROOT,editor_service.ENV_NODE}}
        # A Windows venv python.exe is a redirector with a different pid; run the base interpreter on the same site-packages
        # so the descriptor pid must equal the launched process pid exactly.
        env['PYTHONPATH']=os.pathsep.join([p for p in sys.path if p.endswith('site-packages')]+([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
        proc=subprocess.Popen([getattr(sys,'_base_executable',sys.executable),str(LOCAL/'server.py'),'--port',str(port)],cwd=str(LOCAL.parents[1]),env=env,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            deadline=time.monotonic()+20;token=None
            while token is None:
                try:token=self.req(port,'GET','/api/session',{'Sec-Fetch-Site':'same-origin'})[1]['token']
                except OSError:
                    self.assertIsNone(proc.poll(),'server exited early');self.assertLess(time.monotonic(),deadline);time.sleep(0.1)
            auth={'Authorization':'Bearer '+token,'X-Falsify-Launcher':'1'}
            status,desc=self.req(port,'GET','/api/launcher/instance',auth)
            self.assertEqual(status,200);self.assertEqual(desc['pid'],proc.pid);self.assertIs(desc['busy'],False)
            self.assertEqual(desc['serverPath'],str((LOCAL/'server.py').resolve()));self.assertIsNone(desc['webOrigin'])
            status,_=self.req(port,'POST','/api/launcher/restart',{**auth,'Content-Type':'application/json'},json.dumps({'schema':SCHEMA,'instanceId':'nope'}).encode())
            self.assertEqual(status,409);self.assertIsNone(proc.poll())
            status,data=self.req(port,'POST','/api/launcher/restart',{**auth,'Content-Type':'application/json'},json.dumps({'schema':SCHEMA,'instanceId':desc['instanceId']}).encode())
            self.assertEqual((status,data),(200,{'restarting':True}))
            out,err=proc.communicate(timeout=20)
            self.assertEqual(proc.returncode,0)
            logs=out+err;self.assertNotIn(token.encode(),logs);self.assertNotIn(desc['instanceId'].encode(),logs)
            # Rebind with the production server class so the proof follows its binding policy exactly:
            # exclusive on Windows, stdlib address reuse on POSIX (a plain socket would trip over TIME_WAIT there).
            rebound=server.ThreadingHTTPServer(('127.0.0.1',port),server.Handler)
            try:self.assertEqual(rebound.server_port,port)
            finally:rebound.server_close()
        finally:
            if proc.poll() is None:proc.kill();proc.communicate()

class ShutdownSnapshotTests(unittest.TestCase):
    def test_shutdown_uses_locked_snapshot_and_permanent_closing(self):
        called=[]
        jobs={}
        class Event:
            def __init__(self,name):self.name=name
            def set(self):
                called.append(self.name)
                if self.name=='first':jobs.pop('second',None)
        jobs.update(first={'cancel':Event('first')},second={'cancel':Event('second')})
        class FakeServer:
            def __init__(self,*a,**k):self.closing=False
            def serve_forever(self):raise KeyboardInterrupt
            def server_close(self):called.append(('closed',self.closing))
        with patch.object(server,'JOBS',jobs),patch.object(server,'ThreadingHTTPServer',FakeServer), \
                patch.object(server.editor_service,'config_from',return_value=None), \
                patch.object(sys,'argv',['server.py','--port','54321']),redirect_stdout(io.StringIO()):
            server.main()
        self.assertEqual(called,['first','second',('closed',True)])

if __name__=='__main__':unittest.main()

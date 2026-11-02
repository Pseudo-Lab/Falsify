import base64
import http.client
import json
from pathlib import Path
import struct
import sys
import threading
import unittest
from unittest.mock import patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import layout_agent_service as service
import server

def request():
    return {'schema': service.REQUEST_SCHEMA, 'consent': True, 'projectId': 'a' * 64,
            'step': 0, 'maxSteps': 12, 'instruction': 'Improve layout', 'tools': list(service.TOOLS),
            'observations': [], 'images': [], 'sourceFiles': [{'path': 'main.tex', 'text': 'hello'}]}

def action():
    return {'tool': 'finish', 'path': '', 'before': '', 'after': '', 'pages': [], 'message': 'done'}

def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b''))

class FakeBackend:
    instances = []
    def __init__(self, **kwargs):
        self.kwargs, self.calls, self.argv = kwargs, 0, []
        self.transport = self.run
        self.instances.append(self)
    def run(self, argv, **kwargs):
        self.argv.append(argv)
        image_path = Path(argv[argv.index('--image') + 1])
        assert image_path.read_bytes() == png()
        return {}
    def infer(self, prompt, schema):
        self.calls += 1
        self.prompt = prompt
        if '"pageIndex": 2' in prompt: self.transport(['codex', 'exec'])
        return {'status': 'ok', 'response': action()}

class ServiceTests(unittest.TestCase):
    def test_typed_tool_actions_and_schema(self):
        from jsonschema import Draft202012Validator
        validator = Draft202012Validator(service.CATALOG['actionSchema'])
        valid = {'tool':'update_layout','args':{'blockId':'b1','leadingBp':14},'message':'행간 조정'}
        self.assertTrue(validator.is_valid(valid))
        self.assertEqual(service._action(valid, {'main.tex'}), valid)
        for args in ({'blockId':'b1','run':'shell'}, {'revisionId':'r1'}, {'blockId':'b1','leadingBp':float('inf')}):
            with self.assertRaises(service.LayoutAgentError): service._action({**valid,'args':args}, {'main.tex'})
        class Typed(FakeBackend):
            def infer(self, prompt, schema):
                self.calls += 1
                self.prompt, self.schema = prompt, schema
                return {'status':'ok','response':valid}
        data = {**request(), 'protocol':'v2'}
        result = service.decide(service.validate_request(data), backend_factory=Typed)
        backend = Typed.instances[-1]
        self.assertEqual(result['action'], valid)
        self.assertEqual(backend.schema, service.ACTION_SCHEMA_V2)
        self.assertIn('inspect_document', backend.prompt)
        self.assertIn('selected RED', backend.prompt)
        with self.assertRaises(service.LayoutAgentError):
            service.decide(service.validate_request({**data,'tools':['finish']}), backend_factory=Typed)

    def test_region_image_coordinates_reach_model_context(self):
        data = {**request(),'protocol':'v2','images':[{'document':'original','pageIndex':0,'bbox':[10,20,30,40],'mime':'image/png','base64':base64.b64encode(png()).decode()}]}
        checked = service.validate_request(data)
        self.assertIn('"bbox": [10, 20, 30, 40]', checked['text'])
        for bbox in ([30,20,10,40],[0,0,float('inf'),40],[0,0,20]):
            with self.assertRaises(ValueError): service.validate_request({**data,'images':[{**data['images'][0],'bbox':bbox}]})

    def test_existing_codex_transport_disables_tools_and_sends_image(self):
        calls = []
        def transport(argv, **kwargs):
            calls.append(argv)
            if 'login' in argv: return {'returncode': 0, 'stdout': 'Logged in using ChatGPT'}
            self.assertEqual(Path(argv[argv.index('--image') + 1]).read_bytes(), png())
            events = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(action())}},
                      {'type': 'turn.completed', 'usage': {}}]
            return {'returncode': 0, 'stdout': '\n'.join(map(json.dumps, events))}
        data = request(); data['images'] = [{'pageIndex': 2, 'mime': 'image/png', 'base64': base64.b64encode(png()).decode()}]
        def factory(**kwargs):
            return service.CodexBackend(transport=transport, executable=['codex-test'], skill_folders=[], **kwargs)
        service.decide(service.validate_request(data), backend_factory=factory)
        self.assertEqual(len(calls), 2)  # one local login check, one model decision
        command = calls[1]
        self.assertIn('features.shell_tool=false', command)
        self.assertIn('features.view_image=false', command)
        self.assertIn('--ignore-user-config', command)
        self.assertIn('--image', command)

    def test_single_decision_and_image_transport(self):
        data = request(); data['images'] = [{'pageIndex': 2, 'mime': 'image/png', 'base64': base64.b64encode(png()).decode()}]
        result = service.decide(service.validate_request(data), backend_factory=FakeBackend)
        backend = FakeBackend.instances[-1]
        self.assertEqual(backend.calls, 1)
        self.assertEqual(backend.kwargs['max_calls'], 1)
        self.assertEqual(result['action'], action())
        self.assertEqual(result['step'], 0)
        self.assertEqual(len(result['skillHash']), 64)
        self.assertFalse(Path(backend.argv[0][backend.argv[0].index('--image') + 1]).exists())
        for term in ('read_source', 'replace_source', 'compile_pdf', 'inspect_pdf', 'render_pages', 'finish',
                     'TASK INSTRUCTION', 'DOCUMENT AND TOOL DATA', 'at most four', 'selected RED edits'):
            self.assertIn(term, backend.prompt)
        self.assertIn('Improve layout', backend.prompt)

    def test_request_rejections(self):
        service.validate_request({**request(), 'sourceFiles': [{'path': '논문 폴더/Main.TEX', 'text': 'hello'}]})
        bad = [dict(consent=False), dict(step=12), dict(projectId='x'), dict(sourceFiles=[{'path': '../secret.tex', 'text': ''}]),
               dict(sourceFiles=[{'path': 'C:/secret.tex', 'text': ''}]), dict(images=[{'pageIndex': 0, 'mime': 'image/jpeg', 'base64': ''}]),
               dict(images=[{'pageIndex': 0, 'mime': 'image/png', 'base64': base64.b64encode(png()[:-1]).decode()}])]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError): service.validate_request({**request(), **change})

    def test_invalid_response_and_no_retry(self):
        class Bad(FakeBackend):
            def infer(self, prompt, schema):
                self.calls += 1
                return {'status': 'ok', 'response': {**action(), 'tool': 'read_source', 'path': '../secret.tex'}}
        with self.assertRaises(service.LayoutAgentError) as ctx:
            service.decide(service.validate_request(request()), backend_factory=Bad)
        self.assertEqual(ctx.exception.code, 'invalid_action')
        self.assertEqual(Bad.instances[-1].calls, 1)

    def test_action_schema_and_runtime_limits(self):
        from jsonschema import Draft202012Validator
        validator = Draft202012Validator(service.ACTION_SCHEMA)
        self.assertTrue(validator.is_valid(action()))
        for bad in ({**action(), 'tool': 'shell'}, {**action(), 'pages': [0, 1, 2, 3, 4]},
                    {**action(), 'extra': ''}, {k: v for k, v in action().items() if k != 'message'}):
            self.assertFalse(validator.is_valid(bad))
            with self.assertRaises(service.LayoutAgentError): service._action(bad, {'main.tex'})
        for pages in ([0, 0], [500], [True]):
            with self.assertRaises(service.LayoutAgentError): service._action({**action(), 'pages': pages}, {'main.tex'})
        self.assertEqual(service._action({**action(), 'pages': [0, 1, 2, 3]}, {'main.tex'})['pages'], [0, 1, 2, 3])

    def test_fixed_errors_do_not_expose_provider_diagnostics(self):
        for status, code, expected in [('timeout', 'secret token', 'model_timeout'),
                                      ('error', 'chatgpt_login_required', 'cli_login_required'),
                                      ('error', 'secret token', 'model_failed')]:
            class Bad(FakeBackend):
                def infer(self, prompt, schema): return {'status': status, 'error_code': code, 'diagnostics': 'private'}
            with self.assertRaises(service.LayoutAgentError) as ctx:
                service.decide(service.validate_request(request()), backend_factory=Bad)
            payload = ctx.exception.payload()
            self.assertEqual(payload['error'], expected)
            self.assertTrue(payload['message'])
            self.assertNotIn('secret', json.dumps(payload)); self.assertNotIn('private', json.dumps(payload))

class HttpTests(unittest.TestCase):
    def test_auth_cors_admission_and_response(self):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.web_origin = 'https://example.com'
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        def post(body, token=True):
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            headers = {'Origin': httpd.web_origin, 'Content-Type': 'application/json'}
            if token: headers['Authorization'] = 'Bearer ' + server.TOKEN
            conn.request('POST', server.LAYOUT_AGENT_ROUTE, json.dumps(body), headers)
            response = conn.getresponse(); result = (response.status, dict(response.getheaders()), json.loads(response.read())); conn.close(); return result
        try:
            self.assertEqual(post(request(), False)[0], 403)
            with patch.object(service, 'decide', return_value={'ok': True}) as call:
                status, headers, body = post(request())
                self.assertEqual((status, body), (200, {'ok': True}))
                self.assertEqual(headers['Access-Control-Allow-Origin'], httpd.web_origin)
                self.assertEqual(call.call_count, 1)
                self.assertEqual(post({**request(), 'consent': False})[0], 400)
                self.assertEqual(call.call_count, 1)
                status, _, body = post({**request(), 'instruction': 'x' * 8001})
                self.assertEqual((status, body['error']), (400, 'request_limit'))
                self.assertIn('Reduce', body['message'])
                self.assertEqual(call.call_count, 1)
                server.ACTIVE.acquire()
                try: self.assertEqual(post(request())[0], 409)
                finally: server.ACTIVE.release()
        finally:
            httpd.shutdown(); thread.join(); httpd.server_close()

    def test_http_json_and_schema_regressions(self):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.web_origin = 'https://example.com'
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        def call(raw, *, origin='https://example.com', content_type='application/json', method='POST'):
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            headers = {'Origin': origin, 'Content-Type': content_type, 'Authorization': 'Bearer ' + server.TOKEN}
            if method == 'OPTIONS': headers['Access-Control-Request-Method'] = 'POST'; headers['Access-Control-Request-Headers'] = 'authorization,content-type'
            conn.request(method, server.LAYOUT_AGENT_ROUTE, raw, headers)
            response = conn.getresponse(); status, body = response.status, response.read(); conn.close(); return status, body
        try:
            with patch.object(service, 'decide') as decide:
                self.assertEqual(call(b'', method='OPTIONS')[0], 204)
                self.assertEqual(call(b'{}', origin='https://other.example')[0], 403)
                self.assertEqual(call(b'{}', content_type='text/plain')[0], 400)
                for raw in (b'{', b'{"schema":1,"schema":2}', b'{"n":NaN}', b'[]', json.dumps({**request(), 'extra': 1}).encode()):
                    with self.subTest(raw=raw): self.assertEqual(call(raw)[0], 400)
                conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
                conn.putrequest('POST', server.LAYOUT_AGENT_ROUTE)
                for key, value in {'Origin': httpd.web_origin, 'Content-Type': 'application/json',
                                   'Authorization': 'Bearer ' + server.TOKEN, 'Content-Length': str(6 * 1024 * 1024 + 1)}.items():
                    conn.putheader(key, value)
                conn.endheaders(); response = conn.getresponse(); payload = json.loads(response.read()); conn.close()
                self.assertEqual((response.status, payload['error']), (400, 'request_limit'))
                self.assertEqual(decide.call_count, 0)
            for code in ('model_timeout', 'cli_login_required'):
                with patch.object(service, 'decide', side_effect=service.LayoutAgentError(code)):
                    status, raw = call(json.dumps(request()).encode())
                    payload = json.loads(raw)
                    self.assertEqual(status, 502); self.assertEqual(payload['error'], code); self.assertTrue(payload['message'])
            decide = service.decide
            with patch.object(service, 'decide', side_effect=lambda validated: decide(validated, backend_factory=FakeBackend)):
                status, raw = call(json.dumps(request()).encode())
                response = json.loads(raw)
                self.assertEqual(status, 200)
                self.assertEqual(set(response), {'schema', 'projectId', 'step', 'action', 'model', 'skillHash'})
                self.assertEqual(response['schema'], service.RESPONSE_SCHEMA)
                self.assertEqual((response['projectId'], response['step'], response['action']), ('a' * 64, 0, action()))
        finally:
            httpd.shutdown(); thread.join(); httpd.server_close()

class LayoutAgentLargeProjectTests(unittest.TestCase):
    def test_original_and_candidate_can_share_page_number_without_losing_labels(self):
        data = request()
        data['reference'] = {'schema':'falsify.paper-layout-reference.v1','sourcePdfHash':'b'*64,'sourcePages':7}
        data['images'] = [{'pageIndex':0,'document':kind,'mime':'image/png','base64':base64.b64encode(png()).decode()} for kind in ('original','candidate')]
        checked = service.validate_request(data)
        self.assertEqual([x['document'] for x in json.loads(checked['text'])['images']], ['original','candidate'])
        self.assertEqual(len(checked['images']),2)
        data['images'].append(dict(data['images'][0]))
        with self.assertRaises(ValueError): service.validate_request(data)

    def test_reference_hash_must_match_structure_and_structural_tool_is_explicit(self):
        data = request()
        data['reference'] = {'sourcePdfHash':'b'*64}
        data['structure'] = {'sourcePdfHash':'c'*64}
        with self.assertRaises(ValueError): service.validate_request(data)
        data['structure']['sourcePdfHash']='b'*64
        checked=service.validate_request(data)
        proposed=action();proposed['tool']='restructure_source';proposed['after']=json.dumps({'schema':'falsify.paper-layout-plan.v1'})
        self.assertEqual(service._action(proposed,checked['paths'])['tool'],'restructure_source')

    def test_persistent_execution_status_is_visible_to_model(self):
        data=request();data['execution']={'canFinish':True,'compiledCurrent':True,'completedActions':[{'tool':'compile_pdf','status':'ok'}]}
        checked=service.validate_request(data)
        self.assertTrue(json.loads(checked['text'])['execution']['canFinish'])

    def test_source_index_accepts_more_than_64_bounded_files(self):
        data = request()
        data['sourceFiles'] = [{'path': f'part-{i}.tex', 'text': 'Evidence 12.'} for i in range(100)]
        checked = service.validate_request(data)
        self.assertEqual(len(checked['paths']), 100)


class ReferenceCursorContractTests(unittest.TestCase):
    def test_reference_continuation_cursors_are_accepted_by_service(self):
        action = {'tool': 'read_reference', 'args': {'pages': [0], 'textOffset': 1000, 'unitOffset': 4}, 'message': ''}
        self.assertEqual(service._action(action, {'main.tex'}), action)
        action['args']['unitOffset'] = -1
        with self.assertRaises(service.LayoutAgentError) as error:
            service._action(action, {'main.tex'})
        self.assertEqual(error.exception.code, 'invalid_action')

if __name__ == '__main__': unittest.main()

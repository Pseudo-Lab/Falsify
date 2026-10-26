"""Timeout propagation and budget checks; no network/model calls."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
import io
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runner
import build_profile
import harness_adapter

SCHEMA = {'type':'object','additionalProperties':False,'required':['status','targets'],
          'properties':{'status':{'type':'string','enum':['ok','abstain','refusal']},
                        'targets':{'type':'array','items':{'type':'object','properties':{
                            'referenceId':{'type':'string'},'reason':{'type':'string'}},
                            'required':['referenceId','reason'],'additionalProperties':False}}}}


class TimeoutHotfixTests(unittest.TestCase):
    def payload(self, settings=None):
        return json.dumps({'schema':'falsify.harness-invocation.v1','role':'blue','call':1,'maxCalls':7,
            'settings':settings if settings is not None else runner.contract_settings(),
            'prompt':runner.MARKER+'. '+json.dumps({'segments':[{'id':'s0','text':'Alpha'}]}),
            'outputSchema':SCHEMA}).encode()

    def test_stage_budget_keeps_outer_deadline(self):
        self.assertEqual(runner.model_timeout('document-stage',150,0),120)
        self.assertEqual(runner.model_timeout('expert',150,0),70)
        self.assertEqual(runner.model_timeout('document-stage',40,115),30)
        self.assertEqual(runner.model_timeout('document-stage',1,149),0)

    def test_document_stage_can_complete_after_previous_70s_cap(self):
        calls=[]
        def fake(stage,prompt,schema,seconds):
            calls.append((stage,seconds))
            self.assertGreater(seconds,119)
            # Model duration is synthetic; no sleep or paid execution.
            return {'status':'ok','response':{'status':'abstain','targets':[]},'elapsed_seconds':90}
        with tempfile.TemporaryDirectory() as folder:
            answer=runner.execute(self.payload(),fake,audit_dir=folder)
            audit=json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf8'))
        self.assertEqual(answer,{'status':'abstain','targets':[]})
        self.assertEqual(len(calls),1)
        self.assertEqual(audit['diagnosticVersion'],'0.3.5')
        self.assertEqual(audit['state'],'completed')

    def test_timeout_is_failure_and_never_retried(self):
        calls=[]
        def fake(*args):
            calls.append(args[0])
            return {'status':'timeout','error_code':'timeout','response':None}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(runner.AuditFailure) as caught:
                runner.execute(self.payload(),fake,audit_dir=folder)
            audit=json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf8'))
        self.assertEqual(caught.exception.code,'model_timeout')
        self.assertEqual(audit['errorCode'],'model_timeout')
        self.assertEqual(calls,['document-stage'])
        self.assertNotIn('result',audit)

    def test_unrelated_failure_is_not_mislabeled_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(runner.AuditFailure) as caught:
                runner.execute(self.payload(),lambda *a:{'status':'error','error_code':'refusal','response':None},audit_dir=folder)
        self.assertEqual(caught.exception.code,'model_stage_failed')

    def test_reserved_exit_timeout_does_not_expose_output(self):
        for code,expected in [(124,'adapter 응답 시간 초과'),(1,'adapter 종료 오류')]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError) as caught:
                    harness_adapter.run_stdio([sys.executable,'-c',f'import sys;print("SECRET-OUTPUT");sys.stderr.write("SECRET-ERROR");sys.exit({code})'],b'',folder,str(Path(folder)/'stdout'))
                self.assertIn(expected,str(caught.exception))
                self.assertNotIn('SECRET',str(caught.exception))

    def test_main_exits_124_only_for_timeout_and_prints_nothing(self):
        for code,expected in [('model_timeout',124),('model_stage_failed',1)]:
            with self.subTest(code=code), patch.object(runner.sys,'platform','linux'), \
                    patch.object(runner.sys,'stdin',io.TextIOWrapper(io.BytesIO(b'{}'))), \
                    patch.object(runner.sys,'stdout',io.StringIO()) as output, \
                    patch.object(runner,'execute',side_effect=runner.AuditFailure(code,{})):
                with self.assertRaises(SystemExit) as caught:
                    runner.main()
                self.assertEqual(caught.exception.code,expected)
                self.assertEqual(output.getvalue(),'')

    def test_profile_binds_new_version_and_exact_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=build_profile.build(Path(folder)/'profile.json')
        self.assertEqual(profile['version'],'0.3.5')
        self.assertEqual(profile['settings']['documentTimeoutSeconds'],120)
        self.assertEqual(profile['settings']['totalTimeoutSeconds'],150)
        runner.check_settings(profile['settings'])
        stale=dict(profile['settings'],documentTimeoutSeconds=70)
        with self.assertRaisesRegex(ValueError,'settings_contract'):
            runner.check_settings(stale)


if __name__=='__main__':
    unittest.main()

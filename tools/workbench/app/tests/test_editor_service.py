"""Configured PDF editor adapter tests. Injected subprocess runner and synthetic bytes, with the independent QA
explicitly injected (FakeQuality); IndependentQATests also runs the production MuPDF QA on real in-memory PDFs.
Never runs Node and never touches a server on 7816/7817."""
import base64
import hashlib
import http.client
import io
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import editor_service as es
import paper_inventory
import pdf_quality
import server

SOURCE=b'%PDF-1.7 synthetic bytes only'
OUTPUT=b'%PDF-1.7 synthetic edited bytes'
WASM='12e43c4c2e7deedab629c3b08b14fc0b24c1336f92b7de30ac58d7ec6dcbb833'
STYLE={'supported':True,'policy':'source-number-suffix','scope':'text-only source-style header/footer; standalone Arabic source number plus decimal suffix; originals unchanged'}
def qa_report(status='warning',code='page_map',pages=()):
    checks=[{'code':'output_readable','status':'passed','pages':[]},{'code':code,'status':status,'pages':list(pages)}]
    return {'schema':'falsify.pdf-quality.v1','status':status,'method':'mupdf 1.28.2 text/geometry/raster','checks':checks,'limitations':[pdf_quality.LIMITATIONS['scope']]}

class FakeQuality:
    """Explicit QA stub for synthetic pseudo-PDF bytes; records what the service hands the checker."""
    def __init__(self,result=None):self.result=result if result is not None else qa_report();self.calls=[]
    def __call__(self,source,out,edits,page_map,page_count):
        self.calls.append({'source':Path(source).read_bytes(),'out':Path(out).read_bytes(),'edits':edits,'page_map':page_map,'page_count':page_count})
        if isinstance(self.result,Exception):raise self.result
        return self.result

def payload(**over):
    d={'format':'PDF','fileHash':hashlib.sha256(SOURCE).hexdigest(),'file':base64.b64encode(SOURCE).decode(),
       'patches':[{'id':'c1','segmentId':'s1','label':'PDF p. 3','before':'the result holds','after':'the result may hold','offset':4,'edited':False}]}
    d.update(over);return d

class FakeRunner:
    """Simulates node --version, the bridge --capabilities probe and an edit run."""
    def __init__(self,version=b'v24.19.0\n',caps=None,edit='ok'):
        self.version,self.caps,self.edit=version,caps,edit;self.calls=[];self.requests=[]
    def __call__(self,argv,*,cwd,env,timeout):
        self.calls.append({'argv':list(argv),'cwd':cwd,'env':dict(env),'timeout':timeout})
        if argv[1:]==['--version']:return SimpleNamespace(returncode=0,stdout=self.version)
        if argv[2:]==['--capabilities']:
            caps=self.caps if self.caps is not None else {'ok':True,'engine':'falsify-pdf-editor','version':'0.1.0-alpha.2','wasmSha256':WASM,
                'runtime':{'jsSha256':'a'*64,'manifestSha256':'b'*64,'runtimeKind':'candidate','build':'x'},'reflow':True,'pagination':False,
                'sourceUrl':'https://github.com/Shinick-Han/falsify-pdf-editor'}
            if isinstance(caps,Exception):raise caps
            return SimpleNamespace(returncode=0 if caps.get('ok') else 1,stdout=(json.dumps(caps)+'\n').encode())
        args=dict(zip(argv[2::2],argv[3::2]))
        self.requests.append(json.loads(Path(args['--request']).read_text(encoding='utf-8')))
        self.tempdir=Path(args['--request']).parent
        if callable(self.edit):return self.edit(args)
        if self.edit=='timeout':raise subprocess.TimeoutExpired(argv,timeout)
        req=self.requests[-1]
        edits=[{'id':e['id'],'pageIndex':e['pageIndex'],'status':'applied'} for e in req['edits']]
        report={'ok':True,'status':'self-check-passed','reflow':True,'wrappedLines':None,'layoutVerified':True,'runtime':{'wasmSha256':WASM,'jsSha256':'a'*64,'manifestSha256':'b'*64,'runtimeKind':'candidate'},
            'edits':edits,'repairs':[{'pageIndex':2,'count':1}],'warnings':[],'selfCheck':{'status':'passed','independent':False,'method':'same-pdfium-text-geometry','failures':[],'warnings':[{'code':'self_check_not_independent','pageIndex':None}]},
            'pageCount':{'source':5,'output':5},'sourcePageMap':None,'outputSha256':hashlib.sha256(OUTPUT).hexdigest()}
        if isinstance(self.edit,dict):report.update(self.edit)
        if self.edit=='fail':
            Path(args['--report']).write_text(json.dumps({'ok':False,'error':{'code':'MATCH_FAILED','message':'x'}}));return SimpleNamespace(returncode=1,stdout=b'{"ok":false,"code":"MATCH_FAILED"}\n')
        if self.edit=='wrong-wasm':report['runtime']['wasmSha256']='c'*64
        if self.edit=='not-applied':report['edits'][0]['status']='noop'
        Path(args['--out']).write_bytes(OUTPUT if self.edit!='oversize' else b'%PDF-'+b'0'*64)
        Path(args['--report']).write_text(json.dumps(report))
        return SimpleNamespace(returncode=0,stdout=b'{"ok":true,"code":"OK"}\n' if self.edit!='stdout-oversize' else b'x'*(es.LIMITS['maxStdoutBytes']+1))

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();base=Path(self.tmp.name)
        (base/'module'/'src').mkdir(parents=True);(base/'module'/'src'/'web-bridge.mjs').write_text('// stub')
        (base/'cand').mkdir();(base/'cand'/'candidate-manifest.json').write_text('{}')
        (base/'node.exe').write_bytes(b'');self.base=base
        self.config=es.config_from(str(base/'module'),str(base/'cand'/'candidate-manifest.json'),node=str(base/'node.exe'),environ={})
    def tearDown(self):self.tmp.cleanup()
    def service(self,quality=None,**kw):
        self.runner=FakeRunner(**kw);self.quality=quality or FakeQuality()
        return es.PdfEditorService(self.config,runner=self.runner,quality=self.quality)

class ConfigTests(unittest.TestCase):
    def test_unconfigured_is_legacy(self):self.assertIsNone(es.config_from(environ={}))
    def test_partial_or_relative_rejected(self):
        for kw in [{'root':'C:/x' if sys.platform=='win32' else '/x'},{'manifest':str(Path(tempfile.gettempdir())/'candidate-manifest.json')},
                {'root':'rel','manifest':'rel/candidate-manifest.json'},{'source_root':str(Path(tempfile.gettempdir()))}]:
            with self.subTest(kw=kw):
                with self.assertRaises(ValueError):es.config_from(environ={},**kw)
    def test_manifest_name_and_env_equivalents(self):
        t=Path(tempfile.gettempdir())
        with self.assertRaises(ValueError):es.config_from(str(t),str(t/'other.json'),environ={})
        c=es.config_from(environ={es.ENV_ROOT:str(t),es.ENV_MANIFEST:str(t/'candidate-manifest.json'),es.ENV_SOURCE_ROOT:str(t)})
        self.assertEqual(c.manifest.name,'candidate-manifest.json');self.assertIsNotNone(c.source_root)
    def test_unconfigured_capability_shape(self):
        c=es.unconfigured_capability()
        self.assertEqual((c['available'],c['configured'],c['engine'],c['reflow'],c['pagination']),(False,False,'falsify-pdf-editor',False,False))

class CapabilityTests(Base):
    def test_probe_success_is_truthful_and_path_free(self):
        svc=self.service();cap=svc.capability()
        self.assertTrue(cap['available']);self.assertEqual(cap['wasmSha256'],WASM);self.assertIs(cap['reflow'],True);self.assertIs(cap['pagination'],False)
        self.assertEqual(set(cap)>={'available','engine','version','wasmSha256','reflow','pagination','limits','sourceUrl'},True)
        self.assertNotIn(self.tmp.name.lower(),json.dumps(cap).lower())
        probe=self.runner.calls[-1];self.assertEqual(probe['argv'][1:],[str(self.config.root/'src'/'web-bridge.mjs'),'--capabilities'])
        self.assertEqual(probe['env']['FALSIFY_EDITOR_CANDIDATE_MANIFEST'],str(self.config.manifest));self.assertNotIn('NODE_OPTIONS',probe['env'])
        svc.capability();self.assertEqual(len(self.runner.calls),2,'success cached')
    def test_pagination_descriptor_must_be_bool_true(self):
        caps={'ok':True,'engine':'falsify-pdf-editor','version':'1','wasmSha256':WASM,'reflow':True,'pagination':{'supported':True}}
        self.assertIs(self.service(caps=caps).capability()['pagination'],False)
    def test_continuation_style_declared_exact_and_path_free(self):
        base={'ok':True,'engine':'falsify-pdf-editor','version':'1','wasmSha256':WASM,'reflow':True,'pagination':True}
        self.assertIsNone(self.service(caps=base).capability()['continuationStyle'],'pagination true alone is not a style capability')
        self.assertIsNone(self.service().capability()['continuationStyle'],'older engine without the field')
        cap=self.service(caps={**base,'continuationStyle':{**STYLE,'scope':str(self.base/'paper.pdf')+' header text','extra':1}}).capability()
        self.assertEqual(cap['continuationStyle'],{'supported':True,'policy':'source-number-suffix','scope':es.CONTINUATION_SCOPE})
        self.assertNotIn(self.tmp.name.lower(),json.dumps(cap).lower());self.assertNotIn('header text',json.dumps(cap))
        for bad in [None,True,'source-number-suffix',[STYLE],{**STYLE,'supported':'true'},{**STYLE,'supported':1},{**STYLE,'policy':'renumber-all'},{'supported':True}]:
            with self.subTest(bad=bad):
                cap=self.service(caps={**base,'continuationStyle':bad}).capability();self.assertTrue(cap['available']);self.assertIsNone(cap['continuationStyle'])
        self.assertIsNone(self.service(caps={**base,'pagination':False,'continuationStyle':STYLE}).capability()['continuationStyle'],'no style without pagination')
        self.assertIsNone(es.unconfigured_capability()['continuationStyle'])
    def test_unavailable_reasons(self):
        self.assertEqual(self.service(version=b'v22.1.0\n').capability()['error']['code'],'node_too_old')
        self.assertEqual(self.service(caps={'ok':False,'code':'CANDIDATE_HASH_MISMATCH'}).capability()['error']['code'],'probe_failed')
        self.assertEqual(self.service(caps=subprocess.TimeoutExpired('n',1)).capability()['error']['code'],'probe_timeout')
        self.assertEqual(self.service(caps=OSError()).capability()['error']['code'],'node_missing')
        (self.base/'node.exe').unlink();self.assertEqual(self.service().capability()['error']['code'],'node_missing')
        (self.base/'cand'/'candidate-manifest.json').unlink();self.assertEqual(self.service().capability()['error']['code'],'manifest_missing')
        (self.base/'module'/'src'/'web-bridge.mjs').unlink();cap=self.service().capability()
        self.assertEqual(cap['error']['code'],'module_missing');self.assertFalse(cap['available']);self.assertTrue(cap['configured'])
        self.assertNotIn(self.tmp.name.lower(),json.dumps(cap).lower())
    def test_failed_probe_retries_after_interval(self):
        now=[0.0];runner=FakeRunner(version=b'v20.0.0\n');svc=es.PdfEditorService(self.config,runner=runner,clock=lambda:now[0])
        svc.capability();svc.capability();self.assertEqual(len(runner.calls),1)
        runner.version=b'v24.19.0\n';now[0]=100;self.assertTrue(svc.capability()['available'])

class ExportTests(Base):
    def test_success_fixed_argv_exact_spans_and_cleanup(self):
        svc=self.service();data=payload();before=json.dumps(data)
        result=svc.export(data)
        self.assertEqual(json.dumps(data),before,'request untouched')
        self.assertEqual(base64.b64decode(result['file']),OUTPUT);self.assertEqual(result['sourceFileHash'],data['fileHash'])
        self.assertEqual(result['outputFileHash'],hashlib.sha256(OUTPUT).hexdigest())
        v=result['verification'];self.assertEqual((v['engine'],v['runtime']['wasmSha256'],v['pages'],v['independentQA']),('falsify-pdf-editor',WASM,5,'warning'))
        self.assertEqual(v['independentChecks'],qa_report())
        self.assertIs(v['layoutVerified'],True);self.assertEqual(v['reflow'],{'wrappedLines':None});self.assertEqual(v['pagination'],{'inputPages':5,'outputPages':5})
        self.assertIsNone(v['sourcePageMap']);self.assertEqual(v['capabilities'],{'reflow':True,'pagination':False});self.assertEqual(v['diagnostics'],[])
        self.assertEqual(v['edits'],[{'label':'PDF p. 3','id':'edit-1','pageIndex':2,'status':'applied'}])
        call=self.runner.calls[-1];d=self.runner.tempdir
        self.assertEqual(call['argv'],[str(self.base/'node.exe'),str(self.config.root/'src'/'web-bridge.mjs'),'--request',str(d/'request.json'),'--out',str(d/'output.pdf'),'--report',str(d/'report.json')])
        self.assertEqual(call['timeout'],es.LIMITS['timeoutSeconds'])
        self.assertEqual(self.runner.requests[-1],{'schema':es.REQUEST_SCHEMA,'input':'source.pdf','inputSha256':data['fileHash'],'reflow':True,
            'edits':[{'id':'edit-1','pageIndex':2,'before':'the result holds','after':'the result may hold'}]})
        self.assertFalse(d.exists(),'own temp dir removed');self.assertEqual(svc.leftovers,[])
    def test_malformed_requests_never_invoke_editor(self):
        p=payload()['patches'][0]
        bad=[payload(file='***'),payload(fileHash='0'*64),payload(fileHash='X'),payload(format='DOCX'),payload(extra=1),payload(file=base64.b64encode(b'not pdf').decode(),fileHash=hashlib.sha256(b'not pdf').hexdigest()),
            payload(patches=[]),payload(patches=[p]*13),payload(patches=[{**p,'rationale':'gold'}]),payload(patches=[{**p,'offset':-1}]),
            payload(patches=[{**p,'after':'the result holds 2'}]),payload(patches=[{**p,'after':p['before']}])]
        bad+=[payload(patches=[{**p,'label':l}]) for l in ['PDF p. 0','PDF p. 03','PDF p.3','p. 3','PDF p. 3 ','PDF p. -1','PDF p. 3a','DOCX p. 3']]
        svc=self.service()
        for d in bad:
            with self.subTest(d={k:v for k,v in d.items() if k!='file'}):
                with self.assertRaises(ValueError):svc.export(d)
        self.assertEqual(self.runner.calls,[])
    def test_failures_raise_without_fallback(self):
        for mode in ['fail','timeout','wrong-wasm','not-applied','stdout-oversize']:
            with self.subTest(mode=mode):
                svc=self.service(edit=mode)
                with patch.object(server,'handle_export',side_effect=AssertionError('legacy fallback')):
                    with self.assertRaises(ValueError) as ctx:svc.export(payload())
                self.assertIn('대신 내보내지 않습니다',str(ctx.exception));self.assertFalse(self.runner.tempdir.exists())
        svc=self.service(edit='fail')
        with self.assertRaisesRegex(ValueError,'MATCH_FAILED'):svc.export(payload())
    def test_layout_facts_follow_report(self):
        spm=[{'sourcePageIndex':0,'outputPageIndex':0,'continuationPageIndices':[]},{'sourcePageIndex':1,'outputPageIndex':1,'continuationPageIndices':[2],'extra':'x'}]
        v=self.service(edit={'wrappedLines':3,'pageCount':{'source':5,'output':6},'addedPages':1,'sourcePageMap':spm}).export(payload())['verification']
        self.assertEqual((v['reflow'],v['pagination'],v['addedPages'],v['layoutVerified']),({'wrappedLines':3},{'inputPages':5,'outputPages':6},1,True))
        self.assertEqual(v['sourcePageMap'],[spm[0],{'sourcePageIndex':1,'outputPageIndex':1,'continuationPageIndices':[2]}])
        for over in [{'layoutVerified':False},{'warnings':[{'code':'repair_x','severity':'error','pageIndex':0}]},{'layoutVerified':None},{'selfCheck':{'status':'passed','failures':[{'code':'x'}]}}]:
            with self.subTest(over=over):
                v=self.service(edit=over).export(payload())['verification'];self.assertIs(v['layoutVerified'],False)
        v=self.service(edit={'warnings':[{'code':'edge_edit_unverified','severity':'warning','pageIndex':1}],'sourcePageMap':['C:/x'],'wrappedLines':-2}).export(payload())['verification']
        self.assertEqual((v['diagnostics'],v['sourcePageMap'],v['reflow']['wrappedLines'],v['layoutVerified']),(['edge_edit_unverified (p. 2)'],None,None,True))
    def test_continuation_style_only_when_declared_and_reported(self):
        styled={'ok':True,'engine':'falsify-pdf-editor','version':'1','wasmSha256':WASM,'reflow':True,'pagination':True,'continuationStyle':STYLE}
        grown={'pageCount':{'source':5,'output':7},'addedPages':2}
        report=lambda style,**kw:{**grown,**kw,'continuationStyle':style}
        v=self.service(caps=styled,edit=report({'policy':'source-number-suffix','applied':True,'copiedPages':2,'text':'Running head','path':'C:/x'})).export(payload())['verification']
        self.assertEqual(v['continuationStyle'],{'policy':'source-number-suffix','applied':True,'copiedPages':2})
        ok={'policy':'source-number-suffix','applied':True,'copiedPages':2}
        for bad in [None,'yes',[],{**ok,'applied':'true'},{**ok,'copiedPages':3},{**ok,'copiedPages':1},{**ok,'copiedPages':0},{**ok,'copiedPages':-1},{**ok,'copiedPages':True},
                {**ok,'copiedPages':2.0},{'policy':'source-number-suffix','applied':True},{**ok,'policy':'other'}]:
            with self.subTest(bad=bad):
                v=self.service(caps=styled,edit=report(bad)).export(payload())['verification'];self.assertIsNone(v['continuationStyle']);self.assertIs(v['layoutVerified'],True)
        for over in [{'addedPages':None},{'addedPages':1},{'pageCount':{'source':5,'output':6}},{'pageCount':{'source':5}},{'pageCount':None},{'layoutVerified':False},
                {'warnings':[{'code':'x','severity':'error','pageIndex':0}]}]:
            with self.subTest(over=over):
                self.assertIsNone(self.service(caps=styled,edit=report(ok,**over)).export(payload())['verification']['continuationStyle'],'unknown/mismatched counts or unverified layout: no claim')
        big={'policy':'source-number-suffix','applied':True,'copiedPages':33}
        self.assertIsNone(self.service(caps=styled,edit=report(big,pageCount={'source':1,'output':34},addedPages=33)).export(payload())['verification']['continuationStyle'],'over 32')
        edge={'policy':'source-number-suffix','applied':True,'copiedPages':32}
        self.assertEqual(self.service(caps=styled,edit=report(edge,pageCount={'source':1,'output':33},addedPages=32)).export(payload())['verification']['continuationStyle']['copiedPages'],32)
        self.assertIsNone(self.service(edit=report(ok)).export(payload())['verification']['continuationStyle'],'undeclared capability ignores the report')
        self.assertIsNone(self.service().export(payload())['verification']['continuationStyle'],'older report without the field')
    def test_output_oversize(self):
        svc=self.service(edit='oversize')
        with patch.dict(es.LIMITS,{'maxOutputBytes':16}):
            with self.assertRaisesRegex(ValueError,'출력 크기'):svc.export(payload())
    def test_source_modified_by_editor_rejected(self):
        def tamper(args):(Path(args['--request']).parent/'source.pdf').write_bytes(b'%PDF-changed');return SimpleNamespace(returncode=0,stdout=b'{"ok":true}\n')
        with self.assertRaisesRegex(ValueError,'입력 파일'):self.service(edit=tamper).export(payload())
    def test_unavailable_editor_refuses_export(self):
        svc=self.service(version=b'v20.0.0\n')
        with self.assertRaisesRegex(ValueError,'node_too_old'):svc.export(payload())
        self.assertEqual([c for c in self.runner.calls if '--request' in c['argv']],[])

def refusing(report,code='SELF_CHECK_FAILED',write_out=False):
    """Editor run that exits 1 after writing the given (bridge-sanitized or hostile) report, optionally with an output."""
    def run(args):
        if report is not None:Path(args['--report']).write_text(json.dumps(report))
        if write_out:Path(args['--out']).write_bytes(OUTPUT)
        return SimpleNamespace(returncode=1,stdout=json.dumps({'ok':False,'code':code}).encode()+b'\n')
    return run

class RefusalDiagnosticsTests(Base):
    """A refused export names known self-check failure / error repair warning codes with fixed labels; nothing else."""
    SECRET='C:/Users/secret/source.pdf sk-live-123 the result may hold <script>'
    def refuse(self,report,code='SELF_CHECK_FAILED',write_out=False):
        svc=self.service(edit=refusing(report,code,write_out))
        with patch.object(server,'handle_export',side_effect=AssertionError('legacy fallback')):
            with self.assertRaises(ValueError) as ctx:svc.export(payload())
        self.assertFalse(self.runner.tempdir.exists(),'own temp dir removed');self.assertEqual(svc.leftovers,[])
        self.assertEqual(self.quality.calls,[],'refused output never reaches QA or the caller')
        return str(ctx.exception)
    def head(self,code):return f'PDF 편집기가 변경을 적용하지 못했습니다 ({code}).'
    def test_self_check_failures_named_with_pages_and_dedup(self):
        sc={'status':'failed','failures':[{'code':'edited_page_text_or_order_mismatch','pageIndex':2},{'code':'header_footer_moved','pageIndex':2},
            {'code':'edited_page_text_or_order_mismatch','pageIndex':2},{'code':'edge_band_body_changed','pageIndex':4},{'code':'header_footer_moved','pageIndex':3}]}
        msg=self.refuse({'ok':False,'error':{'code':'SELF_CHECK_FAILED','message':self.SECRET},'selfCheck':sc})
        self.assertEqual(msg,self.head('SELF_CHECK_FAILED')+' 진단: 편집한 페이지의 텍스트/순서가 기대와 다름[edited_page_text_or_order_mismatch] (p. 3); '
            '머리글/바닥글이 움직임[header_footer_moved] (p. 3, 4); 머리글/바닥글 가장자리 영역의 본문이 바뀜[edge_band_body_changed] (p. 5). '+es.NO_FALLBACK)
        self.assertEqual(re.search(r'\(([A-Z][A-Z0-9_]{2,63})\)',msg)[1],'SELF_CHECK_FAILED','QA classifiers still read the top code first')
    def test_pagination_error_warning_only_error_severity(self):
        warnings=[{'pageIndex':2,'code':'pagination_required','severity':'info'},{'pageIndex':2,'code':'reading_order_not_exact','severity':'warning'},
            {'pageIndex':2,'code':'pagination_unsupported_foreign_object_in_flow','severity':'error'}]
        msg=self.refuse({'ok':False,'error':{'code':'LAYOUT_UNSUPPORTED'},'warnings':warnings,'selfCheck':{'status':'not-run','failures':[]}},code='LAYOUT_UNSUPPORTED')
        self.assertEqual(msg,self.head('LAYOUT_UNSUPPORTED')+' 진단: 넘치는 본문 흐름에 텍스트가 아닌 개체가 있어 페이지 넘김 미지원'
            '[pagination_unsupported_foreign_object_in_flow] (p. 3). '+es.NO_FALLBACK)
    def test_unknown_malformed_and_unsafe_fields_never_leak(self):
        s=self.SECRET
        failures=[{'code':s,'pageIndex':1},{'code':'Header_Footer_Moved'},{'code':['header_footer_moved']},{'code':{'x':1}},'header_footer_moved',None,7,
            {'code':'header_footer_moved '},{'code':'unknown_future_code','pageIndex':0},{'code':'after_missing','pageIndex':True,'message':s,'before':s,'after':s},
            {'code':'after_missing','pageIndex':-1},{'code':'after_missing','pageIndex':10**9},{'code':'after_missing','pageIndex':'3'},{'code':'after_missing','pageIndex':1.0}]
        report={'ok':False,'error':{'code':'SELF_CHECK_FAILED','message':s},'selfCheck':{'status':'failed','failures':failures,'method':s},
            'warnings':[{'code':'resize_failed','severity':'ERROR'},{'code':s,'severity':'error'},'x'],'runtime':{'wasmSha256':WASM,'candidate':{'manifestPath':s}},'engineLog':[s]*50}
        msg=self.refuse(report)
        self.assertEqual(msg,self.head('SELF_CHECK_FAILED')+' 진단: After 문구가 출력에서 확인되지 않음[after_missing]. '+es.NO_FALLBACK)
        for leak in ['secret','sk-live','script','C:/','unknown_future_code','Header_Footer','result may hold',WASM]:self.assertNotIn(leak,msg)
    def test_counts_bounded(self):
        codes=list(es.REFUSAL_REASONS)[:10]
        failures=[{'code':c,'pageIndex':p} for c in codes for p in range(8)]
        msg=self.refuse({'ok':False,'selfCheck':{'status':'failed','failures':failures}})
        self.assertEqual([c for c in codes if f'[{c}]' in msg],codes[:es.MAX_REASONS])
        self.assertIn(f'[{codes[0]}] (p. 1, 2, 3);',msg);self.assertLess(len(msg),1200)
        late=[{'code':'after_missing'}]*es.MAX_REASON_SCAN+[{'code':'header_footer_moved'}]
        self.assertNotIn('header_footer_moved',self.refuse({'ok':False,'selfCheck':{'status':'failed','failures':late}}),'scan bounded')
    def test_missing_or_shapeless_report_keeps_generic_failure(self):
        generic=self.head('SELF_CHECK_FAILED')+' '+es.NO_FALLBACK
        for report in [None,{'ok':False},{'ok':False,'selfCheck':'failed'},{'ok':False,'selfCheck':{'failures':{'code':'after_missing'}}},
                {'ok':False,'warnings':{'code':'resize_failed','severity':'error'}},[{'code':'after_missing'}],{'ok':False,'selfCheck':{'failures':[{'code':'unknown'}]}}]:
            with self.subTest(report=report):self.assertEqual(self.refuse(report),generic)
        self.assertEqual(self.refuse(None,code='lower bad'),self.head('EDITOR_FAILED')+' '+es.NO_FALLBACK)
    def test_output_written_by_failed_editor_is_not_returned(self):
        msg=self.refuse({'ok':False,'selfCheck':{'status':'failed','failures':[{'code':'glyphs_off_page','pageIndex':0}]}},write_out=True)
        self.assertIn('[glyphs_off_page] (p. 1)',msg)
    def test_success_path_unchanged(self):
        result=self.service(edit={'warnings':[{'code':'header_footer_moved','severity':'warning','pageIndex':1}]}).export(payload())
        self.assertEqual(base64.b64decode(result['file']),OUTPUT);self.assertEqual(result['verification']['diagnostics'],['header_footer_moved (p. 2)'])

class IndependentQATests(Base):
    def test_production_qa_is_default_regardless_of_runner(self):
        self.assertIs(es.PdfEditorService(self.config,runner=FakeRunner()).quality,pdf_quality.inspect_isolated)
    def test_qa_gets_exact_edits_actual_files_map_and_counts(self):
        spm=[{'sourcePageIndex':i,'outputPageIndex':i,'continuationPageIndices':[]} for i in range(5)]
        svc=self.service(edit={'sourcePageMap':spm});svc.export(payload())
        call=self.quality.calls[0]
        self.assertEqual((call['source'],call['out']),(SOURCE,OUTPUT))
        self.assertEqual(call['edits'],[{'pageIndex':2,'before':'the result holds','after':'the result may hold'}])
        self.assertEqual((call['page_map'],call['page_count']),(spm,{'source':5,'output':5}))
    def test_warning_and_unavailable_keep_download(self):
        for result,expected in [(qa_report('warning','edited_text_order',[3]),'warning'),(pdf_quality.unavailable(),'unavailable'),(RuntimeError('boom'),'unavailable'),
                ({'schema':'falsify.pdf-quality.v1','status':'passed','method':'C:/secret/paper.pdf','checks':[],'limitations':['the result holds']},'unavailable'),
                (qa_report('passed','page_map'),'passed')]:
            with self.subTest(expected=expected):
                r=self.service(quality=FakeQuality(result)).export(payload())
                self.assertEqual(base64.b64decode(r['file']),OUTPUT);self.assertEqual(r['verification']['independentQA'],expected)
                self.assertEqual(r['verification']['independentChecks']['status'],expected)
                blob=json.dumps(r['verification']);self.assertNotIn('secret',blob);self.assertNotIn('the result holds',blob)
    def test_failed_rejects_with_fixed_actionable_error(self):
        svc=self.service(quality=FakeQuality(qa_report('failed','unedited_render',[4])))
        with self.assertRaises(ValueError) as ctx:svc.export(payload())
        msg=str(ctx.exception)
        for part in ['unedited_render (출력 p. 4)','안전한 자동 복구 방법이 없어','대신 내보내지 않습니다']:self.assertIn(part,msg)
        self.assertNotIn('the result',msg);self.assertNotIn(self.tmp.name.lower(),msg.lower());self.assertFalse(self.runner.tempdir.exists())
    def real_pdf(self,pages):
        import pymupdf
        d=pymupdf.open()
        for lines in pages:
            p=d.new_page(width=595.276,height=841.89)
            for k,l in enumerate(lines):p.insert_text((72,80+16*k),l,fontsize=11)
        return d.tobytes()
    def test_real_pdfs_through_production_qa(self):
        head='Running header';src=self.real_pdf([[head,'Page one stays as it was.'],[head,'We see that the result holds here today.'],[head,'Page three stays too.']])
        def editor(out_pages):
            out=self.real_pdf(out_pages)
            def run(args):
                req=json.loads(Path(args['--request']).read_text(encoding='utf-8'))
                Path(args['--out']).write_bytes(out)
                Path(args['--report']).write_text(json.dumps({'ok':True,'layoutVerified':True,'runtime':{'wasmSha256':WASM},'edits':[{'id':e['id'],'pageIndex':e['pageIndex'],'status':'applied'} for e in req['edits']],
                    'selfCheck':{'status':'passed','failures':[]},'pageCount':{'source':3,'output':3},'outputSha256':hashlib.sha256(out).hexdigest(),
                    'sourcePageMap':[{'sourcePageIndex':i,'outputPageIndex':i,'continuationPageIndices':[]} for i in range(3)]}))
                return SimpleNamespace(returncode=0,stdout=b'{"ok":true}\n')
            return run
        data=payload(file=base64.b64encode(src).decode(),fileHash=hashlib.sha256(src).hexdigest(),
            patches=[{'label':'PDF p. 2','before':'the result holds','after':'the result may hold'}])
        good=[[head,'Page one stays as it was.'],[head,'We see that the result may hold here today.'],[head,'Page three stays too.']]
        svc=es.PdfEditorService(self.config,runner=FakeRunner(edit=editor(good)))
        # A longer proportional-font After moves kept text beyond the sealed source region.
        # The usable file is retained, but that movement cannot be certified as unchanged raster.
        v=svc.export(data)['verification'];self.assertEqual(v['independentQA'],'warning',v['independentChecks'])
        self.assertIn({'code':'edited_page_render','status':'warning','pages':[2]},v['independentChecks']['checks'])
        corrupt=[good[0],good[1],[head,'Page three changed too.']]
        with self.assertRaisesRegex(ValueError,'unedited_'):es.PdfEditorService(self.config,runner=FakeRunner(edit=editor(corrupt))).export(data)
        def white(out_pages):
            import pymupdf
            d=pymupdf.open(stream=self.real_pdf(out_pages),filetype='pdf');d[1].insert_text((72,300),'white words',fontsize=11,color=(1,1,1));return d
        out=white(good).tobytes()
        def run_white(args):
            editor_run=editor(good);editor_run(args);Path(args['--out']).write_bytes(out)
            rep=json.loads(Path(args['--report']).read_text());rep['outputSha256']=hashlib.sha256(out).hexdigest();Path(args['--report']).write_text(json.dumps(rep))
            return SimpleNamespace(returncode=0,stdout=b'{"ok":true}\n')
        r=es.PdfEditorService(self.config,runner=FakeRunner(edit=run_white)).export(data)
        self.assertEqual(r['verification']['independentQA'],'warning');self.assertEqual(base64.b64decode(r['file']),out,'uncertain diagnostics keep the download')

class EditPlanTests(Base):
    """Source-derived private edit plan: built before the editor runs, handed only to the default production QA, public summary only."""
    HEAD='Running header'
    def setUp(self):
        super().setUp()
        self.src=IndependentQATests.real_pdf(self,[[self.HEAD,'Page one stays as it was.'],[self.HEAD,'We see that the result','holds here today.']])
        self.out=IndependentQATests.real_pdf(self,[[self.HEAD,'Page one stays as it was.'],[self.HEAD,'We see that the result','may hold here today.']])
        self.edits=[{'id':'edit-1','pageIndex':1,'before':'the result holds','after':'the result may hold'}]
    def data(self,before='the result holds',after='the result may hold'):
        return payload(file=base64.b64encode(self.src).decode(),fileHash=hashlib.sha256(self.src).hexdigest(),
            patches=[{'label':'PDF p. 2','before':before,'after':after}])
    def editor(self):
        out=self.out
        def run(args):
            req=json.loads(Path(args['--request']).read_text(encoding='utf-8'))
            Path(args['--out']).write_bytes(out)
            Path(args['--report']).write_text(json.dumps({'ok':True,'layoutVerified':True,'runtime':{'wasmSha256':WASM},'edits':[{'id':e['id'],'pageIndex':e['pageIndex'],'status':'applied'} for e in req['edits']],
                'selfCheck':{'status':'passed','failures':[]},'pageCount':{'source':2,'output':2},'outputSha256':hashlib.sha256(out).hexdigest(),
                'sourcePageMap':[{'sourcePageIndex':i,'outputPageIndex':i,'continuationPageIndices':[]} for i in range(2)]}))
            return SimpleNamespace(returncode=0,stdout=b'{"ok":true}\n')
        return FakeRunner(edit=run)
    def assert_private(self,result,plan):
        blob=json.dumps(result['verification'])
        # Fixed QA limitation prose may say "regions"; private region DATA must not be returned.
        for leak in ['Helvetica','the result','"regions":','beforeSha256',plan['edits'][0]['beforeSha256'],str(self.tmp.name).lower()]:self.assertNotIn(leak.lower(),blob.lower())
        for region in plan['edits'][0]['regions']:self.assertNotIn(str(region[0]),blob)

    def test_production_qa_gets_same_sealed_plan_by_keyword(self):
        calls=[]
        def production(source,out,edits,page_map,page_count=None,*,edit_plan=None,runner=None):
            calls.append({'args':(Path(source).read_bytes(),Path(out).read_bytes(),edits,page_map,page_count),'edit_plan':edit_plan})
            return pdf_quality.verify_pdf_quality(Path(source).read_bytes(),Path(out).read_bytes(),edits,page_map,page_count)
        runner=self.editor();planned=[]
        def planner(source,source_hash,edits):
            planned.append(([c for c in runner.calls if '--request' in c['argv']],Path(source).read_bytes(),source_hash))
            return paper_inventory.plan_isolated(source,source_hash,edits)
        with patch.object(pdf_quality,'inspect_isolated',production):
            svc=es.PdfEditorService(self.config,runner=runner,planner=planner);result=svc.export(self.data())
        expected=paper_inventory.build_edit_plan(self.src,self.edits)
        self.assertEqual(expected['status'],'resolved')
        self.assertEqual(planned,[([],self.src,hashlib.sha256(self.src).hexdigest())],'plan built from the exact source before the editor ran')
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['edit_plan'],expected)
        self.assertEqual(calls[0]['args'][2],[{'pageIndex':1,'before':'the result holds','after':'the result may hold'}],'positional arguments unchanged')
        v=result['verification']
        self.assertEqual(v['editPlanSummary'],{'schema':'falsify.pdf-edit-plan-summary.v1','status':'resolved','plannedEdits':1,'resolvedEdits':1,'policy':'document-consistency-text'})
        self.assertEqual(v['independentQA'],'warning',v['independentChecks'])
        self.assertIn({'code':'edited_page_render','status':'warning','pages':[2]},v['independentChecks']['checks'])
        self.assert_private(result,expected)
        self.assertEqual(self.runner_request(runner),{'schema':es.REQUEST_SCHEMA,'input':'source.pdf','inputSha256':hashlib.sha256(self.src).hexdigest(),'reflow':True,
            'edits':[{'id':'edit-1','pageIndex':1,'before':'the result holds','after':'the result may hold'}]},'Node wire request unchanged')
    def runner_request(self,runner):return runner.requests[-1]

    def test_default_planner_and_legacy_production_qa_without_edit_plan(self):
        calls=[]
        def legacy(source,out,edits,page_map,page_count=None):
            calls.append(edits);return pdf_quality.verify_pdf_quality(Path(source).read_bytes(),Path(out).read_bytes(),edits,page_map,page_count)
        with patch.object(pdf_quality,'inspect_isolated',legacy):
            svc=es.PdfEditorService(self.config,runner=self.editor());result=svc.export(self.data())
        self.assertIs(svc.planner,paper_inventory.plan_isolated);self.assertFalse(svc._qa_takes_plan)
        self.assertEqual(len(calls),1);self.assertEqual(result['verification']['independentQA'],'warning')
        self.assertIn({'code':'edited_page_render','status':'warning','pages':[2]},result['verification']['independentChecks']['checks'])
        self.assertEqual(result['verification']['editPlanSummary']['status'],'resolved','default isolated planner')
        self.assert_private(result,paper_inventory.build_edit_plan(self.src,self.edits))

    def test_injected_qa_never_receives_plan(self):
        seen=[]
        def injected(source,out,edits,page_map,page_count,edit_plan='unset'):seen.append(edit_plan);return qa_report('passed','page_map')
        svc=es.PdfEditorService(self.config,runner=self.editor(),quality=injected);result=svc.export(self.data())
        self.assertEqual(seen,['unset']);self.assertEqual(result['verification']['independentQA'],'passed')
        self.assertEqual(result['verification']['editPlanSummary']['resolvedEdits'],1)

    def test_unresolved_or_failed_plan_never_blocks_export(self):
        forged=paper_inventory.build_edit_plan(self.src,self.edits);forged['sourceSha256']='0'*64
        nan=paper_inventory.build_edit_plan(self.src,self.edits);nan['edits'][0]['regions']=[[0,0,float('nan'),1]]
        for name,planner,status in [('raises',lambda *a:(_ for _ in ()).throw(RuntimeError('boom')),'unavailable'),('garbage',lambda *a:{'schema':'x'},'unavailable'),
                ('other source',lambda *a:forged,'unavailable'),('nan',lambda *a:nan,'unavailable'),('none',lambda *a:None,'unavailable')]:
            with self.subTest(name=name):
                q=FakeQuality(qa_report('passed','page_map'))
                result=es.PdfEditorService(self.config,runner=self.editor(),quality=q,planner=planner).export(self.data())
                self.assertEqual(base64.b64decode(result['file']),self.out)
                self.assertEqual(result['verification']['editPlanSummary'],{'schema':'falsify.pdf-edit-plan-summary.v1','status':status,'plannedEdits':1,'resolvedEdits':0,'policy':'document-consistency-text'})
        result=es.PdfEditorService(self.config,runner=self.editor(),quality=FakeQuality(qa_report('passed','page_map'))).export(self.data('he','He'))
        self.assertEqual(paper_inventory.build_edit_plan(self.src,[{**self.edits[0],'before':'he','after':'He'}])['edits'][0]['status'],'ambiguous')
        self.assertEqual(result['verification']['editPlanSummary']['status'],'unavailable','repeated anchor: no guessed plan, export unaffected')
        self.assertEqual(self.service().export(payload())['verification']['editPlanSummary']['status'],'unavailable','synthetic non-PDF bytes')
        with patch.dict(paper_inventory.LIMITS,{'maxTextChars':3}):
            result=es.PdfEditorService(self.config,runner=self.editor(),quality=FakeQuality(qa_report('passed','page_map'))).export(self.data())
        self.assertEqual(base64.b64decode(result['file']),self.out)
        self.assertEqual((result['verification']['editPlanSummary']['status'],result['verification']['editPlanSummary']['plannedEdits']),('unavailable',0),'outside planner bounds')

class ServerTests(Base):
    def start(self,editor):
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);httpd.pdf_editor=editor
        t=threading.Thread(target=httpd.serve_forever,daemon=True);t.start()
        self.addCleanup(lambda:(httpd.shutdown(),httpd.server_close(),t.join()));return httpd.server_port
    def call(self,port,path,body=None):
        origin=f'http://127.0.0.1:{port}';h={'Host':f'127.0.0.1:{port}','Origin':origin,'Authorization':'Bearer '+server.TOKEN}
        if body is not None:h['Content-Type']='application/json'
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=10);c.request('POST' if body is not None else 'GET',path,body=json.dumps(body) if body is not None else None,headers=h)
        r=c.getresponse();data=json.loads(r.read());c.close();return r.status,data
    def test_capabilities_old_keys_plus_pdf_editor(self):
        with patch.object(server,'cli_agents',lambda:[]):
            status,data=self.call(self.start(None),'/api/capabilities')
            self.assertEqual(status,200)
            for k in ['red','blue','pdf','officeLayoutVerifiedExport','model','isolation','cliSelection','cliAgents']:self.assertIn(k,data)
            self.assertEqual(data['pdfEditor'],es.unconfigured_capability())
            status,data=self.call(self.start(self.service()),'/api/capabilities')
            self.assertTrue(data['pdfEditor']['available']);self.assertIs(data['pdf'],True)
            status,data=self.call(self.start(self.service(version=b'v20.0.0\n')),'/api/capabilities')
            self.assertFalse(data['pdfEditor']['available']);self.assertIs(data['pdf'],False)
    def test_configured_export_routes_to_editor_and_failure_has_no_fallback(self):
        with patch.object(server,'handle_export',side_effect=AssertionError('legacy fallback')):
            status,data=self.call(self.start(self.service()),'/api/export',payload());self.assertEqual(status,200);self.assertEqual(data['verification']['engine'],'falsify-pdf-editor')
            status,data=self.call(self.start(self.service(edit='fail')),'/api/export',payload());self.assertEqual(status,400);self.assertIn('MATCH_FAILED',data['error'])
        self.assertTrue(server.ACTIVE.acquire(blocking=False));server.ACTIVE.release()
    def test_export_refusal_error_carries_known_reasons(self):
        report={'ok':False,'selfCheck':{'status':'failed','failures':[{'code':'after_missing','pageIndex':0},{'code':'C:/x','pageIndex':0}]}}
        status,data=self.call(self.start(self.service(edit=refusing(report))),'/api/export',payload())
        self.assertEqual(status,400);self.assertNotIn('file',data);self.assertNotIn('C:/x',data['error'])
        self.assertIn('(SELF_CHECK_FAILED). 진단: After 문구가 출력에서 확인되지 않음[after_missing] (p. 1).',data['error'])
    def test_unconfigured_export_keeps_legacy(self):
        with patch.object(server,'handle_export',lambda d:{'legacy':True}):
            self.assertEqual(self.call(self.start(None),'/api/export',payload()),(200,{'legacy':True}))

class MainTests(unittest.TestCase):
    def run_main(self,argv,environ=None):
        created=[]
        class Fake:
            def __init__(s,*a,**k):created.append(s)
            def serve_forever(s):raise KeyboardInterrupt
            def server_close(s):pass
        err=io.StringIO()
        with patch.object(sys,'argv',['server.py',*argv]),patch.object(server,'ThreadingHTTPServer',Fake),patch.dict('os.environ',environ or {},clear=False),\
                patch.object(es.PdfEditorService,'capability',lambda s,refresh=False:None),redirect_stdout(io.StringIO()),patch.object(sys,'stderr',err):
            try:server.main();code=0
            except SystemExit as e:code=e.code
        return code,created
    def test_partial_config_refused_before_bind(self):
        clean={k:'' for k in [es.ENV_ROOT,es.ENV_MANIFEST,es.ENV_SOURCE_ROOT,es.ENV_NODE]}
        code,created=self.run_main(['--port','40125','--pdf-editor-root',tempfile.gettempdir()],clean)
        self.assertEqual(code,2);self.assertEqual(created,[])
        code,created=self.run_main(['--port','40125','--pdf-editor-root','relative','--pdf-editor-manifest','candidate-manifest.json'],clean)
        self.assertEqual(code,2);self.assertEqual(created,[])
    def test_configured_and_default(self):
        t=Path(tempfile.gettempdir())
        clean={k:'' for k in [es.ENV_ROOT,es.ENV_MANIFEST,es.ENV_SOURCE_ROOT,es.ENV_NODE]}
        code,created=self.run_main(['--port','40125','--pdf-editor-root',str(t),'--pdf-editor-manifest',str(t/'candidate-manifest.json')],clean)
        self.assertEqual(code,0);self.assertIsInstance(created[0].pdf_editor,es.PdfEditorService)
        code,created=self.run_main(['--port','40125'],clean);self.assertEqual(code,0);self.assertIsNone(created[0].pdf_editor)

if __name__=='__main__':unittest.main()

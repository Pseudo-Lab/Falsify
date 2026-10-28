import base64
import hashlib
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from red_service import VERSION, validate_request, run_review, validate_candidates
from preserve import export_pdf, handle_export

BEFORE = 'Study does not show benefit.'
AFTER = 'Study does show benefit.'
TEXT = BEFORE + ' Only an association was observed.'
CANDIDATE = {'id': 'c1', 'segmentId': 's0', 'level': 1, 'before': BEFORE, 'after': AFTER,
    'rationale': 'Synthetic contradiction', 'evidence': [{'segmentId': 's0', 'quote': 'Only an association was observed.', 'relation': 'Limitation'}], 'uncertainty': 'Domain review pending'}

def request(text=TEXT, budget=8):
    return {'schema': VERSION, 'revision': 'r1', 'requestId': 'request1', 'sourceHash': hashlib.sha256(text.encode()).hexdigest(),
        'segments': [{'id': 's0', 'label': 'p1', 'text': text}], 'level': 1, 'maxCalls': budget, 'consent': True}

class MockBackend:
    prompts = []
    def __init__(self, **kwargs): self.kwargs = kwargs
    def infer(self, prompt, schema):
        self.prompts.append(prompt)
        if 'summary' in schema['properties']: response = {'status': 'ok', 'summary': 'Synthetic summary', 'evidence': []}
        else: response = {'status': 'ok', 'candidates': [CANDIDATE]}
        return {'status': 'ok', 'response': response}

class RedTests(unittest.TestCase):
    def test_explanation_language_preserves_quotes_and_harness(self):
        for code, name in [('ko', 'Korean'), ('en', 'English')]:
            MockBackend.prompts=[]
            data={**request(), 'explanationLanguage':code}
            run_review(data,lambda _:None,threading.Event(),MockBackend)
            self.assertIn(f'uncertainty and scan summaries in {name}',MockBackend.prompts[0])
            self.assertIn('Never translate exact source quotations',MockBackend.prompts[0])
            self.assertEqual(data['segments'][0]['text'],TEXT)
    def test_invalid_explanation_language_denied_before_calls(self):
        MockBackend.prompts=[]
        with self.assertRaises(ValueError):run_review({**request(),'explanationLanguage':'invalid'},lambda _:None,threading.Event(),MockBackend)
        self.assertEqual(MockBackend.prompts,[])
    def test_single_fulltext_call(self):
        MockBackend.prompts=[]
        result=run_review(request(), lambda _:None, threading.Event(), MockBackend)
        self.assertEqual(result['coverage']['calls'],1);self.assertIn(TEXT,MockBackend.prompts[0]);self.assertTrue(result['coverage']['complete'])
    def test_multichunk_all_read_then_proposals(self):
        MockBackend.prompts=[]
        result=run_review(request(TEXT+'x'*72000), lambda _:None, threading.Event(), MockBackend)
        self.assertEqual(len(MockBackend.prompts),4);self.assertEqual(result['coverage']['completedChunks'],3)
    def test_budget_denied_before_calls(self):
        MockBackend.prompts=[]
        with self.assertRaises(ValueError):run_review(request(TEXT+'x'*72000,2),lambda _:None,threading.Event(),MockBackend)
        self.assertEqual(MockBackend.prompts,[])
    def test_wrong_hash(self):
        data=request();data['sourceHash']='invalid'
        with self.assertRaises(ValueError):validate_request(data)
    def test_no_consent(self):
        data=request();data['consent']=False
        with self.assertRaises(ValueError):validate_request(data)
    def test_cancel_before_call(self):
        MockBackend.prompts=[];cancel=threading.Event();cancel.set()
        with self.assertRaises(ValueError):run_review(request(),lambda _:None,cancel,MockBackend)
        self.assertEqual(MockBackend.prompts,[])
    def test_invalid_evidence(self):
        with self.assertRaises(ValueError):validate_candidates({'status':'ok','candidates':[{**CANDIDATE,'evidence':[{'segmentId':'s0','quote':'fake','relation':'fake'}]}]},request()['segments'])
    def test_refusal_no_retry(self):
        class Refusal(MockBackend):
            def infer(self,*_):return {'status':'ok','response':{'status':'refusal','candidates':[]}}
        result=run_review(request(),lambda _:None,threading.Event(),Refusal)
        self.assertEqual(result['status'],'refusal');self.assertEqual(result['candidates'],[])
    def test_provider_error_no_retry(self):
        class Error(MockBackend):
            calls=0
            def infer(self,*_):self.__class__.calls+=1;return {'status':'error','error_code':'synthetic_error'}
        with self.assertRaises(ValueError):run_review(request(),lambda _:None,threading.Event(),Error)
        self.assertEqual(Error.calls,1)
    def test_mixed_types_deletion_and_optional_uncertainty(self):
        c={**CANDIDATE, 'attackTypes':['contradiction','unsupported-inference'], 'after':''}
        del c['level']; del c['uncertainty']
        validate_candidates({'status':'ok','candidates':[c]}, request()['segments'])
        data=request(); del data['level']; data['attackTypes']=['contradiction','unsupported-inference']
        validate_request(data)
        class Mixed(MockBackend):
            def infer(self, prompt, schema): return {'status':'ok','response':{'status':'ok','candidates':[c]}}
        self.assertEqual(run_review(data,lambda _:None,threading.Event(),Mixed)['candidates'][0]['after'],'')
    def test_real_schema_nullable_uncertainty_and_pdf_prompt(self):
        from jsonschema import Draft202012Validator
        data=request(); del data['level']; data['attackTypes']=['contradiction','unsupported-inference']; data['format']='PDF'
        candidate={**CANDIDATE, 'attackTypes':data['attackTypes'], 'uncertainty':None, 'after':''}; del candidate['level']
        class Validating(MockBackend):
            def infer(self, prompt, schema):
                response={'status':'ok','candidates':[candidate]}
                Draft202012Validator(schema).validate(response)
                assert 'ONE original line' not in prompt and 'original text width' not in prompt
                return {'status':'ok','response':response}
        self.assertIsNone(run_review(data,lambda _:None,threading.Event(),Validating)['candidates'][0]['uncertainty'])

    def test_legacy_level_payload_and_schema_with_type_adapter(self):
        from jsonschema import Draft202012Validator
        data={**request(), 'attackTypes':['contradiction']}
        class Legacy(MockBackend):
            def infer(self, prompt, schema):
                self.assert_payload = '"level": 1' in prompt
                assert self.assert_payload
                response={'status':'ok','candidates':[CANDIDATE]}
                Draft202012Validator(schema).validate(response)
                return {'status':'ok','response':response}
        self.assertEqual(run_review(data,lambda _:None,threading.Event(),Legacy)['candidates'][0]['level'],1)

    def test_office_export_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'렌더러'):handle_export({'format':'DOCX'})

class PdfTests(unittest.TestCase):
    def setUp(self):
        import pymupdf as fitz
        self.fitz=fitz;doc=fitz.open();page=doc.new_page();page.insert_text((50,70),BEFORE);page.insert_text((50,110),'Untouched evidence and layout.');doc.new_page().insert_text((50,70),'Second untouched page.')
        self.raw=doc.tobytes();doc.close()
        self.patch={'id':'c1','label':'PDF p. 1','before':BEFORE,'after':AFTER}
    def test_real_text_removed_and_layout_verified(self):
        out,verification=export_pdf(self.raw,[self.patch]);doc=self.fitz.open(stream=out,filetype='pdf')
        self.assertNotIn(BEFORE,doc[0].get_text());self.assertIn(AFTER,doc[0].get_text());self.assertIn('Untouched evidence',doc[0].get_text());self.assertTrue(verification['outsideSelectedAreasUnchanged']);doc.close()
    def test_overflow_rejected(self):
        with self.assertRaisesRegex(ValueError,'공간'):export_pdf(self.raw,[{**self.patch,'after':'Long replacement '*100}])
    def test_unknown_quote_rejected(self):
        with self.assertRaises(ValueError):export_pdf(self.raw,[{**self.patch,'before':'Fake quote'}])
    def test_unicode_font_rejected(self):
        with self.assertRaisesRegex(ValueError,'글꼴'):export_pdf(self.raw,[{**self.patch,'after':'한글'}])
    def test_embedded_original_font(self):
        fontpath=Path('C:/Windows/Fonts/arial.ttf')
        if not fontpath.is_file():self.skipTest('Windows Arial font unavailable')
        doc=self.fitz.open();page=doc.new_page();page.insert_font(fontname='Original',fontfile=str(fontpath));page.insert_text((50,70),BEFORE,fontname='Original');raw=doc.tobytes();doc.close()
        out,verification=export_pdf(raw,[self.patch]);self.assertTrue(verification['outsideSelectedAreasUnchanged']);self.assertGreater(len(out),0)
    def test_overlap_rejected(self):
        with self.assertRaisesRegex(ValueError,'겹칩니다'):export_pdf(self.raw,[self.patch,self.patch])
    def test_source_hash_required(self):
        with self.assertRaisesRegex(ValueError,'해시'):handle_export({'format':'PDF','file':base64.b64encode(self.raw).decode(),'fileHash':'fake','patches':[self.patch]})

if __name__=='__main__':unittest.main()

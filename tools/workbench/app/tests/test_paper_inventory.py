"""Source-derived edit plan and inventory tests on real in-memory PDFs (PyMuPDF). No editor, Node or server."""
import hashlib
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import paper_inventory as pi
import pymupdf

sha=lambda b:hashlib.sha256(b).hexdigest()
def edit(before,after=None,page=0,id='edit-1'):return {'id':id,'pageIndex':page,'before':before,'after':after or before+' (revised)'}
def pdf(lines,page=None,**kw):
    """One A4 page per entry; each line (text, kw) at 16 pt pitch in Helvetica 11 unless overridden."""
    d=pymupdf.open()
    for spec in lines:
        p=d.new_page(width=595.276,height=841.89)
        for k,l in enumerate(spec):
            text,opts=(l,{}) if isinstance(l,str) else l
            p.insert_text((72,80+16*k),text,**{'fontsize':11,**opts})
        if page:page(p)
    return d.tobytes()
def writer_pdf(text):
    """Unicode text through an embedded font (keeps ligature/minus code points in extraction)."""
    d=pymupdf.open();p=d.new_page();tw=pymupdf.TextWriter(p.rect);tw.append((72,100),text,font=pymupdf.Font('helv'),fontsize=11);tw.write_text(p)
    return d.tobytes()

class PlanTests(unittest.TestCase):
    def plan(self,src,*edits):return pi.build_edit_plan(src,list(edits))
    def one(self,src,before,**kw):return self.plan(src,edit(before,**kw))['edits'][0]

    def test_hashes_schema_and_exact_keys(self):
        src=pdf([['We see that the result holds here today.']])
        plan=self.plan(src,edit('the result holds','the result may hold'))
        self.assertEqual(set(plan),{'schema','sourceSha256','policy','status','edits'})
        self.assertEqual((plan['schema'],plan['policy'],plan['status'],plan['sourceSha256']),(pi.SCHEMA,pi.POLICY,'resolved',sha(src)))
        e=plan['edits'][0]
        self.assertEqual(set(e),set(pi.EDIT_KEYS))
        self.assertEqual((e['id'],e['pageIndex'],e['status']),('edit-1',0,'resolved'))
        self.assertEqual(e['beforeSha256'],sha('the result holds'.encode()));self.assertEqual(e['afterSha256'],sha('the result may hold'.encode()))
        self.assertEqual(e['styles'],[{'font':'Helvetica','size':11.0,'color':0}])
        self.assertNotIn('the result',json.dumps(plan),'private plan carries hashes, never document text')

    def test_selected_before_after_hashes_are_exact_not_normalized(self):
        src=pdf([['the result holds']])
        a=self.one(src,'the result holds');b=self.one(src,'the  result holds ')
        self.assertEqual((a['status'],b['status']),('resolved','resolved'))
        self.assertNotEqual(a['beforeSha256'],b['beforeSha256']);self.assertEqual(a['regions'],b['regions'])

    def test_multiline_tight_per_line_rectangles(self):
        src=pdf([['We see that the result','holds here today, as before.']])
        e=self.one(src,'the result holds')
        self.assertEqual(e['status'],'resolved');self.assertEqual(len(e['regions']),2)
        (a0,a1),(b0,b1)=[(r[:2],r[2:]) for r in e['regions']]
        width=pymupdf.get_text_length
        self.assertAlmostEqual(e['regions'][0][0],72+width('We see that ',fontsize=11),places=1,msg='starts at the selected char, not the line start')
        self.assertAlmostEqual(e['regions'][0][2],72+width('We see that the result',fontsize=11),places=1)
        self.assertAlmostEqual(e['regions'][1][0],72,places=1);self.assertAlmostEqual(e['regions'][1][2],72+width('holds',fontsize=11),places=1,msg='ends at the selected char')
        self.assertLess(e['regions'][0][3],e['regions'][1][3]);self.assertLessEqual(e['regions'][0][1],80);self.assertGreaterEqual(e['regions'][1][3],96)
        for r in e['regions']:
            self.assertTrue(all(math.isfinite(v) for v in r));self.assertLess(r[0],r[2]);self.assertLess(r[1],r[3])
            self.assertLess(r[3]-r[1],20,'one line tall');self.assertLess(r[2]-r[0],595*0.5,'not page wide')

    def test_whitespace_only_normalization(self):
        src=pdf([['We see that the result','holds here today.']])
        for before in ['the result holds','the   result\n holds','\tthe result\r\nholds  ']:
            with self.subTest(before=before):self.assertEqual(self.one(src,before)['status'],'resolved')
        for before in ['the results holds','The result holds','the result-holds','theresult holds']:
            with self.subTest(before=before):self.assertEqual(self.one(src,before)['status'],'unavailable')

    def test_repeated_anchors_and_quotes_are_ambiguous(self):
        src=pdf([['As "noted" before, it holds.','We again say "noted" here.']])
        self.assertEqual(self.one(src,'"noted"')['status'],'ambiguous')
        self.assertEqual(self.one(src,'As "noted" before')['status'],'resolved')
        self.assertEqual(self.one(pdf([['aaa']]),'aa')['status'],'ambiguous','overlapping repeats count')
        plan=self.plan(src,edit('"noted"'),edit('it holds',id='edit-2'))
        self.assertEqual((plan['status'],[e['status'] for e in plan['edits']]),('partial',['ambiguous','resolved']))
        self.assertEqual((plan['edits'][0]['regions'],plan['edits'][0]['styles']),([],[]),'no guessed geometry')
        self.assertEqual(self.one(pdf([['the value'],['the value']]),'the value',page=1)['status'],'resolved','repeats on other pages do not count')

    def test_signs_digits_operators_are_exact(self):
        src=pdf([['so x = -0.5 and a + b > 3.']])
        self.assertEqual(self.one(src,'x = -0.5')['status'],'resolved')
        for before in ['x = −0.5','x = 0.5 and','a - b','a + b < 3','x = -0,5']:
            with self.subTest(before=before):self.assertEqual(self.one(src,before)['status'],'unavailable')
        uni=writer_pdf('so x = −0.5 here')
        self.assertEqual(self.one(uni,'x = −0.5')['status'],'resolved');self.assertEqual(self.one(uni,'x = -0.5')['status'],'unavailable')

    def test_ligatures_never_resolve(self):
        src=writer_pdf('a ﬁne result here')
        self.assertEqual(self.one(src,'fine result')['status'],'unavailable')
        self.assertEqual(self.one(src,'a ﬁne result')['status'],'unavailable')
        self.assertEqual(self.one(src,'result here')['status'],'resolved')

    def test_mixed_fonts_sizes_colors_never_resolve(self):
        w=pymupdf.get_text_length('alpha ',fontsize=11)
        def mixed(opts):
            d=pymupdf.open();p=d.new_page();p.insert_text((72,100),'alpha ',fontsize=11);p.insert_text((72+w,100),'beta gamma',**{'fontsize':11,**opts});return d.tobytes()
        for opts in [{'fontname':'Times-Roman'},{'fontsize':12},{'color':(1,0,0)}]:
            with self.subTest(opts=opts):
                src=mixed(opts)
                self.assertEqual(self.one(src,'alpha beta')['status'],'unavailable')
                e=self.one(src,'beta gamma');self.assertEqual(e['status'],'resolved')
        self.assertEqual(self.one(mixed({'color':(1,0,0)}),'beta gamma')['styles'],[{'font':'Helvetica','size':11.0,'color':0xFF0000}])

    def test_rotated_cropped_offset_pages_and_rotated_text_never_resolve(self):
        base=[['the result holds here']]
        cases={'rotated':lambda p:p.set_rotation(90),'cropped':lambda p:p.set_cropbox(pymupdf.Rect(10,10,500,800)),
            'offset mediabox':lambda p:p.set_mediabox(pymupdf.Rect(20,20,615,861))}
        for name,fn in cases.items():
            with self.subTest(name=name):self.assertEqual(self.one(pdf(base,page=fn),'the result holds')['status'],'unavailable')
        self.assertEqual(self.one(pdf([[('the result holds here',{'rotate':90})]]),'the result holds')['status'],'unavailable','vertical line')
        self.assertEqual(self.one(pdf(base),'the result holds')['status'],'resolved')

    def test_invalid_inputs_degrade_to_unavailable(self):
        edits=[edit('the result holds')]
        for src in [b'',b'not a pdf',b'%PDF-1.7 synthetic bytes only',bytearray(b'%PDF-1.4\n%%EOF'),None,'%PDF-1.7']:
            with self.subTest(src=src):
                plan=pi.build_edit_plan(src,edits)
                self.assertEqual((plan['status'],plan['edits'][0]['status'],plan['edits'][0]['regions']),('unavailable','unavailable',[]))
                self.assertEqual(plan['edits'][0]['beforeSha256'],sha(b'the result holds'))
        self.assertEqual(self.one(pdf([['x']]),'the result holds',page=3)['status'],'unavailable','page out of range')
        enc=pymupdf.open(stream=pdf([['the result holds']]));secret=enc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,user_pw='u',owner_pw='o')
        self.assertEqual(self.one(secret,'the result holds')['status'],'unavailable','password-protected')
        with patch.dict(sys.modules,{'pymupdf':None}):
            self.assertEqual(pi.build_edit_plan(pdf([['the result holds']]),edits)['status'],'unavailable','dependency missing')
            self.assertEqual(pi.build_inventory(pdf([['x']]))['status'],'unavailable')

    def test_malformed_edits_raise(self):
        src=pdf([['x']])
        for bad in [[],None,'edits',[edit('a')]*13,[{**edit('a'),'id':'../x'}],[{**edit('a'),'pageIndex':-1}],[{**edit('a'),'pageIndex':True}],
                [{**edit('a'),'before':' '}],[{**edit('a'),'after':1}],[edit('a'),edit('b')],[{**edit('a'),'before':'x'*4001}]]:
            with self.subTest(bad=str(bad)[:60]):
                with self.assertRaises(ValueError):pi.build_edit_plan(src,bad)

    def test_page_budgets(self):
        src=pdf([['the result holds here','and more text after it.']])
        for key,value in [('maxPageChars',10),('maxPageSpans',1),('maxRegions',0),('maxFileBytes',10)]:
            with self.subTest(key=key),patch.dict(pi.LIMITS,{key:value}):
                self.assertEqual(self.one(src,'the result holds')['status'],'unavailable')
        with patch.dict(pi.LIMITS,{'maxPages':1}):
            self.assertEqual(self.one(pdf([['the result holds'],['x']]),'the result holds')['status'],'unavailable','page count over budget')

    def test_source_bytes_never_mutated(self):
        src=bytearray(pdf([['the result holds']]));before=bytes(src)
        pi.build_edit_plan(src,[edit('the result holds')]);pi.build_inventory(src)
        self.assertEqual(bytes(src),before)

class ValidateTests(unittest.TestCase):
    def setUp(self):
        self.src=pdf([['We see that the result','holds here today.']]);self.edits=[edit('the result holds')]
        self.plan=pi.build_edit_plan(self.src,self.edits)
    def test_round_trip_and_copy(self):
        got=pi.validate_plan(json.loads(json.dumps(self.plan)),sha(self.src),self.edits)
        self.assertEqual(got,self.plan);self.assertIsNot(got['edits'][0]['regions'],self.plan['edits'][0]['regions'])
    def test_rejects_rebinding_and_malformed(self):
        h=sha(self.src)
        def mutate(fn):
            p=json.loads(json.dumps(self.plan));fn(p);return pi.validate_plan(p,h,self.edits)
        self.assertIsNone(pi.validate_plan(self.plan,'0'*64,self.edits),'other source')
        self.assertIsNone(pi.validate_plan(self.plan,h,[edit('the result holds','other After')]),'other After')
        self.assertIsNone(pi.validate_plan(self.plan,h,[edit('the result holds',page=1)]),'other page')
        bad=[lambda p:p.update(extra=1),lambda p:p.update(status='partial'),lambda p:p.update(policy='x'),lambda p:p['edits'].append(p['edits'][0]),
            lambda p:p['edits'][0].update(regions=[[0,0,float('nan'),1]]),lambda p:p['edits'][0].update(regions=[[5,5,1,1]]),
            lambda p:p['edits'][0].update(regions=[[0,0,1,float('inf')]]),lambda p:p['edits'][0].update(regions=[]),
            lambda p:p['edits'][0].update(regions=[['0',0,1,1]]),lambda p:p['edits'][0].update(styles=[]),
            lambda p:p['edits'][0]['styles'][0].update(color=-1),lambda p:p['edits'][0]['styles'][0].update(size=0),
            lambda p:p['edits'][0].update(status='ambiguous'),lambda p:p['edits'][0].update(text='the result holds'),
            lambda p:p['edits'][0].update(pageIndex=True)]
        for fn in bad:
            with self.subTest(fn=fn):self.assertIsNone(mutate(fn))
        self.assertIsNone(pi.validate_plan(None,h,self.edits));self.assertIsNone(pi.validate_plan(self.plan,h,'x'))

    def test_summary_is_fixed_and_private(self):
        s=pi.summarize(self.plan)
        self.assertEqual(s,{'schema':'falsify.pdf-edit-plan-summary.v1','status':'resolved','plannedEdits':1,'resolvedEdits':1,'policy':'document-consistency-text'})
        blob=json.dumps(s)
        for leak in ['Helvetica','regions',str(self.plan['edits'][0]['regions'][0][0]),self.plan['edits'][0]['beforeSha256'],self.plan['sourceSha256']]:self.assertNotIn(leak,blob)
        self.assertEqual(pi.summarize(None)['status'],'unavailable');self.assertEqual(pi.summarize({'schema':'x'})['plannedEdits'],0)
        self.assertEqual(pi.summarize(pi.unavailable_plan(sha(b'x'),self.edits)),{**s,'status':'unavailable','resolvedEdits':0})

class IsolatedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'source.pdf'
        self.src=pdf([['We see that the result','holds here today.']]);self.path.write_bytes(self.src);self.edits=[edit('the result holds')]
    def tearDown(self):self.tmp.cleanup()
    def test_child_matches_in_process_and_leaves_source(self):
        plan=pi.plan_isolated(self.path,sha(self.src),self.edits)
        self.assertEqual(plan,pi.build_edit_plan(self.src,self.edits));self.assertEqual(plan['status'],'resolved')
        self.assertEqual(self.path.read_bytes(),self.src)
    def test_hash_mismatch_and_runner_failures_are_unavailable(self):
        self.assertEqual(pi.plan_isolated(self.path,'0'*64,self.edits)['status'],'unavailable','file is not the declared source')
        h=sha(self.src)
        forged=json.loads(json.dumps(pi.build_edit_plan(self.src,self.edits)));forged['edits'][0]['regions']=[[0,0,595,842],[0,0,1,float('nan')]]
        outs=[subprocess.TimeoutExpired('x',1),OSError(),SimpleNamespace(returncode=1,stdout=b''),SimpleNamespace(returncode=0,stdout=b'not json\n'),
            SimpleNamespace(returncode=0,stdout=b'{}\n{}\n'),SimpleNamespace(returncode=0,stdout=b'x'*(pi.LIMITS['maxStdoutBytes']+1)),
            SimpleNamespace(returncode=0,stdout=(json.dumps(forged)+'\n').encode())]
        for out in outs:
            def runner(argv,*,input,cwd,env,timeout,out=out):
                self.assertEqual(argv[1:3],['-I',str(Path(pi.__file__).resolve())]);self.assertNotIn('NODE_OPTIONS',env)
                if isinstance(out,Exception):raise out
                return out
            with self.subTest(out=str(out)[:40]):
                self.assertEqual(pi.plan_isolated(self.path,h,self.edits,runner=runner),pi.unavailable_plan(h,self.edits))

class InventoryTests(unittest.TestCase):
    def test_bounded_bbox_inventory(self):
        d=pymupdf.open();p=d.new_page();p.insert_text((72,80),'Line one',fontsize=11);p.draw_rect(pymupdf.Rect(100,200,300,260),color=(0,0,0))
        pix=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(0,0,4,4),False);pix.clear_with(200);p.insert_image(pymupdf.Rect(300,300,340,340),pixmap=pix)
        d.new_page().set_rotation(90);src=d.tobytes()
        inv=pi.build_inventory(src)
        self.assertEqual((inv['schema'],inv['status'],inv['sourceSha256'],len(inv['pages'])),(pi.INVENTORY_SCHEMA,'available',sha(src),2))
        p0,p1=inv['pages']
        self.assertEqual((len(p0['text']),len(p0['images']),p0['supportedGeometry'],p1['rotation'],p1['supportedGeometry']),(1,1,True,90,False))
        self.assertTrue(any(abs(v[0]-100)<2 and abs(v[3]-260)<2 for v in p0['vectors']))
        self.assertNotIn('Line one',json.dumps(inv),'boxes only, no text')
        with patch.dict(pi.LIMITS,{'maxInventoryItems':0,'maxInventoryPages':1}):
            small=pi.build_inventory(src,[1,0,0,99])
        self.assertEqual([p['pageIndex'] for p in small['pages']],[1])
        self.assertEqual(pi.build_inventory(b'nope'),{'schema':pi.INVENTORY_SCHEMA,'sourceSha256':sha(b'nope'),'status':'unavailable','pages':[]})

if __name__=='__main__':unittest.main()

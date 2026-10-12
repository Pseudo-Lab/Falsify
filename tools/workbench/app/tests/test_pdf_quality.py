"""Independent MuPDF QA tests on real in-memory PyMuPDF documents (no Node, no server, no network).

The fixture uses the monospaced base-14 Courier and a same-length After, so an ordinary same-position wording edit
keeps every unselected glyph in place and can pass the regional edited-page comparison. Edits that move kept text,
continuations or ambiguous cases are regional warnings; proven damage on the edited page itself (e.g. a white cover
over the edited line) is now a failure where the older whole-page heuristics only warned. See test_pdf_regions.py."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import pdf_quality as q
import pymupdf

W,H=595.276,841.89
HEAD='Running header of the paper'
P1=[HEAD,'First page body text that stays unchanged across export.','Footer 1']
P2=[HEAD,'We observe that the result holds under mild conditions here.','Second paragraph continues with several more words.','Footer 2']
P2E=[HEAD,'We observe that the result fails under mild conditions here.','Second paragraph continues with several more words.','Footer 2']
P3=[HEAD,'Third page body text is untouched by the editor.','Footer 3']
EDITS=[{'pageIndex':1,'before':'the result holds','after':'the result fails'}]
def ident(n):return [{'sourcePageIndex':i,'outputPageIndex':i,'continuationPageIndices':[]} for i in range(n)]

def build(pages,extra=None,mediabox=None):
    d=pymupdf.open()
    for i,lines in enumerate(pages):
        p=d.new_page(width=W,height=H);y=80
        for l in lines:
            p.insert_text((72,y),l,fontname='cour',fontsize=11);y+=16
        if extra:extra(i,p)
        if mediabox:p.set_mediabox(pymupdf.Rect(*mediabox))
    return d.tobytes()

SRC=build([P1,P2,P3])
def run(out,edits=EDITS,page_map='ident',count=None,src=SRC):
    n=pymupdf.open(stream=out,filetype='pdf').page_count
    pm=ident(3) if page_map=='ident' else page_map
    return q.verify_pdf_quality(src,out,edits,pm,count if count is not None else {'source':3,'output':n})
def status(r,code):return next((c['status'],c['pages']) for c in r['checks'] if c['code']==code)
def bad(r):return {c['code']:c['status'] for c in r['checks'] if c['status']!='passed'}

class Baseline(unittest.TestCase):
    def test_positive_is_passed_sanitized_and_text_free(self):
        r=run(build([P1,P2E,P3]))
        self.assertEqual(r['status'],'passed',bad(r));self.assertEqual(r['schema'],'falsify.pdf-quality.v1')
        self.assertEqual(q.sanitize(r),r);self.assertTrue(r['method'].startswith('mupdf '))
        for code in q.REGIONAL:self.assertEqual(status(r,code),('passed',[]),'regional QA ran on the edited page')
        blob=json.dumps(r)
        for word in ['observe','result','fails','Running header','Footer']:self.assertNotIn(word,blob)
        self.assertTrue(set(r['limitations'])<=set(q.LIMITATIONS.values()))
    def test_longer_after_shifting_kept_text_is_partial_warning(self):
        # Kept text after a longer After slides outside the sealed source region: honest warning, never failed or passed.
        edits=[{'pageIndex':1,'before':'the result holds','after':'the result may hold'}]
        out=build([P1,[HEAD,'We observe that the result may hold under mild conditions here.',*P2[2:]],P3])
        r=run(out,edits=edits)
        self.assertEqual(r['status'],'warning',bad(r));self.assertEqual(status(r,'edited_page_render'),('warning',[2]))
        self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
    def test_float32_mediabox_drift_tolerated(self):
        out=build([P1,P2E,P3],mediabox=(0,0,595.27597,841.88997))
        self.assertEqual(run(out)['status'],'passed')
    def test_existing_source_defects_not_flagged_as_new(self):
        white=lambda i,p:i==1 and p.insert_text((72,400),'pre-existing white note',fontsize=11,color=(1,1,1))
        r=run(build([P1,P2E,P3],extra=white),src=build([P1,P2,P3],extra=white))
        self.assertEqual(r['status'],'passed',bad(r))

class UneditedPages(unittest.TestCase):
    def test_visual_corruption_fails_with_output_page(self):
        box=lambda i,p:i==2 and p.draw_rect(pymupdf.Rect(70,90,300,110),color=None,fill=(0,0,0))
        r=run(build([P1,P2E,P3],extra=box))
        self.assertEqual(r['status'],'failed');self.assertEqual(status(r,'unedited_render'),('failed',[3]))
    def test_text_change_fails(self):
        r=run(build([P1,P2E,[HEAD,'Third page body text is touched by the editor.','Footer 3']]))
        self.assertEqual(status(r,'unedited_text'),('failed',[3]));self.assertEqual(r['status'],'failed')
    def test_geometry_change_fails(self):
        out=build([P1,P2E,P3]);d=pymupdf.open(stream=out,filetype='pdf');d[0].set_rotation(90)
        self.assertEqual(status(run(d.tobytes()),'unedited_geometry'),('failed',[1]))
    def test_small_recolor_of_page_number_fails(self):
        num=lambda red:(lambda i,p:i==2 and p.insert_text((290,800),'3',fontsize=10,color=(1,0,0) if red else (0,0,0)))
        r=run(build([P1,P2E,P3],extra=num(True)),src=build([P1,P2,P3],extra=num(False)))
        self.assertEqual(status(r,'unedited_render'),('failed',[3]))

class HiddenText(unittest.TestCase):
    def diag(self,extra,code,overall='warning'):
        r=run(build([P1,P2E,P3],extra=lambda i,p:i==1 and extra(p)))
        self.assertEqual(status(r,code),('warning',[2]));self.assertEqual(r['status'],overall)
        return r
    def test_white(self):self.diag(lambda p:p.insert_text((72,400),'hidden white words',fontsize=11,color=(1,1,1)),'hidden_text_white')
    def test_invisible(self):self.diag(lambda p:p.insert_text((72,400),'hidden invisible words',fontsize=11,render_mode=3),'hidden_text_invisible')
    def test_covered(self):
        # The heuristic stays a diagnostic warning, but this rectangle whites out the edited line itself, which the
        # regional comparison now proves (raster outside the selected region and lost ink): a definite failure.
        r=self.diag(lambda p:p.draw_rect(pymupdf.Rect(70,85,560,100),color=None,fill=(1,1,1)),'hidden_text_covered','failed')
        self.assertEqual(status(r,'edited_page_render'),('failed',[2]));self.assertEqual(status(r,'edited_region_visible'),('failed',[2]))
    def test_cover_away_from_text_stays_diagnostic(self):
        # A white fill over already-white source text changes no pixel: still only the heuristic warning, download kept.
        note=lambda p:p.insert_text((72,400),'note',fontsize=11,color=(1,1,1))
        r=run(build([P1,P2E,P3],extra=lambda i,p:i==1 and (note(p),p.draw_rect(pymupdf.Rect(70,390,200,405),color=None,fill=(1,1,1)))),
            src=build([P1,P2,P3],extra=lambda i,p:i==1 and note(p)))
        self.assertEqual(status(r,'hidden_text_covered'),('warning',[2]));self.assertNotEqual(r['status'],'failed',bad(r))

class PageMap(unittest.TestCase):
    def test_missing_map_equal_counts_assumes_identity_as_warning(self):
        r=run(build([P1,P2E,P3]),page_map=None)
        self.assertEqual(status(r,'page_map')[0],'warning');self.assertIn(q.LIMITATIONS['page_map_assumed'],r['limitations'])
        self.assertEqual(r['status'],'warning')
        box=lambda i,p:i==2 and p.draw_rect(pymupdf.Rect(70,90,300,110),color=None,fill=(0,0,0))
        r=run(build([P1,P2E,P3],extra=box),page_map=None)
        self.assertEqual(status(r,'unedited_render'),('warning',[3]),'assumed mapping never gates');self.assertEqual(r['status'],'warning')
    def test_bad_duplicate_and_wrong_count_maps_are_not_trusted(self):
        out=build([P1,P2E,P3])
        maps=[[ident(3)[0],ident(3)[0],ident(3)[2]],ident(2),ident(4),[{'sourcePageIndex':0,'outputPageIndex':0,'continuationPageIndices':[1]},*ident(3)[1:]],
            [{**ident(3)[0],'continuationPageIndices':[1]},{'sourcePageIndex':1,'outputPageIndex':2,'continuationPageIndices':[]},{'sourcePageIndex':2,'outputPageIndex':3,'continuationPageIndices':[]}],
            ['C:/x'],'nope']
        for m in maps:
            with self.subTest(m=m):
                r=run(out,page_map=m);self.assertEqual(status(r,'page_map')[0],'warning');self.assertNotEqual(r['status'],'passed')
    def test_missing_map_with_added_page_leaves_unedited_unchecked(self):
        out=build([P1,P2E,[HEAD,'continued'],P3])
        r=run(out,page_map=None,count={'source':3,'output':4})
        self.assertEqual(status(r,'unedited_text')[0],'unavailable');self.assertEqual(r['status'],'warning')
        self.assertIn(q.LIMITATIONS['page_map_unusable'],r['limitations'])
    def test_reported_page_count_is_compared_not_trusted(self):
        r=run(build([P1,P2E,P3]),count={'source':3,'output':4});self.assertEqual(status(r,'page_count')[0],'warning')
        r=q.verify_pdf_quality(SRC,build([P1,P2E,P3]),EDITS,ident(3))
        self.assertEqual(r['status'],'passed');self.assertNotIn('page_count',[c['code'] for c in r['checks']],'no reported count, no claim')
    def test_bool_indices_rejected(self):
        m=[{'sourcePageIndex':False,'outputPageIndex':False,'continuationPageIndices':[]},*ident(3)[1:]]
        self.assertEqual(status(run(build([P1,P2E,P3]),page_map=m),'page_map')[0],'warning')
        m=[ident(3)[0],{'sourcePageIndex':1,'outputPageIndex':1,'continuationPageIndices':[True]},{'sourcePageIndex':2,'outputPageIndex':2,'continuationPageIndices':[]}]
        self.assertEqual(status(run(build([P1,P2E,[],P3][:3]),page_map=m),'page_map')[0],'warning')

class EditedText(unittest.TestCase):
    def test_missing_after_fails_when_before_extractable(self):
        r=run(build([P1,[HEAD,'We observe that the outcome may hold under mild conditions here.',*P2[2:]],P3]))
        self.assertEqual(status(r,'edited_after_present'),('failed',[2]));self.assertEqual(r['status'],'failed')
    def test_unextractable_before_is_warning(self):
        r=run(build([P1,P2,P3]),edits=[{'pageIndex':1,'before':'text MuPDF cannot see','after':'other text it cannot see'}])
        self.assertEqual(status(r,'edited_after_present')[0],'warning');self.assertEqual(status(r,'edited_text_order')[0],'warning')
        self.assertEqual(r['status'],'warning')
    def test_original_text_loss_fails(self):
        r=run(build([P1,P2E[:2]+[P2E[3]],P3]))
        self.assertEqual(status(r,'edited_text_order'),('failed',[2]))
    def test_reordered_text_is_warning(self):
        r=run(build([P1,[HEAD,P2E[2],P2E[1],P2E[3]],P3]))
        self.assertEqual(status(r,'edited_text_order')[0],'warning');self.assertEqual(r['status'],'warning')
    def test_residual_before_is_warning(self):
        r=run(build([P1,P2E+['the result holds'],P3]))
        self.assertEqual(status(r,'edited_before_removed')[0],'warning')
        # The extra line is also new unselected ink on the edited page: the regional raster proves it.
        self.assertEqual(status(r,'edited_page_render'),('failed',[2]))

class Continuation(unittest.TestCase):
    # Continued edited pages are outside the regional same-placement comparison: the regional codes are honest
    # warnings (regional_partial), so these formerly 'passed' cases are now 'warning' but never 'failed'.
    PM=[ident(1)[0],{'sourcePageIndex':1,'outputPageIndex':1,'continuationPageIndices':[2]},{'sourcePageIndex':2,'outputPageIndex':3,'continuationPageIndices':[]}]
    def test_multiline_continuation_with_copied_header_footer_is_not_failed(self):
        out=build([P1,[HEAD,'We observe that the result fails under mild','Footer 2'],[HEAD,'conditions here.',P2E[2],'Footer 2.1'],P3])
        r=run(out,page_map=self.PM,count={'source':3,'output':4})
        self.assertEqual(r['status'],'warning',bad(r));self.assertEqual(status(r,'continuation_pages')[0],'passed')
        self.assertEqual(set(bad(r)),set(q.REGIONAL),'only the regional partial coverage is uncertain')
        self.assertIn(q.LIMITATIONS['continuation'],r['limitations'])
        self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
    def test_text_lost_across_continuation_fails(self):
        out=build([P1,[HEAD,'We observe that the result fails under mild','Footer 2'],[HEAD,'conditions here.','Footer 2.1'],P3])
        r=run(out,page_map=self.PM,count={'source':3,'output':4});self.assertEqual(status(r,'edited_text_order'),('failed',[2,3]))
    def test_empty_continuation_is_warning(self):
        out=build([P1,P2E,[],P3]);r=run(out,page_map=self.PM,count={'source':3,'output':4})
        self.assertEqual(status(r,'continuation_pages'),('warning',[3]));self.assertEqual(r['status'],'warning')
    def test_long_after_crossing_copied_header_footer_is_not_a_false_failure(self):
        edits=[{'pageIndex':1,'before':'the result holds under mild conditions here','after':'the result may hold under mild conditions here'}]
        out=build([P1,[HEAD,'We observe that the result may hold under','Footer 2'],[HEAD,'mild conditions here.',P2E[2],'Footer 2.1'],P3])
        r=run(out,edits=edits,page_map=self.PM,count={'source':3,'output':4})
        self.assertEqual(r['status'],'warning',bad(r));self.assertEqual(set(bad(r)),set(q.REGIONAL))
        out=build([P1,[HEAD,'We observe that the result may hold under','Unrecognized running line'],[HEAD,'mild conditions here.',P2E[2],'Footer 2.1'],P3])
        r=run(out,edits=edits,page_map=self.PM,count={'source':3,'output':4})
        self.assertEqual(status(r,'edited_after_present'),('warning',[2,3]),'interleaved but complete After is ambiguous, not failed')
        out=build([P1,[HEAD,'We observe that','Footer 2'],[HEAD,P2E[2],'Footer 2.1'],P3])
        r=run(out,edits=edits,page_map=self.PM,count={'source':3,'output':4})
        self.assertEqual(status(r,'edited_after_present')[0],'failed','After mostly absent is definite')

class Robustness(unittest.TestCase):
    def test_unreadable_output_fails_and_unreadable_source_unavailable(self):
        self.assertEqual(status(run(b'%PDF-1.7 not really'),'output_readable') if False else q.verify_pdf_quality(SRC,b'garbage',EDITS,ident(3))['status'],'failed')
        self.assertEqual(q.verify_pdf_quality(b'garbage',build([P1,P2E,P3]),EDITS,ident(3))['status'],'unavailable')
    def test_sanitize_rejects_text_paths_and_unknown_codes(self):
        good=run(build([P1,P2E,P3]))
        for mutate in [lambda r:r.update(method='C:/Users/x/paper.pdf'),lambda r:r['checks'].append({'code':'free text','status':'passed','pages':[]}),
                lambda r:r['checks'][0].update(pages=[0]),lambda r:r['limitations'].append('the result holds'),lambda r:r.update(status='passed',checks=[{'code':'engine','status':'failed','pages':[]}]),
                lambda r:r['checks'][0].update(detail='doc text'),lambda r:r.update(schema='x')]:
            r=json.loads(json.dumps(good));mutate(r);s=q.sanitize(r)
            if s['status']!='unavailable':self.assertNotIn('doc text',json.dumps(s))
            else:self.assertEqual(s,q.unavailable())
        self.assertEqual(q.sanitize(None)['status'],'unavailable')
    def test_isolated_subprocess_real_files(self):
        with tempfile.TemporaryDirectory() as t:
            s,o=Path(t)/'source.pdf',Path(t)/'output.pdf';s.write_bytes(SRC);o.write_bytes(build([P1,P2E,P3]))
            r=q.inspect_isolated(s,o,EDITS,ident(3),{'source':3,'output':3})
            self.assertEqual(r['status'],'passed',r);self.assertNotIn(t.lower(),json.dumps(r).lower())
            self.assertEqual(status(r,'edited_page_render'),('passed',[]),'regional module loaded in the -I child')
    def test_isolated_failures_are_unavailable_never_passed(self):
        def timeout(argv,**kw):raise subprocess.TimeoutExpired(argv,kw['timeout'])
        calls=[]
        def capture(argv,**kw):calls.append((argv,kw));return SimpleNamespace(returncode=0,stdout=b'{"schema":"falsify.pdf-quality.v1","status":"passed"}\n')
        for runner in [timeout,capture,lambda a,**k:SimpleNamespace(returncode=1,stdout=b''),lambda a,**k:SimpleNamespace(returncode=0,stdout=b'x'*(q.LIMITS['maxStdoutBytes']+1)),
                lambda a,**k:(_ for _ in ()).throw(OSError())]:
            self.assertEqual(q.inspect_isolated('C:/s.pdf','C:/o.pdf',EDITS,None,runner=runner),q.unavailable())
        argv,kw=calls[0];self.assertEqual(argv[:2],[sys.executable,'-I']);self.assertEqual(argv[-1],'--worker')
        self.assertEqual(kw['timeout'],q.LIMITS['timeoutSeconds']);self.assertNotIn('NODE_OPTIONS',kw['env'])

if __name__=='__main__':unittest.main()

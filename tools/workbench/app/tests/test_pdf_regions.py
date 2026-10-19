"""Regional edited-page QA (pdf_regions via pdf_quality) on synthetic in-memory PDFs; no private documents, no Node,
no server, no network. The edited line is drawn as three runs so the selected word can be styled on its own."""
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
LOCAL=Path(__file__).resolve().parents[1]/'local'
sys.path.insert(0,str(LOCAL))
import pdf_quality as q
import pymupdf

W,H=595,842
PM=[{'sourcePageIndex':0,'outputPageIndex':0,'continuationPageIndices':[]}]
EDITS=[{'pageIndex':0,'before':'valid','after':'false'}]
PREFIX='The study supports '
X=72+pymupdf.get_text_length(PREFIX,fontname='cour',fontsize=11)
WORD_W=pymupdf.get_text_length('valid',fontname='cour',fontsize=11)
SECRETS=['Synthetic','study','supports','valid','findings','Neighbor','research']

def build(word='valid',font='cour',size=11,color=(0,0,0),mode=0,head_dy=0,neighbor='Neighbor text must remain unchanged.',ncolor=(0,0,0),extra=None,reflow=False,nfont='cour',nx=72,nsize=11):
    d=pymupdf.open();p=d.new_page(width=W,height=H)
    p.insert_text((72,50+head_dy),'Synthetic research control header',fontname='cour',fontsize=11)
    p.insert_text((72,100),PREFIX,fontname='cour',fontsize=11)
    p.insert_text((X,100),word,fontname=font,fontsize=size,color=color,render_mode=mode)
    tail=' findings under stated conditions.'
    if reflow:p.insert_text((72,112),tail.strip(),fontname='cour',fontsize=11)
    else:p.insert_text((X+pymupdf.get_text_length(word,fontname='cour',fontsize=11),100),tail,fontname='cour',fontsize=11)
    p.insert_text((nx,132),neighbor,fontname=nfont,fontsize=nsize,color=ncolor)
    p.draw_rect(pymupdf.Rect(72,180,250,240),color=(0,0,0),width=1)
    if extra:extra(p)
    return d.tobytes()

SRC=build()
def plan_for(src=SRC,edits=EDITS):
    regions=q._regions();doc=pymupdf.open(stream=src,filetype='pdf')
    return regions.build_plan(doc,pymupdf,hashlib.sha256(src).hexdigest(),edits,q.LIMITS['maxTraceChars'])[0]
def run(out,src=SRC,edits=EDITS,plan=None,pm=PM,count=None):
    n=pymupdf.open(stream=out,filetype='pdf').page_count
    return q.verify_pdf_quality(src,out,edits,pm,count or {'source':1,'output':n},edit_plan=plan)
def status(r,code):return next((c['status'] for c in r['checks'] if c['code']==code),None)
def bad(r):return {c['code']:c['status'] for c in r['checks'] if c['status']!='passed'}

class Loading(unittest.TestCase):
    def test_regions_module_is_loaded_by_absolute_sibling_path(self):
        m=q._regions();self.assertIsNotNone(m);self.assertEqual(Path(m.__file__).resolve(),LOCAL/'pdf_regions.py')

class SamePosition(unittest.TestCase):
    def test_ordinary_same_position_wording_edit_passes_and_source_is_untouched(self):
        before=hashlib.sha256(SRC).hexdigest();out=build('false')
        r=run(out,plan=plan_for())
        self.assertEqual(r['status'],'passed',bad(r))
        for code in (*q.REGIONAL,'edit_plan'):self.assertEqual(status(r,code),'passed',code)
        self.assertEqual(hashlib.sha256(SRC).hexdigest(),before);self.assertEqual(pymupdf.open(stream=out,filetype='pdf')[0].get_text().count('false'),1)
    def test_selected_after_red_size_or_font_fails(self):
        # Helvetica has a different font name AND advances that the source's own Courier glyphs disprove: definite.
        for kw in [{'color':(1,0,0)},{'size':13},{'font':'helv'}]:
            with self.subTest(**kw):
                r=run(build('false',**kw))
                self.assertEqual(status(r,'edited_region_style'),'failed',bad(r));self.assertEqual(r['status'],'failed')
    def test_font_name_mismatch_alone_is_unverified_warning(self):
        # Like an engine's supplemental glyph fallback: same size, color and advances under another font name.
        r=run(build('false',font='cobo'),plan=plan_for())
        self.assertEqual(status(r,'edited_region_style'),'warning',bad(r));self.assertEqual(r['status'],'warning',bad(r))
        self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
        for kw in [{'color':(1,0,0)},{'size':13}]:
            with self.subTest(**kw):
                r=run(build('false',font='cobo',**kw))
                self.assertEqual(status(r,'edited_region_style'),'failed',bad(r));self.assertEqual(r['status'],'failed')
    def test_kept_text_font_name_mismatch_is_warning_but_raster_still_fails(self):
        r=run(build('false',nfont='cobo'))
        self.assertEqual(status(r,'edited_page_text'),'warning',bad(r))
        self.assertEqual(status(r,'edited_page_render'),'failed','the bolder neighbor is measured outside the sealed region')
        r=run(build('false',nfont='cobo',ncolor=(1,0,0)));self.assertEqual(status(r,'edited_page_text'),'failed',bad(r))
    def test_invisible_after_fails(self):
        r=run(build('false',mode=3));self.assertEqual(status(r,'edited_region_visible'),'failed',bad(r));self.assertEqual(r['status'],'failed')

class OutsideSelection(unittest.TestCase):
    def check(self,out,*codes):
        r=run(out,plan=plan_for())
        self.assertEqual(r['status'],'failed',bad(r))
        for code in codes:self.assertEqual(status(r,code),'failed',(code,bad(r)))
        return r
    def test_nearby_paragraph_recolor_and_damage_fail(self):
        self.check(build('false',ncolor=(1,0,0)),'edited_page_text','edited_page_render')
        self.check(build('false',neighbor='Neighbor text must remain unchanged!'),'edited_page_render')
    def test_moved_header_fails(self):self.check(build('false',head_dy=2),'edited_page_text','edited_page_render')
    def test_figure_damage_fails(self):
        self.check(build('false',extra=lambda p:p.draw_line(pymupdf.Point(80,190),pymupdf.Point(240,230),color=(1,0,0),width=3)),'edited_page_render')
    def test_white_cover_on_same_edited_line_unselected_area_fails(self):
        # Over 'study' on the edited line: the old whole-line exclusion hid this; the tight source region does not.
        cover=lambda p:p.draw_rect(pymupdf.Rect(72+4*6.6,88,72+10*6.6,103),color=None,fill=(1,1,1))
        self.check(build('false',extra=cover),'edited_page_render','edited_region_visible')
    def test_graphic_just_outside_sealed_region_on_same_line_fails(self):
        # Inside the blank gap right after the selected word, beyond the fixed BLEED.
        tick=lambda p:p.draw_rect(pymupdf.Rect(X+WORD_W+1.8,94,X+WORD_W+3.2,98),color=None,fill=(1,0,0))
        self.check(build('false',extra=tick),'edited_page_render')
    def test_forged_page_sized_plan_is_ignored(self):
        forged=plan_for();forged['edits'][0]['regions']=[[0,0,W,H]]
        r=run(build('false'),plan=forged);self.assertEqual(status(r,'edit_plan'),'warning');self.assertEqual(r['status'],'warning')
        r=run(build('false',extra=lambda p:p.draw_line(pymupdf.Point(80,190),pymupdf.Point(240,230),color=(1,0,0),width=3)),plan=forged)
        self.assertEqual(status(r,'edited_page_render'),'failed','a forged plan never widens the exclusion')

class Plans(unittest.TestCase):
    def test_plan_cross_check(self):
        own=plan_for();out=build('false')
        renamed=copy.deepcopy(own);renamed['edits'][0]['id']='client-label'
        conservative=copy.deepcopy(own);conservative['status']='unavailable';conservative['edits'][0].update(status='ambiguous',regions=[],styles=[])
        self.assertEqual(status(run(out,plan=renamed),'edit_plan'),'passed','caller ids are labels only')
        self.assertEqual(status(run(out,plan=conservative),'edit_plan'),'passed','a more conservative plan is consistent')
        def mutate(f):p=copy.deepcopy(own);f(p);return p
        malformed=['x',{},[own],mutate(lambda p:p.update(sourceSha256='0'*64)),mutate(lambda p:p['edits'].append(p['edits'][0])),
            mutate(lambda p:p['edits'][0].update(regions=[[1,2,'3',4]])),mutate(lambda p:p['edits'][0].update(regions=[[5,5,1,1]])),
            mutate(lambda p:p['edits'][0].update(afterSha256='f'*64)),mutate(lambda p:p['edits'][0]['styles'][0].update(color=0xFF0000)),
            mutate(lambda p:p['edits'][0].update(status='resolved',regions=p['edits'][0]['regions']*2)),mutate(lambda p:p.update(policy='other'))]
        for plan in malformed:
            with self.subTest(plan=str(plan)[:60]):
                r=run(out,plan=plan);self.assertEqual(status(r,'edit_plan'),'warning');self.assertNotEqual(r['status'],'passed')
        self.assertIsNone(status(run(out),'edit_plan'),'no plan supplied, no plan claim')
    def test_edits_without_ids_are_numbered_internally(self):
        plan=plan_for();self.assertEqual([e['id'] for e in plan['edits']],['edit-1'])
    def test_repeated_anchor_is_warning_not_guessed(self):
        neighbor='Neighbor valid text stays.'
        src=build(neighbor=neighbor);r=run(build('false',neighbor=neighbor),src=src)
        self.assertEqual(plan_for(src)['edits'][0]['status'],'ambiguous')
        for code in q.REGIONAL:self.assertEqual(status(r,code),'warning')
        self.assertEqual(r['status'],'warning',bad(r))

class Partial(unittest.TestCase):
    def test_longer_after_is_partial_warning(self):
        edits=[{'pageIndex':0,'before':'valid','after':'not valid'}]
        r=run(build('not valid'),edits=edits);self.assertEqual(r['status'],'warning',bad(r))
        self.assertEqual(status(r,'edited_page_render'),'warning');self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
        r=run(build('not valid',extra=lambda p:p.draw_line(pymupdf.Point(80,190),pymupdf.Point(240,230),color=(1,0,0),width=3)),edits=edits)
        self.assertEqual(status(r,'edited_page_render'),'failed','damage away from the moved text is still definite')
    def test_reflowed_line_and_unknown_after_are_warnings(self):
        r=run(build('false',reflow=True));self.assertEqual(r['status'],'warning',bad(r))
        self.assertEqual(status(r,'edited_page_render'),'warning');self.assertEqual(status(r,'edited_region_style'),'passed')
        neighbor='Neighbor false note.'  # After also elsewhere on the page: its reflowed position is unknown
        r=run(build('false',reflow=True,neighbor=neighbor),src=build(neighbor=neighbor))
        self.assertEqual(status(r,'edited_region_style'),'warning');self.assertEqual(r['status'],'warning',bad(r))
    def test_continued_reflow_is_warning(self):
        pm=[{'sourcePageIndex':0,'outputPageIndex':0,'continuationPageIndices':[1]}]
        d=pymupdf.open(stream=build('false'),filetype='pdf');d.new_page(width=W,height=H).insert_text((72,60),'Synthetic research control header',fontname='cour',fontsize=11)
        r=run(d.tobytes(),pm=pm,count={'source':1,'output':2})
        for code in q.REGIONAL:self.assertEqual(status(r,code),'warning')
        self.assertNotEqual(r['status'],'passed');self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
    def test_budget_is_warning(self):
        old=q.LIMITS['maxTraceChars'];q.LIMITS['maxTraceChars']=10
        try:r=run(build('false'))
        finally:q.LIMITS['maxTraceChars']=old
        for code in q.REGIONAL:self.assertEqual(status(r,code),'warning')
        self.assertIn(q.LIMITATIONS['budget'],r['limitations']);self.assertEqual(r['status'],'warning')
    def test_unsupported_rotated_source_is_warning(self):
        d=pymupdf.open(stream=SRC,filetype='pdf');d[0].set_rotation(90);src=d.tobytes()
        d=pymupdf.open(stream=build('false'),filetype='pdf');d[0].set_rotation(90)
        r=run(d.tobytes(),src=src);self.assertNotIn('failed',bad(r).values(),bad(r))

class DriftNoise(unittest.TestCase):
    # An engine re-serializing the page in float32 moves an unchanged neighbor line by 1e-4 pt. On an odd 1/8 pt
    # origin that crosses MuPDF's sub-pixel glyph quantization and re-antialiases glyph edges by more than PIXEL_DELTA.
    ON,DRIFT=72.125,72.125-0.0001
    def raster_delta(self,a,b):
        pa,pb=(pymupdf.open(stream=x,filetype='pdf')[0].get_pixmap(colorspace=pymupdf.csRGB,alpha=False) for x in (a,b))
        return sum(abs(x-y)>q._regions().PIXEL_DELTA for x,y in zip(pa.samples,pb.samples))
    def test_float32_drift_of_unchanged_text_is_warning_never_pass(self):
        src=build(nx=self.ON);out=build('false',nx=self.DRIFT)
        self.assertGreater(self.raster_delta(build('false',nx=self.ON),out),0,'the drift really re-antialiases glyph edges')
        r=run(out,src=src,plan=plan_for(src))
        self.assertEqual(status(r,'edited_page_render'),'warning',bad(r));self.assertEqual(r['status'],'warning',bad(r))
        for code in ('edited_page_text','edited_region_style','edited_region_visible','edit_plan'):self.assertEqual(status(r,code),'passed',code)
        self.assertIn(q.LIMITATIONS['regional_partial'],r['limitations'])
        self.assertEqual(status(run(build('false',nx=self.ON),src=src),'edited_page_render'),'passed','no drift, nothing to explain')
    def test_drift_does_not_hide_real_changes_on_or_near_the_drifted_glyphs(self):
        src=build(nx=self.ON);g=72.125+6.6  # second neighbor glyph
        cases={'tick':dict(extra=lambda p:p.draw_rect(pymupdf.Rect(g+2,126,g+3,127),color=None,fill=(0,0,0))),
            'white_cover':dict(extra=lambda p:p.draw_rect(pymupdf.Rect(g,124,g+6.6,134),color=None,fill=(1,1,1))),
            'blank_tick':dict(extra=lambda p:p.draw_rect(pymupdf.Rect(300,150,301,151),color=None,fill=(0,0,0))),
            'figure':dict(extra=lambda p:p.draw_line(pymupdf.Point(80,190),pymupdf.Point(240,230),color=(1,0,0),width=3)),
            'recolor':dict(ncolor=(1,0,0)),'resize':dict(nsize=11.5),'face':dict(nfont='cobo'),
            'beyond_drift_tol':dict(nx=self.ON-0.05)}
        for name,kw in cases.items():
            with self.subTest(name):
                r=run(build('false',**{'nx':self.DRIFT,**kw}),src=src,plan=plan_for(src))
                self.assertEqual(status(r,'edited_page_render'),'failed',bad(r));self.assertEqual(r['status'],'failed')

class Isolation(unittest.TestCase):
    def test_reports_are_sanitized_and_text_free(self):
        for out in [build('false'),build('false',color=(1,0,0)),build('not valid')]:
            r=run(out,plan=plan_for());self.assertEqual(q.sanitize(r),r);blob=json.dumps(r)
            for word in SECRETS:self.assertNotIn(word,blob)
    def test_isolated_child_runs_regional_logic(self):
        with tempfile.TemporaryDirectory() as t:
            s,o=Path(t)/'source.pdf',Path(t)/'output.pdf';s.write_bytes(SRC)
            o.write_bytes(build('false'))
            r=q.inspect_isolated(s,o,EDITS,PM,{'source':1,'output':1},edit_plan=plan_for())
            self.assertEqual(r['status'],'passed',r);self.assertEqual(status(r,'edit_plan'),'passed')
            for code in q.REGIONAL:self.assertEqual(status(r,code),'passed',r)
            self.assertNotIn(t.lower(),json.dumps(r).lower())
            o.write_bytes(build('false',extra=lambda p:p.draw_rect(pymupdf.Rect(72+4*6.6,88,72+10*6.6,103),color=None,fill=(1,1,1))))
            r=q.inspect_isolated(s,o,EDITS,PM,{'source':1,'output':1},edit_plan={'forged':True})
            self.assertEqual(status(r,'edited_page_render'),'failed',r);self.assertEqual(status(r,'edit_plan'),'warning')
            # The child also loads its sibling with -I from an unrelated working directory and empty environment.
            request=json.dumps({'source':str(s),'output':str(o),'pageMap':PM,'pageCount':None,'edits':EDITS}).encode()
            child=subprocess.run([sys.executable,'-I',str(LOCAL/'pdf_quality.py'),'--worker'],input=request,cwd=tempfile.gettempdir(),
                env={k:os.environ[k] for k in q.ENV_ALLOW if k in os.environ},stdout=subprocess.PIPE,timeout=q.LIMITS['timeoutSeconds'])
            report=json.loads(child.stdout)
            self.assertEqual(status(report,'edited_page_render'),'failed',report)

class LigatureOrder(unittest.TestCase):
    # A ligature glyph (one origin, several ToUnicode characters) on an unedited line: the source reports its components
    # at bit-identical origins, a float re-serialized output at origins a few 1e-5 pt apart (values from the T-0071 RCA).
    STYLE=('termes',10.037,0,'Termes')
    def line(self,parts,line=1,style=STYLE):
        R=q._regions()
        return [R._Char(c,(x,295.0685,x+w,305.1055),302.675,style,line,10) for c,x,w in parts]
    SRC=[('a',342.2117,8.3627),('f',350.5743408203125,3.3424),('l',350.5743408203125,2.7903),('i',350.5743408203125,2.8112),('n',353.3855,4.9)]
    OUT=[('a',342.2116,8.3627),('f',350.5743103027344,3.3424),('l',350.5743103027344,2.7903),('i',350.57427978515625,2.8112),('n',353.3854,4.9)]
    def rows(self,chars):
        R=q._regions();return R._rows(chars)
    def test_ligature_components_keep_extraction_order_under_origin_noise(self):
        R=q._regions();S,O=self.line(self.SRC),self.line(self.OUT)
        (_,row),=self.rows(S);(_,orow),=self.rows(O)
        self.assertEqual(R._text(S,row),'aflin')
        self.assertEqual(R._text(O,orow),R._text(S,row));self.assertEqual(R._same_row(S,row,O,orow,True),'same')
    def test_reordered_or_restyled_components_still_differ(self):
        R=q._regions();S=self.line(self.SRC);(_,row),=self.rows(S)
        swapped=[self.OUT[0],self.OUT[3],self.OUT[1],self.OUT[2],self.OUT[4]]  # the output really extracts 'i' first
        O=self.line(swapped);(_,orow),=self.rows(O)
        self.assertNotEqual(R._text(O,orow),R._text(S,row));self.assertIsNone(R._same_row(S,row,O,orow,True))
        O=self.line(self.OUT,style=('termes',10.6,0,'Termes'));(_,orow),=self.rows(O)
        self.assertIsNone(R._same_row(S,row,O,orow,True),'a resized ligature is never the same row')
    def test_distinct_glyphs_and_lines_are_still_ordered_by_position(self):
        R=q._regions()
        # Extraction order disagrees with geometry beyond DRIFT_TOL: geometry still decides.
        O=self.line([('b',350.5763,3.0),('a',350.5743,3.0)]);(_,orow),=self.rows(O);self.assertEqual(R._text(O,orow),'ab')
        # Same origin but different MuPDF lines (e.g. an overprint): not a ligature, position then index order.
        O=self.line([('b',350.5743408,3.0)],line=1)+self.line([('a',350.5743103,3.0)],line=2);(_,orow),=self.rows(O)
        self.assertEqual(R._text(O,orow),'ab')

if __name__=='__main__':unittest.main()

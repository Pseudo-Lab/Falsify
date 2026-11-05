import sys,unittest,hashlib,base64,io
from pathlib import Path
import pymupdf as pdf
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from paper_evidence import EvidenceStore
from paper_visual_edit import export_visual
from test_paper_evidence import sample_pdf

def sha(data):return hashlib.sha256(data).hexdigest()
def png(color='blue',size=(80,80)):
    im=Image.new('RGBA',size,color);buf=io.BytesIO();im.save(buf,format='PNG');return buf.getvalue()
class VisualTests(unittest.TestCase):
    def setUp(self):
        self.raw=sample_pdf(pages=2);self.store=EvidenceStore();self.h=sha(self.raw);self.summary=self.store.prepare(self.raw,self.h);self.pid=self.summary['paperId']
    def request(self,ops):return {'schema':'falsify.visual-edit-request.v1','paperId':self.pid,'fileHash':self.h,'revision':'r1','operations':ops}
    def cell(self):
        meta=self.store.list_items(self.pid,kind='table')['items'][0];item=self.store.read_item(self.pid,meta['id']);c=next(c for c in item['table']['cells'] if c['text']=='1')
        return item,c,{'id':'cell','kind':'table-cell','itemId':item['id'],'row':c['row'],'column':c['column'],'before':'1','after':'-7.5'}
    def region(self,bbox=None,page=0,raw=None):
        bbox=bbox or [90,350,130,390];before=self.store.render_region(self.pid,page,bbox=bbox,dpi=150)
        return {'id':'figure','kind':'region','assetKind':'figure','pageIndex':page,'bbox':bbox,'beforeImageSha256':before['sha256'],'png':base64.b64encode(raw or png()).decode()}
    def assertOutsideSame(self,output,rect,page=0):
        with pdf.open(stream=self.raw,filetype='pdf') as a,pdf.open(stream=output,filetype='pdf') as b:
            x=a[page].get_pixmap(alpha=False);y=b[page].get_pixmap(alpha=False);self.assertEqual((x.width,x.height),(y.width,y.height))
            # Pixel centers outside the selected region must remain identical.
            xs,ys=x.samples,y.samples
            for j in range(x.height):
                for i in range(x.width):
                    if rect[0]-.5<=i<=rect[2]+.5 and rect[1]-.5<=j<=rect[3]+.5:continue
                    k=(j*x.width+i)*3
                    if max(abs(a-b) for a,b in zip(xs[k:k+3],ys[k:k+3]))>2:self.fail('Outside changed beyond 2/255 raster rounding at '+str((i,j)))
            self.assertEqual(a[1].get_pixmap().samples,b[1].get_pixmap().samples)
    def test_native_cell_is_real_pdf_text_and_other_cells_rules_pages_stay(self):
        item,c,op=self.cell();res=export_visual(self.request([op]),store=self.store);out=base64.b64decode(res['file'])
        self.assertEqual(res['outputSha256'],sha(out));self.assertEqual(res['changes'][0]['before'],'1');self.assertEqual(res['changes'][0]['after'],'-7.5');self.assertEqual(res['changes'][0]['author'],'human')
        with pdf.open(stream=out,filetype='pdf') as d:
            self.assertEqual(len(d),2);text=d[0].get_text();self.assertIn('-7.5',text);self.assertIn('Metric',text);self.assertIn('Groups',text)
        self.assertOutsideSame(out,c['bbox']);self.assertEqual(self.store.source_bytes(self.pid,self.h),self.raw)
        with pdf.open(stream=self.raw,filetype='pdf') as a,pdf.open(stream=out,filetype='pdf') as b:
            spans=lambda p:[s for block in p.get_text('dict',clip=pdf.Rect(c['bbox']))['blocks'] for line in block.get('lines',[]) for s in line.get('spans',[]) if s['text'].strip()]
            self.assertAlmostEqual(spans(a[0])[0]['origin'][1],spans(b[0])[0]['origin'][1],delta=.2)
    def test_partial_low_resolution_figure_keeps_surrounding_pixels(self):
        op=self.region();res=export_visual(self.request([op]),store=self.store);out=base64.b64decode(res['file']);self.assertOutsideSame(out,op['bbox'])
        with pdf.open(stream=out,filetype='pdf') as d:self.assertEqual(d[0].get_pixmap().pixel(110,370),(0,0,255))
    def test_shared_image_other_occurrence_is_unchanged(self):
        d=pdf.open(stream=self.raw,filetype='pdf');xref=d[0].get_images()[0][0];d[1].insert_image(pdf.Rect(72,336,160,420),xref=xref)
        self.raw=d.tobytes();d.close();self.h=sha(self.raw);self.pid=self.store.prepare(self.raw,self.h)['paperId']
        op=self.region();out=base64.b64decode(export_visual(self.request([op]),store=self.store)['file']);self.assertOutsideSame(out,op['bbox'])
    def test_rotated_region_matches_selected_view_coordinates(self):
        self.raw=sample_pdf(rotate=90,pages=2);self.h=sha(self.raw);self.pid=self.store.prepare(self.raw,self.h)['paperId']
        with pdf.open(stream=self.raw,filetype='pdf') as d:rect=list(pdf.Rect(90,350,130,390)*d[0].rotation_matrix)
        op=self.region(rect);out=base64.b64decode(export_visual(self.request([op]),store=self.store)['file'])
        with pdf.open(stream=out,filetype='pdf') as d:self.assertEqual(d[0].get_pixmap().pixel(round((rect[0]+rect[2])/2),round((rect[1]+rect[3])/2)),(0,0,255))
    def test_graph_data_changes_are_recorded_outside_pdf_content(self):
        op=self.region();op['assetKind']='graph';op['dataChanges']={'before':{'y':1.25},'after':{'y':-2.5}}
        res=export_visual(self.request([op]),store=self.store);self.assertEqual(res['changes'][0]['dataChanges'],op['dataChanges'])
        with pdf.open(stream=base64.b64decode(res['file']),filetype='pdf') as d:self.assertNotIn('dataChanges',d[0].get_text());self.assertNotIn('human',d[0].get_text())
    def test_region_removes_old_native_text_for_blue(self):
        op=self.region([65,310,250,334]);res=export_visual(self.request([op]),store=self.store)
        with pdf.open(stream=base64.b64decode(res['file']),filetype='pdf') as d:self.assertNotIn('Figure 1. Mark',d[0].get_text())
    def test_wrong_image_and_file_hashes_do_not_export(self):
        op=self.region();op['beforeImageSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'image_mismatch'):export_visual(self.request([op]),store=self.store)
        req=self.request([self.region()]);req['fileHash']='0'*64
        with self.assertRaises(ValueError):export_visual(req,store=self.store)
    def test_merged_cell_and_blank_deletion_and_overlap(self):
        item,c,op=self.cell();op['after']='';res=export_visual(self.request([op]),store=self.store)
        with pdf.open(stream=base64.b64decode(res['file']),filetype='pdf') as d:self.assertNotIn('1',d[0].get_text('text',clip=pdf.Rect(c['bbox'])))
        a=self.region();b={**a,'id':'other'}
        with self.assertRaisesRegex(ValueError,'overlap'):export_visual(self.request([a,b]),store=self.store)
    def test_transparent_replacement_renders_on_white(self):
        raw=png((255,0,0,128));op=self.region(raw=raw);res=export_visual(self.request([op]),store=self.store)
        with pdf.open(stream=base64.b64decode(res['file']),filetype='pdf') as d:
            r,g,b=d[0].get_pixmap().pixel(110,370);self.assertGreater(r,250);self.assertTrue(120<=g<=135);self.assertTrue(120<=b<=135)
    def test_rotated_cell_uses_source_orientation(self):
        self.raw=sample_pdf(rotate=90,pages=2);self.h=sha(self.raw);self.summary=self.store.prepare(self.raw,self.h);self.pid=self.summary['paperId'];item,c,op=self.cell()
        res=export_visual(self.request([op]),store=self.store)
        with pdf.open(stream=base64.b64decode(res['file']),filetype='pdf') as d:self.assertEqual(d[0].rotation,90);self.assertIn('-7.5',d[0].get_text())
    def test_noop_cell_keeps_exact_source_bytes(self):
        item,c,op=self.cell();op['after']=op['before']
        result=export_visual(self.request([op]),store=self.store)
        self.assertEqual(base64.b64decode(result['file']),self.raw)
        self.assertEqual(result['changes'],[])
        self.assertEqual(result['verification']['status'],'passed')

    def test_saved_output_damage_outside_region_is_reported(self):
        from paper_chart_edit_service import _verify_output
        op=self.region();result=export_visual(self.request([op]),store=self.store)
        output=base64.b64decode(result['file'])
        with pdf.open(stream=output,filetype='pdf') as doc:
            doc[1].insert_text((50,50),'damage')
            damaged=doc.tobytes()
        issues=_verify_output(self.raw,damaged,None,regions=[(0,op['bbox'])])
        self.assertTrue(any(i['code']=='outside-region-pixels-changed' and i['pageIndex']==1 for i in issues))
        self.assertTrue(any(i['code']=='source-text-changed' and i['pageIndex']==1 for i in issues))

    def test_shape_only_checks_final_cumulative_bytes(self):
        from unittest.mock import patch
        from paper_visual_edit import _export_visual_native
        with pdf.open(stream=self.raw,filetype='pdf') as doc:
            doc[1].insert_text((50,50),'damage')
            damaged=doc.tobytes()
        result={'file':base64.b64encode(damaged).decode(), 'changes':[{'pageIndex':0,'bbox':[90,350,130,390]}], 'verification':{'issues':[]}}
        op={'id':'shape','kind':'chart-shape','plan':{'paperId':self.pid,'fileHash':self.h}}
        with patch('paper_chart_edit_service.default_service.export',return_value=result):
            exported=_export_visual_native(self.request([op]),store=self.store)
        self.assertEqual(exported['verification']['status'],'warning')
        self.assertIn('outside-region-pixels',exported['verification']['checks'])
        self.assertTrue(any(i['code']=='outside-region-pixels-changed' for i in exported['verification']['issues']))
        self.assertEqual(base64.b64decode(exported['file']),damaged)

    def test_saved_image_check_is_reported(self):
        result=export_visual(self.request([self.region()]),store=self.store)
        self.assertIn('saved-image-render',result['verification']['checks'])
        self.assertFalse(any(i['code']=='saved-image-unconfirmed' for i in result['verification']['issues']))

    def test_verification_failure_is_downloadable_and_warns(self):
        from unittest.mock import patch
        from paper_visual_edit import _export_visual_native
        import paper_native_worker
        real_run=paper_native_worker.run
        def fail_verify(operation,args,**kwargs):
            if operation=='verify': raise RuntimeError('failure')
            return real_run(operation,args,**kwargs)
        with patch('paper_native_worker.run',side_effect=fail_verify):
            result=_export_visual_native(self.request([self.region()]),store=self.store)
        self.assertEqual(result['verification']['status'],'warning')
        self.assertEqual(result['verification']['issues'][-1]['code'],'source-preservation-check-failed')
        self.assertTrue(base64.b64decode(result['file']).startswith(b'%PDF-'))

    def test_unfittable_cell_keeps_source_and_has_no_partial_export(self):
        item,c,op=self.cell();op['after']='A'*4000
        with self.assertRaisesRegex(ValueError,'no_room'):export_visual(self.request([op]),store=self.store)
        self.assertEqual(self.store.source_bytes(self.pid,self.h),self.raw)
if __name__=='__main__':unittest.main()

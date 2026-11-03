import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from paper_evidence import EvidenceStore
from paper_digitizer import digitize
from paper_chart import extract_chart
from test_paper_evidence import sample_pdf,sha


class DigitizerTests(unittest.TestCase):
    def setUp(self):
        self.store=EvidenceStore();self.pdf=sample_pdf();self.hash=sha(self.pdf)
        self.id=self.store.prepare(self.pdf,self.hash)['paperId']
        self.image=self.store.render_region(self.id,0,bbox=[0,0,300,300],dpi=120)
        self.axes={'x':{'scale':'linear','points':[{'pixel':100,'value':1},{'pixel':400,'value':4}]},
                   'y':{'scale':'log','points':[{'pixel':400,'value':10},{'pixel':100,'value':1000}]}}
    def run_points(self,points,**kwargs):
        return digitize(self.store,self.id,self.hash,0,self.image['sha256'],self.axes,points,bbox=[0,0,300,300],**kwargs)
    def test_linear_log_reversed_axis_and_precision(self):
        result=self.run_points([[100,400],[250,250],[400,100]])
        numbers=result['data']['numericCells']
        self.assertEqual([n['value'] for n in numbers],[1,10,2.5,100,4,1000])
        self.assertTrue(all(n['origin']=='pixel-calibrated' for n in numbers))
        self.assertLess(numbers[3]['pixelInterval'][0],100)
        self.assertGreater(numbers[3]['pixelInterval'][1],100)
        self.assertEqual(self.run_points([[100,400],[250,250],[400,100]])['analysisId'],result['analysisId'])
    def test_exact_source_image_binding(self):
        with self.assertRaisesRegex(ValueError,'image_mismatch'):
            digitize(self.store,self.id,self.hash,0,'0'*64,self.axes,[[100,100]],bbox=[0,0,300,300])
        self.assertEqual(self.store.list_analyses(self.id)['items'],[])
    def test_invalid_and_outside_pixels(self):
        for bad in ([[float('nan'),1]],[[-1,20]],[[99999,1]],[]):
            with self.assertRaises(ValueError):self.run_points(bad)
        self.axes['y']['points'][0]['value']=0
        with self.assertRaises(ValueError):self.run_points([[100,100]])
    def test_deplot_title_does_not_become_series_header(self):
        import base64
        png=base64.b64decode(self.image['data'])
        raw='TITLE | A test <0x0A> Time | Measured <0x0A> 1 | 10'
        result=extract_chart(png,engine=lambda *_:raw)
        self.assertEqual(result['title'],'A test')
        self.assertEqual(result['columns'],['Time','Measured'])
        self.assertEqual(result['rows'],[['1','10']])
        self.assertEqual(result['rawOutput'],raw)


if __name__=='__main__':unittest.main()

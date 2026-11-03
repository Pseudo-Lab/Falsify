import io,sys,types,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import paper_ocr as ocr

class OrientationTests(unittest.TestCase):
    def image(self):
        b=io.BytesIO();Image.new('RGB',(200,100),'white').save(b,format='PNG');return b.getvalue()
    def test_classifier_votes_do_not_use_recognition_confidence(self):
        lines=[{'text':'word','bbox':[10,y,150,y+10],'confidence':1} for y in (10,30,50)]
        class Engine:
            def cls_and_rotate(self,crops):return [],types.SimpleNamespace(cls_res=[('180',.99)]*3)
        with patch.dict(sys.modules,{'rapidocr':types.ModuleType('rapidocr')}),patch.object(ocr,'_line_engine',return_value=Engine()):
            self.assertTrue(ocr._upside_down(self.image(),lines,'en'))
            lines[0]['text']='a'
            self.assertFalse(ocr._upside_down(self.image(),lines,'en'))
    def test_page_180_keeps_upright_order_and_maps_original_geometry(self):
        first=[{'text':'bottom','bbox':[10,10,100,20]}]
        upright=[{'text':'first','bbox':[10,15,100,25]},{'text':'second','bbox':[10,35,100,45]}]
        tables=[{'bbox':[10,15,100,45],'cells':[{'row':0,'column':0,'text':'A','bbox':[10,15,100,25]}]}]
        with patch.object(ocr,'_default_lines',side_effect=[(True,first,[]),(True,upright,[])]),patch.object(ocr,'_upside_down',return_value=True),patch.object(ocr,'_default_tables',return_value=(True,tables,[])):
            result=ocr.recognize(self.image())
        self.assertEqual([x['text'] for x in result['lines']],['first','second'])
        self.assertEqual(result['lines'][0]['bbox'],[100,75,190,85])
        self.assertEqual(result['tables'][0]['cells'][0]['bbox'],[100,75,190,85])
        self.assertEqual(result['transforms'][0]['angle'],180)
    def test_flip_geometry_is_its_own_inverse(self):
        original=[{'bbox':[10,20,90,70],'polygon':[[10,20],[90,70]],'cells':[{'bbox':[12,22,50,60],'row':0,'column':0,'text':'-1.2'}]}]
        self.assertEqual(ocr._flip_records(ocr._flip_records(original,200,100),200,100),original)

if __name__=='__main__':unittest.main()

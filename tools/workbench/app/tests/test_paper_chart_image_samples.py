"""Transparency and profile integration with actual PDF render/output."""
import base64,copy,hashlib,io,sys,unittest
from pathlib import Path
import numpy as np
import pikepdf,pymupdf
from PIL import Image,ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from paper_chart_scene import prepare_scene
from paper_chart_paint import export_scene
from paper_chart_image_samples import decode_image

class ImageSampleTests(unittest.TestCase):
    def test_transparent_curve_keeps_background_and_other_occurrence(self):
        im=Image.new('RGBA',(400,200),(0,0,0,0));draw=ImageDraw.Draw(im)
        draw.line([(20,160),(380,40)],fill=(20,100,185,255),width=4)
        draw.line([(20,30),(380,30)],fill=(20,100,185,255),width=4)
        b=io.BytesIO();im.save(b,format='PNG')
        doc=pymupdf.open()
        for _ in range(2):
            p=doc.new_page(width=440,height=250)
            p.draw_rect(p.rect,color=None,fill=(.96,.86,.7))
            p.insert_image(pymupdf.Rect(20,25,420,225),stream=b.getvalue())
        raw=doc.tobytes();doc.close()
        scene=prepare_scene(raw,0,[10,15,430,235])
        self.assertTrue(scene['series'])
        edited=copy.deepcopy(scene)
        s=max(edited['series'],key=lambda a:max(p['y'] for p in a['points'])-min(p['y'] for p in a['points']))
        old=copy.deepcopy(s['points'])
        for point in s['points']:
            if 140<point['x']<250:point['y']-=20
        output,report=export_scene(raw,scene,edited)
        self.assertFalse(report['noop'])
        with pikepdf.open(io.BytesIO(output)) as pdf:
            x=pdf.pages[0].Resources.XObject
            changed=next(x[k] for k in x.keys() if str(k).startswith('/ChartIm'))
            self.assertIsNotNone(changed.get('/SMask'))
            self.assertEqual(changed.SMask.Width,400)
        with pymupdf.open(stream=raw,filetype='pdf') as before,pymupdf.open(stream=output,filetype='pdf') as after:
            a=before[0].get_pixmap();b=after[0].get_pixmap()
            self.assertEqual(a.pixel(50,60),b.pixel(50,60))
            self.assertEqual(a.pixel(100,100),b.pixel(100,100))
            self.assertEqual(before[1].get_pixmap().samples,after[1].get_pixmap().samples)
            delta=np.any(np.frombuffer(a.samples,np.uint8).reshape(a.height,a.width,3)!=np.frombuffer(b.samples,np.uint8).reshape(b.height,b.width,3),axis=2)
            self.assertGreater(delta.sum(),100)
            self.assertFalse(delta[:30].any())
        self.assertEqual(export_scene(raw,scene,scene)[0],raw)

if __name__=='__main__':unittest.main()

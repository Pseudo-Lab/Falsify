import io,sys,unittest
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from paper_chart_geometry import extract_geometry,fit_axis,_value
from paper_chart import extract_chart

def fixture(dual=False,ambiguous=False,bars=False,outlier=False):
    im=Image.new('RGB',(640,480),'white');d=ImageDraw.Draw(im);font=ImageFont.load_default(size=17);lines=[]
    d.rectangle((90,30,550,400),outline='black',width=2)
    def label(text,box,color='black'):
        d.text((box[0],box[1]),text,font=font,fill=color);lines.append({'text':text,'bbox':box})
    for x,value in zip([120,240,360,480],[1,2,3,4]):label(str(value),[x-7,418,x+7,438])
    for i,(y,value) in enumerate(zip([80,160,240,320],[80,40,20,10])):
        label(str(999 if outlier and i==1 else value),[40,y-8,75,y+8], '#1f77b4' if dual and not ambiguous else 'black')
    blue=[(120,320),(240,240),(360,160),(480,80)]
    if bars:
        for x in [120,240,360,480]:d.rectangle((x-18,180,x+18,398),fill='#1f77b4')
    else:
        d.line(blue,fill='#1f77b4',width=3)
        for x,y in blue:d.ellipse((x-5,y-5,x+5,y+5),fill='#1f77b4')
    if dual:
        for y,v in zip([80,160,240,320],[12,9,6,3]):label(str(v),[565,y-8,598,y+8],'black' if ambiguous else '#d62728')
        red=[(120,350),(240,270),(360,190),(480,110)];d.line(red,fill='#d62728',width=3)
        for x,y in red:d.ellipse((x-5,y-5,x+5,y+5),fill='#d62728')
    out=io.BytesIO();im.save(out,format='PNG');return out.getvalue(),lines

class GeometryTests(unittest.TestCase):
    def test_log_calibration_and_original_pixel_provenance(self):
        png,lines=fixture();result=extract_geometry(png,lines)
        self.assertEqual(result['status'],'ready');self.assertEqual(result['axes']['left']['scale'],'log')
        for x,value in zip([1,2,3,4],[10,20,40,80]):
            point=min(result['series'][0]['points'],key=lambda p:abs(p['x']-x))
            self.assertLess(abs(point['x']-x),.025)
            self.assertLess(abs(point['y']/value-1),.03)
            self.assertEqual(len(point['pixelInterval']),2)
    def test_dual_axes_match_color_and_keep_both_scales(self):
        png,lines=fixture(dual=True);result=extract_geometry(png,lines)
        self.assertEqual({s['axisBinding'] for s in result['series']},{'left','right'})
        right=next(s for s in result['series'] if s['axisBinding']=='right')
        for x,value in zip([1,2,3,4],[1.875,4.875,7.875,10.875]):
            p=min(right['points'],key=lambda p:abs(p['x']-x));self.assertAlmostEqual(p['y'],value,delta=.15)
    def test_uncolored_dual_axes_are_not_silently_assigned(self):
        png,lines=fixture(dual=True,ambiguous=True);result=extract_geometry(png,lines)
        self.assertEqual(result['status'],'partial')
        for s in result['series']:
            self.assertEqual(s['axisBinding'],'ambiguous')
            self.assertNotIn('y',s['points'][0]);self.assertEqual(set(s['points'][0]['valueCandidates']),{'left','right'})
    def test_ocr_outlier_is_retained_and_reported(self):
        png,lines=fixture(outlier=True);result=extract_geometry(png,lines)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['axes']['left']['rejectedTicks'][0]['text'],'999')
    def test_bar_chart_does_not_become_a_line(self):
        png,lines=fixture(bars=True);result=extract_geometry(png,lines)
        self.assertEqual(result['status'],'unavailable');self.assertEqual(result['series'],[])
    def test_flattened_exponent_requires_source_glyph_evidence(self):
        self.assertEqual(_value('101'),(101,False));self.assertEqual(_value('10²'),(100,True))
        self.assertIsNone(fit_axis([{'pixel':10,'value':1},{'pixel':90,'value':10}],100))
    def test_black_curve_uses_the_same_log_calibration(self):
        png,lines=fixture();im=Image.open(io.BytesIO(png));pixels=im.load()
        for y in range(im.height):
            for x in range(im.width):
                if pixels[x,y]==(31,119,180):pixels[x,y]=(0,0,0)
        buf=io.BytesIO();im.save(buf,format='PNG');result=extract_geometry(buf.getvalue(),lines)
        self.assertEqual(result['status'],'ready');self.assertEqual(result['series'][0]['color'],'#222222')
        self.assertAlmostEqual(min(result['series'][0]['points'],key=lambda p:abs(p['x']-3))['y'],40,delta=1)

if __name__=='__main__':unittest.main()

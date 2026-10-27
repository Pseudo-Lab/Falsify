import base64, hashlib, json, os, struct, sys, tempfile, threading, unittest, zlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'local'))
import blue_service as blue
from blue_visual import validate_visual

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
PNG = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>II', 20, 20) + b'\x08\x02\x00\x00\x00') + chunk(b'IDAT', zlib.compress((b'\x00' + bytes(60))*20)) + chunk(b'IEND', b'')
if os.environ.get('BLUE_VISUAL_FIXTURE'):
    PNG=Path(os.environ['BLUE_VISUAL_FIXTURE']).read_bytes()
SIDE=struct.unpack('>I', PNG[16:20])[0]
TEXT='Synthetic document.'
def request():
    source=hashlib.sha256(TEXT.encode()).hexdigest(); imagehash=hashlib.sha256(PNG).hexdigest(); f='a'*64
    return {'schema':blue.VERSION,'revision':'r1','requestId':'b1','sourceHash':source,'segments':[{'id':'s0','label':'PDF p. 1','text':TEXT}],'maxCalls':8,'consent':True,'fileHash':f,'visualConsent':True,'visualEvidence':[{'fileHash':f,'sourceHash':source,'page':1,'bbox':[0,0,SIDE/2,SIDE/2],'rotation':0,'width':SIDE,'height':SIDE,'mime':'image/png','sha256':imagehash,'base64':base64.b64encode(PNG).decode()}]}
class FakeCodex(blue.CodexBackend):
    def __init__(self, **kwargs):
        super().__init__(**kwargs, executable=[sys.executable, str(Path(__file__).with_name('fake_blue_codex.py'))], skill_folders=[])
class VisualTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.log=Path(self.directory.name)/'log.json';os.environ['BLUE_FAKE_LOG']=str(self.log);os.environ.pop('BLUE_BAD_REF',None)
    def tearDown(self):
        os.environ.pop('BLUE_FAKE_LOG',None);os.environ.pop('BLUE_BAD_REF',None);self.directory.cleanup()
    def run_request(self, data):return blue.run_review(data,lambda _:None,threading.Event(),FakeCodex)
    def test_roundtrip_and_cleanup(self):
        result=self.run_request(request());self.assertEqual(result['visualObservations'][0]['id'],'v1');log=json.loads(self.log.read_text());self.assertEqual(log['sha256'],hashlib.sha256(PNG).hexdigest());self.assertTrue(all(not Path(p).exists() for p in log['paths']))
    def test_invalid_reference_cleanup(self):
        os.environ['BLUE_BAD_REF']='1'
        with self.assertRaisesRegex(ValueError,'visual_reference_invalid'):self.run_request(request())
        self.assertTrue(all(not Path(p).exists() for p in json.loads(self.log.read_text())['paths']))
    def test_rejections_before_provider(self):
        for mutate in [lambda d:d.update(visualConsent=False),lambda d:d.update(fileHash='c'*64),lambda d:d['visualEvidence'][0].update(sha256='b'*64),lambda d:d['visualEvidence'][0].update(width=4097),lambda d:d.update(visualEvidence=d['visualEvidence']*3)]:
            d=request();mutate(d)
            with self.assertRaises(ValueError):self.run_request(d)
        self.assertFalse(self.log.exists())
    def test_truncated_png_rejected_before_provider(self):
        d=request(); raw=PNG[:29]; d['visualEvidence'][0].update(base64=base64.b64encode(raw).decode(),sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaisesRegex(ValueError, 'visual_png_invalid'): self.run_request(d)
        self.assertFalse(self.log.exists())
    def test_unsupported_before_provider(self):
        from harness import default
        d=request();d['harness']={**default('blue'),'adapter':{'type':'claude'}}
        with self.assertRaisesRegex(ValueError,'visual_provider_unsupported'):self.run_request(d)
        self.assertFalse(self.log.exists())
if __name__=='__main__':unittest.main()

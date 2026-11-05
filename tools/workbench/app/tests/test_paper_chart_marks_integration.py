"""Actual mark dispatch, common core, output verification and SDK transport."""
import base64
import hashlib
import sys
import unittest
from pathlib import Path
import pymupdf
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_evidence import EvidenceStore
from paper_chart_edit_service import ChartEditService
from test_paper_chart_marks import document, circle

class MarkIntegrationTests(unittest.TestCase):
    def test_bar_and_scatter_dispatch_and_cumulative_export(self):
        for stream, kind in [
            (b'0 0 0 RG 1 w 30 40 m 370 40 l S 0.2 0.4 0.8 rg 60 40 36 90 re f 120 40 36 140 re f', 'bar'),
            (b'0.1 0.55 0.25 rg '+circle(150,100,6)+b' '+circle(250,150,6), 'scatter'),
        ]:
            with self.subTest(kind=kind):
                raw = document(stream)
                store = EvidenceStore()
                digest = hashlib.sha256(raw).hexdigest()
                pid = store.prepare(raw, digest)['paperId']
                service = ChartEditService(store)
                prepared = service.prepare({'paperId':pid,'fileHash':digest,'pageIndex':0,'bbox':[20,20,380,275]})
                self.assertEqual(prepared['mode'],'marks')
                series = next(s for s in prepared['series'] if s['kind']==kind)
                point = series['points'][0]
                self.assertNotIn('sourceBinding',series)
                plan = {'schema':'falsify.chart-edit-plan.v1','paperId':pid,'fileHash':digest,'sceneId':prepared['sceneId'],'revision':1,'operations':[
                    {'id':'drag','kind':'set-values','seriesId':series['id'],
                     'points':[{'index':0,'x':point['x']+(15 if kind=='scatter' else 0),'y':point['y']-12}]}]}
                preview = service.preview(plan)
                self.assertTrue(preview['image'])
                result = service.export(plan, author='human')
                output = base64.b64decode(result['file'])
                self.assertNotEqual(output,raw)
                self.assertEqual(result['verification']['issues'],[])
                self.assertEqual(result['changes'][0]['author'],'human')
                with pymupdf.open(stream=output,filetype='pdf') as after, pymupdf.open(stream=raw,filetype='pdf') as before:
                    self.assertEqual(len(after),2)
                    self.assertEqual(after[1].get_pixmap().samples,before[1].get_pixmap().samples)
                noop = service.export({**plan,'revision':0,'operations':[]})
                self.assertEqual(base64.b64decode(noop['file']),raw)

if __name__=='__main__':unittest.main()

"""Cumulative source-style charts and existing table editing use one PDF output."""
import base64, hashlib, sys, unittest, subprocess, tempfile, threading, time
from pathlib import Path
from unittest.mock import patch
import pymupdf
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'local')]
from chart_shape_fixture import chart_pdf
from paper_evidence import EvidenceStore
from paper_chart_edit_service import ChartEditService, SCHEMA
from paper_visual_edit import export_visual

class ChartVisualIntegrationTests(unittest.TestCase):
    def test_cancel_visual_child_during_chart_and_verify(self):
        import paper_native_worker as native
        raw = chart_pdf(); digest = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore(); pid = store.prepare(raw, digest)['paperId']
        service = ChartEditService(store)
        scene = service.prepare({'paperId': pid, 'fileHash': digest, 'pageIndex': 0, 'bbox': [35, 40, 395, 278]})
        plan = {'schema': SCHEMA, 'paperId': pid, 'fileHash': digest, 'sceneId': scene['sceneId'], 'revision': 0, 'operations': []}
        request = {'schema': 'falsify.visual-edit-request.v1', 'paperId': pid, 'fileHash': digest, 'revision': 0,
                   'operations': [{'id': 'chart', 'kind': 'chart-shape', 'plan': plan}]}
        for target in ('chart_evaluate', 'chart_export', 'verify'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as folder:
                marker = str(Path(folder) / 'started')
                script = f'''import sys, time, pathlib, subprocess, asyncio\nsys.path.insert(0, {str(Path(__file__).resolve().parents[1] / 'local')!r})\nimport paper_native_worker as n\noriginal = n._dispatch\ndef dispatch(op, args):\n    if op == {target!r}:\n        pathlib.Path({marker!r}).write_text('started')\n        time.sleep(30)\n    return original(op, args)\nn._dispatch = dispatch\nn._IN_WORKER = True\nsubprocess.Popen = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('nested process'))\nimport json, traceback\ntry:\n    req = json.loads(sys.stdin.buffer.read())\n    result = n._dispatch(req['operation'], n._unpack(req['args']))\n    sys.stdout.write(json.dumps(dict(ok=True, data=n._pack(result))))\nexcept Exception:\n    pathlib.Path({marker!r} + '.error').write_text(traceback.format_exc())\n    raise\n'''
                original_popen = subprocess.Popen; children = []; errors = []; cancelled = threading.Event()
                def launch(*args, **kwargs):
                    if '--worker' not in args[0]: return original_popen(*args, **kwargs)
                    process = original_popen([sys.executable, '-c', script], **kwargs)
                    children.append(process)
                    return process
                def run():
                    try: native.run('visual_export', [request, raw, {}, service.scenes], cancelled=cancelled)
                    except Exception as exc: errors.append(exc)
                with patch.object(native.subprocess, 'Popen', side_effect=launch):
                    thread = threading.Thread(target=run); thread.start()
                    until = time.monotonic() + 20
                    while not Path(marker).exists() and thread.is_alive() and time.monotonic() < until: time.sleep(.05)
                    reached = Path(marker).exists()
                    cancelled.set(); thread.join(15)
                self.assertTrue(reached, (errors, Path(marker + '.error').read_text() if Path(marker + '.error').exists() else 'no child error'))
                self.assertFalse(thread.is_alive())
                self.assertEqual([str(e) for e in errors], ['native_cancelled'])
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll())
        self.assertEqual(native.run('evidence_extract', [raw, digest])['pdf'], raw)

    def test_evaluation_timeout_cancel_and_recovery(self):
        import paper_native_worker as native
        import paper_chart_shape_core as core
        raw = chart_pdf(); digest = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore(); pid = store.prepare(raw, digest)['paperId']
        service = ChartEditService(store)
        def prepare():
            return service.prepare({'paperId': pid, 'fileHash': digest, 'pageIndex': 0, 'bbox': [35, 40, 395, 278]})
        scene = prepare()
        plan = {'schema': SCHEMA, 'paperId': pid, 'fileHash': digest, 'sceneId': scene['sceneId'], 'revision': 1, 'operations': []}
        original_popen = subprocess.Popen
        with tempfile.TemporaryDirectory() as folder:
            marker = str(Path(folder) / 'started')
            script = f"""import sys, time, pathlib
sys.path.insert(0, {str(Path(__file__).resolve().parents[1] / 'local')!r})
import paper_native_worker as n
original = n._dispatch
def dispatch(op, args):
    if op == 'chart_evaluate':
        pathlib.Path({marker!r}).write_text('started')
        time.sleep(30)
    return original(op, args)
n._dispatch = dispatch
n._worker()
"""
            children = []
            def launch(*args, **kwargs):
                if '--worker' not in args[0]: return original_popen(*args, **kwargs)
                process = original_popen([sys.executable, '-c', script], **kwargs)
                children.append(process)
                return process
            with patch.object(core, 'evaluate', side_effect=AssertionError('parent evaluation')):
                with patch.object(native.subprocess, 'Popen', side_effect=launch), patch.object(native, 'budget', side_effect=lambda: time.monotonic() + 3):
                    with self.assertRaisesRegex(ValueError, 'native_timeout'): service.preview(plan)
                self.assertTrue(Path(marker).exists())
                self.assertIsNotNone(children[-1].poll())
                Path(marker).unlink()
                cancelled = threading.Event(); errors = []
                def export():
                    try: service.export(plan, cancelled=cancelled)
                    except Exception as exc: errors.append(exc)
                with patch.object(native.subprocess, 'Popen', side_effect=launch):
                    thread = threading.Thread(target=export); thread.start()
                    until = time.monotonic() + 20
                    while not Path(marker).exists() and thread.is_alive() and time.monotonic() < until: time.sleep(.05)
                    reached = Path(marker).exists()
                    cancelled.set(); thread.join(15)
                self.assertTrue(reached)
                self.assertFalse(thread.is_alive())
                self.assertEqual([str(e) for e in errors], ['native_cancelled'])
                self.assertIsNotNone(children[-1].poll())
                fresh = prepare()
                fresh_plan = {**plan, 'sceneId': fresh['sceneId']}
                self.assertTrue(service.preview(fresh_plan)['image'])
                self.assertTrue(service.export(fresh_plan)['file'])

    def test_two_native_regions_and_table_keep_previous_edits(self):
        doc=pymupdf.open();page=doc.new_page(width=620,height=320)
        page.insert_text((30,25),'Two independent charts')
        for left,color in [(30,(1,0,0)),(330,(0,0,1))]:
            page.draw_line((left,270),(left+240,270),color=(0,0,0))
            page.draw_line((left,270),(left,50),color=(0,0,0))
            shape=page.new_shape();shape.draw_polyline([(left+i*2.4,240-i) for i in range(101)])
            shape.finish(color=color,width=2,closePath=False);shape.commit()
        other=pymupdf.open(stream=chart_pdf(),filetype='pdf');doc.insert_pdf(other,from_page=2,to_page=2);other.close()
        raw=doc.tobytes();doc.close();digest=hashlib.sha256(raw).hexdigest()
        store=EvidenceStore();pid=store.prepare(raw,digest)['paperId'];service=ChartEditService(store)
        operations=[]
        for n,box in enumerate([[20,40,280,280],[320,40,580,280]]):
            scene=service.prepare({'paperId':pid,'fileHash':digest,'pageIndex':0,'bbox':box})
            series=scene['series'][0];p=series['points'][len(series['points'])//2]
            plan={'schema':SCHEMA,'paperId':pid,'fileHash':digest,'sceneId':scene['sceneId'],'revision':1,
                'operations':[{'id':'drag'+str(n),'kind':'deform','seriesId':series['id'],'center':[p['x'],p['y']],'radius':35,'dx':0,'dy':-20}]}
            operations.append({'id':'chart'+str(n),'kind':'chart-shape','plan':plan})
        table=store.list_items(pid,kind='table',page_index=1)['items'][0];item=store.read_item(pid,table['id'])
        cell=next(c for c in item['table']['cells'] if c['text']=='7')
        operations.append({'id':'cell','kind':'table-cell','itemId':table['id'],'row':cell['row'],'column':cell['column'],'before':'7','after':'-7.5'})
        with patch('paper_chart_edit_service.default_service',service):
            result=export_visual({'schema':'falsify.visual-edit-request.v1','paperId':pid,'fileHash':digest,'revision':'combo','operations':operations},store=store)
        self.assertEqual(len(result['changes']),3)
        self.assertEqual(result['verification']['issues'],[])
        out=base64.b64decode(result['file'])
        with pymupdf.open(stream=out,filetype='pdf') as final,pymupdf.open(stream=raw,filetype='pdf') as original:
            self.assertEqual(len(final),2)
            self.assertEqual(final[0].get_text(),original[0].get_text())
            self.assertIn('-7.5',final[1].get_text())
            self.assertNotEqual(final[0].get_pixmap().samples,original[0].get_pixmap().samples)
        self.assertEqual(store.source_bytes(pid,digest),raw)

if __name__=='__main__':unittest.main()

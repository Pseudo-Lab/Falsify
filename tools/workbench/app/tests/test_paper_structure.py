"""Docling structure normalization tests on real in-memory PDFs (PyMuPDF) and DoclingDocument-shaped payloads.

Payloads are hand-built in the docling-core 1.10 export_to_dict() shape. When docling-core is importable (only in a separate
experimental venv, never the app's), DoclingCoreTests also build them with the real docling-core API and every fixture is
validated by DoclingDocument.model_validate. No Docling conversion or model runs here."""
import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import paper_structure as ps
import pymupdf
try:
    from docling_core.types.doc import DoclingDocument
except ImportError:
    DoclingDocument=None

A4=(595.276,841.89)
SECRET='Hidden source sentence'
sha=lambda b:hashlib.sha256(b).hexdigest()
def pdf(pages=1,rotate=None,crop=None,size=A4):
    d=pymupdf.open()
    for i in range(pages):
        p=d.new_page(width=size[0],height=size[1]);p.insert_text((72,100),f'Page {i+1} text',fontsize=11)
        if rotate is not None and i==0:p.set_rotation(rotate)
        if crop is not None and i==0:p.set_cropbox(pymupdf.Rect(*crop))
    return d.tobytes()
def prov(page,l,t,r,b,origin='TOPLEFT',span=(0,4)):
    return {'page_no':page,'bbox':{'l':l,'t':t,'r':r,'b':b,'coord_origin':origin},'charspan':list(span)}
def text(i,label='text',provs=None,parent='#/body'):
    return {'self_ref':f'#/texts/{i}','parent':{'$ref':parent},'children':[],'content_layer':'body','label':label,
        'prov':[prov(1,72,90,300,104)] if provs is None else provs,'orig':SECRET,'text':SECRET}
def table(i,provs=None,captions=(),parent='#/body'):
    return {'self_ref':f'#/tables/{i}','parent':{'$ref':parent},'children':[],'content_layer':'body','label':'table',
        'prov':[prov(1,72,200,500,400)] if provs is None else provs,'captions':[{'$ref':c} for c in captions],'references':[],'footnotes':[],
        'data':{'table_cells':[],'num_rows':0,'num_cols':0}}
def picture(i,provs=None,captions=(),parent='#/body',label='picture'):
    return {'self_ref':f'#/pictures/{i}','parent':{'$ref':parent},'children':[],'content_layer':'body','label':label,
        'prov':[prov(1,72,450,300,600)] if provs is None else provs,'captions':[{'$ref':c} for c in captions],'references':[],'footnotes':[],'annotations':[]}
def doc(src,texts=(),tables=(),pictures=(),groups=(),order=None,origin=True):
    d=pymupdf.open(stream=src,filetype='pdf')
    pages={str(i+1):{'size':{'width':d[i].mediabox.width,'height':d[i].mediabox.height},'page_no':i+1} for i in range(d.page_count)}
    d.close()
    refs=[x['self_ref'] for x in [*texts,*tables,*pictures]] if order is None else order
    out={'schema_name':'DoclingDocument','version':'1.10.0','name':'source',
        'furniture':{'self_ref':'#/furniture','children':[],'content_layer':'furniture','name':'_root_','label':'unspecified'},
        'body':{'self_ref':'#/body','children':[{'$ref':r} for r in refs],'content_layer':'body','name':'_root_','label':'unspecified'},
        'groups':list(groups),'texts':list(texts),'pictures':list(pictures),'tables':list(tables),'key_value_items':[],'form_items':[],'pages':pages}
    if origin:out['origin']={'mimetype':'application/pdf','binary_hash':int(sha(src),16)&0xFFFFFFFFFFFFFFFF,'filename':'source.pdf'}
    return out
def standard(src):
    """caption text 0 (TOPLEFT), body text 1, table 0 with caption, picture 0 in BOTTOMLEFT; body order text1, caption, table, picture."""
    cap=text(0,'caption',[prov(1,72,180,260,194)])
    return doc(src,[cap,text(1)],[table(0,captions=['#/texts/0'])],[picture(0,[prov(1,72,A4[1]-450,300,A4[1]-600,'BOTTOMLEFT')])],
        order=['#/texts/1','#/texts/0','#/tables/0','#/pictures/0'])

class NormalizeTests(unittest.TestCase):
    def norm(self,payload,src):return ps.normalize_docling(payload,src)
    def reason(self,payload,src):
        env=self.norm(payload,src);self.assertEqual((env['status'],env['items'],env['pages']),('unavailable',[],[]));return env['reason']
    def item(self,env,ref):return next(e for e in env['items'] if e['ref']==ref)

    def test_envelope_regions_order_captions_and_no_text(self):
        src=bytearray(pdf());before=bytes(src);payload=standard(bytes(src))
        if DoclingDocument:DoclingDocument.model_validate(payload)
        env=self.norm(payload,src)
        self.assertEqual(bytes(src),before)
        self.assertEqual(set(env),{'schema','sourceSha256','payloadSha256','payloadOrigin','producer','authority','status','reason','checks','pages','items'})
        self.assertEqual((env['schema'],env['sourceSha256'],env['status'],env['reason'],env['authority'],env['payloadOrigin']),
            ('falsify.pdf-structure.v1',sha(before),'available',None,'structure-hint','supplied'))
        self.assertEqual(env['producer'],{'name':'docling','schemaName':'DoclingDocument','version':'1.10.0'})
        self.assertEqual(env['checks'],{'originHash':'matched','pageGeometry':'matched'})
        self.assertEqual(env['pages'],[{'pageIndex':0,'pageNo':1,'width':595.276,'height':841.89,'supportedGeometry':True}])
        self.assertEqual([(e['ref'],e['type'],e['label'],e['readOrder']) for e in env['items']],
            [('#/texts/1','text','text',0),('#/texts/0','caption','caption',1),('#/tables/0','table','table',2),('#/pictures/0','picture','picture',3)])
        self.assertEqual(self.item(env,'#/tables/0')['captionRefs'],['#/texts/0'])
        self.assertEqual(self.item(env,'#/tables/0')['regions'],[{'pageIndex':0,'bbox':[72,200,500,400],'charspan':[0,4]}])
        self.assertEqual(self.item(env,'#/pictures/0')['regions'][0]['bbox'],[72,450,300,600])
        self.assertTrue(all(set(e)=={'ref','type','label','readOrder','status','reason','regions','captionRefs'} for e in env['items']))
        dumped=json.dumps(env)
        for word in (SECRET,'editable','confidence','"text":'):self.assertNotIn(word,dumped)

    def test_bottom_left_equals_top_left_and_json_inputs_agree(self):
        src=pdf();top=doc(src,[text(0,provs=[prov(1,72,90,300,104)])]);bottom=doc(src,[text(0,provs=[prov(1,72,A4[1]-90,300,A4[1]-104,'BOTTOMLEFT')])])
        a,b=self.norm(top,src),self.norm(bottom,src)
        self.assertEqual(a['items'][0]['regions'][0]['bbox'],[72,90,300,104]);self.assertEqual(a['items'],b['items'])
        for form in (json.dumps(top),json.dumps(top).encode('utf-8')):self.assertEqual(self.norm(form,src),a)
        self.assertEqual(a['payloadSha256'],sha(json.dumps(top,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')))

    def test_origin_hash_binding(self):
        src=pdf();p=standard(src)
        p['origin']['binary_hash']=sha(src);self.assertEqual(self.norm(p,src)['checks']['originHash'],'matched')
        for bad in (sha(b'other'),(int(sha(src),16)+1)&0xFFFFFFFFFFFFFFFF,True,1.5,'zz'):
            p['origin']['binary_hash']=bad;self.assertEqual(self.reason(p,src),'origin_hash_mismatch')
        p['origin']={'mimetype':'text/html','binary_hash':int(sha(src),16)&0xFFFFFFFFFFFFFFFF,'filename':'x'};self.assertEqual(self.reason(p,src),'payload_invalid')
        del p['origin'];self.assertEqual(self.norm(p,src)['checks']['originHash'],'absent')
        self.assertEqual(self.reason(standard(src),pdf(2)),'origin_hash_mismatch')

    def test_page_dimensions_and_counts(self):
        src=pdf()
        p=standard(src);p['pages']['1']['size']['width']+=0.4;self.assertEqual(self.norm(p,src)['status'],'available')
        p['pages']['1']['size']['width']+=0.2;self.assertEqual(self.reason(p,src),'page_geometry_mismatch')
        p=standard(src);p['pages']['1']['size']={'width':A4[1],'height':A4[0]};self.assertEqual(self.reason(p,src),'page_geometry_mismatch')
        p=standard(src);p['pages']['2']={'size':{'width':A4[0],'height':A4[1]},'page_no':2};self.assertEqual(self.reason(p,src),'page_count_mismatch')
        p=standard(src);p['texts'][1]['prov'][0]['page_no']=2;self.assertEqual(self.reason(p,src),'page_count_mismatch')
        p=standard(src);p['pages']['1']['page_no']=0;self.assertEqual(self.reason(p,src),'payload_invalid')
        p=standard(src);p['pages']={'01':{'size':{'width':A4[0],'height':A4[1]},'page_no':1}};self.assertEqual(self.reason(p,src),'payload_invalid')
        p=standard(src);p['pages']['1']['size']['height']=0;self.assertEqual(self.reason(p,src),'payload_invalid')
        src2=pdf(2);p=standard(src2);p['texts'][1]['prov'][0]['page_no']=2;del p['pages']['2']
        env=self.norm(p,src2);self.assertEqual(env['status'],'partial');self.assertEqual(self.item(env,'#/texts/1')['reason'],'page_missing')

    def test_int_page_keys_from_python_mode_dump(self):
        src=pdf();p=standard(src);p['pages']={1:p['pages']['1']}
        self.assertEqual(self.norm(p,src)['status'],'available')
        p['pages']={True:{'size':{'width':A4[0],'height':A4[1]},'page_no':1}};self.assertEqual(self.reason(p,src),'payload_invalid')

    def test_ref_cycles_duplicates_and_malformed_refs(self):
        src=pdf()
        g={'self_ref':'#/groups/0','parent':{'$ref':'#/body'},'children':[{'$ref':'#/texts/0'},{'$ref':'#/groups/0'}],'content_layer':'body','name':'g','label':'unspecified'}
        self.assertEqual(self.reason(doc(src,[text(0,parent='#/groups/0')],groups=[g],order=['#/groups/0']),src),'ref_cycle')
        t=text(0);t['children']=[{'$ref':'#/texts/1'}];t1=text(1,parent='#/texts/0');t1['children']=[{'$ref':'#/texts/0'}]
        self.assertEqual(self.reason(doc(src,[t,t1],order=['#/texts/0']),src),'ref_cycle')
        self.assertEqual(self.reason(doc(src,[text(0)],order=['#/texts/0','#/texts/0']),src),'ref_cycle')
        for order in (['#/texts/1'],['#/texts/01'],['#/body'],['#/unknown/0'],['texts/0']):
            self.assertEqual(self.reason(doc(src,[text(0)],order=order),src),'ref_invalid',order)
        p=doc(src,[text(0)]);p['body']['children']=[{'$ref':'#/texts/0','extra':1}];self.assertEqual(self.reason(p,src),'ref_invalid')
        p=doc(src,[text(0)]);p['texts'][0]['self_ref']='#/texts/1';self.assertEqual(self.reason(p,src),'ref_invalid')
        p=standard(src);p['tables'][0]['captions']=[{'$ref':'#/pictures/0'}];self.assertEqual(self.reason(p,src),'ref_invalid')
        p=standard(src);p['tables'][0]['captions']=[{'$ref':'#/texts/9'}];self.assertEqual(self.reason(p,src),'ref_invalid')
        p=standard(src);del p['body'];self.assertEqual(self.reason(p,src),'payload_invalid')

    def test_group_children_keep_preorder(self):
        src=pdf()
        g={'self_ref':'#/groups/0','parent':{'$ref':'#/body'},'children':[{'$ref':'#/texts/1'},{'$ref':'#/texts/0'}],'content_layer':'body','name':'list','label':'list'}
        p=doc(src,[text(0,parent='#/groups/0'),text(1,parent='#/groups/0'),text(2)],groups=[g],order=['#/texts/2','#/groups/0'])
        self.assertEqual([(e['ref'],e['readOrder']) for e in self.norm(p,src)['items']],[('#/texts/2',0),('#/texts/1',1),('#/texts/0',2)])
        p=doc(src,[text(0),text(1)],order=['#/texts/1'])
        self.assertEqual([(e['ref'],e['readOrder']) for e in self.norm(p,src)['items']],[('#/texts/1',0),('#/texts/0',None)])

    def test_budgets(self):
        src=pdf()
        with patch.dict(ps.LIMITS,{'maxItems':3}):self.assertEqual(self.reason(standard(src),src),'over_budget')
        with patch.dict(ps.LIMITS,{'maxNodes':3}):self.assertEqual(self.reason(standard(src),src),'over_budget')
        with patch.dict(ps.LIMITS,{'maxProv':1}):
            p=standard(src);p['tables'][0]['prov']*=2;self.assertEqual(self.reason(p,src),'over_budget')
        with patch.dict(ps.LIMITS,{'maxCaptions':0}):self.assertEqual(self.reason(standard(src),src),'over_budget')
        with patch.dict(ps.LIMITS,{'maxPayloadBytes':100}):
            self.assertEqual(self.reason(json.dumps(standard(src)),src),'over_budget');self.assertEqual(self.reason(standard(src),src),'over_budget')

    def test_nan_infinity_and_non_objects(self):
        src=pdf();raw=json.dumps(standard(src))
        for bad in (raw.replace('"l": 72','"l": NaN',1),raw.replace('"l": 72','"l": Infinity',1),raw.replace('"l": 72','"l": 1e999',1),b'\xff',b'[]','{'):
            self.assertEqual(self.reason(bad,src),'payload_invalid')
        p=standard(src);p['texts'][1]['prov'][0]['bbox']['l']=float('nan');self.assertEqual(self.reason(p,src),'payload_invalid')
        p=standard(src);p['self']=p;self.assertEqual(self.reason(p,src),'payload_invalid')
        for bad in (None,[],42):self.assertEqual(self.reason(bad,src),'payload_invalid')

    def test_schema_version(self):
        src=pdf()
        for key,value in (('schema_name','Other'),('version','2.0.0'),('version','1.10'),('version',1)):
            p=standard(src);p[key]=value;self.assertEqual(self.reason(p,src),'schema_unsupported')
        p=standard(src);p['version']='1.5.0';self.assertEqual(self.norm(p,src)['producer']['version'],'1.5.0')

    def test_bool_and_bad_provenance_fields(self):
        src=pdf()
        cases=[('page_no',True,'provenance'),('page_no',1.0,'provenance'),('charspan',[False,3],'provenance'),('charspan',[3,1],'provenance'),
            ('charspan',[0],'provenance'),('bbox',None,'bbox')]
        for key,value,reason in cases:
            p=standard(src);p['texts'][1]['prov'][0][key]=value
            env=self.norm(p,src);self.assertEqual((env['status'],self.item(env,'#/texts/1')['reason']),('partial',reason),key)
        for key,value in (('coord_origin',None),('coord_origin','TOPRIGHT'),('l',True),('t','90'),('r',50),('b',80),('r',700)):
            p=standard(src);box=p['texts'][1]['prov'][0]['bbox']
            if value is None:del box[key]
            else:box[key]=value
            env=self.norm(p,src);item=self.item(env,'#/texts/1')
            self.assertEqual((item['status'],item['reason'],item['regions']),('unavailable','bbox',[]),(key,value))
        p=standard(src);p['texts'][1]['prov']=[];self.assertEqual(self.item(self.norm(p,src),'#/texts/1')['reason'],'no_provenance')
        p=standard(src);p['texts'][1]['prov']={};self.assertEqual(self.reason(p,src),'payload_invalid')

    def test_labels(self):
        src=pdf()
        for coll,i,label in (('texts',1,'table'),('texts',1,'nonsense'),('tables',0,'picture'),('pictures',0,'text')):
            p=standard(src);p[coll][i]['label']=label;item=self.item(self.norm(p,src),f'#/{coll}/{i}')
            self.assertEqual((item['status'],item['reason'],item['label']),('unavailable','label',label if label in ps.LABELS else None))
        p=standard(src);p['pictures'][0]['label']='chart';self.assertEqual(self.item(self.norm(p,src),'#/pictures/0')['status'],'resolved')

    def test_multi_page_provenance(self):
        src=pdf(2);t=table(0,provs=[prov(1,72,600,500,800,span=(0,10)),prov(2,72,60,500,200,'BOTTOMLEFT',span=(10,20))])
        t['prov'][1]['bbox'].update(t=A4[1]-60,b=A4[1]-200)
        env=self.norm(doc(src,tables=[t]),src)
        self.assertEqual(env['items'][0]['regions'],[{'pageIndex':0,'bbox':[72,600,500,800],'charspan':[0,10]},
            {'pageIndex':1,'bbox':[72,60,500,200],'charspan':[10,20]}])
        t['prov'][1]['bbox']['coord_origin']='TOPLEFT';item=self.norm(doc(src,tables=[t]),src)['items'][0]
        self.assertEqual((item['status'],item['reason'],item['regions']),('unavailable','bbox',[]))

    def test_rotated_and_cropped_source_pages_are_not_mapped(self):
        for src in (pdf(2,rotate=90),pdf(2,crop=(20,20,500,800))):
            p=doc(src,[text(0),text(1,provs=[prov(2,72,90,300,104)])])
            if DoclingDocument:DoclingDocument.model_validate(p)
            env=self.norm(p,src)
            self.assertEqual([pg['supportedGeometry'] for pg in env['pages']],[False,True])
            self.assertEqual(env['pages'][0]['width'],595.276)
            self.assertEqual([(e['status'],e['reason']) for e in env['items']],[('unavailable','page_geometry'),('resolved',None)])
            p['pages']['1']['size']={'width':10,'height':10};self.assertEqual(self.norm(p,src)['status'],'partial')
        src=pdf(1,rotate=90);p=doc(src,[text(0)]);self.assertEqual(self.norm(p,src)['checks']['pageGeometry'],'unchecked')

    def test_unreadable_source_and_summary(self):
        payload=standard(pdf())
        for src in (b'',b'not a pdf',None,'%PDF-1.7'):
            env=ps.normalize_docling(payload,src);self.assertEqual((env['status'],env['reason']),('unavailable','source_unreadable'))
        with patch.dict(ps.LIMITS,{'maxFileBytes':10}):self.assertEqual(ps.normalize_docling(payload,pdf())['reason'],'source_unreadable')
        src=pdf();env=self.norm(standard(src),src)
        self.assertEqual(ps.summarize(env),{'schema':'falsify.pdf-structure-summary.v1','status':'available','reason':None,'items':4,'resolvedItems':4})
        self.assertEqual(ps.summarize({'schema':'x'})['status'],'unavailable')
        self.assertEqual(ps.normalize_docling(payload,src,payload_origin='trusted')['payloadOrigin'],'supplied')

    def test_summary_reason_is_allow_listed_and_never_echoes_text(self):
        src=pdf();sha_=sha(src);invalid={'schema':'falsify.pdf-structure-summary.v1','status':'unavailable','reason':'envelope_invalid','items':0,'resolvedItems':0}
        emitted=set(re.findall(r"(?:_Reject|fail)\('([a-z_]+)'\)|unavailable\(source_sha256, '([a-z_]+)'",Path(ps.__file__).read_text(encoding='utf-8')))
        emitted={a or b for a,b in emitted}|{'no_items','no_resolved_items'}
        self.assertTrue(emitted<=ps.REASONS,emitted-ps.REASONS)
        for reason in sorted(ps.REASONS):
            self.assertEqual(ps.summarize(ps.unavailable(sha_,reason))['reason'],reason)
        self.assertEqual(ps.summarize(self.norm(doc(src,[]),src))['reason'],'no_items')
        env=self.norm(standard(src),src)
        for bad in ('private paper excerpt','x'*40,'','No_Items','no_items ',['no_items'],{'no_items':1},{'a'},1,True,b'no_items'):
            e=dict(env,reason=bad);out=ps.summarize(e)
            self.assertEqual(out,invalid,bad)
            self.assertNotIn('private',json.dumps(out))
        self.assertEqual(ps.summarize(dict(env,authority='edit')),invalid)   # only the structure-hint envelope is summarized
        self.assertEqual(env['authority'],'structure-hint')
        self.assertEqual(ps.summarize(dict(env,reason=None))['reason'],None)

class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name)
        self.src=pdf();self.path=root/'source.pdf';self.path.write_bytes(self.src);self.art=root/'artifacts';self.art.mkdir()
        self.python=Path(sys.executable)
    def tearDown(self):self.tmp.cleanup()
    def convert(self,**kw):
        return ps.convert_isolated(self.path,kw.pop('sha',sha(self.src)),python=kw.pop('python',self.python),artifacts_path=kw.pop('art',self.art),**kw)

    def test_opt_in_required(self):
        for kw in ({'python':None},{'art':None},{'python':self.art},{'art':self.path},{'art':Path(self.tmp.name)/'missing'}):
            env=self.convert(**kw);self.assertEqual((env['status'],env['reason'],env['payloadOrigin']),('unavailable','conversion_unconfigured','local-conversion'))
        self.assertEqual(self.convert(sha=sha(b'x'))['reason'],'source_hash_mismatch')
        with self.assertRaises(ValueError):self.convert(sha='ABC')

    def test_fixed_argv_offline_env_and_parent_normalization(self):
        calls=[]
        def runner(argv,**kw):
            calls.append((argv,kw));return SimpleNamespace(returncode=0,stdout=(json.dumps(standard(self.src))+'\n').encode('utf-8'))
        with patch.dict(ps.os.environ,{'HF_TOKEN':'secret-token','HF_HUB_OFFLINE':'0'}):env=self.convert(runner=runner)
        self.assertEqual((env['status'],env['payloadOrigin'],env['authority']),('available','local-conversion','structure-hint'))
        argv,kw=calls[0]
        self.assertEqual(argv,[str(self.python),'-I',str(Path(ps.__file__).resolve()),'--docling-worker'])
        self.assertEqual({k:kw['env'][k] for k in ps.OFFLINE_ENV},ps.OFFLINE_ENV);self.assertNotIn('HF_TOKEN',kw['env'])
        self.assertEqual(kw['timeout'],ps.LIMITS['timeoutSeconds'])
        self.assertEqual(json.loads(kw['input']),{'source':str(self.path.resolve()),'sourceSha256':sha(self.src),'artifactsPath':str(self.art.resolve())})

    def test_child_failures_are_unavailable(self):
        out=json.dumps(standard(self.src)).encode('utf-8')
        for result in (SimpleNamespace(returncode=1,stdout=out),SimpleNamespace(returncode=0,stdout=b''),SimpleNamespace(returncode=0,stdout=out+b'\n'+out)):
            self.assertEqual(self.convert(runner=lambda argv,**kw:result)['reason'],'conversion_failed')
        def timeout(argv,**kw):raise subprocess.TimeoutExpired(argv,1)
        self.assertEqual(self.convert(runner=timeout)['reason'],'conversion_failed')
        with patch.dict(ps.LIMITS,{'maxStdoutBytes':10}):self.assertEqual(self.convert(runner=lambda argv,**kw:SimpleNamespace(returncode=0,stdout=out))['reason'],'conversion_failed')
        other=pdf(2)
        self.assertEqual(self.convert(runner=lambda argv,**kw:SimpleNamespace(returncode=0,stdout=json.dumps(standard(other)).encode()))['reason'],'origin_hash_mismatch')

    def test_real_child_without_docling_is_unavailable(self):
        try:
            import docling  # noqa: F401
            self.skipTest('docling installed in this interpreter')
        except ImportError:pass
        env=self.convert();self.assertEqual((env['status'],env['reason']),('unavailable','conversion_failed'))
        self.assertEqual(self.path.read_bytes(),self.src)

@unittest.skipIf(DoclingDocument is None,'docling-core not installed (run in the experimental venv)')
class DoclingCoreTests(unittest.TestCase):
    """Payloads produced by the real docling-core serializer, not hand-built dicts."""
    def build(self,src,origin_hash=None):
        from docling_core.types.doc import BoundingBox,CoordOrigin,DocItemLabel,ProvenanceItem,Size,TableData
        from docling_core.types.doc.document import DocumentOrigin
        d=DoclingDocument(name='source',origin=DocumentOrigin(mimetype='application/pdf',filename='source.pdf',binary_hash=origin_hash or sha(src)))
        d.add_page(page_no=1,size=Size(width=A4[0],height=A4[1]));d.add_page(page_no=2,size=Size(width=A4[0],height=A4[1]))
        p=lambda n,l,t,r,b,o=CoordOrigin.BOTTOMLEFT:ProvenanceItem(page_no=n,bbox=BoundingBox(l=l,t=t,r=r,b=b,coord_origin=o),charspan=(0,7))
        d.add_text(label=DocItemLabel.SECTION_HEADER,text=SECRET,prov=p(1,72,780,300,760))
        cap=d.add_text(label=DocItemLabel.CAPTION,text=SECRET,prov=p(1,72,700,260,688))
        d.add_table(data=TableData(num_rows=1,num_cols=1),caption=cap,prov=p(1,72,680,500,500))
        pic=d.add_picture(prov=p(2,72,90,300,240,CoordOrigin.TOPLEFT))
        pic.prov.append(p(1,72,400,300,300))
        return d

    def test_serialized_payload_normalizes(self):
        src=pdf(2);d=self.build(src)
        for payload in (d.export_to_dict(),d.model_dump_json(by_alias=True,exclude_none=True)):
            env=ps.normalize_docling(payload,src)
            self.assertEqual((env['status'],env['checks']),('available',{'originHash':'matched','pageGeometry':'matched'}))
            self.assertEqual([(e['type'],e['label'],e['readOrder']) for e in env['items']],
                [('text','section_header',0),('caption','caption',1),('table','table',2),('picture','picture',3)])
            table=env['items'][2];self.assertEqual((table['captionRefs'],table['regions'][0]['bbox']),(['#/texts/1'],[72,161.89,500,341.89]))
            self.assertEqual([r['pageIndex'] for r in env['items'][3]['regions']],[1,0])
            self.assertEqual(env['items'][3]['regions'][0]['bbox'],[72,90,300,240])
            self.assertNotIn(SECRET,json.dumps(env))

    def test_docling_hex_origin_and_wrong_source(self):
        src=pdf(2);d=self.build(src)
        self.assertEqual(d.origin.binary_hash,int(sha(src),16)&0xFFFFFFFFFFFFFFFF)
        self.assertEqual(ps.normalize_docling(self.build(src,sha(b'other')).export_to_dict(),src)['reason'],'origin_hash_mismatch')
        self.assertEqual(ps.normalize_docling(d.export_to_dict(),pdf(2,size=(612,792)))['reason'],'origin_hash_mismatch')
        payload=d.export_to_dict();del payload['origin']
        self.assertEqual(ps.normalize_docling(payload,pdf(2,size=(612,792)))['reason'],'page_geometry_mismatch')

    def test_fixture_mutations_stay_valid_docling(self):
        """Refusals above are ours, not docling-core's: these mutated fixtures still validate as DoclingDocument."""
        src=pdf()
        p=standard(src);p['texts'][1]['prov'][0]['bbox']['coord_origin']='BOTTOMLEFT';DoclingDocument.model_validate(p)
        p=standard(src);p['pages']['1']['size']['width']=612;DoclingDocument.model_validate(p)
        self.assertEqual(ps.normalize_docling(p,src)['reason'],'page_geometry_mismatch')

if __name__=='__main__':unittest.main()

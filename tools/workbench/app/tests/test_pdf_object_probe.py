"""Object occurrence probe and synthetic-only replacement prototype on real in-memory SYNTHETIC PDFs (PyMuPDF/MuPDF).
No editor, Node, server, model or real paper."""
import hashlib
import json
import sys
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import pdf_foundation_corpus as corpus
import pdf_object_probe as op
import pymupdf

sha=lambda b:hashlib.sha256(b).hexdigest()
R=pymupdf.Rect
def png(seed,alpha=False):
    pix=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(0,0,4,4),alpha)
    for y in range(4):
        for x in range(4):pix.set_pixel(x,y,((seed*70+40*x)%256,(30*y+seed)%256,(seed*50)%256)+((255,) if alpha else ()))
    return pix.tobytes('png')
def build(pages,synthetic=True,size=(300,300)):
    """pages: list of callables(doc, page) drawing one page each; returns saved bytes."""
    d=pymupdf.open()
    for draw in pages:draw(d,d.new_page(width=size[0],height=size[1]))
    d.set_metadata({'keywords':op.SYNTHETIC_KEYWORD} if synthetic else {})
    return d.tobytes(no_new_id=True)
def image(rect,seed=1):return lambda d,p:p.insert_image(R(rect),stream=png(seed))
def both(*fs):
    def draw(d,p):
        for f in fs:f(d,p)
    return draw
def wrap(prefix,suffix=b''):
    """Wrap the page's last content stream (synthetic operator surgery for clip/inline fixtures)."""
    def draw(d,p):
        c=p.get_contents()[-1];d.update_stream(c,prefix+d.xref_stream(c)+suffix)
    return draw
INLINE=b'\nq 100 0 0 100 150 50 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff EI Q\n'
def images(probe,kind='image'):return [o for o in probe['occurrences'] if o['kind']==kind]
def chunk(kind,data):return len(data).to_bytes(4,'big')+kind+data+zlib.crc32(kind+data).to_bytes(4,'big')
def raw_png(width,height,depth=8,colour=2,idat=None):
    """Hand-built PNG whose IHDR claims width x height; idat defaults to a tiny deflate stream (a bomb when dims are huge)."""
    ihdr=width.to_bytes(4,'big')+height.to_bytes(4,'big')+bytes([depth,colour,0,0,0])
    return op.PNG_SIGNATURE+chunk(b'IHDR',ihdr)+chunk(b'IDAT',zlib.compress(b'\0'*4096) if idat is None else idat)+chunk(b'IEND',b'')

class ProbeTests(unittest.TestCase):
    def test_corpus_shared_image_occurrence_is_two_placements_of_one_xref(self):
        case=corpus.build_case('shared_image_occurrence')
        probe=op.build_object_probe(case['source'])
        self.assertEqual((probe['schema'],probe['status'],probe['complete'],probe['policy']),(op.SCHEMA,'available',True,'inventory-only'))
        self.assertEqual(probe['sourceSha256'],sha(case['source']))
        imgs=images(probe)
        self.assertEqual(len(imgs),2);self.assertEqual(len({o['xref'] for o in imgs}),1)
        self.assertEqual(len({o['id'] for o in imgs}),2,'one shared xref is two distinct occurrences')
        self.assertEqual([o['bbox'] for o in imgs],[[72.0,140.0,172.0,240.0],[300.0,140.0,400.0,240.0]])
        for o in imgs:
            self.assertEqual(o['capability'],'ambiguous');self.assertIn('shared-xref',o['reasons'])
            self.assertEqual(o['sharedUse'],{'placements':2,'pageCount':1,'objectReferences':2,'complete':True})
        self.assertEqual(probe['resources'],[{'xref':imgs[0]['xref'],'placements':2,'pageCount':1,'pages':[0],'objectReferences':2,'complete':True}])
        self.assertEqual(probe['operations']['replaceSharedImageOccurrence'],'unsupported')
        self.assertFalse([o for o in probe['occurrences'] if o['pageIndex']==1 and o['kind']=='image'],'control page has no image')

    def test_vector_shapes_are_separate_from_raster_and_unsupported(self):
        probe=op.build_object_probe(corpus.build_case('shared_image_occurrence')['source'],[0])
        vectors=images(probe,'vector')
        self.assertEqual(len(vectors),3)
        self.assertTrue(all(v['capability']=='unsupported' and v['reasons']==['vector-no-object-identity'] and v['xref']==0 for v in vectors))
        self.assertFalse({tuple(v['bbox']) for v in vectors}&{tuple(o['bbox']) for o in images(probe)})

    def test_unique_image_is_inspected_not_editable_claim(self):
        src=build([image((20,20,120,120))])
        (o,)=images(op.build_object_probe(src))
        self.assertEqual((o['capability'],o['reasons'],o['resourceNames']),('inspected',[],['fzImg0']))
        self.assertEqual(o['sharedUse'],{'placements':1,'pageCount':1,'objectReferences':1,'complete':True})
        self.assertEqual(o['transform'],[100.0,0.0,0.0,100.0,20.0,20.0])
        self.assertNotIn('editable',json.dumps(op.build_object_probe(src)))

    def test_same_object_across_pages_counts_source_wide(self):
        holder={}
        def first(d,p):holder['x']=p.insert_image(R(20,20,120,120),stream=png(1))
        def second(d,p):p.insert_image(R(40,40,140,140),xref=holder['x'])
        src=build([first,second])
        probe=op.build_object_probe(src,[0])
        (o,)=images(probe)
        self.assertEqual([p['pageIndex'] for p in probe['pages']],[0],'only page 0 probed')
        self.assertEqual(o['sharedUse']['placements'],2);self.assertEqual(o['sharedUse']['pageCount'],2)
        self.assertEqual(o['capability'],'ambiguous');self.assertIn('shared-xref',o['reasons'])
        self.assertEqual(probe['resources'][0]['pages'],[0,1])

    def test_inline_image_has_no_xref_and_is_unsupported(self):
        src=build([both(image((20,20,120,120)),wrap(b'',INLINE))])
        probe=op.build_object_probe(src)
        (inline,)=images(probe,'inline-image')
        self.assertEqual((inline['xref'],inline['capability'],inline['sharedUse'],inline['resourceNames']),(0,'unsupported',None,[]))
        self.assertEqual(inline['reasons'][0],'inline-image')
        self.assertEqual(images(probe)[0]['capability'],'inspected','the XObject image next to it is unaffected')

    def test_repeated_identical_bbox_is_ambiguous(self):
        src=build([both(image((20,20,120,120),1),image((20,20,120,120),2))])
        imgs=images(op.build_object_probe(src))
        self.assertEqual(len({o['xref'] for o in imgs}),2,'two distinct XObjects')
        for o in imgs:
            self.assertEqual(o['capability'],'ambiguous');self.assertIn('repeated-bbox',o['reasons']);self.assertNotIn('shared-xref',o['reasons'])

    def test_partial_clip_is_ambiguous(self):
        src=build([both(image((20,20,220,220)),wrap(b'q 20 180 100 100 re W n ',b' Q'))])
        (o,)=images(op.build_object_probe(src))
        self.assertEqual(o['capability'],'ambiguous');self.assertIn('clip-uncertain',o['reasons'])

    def test_form_xobject_placement_is_ambiguous(self):
        inner=pymupdf.open();inner.new_page(width=200,height=200).insert_image(R(10,10,110,110),stream=png(1))
        src=build([lambda d,p:p.show_pdf_page(R(0,0,200,200),inner,0)])
        (o,)=images(op.build_object_probe(src))
        self.assertEqual(o['bbox'],[10.0,10.0,110.0,110.0])
        self.assertEqual(o['capability'],'ambiguous');self.assertIn('via-form',o['reasons'])
        twice=build([lambda d,p:(p.show_pdf_page(R(0,0,150,150),inner,0),p.show_pdf_page(R(150,150,300,300),inner,0))])
        imgs=images(op.build_object_probe(twice))
        self.assertEqual(len(imgs),2);self.assertEqual(len({o['xref'] for o in imgs}),1)
        self.assertTrue(all({'via-form','shared-xref'}<=set(o['reasons']) for o in imgs),'one form drawn twice: two placements, one xref')

    def test_rotated_and_cropped_pages_are_ambiguous(self):
        for setup in (lambda p:p.set_rotation(90),lambda p:p.set_cropbox(R(10,10,290,290))):
            src=build([both(image((20,20,120,120)),lambda d,p,s=setup:s(p))])
            probe=op.build_object_probe(src)
            (o,)=images(probe)
            self.assertFalse(probe['pages'][0]['supportedGeometry'])
            self.assertEqual(o['capability'],'ambiguous');self.assertIn('page-geometry',o['reasons'])

    def test_budget_truncation_is_explicitly_incomplete(self):
        src=build([image((20,20,120,120)),image((20,20,120,120),2)])
        with patch.dict(op.LIMITS,{'maxCountPages':1}):
            probe=op.build_object_probe(src)
        self.assertFalse(probe['complete'])
        for o in images(probe):
            self.assertFalse(o['sharedUse']['complete']);self.assertIn('shared-use-incomplete',o['reasons']);self.assertEqual(o['capability'],'ambiguous')
        with patch.dict(op.LIMITS,{'maxObjects':1}):
            self.assertIn('shared-use-incomplete',images(op.build_object_probe(src))[0]['reasons'])
        with patch.dict(op.LIMITS,{'maxProbePages':1}):
            probe=op.build_object_probe(src)
        self.assertEqual((len(probe['pages']),probe['complete']),(1,False))
        busy=build([both(image((20,20,120,120)),lambda d,p:[p.draw_rect(R(150+10*k,150,155+10*k,160)) for k in range(5)])])
        with patch.dict(op.LIMITS,{'maxPageOccurrences':2}):
            probe=op.build_object_probe(busy)
        self.assertEqual((len(probe['occurrences']),probe['pages'][0]['truncated'],probe['complete']),(2,True,False))

    def test_placement_budgets_leave_count_incomplete_and_nothing_inspected(self):
        two_pages=build([image((20,20,120,120)),image((20,20,120,120),2)])
        self.assertEqual([o['capability'] for o in images(op.build_object_probe(two_pages))],['inspected','inspected'])
        with patch.dict(op.LIMITS,{'maxPlacements':1}):
            probe=op.build_object_probe(two_pages)
        self.assertFalse(probe['complete'])
        for o in images(probe):
            self.assertFalse(o['sharedUse']['complete']);self.assertIn('shared-use-incomplete',o['reasons']);self.assertEqual(o['capability'],'ambiguous')
        busy=build([both(image((20,20,60,60),1),image((80,80,120,120),2),image((140,140,180,180),3))])
        with patch.dict(op.LIMITS,{'maxPagePlacements':2}):
            probe=op.build_object_probe(busy)
        self.assertEqual((probe['complete'],probe['pages'][0]['truncated'],len(images(probe))),(False,True,2))
        self.assertTrue(all({'page-truncated','shared-use-incomplete'}<=set(o['reasons']) and o['capability']=='ambiguous' for o in images(probe)))
        self.assertEqual(len(probe['resources']),2)
        drawn=build([both(image((20,20,120,120)),lambda d,p:[p.draw_rect(R(150+10*k,150,155+10*k,160)) for k in range(3)])])
        with patch.dict(op.LIMITS,{'maxPageDrawings':1}):
            (o,)=images(op.build_object_probe(drawn))
        self.assertEqual(o['capability'],'ambiguous');self.assertIn('page-truncated',o['reasons'],'clips past the drawing budget are unknown')

    def test_ids_are_deterministic_and_bound_to_source(self):
        a=build([image((20,20,120,120))]);b=build([image((20,20,120,120),5)])
        ida=images(op.build_object_probe(a))[0]['id']
        self.assertEqual(ida,images(op.build_object_probe(a))[0]['id'])
        self.assertNotEqual(ida,images(op.build_object_probe(b))[0]['id'])
        self.assertRegex(ida,r'^occ-[0-9a-f]{24}$')

    def test_unreadable_input_is_unavailable(self):
        for bad in (b'',b'not a pdf',b'%PDF-1.7 broken',None,'text'):
            probe=op.build_object_probe(bad)
            self.assertEqual((probe['status'],probe['complete'],probe['occurrences']),('unavailable',False,[]))

    def test_probe_is_json_and_does_not_mutate_source(self):
        case=corpus.build_case('shared_image_occurrence');src=bytearray(case['source']);before=bytes(src)
        json.dumps(op.build_object_probe(src))
        self.assertEqual(bytes(src),before)

    def test_whole_foundation_corpus_probes_without_editable_claims(self):
        for case in corpus.build_corpus():
            for key in ('source','output'):
                probe=op.build_object_probe(case[key])
                self.assertEqual((probe['status'],probe['complete']),('available',True),case['id'])
                self.assertTrue(all(o['capability'] in op.CAPABILITIES and set(o['reasons'])<=set(op.REASONS) for o in probe['occurrences']))
                self.assertTrue(all(o['capability']!='inspected' for o in probe['occurrences'] if o['kind']!='image'))

def mixed():
    """Page 0: one unique image. Page 1: one XObject placed twice (shared). Synthetic marker set."""
    holder={}
    def shared(d,p):
        holder['x']=p.insert_image(R(20,20,120,120),stream=png(2));p.insert_image(R(150,150,250,250),xref=holder['x'])
    return build([image((20,20,120,120),1),shared])

class PrototypeTests(unittest.TestCase):
    def replace(self,src,occ,new=None,digest=None):
        return op.synthetic_replace_unique_image(src,digest or sha(bytes(src)),occ,png(9) if new is None else new)

    def test_unique_image_replaced_with_rendered_proof_and_shared_untouched(self):
        src=mixed();keep=bytes(src)
        probe=op.build_object_probe(src)
        unique=[o for o in images(probe) if o['capability']=='inspected']
        self.assertEqual([o['pageIndex'] for o in unique],[0])
        res=self.replace(src,unique[0]['id'])
        self.assertEqual((res['status'],res['reason'],res['schema']),('replaced',None,op.REPLACE_SCHEMA))
        self.assertEqual(res['outputSha256'],sha(res['output']));self.assertNotEqual(res['output'],src)
        self.assertEqual(src,keep,'source bytes are never modified')
        proof=res['proof']
        self.assertEqual((proof['pagesCompared'],proof['identicalPages']),(2,1))
        self.assertTrue(all(proof[k] for k in ('outsideIdentical','targetChanged','otherOccurrencesUnchanged','targetPlacementUnchanged')))
        a,b=pymupdf.open(stream=src,filetype='pdf'),pymupdf.open(stream=res['output'],filetype='pdf')
        self.assertEqual(a[1].get_pixmap().samples,b[1].get_pixmap().samples,'shared-use page renders identically')
        self.assertNotEqual(a[0].get_pixmap().samples,b[0].get_pixmap().samples)

    def test_shared_occurrence_is_refused_without_output(self):
        src=mixed()
        for o in [o for o in images(op.build_object_probe(src)) if o['pageIndex']==1]:
            res=self.replace(src,o['id'])
            self.assertEqual((res['status'],res['reason'],res['output'],res['outputSha256']),('refused','shared-xref-requires-occurrence-isolation',None,None))

    def test_identity_and_synthetic_gates(self):
        src=mixed();occ=images(op.build_object_probe(src))[0]['id']
        self.assertEqual(self.replace(src,occ,digest='0'*64)['reason'],'source-identity')
        real=build([image((20,20,120,120))],synthetic=False)
        self.assertEqual(self.replace(real,images(op.build_object_probe(real))[0]['id'])['reason'],'not-synthetic')
        case=corpus.build_case('shared_image_occurrence')
        self.assertEqual(self.replace(case['source'],images(op.build_object_probe(case['source']))[0]['id'])['reason'],'not-synthetic')
        self.assertEqual(self.replace(src,'occ-'+'0'*24)['reason'],'occurrence-not-found')
        other=build([image((20,20,120,120),7)])
        self.assertEqual(self.replace(src,images(op.build_object_probe(other))[0]['id'])['reason'],'occurrence-not-found','id bound to its source')

    def test_unsupported_and_ambiguous_occurrences_are_refused(self):
        inline=build([both(image((20,20,120,120)),wrap(b'',INLINE))])
        self.assertEqual(self.replace(inline,images(op.build_object_probe(inline),'inline-image')[0]['id'])['reason'],'unsupported-kind')
        clipped=build([both(image((20,20,220,220)),wrap(b'q 20 180 100 100 re W n ',b' Q'))])
        res=self.replace(clipped,images(op.build_object_probe(clipped))[0]['id'])
        self.assertEqual(res['reason'],'occurrence-not-inspected');self.assertIn('clip-uncertain',res['occurrenceReasons'])
        src=mixed()
        with patch.dict(op.LIMITS,{'maxCountPages':1}):
            self.assertEqual(self.replace(src,images(op.build_object_probe(src))[0]['id'])['reason'],'probe-incomplete')

    def test_invalid_replacement_is_refused(self):
        src=mixed();occ=images(op.build_object_probe(src))[0]['id']
        for bad in (b'',b'not png',png(3,alpha=True)):
            self.assertEqual(self.replace(src,occ,new=bad)['reason'],'replacement-invalid')

    def test_replacement_header_is_checked_before_any_decode(self):
        src=mixed();occ=images(op.build_object_probe(src))[0]['id']
        good=png(9);bad_crc=bytearray(good);bad_crc[29]^=0xFF
        jpeg=pymupdf.Pixmap(good).tobytes('jpeg')
        cases={'replacement-over-budget':[raw_png(65535,65535),raw_png(2049,2048),good+b'\0'*op.LIMITS['maxReplacementBytes']],
            'replacement-invalid':[jpeg,raw_png(4,4,colour=6),raw_png(4,4,colour=0),raw_png(4,4,colour=3),raw_png(4,4,depth=16),
                raw_png(0,4),bytes(bad_crc),good[:30],b'GIF89a'+good]}
        with patch.object(pymupdf,'Pixmap',side_effect=AssertionError('decoder reached')) as decoder:
            for reason,blobs in cases.items():
                for blob in blobs:
                    res=self.replace(src,occ,new=blob)
                    self.assertEqual((res['status'],res['reason'],res['output']),('refused',reason,None))
            self.assertEqual(decoder.call_count,0)
        corrupt=raw_png(4,4,idat=b'not deflate')   # header passes; the decoder still rejects the samples
        self.assertEqual(self.replace(src,occ,new=corrupt)['reason'],'replacement-invalid')

    def test_giant_pages_are_refused_before_any_raster(self):
        unique=lambda d,p:p.insert_image(R(20,20,120,120),stream=png(1))
        def mediabox_only(d,p):
            unique(d,p);d.xref_set_key(p.xref,'MediaBox','[0 0 30000 300]');d.xref_set_key(p.xref,'CropBox','[0 0 300 300]')
        sources=[build([unique],size=(5000,300)),build([unique],size=(3000,3000)),build([unique,mediabox_only])]
        with patch.object(pymupdf.Page,'get_pixmap',side_effect=AssertionError('raster reached')) as raster:
            for src in sources:
                res=op.synthetic_replace_unique_image(src,sha(src),images(op.build_object_probe(src))[0]['id'],png(9))
                self.assertEqual((res['status'],res['reason'],res['output'],res['proof']),('refused','page-over-budget',None,None))
            src=mixed();occ=images(op.build_object_probe(src))[0]['id']
            with patch.dict(op.LIMITS,{'maxProofPixels':100000}):
                self.assertEqual(self.replace(src,occ)['reason'],'page-over-budget','two 300x300 pages exceed the document budget')
            with patch.object(op,'_raster_refusal',side_effect=[None,'page-over-budget']) as preflight:
                res=self.replace(src,occ)
            self.assertEqual((res['reason'],res['output'],preflight.call_count),('output-page-over-budget',None,2))
            self.assertEqual(raster.call_count,0)
        inf=type('Doc',(),{'page_count':1,'__getitem__':lambda s,i:type('P',(),{'mediabox':R(0,0,float('inf'),100),'rect':R(0,0,100,100)})()})()
        self.assertEqual(op._raster_refusal(inf),'page-over-budget')
        self.assertEqual(self.replace(src,occ)['status'],'replaced','the same source passes inside the default budgets')

    def test_identical_replacement_fails_proof(self):
        src=build([image((20,20,120,120),1)])
        res=self.replace(src,images(op.build_object_probe(src))[0]['id'],new=png(1))
        self.assertEqual((res['status'],res['reason'],res['output']),('refused','proof-failed',None))
        self.assertFalse(res['proof']['targetChanged'])

if __name__=='__main__':unittest.main()

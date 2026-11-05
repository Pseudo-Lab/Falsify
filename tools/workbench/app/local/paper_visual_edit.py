"""Source-bound visual edits on a PDF copy; original evidence bytes stay immutable."""
import base64
import hashlib
import json
import math
import re
from pathlib import Path

SCHEMA='falsify.visual-edit-request.v1'
HEX=re.compile(r'[a-f0-9]{64}\Z')

def sha(raw):return hashlib.sha256(raw).hexdigest()
def fail(code):raise ValueError('visual_'+code)
def finite(v):return type(v) in (int,float) and math.isfinite(v)
def box(value):
    if not isinstance(value,list) or len(value)!=4 or not all(finite(v) for v in value) or value[2]<=value[0] or value[3]<=value[1]:fail('bbox_invalid')
    return list(value)
def normalize(text):return ''.join(text.split())
def _decode_png(value):
    from image_edit_service import png_dimensions
    if not isinstance(value,str) or len(value)>6*1024*1024:fail('png_limit')
    try:raw=base64.b64decode(value,validate=True);png_dimensions(raw,max_side=8192,max_pixels=4_000_000)
    except (ValueError,TypeError):fail('png_invalid')
    if len(raw)>4*1024*1024:fail('png_limit')
    return raw

def _span(page,rect):
    spans=[s for b in page.get_text('dict',clip=rect).get('blocks',[]) for l in b.get('lines',[]) for s in l.get('spans',[]) if s.get('text','').strip()]
    return max(spans,key=lambda s:len(s['text'])) if spans else {'font':'Helvetica','size':10,'color':0}

def _fallback_font_path(source,text):
    root=Path(__file__).resolve().parents[1]/'dist'
    serif=any(s in source for s in ('times','serif','roman','garamond'))
    if any(ord(c)>0x2ff for c in text):path=root/'font-assets'/('NotoSerifCJKkr-Regular.otf' if serif else 'NotoSansCJKkr-Regular.otf')
    elif serif:path=root/'font-assets'/('LiberationSerif-Bold.ttf' if 'bold' in source else 'LiberationSerif-Italic.ttf' if any(s in source for s in ('italic','oblique')) else 'LiberationSerif-Regular.ttf')
    else:path=root/'recomposition-vendor'/('LiberationSans-Bold.ttf' if 'bold' in source else 'LiberationSans-Italic.ttf' if any(s in source for s in ('italic','oblique')) else 'LiberationSans-Regular.ttf')
    return path


def _embedded_font(doc,page,source,name,text,pdf,clean):
    for entry in page.get_fonts(full=True):
        if clean(entry[3])!=source or not entry[0]:continue
        try:
            raw=doc.extract_font(entry[0])[3]
            if not raw or len(raw)>10*1024*1024:continue
            font=pdf.Font(fontbuffer=raw)
            if all(c.isspace() or font.has_glyph(ord(c)) for c in text):
                page.insert_font(fontname=name,fontbuffer=raw)
                return name,False,font
        except (RuntimeError,ValueError):continue
    return None


def _font(doc,page,span,text,number):
    import pymupdf as pdf
    clean=lambda name:re.sub(r'^[A-Z]{6}\+','',name).replace(' ','').lower()
    source=clean(span.get('font','Helvetica'));name='FVisual'+str(number)
    embedded=_embedded_font(doc,page,source,name,text,pdf,clean)
    if embedded is not None:return embedded
    base={'helvetica':'helv','helveticabold':'hebo','helvetica-bold':'hebo','helvetica-oblique':'heit','times-roman':'tiro','timesnewroman':'tiro','times-bold':'tibo','times-italic':'tiit','courier':'cour'}
    builtin=base.get(source)
    if builtin and all(ord(c)<256 or c.isspace() for c in text):return builtin,False,pdf.Font(fontname=builtin)
    path=_fallback_font_path(source,text)
    font=pdf.Font(fontfile=str(path))
    if not all(c.isspace() or font.has_glyph(ord(c)) for c in text):fail('font_glyph_missing')
    page.insert_font(fontname=name,fontfile=str(path))
    return name,True,font

def _view_box(page,value):
    import pymupdf as pdf
    public=pdf.Rect(box(value))
    if not page.rect.contains(public):fail('bbox_outside_page')
    return public,public*page.derotation_matrix

def _table_plan(op,store,paper_id,doc):
    item=store.read_item(paper_id,op.get('itemId'))
    if item.get('type')!='table':fail('table_missing')
    row,column=op.get('row'),op.get('column')
    if type(row) is not int or type(column) is not int:fail('cell_invalid')
    cell=next((c for c in item['table']['cells'] if c['row']==row and c['column']==column),None)
    if cell is None:fail('cell_missing')
    if type(op.get('before')) is not str or op['before']!=cell['text']:fail('before_mismatch')
    after=op.get('after')
    if not isinstance(after,str) or len(after)>4000 or '\x00' in after:fail('cell_text_invalid')
    page=doc[item['pageIndex']];public,rect=_view_box(page,cell['bbox'])
    return {'op':op,'pageIndex':item['pageIndex'],'public':public,'rect':rect,'span':_span(page,rect),'before':cell['text'],'after':after}

def _snapshot_scenes(ops,default_service,paper_id,digest):
    scenes = {}
    with default_service.lock:
        for op in ops:
            if isinstance(op,dict) and op.get('kind') == 'chart-shape' and isinstance(op.get('plan'),dict):
                plan=op['plan']; scene_id=plan.get('sceneId'); entry=default_service.scenes.get(scene_id)
                if not entry or entry['expires'] <= default_service.clock(): raise ValueError('chart_scene_expired')
                if entry['paperId'] != paper_id or entry['scene']['sourceFileHash'] != digest: fail('source_mismatch')
                import copy
                scenes[scene_id]=copy.deepcopy(entry)
    return scenes


def _validate_scene_snapshots(scenes,default_service):
    for scene_id, entry in scenes.items():
        current = default_service.scenes.get(scene_id)
        if current != entry or current['expires'] <= default_service.clock(): raise ValueError('chart_scene_expired')


def _snapshot_table_items(ops,store,paper_id):
    items = {}
    for op in ops:
        if isinstance(op,dict) and op.get('kind') == 'table-cell':
            item_id = op.get('itemId')
            items[item_id] = store.read_item(paper_id,item_id)
    return items


def export_visual(request,*,store=None,cancelled=None):
    """Snapshot authorized source and selected bindings before native child work."""
    from paper_evidence import default_store
    from paper_chart_edit_service import default_service
    from paper_native_worker import run, budget, check
    deadline = budget()
    store = store if store is not None else default_store
    if not isinstance(request,dict) or request.get('schema') != SCHEMA: fail('request_invalid')
    paper_id, digest, ops = request.get('paperId'), request.get('fileHash'), request.get('operations')
    if not isinstance(paper_id,str) or not isinstance(digest,str) or not HEX.fullmatch(digest): fail('source_invalid')
    if not isinstance(ops,list) or not 1 <= len(ops) <= 24: fail('operation_limit')
    try: raw = store.source_bytes(paper_id,digest)
    except KeyError: fail('source_expired')
    if sha(raw) != digest: fail('source_mismatch')
    items = _snapshot_table_items(ops,store,paper_id)
    scenes = _snapshot_scenes(ops,default_service,paper_id,digest)
    result=run('visual_export', [request,raw,items,scenes], cancelled=cancelled, deadline=deadline)
    try: output=base64.b64decode(result['file'],validate=True)
    except (KeyError,ValueError,TypeError): raise ValueError('native_output_invalid') from None
    if len(output)>50*1024*1024 or sha(output)!=result.get('outputSha256') or result.get('sourceSha256')!=digest:
        raise ValueError('native_output_invalid')
    with _source_authority(store, paper_id, digest, raw):
        with default_service.lock:
            check(deadline, cancelled)
            _validate_scene_snapshots(scenes,default_service)
    return result

def _source_authority(store, paper_id, digest, raw):
    from contextlib import contextmanager
    if hasattr(store, 'source_authority'): return store.source_authority(paper_id, digest, raw)
    @contextmanager
    def authority():
        if store.source_bytes(paper_id, digest) != raw: fail('source_mismatch')
        yield
    return authority()

def _region_plan(op,store,paper_id,doc):
    if set(op)-{'id','kind','assetKind','pageIndex','bbox','beforeImageSha256','png','dataChanges'} or op.get('assetKind') not in ('graph','figure'):fail('operation_invalid')
    page_index=op.get('pageIndex')
    if type(page_index) is not int or not 0<=page_index<len(doc):fail('page_invalid')
    page=doc[page_index];public,rect=_view_box(page,op.get('bbox'))
    before=store.render_region(paper_id,page_index,bbox=list(public),dpi=150)
    if op.get('beforeImageSha256')!=before['sha256']:fail('image_mismatch')
    png=_decode_png(op.get('png'))
    try:encoded=json.dumps(op.get('dataChanges'),allow_nan=False,ensure_ascii=False)
    except (ValueError,TypeError):fail('data_changes_invalid')
    if len(encoded)>512000:fail('data_changes_limit')
    plan={'op':op,'pageIndex':page_index,'public':public,'rect':rect,'png':png,'before':{'imageSha256':before['sha256']}}
    return plan


def _check_visual_overlap(plan,plans,shape_boxes,pdf):
    if any(p['pageIndex']==plan['pageIndex'] and (p['public']&plan['public']).get_area()>.01 for p in plans):fail('operations_overlap')
    if any(page==plan['pageIndex'] and (pdf.Rect(rect)&plan['public']).get_area()>.01 for page,rect in shape_boxes):fail('operations_overlap')


def _plan_visual_operations(ops, store, paper_id, doc, shape_boxes, pdf):
    plans=[];ids=set()
    for op in ops:
        if not isinstance(op,dict) or not isinstance(op.get('id'),str) or not 1<=len(op['id'])<=80 or op['id'] in ids:fail('operation_invalid')
        ids.add(op['id'])
        if op.get('kind')=='chart-shape':continue
        if op.get('kind')=='table-cell':
            if set(op)-{'id','kind','itemId','row','column','before','after'}:fail('operation_invalid')
            plan=_table_plan(op,store,paper_id,doc)
        elif op.get('kind')=='region':
            plan=_region_plan(op,store,paper_id,doc)
        else:fail('operation_invalid')
        _check_visual_overlap(plan,plans,shape_boxes,pdf)
        plans.append(plan)
    return plans


def _cell_target(rect,span,pdf):
    inset=min(2,rect.width*.03,rect.height*.06)
    target=pdf.Rect(rect.x0+inset,rect.y0+inset,rect.x1-inset,rect.y1-inset)
    align=0
    original_box=span.get('bbox')
    if original_box:
        old=pdf.Rect(original_box)
        target.y0=max(target.y0,min(old.y0,target.y1-5))
        left_gap=max(inset,old.x0-rect.x0);right_gap=max(inset,rect.x1-old.x1)
        if abs((old.x0+old.x1)-(rect.x0+rect.x1))<4:
            align=1
        elif right_gap<left_gap:
            align=2;target.x1=rect.x1-right_gap
        else:target.x0=rect.x0+left_gap
    return target,align


def _apply_visual_cell(doc, page, plan, number, record, issues, pdf):
    op=plan['op'];rect=plan['rect']
    span=plan['span'];font,substituted,font_metrics=_font(doc,page,span,plan['after'],number)
    # Redact only glyphs; leave table rules and images untouched.
    page.add_redact_annot(rect,fill=False,cross_out=False)
    page.apply_redactions(images=0,graphics=0,text=0)
    target,align=_cell_target(rect,span,pdf)
    size=max(5,min(float(span.get('size',10)),target.height*.7));original_size=size
    color=span.get('color',0);color=((color>>16&255)/255,(color>>8&255)/255,(color&255)/255)
    fitted=not plan['after']
    if plan['after']:
        length=font_metrics.text_length(plan['after'],fontsize=size)
        if '\n' not in plan['after'] and '\r' not in plan['after'] and length<=target.width and span.get('origin'):
            x=target.x1-length if align==2 else (target.x0+target.x1-length)/2 if align==1 else target.x0
            page.insert_text((x,span['origin'][1]),plan['after'],fontname=font,fontsize=size,color=color,overlay=True)
            fitted=True
        else:
            while size>=5:
                rc=page.insert_textbox(target,plan['after'],fontname=font,fontsize=size,color=color,rotate=0,align=align,overlay=True)
                if rc>=0:fitted=True;break
                size=round(size-.25,3)
    if not fitted:fail('cell_text_no_room')
    if substituted:issues.append({'id':op['id'],'code':'font-substituted'})
    if size<original_size-.1:issues.append({'id':op['id'],'code':'cell-font-reduced','fontSize':size})
    record.update(after=plan['after'],itemId=op['itemId'],row=op['row'],column=op['column'])
    # In rotated views extraction still uses unrotated PDF coordinates.
    if normalize(plan['after']) not in normalize(page.get_text('text',clip=rect)):
        issues.append({'id':op['id'],'code':'after-text-unconfirmed'})


def _apply_visual_plans(doc, plans, changes, issues, pdf):
    for number,plan in enumerate(plans):
        op=plan['op'];page=doc[plan['pageIndex']];rect=plan['rect'];public=plan['public']
        record={'id':op['id'],'kind':op['kind'],'pageIndex':plan['pageIndex'],'bbox':list(public),'before':plan['before'],'author':'human'}
        if op['kind']=='table-cell':
            if plan['before']==plan['after']: continue
            _apply_visual_cell(doc, page, plan, number, record, issues, pdf)
        else:
            # Preserve spanning image resources; paint only the exact selected view region.
            # Pixel blanking can erase neighboring low-resolution source pixels.
            page.add_redact_annot(rect,fill=False,cross_out=False)
            page.apply_redactions(images=0,graphics=0,text=0)
            page.draw_rect(rect,color=None,fill=(1,1,1),overlay=True)
            page.insert_image(rect,stream=plan['png'],keep_proportion=False,rotate=page.rotation,overlay=True)
            image=page.get_pixmap(clip=public,dpi=150,alpha=False).tobytes('png')
            plan['renderedSha256']=sha(image)
            record.update(assetKind=op['assetKind'],after={'imageSha256':sha(image),'replacementSha256':sha(plan['png'])})
            if op.get('dataChanges') is not None:record['dataChanges']=op['dataChanges']
        changes.append(record)


def _verify_saved_plan(saved,plan,issues):
    if plan['op']['kind']=='table-cell' and plan['before']!=plan['after'] and plan['after']:
        if plan['pageIndex']>=len(saved) or normalize(plan['after']) not in normalize(saved[plan['pageIndex']].get_text('text',clip=plan['rect'])):
            issues.append({'id':plan['op']['id'],'code':'saved-after-text-unconfirmed'})
    if plan['op']['kind']=='region':
        image=saved[plan['pageIndex']].get_pixmap(clip=plan['public'],dpi=150,alpha=False).tobytes('png')
        if sha(image)!=plan['renderedSha256']:
            issues.append({'id':plan['op']['id'],'code':'saved-image-unconfirmed'})


def _verify_visual_saved(original, output, regions, plans, issues, pdf):
    checks=[]
    try:
        from paper_native_worker import run
        issues.extend(run('verify', [original,output,regions]))
        checks=['page-count']
        if not any(issue.get('code')=='page-count-changed' for issue in issues):
            checks.extend(['outside-region-text','outside-region-pixels'])
        with pdf.open(stream=output,filetype='pdf') as saved:
            for plan in plans:
                _verify_saved_plan(saved,plan,issues)
        if any(p['op']['kind']=='table-cell' and p['before']!=p['after'] for p in plans): checks.append('saved-cell-text')
        if any(p['op']['kind']=='region' for p in plans): checks.append('saved-image-render')
    except Exception:
        issues.append({'code':'source-preservation-check-failed'})
    return checks


def _validate_visual_request(request):
    if not isinstance(request,dict) or set(request)-{'schema','paperId','fileHash','revision','operations'} or request.get('schema')!=SCHEMA:fail('request_invalid')
    digest=request.get('fileHash');paper_id=request.get('paperId');revision=request.get('revision')
    if not isinstance(digest,str) or not HEX.fullmatch(digest) or not isinstance(paper_id,str) or not 1<=len(paper_id)<=160:fail('source_invalid')
    if not isinstance(revision,(str,int)) or isinstance(revision,bool) or len(str(revision))>200:fail('revision_invalid')
    ops=request.get('operations')
    if not isinstance(ops,list) or not 1<=len(ops)<=24:fail('operation_limit')
    return digest,paper_id,revision,ops


def _apply_shape_ops(ops,paper_id,digest,raw,pdf):
    shape_ops=[op for op in ops if isinstance(op,dict) and op.get('kind')=='chart-shape']
    shape_changes=[];shape_issues=[];shape_boxes=[]
    if shape_ops:
        from paper_chart_edit_service import default_service
        for op in shape_ops:
            if set(op)!={'id','kind','plan'} or not isinstance(op.get('plan'),dict):fail('operation_invalid')
            plan=op['plan']
            if plan.get('paperId')!=paper_id or plan.get('fileHash')!=digest:fail('source_mismatch')
            result=default_service.export(plan,source_override=raw)
            for change in result['changes']:
                if any(p==change['pageIndex'] and (pdf.Rect(b)&pdf.Rect(change['bbox'])).get_area()>.01 for p,b in shape_boxes):fail('operations_overlap')
                shape_boxes.append((change['pageIndex'],change['bbox']))
            raw=base64.b64decode(result['file'],validate=True)
            shape_changes.extend(result['changes']);shape_issues.extend(result['verification']['issues'])
    return raw,shape_ops,shape_changes,shape_issues,shape_boxes


def _shape_only_result(original,raw,digest,shape_boxes,shape_changes,shape_issues,pdf):
    with pdf.open(stream=raw,filetype='pdf') as check:count=len(check)
    checks=[]
    try:
        from paper_native_worker import run
        shape_issues.extend(run('verify', [original, raw, shape_boxes]))
        checks=['page-count']
        if not any(issue.get('code')=='page-count-changed' for issue in shape_issues):
            checks.extend(['outside-region-text','outside-region-pixels'])
    except Exception:
        shape_issues.append({'code':'source-preservation-check-failed'})
    return {'schema':'falsify.visual-edit-export.v1','sourceSha256':digest,'outputSha256':sha(raw),
        'file':base64.b64encode(raw).decode('ascii'),'pageCount':count,'changes':shape_changes,
        'verification':{'status':'warning' if shape_issues else 'passed','issues':shape_issues,'pageCount':count,
            'checks':checks,'scope':'source-preservation'}}


def _export_visual_native(request,*,store=None):
    import pymupdf as pdf
    from paper_evidence import default_store
    store=store if store is not None else default_store
    digest,paper_id,revision,ops=_validate_visual_request(request)
    try:raw=store.source_bytes(paper_id,digest)
    except KeyError:fail('source_expired')
    if sha(raw)!=digest:fail('source_mismatch')
    original=raw
    seen_ids=set()
    for op in ops:
        if not isinstance(op,dict) or not isinstance(op.get('id'),str) or not 1<=len(op['id'])<=80 or op['id'] in seen_ids:fail('operation_invalid')
        seen_ids.add(op['id'])
    raw,shape_ops,shape_changes,shape_issues,shape_boxes=_apply_shape_ops(ops,paper_id,digest,raw,pdf)
    if shape_ops and len(shape_ops)==len(ops):
        return _shape_only_result(original,raw,digest,shape_boxes,shape_changes,shape_issues,pdf)
    doc=pdf.open(stream=raw,filetype='pdf');plans=[];ids=set();issues=list(shape_issues);changes=list(shape_changes)
    try:
        source_pages=len(doc)
        plans=_plan_visual_operations(ops, store, paper_id, doc, shape_boxes, pdf)
        # Plan every operation against the immutable source before applying any.
        _apply_visual_plans(doc, plans, changes, issues, pdf)
        output=doc.tobytes(garbage=4,deflate=True) if changes else original
        from paper_chart_edit_service import _verify_output
        regions=shape_boxes+[(p['pageIndex'],list(p['public'])) for p in plans if p['op']['kind']!='table-cell' or p['before']!=p['after']]
        checks=_verify_visual_saved(original, output, regions, plans, issues, pdf)
        return {'schema':'falsify.visual-edit-export.v1','sourceSha256':digest,'outputSha256':sha(output),
                'file':base64.b64encode(output).decode('ascii'),'pageCount':source_pages,'changes':changes,
                'verification':{'status':'warning' if issues else 'passed','issues':issues,'engine':'pymupdf','pageCount':source_pages,
                    'checks':checks,'scope':'source-preservation'}}
    finally:doc.close()

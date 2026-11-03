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

def _font(doc,page,span,text,number):
    import pymupdf as pdf
    clean=lambda name:re.sub(r'^[A-Z]{6}\+','',name).replace(' ','').lower()
    source=clean(span.get('font','Helvetica'));name='FVisual'+str(number)
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
    base={'helvetica':'helv','helveticabold':'hebo','helvetica-bold':'hebo','helvetica-oblique':'heit','times-roman':'tiro','timesnewroman':'tiro','times-bold':'tibo','times-italic':'tiit','courier':'cour'}
    builtin=base.get(source)
    if builtin and all(ord(c)<256 or c.isspace() for c in text):return builtin,False,pdf.Font(fontname=builtin)
    root=Path(__file__).resolve().parents[1]/'dist'
    serif=any(s in source for s in ('times','serif','roman','garamond'))
    if any(ord(c)>0x2ff for c in text):path=root/'font-assets'/('NotoSerifCJKkr-Regular.otf' if serif else 'NotoSansCJKkr-Regular.otf')
    elif serif:path=root/'font-assets'/('LiberationSerif-Bold.ttf' if 'bold' in source else 'LiberationSerif-Italic.ttf' if any(s in source for s in ('italic','oblique')) else 'LiberationSerif-Regular.ttf')
    else:path=root/'recomposition-vendor'/('LiberationSans-Bold.ttf' if 'bold' in source else 'LiberationSans-Italic.ttf' if any(s in source for s in ('italic','oblique')) else 'LiberationSans-Regular.ttf')
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

def export_visual(request,*,store=None):
    import pymupdf as pdf
    from paper_evidence import default_store
    store=store if store is not None else default_store
    if not isinstance(request,dict) or set(request)-{'schema','paperId','fileHash','revision','operations'} or request.get('schema')!=SCHEMA:fail('request_invalid')
    digest=request.get('fileHash');paper_id=request.get('paperId');revision=request.get('revision')
    if not isinstance(digest,str) or not HEX.fullmatch(digest) or not isinstance(paper_id,str) or not 1<=len(paper_id)<=160:fail('source_invalid')
    if not isinstance(revision,(str,int)) or isinstance(revision,bool) or len(str(revision))>200:fail('revision_invalid')
    ops=request.get('operations')
    if not isinstance(ops,list) or not 1<=len(ops)<=24:fail('operation_limit')
    try:raw=store.source_bytes(paper_id,digest)
    except KeyError:fail('source_expired')
    if sha(raw)!=digest:fail('source_mismatch')
    doc=pdf.open(stream=raw,filetype='pdf');plans=[];ids=set();issues=[];changes=[]
    try:
        source_pages=len(doc)
        for op in ops:
            if not isinstance(op,dict) or not isinstance(op.get('id'),str) or not 1<=len(op['id'])<=80 or op['id'] in ids:fail('operation_invalid')
            ids.add(op['id'])
            if op.get('kind')=='table-cell':
                if set(op)-{'id','kind','itemId','row','column','before','after'}:fail('operation_invalid')
                plan=_table_plan(op,store,paper_id,doc)
            elif op.get('kind')=='region':
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
            else:fail('operation_invalid')
            if any(p['pageIndex']==plan['pageIndex'] and (p['public']&plan['public']).get_area()>.01 for p in plans):fail('operations_overlap')
            plans.append(plan)
        # Plan every operation against the immutable source before applying any.
        for number,plan in enumerate(plans):
            op=plan['op'];page=doc[plan['pageIndex']];rect=plan['rect'];public=plan['public']
            record={'id':op['id'],'kind':op['kind'],'pageIndex':plan['pageIndex'],'bbox':list(public),'before':plan['before'],'author':'human'}
            if op['kind']=='table-cell':
                span=plan['span'];font,substituted,font_metrics=_font(doc,page,span,plan['after'],number)
                # Redact only glyphs; leave table rules and images untouched.
                page.add_redact_annot(rect,fill=False,cross_out=False)
                page.apply_redactions(images=0,graphics=0,text=0)
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
            else:
                # Preserve spanning image resources; paint only the exact selected view region.
                # Pixel blanking can erase neighboring low-resolution source pixels.
                page.add_redact_annot(rect,fill=False,cross_out=False)
                page.apply_redactions(images=0,graphics=0,text=0)
                page.draw_rect(rect,color=None,fill=(1,1,1),overlay=True)
                page.insert_image(rect,stream=plan['png'],keep_proportion=False,rotate=page.rotation,overlay=True)
                image=page.get_pixmap(clip=public,dpi=150,alpha=False).tobytes('png')
                record.update(assetKind=op['assetKind'],after={'imageSha256':sha(image),'replacementSha256':sha(plan['png'])})
                if op.get('dataChanges') is not None:record['dataChanges']=op['dataChanges']
            changes.append(record)
        output=doc.tobytes(garbage=4,deflate=True)
        with pdf.open(stream=output,filetype='pdf') as reopened:
            if len(reopened)!=source_pages:fail('page_count_changed')
        return {'schema':'falsify.visual-edit-export.v1','sourceSha256':digest,'outputSha256':sha(output),
                'file':base64.b64encode(output).decode('ascii'),'pageCount':source_pages,'changes':changes,
                'verification':{'status':'warning' if issues else 'passed','issues':issues,'engine':'pymupdf','pageCount':source_pages}}
    finally:doc.close()

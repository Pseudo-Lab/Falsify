"""Cartesian colored-curve digitization from original pixels and OCR axis ticks.

No tick is corrected or synthesized. A robust fit can exclude an inconsistent
OCR tick and records it. Ambiguous dual-axis bindings retain both candidates.
"""
import hashlib
import itertools
import math
import re


def _value(text):
    value=text.strip().replace('−','-').replace(',','')
    superscripts=str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺','0123456789-+')
    power=re.fullmatch(r'10\s*(?:\^\s*([+-]?\d+)|([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+))',value)
    if power:
        try:return 10**int((power[1] or power[2]).translate(superscripts)),True
        except (ValueError,OverflowError):return None,False
    try:
        number=float(value)
        return (number,False) if math.isfinite(number) else (None,False)
    except ValueError:return None,False


def _score_axis_pair(a,b,scale,valid,ticks,extent):
    pa,pb=a['pixel'],b['pixel']
    va,vb=(math.log10(t['value']) if scale=='log' else t['value'] for t in (a,b))
    if abs(pb-pa)<extent*.15 or va==vb:return None
    slope=(vb-va)/(pb-pa);intercept=va-slope*pa
    inliers=[];errors=[]
    for tick in valid:
        v=math.log10(tick['value']) if scale=='log' else tick['value']
        error=abs((v-intercept)/slope-tick['pixel'])
        if error<=max(3,extent*.009):inliers.append(tick);errors.append(error)
    explicit=scale=='log' and len(inliers)==2 and all(t.get('explicitLog') for t in inliers)
    if len(inliers)<3 and not explicit:return None
    if len(inliers)<len(ticks)*.6:return None
    return (len(inliers),-sum(errors)/len(errors),scale,inliers)


def _axis_candidates(ticks,extent):
    candidates=[]
    for scale in ('linear','log'):
        valid=[t for t in ticks if scale=='linear' or t['value']>0]
        for a,b in itertools.combinations(valid,2):
            candidate=_score_axis_pair(a,b,scale,valid,ticks,extent)
            if candidate is not None:candidates.append(candidate)
    return candidates


def fit_axis(ticks, extent):
    """Robust pixel->value calibration. Three inliers, or two explicit powers."""
    candidates=_axis_candidates(ticks,extent)
    if not candidates:return None
    candidates.sort(key=lambda x:(x[0],round(x[1],4),x[2]=='linear'),reverse=True)
    _,_,scale,used=candidates[0]
    px=[t['pixel'] for t in used];vs=[math.log10(t['value']) if scale=='log' else t['value'] for t in used]
    mp=sum(px)/len(px);mv=sum(vs)/len(vs)
    slope=sum((p-mp)*(v-mv) for p,v in zip(px,vs))/sum((p-mp)**2 for p in px)
    intercept=mv-slope*mp
    return {'scale':scale,'slope':slope,'intercept':intercept,'ticks':ticks,'usedTicks':used,
            'rejectedTicks':[t for t in ticks if t not in used],
            'residualPixels':max(abs((v-intercept)/slope-p) for p,v in zip(px,vs))}


def axis_value(axis,pixel):
    v=axis['slope']*pixel+axis['intercept']
    return 10**v if axis['scale']=='log' else v


def _groups(values):
    out=[]
    for n in values:
        if not out or n>out[-1][-1]+1:out.append([n])
        else:out[-1].append(n)
    return out


def _frame_verticals(left,right,verticals,vm,bottom,width,height,np):
    snapped=[];tops=[]
    for x in (left,right):
        near=[v for v in verticals if abs(v-x)<=max(12,width*.02)]
        if near:x=min(near,key=lambda v:abs(v-x))
        snapped.append(x)
        ys=np.where((vm[:,max(0,x-2):x+3]>0).any(axis=1))[0]
        ys=ys[ys<=bottom]
        if len(ys)>height*.3:tops.append(int(ys[0]))
    return snapped,tops


def _frame(gray,cv,np):
    height,width=gray.shape
    dark=(gray<130).astype('uint8')*255
    hm=cv.morphologyEx(dark,cv.MORPH_OPEN,np.ones((1,max(30,int(width*.25))),np.uint8))
    rows=[]
    for ys in _groups(np.where((hm>0).sum(axis=1)>width*.35)[0].tolist()):
        y=int(sum(ys)/len(ys));xs=np.where(hm[y]>0)[0]
        if len(xs):rows.append((y,int(xs[0]),int(xs[-1])))
    if not rows:return None
    largest=max(x1-x0 for y,x0,x1 in rows)
    choices=[r for r in rows if r[2]-r[1]>=largest*.85 and height*.3<r[0]<height*.94]
    if not choices:return None
    bottom,left,right=max(choices,key=lambda r:r[0])
    vm=cv.morphologyEx(dark,cv.MORPH_OPEN,np.ones((max(30,int(height*.3)),1),np.uint8))
    vertical_groups=_groups(np.where((vm>0).sum(axis=0)>height*.3)[0].tolist())
    verticals=[int(sum(group)/len(group)) for group in vertical_groups]
    snapped,tops=_frame_verticals(left,right,verticals,vm,bottom,width,height,np)
    if not tops:return None
    left,right=snapped
    top=min(tops)
    if right-left<width*.35 or bottom-top<height*.3:return None
    return [left,top,right,bottom]


def _hue_color(image,box,cv,np):
    x0,y0,x1,y1=[int(v) for v in box]
    roi=image[max(0,y0):min(image.shape[0],y1+1),max(0,x0):min(image.shape[1],x1+1)]
    if roi.size==0:return None
    hsv=cv.cvtColor(roi,cv.COLOR_BGR2HSV);mask=(hsv[:,:,1]>90)&(hsv[:,:,2]>70)
    if mask.sum()<5:return None
    return float(np.median(hsv[:,:,0][mask]))


def _tick_value(image,text,box,cv,np):
    """Recover a flattened exponent only when the source glyph is raised/smaller."""
    match=re.fullmatch(r'\s*(?:(\d+(?:\.\d+)?)\s*[×x]\s*)?10([+-]?\d{1,3})\s*',text)
    if match:
        x0,y0,x1,y1=[int(v) for v in box]
        roi=image[max(0,y0):y1+1,max(0,x0):x1+1]
        if roi.size:
            gray=cv.cvtColor(roi,cv.COLOR_BGR2GRAY)
            _,_,stats,_=cv.connectedComponentsWithStats((gray<160).astype('uint8'))
            glyphs=sorted([s for s in stats[1:] if s[4]>8 and s[3]>=5],key=lambda s:s[0])
            if len(glyphs)>=3:
                last=glyphs[-1];base=glyphs[-3:-1]
                baseline=float(np.median([s[1]+s[3] for s in base]));size=float(np.median([s[3] for s in base]))
                if last[3]<size*.86 and last[1]+last[3]<baseline-max(2,size*.15):
                    try:
                        value=float(match[1] or 1)*10.0**int(match[2])
                        if math.isfinite(value) and value>0:return value,True
                    except OverflowError:pass
    return _value(text)


def _tick_side(x0,x1,cx,cy,left,top,right,bottom,width,height):
    side=None
    if bottom+3<=cy<=bottom+min(70,height*.12) and left-10<=cx<=right+10:side='x'
    elif x1<=left+4 and x0>=left-width*.18 and top-15<=cy<=bottom+15:side='left'
    elif x0>=right-4 and x1<=right+width*.18 and top-15<=cy<=bottom+15:side='right'
    return side


def _ticks(lines,frame,width,height,image,cv,np):
    left,top,right,bottom=frame;out={'x':[],'left':[],'right':[]}
    for line in lines:
        box=line.get('bbox');text=line.get('text')
        if not isinstance(box,list) or len(box)!=4 or not isinstance(text,str):continue
        value,explicit=_tick_value(image,text,box,cv,np)
        if value is None:continue
        x0,y0,x1,y1=box;cx=(x0+x1)/2;cy=(y0+y1)/2
        side=_tick_side(x0,x1,cx,cy,left,top,right,bottom,width,height)
        if side:out[side].append({'text':text,'bbox':box,'value':value,'pixel':cx if side=='x' else cy,'explicitLog':explicit})
    return out


def _fit_geometry_axes(ticks,frame,image,cv,np,result):
    left,top,right,bottom=frame
    for side in ('x','left','right'):
        axis=fit_axis(ticks[side],right-left if side=='x' else bottom-top)
        if axis:
            hues=[_hue_color(image,t['bbox'],cv,np) for t in axis['usedTicks']]
            colors=[h for h in hues if h is not None];axis['hue']=float(np.median(colors)) if colors else None
            result['axes'][side]=axis
            if axis['rejectedTicks']:result['issues'].append('axis-ocr-outlier-'+side)


def _geometry_color_mask(hue,roi,mask,frame,ocr_lines,np):
    left,top,right,bottom=frame
    if hue is None:
        cm=(roi[:,:,1]<50)&(roi[:,:,2]<125)
        # Remove full-width grid lines and legend text, leaving the
        # source curve pixels. Flat grid/curve ambiguity is not guessed.
        cm[(cm.sum(axis=1)>(right-left)*.75),:]=False
        cm[:,(cm.sum(axis=0)>(bottom-top)*.75)]=False
        for line in ocr_lines:
            text=line.get('text','');box=line.get('bbox')
            if len(text)>2 and _value(text)[0] is None and isinstance(box,list):
                x0,y0,x1,y1=[int(v) for v in box]
                if left<x0<x1<right and top<y0<y1<bottom:cm[max(0,y0-top-3):y1-top,max(0,x0-left-3):x1-left]=False
    else:
        delta=np.abs(roi[:,:,0].astype(int)-hue);cm=mask&((delta<6)|(delta>174))
    return cm


def _geometry_candidates(image,frame,ocr_lines,cv,np,trace_mask,result):
    left,top,right,bottom=frame
    hsv=cv.cvtColor(image,cv.COLOR_BGR2HSV);roi=hsv[top+2:bottom-1,left+2:right-1]
    mask=(roi[:,:,1]>90)&(roi[:,:,2]>70);counts=np.bincount(roi[:,:,0][mask],minlength=180)
    selected=[]
    for hue in np.argsort(counts)[::-1]:
        hue=int(hue)
        if counts[hue]<20:break
        if any(min(abs(hue-h),180-abs(hue-h))<9 for h in selected):continue
        selected.append(hue)
        if len(selected)==8:break
    candidates=[]
    for hue in [*selected,None]:
        cm=_geometry_color_mask(hue,roi,mask,frame,ocr_lines,np)
        traced=trace_mask(cm, max_gap=max(6, int((right-left)*.025)), min_columns=12)
        accepted=[]
        for trace in traced['traces']:
            columns=trace['columns']
            if len(columns)<12 or columns[-1]['x']-columns[0]['x']<(right-left)*.35:continue
            thickness=[c['high']-c['low']+1 for c in columns]
            if float(np.median(thickness))>max(18,(bottom-top)*.035):continue
            accepted.append((hue,trace))
        if accepted:
            candidates.extend(accepted)
            result['issues'].extend(code for code in traced.get('issues',[]) if code not in result['issues'])
    return candidates


def _geometry_binding(hue,axes):
    possible=[s for s in ('left','right') if s in axes]
    binding=possible[0] if len(possible)==1 else 'ambiguous'
    if len(possible)==2 and hue is not None:
        distances={s:min(abs(hue-axes[s]['hue']),180-abs(hue-axes[s]['hue'])) for s in possible if axes[s]['hue'] is not None}
        matches=[s for s,d in distances.items() if d<10]
        if len(matches)==1:binding=matches[0]
    return possible,binding


def _append_geometry_series(hue,trace,axes,budget,origin_x,origin_y,tick_columns,cv,np,sample_trace,result):
    possible,binding=_geometry_binding(hue,axes)
    # Resampled raster strokes have stepped centers. Keep the reduction
    # error below a quarter of the observed band thickness (0.75–3 px),
    # rather than spending the row budget describing raster stair steps.
    tolerance=max(.75,min(3.0,float(np.median([c['high']-c['low']+1 for c in trace['columns']]))*.25))
    sampled=sample_trace(trace['columns'],x_ticks=tick_columns,max_points=budget,tolerance_px=tolerance)
    result['issues'].extend(code for code in sampled.get('issues',[]) if code not in result['issues'])
    points=[]
    for column in sampled['points']:
        xp=float(column['x'])+origin_x;yp=float(column['y'])+origin_y
        values={s:axis_value(axes[s],yp) for s in possible}
        point={'xPixel':xp,'yPixel':yp,'x':axis_value(axes['x'],xp),'valueCandidates':values}
        if binding!='ambiguous':
            point['y']=values[binding]
            low=float(column['low'])+origin_y-.5;high=float(column['high'])+origin_y+.5
            point['pixelInterval']=sorted([axis_value(axes[binding],low),axis_value(axes[binding],high)])
        points.append(point)
    if len(points)<2:return
    rgb=cv.cvtColor(np.uint8([[[hue,220,190]]]),cv.COLOR_HSV2RGB)[0,0].tolist() if hue is not None else [34,34,34]
    result['series'].append({'id':'series-'+str(len(result['series'])+1),'color':'#'+''.join(f'{v:02x}' for v in rgb),'hue':hue,'axisBinding':binding,'points':points,
        'gapsPixels':[[float(a)+origin_x,float(b)+origin_x] for a,b in trace.get('gaps',[])],
        'segments':sampled.get('segments',[]),'traceAmbiguous':bool(trace.get('ambiguous')),
        'sampling':{'observedColumns':len(trace['columns']),'returnedPoints':len(points),'tolerancePixels':tolerance,'maxDeviationPixels':sampled.get('maxDeviationPixels')}})
    if trace.get('ambiguous') and 'curve-junction-ambiguous' not in result['issues']:result['issues'].append('curve-junction-ambiguous')
    if binding=='ambiguous' and 'series-axis-ambiguous' not in result['issues']:result['issues'].append('series-axis-ambiguous')


def _geometry_ocr_lines(png_bytes,ocr_lines,result):
    if ocr_lines is None:
        import paper_ocr
        issues=[];ok,ocr_lines,_=paper_ocr._default_lines(png_bytes,'en',issues,{})
        if not ok:result['issues']=['axis-ocr-unavailable',*issues];return False,ocr_lines
    return True,ocr_lines


def _decode_chart_image(png_bytes,cv,np,image_info,result):
    image=cv.imdecode(np.frombuffer(png_bytes,dtype=np.uint8),cv.IMREAD_COLOR)
    if image is None:result['issues']=['invalid-image'];return None
    height,width=image.shape[:2];image_info.update(width=width,height=height)
    if width<200 or height<150 or width*height>12_000_000:result['issues']=['unsupported-image-size'];return None
    return image


def extract_geometry(png_bytes,ocr_lines=None):
    image_info={'sha256':hashlib.sha256(png_bytes).hexdigest(),'width':None,'height':None}
    result={'schema':'falsify.chart-geometry.v1','status':'unavailable','image':image_info,'plotBbox':None,'axes':{},'series':[],'issues':[]}
    try:
        import cv2 as cv
        import numpy as np
        from paper_chart_traces import trace_mask
        from paper_chart_sampling import sample_trace
        image=_decode_chart_image(png_bytes,cv,np,image_info,result)
        if image is None:return result
        height,width=image.shape[:2]
        frame=_frame(cv.cvtColor(image,cv.COLOR_BGR2GRAY),cv,np);result['plotBbox']=frame
        if frame is None:result['issues']=['cartesian-axes-not-found'];return result
        ocr_ok,ocr_lines=_geometry_ocr_lines(png_bytes,ocr_lines,result)
        if not ocr_ok:return result
        ticks=_ticks(ocr_lines,frame,width,height,image,cv,np);left,top,right,bottom=frame
        _fit_geometry_axes(ticks,frame,image,cv,np,result)
        axes=result['axes']
        if 'x' not in axes or not any(side in axes for side in ('left','right')):result['issues'].append('axis-calibration-insufficient');return result
        candidates=_geometry_candidates(image,frame,ocr_lines,cv,np,trace_mask,result)
        if len(candidates)>64:
            candidates=candidates[:64];result['issues'].append('curve-count-limit')
        budget=max(3,480//max(1,len(candidates)))
        origin_x,origin_y=left+2,top+2
        tick_columns=[t['pixel']-origin_x for t in axes['x']['usedTicks']]
        for hue,trace in candidates:
            _append_geometry_series(hue,trace,axes,budget,origin_x,origin_y,tick_columns,cv,np,sample_trace,result)
        if not result['series']:result['issues'].append('colored-continuous-curves-not-found');return result
        result['status']='partial' if result['issues'] else 'ready'
        return result
    except ImportError:
        result['issues'].append('geometry-dependency-missing');return result

"""PDF image components, RGB ICC profiles and soft-mask-preserving curve edits."""
import zlib


def decode_image(pk, target):
    """Decode source components; keep a compatible RGB profile and its soft mask."""
    from PIL import Image
    try:
        if target.get('/ImageMask') or target.get('/Mask') is not None:
            return None
        image = pk.PdfImage(target).as_pil_image()
        colorspace = target.get('/ColorSpace')
        rgb_space = str(colorspace) == '/DeviceRGB'
        if isinstance(colorspace, pk.Array) and str(colorspace[0]) == '/ICCBased':
            rgb_space = int(colorspace[1].get('/N',0)) == 3
        preserve = rgb_space and image.mode == 'RGB' and target.get('/Decode') is None
        if image.mode != 'RGB':
            image = image.convert('RGB')
        alpha = None
        soft = target.get('/SMask')
        if soft is not None and hasattr(soft,'read_bytes'):
            if soft.get('/Matte') is not None:
                return None
            mask = pk.PdfImage(soft).as_pil_image().convert('L')
            decode = soft.get('/Decode')
            if decode is not None and list(decode) == [1,0]:
                from PIL import ImageOps
                mask = ImageOps.invert(mask)
            if mask.size != image.size:
                mask = mask.resize(image.size,Image.Resampling.BILINEAR)
            alpha = mask.tobytes()
        return {'samples':image.tobytes(),'width':image.width,'height':image.height,
                'alpha':alpha,'preserveRgbSpace':preserve}
    except (ValueError,TypeError,RuntimeError,NotImplementedError):
        return None


def build_image_stream(pk, pdf, original, samples, width, height, alpha=None, preserve_rgb_space=False):
    """Clone one occurrence with RGB samples and an independent updated soft mask."""
    if len(samples) != width*height*3 or (alpha is not None and len(alpha) != width*height):
        raise ValueError('bad-image')
    stream = pdf.make_stream(zlib.compress(samples))
    skip = {'/Length','/Filter','/DecodeParms','/Decode','/ColorSpace','/BitsPerComponent',
            '/Width','/Height','/SMask','/Mask','/Alternates','/ImageMask','/Type','/Subtype'}
    for key in original.keys():
        if str(key) not in skip:
            stream[key]=original.get(key)
    stream.Type=pk.Name.XObject;stream.Subtype=pk.Name.Image
    stream.Width=width;stream.Height=height;stream.BitsPerComponent=8
    stream.ColorSpace=original.get('/ColorSpace') if preserve_rgb_space else pk.Name.DeviceRGB
    stream.Filter=pk.Name.FlateDecode
    if alpha is not None:
        soft = pdf.make_stream(zlib.compress(alpha))
        soft.Type=pk.Name.XObject;soft.Subtype=pk.Name.Image
        soft.Width=width;soft.Height=height;soft.BitsPerComponent=8
        soft.ColorSpace=pk.Name.DeviceGray;soft.Filter=pk.Name.FlateDecode
        stream.SMask=soft
    return stream


def edit_alpha(rgb, alpha, points, new_points, color, width):
    """Use the same changed-span/color corridor as the RGB editor."""
    import numpy as np
    import paper_chart_raster_edit as raster
    spans = raster._changed_spans(points,new_points)
    if not spans:
        return alpha.copy()
    pieces=[points[begin:end+1] for begin,end in spans]
    mask=raster._corridor(alpha.shape,pieces,max(1.0,float(width)*.5+2))
    mask &= raster.color_mask(rgb,color) & (alpha>0)
    if not mask.any():
        return alpha.copy()
    opacity=int(np.median(alpha[mask]))
    base=raster.restore_under_mask(np.repeat(alpha[:,:,None],3,axis=2),mask)
    if new_points is not None:
        ranges=spans if len(points)==len(new_points) else [(0,len(new_points)-1)]
        for begin,end in ranges:
            base=raster.paint_polyline(base,new_points[begin:end+1],(opacity,)*3,width)
    return base[:,:,0].copy()

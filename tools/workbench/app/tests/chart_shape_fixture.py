"""Public synthetic charts for source-style editing tests; no real paper data."""
import io
import math
import pymupdf as pdf
from PIL import Image, ImageDraw


def chart_pdf():
    doc = pdf.open()
    p = doc.new_page(width=420, height=320)
    p.insert_text((35, 25), 'Source style chart', fontsize=13, fontname='helv')
    for x in range(45, 386, 34):
        p.draw_line((x, 55), (x, 265), color=(.85, .85, .85), width=.5)
    for y in range(55, 266, 42):
        p.draw_line((45, y), (385, y), color=(.85, .85, .85), width=.5)
    p.draw_line((45, 55), (45, 265), color=(0, 0, 0))
    p.draw_line((45, 265), (385, 265), color=(0, 0, 0))
    points = [(45+i*3.4, 240-i*1.5 + math.sin(i*.35)*.4) for i in range(101)]
    shape = p.new_shape()
    shape.draw_polyline(points)
    shape.finish(color=(.05, .4, .75), width=1.8, closePath=False)
    shape.commit()
    p.insert_text((180, 290), 'Dose', fontsize=11)
    p.insert_text((48, 48), 'Response', fontsize=9)
    p.insert_text((330, 305), 'Page 1', fontsize=8)
    p2 = doc.new_page(width=420, height=320)
    image = Image.new('RGB', (680, 420), 'white')
    draw = ImageDraw.Draw(image)
    for x in range(0, 680, 68):
        draw.line((x, 0, x, 419), fill=(220, 220, 220), width=1)
    for y in range(0, 420, 84):
        draw.line((0, y, 679, y), fill=(220, 220, 220), width=1)
    trace = [(i, round(330-180*math.exp(-((i-310)/90)**2))) for i in range(680)]
    draw.line(trace, fill=(20, 100, 185), width=3)
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    p2.insert_image(pdf.Rect(45, 55, 385, 265), stream=buf.getvalue())
    p2.insert_text((35, 25), 'Raster peak', fontsize=13)
    p3 = doc.new_page(width=420, height=320)
    p3.insert_text((40, 35), 'Unedited control and table')
    for x in (40, 180, 300):
        p3.draw_line((x, 60), (x, 150))
    for y in (60, 90, 120, 150):
        p3.draw_line((40, y), (300, y))
    for x, y, text in [(50,80,'Group'),(190,80,'Value'),(50,110,'Control'),(190,110,'7'),(50,140,'Treatment'),(190,140,'11')]:
        p3.insert_text((x,y),text)
    raw = doc.tobytes()
    doc.close()
    return raw

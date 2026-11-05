"""Whitespace-only Korean OCR presentation. Raw OCR text remains unchanged."""
import math
import re
import statistics
import threading

_kiwi=None
_lock=threading.Lock()


def _compact(text):return ''.join(c for c in text if not c.isspace())


def _insert_numeric_spaces(text,cuts):
    out=[];cursor=0
    for char in text:
        if not char.isspace():
            if cursor in cuts and out and not out[-1].isspace():out.append(' ')
            cursor+=1
        out.append(char)
    return ''.join(out)


def _numeric_cuts(chars,threshold):
    cuts=[];offset=0
    for index,(left,right) in enumerate(zip(chars,chars[1:])):
        offset+=len(left['text'])
        if left['text'][-1].isdigit() and right['text'][0].isdigit():
            gap=right['bbox'][0]-left['bbox'][2]
            if math.isfinite(gap) and gap>threshold:cuts.append(offset)
    return cuts


def numeric_gaps(text,tokens):
    chars=[t for t in tokens if isinstance(t.get('text'),str) and t['text'] and not t['text'].isspace()]
    if ''.join(t['text'] for t in chars)!=_compact(text):return text,[]
    widths=[t['bbox'][2]-t['bbox'][0] for t in chars if t['text'].isdigit() and len(t['text'])==1 and t.get('bbox')]
    if len(widths)<3:return text,[]
    # CTC boxes already include side bearings. A visible inter-number space can
    # occupy only a quarter of that width after PDF rasterization/resampling.
    threshold=max(3,statistics.median(widths)*.2)
    cuts=_numeric_cuts(chars,threshold)
    if not cuts:return text,[]
    return _insert_numeric_spaces(text,cuts),cuts



def _default_spacer(text):
    global _kiwi
    # Short labels often contain domain names (e.g. treatment-group suffixes).
    # Use pixel gaps for their numbers; a sentence model can split valid names.
    if len(re.findall('[가-힣]',text))<=6 and not re.search(r'[가-힣0-9]\.[가-힣]',text):return text
    if _kiwi is None:
        with _lock:
            if _kiwi is None:
                from kiwipiepy import Kiwi
                _kiwi=Kiwi(num_workers=1)
    return _kiwi.space(text)


def present(text,tokens=(),spacer=None):
    geometric,cuts=numeric_gaps(text,tokens)
    methods=['numeric-character-gaps'] if cuts else []
    try:
        spaced=(spacer or _default_spacer)(geometric)
        if isinstance(spaced,str) and _compact(spaced)==_compact(text):
            # Numeric boundaries with pixel evidence survive linguistic spacing.
            spaced,_=numeric_gaps(spaced,tokens)
            if spaced!=geometric:methods.append('kiwipiepy-0.24.1')
        else:spaced=geometric;methods.append('non-whitespace-change-rejected')
    except ImportError:spaced=geometric;methods.append('linguistic-spacing-unavailable')
    return {'displayText':spaced,'spacing':{'methods':methods,'numericCuts':cuts,'nonWhitespacePreserved':True}}

"""Inspect eleven manually selected public headings using native PDF text boxes.

This is a bounded sample, not exhaustive gold for either page. No scientific text
or OCR output is emitted. Run only with the known public fixture and detector JSON.
"""
import hashlib
import json
from pathlib import Path
import sys

import pymupdf
from compare import iou

PUBLIC_SHA = 'b41ec33c64b72da8b5c43156751998f6b2f64a3a934dab15a2e15b0894bd2ffb'
ANCHORS = [(0, 'title', 'The Effect of Cold Showering on Health and Work: A Randomized Controlled Trial', 'Title'),
           (0, 'abstract', 'Abstract', 'Section-header'), (0, 'purpose', 'Purpose', 'Section-header'),
           (0, 'abstract-methods', 'Methods', 'Section-header'), (0, 'results', 'Results', 'Section-header'),
           (0, 'conclusion', 'Conclusion', 'Section-header'), (0, 'registration', 'Trial Registration', 'Section-header'),
           (1, 'introduction', 'Introduction', 'Section-header'), (1, 'methods', 'Methods', 'Section-header'),
           (1, 'study-design', 'Study Design', 'Section-header'), (1, 'participants', 'Participants', 'Section-header')]
Y_RANGES = {'title': (105, 160), 'abstract': (285, 315), 'purpose': (325, 350), 'abstract-methods': (385, 410), 'results': (500, 525), 'conclusion': (600, 625), 'registration': (660, 685), 'introduction': (75, 98), 'methods': (350, 375), 'study-design': (375, 395), 'participants': (595, 620)}


def main():
    source = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(source).hexdigest() != PUBLIC_SHA:
        raise ValueError('not the verified public fixture')
    detected = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    if detected.get('status') != 'success' or detected['source']['sha256'] != PUBLIC_SHA:
        raise ValueError('not a successful detection of the public fixture')
    doc = pymupdf.open(stream=source, filetype='pdf')
    observations = []
    for page, identifier, anchor, expected in ANCHORS:
        # Search only the leading heading region. Each chosen anchor has exactly
        # one occurrence there; title may span multiple adjacent source lines.
        top, bottom = Y_RANGES[identifier]
        rects = doc[page].search_for(anchor, clip=pymupdf.Rect(190, top, 590, bottom))
        if not rects:
            raise ValueError(f'missing anchor {identifier}')
        if identifier != 'title' and len(rects) != 1:
            raise ValueError(f'ambiguous anchor {identifier}')
        box = rects[0]
        for rect in rects[1:]:
            box |= rect
        candidates = [(iou(list(box), d['bbox']), d) for d in detected['pages'][page]['detections']]
        score, match = max(candidates, key=lambda x: x[0])
        observations.append({'id': identifier, 'pageIndex': page, 'goldBBox': list(box), 'expectedLabel': expected, 'bestIoU': score, 'matchedLabel': match['label'], 'confidence': match['confidence']})
    doc.close()
    result = {'scope': '11 selected title/heading anchors; not exhaustive page gold', 'iouThreshold': 0.5, 'count': len(observations), 'boxMatches': sum(o['bestIoU'] >= .5 for o in observations), 'correctLabelAndBox': sum(o['bestIoU'] >= .5 and o['matchedLabel'] == o['expectedLabel'] for o in observations), 'observations': observations}
    Path(sys.argv[3]).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'observations'}))


if __name__ == '__main__':
    main()

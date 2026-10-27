"""Report overlap between existing parser lines and model regions, not accuracy."""
import json
from pathlib import Path
import sys


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def main():
    inventory = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    detections = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    if inventory['status'] != 'available' or detections['status'] != 'success' or inventory['sourceSha256'] != detections['source']['sha256']:
        raise ValueError('unavailable or mismatched input')
    results = []
    for page, model in zip(inventory['pages'], detections['pages']):
        if page['pageIndex'] != model['pageIndex'] or page['truncated']:
            raise ValueError('page mismatch or truncated inventory')
        boxes = [x['bbox'] for x in model['detections']]
        lines = page['text']
        covered = sum(any(area(line) > 0 and intersection(line, box) / area(line) >= .5 for box in boxes) for line in lines)
        duplicates = sum(a == b for i, a in enumerate(boxes) for b in boxes[i+1:])
        results.append({'pageIndex': page['pageIndex'], 'inventoryTextLines': len(lines), 'linesAtLeastHalfCoveredByAnyDetection': covered, 'detections': len(boxes), 'identicalDetectionBoxPairs': duplicates})
    out = {'scope': 'geometric intersection only; regions and source lines are different granularities; not accuracy or text preservation', 'pages': results}
    Path(sys.argv[3]).write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(out))


if __name__ == '__main__':
    main()

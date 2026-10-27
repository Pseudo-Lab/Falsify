"""Compare manually annotated boxes to detections; no model or document text required."""
import json
import sys


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return intersection / (area_a + area_b - intersection) if area_a + area_b > intersection else 0


def compare(gold, predicted, threshold=0.5):
    """Greedy highest IoU independent of label, then measure caption classification on matched boxes.

    A match is not a semantic pass. Missing detection and missed caption remain visible.
    Reading order is only evaluated when both sides provide explicit order values.
    """
    candidates = sorted(((iou(g['bbox'], p['bbox']), gi, pi) for gi, g in enumerate(gold) for pi, p in enumerate(predicted) if g['pageIndex'] == p['pageIndex']), reverse=True)
    used_g, used_p, matches = set(), set(), []
    for score, gi, pi in candidates:
        if score < threshold:
            break
        if gi not in used_g and pi not in used_p:
            used_g.add(gi); used_p.add(pi); matches.append((gi, pi, score))
    tp = sum(gold[g]['label'].lower() == 'caption' and predicted[p]['label'].lower() == 'caption' for g, p, _ in matches)
    gold_captions = sum(g['label'].lower() == 'caption' for g in gold)
    predicted_captions = sum(p['label'].lower() == 'caption' for p in predicted)
    ordered = [(gold[g]['pageIndex'], gold[g]['order'], predicted[p]['order']) for g, p, _ in matches if 'order' in gold[g] and 'order' in predicted[p]]
    pairs = [(a, b) for i, a in enumerate(ordered) for b in ordered[i+1:] if a[0] == b[0] and a[1] != b[1] and a[2] != b[2]]
    return {'matching': 'greedy IoU independent of label', 'iouThreshold': threshold, 'goldCount': len(gold), 'predictedCount': len(predicted), 'matched': len(matches), 'meanMatchedIoU': sum(x[2] for x in matches) / len(matches) if matches else None, 'unmatchedGold': len(gold)-len(used_g), 'unmatchedPredicted': len(predicted)-len(used_p), 'caption': {'truePositive': tp, 'gold': gold_captions, 'predicted': predicted_captions, 'precision': tp / predicted_captions if predicted_captions else None, 'recall': tp / gold_captions if gold_captions else None}, 'readingOrder': {'comparablePairs': len(pairs), 'agreement': sum((a[1]-b[1])*(a[2]-b[2]) > 0 for a,b in pairs) / len(pairs) if pairs else None}}


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as f:
        gold = json.load(f)
    with open(sys.argv[2], encoding='utf-8') as f:
        predictions = json.load(f)
    if isinstance(predictions, dict):
        if predictions.get('status') != 'success':
            raise ValueError('model run did not succeed')
        predictions = [d for page in predictions['pages'] for d in page['detections']]
    print(json.dumps(compare(gold, predictions), indent=2, allow_nan=False))

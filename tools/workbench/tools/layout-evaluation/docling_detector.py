"""Public-only Heron detector experiment; emits geometry, never OCR or source text."""
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import urllib.request

ROOT = Path('/tmp/falsify-layout-evaluation')
PDF_URL = 'https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0161749&type=printable'
PDF_SHA256 = 'b41ec33c64b72da8b5c43156751998f6b2f64a3a934dab15a2e15b0894bd2ffb'
REPO = 'docling-project/docling-layout-heron'
REVISION = '8f39ad3c0b4c58e9c2d2c84a38465abf757272d8'
WEIGHTS_SHA256 = '00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c'
LABELS = ('Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title', 'Document Index', 'Code', 'Checkbox-Selected', 'Checkbox-Unselected', 'Form', 'Key-Value Region')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def normalize(page_index, box, score, label_id, image_size, page_size):
    """Map pixels to top-left page points; reject invalid model observations."""
    if len(box) != 4 or len(image_size) != 2 or len(page_size) != 2:
        raise ValueError('invalid dimensions')
    values = list(box) + [score] + list(image_size) + list(page_size)
    if not all(math.isfinite(float(v)) for v in values):
        raise ValueError('non-finite observation')
    iw, ih = image_size
    pw, ph = page_size
    x0, y0, x1, y1 = box
    if min(iw, ih, pw, ph) <= 0 or not (0 <= x0 < x1 <= iw and 0 <= y0 < y1 <= ih):
        raise ValueError('box outside frame')
    if not 0 <= score <= 1 or not isinstance(label_id, int) or not 0 <= label_id < len(LABELS):
        raise ValueError('invalid score or label')
    return {'pageIndex': page_index, 'bbox': [x0 * pw / iw, y0 * ph / ih, x1 * pw / iw, y1 * ph / ih], 'label': LABELS[label_id], 'confidence': float(score)}


def main():
    os.environ['CUDA_VISIBLE_DEVICES'] = ''
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    ROOT.mkdir(parents=True, exist_ok=True)
    import pypdfium2 as pdfium
    import torch
    from huggingface_hub import snapshot_download
    from transformers import RTDetrImageProcessor, RTDetrV2ForObjectDetection

    pdf_path = ROOT / 'public-cold-shower.pdf'
    status = None
    acquisition = 'coordinator-relayed public PDF'
    if not pdf_path.exists():
        acquisition = 'official URL'
        req = urllib.request.Request(PDF_URL, headers={'User-Agent': 'falsify-layout-evaluation/1.0'})
        with urllib.request.urlopen(req, timeout=90) as response:
            status = response.status
            data = response.read(30 * 1024 * 1024 + 1)
        if status != 200 or len(data) > 30 * 1024 * 1024 or not data.startswith(b'%PDF-'):
            raise RuntimeError('public PDF download failed validation')
        pdf_path.write_bytes(data)
    if pdf_path.stat().st_size > 30 * 1024 * 1024 or sha256(pdf_path) != PDF_SHA256:
        raise RuntimeError('public PDF SHA-256 mismatch')
    with pdf_path.open('rb') as stream:
        if stream.read(5) != b'%PDF-':
            raise RuntimeError('public PDF signature mismatch')
    model_dir = Path(snapshot_download(REPO, revision=REVISION, allow_patterns=['config.json', 'preprocessor_config.json', 'model.safetensors']))
    weights_hash = sha256(model_dir / 'model.safetensors')
    if weights_hash != WEIGHTS_SHA256:
        raise RuntimeError('checkpoint hash mismatch')
    processor = RTDetrImageProcessor.from_pretrained(model_dir, local_files_only=True)
    model = RTDetrV2ForObjectDetection.from_pretrained(model_dir, local_files_only=True).to('cpu').eval()
    document = pdfium.PdfDocument(str(pdf_path))
    if len(document) < 2:
        raise RuntimeError('PDF has fewer than two pages')
    pages = []
    for index in range(2):
        page = document[index]
        page_size = page.get_size()
        image = page.render(scale=1.5).to_pil().convert('RGB')
        image.save(ROOT / f'public-page-{index + 1}.png')
        inputs = processor(images=[image], return_tensors='pt')
        with torch.inference_mode():
            outputs = model(**inputs)
        predicted = processor.post_process_object_detection(outputs, target_sizes=torch.tensor([image.size[::-1]]), threshold=0.6)[0]
        boxes = [normalize(index, box.tolist(), float(score), int(label), image.size, page_size) for score, label, box in zip(predicted['scores'], predicted['labels'], predicted['boxes'])]
        pages.append({'pageIndex': index, 'width': page_size[0], 'height': page_size[1], 'detections': boxes})
        page.close()
    document.close()
    result = {'schema': 'falsify.layout-experiment.v1', 'status': 'success', 'source': {'url': PDF_URL, 'httpStatus': status, 'acquisition': acquisition, 'sha256': sha256(pdf_path)}, 'model': {'repository': REPO, 'revision': REVISION, 'weightsSha256': weights_hash, 'license': 'Apache-2.0', 'implementation': 'direct transformers Heron detector', 'transformers': importlib.metadata.version('transformers'), 'torch': torch.__version__, 'device': 'cpu'}, 'threshold': 0.6, 'coordinateSpace': 'top-left page points', 'readingOrder': None, 'pages': pages}
    output = ROOT / 'docling-detector.json'
    output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'status': 'success', 'result': str(output), 'pageDetections': [len(p['detections']) for p in pages], 'pdfSha256': result['source']['sha256'], 'weightsSha256': weights_hash}))


if __name__ == '__main__':
    main()

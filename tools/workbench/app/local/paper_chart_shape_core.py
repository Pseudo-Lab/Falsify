"""Pinned chart-shape bundle in embedded V8.

Geometry changes are computed only by app/dist/chart-shape-core.js. This module
checks the pinned hash and passes scene JSON through. It does not reimplement
deform, move, resize, or set-values.
"""
import hashlib
import json
import threading
from pathlib import Path

UPSTREAM = '5a87af23408aedf00e35e43ca6648a20cf6455bd'
APP = Path(__file__).resolve().parents[1]
BUNDLE = APP / 'dist' / 'chart-shape-core.js'
MANIFEST = APP / 'dist' / 'chart-shape-vendor' / 'manifest.json'
_LOCK = threading.Lock()
_CORE = None


def _bundle_ok():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    digest = hashlib.sha256(BUNDLE.read_bytes()).hexdigest()
    if manifest.get('schema') != 'falsify.chart-shape-runtime.v1':
        raise RuntimeError('chart_shape_bundle_mismatch')
    if manifest.get('upstream', {}).get('commit') != UPSTREAM:
        raise RuntimeError('chart_shape_bundle_mismatch')
    bundle = manifest.get('bundle', {})
    if bundle.get('sha256') != digest or bundle.get('bytes') != BUNDLE.stat().st_size:
        raise RuntimeError('chart_shape_bundle_mismatch')
    if manifest.get('esbuild') != '0.28.2':
        raise RuntimeError('chart_shape_bundle_mismatch')
    return manifest


class Core:
    def __init__(self):
        _bundle_ok()
        from py_mini_racer import MiniRacer
        self.context = MiniRacer()
        self.context.set_hard_memory_limit(512 * 1024 * 1024)
        try:
            self.context.eval(BUNDLE.read_text(encoding='utf-8'), timeout_sec=10)
        except Exception:
            self.close()
            raise

    def close(self):
        self.context.close()

    def evaluate(self, scene, operations):
        try:
            raw = self.context.call(
                'FalsifyChartShape.applyPlanJSON',
                json.dumps(scene, ensure_ascii=False, allow_nan=False, separators=(',', ':')),
                json.dumps(operations, ensure_ascii=False, allow_nan=False, separators=(',', ':')),
                timeout_sec=10,
            )
        except Exception as error:
            message = str(error)
            if 'chart_shape_invalid' in message:
                raise ValueError(message) from error
            raise
        if not isinstance(raw, str):
            raise ValueError('chart_shape_invalid')
        result = json.loads(raw)
        if not isinstance(result, dict) or not isinstance(result.get('scene'), dict):
            raise ValueError('chart_shape_invalid')
        return result


def evaluate(scene, operations):
    """Apply operations by executing the same bundle the browser global uses."""
    if not isinstance(scene, dict) or not isinstance(operations, list):
        raise ValueError('chart_shape_invalid')
    global _CORE
    with _LOCK:
        if _CORE is None:
            _CORE = Core()
        return _CORE.evaluate(scene, operations)

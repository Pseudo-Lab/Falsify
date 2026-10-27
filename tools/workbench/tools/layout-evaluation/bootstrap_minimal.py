"""Recreate only this experiment's failed venv and install detector dependencies."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path('/tmp/falsify-layout-evaluation')
ENV = ROOT / 'venv'
ROOT.mkdir(parents=True, exist_ok=True)
cache = Path.home() / '.cache' / 'pip'
cache_usage = subprocess.run(['du', '-sk', str(cache)], text=True, capture_output=True) if cache.exists() else None
print(json.dumps({'phase': 'before', 'disk': dict(zip(('total', 'used', 'free'), shutil.disk_usage(ROOT))), 'pipCacheKiB': int(cache_usage.stdout.split()[0]) if cache_usage and cache_usage.returncode == 0 else None, 'taskVenvExists': ENV.exists(), 'taskVenvSymlink': ENV.is_symlink(), 'systemTorchPresent': importlib.util.find_spec('torch') is not None}), flush=True)
if ENV.is_symlink() or ROOT.resolve() != ROOT or ENV.parent != ROOT:
    raise RuntimeError('unsafe task venv path')
if ENV.exists():
    shutil.rmtree(ENV)
env = dict(os.environ, CUDA_VISIBLE_DEVICES='', PIP_NO_CACHE_DIR='1', PIP_DISABLE_PIP_VERSION_CHECK='1')
subprocess.run([sys.executable, '-m', 'venv', '--system-site-packages', str(ENV)], check=True, env=env)
python = str(ENV / 'bin' / 'python')
with (ROOT / 'bootstrap-minimal-install.log').open('w') as log:
    result = subprocess.run([python, '-m', 'pip', 'install', '--no-cache-dir', 'transformers==4.51.3', 'pypdfium2==4.30.1', 'Pillow'], stdout=log, stderr=subprocess.STDOUT, env=env)
if result.returncode:
    print(json.dumps({'status': 'install_failed', 'exitCode': result.returncode, 'log': str(ROOT / 'bootstrap-minimal-install.log')}))
    sys.exit(result.returncode)
check = """import json, sys, importlib.metadata as m
import torch, numpy, pypdfium2
from transformers import RTDetrImageProcessor, RTDetrV2ForObjectDetection
print(json.dumps({'status':'ok','python':sys.version,'transformers':m.version('transformers'),'pdfium':m.version('pypdfium2'),'torch':torch.__version__,'numpy':numpy.__version__,'cudaAvailable':torch.cuda.is_available()}))
"""
result = subprocess.run([python, '-c', check], text=True, capture_output=True, env=env)
output = ROOT / 'bootstrap-minimal-check.json'
output.write_text(result.stdout if result.returncode == 0 else json.dumps({'status': 'check_failed', 'stderr': result.stderr[-4000:]}))
print(output.read_text())
sys.exit(result.returncode)

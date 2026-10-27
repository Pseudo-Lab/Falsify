"""Explicit local binding for the shipped BLUE v035 family; no model calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    'app/examples/evidence_blue_v035/runner.py', 'app/examples/evidence_blue_v035/build_profile.py',
    'app/examples/evidence_blue_v034/runner.py', 'app/examples/evidence_blue_v034/profile-template.json',
    'app/examples/evidence_blue_v033/core.py', 'app/examples/evidence_blue_v033/runner.py',
    'app/examples/evidence_blue_v033/reanchor.py', 'app/examples/evidence_blue_v031/core.py',
    'app/examples/evidence_blue_v031/literature.py', 'app/examples/evidence_blue/core.py',
    'app/examples/evidence_blue/corpus.json', 'app/local/cli_backend.py', 'app/local/blue_service.py',
    'app/local/red_service.py', 'app/local/harness.py', 'app/local/harness_adapter.py',
    'app/local/blue_visual.py', 'app/local/blue_evidence_refs.py', 'experiments/selfplay_codex.py',
)

def cache_dir():
    if os.name == 'nt': base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
    elif sys.platform == 'darwin': base = Path.home() / 'Library' / 'Application Support'
    else: base = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share')
    return base / 'falsify-workbench' / 'harness-runtime'

def digest(data): return hashlib.sha256(data).hexdigest()
def manifest(root): return {name: digest((root / name).read_bytes()) for name in FILES}
def identity(files): return digest(json.dumps(files, sort_keys=True, separators=(',', ':')).encode())

def deploy(data, source=ROOT, cache=None):
    if data != {'schema': 'falsify.harness-deployment-request.v1', 'family': 'evidence-blue-v035'}:
        raise ValueError('invalid_deployment_request')
    source = Path(source); cache = Path(cache) if cache is not None else cache_dir()
    files = {name: (source / name).read_bytes() for name in FILES}
    hashes = {name: digest(blob) for name, blob in files.items()}
    bundle = identity(hashes); target = cache / bundle
    cache.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=cache) as temp:
            stage = Path(temp) / 'snapshot'; stage.mkdir()
            for name, blob in files.items():
                path = stage / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(blob)
            if manifest(stage) != hashes: raise ValueError('snapshot_corrupt')
            try: stage.rename(target)
            except OSError:
                if not target.is_dir(): raise
    if manifest(target) != hashes: raise ValueError('snapshot_corrupt')
    runner = target / 'app/examples/evidence_blue_v035'
    with tempfile.TemporaryDirectory(prefix='falsify-profile-') as temp:
        output = Path(temp) / 'profile.json'
        code = 'import sys; sys.path.insert(0, sys.argv[1]); import build_profile; build_profile.build(sys.argv[2])'
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        subprocess.run([sys.executable, '-c', code, str(runner), str(output)], cwd=temp, env=env,
                       check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        profile = json.loads(output.read_text(encoding='utf8'))
    profile['settings']['portableStrategy'] = {'schema': 'falsify.portable-strategy.v1',
        'name': 'evidence-blue', 'version': '0.3.5', 'sourceDigest': bundle,
        'parameters': {'model': profile['settings']['model'], 'effort': profile['settings']['effort'],
                       'internalMaxCalls': profile['settings']['internalMaxCalls'],
                       'externalLookup': profile['settings']['externalLookup']}}
    if manifest(target) != hashes: raise ValueError('snapshot_corrupt')
    return {'schema': 'falsify.harness-deployment.v1', 'profile': profile, 'sourceDigest': bundle}

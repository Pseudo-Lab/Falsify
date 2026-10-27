import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import harness_deployment as deployment

REQUEST = {'schema': 'falsify.harness-deployment-request.v1', 'family': 'evidence-blue-v035'}

class DeploymentTests(unittest.TestCase):
    def test_snapshot_reuse_update_and_corruption(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'source'; cache = root / 'cache'
            for name in deployment.FILES:
                dest = source / name; dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(deployment.ROOT / name, dest)
            with ThreadPoolExecutor(max_workers=2) as pool:
                a, b = list(pool.map(lambda _: deployment.deploy(REQUEST, source, cache), range(2)))
            self.assertEqual(a, b)
            profile = a['profile']; snapshot = cache / a['sourceDigest']
            self.assertTrue(Path(profile['adapter']['executable']).is_absolute())
            self.assertTrue(Path(profile['adapter']['args'][0]).is_relative_to(snapshot))
            (source / 'app/local/harness_adapter.py').write_text('# updated platform\n', encoding='utf8')
            newer = deployment.deploy(REQUEST, source, cache)
            self.assertNotEqual(a['sourceDigest'], newer['sourceDigest'])
            with tempfile.TemporaryDirectory() as tmp:
                settings = Path(tmp) / 'settings.json'; settings.write_text(json.dumps(profile['settings']), encoding='utf8')
                code = 'import json,sys; sys.path.insert(0,sys.argv[1]); import runner; runner.check_settings(json.load(open(sys.argv[2],encoding="utf8")))'
                subprocess.run([sys.executable, '-B', '-c', code, str(snapshot / 'app/examples/evidence_blue_v035'), str(settings)], check=True, cwd=tmp)
            (snapshot / 'app/local/harness_adapter.py').write_text('corrupt', encoding='utf8')
            with self.assertRaisesRegex(ValueError, 'snapshot_corrupt'):
                deployment.deploy(REQUEST, deployment.ROOT, cache)

    def test_invalid_request_does_not_create_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / 'cache'
            with self.assertRaises(ValueError): deployment.deploy({'family':'unknown'}, cache=cache)
            self.assertFalse(cache.exists())

if __name__ == '__main__': unittest.main()

"""Opt-in acceptance against a source-release ZIP, using no model calls.

Set FALSIFY_RELEASE_ZIP to an archive produced by scripts/package-release.mjs.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile


@unittest.skipUnless(os.environ.get('FALSIFY_RELEASE_ZIP'), 'set FALSIFY_RELEASE_ZIP to a source-release ZIP')
class PackagedHarnessTests(unittest.TestCase):
    def test_archive_deployment_and_http_assets(self):
        if not os.environ.get('FALSIFY_PACKAGE_TEST_CHILD'):
            env = dict(os.environ, FALSIFY_PACKAGE_TEST_CHILD='1', PYTHONDONTWRITEBYTECODE='1')
            subprocess.run([sys.executable, '-B', str(Path(__file__).resolve())], env=env, check=True, timeout=90)
            return
        archive = Path(os.environ['FALSIFY_RELEASE_ZIP']).resolve()
        with tempfile.TemporaryDirectory(prefix='falsify-package-qa-') as folder:
            temp = Path(folder)
            with zipfile.ZipFile(archive) as z:
                names = z.namelist()
                roots = {name.split('/')[0] for name in names}
                self.assertEqual(len(roots), 1)
                self.assertTrue(all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in names))
                z.extractall(temp)
            root = temp / roots.pop()
            sys.path.insert(0, str(root / 'app/local'))
            try:
                import harness_deployment as deployment
                import harness
                import server
                self.assertEqual(deployment.ROOT, root)
                source_hashes = deployment.manifest(root)
                cache = temp / 'private-cache'
                request = {'schema': 'falsify.harness-deployment-request.v1', 'family': 'evidence-blue-v035'}
                first = deployment.deploy(request, root, cache)
                self.assertEqual(first, deployment.deploy(request, root, cache))
                self.assertEqual(first['sourceDigest'], deployment.identity(source_hashes))
                old = cache / first['sourceDigest']
                self.assertEqual(deployment.manifest(old), source_hashes)
                self.assertEqual({p.relative_to(old).as_posix() for p in old.rglob('*') if p.is_file()}, set(deployment.FILES))
                harness.validate(first['profile'], 'blue')
                self.check_frozen(old, first['profile'], temp)
                changed = root / 'app/local/harness_adapter.py'
                changed.write_bytes(changed.read_bytes() + b'\n# package acceptance change\n')
                second = deployment.deploy(request, root, cache)
                self.assertNotEqual(first['sourceDigest'], second['sourceDigest'])
                self.assertEqual(deployment.manifest(old), source_hashes)
                self.check_frozen(old, first['profile'], temp)
                self.assertEqual({p.relative_to(cache / second['sourceDigest']).as_posix() for p in (cache / second['sourceDigest']).rglob('*') if p.is_file()}, set(deployment.FILES))

                vendor = root / 'app/dist/recomposition-vendor'
                manifest = json.loads((vendor / 'manifest.json').read_text(encoding='utf8'))
                for entry in [manifest['wasm'], *manifest['fonts']]:
                    self.assertEqual(hashlib.sha256((vendor / entry['url']).read_bytes()).hexdigest(), entry['sha256'])
                for notice in ('LICENSE_TYPST_APACHE', 'notoserif-OFL.txt', 'notosans-OFL.txt', 'LICENSE_LIBERATION'):
                    self.assertTrue((vendor / notice).is_file())
                self.assertIn('SIL Open Font License', (root / 'app/dist/font-assets/LICENSE_STIX').read_text(encoding='utf8'))
                self.http_checks(server, deployment, root, cache, request, manifest)
            finally:
                sys.path.remove(str(root / 'app/local'))

    def check_frozen(self, snapshot, profile, temp):
        settings = temp / 'settings.json'
        settings.write_text(json.dumps(profile['settings']), encoding='utf8')
        code = 'import json,sys; sys.path.insert(0,sys.argv[1]); import runner; runner.check_settings(json.load(open(sys.argv[2],encoding="utf8")))'
        subprocess.run([sys.executable, '-B', '-c', code, str(snapshot / 'app/examples/evidence_blue_v035'), str(settings)], cwd=temp, check=True, timeout=30)

    def http_checks(self, server, deployment, root, cache, request, manifest):
        original = server.harness_deployment.deploy
        server.harness_deployment.deploy = lambda data: original(data, root, cache)
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{httpd.server_port}'
        def call(method, path, body=None, auth=False):
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=30)
            headers = {'Origin': origin}
            if auth: headers['Authorization'] = 'Bearer ' + server.TOKEN
            if body is not None: headers['Content-Type'] = 'application/json'
            conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = conn.getresponse(); data = response.read(); status = response.status
            conn.close()
            return status, data
        try:
            assets = ['recomposition-vendor/manifest.json', 'font-assets/STIXTwoMath-Regular.otf',
                      'recomposition-vendor/' + manifest['fonts'][0]['url'], 'recomposition-vendor/' + manifest['wasm']['url']]
            for path in assets:
                status, data = call('GET', '/' + path)
                self.assertEqual(status, 200, path)
                self.assertEqual(data, (root / 'app/dist' / path).read_bytes())
            self.assertEqual(call('POST', '/api/harness/deploy', request)[0], 403)
            status, data = call('POST', '/api/harness/deploy', request, True)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)['sourceDigest'], deployment.identity(deployment.manifest(root)))
        finally:
            httpd.shutdown(); httpd.server_close(); thread.join()
            server.harness_deployment.deploy = original


if __name__ == '__main__':
    unittest.main()

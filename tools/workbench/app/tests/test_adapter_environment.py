import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'app/local'))
import harness_adapter as adapter
import harness_deployment as deployment


class AdapterEnvironmentTests(unittest.TestCase):
    def test_child_home_and_frozen_cli_search_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / 'synthetic-home'
            home.mkdir()
            cache = root / 'cache'
            result = deployment.deploy(
                {'schema': 'falsify.harness-deployment-request.v1', 'family': 'evidence-blue-v035'},
                cache=cache)
            frozen = cache / result['sourceDigest'] / 'app/local'
            directories = {name: str(root / name) for name in
                           ('APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
                            'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR')}
            env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), **directories,
                       OPENAI_API_KEY='secret', ANTHROPIC_API_KEY='secret',
                       AUTH_TOKEN='secret', CODEX_TOKEN='secret')
            code = '''import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from cli_backend import _search_path
names = sys.argv[2:]
print(json.dumps({'home': str(Path.home()), 'search': _search_path(),
                  'env': {n: os.environ.get(n) for n in names}}))
'''
            names = list(directories) + ['PATH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTH_TOKEN', 'CODEX_TOKEN']
            with patch.dict(os.environ, env, clear=True):
                expected_path = adapter.macos_runtime_path() if sys.platform == 'darwin' else env['PATH']
                raw = adapter.run_stdio([sys.executable, '-c', code, str(frozen), *names], b'',
                                        str(root), str(root / 'out'))
            actual = json.loads(raw)
            self.assertEqual(actual['home'], str(home))
            self.assertIn(str(home / '.local' / 'bin'), actual['search'])
            for name, value in directories.items(): self.assertEqual(actual['env'][name], value)
            self.assertEqual(actual['env']['PATH'], expected_path)
            for name in names[-4:]: self.assertIsNone(actual['env'][name])

    def test_posix_environment_allowlist(self):
        # Inspect the exact subprocess environment under a POSIX-style synthetic account.
        env = {'HOME': '/synthetic/home', 'PATH': '/usr/bin', 'XDG_CONFIG_HOME': '/synthetic/config',
               'CODEX_HOME': '/synthetic/codex', 'CLAUDE_CONFIG_DIR': '/synthetic/claude',
               'OPENAI_API_KEY': 'secret', 'ANTHROPIC_API_KEY': 'secret', 'TOKEN': 'secret'}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, env, clear=True), \
                patch.object(adapter.sys, 'platform', 'linux'), \
                patch.object(adapter.subprocess, 'Popen') as popen:
            popen.return_value.wait.return_value = 0
            popen.return_value.returncode = 0
            popen.return_value.poll.return_value = 0
            adapter.run_stdio(['dummy'], b'', folder, str(Path(folder) / 'out'))
            self.assertEqual(popen.call_args.kwargs['env'], {k: v for k, v in env.items()
                             if k not in {'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TOKEN'}})


if __name__ == '__main__': unittest.main()

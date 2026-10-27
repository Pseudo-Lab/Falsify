"""macOS GUI PATH behavior simulated without invoking installed model CLIs."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import cli_backend
import harness_adapter
from experiments import selfplay_codex


class MacRuntimeTests(unittest.TestCase):
    def test_sparse_path_discovery_and_clean_child_environments(self):
        with tempfile.TemporaryDirectory(prefix='path with spaces ') as root:
            home = Path(root)
            bindir = home / '.local' / 'bin'
            bindir.mkdir(parents=True)
            exe = bindir / ('claude.exe' if os.name == 'nt' else 'claude')
            exe.write_text('fixture', encoding='utf-8')
            exe.chmod(0o755)
            with patch.object(sys, 'platform', 'darwin'), patch.object(Path, 'home', return_value=home), \
                 patch.dict(os.environ, {'PATH': 'relative' + os.pathsep, 'PATHEXT': '.EXE', 'OPENAI_API_KEY': 'secret'}):
                with patch.object(cli_backend.shutil, "which", return_value=str(exe)):
                    self.assertEqual(cli_backend.discover_claude(), [str(exe.absolute())])
                path = selfplay_codex.macos_runtime_path().split(os.pathsep)
                self.assertIn(str(bindir), path)
                self.assertNotIn('relative', path)
                for env in (cli_backend.clean_environment(), selfplay_codex.clean_environment()):
                    self.assertEqual(env['PATH'], os.pathsep.join(path))
                    self.assertNotIn('OPENAI_API_KEY', env)
                with patch.object(selfplay_codex.shutil, 'which', return_value=None) as which:
                    with self.assertRaises(FileNotFoundError): selfplay_codex.discover_codex()
                    self.assertEqual(which.call_args_list[0].kwargs['path'], os.pathsep.join(path))

    def test_stdio_argument_with_spaces_and_timeout(self):
        with tempfile.TemporaryDirectory(prefix='wrapper space ') as root:
            script = Path(root) / 'fake wrapper.py'
            script.write_text('import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n', encoding='utf-8')
            output = str(Path(root) / 'output')
            self.assertEqual(harness_adapter.run_stdio([sys.executable, str(script)], b'hello', root, output), b'hello')
            script.write_text('import time\ntime.sleep(10)\n', encoding='utf-8')
            with patch.object(harness_adapter, 'TIMEOUT_SECONDS', .2):
                with self.assertRaises(ValueError): harness_adapter.run_stdio([sys.executable, str(script)], b'', root, output)


if __name__ == '__main__': unittest.main()

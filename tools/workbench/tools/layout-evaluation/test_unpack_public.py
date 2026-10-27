import base64
import hashlib
from pathlib import Path
import tempfile
import unittest
from unpack_public import NAMES, unpack


class RelayTest(unittest.TestCase):
    def test_hash_failure_writes_nothing(self):
        data = b'synthetic'
        artifacts = [{'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode()} for name in NAMES]
        artifacts[0]['sha256'] = 'bad'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                unpack({'schema': 'falsify.public-layout-relay.v1', 'artifacts': artifacts}, Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()

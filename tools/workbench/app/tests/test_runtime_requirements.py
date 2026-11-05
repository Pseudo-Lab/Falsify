"""Resolve the actual launcher pins for supported OS/architecture combinations."""
import unittest
from pathlib import Path
from packaging.requirements import Requirement
from packaging.markers import default_environment
ROOT=Path(__file__).resolve().parents[2]
class RuntimePins(unittest.TestCase):
    def test_one_pikepdf_pin_per_platform_in_both_install_routes(self):
        for name in ('requirements.txt','requirements-images.txt'):
            requirements=[Requirement(s) for s in (ROOT/'app/local'/name).read_text().splitlines() if s.startswith('pikepdf==')]
            for platform,machine,expected in [('darwin','x86_64','10.13.0.post1'),('darwin','arm64','10.17.0'),('win32','AMD64','10.17.0'),('linux','x86_64','10.17.0')]:
                env={**default_environment(),'sys_platform':platform,'platform_machine':machine}
                active=[r for r in requirements if r.marker is None or r.marker.evaluate(env)]
                self.assertEqual(len(active),1,(name,platform,machine))
                self.assertEqual(str(active[0].specifier),'=='+expected)
    def test_ci_uses_the_same_requirements_as_the_launchers(self):
        workflow=(ROOT/'.github/workflows/pages.yml').read_text()
        self.assertNotIn('pikepdf==',workflow)
        self.assertGreaterEqual(workflow.count('-r app/local/requirements-paper-mcp.txt -r app/local/requirements-images.txt'),4)
if __name__=='__main__':unittest.main()

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from PIL import Image
from reportlab.pdfgen import canvas

BRIDGE = Path(__file__).resolve().parents[1] / "docvortex_bridge.py"

class DocVortexBridgeTest(unittest.TestCase):
    def test_real_pdf_and_failures(self):
        with tempfile.TemporaryDirectory(prefix="docvortex-한글-") as directory:
            root = Path(directory)
            image = root / "image.png"
            Image.new("RGB", (80, 60), "red").save(image)
            pdf = root / "source 한글.pdf"
            c = canvas.Canvas(str(pdf))
            c.setFont("Helvetica-Bold", 20)
            c.drawString(72, 750, "Synthetic Heading")
            c.setFont("Helvetica", 11)
            c.drawString(72, 710, "First paragraph with a number 12345.")
            c.drawImage(str(image), 72, 500, width=160, height=120)
            c.showPage()
            c.drawString(72, 750, "Second page content.")
            c.save()
            output = root / "project 한글.zip"
            run = subprocess.run([sys.executable, str(BRIDGE), str(pdf), "--output", str(output), "--parse-mode", "txt"], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertEqual(run.returncode, 0, run.stderr)
            with zipfile.ZipFile(output) as z:
                tex = z.read("main.tex").decode("utf-8")
                self.assertIn("Synthetic Heading", tex)
                self.assertIn("Second page content", tex)
                self.assertIn("12345", tex)
                self.assertIn("includegraphics", tex)
                self.assertGreater(len(z.namelist()), 1)
                for name in z.namelist()[1:]:
                    self.assertIn(name, tex)
            info = json.loads(Path(str(output) + ".diagnostics.json").read_text(encoding="utf-8"))
            self.assertEqual(info["page_count"], 2)
            self.assertGreater(info["asset_count"], 0)
            again = subprocess.run([sys.executable, str(BRIDGE), str(pdf), "--output", str(output)], capture_output=True)
            self.assertNotEqual(again.returncode, 0)
            bad = root / "bad.pdf"
            bad.write_bytes(b"not a PDF")
            bad_output = root / "bad.zip"
            failed = subprocess.run([sys.executable, str(BRIDGE), str(bad), "--output", str(bad_output)], capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(bad_output.exists())
            missing = subprocess.run([sys.executable, "-S", str(BRIDGE), str(pdf), "--output", str(root / "missing.zip")], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("dependency unavailable", missing.stderr)
            self.assertFalse((root / "missing.zip").exists())

if __name__ == "__main__":
    unittest.main()

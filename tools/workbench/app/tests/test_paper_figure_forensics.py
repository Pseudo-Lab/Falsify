"""Unittest suite for the BLUE figure/panel forensic sensor (synthetic PDFs, stdlib unittest)."""
import base64
import hashlib
import json
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_blue_sensor as sensor  # noqa: E402
import paper_evidence as pe  # noqa: E402
import paper_figure_forensics as fig  # noqa: E402

FORBIDDEN_RED_KEYS = {"before", "after", "patch", "gold", "why_hard", "candidateRationales"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def _no_network(*args, **kwargs):
    raise AssertionError("unexpected_real_network_call")


def _assert_no_forbidden_keys(obj):
    if isinstance(obj, dict):
        for key, value in obj.items():
            assert key not in FORBIDDEN_RED_KEYS, f"forbidden RED key leaked: {key}"
            _assert_no_forbidden_keys(value)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_forbidden_keys(item)


def _raw_rgb(seed, width=64, height=48):
    samples = bytearray()
    for y in range(height):
        for x in range(width):
            samples += bytes((
                (x * 3 + y * 7 + seed * 13) % 256,
                (x * 5 + y * 11 + seed * 29) % 256,
                ((x // 4) * 23 + (y // 6) * 31 + seed * 41) % 256,
            ))
    return bytes(samples), width, height


def _png(seed, width=64, height=48):
    samples, cols, rows = _raw_rgb(seed, width, height)
    return pymupdf.Pixmap(pymupdf.csRGB, cols, rows, samples, 0).tobytes("png")


def _pixmap(raw):
    src = pymupdf.Pixmap(raw)
    colorspace = src.colorspace if src.colorspace is not None else pymupdf.csRGB
    return src, colorspace, src.width, src.height, src.n, src.samples, src.alpha


def _flip(raw, mode):
    src, colorspace, width, height, ncomp, samples, alpha = _pixmap(raw)
    mirrored_bytes = bytearray(len(samples))
    for y in range(height):
        for x in range(width):
            source_x = width - 1 - x if mode in ("h", "r") else x
            source_y = height - 1 - y if mode in ("v", "r") else y
            target = (y * width + x) * ncomp
            source = (source_y * width + source_x) * ncomp
            mirrored_bytes[target:target + ncomp] = samples[source:source + ncomp]
    return pymupdf.Pixmap(colorspace, width, height, bytes(mirrored_bytes), alpha).tobytes("png")


def _centre_crop(raw, fraction=0.5):
    src, colorspace, width, height, ncomp, samples, alpha = _pixmap(raw)
    crop_width, crop_height = int(width * fraction), int(height * fraction)
    left, top = (width - crop_width) // 2, (height - crop_height) // 2
    cropped = bytearray()
    for y in range(top, top + crop_height):
        start = (y * width + left) * ncomp
        cropped += samples[start:start + crop_width * ncomp]
    return pymupdf.Pixmap(colorspace, crop_width, crop_height, bytes(cropped), alpha).tobytes("png")


def _pdf(placements, text_lines=()):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for bbox, png in placements:
        page.insert_image(pymupdf.Rect(*bbox), stream=png)
    for offset, line in enumerate(text_lines):
        page.insert_text((72, 640 + offset * 16), line, fontsize=10)
    raw = doc.tobytes()
    doc.close()
    return raw


class _ItemStore:
    """Wrap a real EvidenceStore and serve fixture figure items for the chart-claim path."""

    def __init__(self, base, items):
        self._base = base
        self._items = items

    def status(self, paper_id):
        return self._base.status(paper_id)

    def prepare(self, pdf_bytes, file_hash, *, cancelled=None):
        return self._base.prepare(pdf_bytes, file_hash, cancelled=cancelled)

    def source_bytes(self, paper_id, file_hash):
        return self._base.source_bytes(paper_id, file_hash)

    def list_items(self, paper_id, kind=None, page_index=None, offset=0, limit=50):
        chunk = self._items[offset:offset + limit]
        served = [{"id": item["id"]} for item in chunk]
        next_offset = offset + len(served) if offset + len(served) < len(self._items) else None
        return {"items": served, "nextOffset": next_offset}

    def read_item(self, paper_id, item_id):
        for item in self._items:
            if item["id"] == item_id:
                return item
        raise KeyError(item_id)


class FigureForensicsTestCase(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()
        self.store = pe.EvidenceStore()

    def tearDown(self):
        self._net.stop()

    def _run(self, raw, store=None, **kwargs):
        store = self.store if store is None else store
        summary = store.prepare(raw, sha(raw))
        result = fig.audit_figure_forensics(summary["paperId"], summary["fileHash"], store=store, **kwargs)
        _assert_no_forbidden_keys(result)
        return result

    def _kinds(self, result):
        return [signal["kind"] for signal in result["signals"]]


class PairDetectionTests(FigureForensicsTestCase):
    def test_duplicate_panels_report_shared_image_and_bboxes(self):
        png = _png(3)
        result = self._run(_pdf([((50, 50, 130, 110), png), ((250, 50, 330, 110), png)]))
        self.assertEqual(result["schema"], fig.SCHEMA)
        self.assertEqual(result["figureCount"], 2)
        self.assertFalse(result["truncated"])
        signals = [signal for signal in result["signals"] if signal["kind"] == "duplicate_figure_panel"]
        self.assertEqual(len(signals), 1)
        signal = signals[0]
        self.assertEqual(signal["family"], "D4-1")
        self.assertEqual(signal["subtype"], "image-reuse")
        self.assertLessEqual(signal["computed"]["hamming"], fig.NEAR_DUPLICATE_HAMMING)
        self.assertTrue(signal["computed"]["sharedImage"])
        self.assertEqual(signal["computed"]["hashKind"], "dhash")
        self.assertEqual(len(signal["computed"]["pageIndexes"]), 2)
        self.assertEqual(len(signal["computed"]["bboxes"]), 2)
        self.assertEqual(signal["computed"]["bboxes"][0], [50.0, 50.0, 130.0, 110.0])
        self.assertIn("id", signal)
        self.assertEqual(len(result["pairs"]), 1)
        self.assertEqual(result["pairs"][0]["relation"], "duplicate_figure_panel")
        self.assertLessEqual(result["pairs"][0]["hamming"], fig.NEAR_DUPLICATE_HAMMING)

    def test_horizontally_mirrored_panel_is_detected(self):
        png = _png(11)
        result = self._run(_pdf([((50, 50, 130, 110), png), ((250, 50, 330, 110), _flip(png, "h"))]))
        signals = [signal for signal in result["signals"] if signal["kind"] == "mirrored_figure_panel"]
        self.assertEqual(len(signals), 1, self._kinds(result))
        self.assertEqual(signals[0]["subtype"], "image-mirror")
        self.assertLessEqual(signals[0]["computed"]["hamming"], fig.NEAR_DUPLICATE_HAMMING)
        self.assertFalse(signals[0]["computed"]["sharedImage"])
        self.assertEqual(result["pairs"][0]["relation"], "mirrored_figure_panel")

    def test_180_degree_rotated_panel_is_not_reported_as_a_mirror(self):
        png = _png(17)
        result = self._run(_pdf([((50, 50, 130, 110), png), ((250, 50, 330, 110), _flip(png, "r"))]))
        self.assertEqual(self._kinds(result), ["rotated_figure_panel"])
        signal = result["signals"][0]
        self.assertEqual(signal["subtype"], "image-rotate")
        self.assertLessEqual(signal["computed"]["hamming"], fig.NEAR_DUPLICATE_HAMMING)

    def test_centred_crop_of_a_larger_panel_is_detected(self):
        png = _png(23)
        result = self._run(_pdf([((50, 50, 210, 170), png), ((300, 50, 380, 110), _centre_crop(png, 0.5))]))
        signals = [signal for signal in result["signals"] if signal["kind"] == "cropped_figure_panel"]
        self.assertEqual(len(signals), 1, self._kinds(result))
        self.assertEqual(signals[0]["subtype"], "image-crop")
        self.assertLessEqual(signals[0]["computed"]["hamming"], fig.NEAR_DUPLICATE_HAMMING)
        bboxes = signals[0]["computed"]["bboxes"]
        self.assertIn([50.0, 50.0, 210.0, 170.0], bboxes)
        self.assertIn([300.0, 50.0, 380.0, 110.0], bboxes)

    def test_unrelated_figure_produces_no_signal_and_no_pairs(self):
        result = self._run(_pdf([((50, 50, 130, 110), _png(5)), ((250, 50, 330, 110), _png(97))]))
        self.assertEqual(result["figureCount"], 2)
        self.assertEqual(result["signals"], [])
        self.assertEqual(result["pairs"], [])

    def test_three_identical_panels_are_deduped_once_per_pair(self):
        png = _png(31)
        placements = [((40 + 140 * index, 40, 120 + 140 * index, 100), png) for index in range(3)]
        result = self._run(_pdf(placements))
        self.assertEqual(result["figureCount"], 3)
        self.assertEqual(len(result["pairs"]), 3)
        keys = {tuple(sorted((pair["a"], pair["b"]))) for pair in result["pairs"]}
        self.assertEqual(len(keys), 3)
        self.assertEqual(result["signalCount"], 3)
        self.assertTrue(all(signal["kind"] == "duplicate_figure_panel" for signal in result["signals"]))


class DegradationTests(FigureForensicsTestCase):
    def test_max_figures_truncation_is_reported(self):
        png = _png(41)
        placements = [((40 + 130 * index, 40, 110 + 130 * index, 100), png) for index in range(3)]
        result = self._run(_pdf(placements), max_figures=2)
        self.assertEqual(result["figureCount"], 2)
        self.assertTrue(result["truncated"])

    def test_unreadable_image_stream_is_skipped_not_raised(self):
        png = _png(43)
        raw = _pdf([((50, 50, 130, 110), png)])
        with patch.object(fig, "_image_sha", side_effect=fig._SkipPanel(fig.SKIP_STREAM_UNREADABLE)):
            result = self._run(raw)
        self.assertEqual(result["figureCount"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0]["reason"], fig.SKIP_STREAM_UNREADABLE)
        self.assertEqual(result["skipped"][0]["pageIndex"], 0)

    def test_zero_area_and_invalid_bbox_are_skipped_with_fixed_reasons(self):
        skipped = []
        self.assertIsNone(fig._panel_record(None, 0, 0, {"bbox": (10.0, 10.0, 10.0, 40.0), "xref": 0}, 96, skipped))
        self.assertIsNone(fig._panel_record(None, 1, 0, {"bbox": (1.0, 2.0, 3.0), "xref": 0}, 96, skipped))
        self.assertEqual([item["reason"] for item in skipped], [fig.SKIP_ZERO_AREA, fig.SKIP_BBOX_INVALID])

    def test_option_validation_rejects_bad_limits(self):
        raw = _pdf([((50, 50, 130, 110), _png(47))])
        summary = self.store.prepare(raw, sha(raw))
        for kwargs in ({"max_signals": 0}, {"max_signals": True}, {"dpi": 10}, {"max_figures": 0}):
            with self.assertRaises(ValueError):
                fig.audit_figure_forensics(summary["paperId"], summary["fileHash"], store=self.store, **kwargs)


class ChartClaimTests(FigureForensicsTestCase):
    PROSE = "Figure 1 shows a 42.0% increase in the treatment arm. The control arm stayed flat."

    def _figure_item(self, printed_values, chart=None):
        item = {
            "id": "item-fig-1",
            "type": "figure",
            "pageIndex": 0,
            "bbox": [50.0, 300.0, 320.0, 520.0],
            "caption": "Figure 1. Treatment response by arm",
        }
        if printed_values is not None:
            item["printedValues"] = printed_values
        if chart is not None:
            item["chart"] = chart
        return item

    def _run_with_item(self, item, prose):
        raw = _pdf([], text_lines=(prose,))
        base = pe.EvidenceStore()
        store = _ItemStore(base, [item])
        summary = store.prepare(raw, sha(raw))
        result = fig.audit_figure_forensics(summary["paperId"], summary["fileHash"], store=store)
        _assert_no_forbidden_keys(result)
        return result

    def test_printed_value_absent_from_prose_claim_is_reported(self):
        item = self._figure_item([{"value": 12.5, "rawText": "12.5%"}, {"value": 60.0, "rawText": "60.0%"}])
        result = self._run_with_item(item, self.PROSE)
        claims = [signal for signal in result["signals"] if signal["kind"] == "chart_printed_value_mismatch"]
        self.assertEqual(len(claims), 1, result["signals"])
        signal = claims[0]
        self.assertEqual(signal["family"], "D1")
        self.assertEqual(signal["subtype"], "chart-claim")
        self.assertEqual(signal["itemId"], "item-fig-1")
        self.assertEqual(signal["computed"]["proseValue"], 42.0)
        self.assertEqual(signal["computed"]["pageIndex"], 0)
        self.assertEqual(signal["reported"]["bbox"], [50.0, 300.0, 320.0, 520.0])
        self.assertAlmostEqual(signal["reported"]["printed"], 60.0, places=6)
        self.assertTrue(signal["computed"]["proseBbox"])

    def test_matching_prose_value_is_silent(self):
        item = self._figure_item([{"value": 12.5, "rawText": "12.5%"}])
        result = self._run_with_item(item, "Figure 1 shows a 12.5% increase in the treatment arm.")
        self.assertEqual([signal for signal in result["signals"] if signal["kind"] == "chart_printed_value_mismatch"], [])

    def test_reconciled_values_on_the_item_are_used_when_printed_values_are_absent(self):
        item = self._figure_item(None, chart={"reconciledValues": [{"value": 30.0, "rawText": "30.0%"}]})
        result = self._run_with_item(item, self.PROSE)
        claims = [signal for signal in result["signals"] if signal["kind"] == "chart_printed_value_mismatch"]
        self.assertEqual(len(claims), 1, result["signals"])
        self.assertAlmostEqual(claims[0]["reported"]["printed"], 30.0, places=6)

    def test_figure_without_extracted_values_emits_nothing(self):
        item = self._figure_item(None)
        result = self._run_with_item(item, self.PROSE)
        self.assertEqual(result["signals"], [])


class SensorWireInTests(FigureForensicsTestCase):
    def _duplicate_pdf(self):
        png = _png(53)
        return _pdf([((50, 50, 130, 110), png), ((250, 50, 330, 110), png)])

    def test_figure_forensics_is_disabled_by_default(self):
        raw = self._duplicate_pdf()
        summary = self.store.prepare(raw, sha(raw))
        result = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        self.assertNotIn("figureForensics", result)
        self.assertEqual(result["tier"], "P0")
        _assert_no_forbidden_keys(result)

    def test_figure_forensics_wire_in_appends_signals_and_summary(self):
        raw = self._duplicate_pdf()
        summary = self.store.prepare(raw, sha(raw))
        result = sensor.run_blue_sensor(
            summary["paperId"], summary["fileHash"], store=self.store, include_figure_forensics=True,
        )
        _assert_no_forbidden_keys(result)
        summary_facts = result["figureForensics"]
        self.assertTrue(summary_facts["enabled"])
        self.assertEqual(summary_facts["figureCount"], 2)
        self.assertGreaterEqual(summary_facts["signalCount"], 1)
        duplicates = [signal for signal in result["signals"] if signal["kind"] == "duplicate_figure_panel"]
        self.assertEqual(len(duplicates), 1)
        self.assertEqual(duplicates[0]["family"], "D4-1")
        self.assertEqual(duplicates[0]["subtype"], "image-reuse")
        self.assertIn("id", duplicates[0])
        self.assertEqual(result["tier"], "P0")

    def test_sensor_rejects_non_boolean_switch(self):
        raw = self._duplicate_pdf()
        summary = self.store.prepare(raw, sha(raw))
        with self.assertRaises(ValueError) as caught:
            sensor.run_blue_sensor(
                summary["paperId"], summary["fileHash"], store=self.store, include_figure_forensics="yes",
            )
        self.assertEqual(caught.exception.args[0], "include_figure_forensics")

    def test_http_blue_sensor_contract_is_unchanged(self):
        raw = self._duplicate_pdf()
        prep = pe.EvidenceStore()
        import paper_evidence_http as http
        prepared = http.prepare({"fileHash": sha(raw), "file": base64.b64encode(raw).decode()}, store=prep)
        result = http.query({"paperId": prepared["paperId"], "operation": "blue_sensor"}, store=prep)
        self.assertEqual(result["schema"], sensor.SCHEMA)
        self.assertNotIn("figureForensics", result)


class ModuleQualityTests(unittest.TestCase):
    def test_pure_python_fallback_matches_the_numpy_hash_path(self):
        pixmap = pymupdf.Pixmap(_png(59))
        with patch.object(fig, "_numpy_module", return_value=None):
            pure = fig._grid_hashes(pixmap)
        self.assertEqual(pure, fig._grid_hashes(pixmap))
        self.assertGreater(len(bin(pure["dhash"])), 60)

    def test_python_module_ccn_under_15(self):
        root = Path(__file__).resolve().parents[2]
        src = (root / "app" / "local" / "paper_figure_forensics.py").read_bytes()
        proc = subprocess.run(
            [sys.executable, str(root / "tools" / "quality" / "python-functions.py")],
            input=src,
            capture_output=True,
            check=True,
        )
        functions = json.loads(proc.stdout.decode("utf-8"))
        self.assertTrue(functions)
        self.assertTrue(all(fn["ccn"] <= 15 for fn in functions), [fn for fn in functions if fn["ccn"] > 15])


if __name__ == "__main__":
    unittest.main()

"""Tests for BLUE Layer 0 offline PDF forensic sensor, adjusted-p guard, HTTP wiring, and opt-in P2 oracle."""
import base64
import hashlib
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_blue_sensor as sensor
import paper_evidence as pe
import paper_evidence_http as http
import paper_stat_audit as audit

sha = lambda data: hashlib.sha256(data).hexdigest()
FORBIDDEN_RED_KEYS = {"before", "after", "patch", "gold", "why_hard", "candidateRationales"}


def _no_network(*args, **kwargs):
    raise AssertionError("unexpected_real_network_call")


def _sha_json(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode("utf-8")).hexdigest()


def _assert_no_forbidden_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert k not in FORBIDDEN_RED_KEYS, f"forbidden RED key leaked: {k}"
            _assert_no_forbidden_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_forbidden_keys(item)


class AdjustedPValueGuardTests(unittest.TestCase):
    def test_multiple_testing_cue_detection(self):
        for cue in (
            "Bonferroni-adjusted p = 0.11",
            "FDR q-value = 0.08",
            "Benjamini-Hochberg procedure",
            "Holm-Šidák correction",
            "Scheffé post-hoc",
            "Games-Howell test",
            "p_adj = 0.12",
            "padj = 0.09",
            "p-adj < 0.05",
            "multiple-testing correction",
            "다중비교 보정 p = 0.12",
            "보정된 p = 0.08",
        ):
            self.assertTrue(audit.has_multiple_testing_adjustment(cue), msg=cue)
        self.assertFalse(audit.has_multiple_testing_adjustment("Unadjusted two-tailed t-test p = 0.25"))

    def test_adjusted_p_guard_and_impossible_downward_claim(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 80), "Raw mismatch: t(28) = 2.50, p = 0.25.", fontsize=10)
        p0.insert_text((72, 100), "Adjusted valid: t(28) = 2.50, Bonferroni-adjusted p = 0.11.", fontsize=10)
        p0.insert_text((72, 120), "FDR adjusted valid: t(28) = 2.50, Benjamini-Hochberg FDR p = 0.09.", fontsize=10)
        p0.insert_text((72, 140), "Impossible downward: t(28) = 1.00, Bonferroni-adjusted p = 0.001.", fontsize=10)
        raw = doc.tobytes()
        doc.close()

        store = pe.EvidenceStore()
        summary = store.prepare(raw, sha(raw))
        res = audit.audit_paper_statistics(summary["paperId"], summary["fileHash"], store=store)
        mismatches = [s for s in res["signals"] if s["kind"] == "stat_pvalue_mismatch"]
        self.assertEqual(len(mismatches), 2)
        self.assertEqual([s["reported"]["p"] for s in mismatches], [0.25, 0.001])

    def test_table_header_context_suppresses_adjusted_p_false_positive(self):
        item = {
            "id": "tbl-adj",
            "type": "table",
            "pageIndex": 0,
            "table": {
                "cells": [
                    {"row": 0, "column": 0, "text": "Endpoint", "header": True},
                    {"row": 0, "column": 1, "text": "Bonferroni-adjusted p", "header": True},
                    {"row": 1, "column": 0, "text": "Outcome A", "header": False},
                    {"row": 1, "column": 1, "text": "t(28) = 2.50, p = 0.11", "header": False},
                ]
            },
        }
        sigs = audit._audit_table_item(item, 0, "tbl-adj")
        self.assertEqual([s for s in sigs if s["kind"] == "stat_pvalue_mismatch"], [])


class OfflineForensicSensorTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()
        self.store = pe.EvidenceStore()

    def tearDown(self):
        self._net.stop()

    def test_w5_d2_1_hidden_uri_doi_mismatch_offline(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "References", fontsize=12)
        ref_line = "[1] Kim J, Park S. Deep learning biomarkers (2023). Nature. doi:10.1038/s41586-023-00001-1"
        p0.insert_text((72, 100), ref_line, fontsize=9.5)
        p0.insert_link({
            "kind": pymupdf.LINK_URI,
            "from": pymupdf.Rect(70, 88, 520, 106),
            "uri": "https://doi.org/10.1038/s41586-019-99999-9",
        })
        raw = doc.tobytes()
        doc.close()

        summary = self.store.prepare(raw, sha(raw))
        res = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        self.assertEqual(res["schema"], sensor.SCHEMA)
        self.assertEqual(res["tier"], "P0")
        self.assertIsNone(res["oraclePack"])
        kinds = {s["kind"]: s for s in res["signals"]}
        self.assertIn("uri_visible_doi_mismatch", kinds)
        sig = kinds["uri_visible_doi_mismatch"]
        self.assertEqual(sig["family"], "D2")
        self.assertEqual(sig["subtype"], "identifier-hijack")
        self.assertEqual(sig["reported"]["visibleDoi"], "10.1038/s41586-023-00001-1")
        self.assertEqual(sig["computed"]["uriDoi"], "10.1038/s41586-019-99999-9")
        self.assertEqual(res["uriLinks"]["mismatchCount"], 1)
        _assert_no_forbidden_keys(res)

    def test_w5_d2_3_shared_uri_hijack_without_visible_doi(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "References", fontsize=12)
        p0.insert_text((72, 100), "[32] Alice B. Cardiac imaging cohort study. Science. 2021.", fontsize=9.5)
        p0.insert_link({
            "kind": pymupdf.LINK_URI,
            "from": pymupdf.Rect(70, 88, 450, 106),
            "uri": "https://doi.org/10.1126/science.abc1234",
        })
        p0.insert_text((72, 130), "[33] Bob C. Unrelated soil microbes analysis. Ecology. 2022.", fontsize=9.5)
        p0.insert_link({
            "kind": pymupdf.LINK_URI,
            "from": pymupdf.Rect(70, 118, 450, 136),
            "uri": "https://doi.org/10.1126/science.abc1234",
        })
        raw = doc.tobytes()
        doc.close()

        summary = self.store.prepare(raw, sha(raw))
        res = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        shared = [s for s in res["signals"] if s["kind"] == "duplicate_reference_uri_or_doi"]
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]["family"], "D2")
        self.assertEqual(shared[0]["subtype"], "identifier-hijack")
        self.assertEqual(shared[0]["reported"]["entries"], [32, 33])
        self.assertEqual(shared[0]["computed"]["target"], "10.1126/science.abc1234")
        self.assertEqual(res["uriLinks"]["sharedTargetCount"], 1)

    def test_w5_d2_2_duplicate_ref_out_of_range_citation_and_malformed_doi(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "Introduction", fontsize=12)
        p0.insert_text((72, 95), "Prior work [1, 99] and [2021] with probability in [0, 1].", fontsize=10)
        p0.insert_text((72, 130), "References", fontsize=12)
        p0.insert_text((72, 155), "[1] Lee K. Valid cardiology study. Lancet. 2021. doi:10.1016/S0140-6736(21)0001-2", fontsize=9)
        p0.insert_text((72, 175), "[4] Smith J. Identical trial outcomes in hypertension. JAMA. 2020.", fontsize=9)
        p0.insert_text((72, 195), "[5] Smith J. Identical trial outcomes in hypertension. JAMA. 2020.", fontsize=9)
        p0.insert_text((72, 215), "[6] Chen W. Corrupt DOI reference. Nature. 2022. doi:10.12/broken", fontsize=9)
        raw = doc.tobytes()
        doc.close()

        summary = self.store.prepare(raw, sha(raw))
        res = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        kinds = {s["kind"] for s in res["signals"]}
        self.assertIn("duplicate_reference_entry", kinds)
        self.assertIn("citation_index_out_of_range", kinds)
        self.assertIn("missing_reference_number", kinds)
        self.assertIn("malformed_doi", kinds)
        self.assertEqual(res["bibliography"]["duplicateCount"], 1)
        self.assertEqual(res["bibliography"]["outOfRangeCitations"], [99])
        # Verify valid parenthesized DOI is not falsely flagged as malformed
        mal_tokens = [s["reported"]["token"] for s in res["signals"] if s["kind"] == "malformed_doi"]
        self.assertEqual(mal_tokens, ["doi:10.12/broken"])

    def test_w4_fls8_acroform_widget_extraction(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 60), "Nature Research Reporting Summary", fontsize=12)
        specs = [
            ("author_name", "Corresponding author", "Dr. Jane Doe", 100),
            ("code_avail", "Code availability", "", 130),
            ("data_avail", "Data availability", "", 160),
        ]
        for name, label, val, y in specs:
            w = pymupdf.Widget()
            w.rect = pymupdf.Rect(72, y, 300, y + 20)
            w.field_name = name
            w.field_label = label
            w.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
            w.field_value = val
            p0.add_widget(w)
        raw = doc.tobytes()
        doc.close()

        summary = self.store.prepare(raw, sha(raw))
        res = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        self.assertEqual(res["acroForm"]["fieldCount"], 3)
        self.assertEqual(res["acroForm"]["filledCount"], 1)
        self.assertEqual(res["acroForm"]["emptyCount"], 2)
        self.assertEqual([f["fieldName"] for f in res["acroForm"]["fields"]], ["author_name", "code_avail", "data_avail"])
        acro_sigs = [s for s in res["signals"] if s["kind"] == "acroform_blank_fields"]
        self.assertEqual(len(acro_sigs), 1)
        self.assertEqual(acro_sigs[0]["family"], "D4-1")
        self.assertEqual(acro_sigs[0]["subtype"], "reporting-summary-incomplete")


class HttpAndOracleIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()
        self.store = pe.EvidenceStore()

    def tearDown(self):
        self._net.stop()

    def test_http_query_blue_sensor_and_validation(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 80), "Result: t(28) = 2.10, p = 0.002.", fontsize=10)
        raw = doc.tobytes()
        doc.close()

        prep = http.prepare({"fileHash": sha(raw), "file": base64.b64encode(raw).decode()}, store=self.store)
        res = http.query({"paperId": prep["paperId"], "operation": "blue_sensor"}, store=self.store)
        self.assertEqual(res["schema"], sensor.SCHEMA)
        self.assertEqual(res["tier"], "P0")
        self.assertIsNone(res["oraclePack"])
        self.assertTrue(any(s["family"] == "D1" and s["kind"] == "stat_pvalue_mismatch" for s in res["signals"]))

        for bad in (
            {"paperId": prep["paperId"], "operation": "blue_sensor", "maxSignals": 0},
            {"paperId": prep["paperId"], "operation": "blue_sensor", "maxSignals": True},
            {"paperId": prep["paperId"], "operation": "blue_sensor", "includeExternalOracle": "yes"},
        ):
            with self.assertRaises(ValueError) as caught:
                http.query(bad, store=self.store)
            self.assertEqual(caught.exception.args[0], "paper_evidence_request_invalid")

    def test_p2_oracle_datacite_404_and_clinical_trials(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "Trial NCT01234567 enrolled 200 patients.", fontsize=10)
        p0.insert_text((72, 90), "The primary outcome was overall survival at 12 months.", fontsize=10)
        p0.insert_text((72, 120), "References", fontsize=12)
        p0.insert_text((72, 145), "[1] Doe J. Open benchmark dataset. Zenodo. 2023. doi:10.5281/zenodo.123456", fontsize=9)
        p0.insert_text((72, 165), "[2] Fake X. Fabricated paper. Nature. 2024. doi:10.1000/fabricated404", fontsize=9)
        raw = doc.tobytes()
        doc.close()

        summary = self.store.prepare(raw, sha(raw))

        def bib_transport(provider, path):
            if provider == "crossref":
                return 404, None, hashlib.sha256(b"not found").hexdigest()
            if provider == "europepmc":
                empty = {"resultList": {"result": []}}
                return 200, empty, _sha_json(empty)
            if provider == "datacite" and "zenodo.123456" in path:
                dc = {"data": {"attributes": {
                    "doi": "10.5281/zenodo.123456",
                    "titles": [{"title": "Open benchmark dataset"}],
                    "creators": [{"name": "Doe, Jane", "familyName": "Doe"}],
                    "publicationYear": 2023,
                    "descriptions": [{"description": "Zenodo benchmark archive"}],
                }}}
                return 200, dc, _sha_json(dc)
            if provider == "datacite":
                return 404, None, hashlib.sha256(b"not found").hexdigest()
            raise AssertionError((provider, path))

        def trial_transport(nct_id):
            data = {"protocolSection": {
                "identificationModule": {"nctId": nct_id, "briefTitle": "Trial"},
                "statusModule": {"overallStatus": "COMPLETED"},
                "designModule": {"studyType": "INTERVENTIONAL", "enrollmentInfo": {"count": 100, "type": "ACTUAL"}},
                "outcomesModule": {
                    "primaryOutcomes": [{"measure": "Progression-free cardiac biomarker score", "timeFrame": "6 months"}],
                    "secondaryOutcomes": [{"measure": "Overall survival at 12 months", "timeFrame": "12 months"}],
                },
            }}
            return 200, data, _sha_json(data)

        res = sensor.run_blue_sensor(
            summary["paperId"], summary["fileHash"],
            include_external_oracle=True, store=self.store,
            bib_transport=bib_transport, trial_transport=trial_transport,
        )
        self.assertEqual(res["tier"], "P2")
        pack = res["oraclePack"]
        self.assertIsNotNone(pack)
        self.assertEqual(pack["bibliographySummary"]["counts"].get("verifiedByDatacite"), 1)
        self.assertEqual(pack["bibliographySummary"]["counts"].get("doiNotFoundInCrossref"), 1)
        self.assertEqual(len(pack["mismatchedReferences"]), 1)
        self.assertEqual(pack["mismatchedReferences"][0]["doi"], "10.1000/fabricated404")
        kinds = {s["kind"] for s in res["signals"]}
        self.assertIn("doi_not_found", kinds)
        self.assertIn("potential_outcome_switch", kinds)
        self.assertIn("enrollment_discrepancy_candidate", kinds)
        _assert_no_forbidden_keys(res)

    def test_p2_two_provider_mock_falls_back_gracefully(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "References", fontsize=12)
        p0.insert_text((72, 95), "[1] Fake X. Missing paper. Nature. 2024. doi:10.1000/missing404", fontsize=9)
        raw = doc.tobytes()
        doc.close()
        summary = self.store.prepare(raw, sha(raw))

        def two_provider_only(provider, path):
            if provider == "crossref":
                return 404, None, hashlib.sha256(b"404").hexdigest()
            if provider == "europepmc":
                empty = {"resultList": {"result": []}}
                return 200, empty, _sha_json(empty)
            raise AssertionError(f"unsupported provider {provider}")

        res = sensor.run_blue_sensor(
            summary["paperId"], summary["fileHash"],
            include_external_oracle=True, store=self.store,
            bib_transport=two_provider_only,
        )
        self.assertEqual(res["tier"], "P2")
        self.assertTrue(any(s["kind"] == "doi_not_found" for s in res["signals"]))


if __name__ == "__main__":
    unittest.main()

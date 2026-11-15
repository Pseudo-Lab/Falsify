"""Offline unit and integration tests for retracted citations and scientific registry/accession verification."""
import hashlib
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_blue_sensor as sensor
import paper_evidence as pe
import paper_external_grounding as peg
import paper_registry_identifiers as pri

FORBIDDEN_RED_KEYS = {"before", "after", "patch", "gold", "why_hard", "candidateRationales"}


def _no_network(*args, **kwargs):
    raise AssertionError("unexpected_real_network_call")


def _sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


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


class RetractedCitationDetectionTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_crossref_and_epmc_retraction_normalization(self):
        cr_row = {
            "DOI": "10.1000/ret1",
            "title": ["Effects of Drug X on Mortality"],
            "author": [{"given": "Jane", "family": "Doe"}],
            "published": {"date-parts": [[2021]]},
            "update-to": [{"type": "retraction", "DOI": "10.1000/ret1-notice"}],
        }
        rec1 = peg._normalize_crossref_work(cr_row, "sha1", "2026-01-01T00:00:00Z")
        self.assertTrue(rec1["retracted"])
        self.assertEqual(rec1["retractionType"], "retraction")
        self.assertTrue(rec1["retractionDetails"]["sources"])

        cr_rel = {
            "DOI": "10.1000/ret2",
            "title": ["Withdrawn: Flawed Meta-Analysis"],
            "relation": {"is-retracted-by": [{"id": "10.1000/notice2"}]},
        }
        rec2 = peg._normalize_crossref_work(cr_rel, "sha2", "2026-01-01T00:00:00Z")
        self.assertTrue(rec2["retracted"])
        self.assertEqual(rec2["retractionType"], "retraction")

        epmc_row = {
            "doi": "10.1000/eoc1",
            "title": "Biomarker Trial in Sepsis",
            "authorString": "Kim S",
            "pubYear": "2022",
            "pubTypeList": {"pubType": ["Journal Article", "Expression of Concern"]},
        }
        rec3 = peg._normalize_epmc_work(epmc_row, "sha3", "2026-01-01T00:00:00Z")
        self.assertTrue(rec3["retracted"])
        self.assertEqual(rec3["retractionType"], "expression_of_concern")

    def test_verify_bibliography_flags_retracted_unless_acknowledged(self):
        refs = [
            "[1] Doe J. Hydroxychloroquine observational outcomes. Lancet. 2020; doi:10.1000/ret-cr",
            "[2] Lee K. Retracted trial acknowledged by author (Retracted). NEJM. 2020; doi:10.1000/ret-ack",
            "[3] Park H. 철회된 논문 인용 예시 (철회). JAMA. 2021; doi:10.1000/ret-ko",
            "[4] Chen M. Sepsis biomarker cohort. BMJ. 2022; doi:10.1000/eoc-epmc",
            "[5] Smith A. Clean cardiology study. Circulation. 2023; doi:10.1000/clean1",
        ]

        def mock_transport(provider, path):
            if provider == "crossref" and "10.1000%2Fret-cr" in path:
                data = {"message": {
                    "DOI": "10.1000/ret-cr",
                    "title": ["Hydroxychloroquine observational outcomes"],
                    "author": [{"given": "J", "family": "Doe"}],
                    "published": {"date-parts": [[2020]]},
                    "update-to": [{"type": "retraction"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "10.1000%2Fret-ack" in path:
                data = {"message": {
                    "DOI": "10.1000/ret-ack",
                    "title": ["Retracted trial acknowledged by author"],
                    "author": [{"given": "K", "family": "Lee"}],
                    "published": {"date-parts": [[2020]]},
                    "update-to": [{"type": "retraction"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "10.1000%2Fret-ko" in path:
                data = {"message": {
                    "DOI": "10.1000/ret-ko",
                    "title": ["Sepsis clinical trial"],
                    "author": [{"given": "H", "family": "Park"}],
                    "published": {"date-parts": [[2021]]},
                    "update-to": [{"type": "retraction"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "10.1000%2Feoc-epmc" in path:
                data = {"message": {
                    "DOI": "10.1000/eoc-epmc",
                    "title": ["Sepsis biomarker cohort"],
                    "author": [{"given": "M", "family": "Chen"}],
                    "published": {"date-parts": [[2022]]},
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "10.1000%2Fclean1" in path:
                data = {"message": {
                    "DOI": "10.1000/clean1",
                    "title": ["Clean cardiology study"],
                    "author": [{"given": "A", "family": "Smith"}],
                    "published": {"date-parts": [[2023]]},
                }}
                return 200, data, _sha_json(data)
            if provider == "europepmc" and "ret-cr" in path:
                data = {"resultList": {"result": [{
                    "doi": "10.1000/ret-cr",
                    "title": "Hydroxychloroquine observational outcomes",
                    "authorString": "Doe J",
                    "pubYear": "2020",
                    "abstractText": "Abstract present in Europe PMC without retraction field.",
                }]}}
                return 200, data, _sha_json(data)
            if provider == "europepmc" and "eoc-epmc" in path:
                data = {"resultList": {"result": [{
                    "doi": "10.1000/eoc-epmc",
                    "title": "Sepsis biomarker cohort",
                    "authorString": "Chen M",
                    "pubYear": "2022",
                    "pubTypeList": {"pubType": ["Journal Article", "Expression of Concern"]},
                }]}}
                return 200, data, _sha_json(data)
            if provider == "europepmc":
                empty = {"resultList": {"result": []}}
                return 200, empty, _sha_json(empty)
            raise AssertionError((provider, path))

        out = peg.verify_bibliography(refs, max_refs=25, transport=mock_transport)
        self.assertEqual([r["status"] for r in out["results"]], ["verified_match"] * 5)
        self.assertTrue(out["results"][0]["retracted"])
        self.assertEqual(out["results"][0]["retractionType"], "retraction")
        self.assertFalse(out["results"][1]["retracted"])
        self.assertTrue(out["results"][1].get("retractionAcknowledged"))
        self.assertFalse(out["results"][2]["retracted"])
        self.assertTrue(out["results"][2].get("retractionAcknowledged"))
        self.assertTrue(out["results"][3]["retracted"])
        self.assertEqual(out["results"][3]["retractionType"], "expression_of_concern")
        self.assertFalse(out["results"][4]["retracted"])
        self.assertEqual(out["summary"]["retractedCount"], 2)


class OfflineIdentifierAuditTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_extract_identifiers_and_pdb_cue_precision(self):
        text = (
            "Preregistered at https://osf.io/ab12c/files and osf.io/login or osf.io/share or osf.io/about. "
            "Systematic review CRD42021123456. Data deposited under GSE123456 and duplicate GSE123456. "
            "Crystal structure PDB ID: 9XYZ and https://www.rcsb.org/structure/4hhb. "
            "In 2024 we administered 10mg daily; code 1A2B without cue is not a PDB ID."
        )
        extracted = pri.extract_scientific_identifiers(text)
        self.assertEqual(extracted["osf"], ["ab12c"])
        self.assertEqual(extracted["prospero"], ["CRD42021123456"])
        self.assertEqual(extracted["geo"], ["GSE123456"])
        self.assertEqual(extracted["pdb"], ["9XYZ", "4HHB"])

    def test_audit_offline_flags_malformed_prospero_and_placeholders(self):
        text = (
            "Protocol CRD99999999 and CRD00000000000 alongside valid CRD42022100001. "
            "Code at osf.io/00000, dataset GSE00000, and trial NCT00000000."
        )
        audit = pri.audit_identifiers_offline(text)
        kinds = [s["kind"] for s in audit["signals"]]
        self.assertEqual(kinds.count("malformed_prospero_id"), 2)
        self.assertIn("placeholder_osf_id", kinds)
        self.assertIn("placeholder_geo_accession", kinds)
        self.assertIn("placeholder_nct_id", kinds)
        for sig in audit["signals"]:
            self.assertIn(sig["family"], ("D4-1", "D2"))


class OnlineIdentifierVerificationTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_security_boundaries_reject_private_ip_and_bad_provider(self):
        private_addr = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(socket, "getaddrinfo", return_value=private_addr):
            with self.assertRaisesRegex(ValueError, "non_public_api_address"):
                pri.fetch_identifier_json("osf", "/v2/nodes/abc12/")
        with self.assertRaisesRegex(ValueError, "unknown_provider"):
            pri.fetch_identifier_json("evil.example.com", "/v2/nodes/abc12/")
        with self.assertRaisesRegex(ValueError, "invalid_api_path"):
            pri.fetch_identifier_json("osf", "v2/nodes/abc12/")

    def test_p2_verify_osf_geo_pdb_and_prospero_truthfulness(self):
        extracted = pri.extract_scientific_identifiers(
            "OSF osf.io/reg20 and osf.io/miss1. "
            "GEO GSE200001 and GSE40400. "
            "PDB ID: 4HHB and PDB ID: 9XYZ. "
            "PROSPERO CRD42023123456."
        )

        def mock_id_transport(provider, path):
            if provider == "osf" and path == "/v2/nodes/reg20/":
                return 404, None, _sha_bytes(b"404")
            if provider == "osf" and path == "/v2/registrations/reg20/":
                data = {"data": {"type": "registrations", "attributes": {"title": "Preregistered Study", "registration": True}}}
                return 200, data, _sha_json(data)
            if provider == "osf" and path in ("/v2/nodes/miss1/", "/v2/registrations/miss1/"):
                return 404, None, _sha_bytes(b"404")
            if provider == "ncbi" and "GSE200001" in path:
                data = {"esearchresult": {"count": "1", "idlist": ["200200001"]}}
                return 200, data, _sha_json(data)
            if provider == "ncbi" and "GSE40400" in path:
                data = {"esearchresult": {"count": "0", "idlist": []}}
                return 200, data, _sha_json(data)
            if provider == "rcsb" and path == "/rest/v1/core/entry/4HHB":
                data = {"struct": {"title": "Deoxyhaemoglobin crystal structure"}}
                return 200, data, _sha_json(data)
            if provider == "rcsb" and path == "/rest/v1/core/entry/9XYZ":
                return 404, None, _sha_bytes(b"404")
            raise AssertionError((provider, path))

        res = pri.verify_identifiers_online(extracted, transport=mock_id_transport)
        self.assertEqual(res["schema"], pri.SCHEMA)
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["summary"]["osfVerified"], 1)
        self.assertEqual(res["summary"]["osfUnresolved"], 1)
        self.assertEqual(res["summary"]["geoVerified"], 1)
        self.assertEqual(res["summary"]["geoUnresolved"], 1)
        self.assertEqual(res["summary"]["pdbVerified"], 1)
        self.assertEqual(res["summary"]["pdbUnresolved"], 1)
        self.assertEqual(res["summary"]["prosperoChecked"], 1)
        kinds = {s["kind"]: s for s in res["signals"]}
        self.assertEqual(set(kinds), {"unresolved_osf_id", "unresolved_geo_accession", "unresolved_pdb_accession"})
        self.assertEqual(kinds["unresolved_osf_id"]["family"], "D4-1")
        self.assertEqual(kinds["unresolved_geo_accession"]["family"], "D2")
        self.assertEqual(kinds["unresolved_pdb_accession"]["family"], "D2")
        self.assertIn("does not prove fabrication", res["limitations"])
        prospero_chk = next(c for c in res["checks"] if c["type"] == "prospero")
        self.assertEqual(prospero_chk["status"], "syntax_verified_no_public_api")

    def test_p2_verify_osf_mutable_node_and_lookup_budget(self):
        extracted = pri.extract_scientific_identifiers(
            "OSF osf.io/node1 osf.io/node2. GEO GSE100001. PDB ID: 4HHB."
        )

        def mock_id_transport(provider, path):
            if provider == "osf" and path == "/v2/nodes/node1/":
                data = {"data": {"type": "nodes", "attributes": {"title": "Mutable OSF Project", "registration": False}}}
                return 200, data, _sha_json(data)
            if provider == "osf" and path == "/v2/nodes/node2/":
                data = {"data": {"type": "nodes", "attributes": {"title": "Second Node", "registration": False}}}
                return 200, data, _sha_json(data)
            raise AssertionError((provider, path))

        res = pri.verify_identifiers_online(extracted, transport=mock_id_transport, max_lookups=2)
        self.assertTrue(res["truncated"])
        self.assertEqual(res["summary"]["osfVerified"], 2)
        self.assertEqual(res["checks"][0]["kind"], "node")
        self.assertFalse(res["checks"][0]["isRegistration"])


class BlueSensorIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()
        self.store = pe.EvidenceStore()

    def tearDown(self):
        self._net.stop()

    def _build_pdf(self):
        doc = pymupdf.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((72, 70), "Methods", fontsize=12)
        p0.insert_text((72, 95), "Protocol CRD99999999, OSF osf.io/00000 and osf.io/miss9.", fontsize=10)
        p0.insert_text((72, 115), "RNA-seq GEO GSE00000 and GSE998877; structure PDB ID: 9XYZ (year 2024).", fontsize=10)
        p0.insert_text((72, 145), "References", fontsize=12)
        p0.insert_text((72, 170), "[1] Doe J. Hydroxychloroquine trial outcomes. Lancet. 2020. doi:10.1000/ret-cr", fontsize=9)
        p0.insert_text((72, 190), "[2] Lee K. Acknowledged citation (Retracted). NEJM. 2020. doi:10.1000/ret-ack", fontsize=9)
        p0.insert_text((72, 210), "[3] Chen M. Biomarker cohort. BMJ. 2022. doi:10.1000/eoc-epmc", fontsize=9)
        p0.insert_text((72, 230), "[4] Park S. Sepsis follow-up study. JAMA. 2023. doi:10.1000/eoc-concern", fontsize=9)
        raw = doc.tobytes()
        doc.close()
        return raw

    def test_end_to_end_p0_and_p2_retraction_and_registries(self):
        raw = self._build_pdf()
        summary = self.store.prepare(raw, _sha_bytes(raw))

        p0_res = sensor.run_blue_sensor(summary["paperId"], summary["fileHash"], store=self.store)
        self.assertEqual(p0_res["tier"], "P0")
        self.assertIsNone(p0_res["oraclePack"])
        self.assertEqual(p0_res["identifiers"]["pdb"], ["9XYZ"])
        p0_kinds = {s["kind"] for s in p0_res["signals"]}
        self.assertIn("malformed_prospero_id", p0_kinds)
        self.assertIn("placeholder_osf_id", p0_kinds)
        self.assertIn("placeholder_geo_accession", p0_kinds)
        _assert_no_forbidden_keys(p0_res)

        def bib_transport(provider, path):
            if provider == "crossref" and "ret-cr" in path:
                data = {"message": {
                    "DOI": "10.1000/ret-cr", "title": ["Hydroxychloroquine trial outcomes"],
                    "author": [{"given": "J", "family": "Doe"}], "published": {"date-parts": [[2020]]},
                    "update-to": [{"type": "retraction"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "ret-ack" in path:
                data = {"message": {
                    "DOI": "10.1000/ret-ack", "title": ["Acknowledged citation"],
                    "author": [{"given": "K", "family": "Lee"}], "published": {"date-parts": [[2020]]},
                    "update-to": [{"type": "retraction"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "eoc-epmc" in path:
                data = {"message": {
                    "DOI": "10.1000/eoc-epmc", "title": ["Biomarker cohort"],
                    "author": [{"given": "M", "family": "Chen"}], "published": {"date-parts": [[2022]]},
                }}
                return 200, data, _sha_json(data)
            if provider == "crossref" and "eoc-concern" in path:
                data = {"message": {
                    "DOI": "10.1000/eoc-concern", "title": ["Sepsis follow-up study"],
                    "author": [{"given": "S", "family": "Park"}], "published": {"date-parts": [[2023]]},
                    "update-to": [{"type": "expression-of-concern"}],
                }}
                return 200, data, _sha_json(data)
            if provider == "europepmc" and "eoc-epmc" in path:
                data = {"resultList": {"result": [{
                    "doi": "10.1000/eoc-epmc", "title": "Biomarker cohort",
                    "authorString": "Chen M", "pubYear": "2022",
                    "pubTypeList": {"pubType": ["Retracted Publication"]},
                }]}}
                return 200, data, _sha_json(data)
            if provider == "europepmc":
                empty = {"resultList": {"result": []}}
                return 200, empty, _sha_json(empty)
            raise AssertionError((provider, path))

        def id_transport(provider, path):
            if provider == "osf":
                return 404, None, _sha_bytes(b"404")
            if provider == "ncbi":
                data = {"esearchresult": {"count": "0", "idlist": []}}
                return 200, data, _sha_json(data)
            if provider == "rcsb":
                return 404, None, _sha_bytes(b"404")
            raise AssertionError((provider, path))

        p2_res = sensor.run_blue_sensor(
            summary["paperId"], summary["fileHash"],
            include_external_oracle=True, store=self.store,
            bib_transport=bib_transport, identifier_transport=id_transport,
        )
        self.assertEqual(p2_res["tier"], "P2")
        p2_kinds = {s["kind"] for s in p2_res["signals"]}
        self.assertIn("retracted_citation", p2_kinds)
        self.assertIn("expression_of_concern_citation", p2_kinds)
        self.assertIn("unresolved_osf_id", p2_kinds)
        self.assertIn("unresolved_geo_accession", p2_kinds)
        self.assertIn("unresolved_pdb_accession", p2_kinds)

        ret_sigs = [s for s in p2_res["signals"] if s["kind"] in ("retracted_citation", "expression_of_concern_citation")]
        self.assertEqual(len(ret_sigs), 3)
        for sig in ret_sigs:
            self.assertEqual(sig["family"], "D2")
            self.assertEqual(sig["subtype"], "retracted-reference")

        pack = p2_res["oraclePack"]
        self.assertEqual(pack["bibliographySummary"]["counts"]["retractedCount"], 3)
        self.assertEqual(len(pack["retractedReferences"]), 3)
        self.assertNotIn("10.1000/ret-ack", [r["doi"] for r in pack["retractedReferences"]])
        self.assertEqual(pack["identifierChecks"]["schema"], pri.SCHEMA)
        _assert_no_forbidden_keys(p2_res)


if __name__ == "__main__":
    unittest.main()

"""Unit and stdio MCP integration tests for paper_mcp_bundle and opt-in --supplement / --oracle tools."""
import hashlib
import io
import json
import socket
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import anyio
import pymupdf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
sys.path.insert(0, str(LOCAL))

import paper_evidence as pe  # noqa: E402
import paper_mcp  # noqa: E402
import paper_mcp_bundle as bundle_mod  # noqa: E402


def _no_network(*_args, **_kwargs):
    raise AssertionError("unexpected_real_network_call")


def _make_docx_bytes(paragraphs):
    body = "".join(
        f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
        for text in paragraphs
    )
    doc_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        zf.writestr("word/document.xml", doc_xml.encode("utf-8"))
    return buf.getvalue()


def _make_pdf_bytes(pages):
    doc = pymupdf.open()
    for lines in pages:
        page = doc.new_page(width=595, height=842)
        y = 72
        for line in lines:
            page.insert_text((72, y), line, fontsize=10.5)
            y += 18
    raw = doc.tobytes()
    doc.close()
    return raw


class BundleLoaderAndGuardTests(unittest.TestCase):
    def test_load_rejects_invalid_and_red_key_contaminated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                bundle_mod.load_selected_supplements([str(folder / "missing.txt")])
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                bundle_mod.load_selected_supplements([str(folder)])
            empty = folder / "empty.csv"
            empty.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                bundle_mod.load_selected_supplements([str(empty)])
            nul_blob = folder / "blob.log"
            nul_blob.write_bytes(b"abc\x00def")
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                bundle_mod.load_selected_supplements([str(nul_blob)])
            too_many = []
            for i in range(13):
                p = folder / f"s{i}.txt"
                p.write_text("ok", encoding="utf-8")
                too_many.append(str(p))
            with self.assertRaisesRegex(ValueError, "paper_evidence_supplement_invalid"):
                bundle_mod.load_selected_supplements(too_many)
            red_json = folder / "red_leak.json"
            red_json.write_text(json.dumps({"nested": [{"why_hard": "leak"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
                bundle_mod.load_selected_supplements([str(red_json)])

            supp_pdf = folder / "Table_S2.pdf"
            supp_pdf.write_bytes(_make_pdf_bytes([["Table S2: sensitivity outcomes.", "accuracy = 0.91"]]))
            loaded = bundle_mod.load_selected_supplements([str(supp_pdf)])
            self.assertEqual(len(loaded), 1)
            self.assertEqual(loaded[0]["supplementId"], "supp-1")
            self.assertEqual(loaded[0]["name"], "Table_S2.pdf")
            self.assertIn("Table S2", loaded[0]["text"])

    def test_main_exits_2_on_red_key_supplement(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pdf = folder / "paper.pdf"
            pdf.write_bytes(_make_pdf_bytes([["Simple paper text."]]))
            bad_json = folder / "bad.json"
            bad_json.write_text(json.dumps({"gold": "secret"}), encoding="utf-8")
            stderr = io.StringIO()
            with patch("sys.stderr", stderr):
                code = paper_mcp.main(["--pdf", str(pdf), "--supplement", str(bad_json)])
            self.assertEqual(code, 2)
            self.assertEqual(stderr.getvalue().strip(), "forbidden_red_key")

    def test_complexity_ccn_gate_on_owned_production_modules(self):
        script = ROOT / "tools" / "quality" / "python-functions.py"
        for rel in ("app/local/paper_mcp.py", "app/local/paper_mcp_bundle.py"):
            source = (ROOT / rel).read_text(encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=source,
                text=True,
                capture_output=True,
                check=True,
            )
            funcs = json.loads(proc.stdout)
            too_complex = [f for f in funcs if f["ccn"] > 15]
            self.assertEqual(too_complex, [], msg=f"{rel} exceeded CCN 15: {too_complex}")


class SupplementStdioMcpTests(unittest.TestCase):
    def test_stdio_supplement_bundle_list_read_and_audit(self):
        main_pdf = _make_pdf_bytes([[
            "We enrolled N = 240 participants across 3 clinics. Final accuracy = 94.2%.",
            "See Table S1 for model metrics and Table S4 for subgroup sensitivity.",
        ]])
        csv_lines = ["patient_id,clinic,outcome"] + [f"ID{i},C1,{i % 2}" for i in range(1, 186)]
        docx_bytes = _make_docx_bytes([
            "Table S1: supplementary metrics summary.",
            "Additional protocol details in Supplementary Note S1.",
        ])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pdf = folder / "main.pdf"
            pdf.write_bytes(main_pdf)
            csv_path = folder / "participants.csv"
            csv_path.write_text("\n".join(csv_lines), encoding="utf-8")
            log_path = folder / "run_eval.log"
            log_path.write_text("Loaded 185 rows\naccuracy = 0.812\nF1 = 0.79\n", encoding="utf-8")
            docx_path = folder / "supplement_notes.docx"
            docx_path.write_bytes(docx_bytes)
            err_path = folder / "stderr.txt"

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[
                        str(LOCAL / "paper_mcp.py"),
                        "--pdf", str(pdf),
                        "--supplement", str(csv_path),
                        "--supplement", str(log_path),
                        "--supplement", str(docx_path),
                    ],
                    cwd=folder,
                    env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                )
                with err_path.open("w", encoding="utf-8") as err:
                    with anyio.fail_after(45):
                        async with stdio_client(params, errlog=err) as (read, write):
                            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=20)) as session:
                                init = await session.initialize()
                                binding = json.loads(init.instructions.split("Selected PDF: ", 1)[1])
                                pid = binding["paperId"]
                                self.assertEqual(binding["supplementCount"], 3)
                                tools = (await session.list_tools()).tools
                                by_name = {t.name: t for t in tools}
                                self.assertTrue({"list_supplements", "read_supplement", "audit_supplements"}.issubset(by_name))
                                self.assertNotIn("verify_references", by_name)
                                self.assertNotIn("verify_registries", by_name)
                                for name in ("list_supplements", "read_supplement", "audit_supplements"):
                                    self.assertTrue(by_name[name].annotations.readOnlyHint)
                                    self.assertFalse(by_name[name].annotations.destructiveHint)
                                    self.assertFalse(by_name[name].annotations.openWorldHint)
                                    self.assertIn("Read-only", by_name[name].description or "")

                                listed = await session.call_tool("list_supplements", {"paperId": pid})
                                self.assertFalse(listed.isError)
                                supps = listed.structuredContent["supplements"]
                                self.assertEqual([s["supplementId"] for s in supps], ["supp-1", "supp-2", "supp-3"])
                                self.assertEqual([s["name"] for s in supps], ["participants.csv", "run_eval.log", "supplement_notes.docx"])
                                dumped_list = json.dumps(listed.structuredContent)
                                self.assertNotIn(str(folder), dumped_list)
                                self.assertTrue(all("text" not in s for s in supps))

                                page1 = await session.call_tool("read_supplement", {"paperId": pid, "supplementId": "supp-3", "offset": 0, "limit": 25})
                                self.assertFalse(page1.isError)
                                self.assertTrue(page1.structuredContent["truncated"])
                                next_off = page1.structuredContent["nextOffset"]
                                self.assertEqual(next_off, 25)
                                page2 = await session.call_tool("read_supplement", {"paperId": pid, "supplementId": "supp-3", "offset": next_off, "limit": 200})
                                self.assertFalse(page2.isError)
                                self.assertFalse(page2.structuredContent["truncated"])
                                combined = page1.structuredContent["text"] + page2.structuredContent["text"]
                                self.assertIn("Table S1", combined)
                                self.assertIn("Supplementary Note S1", combined)

                                bad_id = await session.call_tool("read_supplement", {"paperId": pid, "supplementId": "supp-99"})
                                self.assertTrue(bad_id.isError)
                                self.assertEqual(bad_id.structuredContent["error"], "paper_evidence_unknown_id")

                                audited = await session.call_tool("audit_supplements", {"paperId": pid, "maxSignals": 50})
                                self.assertFalse(audited.isError)
                                sc = audited.structuredContent
                                self.assertEqual(sc["schema"], "falsify.paper-supplement-audit.v1")
                                self.assertEqual(sc["paperId"], pid)
                                self.assertEqual(sc["fileHash"], hashlib.sha256(main_pdf).hexdigest())
                                kinds = {s["kind"] for s in sc["signals"]}
                                self.assertIn("missing_supplementary_item", kinds)
                                self.assertIn("cross_file_sample_size_mismatch", kinds)
                                missing = [s for s in sc["signals"] if s["kind"] == "missing_supplementary_item"]
                                self.assertEqual(missing[0]["reported"]["item"], "Table S4")
                                sample_sig = [s for s in sc["signals"] if s["kind"] == "cross_file_sample_size_mismatch"][0]
                                self.assertEqual(sample_sig["reported"]["mainN"], 240)
                                self.assertEqual(sample_sig["computed"]["supplementN"], 185)

            try:
                anyio.run(run)
            except Exception as exc:
                err = err_path.read_text(encoding="utf-8", errors="replace") if err_path.exists() else ""
                raise AssertionError(f"{exc}\n--- stderr ---\n{err}") from exc


class OracleToolsAndPayloadTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, "create_connection", side_effect=_no_network)
        self._net.start()
        self.store = pe.EvidenceStore()

    def tearDown(self):
        self._net.stop()

    def test_oracle_annotations_only_registered_when_enabled(self):
        raw = _make_pdf_bytes([["Minimal offline PDF."]])
        digest = hashlib.sha256(raw).hexdigest()
        summary = self.store.prepare(raw, digest)
        pid = summary["paperId"]

        default_srv = paper_mcp.build_server(self.store, pid, digest, enable_oracle=False)
        default_tools = anyio.run(default_srv.list_tools)
        self.assertTrue(all(not t.annotations.openWorldHint for t in default_tools))
        self.assertNotIn("verify_references", {t.name for t in default_tools})
        self.assertNotIn("verify_registries", {t.name for t in default_tools})

        oracle_srv = paper_mcp.build_server(self.store, pid, digest, enable_oracle=True)
        oracle_tools = anyio.run(oracle_srv.list_tools)
        by_name = {t.name: t for t in oracle_tools}
        self.assertIn("verify_references", by_name)
        self.assertIn("verify_registries", by_name)
        for name, tool in by_name.items():
            self.assertIn("Read-only", tool.description or "")
            self.assertTrue(tool.annotations.readOnlyHint)
            self.assertFalse(tool.annotations.destructiveHint)
            if name in ("verify_references", "verify_registries"):
                self.assertTrue(tool.annotations.openWorldHint)
            else:
                self.assertFalse(tool.annotations.openWorldHint)

    def test_verify_references_payload_detects_retracted_and_missing_dois_offline(self):
        raw = _make_pdf_bytes([
            [
                "Methods and Results",
                "Earlier trial [3] reported a 22% mortality reduction (p = 0.01).",
            ],
            [
                "References",
                "[1] Smith J. Efficacy of drug X. 2022. doi:10.1000/trial-1",
                "[2] Doe A. Ghost bibliography entry. 2023. doi:10.1000/missing-2",
                "[3] Lee B. Valid mortality study. 2024. doi:10.1000/valid-3",
            ],
        ])
        digest = hashlib.sha256(raw).hexdigest()
        summary = self.store.prepare(raw, digest)
        pid = summary["paperId"]

        def fake_bib_transport(provider, path):
            if provider == "crossref" and "10.1000%2Ftrial-1" in path:
                payload = {
                    "message": {
                        "DOI": "10.1000/trial-1",
                        "title": ["Efficacy of drug X"],
                        "author": [{"given": "J", "family": "Smith"}],
                        "published": {"date-parts": [[2022]]},
                        "update-to": [{"type": "retraction", "DOI": "10.1000/retraction-notice"}],
                    }
                }
                return 200, payload, hashlib.sha256(b"ret").hexdigest()
            if provider == "crossref" and "10.1000%2Fmissing-2" in path:
                return 404, None, hashlib.sha256(b"404").hexdigest()
            if provider == "crossref" and "10.1000%2Fvalid-3" in path:
                payload = {
                    "message": {
                        "DOI": "10.1000/valid-3",
                        "title": ["Valid mortality study"],
                        "author": [{"given": "B", "family": "Lee"}],
                        "published": {"date-parts": [[2024]]},
                        "abstract": "<p>Randomized trial showing 22% mortality reduction.</p>",
                    }
                }
                return 200, payload, hashlib.sha256(b"val").hexdigest()
            return 200, {"resultList": {"result": []}}, hashlib.sha256(b"empty").hexdigest()

        res = bundle_mod.verify_references_payload(
            self.store, pid, digest, max_refs=10, include_claim_grounding=True, transport=fake_bib_transport
        )
        self.assertEqual(res["schema"], "falsify.mcp-reference-oracle.v1")
        self.assertEqual(res["paperId"], pid)
        self.assertEqual(res["fileHash"], digest)
        bib = res["bibliography"]
        self.assertEqual(bib["summary"]["retractedCount"], 1)
        self.assertEqual(bib["summary"]["doiNotFoundInCrossref"], 1)
        self.assertEqual(bib["summary"]["verifiedMatch"], 2)
        self.assertTrue(bib["results"][0]["retracted"])
        self.assertEqual(res["claimGroundings"]["status"], "completed")
        self.assertIn("not full text", res["limitations"])

    def test_verify_registries_payload_nct_osf_prospero_geo_pdb_offline(self):
        raw = _make_pdf_bytes([[
            "Clinical trial NCT01234567 enrolled 200 participants.",
            "The primary outcome was overall survival at 24 months.",
            "Pre-registration at https://osf.io/abcde/ and PROSPERO CRD42023123456.",
            "RNA-seq deposited at GSE98765 and crystal structure PDB ID: 4HHB.",
        ]])
        digest = hashlib.sha256(raw).hexdigest()
        summary = self.store.prepare(raw, digest)
        pid = summary["paperId"]

        def fake_trial_transport(nct_id):
            self.assertEqual(nct_id, "NCT01234567")
            return 200, {
                "protocolSection": {
                    "identificationModule": {"nctId": "NCT01234567", "briefTitle": "Trial Alpha"},
                    "statusModule": {"overallStatus": "COMPLETED"},
                    "designModule": {"studyType": "INTERVENTIONAL", "enrollmentInfo": {"count": 100, "type": "ACTUAL"}},
                    "outcomesModule": {
                        "primaryOutcomes": [{"measure": "Progression-free survival at 12 months", "timeFrame": "12m"}],
                        "secondaryOutcomes": [{"measure": "Overall survival at 24 months", "timeFrame": "24m"}],
                    },
                }
            }, hashlib.sha256(b"nct").hexdigest()

        def fake_id_fetcher(provider, path):
            if provider == "osf" and "/v2/nodes/abcde/" in path:
                return 200, {"data": {"type": "registrations", "attributes": {"title": "OSF Pre-reg", "registration": True}}}, hashlib.sha256(b"osf").hexdigest()
            if provider == "ncbi" and "GSE98765" in path:
                return 200, {"esearchresult": {"count": "1", "idlist": ["200098765"]}}, hashlib.sha256(b"geo").hexdigest()
            if provider == "rcsb" and "4HHB" in path:
                return 200, {"struct": {"title": "Hemoglobin structure"}}, hashlib.sha256(b"pdb").hexdigest()
            return 404, None, hashlib.sha256(b"404").hexdigest()

        res = bundle_mod.verify_registries_payload(
            self.store, pid, digest,
            max_lookups=20,
            registry_transport=fake_trial_transport,
            identifier_fetcher=fake_id_fetcher,
        )
        self.assertEqual(res["schema"], "falsify.mcp-registry-oracle.v1")
        self.assertEqual(res["paperId"], pid)
        self.assertEqual(res["fileHash"], digest)
        self.assertEqual(res["clinicalTrials"]["trialIds"], ["NCT01234567"])
        flags = res["registryComparisons"][0]["flags"]
        self.assertIn("potential_outcome_switch", flags)
        self.assertIn("enrollment_discrepancy_candidate", flags)
        checks_by_type = {c["type"]: c for c in res["identifiers"]["checks"]}
        self.assertEqual(checks_by_type["osf"]["status"], "verified")
        self.assertEqual(checks_by_type["prospero"]["status"], "syntax_verified_no_public_api")
        self.assertEqual(checks_by_type["geo"]["status"], "verified")
        self.assertEqual(checks_by_type["pdb"]["status"], "verified")

    def test_stdio_oracle_flag_registers_and_runs_with_mocked_transports(self):
        raw = _make_pdf_bytes([[
            "NCT07654321 enrolled 150 participants. Primary outcome was pain score at 6 months.",
            "Pre-registered at https://osf.io/xyz98/ and GSE12345.",
            "References",
            "[1] Kim H. Pilot study. 2023. doi:10.1000/pilot-1",
        ]])
        child_src = (
            "import hashlib, sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import paper_mcp_bundle as b\n"
            "def _bib(provider, path):\n"
            "    if provider == 'crossref':\n"
            "        return 200, {'message': {'DOI': '10.1000/pilot-1', 'title': ['Pilot study'], 'author': [{'family': 'Kim'}], 'published': {'date-parts': [[2023]]}}}, hashlib.sha256(b'cr').hexdigest()\n"
            "    return 200, {'resultList': {'result': []}}, hashlib.sha256(b'epmc').hexdigest()\n"
            "def _trial(nct):\n"
            "    return 200, {'protocolSection': {'identificationModule': {'nctId': nct, 'briefTitle': 'Pilot'}, 'statusModule': {'overallStatus': 'COMPLETED'}, 'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 150, 'type': 'ACTUAL'}}, 'outcomesModule': {'primaryOutcomes': [{'measure': 'Pain score at 6 months'}]}}}, hashlib.sha256(b'ct').hexdigest()\n"
            "def _id(provider, path):\n"
            "    if provider == 'osf':\n"
            "        return 200, {'data': {'type': 'registrations', 'attributes': {'title': 'Pilot Reg', 'registration': True}}}, hashlib.sha256(b'o').hexdigest()\n"
            "    if provider == 'ncbi':\n"
            "        return 200, {'esearchresult': {'count': '1', 'idlist': ['200012345']}}, hashlib.sha256(b'g').hexdigest()\n"
            "    return 404, None, hashlib.sha256(b'404').hexdigest()\n"
            "b.fetch_json = _bib\n"
            "b.fetch_study_json = _trial\n"
            "b.verify_identifiers_online = (lambda orig: lambda ext, **kw: orig(ext, transport=kw.get('transport') or _id, max_lookups=kw.get('max_lookups', 12)))(b.verify_identifiers_online)\n"
            "import paper_mcp\n"
            "raise SystemExit(paper_mcp.main(sys.argv[2:]))\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pdf = folder / "oracle.pdf"
            pdf.write_bytes(raw)
            child = folder / "child_oracle.py"
            child.write_text(child_src, encoding="utf-8")
            err_path = folder / "stderr.txt"

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[str(child), str(LOCAL), "--pdf", str(pdf), "--oracle"],
                    cwd=folder,
                    env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                )
                with err_path.open("w", encoding="utf-8") as err:
                    with anyio.fail_after(45):
                        async with stdio_client(params, errlog=err) as (read, write):
                            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=20)) as session:
                                init = await session.initialize()
                                binding = json.loads(init.instructions.split("Selected PDF: ", 1)[1])
                                pid = binding["paperId"]
                                tools = (await session.list_tools()).tools
                                by_name = {t.name: t for t in tools}
                                self.assertIn("verify_references", by_name)
                                self.assertIn("verify_registries", by_name)
                                self.assertTrue(by_name["verify_references"].annotations.openWorldHint)
                                self.assertTrue(by_name["verify_registries"].annotations.openWorldHint)
                                self.assertFalse(by_name["run_blue_sensor"].annotations.openWorldHint)

                                ref_res = await session.call_tool("verify_references", {"paperId": pid, "maxRefs": 10})
                                self.assertFalse(ref_res.isError)
                                self.assertEqual(ref_res.structuredContent["bibliography"]["summary"]["verifiedMatch"], 1)

                                reg_res = await session.call_tool("verify_registries", {"paperId": pid, "maxLookups": 10})
                                self.assertFalse(reg_res.isError)
                                self.assertEqual(reg_res.structuredContent["clinicalTrials"]["trialIds"], ["NCT07654321"])
                                self.assertEqual(reg_res.structuredContent["identifiers"]["summary"]["osfVerified"], 1)
                                self.assertEqual(reg_res.structuredContent["identifiers"]["summary"]["geoVerified"], 1)

            try:
                anyio.run(run)
            except Exception as exc:
                err = err_path.read_text(encoding="utf-8", errors="replace") if err_path.exists() else ""
                raise AssertionError(f"{exc}\n--- stderr ---\n{err}") from exc


if __name__ == "__main__":
    unittest.main()

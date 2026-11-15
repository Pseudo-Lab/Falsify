"""Read-only multi-document workspace mode (`--workspace DIR`). Stdlib unittest only.

The single-PDF surface is pinned by test_paper_mcp.py. These tests cover the
additive directory mode: bounded scan, blind answer-key masking, per-call
selection binding, escape guards and the unchanged single-PDF tool list.
"""
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

import anyio
import pymupdf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import paper_mcp
import paper_mcp_workspace

LOCAL = Path(__file__).resolve().parents[1] / "local"
CHILD = "import sys\nsys.path[:0] = [sys.argv[1], sys.argv[2]]\nimport paper_mcp\nraise SystemExit(paper_mcp.main(sys.argv[3:]))\n"
ORIGINAL_TOOLS = {
    "status", "list_items", "read_item", "render_region", "read_page_text",
    "search_text", "list_references", "audit_statistics", "run_blue_sensor", "audit_figures",
}
WORKSPACE_TOOLS = {
    "list_papers", "select_paper", "triage_workspace",
    "list_supplements", "read_supplement", "audit_supplements", "recompute_raw_supplement",
    "audit_code_supplements",
}
DRIVE = re.compile(r"[A-Za-z]:[\\/]")
SECRET = "SECRET_ANSWER_KEY_BYTES"


def make_pdf(*page_texts):
    """Build a small real PDF with one text line per page."""
    doc = pymupdf.open()
    try:
        for text in page_texts:
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 90), text, fontsize=14)
        return doc.tobytes()
    finally:
        doc.close()


def tool_map(server):
    return server._tool_manager._tools


@contextlib.contextmanager
def track_masked_reads():
    """Fail if a masked file or a file inside a masked directory is read."""
    original = Path.read_bytes

    def tracking(self, *args, **kwargs):
        if paper_mcp_workspace.is_masked_name(self.name) or paper_mcp_workspace.is_masked_name(self.parent.name):
            raise AssertionError("masked path read: " + self.name)
        return original(self, *args, **kwargs)

    Path.read_bytes = tracking
    try:
        yield
    finally:
        Path.read_bytes = original


def link_directory(target, link):
    """Create a directory link: symlink elsewhere, junction on Windows without privileges."""
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    if os.name != "nt":
        return False
    done = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
    return done.returncode == 0


class ExplodingStore:
    """Proves a refused id never reaches a read."""

    def __init__(self):
        self.called = False

    def prepare(self, *_args, **_kwargs):
        self.called = True
        raise AssertionError("prepare must not run for a refused id")


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def write(self, name, payload, parent=None):
        path = (parent or self.root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_scan_lists_pdfs_and_masks_answer_key_names(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        self.write("answer_key.pdf", make_pdf("ANSWER KEY"))
        self.write("gold_ledger.json", SECRET.encode())
        self.write("notes.txt", b"plain notes")
        self.write("one/answer_key.pdf", make_pdf("SECOND ANSWER KEY"))
        self.write("one/page.pdf", make_pdf("NESTED"))
        self.write("one/two/deep.pdf", make_pdf("DEEP"))
        self.write("one/two/three/too-deep.pdf", make_pdf("TOO DEEP"))
        scanned = paper_mcp_workspace.scan_workspace(self.root)
        self.assertEqual(scanned["schema"], paper_mcp_workspace.SCHEMA)
        entries = scanned["papers"]
        self.assertEqual(sorted(item["name"] for item in entries),
                         ["alpha.pdf", "answer_key.pdf", "answer_key.pdf", "deep.pdf", "gold_ledger.json", "page.pdf"])
        masked = [item for item in entries if item["masked"]]
        self.assertEqual(len(masked), 3)
        self.assertEqual(scanned["maskedCount"], 3)
        self.assertEqual(scanned["paperCount"], 6)
        self.assertFalse(scanned["truncated"])
        self.assertEqual({item["reason"] for item in masked}, {"answer_key_name"})
        self.assertEqual(len({item["paperId"] for item in masked}), 3)
        for entry in masked:
            self.assertTrue(entry["paperId"].startswith("masked-"))
            self.assertNotIn(hashlib.sha256(SECRET.encode()).hexdigest()[:16], entry["paperId"])
        plain = next(item for item in entries if item["name"] == "alpha.pdf")
        self.assertFalse(plain["masked"])
        self.assertNotIn("reason", plain)
        self.assertEqual(plain["paperId"], "ws-" + hashlib.sha256((self.root / "alpha.pdf").read_bytes()).hexdigest()[:16])
        self.assertEqual(plain["byteLength"], len((self.root / "alpha.pdf").read_bytes()))

    def test_payload_never_contains_a_path(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        scanned = paper_mcp_workspace.scan_workspace(self.root)
        text = json.dumps(scanned)
        self.assertTrue(Path(self.root).is_dir())
        self.assertNotIn(str(self.root), text)
        self.assertNotIn(str(self.root).replace("\\", "\\\\"), text)
        self.assertIsNone(DRIVE.search(text), text)
        self.assertNotIn("\\\\", text)

    def test_scan_caps_at_32_papers(self):
        for index in range(33):
            self.write(f"paper{index:02d}.pdf", make_pdf(f"PAPER {index}"))
        scanned = paper_mcp_workspace.scan_workspace(self.root)
        self.assertTrue(scanned["truncated"])
        self.assertEqual(scanned["paperCount"], 32)
        self.assertEqual(len(scanned["papers"]), 32)
        self.assertEqual(paper_mcp_workspace.MAX_WORKSPACE_PAPERS, 32)
        raised = paper_mcp_workspace.scan_workspace(self.root, max_papers=paper_mcp_workspace.MAX_WORKSPACE_PAPERS)
        self.assertEqual(raised["paperCount"], 32)
        with self.assertRaises(ValueError) as bad:
            paper_mcp_workspace.scan_workspace(self.root, max_papers=0)
        self.assertEqual(str(bad.exception), "workspace_invalid")
        with self.assertRaises(ValueError) as huge:
            paper_mcp_workspace.scan_workspace(self.root, max_papers=33)
        self.assertEqual(str(huge.exception), "workspace_invalid")

    def test_scan_refuses_a_missing_directory(self):
        with self.assertRaises(ValueError) as missing:
            paper_mcp_workspace.scan_workspace(self.root / "absent")
        self.assertEqual(str(missing.exception), "workspace_invalid")

    def test_scan_skips_empty_and_oversized_files(self):
        self.write("empty.pdf", b"")
        self.write("alpha.pdf", make_pdf("ALPHA"))
        original = paper_mcp.MAX_PDF_BYTES
        paper_mcp.MAX_PDF_BYTES = 64
        try:
            oversized = paper_mcp_workspace.scan_workspace(self.root)
        finally:
            paper_mcp.MAX_PDF_BYTES = original
        self.assertEqual(oversized["paperCount"], 0)
        self.write("alpha.pdf", make_pdf("ALPHA"))
        self.assertEqual([item["name"] for item in paper_mcp_workspace.scan_workspace(self.root)["papers"]], ["alpha.pdf"])

    def test_masked_and_unknown_ids_are_refused_before_any_read(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        self.write("answer_key.pdf", make_pdf("ANSWER KEY"))
        store = ExplodingStore()
        session = paper_mcp_workspace.WorkspaceSession(store, self.root)
        scanned = paper_mcp_workspace.scan_workspace(self.root)
        masked_id = next(item["paperId"] for item in scanned["papers"] if item["masked"])
        for refused in (masked_id, "../alpha.pdf", "ws-0000000000000000", "", 7):
            with self.assertRaises(ValueError) as error:
                paper_mcp_workspace.open_in_workspace(session, refused)
            codes = {"workspace_file_masked", "paper_evidence_unknown_id", "paper_evidence_id_invalid"}
            self.assertIn(str(error.exception), codes)
        self.assertFalse(store.called)
        self.assertIsNone(session.current)
        self.assertIn(masked_id, session.masked)

    def test_directory_links_outside_the_root_are_refused(self):
        outside = Path(self.tmp.name + "-outside")
        outside.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        self.write("alpha.pdf", make_pdf("ALPHA"), parent=outside)
        self.write("inside.pdf", make_pdf("INSIDE"))
        direct = paper_mcp_workspace._entry_for(self.root.resolve(), outside / "alpha.pdf")
        self.assertIsNone(direct)
        if link_directory(outside, self.root / "linked"):
            names = [item["name"] for item in paper_mcp_workspace.scan_workspace(self.root)["papers"]]
            self.assertNotIn("alpha.pdf", names)
            self.assertEqual(names, ["inside.pdf"])
        else:
            self.skipTest("this host cannot create a directory link to test the escape guard")

    def test_masked_supplements_are_refused(self):
        paper = self.write("gold_answers.md", b"answer text")
        self.assertEqual(paper.name, "gold_answers.md")
        with self.assertRaises(ValueError) as refused:
            paper_mcp_workspace.load_workspace_supplements([paper])
        self.assertEqual(str(refused.exception), "workspace_file_masked")
        self.assertEqual(paper.read_bytes(), b"answer text")
        with self.assertRaises(ValueError):
            paper_mcp_workspace.load_workspace_supplements([self.root / "missing.csv"])
        self.assertEqual(paper_mcp_workspace.load_workspace_supplements([]), [])

    def test_workspace_tools_before_selection_report_no_selection(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        session = paper_mcp_workspace.WorkspaceSession(ExplodingStore(), self.root)
        server = paper_mcp.build_workspace_server(session)
        tools = tool_map(server)
        self.assertEqual(set(tools), ORIGINAL_TOOLS | WORKSPACE_TOOLS)
        for name in WORKSPACE_TOOLS:
            tool = tools[name]
            self.assertTrue(tool.description.startswith("Read-only"), tool.description)
            self.assertTrue(tool.annotations.readOnlyHint)
            self.assertFalse(tool.annotations.destructiveHint)
            self.assertFalse(tool.annotations.openWorldHint)
        for name, argument in (("status", "x"), ("read_page_text", "x"), ("audit_statistics", "x")):
            result = tools[name].fn(argument, 0) if name == "read_page_text" else tools[name].fn(argument)
            self.assertTrue(result.isError)
            self.assertEqual(result.structuredContent, {"error": "workspace_no_selection"})
        listed = tools["list_papers"].fn()
        self.assertFalse(listed.isError)
        self.assertEqual(listed.structuredContent["paperCount"], 1)
        selected = tools["select_paper"].fn("ws-0000000000000000")
        self.assertTrue(selected.isError)
        self.assertEqual(selected.structuredContent["error"], "paper_evidence_unknown_id")
        early = tools["list_supplements"].fn("anything")
        self.assertTrue(early.isError)
        self.assertEqual(early.structuredContent, {"error": "workspace_no_selection"})
        rejected = tools["triage_workspace"].fn(0)
        self.assertTrue(rejected.isError)
        self.assertEqual(rejected.structuredContent["error"], "limit")


class StdioWorkspaceTests(unittest.TestCase):
    def test_two_papers_masked_entries_and_no_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "alpha.pdf").write_bytes(make_pdf("ALPHA primary", "ALPHA second page"))
            (root / "beta.pdf").write_bytes(make_pdf("BETA primary"))
            (root / "answer_key.pdf").write_bytes(make_pdf("ANSWER KEY CONTENT"))
            (root / "gold_ledger.json").write_text(json.dumps({"secret": SECRET}), encoding="utf-8")
            err_path = root / "stderr.txt"
            alpha_hash = hashlib.sha256((root / "alpha.pdf").read_bytes()).hexdigest()

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[str(LOCAL / "paper_mcp.py"), "--workspace", str(root)],
                    cwd=str(root),
                    env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                )
                with err_path.open("w", encoding="utf-8") as err:
                    with anyio.fail_after(90):
                        async with stdio_client(params, errlog=err) as (read, write):
                            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                                init = await session.initialize()
                                self.assertIn("Read-only", init.instructions or "")
                                self.assertIn("select_paper", init.instructions or "")
                                listed = await session.list_tools()
                                names = {tool.name for tool in listed.tools}
                                self.assertEqual(names, ORIGINAL_TOOLS | WORKSPACE_TOOLS)
                                for tool in listed.tools:
                                    self.assertTrue(tool.annotations.readOnlyHint)
                                    self.assertFalse(tool.annotations.openWorldHint)
                                    self.assertIn("Read-only", tool.description or "")
                                early = await session.call_tool("read_page_text", {"paperId": "anything", "pageIndex": 0})
                                self.assertTrue(early.isError)
                                self.assertEqual(early.structuredContent["error"], "workspace_no_selection")

                                papers = await session.call_tool("list_papers", {})
                                self.assertFalse(papers.isError)
                                payload = json.dumps(papers.model_dump(mode="json"))
                                self.assertNotIn(str(root), payload)
                                self.assertIsNone(DRIVE.search(payload), payload)
                                self.assertNotIn(SECRET, payload)
                                entries = papers.structuredContent["papers"]
                                by_name = {item["name"]: item for item in entries}
                                self.assertEqual(papers.structuredContent["paperCount"], 4)
                                self.assertEqual(papers.structuredContent["maskedCount"], 2)
                                self.assertFalse(papers.structuredContent["truncated"])
                                for masked_name in ("answer_key.pdf", "gold_ledger.json"):
                                    self.assertTrue(by_name[masked_name]["masked"])
                                    self.assertEqual(by_name[masked_name]["reason"], "answer_key_name")
                                    blocked = await session.call_tool("select_paper", {"paperId": by_name[masked_name]["paperId"]})
                                    self.assertTrue(blocked.isError)
                                    self.assertEqual(blocked.structuredContent["error"], "workspace_file_masked")
                                    dumped = json.dumps(blocked.model_dump(mode="json"))
                                    self.assertNotIn(SECRET, dumped)
                                    self.assertNotIn("ANSWER KEY CONTENT", dumped)

                                first = await session.call_tool("select_paper", {"paperId": by_name["alpha.pdf"]["paperId"]})
                                self.assertFalse(first.isError)
                                self.assertEqual(set(first.structuredContent), {"paperId", "fileHash", "name", "pageCount"})
                                self.assertEqual(first.structuredContent["name"], "alpha.pdf")
                                self.assertEqual(first.structuredContent["fileHash"], alpha_hash)
                                self.assertEqual(first.structuredContent["pageCount"], 2)
                                alpha_id = first.structuredContent["paperId"]
                                again = await session.call_tool("select_paper", {"paperId": by_name["alpha.pdf"]["paperId"]})
                                self.assertEqual(again.structuredContent, first.structuredContent)
                                text = await session.call_tool("read_page_text", {"paperId": alpha_id, "pageIndex": 0})
                                self.assertFalse(text.isError)
                                self.assertIn("ALPHA primary", text.structuredContent["text"])
                                items = await session.call_tool("list_items", {"paperId": alpha_id})
                                self.assertFalse(items.isError)
                                self.assertEqual(items.structuredContent["paperId"], alpha_id)

                                second = await session.call_tool("select_paper", {"paperId": by_name["beta.pdf"]["paperId"]})
                                self.assertFalse(second.isError)
                                beta_id = second.structuredContent["paperId"]
                                self.assertNotEqual(beta_id, alpha_id)
                                moved = await session.call_tool("read_page_text", {"paperId": beta_id, "pageIndex": 0})
                                self.assertFalse(moved.isError)
                                self.assertIn("BETA primary", moved.structuredContent["text"])
                                stale = await session.call_tool("read_page_text", {"paperId": alpha_id, "pageIndex": 0})
                                self.assertTrue(stale.isError)
                                self.assertEqual(stale.structuredContent["error"], "paper_evidence_unknown_id")
                                status = await session.call_tool("status", {"paperId": beta_id})
                                self.assertFalse(status.isError)
                                self.assertEqual(status.structuredContent["pageCount"], 1)
                                escaped = await session.call_tool("select_paper", {"paperId": "../alpha.pdf"})
                                self.assertTrue(escaped.isError)
                                self.assertEqual(escaped.structuredContent["error"], "paper_evidence_unknown_id")

            try:
                anyio.run(run)
            except Exception as exc:
                err = err_path.read_text(encoding="utf-8", errors="replace") if err_path.exists() else ""
                raise AssertionError(f"{exc}\n--- stderr ---\n{err}") from exc

    def test_single_pdf_mode_still_lists_only_the_original_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "selected.pdf"
            pdf.write_bytes(make_pdf("SELECTED paper body"))
            err_path = root / "stderr.txt"

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[str(LOCAL / "paper_mcp.py"), "--pdf", str(pdf)],
                    cwd=str(root),
                    env={"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                )
                with err_path.open("w", encoding="utf-8") as err:
                    with anyio.fail_after(90):
                        async with stdio_client(params, errlog=err) as (read, write):
                            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                                init = await session.initialize()
                                binding = json.loads(init.instructions.split("Selected PDF: ", 1)[1])
                                listed = await session.list_tools()
                                self.assertEqual({tool.name for tool in listed.tools}, ORIGINAL_TOOLS)
                                page = await session.call_tool("read_page_text", {"paperId": binding["paperId"], "pageIndex": 0})
                                self.assertFalse(page.isError)
                                self.assertIn("SELECTED paper body", page.structuredContent["text"])

            try:
                anyio.run(run)
            except Exception as exc:
                err = err_path.read_text(encoding="utf-8", errors="replace") if err_path.exists() else ""
                raise AssertionError(f"{exc}\n--- stderr ---\n{err}") from exc


class CliTests(unittest.TestCase):
    def test_pdf_and_workspace_are_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "selected.pdf"
            pdf.write_bytes(make_pdf("SELECTED"))
            for argv in (["--pdf", str(pdf), "--workspace", str(root)], ["--workspace", str(root), "--pdf", str(pdf)]):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                    code = paper_mcp.main(argv)
                self.assertEqual(code, 2)
                self.assertEqual(stderr.getvalue().strip(), "paper_evidence_file_invalid")

    def test_neither_mode_is_rejected_and_bad_workspace_is_fixed(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
            code = paper_mcp.main([])
        self.assertEqual(code, 2)
        self.assertEqual(stderr.getvalue().strip(), "paper_evidence_file_invalid")
        with tempfile.TemporaryDirectory() as tmp:
            absent = Path(tmp) / "absent"
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                code = paper_mcp.main(["--workspace", str(absent)])
            self.assertEqual(code, 2)
            self.assertEqual(stderr.getvalue().strip(), "workspace_invalid")

    def test_masked_workspace_supplement_stops_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "alpha.pdf").write_bytes(make_pdf("ALPHA"))
            supplement = root / "answer_key.csv"
            supplement.write_text("a,b\n1,2\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                code = paper_mcp.main(["--workspace", str(root), "--supplement", str(supplement)])
            self.assertEqual(code, 2)
            self.assertEqual(stderr.getvalue().strip(), "workspace_file_masked")

    def test_help_exits_zero_and_names_both_modes(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = paper_mcp.main(["--help"])
        self.assertEqual(code, 0)
        text = stdout.getvalue()
        self.assertIn("--pdf", text)
        self.assertIn("--workspace", text)


class SupplementPairingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def write(self, name, payload):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_pairs_same_directory_and_companion_files_only(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        self.write("alpha_cohort.csv", b"patient_id\n1\n")
        self.write("ALPHA_NOTE.CSV", b"note\n1\n")
        self.write("alpha-analysis.py", b"print(1)\n")
        self.write("notes.txt", b"plain notes")
        self.write("alpha_extra.pdf", make_pdf("OTHER"))
        self.write("beta.pdf", make_pdf("BETA"))
        self.write("alpha/zeta.csv", b"id\n1\n")
        self.write("alpha_supplements/note.md", b"note")
        self.write("alpha-supplements/mid.txt", b"mid")
        scanned = paper_mcp_workspace.scan_workspace(self.root)
        text = json.dumps(scanned)
        self.assertIsNone(DRIVE.search(text), text)
        self.assertNotIn(str(self.root), text)
        by_name = {item["name"]: item for item in scanned["papers"]}
        paired = by_name["alpha.pdf"]["pairedSupplementNames"]
        self.assertEqual(by_name["alpha.pdf"]["pairedSupplementCount"], len(paired))
        self.assertEqual(paired, ["alpha-analysis.py", "alpha_cohort.csv", "ALPHA_NOTE.CSV", "mid.txt", "note.md", "zeta.csv"])
        self.assertNotIn("notes.txt", paired)
        self.assertNotIn("alpha_extra.pdf", paired)
        self.assertNotIn("pairedSupplementCount", by_name["beta.pdf"])
        self.assertNotIn("reason", by_name["alpha.pdf"])

    def test_masked_and_forbidden_supplements_are_skipped(self):
        secret = SECRET.encode()
        self.write("alpha.pdf", make_pdf("ALPHA"))
        self.write("alpha_ok.csv", b"a,b\n1,2\n")
        self.write("alpha_gold_ledger.json", secret)
        self.write("alpha_meta.json", json.dumps({"gold": SECRET}).encode())
        self.write("solution/alpha.csv", secret)
        self.write("notes.txt", b"plain notes")
        self.write("alpha/gold.csv", secret)
        self.write("alpha/ok.csv", b"id\n1\n")
        with track_masked_reads():
            scanned = paper_mcp_workspace.scan_workspace(self.root)
        text = json.dumps(scanned)
        self.assertNotIn(SECRET, text)
        self.assertIsNone(DRIVE.search(text), text)
        self.assertNotIn(str(self.root), text)
        plain = next(item for item in scanned["papers"] if item["name"] == "alpha.pdf")
        self.assertEqual(plain["pairedSupplementNames"], ["alpha_ok.csv", "ok.csv"])
        self.assertTrue(all(item["masked"] for item in scanned["papers"] if "gold" in item["name"]))

    def test_pairing_stops_at_twelve_files(self):
        self.write("alpha.pdf", make_pdf("ALPHA"))
        for index in range(13):
            self.write(f"alpha_{index:02d}.csv", f"a\n{index}\n".encode())
        plain = next(item for item in paper_mcp_workspace.scan_workspace(self.root)["papers"] if item["name"] == "alpha.pdf")
        self.assertEqual(plain["pairedSupplementCount"], 12)
        self.assertNotIn("alpha_12.csv", plain["pairedSupplementNames"])
        self.assertIn("alpha_00.csv", plain["pairedSupplementNames"])

    def test_companion_directory_links_outside_the_root_are_not_paired(self):
        outside = Path(self.tmp.name + "-outside")
        outside.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        (outside / "secret.csv").write_bytes(SECRET.encode())
        self.write("alpha.pdf", make_pdf("ALPHA"))
        if not link_directory(outside, self.root / "alpha_supplements"):
            self.skipTest("this host cannot create a directory link to test the escape guard")
        read_names = []
        original = Path.read_bytes

        def tracking(self, *args, **kwargs):
            read_names.append(self.name)
            return original(self, *args, **kwargs)

        Path.read_bytes = tracking
        try:
            scanned = paper_mcp_workspace.scan_workspace(self.root)
        finally:
            Path.read_bytes = original
        text = json.dumps(scanned)
        self.assertNotIn(SECRET, text)
        self.assertNotIn("secret.csv", text)
        self.assertNotIn("secret.csv", read_names)
        plain = next(item for item in scanned["papers"] if item["name"] == "alpha.pdf")
        self.assertNotIn("pairedSupplementCount", plain)

    def test_session_supplements_dedupe_and_cap(self):
        first = {"name": "a.csv", "sha256": "a" * 64, "supplementId": "supp-9", "text": "one"}
        same = {"name": "a.csv", "sha256": "a" * 64, "supplementId": "supp-1", "text": "one"}
        second = {"name": "b.csv", "sha256": "b" * 64, "supplementId": "supp-1", "text": "two"}
        extras = [{"name": f"n{index}.csv", "sha256": f"{index:064x}", "supplementId": "supp-1", "text": "x"} for index in range(13)]
        session = paper_mcp_workspace.WorkspaceSession(ExplodingStore(), self.root, startup_supplements=(first,))
        session.paired_supplements = (same, second)
        merged = session.supplements
        self.assertEqual([item["name"] for item in merged], ["a.csv", "b.csv"])
        self.assertEqual([item["supplementId"] for item in merged], ["supp-1", "supp-2"])
        self.assertFalse(session.store.called)
        capped = paper_mcp_workspace.WorkspaceSession(ExplodingStore(), self.root, startup_supplements=tuple(extras))
        self.assertEqual(len(capped.supplements), 12)
        self.assertEqual(capped.supplements[-1]["supplementId"], "supp-12")

    def test_triage_rejects_invalid_limits_before_opening_files(self):
        with self.assertRaises(ValueError) as limit:
            paper_mcp_workspace.triage_workspace(self.root, max_signals_per_paper=True)
        self.assertEqual(str(limit.exception), "limit")
        with self.assertRaises(ValueError) as high:
            paper_mcp_workspace.triage_workspace(self.root, max_signals_per_paper=101)
        self.assertEqual(str(high.exception), "limit")
        with self.assertRaises(ValueError) as flag:
            paper_mcp_workspace.triage_workspace(self.root, include_figure_forensics=1)
        self.assertEqual(str(flag.exception), "include_figure_forensics")
        with self.assertRaises(ValueError) as raw:
            paper_mcp_workspace.triage_workspace(self.root, recompute_raw="yes")
        self.assertEqual(str(raw.exception), "recompute_raw")
        with self.assertRaises(ValueError) as papers:
            paper_mcp_workspace.triage_workspace(self.root, max_papers=0)
        self.assertEqual(str(papers.exception), "workspace_invalid")


class SelectionSwitchTests(unittest.TestCase):
    def test_select_paper_switches_supplements_and_recompute(self):
        import paper_evidence
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "alpha.pdf").write_bytes(make_pdf("ALPHA cohort"))
            (root / "alpha_cohort.csv").write_bytes(b"patient_id,value\n1,2\n3,4\n")
            (root / "beta.pdf").write_bytes(make_pdf("BETA only"))
            (root / "notes.txt").write_bytes(b"plain notes")
            session = paper_mcp_workspace.WorkspaceSession(paper_evidence.EvidenceStore(max_documents=4), root)
            tools = tool_map(paper_mcp.build_workspace_server(session))
            listed = tools["list_papers"].fn()
            self.assertFalse(listed.isError)
            payload = json.dumps(listed.structuredContent)
            self.assertIsNone(DRIVE.search(payload), payload)
            self.assertNotIn(str(root), payload)
            by_name = {item["name"]: item for item in listed.structuredContent["papers"]}
            self.assertEqual(by_name["alpha.pdf"]["pairedSupplementNames"], ["alpha_cohort.csv"])
            self.assertNotIn("pairedSupplementCount", by_name["beta.pdf"])
            early = tools["recompute_raw_supplement"].fn("anything")
            self.assertEqual(early.structuredContent, {"error": "workspace_no_selection"})

            selected = tools["select_paper"].fn(by_name["alpha.pdf"]["paperId"])
            self.assertFalse(selected.isError, selected.structuredContent)
            self.assertEqual(set(selected.structuredContent), {"paperId", "fileHash", "name", "pageCount"})
            alpha_id = selected.structuredContent["paperId"]
            supplements = tools["list_supplements"].fn(alpha_id)
            self.assertFalse(supplements.isError, supplements.structuredContent)
            self.assertEqual([item["name"] for item in supplements.structuredContent["supplements"]], ["alpha_cohort.csv"])
            recomputed = tools["recompute_raw_supplement"].fn(alpha_id)
            self.assertFalse(recomputed.isError, recomputed.structuredContent)
            self.assertNotIn(str(root), json.dumps(recomputed.structuredContent))

            moved = tools["select_paper"].fn(by_name["beta.pdf"]["paperId"])
            self.assertFalse(moved.isError, moved.structuredContent)
            beta_id = moved.structuredContent["paperId"]
            beta_list = tools["list_supplements"].fn(beta_id)
            self.assertFalse(beta_list.isError, beta_list.structuredContent)
            self.assertEqual(beta_list.structuredContent["supplementCount"], 0)
            beta_raw = tools["recompute_raw_supplement"].fn(beta_id)
            self.assertFalse(beta_raw.isError, beta_raw.structuredContent)
            beta_text = json.dumps(beta_raw.structuredContent)
            self.assertNotIn("alpha_cohort.csv", beta_text)
            self.assertNotIn(str(root), beta_text)

            restored = tools["select_paper"].fn(by_name["alpha.pdf"]["paperId"])
            self.assertFalse(restored.isError)
            back = tools["list_supplements"].fn(restored.structuredContent["paperId"])
            self.assertEqual([item["name"] for item in back.structuredContent["supplements"]], ["alpha_cohort.csv"])


class TriageTests(unittest.TestCase):
    def test_triage_ranks_defective_pdf_above_clean_pdf(self):
        import paper_evidence
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "bad.pdf").write_bytes(make_pdf(
                "Cohort N = 240 patients. Table S1 reports AUC = 0.94. See Table S4."))
            (root / "bad_Table_S1.csv").write_bytes(b"Model,AUC\nMain,0.81\n")
            (root / "clean.pdf").write_bytes(make_pdf("The apparatus was calibrated before use."))
            (root / "answer_key.pdf").write_bytes(make_pdf("ANSWER KEY CONTENT"))
            (root / "bad_gold_ledger.json").write_bytes(json.dumps({"secret": SECRET}).encode())
            (root / "bad_meta.json").write_bytes(json.dumps({"gold": SECRET}).encode())
            (root / "notes.txt").write_bytes(b"plain notes do not pair")
            with track_masked_reads():
                result = paper_mcp_workspace.triage_workspace(
                    root, max_signals_per_paper=25, include_figure_forensics=False, recompute_raw=True,
                    store=paper_evidence.EvidenceStore(max_documents=4))
            text = json.dumps(result)
            self.assertEqual(result["schema"], paper_mcp_workspace.TRIAGE_SCHEMA)
            self.assertEqual(result["paperCount"], 4)
            self.assertEqual(result["maskedCount"], 2)
            self.assertIsNone(DRIVE.search(text), text)
            self.assertNotIn(str(root), text)
            self.assertNotIn(SECRET, text)
            self.assertNotIn("answer_key.pdf", text)
            self.assertNotIn("bad_gold_ledger.json", text)
            self.assertNotIn("bad_meta.json", text)
            self.assertNotIn("notes.txt", text)
            ranked = {item["name"]: item for item in result["rankedPapers"]}
            self.assertEqual(set(ranked), {"bad.pdf", "clean.pdf"})
            self.assertGreater(ranked["bad.pdf"]["totalSignals"], ranked["clean.pdf"]["totalSignals"], result)
            self.assertGreater(ranked["bad.pdf"]["priorityScore"], ranked["clean.pdf"]["priorityScore"])
            self.assertEqual(ranked["bad.pdf"]["pairedSupplementCount"], 1)
            self.assertEqual(ranked["clean.pdf"]["pairedSupplementCount"], 0)
            self.assertEqual(result["rankedPapers"][0]["name"], "bad.pdf")
            self.assertIn("D1", ranked["bad.pdf"]["byFamily"])


class SourceContractTests(unittest.TestCase):
    def test_scanning_logic_stays_out_of_paper_mcp(self):
        source = Path(paper_mcp.__file__).read_text(encoding="utf-8")
        for token in ("urllib", "httpx", "requests", "webbrowser", "subprocess", "blue_service"):
            self.assertNotIn(token, source)
        self.assertIn("from paper_mcp_workspace import", source)
        workspace = Path(paper_mcp_workspace.__file__).read_text(encoding="utf-8")
        self.assertIn("SCHEMA", workspace)
        self.assertIn("MAX_WORKSPACE_PAPERS", workspace)
        self.assertNotIn("import subprocess", workspace)
        self.assertNotIn("webbrowser", workspace)


if __name__ == "__main__":
    unittest.main()

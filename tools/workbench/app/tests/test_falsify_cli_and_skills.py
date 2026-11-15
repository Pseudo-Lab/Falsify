"""Unittest suite for app/local/falsify_cli.py and built-in RED/BLUE agent skills."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
TESTS = ROOT / "app" / "tests"
for _folder in (str(LOCAL), str(TESTS)):
    if _folder not in sys.path:
        sys.path.insert(0, _folder)

import falsify_cli  # noqa: E402
from test_paper_evidence import draw_table  # noqa: E402


def _build_synthetic_paper_pdf() -> bytes:
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 74), "Table 1. Cohort Metrics (N = 200).", fontsize=11)
    draw_table(p0)
    p0.insert_text((72, 240), "Results: Table S1 reports AUC = 0.94 across N = 200 patients.", fontsize=10.5)
    p0.insert_text((72, 270), "References", fontsize=11.5)
    p0.insert_text((72, 295), "[1] Alpha Study. Nature. 2023. doi:10.1000/alpha-one", fontsize=9.5)
    p0.insert_link({
        "kind": pymupdf.LINK_URI,
        "from": pymupdf.Rect(70, 283, 420, 302),
        "uri": "https://doi.org/10.1000/alpha-one",
    })
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 80), "Discussion: Secondary endpoint remained stable.", fontsize=10.5)
    raw = doc.tobytes()
    doc.close()
    return raw


def _build_minimal_docx(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>",
        )
    return buf.getvalue()


def _run_cli(*cli_args: str) -> tuple[int, dict, str]:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.run(
        [sys.executable, str(LOCAL / "falsify_cli.py"), *cli_args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        check=False,
    )
    payload = json.loads(proc.stdout)
    return proc.returncode, payload, proc.stdout


def _parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    raw = path.read_text(encoding="utf-8")
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n(.*)$", raw, flags=re.DOTALL)
    if not m:
        raise AssertionError(f"Missing YAML frontmatter in {path}")
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, m.group(2)


class FalsifyCliAndSkillsTests(unittest.TestCase):
    def test_blue_scan_digest_only_supplement_and_red_key_rejection(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "paper.pdf"
            pdf_path.write_bytes(raw)
            supp_csv = tmp_dir / "Table_S1.csv"
            supp_csv.write_text("Model,AUC\nMain,0.81\n", encoding="utf-8")
            supp_docx = tmp_dir / "notes.docx"
            supp_docx.write_bytes(_build_minimal_docx("Table S1 supplementary AUC = 0.81"))
            out_json = tmp_dir / "scan.json"

            code, payload, stdout = _run_cli(
                "blue", "scan",
                "--pdf", str(pdf_path),
                "--supplement", str(supp_csv), str(supp_docx),
                "--digest-only",
                "--out", str(out_json),
            )
            self.assertEqual(code, 0, payload)
            self.assertEqual(payload["schema"], falsify_cli.SCHEMA)
            self.assertTrue(payload["ok"])
            self.assertTrue(payload["digestOnly"])
            self.assertLess(len(stdout.encode("utf-8")), 12 * 1024)
            self.assertNotIn("links", payload["sensor"]["uriLinks"])
            kinds = {s["kind"] for s in payload["supplementAudit"]["signals"]}
            self.assertIn("cross_file_metric_mismatch", kinds)
            self.assertTrue(out_json.is_file())

            # JSON supplement with forbidden RED key must be rejected with exit code 3.
            bad_json = tmp_dir / "leaked_supp.json"
            bad_json.write_text(json.dumps({"gold": "secret", "accuracy": 0.9}), encoding="utf-8")
            bad_code, bad_payload, _ = _run_cli(
                "blue", "scan", "--pdf", str(pdf_path), "--supplement", str(bad_json),
            )
            self.assertEqual(bad_code, 3)
            self.assertFalse(bad_payload["ok"])
            self.assertEqual(bad_payload["error"], "forbidden_red_key")

            # Missing file emits structured JSON error with exit code 2.
            miss_code, miss_payload, _ = _run_cli("blue", "scan", "--pdf", str(tmp_dir / "missing.pdf"))
            self.assertEqual(miss_code, 2)
            self.assertFalse(miss_payload["ok"])
            self.assertEqual(miss_payload["schema"], falsify_cli.SCHEMA)

    def test_red_targets_and_apply_table_uri_guards(self):
        raw = _build_synthetic_paper_pdf()
        src_sha = hashlib.sha256(raw).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "source.pdf"
            pdf_path.write_bytes(raw)

            t_code, t_payload, _ = _run_cli(
                "red", "targets", "--pdf", str(pdf_path), "--query", "Alpha", "--include-baseline",
            )
            self.assertEqual(t_code, 0, t_payload)
            self.assertGreaterEqual(len(t_payload["links"]), 1)
            self.assertIn("baseline", t_payload)

            all_code, all_targets, _ = _run_cli("red", "targets", "--pdf", str(pdf_path))
            self.assertEqual(all_code, 0, all_targets)
            tbl = all_targets["tables"][0]
            cell = next(c for c in tbl["cells"] if c["text"] == "5")
            lnk = all_targets["links"][0]

            ops = [
                {
                    "id": "op-tbl-1",
                    "kind": "table-cell",
                    "itemId": tbl["itemId"],
                    "row": cell["row"],
                    "column": cell["column"],
                    "before": "5",
                    "after": "9",
                },
                {
                    "id": "op-uri-1",
                    "kind": "uri-link",
                    "linkId": lnk["linkId"],
                    "pageIndex": lnk["pageIndex"],
                    "annotIndex": lnk["annotIndex"],
                    "afterUri": "https://doi.org/10.1000/beta-hijack",
                },
            ]
            ops_file = tmp_dir / "ops.json"
            ops_file.write_text(json.dumps(ops), encoding="utf-8")

            # Must refuse to overwrite source PDF with exit code 2.
            ow_code, ow_payload, _ = _run_cli(
                "red", "apply", "--pdf", str(pdf_path), "--ops", str(ops_file), "--out-pdf", str(pdf_path),
            )
            self.assertEqual(ow_code, 2)
            self.assertEqual(ow_payload["error"], "cannot_overwrite_source")

            blind_pdf = tmp_dir / "blind.pdf"
            gold_json = tmp_dir / "gold.json"
            a_code, a_payload, _ = _run_cli(
                "red", "apply",
                "--pdf", str(pdf_path),
                "--ops", str(ops_file),
                "--out-pdf", str(blind_pdf),
                "--out-gold", str(gold_json),
                "--require-clean-stealth",
            )
            self.assertEqual(a_code, 0, a_payload)
            self.assertTrue(blind_pdf.is_file())
            self.assertTrue(gold_json.is_file())
            self.assertEqual(hashlib.sha256(pdf_path.read_bytes()).hexdigest(), src_sha)
            ledger = json.loads(gold_json.read_text(encoding="utf-8"))
            self.assertEqual(ledger["schema"], "falsify.red-gold-ledger.v1")
            self.assertEqual(ledger["appliedCount"], 2)

            # Enforce --require-clean-stealth failure prevents writing output PDF and exits 3.
            blocked_pdf = tmp_dir / "blocked_blind.pdf"
            fake_stealth = {
                "schema": "falsify.red-stealth-audit.v1",
                "status": "detectable_artifact",
                "checks": {"metadataClean": False},
                "issues": [{"code": "metadata_leak", "severity": "detectable_artifact"}],
                "seamMetrics": [],
            }
            with patch.object(falsify_cli, "audit_pdf_stealth", return_value=fake_stealth):
                buf = io.StringIO()
                with patch.object(sys, "stdout", buf):
                    rc = falsify_cli.main([
                        "red", "apply",
                        "--pdf", str(pdf_path),
                        "--ops", str(ops_file),
                        "--out-pdf", str(blocked_pdf),
                        "--require-clean-stealth",
                    ])
            self.assertEqual(rc, 3)
            self.assertFalse(blocked_pdf.exists())
            blocked_payload = json.loads(buf.getvalue())
            self.assertEqual(blocked_payload["error"], "stealth_audit_failed")

    def test_blind_verify_clean_vs_metadata_leaked(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src_pdf = tmp_dir / "src.pdf"
            src_pdf.write_bytes(raw)

            v_ok, ok_payload, _ = _run_cli("blind", "verify", "--pdf", str(src_pdf), "--source-pdf", str(src_pdf))
            self.assertEqual(v_ok, 0, ok_payload)
            self.assertTrue(ok_payload["clean"])
            self.assertEqual(ok_payload["leaks"], [])

            doc = pymupdf.open(stream=raw, filetype="pdf")
            doc.set_metadata({"title": "Synthetic red-plan candidate", "author": "falsify"})
            leaked_bytes = doc.tobytes()
            doc.close()
            leaked_pdf = tmp_dir / "leaked.pdf"
            leaked_pdf.write_bytes(leaked_bytes)

            v_bad, bad_payload, _ = _run_cli("blind", "verify", "--pdf", str(leaked_pdf), "--source-pdf", str(src_pdf))
            self.assertEqual(v_bad, 3)
            self.assertFalse(bad_payload["clean"])
            self.assertGreaterEqual(len(bad_payload["leaks"]), 1)

            # Standalone verify without --source-pdf also catches metadata leaks.
            v_standalone, st_payload, _ = _run_cli("blind", "verify", "--pdf", str(leaked_pdf))
            self.assertEqual(v_standalone, 3)
            self.assertFalse(st_payload["clean"])

    def test_arena_score_end_to_end_two_blue_runs_and_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            gold = {
                "schema": "falsify.red-gold-ledger.v1",
                "operations": [
                    {"id": "g1", "kind": "table-cell", "itemId": "t1", "pageIndex": 0, "before": "5", "after": "9", "world": "W3", "family": "D3", "difficulty": "L2"},
                    {"id": "g2", "kind": "uri-link", "pageIndex": 0, "afterUri": "https://doi.org/10.1000/beta-hijack", "world": "W4", "family": "D2", "difficulty": "L1"},
                ],
            }
            blue1 = {
                "schema": "falsify.blue-report.v1",
                "findings": [
                    {"id": "f1", "verdict": "defect", "pageIndex": 0, "itemId": "t1", "quote": "Table 1 cell changed to 9"},
                    {"id": "f2", "verdict": "needs_check", "pageIndex": 0, "quote": "Link target points to beta-hijack"},
                ],
            }
            blue2 = {
                "schema": "falsify.blue-report.v1",
                "findings": [
                    {"id": "f1", "verdict": "defect", "pageIndex": 0, "itemId": "t1", "quote": "Table 1 value 9"},
                    {"id": "f2", "verdict": "defect", "pageIndex": 0, "quote": "https://doi.org/10.1000/beta-hijack"},
                    {"id": "f3", "verdict": "defect", "pageIndex": 1, "quote": "Unrelated false alarm"},
                    {"id": "f4", "verdict": "defect", "pageIndex": 1, "quote": "Pre-existing baseline issue in Discussion"},
                ],
            }
            baseline = {
                "schema": "falsify.blue-defect-sensor.v1",
                "signals": [
                    {"id": "b1", "pageIndex": 1, "excerpt": "Pre-existing baseline issue in Discussion"},
                ],
            }
            gold_p = tmp_dir / "gold.json"
            b1_p = tmp_dir / "blue1.json"
            b2_p = tmp_dir / "blue2.json"
            base_p = tmp_dir / "baseline.json"
            out_p = tmp_dir / "score.json"
            gold_p.write_text(json.dumps(gold), encoding="utf-8")
            b1_p.write_text(json.dumps(blue1), encoding="utf-8")
            b2_p.write_text(json.dumps(blue2), encoding="utf-8")
            base_p.write_text(json.dumps(baseline), encoding="utf-8")

            code, payload, _ = _run_cli(
                "arena", "score",
                "--gold", str(gold_p),
                "--blue", str(b1_p), str(b2_p),
                "--baseline", str(base_p),
                "--out", str(out_p),
            )
            self.assertEqual(code, 0, payload)
            self.assertTrue(payload["delegated"])
            self.assertEqual(payload["goldCount"], 2)
            self.assertEqual(len(payload["runs"]), 2)
            self.assertEqual(payload["runs"][0]["recall"], 0.5)
            self.assertEqual(payload["runs"][0]["uncertainMatchedDefectIds"], ["g2"])
            self.assertEqual(payload["runs"][0]["selectivePrediction"]["abstainedCount"], 1)
            self.assertIsNotNone(payload["runs"][0]["selectivePrediction"]["aurc"])
            self.assertEqual(payload["runs"][1]["recall"], 1.0)
            self.assertEqual(payload["runs"][1]["pureFp"], 1)
            self.assertEqual(payload["runs"][1]["preExistingExempted"], 1)
            self.assertIn("nominal", payload["agreement"])
            self.assertIn("ordinal", payload["agreement"])
            self.assertIn("feedbackDigest", payload)
            self.assertEqual(payload["baselineSignalCount"], 1)
            self.assertTrue(out_p.is_file())

    def test_closed_loop_red_text_span_blind_verify_blue_scan_arena_score(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src_pdf = tmp_dir / "paper.pdf"
            src_pdf.write_bytes(raw)
            supp_csv = tmp_dir / "Table_S1.csv"
            supp_csv.write_text("Model,AUC\nMain,0.94\n", encoding="utf-8")

            # 1. Inspect targets including native textSpans
            t_code, t_payload, _ = _run_cli("red", "targets", "--pdf", str(src_pdf), "--query", "AUC = 0.94")
            self.assertEqual(t_code, 0, t_payload)
            self.assertGreaterEqual(len(t_payload["textSpans"]), 1)

            # 2. Self-healing error when text-span before text mismatches
            bad_code, bad_payload, _ = _run_cli(
                "red", "apply",
                "--pdf", str(src_pdf),
                "--ops", json.dumps([{"kind": "text-span", "pageIndex": 0, "before": "AUC = 0.9999", "after": "AUC = 0.61"}]),
                "--out-pdf", str(tmp_dir / "bad.pdf"),
            )
            self.assertEqual(bad_code, 2)
            self.assertEqual(bad_payload["error"], "text_span_not_found")
            self.assertGreaterEqual(len(bad_payload.get("nearestCandidates", [])), 1)
            self.assertTrue(bad_payload.get("recoveryHint"))

            # 3. Apply native text-span defect creating a cross-file metric mismatch against Table_S1.csv
            blind_pdf = tmp_dir / "blind.pdf"
            gold_json = tmp_dir / "gold.json"
            a_code, a_payload, _ = _run_cli(
                "red", "apply",
                "--pdf", str(src_pdf),
                "--ops", json.dumps([{
                    "id": "d-span-1",
                    "kind": "text-span",
                    "pageIndex": 0,
                    "before": "AUC = 0.94",
                    "after": "AUC = 0.61",
                    "world": "W5",
                    "family": "D6",
                    "difficulty": "L2",
                }]),
                "--out-pdf", str(blind_pdf),
                "--out-gold", str(gold_json),
                "--require-clean-stealth",
            )
            self.assertEqual(a_code, 0, a_payload)

            # 4. Verify blind bundle (PDF + supplement) has zero RED leaks
            v_code, v_payload, _ = _run_cli(
                "blind", "verify",
                "--pdf", str(blind_pdf),
                "--source-pdf", str(src_pdf),
                "--supplement", str(supp_csv),
            )
            self.assertEqual(v_code, 0, v_payload)
            self.assertTrue(v_payload["clean"])

            # 5. Run headless BLUE scan on blind bundle and score directly in Arena
            blue_json = tmp_dir / "blue_scan.json"
            b_code, b_payload, _ = _run_cli(
                "blue", "scan",
                "--pdf", str(blind_pdf),
                "--supplement", str(supp_csv),
                "--digest-only",
                "--out", str(blue_json),
            )
            self.assertEqual(b_code, 0, b_payload)
            s_code, s_payload, _ = _run_cli(
                "arena", "score",
                "--gold", str(gold_json),
                "--blue", str(blue_json),
            )
            self.assertEqual(s_code, 0, s_payload)
            self.assertEqual(s_payload["goldCount"], 1)
            self.assertEqual(s_payload["runs"][0]["tp"], 1)
            self.assertEqual(s_payload["runs"][0]["byWorld"]["W5"]["recall"], 1.0)

    def test_skills_frontmatter_referenced_paths_and_cli_ccn(self):
        for skill_name in ("falsify-blue-auditor", "falsify-red-injector"):
            skill_path = ROOT / ".agents" / "skills" / skill_name / "SKILL.md"
            self.assertTrue(skill_path.is_file(), f"Missing {skill_path}")
            meta, body = _parse_frontmatter(skill_path)
            self.assertEqual(meta.get("name"), skill_name)
            self.assertEqual(meta.get("license"), "AGPL-3.0-only")
            self.assertTrue(meta.get("description"))
            refs = re.findall(r"`((?:app|tools)/[A-Za-z0-9_./-]+\.(?:py|mjs|md|json))`", body)
            self.assertGreaterEqual(len(refs), 3)
            for rel in refs:
                self.assertTrue((ROOT / rel).is_file(), f"Skill {skill_name} references missing path: {rel}")

        # Verify falsify_cli.py stays <= 15 CCN across all functions.
        proc = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "quality" / "python-functions.py")],
            input=(LOCAL / "falsify_cli.py").read_bytes(),
            capture_output=True,
            check=True,
        )
        funcs = json.loads(proc.stdout.decode("utf-8"))
        over = [f for f in funcs if f["ccn"] > 15]
        self.assertEqual(over, [], f"Functions exceeded CCN 15: {over}")

    def test_dynamic_delegation_and_timeout_exit_124(self):
        raw = _build_synthetic_paper_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            pdf_path = tmp_dir / "src.pdf"
            pdf_path.write_bytes(raw)
            out_pdf = tmp_dir / "out.pdf"
            gold_p = tmp_dir / "gold.json"
            blue_p = tmp_dir / "blue.json"
            gold_p.write_text(json.dumps({"operations": []}), encoding="utf-8")
            blue_p.write_text(json.dumps({"findings": []}), encoding="utf-8")

            # 1. text-span missing mutator -> exit 2
            buf = io.StringIO()
            with patch.dict(sys.modules, {"paper_text_span_mutator": None}):
                with patch.object(sys, "stdout", buf):
                    rc = falsify_cli.main([
                        "red", "apply",
                        "--pdf", str(pdf_path),
                        "--ops", json.dumps([{"kind": "text-span", "before": "x", "after": "y"}]),
                        "--out-pdf", str(out_pdf),
                    ])
            self.assertEqual(rc, 2)
            self.assertEqual(json.loads(buf.getvalue())["error"], "text_span_mutator_unavailable")

            # 2. text-span dynamic delegation when paper_text_span_mutator is importable
            class _FakeSpanMutator:
                @staticmethod
                def mutate_pdf_text_spans(pdf_bytes, ops):
                    return {
                        "pdfBytes": pdf_bytes,
                        "changes": [{"id": "ts-1", "kind": "text-span", "pageIndex": 0}],
                        "modifiedRegions": [],
                    }

            buf2 = io.StringIO()
            with patch.dict(sys.modules, {"paper_text_span_mutator": _FakeSpanMutator}):
                with patch.object(sys, "stdout", buf2):
                    rc2 = falsify_cli.main([
                        "red", "apply",
                        "--pdf", str(pdf_path),
                        "--ops", json.dumps([{"kind": "text-span", "before": "x", "after": "y"}]),
                        "--out-pdf", str(out_pdf),
                        "--require-clean-stealth",
                    ])
            self.assertEqual(rc2, 0)
            self.assertEqual(json.loads(buf2.getvalue())["appliedCount"], 1)

            # 3. arena_runner delegation for blind verify & arena score
            class _FakeArenaRunner:
                @staticmethod
                def verify_blind_bundle(blind_pdf, source_pdf=None, supplements=None):
                    return {"clean": True, "leaks": [], "checked": blind_pdf}

                @staticmethod
                def evaluate_arena_match(gold_path, blue_paths, baseline_path=None):
                    return {"goldCount": 0, "runs": [], "runner": "arena_runner"}

            buf3, buf4 = io.StringIO(), io.StringIO()
            with patch.dict(sys.modules, {"arena_runner": _FakeArenaRunner}):
                with patch.object(sys, "stdout", buf3):
                    rc3 = falsify_cli.main(["blind", "verify", "--pdf", str(pdf_path)])
                with patch.object(sys, "stdout", buf4):
                    rc4 = falsify_cli.main(["arena", "score", "--gold", str(gold_p), "--blue", str(blue_p)])
            self.assertEqual(rc3, 0)
            self.assertTrue(json.loads(buf3.getvalue())["clean"])
            self.assertEqual(rc4, 0)
            self.assertEqual(json.loads(buf4.getvalue())["runner"], "arena_runner")

            # 4. Timeout handling -> exit 124
            buf5 = io.StringIO()
            with patch.object(falsify_cli, "run_blue_sensor", side_effect=TimeoutError("slow")):
                with patch.object(sys, "stdout", buf5):
                    rc5 = falsify_cli.main(["blue", "scan", "--pdf", str(pdf_path)])
            self.assertEqual(rc5, 124)
            self.assertEqual(json.loads(buf5.getvalue())["error"], "timeout")


if __name__ == "__main__":
    unittest.main()

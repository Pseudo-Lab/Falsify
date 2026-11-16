"""Tests for PRISMA, meta-analysis arithmetic, and cross-table sample-size audit."""
import hashlib
import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "app" / "local"))
import paper_evidence as pe
import paper_meta_and_table_audit as audit
import paper_stat_math as sm

_Z95 = 1.959964


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _kinds(report):
    return {sig["kind"] for sig in report["signals"]}


def _draw_grid(page, origin, col_widths, row_height, rows_data):
    x0, y0 = origin
    for r, row in enumerate(rows_data):
        cx = x0
        cy0 = y0 + r * row_height
        for c, text in enumerate(row):
            cw = col_widths[c]
            rect = pymupdf.Rect(cx, cy0, cx + cw, cy0 + row_height)
            page.draw_rect(rect, color=(0, 0, 0), width=0.8)
            if text:
                page.insert_textbox(
                    pymupdf.Rect(rect.x0 + 3, rect.y0 + 4, rect.x1 - 3, rect.y1 - 2),
                    text, fontsize=9, fontname="helv",
                )
            cx += cw


def _pool_or(studies):
    ys, ses = [], []
    for est, lo, hi in studies:
        y, low, high = math.log(est), math.log(lo), math.log(hi)
        se = (high - low) / (2 * _Z95)
        ys.append(y)
        ses.append(se)
    ws = [1.0 / (se * se) for se in ses]
    sw = sum(ws)
    theta_fe = sum(w * y for w, y in zip(ws, ys)) / sw
    q = sum(w * (y - theta_fe) ** 2 for w, y in zip(ws, ys))
    sum_w2 = sum(w * w for w in ws)
    c = sw - sum_w2 / sw
    df = len(ys) - 1
    tau2 = max(0.0, (q - df) / c) if c > 0 and q > df else 0.0
    wstar = [1.0 / (se * se + tau2) for se in ses]
    sws = sum(wstar)
    theta_re = sum(w * y for w, y in zip(wstar, ys)) / sws
    return math.exp(theta_fe), math.exp(theta_re)


def _or_table(caption, overall, studies):
    rows = [["Study", "OR", "CI low", "CI high"]]
    for index, (est, lo, hi) in enumerate(studies):
        rows.append([f"Study {index + 1}", f"{est:.2f}", f"{lo:.2f}", f"{hi:.2f}"])
    rows.append(["Overall", f"{overall:.2f}", "0.50", "2.00"])
    return {"pageIndex": 1, "caption": caption, "table": {"rows": rows}}


class MetaAndTableAuditTests(unittest.TestCase):
    def test_prisma_tamper_and_clean_exemptions(self):
        tampered = "\n".join([
            "Records identified (n = 500).",
            "Duplicates removed (n = 50).",
            "Records screened (n = 400).",
            "Records excluded (n = 300).",
            "Reports assessed for eligibility (n = 100).",
            "Full-text articles excluded (n = 40).",
            "Studies included in the review (n = 60).",
        ])
        bad = audit.audit_meta_and_tables([(2, tampered)])
        self.assertEqual(bad["status"], "ok")
        self.assertIn("prisma_flow_mismatch", _kinds(bad))
        self.assertTrue(all(sig["family"] == "D1" for sig in bad["signals"]))
        self.assertTrue(all(sig["subtype"] == "prisma-flow-arithmetic" for sig in bad["signals"]))
        self.assertEqual(bad["signals"][0]["pageIndex"], 2)
        self.assertLessEqual(len(bad["signals"][0]["excerpt"]), 220)

        increased = "Records identified (n = 100).\nRecords screened (n = 150)."
        rise = audit.audit_meta_and_tables(increased)
        self.assertIn("prisma_flow_mismatch", _kinds(rise))

        clean = "\n".join([
            "Records identified through database searching (n = 500).",
            "Additional records from citation searching (n = 20).",
            "Duplicates removed (n = 50).",
            "Records screened (n = 470).",
            "Records excluded (n = 400).",
            "Reports assessed for eligibility (n = 70).",
            "Full-text articles excluded (n = 20).",
            "Reasons for exclusion were not mutually exclusive: wrong population (n = 12); wrong outcome (n = 10).",
            "Studies included in meta-analysis (n = 50).",
        ])
        self.assertEqual(audit.audit_meta_and_tables(clean)["signalCount"], 0)

        reasons = "\n".join([
            "Full-text articles excluded (n = 20).",
            "Reasons for exclusion: wrong population (n = 12); wrong outcome (n = 10).",
        ])
        reason_bad = audit.audit_meta_and_tables(reasons)
        self.assertIn("prisma_flow_mismatch", _kinds(reason_bad))

    def test_weights_heterogeneity_and_pooled_effects(self):
        bad_weights = {
            "pageIndex": 0,
            "table": {"rows": [
                ["Study", "Weight (%)"],
                ["Alpha", "30"],
                ["Beta", "40"],
                ["Total", "100"],
            ]},
        }
        weighted = audit.audit_meta_and_tables([], table_items=[bad_weights])
        self.assertEqual(_kinds(weighted), {"meta_weight_sum_mismatch"})
        self.assertEqual(weighted["signals"][0]["subtype"], "forest-weight-sum")

        clean_weights = {
            "pageIndex": 0,
            "table": {"rows": [
                ["Study", "가중치"],
                ["Alpha", "55"],
                ["Beta", "45"],
                ["Total", "100"],
            ]},
        }
        partitioned = {
            "pageIndex": 1,
            "table": {"rows": [
                ["Study", "Weight (%)"],
                ["Alpha", "20"],
                ["Beta", "15"],
                ["Subgroup 1", "35"],
                ["Gamma", "25"],
                ["Subgroup 2", "25"],
            ]},
        }
        self.assertEqual(audit.audit_meta_and_tables([], table_items=[clean_weights])["signalCount"], 0)
        self.assertEqual(audit.audit_meta_and_tables([], table_items=[partitioned])["signalCount"], 0)

        pipe_bad = "\n".join([
            "Study | Weight (%)",
            "Alpha | 25",
            "Beta | 25",
            "Total | 100",
        ])
        self.assertIn("meta_weight_sum_mismatch", _kinds(audit.audit_meta_and_tables(pipe_bad)))

        valid_i2 = "\n".join([
            "Heterogeneity: Q = 12.5, df = 5, p = {p}, I² = 60.0%.",
        ])
        p_hat = sm.gammaincc(5 / 2.0, 12.5 / 2.0)
        valid = audit.audit_meta_and_tables(valid_i2.format(p=f"{p_hat:.3f}"))
        self.assertEqual(valid["signalCount"], 0, valid["signals"])

        bad_i2 = audit.audit_meta_and_tables(
            "Heterogeneity: Q = 12.5, df = 5, p = {p}, I² = 90%.".format(p=f"{p_hat:.3f}")
        )
        self.assertTrue(any("I2" in sig["computed"] for sig in bad_i2["signals"]))
        self.assertTrue(all("p" not in sig["computed"] for sig in bad_i2["signals"]))

        bad_p = audit.audit_meta_and_tables(
            "Heterogeneity: Q = 12.5, df = 5, p for heterogeneity = 0.80, I² = 60%."
        )
        self.assertTrue(any("p" in sig["computed"] for sig in bad_p["signals"]))
        self.assertEqual(bad_p["signals"][0]["subtype"], "cochran-q-i2")

        low_q = audit.audit_meta_and_tables(
            "Heterogeneity: Q = 2.0, df = 5, p = 0.001, I² = 0%."
        )
        self.assertTrue(any(sig["computed"].get("p", 1) > 0.2 for sig in low_q["signals"]))

        by_k = audit.audit_meta_and_tables("Heterogeneity: k = 6 studies, Q = 10, I² = 80%.")
        self.assertTrue(any(sig["reported"].get("df") == 5 for sig in by_k["signals"]))

        studies = [(0.50, 0.40, 0.62), (3.00, 1.00, 9.00), (1.40, 0.90, 2.20)]
        fe, re = _pool_or(studies)
        self.assertGreater(abs(fe - re), 0.05)
        fixed_ok = audit.audit_meta_and_tables([], table_items=[
            _or_table("Fixed-effect inverse-variance meta-analysis", fe, studies),
        ])
        self.assertEqual(fixed_ok["signalCount"], 0, fixed_ok["signals"])
        random_ok = audit.audit_meta_and_tables([], table_items=[
            _or_table("DerSimonian-Laird random-effects meta-analysis", re, studies),
        ])
        self.assertEqual(random_ok["signalCount"], 0, random_ok["signals"])
        fixed_bad = audit.audit_meta_and_tables([], table_items=[
            _or_table("Fixed-effect inverse-variance meta-analysis", fe + 0.40, studies),
        ])
        self.assertEqual(_kinds(fixed_bad), {"meta_pooled_effect_mismatch"})
        self.assertEqual(fixed_bad["signals"][0]["reported"]["model"], "fixed-effect")
        hull = audit.audit_meta_and_tables([], table_items=[
            _or_table("Forest plot", 4.50, [(1.10, 0.80, 1.50), (1.40, 1.00, 2.00), (1.20, 0.90, 1.60)]),
        ])
        self.assertEqual(hull["signals"][0]["reported"]["model"], "convex-hull")
        exempt = audit.audit_meta_and_tables([], table_items=[
            _or_table("Bayesian network meta-analysis with hierarchical priors", 4.50, studies),
        ])
        self.assertEqual(exempt["signalCount"], 0)

    def test_cross_table_sample_size(self):
        first = {
            "id": "t1", "pageIndex": 0, "caption": "Table 1. Baseline characteristics",
            "table": {"rows": [
                ["Characteristic", "Total (N = 240)", "Treatment (n = 120)", "Control (n = 120)"],
                ["Events", "40", "22", "18"],
            ]},
        }
        second = {
            "id": "t2", "pageIndex": 1, "caption": "Table 2. Primary outcomes",
            "table": {"rows": [
                ["Outcome", "Total (N = 240)", "Treatment (n = 90)", "Control (n = 120)"],
                ["Response", "30", "10", "20"],
            ]},
        }
        bad = audit.audit_meta_and_tables([], table_items=[first, second])
        self.assertEqual(bad["signalCount"], 1)
        self.assertEqual(bad["signals"][0]["kind"], "cross_table_sample_size_mismatch")
        self.assertEqual(bad["signals"][0]["subtype"], "table-to-table-n")
        self.assertEqual(bad["signals"][0]["reported"]["arm"], "treatment")

        subset = dict(second)
        subset["caption"] = "Table 2. Primary outcomes in the per-protocol completer subset"
        clean = audit.audit_meta_and_tables([], table_items=[first, subset])
        self.assertEqual(clean["signalCount"], 0)

    def test_paper_binding_red_keys_and_limit(self):
        doc = pymupdf.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 64), "Records identified (n = 200).", fontsize=11)
        page.insert_text((72, 82), "Duplicates removed (n = 20).", fontsize=11)
        page.insert_text((72, 100), "Records screened (n = 100).", fontsize=11)
        _draw_grid(
            page, (72, 140), [180, 120], 24,
            [
                ["Study", "Weight (%)"],
                ["Alpha", "30"],
                ["Beta", "40"],
                ["Total", "100"],
            ],
        )
        raw = doc.tobytes()
        doc.close()
        store = pe.EvidenceStore()
        summary = store.prepare(raw, _sha(raw))
        report = audit.audit_paper_meta_and_tables(summary["paperId"], summary["fileHash"], store=store)
        self.assertEqual(report["schema"], audit.SCHEMA)
        self.assertEqual(report["paperId"], summary["paperId"])
        self.assertEqual(report["fileHash"], summary["fileHash"])
        self.assertGreater(store.list_items(summary["paperId"], kind="table")["total"], 0)
        self.assertIn("prisma_flow_mismatch", _kinds(report))
        self.assertIn("meta_weight_sum_mismatch", _kinds(report))

        with self.assertRaises(ValueError) as red:
            audit.audit_meta_and_tables([{"text": "Records screened (n = 1).", "plan": "hide"}])
        self.assertEqual(str(red.exception), "forbidden_red_key")
        with self.assertRaises(ValueError) as nested:
            audit.audit_meta_and_tables("ok", table_items=[{"caption": "A", "notes": {"gold": 1}}])
        self.assertEqual(str(nested.exception), "forbidden_red_key")
        audit._assert_no_red_keys({"signals": []})
        for bad_limit in (True, 0, 101):
            with self.assertRaises(ValueError) as limit:
                audit.audit_meta_and_tables("hello", max_signals=bad_limit)
            self.assertEqual(str(limit.exception), "limit")
        with self.assertRaises(ValueError):
            audit.audit_paper_meta_and_tables("paper", max_signals=False)

        many = audit.audit_meta_and_tables(
            "Records identified (n = 100).\nRecords screened (n = 180).\n"
            "Heterogeneity: Q = 12.5, df = 5, I² = 90%.",
            max_signals=1,
        )
        self.assertEqual(many["signalCount"], 1)
        self.assertTrue(many["truncated"])

    def test_python_module_ccn_under_15(self):
        src = (ROOT / "app" / "local" / "paper_meta_and_table_audit.py").read_bytes()
        proc = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "quality" / "python-functions.py")],
            input=src, capture_output=True, check=True,
        )
        fns = json.loads(proc.stdout.decode("utf-8"))
        hot = [fn for fn in fns if fn["ccn"] > 15]
        self.assertTrue(fns)
        self.assertEqual(hot, [])


if __name__ == "__main__":
    unittest.main()

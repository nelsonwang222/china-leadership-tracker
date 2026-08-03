import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rmrb_build as rb

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REPO = Path(__file__).resolve().parents[2]


class TestParseLayout(unittest.TestCase):
    def test_layout_20250703(self):
        html_text = (FIXTURES / "layout_20250703.html").read_text(encoding="utf-8")
        items = rb.parse_layout(html_text, date(2025, 7, 3))
        self.assertGreaterEqual(len(items), 8)
        titles = [i["title"] for i in items]
        self.assertNotIn("导读", titles)
        by_id = {i["content_id"]: i for i in items}
        self.assertIn("30084528", by_id)
        self.assertIn("坚定正确政治方向", by_id["30084528"]["title"])
        self.assertTrue(
            by_id["30084528"]["url"].startswith(
                "https://paper.people.com.cn/rmrb/pc/content/"
            )
        )

    def test_layout_20241201(self):
        html_text = (FIXTURES / "layout_20241201.html").read_text(encoding="utf-8")
        items = rb.parse_layout(html_text, date(2024, 12, 1))
        by_id = {i["content_id"]: i for i in items}
        self.assertIn("30032249", by_id)


class TestParseArticle(unittest.TestCase):
    def test_article_20250703(self):
        html_text = (
            FIXTURES / "article_20250703_content30084528.html"
        ).read_text(encoding="utf-8")
        title, content = rb.parse_article(html_text, "fallback")
        self.assertIn("习近平", title)
        self.assertIn("坚定正确政治方向", title)
        self.assertIn("中华全国青年联合会", content)
        self.assertIn("习近平", content)
        self.assertGreater(len(content), 500)

    def test_article_20241201(self):
        html_text = (
            FIXTURES / "article_20241201_content30032249.html"
        ).read_text(encoding="utf-8")
        title, content = rb.parse_article(html_text, "fallback")
        self.assertIn("必须坚持守正创新", title)
        self.assertGreater(len(content), 300)


class TestTagging(unittest.TestCase):
    def test_boilerplate_exclusion(self):
        self.assertFalse(rb.has_real_mention("习近平新时代中国特色社会主义思想", "习近平"))
        self.assertFalse(rb.has_real_mention("习近平精神学习会", "习近平"))
        self.assertTrue(rb.has_real_mention("习近平出席开幕会", "习近平"))

    def test_actor_vs_mention(self):
        leaders = json.loads(
            (REPO / "docs" / "data" / "leaders.json").read_text(encoding="utf-8")
        )
        record = {
            "title_zh": "习近平致信祝贺全国青联十四届全委会全国学联二十八大召开",
            "content_zh": "蔡奇出席开幕会。石泰峰宣读了习近平的贺信。",
        }
        rb.tag_leaders(record, leaders)
        self.assertIn("xi-jinping", record["leaders"])
        self.assertIn("cai-qi", record["mentions"])
        self.assertIn("shi-taifeng", record["mentions"])
        self.assertNotIn("xi-jinping", record["mentions"])


class TestBuild(unittest.TestCase):
    def test_build_outputs(self):
        records = [
            {
                "id": "rmrb-20250703-content30084528",
                "date": "2025-07-03",
                "page": "01",
                "title_zh": "习近平致信祝贺",
                "url": "https://example.com/content_30084528.html",
                "content_zh": "正文内容",
                "leaders": ["xi-jinping"],
                "mentions": ["cai-qi"],
            },
            {
                "id": "rmrb-20250704-content30085000",
                "date": "2025-07-04",
                "page": "01",
                "title_zh": "李强将出访",
                "url": "https://example.com/content_30085000.html",
                "content_zh": "另一篇正文",
                "leaders": ["li-qiang"],
                "mentions": [],
            },
        ]
        translations = {
            "rmrb-20250703-content30084528": {
                "id": "rmrb-20250703-content30084528",
                "title_en": "Xi Sends Congratulatory Letter",
                "summary_en": "Xi congratulated the conference.",
            }
        }
        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            rb.build_outputs(records, translations, out)
            index = json.loads((out / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["columns"], rb.INDEX_COLUMNS)
            self.assertEqual(len(index["events"]), 2)
            self.assertEqual(index["events"][0][0], "rmrb-20250703-content30084528")
            self.assertEqual(index["events"][0][3], 1)
            shard = json.loads((out / "events-2025.json").read_text(encoding="utf-8"))
            self.assertEqual(len(shard), 2)
            self.assertEqual(
                shard["rmrb-20250703-content30084528"]["url"],
                "https://example.com/content_30084528.html",
            )
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["n_events"], 2)
            self.assertEqual(meta["n_translated"], 1)
            self.assertEqual(meta["n_days"], 2)
            self.assertEqual(meta["years"], ["2025"])
            self.assertEqual(meta["first_date"], "2025-07-03")

    def test_jsonl_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "records.jsonl"
            rb.save_jsonl(p, [{"id": "a", "x": 1}])
            self.assertEqual(rb.load_jsonl(p), [{"id": "a", "x": 1}])

    def test_translation_parser(self):
        t = rb.parse_translation_json(
            '```json\n{"title_en": "Hello", "summary_en": "World."}\n```'
        )
        self.assertEqual(t["title_en"], "Hello")
        self.assertEqual(t["summary_en"], "World.")
        self.assertIsNone(rb.parse_translation_json("not json"))




class TestCheckedState(unittest.TestCase):
    def test_checked_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "checked.json"
            rb.save_checked(p, {"2026-07-01": "2026-08-03T00:00:00+00:00"})
            self.assertEqual(
                rb.load_checked(p), {"2026-07-01": "2026-08-03T00:00:00+00:00"}
            )
            self.assertEqual(rb.load_checked(Path(td) / "missing.json"), {})

    def test_checked_stale(self):
        now = datetime(2026, 8, 3, tzinfo=timezone.utc)
        fresh = (now - timedelta(days=2)).isoformat()
        stale = (now - timedelta(days=8)).isoformat()
        self.assertFalse(rb.checked_stale(fresh, 7, now))
        self.assertTrue(rb.checked_stale(stale, 7, now))
        self.assertTrue(rb.checked_stale("not-a-date", 7, now))
        naive = (now - timedelta(days=2)).replace(tzinfo=None).isoformat()
        self.assertFalse(rb.checked_stale(naive, 7, now))

    def test_plan_missing_dates(self):
        since = date(2026, 7, 1)
        today = date(2026, 7, 4)
        checked = {
            "2026-07-02": "2026-08-03T00:00:00+00:00",
            "2026-07-03": "2020-01-01T00:00:00+00:00",
        }
        known = {"2026-07-01"}
        missing = rb.plan_missing_dates(since, today, known, checked, 7, 10)
        self.assertEqual([d.isoformat() for d in missing], ["2026-07-03", "2026-07-04"])
        capped = rb.plan_missing_dates(since, today, known, {}, 7, 1)
        self.assertEqual([d.isoformat() for d in capped], ["2026-07-02"])


class TestMainNoNetwork(unittest.TestCase):
    def test_dry_run_without_records(self):
        with tempfile.TemporaryDirectory() as td:
            records_dir = Path(td) / "records"
            out_dir = Path(td) / "out"
            rc = rb.main([
                "--dry-run", "--records-dir", str(records_dir),
                "--out-dir", str(out_dir),
            ])
            self.assertEqual(rc, 0)
            self.assertFalse((out_dir / "meta.json").exists())


if __name__ == "__main__":
    unittest.main()
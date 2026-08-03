#!/usr/bin/env python3
"""People's Daily front-page scanner and site-data builder (stdlib only).

Harvests the People's Daily e-paper front page
(paper.people.com.cn/rmrb/pc/layout/YYYYMM/DD/node_01.html), extracts each
article's title and full text, tags leaders from the public leaders.json
roster, translates new rows via the repo's Anthropic/Gemini secrets, and
builds docs/data/rmrb/{index.json, events-YYYY.json, meta.json}.

State (both committed, append-only):
  rmrb/records.jsonl      one raw article per line (fetched once)
  rmrb/translations.jsonl one translation per line (cached forever)

Usage:
  python scripts/rmrb_build.py [--since 2026-07-01] [--max-days N]
      [--translate-limit N] [--no-translate] [--dry-run] [--sleep SECONDS]
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SINCE = "2026-07-01"
DEFAULT_CHECKED_TTL_DAYS = 7
DEFAULT_RECORDS_DIR = ROOT / "rmrb"
DEFAULT_OUT_DIR = ROOT / "docs" / "data" / "rmrb"
DEFAULT_LEADERS = ROOT / "docs" / "data" / "leaders.json"
PAPER_BASE = "https://paper.people.com.cn/rmrb/pc"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
INDEX_COLUMNS = [
    "id", "date", "type", "activity", "title_zh", "title_en", "summary_en",
    "leaders", "mentions", "counterpart", "location",
]
TYPES = {"article": "Published article"}
# Names immediately followed by one of these are ideology boilerplate
# (e.g. 习近平新时代中国特色社会主义思想), not a report of the person's activity.
BOILER_PHRASES = ("习近平新时代中国特色社会主义思想", "新时代", "思想", "精神", "理论", "战略")
SKIP_TITLES = {"导读", ""}
BEIJING = timezone(timedelta(hours=8))


class BlockedError(RuntimeError):
    """The paper site refused us (403); stop fetching, self-heal next run."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def beijing_today() -> date:
    return datetime.now(BEIJING).date()


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    print(f"WARN skipping malformed line in {path}", file=sys.stderr)
    return out


def save_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(path)


def load_checked(path: Path) -> dict[str, str]:
    """Return {date: checked_at_iso} for dates found empty on a prior run."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_checked(path: Path, checked: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(checked, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp.replace(path)


def checked_stale(checked_at: str, ttl_days: int, now: datetime) -> bool:
    try:
        dt = datetime.fromisoformat(checked_at)
    except (TypeError, ValueError):
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt) > timedelta(days=ttl_days)


def plan_missing_dates(
    since: date,
    today: date,
    known_dates: set[str],
    checked: dict[str, str],
    ttl_days: int,
    max_days: int,
) -> list[date]:
    """Dates to fetch: not already recorded, and not recently checked-empty."""
    now = datetime.now(timezone.utc)
    out: list[date] = []
    for i in range((today - since).days + 1):
        d = since + timedelta(days=i)
        iso = d.isoformat()
        if iso in known_dates:
            continue
        if iso in checked and not checked_stale(checked[iso], ttl_days, now):
            continue
        out.append(d)
        if len(out) >= max_days:
            break
    return out


def fetch_url(url: str, timeout: int = 30, retries: int = 3) -> tuple[int, bytes]:
    """Return (status, body). Raises BlockedError on 403, URLError after retries."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
    }
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise BlockedError(f"{url} -> 403 (anti-bot; stopping fetch)")
            if e.code == 404:
                return 404, b""
            last_err = e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = e
        if attempt + 1 < retries:
            time.sleep(0.5 * (2 ** attempt))
    raise last_err or RuntimeError(f"fetch failed: {url}")


def layout_url(d: date) -> str:
    return f"{PAPER_BASE}/layout/{d:%Y%m}/{d:%d}/node_01.html"


def strip_tags(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_layout(html_text: str, paper_date: date) -> list[dict]:
    """Return [{content_id, title, url}] from a front-page layout page."""
    items: dict[str, dict] = {}
    pattern = re.compile(
        r'<a\b[^>]*\bhref="([^"]*content_(\d+)\.html)"[^>]*>(.*?)</a>',
        re.S | re.I,
    )
    for href, content_id, body in pattern.findall(html_text):
        title = normalize_space(strip_tags(body))
        if title in SKIP_TITLES or not title:
            continue
        url = urllib.parse.urljoin(layout_url(paper_date), href)
        items[content_id] = {"content_id": content_id, "title": title, "url": url}
    return list(items.values())


def parse_article(html_text: str, fallback_title: str = "") -> tuple[str, str]:
    """Return (title_zh, content_zh) from an article page."""
    def first_text(pattern: str) -> str:
        m = re.search(pattern, html_text, re.S)
        return normalize_space(strip_tags(m.group(1))) if m else ""

    kicker = first_text(r"<h3[^>]*>(.*?)</h3>")
    headline = first_text(r"<h1[^>]*>(.*?)</h1>")
    if kicker and headline and kicker not in headline:
        title = f"{kicker}：{headline}"
    elif headline:
        title = headline
    else:
        title = fallback_title

    body_blocks = [
        r'<div[^>]*id="ozoom"[^>]*>(.*?)(?:<div\s+class="attachment"|<div\s+class="bottom"|<div\s+id=")',
        r'<div[^>]*id="articleContent"[^>]*>(.*?)(?:<div\s+class="article"|<div\s+class="bottom")',
        r'<div[^>]*class="article"[^>]*>(.*?)(?:<div\s+class="attachment"|<div\s+class="bottom")',
    ]
    content = ""
    for pattern in body_blocks:
        m = re.search(pattern, html_text, re.S)
        if m:
            paras = []
            for p in re.findall(r"<p[^>]*>(.*?)</p>", m.group(1), re.S):
                text = normalize_space(strip_tags(p))
                if text:
                    paras.append(text)
            content = "\n".join(paras)
            if content:
                break
    return title, content


def has_real_mention(text: str, name: str) -> bool:
    for m in re.finditer(re.escape(name), text):
        tail = text[m.end():m.end() + 14]
        if any(tail.startswith(s) for s in BOILER_PHRASES):
            continue
        return True
    return False


def tag_leaders(record: dict, leaders: list[dict]) -> None:
    title = record.get("title_zh") or ""
    content = record.get("content_zh") or ""
    actors, mentions = [], []
    for p in leaders:
        name = (p.get("name_zh") or "").strip()
        if not name:
            continue
        if name in title:
            actors.append(p["id"])
        elif has_real_mention(content, name):
            mentions.append(p["id"])
    record["leaders"] = actors
    record["mentions"] = mentions


def fetch_records_for_date(
    d: date, leaders: list[dict], sleep: float
) -> tuple[list[dict], int]:
    """Return (records, expected_article_count) for one paper date.

    expected_article_count is 0 when the layout itself is empty/404, and the
    number of listed articles when the layout parsed but some articles failed.
    Callers use it to keep incomplete dates retryable.
    """
    url = layout_url(d)
    status, body = fetch_url(url)
    if status == 404:
        return [], 0
    html_text = body.decode("utf-8", "replace")
    items = parse_layout(html_text, d)
    if not items:
        return [], 0
    time.sleep(sleep)
    records = []
    for item in items:
        status, body = fetch_url(item["url"])
        if status == 404:
            # The paper site rate-limits with 404s; give one quiet retry
            # before treating the article as missing.
            time.sleep(sleep * 2)
            status, body = fetch_url(item["url"])
        if status == 404:
            continue
        title, content = parse_article(
            body.decode("utf-8", "replace"), item["title"]
        )
        if not content:
            continue
        record = {
            "id": f"rmrb-{d:%Y%m%d}-content{item['content_id']}",
            "date": d.isoformat(),
            "page": "01",
            "title_zh": title,
            "url": item["url"],
            "content_zh": content,
            "leaders": [],
            "mentions": [],
            "fetched_at": now_iso(),
        }
        tag_leaders(record, leaders)
        records.append(record)
        time.sleep(sleep)
    return records, len(items)


def translate_with_anthropic(
    title_zh: str, content_zh: str, api_key: str, model: str
) -> dict | None:
    prompt = _translate_prompt(title_zh, content_zh)
    payload = {
        "model": model,
        "max_tokens": 500,
        "system": (
            "You are the translation engine for the China Leadership Tracker, "
            "a research database of Chinese leaders' public activities. "
            "Translate accurately and neutrally. Reply with JSON only."
        ),
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data["content"][0]["text"]
    return parse_translation_json(text)


def translate_with_gemini(
    title_zh: str, content_zh: str, api_key: str, model: str
) -> dict | None:
    prompt = _translate_prompt(title_zh, content_zh)
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model)}:generateContent?key={api_key}"
    )
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return parse_translation_json(text)


def _translate_prompt(title_zh: str, content_zh: str) -> str:
    return (
        "Translate this People's Daily front-page article for an English-"
        "language China leadership tracker.\n\n"
        f"Original headline: {title_zh}\n\n"
        f"Article text:\n{content_zh[:4000]}\n\n"
        'Reply with ONLY a JSON object: {"title_en": "...", "summary_en": "..."} '
        "where title_en is a fluent English headline and summary_en is a "
        "1-2 sentence factual summary of what the article reports."
    )


def parse_translation_json(text: str) -> dict | None:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if data.get("title_en") and data.get("summary_en"):
                return {
                    "title_en": str(data["title_en"]).strip(),
                    "summary_en": str(data["summary_en"]).strip(),
                }
        except json.JSONDecodeError:
            pass
    m = re.search(r'"title_en"\s*:\s*"([^"]*)"', text)
    s = re.search(r'"summary_en"\s*:\s*"([^"]*)"', text)
    if m and s:
        return {"title_en": m.group(1), "summary_en": s.group(1)}
    return None


def translate_new_records(
    records: list[dict],
    translations: dict[str, dict],
    limit: int,
) -> int:
    """Translate records missing a cache entry; return number attempted."""
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    model = os.environ.get("TRANSLATE_MODEL", "").strip()
    if limit <= 0:
        return 0
    if not anthropic_key and not gemini_key:
        print("No translation API key set; skipping translation.")
        return 0
    use_anthropic = bool(anthropic_key)
    model = model or ("claude-opus-4-8" if use_anthropic else "gemini-2.5-flash")
    pending = [r for r in records if r["id"] not in translations]
    pending.sort(key=lambda r: (r["date"], r["id"]), reverse=True)  # newest first
    attempted = 0
    for r in pending[:limit]:
        try:
            if use_anthropic:
                t = translate_with_anthropic(r["title_zh"], r["content_zh"], anthropic_key, model)
            else:
                t = translate_with_gemini(r["title_zh"], r["content_zh"], gemini_key, model)
        except Exception as e:  # noqa: BLE001 - keep going; next run retries
            print(f"WARN translate {r['id']} failed: {e}", file=sys.stderr)
            attempted += 1
            continue
        if t:
            translations[r["id"]] = {
                "id": r["id"],
                "title_en": t["title_en"],
                "summary_en": t["summary_en"],
                "model": model,
                "translated_at": now_iso(),
            }
        attempted += 1
    return attempted


def build_outputs(
    records: list[dict],
    translations: dict[str, dict],
    out_dir: Path,
) -> None:
    records = sorted(records, key=lambda r: (r["date"], r["id"]))
    rows = []
    shards: dict[str, dict[str, dict]] = {}
    n_translated = 0
    dates = set()
    for r in records:
        tr = translations.get(r["id"], {})
        title_en = tr.get("title_en", "")
        if title_en:
            n_translated += 1
        rows.append([
            r["id"], r["date"], "article", 1 if r.get("leaders") else 0,
            r.get("title_zh", ""), title_en, tr.get("summary_en", ""),
            ",".join(r.get("leaders") or []),
            ",".join(r.get("mentions") or []),
            "", "",
        ])
        dates.add(r["date"])
        year = r["date"][:4]
        shards.setdefault(year, {})[r["id"]] = {
            "content_zh": r.get("content_zh", ""),
            "url": r.get("url", ""),
        }
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "index.json").open("w", encoding="utf-8") as f:
        json.dump(
            {"columns": INDEX_COLUMNS, "types": TYPES, "events": rows},
            f, ensure_ascii=False, separators=(",", ":"),
        )
    for year, entries in shards.items():
        with (out_dir / f"events-{year}.json").open("w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))
    meta = {
        "built_at": now_iso(),
        "first_date": min(dates) if dates else None,
        "last_date": max(dates) if dates else None,
        "n_events": len(rows),
        "n_translated": n_translated,
        "n_days": len(dates),
        "years": sorted({d[:4] for d in dates}),
    }
    with (out_dir / "meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"Built docs/data/rmrb: {meta['n_events']} events, "
        f"{meta['n_days']} days, {meta['n_translated']} translated"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--since", default=DEFAULT_SINCE, help="backfill start date")
    p.add_argument("--max-days", type=int, default=60,
                   help="max dates to fetch per run (guard against blocked runs)")
    p.add_argument("--translate-limit", type=int, default=300,
                   help="max articles to translate this run (0 = skip)")
    p.add_argument("--no-translate", action="store_true",
                   help="shortcut for --translate-limit 0")
    p.add_argument("--dry-run", action="store_true",
                   help="skip fetching/translation; rebuild outputs from records")
    p.add_argument("--checked-ttl-days", type=int, default=DEFAULT_CHECKED_TTL_DAYS,
                   help="re-check an empty date after this many days (default 7)")
    p.add_argument("--sleep", type=float, default=0.5,
                   help="seconds between requests (polite fetching)")
    p.add_argument("--records-dir", type=Path, default=DEFAULT_RECORDS_DIR)
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    p.add_argument("--leaders", type=Path, default=DEFAULT_LEADERS)
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    leaders = json.loads(args.leaders.read_text(encoding="utf-8"))
    records_path = args.records_dir / "records.jsonl"
    translations_path = args.records_dir / "translations.jsonl"
    records = load_jsonl(records_path)
    translations = {t["id"]: t for t in load_jsonl(translations_path)}
    known_ids = {r["id"] for r in records}
    known_dates = {r["date"] for r in records}
    checked_path = args.records_dir / "checked.json"
    checked = load_checked(checked_path)

    if not args.dry_run:
        since = date.fromisoformat(args.since)
        today = beijing_today()
        missing = plan_missing_dates(
            since, today, known_dates, checked, args.checked_ttl_days, args.max_days
        )
        consecutive_misses = 0
        pending_checked: dict[str, str] = {}
        stopped_by_block = False
        for d in missing:
            try:
                fetched, expected = fetch_records_for_date(d, leaders, args.sleep)
            except BlockedError as e:
                print(f"{e}; keeping progress, next run resumes.")
                stopped_by_block = True
                break
            except Exception as e:  # one bad date shouldn't abort the backfill
                print(f"WARN {d} fetch failed: {e}", file=sys.stderr)
                continue
            if not fetched:
                if expected > 0:
                    print(f"WARN {d} layout parsed but no articles fetched; will retry")
                    continue
                consecutive_misses += 1
                # Never tombstone today: the 05:30 run can legitimately run
                # before the paper is posted and the 23:30 run must retry it.
                if d < today:
                    pending_checked[d.isoformat()] = now_iso()
                print(f"{d} no items (404/empty); miss {consecutive_misses}")
                if consecutive_misses >= 5:
                    stopped_by_block = True
                    print("Stopping after 5 consecutive misses; next run resumes.")
                    break
                time.sleep(min(args.sleep * (2 ** consecutive_misses), 10))
                continue
            consecutive_misses = 0
            new = [r for r in fetched if r["id"] not in known_ids]
            if len(fetched) < expected:
                print(
                    f"WARN {d} incomplete ({len(fetched)}/{expected} articles); "
                    "date stays retryable"
                )
            else:
                known_dates.add(d.isoformat())
                checked.pop(d.isoformat(), None)
            records.extend(new)
            known_ids.update(r["id"] for r in new)
            save_jsonl(records_path, records)
            print(f"{d} +{len(new)} articles (total {len(records)})")
        if not stopped_by_block and pending_checked:
            checked.update(pending_checked)
            save_checked(checked_path, checked)
            print(f"Recorded {len(pending_checked)} checked-empty date(s).")

        if not args.no_translate:
            attempted = translate_new_records(
                records, translations, args.translate_limit
            )
            if attempted:
                save_jsonl(translations_path, list(translations.values()))
                print(f"Translated/attempted {attempted} new articles.")

    if records:
        build_outputs(records, translations, args.out_dir)
    else:
        print("No RMRB records yet; nothing to build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
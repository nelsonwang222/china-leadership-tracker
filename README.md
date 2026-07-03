# China Leadership Tracker 新闻联播数据库

A searchable, English-language database of Chinese leaders' public activities,
meetings, and policy events, built from the full text of CCTV's *Xinwen Lianbo*
(新闻联播) evening news broadcast since February 2016. Updated automatically
every day by GitHub Actions and served as a static site from `docs/` via
GitHub Pages.

## How it works

```
CCTV (tv.cctv.com/lm/xwlb) ── pipeline/fetch.py ──▶ data/raw/YYYY.jsonl
                                                        │
                     pipeline/extract.py  (roster of ~58 elite figures,
                     rule-based event typing: meeting / inspection / …)
                                                        │
                     pipeline/translate.py (Claude API, cached in
                     data/translations.json; optional — see below)
                                                        │
                     pipeline/build.py ──▶ docs/data/*.json ──▶ static site
```

- `pipeline/roster.py` — the tracked leaders (Politburo members of the
  18th–20th Central Committees, state leaders, key ministers).
- `docs/` — the website: vanilla HTML/CSS/JS, no build step, no framework.
  Search, filters, per-leader profiles, and a co-appearance network graph are
  all computed client-side from `docs/data/index.json`.

## Daily updates

`.github/workflows/update.yml` runs twice daily (22:30 and 07:30 Beijing
time): it fetches any missing broadcast days, translates new events, rebuilds
`docs/data/`, and commits. GitHub Pages redeploys on push.

## English translations

Rule-based extraction and the English UI work with no configuration. Fluent
English titles and summaries are produced by an LLM when an API-key secret is
set (repo → Settings → Secrets and variables → Actions):

1. Add **either** secret — `GEMINI_API_KEY` (Gemini, default model
   `gemini-2.5-flash`) or `ANTHROPIC_API_KEY` (Claude, default model
   `claude-opus-4-8`). If both are set, Claude is used.
2. Optionally set a repository *variable* `TRANSLATE_MODEL` to override the
   model for whichever provider is active.
3. Each daily run translates up to 300 untranslated events (newest first), so
   the historical backlog fills in gradually. To backfill faster, run the
   workflow manually with a higher `translate_limit`, or locally:
   `GEMINI_API_KEY=... python -m pipeline.translate 5000`.

Translations are cached in `data/translations.json` — each event is only ever
translated once.

## Local development

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pipeline.backfill   # fetch missing days
.venv/bin/python -m pipeline.build      # rebuild docs/data/
.venv/bin/python -m http.server -d docs 8000
```

## Credits

Conceived, maintained by [Nelson Wang (@nelsonwang222)](https://github.com/nelsonwang222), and co-worked with Claude's Fable 5.

## Data reuse

All processed data is plain JSON under `docs/data/` and republished daily.
Please cite as "China Leadership Tracker, based on CCTV Xinwen Lianbo
transcripts." Source transcripts are © CCTV; this project is for research and
educational use and is not affiliated with CCTV.

# China Leadership Tracker 新闻联播数据库

**Live site: https://nelsonwang222.github.io/china-leadership-tracker/**

A searchable, English-language database of Chinese leaders' public activities,
meetings, and policy events, built from the full text of CCTV's *Xinwen Lianbo*
(新闻联播) evening news broadcast since February 2016 — ~19,800 events from
3,800+ broadcasts, updated automatically every day by GitHub Actions and served
as a static site from `docs/` via GitHub Pages.

## Features

- **Events** — every leader-related news item since 2016, with English titles
  and analytic summaries (LLM-translated, cached), the original Chinese
  headline and full transcript, event-type classification, counterparts, and
  locations. Keyword search (English or 中文) covers titles, summaries, names —
  and, by default, the full transcript text. Filter by leader, event type, and
  exact date range; a monthly chart tracks whatever is currently matched.
- **Leaders** — ~58 senior figures (Politburo members of the 18th–20th Central
  Committees, state leaders, key ministers), ranked by appearance count with
  roles, last-seen dates, and per-type breakdowns.
- **Network** — an interactive co-appearance graph (two figures linked when
  they appear in the same news item, a standard elite-proximity proxy).
  Adjustable year range and edge threshold; drag nodes, click to isolate a
  leader's ego-network with ranked partners.
- **Design** — editorial dark/light theme (Newsreader serif + IBM Plex Mono),
  implemented from a Claude Design mockup; toggle in the header, preference
  remembered.

## How it works

This repo holds the website (`docs/` — vanilla HTML/CSS/JS, no build step, no
framework) and the daily-update workflow. Search, filters, the chart, and the
network graph are all computed client-side from `docs/data/index.json`; full
transcripts load per-year on demand.

The scraper/extraction/translation pipeline and the raw transcript archive
live in a separate private repo (`china-leadership-tracker-pipeline`):

```
CCTV (tv.cctv.com/lm/xwlb) ── fetch ──▶ raw JSONL archive (private repo)
                                            │
                     extract  (roster of ~58 elite figures,
                     rule-based event typing: meeting / inspection / …)
                                            │
                     translate  (Gemini or Claude API, cached —
                     each event translated once)
                                            │
                     build ──▶ docs/data/*.json  (published to THIS repo)
```

## Daily updates

`.github/workflows/update.yml` runs twice daily (22:30 and 07:30 Beijing
time): it checks out the private pipeline repo, fetches any missing broadcast
days (self-healing — a failed run is caught by the next), translates new
events, commits the data back to the pipeline repo, and publishes the rebuilt
`docs/data/` here; GitHub Pages redeploys on push.

## Translations

Fluent English titles and summaries are produced by an LLM when an API-key
secret is set (this repo → Settings → Secrets and variables → Actions):

- `GEMINI_API_KEY` (currently active; default model `gemini-2.5-flash`) or
  `ANTHROPIC_API_KEY` (Claude, default `claude-opus-4-8`). If both are set,
  Claude is used. Override the model with a repository variable
  `TRANSLATE_MODEL`.
- Each run translates a batch of untranslated events, newest first, and caches
  results — an event is only ever translated once.
- Manual runs: Actions → "Daily update" → Run workflow, with a custom
  `translate_limit` (0 skips translation).

## Local development

```sh
python -m http.server -d docs 8000
```

The site is fully static; edit `docs/` and refresh. Regenerating the data in
`docs/data/` requires the private pipeline repo.

See `CLAUDE.md` for architecture notes, operational gotchas, and lessons
learned while building this.

## Credits

Conceived, maintained by [Nelson Wang (@nelsonwang222)](https://github.com/nelsonwang222), and co-worked with Claude's Fable 5.

## Data reuse

All processed data is plain JSON under `docs/data/` and republished daily.
Please cite as "China Leadership Tracker, based on CCTV Xinwen Lianbo
transcripts." Source transcripts are © CCTV; this project is for research and
educational use and is not affiliated with CCTV.

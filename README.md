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
  headline and full transcript, event-type classification (17 types, from
  bilateral talks to inbound state visits to policy-document releases),
  counterparts, and locations. Keyword search (English or 中文), filters by
  leader, event type, and exact date range. Three mutually exclusive match
  modes: **AS PRIMARY ACTOR** (events the selected leader actually did —
  named as actor in the headline, not merely invoked in 学习贯彻…精神
  boilerplate), **AS MENTIONED** (named only in the body text), and
  **FULL TEXT 原文** (search inside the transcripts). A monthly chart and a
  live COUNT line track whatever is matched, and a password-gated button
  exports the matching events as a real `.xlsx`, generated in-browser with
  zero dependencies.
- **Leaders** — ~58 senior figures (Politburo members of the 18th–20th Central
  Committees, state leaders, key ministers) in official ranking order, with
  roles and last-seen dates. Per-leader activity and mention counts are read
  off the COUNT line by switching match modes.
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
                     extract  (roster of ~58 elite figures; 17 event types
                     via ordered keyword rules; actor-vs-mention semantics)
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
`docs/data/` here; a chained deploy job (`pages.yml`) then publishes `docs/`
to GitHub Pages.

## Translations

Fluent English titles and summaries are produced by an LLM when an API-key
secret is set (this repo → Settings → Secrets and variables → Actions):

- `GEMINI_API_KEY` (currently active; default model `gemini-2.5-flash`) or
  `ANTHROPIC_API_KEY` (Claude, default `claude-opus-4-8`). If both are set,
  Claude is used. Override the model with a repository variable
  `TRANSLATE_MODEL`.
- Each run translates a batch of untranslated events, newest first, and caches
  results — an event is only ever translated once. The full 2016–present
  archive is translated; daily runs only pick up new broadcasts.
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

The site is deliberately unlisted from search engines
(`<meta name="robots" content="noindex, nofollow">`): it is shared by direct
link rather than discovered by search. A `robots.txt` wouldn't work here —
crawlers read it only at the origin root, which a project Pages site doesn't
control.

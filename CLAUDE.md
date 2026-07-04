# CLAUDE.md — China Leadership Tracker

Public, daily-updating database of Chinese leaders' activities built from CCTV
*Xinwen Lianbo* transcripts. Live site: https://nelsonwang222.github.io/china-leadership-tracker/
(GitHub Pages from `docs/` on `main`). Owner: nelsonwang222.

## Architecture

```
pipeline/fetch.py     scrape tv.cctv.com/lm/xwlb/day/YYYYMMDD.shtml (8 threads/day)
pipeline/backfill.py  fetch ALL missing dates since 2016-02-03 (4 days in parallel)
pipeline/archive.py   raw store: data/raw/YYYY.jsonl (plain JSONL, one line/item)
pipeline/roster.py    ~58 elite figures, 18th–20th CC, with EN names/roles/tenures
pipeline/extract.py   rule-based event typing, counterpart/location parsing
pipeline/translate.py EN titles/summaries via Gemini or Claude; cache data/translations.json
pipeline/build.py     emits docs/data/: index.json, leaders.json, events-YYYY.json, meta.json
docs/                 vanilla HTML/CSS/JS site — no build step, no framework
.github/workflows/update.yml  fetch → translate → build → commit, on cron
```

Local dev: `.venv/bin/python -m pipeline.{backfill,translate,build}`, then
`python -m http.server -d docs`. Frontend data contract: `index.json` holds
compact array-of-arrays rows (see its `columns` field); full Chinese text lives
only in per-year `events-YYYY.json` shards, lazy-loaded/prefetched client-side.

## Operational facts

- **Translations** run on whichever key is present: `ANTHROPIC_API_KEY` (wins)
  or `GEMINI_API_KEY` (repo secret, currently active; default model
  `gemini-2.5-flash`, override via repo var `TRANSLATE_MODEL`). Cache key is
  `sha1(date|title_zh)[:16]` — **changing title cleaning in fetch/ingest
  invalidates cache entries and re-bills translation**; don't touch
  normalization casually.
- **Backfill schedule (temporary):** update.yml has extra cron entries
  (`15 2,5,8,11,17,20 * * *`) and a 2,500-event default while the 2016–2026
  backlog translates. Once `meta.json` `n_translated` ≈ `n_events`, trim back
  to the two daily crons and a ~300 default.
- **Design**: implemented from Claude Design project
  992c228a-c88e-4e22-8073-51d1654f2795 ("Modernizing China leadership
  tracker"). Tokens live in `docs/style.css` (`--bg/--panel/--line/--ink/
  --muted/--faint/--accent`, dark default + light via `html[data-theme]`);
  fonts Newsreader + IBM Plex Mono from Google Fonts.

## Lessons learned (change future behavior)

1. **Never push to main while an Actions run is in flight** unless you must —
   runs take up to ~2h and commit at the end. The commit step now does
   `git pull --rebase -X theirs` with retries, so a collision no longer loses
   a run's work, but it still wastes a rebase. Check
   `gh run list --workflow "Daily update" --limit 1` first.
2. **GitHub Pages (legacy builds) wedges silently.** A build can sit in
   `status: building` for 40+ minutes. Fix: `gh api -X POST
   repos/.../pages/builds` to requeue (or push any commit). Verify deploys by
   `curl`ing a changed file's content, not by build status. Served HTML is
   cached ~10 min — always hard-refresh when eyeballing.
3. **Workflow-file pushes need the `workflow` OAuth scope.** The gh token
   didn't have it; fix is `gh auth refresh -h github.com -s workflow`
   (device-code flow the user must complete in a browser).
4. **CCTV page structure varies by era.** Recent pages have `<h3>` titles;
   ~2019 pages only `div.tit`/`<title>`; some embed a "对不起，可能是网络原因…"
   error overlay that a naive selector grabs as the title. fetch.py tries
   `div.tit` → `h3` → `<title>` and rejects 对不起 strings. Same-day
   transcripts appear a few hours after the 19:00 Beijing broadcast — empty
   days are only marked permanently empty after 2 days (archive.append_day).
5. **Raw archive is deliberately *uncompressed* JSONL** — gzip shards defeat
   git delta compression and would bloat history under daily commits. Don't
   "optimize" it back to .gz.
6. **Gemini for political news:** use REST `v1beta` `generateContent` with
   `responseSchema` (uppercase types, `nullable` instead of type unions) and
   `safetySettings: BLOCK_NONE` on all categories, or routine
   military/sanctions coverage gets refused. Check `finishReason`; skip (don't
   crash on) blocked chunks. translate.py stops gracefully after 10
   consecutive API failures so the workflow still commits partial progress
   (free-tier daily quotas otherwise hang the job past its 6h limit).
7. **SVG drag: don't rely on `setPointerCapture`** — synthetic/CDP pointer
   events lose capture. Attach `pointermove`/`pointerup` to `window`, convert
   coords via `svg.getScreenCTM().inverse()`, and suppress the click handler
   when movement exceeded ~3px.
8. **git author email must be a GitHub-linked address** (e.g.
   `76817107+nelsonwang222@users.noreply.github.com`, set in repo git config)
   or the owner never appears in the Contributors graph — the `.local`
   hostname email doesn't count.
9. **Extraction rules:** TYPE_RULES order matters (first match wins);
   propaganda "coverage" pieces (引发热烈反响 / ^【…】 series) must be caught
   before activity types or they pollute the network graph; counterpart
   capture groups must exclude punctuation (`[^，。；、！？\s]`).
10. **Design handoff:** treat `.dc.html` mockups as visual spec only — their
    data/logic is placeholder. Keep real features the mockup omits (date
    pickers, chart, full-text toggle) and restyle them into the new language.

# CLAUDE.md — China Leadership Tracker (public site repo)

Public, daily-updating database of Chinese leaders' activities built from CCTV
*Xinwen Lianbo* transcripts. Live site: https://nelsonwang222.github.io/china-leadership-tracker/
(GitHub Pages from `docs/` on `main`). Owner: nelsonwang222.

**Split-repo setup (since 2026-07-05):** this repo holds only the static site
(`docs/`) and the update workflow. The pipeline and raw data live in the
private repo `nelsonwang222/china-leadership-tracker-pipeline` — see its
CLAUDE.md for pipeline architecture and scraping/translation lessons.

## Architecture

```
docs/                 vanilla HTML/CSS/JS site — no build step, no framework
docs/data/            built JSON published by the workflow (index, leaders,
                      per-year event shards, meta)
.github/workflows/update.yml  runs the private pipeline, publishes docs/data/
.github/workflows/pages.yml   deploys docs/ to Pages (push to docs/** or
                              called from update.yml)
```

The workflow runs HERE (public repos get free unlimited Actions minutes;
private repos are metered) and checks out the pipeline repo with a write
deploy key stored as secret `PIPELINE_DEPLOY_KEY`. Translation secrets
(`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`) and the `TRANSLATE_MODEL` var also
live in THIS repo's settings. Data commits go back to the pipeline repo;
`docs/data/*.json` commits land here. Because the workflow is public, so are
its run logs (event titles, counts, cadence) — keep pipeline stdout modest.

The 2016–present archive is fully translated as of 2026-07-05 (19,760/19,760);
routine runs only fetch/translate new broadcasts and take minutes, not hours.

Local dev: `python -m http.server -d docs`. Frontend data contract:
`index.json` holds compact array-of-arrays rows (see its `columns` field);
full Chinese text lives only in per-year `events-YYYY.json` shards,
lazy-loaded/prefetched client-side.

Key frontend facts (state as of 2026-07-08):

- **Match modes**: the filter bar has three mutually exclusive switches
  (`wireRadio`, exactly one always on): AS PRIMARY ACTOR (default; leader
  filter matches `e.leaders`) / AS MENTIONED (`e.mentions`) / FULL TEXT 原文
  (search loads transcript shards; leader matches either list). Per-leader
  actor/mention counts are read off the chart's COUNT line by switching
  modes — leader cards deliberately show no counts (dropped as confusing).
- **Roster page** shows all 58 in official ranking — `leaders.json` arrives
  pre-sorted (tier, then roster order); "LEADERS TRACKED" is roster size,
  NOT leaders-with-events (title-based primaries leave ~14 at zero).
- **XLSX export** under the chart: password-gated (SHA-256 hash constant in
  app.js — a deterrent only, the JSON is public; plaintext password is
  recorded only in the workspace-root PROJECT_OVERVIEW.md, outside git),
  session-cached via sessionStorage, generates a real .xlsx from a
  dependency-free stored-entry zip writer + inline-string sheet XML. Columns
  include Mode (how the selected leader relates to each row).
- **Type labels** flow from the pipeline via `index.json`'s `types` map; a
  new event type needs only a cosmetic `TYPE_CODES` entry here.

- **Design**: implemented from Claude Design project
  992c228a-c88e-4e22-8073-51d1654f2795 ("Modernizing China leadership
  tracker"). Tokens live in `docs/style.css` (`--bg/--panel/--line/--ink/
  --muted/--faint/--accent`, dark default + light via `html[data-theme]`);
  fonts Newsreader + IBM Plex Mono from Google Fonts.

## Lessons learned (change future behavior)

1. **Never push to main (either repo) while an Actions run is in flight**
   unless you must — a run commits to BOTH repos at the end. The commit steps
   do `git pull --rebase -X theirs` with retries, so a collision no longer
   loses a run's work, but it still wastes a rebase. Routine runs take
   minutes now (they took ~2h during the translation backfill). Check
   `gh run list --workflow "Daily update" --limit 1` first.
2. **Pages deploys via Actions (`pages.yml`), not the legacy branch builder**
   — the legacy builder repeatedly wedged silently in `status: building`
   (fix was requeueing via `gh api -X POST repos/.../pages/builds`), so
   Pages source was switched to "GitHub Actions" on 2026-07-05. pages.yml
   runs on pushes touching `docs/**` AND as a job called from update.yml —
   both are needed, because GITHUB_TOKEN pushes don't trigger push
   workflows. Verify deploys by `curl`ing a changed file's content; served
   files are CDN-cached ~10 min — always hard-refresh when eyeballing.
   deploy-pages can fail transiently with "Deployment failed, try again
   later" (seen lasting ~1h on 2026-07-06, GitHub status page green the
   whole time); pages.yml retries once, and a red deploy job self-heals at
   the next scheduled run — or `gh workflow run "Deploy Pages"` manually.
3. **Workflow-file pushes need the `workflow` OAuth scope.** The gh token
   didn't have it; fix is `gh auth refresh -h github.com -s workflow`
   (device-code flow the user must complete in a browser).
4. **SVG drag: don't rely on `setPointerCapture`** — synthetic/CDP pointer
   events lose capture. Attach `pointermove`/`pointerup` to `window`, convert
   coords via `svg.getScreenCTM().inverse()`, and suppress the click handler
   when movement exceeded ~3px.
5. **git author email must be a GitHub-linked address** (e.g.
   `76817107+nelsonwang222@users.noreply.github.com`, set in repo git config)
   or the owner never appears in the Contributors graph — the `.local`
   hostname email doesn't count.
6. **Design handoff:** treat `.dc.html` mockups as visual spec only — their
   data/logic is placeholder. Keep real features the mockup omits (date
   pickers, chart, full-text toggle) and restyle them into the new language.
7. **History was rewritten on 2026-07-05** (git filter-repo, force push) to
   purge pre-split `pipeline/`, `data/`, and `requirements.txt` from all
   commits. Any stale clone must `git fetch && git reset --hard origin/main`,
   never merge/rebase old history back in. Old commits may stay reachable on
   GitHub by direct SHA until GitHub garbage-collects them (GitHub Support
   can purge sooner on request). Before force-pushing, verify the rewrite two
   ways: no stripped path anywhere in `git log --all --name-only`, and
   `git ls-tree` hashes of the kept paths identical to the original HEAD.
8. **The whole cross-repo wiring is scriptable with gh** — no web UI needed:
   `gh repo deploy-key add key.pub --allow-write` (private repo),
   `gh secret set PIPELINE_DEPLOY_KEY < key` (this repo), and
   `gh api -X PUT repos/.../pages -F build_type=workflow` to flip the Pages
   source to Actions. Deploy keys beat PATs here: repo-scoped, no expiry
   surprises, and creatable headlessly.
9. **Why this shape:** on a Free plan, making a repo private kills its Pages
   site and meters its Actions minutes — and even paid private repos serve
   Pages publicly. Hence: public site repo + private pipeline repo, workflow
   in the public one. Going private on the single repo was never an option.
10. **Keep every stat consistent with what clicking shows.** A leader card
    count that differs from the filter's result count reads as a bug; when
    the leader filter became primary-actor-only, card counts had to go and
    "LEADERS TRACKED" had to become roster size (it silently fell 58→44 by
    still counting leaders-with-primary-events).
11. **A pipeline semantics change is a two-repo change.** Reclassifications
    ship as pipeline commits, but anything the UI states about the data
    (toggle labels, stats, export columns) usually needs a matching docs/
    commit — grep app.js for the affected field before pushing the pipeline
    side. Data goes live only at the next Daily update run (trigger one
    manually with `gh workflow run "Daily update"`); docs/ changes deploy on
    push via pages.yml.
12. **In-browser .xlsx needs no library**: an xlsx is a zip of XML; stored
    (uncompressed) zip entries + a CRC32 table + inline-string sheet XML is
    ~130 lines and opens fine in Excel with CJK intact. Validate with
    Python zipfile + ElementTree, not by eyeballing.

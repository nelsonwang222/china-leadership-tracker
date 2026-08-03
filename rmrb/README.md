# People's Daily front-page archive

Append-only state for the People's Daily (人民日报) front-page scanner.

- `records.jsonl` — one raw article per line: id, paper date, page 01,
  Chinese title, article URL, full Chinese text, leader actor/mention tags,
  fetch timestamp.
- `translations.jsonl` — one cached translation per line: English title,
  English summary, model used, translation timestamp.
- `checked.json` — dates that were checked and found empty, with the check
  timestamp. Empty dates are remembered so they are not re-fetched on every
  run; today is never recorded (the 23:30 run must retry it), and checked
  dates are re-tried after 7 days (`--checked-ttl-days`).

Built site data (the actual deliverable) is generated from these files into
`docs/data/rmrb/` by `scripts/rmrb_build.py`. The files here are committed so
every daily run is incremental: articles are fetched once and translated once.
Translation supports Claude, Gemini, or DeepSeek (`DEEPSEEK_API_KEY`).

Run the scanner locally with:

    python scripts/rmrb_build.py --dry-run        # rebuild from existing records
    python scripts/rmrb_build.py --no-translate   # fetch + build, no translation

Source: People's Daily e-paper front page (paper.people.com.cn). Content is
republished for research and educational use only, in line with the site's
existing disclaimer.
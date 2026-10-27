# OSRS Dashboard

A static dashboard that parses the Old School RuneScape Wiki "Money making guide" every 2 minutes and
lets you sort and filter 530+ money-making methods. No backend required — the wiki's `api.php`
endpoint sends `Access-Control-Allow-Origin: *`.

## Features

- **Sort / filter** by hourly profit, method, skills, category, intensity and "Can do".
- **Categories** (left panel) — Collecting, Combat, Processing, Recurring, Skilling, Untradeable.
  Recurring and Untradeable are exclusive gates and off by default.
- **Skills** — icon-only toggle squares, one per skill, in in-game order. Any / All match modes.
- **My levels tab** — a grid of every skill the wiki mentions, each with a number input, in
  in-game order (Attack, Strength, Defence … Sailing, then Quest points). Combat level and total
  level are worked out from the entered levels and used only by the Can do filter. A name input
  plus a loop icon opens your OSRS hiscores page; paste the CSV response into the box below to
  auto-fill your levels.
- **Can do** filter — hides any method whose requirements exceed your entered levels. Errs
  towards showing when a level is missing.
- **Sticky top bar + header**, the table list is its own scroll region.
- Profit column uses an uppercase unit letter (`M`/`K`/`B`) spaced 1 ch from the number.

## Running

Any static host works. From the project folder:

```sh
python -m http.server 8123
```

Then open http://127.0.0.1:8123/.

## Persistence

- `osrs-mmg:state:v1` — categories, levels, skills, intensities, Can do, sort.
- `osrs-mmg:cache:v11` — parsed methods cache (bump to force a re-parse).

## Notes

- The "untradeable supplies" methods (divine potions, etc.) get a very high figure because the
  guide computes the value difference of untradeable items; treat those with suspicion.
- Rows tagged **recurring** are farming-style methods whose listed figure is the *effective*
  profit assuming you repeat them on schedule.
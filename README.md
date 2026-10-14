# OSRS Dashboard

A live viewer for the [Old School RuneScape Wiki money making guide](https://oldschool.runescape.wiki/w/Money_making_guide)
that re-fetches the page every **2 minutes** and lets you sort and filter the list.

No build step, no dependencies, no backend.

```
index.html             markup
styles.css             styling
app.js                 fetch + parse + sort + filter + render
icons/                 26 skill icons served from the wiki (~7 KB total)
assets/wiki-logo.svg   the wiki logo used in the header
tools/serve.py         static file server (optional — the page needs no backend)
tools/fetch_skill_icons.py   re-downloads icons/ when the wiki changes them
```

## Run it

Serve the folder with any static server and open the page — there is no backend to run:

```powershell
python -m http.server 8123      # then open http://127.0.0.1:8123/
```

`python tools/serve.py` does the same thing with a friendlier startup message.

## How the data is fetched

The wiki's MediaWiki API allows cross-origin requests
(`Access-Control-Allow-Origin: *`), so the page can call it straight from the browser:

```
https://oldschool.runescape.wiki/api.php
  ?action=parse&page=Money%20making%20guide&prop=text&format=json&formatversion=2
```

The returned HTML is parsed with `DOMParser`. Three tables on the page are recognised by
their header cells, so column order changes on the wiki won't break it:

| Wiki table | Recognised by | Hourly profit taken from |
|---|---|---|
| "All guides" (489 rows) | `Method · Hourly profit · … · Intensity` | `Hourly profit` |
| "Recurring methods" (34) | `Method · … · Effective profit · …` | `Effective profit` (tagged *recurring*) |
| "Untradeable supplies" (8) | same 6-column shape | cell text (no `data-sort-value`) |

Skills come from the wiki's `.scp[data-skill]` markers, which also carry the required level.
Loose text around those markers ("recommended", "for Piety", "High melee stats") is kept as a note
on the skill it follows. Their icons are saved locally in `icons/<skill>.png` (26 files, ~7 KB total)
so the list renders without hitting the wiki for images; a skill the wiki adds later falls back to
its own image URL. Re-download them with `python tools/fetch_skill_icons.py`.

## Features

- **Auto-refresh every 2 minutes** — the status bar shows a live countdown and the time of the
  last successful fetch. Polling pauses while the tab is hidden and catches up when you return.
- **Opens on highest hourly profit first.** Sort by clicking a column header — **Hourly profit** and
  **Method** are sortable. The table has four columns, left to right: Hourly profit, Method, Skills,
  Category. Each click on a sortable header advances it one step and then wraps around:
  **most → least → no sorting → most**. Method uses the same three states in the natural direction
  (A–Z → Z–A → no sorting). "No sorting" restores the order the wiki lists the methods in. The
  active header shows a gold ▲/▼ caret and carries `aria-sort`; hovering explains what the next
  click will do. Skills and Category are display-only.
- **Column sizing** — the Method and Hourly profit columns are measured at runtime to fit their
  content instead of fixed percentages: Method to the longest method name, Hourly profit to the
  widest of its header label, widest value and worst-case price-change line. Both re-measure on every
  refresh. Profit stays centred.
- **Nothing scrolls out of view** — the page itself doesn't scroll. The table list is its own
  scroll region, so the top bar, the "Showing x of y" line and the table header all stay put and
  only the rows move. Rows pass underneath the pinned header, which is opaque.
- **Search** — a plain text input to the left of the result count filters by method or category.
- **Intensity filter** — Low / Moderate / High as toggle pills at the right of the results bar
  (green / amber / red). Click to add or remove a rating; several can be active at once. Only the
  wiki's main table is rated, so the 34 recurring methods have no intensity and drop out while a
  rating is selected.
- **My levels tab** — a grid of every skill the wiki mentions, each with a number input, listed in
  the order the game uses (Attack, Strength, Defence … Sailing, then Combat level and Quest points).
  Combat level is derived for you (Attack/Defence/Strength/Hitpoints, plus 1.5 each once Ranged,
  Prayer or Magic are trained); Total and Combat are shown at the top. Levels and the
  **Can do** toggle are remembered in `localStorage`.
- **Can do filter** — a checkbox above the table that hides any method with a requirement above
  what you have entered. A skill's own stated level always wins: `Cooking 90+ (99 Recommended)`
  needs Cooking 90, not 99. Where a line only says "recommended" with no level of its own
  (`Ranged recommended`), it is still held to a bar — at least a trained level — and where the note
  itself carries the number (`Prayer 70+ recommended`) that number is the requirement. A
  requirement whose skill you haven't entered can't be judged, so it never hides anything — the list
  errs towards showing too much.
- **Filters (left panel)** — two panels, each with its own Clear button:
  - **Categories** — checkboxes for Collecting, Combat, Processing, Recurring and Skilling. Each
    covers every method in that group, so ticking Combat includes `Combat/High`, `Combat/Low` and
    `Combat/Mid`. "Recurring" is the wiki's separate table of methods you repeat (farming, brewing,
    …) rather than a value of the category column, so it selects every row carrying the *recurring*
    badge. Methods in other groups (hunter, ironman, minigame, …) are hidden while a category is
    selected and come back when nothing is.
  - **Skills** — a grid of icon-only squares, one per skill, that toggle on and off; hover or focus
    shows the name. Listed in the same in-game order as the My levels tab. "Any" matches methods
    containing at least one selected skill, "All" requires every selected skill.
  Both combine with the intensity pills, and every selection is remembered in `localStorage`.
- **Skill icons + the wiki's own layout** — the Skills column copies the wiki's line breaks exactly:
  each `<li>` / `<p>` / `<br>` in the wiki's cell becomes a line here (246 methods have more than
  one). Each line shows the wiki's icons plus the required level (`[icon] 90+`); hover a chip for the
  full "Ranged 90+". When the wiki gives several skills the same level on one line ("Attack 90+,
  Strength 90+"), they collapse into a single chip (`[⚔][🏹] 90+`) instead of repeating the level.
  Any explanation the wiki puts next to a skill is kept as muted text inside the same chip —
  "recommended", "for Piety", "(for Abyssal lantern)", "(highly recommended)" — and a line with no
  skill at all ("High melee stats") keeps its own line. Skills sharing a level but carrying different
  notes stay separate. "A party member with …" is one of those lines: it labels somebody else's
  levels rather than yours, so the phrase is broken onto its own line — preceded by a blank one to
  set that group's requirements apart — and the skills it covers go on the next line.
  Notes are assembled exactly as the wiki writes them — its text nodes are concatenated the way a
  browser reads `textContent`, so nothing is re-spaced and nothing is lost: `Song of the Elves'`
  keeps its apostrophe, `the spell "Humidify"` keeps its quotes tight, and an internal comma
  survives. Only three things are tidied: the separators the wiki puts between skill chips (`", "`
  at either end), padding inside brackets (`"( recommended)"` → `"(recommended)"`), and a note left
  with no letters or digits in it, which is dropped rather than shown as a bare `"`.
- **Profit formatting** — `14.9M`, `618K`, `1.5B`, with the unit letter in upper case set one
  character-width away from the number and no trailing `.0`. The exact value is in the row's tooltip.
- **Price deltas** — when a method's hourly profit changes between refreshes, the change and
  percentage show under the profit. The previous snapshot is kept in `localStorage`, so deltas
  still work after a reload.
- Sort column, direction, skill selection, category selection and skill mode are remembered in
  `localStorage` ("no sorting" is deliberately not remembered — the page always reopens on
  highest profit).
- Last good result is cached in `localStorage`; if the wiki is unreachable the page keeps showing
  it with a warning banner instead of going blank.

## Notes

- Roughly 530 methods are listed, which is every row across the three tables above.
- Profits are the wiki's own Grand Exchange estimates, not live exchange data — the wiki itself
  notes they can be off, and the guide caches its own prices. Treat them as a guide.
- Rows tagged **recurring** are farming-style methods whose listed figure is the *effective*
  hourly profit (what you'd earn per hour if you ran them back to back), which is usually
  higher than a normal session rate.
- The "untradeable supplies" methods (divine potions, etc.) get a very high figure because the
  guide computes the value difference of untradeable items; treat those with suspicion.
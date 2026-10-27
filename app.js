/* =====================================================================
   OSRS Money Making Guide — live viewer
   Polls the Old School RuneScape wiki every 2 minutes (the wiki's MediaWiki
   API sends `Access-Control-Allow-Origin: *`, so no backend is needed).
   ===================================================================== */

const API_URL   = 'https://oldschool.runescape.wiki/api.php';
const WIKI_BASE = 'https://oldschool.runescape.wiki';
const PAGE      = 'Money making guide';
const REFRESH_MS = 2 * 60 * 1000;

const STATE_KEY = 'osrs-mmg:state:v1';
const CACHE_KEY = 'osrs-mmg:cache:v11';  // v11: hiscores paste-fill helper added

const INTENSITY_RANK = { low: 1, moderate: 2, medium: 2, high: 3 };
const PSEUDO_SKILLS  = ['combat level', 'quest points', 'total level'];

// The skills in the order Old School RuneScape lists them (the hiscores order).
// Anything not in it — Combat level, Quest points — sorts to the end.
const SKILL_ORDER = [
  'attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer', 'magic',
  'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing',
  'mining', 'herblore', 'agility', 'thieving', 'slayer', 'farming', 'runecraft', 'hunter',
  'construction', 'sailing',
];

const skillSort = (a, b) => {
  const pa = PSEUDO_SKILLS.includes(a), pb = PSEUDO_SKILLS.includes(b);
  if (pa !== pb) return pa ? 1 : -1;
  const ia = SKILL_ORDER.indexOf(a);
  const ib = SKILL_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
};
// {{SCP}} markers that aren't (filterable) skills — except the ones that are "Total level"
// markers the money guide writes as the pseudo-skill "Skills ... Total level"; those are
// promoted to the pseudo-skill "total level" further down instead of dropped.
const NOT_A_SKILL    = new Set(['skills']);

// sortable columns -> the direction each one starts in when you first click it
const SORT_COLUMNS = {
  profit: { label: 'Hourly profit', dir: 'desc' },
  method: { label: 'Method',         dir: 'asc'  },
};

// Skill icons live in icons/<skill-key>.png (see tools/fetch_skill_icons.py). Anything
// the wiki adds later falls back to its own image URL.
const LOCAL_ICONS = new Set([
  'agility', 'attack', 'combat level', 'construction', 'cooking', 'crafting', 'defence',
  'farming', 'firemaking', 'fishing', 'fletching', 'herblore', 'hitpoints', 'hunter',
  'magic', 'mining', 'prayer', 'quest points', 'ranged', 'runecraft', 'sailing', 'slayer',
  'smithing', 'strength', 'thieving', 'woodcutting',
]);

const iconFor = (key, wikiSrc) =>
  LOCAL_ICONS.has(key) ? `icons/${key.replace(/\s+/g, '-')}.png` : absoluteUrl(wikiSrc);

/* ---------------------------------------------------------------- state */
const state = {
  methods: [],        // parsed GP making methods
  profits: new Map(), // method name -> hourly profit from the last successful fetch
  previous: new Map(), // method name -> hourly profit from the fetch before (delta baseline)
  sort: 'profit',
  dir: 'desc',
  skills: new Set(),
  categories: new Set(),
  categoriesChosen: false,   // the user has touched the category boxes; drop the opening default
  intensities: new Set(),
  levels: {},           // skill key -> level the player typed in the My levels tab
  canDoOnly: false,     // hide methods that need more than those levels
  skillMode: 'any',
  query: '',
  lastUpdate: null,
  nextUpdate: null,
  busy: false,
  pending: false,   // last refresh failed
  error: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  tbody: $('tbody'), count: $('resultCount'), banner: $('banner'),
  statusText: $('statusText'), statusDot: $('statusDot'), refreshBtn: $('refreshBtn'),
  skillList: $('skillList'), clearSkills: $('clearSkills'),
  categoryList: $('categoryList'), clearCategories: $('clearCategories'),
  intensityFilters: $('intensityFilters'),
  methodSearch: $('methodSearch'),
  tabMakers: $('tabMakers'), tabLevels: $('tabLevels'),
  panelMakers: $('panelMakers'), panelLevels: $('panelLevels'),
  levelGrid: $('levelGrid'),
  hiscoreName: $('hiscoreName'), hiscoreLink: $('hiscoreLink'),
  hiscoreFill: $('hiscoreFill'),
  hiscoreStatus: $('hiscoreStatus'),
  clearLevels: $('clearLevels'), canDoOnly: $('canDoOnly'), canDoLabel: $('canDoLabel'),
};

/* ---------------------------------------------------------------- fetch */
async function fetchGuideHtml() {
  const url = `${API_URL}?action=parse&page=${encodeURIComponent(PAGE)}` +
              `&prop=text&format=json&formatversion=2&redirects=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wiki API returned HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || 'Wiki API error');
  return data.parse.text;
}

/* ---------------------------------------------------------------- parse */
const slugHeader = (text) => text.toLowerCase().replace(/[^a-z]/g, '');

/** The wiki's "Untradeable supplies" table sits under its own heading and is the only
 *  money-making table with no caption, so both are checked: the heading is the strong
 *  signal and the missing caption covers the wiki renaming or moving the section. */
function isUntradeableTable(table) {
  if (table.querySelector('caption')) return false;
  for (let n = table.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList && n.classList.contains('mw-heading')) return /untradeable/i.test(n.textContent);
    if (n.tagName === 'P') return /untradeable supplies/i.test(n.textContent);
  }
  return false;
}

/** Reads one money-making table into an index map, or null if it isn't one. */
function schemaFor(headers, table) {
  const has = (n) => headers.indexOf(n) !== -1;
  if (has('method') && has('hourlyprofit') && has('intensity')) {
    return {
      method: 0,
      profit: headers.indexOf('hourlyprofit'),
      skills: headers.indexOf('skills'),
      category: headers.indexOf('category'),
      intensity: headers.indexOf('intensity'),
      recurring: false,
      untradeable: table ? isUntradeableTable(table) : false,
    };
  }
  if (has('method') && has('effectiveprofit')) {
    return {
      method: 0,
      profit: headers.indexOf('effectiveprofit'),
      skills: headers.indexOf('skills'),
      category: headers.indexOf('category'),
      intensity: -1,
      recurring: true,
      untradeable: false,
    };
  }
  return null;
}

function cellAt(row, i) { return i >= 0 && i < row.children.length ? row.children[i] : null; }
const textOf = (cell) => (cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '');

/** Turns a wiki-relative src/href into something this page can load. */
function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  return /^https?:/i.test(url) ? url : WIKI_BASE + url;
}

function numberOf(cell) {
  if (!cell) return null;
  const raw = cell.getAttribute('data-sort-value');
  if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  const m = textOf(cell).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Tidies one run of loose wiki text. The caller hands over the line's text nodes already
 *  concatenated, so the spacing here is the wiki's own and nothing is invented; then:
 *  " , " -> "", ", recommended" -> "recommended", "( Protect from Melee )" -> "(Protect from
 *  Melee)", "None" -> "". Text left with no letters or digits in it is dropped rather than
 *  shown, so a stray quote or separator never renders on its own. */
function cleanNote(text) {
  const tidy = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,;\s]+/, '')
    .replace(/[,;\s]+$/, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
  if (!tidy || /^none$/i.test(tidy) || !/[\p{L}\p{N}]/u.test(tidy)) return '';
  return tidy;
}

// The wiki breaks the skills cell into lines with list items, paragraphs and <br>.
const LINE_BREAKS = new Set(['LI', 'P', 'DIV', 'UL', 'OL', 'BR']);
// "A party member with …" labels the skills that follow it (someone else's levels,
// not yours), so it gets its own line instead of becoming a note on the last skill.
const PARTY_MEMBER = /\ba\s+party\s+member\s+with\b/i;

/** Reads a skills cell: the {{SCP}} skill markers plus any loose explanation the
 *  wiki adds around them ("recommended", "for Piety", "High melee stats 43+ …").
 *  Loose text is attached to the skill it follows; a cell with no skills keeps it
 *  as a standalone note. Line breaks are copied from the wiki's own markup, and
 *  runs of skills sharing one level collapse into a single chip. */
function skillsOf(cell) {
  const result = { skills: [], lines: [] };
  if (!cell) return result;

  let cur = [];       // skills on the line being read
  let pending = [];   // loose text seen since the last skill

  // A wiki line is one <li>/<p>/<br> group. Its loose text is a note on the last
  // skill; a line with no skill at all (e.g. "High melee stats") keeps its own line.
  const closeLine = () => {
    // Drop connector-only pieces ("or", "and", ",") so they don't glue themselves to
    // the following chip as notes — these are joiners between skill groups, not notes.
    const kept = pending.filter((frag) => {
      const core = cleanNote(frag).replace(/[.,;:()\-–—]/g, '').trim().toLowerCase();
      if (!core) return false;
      return !(core === 'and' || core === 'or' || core === 'nor' || core === 'plus' || core === 'and/or');
    });
    // The kept pieces are joined with nothing: the wiki's own spaces stay in them, and
    // adding more would split "Elves'" or push a quote to '" Humidify"'.
    const text = cleanNote(kept.join(''));
    pending = [];
    if (cur.length) {
      const last = cur[cur.length - 1];
      if (text) last.note = last.note ? `${last.note} ${text}` : text;
      result.lines.push(groupSkills(cur));   // merge same-level runs on this line
      cur = [];
    } else if (text) {
      result.lines.push([{ icons: [], names: [], level: '', note: text }]);
    }
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.parentElement.closest('.scp')) continue;
        const text = child.nodeValue;
        const at = text.search(PARTY_MEMBER);
        if (at === -1) { pending.push(text); continue; }
        if (at > 0) pending.push(text.slice(0, at));     // anything before it stays on this line
        closeLine();                                    // …then the phrase opens a line of its own
        result.lines.push([]);                          // blank line, to set the group apart
        result.lines.push([{ icons: [], names: [], level: '', note: cleanNote(text.slice(at)) }]);
        continue;                                       // the skills after it form the next line
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (child.tagName === 'A' && child.getAttribute('href')) {
        const hr = child.getAttribute('href');
        const url = hr.startsWith('http') ? hr : 'https://oldschool.runescape.wiki' + (hr.startsWith('/') ? hr : '/' + hr);
        pending.push('\ue000' + url + '\ue001' + child.textContent + '\ue002');
        continue;
      }
      if (child.classList.contains('scp')) {
        const name = child.getAttribute('data-skill');
        const key = name ? name.toLowerCase() : '';
        // any connectors loose in pending ("and" / "or" between skill chips) become
        // their own token instead of glueing themselves on to the next chip:
        const CONN_SET = new Set(['and', 'or', 'nor', 'plus', 'and/or', ',']);
        const connectorTok = pending.map(cleanNote).filter((t) => CONN_SET.has((t || '').trim().toLowerCase()));
        for (const c of connectorTok) cur.push({ icons: [], names: [], level: '', note: c, conjunction: true });
        pending = pending.filter((frag) => !CONN_SET.has(((cleanNote(frag) || '').trim().toLowerCase())));
        const isTotalLevel = key === 'skills' &&
          (/total level/i.test(child.getAttribute('data-level') || '') ||
           /total level/i.test(child.textContent || ''));
        if (isTotalLevel || (name && !NOT_A_SKILL.has(key))) {
          // some data-level values leak wiki markup, e.g. "750+ [[Total level]]"
          const level = (child.getAttribute('data-level') || '').replace(/\[\[[^\]]*\]\]/g, '').trim();
          const img = child.querySelector('img[src]');
          const effectiveKey   = isTotalLevel ? 'total level' : key;
          const effectiveName  = isTotalLevel ? 'Total level'  : name;
          const anchor = child.querySelector('a[href]');
          const href = anchor ? anchor.getAttribute('href')
                              : (effectiveName ? '/w/' + effectiveName.replace(/ /g, '_') : '');
          const fullLink = href
            ? (href.startsWith('http') ? href
                                       : 'https://oldschool.runescape.wiki' + (href.startsWith('/') ? href : '/' + href))
            : '';
          const skill = { name: effectiveName, level, key: effectiveKey,
                          icon: iconFor(effectiveKey, img ? img.getAttribute('src') : null),
                          link: fullLink, note: '' };
          result.skills.push(skill);
          cur.push(skill);
        } else if (name) {
          // any other non-skill marker: carry its written text forward as a loose note
          const loose = (child.textContent || '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\s+/g, ' ').trim();
          if (loose) pending.push(loose);
        }
        continue;
      }

      const isBreak = LINE_BREAKS.has(child.tagName);
      if (isBreak) closeLine();
      if (child.tagName !== 'BR') walk(child);
      if (isBreak) closeLine();
    }
  };

  walk(cell);
  closeLine();
  return result;
}

/** Collapses neighbouring skills that share one level into a single display chip. */
function groupSkills(skills) {
  // Connector tokens ("and" / "or") are punctuation, not requirements: they carry no
  // skill and must never inherit a level, or they'd be judged as one.
  const realSkills = (skills || []).filter((s) => s && !s.conjunction);

  // Skills without an explicit level are grouped into the chip of the first skill in
  // that run that carries a level (including one that appears after them).
  let __previousLevel = "";
  const __pendingBlanks = [];
  for (const s of realSkills) {
    if (s.level) __previousLevel = s.level;
    else { __pendingBlanks.push(s); continue; }
    for (const b of __pendingBlanks) if (b) b.level = s.level;
    __pendingBlanks.length = 0;
  }
  for (const b of __pendingBlanks) if (b && !b.level && __previousLevel) b.level = __previousLevel;

  const groups = [];
  for (const s of (skills || [])) {
    if (s && s.conjunction) {
      groups.push({ icons: [], names: [], level: '', note: s.note, conjunction: true });
      continue;
    }
    const prev = groups[groups.length - 1];
    if (prev && !prev.conjunction && s.level && prev.level === s.level && prev.note === s.note) {
      prev.icons.push({ icon: s.icon, name: s.name, link: s.link || "" });
      prev.names.push(s.name);
    } else {
      groups.push({ icons: [{ icon: s.icon, name: s.name, link: s.link || "" }], names: [s.name], level: s.level, note: s.note,
                    conjunction: false });
    }
  }
  return groups;
}

/** Display groups for a method, tolerating rows cached before grouping existed. */
function skillGroupsOf(method) {
  if (method.skillGroups) return method.skillGroups;
  return method.skills.map((s) => ({ icons: [{ icon: s.icon, name: s.name }], names: [s.name], level: s.level, note: s.note }));
}

/** Display lines for a method, tolerating rows cached before lines were kept. */
function skillLinesOf(method) {
  if (method.skillLines) return method.skillLines;
  return [skillGroupsOf(method)];
}

function parseMethods(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = new Map();

  for (const table of doc.querySelectorAll('table')) {
    const headRow = table.tHead ? table.tHead.rows[0] : table.querySelector('tr');
    if (!headRow) continue;
    const headers = Array.from(headRow.cells).map((c) => slugHeader(c.textContent));
    const schema = schemaFor(headers, table);
    if (!schema) continue;

    for (const row of table.rows) {
      if (row === headRow || row.querySelector('th')) continue;
      if (row.children.length !== headers.length) continue; // guard against misaligned rows

      const methodCell = cellAt(row, schema.method);
      const link = methodCell ? methodCell.querySelector('a[href*="/w/"]') : null;
      const name = link ? link.textContent.trim() : textOf(methodCell);
      if (!name || found.has(name)) continue;

      const intensityText = textOf(cellAt(row, schema.intensity)).toLowerCase();
      const { skills, lines } = skillsOf(cellAt(row, schema.skills));

      found.set(name, {
        name,
        url: absoluteUrl(link ? link.getAttribute('href') : null),
        profit: numberOf(cellAt(row, schema.profit)),
        skills,
        skillLines: lines,
        category: textOf(cellAt(row, schema.category)),
        intensity: INTENSITY_RANK[intensityText] || 0,
        recurring: schema.recurring,
        untradeable: !!schema.untradeable,
      });
    }
  }
  return [...found.values()].map((m, order) => ({ ...m, order }));
}

/* ------------------------------------------------------------- filtering */
/** "Combat/High" -> ["Combat", "High"], "Farming (Herb)" -> ["Farming", "Herb"],
 *  "Skilling/Fishing, Hunter" -> ["Skilling", "Fishing, Hunter"], "" -> ["Other", ""] */
function splitCategory(raw) {
  const text = (raw || '').trim();
  if (!text) return ['Other', ''];
  const slash = text.indexOf('/');
  if (slash !== -1) return [text.slice(0, slash).trim(), text.slice(slash + 1).trim()];
  const paren = text.indexOf(' (');
  if (paren !== -1) return [text.slice(0, paren).trim(), text.slice(paren + 2).replace(/\)$/, '').trim()];
  return [text, ''];
}

// The only category groups offered as filters; methods outside them (an Ironman-only
// method, say) are hidden while any group is ticked.
const CATEGORY_GROUPS = ['Collecting', 'Combat', 'Processing', 'Recurring', 'Skilling', 'Untradeable'];

// Groups that name a separate wiki table rather than a value of the category column,
// so they are matched by a flag on the method instead of by its category text.
const TAG_CATEGORIES = { Recurring: 'recurring', Untradeable: 'untradeable' };

/** "Recurring" and "Untradeable" are not values of the category column — they are the
 *  wiki's separate tables of repeatable methods and of methods that burn untradeable
 *  supplies. Each is an exclusive gate: a tagged method answers to its own box and to
 *  nothing else. Otherwise unticking Recurring still left the handful of recurring
 *  methods whose own column happens to read Collecting/Processing on screen. */
function matchesCategory(method, key) {
  const flag = TAG_CATEGORIES[key];
  if (flag && method[flag]) return true;
  if (method.recurring || method.untradeable) return false;   // the other boxes don't claim it
  return splitCategory(method.category)[0] === key;
}

/** the groups above that actually occur in the data */
function categoryTree() {
  const present = new Set(state.methods.map((m) => splitCategory(m.category)[0]));
  return CATEGORY_GROUPS.filter((name) => {
    const flag = TAG_CATEGORIES[name];
    return flag ? state.methods.some((m) => m[flag]) : present.has(name);
  });
}

/** What the page opens on: every group ticked except Recurring and Untradeable, so the
 *  repeatable methods and the untradeable-supply ones stay out of the way until asked. */
function defaultCategories() {
  return new Set(categoryTree().filter((name) => !TAG_CATEGORIES[name]));
}

/** skill key -> icon url (the first one seen; every skill uses a single icon) */
function skillIcons() {
  const map = new Map();
  for (const m of state.methods) {
    for (const s of m.skills) if (s.icon && !map.has(s.key)) map.set(s.key, s.icon);
  }
  return map;
}

/** every skill that appears in the data, in no particular order */
const SKILL_NAMES = () => {
  const names = new Set();
  for (const m of state.methods) for (const s of m.skills) names.add(s.key);
  return names;
};

function visibleMethods() {
  const q = state.query.trim().toLowerCase();
  const wanted = [...state.skills];
  const cats = [...state.categories];
  const levels = [...state.intensities];

  let list = state.methods.filter((m) => {
    if (q && !(m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q))) return false;
    if (cats.length && !cats.some((key) => matchesCategory(m, key))) return false;
    if (levels.length && !levels.includes(m.intensity)) return false;
    if (state.canDoOnly && !canDo(m)) return false;
    if (!wanted.length) return true;
    const keys = (m.skills || []).map((s) => s.key);
    return state.skillMode === 'all'
      ? wanted.every((s) => keys.includes(s))
      : wanted.some((s) => keys.includes(s));
  });

  const byProfit = (a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity);
  const byWikiOrder = (a, b) => a.order - b.order;
  const sign = state.dir === 'desc' ? 1 : -1;

  // no active sort column -> leave the list in the order the wiki lists it
  if (!state.sort) return list;

  list.sort((a, b) => {
    let r = 0;
    if (state.sort === 'profit') r = (a.profit ?? -Infinity) - (b.profit ?? -Infinity);
    else r = a.name.localeCompare(b.name);
    return r * -sign || byProfit(a, b) || byWikiOrder(a, b);
  });

  return list;
}

/* --------------------------------------------------------------- render */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "14.0" -> "14", "1.50" -> "1.5", "14.9" -> "14.9". Integers are left alone
 *  (a naive trailing-zero strip would turn "10" into "1"). */
const trimZeros = (text) =>
  (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

/** Splits a profit into number and uppercase unit: 14000000 -> { num: '14', unit: 'M' } */
function profitParts(n) {
  if (n === null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return { num: trimZeros((n / 1e9).toFixed(2)), unit: 'B' };
  if (abs >= 1e6) return { num: trimZeros((n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)), unit: 'M' };
  if (abs >= 1e3) return { num: String(Math.round(n / 1e3)), unit: 'K' };
  return { num: String(Math.round(n)), unit: '' };
}

/** The unit letter is upper case and sits one character-width away from the number
 *  (.profit__unit gets a 1ch margin), so "14.9 M" reads as a number and a unit. */
function profitHtml(n) {
  const parts = profitParts(n);
  if (!parts) return '&mdash;';
  return esc(parts.num) + (parts.unit ? `<span class="profit__unit">${parts.unit}</span>` : '');
}

/** Widest number and unit in the data, by character count. */
function widestProfit() {
  let num = '';
  let unit = '';
  for (const m of state.methods) {
    const parts = profitParts(m.profit);
    if (!parts) continue;
    if (parts.num.length > num.length) num = parts.num;
    if (parts.unit.length > unit.length) unit = parts.unit;
  }
  return { num, unit };
}

/** One chip per group: its icons, then the shared level, then the wiki's note.
 *  A line with no skill at all renders as a plain note, like on the wiki. */
function noteHtml(text) {
  const s = String(text || '');
  let out = '';
  let last = 0;
  const re = /\ue000([^\ue001]+)\ue001([^\ue002]+)\ue002/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index));
    out += '<a class="skilllink" href="' + esc(m[1]) + '" target="_blank" rel="noopener">' + esc(m[2]) + '</a>';
    last = m.index + m[0].length;
  }
  out += esc(s.slice(last));
  return out;
}
function skillChip(group) {
  if (group.conjunction) {
    return `<span class="skillconn" aria-hidden="true">${noteHtml(group.note)}</span>`;
  }
  const label = [...group.names, group.level, String(group.note || '').replace(/\ue000[^\ue002]*\ue002/g, '')].filter(Boolean).join(' ');
  if (!group.icons.length) return `<span class="skillnote">${noteHtml(group.note)}</span>`;
  const glyphs = group.icons.map(({ icon, name, link }) => {
    const html = icon ? `<img class="skillicon" src="${esc(icon)}" alt="${esc(name)}" decoding="async" />`
                    : `<span class="skillchip__text">${esc(name.slice(0, 2))}</span>`;
    return link ? `<a class="skilllink" href="${esc(link)}" target="_blank" rel="noopener">${html}</a>` : html;
  }).join('');
  return `<span class="skillchip" title="${esc(label)}">${glyphs}` +
         `${group.level ? `<b>${esc(group.level)}</b>` : ''}` +
         `${group.note ? `<i>${noteHtml(group.note)}</i>` : ''}</span>`;
}

function renderRows() {
  const list = visibleMethods();

  if (!state.methods.length) {
    el.tbody.innerHTML = `<tr class="empty"><td colspan="4">${state.error
      ? esc(state.error) + ' — hit Refresh to try again.'
      : 'No data yet.'}</td></tr>`;
    el.count.textContent = '';
    return;
  }
  if (!list.length) {
    el.tbody.innerHTML = '<tr class="empty"><td colspan="4">No GP making methods match these filters.</td></tr>';
  } else {
    const html = list.map((m) => {
      const prev = state.previous.get(m.name);
      let delta = '';
      if (prev !== undefined && m.profit !== null && Number.isFinite(prev) && prev !== m.profit) {
        const d = m.profit - prev;
        const pct = prev ? (d / Math.abs(prev)) * 100 : 0;
        delta = `<span class="delta delta--${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ` +
                `${profitHtml(Math.abs(d))} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)</span>`;
      }

      const skills = skillLinesOf(m).map((line) => {
        const spacer = line.length === 0 ? ' skillline--spacer' : '';
        return `<div class="skillline${spacer}">${line.map(skillChip).join('')}</div>`;
      }).join('');
      const profitCls = m.profit === null ? '' : (m.profit < 0 ? 'profit--neg' : 'profit--pos');
      const profitTitle = m.profit === null ? '' : ` title="${m.profit.toLocaleString()} gp/hr"`;

      return `<tr${m.recurring ? ' class="row--recurring"' : ''}>` +
        `<td class="col-profit"><span class="profit ${profitCls}"${profitTitle}>${profitHtml(m.profit)}</span>${delta}</td>` +
        `<td class="col-method"><a class="method" href="${m.url || '#'}" target="_blank" rel="noopener noreferrer"` +
          `${m.url ? ` title="${esc(m.name)}"` : ''}><span class="method__name">${esc(m.name)}</span></a></td>` +
        `<td class="col-skills"><div class="skillchips">${skills || '&mdash;'}</div></td>` +
        `<td class="col-category"><span class="cat">${esc(m.category) || '&mdash;'}</span></td>` +
      `</tr>`;
    }).join('');
    el.tbody.innerHTML = html;
  }

  const total = state.methods.length;
  el.count.innerHTML = `Showing <b>${list.length}</b> of <b>${total}</b> GP making methods`;
}

/** Icon-only toggle squares: one per skill, `aria-pressed` carries the on/off state. */
function renderSkills() {
  const present = SKILL_NAMES();
  const icons = skillIcons();

  const names = [...present].sort(skillSort);

  el.skillList.innerHTML = names.map((n) => {
    const label = n.replace(/\b\w/g, (c) => c.toUpperCase());
    const icon = icons.get(n);
    const glyph = icon
      ? `<img class="skillicon" src="${esc(icon)}" alt="" decoding="async" />`
      : `<span class="skilltoggle__text">${esc(label.slice(0, 2))}</span>`;
    return `<button type="button" class="skill-toggle" value="${esc(n)}" ` +
           `aria-pressed="${state.skills.has(n)}" title="${esc(label)}" aria-label="${esc(label)}">` +
           `${glyph}</button>`;
  }).join('');
}

/** Widest method name in the data, by character count. */
function longestMethodName() {
  let longest = '';
  for (const m of state.methods) if (m.name.length > longest.length) longest = m.name;
  return longest;
}

const setVar = (name, value) => document.documentElement.style.setProperty(name, value);

/** Renders `text` inside `host` with that element's own font and returns its width.
 *  The probe is out of flow, so measuring never disturbs the layout. */
function measureText(host, extraClass, text) {
  if (!host || !text) return 0;
  const probe = document.createElement('span');
  probe.className = `col-probe ${extraClass || ''}`.trim();
  probe.textContent = text;
  host.appendChild(probe);
  const width = Math.ceil(probe.getBoundingClientRect().width);
  probe.remove();
  return width;
}

/** Sizes the Method and Hourly profit columns to their content instead of fixed
 *  percentages. For profit that means the widest of: the header label, the widest
 *  value, and a worst-case price-change line. Re-measured on every refresh. */
function syncColumnWidths() {
  if (!state.methods.length) return;
  const CELL_PADDING = 20;

  const methodCell = document.querySelector('#tbody td.col-method');
  const method = measureText(methodCell, '', longestMethodName());
  if (method) setVar('--method-col', `${method + CELL_PADDING}px`);

  const profitHead = document.querySelector('.mmg thead th.col-profit .sort-btn');
  const profitCell = document.querySelector('#tbody td.col-profit');
  if (profitHead && profitCell) {
    const caret = profitHead.querySelector('.caret');
    const caretW = caret ? Math.ceil(caret.getBoundingClientRect().width) + 12 : 0;  // caret + gaps
    const label = measureText(profitHead, '', 'Hourly profit') + caretW;

    // widest value: number + the 1ch gap + the unit letter
    const widest = widestProfit();
    const ch = measureText(profitCell, 'profit', '0');
    const value = measureText(profitCell, 'profit', widest.num) +
                  (widest.unit ? ch + measureText(profitCell, 'profit', widest.unit) : 0);
    const delta = measureText(profitCell, 'delta', '▼ 14.9 M (-100.0%)');          // worst case
    const width = Math.max(label, value, delta);
    if (width) setVar('--profit-col', `${width + CELL_PADDING}px`);
  }
}

/* ------------------------------------------------------------ my levels */
/** A requirement's level from strings like "90+", "99", "43+"; null when unknown. */
function levelNeeded(text) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

/** OSRS combat level from the levels entered: 1.3 + the four melee-ish skills / 3,
 *  plus a flat 1.5 for each of ranged / prayer / magic once trained. */
function combatLevelOf(levels) {
  const four = ['attack', 'defence', 'strength', 'hitpoints']
    .reduce((sum, key) => sum + (levels[key] || 0), 0);
  let base = 1.3 + four / 3;
  for (const key of ['ranged', 'prayer', 'magic']) if ((levels[key] || 0) > 0) base += 1.5;
  return Math.floor(base);
}

function totalLevelOf(levels) {
  return SKILL_ORDER.reduce((sum, key) => sum + (levels[key] || 0), 0);
}

const hasLevels = () => Object.values(state.levels).some((v) => Number.isFinite(v));

/** Every skill the wiki mentions, in game order, with the icon to show next to it. */
function levelRows() {
  const icons = skillIcons();
  return [...SKILL_NAMES()].sort(skillSort).map((key) => ({
    key,
    icon: icons.get(key),
    label: key.replace(/\b\w/g, (c) => c.toUpperCase()),
    derived: key === 'combat level' || key === 'total level',        // worked out, not typed
  }));
}

/** Builds the grid, but only when the set of skills actually changed — rebuilding it
 *  while someone is typing would knock the focus out of their input. */
function buildLevelGrid(force) {
  const rows = levelRows();
  const signature = rows.map((r) => r.key).join(',');
  if (!force && signature === el.levelGrid.dataset.signature) {
    syncLevelReadouts();
    return;
  }
  el.levelGrid.dataset.signature = signature;

  // Combat level and Total level are worked out from the real skills rather
  // than typed, so they get no rows of their own — the Can do filter judges
  // requirements against them behind the scenes.
  el.levelGrid.innerHTML = rows.filter((row) => !row.derived).map((row) => {
    const icon = row.icon
      ? `<img class="level-row__icon" src="${esc(row.icon)}" alt="" decoding="async" />`
      : '';
    const value = state.levels[row.key];
    // Rows are icon + input only. Quest points is the one exception: it keeps a
    // visible label, so it gets a wider row to fit it. Everywhere else the name
    // lives in the input's aria-label and in the row's hover title.
    const isQuestPoints = row.key === 'quest points';
    const label = isQuestPoints
      ? `<label class="level-row__name" for="lvl-${esc(row.key)}">${esc(row.label)}</label>`
      : '';
    return `<div class="level-row${isQuestPoints ? ' level-row--quest' : ''}"` +
           `${isQuestPoints ? '' : ` title="${esc(row.label)}"`}>` +
           `${icon}${label}` +
           `<input id="lvl-${esc(row.key)}" type="text" inputmode="numeric" placeholder="–" maxlength="3" ` +
           `aria-label="${esc(row.label)} level" value="${value === undefined ? '' : esc(value)}" /></div>`;
  }).join('');

  syncLevelReadouts();
}

/** The Can do toggle — safe to call while typing. */
function syncLevelReadouts() {
  // the filter is only meaningful once something has been entered
  el.canDoOnly.checked = state.canDoOnly;
  el.canDoOnly.disabled = !hasLevels();
  el.canDoLabel.title = hasLevels()
    ? 'Hide anything above your levels'
    : 'Enter your levels in the My levels tab first';
}

/** Hiscores CSV -> level inputs. The OSRS hiscores lite response is one CSV line per
 *  skill in a fixed order: Overall first, then the 24 skills, then boss kills and
 *  other stats. We only consume the skill lines. */
function applyHiscoresLevels(levels) {
  for (const [key, value] of Object.entries(levels)) state.levels[key] = value;
  buildLevelGrid(true);
  saveState();
  renderRows();
}

function renderCategories() {
  const names = categoryTree();

  el.categoryList.innerHTML = names.length
    ? names.map((name) => `<label class="cat-row toggle">` +
        `<input type="checkbox" value="${esc(name)}"${state.categories.has(name) ? ' checked' : ''} />` +
        `<span class="toggle__box" aria-hidden="true"></span>` +
        `<span class="name">${esc(name)}</span></label>`).join('')
    : '<div class="none">No categories found.</div>';
}

/** The level a note actually demands. A note like "90+ (99 Recommended)" has a hard
 *  requirement (90) *and* a recommendation (99) — only the hard one counts here. A note
 *  that only recommends a skill ("recommended", "highly recommended", "or and
 *  recommended.") is held to the same bar, so it asks for a trained level: 1.
 *  Returns null when the note has nothing to do with being recommended. */
function noteRequirement(note) {
  const text = note || '';
  if (!/recommend/i.test(text)) return null;
  const withoutRecommendation = text.replace(/\(?\s*\d{1,3}\s*\+?\s*recommended\.?\s*\)?/gi, ' ');
  const hard = levelNeeded(withoutRecommendation);
  if (hard !== null) return hard;
  const numbers = text.match(/\d{1,3}/g);
  return numbers ? Math.min(...numbers.map(Number)) : 1;
}

/** True when nothing in the method's requirements is beyond the levels entered.
 *  A requirement's own level wins; failing that a "recommended" note counts too, so a
 *  skill the wiki says you should have is held to the same standard as one it insists
 *  on. A requirement whose skill has no level entered cannot be judged, so it never
 *  hides a method — the list errs towards showing too much. */
function canDo(method) {
  // 'total level' is computed, so it must only ever JUDGE a method when every one of
  // the 24 real skills is filled in — otherwise the partial sum would wrongly hide
  // almost everything. Err towards showing (the established rule for unknown levels).
  const levels = { ...state.levels, 'combat level': combatLevelOf(state.levels) };
  const allEntered = SKILL_ORDER.every((k) => state.levels[k] !== undefined);
  if (allEntered) levels['total level'] = totalLevelOf(state.levels);
  for (const line of skillLinesOf(method)) {
    for (const group of line) {
      if (!group || group.conjunction) continue;    // "and" / "or" is punctuation
      if (!group.icons || !group.icons.length) continue;   // plain note line, not a requirement
      const need = levelNeeded(group.level) ?? noteRequirement(group.note);
      if (need === null) continue;                  // nothing stated and nothing recommended
      for (const name of (group.names || [])) {
        if (typeof name !== 'string' || !name) continue;
        const have = levels[name.toLowerCase()];
        if (have !== undefined && have < need) return false;
      }
    }
  }
  return true;
}

/** Low / Moderate / High pills in the results bar; the pressed state is the filter. */
function syncIntensityPills() {
  for (const pill of el.intensityFilters.querySelectorAll('.pill')) {
    pill.setAttribute('aria-pressed', String(state.intensities.has(Number(pill.dataset.rank))));
  }
}

function renderStatus() {
  const dot = el.statusDot;
  let text;

  if (state.busy) {
    dot.dataset.status = 'loading';
    text = 'Fetching from wiki…';
  } else if (state.pending) {
    dot.dataset.status = 'error';
    text = `Refresh failed${state.lastUpdate ? ` · cached data from ${formatTime(state.lastUpdate)}` : ''}` +
            ` · retrying in ${formatCountdown(state.nextUpdate)}`;
  } else if (state.lastUpdate) {
    dot.dataset.status = 'ok';
    text = `updated ${formatTime(state.lastUpdate)} · next refresh in ${formatCountdown(state.nextUpdate)}`;
  } else {
    dot.dataset.status = 'idle';
    text = 'Waiting for first update…';
  }

  el.statusText.textContent = text;
}

const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function formatCountdown(ts) {
  if (!ts) return '--:--';
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  renderCategories();
  syncIntensityPills();
  buildLevelGrid();
  renderSkills();
  renderRows();
  renderStatus();
  syncColumnWidths();
}

/* -------------------------------------------------------------- refresh */
async function refresh() {
  if (state.busy) return;
  state.busy = true;
  state.pending = false;
  renderStatus();

  try {
    const html = await fetchGuideHtml();
    const methods = parseMethods(html);
    if (!methods.length) throw new Error('No money making methods found in the page');

    state.previous = state.profits;
    state.profits = new Map(methods.map((m) => [m.name, m.profit]));
    state.methods = methods;
    // the groups can only be listed once the page has been parsed, so the opening
    // default lands here; it is re-applied on every refresh until the user chooses
    if (!state.categoriesChosen || !state.categories.size) state.categories = defaultCategories();
    state.lastUpdate = Date.now();
    state.busy = false;
    state.pending = false;
    state.error = null;
    state.nextUpdate = Date.now() + REFRESH_MS;

    saveCache(methods);
    el.banner.hidden = true;
  } catch (err) {
    console.error(err);
    state.busy = false;
    state.pending = true;
    state.error = err.message;
    state.nextUpdate = Date.now() + REFRESH_MS;

    const age = state.lastUpdate ? ` Showing data from ${formatTime(state.lastUpdate)}.` : '';
    el.banner.textContent = `Could not reach the wiki: ${err.message}.${age}`;
    el.banner.hidden = false;
  }

  render();
}

/* --------------------------------------------------------------- caching */
function saveCache(methods) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), methods }));
  } catch { /* quota — ignore */ }
}

function loadCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.methods) || !raw.methods.length) return null;
    state.methods = raw.methods;
    state.profits = new Map(raw.methods.map((m) => [m.name, m.profit]));
    state.lastUpdate = raw.at;
    state.nextUpdate = Date.now() + REFRESH_MS;
    return raw;
  } catch { return null; }
}

/* ------------------------------------------------------------ ui state */
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      sort: state.sort, dir: state.dir,
      skills: [...state.skills], categories: [...state.categories],
      categoriesChosen: state.categoriesChosen,
      intensities: [...state.intensities], levels: state.levels, canDoOnly: state.canDoOnly,
      skillMode: state.skillMode,
    }));
  } catch { /* ignore */ }
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) return;
    // The page opens on "highest hourly profit first". A saved column/direction is
  // restored, but a saved "sorting off" state is not — the default always wins there.
  const saved = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, s.sort) ? s.sort : 'profit';
  state.sort = saved || 'profit';
  state.dir = state.sort === 'profit' ? 'desc' : (s.dir === 'asc' ? 'asc' : 'desc');
    if (Array.isArray(s.skills)) state.skills = new Set(s.skills);
    if (Array.isArray(s.categories)) state.categories = new Set(s.categories);
    // a saved pick only counts as a pick if it was actually made — otherwise the
    // opening default (everything but Recurring) applies
    state.categoriesChosen = s.categoriesChosen === true && Array.isArray(s.categories);
    if (Array.isArray(s.intensities)) state.intensities = new Set(s.intensities.filter((n) => Number.isFinite(n)));
    if (s.levels && typeof s.levels === 'object') {
      state.levels = Object.fromEntries(Object.entries(s.levels)
        .filter(([k, v]) => Number.isFinite(v) && v >= 0).slice(0, 40));
    }
    state.canDoOnly = !!s.canDoOnly && hasLevels();
    if (s.skillMode === 'any' || s.skillMode === 'all') state.skillMode = s.skillMode;
    // the user's explicit category picks survive a reload; otherwise the opening default applies
    if (Array.isArray(s.categories)) {
      state.categories = new Set(s.categories);
      state.categoriesChosen = s.categoriesChosen === true;
    }
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------- controls */
/** Reflects state.sort / state.dir onto the <th>s: active state, caret, aria-sort. */
function syncHeader() {
  for (const th of document.querySelectorAll('.mmg thead th[data-sort]')) {
    const key = th.dataset.sort;
    const active = key === state.sort;
    th.classList.toggle('is-active', active);
    th.classList.toggle('is-desc', active && state.dir === 'desc');
    th.classList.toggle('is-asc', active && state.dir === 'asc');
    th.setAttribute('aria-sort', active ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none');

    const label = SORT_COLUMNS[key].label;
    const btn = th.querySelector('.sort-btn');
    btn.title = active
      ? `Sorted by ${label.toLowerCase()} — click for ${SORT_COLUMNS[key].dir === 'desc' ? 'least' : 'most'}, then to turn sorting off`
      : `Sort by ${label.toLowerCase()}`;
  }
}

/** Clicking a header cycles it through three states and back:
 *  most/desc -> least/asc -> off (wiki order) -> most/desc …
 *  (text columns start at A–Z instead, then Z–A, then off) */
function sortBy(key) {
  const column = SORT_COLUMNS[key];
  if (!column) return;
  if (state.sort !== key) {
    state.sort = key;
    state.dir = column.dir;
  } else if (state.dir === column.dir) {
    state.dir = column.dir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sort = null;
    state.dir = null;
  }
  saveState();
  syncHeader();
  renderRows();
}

function syncControls() {
  syncHeader();
  for (const input of document.querySelectorAll('input[name="skillMode"]')) {
    input.checked = input.value === state.skillMode;
  }
}

function init() {
  loadState();
  loadCache();
  syncControls();
  render();

  // The sticky table header must sit exactly below the two bars above it. Their heights
  // are normally fixed by CSS, but browser zoom / text size can change them, so measure
  // and publish them as --topbar-h / --tabbar-h. A ResizeObserver alone can be deferred
  // in background tabs, hence the resize + visibility fallbacks too.
  const bars = [[document.querySelector('.topbar'), '--topbar-h'], [document.querySelector('.tabbar'), '--tabbar-h']];
  const trackBars = () => {
    for (const [node, prop] of bars) {
      const h = Math.round(node.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty(prop, `${h}px`);
    }
  };
  trackBars();
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(trackBars);
    bars.forEach(([node]) => observer.observe(node));
  }
  window.addEventListener('resize', trackBars);
  window.addEventListener('orientationchange', trackBars);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trackBars(); });

  for (const th of document.querySelectorAll('.mmg thead th[data-sort]')) {
    th.querySelector('.sort-btn').addEventListener('click', () => sortBy(th.dataset.sort));
  }

  for (const input of document.querySelectorAll('input[name="skillMode"]')) {
    input.addEventListener('change', () => {
      state.skillMode = input.value;
      saveState();
      renderRows();
    });
  }

  el.skillList.addEventListener('click', (e) => {
    const btn = e.target.closest('.skill-toggle');
    if (!btn) return;
    if (state.skills.has(btn.value)) state.skills.delete(btn.value);
    else state.skills.add(btn.value);
    btn.setAttribute('aria-pressed', String(state.skills.has(btn.value)));
    saveState();
    renderRows();
  });

  el.clearSkills.addEventListener('click', () => {
    state.skills.clear();
    saveState();
    renderSkills();
    renderRows();
  });

  el.categoryList.addEventListener('change', (e) => {
    const input = e.target;
    if (input.type !== 'checkbox') return;
    if (input.checked) state.categories.add(input.value); else state.categories.delete(input.value);
    state.categoriesChosen = true;      // an explicit pick outranks the opening default
    saveState();
    renderCategories();
    renderRows();
  });

  el.clearCategories.addEventListener('click', () => {
    state.categories.clear();
    state.categoriesChosen = true;
    saveState();
    renderCategories();
    renderRows();
  });

  el.intensityFilters.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    const rank = Number(pill.dataset.rank);
    if (state.intensities.has(rank)) state.intensities.delete(rank); else state.intensities.add(rank);
    pill.setAttribute('aria-pressed', String(state.intensities.has(rank)));
    saveState();
    renderRows();
  });

  el.canDoOnly.addEventListener('change', () => {
    state.canDoOnly = el.canDoOnly.checked && hasLevels();
    el.canDoOnly.checked = state.canDoOnly;
    saveState();
    renderRows();
  });

  el.levelGrid.addEventListener('input', (e) => {
    const input = e.target.closest('input');
    if (!input || input.readOnly) return;
    const key = input.id.replace(/^lvl-/, '');
    const raw = input.value.trim();
    if (raw === '') delete state.levels[key];
    else {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) state.levels[key] = n; else return;
    }
    const wasFiltering = state.canDoOnly;
    state.canDoOnly = state.canDoOnly && hasLevels();
    el.canDoOnly.checked = state.canDoOnly;
    saveState();
    syncLevelReadouts();          // no rebuild: that would blur the input being typed into
    if (state.canDoOnly || wasFiltering) renderRows();
  });

  el.clearLevels.addEventListener('click', () => {
    state.levels = {};
    state.canDoOnly = false;
    el.canDoOnly.checked = false;
    saveState();
    buildLevelGrid(true);
    renderRows();
  });

  // Hiscores lookup helper: the browser can't fetch the OSRS hiscores API (no CORS),
  // so the user opens the page via the loop icon, copies the CSV and pastes it here.
  function updateHiscoreLink() {
    const name = (el.hiscoreName.value || '').trim();
    el.hiscoreLink.href = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=' +
      encodeURIComponent(name);
  }
  async function runHiscoreFill() {
    let text = '';
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try { text = (await navigator.clipboard.readText() || '').trim(); } catch (e) { text = ''; }
    }
    if (!text) {
      el.hiscoreStatus.textContent = 'Copy the hiscores CSV, then click Import levels from clipboard.';
      return;
    }
    const ORDER = ['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
      'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting',
      'smithing', 'mining', 'herblore', 'agility', 'thieving', 'slayer', 'farming',
      'runecraft', 'hunter', 'construction', 'sailing'];
    const tokens = (text.match(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/g) || []).map((t) => t.replace(/\s+/g, ''));
    const skillLines = tokens.length > ORDER.length ? tokens.slice(1) : tokens;
    const levels = {};
    let filled = 0;
    for (let i = 0; i < ORDER.length && i < skillLines.length; i++) {
      const parts = skillLines[i].split(',');
      const rank = Number(parts[0]);
      const level = Number(parts[1]);
      const xp = Number(parts[2]);
      if (rank !== -1 && Number.isFinite(level) && level > 1 && (rank !== -1 || xp > 0)) { levels[ORDER[i]] = level; filled++; }
    }
    if (!filled) {
      el.hiscoreStatus.textContent = "Couldn't read skills from the clipboard.";
      return;
    }
    applyHiscoresLevels(levels);
    el.hiscoreStatus.textContent = `Filled ${filled} skill${filled === 1 ? '' : 's'} from hiscores.`;
  }
  if (el.hiscoreName) {
    el.hiscoreName.addEventListener('input', updateHiscoreLink);
    updateHiscoreLink();
    el.hiscoreFill.addEventListener('click', runHiscoreFill);
  }

  for (const [tab, panel] of [[el.tabMakers, el.panelMakers], [el.tabLevels, el.panelLevels]]) {
    tab.addEventListener('click', () => {
      const showLevels = tab === el.tabLevels;
      el.tabMakers.classList.toggle('is-active', !showLevels);
      el.tabLevels.classList.toggle('is-active', showLevels);
      el.tabMakers.setAttribute('aria-selected', String(!showLevels));
      el.tabLevels.setAttribute('aria-selected', String(showLevels));
      el.panelMakers.hidden = showLevels;
      el.panelLevels.hidden = !showLevels;
      trackBars();                               // the hidden panel changes nothing, but be safe
    });
  }

  let searchTimer;
  el.methodSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = el.methodSearch.value; renderRows(); }, 120);
  });

  el.refreshBtn.addEventListener('click', () => refresh());

  // countdown + refresh loop (one request per 2 minutes; none while the tab is hidden)
  setInterval(() => {
    renderStatus();
    const due = state.nextUpdate && Date.now() >= state.nextUpdate;
    if (due && !state.busy && !state.pending && !document.hidden) refresh();
  }, 1000);

  // don't poll while the tab is hidden; catch up as soon as it is focused again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.nextUpdate && Date.now() >= state.nextUpdate - 1000) refresh();
  });

  refresh();
}

init();

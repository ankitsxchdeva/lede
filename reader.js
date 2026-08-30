/* lede: today's digest in topic sections, plus a browser-local saved list. */

"use strict";

const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
// Where the digest API lives:
//   localhost dev      → localhost:8000 (run backend/app.py alongside)
//   <meta lede:api>    → static hosting on one origin, backend on another
//   otherwise          → same origin (the container serves both)
const API_META = (document.querySelector('meta[name="lede:api"]')?.content || "").trim();
const API_BASE = LOCAL ? "http://localhost:8000" : API_META.replace(/\/$/, "");
const DATA_URL = `${API_BASE}/data.json`;

const CACHE_KEY = "lede:cache";
const SEEN_KEY = "lede:seen"; // id -> first-render ms; "new" = absent at load
const READ_KEY = "lede:read"; // id -> click ms; read entries render muted
const SAVED_KEY = "lede:saved"; // id -> saved item; browser-local read-later list
const SETTINGS_KEY = "lede:settings"; // homepage prefs; browser-local like the rest
const KEEP_STATE_DAYS = 30;
const FETCH_TIMEOUT_MS = 10000;
// Section order for the today board. <meta lede:sections> pins it (empty
// sections still render); without it, sections follow whatever categories
// feeds.yaml uses, in order of first appearance.
const SECTION_META = document.querySelector('meta[name="lede:sections"]')?.content || "";
const SECTION_ORDER = SECTION_META.split(",").map((s) => s.trim()).filter(Boolean);

const digestEl = document.getElementById("digest");
const themesEl = document.getElementById("themes");
const themesWrap = document.getElementById("themes-wrap");
const noticeEl = document.getElementById("notice");
const emptyEl = document.getElementById("empty-state");
const searchEl = document.getElementById("search");
const searchKbdEl = document.querySelector(".search-kbd");
const tabs = {
  today: document.getElementById("tab-today"),
  week: document.getElementById("tab-week"),
  saved: document.getElementById("tab-saved"),
};
const exportEl = document.getElementById("export-saved");
const clockEl = document.getElementById("clock");
const datelineEl = document.getElementById("dateline");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const setThemeEl = document.getElementById("set-theme");
const setEngineEl = document.getElementById("set-engine");
const setViewEl = document.getElementById("set-view");
const setClock24El = document.getElementById("set-clock24");
const setDatelineEl = document.getElementById("set-dateline");
const setHideEmptyEl = document.getElementById("set-hideempty");
const setClearEl = document.getElementById("set-clear");

let seen = readStore(SEEN_KEY);
let read = readStore(READ_KEY);
const newIds = new Set(); // snapshot of unseen ids, taken at render time
const savedById = new Map(Object.entries(readStore(SAVED_KEY))); // id -> saved item
localStorage.removeItem("lede:token"); // leftover from the server-backed saved list
let view = "today";
let todayData = null;
let weekData = null; // archive from /items, fetched once per session
let shownCount = 0;

/* ─── Local state ────────────────────────────────────────────────────────── */

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the page still works, state just won't stick */
  }
}

function pruneStore(store) {
  const cutoff = Date.now() - KEEP_STATE_DAYS * 86400000;
  for (const id of Object.keys(store)) {
    if (store[id] < cutoff) delete store[id];
  }
  return store;
}

function markRead(id, entryEl) {
  if (!read[id]) {
    read[id] = Date.now();
    writeStore(READ_KEY, read);
  }
  entryEl.classList.add("read");
}

/* ─── Homepage settings (browser-local) ──────────────────────────────────── */

const DEFAULT_SETTINGS = {
  theme: "system", // system | light | dark
  engine: "duckduckgo",
  defaultView: "today",
  clock24: false,
  showDateline: true,
  hideEmpty: false,
};
const ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  kagi: "https://kagi.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};
let settings = { ...DEFAULT_SETTINGS, ...readStore(SETTINGS_KEY) };

function persistSettings() {
  writeStore(SETTINGS_KEY, settings);
}

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, "0");
  clockEl.textContent = settings.clock24
    ? `${String(h).padStart(2, "0")}:${m}`
    : `${h % 12 || 12}:${m} `;
  if (!settings.clock24) {
    const ampm = document.createElement("span");
    ampm.className = "clock-ampm";
    ampm.textContent = h < 12 ? "am" : "pm";
    clockEl.appendChild(ampm);
  }
  datelineEl.hidden = !settings.showDateline;
  if (settings.showDateline) {
    datelineEl.textContent = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  }
}

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
  // Keep the browser chrome tint honest when the user overrides the theme.
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const dark =
    settings.theme === "dark" || (settings.theme === "system" && darkQuery.matches);
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute("content", dark ? "#1e1c22" : "#f5f4fa"));
  searchEl.placeholder = `filter items · enter searches ${settings.engine}`;
  tickClock();
}

function syncSettingsInputs() {
  setThemeEl.value = settings.theme;
  setEngineEl.value = ENGINES[settings.engine] ? settings.engine : "duckduckgo";
  setViewEl.value = settings.defaultView;
  setClock24El.checked = settings.clock24;
  setDatelineEl.checked = settings.showDateline;
  setHideEmptyEl.checked = settings.hideEmpty;
}

function openSettings() {
  syncSettingsInputs();
  settingsPanel.hidden = false;
  settingsBtn.setAttribute("aria-expanded", "true");
  setThemeEl.focus();
}

function closeSettings() {
  if (settingsPanel.hidden) return;
  settingsPanel.hidden = true;
  settingsBtn.setAttribute("aria-expanded", "false");
  settingsBtn.focus();
}

settingsBtn.addEventListener("click", () => {
  if (settingsPanel.hidden) openSettings();
  else closeSettings();
});

document.addEventListener("click", (event) => {
  if (settingsPanel.hidden) return;
  if (!settingsPanel.contains(event.target) && event.target !== settingsBtn) {
    closeSettings();
  }
});

setThemeEl.addEventListener("change", () => {
  settings.theme = setThemeEl.value;
  persistSettings();
  applySettings();
});
setEngineEl.addEventListener("change", () => {
  settings.engine = setEngineEl.value;
  persistSettings();
  applySettings();
});
setViewEl.addEventListener("change", () => {
  settings.defaultView = setViewEl.value;
  persistSettings();
});
setClock24El.addEventListener("change", () => {
  settings.clock24 = setClock24El.checked;
  persistSettings();
  tickClock();
});
setDatelineEl.addEventListener("change", () => {
  settings.showDateline = setDatelineEl.checked;
  persistSettings();
  tickClock();
});
setHideEmptyEl.addEventListener("change", () => {
  settings.hideEmpty = setHideEmptyEl.checked;
  persistSettings();
  renderCurrent();
});
setClearEl.addEventListener("click", () => {
  read = {};
  seen = {};
  writeStore(READ_KEY, read);
  writeStore(SEEN_KEY, seen);
  newIds.clear();
  renderCurrent();
});

// System theme flips while the page is open: honor it when theme = system.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});

/* ─── Saved list (browser-local) + CSV export ────────────────────────────── */

function persistSaved() {
  writeStore(SAVED_KEY, Object.fromEntries(savedById));
}

function csvCell(value) {
  let s = String(value ?? "");
  // Formula-injection guard: a leading = + - @ would execute as a formula when
  // the CSV is opened in Excel/Sheets. A leading ' forces a text cell.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function exportSavedCsv() {
  const header = "title,url,source,category,published,saved_at";
  const items = [...savedById.values()].sort((a, b) =>
    (a.saved_at || "") < (b.saved_at || "") ? 1 : -1
  );
  const rows = items.map((item) =>
    [item.title, item.url, item.source, item.category, item.published, item.saved_at]
      .map(csvCell)
      .join(",")
  );
  const blob = new Blob([`${header}\r\n${rows.join("\r\n")}\r\n`], {
    type: "text/csv",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `lede-saved-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ─── Week archive (server-side, same funnel) ────────────────────────────── */

async function refreshWeek() {
  const response = await fetch(`${API_BASE}/items?days=7`, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  weekData = await response.json();
}

function toggleSaved(item, button) {
  const wasSaved = savedById.has(item.id);
  if (wasSaved) savedById.delete(item.id);
  else savedById.set(item.id, { ...item, saved_at: new Date().toISOString() });
  persistSaved();
  button.textContent = wasSaved ? "save" : "saved";
  button.classList.toggle("saved", !wasSaved);
  button.setAttribute("aria-pressed", String(!wasSaved));
  if (wasSaved && view === "saved") renderCurrent();
}

/* ─── Time ───────────────────────────────────────────────────────────────── */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function relativeTime(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const mins = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days <= 30) return `${days}d ago`;
  const date = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === new Date().getFullYear()
    ? date
    : `${date} ${then.getFullYear()}`;
}

function refreshTimes() {
  for (const el of document.querySelectorAll("time[datetime]")) {
    el.textContent = relativeTime(el.getAttribute("datetime"));
  }
}

/* ─── Rendering ──────────────────────────────────────────────────────────── */

function domain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Items with too little source text (e.g. some Yahoo Finance links) keep a
// bare publisher-name fallback as their "summary" — "Reuters", "Motley Fool".
// Only genuine model summaries (a sentence or two) are long enough to show.
function realSummary(item) {
  const s = (item.summary || "").trim();
  return s.length >= 25 ? s : "";
}

function renderEntry(item, index, { badges }) {
  const entry = document.createElement("article");
  entry.className = "entry";
  entry.style.setProperty("--stagger", `${Math.min(index * 0.05, 0.5)}s`);
  entry.dataset.haystack = [item.title, item.summary, item.source, (item.tags || []).join(" ")]
    .join(" ")
    .toLowerCase();
  if (read[item.id]) entry.classList.add("read");

  const title = document.createElement("h3");
  title.className = "entry-title";
  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = item.title;
  link.addEventListener("click", () => markRead(item.id, entry));
  link.addEventListener("auxclick", () => markRead(item.id, entry));
  title.appendChild(link);

  const summaryText = realSummary(item);
  let summaryEl = null;
  if (summaryText) {
    summaryEl = document.createElement("p");
    summaryEl.className = "entry-summary";
    summaryEl.textContent = summaryText;
  }

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  const time = document.createElement("time");
  time.setAttribute("datetime", item.published);
  time.textContent = relativeTime(item.published);
  meta.appendChild(time);
  const host = domain(item.url);
  if (host) {
    const hostEl = document.createElement("span");
    hostEl.className = "entry-domain";
    hostEl.textContent = host;
    meta.appendChild(hostEl);
  }
  if (badges && newIds.has(item.id)) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "new";
    meta.appendChild(badge);
  }
  const saveBtn = document.createElement("button");
  saveBtn.className = "save-btn";
  const isSaved = savedById.has(item.id);
  saveBtn.textContent = isSaved ? "saved" : "save";
  saveBtn.classList.toggle("saved", isSaved);
  saveBtn.setAttribute("aria-pressed", String(isSaved));
  saveBtn.addEventListener("click", () => toggleSaved(item, saveBtn));
  meta.appendChild(saveBtn);

  // Clustered coverage of the same story: "also: Hacker News, CNX Software".
  const related = item.related || [];
  if (related.length) {
    const bySource = new Map();
    for (const r of related) {
      if (r.source && !bySource.has(r.source)) bySource.set(r.source, r);
    }
    const shown = [...bySource.values()].slice(0, 3);
    const also = document.createElement("span");
    also.className = "entry-related";
    also.append("also: ");
    shown.forEach((rel, i) => {
      if (i) also.append(", ");
      const a = document.createElement("a");
      a.href = rel.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = rel.title;
      a.textContent = rel.source;
      also.append(a);
    });
    const extra = bySource.size - shown.length;
    if (extra > 0) also.append(` +${extra} more`);
    meta.appendChild(also);
  }

  if (summaryEl) entry.append(title, summaryEl, meta);
  else entry.append(title, meta);
  return entry;
}

function renderBoard(items, sources, { badges, fixedSections, emptyText }) {
  const sections = fixedSections
    ? new Map(SECTION_ORDER.map((name) => [name, []]))
    : new Map();
  for (const item of items) {
    const cat = item.category || "software";
    if (!sections.has(cat)) sections.set(cat, []);
    sections.get(cat).push(item);
  }
  for (const list of sections.values()) {
    list.sort((a, b) => (a.published < b.published ? 1 : -1));
  }

  const failed = new Map();
  for (const s of sources) {
    if (s.ok) continue;
    const cat = s.category || "software";
    if (!failed.has(cat)) failed.set(cat, []);
    failed.get(cat).push(s.name.toLowerCase());
  }

  digestEl.textContent = "";
  for (const [name, list] of sections) {
    if (!(fixedSections && !settings.hideEmpty) && !list.length) continue;
    const group = document.createElement("section");
    group.className = "group";

    const header = document.createElement("div");
    header.className = "group-header";
    const heading = document.createElement("h2");
    heading.className = "group-name";
    heading.textContent = name;
    header.appendChild(heading);
    for (const sourceName of failed.get(name) || []) {
      const note = document.createElement("span");
      note.className = "group-note";
      note.textContent = `${sourceName} unreachable`;
      header.appendChild(note);
    }
    group.appendChild(header);

    list.forEach((item, i) => group.appendChild(renderEntry(item, i, { badges })));
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "column-empty";
      empty.textContent = emptyText;
      group.appendChild(empty);
    }
    digestEl.appendChild(group);
  }

  shownCount = items.length;
  applyFilter();
}

function renderToday() {
  const data = todayData;
  if (!data) return;

  // Snapshot which ids are genuinely new before marking everything seen.
  newIds.clear();
  for (const item of data.items) {
    if (!seen[item.id]) newIds.add(item.id);
  }

  const themes = (data.themes || "").trim();
  themesEl.textContent = themes;
  themesWrap.hidden = !themes;

  renderBoard(data.items, data.sources || [], {
    badges: true,
    fixedSections: true,
    emptyText: "nothing today",
  });

  // Everything rendered this visit counts as seen for the next one.
  const now = Date.now();
  for (const item of data.items) {
    if (!seen[item.id]) seen[item.id] = now;
  }
  writeStore(SEEN_KEY, pruneStore(seen));
  writeStore(READ_KEY, pruneStore(read));
}

function renderSaved() {
  themesWrap.hidden = true;
  const items = [...savedById.values()];
  exportEl.hidden = items.length === 0;
  renderBoard(items, [], {
    badges: false,
    fixedSections: false,
    emptyText: "",
  });
  emptyEl.hidden = items.length > 0;
  if (!items.length) {
    emptyEl.textContent = "nothing saved yet; hit save on any article.";
  }
}

function renderWeek() {
  themesWrap.hidden = true;
  if (!weekData) {
    // First archive fetch failed: leave a message, don't blank the page.
    digestEl.textContent = "";
    shownCount = 0;
    emptyEl.hidden = false;
    emptyEl.textContent = "the server didn't answer; try again in a minute.";;
    return;
  }

  // Group by local calendar day. The server sends newest first (undated
  // last), so first sight of a day key is already the right group order.
  const byDay = new Map();
  for (const item of weekData.items) {
    const when = new Date(item.published);
    const dated = item.published && !Number.isNaN(when.getTime());
    const key = dated
      ? `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`
      : "undated";
    if (!byDay.has(key)) {
      byDay.set(key, {
        label: dated
          ? `${DAYS[when.getDay()]} ${MONTHS[when.getMonth()]} ${when.getDate()}`
          : "undated",
        items: [],
      });
    }
    byDay.get(key).items.push(item);
  }

  digestEl.textContent = "";
  for (const day of byDay.values()) {
    const group = document.createElement("section");
    group.className = "group";
    const header = document.createElement("div");
    header.className = "group-header";
    const heading = document.createElement("h2");
    heading.className = "group-name";
    heading.textContent = day.label;
    header.appendChild(heading);
    group.appendChild(header);
    day.items.forEach((item, i) =>
      group.appendChild(renderEntry(item, i, { badges: false }))
    );
    digestEl.appendChild(group);
  }

  shownCount = weekData.items.length;
  applyFilter();
  emptyEl.hidden = weekData.items.length > 0;
  if (!weekData.items.length) {
    emptyEl.textContent =
      "nothing archived yet — the archive starts filling from the next digest build.";
  }
}

function renderCurrent() {
  if (view === "today") renderToday();
  else if (view === "week") renderWeek();
  else renderSaved();
}

/* ─── View tabs ──────────────────────────────────────────────────────────── */

async function setView(next) {
  view = next;
  exportEl.hidden = next !== "saved" || savedById.size === 0;
  for (const [name, el] of Object.entries(tabs)) {
    el.classList.toggle("active", name === view);
    if (name === view) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  if (view === "week" && !weekData) {
    try {
      await refreshWeek();
    } catch (error) {
      console.error("lede: couldn't load the archive", error);
    }
  }
  renderCurrent();
}

tabs.today.addEventListener("click", () => setView("today"));
tabs.week.addEventListener("click", () => setView("week"));
tabs.saved.addEventListener("click", () => setView("saved"));
exportEl.addEventListener("click", exportSavedCsv);

/* ─── Search ─────────────────────────────────────────────────────────────── */

function applyFilter() {
  const query = searchEl.value.trim().toLowerCase();
  let shown = 0;
  for (const group of digestEl.querySelectorAll(".group")) {
    let visible = 0;
    for (const entry of group.querySelectorAll(".entry")) {
      const match = !query || entry.dataset.haystack.includes(query);
      entry.classList.toggle("hidden", !match);
      if (match) visible += 1;
    }
    // While searching, drop empty columns; at rest the full board shows.
    group.classList.toggle("hidden", Boolean(query) && visible === 0);
    shown += visible;
  }
  if (shownCount > 0) {
    // while filtering, the / hint becomes a live match count
    searchKbdEl.textContent = query ? String(shown) : "/";
    emptyEl.hidden = shown > 0;
    if (shown === 0) {
      emptyEl.textContent = `nothing matches "${searchEl.value.trim()}"`;
    }
  }
}

searchEl.addEventListener("input", applyFilter);

// Dual duty: typing filters the board, Enter takes the query to the web.
searchEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const query = searchEl.value.trim();
  if (!query) return;
  const base = ENGINES[settings.engine] || ENGINES.duckduckgo;
  window.open(base + encodeURIComponent(query), "_blank", "noopener");
});

document.addEventListener("keydown", (event) => {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    searchEl.focus();
  } else if (event.key === "Escape") {
    if (!settingsPanel.hidden) {
      closeSettings();
    } else if (document.activeElement === searchEl) {
      searchEl.value = "";
      applyFilter();
      searchEl.blur();
    }
  }
});

/* ─── Load ───────────────────────────────────────────────────────────────── */

function makeRetry() {
  const retry = document.createElement("button");
  retry.className = "notice-retry";
  retry.textContent = "retry";
  retry.addEventListener("click", () => {
    retry.disabled = true;
    retry.textContent = "retrying…";
    load().finally(() => {
      retry.disabled = false;
      retry.textContent = "retry";
    });
  });
  return retry;
}

async function load() {
  try {
    const response = await fetch(DATA_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    todayData = await response.json();
    writeStore(CACHE_KEY, { fetchedAt: Date.now(), data: todayData });
    noticeEl.hidden = true;
    renderCurrent();
  } catch (error) {
    const cached = readStore(CACHE_KEY);
    if (cached.data) {
      todayData = cached.data;
      renderCurrent();
      noticeEl.hidden = false;
      const saved = cached.fetchedAt
        ? relativeTime(new Date(cached.fetchedAt).toISOString())
        : "earlier";
      noticeEl.textContent = `showing a saved copy from ${saved}; the server didn't answer. `;
      noticeEl.appendChild(makeRetry());
    } else {
      digestEl.textContent = ""; // clear the loading skeleton
      emptyEl.hidden = false;
      emptyEl.textContent = "the server didn't answer; try again in a minute. ";
      emptyEl.appendChild(makeRetry());
    }
    console.error("lede: fetch failed", error);
  }
}

applySettings();
setView(settings.defaultView);
load();
tickClock();
setInterval(tickClock, 1000);
setInterval(refreshTimes, 60000);

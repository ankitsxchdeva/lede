/* lede: today's digest in topic sections, plus a saved list on the home server. */

"use strict";

const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
// The home server's public address (tailscale funnel, 8443 → pi:8000).
const API_BASE = LOCAL
  ? "http://localhost:8000"
  : "https://raspberrypi.tail9476fb.ts.net:8443";
const DATA_URL = `${API_BASE}/data.json`;

const CACHE_KEY = "lede:cache";
const SEEN_KEY = "lede:seen"; // id -> first-render ms; "new" = absent at load
const READ_KEY = "lede:read"; // id -> click ms; read entries render muted
const TOKEN_KEY = "lede:token"; // shared secret for saved-list writes
const KEEP_STATE_DAYS = 30;
const FETCH_TIMEOUT_MS = 10000;
const SECTION_ORDER = ["software", "hardware", "health"];

const digestEl = document.getElementById("digest");
const noticeEl = document.getElementById("notice");
const emptyEl = document.getElementById("empty-state");
const searchEl = document.getElementById("search");
const tabs = {
  today: document.getElementById("tab-today"),
  saved: document.getElementById("tab-saved"),
};

let seen = readStore(SEEN_KEY);
let read = readStore(READ_KEY);
const newIds = new Set(); // snapshot of unseen ids, taken at render time
const savedById = new Map(); // id -> saved item, mirrored from the server
let view = "today";
let todayData = null;
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

/* ─── Saved list (server-side, through the same funnel) ─────────────────── */

async function savedRequest(method, path, body) {
  const headers = {};
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers["X-Lede-Token"] = token;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401) {
    const entered = prompt("saving needs the token set on the home server:");
    if (!entered) throw new Error("no token");
    localStorage.setItem(TOKEN_KEY, entered.trim());
    return savedRequest(method, path, body);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function refreshSaved() {
  const response = await fetch(`${API_BASE}/saved`, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  savedById.clear();
  for (const item of data.items) savedById.set(item.id, item);
}

async function toggleSaved(item, button) {
  const wasSaved = savedById.has(item.id);
  // Optimistic flip; revert if the server says no.
  button.textContent = wasSaved ? "save" : "saved";
  button.classList.toggle("saved", !wasSaved);
  try {
    if (wasSaved) {
      await savedRequest("DELETE", `/saved/${encodeURIComponent(item.id)}`);
      savedById.delete(item.id);
      if (view === "saved") renderCurrent();
    } else {
      await savedRequest("POST", "/saved", {
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source || "",
        category: item.category || "",
        published: item.published || "",
      });
      savedById.set(item.id, { ...item, saved_at: new Date().toISOString() });
    }
  } catch (error) {
    button.textContent = wasSaved ? "saved" : "save";
    button.classList.toggle("saved", wasSaved);
    console.error("lede: saved-list update failed", error);
  }
}

/* ─── Time ───────────────────────────────────────────────────────────────── */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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
  saveBtn.addEventListener("click", () => toggleSaved(item, saveBtn));
  meta.appendChild(saveBtn);

  entry.append(title, meta);
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
    if (!fixedSections && !list.length) continue;
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

  renderBoard(data.items, data.sources || [], {
    badges: true,
    fixedSections: true,
    emptyText: "nothing today",
  });

  emptyEl.hidden = true;

  // Everything rendered this visit counts as seen for the next one.
  const now = Date.now();
  for (const item of data.items) {
    if (!seen[item.id]) seen[item.id] = now;
  }
  writeStore(SEEN_KEY, pruneStore(seen));
  writeStore(READ_KEY, pruneStore(read));
}

function renderSaved() {
  const items = [...savedById.values()];
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

function renderCurrent() {
  if (view === "today") renderToday();
  else renderSaved();
}

/* ─── View tabs ──────────────────────────────────────────────────────────── */

async function setView(next) {
  view = next;
  for (const [name, el] of Object.entries(tabs)) {
    el.classList.toggle("active", name === view);
    if (name === view) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  if (view === "saved") {
    try {
      await refreshSaved();
    } catch (error) {
      console.error("lede: couldn't refresh saved list", error);
    }
  }
  renderCurrent();
}

tabs.today.addEventListener("click", () => setView("today"));
tabs.saved.addEventListener("click", () => setView("saved"));

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
    emptyEl.hidden = shown > 0;
    if (shown === 0) {
      emptyEl.textContent = `nothing matches "${searchEl.value.trim()}"`;
    }
  }
}

searchEl.addEventListener("input", applyFilter);

document.addEventListener("keydown", (event) => {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    searchEl.focus();
  } else if (event.key === "Escape" && document.activeElement === searchEl) {
    searchEl.value = "";
    applyFilter();
    searchEl.blur();
  }
});

/* ─── Load ───────────────────────────────────────────────────────────────── */

async function load() {
  try {
    await refreshSaved();
  } catch (error) {
    console.error("lede: couldn't load saved list", error);
  }
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
      noticeEl.textContent = `showing a saved copy from ${saved}; the home server didn't answer.`;
    } else {
      emptyEl.hidden = false;
      emptyEl.textContent = "the home server didn't answer; try again in a minute.";
    }
    console.error("lede: fetch failed", error);
  }
}

load();
setInterval(refreshTimes, 60000);

/* lede: fetch the digest, render one column per source, keep read state local. */

"use strict";

const LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
// The home server's public address (tailscale funnel, 443 → pi:8000).
const DATA_URL = LOCAL
  ? "http://localhost:8000/data.json"
  : "https://raspberrypi.tail9476fb.ts.net/data.json";

const CACHE_KEY = "lede:cache";
const SEEN_KEY = "lede:seen"; // id -> first-render ms; "new" = absent at load
const READ_KEY = "lede:read"; // id -> click ms; read entries render muted
const KEEP_STATE_DAYS = 30;
const FETCH_TIMEOUT_MS = 10000;

const digestEl = document.getElementById("digest");
const noticeEl = document.getElementById("notice");
const emptyEl = document.getElementById("empty-state");
const searchEl = document.getElementById("search");

let seen = readStore(SEEN_KEY);
let read = readStore(READ_KEY);
const newIds = new Set(); // snapshot of unseen ids, taken at render time
let itemCount = 0;

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

function renderEntry(item, index) {
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
  if (newIds.has(item.id)) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "new";
    meta.appendChild(badge);
  }

  entry.append(title, meta);
  return entry;
}

function render(data) {
  // Snapshot which ids are genuinely new before marking everything seen.
  // Recently published only: backfill from a just-added source isn't "new".
  newIds.clear();
  const recent = Date.now() - 3 * 86400000;
  for (const item of data.items) {
    if (!seen[item.id] && new Date(item.published).getTime() > recent) {
      newIds.add(item.id);
    }
  }

  const bySource = new Map();
  for (const item of data.items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }

  // Columns follow feeds.yaml order (stable board), not newest-first.
  const sources = (data.sources || []).map((s) => s.name);
  for (const name of bySource.keys()) {
    if (!sources.includes(name)) sources.push(name);
  }
  const failed = new Map(
    (data.sources || []).filter((s) => !s.ok).map((s) => [s.name, s.error])
  );

  digestEl.textContent = "";
  for (const name of sources) {
    const items = bySource.get(name) || [];
    const group = document.createElement("section");
    group.className = "group";

    const header = document.createElement("div");
    header.className = "group-header";
    const heading = document.createElement("h2");
    heading.className = "group-name";
    heading.textContent = name;
    header.appendChild(heading);
    if (failed.has(name)) {
      const note = document.createElement("span");
      note.className = "group-note";
      note.textContent = "unreachable";
      note.title = failed.get(name) || "";
      header.appendChild(note);
    }
    group.appendChild(header);

    items.forEach((item, i) => group.appendChild(renderEntry(item, i)));
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "column-empty";
      empty.textContent = "nothing recent";
      group.appendChild(empty);
    }
    digestEl.appendChild(group);
  }

  itemCount = data.items.length;
  emptyEl.hidden = itemCount > 0;
  if (itemCount === 0) {
    emptyEl.textContent = "the digest is empty right now; check back after the next refresh.";
  }

  // Everything rendered this visit counts as seen for the next one.
  const now = Date.now();
  for (const item of data.items) {
    if (!seen[item.id]) seen[item.id] = now;
  }
  writeStore(SEEN_KEY, pruneStore(seen));
  writeStore(READ_KEY, pruneStore(read));

  applyFilter();
}

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
  if (itemCount > 0) {
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
    const response = await fetch(DATA_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    writeStore(CACHE_KEY, { fetchedAt: Date.now(), data });
    noticeEl.hidden = true;
    render(data);
  } catch (error) {
    const cached = readStore(CACHE_KEY);
    if (cached.data) {
      render(cached.data);
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

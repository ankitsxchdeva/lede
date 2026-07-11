/* lede: fetch the digest, render it grouped by source, keep read state local. */

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
const statusEl = document.getElementById("status-line");
const noticeEl = document.getElementById("notice");
const emptyEl = document.getElementById("empty-state");
const sourcesEl = document.getElementById("sources-line");
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

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
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

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  const time = document.createElement("time");
  time.className = "entry-time";
  time.setAttribute("datetime", item.published);
  time.textContent = relativeTime(item.published);
  meta.appendChild(time);
  if (newIds.has(item.id)) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "new";
    meta.appendChild(badge);
  }

  const body = document.createElement("div");
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
  const host = domain(item.url);
  if (host) {
    const badge = document.createElement("span");
    badge.className = "entry-domain";
    badge.textContent = host;
    title.appendChild(badge);
  }
  body.appendChild(title);

  if (item.summary) {
    const summary = document.createElement("p");
    summary.className = "entry-summary";
    summary.textContent = item.summary;
    body.appendChild(summary);
  }

  entry.append(meta, body);
  return entry;
}

function render(data) {
  // Snapshot which ids are genuinely new before marking everything seen.
  newIds.clear();
  for (const item of data.items) {
    if (!seen[item.id]) newIds.add(item.id);
  }

  const groups = new Map(); // source name -> items, newest first (input order)
  for (const item of data.items) {
    if (!groups.has(item.source)) groups.set(item.source, []);
    groups.get(item.source).push(item);
  }

  const failed = new Map(
    (data.sources || []).filter((s) => !s.ok).map((s) => [s.name, s.error])
  );

  digestEl.textContent = "";
  let index = 0;
  for (const [name, items] of groups) {
    const group = document.createElement("section");
    group.className = "group";

    const header = document.createElement("div");
    header.className = "group-header";
    const heading = document.createElement("h2");
    heading.className = "group-name";
    heading.textContent = name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(items.length);
    header.append(heading, count);
    if (failed.has(name)) {
      const note = document.createElement("span");
      note.className = "group-note";
      note.textContent = "fetch failed, showing older items";
      header.appendChild(note);
    }
    group.appendChild(header);

    for (const item of items) {
      group.appendChild(renderEntry(item, index));
      index += 1;
    }
    digestEl.appendChild(group);
  }

  itemCount = data.items.length;
  emptyEl.hidden = itemCount > 0;
  if (itemCount === 0) {
    emptyEl.textContent = "the digest is empty right now; check back after the next refresh.";
  }

  renderSources(data.sources || []);

  // Everything rendered this visit counts as seen for the next one.
  const now = Date.now();
  for (const item of data.items) {
    if (!seen[item.id]) seen[item.id] = now;
  }
  writeStore(SEEN_KEY, pruneStore(seen));
  writeStore(READ_KEY, pruneStore(read));

  applyFilter();
}

function renderSources(sources) {
  sourcesEl.textContent = "";
  if (!sources.length) return;
  sourcesEl.append("sources: ");
  sources.forEach((source, i) => {
    if (i > 0) sourcesEl.append(" · ");
    const name = document.createElement("span");
    name.textContent = source.name;
    if (!source.ok) {
      name.className = "source-failed";
      name.textContent += " (unreachable)";
      name.title = source.error || "";
    }
    sourcesEl.appendChild(name);
  });
}

function renderStatus(data, { stale, fetchedAt }) {
  const updated = relativeTime(data.generated_at);
  const parts = [`updated ${updated}`, `${data.items.length} items`];
  if (newIds.size > 0) parts.push(`${newIds.size} new`);
  statusEl.textContent = parts.join(" · ");

  if (stale) {
    noticeEl.hidden = false;
    const saved = fetchedAt ? relativeTime(new Date(fetchedAt).toISOString()) : "earlier";
    noticeEl.textContent = `showing a saved copy from ${saved}; the home server didn't answer.`;
  } else {
    noticeEl.hidden = true;
  }
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
    group.classList.toggle("hidden", visible === 0);
    shown += visible;
  }
  if (itemCount > 0) {
    emptyEl.hidden = shown > 0;
    if (shown === 0) {
      emptyEl.textContent = `nothing matches "${searchEl.value.trim()}"; search looks at titles, summaries, sources, and tags.`;
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
    render(data);
    renderStatus(data, { stale: false });
  } catch (error) {
    const cached = readStore(CACHE_KEY);
    if (cached.data) {
      render(cached.data);
      renderStatus(cached.data, { stale: true, fetchedAt: cached.fetchedAt });
    } else {
      statusEl.textContent = "the home server didn't answer and there's no saved copy yet.";
      emptyEl.hidden = false;
      emptyEl.textContent = "nothing to show; try again in a minute.";
    }
    console.error("lede: fetch failed", error);
  }
}

load();
setInterval(() => {
  refreshTimes();
}, 60000);

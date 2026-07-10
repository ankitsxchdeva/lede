# lede

A personal news/blog reader. Pulls posts from many RSS/Atom feeds (plus a few
scraped sites), refreshes every ~30 minutes, and shows them as a single skimmable
digest — grouped by source, newest first, with instant keyword search and
"new since last visit" highlighting.

> **Status: plan only.** Nothing here is implemented yet. This README is the
> build-out — architecture, file layouts, concrete configs, and a phased
> checklist — so implementation is turnkey when I come back to it.

---

## Goals

- **Daily-ish digest**, not an inbox: one page, last few days, grouped by source, skim and click out.
- **Refreshes every ~30 min** — reliably (rules out GitHub Actions cron; the home server does the work).
- **Dead-easy to add feeds** — adding a source is a 2–3 line edit to one file, no code, no rebuild.
- **Keyword search** — instant client-side filter now; optional saved-keyword highlight/notify later.
- **Reuses the existing home server** — one more Docker Compose service, same patterns as the rest.
- **Static frontend on GitHub Pages** — lives under the existing personal site, styled to match it.

## Why this shape (the decisions already made)

| Decision | Choice | Why |
|---|---|---|
| Where fetch + scrape runs | **Home server** (Raspberry Pi, Docker) | Reliable 30-min cadence; residential IP avoids datacenter blocks; reuses existing tooling. |
| How data reaches the page | **Tailscale Funnel** (public HTTPS) | No port forwarding (Google Fiber), no CGNAT pain, auto TLS. Wanted Tailscale anyway. |
| Public vs private endpoint | **Funnel (public)** | Fine to let others read the same digest; the `.ts.net` URL just isn't a secret. |
| Frontend hosting | **GitHub Pages** (`/reader/` on the personal site) | Static, free, always up; degrades to a cached copy if the Pi is down. |
| Server state | **Stateless rebuild** | Feeds only carry recent items; read/seen state lives client-side in `localStorage`. |

Rejected: fully-static GitHub Actions (cron unreliable at 30-min intervals, burns
private-repo minutes); a live custom API with read-state DB (overkill for a digest —
revisit only if interactive/multi-device sync is wanted later).

---

## Architecture

```
home-server/rss-reader   (one container, always on)
  ├─ every POLL_INTERVAL: read feeds.yaml → fetch feeds + scrape → write data/data.json
  └─ HTTP: GET /data.json   (+ CORS header, + /healthz)         listens on :8000
                    │
        tailscale funnel  ── public HTTPS ──▶  https://<pi>.<tailnet>.ts.net/data.json
                                                          ▲
   ankitsxchdeva.com/reader/  ── fetch() ─────────────────┘
   (static page on GitHub Pages: render digest, search box, seen-state, stale-cache fallback)
```

One container does **both** the periodic fetch and the serving — a background async
task on a timer plus a small FastAPI/uvicorn server. This mirrors the existing
"loop inside `bot.py`" pattern used by `reddit-swap-notifier` and the other bots.
`restart: unless-stopped` keeps it alive across reboots.

## How it reuses the existing home server

- **Service pattern** — modular `include:` in the root `docker-compose.yml`; each service
  self-contained with `Dockerfile` + `requirements.txt` + `.env.example` + a `data/` volume.
  `rss-reader/` is just one more entry.
- **Keyword engine already written** — `reddit-swap-notifier/poller.py` has
  `keyword_pattern()` / `matching_keywords()` (regex lookarounds, case-insensitive).
  Reuse it verbatim for the keyword feature.
- **Paywalls** — the existing **13ft** proxy (`:5001`) can fetch full text for paywalled
  scrape targets: `http://localhost:5001/https://paywalled-site/article`.
- **Frontend look** — `ankitsxchdeva.github.io` is a plain static site with a real design
  system in `DESIGN.md` (ink-plum / lavender-paper / signal-indigo, Lato). `/reader/`
  inherits those tokens so it feels native.
- **Optional glue** — a bookmark on the `homepage` dashboard (`:3000`); the Discord notifier
  can ping on keyword hits.

---

## Component 1 — `home-server/rss-reader/` (the backend service)

```
rss-reader/
├─ docker-compose.yml     # build ., restart: unless-stopped, port 8000, mounts ./data + ./feeds.yaml
├─ Dockerfile             # python:3.12-slim  (matches the other services)
├─ requirements.txt       # feedparser, httpx, selectolax, pyyaml, python-dateutil, fastapi, uvicorn
├─ .env.example           # POLL_INTERVAL_SECONDS, ALLOW_ORIGIN, DAYS_KEPT, USER_AGENT
├─ feeds.yaml             # ← the ONLY file you edit to add sources (bind-mounted, live)
├─ app.py                 # fetch loop + /data.json server + CORS + /healthz
├─ fetch.py               # per-source fetch, parse, normalize → items
├─ discover.py            # feed auto-discovery (bare site URL → its RSS/Atom feed)
├─ scrapers/              # one small module per genuinely-feedless site
│   └─ __init__.py
├─ data/                  # output: data.json (Docker volume, gitignored)
└─ README.md
```

### `docker-compose.yml`
```yaml
services:
  rss-reader:
    build: .
    container_name: rss-reader
    restart: unless-stopped
    ports:
      - "8000:8000"          # tailscale funnel points here
    volumes:
      - ./data:/app/data     # data.json output
      - ./feeds.yaml:/app/feeds.yaml:ro   # edit live; next cycle picks it up
    env_file:
      - .env
```
Then add `- rss-reader/docker-compose.yml` to the `include:` list in the root
`home-server/docker-compose.yml`.

### `Dockerfile`
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py fetch.py discover.py ./
COPY scrapers ./scrapers
CMD ["python", "-u", "app.py"]
```

### `.env.example`
```bash
# How often to rebuild the digest
POLL_INTERVAL_SECONDS=1800
# Which origin may fetch data.json (the Pages site). Use * to allow anyone.
ALLOW_ORIGIN=https://ankitsxchdeva.com
# How many days of items to keep in the digest
DAYS_KEPT=3
# Be a polite bot
USER_AGENT=lede/1.0 (+https://ankitsxchdeva.com/reader)
# Optional: route paywalled sources through the existing 13ft proxy
# PAYWALL_PROXY=http://localhost:5001
```

### `app.py` responsibilities (pseudocode)
```python
# on startup:
#   - start uvicorn serving GET /data.json (adds Access-Control-Allow-Origin: ALLOW_ORIGIN)
#     and GET /healthz
#   - launch a background asyncio task: build_loop()
#
# build_loop():
#   while True:
#       sources = load feeds.yaml
#       items = await gather( fetch_source(s) for s in sources )   # bounded concurrency, per-source timeout
#       items = dedup(items) sorted newest-first, trimmed to DAYS_KEPT
#       write data/data.json atomically   # write tmp + os.replace, so serving never sees a half file
#       sleep(POLL_INTERVAL_SECONDS)
#
# a single source failing marks it ok:false and keeps its last items — never fails the whole build.
```

---

## Component 2 — `feeds.yaml` (the "easy to add feeds" surface)

```yaml
sources:
  - name: Stratechery
    url: https://stratechery.com/feed/
  - name: Simon Willison
    url: https://simonwillison.net/atom/everything/
  - name: Some Blog              # no feed URL known? just give the site —
    url: https://example.com     # discover.py finds the feed via <link rel="alternate"> or /feed, /rss, /atom.xml
  - name: Feedless Site
    url: https://feedless.example/articles
    scrape: feedless_example     # only when discovery fails → scrapers/feedless_example.py
    # optional per-source knobs:
    # tags: [ai, tech]
    # limit: 20
    # paywall: true              # fetch full text through 13ft
```

- Adding a source = a couple of lines. `feeds.yaml` is **bind-mounted**, so you edit it
  and the next cycle picks it up — no rebuild, no restart.
- `discover.py` means most "no feed" sites cost **zero** scraper code.
- You only hand-write a `scrapers/<name>.py` for the genuinely feedless few; each returns
  a list of `{title, url, published, summary}` and its failures stay isolated.

---

## Component 3 — `ankitsxchdeva.github.io/reader/` (the static frontend)

```
reader/
├─ index.html
├─ reader.js     # fetch data.json, group by source, relative times, search, seen-state, stale fallback
└─ reader.css    # pulls DESIGN.md tokens so it matches the personal site
```

- Digest grouped by source, newest first.
- **New-since-last-visit** highlight + read/seen state via `localStorage` — no server state.
- **Instant keyword search** — a box that live-filters loaded items by title/summary (Level 1 below).
- **Resilience** — caches the last good `data.json` in `localStorage`; if the Pi is down when
  the page loads, it shows the last digest with a small "stale" banner instead of a blank page.

### Data contract — `data.json`
```json
{
  "generated_at": "2026-07-10T14:30:00Z",
  "sources": [
    { "name": "Stratechery", "ok": true, "error": null }
  ],
  "items": [
    {
      "id": "sha1-of-url",
      "source": "Stratechery",
      "title": "The End of the Beginning",
      "url": "https://stratechery.com/...",
      "published": "2026-07-10T12:00:00Z",
      "summary": "…short excerpt…",
      "tags": ["tech"]
    }
  ]
}
```
`id` is a stable hash (dedup + seen-tracking). Items sorted newest-first, trimmed to `DAYS_KEPT`.

---

## Keyword search — two levels

- **Level 1 — instant client-side search (build first, free).**
  A search box in the frontend live-filters the loaded items by title/summary.
  Covers "show me everything mentioning `rust` today" with zero backend.
- **Level 2 — saved server-side keywords (optional extension).**
  Reuse `reddit-swap-notifier`'s `matching_keywords()` to pin items hitting a saved list
  (e.g. always surface "Anthropic", "raspberry pi") into a "Matches" section — and,
  since the Discord notifier already exists, optionally **ping** on a new hit. This is the
  one place a small SQLite `seen` table would be worth adding (so you're not re-notified).

---

## Tailscale / Funnel — setup (Phase 0)

No Tailscale on the Pi yet, so this is the genuinely new infra (and the part wanted anyway):

```bash
# 1. Install on the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2. In the Tailscale admin console (one-time):
#    - enable HTTPS certificates for the tailnet
#    - grant the Funnel node attribute (ACL nodeAttrs)

# 3. Expose the reader publicly over HTTPS (stable URL, auto TLS)
sudo tailscale funnel --bg 8000
#    → https://<pi-hostname>.<tailnet>.ts.net   (this is what reader.js fetches)
```

**Bonus:** host-level Tailscale also gives private remote access to *every* home service
(Home Assistant, Homepage, Pi-hole) from your phone — not just the reader. That's why it
goes on the host rather than as a compose sidecar (the sidecar is the alternative if you'd
rather keep everything containerized).

---

## Build phases & rough effort

- [ ] **Phase 0 — Tailscale** (~30 min, one-time): install on the Pi, `tailscale up`, enable HTTPS + Funnel.
- [ ] **Phase 1 — `rss-reader` service** (~half a day): `app.py` (fetch loop + server), `feeds.yaml`,
      `discover.py`, Docker glue; add to root compose `include:`.
- [ ] **Phase 2 — Funnel it** (~15 min): `tailscale funnel --bg 8000`, confirm public `data.json` over HTTPS.
- [ ] **Phase 3 — `/reader/` frontend** (~half a day): render, style to `DESIGN.md`, client-side search,
      seen-state, stale-cache fallback.
- [ ] **Phase 4 — optional** (~1 hr each): saved-keyword highlight/notify (reuse reddit-swap-notifier),
      homepage dashboard bookmark, favicon.

**The only input needed at build time:** the actual feed/site list for `feeds.yaml` — and even
that can be filled in incrementally, since adding feeds is a one-file edit.

---

## Honest tradeoffs

- **Funnel is public** — anyone with the `.ts.net` URL can read `data.json`. Accepted; the URL just isn't a secret.
- **Live dependency** — the Pi must be up when the page loads; mitigated by the `localStorage` cache + stale banner.
- **Scrapers are fragile** — sites change markup. Minimized by preferring discovered feeds, using 13ft for
  paywalls, and isolating per-source failures — but the feedless few will need occasional upkeep.

---

## Repo layout note

At implementation time the code spans two existing repos:

- **Backend** → `home-server/rss-reader/` (this plan's Component 1)
- **Frontend** → `ankitsxchdeva.github.io/reader/` (Component 3)

This `lede` repo holds the plan. If you later prefer a single standalone repo, move both
components here and rename the service dir to `home-server/lede/` for consistency.

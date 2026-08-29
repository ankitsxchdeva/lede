# lede

A personal news dashboard at [ankitsachdeva.com/lede/](https://ankitsachdeva.com/lede/).

This repo is just the frontend: three static files (`index.html`, `reader.js`,
`reader.css`) served by GitHub Pages, no build step, no framework. All the real
work — fetching feeds, scraping, storage — happens in the `rss-reader` service
on the home server (`home-server/rss-reader/`), and this page talks to it over
a Tailscale Funnel.

```
┌───────────────────── home server (raspberry pi) ─────────────────────┐
│  rss-reader container (docker compose)                               │
│                                                                      │
│   every 30 min:  feeds.yaml ──▶ fetch + scrape ──▶ data.json         │
│                                 (today's items, by category)         │
│   saved articles ────────────────────────────────▶ saved.db (sqlite) │
│                                                                      │
│   FastAPI :8000   GET /data.json · GET|POST|DELETE /saved · /healthz │
└─────────────────────────────────┬─────────────────────────────────---┘
                                  │  tailscale funnel (public https)
                                  ▼
                 https://raspberrypi.<tailnet>.ts.net
                                  ▲
                    reads the digest │ saves articles
                     GET /data.json │ POST/DELETE /saved
                                  │  (X-Lede-Token header)
┌─────────────────────────────────┴────────────────────────────────────┐
│  this repo  ──▶  github pages  ──▶  ankitsachdeva.com/lede/           │
│                                                                      │
│   today / saved tabs · keyword filter (/) · new-since-last-visit     │
│   read state in localStorage · stale-cache fallback if the pi is down│
└──────────────────────────────────────────────────────────────────────┘
```

## How it fits together

- **Today view** fetches `data.json`: only items published today (midnight,
  America/Chicago), grouped into software / hardware / health sections. Which
  feed lands in which section is a two-line edit in `feeds.yaml`
  (`home-server/rss-reader/feeds.yaml`).
- **Saved view** is the read-later list. Saves go through the same funnel the
  digest comes from, into SQLite on the Pi. Writes need the password from
  `rss-reader/.env` (`SAVE_TOKEN`); the page asks once and remembers it.
- **If the Pi is down**, the page shows the last good digest from
  `localStorage` with a small notice instead of a blank page.

## Local dev

```bash
# backend (from home-server/rss-reader): serves :8000
python app.py
# frontend: serves :8080; reader.js auto-targets localhost:8000
python3 -m http.server 8080
```

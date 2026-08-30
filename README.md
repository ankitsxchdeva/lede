# lede

A personal news dashboard at [ankitsachdeva.com/lede/](https://ankitsachdeva.com/lede/).

The frontend is three static files (`index.html`, `reader.js`, `reader.css`)
served by GitHub Pages, no build step, no framework. The backend lives in
[`backend/`](./backend/) — fetching feeds, scraping, LLM summaries — and runs
as the `rss-reader` container on the home server (deploy config stays in
`home-server/rss-reader/`). This page talks to it over a Tailscale Funnel.

```
┌───────────────────── home server (raspberry pi) ─────────────────────┐
│  rss-reader container (docker compose)                               │
│                                                                      │
│   every 30 min:  feeds.yaml ──▶ fetch + scrape ──▶ data.json         │
│                                 (today's items, by category)         │
│                                                                      │
│   FastAPI :8000   GET /data.json · GET /items?days=7 · /healthz      │
└─────────────────────────────────┬─────────────────────────────────---┘
                                  │  tailscale funnel (public https)
                                  ▼
                 https://raspberrypi.<tailnet>.ts.net
                                  ▲
                          read-only │ GET /data.json, GET /items
┌─────────────────────────────────┴────────────────────────────────────┐
│  this repo  ──▶  github pages  ──▶  ankitsachdeva.com/lede/           │
│                                                                      │
│   today / week / saved tabs · keyword filter (/) · new badges        │
│   saved list + read state in localStorage · CSV export of saved      │
│   stale-cache fallback if the pi is down                             │
└──────────────────────────────────────────────────────────────────────┘
```

## How it fits together

- **Today view** fetches `data.json`: only items published today (midnight,
  America/Chicago), grouped into software / hardware / health / politics
  sections. Which
  feed lands in which section is a two-line edit in `feeds.yaml`
  (`home-server/rss-reader/feeds.yaml`).
- **Week view** fetches `/items?days=7`: the archive the server keeps of every
  digest item, grouped by day.
- **Saved view** is the read-later list, kept in the browser's `localStorage`
  — no server round-trip, no token, works when the Pi is down. The `export`
  button on that tab downloads the list as a CSV (opens in Excel/Sheets) and
  doubles as its backup. Trade-off: no cross-device sync.
- **If the Pi is down**, the page shows the last good digest from
  `localStorage` with a small notice instead of a blank page.

## Local dev

```bash
# backend (backend/, needs feeds.yaml alongside): serves :8000
python app.py
# frontend: serves :8080; reader.js auto-targets localhost:8000
python3 -m http.server 8080
```

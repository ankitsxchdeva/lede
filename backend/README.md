# backend

The lede digest app: one container that rebuilds `data/data.json` from
`feeds.yaml` every `POLL_INTERVAL_SECONDS` and serves it — plus the frontend,
when a static directory is present — on port 8000.

## The build loop

Each cycle (`app.py: build_once`):

1. **Fetch** (`fetch.py`) — every source in `feeds.yaml`, concurrently
   (semaphore-bounded). Feed URLs parse directly; page URLs go through
   feed discovery (`discover.py`); `scrape:` sources call a module from
   `scrapers/` instead. A source that fails keeps its last good items and is
   reported `ok: false` in the payload.
2. **Window** — only items published since midnight in `DIGEST_TZ` survive,
   except `min_today` backfill, which may reach one day further back.
3. **Dedup** (`cluster.py`) — same story from several sources collapses to
   one entry; losing sources are listed under `related`. Non-aggregator
   sources claim stories before aggregators do.
4. **Enrich** (`summarize.py`) — optional Ollama pass: per-item summaries
   from full article text (`extract.py`, concurrently fetched), plus a short
   "today's themes" paragraph over the top headlines.
5. **Persist** — `data.json` is written atomically (tmp + rename), then every
   item is archived to SQLite (`db.py`) for the week view (`GET /items`).

## The summarizer's safety rails

- Summaries are cached in SQLite keyed by item id + model, so an item hits
  the model exactly once.
- `SUMMARY_MAX_PER_CYCLE` caps model calls per cycle; a backlog spills into
  later cycles.
- `SUMMARY_BREAKER_THRESHOLD` consecutive failures trips a breaker; the rest
  of the cycle uses the feed's own blurb.
- Meta-responses ("the provided text does not contain…") are detected and
  rejected — never cached, never served.
- Extraction failures are not LLM failures and never touch the breaker.
- `SUMMARY_ENABLED=0` disables all of it.

## API

- `GET /data.json` — today's digest (`Cache-Control: no-cache`), 503 until
  the first build completes
- `GET /items?days=7` — the archive (1–30 days)
- `GET /healthz` — `{"ok": true}` once a digest exists
- `GET /…` — the frontend, same-origin, if `STATIC_DIR`/`./static`/the repo
   root contains an `index.html`

Read-only by design; the saved list lives in the browser's localStorage.

## Scrapers

A genuinely feedless site gets a module in `scrapers/` — see
`hackernews.py` for the shape. A scraper returns `{title, url, published?,
summary?}` dicts and is referenced by `scrape: module_name` in `feeds.yaml`.
The registry lives in `scrapers/__init__.py`.

## Tests & CI

```bash
pip install -r requirements.txt
python test_cluster.py
```

Every push to `main` touching the backend or frontend runs the tests and
publishes `ghcr.io/ankitsxchdeva/lede-backend:latest` (multi-arch:
linux/amd64 + linux/arm64). The image bundles the frontend with the
instance-specific `lede:*` meta tags stripped — see the Dockerfile.

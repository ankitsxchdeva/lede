"""lede backend: periodic digest builder + tiny JSON server, one container.

A background task rebuilds data/data.json from feeds.yaml every
POLL_INTERVAL_SECONDS; FastAPI serves it at /data.json with a CORS header.
If a frontend directory is found (STATIC_DIR, ./static in the image, or the
repo root in local dev), it is served same-origin at / as well.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import uvicorn
import yaml
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import cluster
import db
import fetch
import summarize

load_dotenv()
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("app")

BASE = Path(__file__).parent
DATA_FILE = BASE / "data" / "data.json"
FEEDS_FILE = BASE / "feeds.yaml"

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL_SECONDS") or 1800)
ALLOW_ORIGIN = os.environ.get("ALLOW_ORIGIN") or "*"
DIGEST_TZ = os.environ.get("DIGEST_TZ") or "UTC"
USER_AGENT = os.environ.get("USER_AGENT") or "lede/1.0"
CONCURRENCY = 8

# Last good items per source, so one bad cycle never blanks a source out.
last_items: dict[str, list[dict]] = {}

summarizer = summarize.Summarizer()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_sources() -> list[dict]:
    config = yaml.safe_load(FEEDS_FILE.read_text()) or {}
    return config.get("sources") or []


def seed_from_disk() -> None:
    """Reload the previous digest so a restart doesn't drop failed sources."""
    if not DATA_FILE.exists():
        return
    try:
        data = json.loads(DATA_FILE.read_text())
    except ValueError:
        return
    for item in data.get("items", []):
        last_items.setdefault(item["source"], []).append(item)
    log.info("Seeded %d items from existing data.json", len(data.get("items", [])))


async def build_once(client: httpx.AsyncClient) -> None:
    sources = await asyncio.to_thread(load_sources)
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def bounded(source: dict) -> dict:
        async with semaphore:
            return await fetch.fetch_source(client, source)

    results = await asyncio.gather(*(bounded(s) for s in sources))

    # Items with no date keep the published we assigned when first seen.
    prev_by_id = {i["id"]: i for items in last_items.values() for i in items}
    sources_by_name = {s.get("name"): s for s in sources}
    source_meta = []
    for result in results:
        if result["ok"]:
            last_items[result["name"]] = result["items"]
        source_meta.append(
            {
                "name": result["name"],
                "ok": result["ok"],
                "error": result["error"],
                "category": sources_by_name.get(result["name"], {}).get("category")
                or "software",
            }
        )

    # Only items published today make the digest: since midnight in DIGEST_TZ.
    # A source with min_today tops up from yesterday when today runs short —
    # e.g. HN in the morning, before today's posts have earned front-page votes.
    midnight = datetime.now(ZoneInfo(DIGEST_TZ)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    cutoff = midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_before = (midnight - timedelta(days=1)).astimezone(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    items, seen = [], set()
    # Origin feeds claim their articles before aggregators (HN) can: an item
    # on both HN and the author's own feed belongs to the author's source.
    dedup_order = sorted(
        results,
        key=lambda r: bool(sources_by_name.get(r["name"], {}).get("aggregator")),
    )
    for result in dedup_order:
        min_today = int(sources_by_name.get(result["name"], {}).get("min_today") or 0)
        todays, backfill = [], []
        for item in last_items.get(result["name"], []):
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            if not item["published"]:
                prev = prev_by_id.get(item["id"])
                item["published"] = (
                    prev["published"] if prev and prev["published"] else now_iso()
                )
            if item["published"] >= cutoff:
                todays.append(item)
            elif item["published"] >= day_before:
                backfill.append(item)
        items.extend(todays)
        # Feed order is the source's own ranking (points, for HN), so the
        # best of yesterday fills in first.
        if len(todays) < min_today:
            items.extend(backfill[: min_today - len(todays)])
    items.sort(key=lambda i: i["published"], reverse=True)
    # Same story from several sources collapses to one entry (sources listed in
    # `related`), so the LLM only spends budget on unique stories.
    items = cluster.cluster_items(items)

    # LLM enrichment: rewrite new items' summaries and add a themes overview.
    # Degrades to the feed's own truncated summaries if Ollama is unavailable.
    await summarizer.summarize_items(client, items)
    themes = await summarizer.themes(client, items)

    payload = {"generated_at": now_iso(), "sources": source_meta, "items": items}
    if themes:
        payload["themes"] = themes
    DATA_FILE.parent.mkdir(exist_ok=True)
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    os.replace(tmp, DATA_FILE)  # atomic: serving never sees a half-written file
    # Archive everything just served; re-upserts refresh summaries and tags.
    db.upsert_items(items)
    ok = sum(1 for s in source_meta if s["ok"])
    log.info("Built digest: %d items from %d/%d sources", len(items), ok, len(source_meta))
    for s in source_meta:
        if not s["ok"]:
            log.warning("Source %s: %s", s["name"], s["error"])


async def build_loop() -> None:
    await asyncio.to_thread(seed_from_disk)
    timeout = httpx.Timeout(20, connect=10)
    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT}, timeout=timeout, follow_redirects=True
    ) as client:
        while True:
            started = asyncio.get_event_loop().time()
            try:
                await build_once(client)
            except Exception:
                log.exception("Build cycle failed")
            elapsed = asyncio.get_event_loop().time() - started
            await asyncio.sleep(max(60, POLL_INTERVAL - elapsed))


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    task = asyncio.create_task(build_loop())

    def log_loop_exit(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception():
            log.error("Build loop exited", exc_info=t.exception())

    task.add_done_callback(log_loop_exit)
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)

# Read-only API: the saved list is browser-local in the frontend now.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if ALLOW_ORIGIN == "*" else [ALLOW_ORIGIN],
    allow_methods=["GET"],
)


@app.get("/data.json")
async def data_json():
    if not DATA_FILE.exists():
        return JSONResponse({"error": "first build hasn't finished yet"}, status_code=503)
    return FileResponse(
        DATA_FILE, media_type="application/json", headers={"Cache-Control": "no-cache"}
    )


@app.get("/items")
def items_list(days: int = 7):
    days = max(1, min(30, days))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    return {"items": db.items_since(since)}


@app.get("/healthz")
async def healthz():
    generated_at = None
    if DATA_FILE.exists():
        try:
            generated_at = json.loads(DATA_FILE.read_text()).get("generated_at")
        except ValueError:
            pass
    return {"ok": generated_at is not None, "generated_at": generated_at}


def find_static_dir() -> Path | None:
    """Frontend directory to serve at /, if one exists alongside the app."""
    override = os.environ.get("STATIC_DIR")
    for candidate in [override, BASE / "static", BASE.parent]:
        if candidate and (Path(candidate) / "index.html").exists():
            return Path(candidate)
    return None


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles, but every response asks the browser to revalidate.

    The files are tiny and the frontend evolves with the image; heuristic
    caching would leave returning users on a stale reader.js after an update.
    """

    async def get_response(self, path: str, scope) -> object:
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "no-cache"
        return resp


# Mounted last: the API routes above always win, anything else falls through
# to the frontend (index.html at /, reader.js, fonts...). Skipped entirely
# for API-only deployments.
static_dir = find_static_dir()
if static_dir:
    app.mount("/", NoCacheStaticFiles(directory=static_dir, html=True), name="site")
    log.info("Serving frontend from %s", static_dir)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

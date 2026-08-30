# Contributing

lede is a small personal project that welcomes fixes and ideas.

## The short version

1. Open an issue first for anything bigger than a typo — the project stays
   small on purpose, and a feature that doesn't fit is easier to discuss
   before code exists.
2. Fork, branch, PR against `main`.

## Running your change

```bash
# backend
cd backend
pip install -r requirements.txt
cp ../feeds.example.yaml feeds.yaml   # alongside app.py
SUMMARY_ENABLED=0 python app.py       # serves API + frontend on :8000

# frontend only (served separately on :8080, targets localhost:8000)
python3 -m http.server 8080
```

## The bar for a PR

- `python test_cluster.py` passes (CI runs it on every push).
- You actually ran the thing: a digest build for backend changes, a look at
  the rendered page for frontend changes. Say what you ran in the PR.
- No build tooling, frameworks, or new dependencies without an issue first.
  The frontend is three static files and the backend is stdlib-shaped Python;
  that's a feature.

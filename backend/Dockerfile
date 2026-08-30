FROM python:3.14-slim

WORKDIR /app

# Build context is the repo root (see .github/workflows/backend.yml):
#   docker build -f backend/Dockerfile .
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/*.py ./
COPY backend/scrapers ./scrapers

# The frontend, served same-origin at / (app.py mounts static/ when present).
# The lede:* instance meta tags — and the comment explaining them — are
# stripped: the container always derives (same-origin API, sections from
# feeds.yaml), never the publishing instance's.
COPY index.html reader.js reader.css favicon.svg ./static/
COPY fonts ./static/fonts
RUN sed -i -e '/<!-- Instance config/,/-->/d' -e '/name="lede:/d' static/index.html

CMD ["python", "-u", "app.py"]

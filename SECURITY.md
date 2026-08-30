# Security Policy

## Supported versions

Only the latest `main` (and the `:latest` container image built from it) is
supported. Update with:

```bash
docker compose pull && docker compose up -d
```

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the repo's **Security** →
**Report a vulnerability** tab) rather than opening a public issue.

lede is a read-only, self-hosted digest: it fetches public feeds and serves
JSON. It has no accounts, no write endpoints, and no secrets beyond your own
`.env`. The most realistic issues are feed-parsing edge cases and whatever
your proxy/network setup exposes — both still worth reporting.

# INFINITE STREAMS — Stremio Addon

A self-hosted Stremio addon aggregating 12 streaming providers: AnimeSalt, RareAnime, AnimeDekho, NetMirror, StreamFlix, Castle TV, DahmerMovies, HindMoviez, MovieBox, HDHub4U, 4KHDHub, and DooFlix.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the addon server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: none (all defaults are baked in)

### On Replit

The addon is served at `/api` (reverse-proxied by the platform):
- Landing page: `https://<replit-domain>/api/`
- Manifest: `https://<replit-domain>/api/manifest.json`
- Add to Stremio: `https://<replit-domain>/api/configure`

### On VPS (Docker)

With `BASE_PATH=""` (the Docker default), the addon serves at root:
- Landing page: `http://your-server:8080/`
- Manifest: `http://your-server:8080/manifest.json`

## VPS Deployment (Docker)

```bash
# Build and start
docker compose up -d --build

# Optional env overrides in docker-compose.yml:
#   PUBLIC_URL: "https://yourdomain.com"   ← set this for correct links in the addon
#   TMDB_API_KEY: "your_key"               ← has a default, override if needed

# View logs
docker compose logs -f

# Stop
docker compose down
```

The container exposes port `8080`. Put Nginx/Caddy/Traefik in front for HTTPS.

### Nginx example (HTTPS reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    # ... ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Then set `PUBLIC_URL=https://yourdomain.com` in `docker-compose.yml`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5, esbuild (CJS/ESM bundle)
- No database required

## Where things live

- `artifacts/api-server/src/manifest.ts` — addon manifest & provider list
- `artifacts/api-server/src/routes/stremio.ts` — all catalog/meta/stream/subtitles handlers
- `artifacts/api-server/src/providers/` — per-provider scrapers
- `artifacts/api-server/src/extractors/` — stream extractors
- `artifacts/api-server/src/lib/` — shared utilities (cache, proxy, TMDB, etc.)
- `artifacts/api-server/src/castle-tv/` — Castle TV / DahmerMovies / StreamFlix handlers
- `Dockerfile` — multi-stage Docker build for VPS
- `docker-compose.yml` — VPS deployment config

## Architecture decisions

- `BASE_PATH` env controls route prefix: defaults to `/api` on Replit, set to `""` for VPS root-mounted mode.
- `PUBLIC_URL` env overrides the auto-detected origin for proxy/manifest URLs — always set this on VPS.
- Provider selection is encoded as a 12-char `0/1` mask in the URL path (e.g. `/111100110/stream/...`).
- esbuild bundles the entire server into `dist/index.mjs` — the production Docker image only needs that + Node.js.
- Stream caching lives in-memory (no external cache needed).

## Product

Users install the addon in Stremio and get streams from 12 providers. A landing page at `/` (or `/api/` on Replit) lets them toggle providers and copy an install link.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The `pnpm-workspace.yaml` esbuild overrides strip all non-linux-x64 platform binaries — this is intentional and fine for both Replit and Docker (both linux-x64). Do not remove those overrides.
- Always rebuild (`pnpm run build`) before running `start` — the dev script does this automatically.
- Docker's `BASE_PATH=""` means routes are at root; Replit's `BASE_PATH="/api"` means they're under `/api`. Never mix these up.

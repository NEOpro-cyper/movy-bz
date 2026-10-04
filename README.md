# Movy API

Minimal proxy API that fetches and decrypts stream sources from `movy.sx` by TMDB ID and server name. Deployable to **Vercel** (serverless) or **Coolify/VPS** (Docker).

## Files

```
movy-api/
├── package.json        # express dependency + scripts
├── server.js           # express app (shared — exports app, no listen)
├── index.js            # VPS entry — calls app.listen(PORT)
├── api/
│   └── index.js        # Vercel entry — exports app for serverless
├── routes.js           # all logic: routes + movy crypto + TMDB + cache
├── vercel.json         # Vercel config (rewrites + 60s function timeout)
├── Dockerfile          # Coolify/VPS Docker build
├── nixpacks.toml       # Coolify nixpacks alternative
├── .dockerignore
├── .gitignore
└── README.md
```

## Quick Start (Local)

```bash
npm install
npm start
# → http://localhost:3000
```

Requires Node 18+ (uses built-in `fetch` and `Buffer`).

## Deploy to Vercel

### Option A — Vercel CLI

```bash
npm i -g vercel
cd movy-api
vercel              # preview deploy
vercel --prod       # production deploy
```

### Option B — GitHub Integration

1. Push this folder to a GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repo — Vercel auto-detects the `api/` directory and `vercel.json`
4. Click Deploy — done

**Endpoint:** `https://<your-project>.vercel.app/api/movie/273207?server=miami`

**Notes:**
- `vercel.json` rewrites all paths (`/(.*)`) to `/api` (the serverless function)
- Function timeout is set to 60s (Vercel Pro max)
- In-memory cache works per warm lambda instance (~5-15 min idle)

## Deploy to Coolify (VPS)

### Option A — Dockerfile (recommended)

1. In Coolify dashboard → New Resource → Public Repository (or paste raw git URL)
2. Select this repo
3. Build pack: **Dockerfile** (auto-detected from `Dockerfile`)
4. Set port: `3000` (or whatever `PORT` env var you set)
5. Deploy

### Option B — Nixpacks

1. Same as above, but select build pack: **Nixpacks**
2. Coolify reads `nixpacks.toml` automatically
3. Set port: `3000`

### Option C — Direct Docker Run

```bash
docker build -t movy-api .
docker run -p 3000:3000 --name movy-api movy-api
```

**Endpoint:** `http://<your-vps-ip>:3000/api/movie/273207?server=miami`

## Endpoints

### `GET /api/movie/:id?server=...`

Returns decrypted stream sources (m3u8 URLs, subtitles) for a TMDB title.

| Param     | Required | Description                                              |
|-----------|----------|----------------------------------------------------------|
| `server`  | yes      | Server name (`miami`, `boise`, ...) or 1-indexed number (1–16) |
| `season`  | no       | Season number (default `1`, TV only)                     |
| `episode` | no       | Episode number (default `1`, TV only)                    |
| `type`    | no       | `tv` or `movie` (default: auto-detect — tries tv first)  |
| `worker`  | no       | `worker=1` — rewrite stream + subtitle URLs through the CF worker (default off) |

```bash
# By server name
curl 'http://localhost:3000/api/movie/273207?server=miami'

# By server number (1 = miami, 2 = boise, ...)
curl 'http://localhost:3000/api/movie/273207?server=1'

# Movie with explicit type
curl 'http://localhost:3000/api/movie/20526?server=miami&type=movie'

# Specific episode
curl 'http://localhost:3000/api/movie/273207?server=phoenix&season=1&episode=5'

# Route stream + subtitle URLs through the CF worker (bypass CDN edge blocks)
curl 'http://localhost:3000/api/movie/273207?server=miami&worker=1'
```

**Response:**

```json
{
  "server": "miami",
  "tmdbId": "273207",
  "title": "Neagley",
  "mediaType": "tv",
  "imdbId": "tt33539520",
  "season": 1,
  "episode": 1,
  "worker": false,
  "cached": false,
  "sources": [
    { "quality": "1080p", "url": "https://moon.quietridge.top/vd/.../index-s1080p-v1-a1.m3u8" },
    { "quality": "720p",  "url": "https://moon.quietridge.top/vd/.../index-s720p-v1-a1.m3u8" },
    { "quality": "480p",  "url": "https://moon.quietridge.top/vd/.../index-s480p-v1-a1.m3u8" }
  ],
  "subtitles": [],
  "playlist": "https://moon.quietridge.top/vd/.../master.m3u8"
}
```

With `&worker=1`, every stream/subtitle URL (including `playlist`) is prefixed with the
worker origin so playback goes through your Cloudflare worker:

```json
{
  "worker": true,
  "sources": [
    { "quality": "1080p", "url": "https://icy-art-1d5b-movy.ntb7nmytsd.workers.dev/https://moon.zenoak.top/vd/.../index-s1080p-v1-a1.m3u8" }
  ],
  "playlist": "https://icy-art-1d5b-movy.ntb7nmytsd.workers.dev/https://moon.zenoak.top/vd/.../master.m3u8"
}
```

URLs are never double-wrapped, and the cache stores raw (unwrapped) URLs — so the same
cache entry serves both `worker=0` and `worker=1` requests correctly.

### `GET /api/servers`

```json
[
  { "id": 1, "name": "miami" },
  { "id": 2, "name": "boise" },
  ...
  { "id": 16, "name": "cancun" }
]
```

### `GET /`

API documentation (JSON).

## Server List (16 total)

| # | Name    | Note            |  # | Name    | Note          |
|---|---------|-----------------|----|---------|---------------|
| 1 | miami   | Original audio  | 9  | dallas  | Original      |
| 2 | boise   | Original        | 10 | tampa   | Original      |
| 3 | atlanta | Original        | 11 | orlando | Original      |
| 4 | seattle | Original        | 12 | munich  | German audio  |
| 5 | denver  | Original        | 13 | berlin  | German audio  |
| 6 | phoenix | Original        | 14 | paris   | French audio  |
| 7 | portland| Original        | 15 | delhi   | Hindi audio   |
| 8 | austin  | Original        | 16 | cancun  | Spanish audio |

## Caching

- **Successful** responses are cached in memory for 30 min (configurable via `CACHE_TTL_MS` env var).
- **Failed** responses (404, 500, decrypt errors, etc.) are **NOT** cached — so retries always hit upstream.
- Cache key: `${tmdbId}:${server}:${season}:${episode}`
- Cache hit returns `cached: true` and `cacheExpiresAt` in the response.
- **Vercel caveat:** cache is per-lambda-instance — not shared across invocations. Useful for burst traffic on the same lambda, not for global caching. For shared cache, add Redis.

## Environment Variables

| Var             | Default                  | Description                          |
|-----------------|--------------------------|--------------------------------------|
| `PORT`          | `3000`                   | HTTP listen port (VPS/Coolify only) |
| `TMDB_KEY`      | hardcoded fallback       | TMDB API key (override in production) |
| `CACHE_TTL_MS`  | `1800000` (30 min)       | Cache TTL for successful responses  |
| `PROXY_HOST`    | `p.webshare.io`          | Webshare proxy host                 |
| `PROXY_PORT`    | `80`                     | Webshare proxy port                 |
| `PROXY_USERNAME`| `dkmxrsew-rotate`        | Webshare proxy username (rotate)    |
| `PROXY_PASSWORD`| `hd1zl1cegrxs`           | Webshare proxy password             |
| `PROXY_URL`     | built from the 4 vars    | Full proxy URL override (`http://user:pass@host:port`) |
| `PROXY_ENABLED` | `true`                   | `false` disables the proxy (direct fetch) |
| `PROXY_TMDB`    | `false`                  | `true` also routes TMDB lookups through the proxy |
| `PROXY_FALLBACK_DIRECT` | `true`           | Retry direct once if the proxy itself is unreachable |
| `UPSTREAM_TIMEOUT_MS` | `20000`            | Timeout per upstream request        |
| `WORKER_URL`    | `https://icy-art-1d5b-movy.ntb7nmytsd.workers.dev` | Worker origin used for `?worker=1` URL rewriting |

```bash
# Coolify / VPS
PORT=8080 TMDB_KEY=your_key_here CACHE_TTL_MS=3600000 node index.js

# Disable proxy / send TMDB through proxy too
PROXY_ENABLED=false node index.js
PROXY_TMDB=true node index.js

# Vercel — set in dashboard or:
vercel env add TMDB_KEY
vercel env add CACHE_TTL_MS
vercel env add PROXY_PASSWORD
vercel env add WORKER_URL
```

## How It Works

For each request, the server:

1. Looks up title, `imdb_id`, and `total_seasons` from TMDB (`api.themoviedb.org`).
2. Computes the `b35ebba4` anti-leak token: `base64(xorEncode(title + tmdbId))`.
3. Fetches a short-lived seed (30s TTL) from `api.wecollege.net/seed` — **via the Webshare rotating proxy** (`p.webshare.io:80`, credentials baked in, override with env vars).
4. Calls `api.wecollege.net/<server>/sources?...&enc=2&seed=...` — also via the proxy — returns base64 ciphertext.
5. Decrypts using STREAMCRYPTO v2 (custom cipher: FNV-1a + golden ratio + SHA-256 constants + RC4-style KSA, keyed by `seed` + `mediaId`).
6. If `?worker=1` was passed, prefixes `sources[].url`, `subtitles[].url` and `playlist` with the CF worker origin (`WORKER_URL`).
7. Returns `{sources, subtitles, playlist}` JSON.
8. Caches the **raw** result for 30 min (only on success) — worker rewriting is applied at serve time.

## Notes

- **Proxy:** all `api.wecollege.net` calls (seed + sources) go through the Webshare rotating proxy by default — each request may exit from a different IP. If upstream ever binds the seed to an IP and you see repeated 401s, switch to a sticky session by overriding `PROXY_USERNAME` (Webshare sticky format) or set `PROXY_URL`.
- **TMDB** lookups are direct by default (TMDB rarely blocks hosting IPs); set `PROXY_TMDB=true` to proxy them too.
- If the proxy is unreachable, requests fall back to direct once (disable with `PROXY_FALLBACK_DIRECT=false`).
- **Worker rewriting** is opt-in per request via `&worker=1` (accepts `1/true/yes/on`); URLs already pointing at the worker are never double-wrapped.
- Some servers may return 500 (e.g. `portland: title not found`, `berlin: kinoger unavailable`) — that's the upstream scraper failing, not this API.
- Movy's backend rate-limits aggressively. If you hit 429s, slow down — sequential calls with ~2s delay are safest.
- CORS is enabled (`Access-Control-Allow-Origin: *`) so browser frontends can call this API directly.

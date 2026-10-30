const express = require('express');
const crypto = require('crypto');

// ===== Optional undici ProxyAgent — routes upstream fetches through an HTTP proxy =====
let undici = null;
try { undici = require('undici'); } catch (_) { /* not installed — falls back to direct fetch */ }

// ===== Proxy config (Webshare rotating proxy — override via env vars) =====
const PROXY_HOST = process.env.PROXY_HOST || 'p.webshare.io';
const PROXY_PORT = process.env.PROXY_PORT || '80';
const PROXY_USERNAME = process.env.PROXY_USERNAME || 'dkmxrsew-rotate';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || 'hd1zl1cegrxs';
const PROXY_ENABLED = String(process.env.PROXY_ENABLED ?? 'true') !== 'false';
const PROXY_URL = process.env.PROXY_URL ||
  `http://${encodeURIComponent(PROXY_USERNAME)}:${encodeURIComponent(PROXY_PASSWORD)}@${PROXY_HOST}:${PROXY_PORT}`;
// Route TMDB lookups through the proxy too? (movy upstream is ALWAYS proxied)
const PROXY_TMDB = String(process.env.PROXY_TMDB ?? 'false') === 'true';
// If the proxy itself is unreachable, retry the request once without it
const PROXY_FALLBACK_DIRECT = String(process.env.PROXY_FALLBACK_DIRECT ?? 'true') !== 'false';
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '20000', 10);

let proxyAgent = null;
if (PROXY_ENABLED && undici) {
  try {
    proxyAgent = new undici.ProxyAgent(PROXY_URL);
  } catch (e) {
    console.warn(`[movy-api] failed to init proxy agent: ${e.message}`);
  }
}
console.log(`[movy-api] proxy ${PROXY_ENABLED ? (proxyAgent ? `ON -> ${PROXY_HOST}:${PROXY_PORT}` : 'requested but undici missing — using direct fetch') : 'OFF'}`);

// ===== Cloudflare worker rewriting (?worker=1) =====
// When enabled, stream + subtitle URLs are prefixed with the worker origin so the
// worker fetches them on the server side (bypasses geo/IP blocks on the CDN edge).
// Example: https://icy-art-1d5b-movy.ntb7nmytsd.workers.dev/https://moon.zenoak.top/vd/.../master.m3u8
const WORKER_BASE = (process.env.WORKER_URL || 'https://icy-art-1d5b-movy.ntb7nmytsd.workers.dev').replace(/\/+$/, '');
const WORKER_PREFIX = `${WORKER_BASE}/`;

function workerWrap(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
  if (url.startsWith(WORKER_PREFIX)) return url; // already wrapped — never double-wrap
  return WORKER_PREFIX + url;
}

// ===== Encrypted mode (?data=en) =====
// Stream/subtitle URLs are replaced with AES-256-GCM tokens that only the
// EN worker can decrypt — no upstream URL ever appears in the response.
//   token = "v1." + b64url(iv) + "." + b64url(ciphertext + authtag)
//   key   = SHA-256(SECRET)              -> AES-256-GCM
//   iv    = SHA-256("iv:" + url)[0..12]  -> deterministic (same URL = same token)
const WORKER_URL_EN = (
  process.env.WORKER_URL_EN || 'https://noisy-feather-adb6.ryklcd0086.workers.dev/sx'
).replace(/\/+$/, ''); // strip trailing slash
const TOKEN_SECRET = 'bbef4e4840ab0a33b6c129f0de8b1a6735471c82f43e9babc4adc64c5959a64a';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function encryptUrlToken(rawUrl) {
  const key = crypto.createHash('sha256').update(TOKEN_SECRET).digest();
  const iv = crypto.createHash('sha256').update(`iv:${rawUrl}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(rawUrl, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64url(iv)}.${b64url(Buffer.concat([ct, tag]))}`;
}

function proxiedUrl(url, encrypt = false) {
  if (encrypt) {
    // EN mode: tokenize absolute http(s) URLs only — relative paths cannot
    // be decrypted by the worker, so they pass through untouched
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
    if (url.startsWith(`${WORKER_URL_EN}/v1.`)) return url; // already tokenized — never double-encrypt
    return `${WORKER_URL_EN}/${encryptUrlToken(url)}`;
  }
  return workerWrap(url);
}

function applyWorker(data, on, encrypt = false) {
  if (!on && !encrypt) return data;
  const out = structuredClone(data);
  if (Array.isArray(out.sources)) {
    out.sources = out.sources.map(s => ({ ...s, url: proxiedUrl(s.url, encrypt) }));
  }
  if (Array.isArray(out.subtitles)) {
    out.subtitles = out.subtitles.map(t => {
      const copy = { ...t };
      for (const k of ['url', 'file', 'link']) if (copy[k]) copy[k] = proxiedUrl(copy[k], encrypt);
      return copy;
    });
  }
  if (out.playlist) out.playlist = proxiedUrl(out.playlist, encrypt);
  if (out.thumbnail) out.thumbnail = proxiedUrl(out.thumbnail, encrypt);
  if (encrypt) out.encrypted = true;
  return out;
}

// ===== Proxy-aware fetch =====
// useProxy: route through the Webshare proxy. Default ON for the movy upstream
// (seed + sources), OFF for TMDB unless PROXY_TMDB=true. If the proxy itself is
// unreachable (connection-level error), retries once direct when allowed.
function shouldFallbackDirect(e) {
  const code = e && (e.code || e.cause?.code);
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT',
          'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code);
}

async function upstreamFetch(url, opts = {}, { proxy = true } = {}) {
  const fetchImpl = undici ? undici.fetch : globalThis.fetch;
  const baseOpts = { ...opts, signal: opts.signal || AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  if (proxy && proxyAgent) {
    try {
      return await fetchImpl(url, { ...baseOpts, dispatcher: proxyAgent });
    } catch (e) {
      if (PROXY_FALLBACK_DIRECT && shouldFallbackDirect(e)) {
        console.warn(`[movy-api] proxy failed for ${url} (${e.code || e.message}) — retrying direct`);
        return await fetchImpl(url, baseOpts);
      }
      throw e;
    }
  }
  return fetchImpl(url, baseOpts);
}

// ===== Config (override via env vars for production) =====
const TMDB_KEY = process.env.TMDB_KEY || '61e2290429798c561450eb56b26de19b';
const STREAM_API = 'https://api.wecollege.net';
const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://www.movy.sx',
  'Referer': 'https://www.movy.sx/',
};
const SERVERS = [
  'miami', 'boise', 'atlanta', 'seattle', 'denver', 'phoenix', 'portland', 'austin',
  'dallas', 'tampa', 'orlando', 'munich', 'berlin', 'paris', 'delhi', 'cancun',
];
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '3600000', 10); // 30 min default

// ===== In-memory cache (successful responses only) =====
const cache = new Map(); // key: `${tmdbId}:${server}:${season}:${episode}` -> { data, expiresAt }

// ===== Movy STREAMCRYPTO v2 decrypt (clean port from chunk 1zyk0gv4kwtq5.js) =====
const DC = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,
            0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,
            0x9bdc06a7,0xc19bf174];
const MAGIC = [109, 118, 109, 49]; // "mvm1"
const imul = (a, b) => Math.imul(a | 0, b | 0) >>> 0;
const rotl = (x, n) => { x = x >>> 0; n &= 31; if (!n) return x; return ((x << n) | (x >>> (32 - n))) >>> 0; };
const mix = (x) => {
  x = x >>> 0;
  x = x ^ (x >>> 16); x = imul(x, 0x85ebca6b);
  x = x ^ (x >>> 13); x = imul(x, 0xc2b2ae35);
  x = x ^ (x >>> 16);
  return x >>> 0;
};

function decrypt(ctB64, seed, mediaId) {
  const padded = ctB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(ctB64.length / 4), '=');
  const ct = Buffer.from(padded, 'base64');

  // Derive keystream state from (seed, mediaId)
  const e = seed;
  const aNum = Number(mediaId) >>> 0;
  const S = new Array(61).fill(undefined);
  let fnv = 0x811c9dc5;
  for (let k = 0; k < e.length; k++) fnv = imul(fnv ^ e.charCodeAt(k), 0x1000193);
  let n = mix(mix(fnv) ^ mix(aNum ^ 0x9e3779b9));
  for (let k = 0; k < 8; k++) {
    const pos = n % 61;
    n = rotl(n + 0x9e3779b9, 7 + (7 & k));
    S[pos] = (n ^ mix(n)) >>> 0;
    n = mix(n + pos);
  }
  let acc = mix(0xa5a5a5a5 ^ n);

  // Generate keystream
  const ks = Buffer.alloc(ct.length);
  let counter = 0, outIdx = 0;
  while (outIdx < ct.length) {
    const d = acc % 61;
    const assigned = S[d] !== undefined;
    const i = assigned ? -1 : 0;
    const r = assigned ? (S[d] >>> 0) : 0;
    const c = imul(0x9e3779b9, counter + 1);
    const t = acc, s = (r ^ c) >>> 0;
    let b = ((t ^ s) | (t & s & i)) >>> 0;
    b = (rotl(b + acc, 31 & d) ^ rotl(acc, 31 & imul(d, 7))) >>> 0;
    b = (b + 0x9e3779b9) >>> 0;
    acc = mix(b);
    S[d] = acc >>> 0;
    ks[outIdx++] = acc & 0xFF;
    if (outIdx < ct.length) ks[outIdx++] = (acc >>> 8) & 0xFF;
    if (outIdx < ct.length) ks[outIdx++] = (acc >>> 16) & 0xFF;
    if (outIdx < ct.length) ks[outIdx++] = (acc >>> 24) & 0xFF;
    counter++;
  }

  // XOR + verify integrity (first 4 bytes = "mvm1")
  const pt = Buffer.alloc(ct.length);
  for (let k = 0; k < ct.length; k++) pt[k] = ct[k] ^ ks[k];
  for (let k = 0; k < MAGIC.length; k++) {
    if (pt[k] !== MAGIC[k]) throw new Error('decrypt failed: bad seed or tampered payload');
  }
  return pt.slice(MAGIC.length).toString('utf-8');
}

// ===== Movy seed fetcher (with TTL cache) =====
const seedCache = new Map();
async function getSeed(mediaId) {
  const now = Date.now();
  const cached = seedCache.get(mediaId);
  if (cached && cached.expiresAt - 5000 > now) return cached.seed;
  const r = await upstreamFetch(`${STREAM_API}/seed?mediaId=${mediaId}`, { headers: HDRS });
  if (!r.ok) throw new Error(`seed HTTP ${r.status}`);
  const data = await r.json();
  seedCache.set(mediaId, { seed: data.seed, expiresAt: now + (data.ttlMs || 30000) });
  return data.seed;
}

// ===== Fetch + decrypt sources from one server =====
async function getSources(server, p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const seed = await getSeed(p.tmdbId);
    const params = new URLSearchParams({
      title: p.title, mediaType: p.mediaType, totalSeasons: String(p.totalSeasons),
      seasonId: String(p.seasonId), episodeId: String(p.episodeId),
      tmdbId: p.tmdbId, imdbId: p.imdbId, b35ebba4: p.b35ebba4,
      enc: '2', seed,
    });
    const r = await upstreamFetch(`${STREAM_API}/${server}/sources?${params}`, { headers: HDRS });
    if (r.status === 401 && attempt === 0) { seedCache.delete(p.tmdbId); continue; }
    if (!r.ok) throw new Error(`${server} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const ct = await r.text();
    return JSON.parse(decrypt(ct, seed, p.tmdbId));
  }
  throw new Error('exhausted seed retries');
}

// ===== TMDB lookup =====
async function getTmdbMeta(tmdbId, typeHint) {
  const types = typeHint ? [typeHint, typeHint === 'tv' ? 'movie' : 'tv'] : ['tv', 'movie'];
  for (const t of types) {
    const url = `https://api.themoviedb.org/3/${t}/${tmdbId}?api_key=${TMDB_KEY}&append_to_response=external_ids`;
    const r = await upstreamFetch(url, {}, { proxy: PROXY_TMDB });
    if (r.ok) {
      const d = await r.json();
      return {
        title: d.name || d.title,
        imdbId: d.external_ids?.imdb_id,
        totalSeasons: d.number_of_seasons || 1,
        mediaType: t,
      };
    }
  }
  throw new Error(`TMDB lookup failed for id ${tmdbId}`);
}

// ===== b35ebba4 anti-leak token =====
const XOR_KEY = '8c465aa8af6cbfd4c1f91bf0c8d678ba';
function computeB35ebba4(title, tmdbId) {
  const k = XOR_KEY.split('').map(c => c.charCodeAt(0));
  const hex = (title + tmdbId).split('')
    .map(c => c.charCodeAt(0))
    .map(code => k.reduce((a, x) => a ^ x, code))
    .map(b => ('0' + b.toString(16)).slice(-2))
    .join('');
  return Buffer.from(hex, 'utf-8').toString('base64');
}

// ===== Routes =====
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    name: 'Movy API Proxy',
    description: 'Get decrypted stream sources from movy.sx by TMDB ID + server name/number.',
    endpoints: {
      'GET /api/movie/:id': 'Movie sources — /api/movie/20526?server=miami&worker=1',
      'GET /api/tv/:id/:season/:episode': 'TV sources — /api/tv/273207/1/1?server=miami&worker=1 (season/episode default to 1)',
      'GET /api/servers': 'List available servers',
    },
    usage: '/api/tv/273207/1/1?server=miami&worker=1   |   /api/movie/20526?server=miami&data=en',
    params: {
      server: 'Server name (miami, boise, ...) OR 1-indexed number (1-16)',
      season: 'Season number (default 1, TV only)',
      episode: 'Episode number (default 1, TV only)',
      type: 'tv or movie (default: auto-detect, tries tv first)',
      worker: 'Set worker=1 to rewrite stream + subtitle URLs through the CF worker (default off)',
      data: 'Set data=en to replace stream + subtitle URLs with AES-256-GCM tokens (v1.*) that play through the EN decryptor worker — raw upstream URLs never appear in the response',
    },
    proxy: {
      enabled: PROXY_ENABLED && !!proxyAgent,
      host: PROXY_HOST,
      port: PROXY_PORT,
      tmdbThroughProxy: PROXY_TMDB,
      fallbackDirect: PROXY_FALLBACK_DIRECT,
    },
    workerUrl: WORKER_BASE,
    workerUrlEn: WORKER_URL_EN,
    servers: SERVERS.map((name, i) => ({ id: i + 1, name })),
    caching: `Successful responses cached for ${CACHE_TTL / 60000} min. Failures are NOT cached.`,
  });
});

router.get('/api/servers', (req, res) => {
  res.json(SERVERS.map((name, i) => ({ id: i + 1, name })));
});

// ===== Shared handler (movie + tv path-style routes) =====
async function handleStream(req, res, { fixedType } = {}) {
  const tmdbId = req.params.id;
  let server = req.query.server;

  if (!server) {
    return res.status(400).json({
      error: 'Missing ?server= parameter',
      hint: 'Use server name (e.g. ?server=miami) or 1-indexed number (e.g. ?server=1)',
      available: SERVERS.map((name, i) => ({ id: i + 1, name })),
    });
  }

  if (/^\d+$/.test(server)) {
    const idx = parseInt(server, 10) - 1;
    if (idx < 0 || idx >= SERVERS.length) {
      return res.status(400).json({ error: `Invalid server number. Use 1-${SERVERS.length}` });
    }
    server = SERVERS[idx];
  } else {
    server = String(server).toLowerCase();
    if (!SERVERS.includes(server)) {
      return res.status(400).json({ error: `Unknown server "${server}"`, available: SERVERS });
    }
  }

  // Path params (tv route) take precedence, then query params, then defaults
  const season = parseInt(req.params.season, 10) || parseInt(req.query.season, 10) || 1;
  const episode = parseInt(req.params.episode, 10) || parseInt(req.query.episode, 10) || 1;
  const typeHint = fixedType || req.query.type;
  const useWorker = ['1', 'true', 'yes', 'on'].includes(String(req.query.worker || '').toLowerCase());
  const encrypt = String(req.query.data || '').trim().toLowerCase() === 'en';

  const cacheKey = `${tmdbId}:${server}:${season}:${episode}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    // Cache stores RAW (unwrapped) URLs — worker rewriting happens at serve time
    const data = applyWorker(cached.data, useWorker, encrypt);
    return res.json({
      ...data, server, worker: useWorker, cached: true,
      ...(encrypt ? { note: 'Stream URLs are AES-256-GCM tokens (v1.*) — they play through the EN decryptor worker' } : {}),
      cacheExpiresAt: new Date(cached.expiresAt).toISOString(),
    });
  }

  try {
    const meta = await getTmdbMeta(tmdbId, typeHint);
    const b35ebba4 = computeB35ebba4(meta.title, tmdbId);
    const params = {
      title: meta.title, mediaType: meta.mediaType, totalSeasons: meta.totalSeasons,
      seasonId: season, episodeId: episode, tmdbId, imdbId: meta.imdbId, b35ebba4,
    };

    const result = await getSources(server, params);

    // Cache ONLY on success
    cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });

    const payload = applyWorker(result, useWorker, encrypt);
    res.json({
      server, tmdbId, title: meta.title, mediaType: meta.mediaType,
      imdbId: meta.imdbId, season, episode, worker: useWorker, cached: false,
      ...(encrypt ? { note: 'Stream URLs are AES-256-GCM tokens (v1.*) — they play through the EN decryptor worker' } : {}),
      ...payload,
    });
  } catch (e) {
    res.status(502).json({ error: e.message, server, tmdbId });
  }
}

// GET /api/movie/:id?server=... — movie sources
router.get('/api/movie/:id', (req, res) => handleStream(req, res, { fixedType: 'movie' }));

// GET /api/tv/:id/:season/:episode?server=... — TV sources (season/episode optional, default 1)
router.get('/api/tv/:id/:season?/:episode?', (req, res) => handleStream(req, res, { fixedType: 'tv' }));

module.exports = router;

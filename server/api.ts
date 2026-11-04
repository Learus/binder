// Local API served by the Vite dev/preview server:
//   GET    /api/search?game=mtg|pokemon|ygo&q=...&page=1
//   GET    /api/img?u=<remote image url>     (downloads once, then serves from data/images)
//   GET    /api/binders                       (summaries)
//   GET    /api/binders/:id
//   PUT    /api/binders/:id                   (body: full binder JSON)
//   DELETE /api/binders/:id
//   GET    /api/table                         (which binder sits in which table slot)
//   PUT    /api/table
import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// The image cache is capped (500 MB by default, BINDER_IMAGE_CACHE_MB to
// change it). Past the cap, the least recently used images are deleted until
// the cache is back under 90% of it; they download again if needed.
const CACHE_LIMIT = (Number(process.env.BINDER_IMAGE_CACHE_MB) || 500) * 1024 * 1024;
let cacheBytes: number | null = null;
let pruning: Promise<void> | null = null;

let DATA_DIR = '';
let IMG_DIR = '';
let BINDER_DIR = '';
let TABLE_FILE = '';

/** Where binders, the table layout and the image cache live. */
export function setDataDir(dir: string) {
  DATA_DIR = dir;
  IMG_DIR = path.join(dir, 'images');
  BINDER_DIR = path.join(dir, 'binders');
  TABLE_FILE = path.join(dir, 'table.json');
  cacheBytes = null;
}
setDataDir(process.env.BINDER_DATA_DIR ?? path.resolve(process.cwd(), 'data'));
const USER_AGENT = 'LocalCardBinder/0.1 (personal, non-commercial)';
const IMAGE_HOSTS = new Set([
  'cards.scryfall.io',
  'backs.scryfall.io',
  'images.ygoprodeck.com',
  'assets.tcgdex.net',
  'images.pokemontcg.io',
  'tcg.pokemon.com',
]);
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface CardRef {
  game: 'mtg' | 'pokemon' | 'ygo';
  id: string;
  name: string;
  set: string;
  number: string;
  thumb: string;
  image: string;
  large: string;
  back?: string;
}

export function apiPlugin(): Plugin {
  const mw = middleware();
  return {
    name: 'binder-api',
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

/** The API as a plain Node handler; calls `next` for anything outside /api/. */
export function middleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    handle(req, res, url).catch((err) => {
      console.error('[api]', err);
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
  const p = url.pathname;
  if (p === '/api/search' && req.method === 'GET') return search(res, url);
  if (p === '/api/img' && req.method === 'GET') return image(res, url);
  if (p === '/api/binders' && req.method === 'GET') return listBinders(res);
  if (p === '/api/table' && req.method === 'GET') {
    try {
      res.setHeader('Content-Type', 'application/json');
      return res.end(await fs.readFile(TABLE_FILE));
    } catch {
      return sendJson(res, 200, { slots: [] });
    }
  }
  if (p === '/api/table' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body?.slots)) return sendJson(res, 400, { error: 'slots missing' });
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TABLE_FILE, JSON.stringify({ slots: body.slots }));
    return sendJson(res, 200, { ok: true });
  }

  const m = p.match(/^\/api\/binders\/([a-z0-9-]{1,64})$/);
  if (m) {
    const file = path.join(BINDER_DIR, `${m[1]}.json`);
    if (req.method === 'GET') {
      try {
        res.setHeader('Content-Type', 'application/json');
        return res.end(await fs.readFile(file));
      } catch {
        return sendJson(res, 404, { error: 'not found' });
      }
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const binder = JSON.parse(body);
      if (binder?.id !== m[1]) return sendJson(res, 400, { error: 'id mismatch' });
      await fs.mkdir(BINDER_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(binder, null, 1));
      await fs.rename(tmp, file);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await fs.rm(file, { force: true });
      return sendJson(res, 200, { ok: true });
    }
  }
  sendJson(res, 404, { error: 'unknown endpoint' });
}

// ---------- binders ----------

async function listBinders(res: ServerResponse) {
  await fs.mkdir(BINDER_DIR, { recursive: true });
  const files = (await fs.readdir(BINDER_DIR)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const b = JSON.parse(await fs.readFile(path.join(BINDER_DIR, f), 'utf8'));
      const cards = (b.pages as unknown[][]).flat().filter(Boolean).length;
      out.push({
        id: b.id,
        name: b.name,
        updatedAt: b.updatedAt,
        cards,
        cover: b.cover,
        sheets: b.pages.length / 2,
        layout: b.layout,
      });
    } catch (err) {
      console.warn('[api] skipping unreadable binder', f, err);
    }
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  sendJson(res, 200, out);
}

// ---------- image cache ----------

const inflight = new Map<string, Promise<string>>();

async function image(res: ServerResponse, url: URL) {
  const remote = url.searchParams.get('u') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.has(parsed.hostname)) {
    return sendJson(res, 403, { error: 'host not allowed' });
  }

  let file = inflight.get(remote);
  if (!file) {
    file = cachedImage(remote).finally(() => inflight.delete(remote));
    inflight.set(remote, file);
  }
  const filePath = await file;
  const ext = path.extname(filePath).slice(1);
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(await fs.readFile(filePath));
}

async function cachedImage(remote: string): Promise<string> {
  const hash = crypto.createHash('sha1').update(remote).digest('hex');
  await fs.mkdir(IMG_DIR, { recursive: true });
  for (const ext of Object.keys(MIME)) {
    const candidate = path.join(IMG_DIR, `${hash}.${ext}`);
    try {
      // The modification time doubles as "last used", for eviction.
      const now = new Date();
      await fs.utimes(candidate, now, now);
      void trackCache(0);
      return candidate;
    } catch {
      // not cached under this extension
    }
  }
  const r = await limited(() => fetch(remote, { headers: { 'User-Agent': USER_AGENT } }));
  if (!r.ok) throw new Error(`image fetch ${r.status} for ${remote}`);
  const type = r.headers.get('content-type') ?? '';
  const ext = Object.entries(MIME).find(([, m]) => type.startsWith(m))?.[0] ?? 'jpg';
  const out = path.join(IMG_DIR, `${hash}.${ext}`);
  const data = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(out, data);
  void trackCache(data.length);
  return out;
}

async function trackCache(added: number) {
  if (cacheBytes === null) cacheBytes = (await cacheFiles()).reduce((sum, f) => sum + f.size, 0);
  else cacheBytes += added;
  if (cacheBytes > CACHE_LIMIT && !pruning) {
    pruning = pruneCache()
      .catch((err) => console.warn('[api] pruning image cache failed', err))
      .finally(() => (pruning = null));
  }
}

async function cacheFiles() {
  const names = await fs.readdir(IMG_DIR).catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(IMG_DIR, name);
      const st = await fs.stat(file).catch(() => null);
      return st?.isFile() ? { file, size: st.size, used: st.mtimeMs } : null;
    }),
  );
  return files.filter((f): f is { file: string; size: number; used: number } => f !== null);
}

async function pruneCache() {
  const files = (await cacheFiles()).sort((a, b) => a.used - b.used);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  // Skip anything used in the last minute, so an image that is being served right now stays.
  const recent = Date.now() - 60_000;
  for (const f of files) {
    if (total <= CACHE_LIMIT * 0.9) break;
    if (f.used > recent) continue;
    await fs.rm(f.file, { force: true });
    total -= f.size;
  }
  cacheBytes = total;
}

// Keep remote load polite: at most 6 downloads at a time.
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// ---------- search ----------

async function search(res: ServerResponse, url: URL) {
  const game = url.searchParams.get('game');
  const q = (url.searchParams.get('q') ?? '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  if (!q) return sendJson(res, 200, { cards: [], hasMore: false });

  let result: { cards: CardRef[]; hasMore: boolean };
  if (game === 'mtg') result = await searchScryfall(q, page);
  else if (game === 'pokemon') result = await searchTcgdex(q, page);
  else if (game === 'ygo') result = await searchYgo(q, page);
  else return sendJson(res, 400, { error: 'unknown game' });
  sendJson(res, 200, result);
}

async function getJson(u: string): Promise<{ status: number; body: any }> {
  const r = await fetch(u, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON error page
  }
  return { status: r.status, body };
}

async function searchScryfall(q: string, page: number) {
  const u = new URL('https://api.scryfall.com/cards/search');
  u.searchParams.set('q', q);
  u.searchParams.set('unique', 'prints');
  u.searchParams.set('order', 'released');
  u.searchParams.set('page', String(page));
  const { status, body } = await getJson(u.toString());
  if (status === 404) return { cards: [], hasMore: false };
  if (status !== 200) throw new Error(body?.details ?? `Scryfall returned ${status}`);

  const cards: CardRef[] = [];
  for (const c of body.data) {
    const front = c.image_uris ?? c.card_faces?.[0]?.image_uris;
    if (!front) continue;
    const back = c.image_uris ? undefined : c.card_faces?.[1]?.image_uris?.large;
    cards.push({
      game: 'mtg',
      id: c.id,
      name: c.name,
      set: c.set_name,
      number: c.collector_number,
      thumb: front.normal,
      image: front.normal,
      large: front.large,
      back,
    });
  }
  return { cards, hasMore: Boolean(body.has_more) };
}

let tcgdexSets: Promise<Map<string, string>> | null = null;
function pokemonSets() {
  tcgdexSets ??= getJson('https://api.tcgdex.net/v2/en/sets').then(({ body }) => {
    const map = new Map<string, string>();
    for (const s of body ?? []) map.set(s.id, s.name);
    return map;
  });
  return tcgdexSets;
}

// TCGdex has no images for some cards, mostly secret rares, gold cards,
// subsets (Shiny Vault, Galarian Gallery, Classic Collection) and promos.
// The Pokémon TCG API's card data on GitHub has most of them.
const PTCG_DATA = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const normNumber = (n: string) => norm(n).replace(/^0+(?=\d)/, '');

let ptcgSetIds: Promise<{
  ids: Set<string>;
  byName: Map<string, string>;
}> | null = null;
function ptcgSets() {
  ptcgSetIds ??= getJson(`${PTCG_DATA}/sets/en.json`)
    .catch(() => ({ body: null }))
    .then(({ body }) => {
      const ids = new Set<string>();
      const byName = new Map<string, string>();
      for (const s of Array.isArray(body) ? body : []) {
        ids.add(s.id);
        byName.set(norm(s.name), s.id);
      }
      if (!ids.size) ptcgSetIds = null;
      return { ids, byName };
    });
  return ptcgSetIds;
}

type PtcgCard = {
  number: string;
  name: string;
  images: { small: string; large: string };
};
const ptcgSetCards = new Map<string, Promise<PtcgCard[]>>();
function ptcgCards(setId: string) {
  let p = ptcgSetCards.get(setId);
  if (!p) {
    p = getJson(`${PTCG_DATA}/cards/en/${setId}.json`)
      .catch(() => ({ body: null }))
      .then(({ body }) => {
        if (!Array.isArray(body)) ptcgSetCards.delete(setId);
        return Array.isArray(body) ? body : [];
      });
    ptcgSetCards.set(setId, p);
  }
  return p;
}

/** Images for a TCGdex card from the Pokémon TCG data: same set, then same number or a unique name. */
async function ptcgImages(setId: string, setName: string, number: string, name: string) {
  const { ids, byName } = await ptcgSets();
  const ptSet =
    [setId.replace(/\./g, ''), setId.replace(/\.5/g, 'pt5')].find((i) => ids.has(i)) ?? byName.get(norm(setName));
  if (!ptSet) return null;
  const cards = await ptcgCards(ptSet);
  const num = normNumber(number);
  const named = cards.filter((c) => norm(c.name) === norm(name));
  const hit =
    named.find((c) => normNumber(c.number) === num) ??
    cards.find((c) => normNumber(c.number) === num && norm(c.name).startsWith(norm(name).slice(0, 4))) ??
    (named.length === 1 ? named[0] : undefined);
  return hit?.images ?? null;
}

async function searchTcgdex(q: string, page: number) {
  const per = 60;
  const u = new URL('https://api.tcgdex.net/v2/en/cards');
  u.searchParams.set('name', q);
  u.searchParams.set('pagination:page', String(page));
  u.searchParams.set('pagination:itemsPerPage', String(per));
  const [{ status, body }, sets] = await Promise.all([getJson(u.toString()), pokemonSets()]);
  if (status === 404) return { cards: [], hasMore: false };
  if (status !== 200) throw new Error(`TCGdex returned ${status}`);

  const found = await Promise.all(
    (body as any[]).map(async (c): Promise<CardRef | null> => {
      const setId = c.id.slice(0, c.id.length - c.localId.length - 1);
      const set = sets.get(setId) ?? setId;
      const card = {
        game: 'pokemon' as const,
        id: c.id,
        name: c.name,
        set,
        number: c.localId,
      };
      if (c.image) {
        return {
          ...card,
          thumb: `${c.image}/low.webp`,
          image: `${c.image}/high.webp`,
          large: `${c.image}/high.webp`,
        };
      }
      const img = await ptcgImages(setId, set, c.localId, c.name).catch(() => null);
      return img && { ...card, thumb: img.small, image: img.large, large: img.large };
    }),
  );
  return {
    cards: found.filter((c) => c !== null),
    hasMore: body.length === per,
  };
}

async function searchYgo(q: string, page: number) {
  const per = 40;
  const u = new URL('https://db.ygoprodeck.com/api/v7/cardinfo.php');
  u.searchParams.set('fname', q);
  u.searchParams.set('num', String(per));
  u.searchParams.set('offset', String((page - 1) * per));
  const { status, body } = await getJson(u.toString());
  if (status === 400 && body?.error) return { cards: [], hasMore: false };
  if (status !== 200) throw new Error(`YGOPRODeck returned ${status}`);

  const cards: CardRef[] = [];
  for (const c of body.data) {
    for (const img of c.card_images ?? []) {
      cards.push({
        game: 'ygo',
        id: String(img.id),
        name: c.name,
        set: c.humanReadableCardType ?? c.type,
        number: c.card_sets?.[0]?.set_code ?? '',
        thumb: img.image_url_small,
        image: img.image_url,
        large: img.image_url,
      });
    }
  }
  return { cards, hasMore: (body.meta?.rows_remaining ?? 0) > 0 };
}

// ---------- helpers ----------

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 20_000_000) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

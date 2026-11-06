// Local API served by the Vite dev/preview server:
//   GET    /api/search?game=mtg|pokemon|ygo&q=...&page=1  (optional: type, set, word=1)
//   GET    /api/sets?game=mtg|pokemon|ygo     (sets to filter by, newest first)
//   GET    /api/prices?game&id&name&foil&number  (TCGplayer / Cardmarket prices)
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
import { cardPrices } from './prices';

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
  'img.yugipedia.com',
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
  /** Short rarity code of this printing, e.g. UR or SIR, when the source says. */
  rarity?: string;
  /** Yu-Gi-Oh! card type, e.g. Effect Monster. */
  kind?: string;
  /** Release date (YYYY-MM-DD) of the set this printing is from, when known. */
  released?: string;
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
  if (p === '/api/sets' && req.method === 'GET') return listSets(res, url);
  if (p === '/api/prices' && req.method === 'GET') {
    const v = (k: string) => url.searchParams.get(k) ?? '';
    return sendJson(res, 200, await cardPrices({ game: v('game'), id: v('id'), name: v('name'), foil: v('foil'), number: v('number') }));
  }
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

type Query = { q: string; page: number; type: string; set: string; word: boolean };
type Result = { cards: CardRef[]; hasMore: boolean };

async function search(res: ServerResponse, url: URL) {
  const game = url.searchParams.get('game');
  const query: Query = {
    q: (url.searchParams.get('q') ?? '').trim(),
    page: Math.max(1, Number(url.searchParams.get('page')) || 1),
    type: url.searchParams.get('type') ?? '',
    set: url.searchParams.get('set') ?? '',
    word: url.searchParams.get('word') === '1',
  };
  if (!query.q && !query.type && !query.set) return sendJson(res, 200, { cards: [], hasMore: false });

  let result: Result;
  if (game === 'mtg') result = await searchScryfall(query);
  else if (game === 'pokemon') result = await searchTcgdex(query);
  else if (game === 'ygo') result = await searchYgo(query);
  else return sendJson(res, 400, { error: 'unknown game' });
  sendJson(res, 200, result);
}

type SetInfo = { id: string; name: string; date: string };

async function listSets(res: ServerResponse, url: URL) {
  const game = url.searchParams.get('game');
  const sets = game === 'mtg' ? await scryfallSets() : game === 'pokemon' ? await tcgdexSetList() : game === 'ygo' ? await ygoSets() : null;
  if (!sets) return sendJson(res, 400, { error: 'unknown game' });
  sendJson(res, 200, sets);
}

/** A whole-word, case-insensitive test for q, or null when q is empty. */
function wordTest(q: string) {
  if (!q) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  return (name: string) => re.test(name);
}

const byDateDesc = (a: SetInfo, b: SetInfo) => b.date.localeCompare(a.date);

/** Caches a list fetch; a failed one is tried again next time. */
function cached<T>(load: () => Promise<T>) {
  let p: Promise<T> | null = null;
  return () => {
    p ??= load().catch((err) => {
      p = null;
      throw err;
    });
    return p;
  };
}

async function getJson(u: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const r = await fetch(u, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init?.headers },
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

// ----- Magic: Scryfall -----

const MTG_TYPES = new Set(['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'land', 'battle']);
const MTG_RARITY: Record<string, string> = { common: 'C', uncommon: 'U', rare: 'R', mythic: 'M', special: 'S', bonus: 'B' };

const scryfallSets = cached(async () => {
  const { status, body } = await getJson('https://api.scryfall.com/sets');
  if (status !== 200) throw new Error(`Scryfall returned ${status}`);
  return (body.data as any[])
    .filter((s) => !s.digital)
    .map((s): SetInfo => ({ id: s.code, name: s.name, date: s.released_at ?? '' }))
    .sort(byDateDesc);
});

async function searchScryfall({ q, page, type, set, word }: Query): Promise<Result> {
  const parts: string[] = [];
  // Whole words: a name regex (Scryfall's regexes ignore case).
  if (q) parts.push(word ? `name:/\\b${q.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b/` : q);
  if (MTG_TYPES.has(type)) parts.push(`t:${type}`);
  if (/^[a-z0-9]+$/i.test(set)) parts.push(`s:${set}`);
  const u = new URL('https://api.scryfall.com/cards/search');
  u.searchParams.set('q', parts.join(' '));
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
      ...(MTG_RARITY[c.rarity] ? { rarity: MTG_RARITY[c.rarity] } : {}),
    });
  }
  return { cards, hasMore: Boolean(body.has_more) };
}

// ----- Pokémon: TCGdex -----

const tcgdexSetList = cached(async () => {
  const { status, body } = await getJson('https://api.tcgdex.net/v2/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ sets { id name releaseDate } }' }),
  });
  if (status !== 200 || !Array.isArray(body?.data?.sets)) throw new Error(`TCGdex returned ${status}`);
  return (body.data.sets as any[]).map((s): SetInfo => ({ id: s.id, name: s.name, date: s.releaseDate ?? '' })).sort(byDateDesc);
});

async function pokemonSets() {
  return new Map((await tcgdexSetList().catch(() => [] as SetInfo[])).map((s) => [s.id, s.name]));
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

/** The filter's TCGdex category and trainer type. */
const POKEMON_TYPES: Record<string, { category: string; trainerType?: string }> = {
  pokemon: { category: 'Pokemon' },
  trainer: { category: 'Trainer' },
  supporter: { category: 'Trainer', trainerType: 'Supporter' },
  item: { category: 'Trainer', trainerType: 'Item' },
  tool: { category: 'Trainer', trainerType: 'Tool' },
  stadium: { category: 'Trainer', trainerType: 'Stadium' },
  energy: { category: 'Energy' },
};

/** Short codes for TCGdex's rarity names; anything else gets its initials. */
const POKEMON_RARITY: Record<string, string> = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  'holo rare': 'H',
  'rare holo': 'H',
  'holo rare v': 'V',
  'holo rare vmax': 'VMAX',
  'holo rare vstar': 'VSTAR',
  'double rare': 'RR',
  'ultra rare': 'UR',
  'illustration rare': 'IR',
  'special illustration rare': 'SIR',
  'hyper rare': 'HR',
  'mega hyper rare': 'MHR',
  'secret rare': 'SR',
  'shiny rare': 'S',
  'shiny ultra rare': 'SSR',
  'ace spec rare': 'ACE',
  'amazing rare': 'A',
  'radiant rare': 'K',
  'rare prime': 'PRIME',
  'legend': 'LEGEND',
  'rare holo lv.x': 'LV.X',
  'black white rare': 'BWR',
  'full art trainer': 'FA',
  'classic collection': 'CC',
  promo: 'PR',
};
function pokemonRarity(r: unknown) {
  if (typeof r !== 'string' || !r || r === 'None') return undefined;
  const key = r.toLowerCase();
  return POKEMON_RARITY[key] ?? r.split(/\s+/).map((w) => w[0].toUpperCase()).join('');
}

async function tcgdexQuery(query: string) {
  const { status, body } = await getJson('https://api.tcgdex.net/v2/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  // A card whose field breaks the schema comes back null with an error
  // beside the rest, so errors only count when there is no data.
  if (status !== 200 || !body?.data) throw new Error(body?.errors?.[0]?.message ?? `TCGdex returned ${status}`);
  return body.data;
}

/**
 * TCGdex cards from a GraphQL selection that ends in "{ fields }". A card
 * without a rarity breaks TCGdex's schema and comes back null when it is
 * asked for, so the rarities come from their own query, matched up by id.
 */
async function tcgdexCards(select: (fields: string) => string, list: (data: any) => any[] | undefined) {
  const extra = ['rarity'] as const;
  const [cards, ...more] = await Promise.all([
    tcgdexQuery(select('id localId name image')),
    ...extra.map((f) => tcgdexQuery(select(`id ${f}`)).catch(() => null)),
  ]);
  const values = extra.map((f, i) => {
    const m = new Map<string, string>();
    for (const c of (more[i] && list(more[i])) ?? []) if (c?.[f]) m.set(c.id, c[f]);
    return m;
  });
  return (list(cards) ?? [])
    .filter(Boolean)
    .map((c) => ({ ...c, ...Object.fromEntries(extra.map((f, i) => [f, values[i].get(c.id)])) }));
}

async function searchTcgdex({ q, page, type, set, word }: Query): Promise<Result> {
  const per = 60;
  const kind = POKEMON_TYPES[type];
  // TCGdex has no set filter, but every card id starts with its set's id.
  const filters = [
    set && `id: ${JSON.stringify(`${set}-`)}`,
    q && `name: ${JSON.stringify(q)}`,
    kind && `category: ${JSON.stringify(kind.category)}`,
    kind?.trainerType && `trainerType: ${JSON.stringify(kind.trainerType)}`,
  ]
    .filter(Boolean)
    .join(', ');
  let list = await tcgdexCards(
    (fields) => `{ cards(filters: {${filters}}, pagination: {page: ${page}, itemsPerPage: ${per}}) { ${fields} } }`,
    (d) => d.cards,
  );
  const hasMore = list.length === per;
  if (set) list = list.filter((c) => c.id.startsWith(`${set}-`));
  const whole = word ? wordTest(q) : null;
  if (whole) list = list.filter((c) => whole(c.name));
  const sets = await pokemonSets();

  const found = await Promise.all(
    list.map(async (c): Promise<CardRef | null> => {
      const setId = c.id.slice(0, c.id.length - c.localId.length - 1);
      const setName = sets.get(setId) ?? setId;
      const rarity = pokemonRarity(c.rarity);
      const card = {
        game: 'pokemon' as const,
        id: c.id,
        name: c.name,
        set: setName,
        number: c.localId,
        ...(rarity ? { rarity } : {}),
      };
      if (c.image) {
        return {
          ...card,
          thumb: `${c.image}/low.webp`,
          image: `${c.image}/high.webp`,
          large: `${c.image}/high.webp`,
        };
      }
      const img = await ptcgImages(setId, setName, c.localId, c.name).catch(() => null);
      return img && { ...card, thumb: img.small, image: img.large, large: img.large };
    }),
  );
  return { cards: found.filter((c) => c !== null), hasMore };
}

// ----- Yu-Gi-Oh!: YGOPRODeck -----

const YGO_MONSTERS: Record<string, string[]> = {
  normal: ['Normal Monster', 'Normal Tuner Monster'],
  effect: [
    'Effect Monster',
    'Flip Effect Monster',
    'Flip Tuner Effect Monster',
    'Gemini Monster',
    'Spirit Monster',
    'Toon Monster',
    'Tuner Monster',
    'Union Effect Monster',
  ],
  ritual: ['Ritual Monster', 'Ritual Effect Monster', 'Pendulum Effect Ritual Monster'],
  fusion: ['Fusion Monster', 'Pendulum Effect Fusion Monster'],
  synchro: ['Synchro Monster', 'Synchro Tuner Monster', 'Synchro Pendulum Effect Monster'],
  xyz: ['XYZ Monster', 'XYZ Pendulum Effect Monster'],
  pendulum: [
    'Pendulum Effect Monster',
    'Pendulum Normal Monster',
    'Pendulum Flip Effect Monster',
    'Pendulum Tuner Effect Monster',
    'Pendulum Effect Ritual Monster',
    'Pendulum Effect Fusion Monster',
    'Synchro Pendulum Effect Monster',
    'XYZ Pendulum Effect Monster',
  ],
  link: ['Link Monster'],
};
const YGO_TYPES: Record<string, string[]> = {
  ...YGO_MONSTERS,
  monster: [...new Set(Object.values(YGO_MONSTERS).flat())],
  spell: ['Spell Card'],
  trap: ['Trap Card'],
};

const ygoSets = cached(async () => {
  const { status, body } = await getJson('https://db.ygoprodeck.com/api/v7/cardsets.php');
  if (status !== 200 || !Array.isArray(body)) throw new Error(`YGOPRODeck returned ${status}`);
  const seen = new Set<string>();
  return (body as any[])
    .filter((s) => !seen.has(s.set_name) && seen.add(s.set_name))
    .map((s): SetInfo => ({ id: s.set_name, name: s.set_name, date: s.tcg_date ?? '' }))
    .sort(byDateDesc);
});

async function searchYgo({ q, page, type, set, word }: Query): Promise<Result> {
  const per = 40;
  const u = new URL('https://db.ygoprodeck.com/api/v7/cardinfo.php');
  if (q) u.searchParams.set('fname', q);
  if (YGO_TYPES[type]) u.searchParams.set('type', YGO_TYPES[type].join(','));
  if (set) u.searchParams.set('cardset', set);
  u.searchParams.set('num', String(per));
  u.searchParams.set('offset', String((page - 1) * per));
  const [{ status, body }, sets] = await Promise.all([getJson(u.toString()), ygoSets().catch(() => [] as SetInfo[])]);
  if (status === 400 && body?.error) return { cards: [], hasMore: false };
  if (status !== 200) throw new Error(`YGOPRODeck returned ${status}`);
  const released = new Map(sets.map((s) => [s.name, s.date || '9999']));
  const whole = word ? wordTest(q) : null;

  const cards: CardRef[] = [];
  for (const c of body.data) {
    if (whole && !whole(c.name)) continue;
    const printings: any[] = c.card_sets ?? [];
    // In a chosen set, each of its printings, once per rarity (the regional
    // codes of one printing are listed separately); otherwise the card's
    // first printing.
    const rarities = new Set<string>();
    const shown = set
      ? printings.filter((p) => p.set_name === set && !rarities.has(p.set_rarity) && rarities.add(p.set_rarity))
      : printings.slice().sort((a, b) => (released.get(a.set_name) ?? '9999').localeCompare(released.get(b.set_name) ?? '9999')).slice(0, 1);
    // Filtered by set, the images repeat once per regional printing too.
    const images = [...new Map((c.card_images ?? []).map((img: any) => [img.id, img])).values()] as any[];
    for (const img of images) {
      for (const p of shown.length ? shown : [null]) {
        const rarity = p?.set_rarity_code?.replace(/[()]/g, '');
        const date = p ? released.get(p.set_name) : undefined;
        cards.push({
          game: 'ygo',
          id: String(img.id),
          name: c.name,
          set: p?.set_name ?? c.humanReadableCardType ?? c.type,
          number: p?.set_code ?? '',
          thumb: img.image_url_small,
          image: img.image_url,
          large: img.image_url,
          kind: c.humanReadableCardType ?? c.type,
          ...(rarity ? { rarity } : {}),
          ...(date && date !== '9999' ? { released: date } : {}),
        });
      }
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

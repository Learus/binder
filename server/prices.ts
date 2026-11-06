// Card prices from sources that need no API key:
//   Pokémon: TCGdex, which carries TCGplayer and Cardmarket prices per variant.
//   Magic: Scryfall, one TCGplayer and one Cardmarket price per printing and finish.
//   Yu-Gi-Oh!: YGOPRODeck, one price per printing, plus the card's cheapest
//   TCGplayer and Cardmarket prices over all printings.

export interface PriceRow {
  source: string;
  currency: 'USD' | 'EUR';
  low: number | null;
  trend: number | null;
  high: number | null;
  url?: string;
}

export interface PriceGroup {
  title: string;
  note?: string;
  rows: PriceRow[];
}

export interface CardPrices {
  groups: PriceGroup[];
  /** Where to look the card up on each marketplace. */
  links: { source: string; url: string }[];
}

export interface PriceQuery {
  game: string;
  id: string;
  name: string;
  foil: string;
  number: string;
}

const USER_AGENT = 'LocalCardBinder/0.1 (personal, non-commercial)';
const TTL = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<CardPrices> }>();

const SLUGS: Record<string, { tcgplayer: string; cardmarket: string; cardtrader: string }> = {
  pokemon: { tcgplayer: 'pokemon', cardmarket: 'Pokemon', cardtrader: 'pokemon' },
  mtg: { tcgplayer: 'magic', cardmarket: 'Magic', cardtrader: 'magic' },
  ygo: { tcgplayer: 'yugioh', cardmarket: 'YuGiOh', cardtrader: 'yu-gi-oh' },
};

/** Search pages for the card's name on each marketplace. CardTrader's prices need an API token, so it only gets a link. */
function searchLinks(game: string, name: string) {
  const slug = SLUGS[game];
  if (!slug || !name) return [];
  const q = encodeURIComponent(name);
  return [
    { source: 'TCGplayer', url: `https://www.tcgplayer.com/search/${slug.tcgplayer}/product?q=${q}` },
    { source: 'Cardmarket', url: `https://www.cardmarket.com/en/${slug.cardmarket}/Products/Search?searchString=${q}` },
    { source: 'CardTrader', url: `https://www.cardtrader.com/en/${slug.cardtrader}?q=${q}` },
  ];
}

export function cardPrices(q: PriceQuery): Promise<CardPrices> {
  const key = JSON.stringify(q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = (q.game === 'pokemon' ? pokemon(q) : q.game === 'mtg' ? mtg(q) : q.game === 'ygo' ? ygo(q) : Promise.reject(new Error('unknown game')))
    .then((groups) => ({ groups, links: searchLinks(q.game, q.name) }))
    .catch(
    (err) => {
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(u: string): Promise<{ status: number; body: any }> {
  const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  let body: any = null;
  try {
    body = JSON.parse(await r.text());
  } catch {
    // non-JSON error page
  }
  return { status: r.status, body };
}

const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/** Low, median and high of the prices that exist. */
function spread(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return { low: v[0], trend: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, high: v[v.length - 1], count: v.length };
}

const hasPrice = (r: PriceRow) => r.low !== null || r.trend !== null || r.high !== null;

function group(title: string, rows: PriceRow[], note?: string): PriceGroup[] {
  const kept = rows.filter(hasPrice);
  return kept.length ? [{ title, rows: kept, ...(note ? { note } : {}) }] : [];
}

// ----- Pokémon -----

const TCGPLAYER_VARIANTS: Record<string, string[]> = {
  none: ['normal', '1st-edition-normal', 'unlimited-normal'],
  reverse: ['reverse-holofoil'],
};
const HOLO_VARIANTS = ['holofoil', '1st-edition-holofoil', 'unlimited-holofoil'];
const VARIANT_NAMES: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  'reverse-holofoil': 'Reverse holofoil',
  '1st-edition-holofoil': '1st edition holofoil',
  '1st-edition-normal': '1st edition',
  'unlimited-holofoil': 'Unlimited holofoil',
  'unlimited-normal': 'Unlimited',
};

async function pokemon(q: PriceQuery): Promise<PriceGroup[]> {
  const { status, body } = await getJson(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(q.id)}`);
  if (status === 404) return [];
  if (status !== 200) throw new Error(`TCGdex returned ${status}`);
  const tp = body?.pricing?.tcgplayer ?? {};
  const cm = body?.pricing?.cardmarket ?? {};
  const variants = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object');
  const wanted = TCGPLAYER_VARIANTS[q.foil] ?? HOLO_VARIANTS;
  const variant = wanted.find((v) => variants.includes(v)) ?? (q.foil === 'reverse' ? undefined : variants[0]);
  const t = variant ? tp[variant] : null;
  // Cardmarket's "holo" prices are its reverse holo version of the card.
  const rev = q.foil === 'reverse' && (num(cm['trend-holo']) || num(cm['low-holo']));
  const sfx = rev ? '-holo' : '';
  const rows: PriceRow[] = [
    {
      source: 'TCGplayer',
      currency: 'USD',
      low: num(t?.lowPrice),
      trend: num(t?.marketPrice) ?? num(t?.midPrice),
      high: num(t?.highPrice),
      ...(t?.productId ? { url: `https://www.tcgplayer.com/product/${t.productId}` } : {}),
    },
    {
      source: 'Cardmarket',
      currency: 'EUR',
      low: num(cm[`low${sfx}`]),
      trend: num(cm[`trend${sfx}`]) ?? num(cm[`avg${sfx}`]),
      high: null,
      ...(cm.idProduct ? { url: `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` } : {}),
    },
  ];
  const title = [body.set?.name, body.localId && `#${body.localId}`, VARIANT_NAMES[variant ?? ''] ?? variant].filter(Boolean).join(' · ');
  return group(title, rows);
}

// ----- Magic -----

function mtgFinish(foil: string) {
  return foil === 'none' ? { usd: 'usd', eur: 'eur', label: 'Non-foil' } : foil === 'etched' ? { usd: 'usd_etched', eur: 'eur_etched', label: 'Etched' } : { usd: 'usd_foil', eur: 'eur_foil', label: 'Foil' };
}

async function mtg(q: PriceQuery): Promise<PriceGroup[]> {
  const { status, body: card } = await getJson(`https://api.scryfall.com/cards/${encodeURIComponent(q.id)}`);
  if (status === 404) return [];
  if (status !== 200) throw new Error(card?.details ?? `Scryfall returned ${status}`);
  const f = mtgFinish(q.foil);
  const groups = group(`${card.set_name} #${card.collector_number} · ${f.label}`, [
    { source: 'TCGplayer', currency: 'USD', low: null, trend: num(card.prices?.[f.usd]), high: null, url: card.purchase_uris?.tcgplayer },
    { source: 'Cardmarket', currency: 'EUR', low: null, trend: num(card.prices?.[f.eur]), high: null, url: card.purchase_uris?.cardmarket },
  ]);

  // Every paper printing of the card, in the same finish.
  const prints: any[] = [];
  let next: string | null = card.prints_search_uri ?? null;
  for (let page = 0; next && page < 4; page++) {
    const { status: s, body } = await getJson(next);
    if (s !== 200) break;
    prints.push(...body.data);
    next = body.has_more ? body.next_page : null;
    if (next) await new Promise((r) => setTimeout(r, 100)); // Scryfall asks for 50–100 ms between requests
  }
  const paper = prints.filter((p) => !p.digital);
  const usd = spread(paper.map((p) => num(p.prices?.[f.usd])));
  const eur = spread(paper.map((p) => num(p.prices?.[f.eur])));
  if (paper.length > 1 && (usd || eur)) {
    const n = Math.max(usd?.count ?? 0, eur?.count ?? 0);
    groups.push(
      ...group(
        `${n} printings · ${f.label}`,
        [
          { source: 'TCGplayer', currency: 'USD', low: usd?.low ?? null, trend: usd?.trend ?? null, high: usd?.high ?? null },
          { source: 'Cardmarket', currency: 'EUR', low: eur?.low ?? null, trend: eur?.trend ?? null, high: eur?.high ?? null },
        ],
        'Cheapest, median and dearest printing.',
      ),
    );
  }
  return groups;
}

// ----- Yu-Gi-Oh! -----

/** The printed rarities each Yu-Gi-Oh! rarity setting stands for. */
const YGO_RARITIES: Record<string, string[]> = {
  none: ['Common', 'Short Print', 'Super Short Print'],
  rare: ['Rare'],
  super: ['Super Rare'],
  ultra: ['Ultra Rare', "Ultra Rare (Pharaoh's Rare)"],
  secret: ['Secret Rare', 'Prismatic Secret Rare', 'Platinum Secret Rare', 'Extra Secret Rare', 'Quarter Century Secret Rare'],
  ultimate: ['Ultimate Rare'],
  ghost: ['Ghost Rare', 'Ghost/Gold Rare'],
  starlight: ['Starlight Rare'],
  gold: ['Gold Rare', 'Premium Gold Rare'],
  goldsecret: ['Gold Secret Rare'],
};

async function ygo(q: PriceQuery): Promise<PriceGroup[]> {
  const byId = /^\d+$/.test(q.id) ? await getJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${q.id}`) : null;
  const res = byId?.status === 200 ? byId : await getJson(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(q.name)}`);
  const card = res.status === 200 ? res.body?.data?.[0] : null;
  if (!card) return [];
  const names = new Set(YGO_RARITIES[q.foil] ?? []);
  const rarity = YGO_RARITIES[q.foil]?.[0] ?? 'matching';
  const sets: any[] = (card.card_sets ?? []).filter((s: any) => names.has(s.set_rarity));
  const search = encodeURIComponent(card.name);
  const tcg = `https://www.tcgplayer.com/search/yugioh/product?q=${search}`;
  const groups: PriceGroup[] = [];

  const own = sets.find((s) => s.set_code === q.number);
  if (own) {
    groups.push(
      ...group(`${own.set_code} · ${own.set_rarity}`, [{ source: 'TCGplayer', currency: 'USD', low: null, trend: num(own.set_price), high: null, url: tcg }], 'From YGOPRODeck.'),
    );
  }
  const s = spread(sets.map((x) => num(x.set_price)));
  if (s && (sets.length > 1 || !own)) {
    const missing = sets.length - s.count;
    groups.push(
      ...group(
        `${sets.length} ${rarity} printing${sets.length > 1 ? 's' : ''}`,
        [{ source: 'TCGplayer', currency: 'USD', low: s.low, trend: s.trend, high: s.high, url: tcg }],
        `Cheapest, median and dearest printing, from YGOPRODeck${missing ? `; ${missing} without a price` : ''}.`,
      ),
    );
  }
  const any = card.card_prices?.[0] ?? {};
  groups.push(
    ...group(
      'Cheapest printing, any rarity',
      [
        { source: 'TCGplayer', currency: 'USD', low: null, trend: num(any.tcgplayer_price), high: null, url: tcg },
        {
          source: 'Cardmarket',
          currency: 'EUR',
          low: null,
          trend: num(any.cardmarket_price),
          high: null,
          url: `https://www.cardmarket.com/en/YuGiOh/Products/Search?searchString=${search}`,
        },
      ],
    ),
  );
  return groups;
}

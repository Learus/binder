import type { Binder, BinderSummary, CardRef, Game } from './types';

export function imgUrl(remote: string): string {
  return `/api/img?u=${encodeURIComponent(remote)}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface SearchFilters {
  /** A card type key from the game's type list, or '' for any. */
  type: string;
  /** A set id from listSets, or '' for any. */
  set: string;
  /** Match the name as whole words (ignoring case). */
  word: boolean;
}

export async function searchCards(game: Game, q: string, page: number, f: SearchFilters) {
  const params = new URLSearchParams({ game, q, page: String(page) });
  if (f.type) params.set('type', f.type);
  if (f.set) params.set('set', f.set);
  if (f.word) params.set('word', '1');
  return json<{ cards: CardRef[]; hasMore: boolean }>(await fetch(`/api/search?${params}`));
}

export interface SetInfo {
  id: string;
  name: string;
  /** Release date, YYYY-MM-DD, or '' when unknown. */
  date: string;
}

/** The game's sets, newest first. */
export async function listSets(game: Game) {
  return json<SetInfo[]>(await fetch(`/api/sets?game=${game}`));
}

export interface PriceRow {
  source: string;
  currency: 'USD' | 'EUR';
  low: number | null;
  trend: number | null;
  high: number | null;
  url?: string;
}

export interface CardPrices {
  groups: { title: string; note?: string; rows: PriceRow[] }[];
  /** Search pages for the card on each marketplace. */
  links: { source: string; url: string }[];
}

/** Prices of the card's printing(s) in the given rarity. */
export async function cardPrices(card: CardRef, foil: string) {
  const params = new URLSearchParams({ game: card.game, id: card.id, name: card.name, foil, number: card.number ?? '' });
  return json<CardPrices>(await fetch(`/api/prices?${params}`));
}

export async function listBinders() {
  return json<BinderSummary[]>(await fetch('/api/binders'));
}

export async function loadBinder(id: string) {
  return json<Binder>(await fetch(`/api/binders/${id}`));
}

export async function saveBinder(b: Binder) {
  await json(
    await fetch(`/api/binders/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }),
  );
}

export async function deleteBinder(id: string) {
  await json(await fetch(`/api/binders/${id}`, { method: 'DELETE' }));
}

export async function loadTable() {
  return json<{ slots: (string | null)[] }>(await fetch('/api/table'));
}

export async function saveTable(slots: (string | null)[]) {
  await json(
    await fetch('/api/table', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    }),
  );
}

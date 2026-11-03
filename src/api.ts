import type { Binder, BinderSummary, CardRef, Game } from './types';

export function imgUrl(remote: string): string {
  return `/api/img?u=${encodeURIComponent(remote)}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function searchCards(game: Game, q: string, page: number) {
  const params = new URLSearchParams({ game, q, page: String(page) });
  return json<{ cards: CardRef[]; hasMore: boolean }>(await fetch(`/api/search?${params}`));
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

import * as api from './api';
import { foilLabel, normalizeFoil, RARITIES } from './foils';
import { BinderScene } from './three/binderScene';
import { TABLE_SLOTS, type TableEntry } from './three/shelf';
import { InspectView } from './three/inspect';
import type { SlotHit } from './three/pageView';
import { SLOTS_PER_PAGE, type Binder, type BinderSummary, type CardRef, type FoilKey, type Game } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  binderSelect: $<HTMLSelectElement>('binder-select'),
  binderNew: $<HTMLButtonElement>('binder-new'),
  binderRename: $<HTMLButtonElement>('binder-rename'),
  binderDelete: $<HTMLButtonElement>('binder-delete'),
  binderCover: $<HTMLInputElement>('binder-cover'),
  binderStats: $('binder-stats'),
  sheetAdd: $<HTMLButtonElement>('sheet-add'),
  sheetRemove: $<HTMLButtonElement>('sheet-remove'),
  gameTabs: $('game-tabs'),
  searchForm: $<HTMLFormElement>('search-form'),
  searchInput: $<HTMLInputElement>('search-input'),
  foilSelect: $<HTMLSelectElement>('foil-select'),
  targetInfo: $('target-info'),
  searchStatus: $('search-status'),
  results: $('results'),
  loadMore: $<HTMLButtonElement>('load-more'),
  prev: $<HTMLButtonElement>('prev'),
  next: $<HTMLButtonElement>('next'),
  pageLabel: $('page-label'),
  inspectPanel: $('inspect-panel'),
  inspectName: $('inspect-name'),
  inspectSet: $('inspect-set'),
  inspectFoil: $<HTMLSelectElement>('inspect-foil'),
  inspectFlip: $<HTMLButtonElement>('inspect-flip'),
  inspectSelect: $<HTMLButtonElement>('inspect-select'),
  inspectRemove: $<HTMLButtonElement>('inspect-remove'),
  inspectClose: $<HTMLButtonElement>('inspect-close'),
  toast: $('toast'),
  binderExport: $<HTMLButtonElement>('binder-export'),
  binderImport: $<HTMLButtonElement>('binder-import'),
  importFile: $<HTMLInputElement>('import-file'),
  closeToggle: $<HTMLButtonElement>('close-toggle'),
};

const DEFAULT_SHEETS = 10;
const LAST_BINDER_KEY = 'binder:last';

let summaries: BinderSummary[] = [];
let binder: Binder | null = null;
/** Binder id resting in each table slot. The open binder is never in a slot. */
let tableSlots: (string | null)[] = TABLE_SLOTS.map(() => null);
let selected: SlotHit | null = null;
let inspecting: SlotHit | null = null;
let game: Game = 'pokemon';
const foilForNew: Record<Game, FoilKey> = { pokemon: 'none', mtg: 'none', ygo: 'none' };
let search = { q: '', page: 1, hasMore: false, busy: false };

if (!document.createElement('canvas').getContext('webgl2')) {
  document.body.innerHTML =
    '<p style="margin:auto;max-width:520px;padding:24px;line-height:1.6">Card Binder needs WebGL 2 for its 3D view, and this browser or graphics driver doesn\'t provide it. Updating your graphics driver or browser usually fixes this.</p>';
  throw new Error('WebGL 2 unavailable');
}

const scene = new BinderScene($<HTMLCanvasElement>('view'), {
  onSlotClick,
  onSpreadChange: () => updatePager(),
  onTableBinderClick: (id) => void switchTo(id),
  onEmptySlotClick: (slot) => void newBinderInSlot(slot),
  onClosedBinderClick: () => void toggleClosed(),
});
const inspect = new InspectView(scene);
inspect.onDismiss = closeInspect;

// ---------- binders ----------

function emptyPages(sheets: number) {
  return Array.from({ length: sheets * 2 }, () => Array<null>(SLOTS_PER_PAGE).fill(null));
}

function newBinder(name: string): Binder {
  const now = Date.now();
  return { id: crypto.randomUUID(), name, cover: '#5b2333', createdAt: now, updatedAt: now, pages: emptyPages(DEFAULT_SHEETS) };
}

let saveTimer = 0;
function changed(opts: { rebuild?: boolean } = { rebuild: true }) {
  if (!binder) return;
  binder.updatedAt = Date.now();
  if (opts.rebuild) scene.refresh();
  updatePager();
  updateStats();
  updateTargetInfo();
  syncSummary(binder);
  clearTimeout(saveTimer);
  const b = binder;
  saveTimer = window.setTimeout(() => {
    api.saveBinder(b).catch((err) => alert(`Saving failed: ${err.message}`));
  }, 400);
}

function syncSummary(b: Binder) {
  const s = summaries.find((x) => x.id === b.id);
  if (!s) return;
  s.name = b.name;
  s.cover = b.cover;
  s.cards = countCards(b);
  s.sheets = b.pages.length / 2;
  s.updatedAt = b.updatedAt;
}

function summaryOf(b: Binder): BinderSummary {
  return { id: b.id, name: b.name, updatedAt: b.updatedAt, cards: countCards(b), cover: b.cover, sheets: b.pages.length / 2 };
}

function entryOf(id: string): TableEntry | null {
  const s = summaries.find((x) => x.id === id);
  return s ? { id: s.id, name: s.name, cover: s.cover, sheets: s.sheets, cards: s.cards } : null;
}

/** Drop unknown ids, keep the open binder off the table, fill free slots with the rest. */
function arrangeTable() {
  const known = new Set(summaries.map((s) => s.id));
  tableSlots = TABLE_SLOTS.map((_, i) => {
    const id = tableSlots[i] ?? null;
    return id && known.has(id) && id !== binder?.id ? id : null;
  });
  for (const s of summaries) {
    if (s.id === binder?.id || tableSlots.includes(s.id)) continue;
    const free = tableSlots.indexOf(null);
    if (free < 0) break;
    tableSlots[free] = s.id;
  }
  scene.setTable(tableSlots.map((id) => (id ? entryOf(id) : null)));
  api.saveTable(tableSlots).catch((err) => console.warn('saving table failed', err));
}

async function loadAndNormalize(id: string) {
  const b = await api.loadBinder(id);
  for (const page of b.pages) for (const slot of page) if (slot) slot.foil = normalizeFoil(slot.card.game, slot.foil);
  return b;
}

/**
 * Make another binder the open one: close the current binder, slide it into
 * the slot the new one came from (or the first free slot), slide the new one
 * to the middle and open it.
 */
let switching = false;
async function switchTo(id: string) {
  if (switching || id === binder?.id || scene.isBusy || scene.isTurning) return;
  switching = true;
  try {
    closeInspect();
    const next = await loadAndNormalize(id);
    if (!summaries.some((s) => s.id === id)) summaries.unshift(summaryOf(next));
    const from = tableSlots.indexOf(id);
    if (binder) {
      await scene.setClosed(true);
      if (from >= 0) tableSlots[from] = null;
      const to = from >= 0 ? from : tableSlots.indexOf(null);
      await scene.swap(entryOf(binder.id)!, to, entryOf(id)!, from);
      if (to >= 0) tableSlots[to] = binder.id;
    } else if (from >= 0) {
      tableSlots[from] = null;
    }
    showBinder(next, true);
    arrangeTable();
    await scene.setClosed(false);
  } finally {
    switching = false;
    updatePager();
  }
}

async function toggleClosed() {
  if (!binder || switching) return;
  closeInspect();
  await scene.setClosed(!scene.isClosed);
  updatePager();
}

function countCards(b: Binder) {
  return b.pages.flat().filter(Boolean).length;
}

/** Put a loaded binder in the middle of the table without animation. */
function showBinder(b: Binder, closed: boolean) {
  binder = b;
  selected = null;
  scene.setSelected(null);
  scene.setBinder(b, 0, closed);
  try {
    localStorage.setItem(LAST_BINDER_KEY, b.id);
  } catch {
    // storage unavailable; we just won't remember the last binder
  }
  renderBinderSelect();
  ui.binderCover.value = binder.cover;
  updatePager();
  updateStats();
  updateTargetInfo();
}

async function createBinder(name: string) {
  const b = newBinder(name);
  await api.saveBinder(b);
  summaries.unshift(summaryOf(b));
  if (binder) await switchTo(b.id);
  else {
    showBinder(b, false);
    arrangeTable();
  }
}

/** Clicking an empty table slot starts a new binder there, without opening it. */
async function newBinderInSlot(slot: number) {
  const name = prompt('Name for the new binder:', 'New binder');
  if (!name?.trim()) return;
  const b = newBinder(name.trim());
  await api.saveBinder(b);
  summaries.unshift(summaryOf(b));
  tableSlots[slot] = b.id;
  arrangeTable();
  renderBinderSelect();
  toast(`Created ${b.name}. Click it to open.`);
}

function renderBinderSelect() {
  ui.binderSelect.replaceChildren(
    ...summaries.map((s) => {
      const o = new Option(s.name, s.id);
      o.selected = s.id === binder?.id;
      return o;
    }),
  );
}

function updateStats() {
  if (!binder) return;
  const cards = countCards(binder);
  const pockets = binder.pages.length * SLOTS_PER_PAGE;
  ui.binderStats.textContent = `${cards} / ${pockets} cards · ${binder.pages.length} pages`;
  ui.sheetRemove.disabled = binder.pages.length <= 2;
}

ui.binderSelect.addEventListener('change', () => {
  const id = ui.binderSelect.value;
  renderBinderSelect(); // stay on the current entry until the switch finishes
  void switchTo(id);
});
ui.binderNew.addEventListener('click', async () => {
  const name = prompt('Name for the new binder:', 'New binder');
  if (name?.trim()) await createBinder(name.trim());
});
ui.binderRename.addEventListener('click', () => {
  if (!binder) return;
  const name = prompt('Rename binder:', binder.name);
  if (!name?.trim()) return;
  binder.name = name.trim();
  const s = summaries.find((x) => x.id === binder!.id);
  if (s) s.name = binder.name;
  renderBinderSelect();
  changed({ rebuild: false });
  scene.updateFrontPlate();
});
ui.binderDelete.addEventListener('click', async () => {
  if (!binder || !confirm(`Delete "${binder.name}" and all ${countCards(binder)} cards in it? This can't be undone.`)) return;
  await api.deleteBinder(binder.id);
  summaries = summaries.filter((s) => s.id !== binder!.id);
  binder = null;
  const nextId = tableSlots.find((id) => id) ?? summaries[0]?.id;
  if (nextId) {
    tableSlots = tableSlots.map((id) => (id === nextId ? null : id));
    showBinder(await loadAndNormalize(nextId), false);
    arrangeTable();
  } else {
    await createBinder('My Binder');
  }
});

// ---------- import / export ----------

const EXPORT_FORMAT = 'card-binder';

ui.binderExport.addEventListener('click', () => {
  if (!binder) return;
  const data = JSON.stringify({ format: EXPORT_FORMAT, version: 1, binder }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `${binder.name.replace(/[^\w\- ]+/g, '').trim() || 'binder'}.binder.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${binder.name}`);
});

ui.binderImport.addEventListener('click', () => ui.importFile.click());
ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files?.[0];
  ui.importFile.value = '';
  if (!file) return;
  try {
    const b = parseImport(JSON.parse(await file.text()));
    await api.saveBinder(b);
    summaries.unshift(summaryOf(b));
    toast(`Imported ${b.name}`);
    await switchTo(b.id);
  } catch (err) {
    alert(`Couldn't import ${file.name}: ${(err as Error).message}`);
  }
});

/** Accepts an exported file (or a bare binder) and returns a fresh binder with a new id. */
function parseImport(raw: unknown): Binder {
  const src = (raw as { format?: string; binder?: unknown })?.format === EXPORT_FORMAT ? (raw as { binder: unknown }).binder : raw;
  const b = src as Partial<Binder>;
  if (!b || !Array.isArray(b.pages)) throw new Error('this is not a binder file');
  const games = new Set<Game>(['pokemon', 'mtg', 'ygo']);
  const pages = b.pages.map((page) =>
    Array.from({ length: SLOTS_PER_PAGE }, (_, i) => {
      const slot = Array.isArray(page) ? page[i] : null;
      if (!slot?.card || !games.has(slot.card.game) || typeof slot.card.image !== 'string') return null;
      return { card: slot.card, foil: normalizeFoil(slot.card.game, String(slot.foil)) };
    }),
  );
  if (pages.length % 2) pages.push(Array(SLOTS_PER_PAGE).fill(null));
  if (!pages.length) pages.push(...emptyPages(DEFAULT_SHEETS));
  let name = String(b.name || 'Imported binder');
  if (summaries.some((s) => s.name === name)) name += ' (imported)';
  const now = Date.now();
  const cover = typeof b.cover === 'string' && /^#[0-9a-f]{6}$/i.test(b.cover) ? b.cover : '#5b2333';
  return { id: crypto.randomUUID(), name, cover, createdAt: now, updatedAt: now, pages };
}
ui.binderCover.addEventListener('input', () => {
  if (!binder) return;
  binder.cover = ui.binderCover.value;
  changed();
});
ui.sheetAdd.addEventListener('click', () => {
  if (!binder) return;
  binder.pages.push(...emptyPages(1));
  changed();
});
ui.sheetRemove.addEventListener('click', () => {
  if (!binder || binder.pages.length <= 2) return;
  const last = binder.pages.slice(-2).flat().filter(Boolean).length;
  if (last && !confirm(`The last sheet holds ${last} card(s). Remove it anyway?`)) return;
  binder.pages.splice(-2, 2);
  if (selected && selected.page >= binder.pages.length) setSelected(null);
  changed();
});

// ---------- pages and selection ----------

function spreadOfPage(page: number) {
  return page % 2 === 0 ? page / 2 : (page + 1) / 2;
}

function updatePager() {
  const [l, r] = scene.pagesOf(scene.currentSpread);
  const shown = [l, r].filter((p): p is number => p !== null).map((p) => p + 1);
  const total = binder?.pages.length ?? 0;
  ui.pageLabel.textContent =
    scene.currentSpread === 0 ? `Cover · page 1 of ${total}` : !shown.length ? 'Back cover' : `Pages ${shown.join('–')} of ${total}`;
  if (r === null && l !== null) ui.pageLabel.textContent = `Page ${l + 1} of ${total} · back cover`;
  if (scene.isClosed) ui.pageLabel.textContent = `${binder?.name ?? ''} · closed`;
  ui.prev.disabled = scene.isClosed || scene.currentSpread === 0;
  ui.next.disabled = scene.isClosed || scene.currentSpread >= scene.spreadCount - 1;
  ui.closeToggle.textContent = scene.isClosed ? 'Open' : 'Close';
  updateTargetInfo();
}

function setSelected(hit: SlotHit | null) {
  selected = hit;
  scene.setSelected(hit);
  updateTargetInfo();
}

/** Where the next card from the search results will go. */
function findTarget(): SlotHit | null {
  if (!binder) return null;
  if (selected) return selected;
  const [l, r] = scene.pagesOf(scene.currentSpread);
  const start = l ?? r ?? 0;
  const n = binder.pages.length;
  for (let k = 0; k < n; k++) {
    const page = (start + k) % n;
    const slot = binder.pages[page].indexOf(null);
    if (slot >= 0) return { page, slot };
  }
  return null;
}

function updateTargetInfo() {
  const t = findTarget();
  if (!t) {
    ui.targetInfo.textContent = 'Binder is full. A new sheet will be added for the next card.';
    return;
  }
  const where = `page ${t.page + 1}, pocket ${t.slot + 1}`;
  ui.targetInfo.innerHTML = selected
    ? `Next card goes in <b>${where}</b> (selected). Esc to deselect.`
    : `Next card goes in the first empty pocket: ${where}.`;
}

function placeCard(card: CardRef) {
  if (!binder) return;
  let target = findTarget();
  if (!target) {
    binder.pages.push(...emptyPages(1));
    target = { page: binder.pages.length - 2, slot: 0 };
  }
  binder.pages[target.page][target.slot] = { card, foil: foilForNew[card.game] };

  if (selected) {
    // Walk the selection forward so a row of clicks fills pockets in order.
    const nextSlot = target.slot + 1 < SLOTS_PER_PAGE ? { page: target.page, slot: target.slot + 1 } : { page: target.page + 1, slot: 0 };
    const free = nextSlot.page < binder.pages.length && !binder.pages[nextSlot.page][nextSlot.slot];
    setSelected(free ? nextSlot : null);
  }
  changed();
  const spread = spreadOfPage(target.page);
  if (spread !== scene.currentSpread) scene.jumpTo(spread);
}

function onSlotClick(hit: SlotHit, mods: { shift: boolean; ctrl: boolean }) {
  const slot = binder?.pages[hit.page][hit.slot];
  if (mods.ctrl) {
    if (slot) removeCard(hit);
    return;
  }
  if (slot && !mods.shift) return openInspect(hit);
  const same = selected && selected.page === hit.page && selected.slot === hit.slot;
  setSelected(same ? null : hit);
}

function removeCard(hit: SlotHit) {
  const slot = binder?.pages[hit.page][hit.slot];
  if (!binder || !slot) return;
  binder.pages[hit.page][hit.slot] = null;
  changed();
  toast(`Removed ${slot.card.name}`);
}

/**
 * Copy a card into the next empty pocket on its page (after it, then before
 * it). If the page is full, use the next empty pocket after the page.
 */
function duplicateCard(hit: SlotHit) {
  const slot = binder?.pages[hit.page][hit.slot];
  if (!binder || !slot) return;
  const page = binder.pages[hit.page];
  let target: SlotHit | null = null;
  for (let k = 1; k < SLOTS_PER_PAGE && !target; k++) {
    const i = (hit.slot + k) % SLOTS_PER_PAGE;
    if (!page[i]) target = { page: hit.page, slot: i };
  }
  for (let p = hit.page + 1; p < binder.pages.length && !target; p++) {
    const i = binder.pages[p].indexOf(null);
    if (i >= 0) target = { page: p, slot: i };
  }
  if (!target) {
    binder.pages.push(...emptyPages(1));
    target = { page: binder.pages.length - 2, slot: 0 };
  }
  binder.pages[target.page][target.slot] = { card: slot.card, foil: slot.foil };
  changed();
  toast(`Copied ${slot.card.name} to page ${target.page + 1}, pocket ${target.slot + 1}`);
  const spread = spreadOfPage(target.page);
  if (spread !== scene.currentSpread) scene.jumpTo(spread);
}

let toastTimer = 0;
function toast(text: string) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 1800);
}

ui.closeToggle.addEventListener('click', () => void toggleClosed());
ui.prev.addEventListener('click', () => scene.turnPage(-1));
ui.next.addEventListener('click', () => scene.turnPage(1));

// ---------- inspect ----------

function fillFoilSelect(sel: HTMLSelectElement, g: Game, value: FoilKey) {
  sel.replaceChildren(
    ...RARITIES[g].map(({ key, label }) => {
      const o = new Option(label, key);
      o.selected = key === value;
      return o;
    }),
  );
}

function openInspect(hit: SlotHit) {
  const slot = binder?.pages[hit.page][hit.slot];
  if (!slot) return;
  inspecting = hit;
  inspect.show(slot);
  ui.inspectName.textContent = slot.card.name;
  ui.inspectSet.textContent = [slot.card.set, slot.card.number && `#${slot.card.number}`, `page ${hit.page + 1}`]
    .filter(Boolean)
    .join(' · ');
  fillFoilSelect(ui.inspectFoil, slot.card.game, slot.foil);
  ui.inspectPanel.hidden = false;
}

function closeInspect() {
  if (!inspecting) return;
  inspecting = null;
  inspect.hide();
  ui.inspectPanel.hidden = true;
}

ui.inspectFoil.addEventListener('change', () => {
  const slot = inspecting && binder?.pages[inspecting.page][inspecting.slot];
  if (!slot) return;
  slot.foil = ui.inspectFoil.value as FoilKey;
  inspect.setFoil(slot.foil);
  changed();
});
ui.inspectFlip.addEventListener('click', () => inspect.flip());
ui.inspectClose.addEventListener('click', closeInspect);
ui.inspectSelect.addEventListener('click', () => {
  const hit = inspecting;
  closeInspect();
  if (hit) setSelected(hit);
});
ui.inspectRemove.addEventListener('click', () => {
  if (!inspecting || !binder) return;
  binder.pages[inspecting.page][inspecting.slot] = null;
  closeInspect();
  changed();
});

// ---------- search ----------

function setGame(g: Game) {
  game = g;
  for (const b of ui.gameTabs.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.game === g);
  fillFoilSelect(ui.foilSelect, g, foilForNew[g]);
  ui.searchInput.placeholder =
    g === 'mtg' ? 'Card name or Scryfall syntax, e.g. "bolt" or "t:dragon r:mythic"' : g === 'pokemon' ? 'Card name, e.g. Charizard' : 'Card name, e.g. Dark Magician';
  ui.results.replaceChildren();
  ui.loadMore.hidden = true;
  ui.searchStatus.textContent = '';
  if (search.q) void runSearch(search.q, 1);
}

async function runSearch(q: string, page: number) {
  if (search.busy) return;
  search = { q, page, hasMore: false, busy: true };
  const forGame = game;
  if (page === 1) ui.results.replaceChildren();
  ui.searchStatus.textContent = 'Searching…';
  ui.loadMore.hidden = true;
  try {
    const res = await api.searchCards(forGame, q, page);
    if (forGame !== game) return;
    search.hasMore = res.hasMore;
    for (const card of res.cards) ui.results.append(resultTile(card));
    const count = ui.results.childElementCount;
    ui.searchStatus.textContent = count ? `${count}${res.hasMore ? '+' : ''} results. Click one to add it.` : 'No cards found.';
    ui.loadMore.hidden = !res.hasMore;
  } catch (err) {
    ui.searchStatus.textContent = `Search failed: ${(err as Error).message}`;
  } finally {
    search.busy = false;
  }
}

function resultTile(card: CardRef) {
  const b = document.createElement('button');
  b.className = 'result';
  b.title = `${card.name}\n${card.set}${card.number ? ` #${card.number}` : ''}\nClick to add as ${foilLabel(card.game, foilForNew[card.game])}`;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = card.name;
  img.src = api.imgUrl(card.thumb);
  const label = document.createElement('span');
  label.textContent = card.set;
  b.append(img, label);
  b.addEventListener('click', () => placeCard(card));
  return b;
}

ui.gameTabs.addEventListener('click', (e) => {
  const g = (e.target as HTMLElement).closest('button')?.dataset.game as Game | undefined;
  if (g && g !== game) setGame(g);
});
ui.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = ui.searchInput.value.trim();
  if (q) void runSearch(q, 1);
});
ui.loadMore.addEventListener('click', () => runSearch(search.q, search.page + 1));
ui.foilSelect.addEventListener('change', () => {
  foilForNew[game] = ui.foilSelect.value as FoilKey;
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (inspecting) closeInspect();
    else setSelected(null);
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
    // Also keeps the browser's bookmark dialog from opening.
    e.preventDefault();
    const hit = inspecting ?? scene.hoveredSlot;
    if (hit) duplicateCard(hit);
    return;
  }
  if (inspecting) {
    if (e.key === 'f' || e.key === 'F') inspect.flip();
    return;
  }
  if (e.key === 'ArrowRight') scene.turnPage(1);
  else if (e.key === 'ArrowLeft') scene.turnPage(-1);
  else if (e.key === 'r' || e.key === 'R') scene.resetView();
  else if (e.key === 't' || e.key === 'T') scene.tableView();
  else if (e.key === 'c' || e.key === 'C') void toggleClosed();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && binder?.pages[selected.page][selected.slot]) {
    binder.pages[selected.page][selected.slot] = null;
    changed();
  }
});

// ---------- start ----------

async function start() {
  setGame('pokemon');
  summaries = await api.listBinders();
  if (!summaries.length) return createBinder('My Binder');
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_BINDER_KEY);
  } catch {
    // ignore
  }
  tableSlots = (await api.loadTable().catch(() => ({ slots: [] as (string | null)[] }))).slots;
  showBinder(await loadAndNormalize(summaries.find((s) => s.id === last)?.id ?? summaries[0].id), false);
  arrangeTable();
}

start().catch((err) => {
  console.error(err);
  alert(`Could not start: ${err.message}`);
});

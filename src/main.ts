import * as api from './api';
import { foilAges, foilLabel, hasOldFrame, oldFrameByDefault, normalizeFoil, printAge, RARITIES } from './foils';
import tcgplayerLogo from './assets/logos/tcgplayer.png';
import cardmarketLogo from './assets/logos/cardmarket.png';
import cardtraderLogo from './assets/logos/cardtrader.png';
import { CONDITION_KEYS, CONDITION_LABELS, conditionOf, GRADES, gradeOf, isMint } from './condition';
import { BinderScene } from './three/binderScene';
import { TABLE_SLOTS, type TableEntry } from './three/shelf';
import { InspectView } from './three/inspect';
import type { SlotHit } from './three/pageView';
import { layoutOf, type Binder, type BinderLayout, type BinderSummary, type CardRef, type Condition, type FoilKey, type Game, type Slot } from './types';

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
  searchWord: $<HTMLButtonElement>('search-word'),
  searchType: $<HTMLSelectElement>('search-type'),
  searchSet: $<HTMLInputElement>('search-set'),
  searchSets: $<HTMLDataListElement>('search-sets'),
  foilSelect: $<HTMLSelectElement>('foil-select'),
  targetInfo: $('target-info'),
  searchStatus: $('search-status'),
  results: $('results'),
  loadMore: $<HTMLButtonElement>('load-more'),
  prev: $<HTMLButtonElement>('prev'),
  next: $<HTMLButtonElement>('next'),
  pageLabel: $('page-label'),
  pager: $('pager'),
  inspectPanel: $('inspect-panel'),
  inspectName: $('inspect-name'),
  inspectSet: $('inspect-set'),
  inspectFoil: $<HTMLSelectElement>('inspect-foil'),
  inspectAgeRow: $('inspect-age-row'),
  inspectAge: $<HTMLInputElement>('inspect-age'),
  inspectAgeValue: $('inspect-age-value'),
  inspectOldRow: $('inspect-old-row'),
  inspectOld: $<HTMLInputElement>('inspect-old'),
  inspectGrade: $('inspect-grade'),
  inspectGrades: $('inspect-grades'),
  inspectWear: $('inspect-wear'),
  inspectPrices: $('inspect-prices'),
  inspectFlip: $<HTMLButtonElement>('inspect-flip'),
  inspectPrev: $<HTMLButtonElement>('inspect-prev'),
  inspectNext: $<HTMLButtonElement>('inspect-next'),
  inspectPos: $('inspect-pos'),
  inspectSelect: $<HTMLButtonElement>('inspect-select'),
  inspectRemove: $<HTMLButtonElement>('inspect-remove'),
  inspectClose: $<HTMLButtonElement>('inspect-close'),
  toast: $('toast'),
  binderExport: $<HTMLButtonElement>('binder-export'),
  binderImport: $<HTMLButtonElement>('binder-import'),
  importFile: $<HTMLInputElement>('import-file'),
  closeToggle: $<HTMLButtonElement>('close-toggle'),
  binderPockets: $<HTMLSelectElement>('binder-pockets'),
  binderType: $<HTMLSelectElement>('binder-type'),
  binderStyle: $<HTMLSelectElement>('binder-style'),
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
let search = { q: '', page: 1, hasMore: false, busy: false, filters: { type: '', set: '', word: false } as api.SearchFilters };

if (!document.createElement('canvas').getContext('webgl2')) {
  document.body.innerHTML =
    '<p style="margin:auto;max-width:520px;padding:24px;line-height:1.6">Card Binder needs WebGL 2 for its 3D view, and this browser or graphics driver doesn\'t provide it. Updating your graphics driver or browser usually fixes this.</p>';
  throw new Error('WebGL 2 unavailable');
}
(window as any).__dbg = 0;
const scene = new BinderScene($<HTMLCanvasElement>('view'), {
  onSlotClick,
  onSpreadChange: () => updatePager(),
  onTableBinderClick: (id) => void switchTo(id),
  onEmptySlotClick: (slot) => void newBinderInSlot(slot),
  onClosedBinderClick: () => void toggleClosed(),
  canDragSlot: (hit) => !!binder?.pages[hit.page]?.[hit.slot],
  onCardDragStart: (hit, e) => {
    const slot = binder?.pages[hit.page][hit.slot];
    if (slot) startDrag(slot, hit, e);
  },
});
const inspect = new InspectView(scene);
inspect.onDismiss = closeInspect;

// ---------- binders ----------

function emptyPages(sheets: number, pockets: number) {
  return Array.from({ length: sheets * 2 }, () => Array<null>(pockets).fill(null));
}

function pocketsOf(b: Binder) {
  return layoutOf(b).pockets;
}

function newBinder(name: string): Binder {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    cover: '#5b2333',
    createdAt: now,
    updatedAt: now,
    layout: { pockets: 9, type: 'sleeve', style: 'ring' },
    pages: emptyPages(DEFAULT_SHEETS, 9),
  };
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
  s.layout = layoutOf(b);
}

function summaryOf(b: Binder): BinderSummary {
  return {
    id: b.id,
    name: b.name,
    updatedAt: b.updatedAt,
    cards: countCards(b),
    cover: b.cover,
    sheets: b.pages.length / 2,
    layout: layoutOf(b),
  };
}

function entryOf(id: string): TableEntry | null {
  const s = summaries.find((x) => x.id === id);
  return s ? { id: s.id, name: s.name, cover: s.cover, sheets: s.sheets, cards: s.cards, layout: s.layout } : null;
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
  ui.binderCover.value = b.cover;
  renderLayoutControls();
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
  const pockets = binder.pages.length * pocketsOf(binder);
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

// ---------- layout ----------

function renderLayoutControls() {
  if (!binder) return;
  const layout = layoutOf(binder);
  ui.binderPockets.value = String(layout.pockets);
  ui.binderType.value = layout.type;
  ui.binderStyle.value = layout.style;
  ui.binderPockets.disabled = layout.type === 'slab';
}

/**
 * Change pockets per page or holder type. Cards keep their order (gaps
 * included) and flow into the new page size.
 */
function setLayout(layout: BinderLayout) {
  if (!binder || scene.isBusy || scene.isTurning) return renderLayoutControls();
  const next = layoutOf({ layout });
  const flat = binder.pages.flat();
  while (flat.length && !flat[flat.length - 1]) flat.pop();
  const capacity = Math.max(binder.pages.length * pocketsOf(binder), flat.length);
  let count = Math.max(2, Math.ceil(capacity / next.pockets));
  if (count % 2) count++;
  binder.pages = Array.from({ length: count }, (_, p) =>
    Array.from({ length: next.pockets }, (_, i) => flat[p * next.pockets + i] ?? null),
  );
  binder.layout = next;
  setSelected(null);
  scene.setBinder(binder, 0, scene.isClosed);
  changed();
  renderLayoutControls();
}

ui.binderPockets.addEventListener('change', () => {
  if (binder) setLayout({ ...layoutOf(binder), pockets: Number(ui.binderPockets.value) as BinderLayout['pockets'] });
});
ui.binderType.addEventListener('change', () => {
  if (binder) setLayout({ ...layoutOf(binder), type: ui.binderType.value as BinderLayout['type'] });
});
// The style only changes the binder's look, so the pages stay as they are.
ui.binderStyle.addEventListener('change', () => {
  if (!binder || scene.isBusy || scene.isTurning) return renderLayoutControls();
  binder.layout = { ...layoutOf(binder), style: ui.binderStyle.value as BinderLayout['style'] };
  scene.setBinder(binder, scene.currentSpread, scene.isClosed);
  changed();
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
  const layout = layoutOf(b);
  const games = new Set<Game>(['pokemon', 'mtg', 'ygo']);
  const pages = b.pages.map((page) =>
    Array.from({ length: layout.pockets }, (_, i) => {
      const slot = Array.isArray(page) ? page[i] : null;
      if (!slot?.card || !games.has(slot.card.game) || typeof slot.card.image !== 'string') return null;
      const age = Number(slot.age);
      return {
        card: slot.card,
        foil: normalizeFoil(slot.card.game, String(slot.foil)),
        ...(slot.age != null && age >= 0 && age <= 1 ? { age } : {}),
        ...(slot.oldFrame === true && slot.card.game === 'ygo' ? { oldFrame: true } : {}),
        ...(isMint(conditionOf(slot.condition)) ? {} : { condition: conditionOf(slot.condition) }),
      };
    }),
  );
  if (pages.length % 2) pages.push(Array(layout.pockets).fill(null));
  if (!pages.length) pages.push(...emptyPages(DEFAULT_SHEETS, layout.pockets));
  let name = String(b.name || 'Imported binder');
  if (summaries.some((s) => s.name === name)) name += ' (imported)';
  const now = Date.now();
  const cover = typeof b.cover === 'string' && /^#[0-9a-f]{6}$/i.test(b.cover) ? b.cover : '#5b2333';
  return { id: crypto.randomUUID(), name, cover, createdAt: now, updatedAt: now, layout, pages };
}
ui.binderCover.addEventListener('input', () => {
  if (!binder) return;
  binder.cover = ui.binderCover.value;
  changed();
});
/**
 * The pages + Sheet and − Sheet work on: the open spread's two pages, or just
 * page 1 on the front cover. Pages always come in sheets of two, so a single
 * page added or removed at the front is balanced by an empty page at the end.
 */
function spreadPages(): { at: number; count: 1 | 2 } {
  const s = scene.currentSpread;
  return s === 0 ? { at: 0, count: 1 } : { at: 2 * s - 1, count: 2 };
}

/**
 * Keep the selected pocket on the same card after `removed` pages at `at`
 * were replaced by `added` ones; drop it if its page went.
 */
function shiftSelection(at: number, removed: number, added: number) {
  if (!selected || selected.page < at) return;
  if (selected.page < at + removed) setSelected(null);
  else setSelected({ ...selected, page: selected.page - removed + added });
}

// New pages go in where the binder is open, pushing the pages there to the right.
ui.sheetAdd.addEventListener('click', () => {
  if (!binder || scene.isTurning || scene.isClosed) return;
  const { at, count } = spreadPages();
  const blank = emptyPages(1, pocketsOf(binder));
  binder.pages.splice(at, 0, ...blank.slice(0, count));
  if (count === 1) binder.pages.push(blank[1]);
  shiftSelection(at, 0, count);
  changed();
});
// And come out from the same place, pulling the following pages back.
ui.sheetRemove.addEventListener('click', () => {
  if (!binder || binder.pages.length <= 2 || scene.isTurning || scene.isClosed) return;
  const { at, count } = spreadPages();
  const gone = binder.pages.slice(at, at + count);
  const cards = gone.flat().filter(Boolean).length;
  const which = count === 1 ? `Page ${at + 1}` : `Pages ${at + 1}–${at + gone.length}`;
  if (cards && !confirm(`${which} hold${count === 1 ? 's' : ''} ${cards} card(s). Remove anyway?`)) return;
  binder.pages.splice(at, count);
  if (binder.pages.length % 2) {
    // An odd page left over: drop an empty last page, or add one.
    if (binder.pages.at(-1)!.every((s) => !s)) binder.pages.pop();
    else binder.pages.push(...emptyPages(1, pocketsOf(binder)).slice(0, 1));
  }
  shiftSelection(at, count, 0);
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
    binder.pages.push(...emptyPages(1, pocketsOf(binder)));
    target = { page: binder.pages.length - 2, slot: 0 };
  }
  binder.pages[target.page][target.slot] = newSlot(card);

  if (selected) {
    // Walk the selection forward so a row of clicks fills pockets in order.
    const nextSlot = target.slot + 1 < pocketsOf(binder) ? { page: target.page, slot: target.slot + 1 } : { page: target.page + 1, slot: 0 };
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
  const pockets = pocketsOf(binder);
  for (let k = 1; k < pockets && !target; k++) {
    const i = (hit.slot + k) % pockets;
    if (!page[i]) target = { page: hit.page, slot: i };
  }
  for (let p = hit.page + 1; p < binder.pages.length && !target; p++) {
    const i = binder.pages[p].indexOf(null);
    if (i >= 0) target = { page: p, slot: i };
  }
  if (!target) {
    binder.pages.push(...emptyPages(1, pockets));
    target = { page: binder.pages.length - 2, slot: 0 };
  }
  binder.pages[target.page][target.slot] = { ...slot };
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

// ---------- drag and drop ----------

/**
 * A card being dragged: from the search results (`from` is null) or from a
 * pocket. Dropping on a pocket moves it there (swapping with what's there);
 * with Shift held, or from the search results, a copy goes there instead.
 */
interface CardDrag {
  slot: Slot;
  from: SlotHit | null;
  ghost: HTMLElement;
  target: SlotHit | null;
  x: number;
  y: number;
  shift: boolean;
  /** Held beside the binder: which side and since when, to turn the page. */
  edge: { dir: -1 | 1; at: number } | null;
  timer: number;
}
let drag: CardDrag | null = null;
/** A press on a search result that may turn into a drag. */
let resultPress: { card: CardRef; x: number; y: number } | null = null;

/** A search result as it goes into a pocket. */
function newSlot(card: CardRef): Slot {
  return { card, foil: foilForNew[card.game], ...(oldFrameByDefault(card) ? { oldFrame: true } : {}) };
}
let suppressResultClick = false;

const isCopy = (d: CardDrag) => !d.from || d.shift;

function startDrag(slot: Slot, from: SlotHit | null, e: PointerEvent) {
  if (!binder || inspecting) return;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const img = document.createElement('img');
  img.src = api.imgUrl(slot.card.thumb);
  img.alt = '';
  ghost.append(img);
  document.body.append(ghost);
  drag = { slot, from, ghost, target: null, x: e.clientX, y: e.clientY, shift: e.shiftKey, edge: null, timer: 0 };
  drag.timer = window.setInterval(checkDragEdge, 100);
  document.body.classList.add('dragging-card');
  moveDrag(e.clientX, e.clientY, e.shiftKey);
}

function moveDrag(x: number, y: number, shift: boolean) {
  const d = drag;
  if (!d) return;
  Object.assign(d, { x, y, shift });
  d.ghost.style.transform = `translate(${x}px, ${y}px)`;
  d.ghost.classList.toggle('copy', isCopy(d));
  d.target = scene.slotAtClient(x, y);
  scene.setCardDrag(d.target, isCopy(d) ? null : d.from);
}

/** Holding the card beside the binder turns the page that way, so it can go to another spread. */
function checkDragEdge() {
  const d = drag;
  if (!d) return;
  const dir = scene.edgeAtClient(d.x, d.y);
  if (!dir) {
    d.edge = null;
    return;
  }
  const now = performance.now();
  // Turn after a short hold, and again only once each turn has landed.
  if (d.edge?.dir !== dir || scene.isTurning) d.edge = { dir, at: now };
  else if (now - d.edge.at > 600) scene.turnPage(dir);
  // The pocket under the card changes as the page turns.
  moveDrag(d.x, d.y, d.shift);
}

function endDrag(drop: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  clearInterval(d.timer);
  d.ghost.remove();
  document.body.classList.remove('dragging-card');
  scene.setCardDrag(null, null);
  const to = drop && binder ? scene.slotAtClient(d.x, d.y) : null;
  if (!binder || !to) return;
  const pages = binder.pages;
  const there = pages[to.page][to.slot];
  if (isCopy(d)) {
    pages[to.page][to.slot] = structuredClone(d.slot);
    if (there) toast(`Replaced ${there.card.name}`);
  } else {
    const from = d.from!;
    if (from.page === to.page && from.slot === to.slot) return;
    // Moving onto a card swaps the two.
    pages[to.page][to.slot] = pages[from.page][from.slot];
    pages[from.page][from.slot] = there;
  }
  changed();
}

window.addEventListener('pointermove', (e) => {
  const press = resultPress;
  if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
    resultPress = null;
    suppressResultClick = true;
    startDrag(newSlot(press.card), null, e);
  }
  if (drag) moveDrag(e.clientX, e.clientY, e.shiftKey);
});
window.addEventListener('pointerup', () => {
  resultPress = null;
  endDrag(true);
  // The click that follows a drag isn't a click.
  setTimeout(() => (suppressResultClick = false));
});
window.addEventListener('pointercancel', () => endDrag(false));
for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (e) => {
    if (drag && e.key === 'Shift') moveDrag(drag.x, drag.y, type === 'keydown');
  });
}

ui.closeToggle.addEventListener('click', () => void toggleClosed());
ui.prev.addEventListener('click', () => scene.turnPage(-1));
ui.next.addEventListener('click', () => scene.turnPage(1));

// The arrows sit beside the binder and the pager under it, following the camera.
scene.addOverlay(() => {
  const shown = inspect.isOpen ? 'hidden' : '';
  for (const el of [ui.prev, ui.next, ui.pager]) el.style.visibility = shown;
  const b = scene.screenBounds();
  const stage = ui.pager.parentElement!;
  const [w, h] = [stage.clientWidth, stage.clientHeight];
  const pw = ui.pager.offsetWidth;
  const ph = ui.pager.offsetHeight;
  const gap = 14;
  const size = 44;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), hi));
  const left = b ? [b.left.x - gap - size, b.left.y - size / 2] : [8, h / 2 - size / 2];
  const right = b ? [b.right.x + gap, b.right.y - size / 2] : [w - 8 - size, h / 2 - size / 2];
  const below = b ? [b.bottom.x - pw / 2, b.bottom.y + gap] : [w / 2 - pw / 2, h - 16 - ph];
  ui.prev.style.transform = `translate(${clamp(left[0], 8, w - 8 - size)}px, ${clamp(left[1], 8, h - 8 - size)}px)`;
  ui.next.style.transform = `translate(${clamp(right[0], 8, w - 8 - size)}px, ${clamp(right[1], 8, h - 8 - size)}px)`;
  ui.pager.style.transform = `translate(${clamp(below[0], 8, w - 8 - pw)}px, ${clamp(below[1], 8, h - 16 - ph)}px)`;
});

// Typing a page number turns to it; digits typed close together make one number.
let pageTyped = '';
let pageTimer = 0;
function typePageDigit(d: string) {
  pageTyped = (pageTyped + d).slice(-4);
  ui.pageLabel.textContent = `Go to page ${pageTyped}…`;
  clearTimeout(pageTimer);
  // Wait for another digit only if one could still make a page number.
  if (Number(pageTyped) * 10 > (binder?.pages.length ?? 0)) goToTypedPage();
  else pageTimer = window.setTimeout(goToTypedPage, 700);
}
function goToTypedPage() {
  clearTimeout(pageTimer);
  const n = Number(pageTyped);
  pageTyped = '';
  updatePager();
  const total = binder?.pages.length ?? 0;
  if (!n || n > total) {
    toast(`There is no page ${n} (${total} pages)`);
    return;
  }
  scene.turnTo(spreadOfPage(n - 1));
}

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
  inspect.show(slot, layoutOf(binder).type === 'slab');
  ui.inspectName.textContent = slot.card.name;
  ui.inspectSet.textContent = [slot.card.set, slot.card.number && `#${slot.card.number}`, slot.card.rarity, `page ${hit.page + 1}`]
    .filter(Boolean)
    .join(' · ');
  fillFoilSelect(ui.inspectFoil, slot.card.game, slot.foil);
  showAge(slot);
  showPrices(slot);
  showCardNav(hit);
  ui.inspectPanel.hidden = false;
}

/** The next (or previous) filled pocket after `hit`, across pages. */
function neighbour(hit: SlotHit, dir: 1 | -1): SlotHit | null {
  if (!binder) return null;
  let { page, slot } = hit;
  for (;;) {
    slot += dir;
    if (slot < 0 || slot >= (binder.pages[page]?.length ?? 0)) {
      page += dir;
      if (page < 0 || page >= binder.pages.length) return null;
      slot = dir > 0 ? 0 : binder.pages[page].length - 1;
    }
    if (binder.pages[page][slot]) return { page, slot };
  }
}

function showCardNav(hit: SlotHit) {
  ui.inspectPrev.disabled = !neighbour(hit, -1);
  ui.inspectNext.disabled = !neighbour(hit, 1);
  const filled = binder!.pages.flatMap((p, pi) => p.map((s, si) => (s ? pi * 1000 + si : -1))).filter((k) => k >= 0);
  ui.inspectPos.textContent = `${filled.indexOf(hit.page * 1000 + hit.slot) + 1} / ${filled.length}`;
}

/** Look at the next or previous card, turning the binder to its page behind the close-up. */
function stepInspect(dir: 1 | -1) {
  const next = inspecting && neighbour(inspecting, dir);
  if (!next) return;
  const spread = spreadOfPage(next.page);
  if (spread !== scene.currentSpread) scene.turnTo(spread);
  openInspect(next);
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
  delete slot.age;
  inspect.setFoil(slot.foil, slot);
  showAge(slot);
  showPrices(slot);
  changed();
});

// ---------- prices ----------

let pricesRun = 0;

const MARKET_LOGOS: Record<string, string> = { TCGplayer: tcgplayerLogo, Cardmarket: cardmarketLogo, CardTrader: cardtraderLogo };

/** A marketplace name with its logo, as a link when there's a url. */
function market(source: string, url?: string) {
  const e = url ? el('a') : el('span');
  e.className = 'market';
  if (e instanceof HTMLAnchorElement && url) {
    e.href = url;
    e.target = '_blank';
    e.rel = 'noopener noreferrer';
  }
  const logo = MARKET_LOGOS[source];
  if (logo) {
    const img = el('img');
    img.src = logo;
    img.alt = '';
    e.append(img);
  }
  e.append(source);
  return e;
}

function money(v: number | null, currency: 'USD' | 'EUR') {
  if (v === null) return '–';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

async function showPrices(slot: Slot) {
  const run = ++pricesRun;
  const box = ui.inspectPrices;
  box.replaceChildren(el('span', 'Prices'), el('span', 'Looking up prices…', 'muted'));
  let prices: api.CardPrices;
  try {
    prices = await api.cardPrices(slot.card, slot.foil);
  } catch (err) {
    if (run === pricesRun) box.replaceChildren(el('span', 'Prices'), el('span', `Couldn't get prices: ${(err as Error).message}`, 'muted'));
    return;
  }
  if (run !== pricesRun) return;
  box.replaceChildren(el('span', 'Prices'));
  if (!prices.groups.length) box.append(el('span', `No prices for ${foilLabel(slot.card.game, slot.foil)}.`, 'muted'));
  for (const g of prices.groups) {
    const table = el('table');
    const head = el('tr');
    head.append(el('th'), el('th', 'Low'), el('th', 'Trend'), el('th', 'High'));
    table.append(head);
    for (const r of g.rows) {
      const tr = el('tr');
      const name = el('td');
      name.append(market(r.source, r.url));
      tr.append(name, el('td', money(r.low, r.currency)), el('td', money(r.trend, r.currency)), el('td', money(r.high, r.currency)));
      table.append(tr);
    }
    box.append(el('h4', g.title), table);
    if (g.note) box.append(el('span', g.note, 'muted'));
  }
  if (prices.links.length) {
    const links = el('div', '', 'market-links');
    links.append(el('span', 'Search', 'muted'), ...prices.links.map((l) => market(l.source, l.url)));
    box.append(links);
  }
}

function showAge(slot: Slot) {
  ui.inspectAgeRow.hidden = !foilAges(slot.card.game, slot.foil);
  const age = printAge(slot.card.game, slot.foil, slot.age);
  ui.inspectAge.value = String(age);
  ui.inspectAgeValue.textContent = ageLabel(age);
  ui.inspectOldRow.hidden = !hasOldFrame(slot.card);
  ui.inspectOld.checked = Boolean(slot.oldFrame);
  showCondition(slot);
}

// ---------- condition ----------

const gradeButtons = GRADES.map((g) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = g.key;
  b.title = g.name;
  b.addEventListener('click', () => setCondition({ ...g.condition }, true));
  ui.inspectGrades.append(b);
  return b;
});

const wearSliders = CONDITION_KEYS.map((key) => {
  const label = document.createElement('label');
  label.htmlFor = `wear-${key}`;
  label.textContent = CONDITION_LABELS[key];
  const input = document.createElement('input');
  input.type = 'range';
  input.id = `wear-${key}`;
  input.min = '0';
  input.max = '1';
  input.step = '0.05';
  // Dragging updates the close-up live; the binder page rebuilds on release.
  input.addEventListener('input', () => {
    const slot = inspecting && binder?.pages[inspecting.page][inspecting.slot];
    if (slot) setCondition({ ...conditionOf(slot.condition), [key]: Number(input.value) }, false);
  });
  input.addEventListener('change', () => changed());
  ui.inspectWear.append(label, input);
  return input;
});

function setCondition(c: Condition, save: boolean) {
  const slot = inspecting && binder?.pages[inspecting.page][inspecting.slot];
  if (!slot) return;
  if (isMint(c)) delete slot.condition;
  else slot.condition = c;
  inspect.setFoil(slot.foil, slot);
  showCondition(slot);
  if (save) changed();
}

function showCondition(slot: Slot) {
  const c = conditionOf(slot.condition);
  CONDITION_KEYS.forEach((k, i) => (wearSliders[i].value = String(c[k])));
  const grade = gradeOf(c);
  gradeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(GRADES[i].key === grade)));
  ui.inspectGrade.textContent = grade ? GRADES.find((g) => g.key === grade)!.name : 'custom';
}

function ageLabel(age: number) {
  return age === 0 ? 'new' : age < 0.5 ? 'worn' : age < 0.9 ? 'old' : 'vintage';
}

// Dragging updates the close-up live; the binder page rebuilds on release.
ui.inspectAge.addEventListener('input', () => {
  const slot = inspecting && binder?.pages[inspecting.page][inspecting.slot];
  if (!slot) return;
  const age = Number(ui.inspectAge.value);
  // Only a moved slider is saved, so cards follow the rarity's default otherwise.
  if (age === printAge(slot.card.game, slot.foil)) delete slot.age;
  else slot.age = age;
  ui.inspectAgeValue.textContent = ageLabel(age);
  inspect.setFoil(slot.foil, slot);
});
ui.inspectAge.addEventListener('change', () => changed());
ui.inspectOld.addEventListener('change', () => {
  const slot = inspecting && binder?.pages[inspecting.page][inspecting.slot];
  if (!slot) return;
  if (ui.inspectOld.checked) slot.oldFrame = true;
  else delete slot.oldFrame;
  inspect.setFoil(slot.foil, slot);
  changed();
});
ui.inspectFlip.addEventListener('click', () => inspect.flip());
ui.inspectPrev.addEventListener('click', () => stepInspect(-1));
ui.inspectNext.addEventListener('click', () => stepInspect(1));
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

/** The type filter's choices per game: [key the server knows, label]. */
const CARD_TYPES: Record<Game, [string, string][]> = {
  pokemon: [
    ['pokemon', 'Pokémon'],
    ['trainer', 'Trainer (any)'],
    ['supporter', 'Supporter'],
    ['item', 'Item'],
    ['tool', 'Pokémon Tool'],
    ['stadium', 'Stadium'],
    ['energy', 'Energy'],
  ],
  mtg: [
    ['creature', 'Creature'],
    ['instant', 'Instant'],
    ['sorcery', 'Sorcery'],
    ['artifact', 'Artifact'],
    ['enchantment', 'Enchantment'],
    ['planeswalker', 'Planeswalker'],
    ['land', 'Land'],
    ['battle', 'Battle'],
  ],
  ygo: [
    ['monster', 'Monster (any)'],
    ['normal', 'Normal Monster'],
    ['effect', 'Effect Monster'],
    ['ritual', 'Ritual Monster'],
    ['fusion', 'Fusion Monster'],
    ['synchro', 'Synchro Monster'],
    ['xyz', 'Xyz Monster'],
    ['pendulum', 'Pendulum Monster'],
    ['link', 'Link Monster'],
    ['spell', 'Spell'],
    ['trap', 'Trap'],
  ],
};

const setLists = new Map<Game, Promise<api.SetInfo[]>>();
function setsOf(g: Game) {
  let p = setLists.get(g);
  if (!p) {
    p = api.listSets(g);
    p.catch(() => setLists.delete(g));
    setLists.set(g, p);
  }
  return p;
}

/** How a set reads in the set box; Yu-Gi-Oh! sets are known by name alone. */
function setLabel(s: api.SetInfo) {
  return s.id === s.name ? s.name : `${s.name} (${s.id.toUpperCase()})`;
}

async function fillSetList(g: Game) {
  ui.searchSets.replaceChildren();
  const sets = await setsOf(g).catch(() => []);
  if (g !== game) return;
  ui.searchSets.replaceChildren(
    ...sets.map((s) => {
      const o = document.createElement('option');
      o.value = setLabel(s);
      if (s.date) o.label = s.date.slice(0, 4);
      return o;
    }),
  );
}

/** The set the set box names, '' for none, or null when it names no known set. */
async function chosenSet(): Promise<string | null> {
  const v = ui.searchSet.value.trim().toLowerCase();
  if (!v) return '';
  const sets = await setsOf(game).catch(() => []);
  const hit = sets.find((s) => setLabel(s).toLowerCase() === v) ?? sets.find((s) => s.name.toLowerCase() === v || s.id.toLowerCase() === v);
  return hit ? hit.id : null;
}

function setGame(g: Game) {
  game = g;
  for (const b of ui.gameTabs.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.game === g);
  fillFoilSelect(ui.foilSelect, g, foilForNew[g]);
  ui.searchType.replaceChildren(new Option('Any type', ''), ...CARD_TYPES[g].map(([key, label]) => new Option(label, key)));
  ui.searchSet.value = '';
  void fillSetList(g);
  ui.searchInput.placeholder =
    g === 'mtg' ? 'Card name or Scryfall syntax, e.g. "bolt" or "t:dragon r:mythic"' : g === 'pokemon' ? 'Card name, e.g. Charizard' : 'Card name, e.g. Dark Magician';
  ui.results.replaceChildren();
  ui.loadMore.hidden = true;
  ui.searchStatus.textContent = '';
  // The filters were reset for the new game; the name carries over.
  if (search.q) void newSearch();
  else searchRun++;
}

/** A new search from the box and filters; nothing happens while they are all empty. */
async function newSearch() {
  const q = ui.searchInput.value.trim();
  const set = await chosenSet();
  if (set === null) {
    ui.searchStatus.textContent = 'Pick a set from the list.';
    return;
  }
  const filters = { type: ui.searchType.value, set, word: ui.searchWord.getAttribute('aria-pressed') === 'true' };
  if (q || filters.type || filters.set) void runSearch(q, 1, filters);
}

/** Counts searches, so a newer one replaces the results of any still running. */
let searchRun = 0;

async function runSearch(q: string, page: number, filters = search.filters) {
  // Load more waits for the page before it; a new search goes ahead.
  if (page > 1 && search.busy) return;
  const run = ++searchRun;
  search = { q, page, hasMore: false, busy: true, filters };
  const forGame = game;
  if (page === 1) ui.results.replaceChildren();
  ui.searchStatus.textContent = 'Searching…';
  ui.loadMore.hidden = true;
  try {
    const res = await api.searchCards(forGame, q, page, filters);
    if (run !== searchRun || forGame !== game) return;
    search.hasMore = res.hasMore;
    for (const card of res.cards) ui.results.append(resultTile(card));
    const count = ui.results.childElementCount;
    ui.searchStatus.textContent = count ? `${count}${res.hasMore ? '+' : ''} results. Click one to add it, or drag it to a pocket.` : 'No cards found.';
    ui.loadMore.hidden = !res.hasMore;
  } catch (err) {
    if (run === searchRun) ui.searchStatus.textContent = `Search failed: ${(err as Error).message}`;
  } finally {
    if (run === searchRun) search.busy = false;
  }
}

function resultTile(card: CardRef) {
  const b = document.createElement('button');
  b.className = 'result';
  b.title = `${card.name}\n${card.set}${card.number ? ` #${card.number}` : ''}${card.rarity ? ` (${card.rarity})` : ''}\nClick to add as ${foilLabel(card.game, foilForNew[card.game])}, or drag it to a pocket`;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = card.name;
  img.src = api.imgUrl(card.thumb);
  img.draggable = false;
  const label = document.createElement('span');
  label.textContent = card.set;
  b.append(img, label);
  if (card.rarity) {
    const tag = document.createElement('b');
    tag.className = 'rarity';
    tag.textContent = card.rarity;
    b.append(tag);
  }
  b.addEventListener('click', () => !suppressResultClick && placeCard(card));
  b.addEventListener('pointerdown', (e) => {
    if (e.button === 0) resultPress = { card, x: e.clientX, y: e.clientY };
  });
  return b;
}

ui.gameTabs.addEventListener('click', (e) => {
  const g = (e.target as HTMLElement).closest('button')?.dataset.game as Game | undefined;
  if (g && g !== game) setGame(g);
});
ui.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void newSearch();
});
ui.searchWord.addEventListener('click', () => {
  ui.searchWord.setAttribute('aria-pressed', String(ui.searchWord.getAttribute('aria-pressed') !== 'true'));
  void newSearch();
});
ui.searchType.addEventListener('change', () => void newSearch());
// Picking from the list fires change; so do Enter and leaving the box.
ui.searchSet.addEventListener('change', () => void newSearch());
ui.searchSet.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ui.searchSet.blur();
});
ui.loadMore.addEventListener('click', () => runSearch(search.q, search.page + 1));
ui.foilSelect.addEventListener('change', () => {
  foilForNew[game] = ui.foilSelect.value as FoilKey;
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    if (drag) endDrag(false);
    else if (pageTyped) {
      pageTyped = '';
      clearTimeout(pageTimer);
      updatePager();
    } else if (inspecting) closeInspect();
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
    else if (e.key === 'ArrowRight') stepInspect(1);
    else if (e.key === 'ArrowLeft') stepInspect(-1);
    return;
  }
  if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !scene.isClosed) typePageDigit(e.key);
  else if (e.key === 'Enter' && pageTyped) goToTypedPage();
  else if (e.key === 'ArrowRight') scene.turnPage(1);
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

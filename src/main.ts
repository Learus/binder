import * as api from './api';
import { foilAges, foilLabel, normalizeFoil, printAge, RARITIES } from './foils';
import { BinderScene } from './three/binderScene';
import { TABLE_SLOTS, type TableEntry } from './three/shelf';
import { InspectView } from './three/inspect';
import type { SlotHit } from './three/pageView';
import { layoutOf, type Binder, type BinderLayout, type BinderSummary, type CardRef, type FoilKey, type Game, type Slot } from './types';

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
  inspectFlip: $<HTMLButtonElement>('inspect-flip'),
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
let search = { q: '', page: 1, hasMore: false, busy: false };

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
ui.sheetAdd.addEventListener('click', () => {
  if (!binder) return;
  binder.pages.push(...emptyPages(1, pocketsOf(binder)));
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
    binder.pages.push(...emptyPages(1, pocketsOf(binder)));
    target = { page: binder.pages.length - 2, slot: 0 };
  }
  binder.pages[target.page][target.slot] = { card, foil: foilForNew[card.game] };

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
  ui.inspectSet.textContent = [slot.card.set, slot.card.number && `#${slot.card.number}`, `page ${hit.page + 1}`]
    .filter(Boolean)
    .join(' · ');
  fillFoilSelect(ui.inspectFoil, slot.card.game, slot.foil);
  showAge(slot);
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
  delete slot.age;
  inspect.setFoil(slot.foil, slot);
  showAge(slot);
  changed();
});

function showAge(slot: Slot) {
  ui.inspectAgeRow.hidden = !foilAges(slot.card.game, slot.foil);
  const age = printAge(slot.card.game, slot.foil, slot.age);
  ui.inspectAge.value = String(age);
  ui.inspectAgeValue.textContent = ageLabel(age);
  ui.inspectOldRow.hidden = slot.card.game !== 'ygo';
  ui.inspectOld.checked = Boolean(slot.oldFrame);
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
    if (pageTyped) {
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

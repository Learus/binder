export type Game = 'mtg' | 'pokemon' | 'ygo';

export interface CardRef {
  game: Game;
  id: string;
  name: string;
  set: string;
  number: string;
  thumb: string;
  image: string;
  large: string;
  back?: string;
}

export type FoilKey =
  | 'none'
  | 'holo'
  | 'reverse'
  | 'cosmos'
  | 'fullart'
  | 'textured'
  | 'glitter'
  | 'rainbow'
  | 'gold'
  | 'goldsecret'
  | 'foil'
  | 'etched'
  | 'surge'
  | 'rare'
  | 'super'
  | 'ultra'
  | 'secret'
  | 'ultimate'
  | 'ghost'
  | 'starlight';

export interface Slot {
  card: CardRef;
  foil: FoilKey;
  /** 0 = fresh print, 1 = old print: greyer, deeper relief. Only rarities with a dim setting use it. */
  age?: number;
  /** Yu-Gi-Oh! only: the early frame with a shorter art window. */
  oldFrame?: boolean;
}

/** How a card is printed, apart from its rarity. */
export type PrintLook = Pick<Slot, 'age' | 'oldFrame'>;

export type BinderType = 'sleeve' | 'slab';
export type PocketCount = 4 | 9 | 16;
/**
 * The binder itself: a classic ring binder with a label, a padded zippered
 * binder, or a ringless PRO-style binder with an elastic strap.
 */
export type BinderStyle = 'ring' | 'zip' | 'pro';

/** Pockets per page (a square grid), what holds each card, and the binder style. */
export interface BinderLayout {
  pockets: PocketCount;
  type: BinderType;
  style: BinderStyle;
}

/** A binder's layout with defaults filled in. Slab binders always hold 4 slabs per page. */
export function layoutOf(b?: { layout?: Partial<BinderLayout> } | null): BinderLayout {
  const type: BinderType = b?.layout?.type === 'slab' ? 'slab' : 'sleeve';
  const p = b?.layout?.pockets;
  const pockets: PocketCount = type === 'slab' ? 4 : p === 4 || p === 16 ? p : 9;
  const style: BinderStyle = b?.layout?.style === 'zip' || b?.layout?.style === 'pro' ? b.layout.style : 'ring';
  return { pockets, type, style };
}

/**
 * A binder is a list of page sides. Sheet s has page 2s on its front and
 * page 2s+1 on its back, so the page count is always even.
 */
export interface Binder {
  id: string;
  name: string;
  cover: string;
  createdAt: number;
  updatedAt: number;
  /** Missing in older binders: 9 pockets per page, sleeves. */
  layout?: BinderLayout;
  pages: (Slot | null)[][];
}

export interface BinderSummary {
  id: string;
  name: string;
  updatedAt: number;
  cards: number;
  cover: string;
  sheets: number;
  layout?: BinderLayout;
}

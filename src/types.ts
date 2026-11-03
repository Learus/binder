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
}

export const SLOTS_PER_PAGE = 9;

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
  pages: (Slot | null)[][];
}

export interface BinderSummary {
  id: string;
  name: string;
  updatedAt: number;
  cards: number;
  cover: string;
  sheets: number;
}

import type { FoilKey, Game } from './types';

/** Which part of the card carries the foil. */
export enum Region {
  None = 0,
  Art = 1,
  OutsideArt = 2,
  Full = 3,
}

/** Surface structure of the foil sheet; must match the branches in holoMaterial.ts. */
export enum Pattern {
  Smooth = 0,
  Streaks = 1,
  Secret = 2,
  Glitter = 3,
  Cosmos = 4,
  Etched = 5,
  Surge = 6,
  /** Ultimate rare: fine relief lines pressed across the surface. */
  ReliefLines = 7,
}

/** Recolouring of the printed ink before the foil shows through it. */
export enum Tint {
  None = 0,
  Rainbow = 1,
  Gold = 2,
  Ghost = 3,
}

export enum NameFoil {
  None = 0,
  Silver = 1,
  Gold = 2,
  Rainbow = 3,
}

export interface FoilPreset {
  region: Region;
  pattern: Pattern;
  /** Colour of the bare metal: silver is white, gold is warm. */
  metal: [number, number, number];
  /** 0 = plain metallic reflection, 1 = full diffraction rainbow. */
  rainbow: number;
  tint: Tint;
  /** Title lettering stamped in foil (Yu-Gi-Oh! style). */
  name: NameFoil;
  /** How strongly the printed image is pressed into the surface. */
  emboss: number;
  /** Faint foil over everything outside the main region (ultra rare glow). */
  glow: number;
  /** Foil strength outside the art relative to inside it. */
  outside: number;
  /** Overall foil brightness. */
  strength: number;
  /** Outer border and art frame: plain, solid gold, or embossed relief. */
  trim: Trim;
  /** Darken and grey out the foiled parts (ultimate rare). */
  dim: number;
  /** Level stars pressed in and darkened like the trim. */
  embossStars: boolean;
  /** 0 = pattern everywhere in the region, 1 = only on the art's background. */
  backgroundOnly: number;
}

export enum Trim {
  None = 0,
  Gold = 1,
  Relief = 2,
}

const SILVER: [number, number, number] = [1, 1, 1];
const GOLD: [number, number, number] = [1.0, 0.76, 0.4];

const p = (o: Partial<FoilPreset>): FoilPreset => ({
  region: Region.None,
  pattern: Pattern.Smooth,
  metal: SILVER,
  rainbow: 1,
  tint: Tint.None,
  name: NameFoil.None,
  emboss: 0,
  glow: 0,
  outside: 1,
  strength: 1,
  trim: Trim.None,
  dim: 0,
  embossStars: false,
  backgroundOnly: 0,
  ...o,
});

interface Rarity {
  key: FoilKey;
  label: string;
  preset: FoilPreset;
}

/** Each game's rarities, in menu order. */
export const RARITIES: Record<Game, Rarity[]> = {
  pokemon: [
    { key: 'none', label: 'Common / Uncommon', preset: p({}) },
    { key: 'holo', label: 'Holo Rare', preset: p({ region: Region.Art, pattern: Pattern.Streaks }) },
    { key: 'reverse', label: 'Reverse Holo', preset: p({ region: Region.OutsideArt, rainbow: 0.85 }) },
    { key: 'cosmos', label: 'Cosmos Holo', preset: p({ region: Region.Art, pattern: Pattern.Cosmos }) },
    { key: 'fullart', label: 'Ultra Rare (full art)', preset: p({ region: Region.Full, pattern: Pattern.Etched, emboss: 0.5 }) },
    { key: 'textured', label: 'Illustration Rare', preset: p({ region: Region.Full, emboss: 1, rainbow: 0.7 }) },
    { key: 'glitter', label: 'Sparkle', preset: p({ region: Region.Full, pattern: Pattern.Glitter }) },
    { key: 'rainbow', label: 'Rainbow Rare', preset: p({ region: Region.Full, pattern: Pattern.Glitter, tint: Tint.Rainbow, emboss: 0.4 }) },
    {
      key: 'gold',
      label: 'Gold Secret Rare',
      preset: p({ region: Region.Full, pattern: Pattern.Glitter, tint: Tint.Gold, metal: GOLD, rainbow: 0.1, emboss: 0.7 }),
    },
  ],
  mtg: [
    { key: 'none', label: 'Non-foil', preset: p({}) },
    { key: 'foil', label: 'Traditional foil', preset: p({ region: Region.Full, rainbow: 0.85 }) },
    {
      key: 'etched',
      label: 'Foil-etched',
      preset: p({ region: Region.OutsideArt, pattern: Pattern.Etched, rainbow: 0.35, emboss: 0.3 }),
    },
    { key: 'glitter', label: 'Galaxy foil', preset: p({ region: Region.Full, pattern: Pattern.Glitter }) },
    { key: 'surge', label: 'Surge foil', preset: p({ region: Region.Full, pattern: Pattern.Surge }) },
    { key: 'textured', label: 'Textured foil', preset: p({ region: Region.Full, emboss: 1, rainbow: 0.75 }) },
    {
      key: 'gold',
      label: 'Gilded foil',
      preset: p({ region: Region.OutsideArt, tint: Tint.Gold, metal: GOLD, rainbow: 0.1, emboss: 0.7 }),
    },
    { key: 'rainbow', label: 'Rainbow foil', preset: p({ region: Region.Full, tint: Tint.Rainbow }) },
  ],
  ygo: [
    { key: 'none', label: 'Common', preset: p({}) },
    { key: 'rare', label: 'Rare', preset: p({ name: NameFoil.Silver }) },
    { key: 'super', label: 'Super Rare', preset: p({ region: Region.Art, rainbow: 0.9 }) },
    {
      key: 'ultra',
      label: 'Ultra Rare',
      preset: p({ region: Region.Art, rainbow: 0.9, name: NameFoil.Gold, glow: 0.5 }),
    },
    {
      key: 'secret',
      label: 'Secret Rare',
      preset: p({ region: Region.Art, pattern: Pattern.Secret, rainbow: 0.75, name: NameFoil.Silver, backgroundOnly: 0.8 }),
    },
    {
      key: 'ultimate',
      label: 'Ultimate Rare',
      preset: p({
        region: Region.Art,
        pattern: Pattern.ReliefLines,
        rainbow: 0.25,
        metal: [1, 0.9, 0.72],
        name: NameFoil.Gold,
        emboss: 1,
        trim: Trim.Relief,
        dim: 0.75,
        strength: 0.45,
        embossStars: true,
      }),
    },
    {
      key: 'ghost',
      label: 'Ghost Rare',
      preset: p({ region: Region.Art, tint: Tint.Ghost, rainbow: 0.15, name: NameFoil.Silver }),
    },
    {
      key: 'starlight',
      label: 'Starlight Rare',
      preset: p({ region: Region.Full, pattern: Pattern.Secret, rainbow: 0.7, outside: 0.4, name: NameFoil.Rainbow, trim: Trim.Relief }),
    },
    {
      key: 'gold',
      label: 'Gold Rare',
      preset: p({ region: Region.Art, pattern: Pattern.Secret, rainbow: 0.85, name: NameFoil.Gold, trim: Trim.Gold, backgroundOnly: 1 }),
    },
  ],
};

export function rarityOf(game: Game, foil: FoilKey): Rarity {
  return RARITIES[game].find((r) => r.key === foil) ?? RARITIES[game][0];
}

export function foilLabel(game: Game, foil: FoilKey): string {
  return rarityOf(game, foil).label;
}

// Keys from the first version, which shared one list across games.
const LEGACY: Record<Game, Record<string, FoilKey>> = {
  ygo: { holo: 'super', foil: 'ultra', prism: 'secret', etched: 'ultimate', glitter: 'starlight', cosmos: 'super', reverse: 'starlight' },
  pokemon: { foil: 'fullart', etched: 'textured', prism: 'rainbow' },
  mtg: { holo: 'foil', reverse: 'etched', cosmos: 'surge', prism: 'rainbow' },
};

/** Map a stored key to one this game supports. */
export function normalizeFoil(game: Game, foil: string): FoilKey {
  const key = (LEGACY[game][foil] ?? foil) as FoilKey;
  return RARITIES[game].some((r) => r.key === key) ? key : 'none';
}

/** Physical card size in cm and corner radius as a fraction of height. */
export const CARD_SIZE: Record<Game, { w: number; h: number; r: number }> = {
  mtg: { w: 6.3, h: 8.8, r: 0.036 },
  pokemon: { w: 6.3, h: 8.8, r: 0.036 },
  ygo: { w: 5.9, h: 8.6, r: 0.02 },
};

/**
 * Where the illustration sits, as [left, top, right, bottom] fractions of the
 * card image measured from the top-left. Measured on modern frames.
 */
export const ART_BOX: Record<Game, [number, number, number, number]> = {
  mtg: [0.076, 0.11, 0.926, 0.556],
  pokemon: [0.055, 0.103, 0.945, 0.485],
  ygo: [0.117, 0.182, 0.883, 0.708],
};

/** Where the card title is printed, same convention as ART_BOX. */
export const NAME_BOX: Record<Game, [number, number, number, number]> = {
  mtg: [0.07, 0.05, 0.75, 0.1],
  pokemon: [0.17, 0.03, 0.62, 0.085],
  ygo: [0.065, 0.047, 0.83, 0.106],
};

/**
 * Yu-Gi-Oh! frame parts, same convention as ART_BOX: the inside edge of the
 * outer border, the outside edge of the bevelled art frame, and the row of
 * level stars.
 */
export const YGO_FRAME = {
  inner: [0.032, 0.022, 0.968, 0.978] as [number, number, number, number],
  artFrame: [0.09, 0.165, 0.91, 0.725] as [number, number, number, number],
  stars: [0.06, 0.12, 0.94, 0.165] as [number, number, number, number],
};

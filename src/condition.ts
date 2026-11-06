import type { CardRef, Condition } from './types';

export const CONDITION_KEYS = ['crease', 'edges', 'scratches', 'fade'] as const satisfies readonly (keyof Condition)[];

export const CONDITION_LABELS: Record<keyof Condition, string> = {
  crease: 'Creases',
  edges: 'Edges & corners',
  scratches: 'Scratches',
  fade: 'Fading & grime',
};

export type Grade = 'NM' | 'SP' | 'LP' | 'PO';

/** The grades from best to worst, with their slider presets. */
export const GRADES: { key: Grade; name: string; condition: Condition }[] = [
  { key: 'NM', name: 'Near Mint', condition: { crease: 0, edges: 0, scratches: 0, fade: 0 } },
  { key: 'SP', name: 'Slightly Played', condition: { crease: 0, edges: 0.35, scratches: 0.3, fade: 0.1 } },
  { key: 'LP', name: 'Lightly Played', condition: { crease: 0.25, edges: 0.55, scratches: 0.5, fade: 0.25 } },
  { key: 'PO', name: 'Poor', condition: { crease: 0.9, edges: 0.9, scratches: 0.8, fade: 0.6 } },
];

export function conditionOf(c?: Partial<Condition> | null): Condition {
  const v = (x: unknown) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : 0);
  return { crease: v(c?.crease), edges: v(c?.edges), scratches: v(c?.scratches), fade: v(c?.fade) };
}

export function isMint(c?: Condition | null) {
  return !c || CONDITION_KEYS.every((k) => !c[k]);
}

/** The grade whose preset matches exactly, if any. */
export function gradeOf(c?: Condition | null): Grade | null {
  const cur = conditionOf(c);
  return GRADES.find((g) => CONDITION_KEYS.every((k) => Math.abs(g.condition[k] - cur[k]) < 1e-6))?.key ?? null;
}

/** A stable 0..1 number per card, so each copy wears in its own places. */
export function wearSeed(card?: CardRef) {
  const s = card ? `${card.game}:${card.id}` : '';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

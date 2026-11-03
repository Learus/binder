import * as THREE from 'three';
import { CARD_SIZE } from '../foils';
import type { Game, Slot } from '../types';
import { SLOTS_PER_PAGE } from '../types';
import { createCardMaterial, setCardFoilMap, setCardTexture, type SharedUniforms } from './holoMaterial';
import { coverLiningTexture, pageBackingTexture, type TextureCache } from './textures';

// Binder layout in centimetres. A page is a 3x3 grid of pockets.
export const POCKET_W = 6.6;
export const POCKET_H = 9.1;
export const POCKET_GAP = 0.35;
export const PAGE_MARGIN = 0.6;
export const PAGE_W = 3 * POCKET_W + 2 * POCKET_GAP + 2 * PAGE_MARGIN;
export const PAGE_H = 3 * POCKET_H + 2 * POCKET_GAP + 2 * PAGE_MARGIN;

/** Pocket centre in page-local coordinates (x right, y towards the top edge). */
export function slotCenter(i: number): { x: number; y: number } {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: (col - 1) * (POCKET_W + POCKET_GAP), y: (1 - row) * (POCKET_H + POCKET_GAP) };
}

export interface SlotHit {
  page: number;
  slot: number;
}

/** Shared GPU resources for every page so rebuilding a page is cheap. */
export class PageKit {
  readonly backingMat: THREE.MeshStandardMaterial;
  readonly sleeveMat: THREE.MeshStandardMaterial;
  readonly pageGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_H);
  readonly sleeveGeo = new THREE.PlaneGeometry(POCKET_W - 0.08, POCKET_H - 0.08);
  private cardGeos = new Map<Game, THREE.PlaneGeometry>();
  private liningMat: THREE.MeshStandardMaterial | null = null;
  private liningColor = '';

  constructor(
    readonly shared: SharedUniforms,
    readonly textures: TextureCache,
  ) {
    const rects = Array.from({ length: SLOTS_PER_PAGE }, (_, i) => ({ ...slotCenter(i), w: POCKET_W, h: POCKET_H }));
    this.backingMat = new THREE.MeshStandardMaterial({
      map: pageBackingTexture(PAGE_W, PAGE_H, rects),
      roughness: 0.9,
    });
    // Black, additive and glossy: only the environment reflection of the
    // plastic sleeve gets added on top of the card.
    this.sleeveMat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      roughness: 0.28,
      metalness: 0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      envMapIntensity: 0.55,
    });
  }

  cardGeo(game: Game) {
    let g = this.cardGeos.get(game);
    if (!g) {
      const s = CARD_SIZE[game];
      g = new THREE.PlaneGeometry(s.w, s.h);
      this.cardGeos.set(game, g);
    }
    return g;
  }

  lining(color: string) {
    if (!this.liningMat || this.liningColor !== color) {
      this.liningMat?.map?.dispose();
      this.liningMat?.dispose();
      this.liningMat = new THREE.MeshStandardMaterial({ map: coverLiningTexture(color), roughness: 0.75 });
      this.liningColor = color;
    }
    return this.liningMat;
  }
}

/**
 * One side of a sheet lying flat (y up), centred on its own origin.
 * `slots === null` draws the inside of the cover instead of pockets.
 */
export class PageView {
  readonly group = new THREE.Group();
  readonly hitTargets: THREE.Mesh[] = [];
  readonly cards: (THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null)[] = [];
  private pending: Promise<unknown>[] = [];
  private disposed = false;

  constructor(
    kit: PageKit,
    readonly pageIndex: number | null,
    slots: (Slot | null)[] | null,
    coverColor: string,
    /** Sleeves reflect the room straight back at an overhead snapshot camera, so leave them out there. */
    withSleeves = true,
  ) {
    const face = new THREE.Group();
    face.rotation.x = -Math.PI / 2;
    this.group.add(face);

    if (!slots || pageIndex === null) {
      const lining = new THREE.Mesh(kit.pageGeo, kit.lining(coverColor));
      lining.receiveShadow = true;
      face.add(lining);
      return;
    }

    const backing = new THREE.Mesh(kit.pageGeo, kit.backingMat);
    backing.receiveShadow = true;
    face.add(backing);
    for (let i = 0; i < SLOTS_PER_PAGE; i++) {
      const c = slotCenter(i);
      const slot = slots[i];
      if (slot) {
        const mat = createCardMaterial(slot.card.game, slot.foil, kit.shared);
        const mesh = new THREE.Mesh(kit.cardGeo(slot.card.game), mat);
        mesh.position.set(c.x, c.y, 0.02);
        mesh.userData.restZ = 0.02;
        face.add(mesh);
        this.cards.push(mesh);

        const { image } = slot.card;
        const ready = kit.textures.peek(image);
        if (ready) setCardTexture(mat, ready);
        else
          this.pending.push(
            kit.textures
              .get(image)
              .then((tex) => !this.disposed && setCardTexture(mat, tex))
              .catch((err) => console.warn('card image failed', slot.card.name, err)),
          );
        const map = kit.textures.peekFoilMap(image);
        if (map) setCardFoilMap(mat, map);
        else
          this.pending.push(
            kit.textures
              .getFoilMap(image, slot.card.game)
              .then((m) => !this.disposed && setCardFoilMap(mat, m))
              .catch((err) => console.warn('foil map failed', slot.card.name, err)),
          );
      } else {
        this.cards.push(null);
      }

      const sleeve = new THREE.Mesh(kit.sleeveGeo, kit.sleeveMat);
      sleeve.visible = withSleeves;
      sleeve.position.set(c.x, c.y, 0.06);
      sleeve.userData.hit = { page: pageIndex, slot: i } satisfies SlotHit;
      face.add(sleeve);
      this.hitTargets.push(sleeve);
    }
  }

  /** Resolves when card textures are in, or after `timeoutMs`. */
  ready(timeoutMs = 2500): Promise<void> {
    return Promise.race([
      Promise.all(this.pending).then(() => undefined),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  dispose() {
    this.disposed = true;
    for (const c of this.cards) c?.material.dispose();
    this.group.removeFromParent();
  }
}

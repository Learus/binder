import * as THREE from 'three';
import { CARD_SIZE } from '../foils';
import type { BinderLayout, Game, Slot } from '../types';
import { createCardMaterial, setCardFoilMap, setCardTexture, type SharedUniforms } from './holoMaterial';
import { buildSlab, SLAB_CARD_Y, SLAB_CARD_Z, SLAB_H, SLAB_W, SlabKit } from './slab';
import { coverLiningTexture, pageBackingTexture, type TextureCache } from './textures';

// Page space, in centimetres. Every page has this size whatever its layout;
// the pockets inside are scaled to fit, and the whole binder is then scaled
// (see realScale) so cards come out at their real size.
export const POCKET_W = 6.6;
export const POCKET_H = 9.1;
export const POCKET_GAP = 0.35;
export const PAGE_MARGIN = 0.6;
export const PAGE_W = 3 * POCKET_W + 2 * POCKET_GAP + 2 * PAGE_MARGIN;
export const PAGE_H = 3 * POCKET_H + 2 * POCKET_GAP + 2 * PAGE_MARGIN;

/** How a layout's pockets sit on a page, in page space. */
export interface PageGrid {
  layout: BinderLayout;
  cols: number;
  cellW: number;
  cellH: number;
  /** Real size to page space: a pocket's contents are drawn at this scale. */
  fit: number;
  /** Pocket size in page space. */
  pocketW: number;
  pocketH: number;
}

export function gridOf(layout: BinderLayout): PageGrid {
  const n = Math.round(Math.sqrt(layout.pockets));
  const cellW = (PAGE_W - 2 * PAGE_MARGIN - (n - 1) * POCKET_GAP) / n;
  const cellH = (PAGE_H - 2 * PAGE_MARGIN - (n - 1) * POCKET_GAP) / n;
  const [rw, rh] = layout.type === 'slab' ? [SLAB_W + 0.3, SLAB_H + 0.3] : [POCKET_W, POCKET_H];
  const fit = Math.min(cellW / rw, cellH / rh);
  return { layout, cols: n, cellW, cellH, fit, pocketW: rw * fit, pocketH: rh * fit };
}

/** How much to scale a binder with this layout so its cards are real size. */
export function realScale(layout: BinderLayout) {
  return 1 / gridOf(layout).fit;
}

/** Pocket centre in page-local coordinates (x right, y towards the top edge). */
export function slotCenter(i: number, grid: PageGrid): { x: number; y: number } {
  const n = grid.cols;
  const col = i % n;
  const row = Math.floor(i / n);
  return {
    x: (col - (n - 1) / 2) * (grid.cellW + POCKET_GAP),
    y: ((n - 1) / 2 - row) * (grid.cellH + POCKET_GAP),
  };
}

export interface SlotHit {
  page: number;
  slot: number;
}

/** Shared GPU resources for every page so rebuilding a page is cheap. */
export class PageKit {
  readonly sleeveMat: THREE.MeshStandardMaterial;
  readonly pageGeo = new THREE.PlaneGeometry(PAGE_W, PAGE_H);
  readonly sleeveGeo = new THREE.PlaneGeometry(POCKET_W - 0.08, POCKET_H - 0.08);
  readonly slabs = new SlabKit();
  private cardGeos = new Map<Game, THREE.PlaneGeometry>();
  private backings = new Map<string, THREE.MeshStandardMaterial>();
  private liningMat: THREE.MeshStandardMaterial | null = null;
  private liningColor = '';

  constructor(
    readonly shared: SharedUniforms,
    readonly textures: TextureCache,
  ) {
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

  /** Page backing with pocket outlines for a layout. */
  backing(grid: PageGrid) {
    const key = `${grid.cols}-${grid.layout.type}`;
    let m = this.backings.get(key);
    if (!m) {
      const rects = Array.from({ length: grid.layout.pockets }, (_, i) => ({
        ...slotCenter(i, grid),
        w: grid.pocketW,
        h: grid.pocketH,
      }));
      m = new THREE.MeshStandardMaterial({ map: pageBackingTexture(PAGE_W, PAGE_H, rects), roughness: 0.9 });
      this.backings.set(key, m);
    }
    return m;
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
  /** What rises when a pocket is hovered: the card, or the whole slab. */
  readonly lifts: (THREE.Object3D | null)[] = [];
  private pending: Promise<unknown>[] = [];
  private disposed = false;

  constructor(
    kit: PageKit,
    readonly pageIndex: number | null,
    slots: (Slot | null)[] | null,
    coverColor: string,
    /** Sleeves reflect the room straight back at an overhead snapshot camera, so leave them out there. */
    withSleeves: boolean,
    layout: BinderLayout,
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

    const grid = gridOf(layout);
    const backing = new THREE.Mesh(kit.pageGeo, kit.backing(grid));
    backing.receiveShadow = true;
    face.add(backing);

    for (let i = 0; i < layout.pockets; i++) {
      const c = slotCenter(i, grid);
      const slot = slots[i];
      let card: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
      if (slot) {
        card = new THREE.Mesh(kit.cardGeo(slot.card.game), createCardMaterial(slot.card.game, slot.foil, kit.shared, slot));
        this.loadCard(kit, card, slot);
      }
      this.cards.push(card);

      let target: THREE.Mesh;
      let lift: THREE.Object3D | null = card;
      if (layout.type === 'slab' && slot && card) {
        const slab = buildSlab(kit.slabs, slot.card, kit.sleeveMat);
        slab.top.visible = withSleeves;
        card.position.set(0, SLAB_CARD_Y, SLAB_CARD_Z);
        slab.group.add(card);
        slab.group.position.set(c.x, c.y, 0.02);
        slab.group.scale.setScalar(grid.fit);
        face.add(slab.group);
        target = slab.top;
        lift = slab.group;
      } else {
        if (card) {
          card.position.set(c.x, c.y, 0.02);
          card.scale.setScalar(grid.fit);
          face.add(card);
        }
        target = new THREE.Mesh(kit.sleeveGeo, kit.sleeveMat);
        target.visible = withSleeves;
        target.position.set(c.x, c.y, 0.06);
        target.scale.set(grid.pocketW / POCKET_W, grid.pocketH / POCKET_H, 1);
        face.add(target);
      }
      if (lift) {
        lift.userData.restZ = lift.position.z;
        lift.userData.baseScale = grid.fit;
      }
      this.lifts.push(lift);
      target.userData.hit = { page: pageIndex, slot: i } satisfies SlotHit;
      this.hitTargets.push(target);
    }
  }

  private loadCard(kit: PageKit, mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>, slot: Slot) {
    const mat = mesh.material;
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

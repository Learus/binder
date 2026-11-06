import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { layoutOf, type Binder, type BinderLayout } from '../types';
import { createSharedUniforms, type SharedUniforms } from './holoMaterial';
import { Flipper } from './flipper';
import { gridOf, PAGE_H, PAGE_W, PageKit, PageView, POCKET_H, POCKET_W, realScale, slotCenter, type SlotHit } from './pageView';
import { SLAB_T } from './slab';
import { TextureCache } from './textures';
import { createLights, createTable, ROOM_COLOR, studioEnvironment } from './room';
import { boardGeometry, coverNameTexture, elasticStrap, hasRings, stitchOverlay, styleCoverMaterial, zipGusset, zipperRim } from './styles';
import {
  BASE_Y,
  BOARD,
  closedBinder,
  DEPTH,
  HALF,
  namePlate,
  labelTexture,
  SHEET_THICKNESS,
  slotMarker,
  SPINE_GAP,
  TABLE_SLOTS,
  type TableEntry,
} from './shelf';

const COVER_TOP = 0;
const TURN_SECONDS = 0.85;
const CLOSE_SECONDS = 1.1;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Turn {
  dir: 1 | -1;
  target: number;
  /** How far the turn has gone, 0 = not started, 1 = done. */
  e: number;
  /** While true the pointer sets `e`; otherwise `e` animates from `from` to `to`. */
  drag: boolean;
  from: number;
  to: number;
  t: number;
  dur: number;
}

/** A left-press on a page's outer edge that may become a drag-turn. */
interface EdgeGrab {
  dir: 1 | -1;
  x: number;
  y: number;
  /** Distance of the grab point from the spine, in binder space. */
  r: number;
}

export interface BinderSceneEvents {
  onSlotClick(hit: SlotHit, mods: { shift: boolean; ctrl: boolean }): void;
  onSpreadChange(spread: number): void;
  /** A closed binder lying in a table slot was clicked. */
  onTableBinderClick(id: string): void;
  onEmptySlotClick(slot: number): void;
  /** The active binder was clicked while closed. */
  onClosedBinderClick(): void;
  /** Whether the pocket holds a card that can be picked up. */
  canDragSlot(hit: SlotHit): boolean;
  /** The pointer moved far enough with a card held down: a drag starts. */
  onCardDragStart(hit: SlotHit, e: PointerEvent): void;
}

interface Tween {
  t: number;
  dur: number;
  fn: (e: number) => void;
  done: () => void;
}

/** Free geometries, materials and textures under an object. */
function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of [o.material].flat() as THREE.Material[]) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}

export class BinderScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.5, 500);
  readonly shared: SharedUniforms = createSharedUniforms();
  readonly textures: TextureCache;
  private controls: OrbitControls;
  private kit: PageKit;
  private flipper = new Flipper(SPINE_GAP);
  private env: THREE.Texture;

  private binder: Binder | null = null;
  private layout: BinderLayout = layoutOf(null);
  /** Page space to world: makes the cards real size for this layout. */
  private scale = 1;
  private spread = 0;
  private left: PageView | null = null;
  private right: PageView | null = null;
  private turn: Turn | null = null;
  private edgeGrab: EdgeGrab | null = null;
  private queued: (1 | -1)[] = [];
  /** A spread typed in while a turn was running. */
  private queuedSpread: number | null = null;

  private coverMat = new THREE.MeshStandardMaterial({ color: '#5b2333', roughness: 0.7 });
  private stackMat = new THREE.MeshStandardMaterial({ color: '#d9d6cf', roughness: 0.9 });
  private leftStack: THREE.Mesh;
  private rightStack: THREE.Mesh;
  private highlight: THREE.Mesh;
  private selected: SlotHit | null = null;

  private snapScene = new THREE.Scene();
  private snapCam = new THREE.OrthographicCamera(-PAGE_W / 2, PAGE_W / 2, PAGE_H / 2, -PAGE_H / 2, 0.1, 50);

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerDown: { x: number; y: number } | null = null;
  /** A card pressed with the left button, not yet moved far enough to drag. */
  private cardPress: { hit: SlotHit; x: number; y: number } | null = null;
  private cardDragging = false;
  /** Card drag in progress: the pocket it would drop into, and the pocket it left. */
  private dropHit: SlotHit | null = null;
  private hiddenSlot: SlotHit | null = null;
  private lightTarget = new THREE.Vector3(0, 22, 8);
  private timer = new THREE.Timer();
  private overlays: ((dt: number) => void)[] = [];
  private inputBlocked = false;
  private hovered: SlotHit | null = null;

  // The active binder. Its left half hangs off a hinge at the spine so the
  // whole binder can be closed.
  private root = new THREE.Group();
  private pivot = new THREE.Group();
  private leftHalf = new THREE.Group();
  private spinePanel: THREE.Mesh;
  private rings: THREE.Mesh[] = [];
  private frontPlate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private boards: THREE.Mesh[] = [];
  private spine: THREE.Mesh;
  private spineGlass: THREE.Material;
  // Style parts, shown or hidden by applyStyle.
  private stitches: THREE.Object3D[] = [];
  private zipRims: THREE.Object3D[] = [];
  private gusset: ReturnType<typeof zipGusset>;
  private strap: ReturnType<typeof elasticStrap>;
  private closeAmount = 0;
  private busy = false;
  private tweens: Tween[] = [];

  // Closed binders resting in the table slots.
  private tableGroup = new THREE.Group();
  private tableItems: (THREE.Group | null)[] = TABLE_SLOTS.map(() => null);
  private markers: THREE.Mesh[] = [];
  private hoveredTable: THREE.Object3D | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: BinderSceneEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    this.textures = new TextureCache(this.renderer.capabilities.getMaxAnisotropy());
    this.kit = new PageKit(this.shared, this.textures);
    // Cards are small on screen in the binder, so let their foils show more.
    this.shared.uFoilBoost.value = 1.4;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.env = studioEnvironment(this.renderer);
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 1;
    this.scene.background = new THREE.Color(ROOM_COLOR);
    this.scene.fog = new THREE.Fog(ROOM_COLOR, 170, 380);
    this.scene.add(...createLights(true));
    this.snapScene.environment = this.env;
    this.snapScene.environmentIntensity = 1;
    this.snapScene.add(...createLights(false));
    this.snapCam.position.set(0, 20, 0);
    this.snapCam.up.set(0, 0, -1);
    this.snapCam.lookAt(0, 0, 0);

    // Table and binder shell.
    this.scene.add(createTable());

    this.scene.add(this.root);
    this.root.add(this.pivot);
    this.pivot.add(this.leftHalf);

    const boardGeo = new THREE.BoxGeometry(HALF, BOARD, DEPTH);
    const leftBoard = new THREE.Mesh(boardGeo, this.coverMat);
    const rightBoard = new THREE.Mesh(boardGeo, this.coverMat);
    leftBoard.position.set(-HALF / 2, COVER_TOP - BOARD / 2, 0);
    rightBoard.position.set(HALF / 2, COVER_TOP - BOARD / 2, 0);
    for (const b of [leftBoard, rightBoard]) b.castShadow = b.receiveShadow = true;
    this.leftHalf.add(leftBoard);
    this.root.add(rightBoard);
    this.boards = [leftBoard, rightBoard];
    this.spineGlass = new THREE.MeshStandardMaterial({ color: '#000', roughness: 0.6, transparent: true, opacity: 0.35 });
    this.spine = new THREE.Mesh(new THREE.BoxGeometry(SPINE_GAP * 1.6, BOARD + 0.01, DEPTH + 0.01), this.spineGlass);
    this.spine.position.y = COVER_TOP - BOARD / 2;
    this.root.add(this.spine);

    // Ringless styles: stitched seams on both faces of each cover.
    for (const b of [leftBoard, rightBoard]) {
      const up = stitchOverlay(HALF, DEPTH);
      up.position.y = BOARD / 2 + 0.004;
      const down = stitchOverlay(HALF, DEPTH);
      down.rotation.x = Math.PI / 2;
      down.position.y = -BOARD / 2 - 0.004;
      b.add(up, down);
      this.stitches.push(up, down);
    }
    // Zippered: half a zipper round each cover, and the gusset once closed.
    const leftRim = zipperRim(-1, HALF, BOARD, DEPTH);
    const rightRim = zipperRim(1, HALF, BOARD, DEPTH);
    leftBoard.add(leftRim);
    rightBoard.add(rightRim);
    this.zipRims = [leftRim, rightRim];
    this.gusset = zipGusset(this.coverMat, 0, HALF, DEPTH);
    this.root.add(this.gusset.group);
    // Pro: elastic strap round the closed binder, near the fore-edge.
    this.strap = elasticStrap(HALF - 2.8, DEPTH);
    this.root.add(this.strap.group);

    // Outside of the front cover: faces down while open, up once closed.
    this.frontPlate = namePlate('', 0);
    this.frontPlate.rotation.set(Math.PI / 2, 0, Math.PI);
    this.frontPlate.position.set(0, -BOARD / 2 - 0.005, -DEPTH * 0.18);
    leftBoard.add(this.frontPlate);

    // Spine wall shown when closed.
    this.spinePanel = new THREE.Mesh(new THREE.BoxGeometry(BOARD, 1, DEPTH), this.coverMat);
    this.spinePanel.castShadow = true;
    this.spinePanel.visible = false;
    this.root.add(this.spinePanel);

    const ringMat = new THREE.MeshStandardMaterial({ color: '#c9ccd2', metalness: 1, roughness: 0.22 });
    const ringGeo = new THREE.TorusGeometry(SPINE_GAP * 0.9, 0.11, 12, 32, Math.PI);
    for (const z of [-PAGE_H / 3, 0, PAGE_H / 3]) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(0, COVER_TOP, z);
      ring.castShadow = true;
      this.root.add(ring);
      this.rings.push(ring);
    }

    const stackGeo = new THREE.BoxGeometry(PAGE_W, 1, PAGE_H);
    this.leftStack = new THREE.Mesh(stackGeo, this.stackMat);
    this.rightStack = new THREE.Mesh(stackGeo, this.stackMat);
    this.leftStack.castShadow = this.rightStack.castShadow = true;
    this.leftStack.position.x = -(SPINE_GAP + PAGE_W / 2);
    this.rightStack.position.x = SPINE_GAP + PAGE_W / 2;
    this.leftHalf.add(this.leftStack);
    this.root.add(this.rightStack);

    // Glowing outline behind the selected pocket.
    this.highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(POCKET_W + 0.3, POCKET_H + 0.3),
      new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
    );
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.visible = false;
    this.root.add(this.highlight);

    this.root.add(this.flipper.group);

    for (const [x, z] of TABLE_SLOTS) {
      const m = slotMarker();
      m.position.set(x, BASE_Y - 0.04, z);
      m.userData.slot = this.markers.length;
      this.markers.push(m);
      this.tableGroup.add(m);
    }
    this.scene.add(this.tableGroup);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 260;
    // Left button is for clicking and turning pages; right-drag tilts the
    // view up and down (never sideways), middle-drag pans, the wheel zooms.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.minAzimuthAngle = 0;
    this.controls.maxAzimuthAngle = 0;
    this.resetView();

    canvas.addEventListener('pointermove', (e) => {
      this.onPointerMove(e);
      this.dragCard(e);
      this.dragTurn(e);
    });
    canvas.addEventListener('pointercancel', () => this.releaseDrag());
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => this.pointer.set(9, 9));
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- public API ----------

  /** The pocket under the mouse, if any. */
  get hoveredSlot(): SlotHit | null {
    return this.hovered;
  }

  /** Set by the inspect view: while true, the binder ignores clicks, hover and camera drags. */
  get blockInput() {
    return this.inputBlocked;
  }

  set blockInput(v: boolean) {
    this.inputBlocked = v;
    this.controls.enabled = !v;
  }

  get currentSpread() {
    return this.spread;
  }

  get spreadCount() {
    return this.binder ? this.binder.pages.length / 2 + 1 : 1;
  }

  get isTurning() {
    return this.turn !== null;
  }

  get isClosed() {
    return this.closeAmount >= 1;
  }

  /** True while a close, open or swap animation runs. */
  get isBusy() {
    return this.busy;
  }

  /** Pages visible on a spread: [left, right]; null means the inside of a cover. */
  pagesOf(spread: number): [number | null, number | null] {
    const n = this.binder?.pages.length ?? 0;
    const l = 2 * spread - 1;
    const r = 2 * spread;
    return [l >= 0 && l < n ? l : null, r >= 0 && r < n ? r : null];
  }

  setBinder(b: Binder, spread = 0, closed = false) {
    this.binder = b;
    this.layout = layoutOf(b);
    const scale = realScale(this.layout);
    const resized = scale !== this.scale;
    this.scale = scale;
    this.root.scale.setScalar(scale);
    // A bigger or smaller binder needs the camera pulled back or in.
    if (resized) this.fitToView();
    const grid = gridOf(this.layout);
    this.highlight.scale.set((grid.pocketW + 0.3) / (POCKET_W + 0.3), (grid.pocketH + 0.3) / (POCKET_H + 0.3), 1);
    this.coverMat.color.set(b.cover);
    this.applyStyle();
    this.turn = null;
    this.queued = [];
    this.queuedSpread = null;
    this.flipper.group.visible = false;
    this.spread = Math.min(spread, this.spreadCount - 1);
    this.rebuild();
    this.updateFrontPlate();
    this.applyClose(closed ? 1 : 0);
  }

  /** Swing the front cover shut, or open it again. */
  async setClosed(closed: boolean) {
    if (this.busy || this.turn || closed === this.isClosed) return;
    this.busy = true;
    this.highlight.visible = false;
    await this.tween(CLOSE_SECONDS, (e) => this.applyClose(closed ? e : 1 - e));
    this.busy = false;
    this.placeHighlight();
  }

  /** Show closed binders in the table slots; null leaves a slot empty. */
  setTable(entries: (TableEntry | null)[]) {
    this.hoveredTable = null;
    TABLE_SLOTS.forEach(([x, z], i) => {
      const old = this.tableItems[i];
      if (old) {
        old.removeFromParent();
        disposeTree(old);
      }
      const entry = entries[i] ?? null;
      const item = entry ? closedBinder(entry, this.stackMat) : null;
      item?.position.set(x, BASE_Y, z);
      if (item) this.tableGroup.add(item);
      this.tableItems[i] = item;
      this.markers[i].visible = !entry;
    });
  }

  /**
   * With the active binder closed: slide it to `toSlot` (or off the table
   * when -1) while `incoming` slides from `fromSlot` (or drops in from
   * above when -1) to the middle. Call setBinder(…, closed) afterwards.
   */
  async swap(outgoing: TableEntry, toSlot: number, incoming: TableEntry, fromSlot: number) {
    this.busy = true;
    this.root.visible = false;
    const out = closedBinder(outgoing, this.stackMat);
    out.position.set(0, BASE_Y, 0);
    this.scene.add(out);
    let inc = fromSlot >= 0 ? this.tableItems[fromSlot] : null;
    if (inc) {
      this.tableItems[fromSlot] = null;
    } else {
      inc = closedBinder(incoming, this.stackMat);
      inc.position.set(0, 45, 25);
      this.scene.add(inc);
    }
    const outFrom = out.position.clone();
    const outTo = toSlot >= 0 ? new THREE.Vector3(TABLE_SLOTS[toSlot][0], BASE_Y, TABLE_SLOTS[toSlot][1]) : new THREE.Vector3(0, 45, -80);
    const incFrom = inc.position.clone();
    const incTo = new THREE.Vector3(0, BASE_Y, 0);
    const moving = inc;
    await this.tween(0.9, (e) => {
      const lift = Math.sin(e * Math.PI) * 8;
      out.position.lerpVectors(outFrom, outTo, e).y += lift;
      moving.position.lerpVectors(incFrom, incTo, e).y += lift;
    });
    for (const g of [out, moving]) {
      g.removeFromParent();
      disposeTree(g);
    }
    this.root.visible = true;
    this.busy = false;
  }

  /** Redraw the name plate on the front cover. */
  updateFrontPlate() {
    if (!this.binder) return;
    const mat = this.frontPlate.material;
    const { style } = this.layout;
    const cards = this.binder.pages.flat().filter(Boolean).length;
    mat.map?.dispose();
    mat.map = style === 'ring' ? labelTexture(this.binder.name, cards) : coverNameTexture(this.binder.name, cards, style);
    mat.transparent = style !== 'ring';
    mat.needsUpdate = true;
  }

  /** Cover surface, board shape and the parts that belong to the binder style. */
  private applyStyle() {
    const { style } = this.layout;
    styleCoverMaterial(this.coverMat, style);
    for (const b of this.boards) b.geometry = boardGeometry(style, HALF, BOARD, DEPTH);
    this.spine.material = hasRings(style) ? this.spineGlass : this.coverMat;
    for (const s of this.stitches) s.visible = style !== 'ring';
  }

  /** Pull the camera back to show the whole table. */
  tableView() {
    this.controls.target.set(0, 0, -12);
    this.camera.position.set(0, 175, 100);
    this.controls.update();
  }

  /** Call after the binder's pages changed in place. */
  refresh() {
    if (!this.binder) return;
    this.coverMat.color.set(this.binder.cover);
    this.updateFrontPlate();
    this.spread = Math.min(this.spread, this.spreadCount - 1);
    if (!this.turn) this.rebuild();
  }

  jumpTo(spread: number) {
    if (this.turn || spread === this.spread) return;
    this.spread = THREE.MathUtils.clamp(spread, 0, this.spreadCount - 1);
    this.rebuild();
    this.events.onSpreadChange(this.spread);
  }

  turnPage(dir: 1 | -1) {
    if (this.busy || this.closeAmount > 0) return;
    if (this.turn) {
      this.queuedSpread = null;
      if (this.queued.length < 2) this.queued.push(dir);
      return;
    }
    void this.startTurn(dir);
  }

  /** Turn straight to a spread, in one sheet turn. */
  turnTo(spread: number) {
    spread = THREE.MathUtils.clamp(spread, 0, this.spreadCount - 1);
    if (this.busy || this.closeAmount > 0) return;
    if (this.turn) {
      // Go there once the current turn lands.
      this.queued = [];
      this.queuedSpread = spread;
      return;
    }
    if (spread !== this.spread) void this.startTurn(spread > this.spread ? 1 : -1, false, spread);
  }

  /**
   * Where the binder is on screen, in CSS pixels from the canvas's top left:
   * the middle of its left and right edges and the middle of its near edge.
   * Null when it's behind the camera.
   */
  screenBounds(): { left: THREE.Vector2; right: THREE.Vector2; bottom: THREE.Vector2 } | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const outer = HALF;
    // Closed, only the right half is left (shifted to the middle by the root).
    const x0 = THREE.MathUtils.lerp(-outer, 0, this.closeAmount);
    const y = COVER_TOP;
    const toScreen = (x: number, z: number) => {
      const p = this.root.localToWorld(new THREE.Vector3(x, y, z)).project(this.camera);
      return p.z > 1 ? null : new THREE.Vector2(((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h);
    };
    const left = toScreen(x0, 0);
    const right = toScreen(outer, 0);
    const near = [toScreen(x0, DEPTH / 2), toScreen(outer, DEPTH / 2)];
    if (!left || !right || !near[0] || !near[1]) return null;
    const bottom = new THREE.Vector2((near[0].x + near[1].x) / 2, Math.max(near[0].y, near[1].y));
    return { left, right, bottom };
  }

  /** The pocket at a point on the page (client pixels), if the binder is open and idle. */
  slotAtClient(x: number, y: number): SlotHit | null {
    const r = this.canvas.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    this.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    return this.pick();
  }

  /** -1 or 1 when a point is past the binder's left or right edge (beside it), else 0. */
  edgeAtClient(x: number, y: number): -1 | 0 | 1 {
    const r = this.canvas.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return 0;
    this.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const p = this.pagePoint();
    if (!p || Math.abs(p.z) > PAGE_H / 2 + 2) return 0;
    const outer = SPINE_GAP + PAGE_W;
    return p.x < -outer ? -1 : p.x > outer ? 1 : 0;
  }

  /** While a card is dragged: highlight where it would land, and hide the card being moved. */
  setCardDrag(drop: SlotHit | null, hidden: SlotHit | null) {
    this.dropHit = drop;
    this.hiddenSlot = hidden;
    this.placeHighlight();
  }

  setSelected(hit: SlotHit | null) {
    this.selected = hit;
    this.placeHighlight();
  }

  resetView() {
    this.controls.target.set(0, 0, 1.5);
    this.camera.position.set(0, 58, 34);
    this.controls.update();
    this.fitToView();
  }

  /** Register a callback that renders on top of the binder each frame. */
  addOverlay(fn: (dt: number) => void) {
    this.overlays.push(fn);
  }

  // ---------- page building ----------

  private makePage(page: number | null, withSleeves = true): PageView {
    const b = this.binder!;
    return new PageView(this.kit, page, page === null ? null : b.pages[page], b.cover, withSleeves, this.layout);
  }

  private placePage(view: PageView, side: 'left' | 'right', y: number) {
    view.group.position.set((side === 'left' ? -1 : 1) * (SPINE_GAP + PAGE_W / 2), y, 0);
    (side === 'left' ? this.leftHalf : this.root).add(view.group);
  }

  /**
   * The hinge sits above the spine, high enough that the left page lands on
   * the right one with room for both pages of cards when closed.
   */
  private hingeHeight() {
    const h = this.stackHeights(this.spread);
    return (h.left + h.right) / 2 + 0.12;
  }

  /** 0 = lying open, 1 = closed and centred where the open binder was. */
  private applyClose(e: number) {
    this.closeAmount = e;
    const h0 = this.hingeHeight();
    this.pivot.position.y = h0;
    this.leftHalf.position.y = -h0;
    this.pivot.rotation.z = -Math.PI * e;
    this.root.position.x = (-HALF / 2) * e * this.scale;
    const { style } = this.layout;
    const ring = hasRings(style) ? Math.max(0, 1 - e * 3) : 0;
    for (const r of this.rings) {
      r.scale.setScalar(Math.max(ring, 0.0001));
      r.visible = ring > 0;
    }
    const wall = THREE.MathUtils.clamp((e - 0.5) * 2, 0, 1);
    this.spinePanel.visible = wall > 0;
    const height = 2 * h0 + 2 * BOARD;
    this.spinePanel.scale.y = Math.max(wall * height, 0.001);
    this.spinePanel.position.set(-BOARD / 2, COVER_TOP - BOARD + (wall * height) / 2, 0);
    for (const rim of this.zipRims) rim.visible = style === 'zip' && wall === 0;
    this.gusset.group.visible = style === 'zip' && wall > 0;
    if (wall > 0) this.gusset.set(COVER_TOP - BOARD / 2, Math.max(wall * (height - BOARD), 0.001));
    this.strap.group.visible = style === 'pro' && e >= 1;
    this.strap.set(COVER_TOP - BOARD, height);
    if (e > 0) this.highlight.visible = false;
  }

  private tween(dur: number, fn: (e: number) => void): Promise<void> {
    return new Promise((done) => this.tweens.push({ t: 0, dur, fn, done }));
  }

  private stackHeights(spread: number) {
    const sheets = (this.binder?.pages.length ?? 0) / 2;
    const leftSheets = spread;
    const rightSheets = sheets - spread;
    return {
      left: COVER_TOP + 0.02 + leftSheets * SHEET_THICKNESS,
      right: COVER_TOP + 0.02 + rightSheets * SHEET_THICKNESS,
    };
  }

  private setStacks(left: number, right: number) {
    for (const [mesh, top] of [
      [this.leftStack, left],
      [this.rightStack, right],
    ] as const) {
      // Sits a little below the page so the two never z-fight.
      const h = Math.max(top - COVER_TOP - 0.01, 0.001);
      mesh.scale.y = h;
      mesh.position.y = COVER_TOP + h / 2;
    }
  }

  private rebuild() {
    if (!this.binder) return;
    this.left?.dispose();
    this.right?.dispose();
    const [l, r] = this.pagesOf(this.spread);
    const h = this.stackHeights(this.spread);
    this.setStacks(h.left, h.right);
    this.left = this.makePage(l);
    this.right = this.makePage(r);
    this.placePage(this.left, 'left', h.left + 0.02);
    this.placePage(this.right, 'right', h.right + 0.02);
    this.applyClose(this.closeAmount);
    this.placeHighlight();
    this.retainTextures();
  }

  /** Keep textures for this spread and its neighbours; prefetch the neighbours. */
  private retainTextures() {
    const b = this.binder!;
    const keep = new Set<string>();
    for (let s = this.spread - 1; s <= this.spread + 1; s++) {
      for (const p of this.pagesOf(s)) {
        if (p === null) continue;
        for (const slot of b.pages[p]) {
          if (!slot) continue;
          keep.add(slot.card.image);
          if (s !== this.spread) this.textures.get(slot.card.image).catch(() => {});
        }
      }
    }
    this.textures.retain(keep);
  }

  private placeHighlight() {
    const sel = this.dropHit ?? this.selected;
    const [l, r] = this.pagesOf(this.spread);
    const side = sel && !this.turn && this.closeAmount === 0 ? (sel.page === l ? 'left' : sel.page === r ? 'right' : null) : null;
    this.highlight.visible = side !== null;
    if (!side || !sel) return;
    const c = slotCenter(sel.slot, gridOf(this.layout));
    const h = this.stackHeights(this.spread);
    this.highlight.position.set(
      (side === 'left' ? -1 : 1) * (SPINE_GAP + PAGE_W / 2) + c.x,
      (side === 'left' ? h.left : h.right) + 0.025,
      -c.y,
    );
  }

  private async snapshot(page: number | null, rt: THREE.WebGLRenderTarget) {
    const view = this.makePage(page, false);
    this.snapScene.add(view.group);
    await view.ready();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor('#000', 1);
    this.renderer.clear();
    this.renderer.render(this.snapScene, this.snapCam);
    this.renderer.setRenderTarget(null);
    view.dispose();
  }

  // ---------- turning ----------

  /** Turn one sheet; with `to`, the sheet lands on that spread, skipping the ones between. */
  private async startTurn(dir: 1 | -1, drag = false, to = this.spread + dir) {
    const target = to;
    if (!this.binder || target < 0 || target >= this.spreadCount || target === this.spread) return;
    this.turn = { dir, target, e: 0, drag, from: 0, to: 1, t: 0, dur: TURN_SECONDS };
    this.highlight.visible = false;

    // The moving sheet shows the page it lifts off one side and the page it
    // lands with on the other: forward = this right page, then the target's
    // left page; backward = the target's right page, then this left page.
    const [lo, hi] = dir === 1 ? [this.spread, target] : [target, this.spread];
    const frontPage = 2 * lo;
    const backPage = 2 * hi - 1;
    // Sequential: both snapshots share one offscreen scene.
    await this.snapshot(frontPage, this.flipper.frontRT);
    await this.snapshot(backPage, this.flipper.backRT);
    if (!this.turn) return;

    // Swap in the page that the moving sheet uncovers.
    const [nl, nr] = this.pagesOf(target);
    const hFrom = this.stackHeights(this.spread);
    const hTo = this.stackHeights(target);
    if (dir === 1) {
      this.right?.dispose();
      this.right = this.makePage(nr);
      this.placePage(this.right, 'right', hTo.right + 0.02);
      this.setStacks(hFrom.left, hTo.right);
    } else {
      this.left?.dispose();
      this.left = this.makePage(nl);
      this.placePage(this.left, 'left', hTo.left + 0.02);
      this.setStacks(hTo.left, hFrom.right);
    }
    this.flipper.group.visible = true;
    this.stepTurn(0);
  }

  private stepTurn(dt: number) {
    const turn = this.turn!;
    if (!this.flipper.group.visible) return; // still taking snapshots
    if (!turn.drag) {
      turn.t = Math.min(1, turn.t + dt / turn.dur);
      // A full turn eases in and out; finishing a drag only eases out.
      const k = turn.from === 0 && turn.to === 1 ? easeInOut(turn.t) : 1 - (1 - turn.t) ** 2;
      turn.e = turn.from + (turn.to - turn.from) * k;
    }
    const progress = turn.dir === 1 ? turn.e : 1 - turn.e;
    const lo = Math.min(this.spread, turn.target);
    const h = this.stackHeights(lo);
    const hNext = this.stackHeights(Math.max(this.spread, turn.target));
    // Slabs stand up off the page; the turning sheet lies on top of them.
    const above = this.layout.type === 'slab' ? SLAB_T * gridOf(this.layout).fit + 0.05 : 0;
    this.flipper.update(progress, turn.dir, h.right + above, hNext.left + above);

    if (!turn.drag && turn.t >= 1) {
      const done = turn.to === 1;
      if (done) this.spread = turn.target;
      this.turn = null;
      this.flipper.group.visible = false;
      this.rebuild();
      if (done) this.events.onSpreadChange(this.spread);
      const next = this.queued.shift();
      if (next) void this.startTurn(next);
      else if (this.queuedSpread !== null) {
        const spread = this.queuedSpread;
        this.queuedSpread = null;
        this.turnTo(spread);
      }
    }
  }

  // ---------- input ----------

  private onPointerMove(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /**
   * Where the pointer meets the open pages, in binder space (the root's local
   * frame), or null when the binder isn't open and idle.
   */
  private pagePoint(): THREE.Vector3 | null {
    if (this.closeAmount > 0 || this.busy || !this.binder) return null;
    const h = this.stackHeights(this.spread);
    const top = this.root.localToWorld(new THREE.Vector3(0, Math.max(h.left, h.right), 0)).y;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -top), p)) return null;
    return this.root.worldToLocal(p);
  }

  /** The page edge under the pointer that can be dragged to turn, if any. */
  private edgeUnderPointer(): EdgeGrab | null {
    if (this.turn || this.blockInput) return null;
    const p = this.pagePoint();
    if (!p || Math.abs(p.z) > PAGE_H / 2) return null;
    const inner = SPINE_GAP + PAGE_W * 0.7;
    const outer = SPINE_GAP + PAGE_W + 0.5;
    const r = Math.abs(p.x);
    if (r < inner || r > outer) return null;
    const dir = p.x > 0 ? 1 : -1;
    const target = this.spread + dir;
    if (target < 0 || target >= this.spreadCount) return null;
    return { dir, x: 0, y: 0, r: Math.min(r, SPINE_GAP + PAGE_W) };
  }

  private onPointerDown(e: PointerEvent) {
    this.pointerDown = { x: e.clientX, y: e.clientY };
    this.onPointerMove(e);
    // A card picks up; anywhere else on the page's outer part grabs the page.
    const hit = e.button === 0 && !this.blockInput ? this.pick() : null;
    if (hit && this.events.canDragSlot(hit)) {
      this.cardPress = { hit, x: e.clientX, y: e.clientY };
      this.edgeGrab = null;
      // Keep getting the release even when it lands outside the canvas.
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const grab = e.button === 0 ? this.edgeUnderPointer() : null;
    this.edgeGrab = grab && { ...grab, x: e.clientX, y: e.clientY };
    if (grab) this.canvas.setPointerCapture(e.pointerId);
  }

  /** Drag-turning: the page's free edge follows the pointer around the spine. */
  private dragTurn(e: PointerEvent) {
    const grab = this.edgeGrab;
    if (!grab) return;
    if (!this.turn) {
      // Becomes a turn once the pointer moves towards the spine; a plain
      // click on the edge still picks the pocket there.
      const dx = (e.clientX - grab.x) * -grab.dir;
      if (dx < 8 || this.busy || this.closeAmount > 0) return;
      this.canvas.style.cursor = 'grabbing';
      void this.startTurn(grab.dir, true);
    }
    const turn = this.turn;
    if (!turn?.drag) return;
    const p = this.pagePoint();
    if (!p) return;
    const progress = Math.acos(THREE.MathUtils.clamp(p.x / grab.r, -1, 1)) / Math.PI;
    turn.e = turn.dir === 1 ? progress : 1 - progress;
  }

  /** Let go of a dragged page: it falls the way it's leaning. */
  private releaseDrag() {
    const turn = this.turn;
    this.edgeGrab = null;
    if (!turn?.drag) return;
    turn.drag = false;
    turn.from = turn.e;
    turn.to = turn.e > 0.5 ? 1 : 0;
    turn.t = 0;
    turn.dur = Math.max(0.15, TURN_SECONDS * Math.abs(turn.to - turn.from));
  }

  private dragCard(e: PointerEvent) {
    const press = this.cardPress;
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    this.cardPress = null;
    this.cardDragging = true;
    this.events.onCardDragStart(press.hit, e);
  }

  private onPointerUp(e: PointerEvent) {
    const down = this.pointerDown;
    this.pointerDown = null;
    this.cardPress = null;
    if (this.cardDragging) {
      this.cardDragging = false;
      return;
    }
    if (this.turn?.drag) return this.releaseDrag();
    this.edgeGrab = null;
    if (!down || this.blockInput || this.busy || e.button !== 0) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // that was a drag
    const hit = this.pick();
    if (hit) return this.events.onSlotClick(hit, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    const t = this.pickTable();
    if (t?.kind === 'binder') this.events.onTableBinderClick(t.id);
    else if (t?.kind === 'empty') this.events.onEmptySlotClick(t.slot);
    else if (t?.kind === 'active') this.events.onClosedBinderClick();
  }

  /** What on the table is under the pointer: a resting binder, an empty slot, or the closed active binder. */
  private pickTable():
    | { kind: 'binder'; id: string; obj: THREE.Object3D }
    | { kind: 'empty'; slot: number }
    | { kind: 'active' }
    | null {
    if (this.busy || this.turn) return null;
    const targets: THREE.Object3D[] = [...this.tableItems.filter((g): g is THREE.Group => !!g), ...this.markers.filter((m) => m.visible)];
    if (this.isClosed) targets.push(this.root);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.entryId) return { kind: 'binder', id: o.userData.entryId, obj: o };
      if (o.userData.slot !== undefined) return { kind: 'empty', slot: o.userData.slot };
      if (o === this.root) return { kind: 'active' };
    }
    return null;
  }

  private pick(): SlotHit | null {
    if (this.turn || this.busy || this.closeAmount > 0) return null;
    const targets = [...(this.left?.hitTargets ?? []), ...(this.right?.hitTargets ?? [])];
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return (hit?.object.userData.hit as SlotHit) ?? null;
  }

  // ---------- frame ----------

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Move the camera along its current direction until the open binder fits. */
  private fitToView() {
    // Room at the sides for the page arrows.
    const halfW = (HALF + 3) * this.scale;
    const halfH = (PAGE_H / 2 + 1.5) * this.scale;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hFov = Math.atan(Math.tan(vFov) * this.camera.aspect);
    const dist = Math.max(halfW / Math.tan(hFov), (halfH / Math.tan(vFov)) * 1.15) * 1.05;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.shared.uTime.value += dt;
    this.controls.update();
    if (this.turn) this.stepTurn(dt);
    for (const tw of [...this.tweens]) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      tw.fn(easeInOut(tw.t / tw.dur));
      if (tw.t >= tw.dur) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.done();
      }
    }

    // The light follows the mouse across the table so foils react to it.
    if (!this.blockInput && Math.abs(this.pointer.x) <= 1) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) {
        // Put the light where its mirror reflection off the table, at the
        // pointer, goes straight into the camera: the card under the mouse
        // catches it like a card tilted under a lamp, and cards further
        // away get the softer edge of the reflection.
        const r = p.clone().sub(this.camera.position).normalize();
        r.y = -r.y;
        this.lightTarget.copy(p).addScaledVector(r, 24);
      }
    }
    this.shared.uLight.value.lerp(this.lightTarget, 1 - Math.exp(-dt * 8));
    this.updateHover(dt);

    if (this.highlight.visible) {
      const m = this.highlight.material as THREE.MeshBasicMaterial;
      m.opacity = 0.55 + 0.35 * Math.sin(this.shared.uTime.value * 4);
    }

    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(ROOM_COLOR, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.overlays) fn(dt);
  }

  private updateHover(dt: number) {
    const hit = this.blockInput || Math.abs(this.pointer.x) > 1 ? null : this.pick();
    this.hovered = hit;
    let card: THREE.Object3D | null = null;
    if (hit) {
      const view = [this.left, this.right].find((v) => v?.pageIndex === hit.page);
      card = view?.lifts[hit.slot] ?? null;
    }
    const table = hit || this.blockInput || Math.abs(this.pointer.x) > 1 ? null : this.pickTable();
    this.hoveredTable = table?.kind === 'binder' ? table.obj : null;
    this.canvas.style.cursor = this.turn?.drag || this.cardDragging
      ? 'grabbing'
      : hit || table
        ? 'pointer'
        : this.edgeUnderPointer()
          ? 'grab'
          : '';
    for (const item of this.tableItems) {
      if (!item) continue;
      const target = BASE_Y + (item === this.hoveredTable ? 0.6 : 0);
      item.position.y += (target - item.position.y) * (1 - Math.exp(-dt * 12));
    }
    const hidden = this.hiddenSlot;
    for (const view of [this.left, this.right]) {
      for (const [i, c] of (view?.lifts ?? []).entries()) {
        if (!c) continue;
        c.visible = !(hidden && view!.pageIndex === hidden.page && hidden.slot === i);
        const target = c.userData.restZ + (c === card ? 0.035 : 0);
        c.position.z += (target - c.position.z) * (1 - Math.exp(-dt * 14));
        c.scale.setScalar(c.userData.baseScale * (1 + (c.position.z - c.userData.restZ) * 0.6));
      }
    }
  }
}

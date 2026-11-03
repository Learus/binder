import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Binder } from '../types';
import { createSharedUniforms, type SharedUniforms } from './holoMaterial';
import { Flipper } from './flipper';
import { PAGE_H, PAGE_W, PageKit, PageView, POCKET_H, POCKET_W, slotCenter, type SlotHit } from './pageView';
import { TextureCache } from './textures';
import { createLights, createTable, ROOM_COLOR, studioEnvironment } from './room';
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
  t: number;
  target: number;
}

export interface BinderSceneEvents {
  onSlotClick(hit: SlotHit, mods: { shift: boolean; ctrl: boolean }): void;
  onSpreadChange(spread: number): void;
  /** A closed binder lying in a table slot was clicked. */
  onTableBinderClick(id: string): void;
  onEmptySlotClick(slot: number): void;
  /** The active binder was clicked while closed. */
  onClosedBinderClick(): void;
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
  private spread = 0;
  private left: PageView | null = null;
  private right: PageView | null = null;
  private turn: Turn | null = null;
  private queued: (1 | -1)[] = [];

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

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.env = studioEnvironment(this.renderer);
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 1;
    this.scene.background = new THREE.Color(ROOM_COLOR);
    this.scene.fog = new THREE.Fog(ROOM_COLOR, 110, 260);
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
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(SPINE_GAP * 1.6, BOARD + 0.01, DEPTH + 0.01),
      new THREE.MeshStandardMaterial({ color: '#000', roughness: 0.6, transparent: true, opacity: 0.35 }),
    );
    spine.position.y = COVER_TOP - BOARD / 2;
    this.root.add(spine);

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
    this.controls.maxDistance = 160;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.resetView();

    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerdown', (e) => (this.pointerDown = { x: e.clientX, y: e.clientY }));
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
    this.coverMat.color.set(b.cover);
    this.turn = null;
    this.queued = [];
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
    mat.map?.dispose();
    mat.map = labelTexture(this.binder.name, this.binder.pages.flat().filter(Boolean).length);
    mat.needsUpdate = true;
  }

  /** Pull the camera back to show the whole table. */
  tableView() {
    this.controls.target.set(0, 0, -10);
    this.camera.position.set(0, 128, 72);
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
      if (this.queued.length < 2) this.queued.push(dir);
      return;
    }
    void this.startTurn(dir);
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
    return new PageView(this.kit, page, page === null ? null : b.pages[page], b.cover, withSleeves);
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
    this.root.position.x = (-HALF / 2) * e;
    const ring = Math.max(0, 1 - e * 3);
    for (const r of this.rings) {
      r.scale.setScalar(Math.max(ring, 0.0001));
      r.visible = ring > 0;
    }
    const wall = THREE.MathUtils.clamp((e - 0.5) * 2, 0, 1);
    this.spinePanel.visible = wall > 0;
    const height = 2 * h0 + 2 * BOARD;
    this.spinePanel.scale.y = Math.max(wall * height, 0.001);
    this.spinePanel.position.set(-BOARD / 2, COVER_TOP - BOARD + (wall * height) / 2, 0);
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
    const sel = this.selected;
    const [l, r] = this.pagesOf(this.spread);
    const side = sel && !this.turn && this.closeAmount === 0 ? (sel.page === l ? 'left' : sel.page === r ? 'right' : null) : null;
    this.highlight.visible = side !== null;
    if (!side || !sel) return;
    const c = slotCenter(sel.slot);
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

  private async startTurn(dir: 1 | -1) {
    const target = this.spread + dir;
    if (!this.binder || target < 0 || target >= this.spreadCount) return;
    this.turn = { dir, t: 0, target };
    this.highlight.visible = false;

    // The sheet that moves: forward = the right page's sheet, backward = the left page's sheet.
    const sheet = dir === 1 ? this.spread : this.spread - 1;
    const frontPage = 2 * sheet;
    const backPage = 2 * sheet + 1;
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
    turn.t = Math.min(1, turn.t + dt / TURN_SECONDS);
    const e = easeInOut(turn.t);
    const progress = turn.dir === 1 ? e : 1 - e;
    const lo = Math.min(this.spread, turn.target);
    const h = this.stackHeights(lo);
    const hNext = this.stackHeights(lo + 1);
    this.flipper.update(progress, turn.dir, h.right, hNext.left);

    if (turn.t >= 1) {
      this.spread = turn.target;
      this.turn = null;
      this.flipper.group.visible = false;
      this.rebuild();
      this.events.onSpreadChange(this.spread);
      const next = this.queued.shift();
      if (next) void this.startTurn(next);
    }
  }

  // ---------- input ----------

  private onPointerMove(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onPointerUp(e: PointerEvent) {
    const down = this.pointerDown;
    this.pointerDown = null;
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
    const halfW = SPINE_GAP + PAGE_W + 1.5;
    const halfH = PAGE_H / 2 + 1.5;
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
        // In front of and above the pointer, like a desk lamp: the foils
        // still follow the mouse, but the mirror glare goes away from a
        // camera looking down from above.
        this.lightTarget.set(p.x - 4, 12, p.z + 14);
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
    let card: THREE.Mesh | null = null;
    if (hit) {
      const view = [this.left, this.right].find((v) => v?.pageIndex === hit.page);
      card = view?.cards[hit.slot] ?? null;
    }
    const table = hit || this.blockInput || Math.abs(this.pointer.x) > 1 ? null : this.pickTable();
    this.hoveredTable = table?.kind === 'binder' ? table.obj : null;
    this.canvas.style.cursor = hit || table ? 'pointer' : '';
    for (const item of this.tableItems) {
      if (!item) continue;
      const target = BASE_Y + (item === this.hoveredTable ? 0.6 : 0);
      item.position.y += (target - item.position.y) * (1 - Math.exp(-dt * 12));
    }
    for (const view of [this.left, this.right]) {
      for (const c of view?.cards ?? []) {
        if (!c) continue;
        const target = c.userData.restZ + (c === card ? 0.035 : 0);
        c.position.z += (target - c.position.z) * (1 - Math.exp(-dt * 14));
        c.scale.setScalar(1 + (c.position.z - c.userData.restZ) * 0.6);
      }
    }
  }
}

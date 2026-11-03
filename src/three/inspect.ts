import * as THREE from 'three';
import { CARD_SIZE } from '../foils';
import type { Game, Slot } from '../types';
import { createCardMaterial, createSharedUniforms, setCardFoil, setCardFoilMap, setCardTexture } from './holoMaterial';
import type { BinderScene } from './binderScene';
import { cardBackTexture, queueFoilMap } from './textures';

/** Close-up view of one card, drawn on top of the binder. */
export class InspectView {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private shared = createSharedUniforms();
  private card = new THREE.Group();
  private front: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private back: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private dim: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private genericBack = cardBackTexture();
  private pointer = new THREE.Vector2();
  private flipped = false;
  private open = 0; // 0..1 animation
  private active = false;
  private spinY = 0;
  private drag: { x: number; y: number; spin: number } | null = null;
  private raycaster = new THREE.Raycaster();
  /** Called when the user closes the view by clicking outside the card. */
  onDismiss: () => void = () => {};
  private token = 0;
  /** Large textures loaded by this view; binder textures stay owned by the cache. */
  private owned: THREE.Texture[] = [];
  private game: Game = 'pokemon';

  constructor(private host: BinderScene) {
    this.camera.position.set(0, 0, 22);
    this.dim = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshBasicMaterial({ color: '#05060a', transparent: true, opacity: 0, depthWrite: false }),
    );
    this.dim.position.z = -30;
    this.scene.add(this.dim, this.card);

    const canvas = host.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (this.drag) this.spinY = this.drag.spin + ((e.clientX - this.drag.x) / r.width) * Math.PI * 2.5;
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (this.active) this.drag = { x: e.clientX, y: e.clientY, spin: this.spinY };
    });
    window.addEventListener('pointerup', (e) => {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5 && e.target === canvas) {
        this.raycaster.setFromCamera(this.pointer, this.camera);
        if (this.raycaster.intersectObject(this.card).length === 0) {
          this.onDismiss();
          return;
        }
      }
      // Settle on whichever face is closer.
      const half = Math.round(this.spinY / Math.PI);
      this.spinY = half * Math.PI;
      this.flipped = half % 2 !== 0;
    });

    host.addOverlay((dt) => this.frame(dt));
  }

  get isOpen() {
    return this.active;
  }

  show(slot: Slot) {
    this.clearCard();
    const token = ++this.token;
    const game = slot.card.game;
    const size = CARD_SIZE[game];
    const geo = new THREE.PlaneGeometry(size.w, size.h);

    this.front = new THREE.Mesh(geo, createCardMaterial(game, slot.foil, this.shared));
    this.back = new THREE.Mesh(geo, createCardMaterial(game, 'none', this.shared));
    this.back.rotation.y = Math.PI;
    this.card.add(this.front, this.back);

    this.game = game;
    const front = this.front.material;
    const cached = this.host.textures.peek(slot.card.image);
    if (cached) setCardTexture(front, cached);
    setCardFoilMap(front, this.host.textures.peekFoilMap(slot.card.image) ?? null);
    // Load the large image without touching the binder's texture cache.
    const loader = new THREE.TextureLoader();
    const load = (remote: string, mat: THREE.ShaderMaterial) =>
      loader
        .loadAsync(`/api/img?u=${encodeURIComponent(remote)}`)
        .then((tex) => {
          if (token !== this.token) {
            tex.dispose();
            return null;
          }
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.host.renderer.capabilities.getMaxAnisotropy();
          this.owned.push(tex);
          setCardTexture(mat, tex);
          return tex;
        })
        .catch((err) => {
          console.warn('inspect image failed', err);
          return null;
        });
    // A sharper foil map from the large image, so stamped lettering stays crisp up close.
    load(slot.card.large, front).then(async (tex) => {
      if (!tex) return;
      const map = await queueFoilMap(tex.image as HTMLImageElement, game, 1024);
      if (token !== this.token) return map.dispose();
      this.owned.push(map);
      setCardFoilMap(front, map);
    });
    setCardTexture(this.back.material, this.genericBack);
    if (slot.card.back) load(slot.card.back, this.back.material);

    this.flipped = false;
    this.spinY = 0;
    this.open = 0;
    this.active = true;
    this.host.blockInput = true;
  }

  setFoil(foil: Slot['foil']) {
    if (this.front) setCardFoil(this.front.material, this.game, foil);
  }

  flip() {
    this.flipped = !this.flipped;
    this.spinY = Math.round(this.spinY / Math.PI) * Math.PI + (this.flipped ? Math.PI : -Math.PI);
  }

  hide() {
    this.active = false;
    this.host.blockInput = false;
    this.drag = null;
  }

  private clearCard() {
    for (const m of [this.front, this.back]) {
      if (!m) continue;
      m.material.dispose();
      m.removeFromParent();
    }
    this.front?.geometry.dispose();
    this.front = this.back = null;
    for (const t of this.owned) t.dispose();
    this.owned = [];
  }

  private frame(dt: number) {
    const target = this.active ? 1 : 0;
    this.open += (target - this.open) * (1 - Math.exp(-dt * 9));
    if (this.open < 0.002 && !this.active) {
      if (this.front) this.clearCard();
      return;
    }

    const canvas = this.host.renderer.domElement;
    this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
    this.camera.updateProjectionMatrix();
    // Fit card height to ~80% of the view, minding narrow windows.
    const vFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitH = 8.8 / (2 * Math.tan(vFov) * 0.8);
    const fitW = 6.3 / (2 * Math.tan(vFov) * this.camera.aspect * 0.55);
    this.camera.position.z = Math.max(fitH, fitW);
    this.dim.position.z = this.camera.position.z - 40;

    const tiltX = this.drag ? 0 : -this.pointer.y * 0.35;
    const tiltY = this.drag ? 0 : this.pointer.x * 0.45;
    const k = 1 - Math.exp(-dt * 10);
    this.card.rotation.x += (tiltX - this.card.rotation.x) * k;
    this.card.rotation.y += (this.spinY + tiltY - this.card.rotation.y) * k;
    this.card.position.y = (1 - this.open) * -14;
    this.card.scale.setScalar(0.7 + 0.3 * this.open);
    this.dim.material.opacity = 0.78 * this.open;
    this.shared.uLight.value.set(this.pointer.x * 14, this.pointer.y * 12, 16);

    const r = this.host.renderer;
    r.clearDepth();
    r.render(this.scene, this.camera);
  }
}

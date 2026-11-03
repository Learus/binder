import * as THREE from 'three';
import { PAGE_H, PAGE_W } from './pageView';

const COLS = 64;
const LIGHT_DIR = new THREE.Vector3(0.3, 1, 0.4).normalize();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The sheet being turned. Both faces show snapshots (render targets) of the
 * pages, and the sheet bends as it rotates around the spine (the z axis).
 */
export class Flipper {
  readonly group = new THREE.Group();
  readonly frontRT: THREE.WebGLRenderTarget;
  readonly backRT: THREE.WebGLRenderTarget;
  private front: THREE.BufferGeometry;
  private back: THREE.BufferGeometry;
  private positions: Float32Array;
  private frontColors: Float32Array;
  private backColors: Float32Array;

  constructor(private spineGap: number) {
    const w = 1400;
    const h = Math.round((w * PAGE_H) / PAGE_W);
    const rtOpts = { type: THREE.HalfFloatType, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter };
    this.frontRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this.backRT = new THREE.WebGLRenderTarget(w, h, rtOpts);

    const n = (COLS + 1) * 2;
    this.positions = new Float32Array(n * 3);
    this.frontColors = new Float32Array(n * 3);
    this.backColors = new Float32Array(n * 3);
    const uvF = new Float32Array(n * 2);
    const uvB = new Float32Array(n * 2);
    const index: number[] = [];
    for (let i = 0; i <= COLS; i++) {
      const u = i / COLS;
      // row 0: near edge (+z, v = 0); row 1: far edge (-z, v = 1)
      for (let j = 0; j < 2; j++) {
        const k = j * (COLS + 1) + i;
        uvF.set([u, j], k * 2);
        uvB.set([1 - u, j], k * 2);
      }
      if (i < COLS) {
        const a = i;
        const b = i + 1;
        const c = COLS + 1 + i;
        const d = COLS + 2 + i;
        index.push(a, b, c, b, d, c);
      }
    }
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);

    this.front = new THREE.BufferGeometry();
    this.front.setAttribute('position', pos);
    this.front.setAttribute('uv', new THREE.BufferAttribute(uvF, 2));
    this.front.setAttribute('color', new THREE.BufferAttribute(this.frontColors, 3));
    this.front.setIndex(index);

    this.back = new THREE.BufferGeometry();
    this.back.setAttribute('position', pos);
    this.back.setAttribute('uv', new THREE.BufferAttribute(uvB, 2));
    this.back.setAttribute('color', new THREE.BufferAttribute(this.backColors, 3));
    this.back.setIndex(index);

    const mat = (rt: THREE.WebGLRenderTarget, side: THREE.Side) =>
      new THREE.MeshBasicMaterial({ map: rt.texture, side, vertexColors: true, toneMapped: false });
    const frontMesh = new THREE.Mesh(this.front, mat(this.frontRT, THREE.FrontSide));
    const backMesh = new THREE.Mesh(this.back, mat(this.backRT, THREE.BackSide));
    frontMesh.frustumCulled = backMesh.frustumCulled = false;
    this.group.add(frontMesh, backMesh);
    this.group.visible = false;
  }

  /**
   * progress 0 = lying on the right, 1 = lying on the left.
   * dir is +1 when turning forward, -1 backward, so the free edge trails.
   */
  update(progress: number, dir: 1 | -1, yRight: number, yLeft: number) {
    const theta = progress * Math.PI;
    const lift = Math.sin(progress * Math.PI);
    const curl = 0.85 * lift;
    const total = this.spineGap + PAGE_W;
    const angle = (s: number) => THREE.MathUtils.clamp(theta - dir * curl * (s / total) ** 2, 0, Math.PI);
    const baseY = THREE.MathUtils.lerp(yRight, yLeft, progress) + 0.04 + lift * 0.15;

    // Integrate along the sheet from the spine; the first part (spine gap)
    // is hidden, the visible page starts after it.
    let x = 0;
    let y = 0;
    const steps = 6;
    const gapStep = this.spineGap / steps;
    for (let k = 0; k < steps; k++) {
      const a = angle((k + 0.5) * gapStep);
      x += Math.cos(a) * gapStep;
      y += Math.sin(a) * gapStep;
    }
    const ds = PAGE_W / COLS;
    for (let i = 0; i <= COLS; i++) {
      if (i > 0) {
        const a = angle(this.spineGap + (i - 0.5) * ds);
        x += Math.cos(a) * ds;
        y += Math.sin(a) * ds;
      }
      for (let j = 0; j < 2; j++) {
        const k = j * (COLS + 1) + i;
        this.positions[k * 3] = x;
        this.positions[k * 3 + 1] = baseY + y;
        this.positions[k * 3 + 2] = j === 0 ? PAGE_H / 2 : -PAGE_H / 2;
      }
    }
    this.front.attributes.position.needsUpdate = true;
    this.front.computeVertexNormals();

    // Cheap shading so the curl reads in 3D; 1.0 when lying flat.
    const normals = this.front.attributes.normal.array as Float32Array;
    const flat = UP.dot(LIGHT_DIR);
    const n = new THREE.Vector3();
    for (let k = 0; k < normals.length / 3; k++) {
      n.fromArray(normals, k * 3);
      const f = THREE.MathUtils.clamp(0.55 + (0.45 * n.dot(LIGHT_DIR)) / flat, 0.25, 1.05);
      const b = THREE.MathUtils.clamp(0.55 + (0.45 * -n.dot(LIGHT_DIR)) / flat, 0.25, 1.05);
      this.frontColors.fill(f, k * 3, k * 3 + 3);
      this.backColors.fill(b, k * 3, k * 3 + 3);
    }
    this.front.attributes.color.needsUpdate = true;
    this.back.attributes.color.needsUpdate = true;
  }
}

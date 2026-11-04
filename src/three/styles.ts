import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BinderStyle } from '../types';

// Binder styles. Covers are built in board-local coordinates: a board is
// HALF wide (x), BOARD thick (y) and DEPTH deep (z), centred on its origin.

export const BINDER_STYLES: { key: BinderStyle; label: string }[] = [
  { key: 'ring', label: 'Ring binder' },
  { key: 'zip', label: 'Zippered' },
  { key: 'pro', label: 'Pro (strap)' },
];

/** Classic binders hang pages on rings; the others have pages sewn into the spine. */
export const hasRings = (style: BinderStyle) => style === 'ring';

interface CoverLook {
  roughness: number;
  bumpScale: number;
  /** Corner rounding of the boards. */
  radius: number;
}

const LOOKS: Record<BinderStyle, CoverLook> = {
  // Printed board with a paper label.
  ring: { roughness: 0.7, bumpScale: 0, radius: 0 },
  // Padded leatherette: soft rounded edges, coarse grain, matte.
  zip: { roughness: 0.82, bumpScale: 2.2, radius: 0.2 },
  // Stiff coloured leatherette with a satin sheen.
  pro: { roughness: 0.42, bumpScale: 0.9, radius: 0.1 },
};

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return c;
}

/** Pebbled leather grain, used as a bump map. */
function grainTexture(): THREE.CanvasTexture {
  return once('grain', () => {
    const size = 512;
    const c = canvas(size, size, (g) => {
      g.fillStyle = '#808080';
      g.fillRect(0, 0, size, size);
      // Seeded so every session gets the same grain.
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 9000; i++) {
        const x = rnd() * size;
        const y = rnd() * size;
        const r = 1.5 + rnd() * 3.5;
        const v = 110 + rnd() * 90;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath();
        g.ellipse(x, y, r, r * (0.7 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    });
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(5, 5);
    return tex;
  });
}

/** Give a cover material the surface of a style. */
export function styleCoverMaterial(mat: THREE.MeshStandardMaterial, style: BinderStyle) {
  const look = LOOKS[style];
  mat.roughness = look.roughness;
  const bump = look.bumpScale > 0 ? grainTexture() : null;
  if (mat.bumpMap !== bump) {
    mat.bumpMap = bump;
    mat.needsUpdate = true;
  }
  mat.bumpScale = look.bumpScale;
}

export function boardGeometry(style: BinderStyle, w: number, h: number, d: number): THREE.BufferGeometry {
  const r = LOOKS[style].radius;
  return once(`board-${style}-${w}-${h}-${d}`, () =>
    r > 0 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d),
  );
}

/** Stitched seam around the edge of a cover face, as a transparent overlay plane facing +y. */
export function stitchOverlay(w: number, d: number): THREE.Mesh {
  const mat = once(`stitch-${w}-${d}`, () => {
    const s = 24; // px per cm
    const c = canvas(Math.round(w * s), Math.round(d * s), (g) => {
      const inset = 0.45 * s;
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 3;
      g.setLineDash([9, 6]);
      g.beginPath();
      g.roundRect(inset + 1, inset + 1, g.canvas.width - 2 * inset, g.canvas.height - 2 * inset, 0.4 * s);
      g.stroke();
      g.strokeStyle = 'rgba(235,228,214,0.55)';
      g.beginPath();
      g.roundRect(inset, inset, g.canvas.width - 2 * inset, g.canvas.height - 2 * inset, 0.4 * s);
      g.stroke();
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.8 });
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ---------- zipper ----------

const tapeMat = () =>
  once('zip-tape', () => new THREE.MeshStandardMaterial({ color: '#1b1b1d', roughness: 0.95 }));

/** Metal zipper teeth along a strip `length` cm long (texture runs along x). */
function teethMat(length: number) {
  const key = `zip-teeth-${length.toFixed(1)}`;
  return once(key, () => {
    const base = once('zip-teeth-tex', () => {
      const c = canvas(32, 16, (g) => {
        g.fillStyle = '#4a4a4c';
        g.fillRect(0, 0, 32, 16);
        g.fillStyle = '#e4e4e6';
        g.fillRect(2, 0, 12, 10);
        g.fillRect(18, 6, 12, 10);
      });
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return tex;
    });
    const tex = base.clone();
    tex.needsUpdate = true;
    tex.repeat.set(length / 0.32, 1);
    return new THREE.MeshStandardMaterial({ map: tex, metalness: 0.9, roughness: 0.35 });
  });
}

/** A strip of tape with teeth down its middle, running along x, facing out of +z. */
function zipperStrip(length: number, tapeH: number, teethH: number): THREE.Group {
  const g = new THREE.Group();
  const tape = new THREE.Mesh(new THREE.BoxGeometry(length, tapeH, 0.1), tapeMat());
  const teeth = new THREE.Mesh(new THREE.BoxGeometry(length, teethH, 0.16), teethMat(length));
  teeth.position.z = 0.04;
  g.add(tape, teeth);
  return g;
}

/**
 * Half of a zipper running round the three outer edges of a board: the
 * fore-edge (x = fore * w/2) and both ends. Board-local coordinates.
 */
export function zipperRim(fore: 1 | -1, w: number, h: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const tapeH = h * 0.75;
  const foreStrip = zipperStrip(d, tapeH, 0.14);
  foreStrip.rotation.y = fore * Math.PI / 2;
  foreStrip.position.x = fore * (w / 2 + 0.02);
  g.add(foreStrip);
  for (const end of [1, -1]) {
    const s = zipperStrip(w - 0.4, tapeH, 0.14);
    if (end < 0) s.rotation.y = Math.PI;
    s.position.set(0.2 * fore, 0, end * (d / 2 + 0.02));
    g.add(s);
  }
  g.add(zipperPull(fore, w, d));
  return g;
}

/** The slider and pull tab, near the front corner of the fore-edge. */
function zipperPull(fore: 1 | -1, w: number, d: number): THREE.Group {
  const metal = once('zip-metal', () => new THREE.MeshStandardMaterial({ color: '#c8c8cc', metalness: 1, roughness: 0.3 }));
  const g = new THREE.Group();
  const slider = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.42, 0.9), metal);
  const tab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.55), metal);
  tab.position.set(fore * 0.85, -0.1, 0);
  const leather = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.7), tapeMat());
  leather.position.set(fore * 2.2, -0.12, 0);
  g.add(slider, tab, leather);
  g.position.set(fore * (w / 2 + 0.2), 0, d / 2 - 2.2);
  for (const m of g.children) m.castShadow = true;
  return g;
}

/**
 * The fabric gusset of a closed zippered binder: walls round the fore-edge
 * and both ends covering the pages, with the closed zipper along the middle.
 * `set` places it between heights y0 and y0 + h.
 */
export function zipGusset(
  cover: THREE.Material,
  x0: number,
  x1: number,
  d: number,
): { group: THREE.Group; set(y0: number, h: number): void } {
  const group = new THREE.Group();
  const w = x1 - x0;
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const fore = new THREE.Mesh(unit, cover);
  const ends = [1, -1].map(() => new THREE.Mesh(unit, cover));
  const foreZip = zipperStrip(d - 0.6, 0.32, 0.18);
  foreZip.rotation.y = Math.PI / 2;
  const endZips = [1, -1].map((end) => {
    const s = zipperStrip(w - 0.4, 0.32, 0.18);
    if (end < 0) s.rotation.y = Math.PI;
    return s;
  });
  group.add(fore, ...ends, foreZip, ...endZips);
  for (const m of [fore, ...ends]) m.castShadow = m.receiveShadow = true;
  const t = 0.3;
  return {
    group,
    set(y0, h) {
      const mid = y0 + h / 2;
      fore.scale.set(t, h, d);
      fore.position.set(x1 - t / 2, mid, 0);
      foreZip.position.set(x1 + 0.02, mid, 0);
      ends.forEach((m, i) => {
        const end = i === 0 ? 1 : -1;
        m.scale.set(w, h, t);
        m.position.set(x0 + w / 2, mid, end * (d / 2 - t / 2));
        endZips[i].position.set(x0 + w / 2 - 0.2, mid, end * (d / 2 + 0.02));
      });
    },
  };
}

// ---------- elastic strap ----------

function strapMat() {
  return once('strap', () => {
    const c = canvas(64, 64, (g) => {
      g.fillStyle = '#18181a';
      g.fillRect(0, 0, 64, 64);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 2;
      for (let x = 0; x < 64; x += 4) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, 64);
        g.stroke();
      }
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 12);
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  });
}

/**
 * Elastic strap looping round the binder from head to tail, parallel to the
 * spine at x. `set` wraps it round the height range y0 … y0 + h.
 */
export function elasticStrap(x: number, d: number): { group: THREE.Group; set(y0: number, h: number): void } {
  const group = new THREE.Group();
  const W = 2.2;
  const T = 0.09;
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const top = new THREE.Mesh(unit, strapMat());
  const bottom = new THREE.Mesh(unit, strapMat());
  const ends = [1, -1].map(() => new THREE.Mesh(unit, strapMat()));
  group.add(top, bottom, ...ends);
  for (const m of group.children) m.castShadow = true;
  return {
    group,
    set(y0, h) {
      top.scale.set(W, T, d + 2 * T);
      top.position.set(x, y0 + h + T / 2, 0);
      bottom.scale.set(W, T, d + 2 * T);
      bottom.position.set(x, y0 - T / 2, 0);
      ends.forEach((m, i) => {
        m.scale.set(W, h + 2 * T, T);
        m.position.set(x, y0 + h / 2, (i === 0 ? 1 : -1) * (d / 2 + T / 2));
      });
    },
  };
}

// ---------- name on the cover ----------

/**
 * The binder's name on the front cover, for the ringless styles: stitched
 * thread on a zippered binder, pressed into the cover of a pro binder.
 * Transparent, the same 13 × 5.3 proportions as the ring binder's label.
 */
export function coverNameTexture(name: string, cards: number, style: BinderStyle): THREE.CanvasTexture {
  const c = canvas(640, 260, (g) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 70;
    const font = (s: number) => `700 ${s}px "Trebuchet MS", "Segoe UI", sans-serif`;
    g.font = font(size);
    while (g.measureText(name).width > 520 && size > 26) g.font = font((size -= 4));
    const sub = `${cards} card${cards === 1 ? '' : 's'}`;
    if (style === 'zip') {
      // Embroidered patch: thread-coloured text inside a stitched outline.
      g.strokeStyle = 'rgba(236,228,212,0.7)';
      g.lineWidth = 4;
      g.setLineDash([12, 8]);
      g.beginPath();
      g.roundRect(30, 30, 580, 200, 26);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(240,233,218,0.92)';
      g.fillText(name, 320, 112);
      g.font = '600 26px "Trebuchet MS", sans-serif';
      g.fillStyle = 'rgba(240,233,218,0.6)';
      g.fillText(sub, 320, 182);
    } else {
      // Debossed: dark letters with a light lip under them.
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillText(name, 320, 117);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillText(name, 320, 114);
      g.font = '600 26px "Trebuchet MS", sans-serif';
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.fillText(sub, 320, 184);
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

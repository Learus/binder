import * as THREE from 'three';
import type { CardRef } from '../types';

// A graded-card slab in centimetres, built facing +z like the card meshes.
export const SLAB_W = 8.4;
export const SLAB_H = 13.5;
export const SLAB_T = 0.55;
/** Where the card sits inside the slab (centre), below the label. */
export const SLAB_CARD_Y = -1.35;
export const SLAB_CARD_Z = SLAB_T * 0.45;
const LABEL_W = 7.6;
const LABEL_H = 2.2;
const LABEL_Y = SLAB_H / 2 - 0.45 - LABEL_H / 2;

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Grading label: white with a red border, card details on the left and the
 * grade on the right. A stable fake certificate number comes from the card id.
 */
export function gradeLabelTexture(card: CardRef): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 760;
  c.height = 220;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, 760, 220);
  g.strokeStyle = '#b3121c';
  g.lineWidth = 14;
  g.strokeRect(7, 7, 746, 206);

  const fit = (text: string, weight: string, size: number, maxW: number) => {
    let s = size;
    g.font = `${weight} ${s}px Arial, Helvetica, sans-serif`;
    while (g.measureText(text).width > maxW && s > 14) {
      s -= 2;
      g.font = `${weight} ${s}px Arial, Helvetica, sans-serif`;
    }
  };
  g.fillStyle = '#111';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  fit(card.set.toUpperCase(), '600', 30, 470);
  g.fillText(card.set.toUpperCase(), 34, 62);
  fit(card.name.toUpperCase(), '800', 42, 470);
  g.fillText(card.name.toUpperCase(), 34, 116);
  g.font = '600 28px Arial, Helvetica, sans-serif';
  if (card.number) g.fillText(`#${card.number}`, 34, 160);
  g.font = '500 22px Arial, Helvetica, sans-serif';
  g.fillStyle = '#555';
  const cert = String(hashString(card.game + card.id) % 100000000).padStart(8, '0');
  g.fillText(`CERT ${cert}`, 34, 196);

  // barcode
  g.fillStyle = '#111';
  let x = 300;
  const bits = hashString(cert);
  for (let i = 0; i < 40 && x < 500; i++) {
    const w = (bits >> i % 30) & 1 ? 4 : 2;
    g.fillRect(x, 172, w, 30);
    x += w + 3;
  }

  g.textAlign = 'right';
  g.fillStyle = '#111';
  g.font = '800 34px Arial, Helvetica, sans-serif';
  g.fillText('GEM MT', 722, 70);
  g.font = '900 104px Arial, Helvetica, sans-serif';
  g.fillText('10', 722, 172);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Raised inner ridges around the label and card windows, drawn as faint lines. */
function ridgeTexture(): THREE.CanvasTexture {
  const s = 40; // px per cm
  const c = document.createElement('canvas');
  c.width = SLAB_W * s;
  c.height = SLAB_H * s;
  const g = c.getContext('2d')!;
  const rect = (cx: number, cy: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect((cx - w / 2 + SLAB_W / 2) * s, (SLAB_H / 2 - cy - h / 2) * s, w * s, h * s, r * s);
    g.stroke();
  };
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = 3;
  rect(0, LABEL_Y, LABEL_W + 0.35, LABEL_H + 0.35, 0.15);
  rect(0, SLAB_CARD_Y, 7.0, 9.6, 0.25);
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 2;
  rect(0, 0, SLAB_W - 0.5, SLAB_H - 0.5, 0.35);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Materials shared by every slab. */
export class SlabKit {
  readonly rim = new THREE.MeshStandardMaterial({
    color: '#dfe9f2',
    roughness: 0.12,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  readonly ridges = new THREE.MeshBasicMaterial({ map: ridgeTexture(), transparent: true, depthWrite: false });
  readonly insert = new THREE.MeshStandardMaterial({
    color: '#d8dee4',
    roughness: 0.3,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  });
  readonly faceGeo = new THREE.PlaneGeometry(SLAB_W, SLAB_H);
  readonly labelGeo = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
  readonly wallT = 0.32;
  readonly hWall = new THREE.BoxGeometry(SLAB_W, this.wallT, SLAB_T);
  readonly vWall = new THREE.BoxGeometry(this.wallT, SLAB_H - 2 * this.wallT, SLAB_T);
  private labels = new Map<string, THREE.MeshStandardMaterial>();

  labelMaterial(card: CardRef) {
    const key = `${card.game}:${card.id}`;
    let m = this.labels.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ map: gradeLabelTexture(card), roughness: 0.6 });
      this.labels.set(key, m);
    }
    return m;
  }
}

/**
 * A slab around `card`, facing +z with its back at z = 0. `top` is the glossy
 * front face (also the click target); pass the sleeve material for it.
 */
export function buildSlab(kit: SlabKit, card: CardRef, top: THREE.Material): { group: THREE.Group; top: THREE.Mesh } {
  const group = new THREE.Group();

  const insert = new THREE.Mesh(kit.faceGeo, kit.insert);
  insert.position.z = 0.01;
  const label = new THREE.Mesh(kit.labelGeo, kit.labelMaterial(card));
  label.position.set(0, LABEL_Y, SLAB_T * 0.5);

  // Rim: four clear acrylic walls.
  const t = kit.wallT;
  const walls = (
    [
      [kit.hWall, 0, SLAB_H / 2 - t / 2],
      [kit.hWall, 0, -SLAB_H / 2 + t / 2],
      [kit.vWall, SLAB_W / 2 - t / 2, 0],
      [kit.vWall, -SLAB_W / 2 + t / 2, 0],
    ] as const
  ).map(([geo, x, y]) => {
    const m = new THREE.Mesh(geo, kit.rim);
    m.position.set(x, y, SLAB_T / 2);
    return m;
  });

  const ridges = new THREE.Mesh(kit.faceGeo, kit.ridges);
  ridges.position.z = SLAB_T - 0.005;
  const face = new THREE.Mesh(kit.faceGeo, top);
  face.position.z = SLAB_T;

  group.add(insert, label, ...walls, ridges, face);
  return { group, top: face };
}

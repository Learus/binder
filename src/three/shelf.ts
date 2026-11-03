import * as THREE from 'three';
import { PAGE_H, PAGE_W } from './pageView';

export const SPINE_GAP = 0.9;
export const SHEET_THICKNESS = 0.035;
/** Thickness of a cover board. */
export const BOARD = 0.45;
/** Width of one cover board (spine to outer edge). */
export const HALF = SPINE_GAP + PAGE_W + 0.7;
/** Depth of a cover board. */
export const DEPTH = PAGE_H + 1.4;
/** Height of the table top; binders rest on it. */
export const BASE_Y = -0.45;

/** Where closed binders rest around the open one, as [x, z] footprint centres. */
export const TABLE_SLOTS: [number, number][] = [
  [-38, -17],
  [-38, 17],
  [38, -17],
  [38, 17],
  [-13, -34],
  [13, -34],
];

export interface TableEntry {
  id: string;
  name: string;
  cover: string;
  sheets: number;
  cards: number;
}

/** Height of the page block of a closed binder with this many sheets. */
export function pageBlockHeight(sheets: number) {
  return Math.max(0.3, sheets * SHEET_THICKNESS * 2 + 0.24);
}

/** A name plate texture for the front cover. */
export function labelTexture(name: string, cards: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 260;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe6d2';
  g.fillRect(0, 0, 640, 260);
  g.strokeStyle = 'rgba(80,60,30,0.55)';
  g.lineWidth = 8;
  g.strokeRect(14, 14, 612, 232);
  g.lineWidth = 2;
  g.strokeRect(30, 30, 580, 200);
  g.fillStyle = '#2a2016';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 72;
  g.font = `600 ${size}px Georgia, serif`;
  while (g.measureText(name).width > 540 && size > 28) {
    size -= 4;
    g.font = `600 ${size}px Georgia, serif`;
  }
  g.fillText(name, 320, 115);
  g.font = '28px Georgia, serif';
  g.fillStyle = 'rgba(42,32,22,0.7)';
  g.fillText(`${cards} card${cards === 1 ? '' : 's'}`, 320, 190);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The name plate: a small card glued to the cover. Built facing +y with its
 * top edge towards -z (away from a viewer at the front of the table).
 */
export function namePlate(name: string, cards: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(13, 5.3),
    new THREE.MeshStandardMaterial({ map: labelTexture(name, cards), roughness: 0.8 }),
  );
  plate.rotation.x = -Math.PI / 2;
  return plate;
}

/** A closed binder lying on the table: origin at the footprint centre, bottom at y = 0. */
export function closedBinder(entry: TableEntry, pageMat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const cover = new THREE.MeshStandardMaterial({ color: entry.cover, roughness: 0.7 });
  const pagesH = pageBlockHeight(entry.sheets);

  const board = new THREE.BoxGeometry(HALF, BOARD, DEPTH);
  const bottom = new THREE.Mesh(board, cover);
  bottom.position.y = BOARD / 2;
  const top = new THREE.Mesh(board, cover);
  top.position.y = BOARD + pagesH + BOARD / 2;
  const pages = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W, pagesH, PAGE_H), pageMat);
  pages.position.set(HALF / 2 - PAGE_W / 2 - 0.5, BOARD + pagesH / 2, 0);
  const spineH = pagesH + 2 * BOARD;
  const spine = new THREE.Mesh(new THREE.BoxGeometry(BOARD, spineH, DEPTH), cover);
  spine.position.set(-HALF / 2 - BOARD / 2, spineH / 2, 0);

  const plate = namePlate(entry.name, entry.cards);
  plate.position.set(0, spineH + 0.005, -DEPTH * 0.18);

  for (const m of [bottom, top, pages, spine]) m.castShadow = m.receiveShadow = true;
  group.add(bottom, top, pages, spine, plate);
  group.userData.entryId = entry.id;
  return group;
}

/** Faint mat marking an empty slot on the table. */
export function slotMarker(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 336;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(255,235,200,0.35)';
  g.lineWidth = 5;
  g.setLineDash([18, 12]);
  g.beginPath();
  g.roundRect(8, 8, 240, 320, 18);
  g.stroke();
  g.fillStyle = 'rgba(255,235,200,0.35)';
  g.font = '600 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('+', 128, 168);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF, DEPTH),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

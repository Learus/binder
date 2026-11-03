import * as THREE from 'three';
import { imgUrl } from '../api';
import type { Game } from '../types';
import { makeFoilMap } from './foilMap';

// Foil maps take a few ms of CPU each; build them one per tick so a page of
// new cards doesn't stall a frame.
let mapQueue: Promise<unknown> = Promise.resolve();
export function queueFoilMap(image: HTMLImageElement, game: Game, maxWidth?: number): Promise<THREE.DataTexture> {
  const job = mapQueue.then(
    () => new Promise<THREE.DataTexture>((resolve) => setTimeout(() => resolve(makeFoilMap(image, game, maxWidth)), 0)),
  );
  mapQueue = job.catch(() => {});
  return job;
}

/** Loads card images through the local cache and keeps GPU memory bounded. */
export class TextureCache {
  private loader = new THREE.TextureLoader();
  private entries = new Map<string, Promise<THREE.Texture>>();
  private loaded = new Map<string, THREE.Texture>();
  private maps = new Map<string, Promise<THREE.DataTexture>>();
  private mapsLoaded = new Map<string, THREE.DataTexture>();

  constructor(private anisotropy: number) {}

  get(remote: string): Promise<THREE.Texture> {
    let p = this.entries.get(remote);
    if (!p) {
      p = this.loader.loadAsync(imgUrl(remote)).then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.anisotropy;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        this.loaded.set(remote, tex);
        return tex;
      });
      p.catch(() => this.entries.delete(remote));
      this.entries.set(remote, p);
    }
    return p;
  }

  /** Synchronous lookup for textures that already finished loading. */
  peek(remote: string): THREE.Texture | undefined {
    return this.loaded.get(remote);
  }

  /** Foil data (name mask, height, detail) for a card image; see foilMap.ts. */
  getFoilMap(remote: string, game: Game): Promise<THREE.DataTexture> {
    let p = this.maps.get(remote);
    if (!p) {
      p = this.get(remote)
        .then((tex) => queueFoilMap(tex.image as HTMLImageElement, game))
        .then((map) => {
          this.mapsLoaded.set(remote, map);
          return map;
        });
      p.catch(() => this.maps.delete(remote));
      this.maps.set(remote, p);
    }
    return p;
  }

  peekFoilMap(remote: string): THREE.DataTexture | undefined {
    return this.mapsLoaded.get(remote);
  }

  /** Dispose every loaded texture whose url is not in `keep`. */
  retain(keep: Set<string>) {
    for (const [url, tex] of this.loaded) {
      if (keep.has(url)) continue;
      tex.dispose();
      this.loaded.delete(url);
      this.entries.delete(url);
    }
    for (const [url, map] of this.mapsLoaded) {
      if (keep.has(url)) continue;
      map.dispose();
      this.mapsLoaded.delete(url);
      this.maps.delete(url);
    }
  }
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Dark page backing with a lighter pocket outline per slot. */
export function pageBackingTexture(pageW: number, pageH: number, slots: { x: number; y: number; w: number; h: number }[]) {
  const s = 48; // px per cm
  return canvasTexture(Math.round(pageW * s), Math.round(pageH * s), (g) => {
    g.fillStyle = '#17181c';
    g.fillRect(0, 0, pageW * s, pageH * s);
    for (const r of slots) {
      const x = (r.x - r.w / 2 + pageW / 2) * s;
      const y = (pageH / 2 - (r.y + r.h / 2)) * s;
      g.fillStyle = '#1f2026';
      g.fillRect(x, y, r.w * s, r.h * s);
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, r.w * s - 2, r.h * s - 2);
      // stitched seam along the pocket opening
      g.setLineDash([6, 6]);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.beginPath();
      g.moveTo(x + 8, y + 10);
      g.lineTo(x + r.w * s - 8, y + 10);
      g.stroke();
      g.setLineDash([]);
    }
  });
}

/** Inside of the cover, shown where a binder has no page (first and last spread). */
export function coverLiningTexture(color: string) {
  return canvasTexture(512, 700, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 512, 700);
    const grad = g.createRadialGradient(256, 300, 40, 256, 350, 520);
    grad.addColorStop(0, 'rgba(255,255,255,0.08)');
    grad.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 700);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 3;
    g.strokeRect(24, 24, 464, 652);
  });
}

/** Generic card back for cards without a real back image. */
export function cardBackTexture() {
  return canvasTexture(630, 880, (g) => {
    const grad = g.createLinearGradient(0, 0, 630, 880);
    grad.addColorStop(0, '#1c2340');
    grad.addColorStop(1, '#3b1f4a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 630, 880);
    g.strokeStyle = 'rgba(255,215,140,0.75)';
    g.lineWidth = 10;
    g.strokeRect(30, 30, 570, 820);
    g.lineWidth = 4;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.ellipse(315, 440, 60 + i * 34, 90 + i * 46, 0, 0, Math.PI * 2);
      g.strokeStyle = `rgba(255,215,140,${0.55 - i * 0.07})`;
      g.stroke();
    }
    g.fillStyle = 'rgba(255,225,170,0.9)';
    g.font = 'bold 54px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('BINDER', 315, 458);
  });
}

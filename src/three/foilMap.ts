import * as THREE from 'three';
import { ART_BOX, NAME_BOX, YGO_FRAME } from '../foils';
import type { Game } from '../types';

/**
 * Per-card data the foil shader needs but can't cheaply work out per pixel:
 *   R: title lettering, plus the level stars on Yu-Gi-Oh! cards
 *   G: height map, a blurred luminance used for embossing
 *   B: fine detail (luminance minus its blur), for etched/textured finishes
 *   A: how much each art pixel looks like background rather than subject
 * Rows are written bottom-up so the texture matches three's uv convention.
 */
export function makeFoilMap(image: HTMLImageElement | ImageBitmap, game: Game, maxWidth = 512): THREE.DataTexture {
  const w = Math.min(maxWidth, image.width);
  const h = Math.round((w * image.height) / image.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(image, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  }
  const r = Math.max(1, Math.round(w / 256));
  const height = blur(blur(lum, w, h, r), w, h, r);
  const wide = blur(blur(lum, w, h, r * 4), w, h, r * 4);
  const detail = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) detail[i] = Math.min(1, Math.abs(lum[i] - wide[i]) * 3);

  let stamp: Float32Array | null = null;
  if (game === 'ygo') {
    stamp = boxMask(px, w, h, NAME_BOX[game], 0.16, true);
    // A row of 12 stars has no free background, so compare against the
    // frame beside the art instead.
    const side: [number, number, number, number] = [YGO_FRAME.inner[0] + 0.01, 0.25, 0.08, 0.65];
    const stars = boxMask(px, w, h, YGO_FRAME.stars, 0.12, false, side);
    for (let i = 0; i < w * h; i++) stamp[i] = Math.max(stamp[i], stars[i]);
  }
  const bg = backgroundMask(px, detail, w, h, ART_BOX[game]);

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = (dst + x) * 4;
      out[o] = stamp ? stamp[i] * 255 : 0;
      out[o + 1] = height[i] * 255;
      out[o + 2] = detail[i] * 255;
      out[o + 3] = bg[i] * 255;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Marks whatever differs clearly from the box's background colour (the
 * per-channel median, since letters or stars cover less than half the box).
 * With `dropLines`, rows or columns that are mostly "different" are frame
 * edges rather than lettering and get cleared.
 */
function boxMask(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  box: [number, number, number, number],
  threshold: number,
  dropLines: boolean,
  bgBox = box,
) {
  const x0 = Math.round(box[0] * w);
  const x1 = Math.round(box[2] * w);
  const y0 = Math.round(box[1] * h);
  const y1 = Math.round(box[3] * h);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  const [bx0, by0, bx1, by1] = [bgBox[0] * w, bgBox[1] * h, bgBox[2] * w, bgBox[3] * h].map(Math.round);
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const o = (y * w + x) * 4;
      hist[0][px[o]]++;
      hist[1][px[o + 1]]++;
      hist[2][px[o + 2]]++;
      n++;
    }
  }
  const median = hist.map((hc) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hc[v]) >= n / 2) return v;
    return 0;
  });

  const mask = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 4;
      const d = Math.max(Math.abs(px[o] - median[0]), Math.abs(px[o + 1] - median[1]), Math.abs(px[o + 2] - median[2])) / 255;
      mask[y * w + x] = smoothstep(threshold, threshold + 0.18, d);
    }
  }
  if (dropLines) {
    for (let y = y0; y < y1; y++) {
      let sum = 0;
      for (let x = x0; x < x1; x++) sum += mask[y * w + x];
      if (sum > 0.55 * (x1 - x0)) for (let x = x0; x < x1; x++) mask[y * w + x] = 0;
    }
    // Columns: clear vertical frame edges, and anything after a wide gap,
    // which is a speck near the attribute icon rather than the title.
    const gapLimit = Math.round((x1 - x0) * 0.06);
    let lastInk = -1;
    for (let x = x0; x < x1; x++) {
      let sum = 0;
      for (let y = y0; y < y1; y++) sum += mask[y * w + x];
      const tooFar = lastInk >= 0 && x - lastInk > gapLimit;
      if (sum > 0.8 * (y1 - y0) || tooFar) {
        for (let y = y0; y < y1; y++) mask[y * w + x] = 0;
      } else if (sum > 1) {
        lastInk = x;
      }
    }
  }
  return blur(mask, w, h, 1);
}

/**
 * Rough subject/background split for the art: the background is usually the
 * colours that touch the art's edges, and it has less fine detail than the
 * subject. 1 = background, 0 = subject; 1 everywhere outside the art.
 */
function backgroundMask(
  px: Uint8ClampedArray,
  detail: Float32Array,
  w: number,
  h: number,
  box: [number, number, number, number],
) {
  const x0 = Math.round(box[0] * w);
  const x1 = Math.round(box[2] * w);
  const y0 = Math.round(box[1] * h);
  const y1 = Math.round(box[3] * h);
  const band = Math.max(3, Math.round((x1 - x0) * 0.04));
  const bin = (o: number) => ((px[o] >> 5) << 6) | ((px[o + 1] >> 5) << 3) | (px[o + 2] >> 5);

  const hist = new Uint32Array(512);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x - x0 >= band && x1 - x > band && y - y0 >= band && y1 - y > band) continue;
      hist[bin((y * w + x) * 4)]++;
      n++;
    }
  }
  const isBg = new Uint8Array(512);
  for (let b = 0; b < 512; b++) isBg[b] = hist[b] > n * 0.004 ? 1 : 0;

  const busy = blur(blur(detail, w, h, 4), w, h, 4);
  const mask = new Float32Array(w * h).fill(1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      mask[i] = isBg[bin(i * 4)] * (1 - smoothstep(0.2, 0.45, busy[i]));
    }
  }
  return blur(blur(mask, w, h, 3), w, h, 3);
}

/** Separable box blur. */
function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc * norm;
      acc += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

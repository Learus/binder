import * as THREE from 'three';
import { ART_BOX, CARD_SIZE, hasOldFrame, NAME_BOX, printAge, rarityOf, YGO_FRAME } from '../foils';
import { conditionOf, wearSeed } from '../condition';
import stickerUrl from '../assets/ygo-sticker.png';
import type { PrintLook } from '../types';
import type { FoilKey, Game } from '../types';

/**
 * Uniforms shared by every card so one update per frame moves the light and
 * advances time everywhere.
 */
export interface SharedUniforms {
  uLight: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
  /** Foil strength multiplier for the whole scene (the binder view boosts it). */
  uFoilBoost: THREE.IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uLight: { value: new THREE.Vector3(0, 30, 10) },
    uTime: { value: 0 },
    uFoilBoost: { value: 1 },
  };
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  mat3 m = mat3(modelMatrix);
  vNormal = normalize(m * vec3(0.0, 0.0, 1.0));
  vTangent = normalize(m * vec3(1.0, 0.0, 0.0));
  vBitangent = normalize(m * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/*
 * Model: a printed card on top of a foil sheet. Light goes through the ink,
 * bounces off the foil and goes back through the ink, so the printed colours
 * filter the foil and dark ink hides it. The foil's micro-structure (ridges,
 * flakes, embossing) tilts the surface normal, and a diffraction term turns
 * the angle between light, eye and grating into a hue.
 */
const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform float uHasMap;
uniform sampler2D uFoilMap;   // r: lettering + level stars, g: height, b: fine detail, a: art background
uniform float uHasFoilMap;
uniform vec2 uFoilTexel;
uniform vec4 uArt;            // art box in uv space: x0, y0, x1, y1 (origin bottom-left)
uniform vec3 uLight;
uniform float uAspect;        // width / height
uniform float uRadius;        // corner radius as fraction of height

uniform int uRegion;
uniform int uPattern;
uniform int uTint;
uniform int uName;
uniform vec3 uMetal;
uniform float uRainbow;
uniform float uEmboss;
uniform float uGlow;
uniform float uOutside;      // foil strength outside the art
uniform float uStrength;
uniform float uRough;         // 0 = polished foil, 1 = rough brushed metal
uniform float uFoilBoost;
uniform int uTrim;
uniform float uDim;
uniform float uAge;           // older prints: greyer and deeper relief (ultimate), darker liquid gold (gold rare)
uniform float uEmbossStars;
uniform float uShinyIcons;
uniform float uDepth;
uniform float uBgOnly;
uniform float uOldFrame;      // Yu-Gi-Oh! early frame: smaller art box

// Condition, each 0 (mint) to 1.
uniform float uCrease;
uniform float uEdgeWear;
uniform float uScratch;
uniform float uFade;
uniform float uSeed;          // 0..1 per card, so each copy wears in its own places
uniform float uMirror;        // 1 on a card's back, so its wear lines up with the front

// Yu-Gi-Oh! authenticity hologram in the bottom-right corner.
uniform sampler2D uStickerTex; // grey pattern: bright = raised
uniform float uSticker;
uniform vec4 uStickerBox;

// Frame parts (Yu-Gi-Oh!), same convention as uArt.
uniform vec4 uInner;          // inside edge of the outer border
uniform vec4 uArtFrame;       // outside edge of the art frame
uniform vec4 uNameBox;
uniform vec4 uStarsBox;
uniform vec4 uAttrBox;        // attribute icon's bounding box

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

const float TAU = 6.2831853;

// Saturated, smooth spectrum.
vec3 spectrum(float t) {
  vec3 c = 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)));
  return c * c * 1.35;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
  return vec2(hash(p), hash(p + 19.19));
}

// Hash of an integer lattice point. Integer maths, because the float hash
// above is so sensitive to rounding that some GPUs give a different value
// for the same point depending on how it was computed, which shows up as
// hard seams in the noise.
float latticeHash(ivec2 i) {
  uvec2 q = uvec2(i + 65536);
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= h >> 13;
  return float(h) * (1.0 / 4294967295.0);
}

float noise(vec2 p) {
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(latticeHash(i), latticeHash(i + ivec2(1, 0)), u.x),
             mix(latticeHash(i + ivec2(0, 1)), latticeHash(i + ivec2(1, 1)), u.x), u.y);
}

// Signed distance to the card's rounded outline, in card heights (< 0 inside).
float cardDist(vec2 q, vec2 half_) {
  vec2 e = abs(q) - half_ + uRadius;
  return length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - uRadius;
}

// How worn the edge is here: patchy along the sides, worst at the corners.
float edgeAmount(vec2 q, vec2 half_, float s) {
  float corner = clamp(1.0 - length(half_ - abs(q)) / 0.14, 0.0, 1.0);
  float patchy = noise(q * 18.0 + s * 97.0);
  return uEdgeWear * (0.15 + 0.85 * patchy * patchy + 1.3 * corner * corner);
}

// Folds: up to four, a corner bend first. p is in card space (x scaled by
// the aspect). Returns the surface tilt; white is the cracked ink along the
// fold lines.
vec2 creases(vec2 p, float s, float px, out float white) {
  vec2 tilt = vec2(0.0);
  white = 0.0;
  for (int i = 0; i < 4; i++) {
    float k = clamp(uCrease * 4.0 - float(i), 0.0, 1.0);
    if (k <= 0.0) break;
    float fi = float(i);
    vec3 h = vec3(hash(vec2(s * 91.0, fi + 1.3)), hash(vec2(fi + 4.1, s * 37.0)), hash(vec2(s * 13.0 + fi, 8.7)));
    vec2 n;
    float d;
    if (i == 0 || i == 2) {
      // A short fold across one corner.
      float c = floor(h.x * 4.0);
      float right = mod(c, 2.0);
      float top = floor(c / 2.0);
      vec2 corner = vec2(right * uAspect, top);
      float a = atan(1.0 - 2.0 * top, 1.0 - 2.0 * right) + (h.y - 0.5) * 0.7;
      n = vec2(cos(a), sin(a));
      d = dot(p - corner, n) - (0.05 + 0.1 * h.z);
    } else {
      // A fold right across the card.
      float a = h.z * 3.14159;
      n = vec2(cos(a), sin(a));
      d = dot(p - vec2(uAspect * (0.2 + 0.6 * h.x), 0.2 + 0.6 * h.y), n);
    }
    float t = dot(p, vec2(-n.y, n.x));
    d += (noise(vec2(t * 25.0, fi * 17.0 + s * 50.0)) - 0.5) * 0.008;
    float amp = k * (0.5 + 0.5 * uCrease);
    float w = 0.005;
    float g = exp(-d * d / (w * w));
    tilt += n * (d / w) * g * 0.9 * amp;                         // the ridge
    tilt += n * clamp(d / 0.04, -1.0, 1.0) * 0.035 * amp;       // the halves sit at different angles
    float lw = max(0.0012, px * 0.8);
    float crack = exp(-d * d / (lw * lw)) * (0.0012 / lw);
    white = max(white, crack * (0.35 + 0.65 * noise(vec2(t * 180.0, fi * 5.0 + s * 20.0))) * amp);
  }
  return tilt;
}

// Scuffs: short straight scratches scattered over a grid, in two sizes, most
// of them running roughly one way (from shuffling).
float scratches(vec2 p, float s, float px) {
  float m = 0.0;
  float heading = hash(vec2(s * 17.0, 2.9)) * 3.14159;
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 9.0 : 26.0;
    float density = uScratch * (layer == 0 ? 0.3 : 0.35);
    vec2 g = p * scale + s * 40.0 + float(layer) * 7.3;
    vec2 id = floor(g);
    float wd = max(0.0016, px) * scale;       // line width, in cells
    float fade = 0.0016 * scale / wd;
    for (int j = 0; j < 9; j++) {
      vec2 c = id + vec2(float(j % 3) - 1.0, float(j / 3) - 1.0);
      if (hash(c + 3.7) > density) continue;
      vec2 a = c + hash2(c);
      float r = hash(c + 9.1);
      float ang = r < 0.6 ? heading + (r - 0.3) * 0.8 : r * 3.14159 * 1.6;
      vec2 dir = vec2(cos(ang), sin(ang));
      float half_ = 0.15 + 0.55 * hash(c + 5.5);
      vec2 rel = g - a;
      float t = clamp(dot(rel, dir), -half_, half_);
      float dd = length(rel - dir * t);
      float taper = 1.0 - pow(abs(t) / half_, 4.0);
      m = max(m, smoothstep(wd, 0.0, dd) * taper * fade * (0.4 + 0.6 * hash(c + 1.1)));
    }
  }
  return m;
}

// How strongly a tiny mirror tilted by \`tilt\` reflects the light into the eye.
float flake(vec3 N, vec3 T, vec3 B, vec2 tilt, vec3 V, vec3 L, float sharp) {
  vec3 n = normalize(N + T * tilt.x + B * tilt.y);
  return pow(max(dot(reflect(-V, n), L), 0.0), sharp);
}

float inRect(vec4 r, vec2 p) {
  return step(r.x, p.x) * step(p.x, r.z) * step(r.y, p.y) * step(p.y, r.w);
}

// Bright metal surface: dim room, soft halo, hot spot. Rough metal spreads
// the highlight wide and dims it instead of showing a sharp hot spot.
float metalBright(vec3 N, vec3 V, vec3 L, float rough) {
  float r = max(dot(reflect(-V, N), L), 0.0);
  return 0.4 + 0.5 * pow(r, 3.0) + mix(0.8, 0.55, rough) * pow(r, mix(18.0, 6.0, rough))
       + mix(1.5, 0.25, rough) * pow(r, mix(140.0, 20.0, rough));
}

// Gold leaf by print age: newer gold is pale and bright, older gold is deeper
// and darker.
vec3 goldTone(float age) {
  return mix(vec3(1.0, 0.74, 0.34), vec3(0.8, 0.5, 0.15), age);
}

// Polished "liquid" gold on older prints: dark away from the light, a broad
// bright pool with a hot core, and soft bands of reflected room that slide
// across the surface as the card tilts.
float liquidBright(vec3 N, vec3 V, vec3 L) {
  vec3 R = reflect(-V, N);
  float r = max(dot(R, L), 0.0);
  float bands = pow(0.5 + 0.5 * sin(R.x * 7.0 + R.y * 4.0 + sin(R.y * 5.0) * 1.5), 4.0);
  return 0.1 + 0.35 * bands + 0.8 * pow(r, 8.0) + 1.8 * pow(r, 90.0);
}

// Early Yu-Gi-Oh! frame: a smaller art window. The bevelled art frame and the
// art inside it scale down together (nothing is cropped or squashed), about a
// point a little above the frame's centre so the gap above it stays small.
// The gap between the old frame and the scaled one gets the card background
// beside the old frame: mirrored across its side edges, and above and below
// from the thin strips under the level stars and over the text box, mirrored
// at its edge and stretched a little. The corners blend the two.
// The art frame casts a soft shadow that fades over about 0.012 of the card,
// so every pixel read from near the old frame has that shadow taken out and
// the scaled frame's shadow put in, at its own distance from each frame.
// Without that, the gaps would carry stretched shadow and the old frame's
// shadow would be left behind as a dark line around the new one.
// Measured on modern cards in top-down coordinates: the art frame including
// the darkest of its shadow, how much background lies above and below it,
// and the frame's outline, from which the shadow fades.
const vec4 OLD_FRAME = vec4(0.097, 0.168, 0.903, 0.723);
const vec4 OLD_OUTLINE = vec4(0.1033, 0.1722, 0.8979, 0.7139);
const float OLD_TOP_BAND = 0.0045;
const float OLD_BOTTOM_BAND = 0.009;
const float OLD_SCALE = 0.96;
const float OLD_ANCHOR = 0.35; // scale centre, from the frame's top down

// How much light the art frame's shadow leaves at p (top-down), from the
// frame outline r. It fades as exp(-(distance / reach)^1.7). The light comes
// from the upper left, so it is darkest below and right of the frame and
// lightest above it (fitted to scanned cards); past a corner the strength
// and reach blend between the two edges.
float frameShadow(vec2 p, vec4 r) {
  vec2 d = max(max(r.xy - p, p - r.zw), 0.0);
  d.x *= uAspect;
  float len = length(d);
  float wy = len > 0.0 ? d.y * d.y / (len * len) : 0.0;
  vec2 tb = p.y < r.y ? vec2(0.394, 0.0055) : vec2(0.571, 0.0051); // strength, reach
  vec2 lr = p.x < r.x ? vec2(0.52, 0.0062) : vec2(0.6, 0.007);
  vec2 k = mix(lr, tb, wy);
  return 1.0 - k.x * exp(-pow(len / k.y, 1.7));
}

// Returns where to read the card (colour, foil map and frame masks), and
// light, what to multiply the colour by; in the corners src2, light2 and w2
// give a second colour to blend in. outside is 1 outside the scaled frame,
// where the art frame's own effects (such as the ultimate's embossed trim)
// no longer belong, though the art frame's box from the masks reaches there.
vec2 oldFrameUv(vec2 uv, out float light, out vec2 src2, out float light2, out float w2, out float outside) {
  src2 = uv;
  light = 1.0;
  light2 = 1.0;
  w2 = 0.0;
  outside = 0.0;
  vec4 o = OLD_FRAME;
  float inner = uInner.x;
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  if (p.x < inner || p.x > 1.0 - inner) return uv;
  vec2 c = vec2(0.5, mix(o.y, o.w, OLD_ANCHOR));
  vec4 f = vec4(c + (o.xy - c) * OLD_SCALE, c + (o.zw - c) * OLD_SCALE);
  if (p.x >= f.x && p.x <= f.z && p.y >= f.y && p.y <= f.w) {
    vec2 q = c + (p - c) / OLD_SCALE;
    return vec2(q.x, 1.0 - q.y);
  }
  outside = 1.0;
  vec4 r = OLD_OUTLINE;
  vec4 rs = vec4(c + (r.xy - c) * OLD_SCALE, c + (r.zw - c) * OLD_SCALE);
  float there = frameShadow(p, rs);
  if (p.x < o.x || p.x > o.z || p.y < o.y || p.y > o.w) {
    // Outside the old frame the card stays as printed, with the shadow moved.
    light = there / frameShadow(p, r);
    return uv;
  }
  vec2 side = vec2(p.x < 0.5 ? 2.0 * o.x - p.x : 2.0 * o.z - p.x, p.y);
  bool top = p.y < f.y;
  vec2 s = side;
  if (top || p.y > f.w) {
    float depth = top ? (p.y - o.y) / (f.y - o.y) : (o.w - p.y) / (o.w - f.w);
    s = vec2(p.x, top ? o.y - depth * OLD_TOP_BAND : o.w + depth * OLD_BOTTOM_BAND);
    float xm = min(p.x, 1.0 - p.x);
    if (xm < f.x) {
      // Corner: lean towards the edge of the old frame it is nearer.
      float toSide = (xm - o.x) / (f.x - o.x);
      w2 = smoothstep(-0.25, 0.25, depth - toSide);
      src2 = vec2(side.x, 1.0 - side.y);
      light2 = there / frameShadow(side, r);
    }
  }
  light = there / frameShadow(s, r);
  return vec2(s.x, 1.0 - s.y);
}

// Gradient of one foil-map channel, in texels.
vec2 mapGrad(vec2 uv, int ch) {
  vec4 px = texture2D(uFoilMap, uv + vec2(uFoilTexel.x, 0.0));
  vec4 nx = texture2D(uFoilMap, uv - vec2(uFoilTexel.x, 0.0));
  vec4 py = texture2D(uFoilMap, uv + vec2(0.0, uFoilTexel.y));
  vec4 ny = texture2D(uFoilMap, uv - vec2(0.0, uFoilTexel.y));
  return ch == 0 ? vec2(px.r - nx.r, py.r - ny.r)
       : ch == 1 ? vec2(px.g - nx.g, py.g - ny.g)
       : vec2(px.b - nx.b, py.b - ny.b);
}

void main() {
  // Rounded corners.
  vec2 half_ = vec2(uAspect, 1.0) * 0.5;
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  if (length(max(abs(q) - half_ + uRadius, 0.0)) - uRadius > 0.0) discard;

  // Wear is laid out in its own space, mirrored on the back so both sides
  // of the card wear in the same places.
  vec2 wuv = uMirror > 0.5 ? vec2(1.0 - vUv.x, vUv.y) : vUv;
  vec2 wq = (wuv - 0.5) * vec2(uAspect, 1.0);
  vec2 wcp = vec2(wuv.x * uAspect, wuv.y);
  float depthIn = -cardDist(wq, half_);
  float px = fwidth(vUv.y);   // one screen pixel, in card heights
  float edgeWhite = 0.0;
  if (uEdgeWear > 0.0) {
    float amt = edgeAmount(wq, half_, uSeed);
    // Bits of the edge gone, mostly at the corners.
    float chip = amt * amt * 0.0035 * smoothstep(0.45, 0.85, noise(wq * 70.0 + uSeed * 53.0));
    if (depthIn < chip) discard;
    float fine = mix(noise(wq * 260.0 + uSeed * 31.0), 0.5, clamp(px * 150.0 - 0.5, 0.0, 1.0));
    float reach = amt * (0.002 + 0.005 * fine);
    // As much of this pixel as lies in the worn strip, so faint wear stays faint from afar.
    edgeWhite = clamp((reach - depthIn) / max(px, 0.4 * reach), 0.0, 1.0);
    // Specks of white just inside the worn line.
    float speck = step(0.78, noise(wq * 520.0 + uSeed * 7.0)) * (1.0 - smoothstep(reach, reach * 2.5 + px, depthIn));
    edgeWhite = max(edgeWhite, speck * min(amt, 1.0) * (1.0 - clamp(px * 300.0 - 1.0, 0.0, 1.0)));
  }
  float creaseWhite = 0.0;
  vec2 creaseTilt = uCrease > 0.0 ? creases(wcp, uSeed, px, creaseWhite) : vec2(0.0);
  creaseTilt.x *= uMirror > 0.5 ? -1.0 : 1.0;   // back to the card's own uv directions

  // Where the printed card is read from (differs only for the old frame).
  vec2 src2 = vUv;
  float light = 1.0;
  float light2 = 1.0;
  float w2 = 0.0;
  float outsideArt = 0.0;
  vec2 uv = uOldFrame > 0.5 ? oldFrameUv(vUv, light, src2, light2, w2, outsideArt) : vUv;

  vec3 base = uHasMap > 0.5 ? texture2D(uMap, uv).rgb * light : vec3(0.08, 0.085, 0.1);
  if (w2 > 0.0 && uHasMap > 0.5) base = mix(base, texture2D(uMap, src2).rgb * light2, w2);
  bool hasFm = uHasFoilMap > 0.5;
  vec4 fm = hasFm ? texture2D(uFoilMap, uv) : vec4(0.0);

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 T = normalize(vTangent);
  vec3 B = normalize(vBitangent);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uLight - vWorldPos);
  vec2 Lt = vec2(dot(L, T), dot(L, B));
  N = normalize(N + T * creaseTilt.x + B * creaseTilt.y);

  // Faded ink: washed-out colours, lifted blacks, yellowed whites, and grime
  // in patches and along the handled edges.
  if (uFade > 0.0) {
    float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
    base = mix(base, vec3(l), 0.5 * uFade);
    base = mix(base, base * vec3(1.0, 0.95, 0.8) + vec3(0.09, 0.075, 0.04), uFade);
    float grime = smoothstep(0.45, 0.95, noise(wcp * 5.0 + uSeed * 23.0)) + 0.6 * (1.0 - smoothstep(0.0, 0.05, depthIn));
    base *= 1.0 - uFade * 0.22 * grime;
  }
  // Folds catch and lose the light on either side.
  base *= clamp(1.0 + dot(creaseTilt, Lt) * 1.5, 0.6, 1.4);

  float inArt = inRect(uArt, uv);
  float region = uRegion == 1 ? inArt : uRegion == 2 ? 1.0 - inArt : uRegion == 3 ? 1.0 : 0.0;
  float trimMask = max(1.0 - inRect(uInner, uv), inRect(uArtFrame, uv) * (1.0 - inArt) * (1.0 - outsideArt));
  float letters = inRect(uNameBox, uv) * fm.r;
  float stars = inRect(uStarsBox, uv) * fm.r;
  float border = 1.0 - inRect(uInner, uv);
  vec2 attrD = (uv - (uAttrBox.xy + uAttrBox.zw) * 0.5) / max((uAttrBox.zw - uAttrBox.xy) * 0.5, 1e-4);
  float attr = smoothstep(1.0, 0.9, length(attrD));
  float background = hasFm ? fm.a : 1.0;
  vec3 printed = base;

  // Card-space coordinates in real proportions, so patterns aren't stretched.
  vec2 cp = vec2(vUv.x * uAspect, vUv.y);

  // Gold rares age: the frame and title turn darker, liquid gold, and the
  // art goes from a faint embossed gold sheen to a plain, smooth holo.
  float goldAge = uTrim == 1 ? uAge : 0.0;

  // Some finishes recolour the ink itself.
  float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
  if (uTint == 1) {
    vec3 rb = spectrum(cp.x * 0.6 + cp.y * 0.8);
    base = mix(base, rb * (0.2 + 0.9 * sqrt(lum)), 0.5 * region);
  } else if (uTint == 2) {
    base = mix(base, vec3(1.0, 0.76, 0.4) * (0.1 + 1.0 * sqrt(lum)), 0.6 * region);
  } else if (uTint == 3) {
    // Ghost: the colours wash out into a pale, milky silver.
    base = mix(base, vec3(0.78, 0.83, 0.92) * (0.28 + 0.85 * lum), region);
  }
  // Ultimate rare: greyed and darkened wherever it's pressed.
  float dimMask = max(region, max(max(trimMask, stars), attr * uEmbossStars) * step(0.5, float(uTrim))) * uDim;
  dimMask = min(dimMask * (1.0 + 0.4 * uAge), 1.0);
  base = mix(base, mix(vec3(lum), base, 0.35 * (1.0 - 0.85 * uAge)) * (0.45 - 0.07 * uAge), dimMask);

  // Depth: the foiled art sits darker than the card around it, with a soft
  // inner shadow along its edges, like a window set into the card.
  if (uDepth > 0.0) {
    vec2 e = min(uv - uArt.xy, uArt.zw - uv) * vec2(uAspect, 1.0);
    float edge = smoothstep(0.0, 0.03, min(e.x, e.y));
    base *= mix(1.0, mix(0.5, 0.78, edge), uDepth * inArt);
  }

  // Embossing: the printed image pressed into the card, only inside the
  // foil region (the plain frame texture stays flat).
  vec2 relief = vec2(0.0);
  if (uEmboss > 0.0 && hasFm) {
    relief = -mapGrad(uv, 1) * uEmboss * (7.0 + 5.0 * uAge * (1.0 - float(uTrim == 1))) * region * (1.0 - goldAge);
  }
  vec2 tilt = relief;

  // Foil micro-structure.
  vec2 grating = normalize(vec2(1.0, 0.3));   // direction the rainbow spreads along
  float phase = 0.0;
  float stripes = 1.0;   // brightness modulation from ridges
  float sparkle = 0.0;
  vec3 sparkleCol = vec3(1.0);

  if (uPattern == 1) {
    // Holo streaks: thin vertical bands, each catching light a little differently.
    float c = cp.x * 140.0;
    float fade = clamp(1.0 - fwidth(c) * 0.8, 0.0, 1.0);
    float id = floor(c);
    tilt.x += ((hash(vec2(id, 3.1)) - 0.5) * 0.14 + sin(c * TAU) * 0.04) * fade;
    phase += hash(vec2(id, 7.0)) * 0.12 * fade;
    grating = vec2(1.0, 0.0);
  } else if (uPattern == 2) {
    // Secret rare: fine diagonal ridges running bottom-left to top-right,
    // plus a dense field of tiny specks that flash at their own angles.
    // The ridges sit mostly on the art's background, not on the subject.
    vec2 along = normalize(vec2(1.0, 1.0));
    vec2 across = vec2(along.y, -along.x);
    float c = dot(cp, across) * 170.0;
    float fade = clamp(1.2 - fwidth(c) * 0.6, 0.0, 1.0) * mix(1.0, background, uBgOnly);
    tilt += across * sin(c * TAU) * 0.16 * fade;
    // Ridges catch the light, the grooves between them stay dark.
    float ridge = pow(0.5 + 0.5 * sin(c * TAU), 2.0);
    stripes = mix(1.0, mix(0.25, 1.7, ridge), fade);
    grating = across;
    // Colour breaks into streaks that run with the ridges.
    phase += dot(cp, along) * 0.6 + noise(vec2(dot(cp, across) * 22.0, dot(cp, along) * 2.5)) * 0.7;

    vec2 g = cp * 190.0;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 h = hash2(id);
    float shape = smoothstep(0.5, 0.12, length(f));
    float sfade = clamp(1.6 - fwidth(g.x) * 0.8, 0.3, 1.0);
    float lit = flake(N, T, B, (h - 0.5) * 0.6, V, L, 70.0);
    sparkle = (0.12 + lit * 3.2) * shape * step(0.35, hash(id + 5.3)) * sfade;
    sparkleCol = mix(vec3(1.0), spectrum(h.x * 1.5 + phase), 0.75);
  } else if (uPattern == 8) {
    // Sheen: the secret rare's rainbow without its ridges and specks. Soft,
    // wide undulations spread the reflection over many angles (so the foil
    // answers the light everywhere instead of in one glare spot), the colour
    // breaks into soft diagonal streaks, and the hollows stay darker so the
    // art's own colours show through.
    vec2 along = normalize(vec2(1.0, 1.0));
    vec2 across = vec2(along.y, -along.x);
    vec2 w = vec2(noise(cp * 7.0), noise(cp * 7.0 + 11.0)) - 0.5;
    tilt += w * 0.2 + across * sin(dot(cp, across) * 28.0 + w.x * 4.0) * 0.06;
    // Fine metal grain on top of the waves: without it the smooth waves
    // read as glossy plastic film rather than foil.
    vec2 m = cp * 160.0;
    float mfade = clamp(1.4 - fwidth(m.x) * 0.7, 0.0, 1.0);
    tilt += (vec2(noise(m), noise(m + 7.0)) - 0.5) * 0.09 * mfade;
    stripes = (0.6 + 0.8 * noise(cp * vec2(5.0, 14.0) + w * 2.0)) * mix(1.0, 0.8 + 0.4 * noise(m * 0.5), mfade);
    grating = across;
    phase += dot(cp, along) * 0.6 + noise(vec2(dot(cp, across) * 9.0, dot(cp, along) * 2.0)) * 0.7;
  } else if (uPattern == 3) {
    // Glitter: larger, sparser flakes.
    vec2 g = cp * 70.0;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 h = hash2(id);
    float shape = smoothstep(0.45, 0.1, length(f - (hash2(id + 3.0) - 0.5) * 0.4));
    sparkle = flake(N, T, B, (h - 0.5) * 0.9, V, L, 180.0) * shape * step(0.25, hash(id + 1.7)) * 4.0;
    sparkleCol = mix(vec3(1.0), spectrum(h.y * 2.0), 0.6);
    tilt += (vec2(noise(cp * 260.0), noise(cp * 260.0 + 7.0)) - 0.5) * 0.06;
  } else if (uPattern == 4) {
    // Cosmos: overlapping discs of foil set at different angles, plus stars.
    for (int layer = 0; layer < 2; layer++) {
      float scale = layer == 0 ? 7.0 : 16.0;
      vec2 g = cp * scale + float(layer) * 3.7;
      vec2 id = floor(g);
      vec2 f = fract(g) - 0.5;
      vec2 center = (hash2(id) - 0.5) * 0.45;
      float rad = 0.16 + 0.22 * hash(id + 2.0);
      float inside = smoothstep(rad, rad - 0.03, length(f - center)) * step(0.3, hash(id + 9.0));
      tilt = mix(tilt, (hash2(id + 4.0) - 0.5) * 0.5, inside);
      phase += inside * hash(id + 1.0) * 0.8;
    }
    vec2 g = cp * 110.0;
    vec2 id = floor(g);
    float shape = smoothstep(0.4, 0.05, length(fract(g) - 0.5));
    sparkle = flake(N, T, B, (hash2(id) - 0.5) * 0.8, V, L, 200.0) * shape * step(0.6, hash(id + 2.2)) * 3.0;
  } else if (uPattern == 5) {
    // Etched: very fine engraved lines, deepened where the print has detail.
    vec2 dir = normalize(vec2(1.0, 0.45));
    vec2 across = vec2(dir.y, -dir.x);
    float c = dot(cp, across) * 330.0;
    float fade = clamp(1.0 - fwidth(c) * 0.7, 0.0, 1.0);
    tilt += across * sin(c * TAU) * 0.07 * fade * (1.0 - goldAge);
    if (hasFm) tilt -= mapGrad(uv, 2) * 3.0 * (1.0 - goldAge);
    grating = across;
  } else if (uPattern == 6) {
    // Surge: broad rainbow waves with fine ridges inside them.
    vec2 dir = normalize(vec2(1.0, 2.0));
    float c = dot(cp, dir) * 70.0;
    float fade = clamp(1.0 - fwidth(c) * 0.7, 0.0, 1.0);
    tilt += vec2(dir.y, -dir.x) * sin(c * TAU) * 0.06 * fade;
    phase += dot(cp, vec2(0.9, 1.7)) * 1.4;
  } else if (uPattern == 7) {
    // Relief lines: fine horizontal ridges pressed across the surface.
    float c = cp.y * 170.0;
    float fade = clamp(1.2 - fwidth(c) * 0.6, 0.0, 1.0);
    tilt.y += sin(c * TAU) * 0.14 * fade;
    stripes = 1.0 - 0.3 * fade * (0.5 - 0.5 * sin(c * TAU));
  } else {
    // Plain foil still has a faint grain.
    tilt += (vec2(noise(cp * 320.0), noise(cp * 320.0 + 7.0)) - 0.5) * 0.04;
  }

  // Rough metal: a fine, random micro-grain scatters the reflection.
  vec2 grit = (vec2(noise(cp * 900.0), noise(cp * 900.0 + 5.0)) - 0.5) * 0.22 * uRough;
  tilt += grit;

  // Sandblasted grain: each grain catches the light at its own angle, so a
  // rough metal surface glitters finely instead of showing a smooth sheen.
  float speck = 1.0;
  if (uRough > 0.0) {
    vec2 g = cp * 300.0;
    vec2 id = floor(g);
    float gfade = clamp(1.5 - fwidth(g.x) * 0.7, 0.0, 1.0);
    float lit = flake(N, T, B, tilt + (hash2(id) - 0.5) * 0.4, V, L, 30.0);
    float clump = noise(cp * 90.0);
    speck = mix(1.0, 0.6 + 1.5 * lit * (0.4 + clump), gfade * uRough);
  }

  // Reflection off the foil: a dim room, a soft halo and the hot spot.
  vec3 Nf = normalize(N + T * tilt.x + B * tilt.y);
  float rl = max(dot(reflect(-V, Nf), L), 0.0);
  float foilBright = 0.18 + 0.45 * pow(rl, 3.0) + mix(0.65, 0.5, uRough) * pow(rl, mix(16.0, 5.0, uRough))
                   + mix(1.3, 0.2, uRough) * pow(rl, mix(120.0, 16.0, uRough));

  // Diffraction: hue follows the half-vector across the grating.
  vec3 H = normalize(L + V);
  vec2 Ht = vec2(dot(H, T), dot(H, B)) + tilt * 0.5;
  float hue = dot(Ht, grating) * 1.8 + dot(cp, vec2(0.45, 0.3)) + phase;
  vec3 foilCol = mix(uMetal, vec3(1.0), goldAge) * mix(vec3(1.0), spectrum(hue), mix(uRainbow, 0.9, goldAge));

  // Ink filters the foil underneath it: white paper passes the whole
  // rainbow, blue ink only lets the blue part through, black ink hides it.
  // A deep-set art window is only darker on top; the foil under it still
  // shines through the original ink.
  vec3 inkT = min(pow(uDepth > 0.0 ? printed : base, vec3(0.85)) * 1.35, vec3(1.0));
  float outside = mix(uOutside, 1.0, inArt);
  float foilMask = max(region, uGlow) * outside * uStrength * uFoilBoost;
  // The ultra-rare glow outside the art is a little more silver than rainbow.
  vec3 sheenCol = mix(foilCol, uMetal, 0.25 * (1.0 - region));
  vec3 col = base * (1.0 - 0.3 * region * outside);
  col += inkT * sheenCol * foilBright * stripes * speck * foilMask;
  col += sparkleCol * mix(inkT, vec3(1.0), 0.6) * sparkle * region * uFoilBoost;

  // Relief shading so embossing reads even away from the highlight.
  col *= clamp(1.0 + dot(relief, Lt) * 0.8, 0.6, 1.5);

  // Border and art frame.
  if (uTrim > 0 && trimMask > 0.0) {
    float c = cp.y * 170.0;
    float fade = clamp(1.2 - fwidth(c) * 0.6, 0.0, 1.0);
    vec2 grain = (vec2(noise(cp * 400.0), noise(cp * 400.0 + 3.0)) - 0.5) * 0.08;
    if (uTrim == 1) {
      // Solid gold leaf, keeping the frame's bevel shading. Older gold is
      // smoother, so it loses the grain.
      vec3 Nt = normalize(N + (T * grain.x + B * grain.y) * (1.0 - uAge));
      float plum = dot(printed, vec3(0.2126, 0.7152, 0.0722));
      float shine = mix(metalBright(Nt, V, L, uRough), 1.2 * liquidBright(Nt, V, L), uAge);
      vec3 gold = goldTone(uAge) * shine * (0.45 + 0.9 * sqrt(plum));
      col = mix(col, gold, trimMask);
    } else {
      // Pressed relief lines with a faint metallic sheen.
      vec2 t2 = vec2(0.0, sin(c * TAU) * 0.16 * fade) + grain + grit;
      if (hasFm) t2 -= mapGrad(uv, 1) * (5.0 + 4.0 * uAge);
      vec3 Nt = normalize(N + T * t2.x + B * t2.y);
      float shade = clamp(1.0 + dot(t2, Lt) * 1.2, 0.5, 1.6);
      float rt = max(dot(reflect(-V, Nt), L), 0.0);
      vec3 sheen = uMetal * inkT * (0.15 * pow(rt, 4.0) + mix(0.6, 0.25, uRough) * pow(rt, mix(40.0, 8.0, uRough))) * speck;
      vec3 framed = col * shade + sheen;
      // The outer border is dark ink, which would hide the foil; it's bare
      // gunmetal instead.
      vec3 gunmetal = vec3(0.3, 0.29, 0.28) * metalBright(Nt, V, L, uRough) * mix(1.0, speck, 0.6) * shade;
      col = mix(col, mix(framed, gunmetal, border), trimMask);
    }
  }

  // Level stars pressed in like the trim.
  if (uEmbossStars > 0.5 && stars > 0.002) {
    vec2 bevel = mapGrad(uv, 0);
    vec3 Ns = normalize(N - (T * bevel.x + B * bevel.y) * 1.5);
    float shade = clamp(1.0 - dot(bevel, Lt) * 1.5, 0.5, 1.6);
    float rs = max(dot(reflect(-V, normalize(Ns + T * grit.x + B * grit.y)), L), 0.0);
    vec3 pressed = base * shade + vec3(1.0, 0.8, 0.5) * mix(0.4, 0.2, uRough) * pow(rs, mix(30.0, 8.0, uRough));
    col = mix(col, pressed * mix(1.0, speck, 0.6), stars);
  }

  // Attribute icon pressed in with a metal sheen.
  if (uEmbossStars > 0.5 && attr > 0.002 && hasFm) {
    vec2 bevel = mapGrad(uv, 1) * 6.0;
    vec3 Na = normalize(N - T * (bevel.x - grit.x) - B * (bevel.y - grit.y));
    float shade = clamp(1.0 - dot(bevel, Lt) * 1.2, 0.5, 1.6);
    float ra = max(dot(reflect(-V, Na), L), 0.0);
    vec3 sheen = uMetal * min(inkT + 0.25, vec3(1.0)) * (0.2 * pow(ra, 3.0) + 0.45 * pow(ra, 10.0)) * speck;
    col = mix(col, base * shade + sheen, attr);
  }

  // Level stars and attribute circle catching the light in their own colours.
  if (uShinyIcons > 0.5) {
    float icon = max(stars, attr);
    if (icon > 0.002) {
      vec2 bevel = hasFm ? mapGrad(uv, 0) : vec2(0.0);
      vec3 Ni = normalize(N - (T * bevel.x + B * bevel.y) * 1.2);
      float ri = max(dot(reflect(-V, Ni), L), 0.0);
      vec3 tint = min(pow(printed, vec3(0.8)) * 1.4, vec3(1.0)) * mix(vec3(1.0), spectrum(hue), 0.3);
      col += tint * (0.4 * pow(ri, 3.0) + 1.3 * pow(ri, 24.0) + 1.6 * pow(ri, 160.0)) * icon * uFoilBoost;
    }
  }

  // Foil-stamped title: bevelled metal letters.
  if (uName > 0 && letters > 0.002) {
    vec2 bevel = mapGrad(uv, 0);
    vec3 Nn = normalize(N - (T * (bevel.x * 1.2 - grit.x) + B * (bevel.y * 1.2 - grit.y)));
    // Gold-trimmed cards age their title with the trim.
    vec3 metal = uName == 2 ? mix(vec3(1.0, 0.72, 0.32), goldTone(1.0), goldAge) : vec3(0.9, 0.92, 0.96);
    if (uName == 3) metal = mix(metal, spectrum(hue + uv.x * 2.0) * 1.2, 0.55);
    else metal = mix(metal, metal * spectrum(hue), 0.2 * (1.0 - goldAge));
    float shine = mix(metalBright(Nn, V, L, uRough), 1.2 * liquidBright(Nn, V, L), goldAge);
    if (uPattern == 8) {
      // Sheen cards: brighter gold lettering that ripples with the same
      // rainbow as the art.
      vec3 Nr = normalize(Nn + T * tilt.x + B * tilt.y);
      metal = mix(vec3(1.0, 0.8, 0.42), vec3(1.0, 0.8, 0.42) * spectrum(hue + uv.x * 2.0) * 1.3, 0.4);
      shine = 1.25 * metalBright(Nr, V, L, uRough);
    }
    col = mix(col, metal * shine * mix(1.0, speck, 0.5 * uRough), letters);
  }

  // Card stock gloss; rough metal cards have a matte finish instead.
  vec3 Ng = normalize(N + T * relief.x + B * relief.y);
  // Sheen foil keeps its highlight in the foil's colours; a white coating
  // glint on top makes it look like plastic.
  float gloss = 0.2 * (1.0 - uRough) * (uPattern == 8 ? 0.3 : 1.0);
  col += vec3(pow(max(dot(reflect(-V, Ng), L), 0.0), 160.0)) * gloss;

  // The hologram sticker: gold foil pressed with a pattern, throwing a
  // rainbow as it tilts.
  if (uSticker > 0.5) {
    vec2 sp = (uv - uStickerBox.xy) / (uStickerBox.zw - uStickerBox.xy);
    vec2 sq = abs(sp - 0.5) * 2.0;
    float edge = max(sq.x, sq.y);
    if (edge < 1.0) {
      vec2 st = vec2(1.0 / 128.0);
      float pat = textureLod(uStickerTex, sp, 0.0).r;
      vec2 sg = vec2(textureLod(uStickerTex, sp + vec2(st.x, 0.0), 0.0).r - textureLod(uStickerTex, sp - vec2(st.x, 0.0), 0.0).r,
                     textureLod(uStickerTex, sp + vec2(0.0, st.y), 0.0).r - textureLod(uStickerTex, sp - vec2(0.0, st.y), 0.0).r);
      pat = smoothstep(0.1, 0.95, pat);
      vec3 Ns = normalize(N + T * sg.x * 3.0 + B * sg.y * 3.0);
      float rs = max(dot(reflect(-V, Ns), L), 0.0);
      float sh = dot(V + L, T) * 1.6 + dot(V + L, B) * 0.8 + pat * 0.6;
      vec3 gold = vec3(0.95, 0.7, 0.3);
      // Gold foil with the pattern pressed in: raised parts catch more light.
      vec3 sc = gold * (0.3 + 0.4 * pat) * (0.55 + 0.9 * pow(rs, 4.0));
      sc += gold * spectrum(sh) * 0.35 * (0.3 + 0.7 * pow(rs, 2.0)) * (0.5 + 0.5 * pat);
      sc += vec3(1.0, 0.92, 0.7) * pow(rs, 60.0) * 0.4;
      // A thin bright rim and soft corners.
      float corner = length(max(sq - 0.8, 0.0)) / 0.2;
      sc *= 1.0 + 0.5 * smoothstep(0.86, 0.95, edge);
      float a = 1.0 - smoothstep(0.96, 1.0, max(edge, corner));
      col = mix(col, sc, a);
    }
  }

  // Scratches scatter light and cut through the foil; wide scuffed patches
  // dull the gloss.
  if (uScratch > 0.0) {
    float spec = pow(max(dot(reflect(-V, N), L), 0.0), 6.0);
    float sc = scratches(wcp, uSeed + uMirror * 0.37, px) * (0.5 + 0.5 * uScratch);
    col = mix(col, printed * 0.85 + vec3(0.06 + 0.4 * spec), sc * 0.5);
    float haze = uScratch * smoothstep(0.35, 0.8, noise(wcp * 4.0 + uSeed * 11.0));
    col = mix(col, col * 0.88 + vec3(0.05 + 0.12 * spec), haze * 0.45);
  }
  col = mix(col, col * vec3(1.0, 0.96, 0.88), 0.35 * uFade);
  // Card stock showing through worn edges and cracked folds.
  col = mix(col, vec3(0.92, 0.91, 0.87), clamp(max(edgeWhite, creaseWhite), 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Where the hologram sits: [left, top, right, bottom] from the top-left. */
const YGO_STICKER: [number, number, number, number] = [0.913, 0.94, 0.964, 0.975];

let sticker: THREE.Texture | null = null;
function stickerTexture() {
  if (!sticker) {
    sticker = new THREE.TextureLoader().load(stickerUrl);
    sticker.colorSpace = THREE.NoColorSpace;
  }
  return sticker;
}

/** [left, top, right, bottom] from the top-left, to a uv rect from the bottom-left. */
const rect = ([l, t, r, b]: [number, number, number, number]) => new THREE.Vector4(l, 1 - b, r, 1 - t);
const NONE = new THREE.Vector4(2, 2, 2, 2);

export function createCardMaterial(
  game: Game,
  foil: FoilKey,
  shared: SharedUniforms,
  look: PrintLook = {},
): THREE.ShaderMaterial {
  const size = CARD_SIZE[game];
  const ygo = game === 'ygo';
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    toneMapped: false,
    side: THREE.FrontSide,
    uniforms: {
      uMap: { value: null },
      uHasMap: { value: 0 },
      uFoilMap: { value: null },
      uHasFoilMap: { value: 0 },
      uFoilTexel: { value: new THREE.Vector2(1 / 512, 1 / 700) },
      uArt: { value: rect(ART_BOX[game]) },
      uInner: { value: ygo ? rect(YGO_FRAME.inner) : new THREE.Vector4(0, 0, 1, 1) },
      uArtFrame: { value: ygo ? rect(YGO_FRAME.artFrame) : NONE },
      uNameBox: { value: rect(NAME_BOX[game]) },
      uStarsBox: { value: ygo ? rect(YGO_FRAME.stars) : NONE },
      uAttrBox: { value: ygo ? rect(YGO_FRAME.attr) : NONE },
      uAspect: { value: size.w / size.h },
      uRadius: { value: size.r },
      uRegion: { value: 0 },
      uPattern: { value: 0 },
      uTint: { value: 0 },
      uName: { value: 0 },
      uMetal: { value: new THREE.Color(1, 1, 1) },
      uRainbow: { value: 1 },
      uEmboss: { value: 0 },
      uGlow: { value: 0 },
      uOutside: { value: 1 },
      uStrength: { value: 1 },
      uRough: { value: 0 },
      uFoilBoost: shared.uFoilBoost,
      uTrim: { value: 0 },
      uDim: { value: 0 },
      uOldFrame: { value: 0 },
      uCrease: { value: 0 },
      uEdgeWear: { value: 0 },
      uScratch: { value: 0 },
      uFade: { value: 0 },
      uSeed: { value: 0 },
      uMirror: { value: 0 },
      uStickerTex: { value: stickerTexture() },
      uSticker: { value: 0 },
      uStickerBox: { value: rect(YGO_STICKER) },
      uAge: { value: 0 },
      uEmbossStars: { value: 0 },
      uShinyIcons: { value: 0 },
      uDepth: { value: 0 },
      uBgOnly: { value: 0 },
      uLight: shared.uLight,
      uTime: shared.uTime,
    },
  });
  setCardFoil(mat, game, foil, look);
  return mat;
}

export function setCardTexture(mat: THREE.ShaderMaterial, tex: THREE.Texture | null) {
  mat.uniforms.uMap.value = tex;
  mat.uniforms.uHasMap.value = tex ? 1 : 0;
}

export function setCardFoilMap(mat: THREE.ShaderMaterial, map: THREE.DataTexture | null) {
  mat.uniforms.uFoilMap.value = map;
  mat.uniforms.uHasFoilMap.value = map ? 1 : 0;
  if (map) mat.uniforms.uFoilTexel.value.set(1 / map.image.width, 1 / map.image.height);
}

export function setCardFoil(mat: THREE.ShaderMaterial, game: Game, foil: FoilKey, look: PrintLook = {}) {
  const p = rarityOf(game, foil).preset;
  const u = mat.uniforms;
  u.uRegion.value = p.region;
  u.uPattern.value = p.pattern;
  u.uTint.value = p.tint;
  u.uName.value = p.name;
  u.uMetal.value.setRGB(...p.metal);
  u.uRainbow.value = p.rainbow;
  u.uEmboss.value = p.emboss;
  u.uGlow.value = p.glow;
  u.uOutside.value = p.outside;
  u.uStrength.value = p.strength;
  u.uRough.value = p.rough;
  u.uTrim.value = p.trim;
  u.uDim.value = p.dim;
  u.uAge.value = printAge(game, foil, look.age);
  u.uOldFrame.value = look.card && look.oldFrame && hasOldFrame(look.card) ? 1 : 0;
  u.uEmbossStars.value = p.embossStars ? 1 : 0;
  u.uShinyIcons.value = p.shinyIcons ? 1 : 0;
  u.uDepth.value = p.depth;
  u.uBgOnly.value = p.backgroundOnly;
  u.uSticker.value = game === 'ygo' && look.card ? 1 : 0;
  setCardWear(mat, look);
}

/** Wear and damage; `back` lays it out to match the front from behind. */
export function setCardWear(mat: THREE.ShaderMaterial, look: PrintLook = {}, back = false) {
  const c = conditionOf(look.condition);
  const u = mat.uniforms;
  u.uCrease.value = c.crease;
  u.uEdgeWear.value = c.edges;
  u.uScratch.value = c.scratches;
  u.uFade.value = c.fade;
  u.uSeed.value = wearSeed(look.card);
  u.uMirror.value = back ? 1 : 0;
}

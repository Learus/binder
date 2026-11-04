import * as THREE from 'three';
import { ART_BOX, CARD_SIZE, NAME_BOX, printAge, rarityOf, YGO_FRAME } from '../foils';
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
uniform float uOldFrame;      // Yu-Gi-Oh! early frame: shorter art window

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

// Early Yu-Gi-Oh! frame: a smaller art window. For now only narrower: the
// bevelled art frame moves in from both sides by OLD_INSET, the card
// background beside it widens to fill the gap, and the art is cropped at its
// sides (not squeezed). Returns where to read the modern card image instead.
const float OLD_INSET = 0.03;
vec2 oldFrameUv(vec2 uv) {
  if (uv.y < uArtFrame.y || uv.y > uArtFrame.w) return uv;
  // Mirror the right half onto the left, map, then mirror back.
  bool right = uv.x > 0.5;
  float x = right ? 1.0 - uv.x : uv.x;
  float inner = uInner.x;
  float frame = uArtFrame.x;
  float art = uArt.x;
  if (x < inner) return uv;
  float src = x;
  if (x < frame + OLD_INSET) src = inner + (x - inner) * (frame - inner) / (frame + OLD_INSET - inner);
  else if (x < art + OLD_INSET) src = x - OLD_INSET;
  return vec2(right ? 1.0 - src : src, uv.y);
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

  // Where the printed card is read from (differs only for the old frame).
  vec2 uv = uOldFrame > 0.5 ? oldFrameUv(vUv) : vUv;

  vec3 base = uHasMap > 0.5 ? texture2D(uMap, uv).rgb : vec3(0.08, 0.085, 0.1);
  bool hasFm = uHasFoilMap > 0.5;
  vec4 fm = hasFm ? texture2D(uFoilMap, uv) : vec4(0.0);

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 T = normalize(vTangent);
  vec3 B = normalize(vBitangent);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uLight - vWorldPos);
  vec2 Lt = vec2(dot(L, T), dot(L, B));

  float inArt = inRect(uArt, uv);
  float region = uRegion == 1 ? inArt : uRegion == 2 ? 1.0 - inArt : uRegion == 3 ? 1.0 : 0.0;
  float trimMask = max(1.0 - inRect(uInner, uv), inRect(uArtFrame, uv) * (1.0 - inArt));
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

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

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
  u.uOldFrame.value = game === 'ygo' && look.oldFrame ? 1 : 0;
  u.uEmbossStars.value = p.embossStars ? 1 : 0;
  u.uShinyIcons.value = p.shinyIcons ? 1 : 0;
  u.uDepth.value = p.depth;
  u.uBgOnly.value = p.backgroundOnly;
}

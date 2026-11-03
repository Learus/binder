import * as THREE from 'three';
import { ART_BOX, CARD_SIZE, NAME_BOX, rarityOf, YGO_FRAME } from '../foils';
import type { FoilKey, Game } from '../types';

/**
 * Uniforms shared by every card so one update per frame moves the light and
 * advances time everywhere.
 */
export interface SharedUniforms {
  uLight: THREE.IUniform<THREE.Vector3>;
  uTime: THREE.IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uLight: { value: new THREE.Vector3(0, 30, 10) },
    uTime: { value: 0 },
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
uniform int uTrim;
uniform float uDim;
uniform float uEmbossStars;
uniform float uBgOnly;

// Frame parts (Yu-Gi-Oh!), same convention as uArt.
uniform vec4 uInner;          // inside edge of the outer border
uniform vec4 uArtFrame;       // outside edge of the art frame
uniform vec4 uNameBox;
uniform vec4 uStarsBox;

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

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

// How strongly a tiny mirror tilted by \`tilt\` reflects the light into the eye.
float flake(vec3 N, vec3 T, vec3 B, vec2 tilt, vec3 V, vec3 L, float sharp) {
  vec3 n = normalize(N + T * tilt.x + B * tilt.y);
  return pow(max(dot(reflect(-V, n), L), 0.0), sharp);
}

float inRect(vec4 r, vec2 p) {
  return step(r.x, p.x) * step(p.x, r.z) * step(r.y, p.y) * step(p.y, r.w);
}

// Bright metal surface: dim room, soft halo, hot spot.
float metalBright(vec3 N, vec3 V, vec3 L) {
  float r = max(dot(reflect(-V, N), L), 0.0);
  return 0.4 + 0.5 * pow(r, 3.0) + 0.8 * pow(r, 18.0) + 1.5 * pow(r, 140.0);
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
  vec2 uv = vUv;

  // Rounded corners.
  vec2 half_ = vec2(uAspect, 1.0) * 0.5;
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
  if (length(max(abs(q) - half_ + uRadius, 0.0)) - uRadius > 0.0) discard;

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
  float background = hasFm ? fm.a : 1.0;
  vec3 printed = base;

  // Card-space coordinates in real proportions, so patterns aren't stretched.
  vec2 cp = vec2(uv.x * uAspect, uv.y);

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
  float dimMask = max(region, max(trimMask, stars) * step(0.5, float(uTrim))) * uDim;
  base = mix(base, mix(vec3(lum), base, 0.35) * 0.45, dimMask);

  // Embossing: the printed image pressed into the card, only inside the
  // foil region (the plain frame texture stays flat).
  vec2 relief = vec2(0.0);
  if (uEmboss > 0.0 && hasFm) relief = -mapGrad(uv, 1) * uEmboss * 7.0 * region;
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
    tilt += across * sin(c * TAU) * 0.07 * fade;
    if (hasFm) tilt -= mapGrad(uv, 2) * 3.0;
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

  // Reflection off the foil: a dim room, a soft halo and the hot spot.
  vec3 Nf = normalize(N + T * tilt.x + B * tilt.y);
  float rl = max(dot(reflect(-V, Nf), L), 0.0);
  float foilBright = 0.18 + 0.45 * pow(rl, 3.0) + 0.65 * pow(rl, 16.0) + 1.3 * pow(rl, 120.0);

  // Diffraction: hue follows the half-vector across the grating.
  vec3 H = normalize(L + V);
  vec2 Ht = vec2(dot(H, T), dot(H, B)) + tilt * 0.5;
  float hue = dot(Ht, grating) * 1.8 + dot(cp, vec2(0.45, 0.3)) + phase;
  vec3 foilCol = uMetal * mix(vec3(1.0), spectrum(hue), uRainbow);

  // Ink filters the foil underneath it: white paper passes the whole
  // rainbow, blue ink only lets the blue part through, black ink hides it.
  vec3 inkT = min(pow(base, vec3(0.85)) * 1.35, vec3(1.0));
  float outside = mix(uOutside, 1.0, inArt);
  float foilMask = max(region, uGlow) * outside * uStrength;
  // The ultra-rare glow is more silver than rainbow.
  vec3 sheenCol = mix(foilCol, uMetal, 0.6 * (1.0 - region));
  vec3 col = base * (1.0 - 0.3 * region * outside);
  col += inkT * sheenCol * foilBright * stripes * foilMask;
  col += sparkleCol * mix(inkT, vec3(1.0), 0.6) * sparkle * region;

  // Relief shading so embossing reads even away from the highlight.
  col *= clamp(1.0 + dot(relief, Lt) * 0.8, 0.6, 1.5);

  // Border and art frame.
  if (uTrim > 0 && trimMask > 0.0) {
    float c = cp.y * 170.0;
    float fade = clamp(1.2 - fwidth(c) * 0.6, 0.0, 1.0);
    vec2 grain = (vec2(noise(cp * 400.0), noise(cp * 400.0 + 3.0)) - 0.5) * 0.08;
    if (uTrim == 1) {
      // Solid gold leaf, keeping the frame's bevel shading.
      vec3 Nt = normalize(N + T * grain.x + B * grain.y);
      float plum = dot(printed, vec3(0.2126, 0.7152, 0.0722));
      vec3 gold = vec3(1.0, 0.74, 0.34) * metalBright(Nt, V, L) * (0.45 + 0.9 * sqrt(plum));
      col = mix(col, gold, trimMask);
    } else {
      // Pressed relief lines with a faint metallic sheen.
      vec2 t2 = vec2(0.0, sin(c * TAU) * 0.16 * fade) + grain;
      if (hasFm) t2 -= mapGrad(uv, 1) * 5.0;
      vec3 Nt = normalize(N + T * t2.x + B * t2.y);
      float shade = clamp(1.0 + dot(t2, Lt) * 1.2, 0.5, 1.6);
      float rt = max(dot(reflect(-V, Nt), L), 0.0);
      vec3 sheen = uMetal * inkT * (0.15 * pow(rt, 4.0) + 0.6 * pow(rt, 40.0));
      col = mix(col, col * shade + sheen, trimMask);
    }
  }

  // Level stars pressed in like the trim.
  if (uEmbossStars > 0.5 && stars > 0.002) {
    vec2 bevel = mapGrad(uv, 0);
    vec3 Ns = normalize(N - (T * bevel.x + B * bevel.y) * 1.5);
    float shade = clamp(1.0 - dot(bevel, Lt) * 1.5, 0.5, 1.6);
    vec3 pressed = base * shade + vec3(1.0, 0.8, 0.5) * 0.4 * pow(max(dot(reflect(-V, Ns), L), 0.0), 30.0);
    col = mix(col, pressed, stars);
  }

  // Foil-stamped title: bevelled metal letters.
  if (uName > 0 && letters > 0.002) {
    vec2 bevel = mapGrad(uv, 0);
    vec3 Nn = normalize(N - (T * bevel.x + B * bevel.y) * 1.2);
    vec3 metal = uName == 2 ? vec3(1.0, 0.72, 0.32) : vec3(0.9, 0.92, 0.96);
    if (uName == 3) metal = mix(metal, spectrum(hue + uv.x * 2.0) * 1.2, 0.55);
    else metal = mix(metal, metal * spectrum(hue), 0.2);
    col = mix(col, metal * metalBright(Nn, V, L), letters);
  }

  // Card stock gloss.
  vec3 Ng = normalize(N + T * relief.x + B * relief.y);
  col += vec3(pow(max(dot(reflect(-V, Ng), L), 0.0), 160.0)) * 0.2;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** [left, top, right, bottom] from the top-left, to a uv rect from the bottom-left. */
const rect = ([l, t, r, b]: [number, number, number, number]) => new THREE.Vector4(l, 1 - b, r, 1 - t);
const NONE = new THREE.Vector4(2, 2, 2, 2);

export function createCardMaterial(game: Game, foil: FoilKey, shared: SharedUniforms): THREE.ShaderMaterial {
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
      uTrim: { value: 0 },
      uDim: { value: 0 },
      uEmbossStars: { value: 0 },
      uBgOnly: { value: 0 },
      uLight: shared.uLight,
      uTime: shared.uTime,
    },
  });
  setCardFoil(mat, game, foil);
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

export function setCardFoil(mat: THREE.ShaderMaterial, game: Game, foil: FoilKey) {
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
  u.uTrim.value = p.trim;
  u.uDim.value = p.dim;
  u.uEmbossStars.value = p.embossStars ? 1 : 0;
  u.uBgOnly.value = p.backgroundOnly;
}

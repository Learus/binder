import * as THREE from 'three';

export const ROOM_COLOR = '#0c0a08';

/**
 * Reflection environment: a dim, warm room lit by a lamp in front-left and a
 * soft window to the right. Nothing bright sits straight overhead, so glossy
 * surfaces don't flare when the binder is viewed from above.
 */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();

  const geo = new THREE.SphereGeometry(50, 48, 24);
  const colors: number[] = [];
  const floor = new THREE.Color('#0d0906');
  const wall = new THREE.Color('#2a2119');
  const ceiling = new THREE.Color('#15120f');
  const c = new THREE.Color();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    if (y < 0) c.copy(floor).lerp(wall, 1 + y);
    else c.copy(wall).lerp(ceiling, y);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  const panel = (w: number, h: number, color: string, power: number, at: THREE.Vector3Tuple) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }),
    );
    m.position.set(...at);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel(14, 10, '#ffd9a8', 6, [-28, 30, 26]); // lamp
  panel(30, 22, '#cfdcff', 1.2, [46, 14, -8]); // window
  panel(40, 8, '#ffe6c8', 0.6, [0, 6, 46]); // faint bounce from the front

  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.035).texture;
  pmrem.dispose();
  return tex;
}

/** Lamp and fill lights; `shadows` only for the main scene. */
export function createLights(shadows: boolean): THREE.Object3D[] {
  // A desk lamp: a soft pool of warm light on the binder that falls off
  // across the table.
  const lamp = new THREE.SpotLight('#ffe4c4', 2.4, 0, 0.62, 0.85, 0);
  lamp.position.set(-26, 72, 36);
  if (shadows) {
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.camera.near = 30;
    lamp.shadow.camera.far = 160;
    lamp.shadow.bias = -0.0004;
    lamp.shadow.normalBias = 0.02;
    lamp.shadow.radius = 4;
  }
  const fill = new THREE.HemisphereLight('#c8d4ff', '#2b1d12', 0.3);
  return [lamp, lamp.target, fill];
}

/** Wooden table top: planks with procedural grain. */
export function createTable(): THREE.Mesh {
  const tex = woodTexture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.6, 1.3);
  tex.anisotropy = 8;
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, envMapIntensity: 0.7 });
  const edge = new THREE.MeshStandardMaterial({ color: '#2c1a0e', roughness: 0.7 });
  // Box faces: +x, -x, +y, -y, +z, -z
  const table = new THREE.Mesh(new THREE.BoxGeometry(170, 4, 110), [edge, edge, top, edge, edge, edge]);
  table.position.y = -2.5;
  table.receiveShadow = true;
  return table;
}

function woodTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(w, h);

  const rand = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // Value noise that repeats every `period` cells along x, so the texture tiles.
  const noise = (x: number, y: number, period: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const a = rand(x0, yi);
    const b = rand(x1, yi);
    const c = rand(x0, yi + 1);
    const d = rand(x1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  const dark = [52, 31, 17];
  const light = [118, 78, 46];
  const plank = 128; // px per plank, planks run along x
  for (let y = 0; y < h; y++) {
    const p = Math.floor(y / plank);
    const shift = Math.floor(rand(p, 7) * 8); // whole cells keep the tiling intact
    const tone = 0.85 + rand(p, 3) * 0.3;
    for (let x = 0; x < w; x++) {
      const nx = x / w;
      // Long, gently wandering grain lines along the plank.
      const warp = noise(nx * 4 + shift, y / 90, 4) * 0.9 + noise(nx * 16 + shift, y / 25, 16) * 0.2;
      const grain = 0.5 + 0.5 * Math.sin((y / 2.2 + warp * 14) * 1.0);
      const fine = noise(nx * 600, y / 1.5, 600) * 0.18;
      const blotch = noise(nx * 3 + shift, y / 160, 3) * 0.25;
      let t = 0.35 + Math.pow(grain, 2) * 0.3 + fine + blotch;
      t = Math.min(1, t) * tone;
      const seam = y % plank < 2 ? 0.45 : 1;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = (dark[k] + (light[k] - dark[k]) * t) * seam;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

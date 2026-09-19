// Sky, sun and air.
//
//   A gradient dome, calibrated to photographs of the place rather than to a scattering model.
//   The Preetham model was tried first and dropped: through a filmic tone curve it cannot give the
//   deep, saturated blue the owner's midday photographs show over Sulphur Mountain and still hold
//   a blue sky at four in the afternoon — its sun term falls off too fast. So the sky is three
//   colours (zenith, the horizon away from the sun, the horizon towards it) keyed to the sun's
//   altitude, plus a forward-scatter glow and the disc itself. Each key colour was set by taking
//   the sRGB value from a photograph and inverting the renderer's tone curve, so what is seen is
//   what was photographed: #5d8fd9 straight up at noon, paling to #a8c4e8 at the horizon.
//
//   Sunlight keeps a physical part: its colour is what an atmosphere lets through at that
//   altitude (Preetham's extinction term), which is what reddens the last hour of the day.
//
//   The same three-colour function is evaluated here, in JavaScript, for two directions —
//   straight up for the sky light, along the horizon for the haze — so fog, sky and sky light
//   always agree, at every hour.

import * as THREE from 'three';
import { sunPosition, sunVector } from './sun';

// ---- key colours, in linear light, as the renderer needs them --------------------------------------
// (each is the ACES inverse of a photographed sRGB colour at the exposure the world uses then)

const L = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const KEYS = {
  day:   { zenith: L(0.1046, 0.2938, 1.0495), away: L(0.3302, 0.6515, 1.6601), sun: L(0.4300, 0.7800, 1.8200), glow: L(1.6, 1.25, 0.9), glowK: 0.5 },   // #5d8fd9 · #a8c4e8 · #c4d6ec
  dusk:  { zenith: L(0.0406, 0.0768, 0.1634), away: L(0.3243, 0.2591, 0.2010), sun: L(0.8359, 0.1957, 0.0528), glow: L(1.17, 0.30, 0.08), glowK: 1.3 },   // #3a5c8e · #c0b3a4 · #f4a962
  night: { zenith: L(0.0087, 0.0125, 0.0260), away: L(0.0174, 0.0230, 0.0406), sun: L(0.0174, 0.0230, 0.0406), glow: L(0, 0, 0), glowK: 0 }             // #0b1224 · #1a2236
};
const GROUND = L(0.1098, 0.0971, 0.0705);   // #4a4436, the dark under the horizon

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // always at the far plane
}`;

const FRAG = /* glsl */`
uniform vec3 uZenith; uniform vec3 uAway; uniform vec3 uToward; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uGlowColor; uniform float uGlow; uniform vec3 uSunColor; uniform float uDisc;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 s = normalize(uSunDir);
  float h = clamp(d.y, -1.0, 1.0);
  float toward = 0.5 + 0.5 * dot(normalize(d.xz + vec2(1e-5, 0.0)), normalize(s.xz + vec2(1e-5, 0.0)));
  vec3 horizon = mix(uAway, uToward, pow(toward, 4.0));
  float t = pow(1.0 - max(h, 0.0), 2.2);                      // 1 at the horizon, 0 straight up
  vec3 sky = mix(uZenith, horizon, t);
  float c = max(dot(d, s), 0.0);
  sky += uGlowColor * uGlow * (0.5 * pow(c, 32.0) + 0.5 * pow(c, 400.0));  // forward scatter, tight
  sky += uSunColor * uDisc * smoothstep(0.99992, 0.99997, c);             // the disc, about a degree across
  vec3 below = mix(horizon * 0.85, uGround, clamp(-h * 3.0, 0.0, 1.0));
  gl_FragColor = vec4(h < 0.0 ? below : sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- Preetham's extinction, for the colour of sunlight ---------------------------------------------
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH = 8.4e3, MIE_ZENITH = 1.25e3;
const SUNLIGHT = { turbidity: 4, rayleigh: 1.0, mieCoefficient: 0.005 };

/** how much of the sun's light survives the air on its way down — the colour of sunlight, linear */
export function sunTransmission(sun: THREE.Vector3, air = SUNLIGHT): [number, number, number] {
  const s = sun.clone().normalize();
  const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(s.y / 450000)));
  const rayleighCoefficient = air.rayleigh - (1 - sunfade);
  const c = 0.2 * air.turbidity * 10e-18;
  const zenithAngle = Math.acos(Math.max(0, s.y));
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  return TOTAL_RAYLEIGH.map((b, i) => Math.exp(-(b * rayleighCoefficient * RAYLEIGH_ZENITH * inverse + 0.434 * c * MIE_CONST[i] * air.mieCoefficient * MIE_ZENITH * inverse))) as [number, number, number];
}

/** how strong the sun and the sky light are, in three's units, so lit ground renders at about its own colour */
const SUN_INTENSITY = 3.6;
const SKYLIGHT_INTENSITY = 1.5;

export class Sky {
  mesh: THREE.Mesh;
  sun = new THREE.DirectionalLight(0xffffff, 3);
  ambient = new THREE.HemisphereLight(0xbcd6ff, 0x6b6550, 1);
  /** the sky at the horizon (away from the sun) and straight up, in linear light — the fog reads these */
  horizon = new THREE.Color();
  zenith = new THREE.Color();
  /** where the sun is, as a unit vector — the light is placed along it from wherever the player stands */
  dir = new THREE.Vector3(0, 1, 0);
  /**
   * How far the eye has opened. A camera on automatic, or an eye, lets in more of a dusk than of a
   * noon; without this the last hour of light is a black picture with a bright sky in it. 1 at
   * midday, rising as the sun drops, and held open through the night.
   */
  exposure = 1;
  /**
   * How much of the stand-in sky fill to keep.
   *
   *   The hemisphere light is an approximation of the sky: two colours and a lerp. Once the real
   *   dome has been pre-filtered into an environment map, that approximation is being *added* to
   *   the thing it was standing in for, and the shadows wash out. Looks pulls this down when it
   *   has the real one.
   */
  skylightScale = 1;
  private mat: THREE.ShaderMaterial;

  constructor(radius = 30000) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uZenith: { value: KEYS.day.zenith.clone() },
        uAway: { value: KEYS.day.away.clone() },
        uToward: { value: KEYS.day.sun.clone() },
        uGround: { value: GROUND.clone() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uGlowColor: { value: KEYS.day.glow.clone() },
        uGlow: { value: KEYS.day.glowK },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uDisc: { value: 20 }
      }
    });
    this.mat.toneMapped = true;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const c = this.sun.shadow.camera;
    c.near = 1; c.far = 2200; c.left = c.bottom = -320; c.right = c.top = 320;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
  }

  /** the sky's colour in a direction, in linear light — the same function the shader draws */
  colourAt(dir: THREE.Vector3): THREE.Color {
    const u = this.mat.uniforms;
    const d = dir.clone().normalize(), s = (u.uSunDir.value as THREE.Vector3).clone().normalize();
    const h = Math.max(-1, Math.min(1, d.y));
    const dxz = new THREE.Vector2(d.x + 1e-5, d.z).normalize(), sxz = new THREE.Vector2(s.x + 1e-5, s.z).normalize();
    const toward = 0.5 + 0.5 * dxz.dot(sxz);
    const horizon = (u.uAway.value as THREE.Color).clone().lerp(u.uToward.value as THREE.Color, Math.pow(toward, 4));
    const t = Math.pow(1 - Math.max(h, 0), 2.2);
    const sky = (u.uZenith.value as THREE.Color).clone().lerp(horizon, t);
    const c = Math.max(d.dot(s), 0);
    const glow = (u.uGlowColor.value as THREE.Color).clone().multiplyScalar((u.uGlow.value as number) * (0.5 * Math.pow(c, 32) + 0.5 * Math.pow(c, 400)));
    return sky.add(glow);
  }

  /** put the sun where it really is at this place and time, and colour the air to match */
  set(date: Date, lat: number, lng: number) {
    const p = sunPosition(date, lat, lng);
    const v = sunVector(p);
    const sunDir = new THREE.Vector3(v.x, v.y, v.z);
    this.dir.copy(sunDir).setY(Math.max(v.y, 0.02)).normalize();
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.dir, 900);
    (this.mat.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);

    // the key colours: night below -10°, dusk around the horizon, full day from 24° up
    const n = THREE.MathUtils.smoothstep(p.altitude, -10, -1);
    const d = THREE.MathUtils.smoothstep(p.altitude, 1, 24);
    const u = this.mat.uniforms;
    const mix3 = (k: 'zenith' | 'away' | 'sun' | 'glow') => KEYS.night[k].clone().lerp(KEYS.dusk[k], n).lerp(KEYS.day[k], d);
    (u.uZenith.value as THREE.Color).copy(mix3('zenith'));
    (u.uAway.value as THREE.Color).copy(mix3('away'));
    (u.uToward.value as THREE.Color).copy(mix3('sun'));
    (u.uGlowColor.value as THREE.Color).copy(mix3('glow'));
    u.uGlow.value = KEYS.night.glowK + (KEYS.dusk.glowK - KEYS.night.glowK) * n + (KEYS.day.glowK - KEYS.dusk.glowK) * d;

    // the sun's own colour is what the air lets through
    const t = sunTransmission(sunDir);
    const peak = Math.max(t[0], t[1], t[2], 1e-3);
    this.sun.color.setRGB(t[0] / peak, t[1] / peak, t[2] / peak, THREE.LinearSRGBColorSpace);
    (u.uSunColor.value as THREE.Color).copy(this.sun.color);
    u.uDisc.value = 20 * THREE.MathUtils.smoothstep(p.altitude, -1, 1);

    // the sky, asked twice: straight up, and along the horizon square to the sun
    const side = new THREE.Vector3(-v.z, 0, v.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    this.horizon.copy(this.colourAt(side.multiplyScalar(Math.cos(0.03)).add(new THREE.Vector3(0, Math.sin(0.03), 0))));
    this.zenith.copy(this.colourAt(new THREE.Vector3(0, 1, 0)));

    // the lights. The sun keeps at least a third of its strength while it is up — the reddening
    // carries the hour — and the eye opens as it drops, so dusk is dim and warm rather than black.
    const day = THREE.MathUtils.smoothstep(p.altitude, -6, 10);
    const up = THREE.MathUtils.smoothstep(p.altitude, -1, 6);
    this.sun.intensity = 0.02 + SUN_INTENSITY * up * (0.35 + 0.65 * Math.min(1, peak * 1.25));
    // sky light is the zenith's blue warmed by a third of the horizon — the whole dome, not one point —
    // and the ground bounce is the colour of the straw and dirt the light comes back off
    const zp = Math.max(this.zenith.r, this.zenith.g, this.zenith.b, 1e-3);
    const hp = Math.max(this.horizon.r, this.horizon.g, this.horizon.b, 1e-3);
    this.ambient.color.setRGB(this.zenith.r / zp, this.zenith.g / zp, this.zenith.b / zp, THREE.LinearSRGBColorSpace)
      .lerp(new THREE.Color().setRGB(this.horizon.r / hp, this.horizon.g / hp, this.horizon.b / hp, THREE.LinearSRGBColorSpace), 0.35);
    this.ambient.groundColor.set('#8a7f62');
    this.ambient.intensity = (0.1 + SKYLIGHT_INTENSITY * day) * this.skylightScale;
    this.exposure = 1 + 0.9 * (1 - THREE.MathUtils.smoothstep(p.altitude, -2, 30));
    return { pos: p, horizon: this.horizon, zenith: this.zenith };
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.mesh, this.sun, this.sun.target, this.ambient);
  }
}

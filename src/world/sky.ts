// Sky, sun and air.
//
//   A gradient dome rather than a full atmospheric scattering pass: it costs one draw call, it
//   reads correctly at every sun angle we care about, and it leaves the frame budget for the
//   things that actually carry the place — the ground, the trees and the buildings. The colours
//   are driven by the real sun altitude, so dusk looks like dusk rather than like a slider.

import * as THREE from 'three';
import { sunPosition, sunVector } from './sun';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // always at the far plane
}`;

const FRAG = /* glsl */`
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSun; uniform float uAlt;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 sky = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
  vec3 col = h < 0.0 ? mix(uHorizon, uGround, clamp(-h * 2.4, 0.0, 1.0)) : sky;
  float s = max(dot(d, normalize(uSun)), 0.0);
  col += vec3(1.0, 0.86, 0.66) * pow(s, 160.0) * 1.4;                    // the disc
  col += vec3(1.0, 0.78, 0.52) * pow(s, 6.0) * 0.22 * smoothstep(-6.0, 12.0, uAlt);  // the glow
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  mesh: THREE.Mesh;
  sun = new THREE.DirectionalLight(0xfff2dc, 2.0);
  ambient = new THREE.HemisphereLight(0xbcd6ff, 0x6b6550, 0.85);
  private mat: THREE.ShaderMaterial;

  constructor(radius = 8000) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color('#2f6fd0') },
        uHorizon: { value: new THREE.Color('#bcd2e8') },
        uGround: { value: new THREE.Color('#4a4436') },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uAlt: { value: 45 }
      }
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), this.mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.near = 1; c.far = 2200; c.left = c.bottom = -320; c.right = c.top = 320;
    this.sun.shadow.bias = -0.0008;
  }

  /** put the sun where it really is at this place and time, and colour the air to match */
  set(date: Date, lat: number, lng: number) {
    const p = sunPosition(date, lat, lng);
    const v = sunVector(p);
    this.sun.position.set(v.x, Math.max(v.y, 0.02), v.z).multiplyScalar(1500);
    this.sun.target.position.set(0, 0, 0);
    this.mat.uniforms.uSun.value.set(v.x, v.y, v.z);
    this.mat.uniforms.uAlt.value = p.altitude;

    const day = THREE.MathUtils.smoothstep(p.altitude, -6, 14);       // night -> day
    const low = 1 - THREE.MathUtils.smoothstep(p.altitude, 2, 26);    // how close to the horizon
    const top = new THREE.Color('#0a1330').lerp(new THREE.Color('#2f6fd0'), day);
    const hor = new THREE.Color('#18203f').lerp(new THREE.Color('#bcd2e8'), day).lerp(new THREE.Color('#f0a061'), low * day * 0.8);
    this.mat.uniforms.uTop.value.copy(top);
    this.mat.uniforms.uHorizon.value.copy(hor);
    this.sun.intensity = 0.15 + 2.1 * day;
    this.sun.color.copy(new THREE.Color('#ffe9c8').lerp(new THREE.Color('#ff9d54'), low * 0.85));
    this.ambient.intensity = 0.14 + 0.8 * day;
    return { pos: p, horizon: hor };
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.mesh, this.sun, this.sun.target, this.ambient);
  }
}

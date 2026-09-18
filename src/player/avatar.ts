// The body other people see.
//
//   Playground makes the avatars; this is the socket they drop into. So the rig is an interface
//   with two implementations — a built-in one that always works, and a loaded one for a real
//   character — and the walk cycle lives outside both of them, in `gait()`, so the two move
//   identically and the motion can be checked against numbers rather than against a screenshot.
//
//   The gait is driven by DISTANCE TRAVELLED, not by the clock. Feet that are paced by time skate
//   whenever the speed changes; feet paced by ground covered stay planted. One stride is 1.55 m,
//   which is a person's, so at the 1.6 m/s walk the legs turn over about once a second.

import * as THREE from 'three';

export const STRIDE = 1.55;

export interface Pose {
  leftLeg: number; rightLeg: number;
  leftKnee: number; rightKnee: number;
  leftArm: number; rightArm: number;
  bob: number; lean: number;
}

/**
 * The walk cycle.
 *
 * @param phase     cumulative distance travelled, in metres
 * @param intensity 0 at a standstill, 1 walking, ~1.5 at a run — scales the swing
 * @param airborne  true while off the ground: the legs tuck instead of swinging
 */
export function gait(phase: number, intensity: number, airborne: boolean): Pose {
  if (airborne) {
    return {
      leftLeg: -0.55, rightLeg: 0.3, leftKnee: 0.9, rightKnee: 0.35,
      leftArm: -0.7, rightArm: -0.5, bob: 0, lean: 0.06
    };
  }
  const t = (phase / STRIDE) * Math.PI * 2;
  const swing = 0.42 * intensity;
  const l = Math.sin(t), r = Math.sin(t + Math.PI);
  return {
    leftLeg: l * swing,
    rightLeg: r * swing,
    // the knee only bends on the way through, never backwards
    leftKnee: Math.max(0, -l) * 0.85 * intensity,
    rightKnee: Math.max(0, -r) * 0.85 * intensity,
    leftArm: r * swing * 0.75,
    rightArm: l * swing * 0.75,
    bob: Math.abs(Math.cos(t)) * 0.035 * intensity,
    lean: 0.05 * intensity
  };
}

export interface RigInput {
  dt: number;
  /** metres travelled since the last call */
  distance: number;
  speed: number;
  grounded: boolean;
}

export interface AvatarRig {
  readonly object: THREE.Object3D;
  readonly kind: 'capsule' | 'vrm' | 'gltf';
  /** the last pose applied — the tests read this rather than inspecting the scene graph */
  readonly pose: Pose;
  update(i: RigInput): void;
  dispose(): void;
}

// ---- the built-in body --------------------------------------------------------------------------
// Deliberately crude and deliberately the right size: 1.8 m, human proportions, so a doorway judged
// against it is judged correctly even before a real character exists.

const SKIN = '#d9b08c';
const CLOTH = '#3d6b52';

function limb(len: number, r0: number, r1: number, colour: string): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r1, r0, len, 7, 1),
    new THREE.MeshLambertMaterial({ color: colour })
  );
  m.position.y = -len / 2;                 // hangs from the joint at the group's origin
  m.castShadow = true;
  g.add(m);
  return g;
}

export class CapsuleRig implements AvatarRig {
  readonly object = new THREE.Group();
  readonly kind = 'capsule' as const;
  pose: Pose = gait(0, 0, false);
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private legL: THREE.Group; private legR: THREE.Group;
  private kneeL: THREE.Group; private kneeR: THREE.Group;
  private armL: THREE.Group; private armR: THREE.Group;
  private phase = 0;

  constructor() {
    this.object.name = 'avatar';
    this.object.add(this.hips);
    this.hips.position.y = 0.92;
    this.hips.add(this.torso);

    const chest = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.21, 0.42, 5, 10),
      new THREE.MeshLambertMaterial({ color: CLOTH })
    );
    chest.position.y = 0.3;
    chest.castShadow = true;
    this.torso.add(chest);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.145, 16, 12),
      new THREE.MeshLambertMaterial({ color: SKIN })
    );
    head.position.y = 0.72;
    head.castShadow = true;
    this.torso.add(head);

    // a nose, purely so third person can tell which way the body is facing
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.045, 0.11, 8),
      new THREE.MeshLambertMaterial({ color: SKIN })
    );
    nose.position.set(0, 0.7, -0.15);
    nose.rotation.x = -Math.PI / 2;
    this.torso.add(nose);

    this.armL = limb(0.62, 0.062, 0.048, SKIN); this.armL.position.set(0.245, 0.52, 0);
    this.armR = limb(0.62, 0.062, 0.048, SKIN); this.armR.position.set(-0.245, 0.52, 0);
    this.torso.add(this.armL, this.armR);

    this.legL = limb(0.47, 0.085, 0.072, CLOTH); this.legL.position.set(0.105, 0, 0);
    this.legR = limb(0.47, 0.085, 0.072, CLOTH); this.legR.position.set(-0.105, 0, 0);
    this.kneeL = limb(0.45, 0.07, 0.055, CLOTH); this.kneeL.position.y = -0.47;
    this.kneeR = limb(0.45, 0.07, 0.055, CLOTH); this.kneeR.position.y = -0.47;
    this.legL.add(this.kneeL); this.legR.add(this.kneeR);
    this.hips.add(this.legL, this.legR);
  }

  update(i: RigInput) {
    this.phase += i.distance;
    const intensity = Math.min(1.45, i.speed / 1.6);
    const p = gait(this.phase, i.grounded ? intensity : 1, !i.grounded);
    this.pose = p;
    this.legL.rotation.x = p.leftLeg;
    this.legR.rotation.x = p.rightLeg;
    this.kneeL.rotation.x = p.leftKnee;
    this.kneeR.rotation.x = p.rightKnee;
    this.armL.rotation.x = p.leftArm;
    this.armR.rotation.x = p.rightArm;
    this.hips.position.y = 0.92 + p.bob;
    this.torso.rotation.x = p.lean;
  }

  dispose() {
    this.object.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }
}

// ---- a real character ----------------------------------------------------------------------------
// VRM first, because that is what Playground will export and it carries a named humanoid skeleton,
// so there is nothing to map by hand. A plain .glb still works: the bones are found by the names
// every rigging tool agrees on. Neither loader ships unless an avatar is actually asked for.

const BONE_ALIASES: Record<keyof BoneSet, string[]> = {
  hips: ['hips', 'pelvis'],
  leftUpperLeg: ['leftupperleg', 'leftupleg', 'thigh_l', 'leftthigh', 'upleg_l'],
  rightUpperLeg: ['rightupperleg', 'rightupleg', 'thigh_r', 'rightthigh', 'upleg_r'],
  leftLowerLeg: ['leftlowerleg', 'leftleg', 'calf_l', 'leftcalf', 'shin_l'],
  rightLowerLeg: ['rightlowerleg', 'rightleg', 'calf_r', 'rightcalf', 'shin_r'],
  leftUpperArm: ['leftupperarm', 'leftarm', 'upperarm_l', 'arm_l'],
  rightUpperArm: ['rightupperarm', 'rightarm', 'upperarm_r', 'arm_r'],
  spine: ['spine', 'spine1', 'chest']
};

export interface BoneSet {
  hips: THREE.Object3D | null;
  leftUpperLeg: THREE.Object3D | null;
  rightUpperLeg: THREE.Object3D | null;
  leftLowerLeg: THREE.Object3D | null;
  rightLowerLeg: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  spine: THREE.Object3D | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_.:|-]/g, '').replace(/^mixamorig/, '');

/** find a humanoid skeleton in an arbitrary glTF by the names riggers actually use */
export function findBones(root: THREE.Object3D): BoneSet {
  const found = {} as BoneSet;
  const all: THREE.Object3D[] = [];
  root.traverse(o => all.push(o));
  for (const key of Object.keys(BONE_ALIASES) as (keyof BoneSet)[]) {
    const wanted = BONE_ALIASES[key];
    found[key] =
      all.find(o => wanted.includes(norm(o.name))) ??
      all.find(o => wanted.some(w => norm(o.name).endsWith(w))) ??
      null;
  }
  return found;
}

export class BoneRig implements AvatarRig {
  readonly object: THREE.Object3D;
  readonly kind: 'vrm' | 'gltf';
  pose: Pose = gait(0, 0, false);
  private phase = 0;
  private rest = new Map<THREE.Object3D, THREE.Quaternion>();
  private tmp = new THREE.Quaternion();
  private eul = new THREE.Euler();

  constructor(object: THREE.Object3D, private bones: BoneSet, kind: 'vrm' | 'gltf', private vrm?: { update(dt: number): void }) {
    this.object = object;
    this.kind = kind;
    for (const b of Object.values(bones)) if (b) this.rest.set(b, b.quaternion.clone());
    object.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  }

  private turn(bone: THREE.Object3D | null, x: number) {
    if (!bone) return;
    const rest = this.rest.get(bone)!;
    this.eul.set(x, 0, 0);
    this.tmp.setFromEuler(this.eul);
    bone.quaternion.copy(rest).multiply(this.tmp);
  }

  update(i: RigInput) {
    this.phase += i.distance;
    const intensity = Math.min(1.45, i.speed / 1.6);
    const p = gait(this.phase, i.grounded ? intensity : 1, !i.grounded);
    this.pose = p;
    this.turn(this.bones.leftUpperLeg, p.leftLeg);
    this.turn(this.bones.rightUpperLeg, p.rightLeg);
    this.turn(this.bones.leftLowerLeg, -p.leftKnee);
    this.turn(this.bones.rightLowerLeg, -p.rightKnee);
    this.turn(this.bones.leftUpperArm, p.leftArm);
    this.turn(this.bones.rightUpperArm, p.rightArm);
    this.turn(this.bones.spine, p.lean);
    this.vrm?.update(i.dt);
  }

  dispose() {
    this.object.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose(); }
    });
  }
}

/**
 * Load an avatar, or fall back to the built-in body.
 *
 *   Never throws and never leaves the world without a body: a missing file, a 404, a format the
 *   loader does not understand, all end with a capsule standing on the hill rather than an empty
 *   world and a console error.
 */
export async function loadAvatar(url?: string | null): Promise<AvatarRig> {
  if (!url) return new CapsuleRig();
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    let vrmPlugin = false;
    try {
      const vrmMod = await import('@pixiv/three-vrm');
      loader.register(p => new vrmMod.VRMLoaderPlugin(p));
      vrmPlugin = true;
    } catch { /* no VRM support built in; a plain glTF still loads */ }

    const gltf = await loader.loadAsync(url);
    const vrm = vrmPlugin ? (gltf.userData as { vrm?: unknown }).vrm as {
      scene: THREE.Object3D;
      humanoid?: { getNormalizedBoneNode(n: string): THREE.Object3D | null };
      update(dt: number): void;
    } | undefined : undefined;

    if (vrm?.humanoid) {
      const h = vrm.humanoid;
      const bones: BoneSet = {
        hips: h.getNormalizedBoneNode('hips'),
        leftUpperLeg: h.getNormalizedBoneNode('leftUpperLeg'),
        rightUpperLeg: h.getNormalizedBoneNode('rightUpperLeg'),
        leftLowerLeg: h.getNormalizedBoneNode('leftLowerLeg'),
        rightLowerLeg: h.getNormalizedBoneNode('rightLowerLeg'),
        leftUpperArm: h.getNormalizedBoneNode('leftUpperArm'),
        rightUpperArm: h.getNormalizedBoneNode('rightUpperArm'),
        spine: h.getNormalizedBoneNode('spine')
      };
      return new BoneRig(vrm.scene, bones, 'vrm', vrm);
    }
    return new BoneRig(gltf.scene, findBones(gltf.scene), 'gltf');
  } catch (e) {
    console.info('[world] avatar fell back to the built-in body:', e);
    return new CapsuleRig();
  }
}

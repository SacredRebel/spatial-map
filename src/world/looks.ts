// How the light lands.
//
//   The world already knew where the sun was — the real NOAA position for this longitude and this
//   moment — and it already cast a shadow map and tone-mapped the result. What it did not have was
//   the small darkenings that tell the eye a thing is *touching the ground*: the wedge under an
//   eave, the gather of shade where a trunk meets the slope, the dimming inside a doorway. Without
//   them every object floats a little, and a floating object reads as a diagram.
//
//   So: ground-truth ambient occlusion over the whole frame, and a sky that lights things from the
//   sky's own colour rather than from a guess. Between them they do more for the picture than any
//   amount of geometry, and they cost no new dependency — every pass here ships inside three.
//
//   THE RULE THIS FILE KEEPS: the plain render is never taken away. The composer is an addition,
//   tried once, dropped the moment it is unavailable or too slow, and the world goes on drawing
//   the way it always did. A device that cannot afford the chain does not get a black screen; it
//   gets the world, at speed. `render()` is the only thing the loop calls, and it always works.

import * as THREE from 'three';
// TYPE ONLY — these are erased at compile time. The passes themselves are fetched by set(), and
// only when someone actually asks for them: the occlusion shaders and their noise texture are 40 kB
// that a world with the chain switched off should never pay to parse. They were static once, and
// the extra 40 kB on every boot was enough to push a cold page over a test's patience, which is a
// fair warning about what it was doing to a phone.
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/**
 * off   — the plain renderer, exactly as before this file existed
 * plain — the composer, no occlusion: tone mapping moves into OutputPass, nothing else changes
 * full  — the composer with ground-truth ambient occlusion
 */
export type Quality = 'off' | 'plain' | 'full';

/**
 * Metres of neighbourhood an occlusion sample considers — this world is 1 unit : 1 metre.
 *
 *   Under a metre is crevice occlusion: it finds the seam between two boards and nothing else, and
 *   on open ground it finds nothing at all. Swept against this landscape, two and a half metres is
 *   where a building starts to sit down onto the slope it stands on and a trunk gathers shade at
 *   its foot, while five begins to smear the whole hillside grey.
 */
const AO_RADIUS = 2.5;
/**
 * The depth range the occlusion is allowed to think in.
 *
 *   The world's own camera sees from 0.1 m to 60 km, because the ridge across the valley is part
 *   of the picture. That is a depth range of six hundred thousand to one, and a screen-space
 *   effect reading a buffer stretched that far is reading noise: a 0.9 m dip in the ground is
 *   below the precision of the number. So the occlusion gets its own camera — same position, same
 *   lens, same pixels, but only looking as far as occlusion could ever matter. Nothing past this
 *   is occluded, which is correct, because nothing past this shows it.
 */
const AO_NEAR = 0.25;
const AO_FAR = 400;
/** how dark the occlusion is allowed to get; above ~1.2 the hillside turns to soot */
const AO_SCALE = 1.05;
/** below this, for this many seconds in a row, the chain is costing more than it returns */
const SLOW_FPS = 26;
const SLOW_FOR = 2.5;

export interface LooksOpts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** what to ask for before anything is measured; 'auto' reads the device */
  want?: Quality | 'auto';
}

/**
 * A guess at what this machine can afford, made once, before a frame has been drawn.
 *
 *   Coarse on purpose. The watchdog below is the real judge — this only decides where to start,
 *   so that a phone does not spend two seconds at eight frames a second learning what it is.
 */
function guess(renderer: THREE.WebGLRenderer): Quality {
  try {
    if (!renderer.capabilities.isWebGL2) return 'off';
    const touch = matchMedia('(pointer: coarse)').matches;
    const cores = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
    // a phone renders the same frame over far more pixels than its fill rate wants
    if (touch && devicePixelRatio > 2) return 'plain';
    if (touch || cores <= 4) return 'plain';
    return 'full';
  } catch {
    return 'off';
  }
}

export class Looks {
  quality: Quality = 'off';
  /** what was asked for, before the watchdog had an opinion — a downgrade never overwrites this */
  readonly wanted: Quality;
  /** true once the watchdog has stepped the quality down; the reason the HUD can say why */
  downgraded = false;
  /**
   * Whether a slow frame is allowed to step the chain down.
   *
   *   On a real machine it must be, and it is. A software renderer — which is what a headless test
   *   is looking through — is slow at everything, so the watchdog would judge the picture before
   *   anyone had seen it. The suite turns this off to photograph what a real GPU would draw.
   */
  watchdog = true;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  private aoCam: THREE.PerspectiveCamera | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private env: THREE.Texture | null = null;
  private slow = 0;
  /**
   * What the chain is *becoming*, as opposed to what it is.
   *
   *   Building a rung takes a fetch, so between the decision and the chain there is a gap, and in
   *   that gap `quality` still names the old rung. Anything that needs to know what was decided —
   *   the watchdog deciding whether it has already stepped down, a test asking whether the step
   *   happened — should read this, which is set the moment the decision is made.
   */
  private target: Quality = 'off';
  /** the pass class, kept from the dynamic import so setOutput() can name its modes */
  private Gtao: typeof GTAOPass | null = null;

  constructor(o: LooksOpts) {
    this.renderer = o.renderer;
    this.scene = o.scene;
    this.camera = o.camera;
    const want = !o.want || o.want === 'auto' ? guess(o.renderer) : o.want;
    this.wanted = want;
    this.set(want);
  }

  /**
   * Ask for a quality. Anything that throws on the way lands on 'off', which is the working world,
   * so a driver that dislikes one pass costs the viewer nothing but the occlusion.
   */
  async set(q: Quality): Promise<Quality> {
    if (q === this.target && q === this.quality) return this.quality;
    this.target = q;
    this.dispose();
    if (q === 'off') { this.quality = 'off'; return this.quality; }
    try {
      const [{ EffectComposer }, { RenderPass }, { OutputPass }] = await Promise.all([
        import('three/examples/jsm/postprocessing/EffectComposer.js'),
        import('three/examples/jsm/postprocessing/RenderPass.js'),
        import('three/examples/jsm/postprocessing/OutputPass.js')
      ]);
      const c = new EffectComposer(this.renderer);
      c.addPass(new RenderPass(this.scene, this.camera));
      if (q === 'full') {
        const { GTAOPass } = await import('three/examples/jsm/postprocessing/GTAOPass.js');
        this.Gtao = GTAOPass;
        const ao = new THREE.PerspectiveCamera(this.camera.fov, this.camera.aspect, AO_NEAR, AO_FAR);
        this.syncAoCam(ao);
        const g = new GTAOPass(this.scene, ao, innerWidth, innerHeight);
        this.aoCam = ao;
        g.output = GTAOPass.OUTPUT.Default;
        g.updateGtaoMaterial({ radius: AO_RADIUS, scale: AO_SCALE, distanceExponent: 1, thickness: 1, samples: 16 });
        c.addPass(g);
        this.gtao = g;
      }
      // the composer's targets are linear: the tone map and the colour space belong at the end of
      // the chain, not baked into every material, or the occlusion would darken an already-graded
      // picture and the shadows would go to mud
      c.addPass(new OutputPass());
      c.setSize(innerWidth, innerHeight);
      c.setPixelRatio(this.renderer.getPixelRatio());
      this.composer = c;
      this.quality = q;
    } catch {
      this.dispose();
      this.quality = 'off';
    }
    return this.quality;
  }

  /**
   * Light everything from the sky itself.
   *
   *   A hemisphere light is two colours and a lerp: it has no idea that the west is orange at six
   *   o'clock and the east is not. Pre-filtering the actual sky dome into an environment map means
   *   a white wall facing the sunset goes warm without anyone deciding that it should, and a metal
   *   roof gets a sky in it instead of a flat grey. Called when the sun moves, never per frame.
   */
  lightFromSky(skyMesh: THREE.Mesh) {
    try {
      this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileEquirectangularShader();
      // the dome rides the camera in the loop; the environment wants it honestly at the origin
      const parent = skyMesh.parent;
      const was = skyMesh.position.clone();
      skyMesh.position.set(0, 0, 0);
      const box = new THREE.Scene();
      box.add(skyMesh);
      const built = this.pmrem.fromScene(box, 0, 1, 40000);
      box.remove(skyMesh);
      skyMesh.position.copy(was);
      parent?.add(skyMesh);
      this.env?.dispose();
      this.env = built.texture;
      this.scene.environment = built.texture;
      // the sky is its own light now; the hemisphere fill that stood in for it can ease off
      return true;
    } catch {
      return false;
    }
  }

  resize() {
    this.composer?.setSize(innerWidth, innerHeight);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.gtao?.setSize(innerWidth, innerHeight);
  }

  /** the occlusion camera is the real one, with a shorter memory: same pixels, usable depth */
  private syncAoCam(ao = this.aoCam) {
    if (!ao) return;
    ao.fov = this.camera.fov;
    ao.aspect = this.camera.aspect;
    ao.near = AO_NEAR;
    ao.far = AO_FAR;
    ao.position.copy(this.camera.position);
    ao.quaternion.copy(this.camera.quaternion);
    ao.updateMatrixWorld(true);
    ao.updateProjectionMatrix();
  }

  /** try another neighbourhood size without a reload — the suite sweeps this to pick the default */
  tune(radius: number, scale: number) {
    this.gtao?.updateGtaoMaterial({ radius, scale, distanceExponent: 1, thickness: 1, samples: 16 });
  }

  /** show the occlusion on its own — 'Default' is the picture, 'Denoise' is the buffer behind it */
  setOutput(name: string) {
    const modes = this.Gtao?.OUTPUT as Record<string, number> | undefined;
    if (this.gtao && modes && name in modes) this.gtao.output = modes[name];
  }

  /**
   * Draw, and keep an eye on what it cost.
   *
   *   Two and a half seconds under twenty-six frames a second is not a stutter, it is a verdict:
   *   step down one rung and stay there. The step is one-way within a session — a chain that has
   *   proved expensive does not get to keep asking.
   */
  render(dt: number) {
    if (this.composer) {
      this.syncAoCam();
      this.composer.render(dt);
      if (dt > 0 && this.watchdog) {
        this.slow = 1 / dt < SLOW_FPS ? this.slow + dt : 0;
        if (this.slow > SLOW_FOR) {
          this.downgraded = true;
          this.slow = 0;
          // step down from what was last DECIDED, not from what is currently built: a second slow
          // frame arriving while the first step is still fetching must not decide the same step twice
          void this.set(this.target === 'full' ? 'plain' : 'off');
        }
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private dispose() {
    this.composer?.dispose();
    this.composer = null;
    this.gtao = null;
  }

  /** everything this holds on the GPU, for a test that builds a world and throws it away */
  destroy() {
    this.dispose();
    this.env?.dispose();
    this.pmrem?.dispose();
    this.env = null;
    this.pmrem = null;
    this.scene.environment = null;
  }

  state() {
    const a = this.aoCam;
    return {
      quality: this.quality, target: this.target, wanted: this.wanted,
      downgraded: this.downgraded, env: !!this.env,
      ao: a ? { near: a.near, far: a.far, fov: a.fov } : null
    };
  }
}

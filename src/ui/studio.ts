// The studio: the design editor inside the world, without leaving the page.
//
//   The builder (the forked Pascal editor) is its own app, built as static files and served
//   beside the world. This overlay opens it in an iframe and speaks the eco/1 protocol to it:
//   hello, ready, here is the SITE (the real ground, the surveyed line, the standing massing),
//   and back the other way the finished design as a GLB with its walk data. The world and the
//   builder stay two programs — data, not code, crosses this boundary.
//
//   ECO-DEVPLAN-01 §5 is the contract; the shapes in world/site.ts mirror it. If the builder is
//   not deployed yet, the overlay says so in plain words and offers the way back.

import type { EcoSite, EcoWalk } from '../world/site';

/**
 * Where the builder is deployed.
 *
 *   The intention was always same-origin — a static export of the editor with basePath `/builder`,
 *   copied in beside the world, so the iframe never crosses an origin. That export does not exist
 *   yet, and until it does `/builder/embed/` on this host is simply nothing: the overlay opened
 *   onto a blank frame and waited for an `eco:ready` that could never arrive. It looked for all
 *   the world like the builder was broken, and the builder was fine.
 *
 *   So the default is the editor's own deploy. Crossing the origin costs nothing here: the bridge
 *   already posts to '*' and trusts a message only by its source window, never by its origin.
 *   `?builder=/builder/embed/` still selects the same-origin path for whoever builds that export.
 */
export const BUILDER_URL = 'https://architect-editor-snowy.vercel.app/embed';

export interface StudioOpts {
  /** where the builder lives: BUILDER_URL by default, or ?builder=<url> to point somewhere else */
  url: string;
  community: string;
  /** the site to send once the builder says ready */
  site: () => EcoSite | null;
  /** a finished design arrived: raw GLB bytes (extras.walk inside), and where its origin sits */
  onGlb: (glb: Uint8Array, walk: EcoWalk | null, originLL: [number, number]) => void;
  onClose?: () => void;
}

interface StudioState {
  open: boolean; ready: boolean; caps: string[];
  siteSent: { w: number; h: number; guides: number } | null;
  notice: string | null;
}

const HELLO_TRIES = 20, HELLO_EVERY = 500;

export class Studio {
  private root: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private ready = false;
  private caps: string[] = [];
  private siteSent: StudioState['siteSent'] = null;
  private notice: string | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private listener = (e: MessageEvent) => {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    this.handle(m as Record<string, unknown>);
  };

  constructor(private opts: StudioOpts) {}

  state(): StudioState {
    return { open: !!this.root, ready: this.ready, caps: this.caps, siteSent: this.siteSent, notice: this.notice };
  }

  open() {
    if (this.root) return;
    this.ready = false; this.caps = []; this.siteSent = null;
    const el = document.createElement('div');
    el.className = 'studio';
    el.innerHTML = `
      <div class="st-bar">
        <span class="st-brand"><span class="mark">◈</span> the studio · ${this.opts.community}</span>
        <span class="st-note" data-el="st-note">waiting for the studio…</span>
        <button class="btn" data-act="st-back">⟵ back to the world</button>
      </div>
      <iframe class="st-frame" title="the design studio" allow="fullscreen"></iframe>`;
    document.body.appendChild(el);
    this.root = el;
    this.noticeEl = el.querySelector('[data-el="st-note"]');
    (el.querySelector('[data-act="st-back"]') as HTMLElement).addEventListener('click', () => this.close());
    document.exitPointerLock?.();
    window.addEventListener('message', this.listener);
    const frame = el.querySelector('.st-frame') as HTMLIFrameElement;
    this.iframe = frame;
    frame.src = this.opts.url;
    // knock until the builder answers, then stop; if it never does, say so and stay useful
    let tries = 0;
    this.helloTimer = setInterval(() => {
      if (this.ready || !this.iframe) { this.stopHello(); return; }
      if (++tries > HELLO_TRIES) {
        this.stopHello();
        this.say('the studio did not answer — it may not be deployed yet. ⟵ takes you back.');
        return;
      }
      try { this.iframe.contentWindow?.postMessage({ t: 'eco:hello', v: 'eco/1' }, '*'); } catch { /* not up yet */ }
    }, HELLO_EVERY);
  }

  close() {
    this.stopHello();
    window.removeEventListener('message', this.listener);
    this.root?.remove();
    this.root = null; this.iframe = null; this.noticeEl = null;
    this.ready = false;
    this.opts.onClose?.();
  }

  /** ask the builder for its current design (it answers with eco:glb) */
  requestExport() { this.post({ t: 'eco:request-export', what: 'glb' }); }

  /**
   * One message from the builder. Public so the suite can drive the protocol without a second
   * real editor — a test hook, exactly like window.world.
   */
  handle(m: Record<string, unknown>) {
    switch (m.t) {
      case 'eco:ready': {
        if (this.ready) return;
        this.ready = true;
        this.stopHello();
        this.caps = Array.isArray(m.caps) ? (m.caps as string[]) : [];
        const site = this.opts.site();
        if (site) {
          this.post({ t: 'eco:load-site', site });
          this.siteSent = { w: site.terrain.w, h: site.terrain.h, guides: site.guides.length };
          this.say(null);
        } else this.say('no site to send — the pack has not loaded');
        return;
      }
      case 'eco:glb': {
        const b64 = typeof m.glb === 'string' ? m.glb : '';
        let bytes: Uint8Array | null = null;
        try {
          const bin = atob(b64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch { this.say('the design could not be read'); return; }
        const walk = (m.walk && typeof m.walk === 'object' ? m.walk : null) as EcoWalk | null;
        const o = Array.isArray(m.originLL) && m.originLL.length === 2
          ? [Number(m.originLL[0]), Number(m.originLL[1])] as [number, number] : null;
        const site = this.opts.site();
        this.opts.onGlb(bytes, walk, o ?? (site ? site.originLL : [0, 0]));
        this.say('design placed in the world — ⟵ to go walk it');
        return;
      }
      case 'eco:dirty': return;                       // noted, nothing to do yet
      case 'eco:close': this.close(); return;
      case 'eco:error': this.say(String((m as { message?: unknown }).message ?? 'the studio reported an error')); return;
    }
  }

  private post(m: unknown) { try { this.iframe?.contentWindow?.postMessage(m, '*'); } catch { /* gone */ } }
  private stopHello() { if (this.helloTimer) { clearInterval(this.helloTimer); this.helloTimer = null; } }
  private say(t: string | null) {
    this.notice = t;
    if (this.noticeEl) { this.noticeEl.hidden = !t; this.noticeEl.textContent = t ?? ''; }
  }
}

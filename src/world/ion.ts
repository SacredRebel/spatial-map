// The imagery beyond the parcel, from Cesium ion.
//
//   The ground you walk on wears the county's own aerial, draped by the pack. Past the parcel the pack
//   has nothing, and the middle distance and the far ridges wore colour by slope — right in shape,
//   wrong in everything else. ion holds real imagery for the whole planet behind one token: Google's
//   own satellite (the same pixels as Google Earth) and Bing's aerial among them.
//
//   An ion asset does not have a URL. It has an ENDPOINT that hands out a short-lived way in, and what
//   that looks like depends on who owns the pixels:
//     GOOGLE_2D_MAPS — a Google Map Tiles session: tiles at {url}v1/2dtiles/{z}/{x}/{y}?session&key
//     BING           — a Bing key: Bing's own metadata service says where the tiles are, by quadkey
//   Anything else is refused by name rather than guessed at.
//
//   Whoever owns the pixels must be credited on screen while they are shown. That is not a courtesy;
//   it is the condition the imagery is served on. So a source never comes back without its credits,
//   and Google's per-view copyright ("Imagery ©2026 …") can be asked for the ground actually in view.
//
//   The token is meant to be public — the browser has to ask for the tiles itself — and is protected
//   by its scope (read assets) and by the domains it is restricted to on ion, not by being hidden.
//   docs/context-ring.md says why, and says what a token with write scopes must never be used for.

export type IonKind = 'google2d' | 'bing';

export interface IonImagery {
  asset: number;
  kind: IonKind;
  /** the URL of one tile, in the usual slippy-map numbering */
  url: (z: number, x: number, y: number) => string;
  maxzoom: number;
  /** what must be on screen while these pixels are, as the provider gave it (HTML, sanitised on display) */
  credits: string[];
  /** Google only: the copyright for the ground in view, which Google requires be displayed */
  viewportCopyright?: (box: [number, number, number, number], zoom: number) => Promise<string | null>;
}

/** what the last resolve tried and why each step went the way it did — for the tests and for a person reading the console */
export interface IonTrace { asset: number; ok: boolean; kind?: string; why?: string }

/** Google's satellite first, Bing's aerial if Google is not available to this token */
export const ION_IMAGERY = [3830182, 2];

async function json(url: string): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const r = await fetch(url);
    let body: any = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null };
  }
}

const creditsOf = (j: any): string[] =>
  Array.isArray(j?.attributions) ? j.attributions.map((a: any) => String(a?.html ?? '')).filter(Boolean) : [];

/** Bing numbers its tiles by quadkey: one digit per zoom level, the quadrant at that level */
export function quadkey(z: number, x: number, y: number): string {
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return q;
}

async function google(asset: number, j: any): Promise<IonImagery | string> {
  const o = j?.options || {};
  if (!o.session || !o.key) return 'the endpoint gave no Google session or key';
  const base = String(o.url || 'https://tile.googleapis.com/').replace(/\/?$/, '/');
  const q = `session=${encodeURIComponent(o.session)}&key=${encodeURIComponent(o.key)}`;
  return {
    asset, kind: 'google2d', maxzoom: 20, credits: creditsOf(j),
    url: (z, x, y) => `${base}v1/2dtiles/${z}/${x}/${y}?${q}`,
    viewportCopyright: async ([w, s, e, n], zoom) => {
      const v = await json(`${base}tile/v1/viewport?${q}&zoom=${zoom}&north=${n}&south=${s}&east=${e}&west=${w}`);
      return v.ok && typeof v.body?.copyright === 'string' && v.body.copyright.trim() ? v.body.copyright.trim() : null;
    }
  };
}

async function bing(asset: number, j: any): Promise<IonImagery | string> {
  const o = j?.options || {};
  if (!o.key) return 'the endpoint gave no Bing key';
  const base = String(o.url || 'https://dev.virtualearth.net').replace(/\/$/, '');
  const style = encodeURIComponent(o.mapStyle || 'Aerial');
  const m = await json(`${base}/REST/v1/Imagery/Metadata/${style}?incl=ImageryProviders&key=${encodeURIComponent(o.key)}&uriScheme=https`);
  const res = m.body?.resourceSets?.[0]?.resources?.[0];
  if (!m.ok || !res?.imageUrl) return `Bing's metadata did not answer (${m.status})`;
  const subs: string[] = Array.isArray(res.imageUrlSubdomains) && res.imageUrlSubdomains.length ? res.imageUrlSubdomains : [''];
  const template = String(res.imageUrl).replace('{culture}', 'en-US');
  const credits = creditsOf(j);
  if (typeof m.body?.brandLogoUri === 'string' && /^https:\/\//.test(m.body.brandLogoUri)) credits.push(`<img src="${m.body.brandLogoUri}" alt="Bing">`);
  return {
    asset, kind: 'bing', maxzoom: Math.min(Number(res.zoomMax) || 19, 20), credits,
    url: (z, x, y) => template.replace('{subdomain}', subs[(x + y) % subs.length]).replace('{quadkey}', quadkey(z, x, y))
  };
}

/**
 * The first of `assets` this token can actually show. Null when there is no token, or none of them
 * answered — and `trace` says which step failed for each, so "no imagery" is never a mystery.
 */
export async function resolveIonImagery(base: string, token: string, assets: number[] = ION_IMAGERY, trace: IonTrace[] = []): Promise<IonImagery | null> {
  if (!token) return null;
  const root = base.replace(/\/$/, '');
  for (const asset of assets) {
    const r = await json(`${root}/v1/assets/${asset}/endpoint?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) { trace.push({ asset, ok: false, why: `endpoint answered ${r.status}` }); continue; }
    const kind = r.body?.externalType;
    const got = kind === 'GOOGLE_2D_MAPS' ? await google(asset, r.body)
      : kind === 'BING' ? await bing(asset, r.body)
      : `an imagery kind this world does not draw (${kind ?? r.body?.type ?? 'unknown'})`;
    if (typeof got === 'string') { trace.push({ asset, ok: false, kind, why: got }); continue; }
    trace.push({ asset, ok: true, kind });
    return got;
  }
  return null;
}

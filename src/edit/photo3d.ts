// A photo, or a sketch, made into a model — by the atlas, which holds the key to a 3D service.
//
//   The key never comes here. The world sends the atlas a small JPEG and a PIN; the atlas starts the
//   job with whichever service it has a key for (Meshy today), and the world asks after it every few
//   seconds. When it is done, the model is fetched through the atlas in pieces — the service's own
//   links do not allow a browser to read them, and one response from the atlas may not be larger
//   than a few megabytes — and then kept in this browser like any file brought in.
//
//   Photos from a phone are large (a 12 MP HEIC or JPEG is several megabytes); the service wants
//   one clear view of one thing, not the megapixels. So the photo is shrunk here to 1280 px on its
//   long side before it leaves.

export type Photo3DKind = 'object' | 'building';

export interface JobStatus {
  status: 'pending' | 'running' | 'done' | 'failed';
  progress: number;
  bytes?: number;
  thumb?: string | null;
  error?: string | null;
}

/** a photo file as a JPEG data URL no larger than `max` pixels on its long side */
export async function photoToJpeg(file: Blob, max = 1280): Promise<string> {
  let bmp: ImageBitmap | HTMLImageElement;
  try { bmp = await createImageBitmap(file); }
  catch {
    // Safari opens HEIC through an <img>; others cannot open it at all
    bmp = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('this photo cannot be opened here — save it as a JPEG and try again'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = (bmp as { width: number }).width, h = (bmp as { height: number }).height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

export class Photo3D {
  constructor(private atlas: string, private pin: () => string | null) {}

  /** the services the atlas can use, or [] when it has none (or cannot be reached) */
  async providers(): Promise<string[]> {
    try {
      const r = await fetch(`${this.atlas}/api/image3d/config`);
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j?.providers) ? j.providers : [];
    } catch { return []; }
  }

  private async post(path: string, body: object): Promise<Response> {
    const pin = this.pin();
    if (!pin) throw new Error('making a model spends credits, so it needs your atlas PIN — sign in first');
    return fetch(`${this.atlas}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, pin }) });
  }

  private async json(r: Response): Promise<Record<string, unknown>> {
    let j: Record<string, unknown> = {};
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || j.ok === false) {
      const e = String(j.error || r.status);
      throw new Error(e === 'bad_pin' ? 'the atlas does not know that PIN'
        : e === 'no_3d_key' ? 'the atlas has no 3D service key yet (MESHY_API_KEY in its settings)'
        : e === 'not_configured' ? 'the atlas has no PINs set up yet'
        : String(j.message || `the atlas said ${e}`));
    }
    return j;
  }

  async start(image: string, kind: Photo3DKind, name: string): Promise<{ provider: string; task: string }> {
    const j = await this.json(await this.post('/api/image3d', { image, kind, name }));
    return { provider: String(j.provider), task: String(j.task) };
  }

  async status(provider: string, task: string): Promise<JobStatus> {
    const j = await this.json(await this.post('/api/image3d/status', { provider, task }));
    return {
      status: (['pending', 'running', 'done', 'failed'].includes(String(j.status)) ? j.status : 'running') as JobStatus['status'],
      progress: Number(j.progress) || 0,
      bytes: Number(j.bytes) || undefined,
      thumb: (j.thumb as string) || null,
      error: (j.error as string) || null
    };
  }

  /** the finished model, fetched in pieces through the atlas */
  async download(provider: string, task: string, bytes: number, onProgress?: (share: number) => void): Promise<Blob> {
    const PART = 3_000_000;
    const parts: ArrayBuffer[] = [];
    for (let from = 0; from < bytes; from += PART) {
      const to = Math.min(bytes, from + PART) - 1;
      const r = await this.post('/api/image3d/part', { provider, task, from, to });
      if (!r.ok) await this.json(r);
      const buf = await r.arrayBuffer();
      if (buf.byteLength !== to - from + 1) throw new Error('the model arrived broken — try again');
      parts.push(buf);
      onProgress?.(Math.min(1, (to + 1) / bytes));
    }
    return new Blob(parts, { type: 'model/gltf-binary' });
  }
}

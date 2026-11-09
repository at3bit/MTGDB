// Scan diagnostics: the photos the app captured during a run and what it read
// from each, packed into a zip the user can share (e.g. to Google Drive) when
// a scan comes out wrong. Everything stays on the phone until shared.
import { zipSync, strToU8 } from 'fflate';
import type { CardDB } from '../core/carddb.ts';
import type { Calibration } from '../core/geometry.ts';
import type { WirePocket } from './protocol.ts';
import type { SentFrames } from './run.ts';

/** Photos are kept at up to this width (JPEG, ~1 MB each)… */
const MAX_WIDTH = 2560;
/** …and only the most recent this many. */
const MAX_FRAMES = 30;

declare const __BUILD__: string;

interface Frame {
  name: string;
  blob: Promise<Blob | null>;
  time: number;
  focus: number[];
  manual: boolean;
  brief: boolean;
}

class Diagnostics {
  private frames: Frame[] = [];
  private readings: unknown[] = [];
  private info: Record<string, unknown> = {};
  private seq = 0;

  /** A new run: forget the previous one. */
  startRun(info: Record<string, unknown>) {
    this.frames = [];
    this.readings = [];
    this.seq = 0;
    this.info = {
      ...info,
      build: typeof __BUILD__ === 'string' ? __BUILD__ : 'dev',
      started: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    };
  }

  get hasRun() {
    return this.seq > 0 || this.readings.length > 0;
  }

  /** Keeps a JPEG copy of each frame of a capture (canvases are copied synchronously; they get reused). */
  addFrames(f: SentFrames) {
    this.seq++;
    f.canvases.forEach((src, i) => {
      const scale = Math.min(1, MAX_WIDTH / src.width);
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(src, 0, 0, c.width, c.height);
      const blob = new Promise<Blob | null>((resolve) =>
        c.toBlob((b) => {
          c.width = c.height = 0; // free the canvas right away (iOS caps canvas memory)
          resolve(b);
        }, 'image/jpeg', 0.85),
      );
      const kind = f.manual ? 'snap' : f.brief ? 'quick' : 'auto';
      this.frames.push({ name: `frames/${String(this.seq).padStart(3, '0')}-${f.time.toFixed(2)}s-${kind}-${i}.jpg`, blob, time: f.time, focus: f.focus, manual: f.manual, brief: f.brief });
    });
    while (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  /** What was read from a capture. */
  addReading(r: { pockets: WirePocket[]; time: number; change?: number; manual?: boolean; retried?: number[]; ms?: number; calibration?: Calibration }, db: CardDB) {
    this.readings.push({
      capture: this.seq,
      time: r.time,
      change: Number.isFinite(r.change) ? r.change : null,
      manual: !!r.manual,
      ms: r.ms,
      retried: r.retried,
      foundPages: r.calibration?.pages,
      pockets: r.pockets.map((p) => ({
        page: p.page,
        slot: p.slot,
        status: p.status,
        blurry: !!p.blurry,
        cardBack: !!p.cardBack,
        sharpness: round(p.sharpness),
        contrast: round(p.contrast),
        glare: round(p.glare),
        matches: p.matches.slice(0, 3).map((m) => ({ id: db.info(m.card).id, name: db.info(m.card).name, set: db.info(m.card).set, d: m.d })),
        otherNameDistance: p.otherNameDistance,
      })),
    });
  }

  note(key: string, value: unknown) {
    this.info[key] = value;
  }

  /** The zip: manifest.json plus the kept photos. */
  async export(): Promise<File> {
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    const kept: unknown[] = [];
    for (const f of this.frames) {
      const blob = await f.blob;
      if (!blob) continue;
      files[f.name] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      kept.push({ file: f.name, time: f.time, focus: f.focus.map(round), manual: f.manual, brief: f.brief });
    }
    const manifest = { info: this.info, frames: kept, readings: this.readings };
    files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 1));
    const zip = zipSync(files);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    return new File([zip.buffer as ArrayBuffer], `mtgdb-scan-${stamp}.zip`, { type: 'application/zip' });
  }
}

const round = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

export const diagnostics = new Diagnostics();

/** Shares the diagnostics zip (share sheet on a phone; a download elsewhere). */
export async function shareDiagnostics(): Promise<void> {
  const file = await diagnostics.export();
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'MTGDB scan diagnostics' });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

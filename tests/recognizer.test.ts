// The recognizer worker can die (iOS reclaims memory) or hang; a run must not wait on it forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recognizer } from '../src/app/data.ts';
import type { CardDB } from '../src/core/carddb.ts';
import type { Calibration } from '../src/core/geometry.ts';

class FakeWorker extends EventTarget {
  static all: FakeWorker[] = [];
  terminated = false;
  jobs: number[] = [];
  constructor() {
    super();
    FakeWorker.all.push(this);
  }
  postMessage(msg: { type: string; job?: number }) {
    if (msg.type === 'init') this.emit({ type: 'ready' });
    if (msg.type === 'spread') this.jobs.push(msg.job!);
  }
  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  crash() {
    this.dispatchEvent(Object.assign(new Event('error'), { message: 'out of memory' }));
  }
  terminate() {
    this.terminated = true;
  }
}

const db = { fps: new Uint32Array(5), count: 1, nameOf: new Int32Array(1) } as unknown as CardDB;
const cal = { pages: [], rows: 3, cols: 3 } as unknown as Calibration;
const frame = () => ({ width: 1, height: 1, buffer: new ArrayBuffer(4) });
const answer = (job: number) => ({ type: 'spread', job, pockets: [], ms: 1, calibration: cal, retried: [] });

describe('recognizer worker', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fails the jobs of a crashed worker and carries on with a new one', async () => {
    const rec = new Recognizer(db);
    const job = rec.recognize([frame()], cal, 1);
    await Promise.resolve();
    const first = FakeWorker.all[0];
    first.crash();
    await expect(job).rejects.toThrow(/crashed/);
    expect(rec.inFlight).toBe(0);
    expect(first.terminated).toBe(true);
    expect(FakeWorker.all).toHaveLength(2);
    const next = rec.recognize([frame()], cal, 1);
    await Promise.resolve();
    const second = FakeWorker.all[1];
    second.emit(answer(second.jobs[0]));
    await expect(next).resolves.toMatchObject({ pockets: [] });
    expect(rec.inFlight).toBe(0);
  });

  it('gives up on a job the worker never answers', async () => {
    vi.useFakeTimers();
    const rec = new Recognizer(db);
    const job = rec.recognize([frame()], cal, 1);
    const failed = expect(job).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(91_000);
    await failed;
    expect(rec.inFlight).toBe(0);
    expect(FakeWorker.all).toHaveLength(2);
  });
});

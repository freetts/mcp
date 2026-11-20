// Transcriptions that take longer than one tool call may wait.
//
// ChatGPT and other hosts give a tool call about a minute. FreeTTS speech to text
// needs about 0.55 s per minute of audio (measured 2026-11-20: 60 min 33 s,
// 120 min 60 s, 240 min 131 s), plus the download. So every transcription runs as
// a job: transcribe_audio waits up to WAIT_MS and answers with the transcript, or,
// for a long recording, with a job id that get_transcript collects later.
//
// A job belongs to the key that started it (a hash of the key, never the key).
// Results are kept in memory, and written to STATE_DIR/stt only when the caller
// was handed a job id, so a restart in between does not lose a finished
// transcript. Everything is deleted after JOB_KEEP_MS.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.js";

export const JOB_KEEP_MS = 24 * 60 * 60 * 1000;
/** How long one tool call waits for a transcription before handing out a job id. */
export const WAIT_MS = Number(process.env.STT_WAIT_MS || 40_000);
/** Transcriptions one key may run at once, and the whole server. */
export const PER_OWNER = 3;
export const PER_SERVER = 10;

export type JobDone<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Job<T> {
  id: string; owner: string; started: number; audioSeconds: number | null;
  promise: Promise<JobDone<T>>; done?: JobDone<T>; handedOut?: boolean; finishedAt?: number;
}

const DIR = join(CONFIG.stateDir, "stt");
const jobs = new Map<string, Job<unknown>>();

/** Who a job belongs to: a hash of the API key, so the key itself is never kept here. */
export const ownerOf = (apiKey: string) => createHash("sha256").update("ftmcp-job:" + apiKey).digest("hex").slice(0, 32);

export const running = (owner?: string) => [...jobs.values()].filter((j) => !j.done && (!owner || j.owner === owner)).length;

/** Starts the work at once and returns the job. The work's errors become plain text through errText. */
export function startJob<T>(owner: string, audioSeconds: number | null, work: () => Promise<T>, errText: (e: unknown) => string): Job<T> {
  const job: Job<T> = { id: randomUUID(), owner, started: Date.now(), audioSeconds, promise: undefined as unknown as Promise<JobDone<T>> };
  job.promise = work().then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: errText(e) })).then(async (d) => {
    job.done = d; job.finishedAt = Date.now();
    if (job.handedOut) await persist(job).catch(() => {});
    return d;
  });
  jobs.set(job.id, job as Job<unknown>);
  return job;
}

/** The result if it arrives within ms, else null (the job keeps running). */
export async function waitFor<T>(job: Job<T>, ms: number): Promise<JobDone<T> | null> {
  if (job.done) return job.done;
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((res) => { t = setTimeout(() => res(null), ms); });
  try { return await Promise.race([job.promise, timeout]); } finally { clearTimeout(t); }
}

/** Drops a job that was answered in the same call: its transcript is not kept. */
export function forget(job: Job<unknown>): void { jobs.delete(job.id); }

/** Marks a job as handed to the caller by id, so its result is kept on disk when it lands. */
export function handOut(job: Job<unknown>): void {
  job.handedOut = true;
  if (job.done) void persist(job).catch(() => {});
}

async function persist(job: Job<unknown>): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${job.id}.json`), JSON.stringify({ owner: job.owner, started: job.started, audioSeconds: job.audioSeconds, done: job.done, finishedAt: job.finishedAt }));
}

/** A job by id for this owner: the live one, or a finished one from disk. "other" when it belongs to another key. */
export async function findJob(id: string, owner: string): Promise<Job<unknown> | "other" | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const live = jobs.get(id);
  if (live) return live.owner === owner ? live : "other";
  try {
    const j = JSON.parse(await readFile(join(DIR, `${id}.json`), "utf8"));
    if (j.owner !== owner) return "other";
    const done = j.done as JobDone<unknown> | undefined;
    if (!done) return null;
    return { id, owner, started: j.started, audioSeconds: j.audioSeconds ?? null, done, finishedAt: j.finishedAt, handedOut: true, promise: Promise.resolve(done) };
  } catch { return null; }
}

/** Seconds a recording of this length usually takes, from the 2026-11-20 measurements, with room for the download. */
export const expectedSeconds = (audioSeconds: number | null) => (audioSeconds ? Math.round(8 + (audioSeconds / 60) * 0.6) : null);

/** Finished jobs and their files go after JOB_KEEP_MS; a job still running after two hours is dropped from memory. */
export function startJobReaper(): void {
  const sweep = async () => {
    const now = Date.now();
    for (const [id, j] of jobs) if ((j.finishedAt && now - j.finishedAt > JOB_KEEP_MS) || (!j.done && now - j.started > 2 * 3600_000)) jobs.delete(id);
    try {
      for (const f of await readdir(DIR)) {
        const s = await stat(join(DIR, f)).catch(() => null);
        if (s && now - s.mtimeMs > JOB_KEEP_MS) await unlink(join(DIR, f)).catch(() => {});
      }
    } catch { /* folder not made yet */ }
  };
  setInterval(sweep, 10 * 60_000).unref();
  void sweep();
}

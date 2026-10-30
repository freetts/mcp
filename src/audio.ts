// Free audio for callers without an account: the spoken FreeTTS watermark is
// added, the file is kept under mcp.freetts.org/audio/ for one hour, then removed.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";

const AUDIO_DIR = join(CONFIG.stateDir, "audio");

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, { timeout: 120_000 }, (err, _o, stderr) => (err ? rej(new Error(String(stderr || err).slice(-400))) : res())));
}

/** Append the watermark and store the result. Returns the public id. */
export async function watermarkAndStore(mp3: Buffer): Promise<string> {
  const id = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "ftmcp-"));
  try {
    const src = join(dir, "in.mp3");
    await writeFile(src, mp3);
    const out = join(AUDIO_DIR, `${id}.mp3`);
    await run(CONFIG.ffmpeg, ["-y", "-v", "error", "-i", src, "-i", CONFIG.watermarkPath,
      "-filter_complex", "[0:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[a];[1:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]",
      "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "4", out]);
    return id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const storedPath = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? join(AUDIO_DIR, `${id}.mp3`) : null);
export const publicAudioUrl = (id: string) => `${CONFIG.publicUrl}/audio/${id}.mp3`;

/** Seconds of an MP3, from ffprobe-free arithmetic: ffmpeg prints it; cheaper to read the header via ffmpeg -f null. */
export async function durationSeconds(path: string): Promise<number | null> {
  return new Promise((res) => execFile(CONFIG.ffmpeg, ["-v", "info", "-i", path, "-f", "null", "-"], { timeout: 60_000 }, (_e, _o, stderr) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/g;
    let last: RegExpExecArray | null = null, x: RegExpExecArray | null;
    while ((x = m.exec(String(stderr)))) last = x;
    res(last ? +last[1] * 3600 + +last[2] * 60 + parseFloat(last[3]) : null);
  }));
}

/** Files older than the free retention are removed once a minute. */
export function startAudioReaper(): void {
  startInputReaper();
  const sweep = async () => {
    try {
      for (const f of await readdir(AUDIO_DIR)) {
        const p = join(AUDIO_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > CONFIG.anon.keepMs) await unlink(p).catch(() => {});
      }
    } catch { /* next sweep */ }
  };
  setInterval(sweep, 60_000).unref();
  void sweep();
}

/** The real shape of the audio for the in-chat player: `bars` loudness values
 * (0.06 to 1) and the length in seconds, measured with ffmpeg. Null when the
 * file cannot be read in time; the player then draws an even line. */
export async function waveform(mp3: Buffer, bars = 72): Promise<{ peaks: number[]; seconds: number } | null> {
  const RATE = 4000;
  const dir = await mkdtemp(join(tmpdir(), "ftwav-"));
  try {
    const src = join(dir, "in.mp3");
    await writeFile(src, mp3);
    const pcm: Buffer = await new Promise((res, rej) => execFile(CONFIG.ffmpeg,
      ["-v", "error", "-i", src, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
      { timeout: 8_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (err, out) => (err ? rej(err) : res(out as Buffer))));
    const n = Math.floor(pcm.length / 2);
    if (n < bars) return null;
    const per = Math.floor(n / bars);
    const rms: number[] = [];
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      for (let i = b * per; i < (b + 1) * per; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
      rms.push(Math.sqrt(sum / per));
    }
    const top = Math.max(...rms) || 1;
    const peaks = rms.map((v) => Math.round(Math.max(0.06, Math.sqrt(v / top)) * 100) / 100);
    return { peaks, seconds: Math.round((n / RATE) * 10) / 10 };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const requestHash = (parts: string[]) => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);

// ── what each audio was made from ──────────────────────────────────────────
// The in-chat player offers other voices for the same words. Some hosts hand
// the player the result but not the text, so the words behind every audio id
// are kept here for a day: one small JSON file per id under <state>/inputs.
export interface AudioInput { text: string; speed?: number; format?: string; at: number }
const INPUT_DIR = join(CONFIG.stateDir, "inputs");
const INPUT_KEEP_MS = 24 * 3600 * 1000;
const inputs = new Map<string, AudioInput>();
const idOf = (s: string) => (String(s || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [""])[0].toLowerCase();

export async function rememberInput(urlOrId: string, input: Omit<AudioInput, "at">): Promise<void> {
  const id = idOf(urlOrId);
  if (!id) return;
  const rec: AudioInput = { ...input, at: Date.now() };
  inputs.set(id, rec);
  try { await mkdir(INPUT_DIR, { recursive: true }); await writeFile(join(INPUT_DIR, `${id}.json`), JSON.stringify(rec)); } catch { /* memory copy still serves */ }
}

/** The words behind an audio link or id made in the last day, or null. */
export async function recallInput(urlOrId: string): Promise<AudioInput | null> {
  const id = idOf(urlOrId);
  if (!id) return null;
  const hit = inputs.get(id);
  if (hit) return Date.now() - hit.at <= INPUT_KEEP_MS ? hit : null;
  try {
    const rec = JSON.parse(await readFile(join(INPUT_DIR, `${id}.json`), "utf8")) as AudioInput;
    if (!rec || typeof rec.text !== "string" || Date.now() - rec.at > INPUT_KEEP_MS) return null;
    inputs.set(id, rec);
    return rec;
  } catch { return null; }
}

/** Inputs older than a day are dropped hourly (memory and files). */
export function startInputReaper(): void {
  const sweep = async () => {
    const cut = Date.now() - INPUT_KEEP_MS;
    for (const [k, v] of inputs) if (v.at < cut) inputs.delete(k);
    try {
      for (const f of await readdir(INPUT_DIR)) {
        const p = join(INPUT_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && s.mtimeMs < cut) await unlink(p).catch(() => {});
      }
    } catch { /* no dir yet */ }
  };
  setInterval(sweep, 3_600_000).unref();
  void sweep();
}

export { readFile };

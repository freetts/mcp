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

// ── A ZIP of many clips (batch_text_to_speech, 1.3.0) ─────────────────────
// Kept a day at mcp.freetts.org/audio/<id>.zip. The clips themselves stay on
// freetts.org for 30 days; the ZIP is one download for all of them.
export const ZIP_KEEP_MS = 24 * 60 * 60 * 1000;
export const storedZipPath = (id: string) => (/^[0-9a-f-]{36}$/.test(id) ? join(AUDIO_DIR, `${id}.zip`) : null);
export const publicZipUrl = (id: string) => `${CONFIG.publicUrl}/audio/${id}.zip`;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP of the files, stored without compression (MP3 and WAV do not shrink). UTF-8 names. */
export function zipFiles(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = [];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** Store a ZIP of the files; returns its public id. */
export async function storeZip(files: { name: string; data: Buffer }[]): Promise<string> {
  const id = randomUUID();
  await mkdir(AUDIO_DIR, { recursive: true });
  await writeFile(join(AUDIO_DIR, `${id}.zip`), zipFiles(files));
  return id;
}

/** Seconds of an MP3, from ffprobe-free arithmetic: ffmpeg prints it; cheaper to read the header via ffmpeg -f null. */
export async function durationSeconds(path: string): Promise<number | null> {
  return new Promise((res) => execFile(CONFIG.ffmpeg, ["-v", "info", "-i", path, "-f", "null", "-"], { timeout: 60_000 }, (_e, _o, stderr) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/g;
    let last: RegExpExecArray | null = null, x: RegExpExecArray | null;
    while ((x = m.exec(String(stderr)))) last = x;
    res(last ? +last[1] * 3600 + +last[2] * 60 + parseFloat(last[3]) : null);
  }));
}

// ── Transcripts and subtitles (transcribe_audio, 1.4.0) ────────────────────
// The full text of a long transcript, and SRT or WebVTT subtitles, kept a day at
// mcp.freetts.org/transcripts/<id>.<ext> so the person can download them.
export const TEXT_KEEP_MS = 24 * 60 * 60 * 1000;
const TEXT_DIR = join(CONFIG.stateDir, "transcripts");
export const TEXT_TYPES = { txt: "text/plain; charset=utf-8", srt: "application/x-subrip; charset=utf-8", vtt: "text/vtt; charset=utf-8" } as const;
export type TextExt = keyof typeof TEXT_TYPES;
export async function storeText(ext: TextExt, body: string): Promise<string> {
  const id = randomUUID();
  await mkdir(TEXT_DIR, { recursive: true });
  await writeFile(join(TEXT_DIR, `${id}.${ext}`), body, "utf8");
  return id;
}
export const storedTextPath = (id: string, ext: string) => (/^[0-9a-f-]{36}$/.test(id) && ext in TEXT_TYPES ? join(TEXT_DIR, `${id}.${ext}`) : null);
export const publicTextUrl = (id: string, ext: TextExt) => `${CONFIG.publicUrl}/transcripts/${id}.${ext}`;

/** Files older than their retention are removed once a minute. */
export function startAudioReaper(): void {
  startInputReaper();
  const sweep = async () => {
    try {
      for (const f of await readdir(AUDIO_DIR)) {
        const p = join(AUDIO_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > (f.endsWith(".zip") ? ZIP_KEEP_MS : CONFIG.anon.keepMs)) await unlink(p).catch(() => {});
      }
    } catch { /* next sweep */ }
    try {
      for (const f of await readdir(TEXT_DIR)) {
        const p = join(TEXT_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && Date.now() - s.mtimeMs > TEXT_KEEP_MS) await unlink(p).catch(() => {});
      }
    } catch { /* folder not made yet */ }
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

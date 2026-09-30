// Free audio for callers without an account: the spoken FreeTTS watermark is
// added, the file is kept under mcp.freetts.org/audio/ for one hour, then removed.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir, stat, unlink } from "node:fs/promises";
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

export const requestHash = (parts: string[]) => createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);

export { readFile };

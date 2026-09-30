// The FreeTTS API, as the server sees it (loopback to FastAPI on the same
// machine). Every call carries the caller's own key, or the service key for
// callers without an account. Nothing here bypasses a limit: the API's own
// rate limits, safety screen and plan gates run on every request.
import { CONFIG } from "./config.js";

export interface Voice {
  ShortName: string; Gender: string; Locale: string; LocaleName?: string; FriendlyName?: string;
  Source?: string; Tier?: string; RequiresPro?: boolean; StyleList?: string[];
  VoiceTag?: { ContentCategories?: string[]; VoicePersonalities?: string[] };
}

export class ApiError extends Error {
  status: number; detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : (detail as { error?: string })?.error || `FreeTTS API ${status}`);
    this.status = status; this.detail = detail;
  }
}

async function call<T>(path: string, init: RequestInit & { apiKey?: string; ip?: string; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-freetts-source": "mcp", ...(init.headers as Record<string, string> || {}) };
  if (init.apiKey) headers["x-api-key"] = init.apiKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000);
  try {
    const r = await fetch(CONFIG.apiUrl + path, { ...init, headers, signal: ctrl.signal });
    const text = await r.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new ApiError(r.status, (data as { detail?: unknown })?.detail ?? data);
    return data as T;
  } finally { clearTimeout(t); }
}

// ── Voices (cached ten minutes) ──────────────────────────────────────────
let voiceCache: { at: number; list: Voice[] } | null = null;
export async function voices(): Promise<Voice[]> {
  if (voiceCache && Date.now() - voiceCache.at < 600_000) return voiceCache.list;
  const list = await call<Voice[]>("/api/voices", { timeoutMs: 30_000 });
  voiceCache = { at: Date.now(), list };
  return list;
}
export const isFreeVoice = (v: Voice) => v.RequiresPro === false;
export const tierLabel = (v: Voice) => {
  const t = (v.Tier || "").toLowerCase();
  if (t === "signature") return "Signature";
  if (t.startsWith("hd")) return "HD";
  if (t === "ultra") return "Ultra";
  if (t === "multilingual" || t === "turbo") return "Standard (multilingual)";
  return "Standard";
};

// ── Text to speech, one voice ────────────────────────────────────────────
export interface TtsResult { file_id: string; format: string; audio_url: string; voice: string; downgraded?: boolean; watermark?: string; chars_used?: number; chars_limit?: number }
export function tts(apiKey: string, body: { text: string; voice: string; output_format?: string; rate?: string; pitch?: string; style?: string }): Promise<TtsResult> {
  return call<TtsResult>("/api/v1/tts", { method: "POST", apiKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// ── Usage for a key ──────────────────────────────────────────────────────
export interface Usage {
  plan: string; plan_type: string | null; per_request_chars: number; requests_per_minute: number;
  monthly_chars_limit: number; monthly_chars_used: number; monthly_chars_left: number; monthly_reset_date: string | null;
  hd_voices: boolean; watermark: boolean; audio_kept: string; daily_chars_limit?: number; daily_chars_used?: number; daily_chars_left?: number;
}
export function usage(apiKey: string): Promise<Usage> {
  return call<Usage>("/api/v1/usage", { apiKey, timeoutMs: 20_000 });
}

// ── Several voices: the Studio's dialogue route ───────────────────────────
export interface Segment {
  speaker: string; voice: string; text: string; rate?: string;
  pause_after_ms?: number; comma_pause_ms?: number; sentence_pause_ms?: number; trim_edges?: boolean;
}
export interface SegmentAudio { file_id: string; duration?: number | null; gaps?: [number, number][] }
export interface MultiResult { segment_audio?: SegmentAudio[]; file_id?: string; audio_url?: string; duration?: number }
export function multivoice(apiKey: string, segments: Segment[]): Promise<MultiResult> {
  return call<MultiResult>("/api/tts-multivoice", {
    method: "POST", apiKey, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments, output_format: "mp3" }), timeoutMs: 240_000,
  });
}

// ── Join clips sample-accurately ─────────────────────────────────────────
export interface Clip { file_id?: string; sound?: string; sound_len?: number; volume?: number; start?: number; end?: number; pause_after: number }
export function merge(apiKey: string, clips: Clip[], lead_in = 0): Promise<{ file_id: string; duration?: number }> {
  return call("/api/studio/timeline/merge", {
    method: "POST", apiKey, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clips, lead_in }), timeoutMs: 240_000,
  });
}

// ── Speech to text ───────────────────────────────────────────────────────
export interface SttResult { text?: string; transcript?: string; segments?: unknown[]; language?: string; duration?: number; [k: string]: unknown }
export async function transcribe(apiKey: string, audio: Buffer, filename: string, mime: string, language = "auto", durationSec = 0): Promise<SttResult> {
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: mime }), filename);
  form.append("language", language);
  form.append("diarization", "false");
  form.append("durationSec", String(durationSec));
  form.append("enhance", "standard");
  return call<SttResult>("/api/speech-to-text", { method: "POST", apiKey, body: form, timeoutMs: 300_000 });
}

export const audioUrl = (fileId: string) => `${CONFIG.siteUrl}/api/audio/${fileId}`;

/** Download a finished file from the site (for watermarking or length checks). */
export async function download(fileId: string): Promise<Buffer> {
  const r = await fetch(`${CONFIG.apiUrl}/api/audio/${fileId}`, { headers: { "x-freetts-source": "mcp" } });
  if (!r.ok) throw new ApiError(r.status, "audio not found");
  return Buffer.from(await r.arrayBuffer());
}

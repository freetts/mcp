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
  // Most rows carry only the locale code; lend them the name their locale has elsewhere in the list.
  const names = new Map<string, string>();
  for (const v of list) if (v.LocaleName && !names.has(v.Locale)) names.set(v.Locale, v.LocaleName);
  for (const v of list) if (!v.LocaleName && names.has(v.Locale)) v.LocaleName = names.get(v.Locale);
  voiceCache = { at: Date.now(), list };
  return list;
}

/** Voices for a language as people and models write it: 'en-US', 'en', 'German', 'English (US)', 'Portuguese (Brazil)'.
 *  A full locale matches only that locale; a bare language takes all its regions. */
export function byLanguage(list: Voice[], language: string | undefined): Voice[] {
  let w = (language || "").toLowerCase().trim().replace(/_/g, "-");
  if (!w) return list;
  const aliases: [RegExp, string][] = [[/\(us\)|\(usa\)|\(america\)/, "(united states)"], [/\(uk\)|\(gb\)|\(britain\)|\(england\)/, "(united kingdom)"], [/^american( english)?$/, "english (united states)"], [/^british( english)?$/, "english (united kingdom)"], [/^mandarin$/, "chinese (mandarin"], [/^brazilian( portuguese)?$/, "portuguese (brazil)"], [/^mexican( spanish)?$/, "spanish (mexico)"]];
  for (const [a, b] of aliases) w = w.replace(a, b);
  const code = (v: Voice) => v.Locale.toLowerCase();
  const name = (v: Voice) => (v.LocaleName || "").toLowerCase();
  const tries: Array<(v: Voice) => boolean> = [
    (v) => code(v) === w,
    (v) => /^[a-z]{2,3}$/.test(w) && code(v).split("-")[0] === w,
    (v) => name(v) === w,
    (v) => name(v).startsWith(w),
    (v) => name(v).includes(w),
    (v) => { const base = w.replace(/\s*\(.*$/, "").trim(); return !!base && base !== w && name(v).startsWith(base + " ("); },
  ];
  for (const t of tries) { const hit = list.filter(t); if (hit.length) return hit; }
  return [];
}

/** A voice by its id ('en-US-JennyNeural', any case) or by the short name people use ('Jenny', 'Andrew').
 *  A short name shared by several voices prefers a free one in the asked language, then en-US. */
export function findVoice(list: Voice[], asked: string, language?: string): Voice | undefined {
  const a = asked.trim().toLowerCase();
  const exact = list.find((v) => v.ShortName.toLowerCase() === a);
  if (exact) return exact;
  if (!/^[a-z][a-z .'-]{1,40}$/.test(a)) return undefined;
  const short = (v: Voice) => v.ShortName.split("-").slice(2).join("-").replace(/Neural$/, "").toLowerCase();
  const hits = list.filter((v) => short(v) === a.replace(/\s+/g, "") && (v.Tier || "") !== "ultra");
  if (!hits.length) return undefined;
  const inLang = language ? byLanguage(hits, language) : [];
  const rank = (v: Voice) => (inLang.includes(v) ? 0 : 2) + (v.Locale === "en-US" ? 0 : 1) + (isFreeVoice(v) ? 0 : 0.5);
  return [...hits].sort((x, y) => rank(x) - rank(y))[0];
}
export function isFreeVoice(v: Voice): boolean { return v.RequiresPro === false; }
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
export async function usage(apiKey: string): Promise<Usage> {
  try {
    return await call<Usage>("/api/v1/usage", { apiKey, timeoutMs: 20_000 });
  } catch (e) {
    // Until the site ships /api/v1/usage, a key is checked the way the API
    // checks it on a real call: a 404 here means the route is not live yet,
    // so the key is accepted for text_to_speech and the plan is unknown.
    if (e instanceof ApiError && e.status === 404) {
      // Prove the key the way the API proves it, with the smallest real call.
      // A bad key gets the API's own 401 here.
      const r = await tts(apiKey, { text: "Ok.", voice: "en-US-JennyNeural", output_format: "mp3" });
      const limit = Number(r.chars_limit || 0);
      const plan = limit >= 5_000_000 ? "creator" : limit >= 150_000 ? "pro" : "free";
      return { plan, plan_type: null, per_request_chars: plan === "creator" ? 25000 : plan === "pro" ? 10000 : 5000, requests_per_minute: plan === "creator" ? 1000 : plan === "pro" ? 200 : 10, monthly_chars_limit: limit, monthly_chars_used: Number(r.chars_used || 0), monthly_chars_left: Math.max(0, limit - Number(r.chars_used || 0)), monthly_reset_date: null, hd_voices: plan !== "free", watermark: plan === "free", audio_kept: plan === "free" ? "1 hour" : "30 days" };
    }
    throw e;
  }
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
  form.append("audio", new Blob([new Uint8Array(audio)], { type: mime }), filename);
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

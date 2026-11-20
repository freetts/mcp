// The tools. Descriptions are written for the model that reads them: what
// the tool does and when to use it, nothing else.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./config.js";
import { voices, isFreeVoice, tierLabel, tts, usage, multivoice, merge, transcribe, download, audioUrl, ApiError, byLanguage, findVoice, type Voice } from "./freetts.js";
import { safeFetch, FetchRefused, audioFileName } from "./safefetch.js";
import { watermarkAndStore, publicAudioUrl, storedPath, durationSeconds, requestHash, waveform, rememberInput, recallInput, storeZip, publicZipUrl, storeText, publicTextUrl } from "./audio.js";
import { PLAYER_TOOL_META, pickAlternatives, voiceShortName } from "./player.js";
import { store, today } from "./store.js";
import { recordScript, steadyVoiceId } from "./script/record.js";
import { DEFAULT_SETTINGS } from "./script/scriptModel.js";
import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { cues, toSrt, toVtt, timestamped, bySpeakerText, type Seg, type Word } from "./transcript.js";
import { startJob, waitFor, handOut, forget, findJob, ownerOf, running, expectedSeconds, WAIT_MS, PER_OWNER, PER_SERVER, JOB_KEEP_MS, type Job } from "./jobs.js";

export interface Caller {
  kind: "anon" | "key";
  apiKey?: string;
  plan?: string;
  ip: string;
  userAgent: string;
  /** Set when the call comes from claude.ai's or ChatGPT's servers: guests there cannot be told apart. */
  platform?: "claude" | "chatgpt" | null;
}

// The audio as a file a host can fetch and keep: the shape ChatGPT uses for files passed to and from
// tools (file_id, download_url, mime_type, file_name). Declared in each tool's outputSchema.
const FILE_REF = z.object({
  file_id: z.string().describe("FreeTTS id of the audio."),
  download_url: z.string().describe("Where the file can be downloaded."),
  mime_type: z.string().optional().describe("audio/mpeg (MP3) or audio/wav."),
  file_name: z.string().optional().describe("A name for the file, made from its first words."),
});
const TTS_OUTPUT = {
  url: z.string().describe("Link to the audio."),
  file: FILE_REF.describe("The same audio as a file."),
  voice: z.string().optional(),
  format: z.string().optional(),
  characters: z.number().optional(),
  seconds: z.number().nullable().optional(),
  kept: z.string().optional(),
  free_tier: z.boolean().optional(),
  voice_name: z.string().optional(),
  language: z.string().optional(),
  tier: z.string().optional(),
  text: z.string().optional(),
  speed: z.number().optional(),
  peaks: z.array(z.number()).nullable().optional(),
  alternatives: z.array(z.object({ id: z.string(), name: z.string(), tier: z.string(), gender: z.string() })).optional(),
};
const DIALOGUE_OUTPUT = {
  url: z.string().describe("Link to the audio."),
  file: FILE_REF.describe("The same audio as a file."),
  lines: z.number(),
  voices: z.record(z.string(), z.string()),
};
const BATCH_OUTPUT = {
  file: FILE_REF.optional().describe("Every clip in one ZIP, numbered in order."),
  zip_url: z.string().optional().describe("Link to the ZIP."),
  clips: z.array(z.object({ index: z.number(), text: z.string(), url: z.string(), file: FILE_REF,
    voice: z.string().optional().describe("The voice of this clip, when the call gave a voice per clip.") })).describe("One entry per clip made, in order."),
  failed: z.array(z.object({ index: z.number(), text: z.string(), reason: z.string() })).describe("Texts that could not be made, and why."),
  voice: z.string(),
  format: z.string(),
  characters: z.number(),
};
// A file the user attached in ChatGPT, passed to a tool that lists the field in "openai/fileParams".
// OpenAI's plugin check requires all four properties declared and download_url + file_id required.
const CHATGPT_FILE = z.object({
  download_url: z.string().describe("Temporary download address of the file."),
  file_id: z.string().describe("The file's id in ChatGPT."),
  mime_type: z.string().optional().describe("Type of the file, like audio/mpeg."),
  file_name: z.string().optional().describe("Name of the file."),
}).strict();
const STT_OUTPUT = {
  status: z.enum(["done", "working"]).optional().describe("working: a long recording is still being transcribed; collect it with get_transcript."),
  job_id: z.string().optional().describe("Pass to get_transcript while status is working."),
  text: z.string().optional().describe("The transcript (with times or speakers when asked). For a very long one, the first part."),
  language: z.string().nullable().optional(),
  duration_seconds: z.number().optional().describe("Length of the recording."),
  speakers_found: z.number().optional(),
  complete: z.boolean().optional().describe("false when text holds only the first part; the whole text is at transcript_url."),
  transcript_url: z.string().optional().describe("The whole transcript as a text file, kept one day."),
  subtitles: z.object({ format: z.enum(["srt", "vtt"]), url: z.string(), cues: z.number(), file: FILE_REF }).optional().describe("The subtitle file, kept one day."),
  audio_seconds: z.number().nullable().optional(),
  expected_seconds: z.number().nullable().optional().describe("About how long until the transcript is ready."),
};
/** Renders a batch runs at the same time. */
const BATCH_PARALLEL = 5;
/** A file name from the first words: "Hallo! Ich heiße Mia." -> hallo-ich-heisse-mia-7486e6ed.mp3 (the id keeps names apart). */
export function clipFileName(words: string, id: string, ext: string): string {
  return `${clipSlug(words) || "freetts-audio"}-${id.slice(0, 8)}.${ext}`;
}
/** The first six words as a file-name part: "Hallo! Ich heiße Mia." -> hallo-ich-heisse-mia. */
export function clipSlug(words: string): string {
  return words.replace(/ß/g, "ss").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "");
}

/** Tools that need an account. Calls without a token get a 401 before the SDK runs (see index.ts). */
export const PROTECTED_TOOLS = new Set(["batch_text_to_speech", "dialogue_to_speech", "script_to_tracks", "transcribe_audio", "get_transcript"]);

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const DASH = `${CONFIG.siteUrl}/dashboard`;
const PRICING = `${CONFIG.siteUrl}/pricing`;
const KEYS_HELP = `Get a key: ${DASH} (API keys). A free account has one key with 5,000 characters a day; PRO has HD voices, no watermark and 1,000,000 characters a month (${PRICING}).`;
/** ChatGPT's plugin rules: no plan lists or upgrade nudges; a plain reason and an informational plans link only. */
export const inChatGPT = (c: Caller) => c.platform === "chatgpt" || /openai-mcp/i.test(c.userAgent);
const keysHelp = (c: Caller) => inChatGPT(c) ? `What each FreeTTS plan includes: ${PRICING}` : KEYS_HELP;

// Refusals that a plan changes; only these get a pointer to the plans.
const PLAN_LIMITS = new Set(["daily", "monthly", "monthly_chars", "per_gen", "pro_feature", "creator_required", "trial_cap", "trial_velocity", "trial_ended"]);

function apiErrorText(e: unknown, caller: Caller): string {
  if (e instanceof ApiError) {
    const d = e.detail as { error?: string; limit_type?: string } | string;
    // FastAPI's own validation errors arrive as a list of {loc, msg}.
    const list = Array.isArray(e.detail) ? (e.detail as Array<{ loc?: unknown[]; msg?: string }>).map((x) => `${(x.loc || []).slice(-1)[0] ?? "input"}: ${x.msg}`).join("; ") : "";
    const msg = list ? `FreeTTS did not accept the request (${list}).` : typeof d === "string" ? d : d?.error || e.message;
    // /api/v1/tts answers a used-up month with 429 as well (a plain sentence for keys): that is a plan
    // limit, not "too many requests in a minute", so it takes the plan wording below.
    const lt = (typeof d === "object" && d ? d.limit_type || "" : "")
      || (e.status === 429 && /monthly character limit/i.test(String(msg)) ? "monthly" : "");
    if (e.status === 429 && !PLAN_LIMITS.has(lt)) return `FreeTTS is rate limiting this ${caller.kind === "anon" ? "connection" : "key"} (too many requests in a minute). Wait a moment and try again.`;
    // Callers without a key share the service account: its caps are the free pool, not theirs.
    if (caller.kind === "anon" && (e.status === 402 || PLAN_LIMITS.has(lt))) return `The free allowance for callers without an account is used up for now. A free FreeTTS key keeps working: ${keysHelp(caller)}`;
    if (lt === "hd_voice_required") return `HD and Signature voices are part of FreeTTS PRO. list_voices with free_only: true shows the voices this key can use. Plans: ${PRICING}`;
    if (e.status === 402 || PLAN_LIMITS.has(lt)) return `${msg} Plans: ${PRICING}`;
    if (e.status === 401) return `FreeTTS did not accept the API key. Check it in ${DASH} (API keys), or connect again.`;
    if (e.status === 422 || e.status === 400 || lt) return String(msg);
    return `FreeTTS could not finish this (${e.status}). ${msg}`;
  }
  if (e instanceof FetchRefused) return e.message;
  return `Something failed on the FreeTTS side: ${(e as Error)?.message || e}. Try again.`;
}

// ── Anonymous metering (what a website guest gets) ────────────────────────
/** The meter a guest counts against: the address, or for IPv6 its /64 (one subscriber's block, so rotating addresses in it does not reset the allowance). */
export function meterId(ip: string): string {
  if (!ip.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.replace(/^::ffff:/i, "");
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : []; const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** The meter a guest counts against: their address (a /64 on IPv6), or the whole platform on claude.ai and ChatGPT. */
export const meterKey = (caller: Caller) => caller.platform ? `platform:${caller.platform}` : meterId(caller.ip);
const PLATFORM_NAME = { claude: "Claude", chatgpt: "ChatGPT" } as const;

/** Characters guests used in the last day on this meter. */
function dayUsed(caller: Caller): number {
  const m = store.get().anon[meterKey(caller)]; const now = Date.now();
  return m ? m.chars.filter(([t]) => t > now - 86_400_000).reduce((x, [, c]) => x + c, 0) : 0;
}
/** A platform's guest allowance is spent: the next request should ask the person to connect their own account. */
export const platformSpent = (caller: Caller) => !!caller.platform && caller.kind === "anon" && dayUsed(caller) >= CONFIG.anon.platformDailyChars - 50;

function anonCheck(caller: Caller, chars: number): string | null {
  const a = CONFIG.anon;
  if (chars > a.perCallChars) return `Without a FreeTTS key, one call can read up to ${a.perCallChars.toLocaleString()} characters; this text is ${chars.toLocaleString()}. Split it, or add a key. ${keysHelp(caller)}`;
  const s = store.get();
  const m = (s.anon[meterKey(caller)] ||= { calls: [], chars: [] });
  const now = Date.now();
  const perMinute = caller.platform ? a.platformPerMinute : a.perMinute;
  m.calls = m.calls.filter((t) => t > now - 60_000);
  if (m.calls.length >= perMinute) return `Without a key, this connection can make ${perMinute} requests a minute. Wait a moment, or add a key. ${keysHelp(caller)}`;
  m.chars = m.chars.filter(([t]) => t > now - 86_400_000);
  const day = m.chars.reduce((x, [, c]) => x + c, 0);
  if (caller.platform) {
    if (day + chars > a.platformDailyChars) return `Free audio without an account is used up for today on ${PLATFORM_NAME[caller.platform]}. Connect your free FreeTTS account to keep going with 5,000 characters a day of your own: ${DASH} (API keys).`;
  } else {
    const hour = m.chars.filter(([t]) => t > now - 3_600_000).reduce((x, [, c]) => x + c, 0);
    if (day + chars > a.dailyChars) return `Without a key, FreeTTS reads ${a.dailyChars.toLocaleString()} characters a day per connection; ${day.toLocaleString()} are used. ${keysHelp(caller)}`;
    if (hour + chars > a.hourlyChars) return `Without a key, FreeTTS reads ${a.hourlyChars.toLocaleString()} characters an hour per connection. Try again later, or add a key. ${keysHelp(caller)}`;
  }
  const pool = s.pool[today()] || 0;
  if (pool + chars > a.poolDailyChars) return `The free pool for callers without an account is used up for today. A free FreeTTS key keeps working: ${keysHelp(caller)}`;
  return null;
}
/** Counted before the synthesis starts, so parallel calls cannot pass the limits together; handed back if it fails. */
function anonReserve(caller: Caller, chars: number): () => void {
  const s = store.get();
  const m = (s.anon[meterKey(caller)] ||= { calls: [], chars: [] });
  const at = Date.now(); const day = today();
  const call = at; const entry: [number, number] = [at, chars];
  m.calls.push(call); m.chars.push(entry);
  s.pool[day] = (s.pool[day] || 0) + chars;
  store.touch();
  return () => {
    const i = m.calls.indexOf(call); if (i >= 0) m.calls.splice(i, 1);
    const j = m.chars.indexOf(entry); if (j >= 0) m.chars.splice(j, 1);
    s.pool[day] = Math.max(0, (s.pool[day] || 0) - chars);
    store.touch();
  };
}

// Same text, same voice, within a few minutes: the same file, no new synthesis.
// Kept with where the file's bytes are, so a repeat that asks for them (include_audio) gets them too.
interface Recent { at: number; result: CallToolResult; fileId: string; localId: string | null; fmt: string }
const recent = new Map<string, Recent>();
setInterval(() => { const cut = Date.now() - 600_000; for (const [k, v] of recent) if (v.at < cut) recent.delete(k); }, 60_000).unref();

/** The result with the audio bytes added, for a caller that asks for them (include_audio). */
async function withAudio(result: CallToolResult, src: Pick<Recent, "fileId" | "localId" | "fmt">): Promise<CallToolResult> {
  let extra: CallToolResult["content"][number];
  try {
    const bytes = src.localId ? await readFile(storedPath(src.localId)!) : await download(src.fileId);
    extra = bytes.length <= 4_000_000
      ? { type: "audio", data: bytes.toString("base64"), mimeType: src.fmt === "wav" ? "audio/wav" : "audio/mpeg" }
      : { type: "text", text: "The audio is over 4 MB, so only the link is returned." };
  } catch { extra = { type: "text", text: "The audio bytes could not be added just now; the link above works." }; }
  return { ...result, content: [...result.content, extra] };
}

const langOf = (v: Voice) => v.LocaleName || v.Locale;
const voiceLine = (v: Voice) => `${v.ShortName} (${v.FriendlyName || v.ShortName.split("-").slice(2).join("-").replace(/Neural$/, "")}, ${v.Gender}, ${langOf(v)}, ${tierLabel(v)}${isFreeVoice(v) ? ", free" : ", PRO"})`;

// The voice a language gets when none is named: the usual one for its main region.
const PREFERRED = ["en-US-JennyNeural", "en-US-AndrewNeural", "en-US-AriaNeural", "en-GB-SoniaNeural", "en-AU-NatashaNeural", "en-IN-NeerjaNeural", "de-DE-KatjaNeural", "fr-FR-DeniseNeural", "fr-CA-SylvieNeural", "es-ES-ElviraNeural", "es-MX-DaliaNeural", "pt-BR-FranciscaNeural", "pt-PT-RaquelNeural", "it-IT-ElsaNeural", "ja-JP-NanamiNeural", "ko-KR-SunHiNeural", "ar-SA-ZariyahNeural", "ar-EG-SalmaNeural", "hi-IN-SwaraNeural", "zh-CN-XiaoxiaoNeural", "nl-NL-ColetteNeural", "tr-TR-EmelNeural", "ru-RU-SvetlanaNeural", "pl-PL-ZofiaNeural"];

async function pickDefaultVoice(language: string | undefined, free: boolean): Promise<Voice | null> {
  const all = (await voices()).filter((v) => !["ultra", "prime"].includes(v.Tier || "") && (free ? isFreeVoice(v) : true));
  const pool = byLanguage(all, language || "en-US");
  if (!pool.length) return null;
  return PREFERRED.map((id) => pool.find((v) => v.ShortName === id)).find(Boolean) || pool.find((v) => v.Locale.split("-")[1]?.toLowerCase() === v.Locale.split("-")[0]) || pool[0];
}

// Speakers in a dialogue get a voice that matches the name when the name is a common one.
const FEMALE = new Set("anna maya sara sarah emma olivia sophia sophie mia amelia ava isabella grace lily chloe zoe emily hannah laura julia maria fatima aisha amira layla leila noor lina yasmin mariam salma huda rania dana nadia sofia lucia elena ana ines camille chloé lea léa marie claire nina eva ella ruth rachel rebecca leah esther miriam naomi priya ananya aarti kavya mei yuki sakura hana jenny aria kate katie lisa linda susan karen nancy betty helen mary jane alice rose lucy amy anne".split(" "));
const MALE = new Set("omar ben james john michael david daniel adam noah liam oliver william thomas jack harry george charlie ethan lucas mateo leo max paul peter mark luke matthew andrew josh joshua ryan tom sam samuel ahmed ali hassan hussein khalid youssef yusuf ibrahim mohammed muhammad mahmoud tariq karim abd rami ziad ziyad fadi nabil sami jose juan carlos luis diego pierre louis hugo jean marco luca giovanni hans lukas felix raj arjun rahul vikram kenji hiro takeshi guy brian eric kevin chris steve tony frank henry jake alex".split(" "));
const genderFor = (name: string): "female" | "male" | null => { const n = name.toLowerCase().split(/\s+/)[0]; return FEMALE.has(n) ? "female" : MALE.has(n) ? "male" : null; };

export function registerTools(server: McpServer, caller: Caller): void {
  // ── list_voices ───────────────────────────────────────────────────────
  server.registerTool("list_voices", {
    title: "List FreeTTS voices",
    description: "List FreeTTS voices for a language or a search word, with the voice id to pass to text_to_speech. Says which voices are free and which need a FreeTTS PRO key (HD and Signature). Use it when the user names a language, accent or gender, or asks what voices exist.",
    inputSchema: {
      language: z.string().optional().describe("Language or locale, like 'German', 'de-DE', 'Spanish (Mexico)' or 'en'. Empty lists every language."),
      search: z.string().optional().describe("A word to match in the voice name or personality, like 'Andrew', 'calm' or 'news'."),
      gender: z.enum(["female", "male", "any"]).optional().describe("Filter by gender."),
      free_only: z.boolean().optional().describe("Only voices that work without a FreeTTS key."),
      limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 15."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (a) => {
    const all = await voices();
    const want = (a.language || "").toLowerCase().trim();
    const q = (a.search || "").toLowerCase().trim();
    let list = all.filter((v) => !["ultra", "prime"].includes(v.Tier || ""));
    if (want) list = byLanguage(list, want);
    if (q) list = list.filter((v) => `${v.ShortName} ${v.FriendlyName || ""} ${(v.VoiceTag?.VoicePersonalities || []).join(" ")} ${(v.VoiceTag?.ContentCategories || []).join(" ")}`.toLowerCase().includes(q));
    if (a.gender && a.gender !== "any") list = list.filter((v) => v.Gender.toLowerCase() === a.gender);
    if (a.free_only) list = list.filter(isFreeVoice);
    if (!want && !q) {
      const langs = new Map<string, number>();
      for (const v of list) langs.set(v.LocaleName || v.Locale, (langs.get(v.LocaleName || v.Locale) || 0) + 1);
      return text(`FreeTTS has ${list.length.toLocaleString()} voices in ${langs.size} languages and regional variants. Give a language to see its voices. Free without a key: ${list.filter(isFreeVoice).length} standard voices; HD and Signature voices need a FreeTTS PRO key.\n\n` + [...langs.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([l, n]) => `${l}: ${n}`).join("\n"));
    }
    // free first, then standard, then HD, then Signature; friendly names
    const order = (v: Voice) => (isFreeVoice(v) ? 0 : tierLabel(v) === "Standard" ? 1 : tierLabel(v) === "HD" ? 2 : 3);
    list.sort((x, y) => order(x) - order(y) || x.ShortName.localeCompare(y.ShortName));
    const limit = a.limit ?? 15;
    const shown = list.slice(0, limit);
    const more = list.length > shown.length ? `\n${list.length - shown.length} more; raise limit to see them.` : "";
    return {
      content: [{ type: "text", text: shown.length ? shown.map(voiceLine).join("\n") + more : `No FreeTTS voice matches that. Try the language name in English (for example 'Arabic (Egypt)') or leave the search empty.` }],
      structuredContent: { voices: shown.map((v) => ({ id: v.ShortName, name: v.FriendlyName, gender: v.Gender, locale: v.Locale, language: langOf(v), tier: tierLabel(v), free: isFreeVoice(v) })), total: list.length },
    };
  });

  // ── suggest_voice ─────────────────────────────────────────────────────
  server.registerTool("suggest_voice", {
    title: "Suggest a FreeTTS voice",
    description: "Suggest three FreeTTS voices for a language and a use (audiobook, tutorial, ad, news, children's story, meditation, podcast), with a short reason each. Use it when the user has not named a voice.",
    inputSchema: {
      language: z.string().describe("Language or locale, like 'English (US)', 'de-DE' or 'Portuguese (Brazil)'."),
      use: z.string().optional().describe("What the audio is for, in a few words."),
      gender: z.enum(["female", "male", "any"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (a) => {
    const all = await voices();
    const want = a.language.toLowerCase().trim();
    let pool = byLanguage(all.filter((v) => !["ultra", "prime"].includes(v.Tier || "")), want);
    if (a.gender && a.gender !== "any") pool = pool.filter((v) => v.Gender.toLowerCase() === a.gender);
    if (!pool.length) return text(`No FreeTTS voice for "${a.language}". list_voices with no language shows every language available.`);
    const use = (a.use || "").toLowerCase();
    const wants = use.match(/child|kid|story|bedtime/) ? ["Cheerful", "Friendly", "Warm", "Cartoon"] : use.match(/news|announce|corporate|formal/) ? ["Formal", "Confident", "Authoritative", "Newscast"] : use.match(/meditat|sleep|calm|relax/) ? ["Calm", "Soothing", "Warm", "Gentle"] : use.match(/ad|promo|market|sale/) ? ["Confident", "Bright", "Upbeat", "Positive"] : ["Warm", "Friendly", "Clear", "Approachable"];
    const score = (v: Voice) => (v.VoiceTag?.VoicePersonalities || []).reduce((s, p) => s + (wants.some((w) => p.toLowerCase().includes(w.toLowerCase())) ? 2 : 0), 0) + (v.Locale.toLowerCase() === want ? 1 : 0);
    const free = pool.filter(isFreeVoice).sort((x, y) => score(y) - score(x));
    const pro = pool.filter((v) => !isFreeVoice(v) && tierLabel(v) !== "Standard").sort((x, y) => score(y) - score(x));
    const picks: Array<[Voice, string]> = [];
    if (free[0]) picks.push([free[0], `free, ${(free[0].VoiceTag?.VoicePersonalities || ["clear"]).slice(0, 2).join(" and ").toLowerCase()}`]);
    if (free[1]) picks.push([free[1], `free, a ${free[1].Gender.toLowerCase()} alternative`]);
    if (pro[0]) picks.push([pro[0], `${tierLabel(pro[0])} quality, needs a FreeTTS PRO key`]);
    return text(picks.map(([v, why], i) => `${i + 1}. ${v.ShortName} (${v.FriendlyName || ""}, ${v.Gender}, ${langOf(v)}): ${why}.`).join("\n") + `\n\nPass the id to text_to_speech as voice.${caller.kind === "anon" && !inChatGPT(caller) ? " Without a key the free voices work; " + KEYS_HELP : ""}`);
  });

  // ── text_to_speech ────────────────────────────────────────────────────
  server.registerTool("text_to_speech", {
    title: "Text to speech (FreeTTS)",
    description: `Convert text to spoken audio with a FreeTTS voice and return a download link to the MP3 (or WAV with a FreeTTS PRO key). Use it when the user wants text read aloud, narrated, or saved as an audio file. Without a FreeTTS key: standard voices, up to ${CONFIG.anon.perCallChars.toLocaleString()} characters a call, a short spoken "FreeTTS" tag at the end, file kept one hour. With a key: the account's plan (PRO: HD and Signature voices, no tag, 10,000 characters a call, files kept 30 days). For three or more separate clips on a FreeTTS PRO account (word lists, quiz lines, one file per sentence), call batch_text_to_speech once instead of this tool several times.`,
    inputSchema: {
      text: z.string().max(30000).optional().describe("The text to read. Plain text; SSML is not needed. Required unless rerender_of is given."),
      rerender_of: z.string().max(400).optional().describe("Read the same words as an earlier result again, in another voice or speed: the audio link (or id) that result returned, from the last 24 hours. The text is then not needed."),
      voice: z.string().optional().describe("A FreeTTS voice id from list_voices, like en-US-JennyNeural (a short name like 'Jenny' also works). If empty, a good standard voice for the language is chosen."),
      language: z.string().optional().describe("Language of the text when no voice is given, like 'German' or 'pt-BR'."),
      speed: z.number().int().min(-30).max(30).optional().describe("Percent slower (negative) or faster (positive). Default 0."),
      format: z.enum(["mp3", "wav"]).optional().describe("mp3 (default) or wav (FreeTTS PRO)."),
      include_audio: z.boolean().optional().describe("Also return the audio bytes in the result (large). Default false; the link is enough for most clients."),
    },
    outputSchema: TTS_OUTPUT,
    // A write, because the audio is kept and counted on the account. Not open-world:
    // the tool works inside the caller's own FreeTTS account and reaches no public or
    // open-ended destination (only transcribe_audio fetches an outside address). The
    // same holds for the batch, dialogue and script tools below.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // The in-chat player (MCP Apps): hosts that render it show the audio under the answer.
    _meta: PLAYER_TOOL_META,
  }, async (a0) => {
    // Same words as an earlier result: the text and settings come from what
    // that result was made with (kept for a day), unless given again here.
    const a = { ...a0 } as typeof a0 & { text: string };
    if (!(a.text || "").trim() && a.rerender_of) {
      const prev = await recallInput(a.rerender_of);
      if (!prev) return fail("That earlier audio is older than a day or not from this server, so its words are gone. Send the text again.");
      a.text = prev.text;
      if (a.speed == null && prev.speed != null) a.speed = prev.speed;
      if (!a.format && (prev.format === "mp3" || prev.format === "wav")) a.format = prev.format;
    }
    if (!(a.text || "").trim()) return fail("The text is empty. Give the words to read.");
    const chars = a.text.length;
    let voice = (a.voice || "").trim();
    const all = await voices();
    let v = voice ? findVoice(all, voice, a.language) : undefined;
    if (voice && !v) return fail(`"${voice}" is not a FreeTTS voice id. Use list_voices to find one (ids look like en-US-JennyNeural or de-DE-Florian:DragonHDLatestNeural).`);
    if (v) voice = v.ShortName;   // the id the API knows, whatever form the caller used
    if (v && ["ultra", "prime"].includes(v.Tier || "")) return fail(`${v.ShortName} is ${v.Tier === "prime" ? "a Prime" : "an Ultra"} voice, available on freetts.org only, not through the API. Pick another voice from list_voices.`);
    const isAnon = caller.kind === "anon";
    let note = "";
    if (!v) {
      const d = await pickDefaultVoice(a.language, isAnon);
      if (!d) return fail(`No FreeTTS voice for "${a.language}". list_voices with no language shows what exists.`);
      v = d; voice = d.ShortName;
    } else if (isAnon && !isFreeVoice(v)) {
      const alt = await pickDefaultVoice(v.Locale, true);
      if (!alt) return fail(`${v.ShortName} needs a FreeTTS PRO key and there is no free voice for ${langOf(v)}. ${keysHelp(caller)}`);
      note = `${v.ShortName} is a ${tierLabel(v)} voice, which needs a FreeTTS PRO key. This audio uses the closest free voice instead, ${alt.ShortName}. ${keysHelp(caller)}\n`;
      v = alt; voice = alt.ShortName;
    }
    const fmt = a.format || "mp3";
    if (isAnon && fmt === "wav") return fail(`WAV is part of FreeTTS PRO. Without a key the audio is MP3. ${keysHelp(caller)}`);
    if (fmt === "wav" && caller.plan === "free") return fail(`WAV is part of FreeTTS PRO; a free key gets MP3. Plans: ${PRICING}`);
    const rate = a.speed ? `${a.speed > 0 ? "+" : ""}${a.speed}%` : undefined;
    const hk = requestHash([caller.kind, caller.kind === "key" ? caller.apiKey! : meterKey(caller), a.text, voice, fmt, rate || ""]);
    const cached = recent.get(hk);
    if (cached) return a.include_audio ? withAudio(cached.result, cached) : cached.result;
    let refund: (() => void) | null = null;
    if (isAnon) {
      const why = anonCheck(caller, chars);
      if (why) return fail(why);
      if (!CONFIG.serviceApiKey) return fail(CONFIG.local ? `This local FreeTTS server needs your FreeTTS API key to make audio: set FREETTS_API_KEY (a free key works). ${keysHelp(caller)} Or use the hosted server https://mcp.freetts.org/mcp, which works without a key.` : `Calls without a key are not set up on this server yet. ${keysHelp(caller)}`);
      refund = anonReserve(caller, chars);
    }
    try {
      const r = await tts(isAnon ? CONFIG.serviceApiKey : caller.apiKey!, { text: a.text, voice, output_format: fmt, ...(rate ? { rate } : {}) });
      let url = r.audio_url || audioUrl(r.file_id);
      let kept = "30 days";
      let localId: string | null = null;
      if (isAnon) {
        const raw = await download(r.file_id);
        localId = await watermarkAndStore(raw);
        url = publicAudioUrl(localId);
        kept = "1 hour";
      } else if (caller.plan === "free") kept = "1 hour";
      // The player draws the real waveform; ffmpeg measures it here because
      // account audio on freetts.org cannot be read cross-origin in the chat.
      let wave: { peaks: number[]; seconds: number } | null = null;
      try {
        const bytes = localId ? await readFile(storedPath(localId)!) : await download(r.file_id);
        wave = await waveform(bytes);
      } catch { wave = null; }
      const dur = wave?.seconds ?? (localId ? await durationSeconds(storedPath(localId)!) : null);
      const usedVoice = all.find((x) => x.ShortName === r.voice) || v;
      // The same audio as a file a host can fetch and keep, named from its first words.
      const fileName = clipFileName(a.text, localId || r.file_id, fmt);
      const file = { file_id: localId || r.file_id, download_url: url, mime_type: fmt === "wav" ? "audio/wav" : "audio/mpeg", file_name: fileName };
      // A paid account making a short clip is often making several (word lists, quiz
      // lines): the answer says that one batch call makes them all. Never for guests
      // or free keys, where the batch tool would refuse.
      const more = !isAnon && !!caller.plan && caller.plan !== "free" && !a0.rerender_of && chars <= 300
        ? "\nSeveral separate clips to make? One batch_text_to_speech call makes up to 50 at once, with a voice per clip if needed." : "";
      const content: CallToolResult["content"] = [
        { type: "text", text: `${note}Audio ready: ${url}\nVoice: ${r.voice}${r.downgraded ? " (the requested Signature voice was over its cap, so a matching standard voice was used)" : ""}. ${chars.toLocaleString()} characters${dur ? `, about ${Math.round(dur)} seconds` : ""}. ${fmt.toUpperCase()}, kept ${kept}.${isAnon ? (inChatGPT(caller) ? " Ends with a short spoken FreeTTS tag." : " Ends with a short spoken FreeTTS tag; a FreeTTS key removes it.") : r.watermark && r.watermark !== "none" ? " Ends with a short spoken FreeTTS tag (free plan)." : ""}${more}` },
        { type: "resource_link", uri: url, name: fileName, mimeType: fmt === "wav" ? "audio/wav" : "audio/mpeg", description: `Spoken audio, ${chars} characters, voice ${r.voice}` },
      ];
      const result: CallToolResult = { content,
        // For the in-chat player only (hidden from the model): the text and
        // settings, so the voice chips can re-render it even when the host
        // never delivers tool-input.
        _meta: { "freetts/input": { text: a.text.slice(0, 30000), ...(a.speed ? { speed: a.speed } : {}), format: fmt } },
        structuredContent: {
        url, file, voice: r.voice, format: fmt, characters: chars, seconds: dur, kept, free_tier: isAnon,
        // For the in-chat player: display name, language, voice tier, the real
        // waveform, and other voices for this language that this caller can use.
        voice_name: voiceShortName(usedVoice), language: langOf(usedVoice), tier: tierLabel(usedVoice),
        // The text itself, for the player's voice chips: ChatGPT hands the
        // player structuredContent but not the tool input. Short texts only.
        ...(chars <= 3000 ? { text: a.text, ...(a.speed ? { speed: a.speed } : {}) } : {}),
        peaks: wave?.peaks ?? null,
        alternatives: pickAlternatives(all, usedVoice, !isAnon && caller.plan !== "free"),
      } };
      recent.set(hk, { at: Date.now(), result, fileId: r.file_id, localId, fmt });
      void rememberInput(url, { text: a.text, ...(a.speed ? { speed: a.speed } : {}), format: fmt });
      return a.include_audio ? await withAudio(result, { fileId: r.file_id, localId, fmt }) : result;
    } catch (e) { refund?.(); return fail(apiErrorText(e, caller)); }
  });

  // ── batch_text_to_speech (account) ────────────────────────────────────
  // Many short clips in one call (1.3.0). Word lists, flashcards and quiz lines
  // used to take one call per clip. This makes up to 50 a call, five at a time,
  // and hands back one ZIP as well as a link per clip.
  server.registerTool("batch_text_to_speech", {
    title: "Many short clips at once (FreeTTS)",
    description: "Make one audio file per text from a list, in one call: vocabulary and flashcards, quiz questions and answers, H5P and other e-learning clips, app or game lines, each line of a dialogue as its own file. Up to 50 texts of up to 1,000 characters each, in one voice or with a voice for each text (voices). Returns a link per clip and one ZIP with every clip, numbered in order (01-..., 02-...). Use it instead of calling text_to_speech many times. Needs a connected FreeTTS PRO account.",
    inputSchema: {
      texts: z.array(z.string().min(1).max(1000)).min(1).max(50).describe("The texts, one clip each, in the order wanted."),
      voice: z.string().optional().describe("A FreeTTS voice id from list_voices for every clip, like es-ES-ElviraNeural (a short name like 'Elvira' also works). If empty, a good voice for the language is chosen."),
      voices: z.array(z.string().max(120)).max(50).optional().describe("A voice for each text, in the same order as texts, when the clips are spoken by different people: [\"de-DE-KatjaNeural\", \"de-DE-ConradNeural\", \"de-DE-KatjaNeural\"]. One entry per text; an empty entry uses voice."),
      language: z.string().optional().describe("Language of the texts when no voice is given, like 'Spanish' or 'fr-FR'."),
      speed: z.number().int().min(-30).max(30).optional().describe("Percent slower (negative) or faster (positive). Default 0."),
      format: z.enum(["mp3", "wav"]).optional().describe("mp3 (default) or wav."),
    },
    outputSchema: BATCH_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${keysHelp(caller)}`);
    if (caller.plan === "free") return fail(inChatGPT(caller)
      ? `Many clips in one call is part of FreeTTS PRO; on this account, text_to_speech makes one clip at a time. ${keysHelp(caller)}`
      : `Many clips in one call is part of FreeTTS PRO; on the free plan, text_to_speech makes one clip at a time. Plans: ${PRICING}`);
    const texts = a.texts.map((t) => t.trim());
    const empty = texts.findIndex((t) => !t);
    if (empty >= 0) return fail(`Text ${empty + 1} is empty. Give the words for every clip.`);
    const all = await voices();
    // A voice per clip (1.3.1): lines spoken by different people in one call. Each
    // entry is resolved like `voice`; an empty entry falls back to it.
    const own = (a.voices || []).map((s) => (s || "").trim());
    if (a.voices && own.length !== texts.length) return fail(`voices has ${own.length} ${own.length === 1 ? "entry" : "entries"} for ${texts.length} ${texts.length === 1 ? "text" : "texts"}. Give one voice per text, in the same order, or leave voices out to use one voice for every clip.`);
    const perClip: string[] = [];
    for (let i = 0; i < own.length; i++) {
      if (!own[i]) { perClip.push(""); continue; }
      const pv = findVoice(all, own[i], a.language);
      if (!pv) return fail(`Voice ${i + 1} in voices, "${own[i]}", is not a FreeTTS voice id. Use list_voices to find one (ids look like en-US-JennyNeural or de-DE-Florian:DragonHDLatestNeural).`);
      if (["ultra", "prime"].includes(pv.Tier || "")) return fail(`${pv.ShortName} is ${pv.Tier === "prime" ? "a Prime" : "an Ultra"} voice, available on freetts.org only, not through the API. Pick another voice from list_voices.`);
      perClip.push(pv.ShortName);
    }
    let voice = (a.voice || "").trim();
    let v = voice ? findVoice(all, voice, a.language) : undefined;
    if (voice && !v) return fail(`"${voice}" is not a FreeTTS voice id. Use list_voices to find one (ids look like en-US-JennyNeural or de-DE-Florian:DragonHDLatestNeural).`);
    if (v && ["ultra", "prime"].includes(v.Tier || "")) return fail(`${v.ShortName} is ${v.Tier === "prime" ? "a Prime" : "an Ultra"} voice, available on freetts.org only, not through the API. Pick another voice from list_voices.`);
    // The voice for clips without their own, looked up only when one needs it.
    if (!v && (!own.length || perClip.some((x) => !x))) {
      const d = await pickDefaultVoice(a.language, false);
      if (!d) return fail(`No FreeTTS voice for "${a.language}". list_voices with no language shows what exists.`);
      v = d;
    }
    voice = v ? v.ShortName : perClip[0];
    const voiceFor = (i: number) => perClip[i] || voice;
    const fmt = a.format || "mp3";
    const rate = a.speed ? `${a.speed > 0 ? "+" : ""}${a.speed}%` : undefined;
    // Five renders at a time, in order. Each is an ordinary API call: counted on
    // the account, and a repeat of the same text and voice comes back free.
    const done: { index: number; text: string; fileId: string; url: string; voice: string }[] = [];
    const failed: { index: number; text: string; reason: string }[] = [];
    let stop: string | null = null;
    let next = 0;
    const render = async () => {
      while (next < texts.length) {
        const i = next++;
        if (stop) { failed.push({ index: i + 1, text: texts[i].slice(0, 80), reason: stop }); continue; }
        try {
          const r = await tts(caller.apiKey!, { text: texts[i], voice: voiceFor(i), output_format: fmt, ...(rate ? { rate } : {}) });
          done.push({ index: i + 1, text: texts[i], fileId: r.file_id, url: r.audio_url || audioUrl(r.file_id), voice: voiceFor(i) });
        } catch (e) {
          const reason = apiErrorText(e, caller);
          // A refused key, a plan wall or the rate limit would refuse the rest the same way.
          if (e instanceof ApiError && [401, 402, 429].includes(e.status)) stop = reason;
          failed.push({ index: i + 1, text: texts[i].slice(0, 80), reason });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_PARALLEL, texts.length) }, render));
    done.sort((x, y) => x.index - y.index);
    failed.sort((x, y) => x.index - y.index);
    if (!done.length) return fail(failed[0]?.reason || "No clip could be made. Try again.");
    const width = Math.max(2, String(texts.length).length);
    const num = (n: number) => String(n).padStart(width, "0");
    const clipName = (d: { index: number; text: string }) => `${num(d.index)}-${clipSlug(d.text) || "clip"}.${fmt}`;
    // One ZIP with every clip, numbered in order. Without it the links still work.
    let zipId = "", zipUrl = "";
    try {
      const bytes: (Buffer | null)[] = done.map(() => null);
      let k = 0;
      const fetchOne = async () => { while (k < done.length) { const j = k++; try { bytes[j] = await download(done[j].fileId); } catch { bytes[j] = null; } } };
      await Promise.all(Array.from({ length: Math.min(BATCH_PARALLEL, done.length) }, fetchOne));
      const files = done.flatMap((d, j) => (bytes[j] ? [{ name: clipName(d), data: bytes[j]! }] : []));
      if (files.length === done.length) { zipId = await storeZip(files); zipUrl = publicZipUrl(zipId); }
    } catch { zipId = ""; zipUrl = ""; }
    const chars = done.reduce((n, d) => n + d.text.length, 0);
    const mime = fmt === "wav" ? "audio/wav" : "audio/mpeg";
    const zipName = `freetts-${done.length}-clips-${clipSlug(done[0].text).slice(0, 24) || "audio"}.zip`;
    const usedVoices = [...new Set(done.map((d) => d.voice))];
    const voiceOf = new Map(done.map((d) => [d.index, d.voice]));
    // A call without a voices list gets the result shape it always had.
    const clips = done.map((d) => ({ index: d.index, text: d.text.slice(0, 200), url: d.url,
      file: { file_id: d.fileId, download_url: d.url, mime_type: mime, file_name: clipName(d) },
      ...(own.length ? { voice: d.voice } : {}) }));
    const lines = [
      `Made ${done.length} of ${texts.length} clips ${usedVoices.length > 1 ? `in ${usedVoices.length} voices (${usedVoices.join(", ")})` : `with ${usedVoices[0] || voice}`}${failed.length ? `; ${failed.length} could not be made (listed below)` : ""}. ${chars.toLocaleString()} characters, ${fmt.toUpperCase()}.`,
      zipUrl ? `All clips in one ZIP, numbered in order: ${zipUrl} (the ZIP is kept one day).` : "The ZIP could not be made just now; each clip has its own link below.",
      "Each clip (kept 30 days):",
      ...clips.map((c) => `${num(c.index)}. ${c.url}  "${c.text.slice(0, 60)}${c.text.length > 60 ? "..." : ""}"${usedVoices.length > 1 ? `  (${voiceOf.get(c.index)})` : ""}`),
      ...failed.map((f) => `${num(f.index)}. not made: ${f.reason}`),
    ];
    const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    if (zipUrl) content.push({ type: "resource_link", uri: zipUrl, name: zipName, mimeType: "application/zip", description: `${done.length} clips, numbered in order` });
    return { content, structuredContent: {
      ...(zipUrl ? { file: { file_id: zipId, download_url: zipUrl, mime_type: "application/zip", file_name: zipName }, zip_url: zipUrl } : {}),
      clips, failed, voice, format: fmt, characters: chars,
    } };
  });

  // ── check_usage ───────────────────────────────────────────────────────
  server.registerTool("check_usage", {
    title: "Check FreeTTS usage and plan",
    description: "Show the FreeTTS plan behind this connection and what is left: characters today or this month, requests a minute, HD voices, watermark. Use it when the user asks about limits, their plan, or why a request was refused.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => {
    if (caller.kind === "anon") {
      const a = CONFIG.anon; const day = dayUsed(caller);
      if (caller.platform) return text(`No FreeTTS account is connected. Guests on ${PLATFORM_NAME[caller.platform]} share a free allowance: standard voices, ${a.perCallChars.toLocaleString()} characters a call, a short spoken FreeTTS tag at the end, files kept 1 hour. Connecting your free FreeTTS account gives you 5,000 characters a day of your own. ${keysHelp(caller)}`);
      return text(`No FreeTTS key on this connection. Free without a key: standard voices, ${a.perCallChars.toLocaleString()} characters a call, ${a.dailyChars.toLocaleString()} a day (${day.toLocaleString()} used), ${a.perMinute} requests a minute, a short spoken FreeTTS tag at the end, files kept 1 hour. ${keysHelp(caller)}`);
    }
    try {
      const u = await usage(caller.apiKey!);
      const lines = [
        `Plan: ${u.plan.toUpperCase()}${u.plan_type ? ` (${u.plan_type})` : ""}.`,
        u.daily_chars_limit != null ? `Today: ${u.daily_chars_used?.toLocaleString()} of ${u.daily_chars_limit.toLocaleString()} characters used, ${u.daily_chars_left?.toLocaleString()} left.` : "",
        `This month: ${u.monthly_chars_used.toLocaleString()} of ${u.monthly_chars_limit.toLocaleString()} characters used, ${u.monthly_chars_left.toLocaleString()} left${u.monthly_reset_date && String(u.monthly_reset_date).slice(0, 10) > today() ? `, resets ${String(u.monthly_reset_date).slice(0, 10)}` : ""}.`,
        `Per request: ${u.per_request_chars.toLocaleString()} characters. ${u.requests_per_minute} requests a minute. HD and Signature voices: ${u.hd_voices ? "yes" : "no (PRO)"}. Watermark: ${u.watermark ? "yes, on free audio" : "none"}. Files kept ${u.audio_kept}.`,
        u.plan === "free" ? `Plans: ${PRICING}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: u as unknown as Record<string, unknown> };
    } catch (e) { return fail(apiErrorText(e, caller)); }
  });

  // ── dialogue_to_speech (account) ──────────────────────────────────────
  server.registerTool("dialogue_to_speech", {
    title: "Dialogue to speech (two or more voices)",
    description: "Turn a script with several speakers into one audio file, a different FreeTTS voice per speaker, with a pause between lines. Write each line as 'Name: text'. Use it for two-host shows, interviews, scenes, language lessons with two speakers. Needs a connected FreeTTS PRO account.",
    inputSchema: {
      script: z.string().min(1).max(25000).describe("Lines like 'Abd: Tonight we cook shakshuka.' one per line. Names before the colon."),
      voices: z.record(z.string(), z.string()).optional().describe("Speaker name to FreeTTS voice id, like {\"Abd\": \"en-US-AndrewNeural\", \"Guest\": \"en-US-EmmaNeural\"}. Unnamed speakers get a voice each."),
      pause_ms: z.number().int().min(0).max(5000).optional().describe("Silence between lines in milliseconds. Default 600."),
      language: z.string().optional().describe("Language of the lines when no voices are given."),
    },
    outputSchema: DIALOGUE_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${keysHelp(caller)}`);
    if (caller.plan === "free") return fail(`Dialogue with several voices is part of FreeTTS PRO. The free plan can make single-voice audio with text_to_speech. Plans: ${PRICING}`);
    const lines = a.script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => { const m = /^([^:]{1,40}):\s*(.+)$/.exec(l); return m ? { who: m[1].trim(), text: m[2].trim() } : null; });
    if (parsed.some((x) => !x) || !parsed.length) return fail("Every line needs a speaker name before a colon, like 'Abd: Hello there.'");
    const all = await voices();
    const speakers = [...new Set(parsed.map((x) => x!.who))];
    const chosen: Record<string, string> = {};
    const pool = byLanguage(all.filter((v) => !["ultra", "prime"].includes(v.Tier || "") && v.Source !== "google"), a.language || "en-US");
    // Standard voices of the language, the usual ones first, so a scene sounds like the language's main region.
    const main = (await pickDefaultVoice(a.language || "en-US", true))?.Locale;
    const defaults = pool.filter(isFreeVoice).sort((x, y) => ((x.Locale === main ? 0 : 2) + (PREFERRED.includes(x.ShortName) ? 0 : 1)) - ((y.Locale === main ? 0 : 2) + (PREFERRED.includes(y.ShortName) ? 0 : 1)));
    const taken = () => Object.values(chosen);
    let k = 0;
    for (const s of speakers) {
      const asked = a.voices?.[s];
      if (asked) {
        const v = findVoice(all, asked, a.language);
        if (!v) return fail(`"${asked}" (for ${s}) is not a FreeTTS voice id. Use list_voices.`);
        chosen[s] = v.ShortName;
      } else {
        const gender = genderFor(s) || (k % 2 === 0 ? "male" : "female");
        const pick = defaults.find((v) => v.Gender.toLowerCase() === gender && !taken().includes(v.ShortName)) || defaults.find((v) => !taken().includes(v.ShortName)) || defaults[0];
        if (!pick) return fail(`No voice found for "${a.language}". Give voices per speaker.`);
        chosen[s] = pick.ShortName; k++;
      }
    }
    const pause = a.pause_ms ?? 600;
    try {
      const r = await multivoice(caller.apiKey!, parsed.map((x, i) => ({ speaker: x!.who.slice(0, 40), voice: chosen[x!.who], text: x!.text, pause_after_ms: i === parsed.length - 1 ? 0 : pause, trim_edges: true })));
      let fileId = r.file_id;
      if (!fileId) {
        const sa = r.segment_audio || [];
        if (!sa.length) return fail("FreeTTS returned no audio for the dialogue.");
        const m = await merge(caller.apiKey!, sa.map((x, i) => ({ file_id: x.file_id, pause_after: i === sa.length - 1 ? 0 : pause / 1000 })), 0);
        fileId = m.file_id;
      }
      const url = r.audio_url || audioUrl(fileId);
      const fileName = clipFileName(parsed[0]!.text, fileId, "mp3");
      return {
        content: [
          { type: "text", text: `Dialogue ready: ${url}\n${parsed.length} lines, ${speakers.map((s) => `${s}: ${chosen[s]}`).join("; ")}. ${pause} ms between lines. MP3, kept ${caller.plan === "free" ? "1 hour" : "30 days"}.` },
          { type: "resource_link", uri: url, name: fileName, mimeType: "audio/mpeg" },
        ],
        structuredContent: { url, file: { file_id: fileId, download_url: url, mime_type: "audio/mpeg", file_name: fileName }, lines: parsed.length, voices: chosen },
      };
    } catch (e) { return fail(apiErrorText(e, caller)); }
  });

  // ── script_to_tracks (account, PRO) ───────────────────────────────────
  server.registerTool("script_to_tracks", {
    title: "Script to timed tracks (Script mode)",
    description: "Record a script with exact timing, the way FreeTTS Script mode does: (pause 2) is exactly 2 seconds of silence, (beep), (ding) and (click) play a sound, 'CUE:' lines are read in a second voice, 'TRACK: name' starts a new audio file, 'NAME: line' makes a scene with a voice per character. Returns one file with everything plus one file per track. Use it for ear prompter tracks, voiceovers timed to footage, rehearsal tracks, workout or recipe step audio. Needs a connected FreeTTS PRO account.",
    inputSchema: {
      script: z.string().min(1).max(60000).describe("The script text. See freetts.org/text-to-speech-for-actors for the syntax."),
      line_voice: z.string().optional().describe("Voice for the main lines: a steady voice name or id (Guy, Andrew, Ava, Aria, Jenny, Brian, Emma, Sonia, Ryan, Libby, Natasha, William, Clara, Liam...). Default Guy."),
      cue_voice: z.string().optional().describe("Voice for CUE: lines and [bracketed] words. Default Aria."),
      speed: z.number().int().min(-30).max(30).optional().describe("Percent slower or faster for the main lines. Default 0."),
      sentence_pause_ms: z.number().int().min(0).max(3000).optional().describe("Silence after each sentence. Default 500."),
      paragraph_pause_ms: z.number().int().min(0).max(5000).optional().describe("Silence after each paragraph. Default 1000."),
      count_in: z.enum(["none", "3", "5", "10"]).optional().describe("Spoken count-in before each track, one number a second. Default none."),
      track_end: z.enum(["none", "beep", "end"]).optional().describe("After the last line of each track: nothing, a long beep, or the word End. Default none."),
      my_part: z.string().optional().describe("In a scene, the character you play: their lines become timed gaps for you to say them."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${keysHelp(caller)}`);
    if (caller.plan === "free") return fail(`Script mode recording is part of FreeTTS PRO. The free plan can paste a script and see its timing on freetts.org/studio?mode=script; recording needs PRO: ${PRICING}`);
    try {
      const rec = await recordScript(caller.apiKey!, a.script, {
        lineVoice: steadyVoiceId(a.line_voice, DEFAULT_SETTINGS.lineVoice),
        cueVoice: steadyVoiceId(a.cue_voice, DEFAULT_SETTINGS.cueVoice),
        lineSpeed: a.speed ?? 0,
        sentenceMs: a.sentence_pause_ms ?? DEFAULT_SETTINGS.sentenceMs,
        paragraphMs: a.paragraph_pause_ms ?? DEFAULT_SETTINGS.paragraphMs,
        countInSpoken: !!a.count_in && a.count_in !== "none",
        countFrom: a.count_in && a.count_in !== "none" ? Number(a.count_in) : 3,
        trackEnd: a.track_end || "none",
        me: a.my_part || "",
        myLines: a.my_part ? "gap" : "read",
      });
      const fmt = (s: number) => { const r = Math.max(1, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`; };
      const n = (x: number, word: string) => `${x} ${word}${x === 1 ? "" : "s"}`;
      const trackLines = rec.tracks.map((t) => `${String(t.index + 1).padStart(2, "0")} ${t.title}: ${audioUrl(t.file_id)} (${fmt(t.duration)}, ${n(t.sentences, "sentence")})`);
      const content: CallToolResult["content"] = [
        { type: "text", text: [`Recorded ${n(rec.sentences, "sentence")}${rec.tracks.length > 1 ? ` in ${rec.tracks.length} tracks` : ""}.`, `Everything in one file: ${audioUrl(rec.full.file_id)} (${fmt(rec.full.duration)})`, ...(rec.tracks.length > 1 ? trackLines : []), "MP3, kept 30 days. Pauses and sounds are exact; change a word and record again, only that sentence is new audio in the Studio."].join("\n") },
        { type: "resource_link", uri: audioUrl(rec.full.file_id), name: "freetts-script-all-tracks.mp3", mimeType: "audio/mpeg" },
        ...rec.tracks.slice(0, 20).map((t): CallToolResult["content"][number] => ({ type: "resource_link", uri: audioUrl(t.file_id), name: `${String(t.index + 1).padStart(2, "0")}-${t.title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.mp3`, mimeType: "audio/mpeg" })),
      ];
      return { content, structuredContent: { full: { url: audioUrl(rec.full.file_id), seconds: rec.full.duration }, tracks: rec.tracks.map((t) => ({ index: t.index + 1, title: t.title, url: audioUrl(t.file_id), seconds: t.duration })) } };
    } catch (e) { return fail(apiErrorText(e, caller)); }
  });

  // ── transcribe_audio + get_transcript (account, PRO) ─────────────────
  // 1.4.0: a file attached in ChatGPT (openai/fileParams) or a link, or a file on disk in local mode;
  // optional speaker labels, timestamps and SRT/WebVTT subtitles; recordings up to the plan's length
  // (PRO 4 hours), with long ones collected by get_transcript. A call without the new options answers
  // exactly as 1.3.3 did ({ text, language }).
  const sttOpts = (a: { speakers?: boolean; timestamps?: boolean; subtitles?: "srt" | "vtt" }): SttOpts =>
    ({ speakers: !!a.speakers, timestamps: !!a.timestamps, subtitles: a.subtitles });

  server.registerTool("transcribe_audio", {
    title: "Transcribe audio (speech to text)",
    description: `Turn a recording into text with FreeTTS speech to text (PRO). Give the audio as ${CONFIG.local ? "a file path on this computer (file_path), or " : ""}a file the user attached (audio_file) or a public https link to the file (audio_url): mp3, wav, m4a, ogg, flac, aac, webm, or a video file. Up to ${CONFIG.local ? "95" : "200"} MB and the plan's length per recording (PRO: 4 hours). Optional: speakers (label who speaks), timestamps (a time on every line), subtitles ('srt' or 'vtt' file). A long recording may answer with a job_id instead of the text: then call get_transcript with it.`,
    inputSchema: {
      audio_file: CHATGPT_FILE.optional().describe("A file the user attached in the chat."),
      audio_url: z.string().url().optional().describe("Public https URL of the audio file."),
      ...(CONFIG.local ? { file_path: z.string().optional().describe("Path of an audio or video file on this computer.") } : {}),
      language: z.string().optional().describe("Language of the recording, like 'en-US', 'de-DE', 'Arabic' or 'es', or 'auto' to detect it (default). Naming it is more accurate."),
      speakers: z.boolean().optional().describe("Label who is speaking (Speaker 1, Speaker 2, up to 6). Default false."),
      timestamps: z.boolean().optional().describe("Start each line with its time, like [01:15]. Default false."),
      subtitles: z.enum(["srt", "vtt"]).optional().describe("Also make a subtitle file in this format and return its link."),
    },
    outputSchema: STT_OUTPUT,
    // Reads an outside address (open world); makes nothing the caller has to undo.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: {
      "openai/fileParams": ["audio_file"],
      "openai/toolInvocation/invoking": "Transcribing the recording",
      "openai/toolInvocation/invoked": "Transcript ready",
    },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${keysHelp(caller)}`);
    if (caller.plan === "free") return fail(`Speech to text is part of FreeTTS PRO. Plans: ${PRICING}`);
    const filePath = CONFIG.local ? (a as { file_path?: string }).file_path : undefined;
    if (!a.audio_file && !a.audio_url && !filePath) return fail(`Give the recording: ${CONFIG.local ? "a file path (file_path), " : ""}a file attached in the chat (audio_file), or a public https link to it (audio_url).`);
    const owner = ownerOf(caller.apiKey!);
    if (running(owner) >= PER_OWNER) return fail(`${PER_OWNER} transcriptions are already running for this account. Collect one with get_transcript first, then try again.`);
    if (running() >= PER_SERVER) return fail("FreeTTS speech to text is busy right now. Try again in a minute.");
    const opts = sttOpts(a);
    const key = caller.apiKey!;
    let audioSeconds: number | null = null;
    const job = startJob<SttJobValue>(owner, null, async () => {
      const src = await loadRecording({ audio_file: a.audio_file, audio_url: a.audio_url, file_path: filePath });
      audioSeconds = await probeSeconds(src.buf);
      job.audioSeconds = audioSeconds;
      const locale = await sttLocale(a.language);
      const raw = await transcribe(key, src.buf, src.name, src.mime, locale, audioSeconds || 0, opts.speakers) as SttRaw;
      return { raw, opts };
    }, (e) => apiErrorText(e, caller));
    const done = await waitFor(job, WAIT_MS);
    if (!done) { handOut(job); return workingResult(job); }
    // Answered in this call: nothing about it is kept (only files the caller asked for, a day).
    forget(job);
    if (!done.ok) return fail(done.error);
    return renderTranscript(job.id, done.value, false);
  });

  server.registerTool("get_transcript", {
    title: "Get a transcript (speech to text)",
    description: "Collect the transcript of a long recording that transcribe_audio was still working on: pass the job_id it returned. Waits up to 40 seconds; if the transcript is still not ready, it says so and you call it again.",
    inputSchema: { job_id: z.string().max(64).describe("The job_id transcribe_audio returned.") },
    outputSchema: STT_OUTPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { "openai/toolInvocation/invoking": "Checking the transcript", "openai/toolInvocation/invoked": "Transcript checked" },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${keysHelp(caller)}`);
    const job = await findJob(a.job_id.trim(), ownerOf(caller.apiKey!));
    if (job === "other") return fail("That job was started with another FreeTTS account.");
    if (!job) return fail("No transcription with that job id. Jobs are kept one day; one that was running when the server restarted has to be started again with transcribe_audio.");
    const done = await waitFor(job, WAIT_MS);
    if (!done) return workingResult(job);
    if (!done.ok) return fail(done.error);
    return renderTranscript(job.id, done.value as SttJobValue, true);
  });
}

// ── Speech to text helpers (1.4.0) ─────────────────────────────────────
interface SttOpts { speakers: boolean; timestamps: boolean; subtitles?: "srt" | "vtt" }
interface SttRaw { transcript?: string; text?: string; language?: string | null; durationSec?: number; segments?: Seg[]; words?: Word[]; diarized?: boolean }
interface SttJobValue { raw: SttRaw; opts: SttOpts }

/** The largest recording: what the API accepts (200 MB), or through the public API from a computer, what Cloudflare passes. */
const STT_MAX_BYTES = CONFIG.local ? 95_000_000 : 200_000_000;
/** Characters of transcript returned in the answer; past it the whole text is a download. About 10,000 words, an hour of speech. */
export const STT_INLINE_CHARS = 60_000;
const AUDIO_EXT: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", webm: "audio/webm", mov: "video/quicktime", mkv: "video/x-matroska", amr: "audio/amr", wma: "audio/x-ms-wma" };

/** The bytes of the recording, a name the transcriber reads the format from, and its type. */
async function loadRecording(src: { audio_file?: { download_url: string; file_name?: string; mime_type?: string }; audio_url?: string; file_path?: string }): Promise<{ buf: Buffer; name: string; mime: string }> {
  const isMedia = (m: string) => /^(audio|video)\//.test(m);
  if (src.file_path) {
    const p = src.file_path.trim().replace(/^["']|["']$/g, "");
    const info = await stat(p).catch(() => null);
    if (!info || !info.isFile()) throw new FetchRefused(`No file at ${p}.`);
    if (info.size > STT_MAX_BYTES) throw new FetchRefused(`The file is over ${Math.round(STT_MAX_BYTES / 1e6)} MB. Trim it or split it, or give a link to the hosted server (https://mcp.freetts.org/mcp), which takes 200 MB.`);
    const name = basename(p); const ext = name.split(".").pop()?.toLowerCase() || "";
    return { buf: await readFile(p), name, mime: AUDIO_EXT[ext] || "audio/mpeg" };
  }
  const url = src.audio_file?.download_url || src.audio_url!;
  const { buf, mime, url: u } = await safeFetch(url, STT_MAX_BYTES, 120_000);
  const declared = (src.audio_file?.mime_type || "").toLowerCase();
  const type = isMedia(declared) ? declared : isMedia(mime) ? mime : "";
  if (!type && mime && mime !== "application/octet-stream" && !/^binary\//.test(mime)) {
    throw new FetchRefused(`That ${src.audio_file ? "file" : "address"} is ${mime.includes("html") ? "a web page" : `a file of type ${mime}`}, not audio. Give ${src.audio_file ? "an audio or video file" : "the direct link to the audio file"} (mp3, wav, m4a, ogg, flac, webm).`);
  }
  const fileName = src.audio_file?.file_name?.trim();
  const name = fileName && /\.[a-z0-9]{2,5}$/i.test(fileName) ? fileName : audioFileName(u, type || "audio/mpeg");
  return { buf, name, mime: type || AUDIO_EXT[name.split(".").pop()?.toLowerCase() || ""] || "audio/mpeg" };
}

/** The transcriber takes a full locale (en-US); 'en', 'German' or 'Arabic (Egypt)' become one, anything unknown is detected. */
async function sttLocale(language?: string): Promise<string> {
  const asked = (language || "auto").trim();
  if (/^auto$/i.test(asked) || !asked) return "auto";
  if (/^[a-z]{2,3}-[a-z]{2,4}$/i.test(asked)) return asked.replace(/^([a-z]+)-([a-z]+)$/i, (_m, l: string, r: string) => `${l.toLowerCase()}-${r.length === 2 ? r.toUpperCase() : r}`);
  return (await pickDefaultVoice(asked, false))?.Locale || "auto";
}

/** The answer while a long recording is still being transcribed. */
function workingResult(job: Job<unknown>): CallToolResult {
  const len = job.audioSeconds ? Math.round(job.audioSeconds / 60) : null;
  const exp = expectedSeconds(job.audioSeconds);
  const left = exp ? Math.max(5, exp - Math.round((Date.now() - job.started) / 1000)) : null;
  const text = `Still transcribing${len ? ` this ${len}-minute recording` : " this recording"}${left ? `, about ${left} seconds to go` : ""}. Call get_transcript with job_id "${job.id}" to collect the transcript (each call waits up to ${Math.round(WAIT_MS / 1000)} seconds). It is kept for one day.`;
  return { content: [{ type: "text", text }], structuredContent: { status: "working", job_id: job.id, audio_seconds: job.audioSeconds, expected_seconds: left } };
}

// Answers of collected jobs, so asking twice gives the same answer and files; dropped with the job after a day.
const rendered = new Map<string, { at: number; result: CallToolResult }>();
setInterval(() => { const cut = Date.now() - JOB_KEEP_MS; for (const [k, v] of rendered) if (v.at < cut) rendered.delete(k); }, 3600_000).unref();

/** The finished transcript as the caller asked for it. Without speakers, timestamps or subtitles it is the 1.3.3 answer exactly. */
export async function renderTranscript(jobId: string, v: SttJobValue, keep: boolean): Promise<CallToolResult> {
  // A collected job can be asked for again (get_transcript twice): the same answer and the same files.
  const cached = keep ? rendered.get(jobId)?.result : undefined;
  if (cached) return cached;
  const { raw, opts } = v;
  const segs = Array.isArray(raw.segments) ? raw.segments : [];
  const words = Array.isArray(raw.words) ? raw.words : [];
  const plain = (raw.transcript || raw.text || segs.map((s) => s.text || "").join(" ")).trim();
  if (!plain) return fail("FreeTTS found no speech in this recording.");
  const labelled = opts.speakers && !!raw.diarized;
  const body = opts.timestamps && segs.length ? timestamped(segs, { speakers: labelled, duration: raw.durationSec }) : labelled ? bySpeakerText(segs) : plain;
  const extra: CallToolResult["content"] = [];
  const structured: Record<string, unknown> = { status: "done", language: raw.language ?? null };
  let shown = body;
  if (body.length > STT_INLINE_CHARS) {
    const id = await storeText("txt", body);
    const url = publicTextUrl(id, "txt");
    const cut = body.slice(0, STT_INLINE_CHARS);
    const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    const wordsTotal = plain.split(/\s+/).length;
    shown = `${cut.slice(0, at > STT_INLINE_CHARS * 0.8 ? at + 1 : STT_INLINE_CHARS).trimEnd()}\n\n[The transcript is ${wordsTotal.toLocaleString("en-US")} words long; the first part is above. The whole transcript: ${url} (kept one day.)]`;
    structured.transcript_url = url;
    structured.complete = false;
    extra.push({ type: "resource_link", uri: url, name: `freetts-transcript-${id.slice(0, 8)}.txt`, mimeType: "text/plain" });
  }
  if (opts.subtitles) {
    const list = cues(words, segs, raw.language);
    const ext = opts.subtitles;
    const id = await storeText(ext, ext === "srt" ? toSrt(list, labelled) : toVtt(list, labelled));
    const url = publicTextUrl(id, ext);
    const name = `freetts-subtitles-${id.slice(0, 8)}.${ext}`;
    structured.subtitles = { format: ext, url, cues: list.length, file: { file_id: id, download_url: url, mime_type: ext === "srt" ? "application/x-subrip" : "text/vtt", file_name: name } };
    shown += `\n\nSubtitles (${ext.toUpperCase()}, ${list.length} cues): ${url} (kept one day)`;
    extra.push({ type: "resource_link", uri: url, name, mimeType: ext === "srt" ? "application/x-subrip" : "text/vtt" });
  }
  const plainOnly = !opts.speakers && !opts.timestamps && !opts.subtitles && shown === body;
  let result: CallToolResult;
  if (plainOnly) result = { content: [{ type: "text", text: plain }], structuredContent: { text: plain, language: raw.language ?? null } };
  else {
    structured.text = shown;
    if (raw.durationSec) structured.duration_seconds = Math.round(raw.durationSec);
    if (opts.speakers) {
      structured.speakers_found = new Set(segs.map((s) => s.speaker).filter((s) => s !== null && s !== undefined)).size;
      if (!labelled) shown += "\n\n(Only one voice was heard, so no speaker labels were added.)";
    }
    result = { content: [{ type: "text", text: shown }, ...extra], structuredContent: structured };
  }
  if (keep) rendered.set(jobId, { at: Date.now(), result });
  return result;
}

/** Length of the recording in seconds from ffprobe, or null when it cannot be read (or ffprobe is missing, as on some computers). */
async function probeSeconds(buf: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "ftstt-"));
  try {
    const f = join(dir, "in");
    await writeFile(f, buf);
    const probe = CONFIG.ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, x) => `ffprobe${x || ""}`);
    return await new Promise((res) => execFile(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { timeout: 20_000 }, (err, out) => {
      const n = parseFloat(String(out));
      res(!err && isFinite(n) && n > 0 ? n : null);
    }));
  } catch { return null; } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

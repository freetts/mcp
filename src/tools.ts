// The tools. Descriptions are written for the model that reads them: what
// the tool does and when to use it, nothing else.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./config.js";
import { voices, isFreeVoice, tierLabel, tts, usage, multivoice, merge, transcribe, download, audioUrl, ApiError, byLanguage, findVoice, type Voice } from "./freetts.js";
import { safeFetch, FetchRefused, audioFileName } from "./safefetch.js";
import { watermarkAndStore, publicAudioUrl, storedPath, durationSeconds, requestHash } from "./audio.js";
import { store, today } from "./store.js";
import { recordScript, steadyVoiceId } from "./script/record.js";
import { DEFAULT_SETTINGS } from "./script/scriptModel.js";
import { readFile } from "node:fs/promises";

export interface Caller {
  kind: "anon" | "key";
  apiKey?: string;
  plan?: string;
  ip: string;
  userAgent: string;
  /** Set when the call comes from claude.ai's or ChatGPT's servers: guests there cannot be told apart. */
  platform?: "claude" | "chatgpt" | null;
}

/** Tools that need an account. Calls without a token get a 401 before the SDK runs (see index.ts). */
export const PROTECTED_TOOLS = new Set(["dialogue_to_speech", "script_to_tracks", "transcribe_audio"]);

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const DASH = `${CONFIG.siteUrl}/dashboard`;
const PRICING = `${CONFIG.siteUrl}/pricing`;
const KEYS_HELP = `Get a key: ${DASH} (API keys). A free account has one key with 5,000 characters a day; PRO has HD voices, no watermark and 1,000,000 characters a month (${PRICING}).`;

// Refusals that a plan changes; only these get a pointer to the plans.
const PLAN_LIMITS = new Set(["daily", "monthly", "monthly_chars", "per_gen", "pro_feature", "creator_required", "trial_cap", "trial_velocity", "trial_ended"]);

function apiErrorText(e: unknown, caller: Caller): string {
  if (e instanceof ApiError) {
    const d = e.detail as { error?: string; limit_type?: string } | string;
    // FastAPI's own validation errors arrive as a list of {loc, msg}.
    const list = Array.isArray(e.detail) ? (e.detail as Array<{ loc?: unknown[]; msg?: string }>).map((x) => `${(x.loc || []).slice(-1)[0] ?? "input"}: ${x.msg}`).join("; ") : "";
    const msg = list ? `FreeTTS did not accept the request (${list}).` : typeof d === "string" ? d : d?.error || e.message;
    const lt = typeof d === "object" && d ? d.limit_type || "" : "";
    if (e.status === 429) return `FreeTTS is rate limiting this ${caller.kind === "anon" ? "connection" : "key"} (too many requests in a minute). Wait a moment and try again.`;
    // Callers without a key share the service account: its caps are the free pool, not theirs.
    if (caller.kind === "anon" && (e.status === 402 || PLAN_LIMITS.has(lt))) return `The free allowance for callers without an account is used up for now. A free FreeTTS key keeps working: ${KEYS_HELP}`;
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
  if (chars > a.perCallChars) return `Without a FreeTTS key, one call can read up to ${a.perCallChars.toLocaleString()} characters; this text is ${chars.toLocaleString()}. Split it, or add a key. ${KEYS_HELP}`;
  const s = store.get();
  const m = (s.anon[meterKey(caller)] ||= { calls: [], chars: [] });
  const now = Date.now();
  const perMinute = caller.platform ? a.platformPerMinute : a.perMinute;
  m.calls = m.calls.filter((t) => t > now - 60_000);
  if (m.calls.length >= perMinute) return `Without a key, this connection can make ${perMinute} requests a minute. Wait a moment, or add a key. ${KEYS_HELP}`;
  m.chars = m.chars.filter(([t]) => t > now - 86_400_000);
  const day = m.chars.reduce((x, [, c]) => x + c, 0);
  if (caller.platform) {
    if (day + chars > a.platformDailyChars) return `Free audio without an account is used up for today on ${PLATFORM_NAME[caller.platform]}. Connect your free FreeTTS account to keep going with 5,000 characters a day of your own: ${DASH} (API keys).`;
  } else {
    const hour = m.chars.filter(([t]) => t > now - 3_600_000).reduce((x, [, c]) => x + c, 0);
    if (day + chars > a.dailyChars) return `Without a key, FreeTTS reads ${a.dailyChars.toLocaleString()} characters a day per connection; ${day.toLocaleString()} are used. ${KEYS_HELP}`;
    if (hour + chars > a.hourlyChars) return `Without a key, FreeTTS reads ${a.hourlyChars.toLocaleString()} characters an hour per connection. Try again later, or add a key. ${KEYS_HELP}`;
  }
  const pool = s.pool[today()] || 0;
  if (pool + chars > a.poolDailyChars) return `The free pool for callers without an account is used up for today. A free FreeTTS key keeps working: ${KEYS_HELP}`;
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
const recent = new Map<string, { at: number; result: CallToolResult }>();
setInterval(() => { const cut = Date.now() - 600_000; for (const [k, v] of recent) if (v.at < cut) recent.delete(k); }, 60_000).unref();

const langOf = (v: Voice) => v.LocaleName || v.Locale;
const voiceLine = (v: Voice) => `${v.ShortName} (${v.FriendlyName || v.ShortName.split("-").slice(2).join("-").replace(/Neural$/, "")}, ${v.Gender}, ${langOf(v)}, ${tierLabel(v)}${isFreeVoice(v) ? ", free" : ", PRO"})`;

// The voice a language gets when none is named: the usual one for its main region.
const PREFERRED = ["en-US-JennyNeural", "en-US-AndrewNeural", "en-US-AriaNeural", "en-GB-SoniaNeural", "en-AU-NatashaNeural", "en-IN-NeerjaNeural", "de-DE-KatjaNeural", "fr-FR-DeniseNeural", "fr-CA-SylvieNeural", "es-ES-ElviraNeural", "es-MX-DaliaNeural", "pt-BR-FranciscaNeural", "pt-PT-RaquelNeural", "it-IT-ElsaNeural", "ja-JP-NanamiNeural", "ko-KR-SunHiNeural", "ar-SA-ZariyahNeural", "ar-EG-SalmaNeural", "hi-IN-SwaraNeural", "zh-CN-XiaoxiaoNeural", "nl-NL-ColetteNeural", "tr-TR-EmelNeural", "ru-RU-SvetlanaNeural", "pl-PL-ZofiaNeural"];

async function pickDefaultVoice(language: string | undefined, free: boolean): Promise<Voice | null> {
  const all = (await voices()).filter((v) => (v.Tier || "") !== "ultra" && (free ? isFreeVoice(v) : true));
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
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  }, async (a) => {
    const all = await voices();
    const want = (a.language || "").toLowerCase().trim();
    const q = (a.search || "").toLowerCase().trim();
    let list = all.filter((v) => (v.Tier || "") !== "ultra");
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
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  }, async (a) => {
    const all = await voices();
    const want = a.language.toLowerCase().trim();
    let pool = byLanguage(all.filter((v) => (v.Tier || "") !== "ultra"), want);
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
    return text(picks.map(([v, why], i) => `${i + 1}. ${v.ShortName} (${v.FriendlyName || ""}, ${v.Gender}, ${langOf(v)}): ${why}.`).join("\n") + `\n\nPass the id to text_to_speech as voice.${caller.kind === "anon" ? " Without a key the free voices work; " + KEYS_HELP : ""}`);
  });

  // ── text_to_speech ────────────────────────────────────────────────────
  server.registerTool("text_to_speech", {
    title: "Text to speech (FreeTTS)",
    description: `Convert text to spoken audio with a FreeTTS voice and return a download link to the MP3 (or WAV with a FreeTTS PRO key). Use it when the user wants text read aloud, narrated, or saved as an audio file. Without a FreeTTS key: standard voices, up to ${CONFIG.anon.perCallChars.toLocaleString()} characters a call, a short spoken "FreeTTS" tag at the end, file kept one hour. With a key: the account's plan (PRO: HD and Signature voices, no tag, 10,000 characters a call, files kept 30 days).`,
    inputSchema: {
      text: z.string().min(1).max(30000).describe("The text to read. Plain text; SSML is not needed."),
      voice: z.string().optional().describe("A FreeTTS voice id from list_voices, like en-US-JennyNeural (a short name like 'Jenny' also works). If empty, a good standard voice for the language is chosen."),
      language: z.string().optional().describe("Language of the text when no voice is given, like 'German' or 'pt-BR'."),
      speed: z.number().int().min(-30).max(30).optional().describe("Percent slower (negative) or faster (positive). Default 0."),
      format: z.enum(["mp3", "wav"]).optional().describe("mp3 (default) or wav (FreeTTS PRO)."),
      include_audio: z.boolean().optional().describe("Also return the audio bytes in the result (large). Default false; the link is enough for most clients."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    const chars = a.text.length;
    if (!a.text.trim()) return fail("The text is empty. Give the words to read.");
    let voice = (a.voice || "").trim();
    const all = await voices();
    let v = voice ? findVoice(all, voice, a.language) : undefined;
    if (voice && !v) return fail(`"${voice}" is not a FreeTTS voice id. Use list_voices to find one (ids look like en-US-JennyNeural or de-DE-Florian:DragonHDLatestNeural).`);
    if (v) voice = v.ShortName;   // the id the API knows, whatever form the caller used
    if (v && (v.Tier || "") === "ultra") return fail(`${v.ShortName} is an Ultra voice, available on freetts.org only, not through the API. Pick another voice from list_voices.`);
    const isAnon = caller.kind === "anon";
    let note = "";
    if (!v) {
      const d = await pickDefaultVoice(a.language, isAnon);
      if (!d) return fail(`No FreeTTS voice for "${a.language}". list_voices with no language shows what exists.`);
      v = d; voice = d.ShortName;
    } else if (isAnon && !isFreeVoice(v)) {
      const alt = await pickDefaultVoice(v.Locale, true);
      if (!alt) return fail(`${v.ShortName} needs a FreeTTS PRO key and there is no free voice for ${langOf(v)}. ${KEYS_HELP}`);
      note = `${v.ShortName} is a ${tierLabel(v)} voice, which needs a FreeTTS PRO key. This audio uses the closest free voice instead, ${alt.ShortName}. ${KEYS_HELP}\n`;
      v = alt; voice = alt.ShortName;
    }
    const fmt = a.format || "mp3";
    if (isAnon && fmt === "wav") return fail(`WAV is part of FreeTTS PRO. Without a key the audio is MP3. ${KEYS_HELP}`);
    if (fmt === "wav" && caller.plan === "free") return fail(`WAV is part of FreeTTS PRO; a free key gets MP3. Plans: ${PRICING}`);
    const rate = a.speed ? `${a.speed > 0 ? "+" : ""}${a.speed}%` : undefined;
    const hk = requestHash([caller.kind, caller.kind === "key" ? caller.apiKey! : meterKey(caller), a.text, voice, fmt, rate || ""]);
    const cached = recent.get(hk);
    if (cached) return cached.result;
    let refund: (() => void) | null = null;
    if (isAnon) {
      const why = anonCheck(caller, chars);
      if (why) return fail(why);
      if (!CONFIG.serviceApiKey) return fail(`Calls without a key are not set up on this server yet. ${KEYS_HELP}`);
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
      const dur = localId ? await durationSeconds(storedPath(localId)!) : null;
      const content: CallToolResult["content"] = [
        { type: "text", text: `${note}Audio ready: ${url}\nVoice: ${r.voice}${r.downgraded ? " (the requested Signature voice was over its cap, so a matching standard voice was used)" : ""}. ${chars.toLocaleString()} characters${dur ? `, about ${Math.round(dur)} seconds` : ""}. ${fmt.toUpperCase()}, kept ${kept}.${isAnon ? " Ends with a short spoken FreeTTS tag; a FreeTTS key removes it." : r.watermark && r.watermark !== "none" ? " Ends with a short spoken FreeTTS tag (free plan)." : ""}` },
        { type: "resource_link", uri: url, name: `freetts-${(r.voice || voice).replace(/[^A-Za-z0-9]+/g, "-")}.${fmt}`, mimeType: fmt === "wav" ? "audio/wav" : "audio/mpeg", description: `Spoken audio, ${chars} characters, voice ${r.voice}` },
      ];
      if (a.include_audio) {
        const bytes = localId ? await readFile(storedPath(localId)!) : await download(r.file_id);
        if (bytes.length <= 4_000_000) content.push({ type: "audio", data: bytes.toString("base64"), mimeType: fmt === "wav" ? "audio/wav" : "audio/mpeg" });
        else content.push({ type: "text", text: "The audio is over 4 MB, so only the link is returned." });
      }
      const result: CallToolResult = { content, structuredContent: { url, voice: r.voice, format: fmt, characters: chars, seconds: dur, kept, free_tier: isAnon } };
      recent.set(hk, { at: Date.now(), result });
      return result;
    } catch (e) { refund?.(); return fail(apiErrorText(e, caller)); }
  });

  // ── check_usage ───────────────────────────────────────────────────────
  server.registerTool("check_usage", {
    title: "Check FreeTTS usage and plan",
    description: "Show the FreeTTS plan behind this connection and what is left: characters today or this month, requests a minute, HD voices, watermark. Use it when the user asks about limits, their plan, or why a request was refused.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  }, async () => {
    if (caller.kind === "anon") {
      const a = CONFIG.anon; const day = dayUsed(caller);
      if (caller.platform) return text(`No FreeTTS account is connected. Guests on ${PLATFORM_NAME[caller.platform]} share a free allowance: standard voices, ${a.perCallChars.toLocaleString()} characters a call, a short spoken FreeTTS tag at the end, files kept 1 hour. Connecting your free FreeTTS account gives you 5,000 characters a day of your own. ${KEYS_HELP}`);
      return text(`No FreeTTS key on this connection. Free without a key: standard voices, ${a.perCallChars.toLocaleString()} characters a call, ${a.dailyChars.toLocaleString()} a day (${day.toLocaleString()} used), ${a.perMinute} requests a minute, a short spoken FreeTTS tag at the end, files kept 1 hour. ${KEYS_HELP}`);
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${KEYS_HELP}`);
    if (caller.plan === "free") return fail(`Dialogue with several voices is part of FreeTTS PRO. The free plan can make single-voice audio with text_to_speech. Plans: ${PRICING}`);
    const lines = a.script.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => { const m = /^([^:]{1,40}):\s*(.+)$/.exec(l); return m ? { who: m[1].trim(), text: m[2].trim() } : null; });
    if (parsed.some((x) => !x) || !parsed.length) return fail("Every line needs a speaker name before a colon, like 'Abd: Hello there.'");
    const all = await voices();
    const speakers = [...new Set(parsed.map((x) => x!.who))];
    const chosen: Record<string, string> = {};
    const pool = byLanguage(all.filter((v) => (v.Tier || "") !== "ultra" && v.Source !== "google"), a.language || "en-US");
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
      return {
        content: [
          { type: "text", text: `Dialogue ready: ${url}\n${parsed.length} lines, ${speakers.map((s) => `${s}: ${chosen[s]}`).join("; ")}. ${pause} ms between lines. MP3, kept ${caller.plan === "free" ? "1 hour" : "30 days"}.` },
          { type: "resource_link", uri: url, name: "freetts-dialogue.mp3", mimeType: "audio/mpeg" },
        ],
        structuredContent: { url, lines: parsed.length, voices: chosen },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${KEYS_HELP}`);
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

  // ── transcribe_audio (account) ────────────────────────────────────────
  server.registerTool("transcribe_audio", {
    title: "Transcribe audio (speech to text)",
    description: "Turn a recording into text with FreeTTS speech to text. Give a public https URL to an audio file (mp3, wav, m4a, ogg, webm). Needs a connected FreeTTS PRO account.",
    inputSchema: {
      audio_url: z.string().url().describe("Public https URL of the audio file."),
      language: z.string().optional().describe("Language of the recording, like 'en-US', 'de-DE', 'Arabic' or 'es', or 'auto' to detect it (default)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  }, async (a) => {
    if (caller.kind !== "key") return fail(`This tool needs a connected FreeTTS account. ${KEYS_HELP}`);
    if (caller.plan === "free") return fail(`Speech to text is part of FreeTTS PRO. Plans: ${PRICING}`);
    try {
      const { buf, mime, url } = await safeFetch(a.audio_url, 60_000_000);
      if (mime && !/^(audio|video)\//.test(mime) && mime !== "application/octet-stream") return fail(`That address is ${mime.includes("html") ? "a web page" : `a ${mime} file`}, not audio. Give the direct link to the audio file (mp3, wav, m4a, ogg, webm).`);
      const type = /^(audio|video)\//.test(mime) ? mime : "audio/mpeg";
      // The transcriber takes a full locale (en-US); 'en', 'German' or 'Arabic (Egypt)' become one, anything unknown is detected.
      const asked = (a.language || "auto").trim();
      const locale = /^auto$/i.test(asked) ? "auto" : /^[a-z]{2,3}-[a-z]{2,4}$/i.test(asked) ? asked.replace(/^([a-z]+)-([a-z]+)$/i, (_m, l: string, r: string) => `${l.toLowerCase()}-${r.length === 2 ? r.toUpperCase() : r}`) : (await pickDefaultVoice(asked, false))?.Locale || "auto";
      const res = await transcribe(caller.apiKey!, buf, audioFileName(url, type), type, locale);
      const out = (res.text || res.transcript || (Array.isArray(res.segments) ? (res.segments as Array<{ text?: string }>).map((s) => s.text || "").join(" ") : "")) as string;
      if (!out) return fail("FreeTTS returned no text for this file.");
      return { content: [{ type: "text", text: out }], structuredContent: { text: out, language: res.language ?? null } };
    } catch (e) { return fail(apiErrorText(e, caller)); }
  });
}

// Script mode — the model behind an "ear prompter" recording, and behind
// running lines for a scene.
//
// A pasted script becomes sentences, each with its voice (your lines, cues, or
// a scene character), an exact silence after it and an audio identity (key).
// The key is what makes edits cheap: a sentence whose key already has audio is
// never recorded again, so fixing one word records one sentence. Inside that
// sentence the untouched phrases keep their old audio too: sentences are cut
// at their exact comma/semicolon/colon silences (the server reports where) and
// only the phrase that changed is taken from the new recording. A pause added
// after punctuation opens the silence that is already there: no recording.
//
// Sounds ((beep), (ding), (click)) and silences are laid in when joining, so
// adding one never records anything again, except a sound between two words,
// which needs one short silence recorded there to cut at.
//
// Pure functions: no DOM, no network.

export type Kind = "line" | "cue" | "cast";
export type SoundKind = "beep" | "ding" | "click";
export interface Sound { kind: SoundKind; ms: number }

export interface SayAs { from: string; to: string }

export interface Settings {
  lineVoice: string;
  cueVoice: string;
  /** Percent change from the voice's normal pace, -30..+30. */
  lineSpeed: number;
  cueSpeed: number;
  commaMs: number;
  sentenceMs: number;
  paragraphMs: number;
  /** Silence after a cue line. */
  cueMs: number;
  /** Silence after a cue that only asks the room to react ("Wait here."). */
  waitMs: number;
  countInMs: number;
  /** The count-in said on the beat ("Three. Two. One.") instead of silence. */
  countInSpoken: boolean;
  /** The spoken count-in starts from this number (1 to 10), one number a second. */
  countFrom: number;
  /** What marks the end of every track. */
  trackEnd: "none" | "beep" | "end";
  /** Your lines: read aloud (ear prompter), a timed gap to say them yourself
   *  (running lines), or read quietly (learning them). */
  myLines: "read" | "gap" | "quiet";
  /** Running lines: your gap is this % of the time the voice takes to say
   *  your line, plus myExtraMs. */
  myRoomPct: number;
  myExtraMs: number;
  /** Running lines: a short beep when it is your turn. */
  myBeep: boolean;
  /** A scene character that is you ("" = only ME: lines are yours). */
  me: string;
  /** Scene characters and their voices, kept once given so they never shift. */
  cast: Record<string, string>;
  castSpeed: number;
  sayAs: SayAs[];
}

export const DEFAULT_SETTINGS: Settings = {
  lineVoice: "en-US-GuyNeural",
  cueVoice: "en-US-AriaNeural",
  lineSpeed: 0,
  cueSpeed: 0,
  commaMs: 300,
  sentenceMs: 500,
  paragraphMs: 1000,
  cueMs: 1000,
  waitMs: 1000,
  countInMs: 0,
  countInSpoken: false,
  countFrom: 3,
  trackEnd: "none",
  myLines: "read",
  myRoomPct: 120,
  myExtraMs: 500,
  myBeep: true,
  me: "",
  cast: {},
  castSpeed: 0,
  sayAs: [],
};

/** Steady voices: every one measured to sound identical when recorded again
 *  (2026-09-28, waveform correlation ≥ 0.9998), so an edit never changes the
 *  delivery of anything else. Previews: /studio/script-voices/<id>.mp3 */
export interface SteadyVoice { id: string; name: string; accent: "US" | "UK" | "Australia" | "Canada"; gender: "m" | "f" }
export const STEADY_VOICES: SteadyVoice[] = [
  { id: "en-US-GuyNeural", name: "Guy", accent: "US", gender: "m" },
  { id: "en-US-AndrewNeural", name: "Andrew", accent: "US", gender: "m" },
  { id: "en-US-BrianNeural", name: "Brian", accent: "US", gender: "m" },
  { id: "en-US-ChristopherNeural", name: "Christopher", accent: "US", gender: "m" },
  { id: "en-US-DavisNeural", name: "Davis", accent: "US", gender: "m" },
  { id: "en-US-EricNeural", name: "Eric", accent: "US", gender: "m" },
  { id: "en-US-RogerNeural", name: "Roger", accent: "US", gender: "m" },
  { id: "en-US-SteffanNeural", name: "Steffan", accent: "US", gender: "m" },
  { id: "en-US-AriaNeural", name: "Aria", accent: "US", gender: "f" },
  { id: "en-US-JennyNeural", name: "Jenny", accent: "US", gender: "f" },
  { id: "en-US-AvaNeural", name: "Ava", accent: "US", gender: "f" },
  { id: "en-US-EmmaNeural", name: "Emma", accent: "US", gender: "f" },
  { id: "en-US-MichelleNeural", name: "Michelle", accent: "US", gender: "f" },
  { id: "en-US-NancyNeural", name: "Nancy", accent: "US", gender: "f" },
  { id: "en-GB-RyanNeural", name: "Ryan", accent: "UK", gender: "m" },
  { id: "en-GB-ThomasNeural", name: "Thomas", accent: "UK", gender: "m" },
  { id: "en-GB-SoniaNeural", name: "Sonia", accent: "UK", gender: "f" },
  { id: "en-GB-LibbyNeural", name: "Libby", accent: "UK", gender: "f" },
  { id: "en-AU-WilliamMultilingualNeural", name: "William", accent: "Australia", gender: "m" },
  { id: "en-AU-NatashaNeural", name: "Natasha", accent: "Australia", gender: "f" },
  { id: "en-CA-LiamNeural", name: "Liam", accent: "Canada", gender: "m" },
  { id: "en-CA-ClaraNeural", name: "Clara", accent: "Canada", gender: "f" },
];
export const voiceById = (id: string) => STEADY_VOICES.find((v) => v.id === id);
export const voiceName = (id: string) => voiceById(id)?.name || id.replace(/^[a-z]{2}-[A-Z]{2}-/, "").replace(/(Multilingual)?Neural$/, "");

/** The order scene characters get voices in: men and women alternating, the
 *  voices your lines and cues use skipped. */
const CAST_POOL = [
  "en-US-AndrewNeural", "en-US-AvaNeural", "en-US-BrianNeural", "en-US-EmmaNeural", "en-GB-RyanNeural",
  "en-GB-SoniaNeural", "en-US-ChristopherNeural", "en-US-MichelleNeural", "en-US-EricNeural", "en-US-NancyNeural",
  "en-AU-WilliamMultilingualNeural", "en-AU-NatashaNeural", "en-CA-LiamNeural", "en-CA-ClaraNeural", "en-GB-ThomasNeural",
  "en-GB-LibbyNeural", "en-US-RogerNeural", "en-US-JennyNeural", "en-US-DavisNeural", "en-US-AriaNeural",
  "en-US-SteffanNeural", "en-US-GuyNeural",
];
/** Voices for characters that have none yet (kept in settings once given). */
export function castVoices(names: string[], st: Settings): Record<string, string> {
  const out: Record<string, string> = { ...st.cast };
  const used = new Set<string>([st.lineVoice, st.cueVoice, ...Object.values(out)]);
  for (const n of names) {
    if (out[n]) continue;
    const v = CAST_POOL.find((x) => !used.has(x)) || CAST_POOL[Object.keys(out).length % CAST_POOL.length];
    out[n] = v;
    used.add(v);
  }
  return out;
}

/** The server cuts every sentence to 50 ms of silence before its first word
 *  and 50 ms after its last (app.py _trim_edges). Taken off every pause
 *  between sentences, so the gap you hear is the number you set. */
export const EDGE_MS = 100;
export const MAX_BATCH_SEGMENTS = 25;   // sentences per recording call
export const MAX_BATCH_CHARS = 4000;    // characters per recording call
export const MAX_JOIN_CLIPS = 380;      // clips per join (server allows 400)

/** Sounds: how long each lasts (a beep's or a ding's length can be written: (beep 2), (ding 0.5)). */
export const SOUND_MS: Record<SoundKind, number> = { beep: 250, ding: 900, click: 60 };
/** Silence between the last word and a sound, and between two sounds. */
export const SOUND_LEAD_MS = 150;
/** Silence after a sound placed between two words, before the next word. */
export const MID_SOUND_AFTER_MS = 150;
/** The short silence recorded where a sound sits between two words, so the
 *  sentence can be cut there. */
const MID_SOUND_BREAK_MS = 300;
/** The spoken count-in: one number a second, the track starting on the next beat. */
export const COUNT_WORDS = ["One.", "Two.", "Three.", "Four.", "Five.", "Six.", "Seven.", "Eight.", "Nine.", "Ten."];
const COUNT_BEAT_S = 1;
/** Running lines: the beep that says it is your turn. */
export const TURN_BEEP_MS = 150;
/** The long beep that can end every track. */
export const END_BEEP_MS = 1500;
/** "Read quietly": your lines at this volume (about 9 dB under the rest). */
export const QUIET_VOLUME = 0.35;
/** Silence between tracks in the one-file recording. */
export const TRACK_GAP_MS = 2000;
/** Inner pauses a sentence is RECORDED with. They only have to be a clear
 *  silence the server can find: the joiner sets each one to its exact length. */
export const RECORD_COMMA_MS = 300;
export const RECORD_SENTENCE_MS = 500;

export interface Range { start: number; end: number }

export interface Piece {
  i: number;
  kind: Kind;
  /** As written, markers removed (what the list shows). */
  text: string;
  /** What the engine reads: say-as applied, in-phrase pauses as ⟦pN⟧. */
  speak: string;
  voice: string;
  speed: number;
  track: number;
  line: number;
  /** Where the sentence sits in the script text. */
  range: Range;
  /** How its voice was chosen, so one click can change it in the script. */
  src: "plain" | "cueLine" | "bracketLine" | "inlineCue" | "who" | "me" | "direction" | "label";
  /** Scene scripts: the character speaking ("ME" for ME: lines). */
  who?: string;
  /** A cue that only asks the room to react ("Wait here."): the wait length follows it. */
  wait?: boolean;
  /** Exact silence after this sentence. */
  gapAfterMs: number;
  /** A pause written right after punctuation: boundary k -> total ms. Opens
   *  the silence already there, so nothing is recorded again. */
  opens: Record<number, number>;
  /** Phrases of `speak`: where the engine leaves an exact silence. */
  phrases: string[];
  /** Exact silence (ms) after each phrase but the last: a comma pause, an
   *  inner sentence pause, an in-phrase (pause N), or one written after
   *  punctuation. Set when joining, so it never changes the recording. */
  bounds: number[];
  /** Sounds at inner boundary k (after phrase k), before its pause. */
  sounds: Record<number, Sound[]>;
  /** Sounds after this sentence, before the pause that follows it. */
  after: Sound[];
  key: string;
}

export interface Track {
  index: number;
  /** From its TRACK: line, else the first words of the track. */
  title: string;
  named: boolean;
  from: number;
  to: number;
  line: number;
  /** Sounds written before the track's first sentence. */
  lead: Sound[];
}
export interface Mark { range: Range; type: "pause" | "sound" | "track" | "cueTag" | "who" | "skip" }
export interface Parsed {
  pieces: Piece[];
  tracks: Track[];
  marks: Mark[];
  words: number;
  chars: number;
  /** Scene characters in order of appearance (ME: and your own part excluded). */
  cast: string[];
  /** Every character name found, your own part included. */
  characters: string[];
  /** The script names characters, so lines without a name are stage directions. */
  scene: boolean;
  /** The spoken count-in ("Three." "Two." "One.", or from five or ten), when that is on. */
  count: Piece[];
  /** The spoken track end ("End."), when that is on. */
  end: Piece | null;
}

// ── Syntax ─────────────────────────────────────────────────────────────────
const MARK_SRC = String.raw`\(\s*(pause|wait|beat|hold|beep|tone|ding|bell|click)\b\s*(\d+(?:\.\d+)?)?\s*(?:s|sec|secs|second|seconds)?\s*\)`;
const MARK_RX = new RegExp(MARK_SRC, "gi");
const ONLY_MARKS = new RegExp(`^(?:\\s*${MARK_SRC})+\\s*$`, "i");
// "TRACK: Welcome", "Track 2: Sponsors", "TRACK" alone. A colon or dash is
// required, so a line like "Track meets are fun." is still read aloud.
const TRACK_LINE = /^track(?:\s*(\d+))?\s*(?:[:\-–—]\s*([\s\S]*))?$/i;
const CUE_LINE = /^cue\s*[:\-–—]\s*/i;
const ME_LINE = /^me\s*:\s*/i;
// "NORA: Where were you?"  "Nora (quietly): Where were you?"
const NAME_LINE = /^([A-Za-z][A-Za-z0-9.'’ -]{0,28}?)\s*(?:\(([^()]{1,40})\))?\s*:\s*(\S[\s\S]*)$/;
// A screenplay character heading on its own line: "NORA", "NORA (V.O.)".
const BLOCK_NAME = /^([A-Z][A-Z0-9.'’ -]{0,28}[A-Z0-9.])(?:\s*\((?:V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?|CONT'?’?D\.?)\))?$/;
// Production labels at the start of a line ("VIDEO: Play the reel.", "SLIDE:
// 4"): the whole line is read in the cue voice, and never becomes a character.
const CUE_LABELS = new Set(["VIDEO", "MUSIC", "LIGHTS", "LIGHTING", "AUDIO", "SOUND", "SFX", "SLIDE", "SLIDES",
  "SCREEN", "STAGE", "PROJECTION", "PROP", "PROPS", "TRANSITION", "CAMERA", "GRAPHIC", "GRAPHICS", "LOWER THIRD",
  "WALK UP", "WALK-UP", "WALKUP", "PLAYON", "PLAY ON", "PLAY-ON", "BREAK", "DIRECTION", "ACTION", "BEAT"]);
const LABEL_LINE = /^([A-Za-z][A-Za-z -]{1,20}?)\s*:\s*\S/;
// Words that start a line with a colon but are never a character.
const NOT_NAMES = new Set(["CUE", "TRACK", "ME", "NOTE", "NOTES", "TIP", "TIPS", "WARNING",
  "TIME", "DATE", "SCENE", "ACT", "INT", "EXT", "PS", "RE", "FYI", "TODO", "EDIT", "UPDATE", "SUBJECT", ...CUE_LABELS]);
// A cue that only asks the room to react: gets the wait length after it.
const WAIT_RX = /^(?:(?:wait|hold|pause)(?:\s+(?:here|there|now|a\s+moment|for\b[^.!?]*))?|applause|laughter|laughs?|cheers?)[\s.!…]*$/i;
const PH = "";   // stands in for a marker while sentences are split
const PAREN_ONLY = /^\([^()]*\)$/;

type Marker = { t: "pause"; ms: number } | { t: "sound"; sound: Sound };
const clampPauseMs = (v: number) => Math.max(0, Math.min(60000, Math.round(v / 10) * 10));
function markerOf(whole: string): Marker {
  const m = new RegExp(MARK_SRC, "i").exec(whole);
  const word = (m?.[1] || "pause").toLowerCase();
  const n = m?.[2] ? parseFloat(m[2]) : NaN;
  if (word === "beep" || word === "tone") {
    const ms = isFinite(n) ? Math.max(100, Math.min(10000, Math.round(n * 1000))) : SOUND_MS.beep;
    return { t: "sound", sound: { kind: "beep", ms } };
  }
  if (word === "ding" || word === "bell") {
    const ms = isFinite(n) ? Math.max(200, Math.min(5000, Math.round(n * 1000))) : SOUND_MS.ding;
    return { t: "sound", sound: { kind: "ding", ms } };
  }
  if (word === "click") return { t: "sound", sound: { kind: "click", ms: SOUND_MS.click } };
  return { t: "pause", ms: clampPauseMs(isFinite(n) ? n * 1000 : 1000) };
}

// ── Sentences ──────────────────────────────────────────────────────────────
const ABBREV = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "etc", "inc", "ltd", "co", "corp",
  "no", "vol", "fig", "gen", "col", "lt", "sgt", "capt", "rev", "hon", "gov", "sen", "rep", "pres", "ave", "blvd", "rd",
  "dept", "est", "approx", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

/** Split into sentences; offsets relative to `s`. A period after an
 *  abbreviation or a single capital ("Dr.", "U.S.", initials) never ends one,
 *  and a sentence only ends before something that can start one. */
export function splitSentences(s: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const rx = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    const endP = m.index + m[0].length;
    const rest = s.slice(endP);
    const ws = (rest.match(/^\s*/) || [""])[0].length;
    const next = rest.charAt(ws);
    if (next && !/[A-Z0-9"“'‘(\[¿¡]/.test(next)) continue;   //  = a marker (PH)
    if (m[0][0] === ".") {
      const w = (s.slice(start, m.index).match(/([A-Za-z]+)$/) || ["", ""])[1];
      if (w && (ABBREV.has(w.toLowerCase()) || (w.length === 1 && /[A-Z]/.test(w)))) continue;
    }
    if (s.slice(start, endP).trim()) out.push({ text: s.slice(start, endP), start, end: endP });
    start = endP + ws;
  }
  if (s.slice(start).trim()) out.push({ text: s.slice(start), start, end: s.length });
  return out;
}

/** Phrase boundaries of an engine string — the same places the server puts
 *  an exact silence: , ; : before a space, an in-phrase pause, or a sentence
 *  end kept inside the sentence. Boundary k is the k-th silence it reports. */
const BOUNDARY_SRC = String.raw`(?:[,;:](?=\s))|(?:\s*⟦p\d+⟧\s*)|(?:[.!?]["'”’)]*(?=\s+\S))`;
const countBoundaries = (s: string) => (s.match(new RegExp(BOUNDARY_SRC, "g")) || []).length;
export function splitPhrases(speak: string): string[] {
  const rx = new RegExp(BOUNDARY_SRC, "g");
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(speak))) {
    const end = m.index + m[0].length;
    out.push(speak.slice(last, end).trim());
    last = end;
  }
  out.push(speak.slice(last).trim());
  return out;
}
export const hasInnerSentence = (speak: string) => /[.!?]["'”’)]*\s+\S/.test(speak.trim());

// ── Say it right ───────────────────────────────────────────────────────────
const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole word or name in any case: "Hanlon" is found in "Hanlon's", never in "Hanlonville". */
const wordRx = (word: string, flags: string) => new RegExp(`(^|[^\\p{L}\\p{N}])(${escRx(word)})(?![\\p{L}\\p{N}])`, flags);
export function applySayAs(text: string, sayAs: SayAs[]): string {
  let t = text;
  for (const r of sayAs) {
    const from = (r.from || "").trim();
    const to = (r.to || "").trim();
    if (!from || !to) continue;
    t = t.replace(wordRx(from, "giu"), (_m, pre: string) => pre + to);
  }
  return t;
}
/** Whether a text holds the word, found the way Say it right finds it. */
export function hasWord(text: string, word: string): boolean {
  const w = (word || "").trim();
  return !!w && wordRx(w, "iu").test(text);
}

// ── Identity ───────────────────────────────────────────────────────────────
export function hash(str: string, seed = 7): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Only what changes the SOUND of a sentence: voice, pace and words. Every
 *  pause, the ones inside a sentence included, is exact silence set when
 *  joining, so changing a pause never records anything again.
 *  v3: recorded with fixed inner pauses (RECORD_*_MS), cut exact on joining.
 *  v5: edges found with the same detector as the inner pauses. */
export function pieceKey(voice: string, speed: number, speak: string): string {
  return "v5." + hash(`${voice}|${speed}|${speak}`);
}
export const rateOf = (speed: number) => (speed ? `${speed > 0 ? "+" : ""}${Math.round(speed)}%` : undefined);

// ── Scenes: who is speaking ────────────────────────────────────────────────
const isCaps = (s: string) => /\p{L}/u.test(s) && s === s.toUpperCase();
const normName = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/** Character names a script uses, in order of appearance. A name counts when
 *  it is written in capitals or is used on two lines or more, so "On three,
 *  yell:" or a one-off "Note:" never turns into a character. */
function findCharacters(lines: string[]): { inline: Set<string>; blocks: Set<string>; order: string[] } {
  const inlineCount = new Map<string, { n: number; caps: boolean }>();
  const blockCount = new Map<string, number>();
  const blockSeq: string[] = [];
  const order: string[] = [];
  const seen = (n: string) => { if (!order.includes(n)) order.push(n); };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = t.match(NAME_LINE);
    if (m && !CUE_LINE.test(t) && !ME_LINE.test(t) && !TRACK_LINE.test(t)) {
      const raw = m[1].trim();
      const name = normName(raw);
      if (!NOT_NAMES.has(name) && raw.split(/\s+/).length <= 3 && !/[,;]/.test(raw)) {
        const c = inlineCount.get(name) || { n: 0, caps: false };
        c.n += 1;
        c.caps = c.caps || isCaps(raw);
        inlineCount.set(name, c);
      }
    }
    const b = t.match(BLOCK_NAME);
    if (b && !/^(INT|EXT|I\/E)[.\s]/.test(t) && !NOT_NAMES.has(normName(b[1])) && b[1].split(/\s+/).length <= 4) {
      const next = (lines[i + 1] || "").trim();
      if (next && !BLOCK_NAME.test(next)) {
        blockCount.set(normName(b[1]), (blockCount.get(normName(b[1])) || 0) + 1);
        blockSeq.push(normName(b[1]));
      }
    }
  }
  const inline = new Set<string>();
  for (const [name, c] of inlineCount) if (c.caps || c.n >= 2) inline.add(name);
  const blocks = new Set<string>();
  // Screenplay headings only count when speakers take turns (NORA, THEO,
  // NORA): repeated section headings ("AUCTION ITEM") never make a scene.
  let turns = 0;
  for (let i = 1; i < blockSeq.length; i++) if (blockSeq[i] !== blockSeq[i - 1]) turns++;
  if (blockCount.size >= 2 && turns >= 2 && Math.max(0, ...blockCount.values()) >= 2) for (const n of blockCount.keys()) blocks.add(n);
  // Order of appearance
  for (const l of lines) {
    const t = l.trim();
    const m = t.match(NAME_LINE);
    if (m && inline.has(normName(m[1]))) seen(normName(m[1]));
    const b = t.match(BLOCK_NAME);
    if (b && blocks.has(normName(b[1]))) seen(normName(b[1]));
  }
  return { inline, blocks, order };
}

// ── Parse ──────────────────────────────────────────────────────────────────
type Run = { kind: Kind; src: Piece["src"]; who?: string; text: string; offset: number };

export function parseScript(script: string, st: Settings): Parsed {
  const pieces: Piece[] = [];
  const tracks: Track[] = [{ index: 0, title: "", named: false, from: 0, to: 0, line: 0, lead: [] }];
  const marks: Mark[] = [];
  const explicit = new Set<number>();   // sentences whose pause was written by hand
  let words = 0;

  const lines = script.split("\n");
  const found = findCharacters(lines.map((l) => l.replace(/\r$/, "")));
  const scene = found.inline.size + found.blocks.size > 0;
  const me = st.me ? normName(st.me) : "";
  const cast = castVoices(found.order.filter((n) => n !== me), st);

  const setGap = (ms: number, byHand: boolean) => {
    const last = pieces[pieces.length - 1];
    if (!last) return;
    if (!byHand && explicit.has(last.i)) return;   // a written pause always wins
    last.gapAfterMs = ms;
    if (byHand) explicit.add(last.i);
  };
  /** A sound before the next sentence: after the last one in this track, or
   *  at the start of the track when it has none yet. */
  const soundBefore = (s: Sound) => {
    const last = pieces[pieces.length - 1];
    const tr = tracks[tracks.length - 1];
    if (last && tr.from < pieces.length) last.after.push(s);
    else tr.lead.push(s);
  };
  const newTrack = (title: string, line: number) => {
    const cur = tracks[tracks.length - 1];
    if (cur.from === pieces.length) { cur.title = title; cur.named = !!title; cur.line = line; return; }
    tracks.push({ index: tracks.length, title, named: !!title, from: pieces.length, to: pieces.length, line, lead: [] });
  };
  const voiceFor = (kind: Kind, who?: string) =>
    kind === "line" ? { voice: st.lineVoice, speed: st.lineSpeed }
      : kind === "cue" ? { voice: st.cueVoice, speed: st.cueSpeed }
        : { voice: cast[who || ""] || st.cueVoice, speed: st.castSpeed };

  const addSentence = (run: Run, body: string, bodyOffset: number, line: number, markers: Marker[]) => {
    let clean = "";
    const opens: Record<number, number> = {};
    const soundsAt: Record<number, Sound[]> = {};
    const midSound = new Set<number>();
    const beforeSounds: Sound[] = [];
    const afterSounds: Sound[] = [];
    let before: number | null = null;
    let after: number | null = null;
    let mi = 0;
    for (let c = 0; c < body.length; c++) {
      const ch = body[c];
      if (ch !== PH) { clean += ch; continue; }
      const mk = markers[mi++] ?? { t: "pause", ms: 1000 };
      const leadText = body.slice(0, c).split(PH).join("").trim();
      const tailText = body.slice(c + 1).split(PH).join("").trim();
      if (!leadText) { if (mk.t === "pause") before = mk.ms; else beforeSounds.push(mk.sound); continue; }
      if (!tailText) { if (mk.t === "pause") after = mk.ms; else afterSounds.push(mk.sound); continue; }
      const prefix = clean.replace(/\s+/g, " ").trimEnd();
      if (/[,;:.!?]["'”’)]*$/.test(prefix)) {
        const k = countBoundaries(prefix + " x") - 1;   // the silence right behind that punctuation
        if (k >= 0) {
          if (mk.t === "pause") opens[k] = mk.ms;
          else (soundsAt[k] = soundsAt[k] || []).push(mk.sound);
          continue;
        }
      }
      if (mk.t === "pause") { clean += ` ⟦p${mk.ms}⟧ `; continue; }
      // A sound between two words: a short silence is recorded there to cut at.
      clean += ` ⟦p${MID_SOUND_BREAK_MS}⟧ `;
      const k = countBoundaries(clean.replace(/\s+/g, " ").trim() + " x") - 1;
      (soundsAt[k] = soundsAt[k] || []).push(mk.sound);
      midSound.add(k);
    }
    if (before !== null) setGap(before, true);
    beforeSounds.forEach(soundBefore);
    clean = clean.replace(/\s+/g, " ").trim();
    const display = clean.replace(/\s*⟦p\d+⟧\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!display) {
      if (after !== null) setGap(after, true);
      afterSounds.forEach(soundBefore);
      return;
    }
    const speak = applySayAs(clean, st.sayAs);
    const { voice, speed } = voiceFor(run.kind, run.who);
    words += display.split(/\s+/).filter(Boolean).length;
    const lead = Math.max(0, body.search(/\S/));
    const tailTrim = body.replace(/[\s]+$/, "").length;
    const phrases = splitPhrases(speak);
    const bounds = phrases.slice(0, -1).map((ph, k) => {
      if (opens[k] !== undefined) return opens[k];
      if (midSound.has(k)) return MID_SOUND_AFTER_MS;
      const m = ph.match(/⟦p(\d+)⟧$/);
      if (m) return parseInt(m[1], 10);
      return /[.!?]["'”’)]*$/.test(ph) ? st.sentenceMs : st.commaMs;
    });
    const p: Piece = {
      i: pieces.length, kind: run.kind, text: display, speak, voice, speed,
      track: tracks.length - 1, line,
      range: { start: run.offset + bodyOffset + lead, end: run.offset + bodyOffset + tailTrim },
      src: run.src, gapAfterMs: st.sentenceMs, opens, phrases, bounds,
      sounds: soundsAt, after: afterSounds, key: pieceKey(voice, speed, speak),
    };
    if (run.who) p.who = run.who;
    if (run.kind === "cue" && WAIT_RX.test(display)) p.wait = true;
    pieces.push(p);
    if (after !== null) setGap(after, true);
  };

  const addRun = (run: Run, line: number) => {
    const markers: Marker[] = [];
    // Markers become one placeholder char padded to the same length, so every
    // offset still points at the original script text.
    const withPh = run.text.replace(MARK_RX, (whole: string, _w: string, _n: string | undefined, off: number) => {
      const mk = markerOf(whole);
      marks.push({ range: { start: run.offset + off, end: run.offset + off + whole.length }, type: mk.t === "sound" ? "sound" : "pause" });
      markers.push(mk);
      return PH + " ".repeat(Math.max(0, whole.length - 1));
    });
    let mi = 0;
    for (const s of splitSentences(withPh)) {
      const count = s.text.split(PH).length - 1;
      addSentence(run, s.text, s.start, line, markers.slice(mi, mi + count));
      mi += count;
    }
  };
  /** The pause after a cue: the wait length when it only asks the room to react. */
  const afterCue = () => { const last = pieces[pieces.length - 1]; setGap(last?.wait ? st.waitMs : st.cueMs, false); };
  const paragraph = () => { const prev = pieces[pieces.length - 1]; if (prev) setGap(prev.kind === "cue" ? (prev.wait ? st.waitMs : st.cueMs) : st.paragraphMs, false); };

  let offset = 0;
  let blockWho: string | null = null;
  let block: { start: number; end: number; line: number } | null = null;
  const flushBlock = () => {
    if (!block || !blockWho) { block = null; return; }
    const who = blockWho;
    const mine = who === me;
    paragraph();
    addRun({ kind: mine ? "line" : "cast", src: "who", who, text: script.slice(block.start, block.end), offset: block.start }, block.line);
    block = null;
  };

  lines.forEach((rawLine, ln) => {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed) { flushBlock(); blockWho = null; return; }
    const at = lineStart + line.search(/\S/);
    const lineEnd = at + trimmed.length;

    // A line with no words at all (~~~~, ----, ****) is decoration: skipped.
    if (!/[\p{L}\p{N}]/u.test(trimmed)) {
      flushBlock();
      marks.push({ range: { start: at, end: lineEnd }, type: "skip" });
      return;
    }
    const tr = trimmed.match(TRACK_LINE);
    if (tr) {
      flushBlock(); blockWho = null;
      marks.push({ range: { start: at, end: lineEnd }, type: "track" });
      newTrack((tr[2] || "").trim(), ln);
      return;
    }
    if (ONLY_MARKS.test(trimmed)) {
      flushBlock();
      trimmed.replace(MARK_RX, (whole: string, _w: string, _n: string | undefined, off: number) => {
        const mk = markerOf(whole);
        marks.push({ range: { start: at + off, end: at + off + whole.length }, type: mk.t === "sound" ? "sound" : "pause" });
        if (mk.t === "pause") setGap(mk.ms, true); else soundBefore(mk.sound);
        return whole;
      });
      return;
    }
    // Screenplay layout: a character heading, then their lines.
    const bh = trimmed.match(BLOCK_NAME);
    if (bh && found.blocks.has(normName(bh[1]))) {
      flushBlock();
      blockWho = normName(bh[1]);
      marks.push({ range: { start: at, end: lineEnd }, type: "who" });
      return;
    }
    if (blockWho) {
      if (PAREN_ONLY.test(trimmed)) {   // (quietly), (to Nora): a direction, not a line
        flushBlock();
        marks.push({ range: { start: at, end: lineEnd }, type: "skip" });
        return;
      }
      if (block) block.end = lineEnd;
      else block = { start: at, end: lineEnd, line: ln };
      return;
    }

    // A new paragraph ends the previous one: a cue gets the cue pause.
    paragraph();
    const cm = trimmed.match(CUE_LINE);
    if (cm) {
      marks.push({ range: { start: at, end: at + cm[0].length }, type: "cueTag" });
      addRun({ kind: "cue", src: "cueLine", text: trimmed.slice(cm[0].length), offset: at + cm[0].length }, ln);
      afterCue();
      return;
    }
    const lab = trimmed.match(LABEL_LINE);
    if (lab && (CUE_LABELS.has(normName(lab[1])) || CUE_LABELS.has(normName(lab[1]).replace(/-/g, " ")))) {
      marks.push({ range: { start: at, end: at + lab[1].length + 1 }, type: "cueTag" });
      addRun({ kind: "cue", src: "label", text: trimmed, offset: at }, ln);
      afterCue();
      return;
    }
    const mm = trimmed.match(ME_LINE);
    if (mm) {
      marks.push({ range: { start: at, end: at + mm[0].length }, type: "who" });
      addRun({ kind: "line", src: "me", who: "ME", text: trimmed.slice(mm[0].length), offset: at + mm[0].length }, ln);
      paragraph();
      return;
    }
    const nm = scene ? trimmed.match(NAME_LINE) : null;
    if (nm && found.inline.has(normName(nm[1]))) {
      const who = normName(nm[1]);
      const textAt = trimmed.length - nm[3].length;
      marks.push({ range: { start: at, end: at + textAt }, type: "who" });
      addRun({ kind: who === me ? "line" : "cast", src: "who", who, text: nm[3], offset: at + textAt }, ln);
      paragraph();
      return;
    }
    // Screenplay furniture is never read: scene headings and transitions.
    if (scene && /^(?:INT|EXT|INT\.?\/EXT|I\/E|EST)[.\s]|^(?:FADE (?:IN|OUT)|CUT TO|DISSOLVE TO|SMASH CUT|MATCH CUT)/i.test(trimmed)) {
      marks.push({ range: { start: at, end: lineEnd }, type: "skip" });
      return;
    }
    if (scene && PAREN_ONLY.test(trimmed)) {   // a stage direction in brackets: not read
      marks.push({ range: { start: at, end: lineEnd }, type: "skip" });
      return;
    }
    const bm = trimmed.match(/^\[([^\[\]]+)\]$/);
    if (bm) {
      marks.push({ range: { start: at, end: at + 1 }, type: "cueTag" }, { range: { start: lineEnd - 1, end: lineEnd }, type: "cueTag" });
      addRun({ kind: "cue", src: "bracketLine", text: bm[1], offset: at + 1 }, ln);
      afterCue();
      return;
    }
    // In a scene, a line without a name is a stage direction: read as a cue.
    const plainKind: Kind = scene ? "cue" : "line";
    const plainSrc: Piece["src"] = scene ? "direction" : "plain";
    // Lines, with [cues] mixed in.
    const inl = /\[([^\[\]]+)\]/g;
    let last = 0;
    let im: RegExpExecArray | null;
    while ((im = inl.exec(trimmed))) {
      if (im.index > last) addRun({ kind: plainKind, src: plainSrc, text: trimmed.slice(last, im.index), offset: at + last }, ln);
      marks.push({ range: { start: at + im.index, end: at + im.index + 1 }, type: "cueTag" },
                 { range: { start: at + im.index + im[0].length - 1, end: at + im.index + im[0].length }, type: "cueTag" });
      addRun({ kind: "cue", src: "inlineCue", text: im[1], offset: at + im.index + 1 }, ln);
      if (pieces[pieces.length - 1]?.wait) setGap(st.waitMs, false);
      last = im.index + im[0].length;
    }
    if (last < trimmed.length) addRun({ kind: plainKind, src: plainSrc, text: trimmed.slice(last), offset: at + last }, ln);
    paragraph();
  });
  flushBlock();

  for (let t = 0; t < tracks.length; t++) tracks[t].to = t + 1 < tracks.length ? tracks[t + 1].from : pieces.length;
  const kept = tracks.filter((t) => t.to > t.from);
  kept.forEach((t, i) => {
    t.index = i;
    for (let p = t.from; p < t.to; p++) pieces[p].track = i;
    if (!t.title) {
      const first = pieces[t.from].text.replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
      t.title = first.split(" ").slice(0, 6).join(" ") || `Track ${i + 1}`;
    }
  });

  // Spoken count-in and track end: recorded like any cue, reused everywhere.
  const extra = (speak: string, n: number): Piece => ({
    i: -n, kind: "cue", text: speak, speak, voice: st.cueVoice, speed: st.cueSpeed, track: -1, line: -1,
    range: { start: 0, end: 0 }, src: "cueLine", gapAfterMs: 0, opens: {}, phrases: [speak], bounds: [],
    sounds: {}, after: [], key: pieceKey(st.cueVoice, st.cueSpeed, speak),
  });
  const from = Math.max(1, Math.min(COUNT_WORDS.length, Math.round(st.countFrom || 3)));
  const count = st.countInSpoken && pieces.length ? COUNT_WORDS.slice(0, from).reverse().map((w, k) => extra(w, k + 1)) : [];
  const end = st.trackEnd === "end" && pieces.length ? extra("End.", 20) : null;
  const characters = found.order;

  return {
    pieces, tracks: kept, marks, words, chars: pieces.reduce((a, p) => a + p.speak.length, 0),
    cast: characters.filter((n) => n !== me), characters, scene, count, end,
  };
}

// ── Audio assembly ─────────────────────────────────────────────────────────
export interface AudioInfo { id: string; dur: number; gaps: [number, number][]; t: number }
/** A stretch of one audio file, [s, e) seconds (null = file start / end). */
export interface Span { id: string; s: number | null; e: number | null; dur: number; tailGap: number }
/** One clip of a join: a recorded file (or part of one), or a sound made on
 *  the server (beep, ding, click, silence). */
export interface Clip {
  file_id?: string;
  sound?: SoundKind | "silence";
  sound_len?: number;
  volume?: number;
  start?: number;
  end?: number;
  pause_after: number;
}

/** A cut inside a sentence keeps this much of the natural silence on each
 *  side (the same as a sentence's own edges), so it never touches a sound;
 *  the rest of the pause is exact silence. */
const KEEP = EDGE_MS / 2000;
const ms3 = (x: number) => Math.round(x * 1000) / 1000;
/** A beep and a ding say how long they last; a click has its own length. */
const soundClip = (s: Sound): Clip =>
  s.kind === "click" ? { sound: "click", pause_after: 0 } : { sound: s.kind, sound_len: ms3(s.ms / 1000), pause_after: 0 };

/** A recorded sentence cut into phrases at its reported silences, or null
 *  when the silences don't line up with the phrases (it then plays whole). */
export function phraseSpans(a: AudioInfo, nPhrases: number): Span[] | null {
  if (nPhrases <= 1) return [{ id: a.id, s: null, e: null, dur: a.dur, tailGap: 0 }];
  if (!a.dur || !a.gaps || a.gaps.length !== nPhrases - 1) return null;
  const out: Span[] = [];
  for (let j = 0; j < nPhrases; j++) {
    const s = j === 0 ? null : ms3(a.gaps[j - 1][1] - KEEP);
    const e = j === nPhrases - 1 ? null : ms3(a.gaps[j][0] + KEEP);
    if (s !== null && e !== null && e - s <= 0) return null;
    out.push({ id: a.id, s, e, dur: ms3((e ?? a.dur) - (s ?? 0)), tailGap: 0 });
  }
  return out;
}

const normPhrase = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The edited sentence: every phrase that didn't change keeps its old audio,
 *  the changed ones come from the new recording. Null = use the new one whole. */
export function buildSplice(oldPhrases: string[], oldSpans: Span[] | null, newPhrases: string[], newSpans: Span[] | null): { spans: Span[]; kept: number } | null {
  if (!oldSpans || !newSpans) return null;
  if (oldPhrases.length !== newPhrases.length || oldSpans.length !== oldPhrases.length || newSpans.length !== newPhrases.length) return null;
  let kept = 0;
  const spans = newSpans.map((ns, j) => {
    if (normPhrase(oldPhrases[j]) === normPhrase(newPhrases[j])) { kept++; return oldSpans[j]; }
    return ns;
  });
  return kept > 0 && kept < spans.length ? { spans, kept } : null;
}

export interface LastPiece { key: string; kind: Kind; voice: string; speed: number; phrases: string[] }

/** Match the new sentences against the last recorded ones: equal keys are the
 *  same sentence; between two matches, sentences in the same spot and voice
 *  are edits of each other. Returns new index -> old index. */
export function alignEdits(old: LastPiece[], neu: Piece[]): Map<number, number> {
  const n = old.length, m = neu.length;
  const res = new Map<number, number>();
  if (!n || !m || n * m > 2_000_000) return res;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = old[i].key === neu[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  let gapO: number[] = [], gapN: number[] = [];
  const flush = () => {
    const k = Math.min(gapO.length, gapN.length);
    for (let x = 0; x < k; x++) {
      const o = old[gapO[x]], p = neu[gapN[x]];
      if (o.kind === p.kind && o.voice === p.voice && o.speed === p.speed) res.set(gapN[x], gapO[x]);
    }
    gapO = []; gapN = [];
  };
  while (i < n && j < m) {
    if (old[i].key === neu[j].key) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) gapO.push(i++);
    else gapN.push(j++);
  }
  while (i < n) gapO.push(i++);
  while (j < m) gapN.push(j++);
  flush();
  return res;
}

export interface SentenceAudio { clips: Clip[]; dur: number; lost: Sound[] }

/** One sentence's audio as clips: cut at each inner silence, with that
 *  silence set to its exact length (p.bounds) and any sound written there.
 *  `lost` = sounds that could not be placed inside (they play after it). */
export function sentenceClips(p: Piece, whole: AudioInfo | undefined, spliced: Span[] | undefined): SentenceAudio | null {
  let spans: Span[] | null = spliced && spliced.length === p.phrases.length ? spliced : null;
  const inner = Object.keys(p.sounds).map(Number).sort((a, b) => a - b).flatMap((k) => p.sounds[k]);
  if (!spans) {
    if (!whole) return null;
    spans = p.phrases.length > 1 ? phraseSpans(whole, p.phrases.length) : null;
    // One phrase, or silences that don't line up with the phrases: the
    // sentence plays whole, with the pauses it was recorded with.
    if (!spans) return { clips: [{ file_id: whole.id, pause_after: 0 }], dur: whole.dur, lost: inner };
  }
  const use = spans;
  let dur = 0;
  const clips: Clip[] = [];
  use.forEach((sp, j) => {
    const c: Clip = { file_id: sp.id, pause_after: 0 };
    if (sp.s !== null) c.start = sp.s;
    if (sp.e !== null) c.end = sp.e;
    clips.push(c);
    dur += sp.dur;
    if (j === use.length - 1) return;
    const snd = p.sounds[j] || [];
    const pause = (p.bounds[j] ?? 0) / 1000;
    if (!snd.length) {
      c.pause_after = ms3(Math.max(0, pause - 2 * KEEP));
      dur += c.pause_after;
      return;
    }
    c.pause_after = ms3(SOUND_LEAD_MS / 1000 - KEEP);
    dur += c.pause_after;
    snd.forEach((s, n) => {
      const sc = soundClip(s);
      sc.pause_after = n < snd.length - 1 ? SOUND_LEAD_MS / 1000 : ms3(Math.max(0, pause - KEEP));
      clips.push(sc);
      dur += s.ms / 1000 + sc.pause_after;
    });
  });
  return { clips, dur: ms3(dur), lost: [] };
}

export type AudioOf = (p: Piece) => SentenceAudio | null;
export interface PlanOpts { st: Settings; audioOf: AudioOf }
export interface Plan {
  clips: Clip[];
  /** Per sentence of the plan, in order: where it starts and ends (seconds). */
  starts: number[];
  ends: number[];
  /** Silence before the first clip (the join's lead_in). */
  leadIn: number;
  total: number;
  /** One-file plans: where each track starts and ends. */
  trackStarts: number[];
  trackEnds: number[];
}

/** Silence longer than one clip allows is laid as several. */
function silenceClips(sec: number): Clip[] {
  const out: Clip[] = [];
  let left = ms3(sec);
  while (left > 0.0005) {
    const n = Math.min(left, 59);
    out.push({ sound: "silence", sound_len: ms3(Math.max(0.02, n)), pause_after: 0 });
    left = ms3(left - n);
  }
  return out;
}

/** One track as clips, from its count-in to its end signal. Null while any
 *  sentence it needs has no audio yet. */
export function planTrack(pr: Parsed, t: Track, o: PlanOpts): Plan | null {
  const { st, audioOf } = o;
  const clips: Clip[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let leadIn = 0;
  let now = 0;
  const addGroup = (cl: Clip[], len: number) => { for (const c of cl) clips.push({ ...c }); now += len; };
  const addPause = (sec: number) => {
    if (sec <= 0) return;
    const last = clips[clips.length - 1];
    if (last) last.pause_after = ms3(last.pause_after + sec);
    else leadIn = ms3(leadIn + sec);
    now += sec;
  };
  const addSounds = (list: Sound[], gapAfter: number) => {
    list.forEach((s, n) => {
      addGroup([soundClip(s)], s.ms / 1000);
      addPause(n < list.length - 1 ? SOUND_LEAD_MS / 1000 : gapAfter);
    });
  };

  // Count-in: on the beat, or silence
  if (pr.count.length) {
    const beat = COUNT_BEAT_S;
    for (const cp of pr.count) {
      const a = audioOf(cp);
      if (!a) return null;
      const from = now;
      addGroup(a.clips, a.dur);
      addPause(Math.max(0.05, beat - (now - from)));
    }
  } else if (st.countInMs > 0) addPause(st.countInMs / 1000);
  if (t.lead.length) addSounds(t.lead, Math.max(0, st.sentenceMs / 1000 - KEEP));

  for (let k = t.from; k < t.to; k++) {
    const p = pr.pieces[k];
    const a = audioOf(p);
    if (!a) return null;
    const mine = p.kind === "line";
    const lastOne = k === t.to - 1;
    if (mine && st.myLines === "gap") {
      if (st.myBeep) { addGroup([soundClip({ kind: "beep", ms: TURN_BEEP_MS })], TURN_BEEP_MS / 1000); addPause(SOUND_LEAD_MS / 1000); }
      const room = ms3(a.dur * (st.myRoomPct / 100) + st.myExtraMs / 1000);
      starts.push(now);
      addGroup(silenceClips(room), room);
      ends.push(now);
    } else {
      starts.push(now);
      addGroup(mine && st.myLines === "quiet" ? a.clips.map((c) => ({ ...c, volume: QUIET_VOLUME })) : a.clips, a.dur);
      ends.push(now);
    }
    const gap = lastOne ? 0 : p.gapAfterMs / 1000;
    const snd = [...a.lost, ...p.after];
    if (snd.length) {
      addPause(Math.max(0, SOUND_LEAD_MS / 1000 - KEEP));
      addSounds(snd, lastOne ? 0 : Math.max(0, gap - KEEP));
    } else if (!lastOne) addPause(Math.max(0, gap - 2 * KEEP));
  }

  if (st.trackEnd === "beep") {
    addPause(Math.max(0, st.sentenceMs / 1000 - KEEP));
    addGroup([soundClip({ kind: "beep", ms: END_BEEP_MS })], END_BEEP_MS / 1000);
  } else if (st.trackEnd === "end" && pr.end) {
    const a = audioOf(pr.end);
    if (!a) return null;
    addPause(Math.max(0, st.sentenceMs / 1000 - 2 * KEEP));
    addGroup(a.clips, a.dur);
  }
  if (!clips.length) return null;
  return { clips, starts, ends, leadIn, total: ms3(now), trackStarts: [0], trackEnds: [ms3(now)] };
}

/** Every track in one file, each exactly as its own file, with a pause between. */
export function planAll(pr: Parsed, o: PlanOpts): Plan | null {
  if (!pr.tracks.length) return null;
  if (pr.tracks.length === 1) return planTrack(pr, pr.tracks[0], o);
  const out: Plan = { clips: [], starts: [], ends: [], leadIn: 0, total: 0, trackStarts: [], trackEnds: [] };
  let now = 0;
  for (let i = 0; i < pr.tracks.length; i++) {
    const tp = planTrack(pr, pr.tracks[i], o);
    if (!tp) return null;
    const offset = i === 0 ? 0 : ms3(now + TRACK_GAP_MS / 1000);
    if (i === 0) out.leadIn = tp.leadIn;
    else {
      const last = out.clips[out.clips.length - 1];
      last.pause_after = ms3(last.pause_after + TRACK_GAP_MS / 1000 + tp.leadIn);
    }
    for (const c of tp.clips) out.clips.push({ ...c });
    tp.starts.forEach((s) => out.starts.push(ms3(s + offset)));
    tp.ends.forEach((s) => out.ends.push(ms3(s + offset)));
    out.trackStarts.push(offset);
    out.trackEnds.push(ms3(offset + tp.total));
    now = ms3(offset + tp.total);
  }
  out.total = now;
  return out;
}

// ── Estimates ──────────────────────────────────────────────────────────────
/** Seconds of speech before anything is recorded: ~155 words a minute at normal pace. */
const guessDur = (p: Piece) => {
  const w = p.text.split(/\s+/).filter(Boolean).length;
  let s = ((w / 155) * 60) / (1 + p.speed / 100) + EDGE_MS / 1000;
  s += p.bounds.reduce((a, ms) => a + Math.max(ms, EDGE_MS), 0) / 1000;
  for (const k of Object.keys(p.sounds)) for (const snd of p.sounds[Number(k)]) s += (snd.ms + SOUND_LEAD_MS) / 1000;
  return s;
};
/** A sentence's length before it is recorded (seconds, edges included). */
export const guessSeconds = (p: Piece) => guessDur(p);
const guessAudio: AudioOf = (p) => ({ clips: [{ file_id: "x", pause_after: 0 }], dur: guessDur(p), lost: [] });
export function estimateSeconds(p: Parsed, st: Settings): number {
  return planAll(p, { st, audioOf: guessAudio })?.total ?? 0;
}
export function estimateTrack(p: Parsed, t: Track, st: Settings): number {
  return planTrack(p, t, { st, audioOf: guessAudio })?.total ?? 0;
}
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const clipsSignature = (clips: Clip[], leadIn: number) => hash(JSON.stringify([leadIn, clips]));

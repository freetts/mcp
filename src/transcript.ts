// Turning a FreeTTS transcript (segments and words with times, and speaker
// numbers when speaker labels were asked for) into what people read: lines
// with times, turns by speaker, and SRT or WebVTT subtitles.
// Pure functions, no I/O, so the tests can run them on their own.

export interface Seg { start: number; end: number; text: string; speaker?: number | null }
export interface Word { w: string; start: number; end: number; speaker?: number | null }
export interface Cue { start: number; end: number; text: string; speaker?: number | null }

/** Languages written without spaces between words: their words are joined as they are. */
export const joinsWithoutSpaces = (language?: string | null) => /^(zh|ja|th|lo|km|my|yue|wuu)\b/i.test(language || "");

/** 75.4 -> "01:15"; 3725 -> "1:02:05" (hours only when the recording has them). */
export function clock(sec: number, withHours = false): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
  return withHours || h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Speaker numbers from the transcriber start at 0; people count from 1. */
export const speakerName = (n: number | null | undefined) => (n === null || n === undefined ? "" : `Speaker ${n + 1}`);

/** Consecutive segments of one speaker as one turn (speaker labels on), or the segments as they are. */
export function turns(segs: Seg[], bySpeaker: boolean): Seg[] {
  if (!bySpeaker) return segs.filter((s) => s.text.trim());
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 3) { last.text += " " + s.text.trim(); last.end = s.end; }
    else out.push({ ...s, text: s.text.trim() });
  }
  return out;
}

/** "[00:12] Speaker 1: ..." lines (speaker part only with speaker labels). */
export function timestamped(segs: Seg[], opts: { speakers: boolean; duration?: number }): string {
  const withHours = (opts.duration ?? segs[segs.length - 1]?.end ?? 0) >= 3600;
  return turns(segs, opts.speakers).map((t) => {
    const who = opts.speakers && speakerName(t.speaker) ? `${speakerName(t.speaker)}: ` : "";
    return `[${clock(t.start, withHours)}] ${who}${t.text}`;
  }).join("\n");
}

/** Paragraphs by speaker, no times: "Speaker 1: ...". */
export function bySpeakerText(segs: Seg[]): string {
  return turns(segs, true).map((t) => `${speakerName(t.speaker) || "Speaker"}: ${t.text}`).join("\n\n");
}

// ── Subtitles ───────────────────────────────────────────────────────────
/** Netflix-style limits most players and editors expect. */
export const SUB = { lineChars: 42, lines: 2, maxSeconds: 6, minSeconds: 1, gapSeconds: 0.08 };

/** Words grouped into subtitle cues: at most two lines of 42 characters and six seconds, a new cue at a new
 *  speaker or a long pause, and a break after a sentence or clause when the cue is already well filled. */
export function cues(words: Word[], segs: Seg[], language?: string | null): Cue[] {
  const join = joinsWithoutSpaces(language) ? "" : " ";
  // No word times (should not happen with FreeTTS): fall back to whole segments, split by length.
  const src: Word[] = words.length ? words : segs.flatMap((s) => {
    const toks = s.text.trim().split(/\s+/).filter(Boolean);
    const span = Math.max(0.01, s.end - s.start); const total = toks.reduce((n, t) => n + t.length + 1, 0) || 1;
    let t0 = s.start;
    return toks.map((w) => { const d = span * (w.length + 1) / total; const o = { w, start: t0, end: t0 + d, speaker: s.speaker }; t0 += d; return o; });
  });
  const max = SUB.lineChars * SUB.lines;
  const out: Cue[] = [];
  let cur: Word[] = [];
  const textOf = (ws: Word[]) => ws.map((x) => x.w).join(join).trim();
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: textOf(cur), speaker: cur[0].speaker ?? null }); cur = []; };
  for (const w of src) {
    if (!w.w) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const nextText = textOf([...cur, w]);
      const tooLong = !fitsTwoLines(nextText) || w.end - cur[0].start > SUB.maxSeconds;
      const newSpeaker = (w.speaker ?? null) !== (cur[0].speaker ?? null);
      const pause = w.start - prev.end > 1.2;
      const filled = textOf(cur).length >= max * 0.55 || prev.end - cur[0].start >= 3;
      const clauseEnd = /[.!?;:,。！？、，]$/.test(prev.w);
      if (tooLong || newSpeaker || pause || (clauseEnd && filled)) flush();
    }
    cur.push(w);
  }
  flush();
  // Readable on screen: at least a second where the next cue allows it, and never overlapping.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (out[i].end - out[i].start < SUB.minSeconds) out[i].end = Math.min(out[i].start + SUB.minSeconds, next ? next.start - SUB.gapSeconds : Infinity);
    if (next && out[i].end > next.start - SUB.gapSeconds) out[i].end = Math.max(out[i].start + 0.2, next.start - SUB.gapSeconds);
  }
  return out;
}

/** True when the text fits on two subtitle lines of 42 characters, broken at a space. */
export function fitsTwoLines(text: string): boolean {
  if (text.length <= SUB.lineChars) return true;
  if (text.length > SUB.lineChars * SUB.lines + 1) return false;
  return wrap(text).split("\n").every((l) => l.length <= SUB.lineChars);
}

/** A cue's text on at most two lines, broken at the space that makes the longer line shortest
 *  (the space nearest the middle can leave one line over 42 characters). */
export function wrap(text: string): string {
  if (text.length <= SUB.lineChars) return text;
  let best = -1, bestLonger = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") continue;
    const longer = Math.max(i, text.length - i - 1);
    if (longer < bestLonger) { best = i; bestLonger = longer; }
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

const stamp = (sec: number, sep: "," | ".") => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(r).padStart(3, "0")}`;
};

/** SRT: numbered cues, comma before the milliseconds. A new speaker's first cue starts with "[Speaker n]". */
export function toSrt(list: Cue[], speakers: boolean): string {
  let last: number | null | undefined;
  return list.map((c, i) => {
    const tag = speakers && c.speaker !== last && speakerName(c.speaker) ? `[${speakerName(c.speaker)}] ` : "";
    last = c.speaker;
    return `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${wrap(tag + c.text)}\n`;
  }).join("\n");
}

/** WebVTT: the header, dot before the milliseconds, speakers as voice tags. */
export function toVtt(list: Cue[], speakers: boolean): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "WEBVTT\n\n" + list.map((c) => {
    const who = speakers && speakerName(c.speaker) ? `<v ${speakerName(c.speaker)}>` : "";
    return `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${who}${esc(wrap(c.text))}\n`;
  }).join("\n");
}

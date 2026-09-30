// Script mode from the server side: the same model the Studio uses
// (scriptModel.ts, copied from the site), recorded through the same two API
// routes the Studio calls: /api/tts-multivoice for the sentences and
// /api/studio/timeline/merge for the exact pauses, sounds and joins.
import {
  parseScript, planAll, planTrack, sentenceClips, castVoices, hasInnerSentence, rateOf,
  DEFAULT_SETTINGS, STEADY_VOICES, MAX_BATCH_SEGMENTS, MAX_BATCH_CHARS, MAX_JOIN_CLIPS,
  RECORD_COMMA_MS, RECORD_SENTENCE_MS,
  type Settings, type Piece, type AudioInfo, type Clip, type Parsed,
} from "./scriptModel.js";
import { multivoice, merge, type Segment } from "../freetts.js";

export interface TrackFile { index: number; title: string; file_id: string; duration: number; sentences: number }
export interface Recorded { full: { file_id: string; duration: number }; tracks: TrackFile[]; parsed: Parsed; sentences: number; estimate: number }

const segmentOf = (p: Piece): Segment => ({
  speaker: p.kind === "line" ? "Lines" : p.kind === "cue" ? "Cues" : (p.who || "Cast").slice(0, 40), voice: p.voice, text: p.speak,
  ...(rateOf(p.speed) ? { rate: rateOf(p.speed) } : {}),
  pause_after_ms: 0, comma_pause_ms: RECORD_COMMA_MS, trim_edges: true,
  ...(hasInnerSentence(p.speak) ? { sentence_pause_ms: RECORD_SENTENCE_MS } : {}),
});

export const steadyVoiceId = (nameOrId: string | undefined, fallback: string): string => {
  if (!nameOrId) return fallback;
  const s = nameOrId.trim().toLowerCase();
  const hit = STEADY_VOICES.find((v) => v.id.toLowerCase() === s || v.name.toLowerCase() === s);
  return hit ? hit.id : fallback;
};

/** Record a Script mode script for one account. Every sentence is recorded
 *  once, then the file and one file per track are joined with exact pauses. */
export async function recordScript(apiKey: string, text: string, opts: Partial<Settings> & { me?: string }): Promise<Recorded> {
  const st: Settings = { ...DEFAULT_SETTINGS, ...opts, cast: { ...(opts.cast || {}) } };
  let pr = parseScript(text, st);
  // scene characters get a steady voice each, as in the Studio
  const meN = (st.me || "").toUpperCase();
  const missing = pr.characters.filter((n) => n !== meN && !st.cast[n]);
  if (missing.length) { st.cast = castVoices(pr.characters.filter((n) => n !== meN), st); pr = parseScript(text, st); }
  if (!pr.pieces.length) throw new Error("The script has no sentences to read.");
  const extras = [...pr.count, ...(pr.end ? [pr.end] : [])];
  const seen = new Set<string>();
  const todo = [...pr.pieces, ...extras].filter((p) => !seen.has(p.key) && (seen.add(p.key), true));
  const audio: Record<string, AudioInfo> = {};
  // batches: one voice per call, under the size limits
  const byVoice = new Map<string, Piece[]>();
  for (const p of todo) byVoice.set(p.voice, [...(byVoice.get(p.voice) || []), p]);
  const batches: Piece[][] = [];
  for (const group of byVoice.values()) {
    let cur: Piece[] = [], chars = 0;
    for (const p of group) {
      if (cur.length && (cur.length >= MAX_BATCH_SEGMENTS || chars + p.speak.length > MAX_BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(p); chars += p.speak.length;
    }
    if (cur.length) batches.push(cur);
  }
  for (const batch of batches) {
    const r = await multivoice(apiKey, batch.map(segmentOf));
    const sa = r.segment_audio;
    if (!Array.isArray(sa) || sa.length !== batch.length) throw new Error("Recording returned the wrong number of sentences.");
    sa.forEach((x, i) => { audio[batch[i].key] = { id: x.file_id, dur: typeof x.duration === "number" ? x.duration : 0, gaps: Array.isArray(x.gaps) ? x.gaps : [], t: Date.now() }; });
  }
  const audioOf = (p: Piece) => sentenceClips(p, audio[p.key], undefined);
  const po = { st, audioOf };
  const full = planAll(pr, po);
  if (!full) throw new Error("Some sentences have no audio.");
  const join = async (clips: Clip[], leadIn: number): Promise<{ file_id: string; duration: number }> => {
    if (clips.length > MAX_JOIN_CLIPS) {
      const level: Clip[] = [];
      for (let i = 0; i < clips.length; i += MAX_JOIN_CLIPS) {
        const g = clips.slice(i, i + MAX_JOIN_CLIPS);
        const tail = g[g.length - 1].pause_after;
        const f = await join(g.map((c, k) => (k === g.length - 1 ? { ...c, pause_after: 0 } : c)), 0);
        level.push({ file_id: f.file_id, pause_after: tail });
      }
      return join(level, leadIn);
    }
    const r = await merge(apiKey, clips, leadIn);
    return { file_id: r.file_id, duration: r.duration || 0 };
  };
  const fullFile = await join(full.clips, full.leadIn);
  const tracks: TrackFile[] = [];
  if (pr.tracks.length > 1) {
    for (const t of pr.tracks) {
      const tp = planTrack(pr, t, po);
      if (!tp) continue;
      const f = await join(tp.clips, tp.leadIn);
      tracks.push({ index: t.index, title: t.title, file_id: f.file_id, duration: f.duration, sentences: t.to - t.from });
    }
  } else {
    tracks.push({ index: 0, title: pr.tracks[0]?.title || "Track 1", file_id: fullFile.file_id, duration: fullFile.duration, sentences: pr.pieces.length });
  }
  return { full: fullFile, tracks, parsed: pr, sentences: pr.pieces.length, estimate: full.total };
}

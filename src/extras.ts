// Prompts and resources: ready-made requests a person can pick in their
// client, and reference material the model can read before calling a tool.
// Everything here is read-only and free for every caller.
import { z } from "zod";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG } from "./config.js";
import { voices, isFreeVoice, tierLabel, byLanguage, type Voice } from "./freetts.js";

const shortName = (v: Voice) => v.ShortName.split("-").slice(2).join("-").replace(/:.*$/, "").replace(/Neural$/, "").replace(/Multilingual$/, " (multilingual)");
const row = (v: Voice) => ({ id: v.ShortName, name: shortName(v), gender: v.Gender, locale: v.Locale, language: v.LocaleName || v.Locale, tier: tierLabel(v), free: isFreeVoice(v) });
const listable = async () => (await voices()).filter((v) => (v.Tier || "") !== "ultra");

const SCRIPT_SYNTAX = `# FreeTTS Script mode syntax

Used by the script_to_tracks tool (FreeTTS PRO). Write the script as plain text; these marks control timing, sounds, voices and files.

## Pauses (exact silence)
- \`(pause 2)\` two seconds of silence. Decimals work: \`(pause 1.5)\`. Units are optional: \`(pause 3s)\`, \`(pause 3 seconds)\`.
- \`(wait 2)\`, \`(hold 2)\` and \`(beat 2)\` are the same as \`(pause 2)\`.
- Without a number, \`(pause)\` is one second. The longest pause is 60 seconds.
- A pause right after a comma or a full stop replaces the normal gap there; it never adds to it.

## Sounds
- \`(beep)\` a short tone; \`(beep 2)\` a two second tone. \`(tone)\` is the same.
- \`(ding)\` a bell; \`(bell)\` is the same.
- \`(click)\` a short click.

## Files
- \`TRACK: Opening\` starts a new audio file named "Opening". \`TRACK 2 - Q&A\` also works.
- The result is one file with everything, plus one file per track.

## Cues (a second voice)
- \`CUE: Walk to the lectern\` is read in the cue voice, not the main voice.
- Lines that start with \`VIDEO:\`, \`MUSIC:\`, \`LIGHTS:\`, \`SFX:\`, \`SLIDE:\`, \`CAMERA:\` and similar production labels are cues too.
- \`[words in brackets]\` inside a line are read in the cue voice; a line that is only \`[a bracket]\` is a cue.
- A cue that only asks the room to react, like \`Applause\`, \`Laughter\` or \`Wait here\`, is followed by the wait length.

## Scenes (a voice per character)
- \`MAYA: Where were you?\` makes MAYA a character with her own voice.
- Screenplay style works too: the name in capitals on its own line, then the lines. \`(V.O.)\`, \`(O.S.)\` and \`(CONT'D)\` after a name are fine.
- Scene headings and transitions (\`INT.\`, \`EXT.\`, \`FADE IN\`, \`CUT TO\`) are never read aloud.
- Pass \`my_part: "MAYA"\` to make her lines timed gaps, so you can say them yourself while rehearsing.

## Options on the tool
- \`line_voice\` and \`cue_voice\`: a voice name such as Guy, Andrew, Ava, Aria, Jenny, Brian, Emma, Sonia, Ryan.
- \`sentence_pause_ms\` (default 500) and \`paragraph_pause_ms\` (default 1000).
- \`count_in\`: a spoken 3, 5 or 10 count before each track. \`track_end\`: a long beep or the word "End" after each track.

## Example
\`\`\`
TRACK: Warm up
Breathe in. (pause 4) And out. (pause 4) (ding)
CUE: Stand up slowly
TRACK: Scene one
MAYA: Where were you last night?
OMAR: Out. (pause 1) Walking.
MAYA: In the rain? (beep)
\`\`\`
`;

function plansText(): string {
  const a = CONFIG.anon;
  return `# FreeTTS plans through this server

## Without an account
- Tools: text_to_speech, list_voices, suggest_voice, check_usage.
- Standard voices (318 of them) in every language.
- ${a.perCallChars.toLocaleString()} characters a call; ${a.dailyChars.toLocaleString()} a day per connection; ${a.perMinute} requests a minute. On claude.ai and ChatGPT, guests share a platform allowance and are asked to connect a free account when it is used up.
- MP3 with a short spoken FreeTTS tag at the end. Files kept one hour.

## Free FreeTTS account (connect with an API key)
- The same tools and voices, on your own allowance: 5,000 characters a day.
- MP3 with the spoken tag. Files kept one hour.

## FreeTTS PRO
- HD and Signature voices, no tag, WAV as well as MP3.
- 10,000 characters a call, 1,000,000 a month, 200 requests a minute. Files kept 30 days.
- dialogue_to_speech (a voice per speaker), script_to_tracks (Script mode timing) and transcribe_audio (speech to text).

Plans and prices: ${CONFIG.siteUrl}/pricing. API keys: ${CONFIG.siteUrl}/dashboard (API keys).
`;
}

export function registerExtras(server: McpServer): void {
  // ── Resources ───────────────────────────────────────────────────────────
  server.registerResource("languages", "freetts://languages", {
    title: "FreeTTS languages",
    description: "Every language and regional variant FreeTTS speaks, with how many voices each has and how many are free.",
    mimeType: "text/markdown",
  }, async (uri) => {
    const all = await listable();
    const by = new Map<string, { n: number; free: number; locale: string }>();
    for (const v of all) { const k = v.LocaleName || v.Locale; const e = by.get(k) || { n: 0, free: 0, locale: v.Locale }; e.n++; if (isFreeVoice(v)) e.free++; by.set(k, e); }
    const lines = [...by.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([l, e]) => `| ${l} | ${e.locale} | ${e.n} | ${e.free} |`);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# FreeTTS languages\n\n${all.length.toLocaleString()} voices in ${by.size} languages and regional variants. Read freetts://voices/{locale} for the voices of one.\n\n| Language | Locale | Voices | Free |\n|---|---|---|---|\n${lines.join("\n")}\n` }] };
  });

  server.registerResource("free-voices", "freetts://voices/free", {
    title: "Free FreeTTS voices",
    description: "The standard voices that work without a FreeTTS key or on a free account, with id, name, gender and language.",
    mimeType: "application/json",
  }, async (uri) => {
    const list = (await listable()).filter(isFreeVoice).map(row);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ count: list.length, voices: list }) }] };
  });

  server.registerResource("voices-by-language", new ResourceTemplate("freetts://voices/{language}", {
    list: undefined,
    complete: { language: async (value) => { const locs = [...new Set((await listable()).map((v) => v.Locale))].sort(); return locs.filter((l) => l.toLowerCase().startsWith(String(value || "").toLowerCase())).slice(0, 50); } },
  }), {
    title: "FreeTTS voices for a language",
    description: "Every voice for one language or locale (for example en-US, de, Arabic), with tier and whether it is free.",
    mimeType: "application/json",
  }, async (uri, vars) => {
    const lang = decodeURIComponent(String(vars.language || ""));
    const list = byLanguage(await listable(), lang).map(row);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ language: lang, count: list.length, voices: list }) }] };
  });

  server.registerResource("script-mode-syntax", "freetts://script-mode/syntax", {
    title: "Script mode syntax",
    description: "How to write a script for script_to_tracks: exact pauses, beeps and dings, tracks, cues in a second voice, scenes with a voice per character.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SCRIPT_SYNTAX }] }));

  server.registerResource("plans", "freetts://plans", {
    title: "FreeTTS plans and limits",
    description: "What works without an account, on a free account and on PRO through this server: voices, characters, formats, tools.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: plansText() }] }));

  // ── Prompts ─────────────────────────────────────────────────────────────
  const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  server.registerPrompt("read_aloud", {
    title: "Read text aloud",
    description: "Turn a text into an MP3 with a fitting FreeTTS voice.",
    argsSchema: { text: z.string().describe("The text to read."), language: z.string().optional().describe("Language of the text, if not English."), voice: z.string().optional().describe("A voice name or id, if you have one in mind.") },
  }, ({ text, language, voice }) => user(`Read this text aloud with FreeTTS and give me the MP3 link.${voice ? ` Use the voice ${voice}.` : language ? ` It is in ${language}; pick a natural voice for it (suggest_voice can help).` : ""}\n\nText:\n${text}`));

  server.registerPrompt("two_host_podcast", {
    title: "Two-host podcast episode",
    description: "Write a short two-host episode on a topic and record it with a voice per host (FreeTTS PRO).",
    argsSchema: { topic: z.string().describe("What the episode is about."), host_a: z.string().optional().describe("First host's name. Default Maya."), host_b: z.string().optional().describe("Second host's name. Default Omar."), minutes: z.string().optional().describe("About how long, in minutes. Default 2.") },
  }, ({ topic, host_a, host_b, minutes }) => {
    const a = host_a || "Maya", b = host_b || "Omar", m = Number(minutes) || 2;
    return user(`Write a natural two-host podcast segment about: ${topic}.\nHosts: ${a} and ${b}. About ${m} minute${m === 1 ? "" : "s"} spoken (roughly ${m * 150} words). Short lines, real back and forth, no stage directions.\nWrite every line as "${a}: ..." or "${b}: ...", then record it with dialogue_to_speech and give me the MP3 link. If dialogue_to_speech says it needs FreeTTS PRO, show me the script and say so.`);
  });

  server.registerPrompt("timed_voiceover", {
    title: "Timed voiceover or prompter track",
    description: "Prepare a script with exact pauses, cues and tracks and record it with Script mode (FreeTTS PRO).",
    argsSchema: { script: z.string().describe("The words to be spoken, as you have them."), purpose: z.string().optional().describe("What it is for: an ear prompter, a video voiceover, a workout, a rehearsal track...") },
  }, ({ script, purpose }) => user(`Read the resource freetts://script-mode/syntax, then prepare this script for FreeTTS Script mode${purpose ? ` (${purpose})` : ""}: add (pause N) where the listener needs time, (beep) or (ding) where a signal helps, CUE: lines for directions, and TRACK: headings where a new file makes sense. Show me the marked-up script, then record it with script_to_tracks and give me the links. If it says it needs FreeTTS PRO, show me the script and say so.\n\nScript:\n${script}`));

  server.registerPrompt("choose_voice", {
    title: "Choose a voice",
    description: "Find three FreeTTS voices for a language and a use, then hear the best one.",
    argsSchema: { language: z.string().describe("The language or accent, like 'English (UK)' or 'Arabic'."), use: z.string().optional().describe("What the audio is for, like audiobook, ad or children's story.") },
  }, ({ language, use }) => user(`Use suggest_voice to find three FreeTTS voices for ${language}${use ? `, for ${use}` : ""}. Tell me in one line each why they fit, then read one short sample sentence in ${language} with the first one using text_to_speech and give me the link.`));
}

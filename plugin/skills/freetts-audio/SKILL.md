---
name: freetts-audio
description: Turn text into speech with FreeTTS and hand back an MP3 link. Use when someone wants text read aloud, narrated, voiced, saved as audio, turned into a dialogue or podcast, timed as a voiceover or prompter track, or a recording turned into text, with speaker labels, timestamps or subtitles.
---

# Making audio with FreeTTS

FreeTTS reads text aloud in 149 languages with 2,253 voices and returns a link to the audio file. Always give the person the link, the voice used and the length.

In ChatGPT the audio also plays in a FreeTTS player under your reply, with buttons to hear the same text in other voices. Keep your reply short: one line with the voice and length, plus the link.

## Pick the right tool

- Plain text read aloud: `text_to_speech`. Pass `language` when no voice is named; FreeTTS picks a natural voice for it.
- The person has not chosen a voice: `suggest_voice` with the language and what the audio is for, then use its first pick.
- "What voices do you have for ...": `list_voices` with the language, or read the resource `freetts://voices/{language}`.
- Two or more speakers (a dialogue, interview, lesson or podcast): `dialogue_to_speech`, one line per speaker as `Name: text`. Pass `voices` when the person names them.
- Exact timing (a presenter's ear prompter, a voiceover timed to video, a workout or recipe with pauses, rehearsal tracks): `script_to_tracks`. Read the resource `freetts://script-mode/syntax` first; `(pause 2)` is exactly two seconds, `(beep)` and `(ding)` are sounds, `TRACK: name` starts a new file, `CUE:` lines use a second voice.
- A recording to text: `transcribe_audio` with the file the person attached (`audio_file`) or a public https link (`audio_url`). Pass `language` when you know it. Add `speakers: true` for interviews and meetings, `timestamps: true` for notes with times, and `subtitles: "srt"` (or `"vtt"`) for a video. Give the person the subtitle link it returns.
- A long recording: `transcribe_audio` may answer with a `job_id` and about how long it needs. Tell the person it is still working, then call `get_transcript` with that `job_id` until the transcript arrives. Do not start the same recording again.
- A very long transcript comes back as its first part plus a link to the whole text file: work from the part shown and share the link.
- Questions about limits or what an account can do: `check_usage`, or the resource `freetts://plans`.

## Good results

- Keep the person's words exactly as written unless they ask for edits. Split long text at paragraph breaks if it is longer than one request allows, and say so.
- For names or unusual words, spell them the way they should sound.
- Match the voice to the language of the text; do not read Spanish text with an English voice.
- For children, lessons and audiobooks, a calm, clear voice at normal speed works best; `speed` from -15 to -5 helps learners.

## Accounts

- Some tools need a connected FreeTTS account. When a tool says so, tell the person plainly in one sentence and share the link it gives, and leave it at that.

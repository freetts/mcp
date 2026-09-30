---
name: freetts-audio
description: Turn text into speech with FreeTTS and hand back an MP3 link. Use when someone wants text read aloud, narrated, voiced, saved as audio, turned into a dialogue or podcast, timed as a voiceover or prompter track, or transcribed from an audio link.
---

# Making audio with FreeTTS

FreeTTS reads text aloud in 149 languages with 2,253 voices and returns a link to the audio file. Always give the person the link, the voice used and the length.

## Pick the right tool

- Plain text read aloud: `text_to_speech`. Pass `language` when no voice is named; FreeTTS picks a natural voice for it.
- The person has not chosen a voice: `suggest_voice` with the language and what the audio is for, then use its first pick.
- "What voices do you have for ...": `list_voices` with the language, or read the resource `freetts://voices/{language}`.
- Two or more speakers (a dialogue, interview, lesson or podcast): `dialogue_to_speech`, one line per speaker as `Name: text`. Pass `voices` when the person names them.
- Exact timing (a presenter's ear prompter, a voiceover timed to video, a workout or recipe with pauses, rehearsal tracks): `script_to_tracks`. Read the resource `freetts://script-mode/syntax` first; `(pause 2)` is exactly two seconds, `(beep)` and `(ding)` are sounds, `TRACK: name` starts a new file, `CUE:` lines use a second voice.
- A recording to text: `transcribe_audio` with a public https link to the audio file.
- Questions about limits or plans: `check_usage`, or the resource `freetts://plans`.

## Good results

- Keep the person's words exactly as written unless they ask for edits. Split long text at paragraph breaks if it exceeds the plan's limit, and say so.
- For names or unusual words, spell them the way they should sound.
- Match the voice to the language of the text; do not read Spanish text with an English voice.
- For children, lessons and audiobooks, a calm, clear voice at normal speed works best; `speed` from -15 to -5 helps learners.

## Plans, stated plainly

- Without an account: standard voices, a daily allowance, MP3 with a short spoken FreeTTS tag at the end, files kept one hour.
- Free FreeTTS account: the same voices on the person's own allowance.
- FreeTTS PRO: HD and Signature voices, no tag, WAV, longer text, and the dialogue, Script mode and transcription tools.
- When a tool answers that it needs another plan, tell the person that plainly and share the plans page it gives. Never pressure anyone to upgrade.

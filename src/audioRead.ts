// The audio behind this server's own links, handed to hosts that ask for it.
// Every audio result carries a resource_link; a host that wants the file
// itself sends resources/read for that link (ChatGPT does, twice a clip, when
// the person asks for the MP3). Before 1.1.6 the answer was "not found".
// Only FreeTTS audio is answered: a file id on freetts.org, or a free-tier
// file kept here for an hour. The same file is public at its link, so nothing
// new is exposed, and no other address is ever fetched.
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile, stat } from "node:fs/promises";
import { CONFIG } from "./config.js";
import { storedPath, storedZipPath } from "./audio.js";

/** The largest file handed over in one read. The largest clip hosts asked for by 2026-11-12 was 9.5 MB. */
const READ_MAX = Number(process.env.AUDIO_READ_MAX_BYTES) || 10 * 1024 * 1024;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The MCP spec's code for a resource that does not exist. */
const NOT_FOUND = -32002;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

const tooBig = (uri: URL, size: number): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: `This audio is ${mb(size)}, more than the ${mb(READ_MAX)} that can be handed over here. Download it from ${uri.href}` }],
});

export function registerAudioRead(server: McpServer): void {
  server.registerResource("audio-file", new ResourceTemplate(`${CONFIG.siteUrl}/api/audio/{id}`, { list: undefined }), {
    title: "FreeTTS audio file",
    description: "The audio behind a link that text_to_speech, dialogue_to_speech or script_to_tracks returned, as a file (MP3, or WAV when it was asked for).",
    mimeType: "audio/mpeg",
  }, async (uri, vars): Promise<ReadResourceResult> => {
    const id = String(vars.id || "");
    if (!FILE_ID.test(id)) throw new McpError(NOT_FOUND, `Resource ${uri.href} not found`);
    const r = await fetch(`${CONFIG.apiUrl}/api/audio/${id}`, { headers: { "x-freetts-source": "mcp" }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 404) throw new McpError(NOT_FOUND, "This FreeTTS audio has expired or does not exist. Make it again with text_to_speech.");
    if (!r.ok) throw new McpError(-32603, `FreeTTS could not hand over this audio just now (${r.status}). Try again in a moment.`);
    const size = Number(r.headers.get("content-length") || 0);
    if (size > READ_MAX) { await r.body?.cancel(); return tooBig(uri, size); }
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > READ_MAX) return tooBig(uri, bytes.length);
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim() || "audio/mpeg";
    return { contents: [{ uri: uri.href, mimeType: mime, blob: bytes.toString("base64") }] };
  });

  server.registerResource("free-audio-file", new ResourceTemplate(`${CONFIG.publicUrl}/audio/{file}`, { list: undefined }), {
    title: "FreeTTS free-tier audio file",
    description: "The MP3 behind a free-tier link from text_to_speech (kept one hour), as a file.",
    mimeType: "audio/mpeg",
  }, async (uri, vars): Promise<ReadResourceResult> => {
    const name = String(vars.file || "");
    // A ZIP of many clips from batch_text_to_speech, kept a day.
    const zm = /^([0-9a-f-]{36})\.zip$/.exec(name);
    if (zm) {
      const zp = storedZipPath(zm[1]);
      let zsize = 0;
      try { zsize = zp ? (await stat(zp)).size : 0; } catch { zsize = 0; }
      if (!zp || !zsize) throw new McpError(NOT_FOUND, "This ZIP has expired: a ZIP of clips is kept one day. Each clip still works at its own link.");
      if (zsize > READ_MAX) return tooBig(uri, zsize);
      return { contents: [{ uri: uri.href, mimeType: "application/zip", blob: (await readFile(zp)).toString("base64") }] };
    }
    const m = /^([0-9a-f-]{36})\.mp3$/.exec(name);
    const path = m ? storedPath(m[1]) : null;
    if (!path) throw new McpError(NOT_FOUND, `Resource ${uri.href} not found`);
    let size = 0;
    try { size = (await stat(path)).size; } catch { throw new McpError(NOT_FOUND, "This free-tier audio has expired: files made without a FreeTTS key are kept one hour. Make it again with text_to_speech."); }
    if (size > READ_MAX) return tooBig(uri, size);
    return { contents: [{ uri: uri.href, mimeType: "audio/mpeg", blob: (await readFile(path)).toString("base64") }] };
  });
}

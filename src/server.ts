// The MCP server both modes share: the hosted one (index.ts, Streamable HTTP
// at mcp.freetts.org) and the local one (stdio.ts, run on your own machine).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG } from "./config.js";
import { registerTools, type Caller } from "./tools.js";
import { registerExtras } from "./extras.js";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

const INSTRUCTIONS = "FreeTTS turns text into spoken audio in 149 languages. Call text_to_speech with the text (and a voice from list_voices or suggest_voice) and give the user the returned link. Without a FreeTTS key the free voices work with a daily allowance; a key from freetts.org/dashboard raises the limits and, on PRO, adds HD voices, WAV, dialogue_to_speech, script_to_tracks and transcribe_audio. Before script_to_tracks, read the resource freetts://script-mode/syntax; freetts://plans lists what each plan allows.";
const INSTRUCTIONS_LOCAL = "FreeTTS turns text into spoken audio in 149 languages. Call text_to_speech with the text (and a voice from list_voices or suggest_voice) and give the user the returned link. This local server uses the FreeTTS API key in FREETTS_API_KEY: a free key covers the standard voices, PRO adds HD voices, WAV, dialogue_to_speech, script_to_tracks and transcribe_audio. Before script_to_tracks, read the resource freetts://script-mode/syntax; freetts://plans lists what each plan allows.";

/** One server bound to one caller (a request on the hosted server, or the whole session locally). */
export function createServer(caller: Caller): McpServer {
  const server = new McpServer({
    name: "freetts", title: "FreeTTS", version: pkg.version, websiteUrl: `${CONFIG.siteUrl}/developers/mcp`,
    icons: [{ src: "https://mcp.freetts.org/icon-512.png", mimeType: "image/png", sizes: ["512x512"] }, { src: "https://mcp.freetts.org/icon-128.png", mimeType: "image/png", sizes: ["128x128"] }],
  }, { instructions: CONFIG.local ? INSTRUCTIONS_LOCAL : INSTRUCTIONS });
  registerTools(server, caller);
  registerExtras(server);
  return server;
}

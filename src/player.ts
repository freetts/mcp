// The in-chat audio player (MCP Apps). text_to_speech links to this HTML
// resource through _meta.ui.resourceUri, so hosts that render MCP Apps
// (ChatGPT, Claude, VS Code) show a player under the answer instead of a bare
// link. Hosts without MCP Apps ignore it and keep the text and link.
//
// The page talks to the host over the MCP Apps postMessage bridge
// (ui/initialize, ui/notifications/tool-input and tool-result, tools/call,
// ui/open-link, size-changed), with ChatGPT's window.openai globals as a
// fallback. It only plays the audio and offers voices this caller can already
// use: no plans, prices or upgrade prompts (ChatGPT plugin rules).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG } from "./config.js";
import { isFreeVoice, tierLabel, type Voice } from "./freetts.js";
import { PLAYER_HTML } from "./playerHtml.js";

/** Bump the version in the URI whenever the HTML changes: hosts cache by URI. */
export const PLAYER_URI = "ui://freetts/player-v4.html";
/** Earlier addresses, still answered with the current page: a host that kept an old link keeps a working player. */
export const PLAYER_URIS_OLD = ["ui://freetts/player-v3.html", "ui://freetts/player-v2.html"];
export const PLAYER_MIME = "text/html;profile=mcp-app";

/** Short display name: "en-US-JennyNeural" -> "Jenny", "de-DE-Florian:DragonHDLatestNeural" -> "Florian". */
export function voiceShortName(v: Pick<Voice, "ShortName">): string {
  const base = v.ShortName.split(":")[0];
  const parts = base.split("-");
  return (parts.slice(2).join(" ") || base).replace(/Multilingual/g, "").replace(/Neural$/, "").trim() || base;
}

/** Up to three other voices for the same language that this caller can use right now. */
export function pickAlternatives(all: Voice[], chosen: Voice, canUsePaid: boolean): Array<{ id: string; name: string; tier: string; gender: string }> {
  const usable = (v: Voice) => !["ultra", "prime"].includes((v.Tier || "").toLowerCase()) && (canUsePaid || isFreeVoice(v));
  // Best first: the voices paying users pick most, then warm, friendly, clear
  // personalities (the tags the voices carry), never plain alphabetical order.
  const FAVOURITES = /^(Ava|Andrew|Emma|Brian|Jenny|Guy|Aria|Davis|Sonia|Ryan|Ollie|Ada|Denise|Henri|Vivienne|Remy|Seraphina|Florian|Katja|Conrad|Elvira|Alvaro|Dalia|Jorge|Ximena|Isabella|Giuseppe|Francisca|Thalita|Antonio|Nanami|Masaru|SunHi|Xiaoxiao|Yunxi|Hamed|Zariyah|Swara|Madhur)$/;
  const LIKED = ["warm", "friendly", "clear", "approachable", "confident", "bright", "pleasant"];
  const score = (v: Voice) => (FAVOURITES.test(voiceShortName(v)) ? 3 : 0)
    + (v.VoiceTag?.VoicePersonalities || []).reduce((n, p) => n + (LIKED.some((w) => p.toLowerCase().includes(w)) ? 1 : 0), 0);
  const pool = all.filter((v) => v.Locale === chosen.Locale && v.ShortName !== chosen.ShortName && usable(v))
    .map((v, i) => ({ v, i, s: score(v) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.v);
  const sameTier = (v: Voice) => tierLabel(v) === tierLabel(chosen);
  const seen = new Set<string>([voiceShortName(chosen).toLowerCase()]);
  const picks: Voice[] = [];
  const take = (pred: (v: Voice) => boolean, upTo: number) => {
    for (const v of pool) {
      if (picks.length >= upTo) return;
      const n = voiceShortName(v).toLowerCase();
      if (seen.has(n) || !pred(v)) continue;
      seen.add(n); picks.push(v);
    }
  };
  take((v) => sameTier(v) && v.Gender !== chosen.Gender, 1);   // the other voice people compare first
  take((v) => sameTier(v) && v.Gender === chosen.Gender, 2);   // then one like the voice they chose
  take((v) => sameTier(v), 3);
  take(() => true, 3);
  return picks.map((v) => ({ id: v.ShortName, name: voiceShortName(v), tier: tierLabel(v), gender: v.Gender }));
}

export function registerPlayer(server: McpServer): void {
  const audioHosts = [CONFIG.publicUrl, CONFIG.siteUrl];
  registerPlayerAt(server, "player", PLAYER_URI, audioHosts);
  PLAYER_URIS_OLD.forEach((uri, i) => registerPlayerAt(server, `player-old-${i + 1}`, uri, audioHosts));
}

function registerPlayerAt(server: McpServer, name: string, PLAYER_URI: string, audioHosts: string[]): void {
  server.registerResource(name, PLAYER_URI, {
    title: "FreeTTS audio player",
    description: "Plays the audio text_to_speech made, with speed, download and other voices for the same text.",
    mimeType: PLAYER_MIME,
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: PLAYER_MIME,
      text: PLAYER_HTML,
      _meta: {
        ui: { prefersBorder: true, csp: { resourceDomains: audioHosts, connectDomains: [CONFIG.publicUrl] } },
        // ChatGPT's older spelling of the same settings.
        "openai/widgetCSP": { resource_domains: audioHosts, connect_domains: [CONFIG.publicUrl] },
        "openai/widgetPrefersBorder": true,
        "openai/widgetDescription": "An audio player for the speech FreeTTS just made.",
      },
    }],
  }));
}

/** Tool _meta that attaches the player (MCP Apps key plus ChatGPT's alias). */
export const PLAYER_TOOL_META = {
  ui: { resourceUri: PLAYER_URI },
  "openai/outputTemplate": PLAYER_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": "Recording the audio",
  "openai/toolInvocation/invoked": "Audio ready",
};


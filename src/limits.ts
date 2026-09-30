// Requests per address in a sliding window, and which callers are an AI
// platform's servers rather than a person's computer.
//
// Claude.ai and ChatGPT call MCP servers from their own clouds, so every
// guest on those platforms arrives from the same few addresses. They get a
// platform meter of their own (see tools.ts) and higher request limits; a
// person's own client (Claude Code, Cursor, VS Code...) is metered by its
// address. IPv6 callers count per /64, like the free-tier meter.
import { BlockList, isIP } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";
import { meterId } from "./tools.js";

const hits = new Map<string, number[]>();
setInterval(() => {
  const cut = Date.now() - 3_600_000;
  for (const [k, v] of hits) { const keep = v.filter((t) => t > cut); if (keep.length) hits.set(k, keep); else hits.delete(k); }
}, 60_000).unref();

/** Counts this request and says whether the address is over `max` in the last `windowMs`. */
export function overLimit(bucket: string, ip: string, max: number, windowMs: number): boolean {
  const k = `${bucket}|${platformOf(ip) ? `platform:${platformOf(ip)}` : meterId(ip || "0.0.0.0")}`;
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
  list.push(now);
  hits.set(k, list);
  return list.length > max;
}

// ── Platforms ─────────────────────────────────────────────────────────────
// Anthropic: the fixed addresses its MCP connectors call from, and its own
// range (platform.claude.com/docs/en/api/ip-addresses).
const ANTHROPIC = ["34.162.46.92/32", "34.162.102.82/32", "34.162.136.91/32", "34.162.142.92/32", "34.162.183.95/32", "160.79.104.0/21", "2607:6bc0::/48"];
// OpenAI publishes ChatGPT's connector ranges and changes them; fetched daily, kept on disk.
const OPENAI_URL = "https://openai.com/chatgpt-connectors.json";
const OPENAI_FILE = join(CONFIG.stateDir, "chatgpt-connectors.json");

function build(list: string[]): BlockList {
  const b = new BlockList();
  for (const c of list) {
    const [addr, bits] = c.split("/");
    const fam = isIP(addr) === 6 ? "ipv6" : "ipv4";
    try { b.addSubnet(addr, Number(bits ?? (fam === "ipv6" ? 128 : 32)), fam); } catch { /* skip a bad row */ }
  }
  return b;
}
const anthropic = build(ANTHROPIC);
let openai = new BlockList();

function loadOpenAI(json: string): number {
  const d = JSON.parse(json) as { prefixes?: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }> };
  const list = (d.prefixes || []).map((p) => p.ipv4Prefix || p.ipv6Prefix || "").filter(Boolean);
  if (list.length) openai = build(list);
  return list.length;
}
try { loadOpenAI(readFileSync(OPENAI_FILE, "utf8")); } catch { /* first start */ }

async function refreshOpenAI(): Promise<void> {
  try {
    const r = await fetch(OPENAI_URL, { headers: { "User-Agent": "FreeTTS-MCP/1 (+https://freetts.org/developers/mcp)" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return;
    const text = await r.text();
    if (loadOpenAI(text) > 0) writeFileSync(OPENAI_FILE, text);
  } catch { /* keep the last good list */ }
}
void refreshOpenAI();
setInterval(() => void refreshOpenAI(), 86_400_000).unref();

/** "claude" or "chatgpt" when the address is that platform's servers, else null. */
export function platformOf(ip: string): "claude" | "chatgpt" | null {
  const a = (ip || "").replace(/^::ffff:/i, "");
  const fam = isIP(a) === 6 ? "ipv6" : isIP(a) === 4 ? "ipv4" : null;
  if (!fam) return null;
  if (anthropic.check(a, fam)) return "claude";
  if (openai.check(a, fam)) return "chatgpt";
  return null;
}

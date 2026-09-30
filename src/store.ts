// One JSON file for what has to survive a restart: OAuth clients, issued
// codes and refresh tokens, and the anonymous meters. Small by design; the
// server is one process.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";

export interface OAuthClient { client_id: string; client_name?: string; redirect_uris: string[]; created: number }
export interface AuthCode { code: string; client_id: string; redirect_uri: string; code_challenge: string; api_key: string; plan: string; exp: number }
export interface RefreshToken { token: string; client_id: string; api_key: string; plan: string; exp: number; created: number }
export interface AnonMeter { calls: number[]; chars: Array<[number, number]> }

interface State {
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthCode>;
  refresh: Record<string, RefreshToken>;
  anon: Record<string, AnonMeter>;
  pool: Record<string, number>;   // day -> chars made for callers without an account
}

const FILE = join(CONFIG.stateDir, "state.json");
let state: State = { clients: {}, codes: {}, refresh: {}, anon: {}, pool: {} };
let dirty = false;

export function loadStore(): void {
  mkdirSync(CONFIG.stateDir, { recursive: true });
  mkdirSync(join(CONFIG.stateDir, "audio"), { recursive: true });
  if (existsSync(FILE)) {
    try { state = { ...state, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch { /* start clean */ }
  }
  setInterval(flush, 5000).unref();
  setInterval(prune, 60_000).unref();
}

export const store = {
  get: () => state,
  touch: () => { dirty = true; },
};

function flush(): void {
  if (!dirty) return;
  dirty = false;
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, FILE);
}

function prune(): void {
  const now = Date.now();
  for (const [k, c] of Object.entries(state.codes)) if (c.exp < now) { delete state.codes[k]; dirty = true; }
  for (const [k, r] of Object.entries(state.refresh)) if (r.exp < now) { delete state.refresh[k]; dirty = true; }
  const dayAgo = now - 86_400_000;
  for (const [k, m] of Object.entries(state.anon)) {
    m.calls = m.calls.filter((t) => t > now - 60_000);
    m.chars = m.chars.filter(([t]) => t > dayAgo);
    if (!m.calls.length && !m.chars.length) delete state.anon[k];
    dirty = true;
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const d of Object.keys(state.pool)) if (d < today) { delete state.pool[d]; dirty = true; }
}

export const today = () => new Date().toISOString().slice(0, 10);

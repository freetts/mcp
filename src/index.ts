// FreeTTS MCP server. One process, Streamable HTTP, stateless: every request
// builds a server bound to the caller (anonymous, or a FreeTTS API key from a
// header or from an access token we issued) and answers it.
import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, MCP_PATH, RESOURCE } from "./config.js";
import { loadStore } from "./store.js";
import { startAudioReaper, storedPath } from "./audio.js";
import { mountOAuth, keyFromAccessToken, wwwAuthenticate } from "./oauth.js";
import { registerTools, PROTECTED_TOOLS, type Caller } from "./tools.js";
import { usage } from "./freetts.js";
import pkg from "../package.json" with { type: "json" };

loadStore();
startAudioReaper();
mkdirSync(join(CONFIG.stateDir, "log"), { recursive: true });
const logLine = (o: Record<string, unknown>) => { try { appendFileSync(join(CONFIG.stateDir, "log", `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); } catch { /* never fail a call for a log */ } };

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((_q, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, x-api-key"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"); res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate"); next(); });
app.options("/{*path}", (_q, res) => res.sendStatus(204));

mountOAuth(app);

// The logo, for clients that show one next to the server (same host as the server, as the spec asks).
const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
app.get("/icon-:size.png", (req: Request, res: Response) => { if (!["128", "256", "512"].includes(String(req.params.size))) return res.status(404).end(); res.setHeader("Cache-Control", "public, max-age=86400"); res.sendFile(`icon-${req.params.size}.png`, { root: ASSETS }, (err) => { if (err && !res.headersSent) res.status(404).end(); }); });

app.get("/robots.txt", (_q, res) => res.type("text/plain").send(["User-agent: *", "Disallow: /", ""].join(String.fromCharCode(10))));
app.get(["/health", "/mcp/health"], (_q, res) => res.json({ ok: true, name: pkg.name, version: pkg.version, mcp: RESOURCE }));

// Free-tier audio, one hour
app.get("/audio/:file", (req: Request, res: Response) => {
  const p = storedPath(String(req.params.file).replace(/\.mp3$/, ""));
  if (!p) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(p, (err) => { if (err && !res.headersSent) res.status(404).json({ error: "This free-tier file has expired (files without a key are kept one hour)." }); });
});

const clientIp = (req: Request) => (req.headers["cf-connecting-ip"] as string || "").trim() || (req.headers["x-real-ip"] as string || "").trim() || (req.ip || "0.0.0.0").replace(/^::ffff:/, "");

const keyPlans = new Map<string, { plan: string; at: number }>();
async function planForKey(key: string): Promise<string | null> {
  const c = keyPlans.get(key);
  if (c && Date.now() - c.at < 300_000) return c.plan;
  try { const u = await usage(key); keyPlans.set(key, { plan: u.plan, at: Date.now() }); return u.plan; } catch { return null; }
}

/** Who is calling: an API key (header or bearer), a token we issued, or nobody. */
async function resolveCaller(req: Request): Promise<{ caller: Caller; badToken: boolean }> {
  const ip = clientIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 120);
  const auth = String(req.headers.authorization || "");
  let key = String(req.headers["x-api-key"] || "").trim();
  let badToken = false;
  if (!key && auth.startsWith("Bearer ")) {
    const tok = auth.slice(7).trim();
    if (/^ft_live_/.test(tok)) key = tok;
    else if (tok) {
      const k = await keyFromAccessToken(tok);
      if (k) return { caller: { kind: "key", apiKey: k.apiKey, plan: k.plan, ip, userAgent: ua }, badToken: false };
      badToken = true;
    }
  }
  if (key) {
    const plan = await planForKey(key);
    if (plan) return { caller: { kind: "key", apiKey: key, plan, ip, userAgent: ua }, badToken: false };
    badToken = true;
  }
  return { caller: { kind: "anon", ip, userAgent: ua }, badToken };
}

const callsProtected = (body: unknown): string | null => {
  for (const m of Array.isArray(body) ? body : [body]) {
    const msg = m as { method?: string; params?: { name?: string } };
    if (msg?.method === "tools/call" && msg.params?.name && PROTECTED_TOOLS.has(msg.params.name)) return msg.params.name;
  }
  return null;
};

async function handleMcp(req: Request, res: Response): Promise<void> {
  const { caller, badToken } = await resolveCaller(req);
  const protectedTool = req.method === "POST" ? callsProtected(req.body) : null;
  // Sign-in only for the tools that need an account: a transport-level 401
  // makes Claude and other clients show their Connect flow, then retry.
  if ((protectedTool && caller.kind !== "key") || (badToken && req.method === "POST")) {
    res.status(401).set("WWW-Authenticate", wwwAuthenticate(protectedTool ? `Sign in to FreeTTS to use ${protectedTool}` : "The token was not accepted; connect again")).json({ error: "invalid_token", error_description: protectedTool ? `Sign in to FreeTTS to use ${protectedTool}` : "The token was not accepted" });
    logLine({ ev: "auth_required", tool: protectedTool, ip: caller.ip, ua: caller.userAgent });
    return;
  }
  const server = new McpServer({ name: "freetts", title: "FreeTTS", version: pkg.version, websiteUrl: `${CONFIG.siteUrl}/developers/mcp`, icons: [{ src: `${CONFIG.publicUrl}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] }, { src: `${CONFIG.publicUrl}/icon-128.png`, mimeType: "image/png", sizes: ["128x128"] }] }, { instructions: "FreeTTS turns text into spoken audio in 149 languages. Call text_to_speech with the text (and a voice from list_voices or suggest_voice) and give the user the returned link. Without a FreeTTS key the free voices work with a daily allowance; a key from freetts.org/dashboard raises the limits and, on PRO, adds HD voices, dialogue_to_speech and script_to_tracks." });
  registerTools(server, caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.method !== "POST") return;
    for (const m of Array.isArray(req.body) ? req.body : [req.body]) {
      const msg = m as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (msg?.method === "tools/call") logLine({ ev: "call", tool: msg.params?.name, kind: caller.kind, plan: caller.plan || null, chars: typeof msg.params?.arguments?.text === "string" ? (msg.params.arguments.text as string).length : undefined, status: res.statusCode, ms: Date.now() - t0, ip: caller.ip, ua: caller.userAgent });
      else if (msg?.method === "initialize") logLine({ ev: "initialize", client: (msg.params as { clientInfo?: { name?: string; version?: string } })?.clientInfo || null, kind: caller.kind, ip: caller.ip, ua: caller.userAgent });
    }
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
}

// A person opening the address in a browser gets the documentation.
app.get("/", (_q, res) => res.redirect(302, `${CONFIG.siteUrl}/developers/mcp`));
app.all(MCP_PATH, (req, res) => {
  if (req.method === "GET") {
    // People get the documentation; clients asking for a standalone notification stream get 405, since this server is stateless and never pushes.
    if (req.accepts(["text/event-stream", "text/html"]) === "text/html") return res.redirect(302, `${CONFIG.siteUrl}/developers/mcp`);
    res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: send JSON-RPC by POST." }, id: null });
  }
  if (req.method === "DELETE") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).end(); }
 handleMcp(req, res).catch((e) => { console.error("mcp", e); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }); }); });

app.use((err: Error & { type?: string; status?: number }, _q: Request, res: Response, _n: NextFunction) => {
  // A body that is not JSON is the caller's mistake: JSON-RPC's parse error, not a server error.
  if (err.type === "entity.parse.failed") return void res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: the body is not valid JSON." }, id: null });
  if (err.type === "entity.too.large") return void res.status(413).json({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large." }, id: null });
  console.error(err); if (!res.headersSent) res.status(500).json({ error: "server_error" });
});

app.listen(CONFIG.port, CONFIG.host, () => console.log(`freetts mcp ${pkg.version} on ${CONFIG.host}:${CONFIG.port} -> ${RESOURCE}`));

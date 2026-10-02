// OAuth 2.1 for assistants (Claude, ChatGPT, Cursor...), the way the MCP
// authorization spec and Anthropic's connector docs ask for it:
//   - protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414)
//   - Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents
//   - authorization code + PKCE S256, resource indicator (RFC 8707)
//   - short access tokens (JWT), rotating refresh tokens
// What the person does at the consent page: paste a FreeTTS API key made in
// their dashboard. The server checks the key against the FreeTTS API and
// binds the tokens to it. The key is the person's own revocable credential:
// deleting it in the dashboard disconnects every assistant that used it.
import type { Express, Request, Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { CONFIG, RESOURCE, MCP_PATH } from "./config.js";
import { store, today, type OAuthClient } from "./store.js";
import { usage, ApiError } from "./freetts.js";
import { safeFetch } from "./safefetch.js";
import { overLimit, platformOf } from "./limits.js";

const ISSUER = CONFIG.publicUrl;
const SCOPES = ["tts", "account"];
const secret = new TextEncoder().encode(CONFIG.jwtSecret);
const b64url = (b: Buffer) => b.toString("base64url");
const rand = (n = 32) => b64url(randomBytes(n));

export function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "FreeTTS",
    resource_documentation: `${CONFIG.siteUrl}/developers/mcp`,
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    service_documentation: `${CONFIG.siteUrl}/developers/mcp`,
  };
}

export const wwwAuthenticate = (desc: string) =>
  `Bearer error="invalid_token", error_description="${desc.replace(/"/g, "'")}", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource${MCP_PATH}", scope="tts"`;

// ── Clients ──────────────────────────────────────────────────────────────
/** Loopback redirects match with the port ignored (RFC 8252 7.3; Claude Code uses localhost too). */
function redirectAllowed(registered: string[], asked: string): boolean {
  let a: URL;
  try { a = new URL(asked); } catch { return false; }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(a.hostname);
  return registered.some((r) => {
    if (r === asked) return true;
    try {
      const u = new URL(r);
      if (!loop || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return false;
      return u.protocol === a.protocol && u.hostname === a.hostname && u.pathname === a.pathname;
    } catch { return false; }
  });
}

async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  const known = store.get().clients[clientId];
  if (known) return known;
  // Client ID Metadata Document: the client id is an https URL that serves its own registration.
  if (/^https:\/\//.test(clientId)) {
    try {
      const { buf } = await safeFetch(clientId, 64_000, 8000);
      const doc = JSON.parse(buf.toString("utf8")) as { client_id?: string; client_name?: string; redirect_uris?: string[] };
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
      const client: OAuthClient = { client_id: clientId, client_name: doc.client_name || new URL(clientId).hostname, redirect_uris: doc.redirect_uris, created: Date.now() };
      store.get().clients[clientId] = client; store.touch();
      return client;
    } catch { return null; }
  }
  return null;
}

// ── Pending authorization requests (memory, ten minutes) ─────────────────
interface Pending { client: OAuthClient; redirect_uri: string; state?: string; code_challenge: string; scope: string; exp: number }
const pending = new Map<string, Pending>();
setInterval(() => { const now = Date.now(); for (const [k, p] of pending) if (p.exp < now) pending.delete(k); }, 60_000).unref();

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;color:#e6f1ec;display:grid;place-items:center;min-height:100vh;padding:24px;
background:radial-gradient(620px 380px at 18% 0%,rgba(16,185,129,.18),transparent 70%),radial-gradient(560px 360px at 100% 100%,rgba(99,102,241,.14),transparent 70%),#080c0a}
main{max-width:480px;width:100%;background:linear-gradient(180deg,#131a17,#0f1512);border:1px solid #23322b;border-radius:24px;padding:30px 30px 26px;box-shadow:0 40px 90px -40px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.05) inset}
h1{font-size:1.5rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px;font-weight:800;text-wrap:balance}p{margin:10px 0;color:#a9bdb3}
label{display:block;font-weight:700;font-size:.86rem;letter-spacing:.02em;margin:20px 0 8px;color:#dbe9e2}
input{width:100%;font:inherit;padding:14px 16px;border-radius:13px;border:1px solid #2b3d34;background:#0a0f0c;color:#fff;transition:border-color .15s,box-shadow .15s}
input:focus{outline:0;border-color:#10b981;box-shadow:0 0 0 4px rgba(16,185,129,.18)}input::placeholder{color:#5d7268}
button{margin-top:14px;width:100%;font:inherit;font-weight:800;padding:14px;border:0;border-radius:13px;background:linear-gradient(180deg,#12c48b,#059669);color:#fff;cursor:pointer;box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 12px 28px -8px rgba(5,150,105,.6);transition:transform .15s,box-shadow .15s}
button:hover{transform:translateY(-1px)}button:focus-visible,a:focus-visible{outline:2px solid #34d399;outline-offset:3px}a{color:#34d399}
.k{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}.err{margin:14px 0 0;padding:11px 13px;border-radius:11px;border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.1);color:#fecaca;font-size:.92rem}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.05rem;margin-bottom:20px}.brand img{width:34px;height:34px;border-radius:9px;border:1px solid #23322b}.dot{width:10px;height:10px;border-radius:50%;background:#10b981}
.or{display:flex;align-items:center;gap:12px;margin:22px 0 14px;color:#6f857a;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.or::before,.or::after{content:"";flex:1;height:1px;background:#23322b}
.get{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:15px;border:1px solid #2b3d34;background:#0c1210;text-decoration:none;color:#e6f1ec;transition:border-color .15s,transform .15s}
.get:hover{border-color:#10b981;transform:translateY(-1px)}.get b{display:block;font-size:.98rem}.get span{display:block;font-size:.84rem;color:#93a89e;line-height:1.4}
.get i{flex:0 0 auto;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:rgba(16,185,129,.14);color:#34d399;font-style:normal;font-size:1.2rem}.get em{margin-left:auto;font-style:normal;color:#34d399;font-weight:800}
.fine{margin:18px 0 0;font-size:.8rem;line-height:1.5;color:#7d9388}
@media (max-width:480px){main{padding:24px 20px 22px;border-radius:20px}h1{font-size:1.32rem}}
@media (prefers-reduced-motion:reduce){button,.get,input{transition:none}}</style></head><body><main><div class="brand"><img src="${CONFIG.siteUrl}/apple-touch-icon.png" alt="" width="34" height="34">FreeTTS</div>${body}</main></body></html>`;

export function mountOAuth(app: Express): void {
  // The connect page takes a key: no other site may frame it.
  app.use("/oauth", (_q, res, next) => { res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Content-Security-Policy", "frame-ancestors 'none'"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Cache-Control", "no-store"); next(); });
  app.get("/.well-known/oauth-protected-resource", (_q, res) => res.json(protectedResourceMetadata()));
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, (_q, res) => res.json(protectedResourceMetadata()));
  app.get("/.well-known/oauth-authorization-server", (_q, res) => res.json(authorizationServerMetadata()));
  app.get("/.well-known/openid-configuration", (_q, res) => res.json(authorizationServerMetadata()));

  // Dynamic Client Registration
  app.post("/oauth/register", (req: Request, res: Response) => {
    if (overLimit("register", req.ip || "", platformOf(req.ip || "") ? 20_000 : 20, 3_600_000)) return res.status(429).json({ error: "too_many_requests", error_description: "Too many registrations from this address. Try again later." });
    const body = (req.body || {}) as { client_name?: string; redirect_uris?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.some((u) => { try { const x = new URL(u); return !(x.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname)); } catch { return true; } })) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs or loopback addresses" });
    }
    const client: OAuthClient = { client_id: `ftc_${rand(18)}`, client_name: String(body.client_name || "").slice(0, 80) || undefined, redirect_uris: uris, created: Date.now() };
    store.get().clients[client.client_id] = client; store.touch();
    res.status(201).json({ client_id: client.client_id, client_name: client.client_name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  });

  // Authorization: check the request, then show the connect page.
  app.get("/oauth/authorize", async (req: Request, res: Response) => {
    if (overLimit("authorize", req.ip || "", 60, 600_000) || pending.size > 20_000) return res.status(429).send(page("Slow down", `<h1>Too many requests</h1><p>Wait a few minutes, then connect again.</p>`));
    const q = req.query as Record<string, string | undefined>;
    const client = q.client_id ? await resolveClient(q.client_id) : null;
    if (!client) return res.status(400).send(page("Unknown client", `<h1>Unknown client</h1><p>This assistant is not registered with FreeTTS. Ask it to connect again.</p>`));
    if (!q.redirect_uri || !redirectAllowed(client.redirect_uris, q.redirect_uri)) return res.status(400).send(page("Redirect not allowed", `<h1>Redirect not allowed</h1><p>The assistant asked to return to an address it did not register.</p>`));
    const back = (err: string, desc: string) => { const u = new URL(q.redirect_uri!); u.searchParams.set("error", err); u.searchParams.set("error_description", desc); if (q.state) u.searchParams.set("state", q.state); res.redirect(u.toString()); };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with S256 is required");
    if (q.resource && q.resource !== RESOURCE && q.resource !== RESOURCE + "/") return back("invalid_target", `resource must be ${RESOURCE}`);
    const rid = rand(16);
    pending.set(rid, { client, redirect_uri: q.redirect_uri, state: q.state, code_challenge: q.code_challenge, scope: q.scope || "tts", exp: Date.now() + CONFIG.authCodeSeconds * 1000 });
    res.send(connectPage(rid, client, null));
  });

  // The person pastes a key; we check it and hand a code back to the assistant.
  app.post("/oauth/consent", async (req: Request, res: Response) => {
    if (overLimit("consent", req.ip || "", 20, 600_000)) return res.status(429).send(page("Slow down", `<h1>Too many attempts</h1><p>Wait ten minutes, then connect again from your assistant.</p>`));
    const rid = String((req.body || {}).rid || "");
    const key = String((req.body || {}).api_key || "").trim();
    const p = pending.get(rid);
    if (!p || p.exp < Date.now()) return res.status(400).send(page("Expired", `<h1>This request expired</h1><p>Go back to your assistant and connect again.</p>`));
    if (!/^ft_live_[A-Za-z0-9_-]{10,}$/.test(key)) return res.status(400).send(connectPage(rid, p.client, "That does not look like a FreeTTS API key. Keys start with ft_live_."));
    let plan = "free";
    try { plan = (await usage(key)).plan; } catch (e) {
      const msg = e instanceof ApiError && e.status === 401 ? "FreeTTS did not accept this key. Check it in your dashboard, or make a new one." : "FreeTTS could not check the key just now. Try again in a moment.";
      return res.status(400).send(connectPage(rid, p.client, msg));
    }
    pending.delete(rid);
    const code = rand(24);
    store.get().codes[code] = { code, client_id: p.client.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, api_key: key, plan, exp: Date.now() + CONFIG.authCodeSeconds * 1000 };
    store.touch();
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    res.redirect(u.toString());
  });

  // Tokens
  app.post("/oauth/token", async (req: Request, res: Response) => {
    if (overLimit("token", req.ip || "", platformOf(req.ip || "") ? 50_000 : 120, 600_000)) return res.status(429).json({ error: "too_many_requests", error_description: "Slow down." });
    const b = (req.body || {}) as Record<string, string>;
    const fail = (error: string, desc: string, status = 400) => res.status(status).json({ error, error_description: desc });
    if (b.grant_type === "authorization_code") {
      const c = store.get().codes[b.code || ""];
      if (!c || c.exp < Date.now()) return fail("invalid_grant", "Unknown or expired code");
      delete store.get().codes[c.code]; store.touch();   // one use
      if (b.client_id && b.client_id !== c.client_id) return fail("invalid_grant", "Code was issued to another client");
      if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return fail("invalid_grant", "redirect_uri does not match");
      const verifier = b.code_verifier || "";
      if (!verifier || b64url(createHash("sha256").update(verifier).digest()) !== c.code_challenge) return fail("invalid_grant", "PKCE verification failed");
      if (b.resource && b.resource !== RESOURCE && b.resource !== RESOURCE + "/") return fail("invalid_target", `resource must be ${RESOURCE}`);
      return res.json(await issueTokens(c.client_id, c.api_key, c.plan));
    }
    if (b.grant_type === "refresh_token") {
      const r = store.get().refresh[b.refresh_token || ""];
      if (!r || r.exp < Date.now()) return fail("invalid_grant", "Unknown or expired refresh token");
      if (b.client_id && b.client_id !== r.client_id) return fail("invalid_grant", "Refresh token belongs to another client");
      delete store.get().refresh[r.token]; store.touch();   // rotate
      let plan = r.plan;
      try { plan = (await usage(r.api_key)).plan; } catch (e) { if (e instanceof ApiError && e.status === 401) return fail("invalid_grant", "The FreeTTS API key behind this connection was removed. Connect again."); }
      return res.json(await issueTokens(r.client_id, r.api_key, plan));
    }
    return fail("unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  app.post("/oauth/revoke", (req: Request, res: Response) => {
    const t = String((req.body || {}).token || "");
    if (store.get().refresh[t]) { delete store.get().refresh[t]; store.touch(); }
    res.status(200).json({});
  });
}

async function issueTokens(client_id: string, api_key: string, plan: string) {
  const access = await new SignJWT({ plan, scope: "tts account" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER).setAudience(RESOURCE).setSubject(keyRef(api_key))
    .setIssuedAt().setExpirationTime(`${CONFIG.accessTokenSeconds}s`).setJti(rand(8))
    .sign(secret);
  const refresh = `ftr_${rand(32)}`;
  store.get().refresh[refresh] = { token: refresh, client_id, api_key, plan, exp: Date.now() + CONFIG.refreshTokenDays * 86_400_000, created: Date.now() };
  // The access token names the key by a reference the server can resolve; the key itself never leaves the store.
  keysByRef.set(keyRef(api_key), api_key);
  store.touch();
  return { access_token: access, token_type: "Bearer", expires_in: CONFIG.accessTokenSeconds, refresh_token: refresh, scope: "tts account" };
}

// A stable reference for a key: hash, never the key.
const keyRef = (k: string) => createHash("sha256").update(k).digest("base64url").slice(0, 24);
const keysByRef = new Map<string, string>();
function keyForRef(ref: string): string | null {
  const hit = keysByRef.get(ref);
  if (hit) return hit;
  for (const r of Object.values(store.get().refresh)) if (keyRef(r.api_key) === ref) { keysByRef.set(ref, r.api_key); return r.api_key; }
  for (const c of Object.values(store.get().codes)) if (keyRef(c.api_key) === ref) return c.api_key;
  return null;
}

/** An access token we issued -> the FreeTTS key it stands for, or null. */
export async function keyFromAccessToken(token: string): Promise<{ apiKey: string; plan: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: RESOURCE });
    const key = payload.sub ? keyForRef(payload.sub) : null;
    return key ? { apiKey: key, plan: String(payload.plan || "free") } : null;
  } catch { return null; }
}

function connectPage(rid: string, client: OAuthClient, err: string | null): string {
  const name = (client.client_name || "your assistant").replace(/[<>&]/g, "");
  return page("Connect to FreeTTS", `
<h1>Connect ${name} to FreeTTS</h1>
<p>Paste your FreeTTS key and ${name} makes audio with your plan and voices.</p>
${err ? `<p class="err">${err}</p>` : ""}
<form method="post" action="/oauth/consent">
<input type="hidden" name="rid" value="${rid}">
<label for="k">Your FreeTTS API key</label>
<input id="k" name="api_key" class="k" placeholder="ft_live_..." autocomplete="off" spellcheck="false" autofocus required>
<button type="submit">Connect</button>
</form>
<div class="or">No key yet</div>
<a class="get" href="${CONFIG.siteUrl}/chatgpt#key" target="_blank" rel="noopener"><i>&#9889;</i><div><b>Get my key in one press</b><span>Free account, no card. It is copied for you, then come back and paste it here.</span></div><em>&rarr;</em></a>
<p class="fine">Only this key is stored, on FreeTTS servers, to act for you when ${name} asks for audio. Delete the key in your dashboard to disconnect. <a href="${CONFIG.siteUrl}/privacy" target="_blank" rel="noopener">Privacy</a></p>`);
}

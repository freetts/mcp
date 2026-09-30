#!/usr/bin/env node
// FreeTTS MCP server, local mode: runs on your machine over stdio and talks
// to the public FreeTTS API with your own key.
//
//   FREETTS_API_KEY=ft_live_... npx -y @freetts/mcp
//
// Without a key it still starts: list_voices, suggest_voice and the
// resources work; making audio asks for a key (free or PRO, from
// freetts.org/dashboard). The hosted server at https://mcp.freetts.org/mcp
// needs no key at all.
//
// Nothing but MCP messages may go to stdout here; notes go to stderr.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FREETTS_MCP_LOCAL = "1";
process.env.FASTAPI_URL ||= "https://freetts.org";
process.env.STATE_DIR ||= join(tmpdir(), "freetts-mcp");

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, VERSION } = await import("./server.js");
const { usage, ApiError } = await import("./freetts.js");

const key = (process.env.FREETTS_API_KEY || "").trim();
let caller: import("./tools.js").Caller = { kind: "anon", ip: "local", userAgent: "local" };
if (key) {
  try {
    const u = await usage(key);
    caller = { kind: "key", apiKey: key, plan: u.plan, ip: "local", userAgent: "local" };
    console.error(`FreeTTS MCP ${VERSION} (local): key accepted, plan ${u.plan}.`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      console.error(`FreeTTS MCP ${VERSION} (local): FREETTS_API_KEY was not accepted. Check it at https://freetts.org/dashboard (API keys). Starting without a key.`);
    } else {
      // Could not check the key (offline, or the API is busy): use it anyway, the API enforces the plan on every call.
      caller = { kind: "key", apiKey: key, plan: "unknown", ip: "local", userAgent: "local" };
      console.error(`FreeTTS MCP ${VERSION} (local): could not check the key just now (${(e as Error)?.message || e}); using it anyway.`);
    }
  }
} else {
  console.error(`FreeTTS MCP ${VERSION} (local): no FREETTS_API_KEY set. Voices and guides work; set a key (free or PRO, https://freetts.org/dashboard) to make audio, or use the hosted server https://mcp.freetts.org/mcp, which needs none.`);
}

await createServer(caller).connect(new StdioServerTransport());

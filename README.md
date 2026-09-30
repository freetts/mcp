# FreeTTS MCP server

Text to speech inside Claude, ChatGPT, Cursor, VS Code, Codex, Windsurf, Gemini CLI and any other MCP client. One remote server, nothing to install:

```
https://mcp.freetts.org/mcp
```

Ask your assistant to read something aloud, and it calls FreeTTS and hands you an MP3 link.

## What it does

| Tool | What it does | Needs |
|---|---|---|
| `text_to_speech` | Text in, MP3 link out. 2,253 voices in 149 languages. | Nothing. Free without an account. |
| `list_voices` | Voices for a language or search word, with ids. | Nothing |
| `suggest_voice` | Three voices for a language and a use, with reasons. | Nothing |
| `check_usage` | Plan and characters left. | Nothing |
| `dialogue_to_speech` | `Name: line` script, a voice per speaker, one file. | FreeTTS PRO |
| `script_to_tracks` | Script mode: exact `(pause 2)`, `(beep)`, `(ding)`, `TRACK:` files, `CUE:` voice, scenes. | FreeTTS PRO |
| `transcribe_audio` | A public audio URL in, text out. | FreeTTS PRO |

**Free without a key:** standard voices, 2,000 characters a call and a day per connection, 10 requests a minute, a short spoken "FreeTTS" tag at the end, files kept one hour.

**With a FreeTTS key** (free account or PRO): the account's plan. PRO: HD and Signature voices, no tag, 10,000 characters a call, 1,000,000 a month, WAV, files kept 30 days, and the dialogue, Script mode and transcription tools. Keys: [freetts.org/dashboard](https://freetts.org/dashboard) (API keys).

## Add it to your client

**Claude Code**
```
claude mcp add --transport http freetts https://mcp.freetts.org/mcp
```
With a key: add `--header "Authorization: Bearer ft_live_..."`, or run `/mcp` inside a session to connect with the sign-in flow.

**Claude (web, desktop, mobile):** Settings, Connectors, Add custom connector, paste `https://mcp.freetts.org/mcp`. Free tools work at once; when a tool needs your account Claude shows Connect.

**Cursor:** [Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=FreeTTS&config=eyJ1cmwiOiJodHRwczovL21jcC5mcmVldHRzLm9yZy9tY3AifQ==), or in `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "freetts": { "url": "https://mcp.freetts.org/mcp" } } }
```

**VS Code:** [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=FreeTTS&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.freetts.org%2Fmcp%22%7D), or in `.vscode/mcp.json`:
```json
{ "servers": { "freetts": { "type": "http", "url": "https://mcp.freetts.org/mcp" } } }
```

**Codex CLI and ChatGPT desktop**
```
codex mcp add freetts --url https://mcp.freetts.org/mcp
```

**ChatGPT (web):** Settings, Apps (Developer Mode), add `https://mcp.freetts.org/mcp`.

**Windsurf**, `~/.codeium/windsurf/mcp_config.json`:
```json
{ "mcpServers": { "freetts": { "serverUrl": "https://mcp.freetts.org/mcp" } } }
```

**Any other client:** use `https://mcp.freetts.org/mcp` as the server URL (Streamable HTTP). To use your account without the sign-in flow, send your key as `Authorization: Bearer ft_live_...` or `x-api-key: ft_live_...`.

Full guide with copy buttons: [freetts.org/developers/mcp](https://freetts.org/developers/mcp).

## Sign-in (OAuth)

The server is an OAuth 2.1 authorization server (PKCE, dynamic client registration, client ID metadata documents, RFC 9728 and 8414 metadata). Free tools need no sign-in. When a client calls a tool that needs your account, the server answers 401 and the client shows its Connect flow; the page asks for a FreeTTS API key from your dashboard and binds the connection to it. Delete the key in the dashboard to disconnect every assistant that used it.

## Privacy

The text you send is sent to FreeTTS and its speech providers exactly as from the website, under the [FreeTTS privacy policy](https://freetts.org/privacy). Calls without a key are metered by the caller's IP address. The server logs tool name, plan, character count, client name and outcome, never the text.

## Run it locally (stdio)

The same server also runs on your own machine, for clients that start local servers or when you would rather keep a key in a local config. It talks to the public FreeTTS API with your own key. Get one at [freetts.org/dashboard](https://freetts.org/dashboard) (API keys; a free account has one).

```
FREETTS_API_KEY=ft_live_... npx -y @freetts/mcp
```

Claude Desktop, Cursor, Cline, Windsurf and similar clients:

```json
{
  "mcpServers": {
    "freetts": {
      "command": "npx",
      "args": ["-y", "@freetts/mcp"],
      "env": { "FREETTS_API_KEY": "ft_live_..." }
    }
  }
}
```

Without a key it still starts: `list_voices`, `suggest_voice`, the prompts and the resources work, and making audio asks for a key. The hosted server at `https://mcp.freetts.org/mcp` needs no key at all.

From source: `npm install && npm run build && node dist/stdio.js`. Node.js 20 or later.

The hosted server itself (`dist/index.js`) runs next to the FreeTTS API on FreeTTS's own machines and is not meant to be self-hosted; the code is here so you can read exactly what it does.

License: MIT.

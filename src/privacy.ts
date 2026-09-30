// The privacy notice for the FreeTTS MCP server and the ChatGPT and Codex
// plugin, served at https://mcp.freetts.org/privacy. Every statement here is
// what this code does; change the page when the code changes.
export const PRIVACY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy notice: FreeTTS MCP server and plugin</title>
<meta name="description" content="What the FreeTTS MCP server and the FreeTTS plugin for ChatGPT and Codex collect, why, who receives it, how long it is kept and how to control it.">
<style>
:root{color-scheme:light dark;--bg:#fbfcfb;--fg:#15201b;--muted:#4a5a52;--line:#dfe6e2;--accent:#047857}
@media (prefers-color-scheme:dark){:root{--bg:#0e1311;--fg:#e8f1ec;--muted:#a9bab1;--line:#24302a;--accent:#34d399}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,"Segoe UI",Roboto,sans-serif;padding:32px 16px}
main{max-width:760px;margin:0 auto}h1{font-size:1.7rem;line-height:1.25;margin:0 0 6px}h2{font-size:1.15rem;margin:30px 0 8px}
p,li{color:var(--fg)}.meta{color:var(--muted);margin:0 0 20px}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{border-bottom:1px solid var(--line);padding:9px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Privacy notice: FreeTTS MCP server and plugin</h1>
<p class="meta">Last updated 1 October 2026. Applies to the FreeTTS MCP server at https://mcp.freetts.org/mcp, the FreeTTS plugin for ChatGPT and Codex, and the local package @freetts/mcp. The full FreeTTS privacy policy is at <a href="https://freetts.org/privacy">freetts.org/privacy</a>.</p>

<h2>Who we are</h2>
<p>FreeTTS is run by Outline Technologies LLC, 30 N Gould St, Ste R, Sheridan, WY 82801, United States. Contact: <a href="mailto:info@freetts.org">info@freetts.org</a> or <a href="https://freetts.org/contact">freetts.org/contact</a>.</p>

<h2>What we collect</h2>
<ul>
<li><strong>The text you ask to have read aloud</strong>, and for speech to text, the audio link you give. This is the content the assistant sends when you use a FreeTTS tool. It can contain personal data if you include it.</li>
<li><strong>The audio files we produce</strong> from that text.</li>
<li><strong>Technical data about each request:</strong> the IP address it came from, the name of the app or assistant that called us (for example its user agent), the tool used, the number of characters, the time, and whether it worked.</li>
<li><strong>If you connect a FreeTTS account:</strong> the FreeTTS API key you paste on the connect page, and your plan and usage, which we read from your FreeTTS account.</li>
</ul>
<p>We do not ask for your name, email address, location, contacts or payment details through the MCP server or the plugin, and we do not receive your ChatGPT or Codex conversation beyond what the assistant sends to a FreeTTS tool.</p>

<h2>Why we use it</h2>
<ul>
<li>To make the audio or transcript you asked for and give you the link.</li>
<li>To apply the limits of the free allowance or of your FreeTTS plan, and to stop abuse (IP addresses are used for this).</li>
<li>To keep you signed in when you connect your FreeTTS account.</li>
<li>To keep the service secure and working, and to count usage in totals (for example how many requests a day). We never read, analyse or keep your text for any other purpose, never sell it, never use it for advertising and never use it to train AI models.</li>
</ul>

<h2>Who receives it</h2>
<ul>
<li><strong>Speech providers:</strong> your text goes to Microsoft Azure AI Speech (standard and HD voices, and speech to text) or Google Cloud Text-to-Speech (Signature voices), only to make the audio or transcript. They process it under their data processing terms and do not use it to train their models.</li>
<li><strong>Cloudflare</strong>, which carries the network traffic to our servers.</li>
<li><strong>Supabase</strong>, which stores FreeTTS accounts, if you connect one.</li>
<li>No one else. We do not sell or share personal data with advertisers or data brokers.</li>
</ul>

<h2>How long we keep it</h2>
<div class="wrap"><table>
<tr><th>Data</th><th>Kept for</th></tr>
<tr><td>Your text</td><td>Not stored by the MCP server. It is processed in memory to make the audio. If you connect a FreeTTS account and have turned on history saving in your FreeTTS dashboard, the FreeTTS website keeps it as that setting describes.</td></tr>
<tr><td>Audio made without an account</td><td>Deleted after 1 hour.</td></tr>
<tr><td>Audio made with a FreeTTS account</td><td>As your plan sets: 1 hour on a free account, 30 days on PRO.</td></tr>
<tr><td>IP address used for the free allowance</td><td>Up to 24 hours.</td></tr>
<tr><td>Request logs (IP address, app name, tool, character count, time, result; never the text)</td><td>Deleted after 30 days.</td></tr>
<tr><td>Your API key and sign-in tokens, if you connect an account</td><td>Until you disconnect or delete the key. Access tokens expire after 1 hour; the stored key and refresh token are deleted after 90 days without use.</td></tr>
</table></div>

<h2>Your choices and rights</h2>
<ul>
<li>Use the free tools without an account: no account data is involved at all.</li>
<li>Disconnect at any time by deleting the API key in your FreeTTS dashboard (API keys). Every assistant that used it stops working with it at once.</li>
<li>Delete your FreeTTS account from the dashboard, or ask us to.</li>
<li>Ask us for a copy of your data, a correction or its deletion, or object to how we use it, by writing to <a href="mailto:info@freetts.org">info@freetts.org</a>. We answer within 30 days. Depending on where you live (for example the EU, the UK or California), you have these rights by law, and you can also complain to your data protection authority.</li>
</ul>

<h2>Children</h2>
<p>The FreeTTS MCP server and plugin are not directed to children under 13, and we do not knowingly collect their personal data.</p>

<h2>Security</h2>
<p>All traffic is encrypted (HTTPS). API keys and tokens are kept on our servers only and never shown in tool results. Addresses you give for speech to text are checked so that they cannot reach private networks.</p>

<h2>Changes</h2>
<p>If this notice changes, we update the date at the top. Questions: <a href="mailto:info@freetts.org">info@freetts.org</a>.</p>
</main></body></html>`;

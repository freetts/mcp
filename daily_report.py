#!/usr/bin/env python3
"""One Telegram line a day about the MCP server: calls, callers, clients,
the PRO wall, errors. Reads yesterday's JSONL log written by the server
(STATE_DIR/log/<date>.jsonl; tool name, plan, character count, outcome; never
the text). Runs from /var/www/freetts.org so it can use telegram_helper and
the site's Telegram settings. Sends nothing when there were no calls."""
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/var/www/freetts.org")
LOG_DIR = os.getenv("MCP_LOG_DIR", "/var/lib/freetts-mcp/log")
day = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat() if len(sys.argv) < 2 else sys.argv[1]
path = os.path.join(LOG_DIR, f"{day}.jsonl")
if not os.path.exists(path):
    sys.exit(0)

calls = Counter(); kinds = Counter(); clients = Counter(); statuses = Counter(); chars = 0; ips = set(); auth_required = 0
with open(path, encoding="utf-8") as fh:
    for line in fh:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("ev") == "call":
            calls[e.get("tool") or "?"] += 1
            kinds[e.get("plan") or e.get("kind") or "?"] += 1
            statuses["ok" if e.get("status") == 200 else str(e.get("status"))] += 1
            chars += int(e.get("chars") or 0)
            ips.add(e.get("ip"))
        elif e.get("ev") == "initialize":
            c = e.get("client") or {}
            clients[(c.get("name") or "unknown")[:30]] += 1
        elif e.get("ev") == "auth_required":
            auth_required += 1

total = sum(calls.values())
if not total and not clients:
    sys.exit(0)
tools = ", ".join(f"{k} {v}" for k, v in calls.most_common())
who = ", ".join(f"{k} {v}" for k, v in kinds.most_common())
cl = ", ".join(f"{k} {v}" for k, v in clients.most_common(6)) or "none seen"
bad = ", ".join(f"{k} {v}" for k, v in statuses.items() if k != "ok") or "none"
msg = (f"🔊 <b>MCP server, {day}</b>\n"
       f"{total} tool calls from {len(ips)} connections, {chars:,} characters\n"
       f"Tools: {tools or 'none'}\n"
       f"Callers: {who or 'none'}\n"
       f"Clients (handshakes): {cl}\n"
       f"Sign-in walls shown: {auth_required} · Non-200: {bad}")
try:
    import telegram_helper
    telegram_helper.send(msg)
except Exception as e:  # never crash the timer
    print("telegram failed:", e, file=sys.stderr)
    print(msg)

# Claude Code Multi-Session Channels

Multi-session Telegram channel for [Claude Code](https://claude.com/claude-code). Run multiple Claude Code sessions in different project directories and switch between them from Telegram using `/switch`.

Built on the [MCP channel protocol](https://code.claude.com/docs/en/channels-reference) — each session gets the full channel experience: reply tools, permission relay, typing indicators, file attachments.

## How it works

```
Telegram --> Router (standalone bot, port 8799)
                |  HTTP (localhost)
          +-----+-----+
     Session A   Session B   Session C
     (MCP server, random port each)
          |          |          |
     Claude A   Claude B   Claude C
     ~/app      ~/api      ~/docs
```

**Router** (`router.ts`) — standalone process that polls your Telegram bot, handles `/sessions` and `/switch` commands, gates senders via allowlist, and forwards messages to the active session over HTTP.

**Session channel** (`session-channel.ts`) — MCP channel server spawned by Claude Code. Registers with the router on startup, receives forwarded messages, and exposes reply/react/edit tools that proxy back through the router to Telegram.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.com/claude-code) v2.1.80+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- **The official Telegram channel plugin must be set up first** — it provides the pairing flow and access control. Follow the [Claude Code channels guide](https://code.claude.com/docs/en/channels) to:
  1. Install the plugin: `/plugin install telegram@claude-plugins-official`
  2. Configure your token: `/telegram:configure <token>`
  3. Start with channels: `claude --channels plugin:telegram@claude-plugins-official`
  4. Pair your account: DM the bot, get the code, run `/telegram:access pair <code>`
  5. Lock it down: `/telegram:access policy allowlist`

Once pairing is complete, you can disable the official plugin and use this multi-session router instead.

## Setup

### 1. Disable the official Telegram plugin

In `~/.claude/settings.json`, set:
```json
"enabledPlugins": {
  "telegram@claude-plugins-official": false
}
```

This prevents the official plugin from also polling the bot when you start Claude Code.

### 2. Clone and install

```bash
git clone https://github.com/Agostinopisani19/claude-code-multisession-channels.git
cd claude-code-multisession-channels
bash install.sh
```

Or manually:

```bash
bun install
claude mcp add -s user tg-session -- bun run "$(pwd)/session-channel.ts"
```

### 3. Start the router

```bash
bun router.ts
```

You should see:
```
router: HTTP server on port 8799
router: polling as @your_bot
```

### 4. Start Claude Code sessions

In separate terminals:

```bash
SESSION_NAME=frontend cd ~/my-app && claude --dangerously-load-development-channels server:tg-session
```

```bash
SESSION_NAME=backend cd ~/my-api && claude --dangerously-load-development-channels server:tg-session
```

## Telegram commands

| Command | Description |
|---------|-------------|
| `/sessions` | List all connected sessions with active indicator |
| `/switch <name>` | Switch which session receives your messages |
| `/status` | Check your pairing state |
| `/help` | Show available commands |

Regular messages are routed to whichever session is active. The first session to connect becomes the default.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_NAME` | basename of cwd | Display name for the session |
| `ROUTER_PORT` | `8799` | HTTP port the router listens on |
| `TELEGRAM_BOT_TOKEN` | — | Bot token (set in `~/.claude/channels/telegram/.env`) |

## Features

- **Session switching** — `/switch` between sessions without restarting anything
- **Auto-reconnect** — sessions re-register automatically if the router restarts
- **Permission relay** — approve/deny Claude's tool use from Telegram with inline buttons
- **File attachments** — send photos/documents to Claude, receive files back
- **Dead session detection** — stale sessions are reaped every 15 seconds
- **Sender gating** — uses the same allowlist as the official Telegram plugin

## Architecture

The router and session channels communicate over localhost HTTP:

**Router -> Session:**
- `POST /message` — forwarded Telegram message
- `POST /permission_verdict` — user's approval/denial of a tool call

**Session -> Router (port 8799):**
- `POST /register` — register/re-register a session
- `POST /unregister` — remove a session
- `POST /reply` — send a message to Telegram
- `POST /react` — add emoji reaction
- `POST /edit` — edit a previously sent message
- `POST /download_attachment` — download a file from Telegram
- `POST /permission_request` — forward a permission prompt to Telegram
- `POST /typing` — show typing indicator

## Compatibility with official plugin

This router **replaces** the official Telegram channel plugin — you cannot run both simultaneously (they'd fight over the same bot token). To switch:

- **Multi-session mode**: disable official plugin, use this router
- **Single-session mode**: stop the router, re-enable the official plugin with `claude --channels plugin:telegram@claude-plugins-official`

## License

MIT

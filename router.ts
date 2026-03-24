#!/usr/bin/env bun
/**
 * Multi-session Telegram router for Claude Code.
 *
 * Standalone process that owns the Telegram bot and routes messages
 * between Telegram and multiple Claude Code sessions. Each session
 * runs a session-channel MCP server that registers with this router.
 *
 * Usage:
 *   bun ~/.claude/telegram-router/router.ts
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, realpathSync, chmodSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

// ── Paths ──────────────────────────────────────────────────────────────────
const CHANNEL_DIR = join(homedir(), '.claude', 'channels', 'telegram')
const ROUTER_DIR = join(homedir(), '.claude', 'telegram-router')
const ACCESS_FILE = join(CHANNEL_DIR, 'access.json')
const APPROVED_DIR = join(CHANNEL_DIR, 'approved')
const ENV_FILE = join(CHANNEL_DIR, '.env')
const STATE_FILE = join(ROUTER_DIR, 'state.json')
const INBOX_DIR = join(CHANNEL_DIR, 'inbox')
const ROUTER_PORT = Number(process.env.ROUTER_PORT ?? 8799)

// ── Load token ─────────────────────────────────────────────────────────────
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `router: TELEGRAM_BOT_TOKEN required\n  set in ${ENV_FILE}\n`,
  )
  process.exit(1)
}

// ── Error handlers ─────────────────────────────────────────────────────────
process.on('unhandledRejection', err => {
  process.stderr.write(`router: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`router: uncaught exception: ${err}\n`)
})

// ── Access control (reuse from official plugin) ────────────────────────────
type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    return defaultAccess()
  }
}

function loadAccess(): Access { return readAccessFile() }

function saveAccess(a: Access): void {
  mkdirSync(CHANNEL_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted`)
}

// ── Gate ────────────────────────────────────────────────────────────────────
type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    // pairing
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = { senderId, chatId: String(ctx.chat!.id), createdAt: now, expiresAt: now + 3600000, replies: 1 }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    if ((policy.allowFrom ?? []).length > 0 && !(policy.allowFrom ?? []).includes(senderId)) return { action: 'drop' }
    if ((policy.requireMention ?? true) && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

// ── Pairing approval poller ────────────────────────────────────────────────
function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      () => rmSync(file, { force: true }),
    )
  }
}
setInterval(checkApprovals, 5000).unref()

// ── Chunking ───────────────────────────────────────────────────────────────
const MAX_CHUNK_LIMIT = 4096
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function assertSendable(f: string): void {
  let real: string, stateReal: string
  try { real = realpathSync(f); stateReal = realpathSync(CHANNEL_DIR) } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// ── Session state ──────────────────────────────────────────────────────────
type SessionEntry = {
  name: string
  port: number
  pid: number
  registeredAt: number
  lastHeartbeat: number
}

type RouterState = {
  activeSession: string | null
  sessions: Record<string, SessionEntry>
}

let state: RouterState = { activeSession: null, sessions: {} }

function loadState(): void {
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { state = { activeSession: null, sessions: {} } }
}

function saveState(): void {
  mkdirSync(ROUTER_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function getActiveSession(): SessionEntry | null {
  if (!state.activeSession) return null
  return state.sessions[state.activeSession] ?? null
}

function isSessionAlive(s: SessionEntry): boolean {
  try { process.kill(s.pid, 0); return true } catch { return false }
}

// ── Dead session reaper ────────────────────────────────────────────────────
function reapDeadSessions(): void {
  let changed = false
  for (const [name, s] of Object.entries(state.sessions)) {
    if (!isSessionAlive(s) || Date.now() - s.lastHeartbeat > 30_000) {
      process.stderr.write(`router: session "${name}" is dead (pid ${s.pid}), removing\n`)
      delete state.sessions[name]
      if (state.activeSession === name) {
        const remaining = Object.keys(state.sessions)
        state.activeSession = remaining[0] ?? null
        if (state.activeSession) {
          process.stderr.write(`router: switched active to "${state.activeSession}"\n`)
        }
      }
      changed = true
    }
  }
  if (changed) saveState()
}
setInterval(reapDeadSessions, 15_000).unref()

// ── Permission relay state ─────────────────────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const pendingPermissions = new Map<string, { sessionName: string; tool_name: string; description: string; input_preview: string }>()

// ── Telegram bot ───────────────────────────────────────────────────────────
const bot = new Bot(TOKEN)
let botUsername = ''

// ── Forward message to active session ──────────────────────────────────────
async function forwardToSession(content: string, meta: Record<string, string>): Promise<boolean> {
  const session = getActiveSession()
  if (!session) return false
  try {
    const res = await fetch(`http://127.0.0.1:${session.port}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, meta }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: { kind: string; file_id: string; size?: number; mime?: string; name?: string },
): Promise<void> {
  const result = gate(ctx)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Permission reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    const perm = pendingPermissions.get(request_id)
    if (perm) {
      const session = state.sessions[perm.sessionName]
      if (session) {
        await fetch(`http://127.0.0.1:${session.port}/permission_verdict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id, behavior }),
        }).catch(() => {})
      }
      pendingPermissions.delete(request_id)
    }
    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    }
    return
  }

  // No active session?
  if (!getActiveSession()) {
    const names = Object.keys(state.sessions)
    if (names.length === 0) {
      await ctx.reply('No sessions connected. Start a Claude Code session with the session-channel.')
    } else {
      await ctx.reply(`No active session. Use /switch <name>\n\nAvailable: ${names.join(', ')}`)
    }
    return
  }

  // Typing indicator
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [
      { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  const meta: Record<string, string> = {
    chat_id,
    ...(msgId != null ? { message_id: String(msgId) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }

  const sent = await forwardToSession(text, meta)
  if (!sent) {
    await ctx.reply('Failed to deliver message to session. It may have disconnected.')
  }
}

// ── Bot commands (must be registered BEFORE message handlers) ──────────────
bot.command('sessions', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  if (!access.allowFrom.includes(String(ctx.from?.id))) return

  const names = Object.keys(state.sessions)
  if (names.length === 0) {
    await ctx.reply('No sessions connected.')
    return
  }
  const lines = names.map(name => {
    const s = state.sessions[name]
    const active = name === state.activeSession ? ' \u2190 active' : ''
    return `${name === state.activeSession ? '\u25cf' : '\u25cb'} ${name} (pid ${s.pid})${active}`
  })
  await ctx.reply(lines.join('\n'))
})

bot.command('switch', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  if (!access.allowFrom.includes(String(ctx.from?.id))) return

  const name = ctx.message?.text?.split(/\s+/)[1]
  if (!name) {
    await ctx.reply('Usage: /switch <session-name>')
    return
  }
  if (!state.sessions[name]) {
    const available = Object.keys(state.sessions).join(', ') || 'none'
    await ctx.reply(`Session "${name}" not found.\nAvailable: ${available}`)
    return
  }
  state.activeSession = name
  saveState()
  await ctx.reply(`Switched to "${name}"`)
})

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `This bot bridges Telegram to Claude Code sessions.\n\n` +
    `Commands:\n` +
    `/sessions \u2014 list connected sessions\n` +
    `/switch <name> \u2014 switch active session\n` +
    `/status \u2014 check your pairing state\n\n` +
    `To pair: DM me anything \u2014 you'll get a code. Run /telegram:access pair <code> in Claude Code.`,
  )
})

bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `Messages route to the active Claude Code session.\n\n` +
    `/sessions \u2014 list sessions\n` +
    `/switch <name> \u2014 switch active session\n` +
    `/status \u2014 pairing state\n` +
    `/start \u2014 setup instructions`,
  )
})

bot.command('status', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const from = ctx.from
  if (!from) return
  const senderId = String(from.id)
  const access = loadAccess()
  if (access.allowFrom.includes(senderId)) {
    const name = from.username ? `@${from.username}` : senderId
    await ctx.reply(`Paired as ${name}.\nActive session: ${state.activeSession ?? 'none'}`)
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`Pending pairing \u2014 run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply('Not paired. Send me a message to get a pairing code.')
})

// ── Bot message handlers (after commands so /sessions etc. fire first) ─────
bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch { return undefined }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const v = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const a = ctx.message.audio
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(a.file_name) ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name: safeName(a.file_name),
  })
})

bot.on('message:video', async ctx => {
  const v = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: v.file_id, size: v.file_size, mime: v.mime_type, name: safeName(v.file_name),
  })
})

bot.on('message:sticker', async ctx => {
  const s = ctx.message.sticker
  const emoji = s.emoji ? ` ${s.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: s.file_id, size: s.file_size,
  })
})

// ── Permission relay: inline keyboard callback ─────────────────────────────
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(details.input_preview), null, 2) } catch { prettyInput = details.input_preview }
    const expanded =
      `\ud83d\udd10 Permission [${details.sessionName}]: ${details.tool_name}\n\n` +
      `description: ${details.description}\n` +
      `input_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('\u2705 Allow', `perm:allow:${request_id}`)
      .text('\u274c Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // Allow or Deny
  const perm = pendingPermissions.get(request_id)
  if (perm) {
    const session = state.sessions[perm.sessionName]
    if (session) {
      await fetch(`http://127.0.0.1:${session.port}/permission_verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id, behavior }),
      }).catch(() => {})
    }
    pendingPermissions.delete(request_id)
  }

  const label = behavior === 'allow' ? '\u2705 Allowed' : '\u274c Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

// ── Reply helper (used by HTTP handler) ────────────────────────────────────
async function sendReply(args: {
  chat_id: string; text: string; reply_to?: string; files?: string[]; format?: string
}): Promise<{ ok: true; message_ids: number[] } | { ok: false; error: string }> {
  try {
    assertAllowedChat(args.chat_id)
    const access = loadAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'length'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(args.text, limit, mode)
    const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
    const parseMode = args.format === 'markdownv2' ? 'MarkdownV2' as const : undefined
    const files = args.files ?? []

    for (const f of files) {
      assertSendable(f)
      if (statSync(f).size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`)
    }

    const sentIds: number[] = []
    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sent = await bot.api.sendMessage(args.chat_id, chunks[i], {
        ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      })
      sentIds.push(sent.message_id)
    }

    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const input = new InputFile(f)
      const opts = reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : undefined
      if (PHOTO_EXTS.has(ext)) {
        const sent = await bot.api.sendPhoto(args.chat_id, input, opts)
        sentIds.push(sent.message_id)
      } else {
        const sent = await bot.api.sendDocument(args.chat_id, input, opts)
        sentIds.push(sent.message_id)
      }
    }

    return { ok: true, message_ids: sentIds }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── HTTP server for session communication ──────────────────────────────────
loadState()

// Clean stale sessions from previous run
for (const [name, s] of Object.entries(state.sessions)) {
  if (!isSessionAlive(s)) {
    delete state.sessions[name]
    if (state.activeSession === name) state.activeSession = null
  }
}
if (state.activeSession && !state.sessions[state.activeSession]) {
  state.activeSession = Object.keys(state.sessions)[0] ?? null
}
saveState()

const httpServer = Bun.serve({
  port: ROUTER_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method !== 'POST' && path !== '/status') {
      return new Response('not found', { status: 404 })
    }

    try {
      if (path === '/status') {
        return Response.json({ activeSession: state.activeSession, sessions: state.sessions })
      }

      const body = await req.json() as Record<string, unknown>

      if (path === '/register') {
        const name = body.name as string
        const port = body.port as number
        const pid = body.pid as number
        // If name is taken by a DIFFERENT live session, reject
        if (state.sessions[name] && isSessionAlive(state.sessions[name]) && state.sessions[name].pid !== pid) {
          return Response.json({ ok: false, error: `session "${name}" already registered (pid ${state.sessions[name].pid})` }, { status: 409 })
        }
        const isNew = !state.sessions[name] || state.sessions[name].pid !== pid
        state.sessions[name] = { name, port, pid, registeredAt: state.sessions[name]?.registeredAt ?? Date.now(), lastHeartbeat: Date.now() }
        if (!state.activeSession) state.activeSession = name
        saveState()
        if (isNew) {
          process.stderr.write(`router: session "${name}" registered (port ${port}, pid ${pid})${state.activeSession === name ? ' [active]' : ''}\n`)
        }
        return Response.json({ ok: true, active: state.activeSession === name })
      }

      if (path === '/unregister') {
        const name = body.name as string
        delete state.sessions[name]
        if (state.activeSession === name) {
          state.activeSession = Object.keys(state.sessions)[0] ?? null
        }
        saveState()
        process.stderr.write(`router: session "${name}" unregistered\n`)
        return Response.json({ ok: true })
      }

      if (path === '/heartbeat') {
        const name = body.name as string
        if (state.sessions[name]) {
          state.sessions[name].lastHeartbeat = Date.now()
        }
        return Response.json({ ok: true })
      }

      if (path === '/reply') {
        const result = await sendReply(body as Parameters<typeof sendReply>[0])
        return Response.json(result, { status: result.ok ? 200 : 400 })
      }

      if (path === '/react') {
        assertAllowedChat(body.chat_id as string)
        await bot.api.setMessageReaction(body.chat_id as string, Number(body.message_id), [
          { type: 'emoji', emoji: body.emoji as ReactionTypeEmoji['emoji'] },
        ])
        return Response.json({ ok: true })
      }

      if (path === '/edit') {
        assertAllowedChat(body.chat_id as string)
        const editParseMode = (body.format as string) === 'markdownv2' ? 'MarkdownV2' as const : undefined
        const edited = await bot.api.editMessageText(
          body.chat_id as string,
          Number(body.message_id),
          body.text as string,
          ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
        )
        const id = typeof edited === 'object' ? edited.message_id : body.message_id
        return Response.json({ ok: true, message_id: id })
      }

      if (path === '/download_attachment') {
        const file = await bot.api.getFile(body.file_id as string)
        if (!file.file_path) throw new Error('no file_path from Telegram')
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const dlPath = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(dlPath, buf)
        return Response.json({ ok: true, path: dlPath })
      }

      if (path === '/permission_request') {
        const { session_name, request_id, tool_name, description, input_preview } = body as Record<string, string>
        pendingPermissions.set(request_id, { sessionName: session_name, tool_name, description, input_preview })
        const access = loadAccess()
        const text = `\ud83d\udd10 Permission [${session_name}]: ${tool_name}`
        const keyboard = new InlineKeyboard()
          .text('See more', `perm:more:${request_id}`)
          .text('\u2705 Allow', `perm:allow:${request_id}`)
          .text('\u274c Deny', `perm:deny:${request_id}`)
        for (const chat_id of access.allowFrom) {
          void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(() => {})
        }
        return Response.json({ ok: true })
      }

      if (path === '/typing') {
        void bot.api.sendChatAction(body.chat_id as string, 'typing').catch(() => {})
        return Response.json({ ok: true })
      }

      return new Response('not found', { status: 404 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ ok: false, error: msg }, { status: 500 })
    }
  },
})

process.stderr.write(`router: HTTP server on port ${ROUTER_PORT}\n`)

// ── Bot error handler ──────────────────────────────────────────────────────
bot.catch(err => {
  process.stderr.write(`router: bot handler error (polling continues): ${err.error}\n`)
})

// ── Shutdown ───────────────────────────────────────────────────────────────
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('router: shutting down\n')
  saveState()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start bot polling ──────────────────────────────────────────────────────
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          botUsername = info.username
          process.stderr.write(`router: polling as @${botUsername}\n`)
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        process.stderr.write(`router: 409 Conflict (another poller?), retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      process.stderr.write(`router: polling failed: ${err}\n`)
      return
    }
  }
})()

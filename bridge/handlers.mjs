// The three things the extension can ask for, independent of how the request
// arrived. server.mjs wraps these in HTTP; native.mjs wraps them in Chrome's
// native-messaging pipe. Keeping them here means the two transports cannot
// drift apart in what they let a page do.

import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listSessions, sendToSession } from './sessions.mjs'
import { listCodexThreads, sendToCodex } from './codex.mjs'

export const CONF_DIR = join(homedir(), '.webdbg')
export const SHOT_DIR = join(CONF_DIR, 'shots')

export class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function sessions() {
  // Never hand the page a session's peer token; it only needs an opaque id.
  const claude = listSessions().map(({ token, socket, ...safe }) => safe)
  let codex = []
  try {
    codex = listCodexThreads()
  } catch {
    // Codex not installed, or no index yet: Claude sessions still work.
  }
  return { sessions: [...claude, ...codex] }
}

// A capture happens when the element is picked, so cancelling leaves the file
// behind. Keep the recent ones and drop the rest.
const KEEP = 200
function prune() {
  try {
    const files = readdirSync(SHOT_DIR)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: statSync(join(SHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(KEEP)) unlinkSync(join(SHOT_DIR, f))
  } catch {
    // Pruning is housekeeping; never fail a capture over it.
  }
}

export function saveShot(png) {
  png = String(png ?? '').replace(/^data:image\/png;base64,/, '')
  if (!png) throw new RequestError(400, 'png required')
  mkdirSync(SHOT_DIR, { recursive: true })
  prune()
  const file = join(SHOT_DIR, `${Date.now()}-${randomBytes(3).toString('hex')}.png`)
  writeFileSync(file, Buffer.from(png, 'base64'))
  return { ok: true, path: file }
}

// `id` is "claude:<pid>" or "codex:<threadId>"; `pid` is the older form.
export async function send({ id, pid, text }) {
  const ref = id ?? (pid ? `claude:${pid}` : null)
  if (!ref || typeof text !== 'string' || !text.trim())
    throw new RequestError(400, 'id and text required')

  const cut = ref.indexOf(':')
  const [agent, rest] = [ref.slice(0, cut), ref.slice(cut + 1)]

  if (agent === 'codex') {
    const t = listCodexThreads().find((x) => x.threadId === rest)
    if (!t) throw new RequestError(404, 'codex thread not found')
    await sendToCodex(rest, text)
    return { ok: true, name: t.label, agent: 'codex' }
  }

  const target = listSessions().find((s) => s.pid === Number(rest))
  if (!target) throw new RequestError(404, 'session not found or no longer live')
  const r = await sendToSession(target, text)
  return { ok: true, msgId: r.msgId, name: target.label ?? target.name, agent: 'claude' }
}

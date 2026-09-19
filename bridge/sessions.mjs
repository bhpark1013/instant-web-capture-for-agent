// Enumerate and message live Claude Code sessions on this machine.
//
// Each live session writes ~/.claude/sessions/<pid>.json describing itself and a
// paired <pid>.<sha256(socketPath)>.key holding the peer token. Messaging is
// NDJSON over the session's own Unix socket: an auth line, then a user message.

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions')
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// A session's own `name` is auto-derived for interactive sessions ("park-ee"),
// which says nothing about what it is working on. The transcript carries the
// same generated title that /resume shows, so prefer that.
const titleCache = new Map()

function transcriptTitle(sessionId, cwd) {
  if (!sessionId) return null
  // Transcripts live under a directory named after the cwd with separators
  // flattened, e.g. /Users/park -> -Users-park.
  const dir = join(PROJECTS_DIR, cwd.replace(/[/.]/g, '-'))
  const file = join(dir, `${sessionId}.jsonl`)
  if (!existsSync(file)) return null

  const { mtimeMs } = statSync(file)
  const hit = titleCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.title

  let title = null
  let firstPrompt = null
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      // Cheap prefilter: parsing every line of a long transcript is the
      // expensive part, and only two record types can carry a title.
      if (!line.includes('"ai-title"') && !firstPrompt === false && !line.includes('"type":"user"')) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle
      else if (!firstPrompt && d.type === 'user' && typeof d.message?.content === 'string')
        firstPrompt = d.message.content.trim().split('\n')[0].slice(0, 60)
    }
  } catch {
    return null
  }
  const resolved = title ?? firstPrompt ?? null
  titleCache.set(file, { mtimeMs, title: resolved })
  return resolved
}

function comm(pid) {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
raw:      false,
    }).trim()
  } catch {
    return null
  }
}

function keyFor(pid, socketPath) {
  const hash = createHash('sha256').update(socketPath).digest('hex')
  const file = join(SESSIONS_DIR, `${pid}.${hash}.key`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).peerToken ?? null
  } catch {
    return null
  }
}

export function listSessions() {
  let files
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const out = []
  for (const f of files) {
    let rec
    try {
      rec = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'))
    } catch {
      continue
    }
    const { pid, messagingSocketPath: socket } = rec
    if (!pid || !socket) continue

    // A stale record outlives its process, and a recycled pid can belong to
    // something else entirely. Only a live `claude` process counts.
    const c = comm(pid)
    if (!c || !/claude|^\d+\.\d+\.\d+$/.test(c.split('/').pop())) continue
    if (!existsSync(socket)) continue

    const token = keyFor(pid, socket)
    if (!token) continue

    const derived = rec.nameSource === 'derived'
    const title = derived ? transcriptTitle(rec.sessionId, rec.cwd ?? '') : null

    out.push({
      agent: 'claude',
      id: `claude:${pid}`,
      pid,
      // `name` stays the address other tools use; `label` is what a human reads.
      name: rec.name ?? `pid ${pid}`,
      label: title ?? rec.name ?? `pid ${pid}`,
      cwd: rec.cwd ?? '',
      kind: rec.kind ?? 'interactive',
      status: rec.status ?? 'unknown',
      sessionId: rec.sessionId,
      startedAt: rec.startedAt ?? 0,
      socket,
      token,
    })
  }

  // Interactive sessions first: a background session is rarely the one you
  // are watching, so it should never be what the picker defaults to.
  out.sort((a, b) =>
    (a.kind === 'bg') - (b.kind === 'bg') || b.startedAt - a.startedAt,
  )
  return out
}

const TAG = 'cross-session-message'

// A receiving session holds an unattested message for its user to approve. The
// attestation is a self-claim the receiver cannot verify — it only verifies the
// sender's pid — so wrapping here is asserting authority webdbg was never
// granted. That is acceptable only because the content script is restricted to
// local dev origins; widen those and this becomes a way for any page you visit
// to type into your agents unprompted.
const MODE = process.env.WEBDBG_ATTEST_MODE ?? 'bypass'

// The body carries page-controlled text. Without this, a page could embed a
// closing tag and then open its own attested wrapper after it.
function sanitize(body) {
  return body.replace(new RegExp(`</?${TAG}`, 'gi'), (m) => m.replace('<', '\u2039'))
}

function attest(body, from, name) {
  return (
    `<${TAG} from="${from}" from-name="${name}" from-mode="${MODE}">\n` +
    sanitize(body) +
    `\n</${TAG}>`
  )
}

export function sendToSession(session, text, { from = 'uds:webdbg', name = 'webdbg' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(session.socket)
    const done = (err) => {
      sock.destroy()
      err ? reject(err) : resolve({ ok: true, msgId })
    }
    const msgId = randomUUID()

    sock.setTimeout(5000)
    sock.on('timeout', () => done(new Error('socket timeout')))
    sock.on('error', done)

    sock.on('connect', () => {
      const auth = { type: 'auth', token: session.token }
      const msg = {
        msgV: 1,
        msg_id: msgId,
        type: 'user',
        message: { role: 'user', content: attest(text, from, name) },
        priority: 'next',
        from,
      }
      sock.write(JSON.stringify(auth) + '\n' + JSON.stringify(msg) + '\n', (err) =>
        err ? done(err) : setTimeout(() => done(null), 150),
      )
    })
  })
}

// Local HTTP bridge between the browser extension and this machine's Claude
// Code sessions. A browser extension cannot open a Unix socket, so it talks to
// this instead.
//
// Bound to loopback and gated on a bearer token: any page in your browser can
// attempt a request, so the token is what separates the extension from a random
// site trying to read your session list or type into your agent.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listSessions, sendToSession } from './sessions.mjs'
import { listCodexThreads, sendToCodex } from './codex.mjs'

const PORT = Number(process.env.WEBDBG_PORT ?? 4778)
const CONF_DIR = join(homedir(), '.webdbg')
const TOKEN_FILE = join(CONF_DIR, 'token')
const SHOT_DIR = join(CONF_DIR, 'shots')

function loadToken() {
  mkdirSync(CONF_DIR, { recursive: true })
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim()
  const t = randomBytes(24).toString('hex')
  writeFileSync(TOKEN_FILE, t + '\n')
  chmodSync(TOKEN_FILE, 0o600)
  return t
}

const TOKEN = loadToken()

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Vary', 'Origin')
}

function json(res, code, body) {
  const b = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(b)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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

const server = createServer(async (req, res) => {
  cors(res, req.headers.origin)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/health') return json(res, 200, { ok: true })

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'bad token' })

  if (req.method === 'GET' && url.pathname === '/sessions') {
    // Never hand the page a session's peer token; it only needs an opaque id.
    const claude = listSessions().map(({ token, socket, ...safe }) => safe)
    let codex = []
    try {
      codex = listCodexThreads()
    } catch {
      // Codex not installed, or no index yet: Claude sessions still work.
    }
    return json(res, 200, { sessions: [...claude, ...codex] })
  }

  if (req.method === 'POST' && url.pathname === '/shot') {
    let body
    try {
      body = JSON.parse(await readBody(req, 24_000_000))
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
    const png = String(body?.png ?? '').replace(/^data:image\/png;base64,/, '')
    if (!png) return json(res, 400, { error: 'png required' })

    mkdirSync(SHOT_DIR, { recursive: true })
    prune()
    const file = join(SHOT_DIR, `${Date.now()}-${randomBytes(3).toString('hex')}.png`)
    writeFileSync(file, Buffer.from(png, 'base64'))
    return json(res, 200, { ok: true, path: file })
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (e) {
      return json(res, 400, { error: 'bad json' })
    }
    // `id` is "claude:<pid>" or "codex:<threadId>"; `pid` is the older form.
    const { id, pid, text } = body ?? {}
    const ref = id ?? (pid ? `claude:${pid}` : null)
    if (!ref || typeof text !== 'string' || !text.trim())
      return json(res, 400, { error: 'id and text required' })

    const [agent, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]

    try {
      if (agent === 'codex') {
        const t = listCodexThreads().find((x) => x.threadId === rest)
        if (!t) return json(res, 404, { error: 'codex thread not found' })
        await sendToCodex(rest, text)
        return json(res, 200, { ok: true, name: t.label, agent: 'codex' })
      }

      const target = listSessions().find((s) => s.pid === Number(rest))
      if (!target) return json(res, 404, { error: 'session not found or no longer live' })
      const r = await sendToSession(target, text)
      return json(res, 200, { ok: true, msgId: r.msgId, name: target.label ?? target.name, agent: 'claude' })
    } catch (e) {
      return json(res, 502, { error: String(e.message ?? e) })
    }
  }

  return json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`webdbg bridge  http://127.0.0.1:${PORT}`)
  console.log(`token           ${TOKEN}`)
  console.log(`                (also at ${TOKEN_FILE})`)
})

// Local HTTP bridge between the browser extension and this machine's Claude
// Code sessions. A browser extension cannot open a Unix socket, so it talks to
// this instead — or, once `npx webdbg install` has run, to native.mjs over a
// pipe Chrome opens itself, in which case nothing has to be left running.
//
// Bound to loopback and gated on a bearer token: any page in your browser can
// attempt a request, so the token is what separates the extension from a random
// site trying to read your session list or type into your agent.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { CONF_DIR, RequestError, sessions, saveShot, send } from './handlers.mjs'

const PORT = Number(process.env.WEBDBG_PORT ?? 4778)
const TOKEN_FILE = join(CONF_DIR, 'token')

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

async function parse(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit))
  } catch {
    throw new RequestError(400, 'bad json')
  }
}

const server = createServer(async (req, res) => {
  cors(res, req.headers.origin)
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/health') return json(res, 200, { ok: true })

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'bad token' })

  try {
    if (req.method === 'GET' && url.pathname === '/sessions') return json(res, 200, sessions())
    if (req.method === 'POST' && url.pathname === '/shot')
      return json(res, 200, saveShot((await parse(req, 24_000_000))?.png))
    if (req.method === 'POST' && url.pathname === '/send')
      return json(res, 200, await send((await parse(req)) ?? {}))
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    return json(res, e instanceof RequestError ? e.status : 502, { error: String(e.message ?? e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`webdbg bridge  http://127.0.0.1:${PORT}`)
  console.log(`token           ${TOKEN}`)
  console.log(`                (also at ${TOKEN_FILE})`)
})

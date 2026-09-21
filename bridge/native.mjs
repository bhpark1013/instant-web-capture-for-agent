// Chrome native-messaging host: the same three requests as server.mjs, but
// over the stdin/stdout pipe Chrome opens when the extension calls
// chrome.runtime.connectNative. Chrome starts this process when the picker
// needs it and ends it when the port closes, so nothing stays running, and only
// the extension ids listed in the host manifest can reach it at all — which is
// why there is no token here.
//
// Framing: each message is a 4-byte native-endian length followed by that many
// bytes of UTF-8 JSON, in both directions.

import { sessions, saveShot, send } from './handlers.mjs'

const HEADER = 4
let buf = Buffer.alloc(0)

function write(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const len = Buffer.alloc(HEADER)
  len.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([len, body]))
}

async function handle(req) {
  const { seq, type } = req ?? {}
  try {
    if (type === 'ping') return { seq, ok: true }
    if (type === 'sessions') return { seq, ok: true, ...sessions() }
    if (type === 'shot') return { seq, ...saveShot(req.png) }
    if (type === 'send') return { seq, ...(await send(req)) }
    return { seq, ok: false, error: `unknown request: ${type}` }
  } catch (e) {
    return { seq, ok: false, error: String(e.message ?? e) }
  }
}

process.stdin.on('data', async (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= HEADER) {
    const len = buf.readUInt32LE(0)
    if (buf.length < HEADER + len) return
    const body = buf.subarray(HEADER, HEADER + len).toString('utf8')
    buf = buf.subarray(HEADER + len)
    let req
    try {
      req = JSON.parse(body)
    } catch {
      write({ ok: false, error: 'bad json' })
      continue
    }
    write(await handle(req))
  }
})

process.stdin.on('end', () => process.exit(0))

#!/usr/bin/env node
// One-time: mint a Chrome Web Store refresh token for the account that owns the store item.
// Prints a consent URL; approve it in a browser logged in as that account; the token lands here.
//   CWS_CLIENT_ID=… CWS_CLIENT_SECRET=… node scripts/cws-token.mjs
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const id = process.env.CWS_CLIENT_ID, secret = process.env.CWS_CLIENT_SECRET
if (!id || !secret) { console.error('set CWS_CLIENT_ID and CWS_CLIENT_SECRET'); process.exit(2) }
const state = randomBytes(12).toString('hex')
let redirect
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname !== '/cb') { res.writeHead(404); res.end(); return }
  if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end('bad state'); return }
  const body = new URLSearchParams({ code: u.searchParams.get('code'), client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
  const j = await r.json()
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end(j.refresh_token ? 'Done. You can close this tab.' : `Failed: ${JSON.stringify(j)}`)
  if (j.refresh_token) process.stdout.write(`REFRESH_TOKEN=${j.refresh_token}\n`); else console.error(JSON.stringify(j))
  server.close(); process.exit(j.refresh_token ? 0 : 1)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
redirect = `http://127.0.0.1:${server.address().port}/cb`
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
  scope: 'https://www.googleapis.com/auth/chromewebstore', state,
})
console.log(`AUTH_URL=${url}`)

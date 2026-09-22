#!/usr/bin/env node
// Chrome Web Store submission — run by .github/workflows/publish.yml on every push to main.
//
//   node scripts/cws-publish.mjs status         print the store state
//   node scripts/cws-publish.mjs submit <zip>   cancel a pending review if any → upload → submit for review
//
// Env (GitHub secrets): CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
//                       CWS_PUBLISHER_ID, CWS_ITEM_ID (defaults below)
// API: https://developer.chrome.com/docs/webstore/api/reference/rest (v2)
import { readFileSync } from 'node:fs'

const API = 'https://chromewebstore.googleapis.com'
const PUBLISHER = process.env.CWS_PUBLISHER_ID || 'e3ad55b0-5cd7-47b6-84f6-edf2fb8aae1b'
const ITEM = process.env.CWS_ITEM_ID || 'nnjjhkoknjjbggkiadhkmnkngfljalmg'
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2) } return v }

const [command, zipPath] = process.argv.slice(2)
if (!['status', 'submit'].includes(command) || (command === 'submit' && !zipPath)) {
  console.error('usage: cws-publish.mjs status | submit <zip>'); process.exit(2)
}
const name = `publishers/${PUBLISHER}/items/${ITEM}`

async function accessToken() {
  const body = new URLSearchParams({
    client_id: need('CWS_CLIENT_ID'), client_secret: need('CWS_CLIENT_SECRET'),
    refresh_token: need('CWS_REFRESH_TOKEN'), grant_type: 'refresh_token',
  })
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })
  const json = await res.json()
  if (!res.ok || !json.access_token) throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(json)}`)
  return json.access_token
}
const token = await accessToken()

async function call(method, path, { body, contentType } = {}) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, body,
  })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) { const e = new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`); e.status = res.status; e.body = json; throw e }
  return json
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const status = () => call('GET', `/v2/${name}:fetchStatus`)
const ver = (r) => r?.distributionChannels?.map((c) => c.crxVersion).join(',') ?? '-'
const describe = (s) => `published=${s.publishedItemRevisionStatus?.state ?? '-'}(${ver(s.publishedItemRevisionStatus)}) submitted=${s.submittedItemRevisionStatus?.state ?? '-'}(${ver(s.submittedItemRevisionStatus)}) upload=${s.lastAsyncUploadState ?? '-'}${s.takenDown ? ' TAKEN_DOWN' : ''}`

let current = await status()
console.log(`state: ${describe(current)}`)
if (command === 'status') {
  console.log(`versions: published=${ver(current.publishedItemRevisionStatus)} submitted=${ver(current.submittedItemRevisionStatus)}`)
  process.exit(0)
}

if (current.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
  console.log('cancelling the pending review…')
  await call('POST', `/v2/${name}:cancelSubmission`)
  for (let i = 0; i < 20; i++) { await sleep(3000); current = await status(); if (current.submittedItemRevisionStatus?.state !== 'PENDING_REVIEW') break }
  console.log(`after cancel: ${describe(current)}`)
  if (current.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') throw new Error('cancel did not take effect; check the dashboard')
}

const zip = readFileSync(zipPath)
console.log(`upload: ${zipPath} (${zip.length} bytes)`)
let upload = await call('POST', `/upload/v2/${name}:upload?uploadType=media`, { body: zip, contentType: 'application/zip' })
console.log(`upload: state=${upload.uploadState} version=${upload.crxVersion ?? '-'}`)
for (let i = 0; i < 40 && upload.uploadState === 'IN_PROGRESS'; i++) { await sleep(3000); current = await status(); upload = { uploadState: current.lastAsyncUploadState, crxVersion: upload.crxVersion } }
if (upload.uploadState !== 'SUCCEEDED') throw new Error(`upload did not succeed: ${JSON.stringify(upload)}`)

const publish = (skipReview) => call('POST', `/v2/${name}:publish`, { body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview }), contentType: 'application/json' })
let result
try { result = await publish(true); console.log(`submitted (skipReview): state=${result.state}`) }
catch (e) { console.log(`skipReview refused → full review (${e.status ?? ''} ${JSON.stringify(e.body?.error?.message ?? e.body ?? '')})`); result = await publish(false); console.log(`submitted: state=${result.state}`) }
if (result.warningInfo) console.log(`warning: ${JSON.stringify(result.warningInfo)}`)
console.log(`final: ${describe(await status())}`)

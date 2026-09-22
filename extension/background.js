// The content script runs in the page's origin, so it must not hold the bridge
// token or reach the bridge directly. Everything crosses through here.
//
// Two ways to reach the machine, tried in this order:
//   1. the native helper Chrome launches on demand (after `npx webdbg install`)
//      — nothing to keep running, and no token, because Chrome only connects
//      the extension ids named in the host manifest;
//   2. the HTTP bridge on loopback (`npx webdbg`), gated by the token pasted in
//      the options page.

const HOST = 'com.webdbg.bridge'
const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:4778', token: '' }

async function config() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }
}

// One port, opened lazily and dropped on disconnect. Chrome starts the helper
// when the port opens and ends it when the port closes, so this is what keeps
// a single selection (sessions, shot, send) from spawning node three times.
let port = null
let seq = 0
const waiting = new Map()

function nativePort() {
  if (port) return port
  port = chrome.runtime.connectNative(HOST)
  port.onMessage.addListener((m) => {
    const w = waiting.get(m.seq)
    if (!w) return
    waiting.delete(m.seq)
    m.ok === false ? w.reject(new Error(m.error ?? 'native error')) : w.resolve(m)
  })
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message ?? 'native helper disconnected'
    port = null
    for (const w of waiting.values()) w.reject(new Error(why))
    waiting.clear()
  })
  return port
}

function native(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    try {
      nativePort().postMessage({ seq: id, type, ...payload })
    } catch (e) {
      waiting.delete(id)
      reject(e)
    }
  })
}

// "Specified native messaging host not found" is Chrome's wording when the
// manifest is missing — the one case worth falling back on. Anything else is a
// real failure inside a helper that does exist.
const notInstalled = (e) => /not found|forbidden|access to the specified native messaging host/i.test(e.message)

async function http(path, init = {}) {
  const { bridgeUrl, token } = await config()
  if (!token) throw new Error('No bridge: run `npx webdbg install`, or `npx webdbg` and paste its token in the options page.')
  const res = await fetch(bridgeUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `bridge ${res.status}`)
  return body
}

const ROUTES = {
  sessions: () => http('/sessions'),
  shot: (p) => http('/shot', { method: 'POST', body: JSON.stringify(p) }),
  send: (p) => http('/send', { method: 'POST', body: JSON.stringify(p) }),
}

async function call(type, payload) {
  try {
    return { ...(await native(type, payload)), via: 'native' }
  } catch (e) {
    if (!notInstalled(e)) throw e
    return { ...(await ROUTES[type](payload)), via: 'http' }
  }
}

// The content script cannot capture a tab, so it hides its own overlay, asks
// here, and gets back a saved file path to name in the payload. The only
// permission behind this is activeTab, which the shortcut or toolbar click
// grants for that tab; the extension never asks for host access to capture.
async function shot(tab, rect, viewport) {
  // captureVisibleTab grabs whichever tab is visible, not the one that asked —
  // capturing from a background tab would silently return the wrong page.
  if (!tab?.active) throw new Error('tab is not the active tab')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())

  // The capture is the viewport at some scale; derive it from the bitmap rather
  // than trusting devicePixelRatio, which is not always the factor actually used
  // (browser zoom, and a capture that is already downscaled, both break it).
  const scale = bitmap.width / viewport.w
  const sx = Math.max(0, Math.round(rect.x * scale))
  const sy = Math.max(0, Math.round(rect.y * scale))
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale))
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale))
  if (sw <= 0 || sh <= 0) throw new Error('element is off screen')

  const canvas = new OffscreenCanvas(sw, sh)
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  const blob = await canvas.convertToBlob({ type: 'image/png' })

  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))

  const r = await call('shot', { png: btoa(bin) })
  return { path: r.path, clipped: sh < Math.round(rect.h * scale) }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ;(async () => {
    try {
      if (msg.type === 'sessions') return reply({ ok: true, ...(await call('sessions')) })
      if (msg.type === 'shot')
        return reply({ ok: true, ...(await shot(sender.tab, msg.rect, msg.viewport)) })
      if (msg.type === 'send')
        return reply({ ok: true, ...(await call('send', { id: msg.id, text: msg.text })) })
      if (msg.type === 'probe') {
        // For the options page: which of the two routes is alive right now.
        const out = { native: null, http: null }
        try { await native('ping'); out.native = 'ok' } catch (e) { out.native = e.message }
        try { await http('/sessions'); out.http = 'ok' } catch (e) { out.http = e.message }
        return reply({ ok: true, ...out })
      }
      reply({ ok: false, error: 'unknown message' })
    } catch (e) {
      reply({ ok: false, error: String(e.message ?? e) })
    }
  })()
  return true // keep the channel open for the async reply
})

async function toggle(tab) {
  if (!tab?.id) return
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  } catch {
    // No content script on chrome:// pages and the web store; nothing to toggle.
  }
}

// Both the toolbar icon and the keyboard shortcut arrive here: the shortcut is
// declared as _execute_action, not a custom command, because only the action's
// own invocation hands the extension the activeTab grant — and that grant is
// what lets captureVisibleTab photograph the tab without asking for <all_urls>.
chrome.action.onClicked.addListener(toggle)
